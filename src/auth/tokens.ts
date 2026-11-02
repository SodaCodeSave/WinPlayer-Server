/**
 * 登录态：refresh token 的签发、轮换与吊销。
 *
 * 为什么 refresh token 要落库：access token 是无状态的（1 小时），要「远程踢掉
 * 某台设备」只能靠 refresh 这一层 —— 库里标 revoked 后，该设备下次刷新就失败。
 * 每次刷新都轮换（旧的立即作废），被偷的 token 只能用一次。
 */

import { db } from "../db/index.js";
import { env } from "../env.js";
import { randomToken, sha256Hex, signAccessToken } from "../util/crypto.js";

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  disabled: number;
  created_at: number;
  last_login_at: number | null;
}

export interface IssuedTokens {
  token: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: number;
}

export function issueTokens(user: UserRow, device = ""): IssuedTokens {
  const refreshToken = randomToken(32);
  const now = Date.now();
  const refreshExpiresAt = now + env.refreshTtl * 1000;

  db.prepare(
    "insert into refresh_tokens (user_id, token_hash, device, created_at, expires_at, revoked) values (?, ?, ?, ?, ?, 0)",
  ).run(user.id, sha256Hex(refreshToken), device.slice(0, 120), now, refreshExpiresAt);

  // 顺手清理过期/已吊销的历史行，免得表一直长
  db.prepare("delete from refresh_tokens where expires_at < ? or revoked = 1").run(now - 86_400_000);

  return {
    token: signAccessToken(user.id, user.role),
    expiresIn: env.accessTtl,
    refreshToken,
    refreshExpiresAt,
  };
}

export function rotateRefresh(refreshToken: string, device = ""): IssuedTokens | null {
  const hash = sha256Hex(refreshToken);
  const row = db
    .prepare("select * from refresh_tokens where token_hash = ? and revoked = 0")
    .get(hash) as
    | { id: number; user_id: number; expires_at: number; revoked: number }
    | undefined;
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    db.prepare("update refresh_tokens set revoked = 1 where id = ?").run(row.id);
    return null;
  }
  const user = db.prepare("select * from users where id = ?").get(row.user_id) as
    | UserRow
    | undefined;
  if (!user || user.disabled) return null;

  db.prepare("update refresh_tokens set revoked = 1 where id = ?").run(row.id);
  return issueTokens(user, device);
}

export function revokeRefresh(refreshToken: string): void {
  db.prepare("update refresh_tokens set revoked = 1 where token_hash = ?").run(
    sha256Hex(refreshToken),
  );
}

/** 吊销某用户全部登录态（改密码 / 管理员踢人时用） */
export function revokeAllForUser(userId: number): void {
  db.prepare("update refresh_tokens set revoked = 1 where user_id = ?").run(userId);
}
