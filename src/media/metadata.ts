/**
 * 音频元数据解析（music-metadata）。
 *
 * 解析失败不算致命：很多文件只有裸流没有标签，此时用文件名兜底，
 * 保证「传上去了就能播」而不是卡在入库这一步。
 */

import path from "node:path";
import { parseFile } from "music-metadata";

export interface ParsedAudio {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  genre: string;
  year: string;
  trackNo: number;
  discNo: number;
  /** 毫秒 */
  duration: number;
  bitrate: number;
  /** 内嵌歌词（LRC 文本或纯文本，无则为空串） */
  lyrics: string;
  /** 内嵌封面 */
  cover: { data: Uint8Array; format: string } | null;
  /** 解析是否成功（false 表示走了文件名兜底） */
  parsed: boolean;
}

/** 文件名兜底解析：`01. Artist - Title.flac` → 音轨号 / 艺术家 / 标题 */
export function parseFromFileName(fileName: string): {
  title: string;
  artist: string;
  trackNo: number;
} {
  let rest = fileName.replace(/\.[^.]+$/, "").trim();
  let trackNo = 0;
  const numbered = /^(\d{1,3})\s*[.\-_)]\s*(.+)$/.exec(rest) ?? /^(\d{1,3})\s+(.+)$/.exec(rest);
  if (numbered) {
    trackNo = Number(numbered[1]);
    rest = numbered[2].trim();
  }
  const parts = rest
    .split(/\s+-\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2) return { title: parts[parts.length - 1], artist: parts[0], trackNo };
  return { title: rest, artist: "", trackNo };
}

function lyricsText(raw: unknown): string {
  if (!raw) return "";
  // music-metadata 不同版本里 common.lyrics 可能是字符串数组，也可能是 {text} 对象数组
  const list = Array.isArray(raw) ? raw : [raw];
  const parts: string[] = [];
  for (const item of list) {
    if (typeof item === "string" && item.trim()) parts.push(item);
    else if (item && typeof item === "object") {
      const text = (item as { text?: unknown; syncText?: unknown }).text;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

export async function parseAudio(filePath: string, originalName: string): Promise<ParsedAudio> {
  const fallback = parseFromFileName(originalName || path.basename(filePath));
  const empty: ParsedAudio = {
    title: fallback.title,
    artist: fallback.artist,
    album: "",
    albumArtist: fallback.artist,
    genre: "",
    year: "",
    trackNo: fallback.trackNo,
    discNo: 0,
    duration: 0,
    bitrate: 0,
    lyrics: "",
    cover: null,
    parsed: false,
  };

  try {
    const meta = await parseFile(filePath, { duration: true });
    const common = meta.common ?? ({} as typeof meta.common);
    const format = meta.format ?? ({} as typeof meta.format);

    const picture = Array.isArray(common.picture) ? common.picture[0] : undefined;
    const durationSeconds = Number(format.duration ?? 0);

    return {
      title: (common.title ?? "").trim() || fallback.title,
      artist: (common.artist ?? "").trim() || fallback.artist,
      album: (common.album ?? "").trim(),
      albumArtist: (common.albumartist ?? "").trim() || (common.artist ?? "").trim(),
      genre: Array.isArray(common.genre) ? (common.genre[0] ?? "") : String(common.genre ?? ""),
      year: common.year ? String(common.year) : "",
      trackNo: Number(common.track?.no ?? 0) || fallback.trackNo,
      discNo: Number(common.disk?.no ?? 0) || 0,
      duration: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : 0,
      bitrate: Math.round(Number(format.bitrate ?? 0) / 1000),
      lyrics: lyricsText((common as { lyrics?: unknown }).lyrics),
      cover: picture?.data ? { data: picture.data, format: picture.format ?? "" } : null,
      parsed: true,
    };
  } catch {
    // 裸流 / 损坏的标签：仍然入库，用文件名当标题
    return empty;
  }
}
