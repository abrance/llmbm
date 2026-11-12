/**
 * 迁移脚本的自检：参数解析、差异比对、以及一次真实往返（SQLite 文件 → 临时表比对）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { diffRows, parseArgs, migrate } from './migrate.js';
import { toPgSql, listQuery, openRepo, type Repo } from '../repo/results.js';
import pg from 'pg';
import { EventEmitter } from 'node:events';

const PG_URL = process.env['LLMBM_PG_URL'];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/**
 * 缺陷 1 的自检（真 PG）：事务必须钉在同一条连接上。
 *
 * pool.query 的语义是「借一条连接、跑完归还」，不保证两次调用同一条。这里把
 * pool.query 临时换成「每次都用一条全新连接」的极端实现，正是那条语义的最坏情况：
 * - 老写法（BEGIN 走 pool.query，INSERT 也走 pool.query）→ BEGIN 的事务落在另一条
 *   连接上，INSERT 变成自动提交，中途失败时先写成功的行留在库里 → 本用例失败；
 * - 新写法（pool.connect 拿到的 client 上执行）→ 全部在同一连接，失败整批回滚 → 通过。
 */
test(
  'migrate: --apply 中途失败时整批回滚（事务必须在同一连接）',
  { skip: PG_URL ? false : 'LLMBM_PG_URL 未设置，跳过实库事务自检' },
  async () => {
    assert.ok(PG_URL);
    const dir = mkdtempSync(join(tmpdir(), 'llmbm-migrate-tx-'));
    const path = join(dir, 'tx.db');
    const stamp = Date.now().toString(36);
    const pool = new pg.Pool({ connectionString: PG_URL });
    const origQuery = pg.Pool.prototype.query;
    try {
      // SQLite 侧不设约束，才能造出「前一行合法、后一行违反 PG NOT NULL」的批次
      const db = new DatabaseSync(path);
      db.exec(
        'CREATE TABLE results (id TEXT, domain TEXT, model TEXT, protocol TEXT, capability_score REAL, capability_half_width REAL, format_score REAL, stability REAL, question_bank_version TEXT, judge_rule_version TEXT, payload TEXT, created_at TEXT)',
      );
      const insert = db.prepare('INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
      // 好行时间更早：按 created_at 排序时它先插入，回滚才有东西可验
      insert.run(`r_selftest_good_${stamp}`, 'selftest.tx', 'm', 'openai', 1, 1, 1, 1, 'qb', '1', '{}', '2020-01-01T00:00:00.000Z');
      insert.run(null, 'selftest.tx', 'm', 'openai', 1, 1, 1, 1, 'qb', '1', '{}', '2020-01-01T00:00:01.000Z');
      db.close();

      // 模拟最坏情况：每次 pool.query 都是一条独立连接
      pg.Pool.prototype.query = async function (text: string, values?: unknown[]) {
        const solo = new pg.Client({ connectionString: PG_URL });
        await solo.connect();
        try {
          return await solo.query(text, values);
        } finally {
          await solo.end();
        }
      } as typeof origQuery;

      const lines: string[] = [];
      await assert.rejects(
        migrate({ sqlite: path, pgUrl: PG_URL!, apply: true }, (l) => lines.push(l)),
        /null value in column "id"|NOT NULL/i,
      );
      pg.Pool.prototype.query = origQuery;

      const left = await pool.query('SELECT count(*)::int AS n FROM results WHERE domain = $1', ['selftest.tx']);
      assert.equal((left.rows[0] as { n: number }).n, 0, '整批必须回滚，库里不应留下半批数据');
    } finally {
      pg.Pool.prototype.query = origQuery;
      await pool.query('DELETE FROM results WHERE domain = $1', ['selftest.tx']);
      await pool.end();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

/**
 * 缺陷 2 的自检（真 PG）：Pool 的空闲连接被服务端断开时必须被接住。
 *
 * 走真实链路（openRepo → pgDriver → Pool），不从外部挂监听：用 EventEmitter.prototype.on
 * 抓出 pgDriver 创建的那个 Pool，确认它自己注册了 error 处理；再从 PG 侧 terminate 掉
 * 它刚归还的那条空闲连接，确认只打一行、且日志里不含 DSN（口令）。
 * 去掉 pgDriver 里的 guardPoolErrors，本用例会在「没有 error 监听」处失败。
 */
test(
  'repo: pgDriver 挂上 Pool error 处理，空闲连接被杀只打一行',
  { skip: PG_URL ? false : 'LLMBM_PG_URL 未设置，跳过 Pool error 自检' },
  async () => {
    assert.ok(PG_URL);
    const pools: pg.Pool[] = [];
    const origOn = EventEmitter.prototype.on;
    let repo: Repo | undefined;
    const killer = new pg.Pool({ connectionString: PG_URL });
    const logged: string[] = [];
    const origError = console.error;
    try {
      EventEmitter.prototype.on = function (this: unknown, ev: string | symbol, fn: (...a: unknown[]) => void) {
        if (ev === 'error' && this instanceof pg.Pool) pools.push(this);
        return origOn.call(this, ev, fn);
      } as typeof origOn;
      // 先接住 console.error 再建 Pool：guardPoolErrors 的日志出口在创建时就绑定好了
      console.error = ((...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(' '));
      }) as typeof console.error;
      repo = await openRepo(':memory:', PG_URL);
      EventEmitter.prototype.on = origOn;
      await repo.list({ limit: 1 }); // 让 Pool 里至少有一条连接

      assert.equal(pools.length, 1, 'pgDriver 必须为自己的 Pool 注册 error 处理');
      assert.ok(pools[0]!.listenerCount('error') >= 1);
      const own = pools[0]!;

      const { pid } = (await own.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number };
      await killer.query('SELECT pg_terminate_backend($1)', [pid]);
      const deadline = Date.now() + 5000;
      while (!logged.length && Date.now() < deadline) await sleep(50);

      assert.equal(logged.length, 1, '应恰好收到一次空闲连接错误');
      assert.match(logged[0]!, /pg pool 空闲连接错误：/);
      assert.ok(!logged[0]!.includes('@'), '日志里不能带 connectionString（含口令）');
    } finally {
      console.error = origError;
      EventEmitter.prototype.on = origOn;
      await repo?.close();
      await killer.end();
    }
  },
);
