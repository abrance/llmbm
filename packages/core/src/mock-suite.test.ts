/**
 * 端到端冒烟：题库 → 确定性抽样 → 每题 N=3 次采样（mock 模型）→ judge → 单题分 → 聚合。
 * 不联网、不依赖 apps。judge 覆盖率随 rules 增加自动扩大。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from './aggregate.js';
import { defaultRegistry, judge, missingJudges } from './judge/index.js';
import { sampleSuite } from './sampling/index.js';
import { scoreQuestion } from './scoring/index.js';
import { sampleStat } from './scoring/interval.js';
import type { ModelResponse, Question, QuestionScore } from './types.js';

const SAMPLES = 3;

const bank: Question[] = [
  { id: 'basic-001', group: 'basic', prompt: '输出 42', judge: 'exact', expect: '42', core: true },
  { id: 'basic-002', group: 'basic', prompt: '输出 ok', judge: 'exact', expect: 'ok' },
  { id: 'ability-001', group: 'ability', prompt: '输出 3.14', judge: 'exact', expect: '3.14' },
];

/** mock 模型：第 n 次采样有时故意答错，用来验证区间不为 0 且样本数正确。 */
async function mockModel(question: Question, sampleIndex: number): Promise<ModelResponse> {
  const want = String(question.expect ?? '');
  const wrong = question.id === 'ability-001' && sampleIndex === 2;
  return { text: wrong ? '3.15' : want, latencyMs: 5, httpStatus: 200 };
}

test('mock 套题跑通并产出带区间的总分', async () => {
  const picked = sampleSuite(bank, { seed: 'mock-suite' });
  const scores: QuestionScore[] = [];

  for (const question of picked) {
    for (let i = 0; i < SAMPLES; i++) {
      const response = await mockModel(question, i);
      const checks = judge(question, response, i);
      scores.push(scoreQuestion(question, checks));
    }
  }

  const report = aggregate({ scores, expectedQuestions: picked.length });
  assert.equal(report.counts.questions, 3);
  assert.equal(report.stability.completed, 3);
  assert.equal(report.stability.rate, 1);
  // ability-001 有一次 0 分 → 题均 66.67，总分被拉低并封顶 99
  assert.ok(report.total.mean < 99);
  assert.ok(report.total.halfWidth > 0, 'N=3 且有波动时半宽必须 > 0');
  // ability-001 有一次 0 分采样 → 题级取最差，记 fail
  assert.equal(report.counts.fail, 1);
  assert.equal(report.counts.pass, 2);
  assert.equal(sampleStat([100, 100, 0]).mean, 66.66666666666667);
});

test('同 seed 两次运行分数完全一致（可复现）', async () => {
  const run = async () => {
    const picked = sampleSuite(bank, { seed: 'repro' });
    const scores: QuestionScore[] = [];
    for (const q of picked) {
      for (let i = 0; i < SAMPLES; i++) {
        scores.push(scoreQuestion(q, judge(q, await mockModel(q, i), i)));
      }
    }
    return aggregate({ scores }).total.mean;
  };
  assert.equal(await run(), await run());
});

test('registry 自检接口可用（缺规则时能报出来）', () => {
  const missing = missingJudges(defaultRegistry());
  assert.ok(Array.isArray(missing));
  // 现阶段 rules 只有 exact；19 类齐备后此处应为空（由 judge 覆盖率测试把关）。
  assert.ok(missing.includes('json-schema') || missing.length === 0);
});
