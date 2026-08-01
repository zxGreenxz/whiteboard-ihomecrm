#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
infra_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
runtime_root=${OPENCLAW_RUNTIME_ROOT:-/srv/openclaw-runtime}
runtime_env=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-env) [ "$#" -ge 2 ] || exit 64; runtime_env=$2; shift 2 ;;
    *) echo "usage: render-cell.sh --runtime-env ABSOLUTE_PATH" >&2; exit 64 ;;
  esac
done

[ -n "$runtime_env" ] && [ "${runtime_env#/}" != "$runtime_env" ] && [ -f "$runtime_env" ] || {
  echo "--runtime-env must be an existing absolute trusted metadata file" >&2
  exit 64
}
[ "$(stat -c %a "$runtime_env")" = "600" ] || { echo "runtime metadata mode must be 0600" >&2; exit 1; }

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
config_dir="$runtime_root/config/$cell_id"
install -d -m 0700 "$config_dir"
tmp_allowlist="$config_dir/egress-allowlist.yaml.tmp.$$"
install -m 0444 "$infra_dir/egress/allowlist.yaml" "$tmp_allowlist"
mv -f "$tmp_allowlist" "$config_dir/egress-allowlist.yaml"

docker compose --project-name "$project" --env-file "$runtime_env" \
  -f "$infra_dir/compose.cell.yaml" config --quiet
printf '%s\n' "$project"
