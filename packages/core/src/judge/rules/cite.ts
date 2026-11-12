/**
 * cite —— 正文里出现期望的引用标记/链接。
 * expect: { values: string[], mode?: 'all'|'any' }
 * mode 缺省 all。命中形式不限：`[1]`、`^1^`、`[1]: https://…`、裸 URL 都算（题库里写的是字面量）。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, transportChecks } from './shared.js';

export interface CiteExpect {
  values: string[];
  mode?: 'all' | 'any';
}

function normalize(expect: unknown): CiteExpect {
  if (!expect || typeof expect !== 'object') throw new Error('cite judge 需要 expect 为 { values: string[] }');
  const e = expect as Partial<CiteExpect>;
  if (!Array.isArray(e.values) || e.values.length === 0) throw new Error('cite judge 的 expect.values 必须是非空字符串数组');
  if (e.values.some((v) => typeof v !== 'string' || v.length === 0)) {
    throw new Error('cite judge 的 expect.values 必须全部是非空字符串');
  }
  const mode = e.mode ?? 'all';
  if (mode !== 'all' && mode !== 'any') throw new Error(`cite judge 的 expect.mode 非法: ${String(mode)}`);
  return { values: e.values, mode };
}

export function judgeCite({ response, question }: JudgeContext): JudgeCheck[] {
  const empty = emptyChecks(response);
  if (empty) return [...empty, ...transportChecks(response)];

  const exp = normalize(question.expect);
  const text = response.text;

  if (exp.mode === 'any') {
    const hits = exp.values.filter((v) => text.includes(v));
    return [
      {
        name: 'cite.any',
        pass: hits.length > 0,
        ...(hits.length > 0 ? { detail: `命中引用: ${hits.join(', ')}` } : { detail: `未出现任何引用标记: ${exp.values.join(', ')}` }),
      },
      ...transportChecks(response),
    ];
  }

  const checks: JudgeCheck[] = exp.values.map((value) => {
    const hit = text.includes(value);
    return {
      name: `cite:${value}`,
      pass: hit,
      ...(hit ? {} : { detail: `缺少引用标记「${value}」` }),
    };
  });

  return [...checks, ...transportChecks(response)];
}
