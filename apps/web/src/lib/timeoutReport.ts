/**
 * F14 超时归因的汇总与导出段落（纯函数、不依赖题库，题库元数据由调用方传入）。
 *
 * 归因类别与判定只有 core 一份（`classifyTimeout`）；这里只收集 transport 报上来的进度事实、
 * 数分布、生成中文标签与 Markdown，不写第二份阈值。
 */
import { classifyTimeout, type TimeoutClass } from '@llmbm/core';
import type { QuestionResult, TimeoutReport, TimeoutSample } from './types.js';

/* ------------------------------------------------------------------ F14 超时归因 */

/** 归因类别与语义只有 core 一份（`classifyTimeout`）；这里只提供展示顺序与中文标签。 */
export const TIMEOUT_CLASSES: readonly TimeoutClass[] = [
  'connect',
  'first-token',
  'mid-stream',
  'rate-limit',
  'gateway',
  'unknown',
];

export const TIMEOUT_CLASS_LABEL: Record<TimeoutClass, string> = {
  connect: '连接/响应前',
  'first-token': '首字前超时',
  'mid-stream': '流中途断掉',
  'rate-limit': '限流',
  gateway: '网关错误',
  unknown: '其它/未知',
};

/**
 * 逐采样归因：分类交给 core 的 `classifyTimeout`，这里只收集 transport 报上来的进度事实。
 * 没有错误采样时返回空分布（展示层据此整块不渲染）。
 */
export function timeoutReportOf(
  results: readonly QuestionResult[],
  timeoutOf: (questionId: string) => number | undefined = () => undefined,
): TimeoutReport {
  const byClass = Object.fromEntries(TIMEOUT_CLASSES.map((key) => [key, 0])) as Record<TimeoutClass, number>;
  const entries: TimeoutSample[] = [];
  let requests = 0;

  for (const result of results) {
    for (const sample of result.samples) {
      requests += 1;
      const response = sample.response;
      const error = response.error;
      if (!error) continue;
      const timeoutMs = timeoutOf(result.questionId);
      const kind = classifyTimeout({
        error,
        ...(response.httpStatus !== undefined ? { httpStatus: response.httpStatus } : {}),
        ...(response.latencyMs !== undefined ? { latencyMs: response.latencyMs } : {}),
        ...(response.ttftMs !== undefined ? { ttftMs: response.ttftMs } : {}),
        ...(response.lastChunkAtMs !== undefined ? { lastChunkAtMs: response.lastChunkAtMs } : {}),
        ...(response.chunks !== undefined ? { chunks: response.chunks } : {}),
        ...(response.phase !== undefined ? { phase: response.phase } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      byClass[kind] += 1;
      entries.push({
        questionId: result.questionId,
        group: result.group,
        sampleIndex: sample.index,
        error,
        class: kind,
        ...(response.httpStatus !== undefined ? { httpStatus: response.httpStatus } : {}),
        ...(response.latencyMs !== undefined ? { latencyMs: response.latencyMs } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    }
  }

  return { requests, samples: entries.length, byClass, entries };
}

export function timeoutShare(report: TimeoutReport, kind: TimeoutClass): number {
  return report.samples === 0 ? 0 : report.byClass[kind] / report.samples;
}

/** 导出用段落；旧记录（无 report.timeout）明确写「本次未采集」。 */
export function timeoutMarkdownBlock(report: TimeoutReport | undefined): string[] {
  const lines: string[] = [];
  if (!report) {
    lines.push('本次未采集（旧记录没有超时归因）。');
    return lines;
  }
  if (report.samples === 0) {
    lines.push(`本次 ${report.requests} 次请求没有传输错误采样，未产生超时归因。`);
    return lines;
  }
  lines.push(`- 传输错误采样：${report.samples}/${report.requests} 次`);
  lines.push('');
  lines.push('| 类别 | 次数 | 占错误采样 |');
  lines.push('|---|---|---|');
  for (const kind of TIMEOUT_CLASSES) {
    lines.push(
      `| ${TIMEOUT_CLASS_LABEL[kind]} | ${report.byClass[kind]} | ${(timeoutShare(report, kind) * 100).toFixed(0)}% |`,
    );
  }
  lines.push('');
  lines.push('按题归因：');
  lines.push('');
  lines.push('| 题号 | 采样 | 类别 | 错误 | 耗时 | 超时设置 |');
  lines.push('|---|---|---|---|---|---|');
  for (const entry of report.entries) {
    const detail = entry.error.replace(/\s+/g, ' ').slice(0, 160).replace(/\|/g, '\\|');
    lines.push(
      `| ${entry.questionId} | #${entry.sampleIndex + 1} | ${TIMEOUT_CLASS_LABEL[entry.class]} | ${detail} | ${entry.latencyMs ?? '—'}ms | ${entry.timeoutMs ?? '—'}ms |`,
    );
  }
  lines.push('');
  lines.push('> 超时归因只解释「这次请求为什么没拿到答案」，不参与能力分与 judge 分数；同一次跑测的能力分不受它影响。');
  return lines;
}
