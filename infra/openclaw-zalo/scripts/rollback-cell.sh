#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
infra_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
runtime_env=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-env) [ "$#" -ge 2 ] || exit 64; runtime_env=$2; shift 2 ;;
    *) echo "usage: rollback-cell.sh --runtime-env ABSOLUTE_PATH" >&2; exit 64 ;;
  esac
done

[ -n "$runtime_env" ] || { echo "--runtime-env is required" >&2; exit 64; }
cell_id=$(sed -n 's/^OPENCLAW_CELL_ID=//p' "$runtime_env")
project="openclaw-zalo-$cell_id"

docker compose --project-name "$project" --env-file "$runtime_env" \
  -f "$infra_dir/compose.cell.yaml" down --remove-orphans --timeout 30
echo "rolled back $project without deleting volumes"
