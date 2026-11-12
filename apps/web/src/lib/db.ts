/**
 * IndexedDB 持久化（F13）：checkpoint 与最终结果都落在浏览器本地。
 * 隐私（D4）：这里只存题库结果与端点快照，永不存 API Key。
 */
import type { RunCheckpoint, RunRecord } from './types.js';

const DB_NAME = 'llmbm';
const DB_VERSION = 1;
const STORE_CHECKPOINTS = 'checkpoints';
const STORE_RUNS = 'runs';

let dbPromise: Promise<IDBDatabase | undefined> | undefined;

function openDb(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(undefined);
  dbPromise ??= new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CHECKPOINTS)) db.createObjectStore(STORE_CHECKPOINTS, { keyPath: 'runId' });
      if (!db.objectStoreNames.contains(STORE_RUNS)) db.createObjectStore(STORE_RUNS, { keyPath: 'runId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) {
          resolve(undefined);
          return;
        }
        const transaction = db.transaction(store, mode);
        const request = fn(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
        transaction.onabort = () => resolve(undefined);
      }),
  );
}

export async function saveCheckpoint(cp: RunCheckpoint): Promise<void> {
  await tx(STORE_CHECKPOINTS, 'readwrite', (s) => s.put(cp));
}

export async function loadCheckpoint(runId: string): Promise<RunCheckpoint | undefined> {
  return tx<RunCheckpoint>(STORE_CHECKPOINTS, 'readonly', (s) => s.get(runId));
}

export async function deleteCheckpoint(runId: string): Promise<void> {
  await tx(STORE_CHECKPOINTS, 'readwrite', (s) => s.delete(runId));
}

export async function listCheckpoints(): Promise<RunCheckpoint[]> {
  const all = await tx<RunCheckpoint[]>(STORE_CHECKPOINTS, 'readonly', (s) => s.getAll());
  return (all ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function latestCheckpoint(): Promise<RunCheckpoint | undefined> {
  return (await listCheckpoints())[0];
}

export async function saveRun(run: RunRecord): Promise<void> {
  await tx(STORE_RUNS, 'readwrite', (s) => s.put(run));
}

export async function loadRun(runId: string): Promise<RunRecord | undefined> {
  return tx<RunRecord>(STORE_RUNS, 'readonly', (s) => s.get(runId));
}

export async function latestRun(): Promise<RunRecord | undefined> {
  const all = await tx<RunRecord[]>(STORE_RUNS, 'readonly', (s) => s.getAll());
  return (all ?? []).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}
