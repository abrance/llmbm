import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeConflict } from './conflict.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, expect: unknown, error?: string): JudgeContext => ({
  question: { id: 't', group: 'adversarial', prompt: 'p', judge: 'conflict', expect } as Question,
  response: { text, ...(error ? { error } : {}) },
});

const PAIR = { pairs: [{ a: '安全', b: '危险' }] };

test('正例：只给一个结论', () => {
  const checks = judgeConflict(ctx('这个方案是安全的。', PAIR));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：多对互斥，各自独立', () => {
  const checks = judgeConflict(ctx('可以上线。', { pairs: [{ a: '可以上线', b: '不能上线' }, { a: '安全', b: '危险' }] }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— 同时说安全和危险', () => {
  const checks = judgeConflict(ctx('它既安全又危险。', PAIR));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]?.detail), /互斥/);
});

test('反例：内容缺项 —— 多对里有一对冲突', () => {
  const checks = judgeConflict(ctx('既安全又危险，但可以上线。', { pairs: [{ a: '可以上线', b: '不能上线' }, { a: '安全', b: '危险' }] }));
  assert.equal(checks.filter((c) => !c.pass).length, 1);
});

test('反例：空响应 → empty 硬失败', () => {
  const checks = judgeConflict(ctx('', PAIR));
  assert.ok(checks.some((c) => c.name === 'empty' && c.hard));
});

test('反例：expect 非法抛错', () => {
  assert.throws(() => judgeConflict(ctx('x', { pairs: [] })), /pairs/);
  assert.throws(() => judgeConflict(ctx('x', { pairs: [{ a: 'x' }] })), /pair/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeConflict(ctx('安全', PAIR, 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});
