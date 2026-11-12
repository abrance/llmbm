/** 三家 adapter 共用的测试脚手架：逐行喂帧，断言事件序列与聚合结果。 */
import assert from 'node:assert/strict';
import type { Adapter, ModelResponse, StreamEvent, ToolCall } from '../types.js';
import { accumulateSse } from './stream.js';

export function feed(adapter: Adapter, lines: string[]): StreamEvent[] {
  return lines.flatMap((line) => adapter.parseSseLine(line));
}

export function collect(adapter: Adapter, lines: string[], httpStatus?: number): ModelResponse {
  return accumulateSse(lines, (line) => adapter.parseSseLine(line), httpStatus);
}

/** 事件类型序列，便于断言「逐帧输入 → 事件序列」。 */
export function types(events: StreamEvent[]): string[] {
  return events.map((e) => (e.type === 'done' && e.finishReason ? `done:${e.finishReason}` : e.type));
}

export function textOf(events: StreamEvent[]): string {
  return events
    .filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.delta)
    .join('');
}

/** 取第一条 toolCall，缺失即测试失败（避免测试里写一堆 `?.`）。 */
export function firstCall(res: ModelResponse): ToolCall {
  const call = res.toolCalls?.[0];
  assert.ok(call, '期望至少一条 toolCall');
  return call;
}

/** 「流断但 HTTP 200」的共用断言：finishReason 必须缺失，不能默认成 stop。 */
export function assertTruncated(res: ModelResponse): void {
  assert.equal(res.finishReason, undefined);
  assert.equal(res.httpStatus, 200);
  assert.equal(res.error, undefined);
}
