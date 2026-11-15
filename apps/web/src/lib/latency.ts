/**
 * 超时与响应时延统计（纯函数、无 IO）。
 *
 * 分类与分位数全部来自 core（`classifyTimeout` / `latencyStats` / `summarizeTransport`，v0.4 契约）：
 * 这里**不写第二份阈值或算法**，只负责把「每题 × 每次采样」的原始计时整理成可读结论。
 *
 * 口径（与 core/src/timeout.ts 一致，也是唯一一份）：
 * - 超时率 = 超时数 / 已发起且非用户取消的采样；取消与未发起的采样不进分母。
 * - p50/p95/max 只统计成功完成的采样；超时是「等到阈值仍未完成」，不能当完成时延。
 * - 超时按环节归因：connect（还没连上/没回响应）、first-token（已回响应但没有正文）、mid-stream（正文中途停住）。
 * - 429 与 502/503/504 由 core 归为 rate-limit / gateway，算「其他传输失败」，不混进超时率。
 * - attempt 级超时单独计数：重试成功不能把它抹掉，但逻辑采样本身仍算成功。
 */
import {
  classifyTimeout,
  percentile,
  summarizeTransport,
  type LatencyStats,
  type TimeoutClass,
  type TransportPhase,
  type TransportSummary,
} from '@llmbm/core';

/** 一次采样的传输事实（transport 的 ModelResponse 超集子集）。 */
export interface LatencySampleInput {
  latencyMs?: number;
  ttftMs?: number;
  lastChunkAtMs?: number;
  chunks?: number;
  phase?: TransportPhase;
  httpStatus?: number;
  error?: string;
  /** attempt 级明细：重试过才有，用来区分「逻辑采样失败」与「某一次尝试失败」。 */
  attempts?: readonly { outcome: string; latencyMs?: number; error?: string }[];
}

export interface LatencyQuestionInput {
  questionId: string;
  group?: string;
  /** 该题的时延预算（ms）；0 或缺失表示没有独立预算，只统计不判断余量。 */
  timeoutMs?: number;
  /** 题目分类标签（如「短问答」「长输出」「首字慢」），只用于生成可读结论。 */
  tags?: readonly string[];
  samples: readonly LatencySampleInput[];
}

export type LatencyVerdict = 'all-timeout' | 'partial-timeout' | 'no-data' | 'slower-than-peers' | 'normal';

/** attempt 级统计：与逻辑采样的最终结果分开，重试成功不抹掉失败的那次。 */
export interface LatencyAttemptStats {
  /** attempt 总数（含成功与失败）。 */
  attempts: number;
  /** 发生过重试的采样数。 */
  retriedSamples: number;
  /** attempt 级超时数；可能大于逻辑采样超时数（重试后成功）。 */
  timeoutAttempts: number;
}

export interface QuestionLatencyReport {
  questionId: string;
  group: string;
  timeoutMs: number;
  /** 已发起的采样数。 */
  samples: number;
  timeouts: number;
  /** 非超时的传输错误（断流、429、网关、网络），已从时延统计剔除。 */
  otherErrors: number;
  /** 超时 / 已发起；没有采样时为 0。 */
  timeoutRate: number;
  byClass: Record<TimeoutClass, number>;
  attempts: number;
  timeoutAttempts: number;
  /** 只统计成功完成的采样。 */
  ttft: LatencyStats;
  total: LatencyStats;
  /** 同端点其他题的有效 TTFT 中位；没有可比样本时 undefined。 */
  peerTtftP50?: number;
  peerTotalP50?: number;
  verdict: LatencyVerdict;
  /** 本题的可读结论，按重要程度排列。 */
  sentences: string[];
}

export interface LatencyReport extends TransportSummary {
  /** 计划发起的采样数（题数 × 每题采样）。 */
  expected: number;
  /** 用户取消导致没发起的采样数。 */
  cancelled: number;
  /** 短路（端点不可用/账户不可用）导致没发起的采样数。 */
  notRun: number;
  byClass: Record<TimeoutClass, number>;
  attempt: LatencyAttemptStats;
  questions: QuestionLatencyReport[];
  /** 放结果页顶部的整体结论。 */
  headlines: string[];
}

/** 首字慢的绝对门槛：超过 3 秒对短问答已经不可用，低于它不要下「端点排队」的结论。 */
export const SLOW_TTFT_MS = 3000;

export interface AnalyzeLatencyOptions {
  /** 只把这些分组纳入整体统计；对比基准仍用传入的全部题目（同端点其他题）。 */
  scopeGroup?: string;
  /** 计划发起的采样总数；缺省按已记录采样推算（旧记录没有 run 状态）。 */
  expected?: number;
  cancelled?: number;
  notRun?: number;
}

const TIMEOUT_CLASSES: readonly TimeoutClass[] = ['connect', 'first-token', 'mid-stream'];

function emptyClasses(): Record<TimeoutClass, number> {
  return { connect: 0, 'first-token': 0, 'mid-stream': 0, 'rate-limit': 0, gateway: 0, unknown: 0 };
}

/** 给一条失败的采样归环节；没有 error 时 undefined（成功采样没有超时类）。 */
export function timeoutClassOf(sample: LatencySampleInput, timeoutMs = 0): TimeoutClass | undefined {
  if (sample.error === undefined) return undefined;
  return classifyTimeout({
    error: sample.error,
    ...(sample.httpStatus !== undefined ? { httpStatus: sample.httpStatus } : {}),
    ...(timeoutMs > 0 ? { timeoutMs } : {}),
    ...(sample.latencyMs !== undefined ? { latencyMs: sample.latencyMs } : {}),
    ...(sample.ttftMs !== undefined ? { ttftMs: sample.ttftMs } : {}),
    ...(sample.lastChunkAtMs !== undefined ? { lastChunkAtMs: sample.lastChunkAtMs } : {}),
    ...(sample.chunks !== undefined ? { chunks: sample.chunks } : {}),
    ...(sample.phase !== undefined ? { phase: sample.phase } : {}),
  });
}

export function isTimeoutClass(cls: TimeoutClass | undefined): boolean {
  return cls !== undefined && TIMEOUT_CLASSES.includes(cls);
}

const CLASS_LABEL: Record<TimeoutClass, string> = {
  connect: '连接/响应前',
  'first-token': '首字前',
  'mid-stream': '流式中段',
  'rate-limit': '限流 429',
  gateway: '网关 502/503/504',
  unknown: '其他错误',
};

function classSentence(byClass: Record<TimeoutClass, number>): string | undefined {
  const parts = TIMEOUT_CLASSES.filter((cls) => byClass[cls] > 0).map(
    (cls) => `${CLASS_LABEL[cls]} ${byClass[cls]} 次`,
  );
  return parts.length > 0 ? `超时环节：${parts.join('、')}。` : undefined;
}

function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function ms(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function budgetOf(question: LatencyQuestionInput): number {
  return typeof question.timeoutMs === 'number' && Number.isFinite(question.timeoutMs) && question.timeoutMs > 0
    ? Math.round(question.timeoutMs)
    : 0;
}

/** 用 core 的 summarizeTransport 统计一组采样：超时判定由 classifyTimeout 决定，分母与分位数都在 core。 */
function summaryOf(samples: readonly LatencySampleInput[], timeoutMs: number): TransportSummary {
  return summarizeTransport(
    samples.map((sample) => ({
      ...(sample.latencyMs !== undefined ? { latencyMs: sample.latencyMs } : {}),
      ...(sample.ttftMs !== undefined ? { ttftMs: sample.ttftMs } : {}),
      ...(sample.error !== undefined ? { error: sample.error } : {}),
      ...(sample.error !== undefined ? { timedOut: isTimeoutClass(timeoutClassOf(sample, timeoutMs)) } : {}),
    })),
  );
}

function classesOf(samples: readonly LatencySampleInput[], timeoutMs: number): Record<TimeoutClass, number> {
  const byClass = emptyClasses();
  for (const sample of samples) {
    const cls = timeoutClassOf(sample, timeoutMs);
    if (cls !== undefined) byClass[cls] += 1;
  }
  return byClass;
}

function attemptStatsOf(samples: readonly LatencySampleInput[]): LatencyAttemptStats {
  let attempts = 0;
  let retriedSamples = 0;
  let timeoutAttempts = 0;
  for (const sample of samples) {
    const log = sample.attempts ?? [];
    attempts += log.length;
    if (log.length > 1) retriedSamples += 1;
    timeoutAttempts += log.filter((attempt) => attempt.outcome === 'timeout').length;
  }
  return { attempts, retriedSamples, timeoutAttempts };
}

function collectPeers(all: readonly LatencyQuestionInput[], questionId: string): { ttft: number[]; total: number[] } {
  const ttft: number[] = [];
  const total: number[] = [];
  for (const question of all) {
    if (question.questionId === questionId) continue;
    for (const sample of question.samples) {
      if (sample.error !== undefined) continue;
      const t = finite(sample.ttftMs);
      if (t !== undefined) ttft.push(t);
      const l = finite(sample.latencyMs);
      if (l !== undefined) total.push(l);
    }
  }
  return { ttft, total };
}

function questionReport(question: LatencyQuestionInput, all: readonly LatencyQuestionInput[]): QuestionLatencyReport {
  const timeoutMs = budgetOf(question);
  const summary = summaryOf(question.samples, timeoutMs);
  const byClass = classesOf(question.samples, timeoutMs);
  const attempt = attemptStatsOf(question.samples);
  const peer = collectPeers(all, question.questionId);
  const peerTtftP50 = percentile(peer.ttft, 50);
  const peerTotalP50 = percentile(peer.total, 50);

  let verdict: LatencyVerdict = 'normal';
  if (summary.initiated === 0) verdict = 'no-data';
  else if (summary.timedOut === summary.initiated) verdict = 'all-timeout';
  else if (summary.timedOut > 0) verdict = 'partial-timeout';
  else if (
    summary.ttft.p50 !== undefined &&
    peerTtftP50 !== undefined &&
    summary.ttft.p50 >= peerTtftP50 * 2 &&
    summary.ttft.p50 - peerTtftP50 >= 1000
  ) {
    verdict = 'slower-than-peers';
  }

  const sentences: string[] = [];
  if (summary.initiated === 0) {
    sentences.push('本题没有采样（未运行或已取消）。');
  } else {
    if (summary.timedOut > 0) {
      sentences.push(
        `超时 ${summary.timedOut}/${summary.initiated} 次（${pct(summary.timeoutRate)}），预算 ${ms(timeoutMs)}。`,
      );
      const classLine = classSentence(byClass);
      if (classLine) sentences.push(classLine);
    }
    if (summary.failed > 0)
      sentences.push(`另有 ${summary.failed} 次非超时传输错误（断流/限流/网关/网络），已从时延统计剔除。`);
    if (summary.ttft.n > 0) {
      sentences.push(`TTFT 中位 ${ms(summary.ttft.p50)}、p95 ${ms(summary.ttft.p95)}、最大 ${ms(summary.ttft.max)}。`);
    } else if (summary.completed > 0) {
      sentences.push('首字延迟未采集（非流式响应没有 TTFT），只统计总耗时。');
    }
    if (summary.latency.n > 0) {
      sentences.push(
        `总耗时中位 ${ms(summary.latency.p50)}、p95 ${ms(summary.latency.p95)}、最大 ${ms(summary.latency.max)}。`,
      );
    }
    if (timeoutMs > 0 && summary.latency.p95 !== undefined && summary.latency.p95 >= timeoutMs * 0.8) {
      sentences.push(`总耗时 p95 已占预算 ${pct(summary.latency.p95 / timeoutMs)}，余量不足，忙时容易超时。`);
    }
    if (verdict === 'slower-than-peers' && peerTtftP50 !== undefined && summary.ttft.p50 !== undefined) {
      sentences.push(
        `TTFT 中位是同端点其他题（${ms(peerTtftP50)}）的 ${(summary.ttft.p50 / peerTtftP50).toFixed(1)} 倍，属本题偏慢。`,
      );
    }
    if (summary.timedOut > 0) {
      const tags = question.tags ?? [];
      if (tags.includes('挂起')) {
        sentences.push('请求完全没有返回，按端点挂起/网络中断处理，不是模型能力问题。');
      } else if (tags.includes('长输出')) {
        sentences.push('若同端点短问答正常，优先怀疑长输出吞吐或预算不足；若短问答也超时，怀疑整体排队。');
      } else if (tags.includes('短问答')) {
        sentences.push('短问答也超时，基本排除「题太大」，优先检查端点排队或链路。');
      }
    }
    if (attempt.retriedSamples > 0) {
      sentences.push(
        `本题有 ${attempt.retriedSamples} 次采样重试过（attempt 共 ${attempt.attempts} 次）` +
          `${attempt.timeoutAttempts > 0 ? `，其中 ${attempt.timeoutAttempts} 次 attempt 超时` : ''}；` +
          '时延只按最终成功的那次计算，attempt 明细保留。',
      );
    }
    if (sentences.length === 0) sentences.push('时延正常，没有超时。');
  }

  return {
    questionId: question.questionId,
    group: question.group ?? '',
    timeoutMs,
    samples: summary.initiated,
    timeouts: summary.timedOut,
    otherErrors: summary.failed,
    timeoutRate: summary.timeoutRate,
    byClass,
    attempts: attempt.attempts,
    timeoutAttempts: attempt.timeoutAttempts,
    ttft: summary.ttft,
    total: summary.latency,
    ...(peerTtftP50 !== undefined ? { peerTtftP50 } : {}),
    ...(peerTotalP50 !== undefined ? { peerTotalP50 } : {}),
    verdict,
    sentences,
  };
}

/**
 * 统计一组题目的时延分布并生成可读结论。
 * `options.scopeGroup` 只影响统计范围；逐题对比基准始终取传入的全部题目。
 */
export function analyzeLatency(
  questions: readonly LatencyQuestionInput[],
  options: AnalyzeLatencyOptions = {},
): LatencyReport {
  const scoped = options.scopeGroup
    ? questions.filter((question) => question.group === options.scopeGroup)
    : [...questions];
  const reports = scoped.map((question) => questionReport(question, questions));
  const scopedSamples = scoped.flatMap((question) => [...question.samples]);
  const summary = summaryOf(scopedSamples, 0);
  const byClass = classesOf(scopedSamples, 0);
  const attempt = attemptStatsOf(scopedSamples);
  const expected = Math.max(options.expected ?? summary.initiated, summary.initiated);
  const cancelled = Math.max(0, Math.min(options.cancelled ?? 0, expected - summary.initiated));
  const notRun = Math.max(0, Math.min(options.notRun ?? 0, expected - summary.initiated - cancelled));
  const headlines: string[] = [];

  if (summary.initiated === 0) {
    headlines.push(
      expected > 0
        ? `本组没有采样：计划发起 ${expected} 次，未发起 ${expected} 次（取消 ${cancelled}、短路 ${notRun}）。`
        : '本组没有采样：本次没有运行「超时与响应时延」分组，或跑测已取消。',
    );
    return { ...summary, expected, cancelled, notRun, byClass, attempt, questions: reports, headlines };
  }

  if (summary.timedOut === summary.initiated) {
    headlines.push(
      `本组 ${summary.initiated} 次采样全部超时（100%）：该端点在本组预算下完全不可用，先排查端点可用性、网络和排队。`,
    );
  } else if (summary.timedOut > 0) {
    headlines.push(
      `本组 ${summary.initiated} 次采样中 ${summary.timedOut} 次超时（${pct(summary.timeoutRate)}）：部分请求超过预算，端点时延不稳定。`,
    );
  } else if (summary.ttft.n > 0) {
    headlines.push(
      `本组 ${summary.initiated} 次采样 0 超时，TTFT 中位 ${ms(summary.ttft.p50)}，总耗时中位 ${ms(summary.latency.p50)}。`,
    );
  } else {
    headlines.push(
      `本组 ${summary.initiated} 次采样 0 超时，TTFT 未采集（非流式响应），总耗时中位 ${ms(summary.latency.p50)}。`,
    );
  }

  const classLine = classSentence(byClass);
  if (classLine && summary.timedOut > 0) headlines.push(classLine);

  if (cancelled + notRun > 0) {
    headlines.push(
      `本次还有 ${cancelled + notRun} 次采样没有发起（用户取消 ${cancelled}、端点短路 ${notRun}），不计入超时率分母。`,
    );
  }
  if (attempt.retriedSamples > 0) {
    headlines.push(
      `有 ${attempt.retriedSamples} 次采样重试过（attempt 共 ${attempt.attempts} 次，其中 ${attempt.timeoutAttempts} 次超时）：` +
        '重试成功的采样按成功算，但 attempt 级超时不并进完成时延，也不会被抹掉。',
    );
  }

  const shortCandidates = reports.filter((report) => {
    const tags = scoped.find((question) => question.questionId === report.questionId)?.tags ?? [];
    return tags.includes('短问答') && report.ttft.p50 !== undefined;
  });
  const short =
    shortCandidates.find((report) => {
      const tags = scoped.find((question) => question.questionId === report.questionId)?.tags ?? [];
      return tags.includes('排队');
    }) ?? shortCandidates[0];
  if (short && short.ttft.p50 !== undefined) {
    if (short.ttft.p50 >= SLOW_TTFT_MS) {
      headlines.push(`短问答「${short.questionId}」的 TTFT 中位 ${ms(short.ttft.p50)}，说明不是题太大，是端点排队。`);
    } else {
      headlines.push(`短问答「${short.questionId}」的 TTFT 中位 ${ms(short.ttft.p50)}，端点排队不明显。`);
    }
  }

  const longs = reports.filter(
    (report) => scoped.find((question) => question.questionId === report.questionId)?.tags?.includes('长输出') === true,
  );
  if (longs.length > 0) {
    const longTimeouts = longs.reduce((sum, report) => sum + report.timeouts, 0);
    const worstBudget = Math.max(
      ...longs.map((report) =>
        report.timeoutMs > 0 && report.total.p95 !== undefined ? report.total.p95 / report.timeoutMs : 0,
      ),
    );
    if (longTimeouts > 0) {
      headlines.push('长输出题出现超时：短问答正常说明是长输出吞吐或预算不足，短问答也慢说明整体排队。');
    } else if (worstBudget >= 0.8) {
      headlines.push(`长输出题没有超时，但总耗时 p95 最高已占预算 ${pct(worstBudget)}，余量偏小。`);
    }
  }

  const measured = reports.filter((report) => report.ttft.p50 !== undefined);
  if (measured.length >= 2) {
    const p50s = measured.map((report) => report.ttft.p50 as number);
    const min = Math.min(...p50s);
    const max = Math.max(...p50s);
    const shortTagged = new Set(
      scoped.filter((question) => question.tags?.includes('短问答') === true).map((question) => question.questionId),
    );
    if (max <= min * 2) {
      headlines.push(
        max >= SLOW_TTFT_MS
          ? `本组各题 TTFT 中位在 ${ms(min)}–${ms(max)} 之间，差异不到 2 倍，像整个端点慢（排队/链路），不是某一题特别重。`
          : `本组各题 TTFT 中位在 ${ms(min)}–${ms(max)} 之间，差异不到 2 倍，端点首字正常。`,
      );
    } else {
      // 短问答天然应该最快；它反而慢是排队，不是「题太重」，所以不算单题偏慢。
      const slowIds = measured
        .filter((report) => report.verdict === 'slower-than-peers' && !shortTagged.has(report.questionId))
        .map((report) => report.questionId);
      if (slowIds.length > 0) {
        headlines.push(
          `只有 ${slowIds.join('、')} 的 TTFT 中位显著高于同端点其他题（≥2 倍），其余题接近：更像单题偏慢，不是整个端点慢。`,
        );
      } else if (
        short &&
        short.ttft.p50 !== undefined &&
        short.ttft.p50 >= SLOW_TTFT_MS &&
        short.ttft.p50 >= min * 2 &&
        short.ttft.p50 >= max * 0.8
      ) {
        headlines.push(`短问答比重题还慢（${ms(short.ttft.p50)} vs 最快 ${ms(min)}）：瓶颈在排队/调度，不是题量太大。`);
      }
    }
  }

  return { ...summary, expected, cancelled, notRun, byClass, attempt, questions: reports, headlines };
}
