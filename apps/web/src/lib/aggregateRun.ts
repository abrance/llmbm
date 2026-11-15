/**
 * 一次跑测的聚合入口（web 侧唯一一处组装 aggregate 参数）。
 *
 * 诊断题（`diagnostic: true`，如 group=timeout）只观测传输时延：聚合前就从 scores 与
 * expectedQuestions 里剔除，否则 10 道低难度题会把「端点慢」算成「模型差」。
 * 超时/时延结论只走结果页的 LatencyPanel（lib/latency.ts），不经过这里。
 */
import { aggregate, type OutcomeReport } from '@llmbm/core';
import type { QuestionResult } from './types.js';

/** 参与能力分的题：诊断题不在其中。 */
export function scoredResults(results: readonly QuestionResult[]): QuestionResult[] {
  return results.filter((result) => result.diagnostic !== true);
}

/**
 * 聚合能力分。`expected` 缺省=已完成的评分题数（与 worker 历史口径一致）；
 * 补测合并时由调用方显式传入，避免把未跑的题算成完成。
 */
export function aggregateRun(
  results: readonly QuestionResult[],
  samplesPerQuestion: number,
  expected?: number,
): OutcomeReport {
  const scored = scoredResults(results);
  const weights: Record<string, number> = {};
  for (const result of scored) weights[result.questionId] = result.weight;
  return aggregate({
    scores: scored.flatMap((result) => result.samples.map((sample) => sample.score)),
    expectedQuestions: expected ?? scored.length,
    weights,
    samplesPerQuestion,
  });
}
