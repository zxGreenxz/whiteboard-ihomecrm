import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const inventoryMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729010000_network_center_permissions_inventory.sql",
);

const inventorySql = existsSync(inventoryMigrationPath)
  ? readFileSync(inventoryMigrationPath, "utf8").replace(/\r\n/g, "\n")
  : "";

const telemetryMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729020000_network_center_current_telemetry.sql",
);

const telemetrySql = existsSync(telemetryMigrationPath)
  ? readFileSync(telemetryMigrationPath, "utf8").replace(/\r\n/g, "\n")
  : "";

const operationsMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729030000_network_center_operations.sql",
);

const operationsSql = existsSync(operationsMigrationPath)
  ? readFileSync(operationsMigrationPath, "utf8").replace(/\r\n/g, "\n")
  : "";

const rpcMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729040000_network_center_rls_rpcs_realtime.sql",
);

const rpcSql = existsSync(rpcMigrationPath)
  ? readFileSync(rpcMigrationPath, "utf8").replace(/\r\n/g, "\n")
  : "";

const workerIdentityMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729130000_network_center_worker_identity.sql",
);

const workerIdentitySql = existsSync(workerIdentityMigrationPath)
  ? readFileSync(workerIdentityMigrationPath, "utf8").replace(/\r\n/g, "\n")
  : "";

const resourceLifecycleMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729131000_network_center_resource_lifecycle.sql",
);

const resourceLifecycleSql = existsSync(resourceLifecycleMigrationPath)
  ? readFileSync(resourceLifecycleMigrationPath, "utf8").replace(/\r\n/g, "\n")
  : "";

function sqlFunctionBody(sql: string, functionName: string): string {
  const start = sql.search(new RegExp(`CREATE OR REPLACE FUNCTION\\s+(?:public|app_private)\\.${functionName}\\b`, "i"));
  if (start < 0) return "";
  const next = sql.slice(start + 1).search(/CREATE OR REPLACE FUNCTION\s+(?:public|app_private)\./i);
  return next < 0 ? sql.slice(start) : sql.slice(start, start + 1 + next);
}

describe("Network Center permission and inventory migration", () => {
  it("exists as one forward transaction and refreshes the API schema", () => {
    expect(existsSync(inventoryMigrationPath), `Missing migration: ${inventoryMigrationPath}`).toBe(true);
    expect(inventorySql.match(/^BEGIN;$/gim)).toHaveLength(1);
    expect(inventorySql.match(/^COMMIT;$/gim)).toHaveLength(1);
    expect(inventorySql).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/i);
  });

  it("registers exactly the two building-aware Network Center permissions", () => {
    expect(inventorySql).toContain("'network_center.view'");
    expect(inventorySql).toContain("'network_center.execute'");
    expect(inventorySql).toContain("ARRAY['ORGANIZATION','AREA','BUILDING']");
    expect(inventorySql).toContain("ARRAY['BUILDING']");
    expect(inventorySql).not.toMatch(/network_center\.(approve|manage|delete|create)/i);
  });

  it("creates tenant-bound inventory with one active MikroTik per building", () => {
    expect(inventorySql).toMatch(/CREATE TABLE IF NOT EXISTS public\.network_devices/i);
    expect(inventorySql).toMatch(/network_devices_one_active_mikrotik_per_building/i);
    expect(inventorySql).toMatch(/FOREIGN KEY \(organization_id, building_id\)/i);
    expect(inventorySql).toMatch(/UNIQUE \(organization_id, id\)/i);
    expect(inventorySql).toContain("credential_ref");
    expect(inventorySql).not.toMatch(/password|private_key|api_token|secret\s+text/i);
  });

  it("captures inventory identity, topology, protection, and one active desired state", () => {
    for (const column of [
      "external_key",
      "desired_firmware",
      "parent_device_id",
      "uplink_interface_key",
      "sort_order",
      "is_protected",
      "nominal_speed_bps",
      "schema_version",
    ]) {
      expect(inventorySql).toContain(column);
    }
    expect(inventorySql).toContain("network_devices_external_key_uidx");
    expect(inventorySql).toContain("network_desired_state_one_active_per_building");
    expect(inventorySql).toMatch(
      /UNIQUE \(organization_id, building_id, device_id, id\)/i,
    );
  });

  it("keeps Aruba display-only and unlimited", () => {
    expect(inventorySql).toMatch(/device_kind\s*=\s*'ARUBA'[\s\S]{0,100}write_capability\s*=\s*false/i);
    expect(inventorySql).not.toMatch(/slot_no\s+BETWEEN\s+1\s+AND\s+10/i);
    expect(inventorySql).not.toMatch(/aruba[^\n]{0,80}(max|limit|quota)[^\n]{0,40}\d+/i);
  });

  it("creates interfaces, connections, settings, desired-state history, and inert building slots", () => {
    for (const table of [
      "network_interfaces",
      "network_device_connections",
      "network_site_settings",
      "network_desired_state_versions",
    ]) {
      expect(inventorySql).toContain(`public.${table}`);
    }
    expect(inventorySql).toMatch(/INSERT INTO public\.network_devices/i);
    expect(inventorySql).toMatch(/'MIKROTIK'[\s\S]{0,500}'UNPROVISIONED'/i);
    expect(inventorySql).toMatch(/ON CONFLICT DO NOTHING/i);
  });

  it("fails closed until the later RPC migration and pins every child to its building", () => {
    for (const table of [
      "network_devices",
      "network_interfaces",
      "network_device_connections",
      "network_site_settings",
      "network_desired_state_versions",
    ]) {
      expect(inventorySql).toMatch(
        new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, "i"),
      );
      expect(inventorySql).toMatch(
        new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated`, "i"),
      );
    }

    for (const constraint of [
      "network_interfaces_org_building_fk",
      "network_device_connections_org_building_fk",
      "network_desired_state_versions_org_building_fk",
    ]) {
      expect(inventorySql).toContain(constraint);
    }
    expect(inventorySql).toMatch(/b\.is_virtual\s*=\s*false/i);
  });
});

describe("Network Center current state, telemetry, and retention migration", () => {
  it("exists as one forward transaction", () => {
    expect(existsSync(telemetryMigrationPath), `Missing migration: ${telemetryMigrationPath}`).toBe(true);
    expect(telemetrySql.match(/^BEGIN;$/gim)).toHaveLength(1);
    expect(telemetrySql.match(/^COMMIT;$/gim)).toHaveLength(1);
    expect(telemetrySql).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/i);
  });

  it("creates bounded current projections, client history, and Hybrid A+ rollups", () => {
    for (const table of [
      "network_device_current",
      "network_interface_current",
      "network_client_current",
      "network_client_sessions",
      "network_client_links",
      "network_device_samples",
      "network_interface_samples",
      "network_metric_hourly",
      "network_sla_daily",
    ]) {
      expect(telemetrySql).toContain(`public.${table}`);
    }
    expect(telemetrySql).toContain("expires_at");
    expect(telemetrySql).toContain("client_fingerprint");
    expect(telemetrySql).toContain("valid_from");
    expect(telemetrySql).toContain("valid_to");
  });

  it("partitions raw samples and guards them as append-only", () => {
    expect(telemetrySql.match(/PARTITION BY RANGE \(observed_at\)/gi)).toHaveLength(2);
    expect(telemetrySql).toContain("network_center_ensure_raw_partitions_v1");
    expect(telemetrySql).toContain("network_center_reject_append_only_mutation_v1");
    expect(telemetrySql.match(/BEFORE UPDATE OR DELETE ON public\.network_(device|interface)_samples/gi)).toHaveLength(2);
    expect(telemetrySql).not.toMatch(/PARTITION OF public\.network_(device|interface)_samples\s+DEFAULT/i);
  });

  it("implements repeat-safe hourly and daily rollups", () => {
    expect(telemetrySql).toContain("network_center_rollup_hourly_v1");
    expect(telemetrySql).toContain("network_center_rollup_sla_daily_v1");
    expect((telemetrySql.match(/ON CONFLICT[\s\S]{0,500}DO UPDATE/gi) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(telemetrySql).toMatch(/percentile_cont\s*\(\s*0\.95\s*\)/i);
    expect(telemetrySql).toMatch(/interface_role\s+IN\s*\(\s*'WAN'\s*,\s*'UPLINK'\s*\)/i);
    expect(telemetrySql).toMatch(
      /FROM public\.network_device_samples[\s\S]+NOT EXISTS\s*\([\s\S]+FROM public\.network_maintenance_windows/i,
    );
  });

  it("locks raw, hourly, and SLA retention to 14 days, 13 months, and 36 months", () => {
    expect(telemetrySql).toContain("network_center_retention_v1");
    expect(telemetrySql).toMatch(/INTERVAL '14 days'/i);
    expect(telemetrySql).toMatch(/INTERVAL '13 months'/i);
    expect(telemetrySql).toMatch(/INTERVAL '36 months'/i);
    expect(telemetrySql).toMatch(/DROP TABLE IF EXISTS public\.%I/i);
  });

  it("keeps all telemetry tables and internal functions out of browser write access", () => {
    expect((telemetrySql.match(/ENABLE ROW LEVEL SECURITY/gi) ?? []).length).toBeGreaterThanOrEqual(9);
    expect((telemetrySql.match(/REVOKE ALL ON TABLE public\.network_/gi) ?? []).length).toBeGreaterThanOrEqual(9);
    for (const signature of [
      "app_private.network_center_ensure_raw_partitions_v1(date, date)",
      "app_private.network_center_rollup_hourly_v1(timestamp with time zone)",
      "app_private.network_center_rollup_sla_daily_v1(date)",
      "app_private.network_center_retention_v1(timestamp with time zone)",
    ]) {
      expect(telemetrySql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated, service_role`);
    }
  });
});

describe("Network Center durable operations and command queue migration", () => {
  it("exists as one forward transaction", () => {
    expect(existsSync(operationsMigrationPath), `Missing migration: ${operationsMigrationPath}`).toBe(true);
    expect(operationsSql.match(/^BEGIN;$/gim)).toHaveLength(1);
    expect(operationsSql.match(/^COMMIT;$/gim)).toHaveLength(1);
    expect(operationsSql).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/i);
  });

  it("creates every durable operation, evidence, delivery, and worker-health table", () => {
    for (const table of [
      "network_incidents",
      "network_incident_events",
      "network_maintenance_windows",
      "network_config_snapshots",
      "network_commands",
      "network_command_attempts",
      "network_command_events",
      "network_device_leases",
      "network_audit_events",
      "network_outbox_events",
      "network_outbox_deliveries",
      "network_worker_heartbeats",
    ]) {
      expect(operationsSql).toContain(`public.${table}`);
    }
  });

  it("has immediate execution states only and a closed action allowlist", () => {
    for (const action of [
      "FLUSH_DNS_CACHE",
      "RENEW_DHCP_LEASE",
      "CYCLE_ACCESS_PORT",
      "REBOOT_ROUTER",
      "CAPTURE_SNAPSHOT",
    ]) {
      expect(operationsSql).toContain(`'${action}'`);
    }
    expect(operationsSql).not.toMatch(/pending_approval|approved_by|rejected_by|maker_checker/i);
    expect(operationsSql).not.toMatch(/confirmation_(text|value)/i);
  });

  it("enforces idempotent enqueue, expiring leases, and concurrent safe claims", () => {
    expect(operationsSql).toContain("network_commands_idempotency_uidx");
    expect(operationsSql).toContain("network_center_enqueue_command_v1");
    expect(operationsSql).toMatch(/request_hash\s+IS DISTINCT FROM/i);
    expect(operationsSql).toContain("network_center_claim_commands_v1");
    expect(operationsSql).toContain("network_center_reclaim_expired_commands_v1");
    expect(operationsSql).toMatch(/FOR UPDATE SKIP LOCKED/i);
    expect(operationsSql).toMatch(/ON CONFLICT \(device_id\) DO UPDATE/i);
    expect(operationsSql).toMatch(/expires_at\s*<=\s*v_now/i);
    expect(operationsSql).toContain("network_commands_runnable_idx");
    expect(operationsSql).toMatch(
      /\(lease_token IS NOT NULL\)\s*=\s*\(status IN \('LEASED', 'RUNNING', 'RECONCILING'\)\)/i,
    );
    expect(operationsSql).toContain("network_command_attempts_org_building_identity_key");
    expect(operationsSql).toMatch(
      /network_command_events_attempt_fk[\s\S]{0,180}FOREIGN KEY \(organization_id, building_id, attempt_id\)/i,
    );
    expect(operationsSql).toMatch(
      /INSERT INTO public\.network_command_events[\s\S]{0,900}'LEASED'/i,
    );
    expect(operationsSql).toMatch(
      /status\s*=\s*CASE[\s\S]{0,600}THEN\s+'RETRY_WAIT'[\s\S]{0,600}ELSE\s+'UNCERTAIN'/i,
    );
    expect(operationsSql).toMatch(/lease_expires_at\s*<=\s*p_now/i);
    expect(operationsSql).toMatch(
      /FROM public\.network_commands unresolved[\s\S]{0,220}unresolved\.status\s*=\s*'UNCERTAIN'/i,
    );
  });

  it("rejects ambiguous audit actors and malformed target snapshots", () => {
    expect(operationsSql).toMatch(
      /actor_type\s*=\s*'SYSTEM'\s+AND\s+actor_id\s+IS\s+NULL\s+AND\s+worker_id\s+IS\s+NULL/i,
    );
    expect(operationsSql).toMatch(
      /p_target_display\s+IS\s+NULL\s+OR\s+jsonb_typeof\(p_target_display\)\s*<>\s*'object'/i,
    );
  });

  it("makes evidence streams immutable and keeps browser roles read/write inert", () => {
    for (const table of [
      "network_incident_events",
      "network_command_events",
      "network_config_snapshots",
      "network_audit_events",
      "network_outbox_events",
    ]) {
      expect(operationsSql).toMatch(
        new RegExp(`BEFORE UPDATE OR DELETE ON public\\.${table}`, "i"),
      );
    }
    expect((operationsSql.match(/ENABLE ROW LEVEL SECURITY/gi) ?? []).length).toBeGreaterThanOrEqual(12);
    expect((operationsSql.match(/REVOKE ALL ON TABLE public\.network_/gi) ?? []).length).toBeGreaterThanOrEqual(12);
  });
});

describe("Network Center RLS, RPC, worker, and Realtime migration", () => {
  it("exists as one forward transaction and patches the live UI contract", () => {
    expect(existsSync(rpcMigrationPath), `Missing migration: ${rpcMigrationPath}`).toBe(true);
    expect(rpcSql.match(/^BEGIN;$/gim)).toHaveLength(1);
    expect(rpcSql.match(/^COMMIT;$/gim)).toHaveLength(1);
    expect(rpcSql).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/i);
    for (const column of [
      "backup_time_local",
      "alert_sensitivity",
      "dependency_grouping",
      "session_type",
      "rx_bps",
      "tx_bps",
      "randomized_mac",
      "request_hash",
    ]) {
      expect(rpcSql).toContain(column);
    }
  });

  it("opens read-only RLS paths through building-scoped view permission", () => {
    expect((rpcSql.match(/ENABLE ROW LEVEL SECURITY/gi) ?? []).length).toBeGreaterThanOrEqual(20);
    expect(rpcSql).toContain("can_do_on_building('network_center', 'view'");
    expect(rpcSql).toContain("can_do_on_building('network_center', 'execute'");
    expect(rpcSql).toMatch(/GRANT SELECT ON TABLE public\.network_device_current TO authenticated/i);
    expect(rpcSql).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)[^;]+TO authenticated/i);
  });

  it("provides sanitized public reads and unlimited cursor-paginated Aruba", () => {
    for (const rpc of [
      "network_center_list_fleet_v1",
      "network_center_get_building_v1",
      "network_center_list_aruba_v1",
      "network_center_list_clients_v1",
      "network_center_list_commands_v1",
      "network_center_list_audit_v1",
      "network_center_compare_snapshots_v1",
    ]) {
      expect(rpcSql).toContain(`public.${rpc}`);
    }
    const arubaRpc = sqlFunctionBody(rpcSql, "network_center_list_aruba_v1");
    expect(arubaRpc).toContain("device_kind = 'ARUBA'");
    expect(arubaRpc).toMatch(/p_limit\s+NOT BETWEEN\s+1\s+AND\s+100/i);
    expect(arubaRpc).toMatch(/ROW\([^)]*sort_order[^)]*id[^)]*\)\s*>\s*ROW/i);
    expect(arubaRpc).not.toMatch(/\bOFFSET\b|credential_ref|management_username/i);
    expect(rpcSql).not.toMatch(/aruba[^\n]{0,80}(quota|max_devices|hard_limit)/i);
  });

  it("exposes immediate idempotent mutations without approval or persisted confirmation", () => {
    for (const rpc of [
      "network_center_ack_incident_v1",
      "network_center_create_maintenance_v1",
      "network_center_cancel_maintenance_v1",
      "network_center_request_snapshot_v1",
      "network_center_execute_action_v1",
      "network_center_update_settings_v1",
    ]) {
      expect(rpcSql).toContain(`public.${rpc}`);
    }
    expect(rpcSql).toMatch(/auth\.uid\(\)/i);
    expect(rpcSql).toMatch(/FOR UPDATE/gi);
    expect(rpcSql).toMatch(/request_hash\s+IS DISTINCT FROM/i);
    expect(rpcSql).toMatch(/p_confirmation\s+IS DISTINCT FROM/i);
    expect(rpcSql).not.toMatch(/pending_approval|approved_by|rejected_by|confirmation_(text|value)/i);
  });

  it("grants only narrow worker RPCs to service_role and bounds ingestion", () => {
    for (const rpc of [
      "network_center_worker_heartbeat_v1",
      "network_center_worker_list_connections_v1",
      "network_center_worker_claim_v1",
      "network_center_worker_renew_v1",
      "network_center_worker_ingest_v1",
      "network_center_worker_inventory_v1",
      "network_center_worker_command_event_v1",
      "network_center_worker_complete_v1",
      "network_center_worker_upsert_incident_v1",
      "network_center_worker_snapshot_v1",
      "network_center_worker_maintenance_v1",
    ]) {
      expect(rpcSql).toContain(`public.${rpc}`);
      expect(rpcSql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}[\\s\\S]{0,300} TO service_role`, "i"));
      expect(rpcSql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${rpc}[\\s\\S]{0,300} FROM PUBLIC, anon, authenticated`, "i"));
    }
    expect(rpcSql).toMatch(/octet_length\(p_payload::text\)\s*>\s*524288/i);
    expect(rpcSql).toMatch(/jsonb_array_length\([\s\S]{0,120}?\)\s*>\s*256/i);
    expect(rpcSql).toMatch(/FOR UPDATE SKIP LOCKED/i);
  });

  it("does not lease reconciliation work beyond the requested worker batch", () => {
    const claimRpc = sqlFunctionBody(rpcSql, "network_center_worker_claim_v1");
    expect(claimRpc).toMatch(
      /IF\s+jsonb_array_length\(v_regular\)\s*<\s*p_limit\s+THEN/i,
    );
    expect(claimRpc).toMatch(
      /p_limit\s*-\s*jsonb_array_length\(v_regular\)/i,
    );
  });

  it("publishes only safe invalidation tables", () => {
    for (const table of [
      "network_device_current",
      "network_interface_current",
      "network_incidents",
      "network_command_events",
      "network_worker_heartbeats",
    ]) {
      expect(rpcSql).toMatch(new RegExp(`ALTER PUBLICATION supabase_realtime ADD TABLE public\\.${table}`, "i"));
    }
    for (const table of [
      "network_device_connections",
      "network_device_samples",
      "network_interface_samples",
      "network_client_links",
      "network_config_snapshots",
      "network_audit_events",
      "network_outbox_events",
      "network_commands",
    ]) {
      expect(rpcSql).not.toMatch(new RegExp(`ALTER PUBLICATION supabase_realtime ADD TABLE public\\.${table}`, "i"));
    }
    expect(rpcSql).toMatch(
      /ALTER PUBLICATION supabase_realtime DROP TABLE public\.network_commands/i,
    );
  });
});

describe("Network Center worker identity hardening migration", () => {
  it("exists as an additive forward transaction", () => {
    expect(
      existsSync(workerIdentityMigrationPath),
      `Missing migration: ${workerIdentityMigrationPath}`,
    ).toBe(true);
    expect(workerIdentitySql.match(/^BEGIN;$/gim)).toHaveLength(1);
    expect(workerIdentitySql.match(/^COMMIT;$/gim)).toHaveLength(1);
    expect(workerIdentitySql).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/i);
  });

  it("keeps the worker registry inert behind RLS and service-role RPCs", () => {
    for (const table of [
      "network_workers",
      "network_worker_credentials",
      "network_worker_assignments",
    ]) {
      expect(workerIdentitySql).toContain(`public.${table}`);
      expect(workerIdentitySql).toMatch(
        new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, "i"),
      );
      expect(workerIdentitySql).toMatch(
        new RegExp(
          `REVOKE\\s+ALL\\s+ON\\s+TABLE\\s+public\\.${table}\\s+FROM\\s+PUBLIC,\\s*anon,\\s*authenticated,\\s*service_role`,
          "i",
        ),
      );
    }
    expect(workerIdentitySql).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|ALL)\s+ON\s+TABLE/i);
  });
});

describe("Network Center resource lifecycle hardening migration", () => {
  it("is additive, transactional and preserves direct execution without approval", () => {
    expect(
      existsSync(resourceLifecycleMigrationPath),
      `Missing migration: ${resourceLifecycleMigrationPath}`,
    ).toBe(true);
    expect(resourceLifecycleSql.match(/^BEGIN;$/gim)).toHaveLength(1);
    expect(resourceLifecycleSql.match(/^COMMIT;$/gim)).toHaveLength(1);
    expect(resourceLifecycleSql).toMatch(/network_center_enqueue_command_v1/i);
    expect(resourceLifecycleSql).not.toMatch(
      /pending_approval|approved_by|rejected_by|maker_checker/i,
    );
  });
});
