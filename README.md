# WinPlayer 同频服务器

[WinPlayer](https://github.com/) 的配套服务端：把音乐放在**你自己的服务器**上，顺带把「喜欢、歌单、播放历史、歌曲自定义信息」在同一账号的多台设备之间同步。

- **私人同频服务器**：后台上传 / 客户端右键上传，客户端把它当作一个内置播放源（支持 Range 流式播放、封面、歌词）
- **账号数据同步**：增量 + 墓碑 + 服务器时间 LWW，多设备不会互相覆盖
- **后台管理 UI**：概览、用户、邀请码、曲库、服务器设置
- **一条命令部署**：`docker compose up -d`，数据全在 `./data` 一个目录里

---

## 快速开始

```bash
git clone <this-repo> winplayer-server
cd winplayer-server
docker compose up -d
```

打开 `http://<服务器 IP>:3456/admin/` → **第一个注册的账号自动成为管理员**（不受注册开关限制，避免新部署没人能进后台）。

然后在客户端里：

1. 设置 → **同步（温韵同频）**；
2. 填服务器地址（`http://192.168.1.10:3456`），点「检测连接」；
3. 登录或注册；
4. 点「立即同步」跑第一次合并（把本机的喜欢 / 歌单 / 历史推上去，同时拉下服务器已有的）。

曲目上传有两个入口：

- 后台上「曲库」页拖拽批量上传（初始化曲库最快）；
- 客户端任意曲目的右键菜单 → **上传到同频服务器**（插件源会连音频带歌词一起传）。

### 想用 HTTPS

```bash
# DOMAIN 指向这台服务器的域名，且 80/443 可从公网访问
DOMAIN=music.example.com docker compose --profile https up -d
```

Caddy 会自动申请并续期证书。

---

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3456` | 对外端口 |
| `DATA_DIR` | `/data` | 数据库 + 音频 + 封面 + 密钥，**只需要备份这个目录** |
| `USER_QUOTA_MB` | `0` | 单账号容量上限，0 不限 |
| `MAX_UPLOAD_MB` | `512` | 单次上传上限 |
| `REGISTRATION_OPEN` | `0` | 是否默认开放注册（后台也可随时开关） |
| `SECRET` | 自动生成 | token 签名密钥，留空时随机生成并存入 `DATA_DIR/secret.key` |
| `PUBLIC_URL` | 空 | 反向代理对外地址（生成直链时用），留空按请求头推断 |
| `ACCESS_TTL` | `3600` | access token 有效期（秒） |
| `REFRESH_TTL` | `2592000` | refresh token 有效期（秒，默认 30 天） |

迁移服务器时**记得一起带走 `SECRET`（或 `secret.key`）**，否则所有设备都要重新登录。

---

## 备份与升级

```bash
# 备份：先让 WAL 落盘（后台「概览 → 数据库检查点」也可以），然后打包数据目录
docker compose exec server node -e "process.exit(0)"
tar czf winplayer-$(date +%F).tar.gz data/

# 升级
git pull && docker compose up -d --build
```

数据卷不要删。升级只会重建容器，`./data` 原样保留。

---

## 本地开发

```bash
npm install
npm run dev       # 服务端（tsx watch，默认 3456）
npm run web:dev   # 后台 UI（vite，默认 5174，已配 /api 代理）
```

构建产物：`npm run build`（先 tsc 再构建 `web/dist`，服务端从 `/admin/` 托管）。

冒烟测试（注册 → 上传 → Range 播放 → 歌词 → 同步 → 回收站）：

```bash
npm run dev            # 另开一个终端
node scripts/smoke.mjs http://127.0.0.1:3456
```

---

## 目录结构

```
src/
  index.ts          启动、静态托管、错误处理
  db/               SQLite 连接与表结构
  auth/             密码 / token / 中间件
  routes/           auth · tracks · sync · admin
  media/            内容寻址存储、music-metadata 解析
web/                后台 UI（Vue 3 + Vite）
docs/API.md         接口合同（客户端与服务端共用）
scripts/smoke.mjs   端到端冒烟测试
```

## 设计要点

- **音频按 sha256 内容寻址**：`music/<hash 前 2 位>/<hash>.<ext>`。重复上传自动去重，甚至两个账号传同一首歌也只占一份磁盘。
- **曲目 ID 就是 hash**：跨设备稳定，重传不变、改名不变，客户端拿它当 `track_id` 与去重键。
- **上传是原始字节流**：没有 multipart，服务端边收边算哈希边落临时文件，收完再 rename 成正式文件；进程被杀最多留下 `tmp/` 垃圾。
- **播放必须支持 Range**：客户端原生解码器（symphonia）是分段请求的，只回 200 全量会导致拖动进度条失效。
- **同步用 `seq` 游标而不是时间戳**：同一毫秒多次写入不会漏，也不受设备时钟影响。
- **删除写墓碑**：物理删除会让「A 删掉的歌被 B 下次同步推回来」。
- **不转码**：只收 mp3 / flac / m4a / aac / ogg / wav（客户端能解的格式），镜像里没有 ffmpeg。

## License

MIT
