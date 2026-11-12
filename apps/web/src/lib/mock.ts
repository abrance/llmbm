/**
 * 内置 Mock：在浏览器本地构造 OpenAI 形状的 wire payload，再交给 core 的
 * `openaiAdapter.parseChatResponse` 解析。
 *
 * 为什么放在 web 本地而不是 Vite 中间件：中间件只存在于 `npm run dev` /
 * `preview`，api 托管构建产物时 `/__mock/**` 会落到 api 的 404，演示按钮必然
 * 全零。本地分流不依赖任何 HTTP 端点，dev 与构建产物行为一致。
 *
 * D1：这里只负责「造一份假响应」，不做任何解析；text / toolCalls / usage /
 * finishReason 的映射仍然只有 core adapter 一份。
 */
import { openaiAdapter } from '@llmbm/core/adapters';
import type { ModelResponse } from '@llmbm/core';

/** 与题库 `mock` 字段同形；不直接依赖题库模块，便于单测注入。 */
export interface MockQuestionLike {
  id: string;
  prompt?: string;
  system?: string;
  mock?: {
    text?: string;
    toolCalls?: { name: string; arguments: string }[];
  };
}

const MOCK_MODELS = ['mock-llmbm-pro', 'mock-llmbm-lite'] as const;

export function mockModelIds(): string[] {
  return [...MOCK_MODELS];
}

function mockUsageOf(prompt: string, text: string): Record<string, number> {
  const promptTokens = Math.max(1, Math.ceil(prompt.length / 4));
  const completionTokens = Math.max(1, Math.ceil(text.length / 4));
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function answerFor(
  question: MockQuestionLike,
  sampleIndex: number,
  injectFlaky: boolean,
): { text: string; toolCalls?: { name: string; arguments: string }[] } {
  if (!question.id) return { text: 'ok' };
  // 故障注入：只影响一道题的一次采样，用来演示区间、探针与单题重试。
  if (injectFlaky && question.id === 'basic-exact-002' && sampleIndex === 1) {
    return { text: 'Cat' };
  }
  const mock = question.mock;
  if (!mock) return { text: '这是 llmbm 内置 Mock 的占位回答（该题没有演示答案）。' };
  return { text: mock.text ?? '', ...(mock.toolCalls ? { toolCalls: mock.toolCalls } : {}) };
}

/** 构造一份 OpenAI `/chat/completions` 形状的响应体（纯本地，不发请求）。 */
export function buildMockChatPayload(
  question: MockQuestionLike,
  options: { model: string; sampleIndex: number; injectFlaky: boolean },
): unknown {
  const answer = answerFor(question, options.sampleIndex, options.injectFlaky);
  const prompt = [question.system ?? '', question.prompt ?? ''].join('\n');
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: answer.toolCalls ? null : answer.text,
  };
  if (answer.toolCalls) {
    message['tool_calls'] = answer.toolCalls.map((call, index) => ({
      id: `call_mock_${index}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return {
    id: `chatcmpl-mock-${question.id || 'anonymous'}-${options.sampleIndex}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: options.model || MOCK_MODELS[0],
    choices: [
      {
        index: 0,
        message,
        finish_reason: answer.toolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: mockUsageOf(prompt, answer.text),
  };
}

/**
 * 本地 Mock 的一次「请求」：造 payload，再走 core 的解析入口归一化。
 * 返回的 ModelResponse 与真实端点同形（httpStatus=200、raw=wire payload）。
 */
export function mockChatResponse(
  question: MockQuestionLike,
  options: { model: string; sampleIndex: number; injectFlaky: boolean },
): ModelResponse {
  const payload = buildMockChatPayload(question, options);
  return { ...openaiAdapter.parseChatResponse(payload, 200), raw: payload };
}
