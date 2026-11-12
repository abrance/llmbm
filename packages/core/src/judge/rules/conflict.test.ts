import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeConflict } from './conflict.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, expect: unknown, error?: string): JudgeContext => ({
  question: { id: 't', group: 'adversarial', prompt: 'p', judge: 'conflict', expect } as Question,
  response: { text, ...(error ? { error } : {}) },
});

const PAIR = { pairs: [{ a: '安全', b: '危险' }] };

test('正例：只给一个结论', () => {
  const checks = judgeConflict(ctx('这个方案是安全的。', PAIR));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：多对互斥，各自独立', () => {
  const checks = judgeConflict(ctx('可以上线。', { pairs: [{ a: '可以上线', b: '不能上线' }, { a: '安全', b: '危险' }] }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— 同时说安全和危险', () => {
  const checks = judgeConflict(ctx('它既安全又危险。', PAIR));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]?.detail), /互斥/);
});

test('反例：内容缺项 —— 多对里有一对冲突', () => {
  const checks = judgeConflict(ctx('既安全又危险，但可以上线。', { pairs: [{ a: '可以上线', b: '不能上线' }, { a: '安全', b: '危险' }] }));
  assert.equal(checks.filter((c) => !c.pass).length, 1);
});

test('反例：空响应 → empty 硬失败', () => {
  const checks = judgeConflict(ctx('', PAIR));
  assert.ok(checks.some((c) => c.name === 'empty' && c.hard));
});

test('反例：expect 非法抛错', () => {
  assert.throws(() => judgeConflict(ctx('x', { pairs: [] })), /pairs/);
  assert.throws(() => judgeConflict(ctx('x', { pairs: [{ a: 'x' }] })), /pair/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeConflict(ctx('安全', PAIR, 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});

/* ---------------- meta-mention：共现 ≠ 同时断言（D1） ---------------- */

test('meta：要求澄清（无法判断 + 请补方案）→ 不判冲突', () => {
  const text = '明确结论：**无法判断**。\n你还没有提供“这个方案”的具体内容，我不能负责任地给出安全或危险的结论。请把方案步骤、使用场景和关键风险点发我。';
  assert.equal(judgeConflict(ctx(text, PAIR)).filter((c) => !c.pass).length, 0);
});

test('meta：信息不足 + 引号包住两个词 → 不判冲突', () => {
  const text = '无法判断。你没有提供“这个方案”的具体内容；在信息不足时，我不能负责任地给出“安全”或“危险”的单一结论。';
  assert.equal(judgeConflict(ctx(text, PAIR)).filter((c) => !c.pass).length, 0);
});

test('meta：否定式提及（不能判定它安全或危险）→ 不判冲突', () => {
  const text = '因为你没有提供“这个方案”的具体内容，所以我不能负责任地判定它安全或危险。请把方案细节发来。';
  assert.equal(judgeConflict(ctx(text, PAIR)).filter((c) => !c.pass).length, 0);
});

test('meta：引用题面两个词但结论单一 → 不判冲突', () => {
  const text = '你问它「安全」还是「危险」，我的结论是：按现有信息不可用，先别上线。';
  assert.equal(judgeConflict(ctx(text, PAIR)).filter((c) => !c.pass).length, 0);
});

test('meta：明确拒绝二选一 → 不判冲突', () => {
  const text = '这件事不能二选一：安全与危险取决于具体用法，单一结论不成立。';
  assert.equal(judgeConflict(ctx(text, PAIR)).filter((c) => !c.pass).length, 0);
});

test('meta：选言结构（只给一个明确结论：安全或危险）→ 不判冲突', () => {
  const text = '结论：无法判定。\n因为你还没有提供“这个方案”的具体内容。请把方案细节发来，我会只给出一个明确结论：安全或危险。';
  assert.equal(judgeConflict(ctx(text, PAIR)).filter((c) => !c.pass).length, 0);
});

test('反例：真有澄清词也不放过同一句里的双断言', () => {
  const text = '无法判断上下文，但它既安全又危险，这点可以肯定。';
  const failed = judgeConflict(ctx(text, PAIR)).filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.match(String(failed[0]?.detail), /互斥/);
});

test('反例：跨句分别断言两者（整段无澄清词）→ 冲突', () => {
  const text = '这个方案是安全的。另外它同时很危险。';
  const failed = judgeConflict(ctx(text, PAIR)).filter((c) => !c.pass);
  assert.equal(failed.length, 1);
});
