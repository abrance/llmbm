import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModelTraceBank, validateBank, bankModels, resetModelTraceBankCache, type ModelTraceBank } from './loader.js';

test('加载精简库：70 个模型，provenance 带 MIT 版权与来源 sha256', async () => {
  resetModelTraceBankCache();
  const bank = await loadModelTraceBank();
  assert.equal(bank.model_order.length, 70);
  assert.equal(bank.models.length, 70);
  assert.equal(bank.provenance.license, 'MIT');
  assert.equal(bank.provenance.license_copyright, 'Copyright (c) 2026 xqy2006');
  assert.match(bank.provenance.source_repo, /lm-detector/);
  assert.equal(typeof bank.provenance.source_sha256, 'string');
  assert.equal((bank.provenance.source_sha256 ?? '').length, 64);
  assert.ok(bankModels(bank).every((m) => m.id && m.family));
});

test('加载器缓存：连续加载返回同一对象，reset 后仍能重新校验通过', async () => {
  resetModelTraceBankCache();
  const a = await loadModelTraceBank();
  const b = await loadModelTraceBank();
  assert.equal(a, b);
  resetModelTraceBankCache();
  const c = await loadModelTraceBank();
  // ESM 会缓存 JSON 模块本身，reset 只清包装层缓存；重新加载仍应是合法库。
  assert.equal(c.model_order.length, 70);
  assert.doesNotThrow(() => validateBank(c));
});

test('validateBank：维度自洽的库通过校验', async () => {
  const bank = await loadModelTraceBank();
  assert.doesNotThrow(() => validateBank(bank));
});

test('validateBank：model_order 与 models 数量不一致时报错', async () => {
  const bank = await loadModelTraceBank();
  const broken = { ...bank, models: bank.models.slice(0, 3) } as ModelTraceBank;
  assert.throws(() => validateBank(broken), /model_order 不一致/);
});

test('validateBank：质心维度与特征维度不一致时报错', async () => {
  const bank = await loadModelTraceBank();
  const hellinger = { ...bank.robust.hellinger, feature_mean: bank.robust.hellinger.feature_mean.slice(0, 100) };
  const broken = { ...bank, robust: { ...bank.robust, hellinger } } as ModelTraceBank;
  assert.throws(() => validateBank(broken), /维度不一致/);
});

test('validateBank：缺 provenance.license 时报错', async () => {
  const bank = await loadModelTraceBank();
  const broken = { ...bank, provenance: { ...bank.provenance, license: '' } } as ModelTraceBank;
  assert.throws(() => validateBank(broken), /provenance\.license/);
});
