# 变更说明

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循语义化。

## [0.4.0] - 2026-11-16

### 新增（v0.4 ModelTrace 指纹排名）
- **参考库**：`packages/core/src/data/model-trace-bank/model-trace-bank.json`（1.05MB，70 模型 / 15 家族），
  由 `scripts/build-modeltrace-bank.mjs` 从 lm-detector（MIT，Copyright (c) 2026 xqy2006，
  `https://github.com/ikaleio/lm-detector`）commit `2c61f8f` 的 `data/unified_bank.json` 纯抽取生成；
  原始 14MB 库不入库。同目录 `MANIFEST.json` 记上游 commit、算法 `modeltrace-robust-v1`、探针参数与
  calibration（1/2/3 条有效样本的 `beta` 与交叉验证准确率）。
- **CI 门禁**：`node scripts/build-modeltrace-bank.mjs --verify-hash` 只校验仓库内库与 MANIFEST 的
  sha256 / 体积 / 上游 commit，不读原始库；`--check`（需原始库）仍可本地逐字节重建，sha256 `9b16f123…`。
- **core 打分 / 加载 / 探针**：`packages/core/src/fingerprint/model-trace/**` 纯函数——移植上游
  `fingerprint-core.js`（与 300 条真实样本逐条对齐，maxAbsDiff=0）；`loadModelTraceBank` 懒加载并校验；
  `runModelTraceProbe` 串行发 3 条长整数挑战，单条失败不中断整卷。
- **探针对齐上游 `2c61f8f`**：不发 `temperature`、`max_tokens = 8192`、每条独立 250000ms 超时
  （`ProbeSend` 第四参数 `{ timeoutMs }`，不继承普通题的 30s）。
- **闭集概率**：`ranked`（3 条有效样本）才给 `softmax(β × 均值分)`；`partial` / `insufficient` 给 null，
  不拿排名分冒充概率。
- **web 接入**：跑测页开关默认关；结果页 ModelTrace 卡（top-5、闭集概率、参考库交叉验证准确率与 caveat 同屏）；
  Markdown 导出加「ModelTrace 指纹排名（附加结论，不进能力分）」小节。探针失败只显示「未取得有效样本」，
  不影响能力分、保存与断点。
- **准确率口径**：`referenceAccuracy` 标为库属性（3 条样本 86.7%），不与本次运行的置信度混写；
  replay 回归是库内样本回放（70 模型 × 3 条，top-1 100%），属 in-sample 回归值，不是线上泛化准确率。

### 新增（v0.4 超时归因）
- **归因与统计只在 core 一份**：`packages/core/src/timeout.ts` 提供 `classifyTimeout`（connect / first-token /
  mid-stream / rate-limit / gateway / unknown，状态码优先）、`percentile` / `latencyStats`（nearest-rank）、
  `summarizeTransport`（超时率分母 = 已发起 − 用户取消；p50/p95/max 只统成功的采样）。
  `apps/web/src/lib/latency.ts` 只把每题 × 每次采样整理成可读结论，不写第二份阈值或分位数。
- **transport 保留失败时的进度**：`ModelResponse` 新增 `phase` / `lastChunkAtMs` / `chunks` / `attempts`，
  超时与流断时能回答「慢在哪一段」（连接 / 首字 / 流中），attempt 级超时重试成功也不会被抹掉。
- **只展示、不进分**：归因只写 `report.timeout`，结果页无错误采样时整块不渲染，旧记录显示「本次未采集」，
  Markdown 导出同步；不进 judge、不进能力分。
- **只跑观测题时不再显示 0.0 能力分**：全部 `weight=0` 时 `report.total.n === 0`，结果页与导出写
  「本次没有可评分的题目，能力分不适用」，避免被读成「模型 0 分」。

### 新增（v0.4 超时与响应时延）
- **题库新增 `timeout` 分组「超时与响应时延」（10 题，题库 74 题，版本 qb-2026-11-15.1）**：
  首字慢（TTFT 超长、正文正常）、彻底挂起、流式中途卡死（HTTP 200 无 finishReason）、慢速滴流、
  长输出超预算、短问答也超时、心跳空转、长尾 p95、预算边缘，以及并发时延放大（人工复核项，
  本卷按题串行采样、不自动测并发）。每题带 `description` 与独立 `timeoutMs` 预算。
- **该组只做传输观测，不计入能力分**：10 题全部 `weight: 0`（aggregate 对 weight=0 只记传输、
  不进维度分/能力分/题级统计）；跑测页默认不勾选该组，需用户显式勾选才跑。
- **时延分布统计（纯函数）**：`apps/web/src/lib/latency.ts` 对每次采样的 `latencyMs` / `ttftMs` 给
  本题 TTFT 与总耗时的 p50/p95/max、超时次数/采样数（超时率）、与同端点其他题中位对比，
  并输出可直接读的结论（如「短问答的 TTFT 中位 8.2s，说明不是题太大，是端点排队」）。
  分位数为 nearest-rank；超时只认 transport 的「请求超时」文案，断流/网络错误单独计数，
  不混进超时率；失败采样不参与分位数；0 采样与 timeoutMs=0 都有明确处理。
- **结果页「超时与响应时延」卡**：与问题探针并列、不折叠，结论置顶；未跑本组时明说没跑；
  0 超时也明说「本组 N 次采样 0 超时，TTFT 中位 Xms」。Markdown 导出同步加同名列。
- **单测**：web +14 条，覆盖全超时 / 部分超时 / 全正常三种输入下的结论文案与 p50/p95 计算，
  边界 1 条采样、0 条采样、timeoutMs=0。- **内置 Mock**：超时组改用 SSE 分片返回（首字延迟按题配置），可本地演示 TTFT；故障注入下
  `timeout-hang-001` 不返回，用来演示超时结论。
- 不改全局默认 timeout、不改 transport 重试与终止阈值（mike 的 core 契约）。

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
