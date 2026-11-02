/**
 * 鉴权中间件。
 *
 * token 可以从两个地方来：
 * - `Authorization: Bearer <token>`（客户端所有 API 与原生解码器的 Range 请求都走这个）；
 * - `?token=<token>`（`<img src>` 拿封面时没法自定义请求头，只能用 query）。
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db/index.js";
import { verifyAccessToken } from "../util/crypto.js";
import type { UserRow } from "./tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: UserRow;
  }
}

export function tokenFromRequest(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header && /^bearer /i.test(header)) return header.slice(7).trim();
  const query = req.query as Record<string, unknown> | undefined;
  const fromQuery = query?.token;
  if (typeof fromQuery === "string" && fromQuery) return fromQuery;
  return null;
}

/** 路由级 preHandler：校验 access token 并挂上 `req.user` */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = tokenFromRequest(req);
  if (!token) {
    await reply.code(401).send({ error: "未登录" });
    return;
  }
  const payload = verifyAccessToken(token);
  if (!payload) {
    await reply.code(401).send({ error: "登录已过期，请重新登录" });
    return;
  }
  const user = db.prepare("select * from users where id = ?").get(payload.uid) as
    | UserRow
    | undefined;
  if (!user || user.disabled) {
    await reply.code(401).send({ error: "账号不可用" });
    return;
  }
  req.user = user;
}

/** 管理员专用 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (req.user?.role !== "admin") {
    await reply.code(403).send({ error: "需要管理员权限" });
  }
}

export function publicUser(user: UserRow) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  };
}
