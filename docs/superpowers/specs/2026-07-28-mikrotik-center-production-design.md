# MikroTik Network Center Production Design

## Goal

Turn the existing full-screen Network Center UI into a production system for
monitoring and safely operating every rental-building MikroTik, while preserving
the current iHomeCRM authentication, building scope, two-permission model, and
all UI work already implemented.

## Locked Decisions

- The route and current Network Center UI remain in iHomeCRM.
- Every building has at most one active MikroTik router.
- Aruba inventory is display-only and has no hard maximum per building.
- Employee authorization has exactly two public permissions:
  - `network_center.view`
  - `network_center.execute`
- Execute users enqueue allowed actions immediately. There is no approval,
  approver, reject, or maker-checker state.
- The Hybrid A+ storage model is used:
  - normalized current-state projections for fast UI reads;
  - append-only telemetry, incident, command, and audit history;
  - raw telemetry retained for 14 days;
  - hourly rollups retained for 13 months;
  - daily SLA retained for 36 months.
- Router credentials, WireGuard private keys, arbitrary CLI, and unredacted
  configuration never reach browser-readable database rows.
- The Network Center worker is a dedicated service on the existing Vultr host.
  It does not share a process or credential file with the Zalo worker or 9Router.

## System Architecture

```text
iHomeCRM Network Center
    | authenticated narrow RPCs + Realtime invalidation
    v
Supabase control/data plane
    |- inventory and desired state
    |- safe current-state projections
    |- telemetry partitions and rollups
    |- incidents, maintenance, snapshots
    |- command queue, leases, attempts, events
    |- append-only audit and outbox
    |
    | worker-only Edge API backed by internal RPCs
    v
Dedicated Network Center worker on Vultr
    |- WireGuard management network
    |- credential references resolved from VPS-only secret files
    |- RouterOS polling and allowlisted execution
    |- pre-backup, post-check, rollback/reconciliation
    v
MikroTik routers and display-only Aruba inventory
```

The browser treats Realtime payloads only as invalidation signals. It refetches
authoritative data through RPCs after every relevant event.

## Delivery Tracks

The production objective is delivered as three independently testable tracks in
one rollout:

1. **Supabase control/data plane**: schema, RLS, RPCs, queue semantics,
   partitions, retention, Realtime, and database verification.
2. **iHomeCRM integration**: an asynchronous Supabase repository implementing
   the existing UI contract, feature rollout controls, and browser tests.
3. **Vultr network worker**: dedicated deployable, RouterOS connector, polling,
   command execution, health checks, secrets, and operational runbook.

## Authorization And Tenant Isolation

The repository's normalized authorization v3 is authoritative. The legacy
`can_do_on_building()` signature remains a compatibility shim over `can_v3()`;
new code does not read `staff_assignments.permissions` or `roles.permissions`
directly.

- Insert `network_center.view` and `network_center.execute` into
  `permission_definitions` with `TENANT` domain and organization/area/building
  scope support.
- Every Network Center table has `organization_id NOT NULL` and, except for
  worker-global heartbeat data, `building_id NOT NULL`.
- Building-bound rows use a composite foreign key
  `(organization_id, building_id) -> buildings(organization_id, id)`.
- Browser reads require `can_v3('network_center.view', building_id)` through the
  compatibility helper or direct private helper used by current policy style.
- Browser mutations use `SECURITY DEFINER` RPCs, pin
  `search_path = pg_catalog, public, app_private`, derive the actor from
  `auth.uid()`, lock the target, and recheck
  `can_do_on_building('network_center', 'execute', building_id)`.
- Public and anonymous execution is explicitly revoked. Authenticated users
  receive only the public RPC grants required by `view` or `execute`.
- Browser roles receive no direct INSERT, UPDATE, or DELETE grants on operational
  Network Center tables.
- Internal worker functions are not executable by `anon` or `authenticated`.
- Public views are avoided. If a view is required, it must set
  `security_invoker = true` and pass `scripts/check-view-invoker.mjs`.

## Data Model

### Inventory And Control

`network_devices`

- Identifies MikroTik routers and Aruba APs by organization and building.
- Stores type, external key, display identity, model, lifecycle status, desired
  firmware, parent/uplink references, and sort order.
- A partial unique index permits at most one active MikroTik per building.
- Aruba rows are unlimited and must have `write_capability = false`.
- `(organization_id, building_id, kind, external_key)` is unique.

`network_interfaces`

- Stores RouterOS interface identity, role, protection flag, speed, and order.
- WAN, management, and protected uplinks cannot be access-port-cycle targets.
- Role/protection data is worker-owned and never trusted from a browser request.

`network_device_connections`

- Worker-only metadata: management address, connector type, host-key fingerprint,
  and opaque `credential_ref`.
- Contains no password, private key, token, or raw secret.

`network_site_settings`

- One versioned row per building for polling interval, backup time, alert
  sensitivity, dependency grouping, and `changes_paused` kill switch.
- Optimistic concurrency uses `version` and `updated_at`.

`network_desired_state_versions`

- Stores allowlisted, schema-versioned desired configuration with a content hash.
- Only one active version exists per building.
- Supports drift detection without exposing arbitrary RouterOS scripts.

### Current Projections

`network_device_current`

- One row per device with observation time, reachability, last seen, RouterOS
  version, CPU, memory, disk, temperature, voltage, PPPoE state, and connection
  count where applicable.

`network_interface_current`

- One row per interface with link state, RX/TX rates, utilization, error,
  discard, and queue-drop counters.
- WAN throughput has one source of truth: the WAN interface projection.

`network_client_current`

- TTL-based active presence with session key, safe display address fields,
  hostname, connection type, room hint, traffic, and `expires_at`.
- Expired presence is removed by the worker/sweeper.

### Client History And iHomeCRM Links

`network_client_sessions`

- Records first/last seen, address history, hostname, traffic totals, and device
  association for each observed presence session.
- MAC addresses are observations, not permanent tenant identities.

`network_client_links`

- Time-bounded links from an observed client fingerprint to optional room,
  contract, and customer records.
- Stores source, confidence, valid-from/to, and actor metadata so randomized MAC
  changes do not rewrite history.

### Telemetry And SLA

`network_device_samples` and `network_interface_samples`

- Append-only time-series parents partitioned by observation date.
- Worker writes batches; browsers receive no direct raw-sample access.
- Retention functions drop data older than 14 days.

`network_metric_hourly`

- Stores count, minimum, maximum, average, and p95 by metric/hour.
- Retained for 13 months.

`network_sla_daily`

- Stores uptime, outage seconds, excluded maintenance seconds, incident count,
  and MTTR by building/day.
- Retained for 36 months.

The worker may poll every 30 seconds while persisting raw samples every 60 seconds
or on material change. Current projections update every successful poll.

### Incidents And Maintenance

`network_incidents`

- One durable incident per active fingerprint/building/device/interface.
- Stores severity, open/last-observed/resolved times, availability impact, and
  acknowledgement metadata.

`network_incident_events`

- Append-only timeline of open, escalate, acknowledge, recover, and resolve.
- Acknowledge updates the incident and appends audit/event rows atomically.

`network_maintenance_windows`

- Durable scheduled, active, completed, or cancelled windows.
- Cancellation never deletes history.
- Maintenance affects alert grouping and SLA exclusion, not authorization.

### Configuration Snapshots

`network_config_snapshots`

- Stores only normalized, redacted content, line arrays, hashes, schema version,
  source, actor/job references, and optional opaque artifact key.
- Pairwise diff RPCs compare redacted content only.
- Raw `.rsc` and `.backup` artifacts live in VPS/private object storage and are
  never returned by browser RPCs.

### Commands, Leases, And Attempts

`network_commands`

- Stores action type, reason, canonical target references, immutable target
  display snapshot, sanitized parameters, requested actor, request hash,
  idempotency key, status, result, rollback, and reconciliation state.
- Confirmation text is validated and discarded; it is never persisted.
- Command rows are read only through sanitized RPC DTOs and are not a Realtime
  publication because active rows contain worker lease credentials. Append-only
  command events are the browser-safe invalidation signal.

`network_command_attempts`

- Records each leased execution attempt, worker, lease token, timestamps,
  retryability, sanitized error, and result.

`network_command_events`

- Append-only validation, backup, execution, post-check, reconciliation, and
  terminal-state events.

`network_device_leases`

- Provides per-router serialization with token, owner, heartbeat, and expiry.
- A dead worker cannot leave a device locked permanently.

Command state machine:

```text
queued -> leased -> running -> succeeded
              |        |
              |        +-> uncertain -> reconciling -> succeeded/failed
              +-> retry_wait -> queued
queued/leased/running -> failed or cancelled_by_kill_switch
```

There are no approval states. If a disruptive side effect may have started, the
worker never blindly replays it; it reconciles read-only and reports `uncertain`
when the result cannot be proven.

### Audit, Outbox, And Worker Health

`network_audit_events`

- Append-only actor/action/target/reason/validation/result/outcome history.
- Historical target names remain immutable after building renames.
- UPDATE and DELETE are denied to browser and worker roles.

`network_outbox_events` and `network_outbox_deliveries`

- Immutable domain events are separate from mutable notification delivery state.
- Delivery retries cannot alter the audit source event.

`network_worker_heartbeats`

- Stores worker identity, version, capabilities, heartbeat, queue age, and safe
  status metadata for operations monitoring.

## Public RPC Contract

- `network_center_list_fleet_v1()` returns building summaries, derived health,
  router state, Aruba counts, incidents, backup freshness, SLA, and maintenance.
- `network_center_get_building_v1(p_building_id)` returns the bounded aggregate
  used by the ten current tabs; large collections use cursor pagination.
- `network_center_list_aruba_v1(...)` has cursor pagination and no device-count
  ceiling.
- `network_center_list_clients_v1(...)`, `network_center_list_audit_v1(...)`, and
  `network_center_list_commands_v1(...)` use `(created_at, id)` keyset cursors.
- `network_center_compare_snapshots_v1(...)` returns redacted line diffs only.
- `network_center_ack_incident_v1(...)` atomically acknowledges and audits.
- `network_center_create_maintenance_v1(...)` and
  `network_center_cancel_maintenance_v1(...)` preserve history.
- `network_center_request_snapshot_v1(...)` enqueues a snapshot command.
- `network_center_execute_action_v1(...)` validates a closed action enum,
  building/device/interface ownership, protection, settings kill switch,
  reason, action-specific fields, and confirmation before immediate enqueue.
- `network_center_update_settings_v1(...)` uses expected-version concurrency.

Every mutation accepts an idempotency key. A duplicate with the same request
hash returns the original result; reuse with different input raises a conflict.

## Worker API And Security Boundary

The Vultr worker never receives the project-wide Supabase service-role key.
A dedicated Supabase Edge Function validates `NETWORK_WORKER_SECRET` using a
constant-time comparison and exposes only worker operations backed by internal
RPCs:

- register/heartbeat;
- list assigned connection metadata without secrets;
- claim commands;
- renew command/device leases;
- discover/upsert RouterOS interfaces and display-only Aruba inventory in
  bounded batches, returning stable external-key-to-UUID mappings;
- ingest bounded telemetry/current-state batches;
- append command stages/results;
- upsert incidents and snapshots;
- request retention/rollup work.

Aruba discovery has no total device quota. Each request is capped at 256 Aruba
rows and can be repeated as many times as needed; discovered management
addresses are display metadata only and never create a credential or write
capability.

The worker resolves `credential_ref` from a root-owned `0600` configuration file
or secret store on Vultr. Logs redact credentials, raw configuration, addresses
where not operationally required, and customer-linked client identities.

## Router Connectivity And Action Allowlist

- Management transport is WireGuard from each router to the Vultr host.
- RouterOS management services are restricted to the WireGuard management
  subnet; no API/SSH service is exposed to the public WAN.
- The worker connector uses structured RouterOS reads and a closed action map.
- Initial allowed actions match the current UI:
  - flush DNS cache;
  - renew uplink DHCP lease;
  - cycle one unprotected access port for 5-30 seconds;
  - reboot the targeted MikroTik.
- Aruba targets and arbitrary CLI are rejected by the public RPC and worker.
- Every disruptive action performs validation, pre-backup, execution,
  post-check, and reconciliation/rollback classification.

## iHomeCRM Integration

The existing `NetworkCenterRepository` seam is preserved. A production
`SupabaseNetworkCenterRepository` maps RPC DTOs to current UI contracts.

- React Query owns asynchronous reads and mutations.
- Realtime invalidates building/fleet keys with debounce.
- Demo data remains available only behind an explicit development/test flag.
- Production defaults to Supabase data and shows truthful unprovisioned/worker
  offline states instead of fabricated telemetry.
- Execute controls remain gated by the existing two permissions, while server
  RPCs independently enforce authorization.
- No UI polish or redesign is part of this production integration track.

## Rollout And Operational Safety

1. Apply inert schema, catalog permissions, RLS, RPCs, and default site settings.
2. Backfill one unprovisioned MikroTik slot per existing physical building; do
   not fabricate production telemetry or credentials.
3. Deploy Edge worker API and dedicated Vultr worker in heartbeat/read-only mode.
4. Provision one demo router over WireGuard and verify telemetry, incidents,
   snapshots, retention, and reconnect behavior.
5. Enable production reads for the DEMO organization, then one real building.
6. Enable allowlisted execute actions per building only after backup and
   post-check smoke tests pass.
7. Expand to all buildings; `changes_paused` remains the per-building kill
   switch and a global worker-side emergency stop remains available.

Rollback is additive: disable the production repository flag, pause command
claiming, and keep the database/audit history. No rollback deletes evidence.

## Verification Contract

- Static migration tests cover table/constraint/index/RLS/grant/function shape.
- Cross-tenant tests cover owner, view-only, execute, wrong-building, wrong-org,
  offboarded, and anonymous callers.
- Queue tests cover duplicate idempotency, hash conflict, concurrent claims,
  lease expiry, worker crash, retry exhaustion, and uncertain reconciliation.
- Snapshot tests prove secret-like keys and values never reach public rows/diffs.
- Partition/retention tests cover date boundaries and repeat-safe rollups.
- Worker unit/integration tests use a fake connector and deterministic clock.
- Router smoke tests run read-only first, then each allowlisted action with
  pre/post assertions on the dedicated demo router.
- Browser tests cover no-view, view-only, execute, live read data, job progress,
  settings concurrency, Realtime refresh, mobile route integrity, and zero
  unexpected console/network errors.
- Repository gates include focused Vitest, `npm run typecheck:baseline`, build,
  generated Supabase type drift, definer ACL, view invoker, and cross-tenant
  scripts.
- Production completion requires readback from Supabase, worker heartbeat,
  successful demo-router telemetry/action evidence, and a headless smoke test of
  `https://ptcrm.vercel.app/network-center`.

