/**
 * long-output —— 长输出题的「够长 + 不退化 + 含指定要点」检查。
 * expect: { minChars: number, mustInclude?: string[], maxRepeatedLineRatio?: number }
 * 有效长度 = 去掉所有空白后的字符数；重复行比例 = 1 - 去重行数/总行数（退化/复读信号）。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, transportChecks } from './shared.js';

export interface LongOutputExpect {
  minChars: number;
  mustInclude?: string[];
  maxRepeatedLineRatio?: number;
}

function normalize(expect: unknown): LongOutputExpect {
  if (!expect || typeof expect !== 'object') throw new Error('long-output judge 需要 expect 为 { minChars }');
  const e = expect as Partial<LongOutputExpect>;
  if (typeof e.minChars !== 'number' || e.minChars <= 0) {
    throw new Error('long-output judge 的 expect.minChars 必须是正数');
  }
  if (e.mustInclude !== undefined && (!Array.isArray(e.mustInclude) || e.mustInclude.some((s) => typeof s !== 'string'))) {
    throw new Error('long-output judge 的 expect.mustInclude 必须是字符串数组');
  }
  if (e.maxRepeatedLineRatio !== undefined && (typeof e.maxRepeatedLineRatio !== 'number' || e.maxRepeatedLineRatio < 0 || e.maxRepeatedLineRatio > 1)) {
    throw new Error('long-output judge 的 expect.maxRepeatedLineRatio 必须在 0..1');
  }
  return {
    minChars: e.minChars,
    ...(e.mustInclude ? { mustInclude: e.mustInclude } : {}),
    ...(e.maxRepeatedLineRatio !== undefined ? { maxRepeatedLineRatio: e.maxRepeatedLineRatio } : {}),
  };
}

/** 1 - 去重行数/总行数；空文本返回 0。 */
export function repeatedLineRatio(text: string): number {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return 0;
  return 1 - new Set(lines).size / lines.length;
}

export function judgeLongOutput({ response, question }: JudgeContext): JudgeCheck[] {
  const empty = emptyChecks(response);
  if (empty) return [...empty, ...transportChecks(response)];

  const exp = normalize(question.expect);
  const text = response.text;
  const effective = text.replace(/\s+/g, '').length;
  const checks: JudgeCheck[] = [];

  checks.push({
    name: 'long.length',
    pass: effective >= exp.minChars,
    ...(effective >= exp.minChars ? { detail: `有效长度 ${effective}` } : { detail: `有效长度 ${effective} < 要求 ${exp.minChars}` }),
  });

  const ratio = repeatedLineRatio(text);
  const maxRatio = exp.maxRepeatedLineRatio ?? 0.5;
  checks.push({
    name: 'long.repetition',
    pass: ratio <= maxRatio,
    ...(ratio <= maxRatio ? {} : { detail: `重复行比例 ${ratio.toFixed(3)} > ${maxRatio}（退化/复读信号）` }),
  });

  for (const needle of exp.mustInclude ?? []) {
    const hit = text.includes(needle);
    checks.push({
      name: `long.include:${needle}`,
      pass: hit,
      ...(hit ? {} : { detail: `未包含要点「${needle}」` }),
    });
  }

  return [...checks, ...transportChecks(response)];
}
