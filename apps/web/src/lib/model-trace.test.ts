import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregate, type ModelTraceResult, type QuestionScore } from '@llmbm/core';
import {
  decisionText,
  modelTraceMarkdownBlock,
  probabilityText,
  referenceAccuracyText,
  topProbabilityText,
} from './model-trace.ts';

const CAVEAT = '探针只反映数字指纹更接近库内哪个模型，不进能力分。';

const RANK_A = {
  model: 'gpt-4o',
  display_name: 'GPT-4o',
  family: 'gpt-4',
  family_name: 'GPT-4',
  score: 0.91,
  probability: 0.72,
};
const RANK_B = {
  model: 'claude-sonnet-4-5',
  display_name: 'Claude Sonnet 4.5',
  family: 'claude',
  family_name: 'Claude',
  score: 0.88,
  probability: 0.28,
};

function trace(overrides: Partial<ModelTraceResult> = {}): ModelTraceResult {
  return {
    weak: true,
    caveat: CAVEAT,
    method: 'modeltrace-robust-v1',
    queries: 3,
    samples: [
      { index: 0, expectedCount: 300, parsedNumbers: 300, minimumNumbers: 165, accepted: true },
      { index: 1, expectedCount: 300, parsedNumbers: 300, minimumNumbers: 165, accepted: true },
      { index: 2, expectedCount: 300, parsedNumbers: 300, minimumNumbers: 165, accepted: true },
    ],
    used: 3,
    decision: 'ranked',
    probability: 0.72,
    probabilityStatus: 'reference-calibrated',
    probabilityScope: 'reference-closed-set',
    ranking: [RANK_A, RANK_B],
    top: RANK_A,
    referenceAccuracy: 0.97,
    ...overrides,
  };
}

test('旧记录（无 modelTrace）写「本次未采集」，不报错', () => {
  const text = modelTraceMarkdownBlock({}).join('\n');
  assert.match(text, /本次未采集/);
});

test('探针失败（requested 但没有结果）写「未取得有效样本」', () => {
  const text = modelTraceMarkdownBlock({ modelTraceRequested: true }).join('\n');
  assert.match(text, /未取得有效样本/);
});

test('ranked：排名、闭集概率、参考库准确率口径与 caveat 同屏', () => {
  const result = trace();
  const text = modelTraceMarkdownBlock({ modelTrace: result }).join('\n');
  assert.match(text, /GPT-4o/);
  assert.match(text, /72\.0%/);
  assert.match(text, /参考库在该样本数（3 条）下的交叉验证准确率：97\.0%（库属性，不是本次运行的置信度）/);
  assert.match(text, /只与库内模型比较，不含库外模型/);
  assert.match(text, new RegExp(CAVEAT));
  assert.equal(decisionText('ranked'), '三条样本齐全，给出闭集排名');
  assert.equal(probabilityText(RANK_A), '72.0%');
  assert.equal(referenceAccuracyText(result).includes('不是本次运行的置信度'), true);
});

test('partial：概率显示 —，不伪造本次置信度', () => {
  const result = trace({
    used: 1,
    decision: 'partial',
    probability: null,
    probabilityStatus: 'unavailable',
    probabilityScope: null,
    referenceAccuracy: 0.5,
    samples: [
      { index: 0, expectedCount: 300, parsedNumbers: 300, minimumNumbers: 165, accepted: true },
      {
        index: 1,
        expectedCount: 300,
        parsedNumbers: 0,
        minimumNumbers: 165,
        accepted: false,
        error: '请求超时（120000ms）',
      },
      { index: 2, expectedCount: 300, parsedNumbers: 0, minimumNumbers: 165, accepted: false, error: 'HTTP 502' },
    ],
    ranking: [{ ...RANK_A, probability: null }],
    top: { ...RANK_A, probability: null },
  });
  assert.equal(probabilityText(result.ranking[0]!), '—');
  assert.match(topProbabilityText(result), /不提供闭集概率/);
  const text = modelTraceMarkdownBlock({ modelTrace: result }).join('\n');
  assert.match(text, /只给排名、不给闭集概率/);
  assert.match(text, /请求超时（120000ms）/);
});

function score(id: string, value: number): QuestionScore {
  return {
    questionId: id,
    group: 'basic',
    judge: 'exact',
    score: value,
    status: value >= 90 ? 'pass' : 'fail',
    checksPassed: 1,
    checksTotal: 1,
    checks: [],
    flags: [],
    core: false,
  };
}

test('探针结果不参与聚合：带/不带 modelTrace 的 report 完全一致', () => {
  const scores = [score('a', 100), score('b', 80), score('c', 60)];
  const base = { scores, expectedQuestions: 3, weights: { a: 1, b: 1, c: 1 }, samplesPerQuestion: 1 };
  const plain = aggregate(base);
  const withTrace = aggregate({ ...base, modelTrace: trace() } as typeof base);
  assert.deepEqual(withTrace.total, plain.total);
  assert.deepEqual(withTrace.dimensions, plain.dimensions);
  assert.deepEqual(withTrace.counts, plain.counts);
});
