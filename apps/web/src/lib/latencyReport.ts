/**
 * 「超时与响应时延」分组的统计入口：题库元数据（timeoutMs/tags）+ 每次采样的原始计时 + 跑测状态。
 * 结果页卡片与 Markdown 导出都走这一份，口径与 lib/latency.ts 完全一致。
 */
import type { TransportAttempt } from './transport.js';
import { QUESTION_BANK } from '../data/bank.js';
import { analyzeLatency, type LatencyQuestionInput, type LatencyReport } from './latency.js';
import type { QuestionResult, RunRecord } from './types.js';

export const TIMEOUT_GROUP = 'timeout';

/** 结果 → 统计输入：题库提供 timeoutMs/tags，采样提供原始计时与 attempt 明细。 */
export function latencyInputOf(results: readonly QuestionResult[]): LatencyQuestionInput[] {
  const byId = new Map(QUESTION_BANK.map((question) => [question.id, question]));
  return results.map((result) => {
    const question = byId.get(result.questionId);
    return {
      questionId: result.questionId,
      group: result.group,
      ...(question?.timeoutMs !== undefined ? { timeoutMs: question.timeoutMs } : {}),
      ...(question?.tags !== undefined ? { tags: question.tags } : {}),
      samples: result.samples.map((sample) => {
        const response = sample.response;
        const attempts = (response as { attemptLog?: TransportAttempt[] }).attemptLog;
        return {
          ...(response.latencyMs !== undefined ? { latencyMs: response.latencyMs } : {}),
          ...(response.ttftMs !== undefined ? { ttftMs: response.ttftMs } : {}),
          ...(response.lastChunkAtMs !== undefined ? { lastChunkAtMs: response.lastChunkAtMs } : {}),
          ...(response.chunks !== undefined ? { chunks: response.chunks } : {}),
          ...(response.phase !== undefined ? { phase: response.phase } : {}),
          ...(response.httpStatus !== undefined ? { httpStatus: response.httpStatus } : {}),
          ...(response.error !== undefined ? { error: response.error } : {}),
          ...(attempts !== undefined ? { attempts } : {}),
        };
      }),
    };
  });
}

/**
 * 本组计划发起的采样数：只在本次勾选了该组时才有值，否则 0（结果页写「本次没跑该组」）。
 * 正常跑完的卷没有「未发起」，用已发起数收口，避免按题库总数算出假缺口；
 * 只有取消/短路才用题库题数 × 每题采样去估「本来应该跑多少」。
 */
function plannedSamples(run: RunRecord, initiated: number): number {
  if (!run.groups.includes(TIMEOUT_GROUP)) return initiated;
  if (!run.cancelled && !run.abortReason) return initiated;
  const questions = QUESTION_BANK.filter((question) => question.group === TIMEOUT_GROUP).length;
  return Math.max(initiated, questions * Math.max(1, run.samples));
}

/**
 * 只统计本组；对比基准用全部结果（同端点其他题）。
 * 没发起的采样分成两种：用户取消（不进超时率分母）与端点短路（账户/配置不可用提前终止）。
 */
export function latencyReportOf(run: RunRecord): LatencyReport {
  const inputs = latencyInputOf(run.results);
  const scoped = inputs.filter((question) => question.group === TIMEOUT_GROUP);
  const initiated = scoped.reduce((sum, question) => sum + question.samples.length, 0);
  const expected = plannedSamples(run, initiated);
  const gap = Math.max(0, expected - initiated);
  const notRun = run.abortReason ? gap : 0;
  const cancelled = run.abortReason ? 0 : run.cancelled ? gap : 0;
  return analyzeLatency(inputs, { scopeGroup: TIMEOUT_GROUP, expected, cancelled, notRun });
}

