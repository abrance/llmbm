/**
 * 协议适配入口。web 与 api 只从这里引（D1：adapter 只有这一份实现）。
 */
import type { Adapter, EndpointConfig, Protocol } from '../types.js';
import { anthropicAdapter } from './anthropic.js';
import { geminiAdapter } from './gemini.js';
import { openaiAdapter } from './openai.js';

export { openaiAdapter, anthropicAdapter, geminiAdapter };
export { createStreamAccumulator, accumulateSse } from './stream.js';
export type { StreamAccumulator } from './stream.js';

const ADAPTERS: Record<Protocol, Adapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
};

export function getAdapter(protocol: Protocol): Adapter {
  const adapter = ADAPTERS[protocol];
  if (!adapter) throw new Error(`未知协议: ${String(protocol)}`);
  return adapter;
}

export const PROTOCOLS: readonly Protocol[] = ['openai', 'anthropic', 'gemini'];

/**
 * 从 baseUrl / 模型名推断协议。判断顺序：显式特征 > 模型名前缀 > 默认 openai。
 * 推断错也能用：cfg.protocol 显式给出时以它为准。
 */
export function detectProtocol(baseUrl: string, modelHint?: string): Protocol {
  const url = (baseUrl ?? '').toLowerCase();
  if (url.includes('anthropic') || url.includes('claude')) return 'anthropic';
  if (url.includes('generativelanguage.googleapis.com') || url.includes('gemini')) return 'gemini';

  const model = (modelHint ?? '').toLowerCase();
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gemini')) return 'gemini';
  return 'openai';
}

/** 429 与 5xx 值得退避重试；4xx（除 429）重试没有意义。 */
export function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

/** 用 cfg.protocol，缺省时按 baseUrl + model 推断。 */
export function resolveAdapter(cfg: EndpointConfig): Adapter {
  return getAdapter(cfg.protocol ?? detectProtocol(cfg.baseUrl, cfg.model));
}
