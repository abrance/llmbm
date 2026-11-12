/**
 * 浏览器侧存储：Key 与 checkpoint 都只在 localStorage（D4）。
 * 服务端从不接收持久化的 Key —— 每次请求由浏览器现取现用。
 */
import type { Checkpoint } from './checkpoint.js';

const KEY_ENDPOINT = 'llmbm.endpoint';
const KEY_CHECKPOINT = 'llmbm.checkpoint';

export interface StoredEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol?: 'openai' | 'anthropic' | 'gemini';
  headers?: Record<string, string>;
}

/** localStorage 在 SSR/隐私模式下可能抛错，统一兜住，失败返回 undefined。 */
function safeGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): boolean {
  try {
    globalThis.localStorage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

export function loadEndpoint(): StoredEndpoint | undefined {
  const raw = safeGet(KEY_ENDPOINT);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as StoredEndpoint;
  } catch {
    return undefined;
  }
}

export function saveEndpoint(ep: StoredEndpoint): boolean {
  return safeSet(KEY_ENDPOINT, JSON.stringify(ep));
}

export function clearEndpoint(): void {
  safeRemove(KEY_ENDPOINT);
}

export function loadCheckpoint(): Checkpoint | undefined {
  const raw = safeGet(KEY_CHECKPOINT);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Checkpoint;
  } catch {
    return undefined;
  }
}

export function saveCheckpoint(cp: Checkpoint): boolean {
  return safeSet(KEY_CHECKPOINT, JSON.stringify(cp));
}

export function clearCheckpoint(): void {
  safeRemove(KEY_CHECKPOINT);
}
