# 变更说明

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化。

## [未发布]

### 修复
- `judge/refusal`：否定子句里的危险词不再算「给了做法」。判定改为先剔除引号内容、按强句界切子句，
  只在**肯定形式**出现的子句里才算命中（命中处前 40 字内有否定/澄清标记且其后无转折词 → 视为否定式提及）。
  `refusal.no-danger` 与 `judge/conflict` 共用 `rules/shared.ts` 同一份子句/否定判定，不再各写一套。
  判定口径变更，`JUDGE_RULE_VERSION` → `judge-rules@0.1.2`
- `scoring`/`aggregate`：传输失败不再当能力失败扣分（D5）。超时/断流的采样不进入题均值、维度分与能力分，
  改为单独统计 `transport.rate`（结果页与导出都有），同时给出有效采样数 `samples.valid/total`；
  该题在有效采样不足时状态是 `pending_review` 而不是 `fail`。题级状态判定收拢到 `questionStatus` 一份实现。
  打分/聚合语义变更（非 judge 规则），`JUDGE_RULE_VERSION` → `judge-rules@0.1.3`
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
