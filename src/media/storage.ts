/**
 * 音频与封面的落盘策略。
 *
 * 文件按 sha256 内容寻址（`music/<hash 前 2 位>/<hash>.<ext>`）：
 * - 同一个文件重复上传只占一份磁盘（两个账号传同一首歌也共享）；
 * - 上传时就算出哈希，天然可做完整性校验与「断点续传」的将来扩展；
 * - 歌名、歌手这些可改的元数据全部放数据库，改元数据不动文件。
 *
 * 写入流程刻意分两步（临时文件 → 同盘 rename），保证任何时刻都不会有
 * 「写了一半的音频被当成正常文件」的状态：进程被杀只会留下 tmp/ 里的垃圾。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "../env.js";

/** 原生解码器（symphonia）能解的扩展名，与客户端的上传预检保持一致 */
export const ALLOWED_EXTS = new Set(["mp3", "flac", "m4a", "mp4", "m4b", "aac", "ogg", "oga", "wav"]);

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function mimeFor(ext: string): string {
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "flac":
      return "audio/flac";
    case "m4a":
    case "mp4":
    case "m4b":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "ogg":
    case "oga":
      return "audio/ogg";
    case "wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}

/** 扩展名 → 客户端播放源上报的编码名（与 `DECODABLE_CODECS` 对齐） */
export function codecFor(ext: string): string {
  switch (ext) {
    case "flac":
      return "flac";
    case "m4a":
    case "m4b":
    case "mp4":
    case "aac":
      return "aac";
    case "ogg":
    case "oga":
      return "vorbis";
    case "wav":
      return "pcm";
    default:
      return "mp3";
  }
}

function shardPath(root: string, hash: string, ext: string): string {
  return path.join(root, hash.slice(0, 2), `${hash}.${ext}`);
}

export function blobPath(hash: string, ext: string): string {
  return shardPath(env.musicDir, hash, ext);
}

export function coverPath(hash: string, ext: string): string {
  return shardPath(env.coverDir, hash, ext);
}

export async function ensureDir(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * 把上传流写到临时文件，同时算 sha256 与字节数。
 * 超过 `maxBytes` 会中断并抛错（防止一个请求把磁盘写满）。
 */
export async function writeStreamToTemp(
  stream: Readable,
  maxBytes: number,
): Promise<{ tempPath: string; hash: string; size: number }> {
  const tempPath = path.join(env.tmpDir, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
  const hash = crypto.createHash("sha256");
  let size = 0;

  const counter = new (await import("node:stream")).Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(new Error(`文件超过上限 ${Math.round(maxBytes / 1024 / 1024)} MB`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(stream, counter, fs.createWriteStream(tempPath));
  } catch (error) {
    await fsp.rm(tempPath, { force: true });
    throw error;
  }

  return { tempPath, hash: hash.digest("hex"), size };
}

/** 临时文件搬到内容寻址位置；目标已存在则丢弃临时文件（去重） */
export async function commitBlob(tempPath: string, hash: string, ext: string): Promise<string> {
  const target = blobPath(hash, ext);
  if (fileExists(target)) {
    await fsp.rm(tempPath, { force: true });
    return target;
  }
  await ensureDir(target);
  await fsp.rename(tempPath, target);
  return target;
}

/** 保存内嵌封面，返回 { hash, ext }（同一张封面重复出现只存一份） */
export async function saveCover(
  data: Uint8Array,
  format: string,
): Promise<{ hash: string; ext: string }> {
  const buffer = Buffer.from(data);
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  let ext = "jpg";
  if (/png/i.test(format)) ext = "png";
  else if (/webp/i.test(format)) ext = "webp";
  else if (/gif/i.test(format)) ext = "gif";
  else if (/bmp/i.test(format)) ext = "bmp";

  const target = coverPath(hash, ext);
  if (!fileExists(target)) {
    await ensureDir(target);
    await fsp.writeFile(target, buffer);
  }
  return { hash, ext };
}

export function coverMime(ext: string): string {
  switch (ext) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    default:
      return "image/jpeg";
  }
}
