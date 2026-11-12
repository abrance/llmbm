import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiAdapter } from './openai.js';
import { assertTruncated, collect, feed, firstCall, textOf, types } from './testing.js';

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}`;

/* 1. 正常流 */
test('openai 正常流：text 增量拼接 + [DONE] + usage + finishReason', () => {
  const lines = [
    frame({ choices: [{ delta: { role: 'assistant' } }] }),
    frame({ choices: [{ delta: { content: '42' } }] }),
    frame({ choices: [{ delta: { content: ' 是答案' } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }),
    'data: [DONE]',
  ];
  const events = feed(openaiAdapter, lines);
  assert.deepEqual(types(events), ['text', 'text', 'usage', 'done:stop', 'done']);
  assert.equal(textOf(events), '42 是答案');

  const res = collect(openaiAdapter, lines, 200);
  assert.equal(res.text, '42 是答案');
  assert.equal(res.finishReason, 'stop');
  assert.deepEqual(res.usage, { promptTokens: 10, completionTokens: 4, totalTokens: 14 });
  assert.equal(res.httpStatus, 200);
});

/* 2. reasoning 帧 */
test('openai reasoning 帧：reasoning_content 与正文分开', () => {
  const lines = [
    frame({ choices: [{ delta: { reasoning_content: '先算 6×7' } }] }),
    frame({ choices: [{ delta: { reasoning_content: '=42' } }] }),
    frame({ choices: [{ delta: { content: '42' } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ];
  const events = feed(openaiAdapter, lines);
  assert.deepEqual(types(events), ['reasoning', 'reasoning', 'text', 'done:stop']);

  const res = collect(openaiAdapter, lines);
  assert.equal(res.reasoning, '先算 6×7=42');
  assert.equal(res.text, '42', 'reasoning 不得混进正文');
});

test('openai reasoning 别名：delta.reasoning 也认', () => {
  const res = collect(openaiAdapter, [frame({ choices: [{ delta: { reasoning: '思考' } }] })]);
  assert.equal(res.reasoning, '思考');
  assert.equal(res.text, '');
});

/* 3. tool_calls 增量 */
test('openai tool_calls 增量：按 index 拼接 arguments 并解析', () => {
  const lines = [
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"ci' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"北京"}' } }] } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ];
  const res = collect(openaiAdapter, lines);
  assert.equal(res.toolCalls?.length, 1);
  assert.equal(firstCall(res).name, 'get_weather');
  assert.equal(firstCall(res).id, 'call_1');
  assert.deepEqual(firstCall(res).args, { city: '北京' });
  assert.equal(firstCall(res).rawArguments, '{"city":"北京"}');
  assert.equal(res.finishReason, 'tool_calls');
});

test('openai tool_calls 参数半截：不抛错，保留 rawArguments', () => {
  const lines = [
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'f', arguments: '{"a":' } }] } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ];
  const res = collect(openaiAdapter, lines);
  assert.equal(firstCall(res).args, undefined);
  assert.equal(firstCall(res).rawArguments, '{"a":');
});

test('openai tool_calls 多路：index 1 与 0 各自成条并按 index 排序', () => {
  const lines = [
    frame({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'second', arguments: '{}' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'first', arguments: '{}' } }] } }] }),
  ];
  const res = collect(openaiAdapter, lines);
  assert.deepEqual(res.toolCalls?.map((c) => c.name), ['first', 'second']);
});

/* 4. 未知帧：忽略但不报错、不吞正文 */
test('openai 未知帧：注释行/心跳/非 JSON/未知字段都不报错也不吞正文', () => {
  const lines = [
    ': keep-alive',
    '',
    'event: ping',
    'data: {not json',
    frame({ choices: [{ delta: { content: 'A' } }] }),
    frame({ choices: [{ delta: { content: 'B' }, something_new: { x: 1 } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ];
  const events = feed(openaiAdapter, lines);
  assert.equal(events.some((e) => e.type === 'error'), false);
  assert.equal(textOf(events), 'AB');
});

test('openai 错误帧：error 映射成 error 事件', () => {
  const events = feed(openaiAdapter, [frame({ error: { message: 'insufficient quota', code: 'x' } })]);
  assert.deepEqual(events, [{ type: 'error', error: 'insufficient quota' }]);
});

/* 5. HTTP 200 但无完成标记 */
test('openai 流断但 HTTP 200：finishReason 缺失可辨别', () => {
  const lines = [frame({ choices: [{ delta: { content: '半句' } }] })];
  const res = collect(openaiAdapter, lines, 200);
  assert.equal(res.text, '半句');
  assertTruncated(res);
});

test('openai 只有 [DONE] 没有 finish_reason：仍算未完成', () => {
  const res = collect(openaiAdapter, [frame({ choices: [{ delta: { content: 'x' } }] }), 'data: [DONE]'], 200);
  assertTruncated(res);
});

/* 请求体与响应解析 */
test('openai buildChatRequest：/v1/chat/completions、Bearer、jsonMode', () => {
  const req = openaiAdapter.buildChatRequest(
    { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], jsonMode: true, maxTokens: 128 },
    { baseUrl: 'https://api.example.com/', apiKey: 'sk-1', model: 'gpt-4o' },
  );
  assert.equal(req.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer sk-1');
  const body = JSON.parse(req.body) as Record<string, unknown>;
  assert.equal(body.stream, true);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.max_tokens, 128);
});

test('openai buildChatRequest：baseUrl 已含 /v1 不重复拼接', () => {
  const req = openaiAdapter.buildChatRequest(
    { model: 'm', messages: [] },
    { baseUrl: 'https://x.dev/v1', apiKey: 'k', model: 'm' },
  );
  assert.equal(req.url, 'https://x.dev/v1/chat/completions');
});

test('openai parseChatResponse：非流式取 content/finish_reason/usage', () => {
  const res = openaiAdapter.parseChatResponse(
    { choices: [{ message: { content: 'ok', reasoning_content: 'r' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
    200,
  );
  assert.equal(res.text, 'ok');
  assert.equal(res.reasoning, 'r');
  assert.equal(res.finishReason, 'stop');
  assert.deepEqual(res.usage, { promptTokens: 1, completionTokens: 2 });
});

test('openai parseChatResponse：finish_reason 缺失不补 stop', () => {
  const res = openaiAdapter.parseChatResponse({ choices: [{ message: { content: 'x' } }] }, 200);
  assert.equal(res.finishReason, undefined);
});

test('openai parseModelsResponse：取 data[].id', () => {
  assert.deepEqual(openaiAdapter.parseModelsResponse({ data: [{ id: 'a' }, { id: 'b' }, {}] }), ['a', 'b']);
});
