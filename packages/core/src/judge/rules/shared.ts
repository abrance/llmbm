/**
 * judge 规则共用的小工具：纯函数、零依赖、不联网。
 * 只放多个规则都要用的字符串/JSON/数值处理；判定语义留在各自的 <kind>.ts。
 */
import type { JudgeCheck, ModelResponse } from '../../types.js';

export function truncate(s: string, n = 120): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** 去掉 markdown 代码围栏，保留内部原文；无围栏原样返回（trim）。 */
export function stripFence(text: string): string {
  const t = text.trim();
  const m = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(t);
  return m && m[1] !== undefined ? m[1].trim() : t;
}

/** 是否整段被一个代码围栏包住。 */
export function isFenced(text: string): boolean {
  return /^```[a-zA-Z0-9_-]*[ \t]*\r?\n[\s\S]*\r?\n?```$/.test(text.trim());
}

/** 传输层错误 → 硬检查（契约要求：每条规则都要带这一条）。 */
export function transportChecks(response: ModelResponse): JudgeCheck[] {
  return response.error ? [{ name: 'transport', pass: false, hard: true, detail: response.error }] : [];
}

/** 空正文 → 单条 empty 硬失败；非空返回 undefined，由调用方继续判定。 */
export function emptyChecks(response: ModelResponse): JudgeCheck[] | undefined {
  if ((response.text ?? '').trim().length > 0) return undefined;
  return [{ name: 'empty', pass: false, hard: true, detail: '响应正文为空' }];
}

export function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 正文里所有数字（支持千分位、小数、指数），按出现顺序。 */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  const re = /-?\d[\d,]*(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** 深子集比较：expected 的每个键/元素都要在 actual 里对上；返回人类可读的差异列表。 */
export interface SubsetOptions {
  numericTolerance?: number;
}

export function subsetMismatches(actual: unknown, expected: unknown, path = '', opts: SubsetOptions = {}): string[] {
  const label = path || '$';
  if (expected === null || typeof expected !== 'object') {
    if (typeof expected === 'number' && typeof actual === 'number') {
      const tol = opts.numericTolerance ?? 0;
      if (Math.abs(actual - expected) <= tol) return [];
      return [`${label} 期望 ${expected}，实际 ${actual}`];
    }
    if (actual === expected) return [];
    return [`${label} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${label} 期望数组，实际 ${typeName(actual)}`];
    if (actual.length !== expected.length) return [`${label} 期望 ${expected.length} 项，实际 ${actual.length} 项`];
    return expected.flatMap((e, i) => subsetMismatches(actual[i], e, `${label}[${i}]`, opts));
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    return [`${label} 期望对象，实际 ${typeName(actual)}`];
  }
  const obj = actual as Record<string, unknown>;
  const out: string[] = [];
  for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
    const child = path ? `${path}.${k}` : k;
    if (!(k in obj)) {
      out.push(`${child} 缺失`);
      continue;
    }
    out.push(...subsetMismatches(obj[k], v, child, opts));
  }
  return out;
}

/** 从任意输出里切集合：JSON 数组 / 逗号 / 分号 / 换行 / 无序列表。 */
export function extractItems(text: string): string[] {
  const body = stripFence(text);
  const jsonArray = tryJsonArray(body);
  if (jsonArray) return jsonArray.map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)));
  return body
    .split(/\r?\n/)
    .flatMap((line) => line.split(/[,，;；、|]/))
    .map((s) =>
      s
        .replace(/^\s*(?:[-*•·]|\d+[.)、])\s*/, '')
        .trim()
        .replace(/^["'「『`]+|["'」』`]+$/g, '')
        .trim(),
    )
    .filter((s) => s.length > 0);
}

function tryJsonArray(text: string): unknown[] | undefined {
  const t = text.trim();
  if (!t.startsWith('[')) return undefined;
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
