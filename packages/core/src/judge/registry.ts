/**
 * judge registry（D1/D2）：19 类判定各自的纯函数实现，按 kind 注册，禁止大 if-else。
 * 每个规则文件只做一件事：export 一个 (ctx) => JudgeCheck[]。
 */
import type { JudgeCheck, JudgeFn, JudgeKind, Question } from '../types.js';

export interface JudgeRegistry {
  register(kind: JudgeKind, fn: JudgeFn): void;
  get(kind: JudgeKind): JudgeFn | undefined;
  has(kind: JudgeKind): boolean;
  kinds(): JudgeKind[];
  /** 已注册但无实现的 kind，用于启动自检。 */
  missing(expected: readonly JudgeKind[]): JudgeKind[];
}

/**
 * 规则版本（D6）：任何 judge 判定行为变化都要 bump，结果里回写，
 * 保证「同一份题库 + 同一版本规则」可复现同一分数。
 */
export const JUDGE_RULE_VERSION = 'judge-rules@0.1.3';

export function createRegistry(): JudgeRegistry {
  const rules = new Map<JudgeKind, JudgeFn>();
  return {
    register(kind, fn) {
      if (rules.has(kind)) throw new Error(`judge "${kind}" 已注册，禁止重复实现（D1：判分只允许一份实现）`);
      rules.set(kind, fn);
    },
    get: (kind) => rules.get(kind),
    has: (kind) => rules.has(kind),
    kinds: () => [...rules.keys()].sort(),
    missing: (expected) => expected.filter((k) => !rules.has(k)),
  };
}

/** 执行一次判定并兜住异常：judge 抛错不能把整场测跑挂掉。 */
export function runJudge(registry: JudgeRegistry, question: Question, ctx: Parameters<JudgeFn>[0]): JudgeCheck[] {
  const fn = registry.get(question.judge);
  if (!fn) {
    return [{ name: 'registry', pass: false, hard: true, detail: `未知 judge: ${question.judge}` }];
  }
  try {
    const checks = fn(ctx);
    return checks.length > 0 ? checks : [{ name: 'judge.empty', pass: false, hard: true, detail: `${question.judge} 未产出任何检查项` }];
  } catch (err) {
    return [
      {
        name: 'judge.error',
        pass: false,
        hard: true,
        detail: `${question.judge} 执行异常: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }
}
