/**
 * 浏览器侧最小 HTTP 传输层。
 *
 * 只负责「传输语义」：fetch、超时、AbortController 真取消、429/5xx 退避重试、
 * mock 端点分流、域名截断。请求形状（URL / 请求体 / 鉴权头）与响应解析（JSON /
 * SSE 帧 / usage / tool_calls）全部来自 @llmbm/core 的 adapters（D1），这里不再
 * 写第二份协议映射。
 */
import { buildMessages } from '@llmbm/core';
import {
  createStreamAccumulator,
  isRetryable,
  resolveAdapter,
} from '@llmbm/core/adapters';
import type {
  Adapter,
  ChatMessage,
  EndpointConfig,
  ModelResponse,
  PreparedRequest,
  ToolSpec,
} from '@llmbm/core';
import type { BankQuestion } from '../data/bank.js';

export interface ChatOptions {
  signal: AbortSignal;
  sampleIndex: number;
  injectFlaky: boolean;
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

function retryDelay(res: Response, attempt: number): number {
  const header = res.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
  }
  return 300 * 2 ** attempt;
}

interface ExecuteOptions {
  signal: AbortSignal;
  timeoutMs: number;
  headers?: Record<string, string>;
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
}

/**
 * 增量读响应体，一边攒全文一边记首字延迟（TTFT）与分片数。
 * `res.text()` 拿不到这两个数，而「排队 3 秒才吐第一个字」「200 毫秒一次性吐完」
 * 这些中转站限速/假流式的证据只能在这里采到。
 */
async function readWithTiming(
  res: Response,
  startedAt: number,
): Promise<{ text: string; ttftMs?: number; chunks?: number }> {
  const body = res.body;
  if (!body) return { text: await res.text() };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let ttftMs: number | undefined;
  let chunks = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += 1;
      const chunk = decoder.decode(value, { stream: true });
      parts.push(chunk);
      // 首帧常常只有 role 或空 delta，出现正文增量才算首字。
      if (ttftMs === undefined && /"(content|text|text_delta)"\s*:/.test(chunk)) {
        ttftMs = Math.round(performance.now() - startedAt);
      }
    }
    parts.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return { text: parts.join(''), ttftMs, chunks };
}

/** 解码吞吐：completion tokens / 首字之后的耗时；缺 usage 或耗时为 0 时不编数。 */
export function tokensPerSecond(usage: { completionTokens?: number } | undefined, totalMs: number, ttftMs?: number): number | undefined {
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

async function execute(
  ep: EndpointConfig,
  initialMessages: ChatMessage[],
  opts: ExecuteOptions,
  fetchImpl: typeof fetch,
): Promise<ModelResponse> {
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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs);

    const started = performance.now();
    try {
      const res = await fetchImpl(request.url, {
        method: request.method,
        headers,
        body: request.body,
        signal: controller.signal,
      });
      const latencyMs = Math.round(performance.now() - started);

      if (!res.ok) {
        const rawText = await res.text().catch(() => '');
        if (!echoed && res.status === 400 && /reasoning_content/i.test(rawText) && messages.some((m) => m.role === 'assistant')) {
          echoed = true;
          messages = withReasoningEcho(messages);
          request = buildRequest(messages).request;
          attempt -= 1; // 兼容重试不占重试预算
          continue;
        }
        if (isRetryable(res.status) && attempt < MAX_RETRIES) {
          await sleep(retryDelay(res, attempt), opts.signal);
          continue;
        }
        return {
          text: '',
          error: `HTTP ${res.status}${rawText ? `：${rawText.slice(0, 300)}` : ''}`,
          httpStatus: res.status,
          latencyMs,
          raw: rawText,
        };
      }

      const { text: rawText, ttftMs, chunks } = await readWithTiming(res, started);
      const totalMs = Math.round(performance.now() - started);
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      // 有的中转站会忽略 stream:true 直接回 JSON；两种都按实际 body 判定。
      if (contentType.includes('text/event-stream') || looksLikeSse(rawText)) {
        const parsed = parseEventStream(rawText, adapter, res.status);
        const tps = tokensPerSecond(parsed.usage, totalMs, ttftMs);
        return {
          ...parsed,
          latencyMs: totalMs,
          httpStatus: res.status,
          ...(ttftMs !== undefined ? { ttftMs } : {}),
          ...(chunks !== undefined ? { chunks } : {}),
          ...(tps !== undefined ? { tokensPerSec: tps } : {}),
        };
      }

      let json: unknown;
      try {
        json = JSON.parse(rawText);
      } catch {
        return {
          text: '',
          error: `响应不是合法 JSON：${rawText.slice(0, 200)}`,
          httpStatus: res.status,
          latencyMs,
          raw: rawText,
        };
      }
      return {
        ...adapter.parseChatResponse(json, res.status),
        raw: json,
        latencyMs: totalMs,
        httpStatus: res.status,
      };
    } catch (err) {
      if (opts.signal.aborted) throw new DOMException('aborted', 'AbortError');
      const latencyMs = Math.round(performance.now() - started);
      if (timedOut) {
        return { text: '', error: `请求超时（${opts.timeoutMs}ms）`, latencyMs };
      }
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        await sleep(300 * 2 ** attempt, opts.signal);
        continue;
      }
      return { text: '', error: `网络错误：${message}`, latencyMs };
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
    }
  }

  return { text: '', error: '重试次数耗尽' };
}

/** 发一次已构造好的请求（ModelTrace 探针复用同一条传输路径，不新写 HTTP 客户端）。
 * 与 chatOnce 的区别：请求体由调用方（core 探针）构造，这里只负责发送、超时、取消与解析；
 * 单次发送不重试，失败作为 ModelResponse.error 返回，由探针自己记一条无效样本。 */
export async function sendPrepared(
  prepared: PreparedRequest,
  adapter: Adapter,
  signal: AbortSignal,
  timeoutMs = 180000,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const started = performance.now();
  try {
    const res = await fetchImpl(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      body: prepared.body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const rawText = await res.text().catch(() => '');
      return {
        text: '',
        error: `HTTP ${res.status}${rawText ? `：${rawText.slice(0, 300)}` : ''}`,
        httpStatus: res.status,
        latencyMs: Math.round(performance.now() - started),
        raw: rawText,
      };
    }

    const { text: rawText, ttftMs, chunks } = await readWithTiming(res, started);
    const totalMs = Math.round(performance.now() - started);
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('text/event-stream') || looksLikeSse(rawText)) {
      const parsed = parseEventStream(rawText, adapter, res.status);
      return {
        ...parsed,
        latencyMs: totalMs,
        httpStatus: res.status,
        ...(ttftMs !== undefined ? { ttftMs } : {}),
        ...(chunks !== undefined ? { chunks } : {}),
      };
    }

    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      return {
        text: '',
        error: `响应不是合法 JSON：${rawText.slice(0, 200)}`,
        httpStatus: res.status,
        latencyMs: totalMs,
        raw: rawText,
      };
    }
    return { ...adapter.parseChatResponse(json, res.status), raw: json, latencyMs: totalMs, httpStatus: res.status };
  } catch (err) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const latencyMs = Math.round(performance.now() - started);
    if (timedOut) return { text: '', error: `请求超时（${timeoutMs}ms）`, latencyMs };
    return { text: '', error: `网络错误：${err instanceof Error ? err.message : String(err)}`, latencyMs };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** 发一次 chat 请求；超时/网络错误以 ModelResponse.error 返回，取消则以 AbortError 抛出。 */
export async function chatOnce(
  ep: EndpointConfig,
  question: BankQuestion,
  opts: ChatOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelResponse> {
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
      },
      ...(question.tools !== undefined ? { tools: question.tools } : {}),
      ...(question.request?.maxTokens !== undefined ? { maxTokens: question.request.maxTokens } : {}),
      ...(question.request?.temperature !== undefined ? { temperature: question.request.temperature } : {}),
    },
    fetchImpl,
  );
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
