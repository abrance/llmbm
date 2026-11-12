/**
 * 存储层：单文件 SQLite（node:sqlite 内置）。
 * 只有这一层碰 SQL；换 PG 只改本文件（spec §4）。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

export interface Repo {
  insert(input: ResultInput): ResultRow;
  list(filter: { domain?: string; model?: string; limit?: number }): ResultRow[];
  get(id: string): ResultRow | undefined;
  close(): void;
}

const SCHEMA = `
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

/** 测试用内存库；传 path 则落盘。 */
export function openRepo(path = ':memory:'): Repo {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  const insertStmt = db.prepare(
    `INSERT INTO results (id, domain, model, protocol, capability_score, capability_half_width,
      format_score, stability, question_bank_version, judge_rule_version, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getStmt = db.prepare('SELECT * FROM results WHERE id = ?');

  const toRow = (r: Record<string, unknown>): ResultRow => ({
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
  });

  return {
    insert(input) {
      const id = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = new Date().toISOString();
      insertStmt.run(
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
      );
      return toRow(getStmt.get(id) as Record<string, unknown>);
    },

    list(filter) {
      const where: string[] = [];
      const args: string[] = [];
      if (filter.domain) {
        where.push('domain = ?');
        args.push(filter.domain);
      }
      if (filter.model) {
        where.push('model = ?');
        args.push(filter.model);
      }
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
      const sql =
        'SELECT * FROM results' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY created_at DESC LIMIT ?';
      const rows = db.prepare(sql).all(...args, String(limit)) as Record<string, unknown>[];
      return rows.map(toRow);
    },

    get(id) {
      const row = getStmt.get(id) as Record<string, unknown> | undefined;
      return row ? toRow(row) : undefined;
    },

    close() {
      db.close();
    },
  };
}
