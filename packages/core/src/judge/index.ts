/**
 * judge 公共入口：构造一个注册了全部规则的 registry 并执行判定。
 * 浏览器端与 Node 端共用这一份（D1）。
 */
import { JUDGE_KINDS, type JudgeCheck, type JudgeKind, type Question } from '../types.js';
import { createRegistry, JUDGE_RULE_VERSION, runJudge, type JudgeRegistry } from './registry.js';
import { registerRules } from './rules/index.js';

export { createRegistry, JUDGE_RULE_VERSION, runJudge };
export type { JudgeRegistry };

let singleton: JudgeRegistry | undefined;

/** 默认 registry（全量规则），首次调用时构建。 */
export function defaultRegistry(): JudgeRegistry {
  singleton ??= buildRegistry();
  return singleton;
}

export function buildRegistry(): JudgeRegistry {
  const registry = createRegistry();
  registerRules(registry);
  return registry;
}

/** 启动自检：返回尚未实现的 kind；空数组表示 JUDGE_KINDS 全部齐备。 */
export function missingJudges(registry: JudgeRegistry = defaultRegistry()): JudgeKind[] {
  return registry.missing(JUDGE_KINDS);
}

export function judge(question: Question, response: Parameters<typeof runJudge>[2]['response'], sampleIndex = 0, registry: JudgeRegistry = defaultRegistry()): JudgeCheck[] {
  return runJudge(registry, question, { question, response, sampleIndex });
}
