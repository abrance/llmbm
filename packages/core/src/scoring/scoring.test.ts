import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreQuestion, detectWrapped, statusOf, PARAM_CAP, WRAPPED_FLOOR } from './index.js';
import type { Question } from '../types.js';

const ok = (name: string) => ({ name, pass: true });
const bad = (name: string, hard = false) => ({ name, pass: false, hard });

const q = (over: Partial<Question> = {}): Question => ({
  id: 'q1',
  group: 'basic',
  prompt: 'p',
  judge: 'exact',
  expect: 'x',
  ...over,
});

test('score = 通过项/总项 × 100', () => {
  const s = scoreQuestion(q(), [ok('a'), ok('b'), bad('c'), bad('d')]);
  assert.equal(s.score, 50);
  assert.equal(s.checksPassed, 2);
  assert.equal(s.checksTotal, 4);
});

test('core 题未全对 → 0，且打 core-failed', () => {
  const s = scoreQuestion(q({ core: true }), [ok('a'), bad('b')]);
  assert.equal(s.score, 0);
  assert.deepEqual(s.flags, ['core-failed']);
  assert.equal(s.status, 'fail');
});

test('硬检查失败 → 0（非 core 题同样）', () => {
  const s = scoreQuestion(q(), [ok('a'), bad('b', true)]);
  assert.equal(s.score, 0);
  assert.ok(s.flags.includes('core-failed'));
});

test('参数错主体对 → 封顶 50', () => {
  const s = scoreQuestion(q(), [ok('a'), bad('b')], { flags: ['params-wrong'] });
  assert.equal(s.score, PARAM_CAP);
});

test('包装规整但有瑕 → 保底 85 且 pending_review', () => {
  const s = scoreQuestion(q(), [ok('a'), bad('b'), bad('c'), bad('d')], { wrapped: true });
  assert.equal(s.score, WRAPPED_FLOOR);
  assert.equal(s.status, 'pending_review');
  assert.ok(s.flags.includes('wrapped'));
});

test('参数封顶优先于包装保底', () => {
  const s = scoreQuestion(q(), [ok('a'), bad('b')], { wrapped: true, flags: ['params-wrong'] });
  assert.equal(s.score, PARAM_CAP);
});

test('传输失败 → 0 + timeout', () => {
  const s = scoreQuestion(q(), [ok('a')], { transportError: 'ETIMEDOUT' });
  assert.equal(s.score, 0);
  assert.ok(s.flags.includes('timeout'));
});

test('满分 100 且 pass；阈值边界 90 / 55', () => {
  assert.equal(scoreQuestion(q(), [ok('a')]).status, 'pass');
  assert.equal(statusOf(90), 'pass');
  assert.equal(statusOf(89.9), 'pending_review');
  assert.equal(statusOf(55), 'pending_review');
  assert.equal(statusOf(54.9), 'fail');
});

test('detectWrapped：fenced code 与合法 JSON 视为规整', () => {
  assert.equal(detectWrapped('```json\n{}\n```'), true);
  assert.equal(detectWrapped('{"a":1}'), true);
  assert.equal(detectWrapped('{not json}'), false);
  assert.equal(detectWrapped('随便一段话'), false);
});
