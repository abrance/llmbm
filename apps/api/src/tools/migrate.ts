/**
 * 一次性迁移：SQLite `results` → Postgres `results`。
 *
 *   node dist/tools/migrate.js --sqlite <path> [--pg "$LLMBM_PG_URL"] [--dry-run|--apply]
 *
 * - 默认 dry-run，只报告将要写入多少行，不碰 PG 数据；必须显式 `--apply` 才写。
 * - 写入用 `ON CONFLICT (id) DO NOTHING`，可重复执行（幂等）。
 * - 结束后读回 PG 逐行比对关键字段，有任何差异退出码 1。
 * - DSN 只从参数或环境读，日志里只打 host/db，不打用户名与密码。
 */
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { SCHEMA, toPgSql } from '../repo/results.js';

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

const KEY_FIELDS = ['id', 'domain', 'model', 'capability_score', 'created_at'] as const;

const SELECT_ALL = `SELECT ${COLUMNS.join(', ')} FROM results ORDER BY created_at`;
const INSERT_ONE = `INSERT INTO results (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT (id) DO NOTHING`;

export interface Args {
  sqlite: string;
  pgUrl: string;
  apply: boolean;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} 缺少取值`);
    return value;
  };
  const sqlite = get('--sqlite');
  if (!sqlite) throw new Error('缺少 --sqlite <path>');
  const pgUrl = get('--pg') ?? env['LLMBM_PG_URL'];
  if (!pgUrl) throw new Error('缺少 --pg <dsn>（或设置 LLMBM_PG_URL）');
  const apply = argv.includes('--apply');
  if (apply && argv.includes('--dry-run')) throw new Error('--dry-run 与 --apply 不能同时给');
  return { sqlite, pgUrl, apply };
}

/** 逐行比对关键字段，返回人类可读的差异列表（空数组表示全等）。 */
export function diffRows(
  expected: Record<string, unknown>[],
  actual: Record<string, unknown>[],
): string[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of actual) byId.set(String(row['id']), row);

  const diffs: string[] = [];
  for (const want of expected) {
    const id = String(want['id']);
    const got = byId.get(id);
    if (!got) {
      diffs.push(`${id}: PG 中缺失`);
      continue;
    }
    for (const field of KEY_FIELDS) {
      const a = String(want[field]);
      const b = String(got[field]);
      if (a !== b) diffs.push(`${id}: ${field} sqlite=${a} pg=${b}`);
    }
  }
  return diffs;
}

function redactDsn(dsn: string): string {
  try {
    const url = new URL(dsn);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    return '<unparsable dsn>';
  }
}

export async function migrate(args: Args, log: (line: string) => void = console.log): Promise<number> {
  const sqlite = new DatabaseSync(args.sqlite, { readOnly: true });
  let rows: Record<string, unknown>[] = [];
  try {
    rows = sqlite.prepare(SELECT_ALL).all() as Record<string, unknown>[];
  } finally {
    sqlite.close();
  }
  log(`sqlite ${args.sqlite}: ${rows.length} 行`);
  log(`pg ${redactDsn(args.pgUrl)}: ${args.apply ? 'apply' : 'dry-run（默认；加 --apply 才写）'}`);

  if (!args.apply) {
    log(`dry-run：将尝试 upsert ${rows.length} 行（ON CONFLICT (id) DO NOTHING），未写入任何数据`);
    return 0;
  }

  const pool = new pg.Pool({ connectionString: args.pgUrl });
  try {
    await pool.query(SCHEMA);
    let inserted = 0;
    let skipped = 0;
    await pool.query('BEGIN');
    try {
      for (const row of rows) {
        const res = await pool.query(
          toPgSql(INSERT_ONE, COLUMNS.length),
          COLUMNS.map((c) => row[c]),
        );
        if (res.rowCount === 1) inserted += 1;
        else skipped += 1;
      }
      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
    log(`写入完成：新增 ${inserted} 行，已存在跳过 ${skipped} 行`);

    const total = await pool.query('SELECT count(*)::int AS n FROM results');
    log(`pg 当前总行数：${String((total.rows[0] as { n: number }).n)}`);

    const ids = rows.map((r) => String(r['id']));
    const back = await pool.query(`SELECT ${COLUMNS.join(', ')} FROM results WHERE id = ANY($1)`, [ids]);
    const diffs = diffRows(rows, back.rows as Record<string, unknown>[]);
    if (diffs.length) {
      log(`比对失败：${diffs.length} 处差异（只列前 20 条）`);
      for (const d of diffs.slice(0, 20)) log(`  ${d}`);
      return 1;
    }
    log(`比对通过：${rows.length} 行关键字段（${KEY_FIELDS.join('/')}）全等`);
    return 0;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`参数错误：${(err as Error).message}`);
    console.error('用法：node dist/tools/migrate.js --sqlite <path> [--pg <dsn>] [--dry-run|--apply]');
    process.exit(2);
  }
  process.exitCode = await migrate(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
