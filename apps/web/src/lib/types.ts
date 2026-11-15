/**
 * apps/web 的运行态类型（不属于 core 契约）。
 * 只描述「一次跑测」在浏览器里的形状：题目结果、证据链、断点、worker 消息。
 */
import type {
  DegradationSummary,
  JudgeCheck,
  ModelFingerprint,
  ModelResponse,
  ModelTraceResult,
  OutcomeReport,
  QuestionScore,
  QuestionStatus,
  RunSignals,
} from '@llmbm/core';
import type { BankQuestion } from '../data/bank.js';

export type RunPhase = 'idle' | 'running' | 'cancelling' | 'done' | 'error';

export interface ProgressState {
  done: number;
  total: number;
  questionId?: string;
  sampleIndex: number;
  samples: number;
}

/** 提交社区 / 展示用，不含 Key。 */
export interface EndpointSnapshot {
  baseUrl: string;
  model: string;
  protocol: 'openai' | 'anthropic' | 'gemini';
  /** 从 baseUrl 提取的域名；mock 端点固定为 mock.local。 */
  domain: string;
}

export interface SampleResult {
  index: number;
  response: ModelResponse;
  checks: JudgeCheck[];
  score: QuestionScore;
  /** 行去重比例，仅作退化信号展示，不参与判分。 */
  repeatRatio: number;
}

export interface QuestionResult {
  questionId: string;
  group: string;
  prompt: string;
  judge: string;
  core: boolean;
  weight: number;
  samples: SampleResult[];
  /** 题均值（N 次采样）。 */
  mean: number;
  halfWidth: number;
  status: QuestionStatus;
}

export interface RunRecord {
  runId: string;
  seed: string;
  samples: number;
  groups: string[];
  endpoint: EndpointSnapshot;
  questionBankVersion: string;
  judgeRuleVersion: string;
  startedAt: string;
  finishedAt?: string;
  cancelled: boolean;
  expected: number;
  results: QuestionResult[];
  /** 能力分报告；`timeout` 是 F14 的附加归因，只展示、不进任何分数。 */
  report: OutcomeReport & { timeout?: TimeoutReport };
  injectFlaky: boolean;
  /** 非用户取消的提前终止原因（账户/配置/端点不可用）；有值时 cancelled 也为 true。 */
  abortReason?: string;
  /** 被容忍的失败说明（请求形状被拒、瞬时失败），展示用，不进能力分。 */
  notices?: string[];
  /** 补测时间（只重跑失败题时更新）。 */
  retriedAt?: string;
  /** F9 家族指纹（弱信号）。旧 IndexedDB 记录没有这两个字段，展示层要按「本次未采集」处理。 */
  fingerprint?: ModelFingerprint;
  /** F10 退化汇总（弱信号）。 */
  degradation?: DegradationSummary;
  /** v0.4 ModelTrace 指纹探针（附加结论）。旧记录没有该字段。 */
  modelTrace?: ModelTraceResult;
  /** 本次是否请求了 ModelTrace 探针；用于区分「旧记录未采集」与「探针失败」。 */
  modelTraceRequested?: boolean;
}

/** F14 超时归因（只展示，不进 judge / 能力分）。 */
export type TimeoutClass = 'connect' | 'first-token' | 'mid-stream' | 'rate-limit' | 'gateway' | 'unknown';

export interface TimeoutSample {
  questionId: string;
  group: string;
  sampleIndex: number;
  error: string;
  class: TimeoutClass;
  httpStatus?: number;
  latencyMs?: number;
  timeoutMs?: number;
}

export interface TimeoutReport {
  /** 本次参与统计的请求数（全部采样）。 */
  requests: number;
  /** 有传输错误的采样数。 */
  samples: number;
  byClass: Record<TimeoutClass, number>;
  entries: TimeoutSample[];
}

export interface RunCheckpoint {
  runId: string;
  questionBankVersion: string;
  seed: string;
  samples: number;
  groups: string[];
  endpoint: { baseUrl: string; model: string };
  expected: number;
  questionIds: string[];
  done: Record<string, QuestionResult>;
  updatedAt: string;
  injectFlaky: boolean;
}

export interface StartOptions {
  groups: string[];
  seed: string;
  samples: number;
  includeUnavailable: boolean;
  injectFlaky: boolean;
  /** 只跑这些题（补测/单题重试）。 */
  onlyIds?: string[];
  /** 把结果合并回已有 run（补测），不新建 run。 */
  mergeInto?: RunRecord;
  /** 结束后额外跑 ModelTrace 指纹探针（默认关）。 */
  modelTrace?: boolean;
}

/* ------------------------------------------------------------------ worker 协议 */

export interface WorkerStart {
  type: 'start';
  runId: string;
  endpoint: EndpointSnapshot & { apiKey: string; headers?: Record<string, string> };
  questions: BankQuestion[];
  samples: number;
  seed: string;
  done: Record<string, QuestionResult>;
  injectFlaky: boolean;
}

export type WorkerRequest = WorkerStart | { type: 'cancel' };

export type WorkerEvent =
  | {
      type: 'progress';
      done: number;
      total: number;
      questionId: string;
      sampleIndex: number;
      samples: number;
    }
  | { type: 'question'; result: QuestionResult }
  | {
      type: 'done';
      report: OutcomeReport;
      results: QuestionResult[];
      cancelled: boolean;
      /** 短路原因：账户/配置类问题或连续失败，与用户取消区分。 */
      abortReason?: string;
      /** 被容忍的失败说明（请求形状被拒、瞬时失败）。 */
      notices?: string[];
      /** F9/F10 弱信号，只由 core 的 runSignalsOf 计算。 */
      signals: RunSignals;
    }
  | { type: 'fatal'; error: string };

/* ------------------------------------------------------------------ 展示辅助 */

export interface Probe {
  questionId: string;
  group: string;
  judge: string;
  status: QuestionStatus;
  score: number;
  reason: string;
}
