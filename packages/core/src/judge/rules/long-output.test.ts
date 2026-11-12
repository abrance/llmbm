import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeLongOutput, repeatedLineRatio } from './long-output.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, expect: unknown, error?: string): JudgeContext => ({
  question: { id: 't', group: 'ability', prompt: 'p', judge: 'long-output', expect } as Question,
  response: { text, ...(error ? { error } : {}) },
});

const paragraph = (n: number) => Array.from({ length: n }, (_, i) => `第 ${i} 段：说明中转站需要可信度检测的理由。`).join('\n');

test('正例：够长且不重复', () => {
  const checks = judgeLongOutput(ctx(paragraph(20), { minChars: 300, maxRepeatedLineRatio: 0.5 }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：mustInclude 要点齐全', () => {
  const text = `${paragraph(20)}\n结论：检测能发现偷换模型。`;
  const checks = judgeLongOutput(ctx(text, { minChars: 300, mustInclude: ['偷换模型'] }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— 复读同一句凑长度', () => {
  const text = 'API 中转站需要可信度检测。\n'.repeat(40);
  const checks = judgeLongOutput(ctx(text, { minChars: 300, maxRepeatedLineRatio: 0.5 }));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.name, 'long.repetition');
});

test('反例：内容缺项 —— 长度不够', () => {
  const checks = judgeLongOutput(ctx('太短了。', { minChars: 300 }));
  assert.ok(checks.some((c) => c.name === 'long.length' && !c.pass));
});

test('反例：内容缺项 —— 缺 mustInclude', () => {
  const checks = judgeLongOutput(ctx(paragraph(20), { minChars: 300, mustInclude: ['偷换模型'] }));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.name, 'long.include:偷换模型');
});

test('反例：空响应 → empty 硬失败', () => {
  const checks = judgeLongOutput(ctx('  \n ', { minChars: 300 }));
  assert.ok(checks.some((c) => c.name === 'empty' && c.hard));
});

test('反例：expect 非法抛错', () => {
  assert.throws(() => judgeLongOutput(ctx('x', { minChars: 0 })), /minChars/);
  assert.throws(() => judgeLongOutput(ctx('x', { minChars: 1, maxRepeatedLineRatio: 2 })), /maxRepeatedLineRatio/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeLongOutput(ctx(paragraph(20), { minChars: 300 }, 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});

test('repeatedLineRatio：全不重复为 0', () => {
  assert.equal(repeatedLineRatio('a\nb\nc'), 0);
  assert.equal(repeatedLineRatio('a\na\na\na'), 0.75);
});
