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
  lines.push(`### 超时与响应时延（${report.samples} 次采样）`);
  lines.push('');
  for (const headline of report.headlines) lines.push(`- ${headline}`);
  if (report.samples > 0) {
    lines.push('');
    lines.push('| 题目 | 超时率 | TTFT p50 | TTFT p95 | TTFT max | 总耗时 p50 | 总耗时 p95 | 总耗时 max | 预算 | 结论 |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const question of report.questions) {
      lines.push(
        `| ${question.questionId} | ${question.timeouts}/${question.samples}（${(question.timeoutRate * 100).toFixed(0)}%） | ${ms(question.ttft.p50)} | ${ms(question.ttft.p95)} | ${ms(question.ttft.max)} | ${ms(question.total.p50)} | ${ms(question.total.p95)} | ${ms(question.total.max)} | ${question.timeoutMs > 0 ? ms(question.timeoutMs) : '—'} | ${VERDICT_LABEL[question.verdict] ?? question.verdict} |`,
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
