import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeRegex } from './regex.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, expect: unknown, error?: string): JudgeContext => ({
  question: { id: 't', group: 'basic', prompt: 'p', judge: 'regex', expect } as Question,
  response: { text, ...(error ? { error } : {}) },
});

test('正例：手机号匹配', () => {
  const checks = judgeRegex(ctx('13812345678', { pattern: '1[3-9]\\d{9}' }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：mustMatch:false 且确实不匹配', () => {
  const checks = judgeRegex(ctx('安全回答', { pattern: '危险', mustMatch: false }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：flags 生效（多行 ^）', () => {
  const checks = judgeRegex(ctx('第一行\n42', { pattern: '^42$', flags: 'm' }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— 11 位但不是手机号', () => {
  const checks = judgeRegex(ctx('12345678901', { pattern: '1[3-9]\\d{9}' }));
  assert.equal(checks.filter((c) => !c.pass).length, 1);
});

test('反例：内容缺项 —— 正文没有该模式', () => {
  const checks = judgeRegex(ctx('我不知道', { pattern: '\\d{3}' }));
  assert.equal(checks.filter((c) => !c.pass).length, 1);
});

test('反例：空响应 → empty 硬失败', () => {
  const checks = judgeRegex(ctx('  \n ', { pattern: 'a' }));
  assert.ok(checks.some((c) => c.name === 'empty' && c.hard));
});

test('反例：expect 非法（缺 pattern / pattern 非法）抛错', () => {
  assert.throws(() => judgeRegex(ctx('x', {})), /pattern/);
  assert.throws(() => judgeRegex(ctx('x', { pattern: '(' })), /pattern 非法/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeRegex(ctx('13812345678', { pattern: '1[3-9]\\d{9}' }, 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});
