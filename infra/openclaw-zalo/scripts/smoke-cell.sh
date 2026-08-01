#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
infra_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
runtime_env=
session_encryption=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-env) [ "$#" -ge 2 ] || exit 64; runtime_env=$2; shift 2 ;;
    --session-encryption) session_encryption=1; shift ;;
    *) echo "invalid smoke argument" >&2; exit 64 ;;
  esac
done

[ -n "$runtime_env" ] && [ -f "$runtime_env" ] || { echo "--runtime-env is required" >&2; exit 64; }
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
compose() {
  /usr/bin/env -i PATH="$PATH" DOCKER_HOST="$docker_host" \
    docker compose --project-name "$project" --env-file "$runtime_env" \
    -f "$infra_dir/compose.cell.yaml" "$@"
}

compose exec -T cell node -e \
  "fetch('http://127.0.0.1:18789/healthz',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
compose exec -T bridge node -e \
  "fetch('http://127.0.0.1:8080/readyz',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

if [ "$session_encryption" -eq 1 ]; then
  compose exec -T cell sh -s -- "$cell_id" <<'CELL_SMOKE'
set -eu
cell_id=$1
plain_root=/home/node/.openclaw/credentials
cipher_root=/var/lib/openclaw-session
logical=canary/synthetic-canary.json
daemon=/opt/openclaw-cell/session-crypto/dist/daemon.js
plain=$plain_root/$logical
cipher=$cipher_root/$logical
mkdir -p "$(dirname "$plain")"
printf '{"kind":"synthetic-session-canary","value":"not-a-zalo-credential"}\n' >"$plain"
chmod 0600 "$plain"

request() {
  operation=$1
  expected=$2
  request_id=$3
  printf '{"expectedEnvelopeVersion":%s,"id":"%s","operation":"%s","path":"%s","version":1}\n' \
    "$expected" "$request_id" "$operation" "$logical" | \
    node "$daemon" --cell-id "$cell_id" --plaintext-root "$plain_root" --persistent-root "$cipher_root"
}
ok() {
  node -e 'const r=JSON.parse(require("node:fs").readFileSync(0,"utf8"));if(!r.ok)process.exit(1)'
}

request persist null persist-canary | ok
grep -a -q 'synthetic-session-canary' "$cipher" && exit 1
version=$(sha256sum "$cipher" | awk '{print $1}')
rm -f "$plain"
request restore "\"$version\"" restore-canary | ok
grep -q 'synthetic-session-canary' "$plain"
version=$(sha256sum "$cipher" | awk '{print $1}')
request rotate "\"$version\"" rotate-canary | ok
version=$(sha256sum "$cipher" | awk '{print $1}')
printf 'tamper' >>"$cipher"
if request restore "\"$version\"" tamper-canary | ok; then
  exit 1
fi
rm -f "$plain" "$cipher"
rmdir "$(dirname "$plain")" "$(dirname "$cipher")" 2>/dev/null || true
CELL_SMOKE
fi

echo "cell smoke checks passed"
