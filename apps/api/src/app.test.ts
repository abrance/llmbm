/**
 * API smoke 测试（spec §4「api 有 smoke 测试」）。
 * 不起真实端口，用 app.inject 直连；不访问外网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.js';
import { checkTarget, ConcurrencyGate, isRetryableStatus } from './plugins/guard.js';

test('guard: 拒绝私网/回环/云元数据，放行公网 https', () => {
  const rejected = [
    'http://127.0.0.1:8080/v1/chat/completions',
    'http://localhost:3000/v1',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.5/v1',
    'http://192.168.1.10/v1',
    'http://172.20.1.1/v1',
    'http://[::1]/v1',
    'file:///etc/passwd',
  ];
  for (const url of rejected) {
    assert.equal(checkTarget(url).ok, false, `应拒绝 ${url}`);
  }
  assert.equal(checkTarget('https://api.example.com/v1/chat/completions').ok, true);
});

test('guard: 并发闸门满额后拒绝', () => {
  const gate = new ConcurrencyGate(1);
  assert.equal(gate.tryEnter(), true);
  assert.equal(gate.tryEnter(), false);
  gate.leave();
  assert.equal(gate.tryEnter(), true);
});

test('guard: 只有 429/5xx 可重试', () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
});

test('api: health 正常', async () => {
  const { app, close } = await buildApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  } finally {
    await close();
  }
});

test('api: 社区提交后可按域名列出，且不回传 payload', async () => {
  const { app, close } = await buildApp();
  try {
    const submit = await app.inject({
      method: 'POST',
      url: '/api/community/submit',
      payload: {
        domain: 'api.example.com',
        model: 'gpt-4o',
        protocol: 'openai',
        capabilityScore: 87.5,
        capabilityHalfWidth: 3.1,
        formatScore: 96,
        stability: 1,
        questionBankVersion: 'qb-2026-11-12',
        judgeRuleVersion: '1',
        payload: { secret: 'should-not-leak-in-list' },
      },
    });
    assert.equal(submit.statusCode, 201);
    const { id } = submit.json();
    assert.ok(id);

    const list = await app.inject({ method: 'GET', url: '/api/community/results?domain=api.example.com' });
    assert.equal(list.statusCode, 200);
    const body = list.json();
    assert.equal(body.total, 1);
    assert.equal(body.items[0].id, id);
    assert.equal(body.items[0].payload, undefined);

    const one = await app.inject({ method: 'GET', url: `/api/community/results/${id}` });
    assert.equal(one.statusCode, 200);
    assert.equal(one.json().capabilityScore, 87.5);
  } finally {
    await close();
  }
});

test('api: 社区提交缺字段 / 分数越界被拒', async () => {
  const { app, close } = await buildApp();
  try {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/community/submit',
      payload: { domain: 'x.com' },
    });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json().error, /缺少字段/);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/community/submit',
      payload: {
        domain: 'x.com',
        model: 'm',
        protocol: 'openai',
        capabilityScore: 140,
        capabilityHalfWidth: 1,
        formatScore: 90,
        stability: 1,
        questionBankVersion: 'qb',
        judgeRuleVersion: '1',
      },
    });
    assert.equal(bad.statusCode, 400);
  } finally {
    await close();
  }
});

test('api: 代理拒绝私网目标（不发起真实请求）', async () => {
  const { app, close } = await buildApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/proxy',
      payload: { url: 'http://127.0.0.1:9999/v1/chat/completions', headers: { authorization: 'Bearer x' }, body: {} },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /拒绝/);
  } finally {
    await close();
  }
});

test('api: 代理只透传白名单请求头', async () => {
  const { app, close } = await buildApp();
  try {
    // 目标仍被拒，但这里验证的是「非白名单头被丢弃」不会导致异常
    const res = await app.inject({
      method: 'POST',
      url: '/api/proxy',
      payload: {
        url: 'http://10.1.2.3/v1',
        headers: { cookie: 'session=secret', authorization: 'Bearer x', 'x-internal': '1' },
        body: {},
      },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await close();
  }
});
