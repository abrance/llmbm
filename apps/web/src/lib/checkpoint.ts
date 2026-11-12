/**
 * 断点续跑（F13）所需的纯逻辑：checkpoint 的读写与「已完成题集」计算。
 * 纯函数，无浏览器 API —— 存储适配层见 store.ts，便于单测与 Worker 复用（D1）。
 */

export interface Checkpoint {
  runId: string;
  /** 题库版本 + seed，决定这套题的身份；两者任一变化则 checkpoint 失效。 */
  questionBankVersion: string;
  seed: string;
  /** 已完成题目 id → 该题采样原始结果（JSON 可序列化）。 */
  done: Record<string, unknown>;
  updatedAt: string;
}

export function createCheckpoint(runId: string, questionBankVersion: string, seed: string): Checkpoint {
  return { runId, questionBankVersion, seed, done: {}, updatedAt: new Date().toISOString() };
}

/** checkpoint 是否可用于当前题库/seed；不匹配必须重新开始，避免混入旧结果。 */
export function isReusable(cp: Checkpoint | undefined, questionBankVersion: string, seed: string): boolean {
  if (!cp) return false;
  return cp.questionBankVersion === questionBankVersion && cp.seed === seed;
}

/** 待跑题目 = 全部题目 - 已完成。 */
export function pendingIds(allIds: readonly string[], cp: Checkpoint | undefined): string[] {
  if (!cp) return [...allIds];
  return allIds.filter((id) => !(id in cp.done));
}

/** 记录一题结果，返回新对象（不改入参，便于 React 状态比较）。 */
export function recordDone(cp: Checkpoint, questionId: string, result: unknown): Checkpoint {
  return { ...cp, done: { ...cp.done, [questionId]: result }, updatedAt: new Date().toISOString() };
}

export function completionRatio(cp: Checkpoint | undefined, allIds: readonly string[]): number {
  if (!cp || allIds.length === 0) return 0;
  const doneCount = allIds.filter((id) => id in cp.done).length;
  return doneCount / allIds.length;
}
