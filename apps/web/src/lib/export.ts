/**
 * 导出（F11）：把一次跑测导出为 md / json。导出物不含 API Key，也不含请求头。
 */
import { formatStat } from '@llmbm/core';
import { groupLabel } from '../data/bank.js';
import { probesOf } from './metrics.js';
import type { RunRecord } from './types.js';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function timestampForName(date = new Date()): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function safeFilename(input: string, fallback = 'llmbm'): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || fallback;
}

export function exportJson(run: RunRecord): string {
  return JSON.stringify(run, null, 2);
}

function sampleBlock(run: RunRecord, limit = 600): string[] {
  const lines: string[] = [];
  for (const result of run.results) {
    lines.push(`### ${result.questionId} · ${groupLabel(result.group)} · ${result.judge}`);
    lines.push('');
    lines.push(`- 状态：${result.status}；得分：${result.mean.toFixed(1)} ± ${result.halfWidth.toFixed(1)}`);
    lines.push(`- 核心题：${result.core ? '是' : '否'}；权重：${result.weight}`);
    lines.push(`- 题目：${result.prompt}`);
    result.samples.forEach((sample, index) => {
      const text = sample.response.text || '（空响应）';
      const clipped = text.length > limit ? `${text.slice(0, limit)}…` : text;
      lines.push('');
      lines.push(`#### 采样 ${index + 1}（${sample.score.score.toFixed(1)} 分 / ${sample.response.latencyMs ?? '—'}ms）`);
      if (sample.response.error) lines.push(`> 传输错误：${sample.response.error}`);
      lines.push('```text');
      lines.push(clipped);
      lines.push('```');
      const failed = sample.checks.filter((c) => !c.pass);
      if (failed.length > 0) {
        lines.push('');
        lines.push(`未通过检查：${failed.map((c) => (c.detail ? `${c.name}（${c.detail}）` : c.name)).join('；')}`);
      }
    });
    lines.push('');
  }
  return lines;
}

export function exportMarkdown(run: RunRecord): string {
  const report = run.report;
  // 旧断点里没有 D5 的传输字段；缺失时按「无传输失败」导出。
  const transport = report.transport ?? { errors: 0, samples: 0, rate: 0 };
  const sampleCounts = report.samples ?? { valid: 0, total: 0 };
  const lines: string[] = [];
  lines.push('# llmbm 可信度报告');
  lines.push('');
  lines.push(`- 端点：${run.endpoint.domain}`);
  lines.push(`- 模型：${run.endpoint.model}（${run.endpoint.protocol}）`);
  lines.push(`- 能力分：${report.total.mean.toFixed(2)} ± ${report.total.halfWidth.toFixed(2)}（${report.total.n} 题，每题 ${run.samples} 次采样）`);
  lines.push(
    `- 传输错误：${(transport.rate * 100).toFixed(1)}%（${transport.errors}/${transport.samples} 次请求没收到答案，已从能力分聚合剔除；有效采样 ${sampleCounts.valid}/${sampleCounts.total}）`,
  );
  lines.push(`- 格式命中率：${(report.format.rate * 100).toFixed(1)}%（${report.format.hit}/${report.format.total}）`);
  lines.push(
    `- 稳定性：${(report.stability.rate * 100).toFixed(1)}%（有效采样 ${report.samples.valid}/${report.samples.total}，完成 ${report.stability.completed}/${report.stability.expected} 题）`,
  );
  lines.push(`- 通过 / 待复核 / 失败：${report.counts.pass} / ${report.counts.pending} / ${report.counts.fail}`);
  for (const notice of run.notices ?? []) lines.push(`- 被容忍的失败：${notice}`);
  lines.push(`- 题库版本：${run.questionBankVersion}`);
  lines.push(`- 判定规则版本：${run.judgeRuleVersion}`);
  lines.push(`- 随机种子：${run.seed}；每题采样：${run.samples} 次`);
  lines.push(`- 开始 / 结束：${run.startedAt} / ${run.finishedAt ?? '—'}`);
  lines.push('');
  lines.push('> 区间（± 半宽）只反映同一模型多次采样的离散度，不覆盖题库覆盖度与判定口径差异；temperature=0 下采样可能完全一致，± 0.00 不等于高置信。');
  lines.push('');

  lines.push('## 维度得分');
  lines.push('');
  lines.push('| 维度 | 得分 | 题数 |');
  lines.push('|---|---|---|');
  for (const dim of report.dimensions) {
    lines.push(`| ${groupLabel(dim.dimension)} | ${formatStat(dim.stat)} | ${dim.questions} |`);
  }
  lines.push('');

  const probes = probesOf(run.results);
  lines.push('## 问题探针');
  lines.push('');
  if (probes.length === 0) {
    lines.push('本次没有失败或待复核的题。');
  } else {
    lines.push('| 题号 | 维度 | 判定 | 状态 | 分数 | 原因 |');
    lines.push('|---|---|---|---|---|---|');
    for (const probe of probes) {
      lines.push(`| ${probe.questionId} | ${groupLabel(probe.group)} | ${probe.judge} | ${probe.status} | ${probe.score} | ${probe.reason.replace(/\|/g, '\\|')} |`);
    }
  }
  lines.push('');

  lines.push('## 证据链');
  lines.push('');
  lines.push(...sampleBlock(run));
  lines.push('---');
  lines.push(`由 llmbm v0.1 导出（${new Date().toISOString()}）。分数按题库版本与规则版本可复现。`);
  return lines.join('\n');
}

/** 浏览器下载；测试环境没有 document 时返回 false，方便单测只测内容。 */
export function download(filename: string, content: string, mime: string): boolean {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export function exportFilename(run: RunRecord, ext: 'md' | 'json'): string {
  return `${safeFilename(`llmbm-${run.endpoint.domain}-${run.endpoint.model}`)}-${timestampForName(new Date(run.startedAt))}.${ext}`;
}
