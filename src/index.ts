/**
 * 服务入口。
 *
 * 三个职责：
 * 1. 起 Fastify、挂路由；
 * 2. 全局的错误 → JSON 响应（客户端只需要读 `error` 字段）；
 * 3. 托管后台 UI 的静态文件（`web/dist`，构建产物），并把 `/admin/*` 落到 index.html
 *    以便前端路由接管。
 */

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";
import { authRoutes } from "./routes/auth.js";
import { trackRoutes } from "./routes/tracks.js";
import { syncRoutes } from "./routes/sync.js";
import { adminRoutes } from "./routes/admin.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  // 上传路由走原始流解析器（file size 由 media/storage 自己把关），
  // 这里的 bodyLimit 只影响 JSON 请求体
  bodyLimit: 8 * 1024 * 1024,
  trustProxy: true,
});

/**
 * 上传路由要把 body 当字节流处理，而不是先缓冲成 Buffer/字符串。
 * 不传 `parseAs` 时 Fastify 交给我们的就是 Readable。
 */
app.addContentTypeParser(
  /^(audio\/.+|application\/octet-stream)$/,
  {},
  (_req, payload, done) => done(null, payload),
);

app.get("/api/health", async () => ({ ok: true, server: "winplayer-server", version: 1 }));

await app.register(authRoutes);
await app.register(trackRoutes);
await app.register(syncRoutes);
await app.register(adminRoutes);

/* ------------------------------ 后台 UI ------------------------------ */

const webRoot = path.resolve(here, "../web/dist");
if (fs.existsSync(webRoot)) {
  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: "/admin/",
    // 不要用 wildcard:false —— 那样启动时会把当时的文件名固化成路由，
    // 重新构建（文件名带 hash）后新资源就 404 了
    wildcard: true,
    index: ["index.html"],
  });

  app.get("/", async (_req, reply) => reply.redirect("/admin/"));

  // 前端是 SPA：非静态资源请求一律回 index.html
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/admin")) {
      return reply.type("text/html").send(fs.createReadStream(path.join(webRoot, "index.html")));
    }
    return reply.code(404).send({ error: "接口不存在" });
  });
} else {
  app.get("/", async () => ({
    ok: true,
    hint: "后台 UI 未构建。开发时用 `npm run web:dev`，生产镜像会自动构建。",
  }));
}

/* ------------------------------ 错误处理 ------------------------------ */

app.setErrorHandler(async (error, req, reply) => {
  const status = (error as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) req.log.error(error);
  const message =
    status >= 500 ? "服务器内部错误" : (error as Error).message || "请求失败";
  await reply.code(status).send({ error: message });
});

async function shutdown(signal: string): Promise<void> {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: env.port, host: env.host });
app.log.info(`data dir: ${env.dataDir}`);
