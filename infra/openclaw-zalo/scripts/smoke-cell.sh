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

# The two probes above pass while the link between the containers is dead: the
# cell answers /healthz on its own loopback, and /readyz reports the Zalo channel
# rather than the Gateway socket - and it is allowed to answer 503 here anyway.
# An unpaired bridge therefore looked exactly like a working deploy while every
# runtime command, QR login included, was acknowledged and silently never run.
#
# `lastSeenAtMs` is only written once a device actually completes a connect, so
# it distinguishes a real channel from a device that was merely approved.
compose exec -T cell node - <<'GATEWAY_LINK'
const { execFileSync } = require("node:child_process");

const output = execFileSync("node", ["openclaw.mjs", "devices", "list", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
const devices = JSON.parse(output.slice(output.indexOf("{")));
const paired = Array.isArray(devices.paired) ? devices.paired : [];
const connected = paired.filter((device) =>
  device?.clientMode === "backend" &&
  Array.isArray(device?.scopes) && device.scopes.includes("operator.admin") &&
  Number.isFinite(device?.lastSeenAtMs)
);
if (connected.length === 0) {
  console.error("no bridge device has connected to the Gateway; the cell cannot receive runtime commands");
  process.exit(1);
}
const pending = Array.isArray(devices.pending) ? devices.pending : [];
if (pending.length > 0) {
  console.error(`Gateway has ${pending.length} unapproved pairing request(s); the bridge channel is not established`);
  process.exit(1);
}
GATEWAY_LINK

# The fork binds every bridge call to one CRM account and refuses a readiness
# request from any other with "readiness request does not match the cell
# binding". A channel account under a different name therefore starts, is
# refused, and auto-restarts with growing backoff until it gives up - while the
# cell stays healthy and the account row says CONNECTED. It cost a long hunt
# once: a provider left over from before the account binding was rendered kept
# calling itself "default" and no probe here noticed.
compose exec -T -e OPENCLAW_EXPECTED_ACCOUNT_ID="$(sed -n 's/^OPENCLAW_ACCOUNT_ID=//p' "$runtime_env")" cell node - <<'CHANNEL_BINDING'
const { execFileSync } = require("node:child_process");

const expected = process.env.OPENCLAW_EXPECTED_ACCOUNT_ID ?? "";
if (!/^[0-9a-f-]{36}$/.test(expected)) {
  console.error("expected Zalo account id is missing from the runtime metadata");
  process.exit(1);
}
const output = execFileSync("node", ["openclaw.mjs", "channels", "status", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
const status = JSON.parse(output.slice(output.indexOf("{")));
const accounts = status.channelAccounts?.zalouser ?? [];
// Not being logged in yet is fine - this is about identity, not readiness.
const strangers = accounts.filter((account) => account?.accountId !== expected);
if (strangers.length > 0) {
  const names = strangers.map((account) => account?.accountId ?? "unknown").join(", ");
  console.error(`the Zalo channel has accounts the cell is not bound to (${names}); every inbound commit from them is refused`);
  process.exit(1);
}
const bound = accounts.find((account) => account?.accountId === expected);
if (bound?.running === true && bound.lastError) {
  console.error(`the bound Zalo account is running with an error: ${bound.lastError}`);
  process.exit(1);
}
CHANNEL_BINDING

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
