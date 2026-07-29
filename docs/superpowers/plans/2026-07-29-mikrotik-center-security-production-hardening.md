# MikroTik Network Center Security Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đóng đủ 14 security findings, hoàn thiện delivery/rollback automation và đưa Network Center lên Supabase, Vultr, demo MikroTik và Vercel production với bằng chứng end-to-end.

**Architecture:** Giữ Hybrid A+ hiện tại, bổ sung worker principal/credential/assignment registry, tenant-scoped heartbeat, boundary-local resource budgets, managed RouterOS resources và typed command postconditions. Mọi schema change đi bằng migration additive mới; production rollout dùng content-hash manifest, readback receipts, immutable worker image và server-side building canary.

**Tech Stack:** PostgreSQL/Supabase RLS/RPC, Supabase Edge Functions (Deno), React 18 + TypeScript + TanStack Query, Node 20 worker + ssh2, Docker/systemd/WireGuard, Vitest/fast-check, Node test runner, Playwright fleet, Vercel.

**Authoritative inputs:**

- Design: `docs/superpowers/specs/2026-07-29-mikrotik-center-security-production-hardening-design.md`
- Scan: `f159d30d-46a1-4fcd-b1cf-b939007ae3e1`
- Scan baseline: `22a85f7224a4869e20ad8739d23ec9ddfff6a8c1..46d890093a1b9016a4461b7007ea8af0b3acd2d5`
- Findings: 1 High, 10 Medium, 3 Low; every finding needs an exploit regression and a legitimate control.

---

## File structure locked by this plan

New migrations are split by security ownership so no agent edits the same SQL
file concurrently:

- `20260729130000_network_center_worker_identity.sql`: principals, credentials,
  assignments, worker RPC v2 and scoped heartbeat.
- `20260729131000_network_center_resource_lifecycle.sql`: rollout state, queue
  admission, Aruba/client lifecycle and quarantine.
- `20260729132000_network_center_managed_commands.sql`: managed resources,
  immutable interfaces, typed intents/observations/transitions.
- `20260729133000_network_center_hardening_rpcs.sql`: worker RPC v2, browser RPC
  compatible bodies, grants/publication cutover and maintenance v2.

New implementation units:

- `supabase/functions/network-center-worker/workerAuth.ts`: validate and hash the
  request credential; PostgreSQL derives the server-owned principal.
- `infra/network-center-worker/src/routeros/boundedSftpRead.ts`: byte/deadline
  bounded streams.
- `infra/network-center-worker/src/backupStore.ts`: verified save, reserve and
  rotation.
- `infra/network-center-worker/src/reconciliation.ts`: action-specific
  postcondition engine.
- `src/lib/network-center/intentRegistry.ts`: stable browser intent lifecycle.
- `scripts/network-center-rollout-manifest.json` plus validate/apply/audit scripts:
  immutable migration rollout and receipts.
- `infra/network-center-worker/deploy/**`: systemd, host bootstrap and rollback
  assets; PowerShell orchestration remains under `scripts/`.

---

### Task 1: Fail Closed Before Any Migration-Backed Tenant Test

**Findings:** `ci-shadow-migration-production-lock`

**Files:**

- Modify: `scripts/test-cross-tenant.mjs`
- Create: `scripts/network-center-disposable-db.mjs`
- Create: `scripts/__tests__/network-center-cross-tenant-target.test.mjs`
- Modify: `src/lib/__tests__/networkCenterDatabaseRuntimeSafety.test.ts`

- [x] **Step 1: Export target classification and write the failing Node tests**

Add tests with these required cases:

```js
test("rejects production and unknown targets before fetch", async () => {
  for (const target of [
    { projectRef: "production-ref", marker: "disposable" },
    { projectRef: "random-ref", marker: undefined },
  ]) {
    assert.throws(
      () => assertDisposableTenantTestTarget(target, {
        productionRefs: new Set(["production-ref"]),
      }),
      /refuses production|disposable marker/i,
    );
  }
});

test("accepts one per-run local Supabase identity", () => {
  assert.deepEqual(
    assertDisposableTenantTestTarget({
      projectRef: "local-run-019f8c63",
      marker: "network-center-disposable:v1:019f8c63",
      host: "127.0.0.1",
    }, { productionRefs: new Set(["production-ref"]) }),
    { projectRef: "local-run-019f8c63", host: "127.0.0.1" },
  );
});
```

- [x] **Step 2: Run RED and confirm the missing export failure**

```powershell
node --test scripts/__tests__/network-center-cross-tenant-target.test.mjs
```

Expected: FAIL because `assertDisposableTenantTestTarget` does not exist.

- [x] **Step 3: Implement target proof before any fetch or SQL construction**

`network-center-disposable-db.mjs` must:

```js
export function assertDisposableTenantTestTarget(
  { projectRef, marker, host },
  { productionRefs },
) {
  if (!projectRef || productionRefs.has(projectRef)) {
    throw new Error("Cross-tenant test refuses production project reference");
  }
  if (!/^network-center-disposable:v1:[a-z0-9-]{8,64}$/i.test(marker ?? "")) {
    throw new Error("Cross-tenant test requires an immutable disposable marker");
  }
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("Cross-tenant test target must be the per-run local Supabase stack");
  }
  return { projectRef, host };
}
```

Remove the production Management API shadow-migration fallback. Missing deployed
RPC outside an approved local stack must throw setup failure without sending DDL.

- [x] **Step 4: Verify GREEN plus static runtime safety**

```powershell
node --test scripts/__tests__/network-center-cross-tenant-target.test.mjs
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterDatabaseRuntimeSafety.test.ts
node scripts/test-cross-tenant.mjs --dry-run
```

Expected: all pass; dry-run states that no database request was made.

- [x] **Step 5: Commit only Task 1 files**

```powershell
git add -- scripts/test-cross-tenant.mjs scripts/network-center-disposable-db.mjs scripts/__tests__/network-center-cross-tenant-target.test.mjs src/lib/__tests__/networkCenterDatabaseRuntimeSafety.test.ts
git commit -m "fix(network-center): cô lập kiểm thử migration khỏi production" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 2: Add Frontend Off Mode Before Shipping The Route

**Files:**

- Modify: `src/lib/network-center/runtime.ts`
- Modify: `src/hooks/network-center/useNetworkCenter.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/pages/home/launcherTiles.ts`
- Create: `src/lib/__tests__/networkCenterRuntimeMode.test.ts`
- Modify: `src/lib/__tests__/networkCenterReactQueryRuntime.test.ts`

- [x] **Step 1: Write RED tests for explicit `off|demo|production`**

```ts
describe("Network Center runtime mode", () => {
  it("fails closed to off in a production build without an explicit mode", () => {
    expect(resolveNetworkCenterMode(undefined, true)).toBe("off");
  });

  it.each(["off", "production"] as const)("accepts %s", (mode) => {
    expect(resolveNetworkCenterMode(mode, true)).toBe(mode);
  });

  it("fails demo mode closed in a production build", () => {
    expect(resolveNetworkCenterMode("demo", true)).toBe("off");
    expect(resolveNetworkCenterMode("demo", false)).toBe("demo");
  });
});
```

- [x] **Step 2: Run RED**

```powershell
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterRuntimeMode.test.ts
```

- [x] **Step 3: Implement a pure resolver and route/navigation guards**

Use this public contract:

```ts
export type NetworkCenterMode = "off" | "demo" | "production";

export function resolveNetworkCenterMode(
  raw: string | undefined,
  isProductionBuild: boolean,
): NetworkCenterMode;

export function isNetworkCenterEnabled(mode: NetworkCenterMode): boolean {
  return mode !== "off";
}
```

When `off`, do not mount `NetworkCenterApp`, create React Query hooks, or render
sidebar/launcher links. Direct navigation renders the existing Not Found/disabled
state, not demo data.

- [x] **Step 4: Run focused mode, permissions and route tests**

```powershell
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterRuntimeMode.test.ts src/lib/__tests__/networkCenterPermissions.test.ts src/lib/__tests__/networkCenterReactQueryRuntime.test.ts
```

- [x] **Step 5: Commit Task 2**

```powershell
git add -- src/lib/network-center/runtime.ts src/hooks/network-center/useNetworkCenter.ts src/App.tsx src/components/layout/Sidebar.tsx src/pages/home/launcherTiles.ts src/lib/__tests__/networkCenterRuntimeMode.test.ts src/lib/__tests__/networkCenterReactQueryRuntime.test.ts
git commit -m "fix(network-center): thêm chế độ off fail-closed" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 3: Create Per-Worker Principal, Credential And Assignment Registry

**Findings:** `worker-secret-unbound`, foundation for `worker-heartbeat-global-view`

**Files:**

- Create: `supabase/migrations/20260729130000_network_center_worker_identity.sql`
- Modify: `src/lib/__tests__/networkCenterDatabaseMigration.test.ts`
- Create: `src/lib/__tests__/networkCenterWorkerIdentityMigration.test.ts`

- [ ] **Step 1: Add RED schema and ACL assertions**

```ts
for (const table of [
  "network_workers",
  "network_worker_credentials",
  "network_worker_assignments",
]) expect(sql).toContain(`public.${table}`);

expect(sql).toMatch(/secret_digest\s+(text|character\(64\))\s+not null/i);
expect(sql).toMatch(/unique\s*\(secret_digest\)/i);
expect(sql).toMatch(/foreign key \(organization_id, building_id\)/i);
expect(sql).toMatch(/network_center_authenticate_worker_v2/i);
expect(sql).toMatch(/revoke all on function .* from public, anon, authenticated/i);
expect(sql).not.toMatch(/plaintext_secret|worker_secret\s+text/i);
```

- [ ] **Step 2: Run RED and verify missing migration failure**

```powershell
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterWorkerIdentityMigration.test.ts
```

- [ ] **Step 3: Implement additive tables and indexed invariants**

The migration uses these authoritative keys and states:

```sql
CREATE TABLE public.network_workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_key text NOT NULL UNIQUE CHECK (worker_key ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 128),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DRAINING','DISABLED')),
  capabilities text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.network_worker_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id uuid NOT NULL REFERENCES public.network_workers(id) ON DELETE CASCADE,
  secret_digest character(64) NOT NULL UNIQUE
    CHECK (secret_digest ~ '^[a-f0-9]{64}$'),
  fingerprint text NOT NULL UNIQUE,
  not_before timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  CHECK (expires_at > not_before)
);
```

Assignments include organization, building, MikroTik device, `can_poll`,
`can_inventory`, `can_execute`, active interval and composite device/building FK.
Indexes begin with `worker_id`; a partial unique prevents two active polling
owners for one device.

- [ ] **Step 4: Implement service-role-only auth/admin RPC contracts**

Create:

```sql
app_private.network_center_authenticate_worker_v2(p_secret_digest text)
network_center_admin_provision_worker_v1(p_worker_key text, p_display_name text, p_secret_digest text, p_fingerprint text, p_expires_at timestamptz, p_assignments jsonb)
network_center_admin_rotate_worker_credential_v1(p_worker_key text, p_secret_digest text, p_fingerprint text, p_not_before timestamptz, p_expires_at timestamptz)
network_center_admin_revoke_worker_credential_v1(p_worker_key text, p_fingerprint text)
network_center_admin_set_worker_assignments_v1(p_worker_key text, p_assignments jsonb)
```

Each function pins search path and validates bounded arrays. Admin RPCs grant
EXECUTE only to `service_role`; the private auth helper is callable only from the
new SECURITY DEFINER worker RPCs and returns worker UUID/capabilities internally,
never digest/fingerprint to Edge.

- [ ] **Step 5: Run migration/ACL/view gates**

```powershell
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterDatabaseMigration.test.ts src/lib/__tests__/networkCenterWorkerIdentityMigration.test.ts
node scripts/check-definer-acl.mjs
node scripts/check-view-invoker.mjs
```

- [ ] **Step 6: Commit Task 3**

```powershell
git add -- supabase/migrations/20260729130000_network_center_worker_identity.sql src/lib/__tests__/networkCenterDatabaseMigration.test.ts src/lib/__tests__/networkCenterWorkerIdentityMigration.test.ts
git commit -m "fix(network-center): ràng buộc danh tính và assignment worker" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 4: Derive Worker Identity At The Edge And Remove Body Authority

**Findings:** `worker-secret-unbound`

**Files:**

- Create: `supabase/functions/network-center-worker/workerAuth.ts`
- Modify: `supabase/functions/network-center-worker/index.ts`
- Modify: `supabase/functions/network-center-worker/index.test.ts`
- Modify: `infra/network-center-worker/src/apiClient.ts`
- Modify: `infra/network-center-worker/src/config.ts`
- Modify: `infra/network-center-worker/src/main.ts`
- Modify: `infra/network-center-worker/.env.example`
- Modify: `infra/network-center-worker/test/apiClient.test.ts`
- Modify: `infra/network-center-worker/test/config.test.ts`

- [ ] **Step 1: Write RED Edge tests for server-owned principal**

```ts
Deno.test("spoofed workerId never reaches an RPC", async () => {
  const response = await requestEdge("heartbeat", {
    workerId: "victim-worker",
    version: "1.0.0",
  }, { secret: validSecret });
  assertEquals(response.status, 400);
  assertEquals(recordedRpcCalls.length, 0);
});

Deno.test("credential digest reaches RPC but no worker UUID is Edge-controlled", async () => {
  await requestEdge("heartbeat", { version: "1.0.0" }, { secret: validSecret });
  assertMatch(recordedRpcCalls.at(-1)?.args.p_credential_digest, /^[a-f0-9]{64}$/);
  assertEquals(recordedRpcCalls.at(-1)?.args.p_worker_id, undefined);
});
```

- [ ] **Step 2: Write RED worker tests proving request bodies omit worker ID**

```ts
expect(JSON.parse(fetchCalls[0].init.body as string)).not.toHaveProperty("workerId");
expect(fetchCalls[0].init.headers).toMatchObject({
  "x-network-worker-secret": "test-secret-with-at-least-32-bytes",
});
```

- [ ] **Step 3: Run both RED suites**

```powershell
npx --yes deno test --config supabase/functions/network-center-worker/deno.json supabase/functions/network-center-worker/index.test.ts --allow-env
npm --prefix infra/network-center-worker test -- apiClient.test.ts config.test.ts
```

- [ ] **Step 4: Implement digest authentication and body rejection**

`workerAuth.ts` exposes:

```ts
export async function credentialDigestHex(secret: string): Promise<string>;
```

It requires 32–512 characters, computes SHA-256 with Web Crypto and never logs
secret/digest. Route schemas use `.strict()` and reject `workerId`. Edge passes
only `p_credential_digest` into every v2 RPC; PostgreSQL authenticates and derives
the UUID at the same boundary that enforces assignment. Worker config retains a
local `workerKey` only for log/readback labeling; API bodies never send it.

- [ ] **Step 5: Run GREEN suites and type checks**

```powershell
npx --yes deno test --config supabase/functions/network-center-worker/deno.json supabase/functions/network-center-worker/index.test.ts --allow-env
npm --prefix infra/network-center-worker test -- apiClient.test.ts config.test.ts
npm --prefix infra/network-center-worker run typecheck
```

- [ ] **Step 6: Commit Task 4**

```powershell
git add -- supabase/functions/network-center-worker infra/network-center-worker/src/apiClient.ts infra/network-center-worker/src/config.ts infra/network-center-worker/src/main.ts infra/network-center-worker/.env.example infra/network-center-worker/test/apiClient.test.ts infra/network-center-worker/test/config.test.ts
git commit -m "fix(network-center): suy ra worker principal tại Edge" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 5: Enforce Assignments In Every Worker RPC And Scope Heartbeats

**Findings:** `worker-secret-unbound`, `worker-heartbeat-global-view`

**Files:**

- Create: `supabase/migrations/20260729133000_network_center_hardening_rpcs.sql`
- Modify: `supabase/functions/network-center-worker/index.ts`
- Modify: `supabase/functions/network-center-worker/index.test.ts`
- Modify: `src/lib/network-center/runtime.ts`
- Modify: `src/hooks/network-center/useNetworkCenter.ts`
- Modify: `src/lib/__tests__/networkCenterRealtimeExposureSafety.test.ts`
- Modify: `src/lib/__tests__/networkCenterWorkerIdentityMigration.test.ts`

- [ ] **Step 1: Add RED coverage for the complete worker route matrix**

The test enumerates all routes and proves each call receives only the authenticated
principal:

```ts
const protectedRoutes = [
  "heartbeat", "connections", "claim", "renew", "inventory", "ingest",
  "stage", "observe", "complete", "incident", "snapshot", "maintenance",
] as const;

for (const route of protectedRoutes) {
  it(`${route} is assignment-scoped`, () => {
    expect(sqlFor(route)).toMatch(/network_center_worker_can_access_building_v2/i);
  });
}
```

Add two-worker/two-org fixtures: assigned list/claim/write pass; unassigned
connection, command ID, device ID and building ID all fail without side effects.

- [ ] **Step 2: Run RED static/Edge/UI safety tests**

```powershell
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterWorkerIdentityMigration.test.ts src/lib/__tests__/networkCenterRealtimeExposureSafety.test.ts
npx --yes deno test --config supabase/functions/network-center-worker/deno.json supabase/functions/network-center-worker/index.test.ts --allow-env
```

- [ ] **Step 3: Add v2 RPCs and revoke legacy worker functions**

Every v2 RPC takes `p_credential_digest text`, calls the private auth helper,
derives organization/building/device from the final target row and calls:

```sql
IF NOT app_private.network_center_worker_can_access_device_v2(
  v_worker_id, v_organization_id, v_building_id, v_device_id, v_required_capability
) THEN
  RAISE EXCEPTION 'Worker is not assigned to target building' USING ERRCODE = '42501';
END IF;
```

Connections list joins active device assignments. Claim selects only assigned
`can_execute` commands. Poll/ingest requires `can_poll`, inventory requires
`can_inventory`, and maintenance requires the explicit maintenance capability.
During a bounded compatibility window, legacy v1 worker bodies ignore caller
`workerId`, map only to the seeded compatibility principal and enforce the same
assignments. A service-role-only finalize function disables compatibility and
revokes legacy worker EXECUTE grants after the clean soak; no v1 body keeps a
fleet-wide bypass.
Renew/stage/complete/ingest/inventory/incident/snapshot validate target ownership
again even when a command was previously claimed. Revoke all legacy v1 worker
RPCs from `PUBLIC`, `anon`, `authenticated` and `service_role` after Edge cutover.

- [ ] **Step 4: Remove browser heartbeat table exposure**

The migration revokes authenticated SELECT and drops raw
`network_worker_heartbeats` from `supabase_realtime`. It adds the tenant-keyed,
RLS-protected `network_worker_building_status` projection to publication.
`NETWORK_CENTER_REALTIME_TABLES` swaps raw heartbeat for this projection and
treats payloads only as scoped invalidation.

- [ ] **Step 5: Run GREEN plus database security gates**

```powershell
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterWorkerIdentityMigration.test.ts src/lib/__tests__/networkCenterRealtimeExposureSafety.test.ts src/lib/__tests__/networkCenterReactQueryRuntime.test.ts
npx --yes deno test --config supabase/functions/network-center-worker/deno.json supabase/functions/network-center-worker/index.test.ts --allow-env
node scripts/check-definer-acl.mjs
node scripts/check-view-invoker.mjs
```

- [ ] **Step 6: Commit Task 5**

```powershell
git add -- supabase/migrations/20260729133000_network_center_hardening_rpcs.sql supabase/functions/network-center-worker/index.ts supabase/functions/network-center-worker/index.test.ts src/lib/network-center/runtime.ts src/hooks/network-center/useNetworkCenter.ts src/lib/__tests__/networkCenterRealtimeExposureSafety.test.ts src/lib/__tests__/networkCenterWorkerIdentityMigration.test.ts
git commit -m "fix(network-center): khóa mọi worker RPC theo building assignment" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 6: Bound SFTP Reads Before Allocation

**Findings:** `sftp-backup-unbounded-read`

**Files:**

- Create: `infra/network-center-worker/src/routeros/boundedSftpRead.ts`
- Create: `infra/network-center-worker/test/boundedSftpRead.test.ts`
- Modify: `infra/network-center-worker/src/routeros/sshConnector.ts`
- Modify: `infra/network-center-worker/src/config.ts`
- Modify: `infra/network-center-worker/test/sshConnector.test.ts`

- [ ] **Step 1: Write RED stream tests**

Cover: exact limit succeeds; limit+1 aborts before concatenation; zero-progress
stream hits deadline; source error propagates typed; every path destroys stream
and closes SFTP handle.

```ts
await expect(readSftpFileBounded(source, {
  maxBytes: 8,
  timeoutMs: 100,
  kind: "export",
})).rejects.toMatchObject({ code: "SFTP_READ_LIMIT_EXCEEDED" });
expect(source.destroyed).toBe(true);
```

- [ ] **Step 2: Run RED**

```powershell
npm --prefix infra/network-center-worker test -- boundedSftpRead.test.ts
```

- [ ] **Step 3: Implement bounded stream with one terminal cleanup path**

```ts
export const ROUTER_EXPORT_MAX_BYTES = 1 * 1024 * 1024;
export const ROUTER_BACKUP_MAX_BYTES = 16 * 1024 * 1024;
export const ROUTER_EXPORT_TIMEOUT_MS = 15_000;
export const ROUTER_BACKUP_TIMEOUT_MS = 45_000;
```

Accumulate the small text export only after checking
`total + chunk.length <= maxBytes`; stream binary backup directly to a temp file
with byte counting. Deadline destroys the stream with a typed error. `finally`
removes listeners, clears timer, deletes incomplete temp files and closes SFTP.

- [ ] **Step 4: Run GREEN worker tests and typecheck**

```powershell
npm --prefix infra/network-center-worker test -- boundedSftpRead.test.ts sshConnector.test.ts
npm --prefix infra/network-center-worker run typecheck
```

- [ ] **Step 5: Commit Task 6**

```powershell
git add -- infra/network-center-worker/src/routeros/boundedSftpRead.ts infra/network-center-worker/src/routeros/sshConnector.ts infra/network-center-worker/src/config.ts infra/network-center-worker/test/boundedSftpRead.test.ts infra/network-center-worker/test/sshConnector.test.ts
git commit -m "fix(network-center): giới hạn byte và deadline SFTP" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 7: Add Verified Backup Rotation And Disk Reserve

**Findings:** `backup-volume-unbounded-retention`

**Files:**

- Create: `infra/network-center-worker/src/backupStore.ts`
- Create: `infra/network-center-worker/test/backupStore.test.ts`
- Modify: `infra/network-center-worker/src/commands.ts`
- Modify: `infra/network-center-worker/src/config.ts`
- Modify: `infra/network-center-worker/test/commands.test.ts`
- Modify: `infra/network-center-worker/docker-compose.yml`

- [ ] **Step 1: Write RED tests with an isolated temp directory**

Tests prove: encrypted write + hash readback; max 20/device; max age 30 days;
6 GiB soft/8 GiB hard volume caps; 20 GiB host free reserve; current artifact
and newest two verified artifacts never deleted; insufficient reserve prevents
connector mutation.

```ts
await expect(store.saveVerified(candidate)).rejects.toMatchObject({
  code: "BACKUP_RESERVE_UNAVAILABLE",
});
expect(connector.rebootCalls).toBe(0);
```

- [ ] **Step 2: Run RED**

```powershell
npm --prefix infra/network-center-worker test -- backupStore.test.ts commands.test.ts
```

- [ ] **Step 3: Implement `FileBackupStore`**

```ts
export type BackupPolicy = Readonly<{
  maxPerDevice: 20;
  maxAgeMs: number;
  maxVolumeBytes: number;
  minimumFreeBytes: number;
}>;

export interface BackupStore {
  saveVerified(input: BackupCandidate): Promise<VerifiedBackup>;
  rotate(now: Date): Promise<BackupRotationReport>;
  pressure(): Promise<BackupPressure>;
}
```

Use `fs.promises.statfs`, atomic `wx` writes, fsync, hash readback and
oldest-safe-first deletion. Cleanup accepts only normalized descendants of the
configured backup root. Compose mounts a dedicated writable volume; root
filesystem stays read-only.

- [ ] **Step 4: Run GREEN and worker suite**

```powershell
npm --prefix infra/network-center-worker test -- backupStore.test.ts commands.test.ts
npm --prefix infra/network-center-worker run typecheck
```

- [ ] **Step 5: Commit Task 7**

```powershell
git add -- infra/network-center-worker/src/backupStore.ts infra/network-center-worker/src/commands.ts infra/network-center-worker/src/config.ts infra/network-center-worker/docker-compose.yml infra/network-center-worker/test/backupStore.test.ts infra/network-center-worker/test/commands.test.ts
git commit -m "fix(network-center): xoay vòng backup và giữ disk reserve" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 8: Add Atomic Queue Budgets And Bounded History

**Findings:** `execute-queue-unbounded-admission`, part of `duplicate-action-idempotency`, `client-session-history-unbounded-retention`

**Files:**

- Create: `supabase/migrations/20260729131000_network_center_resource_lifecycle.sql`
- Modify: `src/lib/__tests__/networkCenterDatabaseMigration.test.ts`
- Create: `src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts`
- Modify: `scripts/verify-network-center-queue.mjs`
- Modify: `scripts/verify-network-center-retention.mjs`

- [ ] **Step 1: Write RED migration tests for all fixed thresholds**

```ts
expect(sql).toMatch(/max.*1.*disruptive.*device/is);
expect(sql).toMatch(/max.*2.*nonterminal.*device/is);
expect(sql).toMatch(/max.*8.*actor/is);
expect(sql).toMatch(/max.*30.*organization/is);
expect(sql).toMatch(/12.*device.*hour/is);
expect(sql).toMatch(/30.*actor.*hour/is);
expect(sql).toMatch(/120.*organization.*hour/is);
expect(sql).toMatch(/semantic_fingerprint/i);
expect(sql).toMatch(/interval '10 minutes'/i);
expect(sql).toMatch(/network_client_sessions[\s\S]*interval '90 days'/i);
expect(sql).toMatch(/jsonb_array_length[\s\S]*(16|<= 16)/i);
expect(sql).toMatch(/network_commands[\s\S]*interval '180 days'/i);
expect(sql).not.toMatch(/delete from public\.network_audit_events/i);
```

- [ ] **Step 2: Run RED**

```powershell
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts
```

- [ ] **Step 3: Implement atomic admission inside enqueue transaction**

Acquire an advisory transaction lock derived from organization/device before
counting and inserting. Compute `semantic_fingerprint` from canonical target,
action and sanitized parameters; never include reason or browser UUID. Enforce
one device disruptive, two total/device, eight actor and thirty organization
non-terminal rows, plus 12/device/hour, 30/actor/hour and 120/org/hour. Cooldowns
are reboot 10m, cycle 2m, DNS/DHCP 30s and snapshot 60s. Return typed
SQLSTATE/details and create no orphan events on rejection.

- [ ] **Step 4: Extend retention with bounded tenant batches**

Retention deletes expired client sessions after 90 days, trims address history
to the 16 newest distinct entries during ingest, and expires terminal
commands/attempts/events after 180 days only after sanitized audit summary exists.
Active/UNCERTAIN and append-only audit are never purged. Each delete uses indexed
timestamp predicates, bounded batches and a repeat-safe return report.

- [ ] **Step 5: Run static tests and verifiers**

```powershell
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterDatabaseMigration.test.ts src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts
node scripts/verify-network-center-queue.mjs
node scripts/verify-network-center-retention.mjs
node scripts/check-definer-acl.mjs
```

- [ ] **Step 6: Commit Task 8**

```powershell
git add -- supabase/migrations/20260729131000_network_center_resource_lifecycle.sql src/lib/__tests__/networkCenterDatabaseMigration.test.ts src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts scripts/verify-network-center-queue.mjs scripts/verify-network-center-retention.mjs
git commit -m "fix(network-center): giới hạn queue và vòng đời dữ liệu" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 9: Keep Aruba Unlimited While Bounding Discovery Churn

**Findings:** `aruba-inventory-unbounded-retention`, `aruba-malformed-poll-poisoning`

**Files:**

- Modify: `supabase/migrations/20260729131000_network_center_resource_lifecycle.sql`
- Modify: `supabase/functions/network-center-worker/index.ts`
- Modify: `infra/network-center-worker/src/domain.ts`
- Modify: `infra/network-center-worker/src/routeros/sshConnector.ts`
- Modify: `infra/network-center-worker/src/polling.ts`
- Modify: `infra/network-center-worker/test/polling.test.ts`
- Modify: `infra/network-center-worker/test/sshConnector.test.ts`
- Modify: `src/lib/network-center/dto.ts`
- Modify: `src/lib/network-center/supabaseRepository.ts`
- Modify: `src/components/network-center/tabs/TopologyTab.tsx`
- Modify: `src/lib/__tests__/networkCenterSupabaseRepository.test.ts`
- Modify: `src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts`

- [ ] **Step 1: Write RED worker tests for stable identity and item isolation**

```ts
it("deduplicates aliases by serial then hardware MAC", async () => {
  const result = await poll(mixedNeighbors([
    { serial: "AP-001", mac: "AA:BB:CC:DD:EE:01", name: "old-name" },
    { serial: "AP-001", mac: "AA:BB:CC:DD:EE:01", name: "new-name" },
  ]));
  expect(result.inventory.valid).toHaveLength(1);
  expect(result.inventory.valid[0].aliases).toEqual(expect.arrayContaining(["old-name", "new-name"]));
});

it("quarantines one malformed Aruba item without losing valid telemetry", async () => {
  const result = await poll(mixedValidAndMalformedFixture);
  expect(result.telemetry.status).toBe("OK");
  expect(result.inventory.status).toBe("DEGRADED");
  expect(result.inventory.quarantined).toHaveLength(1);
  expect(result.incidents).not.toContainEqual(expect.objectContaining({ kind: "ROUTER_OUTAGE" }));
});
```

- [ ] **Step 2: Write RED database/UI pagination tests**

Require stable-key unique index, 64-new-identities/poll and 128/day/router with a
one-time 512/24h enrollment window, `STALE` after 24h, inactive after 7 days,
discovery-only purge at 30 days, alias tombstones 90 days, quarantine retention
7 days/1,000 per router, and keyset pages default 100/max 250. Assert there is no
total Aruba count check or client-side loop that fetches all pages.

- [ ] **Step 3: Run RED suites**

```powershell
npm --prefix infra/network-center-worker test -- polling.test.ts sshConnector.test.ts
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts src/lib/__tests__/networkCenterSupabaseRepository.test.ts
```

- [ ] **Step 4: Implement stable observation and per-item quarantine**

`RouterDeviceObservation` adds:

```ts
type RouterDeviceObservation = Readonly<{
  stableIdentity: string;
  identitySource: "SERIAL" | "HARDWARE_MAC";
  externalKey: string;
  aliases: readonly string[];
  displayOnly: true;
}>;
```

Serial wins; otherwise normalized unicast hardware MAC. Missing/invalid stable
identity becomes a redacted quarantine item. Polling sends valid telemetry even
when inventory is degraded and opens `INVENTORY_DEGRADED` only.

- [ ] **Step 5: Implement database aging/rate protection and incremental UI**

Upsert existing stable identities without consuming the new-identity budget.
Within one transaction, quarantine excess identities beyond 64/poll or 128/day;
allow at most 512 stable identities during the first 24h enrollment window and
promote later identities only after three sightings spanning 10 minutes.
Scheduled retention marks stale/inactive, purges only discovery-only rows and
keeps 90-day alias tombstones.
Repository returns `{ items, nextCursor }`; `TopologyTab` renders one page and a
load-more control without constructing an all-inventory array.

- [ ] **Step 6: Run GREEN, property fixture and type checks**

```powershell
npm --prefix infra/network-center-worker test -- polling.test.ts sshConnector.test.ts
npm --prefix infra/network-center-worker run typecheck
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts src/lib/__tests__/networkCenterSupabaseRepository.test.ts
npm run typecheck:baseline
```

- [ ] **Step 7: Commit Task 9**

```powershell
git add -- supabase/migrations/20260729131000_network_center_resource_lifecycle.sql supabase/functions/network-center-worker/index.ts infra/network-center-worker/src/domain.ts infra/network-center-worker/src/routeros/sshConnector.ts infra/network-center-worker/src/polling.ts infra/network-center-worker/test/polling.test.ts infra/network-center-worker/test/sshConnector.test.ts src/lib/network-center/dto.ts src/lib/network-center/supabaseRepository.ts src/components/network-center/tabs/TopologyTab.tsx src/lib/__tests__/networkCenterSupabaseRepository.test.ts src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts
git commit -m "fix(network-center): giới hạn churn Aruba không đặt quota tổng" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 10: Bind Interface Protection And Bootstrap Ownership To Stable State

**Findings:** `protected-interface-rename-bypass`, `bootstrap-recovery-cidr-broadening`, `bootstrap-router-user-clobber`

**Files:**

- Create: `supabase/migrations/20260729132000_network_center_managed_commands.sql`
- Modify: `src/lib/__tests__/networkCenterDatabaseMigration.test.ts`
- Create: `src/lib/__tests__/networkCenterManagedCommandsMigration.test.ts`
- Modify: `infra/network-center-worker/src/domain.ts`
- Modify: `infra/network-center-worker/src/routeros/sshConnector.ts`
- Modify: `infra/network-center-worker/test/sshConnector.test.ts`
- Modify: `infra/network-center-worker/scripts/generate-router-bootstrap.mjs`
- Modify: `infra/network-center-worker/templates/router-bootstrap.rsc.tmpl`
- Modify: `infra/network-center-worker/templates/router-rollback.rsc.tmpl`
- Modify: `infra/network-center-worker/templates/router-lockdown.rsc.tmpl`
- Modify: `infra/network-center-worker/test/bootstrap.test.ts`

- [ ] **Step 1: Write RED renamed-interface exploit test**

```ts
it("rejects a renamed ether1 even when its display name looks like access", async () => {
  connector.fixture.interfaces = [{
    id: "*1", name: "room-101", defaultName: "ether1", type: "ether", running: true,
  }];
  await expect(connector.cycleAccessPort({
    currentName: "room-101",
    immutableKey: "ether1",
    durationSeconds: 5,
  })).rejects.toMatchObject({ code: "PROTECTED_INTERFACE" });
});
```

- [ ] **Step 2: Write RED bootstrap exploit tests**

Reject public CIDR, RFC1918 `/23`, missing/non-access recovery interface and any
router username other than `ihome-nc-worker`. Generated bootstrap must abort when an
existing user lacks the exact ownership marker; rollback may remove only the
marked user and must restore captured management-service settings.

- [ ] **Step 3: Run RED**

```powershell
npm --prefix infra/network-center-worker test -- sshConnector.test.ts bootstrap.test.ts
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterManagedCommandsMigration.test.ts
```

- [ ] **Step 4: Create managed-resource registry and safe interface linkage**

```sql
CREATE TABLE public.network_managed_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  building_id uuid NOT NULL,
  device_id uuid NOT NULL REFERENCES public.network_devices(id) ON DELETE CASCADE,
  resource_kind text NOT NULL CHECK (resource_kind IN ('ROUTER','INTERFACE','MANAGED_USER')),
  stable_key text NOT NULL,
  display_name text NOT NULL,
  enrolled_role text,
  protected boolean NOT NULL DEFAULT true,
  ownership_marker text,
  enrollment_state text NOT NULL CHECK (enrollment_state IN ('DISCOVERED','ENROLLED','REVOKED')),
  last_verified_at timestamptz,
  UNIQUE (device_id, resource_kind, stable_key)
);
```

Link `network_interfaces.managed_resource_id`. Worker discovery persists
`default-name`; physical cycle RPC and connector require enrolled ACCESS resource,
`protected=false` and exact current-name/default-name readback. No immutable key
means fail closed.

- [ ] **Step 5: Implement fixed bootstrap identity and narrow recovery scope**

Generator uses `ihome-nc-worker` and marker
`ihomecrm-network-center:v1:${deploymentId}`. IPv4 recovery must be RFC1918
`/28`–`/32` (default `/32`); template binds both `src-address` and explicit non-WAN
`in-interface`. Bootstrap checks the existing user comment before any password,
group or key mutation. Rollback checks the same marker and restores the captured
service allowlist/disabled state.

- [ ] **Step 6: Run GREEN and migration security checks**

```powershell
npm --prefix infra/network-center-worker test -- sshConnector.test.ts bootstrap.test.ts
npm --prefix infra/network-center-worker run typecheck
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterManagedCommandsMigration.test.ts src/lib/__tests__/networkCenterInventoryDiscoverySafety.test.ts
node scripts/check-definer-acl.mjs
```

- [ ] **Step 7: Commit Task 10**

```powershell
git add -- supabase/migrations/20260729132000_network_center_managed_commands.sql src/lib/__tests__/networkCenterDatabaseMigration.test.ts src/lib/__tests__/networkCenterManagedCommandsMigration.test.ts infra/network-center-worker/src/domain.ts infra/network-center-worker/src/routeros/sshConnector.ts infra/network-center-worker/test/sshConnector.test.ts infra/network-center-worker/scripts/generate-router-bootstrap.mjs infra/network-center-worker/templates/router-bootstrap.rsc.tmpl infra/network-center-worker/templates/router-rollback.rsc.tmpl infra/network-center-worker/templates/router-lockdown.rsc.tmpl infra/network-center-worker/test/bootstrap.test.ts
git commit -m "fix(network-center): khóa tài nguyên RouterOS bằng identity bất biến" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 11: Persist Stable Intents And Prove Action-Specific Outcomes

**Findings:** `duplicate-action-idempotency`, `false-success-reconciliation`

**Files:**

- Modify: `supabase/migrations/20260729132000_network_center_managed_commands.sql`
- Create: `infra/network-center-worker/src/reconciliation.ts`
- Create: `infra/network-center-worker/test/reconciliation.test.ts`
- Modify: `infra/network-center-worker/src/routeros/connector.ts`
- Modify: `infra/network-center-worker/src/routeros/sshConnector.ts`
- Modify: `infra/network-center-worker/src/commands.ts`
- Modify: `infra/network-center-worker/test/commands.test.ts`
- Create: `src/lib/network-center/intentRegistry.ts`
- Create: `src/lib/__tests__/networkCenterIntentRegistry.test.ts`
- Modify: `src/hooks/network-center/useNetworkCenter.ts`
- Modify: `src/components/network-center/NetworkActionDialog.tsx`
- Modify: `src/lib/__tests__/networkCenterExecuteGuard.test.tsx`
- Modify: `src/lib/__tests__/networkCenterManagedCommandsMigration.test.ts`

- [ ] **Step 1: Write RED browser intent tests**

```ts
it("keeps one idempotency key across close and reopen until terminal", () => {
  const registry = createIntentRegistry(fixedUuid);
  const first = registry.begin(targetAction);
  registry.closeDialog(targetAction);
  expect(registry.begin(targetAction)).toEqual(first);
  registry.observe(first.id, "SUCCEEDED");
  expect(registry.begin(targetAction).id).not.toBe(first.id);
});
```

Add component test: close while mutation pending does not enable a duplicate
submit; reload/reconnect restores the active command by semantic target.

- [ ] **Step 2: Write RED action reconciliation tests**

Cover exact rules:

- DNS flush: received ACK succeeds; ambiguous transport safely retries same intent.
- DHCP renew: `bound` plus newer expiry succeeds; not-applicable is typed terminal.
- Port cycle: exact immutable interface must transition and end enabled.
- Reboot: new boot/uptime after intent is required.
- Snapshot: redacted snapshot hash and encrypted artifact hash must both persist.
- Generic `reachable=true` without those facts remains `UNCERTAIN`.

- [ ] **Step 3: Run RED suites**

```powershell
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterIntentRegistry.test.ts src/lib/__tests__/networkCenterExecuteGuard.test.tsx src/lib/__tests__/networkCenterManagedCommandsMigration.test.ts
npm --prefix infra/network-center-worker test -- reconciliation.test.ts commands.test.ts
```

- [ ] **Step 4: Add typed command schema and transition enforcement**

Extend `network_commands` with managed target, `intent_type`, pre-observation,
expected postcondition, observation deadline and transition version. Create
append-only `network_command_observations`. A SECURITY DEFINER transition
function accepts the current fencing/version token and rejects illegal or stale
transitions. Only a matching typed postcondition may write `SUCCEEDED`.

- [ ] **Step 5: Implement pure reconciliation strategies and stable registry**

```ts
export type ReconciliationDecision =
  | { outcome: "SUCCEEDED"; evidence: JsonObject }
  | { outcome: "FAILED"; code: string; evidence: JsonObject }
  | { outcome: "UNCERTAIN"; retryAfterSeconds: number; evidence: JsonObject };

export function reconcileAction(
  intent: CommandIntent,
  before: ActionObservation,
  after: ActionObservation,
): ReconciliationDecision;
```

`CommandProcessor` delegates to this function; it never maps generic health to
success. `intentRegistry` owns IDs above dialog lifecycle and clears only after
authoritative terminal status or explicit safe reset.

- [ ] **Step 6: Run GREEN, focused worker/app tests and type checks**

```powershell
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterIntentRegistry.test.ts src/lib/__tests__/networkCenterExecuteGuard.test.tsx src/lib/__tests__/networkCenterManagedCommandsMigration.test.ts
npm --prefix infra/network-center-worker test -- reconciliation.test.ts commands.test.ts
npm --prefix infra/network-center-worker run typecheck
npm run typecheck:baseline
```

- [ ] **Step 7: Commit Task 11**

```powershell
git add -- supabase/migrations/20260729132000_network_center_managed_commands.sql infra/network-center-worker/src/reconciliation.ts infra/network-center-worker/test/reconciliation.test.ts infra/network-center-worker/src/routeros/connector.ts infra/network-center-worker/src/routeros/sshConnector.ts infra/network-center-worker/src/commands.ts infra/network-center-worker/test/commands.test.ts src/lib/network-center/intentRegistry.ts src/lib/__tests__/networkCenterIntentRegistry.test.ts src/hooks/network-center/useNetworkCenter.ts src/components/network-center/NetworkActionDialog.tsx src/lib/__tests__/networkCenterExecuteGuard.test.tsx src/lib/__tests__/networkCenterManagedCommandsMigration.test.ts
git commit -m "fix(network-center): giữ intent ổn định và hậu kiểm theo action" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 12: Enforce Server-Side Building Rollout State

**Files:**

- Modify: `supabase/migrations/20260729131000_network_center_resource_lifecycle.sql`
- Modify: `src/lib/network-center/dto.ts`
- Modify: `src/lib/network-center/model.ts`
- Modify: `src/lib/network-center/supabaseRepository.ts`
- Modify: `src/components/network-center/NetworkCenterShell.tsx`
- Modify: `src/components/network-center/ExecuteGuard.tsx`
- Modify: `src/lib/__tests__/networkCenterSupabaseRepository.test.ts`
- Modify: `src/lib/__tests__/networkCenterExecuteGuard.test.tsx`
- Modify: `src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts`

- [ ] **Step 1: Write RED SQL and UI tests for `OFF|READ_ONLY|EXECUTE`**

Defaults must be `OFF`. Public building/fleet reads return the state. Every
mutation/enqueue RPC checks `EXECUTE` after permission checks. `READ_ONLY` keeps
live reads but rejects commands with stable error `NETWORK_CENTER_READ_ONLY`.

- [ ] **Step 2: Run RED**

```powershell
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts src/lib/__tests__/networkCenterSupabaseRepository.test.ts src/lib/__tests__/networkCenterExecuteGuard.test.tsx
```

- [ ] **Step 3: Implement database enforcement and truthful UI states**

Add constrained `rollout_state` to `network_site_settings`, default `OFF`, and an
indexed helper used by every public execute/settings/snapshot/maintenance RPC.
UI shows disabled/read-only state and never relies on button hiding as security.

- [ ] **Step 4: Run GREEN and permission tests**

```powershell
.\node_modules\.bin\vitest.cmd run src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts src/lib/__tests__/networkCenterSupabaseRepository.test.ts src/lib/__tests__/networkCenterExecuteGuard.test.tsx src/lib/__tests__/networkCenterPermissions.test.ts
```

- [ ] **Step 5: Commit Task 12**

```powershell
git add -- supabase/migrations/20260729131000_network_center_resource_lifecycle.sql src/lib/network-center/dto.ts src/lib/network-center/model.ts src/lib/network-center/supabaseRepository.ts src/components/network-center/NetworkCenterShell.tsx src/components/network-center/ExecuteGuard.tsx src/lib/__tests__/networkCenterSupabaseRepository.test.ts src/lib/__tests__/networkCenterExecuteGuard.test.tsx src/lib/__tests__/networkCenterResourceLifecycleMigration.test.ts
git commit -m "feat(network-center): thêm canary theo từng tòa nhà" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 13: Build Reproducible Migration, Edge And Provisioning Tooling

**Files:**

- Create: `scripts/network-center-rollout-manifest.json`
- Create: `scripts/validate-network-center-rollout.mjs`
- Create: `scripts/apply-network-center-rollout.mjs`
- Create: `scripts/audit-network-center-rollout.mjs`
- Create: `scripts/network-center-admin.mjs`
- Create: `scripts/__tests__/network-center-rollout.test.mjs`
- Modify: `scripts/deploy-edge-fn.mjs`
- Modify: `scripts/gen-supabase-types.mjs`
- Modify: `scripts/__tests__/gen-supabase-types.test.mjs`
- Modify: `supabase/functions/README.md`
- Modify: `package.json`
- Modify: `src/integrations/supabase/types.ts`

- [ ] **Step 1: Write RED rollout tests with fake Management API**

Prove: dirty tree/revision/hash mismatch stops before fetch; wrong project ref
stops; catalog precondition mismatch stops; ordered apply produces one receipt
per migration; errors redact PAT; audit is read-only; Edge deploy command records
source digest and forces `--no-verify-jwt` only for this function.

- [ ] **Step 2: Write RED admin-tool tests**

Prove CSPRNG secret is written atomically to an explicitly named file, mode 0600
on Linux, never returned/logged, only digest/fingerprint reaches RPC, initial
worker assignments are explicit enabled buildings, and connection provisioning
stores only opaque `credential_ref` plus pinned host-key fingerprint.

- [ ] **Step 3: Run RED**

```powershell
node --test scripts/__tests__/network-center-rollout.test.mjs
```

- [ ] **Step 4: Implement manifest/validate/apply/audit contracts**

Manifest contains current reviewed Git SHA, ordered eight Network Center
migrations (four base + four hardening), SHA-256 each, expected preflight and
post-apply catalog objects. Apply acquires a named advisory lock, writes bounded
JSON receipts under ignored `.network-center-rollout/`, and never auto-runs in
GitHub Actions. Partial committed rollout generates an exact additive
forward-fix instruction; no destructive down migration.

- [ ] **Step 5: Implement `network-center-admin.mjs` commands**

Support `provision-worker`, `rotate-worker`, `revoke-worker`, `assign`,
`unassign`, `provision-connection`, `set-rollout`, `finalize-worker-cutover`, and
`status`. Read PAT/service
credential from ignored runtime configuration without printing. All writes use
service-role-only RPCs and follow with redacted readback.

- [ ] **Step 6: Run rollout tests/dry-run, apply migrations to disposable local Supabase and regenerate types**

```powershell
node --test scripts/__tests__/network-center-rollout.test.mjs
node scripts/validate-network-center-rollout.mjs
node scripts/apply-network-center-rollout.mjs --dry-run
node scripts/test-cross-tenant.mjs --local-disposable
$env:SUPABASE_TYPES_SOURCE='local'
npm run gen:types
Remove-Item Env:SUPABASE_TYPES_SOURCE
node scripts/check-definer-acl.mjs
node scripts/check-view-invoker.mjs
```

Restore the generated-file header after type generation and confirm no `as any`
was introduced in Network Center code. `scripts/gen-supabase-types.mjs` must map
`SUPABASE_TYPES_SOURCE=local` to Supabase CLI `gen types --local`, must not resolve
or export the production PAT in that mode, and must retain its atomic write path.

- [ ] **Step 7: Commit Task 13**

```powershell
git add -- scripts/network-center-rollout-manifest.json scripts/validate-network-center-rollout.mjs scripts/apply-network-center-rollout.mjs scripts/audit-network-center-rollout.mjs scripts/network-center-admin.mjs scripts/__tests__/network-center-rollout.test.mjs scripts/deploy-edge-fn.mjs scripts/gen-supabase-types.mjs scripts/__tests__/gen-supabase-types.test.mjs supabase/functions/README.md package.json src/integrations/supabase/types.ts
git commit -m "chore(network-center): tự động hóa rollout và provision an toàn" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 14: Build Immutable Vultr Host Deployment And Rollback

**Files:**

- Create: `infra/network-center-worker/deploy/network-center-worker.service`
- Create: `infra/network-center-worker/deploy/install-host.sh`
- Create: `infra/network-center-worker/deploy/activate-release.sh`
- Create: `infra/network-center-worker/deploy/rollback-release.sh`
- Create: `infra/network-center-worker/scripts/deploy-vultr.ps1`
- Create: `infra/network-center-worker/scripts/rollback-vultr.ps1`
- Create: `infra/network-center-worker/test/deploymentAssets.test.ts`
- Modify: `infra/network-center-worker/docker-compose.yml`
- Modify: `infra/network-center-worker/README.md`

- [ ] **Step 1: Write RED static/deployment dry-run tests**

Tests require: `After=network-online.target wg-quick@wg0.service`; worker UID/GID
10001; root-owned 0600 secret files; image tag and digest equal Git revision;
read-only rootfs; `0.50 CPU`, `512 MiB`, Node old-space `320 MiB`, poll/command
concurrency 3, SFTP concurrency 1, claim limit 3 and bounded PIDs; no Docker
socket; no 9Router/Zalo paths;
emergency-stop canary before switch; previous digest pointer; rollback health
readback.

- [ ] **Step 2: Run RED**

```powershell
npm --prefix infra/network-center-worker test -- deploymentAssets.test.ts
```

- [ ] **Step 3: Implement host bootstrap and immutable releases**

`install-host.sh` installs/checks Docker and WireGuard, enables `wg-quick@wg0`,
creates `/opt/ihome-network-center/{releases,secrets,backups}`, validates
ownership/modes and installs systemd unit. It never overwrites an existing wg0
or firewall policy without an exact managed marker and pre-change backup.

- [ ] **Step 4: Implement blue-green activation and exact rollback**

PowerShell uploads a source archive from `git archive` for the reviewed SHA,
builds `ihome-network-center-worker:$releaseSha`, records image digest, starts a canary
with emergency stop, verifies health/heartbeat/read-only access, drains/stops old
worker, activates new systemd release and retains previous digest. Rollback
restores that digest and verifies health; it never changes credential assignments.

- [ ] **Step 5: Run GREEN, worker suite and local image smoke**

```powershell
npm --prefix infra/network-center-worker test -- deploymentAssets.test.ts
npm --prefix infra/network-center-worker run typecheck
npm --prefix infra/network-center-worker run build
docker build -t ihome-network-center-worker:local infra/network-center-worker
docker inspect ihome-network-center-worker:local --format '{{json .Config.User}}'
```

- [ ] **Step 6: Commit Task 14**

```powershell
git add -- infra/network-center-worker/deploy infra/network-center-worker/scripts/deploy-vultr.ps1 infra/network-center-worker/scripts/rollback-vultr.ps1 infra/network-center-worker/test/deploymentAssets.test.ts infra/network-center-worker/docker-compose.yml infra/network-center-worker/README.md
git commit -m "chore(network-center): triển khai Vultr bất biến có rollback" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 15: Expand CI, Security Regression And Browser Coverage

**Files:**

- Create: `.github/workflows/network-center-validation.yml`
- Modify: `.e2e-fleet/specs/network-center.spec.ts`
- Modify: `.e2e-fleet/specs/auth.ts` only if an existing role fixture is missing
- Create: `scripts/verify-network-center-hardening.mjs`
- Create: `scripts/verify-network-center-worker-scope.mjs`
- Create: `scripts/verify-network-center-managed-resources.mjs`
- Create: `scripts/__tests__/network-center-hardening-verifiers.test.mjs`
- Modify only implementation/test files required by review findings

- [ ] **Step 1: Write the hardening verifier test first**

The verifier maps all 14 slugs to at least one executable regression file and one
legitimate-control assertion. It fails for a missing slug, skipped test or a test
that only checks source text when a runtime boundary is available.

- [ ] **Step 2: Expand Playwright spec before changing fixtures**

Add headless cases for no-view, view-only, execute, `OFF`, `READ_ONLY`, live
telemetry, stable intent across close/reopen, duplicate conflict, job stages,
`UNCERTAIN`, settings version conflict, Realtime invalidation, large Aruba
pagination, mobile route, failed RPC, console errors and unexpected failed
requests. All writes remain DEMO org and cleanup in `finally`.
The worker/database fixture also exercises 50,000 legitimate Aruba identities in
keyset pages and proves browser memory/page cost does not scale with total count.

- [ ] **Step 3: Add CI workflow with no production credentials or auto-apply**

CI installs root and worker lockfiles, Deno, then runs focused app tests, worker
tests/typecheck/build, Edge tests, queue/retention/hardening verifiers,
typecheck-baseline, build and Docker build. Disposable local Supabase job applies
migrations and cross-tenant tests with concurrency 2 and guaranteed teardown.
The workflow contains no production PAT/service-role secret and no `supabase db
push` against a linked project.

- [ ] **Step 4: Run the full local verification matrix**

```powershell
.\node_modules\.bin\vitest.cmd run networkCenter --pool=forks --maxWorkers=1 --no-file-parallelism
npm run typecheck:baseline
npm run build
npx --yes deno test --config supabase/functions/network-center-worker/deno.json supabase/functions/network-center-worker/index.test.ts --allow-env
npm --prefix infra/network-center-worker test
npm --prefix infra/network-center-worker run typecheck
npm --prefix infra/network-center-worker run build
node scripts/check-definer-acl.mjs
node scripts/check-view-invoker.mjs
node scripts/verify-network-center-retention.mjs
node scripts/verify-network-center-queue.mjs
node scripts/verify-network-center-hardening.mjs
node scripts/verify-network-center-worker-scope.mjs
node scripts/verify-network-center-managed-resources.mjs
node scripts/test-cross-tenant.mjs --local-disposable
git diff --check
```

- [ ] **Step 5: Run local headless Playwright with fleet credentials loaded without logging**

```powershell
Set-Location .e2e-fleet
$env:FLEET_WORKERS='8'
npx playwright test specs/network-center.spec.ts
Set-Location ..
```

- [ ] **Step 6: Dispatch independent spec then quality/security review**

Reviewer must inspect the complete diff against the design, replay every scan
PoC/verifier and order findings by severity. Implementer fixes all Critical/High
and Important/Medium findings; reviewer re-runs until approved.

- [ ] **Step 7: Commit Task 15**

```powershell
git add -- .github/workflows/network-center-validation.yml .e2e-fleet/specs/network-center.spec.ts scripts/verify-network-center-hardening.mjs scripts/verify-network-center-worker-scope.mjs scripts/verify-network-center-managed-resources.mjs scripts/__tests__/network-center-hardening-verifiers.test.mjs
git commit -m "test(network-center): khóa regression bảo mật và production E2E" -m "Co-Authored-By: Codex <noreply@openai.com>"
```

### Task 16: Deploy Inert Infrastructure, Demo Router, Canary And Production

**Files:**

- Derived ignored receipts: `.network-center-rollout/**`
- Derived ignored router artifacts: caller-selected secure directory outside repo
- Modify only source required by observed rollout defects

- [ ] **Step 1: Freeze and verify release candidate**

Fetch/rebase `origin/main`, resolve only scoped conflicts, rerun Task 15 full
matrix, confirm worktree clean, record `$releaseSha = git rev-parse HEAD`, and
regenerate manifest hashes if the rebase changed migrations. Do not deploy a
different SHA from the reviewed candidate.

Any source, migration, test or deployment-asset change observed after this step
invalidates the candidate: commit the fix, return to Step 1, regenerate hashes and
repeat all affected gates before any further external rollout.

- [ ] **Step 2: Audit and apply database rollout**

```powershell
node scripts/validate-network-center-rollout.mjs --revision $releaseSha
node scripts/audit-network-center-rollout.mjs --preflight --revision $releaseSha
node scripts/apply-network-center-rollout.mjs --revision $releaseSha
node scripts/audit-network-center-rollout.mjs --post-apply --revision $releaseSha
node scripts/check-definer-acl.mjs
node scripts/check-view-invoker.mjs
npm run gen:types
git diff --exit-code -- src/integrations/supabase/types.ts
```

Read back migrations, catalog fingerprint, functions, grants, policies,
publication and default building rollout `OFF` before proceeding.

- [ ] **Step 3: Deploy Edge and prove the old trust path is dead**

```powershell
node scripts/deploy-edge-fn.mjs network-center-worker --no-verify-jwt --revision $releaseSha
```

Verify missing, wrong, expired, revoked and former fleet bearer all fail; spoofed
body `workerId` fails; no secret is logged.

- [ ] **Step 4: Provision worker, assignments and connection metadata**

Use `network-center-admin.mjs` to provision `vultr-network-center-01`, write its
secret to the root-owned Vultr file, assign the enabled building snapshot, then
provision the demo router connection with opaque credential ref and pinned host
key. Readback must show no plaintext credential and no wildcard assignment.

- [ ] **Step 5: Deploy Vultr read-only and observe seven cycles**

Run `deploy-vultr.ps1` for `$releaseSha` with emergency stop. Verify systemd,
WireGuard, immutable image digest, container resource bounds, heartbeat,
assignment-scoped connections and seven consecutive current telemetry polls.
Test restart/reconnect and previous-image rollback rehearsal before enabling any
command. If a compatibility bearer exists, keep all v1 paths assignment-enforced,
observe a clean 24-hour soak, invoke the finalize-cutover admin action, then prove
the former bearer and v1 worker functions are denied.

- [ ] **Step 6: Bootstrap and verify only the dedicated demo MikroTik**

Capture pre-state and exact rollback, generate bootstrap into secure ignored
output, dry-run/import with LAN recovery preserved, verify WireGuard handshake,
pinned SSH, immutable interfaces, Aruba display-only inventory, redacted snapshot,
backup reserve and zero browser-readable secrets.

- [ ] **Step 7: Exercise the four allowlisted demo actions**

Run DNS flush; DHCP renew only when applicable; cycle one verified access port;
reboot last. For each, verify stable intent, pre-backup/readback hash, stages,
typed postcondition, terminal audit and no duplicate. Inject one ambiguous fixture
to prove `UNCERTAIN`, not false success.

- [ ] **Step 8: Canary DEMO then one real building**

Set DEMO to `READ_ONLY`, then `EXECUTE`; run browser/worker smoke. Set one real
building to `READ_ONLY` and observe 24 hours without synthetic data. Enable
`EXECUTE` only after backup/postcondition gates, then expand explicitly
`1 → 5 → 15` while every remaining building stays `OFF` until its gate passes.

- [ ] **Step 9: Push reviewed release and verify Vercel production**

```powershell
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git status --porcelain
```

Expected: ancestor check exits 0 and status is empty. If `origin/main` advanced,
return to Step 1; do not rebase after external artifacts were tied to
`$releaseSha` and then continue with a different revision.

Before triggering the build, set and read back the Vercel production environment:

```powershell
'production' | npx --yes vercel env add VITE_NETWORK_CENTER_MODE production --force
npx --yes vercel env ls
git push origin HEAD:main
```

Wait until `https://ptcrm.vercel.app` serves `$releaseSha`, then run:

```powershell
Set-Location .e2e-fleet
$env:FLEET_BASE_URL='https://ptcrm.vercel.app'
$env:FLEET_WORKERS='8'
npx playwright test specs/network-center.spec.ts
Set-Location ..
```

- [ ] **Step 10: Complete production readback and only then close the goal**

Evidence must prove all design completion items: exact revisions/digests,
migration receipts/catalog, 14 exploit regressions, assignment isolation, scoped
heartbeat, fresh worker/router telemetry, disk reserve, demo actions, canary
states, headless browser with zero unexpected errors, and no auth/finance/route
regression. Record any skipped live check as not complete; do not substitute
static evidence.

---

## Plan self-review checklist

- [ ] Every one of the 14 canonical finding slugs maps to a task and executable
  regression.
- [ ] Worker identity is server-derived and every privileged route checks final
  building assignment.
- [ ] Aruba has no total quota; only stable identity, churn, pagination and age
  controls exist.
- [ ] Direct `network_center.execute` remains approval-free while queue admission
  and rollout state remain server-enforced.
- [ ] No migration-backed test can emit DDL toward production.
- [ ] Every migration/Edge/worker/Vercel change has readback and rollback/forward-
  fix evidence.
- [ ] No plaintext worker/router/VPN/service secret enters source, logs, receipts
  or browser-readable rows.
- [ ] Final completion requires live production evidence, not only green unit
  tests.
