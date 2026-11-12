import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeNumber } from './number.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, expect: unknown, error?: string): JudgeContext => ({
  question: { id: 't', group: 'basic', prompt: 'p', judge: 'number', expect } as Question,
  response: { text, ...(error ? { error } : {}) },
});

test('正例：正文就是数字', () => {
  const checks = judgeNumber(ctx('391', { value: 391 }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：取最后一个数（前面有干扰数字）', () => {
  const checks = judgeNumber(ctx('17 × 23 = 391', { value: 391 }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：带千分位与小数', () => {
  const checks = judgeNumber(ctx('约 1,234.5 元', { value: 1234.5 }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：relative 容差', () => {
  const checks = judgeNumber(ctx('119.95', { value: 120, tolerance: 0.001, relative: true }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— 数字算错', () => {
  const checks = judgeNumber(ctx('17 × 23 = 401', { value: 391 }));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]?.detail), /期望 391/);
});

test('反例：内容缺项 —— 正文无数字', () => {
  const checks = judgeNumber(ctx('三百九十一', { value: 391 }));
  assert.ok(checks.some((c) => c.name === 'number.found' && c.hard && !c.pass));
});

test('反例：空响应 → empty 硬失败', () => {
  const checks = judgeNumber(ctx(' ', { value: 1 }));
  assert.ok(checks.some((c) => c.name === 'empty' && c.hard));
});

test('反例：expect 非法抛错', () => {
  assert.throws(() => judgeNumber(ctx('1', { value: 'x' })), /value/);
  assert.throws(() => judgeNumber(ctx('1', { value: 1, tolerance: -1 })), /tolerance/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeNumber(ctx('391', { value: 391 }, 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});
