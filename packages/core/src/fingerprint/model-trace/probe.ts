/**
 * ModelTrace 探针请求通路与结论聚合。
 *
 * 探针是三条独立的「凭第一反应写出约 300 个 1–355 的整数」挑战。三条回答各自独立，
 * 每条至少 max(80, ceil(expected*0.55)) 个有效整数才算数（lm-detector 口径）。
 *
 * 关键约束：
 *   - **不新写 HTTP 客户端**：请求体一律由现有 `Adapter.buildChatRequest` 构造，
 *     发送交给注入的 `send`（web 的 transport / 测试的假实现）。这里只做协议无关的拼装。
 *   - 探针与普通题共用同一套超时/取消/重试语义：`signal` 透传给 send，单条失败只记该条，
 *     绝不让整卷中断，也绝不抛到调用方（探针只是附加结论）。
 *   - 结果只描述「像哪个库内模型」，**绝不进能力分 / judge 分数**（调用方单独放 modelTrace 块）。
 */
import type { Adapter, ChatRequest, EndpointConfig, ModelResponse, PreparedRequest } from '../../types.js';
import { parseNumbers, robustScoreNumbers, type ScoringBank } from './scoring.js';

const CAVEAT =
  'ModelTrace 探针：只反映「这条回答的数字指纹更接近库内哪个模型的参考样本」，是闭集内排序，不含库外模型；' +
  '闭集概率表示在该参考库覆盖的模型里谁更像，库外模型一定会被归到最相似的候选，不能当「就是它」的结论。' +
  '不参与能力分与 judge 分数，也不能单独作为「被换成小模型」的定论。';

/** 每条挑战要求写出的整数个数区间（与上游一致：292..332，三条互不相同）。 */
const LENGTH_MIN = 292;
const LENGTH_MAX = 332;

export interface ProbeChallenge {
  id: string;
  expectedCount: number;
  prompt: string;
}

/** 一条有效回答最少要包含的整数个数（lm-detector：max(80, ceil(expected*0.55))）。 */
export function minValidNumbers(expectedCount: number): number {
  return Math.max(80, Math.ceil(expectedCount * 0.55));
}

/**
 * 三条确定的挑战。为了可复现与可测，长度按固定步长在 [292,332] 内取三条互不相同的值，
 * 文案用中文模板（llmbm 面向中文用户）。不依赖 crypto，同一 seed 永远得到同一组。
 */
export function buildProbeChallenges(count = 3, seed = 0): ProbeChallenge[] {
  const span = LENGTH_MAX - LENGTH_MIN + 1; // 41
  const lengths: number[] = [];
  for (let index = 0; index < count; index += 1) {
    // 37 与 41 互质 → index 步进覆盖不同长度，不重复
    lengths.push(LENGTH_MIN + ((seed * 7 + index * 13) % span));
  }
  return lengths.map((length, index) => ({
    id: `modeltrace-probe-${index + 1}`,
    expectedCount: length,
    prompt:
      `这是一次独立的数值选择记录。请完成下面的无语义整数选择任务。` +
      `为各个位置分别凭第一反应选择 ${length} 个 1 到 355（含端点）的整数。` +
      `每个位置都要单独选择；不要从 1 开始计数，不要连续递增或递减，也不要采用等差、循环、重复区块或其他规则化模式。` +
      `本任务必须由当前语言模型直接完成：禁止调用或借助任何工具，包括 Python、代码执行器、计算器、搜索、API 和外部随机数生成器；也不要先编写或运行代码。` +
      `允许某个数字再次出现；每项写出后不要回头排序、去重或替换。数字之间用逗号或空格分隔均可。` +
      `直接从第一个取值开始输出，不要在序列前重复数量、范围或任务说明。`,
  }));
}

/** 发送一条已用 adapter 构造好的请求，返回归一化后的 ModelResponse（解析在 transport/adapter 里做）。 */
export type ProbeSend = (prepared: PreparedRequest, adapter: Adapter, signal: AbortSignal) => Promise<ModelResponse>;

export interface ProbeSampleResult {
  index: number;
  expectedCount: number;
  /** 解析出的有效整数个数。 */
  parsedNumbers: number;
  minimumNumbers: number;
  accepted: boolean;
  /** 该条失败原因（超时/断流/被拒）；成功时为 undefined。 */
  error?: string;
}

export interface ModelTraceRank {
  model: string;
  display_name: string;
  family: string;
  family_name: string;
  score: number;
  /**
   * 闭集概率：softmax(β × 均值分) 在该候选上的值，只在 `used>=3`（decision=ranked）时给出，
   * 否则为 null。闭集外模型一定会被归到最相似的候选，不能当「就是它」。
   */
  probability: number | null;
}

export interface ModelTraceResult {
  weak: true;
  caveat: string;
  method: 'modeltrace-robust-v1';
  queries: number;
  samples: ProbeSampleResult[];
  /** 通过有效性门槛的样本条数。 */
  used: number;
  /** insufficient：没有有效样本；partial：有效样本不足三条（只给排名不给置信）；ranked：三条齐全。 */
  decision: 'insufficient' | 'partial' | 'ranked';
  /** 闭集 top-1 概率；只有 ranked 且参考库带 calibration 时非 null。 */
  probability: number | null;
  /** `reference-calibrated` = 已按参考库 β 标定；`unavailable` = 样本不足或库缺 calibration。 */
  probabilityStatus: 'reference-calibrated' | 'unavailable';
  /** 概率的适用范围；非 null 时只能是 `reference-closed-set`（闭集内，不含库外模型）。 */
  probabilityScope: 'reference-closed-set' | null;
  /** 按分数从高到低的前若干候选（默认前 5）。 */
  ranking: ModelTraceRank[];
  top?: ModelTraceRank;
  /**
   * 该库在 used 条样本下的闭集 top-1 交叉验证准确率（来自参考库 calibration，是库的属性，
   * 不是本次运行的置信度）。没有对应条目时为 null。
   */
  referenceAccuracy: number | null;
}

/** 闭集 softmax：β 来自参考库 calibration（按有效条数取 1/2/3），与上游 lm-detector 一致。 */
function softmax(scores: readonly number[], beta: number): number[] {
  const scaled = scores.map((score) => beta * score);
  const max = Math.max(...scaled);
  const exps = scaled.map((value) => Math.exp(value - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((value) => value / sum);
}

/** 把若干条有效回答的排名分按模型取均值（每条内部先标准化，跨条平均后再排序）。 */
function averageRanking(scores: number[][], bank: ScoringBank): ModelTraceRank[] {
  const order = bank.model_order;
  const byId = new Map(bank.models.map((m) => [m.id, m]));
  const means = order.map((_, modelIndex) => scores.reduce((sum, row) => sum + (row[modelIndex] ?? 0), 0) / scores.length);
  return order
    .map((id, modelIndex) => {
      const meta = byId.get(id);
      return {
        model: id,
        display_name: meta?.display_name ?? id,
        family: meta?.family ?? 'other',
        family_name: meta?.family_name ?? '其他',
        score: means[modelIndex]!,
        probability: null,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * 聚合入口：把探针各条回答（已归一化的 ModelResponse）对照参考库打分，门槛按每条 challenge 的
 * 实际 expectedCount 算。不联网、不调模型；失败样本被跳过，永不抛错 —— 最坏返回 decision='insufficient'。
 */
export function analyzeProbeWithChallenges(
  challenges: readonly ProbeChallenge[],
  outputs: readonly ModelResponse[],
  bank: ScoringBank,
  topN = 5,
): ModelTraceResult {
  const samples: ProbeSampleResult[] = outputs.map((response, index) => {
    const challenge = challenges[index];
    const expectedCount = challenge?.expectedCount ?? 300;
    const minimumNumbers = minValidNumbers(expectedCount);
    const parsed = response.error ? [] : parseNumbers(response.text ?? '');
    return {
      index,
      expectedCount,
      parsedNumbers: parsed.length,
      minimumNumbers,
      accepted: !response.error && parsed.length >= minimumNumbers,
      ...(response.error ? { error: response.error } : {}),
    };
  });
  const acceptedRows = outputs.map((response, index) => ({ response, index })).filter(({ index }) => samples[index]!.accepted);
  return finishResult(samples, acceptedRows.map(({ response }) => parseNumbers(response.text ?? '')), bank, challenges.length, topN);
}

function finishResult(
  samples: ProbeSampleResult[],
  acceptedNumbers: number[][],
  bank: ScoringBank,
  queries: number,
  topN: number,
): ModelTraceResult {
  const used = acceptedNumbers.length;
  const base = {
    weak: true as const,
    caveat: CAVEAT,
    method: 'modeltrace-robust-v1' as const,
    queries,
    samples,
    used,
    referenceAccuracy: bank.calibration[String(used)]?.cv_accuracy ?? null,
  };
  if (used === 0) {
    return {
      ...base,
      decision: 'insufficient',
      probability: null,
      probabilityStatus: 'unavailable',
      probabilityScope: null,
      ranking: [],
    };
  }
  const scores = acceptedNumbers.map((numbers) => robustScoreNumbers(numbers, bank));
  const ranked = averageRanking(scores, bank);
  const decision = used >= 3 ? 'ranked' : 'partial';
  if (decision !== 'ranked') {
    const ranking = ranked.slice(0, topN);
    return { ...base, decision, probability: null, probabilityStatus: 'unavailable' as const, probabilityScope: null, ranking, top: ranking[0] };
  }
  const beta = bank.calibration[String(Math.min(used, 3))]?.beta;
  const calibrated = typeof beta === 'number' && Number.isFinite(beta) ? softmax(ranked.map((rank) => rank.score), beta) : null;
  const withProbability = ranked.map((rank, index) => ({ ...rank, probability: calibrated?.[index] ?? null }));
  const ranking = withProbability.slice(0, topN);
  return {
    ...base,
    decision,
    probability: ranking[0]?.probability ?? null,
    probabilityStatus: calibrated ? ('reference-calibrated' as const) : ('unavailable' as const),
    probabilityScope: calibrated ? ('reference-closed-set' as const) : null,
    ranking,
    top: ranking[0],
  };
}

export interface RunModelTraceProbeOptions {
  cfg: EndpointConfig;
  adapter: Adapter;
  send: ProbeSend;
  bank: ScoringBank;
  signal: AbortSignal;
  /** 探针条数，默认 3。 */
  count?: number;
  seed?: number;
  /** 每条探针的请求只带这一条 user 消息；temperature 默认 0。 */
  temperature?: number;
}

/**
 * 跑一轮 ModelTrace 探针。三条独立发送，逐条 try/catch：某条超时/断流只记该条为失败，
 * 其余照常，最终按有效条数给 insufficient / partial / ranked。永不抛到调用方。
 */
export async function runModelTraceProbe(options: RunModelTraceProbeOptions): Promise<ModelTraceResult> {
  const { cfg, adapter, send, bank, signal } = options;
  const challenges = buildProbeChallenges(options.count ?? 3, options.seed ?? 0);
  const temperature = options.temperature ?? 0;

  const outputs: ModelResponse[] = [];
  for (const challenge of challenges) {
    if (signal.aborted) {
      outputs.push({ text: '', error: '已取消' });
      continue;
    }
    const request: ChatRequest = {
      model: cfg.model,
      messages: [{ role: 'user', content: challenge.prompt }],
      temperature,
    };
    try {
      const prepared = adapter.buildChatRequest(request, cfg);
      outputs.push(await send(prepared, adapter, signal));
    } catch (error) {
      outputs.push({ text: '', error: error instanceof Error ? error.message : String(error) });
    }
  }
  return analyzeProbeWithChallenges(challenges, outputs, bank);
}
