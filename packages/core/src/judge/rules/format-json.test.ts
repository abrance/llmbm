import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeFormatJson } from './format-json.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, error?: string): JudgeContext => ({
  question: { id: 't', group: 'ability', prompt: 'p', judge: 'format-json', expect: {} } as Question,
  response: { text, ...(error ? { error } : {}) },
});

test('正例：裸 JSON 对象', () => {
  const checks = judgeFormatJson(ctx('{"status":"ok"}'));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：裸 JSON 数组', () => {
  const checks = judgeFormatJson(ctx('[1,2,3]'));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— JSON 外面包了围栏', () => {
  const checks = judgeFormatJson(ctx('```json\n{"status":"ok"}\n```'));
  const failed = checks.filter((c) => !c.pass);
  // 围栏既破坏「无围栏」也破坏「整段是 JSON」，两条都该失败。
  assert.deepEqual(failed.map((c) => c.name).sort(), ['format.no-fence', 'format.parse']);
});

test('反例：内容缺项 —— 前面带了散文', () => {
  const checks = judgeFormatJson(ctx('好的，结果如下：{"status":"ok"}'));
  assert.ok(checks.some((c) => c.name === 'format.parse' && !c.pass));
});

test('反例：空响应 → empty 硬失败', () => {
  const checks = judgeFormatJson(ctx('   '));
  assert.ok(checks.some((c) => c.name === 'empty' && c.hard));
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeFormatJson(ctx('{"a":1}', 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});
