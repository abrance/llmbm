/**
 * 「超时与响应时延」分组的统计入口：题库元数据（timeoutMs/tags）+ 每次采样的原始计时。
 * 结果页卡片与 Markdown 导出都走这一份，口径与 lib/latency.ts 完全一致。
 */
import { QUESTION_BANK } from '../data/bank.js';
import { analyzeLatency, type LatencyQuestionInput, type LatencyReport } from './latency.js';
import type { QuestionResult } from './types.js';

export const TIMEOUT_GROUP = 'timeout';

/** 结果 → 统计输入：题库提供 timeoutMs/tags，采样提供原始计时。旧记录没有题库条目时按无预算处理。 */
export function latencyInputOf(results: readonly QuestionResult[]): LatencyQuestionInput[] {
  const byId = new Map(QUESTION_BANK.map((question) => [question.id, question]));
  return results.map((result) => {
    const question = byId.get(result.questionId);
    return {
      questionId: result.questionId,
      group: result.group,
      ...(question?.timeoutMs !== undefined ? { timeoutMs: question.timeoutMs } : {}),
      ...(question?.tags !== undefined ? { tags: question.tags } : {}),
      samples: result.samples.map((sample) => ({
        ...(sample.response.latencyMs !== undefined ? { latencyMs: sample.response.latencyMs } : {}),
        ...(sample.response.ttftMs !== undefined ? { ttftMs: sample.response.ttftMs } : {}),
        ...(sample.response.error !== undefined ? { error: sample.response.error } : {}),
      })),
    };
  });
}

/** 只统计本组；对比基准用全部结果（同端点其他题）。 */
export function latencyReportOf(results: readonly QuestionResult[]): LatencyReport {
  return analyzeLatency(latencyInputOf(results), { scopeGroup: TIMEOUT_GROUP });
}
