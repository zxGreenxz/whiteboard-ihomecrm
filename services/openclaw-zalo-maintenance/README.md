# OpenClaw Zalo maintenance service

This process owns only organization-scoped retention and audit maintenance. It
uses an independent maintenance credential, lease generation, and fencing
token. It never depends on a connected Zalo account or a live channel cell.

## Canonical flow

- `QUARANTINE` calls `/v1/maintenance/work/complete` only. It performs no R2 or
  media-gateway request.
- `FINAL_DELETE` follows one path: delete-ticket -> authorize-delete -> Gateway
  DELETE -> completion. The exact signed ticket, proof, Gateway receipt, and
  completion body are replayed after an ambiguous response.
- `AUDIT_ANCHOR` signs the canonical trusted root projection with Ed25519,
  uploads one immutable JSON object, consumes a distinct one-use verify ticket,
  validates the exact Gateway receipt claims, and only then acknowledges work.

Every media ticket binds a distinct `receiptSigningKeyGeneration`; it is not the
ES256 `gatewayKeyGeneration`. Gateway receipt signature verification remains at
the Runtime trust boundary, which owns the registered Ed25519 keys.

Before signing an audit root, maintenance derives the public SPKI from the
loaded private key and requires its lowercase SHA-256 to equal the
DB-authoritative `auditSigningPublicKeyHash` in the claim and tickets.

## Authorized recovery

Claimed recovery work preserves the frozen signed lineage instead of creating a
new ticket after an ambiguous network result. Retention recovery uses
`RETENTION_DELETE_AUTHORIZED`; audit verification recovery uses
`AUDIT_VERIFY_AUTHORIZED`. Maintenance retries the stored artifacts first and
refreshes them only when Gateway returns the exact
`TICKET_EXPIRED_NO_WORK` denial. A stored Gateway receipt skips the Gateway call
and resumes completion directly.

The worker claims at most 25 items for at most 60 seconds and runs at most eight
items concurrently. Defaults are deliberately smaller. Gateway and network
calls remain outside database transactions.

## Required configuration

```text
OPENCLAW_FUNCTIONS_BASE_URL=https://<project>.supabase.co/functions/v1/
OPENCLAW_MEDIA_GATEWAY_URL=https://openclaw-media.chillhome.io.vn/
OPENCLAW_MAINTENANCE_ORGANIZATION_ID=<uuid>
OPENCLAW_MAINTENANCE_PRINCIPAL_ID=<uuid>
OPENCLAW_MAINTENANCE_CREDENTIAL_FILE=/run/secrets/maintenance-credential
OPENCLAW_AUDIT_PRIVATE_KEY_FILE=/run/secrets/audit-ed25519-pkcs8-b64
OPENCLAW_AUDIT_SIGNING_KEY_GENERATION=<positive integer>
```

The two secret files must be absolute, regular, non-symlink files with exact
Linux mode `0400`, no newline or NUL, and at most 16 KiB. Never pass the
maintenance credential or audit private key through environment variables or
arguments. Startup parses the audit key as Ed25519 PKCS8 and derives its public
SPKI before creating the health server or listening.

Optional bounds are `OPENCLAW_MAINTENANCE_CLAIM_LIMIT` (1-25),
`OPENCLAW_MAINTENANCE_LEASE_SECONDS` (47-60),
`OPENCLAW_MAINTENANCE_CONCURRENCY` (1-8), and
`OPENCLAW_MAINTENANCE_POLL_INTERVAL_MS` (100-300000).

## Health and shutdown

- `GET /livez` checks only that the process is serving.
- `GET /readyz` reports content-free `retentionReady`, `auditReady`,
  `runtimeReachable`, and `stale` state. It never includes channel, account,
  cell, or credential state.

Each work kind remains unready until that capability completes an item
successfully. Every claim hydrates authoritative unresolved-failure counts, so
a restart or another successful item cannot hide durable poison evidence.
Failure completion is bounded to five seconds inside the 47-second minimum
lease. An unreported in-process failure remains red until that exact item later
succeeds; a failed report also marks Runtime unreachable.

`SIGINT` and `SIGTERM` abort polling and active HTTP calls. The poll loop stops
boundedly even if a runner ignores its abort signal. The container runs as the
unprivileged `node` user. Shutdown drains health connections briefly, then
force-closes partial or hung HTTP connections after one second.

## Build and test

Use Node `>=24.15.0 <25` (the image currently pins Node 24.18.0):

```sh
npm ci
npm run typecheck
npm test
npm run build
npm start
```
