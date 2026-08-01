#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
infra_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
runtime_root=${OPENCLAW_RUNTIME_ROOT:-/srv/openclaw-runtime}
runtime_env=
name=
source_file=
rotation_started=0
affected_services=
running_services=
node_path=/opt/openclaw-tools/node-v24.15.0-linux-x64/bin/node
active_secret_snapshot=
current_pointer=
live_backup=
snapshot_backup=
snapshot_update=
snapshot_restore=
live_restore=

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
case "$name" in
  openclaw_session_key) affected_services=cell ;;
  openclaw_zalo_bridge_hmac) affected_services="cell bridge" ;;
  openclaw_customer_ai_key) affected_services=cell ;;
  openclaw_runtime_credential|openclaw_gateway_device_token|openclaw_gateway_device_identity|openclaw_qr_encryption_key) affected_services=bridge ;;
  openclaw_maintenance_credential|openclaw_audit_private_key) affected_services=maintenance ;;
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
rm -f \
  "$secret_dir/$name.backup."* \
  "$secret_dir/$name.restore."* \
  "$secret_dir/$name.rollback."* \
  "$secret_dir/$name.tmp."*
sync -f "$secret_dir"
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
    [ -f "$active_secret_snapshot/$name" ] && [ ! -L "$active_secret_snapshot/$name" ] && \
    [ -s "$active_secret_snapshot/$name" ] && \
    [ "$(stat -c %u "$active_secret_snapshot/$name")" = "$(id -u)" ] && \
    [ "$(stat -c %a "$active_secret_snapshot/$name")" = "400" ] || {
    echo "active deployment secret snapshot is invalid" >&2
    return 1
  }
}

prepare_rotation_backups() {
  [ -f "$secret_dir/$name" ] && [ ! -L "$secret_dir/$name" ] && \
    [ -s "$secret_dir/$name" ] && \
    [ "$(stat -c %u "$secret_dir/$name")" = "$(id -u)" ] && \
    [ "$(stat -c %a "$secret_dir/$name")" = "400" ] || {
    echo "active secret must be a runner-owned 0400 regular file" >&2
    return 1
  }
  live_backup="$secret_dir/$name.backup.$$"
  if ! install -m 0400 "$secret_dir/$name" "$live_backup" || ! sync -f "$live_backup"; then
    rm -f "$live_backup"
    live_backup=
    return 1
  fi
  [ -n "$active_secret_snapshot" ] || return 0
  rm -f \
    "$active_secret_snapshot/$name.backup."* \
    "$active_secret_snapshot/$name.update."* \
    "$active_secret_snapshot/$name.restore."*
  snapshot_backup="$active_secret_snapshot/$name.backup.$$"
  if ! install -m 0400 "$active_secret_snapshot/$name" "$snapshot_backup" ||
    ! sync -f "$snapshot_backup"
  then
    rm -f "$live_backup" "$snapshot_backup"
    live_backup=
    snapshot_backup=
    return 1
  fi
}

update_active_secret_snapshot() {
  [ -n "$active_secret_snapshot" ] || return 0
  snapshot_update="$active_secret_snapshot/$name.update.$$"
  install -m 0400 "$secret_dir/$name" "$snapshot_update" &&
    sync -f "$snapshot_update" &&
    mv -f "$snapshot_update" "$active_secret_snapshot/$name" &&
    sync -f "$active_secret_snapshot"
}

compose() {
  /usr/bin/env -i PATH="$PATH" DOCKER_HOST="$docker_host" \
    docker compose --project-name "$project" --env-file "$runtime_env" \
    -f "$infra_dir/compose.cell.yaml" "$@"
}

recreate_affected_services() {
  [ -n "$running_services" ] || return 0
  # Values come only from the closed mapping above; word splitting is intentional.
  compose up -d --no-build --force-recreate --no-deps --wait $running_services
}

finish_rotation() {
  rm -f "$live_backup" "$snapshot_backup" "$snapshot_update" "$snapshot_restore" "$live_restore"
  sync -f "$secret_dir"
  [ -z "$active_secret_snapshot" ] || sync -f "$active_secret_snapshot"
}

restore_rotation_state() {
  restored=1
  if [ -n "$active_secret_snapshot" ]; then
    snapshot_restore="$active_secret_snapshot/$name.restore.$$"
    if install -m 0400 "$snapshot_backup" "$snapshot_restore" &&
      sync -f "$snapshot_restore" &&
      mv -f "$snapshot_restore" "$active_secret_snapshot/$name" &&
      sync -f "$active_secret_snapshot"
    then
      :
    else
      restored=0
    fi
  fi
  live_restore="$secret_dir/$name.restore.$$"
  if install -m 0400 "$live_backup" "$live_restore" &&
    sync -f "$live_restore" &&
    mv -f "$live_restore" "$secret_dir/$name" &&
    sync -f "$secret_dir"
  then
    :
  else
    restored=0
  fi

  if [ "$restored" -eq 1 ] && recreate_affected_services; then
    finish_rotation
    return 0
  fi
  if [ -n "$current_pointer" ]; then
    rm -f "$current_pointer"
    sync -f "$deployment_root"
  fi
  finish_rotation
  echo "secret rollback failed; deployment snapshot invalidated" >&2
  return 1
}

resume_after_rotation_failure() {
  status=$?
  trap - EXIT
  if [ -n "$tmp" ] && [ -f "$tmp" ]; then rm -f "$tmp"; fi
  if [ "$status" -ne 0 ] && [ "$rotation_started" -eq 1 ]; then
    restore_rotation_state || echo "failed to recover services after rotation error" >&2
  fi
  exit "$status"
}

resolve_active_secret_snapshot
for service in $affected_services; do
  if [ -n "$(compose ps -q "$service")" ]; then
    running_services="$running_services $service"
  fi
done
prepare_rotation_backups
rotation_started=1
trap resume_after_rotation_failure EXIT
if [ "$name" = "openclaw_session_key" ]; then
  case " $running_services " in
    *" cell "*)
    compose stop --timeout 30 cell
    ;;
  esac
  # Remove ciphertext while the old key is still installed. Any later failure
  # therefore leaves either the old usable pair or a clean QR-login state.
  compose run --rm --no-deps -T --entrypoint sh cell -c \
    'set -eu; rm -f /var/lib/openclaw-session/zalouser/credentials.json'
fi

mv -f "$tmp" "$secret_dir/$name"
tmp=
sync -f "$secret_dir"
update_active_secret_snapshot
recreate_affected_services
rotation_started=0
finish_rotation
trap - EXIT

if [ "$name" = "openclaw_session_key" ]; then
  echo "rotated $name for $cell_id; encrypted session cleared and QR login required"
elif [ -n "$running_services" ]; then
  echo "rotated $name for $cell_id; force-recreated:$running_services"
else
  echo "rotated $name for $cell_id; affected services will load it on next start"
fi
