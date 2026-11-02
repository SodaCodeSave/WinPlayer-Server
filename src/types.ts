/**
 * 对外暴露的数据结构（客户端与服务端共享的「合同」）。
 *
 * 独立仓库拿不到客户端的 TypeScript 类型，所以这里手写一份，并在
 * `docs/API.md` 里逐字段说明；两边改动必须同步。
 */

/** 同频服务器里的一首曲目（不含二进制内容） */
export interface CloudTrack {
  /** 内容哈希（同时也是客户端里的 track_id，跨设备稳定） */
  hash: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  genre: string;
  year: string;
  trackNo: number;
  discNo: number;
  /** 时长（毫秒），解析不出时为 0 */
  duration: number;
  /** 码率（kbps） */
  bitrate: number;
  /** flac / mp3 / aac / vorbis / pcm */
  codec: string;
  /** 字节数 */
  size: number;
  /** 扩展名（不带点） */
  ext: string;
  hasCover: boolean;
  hasLyrics: boolean;
  /** 原始文件名（仅展示用） */
  originalName: string;
  createdAt: number;
  updatedAt: number;
}

/** tracks 表的一行 */
export interface TrackRow {
  user_id: number;
  hash: string;
  ext: string;
  size: number;
  codec: string;
  title: string;
  artist: string;
  album: string;
  album_artist: string;
  genre: string;
  year: string;
  track_no: number;
  disc_no: number;
  duration: number;
  bitrate: number;
  cover_hash: string;
  cover_ext: string;
  lyrics: string;
  original_name: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export function toCloudTrack(row: TrackRow): CloudTrack {
  return {
    hash: row.hash,
    title: row.title || row.original_name || row.hash.slice(0, 8),
    artist: row.artist,
    album: row.album,
    albumArtist: row.album_artist || row.artist,
    genre: row.genre,
    year: row.year,
    trackNo: row.track_no,
    discNo: row.disc_no,
    duration: row.duration,
    bitrate: row.bitrate,
    codec: row.codec,
    size: row.size,
    ext: row.ext,
    hasCover: Boolean(row.cover_hash),
    hasLyrics: Boolean(row.lyrics),
    originalName: row.original_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
