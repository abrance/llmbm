import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Adapter, EndpointConfig, ModelResponse, PreparedRequest } from '../../types.js';
import { openaiAdapter } from '../../adapters/index.js';
import type { ScoringBank } from './scoring.js';
import { loadModelTraceBank } from './loader.js';
import {
  buildProbeChallenges,
  minValidNumbers,
  analyzeProbeWithChallenges,
  runModelTraceProbe,
  PROBE_MAX_TOKENS,
  PROBE_TIMEOUT_MS,
  type ProbeSend,
} from './probe.js';

/** 上游 2c61f8f `shared/challenge-browser.js` 的 LANGUAGES.zh.openings，钉住文案不漂。 */
const UPSTREAM_OPENINGS = [
  '这是一次独立的数值选择记录。',
  '请完成下面的无语义整数选择任务。',
  '执行一次第一反应取值记录。',
  '生成一组不承载语义的整数选择。',
  '进行一轮快速逐项取值。',
];

/** 只实现 probe 用得到的 buildChatRequest，其余空实现。 */
const fakeAdapter = {
  protocol: 'openai',
  buildChatRequest: (req: unknown) => ({
    url: 'http://fake.local',
    method: 'POST',
    headers: {},
    body: JSON.stringify(req),
  }),
  parseSseLine: () => [],
  parseChatResponse: () => ({ text: '' }),
  parseModelsResponse: () => [],
} as unknown as Adapter;

const cfg: EndpointConfig = { baseUrl: 'http://fake.local', apiKey: 'k', model: 'm' };

function numberText(length: number, seed = 424242): string {
  let state = seed;
  const nums = Array.from({ length }, () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return 1 + (state % 355);
  });
  return nums.join(', ');
}

const ok = (length: number): ModelResponse => ({ text: numberText(length) });
const failed = (error: string): ModelResponse => ({ text: '', error });

let bank: ScoringBank;
test.before(async () => {
  bank = await loadModelTraceBank();
});

test('门槛口径：max(80, ceil(expected*0.55))', () => {
  assert.equal(minValidNumbers(100), 80); // 55 → 抬到 80
  assert.equal(minValidNumbers(292), Math.ceil(292 * 0.55));
  assert.equal(minValidNumbers(300), 165);
});

test('buildProbeChallenges：三条、长度在 [292,332] 内互不相同、同 seed 可复现', () => {
  const a = buildProbeChallenges(3, 0);
  const b = buildProbeChallenges(3, 0);
  assert.equal(a.length, 3);
  const lengths = a.map((c) => c.expectedCount);
  assert.equal(new Set(lengths).size, 3);
  assert.ok(lengths.every((n) => n >= 292 && n <= 332));
  assert.deepEqual(
    a.map((c) => c.expectedCount),
    b.map((c) => c.expectedCount),
  );
  assert.deepEqual(
    a.map((c) => c.prompt),
    b.map((c) => c.prompt),
  );
});

test('探针文案只取一个 opening（上游拼两个不是上游口径），且句段齐备', () => {
  const challenges = buildProbeChallenges(3, 0);
  for (const challenge of challenges) {
    const hits = UPSTREAM_OPENINGS.filter((opening) => challenge.prompt.includes(opening));
    assert.equal(hits.length, 1, `应当只含一个 opening，实际 ${hits.length}：${challenge.prompt.slice(0, 40)}`);
    assert.ok(challenge.prompt.startsWith(hits[0]!), 'opening 必须在最前');
    assert.match(challenge.prompt, new RegExp(`${challenge.expectedCount} 个 1 到 355（含端点）的整数`));
    assert.match(challenge.prompt, /禁止调用或借助任何工具/, '缺 rules');
    assert.match(challenge.prompt, /直接从第一个取值开始输出/, '缺 start');
    assert.equal(challenge.prompt.match(/直接从第一个取值开始输出/g)?.length, 1);
  }
});

test('探针请求对齐上游 2c61f8f：不发 temperature、max_tokens=8192、单条独立 250000ms', async () => {
  const bodies: Record<string, unknown>[] = [];
  const timeouts: number[] = [];
  const send: ProbeSend = async (prepared, _adapter, _signal, options) => {
    bodies.push(JSON.parse(String(prepared.body)) as Record<string, unknown>);
    timeouts.push(options.timeoutMs);
    return ok(300);
  };
  // 用真实 adapter 构造请求体，才能断言「真的没发 temperature、max_tokens 真的是 8192」
  await runModelTraceProbe({ cfg, adapter: openaiAdapter, send, bank, signal: new AbortController().signal });
  assert.equal(PROBE_MAX_TOKENS, 8192);
  assert.equal(PROBE_TIMEOUT_MS, 250000);
  assert.equal(bodies.length, 3);
  for (const body of bodies) {
    assert.equal(Object.hasOwn(body, 'temperature'), false, '探针不发 temperature');
    assert.equal(body.max_tokens, 8192);
    assert.equal((body.messages as unknown[]).length, 1, '单条 user 消息');
  }
  assert.deepEqual(timeouts, [250000, 250000, 250000], '每条探针各自的 250s 超时');
});

test('timeoutMs 可覆盖（如测试/短超时），其余参数不变', async () => {
  const timeouts: number[] = [];
  const send: ProbeSend = async (_prepared, _adapter, _signal, options) => {
    timeouts.push(options.timeoutMs);
    return ok(300);
  };
  await runModelTraceProbe({
    cfg,
    adapter: fakeAdapter,
    send,
    bank,
    signal: new AbortController().signal,
    timeoutMs: 1000,
  });
  assert.deepEqual(timeouts, [1000, 1000, 1000]);
});

test('三条有效回答 → ranked，带弱信号外壳与前若干候选，永不进能力分（纯附加结论）', async () => {
  const challenges = buildProbeChallenges(3, 0);
  const outputs = challenges.map((c) => ok(c.expectedCount));
  const res = analyzeProbeWithChallenges(challenges, outputs, bank, 5);
  assert.equal(res.decision, 'ranked');
  assert.equal(res.used, 3);
  assert.equal(res.weak, true);
  assert.ok(res.caveat.length > 0);
  assert.ok(res.ranking.length > 0 && res.ranking.length <= 5);
  assert.ok(res.top);
  assert.equal(res.top, res.ranking[0]);
});

test('概率：和为 1、随分数单调、与 softmax(β×分) 逐位一致（闭集）', () => {
  const challenges = buildProbeChallenges(3, 0);
  const res = analyzeProbeWithChallenges(
    challenges,
    challenges.map((c) => ok(c.expectedCount)),
    bank,
    100,
  );
  assert.equal(res.decision, 'ranked');
  assert.equal(res.probabilityStatus, 'reference-calibrated');
  assert.equal(res.probabilityScope, 'reference-closed-set');
  const probs = res.ranking.map((rank) => rank.probability!);
  assert.ok(probs.every((p) => typeof p === 'number' && p > 0 && p <= 1));
  const sum = probs.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12, `概率和为 ${sum}`);
  // 逐位对齐 softmax(β × 均值分)，β 取 bank.calibration[min(条数,3)].beta
  const beta = bank.calibration['3']!.beta;
  const scaled = res.ranking.map((rank) => beta * rank.score);
  const max = Math.max(...scaled);
  const exps = scaled.map((value) => Math.exp(value - max));
  const denom = exps.reduce((a, b) => a + b, 0);
  assert.deepEqual(
    probs,
    exps.map((value) => value / denom),
  );
  // 排序分降序 → 概率必须单调不增
  for (let i = 1; i < probs.length; i += 1) assert.ok(probs[i]! <= probs[i - 1]!);
});

test('探针失败不中断：一条抛错、两条成功 → 不抛异常，记 partial 并保留失败原因', async () => {
  let call = 0;
  const send: ProbeSend = async (_p: PreparedRequest): Promise<ModelResponse> => {
    call += 1;
    if (call === 1) throw new Error('请求超时');
    return ok(300);
  };
  const res = await runModelTraceProbe({ cfg, adapter: fakeAdapter, send, bank, signal: new AbortController().signal });
  assert.equal(res.decision, 'partial');
  assert.equal(res.used, 2);
  assert.equal(res.samples[0]!.accepted, false);
  assert.match(res.samples[0]!.error ?? '', /超时/);
});

test('全部失败 → insufficient，不抛异常，ranking 为空', async () => {
  const send: ProbeSend = async () => failed('断流');
  const res = await runModelTraceProbe({ cfg, adapter: fakeAdapter, send, bank, signal: new AbortController().signal });
  assert.equal(res.decision, 'insufficient');
  assert.equal(res.used, 0);
  assert.deepEqual(res.ranking, []);
});

test('ranked 给闭集概率：top.probability ∈ (0,1]，概率随分数单调、scope 正确', async () => {
  const challenges = buildProbeChallenges(3, 0);
  const outputs = challenges.map((c) => ok(c.expectedCount));
  const res = analyzeProbeWithChallenges(challenges, outputs, bank, 5);
  assert.equal(res.decision, 'ranked');
  assert.equal(res.probabilityStatus, 'reference-calibrated');
  assert.equal(res.probabilityScope, 'reference-closed-set');
  assert.equal(typeof res.probability, 'number');
  assert.ok(res.probability! > 0 && res.probability! <= 1);
  assert.equal(res.top?.probability, res.probability);
  const probs = res.ranking.map((r) => r.probability!);
  assert.ok(probs.every((p) => typeof p === 'number' && p > 0 && p <= 1));
  // softmax(β×score) 与 score 同序：概率必须单调不增
  for (let i = 1; i < probs.length; i += 1) assert.ok(probs[i]! <= probs[i - 1]!);
});

test('partial（有效样本不足三条）→ 不给概率，只给排名', () => {
  const challenges = buildProbeChallenges(3, 0);
  const outputs = [ok(300), ok(300), { text: numberText(10) }];
  const res = analyzeProbeWithChallenges(challenges, outputs, bank, 5);
  assert.equal(res.decision, 'partial');
  assert.equal(res.probability, null);
  assert.equal(res.probabilityStatus, 'unavailable');
  assert.equal(res.probabilityScope, null);
  assert.ok(res.ranking.every((r) => r.probability === null));
});

test('探针结果是独立结论：不含 judge/能力分字段，也不改变任何分数', () => {
  const challenges = buildProbeChallenges(3, 0);
  const res = analyzeProbeWithChallenges(
    challenges,
    challenges.map((c) => ok(c.expectedCount)),
    bank,
    5,
  );
  for (const key of ['score', 'checks', 'status', 'dimensions', 'total', 'transportError']) {
    assert.equal(Object.prototype.hasOwnProperty.call(res, key), false, `探针结果不应含 ${key}`);
  }
  assert.equal(res.weak, true);
});

test('有效整数不足门槛的样本不计入（如只写了 10 个数）', () => {
  const challenges = buildProbeChallenges(3, 0);
  const outputs = [ok(300), ok(300), { text: numberText(10) }];
  const res = analyzeProbeWithChallenges(challenges, outputs, bank, 5);
  assert.equal(res.used, 2);
  assert.equal(res.decision, 'partial');
  assert.equal(res.samples[2]!.accepted, false);
});
