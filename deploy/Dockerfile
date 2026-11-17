# llmbm 单镜像（spec §7）：一个进程同时托管 api 与前端产物
# 镜像名由 CI 的 GITHUB_REPOSITORY 决定；本地 compose 使用 llmbm:local
# 构建上下文是仓库根（npm workspaces 需要根 lockfile）
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @llmbm/core --workspace @llmbm/api --workspace @llmbm/web --include-workspace-root

COPY packages/core packages/core
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build -w @llmbm/core \
 && npm run build -w @llmbm/api \
 && npm run build -w @llmbm/web

FROM node:24-alpine AS runtime
WORKDIR /app
# 运行时只装 core + api 的生产依赖：web 的 antd/vite/rollup 不进镜像（prune 会保留，故重装）
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev --workspace @llmbm/core --workspace @llmbm/api --include-workspace-root \
 && npm cache clean --force
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    LLMBM_DB=/data/llmbm.db \
    WEB_ROOT=/app/apps/web/dist
# 非 root 运行
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown -R app:app /data
COPY --from=build --chown=app:app /repo/packages/core/dist ./packages/core/dist
COPY --from=build --chown=app:app /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=app:app /repo/apps/web/dist ./apps/web/dist
USER app
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
