# 变更说明

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化。

## [未发布]

### 新增
- **提前终止（短路）**：端点整体不可用不再把同一个错误刷满整卷——
  401/402/403/404 第一次命中即终止；连续 3 次同类 4xx（400/422）或连续 3 次传输失败（超时/断网/5xx 重试耗尽）即终止。
  终止后已完成题目与断点全部保留，结果页显示终止原因，修好后可「继续上次」续跑。判定集中在
  `apps/web/src/lib/abort.ts` 的 `FailureGuard`，致命状态码由 core 的 `isFatalStatus` 定义。
- **题库扩到 7 组 64 题**，新增 `context`（上下文与参数）组 15 题，专测中转站最常见的作假面：
  丢 system 提示（`ctx-system-001`）、丢多轮历史（`ctx-history-001/002`）、多轮里格式约束失效（`ctx-degrade-001`）、
  谎报长上下文（`ctx-needle-001/002` 在 4~6 万字文档的中段与 97% 位置埋针）、忽略 `max_tokens`
  （`ctx-params-001/002`）、`temperature=0` 下的确定性（`ctx-temp-001`）、工具结果回填闭环
  （`ctx-tool-loop-001/002`）、图片输入（`ctx-image-001`，64×64 四色块）、以及「正常请求被误杀」（`ctx-refusal-ok-001/002`）。
- **新 judge `max-tokens`（第 20 类）**：看 `finishReason` 是否真截断 + `completion_tokens` 是否超上限，
  抓「端点把 max_tokens 当摆设甚至偷偷放大」。
- **题库输入模型**：`Question` 支持 `messages`（多轮）、`contextDoc`（运行时确定性生成长文档 + 针）、`image`、
  `request`（temperature/max_tokens）、`tools`；组装规则只在 `packages/core/src/prompt.ts` 一处
  （`buildMessages` / `summarizeQuestion`），transport 与界面共用。
- **多模态请求**：`ChatMessage.content` 支持分片数组，openai / anthropic / gemini 三家各自映射图片。
- **首字延迟与吞吐**：transport 改为增量读流，记录 `ttftMs`（首个正文增量）、`chunks`、`tokensPerSec`（扣掉首字延迟），
  非流式响应不编造这两个数。
- **「题库与用例」页**（`/bank`）：逐题展示「这题测什么」+ 实际请求上下文（轮数/角色序列/system 原文/注入规模/
  图片/工具/参数/超时/输入字符数），展开可看真正发出的消息与判定期望。
- **证据链与结果页**：每题展开先给「这题测什么 + 本题上下文」；每次采样增加首字、吞吐、分片数；
  结果页新增「采样一致率」（`temperature=0` 下多次采样是否字节一致，抓随机重放/换模型）。
- 每题补齐 `description`；`JUDGE_KINDS` 成为判分种类与界面文案的唯一事实源（不再硬编码 19）。

### 变更
- **社区榜单改为显式参与（默认不勾选）**：结果页新增「参与社区榜单」勾选框，默认不勾选，不勾选时
  「提交社区」按钮不可用；`POST /api/community/submit` 现在必须带 `consent: true`，缺失一律 400，
  任何客户端都无法绕过勾选把分数公开到榜单。

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
