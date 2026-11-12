import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeCite } from './cite.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, expect: unknown, error?: string): JudgeContext => ({
  question: { id: 't', group: 'ability', prompt: 'p', judge: 'cite', expect } as Question,
  response: { text, ...(error ? { error } : {}) },
});

test('正例：all 模式两个引用都在', () => {
  const checks = judgeCite(ctx('光合作用把光能转为化学能 [1]，并释放氧气 [2]。', { values: ['[1]', '[2]'], mode: 'all' }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：any 模式命中其一', () => {
  const checks = judgeCite(ctx('结论见 [1]。', { values: ['[1]', '[2]'], mode: 'any' }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— 引用编号错位', () => {
  const checks = judgeCite(ctx('光合作用 [3] 释放氧气 [4]。', { values: ['[1]', '[2]'], mode: 'all' }));
  assert.equal(checks.filter((c) => !c.pass).length, 2);
});

test('反例：内容缺项 —— 少一个引用', () => {
  const checks = judgeCite(ctx('光合作用 [1]。', { values: ['[1]', '[2]'], mode: 'all' }));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.name, 'cite:[2]');
});

test('反例：any 模式全都没命中', () => {
  const checks = judgeCite(ctx('没有任何引用。', { values: ['[1]', '[2]'], mode: 'any' }));
  assert.ok(checks.some((c) => c.name === 'cite.any' && !c.pass));
});

test('反例：空响应 → empty 硬失败', () => {
  const checks = judgeCite(ctx('   ', { values: ['[1]'] }));
  assert.ok(checks.some((c) => c.name === 'empty' && c.hard));
});

test('反例：expect 非法抛错', () => {
  assert.throws(() => judgeCite(ctx('x', { values: [] })), /values/);
  assert.throws(() => judgeCite(ctx('x', { values: ['[1]'], mode: 'some' })), /mode/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeCite(ctx('[1]', { values: ['[1]'] }, 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});
