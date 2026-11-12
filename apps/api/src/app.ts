/**
 * Fastify 应用装配。server.ts 只负责监听，测试直接 import buildApp 做注入测试。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { DEFAULTS, ConcurrencyGate } from './plugins/guard.js';
import { openRepo, type Repo } from './repo/results.js';
import { registerModelsRoutes } from './routes/models.js';
import { registerProxyRoutes } from './routes/passthrough.js';
import { registerCommunityRoutes } from './routes/community.js';
import { registerStatic, resolveWebRoot } from './plugins/static.js';

export interface AppOptions {
  /** ':memory:' 为内存库（测试用）。 */
  dbPath?: string;
  logger?: boolean;
  /** 前端构建产物目录（单镜像形态由 api 托管）。不存在则跳过。 */
  webRoot?: string;
}

export interface BuiltApp {
  app: FastifyInstance;
  repo: Repo;
  close(): Promise<void>;
}

export async function buildApp(options: AppOptions = {}): Promise<BuiltApp> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: DEFAULTS.bodyLimit,
    // D4：默认请求日志只含 method/url/hostname，不含 header 与 body，不要再加自定义 serializer
  });
  const repo = openRepo(options.dbPath ?? ':memory:');
  const gate = new ConcurrencyGate(DEFAULTS.maxConcurrency);

  await app.register(cors, { origin: true });

  // D5：并发闸门挂在所有 /api/proxy 与 /api/models 上
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/proxy') && !request.url.startsWith('/api/models')) return;
    if (!gate.tryEnter()) {
      return reply.code(429).send({ error: '服务端并发已满，请稍后重试' });
    }
    (request as unknown as { gateHeld: boolean }).gateHeld = true;
  });
  app.addHook('onResponse', async (request) => {
    if ((request as unknown as { gateHeld?: boolean }).gateHeld) {
      (request as unknown as { gateHeld?: boolean }).gateHeld = false;
      gate.leave();
    }
  });

  app.get('/api/health', async () => ({ ok: true, inFlight: gate.inFlight }));

  registerModelsRoutes(app);
  registerProxyRoutes(app);
  registerCommunityRoutes(app, repo);

  const webRoot = resolveWebRoot(options.webRoot);
  if (webRoot) await registerStatic(app, webRoot);

  return {
    app,
    repo,
    async close() {
      await app.close();
      repo.close();
    },
  };
}
