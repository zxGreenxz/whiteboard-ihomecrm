#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
infra_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
runtime_root=${OPENCLAW_RUNTIME_ROOT:-/srv/openclaw-runtime}
runtime_env=
deployed=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-env) [ "$#" -ge 2 ] || exit 64; runtime_env=$2; shift 2 ;;
    *) echo "usage: deploy-cell.sh --runtime-env ABSOLUTE_PATH" >&2; exit 64 ;;
  esac
done

[ -n "$runtime_env" ] || { echo "--runtime-env is required" >&2; exit 64; }
cell_id=$(sed -n 's/^OPENCLAW_CELL_ID=//p' "$runtime_env")
project="openclaw-zalo-$cell_id"
baseline_dir="$runtime_root/operations/$cell_id"
install -d -m 0700 "$baseline_dir"

rollback_on_failure() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$deployed" -eq 1 ]; then
    "$script_dir/rollback-cell.sh" --runtime-env "$runtime_env" || true
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
"$script_dir/snapshot-host-baseline.sh" --runtime-env "$runtime_env" \
  --output "$baseline_dir/pre-deploy.json"

# pull_policy: never and --no-build keep deployment bound to reviewed local digests.
deployed=1
docker compose --project-name "$project" --env-file "$runtime_env" \
  -f "$infra_dir/compose.cell.yaml" up -d --no-build --remove-orphans --wait
"$script_dir/verify-isolation.sh" --runtime-env "$runtime_env" --session-encryption
"$script_dir/smoke-cell.sh" --runtime-env "$runtime_env"
"$script_dir/snapshot-host-baseline.sh" --runtime-env "$runtime_env" \
  --output "$baseline_dir/post-deploy.json"
deployed=0
trap - EXIT

echo "deployed $project"
