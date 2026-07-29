import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729131000_network_center_resource_lifecycle.sql",
);
const sql = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8").replace(/\r\n/g, "\n")
  : "";

function functionBody(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return sql.match(
    new RegExp(
      `CREATE OR REPLACE FUNCTION\\s+(?:public|app_private)\\.${escaped}\\b[\\s\\S]*?\\$fn\\$;`,
      "i",
    ),
  )?.[0] ?? "";
}

describe("Network Center resource lifecycle hardening migration", () => {
  it("exists as one additive forward transaction", () => {
    expect(existsSync(migrationPath), `Missing migration: ${migrationPath}`).toBe(true);
    expect(sql.match(/^BEGIN;$/gim)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gim)).toHaveLength(1);
    expect(sql).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/i);
  });

  it("adds canonical semantic identity and indexes every admission budget", () => {
    expect(sql).toMatch(
      /ALTER TABLE public\.network_commands[\s\S]{0,300}ADD COLUMN(?: IF NOT EXISTS)? semantic_fingerprint character\(64\)/i,
    );
    expect(sql).toMatch(/semantic_fingerprint\s*~\s*'\^\[a-f0-9\]\{64\}\$'/i);
    for (const indexPrefix of [
      "organization_id, status, created_at",
      "requested_by, status, created_at",
      "device_id, status, created_at",
      "semantic_fingerprint, created_at",
    ]) {
      expect(sql).toContain(`(${indexPrefix}`);
    }
  });

  it("serializes idempotency, semantic suppression, and all queue budgets before insert", () => {
    const enqueue = functionBody("network_center_enqueue_command_v1");
    expect(enqueue).not.toBe("");
    expect(enqueue).toMatch(/pg_advisory_xact_lock[\s\S]*network-center:org:/i);
    expect(enqueue).toMatch(/pg_advisory_xact_lock[\s\S]*network-center:actor:/i);
    expect(enqueue).toMatch(/pg_advisory_xact_lock[\s\S]*network-center:device:/i);
    const organizationLock = enqueue.indexOf("network-center:org:");
    const actorLock = enqueue.indexOf("network-center:actor:");
    const deviceLock = enqueue.indexOf("network-center:device:");
    expect(organizationLock).toBeGreaterThan(-1);
    expect(actorLock).toBeGreaterThan(organizationLock);
    expect(deviceLock).toBeGreaterThan(actorLock);
    expect(enqueue).toMatch(/semantic_fingerprint/i);
    expect(enqueue).toMatch(
      /digest\s*\(\s*convert_to\(v_semantic_material,\s*'UTF8'\),\s*'sha256'/i,
    );

    const semanticAssignment = enqueue.match(
      /v_semantic_material\s*:=([\s\S]*?);/i,
    )?.[1] ?? "";
    expect(semanticAssignment).toContain("p_action_type");
    expect(semanticAssignment).toContain("p_parameters::text");
    expect(semanticAssignment).not.toContain("p_reason");
    expect(semanticAssignment).not.toContain("p_idempotency_key");

    for (const [budget, limit] of [
      ["disruptive", 1],
      ["device", 2],
      ["actor", 8],
      ["organization", 30],
      ["device_hour", 12],
      ["actor_hour", 30],
      ["organization_hour", 120],
    ] as const) {
      expect(enqueue).toMatch(
        new RegExp(`'budget',\\s*'${budget}'[\\s\\S]{0,120}'limit',\\s*${limit}`, "i"),
      );
    }
    expect((enqueue.match(/INTERVAL '1 hour'/gi) ?? [])).toHaveLength(3);
    expect(enqueue).toMatch(/INTERVAL '10 minutes'/i);
    expect(enqueue).toMatch(/REBOOT_ROUTER[\s\S]{0,500}INTERVAL '10 minutes'/i);
    expect(enqueue).toMatch(/CYCLE_ACCESS_PORT[\s\S]{0,500}INTERVAL '2 minutes'/i);
    expect(enqueue).toMatch(/FLUSH_DNS_CACHE[\s\S]{0,700}INTERVAL '30 seconds'/i);
    expect(enqueue).toMatch(/CAPTURE_SNAPSHOT[\s\S]{0,500}INTERVAL '60 seconds'/i);
    for (const code of [
      "NETWORK_CENTER_DUPLICATE_INTENT",
      "NETWORK_CENTER_DEVICE_BUSY",
      "NETWORK_CENTER_ACTOR_QUEUE_LIMIT",
      "NETWORK_CENTER_ORG_QUEUE_LIMIT",
      "NETWORK_CENTER_RATE_LIMIT",
      "NETWORK_CENTER_COOLDOWN",
    ]) {
      expect(enqueue).toContain(code);
    }
    expect(enqueue).toMatch(/INSERT INTO public\.network_commands/i);
  });

  it("uses the action cooldown for semantic conflicts and never replays a different intent", () => {
    const enqueue = functionBody("network_center_enqueue_command_v1");
    const cooldownAssignment = enqueue.indexOf("v_cooldown := CASE p_action_type");
    const semanticLookup = enqueue.indexOf(
      "WHERE command.semantic_fingerprint = v_semantic_fingerprint",
    );
    const deviceBudget = enqueue.indexOf(
      "IF p_action_type IN ('CYCLE_ACCESS_PORT', 'REBOOT_ROUTER')",
    );

    expect(cooldownAssignment).toBeGreaterThan(-1);
    expect(semanticLookup).toBeGreaterThan(cooldownAssignment);
    expect(deviceBudget).toBeGreaterThan(semanticLookup);

    const semanticConflict = enqueue.slice(semanticLookup, deviceBudget);
    expect(semanticConflict).toMatch(
      /created_at\s*>=\s*v_now\s*-\s*v_cooldown/i,
    );
    expect(semanticConflict).not.toMatch(/INTERVAL '10 minutes'/i);
    expect(semanticConflict).not.toMatch(/RETURN\s+v_existing\.id/i);
    expect(semanticConflict).toContain("NETWORK_CENTER_DUPLICATE_INTENT");
    expect(semanticConflict).toContain("NETWORK_CENTER_COOLDOWN");
  });

  it("replays a committed request before mutable router eligibility is re-evaluated", () => {
    const execute = functionBody("network_center_execute_action_v1");
    const snapshot = functionBody("network_center_request_snapshot_v1");
    expect(execute).not.toBe("");
    expect(snapshot).not.toBe("");

    const executeReplay = execute.indexOf("network_center_request_replay_v1");
    expect(executeReplay).toBeGreaterThan(-1);
    for (const mutableCheck of [
      "device.write_capability",
      "network_site_settings",
      "p_confirmation IS DISTINCT FROM v_identity",
      "SELECT interface.* INTO v_interface",
    ]) {
      expect(execute.indexOf(mutableCheck)).toBeGreaterThan(executeReplay);
    }

    const snapshotReplay = snapshot.indexOf("network_center_request_replay_v1");
    expect(snapshotReplay).toBeGreaterThan(-1);
    expect(snapshot.indexOf("device.write_capability")).toBeGreaterThan(snapshotReplay);
    expect(snapshot.indexOf("connection.is_enabled")).toBeGreaterThan(snapshotReplay);
  });

  it("starts cooldowns after admission locks and scopes port cooldown to the immutable target", () => {
    const enqueue = functionBody("network_center_enqueue_command_v1");
    const deviceLock = enqueue.indexOf("network-center:device:");
    const postLockNow = enqueue.indexOf("v_now := clock_timestamp()", deviceLock);
    const semanticLookup = enqueue.indexOf(
      "WHERE command.semantic_fingerprint = v_semantic_fingerprint",
    );
    expect(deviceLock).toBeGreaterThan(-1);
    expect(postLockNow).toBeGreaterThan(deviceLock);
    expect(semanticLookup).toBeGreaterThan(postLockNow);
    expect(enqueue).toMatch(
      /semantic_fingerprint,\s*available_at,\s*created_at,\s*updated_at[\s\S]{0,500}v_semantic_fingerprint,\s*p_available_at,\s*v_now,\s*v_now/i,
    );
    expect(enqueue).toMatch(
      /command\.device_id\s*=\s*p_device_id[\s\S]{0,300}command\.action_type\s*=\s*p_action_type[\s\S]{0,300}p_action_type\s*<>\s*'CYCLE_ACCESS_PORT'[\s\S]{0,200}command\.interface_id\s*=\s*p_interface_id/i,
    );

    for (const indexPrefix of [
      "organization_id, created_at",
      "requested_by, created_at",
      "device_id, created_at",
    ]) {
      expect(sql).toContain(`(${indexPrefix}`);
    }
  });

  it("bounds client history to 16 values and expires sessions in indexed tenant batches", () => {
    expect(sql).toMatch(
      /CREATE INDEX[\s\S]{0,220}network_client_sessions[\s\S]{0,220}\(organization_id, last_seen_at, id\)/i,
    );
    const compact = functionBody("network_center_compact_client_history_v1");
    expect(compact).toMatch(/jsonb_array_elements[\s\S]{0,500}WITH ORDINALITY/i);
    expect(compact).toMatch(/v_count\s*>=\s*16/i);
    expect(sql).toMatch(
      /BEFORE INSERT OR UPDATE OF address_history ON public\.network_client_sessions/i,
    );

    const retention = functionBody("network_center_retention_v1");
    expect(retention).toMatch(/network_client_sessions[\s\S]{0,800}INTERVAL '90 days'/i);
    expect(retention).toMatch(/network_client_sessions[\s\S]{0,1000}LIMIT\s+1000/i);
    expect(retention).toMatch(/FOR UPDATE SKIP LOCKED/i);

    expect(sql).toMatch(
      /DO \$history_backfill\$[\s\S]*network_client_sessions[\s\S]*FOR UPDATE SKIP LOCKED[\s\S]*LIMIT\s+1000[\s\S]*SET address_history\s*=\s*session\.address_history[\s\S]*\$history_backfill\$;/i,
    );
  });

  it("bounds hourly and daily rollup retention by tenant and indexed timestamp", () => {
    expect(sql).toMatch(
      /ON public\.network_metric_hourly\s*\(\s*organization_id,\s*bucket_hour,\s*building_id/i,
    );
    expect(sql).toMatch(
      /ON public\.network_sla_daily\s*\(\s*organization_id,\s*sla_day,\s*building_id/i,
    );

    const retention = functionBody("network_center_retention_v1");
    expect(retention).toMatch(
      /network_metric_hourly[\s\S]{0,1400}FOR UPDATE SKIP LOCKED[\s\S]{0,240}LIMIT\s+5000[\s\S]{0,500}DELETE FROM public\.network_metric_hourly/i,
    );
    expect(retention).toMatch(
      /network_sla_daily[\s\S]{0,1200}FOR UPDATE SKIP LOCKED[\s\S]{0,240}LIMIT\s+1000[\s\S]{0,500}DELETE FROM public\.network_sla_daily/i,
    );
  });

  it("purges only terminal 180-day commands after an append-only sanitized summary", () => {
    const retention = functionBody("network_center_retention_v1");
    expect(retention).toMatch(/FROM public\.network_commands command/i);
    expect(retention).toMatch(
      /status\s+IN\s*\(\s*'SUCCEEDED',\s*'FAILED',\s*'CANCELLED_BY_KILL_SWITCH'\s*\)/i,
    );
    expect(retention).toMatch(/finished_at\s*<\s*p_now\s*-\s*INTERVAL '180 days'/i);
    expect(retention).not.toMatch(/status\s*=\s*'UNCERTAIN'[\s\S]{0,300}DELETE/i);
    expect(retention).toMatch(/INSERT INTO public\.network_audit_events/i);
    expect(retention).toMatch(/'command\.retention_summary'/i);
    expect(retention).toMatch(/DELETE FROM public\.network_command_events/i);
    expect(retention).toMatch(/DELETE FROM public\.network_command_attempts/i);
    expect(retention).toMatch(/DELETE FROM public\.network_commands/i);
    expect(retention).not.toMatch(/DELETE FROM public\.network_audit_events/i);
    expect(retention).toMatch(/LIMIT\s+100/i);
    expect(sql).toMatch(
      /ON public\.network_commands\s*\(\s*organization_id,\s*finished_at,\s*id\s*\)[\s\S]{0,240}WHERE status IN \(\s*'SUCCEEDED',\s*'FAILED',\s*'CANCELLED_BY_KILL_SWITCH'\s*\)/i,
    );
    const summaryIndex = sql.match(
      /CREATE UNIQUE INDEX IF NOT EXISTS network_audit_events_retention_summary_uidx[\s\S]*?;/i,
    )?.[0] ?? "";
    expect(summaryIndex).not.toBe("");
    expect(summaryIndex).toContain("ON public.network_audit_events");
    expect(summaryIndex).toContain("actor_type = 'SYSTEM'");
    expect(summaryIndex).toContain("action = 'command.retention_summary'");
    expect(summaryIndex).toContain("outcome = 'OBSERVED'");
    expect(retention).toMatch(
      /audit\.actor_type\s*=\s*'SYSTEM'[\s\S]{0,500}audit\.outcome\s*=\s*'OBSERVED'[\s\S]{0,500}audit\.result\s*->>\s*'terminalStatus'\s*=\s*command\.status/i,
    );
    expect(retention).toMatch(
      /RAISE EXCEPTION 'Canonical command retention summary is missing'[\s\S]{0,120}ERRCODE\s*=\s*'55000'/i,
    );
    for (const [table, columns] of [
      ["network_device_leases", "command_id"],
      ["network_config_snapshots", "organization_id, building_id, command_id"],
      ["network_audit_events", "organization_id, building_id, command_id"],
    ] as const) {
      expect(sql).toMatch(
        new RegExp(
          `ON public\\.${table}\\s*\\(\\s*${columns.replaceAll(" ", "\\s*")}\\s*\\)`,
          "i",
        ),
      );
    }
  });

  it("binds the transaction-local retention escape hatch to a private backend transaction context", () => {
    const eventGuard = functionBody("network_center_guard_command_events_v2");
    const evidenceGuard = functionBody("network_center_guard_command_evidence_v2");
    const retention = functionBody("network_center_retention_v1");
    expect(sql).toMatch(
      /CREATE TABLE(?: IF NOT EXISTS)? app_private\.network_center_command_retention_contexts/i,
    );
    expect(sql).toMatch(/backend_pid\s+integer\s+NOT NULL/i);
    expect(sql).toMatch(/transaction_id\s+bigint\s+NOT NULL/i);
    expect(eventGuard).toMatch(
      /current_setting\(\s*'app_private\.network_center_command_retention'/i,
    );
    expect(eventGuard).toMatch(/app_private\.network_center_command_retention_contexts/i);
    expect(eventGuard).toMatch(/pg_backend_pid\(\)/i);
    expect(eventGuard).toMatch(/txid_current\(\)/i);
    expect(eventGuard).toMatch(/TG_OP\s*=\s*'DELETE'/i);
    expect(evidenceGuard).toMatch(/app_private\.network_center_command_retention_contexts/i);
    expect(evidenceGuard).toMatch(/pg_backend_pid\(\)/i);
    expect(evidenceGuard).toMatch(/txid_current\(\)/i);
    expect(evidenceGuard).toMatch(/OLD\.command_id\s+IS NOT NULL/i);
    expect(evidenceGuard).toMatch(/NEW\.command_id\s+IS NULL/i);
    expect(evidenceGuard).toMatch(
      /to_jsonb\(NEW\)\s*-\s*'command_id'[\s\S]{0,160}IS NOT DISTINCT FROM[\s\S]{0,160}to_jsonb\(OLD\)\s*-\s*'command_id'/i,
    );
    expect(retention).toMatch(
      /INSERT INTO app_private\.network_center_command_retention_contexts/i,
    );
    expect(retention).toMatch(
      /set_config\(\s*'app_private\.network_center_command_retention',\s*'on',\s*true\s*\)/i,
    );
    expect(retention).toMatch(
      /DELETE FROM app_private\.network_center_command_retention_contexts/i,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON TABLE app_private\.network_center_command_retention_contexts\s+FROM PUBLIC, anon, authenticated, service_role/i,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION app_private\.network_center_retention_v1\(\s*timestamp with time zone\s*\)\s*FROM PUBLIC, anon, authenticated, service_role/i,
    );
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION app_private\.network_center_retention_v1/i);
  });
});
