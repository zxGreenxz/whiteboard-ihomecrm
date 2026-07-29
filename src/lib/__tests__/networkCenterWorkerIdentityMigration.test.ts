import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260729130000_network_center_worker_identity.sql",
);

const sql = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8").replace(/\r\n/g, "\n")
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
