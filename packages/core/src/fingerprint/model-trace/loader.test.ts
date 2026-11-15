import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  loadModelTraceBank,
  validateBank,
  bankModels,
  resetModelTraceBankCache,
  type ModelTraceBank,
} from './loader.js';
import manifest from '../../data/model-trace-bank/MANIFEST.json' with { type: 'json' };

/**
 * 参考库内容的 sha256（钉死）。库换了内容就必须同时改这里与 MANIFEST.json，
 * 否则 --verify-hash 与这条单测会一起拦下来，避免「库悄悄变了但没人发现」。
 * 计算口径：JSON.stringify(库对象) 的字节（建库脚本写盘时用的同一串，见 scripts/build-modeltrace-bank.mjs）。
 */
const BANK_SHA256 = '9b16f1235d645de170e27d7bf7e48ec3d131d86c305930ba43ba4169f68ad9be';

const bankSha256 = (bank: ModelTraceBank): string => createHash('sha256').update(JSON.stringify(bank)).digest('hex');

test('加载精简库：70 个模型，provenance 带 MIT 版权与来源 sha256', async () => {
  resetModelTraceBankCache();
  const bank = await loadModelTraceBank();
  assert.equal(bank.model_order.length, 70);
  assert.equal(bank.models.length, 70);
  assert.equal(bank.provenance.license, 'MIT');
  assert.equal(bank.provenance.license_copyright, 'Copyright (c) 2026 xqy2006');
  assert.match(bank.provenance.source_repo, /lm-detector/);
  assert.equal(bank.provenance.source_url, 'https://github.com/ikaleio/lm-detector');
  assert.match(bank.provenance.source_commit ?? '', /^2c61f8f/);
  assert.equal(typeof bank.provenance.built_at, 'string');
  assert.equal(typeof bank.provenance.source_sha256, 'string');
  assert.equal((bank.provenance.source_sha256 ?? '').length, 64);
  assert.ok(bankModels(bank).every((m) => m.id && m.family));
});

test('参考库 sha256 钉住：内容、MANIFEST 与 --verify-hash 三处一致', async () => {
  const bank = await loadModelTraceBank();
  assert.equal(bankSha256(bank), BANK_SHA256);
  assert.equal(manifest.bank.sha256, BANK_SHA256);
  assert.equal(manifest.bank.source_sha256, bank.provenance.source_sha256);
  assert.equal(manifest.upstream.commit, bank.provenance.source_commit);
  assert.equal(manifest.schema, 'modeltrace-bank-manifest-v1');
  assert.equal(manifest.algorithm, 'modeltrace-robust-v1');
  for (const key of ['1', '2', '3']) {
    assert.equal(manifest.calibration[key as '1'].beta, bank.calibration[key]!.beta);
    assert.equal(manifest.calibration[key as '1'].cv_accuracy, bank.calibration[key]!.cv_accuracy);
  }
});

test('MANIFEST：探针参数与上游 2c61f8f 对齐（不发 temperature、8192、250s）', () => {
  assert.equal(manifest.upstream.commit_short, '2c61f8f');
  assert.equal(manifest.probe.prompt_source, 'shared/challenge-browser.js');
  assert.equal(manifest.probe.max_tokens, 8192);
  assert.equal(manifest.probe.timeout_ms, 250000);
  assert.equal(manifest.probe.temperature, null);
  assert.equal(manifest.upstream.license_file, 'LICENSES/lm-detector-MIT.txt');
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

test('validateBank：source_sha256 不是 64 位十六进制时报错', async () => {
  const bank = await loadModelTraceBank();
  for (const bad of ['', 'xyz', 'a'.repeat(63), `${'a'.repeat(64)}z`]) {
    const broken = { ...bank, provenance: { ...bank.provenance, source_sha256: bad } } as ModelTraceBank;
    assert.throws(() => validateBank(broken), /source_sha256/, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('validateBank：source_url 缺失或不是 URL 时报错', async () => {
  const bank = await loadModelTraceBank();
  for (const bad of ['', 'not a url', 'file:///tmp/x.json']) {
    const broken = { ...bank, provenance: { ...bank.provenance, source_url: bad } } as ModelTraceBank;
    assert.throws(() => validateBank(broken), /source_url/, `应拒绝 ${JSON.stringify(bad)}`);
  }
});
