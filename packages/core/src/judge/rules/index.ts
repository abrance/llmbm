/**
 * 规则注册表入口。每个 kind 一个文件，只在这里登记（D2：禁止大 if-else）。
 * 归属：本文件与 rules/** 由 pit 维护；registry.ts 与 judge/index.ts 由 mike 维护。
 */
import type { JudgeRegistry } from '../registry.js';
import { judgeExact } from './exact.js';

export function registerRules(registry: JudgeRegistry): void {
  registry.register('exact', judgeExact);
}
