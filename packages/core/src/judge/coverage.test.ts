/**
 * 覆盖自检（ARCHITECTURE §5）：19 类判定必须全部注册，且注册的 kind 集合与 JUDGE_KINDS 完全一致。
 * 少一类 → 测跑时会出现「未知 judge」，这里提前拦住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JUDGE_KINDS, type JudgeKind } from '../types.js';
import { buildRegistry, missingJudges, runJudge } from './index.js';

test('19 类判定全部已注册（missingJudges 为空）', () => {
  assert.deepEqual(missingJudges(buildRegistry()), []);
});

test('注册的 kind 集合与 JUDGE_KINDS 完全一致（不多不少）', () => {
  const registered = buildRegistry().kinds();
  assert.deepEqual(registered, [...JUDGE_KINDS].sort());
  assert.equal(registered.length, 19);
});

test('每个 kind 都有可调用的实现函数', () => {
  const registry = buildRegistry();
  for (const kind of JUDGE_KINDS) {
    assert.equal(registry.has(kind), true, `${kind} 未注册`);
    assert.equal(typeof registry.get(kind), 'function', `${kind} 没有实现函数`);
  }
});

test('重复注册同一 kind 会抛错（D1：判分只允许一份实现）', () => {
  const registry = buildRegistry();
  assert.throws(() => registry.register('exact', () => []), /已注册/);
});

test('未知 kind 走 runJudge 兜成硬失败（不会静默给分）', () => {
  const question = { id: 'x', group: 'basic', prompt: 'p', judge: 'nope' as JudgeKind };
  const checks = runJudge(buildRegistry(), question, { question, response: { text: 'anything' } });
  assert.equal(checks.length, 1);
  assert.equal(checks[0]?.name, 'registry');
  assert.equal(checks[0]?.hard, true);
  assert.equal(checks[0]?.pass, false);
});
