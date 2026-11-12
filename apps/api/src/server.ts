import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';

const port = Number(process.env['PORT'] ?? 8787);
const host = process.env['HOST'] ?? '0.0.0.0';
const dbPath = process.env['LLMBM_DB'] ?? './data/llmbm.db';
// 有 LLMBM_PG_URL 就走 Postgres，否则用上面的 SQLite 文件（回滚只需清空该变量）
const pgUrl = process.env['LLMBM_PG_URL'] || undefined;
// 单镜像：前端产物与 api 同包（apps/web/dist）；WEB_ROOT 可覆盖
const webRoot =
  process.env['WEB_ROOT'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');

const { app, close } = await buildApp({ dbPath, pgUrl, webRoot, logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void close().then(() => process.exit(0));
  });
}

await app.listen({ port, host });
app.log.info(`llmbm api listening on ${host}:${port} (backend: ${pgUrl ? 'pg' : 'sqlite'})`);
