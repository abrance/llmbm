/**
 * 「超时与响应时延」的 Markdown 段落（导出用）。输入是统计结果本身，
 * 不在这里重复任何阈值或分位数算法。
 */
import type { LatencyReport } from './latency.js';

const VERDICT_LABEL: Record<string, string> = {
  'all-timeout': '全部超时',
  'partial-timeout': '部分超时',
  'slower-than-peers': '本题偏慢',
  'no-data': '无采样',
  normal: '正常',
};

function ms(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

export function latencyMarkdownBlock(report: LatencyReport): string[] {
  const lines: string[] = [];
  lines.push(`### 超时与响应时延（已发起 ${report.initiated} 次，计划 ${report.expected} 次）`);
  lines.push('');
  for (const headline of report.headlines) lines.push(`- ${headline}`);
  if (report.initiated > 0) {
    lines.push('');
    lines.push(
      `- 分母：已发起 ${report.initiated}（成功 ${report.completed} / 超时 ${report.timedOut} / 其他失败 ${report.failed}），` +
        `未发起 ${report.cancelled + report.notRun}（取消 ${report.cancelled}、短路 ${report.notRun}）。`,
    );
    lines.push('- 分位数只统计成功完成的采样；超时是「等到阈值仍未完成」，不计入完成时延。');
    if (report.attempt.retriedSamples > 0) {
      lines.push(
        `- 重试：${report.attempt.retriedSamples} 次采样重试过（attempt 共 ${report.attempt.attempts} 次，其中 ${report.attempt.timeoutAttempts} 次 attempt 超时）；attempt 级明细不与逻辑采样混算。`,
      );
    }
    lines.push('');
    lines.push(
      '| 题目 | 发起 | 成功 | 超时 | 其他失败 | 超时率 | TTFT p50 | TTFT p95 | TTFT max | 总耗时 p50 | 总耗时 p95 | 总耗时 max | 预算 | 结论 |',
    );
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const question of report.questions) {
      lines.push(
        `| ${question.questionId} | ${question.samples} | ${question.samples - question.timeouts - question.otherErrors} | ${question.timeouts} | ${question.otherErrors} | ` +
          `${question.timeouts}/${question.samples}（${(question.timeoutRate * 100).toFixed(0)}%） | ${ms(question.ttft.p50)} | ${ms(question.ttft.p95)} | ${ms(question.ttft.max)} | ` +
          `${ms(question.total.p50)} | ${ms(question.total.p95)} | ${ms(question.total.max)} | ${question.timeoutMs > 0 ? ms(question.timeoutMs) : '—'} | ${VERDICT_LABEL[question.verdict] ?? question.verdict} |`,
      );
    }
    for (const question of report.questions) {
      lines.push('');
      lines.push(`- ${question.questionId}（超时与响应时延）：${question.sentences.join(' ')}`);
    }
  }
  lines.push('');
  return lines;
}
