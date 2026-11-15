# 第三方组件与许可声明（Third-Party Notices）

本仓库包含或改编了下列第三方作品，按其原始许可分发：

## ModelTrace 指纹排名（参考库与打分算法）

- **上游实现**：lm-detector — https://github.com/ikaleio/lm-detector
- **算法原理**：xqy2006/ModelTrace
- **许可**：MIT License
- **版权**：Copyright (c) 2026 xqy2006

本仓库包含的改编/派生内容：

1. `packages/core/src/fingerprint/model-trace/scoring.ts`
   —— 由 lm-detector 的 `shared/fingerprint-core.js` 忠实移植（TypeScript 重写，逻辑等价）。
2. `packages/core/src/fingerprint/model-trace/probe.ts`
   —— 探针文案模板池逐句对应 lm-detector `shared/challenge-browser.js` 的 `LANGUAGES.zh`；
   请求参数（不发 temperature / `max_tokens: 8192` / 250000ms 超时）对齐 `shared/completion-request.ts`。
   上游基准 commit：`2c61f8f`。
3. `packages/core/src/data/model-trace-bank/model-trace-bank.json`
   —— 由 lm-detector 的 `data/unified_bank.json` 抽取「打分必需字段」生成的精简参考库
   （源仓库 commit 与 sha256 见该文件头部 `provenance`；产物自身 sha256 与校准摘要见同目录 `MANIFEST.json`）。

上述文件均沿用 MIT 许可，全文副本见 [`LICENSES/lm-detector-MIT.txt`](LICENSES/lm-detector-MIT.txt)。
原始版权声明：

```
MIT License

Copyright (c) 2026 xqy2006

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
