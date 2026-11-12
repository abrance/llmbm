import assert from 'node:assert/strict';
import test from 'node:test';
import type { EndpointConfig } from '@llmbm/core';
import type { BankQuestion } from '../data/bank.ts';
import { chatOnce, fetchModels, prepareChatRequest } from './transport.ts';

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

test('chatOnce：HTTP 200 但没有 finishReason 视为流断，保留正文并报错', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"半截回答"}}]}',
    'data: [DONE]',
  ].join('\n');

  const out = await chatOnce(OPENAI, question(), options(), fetchOnce(sseResponse(frames)));

  assert.equal(out.text, '半截回答');
  assert.equal(out.finishReason, undefined);
  assert.match(out.error ?? '', /流在完成标记前结束/);
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

test('工具题：OpenAI 兼容下 tools 原样透传（core 契约暂缺 tools 字段）', () => {
  const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];
  const { request } = prepareChatRequest(OPENAI, [{ role: 'user', content: '查天气' }], { tools });
  const body = JSON.parse(request.body) as Record<string, unknown>;
  assert.deepEqual(body['tools'], tools);
});

test('工具题：anthropic 不猜工具声明形状，等 core 扩展 ChatRequest.tools', () => {
  const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];
  const { request } = prepareChatRequest(ANTHROPIC, [{ role: 'user', content: '查天气' }], { tools });
  const body = JSON.parse(request.body) as Record<string, unknown>;
  assert.equal(body['tools'], undefined);
});
