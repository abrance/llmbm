import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeContains } from './contains.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, expect: unknown, error?: string): JudgeContext => ({
  question: { id: 't', group: 'basic', prompt: 'p', judge: 'contains', expect } as Question,
  response: { text, ...(error ? { error } : {}) },
});

test('正例：all 缺省，全部子串都出现', () => {
  const checks = judgeContains(ctx('在标准大气压下，水在 100 摄氏度沸腾。', { values: ['100', '摄氏度'] }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：all:false 时命中其一即过', () => {
  const checks = judgeContains(ctx('我们用 Rust 实现。', { values: ['Python', 'Rust'], all: false }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：caseInsensitive', () => {
  const checks = judgeContains(ctx('hello WORLD', { values: ['world'], caseInsensitive: true }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— 句子通顺但缺关键子串', () => {
  const checks = judgeContains(ctx('水会沸腾。', { values: ['100', '摄氏度'] }));
  assert.equal(checks.filter((c) => !c.pass).length, 2);
});

test('反例：内容缺项 —— 只缺一个子串', () => {
  const checks = judgeContains(ctx('水在 100 度沸腾。', { values: ['100', '摄氏度'] }));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]?.detail), /摄氏度/);
});

test('反例：空响应 → empty 硬失败', () => {
  const checks = judgeContains(ctx('   ', { values: ['a'] }));
  assert.ok(checks.some((c) => c.name === 'empty' && c.hard && !c.pass));
});

test('反例：expect 形状非法时抛错', () => {
  assert.throws(() => judgeContains(ctx('x', { values: [] })), /values/);
  assert.throws(() => judgeContains(ctx('x', { values: [1] })), /字符串/);
  assert.throws(() => judgeContains(ctx('x', undefined)), /expect/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeContains(ctx('100 摄氏度', { values: ['100'] }, 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard && !c.pass));
});
