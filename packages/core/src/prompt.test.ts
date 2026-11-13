import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, contextDocText, fillerText, summarizeQuestion } from './prompt.js';
import type { Question } from './types.js';

const base: Question = { id: 'q', group: 'basic', prompt: '只输出 42', judge: 'exact', expect: '42' };

test('单轮：system + prompt 组两条消息', () => {
  const messages = buildMessages({ ...base, system: '你是校验器' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages[1]?.role, 'user');
});

test('单轮无 system：只有一条 user 消息，内容是 prompt 原文', () => {
  assert.deepEqual(buildMessages(base), [{ role: 'user', content: '只输出 42' }]);
});

test('多轮：messages 原样发出，不被 prompt 覆盖', () => {
  const messages = buildMessages({
    ...base,
    prompt: '暗号是什么',
    messages: [
      { role: 'user', content: '记住暗号 ORANGE-9' },
      { role: 'assistant', content: '已记住' },
      { role: 'user', content: '暗号是什么' },
    ],
  });
  assert.equal(messages.length, 3);
  assert.equal(messages[2]?.content, '暗号是什么');
});

test('长文档注入：填充文本确定性、针只出现一次、且位置随 needleAt 变化', () => {
  assert.equal(fillerText(500), fillerText(500));
  assert.notEqual(fillerText(500), fillerText(800));
  assert.ok(fillerText(500).length >= 500);

  const text = contextDocText({ ...base, contextDoc: { fillerChars: 3000, needle: 'BL-7241', needleAt: 0.5 } });
  assert.ok(text);
  assert.equal(text.split('BL-7241').length - 1, 1, '针必须只出现一次');

  const early = contextDocText({ ...base, contextDoc: { fillerChars: 3000, needle: 'X-1', needleAt: 0.1 } }) ?? '';
  const late = contextDocText({ ...base, contextDoc: { fillerChars: 3000, needle: 'X-1', needleAt: 0.9 } }) ?? '';
  assert.ok(early.indexOf('X-1') < late.indexOf('X-1'), 'needleAt 应控制针的位置');
});

test('长文档注入拼进最后一条 user，并保留原提问', () => {
  const messages = buildMessages({ ...base, contextDoc: { fillerChars: 1000, needle: 'QZ-3388', needleAt: 0.5 } });
  assert.equal(messages.length, 1);
  const content = messages[0]?.content;
  assert.equal(typeof content, 'string');
  assert.ok((content as string).includes('QZ-3388'));
  assert.ok((content as string).endsWith('只输出 42'));
});

test('图片输入挂在最后一条 user 上，文本保留在前', () => {
  const messages = buildMessages({ ...base, image: { mimeType: 'image/png', dataBase64: 'AAAA' } });
  const content = messages[0]?.content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(
    (content as Array<{ type: string }>).map((p) => p.type),
    ['text', 'image'],
  );
});

test('summarizeQuestion：多轮/注入/图片/参数/tools 都能出摘要', () => {
  const summary = summarizeQuestion({
    ...base,
    system: 'sys',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '问' },
    ],
    prompt: '问',
    contextDoc: { fillerChars: 2000, needle: 'N-1', needleAt: 0.62 },
    image: { mimeType: 'image/png', dataBase64: 'A'.repeat(400), alt: '四色块' },
    request: { temperature: 0.2, maxTokens: 16 },
    tools: [{ type: 'function', function: { name: 'get_weather' } }],
    timeoutMs: 12000,
  });
  assert.equal(summary.mode, 'multi-turn');
  assert.equal(summary.turns, 2);
  assert.deepEqual(summary.roles, ['system', 'user']);
  assert.equal(summary.system, 'sys');
  assert.equal(summary.injection?.needle, 'N-1');
  assert.equal(summary.injection?.needleAt, 0.62);
  assert.equal(summary.image?.bytes, 300);
  assert.deepEqual(summary.tools, ['get_weather']);
  assert.deepEqual(summary.params, { temperature: 0.2, maxTokens: 16 });
  assert.equal(summary.timeoutMs, 12000);
  assert.ok(summary.inputChars > 2000);
});

test('summarizeQuestion：缺省参数是 temperature=0、超时 30000，不编造 maxTokens', () => {
  const summary = summarizeQuestion(base);
  assert.deepEqual(summary.params, { temperature: 0 });
  assert.equal(summary.timeoutMs, 30000);
  assert.equal(summary.injection, undefined);
  assert.equal(summary.image, undefined);
  assert.equal(summary.tools, undefined);
});
