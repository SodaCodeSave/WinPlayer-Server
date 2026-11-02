#!/bin/sh
# 容器启动入口：先校正数据目录的属主，再降权到 node 运行。
#
# 为什么需要这一步：
#   `./data:/data` 是**绑定挂载**，宿主机目录会直接盖掉镜像里对 /data 的 chown。
#   那个目录通常属于 root（Docker 自动创建时）或宿主机的某个普通用户，
#   而镜像里进程以 uid 1000 的 node 运行，于是启动就炸：
#     EACCES: permission denied, mkdir '/data/music'
#
# 处理顺序：
#   1. 以 root 启动（镜像里不写 USER），把 DATA_DIR 交给 node；
#   2. 用 gosu 降权执行真正的命令，容器内进程始终不是 root。
#
# 如果你在 compose 里显式写了 `user: "1000:1000"`，本脚本检测到非 root 会
# 原样透传命令，不再改动权限（这时需要你自己保证挂载目录可写）。
set -e

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"

  # 只在属主不对时才递归 chown：曲库可能有上万个文件，
  # 每次启动都全盘 chown 会明显拖慢重启，改成「不匹配才做一次」。
  current_owner="$(stat -c %u "$DATA_DIR" 2>/dev/null || echo -1)"
  if [ "$current_owner" != "$(id -u node)" ]; then
    if chown -R node:node "$DATA_DIR" 2>/dev/null; then
      echo "[entrypoint] 检测到 $DATA_DIR 属主为 uid=$current_owner，已修正为 node:node（仅首次）"
    else
      # 只读挂载、NFS root-squash 等场景改不了属主。这时降权必然写不进去，
      # 与其让服务起不来，不如保持 root 继续跑，并明确告知原因。
      echo "[entrypoint] 警告：无法修正 $DATA_DIR 的属主（只读挂载 / NFS root-squash），将以 root 运行"
      exec "$@"
    fi
  fi

  exec gosu node "$@"
fi

exec "$@"
