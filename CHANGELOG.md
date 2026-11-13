# 变更说明

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化。

## [未发布]

### 新增（v0.3.5）
- **F9 家族指纹 / F10 退化检测接入一次跑测（弱信号）**：core 新增 `runSignalsOf({ samplesByQuestion, baseline? })`，
  一次给出 `fingerprint`（平均正文 / reasoning 占比 / 工具调用率 / 拒答率 / 样本数）与 `degradation`
  （重复行占比、复读尾巴、长度萎缩、命中条数）。特征与阈值只有 `packages/core/src/fingerprint/index.ts`
  一份，web 不再自己算。
- **弱信号不能被当结论**：所有输出强制带 `weak: true`、`confidence`（只表示这条信号自身有多确定，不是降智概率）与
  `caveat`；没有同端点历史基线时 `verdict` 恒为 `insufficient-data`，绝不从单次响应形态猜「被换成小模型」。
  界面与导出里数值与 `caveat` 同屏，措辞只到「与基线有偏离（未确认降级）」。
- 结果页新增「家族指纹（弱信号）」卡片（问题探针与证据链之间），Markdown 导出加同名小节，json 自动带两个键；
  `RunRecord.fingerprint` / `degradation` 均为可选，旧记录显示「本次未采集」而不报错。
- 传输失败的采样不参与弱信号（否则空正文会被 `degradationOf` 判成「长度萎缩」，且与 D5 聚合口径冲突）；
  拒答率只读 refusal judge 的检查结果，不从正文猜。
- 单测：core 305 / web 54 / api 29 全绿。

### 修复
- **单测并发限流**：三个 workspace 的 `node --test` 都加 `--test-concurrency=3`。此前默认按核数
  开满（本机 12 核 / 41 个测试文件会同时 fork 出上百进程），瞬时 fork 压力会顶穿 cgroup 内存压力阈值，
  被 `systemd-oomd` 连带整个进程树杀掉。限并发后峰值子进程 4 个，全量 verify 约 40s → 55s。

### 变更
- **提前终止改成「按错误性质」判**：只有换题/重试都不可能变好的问题才终止整卷——
  `account`（401/402/403，或响应体明说欠费、余额不足、配额耗尽、订阅/会员过期、Key 失效）
  与 `config`（404 模型或路径不存在）。**跑第一题之前先发一条最小探针做预检**，账户类问题在整卷开始前就
  识别并终止，直接告诉用户去充值/换 Key，而不是白跑 192 次请求。
- **400/422 等「请求形状不被接受」不再终止整卷**：例如 thinking 模式端点要求多轮里回传
  `reasoning_content` 时的 400。这类错误只算该次采样失败，从能力分剔除，`notices` 在结果页与 Markdown
  导出里列明被拒次数、状态码与响应片段。
- **瞬时失败容忍度提高**：超时/断网/5xx 连续 3 次 → **5 次** 才判端点不可用，单次抖动只降稳定性不影响能力结论。
- **稳定性口径改为有效采样率**（有效采样 / 应跑采样）：被端点拒绝或超时不再让「完成率」保持 100%，
  偶发问题让稳定性掉一点点，系统性问题让稳定性明显掉。
- **thinking 模式兼容**：多轮请求命中 `reasoning_content must be passed back` 这类 400 时，
  给历史 assistant 消息补一次空 `reasoning_content` 重试（只补一次，仍被拒就按「请求形状被拒」记）。

### 新增
- `classifyFailure`（`packages/core/src/failure.ts`）：`account` / `config` / `request` / `transient` 四类错误的唯一判定。
- **提前终止（短路，v0.3.1 引入，v0.3.4 改为按错误性质判，见上）**：端点整体不可用时不再把同一个错误刷满整卷。
  终止后已完成题目与断点全部保留，结果页显示终止原因，修好后可「继续上次」续跑。
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
- **连通性测试误判「响应没有正文」**：`pingEndpoint` 原来只认正文，且只给 8 个 token —— 推理模型
  （R1 / o1 / QwQ / gemini thinking）把 token 全花在 reasoning 上时正文必然为空，一个完全健康的端点被判失败。
  现在正文 / 推理 / 工具调用任一非空即算连通（推理-only 会标注「仅推理」），`max_tokens` 给到 64、
  超时给到 30s；三者全空时仍判失败，但错误里带上 `finish_reason` 与 `completion_tokens`，能直接看出是网关空转。
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
