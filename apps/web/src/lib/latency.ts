/**
 * 超时与响应时延统计（纯函数、无 IO）。
 *
 * 输入是「每题 × 每次采样」的原始计时：`latencyMs`（总耗时）、`ttftMs`（首字延迟）、
 * `error`（传输层错误文案）。输出既给分位数，也给**可直接读的结论**——只给一张数字表
 * 无法回答用户真正关心的问题：「是这题太重，还是整个端点在排队」。
 *
 * 口径（与 apps/web/src/lib/transport.ts 的唯一超时文案对齐）：
 * - 超时 = `error` 以「请求超时」开头；断流、网络错误另记为 `otherErrors`，不混进超时率。
 * - 分位数用 nearest-rank（升序第 ceil(p×n) 个，不插值）；n=1 时 p50=p95=max。
 * - 时延只统计没有 `error` 的有效采样；失败的采样最多只计一次超时，不参与分位数。
 * - TTFT 只有流式响应才有；全部缺失时明确说「未采集」，不给 0 充数。
 * - 「同端点其他题」= 同一次跑测里除本题外的所有有效采样中位，用于区分单题偏慢与整体排队。
 */
export interface LatencySampleInput {
  latencyMs?: number;
  ttftMs?: number;
  error?: string;
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

export interface LatencyStats {
  n: number;
  p50?: number;
  p95?: number;
  max?: number;
}

export type LatencyVerdict = 'all-timeout' | 'partial-timeout' | 'no-data' | 'slower-than-peers' | 'normal';

export interface QuestionLatencyReport {
  questionId: string;
  group: string;
  timeoutMs: number;
  samples: number;
  timeouts: number;
  otherErrors: number;
  timeoutRate: number;
  ttft: LatencyStats;
  total: LatencyStats;
  /** 同端点其他题的有效 TTFT 中位；没有可比样本时 undefined。 */
  peerTtftP50?: number;
  peerTotalP50?: number;
  verdict: LatencyVerdict;
  /** 本题的可读结论，按重要程度排列。 */
  sentences: string[];
}

export interface LatencyReport {
  samples: number;
  timeouts: number;
  timeoutRate: number;
  ttft: LatencyStats;
  total: LatencyStats;
  questions: QuestionLatencyReport[];
  /** 放结果页顶部的整体结论。 */
  headlines: string[];
}

/** 首字慢的绝对门槛：超过 3 秒对短问答已经不可用，低于它不要下「端点排队」的结论。 */
export const SLOW_TTFT_MS = 3000;

export interface AnalyzeLatencyOptions {
  /** 只把这些分组纳入整体统计与逐题表；对比基准仍用传入的全部题目（同端点其他题）。 */
  scopeGroup?: string;
}

/** nearest-rank 分位数；空数组返回 undefined。 */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(100, Math.max(0, p));
  const rank = Math.ceil((clamped / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function latencyStats(values: readonly number[]): LatencyStats {
  if (values.length === 0) return { n: 0 };
  const max = Math.max(...values);
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max,
  };
}

/** transport.ts 的超时文案：`请求超时（Nms）`。 */
export function isTimeoutError(error: string | undefined): boolean {
  return typeof error === 'string' && error.startsWith('请求超时');
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

function samplesOf(question: LatencyQuestionInput): number {
  return question.samples.length;
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
  const samples = samplesOf(question);
  const timeouts = question.samples.filter((sample) => isTimeoutError(sample.error)).length;
  const otherErrors = question.samples.filter((sample) => sample.error !== undefined && !isTimeoutError(sample.error)).length;
  const valid = question.samples.filter((sample) => sample.error === undefined);
  const ttftValues = valid.map((sample) => finite(sample.ttftMs)).filter((value): value is number => value !== undefined);
  const totalValues = valid.map((sample) => finite(sample.latencyMs)).filter((value): value is number => value !== undefined);
  const ttft = latencyStats(ttftValues);
  const total = latencyStats(totalValues);
  const timeoutMs = budgetOf(question);
  const peer = collectPeers(all, question.questionId);
  const peerTtftP50 = percentile(peer.ttft, 50);
  const peerTotalP50 = percentile(peer.total, 50);

  const timeoutRate = samples === 0 ? 0 : timeouts / samples;
  let verdict: LatencyVerdict = 'normal';
  if (samples === 0) verdict = 'no-data';
  else if (timeouts === samples) verdict = 'all-timeout';
  else if (timeouts > 0) verdict = 'partial-timeout';
  else if (
    ttft.p50 !== undefined &&
    peerTtftP50 !== undefined &&
    ttft.p50 >= peerTtftP50 * 2 &&
    ttft.p50 - peerTtftP50 >= 1000
  ) {
    verdict = 'slower-than-peers';
  }

  const sentences: string[] = [];
  if (samples === 0) {
    sentences.push('本题没有采样（未运行或已取消）。');
  } else {
    if (timeouts > 0) sentences.push(`超时 ${timeouts}/${samples} 次（${pct(timeoutRate)}），预算 ${ms(timeoutMs)}。`);
    if (otherErrors > 0) sentences.push(`另有 ${otherErrors} 次非超时传输错误（断流/网络），已从时延统计剔除。`);
    if (ttft.n > 0) {
      sentences.push(`TTFT 中位 ${ms(ttft.p50)}、p95 ${ms(ttft.p95)}、最大 ${ms(ttft.max)}。`);
    } else if (valid.length > 0) {
      sentences.push('首字延迟未采集（非流式响应没有 TTFT），只统计总耗时。');
    }
    if (total.n > 0) {
      sentences.push(`总耗时中位 ${ms(total.p50)}、p95 ${ms(total.p95)}、最大 ${ms(total.max)}。`);
    }
    if (timeoutMs > 0 && total.p95 !== undefined && total.p95 >= timeoutMs * 0.8) {
      sentences.push(`总耗时 p95 已占预算 ${pct(total.p95 / timeoutMs)}，余量不足，忙时容易超时。`);
    }
    if (verdict === 'slower-than-peers' && peerTtftP50 !== undefined && ttft.p50 !== undefined) {
      sentences.push(`TTFT 中位是同端点其他题（${ms(peerTtftP50)}）的 ${(ttft.p50 / peerTtftP50).toFixed(1)} 倍，属本题偏慢。`);
    }
    if (timeouts > 0) {
      const tags = question.tags ?? [];
      if (tags.includes('挂起')) {
        sentences.push('请求完全没有返回，按端点挂起/网络中断处理，不是模型能力问题。');
      } else if (tags.includes('长输出')) {
        sentences.push('若同端点短问答正常，优先怀疑长输出吞吐或预算不足；若短问答也超时，怀疑整体排队。');
      } else if (tags.includes('短问答')) {
        sentences.push('短问答也超时，基本排除「题太大」，优先检查端点排队或链路。');
      }
    }
    if (sentences.length === 0) sentences.push('时延正常，没有超时。');
  }

  return {
    questionId: question.questionId,
    group: question.group ?? '',
    timeoutMs,
    samples,
    timeouts,
    otherErrors,
    timeoutRate,
    ttft,
    total,
    ...(peerTtftP50 !== undefined ? { peerTtftP50 } : {}),
    ...(peerTotalP50 !== undefined ? { peerTotalP50 } : {}),
    verdict,
    sentences,
  };
}

function totalStats(questions: readonly LatencyQuestionInput[]): {
  samples: number;
  timeouts: number;
  ttft: LatencyStats;
  total: LatencyStats;
} {
  const samples = questions.reduce((sum, question) => sum + question.samples.length, 0);
  const timeouts = questions.reduce(
    (sum, question) => sum + question.samples.filter((sample) => isTimeoutError(sample.error)).length,
    0,
  );
  const ttft: number[] = [];
  const total: number[] = [];
  for (const question of questions) {
    for (const sample of question.samples) {
      if (sample.error !== undefined) continue;
      const t = finite(sample.ttftMs);
      if (t !== undefined) ttft.push(t);
      const l = finite(sample.latencyMs);
      if (l !== undefined) total.push(l);
    }
  }
  return { samples, timeouts, ttft: latencyStats(ttft), total: latencyStats(total) };
}

/**
 * 统计一组题目的时延分布并生成可读结论。
 * `options.scopeGroup` 只影响统计范围；逐题对比基准始终取传入的全部题目。
 */
export function analyzeLatency(
  questions: readonly LatencyQuestionInput[],
  options: AnalyzeLatencyOptions = {},
): LatencyReport {
  const scoped = options.scopeGroup ? questions.filter((question) => question.group === options.scopeGroup) : [...questions];
  const reports = scoped.map((question) => questionReport(question, questions));
  const overall = totalStats(scoped);
  const timeoutRate = overall.samples === 0 ? 0 : overall.timeouts / overall.samples;
  const headlines: string[] = [];

  if (overall.samples === 0) {
    headlines.push('本组没有采样：本次没有运行「超时与响应时延」分组，或跑测已取消。');
    return { ...overall, timeoutRate, questions: reports, headlines };
  }

  if (overall.timeouts === overall.samples) {
    headlines.push(
      `本组 ${overall.samples} 次采样全部超时（100%）：该端点在本组预算下完全不可用，先排查端点可用性、网络和排队。`,
    );
  } else if (overall.timeouts > 0) {
    headlines.push(
      `本组 ${overall.samples} 次采样中 ${overall.timeouts} 次超时（${pct(timeoutRate)}）：部分请求超过预算，端点时延不稳定。`,
    );
  } else {
    if (overall.ttft.n > 0) {
      headlines.push(`本组 ${overall.samples} 次采样 0 超时，TTFT 中位 ${ms(overall.ttft.p50)}，总耗时中位 ${ms(overall.total.p50)}。`);
    } else {
      headlines.push(`本组 ${overall.samples} 次采样 0 超时，TTFT 未采集（非流式响应），总耗时中位 ${ms(overall.total.p50)}。`);
    }
  }

  const shortCandidates = reports.filter((report) => {
    const tags = scoped.find((question) => question.questionId === report.questionId)?.tags ?? [];
    return tags.includes('短问答') && report.ttft.p50 !== undefined;
  });
  const short = shortCandidates.find((report) => {
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
    const worstBudget = Math.max(...longs.map((report) => (report.timeoutMs > 0 && report.total.p95 !== undefined ? report.total.p95 / report.timeoutMs : 0)));
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
    const shortTagged = new Set(scoped.filter((question) => question.tags?.includes('短问答') === true).map((question) => question.questionId));
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
        headlines.push(`只有 ${slowIds.join('、')} 的 TTFT 中位显著高于同端点其他题（≥2 倍），其余题接近：更像单题偏慢，不是整个端点慢。`);
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

  return { ...overall, timeoutRate, questions: reports, headlines };
}
