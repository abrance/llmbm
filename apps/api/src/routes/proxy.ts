/**
 * 代理转发（D4/D5）。
 * D4：不落盘 Key 与请求体，不打日志；响应原样透传（含 SSE）。
 * D5：目标校验、并发上限、单请求超时、body 上限在 server.ts 统一挂。
 */
import type { FastifyReply } from 'fastify';
import { checkTarget, DEFAULTS, isRetryableStatus } from '../plugins/guard.js';

export interface ForwardOptions {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export type ForwardResult =
  | { ok: true; status: number; headers: Record<string, string>; body: ReadableStream<Uint8Array> | null }
  | { ok: false; status: number; error: string };

/** 只透传与内容相关的头，避免把上游的 set-cookie / 鉴权头带回来。 */
const PASS_THROUGH = ['content-type', 'cache-control', 'x-request-id'];

export async function forward(opts: ForwardOptions): Promise<ForwardResult> {
  const check = checkTarget(opts.url);
  if (!check.ok) return { ok: false, status: 400, error: check.reason ?? '目标地址被拒绝' };

  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(opts.url, {
      method: opts.method,
      headers: opts.headers,
      ...(opts.body === undefined ? {} : { body: opts.body }),
      signal: controller.signal,
      redirect: 'manual',
    });
    const headers: Record<string, string> = {};
    for (const name of PASS_THROUGH) {
      const v = res.headers.get(name);
      if (v) headers[name] = v;
    }
    return { ok: true, status: res.status, headers, body: res.body };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      status: aborted ? 504 : 502,
      error: aborted ? `上游超时（${timeoutMs}ms）` : `上游请求失败：${(err as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 把转发结果写回客户端；SSE 直接 pipe，不缓冲。 */
export async function pipeForward(reply: FastifyReply, result: ForwardResult): Promise<void> {
  if (!result.ok) {
    reply.code(result.status).send({ error: result.error });
    return;
  }
  reply.code(result.status);
  for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
  if (!result.body) {
    reply.send();
    return;
  }
  // 用 Web Stream → Node 流，避免整包读进内存
  const { Readable } = await import('node:stream');
  reply.send(Readable.fromWeb(result.body as Parameters<typeof Readable.fromWeb>[0]));
}

export { isRetryableStatus };
