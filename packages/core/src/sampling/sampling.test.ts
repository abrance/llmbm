import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleSuite, questionBankVersion, hashString, mulberry32 } from './index.js';
import type { Question } from '../types.js';

const bank: Question[] = Array.from({ length: 12 }, (_, i) => ({
  id: `basic-${String(i).padStart(3, '0')}`,
  group: 'basic',
  prompt: `q${i}`,
  judge: 'exact' as const,
  expect: String(i),
}));

test('同 seed 同题库 → 逐题一致（F4）', () => {
  const a = sampleSuite(bank, { seed: 'run-2026-11-12' });
  const b = sampleSuite([...bank].reverse(), { seed: 'run-2026-11-12' });
  assert.deepEqual(a.map((q) => q.id), b.map((q) => q.id));
});

test('不同 seed → 选题/顺序不同（至少一项不同）', () => {
  const a = sampleSuite(bank, { seed: 's1', perGroup: 5 }).map((q) => q.id);
  const b = sampleSuite(bank, { seed: 's2', perGroup: 5 }).map((q) => q.id);
  assert.notDeepEqual(a, b);
});

test('perGroup 限制每组题数，groups 过滤分组', () => {
  const mixed = [...bank, { ...bank[0]!, id: 'adv-001', group: 'adversarial' }];
  assert.equal(sampleSuite(mixed, { seed: 'x', groups: ['basic'] }).length, 12);
  assert.equal(sampleSuite(mixed, { seed: 'x', perGroup: 3 }).length, 4); // basic 3 + adversarial 1
});

test('exclude 生效', () => {
  const picked = sampleSuite(bank, { seed: 'x', exclude: ['basic-000'] });
  assert.equal(picked.length, 11);
  assert.ok(!picked.some((q) => q.id === 'basic-000'));
});

test('题库版本只对内容敏感（D6）', () => {
  assert.equal(questionBankVersion(bank), questionBankVersion([...bank].reverse()));
  assert.notEqual(questionBankVersion(bank), questionBankVersion([{ ...bank[0]!, expect: 'changed' }, ...bank.slice(1)]));
  assert.match(questionBankVersion(bank), /^qb-[0-9a-f]{8}$/);
});

test('PRNG 确定性且落在 [0,1)', () => {
  const r1 = mulberry32(hashString('seed'));
  const r2 = mulberry32(hashString('seed'));
  for (let i = 0; i < 100; i++) {
    const v = r1();
    assert.equal(v, r2());
    assert.ok(v >= 0 && v < 1);
  }
});
