# Hermes host service

This is the managed CRM execution prototype, not the default full personal Hermes deployment. The target uses independently configured/updatable upstream Hermes with a CRM connector; CRM permissions govern CRM tool access only. See [CONNECTOR.md](../hermes-broker/CONNECTOR.md). The bounded wrapper, disabled native toolsets, model relay and short history here must not constrain personal conversations, memory or non-CRM tools of that independent Hermes.

The same CLI now supports the independent connector with `version: 2`, `mode: "connector"` and no `model` field. Use [connector-config.example.json](connector-config.example.json) and [hermes-connector.service](hermes-connector.service) for that mode; Docker/image/profile prerequisites below apply only to the version 1 managed prototype. Connector mode starts MCP/management, encrypted handoff and connection maintenance; it does not start or stop personal Hermes.

Entry point: `host-cli.mjs --config /absolute/private/host.json`. It composes the existing broker, encrypted handoff WAL, runtime gateway/driver, profile leases, coordinated supervisor, command runner and reconciler. No environment secret/model overrides or automatic provisioning are supported.

Deployment prerequisites are **native Linux, a static non-root UID/GID, Node 24.18.0 with the repository's pinned dependencies, Docker Engine 28+ on a local Unix socket, and the pinned Hermes image already present**. This template has not been deployed or verified against a live Linux host. The service user must access that Unix socket; the supplied unit uses the local `docker` group and fixes the endpoint at `/run/docker.sock`. Use the reviewed image and release artifacts in this directory, not mutable image tags.

Provision outside the service:

- Create the static `ihome-hermes` user/group and `/var/lib/ihome-hermes`, owned by that UID/GID with mode 0700. The host creates only its fixed private children: `homes`, `homes/.leases`, `handoff`, `runtime`, `gateway`, `audit`.
- Copy `host-config.example.json` to `/etc/ihome-hermes/host.json` and replace the synthetic project, role, origins and model values. Configuration, password, CA and raw key files must be owned by the same UID/GID with mode 0600, use canonical absolute paths, and have no symlinks. Keep secrets outside all runtime/profile/gateway/WAL directories.
- Each key file contains exactly 32 raw bytes. Retain old version files in the key list while encrypted records still require them. The WAL derives its own domain-specific key from this ring. Password files have no trailing newline. Omit `caFile` only when the database certificate uses the system trust store; TLS verification stays enabled.
- Install the immutable application release and Node runtime at the paths in `hermes-host.service`. Provision the dedicated database principal and reviewed schema separately; startup never applies migrations or creates roles.
- Configure the existing same-origin TLS reverse proxy to forward the Hermes HTTP endpoints to **127.0.0.1:8740**, preserving the configured Host and Origin. The host does not bind a public address, provision TLS or install proxy rules.

Run the CLI under the supplied systemd unit after those paths are prepared. `host_ready` means the host listener and loops started; it does not assert every user runtime attached successfully. Logs contain fixed lifecycle events. Broker audit metadata is written by the host audit adapter, separately from lifecycle logs.

SIGINT/SIGTERM first block new work and await actual startup, runtime and dependency drain. Repeated signals never force exit. The CLI also observes the host's terminal promise, so a listener failure triggers cleanup without waiting for a signal. Exit 0 means a clean stop completed, exit 1 means startup or running service failed with cleanup complete, and exit 2 means shutdown was retained. The unit deliberately sets `Restart=no`, an unlimited stop timeout and no forced SIGKILL. The host's durable ownership marker and profile locks survive an unknown/crashed shutdown: **do not delete them or restart automatically**. Recovery requires checking the owned resources and prior work; there is no PID/age-based takeover. Secret buffers copied by the backend/WAL are disposed, but JavaScript password strings cannot be reliably erased from memory.

Native Linux file permissions/fsync, full product container startup and real Zalo/provider delivery still require their deployment validation lanes. Unit tests with fake ports and Windows parsing do not provide that evidence.

## Frontend on Vercel

The existing CRM UI uses same-origin POST requests. The two Node function entries under `api/hermes/connections/[operation].js` and `api/hermes/zalo/[operation].js` forward only the existing operation allowlists. They do not expose MCP, private queue RPCs or an arbitrary proxy. The SPA rewrite already excludes `/api/`; no new rewrite is required.

Set these **server-side Vercel variables** separately for each intended environment, then redeploy that frontend:

- `HERMES_UPSTREAM_ORIGIN=https://hermes-host.example.com`: the canonical HTTPS origin of the host's TLS proxy, with no path, query, credentials or trailing slash. It must be reachable by Vercel and different from the CRM origin.
- `HERMES_CRM_ORIGIN=https://crm.example.com`: the exact browser origin. No wildcard, automatic Preview hostname or caller-provided origin is trusted.

At the Linux host, terminate HTTPS for the upstream hostname and forward the two route families to `127.0.0.1:8740`. Preserve its upstream Host and the CRM Origin. Set `host.json` HTTP `allowedHosts` to include `hermes-host.example.com` (with port when non-default), and `allowedOrigins` to include `https://crm.example.com`. Keep existing host checks enabled. Do not configure proxy access logs to capture request bodies or Authorization headers.

The browser JWT and JSON body reach the existing host handlers; those handlers still verify real Auth, organization membership and user permissions. Cookies and incoming forwarding/API-key headers do not pass through. Replies cannot set cookies, CORS or redirects. Native HTTPS performs certificate verification; the proxy never follows redirects or retries. Missing/invalid config returns 503 without an upstream call.

Each route exports Node `config.maxDuration=60`; the proxy's complete request deadline is 25 seconds. Verify the built function's effective duration is at least 30 seconds in the selected Vercel environment. A platform cutoff or missing write response still means an unknown result, requiring the existing reconciliation UI; it does not authorize retry. Local Node tests do not prove cloud routing, TLS, deployment settings or a real Zalo reply.
