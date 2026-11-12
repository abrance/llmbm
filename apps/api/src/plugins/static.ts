/**
 * 前端静态托管：单镜像形态（spec §7），api 进程内托管 apps/web/dist。
 * 同源免 CORS、上层只部署一个单元；开发时 webRoot 不存在则跳过，Vite 自己服务前端。
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** 返回可托管的绝对目录；目录不存在或不是目录则返回 undefined。 */
export function resolveWebRoot(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  try {
    return statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 接口前缀不参与 SPA 回落。
 * /__mock 只在 dev / preview 存在；生产构建里它必须和 /api 一样返回 JSON 404，
 * 不能被回落成 200 text/html（否则前端会把接口错误当成正常页面）。
 */
function isInterfacePath(url: string): boolean {
  const pathname = url.split('?')[0] ?? '';
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/__mock' || pathname.startsWith('/__mock/');
}

/**
 * 注册静态托管 + SPA 回落。
 * 回落只对 GET/HEAD 且非接口路径生效，避免把接口 404 变成 HTML。
 */
export async function registerStatic(app: FastifyInstance, webRoot: string): Promise<void> {
  const indexFile = join(webRoot, 'index.html');
  await app.register(fastifyStatic, { root: webRoot, wildcard: false, index: ['index.html'] });

  app.setNotFoundHandler((request, reply) => {
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    if (isInterfacePath(request.url) || !isRead || !existsSync(indexFile)) {
      return reply.code(404).send({ error: '未找到该接口或资源' });
    }
    return reply.type('text/html; charset=utf-8').sendFile('index.html');
  });
}
