/**
 * SSE 归一化事件的聚合层。
 *
 * 为什么单独一层：`Adapter.parseSseLine` 是纯函数、逐行解析、不带状态，
 * 而 tool_calls 的 arguments 是跨帧拼接的、finishReason 是「到没到」的判定。
 * 这两件事都需要状态，放在这里，三家 adapter 共用一份实现（D1）。
 */
import type { ModelResponse, StreamEvent, ToolCall, Usage } from '../types.js';

interface PendingToolCall {
  id?: string;
  name?: string;
  args: string;
}

/** 分片 usage 合并：缺的字段补上，totalTokens 在有 prompt/completion 时重算。 */
function mergeUsage(prev: Usage | undefined, next: Usage): Usage {
  const merged: Usage = { ...prev };
  if (next.promptTokens !== undefined) merged.promptTokens = next.promptTokens;
  if (next.completionTokens !== undefined) merged.completionTokens = next.completionTokens;
  if (next.totalTokens !== undefined) {
    merged.totalTokens = next.totalTokens;
  } else if (merged.promptTokens !== undefined || merged.completionTokens !== undefined) {
    merged.totalTokens = (merged.promptTokens ?? 0) + (merged.completionTokens ?? 0);
  }
  return merged;
}

export interface StreamAccumulator {
  /** 吃一批归一化事件。 */
  push(events: StreamEvent[]): void;
  /** 当前聚合结果。`finishReason === undefined` 表示没收到完成标记（HTTP 200 断流）。 */
  result(httpStatus?: number): ModelResponse;
  /** 是否已收到完成标记。 */
  finished(): boolean;
}

export function createStreamAccumulator(): StreamAccumulator {
  const text: string[] = [];
  const reasoning: string[] = [];
  const toolCalls = new Map<number, PendingToolCall>();
  const errors: string[] = [];
  let finishReason: string | undefined;
  let usage: ModelResponse['usage'];
  let lastEvent: StreamEvent | undefined;

  return {
    push(events) {
      for (const ev of events) {
        lastEvent = ev;
        switch (ev.type) {
          case 'text':
            text.push(ev.delta);
            break;
          case 'reasoning':
            reasoning.push(ev.delta);
            break;
          case 'tool-call': {
            const cur = toolCalls.get(ev.index) ?? { args: '' };
            if (ev.id !== undefined) cur.id = ev.id;
            if (ev.name !== undefined) cur.name = ev.name;
            if (ev.argumentsDelta !== undefined) cur.args += ev.argumentsDelta;
            toolCalls.set(ev.index, cur);
            break;
          }
          case 'usage':
            // 流式 usage 常分片到达（anthropic: message_start 给 input_tokens，
            // message_delta 给 output_tokens），必须合并而不是覆盖。
            usage = mergeUsage(usage, ev.usage);
            break;
          case 'done':
            // 只有真的带 finishReason 才算「正常结束」；[DONE] / message_stop 不算。
            if (ev.finishReason !== undefined) finishReason = ev.finishReason;
            break;
          case 'error':
            errors.push(ev.error);
            break;
        }
      }
    },

    finished() {
      return finishReason !== undefined;
    },

    result(httpStatus) {
      const calls: ToolCall[] = [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => {
          const call: ToolCall = { name: c.name ?? '' };
          if (c.id !== undefined) call.id = c.id;
          if (c.args) {
            call.rawArguments = c.args;
            try {
              call.args = JSON.parse(c.args);
            } catch {
              // 解析失败保留原文，不抛错（参数半截是常见现象）
            }
          }
          return call;
        });

      const out: ModelResponse = { text: text.join('') };
      const reasoningText = reasoning.join('');
      if (reasoningText) out.reasoning = reasoningText;
      if (calls.length) out.toolCalls = calls;
      if (finishReason !== undefined) out.finishReason = finishReason;
      if (usage) out.usage = usage;
      if (errors.length) out.error = errors.join('; ');
      if (httpStatus !== undefined) out.httpStatus = httpStatus;
      if (lastEvent) out.raw = lastEvent;
      return out;
    },
  };
}

/** 便捷入口：逐行喂给某个 adapter 的 parseSseLine，返回聚合结果。 */
export function accumulateSse(
  lines: Iterable<string>,
  parseLine: (line: string) => StreamEvent[],
  httpStatus?: number,
): ModelResponse {
  const acc = createStreamAccumulator();
  for (const line of lines) acc.push(parseLine(line));
  return acc.result(httpStatus);
}
