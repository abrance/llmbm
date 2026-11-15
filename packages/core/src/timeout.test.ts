import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTimeout, latencyStats, percentile, summarizeTransport } from './timeout.js';

test('classifyTimeout：状态码优先于文案', () => {
  assert.equal(classifyTimeout({ error: '请求超时（30000ms）', httpStatus: 429 }), 'rate-limit');
  assert.equal(classifyTimeout({ error: '请求超时（30000ms）', httpStatus: 502 }), 'gateway');
  assert.equal(classifyTimeout({ error: '请求超时（30000ms）', httpStatus: 503 }), 'gateway');
  assert.equal(classifyTimeout({ error: '请求超时（30000ms）', httpStatus: 504 }), 'gateway');
});

test('classifyTimeout：超时按阶段分 connect / first-token / mid-stream', () => {
  // 没有响应头、没有正文、没有分片 → 连接阶段
  assert.equal(classifyTimeout({ error: '请求超时（30000ms）', latencyMs: 30000 }), 'connect');
  // 已拿到响应头（有 httpStatus）但没出正文 → 首字阶段
  assert.equal(classifyTimeout({ error: '请求超时（30000ms）', httpStatus: 200 }), 'first-token');
  assert.equal(classifyTimeout({ error: '请求超时（30000ms）', phase: 'before-first-byte', httpStatus: 200 }), 'first-token');
  // 出过正文/分片 → 流中阶段
  assert.equal(classifyTimeout({ error: '请求超时（30000ms）', ttftMs: 1200 }), 'mid-stream');
  assert.equal(classifyTimeout({ error: '请求超时（30000ms）', chunks: 3, lastChunkAtMs: 20000 }), 'mid-stream');
  assert.equal(classifyTimeout({ error: '请求超时（30000ms）', phase: 'streaming' }), 'mid-stream');
});

test('classifyTimeout：非超时文案返回 unknown，不硬塞进超时统计', () => {
  assert.equal(classifyTimeout({ error: '流在完成标记前结束（HTTP 200，未收到 finishReason）' }), 'unknown');
  assert.equal(classifyTimeout({ error: '网络错误：fetch failed' }), 'unknown');
  assert.equal(classifyTimeout({}), 'unknown');
});

test('percentile：nearest-rank，n=1 时各分位相等，空数组 undefined', () => {
  assert.equal(percentile([], 50), undefined);
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 95), 42);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
});

test('latencyStats：空数组只有 n=0，有值时 p50/p95/max 正确', () => {
  assert.deepEqual(latencyStats([]), { n: 0 });
  assert.deepEqual(latencyStats([5, 1, 3]), { n: 3, p50: 3, p95: 5, max: 5 });
});

test('summarizeTransport：超时率分母排除取消，分位数只统计成功完成', () => {
  const s = summarizeTransport([
    { latencyMs: 1000, ttftMs: 200 },
    { latencyMs: 2000, ttftMs: 300 },
    { error: '请求超时（30000ms）', timedOut: true },
    { error: '流在完成标记前结束（HTTP 200，未收到 finishReason）' },
    { cancelled: true },
  ]);
  assert.equal(s.initiated, 5);
  assert.equal(s.cancelled, 1);
  assert.equal(s.completed, 2);
  assert.equal(s.timedOut, 1);
  assert.equal(s.failed, 1);
  // 1 / (5 - 1)
  assert.equal(s.timeoutRate, 0.25);
  assert.deepEqual(s.latency, { n: 2, p50: 1000, p95: 2000, max: 2000 });
  assert.deepEqual(s.ttft, { n: 2, p50: 200, p95: 300, max: 300 });
});

test('summarizeTransport：全部取消时超时率 0，不出现 NaN', () => {
  const s = summarizeTransport([{ cancelled: true }, { cancelled: true }]);
  assert.equal(s.initiated, 2);
  assert.equal(s.cancelled, 2);
  assert.equal(s.timeoutRate, 0);
  assert.equal(s.latency.n, 0);
});
