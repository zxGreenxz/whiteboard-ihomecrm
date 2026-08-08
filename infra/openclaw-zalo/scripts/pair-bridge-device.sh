#!/bin/sh
set -eu

# Approve the bridge as a paired Gateway device - deterministically, at deploy
# time, bound to the one device id the bridge can prove it holds.
#
# The Gateway refuses an unknown device with NOT_PAIRED and closes the socket
# with 1008, logging only `reason=n/a phase=auth_validated`. Both containers stay
# "healthy" while the channel between them is dead: the bridge keeps talking to
# the server, the cell keeps answering /healthz, and every runtime command the
# owner issues - QR login above all - is accepted, acknowledged, and then never
# executed, because nothing can reach the cell to execute it. A cell whose state
# volume is new (a rebuild, or a move to another organization) starts unpaired,
# so this is not a one-time bring-up step; it belongs in every deploy.
#
# The Gateway's own CIDR auto-approval deliberately does not cover this device:
# it applies only to role "node" with no scopes, and the bridge asks for
# operator/operator.admin. Approving an operator-admin device is meant to be a
# deliberate act, so it is spelled out here rather than widened in config.
#
# The expected device id is derived inside the bridge container from the
# identity secret it already holds, so no private key crosses a boundary; only
# the public device id does. A pairing request from any other device is refused
# outright rather than approved, and leaves this script failing loudly.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
infra_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
runtime_env=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-env) [ "$#" -ge 2 ] || exit 64; runtime_env=$2; shift 2 ;;
    *) echo "invalid pairing argument" >&2; exit 64 ;;
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

# Same derivation the bridge uses when it presents itself: the raw Ed25519 key
# out of the SPKI wrapper, and the device id is its SHA-256. Deriving it here
# instead of trusting a configured value means a rotated identity cannot pair a
# stale device id by accident.
device_id=$(compose exec -T bridge node - <<'DERIVE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
const identity = JSON.parse(fs.readFileSync(process.env.OPENCLAW_GATEWAY_DEVICE_IDENTITY_FILE, "utf8"));
const der = crypto.createPublicKey(identity.publicKeyPem).export({ type: "spki", format: "der" });
if (der.byteLength !== spkiPrefix.byteLength + 32 || !der.subarray(0, spkiPrefix.byteLength).equals(spkiPrefix)) {
  console.error("bridge device public key is not an Ed25519 SPKI key");
  process.exit(1);
}
const raw = der.subarray(spkiPrefix.byteLength);
const derived = crypto.createHash("sha256").update(raw).digest("hex");
if (identity.deviceId !== derived) {
  console.error("bridge device identity does not match its own public key");
  process.exit(1);
}
process.stdout.write(derived);
DERIVE
)
device_id=$(printf '%s' "$device_id" | tr -d '\r\n')
case "$device_id" in
  *[!0-9a-f]*|'') echo "bridge device id is invalid" >&2; exit 1 ;;
esac
[ "${#device_id}" -eq 64 ] || { echo "bridge device id is invalid" >&2; exit 1; }

compose exec -T -e OPENCLAW_EXPECTED_BRIDGE_DEVICE_ID="$device_id" cell node - <<'PAIR'
const { execFileSync } = require("node:child_process");

const expected = process.env.OPENCLAW_EXPECTED_BRIDGE_DEVICE_ID ?? "";
if (!/^[0-9a-f]{64}$/.test(expected)) {
  console.error("expected bridge device id is invalid");
  process.exit(1);
}

// Config warnings go to stderr; --json keeps stdout a single document.
function inventory() {
  const output = execFileSync("node", ["openclaw.mjs", "devices", "list", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(output.slice(output.indexOf("{")));
}

function sleepMs(duration) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

const configuredTimeout = Number(process.env.OPENCLAW_PAIRING_TIMEOUT_MS ?? "");
const timeoutMs = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
  ? configuredTimeout
  : 60_000;
const deadline = Date.now() + timeoutMs;
for (;;) {
  const devices = inventory();
  const paired = Array.isArray(devices.paired) ? devices.paired : [];
  if (paired.some((device) => device?.deviceId === expected)) {
    console.log(`bridge device is paired: ${expected}`);
    process.exit(0);
  }
  const pending = Array.isArray(devices.pending) ? devices.pending : [];
  const foreign = pending.filter((request) => request?.deviceId !== expected);
  if (foreign.length > 0) {
    // Never approve what we cannot attribute to this stack's own bridge.
    const ids = foreign.map((request) => request?.deviceId ?? "unknown").join(", ");
    console.error(`refusing to pair: an unexpected device requested pairing (${ids})`);
    process.exit(1);
  }
  const request = pending.find((entry) => entry?.deviceId === expected);
  if (request) {
    const requestId = request.requestId ?? request.id;
    if (typeof requestId !== "string" || requestId.length === 0) {
      console.error("pending pairing request has no request id");
      process.exit(1);
    }
    execFileSync("node", ["openclaw.mjs", "devices", "approve", requestId, "--json"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    continue;
  }
  if (Date.now() >= deadline) {
    console.error("the bridge never requested Gateway pairing; the cell is unreachable from the bridge");
    process.exit(1);
  }
  sleepMs(2_000);
}
PAIR
