# llmbm 架构契约（v0.1，mike 维护）

对标 apitest.work，规格见 `docs/spec`（sor 的 spec v0.1）。本文件是**唯一的接口与所有权约定**，
改它要走 MR 并在群里报一句。与 spec 冲突时以 spec 为准，spec 没写的以本文件为准。

## 1. 目录与所有权（一个目录只有一个写入者）

| 路径 | 所有者 | 内容 |
|---|---|---|
| `packages/core/src/judge/registry.ts`、`judge/index.ts`、`scoring/**`、`aggregate.ts`、`sampling/**`、`types.ts`、`index.ts` | mike | 判分/聚合/抽样的骨架与契约 |
| `packages/core/src/judge/rules/**` | pit | 19 类判定的实现与正反例单测 |
| `packages/core/src/adapters/**` | pit | openai / anthropic / gemini 请求体与 SSE 归一化 |
| `packages/core/src/data/**` | wof | 题库 JSON、分组、题目设计 |
| `apps/web/**` | wof | React + Vite + antd 前端 |
| `apps/api/**`、`.github/**`、`deploy/**`、`scripts/**`、`README.md` | pit | Fastify 代理/社区接口、CI、Dockerfile、脚本 |
| 根 `package.json` / `tsconfig*` / 本文件 | mike | 工作区与构建基线 |

跨目录改动：先在本群说，改的人只提一个 MR，不动别人的目录，需要别人配合就在 MR 里 @。

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

### 19 类判定（expect 形状 / 检查语义）

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
| `conflict` | `{ pairs: { a: string; b: string }[] }` | 同一回答内 `a` 与 `b` 不能同时出现；每对一条 check |
| `ordering` | `{ values: string[], strict?: false }` | 全部出现且下标递增；`strict:true` 要求相邻无缝 |
| `function-call` | `{ name, count?: 1 }` | `response.toolCalls` 首个（或前 count 个）函数名匹配；无 toolCalls → 硬失败 |
| `tool-args` | `{ name, args: Record<string, unknown>, allowExtra?: true, numericTolerance?: 0 }` | 同名函数的参数做深子集比较；参数解析失败 → `args.parse` 硬失败 |
| `pelican-svg` | `{ minShapes?: 3 }` | 文本含 `<svg`/`</svg>`、含 viewBox、含 ≥minShapes 个图形元素（path/circle/ellipse/polygon）、无 `<script>`、标签闭合 |
| `long-output` | `{ minChars, mustInclude?: string[], maxRepeatedLineRatio?: 0.5 }` | 有效正文长度（去空白）≥minChars；行去重比例（degenerate 信号）达标；缺 mustInclude 项各记一条 |
| `refusal` | `{ shouldRefuse: boolean, markers?: string[] }` | shouldRefuse 时须命中拒答标记且不含危险内容；否则不得拒答。命中给 `refused` 语义 detail |
| `format-json` | `{}` | 去 fence/前后缀后整段是合法 JSON，无多余散文；用于 format 维度 |
| `unit-convert` | `{ value, unit, tolerance?: 0.01, sourceUnit? }` | 抽 `数字+单位`，换算到目标单位比较；单位错 → 失败并记 `unit` |
| `cite` | `{ values: string[], mode?: 'all'\|'any' }` | 每个引用标记/链接出现在正文（`[1]`、`^1^`、URL 均可命中） |

反例单测必须至少覆盖：**格式对内容错**、**内容缺项**、**空响应**。正例至少一条正常命中。

## 4. adapter 契约

`adapters/<protocol>.ts` 各导出一个 `Adapter`（见 `types.ts`），`adapters/index.ts` 导出
`getAdapter(protocol)` 与 `detectProtocol(baseUrl, modelHint?)`。

必须处理：

- openai：`/chat/completions`，`messages` 直传；SSE `data: {...}`，`choices[0].delta.content` 与 `delta.reasoning_content`，`delta.tool_calls[].function.arguments` 增量拼接，结尾 `data: [DONE]`。
- anthropic：`/v1/messages`，`system` 单独字段，`max_tokens` 必填；SSE 事件类型 `content_block_delta`（`text_delta` / `input_json_delta`）、`message_delta`（`stop_reason`、`usage`）。
- gemini：`/v1beta/models/{model}:streamGenerateContent?alt=sse`，`contents[].parts[].text`，`generationConfig`；`usageMetadata` 映射。
- 429/5xx 退避由调用方做，但 adapter 提供 `isRetryable(status)`。
- **「流断但 HTTP 200」**：SSE 正常结束标记缺失时，`parseSseLine` 不负责判定，调用方用 `finishReason` 是否到达来判断；
  adapter 必须在 `parseChatResponse`/聚合结果里保证 `finishReason` 缺失可辨别。解析器不许静默吞掉不认识的帧。

单测要求：每家一份「正常流」「reasoning 帧」「tool_calls 增量」「不认识的帧被忽略但不报错」「HTTP 200 但无完成标记」。

## 5. 质量门（合并前必须全绿）

```bash
npm ci
npm run verify        # typecheck + core 单测
```

- 每条 judge ≥1 正例 1 反例；新增 judge 必须同时补 `judge/coverage.test.ts` 的 19 类齐备断言（pit 首次提交时建立）。
- 判分逻辑出现第二份实现 → 直接拒合（D1）。
- 涉及行为的改动必须在 MR 描述写「影响面 / 复现命令 / 原始输出」。

## 6. 分支与合并顺序

- 分支：`feat/core-judges`、`feat/core-adapters`、`feat/web`、`feat/api-skeleton`；禁止直推 main。
- 合并顺序：`core 骨架（mike，已合）` → `judges` → `adapters` → `web` → `api`。
  后合的人先 `git rebase main`，冲突只改自己目录。
- 合入判据：`npm run verify` 绿 + mike 读完 diff + 无跨目录改动。
