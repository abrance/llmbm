/**
 * 内置 Mock 端点（仅 dev / preview）：`/__mock/v1`。
 * 请求处理在 `./handler.ts`（同一份实现在单测里也能挂在真实 http server 上跑）。
 * 生产构建不包含这个中间件 —— 它不是任何真实模型的替代品。
 */
import type { Plugin } from 'vite';
import { createMockHandler } from './handler.js';

/** Vite 插件：dev 与 preview 都挂同一个中间件。 */
export function mockApiPlugin(): Plugin {
  const handler = createMockHandler();
  return {
    name: 'llmbm-mock-api',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
