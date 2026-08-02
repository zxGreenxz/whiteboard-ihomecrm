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

- `OPENCLAW_WATCHDOG_SHARED_SECRET`
- `OPENCLAW_WATCHDOG_PRINCIPAL_JSON` (current maintenance principal/fence metadata)
- `OPENCLAW_WATCHDOG_PROBE_URL` ending `/openclaw-health/v1/snapshot`
- `OPENCLAW_WATCHDOG_PROBE_TOKEN`
- `OPENCLAW_WATCHDOG_CONTROL_URL` ending `/openclaw-health/v1/controls`
- `OPENCLAW_WATCHDOG_CONTROL_TOKEN`
- `OPENCLAW_WATCHDOG_OWNER_ADMIN_USER_IDS` and `OPENCLAW_WATCHDOG_OWNER_ADMIN_EMAILS`
- `RESEND_API_KEY` and `OPENCLAW_WATCHDOG_EMAIL_FROM`

The health snapshot/control collector is content-free and narrowly authenticated. It
cannot proxy Gateway methods or return message, QR, cookie, token, session, prompt, or
provider payload data.

## Cloudflare Worker

Set `OPENCLAW_WATCHDOG_EDGE_URL`, `OPENCLAW_WATCHDOG_BEARER_TOKEN`, and exact
`OPENCLAW_WATCHDOG_ORGANIZATION_ID` as Worker secrets. Deploy only after:

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
Provision the runner-owned `0400` watchdog token file outside Git.

```bash
systemctl --user daemon-reload
systemctl --user enable --now openclaw-host-guard.timer
systemctl --user list-timers openclaw-host-guard.timer
```

Verify the unit uses `DOCKER_HOST=unix:///run/user/%U/docker.sock`, runs every minute,
and cannot target rootful/global Docker or another host.
