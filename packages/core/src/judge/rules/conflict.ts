/**
 * conflict —— 同一回答里不能同时出现互斥的两个说法（自洽性检查）。
 * expect: { pairs: { a: string, b: string }[] }
 * 每对一条 check：两者都出现即失败。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, transportChecks, truncate } from './shared.js';

export interface ConflictExpect {
  pairs: Array<{ a: string; b: string }>;
}

function normalize(expect: unknown): ConflictExpect {
  if (!expect || typeof expect !== 'object') throw new Error('conflict judge 需要 expect 为 { pairs: [...] }');
  const e = expect as Partial<ConflictExpect>;
  if (!Array.isArray(e.pairs) || e.pairs.length === 0) throw new Error('conflict judge 的 expect.pairs 必须是非空数组');
  for (const p of e.pairs) {
    if (!p || typeof p.a !== 'string' || typeof p.b !== 'string' || !p.a || !p.b) {
      throw new Error('conflict judge 的每个 pair 必须是 { a: string, b: string }');
    }
  }
  return { pairs: e.pairs };
}

export function judgeConflict({ response, question }: JudgeContext): JudgeCheck[] {
  const empty = emptyChecks(response);
  if (empty) return [...empty, ...transportChecks(response)];

  const exp = normalize(question.expect);
  const text = response.text;

  const checks: JudgeCheck[] = exp.pairs.map(({ a, b }) => {
    const both = text.includes(a) && text.includes(b);
    return {
      name: `conflict:${truncate(a, 12)}|${truncate(b, 12)}`,
      pass: !both,
      ...(both ? { detail: `同时出现互斥说法「${a}」与「${b}」` } : {}),
    };
  });

  return [...checks, ...transportChecks(response)];
}
