import { test } from 'node:test';
import assert from 'node:assert/strict';
import { degradationOf, repeatRatioOf, fingerprintOf, featuresOf, isRefusalSample, runSignalsOf } from './index.js';
import type { ModelResponse } from '../types.js';

const resp = (over: Partial<ModelResponse> = {}): ModelResponse => ({ text: 'abc', ...over });

test('F10 重复行占比：全不重复 0，全重复接近 1', () => {
  assert.equal(repeatRatioOf('a\nb\nc'), 0);
  const loopy = 'a\na\na\na\na\nb';
  assert.ok(repeatRatioOf(loopy) > 0.6); // 6 行去重 2 行 → 0.667
  assert.equal(repeatRatioOf(''), 0);
});

test('F10 复读尾巴：末尾 5 行里 3 行相同才算', () => {
  const sig = degradationOf('开头\nx\nx\nx\nx\nx');
  assert.equal(sig.tailLoop, true);
  assert.equal(degradationOf('a\nb\nc\nd\ne').tailLoop, false);
});

test('F10 长度萎缩：与同题 peer 相比掉一半以上记为 1.0 上限', () => {
  const sig = degradationOf('短', ['一二三四五六七八九十', '一二三四五六七八九十']);
  assert.ok(sig.lengthCollapse > 0.8);
  assert.ok(sig.confidence > 0);
  assert.equal(sig.weak, true);
});

test('F10 无 peer 时不给长度结论，confidence 打折', () => {
  const sig = degradationOf('短');
  assert.equal(sig.lengthCollapse, 0);
  assert.ok(sig.basis.some((b) => b.includes('无其他采样可比')));
});

test('F10 干净响应：confidence 0 且仍带 weak/caveat', () => {
  const sig = degradationOf('第一行\n第二行\n第三行\n第四行');
  assert.equal(sig.confidence, 0);
  assert.equal(sig.weak, true);
  assert.ok(sig.caveat.includes('弱信号'));
});

test('F9 无基线 → verdict 只能是 insufficient-data，不猜', () => {
  const fp = fingerprintOf({ responses: [resp(), resp()] });
  assert.equal(fp.verdict, 'insufficient-data');
  assert.equal(fp.weak, true);
  assert.deepEqual(fp.deviations, []);
});

test('F9 空输入 → insufficient-data 且 confidence 0', () => {
  const fp = fingerprintOf({ responses: [] });
  assert.equal(fp.verdict, 'insufficient-data');
  assert.equal(fp.confidence, 0);
});

test('F9 有基线且特征稳定 → no-anomaly', () => {
  const responses = [resp({ text: 'a'.repeat(100) }), resp({ text: 'b'.repeat(100) })];
  const base = featuresOf({ responses });
  const fp = fingerprintOf({ responses, baseline: base });
  assert.equal(fp.verdict, 'no-anomaly');
  assert.ok(fp.confidence <= 0.6);
});

test('F9 正文长度腰斩 + 工具调用消失 → suspect-degraded，并列出偏离项', () => {
  const base = featuresOf({ responses: [resp({ text: 'a'.repeat(200), toolCalls: [{ id: 'c1', name: 'f' }] })] });
  const now = [resp({ text: 'a'.repeat(20) }), resp({ text: 'b'.repeat(20) })];
  const fp = fingerprintOf({ responses: now, baseline: base });
  assert.equal(fp.verdict, 'suspect-degraded');
  assert.ok(fp.deviations.length >= 1);
  assert.ok(fp.confidence <= 0.6);
  assert.equal(fp.features.reasoningShare, 0);
});

test('F9 特征：reasoning / 工具调用 / 拒答占比都是占比而非计数', () => {
  const f = featuresOf({
    responses: [resp({ text: 'x', reasoning: '想' }), resp({ text: 'y' }), resp({ text: 'z', toolCalls: [{ id: 'c', name: 'f' }] })],
    refusals: 1,
  });
  assert.equal(f.reasoningShare, 0.333);
  assert.equal(f.toolCallRate, 0.333);
  assert.equal(f.refusalRate, 0.333);
  assert.equal(f.samples, 3);
});

/* --------------------------------------------------- 一次跑测的整体弱信号（F9+F10 契约） */

test('F9/F10 runSignalsOf：无基线 → fingerprint 只能 insufficient-data，退化照报', () => {
  const r = runSignalsOf({
    samplesByQuestion: [
      [{ response: resp({ text: 'a'.repeat(100) }) }, { response: resp({ text: 'b'.repeat(100) }) }],
      [{ response: resp({ text: 'loopy\nloopy\nloopy\nloopy\nc' }) }],
    ],
  });
  assert.equal(r.fingerprint.verdict, 'insufficient-data');
  assert.equal(r.fingerprint.features.samples, 3);
  assert.equal(r.fingerprint.deviations.length, 0);
  assert.equal(r.degradation.samples, 3);
  assert.equal(r.degradation.flagged, 1);
  assert.ok(r.degradation.caveat.includes('弱信号'));
  assert.equal(r.degradation.weak, true);
});

test('F9/F10 runSignalsOf：有基线且偏离 → suspect-degraded 并列出偏离项', () => {
  const baseResponses = [resp({ text: 'a'.repeat(200), toolCalls: [{ id: 'c1', name: 'f' }] })];
  const baseline = featuresOf({ responses: baseResponses });
  const r = runSignalsOf({
    samplesByQuestion: [[{ response: resp({ text: '短' }) }, { response: resp({ text: '也很短' }) }]],
    baseline,
  });
  assert.equal(r.fingerprint.verdict, 'suspect-degraded');
  assert.ok(r.fingerprint.deviations.length >= 1);
  assert.ok(r.fingerprint.confidence <= 0.6);
});

test('F9 拒答率只认 refusal judge 的检查，不从正文猜', () => {
  assert.equal(isRefusalSample([{ name: 'refusal.marker', pass: true }]), true);
  assert.equal(isRefusalSample([{ name: 'refusal.no-false-refusal', pass: false }]), true);
  assert.equal(isRefusalSample([{ name: 'refusal.marker', pass: false }]), false);
  assert.equal(isRefusalSample([{ name: 'contains', pass: true }]), false);

  const r = runSignalsOf({
    samplesByQuestion: [
      [{ response: resp(), checks: [{ name: 'refusal.marker', pass: true }] }, { response: resp(), checks: [] }],
    ],
  });
  assert.equal(r.fingerprint.features.refusalRate, 0.5);
});

test('F10 退化汇总：无采样时不猜，flagged 0', () => {
  const r = runSignalsOf({ samplesByQuestion: [] });
  assert.equal(r.degradation.samples, 0);
  assert.equal(r.degradation.flagged, 0);
  assert.equal(r.degradation.confidence, 0);
  assert.equal(r.fingerprint.verdict, 'insufficient-data');
});
