/**
 * 超时与时延统计的口径单测：全超时 / 部分超时 / 全正常三种结论，
 * 以及 p50/p95 的边界（1 条采样、0 条采样、timeoutMs=0）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeLatency,
  isTimeoutError,
  latencyStats,
  percentile,
  type LatencyQuestionInput,
} from './latency.ts';

function q(
  questionId: string,
  samples: { latencyMs?: number; ttftMs?: number; error?: string }[],
  extra: Partial<LatencyQuestionInput> = {},
): LatencyQuestionInput {
  return { questionId, group: 'timeout', ...extra, samples };
}

test('percentile：nearest-rank，n=1 时各分位相等，空数组 undefined', () => {
  assert.equal(percentile([], 50), undefined);
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 95), 42);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
  assert.equal(percentile([5, 1, 3], 50), 3);
});

test('latencyStats：1 条采样 p50=p95=max', () => {
  assert.deepEqual(latencyStats([123]), { n: 1, p50: 123, p95: 123, max: 123 });
  assert.deepEqual(latencyStats([]), { n: 0 });
});

test('isTimeoutError：只认 transport 的超时文案，断流不算超时', () => {
  assert.equal(isTimeoutError('请求超时（30000ms）'), true);
  assert.equal(isTimeoutError('流在完成标记前结束（HTTP 200，未收到 finishReason）'), false);
  assert.equal(isTimeoutError(undefined), false);
});

test('全超时：结论明说全部超时，分位数不给有效值', () => {
  const report = analyzeLatency([
    q('timeout-short-001', [
      { latencyMs: 20000, error: '请求超时（20000ms）' },
      { latencyMs: 20000, error: '请求超时（20000ms）' },
      { latencyMs: 20000, error: '请求超时（20000ms）' },
    ], { timeoutMs: 20000, tags: ['短问答'] }),
  ]);
  assert.equal(report.samples, 3);
  assert.equal(report.timeouts, 3);
  assert.equal(report.timeoutRate, 1);
  assert.equal(report.ttft.n, 0);
  assert.equal(report.total.n, 0);
  assert.equal(report.questions[0]?.verdict, 'all-timeout');
  assert.match(report.headlines[0] as string, /全部超时/);
  assert.match(report.headlines[0] as string, /100%/);
  assert.match(report.questions[0]?.sentences[0] as string, /超时 3\/3 次（100.0%）/);
});

test('部分超时：超时率正确，只对有效采样算分位，并给排查方向', () => {
  const report = analyzeLatency([
    q('timeout-long-001', [
      { latencyMs: 61000, error: '请求超时（60000ms）' },
      { latencyMs: 1000, ttftMs: 200 },
      { latencyMs: 1200, ttftMs: 210 },
    ], { timeoutMs: 60000, tags: ['长输出'] }),
  ]);
  assert.equal(report.timeouts, 1);
  assert.equal(report.timeoutRate, 1 / 3);
  assert.equal(report.ttft.n, 2);
  assert.equal(report.ttft.p50, 200);
  assert.equal(report.ttft.p95, 210);
  assert.equal(report.questions[0]?.verdict, 'partial-timeout');
  assert.match(report.headlines[0] as string, /1 次超时/);
  assert.ok(report.questions[0]?.sentences.some((s) => /长输出/.test(s)));
});

test('全正常：明说 0 超时并给 TTFT 中位；短问答慢时下「端点排队」结论', () => {
  const report = analyzeLatency([
    q('timeout-short-001', [
      { latencyMs: 8300, ttftMs: 8200 },
      { latencyMs: 8400, ttftMs: 8300 },
      { latencyMs: 8500, ttftMs: 8400 },
    ], { timeoutMs: 30000, tags: ['短问答'] }),
    q('timeout-long-001', [
      { latencyMs: 9000, ttftMs: 900 },
      { latencyMs: 9100, ttftMs: 950 },
      { latencyMs: 9200, ttftMs: 1000 },
    ], { timeoutMs: 60000, tags: ['长输出'] }),
  ]);
  assert.equal(report.timeouts, 0);
  assert.match(report.headlines[0] as string, /0 超时/);
  assert.ok(report.headlines.some((h) => /短问答「timeout-short-001」的 TTFT 中位 8\.3s/.test(h)));
  assert.ok(report.headlines.some((h) => /不是题太大，是端点排队/.test(h)));
});

test('全正常且各题相差不大：结论是整体慢，不是单题重', () => {
  const report = analyzeLatency([
    q('a', [{ latencyMs: 5000, ttftMs: 4000 }, { latencyMs: 5100, ttftMs: 4100 }]),
    q('b', [{ latencyMs: 5050, ttftMs: 4200 }, { latencyMs: 5080, ttftMs: 4300 }]),
  ]);
  assert.ok(report.headlines.some((h) => /整个端点慢/.test(h)));
  assert.equal(report.questions[0]?.verdict, 'normal');
});

test('单题偏慢：与同端点其他题中位对比 ≥2 倍才标 slower-than-peers', () => {
  const report = analyzeLatency([
    q('slow', [{ latencyMs: 5000, ttftMs: 4000 }, { latencyMs: 5100, ttftMs: 4200 }], { tags: ['首字慢'] }),
    q('peer-a', [{ latencyMs: 800, ttftMs: 400 }, { latencyMs: 820, ttftMs: 410 }]),
    q('peer-b', [{ latencyMs: 900, ttftMs: 450 }, { latencyMs: 880, ttftMs: 430 }]),
  ]);
  const slow = report.questions.find((item) => item.questionId === 'slow');
  assert.equal(slow?.verdict, 'slower-than-peers');
  assert.equal(slow?.peerTtftP50, 410);
  assert.ok(slow?.sentences.some((s) => /本题偏慢/.test(s)));
});

test('0 条采样：不把空结果当 0 超时，明确说没有采样', () => {
  const report = analyzeLatency([q('timeout-x', [], { timeoutMs: 30000 })]);
  assert.equal(report.samples, 0);
  assert.match(report.headlines[0] as string, /没有采样/);
  assert.equal(report.questions[0]?.verdict, 'no-data');
  assert.equal(report.questions[0]?.timeoutRate, 0);
});

test('timeoutMs=0：不做预算余量判断，也不除零', () => {
  const report = analyzeLatency([
    q('timeout-x', [{ latencyMs: 100, ttftMs: 50 }, { latencyMs: 120, ttftMs: 60 }], { timeoutMs: 0 }),
  ]);
  const item = report.questions[0];
  assert.equal(item?.timeoutMs, 0);
  assert.equal(item?.verdict, 'normal');
  assert.ok(!item?.sentences.some((s) => /占预算/.test(s)));
});

test('非超时传输错误单独计数，不混进超时率', () => {
  const report = analyzeLatency([
    q('timeout-x', [
      { latencyMs: 500, error: '流在完成标记前结束（HTTP 200，未收到 finishReason）' },
      { latencyMs: 600, ttftMs: 100 },
    ], { timeoutMs: 30000 }),
  ]);
  assert.equal(report.timeouts, 0);
  assert.equal(report.questions[0]?.otherErrors, 1);
  assert.match(report.questions[0]?.sentences.join('') as string, /非超时传输错误/);
});

test('Markdown 导出：未跑本组也写明；有数据时结论与表格同屏', async () => {
  const { latencyMarkdownBlock } = await import('./latencyMarkdown.ts');
  const empty = latencyMarkdownBlock(analyzeLatency([], { scopeGroup: 'timeout' }));
  assert.ok(empty.some((line) => /没有采样/.test(line)));
  const report = analyzeLatency([
    q('timeout-short-001', [
      { latencyMs: 9000, ttftMs: 8500 },
      { latencyMs: 9100, ttftMs: 8600 },
      { latencyMs: 9200, ttftMs: 8700 },
    ], { timeoutMs: 30000, tags: ['短问答'] }),
  ]);
  const text = latencyMarkdownBlock(report).join('\n');
  assert.match(text, /本组 3 次采样 0 超时/);
  assert.match(text, /\| 题目 \| 超时率 \|/);
  assert.match(text, /不是题太大，是端点排队/);
});
