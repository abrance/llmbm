/**
 * ModelTrace 指纹排名的展示口径（附加结论，不进能力分）。
 * 铁律：`referenceAccuracy` 是参考库的交叉验证准确率，不是本次置信度；caveat 必须同屏。
 */
import type { ModelTraceRank, ModelTraceResult } from '@llmbm/core';
import type { RunRecord } from './types.js';

export function decisionText(decision: ModelTraceResult['decision']): string {
  if (decision === 'ranked') return '三条样本齐全，给出闭集排名';
  if (decision === 'partial') return '有效样本不足三条，只给排名、不给闭集概率';
  return '未取得有效样本';
}

export function probabilityText(rank: ModelTraceRank): string {
  return typeof rank.probability === 'number' ? `${(rank.probability * 100).toFixed(1)}%` : '—';
}

/** 参考库属性说明：必须与数值同屏出现。 */
export function referenceAccuracyText(result: ModelTraceResult): string {
  if (result.referenceAccuracy === null) return '参考库没有该样本数下的交叉验证记录（不是本次置信度）。';
  return `参考库在该样本数（${result.used} 条）下的交叉验证准确率：${(result.referenceAccuracy * 100).toFixed(1)}%（库属性，不是本次运行的置信度）。`;
}

/** 闭集 top-1 概率说明；未标定时明确说不可用，不拿排名分冒充概率。 */
export function topProbabilityText(result: ModelTraceResult): string {
  if (result.probabilityStatus === 'reference-calibrated' && typeof result.probability === 'number') {
    return `闭集内 top-1 概率 ${(result.probability * 100).toFixed(1)}%（只与库内模型比较，不含库外模型）`;
  }
  if (result.decision === 'ranked') return '参考库缺少标定，本次不提供闭集概率（排名仍有效）';
  return '有效样本不足三条，本次不提供闭集概率';
}

/** 没有 modelTrace 结果时的说明：优先给失败原因，其次区分「跑了但没完成」与「旧记录未采集」。 */
export function modelTraceMissingText(
  run: Pick<RunRecord, 'modelTraceRequested' | 'modelTraceError'>,
): string {
  if (run.modelTraceError) return `未取得有效样本（探针失败：${run.modelTraceError}）`;
  if (run.modelTraceRequested)
    return '本次探针没有跑完（刷新或关闭页面会中断探针；不影响能力分与结果保存）。';
  return '本次未采集（旧记录没有这一项）。';
}

/** 导出用段落；旧记录写「本次未采集」，开关打开但没拿到结果时写失败原因或未完成。 */
export function modelTraceMarkdownBlock(run: Pick<RunRecord, 'modelTrace' | 'modelTraceRequested' | 'modelTraceError'>): string[] {
  const lines: string[] = [];
  const result = run.modelTrace;
  if (!result) {
    lines.push(modelTraceMissingText(run));
    return lines;
  }
  lines.push(`- 结论：${decisionText(result.decision)}（有效样本 ${result.used}/${result.queries} 条）`);
  lines.push(`- ${topProbabilityText(result)}`);
  lines.push(`- ${referenceAccuracyText(result)}`);
  lines.push('');
  if (result.ranking.length === 0) {
    lines.push('没有可展示的排名。');
  } else {
    lines.push('| 排名 | 模型 | 家族 | score | 闭集概率 |');
    lines.push('|---|---|---|---|---|');
    result.ranking.forEach((rank, index) => {
      lines.push(
        `| ${index + 1} | ${rank.display_name} | ${rank.family_name} | ${rank.score.toFixed(3)} | ${probabilityText(rank)} |`,
      );
    });
  }
  const failed = result.samples.filter((s) => !s.accepted);
  if (failed.length > 0) {
    lines.push('');
    lines.push(
      `未采用样本：${failed.map((s) => `#${s.index + 1}（${s.error ?? `有效整数 ${s.parsedNumbers}/${s.minimumNumbers}`}）`).join('；')}`,
    );
  }
  lines.push('');
  lines.push(`> ${result.caveat}`);
  return lines;
}
