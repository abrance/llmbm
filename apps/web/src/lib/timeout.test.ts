import assert from 'node:assert/strict';
import test from 'node:test';
import { QUESTION_BANK } from '../data/bank.ts';
import { classifyTimeout, TIMEOUT_CLASSES, timeoutMarkdownBlock, timeoutReportOf } from './timeout.ts';
import type { QuestionResult, RunRecord } from './types.ts';

const timeoutOf = (id: string) => QUESTION_BANK.find((q) => q.id === id)?.timeoutMs;

function result(
  questionId: string,
  samples: { error?: string; httpStatus?: number; latencyMs?: number }[],
): QuestionResult {
  return {
    questionId,
    group: 'context',
    prompt: 'p',
    judge: 'contains',
    core: false,
    weight: 1,
    mean: 0,
    halfWidth: 0,
    status: 'pending_review',
    samples: samples.map((sample, index) => ({
      index,
      response: { text: '', ...sample },
      checks: [],
      score: {
        questionId,
        group: 'context',
        judge: 'contains',
        score: 0,
        status: 'pending_review',
        checksPassed: 0,
        checksTotal: 0,
        checks: [],
        flags: [],
        core: false,
        transportError: true,
      },
      repeatRatio: 0,
    })),
  };
}

test('classifyTimeout：状态码优先，超时文案按阶段分类', () => {
  assert.equal(classifyTimeout({ error: 'HTTP 429', httpStatus: 429 }), 'rate-limit');
  assert.equal(classifyTimeout({ error: 'HTTP 502', httpStatus: 502 }), 'gateway');
  assert.equal(classifyTimeout({ error: 'HTTP 500', httpStatus: 500 }), 'unknown');
  assert.equal(classifyTimeout({ error: '请求超时（30000ms）' }), 'connect');
  assert.equal(classifyTimeout({ error: '请求超时（30000ms）', httpStatus: 200 }), 'first-token');
  assert.equal(classifyTimeout({ error: '请求超时（30000ms）', chunks: 4 }), 'mid-stream');
  assert.equal(classifyTimeout({ error: '网络错误：fetch failed' }), 'unknown');
});

test('只统计 response.error 存在的采样，类别与 classifyTimeout 一致', () => {
  const results = [
    result('ctx-needle-001', [
      { error: '请求超时（120000ms）', latencyMs: 120001 },
      { error: 'HTTP 429', httpStatus: 429 },
      {},
    ]),
  ];
  const report = timeoutReportOf(results, timeoutOf);
  assert.equal(report.requests, 3);
  assert.equal(report.samples, 2);
  assert.equal(report.entries.length, 2);

  for (const entry of report.entries) {
    assert.equal(
      entry.class,
      classifyTimeout({
        error: entry.error,
        ...(entry.httpStatus !== undefined ? { httpStatus: entry.httpStatus } : {}),
      }),
    );
    assert.ok(TIMEOUT_CLASSES.includes(entry.class));
  }
  const total = TIMEOUT_CLASSES.reduce((sum, kind) => sum + report.byClass[kind], 0);
  assert.equal(total, report.samples);
});

test('无错误采样 → 空分布，结果页据此整块不渲染', () => {
  const report = timeoutReportOf([result('basic-exact-001', [{}, {}])], timeoutOf);
  assert.equal(report.samples, 0);
  assert.equal(report.requests, 2);
  assert.equal(report.entries.length, 0);
  assert.match(timeoutMarkdownBlock(report).join('\n'), /没有传输错误采样/);
});

test('旧记录（无 report.timeout）导出写「本次未采集」', () => {
  const run = { results: [], report: {} } as unknown as RunRecord;
  assert.match(timeoutMarkdownBlock(run.report.timeout).join('\n'), /本次未采集/);
});

test('有错误时导出类别表与按题明细', () => {
  const report = timeoutReportOf(
    [
      result('ctx-needle-002', [
        { error: '请求超时（120000ms）', latencyMs: 120000 },
        { error: 'HTTP 502', httpStatus: 502 },
      ]),
    ],
    timeoutOf,
  );
  const text = timeoutMarkdownBlock(report).join('\n');
  assert.match(text, /传输错误采样：2\/2 次/);
  assert.match(text, /ctx-needle-002/);
  assert.match(text, /不参与能力分与 judge 分数/);
});
