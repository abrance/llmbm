# ModelTrace 参考库构建（构建脚本说明）

`scripts/build-modeltrace-bank.mjs` 从 lm-detector 的原始 `unified_bank.json` 抽取「指纹排名打分必需字段」，
生成入库用的两个文件（都在 `packages/core/src/data/model-trace-bank/`，该目录由 data 维护者维护）：

- `model-trace-bank.json` —— 精简参考库本体（约 1.05MB）
- `MANIFEST.json` —— 产物 sha256、上游 commit、算法名、探针参数、calibration 1/2/3 的 beta+cv

- 上游：https://github.com/ikaleio/lm-detector （MIT, Copyright (c) 2026 xqy2006，
  全文见仓库根 `LICENSES/lm-detector-MIT.txt`）
- 原始 14MB 库**不入库**；仓库只保留精简库，头部 `provenance` 记录来源 commit / sha256 / license。

## 用法

```bash
# 用默认路径（会依次尝试 MODELTRACE_SRC、upstream/lm-detector/data/、/tmp/lmdet/data/）
node scripts/build-modeltrace-bank.mjs

# 指定原始库位置（离线可重跑）
node scripts/build-modeltrace-bank.mjs --source /path/to/lm-detector/data/unified_bank.json
MODELTRACE_SRC=/path/to/unified_bank.json node scripts/build-modeltrace-bank.mjs

# 只校验：现有精简库能否被重建为逐字节一致的 sha256（需要原始库）
node scripts/build-modeltrace-bank.mjs --check

# 只校验仓内产物：库的 sha256 与 MANIFEST 记录一致（不需要原始库，CI 门禁跑这个）
node scripts/build-modeltrace-bank.mjs --verify-hash
```

同一份输入两次运行，输出逐字节一致（纯抽取、不重算、不联网）。若引入浮点重算请勿加入此脚本，
否则 sha256 不再稳定。改探针参数（`max_tokens` / `timeout_ms` / 模型模板来源）必须同步改脚本里的
`PROBE` 常量与 `packages/core/src/fingerprint/model-trace/probe.ts`，两边不一致单测会拦。
