/**
 * SQLite 连接与常用小工具。
 */

import Database from "better-sqlite3";
import { env } from "../env.js";
import { SCHEMA } from "./schema.js";

export const db = new Database(env.dbFile);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA);

/* ------------------------------ 服务器设置 ------------------------------ */

export function getServerSetting(key: string, fallback: string): string {
  const row = db
    .prepare("select value from server_settings where key = ?")
    .get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setServerSetting(key: string, value: string): void {
  db.prepare(
    "insert into server_settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
  ).run(key, value);
}

export function getServerFlag(key: string, fallback: boolean): boolean {
  const raw = getServerSetting(key, fallback ? "1" : "0");
  return raw === "1" || raw === "true";
}

/* ------------------------------ 同步游标 ------------------------------ */

/** 取下一个全局同步序号（必须在事务里调用） */
export function nextSeq(): number {
  db.prepare("update sync_seq set value = value + 1 where name = 'seq'").run();
  const row = db.prepare("select value from sync_seq where name = 'seq'").get() as
    | { value: number }
    | undefined;
  return row?.value ?? 0;
}

/** 当前序号（作为「已追平」的游标返回给客户端） */
export function currentSeq(): number {
  const row = db.prepare("select value from sync_seq where name = 'seq'").get() as
    | { value: number }
    | undefined;
  return row?.value ?? 0;
}

/** 事务包装（better-sqlite3 是同步 API，事务里不要有 await） */
export function transaction<T>(fn: () => T): T {
  return db.transaction(fn)();
}

/* ------------------------------ 用户统计 ------------------------------ */

export function countUsers(): number {
  const row = db.prepare("select count(*) as n from users").get() as { n: number };
  return row.n;
}

export function userUsedBytes(userId: number): number {
  const row = db
    .prepare("select coalesce(sum(size), 0) as total from tracks where user_id = ? and deleted_at is null")
    .get(userId) as { total: number };
  return row.total;
}
