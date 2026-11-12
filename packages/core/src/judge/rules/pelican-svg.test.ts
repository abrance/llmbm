import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgePelicanSvg, unclosedTags } from './pelican-svg.js';
import type { JudgeContext, Question } from '../../types.js';

const ctx = (text: string, expect: unknown, error?: string): JudgeContext => ({
  question: { id: 't', group: 'advanced', prompt: 'p', judge: 'pelican-svg', expect } as Question,
  response: { text, ...(error ? { error } : {}) },
});

const GOOD = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <ellipse cx="50" cy="50" rx="20" ry="30"/>
  <circle cx="40" cy="30" r="8"/>
  <path d="M50 60 L70 80"/>
</svg>`;

test('正例：结构完整的 SVG', () => {
  const checks = judgePelicanSvg(ctx(GOOD, { minShapes: 3 }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('正例：围栏包裹也能判', () => {
  const checks = judgePelicanSvg(ctx('```svg\n' + GOOD + '\n```', { minShapes: 3 }));
  assert.equal(checks.filter((c) => !c.pass).length, 0);
});

test('反例：格式对内容错 —— 有 svg 但图形不够', () => {
  const checks = judgePelicanSvg(ctx('<svg viewBox="0 0 10 10"><circle cx="1" cy="1" r="1"/></svg>', { minShapes: 3 }));
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.name, 'svg.shapes');
});

test('反例：内容缺项 —— 没有 viewBox', () => {
  const checks = judgePelicanSvg(ctx('<svg><circle cx="1" cy="1" r="1"/><path d="M0 0"/><rect width="1" height="1"/></svg>', { minShapes: 3 }));
  assert.ok(checks.some((c) => c.name === 'svg.viewBox' && !c.pass));
});

test('反例：含 script', () => {
  const checks = judgePelicanSvg(ctx('<svg viewBox="0 0 1 1"><script>alert(1)</script><circle/><path/><rect/></svg>', { minShapes: 3 }));
  assert.ok(checks.some((c) => c.name === 'svg.no-script' && !c.pass));
});

test('反例：标签未闭合', () => {
  const checks = judgePelicanSvg(ctx('<svg viewBox="0 0 1 1"><g><circle cx="1" cy="1" r="1"/><path d="M0"/><rect/></svg>', { minShapes: 3 }));
  assert.ok(checks.some((c) => c.name === 'svg.closed' && !c.pass));
});

test('反例：空响应 → empty 硬失败', () => {
  const checks = judgePelicanSvg(ctx('   ', { minShapes: 3 }));
  assert.ok(checks.some((c) => c.name === 'empty' && c.hard));
});

test('反例：没有 svg 标签 → 硬失败', () => {
  const checks = judgePelicanSvg(ctx('这是一只鹈鹕的描述文字。', { minShapes: 3 }));
  assert.ok(checks.some((c) => c.name === 'svg.tag' && c.hard && !c.pass));
});

test('反例：expect 非法抛错', () => {
  assert.throws(() => judgePelicanSvg(ctx(GOOD, { minShapes: -1 })), /minShapes/);
  assert.throws(() => judgePelicanSvg(ctx(GOOD, 3)), /expect/);
});

test('反例：传输错误附加硬检查', () => {
  const checks = judgePelicanSvg(ctx(GOOD, { minShapes: 3 }, 'ECONNRESET'));
  assert.ok(checks.some((c) => c.name === 'transport' && c.hard));
});

test('unclosedTags：自闭合与 void 标签不算未闭合', () => {
  assert.deepEqual(unclosedTags('<svg><path d="M0"/><circle/><br></svg>'), []);
  assert.deepEqual(unclosedTags('<svg><g></svg>'), ['g']);
});
