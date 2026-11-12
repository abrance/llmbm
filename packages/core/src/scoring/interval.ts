/**
 * 采样统计（D3）：每题 N 次 → 均值 ± 半宽。半宽用 Student-t 95% 置信区间，
 * 小样本（N=3）下 t 值远大于 1.96，宁可区间宽也不谎报精度。
 */
export interface SampleStat {
  mean: number;
  /** 半宽（半区间长度），mean ± halfWidth。 */
  halfWidth: number;
  n: number;
  values: number[];
}

/** 双侧 95% 的 t 分位数（df=1..30），df>30 用 1.96。 */
const T95: readonly number[] = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11,
  2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

export function sampleStat(values: readonly number[]): SampleStat {
  const n = values.length;
  if (n === 0) return { mean: 0, halfWidth: 0, n: 0, values: [] };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, halfWidth: 0, n, values: [...values] };
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const t = n - 1 <= T95.length ? (T95[n - 2] as number) : 1.96;
  const halfWidth = (t * sd) / Math.sqrt(n);
  return { mean, halfWidth, n, values: [...values] };
}

export function roundStat(stat: SampleStat, digits = 2): SampleStat {
  const f = (x: number) => Number(x.toFixed(digits));
  return { ...stat, mean: f(stat.mean), halfWidth: f(stat.halfWidth) };
}

/** 人类可读形式：`87.33 ± 4.12 (n=3)`。 */
export function formatStat(stat: SampleStat, digits = 2): string {
  const s = roundStat(stat, digits);
  return `${s.mean} ± ${s.halfWidth} (n=${s.n})`;
}
