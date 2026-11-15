/**
 * ModelTrace 指纹排名 + 探针（附加结论，不参与能力分 / judge 分数）。
 *
 * 打分实现：`scoring.ts`（移植自 lm-detector 的 fingerprint-core.js，MIT, Copyright (c) 2026 xqy2006）。
 * 探针通路：`probe.ts`（复用现有 adapter 构造请求体，不新写 HTTP 客户端）。
 * 参考库加载：`loader.ts`（只读仓库内精简库，运行时不下载）。
 */
export {
  parseNumbers,
  countNumbers,
  hellingerFeature,
  orderedBlockFeature,
  robustScoreNumbers,
  VALUE_MIN,
  VALUE_MAX,
  DIMENSION,
  ALPHA,
} from './scoring.js';
export type { ScoringBank, FeatureBlock, HellingerBlock, OrderedBlock, BankModelMeta } from './scoring.js';

export {
  buildProbeChallenges,
  minValidNumbers,
  analyzeProbeWithChallenges,
  runModelTraceProbe,
} from './probe.js';
export type {
  ProbeChallenge,
  ProbeSend,
  ProbeSampleResult,
  ModelTraceRank,
  ModelTraceResult,
  RunModelTraceProbeOptions,
} from './probe.js';

export { loadModelTraceBank, validateBank, bankModels, resetModelTraceBankCache } from './loader.js';
export type { ModelTraceBank } from './loader.js';
