import assert from 'node:assert/strict';
import test from 'node:test';
import { CONSECUTIVE_FAILURE_LIMIT, FailureGuard, toleratedNotices } from './abort.ts';

test('账户/鉴权类第一次命中就终止整卷', () => {
  for (const status of [401, 402, 403]) {
    const reason = new FailureGuard().note({ httpStatus: status, error: `HTTP ${status}：x` });
    assert.match(String(reason), /HTTP 40[123]/);
    assert.match(String(reason), /额度\/订阅\/Key/);
  }
});

test('404 当配置错：一次即终止', () => {
  assert.match(String(new FailureGuard().note({ httpStatus: 404, error: 'HTTP 404：model not found' })), /模型名/);
});

test('欠费/订阅过期塞在别的状态码里也按账户类终止', () => {
  const cases = [
    { httpStatus: 429, error: 'HTTP 429：insufficient_quota' },
    { httpStatus: 400, error: 'HTTP 400：余额不足，请充值' },
    { httpStatus: 500, error: 'HTTP 500：subscription expired' },
  ];
  for (const c of cases) {
    assert.match(String(new FailureGuard().note(c)), /额度\/订阅\/Key/, JSON.stringify(c));
  }
});

test('请求形状被拒（400/422）不终止整卷，只计入被拒次数', () => {
  const guard = new FailureGuard();
  const reasoning = 'HTTP 400：{"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API."}}';
  for (let i = 0; i < 20; i++) {
    assert.equal(guard.note({ httpStatus: 400, error: reasoning }), undefined);
  }
  assert.equal(guard.note({ httpStatus: 422, error: 'HTTP 422：bad schema' }), undefined);
  const t = guard.tolerated();
  assert.equal(t.rejected, 21);
  assert.deepEqual(t.rejectedStatuses, [400, 422]);
  assert.match(String(t.lastRejected), /422/);
});

test('偶发瞬时失败被容忍，连续达到阈值才判端点不可用；中间有响应即归零', () => {
  const guard = new FailureGuard();
  for (let i = 0; i < 2; i++) assert.equal(guard.note({ error: '请求超时（30000ms）' }), undefined);
  assert.equal(guard.note({}), undefined);
  for (let i = 0; i < CONSECUTIVE_FAILURE_LIMIT - 1; i++) {
    assert.equal(guard.note({ error: '网络错误：ECONNRESET' }), undefined);
  }
  assert.match(String(guard.note({ error: '网络错误：ECONNRESET' })), /连续 5 次采样/);
});

test('5xx 单次不终止，连续才终止', () => {
  const guard = new FailureGuard();
  assert.equal(guard.note({ httpStatus: 503, error: 'HTTP 503' }), undefined);
  assert.equal(guard.note({ error: 'HTTP 502：bad gateway' }), undefined);
});

test('可容忍失败说明：请求被拒与瞬时失败分别成句，数字对得上', () => {
  const guard = new FailureGuard();
  guard.note({ httpStatus: 400, error: 'HTTP 400：reasoning_content must be passed back' });
  guard.note({ httpStatus: 400, error: 'HTTP 400：reasoning_content must be passed back' });
  guard.note({ error: '请求超时（30000ms）' });
  guard.note({ error: '请求超时（30000ms）' });
  const notices = toleratedNotices(guard.tolerated(), { errors: 4, samples: 192 });
  assert.equal(notices.length, 2);
  assert.match(notices[0] as string, /2 次采样被端点以 HTTP 400 拒绝/);
  assert.match(notices[0] as string, /reasoning_content/);
  assert.match(notices[1] as string, /2 次采样是超时\/网络\/5xx 失败/);
});
