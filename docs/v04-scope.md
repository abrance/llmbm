# llmbm v0.4 范围与接口契约（mike 定稿，2026-11-16）

v0.3.5 已把「能力测评 + F9/F10 弱信号」做稳。v0.4 只做三件事，**一个版本发 0.4.0**，不拆多个版本：
超时类用例与归因（wof）、ModelTrace 主动探针（mike core + wof 前端）、指纹排名参考库与闭集排名
（mike core、pit 数据流水线）。**探针与排名都是附加结论，不进能力分 / judge 分数。**

## 1. 目录所有权（ARCHITECTURE.md §1 的增补）

| 路径 | 所有者 | 内容 |
|---|---|---|
| `packages/core/src/fingerprint/model-trace/**` | mike | 探针挑战生成、解析、排名打分、参考库加载、闭集概率（纯函数；含 replay 回归与 fixture JSON） |
| `scripts/build-modeltrace-bank.mjs`、`scripts/modeltrace/**`、`packages/core/src/data/model-trace-bank/**` | pit | 上游 raw bank → 精简库抽取脚本与产物（库本体 + MANIFEST，v0.4 目录归属的明确例外）；`--check` 从源重建、`--verify-hash` 只校验仓内产物 |
| `apps/web/src/lib/latency.ts`、`latencyReport.ts`、`components/LatencyPanel.tsx` | wof | 超时/时延归因（纯展示统计，不进判分） |
| `apps/web/src/components/ModelTraceCard.tsx`、`apps/web/src/lib/modelTrace.ts` | wof | 探针结果卡片、导出段落、跑测页开关 |
| `packages/core/src/judge/rules/**` | pit | 本版**不新增** judge；超时不得变成扣分项 |

原 v0.3 的所有权继续有效。`packages/core/src/adapters/**` 仍归 pit，但**只放协议映射**；
探针/排名是「指纹」能力，放在 `fingerprint/**`（mike），复用 adapter 但不修改 adapter。

## 2. 优先级与合入顺序

| 顺序 | 事项 | 负责 | 分支 | 依赖 |
|---|---|---|---|---|
| 1 | 参考库 + 排名打分 + 探针请求通路（含目录归位到 `fingerprint/model-trace/**`） | pit（PR #23 返工） | `feat/model-trace-bank-and-probe` | 无 |
| 2 | core 收尾：闭集概率 + replay 回归（真实样本 top-1） | mike | `feat/v04-core-modeltrace` | 1 合入 |
| 3 | 超时类题库分组 + 结果页超时卡片 + ModelTrace 前端卡片 | wof | `feat/web-timeout-modeltrace` | 1、2 合入 |

**顺序理由**：参考库与打分是「数据 + 纯函数」，没有它探针结果无法解释；core 收尾补上验收要求的
真实数据回归；前端最后接入，避免接口两头改。三件事同版发 **0.4.0**，不单独发 patch。

## 3. 接口契约（不可违反）

### 3.1 超时类用例与归因（F14）

- 超时类用例：题库新增 `timeout` 分组（wof 维护 `packages/core/src/data/questions.json`），题目自带
  `timeoutMs` 预算与「首字慢 / 挂起 / 流式中段卡死 / 滴流 / 长输出超预算 / 短问答超时」标签；
  跑测页可单独勾选该组，只跑这一类。
- 归因分两层，**判定与分位数只有 core 一份**：`packages/core/src/timeout.ts` 的
  `classifyTimeout` / `percentile` / `latencyStats` / `summarizeTransport`（超时率分母 = 已发起且非用户取消，
  p50/p95 只统计成功完成）。web 侧 `apps/web/src/lib/latency.ts` 只组装 `verdict`
  （all-timeout / partial-timeout / slower-than-peers / normal）与文案，`timeoutReport.ts` 只做汇总与导出段落，
  不再自带阈值或第二份 `isTimeoutError`/分位数；只在 `response.error` 存在时计入。
- **不进 judge / 能力分**：超时仍按 D5 记为传输失败，从能力分聚合剔除；归因只进结果页卡片与导出。

### 3.2 ModelTrace 探针

- 探针请求参数固定对齐上游 `2c61f8f`：不发 `temperature`、`max_tokens: 8192`、
  每条探针独立 250000ms 超时（`ProbeSend` 收 `{ timeoutMs }`，由 web transport 实现）；
  文案只取一个 opening + 一个 action + rules + 一个 ending + 一个 separator + start。
- `runModelTraceProbe({ cfg, adapter, send, bank, signal, count?, seed?, timeoutMs? }) => Promise<ModelTraceResult>`
- 三条独立挑战，单条失败只记该条、永不抛出；`decision: 'insufficient' | 'partial' | 'ranked'`。
- **闭集概率**：`used>=3` 时给 `ranking[].probability` 与 `top.probability`（softmax(β×均值分)，β 取
  `bank.calibration[min(used,3)].beta`），并标注 `probabilityScope: 'reference-closed-set'`；
  `used<3` 时 `probability` 为 null，只给排名。闭集外模型一定被归到最相似的候选，UI 必须写明。
- 探针结果只出现在 `RunRecord.modelTrace`，`aggregate` / `judge` 都不读它；结果页必须同屏显示 `caveat`。
- `referenceAccuracy` 是参考库属性（`calibration[n].cv_accuracy`），**不是本次运行的置信度**；UI 禁止把它写成「本次置信度」。
- 跑测页开关默认**关闭**（三条约 300 个整数的长请求，额外耗时与费用由用户显式选择）。

### 3.3 排名参考库

- 只提交精简库（约 1.05MB，gzip 472KB），落在 `packages/core/src/data/model-trace-bank/`（pit 所有），
  头部 `provenance` 记
  `source_repo / source_commit / source_sha256 / license / license_copyright / built_at`；
  同目录 `MANIFEST.json` 记产物 sha256、上游 commit、算法名、探针参数与 calibration 1/2/3 的 beta+cv。
- 原始 14MB `unified_bank.json` 不入库；`node scripts/build-modeltrace-bank.mjs --check` 必须能从源重建同一 sha256；
  CI 门禁跑 `--verify-hash`（只校验仓内产物与 MANIFEST，不依赖原始库）。
- `replay-fixture.json`（70 模型 × 3 条真实样本，约 238KB）是回归测试数据，不是训练数据、不参与打分训练。

### 3.4 许可

- lm-detector / ModelTrace 均为 MIT（Copyright (c) 2026 xqy2006）；`THIRD_PARTY_NOTICES.md` 保留声明与来源 URL。
- 打分逻辑只在 `fingerprint/model-trace/scoring.ts` 一份（D1）；web/api 只从 `@llmbm/core` 引。

## 4. 验收口径（v0.4.0 发版门禁）

1. `npm run verify` 全绿（typecheck + lint + core/api/web 全部单测）。
2. `npm run build -w @llmbm/web` 通过。
3. **排名 replay 回归**：用参考库自带真实样本回放，top-1 命中率 ≥ 95%（本机实测 70/70 = 100%，见 PR 原始输出）；
   低于阈值即拒合。
4. **探针不污染能力分**：单测断言 `aggregate` 不读 modelTrace；结果页独立卡片 + caveat；开关关闭时零额外请求。
5. 超时类只出现在 `response.error` 的采样上：正常响应不产生超时类条目；超时不改任何分数。
6. 旧 IndexedDB 记录（无 modelTrace / timeout 字段）打开不报错，显示「本次未采集」。

## 5. 本轮不做（明确砍掉）

- 不做真实 Key 端到端（无凭据；用 replay 与 mock 验证）。
- 不做探针多语言随机模板（先固定中文模板，seed 可复现）。
- 不做「单次真实概率」的温度重训（`beta` 沿用上游 cv，标注为库属性）。
- 不改 `aggregate.ts` 既有口径，不为 modelTrace 新增总分字段。
