# OpenClaw Zalo - VPS Migration

Target RTO is `<= 60 minutes`. Supabase and R2 remain external canonical stores and are
not copied. Default session handling is fresh QR login; never copy raw Zalo session state
to a new IP/host.

## Exact cutover sequence

The required sequence is:

1. Organization-scoped `GLOBAL_STOP` (must remain active on any failure).
2. Drain new claims; return safe `LEASED` rows to queue and freeze `QUEUED/LEASED`.
3. Move expired unresolved `DISPATCHING` to terminal `UNKNOWN`; never auto-retry it.
4. Snapshot old co-tenants read-only: ID, image, network, mounts, restart count, ports.
5. Provision the new rootless cell with no public Gateway.
6. Rotate workload credentials for the new cell.
7. Acquire a strictly higher fencing lease.
8. Revoke the old credential and lease; prove the old cell is fenced.
9. Require fresh QR re-login; do not copy session.
10. Sync 48-hour history with automation disabled and canonical dedupe.
11. Reconcile gaps and UNKNOWN with operator evidence.
12. Run a controlled one-send smoke and mandatory cleanup.
13. Compare co-tenants and fail on any change.
14. Resume only with `openclaw_zalo.manage_operations` and an audited reason.

Execute the checked state machine:

```bash
infra/openclaw-zalo/scripts/migrate-cell.sh \
  --old-runtime-env /srv/openclaw-runtime/cells/<old>/runtime.env \
  --new-runtime-env /srv/openclaw-runtime/cells/<new>/runtime.env \
  --adapter /opt/ihome-openclaw/bin/openclaw-migration-adapter \
  --evidence-file /srv/openclaw-runtime/evidence/migration-<date>.json \
  --confirm <organization>:<old-cell>:<new-cell>
```

On interruption, do not resume automatically. Preserve `GLOBAL_STOP`, current fencing,
and all UNKNOWN/audit evidence; diagnose from the last successful adapter checkpoint.
