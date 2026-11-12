# 变更说明

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化。

## [未发布]

### 新增
- 工作区骨架：`npm workspaces`（`packages/*` + `apps/*`）、TS strict、`node:test`
- `apps/web`：Vite + React 18 + antd 空壳，四页路由（接入配置 / 跑测 / 结果 / 社区）、
  断点续跑 checkpoint 纯逻辑与浏览器存储适配
- `apps/api`：Fastify 空壳 + `/api/models`、`/api/proxy`（SSE 透传）、`/api/community/*`，
  SQLite 单文件 repo 层，D5 代理护栏（目标校验 / 并发上限 / 超时 / body 上限）
- CI：install → typecheck → lint → test；镜像构建推送 GHCR
- `deploy/`：api / web 多阶段 Dockerfile、nginx（SSE 关缓冲）、docker-compose

### 已知限制
- 跑测引擎与题库尚未接入：`/run`、`/result` 目前是流程骨架，不产出真实分数
- `judge/rules` 只有 `exact` 参考实现，其余 18 类待补
