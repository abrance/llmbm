import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiAdapter } from './gemini.js';
import { assertTruncated, collect, feed, firstCall, textOf, types } from './testing.js';

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}`;

/* 1. 正常流 */
test('gemini 正常流：parts[].text 拼接 + usageMetadata + finishReason STOP', () => {
  const lines = [
    frame({ candidates: [{ content: { role: 'model', parts: [{ text: '42' }] } }] }),
    frame({ candidates: [{ content: { parts: [{ text: ' 是答案' }] } }] }),
    frame({
      candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 },
    }),
  ];
  const events = feed(geminiAdapter, lines);
  assert.deepEqual(types(events), ['text', 'text', 'usage', 'done:STOP']);
  assert.equal(textOf(events), '42 是答案');

  const res = collect(geminiAdapter, lines, 200);
  assert.equal(res.text, '42 是答案');
  assert.equal(res.finishReason, 'STOP');
  assert.deepEqual(res.usage, { promptTokens: 8, completionTokens: 3, totalTokens: 11 });
});

/* 2. reasoning 帧 */
test('gemini reasoning 帧：thought:true 的 part 进 reasoning', () => {
  const lines = [
    frame({ candidates: [{ content: { parts: [{ text: '先算', thought: true }] } }] }),
    frame({ candidates: [{ content: { parts: [{ text: '42' }] } }] }),
    frame({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }),
  ];
  const res = collect(geminiAdapter, lines);
  assert.equal(res.reasoning, '先算');
  assert.equal(res.text, '42');
});

/* 3. tool_calls 增量 */
test('gemini functionCall：name + args 解析成 toolCalls', () => {
  const lines = [
    frame({ candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: '北京' } } }] } }] }),
    frame({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }),
  ];
  const res = collect(geminiAdapter, lines);
  assert.equal(res.toolCalls?.length, 1);
  assert.equal(firstCall(res).name, 'get_weather');
  assert.deepEqual(firstCall(res).args, { city: '北京' });
});

test('gemini 多帧同 index 的 functionCall 参数：按帧拼接后整体解析', () => {
  // Gemini 不像 OpenAI 那样切参数串，但同一调用可能分帧到 parts 里；
  // 逐帧各成一条 event，聚合层按 index 追加 argumentsDelta。
  const lines = [
    frame({ candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] } }] }),
    frame({ candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: { b: 2 } } }] } }] }),
  ];
  const res = collect(geminiAdapter, lines);
  assert.equal(res.toolCalls?.length, 1);
  assert.equal(firstCall(res).rawArguments, '{"a":1}{"b":2}');
  // 两段拼接后不是合法 JSON → 保留原文不抛错
  assert.equal(firstCall(res).args, undefined);
});

/* 4. 未知帧 */
test('gemini 未知帧：非 JSON / 空帧 / 无 candidates 都忽略且不吞正文', () => {
  const lines = [
    'data: {oops',
    ': keep-alive',
    frame({ candidates: [{ content: { parts: [{ text: 'A' }] } }] }),
    frame({ promptFeedback: {} }),
    frame({ candidates: [{ content: { parts: [{ text: 'B' }] } }] }),
    frame({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }),
  ];
  const events = feed(geminiAdapter, lines);
  assert.equal(events.some((e) => e.type === 'error'), false);
  assert.equal(textOf(events), 'AB');
});

test('gemini 安全拦截：promptFeedback.blockReason → error', () => {
  const events = feed(geminiAdapter, [frame({ promptFeedback: { blockReason: 'SAFETY' } })]);
  assert.deepEqual(events, [{ type: 'error', error: 'blocked: SAFETY' }]);
});

/* 5. HTTP 200 但无完成标记 */
test('gemini 流断但 HTTP 200：无 finishReason → 未完成', () => {
  const res = collect(geminiAdapter, [frame({ candidates: [{ content: { parts: [{ text: '半句' }] } }] })], 200);
  assert.equal(res.text, '半句');
  assertTruncated(res);
});

test('gemini finishReason 非 STOP（如 MAX_TOKENS）如实保留，不当作正常', () => {
  const res = collect(geminiAdapter, [
    frame({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] }),
  ]);
  assert.equal(res.finishReason, 'MAX_TOKENS');
});

/* 请求体 */
test('gemini buildChatRequest：streamGenerateContent?alt=sse、systemInstruction、generationConfig', () => {
  const req = geminiAdapter.buildChatRequest(
    {
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'system', content: '你是评测助手' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo' },
        { role: 'user', content: '再来' },
      ],
      temperature: 0.2,
      maxTokens: 256,
      jsonMode: true,
    },
    { baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'AIza', model: 'gemini-2.5-pro' },
  );
  assert.equal(
    req.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
  );
  assert.equal(req.headers['x-goog-api-key'], 'AIza');
  const body = JSON.parse(req.body) as {
    systemInstruction?: unknown;
    contents?: unknown;
    generationConfig?: Record<string, unknown>;
  };
  assert.deepEqual(body.systemInstruction, {
    parts: [{ text: '你是评测助手\n\nOnly reply with a single JSON object, no prose and no markdown fence.' }],
  });
  assert.deepEqual(body.contents, [
    { role: 'user', parts: [{ text: 'hi' }] },
    { role: 'model', parts: [{ text: 'yo' }] },
    { role: 'user', parts: [{ text: '再来' }] },
  ]);
  const cfg = body.generationConfig;
  assert.ok(cfg);
  assert.equal(cfg.temperature, 0.2);
  assert.equal(cfg.maxOutputTokens, 256);
  assert.equal(cfg.responseMimeType, 'application/json');
});

test('gemini buildChatRequest：baseUrl 已含 /v1beta/models 或 /v1beta 不重复拼', () => {
  const req1 = geminiAdapter.buildChatRequest({ model: 'm', messages: [] }, { baseUrl: 'https://g.dev/v1beta', apiKey: 'k', model: 'm' });
  assert.equal(req1.url, 'https://g.dev/v1beta/models/m:streamGenerateContent?alt=sse');
  const req2 = geminiAdapter.buildChatRequest({ model: 'm', messages: [] }, { baseUrl: 'https://g.dev/v1beta/models', apiKey: 'k', model: 'm' });
  assert.equal(req2.url, 'https://g.dev/v1beta/models/m:streamGenerateContent?alt=sse');
});

test('gemini buildChatRequest：tools 映射为 [{functionDeclarations}]', () => {
  const req = geminiAdapter.buildChatRequest(
    {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: '查天气' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '查天气',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    },
    { baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'AIza', model: 'gemini-2.5-pro' },
  );
  const body = JSON.parse(req.body) as Record<string, unknown>;
  assert.deepEqual(body.tools, [
    {
      functionDeclarations: [
        {
          name: 'get_weather',
          description: '查天气',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
    },
  ]);
});

test('gemini buildChatRequest：tools 缺 description/parameters 时不写空值', () => {
  const req = geminiAdapter.buildChatRequest(
    { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'ping' } }] },
    { baseUrl: 'https://g.dev', apiKey: 'k', model: 'm' },
  );
  const body = JSON.parse(req.body) as { tools?: Array<{ functionDeclarations: Array<Record<string, unknown>> }> };
  assert.deepEqual(body.tools, [{ functionDeclarations: [{ name: 'ping' }] }]);
});

test('gemini parseChatResponse：非流式 finishReason 缺失不补 STOP', () => {
  const res = geminiAdapter.parseChatResponse({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }, 200);
  assert.equal(res.text, 'x');
  assert.equal(res.finishReason, undefined);
});

test('gemini parseModelsResponse：剥掉 models/ 前缀', () => {
  assert.deepEqual(geminiAdapter.parseModelsResponse({ models: [{ name: 'models/gemini-2.5-pro' }, { name: 'models/gemini-2.5-flash' }] }), [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
  ]);
});
