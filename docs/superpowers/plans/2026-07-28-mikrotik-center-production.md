# MikroTik Network Center Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the completed Network Center UI and deliver a tenant-safe Supabase control/data plane, live iHomeCRM repository integration, and a dedicated Vultr RouterOS worker verified against the demo router and production deployment.

**Architecture:** Use Hybrid A+ storage: small current-state projections for UI reads, append-only telemetry/incident/command/audit history, bounded rollups, narrow authenticated RPCs, and a lease/idempotency command queue. A dedicated Vultr worker calls a worker-only Edge API, resolves router credentials from VPS-only secrets, connects over WireGuard, and performs polling or allowlisted actions with backup and post-checks.

**Tech Stack:** PostgreSQL/Supabase RLS and RPCs, Supabase Edge Functions (Deno), React 18 + TypeScript + TanStack Query, Node 20 worker, `ssh2`, WireGuard, Vitest, Playwright, Docker, Vercel.

---

### Task 1: Checkpoint Existing UI And Rebase Onto Current Main

**Files:**
- Preserve: `src/components/network-center/**`
- Preserve: `src/pages/network-center/**`
- Preserve: `src/lib/network-center/**`
- Preserve: `src/hooks/network-center/**`
- Preserve: `.e2e-fleet/specs/network-center.spec.ts`
- Merge carefully: `src/App.tsx`
- Merge carefully: `src/components/layout/Sidebar.tsx`
- Merge carefully: `src/lib/permissionPages.ts`
- Merge carefully: `src/lib/permissions.ts`
- Exclude: `package-lock.json`

- [ ] **Step 1: Re-run the focused UI checkpoint tests**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run `
  src/lib/__tests__/networkCenterPermissions.test.ts `
  src/lib/__tests__/networkCenterModel.test.ts `
  src/lib/__tests__/networkCenterRepositoryLifecycle.test.ts `
  src/lib/__tests__/networkCenterActorIdentity.test.ts `
  src/lib/__tests__/networkCenterAuthCache.test.ts `
  src/lib/__tests__/networkCenterExecuteGuard.test.tsx `
  src/lib/__tests__/networkCenterTabs.test.tsx `
  src/hooks/__tests__/useProfile.identity.test.ts `
  --pool=forks --maxWorkers=1 --no-file-parallelism
```

Expected: 8 files and 45 tests pass.

- [ ] **Step 2: Verify TypeScript baseline**

Run:

```powershell
npm run typecheck:baseline
```

Expected: no new TypeScript fingerprints.

- [ ] **Step 3: Stage only Network Center checkpoint files**

```powershell
git add -- `
  .e2e-fleet/specs/network-center.spec.ts `
  docs/superpowers/plans/2026-07-23-mikrotik-center-ui.md `
  docs/superpowers/specs/2026-07-23-mikrotik-center-integrated-design.md `
  src/App.tsx `
  src/components/layout/Sidebar.tsx `
  src/components/network-center `
  src/copilot/CopilotLauncher.tsx `
  src/hooks/useProfile.ts `
  src/hooks/__tests__/useProfile.identity.test.ts `
  src/hooks/network-center `
  src/lib/permissionPages.ts `
  src/lib/permissions.ts `
  src/lib/network-center `
  src/lib/__tests__/networkCenterActorIdentity.test.ts `
  src/lib/__tests__/networkCenterAuthCache.test.ts `
  src/lib/__tests__/networkCenterExecuteGuard.test.tsx `
  src/lib/__tests__/networkCenterModel.test.ts `
  src/lib/__tests__/networkCenterPermissions.test.ts `
  src/lib/__tests__/networkCenterRepositoryLifecycle.test.ts `
  src/lib/__tests__/networkCenterTabs.test.tsx `
  src/pages/home/launcherTiles.ts `
  src/pages/network-center
git diff --cached --quiet -- package-lock.json
```

Expected: the lockfile is not staged.

- [ ] **Step 4: Commit the verified UI checkpoint**

```powershell
git commit -m "feat(network-center): hoàn thiện giao diện trung tâm mạng" `
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

- [ ] **Step 5: Rebase onto the refreshed main branch**

```powershell
git fetch origin main
git rebase origin/main
```

Resolve only the five known overlapping paths by preserving upstream AuthZ v3
and route/layout changes, then reapply the Network Center route and permission
catalog entries. Do not take the old versions wholesale.

- [ ] **Step 6: Re-run Task 1 tests and baseline after rebase**

Expected: the same 45 tests pass and no new TypeScript fingerprints appear.

### Task 2: Register AuthZ V3 Permissions And Inventory Schema

**Files:**
- Create: `supabase/migrations/20260729010000_network_center_permissions_inventory.sql`
- Create: `src/lib/__tests__/networkCenterDatabaseMigration.test.ts`

- [ ] **Step 1: Write failing static migration tests**

Add assertions that the new migration contains:

```ts
expect(sql).toContain("'network_center.view'");
expect(sql).toContain("'network_center.execute'");
expect(sql).toMatch(/create table if not exists public\.network_devices/i);
expect(sql).toMatch(/network_devices_one_active_mikrotik_per_building/i);
expect(sql).toMatch(/write_capability = false/i);
expect(sql).not.toMatch(/slot_no\s+between\s+1\s+and\s+10/i);
expect(sql).toMatch(/foreign key \(organization_id, building_id\)/i);
```

- [ ] **Step 2: Run the test and observe the missing migration failure**

```powershell
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterDatabaseMigration.test.ts
```

Expected: FAIL because the migration does not exist.

- [ ] **Step 3: Create permission and inventory tables**

The migration must insert both catalog keys with building-capable scopes:

```sql
insert into public.permission_definitions
  (key, resource, action, sensitivity, permission_domain, scope_kinds,
   is_active, scope_match_mode, requires_cashbook_possession,
   accepted_possession_kinds, required_dimensions)
values
  ('network_center.view', 'network_center', 'view', 'VIEW', 'TENANT',
   array['ORGANIZATION','AREA','BUILDING'], true, 'ANY_MATCH', false, '{}'::text[],
   array['BUILDING']),
  ('network_center.execute', 'network_center', 'execute', 'MANAGE', 'TENANT',
   array['ORGANIZATION','AREA','BUILDING'], true, 'ANY_MATCH', false, '{}'::text[],
   array['BUILDING'])
on conflict (key) do update set
  is_active = excluded.is_active,
  scope_kinds = excluded.scope_kinds,
  required_dimensions = excluded.required_dimensions;
```

Create `network_devices`, `network_interfaces`,
`network_device_connections`, `network_site_settings`, and
`network_desired_state_versions` with:

- UUID primary keys matching repository conventions;
- non-null org/building columns;
- composite building foreign keys;
- indexes on all foreign keys and building/time read paths;
- one-active-MikroTik partial unique index;
- unlimited Aruba rows and a check forcing Aruba write capability false;
- no secret-bearing columns beyond opaque `credential_ref`.

- [ ] **Step 4: Backfill inert building slots**

Insert one `unprovisioned` MikroTik device and one default settings row for every
physical building. Use `ON CONFLICT DO NOTHING`; do not create credentials or
telemetry.

- [ ] **Step 5: Run the static test**

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```powershell
git add supabase/migrations/20260729010000_network_center_permissions_inventory.sql `
  src/lib/__tests__/networkCenterDatabaseMigration.test.ts
git commit -m "feat(network-center): thêm inventory và quyền AuthZ v3" `
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 3: Add Current State, Client History, Telemetry, And Retention

**Files:**
- Create: `supabase/migrations/20260729020000_network_center_current_telemetry.sql`
- Modify: `src/lib/__tests__/networkCenterDatabaseMigration.test.ts`
- Create: `scripts/verify-network-center-retention.mjs`

- [ ] **Step 1: Add failing tests for current/history/retention shape**

Assert creation of:

```ts
for (const table of [
  'network_device_current',
  'network_interface_current',
  'network_client_current',
  'network_client_sessions',
  'network_client_links',
  'network_device_samples',
  'network_interface_samples',
  'network_metric_hourly',
  'network_sla_daily',
]) expect(sql).toContain(`public.${table}`);

expect(sql).toMatch(/partition by range \(observed_at\)/i);
expect(sql).toMatch(/interval '14 days'/i);
expect(sql).toMatch(/interval '13 months'/i);
expect(sql).toMatch(/interval '36 months'/i);
```

- [ ] **Step 2: Run RED test**

Expected: FAIL because the telemetry migration is absent.

- [ ] **Step 3: Create current projections and client history**

Use one-row-per-device/interface primary or unique keys and atomic upsert targets.
Use `timestamptz`, numeric/integer metric types, and explicit range checks.
`network_client_links` must preserve temporal room/contract/customer linkage and
must not treat MAC as a permanent identity.

- [ ] **Step 4: Create partitioned raw sample parents**

```sql
create table public.network_device_samples (
  organization_id uuid not null,
  building_id uuid not null,
  device_id uuid not null,
  observed_at timestamptz not null,
  sample jsonb not null,
  primary key (device_id, observed_at)
) partition by range (observed_at);
```

Create the interface equivalent, partition maintenance helpers, and indexes with
equality columns before the timestamp range column.

- [ ] **Step 5: Implement repeat-safe rollup and retention functions**

`network_center_rollup_hourly_v1(p_hour)` uses an upsert keyed by building,
metric, and hour. `network_center_rollup_sla_daily_v1(p_day)` does the same for
daily SLA. `network_center_retention_v1(p_now)` drops raw partitions older than
14 days and deletes hourly/daily rows older than their locked retention.

Internal functions revoke `PUBLIC`, `anon`, and `authenticated`.

- [ ] **Step 6: Add the retention verifier**

The script reads the migration and fails when locked durations, partition keys,
or internal-function revokes are absent. It must not connect to production.

- [ ] **Step 7: Run focused tests and verifier**

```powershell
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterDatabaseMigration.test.ts
node scripts/verify-network-center-retention.mjs
```

- [ ] **Step 8: Commit Task 3**

```powershell
git add supabase/migrations/20260729020000_network_center_current_telemetry.sql `
  src/lib/__tests__/networkCenterDatabaseMigration.test.ts `
  scripts/verify-network-center-retention.mjs
git commit -m "feat(network-center): thêm telemetry hybrid và retention" `
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 4: Add Incidents, Maintenance, Snapshots, Commands, And Audit

**Files:**
- Create: `supabase/migrations/20260729030000_network_center_operations.sql`
- Modify: `src/lib/__tests__/networkCenterDatabaseMigration.test.ts`
- Create: `scripts/verify-network-center-queue.mjs`

- [ ] **Step 1: Write failing command and append-only tests**

```ts
expect(sql).toContain('network_incidents');
expect(sql).toContain('network_incident_events');
expect(sql).toContain('network_maintenance_windows');
expect(sql).toContain('network_config_snapshots');
expect(sql).toContain('network_commands');
expect(sql).toContain('network_command_attempts');
expect(sql).toContain('network_command_events');
expect(sql).toContain('network_device_leases');
expect(sql).toContain('network_audit_events');
expect(sql).toContain('network_outbox_events');
expect(sql).not.toMatch(/pending_approval|approved_by|rejected_by/i);
expect(sql).toMatch(/unique.*idempotency/i);
```

- [ ] **Step 2: Run RED test**

Expected: FAIL because the operations migration is absent.

- [ ] **Step 3: Create durable operations tables**

Use check constraints for closed statuses and action types. Store sanitized JSONB
only. Add partial indexes for active incidents, runnable commands, active leases,
and undelivered outbox entries. Index every foreign key.

- [ ] **Step 4: Enforce append-only evidence**

Create an internal trigger function that raises SQLSTATE `55000` on UPDATE or
DELETE of incident events, command events, audit events, and outbox source events.
Revoke mutation privileges from browser roles.

- [ ] **Step 5: Add queue invariants**

Enforce unique `(organization_id, requested_by, idempotency_key)`, request hash,
lease token/expiry fields, attempt count, `available_at`, and terminal states.
There are no approval columns or states.

- [ ] **Step 6: Implement the queue verifier**

Check for the required runnable partial index, `SKIP LOCKED`, lease expiry,
idempotency conflict handling, per-device serialization, and append-only guard.

- [ ] **Step 7: Run focused tests and verifier**

```powershell
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterDatabaseMigration.test.ts
node scripts/verify-network-center-queue.mjs
```

- [ ] **Step 8: Commit Task 4**

```powershell
git add supabase/migrations/20260729030000_network_center_operations.sql `
  src/lib/__tests__/networkCenterDatabaseMigration.test.ts `
  scripts/verify-network-center-queue.mjs
git commit -m "feat(network-center): thêm command queue và audit bất biến" `
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 5: Add RLS, Public RPCs, Worker RPCs, And Realtime

**Files:**
- Create: `supabase/migrations/20260729040000_network_center_rls_rpcs_realtime.sql`
- Modify: `src/lib/__tests__/networkCenterDatabaseMigration.test.ts`
- Modify: `scripts/test-cross-tenant.mjs`

- [ ] **Step 1: Write failing RLS/RPC/grant tests**

Require:

```ts
expect(sql).toMatch(/enable row level security/gi);
expect(sql).toContain("can_do_on_building('network_center', 'execute'");
expect(sql).toContain("can_do_on_building('network_center', 'view'");
expect(sql).toMatch(/security definer/gi);
expect(sql).toMatch(/set search_path to 'pg_catalog', 'public', 'app_private'/i);
expect(sql).toMatch(/revoke all on function .* from public, anon/i);
expect(sql).toMatch(/for update skip locked/i);
```

- [ ] **Step 2: Run RED test**

- [ ] **Step 3: Create read policies and public read RPCs**

Implement fleet/building aggregates plus cursor RPCs for unlimited Aruba,
clients, commands, and audit. RLS uses indexed building/org predicates and wraps
stable auth helpers in scalar subqueries where policy form permits it.

- [ ] **Step 4: Create public mutation RPCs**

Implement:

```sql
network_center_ack_incident_v1(uuid, uuid)
network_center_create_maintenance_v1(uuid, integer, text, uuid)
network_center_cancel_maintenance_v1(uuid, uuid, uuid)
network_center_request_snapshot_v1(uuid, text, uuid)
network_center_execute_action_v1(uuid, text, text, jsonb, text, uuid)
network_center_update_settings_v1(uuid, jsonb, bigint, uuid)
```

Each function derives the actor, locks its target, rechecks execute permission,
validates bounded inputs, writes audit atomically, and returns a sanitized DTO.

- [ ] **Step 5: Create internal worker RPCs**

Implement atomic claim with `FOR UPDATE SKIP LOCKED`, lease renewal, heartbeat,
bounded batch ingest/upsert, incident/snapshot writes, stage/result append, and
retention/rollup invocation. Revoke them from browser roles.

- [ ] **Step 6: Add safe Realtime publication**

Add only current projections, incidents, commands, command events, and worker
heartbeats. Do not publish raw telemetry, connections, client links, raw
snapshots, audit payloads, or credential references.

- [ ] **Step 7: Extend cross-tenant probes**

Add owner, view-only, execute, wrong-building, wrong-org, offboarded, and
anonymous matrix cases. All writes target the DEMO org and execute inside a
transaction that rolls back.

- [ ] **Step 8: Run database security gates**

```powershell
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterDatabaseMigration.test.ts
node scripts/check-definer-acl.mjs
node scripts/check-view-invoker.mjs
node scripts/test-cross-tenant.mjs
```

- [ ] **Step 9: Commit Task 5**

```powershell
git add supabase/migrations/20260729040000_network_center_rls_rpcs_realtime.sql `
  src/lib/__tests__/networkCenterDatabaseMigration.test.ts `
  scripts/test-cross-tenant.mjs
git commit -m "feat(network-center): thêm RLS RPC và Realtime production" `
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 6: Add The Worker-Only Edge API

**Files:**
- Create: `supabase/functions/network-center-worker/index.ts`
- Create: `supabase/functions/network-center-worker/deno.json`
- Create: `supabase/functions/network-center-worker/index.test.ts`
- Modify: `supabase/functions/README.md`

- [ ] **Step 1: Write failing auth and route tests**

Test missing/wrong secret denial, unknown route denial, body limits, malformed
JSON, and successful forwarding for heartbeat, claim, renew, ingest, stage, and
complete operations.

- [ ] **Step 2: Run Edge tests RED**

```powershell
deno test supabase/functions/network-center-worker/index.test.ts --allow-env
```

- [ ] **Step 3: Implement constant-time worker authentication**

Read `NETWORK_WORKER_SECRET` from `Deno.env`, compare fixed-length digests in
constant time, and never log the header or secret.

- [ ] **Step 4: Implement the narrow route allowlist**

Route handlers call internal RPCs with the Edge Function's service-role client.
Validate worker ID, UUIDs, batch count, serialized byte size, timestamps, and
allowed event/stage kinds before RPC invocation.

- [ ] **Step 5: Run Edge tests GREEN and document secrets/deploy**

```powershell
deno test supabase/functions/network-center-worker/index.test.ts --allow-env
```

- [ ] **Step 6: Commit Task 6**

```powershell
git add supabase/functions/network-center-worker supabase/functions/README.md
git commit -m "feat(network-center): thêm worker API hẹp" `
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 7: Apply Migrations And Regenerate Supabase Types

**Files:**
- Modify: `src/integrations/supabase/types.ts`

- [ ] **Step 1: Apply migrations to the linked Supabase project**

Use the ignored local PAT without printing it. Apply migrations in timestamp
order through the Management API or repository migration helper. Read back
tables, constraints, policies, functions, and grants after each migration.

- [ ] **Step 2: Seed only inert inventory and DEMO fixtures**

Production buildings receive unprovisioned router/settings rows only. Synthetic
telemetry fixtures are restricted to organization
`dddd0000-0000-0000-0000-000000000001`.

- [ ] **Step 3: Regenerate types**

```powershell
npm run gen:types
```

Write output to `src/integrations/supabase/types.ts` using a temporary file and
restore the required generated-file header.

- [ ] **Step 4: Verify generated type drift and security scripts**

```powershell
npm run typecheck:baseline
node scripts/check-definer-acl.mjs
node scripts/check-view-invoker.mjs
node scripts/test-cross-tenant.mjs
```

- [ ] **Step 5: Commit Task 7**

```powershell
git add src/integrations/supabase/types.ts
git commit -m "chore(types): cập nhật kiểu Network Center từ Supabase" `
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 8: Implement The Supabase Repository And React Query Integration

**Files:**
- Create: `src/lib/network-center/supabaseRepository.ts`
- Create: `src/lib/network-center/dto.ts`
- Create: `src/lib/network-center/queryKeys.ts`
- Create: `src/lib/__tests__/networkCenterSupabaseRepository.test.ts`
- Modify: `src/lib/network-center/contracts.ts`
- Modify: `src/hooks/network-center/useNetworkCenter.ts`
- Modify: `src/components/network-center/NetworkCenterShell.tsx`
- Modify: `.e2e-fleet/specs/network-center.spec.ts`

- [ ] **Step 1: Write failing DTO/repository tests**

Use complete RPC response fixtures. Assert null/error handling, bounded arrays,
unlimited Aruba pagination, actor server-derivation, mutation idempotency, and
mapping to the existing `NetworkBuilding` UI contract.

- [ ] **Step 2: Run RED repository tests**

- [ ] **Step 3: Make the repository contract asynchronous**

Define read and mutation methods returning promises. Keep the demo repository as
an explicit test/development implementation; production selection is not based
on silent fallback after errors.

- [ ] **Step 4: Implement Supabase RPC calls and DTO validation**

Use Zod at the RPC boundary, typed generated Supabase functions, cursor helpers,
and stable query keys scoped by user/organization/building.

- [ ] **Step 5: Adapt `useNetworkCenter` to React Query**

Reads use queries, mutations invalidate only affected fleet/building keys, and
errors remain visible. Subscribe to safe Realtime tables and debounce targeted
invalidation; payloads never directly mutate cached domain state.

- [ ] **Step 6: Replace simulation copy in production mode**

Production shows `Chưa kết nối` or worker-offline truthfully. Demo mode remains
explicit and cannot be selected by production error fallback.

- [ ] **Step 7: Run unit tests and typecheck**

```powershell
.\node_modules\.bin\vitest.cmd run networkCenter --pool=forks --maxWorkers=1 --no-file-parallelism
npm run typecheck:baseline
```

- [ ] **Step 8: Commit Task 8**

```powershell
git add src/lib/network-center src/hooks/network-center `
  src/components/network-center/NetworkCenterShell.tsx `
  src/lib/__tests__/networkCenterSupabaseRepository.test.ts `
  .e2e-fleet/specs/network-center.spec.ts
git commit -m "feat(network-center): nối UI với Supabase production" `
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 9: Build The Dedicated Vultr Network Worker

**Files:**
- Create: `infra/network-center-worker/package.json`
- Create: `infra/network-center-worker/package-lock.json`
- Create: `infra/network-center-worker/tsconfig.json`
- Create: `infra/network-center-worker/src/config.ts`
- Create: `infra/network-center-worker/src/apiClient.ts`
- Create: `infra/network-center-worker/src/domain.ts`
- Create: `infra/network-center-worker/src/routeros/connector.ts`
- Create: `infra/network-center-worker/src/routeros/sshConnector.ts`
- Create: `infra/network-center-worker/src/polling.ts`
- Create: `infra/network-center-worker/src/commands.ts`
- Create: `infra/network-center-worker/src/main.ts`
- Create: `infra/network-center-worker/test/**`
- Create: `infra/network-center-worker/Dockerfile`
- Create: `infra/network-center-worker/docker-compose.yml`
- Create: `infra/network-center-worker/.env.example`
- Create: `infra/network-center-worker/README.md`

- [ ] **Step 1: Write failing worker tests using a fake connector and clock**

Cover polling/ingest batching, heartbeat, reconnect, idempotent command handling,
lease renewal, pre-backup, post-check, retry classification, uncertain disruptive
outcomes, kill switches, log redaction, and graceful shutdown.

- [ ] **Step 2: Run worker tests RED**

```powershell
npm --prefix infra/network-center-worker test
```

- [ ] **Step 3: Implement validated configuration and API client**

Require Edge URL, worker secret, worker ID, credential file, poll interval, and
emergency-stop setting. Do not accept secrets through command-line arguments.

- [ ] **Step 4: Implement RouterOS connector boundary**

`RouterConnector` exposes structured read methods, redacted export, encrypted
backup retrieval, health checks, and the four closed actions. `SshRouterConnector`
uses strict host-key verification, key authentication, bounded command timeouts,
and exact parsers. No caller can pass raw CLI.

- [ ] **Step 5: Implement polling and command loops**

Use one worker process, bounded concurrency across buildings, per-device leases,
batch ingest, exponential backoff, and no external call while holding a database
transaction. Command results are posted through the worker API.

- [ ] **Step 6: Implement container and operations files**

Run as non-root with read-only filesystem, mounted `0600` secrets, healthcheck,
resource limits, restart policy, and host WireGuard access. Do not mount Docker
socket or 9Router/Zalo data.

- [ ] **Step 7: Run tests, typecheck, and container smoke**

```powershell
npm --prefix infra/network-center-worker test
npm --prefix infra/network-center-worker run typecheck
docker build -t ihome-network-center-worker:local infra/network-center-worker
```

- [ ] **Step 8: Commit Task 9**

```powershell
git add infra/network-center-worker
git commit -m "feat(network-center): thêm worker RouterOS riêng" `
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 10: Provision WireGuard And The Demo Router Safely

**Files:**
- Create: `infra/network-center-worker/scripts/generate-router-bootstrap.mjs`
- Create: `infra/network-center-worker/templates/router-bootstrap.rsc.tmpl`
- Create: `infra/network-center-worker/templates/wg0.conf.tmpl`
- Create: `infra/network-center-worker/docs/DEMO-ROUTER-RUNBOOK.md`
- Test: `infra/network-center-worker/test/bootstrap.test.ts`

- [ ] **Step 1: Write failing deterministic/redaction bootstrap tests**

Assert generated config contains the management subnet and worker public keys,
contains no unresolved placeholders, restricts management services to WireGuard,
and never writes secrets to stdout.

- [ ] **Step 2: Implement the bootstrap generator**

Read inputs from environment or an ignored file and write output only to a
caller-selected temporary path. Configure WireGuard, dedicated management user,
SSH public key, restricted management services, and firewall rules. Do not
disable the existing recovery path until verification passes.

- [ ] **Step 3: Capture a fresh router backup and inspect current state read-only**

Use the existing local demo credentials without logging them. Record identity,
RouterOS version, interface names, management services, and backup hashes.

- [ ] **Step 4: Apply bootstrap to the dedicated demo router**

Verify WireGuard handshake and SSH host key before modifying any public service.
Keep rollback access available throughout.

- [ ] **Step 5: Exercise read-only polling and snapshot capture**

Confirm worker heartbeat, device/interface/current rows, redacted snapshot, and
zero secret material in browser-readable tables.

- [ ] **Step 6: Exercise each allowlisted action**

For DNS flush, applicable DHCP renew, one safe access-port cycle, and reboot:
verify validation, pre-backup, job stages, post-check/reconciliation, and audit.
Skip DHCP renew with an explicit not-applicable result when the router uses PPPoE.

- [ ] **Step 7: Commit Task 10 assets and evidence-safe runbook updates**

Never commit generated router config, host keys, VPN keys, addresses, credentials,
or raw backup artifacts.

### Task 11: Deploy Edge Function And Worker To Vultr

**Files:**
- Modify: `infra/network-center-worker/README.md`
- Create: `infra/network-center-worker/scripts/deploy-vultr.ps1`

- [ ] **Step 1: Generate and set a new worker secret without printing it**

Store the same value in Supabase Edge secrets and a root-owned Vultr env file.
Do not reuse 9Router, Zalo, MikroTik, or Supabase service-role secrets.

- [ ] **Step 2: Deploy the worker Edge Function**

```powershell
node scripts/deploy-edge-fn.mjs network-center-worker
```

Read back function deployment metadata and verify unauthorized requests receive
401/403.

- [ ] **Step 3: Deploy the worker container over the existing SSH key**

The deployment script builds/uploads versioned artifacts, writes no secret to
logs, starts a separate container, and verifies health. It must not restart or
modify the `9router` or Zalo worker containers/processes.

- [ ] **Step 4: Verify worker readback**

Check container health, heartbeat freshness, queue age, WireGuard handshake, and
bounded logs. Reboot the container and verify lease recovery/reconnect.

- [ ] **Step 5: Commit Task 11 deployment automation**

```powershell
git add infra/network-center-worker
git commit -m "chore(network-center): tự động triển khai worker Vultr" `
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 12: Production Browser QA, Review, And Rollout

**Files:**
- Modify: `.e2e-fleet/specs/network-center.spec.ts`
- Modify only implementation files required by findings

- [ ] **Step 1: Run all repository gates**

```powershell
.\node_modules\.bin\vitest.cmd run networkCenter --pool=forks --maxWorkers=1 --no-file-parallelism
npm run typecheck:baseline
npm run build
node scripts/check-definer-acl.mjs
node scripts/check-view-invoker.mjs
node scripts/test-cross-tenant.mjs
node scripts/verify-network-center-retention.mjs
node scripts/verify-network-center-queue.mjs
npm --prefix infra/network-center-worker test
npm --prefix infra/network-center-worker run typecheck
git diff --check
```

- [ ] **Step 2: Run headless local Playwright against the worktree**

Load fleet passwords from the ignored local file without printing them, start a
strict-port Vite server, and run the Network Center fleet tests. Cover no-view,
view-only, live read, execute, settings conflict, Realtime refresh, mobile route,
page errors, failed requests, and console errors.

- [ ] **Step 3: Run independent spec and quality/security reviews**

Resolve every Critical and Important finding. Re-run all affected verification
commands after each fix.

- [ ] **Step 4: Push the verified branch to main**

```powershell
git fetch origin main
git rebase origin/main
git push origin HEAD:main
```

Do not force-push. Verify the pushed commit is the current remote main.

- [ ] **Step 5: Verify Vercel production deployment**

Wait for `https://ptcrm.vercel.app` to serve the pushed build, then run the
Network Center spec with `FLEET_BASE_URL=https://ptcrm.vercel.app`.

- [ ] **Step 6: Complete production readback**

Evidence must include:

- migrations and generated types match production;
- no cross-tenant read/write path;
- worker heartbeat is fresh;
- demo router telemetry is current;
- redacted snapshot and one safe command have complete audit/stages;
- production UI reads live data and handles worker/router offline truthfully;
- existing UI remains available and no unrelated finance/auth regression was
  introduced.

