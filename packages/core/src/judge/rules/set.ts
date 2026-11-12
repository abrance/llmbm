/**
 * set —— 把输出切成集合再与期望集合比较（无序）。
 * expect: { values: string[], mode: 'exact'|'superset'|'subset', caseInsensitive?: boolean }
 * 缺项与多项各记一条 check：set.missing / set.extra，便于证据链定位。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, extractItems, transportChecks } from './shared.js';

export type SetMode = 'exact' | 'superset' | 'subset';

export interface SetExpect {
  values: string[];
  mode: SetMode;
  caseInsensitive?: boolean;
}

function normalize(expect: unknown): SetExpect {
  if (!expect || typeof expect !== 'object') {
    throw new Error('set judge 需要 expect 为 { values: string[], mode }');
  }
  const e = expect as Partial<SetExpect>;
  if (!Array.isArray(e.values) || e.values.length === 0) throw new Error('set judge 的 expect.values 必须是非空字符串数组');
  if (e.values.some((v) => typeof v !== 'string')) throw new Error('set judge 的 expect.values 必须全部是字符串');
  const mode = e.mode ?? 'exact';
  if (mode !== 'exact' && mode !== 'superset' && mode !== 'subset') {
    throw new Error(`set judge 的 mode 非法: ${String(mode)}（只支持 exact/superset/subset）`);
  }
  return { values: e.values, mode, ...(e.caseInsensitive ? { caseInsensitive: true } : {}) };
}

export function judgeSet({ response, question }: JudgeContext): JudgeCheck[] {
  const empty = emptyChecks(response);
  if (empty) return [...empty, ...transportChecks(response)];

  const exp = normalize(question.expect);
  const key = (s: string) => (exp.caseInsensitive ? s.toLowerCase() : s);
  const actual = new Set(extractItems(response.text).map(key));
  const expected = new Set(exp.values.map(key));

  const missing = exp.values.filter((v) => !actual.has(key(v)));
  const extra = [...actual].filter((v) => !expected.has(v));
  const checks: JudgeCheck[] = [];

  if (exp.mode === 'exact' || exp.mode === 'superset') {
    checks.push({
      name: 'set.missing',
      pass: missing.length === 0,
      ...(missing.length === 0 ? {} : { detail: `缺项: ${missing.join('、')}` }),
    });
  }
  if (exp.mode === 'exact' || exp.mode === 'subset') {
    checks.push({
      name: 'set.extra',
      pass: extra.length === 0,
      ...(extra.length === 0 ? {} : { detail: `多项: ${extra.join('、')}` }),
    });
  }

  return [...checks, ...transportChecks(response)];
}
