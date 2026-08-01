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

session_restore() {
  [ -f "$persistent_root/zalouser/credentials.json" ] || return 0
  version=$(sha256sum "$persistent_root/zalouser/credentials.json" | awk '{print $1}')
  response=$(crypto_request restore "\"$version\"" restore-start)
  printf '%s\n' "$response" | response_ok
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

if [ "$#" -eq 0 ]; then
  set -- node openclaw.mjs gateway
fi
"$@" &
child_pid=$!
wait "$child_pid"
