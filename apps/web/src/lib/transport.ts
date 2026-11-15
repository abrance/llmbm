/**
 * 浏览器侧最小 HTTP 传输层。
 *
 * 只负责「传输语义」：fetch、超时、AbortController 真取消、429/5xx 退避重试、
 * mock 端点分流、域名截断。请求形状（URL / 请求体 / 鉴权头）与响应解析（JSON /
 * SSE 帧 / usage / tool_calls）全部来自 @llmbm/core 的 adapters（D1），这里不再
 * 写第二份协议映射。
 */
import { buildMessages } from '@llmbm/core';
import { createStreamAccumulator, isRetryable, resolveAdapter } from '@llmbm/core/adapters';
import type {
  Adapter,
  ChatMessage,
  EndpointConfig,
  ModelResponse,
  PreparedRequest,
  ToolSpec,
  TransportPhase,
} from '@llmbm/core';
import type { BankQuestion } from '../data/bank.js';

export interface ChatOptions {
  signal: AbortSignal;
  sampleIndex: number;
  injectFlaky: boolean;
  /** 只给 mock / E2E 用：显式注入故障模式（请求头 x-llmbm-fault）。 */
  fault?: string;
}

/** 一次 HTTP 尝试的结果（attempt 级证据，不是 core 契约字段）。 */
export interface TransportAttempt {
  attempt: number;
  /** `retryable` = 状态码/网络错误可重试后放弃或再试；`timeout` = 本次尝试超时。 */
  outcome: 'success' | 'timeout' | 'retryable' | 'failed';
  latencyMs: number;
  httpStatus?: number;
  error?: string;
}

/**
 * 传输层返回的响应：core 的 ModelResponse + attempt 级明细。
 * 逻辑采样的最终结果（error / latencyMs）与 attempt 明细分开：重试成功不会抹掉上一次超时。
 */
export interface TransportResponse extends ModelResponse {
  attemptLog?: TransportAttempt[];
}

const MAX_RETRIES = 2;
/** 证据链里最多保留的 SSE 帧数，避免长回答的原始证据撑爆 localStorage / 导出。 */
const MAX_EVIDENCE_FRAMES = 500;

export function isMockBase(baseUrl: string): boolean {
  return baseUrl.startsWith('/__mock') || baseUrl.startsWith('mock://');
}

/** 社区展示只到域名；mock 端点固定 mock.local，避免把协议/路径带出去。 */
export function domainOf(baseUrl: string): string {
  if (isMockBase(baseUrl)) return 'mock.local';
  try {
    return new URL(baseUrl).host || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 题库里的 tools 是协议无关的 ToolSpec（OpenAI 声明形状）。
 * 各协议如何映射由 core adapter 负责，web 侧不再按协议改写请求体（D1）。
 */
export interface PreparedChat {
  adapter: Adapter;
  request: PreparedRequest;
}

/** 构造请求：协议判定、URL、鉴权头、请求体全部交给 core adapter。 */
export function prepareChatRequest(
  ep: EndpointConfig,
  messages: ChatMessage[],
  options: { tools?: ToolSpec[]; maxTokens?: number; temperature?: number } = {},
): PreparedChat {
  const adapter = resolveAdapter(ep);
  const request = adapter.buildChatRequest(
    {
      model: ep.model,
      messages,
      temperature: options.temperature ?? 0,
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
    },
    ep,
  );
  return { adapter, request };
}

function sseData(line: string): string | undefined {
  if (!line.startsWith('data:')) return undefined;
  return line.slice(5).trim();
}

function looksLikeSse(text: string): boolean {
  const head = text.trimStart();
  return head.startsWith('data:') || head.startsWith('event:') || text.includes('\ndata:');
}

/**
 * 消费 SSE 文本：逐行交给 adapter.parseSseLine，跨帧拼接由 core 的聚合层负责。
 * HTTP 200 但没有 finishReason 视为「流断」，显式记 error —— 可信度检测不能把
 * 半截回答当成正常完成。
 */
function parseEventStream(text: string, adapter: Adapter, httpStatus: number): ModelResponse {
  const acc = createStreamAccumulator();
  const frames: unknown[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const payload = sseData(line);
    if (payload && payload !== '[DONE]' && frames.length < MAX_EVIDENCE_FRAMES) {
      try {
        frames.push(JSON.parse(payload) as unknown);
      } catch {
        // 半截帧 / 心跳：adapter 会忽略，证据里也不收
      }
    }
    acc.push(adapter.parseSseLine(line));
  }

  const result = acc.result(httpStatus);
  const raw = { transport: 'sse', frames };
  if (!result.error && result.finishReason === undefined) {
    return { ...result, raw, error: '流在完成标记前结束（HTTP 200，未收到 finishReason）' };
  }
  return { ...result, raw };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 有 Retry-After 就按它（封顶 5s）；没有返回 undefined，由调用方按 attempt 做指数退避。 */
function retryDelay(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
  return undefined;
}

interface ExecuteOptions {
  signal: AbortSignal;
  timeoutMs: number;
  headers?: Record<string, string>;
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
}

/** 一次请求已采集到的传输进度；超时/断流时必须原样带回，不能只剩一个「超时」。 */
interface ReadProgress {
  chunks: number;
  ttftMs?: number;
  lastChunkAtMs?: number;
  phase: TransportPhase;
}

/** 正文增量帧：`"content":"…"` / `"text":"…"` 且值非空。心跳与空 role 帧不算首字。 */
const CONTENT_FRAME = /"(?:content|text)"\s*:\s*"(?:[^"\\]|\\.)+"/;

function progressOf(progress: ReadProgress): {
  ttftMs?: number;
  chunks: number;
  lastChunkAtMs?: number;
  phase: TransportPhase;
} {
  return {
    ...(progress.ttftMs !== undefined ? { ttftMs: progress.ttftMs } : {}),
    chunks: progress.chunks,
    ...(progress.lastChunkAtMs !== undefined ? { lastChunkAtMs: progress.lastChunkAtMs } : {}),
    phase: progress.phase,
  };
}

/** 读一片 body，同时监听 abort：卡住的流不会因为底层实现不响应而永远等下去。 */
function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * 增量读响应体，一边攒全文一边把进度写进 `progress`（首字延迟、分片数、最后一次有效增量）。
 * `res.text()` 拿不到这些数，而「排队 3 秒才吐第一个字」「200 毫秒一次性吐完」
 * 这些中转站限速/假流式的证据只能在这里采到；中途 abort 时 progress 里已经有的数不能丢。
 */
async function readWithTiming(
  res: Response,
  startedAt: number,
  progress: ReadProgress,
  signal: AbortSignal,
): Promise<string> {
  const body = res.body;
  if (!body) return res.text();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  // 正文帧可能被网络分片切开：匹配时带上上一片尾部，否则首字被判晚或漏判。
  let carry = '';
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      progress.chunks += 1;
      const chunk = decoder.decode(value, { stream: true });
      parts.push(chunk);
      const probe = carry + chunk;
      carry = probe.slice(-64);
      if (CONTENT_FRAME.test(probe)) {
        const elapsed = Math.round(performance.now() - startedAt);
        if (progress.ttftMs === undefined) progress.ttftMs = elapsed;
        progress.lastChunkAtMs = elapsed;
        progress.phase = 'streaming';
      }
    }
    parts.push(decoder.decode());
    progress.phase = 'done';
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return parts.join('');
}

/** 解码吞吐：completion tokens / 首字之后的耗时；缺 usage 或耗时为 0 时不编数。 */
export function tokensPerSecond(
  usage: { completionTokens?: number } | undefined,
  totalMs: number,
  ttftMs?: number,
): number | undefined {
  const tokens = usage?.completionTokens;
  if (tokens === undefined || tokens <= 0 || ttftMs === undefined) return undefined;
  const decodeMs = totalMs - ttftMs;
  if (decodeMs <= 0) return undefined;
  return Math.round((tokens / decodeMs) * 1000 * 10) / 10;
}

/**
 * 兼容重试：thinking 模式端点（DeepSeek 类）要求多轮里 assistant 消息带回上一轮的
 * reasoning_content，题库的历史是合成的，本来没有。命中这个明确报错时补一次空值重试
 * —— 只试一次，仍被拒就当成「请求形状不被接受」记下来，不再猜。
 */
function withReasoningEcho(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => (m.role === 'assistant' ? { ...m, reasoningContent: m.reasoningContent ?? '' } : m));
}

interface AttemptOutcome {
  response: TransportResponse;
  /** 状态码/网络错误可再试；超时只在还没收到第一个字节时才算可重试。 */
  retryable: boolean;
  timedOut: boolean;
  /** 429/5xx 的 Retry-After（ms），没有就按指数退避。 */
  retryAfterMs?: number;
}

/**
 * 发一次 HTTP 尝试（不重试）。超时时把已采集的进度（ttftMs/chunks/lastChunkAtMs/phase）一起带回，
 * 失败采样不能只剩一句「超时」，否则「首字慢」「流式中段卡死」无法归因。
 */
async function attemptOnce(
  request: PreparedRequest,
  adapter: Adapter,
  headers: Record<string, string>,
  options: { signal: AbortSignal; timeoutMs: number },
  fetchImpl: typeof fetch,
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (options.signal.aborted) controller.abort();
  else options.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  const started = performance.now();
  const progress: ReadProgress = { chunks: 0, phase: 'before-first-byte' };
  // fetch 一返回就说明连接与响应头都有了；失败时据此区分「连不上」和「连上没出字」。
  let connected = false;
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const res = await fetchImpl(request.url, {
      method: request.method,
      headers,
      body: request.body,
      signal: controller.signal,
    });
    connected = true;
    const latencyMs = elapsed();

    if (!res.ok) {
      const rawText = await res.text().catch(() => '');
      return {
        retryable: isRetryable(res.status),
        timedOut: false,
        retryAfterMs: retryDelay(res),
        response: {
          text: '',
          error: `HTTP ${res.status}${rawText ? `：${rawText.slice(0, 300)}` : ''}`,
          httpStatus: res.status,
          latencyMs,
          raw: rawText,
        },
      };
    }

    const rawText = await readWithTiming(res, started, progress, controller.signal);
    const totalMs = elapsed();
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    // 有的中转站会忽略 stream:true 直接回 JSON；两种都按实际 body 判定。
    if (contentType.includes('text/event-stream') || looksLikeSse(rawText)) {
      const parsed = parseEventStream(rawText, adapter, res.status);
      const tps = tokensPerSecond(parsed.usage, totalMs, progress.ttftMs);
      // 断流（HTTP 200 没有 finishReason）：body 读完了，但请求不是正常结束 —— 阶段要写「断在哪」。
      const phase =
        parsed.error !== undefined && progress.phase === 'done'
          ? progress.chunks === 0
            ? 'before-first-byte'
            : 'streaming'
          : progress.phase;
      return {
        // 断流不重试：正文已经残缺，再要一次只会把「半截回答」洗掉；它按传输失败记，不当超时。
        retryable: false,
        timedOut: false,
        response: {
          ...parsed,
          latencyMs: totalMs,
          httpStatus: res.status,
          ...progressOf({ ...progress, phase }),
          ...(tps !== undefined ? { tokensPerSec: tps } : {}),
        },
      };
    }

    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      return {
        retryable: false,
        timedOut: false,
        response: {
          text: '',
          error: `响应不是合法 JSON：${rawText.slice(0, 200)}`,
          httpStatus: res.status,
          latencyMs,
          raw: rawText,
        },
      };
    }
    // 非流式响应不编造 TTFT：progress 只用于失败时解释「卡在哪一段」。
    return {
      retryable: false,
      timedOut: false,
      response: {
        ...adapter.parseChatResponse(json, res.status),
        raw: json,
        latencyMs: totalMs,
        httpStatus: res.status,
      },
    };
  } catch (err) {
    if (options.signal.aborted) throw new DOMException('aborted', 'AbortError');
    const latencyMs = elapsed();
    if (timedOut) {
      return {
        // 已收到正文再超时的请求不重试：同一预算下再来一次只会让用户多等一倍，正文早已残缺。
        retryable: progress.phase === 'before-first-byte',
        timedOut: true,
        // 没连上就不带 phase/chunks：core 据此归 connect，而不是「连上了没出字」。
        response: {
          text: '',
          error: `请求超时（${options.timeoutMs}ms）`,
          latencyMs,
          ...(connected ? progressOf(progress) : {}),
        },
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      retryable: true,
      timedOut: false,
      response: {
        text: '',
        error: `网络错误：${message}`,
        latencyMs,
        ...(connected ? progressOf(progress) : {}),
      },
    };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }
}

async function execute(
  ep: EndpointConfig,
  initialMessages: ChatMessage[],
  opts: ExecuteOptions,
  fetchImpl: typeof fetch,
): Promise<TransportResponse> {
  let messages = initialMessages;
  let echoed = false;
  const buildRequest = (msgs: ChatMessage[]) =>
    prepareChatRequest(ep, msgs, {
      ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    });
  const built = buildRequest(messages);
  const adapter = built.adapter;
  let request = built.request;
  const headers: Record<string, string> = { ...request.headers, ...(opts.headers ?? {}) };
  const attemptLog: TransportAttempt[] = [];
  // 首字节前超时只额外重试一次（多半是冷启动/排队），中段超时不重试。
  let timeoutRetries = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const outcome = await attemptOnce(
      request,
      adapter,
      headers,
      { signal: opts.signal, timeoutMs: opts.timeoutMs },
      fetchImpl,
    );
    const response = outcome.response;
    attemptLog.push({
      attempt: attemptLog.length + 1,
      outcome:
        response.error === undefined
          ? 'success'
          : outcome.timedOut
            ? 'timeout'
            : outcome.retryable
              ? 'retryable'
              : 'failed',
      latencyMs: response.latencyMs ?? 0,
      ...(response.httpStatus !== undefined ? { httpStatus: response.httpStatus } : {}),
      ...(response.error !== undefined ? { error: response.error } : {}),
    });

    // 兼容重试：不占重试预算，也不写进 attemptLog 之外的地方。
    if (
      response.httpStatus === 400 &&
      !echoed &&
      /reasoning_content/i.test(String(response.raw ?? '')) &&
      messages.some((m) => m.role === 'assistant')
    ) {
      echoed = true;
      messages = withReasoningEcho(messages);
      request = buildRequest(messages).request;
      attempt -= 1;
      continue;
    }

    if (response.error === undefined) return { ...response, attempts: attemptLog.length, attemptLog };

    const canRetryTimeout = outcome.timedOut && outcome.retryable && timeoutRetries < 1;
    if (canRetryTimeout) timeoutRetries += 1;
    const retry = outcome.retryable && (outcome.timedOut ? canRetryTimeout : true) && attempt < MAX_RETRIES;
    if (!retry) return { ...response, attempts: attemptLog.length, attemptLog };
    await sleep(outcome.retryAfterMs ?? 300 * 2 ** attempt, opts.signal);
  }

  return { text: '', error: '重试次数耗尽', attempts: attemptLog.length, attemptLog };
}

/** 发一次 chat 请求；超时/网络错误以 ModelResponse.error 返回，取消则以 AbortError 抛出。 */
export async function chatOnce(
  ep: EndpointConfig,
  question: BankQuestion,
  opts: ChatOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<TransportResponse> {
  return execute(
    ep,
    buildMessages(question),
    {
      signal: opts.signal,
      timeoutMs: question.timeoutMs ?? 30000,
      headers: {
        'x-llmbm-question-id': question.id,
        'x-llmbm-sample': String(opts.sampleIndex),
        ...(opts.injectFlaky ? { 'x-llmbm-inject': 'flaky' } : {}),
        ...(opts.fault ? { 'x-llmbm-fault': opts.fault } : {}),
      },
      ...(question.tools !== undefined ? { tools: question.tools } : {}),
      ...(question.request?.maxTokens !== undefined ? { maxTokens: question.request.maxTokens } : {}),
      ...(question.request?.temperature !== undefined ? { temperature: question.request.temperature } : {}),
    },
    fetchImpl,
  );
}

/**
 * 发一次已由调用方构造好的请求（ModelTrace 探针复用同一条传输路径，不新写 HTTP 客户端）。
 * 与 chatOnce 的区别：请求体来自 core 探针，这里只负责发送、超时、取消与解析；不重试，
 * 失败作为 ModelResponse.error 返回，由探针自己记一条无效样本。
 */
export async function sendPrepared(
  prepared: PreparedRequest,
  adapter: Adapter,
  signal: AbortSignal,
  timeoutMs = 180000,
  fetchImpl: typeof fetch = fetch,
): Promise<TransportResponse> {
  const outcome = await attemptOnce(prepared, adapter, { ...prepared.headers }, { signal, timeoutMs }, fetchImpl);
  return {
    ...outcome.response,
    attempts: 1,
    attemptLog: [
      {
        attempt: 1,
        outcome: outcome.response.error === undefined ? 'success' : outcome.timedOut ? 'timeout' : 'failed',
        latencyMs: outcome.response.latencyMs ?? 0,
        ...(outcome.response.httpStatus !== undefined ? { httpStatus: outcome.response.httpStatus } : {}),
        ...(outcome.response.error !== undefined ? { error: outcome.response.error } : {}),
      },
    ],
  };
}

async function requestModels(request: PreparedRequest, adapter: Adapter, fetchImpl: typeof fetch): Promise<string[]> {
  const res = await fetchImpl(request.url, { method: request.method, headers: request.headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`响应不是合法 JSON：${text.slice(0, 120)}`);
  }
  return adapter.parseModelsResponse(json);
}

/**
 * 拉模型列表：mock 与 anthropic/gemini 直接用 core 的 buildModelsRequest；
 * OpenAI 兼容仍走同源 /api/models 代理（避开浏览器 CORS，代理只转发 Authorization）。
 */
export async function fetchModels(ep: EndpointConfig, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const adapter = resolveAdapter(ep);
  const request = adapter.buildModelsRequest?.(ep);
  if (!request) throw new Error(`协议 ${adapter.protocol} 不支持拉取模型列表`);

  if (!isMockBase(ep.baseUrl) && adapter.protocol === 'openai') {
    const res = await fetchImpl(`/api/models?baseUrl=${encodeURIComponent(ep.baseUrl)}`, {
      headers: ep.apiKey.trim() ? { authorization: `Bearer ${ep.apiKey.trim()}` } : {},
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`响应不是合法 JSON：${text.slice(0, 120)}`);
    }
    return adapter.parseModelsResponse(json);
  }

  return requestModels(request, adapter, fetchImpl);
}

/**
 * 预检探针：跑测第一题之前先发一条最小请求，只用来判断「账户/配置」层面是否可用。
 * 返回原始 ModelResponse，由调用方用 classifyFailure 定性；健康端点的一个 token 成本。
 */
export async function probeEndpoint(ep: EndpointConfig, fetchImpl: typeof fetch = fetch): Promise<ModelResponse> {
  return execute(
    ep,
    [{ role: 'user', content: '只回复 ok' }],
    { signal: new AbortController().signal, timeoutMs: 30000, maxTokens: 16 },
    fetchImpl,
  );
}

/**
 * 连通性测试：发一个最短的 chat 请求，返回耗时；失败抛错。
 *
 * 判定口径按「端点有没有真的干活」而不是「有没有正文」：推理模型（R1 / o1 / QwQ /
 * gemini thinking）会把 token 全花在 reasoning 上，正文此时就是空的；只认 text 会把
 * 一个完全健康的端点判成失败。maxTokens 也给够余量，8 个 token 连思考的开头都放不下。
 */
export async function pingEndpoint(
  ep: EndpointConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ latencyMs: number; sample: string; reasoningOnly?: boolean }> {
  const response = await execute(
    ep,
    [{ role: 'user', content: '只回复 ok' }],
    { signal: new AbortController().signal, timeoutMs: 30000, maxTokens: 64 },
    fetchImpl,
  );
  if (response.error) throw new Error(response.error);
  const latencyMs = response.latencyMs ?? 0;

  if (response.text) return { latencyMs, sample: response.text.slice(0, 80) };
  if (response.toolCalls && response.toolCalls.length > 0) {
    return { latencyMs, sample: `[工具调用] ${response.toolCalls[0]?.name ?? ''}` };
  }
  if (response.reasoning) {
    return { latencyMs, sample: `[仅推理] ${response.reasoning.slice(0, 60)}`, reasoningOnly: true };
  }

  const finish = response.finishReason ?? '缺失';
  const completion = response.usage?.completionTokens;
  throw new Error(
    `HTTP ${response.httpStatus ?? '?'} 拿到了响应但正文/推理/工具调用全为空` +
      `（finish_reason=${finish}${completion !== undefined ? `，completion_tokens=${completion}` : ''}）`,
  );
}
