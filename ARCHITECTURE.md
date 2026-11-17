# llmbm 架构契约（v0.1）

对标 apitest.work，规格见 `docs/SPEC.md`（v0.1）。本文件是**唯一的接口与目录职责约定**，
改它要提交 PR 并说明理由。与 spec 冲突时以 spec 为准，spec 没写的以本文件为准。

## 1. 目录职责（一个目录只有一个事实源）

| 路径 | 职责 | 内容 |
|---|---|---|
| `packages/core/src/judge/registry.ts`、`judge/index.ts`、`scoring/**`、`fingerprint/**`、`timeout.ts`、`aggregate.ts`、`sampling/**`、`types.ts`、`index.ts` | core | 判分/聚合/抽样/弱信号/超时归因与时延统计（v0.4 契约）的骨架与契约 |
| `packages/core/src/fingerprint/model-trace/**` | core | ModelTrace 探针挑战、参考库加载、排名打分、闭集概率与 replay 回归（v0.4，纯函数） |
| `packages/core/src/data/model-trace-bank/**` | data | 精简参考库 JSON + `MANIFEST.json`（上游 commit / 探针参数 / calibration）；只放数据，不含代码 |
| `packages/core/src/judge/rules/**` | rules | 各判定规则的实现与正反例单测 |
| `packages/core/src/adapters/**` | core | openai / anthropic / gemini 请求体与 SSE 归一化（只放协议映射） |
| `packages/core/src/prompt.ts` | core | 题库条目 → 请求消息的组装规则（`buildMessages` / `summarizeQuestion`），唯一实现 |
| `packages/core/src/data/**` | data | 题库 JSON、分组、题目设计 |
| `apps/web/**` | web | React + Vite + antd 前端；含超时/时延归因（`lib/latency.ts` 纯函数 + 面板）与 ModelTrace 结果卡片 |
| `apps/api/**`、`.github/**`、`deploy/**`、`scripts/**`、`README.md` | api / infra | Fastify 代理/社区接口、CI、Dockerfile、脚本（含 `scripts/build-modeltrace-bank.mjs`） |
| 根 `package.json` / `tsconfig*` / 本文件 | maintainers | 工作区与构建基线 |

跨目录改动：先开 issue 说明；一个 PR 只做一件事，需要其他模块配合就在 PR 里写清。

## 2. 不可违反的六条（spec §3）

- D1 判分/聚合法/抽样/adapter **只在 `packages/core` 一份实现**，web 与 api 都从 `@llmbm/core` 引；`rg` 能验证。
- D2 题目是数据，判定是注册表条目；禁止在某个函数里堆 `if (judge === 'json') … else if …`。
- D3 每题默认 3 次采样，报告 `均值 ± 半宽 (n=3)`，总分同样带区间；只输出单个整数视为缺陷。
- D4 Key 只进浏览器内存/localStorage；服务端代理不落 Key 与请求体；走代理必须显式告知用户。
- D5 代理白名单 + 拒私网/回环/云元数据（169.254.169.254 等）+ 单请求超时 + 并发上限 + body 上限。
- D6 结果里写 `questionBankVersion` 与 `judgeRuleVersion`；规则行为变了必须 bump `JUDGE_RULE_VERSION`。

## 3. judge 契约

每个 kind 一个文件 `judge/rules/<kind>.ts`，导出 `judgeXxx(ctx: JudgeContext): JudgeCheck[]`，
在 `judge/rules/index.ts` 的 `registerRules()` 里 `registry.register(kind, fn)`。
**实现判定只用本地纯文本/结构规则，禁止调模型打分，禁止网络请求。**

返回的 check 名要能直接给用户看（如 `schema.required:name`）。约定：

- `hard: true` 且失败 → 该题 0 分。
- 命中「主体对、参数错」时，check 仍按失败记，同时**不要**自己改分；把语义放进 check 名（`args.name` / `value.tolerance`），
  由 scoring 依据 `flags` 的 `params-wrong` 封顶 50。judge 需要表达该语义时通过 `detail` 文案 + 返回值里的
  `weight` 区分，别在 judge 里写死分数。
- 响应带 `response.error` → 追加一条 `{ name: 'transport', pass: false, hard: true, detail }`。
- 空正文 → 返回 `[{ name: 'empty', pass: false, hard: true }]`，不要返回空数组（registry 会兜成硬失败）。
- `expect` 形状非法 → 抛错（`runJudge` 会兜成硬失败），并在单测里覆盖这条。

### 判定清单（expect 形状 / 检查语义）

| kind | expect | 检查语义 |
|---|---|---|
| `exact` | `{ value, trim?, caseInsensitive?, allowTrailingPeriod? }` 或裸值 | 去空白后全等（参考实现已给） |
| `contains` | `{ values: string[], all?: true, caseInsensitive? }` | 每个子串出现；`all:false` 时任一出即可 |
| `not-contains` | `{ values: string[], caseInsensitive? }` | 任一出现即失败 |
| `regex` | `{ pattern, flags?, mustMatch?: true }` | 默认须匹配；`mustMatch:false` 时须不匹配 |
| `set` | `{ values: string[], mode: 'exact'\|'superset'\|'subset', caseInsensitive? }` | 从输出里切集合（JSON 数组/逗号/换行/无序列表）再比较；缺项与多项分别给 check |
| `json` | `{ required?: string[], equals?: unknown, allowExtra?: true }` | 去 fence 后解析；required 逐键存在、equals 深比较子集 |
| `json-schema` | `{ required?: string[], properties?: Record<string,{type?:'string'\|'number'\|'boolean'\|'array'\|'object', enum?: unknown[], minItems?: number, items?: {type?}}>, minItems? }` | 零依赖的 JSON Schema 子集，只支持上述关键字；不支持的关键字要在文件头注释写明 |
| `number` | `{ value, tolerance?: 1e-6, relative?: true }` | 取正文中最后一个数；绝对/相对误差在容差内 |
| `fraction` | `{ numerator, denominator, tolerance? }` | 接受 `3/4`、`0.75`、`75%` 三种写法，统一换算比较 |
| `conflict` | `{ pairs: { a: string; b: string }[] }` | 同一回答内 `a` 与 `b` 不能**同时以肯定形式断言**；引号内提及、否定/澄清、选言结构都不算。每对一条 check |
| `ordering` | `{ values: string[], strict?: false }` | 全部出现且下标递增；`strict:true` 要求相邻无缝 |
| `function-call` | `{ name, count?: 1 }` | `response.toolCalls` 首个（或前 count 个）函数名匹配；无 toolCalls → 硬失败 |
| `tool-args` | `{ name, args: Record<string, unknown>, allowExtra?: true, numericTolerance?: 0 }` | 同名函数的参数做深子集比较；参数解析失败 → `args.parse` 硬失败 |
| `pelican-svg` | `{ minShapes?: 3 }` | 文本含 `<svg`/`</svg>`、含 viewBox、含 ≥minShapes 个图形元素（path/circle/ellipse/polygon）、无 `<script>`、标签闭合 |
| `long-output` | `{ minChars, mustInclude?: string[], maxRepeatedLineRatio?: 0.5 }` | 有效正文长度（去空白）≥minChars；行去重比例（degenerate 信号）达标；缺 mustInclude 项各记一条 |
| `refusal` | `{ shouldRefuse: boolean, markers?: string[] }` | shouldRefuse 时须命中拒答标记，且不得在**肯定形式**的子句里出现危险操作信号（否定子句里的危险词是拒答宾语，不算做法）；否则不得拒答。命中给 `refused` 语义 detail |
| `format-json` | `{}` | 去 fence/前后缀后整段是合法 JSON，无多余散文；用于 format 维度 |
| `unit-convert` | `{ value, unit, tolerance?: 0.01, sourceUnit? }` | 抽 `数字+单位`，换算到目标单位比较；单位错 → 失败并记 `unit` |
| `cite` | `{ values: string[], mode?: 'all'\|'any' }` | 每个引用标记/链接出现在正文（`[1]`、`^1^`、URL 均可命中） |
| `max-tokens` | `{ maxTokens: number, finishReason?: 'length' }` | 请求带了 `max_tokens` 时端点是否真截断：`finishReason` 必须是 `length`/`max_tokens`/`max_output_tokens`（硬检查），有 `usage` 时 `completion_tokens ≤ maxTokens`，无 `usage` 时用 `maxTokens×6` 字上限兜底。传输失败只返回 transport 硬检查，不做长度判定 |

反例单测必须至少覆盖：**格式对内容错**、**内容缺项**、**空响应**。正例至少一条正常命中。

### 打分与聚合（D5）

- **没收到答案 ≠ 答得不对**：`ModelResponse.error` 有值的采样是传输失败，`scoreQuestion` 给 `transportError: true`、
  status 恒为 `pending_review`（不用 `fail` 顶）。
- `aggregate` 只把非传输失败采样算进题均值、维度分、能力分；传输失败单独记 `report.transport`
  （`errors` / `samples` / `rate`），同时给出 `report.samples`（`valid` / `total`），让半宽大的读数能看出是不是被传输失败稀释。
- 有效采样不足（一次都没有，或不足总采样数的一半）时整题不进能力分，状态 `pending_review`。
  题级状态判定只有 `scoring.questionStatus` 一份实现，web worker 也用它。
- 传输失败的采样数**不是**抬高 timeout 的理由：网关卡挂时中位数 0.6s、卡住的 60s，抬 timeout 只会多等。

### 题库输入模型（`prompt.ts`）

`Question` 除 §2.2 的字段外还可以带「输入形态」，让题库用数据描述多轮/长文档/图片/参数，
而不是给每类题写一份拼装代码：

| 字段 | 作用 | 组装规则 |
|---|---|---|
| `description` | 这题测什么、答错说明什么 | **不参与判分**，只给题库页与证据链展示 |
| `messages` | 完整多轮对话（含 `system` / `assistant` / `tool`） | 存在时原样发出，忽略 `system`+`prompt`；`prompt` 必须等于最后一条 user 文本（有单测把关） |
| `contextDoc` | `{ fillerChars, needle?, needleAt? }` | 运行时按确定性算法生成填充文本（不入库），把针插到 `needleAt` 位置，整体拼在最后一条 user 的前部 |
| `image` | `{ mimeType, dataBase64, alt? }` | 追加到最后一条 user 的 content 分片数组末尾 |
| `request` | `{ temperature?, maxTokens? }` | 直接进 `ChatRequest`；缺省 `temperature=0` |
| `tools` | `ToolSpec[]` | 工具声明，与工具回填闭环题配套 |

- `buildMessages(question)` 是「题库 → 请求」的唯一实现，transport 发包与界面展示都必须走它。
- `summarizeQuestion(question)` 由同一份组装结果推导上下文摘要（轮数、角色序列、注入规模、图片大小、参数、超时、输入字符数），
  题库页与结果页显示的就是「实际发出去的东西」，不允许各写一套。
- `ChatMessage.content` 是 `string | ContentPart[]`：纯文本仍是字符串，只有多模态才用分片数组，
  各 adapter 自己映射（openai `image_url` / anthropic `image` base64 block / gemini `inlineData`）。

## 4. adapter 契约

`adapters/<protocol>.ts` 各导出一个 `Adapter`（见 `types.ts`），`adapters/index.ts` 导出
`getAdapter(protocol)` 与 `detectProtocol(baseUrl, modelHint?)`。

必须处理：

- openai：`/chat/completions`，`messages` 直传；SSE `data: {...}`，`choices[0].delta.content` 与 `delta.reasoning_content`，`delta.tool_calls[].function.arguments` 增量拼接，结尾 `data: [DONE]`。
- anthropic：`/v1/messages`，`system` 单独字段，`max_tokens` 必填；SSE 事件类型 `content_block_delta`（`text_delta` / `input_json_delta`）、`message_delta`（`stop_reason`、`usage`）。
- gemini：`/v1beta/models/{model}:streamGenerateContent?alt=sse`，`contents[].parts[].text`，`generationConfig`；`usageMetadata` 映射。
- 429/5xx 退避由调用方做，但 adapter 提供 `isRetryable(status)`。
- 多模态：`content` 为分片数组时按各自 wire 形状映射（见上节表格），文本分片在前、图片在后。
- 首字延迟与分片数由调用方（`apps/web/src/lib/transport.ts` 增量读流）采集，adapter 不负责计时。
- `ChatRequest.tools` 是协议无关的 `ToolSpec[]`（固定 OpenAI function 形状），各 adapter 自己映射：
  openai 原样透传、anthropic `{name, description, input_schema}`、gemini `tools:[{functionDeclarations}]`。
  调用方不按协议分支，也不在 adapter 之外改请求体。
- 多轮工具回填同理：`ChatMessage` 的 `role` 含 `'tool'`，assistant 侧用 `tool_calls`（`ToolCallSpec[]`，
  `arguments` 是 JSON 字符串），工具结果用 `tool_call_id` 指回调用。adapter 各自映射：
  openai 直传 `tool_calls` / `tool_call_id`；anthropic 改成 `tool_use` block + `user` 里的 `tool_result` block；
  gemini 改成 `functionCall` part + `functionResponse`（按 `name` 回填，不用 id，故 `name` 可选但 gemini 需要）。
  题库当前用不上多轮工具，但契约不留半截。
- **「流断但 HTTP 200」**：SSE 正常结束标记缺失时，`parseSseLine` 不负责判定，调用方用 `finishReason` 是否到达来判断；
  adapter 必须在 `parseChatResponse`/聚合结果里保证 `finishReason` 缺失可辨别。解析器不许静默吞掉不认识的帧。

单测要求：每家一份「正常流」「reasoning 帧」「tool_calls 增量」「不认识的帧被忽略但不报错」「HTTP 200 但无完成标记」。

## 5. 质量门（合并前必须全绿）

```bash
npm ci
npm run verify        # typecheck + core 单测
```

- `judge/rules/shared.ts` 是子句/否定判定的唯一实现（引号剔除 → 强句界切子句 → 否定作用域）。
  需要「共现 ≠ 断言」「否定式提及」语义的规则必须复用它，禁止在单条规则里另写一套。
- 每条 judge ≥1 正例 1 反例；新增 judge 时把 kind 加进 `JUDGE_KINDS`，`judge/coverage.test.ts` 自动要求「注册集合与 JUDGE_KINDS 完全一致」，不必手改数字。
- 判分逻辑出现第二份实现 → 直接拒合（D1）。
- 涉及行为的改动必须在 PR 描述写「影响面 / 复现命令 / 原始输出」。

## 6. 分支与合并顺序

- 分支：`feat/core-judges`、`feat/core-adapters`、`feat/web`、`feat/api-skeleton`；禁止直推 main。
- 合并顺序：`core 骨架（已合）` → `judges` → `adapters` → `web` → `api`。
  后合的人先 `git rebase main`，冲突只改自己目录。
- 合入判据：`npm run verify` 绿 + 维护者读完 diff + 无跨目录改动。

## 7. v0.4 增补：主动探针 / 排名参考库 / 超时归因（2026-11-16）

v0.4 一个版本发 **0.4.0**，三件事同版：参考库 + 排名、ModelTrace 探针、超时类用例与归因。
细节契约与验收口径见 `docs/v04-scope.md`，要点：

- **探针与排名是附加结论**：只出现在 `RunRecord.modelTrace`，`aggregate` 与 `judge` 都不读它，永远不进能力分。
- **参考库**只提交精简库（约 1.05MB，gzip 472KB），`provenance` 记录 `source_repo / source_commit / source_sha256 / license / built_at`；
  原始 14MB `unified_bank.json` 不入库。`node scripts/build-modeltrace-bank.mjs --check` 必须能从源重建同一 sha256；
  CI 跑 `--verify-hash`（只校验仓库内 `packages/core/src/data/model-trace-bank/` 的库与 MANIFEST）。
- **replay 回归是硬门槛**：用参考库自带的真实样本（`replay-fixture.json`，70 模型 × 3 条）回放，top-1 命中率 ≥95%；
  低于阈值直接拒合。只测函数不测数据不算通过。
- **超时归因只在 core 一份**：`packages/core/src/timeout.ts` 是唯一实现（`classifyTimeout` connect / first-token / mid-stream /
  rate-limit / gateway / unknown、`percentile` / `latencyStats` nearest-rank、`summarizeTransport`：分母 = 已发起 − 取消，
  p50/p95 只统成功的采样，429 / 502-504 归 rate-limit / gateway 不计入超时率）。
  `apps/web/src/lib/latency.ts` 只负责把「每题 × 每次采样」整理成可读结论与文案，**不写第二份阈值或分位数**；
  超时仍**不进 judge、不进能力分**。transport 把超时时的 `phase` / `lastChunkAtMs` / `chunks` / `attempts` 保留在
  `ModelResponse` 里供归因使用；超时类用例是题库新分组 `group=timeout`（题库维护者维护），**weight=0**：
  `aggregate` 对 weight=0（或 `diagnostic: true`）的题只记 transport、不进维度分/能力分/题级统计；跑测页默认不勾选该组，用户显式打开才跑。
- **MIT**：lm-detector / ModelTrace 均为 MIT（Copyright (c) 2026 xqy2006），`THIRD_PARTY_NOTICES.md` 保留声明与来源 URL。
- **默认关闭**：探针默认关（三条约 300 个整数的长请求有额外耗时与费用），用户显式打开才跑。

## 8. 合入标准（2026-11-12 定）

**硬门槛**：`npm run verify`（typecheck + lint + test）全绿，且 `test` 跑的是**干净编译**的 dist
（`packages/core` 的 `build` 先 `rm -rf dist`：`tsc` 不清旧产物，跨分支残留会让测试数虚高）。
前端改动的 PR 另需 `npm run build -w @llmbm/web` 通过。

**合并顺序**：骨架 → judges → adapters → web → api。前一项没合，后一项不合，避免契约两头改。

**单个 PR 的边界**：一个 PR 只做一件事；跨目录改动要单独说明理由。判分缺陷（scoring）与规则实现（rules）
不同 PR，前者由 core 维护者改，后者由 rules 维护者改。
