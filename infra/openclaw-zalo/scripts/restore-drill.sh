#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runtime_root=${OPENCLAW_RUNTIME_ROOT:-/srv/openclaw-runtime}
runtime_env=
adapter=
evidence_file=
backup_observed_at=
restore_started_at=
restore_completed_at=
r2_object_id=
secret_source_dir=
session_strategy=
drill_organization=
demo_organization=dddd0000-0000-4000-8000-000000000001

while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-env) runtime_env=$2; shift 2 ;;
    --adapter) adapter=$2; shift 2 ;;
    --evidence-file) evidence_file=$2; shift 2 ;;
    --backup-observed-at) backup_observed_at=$2; shift 2 ;;
    --restore-started-at) restore_started_at=$2; shift 2 ;;
    --restore-completed-at) restore_completed_at=$2; shift 2 ;;
    --r2-object-id) r2_object_id=$2; shift 2 ;;
    --secret-source-dir) secret_source_dir=$2; shift 2 ;;
    --session-strategy) session_strategy=$2; shift 2 ;;
    --drill-organization) drill_organization=$2; shift 2 ;;
    *) echo "invalid restore drill argument" >&2; exit 64 ;;
  esac
done

[ "$drill_organization" = "$demo_organization" ] || {
  echo "restore drill mutations are restricted to DEMO" >&2
  exit 64
}
valid_uuid() { printf '%s\n' "$1" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'; }
valid_uuid "$drill_organization" || exit 64
[ -n "$runtime_env" ] && [ "${runtime_env#/}" != "$runtime_env" ] && [ -f "$runtime_env" ] && [ ! -L "$runtime_env" ] || exit 64
[ -n "$adapter" ] && [ "${adapter#/}" != "$adapter" ] && [ -x "$adapter" ] && [ ! -L "$adapter" ] || exit 64
[ -n "$evidence_file" ] && [ "${evidence_file#/}" != "$evidence_file" ] || exit 64
[ -d "$secret_source_dir" ] && [ ! -L "$secret_source_dir" ] || exit 64
case "$session_strategy" in reencrypt|relogin) ;; *) echo "session strategy must be reencrypt or relogin" >&2; exit 64 ;; esac
valid_uuid "$r2_object_id" || { echo "R2 drill object must be an opaque UUID" >&2; exit 64; }

epoch() { date -u -d "$1" +%s 2>/dev/null || { echo "invalid RFC3339 timestamp" >&2; exit 64; }; }
backup_epoch=$(epoch "$backup_observed_at")
restore_start_epoch=$(epoch "$restore_started_at")
restore_end_epoch=$(epoch "$restore_completed_at")
[ "$restore_end_epoch" -ge "$restore_start_epoch" ] || { echo "restore interval is invalid" >&2; exit 64; }
drill_started_epoch=$(date +%s)
rpo_seconds=$((drill_started_epoch - backup_epoch))
[ "$rpo_seconds" -ge 0 ] || rpo_seconds=0
rto_seconds=$((restore_end_epoch - restore_start_epoch))
[ "$rpo_seconds" -le 900 ] || { echo "canonical Supabase RPO exceeds 15 minutes" >&2; exit 1; }
[ "$rto_seconds" -le 14400 ] || { echo "canonical Supabase RTO exceeds 4 hours" >&2; exit 1; }

cell_id=$(sed -n 's/^OPENCLAW_CELL_ID=//p' "$runtime_env")
organization_id=$(sed -n 's/^OPENCLAW_ORGANIZATION_ID=//p' "$runtime_env")
[ "$(grep -c '^OPENCLAW_CELL_ID=' "$runtime_env")" -eq 1 ] && \
  [ "$(grep -c '^OPENCLAW_ORGANIZATION_ID=' "$runtime_env")" -eq 1 ] && \
  valid_uuid "$cell_id" && valid_uuid "$organization_id" || exit 64
[ "$organization_id" = "$drill_organization" ] || { echo "runtime environment is outside drill scope" >&2; exit 64; }

run_adapter() {
  "$adapter" "$@" --organization "$organization_id" --cell "$cell_id"
}

# Restore a test copy and prove canonical DB freshness before any production
# auto/proactive/group mode can be approved.
run_adapter supabase-restore-test --backup-observed-at "$backup_observed_at" \
  --restore-started-at "$restore_started_at" --restore-completed-at "$restore_completed_at"
run_adapter supabase-verify-canonical --maximum-rpo-seconds 900 --maximum-rto-seconds 14400

# R2 deletion is simulated inside the exact seven-day tombstone grace; the
# immutable object key is never printed or copied into evidence.
run_adapter r2-delete-simulate --object-id "$r2_object_id" --grace-seconds 604800
run_adapter r2-restore-within-grace --object-id "$r2_object_id" --grace-seconds 604800
run_adapter r2-verify-restored --object-id "$r2_object_id"

for secret_name in \
  openclaw_runtime_credential \
  openclaw_maintenance_credential \
  openclaw_gateway_device_token \
  openclaw_audit_private_key
do
  source_file="$secret_source_dir/$secret_name"
  [ -f "$source_file" ] && [ ! -L "$source_file" ] && [ "$(stat -c %a "$source_file")" = "400" ] || {
    echo "reviewed rotation source is unavailable" >&2
    exit 1
  }
  "$script_dir/rotate-secrets.sh" --runtime-env "$runtime_env" --name "$secret_name" --source-file "$source_file" >/dev/null
done

if [ "$session_strategy" = reencrypt ]; then
  # Adapter calls the committed session-crypto rotate operation, which performs
  # authenticated decrypt/re-encrypt plus atomic temp-write/fsync/rename.
  run_adapter session-reencrypt-atomic --operation rotate --require-fsync-rename
else
  session_source="$secret_source_dir/openclaw_session_key"
  [ -f "$session_source" ] && [ ! -L "$session_source" ] || exit 1
  "$script_dir/rotate-secrets.sh" --runtime-env "$runtime_env" \
    --name openclaw_session_key --source-file "$session_source" >/dev/null
  run_adapter session-require-fresh-qr-login --invalidate-old-session
fi

run_adapter prove-no-plaintext-session-snapshot --runtime-root "$runtime_root"
if find "$runtime_root" -xdev -type f \( -name credentials.json -o -name '*.cookie' -o -name '*.session-plaintext' \) -print -quit | grep -q .; then
  echo "plaintext session snapshot detected" >&2
  exit 1
fi

evidence_dir=$(dirname -- "$evidence_file")
install -d -m 0700 "$evidence_dir"
tmp="$evidence_file.tmp.$$"
umask 077
printf '%s\n' "{\"version\":1,\"drillOrganizationId\":\"$organization_id\",\"cellId\":\"$cell_id\",\"completedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"actualRpoSeconds\":$rpo_seconds,\"actualRtoSeconds\":$rto_seconds,\"rpoGateSeconds\":900,\"rtoGateSeconds\":14400,\"r2GraceSeconds\":604800,\"r2RestoreVerified\":true,\"workloadTokenAuditKeysRotated\":true,\"sessionRecoveryStrategy\":\"$session_strategy\",\"plaintextSessionSnapshotFound\":false}" > "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$evidence_file"
echo "restore drill passed: RPO ${rpo_seconds}s, RTO ${rto_seconds}s"
