/**
 * regex —— 正文匹配/不匹配某个正则。
 * expect: { pattern: string, flags?: string, mustMatch?: boolean }
 * mustMatch 缺省 true；false 时要求不匹配。pattern 非法 → 抛错（runJudge 兜成硬失败）。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, transportChecks, truncate } from './shared.js';

export interface RegexExpect {
  pattern: string;
  flags?: string;
  mustMatch?: boolean;
}

function normalize(expect: unknown): RegexExpect {
  if (!expect || typeof expect !== 'object') throw new Error('regex judge 需要 expect 为 { pattern: string }');
  const e = expect as Partial<RegexExpect>;
  if (typeof e.pattern !== 'string' || e.pattern.length === 0) {
    throw new Error('regex judge 的 expect.pattern 必须是非空字符串');
  }
  if (e.flags !== undefined && typeof e.flags !== 'string') throw new Error('regex judge 的 expect.flags 必须是字符串');
  return { pattern: e.pattern, ...(e.flags ? { flags: e.flags } : {}), ...(e.mustMatch !== undefined ? { mustMatch: e.mustMatch } : {}) };
}

export function judgeRegex({ response, question }: JudgeContext): JudgeCheck[] {
  const empty = emptyChecks(response);
  if (empty) return [...empty, ...transportChecks(response)];

  const exp = normalize(question.expect);
  let re: RegExp;
  try {
    re = new RegExp(exp.pattern, exp.flags ?? '');
  } catch (err) {
    throw new Error(`regex judge 的 pattern 非法: ${err instanceof Error ? err.message : String(err)}`);
  }

  const mustMatch = exp.mustMatch !== false;
  const m = re.exec(response.text);
  const pass = mustMatch ? m !== null : m === null;

  const checks: JudgeCheck[] = [
    {
      name: mustMatch ? 'regex.match' : 'regex.no-match',
      pass,
      ...(pass
        ? {}
        : {
            detail: mustMatch
              ? `未匹配 /${exp.pattern}/；正文：${truncate(response.text)}`
              : `不应匹配 /${exp.pattern}/，但命中「${truncate(String(m?.[0] ?? ''), 40)}」`,
          }),
    },
  ];
  return [...checks, ...transportChecks(response)];
}
