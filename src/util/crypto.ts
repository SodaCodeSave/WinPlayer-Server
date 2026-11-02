/**
 * 密码哈希、签名 token、杂项摘要。
 *
 * 全部用 node:crypto 实现，不引 bcrypt / jsonwebtoken：
 * - 密码用 scrypt（N=16384），每个用户独立 salt，存储格式 `scrypt$salt$hash`；
 * - access token 是自签的 HMAC-SHA256 token（结构同 JWT，但只支持 HS256，
 *   够用且没有依赖）；refresh token 是随机串，库里只存它的 sha256。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { env } from "../env.js";

/* ------------------------------ 服务器密钥 ------------------------------ */

let cachedSecret: Buffer | null = null;

/** 签名密钥：优先环境变量 `SECRET`，否则落盘到 DATA_DIR/secret.key（重启后 token 仍有效） */
export function secret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.SECRET?.trim();
  if (fromEnv) {
    cachedSecret = Buffer.from(fromEnv, "utf8");
    return cachedSecret;
  }
  if (fs.existsSync(env.secretFile)) {
    cachedSecret = Buffer.from(fs.readFileSync(env.secretFile, "utf8").trim(), "hex");
  } else {
    cachedSecret = crypto.randomBytes(48);
    fs.writeFileSync(env.secretFile, cachedSecret.toString("hex"), { mode: 0o600 });
  }
  return cachedSecret;
}

/* ------------------------------ 摘要 / 随机串 ------------------------------ */

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/* ------------------------------ 密码 ------------------------------ */

const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
  const expected = Buffer.from(hash, "hex");
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

/* ------------------------------ 访问令牌 ------------------------------ */

export interface TokenPayload {
  /** 用户 id */
  uid: number;
  /** user | admin */
  role: string;
  /** 过期时间（Unix 秒） */
  exp: number;
  /** 签发时间（Unix 秒） */
  iat: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signAccessToken(uid: number, role: string, ttl = env.accessTtl): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = { uid, role, iat: now, exp: now + ttl };
  const body = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", secret())
    .update(`${body}.${claims}`)
    .digest("base64url");
  return `${body}.${claims}.${signature}`;
}

export function verifyAccessToken(token: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [body, claims, signature] = parts;
  const expected = crypto
    .createHmac("sha256", secret())
    .update(`${body}.${claims}`)
    .digest("base64url");
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  try {
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as TokenPayload;
    if (!payload || typeof payload.uid !== "number") return null;
    if (payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
