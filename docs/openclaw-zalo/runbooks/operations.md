# OpenClaw Zalo - Operations

## Daily checks

Review account/session/cell state, configured and effective mode, heartbeat age, queue
counts, queue lag p95, current unresolved UNKNOWN count/rate, adapter errors, reconnects,
CPU/RAM/disk, spool age/bytes, media backlog, R2 failures, Supabase egress, R2
storage/requests, VPS outbound, transfer quota, recent incidents, and last restore drill.
Metrics and logs are content-free.

The external watchdog probes every 60 seconds with a 10-second timeout. Heartbeat age
greater than 90 seconds is stale. After three consecutive failures it records one
fingerprinted incident through `openclaw_record_watchdog_health_v1` and sends CRM push
and email to configured owner/admin recipients within three minutes. A fingerprint is
not notified again inside the same repeat window; recovery is a separate `RECOVERED`
event.

## Host guard response

The guard immediately establishes a fail-closed pause marker and requests pause of
outbound, AI, and media while preserving minimal inbound spool. If the condition remains
tripped for ten minutes it stops only the rootless `cell` and `bridge`; it never stops the
host, rootless daemon, maintenance worker, 9Router, or CLI proxy.

Clear conditions must hold continuously for 15 minutes. The timer never removes the
pause marker, restarts services, releases `GLOBAL_STOP`, or resumes outbound.

Manual resume checklist (operator must have `openclaw_zalo.manage_operations`):

1. Confirm 15 minutes of clear host/model metrics and review the fingerprint.
2. Confirm no manual or organization `GLOBAL_STOP` is active.
3. Reconcile `DISPATCHING`/UNKNOWN and prove current lease/fencing/session generations.
4. Resume canonical health controls with an audited reason.
5. Remove `/srv/openclaw-runtime/operations/<cell>/host-guard.pause` only after step 4.
6. Start the rootless `cell`/`bridge` if they were stopped; verify fresh heartbeat and a
   controlled non-content smoke before restoring automation.

Never auto-resume after restart or timer recovery.
