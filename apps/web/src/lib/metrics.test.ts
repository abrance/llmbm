import assert from 'node:assert/strict';
import test from 'node:test';
import { etaMs, failedIds, formatDuration, probesOf, progressPercent, repeatRatio, scoreRange } from './metrics.ts';
import type { QuestionResult } from './types.ts';

function result(id: string, status: 'pass' | 'pending_review' | 'fail', mean: number): QuestionResult {
  return {
    questionId: id,
    group: 'basic',
    prompt: 'p',
    judge: 'exact',
    core: false,
    weight: 1,
    mean,
    halfWidth: 2,
    status,
    samples: [
      {
        index: 0,
        response: { text: 'x', latencyMs: 10 },
        checks: [{ name: 'exact.match', pass: status === 'pass', detail: status === 'pass' ? undefined : '不一样' }],
        score: {
          questionId: id,
          group: 'basic',
          judge: 'exact',
          score: mean,
          status,
          checksPassed: 0,
          checksTotal: 1,
          checks: [],
          flags: [],
          core: false,
        },
        repeatRatio: 0,
      },
    ],
  };
}

test('formatDuration: 秒与分秒', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(65_000), '1m05s');
  assert.equal(formatDuration(Number.NaN), '—');
});

test('etaMs: 只在有进度且未完成时给出', () => {
  assert.equal(etaMs(0, 10, 1000), undefined);
  assert.equal(etaMs(10, 10, 1000), undefined);
  assert.equal(etaMs(2, 10, 1000), 4000);
});

test('progressPercent: 空题集不 NaN', () => {
  assert.equal(progressPercent(0, 0), 0);
  assert.equal(progressPercent(1, 4), 25);
  assert.equal(progressPercent(9, 4), 100);
});

test('repeatRatio: 重复行占比，单行视为 0', () => {
  assert.equal(repeatRatio('只有一行'), 0);
  assert.equal(repeatRatio('a\nb\nc'), 0);
  assert.ok(Math.abs(repeatRatio('a\na\nb') - 1 / 3) < 1e-9);
});

test('scoreRange: 截断在 0~100', () => {
  assert.deepEqual(scoreRange(2, 5), { low: 0, high: 7 });
  assert.deepEqual(scoreRange(98, 5), { low: 93, high: 100 });
});

test('probesOf/failedIds: 只看非 pass，按分数升序', () => {
  const results = [result('a', 'pass', 100), result('b', 'pending_review', 70), result('c', 'fail', 10)];
  const probes = probesOf(results);
  assert.deepEqual(probes.map((p) => p.questionId), ['c', 'b']);
  assert.deepEqual(failedIds(results), ['b', 'c']);
  assert.match(probes[0]?.reason ?? '', /不一样/);
});
