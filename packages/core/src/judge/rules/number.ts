/**
 * number —— 取正文中最后一个数，与期望值在容差内比较。
 * expect: { value: number, tolerance?: number, relative?: boolean }
 * tolerance 缺省 1e-6；relative:true 时按 |期望| 的比例算容差。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, numbersIn, transportChecks, truncate } from './shared.js';

export interface NumberExpect {
  value: number;
  tolerance?: number;
  relative?: boolean;
}

function normalize(expect: unknown): NumberExpect {
  if (typeof expect === 'number') return { value: expect };
  if (!expect || typeof expect !== 'object') throw new Error('number judge 需要 expect 为 { value: number }');
  const e = expect as Partial<NumberExpect>;
  if (typeof e.value !== 'number' || !Number.isFinite(e.value)) {
    throw new Error('number judge 的 expect.value 必须是有限数字');
  }
  if (e.tolerance !== undefined && (typeof e.tolerance !== 'number' || e.tolerance < 0)) {
    throw new Error('number judge 的 expect.tolerance 必须是非负数字');
  }
  return {
    value: e.value,
    ...(e.tolerance !== undefined ? { tolerance: e.tolerance } : {}),
    ...(e.relative ? { relative: true } : {}),
  };
}

export function judgeNumber({ response, question }: JudgeContext): JudgeCheck[] {
  const empty = emptyChecks(response);
  if (empty) return [...empty, ...transportChecks(response)];

  const exp = normalize(question.expect);
  const found = numbersIn(response.text);
  if (found.length === 0) {
    return [
      { name: 'number.found', pass: false, hard: true, detail: `正文里没有数字；正文：${truncate(response.text)}` },
      ...transportChecks(response),
    ];
  }

  const actual = found[found.length - 1] as number;
  const base = exp.relative ? Math.abs(exp.value) : 1;
  const tol = (exp.tolerance ?? 1e-6) * base;
  const diff = Math.abs(actual - exp.value);
  const pass = diff <= tol;

  return [
    { name: 'number.found', pass: true },
    {
      name: 'number.value',
      pass,
      ...(pass ? {} : { detail: `期望 ${exp.value}±${tol}，实际 ${actual}（差 ${diff}）` }),
    },
    ...transportChecks(response),
  ];
}
