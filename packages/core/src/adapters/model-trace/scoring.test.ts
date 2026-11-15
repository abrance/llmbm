import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countNumbers, hellingerFeature, orderedBlockFeature, parseNumbers, robustScoreNumbers } from './scoring.js';
import type { ScoringBank } from './scoring.js';

// dist 下运行时，精简库与测试文件同目录（tsc 会拷贝 json）。
const HERE = dirname(fileURLToPath(import.meta.url));
const BANK = JSON.parse(readFileSync(resolve(HERE, 'model-trace-bank.json'), 'utf8')) as ScoringBank;

/** 确定性伪随机整数序列，避免测试依赖 Math.random。 */
function sequence(length: number, seed = 12345): number[] {
  let state = seed;
  return Array.from({ length }, () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return 1 + (state % 355);
  });
}

test('parseNumbers：取最长有效整数段，越界值丢弃，字母分隔切段', () => {
  assert.deepEqual(parseNumbers('abc 1 2 3 def 4 5'), [1, 2, 3]);
  assert.deepEqual(parseNumbers('0 400 200 300 500'), [200, 300]);
  assert.deepEqual(parseNumbers('没有数字'), []);
  // 355 是上界、1 是下界，都算有效
  assert.deepEqual(parseNumbers('1 355'), [1, 355]);
});

test('countNumbers：直方图长度恒为 355，按值偏移计数', () => {
  const counts = countNumbers([1, 355, 200]);
  assert.equal(counts.length, 355);
  assert.equal(counts[0], 1); // 1 → index 0
  assert.equal(counts[354], 1); // 355 → index 354
  assert.equal(counts[199], 1); // 200 → index 199
  assert.equal(counts.reduce((a, b) => a + b, 0), 3);
});

test('特征维度：Hellinger 355 维、有序块 74 维，且都是有限正数', () => {
  const nums = sequence(300);
  const h = hellingerFeature(countNumbers(nums));
  const o = orderedBlockFeature(nums);
  assert.equal(h.length, 355);
  assert.equal(o.length, 74);
  assert.ok(h.every((v) => Number.isFinite(v) && v > 0));
  assert.ok(o.every((v) => Number.isFinite(v) && v >= 0));
});

test('robustScoreNumbers：输出与 model_order 等长（70），全为有限值', () => {
  const scores = robustScoreNumbers(sequence(320), BANK);
  assert.equal(scores.length, BANK.model_order.length);
  assert.ok(scores.every((v) => Number.isFinite(v)));
});

test('robustScoreNumbers：确定性 —— 同输入两次输出逐位一致', () => {
  const nums = sequence(320, 999);
  assert.deepEqual(robustScoreNumbers(nums, BANK), robustScoreNumbers(nums, BANK));
});

// 回归金标：与 lm-detector 上游实现逐位对齐（移植自 fingerprint-core.js）后取定的数值。
// 若打分实现被改动导致偏差，这条会亮红灯 —— 阈值用 1e-6，远小于上游重算误差。
test('robustScoreNumbers：固定输入的金标（对齐上游 lm-detector）', () => {
  const scores = robustScoreNumbers(sequence(320), BANK);
  assert.ok(Math.abs(scores[0]! - -0.469232) < 1e-6, `scores[0]=${scores[0]}`);
  assert.ok(Math.abs(scores[1]! - -2.763355) < 1e-6, `scores[1]=${scores[1]}`);
  assert.ok(Math.abs(scores[2]! - 0.168159) < 1e-6, `scores[2]=${scores[2]}`);
  // 最高分位置与模型也应稳定（排名的可复现性）
  const topIndex = scores.indexOf(Math.max(...scores));
  assert.equal(topIndex, 51);
  assert.equal(BANK.model_order[topIndex], 'seed-2.0-mini');
});
