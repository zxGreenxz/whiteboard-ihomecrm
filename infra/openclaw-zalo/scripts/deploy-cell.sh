#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
infra_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
runtime_root=${OPENCLAW_RUNTIME_ROOT:-/srv/openclaw-runtime}
runtime_env=
mutation_started=0
had_active_stack=0
old_cell_digest=
old_bridge_digest=
old_maintenance_digest=
old_egress_digest=
deployment_state_root=
active_snapshot=
active_secret_snapshot=
snapshot_name=
snapshot_candidate=
secret_snapshot_candidate=
snapshot_final=
secret_snapshot_final=
snapshot_final_created=0
secret_snapshot_final_created=0
pointer_tmp=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-env) [ "$#" -ge 2 ] || exit 64; runtime_env=$2; shift 2 ;;
    *) echo "usage: deploy-cell.sh --runtime-env ABSOLUTE_PATH" >&2; exit 64 ;;
  esac
done

[ -n "$runtime_env" ] && [ "${runtime_env#/}" != "$runtime_env" ] && [ -f "$runtime_env" ] || {
  echo "--runtime-env must be an existing absolute trusted metadata file" >&2
  exit 64
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

compose_with() {
  compose_env=$1
  compose_file=$2
  shift 2
  /usr/bin/env -i PATH="$PATH" DOCKER_HOST="$docker_host" \
    docker compose --project-name "$project" --env-file "$compose_env" \
      -f "$compose_file" "$@"
}

compose() {
  compose_with "$runtime_env" "$infra_dir/compose.cell.yaml" "$@"
}

cleanup_live_secret_temporaries() {
  live_secret_dir="$runtime_root/secrets/$cell_id"
  [ -d "$live_secret_dir" ] && [ ! -L "$live_secret_dir" ] || {
    echo "candidate secret directory is unsafe" >&2
    return 1
  }
  for secret in \
    openclaw_session_key \
    openclaw_zalo_bridge_hmac \
    openclaw_customer_ai_key \
    openclaw_runtime_credential \
    openclaw_gateway_device_token \
    openclaw_gateway_device_identity \
    openclaw_qr_encryption_key \
    openclaw_maintenance_credential \
    openclaw_audit_private_key
  do
    rm -f \
      "$live_secret_dir/$secret.backup."* \
      "$live_secret_dir/$secret.rollback."* \
      "$live_secret_dir/$secret.restore."* \
      "$live_secret_dir/$secret.tmp."*
  done
  sync -f "$live_secret_dir"
}

validate_candidate() {
  candidate_images=$(compose config --images)
  [ -n "$candidate_images" ] || { echo "candidate stack has no reviewed images" >&2; return 1; }
  for image in $candidate_images; do
    docker image inspect "$image" >/dev/null 2>&1 || {
      echo "candidate image is not present locally: $image" >&2
      return 1
    }
  done

  secret_dir="$runtime_root/secrets/$cell_id"
  for secret in \
    openclaw_session_key \
    openclaw_zalo_bridge_hmac \
    openclaw_customer_ai_key \
    openclaw_runtime_credential \
    openclaw_gateway_device_token \
    openclaw_gateway_device_identity \
    openclaw_qr_encryption_key \
    openclaw_maintenance_credential \
    openclaw_audit_private_key
  do
    [ -f "$secret_dir/$secret" ] && [ ! -L "$secret_dir/$secret" ] && \
      [ -s "$secret_dir/$secret" ] || {
      echo "candidate secret must be a non-empty regular file: $secret" >&2
      return 1
    }
    [ "$(stat -c %u "$secret_dir/$secret")" = "$(id -u)" ] || {
      echo "candidate secret owner must be the rootless runner: $secret" >&2
      return 1
    }
    [ "$(stat -c %a "$secret_dir/$secret")" = "400" ] || {
      echo "candidate secret mode must be 0400: $secret" >&2
      return 1
    }
  done
}

capture_active_stack() {
  existing_count=0
  for service in cell bridge maintenance egress-broker; do
    container_id=$(compose ps -q "$service")
    [ -n "$container_id" ] || continue
    container_count=$(printf '%s\n' "$container_id" | awk 'NF { count += 1 } END { print count + 0 }')
    [ "$container_count" -eq 1 ] || {
      echo "active stack must have exactly one $service container" >&2
      return 1
    }
    [ "$(docker inspect --format '{{.State.Running}}' "$container_id")" = "true" ] || {
      echo "active $service container is not healthy enough to update" >&2
      return 1
    }
    image_ref=$(docker inspect --format '{{.Config.Image}}' "$container_id")
    case "$service:$image_ref" in
      cell:ihome/openclaw-zalo-cell@sha256:*) old_cell_digest=${image_ref##*@sha256:}; digest=$old_cell_digest ;;
      bridge:ihome/openclaw-zalo-bridge@sha256:*) old_bridge_digest=${image_ref##*@sha256:}; digest=$old_bridge_digest ;;
      maintenance:ihome/openclaw-zalo-maintenance@sha256:*) old_maintenance_digest=${image_ref##*@sha256:}; digest=$old_maintenance_digest ;;
      egress-broker:ihome/openclaw-egress-broker@sha256:*) old_egress_digest=${image_ref##*@sha256:}; digest=$old_egress_digest ;;
      *) echo "active $service image is not an immutable reviewed digest" >&2; return 1 ;;
    esac
    [ "${#digest}" -eq 64 ] && ! printf '%s\n' "$digest" | grep -q '[^0-9a-f]' || {
      echo "active $service image digest is invalid" >&2
      return 1
    }
    existing_count=$((existing_count + 1))
  done

  case "$existing_count" in
    0) had_active_stack=0 ;;
    4) had_active_stack=1 ;;
    *) echo "refusing to update a partial active stack" >&2; return 1 ;;
  esac
}

read_env_value() {
  env_file=$1
  env_name=$2
  env_count=$(grep -c "^$env_name=" "$env_file" || true)
  [ "$env_count" -eq 1 ] || {
    echo "deployment snapshot must contain exactly one $env_name" >&2
    return 1
  }
  sed -n "s/^$env_name=//p" "$env_file"
}

load_active_snapshot() {
  deployment_state_root="$runtime_root/operations/$cell_id/deployments"
  current_pointer="$deployment_state_root/current"
  [ -f "$current_pointer" ] && [ ! -L "$current_pointer" ] || {
    echo "active stack has no trusted deployment snapshot; refusing mutation" >&2
    return 1
  }
  [ "$(stat -c %a "$current_pointer")" = "600" ] || {
    echo "deployment snapshot pointer mode must be 0600" >&2
    return 1
  }
  snapshot_name=$(sed -n '1p' "$current_pointer")
  [ "$(wc -l < "$current_pointer")" -eq 1 ] || {
    echo "deployment snapshot pointer must contain one line" >&2
    return 1
  }
  case "$snapshot_name" in
    snapshot-*) ;;
    *) echo "deployment snapshot pointer is invalid" >&2; return 1 ;;
  esac
  case "$snapshot_name" in
    *[!0-9A-Za-z._-]*) echo "deployment snapshot pointer is invalid" >&2; return 1 ;;
  esac

  active_snapshot="$deployment_state_root/snapshots/$snapshot_name"
  [ -d "$active_snapshot" ] && [ ! -L "$active_snapshot" ] || {
    echo "active deployment snapshot is missing" >&2
    return 1
  }
  for snapshot_file in runtime.env compose.cell.yaml egress-allowlist.yaml; do
    [ -f "$active_snapshot/$snapshot_file" ] && [ ! -L "$active_snapshot/$snapshot_file" ] || {
      echo "active deployment snapshot is incomplete: $snapshot_file" >&2
      return 1
    }
  done
  [ "$(stat -c %a "$active_snapshot/runtime.env")" = "600" ] || {
    echo "snapshot runtime metadata mode must be 0600" >&2
    return 1
  }
  snapshot_secret_dir="$runtime_root/secrets/$cell_id/.deployments/$snapshot_name"
  [ -d "$snapshot_secret_dir" ] && [ ! -L "$snapshot_secret_dir" ] || {
    echo "active deployment secret snapshot is missing" >&2
    return 1
  }
  for secret in \
    openclaw_session_key \
    openclaw_zalo_bridge_hmac \
    openclaw_customer_ai_key \
    openclaw_runtime_credential \
    openclaw_gateway_device_token \
    openclaw_gateway_device_identity \
    openclaw_qr_encryption_key \
    openclaw_maintenance_credential \
    openclaw_audit_private_key
  do
    [ -s "$snapshot_secret_dir/$secret" ] && [ ! -L "$snapshot_secret_dir/$secret" ] || {
      echo "active deployment secret snapshot is incomplete: $secret" >&2
      return 1
    }
    [ "$(stat -c %a "$snapshot_secret_dir/$secret")" = "400" ] || {
      echo "active deployment secret snapshot mode must be 0400: $secret" >&2
      return 1
    }
  done
  active_secret_snapshot="$snapshot_secret_dir"

  [ "$(read_env_value "$active_snapshot/runtime.env" OPENCLAW_CELL_ID)" = "$cell_id" ] || {
    echo "active deployment snapshot cell identity mismatch" >&2
    return 1
  }
  [ "$(read_env_value "$active_snapshot/runtime.env" OPENCLAW_CELL_IMAGE_SHA256)" = "$old_cell_digest" ] &&
  [ "$(read_env_value "$active_snapshot/runtime.env" OPENCLAW_BRIDGE_IMAGE_SHA256)" = "$old_bridge_digest" ] &&
  [ "$(read_env_value "$active_snapshot/runtime.env" OPENCLAW_MAINTENANCE_IMAGE_SHA256)" = "$old_maintenance_digest" ] &&
  [ "$(read_env_value "$active_snapshot/runtime.env" OPENCLAW_EGRESS_BROKER_IMAGE_SHA256)" = "$old_egress_digest" ] || {
    echo "active deployment snapshot does not match the running image set" >&2
    return 1
  }
}

restore_snapshot_file() {
  snapshot_source=$1
  live_destination=$2
  live_mode=$3
  live_parent=$(dirname "$live_destination")
  install -d -m 0700 "$live_parent"
  restore_tmp="$live_destination.rollback.$$"
  install -m "$live_mode" "$snapshot_source" "$restore_tmp"
  sync -f "$restore_tmp"
  mv -f "$restore_tmp" "$live_destination"
  sync -f "$live_parent"
}

restore_active_stack() {
  live_secret_dir="$runtime_root/secrets/$cell_id"
  for secret in \
    openclaw_session_key \
    openclaw_zalo_bridge_hmac \
    openclaw_customer_ai_key \
    openclaw_runtime_credential \
    openclaw_gateway_device_token \
    openclaw_gateway_device_identity \
    openclaw_qr_encryption_key \
    openclaw_maintenance_credential \
    openclaw_audit_private_key
  do
    restore_snapshot_file "$active_secret_snapshot/$secret" "$live_secret_dir/$secret" 0400
  done
  restore_snapshot_file \
    "$active_snapshot/egress-allowlist.yaml" \
    "$runtime_root/config/$cell_id/egress-allowlist.yaml" \
    0444
  compose_with "$active_snapshot/runtime.env" "$active_snapshot/compose.cell.yaml" \
    up -d --no-build --force-recreate --remove-orphans --wait
}

persist_active_snapshot() {
  deployment_state_root="$runtime_root/operations/$cell_id/deployments"
  snapshots_root="$deployment_state_root/snapshots"
  secret_snapshots_root="$runtime_root/secrets/$cell_id/.deployments"
  install -d -m 0700 "$deployment_state_root" "$snapshots_root"
  install -d -m 0700 "$secret_snapshots_root"
  snapshot_candidate=$(mktemp -d "$snapshots_root/.candidate.XXXXXX")
  secret_snapshot_candidate=$(mktemp -d "$secret_snapshots_root/.candidate.XXXXXX")
  chmod 0700 "$snapshot_candidate"
  chmod 0700 "$secret_snapshot_candidate"
  install -m 0600 "$runtime_env" "$snapshot_candidate/runtime.env"
  install -m 0444 "$infra_dir/compose.cell.yaml" "$snapshot_candidate/compose.cell.yaml"
  install -m 0444 \
    "$runtime_root/config/$cell_id/egress-allowlist.yaml" \
    "$snapshot_candidate/egress-allowlist.yaml"
  for secret in \
    openclaw_session_key \
    openclaw_zalo_bridge_hmac \
    openclaw_customer_ai_key \
    openclaw_runtime_credential \
    openclaw_gateway_device_token \
    openclaw_gateway_device_identity \
    openclaw_qr_encryption_key \
    openclaw_maintenance_credential \
    openclaw_audit_private_key
  do
    install -m 0400 "$runtime_root/secrets/$cell_id/$secret" "$secret_snapshot_candidate/$secret"
    sync -f "$secret_snapshot_candidate/$secret"
  done
  for snapshot_file in runtime.env compose.cell.yaml egress-allowlist.yaml; do
    sync -f "$snapshot_candidate/$snapshot_file"
  done
  sync -f "$secret_snapshot_candidate"
  sync -f "$snapshot_candidate"

  snapshot_name="snapshot-$(date +%s)-$$"
  snapshot_final="$snapshots_root/$snapshot_name"
  secret_snapshot_final="$secret_snapshots_root/$snapshot_name"
  [ ! -e "$snapshot_final" ] && [ ! -e "$secret_snapshot_final" ] || {
    echo "deployment snapshot collision" >&2
    return 1
  }
  mv "$snapshot_candidate" "$snapshot_final"
  snapshot_final_created=1
  mv "$secret_snapshot_candidate" "$secret_snapshot_final"
  secret_snapshot_final_created=1
  sync -f "$snapshots_root"
  sync -f "$secret_snapshots_root"
  pointer_tmp="$deployment_state_root/current.tmp.$$"
  printf '%s\n' "$snapshot_name" > "$pointer_tmp"
  chmod 0600 "$pointer_tmp"
  sync -f "$pointer_tmp"
  mv -f "$pointer_tmp" "$deployment_state_root/current"
  sync -f "$deployment_state_root" || echo "deployment snapshot pointer directory fsync failed" >&2
  active_snapshot="$snapshot_final"
  active_secret_snapshot="$secret_snapshot_final"
  snapshot_candidate=
  secret_snapshot_candidate=
  snapshot_final_created=0
  secret_snapshot_final_created=0
  pointer_tmp=
}

cleanup_failed_snapshot() {
  if [ -n "$pointer_tmp" ] && [ -f "$pointer_tmp" ]; then rm -f "$pointer_tmp"; fi
  if [ -n "$snapshot_candidate" ] && [ -d "$snapshot_candidate" ]; then
    rm -f \
      "$snapshot_candidate/runtime.env" \
      "$snapshot_candidate/compose.cell.yaml" \
      "$snapshot_candidate/egress-allowlist.yaml"
    rmdir "$snapshot_candidate" || true
  fi
  if [ -n "$secret_snapshot_candidate" ] && [ -d "$secret_snapshot_candidate" ]; then
    for secret in \
      openclaw_session_key \
      openclaw_zalo_bridge_hmac \
      openclaw_customer_ai_key \
      openclaw_runtime_credential \
      openclaw_gateway_device_token \
      openclaw_gateway_device_identity \
      openclaw_qr_encryption_key \
      openclaw_maintenance_credential \
      openclaw_audit_private_key
    do
      rm -f "$secret_snapshot_candidate/$secret"
    done
    rmdir "$secret_snapshot_candidate" || true
  fi
  if [ "$snapshot_final_created" -eq 1 ] && [ -d "$snapshot_final" ]; then
    rm -f \
      "$snapshot_final/runtime.env" \
      "$snapshot_final/compose.cell.yaml" \
      "$snapshot_final/egress-allowlist.yaml"
    rmdir "$snapshot_final" || true
  fi
  if [ "$secret_snapshot_final_created" -eq 1 ] && [ -d "$secret_snapshot_final" ]; then
    for secret in \
      openclaw_session_key \
      openclaw_zalo_bridge_hmac \
      openclaw_customer_ai_key \
      openclaw_runtime_credential \
      openclaw_gateway_device_token \
      openclaw_gateway_device_identity \
      openclaw_qr_encryption_key \
      openclaw_maintenance_credential \
      openclaw_audit_private_key
    do
      rm -f "$secret_snapshot_final/$secret"
    done
    rmdir "$secret_snapshot_final" || true
  fi
}

cleanup_superseded_snapshots() {
  for stale_snapshot in "$snapshots_root"/snapshot-* "$snapshots_root"/.candidate.*; do
    if [ ! -e "$stale_snapshot" ] && [ ! -L "$stale_snapshot" ]; then continue; fi
    [ -d "$stale_snapshot" ] && [ ! -L "$stale_snapshot" ] || {
      echo "superseded deployment snapshot path is unsafe" >&2
      return 1
    }
    stale_name=${stale_snapshot##*/}
    [ "$stale_name" != "$snapshot_name" ] || continue
    case "$stale_name" in
      snapshot-*|.candidate.*) ;;
      *) echo "superseded deployment snapshot name is invalid" >&2; return 1 ;;
    esac
    case "$stale_name" in
      *[!0-9A-Za-z._-]*) echo "superseded deployment snapshot name is invalid" >&2; return 1 ;;
    esac
    rm -f \
      "$stale_snapshot/runtime.env" \
      "$stale_snapshot/compose.cell.yaml" \
      "$stale_snapshot/egress-allowlist.yaml"
    rmdir "$stale_snapshot"
  done

  for stale_secret_snapshot in \
    "$secret_snapshots_root"/snapshot-* \
    "$secret_snapshots_root"/.candidate.*
  do
    if [ ! -e "$stale_secret_snapshot" ] && [ ! -L "$stale_secret_snapshot" ]; then continue; fi
    [ -d "$stale_secret_snapshot" ] && [ ! -L "$stale_secret_snapshot" ] || {
      echo "superseded secret snapshot path is unsafe" >&2
      return 1
    }
    stale_name=${stale_secret_snapshot##*/}
    [ "$stale_name" != "$snapshot_name" ] || continue
    case "$stale_name" in
      snapshot-*|.candidate.*) ;;
      *) echo "superseded secret snapshot name is invalid" >&2; return 1 ;;
    esac
    case "$stale_name" in
      *[!0-9A-Za-z._-]*) echo "superseded secret snapshot name is invalid" >&2; return 1 ;;
    esac
    for secret in \
      openclaw_session_key \
      openclaw_zalo_bridge_hmac \
      openclaw_customer_ai_key \
      openclaw_runtime_credential \
      openclaw_gateway_device_token \
      openclaw_gateway_device_identity \
      openclaw_qr_encryption_key \
      openclaw_maintenance_credential \
      openclaw_audit_private_key
    do
      rm -f \
        "$stale_secret_snapshot/$secret" \
        "$stale_secret_snapshot/$secret.backup."* \
        "$stale_secret_snapshot/$secret.update."* \
        "$stale_secret_snapshot/$secret.restore."*
    done
    rmdir "$stale_secret_snapshot"
  done
  sync -f "$snapshots_root"
  sync -f "$secret_snapshots_root"
}

rollback_on_failure() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$mutation_started" -eq 1 ]; then
    cleanup_failed_snapshot
    if [ "$had_active_stack" -eq 1 ]; then
      restore_active_stack || echo "failed to restore the previously active stack" >&2
    else
      "$script_dir/rollback-cell.sh" --runtime-env "$runtime_env" || \
        echo "failed to remove the incomplete first deployment" >&2
    fi
  fi
  exit "$status"
}
trap rollback_on_failure EXIT

"$script_dir/preflight-host.sh"
[ -f "${OPENCLAW_TRANSFER_QUOTA_RECORD:-$runtime_root/operations/transfer-quota.json}" ] || {
  echo "transfer quota record is required" >&2
  exit 1
}
"$script_dir/render-cell.sh" --runtime-env "$runtime_env" >/dev/null
cell_id=$(sed -n 's/^OPENCLAW_CELL_ID=//p' "$runtime_env")
project="openclaw-zalo-$cell_id"
baseline_dir="$runtime_root/operations/$cell_id"
install -d -m 0700 "$baseline_dir"
cleanup_live_secret_temporaries
validate_candidate
capture_active_stack
if [ "$had_active_stack" -eq 1 ]; then
  load_active_snapshot
fi
"$script_dir/snapshot-host-baseline.sh" --runtime-env "$runtime_env" \
  --output "$baseline_dir/pre-deploy.json"

# pull_policy: never and --no-build keep deployment bound to reviewed local digests.
mutation_started=1
compose up -d --no-build --remove-orphans --wait
"$script_dir/verify-isolation.sh" --runtime-env "$runtime_env" --session-encryption
"$script_dir/smoke-cell.sh" --runtime-env "$runtime_env"
"$script_dir/snapshot-host-baseline.sh" --runtime-env "$runtime_env" \
  --output "$baseline_dir/post-deploy.json"
persist_active_snapshot
mutation_started=0
trap - EXIT
cleanup_superseded_snapshots

echo "deployed $project"
