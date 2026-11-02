/**
 * 注册 / 登录 / 刷新 / 登出。
 *
 * 注册规则（三者叠加）：
 * 1. 库里还没有任何用户时，第一个注册的人直接成为管理员，且不受任何开关限制
 *    —— 否则新部署的服务器会陷入「没人能注册→没有管理员→打不开注册」的死锁；
 * 2. 之后由 `registration_open` 控制是否允许自主注册（管理后台一键开关）；
 * 3. 若打开 `invite_required`，注册还必须带一个未使用的邀请码。
 */

import type { FastifyInstance } from "fastify";
import { countUsers, db, getServerFlag, getServerSetting, setServerSetting } from "../db/index.js";
import { hashPassword, verifyPassword } from "../util/crypto.js";
import { publicUser, requireAuth } from "../auth/middleware.js";
import { issueTokens, revokeAllForUser, revokeRefresh, rotateRefresh, type UserRow } from "../auth/tokens.js";

const USERNAME_RE = /^[\w\-.@\u4e00-\u9fa5]{2,32}$/;

/** 登录失败限流（进程内，够用；重启清零） */
const failures = new Map<string, { count: number; until: number }>();

function tooManyAttempts(key: string): boolean {
  const entry = failures.get(key);
  if (!entry) return false;
  if (entry.until < Date.now()) {
    failures.delete(key);
    return false;
  }
  return entry.count >= 8;
}

function noteFailure(key: string): void {
  const entry = failures.get(key);
  const until = Date.now() + 5 * 60_000;
  if (!entry || entry.until < Date.now()) failures.set(key, { count: 1, until });
  else entry.count += 1;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** 服务器公开信息（客户端登录前要拿它显示服务器名 / 是否可注册） */
  app.get("/api/server/info", async () => {
    return {
      name: getServerSetting("server_name", "WinPlayer 同频服务器"),
      version: 1,
      registrationOpen: getServerFlag("registration_open", false),
      inviteRequired: getServerFlag("invite_required", false),
      needsFirstUser: countUsers() === 0,
      maxUploadBytes: Number(getServerSetting("max_upload_bytes", "0")) || 0,
    };
  });

  app.post("/api/auth/register", async (req, reply) => {
    const body = (req.body ?? {}) as {
      username?: string;
      password?: string;
      inviteCode?: string;
      device?: string;
    };
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    if (!USERNAME_RE.test(username)) {
      return reply.code(400).send({ error: "用户名需为 2–32 位字母、数字、下划线或中文" });
    }
    if (password.length < 6) {
      return reply.code(400).send({ error: "密码至少 6 位" });
    }

    const first = countUsers() === 0;
    if (!first) {
      if (!getServerFlag("registration_open", false)) {
        return reply.code(403).send({ error: "本站未开放注册，请联系管理员" });
      }
      if (getServerFlag("invite_required", false)) {
        const code = String(body.inviteCode ?? "").trim();
        if (!code) return reply.code(400).send({ error: "需要邀请码" });
        const invite = db.prepare("select * from invite_codes where code = ?").get(code) as
          | { code: string; used_by: number | null; created_at: number }
          | undefined;
        if (!invite || invite.used_by) {
          return reply.code(400).send({ error: "邀请码无效或已被使用" });
        }
      }
    }

    const exists = db.prepare("select id from users where username = ?").get(username);
    if (exists) return reply.code(409).send({ error: "用户名已被占用" });

    const now = Date.now();
    const info = db
      .prepare(
        "insert into users (username, password_hash, role, disabled, created_at) values (?, ?, ?, 0, ?)",
      )
      .run(username, hashPassword(password), first ? "admin" : "user", now);

    const userId = Number(info.lastInsertRowid);
    if (!first) {
      if (getServerFlag("invite_required", false)) {
        db.prepare("update invite_codes set used_by = ?, used_at = ? where code = ?").run(
          userId,
          now,
          String(body.inviteCode ?? "").trim(),
        );
      }
    } else if (!getServerSetting("server_name", "")) {
      setServerSetting("server_name", "WinPlayer 同频服务器");
    }

    const user = db.prepare("select * from users where id = ?").get(userId) as UserRow;
    const tokens = issueTokens(user, body.device ?? "");
    return { user: publicUser(user), ...tokens };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string; device?: string };
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    const limitKey = `${req.ip}:${username}`;
    if (tooManyAttempts(limitKey)) {
      return reply.code(429).send({ error: "尝试过于频繁，请 5 分钟后再试" });
    }

    const user = db.prepare("select * from users where username = ?").get(username) as
      | UserRow
      | undefined;
    if (!user || !verifyPassword(password, user.password_hash)) {
      noteFailure(limitKey);
      return reply.code(401).send({ error: "用户名或密码不正确" });
    }
    if (user.disabled) return reply.code(403).send({ error: "账号已被停用" });

    failures.delete(limitKey);
    db.prepare("update users set last_login_at = ? where id = ?").run(Date.now(), user.id);
    const tokens = issueTokens(user, body.device ?? "");
    return { user: publicUser(user), ...tokens };
  });

  app.post("/api/auth/refresh", async (req, reply) => {
    const body = (req.body ?? {}) as { refreshToken?: string; device?: string };
    const tokens = rotateRefresh(String(body.refreshToken ?? ""), body.device ?? "");
    if (!tokens) return reply.code(401).send({ error: "登录状态已失效，请重新登录" });
    return tokens;
  });

  app.post("/api/auth/logout", async (req) => {
    const body = (req.body ?? {}) as { refreshToken?: string };
    if (body.refreshToken) revokeRefresh(body.refreshToken);
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (req) => {
    const user = req.user as UserRow;
    return {
      user: publicUser(user),
      server: {
        name: getServerSetting("server_name", "WinPlayer 同频服务器"),
        registrationOpen: getServerFlag("registration_open", false),
      },
    };
  });

  /** 修改自己的密码（同时踢掉其它设备） */
  app.post("/api/auth/password", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user as UserRow;
    const body = (req.body ?? {}) as { current?: string; next?: string };
    if (!verifyPassword(String(body.current ?? ""), user.password_hash)) {
      return reply.code(400).send({ error: "当前密码不正确" });
    }
    if (String(body.next ?? "").length < 6) {
      return reply.code(400).send({ error: "新密码至少 6 位" });
    }
    db.prepare("update users set password_hash = ? where id = ?").run(
      hashPassword(String(body.next)),
      user.id,
    );
    revokeAllForUser(user.id);
    return { ok: true };
  });
}
