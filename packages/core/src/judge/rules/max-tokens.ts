/**
 * max-tokens —— 请求里给了 max_tokens，端点是否真的按参数截断。
 * expect: { maxTokens: number, finishReason?: 'length' }
 *
 * 为什么单独一类：中转站最常见的作假之一是「忽略参数」—— 把 max_tokens 丢掉，
 * 甚至偷偷放大，用完整的长回答换取「看起来更能干」。这类作弊在纯内容判定里
 * 完全看不出来，只能看 finishReason 与用量。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, transportChecks, truncate } from './shared.js';

export interface MaxTokensExpect {
  maxTokens: number;
  /** 截断标记的字面值；不同协议叫 length / max_tokens。 */
  finishReason?: 'length';
}

/** 各协议表示「被截断」的 finishReason 取值。 */
export const TRUNCATION_FINISH_REASONS = ['length', 'max_tokens', 'max_output_tokens'];

function normalize(expect: unknown): MaxTokensExpect {
  if (!expect || typeof expect !== 'object') throw new Error('max-tokens judge 需要 expect 为 { maxTokens: number }');
  const e = expect as Partial<MaxTokensExpect>;
  if (typeof e.maxTokens !== 'number' || !Number.isFinite(e.maxTokens) || e.maxTokens <= 0) {
    throw new Error('max-tokens judge 的 expect.maxTokens 必须是正数');
  }
  if (e.finishReason !== undefined && e.finishReason !== 'length') {
    throw new Error("max-tokens judge 的 expect.finishReason 只支持 'length'");
  }
  return { maxTokens: e.maxTokens, ...(e.finishReason ? { finishReason: e.finishReason } : {}) };
}

export function judgeMaxTokens({ response, question }: JudgeContext): JudgeCheck[] {
  const exp = normalize(question.expect);
  const transport = transportChecks(response);
  // 传输失败时没有正文可判，也不该用长度兜底给第二次结论。
  if (transport.length > 0) return transport;
  const checks: JudgeCheck[] = [];

  const finish = (response.finishReason ?? '').toLowerCase();
  const truncated = TRUNCATION_FINISH_REASONS.includes(finish);
  checks.push({
    name: 'max-tokens.finish',
    pass: truncated,
    hard: true,
    ...(truncated
      ? { detail: `finishReason=${finish}` }
      : { detail: `未按 max_tokens=${exp.maxTokens} 截断，finishReason=${finish || '（缺失）'}；正文 ${truncate(response.text, 60)}` }),
  });

  const completion = response.usage?.completionTokens;
  if (completion !== undefined) {
    checks.push({
      name: 'max-tokens.usage',
      pass: completion <= exp.maxTokens,
      ...(completion <= exp.maxTokens
        ? { detail: `completion_tokens=${completion} ≤ ${exp.maxTokens}` }
        : { detail: `completion_tokens=${completion} 超过 max_tokens=${exp.maxTokens}，端点放大了上限` }),
    });
  }

  // 兜底：没 usage 时用长度上限拦「整段没截断」。中文约 1.5 字/token，取 6 倍已很宽松。
  const maxChars = exp.maxTokens * 6;
  const chars = response.text.trim().length;
  if (completion === undefined) {
    checks.push({
      name: 'max-tokens.length',
      pass: chars <= maxChars,
      ...(chars <= maxChars ? {} : { detail: `正文 ${chars} 字，远超 max_tokens=${exp.maxTokens} 的合理上限 ${maxChars} 字` }),
    });
  }

  const empty = emptyChecks(response);
  if (empty && !truncated) checks.push(...empty);
  return checks;
}
