# OpenClaw Zalo bridge

The bridge is the local durability and policy boundary between the private
ZaloUser cell and the OpenClaw control plane. It exposes only content-free
health endpoints; credentials, QR payloads, provider frames, model secrets and
raw runtime responses must never be written to logs.

## Run

Build before starting the compiled executable:

```sh
npm ci
npm run build
npm start
```

The listener uses `OPENCLAW_BRIDGE_HOST` (default `0.0.0.0`) and
`OPENCLAW_BRIDGE_PORT` (default `8080`). Invalid or out-of-range values stop the
process before it binds a socket. The executable creates the SQLite spool,
runtime-token client, authenticated inbound controller, heartbeat, inbound
drain, outbox send worker and channel-status loop before it declares traffic
ready. Send-work handlers are explicit composition dependencies; the worker
does not claim background work unless all three handlers are installed.

Required runtime identity and endpoints are supplied through
`OPENCLAW_ORGANIZATION_ID`, `OPENCLAW_ACCOUNT_ID`, `OPENCLAW_CELL_ID`,
`OPENCLAW_SESSION_GENERATION`, `OPENCLAW_FENCING_TOKEN`,
`OPENCLAW_FUNCTIONS_BASE_URL`, `OPENCLAW_GATEWAY_URL`,
`OPENCLAW_MEDIA_GATEWAY_URL` (the exact HTTPS `/v1/object` endpoint), and
`OPENCLAW_MEDIA_ALLOWLIST` (a comma-separated DNS host allowlist). Persistent paths use
`OPENCLAW_SPOOL_PATH` and `OPENCLAW_MEDIA_TEMP_DIRECTORY`; the image defaults
both beneath `/var/lib/openclaw-bridge` and makes that directory writable only
by the unprivileged runtime user.

The bridge authenticates to the OpenClaw Gateway v4 WebSocket protocol with a
paired device token and Ed25519 device identity before it can call
`channels.status`, `agent`, or `zalouser.bridge.send`. The token and one-line
JSON identity are mounted through `OPENCLAW_GATEWAY_DEVICE_TOKEN_FILE` and
`OPENCLAW_GATEWAY_DEVICE_IDENTITY_FILE`.

QR material is encrypted before Runtime publication with the shared AES-256-GCM
key mounted at `/run/secrets/openclaw_qr_encryption_key`. Production sets
`OPENCLAW_QR_ENCRYPTION_KEY_FILE` to that exact path; the file contains one
canonical standard-base64 value that decodes to exactly 32 bytes.

For every Runtime `media` mapping, the bridge uses Node 24's environment-proxy
fetch transport for both the provider download and media-gateway upload.
Production requires `NODE_USE_ENV_PROXY=1` and a reviewed, credential-free
`HTTPS_PROXY=http://<egress-broker>:<port>` supplied by the Task 19 composition;
startup fails before reading secrets when either setting is absent or malformed.
It never falls back to a direct production DNS lookup or socket. The bridge still revalidates
the allowlisted HTTPS redirect chain, verifies the downloaded bytes, obtains an
upload ticket, and submits the signed `MEDIA_UPLOAD` receipt to Runtime. The
local spool row is acknowledged only after every mapped receipt is finalized as
`AVAILABLE`; failures stay durable for retry.

## Health

- `GET /livez` checks the process only and never contacts a dependency.
- `GET /readyz` returns `inboundReady`, `outboundReady`, `aiReady` and
  `heartbeatStale`. It returns HTTP 503 when `inboundReady` is false. A paused
  channel or unavailable model may leave inbound healthy while
  `outboundReady` or `aiReady` is false.

Heartbeat cadence is 10 seconds and becomes stale after 90 seconds. The AI
circuit breaker pauses AI-assisted automatic delivery without disabling manual
non-AI sends.

## Secrets and logs

Mount the runtime credential, cell-local workload secret, Gateway device token,
Gateway device identity, and QR encryption key as direct files at
`OPENCLAW_RUNTIME_CREDENTIAL_FILE`, `OPENCLAW_ZALO_BRIDGE_SECRET_FILE`,
`OPENCLAW_GATEWAY_DEVICE_TOKEN_FILE`, `OPENCLAW_GATEWAY_DEVICE_IDENTITY_FILE`, and
`OPENCLAW_QR_ENCRYPTION_KEY_FILE`
(defaults under `/run/secrets`). Each file must be owned by the service UID with
mode exactly `0400`. Nested paths, symlinks, owner-writable files, multiline
data and values larger than 16 KiB are rejected. Inline credential, token,
password, API-key, private-key, or service-role environment variables are
rejected before the process binds or opens a network connection.

Structured logs must pass through the bridge redactor. It removes auth headers,
tokens, cookies, QR/ciphertext, signed URL fields, session/device secrets,
phone numbers and known secret values. Operational snapshots contain counters,
timestamps and state labels only.

Automatic drafting uses an internal, uniquely hashed agent session and suppresses
customer prompt persistence. Stock OpenClaw may retain an assistant-only internal transcript;
Task 19 host isolation keeps that private residual on encrypted storage and owns its lifecycle.

## Container

`Dockerfile` builds with Node 24.18 and runs as the image's unprivileged `node`
user. Its Docker health check calls local `/livez`; orchestration readiness must
call `/readyz` separately so a live but stale bridge is not sent inbound work.
