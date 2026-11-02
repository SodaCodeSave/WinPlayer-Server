# 后台 UI 与依赖在构建阶段装好，运行镜像只带产物与生产依赖
# 注意：better-sqlite3 是原生模块，必须在与运行镜像同为 Debian 的环境里安装

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 没有对应平台的预编译包时需要现编
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
WORKDIR /app
COPY tsconfig.json vite.config.mts ./
COPY src ./src
COPY web ./web
RUN npm run build \
 && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3456 \
    HOST=0.0.0.0
WORKDIR /app

# gosu 只做一件事：在入口脚本里从 root 降权到 node 后 exec。
# 用它而不是 su/sudo，是因为它能正确转发信号，容器 stop 时 node 能收到 SIGTERM。
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY package.json ./
COPY docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# 镜像内先建好并交给 node；但 ./data 绑定挂载会覆盖它，
# 所以真正的权限校正放在入口脚本里做（见 docker/entrypoint.sh 注释）。
# sed 是防御性的：仓库在 Windows 上检出时可能带 CRLF，带 \r 的 shebang
# 在容器里会直接报 “bad interpreter: /bin/sh^M”。
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data \
 && chown -R node:node /data

# 刻意不写 USER：入口脚本需要 root 才能修正被挂载目录的属主，
# 修正完立刻 gosu node 降权，实际业务进程始终是 uid 1000。
VOLUME ["/data"]
EXPOSE 3456
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
