/**
 * 超时与时延统计的口径单测（分类、分位数、分母、重试）。
 *
 * 分类与分位数来自 core（classifyTimeout / summarizeTransport），这里验的是 web 这一层的口径：
 * 全超时 / 部分超时 / 全正常 / 取消分母 / attempt 级超时不抹掉 / 非超时错误不混算。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeLatency, type LatencyQuestionInput, type LatencySampleInput } from './latency.ts';

function q(
  questionId: string,
  samples: LatencySampleInput[],
  extra: Partial<LatencyQuestionInput> = {},
): LatencyQuestionInput {
  return { questionId, group: 'timeout', ...extra, samples };
}

function timeout(ms = 20000, extra: LatencySampleInput = {}): LatencySampleInput {
  return { latencyMs: ms, error: `请求超时（${ms}ms）`, phase: 'before-first-byte', chunks: 0, ...extra };
}

function ok(latencyMs: number, ttftMs: number): LatencySampleInput {
  return { latencyMs, ttftMs, phase: 'done', chunks: 3 };
}

test('全超时：分母=已发起，结论明说全部超时，分位数不给有效值', () => {
  const report = analyzeLatency([
    q('timeout-short-001', [timeout(), timeout(), timeout()], { timeoutMs: 20000, tags: ['短问答'] }),
  ]);

  assert.equal(report.initiated, 3);
  assert.equal(report.timedOut, 3);
  assert.equal(report.timeoutRate, 1);
  assert.equal(report.ttft.n, 0);
  assert.equal(report.latency.n, 0);
  assert.equal(report.questions[0]?.verdict, 'all-timeout');
  assert.match(report.headlines[0] as string, /全部超时/);
  assert.match(report.questions[0]?.sentences[0] as string, /超时 3\/3 次（100.0%）/);
});

test('部分超时：超时率正确，p50/p95 只统计成功完成的采样（超时不当完成时延）', () => {
  const report = analyzeLatency([
    q('timeout-long-001', [timeout(61000), ok(1000, 200), ok(1200, 210)], { timeoutMs: 60000, tags: ['长输出'] }),
  ]);

  assert.equal(report.timedOut, 1);
  assert.equal(report.completed, 2);
  assert.equal(report.timeoutRate, 1 / 3);
  assert.equal(report.ttft.n, 2);
  assert.equal(report.ttft.p50, 200);
  assert.equal(report.latency.max, 1200);
  assert.equal(report.questions[0]?.verdict, 'partial-timeout');
  assert.match(report.headlines[0] as string, /1 次超时/);
});

test('全正常：明说 0 超时并给 TTFT 中位；短问答慢时下「端点排队」结论', () => {
  const report = analyzeLatency([
    q('timeout-short-001', [ok(8300, 8200), ok(8400, 8300), ok(8500, 8400)], { timeoutMs: 30000, tags: ['短问答'] }),
    q('timeout-long-001', [ok(9000, 900), ok(9100, 950), ok(9200, 1000)], { timeoutMs: 60000, tags: ['长输出'] }),
  ]);

  assert.equal(report.timedOut, 0);
  assert.match(report.headlines[0] as string, /0 超时/);
  assert.ok(report.headlines.some((h) => /短问答「timeout-short-001」的 TTFT 中位 8\.3s/.test(h)));
  assert.ok(report.headlines.some((h) => /不是题太大，是端点排队/.test(h)));
});

test('全正常且各题相差不大：结论是整体慢，不是单题重', () => {
  const report = analyzeLatency([q('a', [ok(5000, 4000), ok(5100, 4100)]), q('b', [ok(5050, 4200), ok(5080, 4300)])]);
  assert.ok(report.headlines.some((h) => /整个端点慢/.test(h)));
  assert.equal(report.questions[0]?.verdict, 'normal');
});

test('单题偏慢：与同端点其他题中位对比 ≥2 倍才标 slower-than-peers', () => {
  const report = analyzeLatency([
    q('slow', [ok(5000, 4000), ok(5100, 4200)], { tags: ['首字慢'] }),
    q('peer-a', [ok(800, 400), ok(820, 410)]),
    q('peer-b', [ok(900, 450), ok(880, 430)]),
  ]);
  const slow = report.questions.find((item) => item.questionId === 'slow');
  assert.equal(slow?.verdict, 'slower-than-peers');
  assert.equal(slow?.peerTtftP50, 410);
  assert.ok(slow?.sentences.some((s) => /本题偏慢/.test(s)));
});

test('0 条采样：不把空结果当 0 超时，明确说没有采样', () => {
  const report = analyzeLatency([q('timeout-x', [], { timeoutMs: 30000 })]);
  assert.equal(report.initiated, 0);
  assert.equal(report.questions[0]?.verdict, 'no-data');
  assert.match(report.headlines[0] as string, /没有采样/);
});

test('取消与未发起不进分母：计划 6 次只发起 3 次，超时率按 3 算', () => {
  const report = analyzeLatency(
    [q('timeout-short-001', [timeout(), ok(900, 100), ok(950, 120)], { timeoutMs: 20000 })],
    {
      expected: 6,
      cancelled: 3,
    },
  );

  assert.equal(report.expected, 6);
  assert.equal(report.initiated, 3);
  assert.equal(report.cancelled, 3);
  assert.equal(report.timeoutRate, 1 / 3);
  assert.ok(report.headlines.some((h) => /3 次采样没有发起/.test(h)));
});

test('短路未发起：单独计数为 notRun，也不进分母', () => {
  const report = analyzeLatency([q('timeout-short-001', [timeout()], { timeoutMs: 20000 })], {
    expected: 3,
    notRun: 2,
  });
  assert.equal(report.notRun, 2);
  assert.equal(report.timeoutRate, 1);
  assert.ok(report.headlines.some((h) => /端点短路 2/.test(h)));
});

test('重试：attempt 级超时不被成功抹掉，逻辑采样仍算成功', () => {
  const retried: LatencySampleInput = {
    latencyMs: 1800,
    ttftMs: 600,
    phase: 'done',
    chunks: 4,
    attempts: [
      { outcome: 'timeout', latencyMs: 1500, error: '请求超时（1500ms）' },
      { outcome: 'success', latencyMs: 300 },
    ],
  };
  const report = analyzeLatency([q('timeout-ttft-001', [retried, ok(1000, 500)], { timeoutMs: 30000 })]);

  assert.equal(report.completed, 2);
  assert.equal(report.timedOut, 0);
  assert.equal(report.timeoutRate, 0);
  assert.equal(report.attempt.retriedSamples, 1);
  assert.equal(report.attempt.timeoutAttempts, 1);
  assert.ok(report.headlines.some((h) => /attempt 共 2 次，其中 1 次超时/.test(h)));
  assert.ok(report.questions[0]?.sentences.some((s) => /attempt 明细保留/.test(s)));
});

test('timeoutMs=0：不做预算余量判断，也不除零', () => {
  const report = analyzeLatency([q('timeout-x', [ok(100, 50), ok(120, 60)], { timeoutMs: 0 })]);
  const item = report.questions[0];
  assert.equal(item?.timeoutMs, 0);
  assert.equal(item?.verdict, 'normal');
  assert.ok(!item?.sentences.some((s) => /占预算/.test(s)));
});

test('非超时传输错误单独计数：断流与 429 都不混进超时率', () => {
  const report = analyzeLatency([
    q(
      'timeout-x',
      [
        { latencyMs: 500, error: '流在完成标记前结束（HTTP 200，未收到 finishReason）', phase: 'streaming', chunks: 2 },
        { latencyMs: 300, error: 'HTTP 429：rate limited', httpStatus: 429 },
        ok(600, 100),
      ],
      { timeoutMs: 30000 },
    ),
  ]);

  assert.equal(report.timedOut, 0);
  assert.equal(report.failed, 2);
  assert.equal(report.questions[0]?.otherErrors, 2);
  assert.equal(report.questions[0]?.byClass['rate-limit'], 1);
  assert.equal(report.questions[0]?.byClass.unknown, 1);
  assert.match(report.questions[0]?.sentences.join('') as string, /非超时传输错误/);
});

test('超时按环节归因：connect / first-token / mid-stream 分别计数', () => {
  const report = analyzeLatency([
    q(
      'timeout-x',
      [
        { latencyMs: 15000, error: '请求超时（15000ms）' },
        { latencyMs: 15000, error: '请求超时（15000ms）', phase: 'before-first-byte' },
        { latencyMs: 15000, error: '请求超时（15000ms）', phase: 'streaming', chunks: 2 },
      ],
      { timeoutMs: 15000 },
    ),
  ]);

  assert.equal(report.byClass.connect, 1);
  assert.equal(report.byClass['first-token'], 1);
  assert.equal(report.byClass['mid-stream'], 1);
  assert.ok(report.headlines.some((h) => /连接\/响应前 1 次/.test(h)));
});

test('Markdown 导出：未跑本组也写明；有数据时分母、结论与表格同屏', async () => {
  const { latencyMarkdownBlock } = await import('./latencyMarkdown.ts');
  const empty = latencyMarkdownBlock(analyzeLatency([], { scopeGroup: 'timeout' }));
  assert.ok(empty.some((line) => /没有采样/.test(line)));

  const report = analyzeLatency(
    [q('timeout-short-001', [ok(9000, 8500), ok(9100, 8600), ok(9200, 8700)], { timeoutMs: 30000, tags: ['短问答'] })],
    { expected: 3 },
  );
  const text = latencyMarkdownBlock(report).join('\n');
  assert.match(text, /本组 3 次采样 0 超时/);
  assert.match(text, /分母：已发起 3/);
  assert.match(text, /\| 题目 \| 发起 \| 成功 \| 超时 \|/);
  assert.match(text, /不是题太大，是端点排队/);
});
