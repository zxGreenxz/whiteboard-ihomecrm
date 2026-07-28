import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const migrationPath = resolve(
  repoRoot,
  "supabase/migrations/20260729040000_network_center_rls_rpcs_realtime.sql",
);
const telemetryMigrationPath = resolve(
  repoRoot,
  "supabase/migrations/20260729020000_network_center_current_telemetry.sql",
);
const crossTenantPath = resolve(repoRoot, "scripts/test-cross-tenant.mjs");

const migrationSql = readFileSync(migrationPath, "utf8");
const telemetrySql = readFileSync(telemetryMigrationPath, "utf8");
const crossTenantScript = readFileSync(crossTenantPath, "utf8");

function functionDefinition(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = migrationSql.match(
    new RegExp(
      `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public|app_private)\\.${escaped}\\b[\\s\\S]*?\\$fn\\$;`,
      "i",
    ),
  );

  expect(match, `Missing SQL function ${name}`).not.toBeNull();
  return match![0];
}

describe("Network Center database runtime safety", () => {
  it("creates tenant identity keys before client-link composite foreign keys", () => {
    for (const table of ["rooms", "contracts", "customers"]) {
      expect(telemetrySql).toMatch(
        new RegExp(
          `CREATE\\s+UNIQUE\\s+INDEX[\\s\\S]{0,160}?ON\\s+public\\.${table}\\s*\\(\\s*organization_id\\s*,\\s*id\\s*\\)`,
          "i",
        ),
      );
    }
  });

  it("gives active organization owners both permissions without granting staff implicitly", () => {
    expect(migrationSql).toMatch(
      /INSERT\s+INTO\s+public\.member_permission_overrides/i,
    );
    expect(migrationSql).toMatch(/member_type\s*=\s*'OWNER'/i);
    expect(migrationSql).toMatch(
      /VALUES\s*\(\s*'network_center\.view'::text\s*\)\s*,\s*\(\s*'network_center\.execute'::text\s*\)/i,
    );
    expect(migrationSql).toMatch(
      /INSERT\s+INTO\s+public\.member_override_scopes/i,
    );
  });

  it("keeps STABLE read RPC time comparisons statement-stable", () => {
    for (const name of [
      "network_center_list_fleet_v1",
      "network_center_get_building_v1",
      "network_center_list_aruba_v1",
      "network_center_list_clients_v1",
      "network_center_list_commands_v1",
      "network_center_list_audit_v1",
      "network_center_compare_snapshots_v1",
    ]) {
      const definition = functionDefinition(name);
      expect(definition).toMatch(/\bSTABLE\b/i);
      expect(definition).not.toMatch(/clock_timestamp\s*\(\s*\)/i);
    }
  });

  it("does not blindly replay an uncertain command when reconciliation is retryable", () => {
    const definition = functionDefinition("network_center_worker_complete_v1");

    expect(definition).toMatch(
      /v_command\.status\s*=\s*'RECONCILING'[\s\S]*?v_outcome\s*=\s*'RETRYABLE_FAILURE'[\s\S]*?'UNCERTAIN'/i,
    );
    expect(definition).toMatch(
      /WHEN\s+v_status\s*=\s*'UNCERTAIN'\s+THEN\s+'REQUIRED'/i,
    );
  });

  it("rejects actions and snapshots for an unprovisioned router slot", () => {
    for (const name of [
      "network_center_request_snapshot_v1",
      "network_center_execute_action_v1",
    ]) {
      const definition = functionDefinition(name);
      expect(definition).toMatch(
        /lifecycle_status\s+IN\s*\(\s*'ONLINE'\s*,\s*'OFFLINE'\s*\)/i,
      );
      expect(definition).toMatch(
        /network_device_connections[\s\S]*?is_enabled/i,
      );
    }
  });

  it("rejects secret-bearing JSON before it reaches browser-readable projections", () => {
    expect(migrationSql).toContain("app_private.network_center_assert_safe_json_v1");

    for (const name of [
      "network_center_worker_heartbeat_v1",
      "network_center_worker_command_event_v1",
      "network_center_worker_complete_v1",
      "network_center_worker_upsert_incident_v1",
      "network_center_worker_snapshot_v1",
    ]) {
      expect(functionDefinition(name)).toContain(
        "app_private.network_center_assert_safe_json_v1",
      );
    }
  });

  it("scopes worker incident replay keys to the incident organization", () => {
    const definition = functionDefinition(
      "network_center_worker_upsert_incident_v1",
    );
    const deviceLookup = definition.search(
      /SELECT\s+device\.\*\s+INTO\s+v_device/i,
    );
    const replayLookup = definition.search(
      /IF\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.network_incident_events/i,
    );

    expect(deviceLookup).toBeGreaterThanOrEqual(0);
    expect(replayLookup).toBeGreaterThan(deviceLookup);
    expect(definition).toMatch(
      /WHERE\s+event\.organization_id\s*=\s*v_device\.organization_id\s+AND\s+event\.external_event_key\s*=\s*v_event_key/i,
    );
  });

  it("preserves the last successful sighting when an offline poll has no lastSeenAt", () => {
    const definition = functionDefinition("network_center_worker_ingest_v1");

    expect(definition).toMatch(
      /last_seen_at\s*=\s*(?:greatest\s*\(\s*public\.network_device_current\.last_seen_at\s*,\s*excluded\.last_seen_at\s*\)|coalesce\s*\(\s*excluded\.last_seen_at\s*,\s*public\.network_device_current\.last_seen_at\s*\))/i,
    );
  });

  it("pins rollback-only Network Center writes to the canonical DEMO organization", () => {
    expect(crossTenantScript).toContain(
      "dddd0000-0000-4000-8000-000000000001",
    );
    expect(crossTenantScript).not.toContain(
      "dddd0000-0000-0000-0000-000000000001",
    );
    expect(crossTenantScript).toMatch(/\bDEMO_ORG_ID\b/);
    expect(crossTenantScript).toMatch(/\bROLLBACK\s*;/i);
    expect(crossTenantScript).not.toMatch(
      /session_replication_role\s*=\s*replica/i,
    );
  });
});
