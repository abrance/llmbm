/**
 * ordering —— 期望序列必须全部出现且下标递增（可选相邻无缝）。
 * expect: { values: string[], strict?: boolean }
 * strict:true 时要求后一项紧跟在前一项之后（中间只允许分隔符），用于「顺序即答案」的题。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, transportChecks } from './shared.js';

export interface OrderingExpect {
  values: string[];
  strict?: boolean;
}

function normalize(expect: unknown): OrderingExpect {
  if (!expect || typeof expect !== 'object') throw new Error('ordering judge 需要 expect 为 { values: string[] }');
  const e = expect as Partial<OrderingExpect>;
  if (!Array.isArray(e.values) || e.values.length === 0) throw new Error('ordering judge 的 expect.values 必须是非空字符串数组');
  if (e.values.some((v) => typeof v !== 'string' || v.length === 0)) {
    throw new Error('ordering judge 的 expect.values 必须全部是非空字符串');
  }
  return { values: e.values, ...(e.strict ? { strict: true } : {}) };
}

export function judgeOrdering({ response, question }: JudgeContext): JudgeCheck[] {
  const empty = emptyChecks(response);
  if (empty) return [...empty, ...transportChecks(response)];

  const exp = normalize(question.expect);
  const text = response.text;

  const positions: number[] = [];
  const missing: string[] = [];
  let cursor = 0;
  for (const value of exp.values) {
    const at = text.indexOf(value, cursor);
    if (at === -1) {
      missing.push(value);
      positions.push(-1);
      continue;
    }
    positions.push(at);
    cursor = at + value.length;
  }

  const checks: JudgeCheck[] = [];
  checks.push({
    name: 'ordering.present',
    pass: missing.length === 0,
    ...(missing.length === 0 ? {} : { detail: `缺项或顺序错乱导致找不到: ${missing.join('、')}` }),
  });

  const present = positions.filter((p) => p >= 0);
  const ascending = present.every((p, i) => i === 0 || p > (present[i - 1] as number));
  checks.push({
    name: 'ordering.ascending',
    pass: ascending,
    ...(ascending ? {} : { detail: `出现顺序不符，位置序列 ${positions.join(',')}` }),
  });

  if (exp.strict && missing.length === 0) {
    const gaps: string[] = [];
    for (let i = 1; i < positions.length; i += 1) {
      const prev = positions[i - 1] as number;
      const cur = positions[i] as number;
      const between = text.slice(prev + (exp.values[i - 1] as string).length, cur);
      // 只允许分隔符/空白：出现实词说明中间夹了别的答案。
      const noise = between.replace(/[\s,，、;；:：>→\-—/|()（）[\]【】.]/g, '');
      if (noise.length > 0) gaps.push(`「${exp.values[i - 1]}」与「${exp.values[i]}」之间夹了「${noise}」`);
    }
    checks.push({
      name: 'ordering.adjacent',
      pass: gaps.length === 0,
      ...(gaps.length === 0 ? {} : { detail: gaps.join('; ') }),
    });
  }

  return [...checks, ...transportChecks(response)];
}
