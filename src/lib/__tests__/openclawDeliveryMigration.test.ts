import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sql = () => readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260727040000_openclaw_delivery_audit_ops.sql"),
  "utf8",
);

const tables = [
  "openclaw_outbox",
  "openclaw_outbound_authorizations",
  "openclaw_delivery_attempts",
  "openclaw_dead_letters",
  "openclaw_unknown_resolutions",
  "openclaw_send_work_items",
  "openclaw_send_work_attempts",
  "openclaw_maintenance_work_items",
  "openclaw_maintenance_work_attempts",
  "openclaw_audit_events",
  "openclaw_audit_roots",
  "openclaw_health_events",
  "openclaw_retention_holds",
  "openclaw_rollout_runs",
  "openclaw_rollout_observations",
  "openclaw_rollout_checkpoints",
  "openclaw_smoke_runs",
  "openclaw_smoke_cleanup_proofs",
] as const;

const mutableTables = [
  "openclaw_outbox",
  "openclaw_outbound_authorizations",
  "openclaw_send_work_items",
  "openclaw_maintenance_work_items",
  "openclaw_audit_roots",
  "openclaw_retention_holds",
  "openclaw_rollout_runs",
  "openclaw_smoke_runs",
] as const;

const appendOnlyTables = [
  "openclaw_delivery_attempts",
  "openclaw_dead_letters",
  "openclaw_unknown_resolutions",
  "openclaw_send_work_attempts",
  "openclaw_maintenance_work_attempts",
  "openclaw_audit_events",
  "openclaw_health_events",
  "openclaw_rollout_observations",
  "openclaw_rollout_checkpoints",
  "openclaw_smoke_cleanup_proofs",
] as const;

const tableDefinition = (migration: string, table: string) => {
  const match = migration.match(
    new RegExp(`create table public\\.${table}\\s*\\([\\s\\S]*?\\n\\);`, "i"),
  );
  expect(match, `missing complete definition for ${table}`).not.toBeNull();
  return match![0];
};

describe("OpenClaw delivery, audit and operations migration", () => {
  it("creates every tenant table with forced deny-by-default RLS", () => {
    const migration = sql();
    for (const table of tables) {
      expect(migration).toMatch(new RegExp(`create table public\\.${table}\\b`, "i"));
      expect(tableDefinition(migration, table)).toMatch(/unique \(organization_id, id\)/i);
      expect(migration).toMatch(new RegExp(`alter table public\\.${table} owner to openclaw_function_owner`, "i"));
      expect(migration).toMatch(new RegExp(`alter table public\\.${table} enable row level security`, "i"));
      expect(migration).toMatch(new RegExp(`alter table public\\.${table} force row level security`, "i"));
      expect(migration).toMatch(new RegExp(`revoke all on public\\.${table} from public, anon, authenticated, service_role`, "i"));
    }
  });

  it("keeps table access on narrow internal roles and freezes mutable tenant identity", () => {
    const migration = sql();
    expect(migration).toContain("to openclaw_function_owner using (true) with check (true)");
    expect(migration).toContain("to openclaw_runtime_writer");
    expect(migration).toContain("to openclaw_maintenance_writer");
    expect(migration).not.toMatch(/grant[^;]*\bdelete\b[^;]*\bopenclaw_/is);
    expect(migration).not.toMatch(
      /grant[^;]*on\s+(?:table\s+)?public\.openclaw_[^;]*to\s+(?:anon|authenticated|service_role)/is,
    );
    for (const table of mutableTables) {
      expect(migration).toContain(`create trigger ${table}_immutable_tenant`);
    }
    for (const table of appendOnlyTables) {
      expect(migration).toContain(`create trigger ${table}_append_only`);
    }
    expect(migration.trimEnd().toLowerCase().endsWith("commit;")).toBe(true);
  });

  it("locks the exact outbox state machine and source idempotency domains", () => {
    const migration = sql();
    expect(migration).toContain("state IN ('QUEUED','LEASED','DISPATCHING','SENT','FAILED','UNKNOWN','DEAD_LETTER')");
    for (const index of [
      "openclaw_outbox_manual_idempotency_uidx",
      "openclaw_outbox_inbound_idempotency_uidx",
      "openclaw_outbox_schedule_idempotency_uidx",
      "openclaw_outbox_crm_idempotency_uidx",
      "openclaw_outbox_claimable_idx",
      "openclaw_outbox_dispatching_sweep_idx",
      "openclaw_outbox_unknown_idx",
    ]) expect(migration).toContain(index);
    expect(migration).toContain("canonical_payload jsonb not null");
    expect(migration).toContain("canonical_payload_bytes bytea not null");
    expect(migration).toContain("payload_hash text not null");
    expect(migration).toContain("convert_to('ihome-openclaw-' || 'send-v1', 'UTF8')");
    expect(migration).toMatch(
      /convert_to\('ihome-openclaw-'\s*\|\|\s*'send-v1', 'UTF8'\)\s*\|\| decode\('00', 'hex'\)\s*\|\| canonical_payload_bytes/i,
    );
    expect(migration).toContain("claim_generation bigint not null default 0");
    expect(migration).toContain("fencing_token bigint not null");
    expect(migration).toContain("session_generation bigint not null");
    expect(migration).toContain("control_version bigint not null");
    expect(migration).toContain("takeover_version bigint not null");
    expect(migration).toContain("outbox intent and canonical payload cannot change");
    expect(migration).toContain("NEW.canonical_payload is distinct from OLD.canonical_payload");
    expect(migration).toContain("NEW.canonical_payload_bytes is distinct from OLD.canonical_payload_bytes");
    expect(migration).toContain("NEW.payload_hash is distinct from OLD.payload_hash");
  });

  it("binds one-time authorization and fail-closed delivery evidence", () => {
    const migration = sql();
    expect(migration).toContain("marker_nonce_hash text not null");
    expect(migration).toContain("expires_at <= issued_at + interval '15 seconds'");
    expect(migration).toContain("expires_at <= lease_expires_at");
    expect(migration).toContain("openclaw_authorizations_one_success_uidx");
    expect(migration).toContain("possible_handoff_prefix_length");
    expect(migration).toContain("known_provider_message_ids text[] not null");
    expect(migration).toContain("delivery_evidence_hash text not null");
    expect(migration).toContain("outcome IN ('SENT','FAILED','UNKNOWN','SAFE_RETRY')");
    expect(migration).toContain("guard_openclaw_outbound_authorization_v1");
    expect(migration).toContain("authorization marker can only be consumed once");
  });

  it("separates channel send work from account-independent maintenance work", () => {
    const migration = sql();
    expect(migration).toContain("work_kind IN ('INBOUND_AUTOMATION','SCHEDULE_OCCURRENCE','CRM_EVENT')");
    expect(migration).toContain("work_kind IN ('RETENTION_DELETE','AUDIT_ANCHOR')");
    expect(migration).toMatch(/openclaw_send_work_items[\s\S]*account_id uuid not null[\s\S]*cell_id uuid not null/i);
    expect(migration).toMatch(/openclaw_maintenance_work_items[\s\S]*maintenance_principal_id uuid not null/i);
    expect(migration).toContain("openclaw_send_work_claimable_idx");
    expect(migration).toContain("openclaw_maintenance_work_claimable_idx");
    expect(tableDefinition(migration, "openclaw_send_work_attempts")).toMatch(
      /cell_id uuid not null[\s\S]*fencing_token bigint not null[\s\S]*session_generation bigint not null/i,
    );
    expect(tableDefinition(migration, "openclaw_maintenance_work_attempts")).toMatch(
      /maintenance_lease_generation bigint not null[\s\S]*fencing_token bigint not null/i,
    );
    expect(migration).toContain("guard_openclaw_send_work_mutation_v1");
    expect(migration).toContain("send work binding can only rebind while unclaimed");
    expect(migration).toContain("guard_openclaw_maintenance_work_mutation_v1");
    expect(migration).toContain("maintenance work binding can only rebind while unclaimed");
    expect(migration).toContain("NEW.claim_generation <> OLD.claim_generation + 1");
  });

  it("keeps UNKNOWN historical and resolves it once through immutable evidence", () => {
    const migration = sql();
    expect(migration).toContain("resolution_version smallint NOT NULL DEFAULT 0 CHECK (resolution_version IN (0,1))");
    expect(migration).toContain("outcome IN ('CONFIRMED_SENT','CONFIRMED_FAILED','NEW_INTENT_CREATED')");
    expect(migration).toContain("authoritative_evidence_domain text not null default 'ihome-openclaw-unknown-authority-v1\\0'");
    expect(migration).toContain("openclaw_unknown_resolutions_new_outbox_uidx");
    expect(migration).toContain("reject_openclaw_unknown_state_rewrite_v1");
    expect(migration).toContain("OLD.state = 'UNKNOWN' AND NEW.state <> 'UNKNOWN'");
    expect(migration).toContain("to_jsonb(NEW) - 'resolution_version'");
    expect(migration).toContain("invalid outbox state transition");
    expect(migration).toContain("openclaw_unknown_resolutions_append_only");
    expect(tableDefinition(migration, "openclaw_outbox")).toContain(
      "check (resolution_version = 0 or state = 'UNKNOWN')",
    );
  });

  it("stores append-only hash-chained audit and signed daily roots", () => {
    const migration = sql();
    expect(migration).toContain("organization_sequence bigint not null");
    expect(migration).toContain("previous_hash text not null");
    expect(migration).toContain("event_hash text not null");
    expect(migration).toContain("redacted_evidence_bytes bytea not null");
    expect(migration).toContain("openclaw_audit_events_append_only");
    expect(migration).toContain("append_openclaw_audit_v1");
    expect(migration).toContain("verify_openclaw_audit_chain_v1");
    expect(migration).not.toContain("chr(0)");
    expect(migration).toContain("decode('00', 'hex')");
    expect(migration).toContain("extensions.digest(p_redacted_evidence_bytes, 'sha256')");
    expect(migration).toMatch(
      /grant execute on function app_private\.verify_openclaw_audit_chain_v1\(uuid\)\s+to openclaw_maintenance_writer;/i,
    );
    expect(migration).toContain("signing_key_generation bigint not null");
    expect(migration).toContain("r2_anchor_key text not null");
    expect(migration).toContain("guard_openclaw_audit_root_mutation_v1");
    expect(migration).toContain("audit root identity cannot change");
    expect(migration).toContain("audit root can only be anchored once");
    expect(tableDefinition(migration, "openclaw_health_events")).toContain(
      "check (cell_id is null or account_id is not null)",
    );
  });

  it("persists rollout/smoke state and enforces staged continuous-green evidence", () => {
    const migration = sql();
    const stageConstraint = "check (stage in ('FOUNDATION','INFRASTRUCTURE','WAITING_OWNER_QR','CONNECTION','SHADOW','WAITING_OWNER_INBOUND','LIMITED_OBSERVING','LIMITED_VERIFIED','PROACTIVE','SALES_GROUPS','COMPLETE'))";
    expect(migration).toContain("WAITING_OWNER_QR");
    expect(migration).toContain("WAITING_OWNER_INBOUND");
    expect(migration).toContain("LIMITED_VERIFIED");
    expect(migration).toContain("SALES_GROUPS");
    expect(migration).toContain("continuous_green_started_at");
    expect(migration).toContain("interval '72 hours'");
    expect(migration).toContain("OLD.continuous_green_started_at + interval '72 hours'");
    expect(migration).toContain("from public.openclaw_rollout_observations");
    expect(migration).toContain("v_green_has_gap");
    expect(migration).toContain("rollout stage_version cannot change without a stage transition");
    expect(migration).toContain("openclaw_rollout_observations_append_only");
    expect(migration).toContain("openclaw_smoke_cleanup_zero_residual_check");
    expect(migration).toContain("reviewed_commit_sha text not null");
    expect(migration).toContain("migration_manifest_sha256 text not null");
    expect(migration).toContain("rollout deployment identity cannot change");
    expect(migration).toContain("smoke command scope cannot change");
    expect(migration.split(stageConstraint)).toHaveLength(4);
  });
});
