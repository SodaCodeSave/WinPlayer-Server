# WinPlayer 同频服务器 API

客户端（`src/services/cloud.ts`）与本服务端共用的接口合同。**任何一侧改动都必须同步这份文档。**

- 基础路径：`<服务器地址>`（例如 `http://192.168.1.10:3456`）
- 认证：`Authorization: Bearer <accessToken>`；媒体类 GET（封面 / 音频流）也接受 `?token=<accessToken>`（`<img>` / 原生解码器没法自定义请求头）
- 错误：非 2xx 一律返回 `{ "error": "人类可读的中文原因" }`
- 时间：除特别说明外都是**毫秒时间戳**（与客户端一致）

---

## 1. 公开信息

### `GET /api/server/info`

```json
{
  "name": "WinPlayer 同频服务器",
  "version": 1,
  "registrationOpen": false,
  "inviteRequired": false,
  "needsFirstUser": false,
  "maxUploadBytes": 0
}
```

`needsFirstUser = true` 表示库里还没有账号，此时任何人注册都会成为管理员。

### `GET /api/health`

`{ "ok": true, "server": "winplayer-server", "version": 1 }`

---

## 2. 账号

### `POST /api/auth/register`

```json
{ "username": "soda", "password": "至少 6 位", "inviteCode": "可选", "device": "WinPlayer" }
```

返回与登录相同。以下情况会被拒绝：

| 场景 | 状态码 | error |
| --- | --- | --- |
| 已有用户且未开放注册 | 403 | 本站未开放注册，请联系管理员 |
| 需要邀请码但没带 / 已被使用 | 400 | 需要邀请码 / 邀请码无效或已被使用 |
| 用户名非法（2–32 位字母数字下划线中文） | 400 | 用户名需为 2–32 位… |
| 重名 | 409 | 用户名已被占用 |

### `POST /api/auth/login`

```json
{ "username": "soda", "password": "…", "device": "WinPlayer" }
```

限流：同一 IP + 用户名 5 分钟内失败 8 次后返回 429。

### 登录/注册的统一返回

```json
{
  "user": { "id": 1, "username": "soda", "role": "admin", "createdAt": 1793606203650, "lastLoginAt": 1793606237429 },
  "token": "<JWT 形状的 HMAC token>",
  "expiresIn": 3600,
  "refreshToken": "<随机串>",
  "refreshExpiresAt": 1796200000000
}
```

### `POST /api/auth/refresh`

```json
{ "refreshToken": "…", "device": "WinPlayer" }
```

返回 `{ token, expiresIn, refreshToken, refreshExpiresAt }`。**每次刷新都轮换**，旧的立即作废；失效返回 401。

### `POST /api/auth/logout`

```json
{ "refreshToken": "…" }
```

### `GET /api/auth/me`

返回 `{ user, server: { name, registrationOpen } }`。

### `POST /api/auth/password`

```json
{ "current": "…", "next": "…" }
```

改密成功会吊销该账号所有 refresh token（其它设备需重新登录）。

---

## 3. 曲库

所有接口都需要登录，且**只返回自己的曲目**。

### 曲目结构（CloudTrack）

```json
{
  "hash": "ca04f2…03aa",
  "title": "TestTitle",
  "artist": "TestArtist",
  "album": "",
  "albumArtist": "TestArtist",
  "genre": "",
  "year": "2024",
  "trackNo": 2,
  "discNo": 0,
  "duration": 3000,
  "bitrate": 1411,
  "codec": "pcm",
  "size": 529244,
  "ext": "wav",
  "hasCover": false,
  "hasLyrics": true,
  "originalName": "02. TestArtist - TestTitle.wav",
  "createdAt": 1793606203650,
  "updatedAt": 1793606237429
}
```

`hash` 是音频内容的 sha256，**同时就是客户端的 `trackId`**：跨设备稳定，重传/改名都不会变。

### `GET /api/tracks?since=<ms>&limit=5000&offset=0`

```json
{ "tracks": [CloudTrack], "total": 128, "usedBytes": 3221225472, "quotaBytes": 0 }
```

不含回收站里的曲目。`quotaBytes = 0` 表示不限容量。

### `GET /api/tracks/:hash`

`{ "track": CloudTrack }`

### `PUT /api/tracks/upload?filename=<urlencoded>`

- 请求体：**原始音频字节**（`Content-Type: application/octet-stream` 或 `audio/*`）
- 不加 multipart，服务端边收边算 sha256、边写临时文件，收完再落成内容寻址文件
- 重复上传（同 hash）返回 `200` 且 `duplicate: true`，不重复占空间

```json
{ "track": CloudTrack, "duplicate": false }
```

状态码：`201` 新建，`200` 已存在，`413` 超容量，`415` 不支持的格式。

### `PATCH /api/tracks/:hash`

可改字段：`title / artist / album / albumArtist / genre / year / trackNo / discNo / lyrics`。
客户端上传时会用它把插件源的歌词补上来。

### `DELETE /api/tracks/:hash`

软删除（进回收站），返回 `{ ok: true }`。

### `GET /api/tracks/trash` · `POST /api/tracks/:hash/restore`

列出回收站 / 从回收站恢复。

### `GET /api/tracks/:hash/stream`

音频流。**必须支持 Range**（原生解码器是分段请求的）：

```
GET /api/tracks/abc/stream
Range: bytes=0-1023

HTTP/1.1 206 Partial Content
Accept-Ranges: bytes
Content-Range: bytes 0-1023/529244
Content-Length: 1024
```

- 无 `Range` → `200` + 全量
- 越界 → `416` + `Content-Range: bytes */<total>`
- `?download=1` 会加上 `Content-Disposition: attachment`

### `GET /api/tracks/:hash/cover`

封面图片（内嵌封面在入库时抽取落盘）。带 `Cache-Control: immutable`，同一个 hash 内容不会变。

### `GET /api/tracks/:hash/lyrics`

`{ "lrc": "[00:01.00]…" }`；没有歌词返回 404。

---

## 4. 账号数据同步

### 数据模型

| 集合 | 键 | 说明 |
| --- | --- | --- |
| `liked` | `sourceId + trackId` | 喜欢的音乐 |
| `playlists` | 歌单名 | 歌单本身（描述 / 封面 / 时间） |
| `playlistItems` | `歌单名 + sourceId + trackId` | 歌单曲目与顺序 |
| `trackMeta` | `sourceId + trackId` | 用户改写的歌名/歌手/专辑/封面 |
| `history` | `sourceId + trackId` | 首次/最近播放时间与次数 |

服务端给每次写入分配**全局单调递增的 `seq`**，客户端拿 `seq` 当游标拉增量。
删除不物理删，而是 `deleted: true` 的**墓碑**（否则别的设备会把删掉的歌推回来）。

### `POST /api/sync/push`

```json
{
  "liked": [{ "sourceId": "builtin.cloud", "trackId": "abc", "track": "{…UnifiedTrack JSON…}", "likedAt": 1793606203650 }],
  "playlists": [{ "id": "通勤", "name": "通勤", "description": "", "cover": "", "createdAt": 0, "updatedAt": 0 }],
  "playlistItems": [{ "playlistId": "通勤", "sourceId": "builtin.cloud", "trackId": "abc", "track": "{…}", "position": 0, "addedAt": 0 }],
  "trackMeta": [{ "sourceId": "builtin.cloud", "trackId": "abc", "meta": "{\"name\":\"改过的名字\"}" }],
  "history": [{ "sourceId": "builtin.cloud", "trackId": "abc", "track": "{…}", "firstPlayed": 0, "lastPlayed": 0, "playCount": 3 }]
}
```

删除：同样的结构加 `"deleted": true`。

返回 `{ "cursor": 42, "counts": { "liked": 1, "playlists": 1, … } }`。

冲突策略：**服务器接收时间 LWW** —— push 一律以服务器当前时间为准，后到的覆盖先到的。
历史记录例外：`first_played` 取更早、`last_played` 取更晚、`play_count` 取更大，不会被覆盖变小。

### `GET /api/sync/pull?since=<seq>`

```json
{
  "cursor": 57,
  "hasMore": false,
  "liked": [{ "sourceId": "…", "trackId": "…", "track": "…", "likedAt": 0, "deleted": false, "seq": 42 }],
  "playlists": [{ "id": "通勤", "name": "通勤", "description": "", "cover": "", "createdAt": 0, "updatedAt": 0, "deleted": false, "seq": 43 }],
  "playlistItems": [{ "playlistId": "通勤", "sourceId": "…", "trackId": "…", "track": "…", "position": 0, "addedAt": 0, "deleted": false, "seq": 44 }],
  "trackMeta": [{ "sourceId": "…", "trackId": "…", "meta": "…", "deleted": false, "seq": 45 }],
  "history": [{ "sourceId": "…", "trackId": "…", "track": "…", "firstPlayed": 0, "lastPlayed": 0, "playCount": 1, "deleted": false, "seq": 46 }]
}
```

**应用顺序很重要**：把五个数组合并后按 `seq` 升序应用，才能复现「先删后建」的最终状态。
`hasMore = true` 表示还有数据，客户端应继续用新 `cursor` 拉。

### `GET /api/sync/state`

`{ "cursor": 57, "liked": 12, "playlists": 3, "playlistItems": 88, "trackMeta": 5, "history": 210 }`

### `POST /api/sync/reset`

清空该账号的云端同步数据（不动曲库），返回 `{ ok: true, cursor }`。当前没有客户端入口，留给运维。

---

## 5. 管理后台 API（要求 `role = admin`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/overview` | 用户数 / 曲目数 / 占用 / 数据目录大小 / 注册开关 |
| GET | `/api/admin/users` | 用户列表（含曲目数与占用） |
| POST | `/api/admin/users` | 建号 `{ username, password, role }` |
| PATCH | `/api/admin/users/:id` | `{ role?, disabled?, password?, username? }` |
| DELETE | `/api/admin/users/:id` | 删除账号（其曲库与同步数据级联删除） |
| GET/PATCH | `/api/admin/settings` | `{ serverName, registrationOpen, inviteRequired }` |
| GET/POST | `/api/admin/invites` | 列出 / 生成邀请码 `{ count }` |
| DELETE | `/api/admin/invites/:code` | 作废 |
| GET | `/api/admin/tracks` | 全部用户曲库 `?userId=&q=&limit=&offset=` |
| DELETE | `/api/admin/tracks/:userId/:hash` | 物理删除一行记录 |
| POST | `/api/admin/trash/purge` | 清空所有用户的回收站 |
| POST | `/api/admin/gc` | 清理未引用文件与 tmp 残渣，返回 `{ removed, freedBytes }` |
| POST | `/api/admin/checkpoint` | WAL 落盘（备份前跑一次） |

保护规则：不能删除自己；不能把**最后一个可用管理员**降级或停用。

---

## 6. 版本与兼容

`version` 字段目前恒为 `1`。规则：

- 服务端**只加字段不删字段**，客户端忽略不认识的字段；
- 破坏性变更（改语义）需要同时提升 `version`，客户端在 `/api/server/info` 里比对后提示升级。
