/**
 * 数据库结构。
 *
 * 全部 `create ... if not exists`，启动时无脑 exec 一遍，所以升级服务端不需要写迁移脚本
 * （只加表/加列；改列语义时才需要单独处理）。
 *
 * 同步部分的设计要点：
 * - 每行带 `seq`，来自 `sync_seq` 里的全局单调计数器；客户端拿 `seq` 当游标，
 *   比时间戳可靠（同一毫秒多次写入也不会漏）。
 * - 删除不物理删，只把 `deleted` 置 1 并分配新 `seq` —— 否则别的设备永远不知道
 *   「这条被删了」，下次同步又会把它推回来。
 * - 曲库（tracks）按 `user_id` 隔离；音频文件本身按 sha256 全服共享（两个账号传同一首歌
 *   只占一份磁盘）。
 */

export const SCHEMA = `
pragma journal_mode = WAL;

create table if not exists users (
  id            integer primary key autoincrement,
  username      text    not null unique,
  password_hash text    not null,
  role          text    not null default 'user',
  disabled      integer not null default 0,
  created_at    integer not null,
  last_login_at integer
);

create table if not exists refresh_tokens (
  id         integer primary key autoincrement,
  user_id    integer not null references users(id) on delete cascade,
  token_hash text    not null unique,
  device     text    not null default '',
  created_at integer not null,
  expires_at integer not null,
  revoked    integer not null default 0
);

create index if not exists idx_refresh_user on refresh_tokens (user_id);

create table if not exists server_settings (
  key   text primary key,
  value text not null
);

create table if not exists invite_codes (
  code       text primary key,
  created_by integer,
  created_at integer not null,
  used_by    integer,
  used_at    integer
);

/* ------------------------------ 曲库 ------------------------------ */

create table if not exists tracks (
  user_id       integer not null references users(id) on delete cascade,
  hash          text    not null,
  ext           text    not null,
  size          integer not null,
  codec         text    not null default '',
  title         text    not null default '',
  artist        text    not null default '',
  album         text    not null default '',
  album_artist  text    not null default '',
  genre         text    not null default '',
  year          text    not null default '',
  track_no      integer not null default 0,
  disc_no       integer not null default 0,
  duration      integer not null default 0,
  bitrate       integer not null default 0,
  cover_hash    text    not null default '',
  cover_ext     text    not null default '',
  lyrics        text    not null default '',
  original_name text    not null default '',
  created_at    integer not null,
  updated_at    integer not null,
  deleted_at    integer,
  primary key (user_id, hash)
);

create index if not exists idx_tracks_user on tracks (user_id, deleted_at);

/* ------------------------------ 同步 ------------------------------ */

create table if not exists sync_seq (
  name  text primary key,
  value integer not null
);
insert or ignore into sync_seq (name, value) values ('seq', 0);

create table if not exists sync_liked (
  user_id   integer not null,
  source_id text    not null,
  track_id  text    not null,
  track     text    not null default '',
  liked_at  integer not null default 0,
  deleted   integer not null default 0,
  seq       integer not null,
  primary key (user_id, source_id, track_id)
);

create table if not exists sync_playlists (
  user_id     integer not null,
  playlist_id text    not null,
  name        text    not null default '',
  description text    not null default '',
  cover       text    not null default '',
  created_at  integer not null default 0,
  updated_at  integer not null default 0,
  deleted     integer not null default 0,
  seq         integer not null,
  primary key (user_id, playlist_id)
);

create table if not exists sync_playlist_items (
  user_id     integer not null,
  playlist_id text    not null,
  item_key    text    not null,
  source_id   text    not null default '',
  track_id    text    not null default '',
  track       text    not null default '',
  position    integer not null default 0,
  added_at    integer not null default 0,
  deleted     integer not null default 0,
  seq         integer not null,
  primary key (user_id, playlist_id, item_key)
);

create table if not exists sync_track_meta (
  user_id   integer not null,
  source_id text    not null,
  track_id  text    not null,
  meta      text    not null default '',
  deleted   integer not null default 0,
  seq       integer not null,
  primary key (user_id, source_id, track_id)
);

create table if not exists sync_history (
  user_id      integer not null,
  source_id    text    not null,
  track_id     text    not null,
  track        text    not null default '',
  first_played integer not null default 0,
  last_played  integer not null default 0,
  play_count   integer not null default 1,
  deleted      integer not null default 0,
  seq          integer not null,
  primary key (user_id, source_id, track_id)
);

create index if not exists idx_sync_liked_seq on sync_liked (user_id, seq);
create index if not exists idx_sync_playlists_seq on sync_playlists (user_id, seq);
create index if not exists idx_sync_playlist_items_seq on sync_playlist_items (user_id, seq);
create index if not exists idx_sync_track_meta_seq on sync_track_meta (user_id, seq);
create index if not exists idx_sync_history_seq on sync_history (user_id, seq);
`;
