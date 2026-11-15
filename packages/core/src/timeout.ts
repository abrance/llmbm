/**
 * 超时归因与时延统计（F14 / F3 / F11）。
 *
 * 这里只做两件事：给失败采样归一个「慢在哪一段」的类，和按统一分母算可复用的时延数字。
 * **不判分**：分类与统计都不进 judge、不进能力分，只进结果页与导出。
 *
 * 口径（与 apps/web/src/lib/transport.ts 的唯一超时文案对齐）：
 * - 超时率分母 = 已发起且非用户取消的采样；取消掉的采样不算「端点失败」。
 * - p50/p95/max 只统计成功完成的采样；超时是「至少等到阈值仍未完成」，不能当完成时延。
 * - 重试成功不能抹掉首次超时：调用方把 attempt 级记录在 ModelResponse.attempts 里，
 *   本模块只统计逻辑采样的最终结果，attempt 级明细由 transport 保留在原始证据里。
 */
import type { TransportPhase } from './types.js';

/** 一次失败请求属于哪个环节。connect=连接/响应前，first-token=已连上但没出正文，mid-stream=正文中途停住。 */
export type TimeoutClass = 'connect' | 'first-token' | 'mid-stream' | 'rate-limit' | 'gateway' | 'unknown';

export interface TimeoutInput {
  error?: string;
  httpStatus?: number;
  /** 本次请求的预算（ms），仅用于展示与判断「是否真的到点」，不参与分类。 */
  timeoutMs?: number;
  latencyMs?: number;
  /** 从发出请求到第一个正文增量；非流式或未出正文时为 undefined。 */
  ttftMs?: number;
  /** 最后一次收到有效增量的时间点（从请求开始计）。 */
  lastChunkAtMs?: number;
  /** 收到的传输分片数。 */
  chunks?: number;
  /** 失败时请求所处阶段；transport 能填就填。 */
  phase?: TransportPhase;
}

const TIMEOUT_PATTERN = /timeout|timed out|超时|ETIMEDOUT|AbortError|The operation was aborted/i;

/**
 * 给一条失败的采样归类。只在 `response.error` 存在时调用；
 * 不是超时文案的失败返回 `unknown`，调用方应保留原始错误，不要硬塞进超时统计。
 */
export function classifyTimeout(input: TimeoutInput): TimeoutClass {
  const { httpStatus, error = '', phase, ttftMs, chunks } = input;
  if (httpStatus === 429) return 'rate-limit';
  if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) return 'gateway';
  if (!TIMEOUT_PATTERN.test(error)) return 'unknown';
  if (phase === 'streaming' || ttftMs !== undefined || (chunks ?? 0) > 0) return 'mid-stream';
  if (phase === 'before-first-byte' || httpStatus !== undefined) return 'first-token';
  return 'connect';
}

/** nearest-rank 分位数（升序第 ceil(p×n) 个，不插值）；空数组返回 undefined。 */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(100, Math.max(0, p));
  const rank = Math.ceil((clamped / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export interface LatencyStats {
  n: number;
  p50?: number;
  p95?: number;
  max?: number;
}

export function latencyStats(values: readonly number[]): LatencyStats {
  if (values.length === 0) return { n: 0 };
  return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: Math.max(...values) };
}

export interface TransportSampleInput {
  latencyMs?: number;
  ttftMs?: number;
  error?: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

export interface TransportSummary {
  /** 实际发起过的采样数（断点里没跑的题不算）。 */
  initiated: number;
  completed: number;
  timedOut: number;
  cancelled: number;
  failed: number;
  /** 超时数 /（已发起 − 用户取消）；没有有效分母时为 0。 */
  timeoutRate: number;
  /** 只统计成功完成的采样。 */
  latency: LatencyStats;
  /** 只统计成功完成且有 TTFT 的流式采样。 */
  ttft: LatencyStats;
}

function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 汇总一组采样的传输结果。`timedOut` 由调用方按 classifyTimeout 判定后传入；
 * 未显式给出时按「有 error 且不是取消」记为失败，不算超时（避免把断流算成超时）。
 */
export function summarizeTransport(samples: readonly TransportSampleInput[]): TransportSummary {
  let initiated = 0;
  let completed = 0;
  let timedOut = 0;
  let cancelled = 0;
  let failed = 0;
  const latencies: number[] = [];
  const ttfts: number[] = [];

  for (const sample of samples) {
    initiated += 1;
    if (sample.cancelled) {
      cancelled += 1;
      continue;
    }
    if (sample.error !== undefined) {
      if (sample.timedOut === true) timedOut += 1;
      else failed += 1;
      continue;
    }
    completed += 1;
    const latency = finite(sample.latencyMs);
    if (latency !== undefined) latencies.push(latency);
    const ttft = finite(sample.ttftMs);
    if (ttft !== undefined) ttfts.push(ttft);
  }

  const denominator = Math.max(0, initiated - cancelled);
  return {
    initiated,
    completed,
    timedOut,
    cancelled,
    failed,
    timeoutRate: denominator === 0 ? 0 : timedOut / denominator,
    latency: latencyStats(latencies),
    ttft: latencyStats(ttfts),
  };
}
