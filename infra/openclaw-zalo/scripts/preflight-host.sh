#!/bin/sh
set -eu

runtime_root=${OPENCLAW_RUNTIME_ROOT:-/srv/openclaw-runtime}
runner_user=${OPENCLAW_RUNNER_USER:-openclaw-runner}
runner_uid=$(id -u "$runner_user")
rootless_socket="/run/user/$runner_uid/docker.sock"
quota_record=${OPENCLAW_TRANSFER_QUOTA_RECORD:-$runtime_root/operations/transfer-quota.json}

[ "$(id -un)" = "$runner_user" ] || {
  echo "preflight must run as $runner_user" >&2
  exit 1
}
[ -S "$rootless_socket" ] || { echo "rootless Docker socket is unavailable" >&2; exit 1; }
[ "${DOCKER_HOST:-}" = "unix://$rootless_socket" ] || {
  echo "DOCKER_HOST must select the dedicated rootless socket" >&2
  exit 1
}
[ -d "$runtime_root" ] || { echo "$runtime_root is missing" >&2; exit 1; }
[ -f "$quota_record" ] || { echo "OPENCLAW_TRANSFER_QUOTA_RECORD is missing" >&2; exit 1; }

# The reviewed runtime filesystem is 20 GiB (20971520 KiB), never host root.
runtime_kib=$(df -Pk "$runtime_root" | awk 'NR==2 {print $2}')
[ "$runtime_kib" -le 20971520 ] || { echo "runtime filesystem exceeds 20 GiB" >&2; exit 1; }
mountpoint -q "$runtime_root" || { echo "$runtime_root must be a dedicated mount" >&2; exit 1; }

info=$(docker info --format '{{json .SecurityOptions}}|{{.DockerRootDir}}')
printf '%s' "$info" | grep -q rootless || { echo "SecurityOptions does not report rootless" >&2; exit 1; }
printf '%s' "$info" | grep -q "|$runtime_root/docker" || {
  echo "Docker data root is outside the runtime filesystem" >&2
  exit 1
}

for path in "$runtime_root/docker" "$runtime_root/cells" "$runtime_root/config" \
  "$runtime_root/secrets" "$runtime_root/logs" "$runtime_root/operations"; do
  [ -d "$path" ] || { echo "required runtime directory is missing" >&2; exit 1; }
done

echo "rootless OpenClaw host preflight passed"
