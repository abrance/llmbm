/**
 * 单题打分（spec §2.3），纯函数、无 IO。
 * 规则顺序即优先级：传输失败 → 硬检查/core → 参数封顶 → 包装保底 → 阈值分级。
 */
import type { JudgeCheck, Question, QuestionScore, QuestionStatus, ScoreFlag } from '../types.js';

export interface ScoreOptions {
  /** 由 judge 判定出的修正信号；judge 也可以直接把权重/硬检查写进 checks。 */
  flags?: ScoreFlag[];
  /** 覆盖率低但答案包装规整时给保底分，默认由 detectWrapped 推断。 */
  wrapped?: boolean;
  /** 传输层错误（超时/429 重试耗尽/断流），有值直接 0。 */
  transportError?: string;
}

export const PASS_THRESHOLD = 90;
export const PENDING_THRESHOLD = 55;
export const PARAM_CAP = 50;
export const WRAPPED_FLOOR = 85;

/** 有 fenced code 块或整体是合法 JSON 对象/数组 → 视为「包装规整」。 */
export function detectWrapped(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/```[\s\S]*?```/.test(t)) return true;
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      JSON.parse(t);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function statusOf(score: number): QuestionStatus {
  if (score >= PASS_THRESHOLD) return 'pass';
  if (score >= PENDING_THRESHOLD) return 'pending_review';
  return 'fail';
}

function weightedTally(checks: readonly JudgeCheck[]): { passed: number; total: number } {
  let passed = 0;
  let total = 0;
  for (const c of checks) {
    const w = c.weight ?? 1;
    total += w;
    if (c.pass) passed += w;
  }
  return { passed, total };
}

/** 一道题的 N 次采样各自调用一次；返回该次采样的分数。 */
export function scoreQuestion(question: Question, checks: readonly JudgeCheck[], opts: ScoreOptions = {}): QuestionScore {
  const flags = new Set<ScoreFlag>(opts.flags ?? []);
  const { passed, total } = weightedTally(checks);
  const allPass = total > 0 && passed === total;
  const hardFailed = checks.some((c) => c.hard && !c.pass);
  const notes: string[] = [];

  let score: number;
  if (opts.transportError) {
    score = 0;
    flags.add('timeout');
    notes.push(`采样失败: ${opts.transportError}`);
  } else if (total === 0) {
    score = 0;
    flags.add('empty-response');
    notes.push('无检查项');
  } else {
    score = (passed / total) * 100;

    if (hardFailed || (question.core && !allPass)) {
      flags.add('core-failed');
      score = 0;
      notes.push(question.core ? '核心题未全对 → 0' : '硬检查失败 → 0');
    }

    const paramsWrong = flags.has('params-wrong');
    if (score > 0 && paramsWrong && score > PARAM_CAP) {
      score = PARAM_CAP;
      notes.push(`主体对但参数错 → 封顶 ${PARAM_CAP}`);
    }

    const wrapped = opts.wrapped ?? false;
    if (!paramsWrong && !allPass && score < WRAPPED_FLOOR && wrapped) {
      score = WRAPPED_FLOOR;
      flags.add('wrapped');
      notes.push(`答案包装规整但有瑕 → 保底 ${WRAPPED_FLOOR}`);
    }
  }

  score = Math.max(0, Math.min(100, score));
  if (flags.has('wrapped') || (score === WRAPPED_FLOOR && !allPass)) flags.add('wrapped');

  return {
    questionId: question.id,
    group: question.group,
    judge: question.judge,
    score,
    status: statusOf(score),
    checksPassed: passed,
    checksTotal: total,
    checks: [...checks],
    flags: [...flags].sort(),
    core: question.core === true,
    ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
  };
}
