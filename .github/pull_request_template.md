## 改了什么

<!-- 一句话说清；多层改动分条。 -->

## 归属检查（合入必过）

- [ ] 只改了本 PR 声明范围内的目录（见 `ARCHITECTURE.md` §6 目录所有权）
- [ ] 没有在 core 之外再写一份判分/采样/打分实现（D1）
- [ ] 没有新增运行时依赖（core 必须零运行时依赖）
- [ ] 契约类型（`types.ts`）如需变更，已在群里报备并由 mike 改

## 验收证据（贴原始输出，不要摘要）

```bash
npm ci && npm run verify
```

```
<把 core / api / web 的 tests / pass / fail 三行原样贴在这里>
```

- [ ] `npm run verify` 全绿（typecheck + lint + test，缺一不可）
- [ ] 涉及前端：`npm run build -w @llmbm/web` 通过

## 未核 / 遗留

<!-- 没跑过的、没数据的、需要真实 Key 的，逐条写清。没有就写「无」。 -->
