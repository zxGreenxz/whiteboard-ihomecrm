# OpenClaw Zalo - Rollback

Rollback is forward-compatible and evidence-preserving. Do not drop OpenClaw tables,
delete audit/UNKNOWN rows, copy session data, or mutate legacy `/chat-zalo`, `worker/**`,
`zalo_*`, 9Router, or CLI proxy.

Exact emergency order:

1. Set organization `GLOBAL_STOP` and stop new claims.
2. Drain/freeze; return provably pre-handoff `LEASED` items, and move unresolved expired
   `DISPATCHING` to `UNKNOWN`.
3. Fence the cell with a higher lease/generation and revoke its workload credential.
4. Disable OpenClaw frontend/runtime feature flags and new object tickets.
5. Stop only the rootless OpenClaw cell/bridge; retain encrypted session, spool, R2, DB,
   and immutable evidence.
6. Compare pre/post co-tenant ID, image, network, mounts, restart count, and ports.
7. Reconcile queue/gaps/UNKNOWN before any manual resume.

Rollback target is 30 minutes. A failed rollback leaves `GLOBAL_STOP` active. Release is
manual, requires `openclaw_zalo.manage_operations`, explicit reason/confirmation, current
fence/session/control versions, and clean smoke evidence.
