# OpenClaw Zalo Personal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a production-grade, tenant-isolated OpenClaw Zalo Personal cockpit at `/openclaw-zalo` for the current company, with QR login, inbox, guarded AI/manual/proactive sending, owner-controlled sales groups, durable outbox, private media, operations controls, and a replaceable Vultr runtime.

**Architecture:** Supabase remains the canonical multi-tenant control plane; a dedicated rootless OpenClaw 2026.7.1 cell installs one reproducibly built, integrity-pinned internal `@openclaw/zalouser` fork that keeps plugin ID/channel `zalouser`, and a policy-aware TypeScript bridge runs beside it without sharing the legacy Zalo worker, 9Router containers, networks, volumes, or secrets. A separate Cloudflare Worker and private R2 bucket handle media through exact-key, short-lived, one-use tickets, while inbound callbacks become durable before internal listener success and every business send uses private RPC `zalouser.bridge.send` plus provider-entrypoint authorization.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind, shadcn/ui, TanStack Query, Zod, Supabase Postgres/Auth/Realtime/Edge Functions, Node.js, SQLite WAL, OpenClaw 2026.7.1, vendored `@openclaw/zalouser@2026.7.1` fork, rootless Docker Compose, systemd, Cloudflare Workers/R2/Durable Objects, Vitest, fast-check, Playwright. The OpenClaw/vendor gate runs Node `>=24.15.0 <25`; Node `22.20` is unsupported for that gate.

---

## 1. Locked Decisions

- The approved design is `docs/superpowers/specs/2026-07-26-openclaw-zalo-personal-design.md`; implementation must not reopen its product decisions.
- The new route is exactly `/openclaw-zalo` and the new permission resource is exactly `openclaw_zalo`.
- Never modify, import, query, migrate, or reuse `worker/**`, `zalo_*`, `/chat-zalo`, `src/hooks/useZaloChat.ts`, or `src/components/chat-zalo/**`.
- Supabase is canonical. The Vultr host stores only OpenClaw session state, bounded SQLite spool data, temporary media, and deploy configuration.
- The existing Vultr Seoul host is used. Do not create a new VPS, restart/recreate current 9Router or `cli-proxy-api` containers, join their Docker networks, mount their volumes, or share secrets.
- Initial runtime caps are 4 vCPU, 8 GiB RAM, and a fixed 20 GiB filesystem under `/srv/openclaw-runtime`.
- One active Zalo Personal account and one effective cell are allowed per organization. Future organizations get their own account, cell, credential, session, and allowlists.
- `GLOBAL_STOP` is organization-scoped and precedes all other outbound policy decisions.
- `UNKNOWN` is terminal for automatic processing. It is never retried; an authorized operator must reconcile it once with CAS.
- Production keeps OpenClaw `2026.7.1`. The ZaloUser fork keeps package name/version `@openclaw/zalouser@2026.7.1`, plugin ID and channel `zalouser`; set `session.dmScope` to `per-account-channel-peer` and install exactly this one internal package.
- Upstream locks are immutable: fixed tarball URL `https://registry.npmjs.org/@openclaw/zalouser/-/zalouser-2026.7.1.tgz`, byte size `2341459`, `3169` regular `package/` entries, npm integrity `sha512-klg0BOOTDv4xUykgA/pTZDsRrI9dzagq23OlPupCLrFijDOebPxGYaYdWDSPy4zBJAWjjnSrgyCB+5OuCMvZGw==`, shasum/SHA-1 `ddd42ffa571e93a881ca5c95203eb7a49713f6c6`, mandatory npm attestation subject `pkg:npm/%40openclaw/zalouser@2026.7.1`, mandatory SLSA resolved commit `2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4`, git head `2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4`, OCI index digest `sha256:6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c`, `linux/amd64` digest `sha256:165b4992f1b4b74ffdd7a02c887ba006f9f5dc951eca420eef573a8b233b543f`, and reference `linux/arm64` digest `sha256:38b611f494cb32e15aaf456d54c6b6be55db9098c90632aed0bfad4a70009707`. This redirect policy belongs only to the tarball: at most three HTTPS redirects, every hop/final host `registry.npmjs.org` or one direct subdomain, no downgrade or cross-organization host.
- Attestation/SLSA verification is fail-closed for every baseline, release, and positive fork gate. Metadata unavailable, provenance/signature mismatch, or network failure is a hard stop. An offline verification may only recheck committed bytes and cannot create/update `FORK.json` hashes, evidence, internal tgz/release artifacts, or unlock Tasks 3-29.
- The signed tgz subject SHA-512 must equal the exact SRI-decoded digest `92583404e3930efe3153292003fa53643b11ac8f5dcda82adb73a53eea422eb1628c339e6cfc4661a61d58348fcb8cc12405a38e74ab832081fb93ae08cbd91b`. The npm publish signature is pinned to key ID `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`, `ecdsa-sha2-nistp256`, and SPKI bytes `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==`. SLSA signer trust pins Fulcio URI SAN `https://github.com/openclaw/openclaw/.github/workflows/plugin-npm-release.yml@refs/heads/release/2026.7.1`, OIDC issuer `https://token.actions.githubusercontent.com`, workflow event `workflow_dispatch`, repository/ref, environment `npm-release`, leaf certificate SHA-256 `9049091963146e23f13feede0d1dcfdae76e353b343bb37f0d8690527a722038`, Fulcio root DER SHA-256 `3ba7b6cc4e95469d4d334b49cb257ad8537076fa84b0ca87ff4ecfe6a54680c1`, intermediate DER SHA-256 `15d795348226b4649f750f5802592c393bee7cc53c3b86982175b7ad087efe47`, build type `https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1`, and resolved commit `2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4`. Chain/log material must come from the committed trust-root blob. Rekor pins base64 key ID `wNI9atQGlz+VWfO6LRygH4QUfY/8W4RFwiT5i5WRgB0=` and SPKI SHA-256 `c0d23d6ad406973f9559f3ba2d1ca01f84147d8ffc5b8445c224f98b9591801d`, and fail-closes unless DSSE PAE/signature, SET, inclusion proof, signed checkpoint, integrated time, canonicalized body, envelope/payload hashes, certificate validity, and body-to-subject/build binding all verify.
- Commit `M` is self-contained and raw-byte portable. It includes `.gitattributes` and exact bytes at `upstream/provenance/npm-registry-metadata.json`, `upstream/provenance/npm-registry-keys.json`, `upstream/provenance/npm-attestation-bundles.json`, and `upstream/provenance/sigstore-trusted-root.json`, retaining complete verification inputs rather than projections. Each acquisition is unauthenticated GET with `Accept: application/json`, `Accept-Encoding: identity`, status `200`, JSON content type, and zero redirects. Metadata uses `https://registry.npmjs.org/@openclaw%2Fzalouser/2026.7.1` / 64 KiB; keys `https://registry.npmjs.org/-/npm/v1/keys` / 64 KiB; attestations `https://registry.npmjs.org/-/npm/v1/attestations/@openclaw%2fzalouser@2026.7.1` / 256 KiB; Sigstore trust root `https://tuf-repo-cdn.sigstore.dev/targets/6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66.trusted_root.json` / 64 KiB, exact size `6787`, SHA-256 `6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66`. The fetcher streams cap+1, aborts overflow, and persists unchanged raw bodies. `UPSTREAM.json` binds every path/size/SHA-256/endpoint/cap and trust identity. Qualifying checks use committed Git blobs via `git ls-tree`/`git cat-file`, never working-tree bytes. Refetch may compare but not rewrite `M`.
- Immutable Task 2 checkpoints are ordered: commit `M` contains `.gitattributes`, the manifest, and self-contained raw provenance inputs and is independently reviewed only after it exists; commit `R` freezes every tracked source/artifact/lock/tooling output and is independently reviewed at its exact SHA. Schema-v1 evidence embeds the exact canonical `M` and `R` review report bytes as base64 plus byte size/SHA-256, exact reviewed SHA, reviewer role/identity/run ID, decision `APPROVED`, and an empty findings array. A qualifying gate exports exact `R` from Git object bytes while preserving blob type/mode, executes only the exported tree, and writes candidate evidence only under the source worktree's ignored `.release/`. Successful output is copied into a detached child worktree at exact `R` and committed as evidence-only child `E`; `E^` must equal `R` and `R..E` must change exactly `services/openclaw-zalo-cell/build-evidence.json`. Only an independent reviewer that revalidates the embedded reports and exact one-file diff may approve `E` and unlock Tasks 3-29. No pre-commit, working-tree, or plan-only review claim is a gate.
- The upstream root `LICENSE` SHA-256 is `73571b25326281d369087f469842c02444fe39faaecebda4d82ed21ff3a1c29d`; root `THIRD_PARTY_NOTICES.md` SHA-256 is `c84200f7a9bb8b3abc8563520433316716a9eb83915cfe7c3063d5e6fce5e7ca` and its exact bytes are committed as `upstream/THIRD_PARTY_NOTICES.openclaw.md`. The published tarball contains exactly `25` package-owned regular files outside `package/node_modules/**`, `3144` bundled regular files, and `38` package roots; the package-owned set contains no TypeScript, tests, source maps, license, or notice files.
- The vendor root is `services/openclaw-zalo-cell/vendor/zalouser-bridge/`. The published npm tarball is verified but is not treated as a TypeScript source/test distribution; the repo commits the exact `75` blobs under `extensions/zalouser` at the pinned git head, applies the committed patch series and bridge overlay, preserves all `39` bundled dependency license carriers under `licenses/<package>@<version>/<original-path>`, and emits the exact internal tgz. `pako@2.2.0` preserves both `LICENSE` and `lib/zlib/README`; `spark-md5` explicitly selects the included WTFPL branch and never fetches absent `LICENSE2`.
- Committed reviewed `licenses/manifest.json` is the independent source of truth, not generated from internal notice/tgz. It contains exact 38 package name/version/SPDX selections and exact 39 source carrier paths/sizes/SHA-256/output paths; `UPSTREAM.json` and `FORK.json` bind its SHA-256 and counts. Internal `THIRD_PARTY_NOTICES.md` and carrier tree are rendered/verified from it, and an independent document/artifact review must approve the manifest and rendered outputs before pack evidence is accepted.
- Internal `THIRD_PARTY_NOTICES.md` contains the upstream root notice verbatim plus the exact inventory, carrier paths, the pako exception, and the Spark-md5 selection. `FORK.json.artifactMembers` is the exact sorted file-by-file path/type/mode/size/SHA-256 manifest for the tgz, while `runtimeReachabilityAllowlist` is the exact sorted required runtime JS/JSON/package-metadata set. The tgz uses exact archive paths `package/LICENSE`, `package/THIRD_PARTY_NOTICES.md`, and `package/licenses/**`; structural bans remain absolute, category pruning cannot remove an allowlisted runtime member, and no unlisted member is allowed. Clean install/load, upstream-compatible, and differential runtime tests must pass.
- Docker installs only the verified internal tgz and never resolves registry ZaloUser during image build/runtime. The Dockerfile has exactly two stages, `install` and `runtime`; it never runs `npm ci` or compiles session-crypto. Before `R`, the Node gate clean-builds session-crypto twice and commits exactly `dist/package.json`, `dist/crypto.js`, and `dist/daemon.js`; `dist/package.json` is exact bytes `{"type":"module"}\n`. The install stage runs the Node `>=24.15.0 <25` assertion first in the same `RUN --network=none`, then installs the local tgz with one newly created, initially empty cache and no reuse/fallback. The runtime stage copies only the installed fork, those three reviewed dist blobs, and runtime config. Base-image acquisition remains the separate pinned `--pull` operation; only application `RUN`/install work is networkless, so the design does not claim air-gapped base acquisition. `FORK.json.installedTree` binds the sorted installed path/type/mode/size/SHA-256 manifest plus file/directory counts and root hash. Verification cross-checks `openclaw plugins list --json`, plugin inspect output, installed `package.json`, all loader/discovery roots, and duplicate/shadow candidates; upstream and fork packages may not coexist.
- Reproducible image gates accept only exact `-ReviewedTree` and an absolute verified `-BuildxPath`. Buildx is exactly `0.13.1`, with binary SHA-256 `6b113e84cbc3cd645646aa82f00a7f7d3737cc10375b4341e0aca0de0c997c75` on Windows or `3e2bc8ed25a9125d6aeec07df4e0211edea6288e075b524160ef3fd305d3d74c` on Linux; BuildKit is exactly `moby/buildkit:v0.13.2@sha256:9194b5ec1be368f41c516df7f93f7f540630ea06136056b2ffebb62226ed4ad6`. Context-root v2 and evidence bind the exact three session-crypto dist Git blobs, while final-rootfs evidence binds their installed hashes and rejects d.ts/tests/source/locks/tsconfig/node_modules/compiler/cache. Two fresh builders must produce byte-identical OCI archives and byte-identical extracted OCI layout/index/blob sets, not merely matching manifest/config/layer digest lists. `build-evidence.schema.v1.json` is closed at every object level, and the PowerShell 7.3 helper is self-contained, checked-native, fail-fast, and performs the dependency-free Node assertion before creating work/artifact/evidence or invoking its first Node/npm/npx/vendor subcommand.
- The vendor package exposes `vendor:prepare`; it must not define npm lifecycle script `prepare`, because `npm ci` may invoke lifecycle hooks before the qualifying gate intends to prepare source. The session-crypto package/lock keep reviewed `engines.node >=22.13.0` as their runtime/library minimum; Node `>=24.15.0 <25` is a separate build/gate requirement and must not rewrite that engine range.
- The production Compose file publishes no Gateway port. OpenClaw and bridge communicate only on a private internal Docker network.
- Do not enable OpenClaw's Docker sandbox backend because it mounts the Docker socket. The cell receives no Docker socket, shell tool, browser tool, arbitrary HTTP tool, filesystem tool, or SQL tool.
- The first production role grant is explicit: every active system role whose exact normalized name is `Chủ sở hữu tổ chức` receives all eight OpenClaw permissions; the ASCII transliteration is documentation/test data only and is never matched in production. No other role receives the permissions automatically. The owner can grant/revoke staff permissions later through the existing authorization UI.
- Permission sensitivities are fixed for the migration: `view=VIEW`, `send=MANAGE`, `manage_knowledge=MANAGE`, `manage_handoff=MANAGE`, and `manage_connections/manage_automation/manage_operations/audit=ELEVATED`.
- `sales_task_due` means a due lead follow-up: `lead_activities.activity_type='FOLLOW_UP'`, `scheduled_at <= DB now()`, `completed_at IS NULL`, with organization derived from the parent lead. It does not use the operational `jobs` table.
- Browser and automated test writes are restricted to DEMO organization `dddd0000-0000-4000-8000-000000000001`. Production organization `aaaa0000-0000-4000-8000-000000000001` is read-only except the controlled production smoke procedure.
- Auto-reply, proactive sends, first-contact/friend workflows, and sales-group sends remain disabled until their rollout gates pass. Manual draft-only mode is the default after infrastructure deployment.
- Task 2 is a positive global architecture gate. No database, Edge, runtime, frontend, infrastructure, or rollout task may proceed until immutable commits `M` and `R` were independently reviewed at their exact SHAs, verification/build ran without tracked mutation from `R`, evidence-only direct child `E` changed exactly `build-evidence.json`, and exact `E` independently passed with verified upstream/source/runtime locks, patch/tgz hashes, full inbound listener ordering, every outbound choke point fail-closed, control-traffic classification, deterministic `linux/amd64` image evidence, and internal-only installation.
- The owner approved the vendored integrity-pinned fork on 2026-07-27. Tasks 3-29 are open only after exact evidence child `E` passes independent review; there is no alternate external adapter, owner wait checkpoint, separate hook package, or pre-commit reviewed-state shortcut in this plan.
- Connection state, session-risk state, and configured/effective send mode are separate canonical fields. `CONNECTED_DRAFT_ONLY` is display text derived from `connection_state='CONNECTED'` plus `effective_mode='DRAFT_ONLY'`; it is never persisted as a connection state.
- `DISPATCHING` begins only when the authorize-send CAS wins immediately before the first possible provider handoff. It never returns to `QUEUED`; any sweeper that wins against an unresolved `DISPATCHING` row records `UNKNOWN`. A late completion is accepted only when it wins the same row-lock/CAS and every claim/session/fencing/control/takeover version still matches.
- Channel runtime and organization maintenance are separate principals. Retention and audit anchoring use an account-independent maintenance credential, lease, generation, and fencing token so they continue after Zalo disconnect, account replacement/removal, or channel-cell outage.
- The independent model provider is configured with a dedicated OpenAI-compatible base URL and secret that are not routed through or shared with 9Router. Provider outage, quota exhaustion, timeout, or schema failure opens the AI circuit breaker and pauses AI-assisted automatic sends while manual non-AI sends remain available.
- Edge verifies gateway receipt signatures and key generations. SQL recomputes canonical receipt/evidence hashes, compares exact persisted claims, performs CAS/idempotency, and stores the full receipt; SQL does not duplicate Ed25519 verification.
- Browser and Edge callers use public, narrowly granted RPC facades. Canonical `openclaw_*` tables deny direct DML to `authenticated` and `service_role`; private helpers remain under `app_private` and are not called through PostgREST.
- Cell, bridge, and maintenance containers have no direct Internet route. All outbound HTTPS/WebSocket traffic crosses a dedicated, dual-homed rootless egress broker with a version-controlled FQDN/port allowlist, connect-time IP validation/pinning, DNS revalidation, and private/reserved/metadata/9Router denial.
- No production migration, protected live-DEMO query, Cloudflare deployment, VPS mutation, QR connection, or production smoke occurs before Tasks 27-28, the complete secret-free/local/ephemeral matrix, and independent pre-production implementation/runbook review pass on the exact commit being deployed. Because DEMO and PROD share one Supabase project, the protected rollback-only live-DEMO matrix runs only after Task 29 applies the reviewed additive flags-off schema.

## 2. Delivery Lanes And Dependency Order

```text
Positive vendored-fork architecture gate
  Task 1 -> Task 2 M review -> R review -> R-only build -> E review -> Tasks 3-29

Lane A - Contracts and database, serial ownership
  Task 2 -> Task 3 -> Task 4 -> Task 5 -> Task 6 -> Task 7
  -> Task 8 -> Task 9 -> Task 10 -> Task 11 -> Task 12

Lane B - Edge and media
  Tasks 8, 9, 12 -> Task 13 -> Task 14 -> Task 15 -> Task 16

Lane C - Runtime and OpenClaw cell
  Tasks 2, 12, 15 -> Task 17 -> Task 18 (strictly serial after Task 17) -> Task 19 -> Task 20

Lane D - Frontend
  Tasks 3, 4, 8, 9, 12 -> Task 21 -> Task 22 -> Task 23 -> Task 24 -> Task 25

Lane E - Integrated verification and rollout
  Tasks 14, 15, 16, 18, 20, 23, 24, 25 -> Task 26 -> Task 27
  -> Task 28 -> pre-production independent review -> reviewed SHA push with flags off
  -> Task 29 -> Task 30
```

Write-capable agents may run in parallel only when their file ownership does not overlap. Migrations remain serial in timestamp order. `package.json`, `supabase/config.toml`, `src/integrations/supabase/types.ts`, `src/App.tsx`, `src/lib/permissions.ts`, and deployment manifests each have one owner at a time.

## 3. Representative File Map And Ownership

The lists below establish ownership boundaries for twelve ordered OpenClaw migrations, three top-level package gates plus two SQL helpers, and the stable paths used across lanes; each task's exact `Files` block is authoritative for every per-migration test, generated artifact, CI helper, and runbook file not repeated here. No task may stage outside its own `Files` block.

### 3.1 Existing files to modify

- `package.json` - add three top-level OpenClaw gates (`test:openclaw:services`, `test:openclaw:sql`, `test:openclaw:r2`) and two SQL helpers (`test:openclaw:sql:local`, `test:openclaw:sql:live-demo`).
- `vite.config.ts` and `eslint.config.js` - exclude package-owned nested suites from root traversal so every suite runs exactly once through its owning package gate.
- `.gitignore` - exclude rendered runtime config, local cell state, local secrets, spool/test data, and Cloudflare dev state.
- `supabase/config.toml` - version-control JWT/custom-auth behavior for the six new Edge Functions.
- `supabase/functions/README.md` - document OpenClaw function auth models, secrets, deploy order, and local commands.
- `src/integrations/supabase/types.ts` - regenerate after all public schema/RPC migrations are applied.
- `src/lib/permissions.ts` - register the `openclaw_zalo` module and five new action names.
- `src/lib/permissionPages.ts` - expose the eight exact page features and sensitivity tiers.
- `src/App.tsx` - lazy-load and gate `/openclaw-zalo`.
- `src/components/layout/Sidebar.tsx` - add a distinct OpenClaw navigation entry.
- `src/components/layout/Breadcrumbs.tsx` - add the route label for catalog consistency.
- `src/pages/home/launcherTiles.ts` - add the mobile launcher tile.
- `.github/workflows/ci-gates.yml` - add isolated OpenClaw contract and production-smoke gates.

### 3.2 Database and test files to create

- `supabase/migrations/20260727010000_openclaw_catalog_foundation.sql`
- `supabase/migrations/20260727015000_openclaw_security_principals.sql`
- `supabase/migrations/20260727020000_openclaw_inbox_schema.sql`
- `supabase/migrations/20260727025000_openclaw_inbound_automation.sql`
- `supabase/migrations/20260727030000_openclaw_policy_automation_knowledge.sql`
- `supabase/migrations/20260727040000_openclaw_delivery_audit_ops.sql`
- `supabase/migrations/20260727050000_openclaw_access_policies.sql`
- `supabase/migrations/20260727060000_openclaw_rpc_surface.sql`
- `supabase/migrations/20260727070000_openclaw_crm_event_sources.sql`
- `supabase/migrations/20260727080000_openclaw_realtime_allowlist.sql`
- `supabase/migrations/20260727090000_openclaw_maintenance_jobs.sql`
- `supabase/migrations/20260727095000_openclaw_activation_guards.sql`
- `src/lib/__tests__/openclawZaloMigrations.test.ts`
- `scripts/test-openclaw-migrations.mjs`
- `scripts/test-openclaw-sql.mjs`
- `scripts/test-openclaw-concurrency.mjs`
- `scripts/__tests__/openclaw-sql-harness.test.mjs`
- `scripts/__tests__/openclaw-concurrency-harness.test.mjs`
- `scripts/check-openclaw-isolation.mjs`

### 3.3 Edge control plane files to create

- `supabase/functions/_shared/openclaw/{deps,constants,env,errors,http,cors,supabase,browser-auth,runtime-auth,crypto,redaction,object-tickets,types}.ts`
- `supabase/functions/openclaw-control/{index,handler,schemas,handler.test}.ts`
- `supabase/functions/openclaw-qr/{index,handler,schemas,handler.test}.ts`
- `supabase/functions/openclaw-runtime-token/{index,handler,schemas,handler.test}.ts`
- `supabase/functions/openclaw-runtime/{index,handler,schemas,handler.test}.ts`
- `supabase/functions/openclaw-object-tickets/{index,handler,schemas,handler.test}.ts`
- `supabase/functions/openclaw-watchdog/{index,handler,schemas,handler.test}.ts`

### 3.4 Private media gateway files to create

- `infra/openclaw-media-gateway/{package.json,package-lock.json,tsconfig.json,vitest.config.ts,wrangler.toml}`
- `infra/openclaw-media-gateway/src/{index,env,ticket,ticket-state,object-key,media-policy,responses}.ts`
- `infra/openclaw-media-gateway/src/handlers/{upload,read,verify,delete,revoke-generation}.ts`
- `infra/openclaw-media-gateway/test/{fixtures,ticket,object-key.property,upload,read,verify,delete-retention,security}.test.ts`

### 3.5 Runtime and deployment files to create

- `services/openclaw-zalo-bridge/{package.json,package-lock.json,tsconfig.json,vitest.config.ts,Dockerfile,README.md}`
- `services/openclaw-zalo-bridge/src/bin/{bridge,fake-cell}.ts`
- `services/openclaw-zalo-bridge/src/bridge/{server,inbound-controller}.ts`
- `services/openclaw-zalo-bridge/src/runtime-api/{client,workload-auth,schemas}.ts`
- `services/openclaw-zalo-bridge/src/adapters/{channel-adapter,zalouser-bridge-rpc-adapter}.ts`
- `services/openclaw-zalo-bridge/src/spool/{sqlite-spool,drain-worker,pressure,checksum}.ts`
- `services/openclaw-zalo-bridge/src/spool/migrations/001_init.sql`
- `services/openclaw-zalo-bridge/src/media/{inbound-fetch,redirect-policy,ip-policy,magic-byte,cache,temp-cleanup}.ts`
- `services/openclaw-zalo-bridge/src/outbox/{worker,state-machine,pre-dispatch,error-classifier}.ts`
- `services/openclaw-zalo-bridge/src/jobs/{worker,inbound-automation-runner,schedule-runner,crm-event-runner,template-renderer}.ts`
- `services/openclaw-zalo-bridge/src/ai/{cell-agent-client,content-policy,dlp,retrieval-context}.ts`
- `services/openclaw-zalo-bridge/src/health/{heartbeat,circuit-breaker,snapshot}.ts`
- `services/openclaw-zalo-bridge/src/security/{redact,secret-files}.ts`
- `services/openclaw-zalo-bridge/src/testing/fake-zalo-adapter.ts`
- `services/openclaw-zalo-bridge/test/{upstream-contract,runtime-auth,spool-recovery,inbound-listener-ordering,inbound-drain,inbound-media,outbox-dispatch,policy-preflight,ai-dlp,zalouser-bridge-rpc-adapter,background-jobs,fencing,health,load-egress}.test.ts`
- `services/openclaw-zalo-cell/{Dockerfile,.dockerignore,README.md,image-lock.json,build-evidence.json,build-evidence.schema.v1.json}`
- `services/openclaw-zalo-cell/config/openclaw.json.tmpl`
- `services/openclaw-zalo-cell/scripts/{entrypoint,install-vendored-zalouser}.sh`
- `services/openclaw-zalo-cell/scripts/build-reproducible-image.ps1`
- `services/openclaw-zalo-cell/scripts/{verify-image-lock,normalize-openclaw-install,export-reviewed-tree}.mjs`
- `services/openclaw-zalo-cell/test/image-contract.test.mjs`
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/{package.json,package-lock.json,tsconfig.json,vitest.config.ts,README.md,UPSTREAM.json,FORK.json,SHA512SUMS,LICENSE,THIRD_PARTY_NOTICES.md}`
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/upstream/{LICENSE.openclaw,THIRD_PARTY_NOTICES.openclaw.md,package/**}` — the two root compliance files are exact pinned-Git bytes, and `package/**` is the complete exact 75-blob snapshot under `extensions/zalouser`, including the top-level public entrypoints, `README.md`, `npm-shrinkwrap.json`, `tsconfig.json`, `test-api.ts`, manifests, and `src/**`.
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/upstream/provenance/{npm-registry-metadata.json,npm-registry-keys.json,npm-attestation-bundles.json,sigstore-trusted-root.json}` — exact raw response/trust bytes reviewed in `M`; no qualifying verifier uses a reserialized projection or mutable online trust root.
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/licenses/manifest.json` — independently reviewed exact 38-package/39-carrier source-of-truth manifest.
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/licenses/<package>@<version>/<original-path>` — exact bytes for all 39 locked bundled-dependency carriers across exactly 38 package roots.
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/patches/{series,0001-durable-inbound-bridge-listener.patch,0002-private-bridge-send-rpc.patch,0003-close-bypasses-and-classify-control.patch}`
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/scripts/{verify-upstream,prepare,build,pack,verify-artifact}.mjs`
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/src/bridge/{inbound-listener,outbound-rpc,authorize-client,send-context,control-traffic}.ts`
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/test/{vendor-integrity,inbound-listener,outbound-choke-points,outbound-negative,control-traffic,reproducible-pack}.test.ts`
- `services/openclaw-zalo-cell/vendor/zalouser-bridge/artifacts/openclaw-zalouser-2026.7.1.tgz`
- `services/openclaw-zalo-cell/session-crypto/{package.json,package-lock.json,tsconfig.json,tsconfig.build.json,src/daemon.ts,src/crypto.ts,src/crypto.test.ts,dist/package.json,dist/crypto.js,dist/daemon.js}` (the three ignored `dist` files are reviewed prebuilt runtime inputs committed with `git add -f`)
- `services/openclaw-zalo-maintenance/{package.json,package-lock.json,tsconfig.json,vitest.config.ts,Dockerfile,README.md}`
- `services/openclaw-zalo-maintenance/src/{main,runtime-client,retention-runner,audit-anchor-runner,health}.ts`
- `services/openclaw-zalo-maintenance/test/{auth,retention,audit,recovery}.test.ts`
- `services/openclaw-egress-broker/{package.json,package-lock.json,tsconfig.json,vitest.config.ts,Dockerfile,README.md}`
- `services/openclaw-egress-broker/src/{main,allowlist,dns-policy,connect-proxy,redaction}.ts`
- `services/openclaw-egress-broker/test/{allowlist,dns-rebinding,private-ranges,proxy}.test.ts`
- `infra/openclaw-zalo/{compose.cell,compose.test}.yaml`
- `infra/openclaw-zalo/egress/allowlist.yaml`
- `infra/openclaw-zalo/env/runtime.env.example`
- `infra/openclaw-zalo/systemd/user/{openclaw-stack@.service,openclaw-host-guard.service,openclaw-host-guard.timer,openclaw-gc.service,openclaw-gc.timer}`
- `infra/openclaw-zalo/systemd/system/user-openclaw-runner.slice.conf.tmpl`
- `infra/openclaw-zalo/scripts/{preflight-host,provision-rootless,render-cell,deploy-cell,verify-isolation,smoke-cell,rollback-cell,snapshot-cotenants,rotate-secrets,restore-drill,migrate-cell}.sh`
- `infra/openclaw-zalo/test/recovery-drill.test.ts`

### 3.6 Frontend files to create

- `src/lib/openclaw-zalo/{types,validation,state-machine,policy,query-contract}.ts`
- `src/lib/openclaw-zalo/__tests__/{stateMachines.property,policy.property,idempotency.property,redaction.property}.test.ts`
- `src/hooks/openclaw-zalo/{queryKeys,useOpenClawOrganization,useOpenClawBootstrap,useOpenClawOverview,useOpenClawInbox,useOpenClawOperations,useOpenClawRealtime,useOpenClawPermissions,useOpenClawMutations}.ts`
- `src/hooks/openclaw-zalo/__tests__/{queries,mutations,realtime}.test.ts`
- `src/pages/openclaw-zalo/{OpenClawZaloPage,OpenClawZaloDesktopPage,OpenClawZaloMobilePage}.tsx`
- `src/pages/openclaw-zalo/__tests__/OpenClawZaloPage.test.tsx`
- `src/components/openclaw-zalo/{OpenClawCockpit,OpenClawCommandBar,OpenClawSectionNav,OpenClawBoundaryState}.tsx`
- `src/components/openclaw-zalo/OpenClawRouteGuard.tsx`
- `src/components/openclaw-zalo/overview/OpenClawOverview.tsx`
- `src/components/openclaw-zalo/inbox/{OpenClawInbox,ConversationList,ConversationThread,AiDraftPanel}.tsx`
- `src/components/openclaw-zalo/automation/OpenClawAutomation.tsx`
- `src/components/openclaw-zalo/knowledge/OpenClawKnowledge.tsx`
- `src/components/openclaw-zalo/schedules/OpenClawSchedulesAndGroups.tsx`
- `src/components/openclaw-zalo/operations/OpenClawOperations.tsx`
- `src/components/openclaw-zalo/dialogs/{OpenClawConnectionDialog,OpenClawGlobalStopDialog,OpenClawUnknownResolutionDialog}.tsx`
- `src/components/openclaw-zalo/__tests__/{permissionStates,globalStop,unknownResolution}.test.tsx`
- `.e2e-fleet/specs/{openclaw-zalo.spec,openclaw-zalo-admin,openclaw-zalo-fake-adapter}.ts`

### 3.7 Shared contract and watchdog files

- `contracts/openclaw-zalo/{control,runtime,inbound,maintenance,media,receipts,policy,state-machine,audit}.schema.json`
- `contracts/openclaw-zalo/golden-vectors.json`
- `infra/openclaw-zalo-watchdog/{package.json,package-lock.json,wrangler.toml,src/index.ts,src/index.test.ts}`
- `src/lib/__tests__/openclawFullContract.test.ts`
- `scripts/__tests__/{openclawCommandContract,openclaw-cotenants,production-openclaw-smoke}.test.mjs`
- `scripts/production-openclaw-smoke.mjs`
- `docs/openclaw-zalo/runbooks/{deploy,operations,backup-restore,vps-migration,rollback,secret-rotation,capacity,load-test-results,production-smoke}.md`

## 4. Stable Contracts Used By Every Lane

```ts
export type OpenClawPermissionAction =
  | "view"
  | "send"
  | "manage_connections"
  | "manage_automation"
  | "manage_knowledge"
  | "manage_handoff"
  | "manage_operations"
  | "audit";

export type OpenClawTargetKind = "PEER" | "SALES_GROUP";
export type OpenClawOutboxState =
  | "QUEUED"
  | "LEASED"
  | "DISPATCHING"
  | "SENT"
  | "FAILED"
  | "UNKNOWN"
  | "DEAD_LETTER";

export type OpenClawMode =
  | "DRAFT_ONLY"
  | "MANUAL_SEND"
  | "LIMITED_AUTO_REPLY"
  | "PROACTIVE"
  | "SALES_GROUPS";

export type OpenClawConnectionState =
  | "DISCONNECTED"
  | "QR_PENDING"
  | "CONNECTING"
  | "CONNECTED"
  | "DISCONNECTING"
  | "RECONNECT_REQUIRED";

export type OpenClawSessionRiskState =
  | "HEALTHY"
  | "DEGRADED"
  | "LIMITED"
  | "SUSPECTED_THEFT"
  | "INVALID";

export type OpenClawMaintenanceWorkKind = "RETENTION_DELETE" | "AUDIT_ANCHOR";

export type OpenClawSendWorkKind =
  | "INBOUND_AUTOMATION"
  | "SCHEDULE_OCCURRENCE"
  | "CRM_EVENT";

export type KnowledgeSensitivity =
  | "CUSTOMER_SAFE"
  | "INTERNAL_REVIEW_ONLY"
  | "RESTRICTED";

export type OpenClawCrmEventType =
  | "lead_created_or_assigned"
  | "room_became_available"
  | "sales_task_due";
```

The fork-to-bridge inbound contract preserves both provider evidence and normalized fields before any OpenClaw dispatch:

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface ZaloUserInboundMediaManifestEntryV1 {
  version: 1;
  index: number;
  providerMediaId: string | null;
  kind: "IMAGE" | "VIDEO" | "AUDIO" | "FILE" | "STICKER" | "OTHER";
  mime: string | null;
  byteLength: number | null;
  providerChecksum: string | null;
  fetchRef: string | null;
  byteState: "PENDING";
}

interface ZaloUserInboundEnvelopeV1 {
  version: 1;
  organizationId: string;
  accountId: string;
  cellId: string;
  sessionGeneration: number;
  providerEventId: string | null;
  providerMessageId: string | null;
  eventKind:
    | "MESSAGE"
    | "REACTION"
    | "DELIVERY_RECEIPT"
    | "SEEN"
    | "TYPING"
    | "MEMBERSHIP"
    | "OTHER";
  providerConversationId: string;
  providerSenderId: string;
  providerTarget: { kind: "PEER" | "SALES_GROUP"; providerId: string };
  providerEventType: string;
  sourceTimestamp: string;
  callbackReceivedAt: string;
  rawEnvelope: JsonValue;
  rawEnvelopeSha256: string;
  normalized: {
    text: string | null;
    replyToProviderMessageId: string | null;
    mediaManifest: ZaloUserInboundMediaManifestEntryV1[];
  };
  normalizedSha256: string;
}
```

The provider callback itself is void/non-awaited and supplies no provider-level acknowledgement. The fork starts an internal awaited listener pipeline with this complete value; it marks that internal listener successful and permits OpenClaw dispatch/queue only after the bridge atomically commits canonical bytes, hashes, local sequence, dedupe inputs, and media manifest with SQLite WAL/`synchronous=FULL`.

Stable-ID identity is exactly `(organizationId, accountId, eventKind, stableIdKind, stableIdValue)`, where `stableIdKind` is `PROVIDER_EVENT_ID` or `PROVIDER_MESSAGE_ID`. If `providerEventId` exists it is primary. For message-bearing events, `providerMessageId` is secondary uniqueness; if event ID is absent and message ID exists, message ID becomes primary. When both exist, persist both identities and their immutable pair mapping to the same inbound event/payload hash. Exact replay dedupes only when event kind, pair, and payload hash all match. Reusing an ID in the same organization/account across event kinds, with a different pair, or with a different payload fails closed, quarantines the event, and appends collision audit. The same textual ID in a different organization/account is independent and never cross-dedupes. Only when both stable IDs are null may the canonical fingerprint run; it remains heuristic at-least-once and stores payload hashes/collision telemetry. Media bytes may remain `PENDING` after manifest durability. No contract claims zero loss before the provider callback reaches the fork.

Policy evaluation always returns one of these reasons, in this exact precedence:

```ts
export type SendDecisionReason =
  | "GLOBAL_STOP"
  | "MODE_PAUSED"
  | "ACCOUNT_PAUSED"
  | "CAMPAIGN_CANCELLED"
  | "TAKEOVER_ACTIVE"
  | "SUPPRESSED"
  | "CONSENT_MISSING"
  | "QUIET_HOURS"
  | "RATE_LIMITED"
  | "GROUP_NOT_ALLOWLISTED"
  | "GROUP_DIRECTORY_STALE"
  | "ALLOWED";
```

The outbox claim/authorize/complete contract is authoritative across SQL, Edge, runtime, bridge, vendored fork, and tests. The bridge is the only component that may carry the private claim token into `zalouser.bridge.send`; the fork never serializes it into provider parameters, audit evidence, or ordinary logs.

```ts
interface OutboxClaim {
  version: 1;
  outboxId: string;
  organizationId: string;
  accountId: string;
  claimToken: string;
  claimGeneration: number;
  fencingToken: number;
  sessionGeneration: number;
  controlVersion: number;
  takeoverVersion: number;
  leaseExpiresAt: string;
  payloadHash: string;
  payload: CanonicalSendPayloadV1;
}

interface OutboundAuthorizationMarker {
  version: 1;
  outboxId: string;
  claimGeneration: number;
  payloadHash: string;
  fencingToken: number;
  sessionGeneration: number;
  controlVersion: number;
  takeoverVersion: number;
  markerNonce: string;
  expiresAt: string;
}

interface OutboxAuthorizeSendRequestV1 {
  version: 1;
  claimToken: string;
  authorizationMarker: OutboundAuthorizationMarker;
}

type ZaloUserBridgeSendPartV1 =
  | { version: 1; partIndex: number; kind: "TEXT"; text: string }
  | {
      version: 1;
      partIndex: number;
      kind: "MEDIA";
      objectKey: string;
      sha256: string;
      mime: string;
      bytes: number;
    };

interface ZaloUserBridgeSendParamsV1 {
  version: 1;
  payload: CanonicalSendPayloadV1;
  authorization: OutboxAuthorizeSendRequestV1;
}

type DeliveryReasonCodeV1 =
  | "ALL_PARTS_ACKNOWLEDGED"
  | "PROVIDER_REJECTED_BEFORE_ACCEPT"
  | "PROVIDER_TIMEOUT_AFTER_POSSIBLE_HANDOFF"
  | "PROVIDER_DISCONNECT_AFTER_POSSIBLE_HANDOFF"
  | "ACK_LOST_AFTER_HANDOFF";

type PreHandoffReasonCodeV1 =
  | "AUTHORIZATION_EXPIRED"
  | "LEASE_EXPIRED"
  | "CELL_FENCED"
  | "SESSION_GENERATION_CHANGED"
  | "CONTROL_VERSION_CHANGED"
  | "TAKEOVER_VERSION_CHANGED"
  | "POLICY_CHANGED_BEFORE_HANDOFF"
  | "ADAPTER_NOT_READY"
  | "EGRESS_BLOCKED_BEFORE_HANDOFF";

interface DeliveryEvidenceBaseV1 {
  version: 1;
  evidenceKind: "OUTBOX_DELIVERY";
  outboxId: string;
  claimGeneration: number;
  payloadHash: string;
  authorizationMarker: OutboundAuthorizationMarker;
  totalPartCount: number;
  knownProviderMessageIds: string[];
  possibleHandoffPrefixLength: number;
}

type DeliveryEvidenceV1 =
  | (DeliveryEvidenceBaseV1 & {
      outcome: "SENT";
      possibleHandoffPrefixLength: number;
      knownProviderMessageIds: string[];
    })
  | (DeliveryEvidenceBaseV1 & {
      outcome: "FAILED";
      reasonCode: "PROVIDER_REJECTED_BEFORE_ACCEPT";
      possibleHandoffPrefixLength: 0;
      knownProviderMessageIds: [];
    })
  | (DeliveryEvidenceBaseV1 & {
      outcome: "UNKNOWN";
      reasonCode:
        | "PROVIDER_TIMEOUT_AFTER_POSSIBLE_HANDOFF"
        | "PROVIDER_DISCONNECT_AFTER_POSSIBLE_HANDOFF"
        | "ACK_LOST_AFTER_HANDOFF";
    });

interface OutboxCompletionBaseV1 {
  version: 1;
  authorization: OutboxAuthorizeSendRequestV1;
  deliveryEvidence: DeliveryEvidenceV1;
  deliveryEvidenceHash: string;
}

type OutboxCompletionV1 =
  | (OutboxCompletionBaseV1 & {
      outcome: "SENT";
      reasonCode: "ALL_PARTS_ACKNOWLEDGED";
    })
  | (OutboxCompletionBaseV1 & {
      outcome: "FAILED";
      reasonCode: "PROVIDER_REJECTED_BEFORE_ACCEPT";
    })
  | (OutboxCompletionBaseV1 & {
      outcome: "UNKNOWN";
      reasonCode:
        | "PROVIDER_TIMEOUT_AFTER_POSSIBLE_HANDOFF"
        | "PROVIDER_DISCONNECT_AFTER_POSSIBLE_HANDOFF"
        | "ACK_LOST_AFTER_HANDOFF";
    });

interface OutboxPreHandoffEvidenceV1 {
  version: 1;
  evidenceKind: "OUTBOX_PRE_HANDOFF";
  outboxId: string;
  claimGeneration: number;
  payloadHash: string;
  authorizationMarker: OutboundAuthorizationMarker;
  reasonCode: PreHandoffReasonCodeV1;
  authorizedHandoffRecorded: false;
}

interface OutboxPreHandoffRequeueV1 {
  version: 1;
  authorization: OutboxAuthorizeSendRequestV1;
  outcome: "SAFE_RETRY";
  reasonCode: PreHandoffReasonCodeV1;
  preHandoffEvidence: OutboxPreHandoffEvidenceV1;
  preHandoffEvidenceHash: string;
  retryNotBefore: string;
}

type OpenClawUnknownResolutionRequestV1 =
  | {
      version: 1;
      outboxId: string;
      expectedResolutionVersion: 0;
      expectedEvidenceDomain: "ihome-openclaw-unknown-authority-v1\\0";
      expectedEvidenceHash: string;
      outcome: "CONFIRMED_SENT";
      reasonCode: "OPERATOR_CONFIRMED_SENT";
      operatorEvidenceHash: string;
    }
  | {
      version: 1;
      outboxId: string;
      expectedResolutionVersion: 0;
      expectedEvidenceDomain: "ihome-openclaw-unknown-authority-v1\\0";
      expectedEvidenceHash: string;
      outcome: "CONFIRMED_FAILED";
      reasonCode: "OPERATOR_CONFIRMED_FAILED";
      operatorEvidenceHash: string;
    }
  | {
      version: 1;
      outboxId: string;
      expectedResolutionVersion: 0;
      expectedEvidenceDomain: "ihome-openclaw-unknown-authority-v1\\0";
      expectedEvidenceHash: string;
      outcome: "NEW_INTENT_CREATED";
      reasonCode: "OPERATOR_CREATED_NEW_INTENT";
      operatorEvidenceHash: string;
      newIntent: {
        clientOperationId: string;
        targetId: string;
        sourceDraftId: string;
        expectedDraftVersion: number;
        replyToMessageId: string | null;
      };
    };

type OpenClawUnknownResolutionV1 =
  | {
      version: 1;
      resolutionId: string;
      organizationId: string;
      accountId: string;
      outboxId: string;
      resolutionVersion: 1;
      outcome: "CONFIRMED_SENT";
      newOutboxId: null;
      authoritativeEvidenceDomain: "ihome-openclaw-unknown-authority-v1\\0";
      authoritativeEvidenceHash: string;
      reasonCode: "OPERATOR_CONFIRMED_SENT";
      resolvedBy: string;
      resolvedAt: string;
    }
  | {
      version: 1;
      resolutionId: string;
      organizationId: string;
      accountId: string;
      outboxId: string;
      resolutionVersion: 1;
      outcome: "CONFIRMED_FAILED";
      newOutboxId: null;
      authoritativeEvidenceDomain: "ihome-openclaw-unknown-authority-v1\\0";
      authoritativeEvidenceHash: string;
      reasonCode: "OPERATOR_CONFIRMED_FAILED";
      resolvedBy: string;
      resolvedAt: string;
    }
  | {
      version: 1;
      resolutionId: string;
      organizationId: string;
      accountId: string;
      outboxId: string;
      resolutionVersion: 1;
      outcome: "NEW_INTENT_CREATED";
      newOutboxId: string;
      authoritativeEvidenceDomain: "ihome-openclaw-unknown-authority-v1\\0";
      authoritativeEvidenceHash: string;
      reasonCode: "OPERATOR_CREATED_NEW_INTENT";
      resolvedBy: string;
      resolvedAt: string;
    };
```

The exact send rules are closed and machine-testable: `parts` is non-empty, has at most 20 elements, `partIndex` is exactly the zero-based array index, text chunks are at most 2,000 Unicode code points, and media parts carry positive bytes plus lowercase SHA-256. `SENT` has exactly `totalPartCount` provider IDs and an acknowledged prefix of that same length; `FAILED` has zero possible handoffs and zero IDs; `UNKNOWN` has `0 <= knownProviderMessageIds.length <= possibleHandoffPrefixLength <= totalPartCount`, and known IDs always describe the contiguous prefix. No other outcome/reason/cardinality combination validates. `OutboxAuthorizeSendRequestV1` is the only authorization request; the bridge injects the private `claimToken` into `zalouser.bridge.send`, while the fork strips/redacts it before any provider frame.

`zalouser.bridge.send` is the sole business-delivery RPC. The fork first constructs the exact ordered text/media/chunk provider batch, then calls `/v1/outbox/authorize-send` immediately before the first provider I/O. Missing authorization, denial, error, timeout, stale marker, replay, or hash mismatch emits zero provider frames. Generic `send`, message tool, pairing notification, direct adapter/tool calls, and every other business-send path are denied unless execution carries the unforgeable authorized fork context created by this RPC. `extensions/zalouser/src/send.ts` including link/reaction, `src/channel.adapters.ts`, and `src/tool.ts` are explicit choke points. Timeout/disconnect/ack loss after possible handoff is `UNKNOWN` with no automatic retry.

```ts
type ZaloUserProviderTrafficClassV1 =
  | "BUSINESS_SEND"
  | "TYPING"
  | "SEEN"
  | "DELIVERY_RECEIPT";
```

Typing, seen, and delivery receipts are control traffic with fixed content-free schemas and rate/audit rules. They cannot carry text/media, cannot mint an outbound marker, and cannot be reclassified to bypass business-send authorization.

Every marker issuer, serializer, verifier, test vector, and audit projection uses the complete `OutboundAuthorizationMarker`. `claimToken` and `markerNonce` are replaced by stable redaction tokens in logs, snapshots, errors, Realtime projections, and test output. `expiresAt` is evaluated against DB-backed runtime time, the nonce is one-time, and omission/mismatch of any field fails closed before Gateway handoff.

The send hash is deterministic across SQL, Edge, bridge, and vendored fork:

```ts
interface CanonicalSendPayloadV1 {
  version: 1;
  organizationId: string;
  accountId: string;
  target: { kind: "PEER" | "SALES_GROUP"; providerId: string };
  channel: "zalouser";
  accountProfile: string;
  idempotencyKey: string;
  parts: ZaloUserBridgeSendPartV1[];
  replyToProviderMessageId: string | null;
  policyVersionId: string;
  automationVersionId: string | null;
  templateVersionId: string | null;
  frozenInputs: {
    campaignVersionId: string | null;
    scheduleVersion: number | null;
    subscriptionVersion: number | null;
    subscriptionId: string | null;
    occurrenceId: string | null;
    sourceTable: string | null;
    sourceId: string | null;
    sourceVersion: string | null;
    knowledgeVersionIds: string[];
    sourceSnapshotHash: string | null;
    targetVersion: number;
    targetDirectoryRefreshedAt: string;
    fieldMappingHash: string | null;
  };
}
```

Compute `payloadHash` as lowercase SHA-256 of UTF-8 bytes for `"ihome-openclaw-send-v1\\0" + RFC8785_JCS(CanonicalSendPayloadV1)`. It deliberately excludes `outboxId`, the private claim token, and the authorization marker, so same idempotency key plus same business payload reproduces the same hash before or after outbox creation; `OutboundAuthorizationMarker.outboxId` separately binds the chosen row at dispatch. It covers every private-RPC business argument and full CRM/schedule lineage (subscription ID/version, occurrence ID, source table/ID/version, campaign/schedule/automation/template/knowledge/target versions). Strings preserve exact Unicode code points with no NFC/NFD normalization. Golden vectors must prove SQL/Edge/bridge/fork parity, ordered-part behavior, code-point preservation, and a different hash for any target, part, media, reply, profile, idempotency, subscription, occurrence, source snapshot, or frozen-version change.

Delivery evidence uses domain-separated canonical bytes: `"ihome-openclaw-delivery-evidence-v1\\0" + RFC8785_JCS(DeliveryEvidenceV1)` and `"ihome-openclaw-pre-handoff-evidence-v1\\0" + RFC8785_JCS(OutboxPreHandoffEvidenceV1)`. `deliveryEvidenceHash`/`preHandoffEvidenceHash` are lowercase SHA-256 of those exact bytes. The UNKNOWN authority hash is `"ihome-openclaw-unknown-authority-v1\\0" + RFC8785_JCS(serverComputedUnknownAuthorityEvidence)`, where SQL computes the evidence from the immutable outbox, attempt, authorization, marker/version, and delivery-evidence rows; the client supplies only the expected domain/hash for CAS.

Background execution has separate send-work and maintenance protocols:

```ts
type OpenClawCrmSourceEnvelopeV1 =
  | { version: 1; eventType: "lead_created_or_assigned"; eventSubtype: "CREATED" | "ASSIGNED" | "REASSIGNED"; sourceTable: "leads"; sourceId: string; sourceVersion: string; snapshot: { leadId: string; assignedStaffId: string | null; status: string } }
  | { version: 1; eventType: "room_became_available"; eventSubtype: "FINAL_STATUS_AVAILABLE"; sourceTable: "rooms"; sourceId: string; sourceVersion: string; snapshot: { roomId: string; buildingId: string; roomStatus: "AVAILABLE" } }
  | { version: 1; eventType: "sales_task_due"; eventSubtype: "FOLLOW_UP_DUE"; sourceTable: "lead_activities"; sourceId: string; sourceVersion: string; snapshot: { activityId: string; leadId: string; scheduledAt: string; scheduleRevision: number } };

type OpenClawSendWorkPayload =
  | { kind: "INBOUND_AUTOMATION"; inboundEventId: string; messageId: string; conversationId: string; targetId: string; automationVersionId: string; knowledgeVersionIds: string[]; eligibilityDecisionHash: string }
  | { kind: "SCHEDULE_OCCURRENCE"; scheduleId: string; scheduleVersion: number; occurrenceId: string; campaignVersionId: string; targetId: string; targetVersion: number; targetDirectoryRefreshedAt: string; automationVersionId: string; templateVersionId: string; knowledgeVersionIds: string[]; fieldMappingHash: string }
  | { kind: "CRM_EVENT"; occurrenceId: string; subscriptionId: string; subscriptionVersion: number; campaignVersionId: string; targetId: string; targetVersion: number; targetDirectoryRefreshedAt: string; automationVersionId: string; templateVersionId: string; knowledgeVersionIds: string[]; fieldMappingHash: string; sourceEnvelope: OpenClawCrmSourceEnvelopeV1; sourceEnvelopeHash: string };

type OpenClawMaintenanceWorkPayload =
  | { kind: "RETENTION_DELETE"; deletePhase: "QUARANTINE"; subjectKind: "MESSAGE" | "AI_DRAFT" | "MEDIA" | "KNOWLEDGE" | "HEALTH" | "AUDIT" | "POLICY" | "CONTROL" | "DELIVERY"; subjectId: string; retentionVersion: number; holdVersion: number }
  | { kind: "RETENTION_DELETE"; deletePhase: "FINAL_DELETE"; subjectKind: "MEDIA"; subjectId: string; objectKey: string; retentionVersion: number; holdVersion: number; quarantineVersion: number; finalDeleteNotBefore: string }
  | { kind: "AUDIT_ANCHOR"; auditRootId: string; rootDate: string; rootHash: string; auditSigningKeyGeneration: number; anchorKey: string };

interface OpenClawSendWorkClaimV1 {
  version: 1; workItemId: string; organizationId: string; accountId: string; cellId: string; credentialGeneration: number; sourceKey: string; claimToken: string; claimGeneration: number; fencingToken: number; leaseExpiresAt: string; payload: OpenClawSendWorkPayload;
}

interface OpenClawMaintenanceWorkClaimV1 {
  version: 1; workItemId: string; organizationId: string; maintenancePrincipalId: string; credentialGeneration: number; sourceKey: string; claimToken: string; claimGeneration: number; fencingToken: number; leaseExpiresAt: string; payload: OpenClawMaintenanceWorkPayload;
}

interface RetentionDeleteAuthorizationV1 {
  version: 1; authorizationKind: "RETENTION_FINAL_DELETE"; organizationId: string; maintenancePrincipalId: string; workItemId: string; claimGeneration: number; fencingToken: number; objectKey: string; deletePhase: "FINAL_DELETE"; holdVersion: number; quarantineVersion: number; deleteTicketJti: string; authorizationJti: string; iat: string; exp: string; gatewaySigningKeyGeneration: number; signature: string;
}

interface RetentionDeleteReceiptBaseV1 {
  version: 1; receiptKind: "RETENTION_FINAL_DELETE"; receiptId: string; organizationId: string; maintenancePrincipalId: string; workItemId: string; claimGeneration: number; fencingToken: number; objectKey: string; deletePhase: "FINAL_DELETE"; holdVersion: number; quarantineVersion: number; deleteTicketJti: string; deleteAuthorizationJti: string; completedAt: string; gatewaySigningKeyGeneration: number; signature: string;
}
type RetentionDeleteReceiptV1 = RetentionDeleteReceiptBaseV1 & ({ objectStatus: "DELETED"; r2VersionOrEtag: string } | { objectStatus: "NOT_FOUND"; r2VersionOrEtag: null });

interface AuditAnchorReceiptV1 {
  version: 1; receiptKind: "AUDIT_ANCHOR_VERIFY"; receiptId: string; organizationId: string; maintenancePrincipalId: string; workItemId: string; claimGeneration: number; fencingToken: number; auditRootId: string; rootHash: string; anchorKey: string; signatureHash: string; auditSigningKeyGeneration: number; verifyTicketJti: string; objectVersionOrEtag: string; verifiedAt: string; gatewaySigningKeyGeneration: number; signature: string;
}

type OpenClawWorkCompletionRequestV1 =
  | { version: 1; principalKind: "CHANNEL"; claim: OpenClawSendWorkClaimV1; outcome: "COMPLETED"; evidenceHash: string; evidence: { outboxId: string; idempotencyKey: string; payloadHash: string } }
  | { version: 1; principalKind: "MAINTENANCE"; claim: OpenClawMaintenanceWorkClaimV1; outcome: "COMPLETED"; evidence: { deletePhase: "QUARANTINE"; expectedHoldVersion: number } }
  | { version: 1; principalKind: "MAINTENANCE"; claim: OpenClawMaintenanceWorkClaimV1; outcome: "COMPLETED"; evidence: { deletePhase: "FINAL_DELETE"; gatewayReceiptHash: string; gatewayReceipt: RetentionDeleteReceiptV1 } }
  | { version: 1; principalKind: "MAINTENANCE"; claim: OpenClawMaintenanceWorkClaimV1; outcome: "COMPLETED"; evidence: { auditRootId: string; gatewayReceiptHash: string; gatewayReceipt: AuditAnchorReceiptV1 } }
  | { version: 1; principalKind: "CHANNEL" | "MAINTENANCE"; claim: OpenClawSendWorkClaimV1 | OpenClawMaintenanceWorkClaimV1; outcome: "SAFE_RETRY"; reasonCode: string; attemptEvidenceHash: string; retryNotBefore: string }
  | { version: 1; principalKind: "CHANNEL" | "MAINTENANCE"; claim: OpenClawSendWorkClaimV1 | OpenClawMaintenanceWorkClaimV1; outcome: "DEAD_LETTER"; reasonCode: string; attemptEvidenceHash: string; terminalEvidenceHash: string };

interface OpenClawWorkCompletionResultV1 {
  version: 1; workItemId: string; claimGeneration: number; outcome: "COMPLETED" | "SAFE_RETRY" | "DEAD_LETTER"; canonicalEvidenceHash: string; completedAt: string | null; retryNotBefore: string | null;
}
```

The gateway signs receipts and delete authorizations with Ed25519 over RFC8785 unsigned bytes plus the exact domain `ihome-openclaw-retention-authorization-v1\0`, `ihome-openclaw-retention-receipt-v1\0`, or `ihome-openclaw-audit-receipt-v1\0`. Signatures are unpadded base64url. The gateway private key is a Worker secret; Edge uses a versioned public-key registry with an explicit activation time, overlap window, and emergency revocation. Edge verifies signature/key generation and supplies trusted verification evidence. SQL recomputes canonical hashes, compares locked claims, persists the full receipt/hash/JTIs, and performs CAS without duplicating cryptography.

Send-work uniqueness includes the exact inbound/schedule/subscription versions described above. Retention and audit source keys are deterministic from the subject/version/phase or root/key generation. Same source key with a different payload hash is rejected rather than merged. Maintenance remains claimable with no active channel account or cell.

## 5. Tasks

### Task 1: Add Isolation And Test Harness Guardrails

**Files:**
- Create: `scripts/check-openclaw-isolation.mjs`
- Create: `src/lib/__tests__/openclawIsolation.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing isolation test**

Create a Vitest test that recursively reads only the new OpenClaw scopes and rejects legacy coupling:

```ts
const forbidden = [
  /from\s+["'][^"']*chat-zalo/i,
  /from\s+["'][^"']*useZaloChat/i,
  /\bzalo_[a-z0-9_]+\b/i,
  /worker\//i,
];

expect(scanOpenClawFiles()).toEqual([]);
```

The scanner must cover `src/**/openclaw-zalo`, `services/openclaw-zalo-*`, `services/openclaw-egress-broker/**`, `infra/openclaw-*`, `contracts/openclaw-zalo/**`, new OpenClaw migrations, and new OpenClaw Edge Functions. It must ignore the approved spec/plan and negative test literals. The canonical channel literal `zalouser` is valid in these isolated OpenClaw scopes because shared schemas, SQL hash reconstruction, Edge authorization, and the bridge must agree on it. Instead, positive/negative fixtures enforce that direct `@openclaw/zalouser` imports, package installation, stock generic `send`, or direct adapter/tool delivery are allowed only in the vendored fork/cell and the exact bridge RPC adapter/contract tests. Legacy `zalo_*`, `chat-zalo`, `useZaloChat`, or `worker/**` references always fail.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/lib/__tests__/openclawIsolation.test.ts`

Expected: FAIL because `scripts/check-openclaw-isolation.mjs` and the scanner export do not exist.

- [ ] **Step 3: Implement the reusable scanner and secret-path ignores**

`check-openclaw-isolation.mjs` must export `scanOpenClawFiles(root)` and exit non-zero when it finds forbidden imports, SQL identifiers, or paths. Do not ban the plain canonical string `zalouser` inside the isolated OpenClaw scopes. Use exact-path rules to reject direct package imports/installation and stock generic-send or direct adapter/tool delivery outside `services/openclaw-zalo-cell/**`, `services/openclaw-zalo-bridge/src/adapters/zalouser-bridge-rpc-adapter.ts`, and their exact contract tests. It must still reject legacy CRM `zalo_*` identifiers and paths everywhere. Add these ignore rules:

```gitignore
infra/openclaw-zalo/.env
infra/openclaw-zalo/secrets/
infra/openclaw-zalo/rendered/
infra/openclaw-media-gateway/.dev.vars
infra/openclaw-media-gateway/.wrangler/
services/openclaw-zalo-bridge/.data/
services/openclaw-zalo-bridge/coverage/
services/openclaw-zalo-cell/.state/
services/openclaw-zalo-cell/.release/
services/openclaw-zalo-cell/vendor/zalouser-bridge/.work/
```

Do not alter existing ignore entries.

- [ ] **Step 4: Run the guardrails**

Run:

```powershell
npx vitest run src/lib/__tests__/openclawIsolation.test.ts
node scripts/check-openclaw-isolation.mjs
```

Expected: both commands PASS and report zero forbidden references.

- [ ] **Step 5: Commit**

```powershell
git add scripts/check-openclaw-isolation.mjs src/lib/__tests__/openclawIsolation.test.ts .gitignore
git commit -m "test(openclaw-zalo): khoa cach ly voi zalo cu" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 2: Vendor And Verify The Integrity-Pinned ZaloUser Fork

**Files:**
- Modify: `.gitattributes`
- Modify: `vite.config.ts`
- Modify: `eslint.config.js`
- Create: `services/openclaw-zalo-cell/Dockerfile`
- Create: `services/openclaw-zalo-cell/.dockerignore`
- Create: `services/openclaw-zalo-cell/{image-lock.json,build-evidence.json,build-evidence.schema.v1.json,README.md}`
- Create: `services/openclaw-zalo-cell/config/openclaw.json.tmpl`
- Create: `services/openclaw-zalo-cell/scripts/{install-vendored-zalouser.sh,normalize-openclaw-install.mjs,export-reviewed-tree.mjs,build-reproducible-image.ps1,verify-image-lock.mjs}`
- Create: `services/openclaw-zalo-cell/test/image-contract.test.mjs`
- Create: `services/openclaw-zalo-cell/vendor/zalouser-bridge/{package.json,package-lock.json,tsconfig.json,vitest.config.ts,README.md,UPSTREAM.json,FORK.json,SHA512SUMS,LICENSE,THIRD_PARTY_NOTICES.md}`
- Create: `services/openclaw-zalo-cell/vendor/zalouser-bridge/upstream/{LICENSE.openclaw,THIRD_PARTY_NOTICES.openclaw.md,package/**}` (exact root compliance bytes plus the complete exact 75-blob `extensions/zalouser` snapshot, not only `src/**`)
- Create: `services/openclaw-zalo-cell/vendor/zalouser-bridge/upstream/provenance/{npm-registry-metadata.json,npm-registry-keys.json,npm-attestation-bundles.json,sigstore-trusted-root.json}` (exact raw registry metadata, npm signing keys, attestation bundles, and pinned Sigstore trust-root target reviewed in `M`)
- Create: `services/openclaw-zalo-cell/vendor/zalouser-bridge/licenses/manifest.json` (reviewed exact package/SPDX and source/output carrier metadata)
- Create: `services/openclaw-zalo-cell/vendor/zalouser-bridge/licenses/<package>@<version>/<original-path>` (all 39 exact bundled-dependency carrier files across exactly 38 locked package roots)
- Create: `services/openclaw-zalo-cell/vendor/zalouser-bridge/patches/{series,0001-durable-inbound-bridge-listener.patch,0002-private-bridge-send-rpc.patch,0003-close-bypasses-and-classify-control.patch}`
- Create: `services/openclaw-zalo-cell/vendor/zalouser-bridge/scripts/{verify-upstream,prepare,build,pack,verify-artifact}.mjs`
- Create: `services/openclaw-zalo-cell/vendor/zalouser-bridge/src/bridge/{inbound-listener,outbound-rpc,authorize-client,send-context,control-traffic}.ts`
- Create: `services/openclaw-zalo-cell/vendor/zalouser-bridge/test/{vendor-integrity,inbound-listener,outbound-choke-points,outbound-negative,control-traffic,reproducible-pack}.test.ts`
- Create: `services/openclaw-zalo-cell/vendor/zalouser-bridge/artifacts/openclaw-zalouser-2026.7.1.tgz`
- Create: `services/openclaw-zalo-cell/session-crypto/{package.json,package-lock.json,tsconfig.json,tsconfig.build.json,src/daemon.ts,src/crypto.ts,src/crypto.test.ts,dist/package.json,dist/crypto.js,dist/daemon.js}` (commit exactly these three ignored prebuilt runtime files with `git add -f`)
- Create: `services/openclaw-zalo-bridge/test/upstream-contract.test.ts`

- [ ] **Step 1: Write the failing vendor, seam, and image contract tests**

Assert `UPSTREAM.json` contains the exact OpenClaw/ZaloUser version; fixed tarball URL `https://registry.npmjs.org/@openclaw/zalouser/-/zalouser-2026.7.1.tgz`; a maximum of three HTTPS redirects restricted at every hop/final URL to `registry.npmjs.org` or a direct subdomain (never downgrade/cross-organization); byte size `2341459`; exactly `3169` regular `package/` entries; npm SRI; shasum/SHA-1; git head; mandatory npm attestation subject `pkg:npm/%40openclaw/zalouser@2026.7.1`; mandatory SLSA resolved commit equal to the git head; index digest; `linux/amd64` digest; reference `linux/arm64` digest; and a manifest/hash of the exact 75 committed `upstream/package/**` source-snapshot blobs from `extensions/zalouser` at that git head. Missing metadata, signature/provenance mismatch, or network failure is a hard stop for baseline/release/positive gates. Offline checks may only recheck committed bytes and cannot create/update `FORK.json` hashes, evidence, artifacts, or unlock Tasks 3-29. The source manifest must include the top-level public entrypoints (`index.ts`, `api.ts`, `runtime-api.ts`, `channel-plugin-api.ts`, `contract-api.ts`, `doctor-contract-api.ts`, `secret-contract-api.ts`, `setup-entry.ts`, `setup-plugin-api.ts`) as well as package-owned metadata and `src/**`. `SHA512SUMS` binds the verified registry tarball. The tar harness requires exactly `25` package-owned regular files outside `package/node_modules/**`, `3144` bundled regular files, and exactly `38` dependency package roots. It proves the package-owned set has no TypeScript, tests, source maps, license, or notice files and that the tarball is never used as the fork source tree. `verify-upstream.mjs` compares the 75-blob committed snapshot against the exact git commit and fails on an extra, missing, or changed source blob.

The raw provenance fixture contract requires exact committed bytes at `upstream/provenance/npm-registry-metadata.json`, `upstream/provenance/npm-registry-keys.json`, `upstream/provenance/npm-attestation-bundles.json`, and `upstream/provenance/sigstore-trusted-root.json`; the files retain every verification input, not reserialized projections. Acquisition is unauthenticated GET with exact headers `Accept: application/json` and `Accept-Encoding: identity`, status `200`, JSON content type after trimming parameters case-insensitively, and zero redirects. Endpoint/cap pairs are metadata `https://registry.npmjs.org/@openclaw%2Fzalouser/2026.7.1` / 64 KiB, keys `https://registry.npmjs.org/-/npm/v1/keys` / 64 KiB, attestations `https://registry.npmjs.org/-/npm/v1/attestations/@openclaw%2fzalouser@2026.7.1` / 256 KiB, and Sigstore trust root `https://tuf-repo-cdn.sigstore.dev/targets/6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66.trusted_root.json` / 64 KiB with exact size `6787` and SHA-256 `6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66`. The fetcher streams into a raw sink, aborts after cap+1, and atomically persists only unchanged bodies. `UPSTREAM.json.provenanceInputs` records every path/endpoint/cap/size/SHA-256 plus subject/key/trust bindings. Tests fail on authentication, compression, redirect, wrong status/content type, overflow, partial persistence, normalization/projection, or Git-blob disagreement.

The attestation verifier binds the signed subject digest to this exact fetched tarball: SHA-512 `92583404e3930efe3153292003fa53643b11ac8f5dcda82adb73a53eea422eb1628c339e6cfc4661a61d58348fcb8cc12405a38e74ab832081fb93ae08cbd91b` must equal decoded SRI bytes. The npm publish bundle uses exact key ID/SPKI from the committed keys response. The SLSA bundle pins the exact URI SAN, OIDC issuer, event, repository/ref/environment, leaf fingerprint, Fulcio root DER SHA-256 `3ba7b6cc4e95469d4d334b49cb257ad8537076fa84b0ca87ff4ecfe6a54680c1`, intermediate DER SHA-256 `15d795348226b4649f750f5802592c393bee7cc53c3b86982175b7ad087efe47`, build type, and resolved commit from the committed trust root. Implicit trust updates are forbidden.

For each bundle, recompute DSSE PAE from the exact payload type and decoded payload, verify every accepted signature, and bind it to the committed key/certificate. Rekor verification decodes the log key ID and requires SHA-256 `c0d23d6ad406973f9559f3ba2d1ca01f84147d8ffc5b8445c224f98b9591801d`; it independently verifies the SET over canonicalized body, inclusion proof leaf/root/index/tree size, signed checkpoint signature/origin/tree size/root, integrated time within certificate validity and policy, and equality among canonicalized-body envelope/payload hashes, the DSSE envelope, statement subject, build identity, and tarball digest. Missing or inconsistent SET/inclusion/checkpoint/time/body binding fails before hashes, evidence, artifacts, or gate state are written.

Signature, issuer, source, workflow, ref, build-type, resolved-commit, and subject validation must be performed against those exact committed raw bytes. A network refetch may compare its response bytes/hashes with `M`, but it may never replace or rewrite the committed provenance inputs.

`UPSTREAM.json` also records `licenseManifestSha256`, `licensePackageRootCount=38`, `licenseCarrierCount=39`, and the reviewed manifest schema. `FORK.json` is external control metadata and is forbidden from the tgz, so its manifest cannot self-reference. It fixes package name/version `@openclaw/zalouser@2026.7.1`, plugin ID/channel `zalouser`, the ordered patch list, patch-series SHA-256, bridge-overlay manifest/SHA-256, `licenseManifestSha256`, `artifactMembers` (exact sorted path/type/mode/size/SHA-256 for every internal tgz member), canonical `artifactMembersSha256`, exact public/exports/bin reachability roots, reviewed `runtimeDynamicImportPatterns`, reviewed `runtimeAssetPatterns`, `runtimeReachabilityAllowlist` (exact sorted runtime code/data closure), exact legal-member exceptions, exact package-metadata exceptions, built-tgz SHA-256, source epoch `1785062400`, internal artifact path, and `installedTree` with exact sorted installed path/type/mode/size/SHA-256 entries, file/directory counts, and canonical root hash. Every archive member must be a regular file with `type="file"`; directory, symlink, hardlink, device, FIFO, sparse, duplicate, traversal, and case-colliding entries are structurally forbidden. Static derivation must equal the allowlist; mandatory instrumented scenarios must produce a nonempty resolved set that is a subset of the allowlist. Every runtime-classified artifact member must belong to the allowlist, with only the two explicit legal/metadata exception sets outside it. Neither JSON derives its manifest hash from the internal notice or tgz; the committed reviewed `licenses/manifest.json` is the independent source of truth. Compute patch-series SHA-256 from UTF-8 bytes for `"ihome-zalouser-patch-series-v1\\0"` followed, in `patches/series` order, by each relative path, NUL, raw patch bytes, and NUL. Compute the overlay SHA-256 from `"ihome-zalouser-bridge-overlay-v1\\0"` followed by each ordered `src/bridge/**` relative path, NUL, raw bytes, and NUL. Reject missing/reordered/unlisted patch or overlay files, changed source snapshot/overlay bytes, wrong package metadata, extra tgz files, any packed `FORK.json`, any unlisted artifact member, resolved-unlisted runtime members, artifact runtime members outside the allowlist, missing allowlisted runtime members, path/type/mode/size/SHA-256 mismatch, TypeScript/tests in package-owned packed output, or an unrecorded root/dependency license/notice. Optional statically classified allowlist members may remain untraced when no mandatory scenario reaches them.

`FORK.json.runtimeDynamicSiteInventory` must enumerate every dynamic resolution or file-read site with source location, operation kind, exact static result or reviewed finite pattern, and exhaustive expanded members. Covered operations include non-literal `import()`, `require` and `createRequire`, `import.meta.resolve`, package `exports`/`bin` indirection, computed filesystem reads/assets, and computed module resolution. Any site that is absent, unclassified, non-finite, or not exhaustively expanded fails verification even if no runtime test exercises it.

Add compliance fixtures that byte-compare upstream root `LICENSE` to SHA-256 `73571b25326281d369087f469842c02444fe39faaecebda4d82ed21ff3a1c29d` and root `THIRD_PARTY_NOTICES.md` to SHA-256 `c84200f7a9bb8b3abc8563520433316716a9eb83915cfe7c3063d5e6fce5e7ca`; require the notice to be copied verbatim as `upstream/THIRD_PARTY_NOTICES.openclaw.md`. `licenses/manifest.json` must independently record every package selection and, for each of all 39 carriers, exact source path, byte size, SHA-256, and output path. Require `licenses/pako@2.2.0/LICENSE` and `licenses/pako@2.2.0/lib/zlib/README`; explicitly select the included Spark-md5 WTFPL branch and reject any network fetch or synthesized absent `LICENSE2`. Internal `THIRD_PARTY_NOTICES.md` must contain the upstream notice verbatim plus the manifest inventory, carrier paths, pako exception, and Spark selection. Every carrier must exist at `licenses/<package>@<version>/<original-path>` with exact bytes. The verifier rejects missing, extra, or changed carriers; dependency-root mismatch; any new notice file; path/case collision; traversal; or symlink entry. The packed compliance entries must be exactly `package/LICENSE`, `package/THIRD_PARTY_NOTICES.md`, and `package/licenses/**`; tests retain required runtime JS/JSON but reject dependency source/tests/fixtures/snapshots/docs/examples, every source map, and every inline `sourceMappingURL`.

The exact reviewed 38-package inventory in `licenses/manifest.json` and rendered internal notice is:

```text
asynckit@0.4.0 | MIT
bignumber.js@9.3.1 | MIT
call-bind-apply-helpers@1.0.2 | MIT
combined-stream@1.0.8 | MIT
crypto-js@4.2.0 | MIT
delayed-stream@1.0.0 | MIT
dunder-proto@1.0.1 | MIT
es-define-property@1.0.1 | MIT
es-errors@1.3.0 | MIT
es-object-atoms@1.1.2 | MIT
es-set-tostringtag@2.1.0 | MIT
form-data@2.5.6 | MIT
function-bind@1.1.2 | MIT
get-intrinsic@1.3.0 | MIT
get-proto@1.0.1 | MIT
gopd@1.2.0 | MIT
has-symbols@1.1.0 | MIT
has-tostringtag@1.0.2 | MIT
hasown@2.0.4 | MIT
json-bigint@1.0.0 | MIT
math-intrinsics@1.1.0 | MIT
mime-db@1.52.0 | MIT
mime-types@2.1.35 | MIT
pako@2.2.0 | MIT AND Zlib
psl@1.15.0 | MIT
punycode@2.3.1 | MIT
querystringify@2.2.0 | MIT
requires-port@1.0.0 | MIT
safe-buffer@5.2.1 | MIT
semver@7.8.5 | ISC
spark-md5@3.0.2 | WTFPL
tough-cookie@4.1.3 | BSD-3-Clause
typebox@1.3.3 | MIT
universalify@0.2.0 | MIT
url-parse@1.5.10 | MIT
ws@8.21.0 | MIT
zca-js@2.1.2 | MIT
zod@4.4.3 | MIT
```

Tests parse this complete block and require byte-for-byte semantic agreement with the committed manifest and both JSON lock files; Spark separately records `declaredExpression: WTFPL OR MIT` and selected SPDX `WTFPL`. The full reviewed 39-record carrier table (source tar path, byte size, SHA-256, and output derived exactly as `licenses/<package>@<version>/<relative-path>`) is an explicit normative input committed in `licenses/manifest.json`; implementation may not rediscover or regenerate it. An independent document/artifact reviewer approves the 38 selections, all 39 carrier records, rendered notice/carriers, `artifactMembers`, and runtime allowlist before pack evidence is accepted.

The normative carrier table below is the exact 39-row input. Rows were derived from the pinned tarball in a read-only temporary extraction and must be rechecked against the same source bytes; every hash is lowercase SHA-256, every output path is exactly `licenses/<package>@<version>/<relative-path>`, and no implementer may select a different carrier.

```text
asynckit@0.4.0 | MIT | package/node_modules/asynckit/LICENSE | 1078 | 1953150d5d4b10c7542cee6f6e0c613b2682545233f069d75cfff1936386ce10 | licenses/asynckit@0.4.0/LICENSE
bignumber.js@9.3.1 | MIT | package/node_modules/bignumber.js/LICENCE.md | 1147 | def75ba75d6426f1c3f02addf8e175fbe6e0d8a82e541cbdffc16d2bd8fd7d6a | licenses/bignumber.js@9.3.1/LICENCE.md
call-bind-apply-helpers@1.0.2 | MIT | package/node_modules/call-bind-apply-helpers/LICENSE | 1071 | 5e325595b4ea8cfec3802f545b1def5d7b73e4a5b8e9ba63e32a320f67732292 | licenses/call-bind-apply-helpers@1.0.2/LICENSE
combined-stream@1.0.8 | MIT | package/node_modules/combined-stream/License | 1085 | 47eb8ca82c798246774946d1be0f9aa08f025fa8325ced0947aeeb4c05fe5547 | licenses/combined-stream@1.0.8/License
crypto-js@4.2.0 | MIT | package/node_modules/crypto-js/LICENSE | 1169 | f729d14b7e1bf8adca0dcc38b93b929d14d53fcd5db56c3d1c9b2daa7aa69396 | licenses/crypto-js@4.2.0/LICENSE
delayed-stream@1.0.0 | MIT | package/node_modules/delayed-stream/License | 1085 | 47eb8ca82c798246774946d1be0f9aa08f025fa8325ced0947aeeb4c05fe5547 | licenses/delayed-stream@1.0.0/License
dunder-proto@1.0.1 | MIT | package/node_modules/dunder-proto/LICENSE | 1073 | 2b770a704c15de238c3f622b01b0044ddd60b49ee30608ea6991ebf19db7a7a1 | licenses/dunder-proto@1.0.1/LICENSE
es-define-property@1.0.1 | MIT | package/node_modules/es-define-property/LICENSE | 1071 | 5e325595b4ea8cfec3802f545b1def5d7b73e4a5b8e9ba63e32a320f67732292 | licenses/es-define-property@1.0.1/LICENSE
es-errors@1.3.0 | MIT | package/node_modules/es-errors/LICENSE | 1071 | 5e325595b4ea8cfec3802f545b1def5d7b73e4a5b8e9ba63e32a320f67732292 | licenses/es-errors@1.3.0/LICENSE
es-object-atoms@1.1.2 | MIT | package/node_modules/es-object-atoms/LICENSE | 1071 | 5e325595b4ea8cfec3802f545b1def5d7b73e4a5b8e9ba63e32a320f67732292 | licenses/es-object-atoms@1.1.2/LICENSE
es-set-tostringtag@2.1.0 | MIT | package/node_modules/es-set-tostringtag/LICENSE | 1073 | 1a3aeb1f1398bd697d57c3c585faadf59d825aca6e3162cd7eeb72ff76eb2466 | licenses/es-set-tostringtag@2.1.0/LICENSE
form-data@2.5.6 | MIT | package/node_modules/form-data/License | 1118 | e5b780d4f38d1d3328e3e53186c4e62d3fa149ea6f2bacd5de5ad0c30ac85343 | licenses/form-data@2.5.6/License
function-bind@1.1.2 | MIT | package/node_modules/function-bind/LICENSE | 1052 | 773e131a7684726005a7e4688a80b4620033bc08499bc1404dd1a1eb3bca725e | licenses/function-bind@1.1.2/LICENSE
get-intrinsic@1.3.0 | MIT | package/node_modules/get-intrinsic/LICENSE | 1071 | 39c5ec504cf6bd5cd782a7c695828e09189df79f5d94840e4f08feb97b9fd416 | licenses/get-intrinsic@1.3.0/LICENSE
get-proto@1.0.1 | MIT | package/node_modules/get-proto/LICENSE | 1071 | be46ce1e3b0479af9ce82d22b465a6d7d2ff084fca0aaf3d54172da2b5eb5781 | licenses/get-proto@1.0.1/LICENSE
gopd@1.2.0 | MIT | package/node_modules/gopd/LICENSE | 1071 | d90bf0a089da4cf43d644ed240a0b3825dcdb705e64e38371d56995a4cc9e4c5 | licenses/gopd@1.2.0/LICENSE
hasown@2.0.4 | MIT | package/node_modules/hasown/LICENSE | 1083 | bf9b0d665be2a689851eea667ca9f42066ea1d903b38349c51e6a44b2577680a | licenses/hasown@2.0.4/LICENSE
has-symbols@1.1.0 | MIT | package/node_modules/has-symbols/LICENSE | 1071 | 206c1adcf206dc0031b11232f5b054ec5f1662407ab1ca415247921cab2068ab | licenses/has-symbols@1.1.0/LICENSE
has-tostringtag@1.0.2 | MIT | package/node_modules/has-tostringtag/LICENSE | 1067 | e2560e002e13281578c75c850061d9255c33d16d732939e8c2db64c2506642fa | licenses/has-tostringtag@1.0.2/LICENSE
json-bigint@1.0.0 | MIT | package/node_modules/json-bigint/LICENSE | 1081 | def82c085d05e795fe6a9cb5b70c48e022212355afc0e91d4de047cade28df06 | licenses/json-bigint@1.0.0/LICENSE
math-intrinsics@1.1.0 | MIT | package/node_modules/math-intrinsics/LICENSE | 1073 | 2b770a704c15de238c3f622b01b0044ddd60b49ee30608ea6991ebf19db7a7a1 | licenses/math-intrinsics@1.1.0/LICENSE
mime-db@1.52.0 | MIT | package/node_modules/mime-db/LICENSE | 1172 | cc1dfd4dafa27271e8212cd3b274eeb3f262e40a6fdab36ddc3f9696f706f58b | licenses/mime-db@1.52.0/LICENSE
mime-types@2.1.35 | MIT | package/node_modules/mime-types/LICENSE | 1167 | 71f83c4c0621102a56d9853812777b85751bce7e9726f686f5b056c1f8a4b0e6 | licenses/mime-types@2.1.35/LICENSE
pako@2.2.0 | MIT AND Zlib | package/node_modules/pako/LICENSE | 1104 | a04665b3b2de56c66730c1f720f528175739e4104f79073614aa611da1e85539 | licenses/pako@2.2.0/LICENSE
pako@2.2.0 | MIT AND Zlib | package/node_modules/pako/lib/zlib/README | 2180 | 20356aece8f36fda34645e97af3b163da0a88e253b78ffba298590d5b9121ebb | licenses/pako@2.2.0/lib/zlib/README
psl@1.15.0 | MIT | package/node_modules/psl/LICENSE | 1101 | ae8c4a3b09681bc30ecbc984d58c4dc2c21b56d320fc02f558d12e86995c26c8 | licenses/psl@1.15.0/LICENSE
punycode@2.3.1 | MIT | package/node_modules/punycode/LICENSE-MIT.txt | 1077 | 483acb265f182907d1caf6cff9c16c96f31325ed23792832cc5d8b12d5f88c8a | licenses/punycode@2.3.1/LICENSE-MIT.txt
querystringify@2.2.0 | MIT | package/node_modules/querystringify/LICENSE | 1115 | 3b2a6a268aa815dec121d614245e03b5c68db1f044d5b525e36db7d5dc7fb9c3 | licenses/querystringify@2.2.0/LICENSE
requires-port@1.0.0 | MIT | package/node_modules/requires-port/LICENSE | 1115 | 3b2a6a268aa815dec121d614245e03b5c68db1f044d5b525e36db7d5dc7fb9c3 | licenses/requires-port@1.0.0/LICENSE
safe-buffer@5.2.1 | MIT | package/node_modules/safe-buffer/LICENSE | 1081 | c7cc929b57080f4b9d0c6cf57669f0463fc5b39906344dfc8d3bc43426b30eac | licenses/safe-buffer@5.2.1/LICENSE
semver@7.8.5 | ISC | package/node_modules/semver/LICENSE | 765 | 4ec3d4c66cd87f5c8d8ad911b10f99bf27cb00cdfcff82621956e379186b016b | licenses/semver@7.8.5/LICENSE
spark-md5@3.0.2 | WTFPL | package/node_modules/spark-md5/LICENSE | 486 | 9c4214d48030b7e877ed2fd76044ea079a987c9b3f01f9b6964ba4a475a5a13d | licenses/spark-md5@3.0.2/LICENSE
tough-cookie@4.1.3 | BSD-3-Clause | package/node_modules/tough-cookie/LICENSE | 1485 | 22ec6791c91ba42c0516a05f4cbdde019aae4687f8a38c5ca7e8a69ee68f851d | licenses/tough-cookie@4.1.3/LICENSE
typebox@1.3.3 | MIT | package/node_modules/typebox/license | 1094 | e8a7cc256941a26ba8234f04390165243a4d42f74fd6491934140605bf7eae2d | licenses/typebox@1.3.3/license
universalify@0.2.0 | MIT | package/node_modules/universalify/LICENSE | 1100 | 3fda5977c0904e226190b4e21d64340c1731e2142d6fe5f3dee0090a216b8b63 | licenses/universalify@0.2.0/LICENSE
url-parse@1.5.10 | MIT | package/node_modules/url-parse/LICENSE | 1115 | 3b2a6a268aa815dec121d614245e03b5c68db1f044d5b525e36db7d5dc7fb9c3 | licenses/url-parse@1.5.10/LICENSE
ws@8.21.0 | MIT | package/node_modules/ws/LICENSE | 1183 | 2b29dcfe0d6471f7e8c92c5fb38c9f93edee10330937055440192f1832b1ecef | licenses/ws@8.21.0/LICENSE
zca-js@2.1.2 | MIT | package/node_modules/zca-js/LICENSE | 1124 | 517f4df002c16fc050acc6391dfe31670f4927e58fd281eeea2101f581da75a9 | licenses/zca-js@2.1.2/LICENSE
zod@4.4.3 | MIT | package/node_modules/zod/LICENSE | 1072 | 3f1189b28e3866e0d979968d466b78f813f76827cfdca1fbb124cc0a5c8841f8 | licenses/zod@4.4.3/LICENSE
```

Add artifact behavior tests with independent static closure and runtime tracing. Before deriving closure, a static analyzer inventories every dynamic resolution/file-read site across the prepared source: non-literal `import()`, `require`/`createRequire`, `import.meta.resolve`, package `exports`/`bin` indirection, computed filesystem reads/assets, and computed module resolution. Each site must resolve to exact members statically or map to an exact reviewed finite pattern whose expansion is exhaustive; an absent, unclassified, open-ended, or incompletely expanded site fails even when runtime never exercises it. The analyzer independently derives the exact runtime code/data closure from all public entrypoints, `package.json` `exports`/`bin`, recursive static imports/requires, and reviewed site expansions without using the allowlist/member manifest; require `derivedRuntimeSet == runtimeReachabilityAllowlist` and require every artifact member classified as runtime code/data to belong to that allowlist. Exact legal carriers and enumerated package metadata are the only non-runtime exceptions.

Clean offline install/load tests instrument module resolution and file/asset reads over the mandatory scenario matrix: discovery/config/setup/doctor; QR and session restore; inbound text/media; outbound text/media/link/reaction; control traffic; authorization denial and UNKNOWN; and offline restart. The aggregate `resolvedRuntimeSet` must be nonempty and a subset of `runtimeReachabilityAllowlist`; every resolved-unlisted member fails. Optional members statically proven in the allowlist may remain untraced, so listed-but-unresolved is not a failure. Dynamic-site classification remains exhaustive and fail-closed regardless of coverage. A negative fixture adds an unexercised/unclassified site and must fail static analysis. The tests load the exact tgz through the pinned OpenClaw plugin loader, require one `zalouser` plugin/channel and the private RPC, cross-check `plugins list --json`, plugin inspect JSON, installed `package.json`, `FORK.json.installedTree`, and every loader/discovery root, and reject duplicate or shadow packages. Differential tests include explicit stock-fail/fork-pass fixtures for the private inbound/outbound authorization seams, plus prepared-tree versus installed-tgz parity for unchanged public behavior. Structural bans cannot be waived, pruning cannot delete an allowlisted member, and no artifact member absent from `FORK.json.artifactMembers` may install or load.

The pinned-host harness tests the actual patched source choke points. Inbound tests cover `extensions/zalouser/src/monitor.ts` and `extensions/zalouser/src/zalo-js.ts`: the provider callback remains void/non-awaited, while the fork's internal listener emits the complete `ZaloUserInboundEnvelopeV1`, awaits the local bridge, and permits no OpenClaw dispatch/queue or built-in reply before WAL/FULL success. Stable-ID cases cover event ID only, message ID only, both present, exact replay, mismatched event/message mapping, same ID with different payload, reuse across event kinds in one account, and the same textual ID in different accounts/organizations without cross-dedupe. Fingerprint is exercised only when both stable IDs are null and remains at-least-once with collision telemetry. Media manifests commit while bytes may remain `PENDING`; bridge error/timeout/crash/ENOSPC/corrupt acknowledgement never marks internal listener success. Tests make no provider-level acknowledgement or pre-callback zero-loss claim.

The same harness must also prove the successful path remains passive: after WAL/FULL commit returns success, after OpenClaw dispatch/queue, and after canonical automation completes as no-send, human draft, or outbox creation, built-in ZaloUser/OpenClaw reply count, pairing notification count, and every non-private-RPC business-content provider frame count remain zero. Creating an outbox does not emit; only a later explicit authorized `zalouser.bridge.send` call may enter the provider path.

Outbound tests cover `extensions/zalouser/src/send.ts` including text/media/link/reaction, `extensions/zalouser/src/channel.adapters.ts`, and `extensions/zalouser/src/tool.ts`. Only `zalouser.bridge.send` may create an authorized business-send context. The fork builds the exact ordered provider batch first and calls `/v1/outbox/authorize-send` immediately before provider I/O. Missing, denied, errored, timed-out, stale, replayed, or hash-mismatched authorization emits zero provider frames. Generic `send`, message tool, pairing notification, and direct adapter/tool calls fail closed. Timeout/disconnect/ack loss after possible handoff returns UNKNOWN evidence and never retries. Typing, seen, and delivery receipts are fixed-schema control traffic and cannot carry business content.

Add session-at-rest tests proving plaintext credentials and session files exist only in tmpfs, persistent files use AES-256-GCM with a unique nonce/auth tag, decrypt failure is fatal, writes use temp file + fsync + atomic rename + directory fsync, rotation re-encrypts with a new key generation, and no plaintext fallback is possible.

Add a session-crypto build contract. `tsconfig.build.json` names only `src/crypto.ts` and `src/daemon.ts` as build inputs and disables declarations/source maps; tests and every other source are excluded. A clean build deletes prior `dist`, emits exactly `crypto.js` and `daemon.js`, then atomically writes exact UTF-8 bytes `{"type":"module"}\n` as `dist/package.json`. `verify:dist` performs two independent clean builds, requires byte-identical path/size/SHA-256 manifests, compares the result with the three committed dist blobs, and rejects stale or extra output. The reviewed runtime closure is exactly those three files; no d.ts, test, source, lock, tsconfig, node_modules, compiler, or cache may enter the context or final rootfs. Keep session-crypto `engines.node >=22.13.0` unchanged while enforcing Node `>=24.15.0 <25` in build/gate entrypoints.

Add command-contract fixtures for `.dockerignore`, `image-lock.json`, `build-evidence.schema.v1.json`, the exact two-stage Dockerfile, `export-reviewed-tree.mjs`, normalization/build helpers, image-contract tests, `vite.config.ts`, and `eslint.config.js`. Task 2 must add precise root Vitest/ESLint exclusions for immutable `vendor/zalouser-bridge/upstream/package/**` and binary/generated artifact paths so the committed upstream `*.test.ts` snapshot and tgz are not traversed by root `npx vitest run`/`eslint .`; the exclusions must not hide `vendor/zalouser-bridge/test/**` contract tests. Negative fixtures delete/broaden these rules and catch accidental traversal or hidden owned tests. Pre-`R` development is non-qualifying. After exact-`R` clean preflight, the qualifying exporter must be obtained from the exact `R` blob and must enumerate `git ls-tree -rz --full-tree R`, consume objects through `git cat-file --batch`, reject non-blob/unapproved modes, preserve `100644`/`100755`, verify Git object size/SHA-1 plus content size/SHA-256, write a deterministic export manifest, and re-hash every output before any `npm ci`, verifier, or build. Working-tree reads, `git checkout`, and `git archive` are forbidden qualifying paths; `git -c core.autocrlf=false archive` appears only in negative/diagnostic fixtures. Context-root v2 uses raw UTF-8 path sorting and `preimage = UTF8("ihome-openclaw-context-root-v2\\0") || UTF8("count\\0" + decimal(1 + inputCount) + "\\0") || record("lock", lockType, lockMode, "image-lock.json", lockSha256) || each record("input", type, mode, path, sha256)`, where `record(role,type,mode,path,sha256) = UTF8(role + "\\0" + type + "\\0" + mode + "\\0" + path + "\\0" + lowercaseHexSha256 + "\\0")`. Golden vector: empty lock SHA `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; `Dockerfile` `FROM scratch\n` blob/`100644` SHA `bb57c7da220a8753d7bdabac0d3afdb6efa742e4c736c5bc93ab40dfd5e23b9b`; `scripts/install.sh` `#!/bin/sh\nexit 0\n` blob/`100755` SHA `306c6ca7407560340797866e077e053627ad409277d1b9da58106fce4cf717cb`; root `925be74a4fe381076871348887a653659ada468fa21333d5d22585be9e381f4e`. M-aggregate fixtures verify the exact 87-path count, RFC 8785 null projection, domain/record grammar and golden root, separately check the final `UPSTREAM.json` blob, and reject self-referential final-blob hashes, omitted paths, wrong projection fields, duplicate JSON keys, or projection substitution during review. Node-contract fixtures require the dependency-free assertion before the first Node/npm/npx/vendor/helper call, accept `24.15.0` and later `24.x`, reject `22.20.x`, `24.14.x`, and `25.x`, and prove rejection leaves no worktree, build context, artifact, or evidence. Docker negatives reject any stage count other than two, any session-crypto `npm ci`/build, a context input outside the exact three dist blobs, reused/nonempty vendor cache, a Node assertion after install, missing `RUN --network=none`, or claims that pinned base-image pull is air-gapped. Evidence-child fixtures require the exact reviewed verifier to validate the copied evidence, closed schema, reviewed tree, and retained absolute OCI candidate before staging. Detached-evidence cleanup fixtures for Task 2, E27, and E29 dirty the child worktree and inject primary/cleanup failures; they require canonical temp-contained paths, checked `git worktree remove --force`, primary-error preservation, and cleanup failure propagation when no primary error. Other negatives cover wrong builder pins, network/fallback install, mutable state, non-minimal rootfs, non-identical OCI, installed/discovery mismatch, handoff/schema/review tampering, source/evidence mixing, ignored-only final evidence, a Task 29 bundle/deploy before approved E29, or native failure followed by a sentinel.

- [ ] **Step 2: Run the tests and verify they fail**

This is a pre-`R` TDD development run. Its only valid result is RED evidence for missing behavior; it is not a positive/release gate and cannot produce or update qualifying artifact/evidence state.

Run:

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge ci
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge test
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run typecheck
npx vitest run services/openclaw-zalo-bridge/test/upstream-contract.test.ts
npm --prefix services/openclaw-zalo-cell/session-crypto ci
npm --prefix services/openclaw-zalo-cell/session-crypto test
npm --prefix services/openclaw-zalo-cell/session-crypto run typecheck
npm --prefix services/openclaw-zalo-cell/session-crypto run verify:dist
```

Expected: FAIL because the vendor harness, patch series, tgz, cell lock/evidence, session package, and exact prebuilt dist contract do not exist. Under rejected Node versions, the assertion fails before `npm`/`npx` and no work/artifact/evidence path is created.

- [ ] **Step 3: Freeze and review manifest/provenance commit M, then implement and freeze R**

All tests, compilation, packing, and provisional verification in this step are pre-`R` development checks used to create the candidate files that will be committed as `R`. They remain non-qualifying until the later exact-`R` gate re-runs from the clean reviewed export.

Create only the immutable manifest/raw-provenance checkpoint first: `.gitattributes`; the precise `vite.config.ts` and `eslint.config.js` exclusions; `UPSTREAM.json`; `SHA512SUMS`; exact raw `upstream/provenance/npm-registry-metadata.json`, `upstream/provenance/npm-registry-keys.json`, `upstream/provenance/npm-attestation-bundles.json`, and `upstream/provenance/sigstore-trusted-root.json`; exact `upstream/LICENSE.openclaw`; exact `upstream/THIRD_PARTY_NOTICES.openclaw.md`; the 75-blob `upstream/package/**` snapshot; and `licenses/manifest.json`. The exclusions are part of `M` because the snapshot contains exactly 22 upstream test files; they cover only immutable `upstream/package/**` and binary/generated vendor artifacts, never `vendor/zalouser-bridge/test/**`. `.gitattributes` contains vendor-wide `-text` plus the narrower tgz `binary` rule. Acquire all four JSON bodies under the exact raw contract. `M` still contains exactly 87 input paths: 75 snapshot blobs plus `.gitattributes`, two root configs, `UPSTREAM.json`, `SHA512SUMS`, four provenance/trust blobs, two root compliance blobs, and `licenses/manifest.json`. Do not render internal legal/carrier files, patches/overlay output, `FORK.json`, tgz, image locks, or evidence yet.

The 87-path aggregate is deliberately non-self-referential. `UPSTREAM.json.mInputAggregate` is exactly `{ "schema": 1, "domain": "ihome-openclaw-m-inputs-v1", "pathCount": 87, "sha256": "<64-lowercase-hex>" }`. Sort all records by raw UTF-8 path bytes. For each of the other 86 paths, append `record("blob", path, mode, rawSize, gitBlobOid, rawSha256)`, where `gitBlobOid` is the repository's Git SHA-1 blob object ID encoded as exactly 40 lowercase hex characters; a generic or SHA-256 object-format value is invalid. For `services/openclaw-zalo-cell/vendor/zalouser-bridge/UPSTREAM.json`, parse strict UTF-8 JSON with duplicate keys/non-finite numbers rejected, replace only `mInputAggregate.sha256` with JSON `null`, serialize the complete projection with RFC 8785 JCS UTF-8, and append `record("projection", upstreamPath, mode, projectionSize, "-", projectionSha256)`. The aggregate is SHA-256 of `UTF8("ihome-openclaw-m-inputs-v1\\0") || UTF8("count\\0" + decimal(87) + "\\0") || sortedRecords`, where `record(kind,path,mode,size,objectId,sha256) = UTF8(kind + "\\0" + path + "\\0" + mode + "\\0" + decimal(size) + "\\0" + objectId + "\\0" + lowercaseHexSha256 + "\\0")`. The stored aggregate hash is verified by recreating this null projection. `UPSTREAM.json` cannot and must not claim its own final Git SHA-1 blob OID/raw SHA-256 inside itself; the `M` reviewer separately verifies the final committed `UPSTREAM.json` mode, size, lowercase 40-hex Git SHA-1 blob OID, and raw SHA-256 while still proving 87 total paths.

Golden aggregate fixture: count `2`; empty `.gitattributes` blob mode `100644`, Git SHA-1 blob OID `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; projection bytes `{"mInputAggregate":{"domain":"ihome-openclaw-m-inputs-v1","pathCount":2,"schema":1,"sha256":null}}`, byte size `98`, SHA-256 `5596aa901117139fdb6a574ceaa1b973f9af5d5e6d60422ca4fdec2fcf9120d3`; projection path `UPSTREAM.json`, mode `100644`, object marker `-`. The resulting aggregate SHA-256 must equal `1d37c61eb87d4e9caf320f9ab07aed1e0d4cfc11e7496493db46fe1d4f6a97fb`.

Commit these exact paths as `M`; only after the commit exists may a fresh read-only reviewer inspect exact `M`. Every raw byte count/hash is computed from committed Git objects using `git ls-tree` and `git cat-file blob`, never from a checkout or reserialized JSON. The reviewer verifies all 87 paths, recalculates the non-self-referential aggregate from the 86 raw blob records plus exact JCS-null `UPSTREAM.json` projection, checks the golden vector, and separately records the final committed `UPSTREAM.json` mode/size/lowercase 40-hex Git SHA-1 blob OID/raw SHA-256. The reviewer also validates npm and Fulcio signatures, DSSE PAE, SET/inclusion/checkpoint/time/body binding, exact subject/source/workflow/ref/environment/build/resolved-commit claims, and the 38-package/39-carrier manifest. Its canonical schema-v1 report names exact `M`, reviewer role/identity/run ID, decision `APPROVED`, and empty findings, and is saved outside the reviewed tree for later exact-byte embedding. A pre-commit tree, proposed hash, plan commit, later descendant, network-only response, or projection substituted for final-blob review cannot be called reviewed `M`.

```powershell
git add .gitattributes vite.config.ts eslint.config.js services/openclaw-zalo-cell/vendor/zalouser-bridge/UPSTREAM.json services/openclaw-zalo-cell/vendor/zalouser-bridge/SHA512SUMS services/openclaw-zalo-cell/vendor/zalouser-bridge/upstream/provenance/npm-registry-metadata.json services/openclaw-zalo-cell/vendor/zalouser-bridge/upstream/provenance/npm-registry-keys.json services/openclaw-zalo-cell/vendor/zalouser-bridge/upstream/provenance/npm-attestation-bundles.json services/openclaw-zalo-cell/vendor/zalouser-bridge/upstream/provenance/sigstore-trusted-root.json services/openclaw-zalo-cell/vendor/zalouser-bridge/upstream/LICENSE.openclaw services/openclaw-zalo-cell/vendor/zalouser-bridge/upstream/THIRD_PARTY_NOTICES.openclaw.md services/openclaw-zalo-cell/vendor/zalouser-bridge/upstream/package services/openclaw-zalo-cell/vendor/zalouser-bridge/licenses/manifest.json
git commit -m "chore(openclaw-zalo): khoa provenance manifest M" -m "Co-Authored-By: Codex <noreply@openai.com>"
$M = git rev-parse HEAD
```

Any `M` review finding requires a new commit and a new exact-SHA review before rendering begins. Later network fetches may compare exact response bytes/hashes with the reviewed raw files but cannot update, replace, normalize, or silently select different provenance bytes without creating and reviewing a new `M`.

`verify-upstream.mjs` first verifies the exact 87-path `M` inventory, the domain/count/record aggregate and golden fixture, the final `UPSTREAM.json` Git blob separately, and `UPSTREAM.json.provenanceInputs` against exact `M` Git blobs. It parses only those committed metadata/key/attestation/trust-root bytes for the full trust policy. It may then reacquire all four JSON endpoints solely for raw byte/hash comparison under the zero-redirect capped contract. Tarball acquisition remains separate: start at `https://registry.npmjs.org/@openclaw/zalouser/-/zalouser-2026.7.1.tgz`, follow at most three same-registry HTTPS redirects, then verify final URL, exact bytes, size `2341459`, `3169` regular `package/` entries, SRI, SHA-1, and `gitHead`. Metadata unavailable, signature/provenance/trust-root mismatch, raw-byte mismatch, aggregate/projection mismatch, or network failure aborts before any `FORK.json` hash, evidence, artifact, or positive-gate state. Offline mode only rechecks committed bytes and is non-qualifying. The verifier rejects traversal, symlinks, duplicate/case-colliding paths, or non-regular entries; requires exact `25` package-owned/`3144` bundled/`38` root counts; and compares the exact 75 committed Git blobs under `extensions/zalouser` at `2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4`. `prepare.mjs` copies those verified blob bytes into ignored `.work/`; the build never reconstructs source from the npm tarball.

Only after exact commit `M` is independently approved, render from its manifest: each of the 38 package records contains exact name/version/SPDX selection and each of the 39 carrier records contains exact source path, byte size, SHA-256, and output path. `UPSTREAM.json` and `FORK.json` record the manifest SHA-256/schema/counts and fail if they disagree. Copy upstream root `LICENSE` exactly to `upstream/LICENSE.openclaw` and internal `LICENSE`; copy upstream root `THIRD_PARTY_NOTICES.md` verbatim to `upstream/THIRD_PARTY_NOTICES.openclaw.md`. Generate internal `THIRD_PARTY_NOTICES.md` and the carrier tree only from the reviewed manifest. Copy all 39 carriers byte-for-byte to `licenses/<package>@<version>/<original-path>`; never fetch or synthesize Spark `LICENSE2`. `verify-upstream.mjs` and `verify-artifact.mjs` reject a missing/extra/changed carrier, package-root mismatch, new notice file, path/case collision, traversal, symlink, manifest self-derivation, or any hash mismatch.

Apply the three committed patches plus `src/bridge/**` overlay deterministically. Preserve package name/version and plugin ID/channel. Patch the top-level `index.ts` entrypoint to register the private `zalouser.bridge.send` RPC and patch `monitor.ts`/`zalo-js.ts` for the awaited internal inbound listener. Patch `send.ts`, including link/reaction branches, plus `channel.adapters.ts` and `tool.ts` for private RPC context enforcement; classify typing/seen/delivery receipts in the third patch. Disable built-in OpenClaw/ZaloUser replies and pairing notifications with content. Run upstream-compatible tests plus the fork tests, compile with the fixed source epoch, use `npm pack --ignore-scripts`, and build `FORK.json.artifactMembers` as the exact sorted file-by-file path/type/mode/size/SHA-256 manifest for every tgz member. Inventory every non-literal `import()`, `require`/`createRequire`, `import.meta.resolve`, package `exports`/`bin` indirection, computed fs-read/asset, and computed module-resolution site. Each site must statically resolve or map to an exact reviewed finite pattern with exhaustive expansion; fail on any absent/unclassified/open-ended site even if runtime does not exercise it. Independently derive runtime closure and require `derivedRuntimeSet == runtimeReachabilityAllowlist`; separately trace the mandatory scenario matrix and require nonempty `resolvedRuntimeSet` with `resolvedRuntimeSet` a subset of the allowlist. Fail on resolved-unlisted, runtime artifact outside the allowlist, pruning of an allowlisted member, unclassified/incomplete dynamic inventory, or member absent from `artifactMembers`; do not fail merely because an optional statically classified allowlist member is untraced. Exact legal carriers and enumerated package metadata are the only allowed non-runtime members. Verify the tgz retains this closure plus legal carriers at `package/LICENSE`, `package/THIRD_PARTY_NOTICES.md`, and `package/licenses/**`. Prune and reject dependency source, tests, fixtures, snapshots, docs, examples, all source maps, every inline `sourceMappingURL`, extra license/notice files, traversal, symlinks, and case-colliding paths.

Build twice from the committed verified source snapshot into separate `.work/` directories and require byte-identical tgz SHA-256 plus identical `artifactMembers`. Write the actual patch-series, bridge-overlay manifest/SHA-256, license-manifest hash, artifact-member manifest, runtime reachability allowlist, and tgz hash to `FORK.json`; re-run `verify-artifact.mjs`, clean offline install/load, upstream-compatible suite, and prepared-tree-versus-installed-tgz differential runtime corpus. The committed artifact is `artifacts/openclaw-zalouser-2026.7.1.tgz` and no other ZaloUser tgz is accepted. Pack evidence remains provisional until a fresh independent reviewer approves the committed license manifest, rendered legal outputs, `artifactMembers`, reachability allowlist, and behavior-test evidence.

Before `R`, run the Node `>=24.15.0 <25` assertion before the first package command, install/test/typecheck session-crypto, and run `verify:dist`. That verifier clean-builds twice from `tsconfig.build.json`, compares byte-identical manifests, and requires the materialized reviewed output to contain exactly `dist/package.json`, `dist/crypto.js`, and `dist/daemon.js`; `dist/package.json` is exact `{"type":"module"}\n`. It rejects stale output and confirms the package/lock engine remains `>=22.13.0`. Docker never repeats these package install/build steps.

After all tracked source, patches, overlay, rendered legal files/carriers, `FORK.json`, package metadata, internal tgz, `installedTree`, artifactMembers, runtime inventory/allowlist, build-evidence schema, image-contract test, normalization tool, session build config, exact three-file prebuilt session runtime, and lock/tooling files are frozen, commit the final source/artifact/lock/tooling checkpoint `R` (do not include `build-evidence.json`, which is created only by `E`). Review only exact committed SHA `R` with a fresh read-only reviewer; the review must confirm `M` is an ancestor, every tracked output is present, no source/evidence mixing occurred, and no working-tree or plan-only state is treated as reviewed. It also verifies the two clean session builds match the exact three committed Git blobs and no extra dist member exists. Emit the same closed canonical review-report format as `M`, with exact `R`, reviewer role/identity/run ID, decision `APPROVED`, empty findings, and exact bytes retained outside `R` for evidence embedding.

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
npm --prefix services/openclaw-zalo-cell/session-crypto ci
npm --prefix services/openclaw-zalo-cell/session-crypto test
npm --prefix services/openclaw-zalo-cell/session-crypto run typecheck
npm --prefix services/openclaw-zalo-cell/session-crypto run verify:dist
git add services/openclaw-zalo-cell/Dockerfile services/openclaw-zalo-cell/.dockerignore services/openclaw-zalo-cell/image-lock.json services/openclaw-zalo-cell/README.md services/openclaw-zalo-cell/config services/openclaw-zalo-cell/scripts services/openclaw-zalo-cell/vendor services/openclaw-zalo-cell/session-crypto services/openclaw-zalo-bridge/test/upstream-contract.test.ts
git add -f -- services/openclaw-zalo-cell/session-crypto/dist/package.json services/openclaw-zalo-cell/session-crypto/dist/crypto.js services/openclaw-zalo-cell/session-crypto/dist/daemon.js
$expectedSessionDist = @(
  'services/openclaw-zalo-cell/session-crypto/dist/package.json',
  'services/openclaw-zalo-cell/session-crypto/dist/crypto.js',
  'services/openclaw-zalo-cell/session-crypto/dist/daemon.js'
)
$stagedSessionDist = @(git diff --cached --name-only -- services/openclaw-zalo-cell/session-crypto/dist)
if ((Compare-Object -ReferenceObject $expectedSessionDist -DifferenceObject $stagedSessionDist).Count -ne 0) { throw 'R must stage exactly the three reviewed session-crypto dist files' }
if (git diff --cached --name-only | Select-String '(^|/)build-evidence\.json$') { throw 'R must not contain build-evidence.json' }
git commit -m "feat(openclaw-zalo): freeze verified vendor source artifact R" -m "Co-Authored-By: Codex <noreply@openai.com>"
$R = git rev-parse HEAD
if (-not (git merge-base --is-ancestor $M $R)) { throw 'M is not an ancestor of R' }
```

If the exact-SHA `R` review finds any issue, create a new forward commit and review its new SHA; never amend a reviewed `R` or use a descendant without a fresh review.

- [ ] **Step 4: Run verification and build strictly from reviewed R without tracked mutation**

Use the architecture-specific base and local-only installation contract:

```dockerignore
**
!Dockerfile
!.dockerignore
!image-lock.json
!config/
!config/openclaw.json.tmpl
!scripts/
!scripts/install-vendored-zalouser.sh
!scripts/normalize-openclaw-install.mjs
!vendor/
!vendor/zalouser-bridge/
!vendor/zalouser-bridge/FORK.json
!vendor/zalouser-bridge/artifacts/
!vendor/zalouser-bridge/artifacts/openclaw-zalouser-2026.7.1.tgz
!session-crypto/
!session-crypto/dist/
!session-crypto/dist/package.json
!session-crypto/dist/crypto.js
!session-crypto/dist/daemon.js
```

```dockerfile
FROM ghcr.io/openclaw/openclaw:2026.7.1@sha256:165b4992f1b4b74ffdd7a02c887ba006f9f5dc951eca420eef573a8b233b543f AS install
ARG SOURCE_DATE_EPOCH
USER node
COPY --chown=node:node image-lock.json /opt/openclaw-cell/image-lock.json
COPY --chown=node:node vendor/zalouser-bridge/FORK.json /opt/openclaw-cell/vendor/FORK.json
COPY --chown=node:node vendor/zalouser-bridge/artifacts/openclaw-zalouser-2026.7.1.tgz /opt/openclaw-cell/vendor/openclaw-zalouser-2026.7.1.tgz
COPY --chown=node:node scripts/install-vendored-zalouser.sh /opt/openclaw-cell/install-vendored-zalouser.sh
COPY --chown=node:node scripts/normalize-openclaw-install.mjs /opt/openclaw-cell/normalize-openclaw-install.mjs
RUN --network=none node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major!==24||minor<15){console.error("Node >=24.15.0 <25 is required");process.exit(1)}' \
    && test "$SOURCE_DATE_EPOCH" = "1785062400" \
    && test ! -e /tmp/npm-empty \
    && mkdir /tmp/npm-empty \
    && test -z "$(find /tmp/npm-empty -mindepth 1 -print -quit)" \
    && /opt/openclaw-cell/install-vendored-zalouser.sh --offline --cache /tmp/npm-empty --no-fallback \
    && node /opt/openclaw-cell/normalize-openclaw-install.mjs --source-date-epoch "$SOURCE_DATE_EPOCH"

FROM ghcr.io/openclaw/openclaw:2026.7.1@sha256:165b4992f1b4b74ffdd7a02c887ba006f9f5dc951eca420eef573a8b233b543f AS runtime
USER node
COPY --from=install --chown=node:node /home/node/.openclaw/npm/projects/zalouser /home/node/.openclaw/npm/projects/zalouser
COPY --chown=node:node session-crypto/dist/package.json /opt/openclaw-cell/session-crypto/dist/package.json
COPY --chown=node:node session-crypto/dist/crypto.js /opt/openclaw-cell/session-crypto/dist/crypto.js
COPY --chown=node:node session-crypto/dist/daemon.js /opt/openclaw-cell/session-crypto/dist/daemon.js
COPY --chown=node:node config/openclaw.json.tmpl /opt/openclaw-cell/openclaw.json.tmpl
```

The first gate commands, before any `npm ci` or executable verifier/build, require `HEAD` to equal independently reviewed exact `R`, a completely clean status/index, and no merge/rebase. The dependency-free Node assertion runs immediately after PowerShell fail-fast setup and before exporter/helper work; `build-reproducible-image.ps1` repeats the same self-preflight before creating temp paths/builders/artifacts/evidence. Bootstrap `export-reviewed-tree.mjs` from its exact `R` Git blob through a raw byte stream, then verify its blob type, Git object ID, and byte size before executing it. The exporter must enumerate `git ls-tree -rz --full-tree R`, consume objects through `git cat-file --batch`, preserve only reviewed `100644`/`100755` blob modes, reject symlink/submodule/tree/unknown entries, record Git object size/SHA-1 plus content size/SHA-256, and write a deterministic manifest. A separate verify mode must re-enumerate exact `R`, validate the complete manifest, and re-hash every exported output before any dependency install, test, verifier, or build. No working-tree byte, checkout, JSON reserialization, or archive extraction may qualify; `git archive` is allowed only in an explicit negative/diagnostic fixture that proves it is rejected as a qualifying source path. Every dependency install, test, verifier, and Docker context uses the fully verified export. `.dockerignore` is deny-by-default; `image-lock.json` lists exact Git-tree path/type/mode/size/SHA-256 records except itself and explicitly binds the three session-crypto dist Git blobs. Context-root v2 includes those three records and uses the approved ordered algorithm and golden vector `925be74a4fe381076871348887a653659ada468fa21333d5d22585be9e381f4e` for the empty-lock/Dockerfile/install.sh fixture. Candidate evidence is written only to the absolute source `.release/` path; later gates, including Tasks 19 and 27, repeat reviewed source `R ->` qualifying build `->` evidence-only `E`, never source plus tracked evidence in one commit.

The Dockerfile has exactly two stages. The `install` stage has one application install `RUN --network=none`: the Node version assertion is the first command, then the source epoch check creates one cache that did not previously exist, proves it is empty, installs only the local tgz with offline/no-fallback flags, and normalizes reviewed OpenClaw install state. No Docker stage runs session-crypto `npm ci`, TypeScript, tests, or any compiler. The `runtime` stage copies only the installed fork closure, exact reviewed `session-crypto/dist/package.json`, `dist/crypto.js`, `dist/daemon.js`, and runtime config, excluding d.ts/tests/source/package lock/tsconfig/node_modules/compiler/cache as well as tgz, `FORK.json`, image lock, scripts, and temporary state. The pinned base image is still acquired separately by BuildKit under `--pull`; `RUN --network=none` constrains application execution and does not claim air-gapped base acquisition. `install-vendored-zalouser.sh` verifies the local tgz and performs no npm metadata/tarball request. Verification requires matching results from `openclaw plugins list --json`, plugin inspect JSON, installed package.json, installedTree, every loader/discovery root, exact final-rootfs hashes for the three session files, and duplicate/shadow scans. The template contains no secrets or customer/provider identifiers.

`build-reproducible-image.ps1` accepts an absolute `-BuildxPath`, rejects PATH lookup, verifies semantic version exactly `0.13.1`, and verifies the platform binary SHA-256: Windows `6b113e84cbc3cd645646aa82f00a7f7d3737cc10375b4341e0aca0de0c997c75`, Linux `3e2bc8ed25a9125d6aeec07df4e0211edea6288e075b524160ef3fd305d3d74c`. It creates two fresh `docker-container` builders named `ihome-openclaw-gate-a-<32hex>` and `ihome-openclaw-gate-b-<32hex>` with exact BuildKit `moby/buildkit:v0.13.2@sha256:9194b5ec1be368f41c516df7f93f7f540630ea06136056b2ffebb62226ed4ad6`; each worker reports `v0.13.2`. In one `try/finally`, it builds the same exact-`-ReviewedTree` context through both builders with `--platform linux/amd64 --no-cache --pull --build-arg SOURCE_DATE_EPOCH=1785062400 --provenance=false --sbom=false` and distinct pinned OCI outputs. Every native call goes through a self-contained checked PowerShell 7.3 wrapper. Cleanup is exact-name and validated-temp-root only.

The helper invokes `verify-image-lock.mjs --oci-a ... --oci-b ...` before cleanup. The verifier requires byte-identical OCI archive bytes, then extracts both safely and requires identical `oci-layout`, `index.json`, file set, path/type/mode/size/SHA-256 manifest, and every blob byte; it separately verifies index/manifest/config/layer digests, mtimes, base digest, installedTree, plugin list/inspect/package/discovery roots, no duplicate/shadow/upstream package, private RPC, and stock-fail/fork-pass behavior. It byte-compares the exact three session-crypto input Git blobs with final-rootfs `dist/package.json`, `dist/crypto.js`, and `dist/daemon.js`, rejects every extra session path, and records both input and installed hashes. It validates `build-evidence.json` against closed `build-evidence.schema.v1.json` (`additionalProperties: false` recursively) and embeds exact canonical `M`/`R` review report bytes as base64 plus size/SHA-256 and reviewed identity fields. It atomically promotes gate A to the explicit source `.release/` path and records exact `M`, `R`, Git-blob provenance inputs including trust root, buildx binary path/hash/version, BuildKit pin, context-root v2, archive/layout/index/blob equality, installed tree, three-file session closure, scenario runtime sets, promoted archive path/hash, and every Task 2 result. Missing/tampered bytes, schema drift, review-report mismatch, lock mismatch, or tracked mutation fails.

Run:

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
$R = $env:OPENCLAW_REVIEWED_R_SHA
if ($R -notmatch '^[0-9a-f]{40}$') { throw 'OPENCLAW_REVIEWED_R_SHA must be the exact reviewed R SHA' }
$buildxPath = (Resolve-Path -LiteralPath $env:OPENCLAW_BUILDX_PATH -ErrorAction Stop).Path
if (-not [IO.Path]::IsPathFullyQualified($buildxPath)) { throw 'OPENCLAW_BUILDX_PATH must resolve to an absolute path' }
$sourceRoot = (Get-Location).Path
if ((git rev-parse HEAD).Trim() -ne $R) { throw 'HEAD is not exact reviewed R' }
if (@(git status --porcelain=v1 --untracked-files=all).Count -ne 0) { throw 'R working tree is not completely clean' }
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { throw 'R index is not empty' }
$gitStatePaths = @(
  (git rev-parse --git-path MERGE_HEAD)
  (git rev-parse --git-path rebase-merge)
  (git rev-parse --git-path rebase-apply)
)
if (@($gitStatePaths | Where-Object { Test-Path -LiteralPath $_ }).Count -ne 0) { throw 'Merge/rebase is in progress' }

$exporterRel = 'services/openclaw-zalo-cell/scripts/export-reviewed-tree.mjs'
$exporterBlob = (git rev-parse "$R`:$exporterRel").Trim()
if ($exporterBlob -notmatch '^[0-9a-f]{40}$') { throw 'Reviewed exporter blob ID is invalid' }
if ((git cat-file -t $exporterBlob).Trim() -ne 'blob') { throw 'Reviewed exporter is not a blob' }
$exporterSize = [int64](git cat-file -s $exporterBlob)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$bootstrapRoot = Join-Path $tempRoot ('ihome-openclaw-bootstrap-' + [guid]::NewGuid().ToString('N'))
$exportRoot = Join-Path $tempRoot ('ihome-openclaw-r-' + [guid]::NewGuid().ToString('N'))
$releaseRoot = Join-Path $sourceRoot 'services/openclaw-zalo-cell/.release'
New-Item -ItemType Directory -Path $bootstrapRoot -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path $releaseRoot -Force -ErrorAction Stop | Out-Null
try {
  $bootstrapExporter = Join-Path $bootstrapRoot 'export-reviewed-tree.mjs'
  $gitPath = (Get-Command git -CommandType Application -ErrorAction Stop).Source
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $gitPath
  $startInfo.ArgumentList.Add('cat-file')
  $startInfo.ArgumentList.Add('blob')
  $startInfo.ArgumentList.Add($exporterBlob)
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw 'Unable to start raw Git blob export' }
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $destination = [IO.File]::Open($bootstrapExporter, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $process.StandardOutput.BaseStream.CopyTo($destination)
  } finally {
    $destination.Dispose()
  }
  $process.WaitForExit()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) { throw "git cat-file exporter bootstrap failed: $stderr" }
  $process.Dispose()
  if ((Get-Item -LiteralPath $bootstrapExporter).Length -ne $exporterSize) { throw 'Reviewed exporter byte size mismatch' }
  if ((git hash-object $bootstrapExporter).Trim() -ne $exporterBlob) { throw 'Reviewed exporter Git object mismatch' }

  $exportManifest = Join-Path $bootstrapRoot 'reviewed-tree-manifest.json'
  node $bootstrapExporter export --reviewed-tree $R --output-root $exportRoot --manifest $exportManifest
  node $bootstrapExporter verify --reviewed-tree $R --output-root $exportRoot --manifest $exportManifest

  Push-Location $exportRoot
  try {
    npm ci
    npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge ci
    npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run verify
    npx vitest run services/openclaw-zalo-bridge/test/upstream-contract.test.ts
    npm --prefix services/openclaw-zalo-cell/session-crypto ci
    npm --prefix services/openclaw-zalo-cell/session-crypto test
    npm --prefix services/openclaw-zalo-cell/session-crypto run typecheck
    npm --prefix services/openclaw-zalo-cell/session-crypto run verify:dist
  } finally {
    Pop-Location
  }

  $reviewedImageHelper = Join-Path $exportRoot 'services/openclaw-zalo-cell/scripts/build-reproducible-image.ps1'
  & $reviewedImageHelper -ReviewedTree $R -BuildxPath $buildxPath -Platform 'linux/amd64' -SourceDateEpoch '1785062400' -EvidencePath (Join-Path $releaseRoot 'task2-build-evidence.json') -ReleaseArtifactPath (Join-Path $releaseRoot 'openclaw-zalo-cell-linux-amd64.oci.tar')

  if ((git rev-parse HEAD).Trim() -ne $R) { throw 'Source HEAD changed after exported-R run' }
  if (@(git status --porcelain=v1 --untracked-files=all).Count -ne 0) { throw 'Exported-R run mutated source worktree/index' }
  git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) { throw 'Exported-R run mutated source index' }
} finally {
  if (Test-Path -LiteralPath $exportRoot) { Remove-Item -LiteralPath $exportRoot -Recurse -Force }
  if (Test-Path -LiteralPath $bootstrapRoot) { Remove-Item -LiteralPath $bootstrapRoot -Recurse -Force }
}
```

Expected: every command exits 0, injected native failure prevents later sentinels, `HEAD` remains exact `R`, and source/index remain unchanged. This creates candidate OCI/evidence only. Evidence includes `M`/`R`; exact Git-blob path/size/SHA-256 records for all four raw provenance/trust inputs; npm key, Fulcio chain/identity, DSSE/SET/inclusion/checkpoint/time/body proof; tarball locks; source/compliance manifests; exact `artifactMembers` and `installedTree`; complete dynamic-site inventory; `derivedRuntimeSet == runtimeReachabilityAllowlist`; nonempty mandatory-scenario `resolvedRuntimeSet` subset of the allowlist; stock-fail/fork-pass and unchanged differential results; pinned buildx/BuildKit/context-root v2; byte-identical OCI archive/layout/index/blob evidence; normalized timestamps/state; promoted archive; and deterministic image digest. It validates against the closed schema and embeds exact canonical `M`/`R` approval-report bytes/base64, sizes/hashes, SHAs, reviewer roles/identities/run IDs, `APPROVED`, and empty findings. Negative fixtures reject acquisition/trust mismatch, resolved-unlisted members, unclassified dynamic sites, artifact runtime outside allowlist, duplicate/shadow install, source/evidence mixing, non-minimal rootfs, OCI byte drift, schema openness, or review-report tampering. Optional statically classified allowlist members may remain untraced. Task 29 later repeats reviewed source `R ->` qualifying build `->` evidence-only `E`.

Candidate evidence re-hashes every `UPSTREAM.json.provenanceInputs` Git blob from `M` (path, byte size, SHA-256, endpoint/cap, subject/key/trust identity), proves all trust decisions came from those exact raw bytes, records complete dynamic-site inventory/finite expansions and mandatory scenario traces, and rejects any unexercised/unclassified dynamic resolution or file-read site.

- [ ] **Step 5: Create the evidence-only child E**

After the reviewed-`R` run succeeds, resolve both verified candidate evidence and the retained OCI archive from absolute paths under the source worktree's `.release/`, reject either file or their parent path if it is a reparse point/symlink, and hash both before copying. Create the detached-child path as a canonical generated child of the canonical non-reparse temp root, then add the worktree at exact `R`, copy and re-hash exactly one tracked file as `services/openclaw-zalo-cell/build-evidence.json`, and invoke the exact reviewed child-worktree `verify-image-lock.mjs` against that copy, the closed schema, exact `$R`, and the retained absolute candidate archive before staging. Only verifier success may commit `E`. Prove `E^ == R` and the committed diff is exactly that evidence path; the OCI archive remains external and uncommitted. Cleanup must use checked `git worktree remove --force` so a dirty child is still removed; a cleanup error fails when it is the only error, while a simultaneous cleanup error is reported without masking the primary exception. Only after confirmed path and registration removal may the source branch fast-forward from `R` to `E`. No relative path may be interpreted inside the child worktree, and no source, artifact, lock, tooling, config, plan, or archive file may differ.

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
$sourceRoot = (Resolve-Path -LiteralPath '.').Path
$releaseRoot = Join-Path $sourceRoot 'services/openclaw-zalo-cell/.release'
$candidateEvidence = Join-Path $releaseRoot 'task2-build-evidence.json'
$candidateArchive = Join-Path $releaseRoot 'openclaw-zalo-cell-linux-amd64.oci.tar'
$releaseItem = Get-Item -LiteralPath $releaseRoot -ErrorAction Stop
$candidateItem = Get-Item -LiteralPath $candidateEvidence -ErrorAction Stop
$candidateArchiveItem = Get-Item -LiteralPath $candidateArchive -ErrorAction Stop
if ($candidateItem.PSIsContainer -or $candidateArchiveItem.PSIsContainer) { throw 'Task 2 candidates must be files' }
if (($releaseItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($candidateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($candidateArchiveItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Task 2 candidate paths must not traverse a reparse point' }
$candidateSha256 = (Get-FileHash -LiteralPath $candidateEvidence -Algorithm SHA256).Hash.ToLowerInvariant()
$candidateArchiveSha256 = (Get-FileHash -LiteralPath $candidateArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ((git rev-parse HEAD).Trim() -ne $R) { throw 'Evidence child must start from R' }
if (@(git status --porcelain=v1 --untracked-files=all).Count -ne 0) { throw 'R worktree is not completely clean' }
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { throw 'R index is not empty' }
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRootItem = Get-Item -LiteralPath $tempRoot -ErrorAction Stop
if ($tempRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Temp root must not be a reparse point' }
$eWorktree = [IO.Path]::GetFullPath((Join-Path $tempRoot ('ihome-openclaw-e-' + [guid]::NewGuid().ToString('N'))))
$eRelative = [IO.Path]::GetRelativePath($tempRoot, $eWorktree)
if ([IO.Path]::IsPathRooted($eRelative) -or $eRelative -eq '..' -or $eRelative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)) { throw 'Detached E path escaped canonical temp root' }
$primaryError = $null
$cleanupError = $null
try {
  git worktree add --detach $eWorktree $R
  $eDestination = Join-Path $eWorktree 'services/openclaw-zalo-cell/build-evidence.json'
  New-Item -ItemType Directory -Path (Split-Path -Parent $eDestination) -Force -ErrorAction Stop | Out-Null
  Copy-Item -LiteralPath $candidateEvidence -Destination $eDestination -ErrorAction Stop
  if ((Get-FileHash -LiteralPath $eDestination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateSha256) { throw 'Copied evidence hash mismatch' }
  if ((Get-FileHash -LiteralPath $candidateArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateArchiveSha256) { throw 'Candidate archive changed before E verification' }
  Push-Location $eWorktree
  try {
    node services/openclaw-zalo-cell/scripts/verify-image-lock.mjs --evidence services/openclaw-zalo-cell/build-evidence.json --schema services/openclaw-zalo-cell/build-evidence.schema.v1.json --reviewed-tree $R --release-artifact $candidateArchive
    git add services/openclaw-zalo-cell/build-evidence.json
    $ePaths = @(git diff --cached --name-only)
    if (($ePaths.Count -ne 1) -or ($ePaths[0] -ne 'services/openclaw-zalo-cell/build-evidence.json')) { throw 'E staged diff is not evidence-only' }
    git commit -m "chore(openclaw-zalo): record verified evidence E" -m "Co-Authored-By: Codex <noreply@openai.com>"
    $E = (git rev-parse HEAD).Trim()
    if ((git rev-parse "$E^").Trim() -ne $R) { throw 'E is not a direct child of R' }
    $committedPaths = @(git diff-tree --no-commit-id --name-only -r $E)
    if (($committedPaths.Count -ne 1) -or ($committedPaths[0] -ne 'services/openclaw-zalo-cell/build-evidence.json')) { throw 'E committed diff is not evidence-only' }
  } finally {
    Pop-Location
  }
} catch {
  $primaryError = $_
} finally {
  try {
    $registeredPaths = @(git worktree list --porcelain | Where-Object { $_ -like 'worktree *' } | ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9)) })
    if (($registeredPaths -contains $eWorktree) -or (Test-Path -LiteralPath $eWorktree)) {
      git worktree remove --force $eWorktree
      if ($LASTEXITCODE -ne 0) { throw 'Forced detached E worktree removal failed' }
    }
    if (Test-Path -LiteralPath $eWorktree) { throw 'Detached E path remains after forced removal' }
    $remainingPaths = @(git worktree list --porcelain | Where-Object { $_ -like 'worktree *' } | ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9)) })
    if ($remainingPaths -contains $eWorktree) { throw 'Detached E registration remains after forced removal' }
  } catch {
    $cleanupError = $_
  }
  if ($null -ne $primaryError) {
    if ($null -ne $cleanupError) { [Console]::Error.WriteLine('Detached E cleanup also failed: ' + $cleanupError.Exception.Message) }
    throw $primaryError
  }
  if ($null -ne $cleanupError) { throw $cleanupError }
}
if ((git rev-parse HEAD).Trim() -ne $R) { throw 'Source branch moved before E fast-forward' }
git merge --ff-only $E
if ((git rev-parse HEAD).Trim() -ne $E) { throw 'Source branch did not fast-forward to E' }
```

- [ ] **Step 6: Independently review exact E and unlock Tasks 3-29**

Use a fresh read-only `reviewer` agent with `fork_turns="none"`. Give it exact `M`, `R`, `E`; the original canonical review report files; all four committed raw provenance/trust blobs and bindings; source/compliance/artifact/installed-tree/runtime evidence; both OCI archives/layout manifests; promoted archive; schema; and `R..E`. It decodes the embedded base64 reports, byte-compares them with the originals, verifies sizes/SHA-256/exact reviewed SHAs/reviewer role/identity/run ID/`APPROVED`/empty findings, validates the closed evidence schema, proves `M` ancestor of `R`, `E^ == R`, and exactly one changed path, and rechecks every trust/runtime/build result. Any finding, missing input, offline-only provenance, non-exact SHA, report tampering, source/evidence mixing, or non-evidence diff keeps Tasks 3-29 blocked.

After `E` approval, consume/remove only the ignored promoted archive after its exact bytes/hash have been handed to the approved evidence consumer. Contract tests inspect tracked status and exact path allowlists; `.work/`, `.release/`, and host `node_modules` may exist only as ignored temporary inputs/outputs and can neither enter the clean context nor be committed.

### Task 3: Add OpenClaw Permissions And Navigation Contracts

**Files:**
- Create: `supabase/migrations/20260727010000_openclaw_catalog_foundation.sql`
- Modify: `src/lib/permissions.ts`
- Modify: `src/lib/permissionPages.ts`
- Modify: `src/lib/__tests__/permissionPages.test.ts`
- Create: `src/lib/__tests__/openclawPermissionMigration.test.ts`

- [ ] **Step 1: Write failing registry and migration tests**

Assert the exact keys, tiers, and no implicit grant behavior:

```ts
const actions = actionsForModule("openclaw_zalo");
expect(actions).toEqual([
  "view", "send", "manage_connections", "manage_automation",
  "manage_knowledge", "manage_handoff", "manage_operations", "audit",
]);
expect(canFeature({}, "openclaw_zalo", "send")).toBe(false);
```

The SQL test must assert eight `permission_definitions`, organization-only scope, the fixed sensitivity mapping, definitions before grants, explicit grants only to active owner system roles, and no `chat_zalo`/`zalo_*` references.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npx vitest run src/lib/__tests__/permissionPages.test.ts src/lib/__tests__/openclawPermissionMigration.test.ts
```

Expected: FAIL because `openclaw_zalo` and the migration do not exist.

- [ ] **Step 3: Implement the permission registry**

Add five new `ActionKey` members and this module:

```ts
{
  key: "openclaw_zalo",
  label: "OpenClaw Zalo ca nhan",
  core: ["view"],
  extra: [
    "send", "manage_connections", "manage_automation", "manage_knowledge",
    "manage_handoff", "manage_operations", "audit",
  ],
}
```

Add all action labels. Do not add `manage_connections`, `manage_operations`, or `audit` to broad manage presets. Add one `PermissionPage` for `/openclaw-zalo` with `view` tier for `view`, `manage` tier for `send/manage_knowledge/manage_handoff`, and `elevated` tier for the other four actions.

- [ ] **Step 4: Implement the catalog migration**

The migration must:

1. Create a dedicated `openclaw_function_owner NOLOGIN NOINHERIT NOBYPASSRLS` role if missing. Task 4 owns the separate writer/principal roles; this catalog migration grants no canonical table privileges.
2. Insert/update the exact eight definitions using `TENANT`, `ARRAY['ORGANIZATION']`, empty required dimensions, and no possession requirement.
3. Grant all eight keys only to active system owner roles whose exact normalized name is `Chủ sở hữu tổ chức`; the ASCII spelling appears only in tests/documentation and is not a second production role name.
4. Create an internal `AFTER INSERT` trigger on `organization_roles` that grants the eight keys only when `NEW.is_system=true` and `NEW.name='Chủ sở hữu tổ chức'`. This is the explicit future-organization provisioning path; do not assume another provisioning hook exists.
5. Revoke all direct access to the trigger/helper. In the migration test, insert a future organization's active system owner role and assert exactly eight OpenClaw grants, then insert ASCII-named, non-owner system, and staff roles and assert each receives zero OpenClaw grants.

- [ ] **Step 5: Run tests**

Run:

```powershell
npx vitest run src/lib/__tests__/permissionPages.test.ts src/lib/__tests__/openclawPermissionMigration.test.ts
node scripts/check-openclaw-isolation.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add supabase/migrations/20260727010000_openclaw_catalog_foundation.sql src/lib/permissions.ts src/lib/permissionPages.ts src/lib/__tests__/permissionPages.test.ts src/lib/__tests__/openclawPermissionMigration.test.ts
git commit -m "feat(openclaw-zalo): them catalog quyen doc lap" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 4: Create Account, Cell, Connection, Lease, And QR Schema

**Files:**
- Create: `supabase/migrations/20260727015000_openclaw_security_principals.sql`
- Create: `src/lib/__tests__/openclawRuntimeFoundationMigration.test.ts`

- [ ] **Step 1: Write the failing schema characterization test**

Assert these tables and invariants:

```text
openclaw_accounts
openclaw_account_connections
openclaw_runtime_cells
openclaw_runtime_leases
openclaw_runtime_credentials
openclaw_maintenance_principals
openclaw_maintenance_leases
openclaw_maintenance_credentials
openclaw_qr_challenges
```

The test must require `organization_id` on every table, `UNIQUE(organization_id,id)` candidate keys, composite same-tenant/account FKs, one active account per organization, one current account/cell credential generation, one effective connection generation per account, one effective runtime lease per account, one current organization maintenance principal/credential/lease generation, and one pending unexpired QR challenge per account. Runtime credentials store only hashes, generations, enabled/revoked timestamps, allowed operation scopes, and the exact organization/account/cell binding. Maintenance credentials store only hashes/generations/scopes and bind the organization maintenance principal rather than an active Zalo account. It must require DB-clock TTL and a hard 120-second challenge window.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/lib/__tests__/openclawRuntimeFoundationMigration.test.ts`

Expected: FAIL because the six tables are absent.

- [ ] **Step 3: Implement the runtime foundation schema**

Use explicit state checks:

```sql
CHECK (connection_state IN ('DISCONNECTED','QR_PENDING','CONNECTING','CONNECTED','DISCONNECTING','RECONNECT_REQUIRED'))
CHECK (session_risk_state IN ('HEALTHY','DEGRADED','LIMITED','SUSPECTED_THEFT','INVALID'))
CHECK (challenge_status IN ('PENDING','CONSUMED','EXPIRED','REVOKED'))
CHECK (expires_at = issued_at + interval '120 seconds')
```

`configured_mode` and `effective_mode` use `OpenClawMode`; disconnect, revocation-pending, risk `LIMITED|SUSPECTED_THEFT|INVALID`, stale disclosure, or any higher-priority control forces `effective_mode='DRAFT_ONLY'` without inventing a connection state. Persist append-only connection/risk transitions and the disclosure acknowledgement version/timestamp used to decide whether reconnect is allowed.

The migration creates narrowly scoped `openclaw_runtime_writer` and `openclaw_maintenance_writer` roles as `NOLOGIN NOINHERIT NOBYPASSRLS`, owns canonical tables with `openclaw_function_owner`, and defines explicit owner policies/minimal grants so `FORCE ROW LEVEL SECURITY` remains usable. `service_role`, `authenticated`, and `anon` receive no canonical table DML. Public service-only RPC facades are owned by the relevant writer role, have pinned `search_path`, and are the only Edge entry point. Catalog tests assert role attributes, memberships, owners, policies, `prosecdef`, `proconfig`, and grants; no broad `BYPASSRLS` role is permitted.

`openclaw_qr_challenges` must store only application-encrypted ciphertext, IV, auth tag, actor ID, auth-session hash, browser nonce hash, account/cell IDs, issued/expiry/consumed timestamps, and version. QR ciphertext gets no authenticated SELECT policy, no Realtime publication, and no browser DML grant.

`openclaw_runtime_credentials` is server-only, stores no plaintext secret, and has a partial uniqueness rule for one enabled current generation per `(organization_id,account_id,cell_id)`. Credential rotation disables every older generation atomically. It can authorize only channel scopes. `openclaw_maintenance_credentials` independently authorize only `maintenance.claim`/`maintenance.complete` for the organization maintenance principal with a live maintenance lease/fencing token; they do not depend on a current Zalo account, cell, or channel session.

Every table must immediately receive `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, `REVOKE ALL FROM public, anon, authenticated`, and indexed FK/policy lookup columns. Add an internal immutable-tenant trigger that rejects updates to `organization_id`, `account_id`, and trusted parent IDs after insert. Do not defer deny-by-default to a later migration.

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/__tests__/openclawRuntimeFoundationMigration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add supabase/migrations/20260727015000_openclaw_security_principals.sql src/lib/__tests__/openclawRuntimeFoundationMigration.test.ts
git commit -m "feat(openclaw-zalo): tao nen tang account va runtime" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 5: Create Inbox, Target, Message, And Media Schema

**Files:**
- Create: `supabase/migrations/20260727020000_openclaw_inbox_schema.sql`
- Create: `supabase/migrations/20260727025000_openclaw_inbound_automation.sql`
- Create: `src/lib/__tests__/openclawInboxMigration.test.ts`

- [ ] **Step 1: Write the failing inbox schema test**

Require these tables:

```text
openclaw_contacts
openclaw_sales_groups
openclaw_targets
openclaw_conversations
openclaw_conversation_members
openclaw_messages
openclaw_message_media
openclaw_inbound_events
openclaw_inbound_provider_identities
openclaw_inbound_automation_decisions
openclaw_ai_drafts
```

Assert that `openclaw_targets.kind IN ('PEER','SALES_GROUP')`, the contact/group FK is XOR, target provider IDs are unique within `(organization_id,account_id,kind)`, and out-of-order messages use canonical cursor ordering `(received_at,id)` rather than offset pagination. Provider timestamps remain display metadata and never drive pagination. Inbound identity tests cover event ID only, message ID only, both present, mismatched pair, same stable ID/different payload, reuse across event kinds, same textual ID across accounts/organizations, and fallback only when both IDs are null.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/lib/__tests__/openclawInboxMigration.test.ts`

Expected: FAIL because the migration is missing.

- [ ] **Step 3: Implement the inbox schema**

Use composite FKs including `organization_id` and `account_id` for targets, conversations, members, messages, and media. `openclaw_inbound_provider_identities` stores `(organization_id,account_id,event_kind,stable_id_kind,stable_id_value,inbound_event_id,payload_hash,paired_stable_id_kind,paired_stable_id_value)` with composite FK to the inbound event. Its canonical unique key is `(organization_id,account_id,event_kind,stable_id_kind,stable_id_value)`; an additional conflict guard rejects reuse of the same `(organization_id,account_id,stable_id_kind,stable_id_value)` under another event kind. `stable_id_kind` is exactly `PROVIDER_EVENT_ID` or `PROVIDER_MESSAGE_ID`.

`openclaw_inbound_events` selects event ID as primary when present. Message ID is secondary uniqueness for message-bearing events and becomes primary only when event ID is null. When both exist, the ingest transaction inserts both identity rows with reciprocal pair fields and the same event/payload hash. Existing identity + same kind/pair/hash is an idempotent replay; different pair, kind, event, or payload hash fails closed, quarantines the candidate, and appends collision audit. Organization/account are part of every key, so identical provider ID text in another account is independent. The fallback partial unique key `(organization_id,account_id,event_kind,fallback_fingerprint)` applies only under `provider_event_id IS NULL AND provider_message_id IS NULL`; the fingerprint is a domain-separated hash of canonical target/direction/provider timestamp bucket/sender/content/media identity, and same-fingerprint/different-payload also fails closed.

`20260727025000_openclaw_inbound_automation.sql` creates only the inbound decision/draft-side schema that can exist before delivery storage: immutable `openclaw_inbound_automation_decisions`, exact eligibility/no-send/recovery discriminators, frozen input/version references, and the constraints/indexes needed by the later atomic ingest RPC. It must not create a service facade, ingest RPC, trigger, work item, outbox row, or FK/reference to any Task 7 delivery-work table; those tables do not exist yet. `HISTORY_SYNC`, sales-group chatter, disabled modes, duplicate events, and ineligible targets have representable explicit no-send decision kinds, but Task 5 tests only schema integrity and never pretend to execute the later transaction.

`openclaw_ai_drafts` stores immutable prompt/input version references, OpenClaw cell result schema/version, DLP decision, human-edit version, and nullable publication/outbox linkage constrained to become usable only through Task 9 RPCs. It never stores model-selected targets or policy decisions. Task 9 owns the completion transaction that persists a draft and either stops for human review or creates a guarded outbox after current policy/DLP/state recheck.

Message media stores only metadata and the immutable R2 object key; it must reject `data:` URLs, base64 payload columns, public URLs, and arbitrary bucket names. Add indexes for active conversation list, thread cursor, unread state, provider dedupe, media retention, and selected account.

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/__tests__/openclawInboxMigration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add supabase/migrations/20260727020000_openclaw_inbox_schema.sql supabase/migrations/20260727025000_openclaw_inbound_automation.sql src/lib/__tests__/openclawInboxMigration.test.ts
git commit -m "feat(openclaw-zalo): tao schema inbox va target" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 6: Create Policy, Automation, Group, And Knowledge Schema

**Files:**
- Create: `supabase/migrations/20260727030000_openclaw_policy_automation_knowledge.sql`
- Create: `src/lib/__tests__/openclawPolicyAutomationMigration.test.ts`

- [ ] **Step 1: Write the failing policy schema test**

Require all approved tables:

```text
openclaw_consents
openclaw_suppressions
openclaw_policies
openclaw_policy_versions
openclaw_control_states
openclaw_takeovers
openclaw_automations
openclaw_automation_versions
openclaw_campaigns
openclaw_campaign_runs
openclaw_schedules
openclaw_crm_event_subscriptions
openclaw_sales_group_allowlists
openclaw_knowledge_sources
openclaw_knowledge_versions
openclaw_knowledge_chunks
```

Assert `GLOBAL_STOP` is keyed by organization, `control_version` is monotonic, `feature_enabled` and every automated mode default false, disclosure acknowledgement is versioned, automation/knowledge edits create immutable versions, group allowlists reference exact stable group targets, directory freshness is at most 24 hours, and knowledge sensitivity is one of the three approved values. An immutable `openclaw_automation_versions` row owns the outbound template body, allowed CRM field list, missing-value policy, escaping mode, maximum rendered length, and content/template version identifier; schedules, campaigns, and CRM subscriptions reference that exact version rather than mutable text.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/lib/__tests__/openclawPolicyAutomationMigration.test.ts`

Expected: FAIL because the migration is missing.

- [ ] **Step 3: Implement the schema and invariants**

Add explicit lifecycle checks for draft/published/archived automation and knowledge versions. Store quiet hours with timezone, explicit consent source/evidence/expiry, suppression reason/scope, takeover expiry/owner, schedule timezone/local recurrence rule/`next_run_at`/schedule version, campaign cancellation version, CRM subscription version/field mapping/destination, and allowlist freshness evidence. Publishing freezes template text and renderer settings in the automation version; later edits create a new version and cannot change an existing schedule occurrence, CRM occurrence, work item, outbox row, or payload hash.

`openclaw_knowledge_chunks` may store text and embeddings/metadata but must inherit the source/version organization and sensitivity through composite FKs. Retrieval queries must be able to exclude `INTERNAL_REVIEW_ONLY` and `RESTRICTED` for customer-facing generation.

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/__tests__/openclawPolicyAutomationMigration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add supabase/migrations/20260727030000_openclaw_policy_automation_knowledge.sql src/lib/__tests__/openclawPolicyAutomationMigration.test.ts
git commit -m "feat(openclaw-zalo): tao policy automation va knowledge" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 7: Create Delivery, UNKNOWN, Audit, Health, And Retention Schema

**Files:**
- Create: `supabase/migrations/20260727040000_openclaw_delivery_audit_ops.sql`
- Create: `src/lib/__tests__/openclawDeliveryMigration.test.ts`

- [ ] **Step 1: Write the failing delivery state-machine test**

Require:

```text
openclaw_outbox
openclaw_outbound_authorizations
openclaw_delivery_attempts
openclaw_dead_letters
openclaw_unknown_resolutions
openclaw_send_work_items
openclaw_send_work_attempts
openclaw_maintenance_work_items
openclaw_maintenance_work_attempts
openclaw_audit_events
openclaw_audit_roots
openclaw_health_events
openclaw_retention_holds
openclaw_rollout_runs
openclaw_rollout_observations
openclaw_rollout_checkpoints
openclaw_smoke_runs
openclaw_smoke_cleanup_proofs
```

Assert the exact outbox state set and source-specific partial uniqueness: manual `(organization_id,actor_id,client_operation_id)`, inbound reply `(organization_id,inbound_event_id,automation_version_id)`, schedule `(organization_id,schedule_id,schedule_version,occurrence_id,target_id)`, and CRM `(organization_id,subscription_id,subscription_version,occurrence_id,target_id)`. Same-key/different-payload rejection, frozen lineage IDs, canonical payload bytes/hash, claim/generation, DB-time lease, fencing/session/control/takeover versions, and immutable audit guards are mandatory. `openclaw_outbound_authorizations` stores organization/account/outbox, claim generation, canonical payload hash, fencing/session/control/takeover versions, nonce hash, DB-issued expiry, consumed timestamp, authorized-handoff timestamp, and one success per claim generation. Marker TTL is at most 15 seconds and never exceeds the outbox lease.

`openclaw_send_work_items` supports `INBOUND_AUTOMATION`, `SCHEDULE_OCCURRENCE`, and `CRM_EVENT`, with non-null organization/account/current-cell ownership and channel fencing. `openclaw_maintenance_work_items` supports `RETENTION_DELETE` and `AUDIT_ANCHOR`, with non-null organization/maintenance-principal/maintenance-lease generation and fencing but no required channel account/cell. Both use exact discriminated payloads, deterministic source/payload hashes, bounded leases, append-only attempts, CAS rebinding only while unclaimed, and terminal/dead-letter handling.

The rollout tables are canonical durable state, not transient script logs. `openclaw_rollout_runs` stores exact reviewed commit SHA, migration-manifest SHA-256, upstream SRI/git head, patch-series SHA-256, built-tgz SHA-256, immutable deployment artifact/image/package digests, current stage/version, `continuous_green_started_at`, and terminal status. `openclaw_rollout_checkpoints` stores append-only named checkpoints including `WAITING_OWNER_QR` and `WAITING_OWNER_INBOUND`; `openclaw_rollout_observations` stores content-free metric windows and resets the continuous-green interval through CAS on any failed/stale interval. `openclaw_smoke_runs` stores preallocated run IDs and immutable command scope, while `openclaw_smoke_cleanup_proofs` stores one durable zero-residual proof per cleanup generation. Direct browser/runtime DML is denied, authenticated reads are owner/audit scoped and redacted, rows retain at least 365 days, and only Task 9's exact service facades may begin/resume/observe/advance/cleanup with expected-version CAS. A process exit never advances or loses a rollout stage.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/lib/__tests__/openclawDeliveryMigration.test.ts`

Expected: FAIL because the migration is missing.

- [ ] **Step 3: Implement delivery and audit storage**

Use this state constraint:

```sql
CHECK (state IN ('QUEUED','LEASED','DISPATCHING','SENT','FAILED','UNKNOWN','DEAD_LETTER'))
```

Store RFC8785 canonical payload bytes/hash separately from the idempotency key and do not Unicode-normalize strings beyond JSON parsing; exact code points are part of the hash. Add partial indexes for claimable outbox/work rows, expired leases, unconsumed authorization nonces, dispatching sweeps, UNKNOWN operations, dead letters, retention tombstones, and health dashboards. Delivery attempts and work attempts are append-only; audit uses per-organization sequence, `previous_hash`, `event_hash`, actor/workload identity, request/correlation IDs, and redacted evidence.

Send and maintenance work attempts are separate append-only child tables carrying only their corresponding principal claims; update/delete is denied and only the narrow service facade can insert. `openclaw_unknown_resolutions` is append-only and uses exact discriminated outcome integrity checks, same-tenant composite FKs, `new_outbox_id <> outbox_id`, and a partial unique index for non-null `new_outbox_id`. The historical outbox has `resolution_version smallint NOT NULL DEFAULT 0 CHECK (resolution_version IN (0,1))` plus a transition guard rejecting every `OLD.state='UNKNOWN' AND NEW.state<>'UNKNOWN'`. Resolution linearizes with `UPDATE ... SET resolution_version=1 WHERE state='UNKNOWN' AND resolution_version=0 AND p_expected_resolution_version=0 RETURNING`; zero rows raises `40001`. Browser/runtime DML, late completion, requeue, and sweep cannot rewrite either unresolved or resolved UNKNOWN. Only the retention-authorized path may delete expired resolution evidence after the approved period and legal-hold checks.

Create internal-only `app_private.append_openclaw_audit_v1` and `app_private.verify_openclaw_audit_chain_v1`, owned by `openclaw_function_owner`, with a fixed search path and no client execute grant. `openclaw_audit_roots` stores one immutable daily root per organization with signing-key generation, R2 anchor key, signature/hash metadata, and anchored timestamp; the signing key itself remains outside the database.

Add row/transition guards so rollout stage order is `FOUNDATION -> INFRASTRUCTURE -> WAITING_OWNER_QR -> CONNECTION -> SHADOW -> WAITING_OWNER_INBOUND -> LIMITED_OBSERVING -> LIMITED_VERIFIED -> PROACTIVE -> SALES_GROUPS -> COMPLETE`. `WAITING_OWNER_QR` and `WAITING_OWNER_INBOUND` may only be completed by binding a later canonical QR/session or approved-peer inbound row through content-free IDs/hashes; the database rejects caller assertions without that trusted evidence. `LIMITED_VERIFIED` requires DB-clock proof of at least 72 continuous green hours across persisted observations, not elapsed time in one process. Smoke cleanup proof creation locks its run, proves zero residual `QUEUED`, `LEASED`, and `DISPATCHING` rows, and never releases organization-scoped `GLOBAL_STOP` automatically.

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/__tests__/openclawDeliveryMigration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add supabase/migrations/20260727040000_openclaw_delivery_audit_ops.sql src/lib/__tests__/openclawDeliveryMigration.test.ts
git commit -m "feat(openclaw-zalo): tao outbox audit va unknown" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 8: Add Tenant-Safe RLS, Grants, And Query Paths

**Files:**
- Create: `supabase/migrations/20260727050000_openclaw_access_policies.sql`
- Create: `src/lib/__tests__/openclawAccessPoliciesMigration.test.ts`

- [ ] **Step 1: Write the failing access-policy test**

Assert every `openclaw_*` table has `ENABLE` and `FORCE ROW LEVEL SECURITY`, no `anon` grants, no authenticated INSERT/UPDATE/DELETE grants, and only explicitly selected read tables receive authenticated SELECT. Require org-aware permission evaluation using the row's `organization_id`; reject `has_any_scope_v3` as a standalone row predicate.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/lib/__tests__/openclawAccessPoliciesMigration.test.ts`

Expected: FAIL because positive policies do not exist.

- [ ] **Step 3: Implement set-based authorization helpers and policies**

Create internal helpers with this contract:

```sql
app_private.openclaw_authorized_org_ids_v1(p_permission_key text)
RETURNS SETOF uuid

app_private.openclaw_can_org_v1(p_organization_id uuid, p_permission_key text)
RETURNS boolean
```

They must use active membership and `app_private.authorized_scope_v3(permission,org)` for the exact organization. Add safe SELECT policies for account health, contacts/groups/targets, conversations/messages/media metadata, published automation/knowledge metadata, and operator-visible operations according to permission. QR ciphertext, runtime credential hashes, raw attempts, raw audit, and retention holds remain RPC/service-only.

Use explicit column projections in read RPCs so a future sensitive column is not exposed by `SELECT *`.

- [ ] **Step 4: Verify policy SQL and query plan shape**

Run: `npx vitest run src/lib/__tests__/openclawAccessPoliciesMigration.test.ts`

Expected: PASS and the static test confirms indexed org/account predicates.

- [ ] **Step 5: Commit**

```powershell
git add supabase/migrations/20260727050000_openclaw_access_policies.sql src/lib/__tests__/openclawAccessPoliciesMigration.test.ts
git commit -m "feat(openclaw-zalo): them rls tenant va acl mac dinh tu choi" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 9: Add Versioned Browser And Runtime RPCs

**Files:**
- Create: `supabase/migrations/20260727060000_openclaw_rpc_surface.sql`
- Create: `src/lib/__tests__/openclawRpcSurfaceMigration.test.ts`

- [ ] **Step 1: Write failing RPC contract tests**

The static test must require these browser RPCs and exact operation IDs:

```text
openclaw_get_bootstrap_v1
openclaw_list_my_organizations_v1
openclaw_get_overview_v1
openclaw_list_conversations_v1
openclaw_list_messages_v1
openclaw_list_unknown_v1
openclaw_list_knowledge_v1
openclaw_get_knowledge_v1
openclaw_preview_knowledge_retrieval_v1
openclaw_list_automations_v1
openclaw_get_automation_v1
openclaw_dry_run_automation_v1
openclaw_list_sales_groups_v1
openclaw_list_schedules_v1
openclaw_list_dead_letters_v1
openclaw_list_audit_events_v1
openclaw_list_health_events_v1
openclaw_list_legal_holds_v1
openclaw_acknowledge_risk_v1
openclaw_begin_qr_login_v1
openclaw_poll_qr_login_v1
openclaw_consume_qr_challenge_v1
openclaw_disconnect_account_v1
openclaw_create_send_intent_v1
openclaw_takeover_conversation_v1
openclaw_release_takeover_v1
openclaw_resolve_unknown_v1
openclaw_set_control_state_v1
openclaw_publish_automation_v1
openclaw_publish_knowledge_v1
openclaw_upsert_group_allowlist_v1
openclaw_upsert_schedule_v1
openclaw_mark_conversation_read_v1
openclaw_assign_conversation_v1
openclaw_create_knowledge_draft_v1
openclaw_update_knowledge_draft_v1
openclaw_validate_knowledge_v1
openclaw_archive_knowledge_v1
openclaw_create_automation_draft_v1
openclaw_save_automation_step_v1
openclaw_pause_automation_v1
openclaw_request_directory_sync_v1
openclaw_pause_schedule_v1
openclaw_cancel_schedule_v1
openclaw_create_legal_hold_v1
openclaw_release_legal_hold_v1
openclaw_replay_dead_letter_v1
```

Require these exact service-only routines in `app_private`, with no execute grant to browser roles:

```text
openclaw_runtime_heartbeat_v1
openclaw_exchange_runtime_credential_v1
openclaw_exchange_maintenance_credential_v1
openclaw_submit_qr_result_v1
openclaw_ingest_inbound_batch_v1
openclaw_claim_inbound_automation_v1
openclaw_complete_inbound_automation_v1
openclaw_claim_outbox_v1
openclaw_preflight_outbox_v1
openclaw_authorize_outbox_send_v1
openclaw_requeue_pre_handoff_v1
openclaw_complete_outbox_v1
openclaw_claim_work_item_v1
openclaw_complete_work_item_v1
openclaw_create_outbox_from_work_v1
openclaw_issue_media_ticket_v1
openclaw_complete_retention_quarantine_v1
openclaw_authorize_retention_delete_v1
openclaw_finalize_retention_delete_v1
openclaw_ack_audit_anchor_v1
openclaw_acquire_cell_lease_v1
openclaw_begin_cell_rebind_v1
openclaw_complete_cell_rebind_v1
openclaw_ack_generation_revocation_v1
openclaw_record_watchdog_health_v1
openclaw_begin_rollout_v1
openclaw_record_rollout_checkpoint_v1
openclaw_record_rollout_observation_v1
openclaw_resume_rollout_v1
openclaw_advance_rollout_stage_v1
openclaw_begin_smoke_run_v1
openclaw_record_smoke_observation_v1
openclaw_cleanup_smoke_run_v1
openclaw_verify_smoke_cleanup_v1
openclaw_sweep_runtime_v1
```

Require these exact public service facades, executable only by `service_role`, with no direct canonical table grants:

```text
openclaw_service_runtime_heartbeat_v1
openclaw_service_exchange_runtime_credential_v1
openclaw_service_exchange_maintenance_credential_v1
openclaw_service_submit_qr_result_v1
openclaw_service_ingest_inbound_batch_v1
openclaw_service_claim_inbound_automation_v1
openclaw_service_complete_inbound_automation_v1
openclaw_service_claim_outbox_v1
openclaw_service_preflight_outbox_v1
openclaw_service_authorize_outbox_send_v1
openclaw_service_requeue_pre_handoff_v1
openclaw_service_complete_outbox_v1
openclaw_service_claim_work_item_v1
openclaw_service_complete_work_item_v1
openclaw_service_create_outbox_from_work_v1
openclaw_service_issue_media_ticket_v1
openclaw_service_complete_retention_quarantine_v1
openclaw_service_authorize_retention_delete_v1
openclaw_service_finalize_retention_delete_v1
openclaw_service_ack_audit_anchor_v1
openclaw_service_acquire_cell_lease_v1
openclaw_service_begin_cell_rebind_v1
openclaw_service_complete_cell_rebind_v1
openclaw_service_ack_generation_revocation_v1
openclaw_service_record_watchdog_health_v1
openclaw_service_begin_rollout_v1
openclaw_service_record_rollout_checkpoint_v1
openclaw_service_record_rollout_observation_v1
openclaw_service_resume_rollout_v1
openclaw_service_advance_rollout_stage_v1
openclaw_service_begin_smoke_run_v1
openclaw_service_record_smoke_observation_v1
openclaw_service_cleanup_smoke_run_v1
openclaw_service_verify_smoke_cleanup_v1
openclaw_service_sweep_runtime_v1
```

Edge calls only these public facades. Each facade validates a trusted principal/envelope, switches only into the narrow writer role needed for that operation, then invokes the same-suffix `app_private.openclaw_*_v1` helper. Static and live ACL tests prove `anon`, `authenticated`, ordinary `service_role` DML, and the wrong writer role cannot reach canonical rows.

Tests must assert request/response fields against `OutboxClaim`, `OutboundAuthorizationMarker`, `OutboxCompletionV1`, `OutboxPreHandoffRequeueV1`, `OpenClawUnknownResolutionRequestV1`, `OpenClawUnknownResolutionV1`, `OpenClawSendWorkClaimV1`, `OpenClawMaintenanceWorkClaimV1`, `OpenClawWorkCompletionRequestV1`, `OpenClawWorkCompletionResultV1`, `RetentionDeleteAuthorizationV1`, `RetentionDeleteReceiptV1`, `AuditAnchorReceiptV1`, rollout/smoke contracts, and every discriminated send/maintenance payload. SQL payload validation and chunk construction enforce exactly 2,000 Unicode code points per text chunk with astral/combining golden vectors shared with Task 2's installed vendored fork and Task 18's JavaScript renderer. Every public writer must accept a `p_client_operation_id`, derive actor/org from `auth.uid()` and trusted rows, lock the organization, call `require_perm_v1`, validate expected versions, append audit, and return compact JSON.

- [ ] **Step 2: Run the tests and verify failure**

Run: `npx vitest run src/lib/__tests__/openclawRpcSurfaceMigration.test.ts`

Expected: FAIL because the RPC migration is absent.

- [ ] **Step 3: Implement the browser read/write RPCs**

Use this common writer skeleton in every security-definer function:

```sql
DECLARE
  v_actor uuid := (select auth.uid());
  v_org uuid := p_organization_id;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION USING ERRCODE = '42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(v_org);
  PERFORM app_private.require_perm_v1(v_org, 'openclaw_zalo.manage_operations');
  PERFORM app_private.assert_openclaw_client_operation_v1(v_org, v_actor, p_client_operation_id, p_payload_hash);
  -- lock trusted rows, validate versions, mutate one bounded aggregate, append audit
  RETURN jsonb_build_object('ok', true, 'organization_id', v_org);
END;
```

Use action-specific checks rather than always requiring `manage_operations`: `send` for manual intent, `manage_connections` for QR/disconnect, `manage_automation` for automation/schedule/group changes, `manage_knowledge` for knowledge publishing, `manage_handoff` for takeover/resume except that the currently assigned active user may take over their own assigned conversation without that elevated action, `audit` for audit/health projections, and `manage_operations` for kill switches/UNKNOWN/dead-letter/retention operations. Legal-hold create/release additionally requires that the actor is an active organization owner and simultaneously holds both `audit` and `manage_operations`; the server rechecks all three conditions under the organization lock.

`openclaw_list_messages_v1` must implement the approved bounded cursor `(received_at,id)`, selected columns, and `limit <= 100`; provider timestamps are display-only. `openclaw_list_unknown_v1` returns a bounded selected-column operations projection with the historical UNKNOWN evidence plus nullable immutable resolution metadata/new-outbox reference; it never rewrites the original delivery state. `openclaw_get_overview_v1` reports unresolved UNKNOWN and resolved UNKNOWN as separate counts. No RPC returns QR ciphertext, session credentials, runtime credential hashes, raw provider attempts, or unrestricted knowledge text.

- [ ] **Step 4: Implement claim, preflight, complete, and UNKNOWN CAS**

`20260727060000_openclaw_rpc_surface.sql` owns the first executable atomic inbound ingest boundary because Tasks 5 and 7 schemas now both exist. `openclaw_service_ingest_inbound_batch_v1` and `app_private.openclaw_ingest_inbound_batch_v1` lock the account plus every supplied stable identity in deterministic kind/value order. They enforce event-ID primary/message-ID secondary precedence, atomically persist both-present pair mappings, accept exact kind/pair/payload replay, reject cross-kind/pair/payload conflicts with quarantine + collision audit, isolate identical IDs across accounts, and permit fallback fingerprint only when both stable IDs are null. The same transaction commits normalized event, message, conversation/unread update, one immutable automation decision, and either one `INBOUND_AUTOMATION` send-work item or one explicit no-send/recovery outcome before the bridge may acknowledge its spool. `HISTORY_SYNC`, sales-group chatter, disabled modes, duplicates, and ineligible targets persist no-send outcomes. Crash injection and replay tests prove there is no message-without-identity/decision/work-or-recovery window, no reference to delivery tables before migration `20260727040000`, and no duplicate auto-reply.

`openclaw_claim_outbox_v1` uses `FOR UPDATE SKIP LOCKED` and updates one row atomically from `QUEUED` to `LEASED`, incrementing `claim_generation`. An expired `LEASED` row is reclaimable only by a CAS that confirms the current fencing token, clears the old claim token, increments generation, and then issues a new token; stale workers cannot revive it. `openclaw_preflight_outbox_v1` re-evaluates the exact precedence and recomputes `CanonicalSendPayloadV1` while the row remains `LEASED`; it creates a short-lived unconsumed authorization row and returns the DB-minted marker. The runtime Edge route transports that marker; the bridge does not invent it. Only `openclaw_authorize_outbox_send_v1` may atomically consume the marker and transition `LEASED -> DISPATCHING` immediately before the first possible provider handoff.

`openclaw_authorize_outbox_send_v1` runs only from the vendored fork's `zalouser.bridge.send` context and accepts `OutboxAuthorizeSendRequestV1`, which contains the complete marker plus the bridge-injected private claim token. It compares `state='LEASED'`, the unexpired DB-time lease/marker, stored nonce hash, canonical payload hash, and current claim/session/fencing/control/takeover versions immediately before the first provider I/O; its single CAS consumes the nonce, records exactly one authorized handoff, and changes the row to `DISPATCHING`. Missing/deny/error/timeout/stale/replay/hash mismatch emits zero frames. `openclaw_complete_outbox_v1` and the sweeper contend on the same row lock. Completion may win after nominal lease expiry only while the row is still `DISPATCHING`, every claim/version field matches, and the recorded handoff belongs to that claim. If the sweeper already changed the row to `UNKNOWN`, completion is rejected and appended only as stale reconciliation evidence. `DISPATCHING` never returns to `QUEUED`; pre-handoff requeue applies only to `LEASED` rows with no consumed authorization.

`openclaw_requeue_pre_handoff_v1` accepts the exact `OutboxPreHandoffRequeueV1` shape and safely returns `LEASED -> QUEUED` only when no authorization was consumed, the caller holds the current claim, and the failure is proven pre-handoff; it clears the token and increments generation. The sweeper may reclaim expired `LEASED` rows to `QUEUED` with generation increment, but every expired or crashed `DISPATCHING` row moves to `UNKNOWN` because provider handoff may already have occurred.

`openclaw_resolve_unknown_v1` accepts `OpenClawUnknownResolutionRequestV1`, locks the historical outbox, requires `state='UNKNOWN'` plus `expected_resolution_version=0`, and inserts exactly one immutable `openclaw_unknown_resolutions` row. `CONFIRMED_SENT` and `CONFIRMED_FAILED` require `newIntent=null` and record operator evidence without rewriting delivery state. `NEW_INTENT_CREATED` requires the exact new-intent reference, locks/rechecks the trusted draft/target/current policy, atomically creates a distinct outbox intent, and stores its ID in the resolution row; it never reuses or retries the ambiguous provider handoff. Same `p_client_operation_id` plus same request after a lost response returns the existing `OpenClawUnknownResolutionV1`; same operation ID/different request fails, while a genuinely different concurrent resolution loses with `40001` and the UI reloads the winning metadata.

Background work claim/complete uses the same DB-time lease/CAS/reclaim pattern but separates `OpenClawSendWorkKind` from `OpenClawMaintenanceWorkKind`. Inbound/schedule/CRM claims are account/cell-bound and require `work.claim`/`work.complete`. Retention/audit claims bind the organization maintenance principal, maintenance credential generation, maintenance lease, and maintenance fencing token, require `maintenance.claim`/`maintenance.complete`, and do not require a current Zalo account/cell/session. Cross-principal, cross-organization, stale-credential, stale-lease, and stale-fencing claims fail before mutation. `openclaw_create_outbox_from_work_v1` locks the send work item and trusted target, rechecks the full policy precedence plus inbound/schedule/subscription/campaign/automation/template/group/consent/suppression/session/control/takeover/fencing versions, re-renders the canonical payload from frozen inputs, and atomically inserts one outbox row plus consumes the work item; any stale bridge decision rolls back both. Schedule uniqueness includes schedule/version/occurrence/target; CRM uniqueness additionally includes subscription ID/version so two matching subscriptions remain distinct. Same source key/different payload fails and audits the collision.

For retention, `QUARANTINE` completion is DB-only: it revokes content access, records the tombstone and seven-day `final_delete_not_before`, and performs no R2 request. A separate deterministic `FINAL_DELETE` work item is materialized only after grace. Edge verifies the full gateway receipt signature/key generation and supplies a trusted verification result plus the full receipt to the public service facade. SQL recomputes the domain-separated receipt hash, compares every organization/maintenance-principal/work-claim/key/phase/status/ticket/proof claim with locked trusted rows, persists the exact receipt/JTIs/hash, and finalizes by CAS; it does not reimplement Ed25519 verification. Audit acknowledgement follows the same boundary. Matching completion replays idempotently and no SQL routine performs network I/O.

Rollout RPCs operate only on Task 7's canonical rollout/smoke tables. Begin pins reviewed SHA, migration-manifest SHA-256, upstream/patch/tgz hashes, exact artifact/image/package digests, project ref, and organization; checkpoint/observation calls accept only content-free trusted row IDs/hashes and DB-derived metric windows; resume returns the durable current stage/version after any process exit; advance performs expected-version CAS and enforces the exact stage order plus 48-hour shadow and 72-continuous-green LIMITED requirements. No rollout RPC synthesizes QR completion or inbound evidence, and smoke cleanup never releases organization-scoped `GLOBAL_STOP`.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npx vitest run src/lib/__tests__/openclawRpcSurfaceMigration.test.ts
node scripts/check-openclaw-isolation.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add supabase/migrations/20260727060000_openclaw_rpc_surface.sql src/lib/__tests__/openclawRpcSurfaceMigration.test.ts
git commit -m "feat(openclaw-zalo): them rpc version hoa cho control va outbox" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 10: Emit Typed CRM Occurrences Without Generic Webhooks

**Files:**
- Create: `supabase/migrations/20260727070000_openclaw_crm_event_sources.sql`
- Create: `src/lib/__tests__/openclawCrmEventSourcesMigration.test.ts`

- [ ] **Step 1: Write the failing CRM event tests**

Test these exact cases:

```text
INSERT lead without assignee -> event_type=lead_created_or_assigned, event_subtype=CREATED
INSERT lead with assignee -> one event_type=lead_created_or_assigned, event_subtype=CREATED occurrence whose frozen snapshot includes the assignee
UPDATE assigned_staff_id NULL -> value -> event_type=lead_created_or_assigned, event_subtype=ASSIGNED
UPDATE assigned_staff_id value -> different value -> event_type=lead_created_or_assigned, event_subtype=REASSIGNED
room update that ends AVAILABLE -> event_type=room_became_available, event_subtype=FINAL_STATUS_AVAILABLE
room AVAILABLE immediately reconciled to RESERVED -> zero occurrence
due FOLLOW_UP sweep repeated twice -> one event_type=sales_task_due, event_subtype=FOLLOW_UP_DUE occurrence
completed FOLLOW_UP -> zero occurrence
```

Assert `event_type` is always one of the three `OpenClawCrmEventType` values and transition labels exist only in `event_subtype`; no row may persist `CREATED`, `ASSIGNED`, `REASSIGNED`, `FINAL_STATUS_AVAILABLE`, or `FOLLOW_UP_DUE` as `event_type`. Add one composite CHECK allowing only these pairs: lead + `leads` + `CREATED|ASSIGNED|REASSIGNED`; room + `rooms` + `FINAL_STATUS_AVAILABLE`; sales task + `lead_activities` + `FOLLOW_UP_DUE`. CRM subscriptions use the same three-value `event_type` CHECK and cannot subscribe to a subtype as an event type. Each occurrence is unique on `(organization_id,event_type,source_table,source_id,source_version)`, carries the frozen source snapshot/hash used later by work materialization, derives org from trusted source rows, and cannot be created for PROD by automated test fixtures.

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run src/lib/__tests__/openclawCrmEventSourcesMigration.test.ts`

Expected: FAIL because the occurrence table and typed emitters are absent.

- [ ] **Step 3: Implement the lead emitter**

Add a narrow `AFTER INSERT OR UPDATE OF assigned_staff_id` trigger on `public.leads`. Emit canonical `event_type='lead_created_or_assigned'` into `openclaw_crm_event_occurrences` with a versioned event-specific allowlisted snapshot union and RFC8785 hash. Compute `snapshot_hash` as lowercase SHA-256 of `"ihome-openclaw-crm-snapshot-v1\0" + RFC8785_JCS(snapshotEnvelope)` and compute `source_version` from the immutable source identity/transition generation rather than mutable render-time fields. Persist `occurred_at` separately for ordering/audit. INSERT always uses `event_subtype='CREATED'`, including an already-assigned row, so it emits one occurrence rather than create-and-assign duplicates. A NULL-to-value update uses `ASSIGNED`; a value-to-different-value update uses `REASSIGNED`. Never emit from React `onSuccess`.

- [ ] **Step 4: Implement final room availability emission**

Extend the existing room reconciliation path so it re-reads the final persisted row after reservation reconciliation. Emit only `event_type='room_became_available'`, `event_subtype='FINAL_STATUS_AVAILABLE'` when the final row is `AVAILABLE` and the prior persisted state was not `AVAILABLE`. This prevents a false proactive message when a holding deposit immediately changes AVAILABLE to RESERVED.

- [ ] **Step 5: Implement the due follow-up sweeper**

Room and follow-up emitters use the same event-specific snapshot union/hash. Add an internal DB function scheduled every minute that selects bounded `lead_activities` rows where `activity_type='FOLLOW_UP'`, `scheduled_at <= statement_timestamp()`, and `completed_at IS NULL`, joins the parent lead for organization, and inserts `event_type='sales_task_due'`, `event_subtype='FOLLOW_UP_DUE'` occurrences with `ON CONFLICT DO NOTHING`. Its event-stable generation is the activity ID plus the persisted canonical scheduled instant and schedule revision; it never hashes the sweep clock. `occurred_at` is the persisted scheduled instant. Repeated/concurrent sweeps, timezone normalization, reschedule revisions, and completion racing the sweep are mandatory tests.

- [ ] **Step 6: Run the focused suite**

Run: `npx vitest run src/lib/__tests__/openclawCrmEventSourcesMigration.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add supabase/migrations/20260727070000_openclaw_crm_event_sources.sql src/lib/__tests__/openclawCrmEventSourcesMigration.test.ts
git commit -m "feat(openclaw-zalo): map crm events typed va idempotent" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 11: Publish Safe Realtime Tables And DB Maintenance Jobs

**Files:**
- Create: `supabase/migrations/20260727080000_openclaw_realtime_allowlist.sql`
- Create: `supabase/migrations/20260727090000_openclaw_maintenance_jobs.sql`
- Create: `supabase/migrations/20260727095000_openclaw_activation_guards.sql`
- Create: `src/lib/__tests__/openclawRealtimeMaintenanceMigration.test.ts`

- [ ] **Step 1: Write failing publication and maintenance tests**

Require an advisory-locked, additive publication allowlist containing only safe account-health, conversation, conversation-member, message, and message-media metadata projections with explicit column lists verified through `pg_publication_columns`. Assert that QR challenges, runtime secrets, message text/body, prompts, object keys, policy evidence, raw attempts, outbox internals, audit raw, and retention holds are not published. Any public projection view must set `security_invoker=true` and pass `node scripts/check-view-invoker.mjs` after creation or replacement.

Require DB-time expiry for QR, safe expired-lease reclaim, authorized-handoff-aware `DISPATCHING` sweep, dead-letter materialization, schedule occurrence materialization, CRM occurrence fan-out, two-phase retention work, audit-root work, and due-event sweep. Every DB job must be internal-only and revoked from `anon` and `authenticated`. The tests must cover duplicate cron invocations, concurrent materializers, schedule-version edits, UTC/local timezone conversion, DST gap/fold golden vectors, missed occurrences persisted as `SKIPPED_MISSED`, and the rule that no missed occurrence is automatically caught up.

Retention job tests must assert a deterministic QUARANTINE item completes through a DB-only CAS, revokes content/browser ticket issuance, records DB-derived access/tombstone evidence, and sets `final_delete_not_before = DB now()+7 days` without any R2 dependency. Duplicate cron/concurrent completion creates one quarantine result; a legal hold before the quarantine CAS blocks it. A distinct FINAL_DELETE item is neither materialized nor claimable before grace, and duplicate materializers create only one after grace.

Activation-guard tests own `20260727095000_openclaw_activation_guards.sql` and prove the entire 12-migration chain remains inert after schema apply: every automated feature/mode defaults false; no account/cell/runtime/maintenance credential is synthesized; QR, automation publish, proactive/group activation, and rollout-stage advancement fail unless exact reviewed artifact/migration evidence and prior canonical checkpoints exist. The guards preserve organization-scoped `GLOBAL_STOP`, never reinterpret UNKNOWN as retryable, and permit no legacy Zalo access.

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run src/lib/__tests__/openclawRealtimeMaintenanceMigration.test.ts`

Expected: FAIL because the publication and jobs are absent.

- [ ] **Step 3: Implement the allowlist**

Use `pg_advisory_xact_lock`, idempotent `pg_publication_tables` checks, and explicit publication column lists validated through `pg_publication_columns`. Publish only safe invalidation metadata tables/projections; set replica identity only where cursor invalidation requires it and never publish sensitive columns.

- [ ] **Step 4: Implement maintenance jobs and retention**

Use UTC pg_cron wrappers only for local DB work. `app_private.materialize_openclaw_schedule_work_v1` locks each due schedule/version, compares the persisted `next_run_at`, creates exactly one occurrence, and atomically advances `next_run_at` from the immutable local recurrence rule/timezone. DST gap times advance to the next valid local instant; repeated-fold times choose the earlier offset unless the schedule explicitly stores the later-offset policy. If downtime places an occurrence outside its allowed grace window, persist `SKIPPED_MISSED`, advance to the first future occurrence, and never catch up automatically. Recurring-series edits create a new schedule version and cannot rewrite prior occurrence IDs.

`app_private.materialize_openclaw_crm_work_v1` expands each unconsumed typed CRM occurrence across every matching active subscription/campaign/exact target. It preserves the canonical three-value `event_type`, separate `event_subtype`, source table/ID/version, and frozen source snapshot/hash. It creates one work item per `(organization_id,campaign_or_schedule_id,occurrence_id,target_id)` with frozen subscription, automation, template, knowledge, mapping, source, and target versions; a second subscription/target gets a distinct work item, while duplicate cron/event delivery cannot duplicate the same fan-out. Materialization does not render templates, call policy services, touch R2, or create an outbound send by itself.

Schedule, CRM, and inbound materializers resolve the organization's current active channel account/cell/credential/lease/fencing into non-null send-work columns. Retention and audit materializers instead resolve the organization maintenance principal/credential/lease/fencing and remain claimable when no active Zalo account exists, an account was replaced/removed, or the channel cell is offline. A stale principal records a defer reason; after credential/lease/fence rotation, `app_private.rebind_openclaw_unclaimed_work_v1` CAS-rebinds only unclaimed work to the new principal generation while preserving the deterministic source key and frozen business payload.

Name the retention routines exactly `app_private.materialize_openclaw_retention_quarantine_v1` and `app_private.materialize_openclaw_retention_final_delete_v1`. QUARANTINE immediately tombstones/redacts message text, AI drafts, and media object keys across read RPCs, direct authenticated SELECT projections, and Realtime metadata while preserving only the documented at-most-60-second residual lifetime of already-issued one-use read tickets. FINAL_DELETE materialization is suppressed by any legal hold created after quarantine but before grace expiry; releasing that hold creates exactly one deterministic final-delete item.

Add organization-scoped DB retention routines for message/draft content, knowledge source/version content, health telemetry, audit/control/policy evidence, and delivery attempts using the approved retention periods. Browser/runtime update/delete remains impossible; only a retention-writer facade may delete after expiry plus legal-hold checks, while evidence that the spec requires to survive remains append-only or externally anchored.

Retention is explicitly two phase. `QUARANTINE` is a DB-only maintenance completion: it locks the protected row, rechecks legal holds and `hold_version`, revokes browser/content access, records the tombstone, and starts an exact seven-day grace through `final_delete_not_before`; it does not issue an R2 ticket, call the gateway, return an object-delete status, or physically delete bytes. After grace, a separate deterministic `FINAL_DELETE` work item is materialized only when no legal hold covers the content/media/evidence.

R2 final deletion remains outside SQL. Maintenance-route final-delete ticket issuance and `openclaw_authorize_retention_delete_v1` both lock the protected row, compare `hold_version`, recheck grace and holds, and bind the exact maintenance work claim; legal-hold creation takes the same lock, increments `hold_version`, and revokes every unconsumed delete authorization. The five-second authorize-delete CAS is the deletion linearization point: a hold committed after work claim or ticket issuance but before this CAS wins and blocks R2 deletion. `DELETE /v1/object` returns a signed `RetentionDeleteReceiptV1` bound to the exact organization/maintenance-principal/maintenance-lease/work item/claim generation/fencing/key/phase/status/delete-ticket JTI/delete-authorization JTI. The gateway's `TicketState` persists that receipt before responding and idempotently replays the same receipt after a lost response. Edge verifies the full signed receipt, gateway key generation, exact claims, and receipt hash before `openclaw_finalize_retention_delete_v1`; forged, mismatched, replayed-to-another-claim, `NOT_FOUND`, and lost-response cases are covered. `NOT_FOUND` is idempotent success only when authenticated by the matching signed receipt. Tests pause at barriers after claim, ticket issuance, and before final authorize-delete, create a legal hold, and prove no physical delete occurs; they also prove an authorization that wins the row lock is serialized before a later hold request and leaves complete audit evidence.

Apply the exact retention contract: message/conversation content and saved AI drafts 180 days; active conversation metadata retained while needed; active published knowledge/template/automation plus 365 days after archive; consent/suppression/risk evidence for the active lifetime plus at least 365 days after removal or last send; audit/policy/control/delivery/UNKNOWN/security evidence and daily anchors 365 days; redacted QR metadata seven days; connection/runtime health 90 days; media 90 days plus seven-day delete grace; local logs 14 days/1 GiB.

The daily DB job computes the per-organization audit root using the canonical audit-root schema/golden vectors and creates an `AUDIT_ANCHOR` work item with a deterministic anchor key. The maintenance worker requests `/v1/maintenance/media/upload-ticket` with `operation='anchor'`, signs the root with the external audit key, and uploads through the immutable no-overwrite R2 path. The gateway independently verifies root hash, signature, signing-key generation, size, and exact key before storage. After upload, the worker requests `/v1/maintenance/media/verify-ticket` with `operation='anchor_verify'` and presents it to `/v1/object/verify`; the gateway consumes its one-use JTI and returns the full signed `AuditAnchorReceiptV1` containing that JTI. The gateway persists/replays the same receipt for the same exact verification after a lost response. The worker submits the complete receipt plus its canonical hash to `/v1/maintenance/work/complete`; Edge verifies the gateway signature/key generation, verify-ticket JTI, and exact organization/maintenance-principal/maintenance-lease/fencing/work claim/root/hash/key/audit-signing claims before `app_private.openclaw_ack_audit_anchor_v1` atomically sets `anchored_at` plus completes the maintenance work item. An expired/replayed-to-another-operation/wrong-key verify ticket, forged receipt, hash-only evidence, receipt from another work claim/root/key, or stale signing generation fails closed. A lost DB response retries the same deterministic key: R2 no-overwrite plus `HEAD` verification returns the existing matching anchor and never creates an orphan duplicate. Retention and audit never use channel-account/cell routes or claims.

- [ ] **Step 5: Implement activation guards**

`20260727095000_openclaw_activation_guards.sql` runs last and owns only additive fail-closed guards. It verifies the expected 12-migration schema shape, keeps all automation/proactive/group flags false by default, prevents connection/activation/rollout advancement without Task 7 rollout evidence and current credential/lease/fence prerequisites, and adds no network behavior or production fixture. Its functions follow the same fixed-search-path/owner/grant rules and are exercised by `openclawRealtimeMaintenanceMigration.test.ts` plus Task 12's full manifest test.

Task 11's migration test owns only root/work materialization, activation guards, and SQL CAS/finalization with synthetic prevalidated receipt JSON. Task 12 owns receipt schemas/golden vectors and the complete 12-file manifest, Task 15 owns Edge signature/claim validation, Task 16 owns gateway issuance/persistence/replay, and Task 18 owns end-to-end runner orchestration; no migration test pretends to execute Worker cryptography.

- [ ] **Step 6: Run required migration checks**

Run:

```powershell
npx vitest run src/lib/__tests__/openclawRealtimeMaintenanceMigration.test.ts
node scripts/check-view-invoker.mjs
```

Expected: PASS; the view checker must report every public view with `security_invoker=true`.

- [ ] **Step 7: Commit**

```powershell
git add supabase/migrations/20260727080000_openclaw_realtime_allowlist.sql supabase/migrations/20260727090000_openclaw_maintenance_jobs.sql supabase/migrations/20260727095000_openclaw_activation_guards.sql src/lib/__tests__/openclawRealtimeMaintenanceMigration.test.ts
git commit -m "feat(openclaw-zalo): gioi han realtime va maintenance" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 12: Add Shared Contracts, Type Generation, And SQL Harnesses

**Files:**
- Create: `contracts/openclaw-zalo/{control,runtime,inbound,maintenance,media,receipts,policy,state-machine,audit}.schema.json`
- Create: `contracts/openclaw-zalo/golden-vectors.json`
- Create: `src/lib/__tests__/openclawZaloMigrations.test.ts`
- Create: `scripts/test-openclaw-migrations.mjs`
- Create: `scripts/test-openclaw-sql.mjs`
- Create: `scripts/test-openclaw-concurrency.mjs`
- Create: `scripts/__tests__/openclaw-sql-harness.test.mjs`
- Create: `scripts/__tests__/openclaw-concurrency-harness.test.mjs`
- Modify: `scripts/gen-supabase-types.mjs`
- Modify: `scripts/__tests__/gen-supabase-types.test.ts`
- Modify: `package.json`
- Modify: `src/integrations/supabase/types.ts` by `npm run gen:types`

- [ ] **Step 1: Write failing contract and harness tests**

Require schema validation and cross-runtime golden vectors for QR, runtime envelope and operation scopes, media tickets, policy decisions, `CanonicalSendPayloadV1`/payload hash, `OutboxClaim`, `OutboundAuthorizationMarker`, `OutboxCompletionV1`, `OutboxPreHandoffRequeueV1`, every send/maintenance claim and completion request/result variant, `OpenClawUnknownResolutionRequestV1`, `OpenClawUnknownResolutionV1`, `RetentionDeleteAuthorizationV1`, `RetentionDeleteReceiptV1`, `AuditAnchorReceiptV1`, rollout/checkpoint/observation/smoke-cleanup records, and canonical audit-root serialization/signature evidence. Receipt vectors bind the exact signing domain/version/kind, organization/maintenance-principal/fencing/work claim, key/phase/status/hold/quarantine/ticket/proof or root/verify-ticket/signing claims, gateway key generation, signature, and canonical receipt hash. `openclawZaloMigrations.test.ts` must manifest all twelve migration files, including `20260727095000_openclaw_activation_guards.sql`, and reject missing transactions, deny-by-default ACLs, composite tenant FKs, unsafe definer search paths, forbidden legacy identifiers, unsafe Realtime publication, or activation defaults that are not fail-closed. Harnesses fail before network access for a wrong project ref, PROD fixture, or possible secret output.

- [ ] **Step 2: Run the tests and verify failure**

Run:

```powershell
npx vitest run scripts/__tests__/openclaw-sql-harness.test.mjs scripts/__tests__/openclaw-concurrency-harness.test.mjs
```

Expected: FAIL because the scripts and golden vectors are absent.

- [ ] **Step 3: Implement DEMO-only rollback harnesses**

Use these constants exactly:

```js
const EXPECTED_PROJECT_REF = "tryymsxyyckgbrmmvozx";
const DEMO_ORG_ID = "dddd0000-0000-4000-8000-000000000001";
const PROD_ORG_ID = "aaaa0000-0000-4000-8000-000000000001";
```

`test-openclaw-sql.mjs --local` executes the rollback-only two-org authorization matrix against the disposable local database: inactive/revoked membership, mixed permissions, wrong account, composite-FK violations, QR uniqueness, outbox/work claim/CAS, marker mint/consume/TTL, exact completion/requeue serialization, atomic inbound message/decision/work-or-recovery commit, work-to-outbox atomic rollback, stale policy rejection, audit immutability/full-receipt anchor acknowledgement, retention hold-version/full-receipt checks, rollout-stage CAS, and safe publication. It proves schedule/CRM versus maintenance operation scopes, non-null account/cell/fencing claims, maintenance while channel-paused, and cross-account/cross-organization/stale-credential negatives.

The separately protected `--live-demo` mode uses the Management API only after validating project ref `tryymsxyyckgbrmmvozx`, confirming DEMO organization `dddd0000-0000-4000-8000-000000000001`, and proving the 12-file schema manifest is already applied by Task 29. It runs only rollback-only DEMO fixtures, never applies a migration, never writes the PROD organization, and is not executed anywhere in Task 12 or pull-request CI.

`test-openclaw-concurrency.mjs` must run bounded concurrent outbox/work claim, expired-lease reclaim, fencing, pre-handoff requeue, one immutable UNKNOWN resolution winner with the old state still `UNKNOWN`, duplicate schedule cron, CRM fan-out/idempotency, and both retention CAS races. It must prove QUARANTINE is DB-only and R2-outage-independent, sets `final_delete_not_before = DB now()+7 days`, duplicate/concurrent materializers create one phase item, no FINAL_DELETE claim/ticket/proof/delete is possible before grace, a hold before quarantine CAS blocks access revocation, and a hold before final authorize-delete blocks physical deletion. It also covers signed delete receipt forgery, authenticated `NOT_FOUND`, lost gateway response replaying the same receipt, lost DB finalization, forged/cross-claim audit receipts, and lost audit acknowledgement, then cleans every DEMO marker in `finally`.

`test-openclaw-migrations.mjs` must create a disposable local Supabase database with CLI `2.109.1`, run `supabase db reset --local` to apply the complete migration chain, execute migration smoke assertions, then prove the OpenClaw rollout rollback contract through forward corrective/inert behavior rather than dropping evidence tables. It must never connect to the linked production database.

Add a read-only `--schema-drift --project-ref PROJECT_REF --reviewed-sha REVIEWED_SHA` mode for Task 29. It compares the remote migration identity, public view invoker settings, function owner/search-path/grants, generated-type shape, activation defaults, and the recorded 12-file SHA-256 manifest without applying SQL or writing organization fixtures; any mismatch exits non-zero with a forward-corrective-only instruction.

- [ ] **Step 4: Validate the additive disabled foundation locally and regenerate types**

After local/static tests are green, apply the migration chain only to a disposable local Supabase instance. Task 12 must not call the Management API, mutate the shared DEMO/PROD project schema, or run the protected live-DEMO helper. Every new automated feature remains `feature_enabled=false`, browser DML remains revoked, and no runtime credential/cell exists. Task 29 alone applies the reviewed additive flags-off schema to the shared project, then runs the rollback-only live-DEMO matrix before any Edge/VPS/QR change.

```powershell
$migrations = @(
  '20260727010000_openclaw_catalog_foundation.sql',
  '20260727015000_openclaw_security_principals.sql',
  '20260727020000_openclaw_inbox_schema.sql',
  '20260727025000_openclaw_inbound_automation.sql',
  '20260727030000_openclaw_policy_automation_knowledge.sql',
  '20260727040000_openclaw_delivery_audit_ops.sql',
  '20260727050000_openclaw_access_policies.sql',
  '20260727060000_openclaw_rpc_surface.sql',
  '20260727070000_openclaw_crm_event_sources.sql',
  '20260727080000_openclaw_realtime_allowlist.sql',
  '20260727090000_openclaw_maintenance_jobs.sql',
  '20260727095000_openclaw_activation_guards.sql'
)
foreach ($migration in $migrations) {
  node scripts/test-openclaw-migrations.mjs --local-file "supabase/migrations/$migration"
  if ($LASTEXITCODE -ne 0) { throw "Local migration failed: $migration" }
}
$env:SUPABASE_TYPES_SOURCE = 'local'
npm run gen:types
Remove-Item Env:SUPABASE_TYPES_SOURCE
```

Extend `scripts/gen-supabase-types.mjs` with a tested `SUPABASE_TYPES_SOURCE=local` mode that invokes pinned Supabase CLI `2.109.1` with `gen types typescript --local --schema public`, requires no PAT, preserves the generated header, and still writes atomically. The default mode remains project-backed for Task 29 post-apply drift verification. Do not use `supabase db push` or any Management API call in Task 12. Any shared-project apply belongs only to Task 29 after the reviewed-SHA gate; if it fails, stop and use a forward corrective migration without dropping evidence tables.

- [ ] **Step 5: Add package scripts**

Add:

```json
"test:openclaw:services": "node -e \"const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}\" && npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run verify:upstream && npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run vendor:prepare && npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run typecheck && npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge test && npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run build && npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run pack && npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run verify:artifact && npm --prefix services/openclaw-zalo-cell/session-crypto run verify:dist && npm --prefix services/openclaw-zalo-cell/session-crypto test && npm --prefix services/openclaw-zalo-cell/session-crypto run typecheck && npm --prefix services/openclaw-zalo-bridge run build && npm --prefix services/openclaw-zalo-bridge test && npm --prefix services/openclaw-zalo-bridge run typecheck && npm --prefix services/openclaw-zalo-maintenance run build && npm --prefix services/openclaw-zalo-maintenance test && npm --prefix services/openclaw-zalo-maintenance run typecheck && npm --prefix services/openclaw-egress-broker run build && npm --prefix services/openclaw-egress-broker test && npm --prefix services/openclaw-egress-broker run typecheck && npm --prefix infra/openclaw-zalo-watchdog run build && npm --prefix infra/openclaw-zalo-watchdog test && npm --prefix infra/openclaw-zalo-watchdog run typecheck && vitest run supabase/functions/_shared/openclaw supabase/functions/openclaw-control supabase/functions/openclaw-qr supabase/functions/openclaw-runtime-token supabase/functions/openclaw-runtime supabase/functions/openclaw-object-tickets supabase/functions/openclaw-watchdog",
"test:openclaw:sql": "npm run test:openclaw:sql:local",
"test:openclaw:sql:local": "vitest run src/lib/__tests__/openclawZaloMigrations.test.ts scripts/__tests__/openclaw-sql-harness.test.mjs scripts/__tests__/openclaw-concurrency-harness.test.mjs && node scripts/test-openclaw-migrations.mjs --local && node scripts/test-openclaw-sql.mjs --local && node scripts/test-openclaw-concurrency.mjs --local",
"test:openclaw:sql:live-demo": "node scripts/test-openclaw-sql.mjs --live-demo && node scripts/test-openclaw-concurrency.mjs --live-demo",
"test:openclaw:r2": "npm --prefix infra/openclaw-media-gateway run build && npm --prefix infra/openclaw-media-gateway test && npm --prefix infra/openclaw-media-gateway run typecheck"
```

The type wrapper atomically writes the generated header and public types; never redirect stdout into `types.ts`. Run `npm run typecheck:baseline` and `npx tsc --noEmit -p tsconfig.app.json` after generation.

- [ ] **Step 6: Run the harnesses**

Run:

```powershell
npx vitest run scripts/__tests__/openclaw-sql-harness.test.mjs scripts/__tests__/openclaw-concurrency-harness.test.mjs src/lib/__tests__/openclawZaloMigrations.test.ts
npm run test:openclaw:sql
node scripts/check-view-invoker.mjs
```

Expected: static/local tests PASS with disposable local fixtures only; no network or shared-project mutation occurs, and `test:openclaw:sql` never invokes the protected live-DEMO helper.

- [ ] **Step 7: Commit**

```powershell
git add contracts/openclaw-zalo src/lib/__tests__/openclawZaloMigrations.test.ts scripts/test-openclaw-migrations.mjs scripts/test-openclaw-sql.mjs scripts/test-openclaw-concurrency.mjs scripts/__tests__/openclaw-sql-harness.test.mjs scripts/__tests__/openclaw-concurrency-harness.test.mjs scripts/gen-supabase-types.mjs scripts/__tests__/gen-supabase-types.test.ts package.json src/integrations/supabase/types.ts
git commit -m "test(openclaw-zalo): them contract va sql harness demo" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 13: Build The Shared Edge Security Boundary

**Files:**
- Create: `supabase/functions/_shared/openclaw/{deps,constants,env,errors,http,cors,supabase,browser-auth,runtime-auth,crypto,redaction,object-tickets,types}.ts`
- Create: `supabase/functions/_shared/openclaw/{runtime-auth,redaction,object-tickets}.test.ts`
- Modify: `supabase/config.toml`
- Modify: `scripts/deploy-edge-fn.mjs`
- Create: `scripts/__tests__/deploy-openclaw-edge-bundle.test.mjs`
- Modify: `supabase/functions/README.md`

- [ ] **Step 1: Write failing auth-envelope and HTTP tests**

Test strict JSON content type, actual and declared byte limits, exact methods, Zod `.strict()`, request IDs, redacted errors, exact origin allowlist, `Vary: Origin`, browser JWT verification, runtime audience/operation/nonce/body-hash binding, five-minute token TTL, 60-second maximum request clock skew, and replay denial. The matrix distinguishes channel work from organization maintenance, rejects missing/wrong scope, and binds each request to its matching current principal/credential/lease/fencing token. The separate health circuit breaker still pauses outbound sending when measured runtime clock drift exceeds two seconds for two minutes.

Use a deterministic vector:

```ts
const envelope = {
  method: "POST",
  path: "/v1/outbox/claim",
  timestamp: 1785062400,
  nonce: "00000000-0000-4000-8000-000000000001",
  bodySha256: "0000000000000000000000000000000000000000000000000000000000000000",
  organizationId: DEMO_ORG_ID,
  accountId: "dddd1000-0000-4000-8000-000000000001",
  cellId: "dddd2000-0000-4000-8000-000000000001",
  operation: "outbox.claim",
};
```

Add a second golden envelope for `POST /v1/maintenance/work/claim` with `operation:'maintenance.claim'`, maintenance principal `dddd3000-0000-4000-8000-000000000001`, and a requested kind allowlist of only `RETENTION_DELETE|AUDIT_ANCHOR`; prove the same token cannot claim send work, and a `work.claim` token cannot claim maintenance.

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run supabase/functions/_shared/openclaw`

Expected: FAIL because shared modules do not exist.

- [ ] **Step 3: Implement the shared boundary**

Pin `npm:@supabase/supabase-js@2.81.1` and `npm:zod@3.25.76` in `deps.ts`. Browser auth must call `auth.getUser()` and treat organization IDs only as selectors; authorization remains in caller-scoped RPCs. Runtime auth verifies a per-cell credential exchange, issues a token with `exp-iat <= 300`, and consumes each nonce before DB mutation.

`runtime-auth.ts` derives the workload class from the exact route and claimed work kind; caller-provided scope names never widen access. Channel routes validate account/cell credential, lease, session and fencing. Maintenance routes validate the organization maintenance principal/credential/lease/fencing and remain independent of channel state. Cross-principal, cross-organization, disabled/revoked generation, expired lease, wrong cell for channel work, and stale fencing fail before nonce consumption or database mutation.

`redaction.ts` must remove Authorization, `claimToken`, `markerNonce`, `X-OpenClaw-Media-Ticket`, `X-OpenClaw-Delete-Authorization`, Supabase keys, Gateway tokens, cookies, IMEI, QR data URLs/ciphertext, model keys, R2 signatures/receipts, revocation signatures, and phone-number-like secrets from structured logs.

Extend `scripts/deploy-edge-fn.mjs` with `--include-shared openclaw`. In that mode, bundle paths are rooted at `supabase/functions`; the only initial entrypoint paths are `openclaw-control/index.ts`, `openclaw-qr/index.ts`, `openclaw-runtime-token/index.ts`, `openclaw-runtime/index.ts`, and `openclaw-object-tickets/index.ts`; and each multipart upload contains only its target function plus `_shared/openclaw/**`. Add a no-network unit test that proves all five mappings, shared imports, exclusion of other functions, UTF-8 preservation, PAT redaction, and correct `--no-verify-jwt` mapping.

- [ ] **Step 4: Version-control Edge JWT modes**

Add:

```toml
[functions.openclaw-control]
verify_jwt = true
[functions.openclaw-qr]
verify_jwt = true
[functions.openclaw-object-tickets]
verify_jwt = true
[functions.openclaw-runtime-token]
verify_jwt = false
[functions.openclaw-runtime]
verify_jwt = false
```

The two `verify_jwt=false` functions must reject browser `Origin` headers and complete custom auth before any database call.

- [ ] **Step 5: Document the OpenClaw Edge contract**

Update `supabase/functions/README.md` with the exact OpenClaw function matrix and deploy order: browser JWT functions (`openclaw-control`, `openclaw-qr`, `openclaw-object-tickets`), runtime custom-auth functions (`openclaw-runtime-token`, `openclaw-runtime`), shared bundle inclusion via `--include-shared openclaw`, required secret names without values, local test commands, and the rule that runtime functions reject browser origins and derive organization/account from the verified workload lease. Include the required deny/expired/cross-organization/replay/idempotency test cases and state that no function may log QR, session, model, workload, or R2 secrets.

- [ ] **Step 6: Run tests**

Run:

```powershell
npx vitest run supabase/functions/_shared/openclaw
npx vitest run scripts/__tests__/deploy-openclaw-edge-bundle.test.mjs
node scripts/check-openclaw-isolation.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add supabase/functions/_shared/openclaw supabase/functions/README.md supabase/config.toml scripts/deploy-edge-fn.mjs scripts/__tests__/deploy-openclaw-edge-bundle.test.mjs
git commit -m "feat(openclaw-zalo): tao edge security boundary" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 14: Implement Browser Control And One-Time QR Reveal

**Files:**
- Create: `supabase/functions/openclaw-control/{index,handler,schemas,handler.test}.ts`
- Create: `supabase/functions/openclaw-qr/{index,handler,schemas,handler.test}.ts`

- [ ] **Step 1: Write failing browser-control tests**

Cover disclosure acknowledgement, begin/refresh QR, disconnect, manual send intent, takeover, global stop/resume, automation/knowledge/group/schedule mutation routing, bounded UNKNOWN list projection, all three `OpenClawUnknownResolutionRequestV1` outcomes, lost-response idempotent replay, competing-resolution `40001`, wrong permission, revoked membership, foreign org, same idempotency key/different payload, and raw provider-error redaction. Assert UNKNOWN resolution never rewrites the historical delivery state and `NEW_INTENT_CREATED` returns the new outbox reference only after current policy/draft/target recheck. Disconnect tests must increment account session generation, send the signed media-gateway revocation update, retry idempotently after an injected gateway failure, keep the account `RECONNECT_REQUIRED`/paused until acknowledgement, and prove old QR/media/runtime tickets fail before a new QR challenge can be created.

QR tests must prove:

```text
issued_at + 120 seconds = expires_at
initiating user/session/org/account/browser nonce all match
every poll rechecks manage_connections
ciphertext is revealed once and cleared atomically
expired/refreshed/replayed challenge returns a stable error
response uses Cache-Control: no-store
QR content is never logged
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run supabase/functions/openclaw-control supabase/functions/openclaw-qr`

Expected: FAIL because handlers do not exist.

- [ ] **Step 3: Implement dependency-injected handlers**

`index.ts` only wires `Deno.serve`, environment, and clients. `handler.ts` accepts dependencies for clock, crypto, caller-scoped Supabase client, admin client, and logger. `openclaw-control` maps a strict `operation` enum to one exact RPC and never exposes a generic SQL/admin path.

`openclaw-qr` calls a service-only atomic consume function, decrypts AES-256-GCM ciphertext in memory, returns the PNG data URL once, zeroes references, and never includes it in analytics or error objects.

- [ ] **Step 4: Run tests**

Run: `npx vitest run supabase/functions/openclaw-control supabase/functions/openclaw-qr`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add supabase/functions/openclaw-control supabase/functions/openclaw-qr
git commit -m "feat(openclaw-zalo): them control api va qr mot lan" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 15: Implement Runtime Token And Runtime API

**Files:**
- Create: `supabase/functions/openclaw-runtime-token/{index,handler,schemas,handler.test}.ts`
- Create: `supabase/functions/openclaw-runtime/{index,handler,schemas,handler.test}.ts`

- [ ] **Step 1: Write failing runtime tests**

Cover credential exchange, disabled/revoked credential, stale clock, replay nonce, wrong audience/operation/org/account/cell, stale fencing/session/control/takeover version, heartbeat, encrypted QR submission, inbound batch dedupe, `OutboxClaim`, preflight marker mint, authorize-send with the complete marker contract and one-time expiry, `OutboxPreHandoffRequeueV1`, `OutboxCompletionV1`, every discriminated `/v1/work/claim`, `/v1/work/create-outbox`, and `/v1/work/complete` request/response, work lease reclaim, media/anchor upload ticket, FINAL_DELETE-only retention ticket plus authorize-delete, and lost-response idempotent audit/retention completion with full signed receipts.

The operation matrix tests prove send work requires `work.claim`/`work.complete` with a non-null matching organization/account/cell/fencing token, while retention/audit require `maintenance.claim`/`maintenance.complete` with a non-null matching organization/maintenance-principal/maintenance-lease/fencing token and no channel account/cell dependency. Maintenance succeeds with no active account and while the channel cell is offline; it fails for disabled/revoked maintenance credentials, expired maintenance leases, stale fencing, wrong principal/organization, or a send-work token. QUARANTINE accepts no gateway receipt; FINAL_DELETE and audit cover signature forgery, exact-claim mismatch, authenticated `NOT_FOUND`, replay, and lost-response recovery.

Inbound batches must reject `count > 100`, body size `> 256 KiB`, mixed org/account IDs, duplicate event IDs with different hashes, and any secret-like field.

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run supabase/functions/openclaw-runtime-token supabase/functions/openclaw-runtime`

Expected: FAIL because handlers do not exist.

- [ ] **Step 3: Implement runtime token exchange**

Expose two exchanges. Channel exchange binds a root-owned per-cell credential to `organization_id`, `account_id`, `cell_id`, `credential_generation`, channel lease/fencing, and explicit operations. Maintenance exchange binds an organization maintenance credential to `organization_id`, `maintenance_principal_id`, `credential_generation`, maintenance lease/fencing, and maintenance operations. Tokens live at most five minutes; every request revalidates the current enabled credential, live lease, and fencing generation. Rotation/lease transfer/fence increase invalidates old tokens and tickets immediately.

The exact work scope matrix is:

```text
work.claim        -> /v1/work/claim for INBOUND_AUTOMATION, SCHEDULE_OCCURRENCE, or CRM_EVENT
work.complete     -> /v1/work/create-outbox and /v1/work/complete for send-work kinds
maintenance.claim -> /v1/maintenance/work/claim for RETENTION_DELETE or AUDIT_ANCHOR
maintenance.complete -> /v1/maintenance/work/complete, maintenance media/anchor tickets, and FINAL_DELETE authorization
```

The server derives the required scope from the trusted claimed work kind and route; a caller cannot select a broader class in the JSON body.

- [ ] **Step 4: Implement runtime route allowlist**

Support only:

```text
POST /v1/heartbeat
POST /v1/qr/publish
POST /v1/qr/result
POST /v1/inbound/batch
POST /v1/outbox/claim
POST /v1/outbox/preflight
POST /v1/outbox/authorize-send
POST /v1/outbox/requeue
POST /v1/outbox/complete
POST /v1/work/claim
POST /v1/work/complete
POST /v1/work/create-outbox
POST /v1/media/upload-ticket
POST /v1/maintenance/work/claim
POST /v1/maintenance/work/complete
POST /v1/maintenance/media/upload-ticket
POST /v1/maintenance/media/verify-ticket
POST /v1/maintenance/retention/delete-ticket
POST /v1/maintenance/retention/authorize-delete
```

Every route verifies the canonical envelope and calls one public service-only facade from Task 9. The implementation contains a checked table `path -> operation -> principal audience -> strict request schema -> public facade -> private SQL helper`; any unmapped combination returns 404/403 before DB access. `/v1/outbox/requeue` accepts only `OutboxPreHandoffRequeueV1`; `/v1/outbox/complete` accepts only `OutboxCompletionV1`; `/v1/work/create-outbox` returns `OpenClawWorkCompletionResultV1` only after the single transaction inserts the outbox and completes send work.

`/v1/work/*` accepts only channel send-work claims. `/v1/maintenance/work/*` accepts only maintenance claims. QUARANTINE success contains only the expected hold version and returns SQL-derived redaction/tombstone/grace evidence. FINAL_DELETE carries the full signed `RetentionDeleteReceiptV1`; audit carries the full signed `AuditAnchorReceiptV1`. Edge validates canonical receipt hash, gateway signature/key generation, exact maintenance claim, and all phase/key/status/root claims before the public facade; SQL recomputes the hash/claim equality and performs CAS. Neither route can double-complete work.

`/v1/media/upload-ticket` handles channel media only. Maintenance upload/verify issues exact anchor tickets; `anchor_verify` is one-use, at most 60 seconds, and binds organization/maintenance principal/fencing/work claim/root/hash/key, with `AuditAnchorReceiptV1.verifyTicketJti` equal to the consumed JTI. Maintenance delete-ticket/authorize-delete accepts only grace-eligible FINAL_DELETE and returns `RetentionDeleteAuthorizationV1` with `exp <= min(iat+5 seconds, work lease expiry)`. External Zalo/model/R2 calls never occur inside SQL transactions.

- [ ] **Step 5: Run tests**

Run: `npx vitest run supabase/functions/openclaw-runtime-token supabase/functions/openclaw-runtime`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add supabase/functions/openclaw-runtime-token supabase/functions/openclaw-runtime
git commit -m "feat(openclaw-zalo): them runtime token va api hep" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 16: Build The Dedicated Private R2 Media Gateway

**Files:**
- Create: `supabase/functions/openclaw-object-tickets/{index,handler,schemas,handler.test}.ts`
- Create: `infra/openclaw-media-gateway/{package.json,package-lock.json,tsconfig.json,vitest.config.ts,wrangler.toml}`
- Create: `infra/openclaw-media-gateway/src/{index,env,ticket,ticket-state,object-key,media-policy,responses}.ts`
- Create: `infra/openclaw-media-gateway/src/handlers/{upload,read,verify,delete,revoke-generation}.ts`
- Create: `infra/openclaw-media-gateway/test/{fixtures,ticket,object-key.property,upload,read,verify,delete-retention,security}.test.ts`

- [ ] **Step 1: Write failing ticket and object tests**

Test ES256 signature, `aud='openclaw-media-gateway'`, `exp-iat <= 60`, one-use `jti`, exact organization/account/key/op binding, browser `user_id` plus Supabase `session_id` hash, exact access-token hash, and OpenClaw account `session_generation` for browser tickets, runtime cell/fencing/session generation for runtime tickets, browser/runtime generation revocation, replay, expired/wrong-user browser session, mismatched or refreshed browser token, wrong key, wrong tenant, declared/actual byte mismatch, SHA-256 mismatch, MIME/magic mismatch, decompression/dimension limits, active-content quarantine, partial upload, no-overwrite, read disposition, and browser-ticket rejection once DB quarantine revokes access. Already-issued read tickets remain bounded by their one-use `jti` and at most 60-second expiry; issuance stops immediately after quarantine.

Retention tests require `deletePhase='FINAL_DELETE'`, prior `quarantineVersion`, and `DB now() >= finalDeleteNotBefore`; they reject QUARANTINE tickets/proofs, pre-grace work, delete-ticket-without-authorization, five-second delete-proof expiry/replay/mismatch, and authorize-delete hold/version failure. `DELETE /v1/object` returns a full signed `RetentionDeleteReceiptV1` for both `DELETED` and authenticated `NOT_FOUND`; `DELETED` requires a non-empty captured R2 version/ETag, while `NOT_FOUND` requires null, and impossible combinations fail schema validation. `TicketState` atomically stores the exact receipt before responding and idempotently returns the same bytes/signature/hash for a repeated same ticket/proof/work claim after a lost response; forgery, cross-claim replay, and object-delete/DB-finalize recovery are mandatory tests. Anchor tests independently validate the canonical root vector, root hash, signature, verification-key generation, exact immutable key, no-overwrite behavior, one-use `anchor_verify` ticket expiry/replay/wrong-tenant/wrong-key rejection, full signed `AuditAnchorReceiptV1` including `verifyTicketJti`, exact-claim verification, and same-receipt retry after a lost gateway or DB acknowledgement. The internal revocation test must require a dedicated Ed25519-signed timestamp/nonce/body-hash envelope with audience `openclaw-media-revocation` and operation `generation.revoke`, reject browser origins and replay, monotonically raise the minimum valid `(organization_id,account_id,session_generation)`, and prove every older browser/runtime ticket is denied immediately after disconnect. Add a Wrangler contract test that requires the exact zone route and rejects `workers_dev=true`, a Worker custom domain, or any public R2 hostname.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm --prefix infra/openclaw-media-gateway test`

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Implement exact-key ticket issuance**

Browser sends only a canonical media row ID to `openclaw-object-tickets`; Edge derives organization/account/object key, verifies the current Supabase user/session, checks `openclaw_zalo.view` or the required write permission, rejects tombstoned/quarantined media, and binds the ticket to `sub`, SHA-256 of the JWT `session_id`, SHA-256 of the exact presented access token, and the current OpenClaw account `session_generation`. Browser gateway requests present the ticket in `X-OpenClaw-Media-Ticket` and the same current Supabase JWT in `Authorization`; the Worker verifies the JWT signature/expiry against the pinned Supabase JWKS, recomputes both hashes, checks `sub` and the Durable Object minimum session generation, consumes `jti`, and rejects expired, refreshed, foreign-user, missing-proof, or revoked-generation requests. Thus a stolen media ticket alone is unusable. Both sensitive headers are redacted.

Runtime media upload tickets are issued through `openclaw-runtime` and bind channel account/cell/fencing/session claims. FINAL_DELETE and audit-anchor tickets are issued through the maintenance routes and bind organization maintenance principal/credential/lease/fencing claims instead of a channel account/cell. `DELETE /v1/object` requires both a `deletePhase='FINAL_DELETE'` ticket and `X-OpenClaw-Delete-Authorization` containing the one-time five-second `RetentionDeleteAuthorizationV1` proof from `/v1/maintenance/retention/authorize-delete`; a delete ticket alone is never sufficient.

The Durable Object persists `AUTHORIZED -> DELETE_IN_PROGRESS -> RECEIPT_STORED` before responding. A crash before mutation resumes the stored authorization; a crash after possible mutation performs exact-key `HEAD`, derives authenticated `DELETED|NOT_FOUND` recovery evidence, stores the one canonical signed receipt, and never repeats an unsafe delete blindly. Inject crashes at every boundary in `delete-retention.test.ts`. `/v1/object/verify` uses the equivalent stored-receipt recovery path for `AuditAnchorReceiptV1`.

Every channel credential rotation, session-generation increase, cell lease transfer, or fencing increase, and every maintenance credential/lease/fencing rotation, sends the dedicated Ed25519-signed `POST /v1/internal/revoke-generation` request to the media gateway. Disconnect does not report complete until `TicketState` acknowledges the new minimum generation. If propagation fails, the account remains `RECONNECT_REQUIRED`, effective mode stays draft-only, retries are idempotent, and no new QR challenge is issued before acknowledgement.

Use this immutable key format:

```text
v1/org/{organizationId}/account/{accountId}/conversation/{conversationId}/message/{messageId}/media/{mediaId}/{variant}
```

Daily audit anchors use `v1/org/{organizationId}/audit/{utcDate}/{auditRootId}.json` and a distinct maintenance `anchor` operation. Braced identifiers are validated UUID/date fields from trusted rows, not caller-selected path fragments. No endpoint accepts a bucket name or arbitrary key, and every media/anchor upload is no-overwrite.

- [ ] **Step 4: Implement the Worker and Durable Object**

Expose only:

```text
PUT /v1/object
POST /v1/object/read
POST /v1/object/verify
DELETE /v1/object
POST /v1/internal/revoke-generation
GET /health
```

`TicketState` atomically consumes every browser/runtime `jti` and tracks the minimum valid account session generation plus revoked runtime cell/credential generations. The internal revocation route has no CORS, accepts only the dedicated Edge verification key/audience/operation, enforces 60-second skew and one-time nonce, and can only increase a generation. Bind `MEDIA` to a new bucket named `ihome-openclaw-media-private`; set `workers_dev=false`; configure the exact zone route `routes = [{ pattern = "openclaw-media.chillhome.io.vn/*", zone_name = "chillhome.io.vn" }]`; do not set `custom_domain=true`, do not expose an R2 development URL/custom domain, and do not enable public listing. Allow only exact CRM origins for browser reads. Responses use `private, no-store`, `nosniff`, and ticket-bound `Content-Disposition`.

The gateway package must define exact `build`, `test`, `typecheck`, and `deploy` scripts. `deploy` runs `wrangler deploy --minify --keep-vars` only after build/test/typecheck and emits a machine-readable Worker deployment version plus bundle SHA-256 for Task 29 verification; it never creates or exposes a public R2 endpoint.

- [ ] **Step 5: Run tests and typecheck**

Run:

```powershell
npm --prefix infra/openclaw-media-gateway ci
npm --prefix infra/openclaw-media-gateway run build
npm --prefix infra/openclaw-media-gateway test
npm --prefix infra/openclaw-media-gateway run typecheck
npx vitest run supabase/functions/openclaw-object-tickets
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add supabase/functions/openclaw-object-tickets infra/openclaw-media-gateway
git commit -m "feat(openclaw-zalo): them media gateway r2 private" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 17: Build The Bridge Package, Fake Adapter, And Durable Inbound Spool

**Files:**
- Create: `services/openclaw-zalo-bridge/{package.json,package-lock.json,tsconfig.json,vitest.config.ts,Dockerfile,README.md}`
- Create: `services/openclaw-zalo-bridge/src/bin/{bridge,fake-cell}.ts`
- Create: `services/openclaw-zalo-bridge/src/bridge/{server,inbound-controller}.ts`
- Create: `services/openclaw-zalo-bridge/src/runtime-api/{client,workload-auth,schemas}.ts`
- Create: `services/openclaw-zalo-bridge/src/adapters/channel-adapter.ts`
- Create: `services/openclaw-zalo-bridge/src/spool/{sqlite-spool,drain-worker,pressure,checksum}.ts`
- Create: `services/openclaw-zalo-bridge/src/spool/migrations/001_init.sql`
- Create: `services/openclaw-zalo-bridge/src/media/{inbound-fetch,redirect-policy,ip-policy,magic-byte,cache,temp-cleanup}.ts`
- Create: `services/openclaw-zalo-bridge/src/health/{heartbeat,circuit-breaker,snapshot}.ts`
- Create: `services/openclaw-zalo-bridge/src/security/{redact,secret-files}.ts`
- Create: `services/openclaw-zalo-bridge/src/testing/fake-zalo-adapter.ts`
- Create: `services/openclaw-zalo-bridge/test/{runtime-auth,spool-recovery,inbound-listener-ordering,inbound-drain,inbound-media,fencing,health}.test.ts`

- [ ] **Step 1: Write failing spool and adapter contract tests**

Test duplicate/out-of-order inbound and the complete stable-ID matrix: event ID only, message ID only, both present with immutable mapping, exact replay, mismatched pair, same stable ID/different payload, same ID reused across event kinds in one account, same textual ID across accounts/organizations without cross-dedupe, and fallback fingerprint only when both IDs are null with at-least-once collision telemetry. Also cover SQLite restart, corrupt checksum quarantine, Supabase outage/recovery, atomic canonical acknowledgement including the automation decision/work marker, media manifest committed with bytes `PENDING`, session kick, two-cell fencing, invalid runtime token, foreign org/account/cell, disabled credential, expired lease, stale fencing, omitted account/fencing, ENOSPC, and 80/95/100 percent pressure behavior. `inbound-listener-ordering.test.ts` drives the vendored `monitor.ts`/`zalo-js.ts` harness and proves the provider callback is void/non-awaited but the fork performs no OpenClaw dispatch/queue or built-in reply until the bridge returns WAL/FULL success. Bridge error/timeout/process crash/ENOSPC/corrupt acknowledgement leaves dispatch count zero and does not mark the internal listener successful.

The ordering suite then exercises successful WAL/FULL commit and downstream canonical outcomes `NO_SEND`, `HUMAN_DRAFT`, and `OUTBOX_CREATED`. After each outcome, built-in reply, pairing notification/business content, and direct provider-frame counters remain zero; even `OUTBOX_CREATED` is inert until Task 18 explicitly invokes authorized `zalouser.bridge.send`. The fake adapter exposes deterministic QR, directory, inbound, send success, provider reject, and ambiguous timeout outcomes. Maintenance authentication is tested in the dedicated maintenance package, not in the channel bridge.

Inbound-media tests cover exact HTTPS allowlists, redirect count and scheme/host revalidation at every hop, fresh DNS resolution plus connect-time IP pinning, denial of loopback/private/link-local/metadata/multicast/ULA/9Router/CLI addresses, declared and actual byte ceilings, MIME/magic mismatch, decompression/dimension bombs, checksum mismatch, partial downloads, aborts, and temporary-file cleanup on every success/error/restart path. Images at or below exactly 5 MiB may be automatically cached through the private gateway after verification; larger images and all other files remain metadata/on-demand only. No media fetch may bypass the egress broker or persist raw bytes in Supabase/SQLite beyond the bounded temporary workflow.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm --prefix services/openclaw-zalo-bridge test`

Expected: FAIL because the service package is absent.

- [ ] **Step 3: Implement SQLite WAL/FULL spool**

Initialize SQLite with:

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
```

The private bridge endpoint validates a cell-local mutually authenticated request, requires the complete raw + normalized envelope and media manifest, begins a SQLite transaction, writes canonical bytes/checksums/local sequence plus the exact primary/secondary stable-ID mapping, and commits with WAL/FULL durability before returning internal-listener success. The vendored fork awaits that response before any OpenClaw dispatch/queue; this is not a provider-level acknowledgement because the provider callback itself is void/non-awaited. Both-present mapping, kind and payload hash are immutable; mapping conflicts are quarantined/audited and never acknowledged as a duplicate. Fingerprint inputs exist only when both stable IDs are null. Each event also stores timestamps, retry count, media byte state, and canonical-ack state. Delete only after Supabase returns the atomic acknowledgement proving event/message/conversation plus automation decision/work-or-recovery marker committed together. Enforce 1 GiB or 24-hour maximum. At 80% pause outbound, history sync, and media prefetch; at 95% accept only the minimal inbound envelope; at 100% stop adapter intake when supported, append `INBOUND_GAP_STARTED`, preserve existing spool, alert P1, and surface `readyz=false`. Never drop the oldest text/event to preserve capacity.

- [ ] **Step 4: Implement runtime client and health**

Exchange the channel root credential for short-lived tokens, sign each envelope, rotate nonces, batch at most 100 events/256 KiB, and never log secrets. `/livez` checks the process only. `/readyz` exposes separate `inboundReady`, `outboundReady`, and `aiReady`: channel pause disables outbound, model-provider outage disables only AI-assisted automation, and neither state is used for maintenance readiness. Heartbeat every 30 seconds; stale after 90 seconds.

- [ ] **Step 5: Run tests and typecheck**

Run:

```powershell
npm --prefix services/openclaw-zalo-bridge ci
npm --prefix services/openclaw-zalo-bridge run build
npm --prefix services/openclaw-zalo-bridge test
npm --prefix services/openclaw-zalo-bridge run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
$task17Files = @(
  'services/openclaw-zalo-bridge/package.json',
  'services/openclaw-zalo-bridge/package-lock.json',
  'services/openclaw-zalo-bridge/tsconfig.json',
  'services/openclaw-zalo-bridge/vitest.config.ts',
  'services/openclaw-zalo-bridge/Dockerfile',
  'services/openclaw-zalo-bridge/README.md',
  'services/openclaw-zalo-bridge/src/bin/bridge.ts',
  'services/openclaw-zalo-bridge/src/bin/fake-cell.ts',
  'services/openclaw-zalo-bridge/src/bridge/server.ts',
  'services/openclaw-zalo-bridge/src/bridge/inbound-controller.ts',
  'services/openclaw-zalo-bridge/src/runtime-api/client.ts',
  'services/openclaw-zalo-bridge/src/runtime-api/workload-auth.ts',
  'services/openclaw-zalo-bridge/src/runtime-api/schemas.ts',
  'services/openclaw-zalo-bridge/src/adapters/channel-adapter.ts',
  'services/openclaw-zalo-bridge/src/spool/sqlite-spool.ts',
  'services/openclaw-zalo-bridge/src/spool/drain-worker.ts',
  'services/openclaw-zalo-bridge/src/spool/pressure.ts',
  'services/openclaw-zalo-bridge/src/spool/checksum.ts',
  'services/openclaw-zalo-bridge/src/spool/migrations/001_init.sql',
  'services/openclaw-zalo-bridge/src/media/inbound-fetch.ts',
  'services/openclaw-zalo-bridge/src/media/redirect-policy.ts',
  'services/openclaw-zalo-bridge/src/media/ip-policy.ts',
  'services/openclaw-zalo-bridge/src/media/magic-byte.ts',
  'services/openclaw-zalo-bridge/src/media/cache.ts',
  'services/openclaw-zalo-bridge/src/media/temp-cleanup.ts',
  'services/openclaw-zalo-bridge/src/health/heartbeat.ts',
  'services/openclaw-zalo-bridge/src/health/circuit-breaker.ts',
  'services/openclaw-zalo-bridge/src/health/snapshot.ts',
  'services/openclaw-zalo-bridge/src/security/redact.ts',
  'services/openclaw-zalo-bridge/src/security/secret-files.ts',
  'services/openclaw-zalo-bridge/src/testing/fake-zalo-adapter.ts',
  'services/openclaw-zalo-bridge/test/runtime-auth.test.ts',
  'services/openclaw-zalo-bridge/test/spool-recovery.test.ts',
  'services/openclaw-zalo-bridge/test/inbound-listener-ordering.test.ts',
  'services/openclaw-zalo-bridge/test/inbound-drain.test.ts',
  'services/openclaw-zalo-bridge/test/inbound-media.test.ts',
  'services/openclaw-zalo-bridge/test/fencing.test.ts',
  'services/openclaw-zalo-bridge/test/health.test.ts'
)
git add -- $task17Files
git commit -m "feat(openclaw-zalo): tao bridge va spool ben vung" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 18: Implement Policy Preflight, Outbox Dispatch, AI Draft, And Private ZaloUser Bridge RPC

Task 18 is strictly serial after Task 17: begin only after Task 17's exact-file commit exists and its bridge build/test/typecheck gate is green. It may modify the Task 17 bridge files listed below but must not retroactively add maintenance ownership or tests to Task 17.

**Files:**
- Modify: `services/openclaw-zalo-bridge/src/bin/bridge.ts`
- Modify: `services/openclaw-zalo-bridge/src/runtime-api/{client,schemas}.ts`
- Create: `services/openclaw-zalo-bridge/src/adapters/zalouser-bridge-rpc-adapter.ts`
- Create: `services/openclaw-zalo-bridge/src/outbox/{worker,state-machine,pre-dispatch,error-classifier}.ts`
- Create: `services/openclaw-zalo-bridge/src/jobs/{worker,inbound-automation-runner,schedule-runner,crm-event-runner,template-renderer}.ts`
- Create: `services/openclaw-zalo-bridge/src/ai/{cell-agent-client,content-policy,dlp,retrieval-context}.ts`
- Create: `services/openclaw-zalo-maintenance/{package.json,package-lock.json,tsconfig.json,vitest.config.ts,Dockerfile,README.md}`
- Create: `services/openclaw-zalo-maintenance/src/{main,runtime-client,retention-runner,audit-anchor-runner,health}.ts`
- Create: `services/openclaw-zalo-maintenance/test/{auth,retention,audit,recovery}.test.ts`
- Create: `services/openclaw-zalo-bridge/test/{outbox-dispatch,policy-preflight,ai-dlp,zalouser-bridge-rpc-adapter,background-jobs}.test.ts`

- [ ] **Step 1: Write failing dispatch and AI boundary tests**

Test the full policy precedence, quiet hours, consent, exact anti-spam ceilings, group allowlist/freshness, takeover, campaign cancellation, session/control/takeover version changes, RFC8785 send-hash golden vectors, DB-minted authorization nonce storage, marker TTL `<=15s` and `<=lease`, text chunking at exactly 2,000 Unicode code points, stable IDs only, expired `LEASED` reclaim, provider reject, proven pre-handoff failure requeue, post-handoff timeout to UNKNOWN, crash in DISPATCHING, completion after lease expiry/UNKNOWN rejection, stale authorization/completion, and no auto-retry UNKNOWN. Shared golden vectors must include astral emoji/combining sequences and prove JavaScript, SQL validation, and the installed vendored fork agree on code-point boundaries rather than UTF-16 units or UTF-8 bytes. Assert the platform ceiling is 1 outbound/3 seconds, burst 2, 30/hour, 200/day, 10 auto-replies/peer/hour, 100 recipients/approved batch, proactive 1/peer/day and 4/peer/month, quiet hours 20:00-08:00, and 72-hour warm-up caps at one-third with 3-8 second random auto-reply delay.

Background-job tests claim each send work type using the exact discriminated contract. `inbound-automation-runner` consumes the canonical decision/work item, calls the private OpenClaw cell `agent` RPC for structured classification/draft, applies deterministic DLP, then calls the completion RPC that atomically persists either a human-review draft, an ineligible/no-send result, or a guarded outbox. Schedule and CRM cases load immutable schedule/subscription/campaign/automation/template/knowledge/source/target versions. `template-renderer.ts` accepts only the frozen field mapping and allowlist, applies the specified missing-value rule, escapes control/markup characters deterministically, rejects unknown fields and over-limit output before chunking, and produces both `CanonicalSendPayloadV1` and the cross-runtime payload hash.

The schedule/CRM runners recheck current policy, group freshness/allowlist, consent, suppression, campaign cancellation, channel session/control/takeover, and fencing versions, then call `/v1/work/create-outbox`. Assert with DB-backed tests that a stale bridge decision cannot enqueue, that outbox insertion and work consumption commit or roll back together, and that repeated claims, duplicate cron, multiple matching subscriptions/targets, retries, or same keys create exactly the intended fan-out with no duplicate outbox.

The dedicated maintenance package tests organization-scoped credentials, no-active-account/account-replaced/channel-cell-offline success, wrong principal/scope, stale generation/lease/fence, and session independence. QUARANTINE calls only the maintenance completion route and performs no R2 request. FINAL_DELETE uses the exact ticket/proof and durable stored-receipt flow. Audit anchoring uses the maintenance principal and continues without a channel cell.

Audit tests compute the canonical DB root, sign with the external audit key, upload through a no-overwrite anchor ticket, independently verify hash/size/signature/key generation, require the full signed `AuditAnchorReceiptV1`, retry the same receipt/key after lost gateway or DB responses, reject forged/cross-claim receipts, acknowledge the anchor through work completion, and only then complete the work item. Retention/audit continue while only the Zalo channel session is paused, but stop on invalid maintenance credential, lease, or fencing.

AI tests must prove that only `CUSTOMER_SAFE` chunks enter customer-facing prompts; `INTERNAL_REVIEW_ONLY` is draft-review only; `RESTRICTED` never enters outbound generation. Generated output must pass DLP and content policy before an outbox intent can be created.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm --prefix services/openclaw-zalo-bridge test -- outbox-dispatch policy-preflight ai-dlp zalouser-bridge-rpc-adapter background-jobs
npm --prefix services/openclaw-zalo-bridge run typecheck
npm --prefix services/openclaw-zalo-maintenance test
npm --prefix services/openclaw-zalo-maintenance run typecheck
```

Expected: FAIL because the dispatch/AI modules and dedicated maintenance package are absent.

- [ ] **Step 3: Implement the private bridge RPC adapter and single-call dispatch**

The adapter uses ordinary cell control RPCs only for `web.login.start/wait`, `channels.status/start/stop/logout`, and toolless `agent`. Business delivery uses exactly one private `zalouser.bridge.send` request carrying the complete `CanonicalSendPayloadV1`, exact stable target ID, explicit account profile, canonical idempotency key, and complete short-lived runtime-minted `OutboundAuthorizationMarker`: outbox ID, claim generation, payload hash, fencing token, session generation, control version, takeover version, one-time marker nonce, and expiry. The stock generic `send` method is never used for business traffic and returns denied outside authorized fork context.

The fork constructs one exact ordered provider batch across text, media, chunks, link, and reaction before authorization, then calls `/v1/outbox/authorize-send` immediately before the first provider I/O. Missing authorization, deny, Edge/bridge error, timeout, stale marker, replay, or payload-hash mismatch produces zero provider frames. If every part succeeds, completion returns all provider message IDs in order. Any failure or disconnect after the first possible part handoff makes the entire outbox `UNKNOWN`; it is never retried automatically, even if later parts are known unsent.

The vendored fork calls `/v1/outbox/authorize-send` through the local bridge; that CAS rechecks every marker field, stored nonce hash, current DB-time lease, nonce freshness, and canonical payload hash. The fork denies generic `send`, message tool, pairing notification, direct adapter/tool calls, and any `send.ts`/`channel.adapters.ts`/`tool.ts` business path without the unforgeable context created by `zalouser.bridge.send`. Typing, seen, and delivery receipts use content-free control schemas and cannot carry text/media or mint authorization. Never enable name matching. No group chatter is routed into auto-reply.

Classify failures as:

```ts
type DispatchOutcome =
  | { kind: "SENT"; providerMessageIds: string[] }
  | { kind: "SAFE_RETRY"; reason: string }
  | { kind: "FAILED"; reason: string }
  | { kind: "UNKNOWN"; reason: string; providerMessageIds: string[] };
```

Only errors known to occur before adapter handoff are `SAFE_RETRY`. The worker serializes `OutboxPreHandoffRequeueV1` exactly and calls `/v1/outbox/requeue`; any timeout/disconnect after possible handoff is `UNKNOWN`. Terminal send results serialize every `OutboxCompletionV1` claim/version/hash/marker/evidence field exactly; omission or mismatch fails closed rather than being inferred by Edge.

- [ ] **Step 4: Implement the background work engine**

The bridge runs bounded workers for send work only. `inbound-automation-runner`, `schedule-runner`, and `crm-event-runner` validate their send-work claims, load frozen versions, call the private cell `agent` only where AI is required, re-evaluate current policy/group/consent/suppression/campaign/session/control/takeover/fencing state, and call the exact completion/create-outbox route; the service-only DB routine repeats authoritative checks and commits the outbox/work transition atomically.

The maintenance service runs `retention-runner` and `audit-anchor-runner` with its independent credential/lease/fence. QUARANTINE calls the maintenance DB-only completion branch. FINAL_DELETE obtains exact maintenance tickets/proofs, replays the stored receipt after any lost response, and submits the full receipt/hash/JTIs for Edge verification and SQL CAS. `audit-anchor-runner` signs the canonical root with the external audit key, uploads through immutable no-overwrite storage, requests `anchor_verify`, and completes with the stored signed receipt. Network calls remain outside SQL transactions.

- [ ] **Step 5: Implement constrained AI drafting**

The bridge calls the private OpenClaw cell `agent` RPC with a toolless, structured-output request; model credentials, provider transport, classification, and draft generation stay inside the cell. The provider base URL/key are dedicated to OpenClaw and never resolve through 9Router. The cell exposes a provider circuit state for timeout/quota/schema failures; opening it pauses AI-assisted automatic sends while manual non-AI sends remain available. The model receives text/context only and has no shell/browser/filesystem/SQL/arbitrary HTTP/direct channel-delivery tool. The bridge validates the strict result and applies deterministic DLP before the authoritative completion RPC. AI never writes the outbox directly.

- [ ] **Step 6: Run service tests**

Run:

```powershell
npm --prefix services/openclaw-zalo-bridge ci
npm --prefix services/openclaw-zalo-bridge run build
npm --prefix services/openclaw-zalo-bridge test
npm --prefix services/openclaw-zalo-bridge run typecheck
npm --prefix services/openclaw-zalo-maintenance ci
npm --prefix services/openclaw-zalo-maintenance run build
npm --prefix services/openclaw-zalo-maintenance test
npm --prefix services/openclaw-zalo-maintenance run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
$task18Files = @(
  'services/openclaw-zalo-bridge/src/bin/bridge.ts',
  'services/openclaw-zalo-bridge/src/runtime-api/client.ts',
  'services/openclaw-zalo-bridge/src/runtime-api/schemas.ts',
  'services/openclaw-zalo-bridge/src/adapters/zalouser-bridge-rpc-adapter.ts',
  'services/openclaw-zalo-bridge/src/outbox/worker.ts',
  'services/openclaw-zalo-bridge/src/outbox/state-machine.ts',
  'services/openclaw-zalo-bridge/src/outbox/pre-dispatch.ts',
  'services/openclaw-zalo-bridge/src/outbox/error-classifier.ts',
  'services/openclaw-zalo-bridge/src/jobs/worker.ts',
  'services/openclaw-zalo-bridge/src/jobs/inbound-automation-runner.ts',
  'services/openclaw-zalo-bridge/src/jobs/schedule-runner.ts',
  'services/openclaw-zalo-bridge/src/jobs/crm-event-runner.ts',
  'services/openclaw-zalo-bridge/src/jobs/template-renderer.ts',
  'services/openclaw-zalo-bridge/src/ai/cell-agent-client.ts',
  'services/openclaw-zalo-bridge/src/ai/content-policy.ts',
  'services/openclaw-zalo-bridge/src/ai/dlp.ts',
  'services/openclaw-zalo-bridge/src/ai/retrieval-context.ts',
  'services/openclaw-zalo-bridge/test/outbox-dispatch.test.ts',
  'services/openclaw-zalo-bridge/test/policy-preflight.test.ts',
  'services/openclaw-zalo-bridge/test/ai-dlp.test.ts',
  'services/openclaw-zalo-bridge/test/zalouser-bridge-rpc-adapter.test.ts',
  'services/openclaw-zalo-bridge/test/background-jobs.test.ts',
  'services/openclaw-zalo-maintenance/package.json',
  'services/openclaw-zalo-maintenance/package-lock.json',
  'services/openclaw-zalo-maintenance/tsconfig.json',
  'services/openclaw-zalo-maintenance/vitest.config.ts',
  'services/openclaw-zalo-maintenance/Dockerfile',
  'services/openclaw-zalo-maintenance/README.md',
  'services/openclaw-zalo-maintenance/src/main.ts',
  'services/openclaw-zalo-maintenance/src/runtime-client.ts',
  'services/openclaw-zalo-maintenance/src/retention-runner.ts',
  'services/openclaw-zalo-maintenance/src/audit-anchor-runner.ts',
  'services/openclaw-zalo-maintenance/src/health.ts',
  'services/openclaw-zalo-maintenance/test/auth.test.ts',
  'services/openclaw-zalo-maintenance/test/retention.test.ts',
  'services/openclaw-zalo-maintenance/test/audit.test.ts',
  'services/openclaw-zalo-maintenance/test/recovery.test.ts'
)
git add -- $task18Files
git commit -m "feat(openclaw-zalo): them dispatch policy ai va zalouser" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 19: Build Rootless Compose And Host Isolation Controls

**Files:**
- Create: `services/openclaw-zalo-cell/scripts/entrypoint.sh`
- Modify: `services/openclaw-zalo-cell/{Dockerfile,.dockerignore,image-lock.json}`; update `build-evidence.json` only in the later evidence-only child
- Create: `services/openclaw-egress-broker/{package.json,package-lock.json,tsconfig.json,vitest.config.ts,Dockerfile,README.md}`
- Create: `services/openclaw-egress-broker/src/{main,allowlist,dns-policy,connect-proxy,redaction}.ts`
- Create: `services/openclaw-egress-broker/test/{allowlist,dns-rebinding,private-ranges,proxy}.test.ts`
- Create: `infra/openclaw-zalo/{compose.cell,compose.test}.yaml`
- Create: `infra/openclaw-zalo/egress/allowlist.yaml`
- Create: `infra/openclaw-zalo/env/runtime.env.example`
- Create: `infra/openclaw-zalo/systemd/user/openclaw-stack@.service`
- Create: `infra/openclaw-zalo/systemd/user/openclaw-gc.service`
- Create: `infra/openclaw-zalo/systemd/user/openclaw-gc.timer`
- Create: `infra/openclaw-zalo/systemd/system/user-openclaw-runner.slice.conf.tmpl`
- Create: `infra/openclaw-zalo/scripts/{preflight-host,provision-rootless,render-cell,deploy-cell,verify-isolation,smoke-cell,rollback-cell,snapshot-cotenants,rotate-secrets}.sh`
- Create: `infra/openclaw-zalo/test/{compose-contract,script-contract}.test.ts`

- [ ] **Step 1: Write failing infrastructure contract tests**

Assert a separate rootless Docker data root/socket/service user, one Compose project per cell, no host ports, no Docker socket, no source mount, read-only root filesystems, `cap_drop: [ALL]`, `no-new-privileges`, and two networks: an internal-only application network for cell/bridge/maintenance and a separate external network attached only to the dual-homed egress broker. App containers must have no direct default route and set HTTP(S)/WebSocket proxy configuration to the broker. Named volumes are limited to encrypted session backing/spool/temp; plaintext paths are tmpfs. No mount may cover `/home/node/.openclaw/npm/projects`, the installed `zalouser` package, `/opt/openclaw-cell/vendor`, or the container entrypoint. The cell image must COPY the reviewed `scripts/entrypoint.sh`; `.dockerignore` and `image-lock.json` must include its exact path/hash; image-vs-running-container inspection must reproduce the final post-Task-19 image digest plus Task 2's upstream SRI, patch-series SHA-256, built-tgz SHA-256, and installed-package digest/list. Tests reject a host-mounted entrypoint, registry resolution, a second ZaloUser package, a mutable tag, or a hidden vendored artifact. Session canary tests cover AES-256-GCM persist/restart/tamper/rotation.

Snapshot tests must compare 9Router and `cli-proxy-api` container IDs, images, networks, mounts, restart counts, and health before/after OpenClaw deployment.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
npx vitest run infra/openclaw-zalo/test
```

Expected: FAIL because infrastructure files do not exist.

- [ ] **Step 3: Implement rootless deployment assets**

Use `/srv/openclaw-runtime` as the 20 GiB filesystem, `/srv/openclaw-runtime/secrets/{cellId}/` for 0400 runner-owned secrets, and a dedicated rootless socket; `{cellId}` is a validated canonical UUID supplied by the renderer. Mount the per-cell AES key at `/run/secrets/openclaw_session_key`, keep plaintext Zalo credentials/Gateway session files only in container tmpfs, and persist only authenticated ciphertext blobs through the session-crypto daemon. Writes use temp file, file fsync, atomic rename, and directory fsync; rotation re-encrypts atomically or forces QR re-login. Build/load only the reviewed Task 2 image whose local tgz and `FORK.json` hashes match; Compose never runs npm install or registry access. Apply the fixed CPU/RAM/disk budgets and publish none of ports `18789`, `18790`, or `3978`.

The version-controlled `allowlist.yaml` contains exact reviewed FQDN/port entries for Supabase, the private media gateway, the independent model provider, and pinned Zalo/OpenClaw endpoints; runtime discovery and wildcards are forbidden. The broker resolves and pins globally routable IPs per connection, validates TLS hostname, strips proxy credentials from logs, and re-resolves on retry/redirect. It rejects IP literals and loopback, RFC1918, link-local, CGNAT, metadata, multicast, unspecified, documentation, ULA, host gateway, 9Router/CLI, and lateral-container destinations. Tests from every app container prove direct Internet/host/socket access fails, allowed broker routes pass, and DNS rebinding fails without changing host UFW or rootful Docker. Update the cell Dockerfile/lock to COPY the reviewed entrypoint, but do not update tracked evidence in the same source commit. Task 19 must freeze and review a new source checkpoint `R19`, run the qualifying image gate from exact `R19`, then create/review evidence-only direct child `E19`.

- [ ] **Step 4: Implement safe deploy and rollback scripts**

Scripts must resolve explicit paths, snapshot co-tenants, verify transfer quota is recorded, render config without printing secrets, deploy only the OpenClaw Compose project, run health/isolation checks, and rollback only OpenClaw services. `smoke-cell.sh --session-encryption` uses a synthetic canary. `verify-isolation.sh --session-encryption --cell-id dddd2000-0000-4000-8000-000000000001` is the documented DEMO contract vector; production substitutes the canonical cell ID loaded from trusted runtime metadata, never free-form caller input. Any mismatch aborts and leaves existing containers untouched.

- [ ] **Step 5: Run source contract tests, then commit and review R19**

Run:

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
npx vitest run infra/openclaw-zalo/test
npm --prefix services/openclaw-egress-broker test
npm --prefix services/openclaw-egress-broker run typecheck
node scripts/check-openclaw-isolation.mjs
git add services/openclaw-zalo-cell/Dockerfile services/openclaw-zalo-cell/.dockerignore services/openclaw-zalo-cell/image-lock.json services/openclaw-zalo-cell/scripts/entrypoint.sh services/openclaw-egress-broker infra/openclaw-zalo
if (git diff --cached --name-only | Select-String '(^|/)build-evidence\.json$') { throw 'R19 must not contain tracked evidence' }
git commit -m "chore(openclaw-zalo): them rootless stack cach ly tren vultr" -m "Co-Authored-By: Codex <noreply@openai.com>"
$R19 = (git rev-parse HEAD).Trim()
```

Expected: source contracts PASS. A fresh read-only reviewer approves exact `R19` with empty findings before the qualifying helper runs.

- [ ] **Step 6: Build from reviewed R19 and create evidence-only E19**

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
$buildxPath = (Resolve-Path -LiteralPath $env:OPENCLAW_BUILDX_PATH -ErrorAction Stop).Path
& services/openclaw-zalo-cell/scripts/build-reproducible-image.ps1 -ReviewedTree $R19 -BuildxPath $buildxPath -Platform 'linux/amd64' -SourceDateEpoch '1785062400' -EvidencePath (Join-Path (Get-Location).Path 'services/openclaw-zalo-cell/.release/task19-build-evidence.json') -ReleaseArtifactPath (Join-Path (Get-Location).Path 'services/openclaw-zalo-cell/.release/openclaw-zalo-cell-linux-amd64.oci.tar')
```

Repeat Task 2 Step 5 with the absolute Task 19 candidate path: detached worktree at `R19`, re-hash/copy exactly `build-evidence.json`, commit direct child `E19`, prove the one-file diff, remove the child worktree, fast-forward, and independently review exact `E19`. Only then consume the promoted archive. No Task 19 commit mixes source with tracked evidence.

### Task 20: Add External Watchdog, Backup, Restore, And VPS Migration Runbooks

**Files:**
- Create: `infra/openclaw-zalo-watchdog/{package.json,package-lock.json,wrangler.toml,src/index.ts,src/index.test.ts}`
- Create: `supabase/functions/openclaw-watchdog/{index,handler,schemas,handler.test}.ts`
- Modify: `supabase/config.toml`
- Modify: `supabase/functions/README.md`
- Create: `infra/openclaw-zalo/scripts/openclaw-host-guard.sh`
- Create: `infra/openclaw-zalo/systemd/user/openclaw-host-guard.service`
- Create: `infra/openclaw-zalo/systemd/user/openclaw-host-guard.timer`
- Create: `infra/openclaw-zalo/scripts/{restore-drill,migrate-cell}.sh`
- Create: `docs/openclaw-zalo/runbooks/{deploy,operations,backup-restore,vps-migration,rollback,secret-rotation,capacity}.md`

- [ ] **Step 1: Write failing watchdog and runbook contract tests**

The watchdog test must call only the dedicated `openclaw-watchdog` Edge endpoint, mark heartbeat stale after 90 seconds, record an incident through `openclaw_record_watchdog_health_v1` idempotently, notify the owner once per fingerprint/repeat window, and never expose or call the OpenClaw Gateway. Worker-to-Edge authentication uses a dedicated Ed25519-signed envelope binding audience `openclaw-watchdog-edge`, operation `health.record`, method/path, timestamp with at most 60-second skew, one-time nonce, and body SHA-256. Edge verifies the dedicated key generation and replay store before any DB call, rejects browser origins and Supabase browser JWTs, and calls only `openclaw_service_record_watchdog_health_v1`. Forgery, replay, stale clock, body mismatch, wrong operation/audience/key generation, cross-organization payload, and raw-secret logging are mandatory negative tests. Host-guard source tests own and execute the exact shell/unit/timer paths listed above.

Runbook source tests must require RPO/RTO gates, exact GLOBAL_STOP/drain/fence/revoke/relogin sequence, restore drill evidence, co-tenant comparison, and quota thresholds.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm --prefix infra/openclaw-zalo-watchdog test`

Expected: FAIL because the watchdog package is absent.

- [ ] **Step 3: Implement watchdog and capacity alerts**

Schedule every minute with a 10-second timeout. After three consecutive failures, record one idempotent incident and send CRM push/email to owner/admin within three minutes. Record stale/offline/recovered health through a narrow Edge operation. Alert on queue lag, UNKNOWN rate, adapter errors, reconnect count, CPU/RAM/disk, spool age/bytes, R2 failure, Supabase egress, R2 storage/requests, VPS outbound, and transfer quota at 60/80/90/100 percent. At 80 percent disable automatic video/file caching, at 90 percent pause noncritical proactive/group media, and at 100 percent pause every outbound message containing media.

Set `[functions.openclaw-watchdog] verify_jwt = false` in `supabase/config.toml`; the handler's signed-envelope verification is mandatory custom auth and must complete before any database call. Update `supabase/functions/README.md` with its exact entrypoint `openclaw-watchdog/index.ts`, signed Worker audience/operation, secret names without values, deploy order, and negative tests. The watchdog package defines `build`, `test`, `typecheck`, and `deploy`; `deploy` runs `wrangler deploy --minify --keep-vars` only after local gates and emits a machine-readable Worker deployment version plus bundle SHA-256.

The host guard pauses outbound, AI, and media immediately if 9Router/CLI p95 latency regresses more than 20 percent for five minutes, their error rate exceeds 1 percent for five minutes, host RAM exceeds 75 percent for 15 minutes, swap exceeds 10 percent, one-minute load exceeds 12 for 15 minutes, or root free disk falls below `max(200 GiB,20%)`. It preserves minimal inbound spool; if the condition remains for ten minutes, it stops only the rootless OpenClaw cell/bridge. Clear conditions must hold 15 minutes and require `manage_operations` manual resume.

- [ ] **Step 4: Implement recovery and migration procedures**

The restore drill must verify Supabase canonical DB RPO <=15 minutes and RTO <=4 hours before auto/proactive/group production, simulate accidental R2 delete inside the seven-day grace period, rotate workload/token/audit keys, rotate the AES session key by atomic decrypt/re-encrypt or force QR re-login, prove no plaintext session snapshot exists, and record actual RPO/RTO without secrets.

The VPS migration script/runbook must perform: organization GLOBAL_STOP, drain/freeze, move expired DISPATCHING to UNKNOWN, snapshot old co-tenants, provision a new rootless cell, rotate workload credentials, acquire a higher fencing lease, revoke old credential/lease, QR re-login, sync 48-hour history, reconcile gaps/UNKNOWN, controlled smoke, and resume. Target RTO is <=60 minutes; Supabase and R2 are not copied.

- [ ] **Step 5: Run tests**

Run:

```powershell
npm --prefix infra/openclaw-zalo-watchdog ci
npm --prefix infra/openclaw-zalo-watchdog run build
npm --prefix infra/openclaw-zalo-watchdog test
npm --prefix infra/openclaw-zalo-watchdog run typecheck
npx vitest run supabase/functions/openclaw-watchdog
npx vitest run infra/openclaw-zalo/test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add infra/openclaw-zalo-watchdog supabase/functions/openclaw-watchdog supabase/config.toml supabase/functions/README.md infra/openclaw-zalo/scripts/openclaw-host-guard.sh infra/openclaw-zalo/systemd/user/openclaw-host-guard.service infra/openclaw-zalo/systemd/user/openclaw-host-guard.timer infra/openclaw-zalo/scripts/restore-drill.sh infra/openclaw-zalo/scripts/migrate-cell.sh docs/openclaw-zalo/runbooks
git commit -m "docs(openclaw-zalo): them watchdog va runbook recovery" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 21: Build Frontend Domain Types, Policy Tests, Query Hooks, And Cache Isolation

**Files:**
- Create: `src/lib/openclaw-zalo/{types,validation,state-machine,policy,query-contract}.ts`
- Create: `src/lib/openclaw-zalo/__tests__/{stateMachines.property,policy.property,idempotency.property,redaction.property}.test.ts`
- Create: `src/hooks/openclaw-zalo/{queryKeys,useOpenClawOrganization,useOpenClawBootstrap,useOpenClawOverview,useOpenClawInbox,useOpenClawOperations,useOpenClawRealtime,useOpenClawPermissions,useOpenClawMutations}.ts`
- Create: `src/hooks/openclaw-zalo/__tests__/{queries,mutations,realtime}.test.ts`

- [ ] **Step 1: Write failing property tests for shared client logic**

Use fast-check with at least 100 cases for valid/invalid outbox transitions, policy precedence, equal-timestamp cursor ordering, idempotency same-key/same-hash vs different-hash, redaction, query key tenant isolation, and Realtime duplicate/out-of-order invalidation. Add strict query/mutation contract tests for unresolved-versus-resolved UNKNOWN projections, all three immutable resolution outcomes, same-operation lost-response replay, `40001` winner reload, and the rule that the historical state remains UNKNOWN.

Example invariant:

```ts
fc.assert(fc.property(outboxStateArb, outboxStateArb, (from, to) => {
  if (from === "UNKNOWN") return canTransition(from, to) === false;
  return canTransition(from, to) === EXPECTED_TRANSITIONS[from].includes(to);
}), { numRuns: 100 });
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run src/lib/openclaw-zalo src/hooks/openclaw-zalo`

Expected: FAIL because the modules are missing.

- [ ] **Step 3: Implement types, validators, and policy model**

Mirror the stable contracts in section 4. All API responses use Zod strict schemas. Keep provider/session secret shapes out of frontend types. Represent degraded/partial states explicitly instead of converting errors to empty arrays.

- [ ] **Step 4: Implement org/account-scoped hooks**

Every query key begins with:

```ts
["openclaw-zalo", organizationId, accountId, ...resourceParts]
```

Use `useOpenClawOrganization` to list active memberships, select exactly one organization from `?org=` or the only available organization, and refuse to guess when multiple organizations exist. Use bounded cursor queries, selected RPCs, `enabled` guards, and action-specific mutations. On organization/account/session change: close Realtime channels, cancel OpenClaw queries, remove only OpenClaw cache entries, then refetch bootstrap. Realtime is invalidation only; reconnect always refetches canonical cursor/current state.

- [ ] **Step 5: Run tests and typecheck**

Run:

```powershell
npx vitest run src/lib/openclaw-zalo src/hooks/openclaw-zalo
npm run typecheck:baseline
npx tsc --noEmit -p tsconfig.app.json
```

Expected: PASS with no increased TypeScript baseline.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/openclaw-zalo src/hooks/openclaw-zalo
git commit -m "feat(openclaw-zalo): them domain client va query hooks" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 22: Add Route, Navigation, Desktop Shell, And Mobile Shell

**Files:**
- Create: `src/pages/openclaw-zalo/{OpenClawZaloPage,OpenClawZaloDesktopPage,OpenClawZaloMobilePage}.tsx`
- Create: `src/pages/openclaw-zalo/__tests__/OpenClawZaloPage.test.tsx`
- Create: `src/components/openclaw-zalo/{OpenClawCockpit,OpenClawCommandBar,OpenClawSectionNav,OpenClawBoundaryState,OpenClawRouteGuard}.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/components/layout/Breadcrumbs.tsx`
- Modify: `src/pages/home/launcherTiles.ts`
- Create: `src/lib/__tests__/openclawNavigation.test.ts`

- [ ] **Step 1: Write failing route/navigation/responsive tests**

Assert lazy import, exact route, a selected-organization-aware `OpenClawRouteGuard`, distinct sidebar item, launcher tile, breadcrumb label, no `/chat-zalo` reuse, desktop `MainLayout fullBleed`, and mobile standalone shell selected by `usePhoneViewport()` without a desktop flash. Do not use the existing aggregate `RequirePermission` as the final OpenClaw organization decision: the guard must load the selected organization from the OpenClaw organization context, call the org-aware bootstrap/authorization RPC, redirect to `/` before rendering content when `openclaw_zalo.view` is absent, and show a selector when a multi-organization user has not selected an organization.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npx vitest run src/lib/__tests__/openclawNavigation.test.ts src/pages/openclaw-zalo/__tests__/OpenClawZaloPage.test.tsx
```

Expected: FAIL because route and page do not exist.

- [ ] **Step 3: Implement the responsive shells**

Desktop exposes six areas in the approved order: Overview, Inbox, Automation, Knowledge, Schedule & Sales Groups, Operations. Mobile bottom navigation exposes exactly Overview, Inbox, Automation, More; More opens Knowledge, Schedule & Sales Groups, and Operations. Use 44px minimum touch controls, no horizontal page scroll, status icon plus text, and a persistent command bar showing organization, account, session health, effective mode, pause state, and GLOBAL_STOP. The organization selector stores only the selected organization ID, never credentials or QR data, and every query/mutation/cache key includes that selected organization.

The visual direction uses warm white surfaces, ink/navy text, safety red only for stop/UNKNOWN, teal for healthy connected state, amber for risk/degraded state, strong 1px borders, readable non-default typography already available to the app, and no decorative purple gradient or drop-shadow-heavy dashboard styling.

- [ ] **Step 4: Implement explicit boundary states**

`OpenClawBoundaryState` must render distinct loading, no account, no permission, disconnected, stale cell, partial Supabase/R2 outage, empty inbox, and fatal error states. Never hide an error by rendering an empty list. The GLOBAL_STOP banner is visible to all viewers; its action is enabled only for `manage_operations`.

- [ ] **Step 5: Run tests and typecheck**

Run:

```powershell
npx vitest run src/lib/__tests__/openclawNavigation.test.ts src/pages/openclaw-zalo src/components/openclaw-zalo/OpenClawBoundaryState.tsx
npm run typecheck:baseline
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/App.tsx src/components/layout/Sidebar.tsx src/components/layout/Breadcrumbs.tsx src/pages/home/launcherTiles.ts src/pages/openclaw-zalo src/components/openclaw-zalo/OpenClawCockpit.tsx src/components/openclaw-zalo/OpenClawCommandBar.tsx src/components/openclaw-zalo/OpenClawSectionNav.tsx src/components/openclaw-zalo/OpenClawBoundaryState.tsx src/components/openclaw-zalo/OpenClawRouteGuard.tsx src/lib/__tests__/openclawNavigation.test.ts
git commit -m "feat(openclaw-zalo): them page rieng desktop mobile" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 23: Implement Connection, Inbox, AI Draft, Manual Send, And Handoff UI

**Files:**
- Create: `src/components/openclaw-zalo/dialogs/OpenClawConnectionDialog.tsx`
- Create: `src/components/openclaw-zalo/inbox/{OpenClawInbox,ConversationList,ConversationThread,AiDraftPanel}.tsx`
- Create: `src/components/openclaw-zalo/__tests__/{connection,inbox,permissionStates}.test.tsx`

- [ ] **Step 1: Write failing permission and state tests**

Cover disclosure acknowledgement, same-phone guidance, 120-second QR countdown, refresh invalidation, session kick, read-only user, sender, connection manager, handoff manager, empty inbox, paginated cursor, media unavailable, AI draft citations/risk flags, DLP blocked draft, manual send confirmation, takeover start/end, and clean rendering when an action is forbidden.

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run src/components/openclaw-zalo/__tests__/connection.test.tsx src/components/openclaw-zalo/__tests__/inbox.test.tsx src/components/openclaw-zalo/__tests__/permissionStates.test.tsx`

Expected: FAIL because components do not exist.

- [ ] **Step 3: Implement QR and connection flow**

The browser generates a nonce with Web Crypto, keeps QR data only in component memory, short-polls the QR Edge endpoint, and clears the QR on expiry, close, logout, org/account switch, route unmount, or successful login. Do not persist QR/session data in localStorage/sessionStorage, analytics, React Query cache, screenshots, or toast descriptions. QR and automation publishing remain blocked until the current disclosure version is acknowledged; a disclosure version change or a LIMITED reconnect requires acknowledgement again, while cancel performs no mutation.

- [ ] **Step 4: Implement inbox and manual sending**

Conversation list uses cursor pagination and selected active-account scope. The thread handles duplicate/out-of-order events deterministically. Manual send requires `send`, displays effective policy result before confirmation, creates a client operation ID, and shows QUEUED/LEASED/DISPATCHING/SENT/FAILED/UNKNOWN without optimistic fake success.

AI draft is review-only unless a separately enabled automation path creates a send intent. Handoff/takeover actions require `manage_handoff`, show owner and expiry, and prevent auto-reply until takeover is released.

- [ ] **Step 5: Run tests and typecheck**

Run:

```powershell
npx vitest run src/components/openclaw-zalo/__tests__/connection.test.tsx src/components/openclaw-zalo/__tests__/inbox.test.tsx src/components/openclaw-zalo/__tests__/permissionStates.test.tsx
npm run typecheck:baseline
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/components/openclaw-zalo/dialogs/OpenClawConnectionDialog.tsx src/components/openclaw-zalo/inbox src/components/openclaw-zalo/__tests__/connection.test.tsx src/components/openclaw-zalo/__tests__/inbox.test.tsx src/components/openclaw-zalo/__tests__/permissionStates.test.tsx
git commit -m "feat(openclaw-zalo): them qr inbox draft va handoff" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 24: Implement Knowledge, Automation Wizard, Sales Groups, Schedules, And CRM Triggers

**Files:**
- Create: `src/components/openclaw-zalo/automation/OpenClawAutomation.tsx`
- Create: `src/components/openclaw-zalo/knowledge/OpenClawKnowledge.tsx`
- Create: `src/components/openclaw-zalo/schedules/OpenClawSchedulesAndGroups.tsx`
- Create: `src/components/openclaw-zalo/__tests__/{automation,knowledge,schedules-groups}.test.tsx`

- [ ] **Step 1: Write failing workflow tests**

Knowledge tests cover create/edit/validate/publish/archive, immutable version conflict, retrieval preview, sensitivity filtering, and denied permission. Automation tests cover resumable wizard state, dry-run, version publish conflict, default-off first-contact/friend workflow, low caps, and blocked auto-send before rollout. Group tests cover exact stable ID selection, no name matching, <=24-hour directory freshness, owner-controlled sales group, schedule timezone, quiet hours, typed CRM event selection, idempotent occurrence preview, and no group-chat auto-reply.

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run src/components/openclaw-zalo/__tests__/automation.test.tsx src/components/openclaw-zalo/__tests__/knowledge.test.tsx src/components/openclaw-zalo/__tests__/schedules-groups.test.tsx`

Expected: FAIL because feature components do not exist.

- [ ] **Step 3: Implement knowledge management**

Require `manage_knowledge` for mutations. Show source/version/sensitivity/status, validation errors, retrieval preview, and stale-version conflict. Customer-facing preview must exclude internal/restricted chunks; internal review preview is visibly marked and cannot be published as customer-safe without a new version and explicit review.

- [ ] **Step 4: Implement the bounded automation wizard**

Use the approved eight steps exactly: (1) explain the feature and Zalo Personal risk, (2) choose a verified recipient/group source, (3) declare consent/business basis and suppression behavior, (4) choose hours/timezone/frequency/hard stop, (5) choose template/knowledge and preview redacted sample data, (6) choose draft-only/human approval/auto policy mode, (7) run validation and a no-send dry-run, and (8) confirm with an authorized user and publish an immutable version. Store server-side draft versions after every step, not browser-only state. Publish requires `manage_automation`, an expected version, a dry-run result, current disclosure acknowledgement, and owner-visible default-off gates for first contact, proactive, and group modes.

Mode-specific required fields must match the spec: inbound conversation scope/published knowledge/delay/mode/per-peer cap; proactive recipient set/consent/schedule/quiet hours/template/per-peer and account caps; sales-group exact group/schedule/timezone/template/group and account caps; CRM-event typed event/exact group/field allowlist/dedupe key/template; first-contact server flag/adapter capability/recipient evidence/enhanced disclosure/risk cap. First-contact remains blocked unless every field and server feature gate passes.

- [ ] **Step 5: Implement groups, schedules, and CRM events**

Display the three exact event types and their canonical sources. Group selection stores provider stable ID and freshness timestamp; stale directory disables publishing. Schedules show local timezone, next occurrence, caps, campaign cancellation, and GLOBAL_STOP impact. A missed occurrence is `SKIPPED_MISSED` with no automatic catch-up; editing a recurring series creates a new future version and never rewrites past evidence. Group chatter is visible in the inbox but never eligible for auto-reply.

- [ ] **Step 6: Run tests and typecheck**

Run:

```powershell
npx vitest run src/components/openclaw-zalo/__tests__/automation.test.tsx src/components/openclaw-zalo/__tests__/knowledge.test.tsx src/components/openclaw-zalo/__tests__/schedules-groups.test.tsx
npm run typecheck:baseline
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/components/openclaw-zalo/automation src/components/openclaw-zalo/knowledge src/components/openclaw-zalo/schedules src/components/openclaw-zalo/__tests__/automation.test.tsx src/components/openclaw-zalo/__tests__/knowledge.test.tsx src/components/openclaw-zalo/__tests__/schedules-groups.test.tsx
git commit -m "feat(openclaw-zalo): them automation knowledge va nhom sale" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 25: Implement Operations, GLOBAL_STOP, UNKNOWN, Retention, And Capacity UI

**Files:**
- Create: `src/components/openclaw-zalo/overview/OpenClawOverview.tsx`
- Create: `src/components/openclaw-zalo/operations/OpenClawOperations.tsx`
- Create: `src/components/openclaw-zalo/dialogs/{OpenClawGlobalStopDialog,OpenClawUnknownResolutionDialog}.tsx`
- Create: `src/components/openclaw-zalo/__tests__/{globalStop,unknownResolution,operations}.test.tsx`

- [ ] **Step 1: Write failing operations tests**

Test healthy/degraded/stale/offline cell, Supabase/R2 partial outage, spool pressure, queue lag, separate unresolved/resolved UNKNOWN counts, dead letter, retention tombstone/hold, audit chain status, transfer/media quotas, action permission gates, typed confirmation text, all three immutable UNKNOWN outcomes, lost-response replay, one-time resolution conflict/winner reload, and all viewers seeing GLOBAL_STOP status.

- [ ] **Step 2: Run tests and verify failure**

Run: `npx vitest run src/components/openclaw-zalo/__tests__/globalStop.test.tsx src/components/openclaw-zalo/__tests__/unknownResolution.test.tsx src/components/openclaw-zalo/__tests__/operations.test.tsx`

Expected: FAIL because operations components do not exist.

- [ ] **Step 3: Implement overview and operational evidence**

Show account/session/cell state, current mode, queue counts by state, p95 lag, unresolved UNKNOWN count/rate separately from historically resolved UNKNOWN, reconnects, CPU/RAM/disk, spool age/bytes, media backlog, Supabase egress, R2 request/storage, VPS outbound, transfer quota, recent health incidents, audit verification, and last restore drill. Status always uses icon plus text.

- [ ] **Step 4: Implement emergency and reconciliation controls**

GLOBAL_STOP requires `manage_operations`, exact typed confirmation `DUNG TOAN BO GUI CUA CONG TY`, and current organization display. UNKNOWN rows always retain the historical `UNKNOWN` badge plus a separate resolution badge/evidence block. Resolution only allows mark sent, mark failed, or create a new confirmed send intent; it sends `OpenClawUnknownResolutionRequestV1` with `expectedResolutionVersion=0`, never fabricates provider success, and displays the immutable winner/new-outbox link returned by `OpenClawUnknownResolutionV1`. Same-operation retry after a lost response is harmless; `40001` reloads the winner without duplicate action. Dead-letter replay creates a new intent only after current policy recheck. Legal-hold create/release requires both `audit` and `manage_operations`, a typed target, reason, optional expiry, and an append-only audit event.

- [ ] **Step 5: Run tests and typecheck**

Run:

```powershell
npx vitest run src/components/openclaw-zalo/__tests__/globalStop.test.tsx src/components/openclaw-zalo/__tests__/unknownResolution.test.tsx src/components/openclaw-zalo/__tests__/operations.test.tsx
npm run typecheck:baseline
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/components/openclaw-zalo/overview src/components/openclaw-zalo/operations src/components/openclaw-zalo/dialogs/OpenClawGlobalStopDialog.tsx src/components/openclaw-zalo/dialogs/OpenClawUnknownResolutionDialog.tsx src/components/openclaw-zalo/__tests__/globalStop.test.tsx src/components/openclaw-zalo/__tests__/unknownResolution.test.tsx src/components/openclaw-zalo/__tests__/operations.test.tsx
git commit -m "feat(openclaw-zalo): them operations stop va unknown" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 26: Add Headless DEMO E2E With A Fake Adapter

**Files:**
- Create: `.e2e-fleet/specs/openclaw-zalo-fake-adapter.ts`
- Create: `.e2e-fleet/specs/openclaw-zalo-admin.ts`
- Create: `.e2e-fleet/specs/openclaw-zalo.spec.ts`

- [ ] **Step 1: Write the E2E scenarios before implementation wiring**

The spec must import `login` and `trackConsoleErrors` from `.e2e-fleet/specs/auth.ts`, use only the DEMO organization, and clean all markers in `finally`. It also requires explicit preproduction inputs `FLEET_BASE_URL=http://127.0.0.1:4173`, `FLEET_OPENCLAW_FIXTURE_ENV=local-preview`, and `FLEET_OPENCLAW_PROJECT_REF=local`; it fails before browser launch if any are absent/mismatched or if the base URL is `https://ptcrm.vercel.app` (the fleet default production URL). Cover:

```text
permission denied hides route/action and has no content flash
owner sees six desktop areas and four mobile navigation items
connect disclosure -> QR -> expiry -> refresh -> fake connected status
inbox search, unread idempotency, assignment conflict, cursor pagination/order, media retry, and no console errors
AI draft is review-only and redacts restricted content
manual send enters QUEUED and fake success reaches SENT
ambiguous fake timeout reaches UNKNOWN and never auto-retries
UNKNOWN keeps its historical state while one immutable resolution wins; lost-response replay is idempotent and create-new-intent links a distinct outbox
GLOBAL_STOP is visible to viewer and actionable only to operations manager
sales group requires exact stable ID and fresh directory
lead/room/follow-up triggers create one deduped occurrence
due schedule and CRM occurrence fan out to exact targets, render frozen templates, create one atomic outbox row, and reach fake SENT without duplicate retries
retention QUARANTINE revokes access with zero R2 call, starts seven-day grace, and a hold before its CAS blocks it; FINAL_DELETE is unavailable before grace, then a hold before authorize-delete blocks R2 and signed-receipt finalization retries idempotently
daily audit root signs, uploads one immutable fake anchor, survives lost DB acknowledgement, and marks anchored only after independent verification
automation wizard autosaves, dry-runs, publishes, pauses, and explains policy blocks
knowledge create/edit/validate/publish/archive/retrieval/no-result/stale-conflict/permission-denied states
dead-letter creates a new validated intent and partial Supabase/R2 outage stays explicit
organization switch closes channels and clears OpenClaw cache
```

- [ ] **Step 2: Run the new E2E and verify it fails**

Run from PowerShell:

```powershell
Push-Location .e2e-fleet
$env:FLEET_WORKERS = '8'
$env:FLEET_BASE_URL = 'http://127.0.0.1:4173'
$env:FLEET_OPENCLAW_FIXTURE_ENV = 'local-preview'
$env:FLEET_OPENCLAW_PROJECT_REF = 'local'
npx playwright test specs/openclaw-zalo.spec.ts
Pop-Location
```

Expected: FAIL because the route, fixture API, and fake adapter are not wired.

- [ ] **Step 3: Implement deterministic fake control and adapter drivers**

`openclaw-zalo-admin.ts` must guard the explicit local project/fixture environment and DEMO organization before every fixture mutation, reject the shared production project ref and production base URL before network access, and never fall back to fleet defaults. `openclaw-zalo-fake-adapter.ts` must provide QR, inbound, session kick, exact peer/group directory, send success/reject/ambiguous timeout, and deterministic clock controls through test-only runtime endpoints unavailable to production cells.

The test must set viewport sizes `1440x1000` and `390x844`, initialize console tracking before navigation, wait for Realtime settle, assert `consoleErrors` is empty, and use a marker prefix for cleanup.

- [ ] **Step 4: Run the E2E**

Run:

```powershell
Push-Location .e2e-fleet
$env:FLEET_WORKERS = '8'
$env:FLEET_BASE_URL = 'http://127.0.0.1:4173'
$env:FLEET_OPENCLAW_FIXTURE_ENV = 'local-preview'
$env:FLEET_OPENCLAW_PROJECT_REF = 'local'
npx playwright test specs/openclaw-zalo.spec.ts
Pop-Location
```

Expected: PASS with no console errors and no leaked DEMO fixtures. A missing `FLEET_PASS_CHUNHA`, `FLEET_PASS_KETOAN`, or `FLEET_PASS_QUANLY` must fail before login with a clear error.

- [ ] **Step 5: Commit**

```powershell
git add .e2e-fleet/specs/openclaw-zalo-fake-adapter.ts .e2e-fleet/specs/openclaw-zalo-admin.ts .e2e-fleet/specs/openclaw-zalo.spec.ts
git commit -m "test(openclaw-zalo): them e2e headless voi fake adapter" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 27: Add Service, SQL, R2, Type, And Isolation Gates To CI

**Files:**
- Modify: `.github/workflows/ci-gates.yml`
- Modify: `package.json`
- Modify: `vite.config.ts`
- Modify: `eslint.config.js`
- Create: `src/lib/__tests__/openclawFullContract.test.ts`
- Create: `scripts/__tests__/openclawCommandContract.test.mjs`

- [ ] **Step 1: Write failing command and coverage tests**

Assert exactly three top-level gates and two SQL helpers exist: `test:openclaw:services`, `test:openclaw:sql`, `test:openclaw:r2`, `test:openclaw:sql:local`, and `test:openclaw:sql:live-demo`; the top-level SQL gate must be the local/static alias and no pull-request workflow may reference the protected live-DEMO helper. The command contract parses root scripts, workflow steps, `vite.config.ts`, and `eslint.config.js`; it proves every nested package suite is excluded from root Vitest/ESLint traversal and executed exactly once by its owning top-level gate, with no stdout redirection into `src/integrations/supabase/types.ts`.

Require Node `>=24.15.0 <25` plus `npm ci`, `verify:upstream`, `vendor:prepare`, `typecheck`, `test`, `build`, `pack`, and `verify:artifact` coverage for the vendored fork; package.json must not define lifecycle `prepare`. The planned `test:openclaw:services` JSON value starts with the same dependency-free Node assertion before its first `npm`/vendor action. CI pins `actions/setup-node` to exact `24.15.0` and runs that assertion before the first `npm ci`; floating `24`, `24.x`, `latest`, or an assertion after install is rejected. Other nested package gates retain their build/test/typecheck coverage. Session-crypto uses `verify:dist` for the exact three reviewed prebuilt runtime files while its package/lock engine remains `>=22.13.0`. The vendor gate verifies provenance/source/artifact/license/runtime/internal-only install and never contacts npm during Docker installation. The command contract also preserves the existing Edge, SQL, R2, smoke, migration, and coverage ownership requirements.

The command contract parses `.gitattributes`, `.dockerignore`, `image-lock.json`, `build-evidence.schema.v1.json`, the exact two-stage Dockerfile, `export-reviewed-tree.mjs`, normalization/install scripts, `build-reproducible-image.ps1`, `verify-image-lock.mjs`, image-contract tests, root scripts, CI, and the Task 29 runbook lifecycle as one gate. Positive coverage requires exact `-ReviewedTree` Git-plumbing export obtained from the exact reviewed blob, `git ls-tree -rz --full-tree`, `git cat-file --batch`, complete manifest/output re-hash before install, absolute pinned `-BuildxPath`, helper self-preflight, context-root v2 golden vector, exact three-blob session input/final-rootfs binding, buildx/BuildKit hashes, Node-first `RUN --network=none`, one newly created empty vendor cache/no reuse/fallback, no Docker session build/install, minimal final rootfs, installedTree plus list/inspect/package/discovery checks, two fresh builders, exact flags/exporter, byte-identical OCI archives/layout/index/blobs, closed schema, tamper-evident review reports, promoted handoff, exact reviewed-verifier-before-stage, exact cleanup, and checked-native fail-fast. Node fixtures accept `24.15.0` and later `24.x`, reject `22.20.x`, `24.14.x`, and `25.x`, and prove failure precedes all work/artifact/evidence. Negative fixtures remove/corrupt each requirement, reject `git archive`/checkout/reserialized source paths, reject source/evidence mixing, inject dirty-worktree/primary/cleanup failures into Task 2/E27/E29 detached lifecycles, reject ignored-only Task 29 evidence, reject an OCI archive in E29, reject bundle/Edge/Worker/VPS actions before independent E29 approval, and reject a later sentinel after native failure. Task 27's source-only preflight is non-qualifying; exact `R27` review precedes the qualifying `-ReviewedTree $R27` build and evidence-only `E27` review. Task 29 similarly requires exact `R29`, qualifying `-ReviewedTree $R29`, one-file direct child `E29`, independent E29 approval, then an E29-bound bundle/deploy while image evidence remains bound to R29.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
npx vitest run src/lib/__tests__/openclawFullContract.test.ts scripts/__tests__/openclawCommandContract.test.mjs
```

Expected: FAIL until all command and manifest references are wired.

- [ ] **Step 3: Implement CI execution order**

Add CI jobs in this order:

```text
isolation -> app typecheck/baseline -> OpenClaw frontend Vitest
-> nested package ci/build/test/typecheck -> bounded Edge Vitest plus Deno cache/lint/check
-> SQL static/harness -> R2 Worker tests
-> infrastructure/session-crypto contracts
-> production-smoke contract (no live credentials)
-> headless E2E (DEMO secrets only)
```

Production secrets, real Zalo credentials, Supabase service-role values, R2 keys, and Vultr SSH keys must never be available to pull-request CI. `test:openclaw:sql:live-demo` and both deploy scripts are forbidden in PR CI. The E2E job uses the explicit local/preview environment from Task 26 and never inherits the fleet production default.

Every CI job that can reach Node/npm/npx/vendor/image-helper work uses exact `actions/setup-node` `node-version: 24.15.0`, then runs the dependency-free version assertion as its first Node command and only afterward runs `npm ci`. A failed assertion must leave caches, `.work/`, `.release/`, Docker builders, archives, and evidence untouched.

Extend root `test.exclude` and ESLint ignores with the exact package-owned paths `services/openclaw-zalo-cell/vendor/zalouser-bridge/**`, `services/openclaw-zalo-cell/session-crypto/**`, `services/openclaw-zalo-bridge/**`, `services/openclaw-zalo-maintenance/**`, `services/openclaw-egress-broker/**`, `infra/openclaw-media-gateway/**`, `infra/openclaw-zalo-watchdog/**`, and Deno-owned `supabase/functions/**`. Root Vitest remains bounded to the explicitly listed app/script tests; nested/Edge gates own their files. `openclawCommandContract.test.mjs` fails on missing exclusions, duplicate traversal, an unowned suite, a vendor gate that skips provenance/artifact verification, or another package gate that skips build/test/typecheck.

Task 27 replaces the transitional Edge suffix from Task 12 with one bounded Vitest invocation for the seven Edge scopes followed by exact type gates: `deno cache` on all seven `index.ts` entrypoints and `_shared/openclaw/deps.ts`; `deno lint` on those seven directories plus `_shared/openclaw`; and `deno check` on `openclaw-control/index.ts`, `openclaw-qr/index.ts`, `openclaw-runtime-token/index.ts`, `openclaw-runtime/index.ts`, `openclaw-object-tickets/index.ts`, and `openclaw-watchdog/index.ts`. None of those paths may also appear in root Vitest/ESLint traversal.

- [ ] **Step 4: Run source-only local gates before R27**

This step is deliberately pre-`R27` and non-qualifying. It may compile, test, prepare, and pack development outputs, but it must not invoke `build-reproducible-image.ps1`, create or update any Task 27 release archive/evidence under `.release/`, or modify tracked `services/openclaw-zalo-cell/build-evidence.json`. These results exist only to make the Task 27 source/CI/config candidate ready for commit and exact-SHA review.

Run:

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
npm ci
node scripts/check-openclaw-isolation.mjs
$env:SUPABASE_TYPES_SOURCE = 'local'
npm run gen:types
git diff --exit-code -- src/integrations/supabase/types.ts
Remove-Item Env:SUPABASE_TYPES_SOURCE
node scripts/check-view-invoker.mjs
npm run typecheck:baseline
npx tsc --noEmit -p tsconfig.app.json
npx vitest run src/lib/openclaw-zalo src/hooks/openclaw-zalo src/components/openclaw-zalo src/pages/openclaw-zalo src/lib/__tests__/openclawFullContract.test.ts scripts/__tests__/openclawCommandContract.test.mjs scripts/__tests__/production-openclaw-smoke.test.mjs
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge ci
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run verify:upstream
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run vendor:prepare
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run typecheck
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge test
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run build
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run pack
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run verify:artifact
npm --prefix services/openclaw-zalo-cell/session-crypto ci
npm --prefix services/openclaw-zalo-bridge ci
npm --prefix services/openclaw-zalo-maintenance ci
npm --prefix services/openclaw-egress-broker ci
npm --prefix infra/openclaw-media-gateway ci
npm --prefix infra/openclaw-zalo-watchdog ci
npx vitest run infra/openclaw-zalo/test
npm run test:openclaw:services
npm run test:openclaw:sql
npm run test:openclaw:r2
if (Test-Path -LiteralPath 'services/openclaw-zalo-cell/.release/task27-build-evidence.json') { throw 'Pre-R27 checks must not create candidate evidence' }
if (Test-Path -LiteralPath 'services/openclaw-zalo-cell/.release/task27-openclaw-zalo-cell-linux-amd64.oci.tar') { throw 'Pre-R27 checks must not create a release archive' }
git diff --exit-code -- services/openclaw-zalo-cell/build-evidence.json
```

Expected: every source-only command exits 0; command-contract evidence proves every nested/Edge suite runs exactly once, SQL is local/static, the protected live-DEMO/deploy commands are absent, generated types are unchanged, and Edge Deno checks are visible rather than hidden from Vitest. No release archive or evidence is produced, and this step does not qualify an image.

- [ ] **Step 5: Commit and independently review exact R27**

```powershell
$task27Files = @(
  '.github/workflows/ci-gates.yml',
  'package.json',
  'vite.config.ts',
  'eslint.config.js',
  'src/lib/__tests__/openclawFullContract.test.ts',
  'scripts/__tests__/openclawCommandContract.test.mjs'
)
git add -- $task27Files
$unexpected = @(git diff --cached --name-only | Where-Object { $_ -notin $task27Files })
if ($unexpected.Count -ne 0) { throw "R27 contains out-of-scope paths: $($unexpected -join ', ')" }
if (git diff --cached --name-only | Select-String '(^|/)build-evidence\.json$') { throw 'R27 must not contain tracked evidence' }
git commit -m "ci(openclaw-zalo): them day du quality gates" -m "Co-Authored-By: Codex <noreply@openai.com>"
$R27 = (git rev-parse HEAD).Trim()
```

A fresh read-only reviewer must inspect exact committed `R27`, verify the Task 27 source/CI/config diff and every command-contract requirement, and issue the closed canonical `APPROVED` report with empty findings outside the tree. If review finds an issue, fix it in a forward commit and review the new SHA; never amend or substitute a descendant for reviewed `R27`.

- [ ] **Step 6: Run the qualifying image gate from reviewed R27**

Only after the independent `R27` review is approved, start from exact `R27` with a clean worktree/index and no merge/rebase. Resolve the pinned buildx binary to an absolute path, invoke the exact reviewed helper with `-ReviewedTree $R27`, and write both candidate outputs only to absolute paths under the source worktree's ignored `.release/`. The helper must bootstrap and fully verify the exact-`R27` Git-plumbing export before any install/verifier/build, embed the exact `R27` approval report, and retain no tracked mutation.

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
$R27 = $env:OPENCLAW_REVIEWED_R27_SHA
if ($R27 -notmatch '^[0-9a-f]{40}$') { throw 'OPENCLAW_REVIEWED_R27_SHA must be exact reviewed R27' }
$sourceRoot = (Resolve-Path -LiteralPath '.').Path
if ((git rev-parse HEAD).Trim() -ne $R27) { throw 'HEAD is not exact reviewed R27' }
if (@(git status --porcelain=v1 --untracked-files=all).Count -ne 0) { throw 'R27 worktree is not completely clean' }
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { throw 'R27 index is not empty' }
$gitStatePaths = @(
  (git rev-parse --git-path MERGE_HEAD)
  (git rev-parse --git-path rebase-merge)
  (git rev-parse --git-path rebase-apply)
)
if (@($gitStatePaths | Where-Object { Test-Path -LiteralPath $_ }).Count -ne 0) { throw 'Merge/rebase is in progress' }
$buildxPath = (Resolve-Path -LiteralPath $env:OPENCLAW_BUILDX_PATH -ErrorAction Stop).Path
if (-not [IO.Path]::IsPathFullyQualified($buildxPath)) { throw 'OPENCLAW_BUILDX_PATH must resolve to an absolute path' }
$reviewedHelper = (Resolve-Path -LiteralPath 'services/openclaw-zalo-cell/scripts/build-reproducible-image.ps1' -ErrorAction Stop).Path
$releaseRoot = Join-Path $sourceRoot 'services/openclaw-zalo-cell/.release'
$candidateEvidence = Join-Path $releaseRoot 'task27-build-evidence.json'
$candidateArchive = Join-Path $releaseRoot 'task27-openclaw-zalo-cell-linux-amd64.oci.tar'
New-Item -ItemType Directory -Path $releaseRoot -Force -ErrorAction Stop | Out-Null
if (Test-Path -LiteralPath $candidateEvidence) { throw 'Stale Task 27 candidate evidence exists' }
if (Test-Path -LiteralPath $candidateArchive) { throw 'Stale Task 27 candidate archive exists' }
& $reviewedHelper -ReviewedTree $R27 -BuildxPath $buildxPath -Platform 'linux/amd64' -SourceDateEpoch '1785062400' -BaselineEvidencePath (Join-Path $sourceRoot 'services/openclaw-zalo-cell/build-evidence.json') -EvidencePath $candidateEvidence -ReleaseArtifactPath $candidateArchive
if (-not (Test-Path -LiteralPath $candidateEvidence -PathType Leaf)) { throw 'Task 27 candidate evidence is missing' }
if (-not (Test-Path -LiteralPath $candidateArchive -PathType Leaf)) { throw 'Task 27 candidate archive is missing' }
$candidateEvidenceSha256 = (Get-FileHash -LiteralPath $candidateEvidence -Algorithm SHA256).Hash.ToLowerInvariant()
$candidateArchiveSha256 = (Get-FileHash -LiteralPath $candidateArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ((git rev-parse HEAD).Trim() -ne $R27) { throw 'Source HEAD changed during R27 qualifying gate' }
if (@(git status --porcelain=v1 --untracked-files=all).Count -ne 0) { throw 'R27 qualifying gate mutated tracked source/index' }
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { throw 'R27 qualifying gate mutated source index' }
```

Expected: the exact-`R27` helper exits 0, the candidate evidence and OCI archive exist only at the absolute `.release/` paths, their hashes are retained for the evidence-child copy/readback, and all pinned exporter/buildx/BuildKit/context-root/OCI equality checks pass. These candidate files are not yet approved release evidence and cannot be consumed downstream.

- [ ] **Step 7: Commit and independently review evidence-only E27**

Copy only the verified candidate evidence into a detached worktree at exact `R27`, re-hash it, validate the closed schema and embedded `R27` review bytes, and commit direct child `E27`. The generated child path must be canonical and contained by the canonical non-reparse temp root. Prove `E27^ == R27` and the committed diff contains only `services/openclaw-zalo-cell/build-evidence.json`. Cleanup uses checked `git worktree remove --force`, including for a dirty child; cleanup failure must fail when no primary error exists and must be reported without masking a primary error. Fast-forward only after both the directory and Git registration are confirmed absent.

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
$releaseItem = Get-Item -LiteralPath $releaseRoot -ErrorAction Stop
$candidateItem = Get-Item -LiteralPath $candidateEvidence -ErrorAction Stop
if (($releaseItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($candidateItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Task 27 candidate evidence path must not be a reparse point' }
if ((Get-FileHash -LiteralPath $candidateEvidence -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateEvidenceSha256) { throw 'Task 27 candidate evidence changed before E27' }
if ((Get-FileHash -LiteralPath $candidateArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateArchiveSha256) { throw 'Task 27 candidate archive changed before E27' }
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRootItem = Get-Item -LiteralPath $tempRoot -ErrorAction Stop
if ($tempRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Temp root must not be a reparse point' }
$e27Worktree = [IO.Path]::GetFullPath((Join-Path $tempRoot ('ihome-openclaw-e27-' + [guid]::NewGuid().ToString('N'))))
$e27Relative = [IO.Path]::GetRelativePath($tempRoot, $e27Worktree)
if ([IO.Path]::IsPathRooted($e27Relative) -or $e27Relative -eq '..' -or $e27Relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)) { throw 'Detached E27 path escaped canonical temp root' }
$primaryError = $null
$cleanupError = $null
try {
  git worktree add --detach $e27Worktree $R27
  $e27Destination = Join-Path $e27Worktree 'services/openclaw-zalo-cell/build-evidence.json'
  Copy-Item -LiteralPath $candidateEvidence -Destination $e27Destination -ErrorAction Stop
  if ((Get-FileHash -LiteralPath $e27Destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateEvidenceSha256) { throw 'Copied E27 evidence hash mismatch' }
  Push-Location $e27Worktree
  try {
    node services/openclaw-zalo-cell/scripts/verify-image-lock.mjs --evidence services/openclaw-zalo-cell/build-evidence.json --schema services/openclaw-zalo-cell/build-evidence.schema.v1.json --reviewed-tree $R27 --release-artifact $candidateArchive
    git add services/openclaw-zalo-cell/build-evidence.json
    $e27Paths = @(git diff --cached --name-only)
    if (($e27Paths.Count -ne 1) -or ($e27Paths[0] -ne 'services/openclaw-zalo-cell/build-evidence.json')) { throw 'E27 staged diff is not evidence-only' }
    git commit -m "chore(openclaw-zalo): record Task 27 verified evidence E27" -m "Co-Authored-By: Codex <noreply@openai.com>"
    $E27 = (git rev-parse HEAD).Trim()
    if ((git rev-parse "$E27^").Trim() -ne $R27) { throw 'E27 is not a direct child of R27' }
    $e27CommittedPaths = @(git diff-tree --no-commit-id --name-only -r $E27)
    if (($e27CommittedPaths.Count -ne 1) -or ($e27CommittedPaths[0] -ne 'services/openclaw-zalo-cell/build-evidence.json')) { throw 'E27 committed diff is not evidence-only' }
  } finally {
    Pop-Location
  }
} catch {
  $primaryError = $_
} finally {
  try {
    $registeredPaths = @(git worktree list --porcelain | Where-Object { $_ -like 'worktree *' } | ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9)) })
    if (($registeredPaths -contains $e27Worktree) -or (Test-Path -LiteralPath $e27Worktree)) {
      git worktree remove --force $e27Worktree
      if ($LASTEXITCODE -ne 0) { throw 'Forced detached E27 worktree removal failed' }
    }
    if (Test-Path -LiteralPath $e27Worktree) { throw 'Detached E27 path remains after forced removal' }
    $remainingPaths = @(git worktree list --porcelain | Where-Object { $_ -like 'worktree *' } | ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9)) })
    if ($remainingPaths -contains $e27Worktree) { throw 'Detached E27 registration remains after forced removal' }
  } catch {
    $cleanupError = $_
  }
  if ($null -ne $primaryError) {
    if ($null -ne $cleanupError) { [Console]::Error.WriteLine('Detached E27 cleanup also failed: ' + $cleanupError.Exception.Message) }
    throw $primaryError
  }
  if ($null -ne $cleanupError) { throw $cleanupError }
}
if ((git rev-parse HEAD).Trim() -ne $R27) { throw 'Source branch moved before E27 fast-forward' }
git merge --ff-only $E27
if ((git rev-parse HEAD).Trim() -ne $E27) { throw 'Source branch did not fast-forward to E27' }
```

A second fresh read-only reviewer byte-compares committed evidence to the retained candidate hash, revalidates the schema, embedded exact-`R27` approval report, reviewed SHA, promoted archive hash/digest, and one-file parent/diff proof, then approves exact `E27` with empty findings. Task 28, pre-production review, rollout, and every downstream consumer may use only approved `E27`; neither `R27` alone nor uncommitted `.release/` candidates qualify.

### Task 28: Run Load, Egress, Recovery, And Co-Tenant Non-Regression Tests

**Files:**
- Create: `services/openclaw-zalo-bridge/test/load-egress.test.ts`
- Create: `infra/openclaw-zalo/test/recovery-drill.test.ts`
- Create: `scripts/__tests__/openclaw-cotenants.test.mjs`
- Create: `docs/openclaw-zalo/runbooks/load-test-results.md`

- [ ] **Step 1: Write failing capacity and recovery assertions**

Assert normal-operation inbound canonical p95 <=60 seconds, queue lag p95 <30 seconds for five minutes, bounded batch sizes, no O(N^2) Realtime refetch, spool pressure thresholds, no media blobs in Supabase JSON, private-ticket behavior, and unchanged synthetic co-tenant fixtures. Seed 10,000 conversation metadata rows and long threads only in the disposable local/ephemeral database; save `EXPLAIN (ANALYZE, BUFFERS)` evidence for inbox cursor, target/consent/suppression preflight, and `SKIP LOCKED` claim, rejecting unintended sequential scans on hot paths. Task 28 must not contact the shared Vultr host, shared Supabase project, production Worker/R2, or real organizations.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm --prefix services/openclaw-zalo-bridge test -- load-egress
npx vitest run infra/openclaw-zalo/test/recovery-drill.test.ts scripts/__tests__/openclaw-cotenants.test.mjs
```

Expected: FAIL until the soak fixtures and co-tenant snapshots are wired.

- [ ] **Step 3: Execute bounded soak and recovery drills**

Run a seven-day simulated/fake-adapter soak with the approved first-cell envelope: 100 active conversations, a 30-message/minute inbound burst for 15 minutes, AI concurrency 4, images <=5 MiB at 10/minute, and outbound capped at 200/day. Record synthetic CPU/RAM/disk, queue lag, UNKNOWN, reconnects, spool bytes/age, database egress counters, R2 request/storage counters, and broker bytes. Pass only when queue p95 <30 seconds, heartbeat remains fresh, and OpenClaw CPU/RAM remain below 70 percent of cap. In disposable containers/namespaces only, inject process loss, local Supabase outage, fake R2 outage, session kick, corrupt spool page, expired ticket, a bounded 20-GiB-equivalent ENOSPC fixture, media redirect/DNS-rebinding attacks, and old-cell fencing. Verify inbound bounded buffering, explicit gap reporting/history reconciliation, outbound fail-closed behavior, temp-media cleanup, and synthetic co-tenant invariants. The equivalent shared-host process-loss/ENOSPC/co-tenant drill is deferred to Task 29 after the reviewed-SHA gate.

- [ ] **Step 4: Verify co-tenant non-regression**

Run the relevant local/preview headless PWA/auth/finance suites plus `openclaw-cotenants.test.mjs` against a checked-in redacted baseline fixture and dependency-injected container/process client. The test proves the drill code would reject a changed ID/image/network/mount/restart counter, but it performs no SSH and never restarts or mutates legacy containers. Task 29 repeats the comparison against the live read-only snapshot before and after its isolated shared-host drill.

- [ ] **Step 5: Record evidence and run gates**

Run:

```powershell
npm --prefix services/openclaw-zalo-bridge test
npx vitest run infra/openclaw-zalo/test/recovery-drill.test.ts scripts/__tests__/openclaw-cotenants.test.mjs
node scripts/check-view-invoker.mjs
```

Expected: PASS with redacted results saved to `docs/openclaw-zalo/runbooks/load-test-results.md`.

- [ ] **Step 6: Commit**

```powershell
git add services/openclaw-zalo-bridge/test/load-egress.test.ts infra/openclaw-zalo/test/recovery-drill.test.ts scripts/__tests__/openclaw-cotenants.test.mjs docs/openclaw-zalo/runbooks/load-test-results.md
git commit -m "test(openclaw-zalo): xac minh capacity recovery va co-tenant" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 29: Execute Reviewed Production Rollout And Controlled Smoke

**Files:**
- Modify: `docs/openclaw-zalo/runbooks/deploy.md`
- Modify: `docs/openclaw-zalo/runbooks/operations.md`
- Create: `docs/openclaw-zalo/runbooks/production-smoke.md`
- Create: `scripts/apply-openclaw-reviewed-migrations.mjs`
- Create: `scripts/production-openclaw-smoke.mjs`
- Create: `scripts/__tests__/apply-openclaw-reviewed-migrations.test.mjs`
- Create: `scripts/__tests__/production-openclaw-smoke.test.mjs`
- Modify: `scripts/deploy-edge-fn.mjs`
- Modify: `scripts/__tests__/deploy-openclaw-edge-bundle.test.mjs`
- Modify: `.github/workflows/ci-gates.yml`

- [ ] **Step 1: Write failing migration, artifact, rollout, and smoke contract tests**

`apply-openclaw-reviewed-migrations.test.mjs` mocks the Management API and proves: exact project ref `tryymsxyyckgbrmmvozx`; exact PROD organization `aaaa0000-0000-4000-8000-000000000001` and DEMO organization `dddd0000-0000-4000-8000-000000000001` confirmation; clean working tree at the reviewed commit; the exact ordered 12-file migration list; per-file SHA-256 plus one aggregate manifest SHA-256; serial additive apply; flags-off activation guards; no organization-row fixture write; and an immediate stop on the first failure. It rejects a changed reviewed SHA, changed/reordered/unreviewed migration, schema already ahead in an unknown way, parallel apply, rollback/drop SQL, or any attempt to auto-revert. Failure output must prescribe only a reviewed forward corrective migration.

`production-openclaw-smoke.test.mjs` mocks every Supabase, Edge, Worker, Vultr, OpenClaw, and Zalo call. It proves the durable Task 7 stage order, exact reviewed SHA/artifact bindings, side-effect-free gate/readiness commands, preallocated smoke run IDs, immutable cleanup intent before mutation, one-send ceilings, organization-scoped `GLOBAL_STOP`, UNKNOWN never retried, and zero residual `QUEUED`/`LEASED`/`DISPATCHING` smoke rows. It scans stdout, stderr, JSON, and evidence files and fails on QR data, message/template content, tokens, cookies, IMEI, provider errors, or secret-shaped values.

The contract must exercise durable pauses `WAITING_OWNER_QR` and `WAITING_OWNER_INBOUND`. The script never creates or pretends to receive a real inbound message: the owner scans QR in CRM, and the approved existing-thread peer sends the real inbound. Resume commands bind only later canonical row IDs, hashes, generations, and timestamps. LIMITED observation may run in any number of short processes; promotion requires DB-clock proof of at least 72 continuous green hours, and any failed/stale observation resets or pauses the interval through CAS.

The contract parses the documented PowerShell and proves every native command, including `npm`, `npx`, `node`, `git`, `ssh`, and `scp`, either uses a checked helper or runs under a tested PowerShell 7.3+ native-error contract with `$ErrorActionPreference='Stop'` and `$PSNativeCommandUseErrorActionPreference=$true`. Injecting a nonzero command must throw before every later gate, commit, bundle, deploy, QR, or sentinel. Transport requires a pinned host key, fixed root provisioning user, fixed `openclaw-runner` runtime user, reviewed bundle SHA-256, and remote release path `/srv/openclaw-runtime/releases/REVIEWED_SHA`. Root commands may create the service user, fixed filesystem, rootless prerequisites, and systemd slice only; cell build/deploy/drills run as `openclaw-runner` and never mutate the rootful daemon, host-wide firewall, 9Router, or CLI proxy.

The production artifact contract requires the exact reviewed `services/openclaw-zalo-cell/scripts/build-reproducible-image.ps1` helper and Task 2 command. It rejects dirty/untracked/secret context input, host `node_modules`, an ad hoc `docker build`, tag/`--load`-only cell image, helper/input-manifest drift, a source epoch other than `1785062400`, mutable/wrong BuildKit or buildx versions, missing fresh-builder/no-cache/pull/build-arg/rewrite-timestamp/exporter locks, reused builders, non-distinct OCI archives, or evidence missing manifest/config/layer/mtime/package-epoch fields. Tests require exact lifecycle `R29 -> qualifying -ReviewedTree R29 build -> evidence-only direct child E29 -> independent E29 approval`; `E29^` must equal `R29`, `R29..E29` changes only `services/openclaw-zalo-cell/build-evidence.json`, and the committed evidence must bind image inputs to `R29`. The OCI archive remains an external verified candidate and may not enter `E29`. The final deploy bundle may be created only from approved `E29` Git blobs plus that exact archive by recorded hash/digest. Tests fail on ignored-only final evidence, bundle/Edge/Worker/VPS activity before E29 approval, missing/tampered archive, stale pre-image bundle, mismatched transfer manifest, or remote load of any other bytes.

- [ ] **Step 2: Run the failing contract tests**

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
npx vitest run scripts/__tests__/apply-openclaw-reviewed-migrations.test.mjs scripts/__tests__/production-openclaw-smoke.test.mjs scripts/__tests__/deploy-openclaw-edge-bundle.test.mjs scripts/__tests__/openclawCommandContract.test.mjs
```

Expected: FAIL because the reviewed migration/apply router, durable rollout engine, and artifact-verification extensions are absent.

- [ ] **Step 3: Implement, test, commit, and independently review all rollout tooling before execution**

`apply-openclaw-reviewed-migrations.mjs` accepts only the exact reviewed commit, project/org confirmations, and 12-file SHA-256 manifest. It reads migration bytes from `git show REVIEWED_SHA:supabase/migrations/FILE_NAME`, compares the local reviewed blob, applies one file at a time, verifies recorded remote migration identity after each success, and performs no fixture DML. It never invokes the live-DEMO harness. `production-openclaw-smoke.mjs` is a strict dependency-injected command router whose gate/readiness/lookup operations are read-only and whose mutation operations derive organization/account/target/version from trusted rows.

The rollout router exposes exact durable commands: `--create-reviewed-deploy-bundle`, `--verify-reviewed-deploy-bundle`, `--verify-final-image-reproduction`, `--begin-rollout`, `--resume-rollout`, `--record-observation`, `--check-gates`, `--verify-stage-evidence`, `--advance-stage`, `--lookup-canonical-cell`, `--bind-owner-qr`, `--bind-owner-inbound`, `--exercise-stop-switch`, `--manual-send`, `--limited-auto-reply`, `--proactive-schedule`, `--sales-group-schedule`, `--crm-event-to-group`, `--disconnect`, `--verify-run`, `--pause-and-cleanup`, and `--release-stop`. Bundle creation accepts only independently approved `E29` Git blobs, the committed evidence-only `build-evidence.json` whose reviewed-tree binding is exact `R29`, and the external promoted cell OCI archive whose hash/digest matches that evidence; verification reopens the tar and checks the embedded archive bytes/hash/digest plus `E29^==R29`. Final-image reproduction is read-only and compares the new R29-built candidate against committed E29 evidence, the E29-bound bundle, and the remote image digest. Every other mutating command requires literal PROD confirmation, a preallocated UUID run ID, expected rollout/control versions, and an existing cleanup-intent row. Machine reasons use `production-smoke:COMMAND_MODE:RUN_ID` from allowlisted command data; raw caller/provider text never becomes evidence.

Extend `deploy-edge-fn.mjs` with no-network `--emit-artifact-manifest` and deploy-time `--expect-artifact-sha256`. The manifest binds reviewed SHA, function name, exact entrypoint, bundled file list, and bundle SHA-256. Deploy output must return a version/deployment ID and server-observed artifact hash for readback. No deploy command accepts a dirty-worktree bundle.

Run the complete secret-free/local/ephemeral Tasks 27-28 matrix before any shared-project or host mutation:

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
npm ci
node scripts/check-openclaw-isolation.mjs
$env:SUPABASE_TYPES_SOURCE = 'local'
npm run gen:types
git diff --exit-code -- src/integrations/supabase/types.ts
Remove-Item Env:SUPABASE_TYPES_SOURCE
node scripts/check-view-invoker.mjs
npm run typecheck:baseline
npx tsc --noEmit -p tsconfig.app.json
npx vitest run src/lib/openclaw-zalo src/hooks/openclaw-zalo src/components/openclaw-zalo src/pages/openclaw-zalo src/lib/__tests__/openclawFullContract.test.ts scripts/__tests__/openclawCommandContract.test.mjs scripts/__tests__/production-openclaw-smoke.test.mjs scripts/__tests__/apply-openclaw-reviewed-migrations.test.mjs
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge ci
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run verify:upstream
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run vendor:prepare
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run typecheck
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge test
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run build
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run pack
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run verify:artifact
npm --prefix services/openclaw-zalo-cell/session-crypto ci
npx vitest run services/openclaw-zalo-cell/test/image-contract.test.mjs
npm --prefix services/openclaw-zalo-bridge ci
npm --prefix services/openclaw-zalo-maintenance ci
npm --prefix services/openclaw-egress-broker ci
npm --prefix infra/openclaw-media-gateway ci
npm --prefix infra/openclaw-zalo-watchdog ci
npm run test:openclaw:services
npm run test:openclaw:sql
npm run test:openclaw:r2
npm --prefix services/openclaw-zalo-bridge test -- load-egress
npx vitest run infra/openclaw-zalo/test/recovery-drill.test.ts scripts/__tests__/openclaw-cotenants.test.mjs
Push-Location .e2e-fleet
$env:FLEET_WORKERS = '8'
$env:FLEET_BASE_URL = 'http://127.0.0.1:4173'
$env:FLEET_OPENCLAW_FIXTURE_ENV = 'local-preview'
$env:FLEET_OPENCLAW_PROJECT_REF = 'local'
npx playwright test specs/openclaw-zalo.spec.ts
Pop-Location
```

Commit the tested tooling/runbooks before rollout:

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
git add docs/openclaw-zalo/runbooks/deploy.md docs/openclaw-zalo/runbooks/operations.md docs/openclaw-zalo/runbooks/production-smoke.md scripts/apply-openclaw-reviewed-migrations.mjs scripts/production-openclaw-smoke.mjs scripts/__tests__/apply-openclaw-reviewed-migrations.test.mjs scripts/__tests__/production-openclaw-smoke.test.mjs scripts/deploy-edge-fn.mjs scripts/__tests__/deploy-openclaw-edge-bundle.test.mjs .github/workflows/ci-gates.yml
if (git diff --cached --name-only | Select-String '(^|/)build-evidence\.json$') { throw 'R29 must not update tracked image evidence' }
git commit -m "chore(openclaw-zalo): san sang rollout production co kiem soat" -m "Co-Authored-By: Codex <noreply@openai.com>"
$R29 = (git rev-parse HEAD).Trim()
```

A fresh independent reviewer then inspects the complete implementation, migrations, deployment scripts, runbooks, and no-secret source state at exact commit `R29`, not this plan alone. Resolve every valid finding in a new exact-file commit and rerun the affected matrix until the reviewer approves one clean `R29` with empty findings. Set `OPENCLAW_REVIEWED_R29_SHA` to that exact 40-hex SHA, require `git rev-parse HEAD` to equal it and `git status --porcelain` to be empty. Freeze the reviewed source identity here, but do not create the final deploy tar or deploy any Edge/Worker/VPS artifact yet. Step 5 must reproduce the cell image from exact `R29`, create and independently approve evidence-only `E29`, and only Step 6 may create the final bundle from approved `E29` plus the external OCI bytes. No rollout script/runbook commit is permitted after the first production mutation.

- [ ] **Step 4: Apply the reviewed additive schema, verify drift, then run protected live-DEMO SQL**

This is the first production-environment mutation. It changes only additive project-wide schema with every feature flags-off; it performs no PROD organization row write. Build the exact reviewed migration manifest and apply serially:

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
$R29 = $env:OPENCLAW_REVIEWED_R29_SHA
if ($R29 -notmatch '^[0-9a-f]{40}$') { throw 'OPENCLAW_REVIEWED_R29_SHA must be exact reviewed R29' }
if ((git rev-parse HEAD).Trim() -ne $R29) { throw 'HEAD is not exact reviewed R29' }
if (git status --porcelain) { throw 'Working tree must be clean' }

$migrations = @(
  '20260727010000_openclaw_catalog_foundation.sql',
  '20260727015000_openclaw_security_principals.sql',
  '20260727020000_openclaw_inbox_schema.sql',
  '20260727025000_openclaw_inbound_automation.sql',
  '20260727030000_openclaw_policy_automation_knowledge.sql',
  '20260727040000_openclaw_delivery_audit_ops.sql',
  '20260727050000_openclaw_access_policies.sql',
  '20260727060000_openclaw_rpc_surface.sql',
  '20260727070000_openclaw_crm_event_sources.sql',
  '20260727080000_openclaw_realtime_allowlist.sql',
  '20260727090000_openclaw_maintenance_jobs.sql',
  '20260727095000_openclaw_activation_guards.sql'
)
node scripts/apply-openclaw-reviewed-migrations.mjs --reviewed-sha $R29 --project-ref tryymsxyyckgbrmmvozx --confirm-project tryymsxyyckgbrmmvozx --prod-organization aaaa0000-0000-4000-8000-000000000001 --demo-organization dddd0000-0000-4000-8000-000000000001 --confirm-production-schema tryymsxyyckgbrmmvozx:aaaa0000-0000-4000-8000-000000000001 --migration-files $migrations
node scripts/check-view-invoker.mjs
npm run gen:types
git diff --exit-code -- src/integrations/supabase/types.ts
node scripts/test-openclaw-migrations.mjs --schema-drift --project-ref tryymsxyyckgbrmmvozx --reviewed-sha $R29
npm run test:openclaw:sql:live-demo
```

The protected live-DEMO helpers run only in the authorized environment after schema apply, use rollback-only DEMO fixtures, and never apply migrations. Verify public views, generated types, function owners/grants, exact 12-file remote manifest, and activation flags. This schema mutation is bound to reviewed source `R29`; it does not authorize a final cell bundle or any Edge/Worker/VPS deployment. Those remain blocked until exact `E29` is created as the evidence-only direct child of `R29` and independently approved. On any apply/post-check/live-DEMO failure, stop before image evidence, bundle, Edge, Worker, VPS, or QR; retain applied evidence and ship only a separately reviewed forward corrective migration. Never down-migrate, drop canonical/evidence tables, or rewrite migration history.

- [ ] **Step 5: Build from reviewed R29, create evidence-only E29, and review it**

Run the canonical cell image gate only from clean exact `R29`. Build with exact `-ReviewedTree $R29`, absolute pinned `-BuildxPath`, Git-blob context-root v2, the exact two-stage `install`/`runtime` Dockerfile, no in-image session-crypto install/build, exactly the three reviewed session dist inputs, Node-first network-none local-tgz install with one fresh empty cache, minimal final rootfs, exact BuildKit pin, two fresh builders, and byte-identical OCI archive/layout/index/blob results. Write candidate evidence and the candidate OCI archive only under ignored `.release/`; neither is deployable yet.

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
$R29 = $env:OPENCLAW_REVIEWED_R29_SHA
if ($R29 -notmatch '^[0-9a-f]{40}$') { throw 'OPENCLAW_REVIEWED_R29_SHA must be exact reviewed R29' }
if ((git rev-parse HEAD).Trim() -ne $R29) { throw 'HEAD is not exact reviewed R29' }
if (@(git status --porcelain=v1 --untracked-files=all).Count -ne 0) { throw 'R29 worktree is not completely clean' }
$sourceRoot = (Resolve-Path -LiteralPath '.').Path
$buildxPath = (Resolve-Path -LiteralPath $env:OPENCLAW_BUILDX_PATH -ErrorAction Stop).Path
$reviewedImageHelper = (Resolve-Path -LiteralPath 'services/openclaw-zalo-cell/scripts/build-reproducible-image.ps1' -ErrorAction Stop).Path
$reviewedImageHelperSha256 = (Get-FileHash -LiteralPath $reviewedImageHelper -Algorithm SHA256).Hash.ToLowerInvariant()
$releaseRoot = Join-Path $sourceRoot 'services/openclaw-zalo-cell/.release'
$candidateEvidence = Join-Path $releaseRoot 'task29-build-evidence.json'
$candidateArchive = Join-Path $releaseRoot 'task29-openclaw-zalo-cell-linux-amd64.oci.tar'
New-Item -ItemType Directory -Path $releaseRoot -Force -ErrorAction Stop | Out-Null
if (Test-Path -LiteralPath $candidateEvidence) { throw 'Stale Task 29 candidate evidence exists' }
if (Test-Path -LiteralPath $candidateArchive) { throw 'Stale Task 29 candidate archive exists' }
& $reviewedImageHelper -ReviewedTree $R29 -BuildxPath $buildxPath -Platform 'linux/amd64' -SourceDateEpoch '1785062400' -BaselineEvidencePath (Join-Path $sourceRoot 'services/openclaw-zalo-cell/build-evidence.json') -EvidencePath $candidateEvidence -ReleaseArtifactPath $candidateArchive
if (-not (Test-Path -LiteralPath $candidateEvidence -PathType Leaf)) { throw 'Task 29 candidate evidence is missing' }
if (-not (Test-Path -LiteralPath $candidateArchive -PathType Leaf)) { throw 'Task 29 candidate OCI archive is missing' }
$candidateEvidenceSha256 = (Get-FileHash -LiteralPath $candidateEvidence -Algorithm SHA256).Hash.ToLowerInvariant()
$candidateArchiveSha256 = (Get-FileHash -LiteralPath $candidateArchive -Algorithm SHA256).Hash.ToLowerInvariant()
$candidateJson = Get-Content -LiteralPath $candidateEvidence -Raw | ConvertFrom-Json
if ($candidateJson.helper_sha256 -ne $reviewedImageHelperSha256) { throw 'Task 29 evidence helper SHA does not match reviewed R29 helper' }
if ($candidateJson.promoted_archive_sha256 -ne $candidateArchiveSha256) { throw 'Task 29 candidate archive hash does not match evidence' }
if ((git rev-parse HEAD).Trim() -ne $R29) { throw 'Source HEAD changed during Task 29 image gate' }
if (@(git status --porcelain=v1 --untracked-files=all).Count -ne 0) { throw 'Task 29 image gate mutated source/index' }
```

Create `E29` as a detached direct child of `R29`. Copy only candidate evidence into the tracked path, verify it with the exact reviewed child-worktree verifier and the retained absolute candidate archive, commit the one-file diff, and force-clean the child without masking a primary error. The OCI archive remains external and must never be staged or committed.

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
$R29 = $env:OPENCLAW_REVIEWED_R29_SHA
$sourceRoot = (Resolve-Path -LiteralPath '.').Path
$releaseRoot = Join-Path $sourceRoot 'services/openclaw-zalo-cell/.release'
$candidateEvidence = Join-Path $releaseRoot 'task29-build-evidence.json'
$candidateArchive = Join-Path $releaseRoot 'task29-openclaw-zalo-cell-linux-amd64.oci.tar'
$releaseItem = Get-Item -LiteralPath $releaseRoot -ErrorAction Stop
$candidateEvidenceItem = Get-Item -LiteralPath $candidateEvidence -ErrorAction Stop
$candidateArchiveItem = Get-Item -LiteralPath $candidateArchive -ErrorAction Stop
if ($candidateEvidenceItem.PSIsContainer -or $candidateArchiveItem.PSIsContainer) { throw 'Task 29 candidates must be files' }
if (($releaseItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($candidateEvidenceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($candidateArchiveItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Task 29 candidate paths must not be reparse points' }
$candidateEvidenceSha256 = (Get-FileHash -LiteralPath $candidateEvidence -Algorithm SHA256).Hash.ToLowerInvariant()
$candidateArchiveSha256 = (Get-FileHash -LiteralPath $candidateArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ((git rev-parse HEAD).Trim() -ne $R29) { throw 'E29 must start from exact R29' }
if (@(git status --porcelain=v1 --untracked-files=all).Count -ne 0) { throw 'R29 source worktree is not completely clean' }
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRootItem = Get-Item -LiteralPath $tempRoot -ErrorAction Stop
if ($tempRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Temp root must not be a reparse point' }
$e29Worktree = [IO.Path]::GetFullPath((Join-Path $tempRoot ('ihome-openclaw-e29-' + [guid]::NewGuid().ToString('N'))))
$e29Relative = [IO.Path]::GetRelativePath($tempRoot, $e29Worktree)
if ([IO.Path]::IsPathRooted($e29Relative) -or $e29Relative -eq '..' -or $e29Relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)) { throw 'Detached E29 path escaped canonical temp root' }
$primaryError = $null
$cleanupError = $null
try {
  git worktree add --detach $e29Worktree $R29
  $e29Destination = Join-Path $e29Worktree 'services/openclaw-zalo-cell/build-evidence.json'
  Copy-Item -LiteralPath $candidateEvidence -Destination $e29Destination -ErrorAction Stop
  if ((Get-FileHash -LiteralPath $e29Destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateEvidenceSha256) { throw 'Copied E29 evidence hash mismatch' }
  if ((Get-FileHash -LiteralPath $candidateArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidateArchiveSha256) { throw 'Task 29 candidate archive changed before E29 verification' }
  Push-Location $e29Worktree
  try {
    node services/openclaw-zalo-cell/scripts/verify-image-lock.mjs --evidence services/openclaw-zalo-cell/build-evidence.json --schema services/openclaw-zalo-cell/build-evidence.schema.v1.json --reviewed-tree $R29 --release-artifact $candidateArchive
    git add services/openclaw-zalo-cell/build-evidence.json
    $e29Paths = @(git diff --cached --name-only)
    if (($e29Paths.Count -ne 1) -or ($e29Paths[0] -ne 'services/openclaw-zalo-cell/build-evidence.json')) { throw 'E29 staged diff is not evidence-only' }
    git commit -m "chore(openclaw-zalo): record Task 29 final image evidence E29" -m "Co-Authored-By: Codex <noreply@openai.com>"
    $E29 = (git rev-parse HEAD).Trim()
    if ((git rev-parse "$E29^").Trim() -ne $R29) { throw 'E29 is not a direct child of R29' }
    $e29CommittedPaths = @(git diff-tree --no-commit-id --name-only -r $E29)
    if (($e29CommittedPaths.Count -ne 1) -or ($e29CommittedPaths[0] -ne 'services/openclaw-zalo-cell/build-evidence.json')) { throw 'E29 committed diff is not evidence-only' }
  } finally {
    Pop-Location
  }
} catch {
  $primaryError = $_
} finally {
  try {
    $registeredPaths = @(git worktree list --porcelain | Where-Object { $_ -like 'worktree *' } | ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9)) })
    if (($registeredPaths -contains $e29Worktree) -or (Test-Path -LiteralPath $e29Worktree)) {
      git worktree remove --force $e29Worktree
      if ($LASTEXITCODE -ne 0) { throw 'Forced detached E29 worktree removal failed' }
    }
    if (Test-Path -LiteralPath $e29Worktree) { throw 'Detached E29 path remains after forced removal' }
    $remainingPaths = @(git worktree list --porcelain | Where-Object { $_ -like 'worktree *' } | ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9)) })
    if ($remainingPaths -contains $e29Worktree) { throw 'Detached E29 registration remains after forced removal' }
  } catch {
    $cleanupError = $_
  }
  if ($null -ne $primaryError) {
    if ($null -ne $cleanupError) { [Console]::Error.WriteLine('Detached E29 cleanup also failed: ' + $cleanupError.Exception.Message) }
    throw $primaryError
  }
  if ($null -ne $cleanupError) { throw $cleanupError }
}
if ((git rev-parse HEAD).Trim() -ne $R29) { throw 'Source branch moved before E29 fast-forward' }
git merge --ff-only $E29
if ((git rev-parse HEAD).Trim() -ne $E29) { throw 'Source branch did not fast-forward to E29' }
```

A fresh independent reviewer must inspect exact `E29`, exact `R29`, the `R29` approval report, the retained candidate OCI archive/hash, the closed schema, and `R29..E29`. It must re-run the verifier, prove `E29^==R29`, prove the one-file evidence diff, confirm the evidence's reviewed-tree/input binding remains exact `R29`, and return `APPROVED` with empty findings. Set `OPENCLAW_REVIEWED_E29_SHA` only to that approved exact SHA. No deploy bundle, Edge/Worker deploy, VPS transfer/load, or QR action may occur before this approval.

- [ ] **Step 6: Create the E29-bound bundle, deploy Edge and Workers, and read back versions**

Require approved `E29` as the final deployment identity while preserving the cell image's exact `R29` input binding. Re-verify the committed evidence against the external archive, then create the bundle from approved `E29` Git blobs and add the OCI archive only by its recorded hash; the archive is not part of the `E29` commit.

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
$R29 = $env:OPENCLAW_REVIEWED_R29_SHA
$E29 = $env:OPENCLAW_REVIEWED_E29_SHA
if ($R29 -notmatch '^[0-9a-f]{40}$' -or $E29 -notmatch '^[0-9a-f]{40}$') { throw 'Exact reviewed R29 and E29 SHAs are required' }
if ((git rev-parse HEAD).Trim() -ne $E29) { throw 'HEAD is not exact approved E29' }
if ((git rev-parse "$E29^").Trim() -ne $R29) { throw 'Approved E29 is not a direct child of R29' }
$e29Paths = @(git diff-tree --no-commit-id --name-only -r $E29)
if (($e29Paths.Count -ne 1) -or ($e29Paths[0] -ne 'services/openclaw-zalo-cell/build-evidence.json')) { throw 'Approved E29 is not evidence-only' }
if (git status --porcelain) { throw 'E29 worktree must be clean' }
$sourceRoot = (Resolve-Path -LiteralPath '.').Path
$releaseCellImage = Join-Path $sourceRoot 'services/openclaw-zalo-cell/.release/task29-openclaw-zalo-cell-linux-amd64.oci.tar'
node services/openclaw-zalo-cell/scripts/verify-image-lock.mjs --evidence services/openclaw-zalo-cell/build-evidence.json --schema services/openclaw-zalo-cell/build-evidence.schema.v1.json --reviewed-tree $R29 --release-artifact $releaseCellImage
$cellImageEvidence = Get-Content -LiteralPath 'services/openclaw-zalo-cell/build-evidence.json' -Raw | ConvertFrom-Json
$releaseCellImageSha256 = (Get-FileHash -LiteralPath $releaseCellImage -Algorithm SHA256).Hash.ToLowerInvariant()
if ($releaseCellImageSha256 -ne $cellImageEvidence.promoted_archive_sha256) { throw 'Approved E29 archive hash mismatch' }
node scripts/production-openclaw-smoke.mjs --create-reviewed-deploy-bundle --reviewed-sha $E29 --cell-reviewed-tree $R29 --cell-image $releaseCellImage --cell-evidence services/openclaw-zalo-cell/build-evidence.json --cell-image-sha256 $releaseCellImageSha256 --cell-image-digest $cellImageEvidence.image_digest --output $env:OPENCLAW_REVIEWED_DEPLOY_BUNDLE
$reviewedSha = $E29
```

The bundle creator exports source/config only from approved `E29` Git blobs, proves `E29^==R29`, adds the exact promoted OCI archive plus content-free evidence/transfer manifest, reopens the final tar, and verifies archive hash/image digest before recording the bundle SHA-256. Build the other runtime images for `linux/amd64`; rerun mandatory online npm attestation/SLSA verification for this release (metadata/network failure is a hard stop; offline verification cannot create release evidence/artifacts), then verify Task 2's bounded redirect/final URL/size/count/SRI/SHA-1 locks, base digest `sha256:165b4992f1b4b74ffdd7a02c887ba006f9f5dc951eca420eef573a8b233b543f`, exact git head/75-blob source, reviewed license-manifest hash/counts, rendered legal outputs, `artifactMembers`, runtime reachability allowlist, patch-series SHA-256, built-tgz SHA-256, install/load/upstream-compatible/differential results, reviewer approval, installed fork digest/list, deterministic cell OCI/image evidence, and architecture-specific bridge, maintenance, and egress-broker image digests. Reject tags, local mutable images, wrong architecture, registry ZaloUser resolution, duplicate packages, a vendor/installed directory hidden by a mount, missing/mismatched provenance/compliance/member/context/builder/exporter/image evidence, or a bundle created before E29 approval.

Deploy the six Edge functions in this exact order, with the watchdog Edge endpoint before either Worker:

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
$R29 = $env:OPENCLAW_REVIEWED_R29_SHA
$reviewedSha = $env:OPENCLAW_REVIEWED_E29_SHA
if ((git rev-parse HEAD).Trim() -ne $reviewedSha -or (git rev-parse "$reviewedSha^").Trim() -ne $R29) { throw 'Edge/Worker deployment requires approved E29 direct child of R29' }
node scripts/deploy-edge-fn.mjs openclaw-runtime-token --no-verify-jwt --include-shared openclaw --reviewed-sha $reviewedSha --expect-artifact-sha256 $env:OPENCLAW_EDGE_RUNTIME_TOKEN_SHA256
node scripts/deploy-edge-fn.mjs openclaw-runtime --no-verify-jwt --include-shared openclaw --reviewed-sha $reviewedSha --expect-artifact-sha256 $env:OPENCLAW_EDGE_RUNTIME_SHA256
node scripts/deploy-edge-fn.mjs openclaw-object-tickets --include-shared openclaw --reviewed-sha $reviewedSha --expect-artifact-sha256 $env:OPENCLAW_EDGE_OBJECT_TICKETS_SHA256
node scripts/deploy-edge-fn.mjs openclaw-control --include-shared openclaw --reviewed-sha $reviewedSha --expect-artifact-sha256 $env:OPENCLAW_EDGE_CONTROL_SHA256
node scripts/deploy-edge-fn.mjs openclaw-qr --include-shared openclaw --reviewed-sha $reviewedSha --expect-artifact-sha256 $env:OPENCLAW_EDGE_QR_SHA256
node scripts/deploy-edge-fn.mjs openclaw-watchdog --no-verify-jwt --include-shared openclaw --reviewed-sha $reviewedSha --expect-artifact-sha256 $env:OPENCLAW_EDGE_WATCHDOG_SHA256
npm --prefix infra/openclaw-media-gateway run deploy -- --expected-bundle-sha256 $env:OPENCLAW_MEDIA_WORKER_SHA256
npm --prefix infra/openclaw-zalo-watchdog run deploy -- --expected-bundle-sha256 $env:OPENCLAW_WATCHDOG_WORKER_SHA256
```

Read back and persist exact `R29`, approved/deployed `E29`, their parent relation, the one-file evidence diff, every Edge function version/deployment ID/artifact hash, media Worker deployment version/bundle hash/route, watchdog Worker deployment version/bundle hash, R2 private-bucket settings, and all four image digests. Create `ihome-openclaw-media-private` only if absent; verify no public R2 URL, `workers_dev=false`, exact route `openclaw-media.chillhome.io.vn/*`, signed watchdog negative paths, and redacted health. Any hash/version/identity mismatch stops before SSH or QR.

- [ ] **Step 7: Transfer the reviewed bundle, provision rootless runtime, and run the live shared-host drill**

The runbook defines `Invoke-NativeChecked`, `Invoke-NativeJsonChecked`, and `Invoke-SmokeChecked` before the first command. `OPENCLAW_VULTR_HOST`, `OPENCLAW_VULTR_HOST_KEY_SHA256`, and a root-owned known-hosts file are required; the script verifies the presented key fingerprint without trusting `ssh-keyscan` output. `scp` transfers only the final approved-`E29` tar created in Step 6, whose SHA-256, `E29^==R29` relation, and embedded cell archive hash/digest are recorded in the transfer manifest, to `/srv/openclaw-runtime/releases/E29/deploy.tar`. Root verifies the bundle and embedded archive hashes before extraction, then creates the fixed filesystem/service user/rootless prerequisites/systemd slice and exits. As `openclaw-runner`, a checked command loads only that exact archive into the private rootless daemon, inspects the loaded `linux/amd64` image digest against the `R29`-bound evidence committed by `E29`, and aborts before Compose on missing/tampered/wrong bytes. Every image load, Compose render/deploy, fault drill, and runtime check uses checked wrappers and the private rootless socket.

Run read-only preflight and co-tenant snapshots before mutation. Deploy only the isolated project, then perform the real shared-host process-loss, bounded ENOSPC, session-crypto restart/tamper/rotation, egress-negative, and co-tenant comparison drill moved from Task 28. The fault injection targets only the rootless OpenClaw slice/filesystem; 9Router/CLI IDs, images, start times, restart counts, networks, mounts, latency, and errors must remain unchanged. Restore the OpenClaw stack, prove zero residual fault state, and abort before QR on any co-tenant delta.

Resolve the canonical cell from trusted DB state and use the returned value, never free-form caller input:

```powershell
$cellResult = Invoke-NativeJsonChecked -FilePath 'node' -ArgumentList @('scripts/production-openclaw-smoke.mjs', '--lookup-canonical-cell', '--organization', 'aaaa0000-0000-4000-8000-000000000001', '--reviewed-sha', $reviewedSha) -Label 'canonical cell lookup'
$canonicalCellId = $cellResult.cellId
if (-not $canonicalCellId) { throw 'Canonical cell lookup returned no cellId' }
Invoke-NativeChecked -FilePath 'ssh' -ArgumentList @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', "UserKnownHostsFile=$env:OPENCLAW_KNOWN_HOSTS_FILE", "openclaw-runner@$env:OPENCLAW_VULTR_HOST", "infra/openclaw-zalo/scripts/verify-isolation.sh --session-encryption --cell-id $canonicalCellId") -Label 'live isolation verification'
```

Before QR, run a side-effect-free fork readiness probe that proves `zalouser.bridge.send` is registered, the generic `send` method and message/direct-adapter business paths are denied, no provider frame is emitted, and the running package/tgz/image hashes match reviewed evidence. Record only content-free host baseline, reviewed bundle SHA-256, upstream/patch/tgz/package/image digests, tmpfs/ciphertext/key-generation evidence, fault results, and co-tenant comparison. Infrastructure gate must pass before connection.

- [ ] **Step 8: Persist WAITING_OWNER_QR, bind the owner's real QR action, and observe shadow**

Begin/resume the canonical rollout run at the reviewed SHA and persist `WAITING_OWNER_QR`. The script may verify that the authenticated CRM challenge exists, but it never scans QR, stores QR evidence, or marks success itself. The owner acknowledges the disclosure and scans the fresh QR in CRM; a later resume binds the canonical used challenge, connection generation, session generation, and cell health without QR content.

Connection verification requires canonical separation: `connection_state='CONNECTED'`, a separately acceptable session-risk state, and `effective_mode='DRAFT_ONLY'`. No persisted or expected connection state named `CONNECTED_DRAFT_ONLY` is allowed. Automation/proactive/group flags remain off.

Keep shadow mode for at least 48 hours through durable `--record-observation` calls that can run from CI/manual invocations across process restarts. Only content-free inbound/draft/health/queue/UNKNOWN/co-tenant metrics are stored; no auto-send occurs. `--verify-stage-evidence --stage shadow --min-continuous-green-hours 48` and expected-version `--advance-stage` must pass before the inbound-owner checkpoint.

- [ ] **Step 9: Persist WAITING_OWNER_INBOUND and accumulate at least 72 continuous green LIMITED hours**

Persist `WAITING_OWNER_INBOUND` with the exact approved existing-thread peer and checkpoint timestamp. The script waits/resumes without synthesizing traffic. The owner or approved peer sends a real inbound message through Zalo; a later `--bind-owner-inbound` call finds a matching canonical inbound event after the checkpoint, verifies consent/peer/account/session, and stores only event/message IDs, hashes, and timestamps.

Advance to `LIMITED_OBSERVING`, enable only the approved limited auto-reply scope, and keep one-reply ceilings plus 3-8 second warm-up delay. Run `--record-observation` repeatedly from short-lived invocations. Every observation rechecks DLP/policy/session/health, queue p95, UNKNOWN threshold, rate caps, co-tenant SLO, and exact reviewed artifacts. A failed or stale interval atomically clears/pauses `continuous_green_started_at`; it never counts around a gap.

Only after DB time proves at least 72 continuous green hours may these commands succeed:

```powershell
Invoke-SmokeChecked -Arguments @('--verify-stage-evidence', '--stage', 'limited-inbound', '--min-continuous-green-hours', '72', '--organization', 'aaaa0000-0000-4000-8000-000000000001', '--run-id', $env:OPENCLAW_ROLLOUT_RUN_ID) -Label '72-hour evidence'
Invoke-SmokeChecked -Arguments @('--advance-stage', '--from', 'LIMITED_OBSERVING', '--to', 'LIMITED_VERIFIED', '--expected-version', $env:OPENCLAW_ROLLOUT_VERSION, '--run-id', $env:OPENCLAW_ROLLOUT_RUN_ID, '--confirm-production', "aaaa0000-0000-4000-8000-000000000001:$env:OPENCLAW_SMOKE_ACCOUNT_ID") -Label 'advance limited stage'
```

There is no requirement or permission to keep one PowerShell process alive for 72 hours. A resume reads canonical stage/version/continuous interval and continues safely.

- [ ] **Step 10: Run bounded outbound stages, cleanup, and reconnect verification**

Before the first real outbound, run the organization-scoped `GLOBAL_STOP` exercise: block an undispatched smoke item, verify the control-version/audit change, cleanup and prove zero residual while the stop remains active, then release only with the explicit operator reason `production-smoke-complete`. Any failure preserves the stop. The fake adapter supplies the UNKNOWN simulation; production UNKNOWN is never intentionally created or retried.

Run one manual send, one limited reply bound to a fresh approved-peer inbound, one consented proactive schedule, one exact allowlisted sales-group schedule, and one CRM-event group occurrence/replay. Each command uses its own preallocated run ID, trusted target/version lookup, one-send ceiling, immutable cleanup intent, checked verification, and `--pause-and-cleanup` in `finally`. Proactive/group commands remain blocked until `LIMITED_VERIFIED`; schedules must map to 08:00-20:00 `Asia/Ho_Chi_Minh`, group directory freshness is at most 24 hours, and replay proves one outbox.

Disconnect increments session generation, waits for signed media-generation revocation acknowledgement, removes old session material, and persists another `WAITING_OWNER_QR` checkpoint. After the owner acknowledges the renewed disclosure when canonical LIMITED/session-theft history requires it and scans a fresh QR, resume/bind the real QR evidence and verify `connection_state='CONNECTED'`, separate session risk, and `effective_mode='DRAFT_ONLY'`. Automation is not restored automatically.

Every cleanup retains immutable audit/delivery/rollout evidence, deletes only tagged smoke fixtures, and proves zero residual `QUEUED`/`LEASED`/`DISPATCHING` rows. The script stops immediately on session warning, console error, unexpected UNKNOWN, provider limitation, missing cleanup proof, artifact drift, session-encryption failure, or co-tenant regression.

- [ ] **Step 11: Freeze deployed evidence for Task 30**

Record exact source/input commit `R29`, exact approved/deployed evidence commit `E29`, proof `E29^==R29`, the one-file `build-evidence.json` diff, both independent approval digests, aggregate migration manifest SHA-256, six Edge versions/hashes, two Worker versions/hashes, release-time mandatory attestation/SLSA proof, bounded redirect/final URL/size/count/SRI/SHA-1 locks, git head/75-blob source manifest, reviewed license-manifest SHA/counts, legal-output hashes, artifact-member/reachability manifests, install/load/upstream-compatible/differential results, patch-series SHA-256, built-tgz SHA-256, installed fork digest/list, clean-context manifest SHA-256, reviewed helper SHA-256, pinned buildx/BuildKit image/version and exporter options, source epoch/layer mtimes, both OCI archive hashes, matching manifest/config/layer digests, package-metadata epoch, external promoted archive path/hash/digest, final E29-bound deploy-bundle/transfer-manifest SHA-256, remote loaded image digest, architecture-specific bridge/maintenance/egress image digests, canonical cell ID, owner checkpoint IDs, continuous observation windows, smoke cleanup proofs, and co-tenant before/after hashes in the canonical rollout/audit stores. Store no content or secrets. Do not commit or cherry-pick a plan-only or post-rollout script change; Task 30 reviews this final implementation/runbook/evidence set at deployed `E29` while re-verifying that the cell image evidence binds exact `R29`.

### Task 30: Verify The Deployed SHA, Review Evidence, And Hand Off

**Files:**
- Review: complete implementation and tests at `OPENCLAW_DEPLOYED_SHA`
- Review: `docs/superpowers/specs/2026-07-26-openclaw-zalo-personal-design.md`
- Review: `docs/superpowers/plans/2026-07-26-openclaw-zalo-personal.md`
- Review: `docs/openclaw-zalo/runbooks/**` at `OPENCLAW_DEPLOYED_SHA`
- Review: canonical rollout/audit/deployment evidence emitted by Task 29

- [ ] **Step 1: Verify exact deployed identity before any final claim**

Require `OPENCLAW_DEPLOYED_SHA` to be exact independently approved `E29`, equal to `OPENCLAW_REVIEWED_E29_SHA` and current clean `HEAD`; require `OPENCLAW_REVIEWED_R29_SHA` to be exact `E29^`, and require `R29..E29` to change only `services/openclaw-zalo-cell/build-evidence.json`. Read back both review reports, the aggregate 12-migration manifest SHA-256, Edge/Worker versions and hashes, upstream/source/patch/tgz/package locks, clean-context manifest SHA-256, reviewed helper SHA-256, buildx/BuildKit image/version/exporter locks, source epoch/layer mtimes, both OCI hashes and matching manifest/config/layers, package epoch, external promoted archive hash/digest, final E29-bound bundle/transfer-manifest SHA-256, remote loaded image digest, other runtime image digests, canonical cell ID, and rollout run ID. Compare every value with Task 29's immutable evidence and reviewed blobs, while proving image evidence names exact `R29` and deployment/bundle identity names exact `E29`; missing, stale, mutable, or mismatched parent/diff/input/archive/bundle/load evidence fails final verification.

- [ ] **Step 2: Run the complete local/static/package/E2E matrix at the deployed SHA**

Run exactly:

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
$R29 = $env:OPENCLAW_REVIEWED_R29_SHA
$E29 = $env:OPENCLAW_DEPLOYED_SHA
if ($env:OPENCLAW_REVIEWED_E29_SHA -ne $E29) { throw 'Approved E29 and deployed SHA differ' }
if ((git rev-parse HEAD).Trim() -ne $E29) { throw 'HEAD does not match deployed E29' }
if ((git rev-parse "$E29^").Trim() -ne $R29) { throw 'Deployed E29 is not a direct child of reviewed R29' }
$e29Paths = @(git diff-tree --no-commit-id --name-only -r $E29)
if (($e29Paths.Count -ne 1) -or ($e29Paths[0] -ne 'services/openclaw-zalo-cell/build-evidence.json')) { throw 'Deployed E29 is not evidence-only' }
if (git status --porcelain) { throw 'Working tree must be clean' }

npm ci
node scripts/check-openclaw-isolation.mjs
npm run gen:types
git diff --exit-code -- src/integrations/supabase/types.ts
node scripts/check-view-invoker.mjs
npm run typecheck:baseline
npx tsc --noEmit -p tsconfig.app.json
npx vitest run src/lib/openclaw-zalo src/hooks/openclaw-zalo src/components/openclaw-zalo src/pages/openclaw-zalo src/lib/__tests__/openclawFullContract.test.ts scripts/__tests__/openclawCommandContract.test.mjs scripts/__tests__/production-openclaw-smoke.test.mjs scripts/__tests__/apply-openclaw-reviewed-migrations.test.mjs
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge ci
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run verify:upstream
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run vendor:prepare
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run typecheck
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge test
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run build
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run pack
npm --prefix services/openclaw-zalo-cell/vendor/zalouser-bridge run verify:artifact
npm --prefix services/openclaw-zalo-cell/session-crypto ci
$sourceRoot = (Resolve-Path -LiteralPath '.').Path
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $sourceRoot 'services/openclaw-zalo-cell/.release'))
$releaseRelative = [IO.Path]::GetRelativePath($sourceRoot, $releaseRoot)
if ([IO.Path]::IsPathRooted($releaseRelative) -or $releaseRelative -eq '..' -or $releaseRelative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)) { throw 'Final verification output escaped the E29 source workspace' }
New-Item -ItemType Directory -Path $releaseRoot -Force -ErrorAction Stop | Out-Null
$releaseItem = Get-Item -LiteralPath $releaseRoot -ErrorAction Stop
if ($releaseItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Final verification release root must not be a reparse point' }
$finalEvidence = Join-Path $releaseRoot 'final-verify-build-evidence.json'
$finalArchive = Join-Path $releaseRoot 'final-verify-openclaw-zalo-cell-linux-amd64.oci.tar'
if (Test-Path -LiteralPath $finalEvidence) { throw 'Stale final verification evidence exists' }
if (Test-Path -LiteralPath $finalArchive) { throw 'Stale final verification archive exists' }
$buildxPath = (Resolve-Path -LiteralPath $env:OPENCLAW_BUILDX_PATH -ErrorAction Stop).Path
if (-not [IO.Path]::IsPathFullyQualified($buildxPath)) { throw 'OPENCLAW_BUILDX_PATH must resolve to an absolute path' }
$helperRel = 'services/openclaw-zalo-cell/scripts/build-reproducible-image.ps1'
$helperBlob = (git rev-parse "$R29`:$helperRel").Trim()
if ($helperBlob -notmatch '^[0-9a-f]{40}$') { throw 'Reviewed R29 helper blob ID is invalid' }
if ((git cat-file -t $helperBlob).Trim() -ne 'blob') { throw 'Reviewed R29 helper is not a blob' }
$helperSize = [int64](git cat-file -s $helperBlob)
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRootItem = Get-Item -LiteralPath $tempRoot -ErrorAction Stop
if ($tempRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Temp root must not be a reparse point' }
$r29Worktree = [IO.Path]::GetFullPath((Join-Path $tempRoot ('ihome-openclaw-final-r29-' + [guid]::NewGuid().ToString('N'))))
$r29Relative = [IO.Path]::GetRelativePath($tempRoot, $r29Worktree)
if ([IO.Path]::IsPathRooted($r29Relative) -or $r29Relative -eq '..' -or $r29Relative.StartsWith('..' + [IO.Path]::DirectorySeparatorChar)) { throw 'Detached final R29 path escaped canonical temp root' }
$primaryError = $null
$cleanupError = $null
try {
  git worktree add --detach $r29Worktree $R29
  $r29Helper = Join-Path $r29Worktree $helperRel
  if ((Get-Item -LiteralPath $r29Helper -ErrorAction Stop).Length -ne $helperSize) { throw 'Detached R29 helper byte size mismatch' }
  if ((git hash-object $r29Helper).Trim() -ne $helperBlob) { throw 'Detached R29 helper bytes do not match the reviewed blob' }
  Push-Location $r29Worktree
  try {
    node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
    if ((git rev-parse HEAD).Trim() -ne $R29) { throw 'Detached final verifier is not exact R29' }
    if (@(git status --porcelain=v1 --untracked-files=all).Count -ne 0) { throw 'Detached R29 verifier worktree is not clean' }
    & $r29Helper -ReviewedTree $R29 -BuildxPath $buildxPath -Platform 'linux/amd64' -SourceDateEpoch '1785062400' -BaselineEvidencePath (Join-Path $sourceRoot 'services/openclaw-zalo-cell/build-evidence.json') -EvidencePath $finalEvidence -ReleaseArtifactPath $finalArchive
    if (@(git status --porcelain=v1 --untracked-files=all).Count -ne 0) { throw 'Final image helper mutated detached R29 source' }
  } finally {
    Pop-Location
  }
} catch {
  $primaryError = $_
} finally {
  try {
    $registeredPaths = @(git worktree list --porcelain | Where-Object { $_ -like 'worktree *' } | ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9)) })
    if (($registeredPaths -contains $r29Worktree) -or (Test-Path -LiteralPath $r29Worktree)) {
      git worktree remove --force $r29Worktree
      if ($LASTEXITCODE -ne 0) { throw 'Forced detached final R29 worktree removal failed' }
    }
    if (Test-Path -LiteralPath $r29Worktree) { throw 'Detached final R29 path remains after forced removal' }
    $remainingPaths = @(git worktree list --porcelain | Where-Object { $_ -like 'worktree *' } | ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9)) })
    if ($remainingPaths -contains $r29Worktree) { throw 'Detached final R29 registration remains after forced removal' }
  } catch {
    $cleanupError = $_
  }
  if ($null -ne $primaryError) {
    if ($null -ne $cleanupError) { [Console]::Error.WriteLine('Detached final R29 cleanup also failed: ' + $cleanupError.Exception.Message) }
    throw $primaryError
  }
  if ($null -ne $cleanupError) { throw $cleanupError }
}
if ((git rev-parse HEAD).Trim() -ne $E29) { throw 'Main source context left exact E29 during final image verification' }
if (git status --porcelain) { throw 'E29 source worktree changed during final image verification' }
if (-not (Test-Path -LiteralPath $finalEvidence -PathType Leaf) -or -not (Test-Path -LiteralPath $finalArchive -PathType Leaf)) { throw 'Final R29 verification outputs are missing' }
node services/openclaw-zalo-cell/scripts/verify-image-lock.mjs --evidence $finalEvidence --schema services/openclaw-zalo-cell/build-evidence.schema.v1.json --reviewed-tree $R29 --release-artifact $finalArchive
node scripts/production-openclaw-smoke.mjs --verify-final-image-reproduction --reviewed-sha $E29 --cell-reviewed-tree $R29 --candidate-evidence $finalEvidence --candidate-archive $finalArchive --baseline-cell-evidence services/openclaw-zalo-cell/build-evidence.json --bundle $env:OPENCLAW_REVIEWED_DEPLOY_BUNDLE --expected-remote-image-digest $env:OPENCLAW_REMOTE_CELL_IMAGE_DIGEST
if ((git rev-parse HEAD).Trim() -ne $E29 -or (git status --porcelain)) { throw 'Final reproduction verification mutated E29 source' }
npm --prefix services/openclaw-zalo-bridge ci
npm --prefix services/openclaw-zalo-maintenance ci
npm --prefix services/openclaw-egress-broker ci
npm --prefix infra/openclaw-media-gateway ci
npm --prefix infra/openclaw-zalo-watchdog ci
npm run test:openclaw:services
npm run test:openclaw:sql
npm run test:openclaw:r2
npx vitest run infra/openclaw-zalo/test/recovery-drill.test.ts scripts/__tests__/openclaw-cotenants.test.mjs
Push-Location .e2e-fleet
$env:FLEET_WORKERS = '8'
$env:FLEET_BASE_URL = 'http://127.0.0.1:4173'
$env:FLEET_OPENCLAW_FIXTURE_ENV = 'local-preview'
$env:FLEET_OPENCLAW_PROJECT_REF = 'local'
npx playwright test specs/openclaw-zalo.spec.ts
Pop-Location
```

Expected: all commands PASS and injected native failure prevents later sentinels; root Vitest/ESLint do not traverse package-owned suites; command contracts prove clean exact E29 main context, exact reviewed R29 helper blob executed only inside the canonical detached R29 worktree, forced cleanup/error preservation, pinned builder/exporter/timestamps, promoted archive and final bundle/load chain. From E29, the closed-schema verifier and final-reproduction command require candidate archive hash/image digest plus installed-tree, three-file session, provenance/trust, manifest/config/layer/mtime/package fields to match committed E29 evidence, the E29-bound deploy bundle, and the remote loaded image. No tracked evidence commit or source mutation occurs; generated types match the applied schema; E2E rejects production and cleans only isolated fixtures.

- [ ] **Step 3: Run the protected live-DEMO matrix only in the authorized environment**

The shared schema is already applied and flags remain controlled by Task 29. Require the protected environment marker, exact project/org confirmations, and rollback-only mode:

```powershell
if ($PSVersionTable.PSVersion -lt [version]'7.3') { throw 'PowerShell 7.3+ is required for native fail-fast' }
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major!==24||minor<15){console.error('Node >=24.15.0 <25 is required');process.exit(1)}"
if ($env:OPENCLAW_AUTHORIZED_LIVE_DEMO -ne '1') { throw 'Authorized live-DEMO environment is required' }
if ($env:OPENCLAW_PROJECT_REF -ne 'tryymsxyyckgbrmmvozx') { throw 'Unexpected Supabase project ref' }
if ($env:OPENCLAW_DEMO_ORG_ID -ne 'dddd0000-0000-4000-8000-000000000001') { throw 'Unexpected DEMO organization' }
npm run test:openclaw:sql:live-demo
```

Expected: PASS with rollback-only DEMO fixtures, redacted output, exact migration/schema identity, and zero PROD organization writes. This helper is never run in pull-request CI and never applies a migration.

- [ ] **Step 4: Review final behavior and durable rollout evidence against the spec**

Review the deployed implementation, not merely plan prose. Trace every spec section 1-20 to concrete deployed files, tests, runbook commands, and canonical evidence: legacy isolation; one account/cell/org; composite FK/FORCE RLS/deny-by-default; permissions; QR/disclosure; atomic inbound decision/work; outbox/CAS/UNKNOWN; organization-scoped `GLOBAL_STOP`; AI/DLP; private media/SSRF; maintenance principal/routes; retention/audit anchors; rootless isolation; watchdog auth; backup/recovery; UI/mobile; DEMO-only automated writes; reviewed production schema apply; owner checkpoints; 48-hour shadow; at least 72 continuous green LIMITED observation; bounded outbound smoke; cleanup proofs; and reconnect returning canonical `CONNECTED` plus separate session risk and `DRAFT_ONLY` effective mode.

Verify Task 29 evidence is content-free and continuous: no QR/message/template/provider content, no secrets, no missing observation gap hidden inside the 72-hour interval, no unexpected UNKNOWN, no co-tenant regression, no upstream/source/patch/tgz/package/image drift, and zero residual smoke work. Recompute the clean-context/helper hashes and confirm pinned buildx/BuildKit/exporter options, source epoch/layer mtimes, both OCI archive hashes, manifest/config/layers, package epoch, promoted archive bytes, final bundle/transfer manifest, and remote loaded image digest match Task 29 exactly. Dirty context, mutable builders, cached tags, missing/tampered handoff bytes, ad hoc builds, or a native failure followed by later mutation invalidate completion. Confirm no production mutation occurred before the reviewed-SHA gate and no post-rollout plan-only commit/cherry-pick changed deployment.

- [ ] **Step 5: Obtain an independent implementation/runbook/evidence review**

Use a fresh `reviewer` agent with `fork_turns="none"`. Give it the exact deployed SHA, approved spec, full implementation diff/history, migrations and SHA-256 manifest, CI commands/results, upstream/source/patch/tgz/package/image evidence, runbooks, owner checkpoints, rollout observations, smoke cleanup proofs, and co-tenant comparison. It must inspect security, correctness, operability, evidence continuity, and test gaps; return findings ordered by severity; and must not edit files or review only this plan.

- [ ] **Step 6: Resolve findings without rewriting deployed history**

If the reviewer finds a valid implementation/runbook/migration/artifact issue, Task 30 is not complete. Create a new exact-file forward commit, repeat independent review, use only forward corrective schema changes, and rerun the applicable Task 29 apply/deploy/rollout gates before restarting Task 30 at the new deployed SHA. Never amend/cherry-pick a plan-only commit onto the deployed lifecycle, down-migrate, erase evidence, or claim completion from stale results.

- [ ] **Step 7: Hand off the verified deployment**

Deliver the exact deployed SHA, migration-manifest SHA-256, Edge/Worker versions, upstream/source/patch/tgz/package locks, clean-context/helper hashes, pinned builder/exporter contract, source epoch/layer mtimes, OCI manifest/config/layer/package evidence, promoted archive and final bundle/transfer/load hashes, other image digests, final rollout stage/version, owner checkpoints, continuous-green duration, smoke/cleanup results, co-tenant comparison, accepted risks, and runbook links. State explicitly that automated writes remain DEMO-only outside controlled smoke, legacy Zalo is untouched, UNKNOWN has no automatic retry, and `GLOBAL_STOP` remains organization-scoped. No plan-only commit or push follows rollout.

## 6. Coverage Checklist

| Spec requirement | Plan tasks |
|---|---|
| New standalone page and no legacy reuse | 1, 22 |
| Vendored fork provenance, source snapshot, patch/tgz/image hashes, license notices | 2, 19, 27, 29, 30 |
| Reproducible cell image: clean context, pinned builder/exporter, rewritten mtimes, distinct OCI digests, promoted bundle/load artifact, safe cleanup | 2, 27, 29, 30 |
| Inbound listener WAL/FULL-before-dispatch ordering and dedupe semantics | 2, 17, 27, 28, 30 |
| Stable event-ID/message-ID precedence, immutable pair mapping, tenant isolation and collision fail-close | 2, 5, 9, 12, 17, 27, 30 |
| Built-in reply/pairing business content remains disabled after successful ingest and canonical outcomes | 2, 17, 18, 27, 30 |
| Private `zalouser.bridge.send`, provider choke points, zero-frame pre-handoff failures | 2, 9, 15, 18, 19, 27, 29, 30 |
| One Zalo account/cell per organization | 4, 8, 15, 19 |
| Composite FK, FORCE RLS, deny-by-default | 4-8 |
| Permission actions and selected-org auth | 3, 8, 9, 22-25 |
| QR 120s, encrypted, one-time, no leakage | 4, 9, 14, 26 |
| Inbox, manual send, draft, handoff | 5, 9, 18, 23 |
| Consent, quiet hours, proactive, first-contact gates | 6, 18, 24, 29 |
| Sales groups and exact stable IDs | 5, 6, 18, 24, 29 |
| Typed CRM events | 10, 11, 24, 29 |
| Schedule/CRM work fan-out, rendering, retention, audit anchoring | 6, 7, 9, 11, 12, 15, 16, 18, 26 |
| Outbox lease/CAS/UNKNOWN/dead letter | 7, 9, 11, 18, 25 |
| AI boundary, knowledge sensitivity, DLP | 6, 18, 24 |
| Private R2/media/SSRF/tickets | 5, 11, 13, 16 |
| Rootless Vultr isolation and co-tenant safety | 2, 17, 19, 20, 28 |
| Spool durability, health, quotas, RPO/RTO | 17, 20, 28, 29 |
| Replaceable VPS migration | 20, 29 |
| Desktop/mobile states and accessibility | 22-25, 26 |
| SQL/service/R2/unit/property/E2E tests | 1, 12, 13-18, 21, 26-28, 30 |
| Rollout and rollback gates | 19, 20, 28, 29, 30 |

## 7. Residual Risks Accepted By The Spec

- Zalo Personal is unofficial and may suspend or invalidate sessions; the UI must keep this visible and the recovery path is QR re-login, not cookie restoration.
- The provider callback is void/non-awaited and there is no provider acknowledgement/replay guarantee for events lost before callback delivery. The fork can guarantee only that its internal listener obtains bridge WAL/FULL durability before OpenClaw dispatch/queue; gap reconciliation still depends on available provider history and Zalo native evidence.
- Missing provider event IDs remain heuristic at-least-once dedupe and can collide; payload hashes, collision telemetry, quarantine, and operator reconciliation are mandatory.
- The vendored fork creates maintenance/rebase burden. Every upstream change requires source-snapshot verification, license review, patch reapplication, full `monitor.ts`/`zalo-js.ts`/`send.ts`/`channel.adapters.ts`/`tool.ts` coverage, new patch/tgz/image hashes, and independent review.
- Broader OpenClaw admin/control surfaces remain reachable only inside the isolated cell; stock business delivery is denied, and the private network, no exposed ports, no Docker socket, explicit tool/method deny list, internal-only fork, and bridge-owned outbox remain mandatory controls.
- Supabase/R2/Vultr quota and pricing must be recorded from the provider portals during preflight; unknown transfer quota blocks proactive/group media production.
- AI providers can return unsafe or stale content; strict retrieval sensitivity, schema validation, post-generation DLP, human review, and server-side policy remain mandatory.

## 8. Execution Handoff

The owner approved the vendored integrity-pinned fork on 2026-07-27. Before implementation, freeze the approved spec and this plan at one exact commit. A fresh independent reviewer must confirm migration order/ownership, committed source-snapshot provenance, patch/tgz/image locks, inbound WAL-before-dispatch ordering, private-RPC provider choke points, maintenance routes/principals, nested package/root exclusions, 12-file manifest, DEMO/live-PROD boundaries, checked deployment transport, durable owner checkpoints, and Task 29/30 reviewed-SHA lifecycle. Resolve plan findings and freeze again before Task 1. Task 2 must pass positively before Tasks 3-29 open; no implementation may proceed from a plan-only draft or later unreviewed edit. Plan complete and saved to `docs/superpowers/plans/2026-07-26-openclaw-zalo-personal.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh implementer per bounded task, then a reviewer after each lane checkpoint.
2. **Inline Execution** - execute the plan in this session with executing-plans checkpoints. In either mode, Task 29 commits and independently reviews rollout tooling before any production mutation; Task 30 reviews the final deployed implementation/runbooks/evidence at that reviewed SHA and has no post-rollout plan-only commit, cherry-pick, or push lifecycle.

## 9. Upstream References Pinned For Implementation

- OpenClaw 2026.7.1 release: `https://github.com/openclaw/openclaw/releases/tag/v2026.7.1`
- Docker installation and hardening: `https://docs.openclaw.ai/install/docker`
- ZaloUser channel: `https://docs.openclaw.ai/channels/zalouser`
- ZaloUser plugin: `https://docs.openclaw.ai/plugins/zalouser`
- Gateway protocol: `https://docs.openclaw.ai/gateway/protocol`
- Session isolation: `https://docs.openclaw.ai/concepts/session`
- Plugin testing constraints: `https://docs.openclaw.ai/plugins/sdk-testing`
