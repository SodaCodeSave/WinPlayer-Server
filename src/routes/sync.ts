/**
 * 账号数据同步 API。
 *
 * 传输模型是「按键的行级增量」：
 * - 每条记录有稳定键（喜欢/自定义信息/历史 = `sourceId + trackId`；
 *   歌单 = 歌单名；歌单曲目 = `playlistId + sourceId + trackId`）；
 * - 服务端给每次写入分配一个全局单调 `seq`，客户端拿 `seq` 当游标拉增量，
 *   比时间戳可靠（同一毫秒多次写入也不会漏、也不会因为设备时钟不准而漏数据）；
 * - 删除不物理删，只把 `deleted` 置 1 并分配新 `seq`（墓碑）。没有墓碑的话，
 *   A 设备删掉的歌会被 B 设备下次同步原样推回来。
 *
 * 冲突策略是「服务器接收时间 LWW」：push 过来的写入一律以服务器当前时间为准，
 * 后到的覆盖先到的。客户端侧因此不需要相信本机时钟。
 */

import type { FastifyInstance } from "fastify";
import { currentSeq, db, nextSeq, transaction } from "../db/index.js";
import { requireAuth } from "../auth/middleware.js";

/** 单次拉取每张表的上限 */
const PULL_LIMIT = 2000;

interface LikedChange {
  sourceId?: string;
  trackId?: string;
  track?: string;
  likedAt?: number;
  deleted?: boolean;
}

interface PlaylistChange {
  id?: string;
  name?: string;
  description?: string;
  cover?: string;
  createdAt?: number;
  updatedAt?: number;
  deleted?: boolean;
}

interface PlaylistItemChange {
  playlistId?: string;
  sourceId?: string;
  trackId?: string;
  track?: string;
  position?: number;
  addedAt?: number;
  deleted?: boolean;
}

interface TrackMetaChange {
  sourceId?: string;
  trackId?: string;
  meta?: string;
  deleted?: boolean;
}

interface HistoryChange {
  sourceId?: string;
  trackId?: string;
  track?: string;
  firstPlayed?: number;
  lastPlayed?: number;
  playCount?: number;
  deleted?: boolean;
}

interface PushBody {
  liked?: LikedChange[];
  playlists?: PlaylistChange[];
  playlistItems?: PlaylistItemChange[];
  trackMeta?: TrackMetaChange[];
  history?: HistoryChange[];
}

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  /** 同步概况（设置页展示「云端有多少条」） */
  app.get("/api/sync/state", { preHandler: requireAuth }, async (req) => {
    const user = req.user!;
    const count = (table: string): number =>
      (
        db
          .prepare(`select count(*) as n from ${table} where user_id = ? and deleted = 0`)
          .get(user.id) as { n: number }
      ).n;
    return {
      cursor: currentSeq(),
      liked: count("sync_liked"),
      playlists: count("sync_playlists"),
      playlistItems: count("sync_playlist_items"),
      trackMeta: count("sync_track_meta"),
      history: count("sync_history"),
    };
  });

  /** 推送本地变更；返回新的游标（客户端推完直接用它作为下一次 pull 的起点） */
  app.post("/api/sync/push", { preHandler: requireAuth }, async (req) => {
    const user = req.user!;
    const body = (req.body ?? {}) as PushBody;
    const now = Date.now();
    const counts = {
      liked: 0,
      playlists: 0,
      playlistItems: 0,
      trackMeta: 0,
      history: 0,
      skipped: 0,
    };

    // better-sqlite3 是同步 API：整个事务里不能有 await
    transaction(() => {
      const upsertLiked = db.prepare(
        `insert into sync_liked (user_id, source_id, track_id, track, liked_at, deleted, seq)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(user_id, source_id, track_id) do update set
           track = excluded.track, liked_at = excluded.liked_at,
           deleted = excluded.deleted, seq = excluded.seq`,
      );
      for (const item of body.liked ?? []) {
        const sourceId = String(item.sourceId ?? "");
        const trackId = String(item.trackId ?? "");
        if (!sourceId || !trackId) {
          counts.skipped += 1;
          continue;
        }
        upsertLiked.run(
          user.id,
          sourceId,
          trackId,
          String(item.track ?? ""),
          Number(item.likedAt ?? now),
          item.deleted ? 1 : 0,
          nextSeq(),
        );
        counts.liked += 1;
      }

      const upsertPlaylist = db.prepare(
        `insert into sync_playlists
           (user_id, playlist_id, name, description, cover, created_at, updated_at, deleted, seq)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(user_id, playlist_id) do update set
           name = excluded.name, description = excluded.description, cover = excluded.cover,
           created_at = excluded.created_at, updated_at = excluded.updated_at,
           deleted = excluded.deleted, seq = excluded.seq`,
      );
      for (const item of body.playlists ?? []) {
        const id = String(item.id ?? "").trim();
        if (!id) {
          counts.skipped += 1;
          continue;
        }
        upsertPlaylist.run(
          user.id,
          id,
          String(item.name ?? ""),
          String(item.description ?? ""),
          String(item.cover ?? ""),
          Number(item.createdAt ?? now),
          Number(item.updatedAt ?? now),
          item.deleted ? 1 : 0,
          nextSeq(),
        );
        counts.playlists += 1;
      }

      const upsertItem = db.prepare(
        `insert into sync_playlist_items
           (user_id, playlist_id, item_key, source_id, track_id, track, position, added_at, deleted, seq)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(user_id, playlist_id, item_key) do update set
           track = excluded.track, position = excluded.position,
           deleted = excluded.deleted, seq = excluded.seq`,
      );
      for (const item of body.playlistItems ?? []) {
        const playlistId = String(item.playlistId ?? "").trim();
        const sourceId = String(item.sourceId ?? "");
        const trackId = String(item.trackId ?? "");
        if (!playlistId || !trackId) {
          counts.skipped += 1;
          continue;
        }
        upsertItem.run(
          user.id,
          playlistId,
          `${sourceId}|${trackId}`,
          sourceId,
          trackId,
          String(item.track ?? ""),
          Number(item.position ?? 0),
          Number(item.addedAt ?? now),
          item.deleted ? 1 : 0,
          nextSeq(),
        );
        counts.playlistItems += 1;
      }

      const upsertMeta = db.prepare(
        `insert into sync_track_meta (user_id, source_id, track_id, meta, deleted, seq)
         values (?, ?, ?, ?, ?, ?)
         on conflict(user_id, source_id, track_id) do update set
           meta = excluded.meta, deleted = excluded.deleted, seq = excluded.seq`,
      );
      for (const item of body.trackMeta ?? []) {
        const sourceId = String(item.sourceId ?? "");
        const trackId = String(item.trackId ?? "");
        if (!sourceId || !trackId) {
          counts.skipped += 1;
          continue;
        }
        upsertMeta.run(
          user.id,
          sourceId,
          trackId,
          String(item.meta ?? ""),
          item.deleted ? 1 : 0,
          nextSeq(),
        );
        counts.trackMeta += 1;
      }

      const upsertHistory = db.prepare(
        `insert into sync_history
           (user_id, source_id, track_id, track, first_played, last_played, play_count, deleted, seq)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(user_id, source_id, track_id) do update set
           track = excluded.track,
           first_played = min(sync_history.first_played, excluded.first_played),
           last_played = max(sync_history.last_played, excluded.last_played),
           play_count = max(sync_history.play_count, excluded.play_count),
           deleted = excluded.deleted, seq = excluded.seq`,
      );
      for (const item of body.history ?? []) {
        const sourceId = String(item.sourceId ?? "");
        const trackId = String(item.trackId ?? "");
        if (!sourceId || !trackId) {
          counts.skipped += 1;
          continue;
        }
        const first = Number(item.firstPlayed ?? now) || now;
        const last = Number(item.lastPlayed ?? now) || now;
        upsertHistory.run(
          user.id,
          sourceId,
          trackId,
          String(item.track ?? ""),
          first,
          last,
          Math.max(1, Number(item.playCount ?? 1)),
          item.deleted ? 1 : 0,
          nextSeq(),
        );
        counts.history += 1;
      }
    });

    return { cursor: currentSeq(), counts };
  });

  /** 拉取 since 之后的所有变更（含墓碑） */
  app.get("/api/sync/pull", { preHandler: requireAuth }, async (req) => {
    const user = req.user!;
    const query = req.query as { since?: string };
    const since = Math.max(0, Number(query.since ?? 0) || 0);

    const liked = db
      .prepare(
        "select * from sync_liked where user_id = ? and seq > ? order by seq asc limit ?",
      )
      .all(user.id, since, PULL_LIMIT) as Array<Record<string, unknown>>;
    const playlists = db
      .prepare(
        "select * from sync_playlists where user_id = ? and seq > ? order by seq asc limit ?",
      )
      .all(user.id, since, PULL_LIMIT) as Array<Record<string, unknown>>;
    const playlistItems = db
      .prepare(
        "select * from sync_playlist_items where user_id = ? and seq > ? order by seq asc limit ?",
      )
      .all(user.id, since, PULL_LIMIT) as Array<Record<string, unknown>>;
    const trackMeta = db
      .prepare(
        "select * from sync_track_meta where user_id = ? and seq > ? order by seq asc limit ?",
      )
      .all(user.id, since, PULL_LIMIT) as Array<Record<string, unknown>>;
    const history = db
      .prepare("select * from sync_history where user_id = ? and seq > ? order by seq asc limit ?")
      .all(user.id, since, PULL_LIMIT) as Array<Record<string, unknown>>;

    // 游标推进到「所有表都已读干净」的位置；某张表被 limit 截断时只推进到它的最后一条
    const truncated = [liked, playlists, playlistItems, trackMeta, history].filter(
      (rows) => rows.length >= PULL_LIMIT,
    );
    let cursor = currentSeq();
    if (truncated.length) {
      cursor = Math.max(
        since,
        Math.min(...truncated.map((rows) => Number(rows[rows.length - 1].seq ?? 0))),
      );
    }

    return {
      cursor,
      hasMore: truncated.length > 0,
      liked: liked.map((row) => ({
        sourceId: row.source_id,
        trackId: row.track_id,
        track: row.track,
        likedAt: row.liked_at,
        deleted: Boolean(row.deleted),
        seq: row.seq,
      })),
      playlists: playlists.map((row) => ({
        id: row.playlist_id,
        name: row.name,
        description: row.description,
        cover: row.cover,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deleted: Boolean(row.deleted),
        seq: row.seq,
      })),
      playlistItems: playlistItems.map((row) => ({
        playlistId: row.playlist_id,
        sourceId: row.source_id,
        trackId: row.track_id,
        track: row.track,
        position: row.position,
        addedAt: row.added_at,
        deleted: Boolean(row.deleted),
        seq: row.seq,
      })),
      trackMeta: trackMeta.map((row) => ({
        sourceId: row.source_id,
        trackId: row.track_id,
        meta: row.meta,
        deleted: Boolean(row.deleted),
        seq: row.seq,
      })),
      history: history.map((row) => ({
        sourceId: row.source_id,
        trackId: row.track_id,
        track: row.track,
        firstPlayed: row.first_played,
        lastPlayed: row.last_played,
        playCount: row.play_count,
        deleted: Boolean(row.deleted),
        seq: row.seq,
      })),
    };
  });

  /** 清空云端同步数据（「重置云端」用；不动曲库） */
  app.post("/api/sync/reset", { preHandler: requireAuth }, async (req) => {
    const user = req.user!;
    transaction(() => {
      for (const table of [
        "sync_liked",
        "sync_playlists",
        "sync_playlist_items",
        "sync_track_meta",
        "sync_history",
      ]) {
        db.prepare(`delete from ${table} where user_id = ?`).run(user.id);
      }
    });
    return { ok: true, cursor: currentSeq() };
  });
}
