import { test as t } from 'node:test';
import assert from 'node:assert/strict';
import { judgeFraction } from './fraction.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, expect: unknown, error?: string): JudgeContext => ({
  question: { id: 't', group: 'basic', prompt: 'p', judge: 'fraction', expect } as Question,
  response: { text, ...(error ? { error } : {}) },
});

t('正例：百分数写法', () => {
  const checks = judgeFraction(ctx('75%', { numerator: 3, denominator: 4 }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

t('正例：小数写法', () => {
  const checks = judgeFraction(ctx('0.75', { numerator: 3, denominator: 4 }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

t('正例：分数写法', () => {
  const checks = judgeFraction(ctx('3/4', { numerator: 3, denominator: 4 }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

t('反例：格式对内容错 —— 百分数算错', () => {
  const checks = judgeFraction(ctx('34%', { numerator: 3, denominator: 4 }));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]?.detail), /期望 3\/4/);
});

t('反例：内容缺项 —— 正文无数字', () => {
  const checks = judgeFraction(ctx('四分之三', { numerator: 3, denominator: 4 }));
  assert.ok(checks.some((c) => c.name === 'fraction.found' && c.hard));
});

t('反例：空响应 → empty 硬失败', () => {
  const checks = judgeFraction(ctx('   ', { numerator: 3, denominator: 4 }));
  assert.ok(checks.some((c) => c.name === 'empty' && c.hard));
});

t('反例：expect 非法抛错', () => {
  assert.throws(() => judgeFraction(ctx('1', { numerator: 1 })), /numerator/);
  assert.throws(() => judgeFraction(ctx('1', { numerator: 1, denominator: 0 })), /denominator/);
});

t('反例：传输错误附加硬检查', () => {
  const checks = judgeFraction(ctx('75%', { numerator: 3, denominator: 4 }, 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});
