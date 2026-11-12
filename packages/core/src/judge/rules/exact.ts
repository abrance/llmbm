/**
 * exact —— 期望值与响应正文完全相等（去首尾空白、可选忽略大小写）。
 * expect: { value: string, trim?: boolean, caseInsensitive?: boolean, allowTrailingPeriod?: boolean }
 * 也接受裸 string / number，视为 { value }。
 * 参考实现：新增 judge 照这个形状写（一个纯函数 + 一个 registerJudge + 正反例单测）。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';

export interface ExactExpect {
  value: string | number;
  trim?: boolean;
  caseInsensitive?: boolean;
  allowTrailingPeriod?: boolean;
}

function normalize(expect: unknown): ExactExpect {
  if (typeof expect === 'string' || typeof expect === 'number') return { value: expect };
  if (expect && typeof expect === 'object' && 'value' in expect) return expect as ExactExpect;
  throw new Error('exact judge 需要 expect 为字符串/数字或 { value }');
}

export function judgeExact({ response, question }: JudgeContext): JudgeCheck[] {
  const exp = normalize(question.expect);
  const trim = exp.trim !== false;
  const expected = String(exp.value);
  let actual = response.text ?? '';
  let want = expected;
  if (trim) {
    actual = actual.trim();
    want = want.trim();
  }
  if (exp.allowTrailingPeriod) {
    actual = actual.replace(/[。.]$/, '');
    want = want.replace(/[。.]$/, '');
  }
  if (exp.caseInsensitive) {
    actual = actual.toLowerCase();
    want = want.toLowerCase();
  }

  const checks: JudgeCheck[] = [
    {
      name: 'exact.match',
      pass: actual === want,
      detail: actual === want ? undefined : `期望 "${truncate(want)}"，实际 "${truncate(actual)}"`,
    },
  ];
  if (response.error) checks.push({ name: 'transport', pass: false, hard: true, detail: response.error });
  return checks;
}

function truncate(s: string, n = 120): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
