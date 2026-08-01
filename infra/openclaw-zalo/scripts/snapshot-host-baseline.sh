#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
infra_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
runtime_root=${OPENCLAW_RUNTIME_ROOT:-/srv/openclaw-runtime}
runtime_env=
output=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-env) [ "$#" -ge 2 ] || exit 64; runtime_env=$2; shift 2 ;;
    --output) [ "$#" -ge 2 ] || exit 64; output=$2; shift 2 ;;
    *) echo "invalid baseline argument" >&2; exit 64 ;;
  esac
done

[ -n "$runtime_env" ] && [ -f "$runtime_env" ] || { echo "--runtime-env is required" >&2; exit 64; }
[ -n "$output" ] && [ "${output#/}" != "$output" ] || { echo "--output must be absolute" >&2; exit 64; }
docker_host=${DOCKER_HOST:-}
case "$docker_host" in
  unix:///run/user/*/docker.sock) ;;
  *) echo "DOCKER_HOST must use the dedicated rootless Unix socket" >&2; exit 64 ;;
esac
docker_host_uid=${docker_host#unix:///run/user/}
docker_host_uid=${docker_host_uid%/docker.sock}
case "$docker_host_uid" in
  ''|*[!0-9]*) echo "DOCKER_HOST rootless UID is invalid" >&2; exit 64 ;;
esac
[ "$docker_host_uid" = "$(id -u)" ] || {
  echo "DOCKER_HOST must belong to the current rootless runner" >&2
  exit 64
}
cell_id=$(sed -n 's/^OPENCLAW_CELL_ID=//p' "$runtime_env")
project="openclaw-zalo-$cell_id"
model_url=https://ai.chillhome.io.vn
model_auth_file=${OPENCLAW_MODEL_PROBE_TOKEN_FILE:-/srv/openclaw-runtime/secrets/model-probe-token}
tmp="$output.tmp.$$"
mkdir -p "$(dirname "$output")"

ids=$(/usr/bin/env -i PATH="$PATH" DOCKER_HOST="$docker_host" \
  docker compose --project-name "$project" --env-file "$runtime_env" \
  -f "$infra_dir/compose.cell.yaml" ps -q)
containers='[]'
if [ -n "$ids" ]; then
  # Dedicated project only: Id, Image, Networks, Mounts, RestartCount, Ports.
  containers=$(docker inspect --format \
    '{"Id":{{json .Id}},"Image":{{json .Image}},"Networks":{{json .NetworkSettings.Networks}},"Mounts":{{json .Mounts}},"RestartCount":{{json .RestartCount}},"Ports":{{json .NetworkSettings.Ports}}}' \
    $ids | jq -s .)
fi
systemd_state=$(systemctl --user --no-pager --plain show "openclaw-stack@$cell_id.service" \
  -p ActiveState -p SubState -p NRestarts 2>/dev/null | jq -Rs .)
runtime_usage=$(df -Pk "$runtime_root" | jq -Rs .)
root_usage=$(df -Pk / | jq -Rs .)

probe='{"status":0,"latency":0,"error":1}'
if [ -f "$model_auth_file" ]; then
  probe=$(
    { printf 'header = "Authorization: Bearer '; tr -d '\r\n' <"$model_auth_file"; printf '"\n'; } | \
      curl --silent --show-error --output /dev/null --config - \
        --connect-timeout 5 --max-time 10 \
        --write-out '{"status":%{http_code},"latency":%{time_total},"error":%{exitcode}}' \
        "$model_url" || printf '{"status":0,"latency":0,"error":1}'
  )
fi

cat >"$tmp" <<EOF
{"schema":1,"cell_id":"$cell_id","project":"$project","captured_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","containers":$containers,"systemd":$systemd_state,"runtime_filesystem":$(printf '%s' "$runtime_usage" | jq -Rs .),"root_filesystem":$(printf '%s' "$root_usage" | jq -Rs .),"model_probe":$probe}
EOF
chmod 0600 "$tmp"
mv -f "$tmp" "$output"
echo "baseline captured without external host inspection"
