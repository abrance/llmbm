/**
 * 跑测短路守卫（F14）：按错误的「性质」决定停不停整卷。
 *
 * - account / config（401/402/403/404、欠费或订阅过期的响应体）：换题重试都不会恢复，
 *   第一次命中就停整卷，并把原因带回结果页让用户去处理。
 * - request（400/422 等「请求形状不被接受」）：只算这一题没答成，不终止整卷；计入
 *   被拒次数，压低稳定性，并在结果页说明。
 * - transient（超时/断网/5xx 重试耗尽）：偶发可容忍，只有连续命中达到阈值才判端点不可用
 *   —— 单次抖动不该让整卷作废。
 */
import { classifyFailure, failureAdvice, type FailureKind, type FailureInput } from '@llmbm/core';

/** 连续多少次采样拿不到可用响应才判端点不可用（≈ 2 题；单次抖动容忍）。 */
export const CONSECUTIVE_FAILURE_LIMIT = 5;

export interface ToleratedFailures {
  /** 被端点以「请求形状」类状态码拒绝的采样数。 */
  rejected: number;
  /** 出现过的拒绝状态码，去重升序。 */
  rejectedStatuses: number[];
  /** 最近一次拒绝的响应体片段，给用户看是哪类请求不被接受。 */
  lastRejected?: string;
  /** 瞬时失败后被重试消化的采样数（不进能力分，但不算题错）。 */
  transient: number;
}

export class FailureGuard {
  private consecutive = 0;
  private rejected = 0;
  private rejectedStatuses = new Set<number>();
  private lastRejected: string | undefined;
  private transient = 0;

  /** 返回短路原因；undefined 表示继续跑。 */
  note(response: FailureInput): string | undefined {
    if (response.error === undefined) {
      this.consecutive = 0;
      return undefined;
    }
    const kind: FailureKind = classifyFailure(response);
    const status = response.httpStatus;

    if (kind === 'account' || kind === 'config') {
      const head = status !== undefined ? `HTTP ${status}` : '端点错误';
      return `${head}：${truncate(response.error)}。${failureAdvice(kind)}`;
    }

    if (kind === 'request') {
      // 端点有响应、只是不接受这个请求：不算端点不可用，清零连续失败计数。
      this.rejected += 1;
      if (status !== undefined) this.rejectedStatuses.add(status);
      this.lastRejected = truncate(response.error);
      this.consecutive = 0;
      return undefined;
    }

    this.consecutive += 1;
    this.transient += 1;
    if (this.consecutive >= CONSECUTIVE_FAILURE_LIMIT) {
      return `连续 ${this.consecutive} 次采样没有拿到可用响应（超时/网络/5xx），端点已不可用：${truncate(response.error)}`;
    }
    return undefined;
  }

  tolerated(): ToleratedFailures {
    return {
      rejected: this.rejected,
      rejectedStatuses: [...this.rejectedStatuses].sort((a, b) => a - b),
      transient: this.transient,
      ...(this.lastRejected !== undefined ? { lastRejected: this.lastRejected } : {}),
    };
  }
}

/** 结果页/导出里给人看的可容忍问题说明；没有可说的就返回空数组。 */
export function toleratedNotices(t: ToleratedFailures, transport: { errors: number; samples: number }): string[] {
  const notices: string[] = [];
  if (t.rejected > 0) {
    const status = t.rejectedStatuses.length > 0 ? `HTTP ${t.rejectedStatuses.join('/')}` : '错误状态';
    notices.push(
      `${t.rejected} 次采样被端点以 ${status} 拒绝（请求形状不被接受）${t.lastRejected ? `：${t.lastRejected}` : ''}` +
        '。这类失败已从能力分剔除，只压低完成率与稳定性，不终止整卷。',
    );
  }
  if (transport.errors > t.rejected) {
    notices.push(
      `${transport.errors - t.rejected} 次采样是超时/网络/5xx 失败，已从能力分剔除并计入稳定性；偶发抖动不影响能力结论。`,
    );
  }
  return notices;
}

function truncate(text: string | undefined): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 240 ? `${t.slice(0, 240)}…` : t;
}
