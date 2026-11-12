/**
 * 单镜像静态托管测试（spec §7）：api 进程内托管前端产物。
 * 用临时目录造一份最小产物，不起端口、不联网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../app.js';
import { resolveWebRoot } from './static.js';

function makeDist(): string {
  const root = mkdtempSync(join(tmpdir(), 'llmbm-web-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(root, 'assets', 'app-abc123.js'), 'export const ok = 1;');
  return root;
}

test('static: webRoot 不存在时跳过托管', () => {
  assert.equal(resolveWebRoot(undefined), undefined);
  assert.equal(resolveWebRoot('/definitely/not/here'), undefined);
  assert.equal(resolveWebRoot(import.meta.filename), undefined); // 是文件不是目录
});

test('static: 相对路径转绝对，@fastify/static 只收绝对 root', () => {
  const root = makeDist();
  const prev = process.cwd();
  try {
    process.chdir(root);
    assert.equal(resolveWebRoot('.'), root);
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test('static: 根路径与静态资源可直接访问', async () => {
  const root = makeDist();
  const { app, close } = await buildApp({ webRoot: root });
  try {
    const index = await app.inject({ method: 'GET', url: '/' });
    assert.equal(index.statusCode, 200);
    assert.match(index.headers['content-type'] as string, /text\/html/);
    assert.match(index.body, /id="root"/);

    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.body, /export const ok = 1;/);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('static: 前端路由回落 index.html，接口不回落', async () => {
  const root = makeDist();
  const { app, close } = await buildApp({ webRoot: root });
  try {
    const spa = await app.inject({ method: 'GET', url: '/run' });
    assert.equal(spa.statusCode, 200);
    assert.match(spa.headers['content-type'] as string, /text\/html/);

    const api404 = await app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(api404.statusCode, 404);
    assert.match(api404.headers['content-type'] as string, /application\/json/);

    // /api 本身也不回落
    const apiRoot = await app.inject({ method: 'GET', url: '/api' });
    assert.equal(apiRoot.statusCode, 404);
    assert.match(apiRoot.headers['content-type'] as string, /application\/json/);

    // /__mock 同 /api：生产构建没有 Mock 端点，GET 也不能被回落成 HTML
    const mockGet = await app.inject({ method: 'GET', url: '/__mock/v1/models' });
    assert.equal(mockGet.statusCode, 404);
    assert.match(mockGet.headers['content-type'] as string, /application\/json/);
    assert.equal(mockGet.json().error, '未找到该接口或资源');

    const mockPost = await app.inject({ method: 'POST', url: '/__mock/v1/chat/completions' });
    assert.equal(mockPost.statusCode, 404);
    assert.match(mockPost.headers['content-type'] as string, /application\/json/);

    // 真实接口不受回落影响
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().ok, true);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('static: 未配置 webRoot 时 / 返回 404 而不是崩', async () => {
  const { app, close } = await buildApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 404);
  } finally {
    await close();
  }
});
