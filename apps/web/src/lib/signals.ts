/**
 * F9/F10 弱信号的输入准备：只做「按题分组 + 剔掉传输失败」，特征与阈值全在 core。
 * worker（正常跑测）与 RunProvider（补测合并后重算）共用这一份，避免两处口径漂移。
 */
import { runSignalsOf, type ModelFingerprint, type RunSignals, type SignalSample } from '@llmbm/core';
import type { QuestionResult, RunRecord } from './types.js';

export function signalSamplesOf(results: readonly QuestionResult[]): SignalSample[][] {
  return results.map((result) =>
    result.samples
      // D5：传输失败的空正文会被当成「长度萎缩」，且与聚合口径不一致，不进弱信号。
      .filter((s) => s.score.transportError !== true)
      .map((s) => ({ response: s.response, checks: s.checks })),
  );
}

/** 无基线：verdict 恒为 insufficient-data（基线持久化是后置项）。 */
export function signalsOf(results: readonly QuestionResult[]): RunSignals {
  return runSignalsOf({ samplesByQuestion: signalSamplesOf(results) });
}

/** 弱信号一律不写成结论；insufficient-data 要明确说「无法判断是否变化」。 */
export function verdictText(verdict: ModelFingerprint['verdict']): string {
  if (verdict === 'suspect-degraded') return '本次与基线有偏离（未确认降级）';
  if (verdict === 'no-anomaly') return '与基线相比未见明显偏离';
  return '该端点没有历史基线，本次无法判断是否变化';
}

/**
 * 导出用段落：数值与 caveat 必须同时出现。旧记录（无字段）写「本次未采集」，不报错。
 * 放在这里而不是 export.ts，是为了让单测能直接验这段文本（export.ts 依赖题库 JSON）。
 */
export function signalMarkdownBlock(run: Pick<RunRecord, 'fingerprint' | 'degradation'>): string[] {
  const lines: string[] = [];
  const fp = run.fingerprint;
  const deg = run.degradation;
  if (!fp && !deg) {
    lines.push('本次未采集（旧记录没有这一项）。');
    return lines;
  }
  if (fp) {
    const f = fp.features;
    lines.push('### 指纹特征');
    lines.push('');
    lines.push(`- 判定：${verdictText(fp.verdict)}（置信 ${(fp.confidence * 100).toFixed(0)}%）`);
    lines.push(
      `- 平均正文 ${f.meanChars} 字；reasoning 占比 ${(f.reasoningShare * 100).toFixed(0)}%；工具调用率 ${(f.toolCallRate * 100).toFixed(0)}%；拒答率 ${(f.refusalRate * 100).toFixed(0)}%；样本 ${f.samples} 条`,
    );
    for (const item of fp.basis) lines.push(`- 依据：${item}`);
    for (const item of fp.deviations) lines.push(`- 偏离：${item}`);
    lines.push('');
    lines.push(`> 弱信号说明：${fp.caveat}`);
    lines.push('');
  }
  if (deg) {
    lines.push('### 退化');
    lines.push('');
    lines.push(`- 命中 ${deg.flagged}/${deg.samples} 条采样（置信 ${(deg.confidence * 100).toFixed(0)}%）`);
    for (const item of deg.basis) lines.push(`- 依据：${item}`);
    if (deg.worst) {
      lines.push(
        `- 最可疑一条：重复行 ${(deg.worst.repeatRatio * 100).toFixed(1)}%、长度萎缩 ${(deg.worst.lengthCollapse * 100).toFixed(1)}%、复读尾巴 ${deg.worst.tailLoop ? '有' : '无'}`,
      );
    }
    lines.push('');
    lines.push(`> 弱信号说明：${deg.caveat}`);
    lines.push('');
  }
  return lines;
}
