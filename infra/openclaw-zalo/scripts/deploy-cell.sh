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

compose() {
  docker compose --project-name "$project" --env-file "$runtime_env" \
    -f "$infra_dir/compose.cell.yaml" "$@"
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
    [ -s "$secret_dir/$secret" ] || {
      echo "candidate secret is missing or empty: $secret" >&2
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

restore_active_stack() {
  OPENCLAW_CELL_IMAGE_SHA256=$old_cell_digest \
  OPENCLAW_BRIDGE_IMAGE_SHA256=$old_bridge_digest \
  OPENCLAW_MAINTENANCE_IMAGE_SHA256=$old_maintenance_digest \
  OPENCLAW_EGRESS_BROKER_IMAGE_SHA256=$old_egress_digest \
    docker compose --project-name "$project" --env-file "$runtime_env" \
      -f "$infra_dir/compose.cell.yaml" up -d --no-build --remove-orphans --wait
}

rollback_on_failure() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$mutation_started" -eq 1 ]; then
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
validate_candidate
capture_active_stack
"$script_dir/snapshot-host-baseline.sh" --runtime-env "$runtime_env" \
  --output "$baseline_dir/pre-deploy.json"

# pull_policy: never and --no-build keep deployment bound to reviewed local digests.
mutation_started=1
compose up -d --no-build --remove-orphans --wait
"$script_dir/verify-isolation.sh" --runtime-env "$runtime_env" --session-encryption
"$script_dir/smoke-cell.sh" --runtime-env "$runtime_env"
"$script_dir/snapshot-host-baseline.sh" --runtime-env "$runtime_env" \
  --output "$baseline_dir/post-deploy.json"
mutation_started=0
trap - EXIT

echo "deployed $project"
