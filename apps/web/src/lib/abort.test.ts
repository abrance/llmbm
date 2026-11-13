import assert from 'node:assert/strict';
import test from 'node:test';
import { CONSECUTIVE_FAILURE_LIMIT, FailureGuard } from './abort.ts';

test('致命状态码第一次命中就短路', () => {
  const guard = new FailureGuard();
  assert.match(String(guard.note({ httpStatus: 401, error: 'HTTP 401：invalid api key' })), /HTTP 401/);
});

test('402/403/404 同属致命', () => {
  for (const status of [402, 403, 404]) {
    assert.match(String(new FailureGuard().note({ httpStatus: status, error: `HTTP ${status}` })), /换题重试不会恢复/);
  }
});

test('单次 400 不短路；连续 400 达到阈值才短路', () => {
  const guard = new FailureGuard();
  assert.equal(guard.note({ httpStatus: 400, error: 'HTTP 400：bad request' }), undefined);
  assert.equal(guard.note({ httpStatus: 400, error: 'HTTP 400：bad request' }), undefined);
  assert.match(String(guard.note({ httpStatus: 400, error: 'HTTP 400：bad request' })), /请求本身不被接受/);
});

test('连续传输失败达到阈值才短路，中间一次成功即归零', () => {
  const guard = new FailureGuard();
  assert.equal(guard.note({ error: '请求超时（30000ms）' }), undefined);
  assert.equal(guard.note({ error: '请求超时（30000ms）' }), undefined);
  assert.equal(guard.note({}), undefined);
  for (let i = 0; i < CONSECUTIVE_FAILURE_LIMIT - 1; i++) {
    assert.equal(guard.note({ error: '网络错误：ECONNRESET' }), undefined);
  }
  assert.match(String(guard.note({ error: '网络错误：ECONNRESET' })), /连续 3 次采样传输失败/);
});

test('首次 5xx 不判致命，按连续失败累计', () => {
  assert.equal(new FailureGuard().note({ httpStatus: 503, error: 'HTTP 503' }), undefined);
});
