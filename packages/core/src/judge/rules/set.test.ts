import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeSet } from './set.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, expect: unknown, error?: string): JudgeContext => ({
  question: { id: 't', group: 'ability', prompt: 'p', judge: 'set', expect } as Question,
  response: { text, ...(error ? { error } : {}) },
});

const FIVE = ['关羽', '张飞', '赵云', '马超', '黄忠'];

test('正例：exact 模式逗号分隔，顺序无关', () => {
  const checks = judgeSet(ctx('黄忠，关羽，马超，张飞，赵云', { values: FIVE, mode: 'exact' }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：JSON 数组输入', () => {
  const checks = judgeSet(ctx('["GET","PUT","DELETE"]', { values: ['GET', 'PUT', 'DELETE'], mode: 'exact' }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：无序列表 + superset 允许多项', () => {
  const checks = judgeSet(ctx('- GET\n- PUT\n- DELETE\n- PATCH', { values: ['GET', 'PUT', 'DELETE'], mode: 'superset' }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：subset 只要求输出是期望的子集', () => {
  const checks = judgeSet(ctx('关羽，张飞', { values: FIVE, mode: 'subset' }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— 列表整齐但名字错', () => {
  const checks = judgeSet(ctx('关羽，张飞，赵云，马超，魏延', { values: FIVE, mode: 'exact' }));
  const failed = checks.filter((c) => !c.pass);
  assert.ok(failed.some((c) => c.name === 'set.missing' && /黄忠/.test(String(c.detail))));
  assert.ok(failed.some((c) => c.name === 'set.extra' && /魏延/.test(String(c.detail))));
});

test('反例：内容缺项 —— 少一个', () => {
  const checks = judgeSet(ctx('关羽，张飞，赵云，马超', { values: FIVE, mode: 'exact' }));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]?.detail), /黄忠/);
});

test('反例：空响应 → empty 硬失败', () => {
  const checks = judgeSet(ctx('', { values: FIVE, mode: 'exact' }));
  assert.ok(checks.some((c) => c.name === 'empty' && c.hard));
});

test('反例：expect 非法（mode 不支持）抛错', () => {
  assert.throws(() => judgeSet(ctx('x', { values: ['a'], mode: 'loose' })), /mode/);
  assert.throws(() => judgeSet(ctx('x', { values: [] })), /values/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeSet(ctx('关羽', { values: FIVE, mode: 'subset' }, 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});
