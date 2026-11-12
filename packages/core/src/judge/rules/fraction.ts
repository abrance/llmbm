/**
 * fraction —— 分数/小数/百分数三种写法统一换算后比较。
 * expect: { numerator: number, denominator: number, tolerance?: number }
 * 接受 "3/4"、"0.75"、"75%"；取正文中最后一个可识别的数值。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, transportChecks, truncate } from './shared.js';

export interface FractionExpect {
  numerator: number;
  denominator: number;
  tolerance?: number;
}

function normalize(expect: unknown): FractionExpect {
  if (!expect || typeof expect !== 'object') {
    throw new Error('fraction judge 需要 expect 为 { numerator, denominator }');
  }
  const e = expect as Partial<FractionExpect>;
  if (typeof e.numerator !== 'number' || typeof e.denominator !== 'number') {
    throw new Error('fraction judge 的 expect.numerator / denominator 必须是数字');
  }
  if (e.denominator === 0) throw new Error('fraction judge 的 expect.denominator 不能为 0');
  if (e.tolerance !== undefined && (typeof e.tolerance !== 'number' || e.tolerance < 0)) {
    throw new Error('fraction judge 的 expect.tolerance 必须是非负数字');
  }
  return {
    numerator: e.numerator,
    denominator: e.denominator,
    ...(e.tolerance !== undefined ? { tolerance: e.tolerance } : {}),
  };
}

interface Candidate {
  raw: string;
  value: number;
  index: number;
}

/** 依次识别 a/b、百分数、普通小数，按出现位置排序；被前两者覆盖的区间不再重复计入。 */
export function fractionCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const spans: Array<[number, number]> = [];

  const ratioRe = /(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = ratioRe.exec(text)) !== null) {
    const den = Number(m[2]);
    if (den === 0) continue;
    out.push({ raw: m[0], value: Number(m[1]) / den, index: m.index });
    spans.push([m.index, m.index + m[0].length]);
  }

  const pctRe = /(-?\d+(?:\.\d+)?)\s*[%％]/g;
  while ((m = pctRe.exec(text)) !== null) {
    out.push({ raw: m[0], value: Number(m[1]) / 100, index: m.index });
    spans.push([m.index, m.index + m[0].length]);
  }

  const covered = (i: number) => spans.some(([a, b]) => i >= a && i < b);
  const plainRe = /-?\d+(?:\.\d+)?/g;
  while ((m = plainRe.exec(text)) !== null) {
    if (covered(m.index)) continue;
    out.push({ raw: m[0], value: Number(m[0]), index: m.index });
  }

  return out.sort((a, b) => a.index - b.index);
}

export function judgeFraction({ response, question }: JudgeContext): JudgeCheck[] {
  const empty = emptyChecks(response);
  if (empty) return [...empty, ...transportChecks(response)];

  const exp = normalize(question.expect);
  const expected = exp.numerator / exp.denominator;
  const tol = exp.tolerance ?? 1e-6;
  const candidates = fractionCandidates(response.text);

  if (candidates.length === 0) {
    return [
      { name: 'fraction.found', pass: false, hard: true, detail: `正文里没有可识别的数值；正文：${truncate(response.text)}` },
      ...transportChecks(response),
    ];
  }

  const actual = candidates[candidates.length - 1] as Candidate;
  const pass = Math.abs(actual.value - expected) <= tol;

  return [
    { name: 'fraction.found', pass: true, detail: `识别到「${actual.raw}」= ${actual.value}` },
    {
      name: 'fraction.value',
      pass,
      ...(pass ? {} : { detail: `期望 ${exp.numerator}/${exp.denominator} = ${expected}，实际「${actual.raw}」= ${actual.value}` }),
    },
    ...transportChecks(response),
  ];
}
