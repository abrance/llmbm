/**
 * conflict —— 同一回答里不能同时出现互斥的两个说法（自洽性检查）。
 * expect: { pairs: { a: string, b: string }[] }
 * 每对一条 check：两者都被「以肯定形式断言」时才失败。
 *
 * 共现 ≠ 同时断言（D1）：要求补充信息、引用题面、否定其一，都会让两个词同时出现
 * 却没有同时下结论。判据分三层：
 *   1. 引号内的词是「提及」，先从断言文本里去掉；
 *   2. 单句里两边都以肯定形式出现，且该句没有澄清/否定/引用标记 → 冲突；
 *   3. 整段都没有澄清/否定/引用标记时，才允许跨句判冲突。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, transportChecks, truncate } from './shared.js';

export interface ConflictExpect {
  pairs: Array<{ a: string; b: string }>;
}

/** 出现这些说法 → 是在引用、否定或要求澄清，不是同时下结论。 */
const NON_ASSERTION =
  /无法(判断|确定|给出|评估|结论)|不能|难以(判断|确定)|信息不足|信息不够|不确定|取决于|要看|视.{0,6}而定|不下结论|不要(同时)?(说|提)|不是说|并非|所谓|题面|引用|二选一|择一|只能选|请(补充|提供|把|告知)/;
const NEGATION = /[不没未无非别勿]/;
const QUOTED = /「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"|'[^'\n]*'|`[^`]*`|《[^》]*》/g;

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

function segments(text: string): string[] {
  return text
    .split(/[。！？!?；;\n，,、：:]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 「安全或危险」这类选言结构是二选一，不是同时断言；从待判文本里去掉。 */
function dropDisjunctions(text: string, a: string, b: string): string {
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sep = '(?:或|或者|还是|、|/|／|或是)';
  return text
    .replace(new RegExp(`${esc(a)}\\s*${sep}\\s*${esc(b)}`, 'g'), ' ')
    .replace(new RegExp(`${esc(b)}\\s*${sep}\\s*${esc(a)}`, 'g'), ' ');
}

/** 该词在文本里是否以肯定形式出现：命中处前 6 个字内没有否定词。 */
function assertedIn(text: string, term: string): boolean {
  let from = 0;
  for (;;) {
    const i = text.indexOf(term, from);
    if (i < 0) return false;
    if (!NEGATION.test(text.slice(Math.max(0, i - 6), i))) return true;
    from = i + term.length;
  }
}

export function judgeConflict({ response, question }: JudgeContext): JudgeCheck[] {
  const empty = emptyChecks(response);
  if (empty) return [...empty, ...transportChecks(response)];

  const exp = normalize(question.expect);
  const body = response.text.replace(QUOTED, ' ');
  // 整段没有任何澄清/否定/引用标记时，跨句的两次断言也算冲突；否则只认同一句。
  const strict = !NON_ASSERTION.test(body);

  const checks: JudgeCheck[] = exp.pairs.map(({ a, b }) => {
    const bare = dropDisjunctions(body, a, b);
    const sameSentence = strict
      ? undefined
      : segments(bare).find((s) => !NON_ASSERTION.test(s) && assertedIn(s, a) && assertedIn(s, b));
    const asserted = sameSentence ?? (strict && assertedIn(bare, a) && assertedIn(bare, b) ? bare : undefined);
    return {
      name: `conflict:${truncate(a, 12)}|${truncate(b, 12)}`,
      pass: asserted === undefined,
      ...(asserted === undefined
        ? {}
        : { detail: `同时断言互斥说法「${a}」与「${b}」${sameSentence ? `：${truncate(sameSentence, 40)}` : ''}` }),
    };
  });

  return [...checks, ...transportChecks(response)];
}
