#!/usr/bin/env bash
# Dựng và chạy worker Zalo trên VPS bằng Docker trần (VPS Minh không có docker compose).
# Chạy bằng root. Mỗi bản là một image gắn tag theo SHA, nên lùi bản = `run` lại tag cũ.
#
#   zalo-worker.sh build <thư mục worker đã giải nén> <SHA 40 ký tự>
#   zalo-worker.sh run <image>     # thay container đang chạy, dừng êm 30 giây trước
#   zalo-worker.sh stop
#
# Dừng êm quan trọng: worker nhả lease khi nhận SIGTERM, bản mới giành lease ngay thay vì
# chờ 30 giây hết hạn (lib/lease.js), và hai bản không bao giờ giữ cùng một phiên Zalo.
set -euo pipefail

ROOT=/opt/ihome-zalo-worker
NAME=ihome-zalo-worker
APP_UID=10002

case "${1:-}" in
  build)
    src="${2:?thiếu thư mục nguồn worker}"
    sha="${3:?thiếu SHA}"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "SHA phải đủ 40 ký tự hex" >&2; exit 2; }
    tag="ihome-zalo-worker:${sha:0:12}"
    # Không có buildx trên VPS: dùng builder cũ, đủ cho Dockerfile nhiều tầng này.
    DOCKER_BUILDKIT=0 docker build --pull=false \
      --build-arg "ZALO_WORKER_RELEASE_SHA=$sha" -t "$tag" "$src"
    echo "$tag"
    ;;
  run)
    image="${2:?thiếu image}"
    [ -f "$ROOT/worker.env" ] || { echo "thiếu $ROOT/worker.env" >&2; exit 2; }
    install -d -m 700 -o "$APP_UID" -g "$APP_UID" "$ROOT/sessions"
    if docker container inspect "$NAME" >/dev/null 2>&1; then
      docker stop --time 30 "$NAME" >/dev/null
      docker rm "$NAME" >/dev/null
    fi
    docker run -d --name "$NAME" \
      --user "$APP_UID:$APP_UID" --init --restart unless-stopped \
      --read-only --cap-drop ALL --security-opt no-new-privileges:true \
      --tmpfs "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=$APP_UID,gid=$APP_UID,mode=0700" \
      --mount "type=bind,source=$ROOT/sessions,target=/app/sessions" \
      --env-file "$ROOT/worker.env" \
      --memory 384m --memory-reservation 96m --cpus 0.5 --pids-limit 128 \
      --stop-timeout 30 \
      --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
      --label com.ihomecrm.component=zalo-worker \
      "$image"
    ;;
  stop)
    docker stop --time 30 "$NAME"
    ;;
  *)
    echo "dùng: $0 build <thư mục> <sha> | run <image> | stop" >&2
    exit 2
    ;;
esac
