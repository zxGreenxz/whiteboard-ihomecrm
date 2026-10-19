# Hermes connector service

The host runs only the CRM connector for an independently configured/updatable upstream Hermes: `version: 2`, `mode: "connector"`. CRM permissions govern CRM tool access only; see [CONNECTOR.md](../hermes-broker/CONNECTOR.md). The connector never starts, stops or configures personal Hermes, and never calls a model: the model/provider stays in the user's Hermes profile (production uses 9router directly).

The earlier managed CRM execution prototype (config `version: 1`, `hermes-host.service`, Docker runtime/gateway, `agent-process.py` wrapper and a model relay through the Copilot Edge `llm-proxy`) was never deployed and was removed on 17/10/2026. The loader now refuses a `version: 1` config and the host refuses any mode other than `connector`.

Entry point: `host-cli.mjs --config /absolute/private/connector.json`. It composes the existing broker/backend, encrypted handoff WAL and connection maintenance. No environment secret overrides or automatic provisioning are supported.

Deployment prerequisites are **native Linux, a static non-root UID/GID and Node 24.18.0 with the repository's pinned dependencies**. No Docker, image or model is required.

Provision outside the service:

- Create the static `ihome-hermes` user/group and the state root (default `/var/lib/ihome-hermes-connector`), owned by that UID/GID with mode 0700. The host creates only its fixed private children `handoff` and `audit`.
- Copy [connector-config.example.json](connector-config.example.json) to `/etc/ihome-hermes/connector.json` and replace the synthetic project, role, hosts and origins. Configuration, password, CA and raw key files must be owned by the same UID/GID with mode 0600, use canonical absolute paths, and have no symlinks. Keep secrets outside the state root's `handoff` directory (the loader refuses them there).
- Each key file contains exactly 32 raw bytes. Retain old version files in the key list while encrypted records still require them. The WAL derives its own domain-specific key from this ring. Password files have no trailing newline. Omit `caFile` only when the database certificate uses the system trust store; TLS verification stays enabled.
- Install the immutable application release and Node runtime at the paths in [hermes-connector.service](hermes-connector.service) (see Release package below). `current` may be a symlink to the release directory: the CLI compares realpaths to detect its entry point. Provision the dedicated database principal and reviewed schema separately; startup never applies migrations or creates roles.
- Configure the existing TLS reverse proxy to forward the Hermes HTTP endpoints to **127.0.0.1:8740**, preserving the configured Host and Origin. The host does not bind a public address, provision TLS or install proxy rules.

Run the CLI under the supplied systemd unit after those paths are prepared. `host_ready` means the listener and the maintenance loop started. Logs contain fixed lifecycle events. Broker audit metadata is written by the host audit adapter, separately from lifecycle logs.

SIGINT/SIGTERM first block new work and await actual startup and dependency drain. Repeated signals never force exit. The CLI also observes the host's terminal promise, so a listener failure triggers cleanup without waiting for a signal. Exit 0 means a clean stop completed, exit 1 means startup or running service failed with cleanup complete, and exit 2 means shutdown was retained. The unit deliberately sets `Restart=no`, an unlimited stop timeout and no forced SIGKILL. The host's durable ownership marker survives an unknown/crashed shutdown: **do not delete it or restart automatically** (see Crash and unclean stop). There is no PID/age-based takeover. Secret buffers copied by the backend/WAL are disposed, but JavaScript password strings cannot be reliably erased from memory.

Native Linux file permissions/fsync still require their deployment validation. Unit tests with fake ports and Windows parsing do not provide that evidence.

## Connector operations (version 2)

This runbook covers the independent connector (`mode: "connector"`, `/etc/ihome-hermes/connector.json`, state root `/var/lib/ihome-hermes-connector`, unit `hermes-connector.service`). Paths below are the documented defaults; use the ones in your config.

### Release package

`package.json` resolves `xlsx` from `file:vendor/xlsx-0.20.3.tgz`. The release directory must therefore contain `vendor/xlsx-0.20.3.tgz` next to `package.json`/`package-lock.json`, otherwise `npm ci --omit=dev --ignore-scripts` fails before the connector can start. Build the release from a git checkout (or an archive that keeps `vendor/`), run the install inside the release directory, then switch `current`. Never copy `node_modules` from a developer machine.

**Schema before connector.** A release may call an RPC that only a newer migration creates. Apply the migration to production first (forward lane), then confirm it on production before switching `current`. Releases from commit `262be4a7` onward call `public.hermes_scope_buildings_v1` (migration `20261017023242_hermes_scope_buildings_v1`) on every authentication. Check that `select to_regprocedure('public.hermes_scope_buildings_v1(text,uuid)') is not null` returns `true`. If the function is missing, every MCP call of the new connector fails with `backend_unavailable`. The older connector keeps working after that migration (it still calls `copilot_org_scope_buildings_v1`, which the migration leaves untouched), so rolling `current` back to it stays safe. Keep that Copilot function on production until no deployed release uses it.

The 19/10 simplification candidate additionally requires the reviewed metadata, inherited-permission and stable-binding migrations before its management UI/API is enabled. Apply all six candidate migrations in timestamp order through the forward lane; the shared cores precede the fast reader and copied-text parity changes. The optional `readFastPath` setting defaults to `false`. Enable it only after the target schema and authenticated customer/contract/invoice reads have been verified. A missing fast RPC returns `backend_unavailable`; it does not silently fall back. See [candidate status](../../docs/plans/hermes-crm/STATUS.md) for deployment evidence, rather than assuming these changes are already on production.

### Limits, deadline and maintenance wait

The optional `limits` block (see `connector-config.example.json`) has safe defaults when omitted: `requestsPerMinute` 60, `toolCallsPerMinute` 30, `callTimeoutMs` 20000, `maintenanceWaitMs` 5000. Rates are per connection and use a sliding 60-second window; a rejected call is not counted. A limited `tools/call` returns a normal MCP tool result with `isError: true` and `{"error":"rate_limited","retryAfterSeconds":N}` (or `busy` when two calls of the same connection are already running), so Hermes keeps its session; other MCP methods answer HTTP 429 with `Retry-After`. `callTimeoutMs` bounds one whole invocation, including admission, tool and audit work; keep it below the Hermes MCP client `timeout` (30 s in the documented profile). The loader refuses `callTimeoutMs + maintenanceWaitMs` above 25000 ms, so a waiting request plus its whole call always ends before that client timeout and the connector's 35 s idle-socket cut-off. Direct room reads may finish under their initial admitted scope without the two final authority/scope rechecks; group preview/send and canonical write checks retain their own rules. The fast reader caches only the bounded read catalog and obtains current authority in the business RPC. Raising a deadline does not bypass admission, expiry or revoke checks on a new call.

While a connection is renewed or its provider session refreshed, MCP requests of that token wait up to `maintenanceWaitMs` for the fence to open (at most two waiters per connection) and are admitted only after the refresh/renewal has drained; otherwise they get `503 connection_maintenance` and Hermes reconnects. The fence stays closed only when the maintenance drain itself is uncertain (its dependencies could still be running): then requests are refused immediately until a restart, see crash recovery below. A renewal or refresh whose ACK was lost but whose work drained cleanly reopens the fence; later requests re-read current authority, and an uncertain provider refresh is settled through `reconnect_session` rather than retried, so the user may have to reconnect.

### Status shown in CRM

`/settings/hermes` uses `POST /api/hermes/connections/overview` to load the caller's own connections and runtime status together; permission options are loaded when the form needs them. The compatibility `status` route remains available. The page shows the connector version (`serverInfo.version`), connector start time, last successful MCP/tool call and last error code. Runtime health is process memory, reset by restart, and never contains tokens, arguments or results. Loading is distinct from a failed request; a successful permissions change that cannot refresh its snapshot prompts a reload instead of being reported as a failed write.

### Optional Zalo profile reconciliation

The optional `zaloProvisioning` configuration accepts only explicitly mapped assistant/user/company/bot profiles; [the example](zalo-provisioning.example.json) contains synthetic IDs. Configure the real mapping outside the repository, with the required filesystem ownership and service write access. The reconciler reads the selected credential from the encrypted handoff and updates that mapped native profile. Missing credentials remain pending; it must not reuse an old credential or report success from an unchanged file alone.

This candidate does not provide a native-profile restart API or observe the running generation. After a configuration change, status remains `restart_pending`; the operator must restart and verify the native profile separately, and this reconciler cannot clear that status from a manual restart alone. Keep that distinction in the UI and operational checks: web confirmation alone does not prove Zalo is using the new credential. The connector itself still follows the clean-stop and ownership rules below.

### Backup and restore

Back up, encrypted and outside the VPS, with owner-only permissions:

- `/etc/ihome-hermes/connector.json` (paths and limits only, no secrets);
- `/etc/ihome-hermes/store-password`, the optional `store-ca.pem`;
- every key file still listed in `encryption.keys` (all versions, not only the active one);
- `/var/lib/ihome-hermes-connector/handoff/` (encrypted WAL of issued connection tokens; maintenance needs it to renew existing connections) and `audit/broker-audit.jsonl` if you keep audit history.

Do not back up or restore `.hermes-host.lock`, and do not back up personal Hermes profiles here. To restore: stop the unit and wait for the process to exit, restore files as `ihome-hermes:ihome-hermes` with mode 0600 for files and 0700 for directories (canonical paths, no symlinks), make sure no stale lock remains (see crash recovery), then start and check the journal for `host_ready`. A restored handoff never revives a revoked or expired connection: the backend re-reads current SQL/Auth authority, and such users simply reconnect from `/settings/hermes`.

### Rotating the encryption key

Create the new key with `head -c 32 /dev/urandom > /etc/ihome-hermes/keys/v2.bin`, set owner/mode 0600, append `{ "version": "v2", "file": ".../v2.bin" }` to `encryption.keys`, set `activeKeyVersion` to `v2` and keep `v1` in the list. Restart cleanly. New session envelopes and handoff records use `v2`; existing ciphertext stays readable only while `v1` remains configured. Remove `v1` only after every active connection has been refreshed or re-enrolled and old handoff records are gone; removing a version makes its ciphertext unreadable (there is no plaintext fallback) and those connections must reconnect.

### Rotating the store role password

The connector reads `store-password` only at startup, and the pool recycles connections within `maxLifetimeSeconds` (15 minutes). Prepare the new value first (`printf %s "$NEW" > store-password.new`, no trailing newline, owner `ihome-hermes`, mode 0600), then change the password of `hermes_store_host` through the reviewed admin path, immediately `mv` the new file over `store-password`, and restart the unit cleanly. Between the role change and the restart, new pool connections fail closed (MCP returns 503), so keep that window short. Verify with the journal (`host_ready`) and with a tool call that updates "Hermes gọi CRM lần cuối".

### Crash and unclean stop

The unit uses `Restart=no` on purpose. Exit 0 is a clean stop, exit 1 a failed start/run with cleanup complete, exit 2 a retained shutdown. After exit 2, a crash or a kill, `.hermes-host.lock` stays in the state root and the next start fails with `host_already_owned`. Do not script its removal. Recover manually: confirm no connector process is running (`systemctl status hermes-connector`, `pgrep -u ihome-hermes -f host-cli.mjs`), read the last journal events, confirm the handoff directory is intact (startup validates and decrypts it before serving), then remove only the lock file as `ihome-hermes` and start the unit. A connection whose maintenance drain was uncertain keeps answering `connection_maintenance` until the restart (a lost ACK with a clean drain does not need a restart); afterwards the backend re-reads the database, and a lease that already expired requires the user to reconnect.

### Audit file capacity

`audit/broker-audit.jsonl` is one append-only file capped at 16 MiB (roughly 80-100 thousand MCP calls). At capacity every MCP call fails closed with `backend_unavailable` (no data is returned without its audit receipt). Watch its size (`stat -c %s`). To rotate: stop the unit, move the file to an archive name (keep mode 0600), start the unit; it creates a new file. Never truncate or edit it while the connector runs.

### Time synchronisation

The host clock must be synchronised with database time. Lease RPCs bound a host-supplied heartbeat by PostgreSQL `clock_timestamp()` and refuse a time in the future with SQLSTATE 42501 (seen on production as `forbidden`). Connector maintenance decides with the host clock when to renew a lease of at most 15 minutes (5 minutes before expiry): a clock that runs ahead treats valid leases as expired and marks the connection for reconnect, a clock that runs behind renews too late and the database expires the lease. On an IPv4-only VPS the default `systemd-timesyncd` servers may resolve only over IPv6 and never sync. Configure IPv4-reachable servers, for example in `/etc/systemd/timesyncd.conf`:

```ini
[Time]
NTP=0.vn.pool.ntp.org 1.vn.pool.ntp.org time.cloudflare.com
```

then `systemctl restart systemd-timesyncd` and confirm `timedatectl show -p NTPSynchronized` prints `NTPSynchronized=yes` and `timedatectl timesync-status` shows a small offset. Check this after every VPS rebuild and before investigating `forbidden`/42501 errors from lease or renewal RPCs.

## Frontend on Vercel

The existing CRM UI uses same-origin POST requests. The two Node function entries under `api/hermes/connections/[operation].js` and `api/hermes/zalo/[operation].js` forward only the existing operation allowlists. They do not expose MCP, private queue RPCs or an arbitrary proxy. The SPA rewrite already excludes `/api/`; no new rewrite is required.

Set these **server-side Vercel variables** separately for each intended environment, then redeploy that frontend:

- `HERMES_UPSTREAM_ORIGIN=https://hermes-host.example.com`: the canonical HTTPS origin of the host's TLS proxy, with no path, query, credentials or trailing slash. It must be reachable by Vercel and different from the CRM origin.
- `HERMES_CRM_ORIGIN=https://crm.example.com`: the exact browser origin. No wildcard, automatic Preview hostname or caller-provided origin is trusted.

At the Linux host, terminate HTTPS for the upstream hostname and forward the two route families to `127.0.0.1:8740`. Preserve its upstream Host and the CRM Origin. Set `connector.json` HTTP `allowedHosts` to include `hermes-host.example.com` (with port when non-default), and `allowedOrigins` to include `https://crm.example.com`. Keep existing host checks enabled. Do not configure proxy access logs to capture request bodies or Authorization headers.

The browser JWT and JSON body reach the existing host handlers; those handlers still verify real Auth, organization membership and user permissions. Cookies and incoming forwarding/API-key headers do not pass through. Replies cannot set cookies, CORS or redirects. Native HTTPS performs certificate verification; the proxy never follows redirects or retries. Missing/invalid config returns 503 without an upstream call.

Each route exports Node `config.maxDuration=60`; the proxy's complete request deadline is 25 seconds. Verify the built function's effective duration is at least 30 seconds in the selected Vercel environment. A platform cutoff or missing write response still means an unknown result, requiring the existing reconciliation UI; it does not authorize retry. Local Node tests do not prove cloud routing, TLS, deployment settings or a real Zalo reply.
