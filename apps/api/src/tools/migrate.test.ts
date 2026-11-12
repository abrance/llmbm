/**
 * 迁移脚本的自检：参数解析、差异比对、以及一次真实往返（SQLite 文件 → 临时表比对）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { diffRows, parseArgs } from './migrate.js';
import { toPgSql, listQuery } from '../repo/results.js';

test('migrate: 占位符按顺序翻成 $n，数量不符直接抛', () => {
  assert.equal(toPgSql('SELECT * FROM t WHERE a = ? AND b = ?', 2), 'SELECT * FROM t WHERE a = $1 AND b = $2');
  assert.throws(() => toPgSql('SELECT * FROM t WHERE a = ?', 2), /占位符数量/);
  assert.equal(toPgSql('SELECT 1', 0), 'SELECT 1');
});

test('migrate: listQuery 的占位符数永远等于参数数', () => {
  for (const filter of [{}, { domain: 'a' }, { model: 'm' }, { domain: 'a', model: 'm', limit: 7 }]) {
    const { sql, params } = listQuery(filter);
    assert.equal((sql.match(/\?/g) ?? []).length, params.length, JSON.stringify(filter));
    assert.equal(params.at(-1), filter.limit ?? 50);
  }
  assert.equal(listQuery({ limit: 0 }).params.at(-1), 1);
  assert.equal(listQuery({ limit: 9999 }).params.at(-1), 200);
});

test('migrate: 参数解析默认 dry-run，--apply 才写，缺值报错', () => {
  assert.deepEqual(parseArgs(['--sqlite', 'x.db', '--pg', 'postgres://h/db'], {}), {
    sqlite: 'x.db',
    pgUrl: 'postgres://h/db',
    apply: false,
  });
  assert.equal(parseArgs(['--sqlite', 'x.db', '--pg', 'p', '--apply'], {}).apply, true);
  // DSN 可从环境退回
  assert.equal(parseArgs(['--sqlite', 'x.db'], { LLMBM_PG_URL: 'postgres://env/db' }).pgUrl, 'postgres://env/db');
  assert.throws(() => parseArgs(['--pg', 'p'], {}), /--sqlite/);
  assert.throws(() => parseArgs(['--sqlite'], {}), /缺少取值/);
  assert.throws(() => parseArgs(['--sqlite', 'x', '--pg', 'p', '--dry-run', '--apply'], {}), /不能同时给/);
});

test('migrate: diffRows 抓缺失、抓字段差异、全等返回空', () => {
  const rows = [
    { id: 'r1', domain: 'd', model: 'm', capability_score: 87.5, created_at: '2026-11-13T00:00:00.000Z' },
    { id: 'r2', domain: 'd', model: 'm', capability_score: 1, created_at: '2026-11-13T00:00:01.000Z' },
  ];
  assert.deepEqual(diffRows(rows, rows.map((r) => ({ ...r }))), []);

  const diffs = diffRows(rows, [
    { ...rows[0], capability_score: 88 },
    // r2 缺失
  ]);
  assert.equal(diffs.length, 2);
  assert.ok(diffs.some((d) => d.includes('r1: capability_score')));
  assert.ok(diffs.some((d) => d.includes('r2: PG 中缺失')));
});

test('migrate: 空 SQLite 库 dry-run 返回 0 且不报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'llmbm-migrate-'));
  const path = join(dir, 'empty.db');
  try {
    const db = new DatabaseSync(path);
    db.exec(
      'CREATE TABLE results (id TEXT PRIMARY KEY, domain TEXT, model TEXT, protocol TEXT, capability_score REAL, capability_half_width REAL, format_score REAL, stability REAL, question_bank_version TEXT, judge_rule_version TEXT, payload TEXT, created_at TEXT)',
    );
    db.close();
    const { migrate } = await import('./migrate.js');
    const lines: string[] = [];
    const code = await migrate(
      { sqlite: path, pgUrl: 'postgres://u:p@127.0.0.1:1/none', apply: false },
      (l) => lines.push(l),
    );
    assert.equal(code, 0);
    assert.ok(lines.some((l) => l.includes('0 行')));
    assert.ok(lines.some((l) => l.includes('dry-run')));
    // DSN 里的口令不能出现在输出里
    assert.ok(!lines.some((l) => l.includes('u:p@')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
