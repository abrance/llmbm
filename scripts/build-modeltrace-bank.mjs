#!/usr/bin/env node
/* global process, Buffer, console */
/**
 * 从 lm-detector 的原始 unified_bank.json 抽取「ModelTrace 指纹排名」打分必需字段，
 * 生成入库用的精简库 model-trace-bank.json（约 1MB），并打印 sha256。
 *
 * 上游： https://github.com/ikaleio/lm-detector （MIT, Copyright (c) 2026 xqy2006）
 * 原理： xqy2006/ModelTrace
 *
 * 全程不联网：只读本地已有的原始库。同一份输入两次运行，输出逐字节一致（纯抽取，不重算）。
 * 打分口径见 packages/core/src/fingerprint/model-trace/scoring.ts。
 *
 * 产物（都在 packages/core/src/data/model-trace-bank/，该目录由 data 维护者维护）：
 *   model-trace-bank.json   精简库本体
 *   MANIFEST.json           上游 commit / 算法 / 探针参数 / bank sha256 / calibration 摘要
 *
 * 用法：
 *   node scripts/build-modeltrace-bank.mjs                 # 用默认原始库路径重建（同时刷新 MANIFEST）
 *   node scripts/build-modeltrace-bank.mjs --source DIR/data/unified_bank.json
 *   MODELTRACE_SRC=/path/unified_bank.json node scripts/build-modeltrace-bank.mjs
 *   node scripts/build-modeltrace-bank.mjs --check          # 有原始库：校验现有精简库与重建一致
 *   node scripts/build-modeltrace-bank.mjs --verify-hash    # 无原始库：只校验仓库内 bank 与 MANIFEST 的 sha256
 *
 * 只保留 scoring 必需字段，其余（frequency_references / counts / sources / conditions 等
 * 展示与校准训练用的中间量）一律不提交，避免 14MB 原始库入库。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const BANK_DIR = resolve(REPO_ROOT, 'packages/core/src/data/model-trace-bank');
const OUT_PATH = resolve(BANK_DIR, 'model-trace-bank.json');
const MANIFEST_PATH = resolve(BANK_DIR, 'MANIFEST.json');

/** 生成 MANIFEST 时钉住的上游事实（与 docs/v04-scope.md 一致；改探针参数必须同步这里）。 */
const UPSTREAM_COMMIT = '2c61f8f836de93d3ce60a9f76f8b8ff9e15011ac';
const PROBE = {
  version: 'modeltrace-probe-v1',
  prompt_source: 'shared/challenge-browser.js',
  challenges: 3,
  max_tokens: 8192,
  timeout_ms: 250000,
  temperature: null,
};
const ALGORITHM = 'modeltrace-robust-v1';

const DEFAULT_SOURCES = [
  process.env.MODELTRACE_SRC,
  resolve(REPO_ROOT, 'upstream/lm-detector/data/unified_bank.json'),
  '/tmp/lmdet/data/unified_bank.json',
  '/tmp/lm-detector/data/unified_bank.json',
].filter(Boolean);

const SOURCE_REPO = process.env.MODELTRACE_REPO || 'https://github.com/ikaleio/lm-detector';
const LICENSE = 'MIT';
const LICENSE_COPYRIGHT = 'Copyright (c) 2026 xqy2006';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function resolveSource() {
  const explicit = arg('source');
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`--source 指定的文件不存在: ${explicit}`);
    return resolve(explicit);
  }
  for (const candidate of DEFAULT_SOURCES) {
    if (existsSync(candidate)) return resolve(candidate);
  }
  throw new Error(
    '找不到原始 unified_bank.json。请用 --source 指定，或设 MODELTRACE_SRC 环境变量。\n' +
      `试过的路径：\n  ${DEFAULT_SOURCES.join('\n  ')}`,
  );
}

/** 从原始库所在 git 仓库取 HEAD commit；取不到返回 null（不联网）。 */
function sourceCommitNear(sourcePath) {
  let dir = dirname(sourcePath);
  for (let i = 0; i < 6; i += 1) {
    try {
      const commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      if (commit) return commit;
    } catch {
      // 继续往上找
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 把原始库里 scoring 必需的字段抽出来，字段顺序固定以保证逐字节可复现。 */
function extract(raw) {
  const robust = raw.robust;
  if (!robust || !robust.hellinger || !robust.ordered_blocks) {
    throw new Error('原始库缺少 robust.hellinger / robust.ordered_blocks，无法生成精简库');
  }
  if (!robust.robust_ready) {
    throw new Error('原始库 robust_ready=false（没有完整环境），不能用于排名，拒绝生成');
  }
  const h = robust.hellinger;
  const o = robust.ordered_blocks;
  if (!Array.isArray(raw.models) || raw.models.length !== robust.model_order.length) {
    throw new Error('原始库 models 数量与 model_order 不一致');
  }

  return {
    schema: 'modeltrace-scoring-bank',
    provenance: {
      built_at: raw.built_at,
      source_repo: SOURCE_REPO,
      source_url: SOURCE_REPO,
      source_commit: null, // 由 build() 填入
      source_sha256: null, // 由 build() 填入
      source_schema: raw.schema,
      source_built_at: raw.built_at,
      license: LICENSE,
      license_copyright: LICENSE_COPYRIGHT,
      builder: 'scripts/build-modeltrace-bank.mjs',
      note: '仅含指纹排名打分必需字段；原始 14MB 库不入库。',
    },
    method: raw.method,
    recommended_queries: raw.recommended_queries,
    minimum_valid_numbers: raw.minimum_valid_numbers,
    model_order: robust.model_order,
    // 展示用最小元数据（family 家族卡需要），不含 counts/sources 等大块。
    models: raw.models.map((m) => ({
      id: m.id,
      display_name: m.display_name,
      family: m.family,
      family_name: m.family_name,
    })),
    calibration: raw.calibration,
    robust: {
      hellinger: {
        feature_mean: h.feature_mean,
        feature_scale: h.feature_scale,
        nuisance_rank: h.nuisance_rank,
        nuisance_basis: h.nuisance_basis,
        centroids: h.centroids,
      },
      ordered_blocks: {
        weight: o.weight,
        feature: o.feature,
        feature_mean: o.feature_mean,
        feature_scale: o.feature_scale,
        nuisance_rank: o.nuisance_rank,
        nuisance_basis: o.nuisance_basis,
        centroids: o.centroids,
        environment_centroids: o.environment_centroids,
      },
    },
  };
}

/** MANIFEST：把「这个库从哪来、怎么算、探针怎么打」钉成可校验的小文件。 */
function manifestFor(text, bank) {
  const calibration = Object.fromEntries(
    ['1', '2', '3'].map((key) => [
      key,
      { beta: bank.calibration[key].beta, cv_accuracy: bank.calibration[key].cv_accuracy },
    ]),
  );
  return {
    schema: 'modeltrace-bank-manifest-v1',
    upstream: {
      repo: bank.provenance.source_repo,
      url: bank.provenance.source_url,
      commit: UPSTREAM_COMMIT,
      commit_short: UPSTREAM_COMMIT.slice(0, 7),
      license: bank.provenance.license,
      license_copyright: bank.provenance.license_copyright,
      license_file: 'LICENSES/lm-detector-MIT.txt',
    },
    algorithm: ALGORITHM,
    probe: PROBE,
    bank: {
      file: 'model-trace-bank.json',
      schema: bank.schema,
      sha256: sha256(Buffer.from(text)),
      bytes: Buffer.byteLength(text),
      models: bank.model_order.length,
      families: new Set(bank.models.map((model) => model.family)).size,
      source_sha256: bank.provenance.source_sha256,
    },
    calibration,
    built_at: bank.provenance.built_at,
  };
}

function build() {
  const sourcePath = resolveSource();
  const rawBuf = readFileSync(sourcePath);
  const raw = JSON.parse(rawBuf.toString('utf8'));
  const out = extract(raw);
  out.provenance.source_sha256 = sha256(rawBuf);
  out.provenance.source_commit = sourceCommitNear(sourcePath);
  const text = JSON.stringify(out);
  return { text, sourcePath, sourceSha: out.provenance.source_sha256, bytes: Buffer.byteLength(text), gzip: undefined };
}

function main() {
  if (hasFlag('verify-hash')) {
    verifyHash();
    return;
  }
  const { text, sourcePath, sourceSha, bytes } = build();
  const outSha = sha256(Buffer.from(text));

  if (hasFlag('check')) {
    if (!existsSync(OUT_PATH)) throw new Error(`精简库不存在: ${OUT_PATH}`);
    const existing = sha256(readFileSync(OUT_PATH));
    if (existing !== outSha) {
      console.error(`sha256 不一致：现有 ${existing} vs 重建 ${outSha}`);
      process.exit(1);
    }
    console.log(`OK 精简库与重建结果一致 sha256=${outSha}`);
    return;
  }

  writeFileSync(OUT_PATH, text);
  const bank = JSON.parse(text);
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifestFor(text, bank), null, 2)}\n`);
  console.log(`原始库: ${sourcePath}  sha256=${sourceSha}`);
  console.log(`精简库: ${OUT_PATH}`);
  console.log(`体积: ${(bytes / 1048576).toFixed(2)} MB   sha256=${outSha}`);
  console.log(`模型数: ${bank.model_order.length}`);
  console.log(`MANIFEST: ${MANIFEST_PATH}`);
  verifyHash();
}

/**
 * 只校验仓库内已有产物：bank 的 sha256 必须等于 MANIFEST 记的值，且 MANIFEST 口径自洽。
 * 不读 14MB 原始库，所以 CI 上能跑。
 */
function verifyHash() {
  const fail = (message) => {
    console.error(`FAIL ${message}`);
    process.exit(1);
  };
  if (!existsSync(OUT_PATH)) fail(`精简库不存在: ${OUT_PATH}`);
  if (!existsSync(MANIFEST_PATH)) fail(`MANIFEST 不存在: ${MANIFEST_PATH}`);
  const bankBuf = readFileSync(OUT_PATH);
  const actual = sha256(bankBuf);
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const bank = JSON.parse(bankBuf.toString('utf8'));
  if (manifest.bank.sha256 !== actual) fail(`bank sha256 不一致：MANIFEST ${manifest.bank.sha256} vs 实际 ${actual}`);
  if (manifest.bank.bytes !== bankBuf.length)
    fail(`bank 体积不一致：MANIFEST ${manifest.bank.bytes} vs 实际 ${bankBuf.length}`);
  if (bank.provenance.source_sha256 !== manifest.bank.source_sha256)
    fail('MANIFEST 与 bank.provenance.source_sha256 不一致');
  if (bank.provenance.source_sha256 !== sha256OfHex(bank.provenance.source_sha256))
    fail('source_sha256 不是 64 位十六进制');
  if (manifest.upstream.commit !== bank.provenance.source_commit)
    fail('MANIFEST 上游 commit 与 bank.provenance.source_commit 不一致');
  if (manifest.algorithm !== ALGORITHM) fail(`MANIFEST algorithm 应为 ${ALGORITHM}`);
  for (const key of ['1', '2', '3']) {
    if (manifest.calibration?.[key]?.beta !== bank.calibration[key].beta) fail(`calibration[${key}].beta 与库不一致`);
  }
  console.log(`OK bank sha256=${actual} models=${bank.model_order.length} upstream=${manifest.upstream.commit_short}`);
}

/** 非法十六进制返回空串，供上面的格式校验用（避免再引一个正则常量）。 */
function sha256OfHex(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value : '';
}

main();
