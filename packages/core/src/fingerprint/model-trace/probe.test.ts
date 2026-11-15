import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Adapter, EndpointConfig, ModelResponse, PreparedRequest } from '../../types.js';
import type { ScoringBank } from './scoring.js';
import { loadModelTraceBank } from './loader.js';
import {
  buildProbeChallenges,
  minValidNumbers,
  analyzeProbeWithChallenges,
  runModelTraceProbe,
  type ProbeSend,
} from './probe.js';

/** 只实现 probe 用得到的 buildChatRequest，其余空实现。 */
const fakeAdapter = {
  protocol: 'openai',
  buildChatRequest: (req: unknown) => ({ url: 'http://fake.local', method: 'POST', headers: {}, body: JSON.stringify(req) }),
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
  assert.deepEqual(a.map((c) => c.expectedCount), b.map((c) => c.expectedCount));
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

test('有效整数不足门槛的样本不计入（如只写了 10 个数）', () => {
  const challenges = buildProbeChallenges(3, 0);
  const outputs = [ok(300), ok(300), { text: numberText(10) }];
  const res = analyzeProbeWithChallenges(challenges, outputs, bank, 5);
  assert.equal(res.used, 2);
  assert.equal(res.decision, 'partial');
  assert.equal(res.samples[2]!.accepted, false);
});
