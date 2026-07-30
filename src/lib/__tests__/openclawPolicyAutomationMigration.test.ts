import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sql = () => readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260727030000_openclaw_policy_automation_knowledge.sql"),
  "utf8",
);

const tables = [
  "openclaw_consents",
  "openclaw_suppressions",
  "openclaw_policies",
  "openclaw_policy_versions",
  "openclaw_control_states",
  "openclaw_takeovers",
  "openclaw_automations",
  "openclaw_automation_versions",
  "openclaw_campaigns",
  "openclaw_campaign_runs",
  "openclaw_schedules",
  "openclaw_crm_event_subscriptions",
  "openclaw_sales_group_allowlists",
  "openclaw_knowledge_sources",
  "openclaw_knowledge_versions",
  "openclaw_knowledge_chunks",
] as const;

describe("OpenClaw policy, automation and knowledge migration", () => {
  it("creates all tenant-scoped tables with forced deny-by-default RLS", () => {
    const migration = sql();
    for (const table of tables) {
      expect(migration).toMatch(new RegExp(`create table public\\.${table}\\b`, "i"));
      expect(migration).toMatch(new RegExp(`alter table public\\.${table} enable row level security`, "i"));
      expect(migration).toMatch(new RegExp(`alter table public\\.${table} force row level security`, "i"));
      expect(migration).toMatch(new RegExp(`revoke all on public\\.${table} from public, anon, authenticated, service_role`, "i"));
      expect(migration).toMatch(new RegExp(`unique \\(organization_id, id\\)`, "i"));
    }
  });

  it("makes organization GLOBAL_STOP first-class and every automatic mode default-off", () => {
    const migration = sql();
    expect(migration).toContain("control_key text not null default 'GLOBAL_STOP'");
    expect(migration).toContain("primary key (organization_id, control_key)");
    expect(migration).toContain("control_version bigint not null default 1");
    for (const flag of [
      "feature_enabled boolean not null default false",
      "limited_auto_reply_enabled boolean not null default false",
      "proactive_enabled boolean not null default false",
      "sales_groups_enabled boolean not null default false",
      "first_contact_enabled boolean not null default false",
    ]) expect(migration).toContain(flag);
    expect(migration).toContain("disclosure_version integer not null");
  });

  it("freezes policy, automation, schedule, campaign and CRM lineage", () => {
    const migration = sql();
    expect(migration).toContain("openclaw_policy_versions_append_only");
    expect(migration).toContain("openclaw_automation_versions_append_only");
    expect(migration).toContain("template_body text not null");
    expect(migration).toContain("allowed_crm_fields text[] not null");
    expect(migration).toContain("missing_value_policy IN ('REJECT','EMPTY','OMIT')");
    expect(migration).toContain("escaping_mode IN ('PLAIN_TEXT','CONTROL_SAFE')");
    expect(migration).toContain("maximum_rendered_codepoints integer not null");
    expect(migration).toContain("content_version_id uuid not null");
    expect(migration).toMatch(/foreign key \(organization_id, account_id, automation_version_id\)/i);
    expect(migration).toContain("subscription_version bigint not null");
    expect(migration).toContain("schedule_version bigint not null");
    expect(migration).toContain("cancellation_version bigint not null");
  });

  it("stores evidence-backed consent, suppression, takeover and group freshness", () => {
    const migration = sql();
    expect(migration).toContain("consent_source text not null");
    expect(migration).toContain("evidence_hash text not null");
    expect(migration).toContain("expires_at timestamptz");
    expect(migration).toContain("suppression_reason text not null");
    expect(migration).toContain("takeover_version bigint not null");
    expect(migration).toContain("directory_expires_at = directory_refreshed_at + interval '24 hours'");
    expect(migration).toContain("sales_group_target_kind text not null default 'SALES_GROUP'");
    expect(migration).toMatch(/foreign key \(organization_id, account_id, sales_group_target_id, sales_group_target_kind\)/i);
  });

  it("uses exact CRM event types and immutable knowledge sensitivity", () => {
    const migration = sql();
    expect(migration).toContain("event_type IN ('lead_created_or_assigned','room_became_available','sales_task_due')");
    expect(migration).toContain("sensitivity IN ('CUSTOMER_SAFE','INTERNAL_REVIEW_ONLY','RESTRICTED')");
    expect(migration).toMatch(/foreign key \(organization_id, account_id, source_id, knowledge_version_id, sensitivity\)/i);
    expect(migration).toContain("openclaw_knowledge_versions_append_only");
    expect(migration).toContain("openclaw_knowledge_chunks_customer_safe_idx");
  });
});
