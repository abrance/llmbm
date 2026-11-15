/**
 * Mock 端点 E2E：真实 http server + 真实流式读取，验证「可复现故障注入」与超时归因。
 * 覆盖验收要求的 slow-first（首字慢但最终成功）与 stall（流式中段卡死）。
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { EndpointConfig } from '@llmbm/core';
import { createMockHandler } from '../../mock/handler.ts';
import type { BankQuestion } from '../data/bank.ts';
import { chatOnce } from './transport.ts';

async function startMock(): Promise<{ server: Server; endpoint: EndpointConfig }> {
  const handler = createMockHandler();
  const server = createServer((req, res) => {
    handler(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    endpoint: {
      baseUrl: `http://127.0.0.1:${port}/__mock/v1`,
      apiKey: '',
      model: 'mock-llmbm-pro',
      protocol: 'openai',
    },
  };
}

function question(overrides: Partial<BankQuestion>): BankQuestion {
  return {
    id: 'timeout-ttft-001',
    group: 'timeout',
    judge: 'exact',
    prompt: '只回复 ok',
    ...overrides,
  } as BankQuestion;
}

function options(fault: string) {
  return { signal: new AbortController().signal, sampleIndex: 0, injectFlaky: false, fault };
}

test('mock slow-first：首字超过 3 秒但正文完整返回，TTFT 与分片数都采到', async (t) => {
  const { server, endpoint } = await startMock();
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const out = await chatOnce(endpoint, question({ id: 'timeout-ttft-001', timeoutMs: 20000 }), options('slow-first'));

  assert.equal(out.error, undefined);
  assert.equal(out.text, 'OK');
  assert.equal(out.phase, 'done');
  assert.ok((out.ttftMs ?? 0) >= 3000, `TTFT 应体现首字慢，实际 ${out.ttftMs}`);
  assert.ok((out.chunks ?? 0) > 1, '应分片返回');
});

test('mock stall：HTTP 200 停在两片之后，超时带回 phase/chunks/lastChunkAtMs，不重试（已收到正文）', async (t) => {
  const { server, endpoint } = await startMock();
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const out = await chatOnce(endpoint, question({ id: 'timeout-stream-stall-001', timeoutMs: 900 }), options('stall'));

  assert.match(String(out.error), /请求超时/);
  assert.equal(out.phase, 'streaming');
  // 1 片空 delta 帧 + 2 片正文；之后的流停住不关，只能靠超时收口。
  assert.ok((out.chunks ?? 0) >= 2, `应至少收到两片，实际 ${out.chunks}`);
  assert.equal(typeof out.ttftMs, 'number');
  assert.equal(typeof out.lastChunkAtMs, 'number');
  assert.equal(out.attempts, 1);
});

test('mock hang：连接建立了但一个字节都不回，归 connect 且只重试一次', async (t) => {
  const { server, endpoint } = await startMock();
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const out = await chatOnce(endpoint, question({ id: 'timeout-hang-001', timeoutMs: 300 }), options('hang'));

  assert.match(String(out.error), /请求超时/);
  // 没拿到响应头就超时：不带 phase，归 connect（不再冒充「首字前」）。
  assert.equal(out.phase, undefined);
  assert.equal(out.chunks, undefined);
  assert.equal(out.attempts, 2);
  assert.deepEqual(
    out.attemptLog?.map((attempt) => attempt.outcome),
    ['timeout', 'timeout'],
  );
});
