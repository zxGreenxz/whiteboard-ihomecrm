# OpenClaw Zalo - Capacity And Quotas

## Alert inventory

Record content-free queue lag, unresolved UNKNOWN count/rate, adapter errors, reconnects,
CPU/RAM/disk, spool age/bytes, media backlog, R2 failures, Supabase egress, R2
storage/requests, VPS outbound, and transfer quota. Forecast Supabase/R2 usage over 7 and
30 days. Unknown transfer quota blocks proactive/group media production.

Quota thresholds are exact:

| Usage | Required action |
|---|---|
| 60% | Warn owner/admin and review forecast. |
| 80% | Disable automatic video/file caching. |
| 90% | Pause noncritical proactive/group media. |
| 100% | Pause every outbound message containing media. |

Queue lag p95 greater than 30 seconds for five minutes, UNKNOWN greater than 3/10 minutes
or greater than 2% with at least 20 attempts, adapter error greater than 1%, spool at 80%,
and any R2 failure generate incidents. Spool at 95% preserves minimal inbound only.

## Host guard thresholds

- 9Router/CLI p95 regression `>20%` for 5 minutes.
- 9Router/CLI error rate `>1%` for 5 minutes.
- host RAM `>75%` for 15 minutes.
- swap `>10%`.
- one-minute load `>12` for 15 minutes.
- root free disk below `max(200 GiB, 20%)`.

Trip pauses outbound, AI, and media immediately and preserves minimal inbound spool.
Ten more minutes tripped stops only rootless cell/bridge. Clear must hold 15 minutes;
resume is never automatic and requires `openclaw_zalo.manage_operations`.

Before another cell, run a seven-day capacity soak, compare co-tenants, keep queue p95
under 30 seconds, keep OpenClaw CPU/RAM under 70% of cap, and retain host/control-plane
headroom. Scale only the isolated OpenClaw stack; do not inspect or mutate 9Router/CLI.
