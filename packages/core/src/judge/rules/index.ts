/**
 * 规则注册表入口。每个 kind 一个文件，只在这里登记（D2：禁止大 if-else）。
 * 归属：本文件与 rules/** 由 pit 维护；registry.ts 与 judge/index.ts 由 mike 维护。
 */
import type { JudgeRegistry } from '../registry.js';
import { judgeCite } from './cite.js';
import { judgeConflict } from './conflict.js';
import { judgeContains } from './contains.js';
import { judgeExact } from './exact.js';
import { judgeFormatJson } from './format-json.js';
import { judgeFraction } from './fraction.js';
import { judgeFunctionCall } from './function-call.js';
import { judgeJson } from './json.js';
import { judgeJsonSchema } from './json-schema.js';
import { judgeLongOutput } from './long-output.js';
import { judgeMaxTokens } from './max-tokens.js';
import { judgeNotContains } from './not-contains.js';
import { judgeNumber } from './number.js';
import { judgeOrdering } from './ordering.js';
import { judgePelicanSvg } from './pelican-svg.js';
import { judgeRefusal } from './refusal.js';
import { judgeRegex } from './regex.js';
import { judgeSet } from './set.js';
import { judgeToolArgs } from './tool-args.js';
import { judgeUnitConvert } from './unit-convert.js';

export function registerRules(registry: JudgeRegistry): void {
  registry.register('exact', judgeExact);
  registry.register('contains', judgeContains);
  registry.register('not-contains', judgeNotContains);
  registry.register('regex', judgeRegex);
  registry.register('set', judgeSet);
  registry.register('json', judgeJson);
  registry.register('json-schema', judgeJsonSchema);
  registry.register('number', judgeNumber);
  registry.register('fraction', judgeFraction);
  registry.register('conflict', judgeConflict);
  registry.register('ordering', judgeOrdering);
  registry.register('function-call', judgeFunctionCall);
  registry.register('tool-args', judgeToolArgs);
  registry.register('pelican-svg', judgePelicanSvg);
  registry.register('long-output', judgeLongOutput);
  registry.register('refusal', judgeRefusal);
  registry.register('format-json', judgeFormatJson);
  registry.register('unit-convert', judgeUnitConvert);
  registry.register('cite', judgeCite);
  registry.register('max-tokens', judgeMaxTokens);
}
