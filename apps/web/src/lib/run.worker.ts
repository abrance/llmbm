/**
 * 跑测 Worker：把「逐题 × 逐采样」的长任务移出主线程，标签页切后台不被节流。
 * 判分、聚合、区间全部调用 @llmbm/core（D1），这里只做调度与事件上报。
 */
import {
  classifyFailure,
  detectWrapped,
  judge,
  questionStatus,
  sampleStat,
  scoreQuestion,
  type EndpointConfig,
  type QuestionScore,
} from '@llmbm/core';
import type { BankQuestion } from '../data/bank.js';
import { aggregateRun, scoredResults } from './aggregateRun.js';
import { FailureGuard, toleratedNotices } from './abort.js';
import { chatOnce, probeEndpoint } from './transport.js';
import { signalsOf } from './signals.js';
import { repeatRatio } from './metrics.js';
import type { QuestionResult, SampleResult, WorkerEvent, WorkerRequest, WorkerStart } from './types.js';

interface WorkerScope {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (msg: WorkerEvent) => void;
}

const scope = self as unknown as WorkerScope;
const controllers = new Set<AbortController>();
let cancelled = false;
/** 短路原因（非用户取消）：致命状态码或连续传输失败，跑完当前采样就收。 */
let abortReason: string | undefined;
const guard = new FailureGuard();

function post(msg: WorkerEvent): void {
  scope.postMessage(msg);
}

function endpointOf(start: WorkerStart): EndpointConfig {
  return {
    baseUrl: start.endpoint.baseUrl,
    apiKey: start.endpoint.apiKey,
    model: start.endpoint.model,
    protocol: start.endpoint.protocol,
    ...(start.endpoint.headers ? { headers: start.endpoint.headers } : {}),
  };
}

/**
 * 跑测前的预检：账户/配置层面的问题（订阅过期、没钱、Key 失效、模型名不存在）
 * 在第一题之前就认出来并终止，不让用户白等一整卷。瞬时抖动不算，交给正式请求的重试。
 */
async function preflight(start: WorkerStart): Promise<string | undefined> {
  const probe = await probeEndpoint(endpointOf(start));
  if (probe.error === undefined) return undefined;
  const kind = classifyFailure(probe);
  if (kind !== 'account' && kind !== 'config') return undefined;
  return guard.note(probe);
}

async function runQuestion(start: WorkerStart, question: BankQuestion): Promise<QuestionResult | undefined> {
  const ep = endpointOf(start);
  const samples: SampleResult[] = [];
  const scores: QuestionScore[] = [];

  for (let index = 0; index < start.samples; index++) {
    if (cancelled || abortReason) return undefined;
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const response = await chatOnce(ep, question, {
        signal: controller.signal,
        sampleIndex: index,
        injectFlaky: start.injectFlaky,
      });
      abortReason = guard.note(response);
      if (cancelled || abortReason) return undefined;
      const checks = judge(question, response, index);
      const score = scoreQuestion(question, checks, {
        wrapped: detectWrapped(response.text),
        ...(response.error ? { transportError: response.error } : {}),
      });
      samples.push({ index, response, checks, score, repeatRatio: repeatRatio(response.text) });
      scores.push(score);
    } catch (err) {
      if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return undefined;
      // chatOnce 已把网络错误收进 ModelResponse；走到这里说明是编程错误，记一次失败采样。
      const message = err instanceof Error ? err.message : String(err);
      const response = { text: '', error: message };
      const checks = judge(question, response, index);
      const score = scoreQuestion(question, checks, { transportError: message });
      samples.push({ index, response, checks, score, repeatRatio: 0 });
      scores.push(score);
    } finally {
      controllers.delete(controller);
    }
    post({
      type: 'progress',
      done: 0,
      total: 0,
      questionId: question.id,
      sampleIndex: index,
      samples: start.samples,
    });
  }

  if (cancelled || samples.length < start.samples) return undefined;
  // 题均值与状态都只看有效采样：传输失败不是能力结论（D5，实现与聚合共用 core 一份）。
  const stat = sampleStat(scores.filter((s) => s.transportError !== true).map((s) => s.score));
  return {
    questionId: question.id,
    group: question.group,
    prompt: question.prompt,
    judge: question.judge,
    core: question.core === true,
    weight: question.weight ?? 1,
    ...(question.diagnostic === true ? { diagnostic: true } : {}),
    ...(question.tags !== undefined ? { tags: question.tags } : {}),
    samples,
    mean: stat.mean,
    halfWidth: stat.halfWidth,
    status: questionStatus(scores),
  };
}

async function run(start: WorkerStart): Promise<void> {
  const results: QuestionResult[] = Object.values(start.done);
  const doneIds = new Set(results.map((r) => r.questionId));
  const pending = start.questions.filter((q) => !doneIds.has(q.id));
  const total = start.questions.length;
  // 「应跑题数」按队列里的能力题算（诊断题不进能力分，也不该抬高完成率分母）。
  const planned = start.questions.filter((question) => question.diagnostic !== true).length;

  try {
    if (!cancelled && pending.length > 0) abortReason = await preflight(start);
    for (const question of pending) {
      if (cancelled || abortReason) break;
      post({
        type: 'progress',
        done: results.length,
        total,
        questionId: question.id,
        sampleIndex: 0,
        samples: start.samples,
      });
      const result = await runQuestion(start, question);
      if (!result) break;
      results.push(result);
      post({ type: 'question', result });
      post({
        type: 'progress',
        done: results.length,
        total,
        questionId: question.id,
        sampleIndex: start.samples - 1,
        samples: start.samples,
      });
    }

    // 诊断题（group=timeout）只做时延观测：aggregateRun 在聚合前剔除，避免污染能力分与稳定性。
    const report = aggregateRun(results, start.samples, planned);
    const notices = toleratedNotices(guard.tolerated(), report.transport);
    post({
      type: 'done',
      report,
      results,
      // F9/F10 看的是能力题的响应形态；诊断题的超时样本会拉低平均字数，不参与弱信号。
      signals: signalsOf(scoredResults(results)),
      cancelled: cancelled || abortReason !== undefined,
      ...(abortReason ? { abortReason } : {}),
      ...(notices.length > 0 ? { notices } : {}),
    });
  } catch (err) {
    post({ type: 'fatal', error: err instanceof Error ? err.message : String(err) });
  }
}

scope.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  if (ev.data.type === 'cancel') {
    cancelled = true;
    for (const controller of controllers) controller.abort();
    return;
  }
  if (ev.data.type === 'start') {
    void run(ev.data);
  }
};
