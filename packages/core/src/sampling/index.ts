/**
 * 确定性抽样（F4 / D3）：seed → 同一套题，结果可复现。自己实现 PRNG，零依赖。
 * 乘法散列（FNV-1a + xmur3 混合）做种子扩散，mulberry32 做序列，Fisher-Yates 做抽取。
 */
import type { Question } from '../types.js';

export function hashString(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // xmur3 扩散，避免相邻 seed 产生相近序列
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SampleOptions {
  seed: string;
  /** 只抽这些分组，缺省全部分组。 */
  groups?: readonly string[];
  /** 每组抽多少题，缺省该组全量。 */
  perGroup?: number;
  /** 显式排除的题 id。 */
  exclude?: readonly string[];
}

/** 题集版本（D6）：与 seed 无关，只对题库内容取指纹。 */
export function questionBankVersion(questions: readonly Question[]): string {
  const canonical = [...questions]
    .map((q) => `${q.id}|${q.group}|${q.judge}|${JSON.stringify(q.expect ?? null)}|${q.prompt}`)
    .sort()
    .join('\n');
  return `qb-${hashString(canonical).toString(16).padStart(8, '0')}`;
}

/**
 * 抽样：先按 id 排序（消除输入顺序影响），再用 seed 洗牌 + 按组分桶取前 N，
 * 最后按 id 排序返回，保证同 seed + 同题库 → 逐题一致。
 */
export function sampleSuite(questions: readonly Question[], opts: SampleOptions): Question[] {
  const pool = [...questions]
    .filter((q) => (opts.groups ? opts.groups.includes(q.group) : true))
    .filter((q) => (opts.exclude ? !opts.exclude.includes(q.id) : true))
    .sort((a, b) => a.id.localeCompare(b.id));

  const rand = mulberry32(hashString(opts.seed));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = pool[i] as Question;
    pool[i] = pool[j] as Question;
    pool[j] = tmp;
  }

  const picked: Question[] = [];
  const byGroup = new Map<string, number>();
  for (const q of pool) {
    const taken = byGroup.get(q.group) ?? 0;
    if (opts.perGroup !== undefined && taken >= opts.perGroup) continue;
    byGroup.set(q.group, taken + 1);
    picked.push(q);
  }

  return picked.sort((a, b) => a.id.localeCompare(b.id));
}
