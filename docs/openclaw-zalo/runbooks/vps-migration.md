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

## Migration adapter

`openclaw-migration-adapter` is committed at
`infra/openclaw-zalo/scripts/openclaw-migration-adapter.mjs`; install it as
`/opt/ihome-openclaw/bin/openclaw-migration-adapter`.

Every one of the seventeen steps fails closed. If a step cannot reach Supabase or the
rootless Docker socket it exits non-zero, which leaves `GLOBAL_STOP` active and the old
credentials revoked rather than resuming the organization on an unverified migration.

- `OPENCLAW_MIGRATION_SUPABASE_URL`, `OPENCLAW_MIGRATION_SUPABASE_SERVICE_KEY`
- `DOCKER_HOST` must be the runner's own `unix:///run/user/<uid>/docker.sock`; a
  rootful socket is rejected outright.
- `OPENCLAW_MIGRATION_COMPOSE_FILE` for provisioning the new cell.
- `OPENCLAW_MIGRATION_COTENANT_DIGEST` - the digest printed by
  `snapshot-old-cotenants`, which `compare-cotenants` must reproduce exactly.

Co-tenant handling is read-only by construction: the adapter only ever runs
`docker ps` and `docker inspect`, and holds no stop/restart/kill/exec verb, so it
cannot disturb the external 9Router or cli-proxy-api containers. `--copy-session` must
be `never` and both `--supabase-copy`/`--r2-copy` must be `false`; anything else is a
usage error.
