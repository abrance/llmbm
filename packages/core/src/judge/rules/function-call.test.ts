import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeFunctionCall } from './function-call.js';
import type { JudgeContext, Question, ToolCall } from '../../types.js';

const ctx = (text: string, expect: unknown, calls?: ToolCall[], error?: string): JudgeContext => ({
  question: { id: 't', group: 'advanced', prompt: 'p', judge: 'function-call', expect } as Question,
  response: { text, ...(calls ? { toolCalls: calls } : {}), ...(error ? { error } : {}) },
});

test('正例：发出了期望的调用', () => {
  const checks = judgeFunctionCall(ctx('', { name: 'get_weather' }, [{ name: 'get_weather' }]));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：count 指定且数量正确', () => {
  const checks = judgeFunctionCall(ctx('', { name: 'get_weather', count: 2 }, [{ name: 'get_weather' }, { name: 'get_weather' }]));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— 调用了别的函数', () => {
  const checks = judgeFunctionCall(ctx('', { name: 'get_weather' }, [{ name: 'search_docs' }]));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]?.detail), /期望 get_weather，实际 search_docs/);
});

test('反例：内容缺项 —— 只有文字描述没有 toolCalls', () => {
  const checks = judgeFunctionCall(ctx('我会调用 get_weather 查询北京天气。', { name: 'get_weather' }));
  assert.ok(checks.some((c) => c.name === 'function-call.present' && c.hard && !c.pass));
});

test('反例：count 不符', () => {
  const checks = judgeFunctionCall(ctx('', { name: 'get_weather', count: 2 }, [{ name: 'get_weather' }]));
  assert.ok(checks.some((c) => c.name === 'function-call.count' && !c.pass));
});

test('反例：空响应且无调用 → 硬失败', () => {
  const checks = judgeFunctionCall(ctx('', { name: 'x' }));
  assert.ok(checks.some((c) => c.hard && !c.pass));
});

test('反例：expect 非法抛错', () => {
  assert.throws(() => judgeFunctionCall(ctx('', {})), /name/);
  assert.throws(() => judgeFunctionCall(ctx('', { name: 'x', count: 0 })), /count/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeFunctionCall(ctx('', { name: 'get_weather' }, [{ name: 'get_weather' }], 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});
