begin;

do $openclaw_owner_grants$
declare
  v_role text;
  v_schema text;
begin
  -- No-op on a superuser harness: superusers already satisfy both checks below.
  -- On Supabase the connected role is the non-superuser `postgres`, which needs
  -- SET on each owner role (PostgreSQL 16+ withholds it from role creators) and
  -- needs each owner role to hold CREATE on the schema it will own objects in.
  -- Both are revoked again at the end of this file.
  for v_role in
    select rolname from pg_catalog.pg_roles where rolname like 'openclaw\_%'
  loop
    if not pg_catalog.pg_has_role(current_user, v_role, 'SET') then
      execute format('grant %I to %I with set true', v_role, current_user);
    end if;
    foreach v_schema in array array['public', 'app_private'] loop
      if pg_catalog.to_regnamespace(v_schema) is not null
         and not pg_catalog.has_schema_privilege(v_role, v_schema, 'CREATE') then
        execute format('grant create on schema %I to %I', v_schema, v_role);
      end if;
    end loop;
  end loop;
end
$openclaw_owner_grants$;

create table public.openclaw_inbound_automation_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  inbound_event_id uuid not null,
  decision_version integer not null default 1 check (decision_version > 0),
  decision_kind text not null
    check (decision_kind IN ('NO_SEND','HUMAN_DRAFT','WORK_ELIGIBLE','RECOVERY_REQUIRED')),
  no_send_reason text
    check (no_send_reason is null or no_send_reason IN ('HISTORY_SYNC','SALES_GROUP_CHATTER','MODE_DISABLED','DUPLICATE','TARGET_INELIGIBLE','POLICY_BLOCKED')),
  eligibility_reason text,
  policy_version_id uuid,
  automation_version_id uuid,
  knowledge_version_ids uuid[] not null default '{}'::uuid[],
  frozen_inputs jsonb not null default '{}'::jsonb,
  frozen_inputs_hash text not null check (frozen_inputs_hash ~ '^[0-9a-f]{64}$'),
  recovery_code text,
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, inbound_event_id),
  foreign key (organization_id, account_id, inbound_event_id)
    references public.openclaw_inbound_events(organization_id, account_id, id) on delete restrict,
  check ((decision_kind = 'NO_SEND') = (no_send_reason is not null)),
  check ((decision_kind = 'RECOVERY_REQUIRED') = (recovery_code is not null))
);

create table public.openclaw_ai_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  conversation_id uuid not null,
  inbound_event_id uuid,
  automation_decision_id uuid,
  draft_version bigint not null check (draft_version > 0),
  prompt_input_hash text not null check (prompt_input_hash ~ '^[0-9a-f]{64}$'),
  policy_version_id uuid,
  automation_version_id uuid,
  knowledge_version_ids uuid[] not null default '{}'::uuid[],
  result_schema_version integer not null check (result_schema_version > 0),
  result_payload jsonb not null,
  draft_text text not null,
  citations jsonb not null default '[]'::jsonb,
  dlp_decision text not null check (dlp_decision IN ('PASS','BLOCK','REVIEW')),
  dlp_evidence_hash text not null check (dlp_evidence_hash ~ '^[0-9a-f]{64}$'),
  human_edit_version bigint not null default 0 check (human_edit_version >= 0),
  publication_state text not null default 'REVIEW_ONLY'
    check (publication_state in ('REVIEW_ONLY','APPROVED','REJECTED','PUBLISHED')),
  publication_intent_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  UNIQUE (organization_id, id),
  unique (organization_id, account_id, id),
  unique (organization_id, account_id, conversation_id, draft_version),
  foreign key (organization_id, account_id, conversation_id)
    references public.openclaw_conversations(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, inbound_event_id)
    references public.openclaw_inbound_events(organization_id, account_id, id) on delete restrict,
  foreign key (organization_id, account_id, automation_decision_id)
    references public.openclaw_inbound_automation_decisions(organization_id, account_id, id) on delete restrict,
  check (jsonb_typeof(citations) = 'array'),
  check (publication_state <> 'PUBLISHED' or (dlp_decision = 'PASS' and publication_intent_id is not null))
);

create index openclaw_inbound_decisions_account_idx
  on public.openclaw_inbound_automation_decisions
    (organization_id, account_id, created_at, id);
create index openclaw_ai_drafts_conversation_idx
  on public.openclaw_ai_drafts
    (organization_id, account_id, conversation_id, draft_version desc);

alter table public.openclaw_inbound_automation_decisions owner to openclaw_function_owner;
alter table public.openclaw_inbound_automation_decisions enable row level security;
alter table public.openclaw_inbound_automation_decisions force row level security;
revoke all on public.openclaw_inbound_automation_decisions from public, anon, authenticated, service_role;
alter table public.openclaw_ai_drafts owner to openclaw_function_owner;
alter table public.openclaw_ai_drafts enable row level security;
alter table public.openclaw_ai_drafts force row level security;
revoke all on public.openclaw_ai_drafts from public, anon, authenticated, service_role;

create policy openclaw_inbound_decisions_function_owner_all
  on public.openclaw_inbound_automation_decisions for all to openclaw_function_owner
  using (true) with check (true);
create policy openclaw_inbound_decisions_runtime_writer_insert
  on public.openclaw_inbound_automation_decisions for insert to openclaw_runtime_writer
  with check (true);
create policy openclaw_inbound_decisions_runtime_writer_select
  on public.openclaw_inbound_automation_decisions for select to openclaw_runtime_writer
  using (true);
create policy openclaw_ai_drafts_function_owner_all
  on public.openclaw_ai_drafts for all to openclaw_function_owner
  using (true) with check (true);
create policy openclaw_ai_drafts_runtime_writer_insert
  on public.openclaw_ai_drafts for insert to openclaw_runtime_writer
  with check (true);
create policy openclaw_ai_drafts_runtime_writer_select
  on public.openclaw_ai_drafts for select to openclaw_runtime_writer
  using (true);

create trigger openclaw_inbound_decisions_immutable_tenant
before update on public.openclaw_inbound_automation_decisions
for each row execute function app_private.reject_openclaw_tenant_identity_update_v1();
create trigger openclaw_ai_drafts_immutable_tenant
before update on public.openclaw_ai_drafts
for each row execute function app_private.reject_openclaw_tenant_identity_update_v1();
create trigger openclaw_inbound_decisions_append_only
before update or delete on public.openclaw_inbound_automation_decisions
for each row execute function app_private.reject_openclaw_append_only_v1();
create trigger openclaw_ai_drafts_append_only
before update or delete on public.openclaw_ai_drafts
for each row execute function app_private.reject_openclaw_append_only_v1();

grant select, insert on
  public.openclaw_inbound_automation_decisions,
  public.openclaw_ai_drafts
to openclaw_runtime_writer;


do $openclaw_owner_grants_release$
declare
  v_role text;
  v_schema text;
begin
  -- CREATE was only ever needed to hand ownership over. Revoking it leaves the
  -- objects owned by the role and leaves SECURITY DEFINER execution working, so
  -- no openclaw role keeps the ability to create objects after this migration.
  for v_role in
    select rolname from pg_catalog.pg_roles where rolname like 'openclaw\_%'
  loop
    foreach v_schema in array array['public', 'app_private'] loop
      if pg_catalog.to_regnamespace(v_schema) is not null then
        execute format('revoke create on schema %I from %I', v_schema, v_role);
      end if;
    end loop;
  end loop;
end
$openclaw_owner_grants_release$;
commit;
