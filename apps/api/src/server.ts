import { buildApp } from './app.js';

const port = Number(process.env['PORT'] ?? 8787);
const host = process.env['HOST'] ?? '0.0.0.0';
const dbPath = process.env['LLMBM_DB'] ?? './data/llmbm.db';

const { app, close } = await buildApp({ dbPath, logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void close().then(() => process.exit(0));
  });
}

await app.listen({ port, host });
app.log.info(`llmbm api listening on ${host}:${port} (db: ${dbPath})`);
