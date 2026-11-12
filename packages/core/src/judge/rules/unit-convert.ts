/**
 * unit-convert —— 抽「数字+单位」，换算到目标单位后比较。
 * expect: { value: number, unit: string, tolerance?: number, sourceUnit?: string }
 * tolerance 缺省 0.01（按目标值的相对比例算）。
 * 只覆盖常见单位族（长度/时间/质量/温度/数据量/功率·能量）。
 * 答案单位与要求单位不同即判失败（ARCHITECTURE 契约：单位错 → 失败并记 unit），不做反向换算。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, transportChecks, truncate } from './shared.js';

export interface UnitConvertExpect {
  value: number;
  unit: string;
  tolerance?: number;
  sourceUnit?: string;
}

/** 单位别名 → 规范符号。中文、英文、大小写混写都归一到同一符号。 */
export const UNIT_ALIASES: Record<string, string> = {
  // 长度
  mm: 'mm', 毫米: 'mm',
  cm: 'cm', 厘米: 'cm',
  m: 'm', 米: 'm',
  km: 'km', 公里: 'km', 千米: 'km',
  // 时间
  ms: 'ms', 毫秒: 'ms',
  s: 's', 秒: 's',
  min: 'min', 分钟: 'min',
  h: 'h', hr: 'h', hour: 'h', 小时: 'h',
  // 质量
  mg: 'mg', 毫克: 'mg',
  g: 'g', 克: 'g',
  kg: 'kg', 千克: 'kg', 公斤: 'kg',
  t: 't', 吨: 't',
  // 数据量
  b: 'b', kb: 'kb', mb: 'mb', gb: 'gb', tb: 'tb',
  // 功率 / 能量
  w: 'w', kw: 'kw', mw: 'mw',
  wh: 'wh', kwh: 'kwh',
  // 温度
  c: 'c', '°c': 'c', celsius: 'c', 摄氏度: 'c',
  f: 'f', '°f': 'f', fahrenheit: 'f', 华氏度: 'f',
  k: 'k', kelvin: 'k', 开尔文: 'k',
};

/** 规范符号 → { 族, 相对该族基准单位的倍率 }（温度单独换算）。 */
export const UNITS: Record<string, { family: string; factor: number }> = {
  mm: { family: 'length', factor: 0.001 },
  cm: { family: 'length', factor: 0.01 },
  m: { family: 'length', factor: 1 },
  km: { family: 'length', factor: 1000 },
  ms: { family: 'time', factor: 0.001 },
  s: { family: 'time', factor: 1 },
  min: { family: 'time', factor: 60 },
  h: { family: 'time', factor: 3600 },
  mg: { family: 'mass', factor: 0.001 },
  g: { family: 'mass', factor: 1 },
  kg: { family: 'mass', factor: 1000 },
  t: { family: 'mass', factor: 1_000_000 },
  b: { family: 'data', factor: 1 },
  kb: { family: 'data', factor: 1024 },
  mb: { family: 'data', factor: 1024 ** 2 },
  gb: { family: 'data', factor: 1024 ** 3 },
  tb: { family: 'data', factor: 1024 ** 4 },
  w: { family: 'power', factor: 1 },
  kw: { family: 'power', factor: 1000 },
  mw: { family: 'power', factor: 1_000_000 },
  wh: { family: 'energy', factor: 1 },
  kwh: { family: 'energy', factor: 1000 },
  c: { family: 'temperature', factor: 1 },
  f: { family: 'temperature', factor: 1 },
  k: { family: 'temperature', factor: 1 },
};

/** 归一到规范符号；未收录的单位原样返回（小写、去空白），由调用方判失败。 */
export function canonicalUnit(u: string): string {
  const key = u.trim().toLowerCase().replace(/\s+/g, '');
  return UNIT_ALIASES[key] ?? key;
}

function normalize(expect: unknown): UnitConvertExpect {
  if (!expect || typeof expect !== 'object') throw new Error('unit-convert judge 需要 expect 为 { value, unit }');
  const e = expect as Partial<UnitConvertExpect>;
  if (typeof e.value !== 'number' || !Number.isFinite(e.value)) {
    throw new Error('unit-convert judge 的 expect.value 必须是有限数字');
  }
  if (typeof e.unit !== 'string' || e.unit.length === 0) {
    throw new Error('unit-convert judge 的 expect.unit 必须是非空字符串');
  }
  if (e.tolerance !== undefined && (typeof e.tolerance !== 'number' || e.tolerance < 0)) {
    throw new Error('unit-convert judge 的 expect.tolerance 必须是非负数字');
  }
  if (e.sourceUnit !== undefined && typeof e.sourceUnit !== 'string') {
    throw new Error('unit-convert judge 的 expect.sourceUnit 必须是字符串');
  }
  return {
    value: e.value,
    unit: e.unit,
    ...(e.tolerance !== undefined ? { tolerance: e.tolerance } : {}),
    ...(e.sourceUnit ? { sourceUnit: e.sourceUnit } : {}),
  };
}

interface Quantity {
  raw: string;
  value: number;
  unit: string;
}

/** 抽出正文里所有「数字 + 单位」对（按出现顺序）。 */
export function quantitiesIn(text: string): Quantity[] {
  const out: Quantity[] = [];
  const re = /(-?\d[\d,]*(?:\.\d+)?)\s*(°?[a-zA-Z]{1,5}|摄氏度|华氏度|开尔文|毫米|厘米|千米|公里|米|毫秒|分钟|小时|秒|千克|公斤|克|吨)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = Number((m[1] as string).replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    out.push({ raw: m[0], value, unit: canonicalUnit(m[2] as string) });
  }
  return out;
}

export function judgeUnitConvert({ response, question }: JudgeContext): JudgeCheck[] {
  const empty = emptyChecks(response);
  if (empty) return [...empty, ...transportChecks(response)];

  const exp = normalize(question.expect);
  const target = canonicalUnit(exp.unit);
  const quantities = quantitiesIn(response.text);

  if (quantities.length === 0) {
    return [
      { name: 'unit.found', pass: false, hard: true, detail: `正文里没有「数字+单位」；正文：${truncate(response.text)}` },
      ...transportChecks(response),
    ];
  }

  const checks: JudgeCheck[] = [{ name: 'unit.found', pass: true, detail: `识别到 ${quantities.map((q) => q.raw).join(', ')}` }];

  const withTargetUnit = quantities.find((q) => q.unit === target);
  const pick = withTargetUnit ?? (quantities[quantities.length - 1] as Quantity);

  const sourceUnit = exp.sourceUnit ? canonicalUnit(exp.sourceUnit) : undefined;
  if (sourceUnit && pick.unit === sourceUnit && sourceUnit !== target) {
    checks.push({
      name: 'unit.target',
      pass: false,
      detail: `仍以源单位「${pick.unit}」作答，未换算到「${target}」`,
    });
    return [...checks, ...transportChecks(response)];
  }

  if (pick.unit !== target) {
    checks.push({
      name: 'unit.target',
      pass: false,
      detail: `单位不符：期望「${target}」，实际「${pick.unit}」（原文「${pick.raw}」）`,
    });
    return [...checks, ...transportChecks(response)];
  }

  checks.push({ name: 'unit.target', pass: true });

  const converted = pick.value;
  const tol = Math.abs(exp.value) * (exp.tolerance ?? 0.01);
  const pass = Math.abs(converted - exp.value) <= Math.max(tol, 1e-9);
  checks.push({
    name: 'unit.value',
    pass,
    ...(pass ? {} : { detail: `期望 ${exp.value} ${target}，实际 ${converted} ${target}（原文「${pick.raw}」）` }),
  });

  return [...checks, ...transportChecks(response)];
}
