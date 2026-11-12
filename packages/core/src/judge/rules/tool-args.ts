/**
 * tool-args —— 函数调用参数是否与期望深子集匹配（主体对参数错的判定点）。
 * expect: { name: string, args: Record<string, unknown>, allowExtra?: boolean, numericTolerance?: number }
 * 参数解析失败 → args.parse 硬失败；找不到同名调用 → 硬失败。
 */
import type { JudgeCheck, JudgeContext, ToolCall } from '../../types.js';
import { subsetMismatches, transportChecks, truncate } from './shared.js';

export interface ToolArgsExpect {
  name: string;
  args: Record<string, unknown>;
  allowExtra?: boolean;
  numericTolerance?: number;
}

function normalize(expect: unknown): ToolArgsExpect {
  if (!expect || typeof expect !== 'object') throw new Error('tool-args judge 需要 expect 为 { name, args }');
  const e = expect as Partial<ToolArgsExpect>;
  if (typeof e.name !== 'string' || e.name.length === 0) {
    throw new Error('tool-args judge 的 expect.name 必须是非空字符串');
  }
  if (!e.args || typeof e.args !== 'object' || Array.isArray(e.args)) {
    throw new Error('tool-args judge 的 expect.args 必须是对象');
  }
  if (e.numericTolerance !== undefined && (typeof e.numericTolerance !== 'number' || e.numericTolerance < 0)) {
    throw new Error('tool-args judge 的 expect.numericTolerance 必须是非负数字');
  }
  return {
    name: e.name,
    args: e.args as Record<string, unknown>,
    ...(e.allowExtra !== undefined ? { allowExtra: e.allowExtra } : {}),
    ...(e.numericTolerance !== undefined ? { numericTolerance: e.numericTolerance } : {}),
  };
}

/** 找到第一个同名调用；没有则返回 undefined。 */
function findCall(calls: readonly ToolCall[], name: string): ToolCall | undefined {
  return calls.find((c) => c.name === name);
}

export function judgeToolArgs({ response, question }: JudgeContext): JudgeCheck[] {
  const exp = normalize(question.expect);
  const calls = response.toolCalls ?? [];
  const call = findCall(calls, exp.name);

  if (!call) {
    return [
      {
        name: 'args.call',
        pass: false,
        hard: true,
        detail: calls.length === 0 ? `没有发出函数调用；正文：${truncate(response.text)}` : `没有名为 ${exp.name} 的调用，实际: ${calls.map((c) => c.name).join(', ')}`,
      },
      ...transportChecks(response),
    ];
  }

  let parsed = call.args;
  if (parsed === undefined && typeof call.rawArguments === 'string') {
    try {
      parsed = JSON.parse(call.rawArguments);
    } catch (err) {
      return [
        {
          name: 'args.parse',
          pass: false,
          hard: true,
          detail: `参数不是合法 JSON: ${err instanceof Error ? err.message : String(err)}；原文：${truncate(call.rawArguments)}`,
        },
        ...transportChecks(response),
      ];
    }
  }

  if (parsed === undefined) {
    return [
      { name: 'args.parse', pass: false, hard: true, detail: `调用 ${exp.name} 没有可解析的参数` },
      ...transportChecks(response),
    ];
  }

  const checks: JudgeCheck[] = [{ name: 'args.call', pass: true, detail: `命中调用 ${exp.name}` }];

  const mismatches = subsetMismatches(parsed, exp.args, '', { numericTolerance: exp.numericTolerance ?? 0 });
  checks.push({
    name: 'args.match',
    pass: mismatches.length === 0,
    ...(mismatches.length === 0 ? {} : { detail: mismatches.join('; ') }),
  });

  if (exp.allowExtra === false && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const extra = Object.keys(parsed as Record<string, unknown>).filter((k) => !(k in exp.args));
    checks.push({
      name: 'args.no-extra',
      pass: extra.length === 0,
      ...(extra.length === 0 ? {} : { detail: `多余参数: ${extra.join(', ')}` }),
    });
  }

  return [...checks, ...transportChecks(response)];
}
