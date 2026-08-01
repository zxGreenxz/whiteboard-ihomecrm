#!/bin/sh
set -eu

runtime_root=${OPENCLAW_RUNTIME_ROOT:-/srv/openclaw-runtime}
runtime_env=
name=
source_file=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-env) [ "$#" -ge 2 ] || exit 64; runtime_env=$2; shift 2 ;;
    --name) [ "$#" -ge 2 ] || exit 64; name=$2; shift 2 ;;
    --source-file) [ "$#" -ge 2 ] || exit 64; source_file=$2; shift 2 ;;
    *) echo "invalid rotation argument" >&2; exit 64 ;;
  esac
done

[ -n "$runtime_env" ] && [ -f "$runtime_env" ] || { echo "--runtime-env is required" >&2; exit 64; }
[ -n "$source_file" ] && [ -f "$source_file" ] || { echo "--source-file is required" >&2; exit 64; }
case "$name" in
  openclaw_session_key|openclaw_zalo_bridge_hmac|openclaw_customer_ai_key|openclaw_runtime_credential|openclaw_gateway_device_token|openclaw_gateway_device_identity|openclaw_qr_encryption_key|openclaw_maintenance_credential|openclaw_audit_private_key) ;;
  *) echo "secret name is not reviewed" >&2; exit 64 ;;
esac
cell_id=$(sed -n 's/^OPENCLAW_CELL_ID=//p' "$runtime_env")
secret_dir="$runtime_root/secrets/$cell_id"
install -d -m 0700 "$secret_dir"
tmp="$secret_dir/$name.tmp.$$"
install -m 0400 "$source_file" "$tmp"
[ -s "$tmp" ] || { rm -f "$tmp"; echo "secret cannot be empty" >&2; exit 1; }
mv -f "$tmp" "$secret_dir/$name"
echo "rotated $name for $cell_id; restart the cell and re-login if session re-encryption is unavailable"
