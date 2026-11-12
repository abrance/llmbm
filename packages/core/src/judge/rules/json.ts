/**
 * json —— 输出是 JSON 对象，且必需键存在、期望键值深相等。
 * expect: { required?: string[], equals?: unknown, allowExtra?: boolean }
 * 去 markdown 围栏后解析；allowExtra 缺省 true（只做子集比较）。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, stripFence, subsetMismatches, transportChecks, truncate, typeName } from './shared.js';

export interface JsonExpect {
  required?: string[];
  equals?: unknown;
  allowExtra?: boolean;
}

function normalize(expect: unknown): JsonExpect {
  if (expect === undefined || expect === null) return {};
  if (typeof expect !== 'object' || Array.isArray(expect)) {
    throw new Error('json judge 需要 expect 为 { required?, equals?, allowExtra? } 对象');
  }
  const e = expect as Partial<JsonExpect>;
  if (e.required !== undefined) {
    if (!Array.isArray(e.required) || e.required.some((k) => typeof k !== 'string')) {
      throw new Error('json judge 的 expect.required 必须是字符串数组');
    }
  }
  return {
    ...(e.required ? { required: e.required } : {}),
    ...('equals' in e ? { equals: e.equals } : {}),
    ...(e.allowExtra !== undefined ? { allowExtra: e.allowExtra } : {}),
  };
}

export function judgeJson({ response, question }: JudgeContext): JudgeCheck[] {
  const empty = emptyChecks(response);
  if (empty) return [...empty, ...transportChecks(response)];

  const exp = normalize(question.expect);
  const body = stripFence(response.text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return [
      {
        name: 'json.parse',
        pass: false,
        hard: true,
        detail: `不是合法 JSON: ${err instanceof Error ? err.message : String(err)}；正文：${truncate(body)}`,
      },
      ...transportChecks(response),
    ];
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [
      { name: 'json.parse', pass: false, hard: true, detail: `期望 JSON 对象，实际 ${typeName(parsed)}` },
      ...transportChecks(response),
    ];
  }

  const obj = parsed as Record<string, unknown>;
  const checks: JudgeCheck[] = [{ name: 'json.parse', pass: true }];

  for (const key of exp.required ?? []) {
    const has = Object.prototype.hasOwnProperty.call(obj, key);
    checks.push({
      name: `json.required:${key}`,
      pass: has,
      ...(has ? {} : { detail: `缺少字段 ${key}；实际字段: ${Object.keys(obj).join(', ') || '（无）'}` }),
    });
  }

  if ('equals' in exp && exp.equals !== undefined) {
    const diff = subsetMismatches(obj, exp.equals);
    checks.push({
      name: 'json.equals',
      pass: diff.length === 0,
      ...(diff.length === 0 ? {} : { detail: diff.join('; ') }),
    });
  }

  if (exp.allowExtra === false && 'equals' in exp && exp.equals && typeof exp.equals === 'object') {
    const expectedKeys = new Set(Object.keys(exp.equals as Record<string, unknown>));
    const extra = Object.keys(obj).filter((k) => !expectedKeys.has(k));
    checks.push({
      name: 'json.no-extra',
      pass: extra.length === 0,
      ...(extra.length === 0 ? {} : { detail: `多余字段: ${extra.join(', ')}` }),
    });
  }

  return [...checks, ...transportChecks(response)];
}
