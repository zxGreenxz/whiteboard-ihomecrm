#!/bin/sh
set -eu

old_runtime_env=
new_runtime_env=
adapter=
evidence_file=
confirm=
target_rto_seconds=3600

while [ "$#" -gt 0 ]; do
  case "$1" in
    --old-runtime-env) old_runtime_env=$2; shift 2 ;;
    --new-runtime-env) new_runtime_env=$2; shift 2 ;;
    --adapter) adapter=$2; shift 2 ;;
    --evidence-file) evidence_file=$2; shift 2 ;;
    --confirm) confirm=$2; shift 2 ;;
    *) echo "invalid cell migration argument" >&2; exit 64 ;;
  esac
done

for path in "$old_runtime_env" "$new_runtime_env"; do
  [ -n "$path" ] && [ "${path#/}" != "$path" ] && [ -f "$path" ] && [ ! -L "$path" ] || exit 64
done
[ -n "$adapter" ] && [ "${adapter#/}" != "$adapter" ] && [ -x "$adapter" ] && [ ! -L "$adapter" ] || exit 64
[ -n "$evidence_file" ] && [ "${evidence_file#/}" != "$evidence_file" ] || exit 64

field() { sed -n "s/^$2=//p" "$1"; }
valid_uuid() { printf '%s\n' "$1" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'; }
organization_id=$(field "$old_runtime_env" OPENCLAW_ORGANIZATION_ID)
new_organization_id=$(field "$new_runtime_env" OPENCLAW_ORGANIZATION_ID)
old_cell_id=$(field "$old_runtime_env" OPENCLAW_CELL_ID)
new_cell_id=$(field "$new_runtime_env" OPENCLAW_CELL_ID)
[ "$(grep -c '^OPENCLAW_ORGANIZATION_ID=' "$old_runtime_env")" -eq 1 ] && \
  [ "$(grep -c '^OPENCLAW_ORGANIZATION_ID=' "$new_runtime_env")" -eq 1 ] && \
  [ "$(grep -c '^OPENCLAW_CELL_ID=' "$old_runtime_env")" -eq 1 ] && \
  [ "$(grep -c '^OPENCLAW_CELL_ID=' "$new_runtime_env")" -eq 1 ] && \
  valid_uuid "$organization_id" && valid_uuid "$new_organization_id" && \
  valid_uuid "$old_cell_id" && valid_uuid "$new_cell_id" || exit 64
[ "$organization_id" = "$new_organization_id" ] || { echo "cross-organization migration is forbidden" >&2; exit 64; }
[ "$old_cell_id" != "$new_cell_id" ] || { echo "migration requires a new cell" >&2; exit 64; }
[ "$confirm" = "$organization_id:$old_cell_id:$new_cell_id" ] || { echo "exact migration confirmation is required" >&2; exit 64; }

started=$(date +%s)
stop_active=0
resumed=0
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ] && [ "$stop_active" -eq 1 ] && [ "$resumed" -eq 0 ]; then
    echo "migration failed; GLOBAL_STOP remains active and old credentials remain revoked as reached" >&2
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

run() {
  "$adapter" "$@" --organization "$organization_id" --old-cell "$old_cell_id" --new-cell "$new_cell_id"
}

# This order is the migration safety contract. No step may be skipped or moved.
run global-stop --scope organization --reason planned-vps-migration
stop_active=1
run drain-outbox --stop-new-claims --return-leased-to-queue
run freeze-outbox --states QUEUED,LEASED
run move-expired-dispatching-to-unknown --never-retry-unknown
run snapshot-old-cotenants --read-only --compare-fields id,image,network,mounts,restart-count,ports
run provision-new-rootless-cell --runtime-env "$new_runtime_env" --no-public-gateway
run rotate-workload-credentials --new-cell-only --revoke-on-fence
run acquire-higher-fencing-lease --strictly-greater-than-old
run revoke-old-credential-and-lease --fence-old-cell
run require-fresh-qr-login --copy-session never
run sync-history --hours 48 --automation disabled --dedupe true
run reconcile-gaps-and-unknown --operator-required-for-unknown
run controlled-smoke --one-send-ceiling 1 --cleanup-required
run compare-cotenants --fail-on-change
run verify-external-canonical-stores --supabase-copy false --r2-copy false
run resume-organization --permission openclaw_zalo.manage_operations --reason planned-vps-migration-complete
resumed=1

completed=$(date +%s)
actual_rto_seconds=$((completed - started))
[ "$actual_rto_seconds" -le "$target_rto_seconds" ] || {
  echo "migration exceeded the 60 minute RTO target" >&2
  exit 1
}

install -d -m 0700 "$(dirname -- "$evidence_file")"
tmp="$evidence_file.tmp.$$"
umask 077
printf '%s\n' "{\"version\":1,\"organizationId\":\"$organization_id\",\"oldCellId\":\"$old_cell_id\",\"newCellId\":\"$new_cell_id\",\"completedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"actualRtoSeconds\":$actual_rto_seconds,\"targetRtoSeconds\":3600,\"globalStopSequenceVerified\":true,\"oldCellFenced\":true,\"freshQrLoginVerified\":true,\"historySyncHours\":48,\"unknownReconciled\":true,\"cotenantsUnchanged\":true,\"supabaseCopied\":false,\"r2Copied\":false}" > "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$evidence_file"
trap - EXIT HUP INT TERM
echo "cell migration completed in ${actual_rto_seconds}s"
