/**
 * /api/proxy 真实流式透传测试（回归：SSE 经代理回来是 200 + content-length: 0 + 空 body）。
 *
 * 为什么不用 app.inject：inject 会把整包缓冲后再交给断言，掩盖「响应头已发出、body 却是空的」
 * 这类问题。这里起真实端口、用真 fetch 打 /api/proxy，按客户端视角断言。
 *
 * 为什么出站那一次 fetch 要打桩：guard.checkTarget 按设计拒绝 loopback/私网目标，
 * 本机起不了「能被 /api/proxy 合法访问」的上游。所以用一个能通过校验的公网地址，
 * 把这一次出站请求接到本机真实 SSE 上游上 —— 路由、Fastify 生命周期、流式传输都是真的，
 * 只有那一次网络跳转被替换。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../app.js';

/** 能被 checkTarget 放行的目标地址；其出站请求在测试里被接到本机上游。 */
const FAKE_UPSTREAM = 'https://api.example.com/v1/chat/completions';

interface Upstream {
  url: string;
  close(): Promise<void>;
}

/** 起一个真实的本机 SSE 上游，发 3 个 data: 帧后结束。 */
async function startSseUpstream(): Promise<Upstream> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (let i = 1; i <= 3; i += 1) res.write(`data: {"chunk":${i}}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/sse`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 起一个真实的本机长连接 SSE 上游（发一帧后不结束），用于验证客户端中断路径。 */
async function startHangingUpstream(): Promise<Upstream> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: 1\n\n');
    // 故意不 end：模拟长连接 SSE
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/sse`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 起一个真实的本机 500 上游，返回 JSON 错误体。 */
async function startErrorUpstream(): Promise<Upstream> {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json', 'x-request-id': 'up-500' });
    res.end(JSON.stringify({ error: { message: 'upstream boom' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * 只把发往 FAKE_UPSTREAM 的那一次出站请求改接到本机上游；其余 fetch（含测试客户端
 * 打 /api/proxy 的那次）原样透传。返回还原函数。
 */
function routeUpstreamTo(localUrl: string): () => void {
  const realFetch = globalThis.fetch;
  const stub: typeof fetch = (input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (target === FAKE_UPSTREAM) return realFetch(localUrl, init);
    return realFetch(input, init);
  };
  globalThis.fetch = stub;
  return () => {
    globalThis.fetch = realFetch;
  };
}

test('api: 代理把 SSE 流原样透传给客户端（不是 200 + 空 body）', async () => {
  const upstream = await startSseUpstream();
  const restore = routeUpstreamTo(upstream.url);
  const { app, close } = await buildApp();
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/api/proxy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: FAKE_UPSTREAM,
        headers: { authorization: 'Bearer test-key' },
        body: { stream: true },
      }),
    });

    assert.equal(res.status, 200, '状态码应原样透传');
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    // 回归点：修复前这里恒为 '0'，body 为空
    assert.equal(res.headers.get('content-length'), null, '流式响应不应带 content-length');

    const body = await res.text();
    for (const i of [1, 2, 3]) {
      assert.ok(body.includes(`data: {"chunk":${i}}`), `应收到第 ${i} 个 data: 帧，实际 body=${JSON.stringify(body)}`);
    }
  } finally {
    await close();
    restore();
    await upstream.close();
  }
});

test('api: 流式响应被客户端中断后并发闸门会释放', async () => {
  // 回归：hijack + 长流不触发 onResponse，闸门若不兜底，8 次中断后全站 429
  const upstream = await startHangingUpstream();
  const restore = routeUpstreamTo(upstream.url);
  const { app, close } = await buildApp();
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const aborted = 10; // > DEFAULTS.maxConcurrency(8)，泄漏就会卡住
    for (let i = 0; i < aborted; i += 1) {
      const controller = new AbortController();
      const res = await fetch(`${base}/api/proxy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: FAKE_UPSTREAM, headers: {}, body: {} }),
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      await reader.read(); // 至少收到一帧，确保流已开始
      controller.abort();
    }
    await new Promise((resolve) => setTimeout(resolve, 300)); // 等 close 事件传播

    const health = (await (await fetch(`${base}/api/health`)).json()) as { inFlight: number };
    assert.equal(health.inFlight, 0, '中断后闸门必须释放，否则后续请求全部 429');

    const next = await fetch(`${base}/api/proxy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://10.0.0.1/x', headers: {}, body: {} }),
    });
    assert.equal(next.status, 400, '中断风暴后应仍能正常处理请求（400 来自私网拦截，而非 429）');
  } finally {
    await close();
    restore();
    await upstream.close();
  }
});

test('api: 上游 500 原样透传状态码与 body', async () => {
  const upstream = await startErrorUpstream();
  const restore = routeUpstreamTo(upstream.url);
  const { app, close } = await buildApp();
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/api/proxy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: FAKE_UPSTREAM, headers: { authorization: 'Bearer test-key' }, body: {} }),
    });

    assert.equal(res.status, 500, '上游 500 应原样透传，而不是被包装成 502');
    assert.equal(res.headers.get('x-request-id'), 'up-500', '白名单头应透传');
    const body = await res.text();
    assert.match(body, /upstream boom/);
  } finally {
    await close();
    restore();
    await upstream.close();
  }
});
