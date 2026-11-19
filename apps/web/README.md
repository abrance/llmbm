# apps/web · 产品面与题库

> 本文件是 llmbm v0.1 前端与题库的交付说明。范围：`apps/web/**` + `packages/core/src/data/**`；
> 判分实现归 `@llmbm/core`，本目录不复制任何判分逻辑（D1）。

## 1. 页面信息架构

| 页面                | 要解决的问题                                           | 关键交互                                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 接入配置 `/connect` | 用户不知道自己填的地址能不能用、Key 会不会被服务端留存 | Base URL / Key / 模型 / 协议；拉模型列表；连通性测试；内置 Mock 一键体验（仅 dev）；隐私边界说明。Key 只进 `localStorage`，导出与提交社区都不含 Key。                                                                                                                  |
| 跑测 `/run`         | 长任务不能卡死页面，断网/刷新不能白跑，跑错了要能停    | 6 个分组多选；seed 可复现；每题 1/3/5 次采样；计划题数/请求数/耗时预估；Web Worker 执行；实时进度（完成数、当前题、当前采样、已耗时、ETA）；真 abort 取消；IndexedDB 断点续跑；失败题补测。                                                                            |
| 结果 `/result`      | 一个整数分数不足以判断「能不能用」                     | 能力分 + 95% 区间（t 分布）；封顶 99 提示；维度条形；格式命中率；稳定性；问题探针（非 pass 题按分数升序，带原因）；证据链（每题 × 每次采样的原文、reasoning、tool_calls、检查项、HTTP/耗时/行重复率、原始 JSON）；导出 md / json；提交社区前明确列出公开与不公开字段。 |
| 社区 `/community`   | 同域名/同模型的横向对比，且不能泄露提交者数据          | 按域名/模型筛选；榜单表；点击行看维度分与探针题号；空态/接口失败可恢复。                                                                                                                                                                                               |

状态流转：`配置 → 跑测（running → done/cancelled）→ 结果 → 提交社区`。取消后保留断点；刷新后从 IndexedDB 恢复最近一次结果与断点。

## 2. 题库结构

文件：`packages/core/src/data/questions.json`（JSON 是唯一事实源，前端只读）。
题目字段严格按 spec §2.2；额外两个仅供演示端点的字段：`mock`（演示答案）与 `tools`（工具题的工具定义）。

| 分组                   |   题数 | core 题 | 覆盖判定                                                                                          | 这个组回答什么                                                                                                                                         |
| ---------------------- | -----: | ------: | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 基础 basic             |     10 |       4 | exact, contains, number, fraction, json, json-schema, regex, unit-convert                         | 听得懂、答得出，最低门槛                                                                                                                               |
| 能力 ability           |     11 |       0 | json-schema, set, ordering, cite, unit-convert, long-output, format-json, exact, contains, number | 真实业务最常用的能力                                                                                                                                   |
| 对抗 adversarial       |      8 |       2 | not-contains, refusal, conflict, regex, cite, exact                                               | 会不会被诱导、自相矛盾、编造来源                                                                                                                       |
| 耐久 endurance         |      7 |       0 | long-output, exact, format-json, set, json, not-contains                                          | 长输出是否退化、复读                                                                                                                                   |
| 进阶 advanced          |      8 |       1 | function-call, tool-args, pelican-svg, json-schema, ordering, json                                | Agent 场景：工具选择与参数                                                                                                                             |
| 精选补测 spotlight     |      6 |       1 | function-call, tool-args, conflict, refusal, pelican-svg, exact                                   | 高风险项上线前复核                                                                                                                                     |
| 上下文与参数 context   |     15 |       2 | regex, exact, json, max-tokens, contains, refusal                                                 | 丢 system、丢历史、假长上下文、忽略 max_tokens、丢图片、误杀拒答                                                                                       |
| 超时与响应时延 timeout |     10 |       0 | exact, long-output, contains                                                                      | 首字慢、彻底挂起、流式卡死、滴流、长输出超预算、短问答超时、长尾 p95、并发（人工复核）。**全部 weight=0 + diagnostic：只诊断，不计能力分，默认不勾选** |
| **合计**               | **75** |  **10** | **20 类全覆盖**                                                                                   |                                                                                                                                                        |

core 题（答错该题直接 0，§2.3）：`basic-exact-001`、`basic-contains-001`、`basic-json-001`、`basic-schema-001`、
`adv-not-001`、`adv-refusal-001`、`adv2-function-001`、`spot-refusal-001`、
`ctx-history-001`、`ctx-needle-001`。

每题另有 `description`（这题测什么，判分不读它），在「题库与用例」页与证据链里展示；
上下文（多轮 / 长文档注入 / 图片 / 参数）由 core 的 `summarizeQuestion` 从真正发出的消息推导，
界面不允许另写一份说明。

题库版本由 `questionBankVersion()` 对 id/group/judge/expect/prompt 取指纹，写入每次结果与导出物（D6）。

## 3. 内置 Mock 端点

- 地址：`/__mock/v1`（Vite dev / preview 中间件）
- 页面入口只在 `import.meta.env.DEV` 下渲染；生产构建（api 托管 dist）不显示入口，也没有这个端点
- 模型：`mock-llmbm-pro`、`mock-llmbm-lite`
- 答案来源：题库的 `mock` 字段，按 `x-llmbm-question-id` 头匹配；延迟 25–80ms/次
- 故障注入：`x-llmbm-inject: flaky`（跑测页开关）下 `basic-exact-002` 的第 2 次采样返回 `Cat`，并给超时组按题映射坏法；
  `x-llmbm-fault: slow-first | hang | stall | drip | long-output` 可显式指定（首字 3.2s / 永不返回 /
  两片后停住 / 700ms 一片 / 小片慢吐），只注入第一次采样，同一请求可复现。单测用真实 http server 跑
  slow-first、stall、hang 三条 E2E（`src/lib/transport.mock.test.ts`）
- 它只是流程演示，不代表任何真实模型能力

## 4. 本地验收

```bash
npm ci
npm run build:core
npm run dev -w @llmbm/api          # 8787
npm run dev -w @llmbm/web          # 5173（被占用会自动换端口）
```

浏览器打开 web 端口 → 「用内置 Mock 直接体验」→ 开始跑测 → 结果 → 提交社区 → 社区榜单。

生产构建校验：

```bash
npm run build
docker compose up -d --build
```

打开 `http://127.0.0.1:8080/connect` 不应出现「用内置 Mock 直接体验」；`GET /__mock/v1/models`
必须返回 404 JSON，不能是 SPA 的 `text/html` 200。

自动化校验：

```bash
npm run typecheck
npm run lint
npm test -w @llmbm/web             # 题库结构 + 进度/探针纯函数 + checkpoint + 传输层
npm run build -w @llmbm/web        # tsc + vite build（含 worker chunk）
```

## 5. 边界与未核

- **协议适配**：请求构造（URL / 请求体 / 鉴权头）与响应解析（非流式 JSON / SSE / usage / tool_calls）全部走 `packages/core/src/adapters/**`，`apps/web/src/lib/transport.ts` 只保留 fetch、超时、真取消、429/5xx 退避。三种协议的工具声明都由 core 映射（`ChatRequest.tools`：openai 原样透传、anthropic `input_schema`、gemini `functionDeclarations`），web 侧不再按协议改写请求体。
- **判定实现**：core 已注册全部 20 类 judge（`missingJudges()` 返回空数组），题库 49 题都跑在真实判定上；「包含未上线判定」开关只作为核对题库的兜底。
- **计分**：硬检查失败 / core 题未全对先置 0，`wrapped` 保底只在「有内容、非硬失败、非参数错」时生效，0 分不会再被抬回 85（`packages/core/src/scoring/index.ts`，dc67f52）。
- **超时与响应时延（v0.4）**：分类与分位数只走 core 契约（`classifyTimeout` / `percentile` / `latencyStats` / `summarizeTransport`），web 不写第二份；`lib/latency.ts` 只组装可读结论，`lib/latencyReport.ts` 补题库元数据与「取消/未发起」分母，结果页 `LatencyPanel` 与 Markdown 导出共用这一份。超时率分母 = 已发起且非用户取消；p50/p95/max 只统计成功完成；超时按环节归因（连接/响应前、首字前、流式中段）；429/5xx 记「其他传输失败」。transport 在超时/断流时回传 `ttftMs/chunks/lastChunkAtMs/phase/attempts`，attempt 级明细与逻辑采样分开。诊断题在聚合前剔除（`lib/aggregateRun.ts`），不进能力分与问题探针。
- **F9 家族指纹 / F10 退化检测**：core 提供 `runSignalsOf()`（一次跑测的指纹 + 退化汇总），特征与阈值全在 `packages/core/src/fingerprint/index.ts`；web 只做「按题分组 + 剔除传输失败采样」后调用，不再自己算一份。两者都是**弱信号**：`weak:true` + `caveat` 必与数值同屏，`confidence` 不是降智概率。**基线尚未持久化**，所以 `verdict` 恒为 `insufficient-data`，只能看本次形态、不能判定「换了模型」。
- **Docker 镜像**：`deploy/Dockerfile` 单镜像已实构建并在本机 8080 验收（`docker compose up -d --build`）；CI 的 `build.yml` 为手动触发，默认只验证构建、不推 GHCR。
