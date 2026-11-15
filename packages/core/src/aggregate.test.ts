import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, SCORE_CAP } from './aggregate.js';
import { sampleStat, formatStat } from './scoring/interval.js';
import type { QuestionScore } from './types.js';

const s = (questionId: string, group: string, score: number, judge = 'exact'): QuestionScore => ({
  questionId,
  group,
  judge: judge as QuestionScore['judge'],
  score,
  status: score >= 90 ? 'pass' : score >= 55 ? 'pending_review' : 'fail',
  checksPassed: 1,
  checksTotal: 1,
  checks: [],
  flags: [],
  core: false,
});

test('区间：n=1 半宽 0；n=3 用 t=4.303', () => {
  assert.equal(sampleStat([80]).halfWidth, 0);
  const st = sampleStat([80, 90, 100]);
  assert.equal(st.mean, 90);
  // sd = 10, t(2,0.975)=4.303, half = 4.303*10/sqrt(3) = 24.84
  assert.ok(Math.abs(st.halfWidth - 24.84) < 0.02, String(st.halfWidth));
  assert.match(formatStat(st), /^90 ± 24\.84 \(n=3\)$/);
});

test('总分非全 100 → 封顶 99（F8）', () => {
  const r = aggregate({ scores: [s('a', 'basic', 100), s('b', 'basic', 100)] });
  assert.equal(r.total.mean, 100);
  assert.equal(r.capped, false);

  const r2 = aggregate({ scores: [s('a', 'basic', 100), s('b', 'ability', 99)] });
  assert.equal(r2.total.mean, SCORE_CAP);
  assert.equal(r2.capped, true);
});

test('维度分按题均值加权，题级状态取最差采样', () => {
  const r = aggregate({
    scores: [s('a', 'basic', 100), s('a', 'basic', 50), s('b', 'basic', 100), s('c', 'ability', 60)],
  });
  const basic = r.dimensions.find((d) => d.dimension === 'basic');
  const ability = r.dimensions.find((d) => d.dimension === 'ability');
  assert.equal(basic?.questions, 2);
  assert.equal(basic?.stat.mean, 87.5); // a 题均 75、b 100 → 87.5
  assert.equal(ability?.stat.mean, 60);
  assert.deepEqual(r.counts, { pass: 1, pending: 1, fail: 1, questions: 3 });
});

test('权重影响总分', () => {
  const scores = [s('a', 'basic', 100), s('b', 'basic', 0)];
  assert.equal(aggregate({ scores }).total.mean, 50);
  assert.equal(aggregate({ scores, weights: { a: 3, b: 1 } }).total.mean, 75);
});

test('format 命中率与 stability 完成率', () => {
  const r = aggregate({
    scores: [s('f1', 'basic', 100, 'format-json'), s('f2', 'basic', 40, 'format-json'), s('x', 'basic', 100)],
    expectedQuestions: 4,
  });
  assert.deepEqual(r.format, { rate: 0.5, hit: 1, total: 2 });
  assert.deepEqual(r.stability, { completed: 3, expected: 4, rate: 0.75 });
});

test('空输入不崩', () => {
  const r = aggregate({ scores: [] });
  assert.equal(r.total.mean, 0);
  assert.deepEqual(r.counts, { pass: 0, pending: 0, fail: 0, questions: 0 });
  assert.equal(r.stability.rate, 0);
});

const t = (questionId: string, group: string, score: number): QuestionScore => ({
  ...s(questionId, group, score),
  score: 0,
  status: 'pending_review',
  transportError: true,
});

test('D5：传输失败的采样不进能力分，只计入传输错误率', () => {
  // 两条 pelican 题各一次 60s 超时：旧口径把能力分从 100 稀释到 97.10。
  const r = aggregate({
    scores: [s('a', 'basic', 100), s('a', 'basic', 100), t('a', 'basic', 0), s('b', 'ability', 100)],
  });
  assert.equal(r.total.mean, 100);
  assert.equal(r.total.n, 2);
  assert.deepEqual(r.samples, { valid: 3, total: 4 });
  assert.deepEqual(r.transport, { errors: 1, samples: 4, rate: 0.25 });
  assert.deepEqual(r.counts, { pass: 2, pending: 0, fail: 0, questions: 2 });
});

test('D5：有效采样不足是 pending_review，不是 fail，且整题不进能力分', () => {
  const r = aggregate({ scores: [t('x', 'ability', 0), s('y', 'ability', 100)] });
  assert.equal(r.total.mean, 100);
  assert.equal(r.total.n, 1);
  assert.deepEqual(r.counts, { pass: 1, pending: 1, fail: 0, questions: 2 });
  assert.deepEqual(r.transport, { errors: 1, samples: 2, rate: 0.5 });
});

test('D5：整场都是传输失败时不崩，能力分 0、错误率 1', () => {
  const r = aggregate({ scores: [t('a', 'basic', 0), t('b', 'basic', 0)] });
  assert.equal(r.total.mean, 0);
  assert.equal(r.total.n, 0);
  assert.deepEqual(r.counts, { pass: 0, pending: 2, fail: 0, questions: 2 });
  assert.equal(r.transport.rate, 1);
  assert.equal(r.dimensions.length, 0);
});

test('稳定性按有效采样率算：被拒/超时压低它，而不是「有采样就算完成」', () => {
  const scores: QuestionScore[] = [];
  // 2 题 × 2 采样：1 次被端点拒绝（transportError），其余 3 次正常满���
  for (let i = 0; i < 2; i++) {
    for (let s = 0; s < 2; s++) {
      const rejected = i === 0 && s === 0;
      scores.push({
        questionId: `q${i}`,
        group: 'basic',
        judge: 'exact',
        score: rejected ? 0 : 100,
        status: rejected ? 'pending_review' : 'pass',
        checksPassed: rejected ? 0 : 1,
        checksTotal: 1,
        checks: [],
        flags: [],
        core: false,
        ...(rejected ? { transportError: true } : {}),
      });
    }
  }
  const report = aggregate({ scores, expectedQuestions: 2, samplesPerQuestion: 2 });
  assert.equal(report.stability.completed, 2);
  assert.equal(report.stability.expected, 2);
  assert.equal(report.stability.rate, 0.75);
  assert.equal(report.samples.valid, 3);
});

test('整卷被拒时稳定性为 0（不因「每题都有采样」而显示 100%）', () => {
  const scores: QuestionScore[] = [0, 1].map((i) => ({
    questionId: `q${i}`,
    group: 'basic',
    judge: 'exact',
    score: 0,
    status: 'pending_review' as const,
    checksPassed: 0,
    checksTotal: 1,
    checks: [],
    flags: [] as [],
    core: false,
    transportError: true,
  }));
  const report = aggregate({ scores, expectedQuestions: 2, samplesPerQuestion: 1 });
  assert.equal(report.stability.rate, 0);
});

test('不给 samplesPerQuestion 时退回旧口径（完成题数 / 应跑题数）', () => {
  const scores: QuestionScore[] = [0, 1].map((i) => ({
    questionId: `q${i}`,
    group: 'basic',
    judge: 'exact',
    score: 100,
    status: 'pass' as const,
    checksPassed: 1,
    checksTotal: 1,
    checks: [],
    flags: [] as [],
    core: false,
  }));
  const report = aggregate({ scores, expectedQuestions: 4 });
  assert.equal(report.stability.rate, 0.5);
});

test('weight=0 的观测题不进能力分、维度分与题级统计，但传输失败仍计入 transport', () => {
  const scored = s('q1', 'ability', 100);
  const observed = s('q-timeout', 'timeout', 0);
  const observedTimeout: QuestionScore = {
    ...s('q-timeout-2', 'timeout', 0),
    status: 'pending_review',
    transportError: true,
    flags: ['timeout'],
  };
  const base = aggregate({ scores: [scored], expectedQuestions: 1, weights: { q1: 1 } });
  const withObservations = aggregate({
    scores: [scored, observed, observedTimeout],
    expectedQuestions: 3,
    weights: { q1: 1, 'q-timeout': 0, 'q-timeout-2': 0 },
  });
  assert.equal(withObservations.total.mean, base.total.mean);
  assert.equal(withObservations.dimensions.length, base.dimensions.length);
  assert.equal(withObservations.counts.pass, base.counts.pass);
  assert.equal(withObservations.counts.fail, base.counts.fail);
  // 观测题的传输失败仍进 transport 账，不静默吞掉
  assert.equal(withObservations.transport.errors, 1);
  assert.equal(withObservations.transport.samples, 3);
});
