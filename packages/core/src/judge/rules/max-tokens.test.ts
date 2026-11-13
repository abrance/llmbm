import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegistry, runJudge } from '../index.js';
import type { JudgeKind, Question } from '../../types.js';

const question: Question = {
  id: 'ctx-params-001',
  group: 'context',
  prompt: '写一句话',
  judge: 'max-tokens' as JudgeKind,
  expect: { maxTokens: 16 },
};

function run(response: Parameters<typeof runJudge>[2]['response']) {
  return runJudge(buildRegistry(), question, { question, response });
}

test('max-tokens 正例：finishReason=length 且有 usage → 全部通过', () => {
  const checks = run({ text: '这是一段被截断的回答', finishReason: 'length', usage: { completionTokens: 16 } });
  assert.equal(checks.every((c) => c.pass), true, JSON.stringify(checks));
  assert.deepEqual(checks.map((c) => c.name), ['max-tokens.finish', 'max-tokens.usage']);
});

test('max-tokens 正例：anthropic 的 max_tokens 也算截断', () => {
  const checks = run({ text: 'x', finishReason: 'max_tokens' });
  assert.equal(checks[0]?.pass, true);
});

test('max-tokens 反例：finishReason=stop → 硬失败（端点忽略了参数）', () => {
  const checks = run({ text: '完整长回答……', finishReason: 'stop' });
  const finish = checks.find((c) => c.name === 'max-tokens.finish');
  assert.equal(finish?.pass, false);
  assert.equal(finish?.hard, true);
});

test('max-tokens 反例：usage 超过上限 → usage 检查失败（放大了 max_tokens）', () => {
  const checks = run({ text: 'ok', finishReason: 'length', usage: { completionTokens: 120 } });
  const usage = checks.find((c) => c.name === 'max-tokens.usage');
  assert.equal(usage?.pass, false);
  assert.match(usage?.detail ?? '', /超过/);
});

test('max-tokens 反例：没有 usage 且正文远超上限 → 长度兜底失败', () => {
  const checks = run({ text: '很'.repeat(500), finishReason: 'length' });
  const length = checks.find((c) => c.name === 'max-tokens.length');
  assert.equal(length?.pass, false);
});

test('max-tokens 传输失败 → 硬失败，且不做长度兜底', () => {
  const checks = run({ text: '', error: '请求超时（30000ms）' });
  assert.equal(checks.find((c) => c.name === 'transport')?.hard, true);
  assert.equal(checks.some((c) => c.name === 'max-tokens.length'), false);
});

test('max-tokens expect 非法 → 抛错（由 runJudge 兜成硬失败）', () => {
  const bad: Question = { ...question, expect: { maxTokens: 0 } };
  const checks = runJudge(buildRegistry(), bad, { question: bad, response: { text: 'x', finishReason: 'length' } });
  assert.equal(checks[0]?.name, 'judge.error');
  assert.equal(checks[0]?.hard, true);
});
