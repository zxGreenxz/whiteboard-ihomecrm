#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
infra_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
demo_cell_id=dddd2000-0000-4000-8000-000000000001
runtime_env=
caller_cell_id=
session_encryption=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-env) [ "$#" -ge 2 ] || exit 64; runtime_env=$2; shift 2 ;;
    --cell-id) [ "$#" -ge 2 ] || exit 64; caller_cell_id=$2; shift 2 ;;
    --session-encryption) session_encryption=1; shift ;;
    *) echo "invalid isolation argument" >&2; exit 64 ;;
  esac
done

if [ -n "$caller_cell_id" ]; then
  [ "$caller_cell_id" = "$demo_cell_id" ] || {
    echo "--cell-id is reserved for the documented DEMO contract vector" >&2
    exit 64
  }
  cell_id=$caller_cell_id
  [ -n "$runtime_env" ] || runtime_env="/srv/openclaw-runtime/cells/$cell_id/runtime.env"
else
  [ -n "$runtime_env" ] && [ -f "$runtime_env" ] || {
    echo "production verification requires trusted runtime metadata" >&2
    exit 64
  }
  cell_id=$(sed -n 's/^OPENCLAW_CELL_ID=//p' "$runtime_env")
fi
[ "$(sed -n 's/^OPENCLAW_CELL_ID=//p' "$runtime_env")" = "$cell_id" ] || {
  echo "cell identity mismatch" >&2
  exit 1
}
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

project="openclaw-zalo-$cell_id"
compose() {
  /usr/bin/env -i PATH="$PATH" DOCKER_HOST="$docker_host" \
    docker compose --project-name "$project" --env-file "$runtime_env" \
    -f "$infra_dir/compose.cell.yaml" "$@"
}

assert_app_isolated() {
  service=$1
  compose exec -T "$service" sh -c \
    'test ! -e /var/run/docker.sock && test ! -e /run/docker.sock && ! awk '\''$2 == "00000000" { found=1 } END { exit found ? 0 : 1 }'\'' /proc/net/route'
  compose exec -T "$service" node -e \
    'const net=require("node:net");const targets=[["169.254.169.254",80],["172.17.0.1",2375],["192.168.1.1",22]];let left=targets.length;for(const [host,port] of targets){const s=net.connect({host,port});const fail=()=>{s.destroy();if(--left===0)process.exit(0)};s.setTimeout(1000,fail);s.once("error",fail);s.once("connect",()=>process.exit(1))}'
  compose exec -T "$service" node -e \
    'const net=require("node:net");const s=net.connect({host:"egress-broker",port:8080});s.setTimeout(2000,()=>process.exit(1));s.once("error",()=>process.exit(1));s.once("connect",()=>{s.destroy();process.exit(0)})'
  compose exec -T "$service" node --use-env-proxy -e \
    'fetch("https://ai.chillhome.io.vn",{method:"HEAD",signal:AbortSignal.timeout(10000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))'
}

# host-gateway, metadata, private ranges and docker.sock must remain blocked.
compose exec -T cell true
compose exec -T bridge true
compose exec -T maintenance true
assert_app_isolated cell
assert_app_isolated bridge
assert_app_isolated maintenance

for service in cell bridge maintenance egress-broker; do
  container_id=$(compose ps -q "$service")
  [ -n "$container_id" ] || { echo "service is not running" >&2; exit 1; }
  docker inspect --format '{{json .HostConfig.PortBindings}}|{{json .Mounts}}|{{json .HostConfig.SecurityOpt}}' \
    "$container_id" | grep -q '^null|' || { echo "host ports detected" >&2; exit 1; }
done

# dns-rebinding and allowed-route behavior are image build-gate contracts; the
# live check above consumes only the broker's public CONNECT surface, not a new RPC.
if [ "$session_encryption" -eq 1 ]; then
  "$script_dir/smoke-cell.sh" --runtime-env "$runtime_env" --session-encryption
fi

echo "rootless isolation verified for $project"
