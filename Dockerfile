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
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY package.json ./
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3456
CMD ["node", "dist/index.js"]
