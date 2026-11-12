/**
 * 构建期能力开关（D3）。
 * 内置 Mock 端点只由 Vite dev / preview 中间件提供；生产构建由 api 进程托管 dist，
 * 没有 /__mock 端点。因此页面入口只在 dev 下渲染，避免生产环境出现点进去必然 404 的 CTA。
 */
export const MOCK_AVAILABLE = import.meta.env.DEV;
