/**
 * not-contains —— 正文里不得出现任何禁用子串（负向约束题）。
 * expect: { values: string[], caseInsensitive?: boolean }
 * 每个禁用词一条 check：出现即失败。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, transportChecks, truncate } from './shared.js';

export interface NotContainsExpect {
  values: string[];
  caseInsensitive?: boolean;
}

function normalize(expect: unknown): NotContainsExpect {
  if (!expect || typeof expect !== 'object') throw new Error('not-contains judge 需要 expect 为 { values: string[] }');
  const e = expect as Partial<NotContainsExpect>;
  if (!Array.isArray(e.values) || e.values.length === 0) {
    throw new Error('not-contains judge 的 expect.values 必须是非空字符串数组');
  }
  if (e.values.some((v) => typeof v !== 'string')) {
    throw new Error('not-contains judge 的 expect.values 必须全部是字符串');
  }
  return { values: e.values, ...(e.caseInsensitive ? { caseInsensitive: true } : {}) };
}

export function judgeNotContains({ response, question }: JudgeContext): JudgeCheck[] {
  const empty = emptyChecks(response);
  if (empty) return [...empty, ...transportChecks(response)];

  const exp = normalize(question.expect);
  const haystack = exp.caseInsensitive ? response.text.toLowerCase() : response.text;

  const checks: JudgeCheck[] = exp.values.map((value) => {
    const needle = exp.caseInsensitive ? value.toLowerCase() : value;
    const at = haystack.indexOf(needle);
    const pass = at === -1;
    return {
      name: `not-contains:${value}`,
      pass,
      ...(pass ? {} : { detail: `出现了禁用内容「${truncate(value, 40)}」，位置 ${at}` }),
    };
  });

  return [...checks, ...transportChecks(response)];
}
