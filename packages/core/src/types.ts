/**
 * llmbm core 公共类型契约。
 * 变更规则：本文件是 judge / adapters / scoring / sampling 与 apps 之间唯一的类型边界，
 * 改动必须同步 ARCHITECTURE.md 并在 MR 描述里写明影响面。
 */

/* ------------------------------------------------------------------ 题目与题库 */

/** §2.1 的 19 类判定。新增一类 = 这里加一个字面量 + registry 注册一个函数 + 单测。 */
export type JudgeKind =
  | 'exact'
  | 'contains'
  | 'not-contains'
  | 'regex'
  | 'set'
  | 'json'
  | 'json-schema'
  | 'number'
  | 'fraction'
  | 'conflict'
  | 'ordering'
  | 'function-call'
  | 'tool-args'
  | 'pelican-svg'
  | 'long-output'
  | 'refusal'
  | 'format-json'
  | 'unit-convert'
  | 'cite';

export const JUDGE_KINDS: readonly JudgeKind[] = [
  'exact',
  'contains',
  'not-contains',
  'regex',
  'set',
  'json',
  'json-schema',
  'number',
  'fraction',
  'conflict',
  'ordering',
  'function-call',
  'tool-args',
  'pelican-svg',
  'long-output',
  'refusal',
  'format-json',
  'unit-convert',
  'cite',
] as const;

/** 题库分组（F3）。 */
export type QuestionGroup = 'basic' | 'ability' | 'adversarial' | 'endurance' | 'advanced' | 'spotlight';

export interface Question {
  id: string;
  group: QuestionGroup | string;
  /** 维度聚合时的权重，默认 1。 */
  weight?: number;
  /** 核心题：答错该题直接 0 分（§2.3）。 */
  core?: boolean;
  prompt: string;
  /** 可选的 system 提示。 */
  system?: string;
  judge: JudgeKind;
  /** 判定期望值，形状由 judge 决定，见 ARCHITECTURE.md 判定契约表。 */
  expect?: unknown;
  timeoutMs?: number;
  tags?: string[];
  /** 该题需要的采样次数，缺省走全局 N（默认 3，D3）。 */
  samples?: number;
}

/* ------------------------------------------------------------------ 模型响应 */

export interface ToolCall {
  id?: string;
  name: string;
  /** 解析后的参数；解析失败时为 undefined，原文留在 rawArguments。 */
  args?: unknown;
  rawArguments?: string;
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ModelResponse {
  /** 助手正文。 */
  text: string;
  /** reasoning_content / thinking 之类，与正文分开存。 */
  reasoning?: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage?: Usage;
  /** 原始 JSON（非流式）或聚合后的最后一帧，用于证据链 F11。 */
  raw?: unknown;
  latencyMs?: number;
  httpStatus?: number;
  /** 传输层错误（超时、断流、429 重试耗尽），有值即视为该次采样失败。 */
  error?: string;
}

/* ------------------------------------------------------------------ 协议适配 */

export type Protocol = 'openai' | 'anthropic' | 'gemini';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** assistant 消息里携带的工具调用。固定 OpenAI wire 形状（arguments 是 JSON 字符串），由 adapter 映射。 */
export interface ToolCallSpec {
  id?: string;
  type?: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** 仅 assistant：本轮发起的工具调用。 */
  tool_calls?: ToolCallSpec[];
  /** 仅 role='tool'：这条结果回填的是哪一个工具调用。 */
  tool_call_id?: string;
  /** 仅 role='tool'：被调用的函数名（gemini 的 functionResponse 按名字回填，必需）。 */
  name?: string;
}

/**
 * 工具声明。这里固定用 OpenAI 的 function 形状（题库与 mock 的原始形状），
 * 由各协议 adapter 映射成自己的 wire 格式，调用方不按协议分支。
 */
export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description?: string;
    /** JSON Schema 形状的参数声明。 */
    parameters?: unknown;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 需要结构化输出时的提示（openai response_format / anthropic prefill 由适配器决定）。 */
  jsonMode?: boolean;
  /** 工具声明，协议无关；缺省表示本次请求不带工具。 */
  tools?: ToolSpec[];
}

export interface EndpointConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol?: Protocol;
  headers?: Record<string, string>;
}

export interface PreparedRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body: string;
}

/** SSE 归一化事件。一个 `data:` 帧可能产出多个事件。 */
export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool-call'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; error: string };

export interface Adapter {
  protocol: Protocol;
  buildChatRequest(req: ChatRequest, cfg: EndpointConfig): PreparedRequest;
  buildModelsRequest?(cfg: EndpointConfig): PreparedRequest;
  /** 传入一条完整 SSE 行（含 `data: ` 前缀，可为注释行/空行），返回 0..n 个归一化事件。 */
  parseSseLine(line: string): StreamEvent[];
  parseChatResponse(json: unknown, httpStatus?: number): ModelResponse;
  parseModelsResponse(json: unknown): string[];
}

/* --------------------------------------------------------------- judge 与打分 */

/** 判定过程里产生的标记，供 §2.3 的分数修正使用。 */
export type ScoreFlag =
  | 'core-failed'
  | 'params-wrong'
  | 'wrapped'
  | 'empty-response'
  | 'timeout'
  | 'refused'
  | 'truncated'
  | 'degenerate';

export interface JudgeCheck {
  /** 检查项名，出现在证据链里，如 "schema.required:name"。 */
  name: string;
  pass: boolean;
  /** 该项权重，缺省 1；同题内按权重求和（spec §2.3 的「pass 项/总项」）。 */
  weight?: number;
  /** 失败原因/命中内容，直接给用户看。 */
  detail?: string;
  /** 硬检查失败 → 该题为 0（与 core 题等价）。 */
  hard?: boolean;
}

export interface JudgeContext {
  question: Question;
  response: ModelResponse;
  /** 该题第几次采样（0 起），judge 不应依赖它做判定，仅用于证据链标注。 */
  sampleIndex?: number;
}

/** 判定函数：纯函数，不读写外部状态，不做网络请求。 */
export type JudgeFn = (ctx: JudgeContext) => JudgeCheck[];

export type QuestionStatus = 'pass' | 'pending_review' | 'fail';

export interface QuestionScore {
  questionId: string;
  group: string;
  judge: JudgeKind;
  score: number;
  status: QuestionStatus;
  checksPassed: number;
  checksTotal: number;
  checks: JudgeCheck[];
  flags: ScoreFlag[];
  core: boolean;
  note?: string;
  /**
   * 该次采样是传输失败（超时/断流/重试耗尽）：没收到答案，不是答得不对（D5）。
   * 这类采样 status 恒为 `pending_review`，且不进入能力分聚合 —— 只计入传输错误率。
   */
  transportError?: boolean;
}
