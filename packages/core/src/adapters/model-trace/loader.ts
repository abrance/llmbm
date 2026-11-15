/**
 * 精简参考库加载器：只读仓库内的 model-trace-bank.json，运行时**不下载**。
 *
 * 该 JSON 由 scripts/build-modeltrace-bank.mjs 从上游 unified_bank.json 抽取生成，
 * 头部 provenance 记录 source_repo / source_commit / source_sha256 / license。
 * 数据量约 1MB，只在首次真正跑探针时按需加载（不在模块顶层加载，避免拖慢 typecheck / 启动）。
 */
import type { BankModelMeta, ScoringBank } from './scoring.js';

/** 精简库文件里的完整形状（打分字段 + 头部溯源 + 展示元数据）。 */
export interface ModelTraceBank extends ScoringBank {
  schema: 'modeltrace-scoring-bank';
  provenance: {
    built_at: string | null;
    source_repo: string;
    source_commit: string | null;
    source_sha256: string | null;
    source_schema?: string;
    source_built_at?: string | null;
    license: string;
    license_copyright: string;
    builder: string;
    note: string;
  };
  method: unknown;
  recommended_queries: number;
  minimum_valid_numbers: number;
}

let cached: ModelTraceBank | undefined;

/**
 * 加载并校验精简库。校验不过直接抛错（能在建库阶段发现，不必等到跑测）。
 * 同一进程内只解析一次。
 */
export async function loadModelTraceBank(): Promise<ModelTraceBank> {
  if (cached) return cached;
  const mod = (await import('./model-trace-bank.json', { with: { type: 'json' } })) as unknown as {
    default: ModelTraceBank;
  };
  cached = validateBank(mod.default);
  return cached;
}

/** 结构校验：字段齐全、维度自洽、model_order 与 models / centroids 对齐。 */
export function validateBank(bank: ModelTraceBank): ModelTraceBank {
  const fail = (message: string): never => {
    throw new Error(`ModelTrace 参考库无效：${message}`);
  };
  if (bank.schema !== 'modeltrace-scoring-bank') fail(`schema 应为 modeltrace-scoring-bank，实际 ${String(bank.schema)}`);
  if (!Array.isArray(bank.model_order) || bank.model_order.length === 0) fail('model_order 为空');
  if (!Array.isArray(bank.models) || bank.models.length !== bank.model_order.length)
    fail('models 数量与 model_order 不一致');
  const modelCount = bank.model_order.length;
  const hellinger = bank.robust?.hellinger;
  const ordered = bank.robust?.ordered_blocks;
  if (!hellinger || !ordered) fail('缺少 robust.hellinger / robust.ordered_blocks');
  if (hellinger.centroids.length !== modelCount) fail('hellinger.centroids 行数与模型数不一致');
  if (ordered.centroids.length !== modelCount) fail('ordered_blocks.centroids 行数与模型数不一致');
  const hDim = hellinger.feature_mean.length;
  if (hellinger.feature_scale.length !== hDim) fail('hellinger feature_mean/scale 维度不一致');
  if (hellinger.centroids[0]?.length !== hDim) fail('hellinger 质心维度与特征维度不一致');
  if (hellinger.feature_mean.some((value) => !Number.isFinite(value))) fail('hellinger.feature_mean 含非有限值');
  const oDim = ordered.feature_mean.length;
  if (ordered.centroids[0]?.length !== oDim) fail('ordered_blocks 质心维度与特征维度不一致');
  if (ordered.environment_centroids.some((env) => env.length !== modelCount)) fail('environment_centroids 维度错位');
  if (!bank.provenance || !bank.provenance.license) fail('缺少 provenance.license');
  return bank;
}

/** 库内模型的展示元数据（家族卡）。 */
export function bankModels(bank: ModelTraceBank): readonly BankModelMeta[] {
  return bank.models;
}

/** 供测试/工具重置缓存。 */
export function resetModelTraceBankCache(): void {
  cached = undefined;
}
