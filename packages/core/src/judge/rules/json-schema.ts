/**
 * json-schema —— 零依赖的 JSON Schema 子集校验。
 *
 * 支持的关键字（其余一律忽略，不报错）：
 *   required、properties、type、enum、minItems、items、minLength、maxLength、minimum、maximum
 * 明确不支持：$ref、allOf/anyOf/oneOf/not、patternProperties、dependencies、format 等。
 * 不支持的关键字被静默忽略是有意的：题库只需表达「形状对不对」，不做完整校验器。
 *
 * expect: { required?, properties?, minItems?, type? }
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, stripFence, transportChecks, truncate, typeName } from './shared.js';

export type SchemaType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null';

export interface SchemaNode {
  type?: SchemaType | SchemaType[];
  enum?: unknown[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  required?: string[];
}

export type JsonSchemaExpect = SchemaNode;

const KNOWN_TYPES: readonly string[] = ['string', 'number', 'boolean', 'array', 'object', 'null'];

function assertSchema(node: unknown, path: string): SchemaNode {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`json-schema judge 的 ${path} 必须是对象`);
  }
  const n = node as SchemaNode;
  if (n.type !== undefined) {
    const types = Array.isArray(n.type) ? n.type : [n.type];
    for (const t of types) {
      if (typeof t !== 'string' || !KNOWN_TYPES.includes(t)) {
        throw new Error(`json-schema judge 的 ${path}.type 非法: ${String(t)}`);
      }
    }
  }
  if (n.required !== undefined && (!Array.isArray(n.required) || n.required.some((k) => typeof k !== 'string'))) {
    throw new Error(`json-schema judge 的 ${path}.required 必须是字符串数组`);
  }
  if (n.enum !== undefined && !Array.isArray(n.enum)) throw new Error(`json-schema judge 的 ${path}.enum 必须是数组`);
  if (n.items !== undefined) assertSchema(n.items, `${path}.items`);
  if (n.properties !== undefined) {
    if (n.properties === null || typeof n.properties !== 'object' || Array.isArray(n.properties)) {
      throw new Error(`json-schema judge 的 ${path}.properties 必须是对象`);
    }
    for (const [k, v] of Object.entries(n.properties)) assertSchema(v, `${path}.properties.${k}`);
  }
  return n;
}

function normalize(expect: unknown): JsonSchemaExpect {
  if (expect === undefined || expect === null) return {};
  return assertSchema(expect, 'expect');
}

function typeOk(value: unknown, t: SchemaType): boolean {
  switch (t) {
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

/** 校验一个节点，返回失败描述（空数组 = 通过）。 */
function validate(value: unknown, schema: SchemaNode, path: string, out: string[]): void {
  const label = path || '$';

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(value, t))) {
      out.push(`${label} 期望 ${types.join('|')}，实际 ${typeName(value)}`);
      return;
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    out.push(`${label} 不在枚举 ${JSON.stringify(schema.enum)} 内，实际 ${JSON.stringify(value)}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      out.push(`${label} 长度 ${value.length} < ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      out.push(`${label} 长度 ${value.length} > ${schema.maxLength}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${label} ${value} < 最小值 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${label} ${value} > 最大值 ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      out.push(`${label} 元素 ${value.length} 个 < ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      out.push(`${label} 元素 ${value.length} 个 > ${schema.maxItems}`);
    }
    if (schema.items) value.forEach((v, i) => validate(v, schema.items as SchemaNode, `${label}[${i}]`, out));
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) {
        out.push(`${label}.${key} 缺失`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) validate(obj[key], sub, `${label}.${key}`, out);
    }
  }
}

export function judgeJsonSchema({ response, question }: JudgeContext): JudgeCheck[] {
  const empty = emptyChecks(response);
  if (empty) return [...empty, ...transportChecks(response)];

  const schema = normalize(question.expect);
  const body = stripFence(response.text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return [
      {
        name: 'schema.parse',
        pass: false,
        hard: true,
        detail: `不是合法 JSON: ${err instanceof Error ? err.message : String(err)}；正文：${truncate(body)}`,
      },
      ...transportChecks(response),
    ];
  }

  const problems: string[] = [];
  validate(parsed, schema, '', problems);

  const checks: JudgeCheck[] = [
    {
      name: 'schema.parse',
      pass: true,
    },
    {
      name: 'schema.shape',
      pass: problems.length === 0,
      ...(problems.length === 0 ? {} : { detail: problems.join('; ') }),
    },
  ];

  // 缺项单独成条，证据链上能直接看到「缺哪个字段」。
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      const has = Object.prototype.hasOwnProperty.call(obj, key);
      checks.push({
        name: `schema.required:${key}`,
        pass: has,
        ...(has ? {} : { detail: `缺少字段 ${key}` }),
      });
    }
  }

  return [...checks, ...transportChecks(response)];
}
