/**
 * OpenAI 兼容协议（/chat/completions）。
 * 覆盖官方、以及 Azure/DeepSeek/Moonshot/vLLM 等「OpenAI 兼容」中转站：
 * 它们的主要差异是 baseUrl 与模型名，请求/SSE 形状一致。
 */
import type {
  Adapter,
  ChatRequest,
  EndpointConfig,
  ModelResponse,
  PreparedRequest,
  StreamEvent,
  ToolCall,
  Usage,
} from '../types.js';
import { joinUrl } from './url.js';

const JSON_ONLY = 'Only reply with a single JSON object, no prose and no markdown fence.';

function sseData(line: string): string | undefined {
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed.startsWith('data:')) return undefined;
  return trimmed.slice(5).trim();
}

export const openaiAdapter: Adapter = {
  protocol: 'openai',

  buildChatRequest(req: ChatRequest, cfg: EndpointConfig): PreparedRequest {
    const body: Record<string, unknown> = {
      model: req.model || cfg.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.jsonMode) body.response_format = { type: 'json_object' };

    return {
      url: joinUrl(cfg.baseUrl, '/v1', '/chat/completions'),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        accept: 'text/event-stream',
        ...cfg.headers,
      },
      body: JSON.stringify(body),
    };
  },

  buildModelsRequest(cfg: EndpointConfig): PreparedRequest {
    return {
      url: joinUrl(cfg.baseUrl, '/v1', '/models'),
      method: 'GET',
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        accept: 'application/json',
        ...cfg.headers,
      },
      body: '',
    };
  },

  parseSseLine(line: string): StreamEvent[] {
    const data = sseData(line);
    if (data === undefined) return [];
    if (data === '[DONE]') return [{ type: 'done' }];
    if (!data) return [];

    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      // 半截帧/心跳：不报错也不吞，交给上层按 finishReason 缺失判定
      return [];
    }
    const obj = asRecord(json);
    if (!obj) return [];

    const events: StreamEvent[] = [];
    if (obj.error) {
      events.push({ type: 'error', error: errorText(obj.error) });
      return events;
    }

    const usage = mapUsage(obj.usage);
    if (usage) events.push({ type: 'usage', usage });

    const choice = firstChoice(obj);
    if (choice) {
      const delta = asRecord(choice.delta) ?? {};
      const reasoning = pickString(delta.reasoning_content) ?? pickString(delta.reasoning);
      if (reasoning) events.push({ type: 'reasoning', delta: reasoning });
      const content = pickString(delta.content);
      if (content) events.push({ type: 'text', delta: content });

      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      calls.forEach((raw, i) => {
        const call = asRecord(raw);
        if (!call) return;
        const fn = asRecord(call.function) ?? {};
        const ev: StreamEvent = {
          type: 'tool-call',
          index: typeof call.index === 'number' ? call.index : i,
        };
        const id = pickString(call.id);
        const name = pickString(fn.name);
        const args = pickString(fn.arguments);
        if (id) ev.id = id;
        if (name) ev.name = name;
        if (args !== undefined) ev.argumentsDelta = args;
        events.push(ev);
      });

      const finish = pickString(choice.finish_reason);
      if (finish) events.push({ type: 'done', finishReason: finish });
    }

    return events;
  },

  parseChatResponse(json: unknown, httpStatus?: number): ModelResponse {
    const obj = asRecord(json);
    if (!obj) return { text: '', httpStatus, error: '响应不是 JSON 对象' };
    if (obj.error) return { text: '', httpStatus, error: errorText(obj.error), raw: json };

    const choice = firstChoice(obj) ?? {};
    const message = asRecord(choice.message) ?? {};
    const out: ModelResponse = { text: pickString(message.content) ?? '', raw: json };
    if (httpStatus !== undefined) out.httpStatus = httpStatus;

    const reasoning = pickString(message.reasoning_content) ?? pickString(message.reasoning);
    if (reasoning) out.reasoning = reasoning;

    const calls = mapToolCalls(message.tool_calls);
    if (calls.length) out.toolCalls = calls;

    // 非流式响应里 finish_reason 缺失同样是「响应被截断」，不默认成 stop
    const finish = pickString(choice.finish_reason);
    if (finish) out.finishReason = finish;

    const usage = mapUsage(obj.usage);
    if (usage) out.usage = usage;
    return out;
  },

  parseModelsResponse(json: unknown): string[] {
    const obj = asRecord(json);
    const list = obj && Array.isArray(obj.data) ? obj.data : [];
    return list
      .map((raw) => {
        const item = asRecord(raw);
        return item ? pickString(item.id) : undefined;
      })
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  },
};

/* --------------------------------------------------------------- 共享小工具 */

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function pickString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function pickNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function errorText(err: unknown): string {
  const obj = asRecord(err);
  if (obj) return pickString(obj.message) ?? JSON.stringify(err);
  return typeof err === 'string' ? err : JSON.stringify(err);
}

function firstChoice(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  return asRecord(choices[0]);
}

export function mapToolCalls(raw: unknown): ToolCall[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: ToolCall[] = [];
  for (const item of list) {
    const call = asRecord(item);
    if (!call) continue;
    const fn = asRecord(call.function) ?? {};
    const tc: ToolCall = { name: pickString(fn.name) ?? '' };
    const id = pickString(call.id);
    if (id) tc.id = id;
    const argsRaw = pickString(fn.arguments);
    if (argsRaw !== undefined) {
      tc.rawArguments = argsRaw;
      try {
        tc.args = JSON.parse(argsRaw);
      } catch {
        // 解析失败保留 rawArguments
      }
    }
    out.push(tc);
  }
  return out;
}

export function mapUsage(raw: unknown): Usage | undefined {
  const u = asRecord(raw);
  if (!u) return undefined;
  const usage: Usage = {};
  const prompt = pickNumber(u.prompt_tokens) ?? pickNumber(u.input_tokens);
  const completion = pickNumber(u.completion_tokens) ?? pickNumber(u.output_tokens);
  const total = pickNumber(u.total_tokens);
  if (prompt !== undefined) usage.promptTokens = prompt;
  if (completion !== undefined) usage.completionTokens = completion;
  if (total !== undefined) usage.totalTokens = total;
  return Object.keys(usage).length ? usage : undefined;
}

export { JSON_ONLY };
