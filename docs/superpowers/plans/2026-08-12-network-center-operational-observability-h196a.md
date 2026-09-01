# Network Center Operational Observability And H196A Downstream Implementation Plan

> **[CÒN SỐNG — trạng thái 02/09/2026]** 0/78 checkbox tick, và đã đối chiếu với đĩa:
> **(a) Phần H196A downstream: ĐÃ SHIP ĐƯỜNG KHÁC** qua `supabase/migrations/20260829010000_network_center_h196a_downstream.sql` (kind `ZTE_H196A`, profiles/quarantine, inventory v1, list RPC — thiết kế lại theo hướng INDIRECT_ONLY + chỉ-để-nhìn, KHÔNG theo 6 migration `20260812010000..015000` plan này đặt tên; 6 file đó không tồn tại).
> **(b) Phần observability (coverage/health/IP/incident/notification/analytics): CHƯA SHIP** — không migration `network_*` nào sau 12/08 chạm tới, kiểm 02/09.
> Muốn làm tiếp phần (b) phải re-anchor lên schema hiện tại. Tài liệu hiện hành: `docs/he-thong/22-network-center.md` (§3b mô tả cái đã ship thật).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Biến Network Center thành hệ thống giám sát MikroTik trung thực theo coverage/health/IP/incident/notification, có analytics vận hành và mô hình hóa router con ZTE ZXHN H196A bằng evidence gián tiếp từ MikroTik.

**Architecture:** Supabase là control plane và nơi lưu evidence durable; Node worker SSH trực tiếp tới MikroTik gateway qua WireGuard và thu H196A downstream từ DHCP/neighbor/uplink evidence đã đọc sẵn. H196A không dùng RouterOS connector và luôn là runtime `INDIRECT_ONLY`; capture được operator cấp phép chỉ đi qua validator offline, không tạo direct state. Thứ tự triển khai là coverage truth -> DEMO canary -> IP/health -> incident/notification -> analytics -> H196A inventory/discovery, không bật production `EXECUTE` trong scope này.

**Tech Stack:** PostgreSQL 17.6/Supabase migrations and SECURITY DEFINER RPCs, Node.js `>=20 <23` (CI Node `22.23.2`) cho `infra/network-center-worker`, Deno `2.9.4` cho Edge functions, React 18/Vite/TypeScript/Zod/React Query, Vitest/Node test/Playwright.

## Global Constraints

- Org THẬT `aaaa0000-0000-4000-8000-000000000001` chỉ đọc ngoài rollout canary đã ghi rõ; mọi fault injection hoặc seed chỉ ở DEMO/TEST và phải tự dọn.
- Không sửa migration lịch sử; thay đổi này thêm sáu migration forward-only: `20260812010000_network_center_coverage_truth.sql`, `20260812011000_network_center_ip_health_observability.sql`, `20260812012000_network_center_incident_rules.sql`, `20260812013000_network_center_notification_delivery.sql`, `20260812014000_network_center_analytics_rpcs.sql`, `20260812015000_network_center_h196a_downstream.sql`. Rollout manifest vẫn chứa mọi migration Network Center lịch sử trên đĩa, cộng sáu file mới này, theo thứ tự tăng dần.
- Mọi bảng public mới có `organization_id` phải bật RLS và có restrictive policy tên theo mẫu `` `${tableName}_hide_sandbox_admin` `` dựa trên `20260801040000_fix_sandbox_hide_null_org.sql`.
- Mọi SECURITY DEFINER browser read phải lọc bằng `public.can_access_building()` / `public.accessible_building_ids()` hoặc helper Network Center đã kiểm chứng tương đương; không tự viết nhánh super-admin.
- Không mở rộng RouterOS permission. Public IP chỉ đọc `public-address` từ `/ip/cloud/print detail without-paging`; không ping, không `force-update`, không `/tool/fetch` và không gọi endpoint ngoài từ router.
- Persist health `UNKNOWN`; UI hiển thị `NO_DATA`. Không biến metric/SLA thiếu thành `0`, và `UNKNOWN` không tính uptime.
- H196A chỉ sâu một tầng và cùng organization/building với MikroTik gateway; không dùng MikroTik làm jump host và không chạy RouterOS command/bootstrap trên H196A.
- H196A luôn `INDIRECT_ONLY`, `write_capability=false`, không có connection/credential/assignment/action. Artifact capability không đổi runtime/UI; connector riêng chỉ thuộc một design/plan sau khóa exact protocol/firmware/credential lifecycle. Scope này không promote production `EXECUTE`.
- `notifications.status` chỉ là unread/read (`PENDING`/`READ`); push dùng `push_state`; Network Center delivery dùng `network_outbox_deliveries`.
- Database rollout phải có provenance, file SHA-256, ordered manifest, backup receipt, forward apply, catalog readback và disposable PostgreSQL proof theo `PROJECT_CONTRACT.md`.
- Stage/commit chỉ các file của từng task; không dùng `git add -A` hoặc `git add .`; mọi commit Codex có trailer `Co-Authored-By: Codex <noreply@openai.com>`.

## File And Interface Map

| Unit | Responsibility |
| --- | --- |
| `20260812010000_network_center_coverage_truth.sql` | Coverage projection/reasons, fleet/building v2 RPCs, watchdog coverage thresholds |
| `20260812011000_network_center_ip_health_observability.sql` | IP evidence current/history, health evidence payload, nullable SLA/coverage |
| `20260812012000_network_center_incident_rules.sql` | Durable rule state, 3-fail/2-success hysteresis, dependency suppression |
| `20260812013000_network_center_notification_delivery.sql` | Subscriptions, outbox fanout/delivery claim, notification insertion |
| `20260812014000_network_center_analytics_rpcs.sql` | Fleet/building/device analytic read models and keyset event log |
| `20260812015000_network_center_h196a_downstream.sql` | MikroTik-root/H196A-downstream invariant, discovery evidence, v3 device-aware browser RPCs |
| `infra/network-center-worker/src/routeros/healthObservation.ts` | Pure RouterOS record -> IP/DNS/WAN/resource evidence parser |
| `infra/network-center-worker/src/healthRules.ts` | Pure health/rule evaluation and evidence freshness |
| `infra/network-center-worker/src/polling.ts` | One observation per connection, telemetry/evidence upload; no in-memory incident authority |
| `supabase/functions/network-center-worker/index.ts` | Validate health/IP payloads and route to versioned worker RPCs |
| `supabase/functions/network-watchdog/index.ts` | Liveness, maintenance, fanout route and health verdicts |
| `src/lib/network-center/{contracts,dto}.ts` | Nullable coverage/health/IP/router-tree browser contract |
| `src/components/network-center/**` | Coverage/NO_DATA UI, analytics, H196A selector/topology/source badges |
| `scripts/network-center-admin.mjs` | DEMO/TEST canary, H196A registration and capability-discovery readback |
| `scripts/deploy-edge-fn.mjs` | Explicit two-function deployment allowlist, digest and verify-JWT contract |

---

### Task 1: Add Coverage Truth And Repair The Live E2E Fixture

**Files:**
- Create: `supabase/migrations/20260812010000_network_center_coverage_truth.sql`
- Create: `src/lib/__tests__/networkCenterCoverageTruthMigration.test.ts`
- Create: `scripts/test-network-center-coverage-disposable.mjs`
- Create: `scripts/__tests__/network-center-coverage-runtime.test.mjs`
- Modify: `src/lib/network-center/contracts.ts`
- Modify: `src/lib/network-center/dto.ts`
- Modify: `src/lib/network-center/model.ts`
- Modify: `src/components/network-center/NetworkStatus.tsx`
- Modify: `src/components/network-center/NetworkMetricStrip.tsx`
- Modify: `src/components/network-center/FleetTable.tsx`
- Modify: `src/components/network-center/BuildingWorkspace.tsx`
- Modify: `src/lib/__tests__/networkCenterModel.test.ts`
- Modify: `src/lib/__tests__/networkCenterEmptyStates.test.tsx`
- Modify: `.e2e-fleet/specs/network-center-request-budget.spec.ts`
- Modify: `supabase/functions/network-watchdog/index.ts`
- Modify: `supabase/functions/network-watchdog/index.test.ts`

**Interfaces:**
- Produces SQL function `app_private.network_center_building_coverage_v1(p_building_id uuid, p_now timestamptz DEFAULT clock_timestamp()) RETURNS jsonb`.
- Produces browser RPCs `network_center_list_fleet_v2()` and `network_center_get_building_v2(p_building_id uuid)`.
- Produces TypeScript `NetworkCoverageState = "DISABLED" | "NOT_ROLLED_OUT" | "COVERAGE_MISSING" | "MONITORED"` and `NetworkCoverageReason` stable string union.
- Extends watchdog evaluation with `NETWORK_WATCHDOG_MIN_BUILDINGS`; once it is a positive integer, `monitoredBuildings` below that expectation returns `503/FLEET_UNDER_PROVISIONED` even when all stale counters are zero.
- Keeps v1 RPCs intact for rollback; frontend switches atomically to v2 after DTO tests pass.

- [ ] **Step 1: Write static migration tests for all four coverage states**

```ts
expect(sql).toMatch(/network_center_building_coverage_v1/i);
expect(sql).toContain("'DISABLED'");
expect(sql).toContain("'NOT_ROLLED_OUT'");
expect(sql).toContain("'COVERAGE_MISSING'");
expect(sql).toContain("'MONITORED'");
expect(sql).toMatch(/network_center_list_fleet_v2/i);
expect(sql).toMatch(/network_center_get_building_v2/i);
expect(sql).toMatch(/can_access_building|accessible_building_ids/i);
```

In `supabase/functions/network-watchdog/index.test.ts`, add the false-green case:

```ts
const configured = await createHarness({
  env: { NETWORK_WATCHDOG_MIN_WORKERS: "1", NETWORK_WATCHDOG_MIN_BUILDINGS: "1" },
  rpcResult: {
    data: { ...HEALTHY, monitoredWorkers: 1, monitoredBuildings: 0 },
    error: null,
  },
});
const response = await configured.handler(post("/liveness"));
assertEquals(response.status, 503);
assertEquals((await body(response)).reason, "FLEET_UNDER_PROVISIONED");
```

- [ ] **Step 2: Write disposable DB cases for exact reason precedence**

In `scripts/test-network-center-coverage-disposable.mjs`, seed DEMO-only buildings and assert this ordered decision table:

```js
[
  { settings: false, expected: ["COVERAGE_MISSING", "NO_SITE_SETTINGS"] },
  { monitoring: false, rollout: "READ_ONLY", expected: ["DISABLED", "MONITORING_DISABLED"] },
  { monitoring: true, rollout: "OFF", expected: ["NOT_ROLLED_OUT", "ROLLOUT_OFF"] },
  { monitoring: true, rollout: "READ_ONLY", gateway: false, expected: ["COVERAGE_MISSING", "NO_GATEWAY"] },
  { gateway: true, connection: false, expected: ["COVERAGE_MISSING", "NO_CONNECTION"] },
  { connection: true, assignment: false, expected: ["COVERAGE_MISSING", "NO_ASSIGNMENT"] },
  { assignment: true, heartbeat: false, expected: ["COVERAGE_MISSING", "WORKER_STALE"] },
  { heartbeat: true, pollEvidence: false, expected: ["COVERAGE_MISSING", "POLL_NEVER_OBSERVED"] },
  { pollEvidence: true, expected: ["MONITORED", null] },
]
```

- [ ] **Step 3: Run RED coverage tests**

Run:

```powershell
npx vitest run src/lib/__tests__/networkCenterCoverageTruthMigration.test.ts src/lib/__tests__/networkCenterModel.test.ts src/lib/__tests__/networkCenterEmptyStates.test.tsx
node --test scripts/__tests__/network-center-coverage-runtime.test.mjs
```

Expected: FAIL because migration, v2 DTO fields and `no-data` status do not exist.

- [ ] **Step 4: Implement the coverage migration**

`network_center_building_coverage_v1` must return:

```json
{
  "state": "COVERAGE_MISSING",
  "reason": "NO_CONNECTION",
  "gatewayDeviceId": "uuid-or-null",
  "connectionId": "uuid-or-null",
  "workerId": "uuid-or-null",
  "lastHeartbeatAt": "timestamp-or-null",
  "lastPollObservedAt": "timestamp-or-null"
}
```

Treat a missing settings row as `COVERAGE_MISSING/NO_SITE_SETTINGS`; do not `coalesce` it to `OFF`. Otherwise use `settings.rollout_state`, `settings.monitoring_enabled`, one active root MikroTik, enabled connection, active `can_poll` assignment, matching worker heartbeat and poll evidence. Add indexes only where `EXPLAIN` for the disposable fixture shows sequential scans over worker assignment/heartbeat lookup.

- [ ] **Step 5: Add nullable frontend coverage/health types**

Update contracts so fleet counts include `disabled`, `notRolledOut`, `coverageMissing`, `monitored`, and health becomes:

```ts
export type NetworkHealth = "healthy" | "degraded" | "critical" | "offline" | "no-data";
export interface NetworkCoverage {
  state: NetworkCoverageState;
  reason: NetworkCoverageReason | null;
}
```

`mapHealth()` returns `no-data` unless coverage is `MONITORED`. Do not infer offline from lifecycle `UNPROVISIONED`.

- [ ] **Step 6: Render coverage separately from health**

Add labels:

```ts
"no-data": { label: "Chưa có dữ liệu", tone: "neutral" }
"COVERAGE_MISSING": "Thiếu cấu hình giám sát"
"NOT_ROLLED_OUT": "Chưa rollout"
"DISABLED": "Đã tắt giám sát"
```

Fleet health metrics count only `MONITORED`; coverage metrics show the other three states. WAN/CPU/RAM fields display `—` when null.

Update watchdog config parsing to accept non-negative integer minima for both workers and buildings. Before any rollout, both defaults remain `0`; Task 2 sets DEMO expectations to `1/1`, and each later wave raises the building minimum only after the corresponding assignments are verified. A positive minimum that is not met must never return HTTP 200.

- [ ] **Step 7: Replace the stale DEMO building constant with runtime discovery**

In `.e2e-fleet/specs/network-center-request-budget.spec.ts`, after DEMO login call `network_center_list_fleet_v2` through the page session and choose the first item with `coverage.state === "MONITORED"`. If none exists, fail with `DEMO_CONTROL_PLANE_CANARY_MISSING`; never hard-code a building UUID again.

- [ ] **Step 8: Run GREEN focused verification**

Run:

```powershell
npx vitest run src/lib/__tests__/networkCenterCoverageTruthMigration.test.ts src/lib/__tests__/networkCenterModel.test.ts src/lib/__tests__/networkCenterEmptyStates.test.tsx src/lib/__tests__/networkCenterSupabaseRepository.test.ts
node --test scripts/__tests__/network-center-coverage-runtime.test.mjs
node scripts/test-network-center-coverage-disposable.mjs --local
npx --yes deno@2.9.4 test --config supabase/functions/network-watchdog/deno.json supabase/functions/network-watchdog/index.test.ts --allow-env
npm run typecheck:baseline
```

Expected: PASS; disposable output reports all nine coverage cases and zero cross-org rows.

- [ ] **Step 9: Commit Task 1**

```powershell
git add -- supabase/migrations/20260812010000_network_center_coverage_truth.sql src/lib/__tests__/networkCenterCoverageTruthMigration.test.ts scripts/test-network-center-coverage-disposable.mjs scripts/__tests__/network-center-coverage-runtime.test.mjs src/lib/network-center/contracts.ts src/lib/network-center/dto.ts src/lib/network-center/model.ts src/components/network-center/NetworkStatus.tsx src/components/network-center/NetworkMetricStrip.tsx src/components/network-center/FleetTable.tsx src/components/network-center/BuildingWorkspace.tsx src/lib/__tests__/networkCenterModel.test.ts src/lib/__tests__/networkCenterEmptyStates.test.tsx .e2e-fleet/specs/network-center-request-budget.spec.ts supabase/functions/network-watchdog/index.ts supabase/functions/network-watchdog/index.test.ts
git commit -m "fix(network-center): phân biệt coverage với router offline" -m "- thêm coverage projection và RPC v2\n- hiển thị no-data thay cho số liệu giả\n- bỏ fixture DEMO hard-code\n\nCo-Authored-By: Codex <noreply@openai.com>"
```

### Task 2: Build A Real DEMO Control-Plane Canary

**Files:**
- Create: `scripts/network-center-demo-canary.mjs`
- Create: `scripts/__tests__/network-center-demo-canary.test.mjs`
- Modify: `scripts/network-center-admin.mjs`
- Modify: `scripts/__tests__/network-center-admin-control-plane.test.mjs`
- Modify: `infra/network-center-worker/docs/DEMO-ROUTER-RUNBOOK.md`
- Modify: `.e2e-fleet/specs/network-center-request-budget.spec.ts`

**Interfaces:**
- Produces CLI `node scripts/network-center-demo-canary.mjs plan|apply|verify|cleanup`.
- Consumes existing admin RPCs for worker, connection, assignment and rollout; no direct table writes.
- Produces machine-readable verify payload with `coverageState`, `successfulPolls`, `failedPolls`, `telemetryRows`, `workerVersion` and `buildingId`; `successfulPolls` is the count of consecutive clean poll cycles in the canary observation window.
- This CLI does not synthesize health observations. The 3-fail/2-success contract is proven by Task 4's disposable PostgreSQL evaluator and, during Task 9, by controlled DEMO/TEST router reachability; no browser/admin RPC may forge worker evidence.

- [ ] **Step 1: Write fail-closed CLI tests**

Test that `apply` rejects real-org IDs, missing explicit `--confirm-demo`, existing output secret paths, `canExecute=true`, rollout other than `READ_ONLY`, missing pinned host key and any cleanup target not carrying a canary marker.

- [ ] **Step 2: Run RED canary tests**

Run:

```powershell
node --test scripts/__tests__/network-center-demo-canary.test.mjs scripts/__tests__/network-center-admin-control-plane.test.mjs
```

Expected: FAIL because the canary CLI and verification contract do not exist.

- [ ] **Step 3: Implement `plan` and `verify` before `apply`**

`plan` prints the exact DEMO organization/building/device/connection/worker mutations without sending requests. `verify` is read-only and fails unless:

```js
coverageState === "MONITORED"
&& connectionCount === 1
&& successfulPolls >= 7
&& failedPolls === 0
&& telemetryRows > 0
&& rolloutState === "READ_ONLY"
&& canExecute === false
```

- [ ] **Step 4: Implement reversible DEMO apply/cleanup through admin RPCs**

`apply` creates or reconciles one marked DEMO gateway, per-device connection, worker assignment `{canPoll:true, canInventory:true, canExecute:false}`, settings and rollout `READ_ONLY`. `cleanup` first disables assignment/connection and sets rollout `OFF`; it deletes only rows whose external key/comment equals the canary marker and only when the user passes the exact runtime value `` `--confirm-cleanup ${buildingId}` ``. Neither path accepts an observation/health payload or invokes worker ingest/evaluation RPCs.

- [ ] **Step 5: Update the runbook and E2E prerequisite**

Document the exact release-time `plan -> apply -> seven poll cycles -> verify -> E2E` sequence. Make it explicit that Task 2 implements and tests the CLI only: live `apply`, live `verify`, fault injection and E2E are blocked until Task 9 has applied all six migrations, generated project-backed types, deployed both Edge functions and deployed the worker candidate. The E2E must report `DEMO_CONTROL_PLANE_CANARY_MISSING` with the verify command when the canary is absent.

- [ ] **Step 6: Run GREEN CLI tests and plan-only proof**

Run:

```powershell
node --test scripts/__tests__/network-center-demo-canary.test.mjs scripts/__tests__/network-center-admin-control-plane.test.mjs
node scripts/network-center-demo-canary.mjs plan --confirm-demo
```

Expected: tests PASS; plan prints only DEMO IDs and `canExecute:false`; no network write occurs.

- [ ] **Step 7: Commit Task 2 without contacting a shared environment**

```powershell
git add -- scripts/network-center-demo-canary.mjs scripts/__tests__/network-center-demo-canary.test.mjs scripts/network-center-admin.mjs scripts/__tests__/network-center-admin-control-plane.test.mjs infra/network-center-worker/docs/DEMO-ROUTER-RUNBOOK.md .e2e-fleet/specs/network-center-request-budget.spec.ts
git commit -m "feat(network-center): thêm canary control plane DEMO" -m "- provision gateway DEMO chỉ đọc qua admin RPC\n- verify poll và telemetry thật\n- thêm cleanup có marker\n\nCo-Authored-By: Codex <noreply@openai.com>"
```

### Task 3: Capture IP Evidence And Derive Truthful Health

**Files:**
- Create: `supabase/migrations/20260812011000_network_center_ip_health_observability.sql`
- Create: `src/lib/__tests__/networkCenterIpHealthMigration.test.ts`
- Create: `scripts/test-network-center-ip-health-disposable.mjs`
- Create: `scripts/__tests__/network-center-ip-health-runtime.test.mjs`
- Create: `infra/network-center-worker/src/routeros/healthObservation.ts`
- Create: `infra/network-center-worker/src/healthRules.ts`
- Create: `infra/network-center-worker/test/healthObservation.test.ts`
- Create: `infra/network-center-worker/test/healthRules.test.ts`
- Modify: `infra/network-center-worker/src/domain.ts`
- Modify: `infra/network-center-worker/src/routeros/connector.ts`
- Modify: `infra/network-center-worker/src/routeros/sshConnector.ts`
- Modify: `infra/network-center-worker/src/polling.ts`
- Modify: `infra/network-center-worker/test/sshConnector.test.ts`
- Modify: `infra/network-center-worker/test/polling.test.ts`
- Modify: `supabase/functions/network-center-worker/index.ts`
- Modify: `supabase/functions/network-center-worker/index.test.ts`
- Modify: `src/lib/network-center/contracts.ts`
- Modify: `src/lib/network-center/dto.ts`
- Modify: `src/components/network-center/FleetTable.tsx`
- Modify: `src/components/network-center/tabs/OverviewTab.tsx`
- Modify: `src/components/network-center/tabs/IncidentsTab.tsx`
- Modify: `src/lib/__tests__/networkCenterSupabaseRepository.test.ts`
- Modify: `src/lib/__tests__/networkCenterModel.test.ts`

**Interfaces:**
- Produces tables `network_device_ip_current`, `network_device_ip_history`, new per-device rollup `network_device_sla_daily`, and extended building-level `network_sla_daily` fields `unknown_seconds`, `coverage_seconds`, `coverage_pct`.
- Produces worker RPC `network_center_worker_ingest_v3(p_credential_digest text, p_payload jsonb)`.
- Produces `RouterHealthObservation` with management/WAN/public/DNS/default-route/resource evidence.
- Produces `deriveObservedHealth(input, now): { observedHealthStatus; wanStatus; reasons; evidenceExpiresAt }`; Task 4 turns raw observations into effective persisted health through durable hysteresis.

- [ ] **Step 1: Write parser tests from exact RouterOS output shapes**

Cover:

```ts
parseHealthObservation({
  addresses: "... address=10.77.1.2/32 interface=wg-ihome-mgmt ...",
  routes: "... dst-address=0.0.0.0/0 active=yes gateway=pppoe-out1 ...",
  dns: "servers=1.1.1.1,8.8.8.8 allow-remote-requests=no",
  cloud: "ddns-enabled=yes public-address=203.0.113.7",
  resources: "cpu-load=12 free-memory=... total-memory=... temperature=54C",
});
```

Also assert empty/disabled IP Cloud yields `PUBLIC_EGRESS` absent, never an exception and never a fabricated address.

- [ ] **Step 2: Write health truth-table tests**

```ts
expect(deriveObservedHealth({ managementReachable: false }).observedHealthStatus).toBe("OFFLINE");
expect(deriveObservedHealth({ managementReachable: true, defaultRouteUp: false }).observedHealthStatus).toBe("CRITICAL");
expect(deriveObservedHealth({ fresh: false }).observedHealthStatus).toBe("DEGRADED");
expect(deriveObservedHealth({ dnsConfigured: false }).observedHealthStatus).toBe("DEGRADED");
expect(deriveObservedHealth({ requiredEvidenceComplete: false }).observedHealthStatus).toBe("UNKNOWN");
expect(deriveObservedHealth({ allRequiredFresh: true }).observedHealthStatus).toBe("HEALTHY");
```

These are single-poll observations, not the effective UI state. Before Task 4, an unreachable observation is stored as evidence while effective health remains `UNKNOWN`; after Task 4, the durable evaluator exposes `OFFLINE` only on the third consecutive failure and recovers after two successes.

- [ ] **Step 3: Write SQL tests for current/history and nullable SLA**

Assert unique `(device_id, evidence_kind)` current rows, append-only history, address type `inet`, bounded source/confidence, sandbox-hide policy, unchanged building-level primary key, per-device key `(organization_id, building_id, device_id, sla_day)`, and nullable `uptime_pct` when `coverage_seconds=0` in both rollups.

- [ ] **Step 4: Run RED worker/Edge/SQL tests**

Run:

```powershell
npm --prefix infra/network-center-worker test -- healthObservation.test.ts healthRules.test.ts sshConnector.test.ts polling.test.ts
npx --yes deno@2.9.4 test --config supabase/functions/network-center-worker/deno.json supabase/functions/network-center-worker/index.test.ts --allow-env
npx vitest run src/lib/__tests__/networkCenterIpHealthMigration.test.ts
node --test scripts/__tests__/network-center-ip-health-runtime.test.mjs
```

Expected: FAIL on missing parser, ingest v3 and schema.

- [ ] **Step 5: Implement read-only RouterOS evidence collection**

In `sshConnector.poll()`, add bounded reads for:

```text
/ip/address/print detail terse without-paging
/ip/route/print detail terse without-paging where dst-address=0.0.0.0/0
/ip/dns/print detail without-paging
/ip/cloud/print detail without-paging
```

Reuse already-read interface/resource records. Do not call `healthCheck()` separately if that repeats SSH reads; instead construct health evidence from the same poll snapshot. Remove hard-coded `HEALTHY`.

- [ ] **Step 6: Implement migration and ingest v3**

Payload shape:

```json
{
  "observedAt": "RFC3339",
  "devices": [{
    "deviceId": "uuid",
    "reachable": true,
    "observedHealthStatus": "DEGRADED",
    "wanStatus": "UP",
    "healthReasons": ["PUBLIC_IP_MISSING"],
    "evidenceExpiresAt": "RFC3339"
  }],
  "ipEvidence": [{
    "deviceId": "uuid",
    "kind": "WAN",
    "address": "100.64.1.2",
    "source": "ROUTEROS_IP_ADDRESS",
    "confidence": "OBSERVED",
    "interfaceKey": "pppoe-out1",
    "observedAt": "RFC3339",
    "expiresAt": "RFC3339"
  }]
}
```

The Edge route validates max 16 evidence rows per device, exact enums, valid `inet`, timestamps and bounded details before RPC. Ingest v3 stores raw observation/evidence; it does not independently open incidents or publish `OFFLINE` before Task 4 applies hysteresis.

- [ ] **Step 7: Update UI DTOs to preserve null/unknown**

Change `RouterSummary` fields to nullable values and WAN `"up" | "down" | "unknown"`. Add current IP evidence list with source/confidence/observedAt. Render `—` for absent CPU/RAM/throughput/SLA; `IncidentsTab` shows `Chưa đủ coverage` when `uptimePercent === null`.

- [ ] **Step 8: Run GREEN focused verification**

Run:

```powershell
npm --prefix infra/network-center-worker test -- healthObservation.test.ts healthRules.test.ts sshConnector.test.ts polling.test.ts
npm --prefix infra/network-center-worker run typecheck
npx --yes deno@2.9.4 test --config supabase/functions/network-center-worker/deno.json supabase/functions/network-center-worker/index.test.ts --allow-env
npx vitest run src/lib/__tests__/networkCenterIpHealthMigration.test.ts src/lib/__tests__/networkCenterModel.test.ts src/lib/__tests__/networkCenterSupabaseRepository.test.ts
node --test scripts/__tests__/network-center-ip-health-runtime.test.mjs
node scripts/test-network-center-ip-health-disposable.mjs --local
```

Expected: PASS; no test observes hard-coded `HEALTHY`; no missing metric becomes zero.

- [ ] **Step 9: Commit Task 3**

```powershell
git add -- supabase/migrations/20260812011000_network_center_ip_health_observability.sql src/lib/__tests__/networkCenterIpHealthMigration.test.ts scripts/test-network-center-ip-health-disposable.mjs scripts/__tests__/network-center-ip-health-runtime.test.mjs infra/network-center-worker/src/routeros/healthObservation.ts infra/network-center-worker/src/healthRules.ts infra/network-center-worker/test/healthObservation.test.ts infra/network-center-worker/test/healthRules.test.ts infra/network-center-worker/src/domain.ts infra/network-center-worker/src/routeros/connector.ts infra/network-center-worker/src/routeros/sshConnector.ts infra/network-center-worker/src/polling.ts infra/network-center-worker/test/sshConnector.test.ts infra/network-center-worker/test/polling.test.ts supabase/functions/network-center-worker/index.ts supabase/functions/network-center-worker/index.test.ts src/lib/network-center/contracts.ts src/lib/network-center/dto.ts src/components/network-center/FleetTable.tsx src/components/network-center/tabs/OverviewTab.tsx src/components/network-center/tabs/IncidentsTab.tsx
git commit -m "feat(network-center): lưu IP evidence và health trung thực" -m "- đọc management WAN public-address không mở quyền RouterOS\n- bỏ health HEALTHY cứng\n- giữ metric và SLA thiếu ở dạng null\n\nCo-Authored-By: Codex <noreply@openai.com>"
```

### Task 4: Make Incident Hysteresis And Dependency State Durable

**Files:**
- Create: `supabase/migrations/20260812012000_network_center_incident_rules.sql`
- Create: `src/lib/__tests__/networkCenterIncidentRulesMigration.test.ts`
- Create: `scripts/test-network-center-incidents-disposable.mjs`
- Create: `scripts/__tests__/network-center-incident-rules-runtime.test.mjs`
- Modify: `infra/network-center-worker/src/polling.ts`
- Modify: `infra/network-center-worker/src/domain.ts`
- Modify: `infra/network-center-worker/src/apiClient.ts`
- Modify: `infra/network-center-worker/test/polling.test.ts`
- Modify: `supabase/functions/network-center-worker/index.ts`
- Modify: `supabase/functions/network-center-worker/index.test.ts`

**Interfaces:**
- Produces table `network_incident_rule_state` and RPC `network_center_worker_evaluate_health_v1(p_credential_digest text, p_payload jsonb)`.
- Consumes Task 3 `observedHealthStatus`, `wanStatus`, reasons, freshness and IP evidence; produces the effective persisted `network_device_current.health_status` after durable transitions.
- Worker stops calling `upsertIncident()` as incident authority; it submits evidence/rule observations.
- Produces exact worker types:

```ts
export interface EvaluateHealthPayload {
  schemaVersion: 1;
  deviceId: string;
  observedAt: string;
  observedHealthStatus: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "CRITICAL" | "OFFLINE";
  wanStatus: "UP" | "DOWN" | "UNKNOWN";
  reasons: string[];
  evidenceExpiresAt: string;
}

export interface EvaluateHealthTransition {
  ruleKey: string;
  from: "CLOSED" | "PENDING_OPEN" | "OPEN" | "PENDING_RECOVERY";
  to: "CLOSED" | "PENDING_OPEN" | "OPEN" | "PENDING_RECOVERY";
  incidentId: string | null;
  eventKind: "NONE" | "OPENED" | "OBSERVED" | "RECOVERED";
  suppressedByMaintenance: boolean;
}

export interface EvaluateHealthResult {
  deviceId: string;
  evaluatedAt: string;
  effectiveHealthStatus: "UNKNOWN" | "HEALTHY" | "DEGRADED" | "CRITICAL" | "OFFLINE";
  transitions: EvaluateHealthTransition[];
  dependencies: Array<{
    deviceId: string;
    state: "DEPENDENCY_UNKNOWN" | "NO_DATA";
  }>;
}
```

- [ ] **Step 1: Write disposable transition tests**

Assert exact sequence:

```text
failure 1 -> PENDING_OPEN, no incident
failure 2 -> PENDING_OPEN, no incident
failure 3 -> OPEN, one incident/event/outbox
failure 4 -> OPEN, same incident, OBSERVED only
success 1 -> PENDING_RECOVERY, incident still open
failure -> OPEN, recovery counter reset
success 1 -> PENDING_RECOVERY
success 2 -> CLOSED, same incident resolved, one recovery outbox
```

Restart simulation must read counters from database and continue at the correct step.

- [ ] **Step 2: Write maintenance tests and lock the dependency contract**

During maintenance, assert evidence and rule counters update, the outbox payload carries `suppressedByMaintenance:true`, and SLA availability impact is false. The RPC must derive organization/building/parent relationships from the authenticated connection and database, never trust those fields from `p_payload`. Add a static/runtime assertion that an unknown or mismatched `deviceId` is rejected; Task 8 exercises the gateway-to-H196A dependency result after the downstream invariant permits those rows.

- [ ] **Step 3: Run RED incident tests**

Run:

```powershell
npx vitest run src/lib/__tests__/networkCenterIncidentRulesMigration.test.ts
node --test scripts/__tests__/network-center-incident-rules-runtime.test.mjs
npm --prefix infra/network-center-worker test -- polling.test.ts
```

Expected: FAIL because incidents still open on first failure and state is process-local.

- [ ] **Step 4: Implement durable evaluator**

Ensure `(device_id, rule_key)` is a unique or primary key, then lock that exact row with `FOR UPDATE` inside a short transaction. Stable fingerprint is SHA-256 of `organization_id/building_id/device_id/rule_key`; timestamp is excluded. Validate `schemaVersion=1`, bind `deviceId` to the credential/assignment, cap `reasons` at 32 values of 80 characters, and require `observedAt <= evidenceExpiresAt`. The evaluator owns effective-health update plus incident open/observe/recover/outbox writes in the same transaction and returns:

```json
{
  "deviceId": "uuid",
  "evaluatedAt": "RFC3339",
  "effectiveHealthStatus": "OFFLINE",
  "transitions": [{
    "ruleKey":"MANAGEMENT_UNREACHABLE",
    "from":"PENDING_OPEN",
    "to":"OPEN",
    "incidentId":"uuid",
    "eventKind":"OPENED",
    "suppressedByMaintenance":false
  }],
  "dependencies": []
}
```

- [ ] **Step 5: Replace worker incident calls with one evidence submission**

`PollingApi` gains `evaluateHealth(payload)`. Remove `#incident`, `#inventoryIncident`, `lastReportedReachable` and `lastInventoryDegraded` as authoritative transition state. Keep only retry/backoff scheduling in memory; incident and effective-health truth live in PostgreSQL.

- [ ] **Step 6: Run GREEN incident verification**

Run:

```powershell
npm --prefix infra/network-center-worker test -- polling.test.ts fleetHealthHonesty.test.ts
npm --prefix infra/network-center-worker run typecheck
npx --yes deno@2.9.4 test --config supabase/functions/network-center-worker/deno.json supabase/functions/network-center-worker/index.test.ts --allow-env
npx vitest run src/lib/__tests__/networkCenterIncidentRulesMigration.test.ts
node --test scripts/__tests__/network-center-incident-rules-runtime.test.mjs
node scripts/test-network-center-incidents-disposable.mjs --local
```

Expected: PASS with exact 3-fail/2-success transitions, one incident fingerprint, maintenance suppression, and a payload contract ready for Task 8 dependency tests.

- [ ] **Step 7: Commit Task 4**

```powershell
git add -- supabase/migrations/20260812012000_network_center_incident_rules.sql src/lib/__tests__/networkCenterIncidentRulesMigration.test.ts scripts/test-network-center-incidents-disposable.mjs scripts/__tests__/network-center-incident-rules-runtime.test.mjs infra/network-center-worker/src/polling.ts infra/network-center-worker/src/domain.ts infra/network-center-worker/src/apiClient.ts infra/network-center-worker/test/polling.test.ts supabase/functions/network-center-worker/index.ts supabase/functions/network-center-worker/index.test.ts
git commit -m "feat(network-center): làm bền hysteresis sự cố" -m "- mở sau ba lỗi và phục hồi sau hai lần xanh\n- gom dependency H196A theo gateway root cause\n- giữ evidence trong maintenance\n\nCo-Authored-By: Codex <noreply@openai.com>"
```

### Task 5: Fan Out Network Events To In-App And Push Notifications

**Files:**
- Create: `supabase/migrations/20260812013000_network_center_notification_delivery.sql`
- Create: `src/lib/__tests__/networkCenterNotificationDeliveryMigration.test.ts`
- Create: `scripts/test-network-center-notifications-disposable.mjs`
- Create: `scripts/__tests__/network-center-notification-runtime.test.mjs`
- Modify: `supabase/functions/network-watchdog/index.ts`
- Modify: `supabase/functions/network-watchdog/index.test.ts`
- Modify: `src/lib/network-center/contracts.ts`
- Modify: `src/lib/network-center/dto.ts`
- Modify: `src/lib/network-center/supabaseRepository.ts`
- Modify: `src/hooks/network-center/useNetworkCenter.ts`
- Modify: `src/components/network-center/tabs/SettingsTab.tsx`
- Modify: `src/lib/__tests__/networkCenterSupabaseRepository.test.ts`

**Interfaces:**
- Produces table `network_notification_subscriptions`.
- Alters `network_outbox_deliveries` with nullable `recipient_id uuid REFERENCES auth.users(id)`, replaces the old unique constraint with partial legacy `(outbox_event_id, channel) WHERE recipient_id IS NULL` and recipient `(outbox_event_id, recipient_id, channel) WHERE recipient_id IS NOT NULL` indexes, and keeps delivery attempts/status in that table.
- Produces RPCs `network_center_get_my_notification_subscriptions_v1`, `network_center_set_my_notification_subscription_v1`, `network_center_watchdog_fanout_v1(p_batch_size integer DEFAULT 100)`.
- Adds watchdog route `POST /fanout`.
- Reuses `notifications` with `channel='IN_APP'`, `type='CUSTOM'`, and `push_state='QUEUED'` only for push subscribers.

- [ ] **Step 1: Write migration tests that pin notification semantics**

```ts
expect(sql).toMatch(/network_notification_subscriptions/i);
expect(sql).toMatch(/channel[^;]*IN_APP/is);
expect(sql).toMatch(/type[^;]*CUSTOM/is);
expect(sql).toMatch(/push_state[^;]*QUEUED/is);
expect(sql).toMatch(/network_outbox_deliveries[\s\S]*recipient_id/is);
expect(sql).not.toMatch(/notifications[\s\S]*status\s*=\s*'SENT'/i);
expect(sql).not.toMatch(/notification_preferences[\s\S]*NETWORK_CENTER/i);
```

- [ ] **Step 2: Write disposable fanout cases**

Cover migration of an existing delivery row to a non-recipient legacy marker without duplicating it, then recipient building permission, inactive membership, severity threshold, building-specific override, quiet hours, in-app only, push enabled, duplicate fanout retry and maintenance-suppressed event. During quiet hours assert the in-app row exists immediately with `push_state=NULL` and `metadata.pushDeferredUntil`; after the boundary, a later sweep changes that same row to `QUEUED`. Assert new fanout rows use a real `recipient_id` and unique `(outbox_event_id, recipient_id, channel)` delivery.

- [ ] **Step 3: Write watchdog `/fanout` tests**

Wrong secret -> 401/no RPC; success -> 200 with claimed/created/skipped counts; contention -> 200 skipped; DB failure -> 503; malformed report -> 503.

- [ ] **Step 4: Run RED notification tests**

Run:

```powershell
npx vitest run src/lib/__tests__/networkCenterNotificationDeliveryMigration.test.ts src/lib/__tests__/networkCenterSupabaseRepository.test.ts
node --test scripts/__tests__/network-center-notification-runtime.test.mjs
npx --yes deno@2.9.4 test --config supabase/functions/network-watchdog/deno.json supabase/functions/network-watchdog/index.test.ts --allow-env
```

Expected: FAIL on missing subscription table, fanout RPC and route.

- [ ] **Step 5: Implement subscription RLS and RPCs**

Columns: `user_id`, `organization_id`, nullable `building_id`, `minimum_severity`, `in_app`, `push`, nullable `quiet_start`, `quiet_end`, `timezone`, `enabled`, `version`, timestamps. Own-row permissive policy plus restrictive org/sandbox boundary; setters verify active membership and `network_center.view` for building-scoped rows. Add nullable `network_outbox_deliveries.recipient_id` for legacy compatibility, backfill no fake user IDs, drop the old unique constraint, and create a partial legacy key plus the new recipient key so retries remain idempotent on both row classes.

- [ ] **Step 6: Implement idempotent fanout**

Use one transaction-level advisory try-lock for the fanout sweep, then claim at most `p_batch_size` eligible outbox rows with `FOR UPDATE SKIP LOCKED`. Select recipients using the authoritative building permission helper, insert delivery rows with `ON CONFLICT DO NOTHING`, then insert notification metadata. Add indexes matching `(status, available_at, id)`, recipient joins, subscription scope/severity filters and RLS columns; prove them with `EXPLAIN (COSTS OFF)` in the disposable harness.

```json
{
  "domain": "NETWORK_CENTER",
  "eventKind": "INCIDENT_OPENED",
  "organizationId": "uuid",
  "buildingId": "uuid",
  "deviceId": "uuid",
  "incidentId": "uuid",
  "severity": "CRITICAL",
  "fingerprint": "sha256",
  "href": "/network-center/buildings/${buildingId}?tab=incidents"
}
```

Set `notifications.status='PENDING'`. Set `push_state='QUEUED'` only when `push=true` and the recipient is outside quiet hours; during quiet hours leave it `NULL`, store `metadata.pushDeferredUntil`, and let the same fanout RPC queue it after that timestamp without inserting another notification.

- [ ] **Step 7: Add notification settings UI**

In `SettingsTab`, add a separate “Thông báo vận hành” section with minimum severity, in-app, push, quiet hours and building/default scope. This section needs `network_center.view`; it must not require or imply RouterOS execute permission.

- [ ] **Step 8: Run GREEN notification verification**

Run:

```powershell
npx vitest run src/lib/__tests__/networkCenterNotificationDeliveryMigration.test.ts src/lib/__tests__/networkCenterSupabaseRepository.test.ts src/lib/__tests__/networkCenterTabs.test.tsx
node --test scripts/__tests__/network-center-notification-runtime.test.mjs
node scripts/test-network-center-notifications-disposable.mjs --local
npx --yes deno@2.9.4 test --config supabase/functions/network-watchdog/deno.json supabase/functions/network-watchdog/index.test.ts --allow-env
npm run typecheck:baseline
```

Expected: PASS; repeated fanout creates no duplicate notification/delivery; push state is correct.

- [ ] **Step 9: Commit Task 5**

```powershell
git add -- supabase/migrations/20260812013000_network_center_notification_delivery.sql src/lib/__tests__/networkCenterNotificationDeliveryMigration.test.ts scripts/test-network-center-notifications-disposable.mjs scripts/__tests__/network-center-notification-runtime.test.mjs supabase/functions/network-watchdog/index.ts supabase/functions/network-watchdog/index.test.ts src/lib/network-center/contracts.ts src/lib/network-center/dto.ts src/lib/network-center/supabaseRepository.ts src/hooks/network-center/useNetworkCenter.ts src/components/network-center/tabs/SettingsTab.tsx src/lib/__tests__/networkCenterSupabaseRepository.test.ts
git commit -m "feat(network-center): nối sự cố vào thông báo vận hành" -m "- thêm subscription theo tòa và severity\n- fanout outbox idempotent sang in-app và push\n- giữ read state tách delivery state\n\nCo-Authored-By: Codex <noreply@openai.com>"
```

### Task 6: Deploy And Verify The Network Watchdog As A Release Artifact

**Files:**
- Modify: `scripts/deploy-edge-fn.mjs`
- Modify: `scripts/generate-network-center-rollout-manifest.mjs`
- Modify: `scripts/network-center-rollout-manifest.json`
- Modify: `scripts/validate-network-center-rollout.mjs`
- Modify: `scripts/audit-network-center-rollout.mjs`
- Modify: `scripts/__tests__/network-center-rollout.test.mjs`
- Modify: `.github/workflows/network-center-validation.yml`
- Modify: `supabase/functions/network-watchdog/index.ts`
- Modify: `supabase/functions/network-watchdog/index.test.ts`

**Interfaces:**
- Manifest schema bumps from `1` to `2` and changes one `edgeFunction` to ordered `edgeFunctions[]` containing worker and watchdog file lists/digests/verifyJwt mode; validator/deployer reject legacy v1 for this release instead of guessing both shapes.
- `deploy-edge-fn.mjs` explicitly allows `--no-verify-jwt` for `network-center-worker` and `network-watchdog`, and for no other slug.
- Audit returns deployed version plus an explicit deployed-digest verification state for both functions.
- The Management API list readback returns the exact ACTIVE slug, version and `verify_jwt` for both functions. A server-side source/bundle digest counts as independent readback only when the documented response exposes a digest field whose semantics are covered by a fixture; otherwise the audit reports `deployedDigestState: "RECEIPT_BOUND"` and keeps the exact digest binding in the immutable deploy receipt instead of pretending a locally echoed digest came from the server.

- [ ] **Step 1: Extend rollout tests before changing deploy code**

Test explicit file allowlists:

```js
{
  slug: "network-center-worker",
  files: ["deno.json", "deno.lock", "index.ts", "workerAuth.ts"],
  verifyJwt: false
}
{
  slug: "network-watchdog",
  files: ["deno.json", "deno.lock", "index.ts", "watchdogAuth.ts"],
  verifyJwt: false
}
```

Unknown slug and symlink path must fail. Tracked support files not in the deploy allowlist, such as `index.test.ts`, remain excluded from the production bundle; changing any deployable source requires updating the explicit list and digest.

Add rollout tests proving both Edge bundles are required by manifest validation, reviewed-revision digest checks, deployment and audit. Reject duplicate slugs, unknown slug, missing explicit file allowlist, symlink source, malformed digest, wrong `verifyJwt`, wrong returned slug/version or a release whose reviewed revision does not contain the pinned bytes. Add Management API fixtures for missing slug, non-`ACTIVE` status, stale version, wrong `verify_jwt`, duplicate slug and missing/unknown server digest. A deploy receipt proves the reviewed bytes submitted with the returned version; it does not by itself prove that version remains current, so Management API status/version/verify-JWT readback is still mandatory.

- [ ] **Step 2: Run RED rollout tests**

Run:

```powershell
node --test scripts/__tests__/network-center-rollout.test.mjs
```

Expected: FAIL because manifest/deployer/readback support only the worker.

- [ ] **Step 3: Implement multi-function manifest/deployer/readback**

The generator emits `edgeFunctions[]` in stable slug order. Validator and reviewed-byte checks iterate every entry. The deployer checks exact project ref, reviewed Git SHA, individual file SHA, bundle digest, returned slug, each function's exact `verifyJwt` and deployed version, then writes one receipt per function.

`audit-network-center-rollout.mjs` performs a separate authenticated `GET https://api.supabase.com/v1/projects/${projectRef}/functions`, indexes the returned functions by exact slug, and requires one `ACTIVE` row for `network-center-worker` and one for `network-watchdog`. For each row it compares exact `version` and `verify_jwt` to that function's immutable deploy receipt. It compares a deployed source digest to `edgeFunctions[].sha256` only when the response contains the tested canonical digest field. When the API omits such a field, the audit accepts `deployedDigestState: "RECEIPT_BOUND"` only if the immutable receipt binds manifest digest, reviewed SHA, release SHA, source digest and the same server-read-back version; a conflicting digest still fails. The audit output carries `{slug, status, version, verifyJwt, deployedDigest, deployedDigestState, receiptPath}` for both functions so operators can distinguish reviewed source, deploy response and current server state. `network-center:apply` remains unchanged and is not used to apply the six new schema migrations; Task 9 uses the repository's mandatory per-file `migrate:forward` lane.

- [ ] **Step 4: Add watchdog smoke to CI**

After Deno tests, start or invoke handler-level smoke proving missing/wrong secret denial and `/liveness`, `/maintenance`, `/fanout` route contract. CI remains Deno `2.9.4` and Node `22.23.2`.

- [ ] **Step 5: Run GREEN rollout verification**

Run:

```powershell
node --test scripts/__tests__/network-center-rollout.test.mjs
node scripts/generate-network-center-rollout-manifest.mjs --check
npm run network-center:validate
npx --yes deno@2.9.4 test --config supabase/functions/network-watchdog/deno.json supabase/functions/network-watchdog/index.test.ts --allow-env
```

Expected: PASS; manifest pins both Edge bundles.

- [ ] **Step 6: Commit Task 6**

```powershell
git add -- scripts/deploy-edge-fn.mjs scripts/generate-network-center-rollout-manifest.mjs scripts/network-center-rollout-manifest.json scripts/validate-network-center-rollout.mjs scripts/audit-network-center-rollout.mjs scripts/__tests__/network-center-rollout.test.mjs .github/workflows/network-center-validation.yml supabase/functions/network-watchdog/index.ts supabase/functions/network-watchdog/index.test.ts
git commit -m "fix(network-center): quản lý release watchdog theo digest" -m "- pin source worker và watchdog trong manifest\n- deploy và audit exact Edge revision\n- smoke ba route watchdog\n\nCo-Authored-By: Codex <noreply@openai.com>"
```

### Task 7: Add Fleet, Building And Device Analytics

**Files:**
- Create: `supabase/migrations/20260812014000_network_center_analytics_rpcs.sql`
- Create: `src/lib/__tests__/networkCenterAnalyticsMigration.test.ts`
- Create: `scripts/test-network-center-analytics-disposable.mjs`
- Create: `scripts/__tests__/network-center-analytics-runtime.test.mjs`
- Create: `src/components/network-center/tabs/AnalyticsTab.tsx`
- Modify: `src/lib/network-center/contracts.ts`
- Modify: `src/lib/network-center/dto.ts`
- Modify: `src/lib/network-center/supabaseRepository.ts`
- Modify: `src/hooks/network-center/useNetworkCenter.ts`
- Modify: `src/lib/network-center/model.ts`
- Modify: `src/components/network-center/BuildingTabs.tsx`
- Modify: `src/components/network-center/FleetOverview.tsx`
- Modify: `src/components/network-center/NetworkMetricStrip.tsx`
- Modify: `src/lib/__tests__/networkCenterTabs.test.tsx`
- Modify: `src/lib/__tests__/networkCenterSupabaseRepository.test.ts`
- Modify: `.e2e-fleet/specs/network-center.spec.ts`

**Interfaces:**
- Produces `network_center_get_operational_summary_v1(p_from timestamptz, p_to timestamptz) RETURNS jsonb`.
- Produces `network_center_get_building_analysis_v1(p_building_id uuid, p_from timestamptz, p_to timestamptz) RETURNS jsonb`.
- Produces exact keyset RPC `network_center_list_device_events_v1(p_building_id uuid, p_device_id uuid DEFAULT NULL, p_event_kinds text[] DEFAULT NULL, p_severities text[] DEFAULT NULL, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL, p_before_at timestamptz DEFAULT NULL, p_before_id uuid DEFAULT NULL, p_limit integer DEFAULT 100) RETURNS jsonb`.
- Event result shape is `{ items, nextCursor }`, where each item has `id`, `occurredAt`, `organizationId`, `buildingId`, `deviceId`, `eventKind`, `severity`, `healthStatus`, `incidentId`, `source`, `summary`, and redacted `details`; `nextCursor` is either `null` or `{ occurredAt, id }`.

- [ ] **Step 1: Write authorization and null-semantics tests**

Assert inaccessible building returns permission error, sandbox data is hidden, `coveragePct` and `uptimePct` are null with zero coverage, unknown seconds are explicit, filter arrays reject unknown values or more than 16 members, and device-event cursor is stable on `(occurred_at, id)`.

- [ ] **Step 2: Run RED analytics tests**

Run:

```powershell
npx vitest run src/lib/__tests__/networkCenterAnalyticsMigration.test.ts src/lib/__tests__/networkCenterTabs.test.tsx
node --test scripts/__tests__/network-center-analytics-runtime.test.mjs
```

Expected: FAIL because RPCs and tab do not exist.

- [ ] **Step 3: Implement bounded analytic RPCs**

Enforce `p_to > p_from`, maximum range 90 days for event detail and 13 months for rollups, page max 250. When event `p_from`/`p_to` are null, default to the last 24 hours; when only one bound is supplied, reject it. Summary returns coverage counts, health duration, incident counts/MTTR, IP changes, notification delivery status and stale evidence. Building analysis groups by device and root-cause fingerprint. Event ordering and cursor are exactly `(occurred_at DESC, id DESC)` with a matching composite index; no RPC uses `OFFSET`. Validate optional `p_device_id` belongs to the accessible building, constrain event/severity filters to catalog enums, and redact details through an allowlist before return. Add `EXPLAIN (COSTS OFF)` assertions for fleet time range, building/device range and delivery-status joins.

- [ ] **Step 4: Add analytics repository/query keys**

Use dedicated query keys containing actor ID, building ID, time range and cursor. Realtime invalidation may refresh the first page/summary; it must not reset loaded keyset history silently.

- [ ] **Step 5: Build analytics UI without zero fallbacks**

Add fleet coverage cards and building “Phân tích” tab with:

```text
Coverage % | Uptime % | Unknown time | Incidents | MTTR | IP changes
device timeline: health, WAN, public IP, incident, notification delivery
```

Display `—` / “Chưa đủ dữ liệu” for null values.

- [ ] **Step 6: Run GREEN analytics verification**

Run:

```powershell
npx vitest run src/lib/__tests__/networkCenterAnalyticsMigration.test.ts src/lib/__tests__/networkCenterTabs.test.tsx src/lib/__tests__/networkCenterSupabaseRepository.test.ts
node --test scripts/__tests__/network-center-analytics-runtime.test.mjs
node scripts/test-network-center-analytics-disposable.mjs --local
npm run typecheck:baseline
```

Expected: PASS; null coverage stays null from SQL through rendered text.

- [ ] **Step 7: Commit Task 7**

```powershell
git add -- supabase/migrations/20260812014000_network_center_analytics_rpcs.sql src/lib/__tests__/networkCenterAnalyticsMigration.test.ts scripts/test-network-center-analytics-disposable.mjs scripts/__tests__/network-center-analytics-runtime.test.mjs src/components/network-center/tabs/AnalyticsTab.tsx src/lib/network-center/contracts.ts src/lib/network-center/dto.ts src/lib/network-center/supabaseRepository.ts src/hooks/network-center/useNetworkCenter.ts src/lib/network-center/model.ts src/components/network-center/BuildingTabs.tsx src/components/network-center/FleetOverview.tsx src/components/network-center/NetworkMetricStrip.tsx src/lib/__tests__/networkCenterTabs.test.tsx src/lib/__tests__/networkCenterSupabaseRepository.test.ts .e2e-fleet/specs/network-center.spec.ts
git commit -m "feat(network-center): thêm phân tích vận hành theo evidence" -m "- tổng hợp coverage health incident và IP change\n- thêm timeline keyset theo thiết bị\n- không thay null bằng zero\n\nCo-Authored-By: Codex <noreply@openai.com>"
```

### Task 8: Add H196A Downstream Inventory, Discovery And Topology

**Files:**
- Create: `supabase/migrations/20260812015000_network_center_h196a_downstream.sql`
- Create: `src/lib/__tests__/networkCenterH196aMigration.test.ts`
- Create: `scripts/test-network-center-h196a-disposable.mjs`
- Create: `scripts/__tests__/network-center-h196a-runtime.test.mjs`
- Create: `infra/network-center-worker/src/h196a/discovery.ts`
- Create: `infra/network-center-worker/test/h196aDiscovery.test.ts`
- Create: `scripts/network-center-h196a-capability.mjs`
- Create: `scripts/__tests__/network-center-h196a-capability.test.mjs`
- Create: `infra/network-center-worker/docs/H196A-DISCOVERY-RUNBOOK.md`
- Create: `src/components/network-center/RouterSelector.tsx`
- Create: `src/lib/__tests__/networkCenterRouterSelector.test.tsx`
- Modify: `scripts/network-center-admin.mjs`
- Modify: `scripts/__tests__/network-center-admin-control-plane.test.mjs`
- Modify: `infra/network-center-worker/src/domain.ts`
- Modify: `infra/network-center-worker/src/routeros/sshConnector.ts`
- Modify: `infra/network-center-worker/src/polling.ts`
- Modify: `infra/network-center-worker/src/apiClient.ts`
- Modify: `infra/network-center-worker/test/sshConnector.test.ts`
- Modify: `infra/network-center-worker/test/polling.test.ts`
- Modify: `infra/network-center-worker/test/apiClient.test.ts`
- Modify: `supabase/functions/network-center-worker/index.ts`
- Modify: `supabase/functions/network-center-worker/index.test.ts`
- Modify: `src/lib/network-center/contracts.ts`
- Modify: `src/lib/network-center/dto.ts`
- Modify: `src/lib/network-center/supabaseRepository.ts`
- Modify: `src/lib/network-center/demoRepository.ts`
- Modify: `src/hooks/network-center/useNetworkCenter.ts`
- Modify: `src/components/network-center/BuildingWorkspace.tsx`
- Modify: `src/components/network-center/tabs/OverviewTab.tsx`
- Modify: `src/components/network-center/tabs/ClientsTab.tsx`
- Modify: `src/components/network-center/tabs/TopologyTab.tsx`
- Modify: `src/components/network-center/tabs/IncidentsTab.tsx`
- Modify: `src/components/network-center/NetworkActionDialog.tsx`
- Modify: `src/lib/__tests__/networkCenterSupabaseRepository.test.ts`
- Modify: `src/lib/__tests__/networkCenterModel.test.ts`
- Modify: `.e2e-fleet/specs/network-center.spec.ts`

**Interfaces:**
- Keeps `network_devices_one_active_mikrotik_per_building` unchanged; adds `ZTE_H196A` to `device_kind` and trigger `app_private.network_center_guard_h196a_parent_v1()`.
- Adds an H196A-owned one-to-one table `network_h196a_profiles(device_id uuid PRIMARY KEY REFERENCES network_devices(id))` carrying `organization_id`, `building_id`, `gateway_device_id`, `stable_key`, `identity_source`, `mac_address`, `observed_ip`, `observed_ip_at`, `observed_ip_expires_at`, `firmware_version`, fixed `capability_verdict='INDIRECT_ONLY'`, fixed `monitoring_mode='INDIRECT'`, discovery timestamps and redacted indirect evidence metadata. Adds `network_h196a_discovery_candidates` for quarantined/unknown evidence. No H196A connection/credential/assignment is created in this plan.
- Produces admin RPC:

```sql
network_center_admin_register_h196a_v1(
  p_gateway_device_id uuid,
  p_stable_key text,
  p_display_name text,
  p_serial_number text DEFAULT NULL,
  p_mac_address macaddr DEFAULT NULL,
  p_observed_ip inet DEFAULT NULL,
  p_firmware_version text DEFAULT NULL,
  p_discovery_evidence jsonb DEFAULT '{}'::jsonb,
  p_request_id uuid DEFAULT gen_random_uuid()
) RETURNS jsonb
```

- Extends `network_center_worker_inventory_v2` payload/response rather than creating a RouterOS connection RPC for H196A. Payload adds `h196a[]` and `h196aQuarantine[]`; response adds `h196a[]` mappings and quarantine counts.
- Produces browser RPCs `network_center_get_building_v3(p_building_id uuid, p_device_id uuid DEFAULT NULL)` and `network_center_list_clients_v2(p_building_id uuid, p_device_id uuid DEFAULT NULL, p_before_seen_at timestamptz DEFAULT NULL, p_before_id uuid DEFAULT NULL, p_limit integer DEFAULT 100)`. Task 7 event RPC already validates the same device scope.
- Produces `NetworkBuilding.gatewayDeviceId`, `routers`, `selectedRouterId`, `h196aCount`, `h196aIndirectSeen`, and `h196aProblemCount`; read/query targets carry exact `deviceId`, while every mutation/action rejects `deviceKind="ZTE_H196A"`.

- [ ] **Step 1: Write schema and identity invariant tests**

Disposable PostgreSQL must prove:

```text
two active MikroTik devices in one building -> reject by existing index
one active MikroTik + two active ZTE_H196A -> accept
H196A parent missing/inactive/non-root/wrong building/wrong org -> reject
H196A parent is Aruba or H196A -> reject
H196A parent changed after evidence exists -> reject unless device is inactive
H196A with child/self-parent/cycle -> reject
same stable MAC/serial maps to one device -> idempotent reconcile
same stable key presented with conflicting MAC/serial -> quarantine, no overwrite
H196A write_capability=true -> reject
H196A connection/credential/assignment insertion -> reject in this release
network_center_admin_provision_connection_v1(H196A) -> deny
network_center_request_snapshot_v1(H196A) -> deny
network_center_execute_action_v1(H196A) -> deny
```

Pin `device_kind IN ('MIKROTIK','ARUBA','ZTE_H196A')`, preserve the existing one-MikroTik index, and require stable keys `serial:<normalized>` or `mac:<lowercase-globally-administered-unicast-mac>`. Reject zero/broadcast/multicast and locally administered/randomized MACs; for normalized MAC text, the second nibble of the first octet must match `[048c]`. A legacy/hostname/IP-only identity may be quarantined for operator review but may not auto-enroll.

- [ ] **Step 2: Write exact indirect-discovery parser tests**

`discoverH196aCandidates(input)` is pure and accepts the MikroTik records already read by `poll()`:

```ts
export interface H196aDiscoveryInput {
  observedAt: string;
  leases: Array<Record<string, string>>;
  neighbors: Array<Record<string, string>>;
  knownDevices: Array<{
    deviceId: string;
    stableKey: string;
    macAddress: string | null;
    serialNumber: string | null;
  }>;
}

export interface H196aMatchedObservation {
  deviceId: string;
  stableKey: string;
  identitySource: "SERIAL" | "HARDWARE_MAC";
  macAddress: string | null;
  serialNumber: string | null;
  observedIp: string | null;
  hostname: string | null;
  interfaceKey: string | null;
  evidenceSources: Array<"MIKROTIK_DHCP_LEASE" | "MIKROTIK_NEIGHBOR">;
  firstSeenAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface H196aDiscoveryCandidate {
  proposedStableKey: string | null;
  fingerprint: string;
  reason: "HOSTNAME_ONLY" | "IP_ONLY" | "UNSTABLE_MAC" | "IDENTITY_CONFLICT" | "AMBIGUOUS_MATCH";
  macAddress: string | null;
  serialNumber: string | null;
  observedIp: string | null;
  hostname: string | null;
  interfaceKey: string | null;
  evidenceSources: Array<"MIKROTIK_DHCP_LEASE" | "MIKROTIK_NEIGHBOR">;
  observedAt: string;
  expiresAt: string;
}
```

Tests cover: DHCP+neighbor joining on MAC; case normalization; locally administered/randomized/multicast/zero/broadcast MAC quarantine; IP churn with stable MAC; duplicate MAC with conflicting serial; hostname containing `H196A` without a pinned identity staying candidate-only; nullable `proposedStableKey` for hostname/IP-only evidence; deterministic fingerprint/reason; and unrelated clients never being enrolled as H196A. Discovery must not probe H196A or issue any additional RouterOS command. DHCP/neighbor IP is always observed evidence with freshness, never an authoritative management address.

- [ ] **Step 3: Write admin registration and capability fail-closed tests**

`scripts/network-center-admin.mjs register-h196a` accepts the exact RPC fields plus `--confirm-indirect`. It may write only DEMO/TEST during this task. Registration always persists `INDIRECT_ONLY`; a separate offline artifact may record another verdict but cannot change runtime monitoring mode in this plan. It refuses: missing active gateway readback, any requested direct runtime mode, IP-only stable identity, `canExecute`, credential/host-key/bootstrap inputs, duplicate identity conflicts and real-org writes.

`scripts/network-center-h196a-capability.mjs inspect --input C:\temp\h196a-capture.json --output C:\temp\h196a-capability.json` is an offline artifact validator, not a network scanner or probe command. The input capture must have been collected by an authorized operator on lab/DEMO/TEST equipment. Exact artifact:

```json
{
  "schemaVersion": 1,
  "device": {
    "model": "ZXHN H196A",
    "firmwareVersion": "string",
    "serialNumber": null,
    "macAddress": "aa:bb:cc:dd:ee:ff",
    "observedAddress": "192.168.1.1"
  },
  "probes": [{
    "protocol": "LOCAL_HTTPS_READ_ONLY|LOCAL_HTTP_READ_ONLY|TR069_OPERATOR_OWNED_ACS",
    "documented": true,
    "authenticated": true,
    "readOnly": true,
    "identityMatched": true,
    "writeAttempted": false,
    "result": "VERIFIED|NOT_AVAILABLE|NOT_OWNED|FAILED_CLOSED"
  }],
  "verdict": "INDIRECT_ONLY",
  "capturedAt": "RFC3339",
  "operator": "non-secret-label",
  "redactions": ["credentials", "sessionTokens", "subscriberData"]
}
```

The validator rejects credentials/session tokens, missing model/firmware/stable-identity match, any `writeAttempted=true`, unknown protocols or a direct research verdict without at least one verified documented read-only observation in the supplied capture. It performs no network I/O, does not brute-force, enable management, change password, upload firmware, reboot, contact an ISP ACS or generate a connection. The artifact never changes runtime `INDIRECT_ONLY` and the UI does not render a direct H196A state in this release.

- [ ] **Step 4: Write dependency, aggregate, selector and action-denial tests**

With one MikroTik gateway and two H196A devices, prove a gateway `ROUTER_UNREACHABLE` transition returns both downstream devices as `DEPENDENCY_UNKNOWN` and emits no duplicate H196A critical incident. An indirectly seen H196A exposes only `SEEN`, `STALE`, `DEPENDENCY_UNKNOWN` or `NO_DATA`; it never becomes `HEALTHY/OFFLINE` from a lease alone. Call the real provisioning, snapshot and action RPCs with an H196A ID and assert permission/validation denial before any connection, command request or snapshot row is written.

Fleet remains one row per building with gateway health primary. Building v3 defaults selection to the gateway, accepts an in-building H196A, rejects another building's device, and returns evidence badges. `RouterSelector` orders gateway first then H196A by `sortOrder/displayName`; invalid query IDs fall back to gateway with a warning. Clients and analytics reads include selected `deviceId`; configuration, backup, reboot, port-cycle, DHCP-renew and DNS-flush actions remain gateway-only, and `NetworkActionDialog` renders no H196A action button.

- [ ] **Step 5: Run RED H196A tests**

```powershell
npx vitest run src/lib/__tests__/networkCenterH196aMigration.test.ts src/lib/__tests__/networkCenterRouterSelector.test.tsx src/lib/__tests__/networkCenterSupabaseRepository.test.ts src/lib/__tests__/networkCenterModel.test.ts
node --test scripts/__tests__/network-center-h196a-runtime.test.mjs scripts/__tests__/network-center-h196a-capability.test.mjs scripts/__tests__/network-center-admin-control-plane.test.mjs
npm --prefix infra/network-center-worker test -- h196aDiscovery.test.ts sshConnector.test.ts polling.test.ts apiClient.test.ts
```

Expected: FAIL because `ZTE_H196A`, stable identity, indirect discovery payloads, admin registration, topology selection and explicit action denial do not exist.

- [ ] **Step 6: Implement schema guard, registration RPC and inventory ingestion**

The migration replaces only the `device_kind` CHECK and adds H196A-owned constraints/indexes/trigger. It must not drop or widen `network_devices_one_active_mikrotik_per_building`. `network_center_admin_register_h196a_v1` locks the gateway and matching stable identity, validates DEMO/TEST scope, reconciles non-conflicting metadata, sets `parent_device_id`, `vendor='ZTE'`, `model='ZXHN H196A'`, `write_capability=false`, `credential_ref=NULL`, `monitoring_mode='INDIRECT'`, and returns:

```json
{
  "gatewayDeviceId": "uuid",
  "h196aDeviceId": "uuid",
  "stableKey": "mac:aa:bb:cc:dd:ee:ff",
  "identitySource": "HARDWARE_MAC",
  "capabilityVerdict": "INDIRECT_ONLY",
  "monitoringMode": "INDIRECT",
  "writeCapability": false,
  "connectionId": null,
  "credentialRef": null,
  "assignmentId": null
}
```

Extend inventory v2 transactionally with bounded `h196a` and `h196aQuarantine` arrays. Only an already registered stable key is auto-refreshed; unknown candidates are stored in a quarantine/candidate table and surfaced for operator registration. Matching updates `last_seen`, observed IP, evidence sources and uplink metadata without changing stable identity.

- [ ] **Step 7: Implement MikroTik-derived discovery without a H196A connector**

Keep the existing RouterOS lease and neighbor reads. Preserve their parsed records long enough to call `discoverH196aCandidates`; do not add SSH commands. `RouterObservation` gains `h196a` and `h196aQuarantine`, `PollingManager.#syncInventory()` includes them in its signature/batches, and `InventoryMapping` adds `h196a: Array<{ stableKey: string; id: string }>`.

There is no change to `network_center_worker_list_connections_v2` in this release: it continues returning only pollable MikroTik connections. Do not add H196A to `RouterCredential`, RouterOS connector factory, bootstrap policy, host-key verification, command claims or worker assignment. The capability runbook documents only the operator-capture/offline-validator workflow and explicitly defines no `H196aAdapter` runtime interface; any connector requires a separate approved design and plan after exact protocol discovery.

- [ ] **Step 8: Implement browser topology and evidence-source UX**

`NetworkBuilding` gains:

```ts
gatewayDeviceId: string | null;
routers: RouterSummary[];
selectedRouterId: string | null;
h196aCount: number;
h196aIndirectSeen: number;
h196aProblemCount: number;
```

`RouterSummary` gains `deviceKind: "MIKROTIK" | "ZTE_H196A"`, `parentDeviceId`, `monitoringMode: "DIRECT" | "INDIRECT"`, `evidenceSource: "ROUTEROS_DIRECT" | "MIKROTIK_DHCP_LEASE" | "MIKROTIK_NEIGHBOR"`, nullable metrics, fixed H196A capability verdict and freshness. For `ZTE_H196A`, `monitoringMode` is always `INDIRECT` and runtime status is only `SEEN|STALE|DEPENDENCY_UNKNOWN|NO_DATA`. Keep `router` as a derived alias of the selected device during migration.

Topology renders `MikroTik -> H196A`, plus Aruba under its existing display-only relationship, with badges `Trực tiếp RouterOS`, `Gián tiếp qua DHCP` or `Gián tiếp qua Neighbor`. Selecting H196A may filter client/event evidence but does not expose interface/configuration/action panels as if it were RouterOS. Extend read targets with exact `deviceId`; extend mutation targets only to reject H196A explicitly and prevent silent retargeting to `building.router.id`.

- [ ] **Step 9: Run GREEN H196A verification**

```powershell
npx vitest run src/lib/__tests__/networkCenterH196aMigration.test.ts src/lib/__tests__/networkCenterRouterSelector.test.tsx src/lib/__tests__/networkCenterSupabaseRepository.test.ts src/lib/__tests__/networkCenterModel.test.ts src/lib/__tests__/networkCenterTabs.test.tsx
node --test scripts/__tests__/network-center-h196a-runtime.test.mjs scripts/__tests__/network-center-h196a-capability.test.mjs scripts/__tests__/network-center-admin-control-plane.test.mjs
node scripts/test-network-center-h196a-disposable.mjs --local
npm --prefix infra/network-center-worker test -- h196aDiscovery.test.ts sshConnector.test.ts polling.test.ts apiClient.test.ts
npm --prefix infra/network-center-worker run typecheck
npx --yes deno@2.9.4 test --config supabase/functions/network-center-worker/deno.json supabase/functions/network-center-worker/index.test.ts --allow-env
npm run typecheck:baseline
npm run build
```

Expected: PASS; one MikroTik remains the only pollable gateway, registered H196A devices are refreshed from stable indirect evidence, identity conflicts quarantine instead of overwriting, gateway outage groups H196A dependency once, no H196A connection/credential/assignment/bootstrap is created, and the production bundle renders truthful topology/evidence badges.

- [ ] **Step 10: Commit Task 8**

```powershell
git add -- supabase/migrations/20260812015000_network_center_h196a_downstream.sql src/lib/__tests__/networkCenterH196aMigration.test.ts scripts/test-network-center-h196a-disposable.mjs scripts/__tests__/network-center-h196a-runtime.test.mjs scripts/network-center-h196a-capability.mjs scripts/__tests__/network-center-h196a-capability.test.mjs scripts/network-center-admin.mjs scripts/__tests__/network-center-admin-control-plane.test.mjs
git add -- infra/network-center-worker/src/h196a/discovery.ts infra/network-center-worker/test/h196aDiscovery.test.ts infra/network-center-worker/docs/H196A-DISCOVERY-RUNBOOK.md infra/network-center-worker/src/domain.ts infra/network-center-worker/src/routeros/sshConnector.ts infra/network-center-worker/src/polling.ts infra/network-center-worker/src/apiClient.ts infra/network-center-worker/test/sshConnector.test.ts infra/network-center-worker/test/polling.test.ts infra/network-center-worker/test/apiClient.test.ts supabase/functions/network-center-worker/index.ts supabase/functions/network-center-worker/index.test.ts
git add -- src/components/network-center/RouterSelector.tsx src/lib/__tests__/networkCenterRouterSelector.test.tsx src/lib/network-center/contracts.ts src/lib/network-center/dto.ts src/lib/network-center/supabaseRepository.ts src/lib/network-center/demoRepository.ts src/hooks/network-center/useNetworkCenter.ts src/components/network-center/BuildingWorkspace.tsx src/components/network-center/tabs/OverviewTab.tsx src/components/network-center/tabs/ClientsTab.tsx src/components/network-center/tabs/TopologyTab.tsx src/components/network-center/tabs/IncidentsTab.tsx src/components/network-center/NetworkActionDialog.tsx src/lib/__tests__/networkCenterSupabaseRepository.test.ts src/lib/__tests__/networkCenterModel.test.ts .e2e-fleet/specs/network-center.spec.ts
git commit -m "feat(network-center): mô hình hóa H196A downstream" -m "- giữ MikroTik là gateway RouterOS duy nhất\n- nhận diện H196A bằng MAC hoặc serial và evidence gián tiếp\n- chặn credential, bootstrap và hành động ghi H196A\n\nCo-Authored-By: Codex <noreply@openai.com>"
```

### Task 9: Freeze Reviewed Artifacts, Apply Forward Migrations, Then Roll Out In Waves

**Files:**
- Modify: `scripts/network-center-rollout-manifest.json`
- Modify: `supabase/migration-provenance.json`
- Modify: `src/integrations/supabase/types.ts`
- Modify: `docs/generated/database-inventory.json`
- Create: `docs/generated/schema-change-evidence/20260812010000_network_center_coverage_truth.json`
- Create: `docs/generated/schema-change-evidence/20260812011000_network_center_ip_health_observability.json`
- Create: `docs/generated/schema-change-evidence/20260812012000_network_center_incident_rules.json`
- Create: `docs/generated/schema-change-evidence/20260812013000_network_center_notification_delivery.json`
- Create: `docs/generated/schema-change-evidence/20260812014000_network_center_analytics_rpcs.json`
- Create: `docs/generated/schema-change-evidence/20260812015000_network_center_h196a_downstream.json`
- Create: `` `.network-center-rollout/${projectRef}/${manifestDigest}/*.json` `` at runtime only; this ignored receipt store is readback evidence and must not be staged or hand-edited.

**Interfaces:**
- Ordered migration list contains every historical Network Center migration discovered on disk plus the six new migration files in Global Constraints.
- Rollout waves: DEMO -> TEST -> one real building -> three-building batch -> remaining buildings.
- Production rollback is rollout `OFF`, assignment/connection drain, watchdog/worker exact previous digest; no down migration.

- [ ] **Step 1: Generate pre-apply provenance and commit the reviewed source candidate**

After Tasks 1-8 are committed, generate provenance from the current production catalog plus the six new file digests. Do not run project-backed type generation yet: production does not contain the new schema before Step 6, and `SUPABASE_TYPES_SOURCE=local` is not a valid substitute unless the execution first proves a complete local stack containing the production baseline plus all six forward migrations. The current Network Center disposable harness builds only its scoped bootstrap, so this plan uses a separate post-apply type commit.

```powershell
node scripts/generate-migration-provenance.mjs --write
git add -- supabase/migration-provenance.json
git commit -m "chore(network-center): chốt provenance observability" -m "- pin SHA sáu migration forward-only mới\n- giữ trạng thái pre-apply dựa trên catalog hiện tại\n\nCo-Authored-By: Codex <noreply@openai.com>"
$reviewedSha = git rev-parse HEAD
```

Expected: provenance contains exact SHA-256 entries for all six migrations, remains honest that they are not yet catalog-proven, and `$reviewedSha` is a full 40-character clean candidate SHA. If the execution request does not authorize commits, stop here: the rollout lane requires committed reviewed bytes.

- [ ] **Step 2: Generate and commit the manifest against the clean candidate**

```powershell
node scripts/generate-network-center-rollout-manifest.mjs --reviewed-git-sha $reviewedSha
node scripts/generate-network-center-rollout-manifest.mjs --check
git add -- scripts/network-center-rollout-manifest.json
git commit -m "chore(network-center): chốt manifest observability read-only" -m "- pin toàn bộ lịch sử Network Center và sáu migration mới\n- pin hai Edge bundle và reviewed release SHA\n- giữ production execute tắt\n\nCo-Authored-By: Codex <noreply@openai.com>"
$releaseSha = git rev-parse HEAD
npm run network-center:validate -- --revision $releaseSha
```

Validation must prove that `$reviewedSha` is an ancestor of final `$releaseSha` and every migration/Edge byte pinned by the manifest matches the reviewed revision. The manifest does not pin itself, so `--stamp` is unnecessary. Expected: clean worktree, manifest hashes match committed bytes, and validation reports the exact full release SHA.

- [ ] **Step 3: Run focused database/runtime gates**

```powershell
npx vitest run src/lib/__tests__/networkCenterCoverageTruthMigration.test.ts src/lib/__tests__/networkCenterIpHealthMigration.test.ts src/lib/__tests__/networkCenterIncidentRulesMigration.test.ts src/lib/__tests__/networkCenterNotificationDeliveryMigration.test.ts src/lib/__tests__/networkCenterAnalyticsMigration.test.ts src/lib/__tests__/networkCenterH196aMigration.test.ts
node --test scripts/__tests__/network-center-*.test.mjs
node scripts/test-network-center-coverage-disposable.mjs --local
node scripts/test-network-center-ip-health-disposable.mjs --local
node scripts/test-network-center-incidents-disposable.mjs --local
node scripts/test-network-center-notifications-disposable.mjs --local
node scripts/test-network-center-analytics-disposable.mjs --local
node scripts/test-network-center-h196a-disposable.mjs --local
```

Expected: all PASS; no disposable script targets production.

- [ ] **Step 4: Run worker and Edge gates on pinned runtimes**

```powershell
npm ci --prefix infra/network-center-worker
npm --prefix infra/network-center-worker test
npm --prefix infra/network-center-worker run typecheck
npm --prefix infra/network-center-worker run build
npx --yes deno@2.9.4 test --config supabase/functions/network-center-worker/deno.json supabase/functions/network-center-worker/index.test.ts --allow-env
npx --yes deno@2.9.4 test --config supabase/functions/network-watchdog/deno.json supabase/functions/network-watchdog/index.test.ts --allow-env
```

Expected: PASS on Node 22-compatible worker and Deno 2.9.4.

- [ ] **Step 5: Run repository gates**

```powershell
npm run gate:runtime-matrix
npm run gate:test-matrix
npm run gate:migration-provenance
npm run gate:migration-idempotent
npm run gate:definer-acl
npm run gate:view-invoker
npm run gate:rpc-arg-names
npm run gate:rpc-layer
npm run typecheck:baseline
npm run build
npm run docs:check:links
git diff --check
```

Expected: all PASS with the exact package scripts shown above.

- [ ] **Step 6: Dry-run and apply each migration through `migrate:forward`**

Run the credential gate first. If backup or Supabase Management capability is missing, stop and report that named capability; do not contact production. `network-center:validate/audit` supplies manifest/catalog evidence only. It must not apply these new schema files. For each file in timestamp order, dry-run it and then immediately apply that exact file through `migrate:forward` before moving to the dependent migration; the lane creates and verifies a fresh full backup for each apply and records its own receipt. Do not create one shared backup or pass `--backup-manifest` to `network-center:apply`.

```powershell
npm run gate:local-credentials
$releaseSha = git rev-parse HEAD
npm run network-center:validate -- --revision $releaseSha
npm run network-center:audit -- --preflight --revision $releaseSha

$migrations = @(
  'supabase/migrations/20260812010000_network_center_coverage_truth.sql',
  'supabase/migrations/20260812011000_network_center_ip_health_observability.sql',
  'supabase/migrations/20260812012000_network_center_incident_rules.sql',
  'supabase/migrations/20260812013000_network_center_notification_delivery.sql',
  'supabase/migrations/20260812014000_network_center_analytics_rpcs.sql',
  'supabase/migrations/20260812015000_network_center_h196a_downstream.sql'
)
foreach ($migration in $migrations) {
  npm run migrate:forward -- $migration
  if ($LASTEXITCODE -ne 0) { throw "Dry-run failed: $migration" }
  npm run migrate:forward -- $migration --apply
  if ($LASTEXITCODE -ne 0) { throw "Apply failed: $migration" }
}
```

Expected after apply: six schema-change evidence files, each bound to the backup created and verified for that exact migration. The worktree is intentionally dirty with those generated receipts, so do not run `network-center:audit` yet; its validator requires a clean HEAD. Never replace this with `network-center:apply`, ad-hoc Management API SQL or a shared backup shortcut.

- [ ] **Step 7: Generate canonical Supabase types from the now-updated project and commit the frontend release SHA**

Run the canonical project-backed generator only after all six migrations pass. Then capture the live catalog and normalize daily partitions before type checks:

```powershell
npm run gen:types
npm run types:normalize
npm run types:check
node scripts/generate-migration-provenance.mjs --write
npm run catalog:capture
npm run gate:migration-provenance
npm run catalog:verify-proven
git add -- src/integrations/supabase/types.ts supabase/migration-provenance.json docs/generated/database-inventory.json docs/generated/schema-change-evidence/20260812010000_network_center_coverage_truth.json docs/generated/schema-change-evidence/20260812011000_network_center_ip_health_observability.json docs/generated/schema-change-evidence/20260812012000_network_center_incident_rules.json docs/generated/schema-change-evidence/20260812013000_network_center_notification_delivery.json docs/generated/schema-change-evidence/20260812014000_network_center_analytics_rpcs.json docs/generated/schema-change-evidence/20260812015000_network_center_h196a_downstream.json
git commit -m "chore(network-center): cập nhật type và catalog sau migration" -m "- sinh canonical type từ schema đã apply\n- ghi provenance và catalog receipt-backed\n\nCo-Authored-By: Codex <noreply@openai.com>"
$frontendReleaseSha = git rev-parse HEAD
npm run network-center:validate -- --revision $frontendReleaseSha
```

Expected: generated types contain all six new tables/RPCs and no daily partition types; provenance/catalog and all six evidence receipts are committed; manifest/reviewed-byte validation passes from a clean HEAD. Do not run post-apply rollout audit until both Edge candidates have been deployed, because current server versions cannot yet match them. This commit is the frontend/runtime release candidate; database migration evidence remains tied to `$releaseSha`. Regenerate the rollout manifest against `$frontendReleaseSha` only if Edge or migration bytes changed; a types/provenance/catalog-only commit must leave pinned runtime bytes unchanged and still validate `$reviewedSha` as an ancestor.

- [ ] **Step 8: Deploy Edge functions and worker canary by exact digest**

```powershell
node scripts/deploy-edge-fn.mjs network-center-worker --no-verify-jwt --revision $frontendReleaseSha
node scripts/deploy-edge-fn.mjs network-watchdog --no-verify-jwt --revision $frontendReleaseSha
node scripts/audit-network-center-rollout.mjs --post-apply --revision $frontendReleaseSha
```

Deploy the worker through the existing blue-green lane after its plan-only preflight:

```powershell
powershell -NoProfile -File infra/network-center-worker/scripts/deploy-vultr.ps1 -ReleaseSha $frontendReleaseSha -HostName $env:NETWORK_CENTER_VULTR_HOST -KnownHostsFile $env:NETWORK_CENTER_KNOWN_HOSTS_FILE -PlanOnly
powershell -NoProfile -File infra/network-center-worker/scripts/deploy-vultr.ps1 -ReleaseSha $frontendReleaseSha -HostName $env:NETWORK_CENTER_VULTR_HOST -KnownHostsFile $env:NETWORK_CENTER_KNOWN_HOSTS_FILE
```

Expected: exact image SHA/digest, emergency-stop canary, heartbeat and poll readback match the release; no command claim occurs before read-only verification passes.

- [ ] **Step 9: DEMO and TEST rollout gates**

DEMO:

```powershell
npm run gate:local-credentials
node scripts/network-center-demo-canary.mjs plan --confirm-demo
node scripts/network-center-demo-canary.mjs apply --confirm-demo
# Wait for at least seven real read-only poll cycles.
node scripts/network-center-demo-canary.mjs verify
```

If the credential gate reports missing Network Center router/VPS capability, stop here and name the missing capability; do not continue to TEST or the real organization. Register one H196A in DEMO and one in TEST with `scripts/network-center-admin.mjs register-h196a --confirm-indirect`, using a stable serial/MAC and no credential/host-key/bootstrap arguments. Feed DHCP/neighbor evidence through the normal MikroTik poll and observe at least seven clean cycles. Verify the topology shows `MikroTik -> H196A`, evidence source/freshness is correct, the H196A has no connection/credential/assignment, and selecting it exposes no action controls.

Prove the live dependency behavior only by a controlled DEMO/TEST gateway reachability exercise from the runbook: temporarily block the canary worker's route to the DEMO/TEST MikroTik for exactly three scheduled polls, restore it for two scheduled polls, and capture before/after worker, connection, incident, outbox and H196A readback. Do not change the router, H196A or real-org route, and do not post synthetic observations through admin/browser RPCs. Require one gateway root incident/fanout, H196A `DEPENDENCY_UNKNOWN`, no duplicate H196A critical incident, then run `cleanup` if the canary was created only for this rollout. If an operator-captured capability artifact exists, run the offline validator and record its verdict; `INDIRECT_ONLY` or `UNSUPPORTED` is a valid outcome and does not block rollout.

Stop if any: duplicate notification, H196A critical storm under gateway outage, indirect evidence labeled healthy/offline, identity conflict auto-overwrite, any H196A credential/connection/assignment/action, unknown counted as uptime, gateway host-key mismatch, failed gateway poll, stale watchdog or capacity breach.

- [ ] **Step 10: Run headless production E2E before real-building rollout**

```powershell
Set-Location .e2e-fleet
$env:FLEET_WORKERS='8'
npx playwright test specs/network-center-request-budget.spec.ts specs/network-center.spec.ts
Set-Location ..
```

Use the repository-provided `FLEET_PASS_*` secret environment only; never put credentials in the command, plan, screenshot or trace. Expected: request budgets pass, no fallback/demo leakage, no console errors, DEMO H196A selector/evidence badge and notification deep link pass, then the shell returns to the repo root. The unauthenticated public smoke is not a substitute for this gate.

- [ ] **Step 11: Roll out one real building read-only**

Use admin status to capture pre-state. Provision only connection/assignment for the explicitly selected building; keep `can_execute=false`, set rollout `READ_ONLY`, and observe 24 hours. Acceptance:

```text
coverage=MONITORED
poll success=100% of configured connections
no unexpected router write
notification duplicates=0
coveragePct >= 99% after initial warm-up
worker RSS <= 384 MiB steady / 448 MiB peak
5-minute CPU average < 0.35 core
poll-cycle p95 < 45 seconds
```

- [ ] **Step 12: Expand to three buildings, then remaining buildings**

Each wave must repeat status snapshot, MikroTik connection/assignment exact readback, H196A inventory/quarantine readback, 24-hour soak and stop conditions. Never batch a building whose gateway host key, management route or credential readback is missing, or whose H196A identity evidence conflicts. No `EXECUTE` promotion and no H196A direct adapter rollout.

- [ ] **Step 13: Rehearse rollback**

On DEMO/TEST and before fleet expansion prove:

```text
building rollout -> OFF removes it from monitored denominator without deleting evidence
gateway assignment/connection drain stops future RouterOS polls
H196A inventory downgrade to INDIRECT retains topology/evidence and removes no history
watchdog redeploys previous exact digest
worker rollback uses previous image ID without rebuild/pull
notifications fanout kill switch stops new deliveries while outbox remains
```

- [ ] **Step 14: Final integrated verification and change-set review**

Rerun only affected failed gates plus one final integrated pass from Steps 2–4 and production E2E. Then inspect:

```powershell
git status --short
git diff --stat
git diff --check
```

Expected: only planned Network Center files, generated artifacts and approved evidence receipts; user-owned unrelated changes remain untouched.

Do not stage `.network-center-rollout/`; it is an ignored operational receipt store. Pre-apply provenance and manifest are committed before schema apply; canonical types plus receipt-backed provenance/catalog are committed after schema apply as the separate frontend/runtime release candidate.

## Rollback Matrix

| Failure | Immediate action | Evidence retained |
| --- | --- | --- |
| Coverage/RPC/UI regression | Roll frontend revision back; keep v1 RPCs and additive schema | DB evidence and migrations |
| Worker creates load or bad polls | Stop `network-center-worker` service/container; `EMERGENCY_STOP` alone does not stop SSH polling | Heartbeat, poll/error logs |
| H196A identity conflict or false discovery | Quarantine the candidate or deactivate the H196A inventory row; keep the MikroTik gateway rollout read-only | Topology, discovery evidence and incident history |
| Notification storm | Disable Network Center fanout job/kill switch; leave outbox and in-app rows intact | Outbox/delivery audit |
| Watchdog regression | Redeploy previous exact Edge digest | Deployment receipt/catalog |
| Real-building canary failure | Set building rollout `OFF`, drain its assignments/connections, do not delete rows | Full canary history |
| Migration semantic error after commit | Add forward-fix migration with new timestamp; never edit or down-migrate applied file | Provenance and receipts |

## Completion Gate

Do not call the feature complete or production-ready until all of these are true:

- Coverage states for disabled/not-rolled-out/missing/monitored are proven on disposable DB and live readback.
- DEMO has real current telemetry and seven consecutive clean read-only cycles.
- IP evidence, health derivation, durable hysteresis and SLA unknown semantics pass worker/Edge/SQL/UI tests.
- In-app and optional push notification delivery is recipient-scoped, deduped and read/delivery states are separate.
- Watchdog and worker are both digest-pinned in immutable deploy receipts; current ACTIVE version/verify-JWT is independently read back by the rollout lane, and any server-side digest exposed by the API must also match.
- Analytics shows null/unknown honestly and uses bounded/keyset RPCs.
- Gateway MikroTik polls directly; H196A DEMO/TEST is identified by stable MAC/serial and refreshed from indirect evidence, groups gateway root cause, has no connection/credential/assignment, and keeps write capability false.
- Focused tests, disposable PostgreSQL proofs, Node/Deno gates, typecheck, build, docs link check and headless Playwright are green after the final change.
- Real-org rollout remains read-only and every wave has a successful rollback rehearsal.
