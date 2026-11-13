/**
 * 跑测短路守卫（F14）：把「同一错误刷满整卷」的跑测提前停掉。
 *
 * 三类信号：
 * - 端点级致命状态（401/402/403/404）：鉴权错、额度耗尽、模型名不存在。换题也不会
 *   变好，第一次命中就停。
 * - 连续同类型 4xx（重试无意义的客户端错误，如 400/422）：单题可能是请求形状问题，
 *   连续命中说明整个请求被端点系统性拒绝，继续跑也只是白耗额度。
 * - 连续传输失败（超时/断网/5xx 重试耗尽）：单次失败只是瞬时问题，连续命中说明端点
 *   已经不可用。
 */
import { isFatalStatus, isRetryable } from '@llmbm/core/adapters';

/** 连续多少次采样命中同一类失败视为端点不可用。默认 3 ≈ 一整题（N=3）。 */
export const CONSECUTIVE_FAILURE_LIMIT = 3;

export interface FailureSignal {
  httpStatus?: number;
  error?: string;
}

export class FailureGuard {
  private consecutive = 0;
  private consecutiveClientError = 0;

  note(response: FailureSignal): string | undefined {
    if (response.error === undefined) {
      this.consecutive = 0;
      this.consecutiveClientError = 0;
      return undefined;
    }
    const status = response.httpStatus;
    if (status !== undefined && isFatalStatus(status)) {
      return `端点返回 HTTP ${status}（鉴权/额度/模型名错误），换题重试不会恢复：${response.error}`;
    }

    this.consecutive += 1;
    if (status !== undefined && status >= 400 && status < 500 && !isRetryable(status)) {
      this.consecutiveClientError += 1;
      if (this.consecutiveClientError >= CONSECUTIVE_FAILURE_LIMIT) {
        return `连续 ${this.consecutiveClientError} 次被端点以 HTTP ${status} 拒绝，请求本身不被接受：${response.error}`;
      }
    } else {
      this.consecutiveClientError = 0;
    }

    if (this.consecutive >= CONSECUTIVE_FAILURE_LIMIT) {
      return `连续 ${this.consecutive} 次采样传输失败，端点已不可用：${response.error}`;
    }
    return undefined;
  }
}
