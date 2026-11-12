/**
 * /api/proxy：SSE 透传（D4/D5）。
 * 前端在「允许走代理」明确勾选后才会调用；服务端不保存 Key 与请求体，只做流式转发。
 */
import type { FastifyInstance } from 'fastify';
import { forward, pipeForward } from './proxy.js';

interface ProxyBody {
  url?: string;
  method?: 'POST' | 'GET';
  headers?: Record<string, string>;
  body?: unknown;
}

/** 只允许转发这些头，其余一律丢弃（防止把 Cookie / 内网鉴权头带出去）。 */
const ALLOWED_HEADERS = new Set(['authorization', 'content-type', 'accept', 'x-api-key', 'anthropic-version']);

export function registerProxyRoutes(app: FastifyInstance): void {
  app.post<{ Body: ProxyBody }>('/api/proxy', async (request, reply) => {
    const { url, method = 'POST', headers = {}, body } = request.body ?? {};
    if (!url) return reply.code(400).send({ error: '缺少 url' });

    const safeHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const name = k.toLowerCase();
      if (ALLOWED_HEADERS.has(name) && typeof v === 'string') safeHeaders[name] = v;
    }

    const result = await forward({
      url,
      method,
      headers: safeHeaders,
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    return pipeForward(reply, result);
  });
}
