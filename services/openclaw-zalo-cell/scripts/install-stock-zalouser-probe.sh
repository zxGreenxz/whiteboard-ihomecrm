#!/bin/sh
set -eu

offline=0
no_fallback=0
cache=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --offline) offline=1; shift ;;
    --no-fallback) no_fallback=1; shift ;;
    --cache) [ "$#" -ge 2 ] || exit 2; cache=$2; shift 2 ;;
    *) echo "unsupported installer argument: $1" >&2; exit 2 ;;
  esac
done
[ "$offline" -eq 1 ] || { echo "--offline is required" >&2; exit 2; }
[ "$no_fallback" -eq 1 ] || { echo "--no-fallback is required" >&2; exit 2; }
[ -n "$cache" ] && [ -d "$cache" ] || { echo "--cache must name an existing directory" >&2; exit 2; }
[ -z "$(find "$cache" -mindepth 1 -print -quit)" ] || { echo "cache must be empty" >&2; exit 1; }

artifact=/opt/openclaw-cell/upstream/verified-upstream.tgz
project=/home/node/.openclaw/npm/projects/zalouser
staging=/home/node/.openclaw/npm/projects/.zalouser-stock-probe
expected_sha256=e4022d5dc39009460523b796445c089caedce7e875a816d0e4cd18e8a48a0089
[ -f "$artifact" ] || { echo "authenticated upstream artifact is missing" >&2; exit 1; }
[ ! -e "$project" ] && [ ! -e "$staging" ] || { echo "stock probe project already exists" >&2; exit 1; }
actual_sha256=$(node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));
' "$artifact")
[ "$actual_sha256" = "$expected_sha256" ] || { echo "upstream artifact SHA-256 mismatch" >&2; exit 1; }

mkdir -p "$staging"
printf '%s\n' '{"name":"@ihome/openclaw-zalouser-stock-probe","private":true}' > "$staging/package.json"
NPM_CONFIG_OFFLINE=true \
NPM_CONFIG_PREFER_OFFLINE=true \
NPM_CONFIG_AUDIT=false \
NPM_CONFIG_FUND=false \
NPM_CONFIG_IGNORE_SCRIPTS=true \
NPM_CONFIG_UPDATE_NOTIFIER=false \
NPM_CONFIG_REGISTRY=http://127.0.0.1:9 \
npm install \
  --prefix "$staging" \
  --cache "$cache" \
  --offline \
  --ignore-scripts \
  --no-bin-links \
  --no-audit \
  --no-fund \
  --package-lock=false \
  --omit=dev \
  "$artifact"

installed=$staging/node_modules/@openclaw/zalouser
[ -d "$installed" ] || { echo "stock ZaloUser package is missing" >&2; exit 1; }
node -e '
  const { readFileSync } = require("node:fs");
  const value = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (value.name !== "@openclaw/zalouser" || value.version !== "2026.7.1") process.exit(1);
' "$installed/package.json"
rm -f "$staging/node_modules/.package-lock.json"
printf '%s\n' '{"name":"@ihome/openclaw-zalouser-stock-probe","private":true,"dependencies":{"@openclaw/zalouser":"2026.7.1"}}' > "$staging/package.json"
mv "$staging" "$project"
