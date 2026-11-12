/**
 * function-call —— 模型是否发出了期望的函数调用（toolCalls）。
 * expect: { name: string, count?: number }
 * 无 toolCalls → 硬失败（这类题不接受「用文字描述我要调什么」）。
 * count 缺省 1：前 count 个调用都要同名。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { transportChecks, truncate } from './shared.js';

export interface FunctionCallExpect {
  name: string;
  count?: number;
}

function normalize(expect: unknown): FunctionCallExpect {
  if (!expect || typeof expect !== 'object') throw new Error('function-call judge 需要 expect 为 { name }');
  const e = expect as Partial<FunctionCallExpect>;
  if (typeof e.name !== 'string' || e.name.length === 0) {
    throw new Error('function-call judge 的 expect.name 必须是非空字符串');
  }
  if (e.count !== undefined && (typeof e.count !== 'number' || e.count < 1 || !Number.isInteger(e.count))) {
    throw new Error('function-call judge 的 expect.count 必须是 >=1 的整数');
  }
  return { name: e.name, ...(e.count !== undefined ? { count: e.count } : {}) };
}

export function judgeFunctionCall({ response, question }: JudgeContext): JudgeCheck[] {
  const exp = normalize(question.expect);
  const calls = response.toolCalls ?? [];

  if (calls.length === 0) {
    return [
      {
        name: 'function-call.present',
        pass: false,
        hard: true,
        detail: `没有发出函数调用；正文：${truncate(response.text)}`,
      },
      ...transportChecks(response),
    ];
  }

  const count = exp.count ?? 1;
  const checks: JudgeCheck[] = [
    { name: 'function-call.present', pass: true, detail: `${calls.length} 个调用: ${calls.map((c) => c.name).join(', ')}` },
  ];

  for (let i = 0; i < count; i += 1) {
    const call = calls[i];
    const pass = call?.name === exp.name;
    checks.push({
      name: `function-call.name[${i}]`,
      pass,
      ...(pass ? {} : { detail: call ? `期望 ${exp.name}，实际 ${call.name}` : `缺少第 ${i + 1} 个调用` }),
    });
  }

  if (calls.length !== count && exp.count !== undefined) {
    checks.push({
      name: 'function-call.count',
      pass: false,
      detail: `期望 ${count} 个调用，实际 ${calls.length} 个`,
    });
  }

  return [...checks, ...transportChecks(response)];
}
