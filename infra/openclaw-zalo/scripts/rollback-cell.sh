#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
infra_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
runtime_env=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-env) [ "$#" -ge 2 ] || exit 64; runtime_env=$2; shift 2 ;;
    *) echo "usage: rollback-cell.sh --runtime-env ABSOLUTE_PATH" >&2; exit 64 ;;
  esac
done

[ -n "$runtime_env" ] || { echo "--runtime-env is required" >&2; exit 64; }
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

/usr/bin/env -i PATH="$PATH" DOCKER_HOST="$docker_host" \
  docker compose --project-name "$project" --env-file "$runtime_env" \
  -f "$infra_dir/compose.cell.yaml" down --remove-orphans --timeout 30
echo "rolled back $project without deleting volumes"
