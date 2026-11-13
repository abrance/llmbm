import assert from 'node:assert/strict';
import test from 'node:test';
import { JUDGE_KINDS, buildMessages, summarizeQuestion } from '@llmbm/core';
import { BANK_VERSION, GROUP_ORDER, QUESTION_BANK } from './bank.ts';

test('题库文件可加载，版本与题目数符合本次交付', () => {
  assert.match(BANK_VERSION, /^qb-/);
  assert.equal(QUESTION_BANK.length, 64);
});

test('spec §1 F3 六个分组都有题', () => {
  for (const group of GROUP_ORDER) {
    const count = QUESTION_BANK.filter((q) => q.group === group).length;
    assert.ok(count >= 5, `${group} 只有 ${count} 题`);
  }
});

test('JUDGE_KINDS 每类 judge 都有题覆盖', () => {
  const used = new Set(QUESTION_BANK.map((q) => q.judge));
  const missing = JUDGE_KINDS.filter((kind) => !used.has(kind));
  assert.deepEqual(missing, [], `缺少判定类型的题：${missing.join(', ')}`);
});

test('每类 judge 至少 2 题（正例 + 难点各一）', () => {
  for (const kind of JUDGE_KINDS) {
    const count = QUESTION_BANK.filter((q) => q.judge === kind).length;
    assert.ok(count >= 2, `${kind} 只有 ${count} 题`);
  }
});

test('题目 id 唯一、必填字段齐全、分数权重为正', () => {
  const ids = new Set<string>();
  for (const q of QUESTION_BANK) {
    assert.ok(!ids.has(q.id), `重复 id: ${q.id}`);
    ids.add(q.id);
    assert.ok(q.prompt.trim().length > 0, `${q.id} 没有 prompt`);
    assert.ok((q.timeoutMs ?? 0) > 0, `${q.id} 没有超时`);
    assert.ok((q.weight ?? 1) > 0, `${q.id} 权重非法`);
  }
  assert.ok(QUESTION_BANK.some((q) => q.core === true), '至少要有 core 题');
});

test('每题都有 description（用例说明），供题库页与证据链展示', () => {
  for (const q of QUESTION_BANK) {
    assert.ok((q.description ?? '').trim().length >= 10, `${q.id} 缺 description 或过短`);
  }
});

test('多轮题的 prompt 与最后一条 user 消息一致（展示与实发同一个事实源）', () => {
  for (const q of QUESTION_BANK.filter((item) => item.messages && item.messages.length > 0)) {
    const lastUser = [...(q.messages ?? [])].reverse().find((m) => m.role === 'user');
    assert.ok(lastUser, `${q.id} 没有 user 消息`);
    assert.equal(
      typeof lastUser?.content === 'string' ? lastUser.content : '',
      q.prompt,
      `${q.id} 的 prompt 与最后一条 user 不一致`,
    );
  }
});

test('不管单轮/多轮/长文档/图片，buildMessages 都能组出请求，且摘要与消息数一致', () => {
  for (const q of QUESTION_BANK) {
    const messages = buildMessages(q);
    assert.ok(messages.length > 0, `${q.id} 组不出消息`);
    const summary = summarizeQuestion(q);
    assert.equal(summary.turns, messages.length, `${q.id} 摘要轮数与实际消息数不一致`);
    assert.ok(summary.inputChars > 0, `${q.id} 输入字符数为 0`);
    if (q.contextDoc) assert.ok((summary.injection?.fillerChars ?? 0) > 0, `${q.id} 缺注入摘要`);
    if (q.image) assert.ok((summary.image?.bytes ?? 0) > 0, `${q.id} 缺图片摘要`);
  }
});

test('每题都有 mock 演示答案，工具题带 tools 与 toolCalls', () => {
  for (const q of QUESTION_BANK) {
    assert.ok(q.mock, `${q.id} 没有 mock 答案`);
    const isToolJudge = q.judge === 'function-call' || q.judge === 'tool-args';
    if (isToolJudge) {
      assert.ok(q.tools && q.tools.length > 0, `${q.id} 工具题缺 tools`);
      assert.ok(q.mock?.toolCalls && q.mock.toolCalls.length > 0, `${q.id} 工具题缺 mock.toolCalls`);
    } else {
      assert.ok((q.mock?.text ?? '').length > 0, `${q.id} 没有文本 mock 答案`);
    }
  }
});

test('exact 题的 mock 答案与 expect 完全一致（演示可满分）', () => {
  for (const q of QUESTION_BANK.filter((item) => item.judge === 'exact')) {
    const expected = typeof q.expect === 'object' && q.expect !== null && 'value' in q.expect ? String(q.expect.value) : String(q.expect);
    assert.equal((q.mock?.text ?? '').trim(), expected.trim(), `${q.id} 的 mock 与 expect 不一致`);
  }
});
