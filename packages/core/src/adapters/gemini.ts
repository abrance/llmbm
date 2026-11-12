/**
 * Gemini 协议（/v1beta/models/{model}:streamGenerateContent?alt=sse）。
 * 与 OpenAI 的关键差异：contents[].parts[]、systemInstruction 顶层、generationConfig、
 * 每帧带 candidates[].finishReason（因此 finishReason 出现即代表正常结束）。
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
import { trimSlash } from './url.js';

const JSON_ONLY = 'Only reply with a single JSON object, no prose and no markdown fence.';

function sseData(line: string): string | undefined {
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed.startsWith('data:')) return undefined;
  return trimmed.slice(5).trim();
}

/** baseUrl 可能是 https://host、https://host/v1beta 或 https://host/v1beta/models。 */
function modelsBase(baseUrl: string): string {
  const base = trimSlash(baseUrl);
  if (/\/v1beta\/models$/.test(base)) return base;
  if (/\/v1beta$/.test(base)) return `${base}/models`;
  return `${base}/v1beta/models`;
}

function partsText(parts: unknown, wantThought: boolean): string {
  const list = Array.isArray(parts) ? parts : [];
  const out: string[] = [];
  for (const raw of list) {
    const part = asRecord(raw);
    if (!part) continue;
    const isThought = part.thought === true;
    if (isThought !== wantThought) continue;
    const t = pickString(part.text);
    if (t) out.push(t);
  }
  return out.join('');
}

function partsFunctionCalls(parts: unknown): Array<{ name: string; args: Record<string, unknown> }> {
  const list = Array.isArray(parts) ? parts : [];
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const raw of list) {
    const part = asRecord(raw);
    if (!part) continue;
    const call = asRecord(part.functionCall);
    if (!call) continue;
    out.push({ name: pickString(call.name) ?? '', args: asRecord(call.args) ?? {} });
  }
  return out;
}

export const geminiAdapter: Adapter = {
  protocol: 'gemini',

  buildChatRequest(req: ChatRequest, cfg: EndpointConfig): PreparedRequest {
    const systemParts = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
    if (req.jsonMode) systemParts.push(JSON_ONLY);

    const contents = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    const generationConfig: Record<string, unknown> = {};
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
    if (req.jsonMode) generationConfig.responseMimeType = 'application/json';

    const body: Record<string, unknown> = { contents };
    if (systemParts.length) body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

    const model = req.model || cfg.model;
    return {
      url: `${modelsBase(cfg.baseUrl)}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': cfg.apiKey,
        accept: 'text/event-stream',
        ...cfg.headers,
      },
      body: JSON.stringify(body),
    };
  },

  buildModelsRequest(cfg: EndpointConfig): PreparedRequest {
    return {
      url: modelsBase(cfg.baseUrl),
      method: 'GET',
      headers: {
        'x-goog-api-key': cfg.apiKey,
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
      return [];
    }
    const obj = asRecord(json);
    if (!obj) return [];

    const events: StreamEvent[] = [];
    if (obj.error) return [{ type: 'error', error: errorText(obj.error) }];

    const usage = mapGeminiUsage(obj.usageMetadata);
    if (usage) events.push({ type: 'usage', usage });

    const candidates = Array.isArray(obj.candidates) ? obj.candidates : [];
    const candidate = asRecord(candidates[0]);
    if (candidate) {
      const content = asRecord(candidate.content) ?? {};
      const reasoning = partsText(content.parts, true);
      if (reasoning) events.push({ type: 'reasoning', delta: reasoning });
      const text = partsText(content.parts, false);
      if (text) events.push({ type: 'text', delta: text });

      partsFunctionCalls(content.parts).forEach((call, i) => {
        events.push({
          type: 'tool-call',
          index: i,
          name: call.name,
          argumentsDelta: JSON.stringify(call.args),
        });
      });

      // Gemini 每帧都可能带 finishReason；"STOP" 表示正常结束
      const finish = pickString(candidate.finishReason);
      if (finish) events.push({ type: 'done', finishReason: finish });
    }

    const block = pickString(asRecord(obj.promptFeedback)?.blockReason);
    if (block) events.push({ type: 'error', error: `blocked: ${block}` });

    return events;
  },

  parseChatResponse(json: unknown, httpStatus?: number): ModelResponse {
    const obj = asRecord(json);
    if (!obj) return { text: '', httpStatus, error: '响应不是 JSON 对象' };
    if (obj.error) return { text: '', httpStatus, error: errorText(obj.error), raw: json };

    const candidates = Array.isArray(obj.candidates) ? obj.candidates : [];
    const candidate = asRecord(candidates[0]);
    if (!candidate) {
      const block = pickString(asRecord(obj.promptFeedback)?.blockReason);
      return {
        text: '',
        httpStatus,
        raw: json,
        ...(block ? { error: `blocked: ${block}` } : {}),
      };
    }

    const content = asRecord(candidate.content) ?? {};
    const out: ModelResponse = { text: partsText(content.parts, false), raw: json };
    if (httpStatus !== undefined) out.httpStatus = httpStatus;

    const reasoning = partsText(content.parts, true);
    if (reasoning) out.reasoning = reasoning;

    const calls = partsFunctionCalls(content.parts).map((c) => ({
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }));
    const toolCalls = mapToolCalls(calls);
    if (toolCalls.length) out.toolCalls = toolCalls;

    const finish = pickString(candidate.finishReason);
    if (finish) out.finishReason = finish;
    const usage = mapGeminiUsage(obj.usageMetadata);
    if (usage) out.usage = usage;
    return out;
  },

  parseModelsResponse(json: unknown): string[] {
    const obj = asRecord(json);
    const list = obj && Array.isArray(obj.models) ? obj.models : [];
    return list
      .map((raw) => {
        const item = asRecord(raw);
        if (!item) return undefined;
        const name = pickString(item.name);
        if (!name) return undefined;
        // "models/gemini-2.5-pro" → "gemini-2.5-pro"
        return name.startsWith('models/') ? name.slice('models/'.length) : name;
      })
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  },
};

function mapGeminiUsage(raw: unknown): Usage | undefined {
  const u = asRecord(raw);
  if (!u) return undefined;
  const usage: Usage = {};
  const prompt = pickNumber(u.promptTokenCount);
  const completion = pickNumber(u.candidatesTokenCount);
  const total = pickNumber(u.totalTokenCount);
  if (prompt !== undefined) usage.promptTokens = prompt;
  if (completion !== undefined) usage.completionTokens = completion;
  if (total !== undefined) usage.totalTokens = total;
  return Object.keys(usage).length ? usage : undefined;
}
