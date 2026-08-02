import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationDirectory = resolve(process.cwd(), "supabase/migrations");
const migrationManifest = [
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
] as const;

const migrationPath = resolve(
  migrationDirectory,
  migrationManifest[7],
);

const browserReadRpcs = [
  "openclaw_get_bootstrap_v1",
  "openclaw_list_my_organizations_v1",
  "openclaw_get_overview_v1",
  "openclaw_list_conversations_v1",
  "openclaw_list_messages_v1",
  "openclaw_list_unknown_v1",
  "openclaw_list_unknown_by_account_v1",
  "openclaw_get_unknown_resolution_v1",
  "openclaw_list_knowledge_v1",
  "openclaw_get_knowledge_v1",
  "openclaw_preview_knowledge_retrieval_v1",
  "openclaw_list_automations_v1",
  "openclaw_get_automation_v1",
  "openclaw_dry_run_automation_v1",
  "openclaw_list_sales_groups_v1",
  "openclaw_list_schedules_v1",
  "openclaw_list_dead_letters_v1",
  "openclaw_list_dead_letters_by_account_v1",
  "openclaw_list_audit_events_v1",
  "openclaw_list_health_events_v1",
  "openclaw_list_health_events_by_account_v1",
  "openclaw_list_legal_holds_v1",
  "openclaw_poll_qr_login_v1",
  "openclaw_resolve_media_object_v1",
] as const;

const browserWriterRpcs = [
  "openclaw_acknowledge_disclosure_v1",
  "openclaw_acknowledge_risk_v1",
  "openclaw_begin_qr_login_v1",
  "openclaw_consume_qr_challenge_v1",
  "openclaw_disconnect_account_v1",
  "openclaw_create_send_intent_v1",
  "openclaw_takeover_conversation_v1",
  "openclaw_release_takeover_v1",
  "openclaw_resolve_unknown_v1",
  "openclaw_set_control_state_v1",
  "openclaw_publish_automation_v1",
  "openclaw_publish_knowledge_v1",
  "openclaw_upsert_group_allowlist_v1",
  "openclaw_upsert_schedule_v1",
  "openclaw_mark_conversation_read_v1",
  "openclaw_assign_conversation_v1",
  "openclaw_create_knowledge_draft_v1",
  "openclaw_update_knowledge_draft_v1",
  "openclaw_validate_knowledge_v1",
  "openclaw_archive_knowledge_v1",
  "openclaw_create_automation_draft_v1",
  "openclaw_save_automation_step_v1",
  "openclaw_pause_automation_v1",
  "openclaw_request_directory_sync_v1",
  "openclaw_pause_schedule_v1",
  "openclaw_cancel_schedule_v1",
  "openclaw_create_legal_hold_v1",
  "openclaw_release_legal_hold_v1",
  "openclaw_replay_dead_letter_v1",
] as const;

const serviceRoutines = [
  "openclaw_runtime_heartbeat_v1",
  "openclaw_exchange_runtime_credential_v1",
  "openclaw_exchange_maintenance_credential_v1",
  "openclaw_submit_qr_result_v1",
  "openclaw_ingest_inbound_batch_v1",
  "openclaw_claim_inbound_automation_v1",
  "openclaw_complete_inbound_automation_v1",
  "openclaw_claim_outbox_v1",
  "openclaw_preflight_outbox_v1",
  "openclaw_authorize_outbox_send_v1",
  "openclaw_requeue_pre_handoff_v1",
  "openclaw_complete_outbox_v1",
  "openclaw_claim_work_item_v1",
  "openclaw_complete_work_item_v1",
  "openclaw_create_outbox_from_work_v1",
  "openclaw_issue_media_ticket_v1",
  "openclaw_complete_retention_quarantine_v1",
  "openclaw_authorize_retention_delete_v1",
  "openclaw_finalize_retention_delete_v1",
  "openclaw_ack_audit_anchor_v1",
  "openclaw_acquire_cell_lease_v1",
  "openclaw_begin_cell_rebind_v1",
  "openclaw_complete_cell_rebind_v1",
  "openclaw_ack_generation_revocation_v1",
  "openclaw_record_watchdog_health_v1",
  "openclaw_begin_rollout_v1",
  "openclaw_record_rollout_checkpoint_v1",
  "openclaw_record_rollout_observation_v1",
  "openclaw_resume_rollout_v1",
  "openclaw_advance_rollout_stage_v1",
  "openclaw_begin_smoke_run_v1",
  "openclaw_record_smoke_observation_v1",
  "openclaw_cleanup_smoke_run_v1",
  "openclaw_verify_smoke_cleanup_v1",
  "openclaw_sweep_runtime_v1",
] as const;

const additionalFinalServiceFacades = [
  "openclaw_service_ack_disconnect_revocation_v1",
  "openclaw_service_consume_qr_challenge_v1",
  "openclaw_service_finalize_account_connection_v1",
  "openclaw_service_finalize_media_upload_v1",
  "openclaw_service_get_work_context_v1",
  "openclaw_service_complete_maintenance_work_v1",
  "openclaw_service_issue_retention_delete_ticket_v1",
  "openclaw_service_resume_disconnect_revocation_v1",
] as const;

const legacyServiceFacades = [
  "openclaw_service_claim_inbound_automation_v1",
  "openclaw_service_complete_inbound_automation_v1",
  "openclaw_service_complete_retention_quarantine_v1",
  "openclaw_service_finalize_retention_delete_v1",
  "openclaw_service_ack_audit_anchor_v1",
] as const;

const credentialExchangeRoutines = [
  "openclaw_exchange_runtime_credential_v1",
  "openclaw_exchange_maintenance_credential_v1",
] as const;

const authenticatedServiceRoutines = serviceRoutines.filter(
  (name) => !credentialExchangeRoutines.includes(
    name as (typeof credentialExchangeRoutines)[number],
  ),
);

const supportTables = [
  "openclaw_client_operations",
  "openclaw_runtime_commands",
  "openclaw_generation_revocations",
  "openclaw_cell_rebinds",
  "openclaw_schedule_snapshots",
  "openclaw_crm_event_subscription_snapshots",
  "openclaw_inbound_collisions",
  "openclaw_retention_tombstones",
  "openclaw_retention_delete_authorizations",
  "openclaw_smoke_observations",
  "openclaw_service_nonces",
] as const;

const runtimeOwnedRoutines = [
  "openclaw_runtime_heartbeat_v1",
  "openclaw_exchange_runtime_credential_v1",
  "openclaw_submit_qr_result_v1",
  "openclaw_ingest_inbound_batch_v1",
  "openclaw_claim_inbound_automation_v1",
  "openclaw_complete_inbound_automation_v1",
  "openclaw_claim_outbox_v1",
  "openclaw_preflight_outbox_v1",
  "openclaw_authorize_outbox_send_v1",
  "openclaw_requeue_pre_handoff_v1",
  "openclaw_complete_outbox_v1",
  "openclaw_create_outbox_from_work_v1",
  "openclaw_acquire_cell_lease_v1",
  "openclaw_begin_cell_rebind_v1",
  "openclaw_complete_cell_rebind_v1",
  "openclaw_ack_generation_revocation_v1",
] as const;

const maintenanceOwnedRoutines = [
  "openclaw_exchange_maintenance_credential_v1",
  "openclaw_complete_retention_quarantine_v1",
  "openclaw_authorize_retention_delete_v1",
  "openclaw_finalize_retention_delete_v1",
  "openclaw_ack_audit_anchor_v1",
  "openclaw_record_watchdog_health_v1",
  "openclaw_begin_rollout_v1",
  "openclaw_record_rollout_checkpoint_v1",
  "openclaw_record_rollout_observation_v1",
  "openclaw_resume_rollout_v1",
  "openclaw_advance_rollout_stage_v1",
  "openclaw_begin_smoke_run_v1",
  "openclaw_record_smoke_observation_v1",
  "openclaw_cleanup_smoke_run_v1",
  "openclaw_verify_smoke_cleanup_v1",
] as const;

const routedRoutines = [
  "openclaw_claim_work_item_v1",
  "openclaw_complete_work_item_v1",
  "openclaw_issue_media_ticket_v1",
  "openclaw_sweep_runtime_v1",
] as const;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sql = () => readFileSync(migrationPath, "utf8");
const manifestSql = () => migrationManifest.map((migration) =>
  readFileSync(resolve(migrationDirectory, migration), "utf8")
);

const finalPublicRpcSurface = () => {
  const surface = new Set<string>();
  for (const source of manifestSql()) {
    const operations = source.matchAll(
      /^(create(?:\s+or\s+replace)?\s+function|drop\s+function\s+if\s+exists)\s+public\.(openclaw_[a-z0-9_]+)\s*\(/gim,
    );
    for (const operation of operations) {
      if (/^drop/i.test(operation[1])) surface.delete(operation[2]);
      else surface.add(operation[2]);
    }
  }
  return surface;
};

const functionBody = (source: string, schema: "public" | "app_private", name: string) => {
  const match = source.match(new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${schema}\\.${escapeRegex(name)}\\s*\\(([\\s\\S]*?)\\)\\s*returns\\s+jsonb([\\s\\S]*?)\\$function\\$;`,
    "i",
  ));
  expect(match, `missing ${schema}.${name}`).not.toBeNull();
  return { argumentsSql: match![1], definitionSql: match![2] };
};

describe("OpenClaw browser and runtime RPC surface migration", () => {
  it("computes the exact final RPC inventory across the authoritative migration manifest", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const source = sql();
    expect(migrationManifest).toHaveLength(12);
    for (const migration of migrationManifest) {
      expect(existsSync(resolve(migrationDirectory, migration)), `missing ${migration}`).toBe(true);
    }
    expect([...browserReadRpcs, ...browserWriterRpcs]).toHaveLength(53);
    expect(serviceRoutines).toHaveLength(35);

    for (const name of browserReadRpcs) {
      const fn = functionBody(source, "public", name);
      if (name === "openclaw_list_my_organizations_v1") {
        expect(fn.argumentsSql.trim()).toBe("");
      } else {
        expect(fn.argumentsSql).toMatch(/^\s*p_request\s+jsonb\s*$/i);
      }
    }

    for (const name of browserWriterRpcs) {
      const fn = functionBody(source, "public", name);
      expect(fn.argumentsSql).toMatch(
        /^\s*p_request\s+jsonb\s*,\s*p_client_operation_id\s+uuid\s*$/i,
      );
    }

    for (const name of serviceRoutines) {
      const privateFn = functionBody(source, "app_private", name);
      const publicFn = functionBody(source, "public", `openclaw_service_${name.slice("openclaw_".length)}`);
      for (const fn of [privateFn, publicFn]) {
        expect(fn.argumentsSql).toMatch(
          /^\s*p_principal\s+jsonb\s*,\s*p_envelope\s+jsonb\s*,\s*p_request\s+jsonb\s*$/i,
        );
      }
      expect(publicFn.definitionSql).toContain(`app_private.${name}`);
    }

    const droppedPublicFacades = manifestSql().flatMap((migrationSource) =>
      [...migrationSource.matchAll(
        /^drop\s+function\s+if\s+exists\s+public\.(openclaw_[a-z0-9_]+)\s*\(/gim,
      )].map((match) => match[1])
    );
    expect(droppedPublicFacades).toEqual([...legacyServiceFacades]);

    const expectedFinalPublic = new Set([
      ...browserReadRpcs,
      ...browserWriterRpcs,
      ...serviceRoutines.map((name) => `openclaw_service_${name.slice("openclaw_".length)}`),
      ...additionalFinalServiceFacades,
    ].filter((name) => !legacyServiceFacades.includes(
      name as (typeof legacyServiceFacades)[number],
    )));
    const actualFinalPublic = finalPublicRpcSurface();
    expect(actualFinalPublic).toEqual(expectedFinalPublic);
    for (const legacyFacade of legacyServiceFacades) {
      expect(actualFinalPublic.has(legacyFacade), `${legacyFacade} must be dropped`).toBe(false);
    }

    const actualPrivateService = [...source.matchAll(
      /^create\s+or\s+replace\s+function\s+app_private\.(openclaw_[a-z0-9_]+)\s*\(\s*p_principal\s+jsonb\s*,\s*p_envelope\s+jsonb\s*,\s*p_request\s+jsonb\s*\)/gim,
    )].map((match) => match[1]);
    expect(actualPrivateService).toHaveLength(35);
    expect(new Set(actualPrivateService)).toEqual(new Set(serviceRoutines));

    expect(source.trimStart().toLowerCase().startsWith("begin;")).toBe(true);
    expect(source.trimEnd().toLowerCase().endsWith("commit;")).toBe(true);
    expect(source).not.toMatch(/(^|\n)\s*end\s*\r?\n\s*\$[a-z_][a-z0-9_]*\$;/i);
  });

  it("adds the closed support ledgers, immutable snapshots and rollout lineage", () => {
    const source = sql();
    expect(supportTables).toHaveLength(11);
    for (const table of supportTables) {
      expect(source).toMatch(new RegExp(`create table public\\.${table}\\s*\\(`, "i"));
      expect(source).toMatch(new RegExp(`alter table public\\.${table} owner to openclaw_function_owner`, "i"));
      expect(source).toMatch(new RegExp(`alter table public\\.${table} enable row level security`, "i"));
      expect(source).toMatch(new RegExp(`alter table public\\.${table} force row level security`, "i"));
      expect(source).toMatch(new RegExp(
        `revoke all on public\\.${table} from public, anon, authenticated, service_role`,
        "i",
      ));
    }

    expect(source).toContain("primary key (organization_id, actor_id, operation_key, client_operation_id)");
    expect(source).toContain("replay_policy in ('RETURN_SAFE_RESULT','SINGLE_USE')");
    expect(source).toContain("openclaw_client_operations_incomplete_idx");
    expect(source).toContain("command_kind in ('QR_LOGIN','DISCONNECT','DIRECTORY_SYNC','CELL_REBIND','GENERATION_REVOKE')");
    expect(source).toContain("state in ('PENDING','LEASED','STARTED','ACKNOWLEDGED','FAILED','EXPIRED','REVOKED')");
    expect(source).toContain("openclaw_runtime_commands_claimable_idx");
    expect(source).toContain("principal_kind in ('CHANNEL','MAINTENANCE')");
    expect(source).toContain("openclaw_generation_revocations_channel_uidx");
    expect(source).toContain("openclaw_generation_revocations_maintenance_uidx");
    expect(source).toContain("openclaw_cell_rebinds_one_prepared_uidx");
    expect(source).toContain("openclaw_schedule_snapshots_append_only");
    expect(source).toContain("openclaw_crm_subscription_snapshots_append_only");
    expect(source).toContain("collision_kind in ('CROSS_KIND','PAIR_MISMATCH','PAYLOAD_MISMATCH','FINGERPRINT_COLLISION')");
    expect(source).toContain("final_delete_not_before = quarantined_at + interval '7 days'");
    expect(source).toContain("expires_at <= issued_at + interval '5 seconds'");
    expect(source).toContain("delete_ticket_jti");
    expect(source).toContain("delete_authorization_jti");
    expect(source).toContain("openclaw_retention_delete_ticket_jti_uidx");
    expect(source).toContain("openclaw_retention_delete_authorization_jti_uidx");
    expect(source).toContain("openclaw_service_nonces_unconsumed_idx");

    expect(source).toMatch(/alter table public\.openclaw_qr_challenges[\s\S]*?alter column ciphertext drop not null/is);
    expect(source).toMatch(/alter table public\.openclaw_qr_challenges[\s\S]*?alter column cipher_iv drop not null/is);
    expect(source).toMatch(/alter table public\.openclaw_qr_challenges[\s\S]*?alter column auth_tag drop not null/is);
    expect(source).toContain("runtime_command_id uuid");
    expect(source).toContain("material_version integer not null default 0");
    expect(source).toContain("openclaw_qr_material_consistency_check");
    expect(source).toContain("openclaw_outbox_schedule_snapshot_fkey");
    expect(source).toContain("openclaw_outbox_crm_subscription_snapshot_fkey");
    expect(source).toContain("smoke_run_id uuid");
    expect(source).toContain("project_ref text");
    expect(source).toContain("shadow_started_at timestamptz");
    expect(source).toContain("lineage_hash text");
    expect(source).toContain("openclaw_retention_holds_release_guard_v1");
  });

  it("uses a no-login dispatcher and exact nested function-owner boundaries", () => {
    const source = sql();
    expect(runtimeOwnedRoutines).toHaveLength(16);
    expect(maintenanceOwnedRoutines).toHaveLength(15);
    expect(routedRoutines).toHaveLength(4);
    expect(new Set([...runtimeOwnedRoutines, ...maintenanceOwnedRoutines, ...routedRoutines])).toEqual(
      new Set(serviceRoutines),
    );

    expect(source).toMatch(
      /create role openclaw_service_dispatcher with NOLOGIN NOINHERIT NOBYPASSRLS/i,
    );
    expect(source).toMatch(/NOBYPASSRLS\s+NOSUPERUSER\s+NOCREATEDB\s+NOCREATEROLE\s+NOREPLICATION/i);
    expect(source).toContain("revoke all on all tables in schema public from openclaw_service_dispatcher");
    expect(source).toContain("revoke all on all sequences in schema public from openclaw_service_dispatcher");
    expect(source).not.toMatch(/\bset\s+(?:local\s+|session\s+)?role\b/i);
    expect(source).not.toMatch(/execute\s+format\s*\(/i);

    for (const name of runtimeOwnedRoutines) {
      expect(source).toMatch(new RegExp(
        `alter function app_private\\.${name}\\(jsonb,jsonb,jsonb\\) owner to openclaw_runtime_writer`,
        "i",
      ));
    }
    for (const name of maintenanceOwnedRoutines) {
      expect(source).toMatch(new RegExp(
        `alter function app_private\\.${name}\\(jsonb,jsonb,jsonb\\) owner to openclaw_maintenance_writer`,
        "i",
      ));
    }
    for (const name of serviceRoutines) {
      const facade = `openclaw_service_${name.slice("openclaw_".length)}`;
      expect(source).toMatch(new RegExp(
        `alter function public\\.${facade}\\(jsonb,jsonb,jsonb\\) owner to openclaw_service_dispatcher`,
        "i",
      ));
      expect(source).toMatch(new RegExp(
        `grant execute on function public\\.${facade}\\(jsonb,jsonb,jsonb\\) to service_role`,
        "i",
      ));
      expect(source).toMatch(new RegExp(
        `revoke all on function public\\.${facade}\\(jsonb,jsonb,jsonb\\) from public, anon, authenticated, service_role`,
        "i",
      ));
      expect(source).toMatch(new RegExp(
        `revoke all on function app_private\\.${name}\\(jsonb,jsonb,jsonb\\) from public, anon, authenticated, service_role`,
        "i",
      ));
      expect(source).toMatch(new RegExp(
        `grant execute on function app_private\\.${name}\\(jsonb,jsonb,jsonb\\) to openclaw_service_dispatcher`,
        "i",
      ));
    }
    expect(source).toContain("grant execute on function app_private.lock_org_for_decision_v1(uuid) to openclaw_function_owner");
    expect(source).toContain("grant execute on function app_private.require_perm_v1(uuid,text,text) to openclaw_function_owner");
    expect(source).not.toMatch(/require_perm_v1\s*\(\s*uuid\s*,\s*text\s*\)/i);
  });

  it("constructs strict JCS send bytes and 2,000-code-point chunks without normalization", () => {
    const source = sql();
    for (const helper of [
      "openclaw_assert_strict_object_v1",
      "openclaw_jcs_text_v1",
      "openclaw_jcs_bytes_v1",
      "openclaw_canonical_send_payload_bytes_v1",
      "openclaw_send_payload_hash_v1",
      "openclaw_text_chunks_v1",
    ]) {
      expect(source).toContain(`app_private.${helper}`);
    }
    expect(source).toContain("jsonb_object_keys");
    expect(source).toContain("jsonb_array_elements");
    expect(source).toContain("jsonb_typeof");
    expect(source).toContain("integer-only JSON number required");
    expect(source).toContain("non-ASCII object key rejected");
    expect(source).toContain("char_length(p_text)");
    expect(source).toContain("substring(p_text from v_offset for 2000)");
    expect(source).toContain("part_count <= 20");
    expect(source).toMatch(
      /convert_to\('ihome-openclaw-'\s*\|\|\s*'send-v1',\s*'UTF8'\)\s*\|\|\s*decode\('00',\s*'hex'\)\s*\|\|\s*app_private\.openclaw_canonical_send_payload_bytes_v1/i,
    );
    expect(source).not.toMatch(/unicode_normalize|normalize\s*\(/i);
    expect(source).toContain("1999 × a + astral + b => 2000,1");
    expect(source).toContain("1000 × decomposed e acute => 2000");
    expect(source).toContain("NFC and NFD payload hashes must differ");
    expect(source).toContain("organizationId");
    expect(source).toContain("replyToProviderMessageId");
    expect(source).toContain("frozenInputs");
    expect(source).toContain("knowledgeVersionIds");
    expect(source).toContain("sourceSnapshotHash");
    expect(source).toContain("targetDirectoryRefreshedAt");
  });

  it("locks browser writers to auth-derived actors, exact permissions and replay-safe operations", () => {
    const source = sql();
    const permissions: Record<(typeof browserWriterRpcs)[number], string> = {
      openclaw_acknowledge_disclosure_v1: "openclaw_zalo.manage_connections",
      openclaw_acknowledge_risk_v1: "openclaw_zalo.manage_connections",
      openclaw_begin_qr_login_v1: "openclaw_zalo.manage_connections",
      openclaw_consume_qr_challenge_v1: "openclaw_zalo.manage_connections",
      openclaw_disconnect_account_v1: "openclaw_zalo.manage_connections",
      openclaw_create_send_intent_v1: "openclaw_zalo.send",
      openclaw_takeover_conversation_v1: "openclaw_zalo.manage_handoff",
      openclaw_release_takeover_v1: "openclaw_zalo.manage_handoff",
      openclaw_resolve_unknown_v1: "openclaw_zalo.manage_operations",
      openclaw_set_control_state_v1: "openclaw_zalo.manage_operations",
      openclaw_publish_automation_v1: "openclaw_zalo.manage_automation",
      openclaw_publish_knowledge_v1: "openclaw_zalo.manage_knowledge",
      openclaw_upsert_group_allowlist_v1: "openclaw_zalo.manage_automation",
      openclaw_upsert_schedule_v1: "openclaw_zalo.manage_automation",
      openclaw_mark_conversation_read_v1: "openclaw_zalo.view",
      openclaw_assign_conversation_v1: "openclaw_zalo.manage_handoff",
      openclaw_create_knowledge_draft_v1: "openclaw_zalo.manage_knowledge",
      openclaw_update_knowledge_draft_v1: "openclaw_zalo.manage_knowledge",
      openclaw_validate_knowledge_v1: "openclaw_zalo.manage_knowledge",
      openclaw_archive_knowledge_v1: "openclaw_zalo.manage_knowledge",
      openclaw_create_automation_draft_v1: "openclaw_zalo.manage_automation",
      openclaw_save_automation_step_v1: "openclaw_zalo.manage_automation",
      openclaw_pause_automation_v1: "openclaw_zalo.manage_automation",
      openclaw_request_directory_sync_v1: "openclaw_zalo.manage_connections",
      openclaw_pause_schedule_v1: "openclaw_zalo.manage_automation",
      openclaw_cancel_schedule_v1: "openclaw_zalo.manage_automation",
      openclaw_create_legal_hold_v1: "openclaw_zalo.manage_operations",
      openclaw_release_legal_hold_v1: "openclaw_zalo.manage_operations",
      openclaw_replay_dead_letter_v1: "openclaw_zalo.manage_operations",
    };

    for (const name of browserWriterRpcs) {
      const fn = functionBody(source, "public", name).definitionSql;
      expect(fn, name).toMatch(/auth\.uid\(\)/i);
      expect(fn, name).toContain("app_private.lock_org_for_decision_v1");
      expect(fn, name).toContain("app_private.require_perm_v1");
      expect(fn, name).toContain(permissions[name]);
      expect(fn, name).toContain("app_private.openclaw_begin_client_operation_v1");
      expect(fn, name).toContain("app_private.openclaw_finish_browser_write_v1");
      expect(fn, name).not.toMatch(/p_actor|p_user_id/i);
    }

    const finisher = functionBody(
      source,
      "app_private",
      "openclaw_finish_browser_write_v1",
    ).definitionSql;
    expect(finisher).toContain("app_private.append_openclaw_audit_v1");
    expect(finisher).toContain("app_private.openclaw_complete_client_operation_v1");

    expect(source).toContain("active organization owner required");
    expect(functionBody(source, "public", "openclaw_create_legal_hold_v1").definitionSql)
      .toContain("openclaw_zalo.audit");
    expect(functionBody(source, "public", "openclaw_release_legal_hold_v1").definitionSql)
      .toContain("openclaw_zalo.audit");
    expect(source).toContain("assigned active user may take over own conversation");
    expect(source).toContain("client operation id reused with a different request");
    expect(source).toContain("safe_result");
    expect(source).toContain("octet_length(safe_result::text) <= 8192");
  });

  it("keeps browser reads bounded, selected-column and secret-free", () => {
    const source = sql();
    const messages = functionBody(source, "public", "openclaw_list_messages_v1").definitionSql;
    expect(messages).toMatch(/least\s*\(\s*coalesce\s*\([^)]*limit[^)]*\)\s*,\s*100\s*\)/i);
    expect(messages).toMatch(/\(\s*m\.received_at\s*,\s*m\.id\s*\)\s*</i);
    expect(messages).toMatch(/order by\s+m\.received_at\s+desc\s*,\s*m\.id\s+desc/i);
    expect(messages).not.toMatch(/select\s+\*/i);

    const unknown = functionBody(source, "public", "openclaw_list_unknown_v1").definitionSql;
    expect(unknown).toContain("authoritative_evidence_hash");
    expect(unknown).toContain("resolution_version");
    expect(unknown).toContain("new_outbox_id");
    expect(unknown).not.toMatch(/update\s+public\.openclaw_outbox/i);

    const overview = functionBody(source, "public", "openclaw_get_overview_v1").definitionSql;
    expect(overview).toContain("unresolvedUnknownCount");
    expect(overview).toContain("resolvedUnknownCount");

    const forbiddenProjectionFields = [
      "credential_hash",
      "ciphertext",
      "cipher_iv",
      "auth_tag",
      "claim_token_hash",
      "marker_nonce_hash",
      "raw_envelope",
      "gateway_receipt",
    ];
    for (const name of browserReadRpcs) {
      const fn = functionBody(source, "public", name).definitionSql;
      expect(fn, name).not.toMatch(/select\s+\*/i);
      for (const field of forbiddenProjectionFields) {
        expect(fn, `${name} leaked ${field}`).not.toContain(field);
      }
    }

    const consumeQr = functionBody(source, "public", "openclaw_consume_qr_challenge_v1").definitionSql;
    expect(consumeQr).not.toMatch(/ciphertextB64|cipherIvB64|authTagB64|\.ciphertext|\.cipher_iv|\.auth_tag/i);
    expect(consumeQr).toMatch(/set\s+challenge_status\s*=\s*'CONSUMED'[\s\S]*?ciphertext\s*=\s*null/i);
    expect(consumeQr).toContain("cipher_iv = null");
    expect(consumeQr).toContain("auth_tag = null");
    expect(consumeQr).toContain("material_version = 0");
    for (const name of [
      "openclaw_list_knowledge_v1",
      "openclaw_list_automations_v1",
      "openclaw_list_sales_groups_v1",
      "openclaw_list_schedules_v1",
    ]) {
      expect(functionBody(source, "public", name).definitionSql, name).toContain("limit v_limit");
    }
  });

  it("implements atomic inbound identity precedence and durable quarantine", () => {
    const body = functionBody(sql(), "app_private", "openclaw_ingest_inbound_batch_v1").definitionSql;
    expect(body).toContain("PROVIDER_EVENT_ID");
    expect(body).toContain("PROVIDER_MESSAGE_ID");
    expect(body).toContain("event ID primary, message ID secondary");
    expect(body).toContain("both stable IDs are null");
    expect(body).toContain("pg_advisory_xact_lock");
    expect(body).toMatch(/order by\s+stable_id_kind\s*,\s*stable_id_value/i);
    expect(body).toContain("openclaw_inbound_collisions");
    expect(body).toContain("QUARANTINED");
    expect(body).not.toMatch(/raise[^;]+QUARANTINED/is);
    expect(body).toContain("openclaw_inbound_automation_decisions");
    expect(body).toContain("openclaw_send_work_items");
    expect(body).toContain("NO_SEND");
    expect(body).toContain("HISTORY_SYNC");
    expect(body).toMatch(
      /stable_id_kind\s*=\s*'PROVIDER_EVENT_ID'[\s\S]*?or\s*\([\s\S]*?stable_id_kind\s*=\s*'PROVIDER_MESSAGE_ID'/i,
    );
    expect(body).not.toMatch(/elsif\s+v_message_stable\s+is\s+not\s+null/i);
  });

  it("enforces claim, authorize, completion, requeue and UNKNOWN CAS state machines", () => {
    const source = sql();
    const claim = functionBody(source, "app_private", "openclaw_claim_outbox_v1").definitionSql;
    expect(claim).toContain("for update skip locked");
    expect(claim).toContain("claim_generation = claim_generation + 1");
    expect(claim).toContain("state = 'LEASED'");

    const preflight = functionBody(source, "app_private", "openclaw_preflight_outbox_v1").definitionSql;
    for (const reason of [
      "GLOBAL_STOP", "MODE_PAUSED", "ACCOUNT_PAUSED", "CAMPAIGN_CANCELLED",
      "TAKEOVER_ACTIVE", "SUPPRESSED", "CONSENT_MISSING", "QUIET_HOURS",
      "RATE_LIMITED", "GROUP_NOT_ALLOWLISTED", "GROUP_DIRECTORY_STALE", "ALLOWED",
    ]) expect(preflight).toContain(reason);
    expect(preflight).toContain("openclaw_send_payload_hash_v1");
    expect(preflight).toContain("interval '15 seconds'");
    expect(preflight).toContain("v_marker_nonce text := gen_random_uuid()::text");
    expect(preflight).toContain("p_request ->> 'claimToken'");
    expect(preflight).toContain("outbox.claim_token_hash = v_claim_token_hash");
    expect(preflight).toContain("'authorizationMarker'");
    for (const field of [
      "'version',1", "'outboxId',v_outbox.id", "'claimGeneration',v_outbox.claim_generation",
      "'payloadHash',v_outbox.payload_hash", "'fencingToken',v_outbox.fencing_token",
      "'sessionGeneration',v_outbox.session_generation", "'controlVersion',v_control_version",
      "'takeoverVersion',v_takeover_version", "'markerNonce',v_marker_nonce",
      "'expiresAt',v_expires_at",
    ]) expect(preflight).toContain(field);
    expect(preflight).not.toContain("p_request ->> 'markerNonce'");
    expect(preflight).not.toContain("'authorizationId'");

    const authorize = functionBody(source, "app_private", "openclaw_authorize_outbox_send_v1").definitionSql;
    expect(authorize).not.toContain("toolName");
    expect(authorize).toContain("state = 'LEASED'");
    expect(authorize).toContain("state = 'DISPATCHING'");
    expect(authorize).toContain("authorized_handoff_at");
    expect(authorize).toContain("consumed_at");
    expect(authorize).toContain("marker_nonce_hash");
    expect(authorize).toContain("claimToken");
    expect(authorize).toContain("claim_token_hash");
    expect(authorize).toContain("authorizationMarker");
    expect(authorize).toContain("v_marker jsonb := p_request -> 'authorizationMarker'");
    expect(authorize).toContain("handoff.outbox_id=(v_marker ->> 'outboxId')::uuid");
    expect(authorize).toContain("handoff.claim_generation=(v_marker ->> 'claimGeneration')::bigint");
    expect(authorize).toContain("handoff.payload_hash=v_marker ->> 'payloadHash'");
    expect(authorize).toContain("handoff.fencing_token=(v_marker ->> 'fencingToken')::bigint");
    expect(authorize).toContain("handoff.session_generation=(v_marker ->> 'sessionGeneration')::bigint");
    expect(authorize).toContain("handoff.control_version=(v_marker ->> 'controlVersion')::bigint");
    expect(authorize).toContain("handoff.takeover_version=(v_marker ->> 'takeoverVersion')::bigint");
    expect(authorize).toContain("handoff.expires_at=(v_marker ->> 'expiresAt')::timestamptz");
    expect(authorize).not.toContain("p_request ->> 'authorizationId'");

    const requeue = functionBody(source, "app_private", "openclaw_requeue_pre_handoff_v1").definitionSql;
    expect(requeue).toContain("authorized_handoff_at is null");
    expect(requeue).toContain("state = 'QUEUED'");
    expect(requeue).toContain("claim_token_hash");
    expect(requeue).toContain("session_generation");
    expect(requeue).toMatch(/claim_generation\s*=\s*outbox\.claim_generation\s*\+\s*1/i);
    expect(requeue).not.toContain("state = 'DISPATCHING'");

    const completion = functionBody(source, "app_private", "openclaw_complete_outbox_v1").definitionSql;
    expect(completion).toContain("state = 'DISPATCHING'");
    expect(completion).toContain("authorized handoff evidence is stale");
    expect(completion).toMatch(
      /handoff\.consumed_at is not null and handoff\.authorized_handoff_at is not null[\s\S]*?authorized handoff evidence is stale/i,
    );
    expect(completion).toContain("known_provider_message_ids");
    expect(completion).toContain("possible_handoff_prefix_length");
    expect(completion).toContain("claim_token_hash");
    expect(completion).toContain("session_generation");

    const sweep = functionBody(source, "app_private", "openclaw_sweep_runtime_v1").definitionSql;
    expect(sweep).toContain("state = 'UNKNOWN'");
    expect(sweep).toContain("state = 'DISPATCHING'");
    expect(sweep).toContain("state = 'QUEUED'");

    const unknown = functionBody(source, "public", "openclaw_resolve_unknown_v1").definitionSql;
    expect(unknown).toContain("expectedResolutionVersion");
    expect(unknown).toContain("resolution_version = 0");
    expect(unknown).toContain("NEW_INTENT_CREATED");
    expect(unknown).toContain("40001");
    expect(unknown).not.toMatch(/set\s+state\s*=/i);
  });

  it("separates channel work from account-independent maintenance work", () => {
    const source = sql();
    const claim = functionBody(source, "app_private", "openclaw_claim_work_item_v1").definitionSql;
    expect(claim).toContain("principalKind");
    expect(claim).toContain("CHANNEL");
    expect(claim).toContain("MAINTENANCE");
    expect(claim).toContain("openclaw_runtime_credentials");
    expect(claim).toContain("openclaw_maintenance_credentials");
    expect(claim).toContain("for update skip locked");
    expect(claim).toContain("credentialGeneration");
    expect(claim).toContain("fencingToken");

    const createOutbox = functionBody(source, "app_private", "openclaw_create_outbox_from_work_v1").definitionSql;
    expect(createOutbox).toContain("openclaw_schedule_snapshots");
    expect(createOutbox).toContain("openclaw_crm_event_subscription_snapshots");
    expect(createOutbox).toContain("source_hash");
    expect(createOutbox).toContain("payload_hash");
    expect(createOutbox).toContain("openclaw_send_payload_hash_v1");
    expect(createOutbox).toContain("GROUP_DIRECTORY_STALE");

    const quarantine = functionBody(source, "app_private", "openclaw_complete_retention_quarantine_v1").definitionSql;
    expect(quarantine).toContain("openclaw_retention_tombstones");
    expect(quarantine).toContain("final_delete_not_before");
    expect(quarantine).toContain("interval '7 days'");
    expect(quarantine).not.toMatch(/http|fetch|r2/i);

    const authorizeDelete = functionBody(source, "app_private", "openclaw_authorize_retention_delete_v1").definitionSql;
    expect(authorizeDelete).toContain("hold_version");
    expect(authorizeDelete).toContain("final_delete_not_before");
    expect(authorizeDelete).toContain("interval '5 seconds'");
    expect(authorizeDelete).toContain("openclaw_retention_delete_authorizations");

    const finalizeDelete = functionBody(source, "app_private", "openclaw_finalize_retention_delete_v1").definitionSql;
    expect(finalizeDelete).toContain("gateway_receipt");
    expect(finalizeDelete).toContain("gateway_signing_key_generation");
    expect(finalizeDelete).toContain("NOT_FOUND");
    expect(finalizeDelete).toContain("receipt_hash");
    expect(finalizeDelete).not.toMatch(/ed25519|public_key|verify_signature/i);

    const audit = functionBody(source, "app_private", "openclaw_ack_audit_anchor_v1").definitionSql;
    expect(audit).toContain("verifyTicketJti");
    expect(audit).toContain("gateway_receipt_hash");
    expect(audit).toContain("auditSigningKeyGeneration");
    expect(audit).not.toMatch(/ed25519|public_key|verify_signature/i);
  });

  it("pins rollout identity, 48-hour SHADOW and smoke-resource cleanup lineage", () => {
    const source = sql();
    const begin = functionBody(source, "app_private", "openclaw_begin_rollout_v1").definitionSql;
    for (const field of [
      "reviewedCommitSha", "migrationManifestSha256", "upstreamSri", "upstreamGitHead",
      "patchSeriesSha256", "builtTgzSha256", "artifactDigests", "projectRef",
    ]) expect(begin).toContain(field);

    const advance = functionBody(source, "app_private", "openclaw_advance_rollout_stage_v1").definitionSql;
    expect(advance).toContain("expectedStageVersion");
    expect(advance).toContain("interval '48 hours'");
    expect(advance).toContain("interval '72 hours'");
    expect(advance).toContain("shadow_started_at");
    expect(advance).toContain("continuous_green_started_at");
    expect(advance).toContain("WAITING_OWNER_QR");
    expect(advance).toContain("WAITING_OWNER_INBOUND");

    const observe = functionBody(source, "app_private", "openclaw_record_smoke_observation_v1").definitionSql;
    expect(observe).toContain("openclaw_smoke_observations");
    expect(observe).toContain("trusted_row_ids");
    expect(observe).toContain("lineage_hash");

    const cleanup = functionBody(source, "app_private", "openclaw_cleanup_smoke_run_v1").definitionSql;
    expect(cleanup).toContain("smoke_run_id");
    expect(cleanup).toContain("state = 'UNKNOWN'");
    expect(cleanup).toContain("DISPATCHING");
    expect(cleanup).not.toMatch(/global_stop\s*=\s*false/i);

    const verify = functionBody(source, "app_private", "openclaw_verify_smoke_cleanup_v1").definitionSql;
    expect(verify).toContain("queued_residual = 0");
    expect(verify).toContain("leased_residual = 0");
    expect(verify).toContain("dispatching_residual = 0");
  });

  it("strict-validates service principals, envelopes and atomically consumes nonces", () => {
    const source = sql();
    const validateContext = functionBody(
      source,
      "app_private",
      "openclaw_validate_service_context_v1",
    ).definitionSql;
    expect(source).toContain("app_private.openclaw_validate_service_context_v1");
    expect(source).toContain("app_private.openclaw_consume_service_nonce_v1");
    expect(source).toContain("openclaw_service_nonces");
    expect(source).toContain("nonce replay rejected");
    expect(source).toContain("envelope operation mismatch");
    expect(source).toContain("credential generation mismatch");
    expect(source).toContain("lease generation mismatch");
    expect(source).toContain("fencing token mismatch");
    expect(validateContext).toContain("channel service operation matrix mismatch");
    expect(validateContext).toContain("maintenance service operation matrix mismatch");
    expect(validateContext).toContain("openclaw_issue_retention_delete_ticket_v1");

    for (const name of authenticatedServiceRoutines) {
      const privateFn = functionBody(source, "app_private", name).definitionSql;
      const facadeName = `openclaw_service_${name.slice("openclaw_".length)}`;
      const facade = functionBody(source, "public", facadeName).definitionSql;
      expect(facade, facadeName).toContain("app_private.openclaw_validate_service_context_v1");
      expect(facade, facadeName).toContain("app_private.openclaw_consume_service_nonce_v1");
      expect(facade, facadeName).toContain(`app_private.${name}`);
      expect(facade, facadeName).not.toMatch(/execute\s+|format\s*\(/i);
      const validateAt = facade.indexOf("app_private.openclaw_validate_service_context_v1");
      const consumeAt = facade.indexOf("app_private.openclaw_consume_service_nonce_v1");
      const privateAt = facade.indexOf(`app_private.${name}`);
      expect(validateAt, facadeName).toBeGreaterThanOrEqual(0);
      expect(consumeAt, facadeName).toBeGreaterThan(validateAt);
      expect(privateAt, facadeName).toBeGreaterThan(consumeAt);
      expect(facade, facadeName).toContain(`'${name}'`);
      expect(privateFn, name).toContain("version");
    }

    for (const name of credentialExchangeRoutines) {
      const privateFn = functionBody(source, "app_private", name).definitionSql;
      const facadeName = `openclaw_service_${name.slice("openclaw_".length)}`;
      const facade = functionBody(source, "public", facadeName).definitionSql;
      expect(privateFn, name).toContain("credentialProofSha256");
      expect(privateFn, name).toContain("requestedOperation");
      expect(privateFn, name).toContain("runtimeMethod");
      expect(privateFn, name).toContain("runtimePath");
      expect(privateFn, name).toContain("runtimeTimestamp");
      expect(privateFn, name).toContain("runtimeNonce");
      expect(privateFn, name).toContain("runtimeBodySha256");
      expect(privateFn, name).toContain("exchangeRequestHash");
      expect(privateFn, name).toContain("authenticatedAt");
      expect(privateFn, name).not.toContain("'allowedScopes'");
      expect(privateFn, name).toContain("app_private.openclaw_secure_digest_equal_v1");
      expect(privateFn, name).toContain("credential exchange denied");
      expect(facade, facadeName).not.toContain(
        "app_private.openclaw_validate_service_context_v1",
      );
      const authenticateAt = facade.indexOf(`app_private.${name}`);
      const consumeAt = facade.indexOf("app_private.openclaw_consume_service_nonce_v1");
      expect(authenticateAt, facadeName).toBeGreaterThanOrEqual(0);
      expect(consumeAt, facadeName).toBeGreaterThan(authenticateAt);
      expect(facade, facadeName).not.toMatch(/execute\s+|format\s*\(/i);
    }
  });

  it("separates exchange nonces from runtime nonces in their own namespace", () => {
    const source = sql();
    expect(source).toMatch(
      /nonce_namespace\s+text\s+not\s+null[\s\S]{0,120}check\s*\(\s*nonce_namespace\s+in\s*\(\s*'RUNTIME'\s*,\s*'EXCHANGE'\s*\)\s*\)/i,
    );
    expect(source).toMatch(
      /openclaw_service_nonces_channel_uidx[\s\S]{0,200}nonce_namespace/i,
    );
    expect(source).toMatch(
      /openclaw_service_nonces_maintenance_uidx[\s\S]{0,200}nonce_namespace/i,
    );

    const consume = functionBody(
      source,
      "app_private",
      "openclaw_consume_service_nonce_v1",
    ).definitionSql;
    expect(consume).toContain("p_namespace");
    expect(consume).toContain("nonce_namespace");
    expect(consume).toMatch(/'RUNTIME'/);
    expect(consume).toMatch(/'EXCHANGE'/);

    for (const name of credentialExchangeRoutines) {
      const facadeName = `openclaw_service_${name.slice("openclaw_".length)}`;
      const facade = functionBody(source, "public", facadeName).definitionSql;
      expect(facade, facadeName).toMatch(/openclaw_consume_service_nonce_v1\([\s\S]{0,160}'EXCHANGE'/);
    }

    for (const name of authenticatedServiceRoutines) {
      const facadeName = `openclaw_service_${name.slice("openclaw_".length)}`;
      const facade = functionBody(source, "public", facadeName).definitionSql;
      expect(facade, facadeName).toMatch(/openclaw_consume_service_nonce_v1\([\s\S]{0,160}'RUNTIME'/);
    }
  });
});
