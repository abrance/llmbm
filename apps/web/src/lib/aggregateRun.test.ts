/**
 * 聚合口径：诊断题（group=timeout）在进 aggregate 之前就被剔除 —— 这是「超时不判分」的最后一道闸。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { QuestionScore } from '@llmbm/core';
import { aggregateRun, scoredResults } from './aggregateRun.ts';
import type { QuestionResult } from './types.ts';

function scoreOf(questionId: string, group: string, value: number, transportError?: boolean): QuestionScore {
  return {
    questionId,
    group,
    judge: 'exact',
    score: value,
    status: value >= 90 ? 'pass' : 'fail',
    checksPassed: 1,
    checksTotal: 1,
    checks: [],
    flags: [],
    core: false,
    ...(transportError !== undefined ? { transportError } : {}),
  };
}

function resultOf(questionId: string, group: string, list: QuestionScore[], diagnostic = false): QuestionResult {
  return {
    questionId,
    group,
    prompt: 'q',
    judge: 'exact',
    core: false,
    weight: diagnostic ? 0 : 1,
    ...(diagnostic ? { diagnostic: true } : {}),
    samples: list.map((score, index) => ({ index, response: { text: '' }, checks: [], score, repeatRatio: 0 })),
    mean: 0,
    halfWidth: 0,
    status: 'pass',
  };
}

test('scoredResults：只留能力题，诊断题被剔除', () => {
  const results = [resultOf('a', 'basic', [scoreOf('a', 'basic', 100)]), resultOf('t', 'timeout', [], true)];
  assert.deepEqual(
    scoredResults(results).map((item) => item.questionId),
    ['a'],
  );
});

test('诊断题不进能力分/维度/题数与通过计数', () => {
  const capability = [resultOf('a', 'basic', [scoreOf('a', 'basic', 100)])];
  const withTimeout = [
    ...capability,
    resultOf('timeout-short-001', 'timeout', [scoreOf('timeout-short-001', 'timeout', 0, true)], true),
    resultOf('timeout-hang-001', 'timeout', [scoreOf('timeout-hang-001', 'timeout', 0, true)], true),
  ];

  const plain = aggregateRun(capability, 1);
  const observed = aggregateRun(withTimeout, 1);

  assert.deepEqual(observed.total, plain.total);
  assert.deepEqual(observed.dimensions, plain.dimensions);
  assert.deepEqual(observed.counts, plain.counts);
  assert.deepEqual(observed.samples, plain.samples);
  // 传输错误也不混进能力报告的传输账：诊断题的传输结论只在 LatencyPanel。
  assert.equal(observed.transport.errors, 0);
  assert.equal(observed.transport.samples, plain.transport.samples);
});

test('诊断题成绩不影响能力题的通过率与格式统计', () => {
  const results = [
    resultOf('a', 'basic', [scoreOf('a', 'basic', 100)]),
    resultOf('b', 'ability', [scoreOf('b', 'ability', 40)]),
    resultOf('timeout-ttft-001', 'timeout', [scoreOf('timeout-ttft-001', 'timeout', 0, true)], true),
  ];
  const report = aggregateRun(results, 1);
  assert.equal(report.counts.pass, 1);
  assert.equal(report.counts.fail, 1);
  assert.equal(report.counts.questions, 2);
  assert.equal(report.stability.expected, 2);
});
