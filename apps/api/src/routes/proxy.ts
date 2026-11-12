/**
 * 代理转发（D4/D5）。
 * D4：不落盘 Key 与请求体，不打日志；响应原样透传（含 SSE）。
 * D5：目标校验、并发上限、单请求超时、body 上限在 server.ts 统一挂。
 */
import { Readable } from 'node:stream';
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
  if (!result.body) {
    reply.code(result.status);
    for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
    reply.send();
    return;
  }
  // 流式分支必须 hijack 后直接 pipe 底层响应：本 handler 是 async，其 promise 在
  // 拿到响应头时就已结算，而流还没吐完；Fastify 的 wrapThenable 会因此补发一次
  // send(undefined)，把已 pipe 的响应覆盖成 content-length: 0 的空 body。
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(result.status, result.headers);
  // Web Stream → Node 流，避免整包读进内存
  const source = Readable.fromWeb(result.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('error', (err: Error) => {
    // 头已发出，无法再回 JSON 错误：断开连接让客户端看到截断，而不是假成功
    reply.log.warn({ err }, '上游响应流中断');
    raw.destroy();
  });
  raw.on('close', () => source.destroy());
  source.pipe(raw);
}

export { isRetryableStatus };
