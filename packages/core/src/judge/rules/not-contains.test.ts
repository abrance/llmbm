import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeNotContains } from './not-contains.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, expect: unknown, error?: string): JudgeContext => ({
  question: { id: 't', group: 'adversarial', prompt: 'p', judge: 'not-contains', expect } as Question,
  response: { text, ...(error ? { error } : {}) },
});

test('正例：禁用词未出现', () => {
  const checks = judgeNotContains(ctx('安全', { values: ['危险'] }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：caseInsensitive 下也不误报', () => {
  const checks = judgeNotContains(ctx('all good', { values: ['ERROR'], caseInsensitive: true }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— 简短合规却带了禁用词', () => {
  const checks = judgeNotContains(ctx('安全，但有危险', { values: ['危险'] }));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]?.detail), /危险/);
});

test('反例：内容缺项 —— 多个禁用词各记一条', () => {
  const checks = judgeNotContains(ctx('密码是 123456', { values: ['密码', '123456'] }));
  assert.equal(checks.filter((c) => !c.pass).length, 2);
});

test('反例：空响应 → empty 硬失败', () => {
  const checks = judgeNotContains(ctx('', { values: ['危险'] }));
  assert.ok(checks.some((c) => c.name === 'empty' && c.hard));
});

test('反例：expect 形状非法时抛错', () => {
  assert.throws(() => judgeNotContains(ctx('x', {})), /values/);
  assert.throws(() => judgeNotContains(ctx('x', null)), /expect/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeNotContains(ctx('安全', { values: ['危险'] }, 'ETIMEDOUT'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});
