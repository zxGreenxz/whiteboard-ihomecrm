#!/bin/sh
set -eu

offline=0
no_fallback=0
cache=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --offline)
      offline=1
      shift
      ;;
    --no-fallback)
      no_fallback=1
      shift
      ;;
    --cache)
      [ "$#" -ge 2 ] || { echo "--cache requires a path" >&2; exit 2; }
      cache=$2
      shift 2
      ;;
    *)
      echo "unsupported installer argument: $1" >&2
      exit 2
      ;;
  esac
done

[ "$offline" -eq 1 ] || { echo "--offline is required" >&2; exit 2; }
[ "$no_fallback" -eq 1 ] || { echo "--no-fallback is required" >&2; exit 2; }
[ -n "$cache" ] || { echo "--cache is required" >&2; exit 2; }
[ -d "$cache" ] || { echo "cache must already exist" >&2; exit 2; }
[ -z "$(find "$cache" -mindepth 1 -print -quit)" ] || {
  echo "cache must be freshly created and empty" >&2
  exit 1
}

artifact=/opt/openclaw-cell/vendor/openclaw-zalouser-2026.7.1.tgz
fork_lock=/opt/openclaw-cell/vendor/FORK.json
project=/home/node/.openclaw/npm/projects/zalouser
staging=/home/node/.openclaw/npm/projects/.zalouser-install

[ -f "$artifact" ] || { echo "vendored artifact is missing" >&2; exit 1; }
[ -f "$fork_lock" ] || { echo "fork lock is missing" >&2; exit 1; }
[ ! -e "$project" ] || { echo "plugin project already exists" >&2; exit 1; }
[ ! -e "$staging" ] || { echo "plugin staging directory already exists" >&2; exit 1; }

expected_sha256=$(node -e '
  const fs = require("node:fs");
  const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const value = lock.builtTgzSha256 ?? lock.built_tgz_sha256;
  if (!/^[0-9a-f]{64}$/.test(value ?? "")) process.exit(1);
  process.stdout.write(value);
' "$fork_lock")
actual_sha256=$(node -e '
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(process.argv[1]);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("end", () => process.stdout.write(hash.digest("hex")));
  stream.on("error", () => process.exit(1));
' "$artifact")
[ "$actual_sha256" = "$expected_sha256" ] || {
  echo "artifact sha256 mismatch" >&2
  exit 1
}

mkdir -p "$staging"
printf '%s\n' '{"name":"@ihome/openclaw-zalouser-install","private":true}' > "$staging/package.json"

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
  --no-audit \
  --no-fund \
  --package-lock=false \
  --omit=dev \
  "$artifact"

installed=$staging/node_modules/@openclaw/zalouser
[ -d "$installed" ] || { echo "installed fork package is missing" >&2; exit 1; }
node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (manifest.name !== "@openclaw/zalouser" || manifest.version !== "2026.7.1") process.exit(1);
  if (Object.keys(manifest.dependencies ?? {}).length !== 0) process.exit(1);
' "$installed/package.json"
[ -z "$(find "$staging/node_modules" -mindepth 1 -maxdepth 1 ! -name @openclaw -print -quit)" ] || {
  echo "unexpected top-level package was installed" >&2
  exit 1
}
[ -z "$(find "$staging/node_modules/@openclaw" -mindepth 1 -maxdepth 1 ! -name zalouser -print -quit)" ] || {
  echo "unexpected scoped package was installed" >&2
  exit 1
}
mv "$installed" "$project"
rm -rf "$staging"
