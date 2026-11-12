# llmbm

LLM API 中转站可信度检测工作台。填 Base URL + Key + 模型 ID，跑一套题，得到**能力分 ± 半宽**、
各维度分、问题探针与可导出的证据链；结果可提交社区做横向对比。

对标 [apitest.work](https://www.apitest.work/)，功能面对齐，工程质量必须更高 —— 差异见 `docs/SPEC.md` §3 的 D1~D6。

## 快速开始

需要 Node 24+（`node:sqlite` 是内置的，无需额外数据库）。

```bash
npm ci
npm run verify        # typecheck + lint + 全部单测
```

本地起前后端（两个终端）：

```bash
npm run dev -w @llmbm/api     # http://127.0.0.1:8787
npm run dev -w @llmbm/web     # http://127.0.0.1:5173（已代理 /api）
```

生产构建与容器：

```bash
npm run build
docker compose up -d --build   # 单镜像（api 托管前端）→ http://127.0.0.1:8080
```

> v0.1 阶段只在本机做功能验收（spec §7）：deploy/ 就是本机 compose，够用即停。
> 不搭 CDN / 多环境 / 域名证书，也不随 main 推送自动构建镜像（`.github/workflows/build.yml` 仅手动触发，默认只验证构建、不推 GHCR）。
> 云环境部署等 v0.1 验收通过后由 mike 协调运维执行，形态是 cops 单元 `apps/llmbm/` 部署到 cloud3（k3s）。

## 目录

```
packages/core/         判分内核，零运行时依赖，前后端共用（唯一一份实现，D1）
  src/judge/           19 类判定：registry + rules/<kind>.ts
  src/adapters/        openai / anthropic / gemini 请求体与 SSE 归一化
  src/scoring/         单题打分（§2.3）+ 区间（D3）
  src/sampling/        确定性抽样（seed → 同一套题）
  src/data/            题库 JSON（wof）
apps/web/              React 18 + Vite + antd，纯前端跑测（Key 不出浏览器，D4）
apps/api/              Fastify：/api/models、/api/proxy（SSE 透传）、/api/community/*，生产态托管 apps/web/dist
  src/plugins/guard    D5 代理护栏：目标校验 / 并发上限 / 超时 / body 上限
  src/repo/            唯一碰 SQL 的一层（一套 SQL + 两个瘦驱动：Postgres / SQLite，按 LLMBM_PG_URL 选）
deploy/                Dockerfile（单镜像：api 进程内托管前端产物，同源免 CORS）
docs/SPEC.md           产品规格与架构基线（sor，v0.1）
ARCHITECTURE.md        接口契约与目录所有权（mike）
```

## 隐私与代理（D4/D5）

- API Key 只进浏览器内存与 `localStorage`；服务端不落 Key、不落请求体、不写进日志。
- 走服务端代理必须在界面上显式允许；代理只放行白名单请求头，拒绝私网、回环与云元数据地址
  （`169.254.169.254` 等），有并发上限与单请求超时。

## 贡献

分支 + MR，禁止直推 main。合并前 `npm run verify` 必须全绿，MR 描述写清**影响面 / 复现命令 / 原始输出**。
目录所有权与合并顺序见 `ARCHITECTURE.md` §1、§6。
