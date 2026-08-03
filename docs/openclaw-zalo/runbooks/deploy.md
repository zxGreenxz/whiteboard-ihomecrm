# OpenClaw Zalo - Deploy Watchdog And Host Guard

## Gate

Do not deploy before the reviewed commit, rootless isolation, migration/RLS/RPC tests,
backup RPO/RTO, known transfer quota, and co-tenant baseline are recorded. The watchdog
is outside the VPS and its only network target is the dedicated Supabase Edge endpoint:

`https://<project>.supabase.co/functions/v1/openclaw-watchdog`

It must never call or expose the OpenClaw Gateway, port `18789`, Docker socket, SSH, or
the 9Router/CLI management plane.

## Edge secrets

Configure secret references, never values, for:

- `OPENCLAW_WATCHDOG_ENVELOPE_KEYS_JSON` - Ed25519 **public** key registry keyed by
  generation. Each entry carries `generation`, `organizationId`, `publicKeySpkiBase64`,
  `allowedOperations`, `activatesAt`, `retiresAt`, `revokedAt`. No private key ever
  reaches the Edge. The Worker generation may sign `health.probe`/`health.record`; the
  cell host generation may sign `host.guard` only, so a compromised host cannot forge
  health records. There is no shared bearer secret: a bearer replays forever and proves
  nothing about operation, body, organization, or key generation.
- `OPENCLAW_WATCHDOG_PRINCIPAL_JSON` (current maintenance principal/fence metadata)
- `OPENCLAW_WATCHDOG_OWNER_ADMIN_USER_IDS` and `OPENCLAW_WATCHDOG_OWNER_ADMIN_EMAILS`
- `RESEND_API_KEY` and `OPENCLAW_WATCHDOG_EMAIL_FROM`

There is deliberately NO probe URL and NO control URL. Both would have required an
INBOUND port on the VPS that holds the Zalo session, which the design spec forbids
("chi them rule egress/namespace rieng va khong expose inbound port"). The watchdog
instead reads health from the database through
`openclaw_service_watchdog_snapshot_v1` and writes capacity controls through
`openclaw_service_apply_capacity_controls_v1`.

That data is already there without any new transport: the cell pushes heartbeat and
content-free metrics outward every minute through `POST /v1/heartbeat`, and reads the
active controls back in the response of that same call. This also measures the property
that actually matters - whether the cell can still reach Supabase - which an inbound
probe of the cell's own HTTP port cannot see: a cell can answer a probe cheerfully while
its link to Supabase has been down for hours.

The snapshot is content-free: heartbeat freshness, cell counts, and the nineteen
capacity metrics. It cannot proxy Gateway methods or return message, QR, cookie, token,
session, prompt, or provider payload data.

## Cloudflare Worker

Set `OPENCLAW_WATCHDOG_EDGE_URL`, `OPENCLAW_WATCHDOG_SIGNING_KEY_PKCS8_BASE64`,
`OPENCLAW_WATCHDOG_SIGNING_KEY_GENERATION`, and exact
`OPENCLAW_WATCHDOG_ORGANIZATION_ID` as Worker secrets. The signing key is the Ed25519
private key whose public half is registered in `OPENCLAW_WATCHDOG_ENVELOPE_KEYS_JSON`
under the same generation; it is imported non-extractable and never logged.

```bash
openssl genpkey -algorithm ed25519 -out worker-<generation>.pem
openssl pkey -in worker-<generation>.pem -outform DER | base64 -w0   # Worker secret
openssl pkey -in worker-<generation>.pem -pubout -outform DER | base64 -w0  # registry
```

Deploy only after:

```bash
npm --prefix infra/openclaw-zalo-watchdog ci
npm --prefix infra/openclaw-zalo-watchdog test
npm --prefix infra/openclaw-zalo-watchdog run typecheck
npm --prefix infra/openclaw-zalo-watchdog run deploy
```

The cron is exactly every minute, timeout is 10 seconds, heartbeat stale is strictly
after 90 seconds, and an availability incident opens after three consecutive failures.

## Host guard

Install only under the rootless runner. `/srv/openclaw-runtime/host-guard.env` contains
only `OPENCLAW_HOST_GUARD_RUNTIME_ENV=/srv/openclaw-runtime/cells/<cell>/runtime.env`.
The cell `runtime.env` must declare `OPENCLAW_WATCHDOG_SIGNING_KEY_GENERATION` exactly
once alongside `OPENCLAW_CELL_ID`, `OPENCLAW_ORGANIZATION_ID`, and
`OPENCLAW_WATCHDOG_EDGE_URL`. Provision the runner-owned `0400` Ed25519 private key at
`/srv/openclaw-runtime/secrets/<cell>/openclaw_watchdog_envelope_key.pem` outside Git;
register only its public half, restricted to `host.guard`.

```bash
systemctl --user daemon-reload
systemctl --user enable --now openclaw-host-guard.timer
systemctl --user list-timers openclaw-host-guard.timer
```

Verify the unit uses `DOCKER_HOST=unix:///run/user/%U/docker.sock`, runs every minute,
and cannot target rootful/global Docker or another host.
