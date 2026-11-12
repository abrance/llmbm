import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeToolArgs } from './tool-args.js';
import type { JudgeContext, Question, ToolCall } from '../../types.js';

const ctx = (expect: unknown, calls?: ToolCall[], text = '', error?: string): JudgeContext => ({
  question: { id: 't', group: 'advanced', prompt: 'p', judge: 'tool-args', expect } as Question,
  response: { text, ...(calls ? { toolCalls: calls } : {}), ...(error ? { error } : {}) },
});

const ORDER = { name: 'create_order', args: { sku: 'A-100', quantity: 2 }, allowExtra: true };

test('正例：参数完全匹配', () => {
  const checks = judgeToolArgs(ctx(ORDER, [{ name: 'create_order', args: { sku: 'A-100', quantity: 2 } }]));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：allowExtra 下多余参数可接受', () => {
  const checks = judgeToolArgs(ctx(ORDER, [{ name: 'create_order', args: { sku: 'A-100', quantity: 2, note: 'x' } }]));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：args 缺失但 rawArguments 可解析', () => {
  const checks = judgeToolArgs(ctx(ORDER, [{ name: 'create_order', rawArguments: '{"sku":"A-100","quantity":2}' }]));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：numericTolerance 容忍浮点误差', () => {
  const checks = judgeToolArgs(ctx(
    { name: 'pay', args: { amount: 10 }, numericTolerance: 0.01 },
    [{ name: 'pay', args: { amount: 10.005 } }],
  ));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— 主体对但参数错（数量 3）', () => {
  const checks = judgeToolArgs(ctx(ORDER, [{ name: 'create_order', args: { sku: 'A-100', quantity: 3 } }]));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]?.detail), /quantity 期望 2，实际 3/);
});

test('反例：内容缺项 —— 参数缺 sku', () => {
  const checks = judgeToolArgs(ctx(ORDER, [{ name: 'create_order', args: { quantity: 2 } }]));
  assert.ok(checks.some((c) => !c.pass && /sku 缺失/.test(String(c.detail))));
});

test('反例：调用了别的函数 → 硬失败', () => {
  const checks = judgeToolArgs(ctx(ORDER, [{ name: 'delete_order', args: {} }]));
  assert.ok(checks.some((c) => c.name === 'args.call' && c.hard && !c.pass));
});

test('反例：参数不是合法 JSON → 硬失败', () => {
  const checks = judgeToolArgs(ctx(ORDER, [{ name: 'create_order', rawArguments: '{sku:A-100' }]));
  assert.ok(checks.some((c) => c.name === 'args.parse' && c.hard && !c.pass));
});

test('反例：空响应且无调用 → 硬失败', () => {
  const checks = judgeToolArgs(ctx(ORDER));
  assert.ok(checks.some((c) => c.hard && !c.pass));
});

test('反例：allowExtra:false 时多余参数失败', () => {
  const checks = judgeToolArgs(ctx(
    { name: 'create_order', args: { sku: 'A-100' }, allowExtra: false },
    [{ name: 'create_order', args: { sku: 'A-100', quantity: 2 } }],
  ));
  assert.ok(checks.some((c) => c.name === 'args.no-extra' && !c.pass));
});

test('反例：expect 非法抛错', () => {
  assert.throws(() => judgeToolArgs(ctx({ args: {} })), /name/);
  assert.throws(() => judgeToolArgs(ctx({ name: 'x', args: [] })), /args/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeToolArgs(ctx(ORDER, [{ name: 'create_order', args: { sku: 'A-100', quantity: 2 } }], '', 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});
