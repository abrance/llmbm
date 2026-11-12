/**
 * format-json —— 整段输出就是合法 JSON，没有多余散文或围栏（format 维度）。
 * expect: {} （不使用任何期望值）
 * 与 json judge 的区别：这条只判「格式纯净度」，不看字段内容，也不剥围栏。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, isFenced, transportChecks, truncate } from './shared.js';

export function judgeFormatJson({ response }: JudgeContext): JudgeCheck[] {
  const empty = emptyChecks(response);
  if (empty) return [...empty, ...transportChecks(response)];

  const raw = response.text;
  const text = raw.trim();
  const checks: JudgeCheck[] = [];

  const fenced = isFenced(text);
  checks.push({
    name: 'format.no-fence',
    pass: !fenced,
    ...(fenced ? { detail: '输出被 markdown 代码围栏包住（题目要求裸 JSON）' } : {}),
  });

  let parsedOk = false;
  let parseError = '';
  try {
    JSON.parse(text);
    parsedOk = true;
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  const isObject = parsedOk && /^[[{]/.test(text);
  checks.push({
    name: 'format.parse',
    pass: parsedOk && isObject,
    ...(parsedOk && isObject ? {} : { detail: parsedOk ? `是合法 JSON 但不是对象/数组：${truncate(text, 60)}` : `不是合法 JSON: ${parseError}；正文：${truncate(text)}` }),
  });

  return [...checks, ...transportChecks(response)];
}
