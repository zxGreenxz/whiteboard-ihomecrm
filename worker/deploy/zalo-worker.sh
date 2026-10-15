#!/usr/bin/env bash
# Dựng và chạy worker Zalo trên VPS bằng Docker trần (VPS Minh không có docker compose).
# Chạy bằng root. Mỗi bản là một image gắn tag theo SHA, nên lùi bản = `run` lại tag cũ.
#
#   zalo-worker.sh build <thư mục worker đã giải nén> <SHA 40 ký tự>
#   zalo-worker.sh run <image> [--native]  # preflight rồi dừng worker cũ
#   zalo-worker.sh stop
#
# SIGTERM đợi provider drain trước khi nhả lease. Không tự SIGKILL sau 30 giây:
# provider chưa kết thúc có thể giữ lệnh stop chờ vô hạn; ngắt thì không thay container.
set -euo pipefail

ROOT=/opt/ihome-zalo-worker
NAME=ihome-zalo-worker
APP_UID=10002
NATIVE_CONFIG_DIR="$ROOT/native-config"
NATIVE_STATE_DIR="$ROOT/native-state"

native_directory() {
  # Docker resolves a symlinked bind source before the in-image validator sees
  # it. Check host canonical identity here; owner/mode/schema belong to Node.
  if [ ! -d "$1" ] || [ "$(realpath -e -- "$1")" != "$1" ]; then
    echo "native_deployment_directory_invalid" >&2
    exit 2
  fi
}

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
    [[ "$#" -eq 2 || ( "$#" -eq 3 && "$3" == --native ) ]] || { echo "dùng: run <image> [--native]" >&2; exit 2; }
    [ -f "$ROOT/worker.env" ] || { echo "thiếu $ROOT/worker.env" >&2; exit 2; }
    # Resolve once so a mutable tag cannot select different images between the
    # preflight and worker startup. Missing local images fail before stop.
    image_id="$(docker image inspect --format '{{.Id}}' "$image")"
    [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "image ID không hợp lệ" >&2; exit 2; }
    native_mounts=()
    native_config=''
    if [ "${3:-}" = --native ]; then
      native_directory "$NATIVE_CONFIG_DIR"
      native_directory "$NATIVE_STATE_DIR"
      native_mounts=(
        --mount "type=bind,source=$NATIVE_CONFIG_DIR,target=$NATIVE_CONFIG_DIR,readonly"
        --mount "type=bind,source=$NATIVE_STATE_DIR,target=$NATIVE_STATE_DIR"
      )
      native_config="$NATIVE_CONFIG_DIR/config.json"
      # This selected image uses the exact worker validator with its production
      # identity. No worker.env, sessions, network or provider is available.
      docker run --rm --network none \
        --user "$APP_UID:$APP_UID" --read-only --cap-drop ALL \
        --security-opt no-new-privileges:true \
        --memory 128m --cpus 0.5 --pids-limit 32 \
        "${native_mounts[@]}" --entrypoint node "$image_id" \
        /app/deploy/native-preflight.mjs "$NATIVE_CONFIG_DIR" "$NATIVE_STATE_DIR"
    fi
    install -d -m 700 -o "$APP_UID" -g "$APP_UID" "$ROOT/sessions"
    if docker container inspect "$NAME" >/dev/null 2>&1; then
      docker stop --time -1 "$NAME" >/dev/null
      docker rm "$NAME" >/dev/null
    fi
    docker run -d --name "$NAME" \
      --user "$APP_UID:$APP_UID" --init --restart unless-stopped \
      --read-only --cap-drop ALL --security-opt no-new-privileges:true \
      --tmpfs "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=$APP_UID,gid=$APP_UID,mode=0700" \
      --mount "type=bind,source=$ROOT/sessions,target=/app/sessions" \
      --env-file "$ROOT/worker.env" \
      --env "HERMES_ZALO_NATIVE_CONFIG=$native_config" \
      "${native_mounts[@]}" \
      --memory 384m --memory-reservation 96m --cpus 0.5 --pids-limit 128 \
      --stop-timeout -1 \
      --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
      --label com.ihomecrm.component=zalo-worker \
      "$image_id"
    ;;
  stop)
    docker stop --time -1 "$NAME"
    ;;
  *)
    echo "dùng: $0 build <thư mục> <sha> | run <image> [--native] | stop" >&2
    exit 2
    ;;
esac
