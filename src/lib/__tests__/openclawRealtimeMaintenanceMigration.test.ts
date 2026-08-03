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
    expect(sql).toContain("pg_publication_tables");
    expect(sql).toContain("attnames");
    expect(sql).not.toContain("pg_publication_columns");
    expect(sql).toContain("supabase_realtime");
    expect(sql).toContain("Unsafe OpenClaw relation is already present in supabase_realtime");
    expect(sql).toMatch(/published\.tablename<>all\s*\(array\[/i);

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
    expect(body).toContain("for update of candidate_schedule skip locked");
    expect(body).not.toContain("select schedule.*");
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
    expect(body).toMatch(/if v_next_local is null then[\s\S]*?status='COMPLETE'/i);
    expect(body).not.toMatch(
      /case when v_next_local is null then null else v_next\./i,
    );
  });

  it("allows only the UNKNOWN resolution timestamp to move with the 0-to-1 CAS", () => {
    const sql = source(paths.maintenance);
    const guard = functionBody(
      sql,
      "app_private",
      "reject_openclaw_unknown_state_rewrite_v1",
    );
    expect(guard).toContain(
      "to_jsonb(NEW)-array['resolution_version','updated_at']::text[]",
    );
    expect(guard).toContain("NEW.updated_at is distinct from OLD.updated_at");
    expect(guard).toMatch(
      /OLD\.resolution_version=0[\s\S]*?NEW\.resolution_version=1/i,
    );
    expect(guard).toContain(
      "UNKNOWN timestamp may change only with the resolution CAS",
    );
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
    expect(complete).toContain("openclaw_lock_retention_scope_v1");
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

  it("permits only the exact maintenance retention redaction transitions", () => {
    const sql = source(paths.maintenance);
    const guard = functionBody(
      sql,
      "app_private",
      "guard_openclaw_retention_redaction_v1",
    );

    expect(guard).toContain("openclaw_maintenance_writer");
    expect(guard).toContain("REDACTED_BY_RETENTION");
    expect(guard).toContain("TG_TABLE_NAME");
    expect(guard).toContain("openclaw_messages");
    expect(guard).toContain("openclaw_ai_drafts");
    expect(guard).toContain("openclaw_knowledge_versions");
    expect(guard).toContain("openclaw_knowledge_chunks");
    expect(guard).toContain("openclaw_delivery_attempts");
    expect(guard).toContain("openclaw_inbound_automation_decisions");
    expect(guard).toContain("deny unknown retention redaction target");
    expect(guard).toMatch(
      /TG_TABLE_NAME\s+in\s*\('openclaw_policy_versions','openclaw_knowledge_versions'\)[\s\S]*?OLD\.lifecycle_state='DRAFT'[\s\S]*?NEW\.lifecycle_state='PUBLISHED'/i,
    );
    expect(guard).toMatch(
      /OLD\.lifecycle_state='PUBLISHED'[\s\S]*?NEW\.lifecycle_state='ARCHIVED'/i,
    );
    expect(guard.indexOf("OLD.lifecycle_state='DRAFT'"))
      .toBeLessThan(guard.indexOf("only openclaw_maintenance_writer"));
    expect(sql).toMatch(
      /drop trigger openclaw_messages_append_only[\s\S]*?create trigger openclaw_messages_retention_guard/i,
    );
    expect(sql).toMatch(
      /drop trigger openclaw_ai_drafts_append_only[\s\S]*?create trigger openclaw_ai_drafts_retention_guard/i,
    );
    expect(sql).toMatch(
      /grant select,update on[\s\S]*?openclaw_messages[\s\S]*?openclaw_ai_drafts[\s\S]*?to openclaw_maintenance_writer/i,
    );
    expect(sql).toMatch(
      /create policy openclaw_messages_maintenance_retention_update[\s\S]*?to openclaw_maintenance_writer/i,
    );
    expect(sql).toMatch(
      /revoke all on function app_private\.guard_openclaw_retention_redaction_v1\(\)[\s\S]*?from public,\s*anon,\s*authenticated,\s*service_role/i,
    );
    expect(guard).toMatch(
      /NEW\.known_provider_message_ids\s+is\s+distinct\s+from\s+OLD\.known_provider_message_ids/i,
    );
    expect(
      functionBody(sql, "app_private", "enforce_openclaw_evidence_retention_v1"),
    ).not.toMatch(/known_provider_message_ids\s*=\s*'\{\}'/i);
  });

  it("enforces the complete organization retention contract beyond message and media", () => {
    const sql = source(paths.maintenance);
    const materialize = functionBody(
      sql,
      "app_private",
      "materialize_openclaw_retention_quarantine_v1",
    );
    const complete = functionBody(
      sql,
      "app_private",
      "openclaw_complete_retention_quarantine_v1",
    );
    const evidenceSweep = functionBody(
      sql,
      "app_private",
      "enforce_openclaw_evidence_retention_v1",
    );
    const held = functionBody(
      sql,
      "app_private",
      "openclaw_retention_subject_held_v1",
    );
    const runner = functionBody(sql, "app_private", "run_openclaw_maintenance_jobs_v1");
    const automationGuard = functionBody(
      source(paths.activation),
      "app_private",
      "openclaw_guard_automation_version_transition_v1",
    );

    for (const kind of [
      "MESSAGE", "AI_DRAFT", "MEDIA", "KNOWLEDGE", "HEALTH", "QR",
      "AUDIT", "POLICY", "CONTROL", "DELIVERY", "UNKNOWN", "SECURITY",
      "CONSENT", "RISK",
    ]) {
      expect(sql).toContain(`'${kind}'`);
    }
    for (const table of [
      "openclaw_knowledge_versions",
      "openclaw_knowledge_chunks",
      "openclaw_health_events",
      "openclaw_qr_challenges",
      "openclaw_audit_events",
      "openclaw_audit_roots",
      "openclaw_policy_versions",
      "openclaw_automation_versions",
      "openclaw_control_states",
      "openclaw_delivery_attempts",
      "openclaw_unknown_resolutions",
      "openclaw_runtime_credentials",
      "openclaw_maintenance_credentials",
      "openclaw_consents",
      "openclaw_suppressions",
      "openclaw_inbound_automation_decisions",
    ]) {
      expect(`${materialize}\n${complete}\n${evidenceSweep}`).toContain(table);
    }
    expect(sql).toContain("15552000");
    expect(sql).toContain("7776000");
    expect(sql).toContain("604800");
    expect(sql).toContain("31536000");
    expect(sql).toContain("openclaw_retention_evidence_seals");
    expect(sql).toMatch(
      /create trigger openclaw_retention_evidence_seals_append_only[\s\S]*?reject_openclaw_append_only_v1/i,
    );
    expect(sql).toContain("openclaw_retention_evidence_seals_maintenance_select");
    expect(sql).toContain("openclaw_retention_evidence_seals_maintenance_insert");
    expect(sql).not.toMatch(
      /grant\s+select,insert,update\s+on[^;]*\bopenclaw_retention_evidence_seals\b[^;]*;/i,
    );
    expect(sql).toContain("EXTERNAL_ANCHOR");
    expect(sql).toContain("HASH_ONLY");
    expect(evidenceSweep).toContain("openclaw_retention_subject_held_v1");
    expect(evidenceSweep).toContain("openclaw_lock_retention_scope_v1");
    expect(evidenceSweep).toContain("for update");
    expect(evidenceSweep).toContain("skip locked");
    expect(evidenceSweep).not.toMatch(/\bhttp|fetch|net\.|\br2\b/i);
    expect(evidenceSweep).toMatch(
      /delete\s+from\s+public\.openclaw_qr_challenges/i,
    );
    expect(evidenceSweep).toMatch(
      /update\s+public\.openclaw_automation_versions[\s\S]*?template_body[\s\S]*?allowed_crm_fields[\s\S]*?configuration/i,
    );
    expect(automationGuard).toContain("openclaw_maintenance_writer");
    expect(automationGuard).toContain("REDACTED_BY_RETENTION");
    expect(automationGuard).toMatch(
      /OLD\.lifecycle_state='PUBLISHED'[\s\S]*?NEW\.lifecycle_state='ARCHIVED'/i,
    );
    expect(held).toMatch(
      /hold\.target_kind='KNOWLEDGE'[\s\S]*?version\.source_id=hold\.target_id/i,
    );
    expect(held).toMatch(
      /hold\.target_kind='POLICY'[\s\S]*?version\.policy_id=hold\.target_id/i,
    );
    expect(held).toMatch(
      /hold\.target_kind='POLICY'[\s\S]*?version\.automation_id=hold\.target_id/i,
    );
    expect(runner).toContain("enforce_openclaw_evidence_retention_v1");
  });

  it("provisions the immutable retention contract only for onboarded maintenance organizations", () => {
    const sql = source(paths.maintenance);
    const ensure = functionBody(
      sql,
      "app_private",
      "ensure_openclaw_retention_contract_v1",
    );
    const runner = functionBody(sql, "app_private", "run_openclaw_maintenance_jobs_v1");

    expect(ensure).toContain("openclaw_maintenance_principals");
    expect(ensure).toContain("principal.is_current");
    expect(ensure).toContain("principal.revoked_at is null");
    for (const [kind, seconds] of [
      ["MESSAGE", "15552000"],
      ["AI_DRAFT", "15552000"],
      ["MEDIA", "7776000"],
      ["KNOWLEDGE", "31536000"],
      ["HEALTH", "7776000"],
      ["QR", "604800"],
      ["AUDIT", "31536000"],
      ["POLICY", "31536000"],
      ["CONTROL", "31536000"],
      ["DELIVERY", "31536000"],
      ["UNKNOWN", "31536000"],
      ["SECURITY", "31536000"],
      ["CONSENT", "31536000"],
      ["RISK", "31536000"],
    ]) {
      expect(ensure).toContain(`'${kind}'`);
      expect(ensure).toContain(seconds);
    }
    expect(ensure).toContain("on conflict");
    expect(ensure).not.toMatch(/openclaw_accounts|openclaw_runtime_cells/i);
    expect(runner.indexOf("ensure_openclaw_retention_contract_v1"))
      .toBeLessThan(runner.indexOf("materialize_openclaw_retention_quarantine_v1"));
  });

  it("materializes dead letters, daily audit roots, and runs all DB jobs internally", () => {
    expect(existsSync(paths.maintenance)).toBe(true);
    const sql = source(paths.maintenance);
    const runner = functionBody(sql, "app_private", "run_openclaw_maintenance_jobs_v1");
    expect(runner).toContain("pg_try_advisory_xact_lock");
    expect(runner).not.toContain("pg_advisory_unlock");
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
    expect(deliverySweep).toContain("handoff.consumed_at is not null");
    expect(deliverySweep).toContain("handoff.authorized_handoff_at is not null");
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
    const materializeSchedule = functionBody(
      sql,
      "app_private",
      "materialize_openclaw_schedule_work_v1",
    );
    const resolver = functionBody(sql, "app_private", "openclaw_resolve_local_occurrence_v1");
    const claimWork = functionBody(sql, "app_private", "openclaw_claim_work_item_v1");
    const claimOutbox = functionBody(sql, "app_private", "openclaw_claim_outbox_v1");

    expect(scheduleWrite).toMatch(/p_request\s*\?\s*'nextRunAt'/i);
    expect(scheduleWrite).toContain("database-derived");
    expect(scheduleWrite).toContain("immutable campaignVersionId");
    expect(scheduleWrite).toMatch(
      /from public\.openclaw_campaign_runs campaign_version[\s\S]*?campaign_version\.id=\(p_request->>'campaignVersionId'\)::uuid[\s\S]*?campaign_version\.automation_version_id=\(p_request->>'automationVersionId'\)::uuid/i,
    );
    expect(scheduleWrite).toContain("'campaignVersionId',v_schedule.campaign_version_id");
    expect(materializeSchedule).toContain(
      "snapshot.campaign_version_id=schedule.campaign_version_id",
    );
    expect(materializeSchedule).toContain(
      "'campaignVersionId',schedule.campaign_version_id",
    );
    expect(materializeSchedule).toMatch(
      /schedule_occurrence_id,campaign_version_id[\s\S]*?v_occurrence_id,schedule\.campaign_version_id/i,
    );
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
    const issueTicket = functionBody(
      maintenance,
      "app_private",
      "openclaw_issue_retention_delete_ticket_v1",
    );
    const authorize = functionBody(maintenance, "app_private", "openclaw_authorize_retention_delete_v1");
    const issueMedia = functionBody(maintenance, "app_private", "openclaw_issue_media_ticket_v1");
    const finalize = functionBody(maintenance, "app_private", "openclaw_finalize_retention_delete_v1");
    const guard = functionBody(activation, "app_private", "openclaw_guard_activation_v1");
    const resume = functionBody(activation, "app_private", "openclaw_resume_rollout_v1");

    expect(issueTicket).toContain("v_work.source_id");
    expect(issueTicket).toContain("insert into public.openclaw_retention_delete_tickets");
    expect(issueTicket).toContain("TICKET_ISSUED");
    expect(issueTicket).toContain("idempotent");
    expect(authorize).toContain("v_work.source_id");
    expect(authorize).not.toContain("v_work.payload->>'tombstoneId'");
    for (const body of [issueTicket, authorize]) {
      expect(body).toContain("array['version','workItemId','claimGeneration','claimToken']");
      expect(body).not.toMatch(/p_request\s*->>\s*'(?:tombstoneId|holdVersion|deleteTicketJti|deleteAuthorizationJti|gatewaySigningKeyGeneration)'/i);
      expect(body).not.toContain("preverified");
    }
    expect(authorize).toContain("DELETE_AUTHORIZED");
    expect(authorize).toContain("v_ticket.ticket_hash");
    expect(authorize).toContain("v_ticket.ticket_jti");
    expect(authorize).toContain("v_ticket.delete_authorization_jti");
    expect(authorize).toContain("for share");
    expect(issueMedia).toContain("documentSha256");
    expect(issueMedia).toContain("documentByteLength");
    expect(issueMedia).toContain("ANCHOR_VERIFY");
    expect(issueMedia).toContain("gatewayKeyGeneration");
    expect(maintenance).toContain(
      "create or replace function public.openclaw_service_issue_retention_delete_ticket_v1",
    );
    expect(finalize).toContain("idempotentReplay");
    expect(finalize).not.toContain("preverified");
    expect(finalize).not.toMatch(/v_ticket\.expires_at\s*>\s*statement_timestamp/i);
    expect(finalize).toContain("recovery_lease_expires_at>statement_timestamp()");
    expect(finalize).toContain("ihome-openclaw-retention-receipt-v1");
    expect(finalize).toContain("app_private.openclaw_jcs_bytes_v1(v_receipt)");
    expect(finalize).toContain("r2VersionOrEtag");
    expect(finalize).toContain("gatewaySigningKeyGeneration");
    expect(finalize).toContain("proofJti");
    expect(finalize).toContain("v_ticket.receipt is distinct from v_receipt");
    expect(finalize).toMatch(
      /objectStatus'[\s\S]*?DELETED'[\s\S]*?r2VersionOrEtag'[\s\S]*?NOT_FOUND/i,
    );
    // The binding is checked against the LINEAGE row, not the ticket row. These four
    // assertions named `v_ticket.` until d20c7b9 split each issuance of a logical
    // ticket into its own immutable lineage record; the ticket only carries the
    // latest state, while the receipt has to match the exact authorization that
    // produced it. Lineage is the stricter of the two, so the assertions moved
    // rather than being dropped.
    expect(finalize).toMatch(
      /v_lineage\.maintenance_principal_id\s*<>\s*\(p_principal->>'maintenancePrincipalId'\)::uuid/i,
    );
    expect(finalize).toMatch(
      /v_lineage\.credential_generation\s*<>\s*\(p_principal->>'credentialGeneration'\)::bigint/i,
    );
    expect(finalize).toMatch(
      /v_lineage\.maintenance_lease_generation\s*<>\s*\(p_principal->>'leaseGeneration'\)::bigint/i,
    );
    expect(finalize).toMatch(
      /v_lineage\.fencing_token\s*<>\s*\(p_principal->>'fencingToken'\)::bigint/i,
    );
    // …and the lineage row cannot outlive the ownership it records, which is what
    // makes checking it sufficient. Two independent reasons, both pinned here:
    // the final CAS refuses unless the work item is STILL owned by the lineage's
    // principal, and the composite foreign key blocks moving that ownership while
    // any lineage row references it.
    expect(finalize).toMatch(
      /work\.maintenance_principal_id\s*=\s*v_lineage\.maintenance_principal_id/i,
    );
    expect(maintenance).toMatch(
      /foreign key \(organization_id,maintenance_principal_id,work_item_id\)\s*references public\.openclaw_maintenance_work_items\(\s*organization_id,maintenance_principal_id,id\s*\)/i,
    );
    expect(finalize.indexOf("maintenance principal binding mismatch"))
      .toBeGreaterThan(finalize.indexOf("v_ticket.state='FINALIZED'"));
    expect(guard).toContain("artifact_digests");
    expect(guard).toContain("migration_manifest_sha256");
    expect(guard).toContain("deny unknown activation target");
    expect(guard).not.toMatch(/insert\s+into|update\s+public\./i);
    expect(resume).toMatch(/update public\.openclaw_rollout_runs[\s\S]*?set status='RUNNING'/i);
    expect(resume).not.toMatch(/stage_version\s*\+/i);
    expect(activation).not.toMatch(/create table public\.openclaw_rollout_artifacts/i);
  });

  it("upgrades every work producer and attempt to the exact credential and lease binding", () => {
    const sql = source(paths.maintenance);
    const insertGuard = functionBody(
      sql,
      "app_private",
      "guard_openclaw_send_work_insert_v1",
    );
    const inboundClaim = functionBody(
      sql,
      "app_private",
      "openclaw_claim_inbound_automation_v1",
    );
    const inboundComplete = functionBody(
      sql,
      "app_private",
      "openclaw_complete_inbound_automation_v1",
    );

    expect(sql).toContain("OPENCLAW_WORK_BINDING_PREFLIGHT_FAILED");
    expect(sql).toMatch(/drop constraint[\s\S]*?source_id[\s\S]*?source_version/i);
    expect(sql).toMatch(/alter table public\.openclaw_send_work_attempts[\s\S]*?credential_generation[\s\S]*?runtime_lease_generation/i);
    expect(sql).toMatch(/alter table public\.openclaw_maintenance_work_attempts[\s\S]*?credential_generation/i);
    expect(sql).toMatch(/before insert on public\.openclaw_send_work_items[\s\S]*?guard_openclaw_send_work_insert_v1/i);
    for (const required of [
      "source_key",
      "target_id",
      "credential_generation",
      "runtime_lease_generation",
      "openclaw_runtime_credentials",
      "openclaw_runtime_leases",
    ]) {
      expect(insertGuard).toContain(required);
    }
    for (const body of [inboundClaim, inboundComplete]) {
      expect(body).toContain("credential_generation");
      expect(body).toContain("runtime_lease_generation");
      expect(body).toContain("lease.expires_at");
    }
  });

  it("never advances a due schedule without either durable work or a durable missed occurrence", () => {
    const sql = source(paths.maintenance);
    const body = functionBody(sql, "app_private", "materialize_openclaw_schedule_work_v1");
    expect(body).toMatch(/v_status\s*=\s*'MATERIALIZED'[\s\S]*?v_cell\s+is\s+null[\s\S]*?binding_defer_reason[\s\S]*?continue/i);
    expect(body).toMatch(/get diagnostics\s+v_[a-z0-9_]+\s*=\s*row_count/i);
    expect(body).not.toMatch(/v_created\s*:=\s*v_created\s*\+\s*1\s*;\s*end if/i);
    expect(functionBody(sql, "app_private", "openclaw_next_schedule_occurrence_v1"))
      .toContain("date_trunc('week'");
  });

  it("creates an outbox and completes its send work in one idempotent CAS", () => {
    const sql = source(paths.maintenance);
    const body = functionBody(sql, "app_private", "openclaw_create_outbox_from_work_v1");
    const resultBuilder = body.match(
      /v_result\s*:=\s*jsonb_build_object\(([\s\S]*?)\);\s*v_internal_evidence\s*:=/i,
    );
    expect(body).toContain("openclaw_send_work_attempts");
    expect(body).toMatch(/state\s*=\s*'COMPLETE'/i);
    expect(body).toContain("terminal_at");
    expect(body).toContain("claimTokenHash");
    expect(body).not.toContain("idempotentReplay");
    expect(resultBuilder, "missing exact OpenClawWorkCompletionResult builder").not.toBeNull();
    expect(resultBuilder![1].replace(/\s+/g, "")).toBe(
      "'version',1,'workItemId',v_work.id,'claimGeneration',v_work.claim_generation," +
      "'outcome','COMPLETED','canonicalEvidenceHash',v_completion_hash," +
      "'completedAt',v_now,'retryNotBefore',null",
    );
    expect(body).toContain(
      "v_completion_evidence:=jsonb_build_object('outboxId',v_outbox,'payloadHash',v_payload_hash)",
    );
    expect(body).toContain("ihome-openclaw-send-work-completion-v1");
    expect(body).toContain("app_private.openclaw_jcs_bytes_v1(v_completion_evidence)");
    expect(body).toMatch(
      /attempt\.work_item_id=\(v_claim->>'workItemId'\)::uuid[\s\S]*?attempt\.claim_generation=\(v_claim->>'claimGeneration'\)::bigint[\s\S]*?attempt\.outcome='COMPLETE'[\s\S]*?claimTokenHash[\s\S]*?sourceSnapshotHash[\s\S]*?clientEvidence,payloadHash/i,
    );
    expect(body).toContain("return v_existing_attempt.evidence->'result'");
    expect(body).toMatch(/'COMPLETE',v_internal_evidence,v_completion_hash/i);
    expect(body).toMatch(
      /if v_payload_hash\s+is\s+distinct\s+from\s+p_request->>'payloadHash'[\s\S]*?canonical send payload hash mismatch/i,
    );
    expect(body).toMatch(
      /v_existing\.payload_hash is distinct from v_payload_hash[\s\S]*?idempotent work-to-outbox replay mismatch/i,
    );
    expect(body).toContain("v_existing.target_id is distinct from v_target.id");
    expect(body).not.toMatch(/v_existing\.target_id\s+is\s+distinct\s+from\s+v_target\s*(?:\n|or)/i);
    expect(body).not.toMatch(/on conflict[^;]+do update\s+set\s+updated_at\s*=\s*public\.openclaw_outbox\.updated_at/i);
  });

  it("serializes legal holds with quarantine and final-delete authorization", () => {
    const sql = source(paths.maintenance);
    const hold = functionBody(sql, "app_private", "openclaw_expand_retention_hold_scopes_v1");
    const claim = functionBody(sql, "app_private", "openclaw_claim_work_item_v1");
    const quarantine = functionBody(
      sql,
      "app_private",
      "openclaw_complete_retention_quarantine_v1",
    );
    const authorize = functionBody(
      sql,
      "app_private",
      "openclaw_authorize_retention_delete_v1",
    );
    for (const body of [hold, quarantine, authorize]) {
      expect(body).toContain("openclaw_lock_retention_scope_v1");
    }
    expect(hold).toContain("NEW.scope_version");
    expect(hold).not.toMatch(/NEW\.hold_version\s*:=/i);
    expect(quarantine).toMatch(/v_current_scope\s*<>\s*v_scope_version/i);
    expect(
      functionBody(sql, "app_private", "materialize_openclaw_retention_quarantine_v1"),
    ).toMatch(/source_key[\s\S]*?scope_version/i);
    expect(claim).toContain("STALE_RETENTION_SCOPE");
    expect(claim).toMatch(
      /work_kind\s*=\s*'RETENTION_DELETE'[\s\S]*?work_phase\s*=\s*'QUARANTINE'[\s\S]*?scopeVersion[\s\S]*?hold_version/i,
    );
    expect(claim).toMatch(
      /openclaw_maintenance_work_attempts[\s\S]*?'DEAD_LETTER'[\s\S]*?state\s*=\s*'DEAD_LETTER'/i,
    );
    for (const triggerFunction of [
      "openclaw_expand_retention_hold_scopes_v1",
      "openclaw_persist_retention_hold_scopes_v1",
    ]) {
      expect(sql).toContain(
        `alter function app_private.${triggerFunction}()\n  owner to openclaw_function_owner`,
      );
      expect(sql).toContain(
        `revoke all on function app_private.${triggerFunction}()`,
      );
    }
    const finalize = functionBody(
      sql,
      "app_private",
      "openclaw_finalize_retention_delete_v1",
    );
    expect(finalize).toContain("expected_receipt_claims");
    for (const claim of [
      "maintenancePrincipalId",
      "workItemId",
      "claimGeneration",
      "credentialGeneration",
      "leaseGeneration",
      "fencingToken",
      "holdVersion",
      "quarantineVersion",
    ]) {
      expect(finalize).toContain(claim);
    }
  });

  it("binds activation to canonical manifest, cell artifacts, flags, and evidence rows", () => {
    const activation = source(paths.activation);
    const guard = functionBody(activation, "app_private", "openclaw_guard_activation_v1");
    expect(activation).toMatch(/create unique index[\s\S]*?openclaw_rollout_runs[\s\S]*?where status in \('RUNNING','PAUSED'\)/i);
    expect(activation).toContain("openclaw_rollout_runs_activation_guard");
    expect(activation).toContain("openclaw_rollout_checkpoints_activation_guard");
    expect(activation).toContain("openclaw_qr_challenges_activation_guard");
    expect(activation).toContain("openclaw_runtime_commands_activation_guard");
    expect(activation).toContain("openclaw_account_connections_activation_guard");
    expect(activation).toContain("openclaw_sales_group_allowlists_activation_guard");
    expect(guard).toContain("cellReviewedCommitSha");
    expect(guard).toContain("cellImageDigest");
    expect(guard).toContain("cellConfigDigest");
    expect(guard).toContain("project_ref");
    expect(guard).toContain("openclaw_account_connections");
    expect(guard).toContain("openclaw_inbound_events");
    expect(guard).toContain("trusted_evidence_hash");
    expect(guard).toContain("limited_auto_reply_enabled");
    expect(guard).toContain("proactive_enabled");
    expect(guard).toContain("sales_groups_enabled");
  });

  it("does not orphan audit roots and completes anchor work with an exact receipt CAS", () => {
    const sql = source(paths.maintenance);
    const materialize = functionBody(sql, "app_private", "materialize_openclaw_audit_root_v1");
    const acknowledge = functionBody(sql, "app_private", "openclaw_ack_audit_anchor_v1");
    expect(materialize.indexOf("openclaw_maintenance_principals"))
      .toBeLessThan(materialize.indexOf("insert into public.openclaw_audit_roots"));
    expect(materialize).toContain("'anchorKey','v1/org/'");
    expect(materialize).toContain(
      "'auditSigningKeyGeneration',day.signing_key_generation",
    );
    expect(materialize).not.toContain("'r2AnchorKey'");
    expect(materialize).not.toContain("'signingKeyGeneration'");
    expect(materialize).toContain(".json");
    expect(acknowledge).toContain("openclaw_maintenance_work_items");
    expect(acknowledge).toContain("credential_generation");
    expect(acknowledge).toContain("maintenance_lease_generation");
    expect(acknowledge).toContain("verifyTicketJti");
    expect(acknowledge).toContain("gatewayReceiptHash");
    expect(acknowledge).toContain("v_work.payload->>'anchorKey'");
    expect(acknowledge).toContain("v_work.payload->>'auditSigningKeyGeneration'");
    expect(acknowledge).not.toContain("preverified");
    expect(acknowledge).toContain("ihome-openclaw-audit-receipt-v1");
    expect(acknowledge).toContain("app_private.openclaw_jcs_bytes_v1(v_receipt)");
    expect(acknowledge).toContain("receiptKind");
    expect(acknowledge).toContain("AUDIT_ANCHOR_VERIFY");
    expect(acknowledge).toContain("objectVersionOrEtag");
    expect(acknowledge).toContain("gatewaySigningKeyGeneration");
    expect(acknowledge).toContain("v_root.gateway_receipt is distinct from v_receipt");
    expect(acknowledge).toContain("idempotentReplay");
    expect(acknowledge.match(/openclaw_maintenance_work_attempts/g)).toHaveLength(1);
    expect(acknowledge).toContain("claim_token_hash");
    expect(acknowledge).toMatch(
      /state='COMPLETE'[\s\S]*?credential_generation[\s\S]*?maintenance_lease_generation[\s\S]*?fencing_token/i,
    );
    expect(acknowledge).toMatch(/state='COMPLETE'/i);
  });
});
