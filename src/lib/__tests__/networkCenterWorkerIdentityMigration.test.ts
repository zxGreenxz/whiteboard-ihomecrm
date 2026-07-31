import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729130000_network_center_worker_identity.sql",
);
const hardeningMigrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729133000_network_center_hardening_rpcs.sql",
);

const sql = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8").replace(/\r\n/g, "\n")
  : "";
const hardeningSql = existsSync(hardeningMigrationPath)
  ? readFileSync(hardeningMigrationPath, "utf8").replace(/\r\n/g, "\n")
  : "";

function sqlFunctionBody(functionName: string): string {
  const start = sql.search(
    new RegExp(
      `CREATE OR REPLACE FUNCTION\\s+(?:public|app_private)\\.${functionName}\\b`,
      "i",
    ),
  );
  if (start < 0) return "";
  const next = sql
    .slice(start + 1)
    .search(/CREATE OR REPLACE FUNCTION\s+(?:public|app_private)\./i);
  return next < 0 ? sql.slice(start) : sql.slice(start, start + 1 + next);
}

function hardeningFunctionBody(functionName: string): string {
  const start = hardeningSql.search(
    new RegExp(
      `CREATE OR REPLACE FUNCTION\\s+(?:public|app_private)\\.${functionName}\\b`,
      "i",
    ),
  );
  if (start < 0) return "";
  const next = hardeningSql
    .slice(start + 1)
    .search(/CREATE OR REPLACE FUNCTION\s+(?:public|app_private)\./i);
  return next < 0
    ? hardeningSql.slice(start)
    : hardeningSql.slice(start, start + 1 + next);
}

describe("Network Center per-worker identity migration", () => {
  it("creates principals, verifier-only credentials and device assignments", () => {
    expect(existsSync(migrationPath), `Missing migration: ${migrationPath}`).toBe(true);
    for (const table of [
      "network_workers",
      "network_worker_credentials",
      "network_worker_assignments",
    ]) {
      expect(sql).toContain(`public.${table}`);
    }

    expect(sql).toMatch(/worker_key\s+text\s+NOT NULL\s+UNIQUE/i);
    expect(sql).toMatch(/status\s+text[\s\S]{0,160}'ACTIVE'[\s\S]{0,160}'DRAINING'[\s\S]{0,160}'DISABLED'/i);
    expect(sql).toMatch(/version\s+bigint\s+NOT NULL\s+DEFAULT\s+1/i);
    expect(sql).toMatch(/secret_digest\s+(?:text|character\(64\))\s+NOT NULL/i);
    expect(sql).toMatch(/UNIQUE\s*\(secret_digest\)/i);
    expect(sql).toMatch(/secret_digest\s*~\s*'\^\[a-f0-9\]\{64\}\$'/i);
    expect(sql).not.toMatch(/plaintext_secret|worker_secret\s+text|secret_value/i);

    expect(sql).toMatch(/FOREIGN KEY\s*\(organization_id,\s*building_id\)/i);
    const deviceIdentityKey = sql.search(
      /ALTER TABLE public\.network_devices[\s\S]{0,240}UNIQUE\s*\(organization_id,\s*building_id,\s*id,\s*device_kind\)/i,
    );
    const assignmentTable = sql.search(
      /CREATE TABLE public\.network_worker_assignments/i,
    );
    expect(deviceIdentityKey).toBeGreaterThanOrEqual(0);
    expect(deviceIdentityKey).toBeLessThan(assignmentTable);
    expect(sql).toMatch(
      /device_kind\s+text\s+NOT NULL[\s\S]{0,100}CHECK\s*\(device_kind\s*=\s*'MIKROTIK'\)/i,
    );
    expect(sql).toMatch(
      /FOREIGN KEY\s*\(organization_id,\s*building_id,\s*device_id,\s*device_kind\)[\s\S]{0,180}REFERENCES public\.network_devices\s*\(organization_id,\s*building_id,\s*id,\s*device_kind\)/i,
    );
    expect(sql).toMatch(
      /CREATE INDEX[\s\S]{0,180}ON public\.network_worker_assignments\s*\(organization_id,\s*building_id,\s*device_id,\s*device_kind\)/i,
    );
    expect(sql).toMatch(/CREATE INDEX[\s\S]{0,180}ON public\.network_worker_assignments\s*\(worker_id,/i);
    expect(sql).toMatch(/CREATE UNIQUE INDEX[\s\S]{0,260}network_worker_assignments[\s\S]{0,260}can_poll[\s\S]{0,160}active_until IS NULL/i);
    expect(sql).toMatch(/active_until\s+IS NULL\s+OR\s+active_until\s*>\s*active_from/i);
  });

  it("authenticates one active principal from a digest without exposing verifier data", () => {
    const body = sqlFunctionBody("network_center_authenticate_worker_v2");
    expect(body).toMatch(/p_secret_digest\s+text/i);
    expect(body).toMatch(/network_worker_credentials/i);
    expect(body).toMatch(/network_workers/i);
    expect(body).toMatch(/revoked_at\s+IS NULL/i);
    expect(body).toMatch(/not_before\s*<=/i);
    expect(body).toMatch(/expires_at\s*>/i);
    expect(body).toMatch(/status\s+IN\s*\('ACTIVE',\s*'DRAINING'\)/i);
    expect(body).toMatch(/worker_id/i);
    expect(body).toMatch(/capabilities/i);
    expect(body).not.toMatch(/RETURNS[\s\S]{0,180}(secret_digest|fingerprint)/i);
    expect(body).not.toMatch(/FOR UPDATE OF\s+credential/i);
    expect(body).toMatch(
      /last_used_at\s+IS NULL[\s\S]{0,120}last_used_at\s*<\s*v_now\s*-\s*INTERVAL '5 minutes'/i,
    );
  });

  it("provides bounded service-role-only provision, rotate, revoke and assignment RPCs", () => {
    const adminFunctions = [
      "network_center_admin_provision_worker_v1",
      "network_center_admin_rotate_worker_credential_v1",
      "network_center_admin_revoke_worker_credential_v1",
      "network_center_admin_set_worker_assignments_v1",
    ];

    for (const functionName of adminFunctions) {
      const body = sqlFunctionBody(functionName);
      expect(body, `Missing ${functionName}`).not.toBe("");
      expect(body).toMatch(/SECURITY DEFINER/i);
      expect(body).toMatch(/SET search_path TO 'pg_catalog'/i);
      expect(sql).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${functionName}\\([\\s\\S]{0,600}?FROM PUBLIC, anon, authenticated, service_role`,
          "i",
        ),
      );
      expect(sql).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${functionName}\\([\\s\\S]{0,600}?TO service_role`,
          "i",
        ),
      );
    }

    const provision = sqlFunctionBody("network_center_admin_provision_worker_v1");
    const assignments = sqlFunctionBody("network_center_admin_set_worker_assignments_v1");
    expect(provision).toMatch(/p_assignments\s+IS NULL/i);
    expect(provision).toMatch(
      /jsonb_typeof\(p_assignments\)\s+IS DISTINCT FROM\s+'array'/i,
    );
    expect(provision).toMatch(/jsonb_array_length\(p_assignments\)\s+NOT BETWEEN\s+1\s+AND\s+100/i);
    expect(assignments).toMatch(/p_assignments\s+IS NULL/i);
    expect(assignments).toMatch(
      /jsonb_typeof\(p_assignments\)\s+IS DISTINCT FROM\s+'array'/i,
    );
    expect(assignments).toMatch(/jsonb_array_length\(p_assignments\)\s*>\s*100/i);
  });

  it("accepts only current assignment state and closes history server-side", () => {
    const replace = sqlFunctionBody(
      "network_center_replace_worker_assignments_v1",
    );

    expect(replace).toMatch(/p_assignments\s+IS NULL/i);
    expect(replace).toMatch(
      /jsonb_typeof\(p_assignments\)\s+IS DISTINCT FROM\s+'array'/i,
    );
    expect(replace).toMatch(/jsonb_object_keys\(v_item\)/i);
    for (const key of [
      "organizationId",
      "buildingId",
      "deviceId",
      "canPoll",
      "canInventory",
      "canExecute",
    ]) {
      expect(replace).toContain(`'${key}'`);
    }
    expect(replace).not.toMatch(/v_item\s*->>\s*'active(?:From|Until)'/i);
    expect(replace).toMatch(
      /active_until\s*=\s*greatest\(v_now,\s*assignment\.active_from\s*\+\s*INTERVAL '1 microsecond'\)/i,
    );
    expect(replace).toMatch(
      /INSERT INTO public\.network_worker_assignments[\s\S]{0,600}active_from,\s*active_until[\s\S]{0,600}v_now,\s*NULL/i,
    );
  });

  it("bounds credential lifetime and overlap while allowing independent revocation", () => {
    const provision = sqlFunctionBody("network_center_admin_provision_worker_v1");
    const rotate = sqlFunctionBody("network_center_admin_rotate_worker_credential_v1");
    const revoke = sqlFunctionBody("network_center_admin_revoke_worker_credential_v1");

    expect(provision).toMatch(/INTERVAL '90 days'/i);
    expect(rotate).toMatch(/INTERVAL '90 days'/i);
    expect(rotate).toMatch(/INTERVAL '24 hours'/i);
    expect(rotate).toMatch(/worker_id\s*=\s*v_worker_id/i);
    expect(rotate).toMatch(
      /credential\.not_before\s*>\s*p_not_before[\s\S]{0,240}already scheduled/i,
    );
    expect(rotate).toMatch(
      /UPDATE public\.network_worker_credentials[\s\S]{0,500}credential\.not_before\s*<=\s*p_not_before/i,
    );
    expect(rotate.indexOf("already scheduled")).toBeLessThan(
      rotate.indexOf("UPDATE public.network_worker_credentials"),
    );
    expect(revoke).toMatch(/worker_id\s*=\s*v_worker_id/i);
    expect(revoke).toMatch(/fingerprint\s*=\s*p_fingerprint/i);
    expect(revoke).toMatch(/revoked_at\s*=\s*clock_timestamp\(\)/i);
    expect(revoke).not.toMatch(/DELETE FROM public\.network_worker_credentials/i);
  });

  it("revokes all direct table access and keeps the private auth helper private", () => {
    for (const table of [
      "network_workers",
      "network_worker_credentials",
      "network_worker_assignments",
    ]) {
      expect(sql).toMatch(
        new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, "i"),
      );
      expect(sql).toMatch(
        new RegExp(
          `REVOKE\\s+ALL\\s+ON\\s+TABLE\\s+public\\.${table}\\s+FROM\\s+PUBLIC,\\s*anon,\\s*authenticated,\\s*service_role`,
          "i",
        ),
      );
    }
    expect(sql).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+app_private\.network_center_authenticate_worker_v2\(text\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated,\s*service_role/i,
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION app_private\.network_center_authenticate_worker_v2\(text\)/i,
    );
  });
});

describe("Network Center assignment-scoped worker RPC hardening", () => {
  const routeFunctions = [
    "network_center_worker_heartbeat_v2",
    "network_center_worker_list_connections_v2",
    "network_center_worker_claim_v2",
    "network_center_worker_renew_v2",
    "network_center_worker_ingest_v2",
    "network_center_worker_inventory_v2",
    "network_center_worker_command_event_v2",
    "network_center_worker_observe_v2",
    "network_center_worker_complete_v2",
    "network_center_worker_upsert_incident_v2",
    "network_center_worker_snapshot_v2",
    "network_center_worker_maintenance_v2",
  ] as const;

  it("creates the additive hardening migration and authenticates every worker route from the credential digest", () => {
    expect(
      existsSync(hardeningMigrationPath),
      `Missing migration: ${hardeningMigrationPath}`,
    ).toBe(true);

    for (const functionName of routeFunctions) {
      const body = hardeningFunctionBody(functionName);
      expect(body, `Missing ${functionName}`).not.toBe("");
      expect(body).toMatch(/p_credential_digest\s+text/i);
      expect(body).toMatch(/network_center_authenticate_worker_v2/i);
      expect(body).toMatch(/SECURITY DEFINER/i);
      expect(body).toMatch(/SET search_path TO 'pg_catalog'/i);
      expect(hardeningSql).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${functionName}\\([\\s\\S]{0,800}?FROM PUBLIC, anon, authenticated, service_role`,
          "i",
        ),
      );
      expect(hardeningSql).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${functionName}\\([\\s\\S]{0,800}?TO service_role`,
          "i",
        ),
      );
    }
  });

  it("checks an active explicit assignment and the registry operation capability at every final target", () => {
    const helper = hardeningFunctionBody(
      "network_center_worker_can_access_device_v2",
    );
    expect(helper).toMatch(/network_worker_assignments/i);
    expect(helper).toMatch(/worker_id\s*=\s*p_worker_id/i);
    expect(helper).toMatch(/organization_id\s*=\s*p_organization_id/i);
    expect(helper).toMatch(/building_id\s*=\s*p_building_id/i);
    expect(helper).toMatch(/device_id\s*=\s*p_device_id/i);
    expect(helper).toMatch(/active_from\s*<=\s*p_now/i);
    expect(helper).toMatch(/active_until\s+IS NULL[\s\S]{0,100}active_until\s*>\s*p_now/i);
    expect(helper).toMatch(/HEARTBEAT|POLL|TELEMETRY|INVENTORY|EXECUTE|INCIDENT|SNAPSHOT|MAINTENANCE/);
    expect(helper).toMatch(/network_workers/i);
    expect(helper).toMatch(/status\s+IN\s*\('ACTIVE',\s*'DRAINING'\)/i);
    expect(helper).toMatch(/p_required_capability\s*=\s*ANY\(worker\.capabilities\)/i);

    for (const functionName of routeFunctions.slice(3)) {
      const body = hardeningFunctionBody(functionName);
      expect(
        body,
        `${functionName} must resolve and authorize its final target`,
      ).toMatch(/network_center_worker_can_access_(?:device|building)_v2/i);
    }

    expect(hardeningFunctionBody("network_center_worker_list_connections_v2"))
      .toMatch(/JOIN public\.network_worker_assignments/i);
    expect(hardeningFunctionBody("network_center_worker_claim_v2"))
      .toMatch(/network_worker_assignments[\s\S]{0,500}can_execute/i);
    expect(hardeningFunctionBody("network_center_worker_renew_v2"))
      .toMatch(/network_commands[\s\S]*?network_center_worker_can_access_device_v2/i);

    const requiredCapability = new Map<string, RegExp>([
      ["network_center_worker_heartbeat_v2", /'HEARTBEAT'/],
      ["network_center_worker_list_connections_v2", /'POLL'/],
      ["network_center_worker_claim_v2", /'EXECUTE'/],
      ["network_center_worker_renew_v2", /'EXECUTE'/],
      ["network_center_worker_ingest_v2", /'TELEMETRY'/],
      ["network_center_worker_inventory_v2", /'INVENTORY'/],
      ["network_center_worker_command_event_v2", /'EXECUTE'/],
      ["network_center_worker_observe_v2", /'EXECUTE'/],
      ["network_center_worker_complete_v2", /'EXECUTE'/],
      ["network_center_worker_upsert_incident_v2", /'INCIDENT'/],
      ["network_center_worker_snapshot_v2", /'SNAPSHOT'/],
      ["network_center_worker_maintenance_v2", /'MAINTENANCE'/],
    ]);
    for (const [functionName, capability] of requiredCapability) {
      expect(hardeningFunctionBody(functionName)).toMatch(capability);
    }
  });

  it("keeps v1 only behind one expiring snapshot principal and a one-way finalizer", () => {
    const legacyFunctions = [
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
    ];

    for (const functionName of legacyFunctions) {
      expect(hardeningSql).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${functionName}\\([\\s\\S]{0,800}?FROM PUBLIC, anon, authenticated`,
          "i",
        ),
      );
      expect(hardeningFunctionBody(functionName)).toMatch(
        /network_center_compatibility_worker_v1/i,
      );
      expect(hardeningFunctionBody(functionName)).not.toMatch(
        /\bp_worker_id\s*:=|WHERE\s+worker_id\s*=\s*p_worker_id/i,
      );
      expect(hardeningSql).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${functionName}\\([\\s\\S]{0,800}?TO service_role`,
          "i",
        ),
      );
    }

    expect(hardeningSql).toMatch(
      /CREATE TABLE app_private\.network_worker_compatibility_state/i,
    );
    expect(hardeningSql).toMatch(/expires_at\s*<=\s*activated_at\s*\+\s*INTERVAL '7 days'/i);
    expect(hardeningSql).toMatch(/assignment_snapshot\s+jsonb/i);
    expect(hardeningSql).toMatch(/can_execute[\s\S]{0,120}false/i);
    expect(hardeningFunctionBody(
      "network_center_compatibility_can_access_device_v1",
    )).not.toMatch(/device_id\s+IS\s+NULL|p_device_id\s+IS\s+NULL/i);
    expect(hardeningFunctionBody("network_center_worker_claim_v1")).toMatch(
      /jsonb_build_object\(\s*'items',\s*'\[\]'::jsonb\s*\)/i,
    );

    const finalizer = hardeningFunctionBody(
      "network_center_admin_finalize_worker_compatibility_v1",
    );
    expect(finalizer).toMatch(/finalized_at\s*=\s*v_now/i);
    expect(finalizer).toMatch(/status\s*=\s*'DISABLED'/i);
    expect(finalizer).toMatch(/active_until\s*=\s*greatest/i);
    expect(finalizer).toMatch(/REVOKE EXECUTE ON FUNCTION public\.network_center_worker_heartbeat_v1/i);
    expect(hardeningSql).toMatch(
      /REVOKE ALL ON FUNCTION\s+public\.network_center_admin_finalize_worker_compatibility_v1\(\)[\s\S]{0,300}FROM PUBLIC, anon, authenticated, service_role/i,
    );
    expect(hardeningSql).toMatch(
      /GRANT EXECUTE ON FUNCTION\s+public\.network_center_admin_finalize_worker_compatibility_v1\(\)[\s\S]{0,120}TO service_role/i,
    );
  });

  it("filters claim candidates before leasing and revalidates managed targets", () => {
    const body = hardeningFunctionBody("network_center_worker_claim_v2");
    const reclaim = hardeningFunctionBody(
      "network_center_reclaim_expired_commands_v2",
    );
    expect(reclaim).toMatch(/network_worker_assignments/i);
    expect(reclaim).toMatch(/can_execute/i);
    expect(reclaim).toMatch(/lease_expires_at\s*<=\s*p_now/i);
    expect(body).toMatch(/network_center_reclaim_expired_commands_v2/i);
    expect(body.indexOf("network_center_reclaim_expired_commands_v2")).toBeLessThan(
      body.indexOf("FOR v_candidate IN"),
    );
    const assignment = body.search(/network_worker_assignments/i);
    const leaseMutation = body.search(/INSERT INTO public\.network_device_leases/i);
    expect(assignment).toBeGreaterThanOrEqual(0);
    expect(leaseMutation).toBeGreaterThan(assignment);
    expect(body).toMatch(/can_execute/i);
    expect(body).toMatch(/worker\.status\s*=\s*'ACTIVE'/i);
    expect(body).not.toMatch(/worker\.status\s+IN\s*\('ACTIVE',\s*'DRAINING'\)/i);
    expect(body).toMatch(/'EXECUTE'\s*=\s*ANY\(worker\.capabilities\)/i);
    expect(body).toMatch(/network_managed_resources/i);
    expect(body).toMatch(/enrollment_state\s*=\s*'ENROLLED'/i);
    expect(body).toMatch(/protected\s*=\s*false/i);
  });

  it("fences command writers and delegates observations and outcomes to typed private helpers", () => {
    for (const functionName of [
      "network_center_worker_renew_v2",
      "network_center_worker_command_event_v2",
      "network_center_worker_observe_v2",
      "network_center_worker_complete_v2",
    ]) {
      const body = hardeningFunctionBody(functionName);
      expect(body).toMatch(/p_fencing_generation\s+bigint/i);
      expect(body).toMatch(/network_device_leases/i);
      expect(body).toMatch(/lease_owner\s*=\s*v_worker_key/i);
      expect(body).toMatch(/lease_token\s*=\s*p_lease_token/i);
      expect(body).toMatch(/generation\s*=\s*p_fencing_generation/i);
    }
    expect(hardeningFunctionBody("network_center_worker_observe_v2"))
      .toMatch(/network_center_record_command_observation_v1/i);
    const complete = hardeningFunctionBody("network_center_worker_complete_v2");
    expect(complete).toMatch(/network_center_transition_command_v1/i);
    expect(complete).toMatch(/v_outcome[\s\S]{0,300}NOT IN[\s\S]{0,300}EVALUATE_POSTCONDITION/i);
    expect(complete).not.toMatch(/'SUCCEEDED'\s*,/i);
  });

  it("authorizes every ingest target before invoking the all-or-nothing telemetry writer", () => {
    const body = hardeningFunctionBody("network_center_worker_ingest_v2");
    expect(body).toMatch(/p_payload->'devices'/i);
    expect(body).toMatch(/p_payload->'interfaces'/i);
    expect(body).toMatch(/p_payload->'clients'/i);
    expect(body).toMatch(/network_center_worker_can_access_device_v2/i);
    expect(body).toMatch(/unauthorized telemetry target/i);
    expect(body.indexOf("network_center_worker_ingest_legacy_impl_v1")).toBeGreaterThan(
      body.indexOf("unauthorized telemetry target"),
    );
  });

  it("preserves inventory quarantine fields and replaces only the managed interface mapping", () => {
    const body = hardeningFunctionBody("network_center_worker_inventory_v2");
    expect(body).toMatch(/network_center_worker_inventory_legacy_impl_v1/i);
    expect(body).toMatch(/network_center_managed_interface_mapping_v1/i);
    expect(body).toMatch(/jsonb_set\([\s\S]{0,300}'\{interfaces\}'/i);
    expect(body).not.toMatch(/-\s*'inventoryStatus'|-\s*'quarantinedCount'/i);
  });

  it("keeps maintenance assignment-scoped instead of invoking fleet maintenance", () => {
    const body = hardeningFunctionBody("network_center_worker_maintenance_v2");
    expect(body).toMatch(/network_worker_assignments/i);
    expect(body).toMatch(/can_poll/i);
    expect(body).toMatch(/'MAINTENANCE'/);
    expect(body).not.toMatch(/network_center_worker_maintenance_v1/i);
    expect(body).not.toMatch(/network_center_retention_v1|network_center_rollup_/i);
  });

  it("publishes only tenant-keyed worker building status and never raw heartbeat rows", () => {
    const statusTable = hardeningSql.match(
      /CREATE TABLE public\.network_worker_building_status\s*\([\s\S]*?\n\);/i,
    )?.[0] ?? "";
    expect(hardeningSql).toMatch(/public\.network_worker_building_status/i);
    expect(hardeningSql).toMatch(
      /ALTER TABLE public\.network_worker_building_status ENABLE ROW LEVEL SECURITY/i,
    );
    expect(statusTable).not.toBe("");
    expect(statusTable).not.toMatch(/safe_metadata|credential|worker_key|worker_id/i);
    expect(hardeningSql).toMatch(
      /network_worker_building_status[\s\S]{0,1600}can_do_on_building\(\s*'network_center',\s*'view',\s*building_id\s*\)/i,
    );
    expect(hardeningSql).toMatch(
      /REVOKE ALL ON TABLE public\.network_worker_heartbeats\s+FROM PUBLIC, anon, authenticated, service_role/i,
    );
    expect(hardeningSql).toMatch(
      /ALTER PUBLICATION supabase_realtime\s+DROP TABLE public\.network_worker_heartbeats/i,
    );
    expect(hardeningSql).toMatch(
      /ALTER PUBLICATION supabase_realtime\s+ADD TABLE public\.network_worker_building_status/i,
    );
  });
});
