import assert from 'node:assert/strict';
import test from 'node:test';
import type { EndpointConfig, ToolSpec } from '@llmbm/core';
import { classifyTimeout } from '@llmbm/core';
import type { BankQuestion } from '../data/bank.ts';
import {
  chatOnce,
  fetchModels,
  pingEndpoint,
  prepareChatRequest,
  probeEndpoint,
  tokensPerSecond,
} from './transport.ts';

const OPENAI: EndpointConfig = {
  baseUrl: 'https://relay.example.com',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
  protocol: 'openai',
};

const ANTHROPIC: EndpointConfig = {
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  model: 'claude-sonnet-4-5',
  protocol: 'anthropic',
};

function question(overrides: Partial<BankQuestion> = {}): BankQuestion {
  return {
    id: 'basic-exact-001',
    group: 'basic',
    judge: 'exact',
    prompt: '只回复 ok',
    ...overrides,
  } as BankQuestion;
}

function options() {
  return { signal: new AbortController().signal, sampleIndex: 0, injectFlaky: false };
}

function jsonResponse(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function fetchOnce(response: Response): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

test('请求构造走 core adapter：anthropic 的 system 在顶层、max_tokens 必填', () => {
  const { adapter, request } = prepareChatRequest(
    ANTHROPIC,
    [
      { role: 'system', content: '你是简洁的助手' },
      { role: 'user', content: '只回复 ok' },
    ],
    {},
  );

  assert.equal(adapter.protocol, 'anthropic');
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['x-api-key'], 'sk-ant-test');

  const body = JSON.parse(request.body) as Record<string, unknown>;
  assert.equal(body['system'], '你是简洁的助手');
  assert.equal(typeof body['max_tokens'], 'number');
  assert.deepEqual(body['messages'], [{ role: 'user', content: '只回复 ok' }]);
});

test('chatOnce：OpenAI 兼容 JSON 响应由 core 归一化（text / reasoning / toolCalls / usage）', async () => {
  const response = jsonResponse({
    choices: [
      {
        message: {
          content: '你好',
          reasoning_content: '先想一下',
          tool_calls: [
            {
              id: 'call_1',
              function: { name: 'get_weather', arguments: '{"city":"北京"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });

  const out = await chatOnce(OPENAI, question(), options(), fetchOnce(response));

  assert.equal(out.error, undefined);
  assert.equal(out.text, '你好');
  assert.equal(out.reasoning, '先想一下');
  assert.equal(out.finishReason, 'tool_calls');
  assert.equal(out.toolCalls?.[0]?.name, 'get_weather');
  assert.deepEqual(out.toolCalls?.[0]?.args, { city: '北京' });
  assert.deepEqual(out.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  assert.equal(out.httpStatus, 200);
});

test('chatOnce：anthropic 端点走 anthropic adapter 解析非流式响应', async () => {
  const response = jsonResponse({
    content: [{ type: 'text', text: '好的' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 4 },
  });

  const out = await chatOnce(ANTHROPIC, question(), options(), fetchOnce(response));

  assert.equal(out.error, undefined);
  assert.equal(out.text, '好的');
  assert.equal(out.finishReason, 'end_turn');
});

test('chatOnce：SSE 逐帧交给 core 聚合，tool_calls 参数跨帧拼接', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"查"}}]}',
    'data: {"choices":[{"delta":{"content":"一下"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"北京\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ].join('\n');

  const out = await chatOnce(OPENAI, question(), options(), fetchOnce(sseResponse(frames)));

  assert.equal(out.text, '查一下');
  assert.equal(out.finishReason, 'tool_calls');
  assert.equal(out.toolCalls?.[0]?.name, 'get_weather');
  assert.deepEqual(out.toolCalls?.[0]?.args, { city: '北京' });
  assert.equal(out.error, undefined);
  assert.deepEqual((out.raw as { transport?: string }).transport, 'sse');
});

test('chatOnce：流式响应记下首字延迟、分片数与解码吞吐', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}',
    'data: {"choices":[{"delta":{"content":"你"}}]}',
    'data: {"choices":[{"delta":{"content":"好"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":2}}',
    'data: [DONE]',
  ].join('\n');

  const out = await chatOnce(OPENAI, question(), options(), fetchOnce(sseResponse(frames)));

  assert.equal(out.text, '你好');
  assert.equal(out.error, undefined);
  assert.equal(typeof out.chunks, 'number');
  assert.ok((out.chunks ?? 0) >= 1, '必须记下分片数');
  // 只有出现正文增量才算首字；role 帧不算。
  assert.equal(typeof out.ttftMs, 'number');
  assert.ok((out.ttftMs ?? -1) >= 0);
});

test('tokensPerSecond：按首字之后的耗时算，缺 usage 或耗时为 0 时不给数', () => {
  assert.equal(tokensPerSecond({ completionTokens: 20 }, 1200, 200), 20);
  assert.equal(tokensPerSecond(undefined, 1200, 200), undefined);
  assert.equal(tokensPerSecond({ completionTokens: 5 }, 300, 300), undefined);
  assert.equal(tokensPerSecond({ completionTokens: 0 }, 1200, 200), undefined);
});

test('chatOnce：非流式 JSON 响应不编造首字延迟与吞吐', async () => {
  const json = {
    choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
    usage: { completion_tokens: 2 },
  };
  const out = await chatOnce(OPENAI, question(), options(), fetchOnce(jsonResponse(json)));
  assert.equal(out.ttftMs, undefined);
  assert.equal(out.tokensPerSec, undefined);
});

test('chatOnce：多轮与 max_tokens/temperature 原样进请求体', async () => {
  let body: Record<string, unknown> = {};
  const fake = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return jsonResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    });
  }) as unknown as typeof fetch;

  await chatOnce(
    OPENAI,
    question({
      prompt: '暗号是什么',
      messages: [
        { role: 'user', content: '记住暗号 ORANGE-9' },
        { role: 'assistant', content: '已记住' },
        { role: 'user', content: '暗号是什么' },
      ],
      request: { temperature: 0, maxTokens: 16 },
    } as Partial<BankQuestion>),
    options(),
    fake,
  );

  assert.equal((body['messages'] as unknown[]).length, 3, '多轮题必须把整段历史发出去');
  assert.equal(body['max_tokens'], 16);
  assert.equal(body['temperature'], 0);
});

test('chatOnce：图片题按协议把图片分片塞进最后一条 user', async () => {
  let body: Record<string, unknown> = {};
  const fake = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return jsonResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: '蓝' }, finish_reason: 'stop' }],
    });
  }) as unknown as typeof fetch;

  await chatOnce(
    OPENAI,
    question({ image: { mimeType: 'image/png', dataBase64: 'QUJD' } } as Partial<BankQuestion>),
    options(),
    fake,
  );

  const messages = body['messages'] as Array<{ content: unknown }>;
  const content = messages[messages.length - 1]?.content as Array<{ type: string; image_url?: { url: string } }>;
  assert.ok(Array.isArray(content), '图片题 content 必须是分片数组');
  assert.equal(content[content.length - 1]?.type, 'image_url');
  assert.match(content[content.length - 1]?.image_url?.url ?? '', /^data:image\/png;base64,QUJD$/);
});

test('chatOnce：HTTP 200 但没有 finishReason 视为流断，保留正文并报错', async () => {
  const frames = ['data: {"choices":[{"delta":{"content":"半截回答"}}]}', 'data: [DONE]'].join('\n');

  const out = await chatOnce(OPENAI, question(), options(), fetchOnce(sseResponse(frames)));

  assert.equal(out.text, '半截回答');
  assert.equal(out.finishReason, undefined);
  assert.match(out.error ?? '', /流在完成标记前结束/);
  // 断流也保留进度：断在「已收到正文」这一段，而不是冒充正常结束。
  assert.equal(out.phase, 'streaming');
  assert.equal(out.chunks, 1);
});

test('chatOnce：429/5xx 退避重试，第二次成功', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('busy', { status: 500, headers: { 'retry-after': '0' } });
    }
    return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  }) as unknown as typeof fetch;

  const out = await chatOnce(OPENAI, question(), options(), fetchImpl);

  assert.equal(calls, 2);
  assert.equal(out.text, 'ok');
  assert.equal(out.httpStatus, 200);
});

test('fetchModels：mock 端点用 core 的 buildModelsRequest', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return jsonResponse({ data: [{ id: 'mock-llmbm-pro' }, { id: 'mock-llmbm-lite' }] });
  }) as unknown as typeof fetch;

  const list = await fetchModels(
    { baseUrl: '/__mock/v1', apiKey: 'mock-key', model: 'mock-llmbm-pro', protocol: 'openai' },
    fetchImpl,
  );

  assert.deepEqual(seen, ['/__mock/v1/models']);
  assert.deepEqual(list, ['mock-llmbm-pro', 'mock-llmbm-lite']);
});

test('工具题：OpenAI 兼容下 tools 由 core 原样透传', () => {
  const tools: ToolSpec[] = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];
  const { request } = prepareChatRequest(OPENAI, [{ role: 'user', content: '查天气' }], { tools });
  const body = JSON.parse(request.body) as Record<string, unknown>;
  assert.deepEqual(body['tools'], tools);
});

test('工具题：anthropic 由 core 映射为 input_schema', () => {
  const tools: ToolSpec[] = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];
  const { request } = prepareChatRequest(ANTHROPIC, [{ role: 'user', content: '查天气' }], { tools });
  const body = JSON.parse(request.body) as Record<string, unknown>;
  assert.deepEqual(body['tools'], [{ name: 'get_weather', input_schema: { type: 'object' } }]);
});

test('工具题：gemini 由 core 映射为 functionDeclarations', () => {
  const tools: ToolSpec[] = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];
  const gemini: EndpointConfig = {
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: 'gemini-key',
    model: 'gemini-2.5-pro',
    protocol: 'gemini',
  };
  const { request } = prepareChatRequest(gemini, [{ role: 'user', content: '查天气' }], { tools });
  const body = JSON.parse(request.body) as Record<string, unknown>;
  assert.deepEqual(body['tools'], [
    { functionDeclarations: [{ name: 'get_weather', parameters: { type: 'object' } }] },
  ]);
});

test('连通性测试：推理模型把 token 全用在 reasoning 上，不应判「响应没有正文」', async () => {
  const response = jsonResponse({
    choices: [
      {
        message: { content: '', reasoning_content: '用户在让我只回复 ok，我先想一下' },
        finish_reason: 'length',
      },
    ],
    usage: { prompt_tokens: 6, completion_tokens: 8 },
  });

  const out = await pingEndpoint(OPENAI, fetchOnce(response));
  assert.match(out.sample, /推理/);
  assert.equal(out.latencyMs >= 0, true);
});

test('连通性测试：正文真的为空时仍要失败，并带上 finish_reason', async () => {
  const response = jsonResponse({
    choices: [{ message: { content: '' }, finish_reason: 'stop' }],
  });

  await assert.rejects(
    () => pingEndpoint(OPENAI, fetchOnce(response)),
    (err: Error) => /正文\/推理\/工具调用全为空/.test(err.message) && /finish_reason=stop/.test(err.message),
  );
});

test('thinking 模式要求回传 reasoning_content：命中该报错补一次空值重试，第二次成功即算通', async () => {
  let calls = 0;
  const bodies: Record<string, unknown>[] = [];
  const fetchStub = (async (_url: string, init?: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { messages: Record<string, unknown>[] };
    bodies.push(body as unknown as Record<string, unknown>);
    const assistant = body.messages.find((m) => m['role'] === 'assistant');
    if (assistant && assistant['reasoning_content'] === undefined) {
      return jsonResponse(
        {
          error: {
            message: 'The `reasoning_content` in the thinking mode must be passed back to the API.',
            type: 'invalid_request_error',
          },
        },
        400,
      );
    }
    return jsonResponse({ choices: [{ message: { content: '408' }, finish_reason: 'stop' }] });
  }) as unknown as typeof fetch;

  const out = await chatOnce(
    OPENAI,
    question({
      prompt: '两轮',
      messages: [
        { role: 'user', content: '3 乘 4 是多少？' },
        { role: 'assistant', content: '12' },
        { role: 'user', content: '把结果再乘 34' },
      ],
    }),
    options(),
    fetchStub,
  );

  assert.equal(calls, 2);
  assert.equal(out.error, undefined);
  assert.equal(out.text, '408');
  const retried = (bodies[1]?.['messages'] as Record<string, unknown>[]).find((m) => m['role'] === 'assistant');
  assert.equal(retried?.['reasoning_content'], '');
});

test('兼容重试只做一次：补了 reasoning_content 仍被 400 拒绝就不再重试', async () => {
  let calls = 0;
  const fetchStub = (async () => {
    calls += 1;
    return jsonResponse(
      { error: { message: 'reasoning_content must be passed back', type: 'invalid_request_error' } },
      400,
    );
  }) as unknown as typeof fetch;

  const out = await chatOnce(
    OPENAI,
    question({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    }),
    options(),
    fetchStub,
  );

  assert.equal(calls, 2);
  assert.equal(out.httpStatus, 400);
  assert.match(String(out.error), /HTTP 400/);
});

test('预检探针把账户类错误原样带回来（带 httpStatus 供定性）', async () => {
  // 429 会被重试，响应体每次要新的 Response 实例
  const fetchStub = (async () =>
    jsonResponse({ error: { message: 'insufficient_quota' } }, 429)) as unknown as typeof fetch;
  const probe = await probeEndpoint(OPENAI, fetchStub);
  assert.equal(probe.httpStatus, 429);
  assert.match(String(probe.error), /insufficient_quota/);
});

/* --------------------------------------------------- 超时保留进度 / attempt 明细 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 按片返回的 SSE 响应；`stalling` 时最后一帧之后永不关闭（模拟流式中段卡死）。 */
function timedSse(parts: { text: string; delayMs?: number }[], stalling = false): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const part = parts[index];
      if (!part) {
        if (stalling) return;
        controller.close();
        return;
      }
      index += 1;
      if (part.delayMs) await sleep(part.delayMs);
      controller.enqueue(encoder.encode(part.text));
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const SSE_DONE = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

test('流式中段卡死超时：回传 ttftMs / chunks / lastChunkAtMs / phase，不把已收进度丢掉', async () => {
  const res = timedSse(
    [
      { text: 'data: {"choices":[{"delta":{"content":"前半段"}}]}\n\n' },
      { text: 'data: {"choices":[{"delta":{"content":"后半段"}}]}\n\n' },
    ],
    true,
  );
  const out = await chatOnce(
    OPENAI,
    question({ id: 'timeout-stream-stall-001', timeoutMs: 150 }),
    options(),
    fetchOnce(res),
  );

  assert.match(String(out.error), /请求超时（150ms）/);
  assert.equal(out.phase, 'streaming');
  assert.equal(out.chunks, 2);
  assert.equal(typeof out.ttftMs, 'number');
  assert.equal(typeof out.lastChunkAtMs, 'number');
  assert.equal(out.attempts, 1);
  assert.deepEqual(
    out.attemptLog?.map((a) => a.outcome),
    ['timeout'],
  );
});

test('首字前挂起：只在没收到任何字节时才重试一次，attempt 明细保留两次超时', async () => {
  let calls = 0;
  const fetchStub = (async () => {
    calls += 1;
    return timedSse([], true);
  }) as unknown as typeof fetch;

  const out = await chatOnce(OPENAI, question({ id: 'timeout-hang-001', timeoutMs: 60 }), options(), fetchStub);

  assert.equal(calls, 2);
  assert.match(String(out.error), /请求超时/);
  assert.equal(out.phase, 'before-first-byte');
  assert.equal(out.chunks, 0);
  assert.equal(out.ttftMs, undefined);
  assert.equal(out.attempts, 2);
  assert.deepEqual(
    out.attemptLog?.map((a) => a.outcome),
    ['timeout', 'timeout'],
  );
});

test('连不上就超时：不带 phase/chunks，归因落 connect 而不是「首字前」', async () => {
  // 模拟 DNS/TLS/连不上：fetch 一直不返回，直到 abort。
  const fetchStub = (async (_url: string, init: RequestInit) => {
    await new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
        once: true,
      });
    });
  }) as unknown as typeof fetch;

  const out = await chatOnce(OPENAI, question({ id: 'timeout-hang-002', timeoutMs: 60 }), options(), fetchStub);

  assert.match(String(out.error), /请求超时/);
  assert.equal(out.phase, undefined);
  assert.equal(out.chunks, undefined);
  assert.equal(classifyTimeout({ error: out.error, httpStatus: out.httpStatus, phase: out.phase }), 'connect');
});

test('首字帧被网络分片切开：仍然认得出首字', async () => {
  const res = timedSse([
    { text: 'data: {"choices":[{"delta":{"cont' },
    { text: 'ent":"你好"}}]}\n\n', delayMs: 40 },
    { text: SSE_DONE },
  ]);
  const out = await chatOnce(OPENAI, question(), options(), fetchOnce(res));

  assert.equal(out.error, undefined);
  assert.equal(out.phase, 'done');
  assert.equal(typeof out.ttftMs, 'number');
});

test('心跳与空 role 帧不算首字：TTFT 从第一个正文增量算起', async () => {
  const res = timedSse([
    { text: 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' },
    { text: 'data: {"choices":[{"delta":{"content":""}}]}\n\n', delayMs: 70 },
    { text: 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n', delayMs: 70 },
    { text: SSE_DONE },
  ]);
  const out = await chatOnce(OPENAI, question(), options(), fetchOnce(res));

  assert.equal(out.error, undefined);
  assert.equal(out.phase, 'done');
  assert.equal(typeof out.ttftMs, 'number');
  assert.ok((out.ttftMs as number) >= 110, `TTFT 应至少跨过两帧延迟，实际 ${out.ttftMs}`);
  assert.equal(out.chunks, 4);
});

test('429 重试后成功：逻辑采样成功，但 attempt 明细保留第一次的限流', async () => {
  let calls = 0;
  const fetchStub = (async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: { message: 'slow down' } }, 429);
    return jsonResponse({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }) as unknown as typeof fetch;

  const out = await chatOnce(OPENAI, question(), options(), fetchStub);

  assert.equal(out.error, undefined);
  assert.equal(out.text, 'ok');
  assert.equal(out.attempts, 2);
  assert.deepEqual(
    out.attemptLog?.map((a) => a.outcome),
    ['retryable', 'success'],
  );
  assert.equal(out.attemptLog?.[0]?.httpStatus, 429);
});
