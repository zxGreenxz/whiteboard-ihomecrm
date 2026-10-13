# Hermes host service

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
