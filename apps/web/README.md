# apps/web · 产品面与题库（wof 维护）

> 本文件是 llmbm v0.1 前端与题库的交付说明。范围：`apps/web/**` + `packages/core/src/data/**`；
> 判分实现归 mike/pit，本目录不复制任何判分逻辑（D1）。

## 1. 页面信息架构

| 页面 | 要解决的问题 | 关键交互 |
|---|---|---|
| 接入配置 `/connect` | 用户不知道自己填的地址能不能用、Key 会不会被服务端留存 | Base URL / Key / 模型 / 协议；拉模型列表；连通性测试；内置 Mock 一键体验；隐私边界说明。Key 只进 `localStorage`，导出与提交社区都不含 Key。 |
| 跑测 `/run` | 长任务不能卡死页面，断网/刷新不能白跑，跑错了要能停 | 6 个分组多选；seed 可复现；每题 1/3/5 次采样；计划题数/请求数/耗时预估；Web Worker 执行；实时进度（完成数、当前题、当前采样、已耗时、ETA）；真 abort 取消；IndexedDB 断点续跑；失败题补测。 |
| 结果 `/result` | 一个整数分数不足以判断「能不能用」 | 能力分 + 95% 区间（t 分布）；封顶 99 提示；维度条形；格式命中率；稳定性；问题探针（非 pass 题按分数升序，带原因）；证据链（每题 × 每次采样的原文、reasoning、tool_calls、检查项、HTTP/耗时/行重复率、原始 JSON）；导出 md / json；提交社区前明确列出公开与不公开字段。 |
| 社区 `/community` | 同域名/同模型的横向对比，且不能泄露提交者数据 | 按域名/模型筛选；榜单表；点击行看维度分与探针题号；空态/接口失败可恢复。 |

状态流转：`配置 → 跑测（running → done/cancelled）→ 结果 → 提交社区`。取消后保留断点；刷新后从 IndexedDB 恢复最近一次结果与断点。

## 2. 题库结构

文件：`packages/core/src/data/questions.json`（JSON 是唯一事实源，前端只读）。
题目字段严格按 spec §2.2；额外两个仅供演示端点的字段：`mock`（演示答案）与 `tools`（工具题的工具定义）。

| 分组 | 题数 | core 题 | 覆盖判定 | 这个组回答什么 |
|---|---:|---:|---|---|
| 基础 basic | 10 | 4 | exact, contains, number, fraction, json, json-schema, regex, unit-convert | 听得懂、答得出，最低门槛 |
| 能力 ability | 10 | 0 | json-schema, set, ordering, cite, unit-convert, long-output, format-json, exact, contains, number | 真实业务最常用的能力 |
| 对抗 adversarial | 8 | 2 | not-contains, refusal, conflict, regex, cite, exact | 会不会被诱导、自相矛盾、编造来源 |
| 耐久 endurance | 7 | 0 | long-output, exact, format-json, set, json, not-contains | 长输出是否退化、复读 |
| 进阶 advanced | 7 | 1 | function-call, tool-args, pelican-svg, json-schema, ordering, json | Agent 场景：工具选择与参数 |
| 精选补测 spotlight | 6 | 1 | function-call, tool-args, conflict, refusal, pelican-svg, exact | 高风险项上线前复核 |
| **合计** | **48** | **8** | **19 类全覆盖** | |

core 题（答错该题直接 0，§2.3）：`basic-exact-001`、`basic-contains-001`、`basic-json-001`、`basic-schema-001`、
`adv-not-001`、`adv-refusal-001`、`adv2-function-001`、`spot-refusal-001`。

题库版本由 `questionBankVersion()` 对 id/group/judge/expect/prompt 取指纹，写入每次结果与导出物（D6）。

## 3. 内置 Mock 端点

- 地址：`/__mock/v1`（Vite dev / preview 中间件，生产构建不包含）
- 模型：`mock-llmbm-pro`、`mock-llmbm-lite`
- 答案来源：题库的 `mock` 字段，按 `x-llmbm-question-id` 头匹配；延迟 25–80ms/次
- 故障注入：开启后 `basic-exact-002` 的第 2 次采样返回 `Cat`，用来演示区间、探针、单题重试与补测
- 它只是流程演示，不代表任何真实模型能力

## 4. 本地验收

```bash
npm ci
npm run build:core
npm run dev -w @llmbm/api          # 8787
npm run dev -w @llmbm/web          # 5173（被占用会自动换端口）
```

浏览器打开 web 端口 → 「用内置 Mock 直接体验」→ 开始跑测 → 结果 → 提交社区 → 社区榜单。

自动化校验：

```bash
npm run typecheck
npm run lint
npm test -w @llmbm/web             # 题库结构 + 进度/探针纯函数 + checkpoint + 传输层
npm run build -w @llmbm/web        # tsc + vite build（含 worker chunk）
```

## 5. 边界与未核

- **协议适配**：请求构造（URL / 请求体 / 鉴权头）与响应解析（非流式 JSON / SSE / usage / tool_calls）全部走 `packages/core/src/adapters/**`，`apps/web/src/lib/transport.ts` 只保留 fetch、超时、真取消、429/5xx 退避。三种协议都能跑；工具题受 core `ChatRequest` 尚无 `tools` 字段限制，目前只有 openai 协议透传 tools。
- **判定实现**：core 当前只注册了 `exact`。默认跑测会自动过滤掉未实现判定的题；打开「包含未上线判定」可核对题库，未实现判定会以 `registry：未知 judge: xxx` 出现在探针里。
- **已知 core 计分缺陷（待 mike 确认）**：硬检查失败（如 `registry`）先置 0 后，仍可能被「包装规整保底 85」抬回 85，导致未上线判定显示为「待复核 85」。位置 `packages/core/src/scoring/index.ts` 的 `wrapped` 分支；本目录未越界修改。
- **F9 家族指纹**：core 尚未提供指纹结果字段，结果页没有展示该卡片；等 core 契约补上再接。
- **Docker 镜像**：本地 daemon 镜像源不可用，未做镜像实构建；web 的 `vite build` 已通过。
