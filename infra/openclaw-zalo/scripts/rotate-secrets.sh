#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
infra_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
runtime_root=${OPENCLAW_RUNTIME_ROOT:-/srv/openclaw-runtime}
runtime_env=
name=
source_file=
session_rotation_started=0
cell_was_running=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-env) [ "$#" -ge 2 ] || exit 64; runtime_env=$2; shift 2 ;;
    --name) [ "$#" -ge 2 ] || exit 64; name=$2; shift 2 ;;
    --source-file) [ "$#" -ge 2 ] || exit 64; source_file=$2; shift 2 ;;
    *) echo "invalid rotation argument" >&2; exit 64 ;;
  esac
done

[ -n "$runtime_env" ] && [ "${runtime_env#/}" != "$runtime_env" ] && [ -f "$runtime_env" ] || {
  echo "--runtime-env must be an existing absolute trusted metadata file" >&2
  exit 64
}
[ -n "$source_file" ] && [ -f "$source_file" ] || { echo "--source-file is required" >&2; exit 64; }
case "$name" in
  openclaw_session_key|openclaw_zalo_bridge_hmac|openclaw_customer_ai_key|openclaw_runtime_credential|openclaw_gateway_device_token|openclaw_gateway_device_identity|openclaw_qr_encryption_key|openclaw_maintenance_credential|openclaw_audit_private_key) ;;
  *) echo "secret name is not reviewed" >&2; exit 64 ;;
esac
"$script_dir/render-cell.sh" --runtime-env "$runtime_env" >/dev/null
cell_id=$(sed -n 's/^OPENCLAW_CELL_ID=//p' "$runtime_env")
project="openclaw-zalo-$cell_id"
secret_dir="$runtime_root/secrets/$cell_id"
install -d -m 0700 "$secret_dir"

compose() {
  docker compose --project-name "$project" --env-file "$runtime_env" \
    -f "$infra_dir/compose.cell.yaml" "$@"
}

resume_after_rotation_failure() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$session_rotation_started" -eq 1 ] && [ "$cell_was_running" -eq 1 ]; then
    compose up -d --no-build --wait cell || echo "failed to restart cell after rotation error" >&2
  fi
  exit "$status"
}

if [ "$name" = "openclaw_session_key" ]; then
  trap resume_after_rotation_failure EXIT
  session_rotation_started=1
  if [ -n "$(compose ps -q cell)" ]; then
    cell_was_running=1
    compose stop --timeout 30 cell
  fi
  # Remove ciphertext while the old key is still installed. Any later failure
  # therefore leaves either the old usable pair or a clean QR-login state.
  compose run --rm --no-deps -T --entrypoint sh cell -c \
    'set -eu; rm -f /var/lib/openclaw-session/zalouser/credentials.json'
fi

tmp="$secret_dir/$name.tmp.$$"
install -m 0400 "$source_file" "$tmp"
[ -s "$tmp" ] || { rm -f "$tmp"; echo "secret cannot be empty" >&2; exit 1; }
sync -f "$tmp"
mv -f "$tmp" "$secret_dir/$name"
sync -f "$secret_dir"

if [ "$name" = "openclaw_session_key" ]; then
  if [ "$cell_was_running" -eq 1 ]; then
    compose up -d --no-build --wait cell
  fi
  session_rotation_started=0
  trap - EXIT
  echo "rotated $name for $cell_id; encrypted session cleared and QR login required"
else
  echo "rotated $name for $cell_id; restart the affected service"
fi
