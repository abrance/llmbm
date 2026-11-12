/**
 * 维度聚合 + 能力分 + 总分区间（F7 / F8 / D3）。
 * 输入是「每题 × 每次采样」的 QuestionScore；聚合先算每题均值（带区间），再按权重聚合，
 * 避免某题采样数多就自动占更多权重。
 */
import type { QuestionScore } from './types.js';
import { questionStatus } from './scoring/index.js';
import { sampleStat, type SampleStat } from './scoring/interval.js';

export const MAX_SCORE = 100;
/** F8：非全 100 时封顶 99。 */
export const SCORE_CAP = 99;

export interface DimensionScore {
  dimension: string;
  /** 该维度题均值的加权平均；halfWidth 取维度内题级半宽的均值。 */
  stat: SampleStat;
  questions: number;
}

export interface OutcomeReport {
  total: SampleStat;
  capped: boolean;
  dimensions: DimensionScore[];
  /** 格式检查命中率（format-json 类题，题均值 ≥90 记命中）。 */
  format: { rate: number; hit: number; total: number };
  /** 完成率 = 有采样的题 / 应跑题数。 */
  stability: { completed: number; expected: number; rate: number };
  counts: { pass: number; pending: number; fail: number; questions: number };
  /**
   * D5：传输错误单独统计 —— 没收到答案 ≠ 答得不对，不进能力分。
   * `samples` 是实际请求次数，`errors` 是其中传输失败的次数。
   */
  transport: { errors: number; samples: number; rate: number };
  /** D5：进入能力分聚合的有效采样数（= samples - transport.errors）。 */
  samples: { valid: number; total: number };
}

export interface AggregateInput {
  scores: readonly QuestionScore[];
  /** 应跑题数（取消/断点续跑时用队列长度，而非已采样题数）。 */
  expectedQuestions?: number;
  /** 每题权重，缺省 1。 */
  weights?: Record<string, number>;
}

function groupByQuestion(scores: readonly QuestionScore[]): Map<string, QuestionScore[]> {
  const map = new Map<string, QuestionScore[]>();
  for (const s of scores) {
    const list = map.get(s.questionId);
    if (list) list.push(s);
    else map.set(s.questionId, [s]);
  }
  return map;
}

export function aggregate({ scores, expectedQuestions, weights }: AggregateInput): OutcomeReport {
  const perQuestion = groupByQuestion(scores);
  const dimMap = new Map<string, { weighted: number; weight: number; halfWidths: number[] }>();
  const questionMeans: { mean: number; weight: number }[] = [];

  let pass = 0;
  let pending = 0;
  let fail = 0;
  let formatHit = 0;
  let formatTotal = 0;
  let transportErrors = 0;
  let totalSamples = 0;
  let validSamples = 0;

  for (const [questionId, list] of perQuestion) {
    // 传输失败的采样不进入均值，并单独立账；没有有效采样时整题不进能力分。
    const valid = list.filter((s) => s.transportError !== true);
    transportErrors += list.length - valid.length;
    totalSamples += list.length;
    validSamples += valid.length;
    if (valid.length === 0) {
      pending += 1;
      continue;
    }
    const stat = sampleStat(valid.map((s) => s.score));
    const weight = weights?.[questionId] ?? 1;
    const first = valid[0] as QuestionScore;
    const dim = dimMap.get(first.group) ?? { weighted: 0, weight: 0, halfWidths: [] };
    dim.weighted += stat.mean * weight;
    dim.weight += weight;
    dim.halfWidths.push(stat.halfWidth);
    dimMap.set(first.group, dim);
    questionMeans.push({ mean: stat.mean, weight });

    // 题级状态只看有效采样；有效采样不足时是待复核而不是失败（D5）。
    const status = questionStatus(list);
    if (status === 'fail') fail += 1;
    else if (status === 'pending_review') pending += 1;
    else pass += 1;

    if (first.judge === 'format-json') {
      formatTotal += 1;
      if (stat.mean >= 90) formatHit += 1;
    }
  }

  const dimensions: DimensionScore[] = [...dimMap.entries()]
    .map(([dimension, d]) => {
      const mean = d.weight === 0 ? 0 : d.weighted / d.weight;
      const halfWidth = d.halfWidths.reduce((a, b) => a + b, 0) / Math.max(1, d.halfWidths.length);
      return { dimension, stat: { mean, halfWidth, n: d.halfWidths.length, values: [] }, questions: d.halfWidths.length };
    })
    .sort((a, b) => a.dimension.localeCompare(b.dimension));

  const totalWeight = questionMeans.reduce((a, b) => a + b.weight, 0);
  const totalMean = totalWeight === 0 ? 0 : questionMeans.reduce((a, b) => a + b.mean * b.weight, 0) / totalWeight;
  const capped = questionMeans.some((q) => q.mean < MAX_SCORE);
  const totalHalfWidth = dimensions.length === 0
    ? 0
    : dimensions.reduce((a, d) => a + d.stat.halfWidth, 0) / dimensions.length;

  const completed = perQuestion.size;
  const expected = expectedQuestions ?? completed;
  const scored = questionMeans.length;

  return {
    total: {
      mean: capped ? Math.min(SCORE_CAP, totalMean) : totalMean,
      halfWidth: totalHalfWidth,
      n: scored,
      values: [],
    },
    capped,
    dimensions,
    format: { rate: formatTotal === 0 ? 0 : formatHit / formatTotal, hit: formatHit, total: formatTotal },
    stability: { completed, expected, rate: expected === 0 ? 0 : completed / expected },
    counts: { pass, pending, fail, questions: completed },
    transport: { errors: transportErrors, samples: totalSamples, rate: totalSamples === 0 ? 0 : transportErrors / totalSamples },
    samples: { valid: validSamples, total: totalSamples },
  };
}
