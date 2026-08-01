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
node_path=/opt/openclaw-tools/node-v24.15.0-linux-x64/bin/node
active_secret_snapshot=

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
cell_id=$(sed -n 's/^OPENCLAW_CELL_ID=//p' "$runtime_env")
case "$cell_id" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo "OPENCLAW_CELL_ID must be a canonical UUID" >&2; exit 64 ;;
esac
[ "$(grep -c '^OPENCLAW_CELL_ID=' "$runtime_env")" -eq 1 ] || {
  echo "runtime metadata contains duplicate cell identity" >&2
  exit 64
}
project="openclaw-zalo-$cell_id"
secret_dir="$runtime_root/secrets/$cell_id"
install -d -m 0700 "$secret_dir"
tmp="$secret_dir/$name.tmp.$$"
cleanup_candidate() {
  status=$?
  trap - EXIT
  if [ -n "$tmp" ] && [ -f "$tmp" ]; then rm -f "$tmp"; fi
  exit "$status"
}
trap cleanup_candidate EXIT
install -m 0400 "$source_file" "$tmp"
[ -s "$tmp" ] || { echo "secret cannot be empty" >&2; exit 1; }
sync -f "$tmp"

if [ "$name" = "openclaw_session_key" ]; then
  [ -x "$node_path" ] || { echo "pinned Node runtime is unavailable" >&2; exit 1; }
  [ "$("$node_path" --version)" = "v24.15.0" ] || {
    echo "pinned Node runtime version mismatch" >&2
    exit 1
  }
  "$node_path" "$script_dir/validate-session-key.mjs" --candidate "$tmp"
fi

"$script_dir/render-cell.sh" --runtime-env "$runtime_env" >/dev/null

resolve_active_secret_snapshot() {
  deployment_root="$runtime_root/operations/$cell_id/deployments"
  current_pointer="$deployment_root/current"
  if [ ! -e "$current_pointer" ] && [ ! -L "$current_pointer" ]; then
    active_secret_snapshot=
    return 0
  fi
  [ -f "$current_pointer" ] && [ ! -L "$current_pointer" ] && \
    [ "$(stat -c %a "$current_pointer")" = "600" ] || {
    echo "active deployment snapshot pointer is invalid" >&2
    return 1
  }
  snapshot_name=$(sed -n '1p' "$current_pointer")
  [ "$(wc -l < "$current_pointer")" -eq 1 ] || {
    echo "active deployment snapshot pointer is invalid" >&2
    return 1
  }
  case "$snapshot_name" in
    snapshot-*) ;;
    *) echo "active deployment snapshot pointer is invalid" >&2; return 1 ;;
  esac
  case "$snapshot_name" in
    *[!0-9A-Za-z._-]*) echo "active deployment snapshot pointer is invalid" >&2; return 1 ;;
  esac
  active_secret_snapshot="$runtime_root/secrets/$cell_id/.deployments/$snapshot_name"
  [ -d "$active_secret_snapshot" ] && [ ! -L "$active_secret_snapshot" ] && \
    [ -s "$active_secret_snapshot/$name" ] && [ ! -L "$active_secret_snapshot/$name" ] && \
    [ "$(stat -c %a "$active_secret_snapshot/$name")" = "400" ] || {
    echo "active deployment secret snapshot is invalid" >&2
    return 1
  }
}

update_active_secret_snapshot() {
  [ -n "$active_secret_snapshot" ] || return 0
  snapshot_backup="$active_secret_snapshot/$name.backup.$$"
  snapshot_update="$active_secret_snapshot/$name.update.$$"
  if ! install -m 0400 "$active_secret_snapshot/$name" "$snapshot_backup" ||
    ! sync -f "$snapshot_backup"
  then
    rm -f "$snapshot_backup"
    live_restore="$secret_dir/$name.restore.$$"
    if install -m 0400 "$active_secret_snapshot/$name" "$live_restore" &&
      sync -f "$live_restore" &&
      mv -f "$live_restore" "$secret_dir/$name" &&
      sync -f "$secret_dir"
    then
      echo "failed to prepare deployment snapshot update; restored prior key" >&2
      return 1
    fi
    rm -f "$current_pointer" "$live_restore"
    echo "secret rollback failed; deployment snapshot invalidated" >&2
    return 1
  fi
  if install -m 0400 "$secret_dir/$name" "$snapshot_update" &&
    sync -f "$snapshot_update" &&
    mv -f "$snapshot_update" "$active_secret_snapshot/$name" &&
    sync -f "$active_secret_snapshot"
  then
    rm -f "$snapshot_backup"
    sync -f "$active_secret_snapshot"
    return 0
  else
    update_status=$?
  fi

  echo "failed to update active deployment secret snapshot; restoring prior key" >&2
  snapshot_restore="$active_secret_snapshot/$name.restore.$$"
  live_restore="$secret_dir/$name.restore.$$"
  if install -m 0400 "$snapshot_backup" "$snapshot_restore" &&
    sync -f "$snapshot_restore" &&
    mv -f "$snapshot_restore" "$active_secret_snapshot/$name" &&
    sync -f "$active_secret_snapshot" &&
    install -m 0400 "$snapshot_backup" "$live_restore" &&
    sync -f "$live_restore" &&
    mv -f "$live_restore" "$secret_dir/$name" &&
    sync -f "$secret_dir"
  then
    rm -f "$snapshot_backup" "$snapshot_update"
    return "$update_status"
  fi
  rm -f "$current_pointer" "$snapshot_backup" "$snapshot_update" "$snapshot_restore" "$live_restore"
  echo "secret rollback failed; deployment snapshot invalidated" >&2
  return 1
}

compose() {
  docker compose --project-name "$project" --env-file "$runtime_env" \
    -f "$infra_dir/compose.cell.yaml" "$@"
}

resume_after_rotation_failure() {
  status=$?
  trap - EXIT
  if [ -n "$tmp" ] && [ -f "$tmp" ]; then rm -f "$tmp"; fi
  if [ "$status" -ne 0 ] && [ "$session_rotation_started" -eq 1 ] && [ "$cell_was_running" -eq 1 ]; then
    compose up -d --no-build --force-recreate --no-deps --wait cell || echo "failed to recreate cell after rotation error" >&2
  fi
  exit "$status"
}

resolve_active_secret_snapshot
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

mv -f "$tmp" "$secret_dir/$name"
tmp=
sync -f "$secret_dir"
update_active_secret_snapshot

if [ "$name" = "openclaw_session_key" ]; then
  if [ "$cell_was_running" -eq 1 ]; then
    compose up -d --no-build --force-recreate --no-deps --wait cell
  fi
  session_rotation_started=0
  trap - EXIT
  echo "rotated $name for $cell_id; encrypted session cleared and QR login required"
else
  trap - EXIT
  echo "rotated $name for $cell_id; restart the affected service"
fi
