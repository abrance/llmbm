import assert from 'node:assert/strict';
import test from 'node:test';
import { signalMarkdownBlock, signalsOf, verdictText } from './signals.ts';
import type { QuestionResult, RunRecord, SampleResult } from './types.ts';

function sample(index: number, text: string, err?: string): SampleResult {
  return {
    index,
    response: err ? { text: '', error: err } : { text },
    checks: [],
    score: {
      questionId: 'q1',
      group: 'basic',
      judge: 'exact',
      score: err ? 0 : 100,
      status: err ? 'pending_review' : 'pass',
      checksPassed: 0,
      checksTotal: 0,
      checks: [],
      flags: [],
      core: false,
      ...(err ? { transportError: true as const } : {}),
    },
    repeatRatio: 0,
  };
}

function result(samples: SampleResult[]): QuestionResult {
  return {
    questionId: 'q1',
    group: 'basic',
    prompt: 'p',
    judge: 'exact',
    core: false,
    weight: 1,
    samples,
    mean: 100,
    halfWidth: 0,
    status: 'pass',
  };
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run_1',
    seed: 's',
    samples: 2,
    groups: ['basic'],
    endpoint: { baseUrl: 'https://x.test', model: 'm', protocol: 'openai', domain: 'x.test' },
    questionBankVersion: 'qb-1',
    judgeRuleVersion: 'jr-1',
    startedAt: '2026-11-13T00:00:00.000Z',
    finishedAt: '2026-11-13T00:01:00.000Z',
    cancelled: false,
    expected: 1,
    results: [result([sample(0, '答案 A'), sample(1, '答案 B')])],
    report: {
      total: { mean: 100, halfWidth: 0, n: 1, values: [] },
      capped: false,
      dimensions: [],
      format: { rate: 0, hit: 0, total: 0 },
      stability: { completed: 1, expected: 1, rate: 1 },
      counts: { pass: 1, pending: 0, fail: 0, questions: 1 },
      transport: { errors: 0, samples: 2, rate: 0 },
      samples: { valid: 2, total: 2 },
    },
    injectFlaky: false,
    ...overrides,
  };
}

test('signalsOf：传输失败的采样不进弱信号（否则空正文会被判成长度萎缩）', () => {
  const run = record({ results: [result([sample(0, '正常回答'), sample(1, '', '超时')])] });
  const signals = signalsOf(run.results);
  assert.equal(signals.fingerprint.features.samples, 1);
  assert.equal(signals.degradation.samples, 1);
  assert.equal(signals.degradation.flagged, 0);
});

test('无基线：verdict 恒为 insufficient-data，且带 caveat', () => {
  const signals = signalsOf(record().results);
  assert.equal(signals.fingerprint.verdict, 'insufficient-data');
  assert.ok(signals.fingerprint.caveat.length > 0);
  assert.equal(signals.fingerprint.weak, true);
  assert.match(verdictText('insufficient-data'), /没有历史基线/);
  assert.match(verdictText('insufficient-data'), /无法判断是否变化/);
});

test('verdictText：suspect-degraded 不写成人话结论', () => {
  assert.doesNotMatch(verdictText('suspect-degraded'), /已确认|确定降智/);
  assert.match(verdictText('suspect-degraded'), /未确认/);
});

test('导出段落：数值与 caveat 同屏，且写明缺少基线', () => {
  const signals = signalsOf(record().results);
  const md = signalMarkdownBlock({ ...record(), ...signals }).join('\n');
  assert.match(md, /### 指纹特征/);
  assert.match(md, /该端点没有历史基线，本次无法判断是否变化/);
  assert.ok(md.includes(signals.fingerprint.caveat));
  assert.ok(md.includes(signals.degradation.caveat));
  assert.match(md, /平均正文 4 字/);
  assert.match(md, /命中 0\/2 条采样/);
});

test('导出段落：旧记录（无指纹字段）写明本次未采集，不抛错', () => {
  const md = signalMarkdownBlock(record()).join('\n');
  assert.match(md, /本次未采集/);
});
