import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeOrdering } from './ordering.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, expect: unknown, error?: string): JudgeContext => ({
  question: { id: 't', group: 'ability', prompt: 'p', judge: 'ordering', expect } as Question,
  response: { text, ...(error ? { error } : {}) },
});

const ASC = { values: ['1', '3', '7', '9'] };

test('正例：逗号分隔升序', () => {
  const checks = judgeOrdering(ctx('1, 3, 7, 9', ASC));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：strict 下相邻无缝', () => {
  const checks = judgeOrdering(ctx('需求→设计→测试→部署', { values: ['需求', '设计', '测试', '部署'], strict: true }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— 顺序颠倒', () => {
  const checks = judgeOrdering(ctx('9, 7, 3, 1', ASC));
  const failed = checks.filter((c) => !c.pass);
  assert.ok(failed.length >= 1);
  assert.match(failed.map((c) => `${c.name}:${c.detail ?? ''}`).join(' '), /ordering\.(present|ascending)/);
});

test('反例：内容缺项 —— 少一个数字', () => {
  const checks = judgeOrdering(ctx('1, 3, 9', ASC));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]?.detail), /7/);
});

test('反例：strict 中间夹了额外内容', () => {
  const checks = judgeOrdering(ctx('需求，然后是设计，接着测试，最后部署', { values: ['需求', '设计', '测试', '部署'], strict: true }));
  assert.ok(checks.some((c) => c.name === 'ordering.adjacent' && !c.pass));
});

test('反例：空响应 → empty 硬失败', () => {
  const checks = judgeOrdering(ctx('   ', ASC));
  assert.ok(checks.some((c) => c.name === 'empty' && c.hard));
});

test('反例：expect 非法抛错', () => {
  assert.throws(() => judgeOrdering(ctx('x', { values: [] })), /values/);
  assert.throws(() => judgeOrdering(ctx('x', { values: [''] })), /非空字符串/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeOrdering(ctx('1,3,7,9', ASC, 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});
