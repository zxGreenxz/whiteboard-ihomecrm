# Hermes runtime compatibility and isolation spike

This is a synthetic P1 harness. It never connects to CRM, Zalo or a paid model.
It is not a production gateway, credential store or memory service.

The production connector host in this directory (`host-cli.mjs`, `host-service.mjs`,
`host-config.mjs`, `hermes-connector.service`) is documented in
[HOST_SERVICE.md](HOST_SERVICE.md). The managed host v1 runtime (container
gateway/driver, `agent-process.py` wrapper and model relay) was never deployed and
was removed on 17/10/2026; this P1 experiment does not depend on it.

The runtime image is pinned to Hermes `v0.22.2` (release date string `2026.9.24`),
source commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8`, Linux amd64 manifest digest
`sha256:a11574b7fe8e1631d7d88d556677dac693bc058abf558cdeb899155688c1bf05`.
The upstream annotated tag's release receipt binds that commit to index digest
`sha256:36099926da316742423544e055d4734777105ffe6341873af5459b957d0c2919`;
the Linux amd64 member and its config are checked by content digest. This is an
unsigned upstream release receipt, not a signed build attestation or a reproducible
build proof. The runner still records image labels and rejects a conflicting revision.
An absent revision label stays unverified independently of the release receipt.
Earlier runtime receipts do not certify the current image: those for `32d095e8…`
used an image outside any release receipt, and those for `ffa4fbb4…` belong to the
previous pin, v0.21.6. The current image needs a new runtime run.

### Pin synced to production on 11/11/2026 (v0.21.6 → v0.22.2)

Production moved to v0.22.2 before this repository did, so until the sync CI probed
a different version than production ran.

- Read on the production host on 11/11/2026: container `hermes-owner` runs the digest
  above and reports `Hermes Agent v0.22.2 (2026.9.24)`, upstream `d923a5eb`,
  Python 3.14.7. The image was built on 15/10/2026 and the running container was
  created on 23/10/2026. No receipt records the moment of the upgrade itself:
  repository notes already mention v0.22.2 on that host on 19/10 and 21/10
  (`docs/plans/hermes-crm/STATUS.md`, `infra/hermes-broker/wave2-registry.mjs`).
- What was re-established for the new pin on 11/11/2026: the tag object, release,
  index and Linux amd64 manifest were fetched again from GitHub and Docker Hub and
  `image-provenance.json` was rebuilt from those bytes only (`assertImageProvenance`
  passes offline). The receipt is still unsigned. Nothing from the v0.21.6 artifact
  was carried over. The image config blob named by that manifest was also fetched by
  digest: it was created on 2026-10-15T06:20:46Z and carries no labels at all, so
  there is no revision label to compare against the pinned commit.
- Still missing for the new pin: the live `docker image inspect` check
  (`assertPinnedImageInspection`) and a synthetic runtime receipt. No Docker daemon
  was available where the pin was synced; jobs `native-upstream` and
  `synthetic-isolation` of the `Hermes synthetic runtime` workflow produce both.
- Behaviour found on v0.22.2 in production: a manual `hermes cron run <id>` executes
  the job synchronously inside the CLI process, without the gateway's live adapters,
  so it cannot deliver through the Zalo plugin; a scheduled run is executed by the
  ticker inside the gateway and delivers through the live adapter. The code path
  (`hermes_cli/cron.py` `_job_action`, `tools/cronjob_tools.py` `_run_claimed_job`)
  differs from v0.21.6 only in typing and lint edits, so this is an observation made
  on v0.22.2, not a change introduced by it. Details:
  [Zalo native plugin](../hermes-zalo-native/README.md), "Cron".
- The production Zalo plugin is a backport (the plugin released on 16/10 plus the
  `cron_deliver_env_var` declaration), not this repository's current `adapter.py`.
  The probes here test the repository's adapter against the pin, not that backport.

## Commands

```powershell
node --test infra/hermes-runtime/runtime-contract.test.mjs infra/hermes-runtime/fixture-server.test.mjs infra/hermes-runtime/profile-lease.test.mjs
node scripts/test-hermes-runtime-isolation.mjs --preflight
node scripts/test-hermes-runtime-isolation.mjs --run
```

`--run` pulls only the pinned image and requires a native Linux supervisor with
Docker Engine 28 or later for isolated IPv4/IPv6 bridge gateways. Docker Desktop
host/VM mismatch is blocked rather than counted as a network isolation success.
It does not install Docker, start services or change OS settings. To use a
nondefault Docker CLI path, set `HERMES_FIXTURE_DOCKER` in the invoking process.
Daemon absence produces a `BLOCKED` receipt and a nonzero exit. A preflight or
unit-test pass is never a runtime isolation pass.

Receipts and logs stay under `.cache/hermes-p1/hermes-p1-<run>/`. Synthetic
bootstrap tokens and private-note sentinels are generated per run and never
committed. Only container and network names created by that run are cleaned up;
cache files remain for evidence. There are no host port publications.

The `Hermes synthetic runtime` GitHub workflow runs the same command on an
Ubuntu 24.04 runner with Node 24.18.0. It requests no repository secrets and
uploads only `receipt.json` files, never bootstrap files, homes or logs. The
host supervisor selects its own nonzero numeric UID/GID on Linux so private
bind mounts remain writable without `chmod 777`, root or an ownership change.
Windows preflight/tests use UID/GID 10000. The runner verifies the selected user and exact
mounts on the live fixture and Hermes containers. No actor can select that UID.
Input hashes are captured before execution and compared again after cleanup;
changed or unreadable input invalidates the receipt.

When Docker is unavailable, the following separate experiment exercises the
actual upstream Hermes MCP client against the loopback fixture. It has no
container/network isolation claim and does not run `AIAgent` or a model. Use a
clean upstream checkout at the pinned commit; the launcher rejects a different
or modified checkout. It starts each client with a private home and a clean
environment without forwarding host provider credentials.

```powershell
python -m venv .cache/hermes-p1/transport-venv
& .cache/hermes-p1/transport-venv/Scripts/python.exe -m pip --isolated --disable-pip-version-check install --index-url https://pypi.org/simple --only-binary=:all: --require-hashes -r infra/hermes-runtime/requirements-transport-win-py312.lock
node infra/hermes-runtime/transport-compat.mjs --python .cache/hermes-p1/transport-venv/Scripts/python.exe --upstream .cache/hermes-p1/upstream-hermes-agent
```

The lock is for the tested Windows amd64/Python 3.12 transport fixture only.
It must not replace the upstream image dependency lock. A successful receipt is
named `PASSED_TRANSPORT_COMPATIBILITY_ONLY` and records exact installed versions,
source/input hashes and the positive/negative checks actually run.
The pinned MCP 2.0 client can flatten a rejected HTTP 401 into a generic MCP
error. The transport proof therefore also requires recorded 401 responses for
that same actor's call; a generic error or a 500/503 cannot pass as revocation.

## What the runnable experiment checks

1. A fixture service exposes the actual P1 broker through its MCP HTTP adapter,
   plus a deterministic OpenAI-compatible model. Its management listener binds
   only to its container's loopback address.
2. Two Hermes processes receive separate home mounts and separate bootstrap
   files. Neither gets the other user's files, the host home/vault, a Supabase
   JWT or the Docker socket. The root filesystem is read-only and processes run
   as the supervisor-selected nonroot UID/GID with capabilities dropped.
3. The real Hermes `AIAgent` discovers and calls only `crm_auth_context`. The
   fake model also emits unavailable terminal, browser and HTTP tools. Direct attempts to call
   an unknown MCP tool or provide a different actor/org must be rejected.
   These assertions require the exact policy error, including a missing shell
   execution marker. Generic errors or backend outages fail the verifier.
4. Hermes native memory, SQLite session store and OAuth-token store each use
   their own home. A process restart must retain its own synthetic state and
   reveal no state belonging to the other actor. The fake model rejects foreign
   sentinels and broker tokens in a prompt.
5. A trusted wrapper checks broker admission before sending context to the
   model and before releasing the answer. A revoked connection must discard its
   retained agent/history and make no further model call; B remains usable.

Each actor attaches to its own internal Docker network with isolated IPv4/IPv6
gateways and no inherited external DNS. The fixture joins both, with forwarding
disabled and capabilities dropped. Live peer listeners must be blocked through
IPv4, IPv6 and Docker DNS. A separate disposable control network provides TCP and
UDP/TCP DNS canaries; host canaries bind only its exact gateway addresses. Positive
controls run before and after negative actor probes and must increment counters;
actor probes must leave those counters unchanged. Unit listeners default to loopback.
This covers representative protocols/ports, not every host service or a production
firewall. Inspection verifies exact network membership and no host port publication.

`ProfileLeaseStore` keeps immutable assistant/user/org/home bindings and an atomic
exclusive lock outside every mounted home. It refuses duplicate holders, owner
reassignment, nested homes, path/symlink escape and restart after profile revoke.
The lock is released only after the container has stopped. A crashed holder is
never reclaimed by age or PID automatically; operator reconciliation is required.
This is a single-host supervisor primitive, not a distributed lease or a service
that removes CRM-derived memory from disk. It does not implement regrant yet.

## Deliberate limits

The memory note is synthetic private fixture data. Clearing an in-memory agent
does not scrub native memory files or previously retained CRM facts. Production
CRM-derived memory needs provenance, authorization versions and invalidation
across disk, active context, jobs and responses; that remains separate work.

The broker here uses its injected fixture identity provider. It does not prove
Supabase `auth.uid()`, RLS, user-session refresh, OAuth audience/expiry, TLS,
production quotas, approvals, Zalo delivery or the later multiuser supervisor.
The wrapper does not claim to cancel an effect already dispatched.

The container entrypoint is intentionally the sealed image Python interpreter,
running the trusted probe. It exercises upstream `AIAgent`, MCP, memory and
session code directly; it does not exercise the upstream dashboard or service
supervisor. Image paths and dependency compatibility are established only by a
successful runtime receipt, not by the static contract tests.
