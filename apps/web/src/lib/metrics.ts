/**
 * 跑测页/结果页的纯展示计算：进度、ETA、退化信号、问题探针。
 * 不参与判分（判分只在 core），这里只把已有结果整理成可读信息。
 */
import type { QuestionResult, Probe } from './types.js';

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/** 线性 ETA：已耗时 / 已完成 × 剩余；样本太少（<1 题）时返回 undefined。 */
export function etaMs(done: number, total: number, elapsedMs: number): number | undefined {
  if (done <= 0 || total <= done || elapsedMs <= 0) return undefined;
  return (elapsedMs / done) * (total - done);
}

export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (done / total) * 100));
}

/** 行去重比例：重复行占比越高越可能是复读/退化。非判分项，只作证据展示。 */
export function repeatRatio(text: string): number {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return 0;
  const unique = new Set(lines).size;
  return Math.max(0, Math.min(1, 1 - unique / lines.length));
}

export function scoreRange(mean: number, halfWidth: number): { low: number; high: number } {
  return {
    low: Math.max(0, Math.min(100, mean - halfWidth)),
    high: Math.max(0, Math.min(100, mean + halfWidth)),
  };
}

function reasonOf(result: QuestionResult): string {
  const failing: string[] = [];
  const last = result.samples[result.samples.length - 1];
  if (last?.response.error) failing.push(last.response.error);
  for (const sample of result.samples) {
    for (const check of sample.checks) {
      if (!check.pass) failing.push(check.detail ? `${check.name}：${check.detail}` : check.name);
    }
  }
  const unique = [...new Set(failing)].slice(0, 3);
  return unique.length > 0 ? unique.join('；') : '分数未达 pass 阈值';
}

/** 问题探针 = 非 pass 的题；补测/导出/榜单都只看这一份。 */
export function probesOf(results: readonly QuestionResult[]): Probe[] {
  return results
    .filter((r) => r.status !== 'pass')
    .map((r) => ({
      questionId: r.questionId,
      group: r.group,
      judge: r.judge,
      status: r.status,
      score: Number(r.mean.toFixed(1)),
      reason: reasonOf(r),
    }))
    .sort((a, b) => a.score - b.score);
}

export function failedIds(results: readonly QuestionResult[]): string[] {
  return results.filter((r) => r.status !== 'pass').map((r) => r.questionId);
}
