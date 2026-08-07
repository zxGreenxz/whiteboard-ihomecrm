#!/bin/sh
set -eu

umask 077

state_dir=${OPENCLAW_STATE_DIR:-/home/node/.openclaw}
config_path=${OPENCLAW_CONFIG_PATH:-/run/openclaw/openclaw.json}
plaintext_root=${OPENCLAW_SESSION_PLAINTEXT_ROOT:-/home/node/.openclaw/credentials}
persistent_root=${OPENCLAW_SESSION_CIPHERTEXT_ROOT:-/var/lib/openclaw-session}
internal_runs_dir=${OPENCLAW_INTERNAL_AGENT_RUNS_DIR:-/home/node/.openclaw/internal-agent-runs}
cell_id=${OPENCLAW_CELL_ID:?OPENCLAW_CELL_ID is required}
key_path=${OPENCLAW_SESSION_KEY_FILE:-/run/secrets/openclaw_session_key}
customer_ai_key_file=${OPENCLAW_CUSTOMER_AI_KEY_FILE:-/run/secrets/openclaw_customer_ai_key}
crypto_daemon=/opt/openclaw-cell/session-crypto/dist/daemon.js
session_path=zalouser/credentials.json
child_pid=
shutdown_signal=
child_status=0

case "$cell_id" in
  ????????-????-4???-[89abAB]???-????????????) ;;
  *) echo "OPENCLAW_CELL_ID must be a canonical UUID" >&2; exit 64 ;;
esac
[ "$key_path" = /run/secrets/openclaw_session_key ] || {
  echo "OPENCLAW_SESSION_KEY_FILE must use the fixed secret target" >&2
  exit 64
}

mkdir -p "$state_dir" "$plaintext_root" "$internal_runs_dir" "$(dirname "$config_path")"
chmod 700 "$plaintext_root" "$internal_runs_dir"

# Internal transcripts are a supported transient OpenClaw lifecycle artifact.
# Remove only direct regular JSONL files in the owned directory; never follow links.
cleanup_internal_runs() {
  find "$internal_runs_dir" -maxdepth 1 -type f -name '*.jsonl' -delete
}

crypto_request() {
  operation=$1
  expected=$2
  request_id=$3
  node "$crypto_daemon" \
    --cell-id "$cell_id" \
    --plaintext-root "$plaintext_root" \
    --persistent-root "$persistent_root" <<EOF
{"expectedEnvelopeVersion":$expected,"id":"$request_id","operation":"$operation","path":"$session_path","version":1}
EOF
}

response_ok() {
  node -e 'const value=JSON.parse(require("node:fs").readFileSync(0,"utf8"));if(!value.ok)process.exit(1)'
}

response_error_code() {
  node -e 'const value=JSON.parse(require("node:fs").readFileSync(0,"utf8"));process.stdout.write(typeof value?.error?.code === "string" ? value.error.code : "")'
}

session_restore() {
  [ -f "$persistent_root/zalouser/credentials.json" ] || return 0
  version=$(sha256sum "$persistent_root/zalouser/credentials.json" | awk '{print $1}')
  if response=$(crypto_request restore "\"$version\"" restore-start); then
    :
  fi
  if printf '%s\n' "$response" | response_ok; then
    return 0
  fi
  error_code=$(printf '%s\n' "$response" | response_error_code) || error_code=
  case "$error_code" in
    AUTHENTICATION_FAILED|UNKNOWN_KEY_GENERATION|MALFORMED_ENVELOPE)
      # A ciphertext that cannot be authenticated is unusable; start clean for QR login.
      rm -f \
        "$plaintext_root/zalouser/credentials.json" \
        "$persistent_root/zalouser/credentials.json"
      echo "encrypted Zalo session unavailable; starting QR login" >&2
      return 0
      ;;
    *)
      printf '%s\n' "$response" | response_ok
      ;;
  esac
}

session_persist() {
  [ -f "$plaintext_root/zalouser/credentials.json" ] || return 0
  expected=null
  if [ -f "$persistent_root/zalouser/credentials.json" ]; then
    expected="\"$(sha256sum "$persistent_root/zalouser/credentials.json" | awk '{print $1}')\""
  fi
  response=$(crypto_request persist "$expected" persist-shutdown)
  printf '%s\n' "$response" | response_ok
}

shutdown() {
  shutdown_signal=$1
  if [ -n "$child_pid" ]; then
    kill -"$shutdown_signal" "$child_pid" 2>/dev/null || true
  fi
}

cleanup() {
  status=$?
  trap - EXIT
  session_persist || status=$?
  cleanup_internal_runs
  rm -f "$plaintext_root/zalouser/credentials.json"
  exit "$status"
}

wait_for_child() {
  while :; do
    if wait "$child_pid"; then
      child_status=0
    else
      child_status=$?
    fi
    # A signal can interrupt wait before the child has flushed its final state.
    if kill -0 "$child_pid" 2>/dev/null; then
      continue
    fi
    return "$child_status"
  done
}

# OpenClaw only ever finds a managed npm plugin under the directory name it
# derives itself from the package name, and only through install records it
# wrote. The vendored fork lives under a name that derivation never produces, so
# it is claimed by plugins.load.paths in the config template - and verified here.
# Without this the gateway treats "zalouser" as missing and repairs it by
# installing the stock package from the public registry: it loads, it answers
# messages, and it drops every one of them because it has no bridge dispatch.
# Fail closed, before the traps that would rewrite session material.
plugin_root=${OPENCLAW_ZALOUSER_PLUGIN_ROOT:-/home/node/.openclaw/npm/projects/zalouser/node_modules/@openclaw/zalouser}
node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const root = process.argv[1];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch (error) {
    console.error(`zalouser plugin is unreadable at ${root}: ${error.message}`);
    process.exit(1);
  }
  if (manifest.name !== "@openclaw/zalouser") {
    console.error(`zalouser plugin at ${root} is "${manifest.name}", not @openclaw/zalouser`);
    process.exit(1);
  }
  const apiPath = path.join(root, "dist", "behavior-contract-api.js");
  let api;
  try {
    api = fs.readFileSync(apiPath, "utf8");
  } catch (error) {
    console.error(`zalouser bridge contract is unreadable at ${apiPath}: ${error.message}`);
    process.exit(1);
  }
  if (!api.includes("commitAndDispatchInbound")) {
    console.error(`zalouser plugin at ${root} is the stock upstream build: it has no commitAndDispatchInbound, so inbound messages never reach the bridge`);
    process.exit(1);
  }
' "$plugin_root"

trap 'shutdown TERM' TERM
trap 'shutdown INT' INT
trap cleanup EXIT

cleanup_internal_runs
if [ -f "$crypto_daemon" ] && [ -f "$persistent_root/zalouser/credentials.json" ]; then
  session_restore
fi

if [ ! -f "$config_path" ]; then
  cp /opt/openclaw-cell/openclaw.json.tmpl "$config_path"
  chmod 600 "$config_path"
fi

if [ -f "$customer_ai_key_file" ]; then
  OPENCLAW_ZALO_CUSTOMER_AI_API_KEY=$(tr -d '\r\n' <"$customer_ai_key_file")
  [ -n "$OPENCLAW_ZALO_CUSTOMER_AI_API_KEY" ] || {
    echo "customer AI key file is empty" >&2
    exit 1
  }
  export OPENCLAW_ZALO_CUSTOMER_AI_API_KEY
fi

# The load path makes OpenClaw load the fork, but OpenClaw only trusts a plugin
# it holds an install record for. With no record the startup convergence treats
# the configured plugin as missing and installs @openclaw/zalouser from the
# public registry; the egress broker denies that by design, and the gateway then
# refuses to report ready. A record recovered from the managed npm tree is worse:
# it is typed "npm" and chased for updates over the same blocked route on every
# boot. Claiming the fork through OpenClaw's own linker records a "path" install,
# the one source no update path follows. Idempotent by design.
claim_state=$(node -e '
  const path = require("node:path");
  const { DatabaseSync } = require("node:sqlite");
  try {
    const db = new DatabaseSync(path.join(process.argv[1], "state", "openclaw.sqlite"), { readOnly: true });
    for (const row of db.prepare("select install_records_json from installed_plugin_index").all()) {
      const record = JSON.parse(row.install_records_json ?? "{}").zalouser;
      if (record && record.source !== "npm") {
        process.stdout.write("claimed");
        process.exit(0);
      }
    }
  } catch {}
  process.stdout.write("unclaimed");
' "$state_dir")
if [ "$claim_state" = unclaimed ]; then
  node openclaw.mjs plugins install --link "$plugin_root" >&2 || {
    echo "could not claim the vendored zalouser fork as a linked plugin install" >&2
    exit 1
  }
fi

if [ "$#" -eq 0 ]; then
  set -- node openclaw.mjs gateway
fi
"$@" &
child_pid=$!
if wait_for_child; then
  :
fi
exit "$child_status"
