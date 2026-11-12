/**
 * Repo 契约测试：同一组用例对 SQLite 与 PG 各跑一遍（spec §4「换后端不改行为」）。
 * LLMBM_PG_URL 未设时 PG 那条 skip；设了就真跑，并在 finally 清掉自己写进去的行。
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { openRepo, type Repo, type ResultInput } from './results.js';

const PG_URL = process.env['LLMBM_PG_URL'];
const PREFIX = 'contract.local';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function input(domain: string, overrides: Partial<ResultInput> = {}): ResultInput {
  return {
    domain,
    model: 'gpt-4o',
    protocol: 'openai',
    capabilityScore: 87.5,
    capabilityHalfWidth: 3.1,
    formatScore: 96,
    stability: 1,
    questionBankVersion: 'qb-contract',
    judgeRuleVersion: '1',
    payload: { probes: [{ id: 'p1', pass: true }], n: 3 },
    ...overrides,
  };
}

async function runContract(t: TestContext, label: string, open: () => Promise<Repo>): Promise<void> {
  // 每个用例一个独立 domain：多个用例共用一个 PG 库时互不干扰（SQLite 每次新建内存库，天然隔离）
  const base = `${PREFIX}-${label}-${Date.now().toString(36)}`;
  let n = 0;
  const nextDomain = (): string => `${base}-${(n += 1)}`;
  let domain = nextDomain();

  await t.test('insert → get 字段全等', async () => {
    domain = nextDomain();
    const repo = await open();
    try {
      const sent = input(domain, { payload: { a: 1, b: ['x', 'y'], c: { d: null } } });
      const row = await repo.insert(sent);
      assert.match(row.id, /^r_/);
      assert.equal(row.domain, sent.domain);
      assert.equal(row.model, sent.model);
      assert.equal(row.protocol, sent.protocol);
      assert.equal(row.capabilityScore, sent.capabilityScore);
      assert.equal(row.capabilityHalfWidth, sent.capabilityHalfWidth);
      assert.equal(row.formatScore, sent.formatScore);
      assert.equal(row.stability, sent.stability);
      assert.equal(row.questionBankVersion, sent.questionBankVersion);
      assert.equal(row.judgeRuleVersion, sent.judgeRuleVersion);
      assert.equal(row.payload, JSON.stringify(sent.payload));
      assert.equal(new Date(row.createdAt).toISOString(), row.createdAt);

      const fetched = await repo.get(row.id);
      assert.deepEqual(fetched, row);
    } finally {
      await repo.close();
    }
  });

  await t.test('get 不存在返回 undefined', async () => {
    const repo = await open();
    try {
      assert.equal(await repo.get('r_does_not_exist'), undefined);
    } finally {
      await repo.close();
    }
  });

  await t.test('list 按 domain/model 过滤，limit 上下界被夹紧', async () => {
    domain = nextDomain();
    const repo = await open();
    try {
      await repo.insert(input(domain, { model: 'm-a' }));
      await repo.insert(input(domain, { model: 'm-b' }));
      const other = await repo.insert(input(`${domain}-other`, { model: 'm-a' }));

      const byDomain = await repo.list({ domain });
      assert.equal(byDomain.length, 2);
      assert.ok(byDomain.every((r) => r.domain === domain));
      assert.ok(!byDomain.some((r) => r.id === other.id));

      const byModel = await repo.list({ domain, model: 'm-b' });
      assert.equal(byModel.length, 1);
      assert.equal(byModel[0]?.model, 'm-b');

      const none = await repo.list({ domain, model: 'm-zzz' });
      assert.equal(none.length, 0);

      // 下界：0 / 负数 都夹到 1
      assert.equal((await repo.list({ domain, limit: 0 })).length, 1);
      assert.equal((await repo.list({ domain, limit: -5 })).length, 1);
      // 不传 limit：默认 50，足够放下这 2 行
      assert.equal((await repo.list({ domain })).length, 2);
    } finally {
      await repo.close();
    }
  });

  await t.test('list 按 created_at DESC 排序', async () => {
    domain = nextDomain();
    const repo = await open();
    try {
      const first = await repo.insert(input(domain, { model: 'sort-1' }));
      await sleep(5);
      const second = await repo.insert(input(domain, { model: 'sort-2' }));
      await sleep(5);
      const third = await repo.insert(input(domain, { model: 'sort-3' }));

      const rows = await repo.list({ domain });
      assert.deepEqual(
        rows.map((r) => r.id),
        [third.id, second.id, first.id],
      );
      const times = rows.map((r) => r.createdAt);
      assert.deepEqual([...times].sort().reverse(), times);
    } finally {
      await repo.close();
    }
  });

  await t.test('并发插入同一批不串行错绑（占位符映射）', async () => {
    domain = nextDomain();
    const repo = await open();
    try {
      const made = await Promise.all(
        ['c-1', 'c-2', 'c-3'].map((m) => repo.insert(input(domain, { model: m, formatScore: 90 }))),
      );
      assert.deepEqual(
        made.map((r) => r.model).sort(),
        ['c-1', 'c-2', 'c-3'],
      );
      for (const row of made) {
        assert.equal(row.formatScore, 90);
        assert.equal(row.domain, domain);
      }
    } finally {
      await repo.close();
    }
  });
}

test('repo 契约: sqlite', async (t) => {
  await runContract(t, 'sqlite', () => openRepo(':memory:'));
});

test(
  'repo 契约: pg',
  { skip: PG_URL ? false : 'LLMBM_PG_URL 未设置，跳过 PG 契约' },
  async (t) => {
    assert.ok(PG_URL);
    const cleanup = new pg.Pool({ connectionString: PG_URL });
    try {
      await runContract(t, 'pg', () => openRepo(':memory:', PG_URL));
    } finally {
      // 清理本次写入（按本测试固定的 domain 前缀）
      await cleanup.query('DELETE FROM results WHERE domain LIKE $1', [`${PREFIX}-%`]);
      await cleanup.end();
    }
  },
);
