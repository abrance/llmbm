/**
 * F14 超时归因：只在 `sample.response.error` 存在时给失败采样分类，
 * 结果只用于结果页卡片与导出，**不进 judge / 能力分**。
 *
 * 归因是浏览器侧对 transport 错误的解释（web 拥有 transport 与展示），不复制 core 的
 * 判分/聚合逻辑；题库里的超时用例分组由 PR #26 维护，本文件不依赖题库。
 * 旧记录没有 `report.timeout`，展示层按「本次未采集」处理。
 */
import type { ModelResponse } from '@llmbm/core';
import type { QuestionResult, TimeoutClass, TimeoutReport, TimeoutSample } from './types.js';

export type { TimeoutClass };

export const TIMEOUT_CLASSES: readonly TimeoutClass[] = ['connect', 'first-token', 'mid-stream', 'rate-limit', 'gateway', 'unknown'];

export const TIMEOUT_CLASS_LABEL: Record<TimeoutClass, string> = {
  connect: '连接建立失败',
  'first-token': '首字前超时',
  'mid-stream': '流中途断掉',
  'rate-limit': '限流',
  gateway: '网关错误',
  unknown: '其它/未知',
};

export interface TimeoutInput {
  error?: string;
  httpStatus?: number;
  /** 已拿到首字后是否进入流中；由 transport 提供（拿不到时 undefined）。 */
  ttftMs?: number;
  /** 失败前已收到的传输分片数。 */
  chunks?: number;
}

const TIMEOUT_PATTERN = /timeout|timed out|超时|ETIMEDOUT|AbortError|operation was aborted/i;

/**
 * 给一条失败采样归因。状态码优先（429 / 502-504），超时文案再按已收到的分片/首字
 * 区分「连接阶段 / 首字前 / 流中途」；不是超时文案的失败返回 unknown，保留原始错误。
 */
export function classifyTimeout(input: TimeoutInput): TimeoutClass {
  const { httpStatus, error = '', ttftMs, chunks } = input;
  if (httpStatus === 429) return 'rate-limit';
  if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) return 'gateway';
  if (!TIMEOUT_PATTERN.test(error)) return 'unknown';
  if (ttftMs !== undefined || (chunks ?? 0) > 0) return 'mid-stream';
  if (httpStatus !== undefined) return 'first-token';
  return 'connect';
}

function responseTiming(response: ModelResponse): Pick<TimeoutInput, 'ttftMs' | 'chunks'> {
  return {
    ...(response.ttftMs !== undefined ? { ttftMs: response.ttftMs } : {}),
    ...(response.chunks !== undefined ? { chunks: response.chunks } : {}),
  };
}

/** 逐采样归因；没有错误采样时返回空分布（展示层据此不渲染）。
 * `timeoutOf` 由调用方提供（题库在 data/bank.ts），lib 不直接依赖题库以便单测。 */
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
      const error = sample.response.error;
      if (!error) continue;
      const timeoutMs = timeoutOf(result.questionId);
      const response = sample.response;
      const kind = classifyTimeout({
        error,
        ...(response.httpStatus !== undefined ? { httpStatus: response.httpStatus } : {}),
        ...responseTiming(response),
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
    lines.push(`| ${TIMEOUT_CLASS_LABEL[kind]} | ${report.byClass[kind]} | ${(timeoutShare(report, kind) * 100).toFixed(0)}% |`);
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
