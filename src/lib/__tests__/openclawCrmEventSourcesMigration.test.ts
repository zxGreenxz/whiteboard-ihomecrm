import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260727070000_openclaw_crm_event_sources.sql",
);

const source = () => readFileSync(migrationPath, "utf8");

const functionBody = (sql: string, schema: "public" | "app_private", name: string) => {
  const match = sql.match(new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${schema}\\.${name}\\s*\\([\\s\\S]*?\\)\\s*returns[\\s\\S]*?as\\s+\\$function\\$([\\s\\S]*?)\\$function\\$;`,
    "i",
  ));
  expect(match, `missing ${schema}.${name}`).not.toBeNull();
  return match![1];
};

describe("OpenClaw typed CRM occurrence sources migration", () => {
  it("creates only the three typed event families with exact subtype/source pairs", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const sql = source();
    expect(sql).toMatch(/create table public\.openclaw_crm_event_occurrences\s*\(/i);
    expect(sql).toContain("event_type in ('lead_created_or_assigned','room_became_available','sales_task_due')");
    expect(sql).toContain("event_subtype in ('CREATED','ASSIGNED','REASSIGNED')");
    expect(sql).toContain("event_subtype = 'FINAL_STATUS_AVAILABLE'");
    expect(sql).toContain("event_subtype = 'FOLLOW_UP_DUE'");
    expect(sql).toContain("source_table = 'leads'");
    expect(sql).toContain("source_table = 'rooms'");
    expect(sql).toContain("source_table = 'lead_activities'");
    expect(sql).toContain("unique (organization_id,event_type,source_table,source_id,source_version)");
    expect(sql).toContain("source_version bigint not null check (source_version > 0)");
    expect(sql).toContain("openclaw_crm_event_occurrences_pair_check");
    expect(sql).not.toMatch(/event_type\s*=\s*'(?:CREATED|ASSIGNED|REASSIGNED|FINAL_STATUS_AVAILABLE|FOLLOW_UP_DUE)'/i);
  });

  it("keeps CRM subscriptions on event families and rejects subtype subscriptions", () => {
    const sql = source();
    expect(sql).toContain("openclaw_crm_event_subscriptions_event_type_check");
    expect(sql).toContain("event_type in ('lead_created_or_assigned','room_became_available','sales_task_due')");
    const constraint = sql.match(
      /add constraint openclaw_crm_event_subscriptions_event_type_check\s+check\s*\(([\s\S]*?)\);/i,
    );
    expect(constraint).not.toBeNull();
    expect(constraint![1]).not.toMatch(/'(?:CREATED|ASSIGNED|REASSIGNED|FINAL_STATUS_AVAILABLE|FOLLOW_UP_DUE)'/i);
  });

  it("emits exactly one CREATED lead occurrence and assignment transitions with frozen assignee", () => {
    const sql = source();
    const body = functionBody(sql, "app_private", "openclaw_emit_lead_occurrence_v1");
    expect(sql).toMatch(/after insert or update of assigned_staff_id on public\.leads/i);
    expect(body).toContain("if TG_OP = 'INSERT' then");
    expect(body).toContain("v_subtype := 'CREATED'");
    expect(body).toContain("OLD.assigned_staff_id is null and NEW.assigned_staff_id is not null");
    expect(body).toContain("v_subtype := 'ASSIGNED'");
    expect(body).toMatch(/NEW\.assigned_staff_id is not null\s+and OLD\.assigned_staff_id is distinct from NEW\.assigned_staff_id/i);
    expect(body).toContain("OLD.assigned_staff_id is distinct from NEW.assigned_staff_id");
    expect(body).toContain("v_subtype := 'REASSIGNED'");
    expect(body).toContain("'assignedStaffId',NEW.assigned_staff_id");
    expect(body).toContain("'eventType','lead_created_or_assigned'");
    expect(body).toContain("'eventSubtype',v_subtype");
    expect(body).toContain("NEW.organization_id");
    expect(body).toContain("NEW.updated_at");
    expect(body).toMatch(/to_char\(\s*NEW\.created_at at time zone 'UTC'/i);
    expect(body).toMatch(/to_char\(\s*NEW\.updated_at at time zone 'UTC'/i);
    expect(body).toContain("NEW.openclaw_assignment_revision");
    expect(body).not.toMatch(/event_type\s*,[\s\S]{0,100}v_subtype/i);

    const revisionBody = functionBody(sql, "app_private", "openclaw_bump_lead_assignment_revision_v1");
    expect(revisionBody).toContain("if TG_OP = 'INSERT' then");
    expect(revisionBody).toContain("NEW.openclaw_assignment_revision is distinct from 1");
    expect(sql).toMatch(/before insert or update of assigned_staff_id,openclaw_assignment_revision on public\.leads/i);
  });

  it("emits room availability only after reservation reconciliation leaves the final row AVAILABLE", () => {
    const sql = source();
    const body = functionBody(sql, "public", "trg_room_status_reconcile");
    expect(body).toContain("perform public.recompute_room_reservation(NEW.id)");
    expect(body).toMatch(/select room\.\* into v_final[\s\S]*?from public\.rooms room/i);
    expect(body.indexOf("recompute_room_reservation")).toBeLessThan(body.indexOf("select room.* into v_final"));
    expect(body).toContain("v_final.status = 'AVAILABLE'");
    expect(body).toContain("OLD.status is distinct from 'AVAILABLE'");
    expect(body).toContain("v_final.openclaw_availability_revision");
    expect(body).toMatch(/to_char\(\s*v_final\.updated_at at time zone 'UTC'/i);
    expect(body).toContain("'room_became_available'");
    expect(body).toContain("'FINAL_STATUS_AVAILABLE'");
    expect(sql).toMatch(/for each row when \(NEW\.status = 'AVAILABLE'\)/i);

    const revisionBody = functionBody(sql, "app_private", "openclaw_bump_room_availability_revision_v1");
    expect(revisionBody).toContain("if TG_OP = 'INSERT' then");
    expect(revisionBody).toContain("NEW.openclaw_availability_revision is distinct from 1");
    expect(sql).toMatch(/before insert or update of status,openclaw_availability_revision on public\.rooms/i);
  });

  it("sweeps due incomplete FOLLOW_UP rows idempotently with schedule-stable versions", () => {
    const sql = source();
    const body = functionBody(sql, "app_private", "openclaw_sweep_due_sales_tasks_v1");
    const insertBody = functionBody(sql, "app_private", "openclaw_insert_crm_occurrence_v1");
    expect(body).toContain("task.activity_type = 'FOLLOW_UP'");
    expect(body).toContain("task.openclaw_scheduled_at_utc <= statement_timestamp()");
    expect(body).toContain("task.completed_at is null");
    expect(body).toContain("task.organization_id = lead.organization_id");
    expect(body).toContain("for update of task skip locked");
    expect(body).toContain("limit v_limit");
    expect(body).toContain("'sales_task_due'");
    expect(body).toContain("'FOLLOW_UP_DUE'");
    expect(body).toContain("activity.openclaw_scheduled_at_utc");
    expect(body).toContain("activity.openclaw_schedule_timezone");
    expect(body).toContain("activity.openclaw_schedule_revision");
    expect(body).toContain("'scheduledAtUtc'");
    expect(body).toContain("'scheduleTimezone'");
    expect(body).toContain("activity.openclaw_scheduled_at_utc");
    expect(insertBody).toContain("p_occurred_at");
    expect(insertBody).toContain("on conflict (organization_id,event_type,source_table,source_id,source_version) do nothing");
    expect(insertBody).toContain("typed CRM occurrence conflict mismatch");
    expect(body).not.toMatch(/source_version[\s\S]{0,160}statement_timestamp\(\)/i);
    expect(body).toMatch(/not exists\s*\([\s\S]*?openclaw_crm_event_occurrences[\s\S]*?task\.openclaw_schedule_revision[\s\S]*?\)/i);

    const revisionBody = functionBody(sql, "app_private", "openclaw_bump_sales_task_schedule_revision_v1");
    expect(revisionBody).toContain("if TG_OP = 'INSERT' then");
    expect(revisionBody).toContain("NEW.openclaw_schedule_revision is distinct from 1");
    expect(revisionBody).toContain("OLD.openclaw_schedule_timezone is distinct from NEW.openclaw_schedule_timezone");
    expect(revisionBody).toContain("v_scheduled_at_utc := NEW.scheduled_at at time zone NEW.openclaw_schedule_timezone");
    expect(revisionBody).toContain("NEW.openclaw_scheduled_at_utc := v_scheduled_at_utc");
    expect(sql).toContain("openclaw_schedule_timezone text not null default 'Asia/Ho_Chi_Minh'");
    expect(sql).toContain("openclaw_scheduled_at_utc timestamptz");
    expect(sql).toMatch(/before insert or update of scheduled_at,openclaw_schedule_timezone,openclaw_scheduled_at_utc,openclaw_schedule_revision on public\.lead_activities/i);
    expect(sql).toMatch(/create index openclaw_lead_activities_due_follow_up_idx[\s\S]*?on public\.lead_activities\s*\(openclaw_scheduled_at_utc,id\)[\s\S]*?where activity_type = 'FOLLOW_UP'[\s\S]*?completed_at is null/i);
  });

  it("binds activity tenant to the trusted parent lead and rejects cross-tenant source lookup", () => {
    const sql = source();
    const bindingBody = functionBody(sql, "app_private", "openclaw_bind_sales_task_organization_v1");
    const insertBody = functionBody(sql, "app_private", "openclaw_insert_crm_occurrence_v1");
    expect(sql).toMatch(/update public\.lead_activities task[\s\S]*?set organization_id = lead\.organization_id[\s\S]*?from public\.leads lead[\s\S]*?task\.lead_id = lead\.id/i);
    expect(bindingBody).toMatch(/select lead\.organization_id,lead\.building_id[\s\S]*?from public\.leads lead[\s\S]*?lead\.id = NEW\.lead_id/i);
    expect(bindingBody).toContain("perform app_private.lock_org_for_decision_v1(v_organization_id)");
    expect(bindingBody).toContain("app_private.authorize_tenant_action_v3(");
    expect(bindingBody).toContain("app_private.authorized_scope_v3(v_permission_key,v_organization_id)");
    expect(bindingBody).toContain("cardinality(scope.building_ids)");
    expect(bindingBody).toContain("v_permission_key");
    expect(bindingBody).toContain("v_building_id");
    expect(bindingBody).toContain("for share of lead");
    expect(bindingBody).toContain("v_is_trusted");
    expect(bindingBody).toContain("if not v_is_trusted then");
    expect(bindingBody).toContain("if v_actor_id is null then");
    expect(bindingBody.indexOf("if not v_is_trusted then")).toBeLessThan(
      bindingBody.indexOf("if v_actor_id is null then"),
    );
    expect(bindingBody).toContain("sales task parent lead is outside the caller");
    expect(bindingBody).toContain("request.jwt.claim.role");
    expect(bindingBody).toContain("request.jwt.claims");
    expect(bindingBody).toContain("NEW.organization_id := v_organization_id");
    expect(bindingBody).toContain("sales task organization does not match parent lead");
    expect(sql).toMatch(/before insert or update of lead_id,organization_id on public\.lead_activities/i);
    expect(insertBody).toContain("typed CRM occurrence source organization mismatch");
    expect(insertBody).toContain("from public.leads source_row");
    expect(insertBody).toContain("from public.rooms source_row");
    expect(insertBody).toContain("from public.lead_activities source_row");
    expect(sql).toContain("to_regprocedure('app_private.authorized_scope_v3(text,uuid)') is null");
    // The preflight names the dependency this file actually has. It used to name
    // auth.uid(), which openclaw_function_owner cannot reach on Supabase - checking
    // for a function the caller may not call proves nothing about being able to run.
    expect(sql).toContain("to_regprocedure('app_private.openclaw_actor_id_v1()') is null");
    expect(sql).toMatch(/grant execute on function app_private\.authorize_tenant_action_v3\(uuid,uuid,text,uuid,uuid\)\s+to openclaw_function_owner/i);
    expect(sql).toMatch(/grant execute on function app_private\.authorized_scope_v3\(text,uuid\)\s+to openclaw_function_owner/i);
    // The opposite of what this used to assert, and for a reason measured in
    // production: `grant usage on schema auth` is silently discarded when postgres
    // is not a member of supabase_admin, so a migration that issues it reports
    // success while every browser RPC raises 42501. Asserting its ABSENCE stops the
    // dependency being reintroduced by someone who reads the discarded grant as
    // proof that it works.
    // Anchored to the start of a line: the comment above the removal explains the
    // grant by name, and a substring check would match the explanation and call it
    // a violation.
    expect(sql).not.toMatch(/^\s*grant\s+usage\s+on\s+schema\s+auth\b/imu);
    expect(sql).not.toMatch(/^\s*grant\s+execute\s+on\s+function\s+auth\.uid\(\)/imu);
    expect(sql).toMatch(/grant update \(openclaw_assignment_revision\) on public\.leads\s+to openclaw_function_owner/i);
    expect(sql).toMatch(/create policy openclaw_crm_sources_function_owner_leads_lock\s+on public\.leads for update to openclaw_function_owner\s+using \(true\) with check \(true\)/i);
    expect(sql).not.toMatch(/alter table public\.lead_activities\s+alter column organization_id set not null/i);
  });

  it("hashes event-specific snapshots and keeps occurrences append-only and tenant-closed", () => {
    const sql = source();
    expect(sql).toContain("ihome-openclaw-crm-snapshot-v1");
    expect(sql).toContain("app_private.openclaw_jcs_bytes_v1");
    expect(sql).toContain("snapshot_bytes bytea not null");
    expect(sql).toContain("snapshot_hash text not null");
    expect(sql).toContain("openclaw_crm_event_occurrences_append_only");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("force row level security");
    expect(sql).toContain("revoke all on public.openclaw_crm_event_occurrences from public, anon, authenticated, service_role");
    expect(sql).toContain("grant usage on schema extensions to openclaw_function_owner");
    expect(sql).toContain("grant execute on function extensions.digest(bytea,text) to openclaw_function_owner");
    expect(sql).not.toContain("aaaa0000-0000-4000-8000-000000000001");
  });
});
