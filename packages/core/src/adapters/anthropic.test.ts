import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicAdapter } from './anthropic.js';
import { assertTruncated, collect, feed, firstCall, textOf, types } from './testing.js';

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}`;

/* 1. 正常流 */
test('anthropic 正常流：content_block_delta → message_delta(stop_reason) → message_stop', () => {
  const lines = [
    'event: message_start',
    frame({ type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } }),
    'event: content_block_start',
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '42' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' 是答案' } }),
    frame({ type: 'content_block_stop', index: 0 }),
    frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
    frame({ type: 'message_stop' }),
  ];
  const events = feed(anthropicAdapter, lines);
  assert.deepEqual(types(events), ['usage', 'text', 'text', 'usage', 'done:end_turn', 'done']);
  assert.equal(textOf(events), '42 是答案');

  const res = collect(anthropicAdapter, lines, 200);
  assert.equal(res.text, '42 是答案');
  assert.equal(res.finishReason, 'end_turn');
  assert.deepEqual(res.usage, { promptTokens: 12, completionTokens: 4, totalTokens: 16 });
});

/* 2. reasoning 帧 */
test('anthropic reasoning 帧：thinking_delta 进 reasoning，不混正文', () => {
  const lines = [
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先想一下' } }),
    frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '答案' } }),
    frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
  ];
  const res = collect(anthropicAdapter, lines);
  assert.equal(res.reasoning, '先想一下');
  assert.equal(res.text, '答案');
});

/* 3. tool_calls 增量 */
test('anthropic tool_use：content_block_start 给 name，input_json_delta 逐片拼参数', () => {
  const lines = [
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city"' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':"北京"}' } }),
    frame({ type: 'content_block_stop', index: 0 }),
    frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
  ];
  const res = collect(anthropicAdapter, lines);
  assert.equal(res.toolCalls?.length, 1);
  assert.equal(firstCall(res).name, 'get_weather');
  assert.equal(firstCall(res).id, 'toolu_1');
  assert.deepEqual(firstCall(res).args, { city: '北京' });
  assert.equal(res.finishReason, 'tool_use');
});

test('anthropic input_json_delta 半截参数：保留 rawArguments 不抛错', () => {
  const res = collect(anthropicAdapter, [
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'f' } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } }),
  ]);
  assert.equal(firstCall(res).args, undefined);
  assert.equal(firstCall(res).rawArguments, '{"a":');
});

/* 4. 未知帧 */
test('anthropic 未知帧：ping / event 行 / 非 JSON 都忽略且不吞正文', () => {
  const lines = [
    'event: ping',
    frame({ type: 'ping' }),
    'data: {oops',
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A' } }),
    frame({ type: 'some_future_event', payload: 1 }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'B' } }),
    frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
  ];
  const events = feed(anthropicAdapter, lines);
  assert.equal(events.some((e) => e.type === 'error'), false);
  assert.equal(textOf(events), 'AB');
});

test('anthropic error 事件：映射成 error', () => {
  const events = feed(anthropicAdapter, [frame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })]);
  assert.deepEqual(events, [{ type: 'error', error: 'Overloaded' }]);
});

/* 5. HTTP 200 但无完成标记 */
test('anthropic 流断但 HTTP 200：只有 message_stop 没有 stop_reason → 未完成', () => {
  const lines = [
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半句' } }),
    frame({ type: 'message_stop' }),
  ];
  const res = collect(anthropicAdapter, lines, 200);
  assert.equal(res.text, '半句');
  assertTruncated(res);
});

/* 请求体 */
test('anthropic buildChatRequest：system 提到顶层、max_tokens 必填、x-api-key + version', () => {
  const req = anthropicAdapter.buildChatRequest(
    {
      model: 'claude-sonnet-4',
      messages: [
        { role: 'system', content: '你是评测助手' },
        { role: 'user', content: 'hi' },
      ],
      jsonMode: true,
    },
    { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant', model: 'claude-sonnet-4' },
  );
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.headers['x-api-key'], 'sk-ant');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(req.body) as Record<string, unknown>;
  assert.equal(typeof body.max_tokens, 'number', 'max_tokens 必填，缺省要补');
  assert.equal(body.system, '你是评测助手\n\nOnly reply with a single JSON object, no prose and no markdown fence.');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }], 'system 不得留在 messages 里');
  assert.equal(body.stream, true);
});

test('anthropic buildChatRequest：tools 映射为 {name, description, input_schema}', () => {
  const req = anthropicAdapter.buildChatRequest(
    {
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: '查天气' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '查天气',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        },
      ],
    },
    { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant', model: 'claude-sonnet-4' },
  );
  const body = JSON.parse(req.body) as Record<string, unknown>;
  assert.deepEqual(body.tools, [
    {
      name: 'get_weather',
      description: '查天气',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  ]);
});

test('anthropic buildChatRequest：tools 缺 parameters 时 input_schema 补 object，缺 description 不写空串', () => {
  const req = anthropicAdapter.buildChatRequest(
    { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'ping' } }] },
    { baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'm' },
  );
  const body = JSON.parse(req.body) as { tools?: Array<Record<string, unknown>> };
  const tools = body.tools ?? [];
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.['description'], undefined, '没有 description 时不得写空串');
  assert.deepEqual(tools, [{ name: 'ping', input_schema: { type: 'object' } }]);
});

test('anthropic buildChatRequest：多轮工具回填映射成 tool_use / tool_result block', () => {
  const req = anthropicAdapter.buildChatRequest(
    {
      model: 'claude-sonnet-4',
      messages: [
        { role: 'user', content: '查天气' },
        {
          role: 'assistant',
          content: '我来查',
          tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
        },
        { role: 'tool', content: '{"temp":21}', tool_call_id: 'toolu_1' },
      ],
    },
    { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant', model: 'claude-sonnet-4' },
  );
  const body = JSON.parse(req.body) as { messages: Array<Record<string, unknown>> };
  assert.deepEqual(body.messages[1], {
    role: 'assistant',
    content: [
      { type: 'text', text: '我来查' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '北京' } },
    ],
  });
  assert.deepEqual(body.messages[2], {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"temp":21}' }],
  });
});

test('anthropic buildChatRequest：工具参数不是合法 JSON 时不抛错，原文裹进 input._raw', () => {
  const req = anthropicAdapter.buildChatRequest(
    {
      model: 'm',
      messages: [
        { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'f', arguments: '{oops' } }] },
      ],
    },
    { baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'm' },
  );
  const body = JSON.parse(req.body) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
  assert.deepEqual(body.messages[0]?.content, [{ type: 'tool_use', name: 'f', input: { _raw: '{oops' } }]);
});

test('anthropic parseChatResponse：text/thinking/tool_use 分开、stop_reason 保留', () => {
  const res = anthropicAdapter.parseChatResponse(
    {
      type: 'message',
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: '想想' },
        { type: 'text', text: '好的' },
        { type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } },
      ],
      usage: { input_tokens: 5, output_tokens: 7 },
    },
    200,
  );
  assert.equal(res.text, '好的');
  assert.equal(res.reasoning, '想想');
  assert.equal(firstCall(res).name, 'f');
  assert.deepEqual(firstCall(res).args, { a: 1 });
  assert.equal(res.finishReason, 'tool_use');
  assert.deepEqual(res.usage, { promptTokens: 5, completionTokens: 7, totalTokens: 12 });
});

test('anthropic parseChatResponse：stop_reason 缺失不补 end_turn', () => {
  const res = anthropicAdapter.parseChatResponse({ type: 'message', content: [{ type: 'text', text: 'x' }] }, 200);
  assert.equal(res.finishReason, undefined);
});

test('anthropic parseModelsResponse：取 data[].id', () => {
  assert.deepEqual(anthropicAdapter.parseModelsResponse({ data: [{ id: 'claude-a' }] }), ['claude-a']);
});
