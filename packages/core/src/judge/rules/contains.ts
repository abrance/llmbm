/**
 * contains —— 正文里出现期望子串。
 * expect: { values: string[], all?: boolean, caseInsensitive?: boolean }
 * all 缺省 true（每个子串都要出现）；all:false 时任一出即可。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, transportChecks, truncate } from './shared.js';

export interface ContainsExpect {
  values: string[];
  all?: boolean;
  caseInsensitive?: boolean;
}

function normalize(expect: unknown): ContainsExpect {
  if (!expect || typeof expect !== 'object') throw new Error('contains judge 需要 expect 为 { values: string[] }');
  const e = expect as Partial<ContainsExpect>;
  if (!Array.isArray(e.values) || e.values.length === 0) {
    throw new Error('contains judge 的 expect.values 必须是非空字符串数组');
  }
  if (e.values.some((v) => typeof v !== 'string')) throw new Error('contains judge 的 expect.values 必须全部是字符串');
  return {
    values: e.values,
    ...(e.all !== undefined ? { all: e.all } : {}),
    ...(e.caseInsensitive ? { caseInsensitive: true } : {}),
  };
}

export function judgeContains({ response, question }: JudgeContext): JudgeCheck[] {
  const empty = emptyChecks(response);
  if (empty) return [...empty, ...transportChecks(response)];

  const exp = normalize(question.expect);
  const haystack = exp.caseInsensitive ? response.text.toLowerCase() : response.text;
  const needles = exp.caseInsensitive ? exp.values.map((v) => v.toLowerCase()) : exp.values;
  const all = exp.all !== false;

  const checks: JudgeCheck[] = all
    ? exp.values.map((value, i) => {
        const hit = haystack.includes(needles[i] as string);
        return {
          name: `contains:${value}`,
          pass: hit,
          ...(hit ? {} : { detail: `未出现「${truncate(value, 40)}」；正文：${truncate(response.text)}` }),
        };
      })
    : [
        {
          name: 'contains.any',
          pass: needles.some((n) => haystack.includes(n)),
          ...(needles.some((n) => haystack.includes(n))
            ? {}
            : { detail: `期望出现其一：${exp.values.join(' / ')}；正文：${truncate(response.text)}` }),
        },
      ];

  return [...checks, ...transportChecks(response)];
}
