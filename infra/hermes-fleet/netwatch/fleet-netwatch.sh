#!/usr/bin/env bash
# Canh mạng cho MỌI sidecar Hermes (nhãn com.ihomecrm.component=hermes-sidecar), thay cho hermes-owner-netwatch.sh vốn chỉ biết một
# container. Sidecar dùng chung network namespace với worker Zalo: worker bị Docker dựng lại (cùng ID) thì sidecar mất mạng tới nhà
# cung cấp model cho tới khi được `docker restart`. Worker bị THAY (ID mới) thì restart không cứu được: bộ canh chỉ ghi một dòng
# mức err và để quản trị chạy `fleet.mjs tao-lai-sidecar`.
# Chỉ restart khi host gọi được nhà cung cấp mà trong container không gọi được ở HAI lần đo cách nhau RETRY_SLEEP giây.
set -u
PROBE_URL="${PROBE_URL:-http://172.17.0.1:20128/v1/models}"
HOST_URL="${HOST_URL:-http://127.0.0.1:20128/v1/models}"
WORKER="${WORKER:-ihome-zalo-worker}"
DOCKER="${DOCKER:-docker}"; CURL="${CURL:-curl}"; LOGGER="${LOGGER:-logger}"; RETRY_SLEEP="${RETRY_SLEEP:-20}"
TAG=ihome-hermes-fleet-netwatch
inner() { "$DOCKER" exec "$1" sh -c "curl -s -m 10 -o /dev/null -w '%{http_code}' $PROBE_URL" 2>/dev/null; }

# Nhà cung cấp hỏng từ phía host: không phải việc của bộ canh này.
[ "$("$CURL" -s -m 10 -o /dev/null -w '%{http_code}' "$HOST_URL" 2>/dev/null)" = 200 ] || exit 0
worker_id="$("$DOCKER" inspect --format '{{.Id}}' "$WORKER" 2>/dev/null)" || exit 0
bad=""
for name in $("$DOCKER" ps --filter "label=com.ihomecrm.component=hermes-sidecar" --format '{{.Names}}'); do
  # Tên lạ không bao giờ được đưa vào lệnh.
  [[ "$name" =~ ^[a-z0-9][a-z0-9_.-]{0,62}$ ]] || continue
  [ "$(inner "$name")" = 200 ] || bad="$bad $name"
done
[ -n "$bad" ] || exit 0
sleep "$RETRY_SLEEP"
for name in $bad; do
  [ "$(inner "$name")" = 200 ] && continue
  net="$("$DOCKER" inspect --format '{{.HostConfig.NetworkMode}}' "$name" 2>/dev/null)"
  if [ "$net" != "container:$worker_id" ]; then
    "$LOGGER" -p user.err -t "$TAG" "$name bam network namespace cua worker cu: can chay fleet.mjs tao-lai-sidecar (restart khong cuu duoc)"
    continue
  fi
  "$LOGGER" -t "$TAG" "$name mat mang toi nha cung cap model (host van goi duoc): docker restart $name"
  "$DOCKER" restart "$name" >/dev/null
done
exit 0
