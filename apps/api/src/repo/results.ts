/**
 * 存储层：一套 SQL + 两个瘦驱动（PG / SQLite），只有这一层碰 SQL（spec §4）。
 *
 * - 生产：`LLMBM_PG_URL` 有值 → `pg` 的 Pool；没值 → `LLMBM_DB` 的 SQLite 文件（这同时是回滚开关）。
 * - 测试：SQLite `:memory:`。
 * - SQL 只写一份，占位符一律写 `?`，PG 驱动按出现顺序翻成 `$n`。SQL 文本里不要出现字面 `?`。
 * - DDL 两边通用：只用 TEXT/REAL/INTEGER，主键是应用生成的 uuid 文本，不用 AUTOINCREMENT/SERIAL。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

export interface ResultRow {
  id: string;
  domain: string;
  model: string;
  protocol: string;
  capabilityScore: number;
  capabilityHalfWidth: number;
  formatScore: number;
  stability: number;
  questionBankVersion: string;
  judgeRuleVersion: string;
  payload: string;
  createdAt: string;
}

export interface ResultInput {
  domain: string;
  model: string;
  protocol: string;
  capabilityScore: number;
  capabilityHalfWidth: number;
  formatScore: number;
  stability: number;
  questionBankVersion: string;
  judgeRuleVersion: string;
  payload: unknown;
}

export type Backend = 'pg' | 'sqlite';

export interface Repo {
  readonly backend: Backend;
  insert(input: ResultInput): Promise<ResultRow>;
  list(filter: { domain?: string; model?: string; limit?: number }): Promise<ResultRow[]>;
  get(id: string): Promise<ResultRow | undefined>;
  close(): Promise<void>;
}

/** 建表语句。两边都能直接跑（SQLite exec / PG 简单查询支持多语句）。 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  model TEXT NOT NULL,
  protocol TEXT NOT NULL,
  capability_score REAL NOT NULL,
  capability_half_width REAL NOT NULL,
  format_score REAL NOT NULL,
  stability REAL NOT NULL,
  question_bank_version TEXT NOT NULL,
  judge_rule_version TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_domain_model ON results(domain, model, created_at DESC);
`;

const INSERT_SQL = `INSERT INTO results (id, domain, model, protocol, capability_score,
  capability_half_width, format_score, stability, question_bank_version, judge_rule_version,
  payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const GET_SQL = 'SELECT * FROM results WHERE id = ?';

const COLUMNS = [
  'id',
  'domain',
  'model',
  'protocol',
  'capability_score',
  'capability_half_width',
  'format_score',
  'stability',
  'question_bank_version',
  'judge_rule_version',
  'payload',
  'created_at',
] as const;

function countPlaceholders(sql: string): number {
  let n = 0;
  for (const ch of sql) if (ch === '?') n += 1;
  return n;
}

/** `?` → `$1..$n`。数量必须与参数个数一致，否则直接抛（避免静默错绑）。 */
export function toPgSql(sql: string, paramCount: number): string {
  const expected = countPlaceholders(sql);
  if (expected !== paramCount) {
    throw new Error(`占位符数量(${expected})与参数数量(${paramCount})不一致：${sql}`);
  }
  let n = 0;
  return sql.replace(/\?/g, () => `$${(n += 1)}`);
}

function toRow(r: Record<string, unknown>): ResultRow {
  return {
    id: String(r['id']),
    domain: String(r['domain']),
    model: String(r['model']),
    protocol: String(r['protocol']),
    capabilityScore: Number(r['capability_score']),
    capabilityHalfWidth: Number(r['capability_half_width']),
    formatScore: Number(r['format_score']),
    stability: Number(r['stability']),
    questionBankVersion: String(r['question_bank_version']),
    judgeRuleVersion: String(r['judge_rule_version']),
    payload: String(r['payload']),
    createdAt: String(r['created_at']),
  };
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 50, 1), 200);
}

/** list 的 SQL 与参数（唯一一份）。 */
export function listQuery(filter: { domain?: string; model?: string; limit?: number }): {
  sql: string;
  params: unknown[];
} {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.domain) {
    where.push('domain = ?');
    params.push(filter.domain);
  }
  if (filter.model) {
    where.push('model = ?');
    params.push(filter.model);
  }
  const sql =
    'SELECT * FROM results' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY created_at DESC LIMIT ?';
  params.push(clampLimit(filter.limit));
  return { sql, params };
}

interface Driver {
  backend: Backend;
  all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params: unknown[]): Promise<void>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

function sqliteDriver(path: string): Driver {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  // 同步 API 留在驱动内部，对外仍是 Promise（调用方不用关心后端形态）
  const db = new DatabaseSync(path);
  return {
    backend: 'sqlite',
    async all(sql, params) {
      return db.prepare(sql).all(...(params as (string | number)[])) as Record<string, unknown>[];
    },
    async run(sql, params) {
      db.prepare(sql).run(...(params as (string | number)[]));
    },
    async exec(sql) {
      db.exec(sql);
    },
    async close() {
      db.close();
    },
  };
}

function pgDriver(connectionString: string): Driver {
  const pool = new pg.Pool({ connectionString });
  return {
    backend: 'pg',
    async all(sql, params) {
      const res = await pool.query(toPgSql(sql, params.length), params);
      return res.rows as Record<string, unknown>[];
    },
    async run(sql, params) {
      await pool.query(toPgSql(sql, params.length), params);
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    },
  };
}

/** pgUrl 有值走 PG，否则用 path（默认内存库，测试用）。 */
export async function openRepo(path = ':memory:', pgUrl?: string): Promise<Repo> {
  const driver: Driver = pgUrl ? pgDriver(pgUrl) : sqliteDriver(path);
  await driver.exec(SCHEMA);

  return {
    backend: driver.backend,

    async insert(input) {
      const id = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = new Date().toISOString();
      await driver.run(INSERT_SQL, [
        id,
        input.domain,
        input.model,
        input.protocol,
        input.capabilityScore,
        input.capabilityHalfWidth,
        input.formatScore,
        input.stability,
        input.questionBankVersion,
        input.judgeRuleVersion,
        JSON.stringify(input.payload),
        createdAt,
      ]);
      const row = await driver.all(GET_SQL, [id]);
      const first = row[0];
      if (!first) throw new Error(`插入后读不到行：${id}`);
      return toRow(first);
    },

    async list(filter) {
      const { sql, params } = listQuery(filter);
      const rows = await driver.all(sql, params);
      return rows.map(toRow);
    },

    async get(id) {
      const rows = await driver.all(GET_SQL, [id]);
      const first = rows[0];
      return first ? toRow(first) : undefined;
    },

    async close() {
      await driver.close();
    },
  };
}

export { COLUMNS };
