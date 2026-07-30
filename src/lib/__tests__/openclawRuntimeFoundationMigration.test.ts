import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = () => readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260727015000_openclaw_security_principals.sql"),
  "utf8",
);

const tables = [
  "openclaw_accounts",
  "openclaw_account_connections",
  "openclaw_runtime_cells",
  "openclaw_runtime_leases",
  "openclaw_runtime_credentials",
  "openclaw_maintenance_principals",
  "openclaw_maintenance_leases",
  "openclaw_maintenance_credentials",
  "openclaw_qr_challenges",
] as const;

describe("OpenClaw runtime foundation migration", () => {
  it("creates every tenant-scoped principal table in one transaction", () => {
    const sql = migration();
    expect(sql.match(/^\s*begin\s*;\s*$/gim)).toHaveLength(1);
    expect(sql.match(/^\s*commit\s*;\s*$/gim)).toHaveLength(1);
    for (const table of tables) {
      expect(sql).toMatch(new RegExp(`create table public\\.${table}\\b`, "i"));
      expect(sql).toMatch(new RegExp(`alter table public\\.${table} enable row level security`, "i"));
      expect(sql).toMatch(new RegExp(`alter table public\\.${table} force row level security`, "i"));
      expect(sql).toMatch(new RegExp(`revoke all on public\\.${table} from public, anon, authenticated, service_role`, "i"));
      expect(sql).toMatch(new RegExp(`unique \\(organization_id, id\\)`, "i"));
    }
  });

  it("separates connection, risk and send-mode state", () => {
    const sql = migration();
    expect(sql).toContain("connection_state IN ('DISCONNECTED','QR_PENDING','CONNECTING','CONNECTED','DISCONNECTING','RECONNECT_REQUIRED')");
    expect(sql).toContain("session_risk_state IN ('HEALTHY','DEGRADED','LIMITED','SUSPECTED_THEFT','INVALID')");
    expect(sql).toContain("configured_mode IN ('DRAFT_ONLY','MANUAL_SEND','LIMITED_AUTO_REPLY','PROACTIVE','SALES_GROUPS')");
    expect(sql).toContain("effective_mode IN ('DRAFT_ONLY','MANUAL_SEND','LIMITED_AUTO_REPLY','PROACTIVE','SALES_GROUPS')");
    expect(sql).not.toContain("CONNECTED_DRAFT_ONLY");
  });

  it("enforces one active account and one effective generation per organization/account", () => {
    const sql = migration();
    for (const index of [
      "openclaw_accounts_one_active_per_org_uidx",
      "openclaw_connections_one_effective_uidx",
      "openclaw_runtime_cells_one_current_uidx",
      "openclaw_runtime_leases_one_effective_uidx",
      "openclaw_runtime_credentials_one_current_uidx",
      "openclaw_maintenance_principals_one_current_uidx",
      "openclaw_maintenance_leases_one_effective_uidx",
      "openclaw_maintenance_credentials_one_current_uidx",
    ]) expect(sql).toContain(index);
    expect(sql).toMatch(/foreign key \(organization_id, account_id\)/i);
    expect(sql).toMatch(/foreign key \(organization_id, account_id, cell_id\)/i);
    expect(sql).toMatch(/foreign key \(organization_id, maintenance_principal_id\)/i);
  });

  it("stores only hashed scoped workload credentials", () => {
    const sql = migration();
    expect(sql).toContain("credential_hash text NOT NULL");
    expect(sql).toContain("credential_hash ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain("allowed_scopes text[] NOT NULL");
    expect(sql).toContain("<@ ARRAY['heartbeat','qr.publish','qr.result','inbound.commit','outbox.claim','outbox.preflight','outbox.authorize-send','outbox.requeue','outbox.complete','work.claim','work.complete','media.issue']::text[]");
    expect(sql).toContain("<@ ARRAY['maintenance.claim','maintenance.complete']::text[]");
    expect(sql).not.toMatch(/plaintext|raw_secret|secret_value/i);
  });

  it("uses application-encrypted one-time QR challenges with an exact DB-clock TTL", () => {
    const sql = migration();
    expect(sql).toContain("challenge_status IN ('PENDING','CONSUMED','EXPIRED','REVOKED')");
    expect(sql).toContain("expires_at = issued_at + interval '120 seconds'");
    for (const field of [
      "ciphertext bytea",
      "cipher_iv bytea",
      "auth_tag bytea",
      "actor_id uuid",
      "auth_session_hash text",
      "browser_nonce_hash text",
      "consumed_at timestamptz",
    ]) expect(sql).toContain(field);
    expect(sql).toContain("openclaw_qr_challenges_one_pending_uidx");
    expect(sql).not.toMatch(/grant select on public\.openclaw_qr_challenges to authenticated/i);
  });

  it("creates narrow non-bypass writer roles and immutable tenant identities", () => {
    const sql = migration();
    expect(sql).toMatch(/create role openclaw_runtime_writer with NOLOGIN NOINHERIT NOBYPASSRLS/i);
    expect(sql).toMatch(/create role openclaw_maintenance_writer with NOLOGIN NOINHERIT NOBYPASSRLS/i);
    expect(sql).toContain("reject_openclaw_tenant_identity_update_v1");
    expect(sql).toContain("organization_id cannot change");
    expect(sql).toContain("account_id cannot change");
    expect(sql).toContain("maintenance_principal_id cannot change");
    expect(sql).not.toMatch(/\bBYPASSRLS\b(?!;)/i);
  });

  it("keeps connection and risk transitions append-only", () => {
    const sql = migration();
    expect(sql).toContain("reject_openclaw_append_only_v1");
    expect(sql).toMatch(/before update or delete on public\.openclaw_account_connections/i);
    expect(sql).toMatch(/grant select, insert on public\.openclaw_account_connections to openclaw_runtime_writer/i);
    expect(sql).not.toMatch(/grant[^;]*update[^;]*openclaw_account_connections[^;]*openclaw_runtime_writer/i);
  });
});
