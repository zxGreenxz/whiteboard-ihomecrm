begin;

do $preflight$
begin
  if to_regprocedure('app_private.openclaw_jcs_bytes_v1(jsonb)') is null
     or to_regclass('public.openclaw_crm_event_subscriptions') is null
     or to_regclass('public.leads') is null
     or to_regclass('public.rooms') is null
     or to_regclass('public.lead_activities') is null
     or to_regprocedure('public.recompute_room_reservation(uuid)') is null
     or to_regprocedure('app_private.lock_org_for_decision_v1(uuid)') is null
     or to_regprocedure('app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)') is null
     or to_regprocedure('app_private.authorized_scope_v3(text,uuid)') is null
  then
    raise exception 'OpenClaw CRM event source dependencies are incomplete' using errcode = '55000';
  end if;
end
$preflight$;

grant usage on schema extensions to openclaw_function_owner;
grant execute on function extensions.digest(bytea,text) to openclaw_function_owner;
grant usage on schema auth to openclaw_function_owner;
grant execute on function auth.uid() to openclaw_function_owner;
grant execute on function app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)
  to openclaw_function_owner;
grant execute on function app_private.authorized_scope_v3(text,uuid)
  to openclaw_function_owner;

alter table public.openclaw_crm_event_subscriptions
  drop constraint if exists openclaw_crm_event_subscriptions_event_type_check;
alter table public.openclaw_crm_event_subscriptions
  add constraint openclaw_crm_event_subscriptions_event_type_check
  check (event_type in ('lead_created_or_assigned','room_became_available','sales_task_due'));

alter table public.leads
  add column if not exists openclaw_assignment_revision bigint not null default 1
    check (openclaw_assignment_revision > 0);
alter table public.rooms
  add column if not exists openclaw_availability_revision bigint not null default 1
    check (openclaw_availability_revision > 0);
alter table public.lead_activities
  add column if not exists openclaw_schedule_revision bigint not null default 1
    check (openclaw_schedule_revision > 0);
alter table public.lead_activities
  add column if not exists openclaw_schedule_timezone text not null default 'Asia/Ho_Chi_Minh'
    check (btrim(openclaw_schedule_timezone) <> '');
alter table public.lead_activities
  add column if not exists openclaw_scheduled_at_utc timestamptz;

update public.lead_activities task
set organization_id = lead.organization_id
from public.leads lead
where task.lead_id = lead.id
  and task.organization_id is distinct from lead.organization_id;

update public.lead_activities task
set openclaw_scheduled_at_utc = task.scheduled_at at time zone task.openclaw_schedule_timezone
where task.scheduled_at is not null
  and task.openclaw_scheduled_at_utc is distinct from
    (task.scheduled_at at time zone task.openclaw_schedule_timezone);

do $source_preflight$
begin
  if exists (
    select 1
    from public.lead_activities task
    join public.leads lead on lead.id = task.lead_id
    where task.organization_id is null
       or lead.organization_id is null
       or task.organization_id is distinct from lead.organization_id
  ) then
    raise exception 'OpenClaw sales task organization backfill is incomplete' using errcode = '55000';
  end if;
end
$source_preflight$;

alter table public.lead_activities
  add constraint openclaw_lead_activities_schedule_canonical_check check (
    (scheduled_at is null and openclaw_scheduled_at_utc is null)
    or (scheduled_at is not null and openclaw_scheduled_at_utc =
      (scheduled_at at time zone openclaw_schedule_timezone))
  );

create index openclaw_lead_activities_due_follow_up_idx
  on public.lead_activities (openclaw_scheduled_at_utc,id)
  where activity_type = 'FOLLOW_UP'
    and completed_at is null
    and scheduled_at is not null;

create table public.openclaw_crm_event_occurrences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  event_type text not null
    check (event_type in ('lead_created_or_assigned','room_became_available','sales_task_due')),
  event_subtype text not null,
  source_table text not null,
  source_id uuid not null,
  source_version bigint not null check (source_version > 0),
  source_snapshot jsonb not null check (jsonb_typeof(source_snapshot) = 'object'),
  snapshot_bytes bytea not null,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  unique (organization_id,id),
  unique (organization_id,event_type,source_table,source_id,source_version),
  constraint openclaw_crm_event_occurrences_pair_check check (
    (event_type = 'lead_created_or_assigned'
      and source_table = 'leads'
      and event_subtype in ('CREATED','ASSIGNED','REASSIGNED'))
    or (event_type = 'room_became_available'
      and source_table = 'rooms'
      and event_subtype = 'FINAL_STATUS_AVAILABLE')
    or (event_type = 'sales_task_due'
      and source_table = 'lead_activities'
      and event_subtype = 'FOLLOW_UP_DUE')
  ),
  check (snapshot_bytes = app_private.openclaw_jcs_bytes_v1(source_snapshot)),
  check (snapshot_hash = encode(extensions.digest(
    convert_to('ihome-openclaw-crm-snapshot-v1','UTF8')
      || decode('00','hex') || snapshot_bytes,
    'sha256'
  ), 'hex'))
);

create index openclaw_crm_event_occurrences_runtime_idx
  on public.openclaw_crm_event_occurrences
    (organization_id,event_type,occurred_at,id);

create or replace function app_private.openclaw_reject_crm_occurrence_mutation_v1()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'OpenClaw CRM occurrences are append-only' using errcode = '55000';
end;
$function$;

create trigger openclaw_crm_event_occurrences_append_only
before update or delete on public.openclaw_crm_event_occurrences
for each row execute function app_private.openclaw_reject_crm_occurrence_mutation_v1();

create or replace function app_private.openclaw_insert_crm_occurrence_v1(
  p_organization_id uuid,
  p_event_type text,
  p_event_subtype text,
  p_source_table text,
  p_source_id uuid,
  p_source_version bigint,
  p_snapshot jsonb,
  p_occurred_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_bytes bytea;
  v_hash text;
  v_inserted integer;
  v_source_organization_id uuid;
  v_existing public.openclaw_crm_event_occurrences%rowtype;
begin
  if p_organization_id is null or p_source_id is null or p_source_version <= 0
     or p_occurred_at is null or jsonb_typeof(p_snapshot) <> 'object'
     or p_snapshot ->> 'version' <> '1'
     or p_snapshot ->> 'eventType' is distinct from p_event_type
     or p_snapshot ->> 'eventSubtype' is distinct from p_event_subtype
     or p_snapshot ->> 'sourceTable' is distinct from p_source_table
     or p_snapshot ->> 'sourceId' is distinct from p_source_id::text
     or (p_snapshot ->> 'sourceVersion')::bigint is distinct from p_source_version
     or jsonb_typeof(p_snapshot -> 'payload') <> 'object'
  then
    raise exception 'invalid typed CRM occurrence snapshot' using errcode = '22023';
  end if;
  case p_source_table
    when 'leads' then
      select source_row.organization_id into v_source_organization_id
      from public.leads source_row
      where source_row.id = p_source_id;
    when 'rooms' then
      select source_row.organization_id into v_source_organization_id
      from public.rooms source_row
      where source_row.id = p_source_id;
    when 'lead_activities' then
      select source_row.organization_id into v_source_organization_id
      from public.lead_activities source_row
      where source_row.id = p_source_id;
    else
      raise exception 'invalid typed CRM occurrence source table' using errcode = '22023';
  end case;
  if not found or v_source_organization_id is distinct from p_organization_id then
    raise exception 'typed CRM occurrence source organization mismatch' using errcode = '42501';
  end if;
  v_bytes := app_private.openclaw_jcs_bytes_v1(p_snapshot);
  v_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-crm-snapshot-v1','UTF8')
      || decode('00','hex') || v_bytes,
    'sha256'
  ), 'hex');
  insert into public.openclaw_crm_event_occurrences(
    organization_id,event_type,event_subtype,source_table,source_id,source_version,
    source_snapshot,snapshot_bytes,snapshot_hash,occurred_at
  ) values (
    p_organization_id,p_event_type,p_event_subtype,p_source_table,p_source_id,p_source_version,
    p_snapshot,v_bytes,v_hash,p_occurred_at
  )
  on conflict (organization_id,event_type,source_table,source_id,source_version) do nothing
  returning 1 into v_inserted;
  if v_inserted = 1 then
    return true;
  end if;
  select occurrence.* into v_existing
  from public.openclaw_crm_event_occurrences occurrence
  where occurrence.organization_id = p_organization_id
    and occurrence.event_type = p_event_type
    and occurrence.source_table = p_source_table
    and occurrence.source_id = p_source_id
    and occurrence.source_version = p_source_version;
  if not found
     or v_existing.event_subtype is distinct from p_event_subtype
     or v_existing.source_snapshot is distinct from p_snapshot
     or v_existing.snapshot_bytes is distinct from v_bytes
     or v_existing.snapshot_hash is distinct from v_hash
     or v_existing.occurred_at is distinct from p_occurred_at
  then
    raise exception 'typed CRM occurrence conflict mismatch' using errcode = '23505';
  end if;
  return false;
end;
$function$;

create or replace function app_private.openclaw_bump_lead_assignment_revision_v1()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if TG_OP = 'INSERT' then
    if NEW.openclaw_assignment_revision is distinct from 1 then
      raise exception 'openclaw_assignment_revision must start at 1' using errcode = '42501';
    end if;
    return NEW;
  end if;
  if OLD.assigned_staff_id is distinct from NEW.assigned_staff_id then
    NEW.openclaw_assignment_revision := OLD.openclaw_assignment_revision + 1;
  elsif NEW.openclaw_assignment_revision is distinct from OLD.openclaw_assignment_revision then
    raise exception 'openclaw_assignment_revision is system-managed' using errcode = '42501';
  end if;
  return NEW;
end;
$function$;

create trigger openclaw_leads_assignment_revision
before insert or update of assigned_staff_id,openclaw_assignment_revision on public.leads
for each row execute function app_private.openclaw_bump_lead_assignment_revision_v1();

create or replace function app_private.openclaw_emit_lead_occurrence_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_subtype text;
  v_snapshot jsonb;
  v_occurred_at timestamptz;
begin
  if NEW.organization_id is null then
    raise exception 'lead organization_id is required for OpenClaw CRM occurrence' using errcode = '23502';
  end if;
  if TG_OP = 'INSERT' then
    v_subtype := 'CREATED';
    v_occurred_at := NEW.created_at;
  elsif OLD.assigned_staff_id is null and NEW.assigned_staff_id is not null then
    v_subtype := 'ASSIGNED';
    v_occurred_at := NEW.updated_at;
  elsif NEW.assigned_staff_id is not null
     and OLD.assigned_staff_id is distinct from NEW.assigned_staff_id
  then
    v_subtype := 'REASSIGNED';
    v_occurred_at := NEW.updated_at;
  else
    return NEW;
  end if;
  v_snapshot := jsonb_build_object(
    'version',1,
    'eventType','lead_created_or_assigned',
    'eventSubtype',v_subtype,
    'sourceTable','leads',
    'sourceId',NEW.id,
    'sourceVersion',NEW.openclaw_assignment_revision,
    'payload',jsonb_build_object(
      'leadId',NEW.id,
      'organizationId',NEW.organization_id,
      'customerName',NEW.customer_name,
      'phone',NEW.phone,
      'assignedStaffId',NEW.assigned_staff_id,
      'buildingId',NEW.building_id,
      'roomId',NEW.room_id,
      'status',NEW.status,
      'source',NEW.source,
      'createdAt',to_char(
        NEW.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'updatedAt',to_char(
        NEW.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    )
  );
  perform app_private.openclaw_insert_crm_occurrence_v1(
    NEW.organization_id,'lead_created_or_assigned',v_subtype,'leads',NEW.id,
    NEW.openclaw_assignment_revision,v_snapshot,v_occurred_at
  );
  return NEW;
end;
$function$;

create trigger openclaw_leads_emit_typed_occurrence
after insert or update of assigned_staff_id on public.leads
for each row execute function app_private.openclaw_emit_lead_occurrence_v1();

create or replace function app_private.openclaw_bump_room_availability_revision_v1()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if TG_OP = 'INSERT' then
    if NEW.openclaw_availability_revision is distinct from 1 then
      raise exception 'openclaw_availability_revision must start at 1' using errcode = '42501';
    end if;
    return NEW;
  end if;
  if OLD.status is distinct from NEW.status then
    NEW.openclaw_availability_revision := OLD.openclaw_availability_revision + 1;
  elsif NEW.openclaw_availability_revision is distinct from OLD.openclaw_availability_revision then
    raise exception 'openclaw_availability_revision is system-managed' using errcode = '42501';
  end if;
  return NEW;
end;
$function$;

create trigger openclaw_rooms_availability_revision
before insert or update of status,openclaw_availability_revision on public.rooms
for each row execute function app_private.openclaw_bump_room_availability_revision_v1();

create or replace function public.trg_room_status_reconcile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_final public.rooms%rowtype;
  v_snapshot jsonb;
begin
  perform public.recompute_room_reservation(NEW.id);
  select room.* into v_final
  from public.rooms room
  where room.id = NEW.id and room.deleted_at is null;
  if found
     and v_final.status = 'AVAILABLE'
     and OLD.status is distinct from 'AVAILABLE'
  then
    if v_final.organization_id is null then
      raise exception 'room organization_id is required for OpenClaw CRM occurrence' using errcode = '23502';
    end if;
    v_snapshot := jsonb_build_object(
      'version',1,
      'eventType','room_became_available',
      'eventSubtype','FINAL_STATUS_AVAILABLE',
      'sourceTable','rooms',
      'sourceId',v_final.id,
      'sourceVersion',v_final.openclaw_availability_revision,
      'payload',jsonb_build_object(
        'roomId',v_final.id,
        'organizationId',v_final.organization_id,
        'buildingId',v_final.building_id,
        'name',v_final.name,
        'code',v_final.code,
        'status',v_final.status,
        'updatedAt',to_char(
          v_final.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      )
    );
    perform app_private.openclaw_insert_crm_occurrence_v1(
      v_final.organization_id,'room_became_available','FINAL_STATUS_AVAILABLE',
      'rooms',v_final.id,v_final.openclaw_availability_revision,v_snapshot,v_final.updated_at
    );
  end if;
  return null;
end;
$function$;

drop trigger if exists trg_room_status_reconcile on public.rooms;
create trigger trg_room_status_reconcile
after update of status on public.rooms
for each row when (NEW.status = 'AVAILABLE')
execute function public.trg_room_status_reconcile();

create or replace function app_private.openclaw_bind_sales_task_organization_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_organization_id uuid;
  v_building_id uuid;
  v_actor_id uuid := (select auth.uid());
  v_permission_key text := case when TG_OP = 'INSERT' then 'leads.create' else 'leads.edit' end;
  v_allowed boolean;
  v_jwt_role text := pg_catalog.current_setting('request.jwt.claim.role',true);
begin
  select lead.organization_id,lead.building_id into v_organization_id,v_building_id
  from public.leads lead
  where lead.id = NEW.lead_id;
  if not found or v_organization_id is null then
    raise exception 'sales task parent lead organization is unavailable' using errcode = '23503';
  end if;
  if v_actor_id is not null then
    perform app_private.lock_org_for_decision_v1(v_organization_id);
    if v_building_id is not null then
      select decision.allowed into v_allowed
      from app_private.authorize_tenant_action_v3(
        v_actor_id,v_organization_id,v_permission_key,v_building_id,null
      ) decision;
    else
      select coalesce(scope.org_wide,false)
          or coalesce(cardinality(scope.building_ids),0) > 0
      into v_allowed
      from app_private.authorized_scope_v3(v_permission_key,v_organization_id) scope;
    end if;
    if not coalesce(v_allowed,false) then
      raise exception 'sales task parent lead is outside the caller''s authorized scope'
        using errcode = '42501';
    end if;
  elsif coalesce(v_jwt_role,'') <> 'service_role'
    and session_user not in ('postgres','supabase_admin')
  then
    raise exception 'sales task organization binding requires a trusted caller'
      using errcode = '42501';
  end if;
  if NEW.organization_id is null then
    NEW.organization_id := v_organization_id;
  elsif NEW.organization_id is distinct from v_organization_id then
    raise exception 'sales task organization does not match parent lead' using errcode = '42501';
  end if;
  return NEW;
end;
$function$;

create trigger openclaw_lead_activities_organization
before insert or update of lead_id,organization_id on public.lead_activities
for each row execute function app_private.openclaw_bind_sales_task_organization_v1();

create or replace function app_private.openclaw_bump_sales_task_schedule_revision_v1()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_scheduled_at_utc timestamptz;
begin
  if NEW.openclaw_schedule_timezone is null
     or btrim(NEW.openclaw_schedule_timezone) = ''
  then
    raise exception 'openclaw_schedule_timezone is required' using errcode = '22023';
  end if;
  begin
    v_scheduled_at_utc := NEW.scheduled_at at time zone NEW.openclaw_schedule_timezone;
  exception when invalid_parameter_value then
    raise exception 'openclaw_schedule_timezone is invalid' using errcode = '22023';
  end;
  if TG_OP = 'INSERT' then
    if NEW.openclaw_schedule_revision is distinct from 1 then
      raise exception 'openclaw_schedule_revision must start at 1' using errcode = '42501';
    end if;
    NEW.openclaw_scheduled_at_utc := v_scheduled_at_utc;
    return NEW;
  end if;
  if OLD.scheduled_at is distinct from NEW.scheduled_at
     or OLD.openclaw_schedule_timezone is distinct from NEW.openclaw_schedule_timezone
  then
    NEW.openclaw_schedule_revision := OLD.openclaw_schedule_revision + 1;
    NEW.openclaw_scheduled_at_utc := v_scheduled_at_utc;
  elsif NEW.openclaw_schedule_revision is distinct from OLD.openclaw_schedule_revision
     or NEW.openclaw_scheduled_at_utc is distinct from OLD.openclaw_scheduled_at_utc
  then
    raise exception 'OpenClaw sales task schedule lineage is system-managed' using errcode = '42501';
  end if;
  return NEW;
end;
$function$;

create trigger openclaw_lead_activities_schedule_revision
before insert or update of scheduled_at,openclaw_schedule_timezone,openclaw_scheduled_at_utc,openclaw_schedule_revision on public.lead_activities
for each row execute function app_private.openclaw_bump_sales_task_schedule_revision_v1();

create or replace function app_private.openclaw_sweep_due_sales_tasks_v1(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer := greatest(1,least(coalesce(p_limit,100),500));
  activity record;
  v_snapshot jsonb;
  v_inserted integer := 0;
begin
  for activity in
    select task.id,task.lead_id,task.activity_type,task.scheduled_at,
      task.openclaw_schedule_timezone,task.openclaw_scheduled_at_utc,
      task.openclaw_schedule_revision,task.organization_id,lead.customer_name,
      lead.phone,lead.assigned_staff_id
    from public.lead_activities task
    join public.leads lead on lead.id = task.lead_id
    where task.activity_type = 'FOLLOW_UP'
      and task.openclaw_scheduled_at_utc <= statement_timestamp()
      and task.completed_at is null
      and task.scheduled_at is not null
      and task.organization_id = lead.organization_id
      and lead.organization_id is not null
      and lead.deleted_at is null
      and not exists (
        select 1
        from public.openclaw_crm_event_occurrences occurrence
        where occurrence.organization_id = task.organization_id
          and occurrence.event_type = 'sales_task_due'
          and occurrence.source_table = 'lead_activities'
          and occurrence.source_id = task.id
          and occurrence.source_version = task.openclaw_schedule_revision
      )
    order by task.openclaw_scheduled_at_utc,task.id
    for update of task skip locked
    limit v_limit
  loop
    v_snapshot := jsonb_build_object(
      'version',1,
      'eventType','sales_task_due',
      'eventSubtype','FOLLOW_UP_DUE',
      'sourceTable','lead_activities',
      'sourceId',activity.id,
      'sourceVersion',activity.openclaw_schedule_revision,
      'payload',jsonb_build_object(
        'activityId',activity.id,
        'leadId',activity.lead_id,
        'organizationId',activity.organization_id,
        'activityType',activity.activity_type,
        'scheduledAtLocal',activity.scheduled_at,
        'scheduledAtUtc',to_char(
          activity.openclaw_scheduled_at_utc at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ),
        'scheduleTimezone',activity.openclaw_schedule_timezone,
        'scheduleRevision',activity.openclaw_schedule_revision,
        'customerName',activity.customer_name,
        'phone',activity.phone,
        'assignedStaffId',activity.assigned_staff_id
      )
    );
    if app_private.openclaw_insert_crm_occurrence_v1(
      activity.organization_id,'sales_task_due','FOLLOW_UP_DUE','lead_activities',
      activity.id,activity.openclaw_schedule_revision,v_snapshot,
      activity.openclaw_scheduled_at_utc
    ) then
      v_inserted := v_inserted + 1;
    end if;
  end loop;
  return v_inserted;
end;
$function$;

alter table public.openclaw_crm_event_occurrences owner to openclaw_function_owner;
alter table public.openclaw_crm_event_occurrences enable row level security;
alter table public.openclaw_crm_event_occurrences force row level security;
revoke all on public.openclaw_crm_event_occurrences from public, anon, authenticated, service_role;

create policy openclaw_crm_event_occurrences_function_owner_all
  on public.openclaw_crm_event_occurrences for all to openclaw_function_owner
  using (true) with check (true);
create policy openclaw_crm_event_occurrences_runtime_writer_select
  on public.openclaw_crm_event_occurrences for select to openclaw_runtime_writer
  using (true);
create policy openclaw_crm_sources_function_owner_rooms_select
  on public.rooms for select to openclaw_function_owner using (true);
create policy openclaw_crm_sources_function_owner_leads_select
  on public.leads for select to openclaw_function_owner using (true);
create policy openclaw_crm_sources_function_owner_activities_select
  on public.lead_activities for select to openclaw_function_owner using (true);
create policy openclaw_crm_sources_function_owner_activities_update
  on public.lead_activities for update to openclaw_function_owner
  using (true) with check (true);

alter function app_private.openclaw_reject_crm_occurrence_mutation_v1() owner to openclaw_function_owner;
alter function app_private.openclaw_insert_crm_occurrence_v1(uuid,text,text,text,uuid,bigint,jsonb,timestamptz)
  owner to openclaw_function_owner;
alter function app_private.openclaw_bump_lead_assignment_revision_v1() owner to openclaw_function_owner;
alter function app_private.openclaw_emit_lead_occurrence_v1() owner to openclaw_function_owner;
alter function app_private.openclaw_bump_room_availability_revision_v1() owner to openclaw_function_owner;
alter function public.trg_room_status_reconcile() owner to openclaw_function_owner;
alter function app_private.openclaw_bind_sales_task_organization_v1() owner to openclaw_function_owner;
alter function app_private.openclaw_bump_sales_task_schedule_revision_v1() owner to openclaw_function_owner;
alter function app_private.openclaw_sweep_due_sales_tasks_v1(integer) owner to openclaw_function_owner;

revoke all on function app_private.openclaw_insert_crm_occurrence_v1(uuid,text,text,text,uuid,bigint,jsonb,timestamptz)
  from public,anon,authenticated,service_role;
revoke all on function app_private.openclaw_sweep_due_sales_tasks_v1(integer)
  from public,anon,authenticated,service_role;
revoke all on function app_private.openclaw_bind_sales_task_organization_v1()
  from public,anon,authenticated,service_role;
grant select,insert on public.openclaw_crm_event_occurrences to openclaw_function_owner;
grant select on public.openclaw_crm_event_occurrences to openclaw_runtime_writer;
grant select on public.rooms,public.leads to openclaw_function_owner;
grant select,update on public.lead_activities to openclaw_function_owner;
grant execute on function public.recompute_room_reservation(uuid) to openclaw_function_owner;

commit;
