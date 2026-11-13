# llmbm 产品规格与架构基线 v0.1

日期：2026-11-12 · 作者：sor（架构） · 对标：https://www.apitest.work/

仓库：`/opt/mystorage/github/llmbm`（git@github.com:abrance/llmbm.git，当前空仓）

## 0. 一句话目标

做一个 **LLM API 中转站可信度检测工作台**：填 Base URL + Key + 模型 ID，跑套题，输出能力分、覆盖率、
问题探针、证据链，结果可提交社区横向对比。功能面对齐 apitest.work，工程质量必须高于它。

## 1. 功能基线（对齐 apitest.work，缺一不可）

| # | 功能 | 验收要点 |
|---|---|---|
| F1 | 接入配置 | Base URL / API Key / 模型 ID；OpenAI 兼容 `/v1/models` 拉模型列表 |
| F2 | 协议适配 | openai / anthropic / gemini 三家请求体 + SSE 帧格式归一化 |
| F3 | 题库分组 | 基础、能力、对抗、耐久、进阶、精选补测、上下文与参数，可单选/多选 |
| F4 | 确定性抽样 | seed → 同 seed 出同一套题，结果可复现 |
| F5 | 判卷 | ≥19 类 judge（见 §2，当前 20 类） |
| F6 | 单题打分 | pass 项/总项 + 硬规则（见 §2.3） |
| F7 | 维度聚合 | 各维度得分 + format（格式检查命中率）+ stability（有效采样率 = 有效采样 / 应跑采样；被拒与传输失败都会压低它） |
| F8 | 能力分 | 均值聚合，非全 100 满分则封顶 99 |
| F9 | 家族指纹 | 判定"是否被换成小模型/降智"，并标注置信度（**弱信号**：无同端点基线时只能给 `insufficient-data`，不得从单次形态下结论） |
| F10 | 退化检测 | 复读、行去重比例（同上，弱信号） |
| F11 | 证据链 | 每次响应原文留存，可导出 md / json |
| F12 | 社区 | 提交结果 → 按域名/模型列表 → 横向对比榜单（**参与是选项，默认不勾选**；服务端要求 `consent=true`） |
| F13 | 流程控制 | 跑测 / 补测、断点续跑（checkpoint）、随时取消（真 abort） |

## 2. 判分（本产品核心资产）

### 2.1 judge 清单（至少 19 类）
`exact` `contains` `not-contains` `regex` `set` `json` `json-schema` `number` `fraction`
`conflict` `ordering` `function-call` `tool-args` `pelican-svg` `long-output` `refusal`
`format-json` `unit-convert` `cite` `max-tokens`（第 20 类，v0.3 增补：验端点是否真的按 max_tokens 截断）

全部为**本地纯文本/结构规则**，不调用模型打分（LLM-as-judge 只作为可选的人工复核辅助，不进主分）。

### 2.2 题目格式（数据化，不是代码）
```json
{
  "id": "basic-json-001",
  "group": "basic",
  "weight": 1,
  "core": true,
  "prompt": "……",
  "judge": "json-schema",
  "expect": { "required": ["name", "age"] },
  "timeoutMs": 30000
}
```
新增一类判定 = 在 judge registry 注册一个函数 + 一条单测，**不允许**在某个大 if-else 里堆分支。

### 2.3 单题打分规则
- 分数 = pass 项 / 总检查项 × 100
- 核心项（`core:true`）答错 → 该题直接 0
- 参数类题目答对主体但参数错 → 封顶 50
- 答案包装规整（有 fenced code / 结构完整）但内容有瑕 → 保底 85，且标 `pending_review`
- ≥90 记为 pass；55~90 记 `pending_review`；<55 fail

### 2.4 用例可读性（v0.3 增补）
每题必须带 `description`（这题测什么、答错说明什么），并在界面上与「实际发出去的上下文」并排展示：

- 题库页：按分组列出全部题目，展示题号、判定、`description`、上下文摘要（单轮/多轮、system、注入规模、
  图片、工具、temperature/max_tokens、超时、输入字符数），展开可看真正发出的消息与判定期望。
- 结果页：证据链每题展开后先给「这题测什么 + 本题上下文」，再给每次采样的正文、判定项、耗时、首字延迟、吞吐。
- 展示与实际发包必须同源（`prompt.ts` 的 `buildMessages`），不允许界面自己拼一份说明。

### 2.5 输入形态（v0.3 增补）
题库可以用数据描述多轮（`messages`）、长上下文注入（`contextDoc`，运行时确定性生成，不把 6 万字写进 JSON）、
图片（`image`）与请求参数（`request`），覆盖中转站最典型的作假面：丢 system、丢历史、
谎报长上下文、忽略 max_tokens、丢图片、假流式。

### 2.6 提前终止与容忍（v0.3 增补，v0.3.4 改口径）
判定口径只有一个问题：**换题或重试能不能变好**。能变好的一律容忍（只压低稳定性，不终止整卷），
不能变好的立刻终止并把原因交给用户。

| 错误性质 | 判据 | 处理 |
|---|---|---|
| `account` 账户层面 | 401/402/403，或响应体明说欠费、余额不足、配额耗尽、订阅/会员过期、Key 失效 | **预检即终止**（跑第一题之前先发一条最小探针），或首次命中即终止 |
| `config` 配置错 | 404（baseUrl 或模型名不存在） | 首次命中即终止，提示检查配置 |
| `request` 请求形状被拒 | 400/405/409/413/415/422 等（如 thinking 模式要求回传 `reasoning_content`、参数不被接受） | **不终止**：该次采样记失败、从能力分剔除，只压低有效采样率；结果页列出被拒次数、状态码与响应片段 |
| `transient` 瞬时故障 | 429（非配额）、5xx、超时、网络错误 | 传输层先退避重试；仍失败则容忍，连续 5 次（≈ 2 题）才判端点不可用并终止 |

- 终止等价于「非用户取消的取消」：已完成题目保留、断点保留、`cancelled=true` 且带 `abortReason`；
  结果页显示终止原因，未跑的题不进能力分（D5），但稳定性会下降；修好端点后可「继续上次」续跑。
- 容忍的失败不是静默的：`notices` 随结果落盘并在结果页与 Markdown 导出里列出。
- 判定逻辑只有一份：`classifyFailure`（`packages/core/src/failure.ts`），
  `FailureGuard`（`apps/web/src/lib/abort.ts`）只管计数与阈值。

## 3. 与 apitest.work 的差异（这 6 条是硬要求，别照抄）

- **D1 单一判分实现**：判分、聚合、抽样、adapter 只在 `packages/core` 里写一份纯函数，
  浏览器端与 Node 端共用；出现第二份实现即视为缺陷。
- **D2 题库数据化 + 判定注册表**：题目是数据，judge 是注册表条目。禁止"evalProbe 里 if 套 else if 再包一层旧实现"。
- **D3 分数带区间**：每题默认 N=3 次采样，报告 `均值 ± 半宽` 与样本数；总分同样给区间，不允许只输出一个整数。
- **D4 隐私**：Key 只进浏览器内存/localStorage；服务端代理路径全程不落 Key 与请求体；任何走代理的请求必须显式告知用户。
- **D5 代理安全**：目标域名白名单 / 拒私网、回环、云元数据地址 / 单请求超时 / 并发上限 / 请求体大小上限。
- **D6 可审计**：结果里写入 `questionBankVersion` 与 `judgeRuleVersion`，任何人可复现同一份分数。

## 4. 技术选型（定稿，改需找我）

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript（strict） | 判分规则要能前后端共用 |
| 仓库结构 | npm workspaces：`packages/core` + `apps/web` + `apps/api` | 与 vectorman / ptdoc 一致，团队零学习成本 |
| core | 零运行时依赖纯函数，`node:test` 覆盖 | 可单测、可换题库、可移植 |
| 前端 | React 18 + Vite + antd + react-router | 团队已在用（vectorman console） |
| 状态 | hooks + 少量 context，不引 redux | 页面状态简单 |
| 长任务 | Web Worker + AbortController + IndexedDB checkpoint | 后台标签页节流、刷新不丢 |
| 后端 | Node 24 + Fastify：`/api/models` `/api/proxy`(SSE 透传) `/api/community/*` | 单进程够用 |
| 存储 | 单文件 SQLite（`node:sqlite` 内置），一张 `results` + 一张 `submissions` | 量级 <1e4 行；迁移 PG 只改一个 repo 层文件 |
| 部署 | Dockerfile + docker compose | 不需要 k8s / 队列 / 缓存 |
| 测试 | core 单测必过；每个 judge ≥1 正例 1 反例；api 有 smoke 测试 | 判分错 = 产品死 |

**明确不做（v0.1）**：账号体系、付费、多租户、i18n、移动端适配、自建模型网关、向量检索。

## 5. 分工与文件所有权（避免并发写冲突）

| 人 | 范围 | 边界 |
|---|---|---|
| pit | 仓库骨架、CI、Dockerfile/compose、scripts、README | 骨架交付后只改 `.github/` `deploy/` `scripts/` |
| wof | `apps/web/**` 全部 + `packages/core/src/data/**`（题库 JSON、题目设计） | 不改 core 的判定实现 |
| mike | `packages/core/src/{judge,adapters,scoring,sampling}/**`、代码规范、MR 评审与合入 | 不改 `apps/web` |
| sor | 架构与选型裁决、功能基线验收 | 不改业务代码 |

节奏：pit 先把骨架做到 `npm ci && npm test` 能过；wof / mike 在各自目录内并行；合并顺序与冲突由 mike 定。

## 6. v0.1 完成定义

1. `npm ci && npm test` 全绿，core 覆盖率中 judge 每条规则有正反例
2. 本地起 web + api，用真实中转站 Base URL/Key 跑完一次"验收"套题
3. 产出：能力分 + 区间 + 各维度分 + 问题探针 + 证据链，可导出
4. 结果可**主动勾选参与**后提交社区并被列表/榜单查询到（默认不参与，未勾选无法提交）
5. 判分逻辑全仓只有 `packages/core` 一份实现（`rg` 可验证）
