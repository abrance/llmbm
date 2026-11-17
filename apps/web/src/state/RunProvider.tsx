/**
 * 跑测状态机（F13）：配置 → 套题 → Worker 跑测 → 断点续跑 / 取消 / 补测。
 * 所有判分与聚合都在 core；这里只管调度、持久化与页面状态。
 */
import {
  JUDGE_RULE_VERSION,
  defaultRegistry,
  loadModelTraceBank,
  questionBankVersion,
  runModelTraceProbe,
  sampleSuite,
} from '@llmbm/core';
import { resolveAdapter } from '@llmbm/core/adapters';
import type { EndpointConfig } from '@llmbm/core';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BANK_VERSION, QUESTION_BANK, type BankQuestion } from '../data/bank.js';
import { aggregateRun, scoredResults } from '../lib/aggregateRun.js';
import { deleteCheckpoint, latestCheckpoint, latestRun, saveCheckpoint, saveRun } from '../lib/db.js';
import { domainOf, sendPrepared } from '../lib/transport.js';
import { failedIds } from '../lib/metrics.js';
import { timeoutReportOf } from '../lib/timeoutReport.js';
import { signalsOf } from '../lib/signals.js';
import type {
  EndpointSnapshot,
  ProgressState,
  QuestionResult,
  RunCheckpoint,
  RunPhase,
  RunRecord,
  StartOptions,
  WorkerEvent,
  WorkerRequest,
} from '../lib/types.js';
import { loadEndpoint, saveEndpoint, type StoredEndpoint } from '../lib/store.js';
import { RunContext, type RunContextValue } from './runContext.js';

const AVAILABLE = defaultRegistry().kinds();
const QB_VERSION = questionBankVersion(QUESTION_BANK);
const TIMEOUT_OF = new Map(QUESTION_BANK.map((q) => [q.id, q.timeoutMs]));

function normalizeEndpoint(values: StoredEndpoint): StoredEndpoint {
  return { ...values, protocol: values.protocol ?? 'openai' };
}

function snapshotOf(values: StoredEndpoint): EndpointSnapshot {
  return {
    baseUrl: values.baseUrl.replace(/\/+$/, ''),
    model: values.model,
    protocol: values.protocol ?? 'openai',
    domain: domainOf(values.baseUrl),
  };
}

function resultMap(results: readonly QuestionResult[]): Record<string, QuestionResult> {
  return Object.fromEntries(results.map((r) => [r.questionId, r]));
}

interface LaunchConfig {
  runId: string;
  seed: string;
  samples: number;
  groups: string[];
  expected: number;
  questions: BankQuestion[];
  /** 已完成的题（断点 / 补测的底稿），用于恢复与合并。 */
  done: Record<string, QuestionResult>;
  startedAt: string;
  injectFlaky: boolean;
  /** 跑完后是否额外跑 ModelTrace 指纹探针。 */
  modelTrace: boolean;
  merge?: RunRecord;
}

export function RunProvider({ children }: { children: ReactNode }) {
  const [endpoint, setEndpoint] = useState<StoredEndpoint | undefined>(() => {
    const saved = loadEndpoint();
    return saved ? normalizeEndpoint(saved) : undefined;
  });
  const [run, setRun] = useState<RunRecord>();
  const [checkpoint, setCheckpoint] = useState<RunCheckpoint>();
  const [phase, setPhase] = useState<RunPhase>('idle');
  const [progress, setProgress] = useState<ProgressState>({ done: 0, total: 0, sampleIndex: 0, samples: 3 });
  const [startedAtMs, setStartedAtMs] = useState<number>();
  const [error, setError] = useState<string>();
  const [modelTracePending, setModelTracePending] = useState(false);

  const workerRef = useRef<Worker>();
  const cpRef = useRef<RunCheckpoint>();
  const mergeRef = useRef<RunRecord>();
  const cfgRef = useRef<LaunchConfig>();
  const cancelTimerRef = useRef<number>();
  /** 最新一条完成的 run：探针是异步后置的，合并时不能覆盖用户后来触发的补测结果。 */
  const runRef = useRef<RunRecord>();
  const probeAbortRef = useRef<AbortController>();

  const setCurrentRun = useCallback((next: RunRecord | undefined) => {
    runRef.current = next;
    setRun(next);
  }, []);

  useEffect(() => {
    let alive = true;
    void Promise.all([latestRun(), latestCheckpoint()]).then(([lastRun, lastCp]) => {
      if (!alive) return;
      if (lastRun) setCurrentRun(lastRun);
      if (lastCp) setCheckpoint(lastCp);
    });
    return () => {
      alive = false;
    };
  }, [setCurrentRun]);

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      probeAbortRef.current?.abort();
      if (cancelTimerRef.current) window.clearTimeout(cancelTimerRef.current);
    },
    [],
  );

  const stopWorker = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = undefined;
    if (cancelTimerRef.current) {
      window.clearTimeout(cancelTimerRef.current);
      cancelTimerRef.current = undefined;
    }
  }, []);

  const launch = useCallback(
    (cfg: LaunchConfig, ep: StoredEndpoint) => {
      cpRef.current = {
        runId: cfg.runId,
        questionBankVersion: QB_VERSION,
        seed: cfg.seed,
        samples: cfg.samples,
        groups: cfg.groups,
        endpoint: { baseUrl: ep.baseUrl.replace(/\/+$/, ''), model: ep.model },
        expected: cfg.expected,
        questionIds: cfg.merge ? cfg.merge.results.map((r) => r.questionId) : cfg.questions.map((q) => q.id),
        done: cfg.done,
        updatedAt: cfg.startedAt,
        injectFlaky: cfg.injectFlaky,
      };
      setCheckpoint(cpRef.current);
      void saveCheckpoint(cpRef.current);

      cfgRef.current = cfg;
      mergeRef.current = cfg.merge;
      probeAbortRef.current?.abort();
      setModelTracePending(false);
      setCurrentRun(undefined);
      setError(undefined);
      setPhase('running');
      setStartedAtMs(Date.now());
      setProgress({
        done: cfg.merge ? 0 : Object.keys(cfg.done).length,
        total: cfg.merge ? cfg.questions.length : cfg.expected,
        sampleIndex: 0,
        samples: cfg.samples,
      });

      stopWorker();
      const worker = new Worker(new URL('../lib/run.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;

      worker.onmessage = (ev: MessageEvent<WorkerEvent>) => {
        const msg = ev.data;
        if (msg.type === 'progress') {
          setProgress((prev) => ({
            done: msg.done > 0 ? msg.done : prev.done,
            total: msg.total > 0 ? msg.total : prev.total,
            questionId: msg.questionId,
            sampleIndex: msg.sampleIndex,
            samples: msg.samples,
          }));
          return;
        }
        if (msg.type === 'question') {
          const current = cpRef.current;
          if (!current) return;
          const next: RunCheckpoint = {
            ...current,
            done: { ...current.done, [msg.result.questionId]: msg.result },
            updatedAt: new Date().toISOString(),
          };
          cpRef.current = next;
          setCheckpoint(next);
          void saveCheckpoint(next);
          setProgress((prev) => ({ ...prev, done: Object.keys(next.done).length, total: next.expected }));
          return;
        }
        if (msg.type === 'fatal') {
          setError(msg.error);
          setPhase('error');
          stopWorker();
          return;
        }

        // done：合并补测结果 / 直接采用 worker 的聚合报告
        const merge = mergeRef.current;
        const allResults = merge
          ? [
              ...merge.results.filter((r) => !msg.results.some((n) => n.questionId === r.questionId)),
              ...msg.results,
            ].sort((a, b) => a.questionId.localeCompare(b.questionId))
          : [...msg.results].sort((a, b) => a.questionId.localeCompare(b.questionId));
        if (msg.cancelled && allResults.length === 0) {
          setCurrentRun(undefined);
          setPhase('idle');
          setError(
            msg.abortReason
              ? `跑测已提前终止（${msg.abortReason}）。本次没有完成任何题目，断点已保留；修好端点后回跑测页点「继续上次」即可续跑。`
              : '已取消：本次没有完成任何题目，断点已保留。回到跑测页点「继续上次」即可续跑。',
          );
          setProgress({ done: 0, total: cfg.expected, sampleIndex: 0, samples: cfg.samples });
          stopWorker();
          mergeRef.current = undefined;
          return;
        }

        // 诊断题（group=timeout）不进能力分：补测重算时与 worker 走同一份组装（lib/aggregateRun）。
        const scored = scoredResults(allResults);
        // 补测重算沿用原卷的能力题「应跑题数」，避免诊断题或补测子集把完成率分母算错。
        const report = merge ? aggregateRun(allResults, cfg.samples, merge.report.stability.expected) : msg.report;
        // F14：超时归因只是报告附加块，不改 report 的任何分数。
        const reportWithTimeout = { ...report, timeout: timeoutReportOf(allResults, (id) => TIMEOUT_OF.get(id)) };

        const shouldProbe = cfg.modelTrace && !msg.cancelled;
        const record: RunRecord = {
          runId: cfg.runId,
          seed: cfg.seed,
          samples: cfg.samples,
          groups: cfg.groups,
          endpoint: snapshotOf(ep),
          questionBankVersion: QB_VERSION,
          judgeRuleVersion: JUDGE_RULE_VERSION,
          startedAt: merge?.startedAt ?? cfg.startedAt,
          finishedAt: new Date().toISOString(),
          cancelled: msg.cancelled,
          expected: cfg.expected,
          results: allResults,
          report: reportWithTimeout,
          // F9/F10 跟着「合并后的全量结果」走：补测只跑了失败题，直接用 msg.signals
          // 会只覆盖那几道题，所以合并路径重算一次（口径仍在 core）。诊断题同样不参与弱信号。
          ...(merge ? signalsOf(scored) : msg.signals),
          injectFlaky: cfg.injectFlaky,
          ...(msg.abortReason ? { abortReason: msg.abortReason } : {}),
          ...(msg.notices ? { notices: msg.notices } : {}),
          ...(merge ? { retriedAt: new Date().toISOString() } : {}),
          ...(merge?.modelTrace ? { modelTrace: merge.modelTrace } : {}),
          ...(merge?.modelTraceRequested ? { modelTraceRequested: true } : {}),
          ...(shouldProbe ? { modelTraceRequested: true } : {}),
        };
        setCurrentRun(record);
        setPhase('done');
        if (!msg.cancelled) {
          setCheckpoint(undefined);
          cpRef.current = undefined;
          void deleteCheckpoint(cfg.runId);
        }
        setProgress({ done: 0, total: 0, sampleIndex: 0, samples: cfg.samples });
        void saveRun(record);
        stopWorker();
        mergeRef.current = undefined;

        // ModelTrace 探针串行跑在整卷结束之后：失败只影响卡片，不影响结果保存与断点。
        if (shouldProbe) {
          const controller = new AbortController();
          setModelTracePending(true);
          probeAbortRef.current?.abort();
          probeAbortRef.current = controller;
          void (async () => {
            try {
              const probeCfg: EndpointConfig = {
                baseUrl: ep.baseUrl,
                apiKey: ep.apiKey,
                model: ep.model,
                protocol: ep.protocol ?? 'openai',
                ...(ep.headers ? { headers: ep.headers } : {}),
              };
              const adapter = resolveAdapter(probeCfg);
              const bank = await loadModelTraceBank();
              const result = await runModelTraceProbe({
                cfg: probeCfg,
                adapter,
                bank,
                signal: controller.signal,
                // 探针契约：每条探针有自己的 timeoutMs（默认 250s），不继承普通题的 30s。
                send: (prepared, adapter, signal, opts) => sendPrepared(prepared, adapter, signal, opts.timeoutMs),
              });
              const latest = runRef.current;
              if (!latest || latest.runId !== record.runId) return;
              const next: RunRecord = { ...latest, modelTrace: result };
              setCurrentRun(next);
              await saveRun(next);
            } catch (error) {
              // 探针失败（参考库加载/网络/被中断）：原因落到记录上，卡片与导出能说明白，不再静默。
              console.warn('[ModelTrace] 探针失败', error);
              const latest = runRef.current;
              if (latest && latest.runId === record.runId) {
                const next: RunRecord = {
                  ...latest,
                  modelTraceError: error instanceof Error ? error.message : String(error),
                };
                setCurrentRun(next);
                await saveRun(next);
              }
            } finally {
              if (probeAbortRef.current === controller) setModelTracePending(false);
            }
          })();
        }
      };
      worker.onerror = (event) => {
        setError(`跑测引擎异常：${event.message || '未知错误'}`);
        setPhase('error');
        stopWorker();
      };

      const request: WorkerRequest = {
        type: 'start',
        runId: cfg.runId,
        endpoint: { ...snapshotOf(ep), apiKey: ep.apiKey, ...(ep.headers ? { headers: ep.headers } : {}) },
        questions: cfg.questions,
        samples: cfg.samples,
        seed: cfg.seed,
        done: cfg.merge ? {} : cfg.done,
        injectFlaky: cfg.injectFlaky,
      };
      worker.postMessage(request);
    },
    [stopWorker],
  );

  const start = useCallback(
    (options: StartOptions) => {
      if (!endpoint) {
        setError('还没有接入配置，请先保存 Base URL 与模型。');
        setPhase('error');
        return;
      }
      const available = new Set<string>(AVAILABLE);
      let pool = [...QUESTION_BANK];
      if (options.onlyIds) pool = pool.filter((q) => options.onlyIds?.includes(q.id));
      else {
        if (!options.includeUnavailable) pool = pool.filter((q) => available.has(q.judge));
        pool = sampleSuite(pool, { seed: options.seed, groups: options.groups });
      }
      if (pool.length === 0) {
        setError('这套筛选条件下没有可跑的题。请放宽分组，或打开「包含未上线判定」。');
        setPhase('error');
        return;
      }

      const merge = options.mergeInto;
      const runId = merge?.runId ?? `run_${Date.now().toString(36)}`;
      const done = merge ? resultMap(merge.results) : {};
      launch(
        {
          runId,
          seed: merge?.seed ?? options.seed,
          samples: merge?.samples ?? options.samples,
          groups: merge?.groups ?? options.groups,
          expected: merge?.expected ?? pool.length,
          questions: pool,
          done,
          startedAt: new Date().toISOString(),
          injectFlaky: merge?.injectFlaky ?? options.injectFlaky,
          modelTrace: merge ? false : options.modelTrace === true,
          ...(merge ? { merge } : {}),
        },
        endpoint,
      );
    },
    [endpoint, launch],
  );

  const resume = useCallback(() => {
    const cp = checkpoint;
    if (!cp || !endpoint) return;
    if (cp.questionBankVersion !== QB_VERSION) {
      setError('题库版本已变化，这份断点不能继续，请重新跑测。');
      return;
    }
    if (cp.endpoint.baseUrl !== endpoint.baseUrl.replace(/\/+$/, '') || cp.endpoint.model !== endpoint.model) {
      setError('当前接入配置与断点不一致，请切回原模型后再继续，或丢弃断点重新跑。');
      return;
    }
    const byId = new Map(QUESTION_BANK.map((q) => [q.id, q]));
    const questions = cp.questionIds.map((id) => byId.get(id)).filter((q): q is BankQuestion => Boolean(q));
    if (questions.length === 0) {
      setError('断点里的题目已不在题库中，请重新跑测。');
      return;
    }
    launch(
      {
        runId: cp.runId,
        seed: cp.seed,
        samples: cp.samples,
        groups: cp.groups,
        expected: cp.expected,
        questions,
        done: cp.done,
        startedAt: cp.updatedAt,
        injectFlaky: cp.injectFlaky,
        modelTrace: false,
      },
      endpoint,
    );
  }, [checkpoint, endpoint, launch]);

  const cancel = useCallback(() => {
    const worker = workerRef.current;
    if (!worker) return;
    setPhase('cancelling');
    worker.postMessage({ type: 'cancel' } satisfies WorkerRequest);
    cancelTimerRef.current = window.setTimeout(() => {
      worker.terminate();
      workerRef.current = undefined;
      setPhase('error');
      setError('取消超时，已强制停止；已完成题目的断点已保存。');
    }, 8000);
  }, []);

  const discardCheckpoint = useCallback(() => {
    const cp = checkpoint;
    setCheckpoint(undefined);
    cpRef.current = undefined;
    if (cp) void deleteCheckpoint(cp.runId);
  }, [checkpoint]);

  const retryFailed = useCallback(
    (ids?: string[]) => {
      if (!run) return;
      const targets = ids ?? failedIds(run.results);
      if (targets.length === 0) return;
      start({
        groups: run.groups,
        seed: run.seed,
        samples: run.samples,
        includeUnavailable: true,
        injectFlaky: run.injectFlaky,
        onlyIds: targets,
        mergeInto: run,
      });
    },
    [run, start],
  );

  const clearRun = useCallback(() => setCurrentRun(undefined), [setCurrentRun]);

  const saveEndpointAndStore = useCallback((values: StoredEndpoint) => {
    const normalized = normalizeEndpoint(values);
    setEndpoint(normalized);
    return saveEndpoint(normalized);
  }, []);

  const value = useMemo<RunContextValue>(
    () => ({
      endpoint,
      run,
      checkpoint,
      phase,
      progress,
      startedAtMs,
      error,
      modelTracePending,
      availableJudges: AVAILABLE,
      bankVersion: BANK_VERSION,
      judgeRuleVersion: JUDGE_RULE_VERSION,
      saveEndpoint: saveEndpointAndStore,
      start,
      resume,
      cancel,
      discardCheckpoint,
      retryFailed,
      clearRun,
    }),
    [
      endpoint,
      run,
      checkpoint,
      phase,
      progress,
      startedAtMs,
      error,
      modelTracePending,
      saveEndpointAndStore,
      start,
      resume,
      cancel,
      discardCheckpoint,
      retryFailed,
      clearRun,
    ],
  );

  return <RunContext.Provider value={value}>{children}</RunContext.Provider>;
}
