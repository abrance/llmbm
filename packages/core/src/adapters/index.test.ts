import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProtocol, getAdapter, isFatalStatus, isRetryable, PROTOCOLS, resolveAdapter } from './index.js';
import { classifyFailure } from '../failure.js';
import { openaiAdapter } from './openai.js';

test('getAdapter：三家都能取到且 protocol 自洽', () => {
  for (const p of PROTOCOLS) {
    assert.equal(getAdapter(p).protocol, p);
  }
});

test('getAdapter：未知协议抛错，不返回 undefined 让调用方晚崩', () => {
  assert.throws(() => getAdapter('cohere' as never), /未知协议/);
});

test('detectProtocol：按 baseUrl 特征', () => {
  assert.equal(detectProtocol('https://api.anthropic.com'), 'anthropic');
  assert.equal(detectProtocol('https://generativelanguage.googleapis.com'), 'gemini');
  assert.equal(detectProtocol('https://api.openai.com/v1'), 'openai');
});

test('detectProtocol：按模型名前缀', () => {
  assert.equal(detectProtocol('https://relay.example.com', 'claude-sonnet-4'), 'anthropic');
  assert.equal(detectProtocol('https://relay.example.com', 'gemini-2.5-pro'), 'gemini');
  assert.equal(detectProtocol('https://relay.example.com', 'gpt-4o'), 'openai');
});

test('detectProtocol：无从判断时默认 openai（兼容中转站最常见）', () => {
  assert.equal(detectProtocol('https://relay.example.com'), 'openai');
  assert.equal(detectProtocol(''), 'openai');
});

test('resolveAdapter：显式 protocol 优先于推断', () => {
  const cfg = { baseUrl: 'https://api.openai.com', apiKey: 'k', model: 'gpt-4o', protocol: 'gemini' as const };
  assert.equal(resolveAdapter(cfg).protocol, 'gemini');
  assert.equal(resolveAdapter({ ...cfg, protocol: undefined }).protocol, 'openai');
});

test('isFatalStatus：鉴权/额度/模型名错误一次即短路，400/422 不算', () => {
  for (const status of [401, 402, 403, 404]) assert.equal(isFatalStatus(status), true);
  for (const status of [400, 408, 422, 429, 500, 503, 200]) assert.equal(isFatalStatus(status), false);
});

test('isRetryable：429/408/5xx 可重试，其余 4xx 不可', () => {
  assert.equal(isRetryable(429), true);
  assert.equal(isRetryable(408), true);
  assert.equal(isRetryable(500), true);
  assert.equal(isRetryable(503), true);
  assert.equal(isRetryable(400), false);
  assert.equal(isRetryable(401), false);
  assert.equal(isRetryable(404), false);
  assert.equal(isRetryable(200), false);
});

test('classifyFailure：账户/配置/请求形状/瞬时四类分得清', () => {
  assert.equal(classifyFailure({ httpStatus: 401, error: 'HTTP 401' }), 'account');
  assert.equal(classifyFailure({ httpStatus: 402, error: 'HTTP 402' }), 'account');
  assert.equal(classifyFailure({ httpStatus: 403, error: 'HTTP 403' }), 'account');
  assert.equal(classifyFailure({ httpStatus: 404, error: 'HTTP 404：model not found' }), 'config');
  assert.equal(classifyFailure({ httpStatus: 429, error: 'HTTP 429：insufficient_quota' }), 'account');
  assert.equal(classifyFailure({ httpStatus: 400, error: 'HTTP 400：余额不足' }), 'account');
  assert.equal(
    classifyFailure({ httpStatus: 400, error: 'HTTP 400：{"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API."}}' }),
    'request',
  );
  assert.equal(classifyFailure({ httpStatus: 422, error: 'HTTP 422' }), 'request');
  assert.equal(classifyFailure({ httpStatus: 429, error: 'HTTP 429：rate limited' }), 'transient');
  assert.equal(classifyFailure({ httpStatus: 503, error: 'HTTP 503' }), 'transient');
  assert.equal(classifyFailure({ error: '请求超时（30000ms）' }), 'transient');
});

test('openai 适配器：assistant 历史带 reasoningContent 时原样透传', () => {
  const request = openaiAdapter.buildChatRequest(
    {
      model: 'deepseek-reasoner',
      messages: [
        { role: 'user', content: '3 乘 4' },
        { role: 'assistant', content: '12', reasoningContent: '先算乘法' },
        { role: 'user', content: '再乘 34' },
      ],
    },
    { baseUrl: 'https://relay.example.com', apiKey: 'k', model: 'deepseek-reasoner' },
  );
  const body = JSON.parse(request.body) as { messages: Record<string, unknown>[] };
  assert.equal(body.messages[1]?.['reasoning_content'], '先算乘法');
  assert.equal('reasoning_content' in (body.messages[0] as object), false);
});
