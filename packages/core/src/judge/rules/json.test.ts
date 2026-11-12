import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeJson } from './json.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, expect: unknown, error?: string): JudgeContext => ({
  question: { id: 't', group: 'basic', prompt: 'p', judge: 'json', expect } as Question,
  response: { text, ...(error ? { error } : {}) },
});

test('正例：必需键与值都对', () => {
  const checks = judgeJson(ctx('{"name":"Ada","age":36}', { required: ['name', 'age'], equals: { name: 'Ada', age: 36 } }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：剥掉 markdown 围栏后解析', () => {
  const checks = judgeJson(ctx('```json\n{"name":"Ada","age":36}\n```', { required: ['name'] }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：allowExtra 缺省允许额外字段', () => {
  const checks = judgeJson(ctx('{"retries":3,"backoff":"exponential","jitter":true,"extra":1}', { required: ['retries'], equals: { retries: 3 } }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— 合法 JSON 但值不对', () => {
  const checks = judgeJson(ctx('{"name":"Bob","age":36}', { equals: { name: 'Ada' } }));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]?.detail), /期望 "Ada"，实际 "Bob"/);
});

test('反例：内容缺项 —— 少字段', () => {
  const checks = judgeJson(ctx('{"name":"Ada"}', { required: ['name', 'age'] }));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.name, 'json.required:age');
});

test('反例：不是 JSON → 硬失败', () => {
  const checks = judgeJson(ctx('name 是 Ada，age 是 36', { required: ['name'] }));
  assert.ok(checks.some((c) => c.name === 'json.parse' && c.hard && !c.pass));
});

test('反例：JSON 是数组而非对象 → 硬失败', () => {
  const checks = judgeJson(ctx('[1,2]', { required: ['a'] }));
  assert.ok(checks.some((c) => c.name === 'json.parse' && c.hard && /对象/.test(String(c.detail))));
});

test('反例：allowExtra:false 时多余字段失败', () => {
  const checks = judgeJson(ctx('{"a":1,"b":2}', { equals: { a: 1 }, allowExtra: false }));
  assert.ok(checks.some((c) => c.name === 'json.no-extra' && !c.pass));
});

test('反例：空响应 → empty 硬失败', () => {
  const checks = judgeJson(ctx('   ', { required: ['a'] }));
  assert.ok(checks.some((c) => c.name === 'empty' && c.hard));
});

test('反例：expect 非法抛错', () => {
  assert.throws(() => judgeJson(ctx('{}', 'x')), /expect/);
  assert.throws(() => judgeJson(ctx('{}', { required: 'a' })), /required/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeJson(ctx('{"a":1}', { required: ['a'] }, 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});
