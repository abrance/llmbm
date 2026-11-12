/**
 * pelican-svg —— SVG 结构检查（鹈鹕题）。
 * expect: { minShapes?: number }
 * 要求：含 <svg … </svg>、含 viewBox、图形元素（path/circle/ellipse/polygon/rect/line/polyline）数量 ≥ minShapes、
 * 不含 <script>、主要标签闭合。只看结构不看画得像不像（本地纯文本规则，不做渲染）。
 */
import type { JudgeCheck, JudgeContext } from '../../types.js';
import { emptyChecks, stripFence, transportChecks, truncate } from './shared.js';

export interface PelicanSvgExpect {
  minShapes?: number;
}

const SHAPE_RE = /<(path|circle|ellipse|polygon|rect|line|polyline)\b/gi;
const SCRIPT_RE = /<script\b/i;
const VOID_TAGS = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'path', 'circle', 'ellipse', 'polygon', 'rect', 'line', 'polyline', 'use', 'stop']);

function normalize(expect: unknown): PelicanSvgExpect {
  if (expect === undefined || expect === null) return {};
  if (typeof expect !== 'object') throw new Error('pelican-svg judge 需要 expect 为 { minShapes? }');
  const e = expect as Partial<PelicanSvgExpect>;
  if (e.minShapes !== undefined && (typeof e.minShapes !== 'number' || e.minShapes < 0)) {
    throw new Error('pelican-svg judge 的 expect.minShapes 必须是非负数字');
  }
  return { ...(e.minShapes !== undefined ? { minShapes: e.minShapes } : {}) };
}

/** 未闭合标签列表（粗检：只对非自闭合、非 void 标签计数）。 */
export function unclosedTags(svg: string): string[] {
  const open = new Map<string, number>();
  const tagRe = /<\/?([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(svg)) !== null) {
    const raw = m[0];
    const tag = (m[1] as string).toLowerCase();
    if (raw.startsWith('</')) {
      const n = open.get(tag) ?? 0;
      if (n <= 1) open.delete(tag);
      else open.set(tag, n - 1);
      continue;
    }
    if (m[2] === '/' || VOID_TAGS.has(tag)) continue;
    open.set(tag, (open.get(tag) ?? 0) + 1);
  }
  return [...open.keys()];
}

export function judgePelicanSvg({ response, question }: JudgeContext): JudgeCheck[] {
  const empty = emptyChecks(response);
  if (empty) return [...empty, ...transportChecks(response)];

  const exp = normalize(question.expect);
  const body = stripFence(response.text);
  const minShapes = exp.minShapes ?? 3;

  const hasOpen = /<svg\b/i.test(body);
  const hasClose = /<\/svg>/i.test(body);
  const shapes = body.match(SHAPE_RE) ?? [];
  const hasViewBox = /viewBox\s*=\s*["'][^"']+["']/i.test(body);
  const hasScript = SCRIPT_RE.test(body);
  const unclosed = unclosedTags(body);

  const checks: JudgeCheck[] = [
    {
      name: 'svg.tag',
      pass: hasOpen && hasClose,
      hard: !hasOpen,
      ...(hasOpen && hasClose ? {} : { detail: hasOpen ? '缺少 </svg> 闭合' : `正文里没有 <svg>；正文：${truncate(body)}` }),
    },
    { name: 'svg.viewBox', pass: hasViewBox, ...(hasViewBox ? {} : { detail: '缺少 viewBox 属性' }) },
    {
      name: 'svg.shapes',
      pass: shapes.length >= minShapes,
      ...(shapes.length >= minShapes ? { detail: `${shapes.length} 个图形元素` } : { detail: `图形元素 ${shapes.length} 个 < 要求的 ${minShapes} 个` }),
    },
    {
      name: 'svg.no-script',
      pass: !hasScript,
      ...(hasScript ? { detail: '含 <script>，不允许' } : {}),
    },
    {
      name: 'svg.closed',
      pass: unclosed.length === 0,
      ...(unclosed.length === 0 ? {} : { detail: `未闭合标签: ${unclosed.join(', ')}` }),
    },
  ];

  return [...checks, ...transportChecks(response)];
}
