# 变更说明

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化。

## [未发布]

### 修复
- `judge/conflict`：共现不再等于同时断言。引号内提及、否定（`不能`/`无法`）、要求澄清
  （`无法判断`/`信息不足`/`请补充`）、选言结构（`安全或危险`）都不判冲突；同一句里两边都以
  肯定形式出现才失败。判定口径变更，`JUDGE_RULE_VERSION` → `judge-rules@0.1.1`
- 结果页与导出 Markdown 各加一句明示：区间只反映采样一致性，不覆盖题库覆盖度与判定口径差异

### 新增
- 工作区骨架：`npm workspaces`（`packages/*` + `apps/*`）、TS strict、`node:test`
- `apps/web`：Vite + React 18 + antd 空壳，四页路由（接入配置 / 跑测 / 结果 / 社区）、
  断点续跑 checkpoint 纯逻辑与浏览器存储适配
- `apps/api`：Fastify 空壳 + `/api/models`、`/api/proxy`（SSE 透传）、`/api/community/*`，
  SQLite 单文件 repo 层，D5 代理护栏（目标校验 / 并发上限 / 超时 / body 上限）
- CI：install → typecheck → lint → test；镜像构建推送 GHCR
- `deploy/`：单镜像 Dockerfile（api 进程内托管前端产物，同源免 CORS）、docker-compose

### 已知限制
- 跑测引擎与题库尚未接入：`/run`、`/result` 目前是流程骨架，不产出真实分数
- `judge/rules` 只有 `exact` 参考实现，其余 18 类待补
