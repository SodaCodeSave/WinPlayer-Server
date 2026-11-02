/**
 * 曲库 API。
 *
 * 上传是「一个 PUT，body 就是音频字节流」：服务端边收边算 sha256、边写临时文件，
 * 收完再落成内容寻址的正式文件。这样做的好处是内存占用与文件大小无关
 * （不需要把 100MB 的 FLAC 读进内存），也能在前端拿到真实进度。
 *
 * 播放直链必须支持 Range：客户端的原生解码器（symphonia）是分段请求的，
 * 只回 200 全量会让「拖动进度条」「边下边播」全部失效。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import type { Readable } from "node:stream";
import fsp from "node:fs/promises";
import { db, userUsedBytes } from "../db/index.js";
import { env } from "../env.js";
import { requireAuth } from "../auth/middleware.js";
import { parseAudio } from "../media/metadata.js";
import {
  ALLOWED_EXTS,
  codecFor,
  commitBlob,
  coverMime,
  coverPath,
  blobPath,
  extOf,
  fileExists,
  mimeFor,
  saveCover,
  writeStreamToTemp,
} from "../media/storage.js";
import { toCloudTrack, type TrackRow } from "../types.js";

/** 单账号容量上限（0 = 不限） */
const QUOTA = env.userQuotaBytes;

function trackOf(userId: number, hash: string): TrackRow | undefined {
  return db
    .prepare("select * from tracks where user_id = ? and hash = ? and deleted_at is null")
    .get(userId, hash) as TrackRow | undefined;
}

/** 按 Range 头流式返回文件（无 Range 时返回 200 全量） */
async function sendFile(
  req: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  mime: string,
  cacheControl = "private, max-age=0, must-revalidate",
): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    await reply.code(404).send({ error: "文件不存在" });
    return;
  }

  const total = stat.size;
  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", mime);
  reply.header("Cache-Control", cacheControl);

  const range = req.headers.range;
  if (!range) {
    reply.header("Content-Length", String(total));
    await reply.send(fs.createReadStream(filePath));
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) {
    reply.header("Content-Range", `bytes */${total}`);
    await reply.code(416).send();
    return;
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : total - 1;
  // `bytes=-1024` 表示「最后 1024 字节」
  if (!match[1] && match[2]) {
    start = Math.max(0, total - Number(match[2]));
    end = total - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
    reply.header("Content-Range", `bytes */${total}`);
    await reply.code(416).send();
    return;
  }
  end = Math.min(end, total - 1);

  reply.code(206);
  reply.header("Content-Range", `bytes ${start}-${end}/${total}`);
  reply.header("Content-Length", String(end - start + 1));
  await reply.send(fs.createReadStream(filePath, { start, end }));
}

export async function trackRoutes(app: FastifyInstance): Promise<void> {
  /** 曲目列表（自己的曲库，不含回收站） */
  app.get("/api/tracks", { preHandler: requireAuth }, async (req) => {
    const user = req.user!;
    const query = req.query as { since?: string; limit?: string; offset?: string };
    const since = Number(query.since ?? 0) || 0;
    const limit = Math.min(Math.max(Number(query.limit ?? 5000) || 5000, 1), 20000);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);

    const rows = db
      .prepare(
        `select * from tracks
          where user_id = ? and deleted_at is null and updated_at >= ?
          order by created_at desc limit ? offset ?`,
      )
      .all(user.id, since, limit, offset) as TrackRow[];
    const total = db
      .prepare("select count(*) as n from tracks where user_id = ? and deleted_at is null")
      .get(user.id) as { n: number };

    return {
      tracks: rows.map(toCloudTrack),
      total: total.n,
      usedBytes: userUsedBytes(user.id),
      quotaBytes: QUOTA,
    };
  });

  /** 单曲详情 */
  app.get("/api/tracks/:hash", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!;
    const { hash } = req.params as { hash: string };
    const row = trackOf(user.id, hash);
    if (!row) return reply.code(404).send({ error: "曲目不存在" });
    return { track: toCloudTrack(row) };
  });

  /**
   * 上传音频。body 为原始字节（`application/octet-stream` 或 `audio/*`），
   * 文件名通过 `?filename=` 传入（只用于取扩展名与兜底标题）。
   */
  app.put("/api/tracks/upload", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!;
    const query = req.query as { filename?: string; overwrite?: string };
    const filename = String(query.filename ?? "upload.mp3").slice(-200);
    const ext = extOf(filename);
    if (!ALLOWED_EXTS.has(ext)) {
      return reply
        .code(415)
        .send({ error: `不支持的格式 .${ext || "?"}（支持 mp3/flac/m4a/aac/ogg/wav）` });
    }
    const stream = req.body as unknown as Readable | undefined;
    if (!stream || typeof (stream as { pipe?: unknown }).pipe !== "function") {
      return reply.code(400).send({ error: "请求体必须是音频字节流" });
    }

    const { tempPath, hash, size } = await writeStreamToTemp(stream, env.maxUploadBytes);
    if (!size) {
      await fsp.rm(tempPath, { force: true });
      return reply.code(400).send({ error: "上传内容为空" });
    }

    if (QUOTA > 0) {
      const used = userUsedBytes(user.id);
      const existing = trackOf(user.id, hash);
      if (!existing && used + size > QUOTA) {
        await fsp.rm(tempPath, { force: true });
        return reply.code(413).send({
          error: `超出账号容量上限（已用 ${(used / 1048576).toFixed(0)} MB / 共 ${(QUOTA / 1048576).toFixed(0)} MB）`,
        });
      }
    }

    const meta = await parseAudio(tempPath, filename);
    await commitBlob(tempPath, hash, ext);

    let coverHash = "";
    let coverExt = "";
    if (meta.cover) {
      const saved = await saveCover(meta.cover.data, meta.cover.format);
      coverHash = saved.hash;
      coverExt = saved.ext;
    }

    const now = Date.now();
    const previous = db
      .prepare("select * from tracks where user_id = ? and hash = ?")
      .get(user.id, hash) as TrackRow | undefined;

    if (previous) {
      // 同一文件再传一次：元数据以本次解析为准（文件内容相同，标签也可能被改过）
      db.prepare(
        `update tracks set
           title = ?, artist = ?, album = ?, album_artist = ?, genre = ?, year = ?,
           track_no = ?, disc_no = ?, duration = ?, bitrate = ?, codec = ?,
           cover_hash = ?, cover_ext = ?, original_name = ?, updated_at = ?, deleted_at = null
         where user_id = ? and hash = ?`,
      ).run(
        meta.title,
        meta.artist,
        meta.album,
        meta.albumArtist,
        meta.genre,
        meta.year,
        meta.trackNo,
        meta.discNo,
        meta.duration,
        meta.bitrate,
        codecFor(ext),
        coverHash || previous.cover_hash,
        coverExt || previous.cover_ext,
        filename,
        now,
        user.id,
        hash,
      );
    } else {
      db.prepare(
        `insert into tracks
           (user_id, hash, ext, size, codec, title, artist, album, album_artist, genre, year,
            track_no, disc_no, duration, bitrate, cover_hash, cover_ext, lyrics, original_name,
            created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        user.id,
        hash,
        ext,
        size,
        codecFor(ext),
        meta.title,
        meta.artist,
        meta.album,
        meta.albumArtist,
        meta.genre,
        meta.year,
        meta.trackNo,
        meta.discNo,
        meta.duration,
        meta.bitrate,
        coverHash,
        coverExt,
        meta.lyrics,
        filename,
        now,
        now,
      );
    }

    const row = trackOf(user.id, hash) as TrackRow;
    return reply.code(previous ? 200 : 201).send({
      track: toCloudTrack(row),
      duplicate: Boolean(previous),
    });
  });

  /** 改元数据（客户端上传时附带歌词也走这里） */
  app.patch("/api/tracks/:hash", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!;
    const { hash } = req.params as { hash: string };
    const row = trackOf(user.id, hash);
    if (!row) return reply.code(404).send({ error: "曲目不存在" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const fields: string[] = [];
    const params: unknown[] = [];
    const pick = (key: string, column: string): void => {
      if (typeof body[key] === "string") {
        fields.push(`${column} = ?`);
        params.push(body[key]);
      }
    };
    pick("title", "title");
    pick("artist", "artist");
    pick("album", "album");
    pick("albumArtist", "album_artist");
    pick("genre", "genre");
    pick("year", "year");
    pick("lyrics", "lyrics");
    if (typeof body.trackNo === "number") {
      fields.push("track_no = ?");
      params.push(Math.trunc(body.trackNo));
    }
    if (typeof body.discNo === "number") {
      fields.push("disc_no = ?");
      params.push(Math.trunc(body.discNo));
    }
    if (!fields.length) return { track: toCloudTrack(row) };

    fields.push("updated_at = ?");
    params.push(Date.now(), user.id, hash);
    db.prepare(`update tracks set ${fields.join(", ")} where user_id = ? and hash = ?`).run(
      ...params,
    );
    return { track: toCloudTrack(trackOf(user.id, hash) as TrackRow) };
  });

  /** 删除（软删除：进回收站，音频文件留着，直到管理员清理未引用文件） */
  app.delete("/api/tracks/:hash", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!;
    const { hash } = req.params as { hash: string };
    const row = trackOf(user.id, hash);
    if (!row) return reply.code(404).send({ error: "曲目不存在" });
    db.prepare("update tracks set deleted_at = ?, updated_at = ? where user_id = ? and hash = ?").run(
      Date.now(),
      Date.now(),
      user.id,
      hash,
    );
    return { ok: true };
  });

  /** 回收站（客户端「同频服务器」页可以列出来恢复） */
  app.get("/api/tracks/trash", { preHandler: requireAuth }, async (req) => {
    const user = req.user!;
    const rows = db
      .prepare(
        "select * from tracks where user_id = ? and deleted_at is not null order by deleted_at desc limit 2000",
      )
      .all(user.id) as TrackRow[];
    return { tracks: rows.map(toCloudTrack) };
  });

  /** 从回收站恢复 */
  app.post("/api/tracks/:hash/restore", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!;
    const { hash } = req.params as { hash: string };
    const info = db
      .prepare("update tracks set deleted_at = null, updated_at = ? where user_id = ? and hash = ?")
      .run(Date.now(), user.id, hash);
    if (!info.changes) return reply.code(404).send({ error: "曲目不存在" });
    return { ok: true };
  });

  /** 歌词（LRC / 纯文本） */
  app.get("/api/tracks/:hash/lyrics", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!;
    const { hash } = req.params as { hash: string };
    const row = trackOf(user.id, hash);
    if (!row) return reply.code(404).send({ error: "曲目不存在" });
    if (!row.lyrics) return reply.code(404).send({ error: "没有歌词" });
    return { lrc: row.lyrics };
  });

  /** 封面 */
  app.get("/api/tracks/:hash/cover", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!;
    const { hash } = req.params as { hash: string };
    const row = trackOf(user.id, hash);
    if (!row?.cover_hash) return reply.code(404).send({ error: "没有封面" });
    const file = coverPath(row.cover_hash, row.cover_ext || "jpg");
    if (!fileExists(file)) return reply.code(404).send({ error: "封面文件缺失" });
    await sendFile(req, reply, file, coverMime(row.cover_ext), "private, max-age=604800, immutable");
  });

  /** 音频流（支持 Range） */
  app.get("/api/tracks/:hash/stream", { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user!;
    const { hash } = req.params as { hash: string };
    const row = trackOf(user.id, hash);
    if (!row) return reply.code(404).send({ error: "曲目不存在" });
    const file = blobPath(row.hash, row.ext);
    if (!fileExists(file)) return reply.code(404).send({ error: "音频文件缺失，请重新上传" });

    const download = (req.query as { download?: string }).download === "1";
    if (download) {
      const name = `${row.artist ? `${row.artist} - ` : ""}${row.title || row.hash}.${row.ext}`;
      reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    }
    await sendFile(req, reply, file, mimeFor(row.ext));
  });
}
