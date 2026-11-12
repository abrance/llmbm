import assert from 'node:assert/strict';
import test from 'node:test';
import { completionRatio, createCheckpoint, isReusable, pendingIds, recordDone } from './checkpoint.ts';

test('checkpoint: 新建为空，全部题待跑', () => {
  const cp = createCheckpoint('run1', 'qb-1', 'seed-a');
  assert.deepEqual(pendingIds(['a', 'b'], cp), ['a', 'b']);
  assert.equal(completionRatio(cp, ['a', 'b']), 0);
});

test('checkpoint: 记录后不重复跑，比例正确，且不改原对象', () => {
  const cp0 = createCheckpoint('run1', 'qb-1', 'seed-a');
  const cp1 = recordDone(cp0, 'a', { score: 90 });
  assert.deepEqual(cp0.done, {}, '原对象不应被改');
  assert.deepEqual(pendingIds(['a', 'b'], cp1), ['b']);
  assert.equal(completionRatio(cp1, ['a', 'b']), 0.5);
});

test('checkpoint: 题库版本或 seed 变化即失效', () => {
  const cp = createCheckpoint('run1', 'qb-1', 'seed-a');
  assert.equal(isReusable(cp, 'qb-1', 'seed-a'), true);
  assert.equal(isReusable(cp, 'qb-2', 'seed-a'), false);
  assert.equal(isReusable(cp, 'qb-1', 'seed-b'), false);
  assert.equal(isReusable(undefined, 'qb-1', 'seed-a'), false);
});

test('checkpoint: 空题集比例是 0 而不是 NaN', () => {
  assert.equal(completionRatio(createCheckpoint('r', 'q', 's'), []), 0);
});
