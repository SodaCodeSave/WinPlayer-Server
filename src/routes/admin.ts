/**
 * 管理后台 API（全部要求 `role = admin`）。
 *
 * 后台能看到所有人的曲库，但不能替用户改数据（除了删除/清理），
 * 以免「管理员顺手改了一首歌的名字」这种难以追溯的事情发生。
 */

import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { currentSeq, db, getServerFlag, getServerSetting, setServerSetting, userUsedBytes } from "../db/index.js";
import { env } from "../env.js";
import { publicUser, requireAdmin } from "../auth/middleware.js";
import { hashPassword, randomToken } from "../util/crypto.js";
import { revokeAllForUser, type UserRow } from "../auth/tokens.js";
import { coverPath, blobPath } from "../media/storage.js";
import { toCloudTrack, type TrackRow } from "../types.js";

/** 递归统计目录占用 */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await fsp.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/overview", { preHandler: requireAdmin }, async () => {
    const users = db.prepare("select count(*) as n from users").get() as { n: number };
    const disabled = db.prepare("select count(*) as n from users where disabled = 1").get() as {
      n: number;
    };
    const tracks = db
      .prepare("select count(*) as n, coalesce(sum(size), 0) as bytes from tracks where deleted_at is null")
      .get() as { n: number; bytes: number };
    const trash = db
      .prepare("select count(*) as n from tracks where deleted_at is not null")
      .get() as { n: number };

    return {
      users: users.n,
      disabledUsers: disabled.n,
      tracks: tracks.n,
      libraryBytes: tracks.bytes,
      trashCount: trash.n,
      diskBytes: await dirSize(env.dataDir),
      cursor: currentSeq(),
      serverName: getServerSetting("server_name", "WinPlayer 音乐云"),
      registrationOpen: getServerFlag("registration_open", false),
      inviteRequired: getServerFlag("invite_required", false),
      quotaBytes: env.userQuotaBytes,
    };
  });

  /* ------------------------------ 用户 ------------------------------ */

  app.get("/api/admin/users", { preHandler: requireAdmin }, async () => {
    const rows = db
      .prepare(
        `select u.*, (select count(*) from tracks t where t.user_id = u.id and t.deleted_at is null) as track_count
           from users u order by u.id asc`,
      )
      .all() as Array<UserRow & { track_count: number }>;
    return {
      users: rows.map((row) => ({
        ...publicUser(row),
        trackCount: row.track_count,
        usedBytes: userUsedBytes(row.id),
      })),
    };
  });

  app.post("/api/admin/users", { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string; role?: string };
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    if (username.length < 2) return reply.code(400).send({ error: "用户名太短" });
    if (password.length < 6) return reply.code(400).send({ error: "密码至少 6 位" });
    if (db.prepare("select id from users where username = ?").get(username)) {
      return reply.code(409).send({ error: "用户名已存在" });
    }
    const role = body.role === "admin" ? "admin" : "user";
    const info = db
      .prepare(
        "insert into users (username, password_hash, role, disabled, created_at) values (?, ?, ?, 0, ?)",
      )
      .run(username, hashPassword(password), role, Date.now());
    const user = db
      .prepare("select * from users where id = ?")
      .get(Number(info.lastInsertRowid)) as UserRow;
    return { user: publicUser(user) };
  });

  app.patch("/api/admin/users/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const self = req.user as UserRow;
    const id = Number((req.params as { id: string }).id);
    const target = db.prepare("select * from users where id = ?").get(id) as UserRow | undefined;
    if (!target) return reply.code(404).send({ error: "用户不存在" });

    const body = (req.body ?? {}) as { role?: string; disabled?: boolean; password?: string; username?: string };

    // 不允许把最后一个管理员降级或停用，否则后台就锁死了
    const adminCount = (
      db.prepare("select count(*) as n from users where role = 'admin' and disabled = 0").get() as {
        n: number;
      }
    ).n;
    const losingAdmin =
      target.role === "admin" &&
      ((body.role === "user") || body.disabled === true) &&
      adminCount <= 1;
    if (losingAdmin) return reply.code(400).send({ error: "至少要保留一个可用的管理员" });
    if (target.id === self.id && body.disabled === true) {
      return reply.code(400).send({ error: "不能停用自己的账号" });
    }

    const fields: string[] = [];
    const params: unknown[] = [];
    if (body.role === "admin" || body.role === "user") {
      fields.push("role = ?");
      params.push(body.role);
    }
    if (typeof body.disabled === "boolean") {
      fields.push("disabled = ?");
      params.push(body.disabled ? 1 : 0);
    }
    if (typeof body.username === "string" && body.username.trim()) {
      fields.push("username = ?");
      params.push(body.username.trim());
    }
    if (typeof body.password === "string" && body.password.length >= 6) {
      fields.push("password_hash = ?");
      params.push(hashPassword(body.password));
    }
    if (!fields.length) return { user: publicUser(target) };

    params.push(id);
    db.prepare(`update users set ${fields.join(", ")} where id = ?`).run(...params);
    if (typeof body.password === "string" || body.disabled === true) revokeAllForUser(id);

    const updated = db.prepare("select * from users where id = ?").get(id) as UserRow;
    return { user: publicUser(updated) };
  });

  app.delete("/api/admin/users/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const self = req.user as UserRow;
    const id = Number((req.params as { id: string }).id);
    if (id === self.id) return reply.code(400).send({ error: "不能删除自己的账号" });
    const target = db.prepare("select * from users where id = ?").get(id) as UserRow | undefined;
    if (!target) return reply.code(404).send({ error: "用户不存在" });
    db.prepare("delete from users where id = ?").run(id);
    return { ok: true };
  });

  /* ------------------------------ 服务器设置 ------------------------------ */

  app.get("/api/admin/settings", { preHandler: requireAdmin }, async () => ({
    serverName: getServerSetting("server_name", "WinPlayer 音乐云"),
    registrationOpen: getServerFlag("registration_open", false),
    inviteRequired: getServerFlag("invite_required", false),
    quotaBytes: env.userQuotaBytes,
    maxUploadBytes: env.maxUploadBytes,
  }));

  app.patch("/api/admin/settings", { preHandler: requireAdmin }, async (req) => {
    const body = (req.body ?? {}) as {
      serverName?: string;
      registrationOpen?: boolean;
      inviteRequired?: boolean;
    };
    if (typeof body.serverName === "string" && body.serverName.trim()) {
      setServerSetting("server_name", body.serverName.trim().slice(0, 60));
    }
    if (typeof body.registrationOpen === "boolean") {
      setServerSetting("registration_open", body.registrationOpen ? "1" : "0");
    }
    if (typeof body.inviteRequired === "boolean") {
      setServerSetting("invite_required", body.inviteRequired ? "1" : "0");
    }
    return {
      serverName: getServerSetting("server_name", "WinPlayer 音乐云"),
      registrationOpen: getServerFlag("registration_open", false),
      inviteRequired: getServerFlag("invite_required", false),
    };
  });

  /* ------------------------------ 邀请码 ------------------------------ */

  app.get("/api/admin/invites", { preHandler: requireAdmin }, async () => {
    const rows = db
      .prepare(
        `select i.*, u.username as used_by_name from invite_codes i
           left join users u on u.id = i.used_by order by i.created_at desc limit 200`,
      )
      .all() as Array<Record<string, unknown>>;
    return {
      invites: rows.map((row) => ({
        code: row.code,
        createdAt: row.created_at,
        usedBy: row.used_by_name ?? null,
        usedAt: row.used_at ?? null,
      })),
    };
  });

  app.post("/api/admin/invites", { preHandler: requireAdmin }, async (req) => {
    const self = req.user as UserRow;
    const body = (req.body ?? {}) as { count?: number };
    const count = Math.min(Math.max(Number(body.count ?? 1) || 1, 1), 20);
    const created: string[] = [];
    const now = Date.now();
    for (let index = 0; index < count; index += 1) {
      const code = randomToken(9).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12).toUpperCase();
      db.prepare("insert or ignore into invite_codes (code, created_by, created_at) values (?, ?, ?)").run(
        code,
        self.id,
        now,
      );
      created.push(code);
    }
    return { created };
  });

  app.delete("/api/admin/invites/:code", { preHandler: requireAdmin }, async (req) => {
    db.prepare("delete from invite_codes where code = ?").run((req.params as { code: string }).code);
    return { ok: true };
  });

  /* ------------------------------ 曲库 ------------------------------ */

  app.get("/api/admin/tracks", { preHandler: requireAdmin }, async (req) => {
    const query = req.query as { userId?: string; limit?: string; offset?: string; q?: string };
    const userId = Number(query.userId ?? 0) || 0;
    const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
    const keyword = String(query.q ?? "").trim();

    const where: string[] = ["t.deleted_at is null"];
    const params: unknown[] = [];
    if (userId) {
      where.push("t.user_id = ?");
      params.push(userId);
    }
    if (keyword) {
      where.push("(t.title like ? or t.artist like ? or t.album like ?)");
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    const rows = db
      .prepare(
        `select t.*, u.username from tracks t join users u on u.id = t.user_id
          where ${where.join(" and ")} order by t.created_at desc limit ? offset ?`,
      )
      .all(...params, limit, offset) as Array<TrackRow & { username: string }>;
    const total = db
      .prepare(`select count(*) as n from tracks t where ${where.join(" and ")}`)
      .get(...params) as { n: number };

    return {
      total: total.n,
      tracks: rows.map((row) => ({ ...toCloudTrack(row), userId: row.user_id, username: row.username })),
    };
  });

  /** 彻底删除（物理删行；文件交给 gc 回收） */
  app.delete("/api/admin/tracks/:userId/:hash", { preHandler: requireAdmin }, async (req) => {
    const { userId, hash } = req.params as { userId: string; hash: string };
    db.prepare("delete from tracks where user_id = ? and hash = ?").run(Number(userId), hash);
    return { ok: true };
  });

  /** 清理回收站（物理删掉软删除的行） */
  app.post("/api/admin/trash/purge", { preHandler: requireAdmin }, async () => {
    const info = db.prepare("delete from tracks where deleted_at is not null").run();
    return { removed: info.changes };
  });

  /** 清理未引用文件：磁盘上有、但没有任何 tracks 行指向的音频与封面 */
  app.post("/api/admin/gc", { preHandler: requireAdmin }, async () => {
    const referenced = new Set(
      (db.prepare("select hash, ext from tracks").all() as Array<{ hash: string; ext: string }>).map(
        (row) => `${row.hash}.${row.ext}`,
      ),
    );
    const referencedCovers = new Set(
      (
        db
          .prepare("select distinct cover_hash as h, cover_ext as e from tracks where cover_hash <> ''")
          .all() as Array<{ h: string; e: string }>
      ).map((row) => `${row.h}.${row.e || "jpg"}`),
    );

    let removed = 0;
    let freed = 0;
    const walk = async (root: string, keep: Set<string>, suffixOf: (name: string) => boolean) => {
      const shards = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const shard of shards) {
        if (!shard.isDirectory()) continue;
        const dir = path.join(root, shard.name);
        const files = await fsp.readdir(dir).catch(() => []);
        for (const file of files) {
          if (!suffixOf(file)) continue;
          const key = file;
          if (keep.has(key)) continue;
          const full = path.join(dir, file);
          const size = (await fsp.stat(full).catch(() => ({ size: 0 }))).size;
          await fsp.rm(full, { force: true });
          removed += 1;
          freed += size;
        }
      }
    };

    await walk(env.musicDir, referenced, (name) => /\.(mp3|flac|m4a|mp4|m4b|aac|ogg|oga|wav)$/i.test(name));
    await walk(env.coverDir, referencedCovers, (name) => /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(name));

    // 临时目录里的残渣（进程被杀留下的半截文件）
    const temps = await fsp.readdir(env.tmpDir).catch(() => []);
    for (const file of temps) {
      await fsp.rm(path.join(env.tmpDir, file), { force: true });
    }

    return { removed, freedBytes: freed };
  });

  /** 触发一次数据库检查点，方便运维在备份前把 WAL 落盘 */
  app.post("/api/admin/checkpoint", { preHandler: requireAdmin }, async () => {
    db.pragma("wal_checkpoint(TRUNCATE)");
    return { ok: true, dbBytes: fs.statSync(env.dbFile).size };
  });

  /** 用户自己的曲目（后台「我的」页复用同一接口，省一份实现） */
  app.get("/api/admin/me/quota", { preHandler: requireAdmin }, async (req) => {
    const user = req.user as UserRow;
    return { usedBytes: userUsedBytes(user.id), quotaBytes: env.userQuotaBytes };
  });
}

/** 供其它模块复用的封面路径（避免重复 import 顺序问题） */
export { coverPath, blobPath };
