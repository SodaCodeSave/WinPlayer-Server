/**
 * 运行环境与路径。
 *
 * 所有状态都在 `DATA_DIR` 一个目录里（SQLite + music/ + covers/），
 * 所以「备份服务器」= 打包这一个目录，Docker 里挂一个卷就够。
 */

import fs from "node:fs";
import path from "node:path";

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");

export const env = {
  port: Number(process.env.PORT ?? 3456),
  host: process.env.HOST ?? "0.0.0.0",
  dataDir,
  /** 音频文件（内容寻址：<hash[0:2]>/<hash>.<ext>） */
  musicDir: path.join(dataDir, "music"),
  /** 封面（同样是内容寻址） */
  coverDir: path.join(dataDir, "covers"),
  /** 上传落盘前的临时目录（同目录 rename 才能原子） */
  tmpDir: path.join(dataDir, "tmp"),
  dbFile: path.join(dataDir, "winplayer-server.db"),
  secretFile: path.join(dataDir, "secret.key"),
  /** 反向代理对外地址（生成直链时用；留空则用请求头推断） */
  publicUrl: (process.env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
  /** 单账号容量上限（字节），0 = 不限 */
  userQuotaBytes: Math.max(0, Number(process.env.USER_QUOTA_MB ?? 0)) * 1024 * 1024,
  /** access token 有效期（秒） */
  accessTtl: Number(process.env.ACCESS_TTL ?? 60 * 60),
  /** refresh token 有效期（秒） */
  refreshTtl: Number(process.env.REFRESH_TTL ?? 60 * 60 * 24 * 30),
  /** 单次上传上限（字节） */
  maxUploadBytes: Math.max(1, Number(process.env.MAX_UPLOAD_MB ?? 512)) * 1024 * 1024,
  /** 是否为首次部署自动打开注册（首个账号永远是管理员且不受开关限制） */
  registrationOpenDefault: process.env.REGISTRATION_OPEN === "1",
};

for (const dir of [env.dataDir, env.musicDir, env.coverDir, env.tmpDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
