import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeJsonSchema } from './json-schema.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, expect: unknown, error?: string): JudgeContext => ({
  question: { id: 't', group: 'basic', prompt: 'p', judge: 'json-schema', expect } as Question,
  response: { text, ...(error ? { error } : {}) },
});

const USER_SCHEMA = {
  required: ['id', 'tags'],
  properties: {
    id: { type: 'number' },
    tags: { type: 'array', minItems: 2, items: { type: 'string' } },
  },
};

test('正例：类型与 minItems 都对', () => {
  const checks = judgeJsonSchema(ctx('{"id":7,"tags":["a","b"]}', USER_SCHEMA));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：enum 与数值范围', () => {
  const checks = judgeJsonSchema(ctx('{"level":"high","score":80}', {
    properties: { level: { type: 'string', enum: ['low', 'high'] }, score: { type: 'number', minimum: 0, maximum: 100 } },
  }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— id 是字符串', () => {
  const checks = judgeJsonSchema(ctx('{"id":"7","tags":["a","b"]}', USER_SCHEMA));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]?.detail), /id 期望 number，实际 string/);
});

test('反例：内容缺项 —— tags 只有 1 个元素', () => {
  const checks = judgeJsonSchema(ctx('{"id":7,"tags":["a"]}', USER_SCHEMA));
  assert.ok(checks.some((c) => !c.pass && /元素 1 个 < 2/.test(String(c.detail))));
});

test('反例：内容缺项 —— 必需字段缺失', () => {
  const checks = judgeJsonSchema(ctx('{"id":7}', USER_SCHEMA));
  const req = checks.find((c) => c.name === 'schema.required:tags');
  assert.ok(req);
  assert.equal(req?.pass, false);
});

test('反例：不是 JSON → 硬失败', () => {
  const checks = judgeJsonSchema(ctx('id 是 7，tags 是 a 和 b', USER_SCHEMA));
  assert.ok(checks.some((c) => c.name === 'schema.parse' && c.hard && !c.pass));
});

test('反例：空响应 → empty 硬失败', () => {
  const checks = judgeJsonSchema(ctx('', USER_SCHEMA));
  assert.ok(checks.some((c) => c.name === 'empty' && c.hard));
});

test('反例：expect 非法（未知 type / required 非数组）抛错', () => {
  assert.throws(() => judgeJsonSchema(ctx('{}', { type: 'integer' })), /type 非法/);
  assert.throws(() => judgeJsonSchema(ctx('{}', { required: 'a' })), /required/);
  assert.throws(() => judgeJsonSchema(ctx('{}', { properties: { a: 'string' } })), /properties.a/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeJsonSchema(ctx('{"id":7,"tags":["a","b"]}', USER_SCHEMA, 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});
