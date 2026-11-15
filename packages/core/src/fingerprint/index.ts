/**
 * F9 家族指纹 / F10 退化检测 —— **弱信号**，不是权威结论。
 *
 * 这两项在原站（apitest.work）被包装成「这家中转站偷偷换成了小模型」的定论，
 * 但只用响应文本与用量就能下的判断，本质上只是可疑度排序。所以这里刻意做了三件事：
 *   1. 每个输出都带 `weak: true` 与 `caveat`，调用方无法把它当布尔结论用；
 *   2. `confidence` 只表示「这条信号自身有多确定」，**不是**「降智概率」；
 *   3. 没有历史基线时 `verdict` 只能是 `insufficient-data`，绝不猜。
 *
 * 判定口径：全部基于已抓到的响应原文与 usage，不联网、不调模型（D1）。
 */
import type { JudgeCheck, ModelResponse } from '../types.js';

/** 所有 F9/F10 输出的公共外壳。 */
export interface WeakSignal {
  weak: true;
  /** 0~1：本条信号自身的确定性，不是「模型降智」的概率。 */
  confidence: number;
  /** 支撑该信号的可核对依据，逐条对应可观测量。 */
  basis: string[];
  /** 展示时必须一起出现的一句话，禁止只显示数值。 */
  caveat: string;
}

const WEAK_CAVEAT =
  '弱信号：只反映响应形态，不能据此判定「被换成小模型」或「降智」；需要同一端点、同一题库的历史基线才可对比。';

/* ------------------------------------------------------------------ F10 退化 */

export interface DegradationSignal extends WeakSignal {
  /** 重复行占比 0~1（行去重后剩余比例）。 */
  repeatRatio: number;
  /** 末尾 5 个非空行出现 3 行以上相同 → 复读尾巴。 */
  tailLoop: boolean;
  /** 相对同题其他采样的长度萎缩比 0~1；无 peer 时为 0 且 confidence 降低。 */
  lengthCollapse: number;
  /** 是否命中任一退化信号（阈值只在这里定义，展示方不要自己再判一次）。 */
  flagged: boolean;
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function repeatRatioOf(text: string): number {
  const lines = nonEmptyLines(text);
  if (lines.length < 2) return 0;
  const unique = new Set(lines).size;
  return Math.max(0, Math.min(1, 1 - unique / lines.length));
}

function tailLoopOf(text: string): boolean {
  const lines = nonEmptyLines(text);
  if (lines.length < 3) return false;
  const tail = lines.slice(-5);
  const counts = new Map<string, number>();
  for (const line of tail) counts.set(line, (counts.get(line) ?? 0) + 1);
  return [...counts.values()].some((c) => c >= 3);
}

/**
 * 单条响应的退化信号。`peers` 传同一题的其他采样正文，用于看长度萎缩。
 */
export function degradationOf(text: string, peers: readonly string[] = []): DegradationSignal {
  const repeatRatio = repeatRatioOf(text);
  const tailLoop = tailLoopOf(text);
  const own = text.trim().length;
  const peerLens = peers.map((p) => p.trim().length).filter((n) => n > 0);
  const peerMean = peerLens.length === 0 ? 0 : peerLens.reduce((a, b) => a + b, 0) / peerLens.length;
  const lengthCollapse = peerMean > 0 && own < peerMean ? Math.min(1, 1 - own / peerMean) : 0;

  const basis: string[] = [
    `重复行占比 ${(repeatRatio * 100).toFixed(1)}%（非空行 ${nonEmptyLines(text).length} 行）`,
    tailLoop ? '末尾存在 3 行以上重复（复读尾巴）' : '末尾未见复读',
  ];
  if (peerMean > 0) basis.push(`本题同批采样平均 ${Math.round(peerMean)} 字，本条 ${own} 字，萎缩 ${(lengthCollapse * 100).toFixed(1)}%`);
  else basis.push('本题无其他采样可比，长度萎缩不参与判定');

  let confidence = 0;
  if (repeatRatio >= 0.5) confidence += 0.5;
  else if (repeatRatio >= 0.3) confidence += 0.3;
  if (tailLoop) confidence += 0.3;
  if (lengthCollapse >= 0.5) confidence += 0.2;
  else if (lengthCollapse >= 0.3) confidence += 0.1;
  if (peerMean === 0) confidence *= 0.6;

  return {
    weak: true,
    confidence: Math.min(1, Number(confidence.toFixed(2))),
    basis,
    caveat: WEAK_CAVEAT,
    repeatRatio,
    tailLoop,
    lengthCollapse,
    flagged: confidence > 0,
  };
}

/* ------------------------------------------------------------------ F9 指纹 */

export interface FingerprintFeatures {
  /** 平均正文字数。 */
  meanChars: number;
  /** 带 reasoning/thinking 的响应占比 0~1。 */
  reasoningShare: number;
  /** 出现 tool_calls 的响应占比 0~1。 */
  toolCallRate: number;
  /** 被判为拒答的响应占比 0~1（由 judge 结果给出，不由本模块推断）。 */
  refusalRate: number;
  samples: number;
}

export interface ModelFingerprint extends WeakSignal {
  features: FingerprintFeatures;
  /** 只有拿到基线且偏差显著时才给 suspect-degraded；否则 insufficient-data / no-anomaly。 */
  verdict: 'insufficient-data' | 'no-anomaly' | 'suspect-degraded';
  /** 与基线相比的偏离项，便于人复核。 */
  deviations: string[];
}

export interface FingerprintInput {
  responses: readonly ModelResponse[];
  /** 已由 judge 判定为拒答的条数；缺省 0。 */
  refusals?: number;
  /** 该端点此前的指纹；没有就传 undefined。 */
  baseline?: FingerprintFeatures;
}

export function featuresOf({ responses, refusals = 0 }: FingerprintInput): FingerprintFeatures {
  const samples = responses.length;
  if (samples === 0) return { meanChars: 0, reasoningShare: 0, toolCallRate: 0, refusalRate: 0, samples: 0 };
  const chars = responses.reduce((a, r) => a + (r.text ?? '').trim().length, 0);
  const withReasoning = responses.filter((r) => (r.reasoning ?? '').trim().length > 0).length;
  const withTools = responses.filter((r) => (r.toolCalls?.length ?? 0) > 0).length;
  const round = (x: number) => Number(x.toFixed(3));
  return {
    meanChars: Math.round(chars / samples),
    reasoningShare: round(withReasoning / samples),
    toolCallRate: round(withTools / samples),
    refusalRate: round(refusals / samples),
    samples,
  };
}

/** 正文长度掉到基线 60% 以下，或工具调用率掉 50% 以上 → 记为偏离。 */
function deviationsFrom(f: FingerprintFeatures, base: FingerprintFeatures): string[] {
  const out: string[] = [];
  if (base.meanChars > 0 && f.meanChars < base.meanChars * 0.6) {
    out.push(`平均正文 ${f.meanChars} 字，基线 ${base.meanChars} 字（低于 60%）`);
  }
  if (base.toolCallRate > 0 && f.toolCallRate < base.toolCallRate * 0.5) {
    out.push(`工具调用率 ${(f.toolCallRate * 100).toFixed(0)}%，基线 ${(base.toolCallRate * 100).toFixed(0)}%（低于一半）`);
  }
  if (base.refusalRate >= 0 && f.refusalRate > base.refusalRate + 0.3) {
    out.push(`拒答率 ${(f.refusalRate * 100).toFixed(0)}%，基线 ${(base.refusalRate * 100).toFixed(0)}%（高出 30 个百分点）`);
  }
  return out;
}

export function fingerprintOf(input: FingerprintInput): ModelFingerprint {
  const features = featuresOf(input);
  if (features.samples === 0) {
    return {
      weak: true,
      confidence: 0,
      basis: ['本次没有任何响应可算特征'],
      caveat: WEAK_CAVEAT,
      features,
      verdict: 'insufficient-data',
      deviations: [],
    };
  }

  const base = input.baseline;
  if (!base || base.samples === 0) {
    return {
      weak: true,
      confidence: 0.2,
      basis: [`本次 ${features.samples} 条响应：平均 ${features.meanChars} 字、reasoning ${(features.reasoningShare * 100).toFixed(0)}%、工具调用 ${(features.toolCallRate * 100).toFixed(0)}%`, '该端点没有历史基线，无法判断是否变化'],
      caveat: WEAK_CAVEAT,
      features,
      verdict: 'insufficient-data',
      deviations: [],
    };
  }

  const deviations = deviationsFrom(features, base);
  return {
    weak: true,
    confidence: deviations.length === 0 ? 0.3 : Math.min(0.6, 0.4 + 0.1 * deviations.length),
    basis: [
      `本次 ${features.samples} 条 vs 基线 ${base.samples} 条`,
      ...(deviations.length > 0 ? deviations : ['三项特征（正文长度 / 工具调用 / 拒答率）均未超出阈值']),
    ],
    caveat: WEAK_CAVEAT,
    features,
    verdict: deviations.length === 0 ? 'no-anomaly' : 'suspect-degraded',
    deviations,
  };
}

/* ------------------------------------------------------- 一次跑测的整体弱信号 */

/**
 * 该次采样是否被判为拒答（只看 refusal judge 自己的检查，不从正文猜）。
 * 拒答题命中了标记 → 是拒答；不该拒答的题反而拒了 → 也是拒答。
 */
export function isRefusalSample(checks: readonly JudgeCheck[]): boolean {
  return checks.some((c) => (c.name === 'refusal.marker' && c.pass) || (c.name === 'refusal.no-false-refusal' && !c.pass));
}

/** 一条参与弱信号判定的采样：判定结果用来数拒答率，正文用来算退化。 */
export interface SignalSample {
  response: ModelResponse;
  checks?: readonly JudgeCheck[];
}

/** 一次跑测的退化汇总（F10）：只报「有几条命中」，不定性。 */
export interface DegradationSummary extends WeakSignal {
  /** 命中退化信号的采样数。 */
  flagged: number;
  /** 参与判定的采样总数。 */
  samples: number;
  /** confidence 最高的一条；没有采样时为 undefined。 */
  worst?: DegradationSignal;
}

export interface RunSignalInput {
  /** 按题分组的有效采样（传输失败的采样不参与），顺序不影响结果。 */
  samplesByQuestion: readonly (readonly SignalSample[])[];
  /** 该端点历史指纹；没有就不传 —— 此时 verdict 只能是 insufficient-data。 */
  baseline?: FingerprintFeatures;
}

export interface RunSignals {
  fingerprint: ModelFingerprint;
  degradation: DegradationSummary;
}

function degradationSummaryOf(groups: readonly (readonly SignalSample[])[]): DegradationSummary {
  let flagged = 0;
  let samples = 0;
  let worst: DegradationSignal | undefined;
  for (const group of groups) {
    const texts = group.map((s) => s.response.text ?? '');
    texts.forEach((text, index) => {
      samples += 1;
      const peers = texts.filter((_, i) => i !== index);
      const signal = degradationOf(text, peers);
      if (signal.flagged) flagged += 1;
      if (!worst || signal.confidence > worst.confidence) worst = signal;
    });
  }
  if (!worst) {
    return {
      weak: true,
      confidence: 0,
      basis: ['本次没有可判定的采样'],
      caveat: WEAK_CAVEAT,
      flagged: 0,
      samples: 0,
    };
  }
  return {
    weak: true,
    confidence: worst.confidence,
    basis: [`${flagged}/${samples} 条采样命中退化信号`, ...worst.basis],
    caveat: WEAK_CAVEAT,
    flagged,
    samples,
    worst,
  };
}

/**
 * 一次跑测的 F9 + F10 汇总。web / api 只调这一个函数，特征计算只有这里一份（D1）。
 * 没有 baseline 时指纹 verdict 恒为 `insufficient-data`，绝不从单次形态猜「降智」。
 */
export function runSignalsOf(input: RunSignalInput): RunSignals {
  const flat = input.samplesByQuestion.flat();
  const refusals = flat.filter((s) => isRefusalSample(s.checks ?? [])).length;
  return {
    fingerprint: fingerprintOf({
      responses: flat.map((s) => s.response),
      refusals,
      ...(input.baseline ? { baseline: input.baseline } : {}),
    }),
    degradation: degradationSummaryOf(input.samplesByQuestion),
  };
}

export * from './model-trace/index.js';
