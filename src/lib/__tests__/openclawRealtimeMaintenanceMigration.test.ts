import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const paths = {
  policy: resolve(
    process.cwd(),
    "supabase/migrations/20260727030000_openclaw_policy_automation_knowledge.sql",
  ),
  realtime: resolve(
    process.cwd(),
    "supabase/migrations/20260727080000_openclaw_realtime_allowlist.sql",
  ),
  maintenance: resolve(
    process.cwd(),
    "supabase/migrations/20260727090000_openclaw_maintenance_jobs.sql",
  ),
  activation: resolve(
    process.cwd(),
    "supabase/migrations/20260727095000_openclaw_activation_guards.sql",
  ),
};

const source = (path: string) => readFileSync(path, "utf8");

const functionBody = (sql: string, schema: "public" | "app_private", name: string) => {
  const match = sql.match(new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${schema}\\.${name}\\s*\\([\\s\\S]*?\\)\\s*returns[\\s\\S]*?as\\s+\\$function\\$([\\s\\S]*?)\\$function\\$;`,
    "i",
  ));
  expect(match, `missing ${schema}.${name}`).not.toBeNull();
  return match![1];
};

const expectMigrationEnvelope = (sql: string) => {
  expect(sql.trimStart().toLowerCase().startsWith("begin;")).toBe(true);
  expect(sql.trimEnd().toLowerCase().endsWith("commit;")).toBe(true);
};

describe("OpenClaw Realtime, maintenance, and activation migrations", () => {
  it("creates the final three inert migrations with transactional envelopes", () => {
    for (const path of Object.values(paths)) {
      expect(existsSync(path), `missing ${path}`).toBe(true);
      expectMigrationEnvelope(source(path));
    }
  });

  it("publishes only explicit safe invalidation metadata columns", () => {
    expect(existsSync(paths.realtime)).toBe(true);
    const sql = source(paths.realtime);
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("pg_publication_columns");
    expect(sql).toContain("supabase_realtime");

    const requiredTables = [
      "openclaw_accounts",
      "openclaw_account_connections",
      "openclaw_runtime_cells",
      "openclaw_conversations",
      "openclaw_conversation_members",
      "openclaw_messages",
      "openclaw_message_media",
    ];
    for (const table of requiredTables) {
      expect(sql).toMatch(new RegExp(
        `alter publication supabase_realtime add table public\\.${table}\\s*\\([^)]{3,}\\)`,
        "i",
      ));
    }

    const publicationStatements = Array.from(sql.matchAll(
      /alter publication supabase_realtime add table public\.[a-z0-9_]+\s*\(([^)]*)\)/gi,
    )).map((match) => match[0].toLowerCase());
    expect(publicationStatements).toHaveLength(requiredTables.length);
    const published = publicationStatements.join("\n");
    for (const forbidden of [
      "qr_payload", "credential", "secret", "text_content", "draft_text",
      "prompt", "object_key", "provider_message_id", "payload_hash",
      "policy_evidence", "raw_attempt", "retention_hold",
    ]) {
      expect(published).not.toContain(forbidden);
    }
    expect(sql).not.toMatch(/create\s+(?:or\s+replace\s+)?view\s+public\./i);
  });

  it("stores deterministic schedule occurrences and immutable recurrence policy", () => {
    expect(existsSync(paths.maintenance)).toBe(true);
    const sql = source(paths.maintenance);
    expect(sql).toMatch(/create table public\.openclaw_schedule_occurrences\s*\(/i);
    expect(sql).toContain("SKIPPED_MISSED");
    expect(sql).toContain("MATERIALIZED");
    expect(sql).toContain("planned_for timestamptz not null");
    expect(sql).toContain("planned_local timestamp without time zone not null");
    expect(sql).toContain("resolved_local timestamp without time zone not null");
    expect(sql).toContain("schedule_version bigint not null");
    expect(sql).toMatch(/unique\s*\(organization_id,account_id,schedule_id,schedule_version,planned_local\)/i);
    expect(sql).toMatch(/unique\s*\(organization_id,account_id,schedule_id,schedule_version,planned_for\)/i);
    expect(sql).toMatch(/unique\s*\(organization_id,account_id,id\)/i);
    expect(sql).toContain("occurrence_grace_seconds");
    expect(sql).toContain("dst_fold_policy");
    expect(sql).toContain("EARLIER_OFFSET");
    expect(sql).toContain("LATER_OFFSET");
    expect(sql).toContain("openclaw_valid_local_recurrence_rule_v1");
    expect(sql).toContain("openclaw_parse_local_recurrence_rule_v1");
    expect(sql).toContain("openclaw_resolve_local_occurrence_v1");
    expect(sql).toContain("openclaw_next_schedule_occurrence_v1");
    expect(sql).toContain("V1;FREQ=ONCE;DTSTART=");
    expect(sql).toContain("V1;FREQ=DAILY;DTSTART=");
    expect(sql).toContain("V1;FREQ=WEEKLY;DTSTART=");
    expect(sql).toContain("GAP_SHIFT_FORWARD");
    expect(sql).toContain("FOLD_EARLIER_OFFSET");
    expect(sql).toContain("FOLD_LATER_OFFSET");
  });

  it("materializes schedules with DB time, DST policy, no catch-up, and stable versions", () => {
    expect(existsSync(paths.maintenance)).toBe(true);
    const sql = source(paths.maintenance);
    const body = functionBody(sql, "app_private", "materialize_openclaw_schedule_work_v1");
    expect(body).toContain("statement_timestamp()");
    expect(body).toContain("for update of schedule skip locked");
    expect(body).toContain("schedule.next_run_at");
    expect(body).toContain("schedule.schedule_version");
    expect(body).toContain("openclaw_schedule_snapshots");
    expect(body).toContain("SKIPPED_MISSED");
    expect(body).toContain("occurrence_grace_seconds");
    expect(body).toContain("dst_fold_policy");
    expect(body).toContain("openclaw_next_schedule_occurrence_v1");
    expect(body).toContain("on conflict");
    expect(body).not.toMatch(/catch.?up/i);
    expect(body).not.toMatch(/p_(?:now|clock|as_of)|nextRunAt/i);
    expect(body).not.toMatch(/\bhttp|net\.|r2\b/i);
  });

  it("fans typed CRM occurrences out once per exact subscription and target", () => {
    expect(existsSync(paths.maintenance)).toBe(true);
    const sql = source(paths.maintenance);
    const body = functionBody(sql, "app_private", "materialize_openclaw_crm_work_v1");
    expect(body).toContain("openclaw_crm_event_occurrences");
    expect(body).toContain("openclaw_crm_event_subscriptions");
    expect(body).toContain("event_subtype");
    expect(body).toContain("source_snapshot");
    expect(body).toContain("snapshot_hash");
    expect(body).toContain("subscription_version");
    expect(body).toContain("destination_target_id");
    expect(body).toContain("for update");
    expect(body).toContain("skip locked");
    expect(body).toContain("on conflict");
    expect(sql).toMatch(/unique[^;]*organization_id[^;]*schedule_id[^;]*schedule_version[^;]*schedule_occurrence_id[^;]*target_id/i);
    expect(sql).toMatch(/unique[^;]*organization_id[^;]*subscription_id[^;]*subscription_version[^;]*crm_occurrence_id[^;]*target_id/i);
    expect(sql).not.toContain("campaign_or_schedule_id");
    expect(body).not.toMatch(/render|policy|\bhttp|\br2\b/i);
  });

  it("keeps channel and maintenance principals separated and rebinds only unclaimed work", () => {
    expect(existsSync(paths.maintenance)).toBe(true);
    const sql = source(paths.maintenance);
    const rebind = functionBody(sql, "app_private", "rebind_openclaw_unclaimed_work_v1");
    expect(sql).toContain("binding_defer_reason");
    expect(rebind).toContain("state = 'QUEUED'");
    expect(rebind).toContain("claim_token_hash is null");
    expect(rebind).toContain("lease_expires_at is null");
    expect(rebind).toContain("terminal_at is null");
    expect(rebind).toMatch(/claim_generation\s*=\s*[^,;]+claim_generation\s*\+\s*1/i);
    expect(rebind).toContain("claim_token_hash is null");
    expect(rebind).toContain("maintenance_principal_id");
    expect(rebind).toContain("fencing_token");
    expect(sql).toContain("credential_generation");
    expect(sql).toContain("runtime_lease_generation");
    expect(sql).toContain("source_key");
    expect(rebind).not.toMatch(/payload\s*=/i);
  });

  it("implements DB-only quarantine and post-grace final deletion under legal-hold CAS", () => {
    expect(existsSync(paths.maintenance)).toBe(true);
    const sql = source(paths.maintenance);
    const quarantine = functionBody(
      sql,
      "app_private",
      "materialize_openclaw_retention_quarantine_v1",
    );
    const finalDelete = functionBody(
      sql,
      "app_private",
      "materialize_openclaw_retention_final_delete_v1",
    );
    const complete = functionBody(
      sql,
      "app_private",
      "openclaw_complete_retention_quarantine_v1",
    );

    expect(quarantine).toContain("openclaw_retention_policies");
    expect(quarantine).toContain("openclaw_retention_subject_held_v1");
    expect(quarantine).toContain("openclaw_retention_hold_clocks");
    expect(quarantine).toContain("QUARANTINE");
    expect(quarantine).toContain("on conflict");
    expect(finalDelete).toContain("FINAL_DELETE");
    expect(finalDelete).toContain("final_delete_not_before");
    expect(finalDelete).toContain("openclaw_retention_subject_held_v1");
    expect(complete).toContain("for update");
    expect(complete).toContain("hold_version");
    expect(complete).toContain("openclaw_retention_hold_scopes");
    expect(complete).toContain("claim_token_hash");
    expect(complete).toContain("interval '7 days'");
    expect(complete).toContain("openclaw_messages");
    expect(complete).toContain("openclaw_ai_drafts");
    expect(complete).toContain("openclaw_message_media");
    expect(complete).toContain("REDACTED_BY_RETENTION");
    expect(sql).toContain("DELETE_AUTHORIZED");
    expect(sql).toContain("openclaw_retention_delete_tickets");
    expect(sql).toContain("openclaw_retention_policies");
    expect(sql).toMatch(/openclaw_complete_work_item_v1[\s\S]*?(?:retention|audit)[\s\S]*?raise exception/i);
    expect(complete).not.toMatch(/\bhttp|fetch|r2|object.delete|delete \/v1\/object/i);
    expect(sql).toContain("openclaw_authorize_retention_delete_v1");
    expect(sql).toContain("openclaw_finalize_retention_delete_v1");
  });

  it("materializes dead letters, daily audit roots, and runs all DB jobs internally", () => {
    expect(existsSync(paths.maintenance)).toBe(true);
    const sql = source(paths.maintenance);
    const runner = functionBody(sql, "app_private", "run_openclaw_maintenance_jobs_v1");
    expect(runner).toContain("openclaw_sweep_due_sales_tasks_v1");
    expect(runner).toContain("materialize_openclaw_schedule_work_v1");
    expect(runner).toContain("materialize_openclaw_crm_work_v1");
    expect(runner).toContain("materialize_openclaw_retention_quarantine_v1");
    expect(runner).toContain("materialize_openclaw_retention_final_delete_v1");
    expect(runner).toContain("materialize_openclaw_audit_root_v1");
    expect(runner).toContain("expire_openclaw_qr_challenges_v1");
    expect(runner).toContain("expire_openclaw_runtime_leases_v1");
    expect(runner).toContain("expire_openclaw_maintenance_leases_v1");
    expect(runner).toContain("sweep_openclaw_delivery_claims_v1");
    const deliverySweep = functionBody(sql, "app_private", "sweep_openclaw_delivery_claims_v1");
    expect(deliverySweep).not.toMatch(/\bauthorization\s*\./i);
    expect(deliverySweep).not.toMatch(/\)\s*authorization\s+on\s+true/i);
    expect(deliverySweep).toContain("openclaw_dead_letters");
    expect(deliverySweep).toContain("SWEEPER_LEASE_EXPIRED_AFTER_HANDOFF");
    expect(deliverySweep).toContain("SWEEPER_DISPATCHING_WITHOUT_AUTHORIZATION");
    expect(functionBody(sql, "app_private", "expire_openclaw_qr_challenges_v1"))
      .toContain("openclaw_qr_challenges");
    expect(functionBody(sql, "app_private", "expire_openclaw_runtime_leases_v1"))
      .toContain("openclaw_runtime_leases");
    expect(functionBody(sql, "app_private", "expire_openclaw_maintenance_leases_v1"))
      .toContain("openclaw_maintenance_leases");
    expect(sql).toContain("SWEEPER_LEASE_EXPIRED_AFTER_HANDOFF");
    expect(sql).toContain("SWEEPER_DISPATCHING_WITHOUT_AUTHORIZATION");
    expect(sql).toMatch(/cron\.schedule\([\s\S]*?'\* \* \* \* \*'/i);
    expect(sql).toMatch(/revoke all on function app_private\.run_openclaw_maintenance_jobs_v1\(\)[\s\S]*?from public,\s*anon,\s*authenticated,\s*service_role/i);
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = ''");
  });

  it("keeps the twelve-migration chain inert behind additive activation guards", () => {
    expect(existsSync(paths.activation)).toBe(true);
    const sql = source(paths.activation);
    const policySql = source(paths.policy);
    const exactMigrations = [
      "20260727010000_openclaw_catalog_foundation.sql",
      "20260727015000_openclaw_security_principals.sql",
      "20260727020000_openclaw_inbox_schema.sql",
      "20260727025000_openclaw_inbound_automation.sql",
      "20260727030000_openclaw_policy_automation_knowledge.sql",
      "20260727040000_openclaw_delivery_audit_ops.sql",
      "20260727050000_openclaw_access_policies.sql",
      "20260727060000_openclaw_rpc_surface.sql",
      "20260727070000_openclaw_crm_event_sources.sql",
      "20260727080000_openclaw_realtime_allowlist.sql",
      "20260727090000_openclaw_maintenance_jobs.sql",
      "20260727095000_openclaw_activation_guards.sql",
    ];
    for (const migration of exactMigrations) expect(sql).toContain(migration);

    expect(sql).toContain("openclaw_guard_activation_v1");
    expect(sql).toContain("openclaw_rollout_runs");
    expect(sql).toContain("migration_manifest_sha256");
    expect(sql).toContain("artifact_digests");
    expect(sql).not.toMatch(/create table public\.openclaw_rollout_artifacts/i);
    expect(sql).toContain("openclaw_rollout_checkpoints");
    expect(sql).toContain("openclaw_runtime_credentials");
    expect(sql).toContain("openclaw_runtime_leases");
    expect(sql).toContain("fencing_token");
    expect(sql).toContain("global_stop");
    expect(sql).toContain("feature_enabled");
    expect(sql).toContain("limited_auto_reply_enabled");
    expect(sql).toContain("proactive_enabled");
    expect(sql).toContain("sales_groups_enabled");
    expect(sql).toContain("first_contact_enabled");
    expect(policySql).toMatch(/feature_enabled\s+boolean\s+not null\s+default false/i);
    expect(sql).toContain("openclaw_outbound_authorizations");
    expect(sql).toContain("WAITING_OWNER_QR");
    expect(sql).toContain("WAITING_OWNER_INBOUND");
    expect(sql).toContain("deny unknown activation target");
    expect(sql).not.toMatch(/insert\s+into\s+public\.openclaw_(?:accounts|runtime_cells|runtime_credentials|maintenance_credentials)/i);
    expect(sql).not.toMatch(/chat-zalo|\bzalo_[a-z0-9_]+|worker\//i);
    expect(sql).toMatch(/revoke all on function app_private\.openclaw_guard_activation_v1\(\)[\s\S]*?from public,\s*anon,\s*authenticated,\s*service_role/i);
  });

  it("makes recurrence cursors and runtime bindings effective, not client assertions", () => {
    const sql = source(paths.maintenance);
    const scheduleWrite = functionBody(sql, "app_private", "openclaw_apply_schedule_write_v1");
    const resolver = functionBody(sql, "app_private", "openclaw_resolve_local_occurrence_v1");
    const claimWork = functionBody(sql, "app_private", "openclaw_claim_work_item_v1");
    const claimOutbox = functionBody(sql, "app_private", "openclaw_claim_outbox_v1");

    expect(scheduleWrite).toMatch(/p_request\s*\?\s*'nextRunAt'/i);
    expect(scheduleWrite).toContain("database-derived");
    expect(scheduleWrite).toContain("direct target only");
    expect(resolver).toContain("generate_series");
    expect(resolver).toContain("interval '26 hours'");
    expect(resolver).toContain("GAP_SHIFT_FORWARD");
    expect(claimWork).toContain("credential_generation");
    expect(claimWork).toContain("runtime_lease_generation");
    expect(claimWork).toMatch(/least\s*\(lease\.expires_at/i);
    expect(claimOutbox).toContain("credential_generation");
    expect(claimOutbox).toContain("runtime_lease_generation");
    expect(claimOutbox).toMatch(/least\s*\(lease\.expires_at/i);
    expect(sql).not.toMatch(/claim_generation\s*(?:=|[^\n]*default)\s*0/i);
  });

  it("keeps retention authorization replayable and activation predicate-only", () => {
    const maintenance = source(paths.maintenance);
    const activation = source(paths.activation);
    const authorize = functionBody(maintenance, "app_private", "openclaw_authorize_retention_delete_v1");
    const finalize = functionBody(maintenance, "app_private", "openclaw_finalize_retention_delete_v1");
    const guard = functionBody(activation, "app_private", "openclaw_guard_activation_v1");
    const resume = functionBody(activation, "app_private", "openclaw_resume_rollout_v1");

    expect(authorize).toContain("DELETE_AUTHORIZED");
    expect(authorize).toContain("for share");
    expect(finalize).toContain("idempotentReplay");
    expect(finalize).toContain("preverified");
    expect(finalize).not.toMatch(/expires_at\s*>\s*statement_timestamp/i);
    expect(guard).toContain("artifact_digests");
    expect(guard).toContain("migration_manifest_sha256");
    expect(guard).toContain("deny unknown activation target");
    expect(guard).not.toMatch(/insert\s+into|update\s+public\./i);
    expect(resume).not.toMatch(/\bupdate\b|stage_version\s*\+/i);
    expect(activation).not.toMatch(/create table public\.openclaw_rollout_artifacts/i);
  });
});
