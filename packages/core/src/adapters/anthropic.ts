/**
 * Anthropic Messages 协议（/v1/messages）。
 * 与 OpenAI 的关键差异：system 是顶层字段、max_tokens 必填、SSE 走具名事件。
 */
import type {
  Adapter,
  ChatRequest,
  EndpointConfig,
  ModelResponse,
  PreparedRequest,
  StreamEvent,
  Usage,
} from '../types.js';
import { asRecord, errorText, mapToolCalls, pickNumber, pickString } from './openai.js';
import { joinUrl } from './url.js';

const DEFAULT_MAX_TOKENS = 4096;
const JSON_ONLY = 'Only reply with a single JSON object, no prose and no markdown fence.';

function sseData(line: string): string | undefined {
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed.startsWith('data:')) return undefined;
  return trimmed.slice(5).trim();
}

export const anthropicAdapter: Adapter = {
  protocol: 'anthropic',

  buildChatRequest(req: ChatRequest, cfg: EndpointConfig): PreparedRequest {
    const systemParts = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
    if (req.jsonMode) systemParts.push(JSON_ONLY);

    const body: Record<string, unknown> = {
      model: req.model || cfg.model,
      // max_tokens 必填，缺省补一个安全值
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: req.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    };
    if (systemParts.length) body.system = systemParts.join('\n\n');
    if (req.temperature !== undefined) body.temperature = req.temperature;
    // Anthropic：tools[].input_schema 直接接 OpenAI 的 parameters
    if (req.tools && req.tools.length) {
      body.tools = req.tools.map((t) => {
        const out: Record<string, unknown> = { name: t.function.name, input_schema: t.function.parameters ?? { type: 'object' } };
        if (t.function.description) out.description = t.function.description;
        return out;
      });
    }

    return {
      url: joinUrl(cfg.baseUrl, '/v1', '/messages'),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
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
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        accept: 'application/json',
        ...cfg.headers,
      },
      body: '',
    };
  },

  parseSseLine(line: string): StreamEvent[] {
    const data = sseData(line);
    // `event: xxx` 行与注释行不承载数据，忽略
    if (data === undefined) return [];
    if (data === '[DONE]') return [{ type: 'done' }];
    if (!data) return [];

    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return [];
    }
    const obj = asRecord(json);
    if (!obj) return [];

    const type = pickString(obj.type) ?? '';
    switch (type) {
      case 'error': {
        return [{ type: 'error', error: errorText(obj.error) }];
      }
      case 'content_block_delta': {
        const delta = asRecord(obj.delta) ?? {};
        const deltaType = pickString(delta.type) ?? '';
        if (deltaType === 'thinking_delta') {
          const thinking = pickString(delta.thinking);
          return thinking ? [{ type: 'reasoning', delta: thinking }] : [];
        }
        if (deltaType === 'input_json_delta') {
          const partial = pickString(delta.partial_json);
          return partial !== undefined
            ? [{ type: 'tool-call', index: pickNumber(obj.index) ?? 0, argumentsDelta: partial }]
            : [];
        }
        const text = pickString(delta.text);
        return text ? [{ type: 'text', delta: text }] : [];
      }
      case 'content_block_start': {
        const block = asRecord(obj.content_block) ?? {};
        if (pickString(block.type) === 'tool_use') {
          const ev: StreamEvent = { type: 'tool-call', index: pickNumber(obj.index) ?? 0 };
          const id = pickString(block.id);
          const name = pickString(block.name);
          if (id) ev.id = id;
          if (name) ev.name = name;
          return [ev];
        }
        return [];
      }
      case 'message_delta': {
        const events: StreamEvent[] = [];
        const usage = mapAnthropicUsage(obj.usage);
        if (usage) events.push({ type: 'usage', usage });
        const delta = asRecord(obj.delta) ?? {};
        const stop = pickString(delta.stop_reason);
        if (stop) events.push({ type: 'done', finishReason: stop });
        return events;
      }
      case 'message_start': {
        const message = asRecord(obj.message) ?? {};
        const usage = mapAnthropicUsage(message.usage);
        return usage ? [{ type: 'usage', usage }] : [];
      }
      case 'message_stop':
        // 只是「流结束」，不带 stop_reason；finishReason 由 message_delta 提供。
        // 单独到达时说明 finishReason 缺失 —— 由聚合层判定为断流，这里不补 stop。
        return [{ type: 'done' }];
      default:
        // ping / content_block_stop / 未知事件：忽略但不报错
        return [];
    }
  },

  parseChatResponse(json: unknown, httpStatus?: number): ModelResponse {
    const obj = asRecord(json);
    if (!obj) return { text: '', httpStatus, error: '响应不是 JSON 对象' };
    if (pickString(obj.type) === 'error' || obj.error) {
      return { text: '', httpStatus, error: errorText(obj.error), raw: json };
    }

    const content = Array.isArray(obj.content) ? obj.content : [];
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolUses: unknown[] = [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (!block) continue;
      switch (pickString(block.type)) {
        case 'text': {
          const t = pickString(block.text);
          if (t) textParts.push(t);
          break;
        }
        case 'thinking': {
          const t = pickString(block.thinking);
          if (t) thinkingParts.push(t);
          break;
        }
        case 'tool_use':
          toolUses.push({
            id: block.id,
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
          break;
        default:
          break;
      }
    }

    const out: ModelResponse = { text: textParts.join(''), raw: json };
    if (httpStatus !== undefined) out.httpStatus = httpStatus;
    if (thinkingParts.length) out.reasoning = thinkingParts.join('');
    const calls = mapToolCalls(toolUses);
    if (calls.length) out.toolCalls = calls;
    const stop = pickString(obj.stop_reason);
    if (stop) out.finishReason = stop;
    const usage = mapAnthropicUsage(obj.usage);
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

function mapAnthropicUsage(raw: unknown): Usage | undefined {
  const u = asRecord(raw);
  if (!u) return undefined;
  const usage: Usage = {};
  const input = pickNumber(u.input_tokens);
  const output = pickNumber(u.output_tokens);
  if (input !== undefined) usage.promptTokens = input;
  if (output !== undefined) usage.completionTokens = output;
  if (input !== undefined || output !== undefined) {
    // 只有两边都在时才算总数；单边帧（message_delta 只给 output_tokens）留给聚合层合并
    if (input !== undefined && output !== undefined) usage.totalTokens = input + output;
  }
  return Object.keys(usage).length ? usage : undefined;
}
