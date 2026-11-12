/**
 * 浏览器侧最小 HTTP 传输层（只负责发请求与解析 OpenAI 兼容的 chat 响应）。
 * 协议归一化（anthropic / gemini / SSE）属于 core adapters（D1），不在这里重写。
 */
import type { EndpointConfig, ModelResponse, ToolCall, Usage } from '@llmbm/core';
import type { BankQuestion } from '../data/bank.js';

export interface ChatOptions {
  signal: AbortSignal;
  sampleIndex: number;
  injectFlaky: boolean;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;

export function isMockBase(baseUrl: string): boolean {
  return baseUrl.startsWith('/__mock') || baseUrl.startsWith('mock://');
}

/** 去尾部斜杠；已带 /chat/completions 的原样使用。 */
export function chatUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

export function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/models`;
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

function messagesOf(question: BankQuestion): { role: 'system' | 'user'; content: string }[] {
  const messages: { role: 'system' | 'user'; content: string }[] = [];
  if (question.system) messages.push({ role: 'system', content: question.system });
  messages.push({ role: 'user', content: question.prompt });
  return messages;
}

function buildHeaders(ep: EndpointConfig, question: BankQuestion, opts: ChatOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-llmbm-question-id': question.id,
    'x-llmbm-sample': String(opts.sampleIndex),
    ...(opts.injectFlaky ? { 'x-llmbm-inject': 'flaky' } : {}),
    ...(ep.headers ?? {}),
  };
  if (ep.apiKey.trim()) headers.authorization = `Bearer ${ep.apiKey.trim()}`;
  return headers;
}

function usageOf(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  const prompt = num(v['prompt_tokens']) ?? num(v['input_tokens']);
  const completion = num(v['completion_tokens']) ?? num(v['output_tokens']);
  const total = num(v['total_tokens']) ?? (prompt !== undefined && completion !== undefined ? prompt + completion : undefined);
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  return { ...(prompt !== undefined ? { promptTokens: prompt } : {}), ...(completion !== undefined ? { completionTokens: completion } : {}), ...(total !== undefined ? { totalTokens: total } : {}) };
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('');
  }
  return '';
}

export interface ParsedChat {
  text: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage?: Usage;
}

/** 解析 OpenAI 兼容的非流式响应；不认识的字段忽略，不抛错。 */
export function parseChatJson(json: unknown): ParsedChat {
  const root = (json ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(root['choices']) ? (root['choices'] as unknown[]) : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first['message'] ?? first['delta'] ?? {}) as Record<string, unknown>;
  const rawCalls = Array.isArray(message['tool_calls']) ? (message['tool_calls'] as unknown[]) : [];
  const toolCalls: ToolCall[] = rawCalls.map((item, index) => {
    const call = (item ?? {}) as Record<string, unknown>;
    const fn = (call['function'] ?? {}) as Record<string, unknown>;
    const name = typeof fn['name'] === 'string' ? fn['name'] : '';
    const rawArguments = typeof fn['arguments'] === 'string' ? fn['arguments'] : undefined;
    let args: unknown;
    if (rawArguments !== undefined) {
      try {
        args = JSON.parse(rawArguments);
      } catch {
        args = undefined;
      }
    }
    return {
      id: typeof call['id'] === 'string' ? call['id'] : `call_${index}`,
      name,
      ...(args !== undefined ? { args } : {}),
      ...(rawArguments !== undefined ? { rawArguments } : {}),
    };
  });
  const reasoning = message['reasoning_content'] ?? message['reasoning'];
  return {
    text: textOfContent(message['content']),
    ...(typeof reasoning === 'string' ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(typeof first['finish_reason'] === 'string' ? { finishReason: first['finish_reason'] } : {}),
    ...(usageOf(root['usage']) !== undefined ? { usage: usageOf(root['usage']) } : {}),
  };
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

/** 发一次 chat 请求；超时/网络错误以 ModelResponse.error 返回，取消则以 AbortError 抛出。 */
export async function chatOnce(
  ep: EndpointConfig,
  question: BankQuestion,
  opts: ChatOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelResponse> {
  const timeoutMs = question.timeoutMs ?? 30000;
  const body = {
    model: ep.model,
    messages: messagesOf(question),
    temperature: 0,
    stream: false,
    ...(question.tools ? { tools: question.tools } : {}),
  };
  const url = chatUrl(ep.baseUrl);
  const headers = buildHeaders(ep, question, opts);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const started = performance.now();
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const latencyMs = Math.round(performance.now() - started);

      if (!res.ok) {
        const rawText = await res.text().catch(() => '');
        if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
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
      const parsed = parseChatJson(json);
      return {
        ...parsed,
        raw: json,
        latencyMs,
        httpStatus: res.status,
      };
    } catch (err) {
      if (opts.signal.aborted) throw new DOMException('aborted', 'AbortError');
      const latencyMs = Math.round(performance.now() - started);
      if (timedOut) {
        return { text: '', error: `请求超时（${timeoutMs}ms）`, latencyMs };
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

/** 拉模型列表：mock 直接读内置端点，真实地址走同源 /api/models 代理。 */
export async function fetchModels(ep: EndpointConfig, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const mock = isMockBase(ep.baseUrl);
  const url = mock ? modelsUrl(ep.baseUrl) : `/api/models?baseUrl=${encodeURIComponent(ep.baseUrl)}`;
  const res = await fetchImpl(url, {
    headers: ep.apiKey.trim() ? { authorization: `Bearer ${ep.apiKey.trim()}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { data?: { id?: unknown }[] };
  return (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
}

/** 连通性测试：发一个最短的 chat 请求，返回耗时；失败抛错。 */
export async function pingEndpoint(ep: EndpointConfig, fetchImpl: typeof fetch = fetch): Promise<{ latencyMs: number; sample: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const started = performance.now();
  try {
    const res = await fetchImpl(chatUrl(ep.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(ep.apiKey.trim() ? { authorization: `Bearer ${ep.apiKey.trim()}` } : {}),
        ...(ep.headers ?? {}),
      },
      body: JSON.stringify({
        model: ep.model,
        messages: [{ role: 'user', content: '只回复 ok' }],
        temperature: 0,
        max_tokens: 8,
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
    const parsed = parseChatJson(JSON.parse(text) as unknown);
    if (!parsed.text && !parsed.toolCalls) throw new Error('响应没有正文');
    return { latencyMs: Math.round(performance.now() - started), sample: parsed.text.slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}
