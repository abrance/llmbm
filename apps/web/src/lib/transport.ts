/**
 * 浏览器侧最小 HTTP 传输层。
 *
 * 只负责「传输语义」：fetch、超时、AbortController 真取消、429/5xx 退避重试、
 * mock 端点分流、域名截断。请求形状（URL / 请求体 / 鉴权头）与响应解析（JSON /
 * SSE 帧 / usage / tool_calls）全部来自 @llmbm/core 的 adapters（D1），这里不再
 * 写第二份协议映射。
 */
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

function chatMessagesOf(question: BankQuestion): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (question.system) messages.push({ role: 'system', content: question.system });
  messages.push({ role: 'user', content: question.prompt });
  return messages;
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
  options: { tools?: ToolSpec[]; maxTokens?: number } = {},
): PreparedChat {
  const adapter = resolveAdapter(ep);
  const request = adapter.buildChatRequest(
    {
      model: ep.model,
      messages,
      temperature: 0,
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
}

async function execute(
  ep: EndpointConfig,
  messages: ChatMessage[],
  opts: ExecuteOptions,
  fetchImpl: typeof fetch,
): Promise<ModelResponse> {
  const { adapter, request } = prepareChatRequest(ep, messages, {
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
  });
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

      const rawText = await res.text();
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      // 有的中转站会忽略 stream:true 直接回 JSON；两种都按实际 body 判定。
      if (contentType.includes('text/event-stream') || looksLikeSse(rawText)) {
        return {
          ...parseEventStream(rawText, adapter, res.status),
          latencyMs,
          httpStatus: res.status,
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
        latencyMs,
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

/** 发一次 chat 请求；超时/网络错误以 ModelResponse.error 返回，取消则以 AbortError 抛出。 */
export async function chatOnce(
  ep: EndpointConfig,
  question: BankQuestion,
  opts: ChatOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelResponse> {
  return execute(
    ep,
    chatMessagesOf(question),
    {
      signal: opts.signal,
      timeoutMs: question.timeoutMs ?? 30000,
      headers: {
        'x-llmbm-question-id': question.id,
        'x-llmbm-sample': String(opts.sampleIndex),
        ...(opts.injectFlaky ? { 'x-llmbm-inject': 'flaky' } : {}),
      },
      ...(question.tools !== undefined ? { tools: question.tools } : {}),
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

/** 连通性测试：发一个最短的 chat 请求，返回耗时；失败抛错。 */
export async function pingEndpoint(
  ep: EndpointConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ latencyMs: number; sample: string }> {
  const response = await execute(
    ep,
    [{ role: 'user', content: '只回复 ok' }],
    { signal: new AbortController().signal, timeoutMs: 15000, maxTokens: 8 },
    fetchImpl,
  );
  if (response.error) throw new Error(response.error);
  if (!response.text && !(response.toolCalls && response.toolCalls.length > 0)) {
    throw new Error('响应没有正文');
  }
  return { latencyMs: response.latencyMs ?? 0, sample: response.text.slice(0, 80) };
}
