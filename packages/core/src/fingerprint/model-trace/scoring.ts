/**
 * ModelTrace 指纹排名打分 —— 从 lm-detector 的 `shared/fingerprint-core.js` 忠实移植。
 *
 * 原理：xqy2006/ModelTrace。上游实现：https://github.com/ikaleio/lm-detector
 * （MIT, Copyright (c) 2026 xqy2006）。本文件只保留排名打分必需的纯函数：
 * 把一次回答里的整数序列 → 355 维 Hellinger 特征（含 4×16 有序块 + 末位数字分布），
 * 对库内质心做点积 + nuisance 基投影 + 标准化，得到每个候选模型的排名分。
 *
 * D1：打分只有这一份实现，web / api 都从这里引；不得在别处再写一套。
 * 纯函数、无网络、无依赖 —— 输入原始数字数组和精简库（model-trace-bank.json）。
 */

export const VALUE_MIN = 1;
export const VALUE_MAX = 355;
export const DIMENSION = VALUE_MAX - VALUE_MIN + 1; // 355
export const ALPHA = 0.5;

/** 预处理块：每个特征维度的均值 / 尺度 + nuisance 基 + 各模型质心。 */
export interface FeatureBlock {
  feature_mean: number[];
  feature_scale: number[];
  nuisance_rank?: number;
  nuisance_basis: number[][];
  centroids: number[][];
}

export interface HellingerBlock extends FeatureBlock {
  nuisance_environments?: number[] | string[];
}

export interface OrderedBlock extends FeatureBlock {
  weight: number;
  feature?: string;
  environment_centroids: number[][][];
}

/** 精简库里每个模型的展示元数据（家族卡用，不参与打分）。 */
export interface BankModelMeta {
  id: string;
  display_name: string;
  family: string;
  family_name: string;
}

/** 精简库（model-trace-bank.json）里参与打分的部分。 */
export interface ScoringBank {
  model_order: string[];
  models: BankModelMeta[];
  calibration: Record<string, { beta: number; cv_accuracy: number | null; [key: string]: unknown }>;
  robust: {
    hellinger: HellingerBlock;
    ordered_blocks: OrderedBlock;
  };
}

/**
 * 从一段文本里抽取「最长的有效整数序列」：连续数字（被字母隔开则切成多段）里只保留 1..355，
 * 返回长度最长的那段。与上游 parseNumbers 完全一致 —— 候选回答常常掺着说明文字。
 */
export function parseNumbers(text: string): number[] {
  const runs: number[][] = [];
  let current: number[] = [];
  let previousEnd = 0;
  const source = String(text);
  for (const match of source.matchAll(/\d+/g)) {
    const index = match.index ?? 0;
    const separator = source.slice(previousEnd, index);
    const value = Number(match[0]);
    if (current.length && /\p{L}/u.test(separator)) {
      runs.push(current);
      current = [];
    }
    if (value >= VALUE_MIN && value <= VALUE_MAX) current.push(value);
    previousEnd = index + match[0].length;
  }
  if (current.length) runs.push(current);
  return runs.reduce((best, run) => (run.length > best.length ? run : best), [] as number[]);
}

/** 计数直方图（长度 355）。 */
export function countNumbers(numbers: readonly number[]): number[] {
  const counts = new Array<number>(DIMENSION).fill(0);
  for (const number of numbers) counts[number - VALUE_MIN] = (counts[number - VALUE_MIN] ?? 0) + 1;
  return counts;
}

const mean = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0) / values.length;

function standardize(values: readonly number[]): number[] {
  const center = mean(values);
  const variance = mean(values.map((value) => (value - center) ** 2));
  const scale = Math.max(Math.sqrt(variance), 1e-12);
  return values.map((value) => (value - center) / scale);
}

function dot(left: readonly number[], right: readonly number[]): number {
  let value = 0;
  for (let index = 0; index < left.length; index += 1) value += left[index]! * right[index]!;
  return value;
}

function norm(values: readonly number[]): number {
  return Math.sqrt(dot(values, values));
}

function normalized(values: readonly number[]): number[] {
  const scale = Math.max(norm(values), 1e-12);
  return values.map((value) => value / scale);
}

function subtractBasis(values: readonly number[], basis: readonly number[][]): number[] {
  const output = values.slice();
  for (const vector of basis ?? []) {
    const projection = dot(output, vector);
    for (let index = 0; index < output.length; index += 1) output[index]! -= projection * vector[index]!;
  }
  return output;
}

/** 355 维 Hellinger 特征（加 ALPHA 平滑后的平方根频率）。 */
export function hellingerFeature(counts: readonly number[]): number[] {
  const total = counts.reduce((sum, value) => sum + value, 0) + ALPHA * DIMENSION;
  return counts.map((value) => Math.sqrt((value + ALPHA) / total));
}

function splitIntoFour(values: readonly number[]): number[][] {
  const base = Math.floor(values.length / 4);
  const remainder = values.length % 4;
  const chunks: number[][] = [];
  let start = 0;
  for (let index = 0; index < 4; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    chunks.push(values.slice(start, start + size));
    start += size;
  }
  return chunks;
}

/** 74 维有序块特征：4 个位置块各 16 档 + 末位数字 10 项分布。 */
export function orderedBlockFeature(numbers: readonly number[]): number[] {
  const pieces: number[] = [];
  for (const chunk of splitIntoFour(numbers)) {
    const bins = new Array<number>(16).fill(0.5);
    for (const value of chunk) {
      const index = Math.min(15, Math.floor(((value - 1) / 355) * 16));
      bins[index]! += 1;
    }
    const total = bins.reduce((sum, value) => sum + value, 0);
    pieces.push(...bins.map((value) => Math.sqrt(value / total)));
  }
  const lastDigits = new Array<number>(10).fill(0.5);
  for (const value of numbers) lastDigits[value % 10]! += 1;
  const lastTotal = lastDigits.reduce((sum, value) => sum + value, 0);
  pieces.push(...lastDigits.map((value) => Math.sqrt(value / lastTotal)));
  return pieces;
}

function robustScoreCounts(counts: readonly number[], bank: ScoringBank): number[] {
  const artifact = bank.robust.hellinger;
  const feature = hellingerFeature(counts);
  let projected = feature.map((value, index) => (value - artifact.feature_mean[index]!) / artifact.feature_scale[index]!);
  projected = subtractBasis(projected, artifact.nuisance_basis);
  projected = normalized(projected);
  const scores = artifact.centroids.map((centroid) => dot(projected, centroid));
  return standardize(scores);
}

function orderedBlockScores(numbers: readonly number[], bank: ScoringBank): number[] {
  const artifact = bank.robust.ordered_blocks;
  const feature = orderedBlockFeature(numbers);
  const standardizedFeature = feature.map((value, index) => (value - artifact.feature_mean[index]!) / artifact.feature_scale[index]!);
  const unit = normalized(standardizedFeature);
  const environmentScores = artifact.environment_centroids.map((centroids) => centroids.map((centroid) => dot(unit, centroid)));
  const template = standardize(
    artifact.centroids.map((_, modelIndex) => Math.max(...environmentScores.map((scores) => scores[modelIndex]!))),
  );
  const projected = normalized(subtractBasis(standardizedFeature, artifact.nuisance_basis));
  const nuisance = standardize(artifact.centroids.map((centroid) => dot(projected, centroid)));
  return standardize(template.map((value, index) => 0.5 * value + 0.5 * nuisance[index]!));
}

/** 单条回答的排名分（70 维，与 model_order 对齐）。 */
export function robustScoreNumbers(numbers: readonly number[], bank: ScoringBank): number[] {
  const marginal = robustScoreCounts(countNumbers(numbers), bank);
  const artifact = bank.robust.ordered_blocks;
  const weight = artifact ? Number(artifact.weight || 0) : 0;
  if (!artifact || weight === 0) return marginal;
  const ordered = orderedBlockScores(numbers, bank);
  return marginal.map((value, index) => (1 - weight) * value + weight * ordered[index]!);
}
