import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeExact } from './exact.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, expect: unknown, error?: string): JudgeContext => ({
  question: { id: 't', group: 'basic', prompt: 'p', judge: 'exact', expect } as Question,
  response: { text, ...(error ? { error } : {}) },
});

test('正例：完全相等', () => {
  const checks = judgeExact(ctx('42', '42'));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：去首尾空白 + 尾句号 + 忽略大小写', () => {
  const checks = judgeExact(ctx('  Hello.\n', { value: 'hello', caseInsensitive: true, allowTrailingPeriod: true }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：内容不等 → 失败且给出期望/实际', () => {
  const checks = judgeExact(ctx('43', '42'));
  const fail = checks.find((c) => !c.pass);
  assert.ok(fail);
  assert.match(String(fail?.detail), /期望 "42"，实际 "43"/);
});

test('反例：expect 形状非法时抛错（由 runJudge 兜成硬失败）', () => {
  assert.throws(() => judgeExact(ctx('x', undefined)), /expect/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeExact(ctx('42', '42', 'ECONNRESET'));
  assert.ok(checks.some((c) => c.hard && !c.pass));
});
