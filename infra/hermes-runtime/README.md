# Hermes runtime compatibility and isolation spike

This is a synthetic P1 harness. It never connects to CRM, Zalo or a paid model.
It is not a production gateway, credential store or memory service.

The runtime image is pinned to Hermes `v0.21.6`, source commit
`818c13be1dc4fd28987e1e881a9408224afd4535`, Linux amd64 manifest digest
`sha256:32d095e84190ae7266afbb361579e6921f2c633e899f5eacfb88111b9c851a22`.
The runner records image labels after pulling and rejects a conflicting revision.
An absent revision label remains explicitly unverified in the receipt.

## Commands

```powershell
node --test infra/hermes-runtime/runtime-contract.test.mjs infra/hermes-runtime/fixture-server.test.mjs
node scripts/test-hermes-runtime-isolation.mjs --preflight
node scripts/test-hermes-runtime-isolation.mjs --run
```

`--run` pulls only the pinned image and uses the installed Docker Linux engine.
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
Windows uses UID/GID 10000. The runner verifies the selected user and exact
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
   fake model also emits an unavailable terminal tool. Direct attempts to call
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

All containers attach to one internal Docker network. The harness inspects
mounts/privileges and probes an external IP and the fixture's management port.
Those probes do not prove that every host service is unreachable. Production
egress policy, DNS/IPv6/host-boundary coverage and broker/model gateway routing
need their own evidence before opening real data.
The shared internal bridge is not a per-user network policy: it does not prove
that an arbitrary new listener in a peer container could never be reached.

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
