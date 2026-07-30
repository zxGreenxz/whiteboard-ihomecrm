import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationFiles = [
  "20260727010000_openclaw_catalog_foundation.sql",
  "20260727015000_openclaw_security_principals.sql",
  "20260727020000_openclaw_inbox_schema.sql",
  "20260727025000_openclaw_inbound_automation.sql",
  "20260727030000_openclaw_policy_automation_knowledge.sql",
  "20260727040000_openclaw_delivery_audit_ops.sql",
  "20260727050000_openclaw_access_policies.sql",
] as const;

const readMigration = (file: string) => readFileSync(
  resolve(process.cwd(), "supabase/migrations", file),
  "utf8",
);

const accessSql = () => readMigration(migrationFiles.at(-1)!);
const allSql = () => migrationFiles.map(readMigration).join("\n");
const compact = (value: string) => value
  .replace(/\s+/g, " ")
  .replace(/\(\s+/g, "(")
  .replace(/\s+\)/g, ")")
  .trim()
  .toLowerCase();

const expectedPolicyPermissions = {
  openclaw_accounts: "openclaw_zalo.view",
  openclaw_account_connections: "openclaw_zalo.view",
  openclaw_runtime_cells: "openclaw_zalo.view",
  openclaw_contacts: "openclaw_zalo.view",
  openclaw_sales_groups: "openclaw_zalo.view",
  openclaw_targets: "openclaw_zalo.view",
  openclaw_conversations: "openclaw_zalo.view",
  openclaw_conversation_members: "openclaw_zalo.view",
  openclaw_messages: "openclaw_zalo.view",
  openclaw_message_media: "openclaw_zalo.view",
  openclaw_control_states: "openclaw_zalo.view",
  openclaw_takeovers: "openclaw_zalo.view",
  openclaw_policies: "openclaw_zalo.manage_automation",
  openclaw_campaigns: "openclaw_zalo.manage_automation",
  openclaw_campaign_runs: "openclaw_zalo.manage_automation",
  openclaw_schedules: "openclaw_zalo.manage_automation",
  openclaw_crm_event_subscriptions: "openclaw_zalo.manage_automation",
  openclaw_sales_group_allowlists: "openclaw_zalo.manage_automation",
  openclaw_audit_roots: "openclaw_zalo.audit",
  openclaw_health_events: "openclaw_zalo.audit",
  openclaw_rollout_runs: "openclaw_zalo.audit",
  openclaw_rollout_observations: "openclaw_zalo.audit",
  openclaw_rollout_checkpoints: "openclaw_zalo.audit",
  openclaw_smoke_runs: "openclaw_zalo.audit",
  openclaw_smoke_cleanup_proofs: "openclaw_zalo.audit",
} as const;

const expectedColumnGrants = {
  openclaw_accounts: [
    "id", "organization_id", "account_profile", "display_name", "is_active",
    "connection_state", "session_risk_state", "configured_mode", "effective_mode",
    "connection_generation", "disclosure_version", "disclosure_acknowledged_version",
    "disclosure_acknowledged_at", "paused_at", "created_at", "updated_at",
  ],
  openclaw_account_connections: [
    "id", "organization_id", "account_id", "connection_generation", "connection_state",
    "session_risk_state", "configured_mode", "effective_mode", "reason_code",
    "disclosure_version", "disclosure_acknowledged_version", "changed_at",
  ],
  openclaw_runtime_cells: [
    "id", "organization_id", "account_id", "cell_generation", "state", "is_current",
    "last_heartbeat_at", "created_at", "retired_at",
  ],
  openclaw_contacts: [
    "id", "organization_id", "account_id", "display_name", "directory_version",
    "directory_refreshed_at", "created_at", "updated_at",
  ],
  openclaw_sales_groups: [
    "id", "organization_id", "account_id", "display_name", "member_count",
    "directory_version", "directory_refreshed_at", "created_at", "updated_at",
  ],
  openclaw_targets: [
    "id", "organization_id", "account_id", "kind", "contact_id", "sales_group_id",
    "target_version", "directory_refreshed_at", "is_active", "created_at", "updated_at",
  ],
  openclaw_conversations: [
    "id", "organization_id", "account_id", "target_id", "status",
    "assigned_membership_id", "unread_count", "last_received_at", "last_message_id",
    "version", "created_at", "updated_at",
  ],
  openclaw_conversation_members: [
    "id", "organization_id", "account_id", "conversation_id", "display_name",
    "member_role", "joined_at", "left_at", "created_at",
  ],
  openclaw_messages: [
    "id", "organization_id", "account_id", "conversation_id", "direction", "event_kind",
    "provider_timestamp", "received_at", "created_at",
  ],
  openclaw_message_media: [
    "id", "organization_id", "account_id", "conversation_id", "message_id", "media_index",
    "media_kind", "mime", "byte_length", "byte_state", "retention_delete_not_before",
    "created_at", "updated_at",
  ],
  openclaw_control_states: [
    "id", "organization_id", "control_key", "global_stop", "feature_enabled",
    "limited_auto_reply_enabled", "proactive_enabled", "sales_groups_enabled",
    "first_contact_enabled", "control_version", "disclosure_version", "updated_at",
  ],
  openclaw_takeovers: [
    "id", "organization_id", "account_id", "conversation_id", "owner_membership_id",
    "takeover_version", "started_at", "expires_at", "released_at",
  ],
  openclaw_policies: [
    "id", "organization_id", "account_id", "name", "lifecycle_state", "current_version",
    "created_at", "updated_at",
  ],
  openclaw_automations: [
    "id", "organization_id", "account_id", "name", "automation_kind", "lifecycle_state",
    "current_version", "created_at", "updated_at",
  ],
  openclaw_campaigns: [
    "id", "organization_id", "account_id", "automation_version_id", "name", "status",
    "cancellation_version", "cancelled_at", "created_at", "updated_at",
  ],
  openclaw_campaign_runs: [
    "id", "organization_id", "account_id", "campaign_id", "campaign_version",
    "automation_version_id", "run_key", "status", "started_at", "finished_at", "created_at",
  ],
  openclaw_schedules: [
    "id", "organization_id", "account_id", "automation_version_id", "target_id", "campaign_id",
    "schedule_version", "status", "timezone", "local_recurrence_rule", "next_run_at",
    "missed_occurrence_policy", "created_at", "updated_at",
  ],
  openclaw_crm_event_subscriptions: [
    "id", "organization_id", "account_id", "automation_version_id", "destination_target_id",
    "event_type", "subscription_version", "is_active", "created_at", "updated_at",
  ],
  openclaw_sales_group_allowlists: [
    "id", "organization_id", "account_id", "sales_group_target_id", "sales_group_target_kind",
    "allowlist_version", "is_allowed", "directory_refreshed_at", "directory_expires_at",
    "approved_at", "created_at",
  ],
  openclaw_knowledge_sources: [
    "id", "organization_id", "account_id", "title", "source_kind", "sensitivity",
    "lifecycle_state", "current_version", "created_at", "updated_at",
  ],
  openclaw_audit_roots: [
    "id", "organization_id", "root_date", "first_sequence", "last_sequence", "root_hash",
    "event_count", "signing_key_generation", "signature_algorithm", "signature_hash",
    "gateway_receipt_hash", "anchored_at", "created_at",
  ],
  openclaw_health_events: [
    "id", "organization_id", "account_id", "cell_id", "severity", "health_kind", "status",
    "fingerprint", "content_free_metrics", "observed_at", "created_at",
  ],
  openclaw_rollout_runs: [
    "id", "organization_id", "stage", "stage_version", "continuous_green_started_at",
    "status", "started_at", "completed_at",
  ],
  openclaw_rollout_observations: [
    "id", "organization_id", "rollout_run_id", "stage", "window_started_at", "window_ended_at",
    "passed", "content_free_metrics", "observation_hash", "created_at",
  ],
  openclaw_rollout_checkpoints: [
    "id", "organization_id", "rollout_run_id", "checkpoint_name", "stage", "status",
    "trusted_evidence_hash", "created_at", "completed_at",
  ],
  openclaw_smoke_runs: [
    "id", "organization_id", "rollout_run_id", "cleanup_generation", "status",
    "started_at", "finished_at",
  ],
  openclaw_smoke_cleanup_proofs: [
    "id", "organization_id", "smoke_run_id", "cleanup_generation", "queued_residual",
    "leased_residual", "dispatching_residual", "proof_hash", "verified_at",
  ],
} as const;

const rpcOnlyTables = [
  "openclaw_runtime_leases",
  "openclaw_runtime_credentials",
  "openclaw_maintenance_principals",
  "openclaw_maintenance_leases",
  "openclaw_maintenance_credentials",
  "openclaw_qr_challenges",
  "openclaw_inbound_events",
  "openclaw_inbound_provider_identities",
  "openclaw_inbound_automation_decisions",
  "openclaw_ai_drafts",
  "openclaw_consents",
  "openclaw_suppressions",
  "openclaw_policy_versions",
  "openclaw_automation_versions",
  "openclaw_knowledge_versions",
  "openclaw_knowledge_chunks",
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
  "openclaw_retention_holds",
] as const;

describe("OpenClaw tenant-safe access policy migration", () => {
  it("keeps all 54 canonical tables forced-RLS and default-deny", () => {
    const sql = allSql();
    const tables = [...sql.matchAll(/create table public\.(openclaw_[a-z0-9_]+)\s*\(/gi)]
      .map((match) => match[1]);
    expect(new Set(tables).size).toBe(54);
    for (const table of new Set(tables)) {
      expect(sql).toMatch(new RegExp(`alter table public\\.${table} enable row level security`, "i"));
      expect(sql).toMatch(new RegExp(`alter table public\\.${table} force row level security`, "i"));
      expect(sql).toMatch(new RegExp(
        `revoke all on public\\.${table} from public, anon, authenticated, service_role`,
        "i",
      ));
    }
  });

  it("derives authorized organizations through the exact row organization", () => {
    const sql = accessSql();
    expect(allSql()).not.toMatch(
      /grant\s+usage\s+on\s+schema\s+app_private\s+to\s+[^;]*\bauthenticated\b/is,
    );
    expect(sql).toMatch(
      /revoke\s+usage\s+on\s+schema\s+app_private\s+from\s+public,\s*anon,\s*authenticated,\s*service_role;/i,
    );
    expect(sql).toContain("app_private.openclaw_authorized_org_ids_v1");
    expect(sql).toContain("app_private.openclaw_can_org_v1");
    expect(sql).toContain("unnest(public.my_org_ids())");
    expect(compact(sql)).toContain(
      "app_private.authorized_scope_v3(p_permission_key, candidate.organization_id)",
    );
    expect(sql).toContain("scope.org_wide");
    expect(sql).not.toContain("has_any_scope_v3");
    expect(sql).toMatch(/returns setof uuid[\s\S]*stable[\s\S]*security definer[\s\S]*set search_path = ''/i);
    expect(sql).toContain("grant execute on function public.my_org_ids() to openclaw_function_owner");
    expect(sql).toContain(
      "grant execute on function app_private.authorized_scope_v3(text, uuid) to openclaw_function_owner",
    );
  });

  it("exposes only selected columns through org-aware read policies", () => {
    const sql = accessSql();
    const normalized = compact(sql);
    const schema = allSql();
    for (const [table, columns] of Object.entries(expectedColumnGrants)) {
      expect(normalized).toContain(
        compact(`grant select (${columns.join(", ")}) on public.${table} to authenticated;`),
      );
      const grants = [...sql.matchAll(new RegExp(
        `grant select \\(([^)]+)\\) on public\\.${table} to authenticated;`,
        "gi",
      ))];
      expect(grants, `expected one column grant for ${table}`).toHaveLength(1);
      expect(grants[0][1].split(",").map((column) => column.trim().toLowerCase())).toEqual(columns);
      const definition = schema.match(new RegExp(
        `create table public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
        "i",
      ));
      expect(definition, `missing table definition for ${table}`).not.toBeNull();
      for (const column of columns) {
        expect(definition![1], `${table}.${column} must exist`).toMatch(
          new RegExp(`^\\s*${column}\\s+`, "mi"),
        );
      }
    }
    for (const [table, permission] of Object.entries(expectedPolicyPermissions)) {
      expect(sql).toMatch(new RegExp(
        `create policy ${table}_authenticated_[a-z_]+_select[\\s\\S]*?on public\\.${table}[\\s\\S]*?for select to authenticated[\\s\\S]*?organization_id in \\(\\s*select app_private\\.openclaw_authorized_org_ids_v1\\('${permission.replace(".", "\\.")}?'\\)`,
        "i",
      ));
    }
    expect(sql).not.toMatch(/grant\s+select\s+on\s+(?:table\s+)?public\.openclaw_/i);
    expect(sql).not.toMatch(/select\s+\*/i);
    const authenticatedPolicies = [
      ...sql.matchAll(/create policy ([^;]+?)\s+to authenticated\s+using\s*\(([^;]+)\);/gis),
    ];
    expect(authenticatedPolicies).toHaveLength(29);
    for (const policy of authenticatedPolicies) {
      expect(policy[2], policy[1]).toContain("organization_id");
      expect(policy[2], policy[1]).toContain("openclaw_authorized_org_ids_v1");
      expect(policy[2], policy[1]).not.toMatch(/^\s*true\s*$/i);
    }
  });

  it("keeps sensitive canonical rows RPC/service-only", () => {
    const sql = accessSql();
    for (const table of rpcOnlyTables) {
      expect(sql).not.toMatch(new RegExp(
        `grant select \\([^;]+\\) on public\\.${table} to authenticated`,
        "i",
      ));
      expect(sql).not.toMatch(new RegExp(
        `create policy [^;]+ on public\\.${table}[^;]+to authenticated`,
        "i",
      ));
    }
    expect(sql).not.toMatch(/grant[^;]*\b(?:insert|update|delete)\b[^;]*to authenticated/is);
    expect(sql).not.toMatch(/grant[^;]*on[^;]*public\.openclaw_[^;]*to (?:public|anon|service_role)/is);
  });

  it("filters published metadata and retains indexed org/account paths", () => {
    const sql = accessSql();
    expect(sql).toContain("lifecycle_state in ('PUBLISHED','PAUSED')");
    expect(sql).toContain("lifecycle_state = 'PUBLISHED' and sensitivity = 'CUSTOMER_SAFE'");
    expect(sql).toContain("openclaw_automations_authenticated_manage_automation_select");
    expect(sql).toContain("openclaw_knowledge_sources_authenticated_manage_knowledge_select");
    expect(sql).toContain("openclaw_health_events_account_dashboard_idx");
    for (const index of [
      "openclaw_accounts_one_active_per_org_uidx",
      "openclaw_conversations_active_idx",
      "openclaw_messages_thread_cursor_idx",
      "openclaw_outbox_unknown_idx",
      "openclaw_dead_letters_idx",
    ]) expect(allSql()).toContain(index);
    expect(accessSql().trimEnd().toLowerCase().endsWith("commit;")).toBe(true);
  });
});
