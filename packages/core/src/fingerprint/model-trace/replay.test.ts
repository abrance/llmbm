import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumbers, robustScoreNumbers } from './scoring.js';
import { loadModelTraceBank } from './loader.js';
import type { ModelTraceBank } from './loader.js';
import replayFixtureRaw from './replay-fixture.json' with { type: 'json' };

/**
 * 回归测试：拿 lm-detector 真实参考样本（unified_reference.jsonl 抽取的 70 模型 × 3 条）
 * 走一遍打分链路，验证 top-1 命中率。只测函数不喂真实样本不算通过，这条必须真读 fixture。
 *
 * 口径（与 lm-detector 一致）：单条 parseNumbers → robustScoreNumbers 得 70 维分；
 * 三条取均值 → softmax(beta × 均值分)，beta 取 bank.calibration[min(条数,3)].beta；
 * 概率最高者即预测模型，与样本所属模型 id 比对。
 */

interface ReplaySample {
  expectedCount: number;
  text: string;
}
interface ReplayModel {
  id: string;
  samples: ReplaySample[];
}
interface ReplayFixture {
  schema: string;
  source: string;
  models: ReplayModel[];
}

const fixture = replayFixtureRaw as unknown as ReplayFixture;

function softmax(scores: readonly number[], beta: number): number[] {
  const max = Math.max(...scores);
  const exps = scores.map((s) => Math.exp(beta * (s - max)));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

function argmax(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) if (values[i]! > values[best]!) best = i;
  return best;
}

function predictModel(bank: ModelTraceBank, samples: readonly ReplaySample[]): string {
  const perSampleScores = samples.map((s) => robustScoreNumbers(parseNumbers(s.text), bank));
  const dim = perSampleScores[0]!.length;
  const meanScores = Array.from({ length: dim }, (_, i) =>
    perSampleScores.reduce((acc, row) => acc + row[i]!, 0) / perSampleScores.length,
  );
  const beta = bank.calibration[String(Math.min(samples.length, 3))]!.beta;
  const probs = softmax(meanScores, beta);
  return bank.model_order[argmax(probs)]!;
}

test('replay 回归：70 模型真实参考样本 top-1 命中率 ≥ 95%', async () => {
  assert.equal(fixture.schema, 'modeltrace-replay-fixture-v1');
  assert.equal(fixture.models.length, 70);
  assert.ok(
    fixture.models.every((m) => m.samples.length >= 1),
    '每个模型至少要有 1 条真实样本',
  );

  const bank = await loadModelTraceBank();
  const misses: string[] = [];
  for (const model of fixture.models) {
    const predicted = predictModel(bank, model.samples);
    if (predicted !== model.id) misses.push(`${model.id}→${predicted}`);
  }
  const hitRate = (fixture.models.length - misses.length) / fixture.models.length;
  assert.ok(
    hitRate >= 0.95,
    `top-1 命中率 ${(hitRate * 100).toFixed(1)}%（${fixture.models.length - misses.length}/${fixture.models.length}）不足 95%；误判：${misses.join(', ')}`,
  );
});
