/**
 * 冒烟测试：注册 → 登录 → 上传 → 列表 → Range 播放 → 歌词 → 同步 push/pull。
 *
 * 用法：node scripts/smoke.mjs [baseUrl]
 * 需要服务端已启动（可指定独立 DATA_DIR 免得污染正式库）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = (process.argv[2] ?? "http://127.0.0.1:3457").replace(/\/+$/, "");
const username = `smoke_${Date.now().toString(36)}`;
const password = "smoke-pass-123";

let token = "";
let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

async function api(method, url, { body, headers = {}, raw = false } = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(raw ? {} : body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应（音频流） */
  }
  return { status: response.status, headers: response.headers, json, text };
}

/** 造一个 2 秒 440Hz 的 WAV（symphonia 能解 pcm） */
function makeWav(seconds = 2) {
  const rate = 44100;
  const channels = 2;
  const frames = rate * seconds;
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000);
    for (let c = 0; c < channels; c += 1) data.writeInt16LE(sample, (i * channels + c) * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

console.log(`\n== WinPlayer-Server smoke @ ${base} ==`);

const info = await api("GET", "/api/server/info");
check("server/info 可访问", info.status === 200 && Boolean(info.json?.name), info.text);

const register = await api("POST", "/api/auth/register", {
  body: { username, password, device: "smoke" },
});
if (register.status === 403) {
  console.log("  skip 注册（服务器已关闭注册且非首个用户），改用管理员账号测试…");
  const admin = await api("POST", "/api/auth/login", {
    body: { username: process.env.SMOKE_USER ?? "soda", password: process.env.SMOKE_PASS ?? "secret123" },
  });
  check("管理员登录", admin.status === 200 && Boolean(admin.json?.token), admin.text);
  token = admin.json?.token ?? "";
} else {
  check("注册", register.status === 200 && Boolean(register.json?.token), register.text);
  token = register.json?.token ?? "";
}

if (!token) {
  console.log("\n没有可用登录态，终止。");
  process.exit(1);
}

const wav = makeWav(2);
const upload = await api("PUT", `/api/tracks/upload?filename=${encodeURIComponent("01. Smoke Artist - Smoke Title.wav")}`, {
  body: wav,
  raw: true,
  headers: { "Content-Type": "application/octet-stream" },
});
check("上传音频", [200, 201].includes(upload.status) && Boolean(upload.json?.track?.hash), upload.text.slice(0, 200));
const hash = upload.json?.track?.hash ?? "";
check("解析文件名元数据", upload.json?.track?.title === "Smoke Title", JSON.stringify(upload.json?.track));

const list = await api("GET", "/api/tracks");
check("曲目列表包含刚上传的歌", list.json?.tracks?.some((t) => t.hash === hash), list.text.slice(0, 200));

const full = await api("GET", `/api/tracks/${hash}/stream`);
check("整段播放返回 200", full.status === 200);

const ranged = await fetch(`${base}/api/tracks/${hash}/stream`, {
  headers: { Authorization: `Bearer ${token}`, Range: "bytes=0-1023" },
});
const rangedBody = Buffer.from(await ranged.arrayBuffer());
check(
  "Range 返回 206 且长度正确",
  ranged.status === 206 && rangedBody.length === 1024 && /bytes 0-1023\//.test(ranged.headers.get("content-range") ?? ""),
  `status=${ranged.status} len=${rangedBody.length} range=${ranged.headers.get("content-range")}`,
);

const badRange = await fetch(`${base}/api/tracks/${hash}/stream`, {
  headers: { Authorization: `Bearer ${token}`, Range: "bytes=99999999-" },
});
check("越界 Range 返回 416", badRange.status === 416, String(badRange.status));

const lyric = "# 冒烟测试歌词\n[00:01.00]hello\n[00:02.00]world\n";
const patched = await api("PATCH", `/api/tracks/${hash}`, { body: { lyrics: lyric } });
check("写入歌词", patched.json?.track?.hasLyrics === true, patched.text.slice(0, 200));
const readLyric = await api("GET", `/api/tracks/${hash}/lyrics`);
check("读取歌词", readLyric.json?.lrc === lyric, readLyric.text.slice(0, 120));

const push = await api("POST", "/api/sync/push", {
  body: {
    liked: [{ sourceId: "builtin.cloud", trackId: hash, track: '{"id":"x","name":"Smoke Title","artists":["Smoke Artist"]}', likedAt: Date.now() }],
    playlists: [{ id: "默认歌单", name: "默认歌单", description: "", cover: "", createdAt: Date.now(), updatedAt: Date.now() }],
    playlistItems: [
      { playlistId: "默认歌单", sourceId: "builtin.cloud", trackId: hash, track: "{}", position: 0, addedAt: Date.now() },
    ],
    trackMeta: [{ sourceId: "builtin.cloud", trackId: hash, meta: '{"name":"改过的名字"}' }],
    history: [{ sourceId: "builtin.cloud", trackId: hash, track: "{}", firstPlayed: Date.now(), lastPlayed: Date.now(), playCount: 3 }],
  },
});
check("同步 push", push.status === 200 && push.json?.counts?.liked === 1, push.text.slice(0, 200));
const cursor = push.json?.cursor ?? 0;

const pull = await api("GET", `/api/sync/pull?since=0`);
check("同步 pull 拿回喜欢", pull.json?.liked?.some((row) => row.trackId === hash), pull.text.slice(0, 200));
check("同步 pull 拿回歌单与曲目", pull.json?.playlists?.length >= 1 && pull.json?.playlistItems?.length >= 1);
check("同步 pull 拿回自定义信息与历史", pull.json?.trackMeta?.length >= 1 && pull.json?.history?.length >= 1);

const del = await api("POST", "/api/sync/push", {
  body: { liked: [{ sourceId: "builtin.cloud", trackId: hash, deleted: true }] },
});
const pullDeleted = await api("GET", `/api/sync/pull?since=${cursor}`);
const tomb = pullDeleted.json?.liked?.find((row) => row.trackId === hash);
check("取消喜欢产生墓碑", Boolean(tomb?.deleted), JSON.stringify(tomb));

const emptyPull = await api("GET", `/api/sync/pull?since=${pullDeleted.json?.cursor ?? 0}`);
check("游标追平后 pull 为空", emptyPull.json?.liked?.length === 0 && emptyPull.json?.hasMore === false);

const remove = await api("DELETE", `/api/tracks/${hash}`);
check("删除曲目（软删除）", remove.json?.ok === true, remove.text);
const trash = await api("GET", "/api/tracks/trash");
check("回收站能查到", trash.json?.tracks?.some((t) => t.hash === hash));
const restored = await api("POST", `/api/tracks/${hash}/restore`);
check("可从回收站恢复", restored.json?.ok === true, restored.text);

const unauth = await fetch(`${base}/api/tracks`);
check("未登录访问被拒", unauth.status === 401, String(unauth.status));

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}\n`);
process.exit(failures === 0 ? 0 : 1);
