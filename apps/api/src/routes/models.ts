/**
 * /api/models：OpenAI 兼容的模型列表拉取。
 * Key 由浏览器随请求带在 Authorization 头里，服务端只在内存中转发，不落盘不打日志（D4）。
 */
import type { FastifyInstance } from 'fastify';
import { forward, pipeForward } from './proxy.js';

interface ModelsQuery {
  baseUrl?: string;
}

export function registerModelsRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: ModelsQuery }>('/api/models', async (request, reply) => {
    const baseUrl = request.query.baseUrl?.trim();
    if (!baseUrl) {
      return reply.code(400).send({ error: '缺少 baseUrl 参数' });
    }
    const auth = request.headers.authorization;
    if (!auth) {
      return reply.code(400).send({ error: '缺少 Authorization 头（API Key 由浏览器直接携带）' });
    }
    const url = baseUrl.replace(/\/+$/, '') + '/models';
    const result = await forward({
      url,
      method: 'GET',
      headers: { authorization: auth, accept: 'application/json' },
    });
    return pipeForward(reply, result);
  });
}
