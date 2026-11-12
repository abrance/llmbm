import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeUnitConvert, quantitiesIn } from './unit-convert.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, expect: unknown, error?: string): JudgeContext => ({
  question: { id: 't', group: 'basic', prompt: 'p', judge: 'unit-convert', expect } as Question,
  response: { text, ...(error ? { error } : {}) },
});

test('正例：km → m', () => {
  const checks = judgeUnitConvert(ctx('1000 m', { value: 1000, unit: 'm', sourceUnit: 'km' }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：h → min', () => {
  const checks = judgeUnitConvert(ctx('150 分钟', { value: 150, unit: 'min', sourceUnit: 'h' }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：温度题按目标单位作答', () => {
  const checks = judgeUnitConvert(ctx('212 °F', { value: 212, unit: 'f', sourceUnit: 'c' }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：正文有多个量时优先取目标单位的那个', () => {
  const checks = judgeUnitConvert(ctx('1 km = 1000 m', { value: 1000, unit: 'm' }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— 数值算错', () => {
  const checks = judgeUnitConvert(ctx('100 m', { value: 1000, unit: 'm', sourceUnit: 'km' }));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.name, 'unit.value');
});

test('反例：内容缺项 —— 单位没换算', () => {
  const checks = judgeUnitConvert(ctx('1 km', { value: 1000, unit: 'm', sourceUnit: 'km' }));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.name, 'unit.target');
});

test('反例：内容缺项 —— 正文没有数字+单位', () => {
  const checks = judgeUnitConvert(ctx('一公里是一千米', { value: 1000, unit: 'm' }));
  assert.ok(checks.some((c) => c.name === 'unit.found' && c.hard));
});

test('反例：空响应 → empty 硬失败', () => {
  const checks = judgeUnitConvert(ctx('  ', { value: 1, unit: 'm' }));
  assert.ok(checks.some((c) => c.name === 'empty' && c.hard));
});

test('反例：expect 非法抛错', () => {
  assert.throws(() => judgeUnitConvert(ctx('1 m', { unit: 'm' })), /value/);
  assert.throws(() => judgeUnitConvert(ctx('1 m', { value: 1 })), /unit/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgeUnitConvert(ctx('1000 m', { value: 1000, unit: 'm' }, 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});

test('quantitiesIn：识别中文单位与 °C，并归一到规范符号', () => {
  const qs = quantitiesIn('温度 25 °C，距离 3 公里');
  assert.equal(qs.length, 2);
  assert.equal(qs[0]?.unit, 'c');
  assert.equal(qs[1]?.unit, 'km');
});
