begin;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('ihome-openclaw-maintenance-jobs-v1', 0)
);

do $binding_preflight$
begin
  if exists (select 1 from public.openclaw_send_work_items)
     or exists (select 1 from public.openclaw_send_work_attempts)
     or exists (select 1 from public.openclaw_maintenance_work_items)
     or exists (select 1 from public.openclaw_maintenance_work_attempts) then
    raise exception 'OPENCLAW_WORK_BINDING_PREFLIGHT_FAILED: historical work binding cannot be reconstructed'
      using errcode='55000';
  end if;
end
$binding_preflight$;

-- Scheduling is deliberately a small, bounded language.  In particular there is
-- no client supplied UTC cursor: the database owns both recurrence parsing and
-- local-time resolution.
alter table public.openclaw_schedules
  add column occurrence_grace_seconds integer not null default 300
    check (occurrence_grace_seconds between 60 and 3600),
  add column dst_fold_policy text not null default 'EARLIER_OFFSET'
    check (dst_fold_policy in ('EARLIER_OFFSET','LATER_OFFSET')),
  add column next_nominal_local timestamp without time zone,
  add column next_resolved_local timestamp without time zone,
  add column next_utc_offset_seconds integer,
  add column next_resolution text
    check (next_resolution is null or next_resolution in (
      'EXACT','GAP_SHIFT_FORWARD','FOLD_EARLIER_OFFSET','FOLD_LATER_OFFSET'
    )),
  add column cursor_version bigint not null default 1 check (cursor_version > 0),
  add column binding_defer_reason text;

alter table public.openclaw_schedule_snapshots
  add column occurrence_grace_seconds integer not null default 300
    check (occurrence_grace_seconds between 60 and 3600),
  add column dst_fold_policy text not null default 'EARLIER_OFFSET'
    check (dst_fold_policy in ('EARLIER_OFFSET','LATER_OFFSET'));

-- A campaign version is represented by the immutable UUID identity of the
-- corresponding campaign run.  The bigint campaign_version remains useful
-- for display/CAS, while campaign_runs.id is the cross-runtime version key
-- carried by checked JSON contracts.
alter table public.openclaw_schedules
  add column campaign_version_id uuid,
  add constraint openclaw_schedules_campaign_version_fkey
    foreign key (organization_id,account_id,campaign_version_id)
    references public.openclaw_campaign_runs(organization_id,account_id,id)
    on delete restrict;

alter table public.openclaw_schedule_snapshots
  add column campaign_version_id uuid,
  add constraint openclaw_schedule_snapshots_campaign_version_fkey
    foreign key (organization_id,account_id,campaign_version_id)
    references public.openclaw_campaign_runs(organization_id,account_id,id)
    on delete restrict;

create or replace function app_private.guard_openclaw_campaign_run_version_v1()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if TG_OP='DELETE' then
    raise exception 'campaign version identity is immutable' using errcode='55000';
  end if;
  if NEW.organization_id is distinct from OLD.organization_id
     or NEW.account_id is distinct from OLD.account_id
     or NEW.campaign_id is distinct from OLD.campaign_id
     or NEW.campaign_version is distinct from OLD.campaign_version
     or NEW.automation_version_id is distinct from OLD.automation_version_id
     or NEW.run_key is distinct from OLD.run_key
     or NEW.target_snapshot_hash is distinct from OLD.target_snapshot_hash
  then
    raise exception 'campaign version lineage is immutable' using errcode='55000';
  end if;
  return NEW;
end;
$function$;

create trigger openclaw_campaign_runs_version_guard
before update or delete on public.openclaw_campaign_runs
for each row execute function app_private.guard_openclaw_campaign_run_version_v1();

create or replace function app_private.openclaw_parse_local_recurrence_rule_v1(
  p_rule text
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_match text[];
  v_frequency text;
  v_start_text text;
  v_until_text text;
  v_byday_text text;
  v_start timestamp without time zone;
  v_until timestamp without time zone;
  v_interval integer := 1;
  v_days text[];
  v_canonical text;
begin
  if p_rule ~ '^V1;FREQ=ONCE;DTSTART=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' then
    v_frequency := 'ONCE';
    v_start_text := substring(p_rule from 'DTSTART=([^;]+)$');
  elsif p_rule ~ '^V1;FREQ=DAILY;DTSTART=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2};INTERVAL=[1-9][0-9]{0,2};UNTIL=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' then
    v_frequency := 'DAILY';
    v_match := regexp_match(p_rule,
      '^V1;FREQ=DAILY;DTSTART=([^;]+);INTERVAL=([0-9]+);UNTIL=([^;]+)$');
    v_start_text := v_match[1];
    v_interval := v_match[2]::integer;
    v_until_text := v_match[3];
  elsif p_rule ~ '^V1;FREQ=WEEKLY;DTSTART=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2};INTERVAL=[1-9][0-9]{0,2};BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*;UNTIL=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' then
    v_frequency := 'WEEKLY';
    v_match := regexp_match(p_rule,
      '^V1;FREQ=WEEKLY;DTSTART=([^;]+);INTERVAL=([0-9]+);BYDAY=([^;]+);UNTIL=([^;]+)$');
    v_start_text := v_match[1];
    v_interval := v_match[2]::integer;
    v_byday_text := v_match[3];
    v_until_text := v_match[4];
  else
    raise exception 'local recurrence rule is not canonical V1 ONCE/DAILY/WEEKLY'
      using errcode = '22023';
  end if;

  begin
    v_start := to_timestamp(v_start_text, 'FXYYYY-MM-DD"T"HH24:MI')::timestamp;
  exception when others then
    raise exception 'invalid recurrence DTSTART' using errcode = '22023';
  end;
  if to_char(v_start, 'YYYY-MM-DD"T"HH24:MI') <> v_start_text then
    raise exception 'invalid recurrence DTSTART' using errcode = '22023';
  end if;

  if v_frequency <> 'ONCE' then
    begin
      v_until := to_timestamp(v_until_text, 'FXYYYY-MM-DD"T"HH24:MI')::timestamp;
    exception when others then
      raise exception 'invalid recurrence UNTIL' using errcode = '22023';
    end;
    if to_char(v_until, 'YYYY-MM-DD"T"HH24:MI') <> v_until_text
       or v_until < v_start
       or v_until > v_start + interval '366 days'
       or v_interval > 366
    then
      raise exception 'recurrence interval or UNTIL exceeds the V1 bound'
        using errcode = '22023';
    end if;
  end if;

  if v_frequency = 'WEEKLY' then
    v_days := string_to_array(v_byday_text, ',');
    select string_agg(day_code, ',' order by ordinal)
      into v_canonical
    from (values
      ('MO',1),('TU',2),('WE',3),('TH',4),('FR',5),('SA',6),('SU',7)
    ) ordered(day_code,ordinal)
    where day_code = any(v_days);
    if v_canonical is distinct from v_byday_text
       or cardinality(v_days) <> cardinality(array(select distinct unnest(v_days)))
       or not (case extract(isodow from v_start)::integer
         when 1 then 'MO' when 2 then 'TU' when 3 then 'WE' when 4 then 'TH'
         when 5 then 'FR' when 6 then 'SA' else 'SU' end = any(v_days))
    then
      raise exception 'WEEKLY BYDAY must be unique and canonical MO..SU and include DTSTART'
        using errcode = '22023';
    end if;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'version',1,'frequency',v_frequency,'dtstart',to_char(v_start,'YYYY-MM-DD"T"HH24:MI'),
    'interval',case when v_frequency = 'ONCE' then null else v_interval end,
    'byday',case when v_frequency = 'WEEKLY' then to_jsonb(v_days) end,
    'until',case when v_frequency = 'ONCE' then null else to_char(v_until,'YYYY-MM-DD"T"HH24:MI') end
  ));
end;
$function$;

create or replace function app_private.openclaw_valid_local_recurrence_rule_v1(
  p_rule text
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
begin
  perform app_private.openclaw_parse_local_recurrence_rule_v1(p_rule);
  return true;
exception when others then
  return false;
end;
$function$;

create or replace function app_private.openclaw_next_schedule_occurrence_v1(
  p_rule text,
  p_after_local timestamp without time zone default null
)
returns timestamp without time zone
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_rule jsonb := app_private.openclaw_parse_local_recurrence_rule_v1(p_rule);
  v_frequency text := v_rule ->> 'frequency';
  v_start timestamp := (v_rule ->> 'dtstart')::timestamp;
  v_until timestamp := nullif(v_rule ->> 'until','')::timestamp;
  v_interval integer := coalesce((v_rule ->> 'interval')::integer,1);
  v_candidate timestamp;
  v_days text[] := coalesce(array(select jsonb_array_elements_text(v_rule -> 'byday')),'{}'::text[]);
  v_day text;
  v_week integer;
begin
  if p_after_local is null or p_after_local < v_start then
    return v_start;
  end if;
  if v_frequency = 'ONCE' then
    return null;
  elsif v_frequency = 'DAILY' then
    v_candidate := v_start + (
      (floor(extract(epoch from (p_after_local - v_start)) / 86400 / v_interval)::bigint + 1)
      * v_interval
    ) * interval '1 day';
    if v_candidate <= v_until then return v_candidate; end if;
    return null;
  end if;

  v_candidate := date_trunc('day',p_after_local) + (v_start - date_trunc('day',v_start));
  if v_candidate <= p_after_local then v_candidate := v_candidate + interval '1 day'; end if;
  while v_candidate <= v_until loop
    v_day := case extract(isodow from v_candidate)::integer
      when 1 then 'MO' when 2 then 'TU' when 3 then 'WE' when 4 then 'TH'
      when 5 then 'FR' when 6 then 'SA' else 'SU' end;
    v_week := floor(extract(epoch from (
      date_trunc('week',v_candidate)-date_trunc('week',v_start)
    )) / 604800)::integer;
    if v_candidate >= v_start and v_day = any(v_days) and mod(v_week,v_interval)=0 then
      return v_candidate;
    end if;
    v_candidate := v_candidate + interval '1 day';
  end loop;
  return null;
end;
$function$;

create or replace function app_private.openclaw_resolve_local_occurrence_v1(
  p_nominal_local timestamp without time zone,
  p_timezone text,
  p_fold_policy text default 'EARLIER_OFFSET'
)
returns table (
  resolved_local timestamp without time zone,
  planned_for timestamptz,
  utc_offset_seconds integer,
  resolution text
)
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_probe_local timestamp;
  v_guess timestamptz;
  v_candidate timestamptz;
  v_matches timestamptz[];
  v_utc timestamptz;
begin
  if p_fold_policy not in ('EARLIER_OFFSET','LATER_OFFSET') then
    raise exception 'fold policy must be EARLIER_OFFSET or LATER_OFFSET' using errcode='22023';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names zone where zone.name=p_timezone) then
    raise exception 'unknown IANA timezone %', p_timezone using errcode='22023';
  end if;

  v_probe_local := date_trunc('minute',p_nominal_local);
  if v_probe_local is distinct from p_nominal_local then
    raise exception 'nominal local occurrence must have minute precision' using errcode='22023';
  end if;
  loop
    v_guess := v_probe_local at time zone p_timezone;
    v_matches := array[]::timestamptz[];
    for v_candidate in
      select series.candidate_utc
      from generate_series(
        v_guess-interval '26 hours',v_guess+interval '26 hours',interval '1 minute'
      ) as series(candidate_utc)
      where series.candidate_utc at time zone p_timezone = v_probe_local
      order by series.candidate_utc
    loop
      v_matches := array_append(v_matches,v_candidate);
    end loop;
    exit when cardinality(v_matches)>0;
    v_probe_local := v_probe_local + interval '1 minute';
    if v_probe_local > p_nominal_local + interval '26 hours' then
      raise exception 'unable to resolve local occurrence within bounded timezone window' using errcode='22023';
    end if;
  end loop;

  if cardinality(v_matches)=1 then
    v_utc := v_matches[1];
    resolution := case when v_probe_local=p_nominal_local then 'EXACT' else 'GAP_SHIFT_FORWARD' end;
  elsif p_fold_policy='EARLIER_OFFSET' then
    select min(candidate) into v_utc from unnest(v_matches) candidate;
    resolution := 'FOLD_EARLIER_OFFSET';
  else
    select max(candidate) into v_utc from unnest(v_matches) candidate;
    resolution := 'FOLD_LATER_OFFSET';
  end if;
  resolved_local := v_probe_local;
  planned_for := v_utc;
  utc_offset_seconds := extract(epoch from (v_probe_local-(v_utc at time zone 'UTC')))::integer;
  return next;
end;
$function$;

create table public.openclaw_schedule_occurrences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_id uuid not null,
  schedule_id uuid not null,
  schedule_version bigint not null check (schedule_version > 0),
  target_id uuid not null,
  planned_local timestamp without time zone not null,
  resolved_local timestamp without time zone not null,
  planned_for timestamptz not null,
  utc_offset_seconds integer not null,
  resolution text not null check (resolution in (
    'EXACT','GAP_SHIFT_FORWARD','FOLD_EARLIER_OFFSET','FOLD_LATER_OFFSET'
  )),
  occurrence_status text not null check (occurrence_status in ('SKIPPED_MISSED','MATERIALIZED')),
  occurrence_evidence jsonb not null check (jsonb_typeof(occurrence_evidence)='object'),
  occurrence_evidence_bytes bytea not null,
  occurrence_evidence_hash text not null check (occurrence_evidence_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default statement_timestamp(),
  unique (organization_id,id),
  unique (organization_id,account_id,id),
  unique (organization_id,account_id,schedule_id,schedule_version,planned_local),
  unique (organization_id,account_id,schedule_id,schedule_version,planned_for),
  foreign key (organization_id,account_id,schedule_id,schedule_version)
    references public.openclaw_schedule_snapshots(organization_id,account_id,schedule_id,schedule_version)
    on delete restrict,
  foreign key (organization_id,account_id,target_id)
    references public.openclaw_targets(organization_id,account_id,id) on delete restrict,
  check (convert_from(occurrence_evidence_bytes,'UTF8')::jsonb=occurrence_evidence),
  check (occurrence_evidence_hash=encode(extensions.digest(
    convert_to('ihome-openclaw-schedule-occurrence-v1','UTF8')||decode('00','hex')
      ||occurrence_evidence_bytes,'sha256'),'hex'))
);

create index openclaw_schedule_occurrences_materialized_idx
  on public.openclaw_schedule_occurrences(organization_id,account_id,created_at,id)
  where occurrence_status='MATERIALIZED';

alter table public.openclaw_runtime_credentials
  add constraint openclaw_runtime_credentials_binding_key
    unique (organization_id,account_id,cell_id,credential_generation);
alter table public.openclaw_runtime_leases
  add constraint openclaw_runtime_leases_binding_key
    unique (organization_id,account_id,cell_id,lease_generation,fencing_token);
alter table public.openclaw_maintenance_credentials
  add constraint openclaw_maintenance_credentials_binding_key
    unique (organization_id,maintenance_principal_id,credential_generation);
alter table public.openclaw_maintenance_leases
  add constraint openclaw_maintenance_leases_binding_key
    unique (organization_id,maintenance_principal_id,lease_generation,fencing_token);

alter table public.openclaw_send_work_items
  add column source_key text,
  add column target_id uuid,
  add column credential_generation bigint,
  add column runtime_lease_generation bigint,
  add column binding_defer_reason text,
  add column schedule_id uuid,
  add column schedule_version bigint,
  add column schedule_occurrence_id uuid,
  add column campaign_version_id uuid,
  add column subscription_id uuid,
  add column subscription_version bigint,
  add column crm_occurrence_id uuid,
  add constraint openclaw_send_work_target_fkey
    foreign key (organization_id,account_id,target_id)
    references public.openclaw_targets(organization_id,account_id,id) on delete restrict,
  add constraint openclaw_send_work_credential_binding_fkey
    foreign key (organization_id,account_id,cell_id,credential_generation)
    references public.openclaw_runtime_credentials(
      organization_id,account_id,cell_id,credential_generation
    ) on delete restrict,
  add constraint openclaw_send_work_lease_binding_fkey
    foreign key (organization_id,account_id,cell_id,runtime_lease_generation,fencing_token)
    references public.openclaw_runtime_leases(
      organization_id,account_id,cell_id,lease_generation,fencing_token
    ) on delete restrict,
  add constraint openclaw_send_work_schedule_occurrence_fkey
    foreign key (organization_id,account_id,schedule_occurrence_id)
    references public.openclaw_schedule_occurrences(organization_id,account_id,id) on delete restrict,
  add constraint openclaw_send_work_campaign_version_fkey
    foreign key (organization_id,account_id,campaign_version_id)
    references public.openclaw_campaign_runs(organization_id,account_id,id) on delete restrict,
  add constraint openclaw_send_work_crm_occurrence_fkey
    foreign key (organization_id,crm_occurrence_id)
    references public.openclaw_crm_event_occurrences(organization_id,id) on delete restrict;

do $drop_legacy_work_identity$
declare
  v_constraint text;
begin
  select constraint_row.conname into v_constraint
  from pg_catalog.pg_constraint constraint_row
  where constraint_row.conrelid='public.openclaw_send_work_items'::regclass
    and constraint_row.contype='u'
    and pg_catalog.pg_get_constraintdef(constraint_row.oid)
      ilike 'UNIQUE (organization_id, account_id, work_kind, source_id, source_version)';
  if v_constraint is null then
    raise exception 'OPENCLAW_WORK_BINDING_PREFLIGHT_FAILED: legacy source_id/source_version identity is missing'
      using errcode='55000';
  end if;
  execute format('alter table public.openclaw_send_work_items drop constraint %I',v_constraint);
end
$drop_legacy_work_identity$;

alter table public.openclaw_send_work_items
  alter column source_key set not null,
  alter column target_id set not null,
  alter column credential_generation set not null,
  alter column runtime_lease_generation set not null,
  add constraint openclaw_send_work_typed_identity_check check (
    (work_kind='INBOUND_AUTOMATION'
      and schedule_id is null and schedule_version is null and schedule_occurrence_id is null
      and campaign_version_id is null
      and subscription_id is null and subscription_version is null and crm_occurrence_id is null)
    or (work_kind='SCHEDULE_OCCURRENCE'
      and schedule_id is not null and schedule_version is not null and schedule_occurrence_id is not null
      and campaign_version_id is not null
      and subscription_id is null and subscription_version is null and crm_occurrence_id is null
      and source_id=schedule_occurrence_id)
    or (work_kind='CRM_EVENT'
      and schedule_id is null and schedule_version is null and schedule_occurrence_id is null
      and subscription_id is not null and subscription_version is not null and crm_occurrence_id is not null
      and source_id=crm_occurrence_id)
  );

create unique index openclaw_send_work_schedule_identity_uidx
  on public.openclaw_send_work_items(
    organization_id,schedule_id,schedule_version,schedule_occurrence_id,target_id
  ) where work_kind='SCHEDULE_OCCURRENCE';
create unique index openclaw_send_work_crm_identity_uidx
  on public.openclaw_send_work_items(
    organization_id,subscription_id,subscription_version,crm_occurrence_id,target_id
  ) where work_kind='CRM_EVENT';
create unique index openclaw_send_work_source_key_uidx
  on public.openclaw_send_work_items(organization_id,source_key)
  where source_key is not null;

alter table public.openclaw_maintenance_work_items
  drop constraint openclaw_maintenance_work_items_state_check,
  drop constraint openclaw_maintenance_work_items_check1,
  add constraint openclaw_maintenance_work_items_state_check
    check (state in ('QUEUED','LEASED','DELETE_AUTHORIZED','AUDIT_VERIFY_AUTHORIZED',
      'COMPLETE','FAILED','DEAD_LETTER')),
  add column source_key text,
  add column credential_generation bigint,
  add column binding_defer_reason text,
  add column recovery_maintenance_principal_id uuid,
  add column recovery_credential_generation bigint,
  add column recovery_lease_generation bigint,
  add column recovery_fencing_token bigint,
  add column recovery_generation bigint not null default 0 check (recovery_generation>=0),
  add column recovery_lease_expires_at timestamptz,
  add constraint openclaw_maintenance_work_credential_binding_fkey
    foreign key (organization_id,maintenance_principal_id,credential_generation)
    references public.openclaw_maintenance_credentials(
      organization_id,maintenance_principal_id,credential_generation
    ) on delete restrict,
  add constraint openclaw_maintenance_work_lease_binding_fkey
    foreign key (organization_id,maintenance_principal_id,maintenance_lease_generation,fencing_token)
    references public.openclaw_maintenance_leases(
      organization_id,maintenance_principal_id,lease_generation,fencing_token
    ) on delete restrict,
  add constraint openclaw_maintenance_work_recovery_credential_fkey
    foreign key (organization_id,recovery_maintenance_principal_id,recovery_credential_generation)
    references public.openclaw_maintenance_credentials(
      organization_id,maintenance_principal_id,credential_generation
    ) on delete restrict,
  add constraint openclaw_maintenance_work_recovery_lease_fkey
    foreign key (organization_id,recovery_maintenance_principal_id,
      recovery_lease_generation,recovery_fencing_token)
    references public.openclaw_maintenance_leases(
      organization_id,maintenance_principal_id,lease_generation,fencing_token
    ) on delete restrict,
  add constraint openclaw_maintenance_work_recovery_binding_check check (
    (recovery_generation=0 and recovery_maintenance_principal_id is null
      and recovery_credential_generation is null and recovery_lease_generation is null
      and recovery_fencing_token is null and recovery_lease_expires_at is null)
    or
    (recovery_generation>0 and recovery_maintenance_principal_id is not null
      and recovery_credential_generation is not null and recovery_lease_generation is not null
      and recovery_fencing_token is not null and recovery_lease_expires_at is not null)
  ),
  add constraint openclaw_maintenance_work_claim_token_state_check check (
    (state='LEASED' and claim_token_hash is not null)
    or state in ('DELETE_AUTHORIZED','AUDIT_VERIFY_AUTHORIZED')
    or (state not in ('LEASED','DELETE_AUTHORIZED','AUDIT_VERIFY_AUTHORIZED')
      and claim_token_hash is null)
  );

alter table public.openclaw_maintenance_work_items
  alter column source_key set not null,
  alter column credential_generation set not null;

alter table public.openclaw_send_work_attempts
  add column credential_generation bigint not null,
  add column runtime_lease_generation bigint not null,
  add constraint openclaw_send_work_attempt_credential_binding_fkey
    foreign key (organization_id,account_id,cell_id,credential_generation)
    references public.openclaw_runtime_credentials(
      organization_id,account_id,cell_id,credential_generation
    ) on delete restrict,
  add constraint openclaw_send_work_attempt_lease_binding_fkey
    foreign key (organization_id,account_id,cell_id,runtime_lease_generation,fencing_token)
    references public.openclaw_runtime_leases(
      organization_id,account_id,cell_id,lease_generation,fencing_token
    ) on delete restrict;

alter table public.openclaw_maintenance_work_attempts
  add column credential_generation bigint not null,
  add constraint openclaw_maintenance_work_attempt_credential_binding_fkey
    foreign key (organization_id,maintenance_principal_id,credential_generation)
    references public.openclaw_maintenance_credentials(
      organization_id,maintenance_principal_id,credential_generation
    ) on delete restrict;

create unique index openclaw_maintenance_work_source_key_uidx
  on public.openclaw_maintenance_work_items(organization_id,source_key)
  where source_key is not null;

alter table public.openclaw_outbox
  add column credential_generation bigint,
  add column runtime_lease_generation bigint,
  add column campaign_version_id uuid,
  add constraint openclaw_outbox_claim_credential_fkey
    foreign key (organization_id,account_id,claimed_cell_id,credential_generation)
    references public.openclaw_runtime_credentials(
      organization_id,account_id,cell_id,credential_generation
    ) on delete restrict,
  add constraint openclaw_outbox_claim_lease_fkey
    foreign key (organization_id,account_id,claimed_cell_id,runtime_lease_generation,fencing_token)
    references public.openclaw_runtime_leases(
      organization_id,account_id,cell_id,lease_generation,fencing_token
    ) on delete restrict,
  add constraint openclaw_outbox_campaign_version_fkey
    foreign key (organization_id,account_id,campaign_version_id)
    references public.openclaw_campaign_runs(organization_id,account_id,id)
    on delete restrict;

create or replace function app_private.guard_openclaw_send_work_insert_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_target uuid;
  v_source_key text;
  v_credential bigint;
  v_lease bigint;
begin
  if NEW.work_kind='INBOUND_AUTOMATION' then
    v_target := nullif(NEW.payload->>'targetId','')::uuid;
    v_source_key := 'inbound:'||NEW.source_id||':'||NEW.source_version||':'||v_target;
    if NEW.schedule_id is not null or NEW.schedule_version is not null
       or NEW.schedule_occurrence_id is not null or NEW.subscription_id is not null
       or NEW.subscription_version is not null or NEW.crm_occurrence_id is not null then
      raise exception 'inbound work cannot carry schedule or CRM identity' using errcode='55000';
    end if;
  elsif NEW.work_kind='SCHEDULE_OCCURRENCE' then
    v_target := NEW.target_id;
    v_source_key := 'schedule:'||NEW.schedule_id||':'||NEW.schedule_version||':'
      ||NEW.schedule_occurrence_id||':'||NEW.target_id;
    if NEW.source_id is distinct from NEW.schedule_occurrence_id then
      raise exception 'schedule work source identity mismatch' using errcode='55000';
    end if;
  elsif NEW.work_kind='CRM_EVENT' then
    v_target := NEW.target_id;
    v_source_key := 'crm:'||NEW.subscription_id||':'||NEW.subscription_version||':'
      ||NEW.crm_occurrence_id||':'||NEW.target_id;
    if NEW.source_id is distinct from NEW.crm_occurrence_id then
      raise exception 'CRM work source identity mismatch' using errcode='55000';
    end if;
  else
    raise exception 'unknown send work kind' using errcode='55000';
  end if;
  if v_target is null then
    raise exception 'send work target must be frozen' using errcode='55000';
  end if;
  if NEW.target_id is not null and NEW.target_id<>v_target then
    raise exception 'send work target differs from frozen payload identity' using errcode='55000';
  end if;
  if NEW.source_key is not null and NEW.source_key<>v_source_key then
    raise exception 'send work source key is not canonical' using errcode='55000';
  end if;

  select credential.credential_generation,lease.lease_generation
  into v_credential,v_lease
  from public.openclaw_accounts account
  join public.openclaw_runtime_cells cell
    on cell.organization_id=account.organization_id and cell.account_id=account.id
   and cell.id=NEW.cell_id and cell.is_current and cell.state='READY'
  join public.openclaw_runtime_credentials credential
    on credential.organization_id=cell.organization_id and credential.account_id=cell.account_id
   and credential.cell_id=cell.id and credential.revoked_at is null
  join public.openclaw_runtime_leases lease
    on lease.organization_id=cell.organization_id and lease.account_id=cell.account_id
   and lease.cell_id=cell.id and lease.status='ACTIVE'
   and lease.expires_at>statement_timestamp() and lease.fencing_token=NEW.fencing_token
  where account.organization_id=NEW.organization_id and account.id=NEW.account_id
    and account.is_active and account.session_generation=NEW.session_generation
  order by credential.credential_generation desc,lease.lease_generation desc
  limit 1
  for share of credential,lease;
  if v_credential is null or v_lease is null then
    raise exception 'send work has no current credential lease binding' using errcode='42501';
  end if;
  if NEW.credential_generation is not null and NEW.credential_generation<>v_credential then
    raise exception 'send work credential generation is stale' using errcode='40001';
  end if;
  if NEW.runtime_lease_generation is not null and NEW.runtime_lease_generation<>v_lease then
    raise exception 'send work lease generation is stale' using errcode='40001';
  end if;
  NEW.target_id:=v_target;
  NEW.source_key:=v_source_key;
  NEW.credential_generation:=v_credential;
  NEW.runtime_lease_generation:=v_lease;
  NEW.claim_generation:=greatest(NEW.claim_generation,1);
  NEW.binding_defer_reason:=null;
  return NEW;
end;
$function$;

create trigger openclaw_send_work_items_binding_guard
before insert on public.openclaw_send_work_items
for each row execute function app_private.guard_openclaw_send_work_insert_v1();

create or replace function app_private.guard_openclaw_work_attempt_insert_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_send public.openclaw_send_work_items%rowtype;
  v_maintenance public.openclaw_maintenance_work_items%rowtype;
begin
  if TG_TABLE_NAME='openclaw_send_work_attempts' then
    select work.* into strict v_send from public.openclaw_send_work_items work
    where work.organization_id=NEW.organization_id and work.account_id=NEW.account_id
      and work.id=NEW.work_item_id and work.cell_id=NEW.cell_id
      and work.claim_generation=NEW.claim_generation
      and work.fencing_token=NEW.fencing_token and work.session_generation=NEW.session_generation
    for share;
    if NEW.credential_generation is not null
       and NEW.credential_generation<>v_send.credential_generation then
      raise exception 'send attempt credential generation mismatch' using errcode='55000';
    end if;
    if NEW.runtime_lease_generation is not null
       and NEW.runtime_lease_generation<>v_send.runtime_lease_generation then
      raise exception 'send attempt lease generation mismatch' using errcode='55000';
    end if;
    NEW.credential_generation:=v_send.credential_generation;
    NEW.runtime_lease_generation:=v_send.runtime_lease_generation;
  elsif TG_TABLE_NAME='openclaw_maintenance_work_attempts' then
    select work.* into strict v_maintenance from public.openclaw_maintenance_work_items work
    where work.organization_id=NEW.organization_id
      and work.maintenance_principal_id=NEW.maintenance_principal_id
      and work.id=NEW.work_item_id and work.claim_generation=NEW.claim_generation
      and work.maintenance_lease_generation=NEW.maintenance_lease_generation
      and work.fencing_token=NEW.fencing_token
    for share;
    if NEW.credential_generation is not null
       and NEW.credential_generation<>v_maintenance.credential_generation then
      raise exception 'maintenance attempt credential generation mismatch' using errcode='55000';
    end if;
    NEW.credential_generation:=v_maintenance.credential_generation;
  else
    raise exception 'deny unknown work attempt target %',TG_TABLE_NAME using errcode='55000';
  end if;
  return NEW;
end;
$function$;

create trigger openclaw_send_work_attempts_binding_guard
before insert on public.openclaw_send_work_attempts
for each row execute function app_private.guard_openclaw_work_attempt_insert_v1();
create trigger openclaw_maintenance_work_attempts_binding_guard
before insert on public.openclaw_maintenance_work_attempts
for each row execute function app_private.guard_openclaw_work_attempt_insert_v1();

create or replace function app_private.guard_openclaw_send_work_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_binding_changed boolean := row(
    NEW.account_id,NEW.cell_id,NEW.credential_generation,NEW.runtime_lease_generation,
    NEW.fencing_token,NEW.session_generation,NEW.binding_defer_reason
  ) is distinct from row(
    OLD.account_id,OLD.cell_id,OLD.credential_generation,OLD.runtime_lease_generation,
    OLD.fencing_token,OLD.session_generation,OLD.binding_defer_reason
  );
begin
  if row(
    NEW.id,NEW.organization_id,NEW.work_kind,NEW.source_id,NEW.source_version,
    NEW.source_key,NEW.source_hash,NEW.payload,NEW.payload_hash,NEW.target_id,
    NEW.schedule_id,NEW.schedule_version,NEW.schedule_occurrence_id,
    NEW.subscription_id,NEW.subscription_version,NEW.crm_occurrence_id,NEW.created_at
  ) is distinct from row(
    OLD.id,OLD.organization_id,OLD.work_kind,OLD.source_id,OLD.source_version,
    OLD.source_key,OLD.source_hash,OLD.payload,OLD.payload_hash,OLD.target_id,
    OLD.schedule_id,OLD.schedule_version,OLD.schedule_occurrence_id,
    OLD.subscription_id,OLD.subscription_version,OLD.crm_occurrence_id,OLD.created_at
  ) then
    raise exception 'send work typed source and frozen payload cannot change' using errcode='55000';
  end if;
  if v_binding_changed and (
    OLD.state<>'QUEUED' or NEW.state<>'QUEUED'
    or OLD.claim_token_hash is not null or NEW.claim_token_hash is not null
    or OLD.lease_expires_at is not null or NEW.lease_expires_at is not null
    or OLD.terminal_at is not null or NEW.terminal_at is not null
    or OLD.claim_generation<=0 or NEW.claim_generation<>OLD.claim_generation+1
    or NEW.payload is distinct from OLD.payload or NEW.payload_hash is distinct from OLD.payload_hash
    or NEW.retry_not_before is distinct from OLD.retry_not_before
    or NEW.attempt_count is distinct from OLD.attempt_count
  ) then
    raise exception 'send work binding can only rebind while unclaimed without changing frozen state'
      using errcode='55000';
  end if;
  return NEW;
end;
$function$;

create or replace function app_private.guard_openclaw_maintenance_work_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_binding_changed boolean := row(
    NEW.maintenance_principal_id,NEW.credential_generation,
    NEW.maintenance_lease_generation,NEW.fencing_token,NEW.binding_defer_reason
  ) is distinct from row(
    OLD.maintenance_principal_id,OLD.credential_generation,
    OLD.maintenance_lease_generation,OLD.fencing_token,OLD.binding_defer_reason
  );
begin
  if row(
    NEW.id,NEW.organization_id,NEW.work_kind,NEW.work_phase,NEW.source_id,
    NEW.source_version,NEW.source_key,NEW.source_hash,NEW.payload,NEW.payload_hash,NEW.created_at
  ) is distinct from row(
    OLD.id,OLD.organization_id,OLD.work_kind,OLD.work_phase,OLD.source_id,
    OLD.source_version,OLD.source_key,OLD.source_hash,OLD.payload,OLD.payload_hash,OLD.created_at
  ) then
    raise exception 'maintenance work typed source and frozen payload cannot change' using errcode='55000';
  end if;
  if v_binding_changed and (
    OLD.state<>'QUEUED' or NEW.state<>'QUEUED'
    or OLD.claim_token_hash is not null or NEW.claim_token_hash is not null
    or OLD.lease_expires_at is not null or NEW.lease_expires_at is not null
    or OLD.terminal_at is not null or NEW.terminal_at is not null
    or OLD.claim_generation<=0 or NEW.claim_generation<>OLD.claim_generation+1
    or NEW.retry_not_before is distinct from OLD.retry_not_before
    or NEW.attempt_count is distinct from OLD.attempt_count
  ) then
    raise exception 'maintenance work binding can only rebind while unclaimed without changing frozen state'
      using errcode='55000';
  end if;
  return NEW;
end;
$function$;

create trigger openclaw_schedule_occurrences_append_only
before update or delete on public.openclaw_schedule_occurrences
for each row execute function app_private.reject_openclaw_append_only_v1();

create or replace function app_private.openclaw_apply_schedule_write_v1(
  p_action text,p_organization_id uuid,p_actor_id uuid,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_schedule public.openclaw_schedules%rowtype;
  v_campaign_version public.openclaw_campaign_runs%rowtype;
  v_schedule_id uuid := coalesce(nullif(p_request->>'scheduleId','')::uuid,gen_random_uuid());
  v_account uuid := (p_request->>'accountId')::uuid;
  v_version bigint;
  v_status text;
  v_rule text;
  v_timezone text;
  v_nominal timestamp;
  v_resolved record;
  v_grace integer;
  v_fold text;
  v_snapshot jsonb;
  v_snapshot_bytes bytea;
  v_snapshot_hash text;
begin
  if p_action not in ('UPSERT','PAUSE','CANCEL') then
    raise exception 'unsupported schedule action' using errcode='22023';
  end if;
  if p_action='UPSERT' and p_request ? 'nextRunAt' then
    raise exception 'nextRunAt is database-derived and must not be supplied' using errcode='22023';
  end if;
  if p_action='UPSERT' and (
    nullif(p_request->>'targetId','') is null
    or nullif(p_request->>'campaignVersionId','') is null
  ) then
    raise exception 'targetId and immutable campaignVersionId are required'
      using errcode='22023';
  end if;

  if p_action='UPSERT' then
    select campaign_version.* into strict v_campaign_version
    from public.openclaw_campaign_runs campaign_version
    where campaign_version.organization_id=p_organization_id
      and campaign_version.account_id=v_account
      and campaign_version.id=(p_request->>'campaignVersionId')::uuid
      and campaign_version.automation_version_id=(p_request->>'automationVersionId')::uuid
      and campaign_version.status in ('PLANNED','RUNNING')
    for share;
    v_rule := p_request->>'localRecurrenceRule';
    perform app_private.openclaw_parse_local_recurrence_rule_v1(v_rule);
    v_timezone := p_request->>'timezone';
    if not exists (select 1 from pg_catalog.pg_timezone_names zone where zone.name=v_timezone) then
      raise exception 'unknown IANA timezone' using errcode='22023';
    end if;
    v_grace := coalesce((p_request->>'occurrenceGraceSeconds')::integer,300);
    v_fold := coalesce(p_request->>'dstFoldPolicy','EARLIER_OFFSET');
    if v_grace not between 60 and 3600 or v_fold not in ('EARLIER_OFFSET','LATER_OFFSET') then
      raise exception 'invalid occurrence grace or DST fold policy' using errcode='22023';
    end if;
    v_nominal := app_private.openclaw_next_schedule_occurrence_v1(v_rule,null);
    select * into strict v_resolved
    from app_private.openclaw_resolve_local_occurrence_v1(v_nominal,v_timezone,v_fold);
  end if;

  if p_action='UPSERT' and nullif(p_request->>'scheduleId','') is null then
    v_version := 1;
    v_status := 'PAUSED';
    insert into public.openclaw_schedules(
      id,organization_id,account_id,automation_version_id,target_id,campaign_id,
      campaign_version_id,
      schedule_version,status,timezone,local_recurrence_rule,next_run_at,
      occurrence_grace_seconds,dst_fold_policy,next_nominal_local,next_resolved_local,
      next_utc_offset_seconds,next_resolution,cursor_version,binding_defer_reason
    ) values (
      v_schedule_id,p_organization_id,v_account,(p_request->>'automationVersionId')::uuid,
      (p_request->>'targetId')::uuid,v_campaign_version.campaign_id,v_campaign_version.id,
      1,v_status,v_timezone,v_rule,v_resolved.planned_for,
      v_grace,v_fold,v_nominal,v_resolved.resolved_local,v_resolved.utc_offset_seconds,
      v_resolved.resolution,1,null
    );
  else
    select schedule.* into strict v_schedule
    from public.openclaw_schedules schedule
    where schedule.organization_id=p_organization_id
      and schedule.id=(p_request->>'scheduleId')::uuid
    for update;
    if v_schedule.schedule_version<>(p_request->>'expectedScheduleVersion')::bigint then
      raise exception 'schedule version mismatch' using errcode='40001';
    end if;
    v_schedule_id := v_schedule.id;
    v_account := v_schedule.account_id;
    v_version := v_schedule.schedule_version+1;
    v_status := case p_action when 'PAUSE' then 'PAUSED' when 'CANCEL' then 'CANCELLED' else 'PAUSED' end;
    update public.openclaw_schedules schedule set
      automation_version_id=case when p_action='UPSERT' then (p_request->>'automationVersionId')::uuid else schedule.automation_version_id end,
      target_id=case when p_action='UPSERT' then (p_request->>'targetId')::uuid else schedule.target_id end,
      campaign_id=case when p_action='UPSERT' then v_campaign_version.campaign_id else schedule.campaign_id end,
      campaign_version_id=case when p_action='UPSERT' then v_campaign_version.id else schedule.campaign_version_id end,
      schedule_version=v_version,status=v_status,
      timezone=case when p_action='UPSERT' then v_timezone else schedule.timezone end,
      local_recurrence_rule=case when p_action='UPSERT' then v_rule else schedule.local_recurrence_rule end,
      occurrence_grace_seconds=case when p_action='UPSERT' then v_grace else schedule.occurrence_grace_seconds end,
      dst_fold_policy=case when p_action='UPSERT' then v_fold else schedule.dst_fold_policy end,
      next_nominal_local=case when p_action='UPSERT' then v_nominal else schedule.next_nominal_local end,
      next_resolved_local=case when p_action='UPSERT' then v_resolved.resolved_local else schedule.next_resolved_local end,
      next_run_at=case when p_action='UPSERT' then v_resolved.planned_for else schedule.next_run_at end,
      next_utc_offset_seconds=case when p_action='UPSERT' then v_resolved.utc_offset_seconds else schedule.next_utc_offset_seconds end,
      next_resolution=case when p_action='UPSERT' then v_resolved.resolution else schedule.next_resolution end,
      cursor_version=schedule.cursor_version+1,binding_defer_reason=null,
      updated_at=statement_timestamp()
    where schedule.organization_id=p_organization_id and schedule.id=v_schedule.id;
  end if;

  select schedule.* into strict v_schedule from public.openclaw_schedules schedule
  where schedule.organization_id=p_organization_id and schedule.id=v_schedule_id;
  v_snapshot := jsonb_build_object(
    'version',1,'scheduleId',v_schedule.id,'scheduleVersion',v_schedule.schedule_version,
    'automationVersionId',v_schedule.automation_version_id,'targetId',v_schedule.target_id,
    'campaignVersionId',v_schedule.campaign_version_id,
    'status',v_schedule.status,'timezone',v_schedule.timezone,
    'localRecurrenceRule',v_schedule.local_recurrence_rule,
    'missedOccurrencePolicy',v_schedule.missed_occurrence_policy,
    'occurrenceGraceSeconds',v_schedule.occurrence_grace_seconds,
    'dstFoldPolicy',v_schedule.dst_fold_policy
  );
  v_snapshot_bytes := app_private.openclaw_jcs_bytes_v1(v_snapshot);
  v_snapshot_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-schedule-snapshot-v1','UTF8')||decode('00','hex')||v_snapshot_bytes,
    'sha256'),'hex');
  insert into public.openclaw_schedule_snapshots(
    organization_id,account_id,schedule_id,schedule_version,automation_version_id,
    target_id,campaign_id,campaign_version_id,status,timezone,local_recurrence_rule,missed_occurrence_policy,
    occurrence_grace_seconds,dst_fold_policy,snapshot,snapshot_bytes,snapshot_hash,created_by
  ) values (
    p_organization_id,v_schedule.account_id,v_schedule.id,v_schedule.schedule_version,
    v_schedule.automation_version_id,v_schedule.target_id,v_schedule.campaign_id,
    v_schedule.campaign_version_id,v_schedule.status,
    v_schedule.timezone,v_schedule.local_recurrence_rule,v_schedule.missed_occurrence_policy,
    v_schedule.occurrence_grace_seconds,v_schedule.dst_fold_policy,
    v_snapshot,v_snapshot_bytes,v_snapshot_hash,p_actor_id
  );
  return jsonb_build_object('version',1,'scheduleId',v_schedule.id,
    'scheduleVersion',v_schedule.schedule_version,'status',v_schedule.status,
    'nextRunAt',v_schedule.next_run_at,'snapshotHash',v_snapshot_hash);
end;
$function$;

create or replace function app_private.materialize_openclaw_schedule_work_v1(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := statement_timestamp();
  schedule record;
  v_occurrence_id uuid;
  v_status text;
  v_evidence jsonb;
  v_bytes bytea;
  v_hash text;
  v_next_local timestamp;
  v_next record;
  v_cell uuid;
  v_credential bigint;
  v_lease bigint;
  v_fence bigint;
  v_session bigint;
  v_snapshot_hash text;
  v_target_version bigint;
  v_target_directory_refreshed_at timestamptz;
  v_template_version uuid;
  v_knowledge_version_ids uuid[];
  v_payload jsonb;
  v_payload_bytes bytea;
  v_inserted integer;
  v_created integer := 0;
begin
  for schedule in
    select candidate_schedule.*
    from public.openclaw_schedules candidate_schedule
    where candidate_schedule.status='ACTIVE'
      and candidate_schedule.next_run_at is not null
      and candidate_schedule.next_run_at<=v_now
    order by candidate_schedule.next_run_at,candidate_schedule.id
    for update of candidate_schedule skip locked
    limit greatest(1,least(coalesce(p_limit,100),500))
  loop
    if schedule.campaign_id is null or schedule.campaign_version_id is null
       or schedule.target_id is null then
      update public.openclaw_schedules set binding_defer_reason='CAMPAIGN_VERSION_REQUIRED',
        status='PAUSED',updated_at=v_now
      where organization_id=schedule.organization_id and id=schedule.id;
      continue;
    end if;

    v_status := case when v_now>schedule.next_run_at
      + make_interval(secs=>schedule.occurrence_grace_seconds)
      then 'SKIPPED_MISSED' else 'MATERIALIZED' end;
    v_cell:=null; v_credential:=null; v_lease:=null; v_fence:=null; v_session:=null;
    if v_status='MATERIALIZED' then
      select cell.id,credential.credential_generation,lease.lease_generation,
        lease.fencing_token,account.session_generation
      into v_cell,v_credential,v_lease,v_fence,v_session
      from public.openclaw_accounts account
      join public.openclaw_runtime_cells cell
        on cell.organization_id=account.organization_id and cell.account_id=account.id
       and cell.is_current and cell.state='READY'
      join public.openclaw_runtime_leases lease
        on lease.organization_id=cell.organization_id and lease.account_id=cell.account_id
       and lease.cell_id=cell.id and lease.status='ACTIVE' and lease.expires_at>v_now
      join public.openclaw_runtime_credentials credential
        on credential.organization_id=cell.organization_id and credential.account_id=cell.account_id
       and credential.cell_id=cell.id and credential.revoked_at is null
      where account.organization_id=schedule.organization_id and account.id=schedule.account_id
        and account.is_active
      order by lease.lease_generation desc,credential.credential_generation desc
      limit 1 for share of credential,lease;
      if v_cell is null then
        update public.openclaw_schedules set binding_defer_reason='NO_CURRENT_CHANNEL_BINDING',
          updated_at=v_now
        where organization_id=schedule.organization_id and id=schedule.id;
        continue;
      end if;
    end if;
    select snapshot.snapshot_hash,target.target_version,target.directory_refreshed_at,
      automation.content_version_id,automation.knowledge_version_ids
    into strict v_snapshot_hash,v_target_version,v_target_directory_refreshed_at,
      v_template_version,v_knowledge_version_ids
    from public.openclaw_schedule_snapshots snapshot
    join public.openclaw_targets target
      on target.organization_id=snapshot.organization_id and target.account_id=snapshot.account_id
     and target.id=snapshot.target_id
    join public.openclaw_automation_versions automation
      on automation.organization_id=snapshot.organization_id
     and automation.account_id=snapshot.account_id
     and automation.id=snapshot.automation_version_id
    where snapshot.organization_id=schedule.organization_id
      and snapshot.account_id=schedule.account_id and snapshot.schedule_id=schedule.id
      and snapshot.schedule_version=schedule.schedule_version
      and snapshot.campaign_version_id=schedule.campaign_version_id;
    v_evidence := jsonb_build_object(
      'version',1,'scheduleId',schedule.id,'scheduleVersion',schedule.schedule_version,
      'targetId',schedule.target_id,'plannedLocal',schedule.next_nominal_local,
      'resolvedLocal',schedule.next_resolved_local,'plannedFor',schedule.next_run_at,
      'utcOffsetSeconds',schedule.next_utc_offset_seconds,'resolution',schedule.next_resolution,
      'occurrenceStatus',v_status,'databaseTime',v_now
    );
    v_bytes := app_private.openclaw_jcs_bytes_v1(v_evidence);
    v_hash := encode(extensions.digest(
      convert_to('ihome-openclaw-schedule-occurrence-v1','UTF8')||decode('00','hex')||v_bytes,
      'sha256'),'hex');
    insert into public.openclaw_schedule_occurrences(
      organization_id,account_id,schedule_id,schedule_version,target_id,planned_local,
      resolved_local,planned_for,utc_offset_seconds,resolution,occurrence_status,
      occurrence_evidence,occurrence_evidence_bytes,occurrence_evidence_hash
    ) values (
      schedule.organization_id,schedule.account_id,schedule.id,schedule.schedule_version,
      schedule.target_id,schedule.next_nominal_local,schedule.next_resolved_local,
      schedule.next_run_at,schedule.next_utc_offset_seconds,schedule.next_resolution,
      v_status,v_evidence,v_bytes,v_hash
    ) on conflict (organization_id,account_id,schedule_id,schedule_version,planned_local)
      do nothing returning id into v_occurrence_id;
    if v_occurrence_id is null then
      select occurrence.id into strict v_occurrence_id
      from public.openclaw_schedule_occurrences occurrence
      where occurrence.organization_id=schedule.organization_id
        and occurrence.account_id=schedule.account_id and occurrence.schedule_id=schedule.id
        and occurrence.schedule_version=schedule.schedule_version
        and occurrence.planned_local=schedule.next_nominal_local;
    end if;

    if v_status='MATERIALIZED' then
        v_payload:=jsonb_build_object('kind','SCHEDULE_OCCURRENCE','scheduleId',schedule.id,
          'scheduleVersion',schedule.schedule_version,'occurrenceId',v_occurrence_id,
          'campaignVersionId',schedule.campaign_version_id,
          'automationVersionId',schedule.automation_version_id,'targetId',schedule.target_id,
          'targetVersion',v_target_version,
          'targetDirectoryRefreshedAt',v_target_directory_refreshed_at,
          'templateVersionId',v_template_version,
          'knowledgeVersionIds',to_jsonb(v_knowledge_version_ids),
          'eligibilityDecisionHash',v_hash);
        v_payload_bytes:=app_private.openclaw_jcs_bytes_v1(v_payload);
        insert into public.openclaw_send_work_items(
          organization_id,account_id,cell_id,work_kind,source_id,source_version,source_key,
          source_hash,payload,payload_hash,state,claim_generation,fencing_token,
          session_generation,target_id,credential_generation,runtime_lease_generation,
          schedule_id,schedule_version,schedule_occurrence_id,campaign_version_id
        ) values (
          schedule.organization_id,schedule.account_id,v_cell,'SCHEDULE_OCCURRENCE',
          v_occurrence_id,schedule.schedule_version::text,
          'schedule:'||schedule.id||':'||schedule.schedule_version||':'||v_occurrence_id||':'||schedule.target_id,
          v_snapshot_hash,v_payload,
          encode(extensions.digest(v_payload_bytes,'sha256'),'hex'),'QUEUED',1,v_fence,v_session,
          schedule.target_id,v_credential,v_lease,schedule.id,schedule.schedule_version,
          v_occurrence_id,schedule.campaign_version_id
        ) on conflict (organization_id,schedule_id,schedule_version,schedule_occurrence_id,target_id)
          where work_kind='SCHEDULE_OCCURRENCE' do nothing;
        get diagnostics v_inserted=row_count;
        v_created := v_created+v_inserted;
    end if;

    v_next_local := app_private.openclaw_next_schedule_occurrence_v1(
      schedule.local_recurrence_rule,schedule.next_nominal_local);
    if v_status='SKIPPED_MISSED' then
      while v_next_local is not null loop
        select * into strict v_next from app_private.openclaw_resolve_local_occurrence_v1(
          v_next_local,schedule.timezone,schedule.dst_fold_policy);
        exit when v_next.planned_for>v_now;
        v_evidence:=jsonb_build_object(
          'version',1,'scheduleId',schedule.id,'scheduleVersion',schedule.schedule_version,
          'targetId',schedule.target_id,'plannedLocal',v_next_local,
          'resolvedLocal',v_next.resolved_local,'plannedFor',v_next.planned_for,
          'utcOffsetSeconds',v_next.utc_offset_seconds,'resolution',v_next.resolution,
          'occurrenceStatus','SKIPPED_MISSED','databaseTime',v_now
        );
        v_bytes:=app_private.openclaw_jcs_bytes_v1(v_evidence);
        v_hash:=encode(extensions.digest(
          convert_to('ihome-openclaw-schedule-occurrence-v1','UTF8')||decode('00','hex')||v_bytes,
          'sha256'),'hex');
        insert into public.openclaw_schedule_occurrences(
          organization_id,account_id,schedule_id,schedule_version,target_id,planned_local,
          resolved_local,planned_for,utc_offset_seconds,resolution,occurrence_status,
          occurrence_evidence,occurrence_evidence_bytes,occurrence_evidence_hash
        ) values (
          schedule.organization_id,schedule.account_id,schedule.id,schedule.schedule_version,
          schedule.target_id,v_next_local,v_next.resolved_local,v_next.planned_for,
          v_next.utc_offset_seconds,v_next.resolution,'SKIPPED_MISSED',v_evidence,v_bytes,v_hash
        ) on conflict (organization_id,account_id,schedule_id,schedule_version,planned_local)
          do nothing;
        v_next_local := app_private.openclaw_next_schedule_occurrence_v1(
          schedule.local_recurrence_rule,v_next_local);
      end loop;
    elsif v_next_local is not null then
      select * into strict v_next from app_private.openclaw_resolve_local_occurrence_v1(
        v_next_local,schedule.timezone,schedule.dst_fold_policy);
    end if;
    if v_next_local is null then
      update public.openclaw_schedules current_schedule set
        next_nominal_local=null,next_resolved_local=null,next_run_at=null,
        next_utc_offset_seconds=null,next_resolution=null,
        cursor_version=current_schedule.cursor_version+1,
        binding_defer_reason=null,status='COMPLETE',updated_at=v_now
      where current_schedule.organization_id=schedule.organization_id
        and current_schedule.id=schedule.id
        and current_schedule.schedule_version=schedule.schedule_version;
    else
      update public.openclaw_schedules current_schedule set
        next_nominal_local=v_next_local,
        next_resolved_local=v_next.resolved_local,
        next_run_at=v_next.planned_for,
        next_utc_offset_seconds=v_next.utc_offset_seconds,
        next_resolution=v_next.resolution,
        cursor_version=current_schedule.cursor_version+1,
        binding_defer_reason=null,updated_at=v_now
      where current_schedule.organization_id=schedule.organization_id
        and current_schedule.id=schedule.id
        and current_schedule.schedule_version=schedule.schedule_version;
    end if;
  end loop;
  return v_created;
end;
$function$;

create or replace function app_private.materialize_openclaw_crm_work_v1(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  item record;
  v_now timestamptz := statement_timestamp();
  v_cell uuid;
  v_credential bigint;
  v_lease bigint;
  v_fence bigint;
  v_session bigint;
  v_payload jsonb;
  v_payload_bytes bytea;
  v_source_hash text;
  v_inserted integer;
  v_created integer := 0;
begin
  for item in
    select occurrence.id crm_occurrence_id,occurrence.organization_id,
      occurrence.event_type,occurrence.event_subtype,occurrence.source_snapshot,
      occurrence.snapshot_hash source_envelope_hash,subscription.id subscription_id,
      subscription.account_id,subscription.subscription_version,
      subscription.automation_version_id,subscription.destination_target_id,
      snapshot.snapshot_hash subscription_snapshot_hash,snapshot.field_mapping_hash,
      target.target_version,target.directory_refreshed_at,
      automation.content_version_id template_version_id,
      automation.knowledge_version_ids
    from public.openclaw_crm_event_occurrences occurrence
    join public.openclaw_crm_event_subscriptions subscription
      on subscription.organization_id=occurrence.organization_id
     and subscription.event_type=occurrence.event_type and subscription.is_active
    join public.openclaw_crm_event_subscription_snapshots snapshot
      on snapshot.organization_id=subscription.organization_id
     and snapshot.account_id=subscription.account_id and snapshot.subscription_id=subscription.id
      and snapshot.subscription_version=subscription.subscription_version
    join public.openclaw_targets target
      on target.organization_id=subscription.organization_id
     and target.account_id=subscription.account_id
     and target.id=subscription.destination_target_id and target.is_active
    join public.openclaw_automation_versions automation
      on automation.organization_id=subscription.organization_id
     and automation.account_id=subscription.account_id
     and automation.id=subscription.automation_version_id
    join public.openclaw_control_states control
      on control.organization_id=subscription.organization_id and control.control_key='GLOBAL_STOP'
     and control.feature_enabled and control.proactive_enabled and not control.global_stop
    where not exists (
      select 1 from public.openclaw_send_work_items work
      where work.organization_id=occurrence.organization_id and work.work_kind='CRM_EVENT'
        and work.subscription_id=subscription.id
        and work.subscription_version=subscription.subscription_version
        and work.crm_occurrence_id=occurrence.id
        and work.target_id=subscription.destination_target_id
    )
    order by occurrence.created_at,occurrence.id,subscription.id
    for update of occurrence,subscription skip locked
    limit greatest(1,least(coalesce(p_limit,100),500))
  loop
    select cell.id,credential.credential_generation,lease.lease_generation,
      lease.fencing_token,account.session_generation
    into v_cell,v_credential,v_lease,v_fence,v_session
    from public.openclaw_accounts account
    join public.openclaw_runtime_cells cell
      on cell.organization_id=account.organization_id and cell.account_id=account.id
     and cell.is_current and cell.state='READY'
    join public.openclaw_runtime_leases lease
      on lease.organization_id=cell.organization_id and lease.account_id=cell.account_id
     and lease.cell_id=cell.id and lease.status='ACTIVE' and lease.expires_at>v_now
    join public.openclaw_runtime_credentials credential
      on credential.organization_id=cell.organization_id and credential.account_id=cell.account_id
     and credential.cell_id=cell.id and credential.revoked_at is null
    where account.organization_id=item.organization_id and account.id=item.account_id
      and account.is_active
    order by lease.lease_generation desc,credential.credential_generation desc
    limit 1;
    if v_cell is null then continue; end if;
    v_payload := jsonb_build_object(
      'kind','CRM_EVENT','subscriptionId',item.subscription_id,
      'subscriptionVersion',item.subscription_version,'occurrenceId',item.crm_occurrence_id,
      'automationVersionId',item.automation_version_id,
      'templateVersionId',item.template_version_id,
      'knowledgeVersionIds',to_jsonb(item.knowledge_version_ids),
      'targetId',item.destination_target_id,'targetVersion',item.target_version,
      'targetDirectoryRefreshedAt',item.directory_refreshed_at,
      'fieldMappingHash',item.field_mapping_hash,
      'sourceEnvelope',item.source_snapshot,
      'sourceEnvelopeHash',item.source_envelope_hash
    );
    v_payload_bytes := app_private.openclaw_jcs_bytes_v1(v_payload);
    v_source_hash := encode(extensions.digest(
      convert_to('ihome-openclaw-crm-work-source-v1','UTF8')||decode('00','hex')
        ||app_private.openclaw_jcs_bytes_v1(jsonb_build_object(
          'subscriptionSnapshotHash',item.subscription_snapshot_hash,
          'sourceEnvelopeHash',item.source_envelope_hash
        )),'sha256'),'hex');
    insert into public.openclaw_send_work_items(
      organization_id,account_id,cell_id,work_kind,source_id,source_version,source_key,
      source_hash,payload,payload_hash,state,claim_generation,fencing_token,
      session_generation,target_id,credential_generation,runtime_lease_generation,
      subscription_id,subscription_version,crm_occurrence_id
    ) values (
      item.organization_id,item.account_id,v_cell,'CRM_EVENT',item.crm_occurrence_id,
      item.subscription_version::text,
      'crm:'||item.subscription_id||':'||item.subscription_version||':'
        ||item.crm_occurrence_id||':'||item.destination_target_id,
      v_source_hash,v_payload,
      encode(extensions.digest(v_payload_bytes,'sha256'),'hex'),'QUEUED',1,
      v_fence,v_session,item.destination_target_id,v_credential,v_lease,
      item.subscription_id,item.subscription_version,item.crm_occurrence_id
    ) on conflict (organization_id,subscription_id,subscription_version,crm_occurrence_id,target_id)
      where work_kind='CRM_EVENT' do nothing;
    get diagnostics v_inserted=row_count;
    v_created := v_created+v_inserted;
  end loop;
  return v_created;
end;
$function$;

create or replace function app_private.rebind_openclaw_unclaimed_work_v1(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := statement_timestamp();
  v_send integer := 0;
  v_maintenance integer := 0;
begin
  with current_binding as (
    select distinct on (account.organization_id,account.id)
      account.organization_id,account.id account_id,account.session_generation,
      cell.id cell_id,credential.credential_generation,
      lease.lease_generation runtime_lease_generation,lease.fencing_token
    from public.openclaw_accounts account
    join public.openclaw_runtime_cells cell
      on cell.organization_id=account.organization_id and cell.account_id=account.id
     and cell.is_current and cell.state='READY'
    join public.openclaw_runtime_credentials credential
      on credential.organization_id=cell.organization_id and credential.account_id=cell.account_id
     and credential.cell_id=cell.id and credential.revoked_at is null
    join public.openclaw_runtime_leases lease
      on lease.organization_id=cell.organization_id and lease.account_id=cell.account_id
     and lease.cell_id=cell.id and lease.status='ACTIVE' and lease.expires_at>v_now
    where account.is_active
    order by account.organization_id,account.id,lease.lease_generation desc,
      credential.credential_generation desc
  ), candidates as (
    select work.id,binding.*
    from public.openclaw_send_work_items work
    join current_binding binding
      on binding.organization_id=work.organization_id and binding.account_id=work.account_id
    where work.state = 'QUEUED' and work.claim_token_hash is null
      and work.lease_expires_at is null and work.terminal_at is null
      and work.claim_generation>0
      and row(work.cell_id,work.credential_generation,work.runtime_lease_generation,
        work.fencing_token,work.session_generation)
        is distinct from row(binding.cell_id,binding.credential_generation,
          binding.runtime_lease_generation,binding.fencing_token,binding.session_generation)
    order by work.created_at,work.id
    for update of work skip locked
    limit greatest(1,least(coalesce(p_limit,100),500))
  )
  update public.openclaw_send_work_items work set
    cell_id=candidate.cell_id,credential_generation=candidate.credential_generation,
    runtime_lease_generation=candidate.runtime_lease_generation,
    fencing_token=candidate.fencing_token,session_generation=candidate.session_generation,
    claim_generation=work.claim_generation+1,binding_defer_reason=null,
    updated_at=v_now
  from candidates candidate
  where work.id=candidate.id and work.organization_id=candidate.organization_id
    and work.state='QUEUED' and work.claim_token_hash is null
    and work.lease_expires_at is null and work.terminal_at is null;
  get diagnostics v_send=row_count;

  with current_binding as (
    select distinct on (principal.organization_id)
      principal.organization_id,principal.id maintenance_principal_id,
      credential.credential_generation,lease.lease_generation,lease.fencing_token
    from public.openclaw_maintenance_principals principal
    join public.openclaw_maintenance_credentials credential
      on credential.organization_id=principal.organization_id
     and credential.maintenance_principal_id=principal.id and credential.revoked_at is null
    join public.openclaw_maintenance_leases lease
      on lease.organization_id=principal.organization_id
     and lease.maintenance_principal_id=principal.id
     and lease.status='ACTIVE' and lease.expires_at>v_now
    where principal.is_current and principal.revoked_at is null
    order by principal.organization_id,lease.lease_generation desc,
      credential.credential_generation desc
  ), candidates as (
    select work.id,binding.*
    from public.openclaw_maintenance_work_items work
    join current_binding binding on binding.organization_id=work.organization_id
    where work.state='QUEUED' and work.claim_token_hash is null
      and work.lease_expires_at is null and work.terminal_at is null
      and work.claim_generation>0
      and row(work.maintenance_principal_id,work.credential_generation,
        work.maintenance_lease_generation,work.fencing_token)
        is distinct from row(binding.maintenance_principal_id,binding.credential_generation,
          binding.lease_generation,binding.fencing_token)
    order by work.created_at,work.id
    for update of work skip locked
    limit greatest(1,least(coalesce(p_limit,100),500))
  )
  update public.openclaw_maintenance_work_items work set
    maintenance_principal_id=candidate.maintenance_principal_id,
    credential_generation=candidate.credential_generation,
    maintenance_lease_generation=candidate.lease_generation,
    fencing_token=candidate.fencing_token,claim_generation=work.claim_generation+1,
    binding_defer_reason=null,updated_at=v_now
  from candidates candidate
  where work.id=candidate.id and work.organization_id=candidate.organization_id
    and work.state='QUEUED' and work.claim_token_hash is null
    and work.lease_expires_at is null and work.terminal_at is null;
  get diagnostics v_maintenance=row_count;
  return v_send+v_maintenance;
end;
$function$;

create or replace function app_private.openclaw_claim_inbound_automation_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal->>'organizationId')::uuid;
  v_account uuid := (p_principal->>'accountId')::uuid;
  v_cell uuid := (p_principal->>'cellId')::uuid;
  v_limit integer := greatest(1,least(coalesce((p_request->>'limit')::integer,10),50));
  v_seconds integer := greatest(5,least(coalesce((p_request->>'leaseSeconds')::integer,30),60));
  v_expires timestamptz;
  v_token text;
  v_items jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','claimToken','limit','leaseSeconds'],
    array['version','claimToken','limit','leaseSeconds']
  );
  if p_request->>'version'<>'1'
     or char_length(p_request->>'claimToken') not between 32 and 512
     or (p_request->>'limit')::integer not between 1 and 25
     or (p_request->>'leaseSeconds')::integer not between 5 and 60
  then
    raise exception 'canonical outbox claim request is invalid' using errcode='22023';
  end if;
  select least(lease.expires_at,statement_timestamp()+make_interval(secs=>v_seconds))
  into v_expires
  from public.openclaw_accounts account
  join public.openclaw_runtime_cells cell
    on cell.organization_id=account.organization_id and cell.account_id=account.id
   and cell.id=v_cell and cell.is_current and cell.state='READY'
  join public.openclaw_runtime_credentials credential
    on credential.organization_id=cell.organization_id and credential.account_id=cell.account_id
   and credential.cell_id=cell.id
  join public.openclaw_runtime_leases lease
    on lease.organization_id=cell.organization_id and lease.account_id=cell.account_id
   and lease.cell_id=cell.id
  where account.organization_id=v_org and account.id=v_account and account.is_active
    and account.session_generation=(p_principal->>'sessionGeneration')::bigint
    and credential.credential_generation=(p_principal->>'credentialGeneration')::bigint
    and credential.revoked_at is null
    and lease.lease_generation=(p_principal->>'leaseGeneration')::bigint
    and lease.fencing_token=(p_principal->>'fencingToken')::bigint
    and lease.status='ACTIVE' and lease.expires_at>statement_timestamp();
  if v_expires is null then
    raise exception 'inbound work credential or lease is stale' using errcode='42501';
  end if;
  v_token:=encode(extensions.digest(
    convert_to('ihome-openclaw-inbound-automation-claim-v1','UTF8')||decode('00','hex')
      ||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');
  with candidates as (
    select work.id from public.openclaw_send_work_items work
    where work.organization_id=v_org and work.account_id=v_account and work.cell_id=v_cell
      and work.work_kind='INBOUND_AUTOMATION' and work.state='QUEUED'
      and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
      and work.runtime_lease_generation=(p_principal->>'leaseGeneration')::bigint
      and work.fencing_token=(p_principal->>'fencingToken')::bigint
      and work.session_generation=(p_principal->>'sessionGeneration')::bigint
      and work.binding_defer_reason is null and work.claim_token_hash is null
      and work.lease_expires_at is null and work.terminal_at is null
      and (work.retry_not_before is null or work.retry_not_before<=statement_timestamp())
    order by work.created_at,work.id for update skip locked limit v_limit
  ), claimed as (
    update public.openclaw_send_work_items work set state='LEASED',claim_token_hash=v_token,
      claim_generation=work.claim_generation+1,lease_expires_at=v_expires,
      attempt_count=work.attempt_count+1,updated_at=statement_timestamp()
    from candidates where work.organization_id=v_org and work.id=candidates.id
    returning work.*
  ) select coalesce(jsonb_agg(jsonb_build_object(
    'workItemId',id,'claimGeneration',claim_generation,'leaseExpiresAt',lease_expires_at,
    'inboundEventId',source_id,'sourceKey',source_key,'targetId',target_id,
    'sourceHash',source_hash,'payload',payload,'payloadHash',payload_hash
  ) order by id),'[]'::jsonb) into v_items from claimed;
  return jsonb_build_object('version',1,
    'credentialGeneration',(p_principal->>'credentialGeneration')::bigint,
    'leaseGeneration',(p_principal->>'leaseGeneration')::bigint,
    'fencingToken',(p_principal->>'fencingToken')::bigint,
    'items',v_items,'databaseTime',statement_timestamp());
end;
$function$;

create or replace function app_private.openclaw_complete_inbound_automation_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal->>'organizationId')::uuid;
  v_account uuid := (p_principal->>'accountId')::uuid;
  v_cell uuid := (p_principal->>'cellId')::uuid;
  v_work uuid := (p_request->>'workItemId')::uuid;
  v_claim bigint := (p_request->>'claimGeneration')::bigint;
  v_outcome text := p_request->>'outcome';
  v_token text;
  v_attempt integer;
  v_evidence jsonb := coalesce(p_request->'evidence','{}'::jsonb);
begin
  if p_request->>'version'<>'1' or v_outcome not in ('COMPLETE','RETRY','FAILED','DEAD_LETTER') then
    raise exception 'invalid inbound automation completion' using errcode='22023';
  end if;
  v_token:=encode(extensions.digest(
    convert_to('ihome-openclaw-inbound-automation-claim-v1','UTF8')||decode('00','hex')
      ||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');
  select work.attempt_count into v_attempt
  from public.openclaw_send_work_items work
  join public.openclaw_runtime_credentials credential
    on credential.organization_id=work.organization_id and credential.account_id=work.account_id
   and credential.cell_id=work.cell_id and credential.credential_generation=work.credential_generation
   and credential.revoked_at is null
  join public.openclaw_runtime_leases lease
    on lease.organization_id=work.organization_id and lease.account_id=work.account_id
   and lease.cell_id=work.cell_id and lease.lease_generation=work.runtime_lease_generation
   and lease.fencing_token=work.fencing_token and lease.status='ACTIVE'
  where work.organization_id=v_org and work.account_id=v_account and work.id=v_work
    and work.cell_id=v_cell and work.work_kind='INBOUND_AUTOMATION' and work.state='LEASED'
    and work.claim_generation=v_claim and work.claim_token_hash=v_token
    and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
    and work.runtime_lease_generation=(p_principal->>'leaseGeneration')::bigint
    and work.fencing_token=(p_principal->>'fencingToken')::bigint
    and work.session_generation=(p_principal->>'sessionGeneration')::bigint
    and work.lease_expires_at>statement_timestamp() and lease.expires_at>statement_timestamp()
  for update of work;
  if not found then raise exception 'inbound automation completion binding CAS failed' using errcode='40001'; end if;
  insert into public.openclaw_send_work_attempts(
    organization_id,account_id,cell_id,work_item_id,claim_generation,fencing_token,
    session_generation,credential_generation,runtime_lease_generation,
    attempt_number,outcome,evidence,evidence_hash
  ) values (
    v_org,v_account,v_cell,v_work,v_claim,(p_principal->>'fencingToken')::bigint,
    (p_principal->>'sessionGeneration')::bigint,
    (p_principal->>'credentialGeneration')::bigint,(p_principal->>'leaseGeneration')::bigint,
    v_attempt,v_outcome,v_evidence,
    encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_evidence),'sha256'),'hex')
  );
  update public.openclaw_send_work_items work set
    state=case when v_outcome='RETRY' then 'QUEUED' else v_outcome end,
    claim_token_hash=null,lease_expires_at=null,
    retry_not_before=case when v_outcome='RETRY' then statement_timestamp()
      +make_interval(secs=>greatest(1,least(coalesce((p_request->>'retryAfterSeconds')::integer,5),3600))) end,
    terminal_at=case when v_outcome='RETRY' then null else statement_timestamp() end,
    updated_at=statement_timestamp()
  where work.organization_id=v_org and work.id=v_work and work.state='LEASED'
    and work.claim_generation=v_claim;
  if not found then raise exception 'inbound automation completion CAS failed' using errcode='40001'; end if;
  return jsonb_build_object('version',1,'workItemId',v_work,'outcome',v_outcome);
end;
$function$;

create or replace function app_private.openclaw_claim_work_item_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_kind text := p_principal->>'principalKind';
  v_org uuid := (p_principal->>'organizationId')::uuid;
  v_limit integer := greatest(1,least(coalesce((p_request->>'limit')::integer,10),25));
  v_seconds integer := greatest(5,least(coalesce((p_request->>'leaseSeconds')::integer,30),60));
  v_token_hash text;
  v_principal_expires timestamptz;
  v_items jsonb;
  v_requested_kinds text[];
  v_stale record;
  v_stale_evidence jsonb;
  v_recovery_items jsonb := '[]'::jsonb;
  v_recovery_count integer := 0;
  v_remaining integer;
  v_unresolved_retention integer := 0;
  v_unresolved_audit integer := 0;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','claimToken','limit','leaseSeconds','requestedKinds'],
    array['version','claimToken','limit','leaseSeconds','requestedKinds']
  );
  if p_request->>'version'<>'1' or v_kind not in ('CHANNEL','MAINTENANCE')
     or char_length(p_request->>'claimToken') not between 32 and 512
     or (p_request->>'limit')::integer not between 1 and 25
     or (p_request->>'leaseSeconds')::integer not between 5 and 60
     or jsonb_typeof(p_request->'requestedKinds')<>'array'
     or jsonb_array_length(p_request->'requestedKinds') not between 1 and 3
  then
    raise exception 'work claim version or principal kind invalid' using errcode='22023';
  end if;
  select array_agg(kind order by kind) into v_requested_kinds
  from (select distinct jsonb_array_elements_text(p_request->'requestedKinds') kind) requested;
  if cardinality(v_requested_kinds)<>jsonb_array_length(p_request->'requestedKinds')
     or (v_kind='CHANNEL' and exists (select 1 from unnest(v_requested_kinds) kind
       where kind not in ('INBOUND_AUTOMATION','SCHEDULE_OCCURRENCE','CRM_EVENT')))
     or (v_kind='MAINTENANCE' and exists (select 1 from unnest(v_requested_kinds) kind
       where kind not in ('RETENTION_DELETE','AUDIT_ANCHOR')))
  then
    raise exception 'requested work kind is outside the principal class' using errcode='42501';
  end if;
  v_token_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-work-claim-v1','UTF8')||decode('00','hex')
      ||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');
  if v_kind='CHANNEL' then
    select least(lease.expires_at,statement_timestamp()+make_interval(secs=>v_seconds))
    into v_principal_expires
    from public.openclaw_accounts account
    join public.openclaw_runtime_cells cell
      on cell.organization_id=account.organization_id and cell.account_id=account.id
     and cell.id=(p_principal->>'cellId')::uuid and cell.is_current and cell.state='READY'
    join public.openclaw_runtime_credentials credential
      on credential.organization_id=cell.organization_id and credential.account_id=cell.account_id
     and credential.cell_id=cell.id
    join public.openclaw_runtime_leases lease
      on lease.organization_id=credential.organization_id and lease.account_id=credential.account_id
     and lease.cell_id=credential.cell_id
    where account.organization_id=v_org
      and account.id=(p_principal->>'accountId')::uuid and account.is_active
      and account.session_generation=(p_principal->>'sessionGeneration')::bigint
      and credential.credential_generation=(p_principal->>'credentialGeneration')::bigint
      and credential.revoked_at is null
      and lease.lease_generation=(p_principal->>'leaseGeneration')::bigint
      and lease.fencing_token=(p_principal->>'fencingToken')::bigint
      and lease.status='ACTIVE' and lease.expires_at>statement_timestamp();
    if v_principal_expires is null then
      raise exception 'channel credential or principal lease is stale' using errcode='42501';
    end if;
    with candidates as (
      select work.id from public.openclaw_send_work_items work
      where work.organization_id=v_org
        and work.account_id=(p_principal->>'accountId')::uuid
        and work.cell_id=(p_principal->>'cellId')::uuid
        and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
        and work.runtime_lease_generation=(p_principal->>'leaseGeneration')::bigint
        and work.fencing_token=(p_principal->>'fencingToken')::bigint
        and work.session_generation=(p_principal->>'sessionGeneration')::bigint
        and work.work_kind=any(v_requested_kinds) and work.state='QUEUED'
        and work.claim_token_hash is null and work.lease_expires_at is null
        and work.terminal_at is null
        and (work.retry_not_before is null or work.retry_not_before<=statement_timestamp())
      order by work.created_at,work.id for update skip locked limit v_limit
    ), claimed as (
      update public.openclaw_send_work_items work set
        state='LEASED',claim_token_hash=v_token_hash,
        claim_generation=work.claim_generation+1,lease_expires_at=v_principal_expires,
        attempt_count=work.attempt_count+1,updated_at=statement_timestamp()
      from candidates where work.organization_id=v_org and work.id=candidates.id
      returning work.*
    ) select coalesce(jsonb_agg(jsonb_build_object(
      'version',1,
      'workItemId',id,
      'organizationId',organization_id,
      'accountId',account_id,
      'cellId',cell_id,
      'credentialGeneration',credential_generation,
      'leaseGeneration',runtime_lease_generation,
      'sourceKey',source_key,
      'claimToken',p_request->>'claimToken',
      'claimGeneration',claim_generation,
      'fencingToken',fencing_token,
      'leaseExpiresAt',lease_expires_at,
      'payload',payload
    ) order by id),'[]'::jsonb) into v_items from claimed;
  else
    select least(lease.expires_at,statement_timestamp()+make_interval(secs=>v_seconds))
    into v_principal_expires
    from public.openclaw_maintenance_principals principal
    join public.openclaw_maintenance_credentials credential
      on credential.organization_id=principal.organization_id
     and credential.maintenance_principal_id=principal.id
    join public.openclaw_maintenance_leases lease
      on lease.organization_id=credential.organization_id
     and lease.maintenance_principal_id=credential.maintenance_principal_id
    where principal.organization_id=v_org
      and principal.id=(p_principal->>'maintenancePrincipalId')::uuid
      and principal.is_current and principal.revoked_at is null
      and credential.credential_generation=(p_principal->>'credentialGeneration')::bigint
      and credential.revoked_at is null
      and lease.lease_generation=(p_principal->>'leaseGeneration')::bigint
      and lease.fencing_token=(p_principal->>'fencingToken')::bigint
      and lease.status='ACTIVE' and lease.expires_at>statement_timestamp();
    if v_principal_expires is null then
      raise exception 'maintenance credential or principal lease is stale' using errcode='42501';
    end if;
    -- Authorized Gateway operations keep their original receipt lineage but
    -- may be recovered by the current maintenance principal after a crash.
    with candidates as (
      select work.id
      from public.openclaw_maintenance_work_items work
      where work.organization_id=v_org
        and work.work_kind=any(v_requested_kinds)
        and work.state in ('DELETE_AUTHORIZED','AUDIT_VERIFY_AUTHORIZED')
        and (work.recovery_lease_expires_at is null
          or work.recovery_lease_expires_at<=statement_timestamp())
        and (work.retry_not_before is null or work.retry_not_before<=statement_timestamp())
      order by work.created_at,work.id
      for update skip locked
      limit v_limit
    ), rebound as (
      update public.openclaw_maintenance_work_items work set
        claim_token_hash=v_token_hash,
        recovery_maintenance_principal_id=(p_principal->>'maintenancePrincipalId')::uuid,
        recovery_credential_generation=(p_principal->>'credentialGeneration')::bigint,
        recovery_lease_generation=(p_principal->>'leaseGeneration')::bigint,
        recovery_fencing_token=(p_principal->>'fencingToken')::bigint,
        recovery_generation=work.recovery_generation+1,
        recovery_lease_expires_at=v_principal_expires,
        attempt_count=work.attempt_count+1,
        updated_at=statement_timestamp()
      from candidates
      where work.organization_id=v_org and work.id=candidates.id
      returning work.*
    ), recovery_rows as (
      select jsonb_build_object(
        'version',1,'recoveryKind','RETENTION_DELETE_AUTHORIZED',
        'workItemId',work.id,'organizationId',work.organization_id,
        'maintenancePrincipalId',work.recovery_maintenance_principal_id,
        'credentialGeneration',work.recovery_credential_generation,
        'leaseGeneration',work.recovery_lease_generation,
        'fencingToken',work.recovery_fencing_token,'sourceKey',work.source_key,
        'claimToken',p_request->>'claimToken','recoveryGeneration',work.recovery_generation,
        'recoveryLeaseExpiresAt',work.recovery_lease_expires_at,
        'frozenClaim',jsonb_build_object(
          'maintenancePrincipalId',ticket.maintenance_principal_id,
          'credentialGeneration',ticket.credential_generation,
          'leaseGeneration',ticket.maintenance_lease_generation,
          'fencingToken',ticket.fencing_token,'claimGeneration',ticket.claim_generation
        ),
        'payload',work.payload,'ticketId',ticket.id,'ticketHash',ticket.ticket_hash,
        'ticket',ticket.ticket_payload,'authorizationHash',ticket.authorization_hash,
        'authorization',ticket.authorization_payload,
        'authorizationExpiresAt',ticket.authorization_expires_at,
        'gatewayReceipt',ticket.receipt
      ) item,work.created_at,work.id
      from rebound work
      join public.openclaw_retention_delete_tickets ticket
        on ticket.organization_id=work.organization_id and ticket.work_item_id=work.id
       and ticket.claim_generation=work.claim_generation
      where work.state='DELETE_AUTHORIZED'
      union all
      select jsonb_build_object(
        'version',1,'recoveryKind','AUDIT_VERIFY_AUTHORIZED',
        'workItemId',work.id,'organizationId',work.organization_id,
        'maintenancePrincipalId',work.recovery_maintenance_principal_id,
        'credentialGeneration',work.recovery_credential_generation,
        'leaseGeneration',work.recovery_lease_generation,
        'fencingToken',work.recovery_fencing_token,'sourceKey',work.source_key,
        'claimToken',p_request->>'claimToken','recoveryGeneration',work.recovery_generation,
        'recoveryLeaseExpiresAt',work.recovery_lease_expires_at,
        'frozenClaim',jsonb_build_object(
          'maintenancePrincipalId',ticket.maintenance_principal_id,
          'credentialGeneration',ticket.credential_generation,
          'leaseGeneration',ticket.maintenance_lease_generation,
          'fencingToken',ticket.fencing_token,'claimGeneration',ticket.claim_generation
        ),
        'payload',work.payload,'verifyTicketId',ticket.ticket_jti,
        'verifyTicketHash',ticket.ticket_hash,'signatureHash',ticket.signature_hash,
        'verifyTicket',ticket.ticket_payload,
        'gatewayReceipt',ticket.gateway_receipt
      ) item,work.created_at,work.id
      from rebound work
      join public.openclaw_audit_gateway_tickets ticket
        on ticket.organization_id=work.organization_id and ticket.work_item_id=work.id
       and ticket.operation='ANCHOR_VERIFY' and ticket.is_authoritative
      where work.state='AUDIT_VERIFY_AUTHORIZED'
    )
    select coalesce(jsonb_agg(item order by created_at,id),'[]'::jsonb),count(*)::integer
    into v_recovery_items,v_recovery_count from recovery_rows;
    v_remaining:=greatest(0,v_limit-v_recovery_count);
    -- A hold lifecycle change invalidates a frozen QUARANTINE authorization
    -- epoch. Retire that old item with immutable evidence before claiming new
    -- work; otherwise the specialized completion would fail closed forever
    -- and the lease sweeper would keep requeueing the same poison item.
    perform app_private.openclaw_lock_retention_scope_v1(v_org);
    for v_stale in
      select work.*
      from public.openclaw_maintenance_work_items work
      left join public.openclaw_retention_hold_clocks clock
        on clock.organization_id=work.organization_id
      where work.organization_id=v_org
        and work.maintenance_principal_id=(p_principal->>'maintenancePrincipalId')::uuid
        and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
        and work.maintenance_lease_generation=(p_principal->>'leaseGeneration')::bigint
        and work.fencing_token=(p_principal->>'fencingToken')::bigint
        and work.work_kind='RETENTION_DELETE' and work.work_phase='QUARANTINE'
        and work.work_kind=any(v_requested_kinds)
        and work.state='QUEUED' and work.claim_token_hash is null
        and work.lease_expires_at is null and work.terminal_at is null
        and (work.payload->>'holdVersion')::bigint<>coalesce(clock.hold_version,0)
      order by work.created_at,work.id
      for update of work skip locked
      limit v_limit
    loop
      v_stale_evidence:=jsonb_build_object(
        'version',1,'reason','STALE_RETENTION_SCOPE','workItemId',v_stale.id,
        'frozenHoldVersion',(v_stale.payload->>'holdVersion')::bigint,
        'currentScopeVersion',coalesce((
          select clock.hold_version
          from public.openclaw_retention_hold_clocks clock
          where clock.organization_id=v_org
        ),0)
      );
      insert into public.openclaw_maintenance_work_attempts(
        organization_id,maintenance_principal_id,work_item_id,claim_generation,
        maintenance_lease_generation,fencing_token,credential_generation,
        attempt_number,outcome,evidence,evidence_hash
      ) values (
        v_stale.organization_id,v_stale.maintenance_principal_id,v_stale.id,
        v_stale.claim_generation,v_stale.maintenance_lease_generation,
        v_stale.fencing_token,v_stale.credential_generation,
        v_stale.attempt_count+1,'DEAD_LETTER',v_stale_evidence,
        encode(extensions.digest(
          app_private.openclaw_jcs_bytes_v1(v_stale_evidence),'sha256'
        ),'hex')
      ) on conflict (
        organization_id,maintenance_principal_id,work_item_id,
        claim_generation,attempt_number
      ) do nothing;
      update public.openclaw_maintenance_work_items work set
        state='DEAD_LETTER',attempt_count=work.attempt_count+1,
        terminal_at=statement_timestamp(),updated_at=statement_timestamp()
      where work.organization_id=v_stale.organization_id and work.id=v_stale.id
        and work.state='QUEUED' and work.claim_generation=v_stale.claim_generation;
    end loop;
    with candidates as (
      select work.id from public.openclaw_maintenance_work_items work
      where work.organization_id=v_org
        and work.maintenance_principal_id=(p_principal->>'maintenancePrincipalId')::uuid
        and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
        and work.maintenance_lease_generation=(p_principal->>'leaseGeneration')::bigint
        and work.fencing_token=(p_principal->>'fencingToken')::bigint
        and work.work_kind=any(v_requested_kinds)
        and work.state='QUEUED' and work.claim_token_hash is null
        and work.lease_expires_at is null and work.terminal_at is null
        and (work.retry_not_before is null or work.retry_not_before<=statement_timestamp())
      order by work.created_at,work.id for update skip locked limit v_remaining
    ), claimed as (
      update public.openclaw_maintenance_work_items work set
        state='LEASED',claim_token_hash=v_token_hash,
        claim_generation=work.claim_generation+1,lease_expires_at=v_principal_expires,
        attempt_count=work.attempt_count+1,updated_at=statement_timestamp()
      from candidates where work.organization_id=v_org and work.id=candidates.id
      returning work.*
    ) select v_recovery_items || coalesce(jsonb_agg(jsonb_build_object(
      'version',1,
      'workItemId',id,
      'organizationId',organization_id,
      'maintenancePrincipalId',maintenance_principal_id,
      'credentialGeneration',credential_generation,
      'leaseGeneration',maintenance_lease_generation,
      'sourceKey',source_key,
      'claimToken',p_request->>'claimToken',
      'claimGeneration',claim_generation,
      'fencingToken',fencing_token,
      'leaseExpiresAt',lease_expires_at,
      'payload',payload
    ) order by id),'[]'::jsonb) into v_items from claimed;
  end if;
  if v_kind='CHANNEL' then
    return jsonb_build_object('version',1,'items',v_items);
  end if;
  with latest_failure as (
    select distinct on (attempt.work_item_id)
      attempt.work_item_id,attempt.outcome
    from public.openclaw_maintenance_work_attempts attempt
    where attempt.organization_id=v_org
    order by attempt.work_item_id,attempt.created_at desc,attempt.id desc
  )
  select
    count(*) filter (where work.work_kind='RETENTION_DELETE')::integer,
    count(*) filter (where work.work_kind='AUDIT_ANCHOR')::integer
  into v_unresolved_retention,v_unresolved_audit
  from public.openclaw_maintenance_work_items work
  join latest_failure latest on latest.work_item_id=work.id
  where work.organization_id=v_org and work.state<>'COMPLETE'
    and latest.outcome in ('RETRY','FAILED','DEAD_LETTER');
  return jsonb_build_object('version',1,'items',v_items,
    'unresolvedFailures',jsonb_build_object(
      'retentionDelete',coalesce(v_unresolved_retention,0),
      'auditAnchor',coalesce(v_unresolved_audit,0)
    ));
end;
$function$;

create or replace function app_private.openclaw_complete_work_item_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal->>'organizationId')::uuid;
  v_work uuid := (p_request->>'workItemId')::uuid;
  v_claim bigint := (p_request->>'claimGeneration')::bigint;
  v_outcome text := p_request->>'outcome';
  v_token text;
  v_evidence jsonb := p_request->'evidence';
  v_evidence_hash text;
  v_now timestamptz := statement_timestamp();
  v_retry_not_before timestamptz;
  v_result jsonb;
  v_work_row public.openclaw_send_work_items%rowtype;
  v_existing public.openclaw_send_work_attempts%rowtype;
  v_internal_evidence jsonb;
  v_evidence_kind text := p_request#>>'{evidence,evidenceKind}';
  v_expected_draft_hash text;
  v_decision public.openclaw_inbound_automation_decisions%rowtype;
  v_draft_version bigint;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','workItemId','organizationId','accountId','cellId',
      'credentialGeneration','leaseGeneration','claimToken','claimGeneration',
      'fencingToken','outcome','evidence','evidenceHash','retryAfterSeconds'],
    array['version','workItemId','organizationId','accountId','cellId',
      'credentialGeneration','leaseGeneration','claimToken','claimGeneration',
      'fencingToken','outcome','evidence','evidenceHash','retryAfterSeconds']
  );
  if p_principal->>'principalKind'<>'CHANNEL'
     or p_request->>'organizationId' is distinct from p_principal->>'organizationId'
     or p_request->>'accountId' is distinct from p_principal->>'accountId'
     or p_request->>'cellId' is distinct from p_principal->>'cellId'
     or p_request->'credentialGeneration' is distinct from p_principal->'credentialGeneration'
     or p_request->'leaseGeneration' is distinct from p_principal->'leaseGeneration'
     or p_request->'fencingToken' is distinct from p_principal->'fencingToken'
  then
    raise exception 'channel work completion principal binding mismatch' using errcode='42501';
  end if;
  if p_request->>'version'<>'1'
     or v_outcome not in ('COMPLETE','RETRY','FAILED','DEAD_LETTER')
     or char_length(p_request->>'claimToken') not between 32 and 512
     or (p_request->>'evidenceHash') !~ '^[0-9a-f]{64}$'
     or (v_evidence->>'payloadHash') !~ '^[0-9a-f]{64}$'
     or (v_outcome='RETRY' and (
       jsonb_typeof(p_request->'retryAfterSeconds')<>'number'
       or (p_request->>'retryAfterSeconds')::integer not between 1 and 3600
     ))
     or (v_outcome<>'RETRY' and p_request->'retryAfterSeconds'<>'null'::jsonb)
  then
    raise exception 'work completion version or outcome invalid' using errcode='22023';
  end if;
  if v_outcome='COMPLETE' and v_evidence_kind='NO_SEND' then
    perform app_private.openclaw_assert_strict_object_v1(
      v_evidence,
      array['version','evidenceKind','reasonCode'],
      array['version','evidenceKind','reasonCode']
    );
    if v_evidence->>'version'<>'1'
       or (v_evidence->>'reasonCode')!~'^[A-Z][A-Z0-9_]{1,63}$'
    then
      raise exception 'NO_SEND evidence invalid' using errcode='22023';
    end if;
  elsif v_outcome='COMPLETE' and v_evidence_kind='HUMAN_DRAFT' then
    perform app_private.openclaw_assert_strict_object_v1(
      v_evidence,
      array['version','evidenceKind','reasonCode','classification','confidenceBasisPoints',
        'findings','draftText','draftHash'],
      array['version','evidenceKind','reasonCode','classification','confidenceBasisPoints',
        'findings','draftText','draftHash']
    );
    if v_evidence->>'version'<>'1'
       or (v_evidence->>'reasonCode')!~'^[A-Z][A-Z0-9_]{1,63}$'
       or not (
         v_evidence->'classification'='null'::jsonb
         or (jsonb_typeof(v_evidence->'classification')='string'
           and char_length(v_evidence->>'classification') between 1 and 128)
       )
       or not (
         v_evidence->'confidenceBasisPoints'='null'::jsonb
         or (jsonb_typeof(v_evidence->'confidenceBasisPoints')='number'
           and (v_evidence->>'confidenceBasisPoints')~'^[0-9]{1,5}$'
           and (v_evidence->>'confidenceBasisPoints')::integer between 0 and 10000)
       )
       or jsonb_typeof(v_evidence->'findings')<>'array'
       or jsonb_array_length(v_evidence->'findings')>7
       or exists (
         select 1 from jsonb_array_elements_text(v_evidence->'findings') finding
         where finding not in (
           'PHONE_NUMBER','EMAIL','NATIONAL_ID','BANK_ACCOUNT','CREDENTIAL',
           'URL_NOT_ALLOWED','CONTROL_CHARACTERS'
         )
       )
       or (select count(*) from jsonb_array_elements_text(v_evidence->'findings'))
          <>(select count(distinct finding)
             from jsonb_array_elements_text(v_evidence->'findings') finding)
       or char_length(v_evidence->>'draftText') not between 1 and 8000
       or (v_evidence->>'draftHash')!~'^[0-9a-f]{64}$'
    then
      raise exception 'HUMAN_DRAFT evidence invalid' using errcode='22023';
    end if;
    v_expected_draft_hash:=encode(extensions.digest(
      convert_to('ihome-openclaw-human-draft-v1','UTF8')||decode('00','hex')
        ||convert_to(v_evidence->>'draftText','UTF8'),
      'sha256'
    ),'hex');
    if v_evidence->>'draftHash' is distinct from v_expected_draft_hash then
      raise exception 'HUMAN_DRAFT hash mismatch' using errcode='22023';
    end if;
  elsif v_outcome<>'COMPLETE' and v_evidence_kind='WORK_FAILURE' then
    perform app_private.openclaw_assert_strict_object_v1(
      v_evidence,
      array['version','evidenceKind','reasonCode','failureFingerprint'],
      array['version','evidenceKind','reasonCode','failureFingerprint']
    );
    if v_evidence->>'version'<>'1'
       or (v_evidence->>'reasonCode')!~'^[A-Z][A-Z0-9_]{1,63}$'
       or (v_evidence->>'failureFingerprint')!~'^[0-9a-f]{64}$'
    then
      raise exception 'WORK_FAILURE evidence invalid' using errcode='22023';
    end if;
  else
    raise exception 'channel work completion evidence kind invalid' using errcode='22023';
  end if;
  v_evidence_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-send-work-completion-v1','UTF8')||decode('00','hex')
      ||app_private.openclaw_jcs_bytes_v1(v_evidence),'sha256'),'hex');
  if v_evidence_hash is distinct from p_request->>'evidenceHash' then
    raise exception 'send-work completion evidence hash mismatch' using errcode='22023';
  end if;
  v_token := encode(extensions.digest(convert_to('ihome-openclaw-work-claim-v1','UTF8')
    ||decode('00','hex')||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');

  select attempt.* into v_existing
  from public.openclaw_send_work_attempts attempt
  where attempt.organization_id=v_org
    and attempt.account_id=(p_principal->>'accountId')::uuid
    and attempt.cell_id=(p_principal->>'cellId')::uuid
    and attempt.work_item_id=v_work and attempt.claim_generation=v_claim
    and attempt.credential_generation=(p_principal->>'credentialGeneration')::bigint
    and attempt.runtime_lease_generation=(p_principal->>'leaseGeneration')::bigint
    and attempt.fencing_token=(p_principal->>'fencingToken')::bigint
    and attempt.session_generation=(p_principal->>'sessionGeneration')::bigint
    and attempt.outcome=v_outcome and attempt.evidence_hash=v_evidence_hash
    and attempt.evidence->>'claimTokenHash'=v_token
  order by attempt.attempt_number desc,attempt.id desc limit 1;
  if found then
    if v_existing.evidence->'clientEvidence' is distinct from v_evidence
       or jsonb_typeof(v_existing.evidence->'result')<>'object' then
      raise exception 'send-work completion replay evidence mismatch' using errcode='40001';
    end if;
    return v_existing.evidence->'result';
  end if;

  select work.* into v_work_row
  from public.openclaw_send_work_items work
  where work.organization_id=v_org and work.id=v_work and work.state='LEASED'
    and work.account_id=(p_principal->>'accountId')::uuid
    and work.cell_id=(p_principal->>'cellId')::uuid
    and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
    and work.runtime_lease_generation=(p_principal->>'leaseGeneration')::bigint
    and work.fencing_token=(p_principal->>'fencingToken')::bigint
    and work.session_generation=(p_principal->>'sessionGeneration')::bigint
    and work.claim_generation=v_claim and work.claim_token_hash=v_token
    and work.lease_expires_at>v_now
  for update;
  if not found then
    raise exception 'channel work completion binding CAS failed' using errcode='40001';
  end if;
  if v_evidence_kind='HUMAN_DRAFT' then
    if v_work_row.work_kind<>'INBOUND_AUTOMATION'
       or v_work_row.source_id is distinct from (v_work_row.payload->>'inboundEventId')::uuid
    then
      raise exception 'HUMAN_DRAFT requires inbound automation lineage' using errcode='40001';
    end if;
    select decision.* into strict v_decision
    from public.openclaw_inbound_automation_decisions decision
    where decision.organization_id=v_org
      and decision.account_id=v_work_row.account_id
      and decision.inbound_event_id=v_work_row.source_id
      and decision.frozen_inputs_hash=v_work_row.source_hash
      and decision.decision_kind='WORK_ELIGIBLE'
    for share;
    perform 1 from public.openclaw_conversations conversation
    where conversation.organization_id=v_org
      and conversation.account_id=v_work_row.account_id
      and conversation.id=(v_work_row.payload->>'conversationId')::uuid
    for update;
    if not found then
      raise exception 'HUMAN_DRAFT conversation lineage invalid' using errcode='40001';
    end if;
    select coalesce(max(draft.draft_version),0)+1 into v_draft_version
    from public.openclaw_ai_drafts draft
    where draft.organization_id=v_org
      and draft.account_id=v_work_row.account_id
      and draft.conversation_id=(v_work_row.payload->>'conversationId')::uuid;
    insert into public.openclaw_ai_drafts(
      organization_id,account_id,conversation_id,inbound_event_id,
      automation_decision_id,draft_version,prompt_input_hash,policy_version_id,
      automation_version_id,knowledge_version_ids,result_schema_version,result_payload,
      draft_text,citations,dlp_decision,dlp_evidence_hash,publication_state
    ) values (
      v_org,v_work_row.account_id,(v_work_row.payload->>'conversationId')::uuid,
      v_work_row.source_id,v_decision.id,v_draft_version,v_work_row.source_hash,
      v_decision.policy_version_id,v_decision.automation_version_id,
      v_decision.knowledge_version_ids,1,v_evidence-'draftText',
      v_evidence->>'draftText','[]'::jsonb,
      case when jsonb_array_length(v_evidence->'findings')>0 then 'BLOCK' else 'REVIEW' end,
      v_evidence_hash,'REVIEW_ONLY'
    );
  end if;

  if v_outcome='RETRY' then
    v_retry_not_before:=v_now+make_interval(secs=>(p_request->>'retryAfterSeconds')::integer);
    v_result:=jsonb_build_object(
      'version',1,'workItemId',v_work,'claimGeneration',v_claim,
      'outcome','SAFE_RETRY','canonicalEvidenceHash',v_evidence_hash,
      'completedAt',null,'retryNotBefore',v_retry_not_before
    );
  else
    v_result:=jsonb_build_object(
      'version',1,'workItemId',v_work,'claimGeneration',v_claim,
      'outcome',case when v_outcome='COMPLETE' then 'COMPLETED' else 'DEAD_LETTER' end,
      'canonicalEvidenceHash',v_evidence_hash,'completedAt',v_now,'retryNotBefore',null
    );
  end if;
  v_internal_evidence:=jsonb_build_object(
    'version',1,'claimTokenHash',v_token,'clientEvidence',v_evidence,'result',v_result
  );
  insert into public.openclaw_send_work_attempts(
    organization_id,account_id,cell_id,work_item_id,claim_generation,fencing_token,
    session_generation,credential_generation,runtime_lease_generation,
    attempt_number,outcome,evidence,evidence_hash
  ) values (
    v_org,v_work_row.account_id,v_work_row.cell_id,v_work,v_claim,v_work_row.fencing_token,
    v_work_row.session_generation,v_work_row.credential_generation,
    v_work_row.runtime_lease_generation,v_work_row.attempt_count,v_outcome,
    v_internal_evidence,v_evidence_hash
  );
  update public.openclaw_send_work_items work set
    state=case v_outcome
      when 'RETRY' then 'QUEUED' when 'COMPLETE' then 'COMPLETE'
      when 'FAILED' then 'FAILED' else 'DEAD_LETTER' end,
    claim_token_hash=null,lease_expires_at=null,retry_not_before=v_retry_not_before,
    terminal_at=case when v_outcome='RETRY' then null else v_now end,updated_at=v_now
  where work.organization_id=v_org and work.id=v_work and work.state='LEASED'
    and work.claim_generation=v_claim and work.claim_token_hash=v_token;
  if not found then raise exception 'channel work completion CAS lost' using errcode='40001'; end if;
  return v_result;
end;
$function$;

create or replace function app_private.openclaw_complete_maintenance_failure_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal->>'organizationId')::uuid;
  v_work_id uuid := (p_request->>'workItemId')::uuid;
  v_recovery boolean := p_request ? 'recoveryKind';
  v_binding bigint := case when p_request ? 'recoveryGeneration'
    then (p_request->>'recoveryGeneration')::bigint
    else (p_request->>'claimGeneration')::bigint end;
  v_outcome text := p_request->>'outcome';
  v_evidence jsonb := p_request->'evidence';
  v_evidence_hash text;
  v_token_hash text;
  v_now timestamptz := statement_timestamp();
  v_retry_not_before timestamptz;
  v_result jsonb;
  v_internal_evidence jsonb;
  v_expected_state text;
  v_work public.openclaw_maintenance_work_items%rowtype;
  v_existing public.openclaw_maintenance_work_attempts%rowtype;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    case when v_recovery then array[
      'version','workItemId','organizationId','maintenancePrincipalId',
      'credentialGeneration','leaseGeneration','fencingToken','claimToken',
      'recoveryKind','recoveryGeneration','frozenClaim','outcome','evidence',
      'evidenceHash','retryAfterSeconds'
    ] else array[
      'version','workItemId','organizationId','maintenancePrincipalId',
      'credentialGeneration','leaseGeneration','fencingToken','claimToken',
      'claimGeneration','outcome','evidence','evidenceHash','retryAfterSeconds'
    ] end,
    case when v_recovery then array[
      'version','workItemId','organizationId','maintenancePrincipalId',
      'credentialGeneration','leaseGeneration','fencingToken','claimToken',
      'recoveryKind','recoveryGeneration','frozenClaim','outcome','evidence',
      'evidenceHash','retryAfterSeconds'
    ] else array[
      'version','workItemId','organizationId','maintenancePrincipalId',
      'credentialGeneration','leaseGeneration','fencingToken','claimToken',
      'claimGeneration','outcome','evidence','evidenceHash','retryAfterSeconds'
    ] end
  );
  perform app_private.openclaw_assert_strict_object_v1(
    v_evidence,
    array['version','evidenceKind','reasonCode','failureFingerprint'],
    array['version','evidenceKind','reasonCode','failureFingerprint']
  );
  if p_request->>'version'<>'1' or (p_request->>'organizationId')::uuid<>v_org
    or p_request->>'maintenancePrincipalId'<>p_principal->>'maintenancePrincipalId'
    or (p_request->>'credentialGeneration')::bigint<>
      (p_principal->>'credentialGeneration')::bigint
    or (p_request->>'leaseGeneration')::bigint<>(p_principal->>'leaseGeneration')::bigint
    or (p_request->>'fencingToken')::bigint<>(p_principal->>'fencingToken')::bigint
    or char_length(p_request->>'claimToken') not between 32 and 512
    or v_outcome not in ('RETRY','FAILED','DEAD_LETTER')
    or v_evidence->>'version'<>'1' or v_evidence->>'evidenceKind'<>'WORK_FAILURE'
    or coalesce(v_evidence->>'reasonCode','') !~ '^[A-Z][A-Z0-9_]{1,63}$'
    or coalesce(v_evidence->>'failureFingerprint','') !~ '^[0-9a-f]{64}$'
    or (v_outcome='RETRY' and ((p_request->>'retryAfterSeconds')::integer not between 1 and 3600))
    or (v_outcome<>'RETRY' and p_request->'retryAfterSeconds' is distinct from 'null'::jsonb)
    or (v_recovery and p_request->>'recoveryKind' not in (
      'RETENTION_DELETE_AUTHORIZED','AUDIT_VERIFY_AUTHORIZED'
    ))
  then
    raise exception 'maintenance failure completion is invalid' using errcode='22023';
  end if;
  if v_recovery then
    v_expected_state:=case p_request->>'recoveryKind'
      when 'RETENTION_DELETE_AUTHORIZED' then 'DELETE_AUTHORIZED'
      else 'AUDIT_VERIFY_AUTHORIZED' end;
    perform app_private.openclaw_assert_strict_object_v1(
      p_request->'frozenClaim',
      array['maintenancePrincipalId','credentialGeneration','leaseGeneration','fencingToken',
        'claimGeneration'],
      array['maintenancePrincipalId','credentialGeneration','leaseGeneration','fencingToken',
        'claimGeneration']
    );
  end if;
  v_token_hash:=encode(extensions.digest(
    convert_to('ihome-openclaw-work-claim-v1','UTF8')||decode('00','hex')
      ||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');
  v_evidence_hash:=encode(extensions.digest(
    convert_to('ihome-openclaw-maintenance-work-failure-v1','UTF8')||decode('00','hex')
      ||app_private.openclaw_jcs_bytes_v1(v_evidence),'sha256'),'hex');
  if v_evidence_hash is distinct from p_request->>'evidenceHash' then
    raise exception 'maintenance failure evidence hash mismatch' using errcode='22023';
  end if;
  select attempt.* into v_existing
  from public.openclaw_maintenance_work_attempts attempt
  where attempt.organization_id=v_org and attempt.work_item_id=v_work_id
    and attempt.evidence->>'failureBindingKind'=
      case when v_recovery then 'RECOVERY' else 'CLAIM' end
    and (attempt.evidence->>'failureBindingGeneration')::bigint=v_binding
  order by attempt.created_at desc,attempt.id desc limit 1;
  if found then
    if v_existing.evidence_hash is distinct from v_evidence_hash
      or v_existing.evidence->>'claimTokenHash' is distinct from v_token_hash
      or v_existing.evidence->'clientEvidence' is distinct from v_evidence then
      raise exception 'maintenance failure replay mismatch' using errcode='40001';
    end if;
    return v_existing.evidence->'result';
  end if;
  select work.* into v_work
  from public.openclaw_maintenance_work_items work
  where work.organization_id=v_org and work.id=v_work_id
  for update;
  if not found then raise exception 'maintenance failure work not found' using errcode='40001'; end if;
  if v_recovery then
    if v_work.state<>v_expected_state
      or v_work.recovery_maintenance_principal_id<>
        (p_principal->>'maintenancePrincipalId')::uuid
      or v_work.recovery_credential_generation<>(p_principal->>'credentialGeneration')::bigint
      or v_work.recovery_lease_generation<>(p_principal->>'leaseGeneration')::bigint
      or v_work.recovery_fencing_token<>(p_principal->>'fencingToken')::bigint
      or v_work.recovery_generation<>v_binding or v_work.claim_token_hash<>v_token_hash
      or v_work.recovery_lease_expires_at<=v_now
      or p_request->'frozenClaim' is distinct from jsonb_build_object(
        'maintenancePrincipalId',v_work.maintenance_principal_id,
        'credentialGeneration',v_work.credential_generation,
        'leaseGeneration',v_work.maintenance_lease_generation,
        'fencingToken',v_work.fencing_token,'claimGeneration',v_work.claim_generation
      ) then
      raise exception 'maintenance recovery failure binding CAS failed' using errcode='40001';
    end if;
  elsif v_work.state<>'LEASED' or v_work.claim_generation<>v_binding
    or v_work.maintenance_principal_id<>(p_principal->>'maintenancePrincipalId')::uuid
    or v_work.credential_generation<>(p_principal->>'credentialGeneration')::bigint
    or v_work.maintenance_lease_generation<>(p_principal->>'leaseGeneration')::bigint
    or v_work.fencing_token<>(p_principal->>'fencingToken')::bigint
    or v_work.claim_token_hash<>v_token_hash or v_work.lease_expires_at<=v_now then
    raise exception 'maintenance failure claim binding CAS failed' using errcode='40001';
  end if;
  if v_outcome='RETRY' then
    v_retry_not_before:=v_now+make_interval(secs=>(p_request->>'retryAfterSeconds')::integer);
  end if;
  v_result:=jsonb_build_object('version',1,'state','FAILURE_RECORDED',
    'workItemId',v_work_id,
    case when v_recovery then 'recoveryGeneration' else 'claimGeneration' end,v_binding,
    'outcome',case when v_outcome='RETRY' then 'SAFE_RETRY' else v_outcome end,
    'canonicalEvidenceHash',v_evidence_hash,
    'completedAt',case when v_outcome='RETRY' then null else v_now end,
    'retryNotBefore',v_retry_not_before);
  v_internal_evidence:=jsonb_build_object('version',1,
    'failureBindingKind',case when v_recovery then 'RECOVERY' else 'CLAIM' end,
    'failureBindingGeneration',v_binding,'claimTokenHash',v_token_hash,
    'recoveryOwner',case when v_recovery then jsonb_build_object(
      'maintenancePrincipalId',(p_principal->>'maintenancePrincipalId')::uuid,
      'credentialGeneration',(p_principal->>'credentialGeneration')::bigint,
      'leaseGeneration',(p_principal->>'leaseGeneration')::bigint,
      'fencingToken',(p_principal->>'fencingToken')::bigint
    ) else null end,'clientEvidence',v_evidence,'result',v_result);
  insert into public.openclaw_maintenance_work_attempts(
    organization_id,maintenance_principal_id,work_item_id,claim_generation,
    maintenance_lease_generation,fencing_token,credential_generation,attempt_number,
    outcome,evidence,evidence_hash
  ) values (
    v_org,v_work.maintenance_principal_id,v_work.id,v_work.claim_generation,
    v_work.maintenance_lease_generation,v_work.fencing_token,v_work.credential_generation,
    v_work.attempt_count,v_outcome,v_internal_evidence,v_evidence_hash
  );
  update public.openclaw_maintenance_work_items work set
    state=case when v_recovery and v_outcome='RETRY' then work.state
      when v_outcome='RETRY' then 'QUEUED' else v_outcome end,
    claim_token_hash=null,lease_expires_at=null,
    recovery_lease_expires_at=case when v_recovery then v_now else work.recovery_lease_expires_at end,
    retry_not_before=v_retry_not_before,
    terminal_at=case when v_outcome='RETRY' then null else v_now end,
    updated_at=v_now
  where work.organization_id=v_org and work.id=v_work.id;
  return v_result;
end;
$function$;

create or replace function app_private.openclaw_sweep_due_sales_tasks_v1(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
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
    join public.leads lead on lead.id=task.lead_id and lead.organization_id=task.organization_id
    join public.openclaw_control_states control
      on control.organization_id=task.organization_id and control.control_key='GLOBAL_STOP'
     and control.feature_enabled and not control.global_stop
    where task.activity_type='FOLLOW_UP'
      and task.openclaw_scheduled_at_utc<=statement_timestamp()
      and task.completed_at is null and task.scheduled_at is not null
      and lead.deleted_at is null
      and exists (select 1 from public.openclaw_crm_event_subscriptions subscription
        where subscription.organization_id=task.organization_id
          and subscription.event_type='sales_task_due' and subscription.is_active)
      and not exists (select 1 from public.openclaw_crm_event_occurrences occurrence
        where occurrence.organization_id=task.organization_id
          and occurrence.event_type='sales_task_due' and occurrence.source_table='lead_activities'
          and occurrence.source_id=task.id
          and occurrence.source_version=task.openclaw_schedule_revision)
    order by task.openclaw_scheduled_at_utc,task.id
    for update of task skip locked
    limit greatest(1,least(coalesce(p_limit,100),500))
  loop
    v_snapshot := jsonb_build_object('version',1,'eventType','sales_task_due',
      'eventSubtype','FOLLOW_UP_DUE','sourceTable','lead_activities','sourceId',activity.id,
      'sourceVersion',activity.openclaw_schedule_revision,'payload',jsonb_build_object(
        'activityId',activity.id,'leadId',activity.lead_id,'organizationId',activity.organization_id,
        'activityType',activity.activity_type,'scheduledAtLocal',activity.scheduled_at,
        'scheduledAtUtc',activity.openclaw_scheduled_at_utc,
        'scheduleTimezone',activity.openclaw_schedule_timezone,
        'scheduleRevision',activity.openclaw_schedule_revision,
        'customerName',activity.customer_name,'phone',activity.phone,
        'assignedStaffId',activity.assigned_staff_id));
    if app_private.openclaw_insert_crm_occurrence_v1(
      activity.organization_id,'sales_task_due','FOLLOW_UP_DUE','lead_activities',
      activity.id,activity.openclaw_schedule_revision,v_snapshot,activity.openclaw_scheduled_at_utc
    ) then v_inserted:=v_inserted+1; end if;
  end loop;
  return v_inserted;
end;
$function$;

alter table public.openclaw_retention_holds
  drop constraint openclaw_retention_holds_target_kind_check,
  add column scope_version bigint not null default 0 check (scope_version>=0),
  add constraint openclaw_retention_holds_target_kind_check
    check (target_kind in (
      'ORGANIZATION','CONVERSATION','MESSAGE','MEDIA','AI_DRAFT',
      'KNOWLEDGE','HEALTH','QR','AUDIT','POLICY','CONTROL','DELIVERY',
      'UNKNOWN','SECURITY','CONSENT','RISK'
    ));

alter table public.openclaw_retention_tombstones
  drop constraint openclaw_retention_tombstones_subject_kind_check,
  add constraint openclaw_retention_tombstones_subject_kind_check
    check (subject_kind in (
      'MESSAGE','AI_DRAFT','MEDIA','KNOWLEDGE','HEALTH','QR','AUDIT','POLICY',
      'CONTROL','DELIVERY','UNKNOWN','SECURITY','CONSENT','RISK'
    ));

create or replace function app_private.guard_openclaw_retention_redaction_v1()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if TG_OP='DELETE' then
    raise exception 'retention-protected evidence cannot be deleted' using errcode='55000';
  end if;
  if TG_TABLE_NAME in ('openclaw_policy_versions','openclaw_knowledge_versions') then
    if OLD.lifecycle_state='DRAFT' and NEW.lifecycle_state='PUBLISHED'
       and OLD.published_at is null and NEW.published_at is not null
       and (to_jsonb(NEW)-array['lifecycle_state','published_at'])
         is not distinct from
           (to_jsonb(OLD)-array['lifecycle_state','published_at']) then
      return NEW;
    end if;
    if OLD.lifecycle_state='PUBLISHED' and NEW.lifecycle_state='ARCHIVED'
       and OLD.archived_at is null and NEW.archived_at is not null
       and (to_jsonb(NEW)-array['lifecycle_state','archived_at'])
         is not distinct from
           (to_jsonb(OLD)-array['lifecycle_state','archived_at']) then
      return NEW;
    end if;
    -- RECORDING A VALIDATION RESULT IS NOT REDACTION.
    --
    -- openclaw_validate_knowledge_v1 sets validation_result on a DRAFT and changes
    -- nothing else. Without this exemption it raised 42501 unconditionally - the
    -- RPC runs as openclaw_function_owner, not openclaw_maintenance_writer - and
    -- because openclaw_publish_knowledge_v1 hard-requires a non-null
    -- validation_result that nothing else ever writes, PUBLISH was unreachable too.
    -- The whole knowledge lifecycle was dead from the moment this trigger replaced
    -- the append-only one, and no test noticed because PGlite runs as superuser
    -- while `current_user` inside a definer body is the function OWNER, not the
    -- session role.
    --
    -- Direction matters: the redaction path below NULLS validation_result, so
    -- null -> non-null is provably the opposite operation and cannot be used to
    -- erase evidence. Everything else must be byte-identical.
    if TG_TABLE_NAME='openclaw_knowledge_versions'
       and OLD.lifecycle_state='DRAFT' and NEW.lifecycle_state='DRAFT'
       and OLD.validation_result is null and NEW.validation_result is not null
       and (to_jsonb(NEW)-'validation_result')
         is not distinct from (to_jsonb(OLD)-'validation_result') then
      return NEW;
    end if;
    -- ARCHIVING A DRAFT.
    --
    -- openclaw_archive_knowledge_v1 accepts a DRAFT as well as a PUBLISHED version,
    -- and sets published_at because an archived row must carry one. For a PUBLISHED
    -- row coalesce leaves that column alone and the exemption above matches; for a
    -- DRAFT it moves, so that exemption's byte-identical test failed and archiving a
    -- draft was impossible. Scoped to knowledge versions: no policy-version RPC
    -- performs this transition, and widening a redaction guard for a caller that
    -- does not exist is how guards stop meaning anything.
    if TG_TABLE_NAME='openclaw_knowledge_versions'
       and OLD.lifecycle_state='DRAFT' and NEW.lifecycle_state='ARCHIVED'
       and OLD.archived_at is null and NEW.archived_at is not null
       and OLD.published_at is null and NEW.published_at is not null
       and (to_jsonb(NEW)-array['lifecycle_state','archived_at','published_at'])
         is not distinct from
           (to_jsonb(OLD)-array['lifecycle_state','archived_at','published_at']) then
      return NEW;
    end if;
  end if;
  if current_user<>'openclaw_maintenance_writer' then
    raise exception 'only openclaw_maintenance_writer may perform retention redaction'
      using errcode='42501';
  end if;

  case TG_TABLE_NAME
    when 'openclaw_messages' then
      if NEW.text_content<>'[REDACTED_BY_RETENTION]'
         or (to_jsonb(NEW)-'text_content') is distinct from
            (to_jsonb(OLD)-'text_content') then
        raise exception 'invalid message retention redaction' using errcode='55000';
      end if;
    when 'openclaw_ai_drafts' then
      if NEW.draft_text<>'[REDACTED_BY_RETENTION]'
         or NEW.result_payload<>jsonb_build_object('marker','REDACTED_BY_RETENTION')
         or NEW.citations<>jsonb_build_array(jsonb_build_object('marker','REDACTED_BY_RETENTION'))
         or (to_jsonb(NEW)-array['draft_text','result_payload','citations']) is distinct from
            (to_jsonb(OLD)-array['draft_text','result_payload','citations']) then
        raise exception 'invalid AI draft retention redaction' using errcode='55000';
      end if;
    when 'openclaw_knowledge_versions' then
      if NEW.content<>'[REDACTED_BY_RETENTION]'
         or NEW.metadata<>jsonb_build_object('marker','REDACTED_BY_RETENTION')
         or NEW.validation_result is not null
         or (to_jsonb(NEW)-array['content','metadata','validation_result']) is distinct from
            (to_jsonb(OLD)-array['content','metadata','validation_result']) then
        raise exception 'invalid knowledge version retention redaction' using errcode='55000';
      end if;
    when 'openclaw_knowledge_chunks' then
      if NEW.chunk_text<>'[REDACTED_BY_RETENTION]'
         or NEW.embedding is not null
         or NEW.metadata<>jsonb_build_object('marker','REDACTED_BY_RETENTION')
         or (to_jsonb(NEW)-array['chunk_text','embedding','metadata']) is distinct from
            (to_jsonb(OLD)-array['chunk_text','embedding','metadata']) then
        raise exception 'invalid knowledge chunk retention redaction' using errcode='55000';
      end if;
    when 'openclaw_policy_versions' then
      if NEW.rate_limits<>jsonb_build_object('marker','REDACTED_BY_RETENTION')
         or NEW.policy_payload<>jsonb_build_object('marker','REDACTED_BY_RETENTION')
         or (to_jsonb(NEW)-array['rate_limits','policy_payload']) is distinct from
            (to_jsonb(OLD)-array['rate_limits','policy_payload']) then
        raise exception 'invalid policy retention redaction' using errcode='55000';
      end if;
    when 'openclaw_health_events' then
      if NEW.content_free_metrics<>jsonb_build_object('marker','REDACTED_BY_RETENTION')
         or (to_jsonb(NEW)-'content_free_metrics') is distinct from
            (to_jsonb(OLD)-'content_free_metrics') then
        raise exception 'invalid health retention redaction' using errcode='55000';
      end if;
    when 'openclaw_delivery_attempts' then
      if NEW.known_provider_message_ids is distinct from OLD.known_provider_message_ids
         or NEW.delivery_evidence<>jsonb_build_object('marker','REDACTED_BY_RETENTION')
         or (to_jsonb(NEW)-'delivery_evidence') is distinct from
            (to_jsonb(OLD)-'delivery_evidence') then
        raise exception 'invalid delivery retention redaction' using errcode='55000';
      end if;
    when 'openclaw_inbound_automation_decisions' then
      if NEW.frozen_inputs<>jsonb_build_object('marker','REDACTED_BY_RETENTION')
         or (to_jsonb(NEW)-'frozen_inputs') is distinct from
            (to_jsonb(OLD)-'frozen_inputs') then
        raise exception 'invalid risk retention redaction' using errcode='55000';
      end if;
    else
      raise exception 'deny unknown retention redaction target: %',TG_TABLE_NAME
        using errcode='55000';
  end case;
  return NEW;
end;
$function$;

drop trigger openclaw_messages_append_only on public.openclaw_messages;
create trigger openclaw_messages_retention_guard
before update or delete on public.openclaw_messages
for each row execute function app_private.guard_openclaw_retention_redaction_v1();

drop trigger openclaw_ai_drafts_append_only on public.openclaw_ai_drafts;
create trigger openclaw_ai_drafts_retention_guard
before update or delete on public.openclaw_ai_drafts
for each row execute function app_private.guard_openclaw_retention_redaction_v1();

drop trigger openclaw_knowledge_versions_append_only on public.openclaw_knowledge_versions;
create trigger openclaw_knowledge_versions_retention_guard
before update or delete on public.openclaw_knowledge_versions
for each row execute function app_private.guard_openclaw_retention_redaction_v1();

drop trigger openclaw_knowledge_chunks_append_only on public.openclaw_knowledge_chunks;
create trigger openclaw_knowledge_chunks_retention_guard
before update or delete on public.openclaw_knowledge_chunks
for each row execute function app_private.guard_openclaw_retention_redaction_v1();

drop trigger openclaw_policy_versions_append_only on public.openclaw_policy_versions;
create trigger openclaw_policy_versions_retention_guard
before update or delete on public.openclaw_policy_versions
for each row execute function app_private.guard_openclaw_retention_redaction_v1();

drop trigger openclaw_health_events_append_only on public.openclaw_health_events;
create trigger openclaw_health_events_retention_guard
before update or delete on public.openclaw_health_events
for each row execute function app_private.guard_openclaw_retention_redaction_v1();

drop trigger openclaw_delivery_attempts_append_only on public.openclaw_delivery_attempts;
create trigger openclaw_delivery_attempts_retention_guard
before update or delete on public.openclaw_delivery_attempts
for each row execute function app_private.guard_openclaw_retention_redaction_v1();

drop trigger openclaw_inbound_decisions_append_only
  on public.openclaw_inbound_automation_decisions;
create trigger openclaw_inbound_decisions_retention_guard
before update or delete on public.openclaw_inbound_automation_decisions
for each row execute function app_private.guard_openclaw_retention_redaction_v1();

create table public.openclaw_retention_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  policy_version bigint not null check (policy_version>0),
  subject_kind text not null check (subject_kind in (
    'MESSAGE','AI_DRAFT','MEDIA','KNOWLEDGE','HEALTH','QR','AUDIT','POLICY',
    'CONTROL','DELIVERY','UNKNOWN','SECURITY','CONSENT','RISK'
  )),
  retain_for_seconds bigint not null,
  is_active boolean not null default false,
  activated_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  unique (organization_id,id),
  unique (organization_id,subject_kind,policy_version),
  check ((is_active and activated_at is not null and retired_at is null) or not is_active),
  check (retain_for_seconds=case
    when subject_kind in ('MESSAGE','AI_DRAFT') then 15552000
    when subject_kind in ('MEDIA','HEALTH') then 7776000
    when subject_kind='QR' then 604800
    else 31536000
  end)
);

create unique index openclaw_retention_policies_one_active_uidx
  on public.openclaw_retention_policies(organization_id,subject_kind)
  where is_active;

create or replace function app_private.ensure_openclaw_retention_contract_v1()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_inserted integer;
begin
  with contract(subject_kind,retain_for_seconds) as (
    values
      ('MESSAGE'::text,15552000::bigint),
      ('AI_DRAFT',15552000),
      ('MEDIA',7776000),
      ('KNOWLEDGE',31536000),
      ('HEALTH',7776000),
      ('QR',604800),
      ('AUDIT',31536000),
      ('POLICY',31536000),
      ('CONTROL',31536000),
      ('DELIVERY',31536000),
      ('UNKNOWN',31536000),
      ('SECURITY',31536000),
      ('CONSENT',31536000),
      ('RISK',31536000)
  ), missing as (
    select principal.organization_id,contract.subject_kind,contract.retain_for_seconds,
      coalesce((
        select max(history.policy_version)+1
        from public.openclaw_retention_policies history
        where history.organization_id=principal.organization_id
          and history.subject_kind=contract.subject_kind
      ),1) policy_version
    from public.openclaw_maintenance_principals principal
    cross join contract
    where principal.is_current and principal.revoked_at is null
      and not exists (
        select 1 from public.openclaw_retention_policies active
        where active.organization_id=principal.organization_id
          and active.subject_kind=contract.subject_kind and active.is_active
      )
  )
  insert into public.openclaw_retention_policies(
    organization_id,policy_version,subject_kind,retain_for_seconds,
    is_active,activated_at
  )
  select missing.organization_id,missing.policy_version,missing.subject_kind,
    missing.retain_for_seconds,true,statement_timestamp()
  from missing
  on conflict do nothing;
  get diagnostics v_inserted=row_count;
  return v_inserted;
end;
$function$;

create table public.openclaw_retention_hold_clocks (
  organization_id uuid primary key references public.organizations(id) on delete restrict,
  hold_version bigint not null check (hold_version>0),
  updated_at timestamptz not null default statement_timestamp()
);

create table public.openclaw_retention_hold_scopes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  hold_id uuid not null,
  hold_version bigint not null check (hold_version>0),
  scope_kind text not null check (scope_kind in (
    'ORGANIZATION','CONVERSATION','MESSAGE','MEDIA','AI_DRAFT','KNOWLEDGE','AUDIT','DELIVERY'
  )),
  scope_id uuid,
  is_active boolean not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (organization_id,id),
  unique (organization_id,hold_id,scope_kind,scope_id),
  foreign key (organization_id,hold_id)
    references public.openclaw_retention_holds(organization_id,id) on delete restrict,
  check ((scope_kind='ORGANIZATION')=(scope_id is null))
);

create index openclaw_retention_hold_scopes_lookup_idx
  on public.openclaw_retention_hold_scopes(organization_id,scope_kind,scope_id,hold_version)
  where is_active;

create or replace function app_private.openclaw_lock_retention_scope_v1(
  p_organization_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'ihome-openclaw-retention-scope-v1:'||p_organization_id::text,0
  ));
end;
$function$;

create or replace function app_private.openclaw_lock_retention_tombstone_v1(
  p_organization_id uuid,
  p_tombstone_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform tombstone.id
  from public.openclaw_retention_tombstones tombstone
  where tombstone.organization_id=p_organization_id
    and tombstone.id=p_tombstone_id
  for update;
  if not found then
    raise exception 'retention tombstone not found' using errcode='40001';
  end if;
end;
$function$;

create or replace function app_private.openclaw_expand_retention_hold_scopes_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_version bigint;
  v_active boolean := NEW.released_at is null
    and (NEW.expires_at is null or NEW.expires_at>statement_timestamp());
begin
  perform app_private.openclaw_lock_retention_scope_v1(NEW.organization_id);
  insert into public.openclaw_retention_hold_clocks(organization_id,hold_version,updated_at)
  values(NEW.organization_id,1,statement_timestamp())
  on conflict (organization_id) do update
    set hold_version=public.openclaw_retention_hold_clocks.hold_version+1,
        updated_at=statement_timestamp()
  returning hold_version into v_version;
  NEW.scope_version := v_version;

  if TG_OP='UPDATE' then
    update public.openclaw_retention_hold_scopes scope
    set hold_version=v_version,is_active=v_active,updated_at=statement_timestamp()
    where scope.organization_id=NEW.organization_id and scope.hold_id=NEW.id;
  end if;
  return NEW;
end;
$function$;

create or replace function app_private.openclaw_persist_retention_hold_scopes_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_active boolean := NEW.released_at is null
    and (NEW.expires_at is null or NEW.expires_at>statement_timestamp());
begin
  insert into public.openclaw_retention_hold_scopes(
    organization_id,hold_id,hold_version,scope_kind,scope_id,is_active
  ) values (
    NEW.organization_id,NEW.id,NEW.scope_version,NEW.target_kind,
    case when NEW.target_kind='ORGANIZATION' then null else NEW.target_id end,v_active
  ) on conflict (organization_id,hold_id,scope_kind,scope_id) do update
    set hold_version=excluded.hold_version,is_active=excluded.is_active,
        updated_at=statement_timestamp();

  if NEW.target_kind='CONVERSATION' then
    perform message.id from public.openclaw_messages message
      where message.organization_id=NEW.organization_id and message.conversation_id=NEW.target_id
      order by message.id for share;
    insert into public.openclaw_retention_hold_scopes(
      organization_id,hold_id,hold_version,scope_kind,scope_id,is_active
    ) select NEW.organization_id,NEW.id,NEW.scope_version,'MESSAGE',message.id,v_active
      from public.openclaw_messages message
      where message.organization_id=NEW.organization_id and message.conversation_id=NEW.target_id
    on conflict (organization_id,hold_id,scope_kind,scope_id) do update
      set hold_version=excluded.hold_version,is_active=excluded.is_active,
          updated_at=statement_timestamp();
    insert into public.openclaw_retention_hold_scopes(
      organization_id,hold_id,hold_version,scope_kind,scope_id,is_active
    ) select NEW.organization_id,NEW.id,NEW.scope_version,'MEDIA',media.id,v_active
      from public.openclaw_message_media media
      where media.organization_id=NEW.organization_id and media.conversation_id=NEW.target_id
    on conflict (organization_id,hold_id,scope_kind,scope_id) do update
      set hold_version=excluded.hold_version,is_active=excluded.is_active,
          updated_at=statement_timestamp();
    insert into public.openclaw_retention_hold_scopes(
      organization_id,hold_id,hold_version,scope_kind,scope_id,is_active
    ) select NEW.organization_id,NEW.id,NEW.scope_version,'AI_DRAFT',draft.id,v_active
      from public.openclaw_ai_drafts draft
      where draft.organization_id=NEW.organization_id and draft.conversation_id=NEW.target_id
    on conflict (organization_id,hold_id,scope_kind,scope_id) do update
      set hold_version=excluded.hold_version,is_active=excluded.is_active,
          updated_at=statement_timestamp();
  elsif NEW.target_kind='MESSAGE' then
    insert into public.openclaw_retention_hold_scopes(
      organization_id,hold_id,hold_version,scope_kind,scope_id,is_active
    ) select NEW.organization_id,NEW.id,NEW.scope_version,'MEDIA',media.id,v_active
      from public.openclaw_message_media media
      where media.organization_id=NEW.organization_id and media.message_id=NEW.target_id
    on conflict (organization_id,hold_id,scope_kind,scope_id) do update
      set hold_version=excluded.hold_version,is_active=excluded.is_active,
          updated_at=statement_timestamp();
  end if;
  return null;
end;
$function$;

create trigger openclaw_retention_holds_clock
before insert or update on public.openclaw_retention_holds
for each row execute function app_private.openclaw_expand_retention_hold_scopes_v1();
create trigger openclaw_retention_holds_descendants
after insert or update on public.openclaw_retention_holds
for each row execute function app_private.openclaw_persist_retention_hold_scopes_v1();

create or replace function app_private.openclaw_retention_subject_held_v1(
  p_organization_id uuid,p_subject_kind text,p_subject_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from public.openclaw_retention_hold_scopes scope
    join public.openclaw_retention_holds hold
      on hold.organization_id=scope.organization_id and hold.id=scope.hold_id
    where scope.organization_id=p_organization_id and scope.is_active
      and hold.released_at is null
      and (hold.expires_at is null or hold.expires_at>statement_timestamp())
      and (scope.scope_kind='ORGANIZATION'
        or (scope.scope_kind=p_subject_kind and scope.scope_id=p_subject_id))
  ) or exists (
    select 1
    from public.openclaw_retention_holds hold
    where hold.organization_id=p_organization_id and hold.released_at is null
      and (hold.expires_at is null or hold.expires_at>statement_timestamp())
      and (
        (hold.target_kind='ORGANIZATION')
        or (hold.target_kind=p_subject_kind and hold.target_id=p_subject_id)
        or (hold.target_kind='CONVERSATION' and p_subject_kind='MESSAGE' and exists (
          select 1 from public.openclaw_messages message
          where message.organization_id=p_organization_id and message.id=p_subject_id
            and message.conversation_id=hold.target_id))
        or (hold.target_kind='CONVERSATION' and p_subject_kind='AI_DRAFT' and exists (
          select 1 from public.openclaw_ai_drafts draft
          where draft.organization_id=p_organization_id and draft.id=p_subject_id
            and draft.conversation_id=hold.target_id))
        or (hold.target_kind='CONVERSATION' and p_subject_kind='MEDIA' and exists (
          select 1 from public.openclaw_message_media media
          where media.organization_id=p_organization_id and media.id=p_subject_id
            and media.conversation_id=hold.target_id))
        or (hold.target_kind='MESSAGE' and p_subject_kind='MEDIA' and exists (
          select 1 from public.openclaw_message_media media
          where media.organization_id=p_organization_id and media.id=p_subject_id
            and media.message_id=hold.target_id))
        or (hold.target_kind='KNOWLEDGE' and p_subject_kind='KNOWLEDGE' and exists (
          select 1 from public.openclaw_knowledge_versions version
          where version.organization_id=p_organization_id and version.id=p_subject_id
            and version.source_id=hold.target_id))
        or (hold.target_kind='POLICY' and p_subject_kind='POLICY' and exists (
          select 1 from public.openclaw_policy_versions version
          where version.organization_id=p_organization_id and version.id=p_subject_id
            and version.policy_id=hold.target_id))
        or (hold.target_kind='POLICY' and p_subject_kind='POLICY' and exists (
          select 1 from public.openclaw_automation_versions version
          where version.organization_id=p_organization_id and version.id=p_subject_id
            and version.automation_id=hold.target_id))
      )
  );
$function$;

create table public.openclaw_retention_evidence_seals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  subject_kind text not null check (subject_kind in (
    'KNOWLEDGE','HEALTH','QR','AUDIT','POLICY','CONTROL','DELIVERY',
    'UNKNOWN','SECURITY','CONSENT','RISK'
  )),
  source_table text not null check (source_table in (
    'openclaw_knowledge_versions','openclaw_health_events','openclaw_qr_challenges',
    'openclaw_audit_events','openclaw_audit_roots','openclaw_policy_versions',
    'openclaw_automation_versions','openclaw_control_states','openclaw_delivery_attempts',
    'openclaw_unknown_resolutions','openclaw_runtime_credentials',
    'openclaw_maintenance_credentials','openclaw_consents','openclaw_suppressions',
    'openclaw_inbound_automation_decisions'
  )),
  subject_id uuid not null,
  retention_version bigint not null check (retention_version>0),
  retention_action text not null
    check (retention_action in ('REDACTED','HASH_ONLY','EXTERNAL_ANCHOR')),
  source_evidence_hash text not null check (source_evidence_hash ~ '^[0-9a-f]{64}$'),
  hold_version bigint not null check (hold_version>=0),
  due_at timestamptz not null,
  sealed_at timestamptz not null default statement_timestamp(),
  unique (organization_id,id),
  unique (organization_id,source_table,subject_id,retention_version)
);

create index openclaw_retention_evidence_seals_cursor_idx
  on public.openclaw_retention_evidence_seals
    (organization_id,subject_kind,sealed_at,subject_id);

create trigger openclaw_retention_evidence_seals_append_only
before update or delete on public.openclaw_retention_evidence_seals
for each row execute function app_private.reject_openclaw_append_only_v1();

create or replace function app_private.enforce_openclaw_evidence_retention_v1(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  candidate record;
  v_action text;
  v_hold_version bigint;
  v_inserted integer;
  v_sealed integer := 0;
begin
  for candidate in
    select due.* from (
      select policy.organization_id,policy.policy_version,'KNOWLEDGE'::text subject_kind,
        'openclaw_knowledge_versions'::text source_table,version.id subject_id,
        version.content_hash source_evidence_hash,
        version.archived_at+make_interval(secs=>policy.retain_for_seconds::integer) due_at
      from public.openclaw_retention_policies policy
      join public.openclaw_knowledge_versions version
        on version.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='KNOWLEDGE'
        and version.lifecycle_state='ARCHIVED' and version.archived_at is not null
        and version.archived_at<=statement_timestamp()
          -make_interval(secs=>policy.retain_for_seconds::integer)
        and version.content is distinct from '[REDACTED_BY_RETENTION]'
      union all
      select policy.organization_id,policy.policy_version,'HEALTH',
        'openclaw_health_events',health.id,
        encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(
          jsonb_build_object('fingerprint',health.fingerprint,'metrics',health.content_free_metrics)
        ),'sha256'),'hex'),
        health.observed_at+make_interval(secs=>policy.retain_for_seconds::integer)
      from public.openclaw_retention_policies policy
      join public.openclaw_health_events health
        on health.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='HEALTH'
        and health.observed_at<=statement_timestamp()
          -make_interval(secs=>policy.retain_for_seconds::integer)
        and health.content_free_metrics
          is distinct from jsonb_build_object('marker','REDACTED_BY_RETENTION')
      union all
      select policy.organization_id,policy.policy_version,'QR',
        'openclaw_qr_challenges',challenge.id,
        encode(extensions.digest(convert_to(
          challenge.auth_session_hash||':'||challenge.browser_nonce_hash,'UTF8'
        ),'sha256'),'hex'),
        challenge.issued_at+make_interval(secs=>policy.retain_for_seconds::integer)
      from public.openclaw_retention_policies policy
      join public.openclaw_qr_challenges challenge
        on challenge.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='QR' and challenge.material_version=0
        and challenge.issued_at<=statement_timestamp()
          -make_interval(secs=>policy.retain_for_seconds::integer)
      union all
      select policy.organization_id,policy.policy_version,'AUDIT',
        'openclaw_audit_events',event.id,event.event_hash,
        event.occurred_at+make_interval(secs=>policy.retain_for_seconds::integer)
      from public.openclaw_retention_policies policy
      join public.openclaw_audit_events event
        on event.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='AUDIT'
        and event.occurred_at<=statement_timestamp()
          -make_interval(secs=>policy.retain_for_seconds::integer)
        and exists (
          select 1 from public.openclaw_audit_roots root
          where root.organization_id=event.organization_id and root.anchored_at is not null
            and event.organization_sequence between root.first_sequence and root.last_sequence
        )
      union all
      select policy.organization_id,policy.policy_version,'AUDIT',
        'openclaw_audit_roots',root.id,root.root_hash,
        root.created_at+make_interval(secs=>policy.retain_for_seconds::integer)
      from public.openclaw_retention_policies policy
      join public.openclaw_audit_roots root
        on root.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='AUDIT' and root.anchored_at is not null
        and root.created_at<=statement_timestamp()
          -make_interval(secs=>policy.retain_for_seconds::integer)
      union all
      select policy.organization_id,policy.policy_version,'POLICY',
        'openclaw_policy_versions',version.id,version.payload_hash,
        version.archived_at+make_interval(secs=>policy.retain_for_seconds::integer)
      from public.openclaw_retention_policies policy
      join public.openclaw_policy_versions version
        on version.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='POLICY'
        and version.lifecycle_state='ARCHIVED' and version.archived_at is not null
        and version.archived_at<=statement_timestamp()
          -make_interval(secs=>policy.retain_for_seconds::integer)
        and version.policy_payload
          is distinct from jsonb_build_object('marker','REDACTED_BY_RETENTION')
      union all
      select policy.organization_id,policy.policy_version,'POLICY',
        'openclaw_automation_versions',version.id,
        coalesce(version.dry_run_hash,encode(extensions.digest(
          app_private.openclaw_jcs_bytes_v1(version.configuration),'sha256'),'hex')),
        version.archived_at+make_interval(secs=>policy.retain_for_seconds::integer)
      from public.openclaw_retention_policies policy
      join public.openclaw_automation_versions version
        on version.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='POLICY'
        and version.lifecycle_state='ARCHIVED' and version.archived_at is not null
        and version.archived_at<=statement_timestamp()
          -make_interval(secs=>policy.retain_for_seconds::integer)
      union all
      select policy.organization_id,policy.policy_version,'CONTROL',
        'openclaw_control_states',control.id,
        encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(jsonb_build_object(
          'controlVersion',control.control_version,'reason',control.reason
        )),'sha256'),'hex'),
        control.updated_at+make_interval(secs=>policy.retain_for_seconds::integer)
      from public.openclaw_retention_policies policy
      join public.openclaw_control_states control
        on control.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='CONTROL'
        and not control.feature_enabled and not control.limited_auto_reply_enabled
        and not control.proactive_enabled and not control.sales_groups_enabled
        and not control.first_contact_enabled and control.reason is not null
        and control.updated_at<=statement_timestamp()
          -make_interval(secs=>policy.retain_for_seconds::integer)
      union all
      select policy.organization_id,policy.policy_version,'DELIVERY',
        'openclaw_delivery_attempts',attempt.id,attempt.delivery_evidence_hash,
        attempt.created_at+make_interval(secs=>policy.retain_for_seconds::integer)
      from public.openclaw_retention_policies policy
      join public.openclaw_delivery_attempts attempt
        on attempt.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='DELIVERY'
        and attempt.created_at<=statement_timestamp()
          -make_interval(secs=>policy.retain_for_seconds::integer)
        and attempt.delivery_evidence
          is distinct from jsonb_build_object('marker','REDACTED_BY_RETENTION')
      union all
      select policy.organization_id,policy.policy_version,'UNKNOWN',
        'openclaw_unknown_resolutions',resolution.id,
        resolution.authoritative_evidence_hash,
        resolution.resolved_at+make_interval(secs=>policy.retain_for_seconds::integer)
      from public.openclaw_retention_policies policy
      join public.openclaw_unknown_resolutions resolution
        on resolution.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='UNKNOWN'
        and resolution.resolved_at<=statement_timestamp()
          -make_interval(secs=>policy.retain_for_seconds::integer)
      union all
      select policy.organization_id,policy.policy_version,'SECURITY',
        'openclaw_runtime_credentials',credential.id,credential.credential_hash,
        credential.revoked_at+make_interval(secs=>policy.retain_for_seconds::integer)
      from public.openclaw_retention_policies policy
      join public.openclaw_runtime_credentials credential
        on credential.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='SECURITY'
        and credential.revoked_at is not null
        and credential.revoked_at<=statement_timestamp()
          -make_interval(secs=>policy.retain_for_seconds::integer)
      union all
      select policy.organization_id,policy.policy_version,'SECURITY',
        'openclaw_maintenance_credentials',credential.id,credential.credential_hash,
        credential.revoked_at+make_interval(secs=>policy.retain_for_seconds::integer)
      from public.openclaw_retention_policies policy
      join public.openclaw_maintenance_credentials credential
        on credential.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='SECURITY'
        and credential.revoked_at is not null
        and credential.revoked_at<=statement_timestamp()
          -make_interval(secs=>policy.retain_for_seconds::integer)
      union all
      select policy.organization_id,policy.policy_version,'CONSENT',
        'openclaw_consents',consent.id,consent.evidence_hash,
        coalesce(consent.revoked_at,consent.expires_at)
          +make_interval(secs=>policy.retain_for_seconds::integer)
      from public.openclaw_retention_policies policy
      join public.openclaw_consents consent
        on consent.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='CONSENT'
        and coalesce(consent.revoked_at,consent.expires_at) is not null
        and coalesce(consent.revoked_at,consent.expires_at)<=statement_timestamp()
          -make_interval(secs=>policy.retain_for_seconds::integer)
      union all
      select policy.organization_id,policy.policy_version,'CONSENT',
        'openclaw_suppressions',suppression.id,suppression.evidence_hash,
        coalesce(suppression.released_at,suppression.expires_at)
          +make_interval(secs=>policy.retain_for_seconds::integer)
      from public.openclaw_retention_policies policy
      join public.openclaw_suppressions suppression
        on suppression.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='CONSENT'
        and coalesce(suppression.released_at,suppression.expires_at) is not null
        and coalesce(suppression.released_at,suppression.expires_at)<=statement_timestamp()
          -make_interval(secs=>policy.retain_for_seconds::integer)
      union all
      select policy.organization_id,policy.policy_version,'RISK',
        'openclaw_inbound_automation_decisions',decision.id,decision.frozen_inputs_hash,
        decision.created_at+make_interval(secs=>policy.retain_for_seconds::integer)
      from public.openclaw_retention_policies policy
      join public.openclaw_inbound_automation_decisions decision
        on decision.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='RISK'
        and decision.created_at<=statement_timestamp()
          -make_interval(secs=>policy.retain_for_seconds::integer)
        and decision.frozen_inputs
          is distinct from jsonb_build_object('marker','REDACTED_BY_RETENTION')
    ) due
    where not exists (
      select 1 from public.openclaw_retention_evidence_seals seal
      where seal.organization_id=due.organization_id
        and seal.source_table=due.source_table and seal.subject_id=due.subject_id
        and seal.retention_version=due.policy_version
    )
    order by due.due_at,due.subject_id
    limit greatest(1,least(coalesce(p_limit,100),500))
  loop
    perform app_private.openclaw_lock_retention_scope_v1(candidate.organization_id);
    if app_private.openclaw_retention_subject_held_v1(
      candidate.organization_id,candidate.subject_kind,candidate.subject_id
    ) then
      continue;
    end if;
    select coalesce(clock.hold_version,0) into v_hold_version
    from (select 1) singleton left join public.openclaw_retention_hold_clocks clock
      on clock.organization_id=candidate.organization_id;

    -- Lock the canonical source after the organization hold lock. SKIP LOCKED
    -- keeps concurrent minute runners non-blocking.
    case candidate.source_table
      when 'openclaw_knowledge_versions' then
        perform version.id from public.openclaw_knowledge_versions version
        where version.organization_id=candidate.organization_id
          and version.id=candidate.subject_id for update skip locked;
        if not found then continue; end if;
        update public.openclaw_knowledge_versions version set
          content='[REDACTED_BY_RETENTION]',
          metadata=jsonb_build_object('marker','REDACTED_BY_RETENTION'),
          validation_result=null
        where version.organization_id=candidate.organization_id
          and version.id=candidate.subject_id
          and version.content is distinct from '[REDACTED_BY_RETENTION]';
        update public.openclaw_knowledge_chunks chunk set
          chunk_text='[REDACTED_BY_RETENTION]',embedding=null,
          metadata=jsonb_build_object('marker','REDACTED_BY_RETENTION')
        where chunk.organization_id=candidate.organization_id
          and chunk.knowledge_version_id=candidate.subject_id
          and chunk.chunk_text is distinct from '[REDACTED_BY_RETENTION]';
        v_action:='REDACTED';
      when 'openclaw_health_events' then
        perform health.id from public.openclaw_health_events health
        where health.organization_id=candidate.organization_id
          and health.id=candidate.subject_id for update skip locked;
        if not found then continue; end if;
        update public.openclaw_health_events health
        set content_free_metrics=jsonb_build_object('marker','REDACTED_BY_RETENTION')
        where health.organization_id=candidate.organization_id
          and health.id=candidate.subject_id;
        v_action:='REDACTED';
      when 'openclaw_policy_versions' then
        perform version.id from public.openclaw_policy_versions version
        where version.organization_id=candidate.organization_id
          and version.id=candidate.subject_id for update skip locked;
        if not found then continue; end if;
        update public.openclaw_policy_versions version set
          rate_limits=jsonb_build_object('marker','REDACTED_BY_RETENTION'),
          policy_payload=jsonb_build_object('marker','REDACTED_BY_RETENTION')
        where version.organization_id=candidate.organization_id
          and version.id=candidate.subject_id;
        v_action:='REDACTED';
      when 'openclaw_delivery_attempts' then
        perform attempt.id from public.openclaw_delivery_attempts attempt
        where attempt.organization_id=candidate.organization_id
          and attempt.id=candidate.subject_id for update skip locked;
        if not found then continue; end if;
        update public.openclaw_delivery_attempts attempt
        set delivery_evidence=jsonb_build_object('marker','REDACTED_BY_RETENTION')
        where attempt.organization_id=candidate.organization_id
          and attempt.id=candidate.subject_id;
        v_action:='REDACTED';
      when 'openclaw_inbound_automation_decisions' then
        perform decision.id from public.openclaw_inbound_automation_decisions decision
        where decision.organization_id=candidate.organization_id
          and decision.id=candidate.subject_id for update skip locked;
        if not found then continue; end if;
        update public.openclaw_inbound_automation_decisions decision
        set frozen_inputs=jsonb_build_object('marker','REDACTED_BY_RETENTION')
        where decision.organization_id=candidate.organization_id
          and decision.id=candidate.subject_id;
        v_action:='REDACTED';
      when 'openclaw_audit_events' then
        perform event.id from public.openclaw_audit_events event
        where event.organization_id=candidate.organization_id
          and event.id=candidate.subject_id for update skip locked;
        if not found then continue; end if;
        v_action:='EXTERNAL_ANCHOR';
      when 'openclaw_audit_roots' then
        perform root.id from public.openclaw_audit_roots root
        where root.organization_id=candidate.organization_id
          and root.id=candidate.subject_id and root.anchored_at is not null
        for update skip locked;
        if not found then continue; end if;
        v_action:='EXTERNAL_ANCHOR';
      when 'openclaw_qr_challenges' then
        delete from public.openclaw_qr_challenges challenge
        where challenge.organization_id=candidate.organization_id
          and challenge.id=candidate.subject_id and challenge.material_version=0;
        if not found then continue; end if;
        v_action:='HASH_ONLY';
      when 'openclaw_automation_versions' then
        perform version.id from public.openclaw_automation_versions version
        where version.organization_id=candidate.organization_id
          and version.id=candidate.subject_id for update skip locked;
        if not found then continue; end if;
        update public.openclaw_automation_versions version set
          template_body='[REDACTED_BY_RETENTION]',
          allowed_crm_fields='{}'::text[],
          configuration=jsonb_build_object('marker','REDACTED_BY_RETENTION')
        where version.organization_id=candidate.organization_id
          and version.id=candidate.subject_id;
        v_action:='REDACTED';
      when 'openclaw_control_states' then
        perform control.id from public.openclaw_control_states control
        where control.organization_id=candidate.organization_id
          and control.id=candidate.subject_id for update skip locked;
        if not found then continue; end if;
        v_action:='HASH_ONLY';
      when 'openclaw_unknown_resolutions' then
        perform resolution.id from public.openclaw_unknown_resolutions resolution
        where resolution.organization_id=candidate.organization_id
          and resolution.id=candidate.subject_id for update skip locked;
        if not found then continue; end if;
        v_action:='HASH_ONLY';
      when 'openclaw_runtime_credentials' then
        perform credential.id from public.openclaw_runtime_credentials credential
        where credential.organization_id=candidate.organization_id
          and credential.id=candidate.subject_id and credential.revoked_at is not null
        for update skip locked;
        if not found then continue; end if;
        v_action:='HASH_ONLY';
      when 'openclaw_maintenance_credentials' then
        perform credential.id from public.openclaw_maintenance_credentials credential
        where credential.organization_id=candidate.organization_id
          and credential.id=candidate.subject_id and credential.revoked_at is not null
        for update skip locked;
        if not found then continue; end if;
        v_action:='HASH_ONLY';
      when 'openclaw_consents' then
        perform consent.id from public.openclaw_consents consent
        where consent.organization_id=candidate.organization_id
          and consent.id=candidate.subject_id for update skip locked;
        if not found then continue; end if;
        v_action:='HASH_ONLY';
      when 'openclaw_suppressions' then
        perform suppression.id from public.openclaw_suppressions suppression
        where suppression.organization_id=candidate.organization_id
          and suppression.id=candidate.subject_id for update skip locked;
        if not found then continue; end if;
        v_action:='HASH_ONLY';
      else
        raise exception 'deny unknown evidence retention source: %',candidate.source_table
          using errcode='55000';
    end case;

    insert into public.openclaw_retention_evidence_seals(
      organization_id,subject_kind,source_table,subject_id,retention_version,
      retention_action,source_evidence_hash,hold_version,due_at
    ) values (
      candidate.organization_id,candidate.subject_kind,candidate.source_table,
      candidate.subject_id,candidate.policy_version,v_action,
      candidate.source_evidence_hash,v_hold_version,candidate.due_at
    ) on conflict (organization_id,source_table,subject_id,retention_version) do nothing;
    get diagnostics v_inserted=row_count;
    v_sealed:=v_sealed+v_inserted;
  end loop;
  return v_sealed;
end;
$function$;

create table public.openclaw_retention_delete_tickets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  maintenance_principal_id uuid not null,
  work_item_id uuid not null,
  tombstone_id uuid not null,
  subject_id uuid not null,
  object_key text not null,
  ticket_jti uuid not null default gen_random_uuid(),
  delete_authorization_jti uuid not null default gen_random_uuid(),
  claim_token_hash text not null check (claim_token_hash ~ '^[0-9a-f]{64}$'),
  claim_generation bigint not null check (claim_generation>0),
  credential_generation bigint not null check (credential_generation>0),
  maintenance_lease_generation bigint not null check (maintenance_lease_generation>0),
  fencing_token bigint not null check (fencing_token>0),
  hold_version bigint not null check (hold_version>=0),
  quarantine_version bigint not null check (quarantine_version>0),
  signing_key_generation bigint not null check (signing_key_generation>0),
  receipt_signing_key_generation bigint not null check (receipt_signing_key_generation>0),
  domain_hash text not null check (domain_hash ~ '^[0-9a-f]{64}$'),
  ticket_payload jsonb not null check (jsonb_typeof(ticket_payload)='object'),
  ticket_bytes bytea not null,
  ticket_hash text not null check (ticket_hash ~ '^[0-9a-f]{64}$'),
  expected_receipt_claims jsonb not null check (jsonb_typeof(expected_receipt_claims)='object'),
  authorization_payload jsonb check (authorization_payload is null or jsonb_typeof(authorization_payload)='object'),
  authorization_bytes bytea,
  authorization_hash text check (authorization_hash is null or authorization_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'TICKET_ISSUED'
    check (state in ('TICKET_ISSUED','DELETE_AUTHORIZED','FINALIZED','REVOKED')),
  issued_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  authorized_at timestamptz,
  authorization_expires_at timestamptz,
  receipt jsonb,
  receipt_hash text check (receipt_hash is null or receipt_hash ~ '^[0-9a-f]{64}$'),
  gateway_outcome text check (gateway_outcome is null or gateway_outcome in ('DELETED','NOT_FOUND')),
  finalized_at timestamptz,
  unique (organization_id,id),
  unique (organization_id,ticket_jti),
  unique (organization_id,delete_authorization_jti),
  unique (organization_id,work_item_id,claim_generation),
  foreign key (organization_id,maintenance_principal_id,work_item_id)
    references public.openclaw_maintenance_work_items(
      organization_id,maintenance_principal_id,id
    ) on delete restrict,
  foreign key (organization_id,tombstone_id)
    references public.openclaw_retention_tombstones(organization_id,id) on delete restrict,
  check (convert_from(ticket_bytes,'UTF8')::jsonb=ticket_payload),
  check (id<>ticket_jti),
  check (ticket_hash=encode(extensions.digest(
    convert_to('ihome-openclaw-retention-delete-ticket-v1','UTF8')||decode('00','hex')
      ||ticket_bytes,'sha256'),'hex')),
  check ((authorization_payload is null)=(authorization_bytes is null)),
  check ((authorization_payload is null)=(authorization_hash is null)),
  check ((authorization_payload is null)=(authorized_at is null)),
  check ((authorization_payload is null)=(authorization_expires_at is null)),
  check (authorization_payload is null or convert_from(authorization_bytes,'UTF8')::jsonb=authorization_payload),
  check (authorization_hash is null or authorization_hash=encode(extensions.digest(
    convert_to('ihome-openclaw-retention-authorization-v1','UTF8')||decode('00','hex')
      ||authorization_bytes,'sha256'),'hex')),
  check ((state='FINALIZED')=(finalized_at is not null)),
  check ((state in ('DELETE_AUTHORIZED','FINALIZED'))=(authorization_payload is not null)),
  check (expires_at>issued_at and expires_at<=issued_at+interval '60 seconds'),
  check (authorization_expires_at is null or
    (authorization_expires_at>authorized_at and authorization_expires_at<=authorized_at+interval '5 seconds')),
  check ((receipt is null)=(receipt_hash is null)),
  check ((receipt is null)=(gateway_outcome is null))
);

create table public.openclaw_retention_delete_ticket_lineage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  logical_ticket_id uuid not null,
  maintenance_principal_id uuid not null,
  work_item_id uuid not null,
  tombstone_id uuid not null,
  subject_id uuid not null,
  object_key text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content_type text not null,
  content_length bigint not null check (content_length between 1 and 52428800),
  ticket_jti uuid not null,
  delete_authorization_jti uuid not null,
  claim_generation bigint not null check (claim_generation>0),
  credential_generation bigint not null check (credential_generation>0),
  maintenance_lease_generation bigint not null check (maintenance_lease_generation>0),
  fencing_token bigint not null check (fencing_token>0),
  authorization_claim_token_hash text not null
    check (authorization_claim_token_hash ~ '^[0-9a-f]{64}$'),
  authorization_maintenance_principal_id uuid not null,
  authorization_credential_generation bigint not null check (authorization_credential_generation>0),
  authorization_lease_generation bigint not null check (authorization_lease_generation>0),
  authorization_fencing_token bigint not null check (authorization_fencing_token>0),
  recovery_generation bigint not null check (recovery_generation>0),
  hold_version bigint not null check (hold_version>=0),
  quarantine_version bigint not null check (quarantine_version>0),
  ticket_signing_key_generation bigint not null check (ticket_signing_key_generation>0),
  receipt_signing_key_generation bigint not null check (receipt_signing_key_generation>0),
  gateway_public_key_hash text not null check (gateway_public_key_hash ~ '^[0-9a-f]{64}$'),
  domain_hash text not null check (domain_hash ~ '^[0-9a-f]{64}$'),
  ticket_payload jsonb not null check (jsonb_typeof(ticket_payload)='object'),
  ticket_bytes bytea not null,
  ticket_hash text not null check (ticket_hash ~ '^[0-9a-f]{64}$'),
  expected_receipt_claims jsonb not null check (jsonb_typeof(expected_receipt_claims)='object'),
  authorization_payload jsonb not null check (jsonb_typeof(authorization_payload)='object'),
  authorization_bytes bytea not null,
  authorization_hash text not null check (authorization_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  authorized_at timestamptz not null,
  authorization_expires_at timestamptz not null,
  replaces_ticket_jti uuid,
  replaces_delete_authorization_jti uuid,
  refresh_gateway_denial jsonb,
  refresh_gateway_denial_hash text
    check (refresh_gateway_denial_hash is null or refresh_gateway_denial_hash ~ '^[0-9a-f]{64}$'),
  receipt jsonb,
  receipt_hash text check (receipt_hash is null or receipt_hash ~ '^[0-9a-f]{64}$'),
  gateway_outcome text check (gateway_outcome is null or gateway_outcome in ('DELETED','NOT_FOUND')),
  finalized_at timestamptz,
  unique (organization_id,id),
  unique (organization_id,ticket_jti),
  unique (organization_id,delete_authorization_jti),
  foreign key (organization_id,logical_ticket_id)
    references public.openclaw_retention_delete_tickets(organization_id,id) on delete restrict,
  foreign key (organization_id,maintenance_principal_id,work_item_id)
    references public.openclaw_maintenance_work_items(
      organization_id,maintenance_principal_id,id
    ) on delete restrict,
  foreign key (organization_id,tombstone_id)
    references public.openclaw_retention_tombstones(organization_id,id) on delete restrict,
  check (convert_from(ticket_bytes,'UTF8')::jsonb=ticket_payload),
  check (ticket_hash=encode(extensions.digest(
    convert_to('ihome-openclaw-retention-delete-ticket-v1','UTF8')||decode('00','hex')
      ||ticket_bytes,'sha256'),'hex')),
  check (convert_from(authorization_bytes,'UTF8')::jsonb=authorization_payload),
  check (authorization_hash=encode(extensions.digest(
    convert_to('ihome-openclaw-retention-authorization-v1','UTF8')||decode('00','hex')
      ||authorization_bytes,'sha256'),'hex')),
  check (expires_at>issued_at and expires_at<=issued_at+interval '60 seconds'),
  check (authorization_expires_at>authorized_at
    and authorization_expires_at<=authorized_at+interval '5 seconds'),
  check ((replaces_ticket_jti is null)=(replaces_delete_authorization_jti is null)),
  check ((replaces_ticket_jti is null)=(refresh_gateway_denial is null)),
  check ((replaces_ticket_jti is null)=(refresh_gateway_denial_hash is null)),
  check (refresh_gateway_denial is null or refresh_gateway_denial=
    jsonb_build_object('status',410,'code','TICKET_EXPIRED_NO_WORK')),
  check (refresh_gateway_denial_hash is null or refresh_gateway_denial_hash=encode(
    extensions.digest(app_private.openclaw_jcs_bytes_v1(refresh_gateway_denial),'sha256'),'hex')),
  check ((receipt is null)=(receipt_hash is null)),
  check ((receipt is null)=(gateway_outcome is null)),
  check ((receipt is null)=(finalized_at is null))
);

create or replace function app_private.guard_openclaw_retention_ticket_lineage_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op='DELETE' or old.receipt is not null
     or (to_jsonb(new)-array['receipt','receipt_hash','gateway_outcome','finalized_at'])
       is distinct from
       (to_jsonb(old)-array['receipt','receipt_hash','gateway_outcome','finalized_at'])
     or new.receipt is null or new.receipt_hash is null
     or new.gateway_outcome not in ('DELETED','NOT_FOUND') or new.finalized_at is null then
    raise exception 'retention ticket lineage is immutable except one terminal receipt'
      using errcode='55000';
  end if;
  return new;
end;
$function$;

create trigger openclaw_retention_ticket_lineage_guard
before update or delete on public.openclaw_retention_delete_ticket_lineage
for each row execute function app_private.guard_openclaw_retention_ticket_lineage_v1();

create table public.openclaw_audit_gateway_tickets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  work_item_id uuid not null,
  ticket_jti uuid not null,
  operation text not null check (operation='ANCHOR_VERIFY'),
  maintenance_principal_id uuid not null,
  claim_generation bigint not null check (claim_generation>0),
  credential_generation bigint not null check (credential_generation>0),
  maintenance_lease_generation bigint not null check (maintenance_lease_generation>0),
  fencing_token bigint not null check (fencing_token>0),
  audit_root_id uuid not null,
  root_hash text not null check (root_hash ~ '^[0-9a-f]{64}$'),
  object_key text not null,
  signature_hash text not null check (signature_hash ~ '^[0-9a-f]{64}$'),
  audit_signing_key_generation bigint not null check (audit_signing_key_generation>0),
  audit_signing_public_key_hash text not null check (audit_signing_public_key_hash ~ '^[0-9a-f]{64}$'),
  gateway_key_generation bigint not null check (gateway_key_generation>0),
  receipt_signing_key_generation bigint not null check (receipt_signing_key_generation>0),
  ticket_payload jsonb not null check (jsonb_typeof(ticket_payload)='object'),
  ticket_bytes bytea not null,
  ticket_hash text not null check (ticket_hash ~ '^[0-9a-f]{64}$'),
  is_authoritative boolean not null default true,
  replaces_verify_ticket_jti uuid,
  refresh_gateway_denial jsonb,
  refresh_gateway_denial_hash text
    check (refresh_gateway_denial_hash is null or refresh_gateway_denial_hash ~ '^[0-9a-f]{64}$'),
  refresh_claim_token_hash text
    check (refresh_claim_token_hash is null or refresh_claim_token_hash ~ '^[0-9a-f]{64}$'),
  refresh_maintenance_principal_id uuid,
  refresh_credential_generation bigint check (refresh_credential_generation is null or refresh_credential_generation>0),
  refresh_lease_generation bigint check (refresh_lease_generation is null or refresh_lease_generation>0),
  refresh_fencing_token bigint check (refresh_fencing_token is null or refresh_fencing_token>0),
  refresh_recovery_generation bigint check (refresh_recovery_generation is null or refresh_recovery_generation>0),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  gateway_receipt jsonb,
  gateway_receipt_hash text check (gateway_receipt_hash is null or gateway_receipt_hash ~ '^[0-9a-f]{64}$'),
  finalized_at timestamptz,
  unique (organization_id,id),
  unique (organization_id,ticket_jti),
  foreign key (organization_id,maintenance_principal_id,work_item_id)
    references public.openclaw_maintenance_work_items(
      organization_id,maintenance_principal_id,id
    ) on delete restrict,
  foreign key (organization_id,audit_root_id)
    references public.openclaw_audit_roots(organization_id,id) on delete restrict,
  check (convert_from(ticket_bytes,'UTF8')::jsonb=ticket_payload),
  check (ticket_hash=encode(extensions.digest(
    convert_to('ihome-openclaw-media-ticket-v1','UTF8')||decode('00','hex')
      ||ticket_bytes,'sha256'),'hex')),
  check (expires_at>issued_at and expires_at<=issued_at+interval '60 seconds'),
  check ((replaces_verify_ticket_jti is null)=(refresh_gateway_denial is null)),
  check ((replaces_verify_ticket_jti is null)=(refresh_gateway_denial_hash is null)),
  check ((replaces_verify_ticket_jti is null)=(refresh_claim_token_hash is null)),
  check ((replaces_verify_ticket_jti is null)=(refresh_maintenance_principal_id is null)),
  check ((replaces_verify_ticket_jti is null)=(refresh_credential_generation is null)),
  check ((replaces_verify_ticket_jti is null)=(refresh_lease_generation is null)),
  check ((replaces_verify_ticket_jti is null)=(refresh_fencing_token is null)),
  check ((replaces_verify_ticket_jti is null)=(refresh_recovery_generation is null)),
  check (refresh_gateway_denial is null or refresh_gateway_denial=
    jsonb_build_object('status',410,'code','TICKET_EXPIRED_NO_WORK')),
  check (refresh_gateway_denial_hash is null or refresh_gateway_denial_hash=encode(
    extensions.digest(app_private.openclaw_jcs_bytes_v1(refresh_gateway_denial),'sha256'),'hex')),
  check ((gateway_receipt is null)=(gateway_receipt_hash is null)),
  check ((gateway_receipt is null)=(finalized_at is null))
);

create unique index openclaw_audit_gateway_authoritative_verify_uidx
  on public.openclaw_audit_gateway_tickets(organization_id,work_item_id)
  where is_authoritative;

create table public.openclaw_retention_gateway_configs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  signing_key_generation bigint not null check (signing_key_generation>0),
  ticket_key_generation bigint not null default 1 check (ticket_key_generation>0),
  public_key_hash text not null check (public_key_hash ~ '^[0-9a-f]{64}$'),
  is_active boolean not null default false,
  enabled_at timestamptz,
  retired_at timestamptz,
  unique (organization_id,id),
  unique (organization_id,signing_key_generation),
  unique (organization_id,ticket_key_generation),
  check ((is_active and enabled_at is not null and retired_at is null) or not is_active)
);

create unique index openclaw_retention_gateway_one_active_uidx
  on public.openclaw_retention_gateway_configs(organization_id) where is_active;

create or replace function app_private.openclaw_lock_retention_gateway_config_v1(
  p_organization_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform config.id
  from public.openclaw_retention_gateway_configs config
  where config.organization_id=p_organization_id
    and config.is_active
    and config.retired_at is null
  for update;
  if not found then
    raise exception 'active secret-free retention gateway signing generation required'
      using errcode='42501';
  end if;
end;
$function$;

create or replace function app_private.materialize_openclaw_retention_quarantine_v1(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  candidate record;
  binding record;
  v_payload jsonb;
  v_bytes bytea;
  v_hash text;
  v_inserted integer;
  v_created integer := 0;
begin
  for candidate in
    with subjects as (
      select policy.organization_id,policy.policy_version,policy.subject_kind,
        message.id subject_id,message.created_at subject_created_at
      from public.openclaw_retention_policies policy
      join public.openclaw_messages message on message.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='MESSAGE'
        and message.created_at<=statement_timestamp()-make_interval(secs=>policy.retain_for_seconds::integer)
        and message.text_content is distinct from '[REDACTED_BY_RETENTION]'
      union all
      select policy.organization_id,policy.policy_version,policy.subject_kind,
        draft.id,draft.created_at
      from public.openclaw_retention_policies policy
      join public.openclaw_ai_drafts draft on draft.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='AI_DRAFT'
        and draft.created_at<=statement_timestamp()-make_interval(secs=>policy.retain_for_seconds::integer)
        and draft.draft_text is distinct from '[REDACTED_BY_RETENTION]'
      union all
      select policy.organization_id,policy.policy_version,policy.subject_kind,
        media.id,media.created_at
      from public.openclaw_retention_policies policy
      join public.openclaw_message_media media on media.organization_id=policy.organization_id
      where policy.is_active and policy.subject_kind='MEDIA'
        and media.created_at<=statement_timestamp()-make_interval(secs=>policy.retain_for_seconds::integer)
        and media.object_key is not null and media.byte_state in ('CACHED','AVAILABLE')
    )
    select subject.*,coalesce(clock.hold_version,0) scope_version
    from subjects subject
    left join public.openclaw_retention_hold_clocks clock
      on clock.organization_id=subject.organization_id
    where not app_private.openclaw_retention_subject_held_v1(
      subject.organization_id,subject.subject_kind,subject.subject_id)
      and not exists (select 1 from public.openclaw_maintenance_work_items work
        where work.organization_id=subject.organization_id
          and work.source_key='retention:quarantine:'||subject.subject_kind||':'
            ||subject.subject_id||':'||subject.policy_version||':'
            ||coalesce(clock.hold_version,0))
    order by subject.subject_created_at,subject.subject_id
    limit greatest(1,least(coalesce(p_limit,100),500))
  loop
    select principal.id maintenance_principal_id,credential.credential_generation,
      lease.lease_generation,lease.fencing_token
    into binding
    from public.openclaw_maintenance_principals principal
    join public.openclaw_maintenance_credentials credential
      on credential.organization_id=principal.organization_id
     and credential.maintenance_principal_id=principal.id and credential.revoked_at is null
    join public.openclaw_maintenance_leases lease
      on lease.organization_id=principal.organization_id
     and lease.maintenance_principal_id=principal.id
     and lease.status='ACTIVE' and lease.expires_at>statement_timestamp()
    where principal.organization_id=candidate.organization_id
      and principal.is_current and principal.revoked_at is null
    order by lease.lease_generation desc,credential.credential_generation desc
    limit 1;
    if binding.maintenance_principal_id is null then continue; end if;
    v_payload := jsonb_build_object(
      'kind','RETENTION_DELETE','deletePhase','QUARANTINE',
      'subjectKind',candidate.subject_kind,'subjectId',candidate.subject_id,
      'retentionVersion',candidate.policy_version,'holdVersion',candidate.scope_version
    );
    v_bytes := app_private.openclaw_jcs_bytes_v1(v_payload);
    v_hash := encode(extensions.digest(v_bytes,'sha256'),'hex');
    insert into public.openclaw_maintenance_work_items(
      organization_id,maintenance_principal_id,work_kind,work_phase,source_id,
      source_version,source_key,source_hash,payload,payload_hash,state,claim_generation,
      maintenance_lease_generation,fencing_token,credential_generation
    ) values (
      candidate.organization_id,binding.maintenance_principal_id,'RETENTION_DELETE','QUARANTINE',
      candidate.subject_id,candidate.policy_version||':'||candidate.scope_version,
      'retention:quarantine:'||candidate.subject_kind||':'||candidate.subject_id||':'
        ||candidate.policy_version||':'||candidate.scope_version,
      v_hash,v_payload,v_hash,'QUEUED',1,binding.lease_generation,
      binding.fencing_token,binding.credential_generation
    ) on conflict do nothing;
    get diagnostics v_inserted=row_count;
    v_created:=v_created+v_inserted;
  end loop;
  return v_created;
end;
$function$;

create or replace function app_private.openclaw_complete_retention_quarantine_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal->>'organizationId')::uuid;
  v_maintenance uuid := (p_principal->>'maintenancePrincipalId')::uuid;
  v_work public.openclaw_maintenance_work_items%rowtype;
  v_subject_kind text;
  v_subject uuid;
  v_scope_version bigint;
  v_current_scope bigint;
  v_token text;
  v_object_key text;
  v_quarantined timestamptz := statement_timestamp();
  v_tombstone uuid;
  v_evidence jsonb;
begin
  if p_request->>'version'<>'1' then
    raise exception 'retention quarantine version mismatch' using errcode='22023';
  end if;
  perform app_private.openclaw_lock_retention_scope_v1(v_org);
  v_token := encode(extensions.digest(convert_to('ihome-openclaw-work-claim-v1','UTF8')
    ||decode('00','hex')||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');
  select work.* into v_work from public.openclaw_maintenance_work_items work
  join public.openclaw_maintenance_credentials credential
    on credential.organization_id=work.organization_id
   and credential.maintenance_principal_id=work.maintenance_principal_id
   and credential.credential_generation=work.credential_generation and credential.revoked_at is null
  join public.openclaw_maintenance_leases lease
    on lease.organization_id=work.organization_id
   and lease.maintenance_principal_id=work.maintenance_principal_id
   and lease.lease_generation=work.maintenance_lease_generation
   and lease.fencing_token=work.fencing_token and lease.status='ACTIVE'
  where work.organization_id=v_org and work.maintenance_principal_id=v_maintenance
    and work.id=(p_request->>'workItemId')::uuid and work.work_kind='RETENTION_DELETE'
    and work.work_phase='QUARANTINE' and work.state='LEASED'
    and work.claim_generation=(p_request->>'claimGeneration')::bigint
    and work.claim_token_hash=v_token
    and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
    and work.maintenance_lease_generation=(p_principal->>'leaseGeneration')::bigint
    and work.fencing_token=(p_principal->>'fencingToken')::bigint
    and work.lease_expires_at>v_quarantined and lease.expires_at>v_quarantined
  for update of work;
  if not found then raise exception 'retention quarantine binding CAS failed' using errcode='40001'; end if;
  v_subject_kind := v_work.payload->>'subjectKind';
  v_subject := (v_work.payload->>'subjectId')::uuid;
  v_scope_version := (v_work.payload->>'holdVersion')::bigint;
  if (p_request ? 'subjectKind' and p_request->>'subjectKind'<>v_subject_kind)
     or (p_request ? 'subjectId' and (p_request->>'subjectId')::uuid<>v_subject) then
    raise exception 'retention subject must be derived from frozen work' using errcode='22023';
  end if;
  select coalesce(clock.hold_version,0) into v_current_scope
  from (select 1) singleton
  left join public.openclaw_retention_hold_clocks clock
    on clock.organization_id=v_org;
  perform scope.id from public.openclaw_retention_hold_scopes scope
  where scope.organization_id=v_org
    and (scope.scope_kind='ORGANIZATION'
      or (scope.scope_kind=v_subject_kind and scope.scope_id=v_subject))
  order by scope.scope_kind,scope.scope_id,scope.id for share;
  if v_current_scope<>v_scope_version
     or app_private.openclaw_retention_subject_held_v1(v_org,v_subject_kind,v_subject) then
    raise exception 'hold_version or descendant legal hold changed' using errcode='40001';
  end if;

  if v_subject_kind='MESSAGE' then
    update public.openclaw_messages message set text_content='[REDACTED_BY_RETENTION]'
    where message.organization_id=v_org and message.id=v_subject
      and message.text_content is distinct from '[REDACTED_BY_RETENTION]';
    if not found then raise exception 'message retention redaction CAS failed' using errcode='40001'; end if;
  elsif v_subject_kind='AI_DRAFT' then
    update public.openclaw_ai_drafts draft set
      draft_text='[REDACTED_BY_RETENTION]',
      result_payload=jsonb_build_object('marker','REDACTED_BY_RETENTION'),
      citations=jsonb_build_array(jsonb_build_object('marker','REDACTED_BY_RETENTION'))
    where draft.organization_id=v_org and draft.id=v_subject
      and draft.draft_text is distinct from '[REDACTED_BY_RETENTION]';
    if not found then raise exception 'AI draft retention redaction CAS failed' using errcode='40001'; end if;
  elsif v_subject_kind='MEDIA' then
    select media.object_key into v_object_key from public.openclaw_message_media media
    where media.organization_id=v_org and media.id=v_subject
      and media.object_key is not null and media.byte_state in ('CACHED','AVAILABLE') for update;
    if not found then raise exception 'media retention quarantine CAS failed' using errcode='40001'; end if;
    update public.openclaw_message_media media set object_key=null,byte_state='QUARANTINED',
      retention_delete_not_before=v_quarantined+interval '7 days',updated_at=v_quarantined
    where media.organization_id=v_org and media.id=v_subject and media.object_key=v_object_key;
  else
    raise exception 'unsupported frozen retention subject' using errcode='22023';
  end if;
  v_evidence := jsonb_build_object('version',1,'marker','REDACTED_BY_RETENTION',
    'workItemId',v_work.id,'subjectKind',v_subject_kind,'subjectId',v_subject,
    'retentionVersion',(v_work.payload->>'retentionVersion')::bigint,
    'holdVersion',v_current_scope,'quarantinedAt',v_quarantined);
  insert into public.openclaw_retention_tombstones(
    organization_id,maintenance_principal_id,work_item_id,subject_kind,subject_id,
    retention_version,hold_version,quarantine_version,object_key,
    redaction_evidence_hash,quarantined_at,final_delete_not_before
  ) values (
    v_org,v_maintenance,v_work.id,v_subject_kind,v_subject,
    (v_work.payload->>'retentionVersion')::bigint,v_current_scope,1,v_object_key,
    encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_evidence),'sha256'),'hex'),
    v_quarantined,case when v_subject_kind='MEDIA' then v_quarantined+interval '7 days' end
  ) returning id into v_tombstone;
  update public.openclaw_maintenance_work_items work set state='COMPLETE',
    claim_token_hash=null,lease_expires_at=null,terminal_at=v_quarantined,updated_at=v_quarantined
  where work.organization_id=v_org and work.id=v_work.id and work.state='LEASED'
    and work.claim_generation=v_work.claim_generation;
  return jsonb_build_object('version',1,'tombstoneId',v_tombstone,
    'subjectKind',v_subject_kind,'subjectId',v_subject,
    'finalDeleteNotBefore',case when v_subject_kind='MEDIA'
      then v_quarantined+interval '7 days' end);
end;
$function$;

create or replace function app_private.materialize_openclaw_retention_final_delete_v1(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tombstone record;
  binding record;
  v_payload jsonb;
  v_bytes bytea;
  v_hash text;
  v_inserted integer;
  v_created integer := 0;
begin
  for v_tombstone in
    select candidate.* from public.openclaw_retention_tombstones candidate
    where candidate.subject_kind='MEDIA'
      and candidate.final_delete_not_before<=statement_timestamp()
      and candidate.object_key is not null
      and not app_private.openclaw_retention_subject_held_v1(
        candidate.organization_id,'MEDIA',candidate.subject_id)
      and not exists (select 1 from public.openclaw_retention_delete_tickets ticket
        where ticket.organization_id=candidate.organization_id
          and ticket.tombstone_id=candidate.id)
      and not exists (select 1 from public.openclaw_maintenance_work_items work
        where work.organization_id=candidate.organization_id
          and work.source_key='retention:final:'||candidate.id||':'||candidate.quarantine_version)
    order by candidate.final_delete_not_before,candidate.id
    for update of candidate skip locked
    limit greatest(1,least(coalesce(p_limit,100),500))
  loop
    select principal.id maintenance_principal_id,credential.credential_generation,
      lease.lease_generation,lease.fencing_token
    into binding
    from public.openclaw_maintenance_principals principal
    join public.openclaw_maintenance_credentials credential
      on credential.organization_id=principal.organization_id
     and credential.maintenance_principal_id=principal.id and credential.revoked_at is null
    join public.openclaw_maintenance_leases lease
      on lease.organization_id=principal.organization_id
     and lease.maintenance_principal_id=principal.id
     and lease.status='ACTIVE' and lease.expires_at>statement_timestamp()
    where principal.organization_id=v_tombstone.organization_id
      and principal.is_current and principal.revoked_at is null
    order by lease.lease_generation desc,credential.credential_generation desc limit 1;
    if binding.maintenance_principal_id is null then continue; end if;
    v_payload := jsonb_build_object(
      'kind','RETENTION_DELETE','deletePhase','FINAL_DELETE','subjectKind','MEDIA',
      'subjectId',v_tombstone.subject_id,'objectKey',v_tombstone.object_key,
      'retentionVersion',v_tombstone.retention_version,
      'holdVersion',coalesce((select clock.hold_version
        from public.openclaw_retention_hold_clocks clock
        where clock.organization_id=v_tombstone.organization_id),0),
      'quarantineVersion',v_tombstone.quarantine_version,
      'finalDeleteNotBefore',v_tombstone.final_delete_not_before
    );
    v_bytes := app_private.openclaw_jcs_bytes_v1(v_payload);
    v_hash := encode(extensions.digest(v_bytes,'sha256'),'hex');
    insert into public.openclaw_maintenance_work_items(
      organization_id,maintenance_principal_id,work_kind,work_phase,source_id,
      source_version,source_key,source_hash,payload,payload_hash,state,claim_generation,
      maintenance_lease_generation,fencing_token,credential_generation
    ) values (
      v_tombstone.organization_id,binding.maintenance_principal_id,'RETENTION_DELETE','FINAL_DELETE',
      v_tombstone.id,v_tombstone.quarantine_version::text,
      'retention:final:'||v_tombstone.id||':'||v_tombstone.quarantine_version,
      v_hash,v_payload,v_hash,'QUEUED',1,binding.lease_generation,
      binding.fencing_token,binding.credential_generation
    ) on conflict (organization_id,source_key) where source_key is not null do nothing;
    get diagnostics v_inserted=row_count;
    v_created:=v_created+v_inserted;
  end loop;
  return v_created;
end;
$function$;

alter table public.openclaw_message_media
  add column media_upload_receipt jsonb,
  add column media_upload_receipt_hash text,
  add column media_upload_receipt_id uuid,
  add column media_upload_ticket_jti uuid,
  add column media_upload_object_version_or_etag text,
  add column media_upload_finalized_at timestamptz,
  add constraint openclaw_message_media_upload_receipt_pair_check
    check ((media_upload_receipt is null) = (media_upload_receipt_hash is null)),
  add constraint openclaw_message_media_upload_receipt_hash_check
    check (media_upload_receipt_hash is null or media_upload_receipt_hash ~ '^[0-9a-f]{64}$'),
  add constraint openclaw_message_media_upload_receipt_id_pair_check
    check ((media_upload_receipt is null) = (media_upload_receipt_id is null)),
  add constraint openclaw_message_media_upload_ticket_pair_check
    check ((media_upload_receipt is null) = (media_upload_ticket_jti is null)),
  add constraint openclaw_message_media_upload_object_version_pair_check
    check ((media_upload_receipt is null) = (media_upload_object_version_or_etag is null)),
  add constraint openclaw_message_media_upload_finalized_pair_check
    check ((media_upload_receipt is null) = (media_upload_finalized_at is null)),
  add constraint openclaw_message_media_upload_available_check
    check (media_upload_receipt is null or byte_state = 'AVAILABLE');

create unique index openclaw_message_media_upload_receipt_id_uidx
  on public.openclaw_message_media(organization_id, media_upload_receipt_id)
  where media_upload_receipt_id is not null;
create unique index openclaw_message_media_upload_ticket_jti_uidx
  on public.openclaw_message_media(organization_id, media_upload_ticket_jti)
  where media_upload_ticket_jti is not null;

create table public.openclaw_media_upload_tickets (
  organization_id uuid not null,
  ticket_jti uuid not null,
  media_id uuid not null,
  account_id uuid not null,
  cell_id uuid not null,
  object_key text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content_type text not null,
  content_length bigint not null check (content_length between 1 and 52428800),
  credential_generation bigint not null check (credential_generation >= 1),
  lease_generation bigint not null check (lease_generation >= 1),
  fencing_token bigint not null check (fencing_token >= 1),
  session_generation bigint not null check (session_generation >= 1),
  gateway_key_generation bigint not null check (gateway_key_generation >= 1),
  receipt_signing_key_generation bigint not null check (receipt_signing_key_generation >= 1),
  issued_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > issued_at and expires_at <= issued_at + interval '60 seconds'),
  finalized_at timestamptz,
  primary key (organization_id, ticket_jti),
  unique (organization_id, ticket_jti, media_id),
  foreign key (organization_id, account_id, media_id)
    references public.openclaw_message_media(organization_id, account_id, id) on delete restrict
);

alter table public.openclaw_media_upload_tickets owner to openclaw_function_owner;
alter table public.openclaw_media_upload_tickets enable row level security;
alter table public.openclaw_media_upload_tickets force row level security;
revoke all on public.openclaw_media_upload_tickets from public, anon, authenticated, service_role;
create policy openclaw_media_upload_tickets_function_owner_all
  on public.openclaw_media_upload_tickets for all to openclaw_function_owner
  using (true) with check (true);
grant select,insert,update on public.openclaw_media_upload_tickets to openclaw_function_owner;

create or replace function app_private.openclaw_issue_media_ticket_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal->>'organizationId')::uuid;
  v_kind text := p_principal->>'principalKind';
  v_media public.openclaw_message_media%rowtype;
  v_work public.openclaw_maintenance_work_items%rowtype;
  v_root public.openclaw_audit_roots%rowtype;
  v_token text;
  v_jti uuid := gen_random_uuid();
  v_issued timestamptz := date_trunc('second',statement_timestamp());
  v_expires timestamptz;
  v_ticket_generation bigint;
  v_receipt_generation bigint;
  v_audit_key_hash text;
  v_existing record;
  v_old_ticket public.openclaw_audit_gateway_tickets%rowtype;
  v_refresh boolean := p_request->>'recoveryKind'='AUDIT_VERIFY_AUTHORIZED';
  v_refresh_denial_hash text;
  v_payload jsonb;
  v_bytes bytea;
  v_hash text;
begin
  if v_kind='CHANNEL' then
    perform app_private.openclaw_assert_strict_object_v1(
      p_request,
      array['version','mediaId','operation','verifiedSha256','contentType','contentLength'],
      array['version','mediaId','operation','verifiedSha256','contentType','contentLength']
    );
    if p_request->>'version'<>'1' or p_request->>'operation'<>'PUT'
       or coalesce(p_request->>'verifiedSha256','') !~ '^[0-9a-f]{64}$'
       or char_length(coalesce(p_request->>'contentType','')) not between 1 and 255
       or coalesce(p_request->>'contentLength','') !~ '^[1-9][0-9]*$'
       or (p_request->>'contentLength')::bigint>52428800 then
      raise exception 'channel media ticket request invalid' using errcode='22023';
    end if;
    select media.* into v_media from public.openclaw_message_media media
    where media.organization_id=v_org
      and media.account_id=(p_principal->>'accountId')::uuid
      and media.id=(p_request->>'mediaId')::uuid
      and media.object_key is not null and media.byte_state='PENDING'
    for update;
    if not found then raise exception 'channel media upload binding not available' using errcode='42501'; end if;
    if (v_media.sha256 is not null and v_media.sha256 is distinct from p_request->>'verifiedSha256')
       or (v_media.mime is not null and v_media.mime is distinct from p_request->>'contentType')
       or (v_media.byte_length is not null
         and v_media.byte_length is distinct from (p_request->>'contentLength')::bigint) then
      raise exception 'channel media verified-byte metadata replay mismatch' using errcode='40001';
    end if;
    update public.openclaw_message_media media set
      sha256=coalesce(media.sha256,p_request->>'verifiedSha256'),
      mime=coalesce(media.mime,p_request->>'contentType'),
      byte_length=coalesce(media.byte_length,(p_request->>'contentLength')::bigint),
      updated_at=statement_timestamp()
    where media.organization_id=v_org
      and media.account_id=(p_principal->>'accountId')::uuid
      and media.id=(p_request->>'mediaId')::uuid and media.byte_state='PENDING'
      and (media.sha256 is null or media.sha256=p_request->>'verifiedSha256')
      and (media.mime is null or media.mime=p_request->>'contentType')
      and (media.byte_length is null or media.byte_length=(p_request->>'contentLength')::bigint)
    returning media.* into v_media;
    if not found then raise exception 'channel media verified-byte metadata CAS failed' using errcode='40001'; end if;
  elsif v_kind='MAINTENANCE' then
    if v_refresh then
      perform app_private.openclaw_assert_strict_object_v1(
        p_request,
        array['version','operation','recoveryKind','workItemId','recoveryGeneration',
          'claimToken','expiredVerifyTicketJti','gatewayDenial','auditRootId','rootHash',
          'anchorKey','signatureHash','auditSigningKeyGeneration',
          'auditSigningPublicKeyHash','documentSha256','documentByteLength'],
        array['version','operation','recoveryKind','workItemId','recoveryGeneration',
          'claimToken','expiredVerifyTicketJti','gatewayDenial','auditRootId','rootHash',
          'anchorKey','signatureHash','auditSigningKeyGeneration',
          'auditSigningPublicKeyHash','documentSha256','documentByteLength']
      );
      perform app_private.openclaw_assert_strict_object_v1(
        p_request->'gatewayDenial',array['status','code'],array['status','code']
      );
    else
      perform app_private.openclaw_assert_strict_object_v1(
        p_request,
        array['version','operation','workItemId','claimGeneration','claimToken','auditRootId',
          'rootHash','anchorKey','signatureHash','auditSigningKeyGeneration',
          'auditSigningPublicKeyHash','documentSha256','documentByteLength'],
        array['version','operation','workItemId','claimGeneration','claimToken','auditRootId',
          'rootHash','anchorKey','signatureHash','auditSigningKeyGeneration',
          'auditSigningPublicKeyHash','documentSha256','documentByteLength']
      );
    end if;
    if p_request->>'version'<>'1' or p_request->>'operation' not in ('ANCHOR','ANCHOR_VERIFY')
      or coalesce(p_request->>'documentSha256','') !~ '^[0-9a-f]{64}$'
      or coalesce(p_request->>'signatureHash','') !~ '^[0-9a-f]{64}$'
      or coalesce(p_request->>'auditSigningPublicKeyHash','') !~ '^[0-9a-f]{64}$'
      or (p_request->>'documentByteLength')::bigint not between 1 and 52428800
      or (v_refresh and (p_request->>'operation'<>'ANCHOR_VERIFY'
        or p_request->>'recoveryKind'<>'AUDIT_VERIFY_AUTHORIZED'
        or p_request->>'expiredVerifyTicketJti' !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or p_request->'gatewayDenial' is distinct from
          jsonb_build_object('status',410,'code','TICKET_EXPIRED_NO_WORK'))) then
      raise exception 'maintenance audit ticket request invalid' using errcode='22023';
    end if;
    v_token:=encode(extensions.digest(convert_to('ihome-openclaw-work-claim-v1','UTF8')
      ||decode('00','hex')||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');
    if v_refresh then
      v_refresh_denial_hash:=encode(extensions.digest(
        app_private.openclaw_jcs_bytes_v1(p_request->'gatewayDenial'),'sha256'),'hex');
      select ticket.* into v_existing
      from public.openclaw_audit_gateway_tickets ticket
      where ticket.organization_id=v_org
        and ticket.work_item_id=(p_request->>'workItemId')::uuid
        and ticket.replaces_verify_ticket_jti=(p_request->>'expiredVerifyTicketJti')::uuid
        and ticket.refresh_gateway_denial=p_request->'gatewayDenial'
        and ticket.refresh_gateway_denial_hash=v_refresh_denial_hash
        and ticket.refresh_claim_token_hash=v_token
        and ticket.refresh_maintenance_principal_id=(p_principal->>'maintenancePrincipalId')::uuid
        and ticket.refresh_credential_generation=(p_principal->>'credentialGeneration')::bigint
        and ticket.refresh_lease_generation=(p_principal->>'leaseGeneration')::bigint
        and ticket.refresh_fencing_token=(p_principal->>'fencingToken')::bigint
        and ticket.refresh_recovery_generation=(p_request->>'recoveryGeneration')::bigint
      for update;
      if found then
        if v_existing.audit_root_id<>(p_request->>'auditRootId')::uuid
          or v_existing.root_hash is distinct from p_request->>'rootHash'
          or v_existing.object_key is distinct from p_request->>'anchorKey'
          or v_existing.signature_hash is distinct from p_request->>'signatureHash'
          or v_existing.audit_signing_key_generation<>
            (p_request->>'auditSigningKeyGeneration')::bigint
          or v_existing.audit_signing_public_key_hash is distinct from
            p_request->>'auditSigningPublicKeyHash'
          or v_existing.ticket_payload->>'sha256' is distinct from p_request->>'documentSha256'
          or (v_existing.ticket_payload->>'contentLength')::bigint<>
            (p_request->>'documentByteLength')::bigint then
          raise exception 'audit recovery refresh replay mismatch' using errcode='40001';
        end if;
        return jsonb_build_object('version',1,'ticketId',v_existing.ticket_jti,
          'ticketHash',v_existing.ticket_hash,'expiresAt',v_existing.expires_at,
          'state','RECOVERY_REFRESHED','replacesVerifyTicketJti',
          v_existing.replaces_verify_ticket_jti,'ticket',v_existing.ticket_payload);
      end if;
      select work.* into v_work from public.openclaw_maintenance_work_items work
      join public.openclaw_maintenance_credentials credential
        on credential.organization_id=work.organization_id
       and credential.maintenance_principal_id=work.recovery_maintenance_principal_id
       and credential.credential_generation=work.recovery_credential_generation
       and credential.revoked_at is null
      join public.openclaw_maintenance_leases lease
        on lease.organization_id=work.organization_id
       and lease.maintenance_principal_id=work.recovery_maintenance_principal_id
       and lease.lease_generation=work.recovery_lease_generation
       and lease.fencing_token=work.recovery_fencing_token
       and lease.status='ACTIVE' and lease.expires_at>v_issued
      where work.organization_id=v_org and work.id=(p_request->>'workItemId')::uuid
        and work.work_kind='AUDIT_ANCHOR' and work.work_phase='ANCHOR'
        and work.state='AUDIT_VERIFY_AUTHORIZED'
        and work.recovery_maintenance_principal_id=(p_principal->>'maintenancePrincipalId')::uuid
        and work.recovery_credential_generation=(p_principal->>'credentialGeneration')::bigint
        and work.recovery_lease_generation=(p_principal->>'leaseGeneration')::bigint
        and work.recovery_fencing_token=(p_principal->>'fencingToken')::bigint
        and work.recovery_generation=(p_request->>'recoveryGeneration')::bigint
        and work.claim_token_hash=v_token and work.recovery_lease_expires_at>v_issued
      for update of work;
      if not found then raise exception 'audit recovery refresh ownership CAS failed'
        using errcode='40001'; end if;
      select ticket.* into v_old_ticket
      from public.openclaw_audit_gateway_tickets ticket
      where ticket.organization_id=v_org and ticket.work_item_id=v_work.id
        and ticket.ticket_jti=(p_request->>'expiredVerifyTicketJti')::uuid
        and ticket.operation='ANCHOR_VERIFY' and ticket.is_authoritative
      for update;
      if not found or v_old_ticket.expires_at>v_issued then
        raise exception 'audit recovery refresh requires expired authoritative ticket'
          using errcode='40001';
      end if;
      select root.* into v_root from public.openclaw_audit_roots root
      where root.organization_id=v_org and root.id=v_old_ticket.audit_root_id
        and root.id=(p_request->>'auditRootId')::uuid
        and root.root_hash=p_request->>'rootHash'
        and root.r2_anchor_key=p_request->>'anchorKey'
        and root.signing_key_generation=(p_request->>'auditSigningKeyGeneration')::bigint
        and root.anchored_at is null for update;
      if not found or v_old_ticket.signature_hash is distinct from p_request->>'signatureHash'
        or v_old_ticket.audit_signing_public_key_hash is distinct from
          p_request->>'auditSigningPublicKeyHash'
        or v_old_ticket.ticket_payload->>'sha256' is distinct from p_request->>'documentSha256'
        or (v_old_ticket.ticket_payload->>'contentLength')::bigint<>
          (p_request->>'documentByteLength')::bigint then
        raise exception 'audit recovery refresh frozen lineage mismatch' using errcode='40001';
      end if;
      perform app_private.openclaw_lock_retention_gateway_config_v1(v_org);
      select config.ticket_key_generation,config.signing_key_generation
        into v_ticket_generation,v_receipt_generation
      from public.openclaw_retention_gateway_configs config
      where config.organization_id=v_org and config.is_active and config.retired_at is null;
      if not found then raise exception 'active ticket signing generation required'
        using errcode='42501'; end if;
      v_expires:=least(v_issued+interval '60 seconds',v_work.recovery_lease_expires_at);
      if v_expires<=v_issued then raise exception 'audit recovery refresh lease expired'
        using errcode='40001'; end if;
      v_payload:=jsonb_build_object('version',1,'aud','openclaw-media-gateway',
        'operation','ANCHOR_VERIFY','subject','MAINTENANCE','jti',v_jti,
        'organizationId',v_org,'accountId',null,'objectKey',v_old_ticket.object_key,
        'sha256',p_request->>'documentSha256','contentType','application/json',
        'contentLength',(p_request->>'documentByteLength')::bigint,'sessionGeneration',0,
        'gatewayKeyGeneration',v_ticket_generation,'receiptSigningKeyGeneration',v_receipt_generation,
        'iat',extract(epoch from v_issued)::bigint,'exp',extract(epoch from v_expires)::bigint,
        'maintenancePrincipalId',(p_principal->>'maintenancePrincipalId')::uuid,
        'workItemId',v_old_ticket.work_item_id,
        'credentialGeneration',(p_principal->>'credentialGeneration')::bigint,
        'leaseGeneration',(p_principal->>'leaseGeneration')::bigint,
        'fencingToken',(p_principal->>'fencingToken')::bigint,
        'recoveryKind','AUDIT_VERIFY_AUTHORIZED',
        'recoveryGeneration',(p_request->>'recoveryGeneration')::bigint,
        'replacesVerifyTicketJti',v_old_ticket.ticket_jti,
        'frozenClaim',jsonb_build_object(
          'maintenancePrincipalId',v_old_ticket.maintenance_principal_id,
          'credentialGeneration',v_old_ticket.credential_generation,
          'leaseGeneration',v_old_ticket.maintenance_lease_generation,
          'fencingToken',v_old_ticket.fencing_token,
          'claimGeneration',v_old_ticket.claim_generation
        ),
        'auditRootId',v_old_ticket.audit_root_id,
        'rootHash',v_old_ticket.root_hash,'signatureHash',v_old_ticket.signature_hash,
        'auditSigningKeyGeneration',v_old_ticket.audit_signing_key_generation,
        'auditSigningPublicKeyHash',v_old_ticket.audit_signing_public_key_hash);
      v_bytes:=app_private.openclaw_jcs_bytes_v1(v_payload);
      v_hash:=encode(extensions.digest(convert_to('ihome-openclaw-media-ticket-v1','UTF8')
        ||decode('00','hex')||v_bytes,'sha256'),'hex');
      update public.openclaw_audit_gateway_tickets ticket set is_authoritative=false
      where ticket.organization_id=v_org and ticket.id=v_old_ticket.id and ticket.is_authoritative;
      if not found then raise exception 'audit recovery refresh authority CAS failed'
        using errcode='40001'; end if;
      insert into public.openclaw_audit_gateway_tickets(
        organization_id,work_item_id,ticket_jti,operation,maintenance_principal_id,
        claim_generation,credential_generation,maintenance_lease_generation,fencing_token,
        audit_root_id,root_hash,object_key,signature_hash,audit_signing_key_generation,
        audit_signing_public_key_hash,gateway_key_generation,receipt_signing_key_generation,
        ticket_payload,ticket_bytes,ticket_hash,is_authoritative,replaces_verify_ticket_jti,
        refresh_gateway_denial,refresh_gateway_denial_hash,refresh_claim_token_hash,
        refresh_maintenance_principal_id,refresh_credential_generation,refresh_lease_generation,
        refresh_fencing_token,refresh_recovery_generation,issued_at,expires_at
      ) values (
        v_org,v_old_ticket.work_item_id,v_jti,'ANCHOR_VERIFY',v_old_ticket.maintenance_principal_id,
        v_old_ticket.claim_generation,v_old_ticket.credential_generation,
        v_old_ticket.maintenance_lease_generation,v_old_ticket.fencing_token,
        v_old_ticket.audit_root_id,v_old_ticket.root_hash,v_old_ticket.object_key,
        v_old_ticket.signature_hash,v_old_ticket.audit_signing_key_generation,
        v_old_ticket.audit_signing_public_key_hash,v_ticket_generation,v_receipt_generation,
        v_payload,v_bytes,v_hash,true,v_old_ticket.ticket_jti,p_request->'gatewayDenial',
        v_refresh_denial_hash,v_token,(p_principal->>'maintenancePrincipalId')::uuid,
        (p_principal->>'credentialGeneration')::bigint,
        (p_principal->>'leaseGeneration')::bigint,(p_principal->>'fencingToken')::bigint,
        (p_request->>'recoveryGeneration')::bigint,v_issued,v_expires
      );
      return jsonb_build_object('version',1,'ticketId',v_jti,'ticketHash',v_hash,
        'expiresAt',v_expires,'state','RECOVERY_REFRESHED',
        'replacesVerifyTicketJti',v_old_ticket.ticket_jti,'ticket',v_payload);
    end if;
    select work.* into v_work from public.openclaw_maintenance_work_items work
    join public.openclaw_maintenance_credentials credential
      on credential.organization_id=work.organization_id
     and credential.maintenance_principal_id=work.maintenance_principal_id
     and credential.credential_generation=work.credential_generation and credential.revoked_at is null
    join public.openclaw_maintenance_leases lease
      on lease.organization_id=work.organization_id
     and lease.maintenance_principal_id=work.maintenance_principal_id
     and lease.lease_generation=work.maintenance_lease_generation
     and lease.fencing_token=work.fencing_token and lease.status='ACTIVE'
    where work.organization_id=v_org
      and work.maintenance_principal_id=(p_principal->>'maintenancePrincipalId')::uuid
      and work.id=(p_request->>'workItemId')::uuid and work.work_kind='AUDIT_ANCHOR'
      and work.work_phase='ANCHOR' and work.state in ('LEASED','AUDIT_VERIFY_AUTHORIZED')
      and work.claim_generation=(p_request->>'claimGeneration')::bigint
      and work.claim_token_hash=v_token
      and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
      and work.maintenance_lease_generation=(p_principal->>'leaseGeneration')::bigint
      and work.fencing_token=(p_principal->>'fencingToken')::bigint
      and work.lease_expires_at>v_issued and lease.expires_at>v_issued
    for update of work;
    if not found then raise exception 'maintenance audit work binding CAS failed' using errcode='40001'; end if;
    select root.* into v_root from public.openclaw_audit_roots root
    where root.organization_id=v_org and root.id=v_work.source_id
      and root.id=(p_request->>'auditRootId')::uuid
      and root.root_hash=p_request->>'rootHash'
      and root.r2_anchor_key=p_request->>'anchorKey'
      and root.signing_key_generation=(p_request->>'auditSigningKeyGeneration')::bigint
      and root.anchored_at is null
      and v_work.payload->>'auditRootId'=root.id::text
      and v_work.payload->>'rootHash'=root.root_hash
      and v_work.payload->>'anchorKey'=root.r2_anchor_key
      and (v_work.payload->>'auditSigningKeyGeneration')::bigint=root.signing_key_generation
      and v_work.payload->>'auditSigningPublicKeyHash'=p_request->>'auditSigningPublicKeyHash'
    for update;
    if not found then raise exception 'maintenance audit root binding CAS failed' using errcode='40001'; end if;
    select config.public_key_hash into v_audit_key_hash
    from public.openclaw_audit_signing_configs config
    where config.organization_id=v_org and config.is_active and config.retired_at is null
      and config.signing_key_generation=v_root.signing_key_generation;
    if v_audit_key_hash is distinct from p_request->>'auditSigningPublicKeyHash' then
      raise exception 'audit signing public key hash is not authoritative' using errcode='42501';
    end if;
    if p_request->>'operation'='ANCHOR_VERIFY' then
      select ticket.* into v_existing
      from public.openclaw_audit_gateway_tickets ticket
      where ticket.organization_id=v_org and ticket.work_item_id=v_work.id
        and ticket.is_authoritative
      for update;
      if found then
        if v_existing.signature_hash is distinct from p_request->>'signatureHash'
          or v_existing.audit_signing_public_key_hash is distinct from v_audit_key_hash
          or v_existing.ticket_payload->>'sha256' is distinct from p_request->>'documentSha256'
          or (v_existing.ticket_payload->>'contentLength')::bigint
            is distinct from (p_request->>'documentByteLength')::bigint then
          raise exception 'audit verify ticket replay payload mismatch' using errcode='40001';
        end if;
        return jsonb_build_object('version',1,'ticketId',v_existing.ticket_jti,
          'ticketHash',v_existing.ticket_hash,'expiresAt',v_existing.expires_at,
          'state','ISSUED','ticket',v_existing.ticket_payload);
      end if;
    end if;
  else
    raise exception 'media ticket principal kind denied' using errcode='42501';
  end if;

  perform app_private.openclaw_lock_retention_gateway_config_v1(v_org);
  select config.ticket_key_generation,config.signing_key_generation
    into v_ticket_generation,v_receipt_generation
  from public.openclaw_retention_gateway_configs config
  where config.organization_id=v_org and config.is_active and config.retired_at is null
  ;
  if not found then raise exception 'active ticket signing generation required' using errcode='42501'; end if;

  if v_kind='CHANNEL' then
    v_expires:=v_issued+interval '60 seconds';
    v_payload:=jsonb_build_object('version',1,'aud','openclaw-media-gateway',
      'operation','PUT','subject','RUNTIME','jti',v_jti,'organizationId',v_org,
      'accountId',v_media.account_id,'objectKey',v_media.object_key,'sha256',v_media.sha256,
      'contentType',v_media.mime,'contentLength',v_media.byte_length,
      'sessionGeneration',(p_principal->>'sessionGeneration')::bigint,
      'gatewayKeyGeneration',v_ticket_generation,'iat',extract(epoch from v_issued)::bigint,
      'receiptSigningKeyGeneration',v_receipt_generation,
      'exp',extract(epoch from v_expires)::bigint,'cellId',(p_principal->>'cellId')::uuid,
      'credentialGeneration',(p_principal->>'credentialGeneration')::bigint,
      'leaseGeneration',(p_principal->>'leaseGeneration')::bigint,
      'fencingToken',(p_principal->>'fencingToken')::bigint);
  else
    v_expires:=least(v_issued+interval '60 seconds',v_work.lease_expires_at);
    if v_expires<=v_issued then raise exception 'maintenance audit ticket lease expired' using errcode='40001'; end if;
    v_payload:=jsonb_build_object('version',1,'aud','openclaw-media-gateway',
      'operation',p_request->>'operation','subject','MAINTENANCE','jti',v_jti,
      'organizationId',v_org,'accountId',null,'objectKey',v_root.r2_anchor_key,
      'sha256',p_request->>'documentSha256','contentType','application/json',
      'contentLength',(p_request->>'documentByteLength')::bigint,'sessionGeneration',0,
      'gatewayKeyGeneration',v_ticket_generation,'iat',extract(epoch from v_issued)::bigint,
      'receiptSigningKeyGeneration',v_receipt_generation,
      'exp',extract(epoch from v_expires)::bigint,
      'maintenancePrincipalId',(p_principal->>'maintenancePrincipalId')::uuid,
      'workItemId',v_work.id,'claimGeneration',v_work.claim_generation,
      'credentialGeneration',v_work.credential_generation,
      'leaseGeneration',v_work.maintenance_lease_generation,'fencingToken',v_work.fencing_token,
      'auditRootId',v_root.id,'rootHash',v_root.root_hash,
      'signatureHash',p_request->>'signatureHash',
      'auditSigningKeyGeneration',v_root.signing_key_generation,
      'auditSigningPublicKeyHash',v_audit_key_hash);
  end if;
  v_bytes:=app_private.openclaw_jcs_bytes_v1(v_payload);
  v_hash:=encode(extensions.digest(convert_to('ihome-openclaw-media-ticket-v1','UTF8')
    ||decode('00','hex')||v_bytes,'sha256'),'hex');
  if v_kind='CHANNEL' then
    insert into public.openclaw_media_upload_tickets(
      organization_id,ticket_jti,media_id,account_id,cell_id,object_key,sha256,content_type,
      content_length,credential_generation,lease_generation,fencing_token,session_generation,
      gateway_key_generation,receipt_signing_key_generation,issued_at,expires_at
    ) values (
      v_org,v_jti,v_media.id,v_media.account_id,(p_principal->>'cellId')::uuid,
      v_media.object_key,v_media.sha256,v_media.mime,v_media.byte_length,
      (p_principal->>'credentialGeneration')::bigint,(p_principal->>'leaseGeneration')::bigint,
      (p_principal->>'fencingToken')::bigint,(p_principal->>'sessionGeneration')::bigint,
      v_ticket_generation,v_receipt_generation,v_issued,v_expires
    );
  elsif p_request->>'operation'='ANCHOR_VERIFY' then
    insert into public.openclaw_audit_gateway_tickets(
      organization_id,work_item_id,ticket_jti,operation,maintenance_principal_id,
      claim_generation,credential_generation,maintenance_lease_generation,fencing_token,
      audit_root_id,root_hash,object_key,signature_hash,audit_signing_key_generation,
      audit_signing_public_key_hash,gateway_key_generation,receipt_signing_key_generation,
      ticket_payload,ticket_bytes,ticket_hash,issued_at,expires_at
    ) values (
      v_org,v_work.id,v_jti,'ANCHOR_VERIFY',v_work.maintenance_principal_id,
      v_work.claim_generation,v_work.credential_generation,v_work.maintenance_lease_generation,
      v_work.fencing_token,v_root.id,v_root.root_hash,v_root.r2_anchor_key,
      p_request->>'signatureHash',v_root.signing_key_generation,v_audit_key_hash,
      v_ticket_generation,v_receipt_generation,v_payload,v_bytes,v_hash,v_issued,v_expires
    );
    update public.openclaw_maintenance_work_items work set
      state='AUDIT_VERIFY_AUTHORIZED',
      recovery_maintenance_principal_id=work.maintenance_principal_id,
      recovery_credential_generation=work.credential_generation,
      recovery_lease_generation=work.maintenance_lease_generation,
      recovery_fencing_token=work.fencing_token,
      recovery_generation=1,recovery_lease_expires_at=work.lease_expires_at,
      updated_at=statement_timestamp()
    where work.organization_id=v_org and work.id=v_work.id and work.state='LEASED'
      and work.claim_generation=v_work.claim_generation;
    if not found then raise exception 'audit verify authorization transition CAS failed' using errcode='40001'; end if;
  end if;
  return jsonb_build_object('version',1,'ticketId',v_jti,'ticketHash',v_hash,
    'expiresAt',v_expires,'state','ISSUED','ticket',v_payload);
end;
$function$;

create or replace function app_private.openclaw_finalize_media_upload_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal->>'organizationId')::uuid;
  v_account uuid := (p_principal->>'accountId')::uuid;
  v_cell uuid := (p_principal->>'cellId')::uuid;
  v_receipt jsonb := p_request->'gatewayReceipt';
  v_ticket public.openclaw_media_upload_tickets%rowtype;
  v_media public.openclaw_message_media%rowtype;
  v_receipt_hash text;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,array['version','mediaId','gatewayReceipt'],array['version','mediaId','gatewayReceipt']
  );
  perform app_private.openclaw_assert_strict_object_v1(
    v_receipt,
    array['version','receiptKind','receiptId','organizationId','accountId','cellId','mediaId',
      'objectKey','sha256','contentType','contentLength','uploadTicketJti',
      'credentialGeneration','leaseGeneration','fencingToken','sessionGeneration',
      'objectVersionOrEtag','storedAt','gatewaySigningKeyGeneration','signature'],
    array['version','receiptKind','receiptId','organizationId','accountId','cellId','mediaId',
      'objectKey','sha256','contentType','contentLength','uploadTicketJti',
      'credentialGeneration','leaseGeneration','fencingToken','sessionGeneration',
      'objectVersionOrEtag','storedAt','gatewaySigningKeyGeneration','signature']
  );
  if p_request->>'version'<>'1' or p_request->>'mediaId' !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or v_receipt->>'version'<>'1' or v_receipt->>'receiptKind'<>'MEDIA_UPLOAD'
     or v_receipt->>'receiptId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or v_receipt->>'uploadTicketJti' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or v_receipt->>'mediaId' is distinct from p_request->>'mediaId'
     or v_receipt->>'sha256' !~ '^[0-9a-f]{64}$'
     or coalesce(v_receipt->>'contentType','')=''
     or coalesce(v_receipt->>'contentLength','') !~ '^[1-9][0-9]*$'
     or (v_receipt->>'contentLength')::bigint > 52428800
     or coalesce(v_receipt->>'objectKey','')=''
     or coalesce(v_receipt->>'objectVersionOrEtag','')=''
     or coalesce(v_receipt->>'storedAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
     or coalesce(v_receipt->>'signature','') !~ '^[A-Za-z0-9_-]{86}$'
     or coalesce(v_receipt->>'credentialGeneration','') !~ '^[1-9][0-9]*$'
     or coalesce(v_receipt->>'leaseGeneration','') !~ '^[1-9][0-9]*$'
     or coalesce(v_receipt->>'fencingToken','') !~ '^[1-9][0-9]*$'
     or coalesce(v_receipt->>'sessionGeneration','') !~ '^[1-9][0-9]*$'
     or coalesce(v_receipt->>'gatewaySigningKeyGeneration','') !~ '^[1-9][0-9]*$'
  then
    raise exception 'media upload receipt is invalid' using errcode='22023';
  end if;
  v_receipt_hash:=encode(extensions.digest(
    convert_to('ihome-openclaw-media-upload-receipt-v1','UTF8')||decode('00','hex')
      ||app_private.openclaw_jcs_bytes_v1(v_receipt),'sha256'
  ),'hex');
  select ticket.* into v_ticket from public.openclaw_media_upload_tickets ticket
  where ticket.organization_id=v_org and ticket.ticket_jti=(v_receipt->>'uploadTicketJti')::uuid
  for update;
  if not found then raise exception 'media upload ticket is unknown' using errcode='42501'; end if;
  if v_ticket.media_id<>(p_request->>'mediaId')::uuid or v_ticket.account_id<>v_account
     or v_ticket.object_key is distinct from v_receipt->>'objectKey'
     or v_ticket.sha256 is distinct from v_receipt->>'sha256'
     or v_ticket.content_type is distinct from v_receipt->>'contentType'
     or v_ticket.content_length<>(v_receipt->>'contentLength')::bigint
     or v_ticket.receipt_signing_key_generation<>(v_receipt->>'gatewaySigningKeyGeneration')::bigint
     or v_receipt->>'organizationId' is distinct from v_org::text
     or v_receipt->>'accountId' is distinct from v_account::text
     or v_receipt->>'cellId' is distinct from v_ticket.cell_id::text
     or (v_receipt->>'credentialGeneration')::bigint<>v_ticket.credential_generation
     or (v_receipt->>'leaseGeneration')::bigint<>v_ticket.lease_generation
     or (v_receipt->>'fencingToken')::bigint<>v_ticket.fencing_token
     or (v_receipt->>'sessionGeneration')::bigint<>v_ticket.session_generation
  then
    raise exception 'media upload receipt principal or ticket binding is stale' using errcode='42501';
  end if;
  select media.* into v_media from public.openclaw_message_media media
  where media.organization_id=v_org and media.account_id=v_account and media.id=v_ticket.media_id
  for update;
  if not found then raise exception 'media upload binding is unknown' using errcode='42501'; end if;
  if v_media.byte_state='AVAILABLE' then
    if v_media.media_upload_receipt is distinct from v_receipt
       or v_media.media_upload_receipt_hash is distinct from v_receipt_hash
       or v_media.media_upload_ticket_jti is distinct from v_ticket.ticket_jti
    then raise exception 'media upload finalization replay mismatch' using errcode='40001'; end if;
    return jsonb_build_object('version',1,'mediaId',v_media.id,'byteState','AVAILABLE',
      'receiptHash',v_receipt_hash,'idempotentReplay',true);
  end if;
  if v_media.byte_state<>'PENDING'
     or v_media.object_key is distinct from v_ticket.object_key
     or v_media.sha256 is distinct from v_ticket.sha256
     or v_media.mime is distinct from v_ticket.content_type
     or v_media.byte_length is distinct from v_ticket.content_length
  then raise exception 'media upload finalization CAS is stale' using errcode='40001'; end if;
  update public.openclaw_message_media media set
    byte_state='AVAILABLE',media_upload_receipt=v_receipt,media_upload_receipt_hash=v_receipt_hash,
    media_upload_receipt_id=(v_receipt->>'receiptId')::uuid,
    media_upload_ticket_jti=v_ticket.ticket_jti,
    media_upload_object_version_or_etag=v_receipt->>'objectVersionOrEtag',
    media_upload_finalized_at=statement_timestamp(),updated_at=statement_timestamp()
  where media.organization_id=v_org and media.account_id=v_account and media.id=v_media.id
    and media.byte_state='PENDING' and media.media_upload_receipt is null;
  if not found then raise exception 'media upload finalization CAS failed' using errcode='40001'; end if;
  update public.openclaw_media_upload_tickets ticket set finalized_at=statement_timestamp()
  where ticket.organization_id=v_org and ticket.ticket_jti=v_ticket.ticket_jti and ticket.finalized_at is null;
  if not found then raise exception 'media upload ticket finalization CAS failed' using errcode='40001'; end if;
  return jsonb_build_object('version',1,'mediaId',v_media.id,'byteState','AVAILABLE',
    'receiptHash',v_receipt_hash,'idempotentReplay',false);
end;
$function$;

create or replace function app_private.openclaw_issue_retention_delete_ticket_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal->>'organizationId')::uuid;
  v_maintenance uuid := (p_principal->>'maintenancePrincipalId')::uuid;
  v_work public.openclaw_maintenance_work_items%rowtype;
  v_tomb public.openclaw_retention_tombstones%rowtype;
  v_media public.openclaw_message_media%rowtype;
  v_existing public.openclaw_retention_delete_tickets%rowtype;
  v_token text;
  v_hold_version bigint;
  v_ticket_signing bigint;
  v_receipt_signing bigint;
  v_ticket_id uuid := gen_random_uuid();
  v_ticket_jti uuid := gen_random_uuid();
  v_authorization_jti uuid := gen_random_uuid();
  v_issued timestamptz := date_trunc('second',statement_timestamp());
  v_expires timestamptz;
  v_payload jsonb;
  v_expected_receipt jsonb;
  v_bytes bytea;
  v_hash text;
  v_domain_hash text;
  v_idempotent_replay boolean := false;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','workItemId','claimGeneration','claimToken'],
    array['version','workItemId','claimGeneration','claimToken']
  );
  if p_request->>'version'<>'1' then
    raise exception 'retention delete ticket version mismatch' using errcode='22023';
  end if;
  perform app_private.openclaw_lock_retention_scope_v1(v_org);
  v_token := encode(extensions.digest(convert_to('ihome-openclaw-work-claim-v1','UTF8')
    ||decode('00','hex')||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');
  select ticket.* into v_existing
  from public.openclaw_retention_delete_tickets ticket
  where ticket.organization_id=v_org
    and ticket.work_item_id=(p_request->>'workItemId')::uuid
    and ticket.claim_generation=(p_request->>'claimGeneration')::bigint
  for update;
  if found then
    v_idempotent_replay:=true;
    if v_existing.maintenance_principal_id<>v_maintenance
      or v_existing.credential_generation<>(p_principal->>'credentialGeneration')::bigint
      or v_existing.maintenance_lease_generation<>(p_principal->>'leaseGeneration')::bigint
      or v_existing.fencing_token<>(p_principal->>'fencingToken')::bigint
      or v_existing.claim_token_hash<>v_token
      or v_existing.state='REVOKED' then
      raise exception 'retention delete ticket replay binding mismatch' using errcode='42501';
    end if;
    return jsonb_build_object('version',1,'ticketId',v_existing.id,
      'ticketHash',v_existing.ticket_hash,'expiresAt',v_existing.expires_at,
      'state','TICKET_ISSUED','ticket',v_existing.ticket_payload);
  end if;
  select work.* into v_work from public.openclaw_maintenance_work_items work
  join public.openclaw_maintenance_credentials credential
    on credential.organization_id=work.organization_id
   and credential.maintenance_principal_id=work.maintenance_principal_id
   and credential.credential_generation=work.credential_generation and credential.revoked_at is null
  join public.openclaw_maintenance_leases lease
    on lease.organization_id=work.organization_id
   and lease.maintenance_principal_id=work.maintenance_principal_id
   and lease.lease_generation=work.maintenance_lease_generation
   and lease.fencing_token=work.fencing_token and lease.status='ACTIVE'
  where work.organization_id=v_org and work.maintenance_principal_id=v_maintenance
    and work.id=(p_request->>'workItemId')::uuid and work.work_kind='RETENTION_DELETE'
    and work.work_phase='FINAL_DELETE' and work.state='LEASED'
    and work.claim_generation=(p_request->>'claimGeneration')::bigint
    and work.claim_token_hash=v_token
    and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
    and work.maintenance_lease_generation=(p_principal->>'leaseGeneration')::bigint
    and work.fencing_token=(p_principal->>'fencingToken')::bigint
    and work.lease_expires_at>v_issued and lease.expires_at>v_issued
  for update of work;
  if not found then raise exception 'retention delete binding CAS failed' using errcode='40001'; end if;
  perform app_private.openclaw_lock_retention_tombstone_v1(v_org,v_work.source_id);
  select tombstone.* into v_tomb from public.openclaw_retention_tombstones tombstone
  where tombstone.organization_id=v_org
    and tombstone.id=v_work.source_id
    and tombstone.subject_kind='MEDIA'
    and tombstone.subject_id=(v_work.payload->>'subjectId')::uuid
    and tombstone.quarantine_version=(v_work.payload->>'quarantineVersion')::bigint
    and tombstone.final_delete_not_before<=v_issued
    and tombstone.object_key is not null;
  if not found then raise exception 'final_delete_not_before or tombstone CAS failed' using errcode='40001'; end if;
  select media.* into v_media from public.openclaw_message_media media
  where media.organization_id=v_org and media.id=v_tomb.subject_id
    and media.object_key is null and media.byte_state='QUARANTINED'
    and media.sha256 is not null and media.mime is not null
    and media.byte_length between 1 and 52428800 for share;
  if not found then raise exception 'quarantined media ticket metadata is incomplete' using errcode='40001'; end if;
  perform scope.id from public.openclaw_retention_hold_scopes scope
  where scope.organization_id=v_org and (scope.scope_kind='ORGANIZATION'
    or (scope.scope_kind='MEDIA' and scope.scope_id=v_tomb.subject_id))
  order by scope.scope_kind,scope.scope_id,scope.id for share;
  if app_private.openclaw_retention_subject_held_v1(v_org,'MEDIA',v_tomb.subject_id) then
    raise exception 'active descendant legal hold blocks retention delete' using errcode='42501';
  end if;
  select coalesce(clock.hold_version,0) into v_hold_version
  from (select 1) singleton left join public.openclaw_retention_hold_clocks clock
    on clock.organization_id=v_org;
  perform app_private.openclaw_lock_retention_gateway_config_v1(v_org);
  select config.ticket_key_generation,config.signing_key_generation
    into v_ticket_signing,v_receipt_signing
  from public.openclaw_retention_gateway_configs config
  where config.organization_id=v_org and config.is_active
    and config.retired_at is null;
  if not found then raise exception 'active secret-free retention gateway signing generation required'
    using errcode='42501'; end if;
  v_expires:=least(v_issued+interval '60 seconds',v_work.lease_expires_at);
  if v_expires<=v_issued then
    raise exception 'retention delete ticket lease expired' using errcode='40001';
  end if;
  v_payload := jsonb_build_object('version',1,'aud','openclaw-media-gateway',
    'operation','DELETE','subject','MAINTENANCE','jti',v_ticket_jti,
    'organizationId',v_org,'accountId',null,'objectKey',v_tomb.object_key,
    'sha256',v_media.sha256,'contentType',v_media.mime,'contentLength',v_media.byte_length,
    'sessionGeneration',0,'gatewayKeyGeneration',v_ticket_signing,
    'receiptSigningKeyGeneration',v_receipt_signing,
    'iat',extract(epoch from v_issued)::bigint,'exp',extract(epoch from v_expires)::bigint,
    'maintenancePrincipalId',v_maintenance,'workItemId',v_work.id,
    'claimGeneration',v_work.claim_generation,
    'credentialGeneration',v_work.credential_generation,
    'leaseGeneration',v_work.maintenance_lease_generation,
    'fencingToken',v_work.fencing_token,'deletePhase','FINAL_DELETE',
    'holdVersion',v_hold_version,'quarantineVersion',v_tomb.quarantine_version,
    'finalDeleteNotBefore',extract(epoch from v_tomb.final_delete_not_before)::bigint);
  v_bytes := app_private.openclaw_jcs_bytes_v1(v_payload);
  v_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-retention-delete-ticket-v1','UTF8')||decode('00','hex')
      ||v_bytes,'sha256'),'hex');
  v_domain_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-retention-delete-domain-v1','UTF8')||decode('00','hex')
      ||convert_to(v_org::text||':'||v_ticket_jti||':'||v_tomb.object_key,'UTF8'),
    'sha256'),'hex');
  v_expected_receipt := jsonb_build_object('version',1,
    'receiptKind','RETENTION_FINAL_DELETE','organizationId',v_org,
    'maintenancePrincipalId',v_maintenance,'workItemId',v_work.id,
    'claimGeneration',v_work.claim_generation,'credentialGeneration',v_work.credential_generation,
    'leaseGeneration',v_work.maintenance_lease_generation,'fencingToken',v_work.fencing_token,
    'objectKey',v_tomb.object_key,'deletePhase','FINAL_DELETE','holdVersion',v_hold_version,
    'quarantineVersion',v_tomb.quarantine_version,'deleteTicketJti',v_ticket_jti,
    'deleteAuthorizationJti',v_authorization_jti,'proofJti',v_authorization_jti,
    'gatewaySigningKeyGeneration',v_receipt_signing);
  insert into public.openclaw_retention_delete_tickets(
    id,organization_id,maintenance_principal_id,work_item_id,tombstone_id,subject_id,
    object_key,ticket_jti,delete_authorization_jti,claim_token_hash,claim_generation,
    credential_generation,maintenance_lease_generation,fencing_token,hold_version,
    quarantine_version,signing_key_generation,receipt_signing_key_generation,domain_hash,
    ticket_payload,ticket_bytes,ticket_hash,expected_receipt_claims,state,issued_at,expires_at
  ) values (
    v_ticket_id,v_org,v_maintenance,v_work.id,v_tomb.id,v_tomb.subject_id,v_tomb.object_key,
    v_ticket_jti,v_authorization_jti,v_token,v_work.claim_generation,v_work.credential_generation,
    v_work.maintenance_lease_generation,v_work.fencing_token,v_hold_version,
    v_tomb.quarantine_version,v_ticket_signing,v_receipt_signing,v_domain_hash,
    v_payload,v_bytes,v_hash,v_expected_receipt,'TICKET_ISSUED',v_issued,v_expires
  );
  return jsonb_build_object('version',1,'ticketId',v_ticket_id,'ticketHash',v_hash,
    'expiresAt',v_expires,'state','TICKET_ISSUED','ticket',v_payload);
end;
$function$;

create or replace function app_private.openclaw_authorize_retention_delete_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal->>'organizationId')::uuid;
  v_maintenance uuid := (p_principal->>'maintenancePrincipalId')::uuid;
  v_work public.openclaw_maintenance_work_items%rowtype;
  v_tomb public.openclaw_retention_tombstones%rowtype;
  v_ticket public.openclaw_retention_delete_tickets%rowtype;
  v_token text;
  v_hold_version bigint;
  v_ticket_signing bigint;
  v_receipt_signing bigint;
  v_gateway_key_hash text;
  v_issued timestamptz := date_trunc('milliseconds',statement_timestamp());
  v_expires timestamptz;
  v_ticket_expires timestamptz;
  v_claims jsonb;
  v_payload jsonb;
  v_bytes bytea;
  v_authorization_hash text;
  v_refresh boolean := p_request->>'recoveryKind'='RETENTION_DELETE_AUTHORIZED';
  v_old_lineage public.openclaw_retention_delete_ticket_lineage%rowtype;
  v_existing_lineage public.openclaw_retention_delete_ticket_lineage%rowtype;
  v_new_ticket_jti uuid := gen_random_uuid();
  v_new_authorization_jti uuid := gen_random_uuid();
  v_ticket_payload jsonb;
  v_ticket_bytes bytea;
  v_ticket_hash text;
  v_domain_hash text;
  v_refresh_denial_hash text;
begin
  if v_refresh then
    perform app_private.openclaw_assert_strict_object_v1(
      p_request,
      array['version','recoveryKind','workItemId','recoveryGeneration','claimToken','ticketId',
        'expiredTicketJti','expiredDeleteAuthorizationJti','gatewayDenial'],
      array['version','recoveryKind','workItemId','recoveryGeneration','claimToken','ticketId',
        'expiredTicketJti','expiredDeleteAuthorizationJti','gatewayDenial']
    );
    perform app_private.openclaw_assert_strict_object_v1(
      p_request->'gatewayDenial',array['status','code'],array['status','code']
    );
  else
    perform app_private.openclaw_assert_strict_object_v1(
      p_request,
      array['version','workItemId','claimGeneration','claimToken'],
      array['version','workItemId','claimGeneration','claimToken']
    );
  end if;
  if p_request->>'version'<>'1' then
    raise exception 'retention authorization version mismatch' using errcode='22023';
  end if;
  perform app_private.openclaw_lock_retention_scope_v1(v_org);
  v_token := encode(extensions.digest(convert_to('ihome-openclaw-work-claim-v1','UTF8')
    ||decode('00','hex')||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');
  if v_refresh then
    if p_request->>'recoveryKind'<>'RETENTION_DELETE_AUTHORIZED'
       or p_request->>'expiredTicketJti' !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or p_request->>'expiredDeleteAuthorizationJti' !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or p_request->'gatewayDenial' is distinct from
         jsonb_build_object('status',410,'code','TICKET_EXPIRED_NO_WORK') then
      raise exception 'retention recovery refresh evidence invalid' using errcode='22023';
    end if;
    v_refresh_denial_hash:=encode(extensions.digest(
      app_private.openclaw_jcs_bytes_v1(p_request->'gatewayDenial'),'sha256'),'hex');
    select lineage.* into v_existing_lineage
    from public.openclaw_retention_delete_ticket_lineage lineage
    where lineage.organization_id=v_org
      and lineage.logical_ticket_id=(p_request->>'ticketId')::uuid
      and lineage.work_item_id=(p_request->>'workItemId')::uuid
      and lineage.replaces_ticket_jti=(p_request->>'expiredTicketJti')::uuid
      and lineage.replaces_delete_authorization_jti=
        (p_request->>'expiredDeleteAuthorizationJti')::uuid
      and lineage.refresh_gateway_denial=p_request->'gatewayDenial'
      and lineage.refresh_gateway_denial_hash=v_refresh_denial_hash
      and lineage.authorization_claim_token_hash=v_token
      and lineage.authorization_maintenance_principal_id=v_maintenance
      and lineage.authorization_credential_generation=
        (p_principal->>'credentialGeneration')::bigint
      and lineage.authorization_lease_generation=(p_principal->>'leaseGeneration')::bigint
      and lineage.authorization_fencing_token=(p_principal->>'fencingToken')::bigint
      and lineage.recovery_generation=(p_request->>'recoveryGeneration')::bigint;
    if found then
      return jsonb_build_object('version',1,'ticketId',v_existing_lineage.logical_ticket_id,
        'ticketHash',v_existing_lineage.ticket_hash,
        'deleteAuthorizationJti',v_existing_lineage.delete_authorization_jti,
        'expiresAt',v_existing_lineage.authorization_expires_at,
        'state','RECOVERY_REFRESHED','replacesTicketJti',v_existing_lineage.replaces_ticket_jti,
        'replacesDeleteAuthorizationJti',v_existing_lineage.replaces_delete_authorization_jti,
        'ticket',v_existing_lineage.ticket_payload,
        'authorization',v_existing_lineage.authorization_payload);
    end if;
    select ticket.* into v_ticket
    from public.openclaw_retention_delete_tickets ticket
    where ticket.organization_id=v_org and ticket.id=(p_request->>'ticketId')::uuid
      and ticket.work_item_id=(p_request->>'workItemId')::uuid
    for update;
    if not found or v_ticket.state<>'DELETE_AUTHORIZED'
       or v_ticket.ticket_jti<>(p_request->>'expiredTicketJti')::uuid
       or v_ticket.delete_authorization_jti<>
         (p_request->>'expiredDeleteAuthorizationJti')::uuid then
      raise exception 'retention recovery refresh authoritative pointer mismatch'
        using errcode='40001';
    end if;
    select lineage.* into v_old_lineage
    from public.openclaw_retention_delete_ticket_lineage lineage
    where lineage.organization_id=v_org and lineage.logical_ticket_id=v_ticket.id
      and lineage.ticket_jti=v_ticket.ticket_jti
      and lineage.delete_authorization_jti=v_ticket.delete_authorization_jti;
    if not found or (v_old_lineage.expires_at>v_issued
      and v_old_lineage.authorization_expires_at>v_issued) then
      raise exception 'retention recovery refresh requires expired ticket or proof'
        using errcode='40001';
    end if;
    select work.* into v_work from public.openclaw_maintenance_work_items work
    join public.openclaw_maintenance_credentials credential
      on credential.organization_id=work.organization_id
     and credential.maintenance_principal_id=work.recovery_maintenance_principal_id
     and credential.credential_generation=work.recovery_credential_generation
     and credential.revoked_at is null
    join public.openclaw_maintenance_leases lease
      on lease.organization_id=work.organization_id
     and lease.maintenance_principal_id=work.recovery_maintenance_principal_id
     and lease.lease_generation=work.recovery_lease_generation
     and lease.fencing_token=work.recovery_fencing_token
     and lease.status='ACTIVE' and lease.expires_at>v_issued
    where work.organization_id=v_org and work.id=v_ticket.work_item_id
      and work.state='DELETE_AUTHORIZED' and work.work_kind='RETENTION_DELETE'
      and work.work_phase='FINAL_DELETE'
      and work.recovery_maintenance_principal_id=v_maintenance
      and work.recovery_credential_generation=(p_principal->>'credentialGeneration')::bigint
      and work.recovery_lease_generation=(p_principal->>'leaseGeneration')::bigint
      and work.recovery_fencing_token=(p_principal->>'fencingToken')::bigint
      and work.recovery_generation=(p_request->>'recoveryGeneration')::bigint
      and work.claim_token_hash=v_token and work.recovery_lease_expires_at>v_issued
    for update of work;
    if not found then raise exception 'retention recovery refresh ownership CAS failed'
      using errcode='40001'; end if;
    perform app_private.openclaw_lock_retention_tombstone_v1(v_org,v_work.source_id);
    select tombstone.* into v_tomb from public.openclaw_retention_tombstones tombstone
    where tombstone.organization_id=v_org and tombstone.id=v_ticket.tombstone_id
      and tombstone.subject_kind='MEDIA' and tombstone.subject_id=v_ticket.subject_id
      and tombstone.object_key=v_ticket.object_key
      and tombstone.quarantine_version=v_ticket.quarantine_version
      and tombstone.final_delete_not_before<=v_issued;
    if not found then raise exception 'retention recovery refresh tombstone mismatch'
      using errcode='40001'; end if;
    perform scope.id from public.openclaw_retention_hold_scopes scope
    where scope.organization_id=v_org and (scope.scope_kind='ORGANIZATION'
      or (scope.scope_kind='MEDIA' and scope.scope_id=v_tomb.subject_id))
    order by scope.scope_kind,scope.scope_id,scope.id for share;
    if app_private.openclaw_retention_subject_held_v1(v_org,'MEDIA',v_tomb.subject_id) then
      raise exception 'active descendant legal hold blocks retention recovery refresh'
        using errcode='42501';
    end if;
    select coalesce(clock.hold_version,0) into v_hold_version
    from (select 1) singleton left join public.openclaw_retention_hold_clocks clock
      on clock.organization_id=v_org;
    if v_hold_version<>v_old_lineage.hold_version then
      raise exception 'hold_version changed before retention recovery refresh'
        using errcode='40001';
    end if;
    perform app_private.openclaw_lock_retention_gateway_config_v1(v_org);
    select config.ticket_key_generation,config.signing_key_generation,config.public_key_hash
      into v_ticket_signing,v_receipt_signing,v_gateway_key_hash
    from public.openclaw_retention_gateway_configs config
    where config.organization_id=v_org and config.is_active and config.retired_at is null;
    if not found then raise exception 'active retention Gateway generations required'
      using errcode='42501'; end if;
    v_ticket_expires:=least(v_issued+interval '60 seconds',v_work.recovery_lease_expires_at);
    v_expires:=least(v_issued+interval '5 seconds',v_work.recovery_lease_expires_at);
    if v_ticket_expires<=v_issued or v_expires<=v_issued then
      raise exception 'retention recovery refresh lease expired' using errcode='40001';
    end if;
    v_ticket_payload:=jsonb_build_object('version',1,'aud','openclaw-media-gateway',
      'operation','DELETE','subject','MAINTENANCE','jti',v_new_ticket_jti,
      'organizationId',v_org,'accountId',null,'objectKey',v_old_lineage.object_key,
      'sha256',v_old_lineage.sha256,'contentType',v_old_lineage.content_type,
      'contentLength',v_old_lineage.content_length,'sessionGeneration',0,
      'gatewayKeyGeneration',v_ticket_signing,
      'receiptSigningKeyGeneration',v_receipt_signing,
      'iat',extract(epoch from date_trunc('second',v_issued))::bigint,
      'exp',extract(epoch from date_trunc('second',v_ticket_expires))::bigint,
      'maintenancePrincipalId',v_maintenance,'workItemId',v_old_lineage.work_item_id,
      'credentialGeneration',(p_principal->>'credentialGeneration')::bigint,
      'leaseGeneration',(p_principal->>'leaseGeneration')::bigint,
      'fencingToken',(p_principal->>'fencingToken')::bigint,
      'recoveryKind','RETENTION_DELETE_AUTHORIZED',
      'recoveryGeneration',(p_request->>'recoveryGeneration')::bigint,
      'replacesTicketJti',v_old_lineage.ticket_jti,
      'replacesDeleteAuthorizationJti',v_old_lineage.delete_authorization_jti,
      'frozenClaim',jsonb_build_object(
        'maintenancePrincipalId',v_old_lineage.maintenance_principal_id,
        'credentialGeneration',v_old_lineage.credential_generation,
        'leaseGeneration',v_old_lineage.maintenance_lease_generation,
        'fencingToken',v_old_lineage.fencing_token,
        'claimGeneration',v_old_lineage.claim_generation
      ),
      'deletePhase','FINAL_DELETE',
      'holdVersion',v_old_lineage.hold_version,
      'quarantineVersion',v_old_lineage.quarantine_version,
      'finalDeleteNotBefore',v_old_lineage.ticket_payload->'finalDeleteNotBefore');
    v_ticket_bytes:=app_private.openclaw_jcs_bytes_v1(v_ticket_payload);
    v_ticket_hash:=encode(extensions.digest(
      convert_to('ihome-openclaw-retention-delete-ticket-v1','UTF8')||decode('00','hex')
        ||v_ticket_bytes,'sha256'),'hex');
    v_domain_hash:=encode(extensions.digest(
      convert_to('ihome-openclaw-retention-delete-domain-v1','UTF8')||decode('00','hex')
        ||convert_to(v_org::text||':'||v_new_ticket_jti||':'||v_old_lineage.object_key,'UTF8'),
      'sha256'),'hex');
    v_claims:=jsonb_build_object('version',1,'receiptKind','RETENTION_FINAL_DELETE',
      'organizationId',v_org,'maintenancePrincipalId',v_old_lineage.maintenance_principal_id,
      'workItemId',v_old_lineage.work_item_id,'claimGeneration',v_old_lineage.claim_generation,
      'credentialGeneration',v_old_lineage.credential_generation,
      'leaseGeneration',v_old_lineage.maintenance_lease_generation,
      'fencingToken',v_old_lineage.fencing_token,'objectKey',v_old_lineage.object_key,
      'deletePhase','FINAL_DELETE','holdVersion',v_old_lineage.hold_version,
      'quarantineVersion',v_old_lineage.quarantine_version,
      'deleteTicketJti',v_new_ticket_jti,
      'deleteAuthorizationJti',v_new_authorization_jti,'proofJti',v_new_authorization_jti,
      'gatewaySigningKeyGeneration',v_receipt_signing);
    v_payload:=jsonb_build_object('version',1,'authorizationKind','RETENTION_FINAL_DELETE',
      'organizationId',v_org,'maintenancePrincipalId',v_maintenance,
      'workItemId',v_old_lineage.work_item_id,
      'credentialGeneration',(p_principal->>'credentialGeneration')::bigint,
      'leaseGeneration',(p_principal->>'leaseGeneration')::bigint,
      'fencingToken',(p_principal->>'fencingToken')::bigint,
      'recoveryKind','RETENTION_DELETE_AUTHORIZED',
      'recoveryGeneration',(p_request->>'recoveryGeneration')::bigint,
      'replacesTicketJti',v_old_lineage.ticket_jti,
      'replacesDeleteAuthorizationJti',v_old_lineage.delete_authorization_jti,
      'frozenClaim',jsonb_build_object(
        'maintenancePrincipalId',v_old_lineage.maintenance_principal_id,
        'credentialGeneration',v_old_lineage.credential_generation,
        'leaseGeneration',v_old_lineage.maintenance_lease_generation,
        'fencingToken',v_old_lineage.fencing_token,
        'claimGeneration',v_old_lineage.claim_generation
      ),
      'objectKey',v_old_lineage.object_key,
      'deletePhase','FINAL_DELETE','holdVersion',v_old_lineage.hold_version,
      'quarantineVersion',v_old_lineage.quarantine_version,'deleteTicketJti',v_new_ticket_jti,
      'authorizationJti',v_new_authorization_jti,
      'iat',to_char(v_issued at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'exp',to_char(v_expires at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'gatewaySigningKeyGeneration',v_ticket_signing);
    v_bytes:=app_private.openclaw_jcs_bytes_v1(v_payload);
    v_authorization_hash:=encode(extensions.digest(
      convert_to('ihome-openclaw-retention-authorization-v1','UTF8')||decode('00','hex')
        ||v_bytes,'sha256'),'hex');
    insert into public.openclaw_retention_delete_ticket_lineage(
      organization_id,logical_ticket_id,maintenance_principal_id,work_item_id,tombstone_id,
      subject_id,object_key,sha256,content_type,content_length,ticket_jti,
      delete_authorization_jti,claim_generation,credential_generation,
      maintenance_lease_generation,fencing_token,authorization_claim_token_hash,
      authorization_maintenance_principal_id,authorization_credential_generation,
      authorization_lease_generation,authorization_fencing_token,recovery_generation,
      hold_version,quarantine_version,ticket_signing_key_generation,
      receipt_signing_key_generation,gateway_public_key_hash,domain_hash,ticket_payload,
      ticket_bytes,ticket_hash,expected_receipt_claims,authorization_payload,
      authorization_bytes,authorization_hash,issued_at,expires_at,authorized_at,
      authorization_expires_at,replaces_ticket_jti,replaces_delete_authorization_jti,
      refresh_gateway_denial,refresh_gateway_denial_hash
    ) values (
      v_org,v_ticket.id,v_old_lineage.maintenance_principal_id,v_old_lineage.work_item_id,
      v_old_lineage.tombstone_id,v_old_lineage.subject_id,v_old_lineage.object_key,
      v_old_lineage.sha256,v_old_lineage.content_type,v_old_lineage.content_length,
      v_new_ticket_jti,v_new_authorization_jti,v_old_lineage.claim_generation,
      v_old_lineage.credential_generation,v_old_lineage.maintenance_lease_generation,
      v_old_lineage.fencing_token,v_token,v_maintenance,
      (p_principal->>'credentialGeneration')::bigint,(p_principal->>'leaseGeneration')::bigint,
      (p_principal->>'fencingToken')::bigint,(p_request->>'recoveryGeneration')::bigint,
      v_old_lineage.hold_version,v_old_lineage.quarantine_version,v_ticket_signing,
      v_receipt_signing,v_gateway_key_hash,v_domain_hash,v_ticket_payload,v_ticket_bytes,
      v_ticket_hash,v_claims,v_payload,v_bytes,v_authorization_hash,v_issued,v_ticket_expires,
      v_issued,v_expires,v_old_lineage.ticket_jti,v_old_lineage.delete_authorization_jti,
      p_request->'gatewayDenial',v_refresh_denial_hash
    );
    update public.openclaw_retention_delete_tickets ticket set
      ticket_jti=v_new_ticket_jti,delete_authorization_jti=v_new_authorization_jti,
      claim_token_hash=v_token,signing_key_generation=v_ticket_signing,
      receipt_signing_key_generation=v_receipt_signing,domain_hash=v_domain_hash,
      ticket_payload=v_ticket_payload,ticket_bytes=v_ticket_bytes,ticket_hash=v_ticket_hash,
      expected_receipt_claims=v_claims,authorization_payload=v_payload,
      authorization_bytes=v_bytes,authorization_hash=v_authorization_hash,
      issued_at=v_issued,expires_at=v_ticket_expires,authorized_at=v_issued,
      authorization_expires_at=v_expires
    where ticket.organization_id=v_org and ticket.id=v_ticket.id
      and ticket.state='DELETE_AUTHORIZED'
      and ticket.ticket_jti=v_old_lineage.ticket_jti
      and ticket.delete_authorization_jti=v_old_lineage.delete_authorization_jti;
    if not found then raise exception 'retention recovery refresh pointer CAS failed'
      using errcode='40001'; end if;
    return jsonb_build_object('version',1,'ticketId',v_ticket.id,'ticketHash',v_ticket_hash,
      'deleteAuthorizationJti',v_new_authorization_jti,'expiresAt',v_expires,
      'state','RECOVERY_REFRESHED','replacesTicketJti',v_old_lineage.ticket_jti,
      'replacesDeleteAuthorizationJti',v_old_lineage.delete_authorization_jti,
      'ticket',v_ticket_payload,'authorization',v_payload);
  end if;
  select ticket.* into v_ticket
  from public.openclaw_retention_delete_tickets ticket
  where ticket.organization_id=v_org
    and ticket.work_item_id=(p_request->>'workItemId')::uuid
    and ticket.claim_generation=(p_request->>'claimGeneration')::bigint
  for update;
  if not found then
    raise exception 'retention delete ticket must be issued before authorization' using errcode='40001';
  end if;
  if v_ticket.maintenance_principal_id<>v_maintenance
    or v_ticket.credential_generation<>(p_principal->>'credentialGeneration')::bigint
    or v_ticket.maintenance_lease_generation<>(p_principal->>'leaseGeneration')::bigint
    or v_ticket.fencing_token<>(p_principal->>'fencingToken')::bigint
    or v_ticket.claim_token_hash<>v_token or v_ticket.state='REVOKED' then
    raise exception 'retention authorization ticket binding mismatch' using errcode='42501';
  end if;
  if v_ticket.state in ('DELETE_AUTHORIZED','FINALIZED') then
    return jsonb_build_object('version',1,'ticketId',v_ticket.id,
      'ticketHash',v_ticket.ticket_hash,
      'deleteAuthorizationJti',v_ticket.delete_authorization_jti,
      'expiresAt',v_ticket.authorization_expires_at,'state','DELETE_AUTHORIZED',
      'authorization',v_ticket.authorization_payload);
  end if;
  if v_ticket.state<>'TICKET_ISSUED' or v_ticket.expires_at<=v_issued then
    raise exception 'retention delete ticket is not authorizable' using errcode='40001';
  end if;
  select work.* into v_work from public.openclaw_maintenance_work_items work
  join public.openclaw_maintenance_credentials credential
    on credential.organization_id=work.organization_id
   and credential.maintenance_principal_id=work.maintenance_principal_id
   and credential.credential_generation=work.credential_generation and credential.revoked_at is null
  join public.openclaw_maintenance_leases lease
    on lease.organization_id=work.organization_id
   and lease.maintenance_principal_id=work.maintenance_principal_id
   and lease.lease_generation=work.maintenance_lease_generation
   and lease.fencing_token=work.fencing_token and lease.status='ACTIVE'
  where work.organization_id=v_org and work.maintenance_principal_id=v_maintenance
    and work.id=(p_request->>'workItemId')::uuid and work.work_kind='RETENTION_DELETE'
    and work.work_phase='FINAL_DELETE' and work.state='LEASED'
    and work.claim_generation=(p_request->>'claimGeneration')::bigint
    and work.claim_token_hash=v_token
    and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
    and work.maintenance_lease_generation=(p_principal->>'leaseGeneration')::bigint
    and work.fencing_token=(p_principal->>'fencingToken')::bigint
    and work.lease_expires_at>v_issued and lease.expires_at>v_issued
  for update of work;
  if not found then raise exception 'retention delete authorization binding CAS failed' using errcode='40001'; end if;
  perform app_private.openclaw_lock_retention_tombstone_v1(v_org,v_work.source_id);
  select tombstone.* into v_tomb from public.openclaw_retention_tombstones tombstone
  where tombstone.organization_id=v_org and tombstone.id=v_work.source_id
    and tombstone.id=v_ticket.tombstone_id
    and tombstone.subject_kind='MEDIA'
    and tombstone.subject_id=(v_work.payload->>'subjectId')::uuid
    and tombstone.quarantine_version=(v_work.payload->>'quarantineVersion')::bigint
    and tombstone.final_delete_not_before<=v_issued
    and tombstone.object_key is not null;
  if not found then raise exception 'final_delete_not_before or tombstone CAS failed' using errcode='40001'; end if;
  perform scope.id from public.openclaw_retention_hold_scopes scope
  where scope.organization_id=v_org and (scope.scope_kind='ORGANIZATION'
    or (scope.scope_kind='MEDIA' and scope.scope_id=v_tomb.subject_id))
  order by scope.scope_kind,scope.scope_id,scope.id for share;
  if app_private.openclaw_retention_subject_held_v1(v_org,'MEDIA',v_tomb.subject_id) then
    raise exception 'active descendant legal hold blocks retention delete' using errcode='42501';
  end if;
  select coalesce(clock.hold_version,0) into v_hold_version
  from (select 1) singleton left join public.openclaw_retention_hold_clocks clock
    on clock.organization_id=v_org;
  if v_hold_version<>v_ticket.hold_version then
    raise exception 'hold_version changed before retention authorization' using errcode='40001';
  end if;
  perform app_private.openclaw_lock_retention_gateway_config_v1(v_org);
  select config.ticket_key_generation,config.signing_key_generation,config.public_key_hash
    into v_ticket_signing,v_receipt_signing,v_gateway_key_hash
  from public.openclaw_retention_gateway_configs config
  where config.organization_id=v_org and config.is_active and config.retired_at is null;
  if not found or v_ticket_signing<>v_ticket.signing_key_generation then
    raise exception 'active retention gateway signing generation mismatch' using errcode='42501';
  end if;
  v_expires:=least(v_issued+interval '5 seconds',v_work.lease_expires_at);
  if v_expires<=v_issued then
    raise exception 'retention authorization lease expired' using errcode='40001';
  end if;
  v_claims := jsonb_build_object('version',1,'receiptKind','RETENTION_FINAL_DELETE',
    'organizationId',v_org,'maintenancePrincipalId',v_maintenance,'workItemId',v_work.id,
    'claimGeneration',v_work.claim_generation,'credentialGeneration',v_work.credential_generation,
    'leaseGeneration',v_work.maintenance_lease_generation,'fencingToken',v_work.fencing_token,
    'objectKey',v_tomb.object_key,'deletePhase','FINAL_DELETE','holdVersion',v_hold_version,
    'quarantineVersion',v_tomb.quarantine_version,'deleteTicketJti',v_ticket.ticket_jti,
    'deleteAuthorizationJti',v_ticket.delete_authorization_jti,
    'proofJti',v_ticket.delete_authorization_jti,
    'gatewaySigningKeyGeneration',v_receipt_signing);
  v_payload := jsonb_build_object('version',1,'authorizationKind','RETENTION_FINAL_DELETE',
    'organizationId',v_org,'maintenancePrincipalId',v_maintenance,'workItemId',v_work.id,
    'claimGeneration',v_work.claim_generation,'credentialGeneration',v_work.credential_generation,
    'leaseGeneration',v_work.maintenance_lease_generation,'fencingToken',v_work.fencing_token,
    'objectKey',v_tomb.object_key,'deletePhase','FINAL_DELETE','holdVersion',v_hold_version,
    'quarantineVersion',v_tomb.quarantine_version,'deleteTicketJti',v_ticket.ticket_jti,
    'authorizationJti',v_ticket.delete_authorization_jti,
    'iat',to_char(v_issued at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'exp',to_char(v_expires at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'gatewaySigningKeyGeneration',v_ticket_signing);
  v_bytes := app_private.openclaw_jcs_bytes_v1(v_payload);
  v_authorization_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-retention-authorization-v1','UTF8')||decode('00','hex')
      ||v_bytes,'sha256'),'hex');
  update public.openclaw_retention_delete_tickets ticket
  set state='DELETE_AUTHORIZED',authorization_payload=v_payload,authorization_bytes=v_bytes,
    authorization_hash=v_authorization_hash,expected_receipt_claims=v_claims,
    receipt_signing_key_generation=v_receipt_signing,authorized_at=v_issued,
    authorization_expires_at=v_expires
  where ticket.organization_id=v_org and ticket.id=v_ticket.id and ticket.state='TICKET_ISSUED';
  if not found then raise exception 'DELETE_AUTHORIZED ticket transition CAS failed' using errcode='40001'; end if;
  insert into public.openclaw_retention_delete_ticket_lineage(
    organization_id,logical_ticket_id,maintenance_principal_id,work_item_id,tombstone_id,
    subject_id,object_key,sha256,content_type,content_length,ticket_jti,
    delete_authorization_jti,claim_generation,credential_generation,
    maintenance_lease_generation,fencing_token,authorization_claim_token_hash,
    authorization_maintenance_principal_id,authorization_credential_generation,
    authorization_lease_generation,authorization_fencing_token,recovery_generation,
    hold_version,quarantine_version,ticket_signing_key_generation,
    receipt_signing_key_generation,gateway_public_key_hash,domain_hash,ticket_payload,
    ticket_bytes,ticket_hash,expected_receipt_claims,authorization_payload,
    authorization_bytes,authorization_hash,issued_at,expires_at,authorized_at,
    authorization_expires_at
  ) values (
    v_org,v_ticket.id,v_ticket.maintenance_principal_id,v_ticket.work_item_id,
    v_ticket.tombstone_id,v_ticket.subject_id,v_ticket.object_key,
    v_ticket.ticket_payload->>'sha256',v_ticket.ticket_payload->>'contentType',
    (v_ticket.ticket_payload->>'contentLength')::bigint,v_ticket.ticket_jti,
    v_ticket.delete_authorization_jti,v_ticket.claim_generation,v_ticket.credential_generation,
    v_ticket.maintenance_lease_generation,v_ticket.fencing_token,v_token,v_maintenance,
    (p_principal->>'credentialGeneration')::bigint,(p_principal->>'leaseGeneration')::bigint,
    (p_principal->>'fencingToken')::bigint,1,v_ticket.hold_version,
    v_ticket.quarantine_version,v_ticket.signing_key_generation,v_receipt_signing,
    v_gateway_key_hash,v_ticket.domain_hash,v_ticket.ticket_payload,v_ticket.ticket_bytes,
    v_ticket.ticket_hash,v_claims,v_payload,v_bytes,v_authorization_hash,
    v_ticket.issued_at,v_ticket.expires_at,v_issued,v_expires
  );
  update public.openclaw_maintenance_work_items work set state='DELETE_AUTHORIZED',
    claim_token_hash=null,lease_expires_at=null,retry_not_before=null,
    recovery_maintenance_principal_id=work.maintenance_principal_id,
    recovery_credential_generation=work.credential_generation,
    recovery_lease_generation=work.maintenance_lease_generation,
    recovery_fencing_token=work.fencing_token,recovery_generation=1,
    recovery_lease_expires_at=v_expires,updated_at=statement_timestamp()
  where work.organization_id=v_org and work.id=v_work.id and work.state='LEASED'
    and work.claim_generation=v_work.claim_generation;
  if not found then raise exception 'DELETE_AUTHORIZED work transition CAS failed' using errcode='40001'; end if;
  return jsonb_build_object('version',1,'ticketId',v_ticket.id,'authorization',v_payload,
    'ticketHash',v_ticket.ticket_hash,'deleteAuthorizationJti',v_ticket.delete_authorization_jti,
    'expiresAt',v_expires,'state','DELETE_AUTHORIZED');
end;
$function$;

create or replace function app_private.openclaw_finalize_retention_delete_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal->>'organizationId')::uuid;
  v_ticket public.openclaw_retention_delete_tickets%rowtype;
  v_receipt jsonb := p_request->'gatewayReceipt';
  v_hash text;
  v_outcome text;
  v_attempt integer;
  v_work public.openclaw_maintenance_work_items%rowtype;
  v_lineage public.openclaw_retention_delete_ticket_lineage%rowtype;
  v_token text;
  v_recovery boolean := p_request->>'recoveryKind'='RETENTION_DELETE_AUTHORIZED';
begin
  if v_recovery then
    perform app_private.openclaw_assert_strict_object_v1(
      p_request,
      array['version','recoveryKind','workItemId','recoveryGeneration','claimToken',
        'ticketId','gatewayReceipt'],
      array['version','recoveryKind','workItemId','recoveryGeneration','claimToken',
        'ticketId','gatewayReceipt']
    );
  else
    perform app_private.openclaw_assert_strict_object_v1(
      p_request,
      array['version','ticketId','gatewayReceipt'],
      array['version','ticketId','gatewayReceipt']
    );
  end if;
  perform app_private.openclaw_assert_strict_object_v1(
    v_receipt,
    array['version','receiptKind','receiptId','organizationId','maintenancePrincipalId',
      'workItemId','claimGeneration','credentialGeneration','leaseGeneration','fencingToken',
      'objectKey','deletePhase','holdVersion','quarantineVersion','deleteTicketJti',
      'deleteAuthorizationJti','proofJti','objectStatus','r2VersionOrEtag','completedAt',
      'gatewaySigningKeyGeneration','signature'],
    array['version','receiptKind','receiptId','organizationId','maintenancePrincipalId',
      'workItemId','claimGeneration','credentialGeneration','leaseGeneration','fencingToken',
      'objectKey','deletePhase','holdVersion','quarantineVersion','deleteTicketJti',
      'deleteAuthorizationJti','proofJti','objectStatus','r2VersionOrEtag','completedAt',
      'gatewaySigningKeyGeneration','signature']
  );
  if p_request->>'version'<>'1' or jsonb_typeof(v_receipt)<>'object' then
    raise exception 'retention finalize version or receipt invalid' using errcode='22023';
  end if;
  v_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-retention-receipt-v1','UTF8')||decode('00','hex')
      ||app_private.openclaw_jcs_bytes_v1(v_receipt),
    'sha256'),'hex');
  v_outcome := v_receipt->>'objectStatus';
  select ticket.* into v_ticket from public.openclaw_retention_delete_tickets ticket
  where ticket.organization_id=v_org and ticket.id=(p_request->>'ticketId')::uuid
  for update;
  if not found then raise exception 'retention delete ticket not found' using errcode='40001'; end if;
  if v_ticket.state='FINALIZED' then
    if v_ticket.receipt is distinct from v_receipt
       or v_ticket.receipt_hash is distinct from v_hash
       or v_ticket.gateway_outcome is distinct from v_outcome then
      raise exception 'finalized retention ticket replay mismatch' using errcode='40001';
    end if;
    return jsonb_build_object('version',1,'ticketId',v_ticket.id,
      'gatewayOutcome',v_ticket.gateway_outcome,'receiptHash',v_ticket.receipt_hash,
      'finalized',true,'idempotentReplay',true);
  end if;
  select lineage.* into v_lineage
  from public.openclaw_retention_delete_ticket_lineage lineage
  where lineage.organization_id=v_org and lineage.logical_ticket_id=v_ticket.id
    and lineage.ticket_jti=(v_receipt->>'deleteTicketJti')::uuid
    and lineage.delete_authorization_jti=(v_receipt->>'deleteAuthorizationJti')::uuid
  for update;
  if not found or v_lineage.receipt is not null then
    raise exception 'retention receipt ticket/proof lineage is unknown or terminal'
      using errcode='42501';
  end if;
  if v_recovery then
    v_token:=encode(extensions.digest(convert_to('ihome-openclaw-work-claim-v1','UTF8')
      ||decode('00','hex')||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');
    select work.* into v_work from public.openclaw_maintenance_work_items work
    where work.organization_id=v_org and work.id=v_ticket.work_item_id
      and work.id=(p_request->>'workItemId')::uuid and work.state='DELETE_AUTHORIZED'
      and work.recovery_maintenance_principal_id=(p_principal->>'maintenancePrincipalId')::uuid
      and work.recovery_credential_generation=(p_principal->>'credentialGeneration')::bigint
      and work.recovery_lease_generation=(p_principal->>'leaseGeneration')::bigint
      and work.recovery_fencing_token=(p_principal->>'fencingToken')::bigint
      and work.recovery_generation=(p_request->>'recoveryGeneration')::bigint
      and work.claim_token_hash=v_token
      and work.recovery_lease_expires_at>statement_timestamp()
    for update;
    if not found then raise exception 'retention recovery ownership CAS failed' using errcode='40001'; end if;
  elsif v_lineage.maintenance_principal_id<>(p_principal->>'maintenancePrincipalId')::uuid
    or v_lineage.credential_generation<>(p_principal->>'credentialGeneration')::bigint
    or v_lineage.maintenance_lease_generation<>(p_principal->>'leaseGeneration')::bigint
    or v_lineage.fencing_token<>(p_principal->>'fencingToken')::bigint then
      raise exception 'maintenance principal binding mismatch for retention receipt'
        using errcode='42501';
  end if;
  if v_ticket.state<>'DELETE_AUTHORIZED'
    or v_receipt->>'version' is distinct from '1'
    or v_receipt->>'receiptKind' is distinct from 'RETENTION_FINAL_DELETE'
    or coalesce(v_receipt->>'receiptId','') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or v_receipt->>'organizationId' is distinct from v_lineage.organization_id::text
    or v_receipt->>'maintenancePrincipalId' is distinct from v_lineage.maintenance_principal_id::text
    or v_receipt->>'workItemId' is distinct from v_lineage.work_item_id::text
    or (v_receipt->>'claimGeneration')::bigint is distinct from v_lineage.claim_generation
    or (v_receipt->>'credentialGeneration')::bigint is distinct from v_lineage.credential_generation
    or (v_receipt->>'leaseGeneration')::bigint is distinct from v_lineage.maintenance_lease_generation
    or (v_receipt->>'fencingToken')::bigint is distinct from v_lineage.fencing_token
    or v_receipt->>'deletePhase' is distinct from 'FINAL_DELETE'
    or v_receipt->>'deleteTicketJti' is distinct from v_lineage.ticket_jti::text
    or v_receipt->>'deleteAuthorizationJti' is distinct from v_lineage.delete_authorization_jti::text
    or v_receipt->>'proofJti' is distinct from v_lineage.delete_authorization_jti::text
    or v_receipt->>'objectKey' is distinct from v_lineage.object_key
    or (v_receipt->>'holdVersion')::bigint is distinct from v_lineage.hold_version
    or (v_receipt->>'quarantineVersion')::bigint is distinct from v_lineage.quarantine_version
    or (v_receipt->>'gatewaySigningKeyGeneration')::bigint is distinct from v_lineage.receipt_signing_key_generation
    or coalesce(v_receipt->>'completedAt','') !~ '^\d{4}-\d{2}-\d{2}T'
    or coalesce(v_receipt->>'signature','') !~ '^[A-Za-z0-9_-]{86}$'
    or v_outcome not in ('DELETED','NOT_FOUND')
    or (v_outcome='DELETED' and nullif(v_receipt->>'r2VersionOrEtag','') is null)
    or (v_outcome='NOT_FOUND' and v_receipt->'r2VersionOrEtag' is distinct from 'null'::jsonb)
    or exists (
      select 1 from pg_catalog.jsonb_each(v_lineage.expected_receipt_claims) expected(key,value)
      where v_receipt -> (expected.key) is distinct from expected.value
    )
  then
    raise exception 'gateway receipt claims do not exactly match authorized delete ticket'
      using errcode='42501';
  end if;
  select work.attempt_count into v_attempt
  from public.openclaw_maintenance_work_items work
  where work.organization_id=v_org
    and work.maintenance_principal_id=v_lineage.maintenance_principal_id
    and work.id=v_lineage.work_item_id and work.work_kind='RETENTION_DELETE'
    and work.work_phase='FINAL_DELETE' and work.state='DELETE_AUTHORIZED'
    and work.claim_generation=v_lineage.claim_generation
    and work.credential_generation=v_lineage.credential_generation
    and work.maintenance_lease_generation=v_lineage.maintenance_lease_generation
    and work.fencing_token=v_lineage.fencing_token
    and work.source_id=v_lineage.tombstone_id for update;
  if not found then raise exception 'authorized retention work CAS failed' using errcode='40001'; end if;
  update public.openclaw_message_media media set byte_state='DELETED',
    retention_delete_not_before=null,updated_at=statement_timestamp()
  from public.openclaw_retention_tombstones tombstone
  where tombstone.organization_id=v_org and tombstone.id=v_lineage.tombstone_id
    and media.organization_id=tombstone.organization_id and media.id=tombstone.subject_id
    and tombstone.object_key=v_lineage.object_key
    and tombstone.quarantine_version=v_lineage.quarantine_version
    and media.object_key is null and media.byte_state='QUARANTINED';
  if not found then
    raise exception 'media final delete CAS failed' using errcode='40001';
  end if;
  update public.openclaw_retention_delete_tickets ticket set state='FINALIZED',
    receipt=v_receipt,receipt_hash=v_hash,gateway_outcome=v_outcome,
    finalized_at=statement_timestamp()
  where ticket.organization_id=v_org and ticket.id=v_ticket.id
    and ticket.state='DELETE_AUTHORIZED';
  if not found then raise exception 'retention ticket finalization CAS failed' using errcode='40001'; end if;
  update public.openclaw_retention_delete_ticket_lineage lineage set
    receipt=v_receipt,receipt_hash=v_hash,gateway_outcome=v_outcome,
    finalized_at=statement_timestamp()
  where lineage.organization_id=v_org and lineage.id=v_lineage.id and lineage.receipt is null;
  if not found then raise exception 'retention lineage finalization CAS failed'
    using errcode='40001'; end if;
  insert into public.openclaw_maintenance_work_attempts(
    organization_id,maintenance_principal_id,work_item_id,claim_generation,
    maintenance_lease_generation,fencing_token,credential_generation,attempt_number,outcome,
    gateway_receipt,receipt_hash,evidence,evidence_hash
  ) values (
    v_org,v_lineage.maintenance_principal_id,v_lineage.work_item_id,v_lineage.claim_generation,
    v_lineage.maintenance_lease_generation,v_lineage.fencing_token,v_lineage.credential_generation,
    v_attempt,'COMPLETE',
    v_receipt,v_hash,jsonb_build_object('ticketId',v_ticket.id,
      'deleteTicketJti',v_lineage.ticket_jti,
      'deleteAuthorizationJti',v_lineage.delete_authorization_jti,
      'gatewayOutcome',v_outcome),v_hash
  );
  update public.openclaw_maintenance_work_items work set state='COMPLETE',
    claim_token_hash=null,lease_expires_at=null,
    terminal_at=statement_timestamp(),updated_at=statement_timestamp()
  where work.organization_id=v_org and work.id=v_lineage.work_item_id
    and work.state='DELETE_AUTHORIZED';
  return jsonb_build_object('version',1,'ticketId',v_ticket.id,
    'gatewayOutcome',v_outcome,'receiptHash',v_hash,'finalized',true,'idempotentReplay',false);
end;
$function$;

create table public.openclaw_audit_signing_configs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  signing_key_generation bigint not null check (signing_key_generation>0),
  public_key_hash text not null check (public_key_hash ~ '^[0-9a-f]{64}$'),
  is_active boolean not null default false,
  enabled_at timestamptz,
  retired_at timestamptz,
  unique (organization_id,id),
  unique (organization_id,signing_key_generation),
  check ((is_active and enabled_at is not null and retired_at is null) or not is_active)
);

create unique index openclaw_audit_signing_one_active_uidx
  on public.openclaw_audit_signing_configs(organization_id) where is_active;

create or replace function app_private.openclaw_audit_merkle_root_v1(
  p_sequences bigint[], p_event_hashes text[]
)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $function$
declare
  v_level bytea[] := array[]::bytea[];
  v_next bytea[];
  v_index integer;
  v_length integer := coalesce(array_length(p_sequences,1),0);
begin
  if v_length=0 or v_length<>coalesce(array_length(p_event_hashes,1),0) then
    raise exception 'audit Merkle inputs are invalid' using errcode='22023';
  end if;
  for v_index in 1..v_length loop
    if p_sequences[v_index] not between 1 and 9007199254740991
       or p_event_hashes[v_index] !~ '^[0-9a-f]{64}$' then
      raise exception 'audit Merkle leaf is invalid' using errcode='22023';
    end if;
    v_level:=array_append(v_level,extensions.digest(
      convert_to('ihome-openclaw-audit-merkle-leaf-v1','UTF8')||decode('00','hex')
        ||convert_to(p_sequences[v_index]::text,'UTF8')||decode('00','hex')
        ||decode(p_event_hashes[v_index],'hex'),'sha256'
    ));
  end loop;
  while array_length(v_level,1)>1 loop
    v_next:=array[]::bytea[];
    v_index:=1;
    while v_index<=array_length(v_level,1) loop
      v_next:=array_append(v_next,extensions.digest(
        convert_to('ihome-openclaw-audit-merkle-node-v1','UTF8')||decode('00','hex')
          ||v_level[v_index]
          ||coalesce(v_level[v_index+1],v_level[v_index]),'sha256'
      ));
      v_index:=v_index+2;
    end loop;
    v_level:=v_next;
  end loop;
  return encode(v_level[1],'hex');
end;
$function$;

create or replace function app_private.openclaw_audit_lineage_root_v1(
  p_organization_id uuid,p_root_date date,p_first_sequence bigint,p_last_sequence bigint,
  p_event_count bigint,p_previous_root_hash text,p_merkle_root_hash text
)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $function$
declare v_lineage jsonb;
begin
  if p_first_sequence not between 1 and 9007199254740991
     or p_last_sequence not between p_first_sequence and 9007199254740991
     or p_event_count<>p_last_sequence-p_first_sequence+1
     or p_previous_root_hash is not null and p_previous_root_hash !~ '^[0-9a-f]{64}$'
     or p_merkle_root_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'audit lineage inputs are invalid' using errcode='22023';
  end if;
  v_lineage:=jsonb_build_object(
    'version',1,'organizationId',p_organization_id,'rootDate',p_root_date,
    'firstSequence',p_first_sequence,'lastSequence',p_last_sequence,
    'eventCount',p_event_count,'previousRootHash',p_previous_root_hash,
    'merkleRootHash',p_merkle_root_hash
  );
  return encode(extensions.digest(
    convert_to('ihome-openclaw-audit-lineage-root-v1','UTF8')||decode('00','hex')
      ||app_private.openclaw_jcs_bytes_v1(v_lineage),'sha256'),'hex');
end;
$function$;

create or replace function app_private.materialize_openclaw_audit_root_v1(
  p_limit integer default 31
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  day record;
  binding record;
  v_root uuid;
  v_payload jsonb;
  v_bytes bytea;
  v_hash text;
  v_previous_root_hash text;
  v_merkle_root_hash text;
  v_root_hash text;
  v_inserted integer;
  v_created integer := 0;
begin
  for day in
    select event.organization_id,(event.occurred_at at time zone 'UTC')::date root_date,
      min(event.organization_sequence) first_sequence,
      max(event.organization_sequence) last_sequence,count(*) event_count,
      array_agg(event.organization_sequence order by event.organization_sequence) sequences,
      array_agg(event.event_hash order by event.organization_sequence) event_hashes,
      config.signing_key_generation,config.public_key_hash audit_signing_public_key_hash
    from public.openclaw_audit_events event
    join public.openclaw_audit_signing_configs config
      on config.organization_id=event.organization_id and config.is_active
     and config.retired_at is null
    where (event.occurred_at at time zone 'UTC')::date
      < (statement_timestamp() at time zone 'UTC')::date
      and not exists (select 1 from public.openclaw_audit_roots root
        where root.organization_id=event.organization_id
          and root.root_date=(event.occurred_at at time zone 'UTC')::date)
      and not exists (
        select 1 from public.openclaw_audit_events earlier
        where earlier.organization_id=event.organization_id
          and (earlier.occurred_at at time zone 'UTC')::date
            < (event.occurred_at at time zone 'UTC')::date
          and (earlier.occurred_at at time zone 'UTC')::date
            < (statement_timestamp() at time zone 'UTC')::date
          and not exists (
            select 1 from public.openclaw_audit_roots earlier_root
            where earlier_root.organization_id=earlier.organization_id
              and earlier_root.root_date=(earlier.occurred_at at time zone 'UTC')::date
          )
      )
    group by event.organization_id,(event.occurred_at at time zone 'UTC')::date,
      config.signing_key_generation,config.public_key_hash
    order by root_date,event.organization_id
    limit greatest(1,least(coalesce(p_limit,31),366))
  loop
    perform pg_advisory_xact_lock(hashtextextended(day.organization_id::text,0));
    if exists (select 1 from public.openclaw_audit_roots root
      where root.organization_id=day.organization_id and root.root_date=day.root_date) then
      continue;
    end if;
    select root.root_hash into v_previous_root_hash
    from public.openclaw_audit_roots root
    where root.organization_id=day.organization_id and root.root_date<day.root_date
    order by root.root_date desc limit 1;
    v_merkle_root_hash:=app_private.openclaw_audit_merkle_root_v1(
      day.sequences,day.event_hashes
    );
    v_root_hash:=app_private.openclaw_audit_lineage_root_v1(
      day.organization_id,day.root_date,day.first_sequence,day.last_sequence,
      day.event_count,v_previous_root_hash,v_merkle_root_hash
    );
    select principal.id maintenance_principal_id,credential.credential_generation,
      lease.lease_generation,lease.fencing_token
    into binding
    from public.openclaw_maintenance_principals principal
    join public.openclaw_maintenance_credentials credential
      on credential.organization_id=principal.organization_id
     and credential.maintenance_principal_id=principal.id and credential.revoked_at is null
    join public.openclaw_maintenance_leases lease
      on lease.organization_id=principal.organization_id
     and lease.maintenance_principal_id=principal.id
     and lease.status='ACTIVE' and lease.expires_at>statement_timestamp()
    where principal.organization_id=day.organization_id
      and principal.is_current and principal.revoked_at is null
    order by lease.lease_generation desc,credential.credential_generation desc limit 1;
    if binding.maintenance_principal_id is null then continue; end if;
    v_root:=gen_random_uuid();
    insert into public.openclaw_audit_roots(
      id,organization_id,root_date,first_sequence,last_sequence,previous_root_hash,
      merkle_root_hash,root_hash,event_count,signing_key_generation,r2_anchor_key
    ) values (
      v_root,day.organization_id,day.root_date,day.first_sequence,day.last_sequence,
      v_previous_root_hash,v_merkle_root_hash,v_root_hash,day.event_count,day.signing_key_generation,
      'v1/org/'||day.organization_id||'/audit/'||day.root_date||'/'||v_root||'.json'
    ) on conflict (organization_id,root_date) do nothing returning id into v_root;
    if v_root is null then continue; end if;
    v_payload := jsonb_build_object(
      'kind','AUDIT_ANCHOR','auditRootId',v_root,
      'rootDate',day.root_date,'firstSequence',day.first_sequence,
      'lastSequence',day.last_sequence,'eventCount',day.event_count,
      'previousRootHash',v_previous_root_hash,'merkleRootHash',v_merkle_root_hash,
      'rootHash',v_root_hash,
      'auditSigningKeyGeneration',day.signing_key_generation,
      'auditSigningPublicKeyHash',day.audit_signing_public_key_hash,
      'anchorKey','v1/org/'||day.organization_id||'/audit/'||day.root_date||'/'||v_root||'.json'
    );
    v_bytes := app_private.openclaw_jcs_bytes_v1(v_payload);
    v_hash := encode(extensions.digest(v_bytes,'sha256'),'hex');
    insert into public.openclaw_maintenance_work_items(
      organization_id,maintenance_principal_id,work_kind,work_phase,source_id,
      source_version,source_key,source_hash,payload,payload_hash,state,claim_generation,
      maintenance_lease_generation,fencing_token,credential_generation
    ) values (
      day.organization_id,binding.maintenance_principal_id,'AUDIT_ANCHOR','ANCHOR',v_root,
      day.signing_key_generation::text,'audit:'||v_root||':'||day.signing_key_generation,
      v_hash,v_payload,v_hash,'QUEUED',1,binding.lease_generation,
      binding.fencing_token,binding.credential_generation
    ) on conflict (organization_id,source_key) where source_key is not null do nothing;
    get diagnostics v_inserted=row_count;
    v_created:=v_created+v_inserted;
  end loop;
  return v_created;
end;
$function$;

create or replace function app_private.openclaw_ack_audit_anchor_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal->>'organizationId')::uuid;
  v_maintenance uuid := (p_principal->>'maintenancePrincipalId')::uuid;
  v_work public.openclaw_maintenance_work_items%rowtype;
  v_root public.openclaw_audit_roots%rowtype;
  v_ticket public.openclaw_audit_gateway_tickets%rowtype;
  v_receipt jsonb := p_request->'gatewayReceipt';
  v_receipt_hash text;
  v_token text;
  v_attempt integer;
  v_recovery boolean := p_request->>'recoveryKind'='AUDIT_VERIFY_AUTHORIZED';
begin
  if v_recovery then
    perform app_private.openclaw_assert_strict_object_v1(
      p_request,
      array['version','recoveryKind','workItemId','recoveryGeneration','claimToken',
        'verifyTicketJti','gatewayReceipt'],
      array['version','recoveryKind','workItemId','recoveryGeneration','claimToken',
        'verifyTicketJti','gatewayReceipt']
    );
  else
    perform app_private.openclaw_assert_strict_object_v1(
      p_request,
      array['version','workItemId','claimGeneration','claimToken','verifyTicketJti','gatewayReceipt'],
      array['version','workItemId','claimGeneration','claimToken','verifyTicketJti','gatewayReceipt']
    );
  end if;
  perform app_private.openclaw_assert_strict_object_v1(
    v_receipt,
    array['version','receiptKind','receiptId','organizationId','maintenancePrincipalId',
      'workItemId','claimGeneration','credentialGeneration','leaseGeneration','fencingToken',
      'auditRootId','rootHash','anchorKey','signatureHash','auditSigningKeyGeneration',
      'verifyTicketJti','objectVersionOrEtag','verifiedAt','gatewaySigningKeyGeneration','signature'],
    array['version','receiptKind','receiptId','organizationId','maintenancePrincipalId',
      'workItemId','claimGeneration','credentialGeneration','leaseGeneration','fencingToken',
      'auditRootId','rootHash','anchorKey','signatureHash','auditSigningKeyGeneration',
      'verifyTicketJti','objectVersionOrEtag','verifiedAt','gatewaySigningKeyGeneration','signature']
  );
  if p_request->>'version'<>'1' or jsonb_typeof(v_receipt)<>'object'
     or nullif(p_request->>'verifyTicketJti','') is null then
    raise exception 'audit anchor acknowledgement is invalid' using errcode='22023';
  end if;
  v_token:=encode(extensions.digest(convert_to('ihome-openclaw-work-claim-v1','UTF8')
    ||decode('00','hex')||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');
  v_receipt_hash:=encode(extensions.digest(
    convert_to('ihome-openclaw-audit-receipt-v1','UTF8')||decode('00','hex')
      ||app_private.openclaw_jcs_bytes_v1(v_receipt),
    'sha256'),'hex');
  select work.* into v_work from public.openclaw_maintenance_work_items work
  where work.organization_id=v_org and work.id=(p_request->>'workItemId')::uuid
    and work.work_kind='AUDIT_ANCHOR' and work.work_phase='ANCHOR'
  for update;
  if found and v_work.state='AUDIT_VERIFY_AUTHORIZED' then
    if v_recovery then
      if v_work.recovery_maintenance_principal_id<>v_maintenance
        or v_work.recovery_credential_generation<>(p_principal->>'credentialGeneration')::bigint
        or v_work.recovery_lease_generation<>(p_principal->>'leaseGeneration')::bigint
        or v_work.recovery_fencing_token<>(p_principal->>'fencingToken')::bigint
        or v_work.recovery_generation<>(p_request->>'recoveryGeneration')::bigint
        or v_work.claim_token_hash<>v_token
        or v_work.recovery_lease_expires_at<=statement_timestamp() then
        raise exception 'audit recovery ownership CAS failed' using errcode='40001';
      end if;
    elsif v_work.maintenance_principal_id<>v_maintenance
      or v_work.credential_generation<>(p_principal->>'credentialGeneration')::bigint
      or v_work.maintenance_lease_generation<>(p_principal->>'leaseGeneration')::bigint
      or v_work.fencing_token<>(p_principal->>'fencingToken')::bigint
      or v_work.claim_generation<>(p_request->>'claimGeneration')::bigint
      or v_work.claim_token_hash<>v_token or v_work.lease_expires_at<=statement_timestamp() then
      raise exception 'audit original ownership CAS failed' using errcode='40001';
    end if;
  end if;
  if not found then
    raise exception 'audit work claim binding CAS failed' using errcode='40001';
  end if;
  select ticket.* into v_ticket from public.openclaw_audit_gateway_tickets ticket
  where ticket.organization_id=v_org
    and ticket.ticket_jti=(p_request->>'verifyTicketJti')::uuid
    and ticket.work_item_id=v_work.id and ticket.operation='ANCHOR_VERIFY'
  for update;
  if not found then raise exception 'audit verify ticket lineage is unknown' using errcode='42501'; end if;
  if v_work.state='COMPLETE' then
    select root.* into strict v_root from public.openclaw_audit_roots root
    where root.organization_id=v_org and root.id=v_ticket.audit_root_id;
    if v_root.gateway_receipt is distinct from v_receipt
      or v_root.gateway_receipt_hash is distinct from v_receipt_hash
      or v_ticket.gateway_receipt is distinct from v_receipt then
      raise exception 'audit acknowledgement replay mismatch' using errcode='40001';
    end if;
    return jsonb_build_object('version',1,'auditRootId',v_root.id,
      'gatewayReceiptHash',v_receipt_hash,'idempotentReplay',true);
  end if;
  select root.* into v_root from public.openclaw_audit_roots root
  where root.organization_id=v_org and root.id=(v_work.payload->>'auditRootId')::uuid
    and root.root_date=(v_work.payload->>'rootDate')::date
    and root.first_sequence=(v_work.payload->>'firstSequence')::bigint
    and root.last_sequence=(v_work.payload->>'lastSequence')::bigint
    and root.event_count=(v_work.payload->>'eventCount')::bigint
    and root.previous_root_hash is not distinct from nullif(v_work.payload->>'previousRootHash','')
    and root.merkle_root_hash=v_work.payload->>'merkleRootHash'
    and root.root_hash=v_work.payload->>'rootHash'
    and root.r2_anchor_key=v_work.payload->>'anchorKey'
    and root.signing_key_generation=(v_work.payload->>'auditSigningKeyGeneration')::bigint
    and root.anchored_at is null for update;
  if not found then raise exception 'audit root frozen work mismatch' using errcode='40001'; end if;
  if v_receipt->>'version' is distinct from '1'
     or v_receipt->>'receiptKind' is distinct from 'AUDIT_ANCHOR_VERIFY'
     or coalesce(v_receipt->>'receiptId','') !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or v_receipt->>'organizationId' is distinct from v_org::text
     or v_receipt->>'maintenancePrincipalId' is distinct from v_ticket.maintenance_principal_id::text
     or v_receipt->>'workItemId' is distinct from v_ticket.work_item_id::text
     or (v_receipt->>'claimGeneration')::bigint is distinct from v_ticket.claim_generation
     or (v_receipt->>'credentialGeneration')::bigint is distinct from v_ticket.credential_generation
     or (v_receipt->>'leaseGeneration')::bigint is distinct from v_ticket.maintenance_lease_generation
     or (v_receipt->>'fencingToken')::bigint is distinct from v_ticket.fencing_token
     or v_receipt->>'auditRootId' is distinct from v_root.id::text
     or v_receipt->>'rootHash' is distinct from v_root.root_hash
     or v_receipt->>'anchorKey' is distinct from v_root.r2_anchor_key
     or v_receipt->>'verifyTicketJti' is distinct from p_request->>'verifyTicketJti'
     or (v_receipt->>'auditSigningKeyGeneration')::bigint is distinct from v_ticket.audit_signing_key_generation
     or nullif(v_receipt->>'objectVersionOrEtag','') is null
     or coalesce(v_receipt->>'verifiedAt','') !~ '^\d{4}-\d{2}-\d{2}T'
     or coalesce(v_receipt->>'signatureHash','') !~ '^[0-9a-f]{64}$'
     or v_receipt->>'signatureHash' is distinct from v_ticket.signature_hash
     or coalesce(v_receipt->>'signature','') !~ '^[A-Za-z0-9_-]{86}$'
     or (v_receipt->>'gatewaySigningKeyGeneration')::bigint
       is distinct from v_ticket.receipt_signing_key_generation then
    raise exception 'audit receipt does not match exact work/root claim' using errcode='42501';
  end if;
  update public.openclaw_audit_roots root set signature_hash=v_receipt->>'signatureHash',
    gateway_receipt=v_receipt,gateway_receipt_hash=v_receipt_hash,anchored_at=statement_timestamp()
  where root.organization_id=v_org and root.id=v_root.id and root.anchored_at is null;
  if not found then raise exception 'audit root completion CAS failed' using errcode='40001'; end if;
  update public.openclaw_audit_gateway_tickets ticket set
    gateway_receipt=v_receipt,gateway_receipt_hash=v_receipt_hash,finalized_at=statement_timestamp()
  where ticket.organization_id=v_org and ticket.id=v_ticket.id and ticket.gateway_receipt is null;
  if not found then raise exception 'audit verify ticket finalization CAS failed' using errcode='40001'; end if;
  v_attempt:=v_work.attempt_count;
  insert into public.openclaw_maintenance_work_attempts(
    organization_id,maintenance_principal_id,work_item_id,claim_generation,
    maintenance_lease_generation,fencing_token,credential_generation,attempt_number,outcome,
    gateway_receipt,receipt_hash,evidence,evidence_hash
  ) values (
    v_org,v_work.maintenance_principal_id,v_work.id,v_work.claim_generation,v_work.maintenance_lease_generation,
    v_work.fencing_token,v_work.credential_generation,v_attempt,'COMPLETE',v_receipt,v_receipt_hash,
    jsonb_build_object('auditRootId',v_root.id,'verifyTicketJti',p_request->>'verifyTicketJti',
      'recoveryGeneration',case when v_recovery then v_work.recovery_generation else null end),
    v_receipt_hash
  );
  update public.openclaw_maintenance_work_items work set state='COMPLETE',claim_token_hash=null,
    lease_expires_at=null,terminal_at=statement_timestamp(),updated_at=statement_timestamp()
  where work.organization_id=v_org and work.id=v_work.id and work.state='AUDIT_VERIFY_AUTHORIZED'
    and work.claim_generation=v_work.claim_generation;
  if not found then raise exception 'audit work completion CAS failed' using errcode='40001'; end if;
  return jsonb_build_object('version',1,'auditRootId',v_root.id,
    'gatewayReceiptHash',v_receipt_hash,'idempotentReplay',false);
end;
$function$;

create or replace function app_private.expire_openclaw_qr_challenges_v1()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare v_count integer;
begin
  update public.openclaw_qr_challenges challenge set
    challenge_status='EXPIRED',active_slot=false,ciphertext=null,cipher_iv=null,auth_tag=null,
    material_version=0,material_published_at=null
  where challenge.challenge_status='PENDING' and challenge.expires_at<=statement_timestamp();
  get diagnostics v_count=row_count;
  return v_count;
end;
$function$;

create or replace function app_private.expire_openclaw_runtime_leases_v1()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare v_count integer;
begin
  update public.openclaw_runtime_leases lease set status='EXPIRED',released_at=statement_timestamp()
  where lease.status='ACTIVE' and lease.expires_at<=statement_timestamp();
  get diagnostics v_count=row_count;
  return v_count;
end;
$function$;

create or replace function app_private.expire_openclaw_maintenance_leases_v1()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare v_count integer;
begin
  update public.openclaw_maintenance_leases lease set status='EXPIRED',released_at=statement_timestamp()
  where lease.status='ACTIVE' and lease.expires_at<=statement_timestamp();
  get diagnostics v_count=row_count;
  return v_count;
end;
$function$;

create or replace function app_private.reject_openclaw_unknown_state_rewrite_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if row(NEW.id,NEW.organization_id,NEW.account_id,NEW.target_id,NEW.source_kind,
    NEW.actor_id,NEW.client_operation_id,NEW.inbound_event_id,NEW.automation_version_id,
    NEW.schedule_id,NEW.schedule_version,NEW.subscription_id,NEW.subscription_version,
    NEW.occurrence_id,NEW.campaign_id,NEW.campaign_version,NEW.idempotency_key,
    NEW.canonical_payload,NEW.canonical_payload_bytes,NEW.payload_hash,NEW.created_at)
    is distinct from row(OLD.id,OLD.organization_id,OLD.account_id,OLD.target_id,OLD.source_kind,
    OLD.actor_id,OLD.client_operation_id,OLD.inbound_event_id,OLD.automation_version_id,
    OLD.schedule_id,OLD.schedule_version,OLD.subscription_id,OLD.subscription_version,
    OLD.occurrence_id,OLD.campaign_id,OLD.campaign_version,OLD.idempotency_key,
    OLD.canonical_payload,OLD.canonical_payload_bytes,OLD.payload_hash,OLD.created_at)
  then raise exception 'outbox intent and canonical payload cannot change' using errcode='55000'; end if;
  if OLD.state in ('SENT','FAILED','UNKNOWN','DEAD_LETTER') and NEW.state<>OLD.state then
    raise exception 'terminal outbox state cannot be rewritten' using errcode='55000';
  end if;
  if NEW.state is distinct from OLD.state and not (
    (OLD.state='QUEUED' and NEW.state in ('LEASED','FAILED','DEAD_LETTER'))
    or (OLD.state='LEASED' and NEW.state in ('QUEUED','DISPATCHING','UNKNOWN','FAILED','DEAD_LETTER'))
    or (OLD.state='DISPATCHING' and NEW.state in ('SENT','FAILED','UNKNOWN','DEAD_LETTER'))
  ) then raise exception 'invalid outbox state transition' using errcode='55000'; end if;
  if OLD.state='UNKNOWN'
    and (to_jsonb(NEW)-array['resolution_version','updated_at']::text[])
      is distinct from
        (to_jsonb(OLD)-array['resolution_version','updated_at']::text[]) then
    raise exception 'historical UNKNOWN evidence cannot be rewritten' using errcode='55000';
  end if;
  if OLD.state='UNKNOWN' and NEW.updated_at is distinct from OLD.updated_at
    and not (
      OLD.state='UNKNOWN' and NEW.state='UNKNOWN'
      and OLD.resolution_version=0 and NEW.resolution_version=1
    ) then
    raise exception 'UNKNOWN timestamp may change only with the resolution CAS'
      using errcode='55000';
  end if;
  if NEW.resolution_version is distinct from OLD.resolution_version and not (
    OLD.state='UNKNOWN' and NEW.state='UNKNOWN'
    and OLD.resolution_version=0 and NEW.resolution_version=1
  ) then raise exception 'invalid UNKNOWN resolution transition' using errcode='55000'; end if;
  return NEW;
end;
$function$;

create or replace function app_private.sweep_openclaw_delivery_claims_v1(
  p_organization_id uuid default null,
  p_account_id uuid default null,
  p_maintenance_principal_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  item record;
  v_requeued integer := 0;
  v_unknown integer := 0;
  v_work integer := 0;
  v_dead integer := 0;
  v_reason text;
  v_evidence jsonb;
  v_count integer;
begin
  for item in
    select outbox.*,handoff_match.id authorization_id,
      handoff_match.authorized_handoff_at
    from public.openclaw_outbox outbox
    left join lateral (
      select handoff.id,handoff.authorized_handoff_at
      from public.openclaw_outbound_authorizations handoff
      where handoff.organization_id=outbox.organization_id
        and handoff.account_id=outbox.account_id and handoff.outbox_id=outbox.id
        and handoff.claim_generation=outbox.claim_generation
        and handoff.consumed_at is not null
        and handoff.authorized_handoff_at is not null
      order by handoff.issued_at desc limit 1
    ) handoff_match on true
    where (p_organization_id is null or outbox.organization_id=p_organization_id)
      and (p_account_id is null or outbox.account_id=p_account_id)
      and outbox.state in ('LEASED','DISPATCHING')
      and outbox.lease_expires_at<=statement_timestamp()
    order by outbox.organization_id,outbox.account_id,outbox.id
    for update of outbox skip locked
  loop
    if item.authorization_id is null and item.state='LEASED' then
      v_evidence := jsonb_build_object('version',1,'reason','SWEEPER_LEASE_EXPIRED_PRE_HANDOFF',
        'outboxId',item.id,'claimGeneration',item.claim_generation);
      insert into public.openclaw_delivery_attempts(
        organization_id,account_id,outbox_id,authorization_id,claim_generation,
        attempt_number,outcome,reason_code,total_part_count,possible_handoff_prefix_length,
        known_provider_message_ids,evidence_kind,delivery_evidence,delivery_evidence_hash,
        started_at,finished_at
      ) values (
        item.organization_id,item.account_id,item.id,null,item.claim_generation,
        greatest(item.attempt_count,1),'SAFE_RETRY','SWEEPER_LEASE_EXPIRED_PRE_HANDOFF',
        1,0,'{}','OUTBOX_PRE_HANDOFF',v_evidence,
        encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_evidence),'sha256'),'hex'),
        coalesce(item.updated_at,item.created_at),statement_timestamp()
      ) on conflict (organization_id,account_id,outbox_id,claim_generation,attempt_number) do nothing;
      update public.openclaw_outbox outbox set state='QUEUED',claim_token_hash=null,
        claimed_cell_id=null,lease_expires_at=null,credential_generation=null,
        runtime_lease_generation=null,claim_generation=outbox.claim_generation+1,
        retry_not_before=statement_timestamp(),updated_at=statement_timestamp()
      where outbox.organization_id=item.organization_id and outbox.id=item.id
        and outbox.state='LEASED' and outbox.claim_generation=item.claim_generation;
      v_requeued:=v_requeued+1;
    else
      v_reason := case when item.state='LEASED'
        then 'SWEEPER_LEASE_EXPIRED_AFTER_HANDOFF'
        else 'SWEEPER_DISPATCHING_WITHOUT_AUTHORIZATION' end;
      v_evidence := jsonb_build_object('version',1,'reason',v_reason,'outboxId',item.id,
        'claimGeneration',item.claim_generation,'authorizationId',item.authorization_id);
      insert into public.openclaw_delivery_attempts(
        organization_id,account_id,outbox_id,authorization_id,claim_generation,
        attempt_number,outcome,reason_code,total_part_count,possible_handoff_prefix_length,
        known_provider_message_ids,evidence_kind,delivery_evidence,delivery_evidence_hash,
        started_at,finished_at
      ) values (
        item.organization_id,item.account_id,item.id,item.authorization_id,item.claim_generation,
        greatest(item.attempt_count,1),'UNKNOWN',v_reason,1,0,'{}','OUTBOX_DELIVERY',v_evidence,
        encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_evidence),'sha256'),'hex'),
        coalesce(item.dispatching_at,item.updated_at,item.created_at),statement_timestamp()
      ) on conflict (organization_id,account_id,outbox_id,claim_generation,attempt_number) do nothing;
      update public.openclaw_outbox outbox set state='UNKNOWN',claim_token_hash=null,
        claimed_cell_id=null,lease_expires_at=null,dispatching_at=null,
        credential_generation=null,runtime_lease_generation=null,
        terminal_at=statement_timestamp(),updated_at=statement_timestamp()
      where outbox.organization_id=item.organization_id and outbox.id=item.id
        and outbox.state in ('LEASED','DISPATCHING')
        and outbox.claim_generation=item.claim_generation;
      v_unknown:=v_unknown+1;
    end if;
  end loop;

  with candidates as (
    select work.id,work.organization_id from public.openclaw_send_work_items work
    where (p_organization_id is null or work.organization_id=p_organization_id)
      and (p_account_id is null or work.account_id=p_account_id)
      and work.state='LEASED' and work.lease_expires_at<=statement_timestamp()
    order by work.organization_id,work.account_id,work.id for update skip locked
  ) update public.openclaw_send_work_items work set state='QUEUED',claim_token_hash=null,
    lease_expires_at=null,claim_generation=work.claim_generation+1,
    retry_not_before=statement_timestamp(),updated_at=statement_timestamp()
  from candidates where work.organization_id=candidates.organization_id and work.id=candidates.id;
  get diagnostics v_count=row_count; v_work:=v_work+v_count;
  with candidates as (
    select work.id,work.organization_id from public.openclaw_maintenance_work_items work
    where (p_organization_id is null or work.organization_id=p_organization_id)
      and (p_maintenance_principal_id is null
        or work.maintenance_principal_id=p_maintenance_principal_id)
      and work.state='LEASED' and work.lease_expires_at<=statement_timestamp()
    order by work.organization_id,work.maintenance_principal_id,work.id for update skip locked
  ) update public.openclaw_maintenance_work_items work set state='QUEUED',claim_token_hash=null,
    lease_expires_at=null,claim_generation=work.claim_generation+1,
    retry_not_before=statement_timestamp(),updated_at=statement_timestamp()
  from candidates where work.organization_id=candidates.organization_id and work.id=candidates.id;
  get diagnostics v_count=row_count; v_work:=v_work+v_count;

  for item in select work.* from public.openclaw_send_work_items work
    where (p_organization_id is null or work.organization_id=p_organization_id)
      and (p_account_id is null or work.account_id=p_account_id)
      and work.state='QUEUED' and work.attempt_count>=5
    order by work.organization_id,work.account_id,work.id for update skip locked
  loop
    insert into public.openclaw_dead_letters(
      organization_id,account_id,send_work_item_id,reason_code,payload_hash,evidence
    ) values (item.organization_id,item.account_id,item.id,'WORK_RETRY_EXHAUSTED',
      item.payload_hash,jsonb_build_object('sourceKey',item.source_key,
        'attemptCount',item.attempt_count,'bindingGeneration',item.claim_generation))
    on conflict do nothing;
    update public.openclaw_send_work_items set state='DEAD_LETTER',terminal_at=statement_timestamp(),
      updated_at=statement_timestamp() where organization_id=item.organization_id and id=item.id
      and state='QUEUED';
    v_dead:=v_dead+1;
  end loop;
  return jsonb_build_object('version',1,'outboxRequeued',v_requeued,
    'outboxUnknown',v_unknown,'workReclaimed',v_work,'deadLetters',v_dead,
    'databaseTime',statement_timestamp());
end;
$function$;

create or replace function app_private.openclaw_sweep_runtime_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_request->>'version'<>'1' then
    raise exception 'runtime sweep version mismatch' using errcode='22023';
  end if;
  if p_principal->>'principalKind'='CHANNEL' then
    return app_private.sweep_openclaw_delivery_claims_v1(
      (p_principal->>'organizationId')::uuid,(p_principal->>'accountId')::uuid,null);
  elsif p_principal->>'principalKind'='MAINTENANCE' then
    return app_private.sweep_openclaw_delivery_claims_v1(
      (p_principal->>'organizationId')::uuid,null,
      (p_principal->>'maintenancePrincipalId')::uuid);
  end if;
  raise exception 'principalKind must be CHANNEL or MAINTENANCE' using errcode='42501';
end;
$function$;

create or replace function app_private.openclaw_claim_outbox_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal->>'organizationId')::uuid;
  v_account uuid := (p_principal->>'accountId')::uuid;
  v_cell uuid := (p_principal->>'cellId')::uuid;
  v_limit integer := greatest(1,least(coalesce((p_request->>'limit')::integer,10),25));
  v_seconds integer := greatest(5,least(coalesce((p_request->>'leaseSeconds')::integer,30),60));
  v_expires timestamptz;
  v_token text;
  v_items jsonb;
begin
  if p_request->>'version'<>'1' or nullif(p_request->>'claimToken','') is null then
    raise exception 'version 1 and claimToken required' using errcode='22023';
  end if;
  select least(lease.expires_at,statement_timestamp()+make_interval(secs=>v_seconds))
  into v_expires
  from public.openclaw_runtime_credentials credential
  join public.openclaw_runtime_leases lease
    on lease.organization_id=credential.organization_id and lease.account_id=credential.account_id
   and lease.cell_id=credential.cell_id
  where credential.organization_id=v_org and credential.account_id=v_account
    and credential.cell_id=v_cell
    and credential.credential_generation=(p_principal->>'credentialGeneration')::bigint
    and credential.revoked_at is null
    and lease.lease_generation=(p_principal->>'leaseGeneration')::bigint
    and lease.fencing_token=(p_principal->>'fencingToken')::bigint
    and lease.status='ACTIVE' and lease.expires_at>statement_timestamp();
  if v_expires is null then raise exception 'outbox principal binding is stale' using errcode='42501'; end if;
  v_token := encode(extensions.digest(convert_to('ihome-openclaw-outbox-claim-v1','UTF8')
    ||decode('00','hex')||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');
  with locked as (
    select outbox.* from public.openclaw_outbox outbox
    where outbox.organization_id=v_org and outbox.account_id=v_account
      and outbox.state='QUEUED'
      and (outbox.retry_not_before is null or outbox.retry_not_before<=statement_timestamp())
    order by outbox.created_at,outbox.id for update skip locked limit v_limit
  ), ranked as (
    select locked.id,sum(octet_length(convert_to(jsonb_build_object(
      'version',1,
      'outboxId',locked.id,
      'organizationId',locked.organization_id,
      'accountId',locked.account_id,
      'claimToken',p_request->>'claimToken',
      'claimGeneration',locked.claim_generation+1,
      'fencingToken',(p_principal->>'fencingToken')::bigint,
      'sessionGeneration',(p_principal->>'sessionGeneration')::bigint,
      'controlVersion',locked.control_version,
      'takeoverVersion',locked.takeover_version,
      'leaseExpiresAt',v_expires,
      'payloadHash',locked.payload_hash,
      'payload',locked.canonical_payload
    )::text,'UTF8'))) over (order by locked.created_at,locked.id) encoded_bytes
    from locked
  ), candidates as (
    select ranked.id from ranked where ranked.encoded_bytes<=229376
  ), claimed as (
    update public.openclaw_outbox outbox set state='LEASED',claim_token_hash=v_token,
      claim_generation=outbox.claim_generation+1,claimed_cell_id=v_cell,
      credential_generation=(p_principal->>'credentialGeneration')::bigint,
      runtime_lease_generation=(p_principal->>'leaseGeneration')::bigint,
      lease_expires_at=v_expires,fencing_token=(p_principal->>'fencingToken')::bigint,
      session_generation=(p_principal->>'sessionGeneration')::bigint,
      attempt_count=outbox.attempt_count+1,updated_at=statement_timestamp()
    from candidates where outbox.organization_id=v_org and outbox.id=candidates.id
    returning outbox.*
  ) select coalesce(jsonb_agg(jsonb_build_object(
    'version',1,
    'outboxId',id,
    'organizationId',organization_id,
    'accountId',account_id,
    'claimToken',p_request->>'claimToken',
    'claimGeneration',claim_generation,
    'fencingToken',fencing_token,
    'sessionGeneration',session_generation,
    'controlVersion',control_version,
    'takeoverVersion',takeover_version,
    'leaseExpiresAt',lease_expires_at,
    'payloadHash',payload_hash,
    'payload',canonical_payload
  ) order by id),'[]'::jsonb) into v_items from claimed;
  return jsonb_build_object('version',1,'items',v_items);
end;
$function$;

create or replace function app_private.openclaw_get_work_context_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_claim jsonb := p_request->'claim';
  v_binding record;
  v_work public.openclaw_send_work_items%rowtype;
  v_account public.openclaw_accounts%rowtype;
  v_target public.openclaw_targets%rowtype;
  v_automation public.openclaw_automation_versions%rowtype;
  v_token_hash text;
  v_current jsonb := jsonb_build_object('allowed',true);
  v_frozen jsonb;
  v_canonical jsonb;
  v_frozen_inputs jsonb;
  v_knowledge jsonb := '[]'::jsonb;
  v_values jsonb := '{}'::jsonb;
  v_required jsonb := '[]'::jsonb;
  v_message public.openclaw_messages%rowtype;
  v_schedule_snapshot public.openclaw_schedule_snapshots%rowtype;
  v_crm_snapshot public.openclaw_crm_event_subscription_snapshots%rowtype;
  v_crm_occurrence public.openclaw_crm_event_occurrences%rowtype;
  v_recomputed_source_hash text;
  v_now timestamptz := statement_timestamp();
  v_result jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,array['version','claim'],array['version','claim']
  );
  perform app_private.openclaw_assert_strict_object_v1(
    v_claim,
    array['version','workItemId','organizationId','accountId','cellId',
      'credentialGeneration','leaseGeneration','sourceKey','claimToken','claimGeneration',
      'fencingToken','leaseExpiresAt','payload'],
    array['version','workItemId','organizationId','accountId','cellId',
      'credentialGeneration','leaseGeneration','sourceKey','claimToken','claimGeneration',
      'fencingToken','leaseExpiresAt','payload']
  );
  if p_request->>'version'<>'1' or v_claim->>'version'<>'1'
     or p_principal->>'principalKind'<>'CHANNEL'
     or v_claim->>'organizationId' is distinct from p_principal->>'organizationId'
     or v_claim->>'accountId' is distinct from p_principal->>'accountId'
     or v_claim->>'cellId' is distinct from p_principal->>'cellId'
     or v_claim->'credentialGeneration' is distinct from p_principal->'credentialGeneration'
     or v_claim->'leaseGeneration' is distinct from p_principal->'leaseGeneration'
     or v_claim->'fencingToken' is distinct from p_principal->'fencingToken'
     or char_length(v_claim->>'claimToken') not between 32 and 512
     or jsonb_typeof(v_claim->'payload')<>'object'
  then
    raise exception 'nested channel work-context claim is invalid' using errcode='22023';
  end if;
  v_token_hash:=encode(extensions.digest(
    convert_to('ihome-openclaw-work-claim-v1','UTF8')||decode('00','hex')
      ||convert_to(v_claim->>'claimToken','UTF8'),'sha256'),'hex');

  select work work_row,account account_row,target target_row,automation automation_row
  into v_binding
  from public.openclaw_send_work_items work
  join public.openclaw_accounts account
    on account.organization_id=work.organization_id and account.id=work.account_id
  join public.openclaw_runtime_cells cell
    on cell.organization_id=work.organization_id and cell.account_id=work.account_id
   and cell.id=work.cell_id and cell.is_current and cell.state='READY'
  join public.openclaw_runtime_credentials credential
    on credential.organization_id=work.organization_id and credential.account_id=work.account_id
   and credential.cell_id=work.cell_id
   and credential.credential_generation=work.credential_generation
   and credential.revoked_at is null
  join public.openclaw_runtime_leases lease
    on lease.organization_id=work.organization_id and lease.account_id=work.account_id
   and lease.cell_id=work.cell_id and lease.lease_generation=work.runtime_lease_generation
   and lease.fencing_token=work.fencing_token and lease.status='ACTIVE'
   and lease.expires_at>v_now
  join public.openclaw_targets target
    on target.organization_id=work.organization_id and target.account_id=work.account_id
   and target.id=work.target_id
  join public.openclaw_automation_versions automation
    on automation.organization_id=work.organization_id and automation.account_id=work.account_id
   and automation.id=nullif(work.payload->>'automationVersionId','')::uuid
  where work.organization_id=(p_principal->>'organizationId')::uuid
    and work.account_id=(p_principal->>'accountId')::uuid
    and work.id=(v_claim->>'workItemId')::uuid and work.state='LEASED'
    and work.claim_generation=(v_claim->>'claimGeneration')::bigint
    and work.claim_token_hash=v_token_hash
    and work.cell_id=(p_principal->>'cellId')::uuid
    and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
    and work.runtime_lease_generation=(p_principal->>'leaseGeneration')::bigint
    and work.fencing_token=(p_principal->>'fencingToken')::bigint
    and work.session_generation=(p_principal->>'sessionGeneration')::bigint
    and account.session_generation=work.session_generation
    and work.lease_expires_at>v_now
  for share of work;
  if not found then
    raise exception 'work-context claim binding CAS failed' using errcode='40001';
  end if;
  v_work:=v_binding.work_row;
  v_account:=v_binding.account_row;
  v_target:=v_binding.target_row;
  v_automation:=v_binding.automation_row;
  if v_work.source_key is distinct from v_claim->>'sourceKey'
     or v_work.payload is distinct from v_claim->'payload'
     or v_work.credential_generation is distinct from (v_claim->>'credentialGeneration')::bigint
     or v_work.runtime_lease_generation is distinct from (v_claim->>'leaseGeneration')::bigint
     or v_work.fencing_token is distinct from (v_claim->>'fencingToken')::bigint
     or v_work.lease_expires_at is distinct from (v_claim->>'leaseExpiresAt')::timestamptz
  then
    raise exception 'work-context claim differs from stored frozen work' using errcode='40001';
  end if;

  if v_work.work_kind='INBOUND_AUTOMATION' then
    select message.* into v_message from public.openclaw_messages message
    where message.organization_id=v_work.organization_id
      and message.account_id=v_work.account_id
      and message.id=(v_work.payload->>'messageId')::uuid
      and message.conversation_id=(v_work.payload->>'conversationId')::uuid
      and message.source_inbound_event_id=(v_work.payload->>'inboundEventId')::uuid
      and message.direction='INBOUND';
    if not found or v_work.payload->>'eligibilityDecisionHash' is distinct from v_work.source_hash then
      raise exception 'frozen inbound source is unavailable' using errcode='40001';
    end if;
    if char_length(coalesce(v_message.text_content,''))>32768
       or (select count(*) from public.openclaw_knowledge_chunks chunk
         where chunk.organization_id=v_work.organization_id
           and chunk.account_id=v_work.account_id
           and chunk.knowledge_version_id=any(v_automation.knowledge_version_ids))>50
       or exists (select 1 from public.openclaw_knowledge_chunks chunk
         where chunk.organization_id=v_work.organization_id
           and chunk.account_id=v_work.account_id
           and chunk.knowledge_version_id=any(v_automation.knowledge_version_ids)
           and char_length(chunk.chunk_text)>4000)
    then raise exception 'frozen inbound context exceeds the runtime contract' using errcode='54000'; end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'chunkId',chunk.id,'versionId',chunk.knowledge_version_id,
      'sensitivity',chunk.sensitivity,'text',chunk.chunk_text
    ) order by chunk.knowledge_version_id,chunk.chunk_index,chunk.id),'[]'::jsonb)
    into v_knowledge
    from public.openclaw_knowledge_chunks chunk
    where chunk.organization_id=v_work.organization_id
      and chunk.account_id=v_work.account_id
      and chunk.knowledge_version_id=any(v_automation.knowledge_version_ids);
    v_frozen_inputs:=jsonb_build_object(
      'campaignVersionId',null,'scheduleVersion',null,'subscriptionVersion',null,
      'subscriptionId',null,'occurrenceId',null,'sourceTable',null,'sourceId',null,
      'sourceVersion',null,'knowledgeVersionIds',to_jsonb(v_automation.knowledge_version_ids),
      'sourceSnapshotHash',v_work.source_hash,'targetVersion',v_work.payload->'targetVersion',
      'targetDirectoryRefreshedAt',v_work.payload->'targetDirectoryRefreshedAt',
      'fieldMappingHash',null
    );
  elsif v_work.work_kind='SCHEDULE_OCCURRENCE' then
    select snapshot.* into v_schedule_snapshot
    from public.openclaw_schedule_snapshots snapshot
    where snapshot.organization_id=v_work.organization_id
      and snapshot.account_id=v_work.account_id and snapshot.schedule_id=v_work.schedule_id
      and snapshot.schedule_version=v_work.schedule_version
      and snapshot.snapshot_hash=v_work.source_hash
      and snapshot.campaign_version_id=v_work.campaign_version_id;
    if not found then raise exception 'frozen schedule source is unavailable' using errcode='40001'; end if;
    v_frozen_inputs:=jsonb_build_object(
      'campaignVersionId',v_work.payload->'campaignVersionId',
      'scheduleVersion',v_work.payload->'scheduleVersion','subscriptionVersion',null,
      'subscriptionId',null,'occurrenceId',v_work.payload->'occurrenceId',
      'sourceTable','openclaw_schedule_snapshots','sourceId',v_work.payload->'scheduleId',
      'sourceVersion',v_work.payload->>'scheduleVersion',
      'knowledgeVersionIds',to_jsonb(v_automation.knowledge_version_ids),
      'sourceSnapshotHash',v_work.source_hash,'targetVersion',v_work.payload->'targetVersion',
      'targetDirectoryRefreshedAt',v_work.payload->'targetDirectoryRefreshedAt',
      'fieldMappingHash',null
    );
  elsif v_work.work_kind='CRM_EVENT' then
    select snapshot.* into v_crm_snapshot
    from public.openclaw_crm_event_subscription_snapshots snapshot
    where snapshot.organization_id=v_work.organization_id
      and snapshot.account_id=v_work.account_id
      and snapshot.subscription_id=v_work.subscription_id
      and snapshot.subscription_version=v_work.subscription_version;
    select occurrence.* into v_crm_occurrence
    from public.openclaw_crm_event_occurrences occurrence
    where occurrence.organization_id=v_work.organization_id and occurrence.id=v_work.crm_occurrence_id;
    if v_crm_snapshot.id is null or v_crm_occurrence.id is null then
      raise exception 'frozen CRM source is unavailable' using errcode='40001';
    end if;
    v_recomputed_source_hash:=encode(extensions.digest(
      convert_to('ihome-openclaw-crm-work-source-v1','UTF8')||decode('00','hex')
        ||app_private.openclaw_jcs_bytes_v1(jsonb_build_object(
          'subscriptionSnapshotHash',v_crm_snapshot.snapshot_hash,
          'sourceEnvelopeHash',v_crm_occurrence.snapshot_hash
        )),'sha256'),'hex');
    if v_recomputed_source_hash is distinct from v_work.source_hash
       or v_work.payload->'sourceEnvelope' is distinct from v_crm_occurrence.source_snapshot
       or v_work.payload->>'sourceEnvelopeHash' is distinct from v_crm_occurrence.snapshot_hash
       or v_work.payload->>'fieldMappingHash' is distinct from v_crm_snapshot.field_mapping_hash
    then raise exception 'frozen CRM lineage mismatch' using errcode='40001'; end if;
    select coalesce(jsonb_object_agg(entry.key,entry.value),'{}'::jsonb) into v_values
    from jsonb_each(coalesce(v_crm_occurrence.source_snapshot->'payload','{}'::jsonb)) entry
    where entry.key=any(array['customerName','roomCode','buildingName','amountDue','dueDate',
      'invoiceCode','meterReading','periodLabel','contactPhoneMasked'])
      and jsonb_typeof(entry.value)='string';
    v_frozen_inputs:=jsonb_build_object(
      'campaignVersionId',coalesce(v_work.payload->'campaignVersionId','null'::jsonb),
      'scheduleVersion',null,'subscriptionVersion',v_work.payload->'subscriptionVersion',
      'subscriptionId',v_work.payload->'subscriptionId','occurrenceId',v_work.payload->'occurrenceId',
      'sourceTable',v_crm_occurrence.source_table,'sourceId',v_crm_occurrence.source_id,
      'sourceVersion',v_crm_occurrence.source_version::text,
      'knowledgeVersionIds',to_jsonb(v_automation.knowledge_version_ids),
      'sourceSnapshotHash',v_work.source_hash,'targetVersion',v_work.payload->'targetVersion',
      'targetDirectoryRefreshedAt',v_work.payload->'targetDirectoryRefreshedAt',
      'fieldMappingHash',v_crm_snapshot.field_mapping_hash
    );
  else
    raise exception 'unsupported channel work kind' using errcode='22023';
  end if;

  if char_length(v_automation.template_body)>32768 then
    raise exception 'frozen template exceeds the runtime contract' using errcode='54000';
  end if;

  select coalesce(jsonb_object_agg(entry.key,entry.value),'{}'::jsonb)||v_values into v_values
  from jsonb_each(coalesce(v_automation.configuration->'templateValues','{}'::jsonb)) entry
  where entry.key=any(array['customerName','roomCode','buildingName','amountDue','dueDate',
    'invoiceCode','meterReading','periodLabel','contactPhoneMasked'])
    and jsonb_typeof(entry.value)='string';
  select coalesce(jsonb_agg(value order by value),'[]'::jsonb) into v_required
  from (
    select distinct matches.value[1] value
    from regexp_matches(
      v_automation.template_body,'\{\{\s*([A-Za-z0-9_]+)\s*\}\}','g'
    ) as matches(value)
    where matches.value[1]=any(array['customerName','roomCode','buildingName','amountDue','dueDate',
      'invoiceCode','meterReading','periodLabel','contactPhoneMasked'])
  ) required;
  v_canonical:=jsonb_build_object(
    'version',1,'organizationId',v_work.organization_id,'accountId',v_work.account_id,
    'target',jsonb_build_object('kind',v_target.kind,'providerId',v_target.provider_id),
    'channel','zalouser','accountProfile',v_account.account_profile,
    'idempotencyKey','work:'||v_work.id||':'||v_work.claim_generation,
    'parts',jsonb_build_array(jsonb_build_object(
      'version',1,'partIndex',0,'kind','TEXT','text','[PENDING_RENDER]')),
    'replyToProviderMessageId',case when v_work.work_kind='INBOUND_AUTOMATION'
      then to_jsonb(v_message.provider_message_id) else 'null'::jsonb end,
    'policyVersionId',v_automation.policy_version_id,
    'automationVersionId',v_automation.id,'templateVersionId',v_automation.content_version_id,
    'frozenInputs',v_frozen_inputs
  );

  if not v_account.is_active or v_account.paused_at is not null then
    v_current:=jsonb_build_object('allowed',false,'reasonCode','ACCOUNT_PAUSED');
  elsif v_automation.lifecycle_state<>'PUBLISHED' or not exists (
    select 1 from public.openclaw_policy_versions policy
    where policy.organization_id=v_work.organization_id and policy.account_id=v_work.account_id
      and policy.id=v_automation.policy_version_id and policy.lifecycle_state='PUBLISHED'
  ) then v_current:=jsonb_build_object('allowed',false,'reasonCode','POLICY_STALE');
  elsif not exists (
    select 1 from public.openclaw_control_states control
    where control.organization_id=v_work.organization_id and control.control_key='GLOBAL_STOP'
      and control.feature_enabled and not control.global_stop
      and (v_work.work_kind='INBOUND_AUTOMATION' or control.proactive_enabled)
  ) then v_current:=jsonb_build_object('allowed',false,'reasonCode','CONTROL_BLOCKED');
  elsif not v_target.is_active
     or v_target.target_version is distinct from (v_work.payload->>'targetVersion')::bigint
     or v_target.directory_refreshed_at is distinct from
       (v_work.payload->>'targetDirectoryRefreshedAt')::timestamptz
  then v_current:=jsonb_build_object('allowed',false,'reasonCode','TARGET_STALE');
  elsif exists (
    select 1 from public.openclaw_suppressions suppression
    where suppression.organization_id=v_work.organization_id
      and suppression.account_id=v_work.account_id and suppression.active_from<=v_now
      and suppression.released_at is null
      and (suppression.expires_at is null or suppression.expires_at>v_now)
      and (suppression.suppression_scope in ('ORGANIZATION','ACCOUNT')
        or (suppression.suppression_scope='TARGET' and suppression.target_id=v_work.target_id))
  ) then v_current:=jsonb_build_object('allowed',false,'reasonCode','SUPPRESSION_ACTIVE');
  elsif exists (
    select 1 from public.openclaw_takeovers takeover
    join public.openclaw_conversations conversation
      on conversation.organization_id=takeover.organization_id
     and conversation.account_id=takeover.account_id and conversation.id=takeover.conversation_id
    where takeover.organization_id=v_work.organization_id and takeover.account_id=v_work.account_id
      and conversation.target_id=v_work.target_id and takeover.released_at is null
      and takeover.expires_at>v_now
  ) then v_current:=jsonb_build_object('allowed',false,'reasonCode','TAKEOVER_ACTIVE');
  elsif v_work.work_kind='SCHEDULE_OCCURRENCE' and not exists (
    select 1 from public.openclaw_schedules schedule
    join public.openclaw_campaign_runs run
      on run.organization_id=schedule.organization_id and run.account_id=schedule.account_id
     and run.id=v_work.campaign_version_id and run.status in ('PLANNED','RUNNING')
    join public.openclaw_campaigns campaign
      on campaign.organization_id=run.organization_id and campaign.account_id=run.account_id
     and campaign.id=run.campaign_id and campaign.status<>'CANCELLED'
    where schedule.organization_id=v_work.organization_id and schedule.account_id=v_work.account_id
      and schedule.id=v_work.schedule_id and schedule.schedule_version=v_work.schedule_version
      and schedule.status in ('ACTIVE','COMPLETE')
  ) then v_current:=jsonb_build_object('allowed',false,'reasonCode','SCHEDULE_STALE');
  elsif v_work.work_kind='CRM_EVENT' and not exists (
    select 1 from public.openclaw_crm_event_subscriptions subscription
    where subscription.organization_id=v_work.organization_id
      and subscription.account_id=v_work.account_id and subscription.id=v_work.subscription_id
      and subscription.subscription_version=v_work.subscription_version and subscription.is_active
  ) then v_current:=jsonb_build_object('allowed',false,'reasonCode','SUBSCRIPTION_STALE');
  end if;

  if v_work.work_kind='INBOUND_AUTOMATION' then
    v_frozen:=jsonb_build_object(
      'customerText',coalesce(v_message.text_content,''),'knowledgeChunks',v_knowledge,
      'canonicalPayload',v_canonical,'sourceSnapshotHash',v_work.source_hash
    );
  elsif v_work.work_kind='CRM_EVENT' then
    v_frozen:=jsonb_build_object(
      'frozenIdentity',v_work.payload,'template',v_automation.template_body,
      'values',v_values,'requiredFields',v_required,
      'allowedCrmFields',to_jsonb(v_automation.allowed_crm_fields),
      'canonicalPayload',v_canonical,'sourceSnapshotHash',v_work.source_hash
    );
  else
    v_frozen:=jsonb_build_object(
      'frozenIdentity',v_work.payload,'template',v_automation.template_body,
      'values',v_values,'requiredFields',v_required,
      'canonicalPayload',v_canonical,'sourceSnapshotHash',v_work.source_hash
    );
  end if;
  v_result:=jsonb_build_object(
    'version',1,'workItemId',v_work.id,'claimGeneration',v_work.claim_generation,
    'kind',v_work.work_kind,'currentState',v_current,'frozenContext',v_frozen
  );
  if octet_length(convert_to(v_result::text,'UTF8'))>458752 then
    raise exception 'frozen work context exceeds the encoded runtime contract' using errcode='54000';
  end if;
  return v_result;
end;
$function$;

create or replace function app_private.openclaw_create_outbox_from_work_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal->>'organizationId')::uuid;
  v_account uuid := (p_principal->>'accountId')::uuid;
  v_claim jsonb := p_request->'claim';
  v_work public.openclaw_send_work_items%rowtype;
  v_payload jsonb := p_request->'canonicalPayload';
  v_frozen jsonb;
  v_payload_hash text;
  v_token text;
  v_target public.openclaw_targets%rowtype;
  v_source_kind text;
  v_automation uuid;
  v_automation_row public.openclaw_automation_versions%rowtype;
  v_campaign_version uuid;
  v_campaign_id uuid;
  v_campaign_number bigint;
  v_control bigint;
  v_takeover bigint;
  v_outbox uuid;
  v_inserted integer;
  v_existing public.openclaw_outbox%rowtype;
  v_existing_attempt public.openclaw_send_work_attempts%rowtype;
  v_schedule record;
  v_crm record;
  v_recomputed_source_hash text;
  v_completion_evidence jsonb;
  v_completion_hash text;
  v_result jsonb;
  v_internal_evidence jsonb;
  v_now timestamptz := statement_timestamp();
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','principalKind','claim','canonicalPayload','payloadHash','sourceSnapshotHash'],
    array['version','principalKind','claim','canonicalPayload','payloadHash','sourceSnapshotHash']
  );
  perform app_private.openclaw_assert_strict_object_v1(
    v_claim,
    array['version','workItemId','organizationId','accountId','cellId',
      'credentialGeneration','leaseGeneration','sourceKey','claimToken','claimGeneration',
      'fencingToken','leaseExpiresAt','payload'],
    array['version','workItemId','organizationId','accountId','cellId',
      'credentialGeneration','leaseGeneration','sourceKey','claimToken','claimGeneration',
      'fencingToken','leaseExpiresAt','payload']
  );
  if p_request->>'version'<>'1' or p_request->>'principalKind'<>'CHANNEL'
     or p_principal->>'principalKind'<>'CHANNEL' or jsonb_typeof(v_payload)<>'object'
     or v_claim->>'version'<>'1'
     or v_claim->>'organizationId' is distinct from p_principal->>'organizationId'
     or v_claim->>'accountId' is distinct from p_principal->>'accountId'
     or v_claim->>'cellId' is distinct from p_principal->>'cellId'
     or v_claim->'credentialGeneration' is distinct from p_principal->'credentialGeneration'
     or v_claim->'leaseGeneration' is distinct from p_principal->'leaseGeneration'
     or v_claim->'fencingToken' is distinct from p_principal->'fencingToken'
     or char_length(v_claim->>'claimToken') not between 32 and 512
     or (p_request->>'payloadHash') !~ '^[0-9a-f]{64}$'
     or (p_request->>'sourceSnapshotHash') !~ '^[0-9a-f]{64}$'
  then
    raise exception 'nested channel work claim is invalid' using errcode='22023';
  end if;
  v_token:=encode(extensions.digest(convert_to('ihome-openclaw-work-claim-v1','UTF8')
    ||decode('00','hex')||convert_to(v_claim->>'claimToken','UTF8'),'sha256'),'hex');
  v_payload_hash:=app_private.openclaw_send_payload_hash_v1(v_payload);
  if v_payload_hash is distinct from p_request->>'payloadHash' then
    raise exception 'canonical send payload hash mismatch' using errcode='40001';
  end if;

  select attempt.* into v_existing_attempt
  from public.openclaw_send_work_attempts attempt
  where attempt.organization_id=v_org and attempt.account_id=v_account
    and attempt.work_item_id=(v_claim->>'workItemId')::uuid
    and attempt.claim_generation=(v_claim->>'claimGeneration')::bigint
    and attempt.outcome='COMPLETE' and attempt.evidence->>'claimTokenHash'=v_token
    and attempt.evidence->>'sourceSnapshotHash'=p_request->>'sourceSnapshotHash'
    and attempt.evidence#>>'{clientEvidence,payloadHash}'=v_payload_hash
  order by attempt.attempt_number desc,attempt.id desc limit 1;
  if found then
    select outbox.* into strict v_existing
    from public.openclaw_outbox outbox
    where outbox.organization_id=v_org and outbox.account_id=v_account
      and outbox.id=(v_existing_attempt.evidence#>>'{clientEvidence,outboxId}')::uuid;
    if v_existing.payload_hash is distinct from v_payload_hash
       or v_existing.canonical_payload is distinct from v_payload
       or jsonb_typeof(v_existing_attempt.evidence->'result')<>'object' then
      raise exception 'idempotent work-to-outbox replay mismatch' using errcode='40001';
    end if;
    return v_existing_attempt.evidence->'result';
  end if;

  select work.* into v_work from public.openclaw_send_work_items work
  join public.openclaw_runtime_credentials credential
    on credential.organization_id=work.organization_id and credential.account_id=work.account_id
   and credential.cell_id=work.cell_id
   and credential.credential_generation=work.credential_generation and credential.revoked_at is null
  join public.openclaw_runtime_leases lease
    on lease.organization_id=work.organization_id and lease.account_id=work.account_id
   and lease.cell_id=work.cell_id and lease.lease_generation=work.runtime_lease_generation
   and lease.fencing_token=work.fencing_token and lease.status='ACTIVE'
  where work.organization_id=v_org and work.account_id=v_account
    and work.id=(v_claim->>'workItemId')::uuid and work.state='LEASED'
    and work.claim_generation=(v_claim->>'claimGeneration')::bigint
    and work.claim_token_hash=v_token
    and work.cell_id=(p_principal->>'cellId')::uuid
    and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
    and work.runtime_lease_generation=(p_principal->>'leaseGeneration')::bigint
    and work.fencing_token=(p_principal->>'fencingToken')::bigint
    and work.session_generation=(p_principal->>'sessionGeneration')::bigint
    and work.lease_expires_at>v_now and lease.expires_at>v_now
  for update of work;
  if not found then raise exception 'create outbox stored work binding CAS failed' using errcode='40001'; end if;
  if v_work.source_hash is distinct from p_request->>'sourceSnapshotHash'
     or v_work.source_key is distinct from v_claim->>'sourceKey'
     or v_work.payload is distinct from v_claim->'payload'
     or v_work.credential_generation is distinct from (v_claim->>'credentialGeneration')::bigint
     or v_work.runtime_lease_generation is distinct from (v_claim->>'leaseGeneration')::bigint
     or v_work.fencing_token is distinct from (v_claim->>'fencingToken')::bigint
     or v_work.cell_id is distinct from (v_claim->>'cellId')::uuid
     or v_work.lease_expires_at is distinct from (v_claim->>'leaseExpiresAt')::timestamptz
  then
    raise exception 'canonical payload or frozen source hash mismatch' using errcode='40001';
  end if;
  select target.* into v_target from public.openclaw_targets target
  where target.organization_id=v_org and target.account_id=v_account
    and target.kind=v_payload#>>'{target,kind}'
    and target.provider_id=v_payload#>>'{target,providerId}' and target.is_active;
  if not found or v_target.id is distinct from v_work.target_id then
    raise exception 'canonical target differs from frozen work target' using errcode='42501';
  end if;
  v_frozen:=v_payload->'frozenInputs';
  if v_payload->>'organizationId' is distinct from v_org::text
     or v_payload->>'accountId' is distinct from v_account::text
     or v_payload->>'channel'<>'zalouser'
     or v_frozen->>'sourceSnapshotHash' is distinct from v_work.source_hash
     or (v_frozen->>'targetVersion')::bigint is distinct from v_target.target_version
     or (v_frozen->>'targetDirectoryRefreshedAt')::timestamptz
       is distinct from v_target.directory_refreshed_at
     or (v_work.payload->>'targetVersion')::bigint is distinct from v_target.target_version
     or (v_work.payload->>'targetDirectoryRefreshedAt')::timestamptz
       is distinct from v_target.directory_refreshed_at
  then
    raise exception 'canonical target or frozen directory lineage is stale' using errcode='40001';
  end if;

  if v_work.work_kind='INBOUND_AUTOMATION' then
    v_source_kind:='INBOUND_REPLY';
    v_automation:=nullif(v_work.payload->>'automationVersionId','')::uuid;
    if v_work.payload->>'eligibilityDecisionHash' is distinct from v_work.source_hash
       or v_frozen->'campaignVersionId'<>'null'::jsonb
       or v_frozen->'scheduleVersion'<>'null'::jsonb
       or v_frozen->'subscriptionVersion'<>'null'::jsonb
       or v_frozen->'subscriptionId'<>'null'::jsonb
       or v_frozen->'occurrenceId'<>'null'::jsonb
       or v_frozen->'sourceTable'<>'null'::jsonb
       or v_frozen->'sourceId'<>'null'::jsonb
       or v_frozen->'sourceVersion'<>'null'::jsonb
       or v_frozen->'fieldMappingHash'<>'null'::jsonb
    then raise exception 'inbound frozen lineage mismatch' using errcode='40001'; end if;
  elsif v_work.work_kind='SCHEDULE_OCCURRENCE' then
    v_source_kind:='SCHEDULE';
    if v_work.schedule_id is null or v_work.schedule_version is null
      or v_work.schedule_occurrence_id is null or v_work.target_id is null
      or v_work.campaign_version_id is null then
      raise exception 'typed schedule work identity is incomplete' using errcode='55000';
    end if;
    select snapshot.automation_version_id,snapshot.campaign_version_id,
      occurrence.occurrence_evidence_hash,campaign_version.campaign_id,
      campaign_version.campaign_version,campaign_version.status,campaign.status campaign_status
    into v_schedule
    from public.openclaw_schedule_snapshots snapshot
    join public.openclaw_schedule_occurrences occurrence
      on occurrence.organization_id=snapshot.organization_id
     and occurrence.account_id=snapshot.account_id
     and occurrence.schedule_id=snapshot.schedule_id
     and occurrence.schedule_version=snapshot.schedule_version
     and occurrence.id=v_work.schedule_occurrence_id
    join public.openclaw_campaign_runs campaign_version
      on campaign_version.organization_id=snapshot.organization_id
     and campaign_version.account_id=snapshot.account_id
     and campaign_version.id=snapshot.campaign_version_id
    join public.openclaw_campaigns campaign
      on campaign.organization_id=campaign_version.organization_id
     and campaign.account_id=campaign_version.account_id
     and campaign.id=campaign_version.campaign_id
    join public.openclaw_schedules current_schedule
      on current_schedule.organization_id=snapshot.organization_id
     and current_schedule.account_id=snapshot.account_id
     and current_schedule.id=snapshot.schedule_id
     and current_schedule.schedule_version=snapshot.schedule_version
     and current_schedule.status in ('ACTIVE','COMPLETE')
    where snapshot.organization_id=v_org and snapshot.account_id=v_account
      and snapshot.schedule_id=v_work.schedule_id
      and snapshot.schedule_version=v_work.schedule_version
      and snapshot.snapshot_hash=v_work.source_hash
      and snapshot.campaign_version_id=v_work.campaign_version_id;
    if not found or v_schedule.status not in ('PLANNED','RUNNING')
       or v_schedule.campaign_status='CANCELLED' then
      raise exception 'frozen schedule or campaign version is stale' using errcode='40001';
    end if;
    v_automation:=v_schedule.automation_version_id;
    v_campaign_version:=v_schedule.campaign_version_id;
    v_campaign_id:=v_schedule.campaign_id;
    v_campaign_number:=v_schedule.campaign_version;
    if v_work.payload->>'campaignVersionId' is distinct from v_campaign_version::text
       or v_work.payload->>'eligibilityDecisionHash'
          is distinct from v_schedule.occurrence_evidence_hash
       or v_frozen->>'campaignVersionId' is distinct from v_campaign_version::text
       or (v_frozen->>'scheduleVersion')::bigint is distinct from v_work.schedule_version
       or v_frozen->>'occurrenceId' is distinct from v_work.schedule_occurrence_id::text
       or v_frozen->>'sourceTable'<>'openclaw_schedule_snapshots'
       or v_frozen->>'sourceId' is distinct from v_work.schedule_id::text
       or v_frozen->>'sourceVersion' is distinct from v_work.schedule_version::text
       or v_frozen->'subscriptionVersion'<>'null'::jsonb
       or v_frozen->'subscriptionId'<>'null'::jsonb
       or v_frozen->'fieldMappingHash'<>'null'::jsonb
    then raise exception 'schedule frozen lineage mismatch' using errcode='40001'; end if;
  elsif v_work.work_kind='CRM_EVENT' then
    v_source_kind:='CRM_EVENT';
    if v_work.subscription_id is null or v_work.subscription_version is null
      or v_work.crm_occurrence_id is null or v_work.target_id is null then
      raise exception 'typed CRM work identity is incomplete' using errcode='55000';
    end if;
    select snapshot.automation_version_id,snapshot.field_mapping_hash,
      snapshot.snapshot_hash subscription_snapshot_hash,
      occurrence.source_snapshot,occurrence.snapshot_hash source_envelope_hash,
      occurrence.source_table,occurrence.source_id,occurrence.source_version
    into v_crm
    from public.openclaw_crm_event_subscription_snapshots snapshot
    join public.openclaw_crm_event_subscriptions subscription
      on subscription.organization_id=snapshot.organization_id
     and subscription.account_id=snapshot.account_id
     and subscription.id=snapshot.subscription_id
     and subscription.subscription_version=snapshot.subscription_version
     and subscription.is_active
    join public.openclaw_crm_event_occurrences occurrence
      on occurrence.organization_id=snapshot.organization_id
     and occurrence.id=v_work.crm_occurrence_id
    where snapshot.organization_id=v_org and snapshot.account_id=v_account
      and snapshot.subscription_id=v_work.subscription_id
      and snapshot.subscription_version=v_work.subscription_version;
    if not found then raise exception 'frozen CRM source is unavailable' using errcode='40001'; end if;
    v_recomputed_source_hash:=encode(extensions.digest(
      convert_to('ihome-openclaw-crm-work-source-v1','UTF8')||decode('00','hex')
        ||app_private.openclaw_jcs_bytes_v1(jsonb_build_object(
          'subscriptionSnapshotHash',v_crm.subscription_snapshot_hash,
          'sourceEnvelopeHash',v_crm.source_envelope_hash
        )),'sha256'),'hex');
    v_automation:=v_crm.automation_version_id;
    if v_recomputed_source_hash is distinct from v_work.source_hash
       or v_work.payload->'sourceEnvelope' is distinct from v_crm.source_snapshot
       or v_work.payload->>'sourceEnvelopeHash' is distinct from v_crm.source_envelope_hash
       or v_work.payload->>'fieldMappingHash' is distinct from v_crm.field_mapping_hash
       or (v_frozen->>'subscriptionVersion')::bigint is distinct from v_work.subscription_version
       or v_frozen->>'subscriptionId' is distinct from v_work.subscription_id::text
       or v_frozen->>'occurrenceId' is distinct from v_work.crm_occurrence_id::text
       or v_frozen->>'sourceTable' is distinct from v_crm.source_table
       or v_frozen->>'sourceId' is distinct from v_crm.source_id::text
       or v_frozen->>'sourceVersion' is distinct from v_crm.source_version::text
       or v_frozen->>'fieldMappingHash' is distinct from v_crm.field_mapping_hash
    then raise exception 'CRM frozen lineage mismatch' using errcode='40001'; end if;
  else raise exception 'unsupported work kind' using errcode='22023';
  end if;
  if v_automation is null then raise exception 'frozen source snapshot is unavailable' using errcode='40001'; end if;
  select automation.* into strict v_automation_row
  from public.openclaw_automation_versions automation
  join public.openclaw_policy_versions policy
    on policy.organization_id=automation.organization_id
   and policy.account_id=automation.account_id and policy.id=automation.policy_version_id
   and policy.lifecycle_state='PUBLISHED'
  where automation.organization_id=v_org and automation.account_id=v_account
    and automation.id=v_automation and automation.lifecycle_state='PUBLISHED';
  if v_payload->>'automationVersionId' is distinct from v_automation::text
     or v_payload->>'templateVersionId' is distinct from v_automation_row.content_version_id::text
     or v_payload->>'policyVersionId' is distinct from v_automation_row.policy_version_id::text
     or v_work.payload->>'templateVersionId' is distinct from v_automation_row.content_version_id::text
     or v_work.payload->'knowledgeVersionIds'
       is distinct from to_jsonb(v_automation_row.knowledge_version_ids)
     or v_frozen->'knowledgeVersionIds'
       is distinct from to_jsonb(v_automation_row.knowledge_version_ids)
  then raise exception 'automation/template/knowledge lineage mismatch' using errcode='40001'; end if;
  select control.control_version into v_control from public.openclaw_control_states control
  where control.organization_id=v_org and control.control_key='GLOBAL_STOP'
    and control.feature_enabled and not control.global_stop
    and (v_work.work_kind='INBOUND_AUTOMATION' or control.proactive_enabled);
  if not found then raise exception 'OpenClaw control state is missing' using errcode='42501'; end if;
  if exists (
    select 1 from public.openclaw_suppressions suppression
    where suppression.organization_id=v_org and suppression.account_id=v_account
      and suppression.active_from<=v_now and suppression.released_at is null
      and (suppression.expires_at is null or suppression.expires_at>v_now)
      and (suppression.suppression_scope in ('ORGANIZATION','ACCOUNT')
        or (suppression.suppression_scope='TARGET' and suppression.target_id=v_target.id))
  ) then raise exception 'current suppression blocks work-to-outbox' using errcode='42501'; end if;
  select coalesce(max(takeover.takeover_version),0) into v_takeover
  from public.openclaw_takeovers takeover
  join public.openclaw_conversations conversation
    on conversation.organization_id=takeover.organization_id
   and conversation.account_id=takeover.account_id and conversation.id=takeover.conversation_id
  where takeover.organization_id=v_org and takeover.account_id=v_account
    and conversation.target_id=v_target.id;
  if exists (
    select 1 from public.openclaw_takeovers takeover
    join public.openclaw_conversations conversation
      on conversation.organization_id=takeover.organization_id
     and conversation.account_id=takeover.account_id and conversation.id=takeover.conversation_id
    where takeover.organization_id=v_org and takeover.account_id=v_account
      and conversation.target_id=v_target.id and takeover.released_at is null
      and takeover.expires_at>v_now
  ) then raise exception 'active human takeover blocks work-to-outbox' using errcode='42501'; end if;
  insert into public.openclaw_outbox(
    organization_id,account_id,target_id,source_kind,inbound_event_id,
    automation_version_id,schedule_id,schedule_version,subscription_id,
    subscription_version,occurrence_id,campaign_id,campaign_version,campaign_version_id,
    idempotency_key,canonical_payload,
    canonical_payload_bytes,payload_hash,fencing_token,session_generation,
    control_version,takeover_version,smoke_run_id
  ) values (
    v_org,v_account,v_target.id,v_source_kind,
    case when v_source_kind='INBOUND_REPLY' then v_work.source_id end,
    v_automation,v_work.schedule_id,v_work.schedule_version,v_work.subscription_id,
    v_work.subscription_version,coalesce(v_work.schedule_occurrence_id,v_work.crm_occurrence_id),
    v_campaign_id,v_campaign_number,v_campaign_version,
    v_payload->>'idempotencyKey',v_payload,
    app_private.openclaw_canonical_send_payload_bytes_v1(v_payload),v_payload_hash,
    v_work.fencing_token,v_work.session_generation,v_control,v_takeover,v_work.smoke_run_id
  ) on conflict (organization_id,account_id,idempotency_key) do nothing
  returning id into v_outbox;
  get diagnostics v_inserted=row_count;
  if v_inserted=0 then
    select outbox.* into strict v_existing from public.openclaw_outbox outbox
    where outbox.organization_id=v_org and outbox.account_id=v_account
      and outbox.idempotency_key=v_payload->>'idempotencyKey' for share;
    if v_existing.payload_hash is distinct from v_payload_hash
       or v_existing.target_id is distinct from v_target.id
       or v_existing.source_kind is distinct from v_source_kind
       or v_existing.automation_version_id is distinct from v_automation
       or v_existing.schedule_id is distinct from v_work.schedule_id
       or v_existing.schedule_version is distinct from v_work.schedule_version
       or v_existing.subscription_id is distinct from v_work.subscription_id
       or v_existing.subscription_version is distinct from v_work.subscription_version
       or v_existing.campaign_version_id is distinct from v_campaign_version
       or v_existing.occurrence_id is distinct from coalesce(v_work.schedule_occurrence_id,v_work.crm_occurrence_id)
    then
      raise exception 'same idempotency key has different frozen work or payload' using errcode='40001';
    end if;
    v_outbox:=v_existing.id;
  end if;
  v_completion_evidence:=jsonb_build_object('outboxId',v_outbox,'payloadHash',v_payload_hash);
  v_completion_hash:=encode(extensions.digest(
    convert_to('ihome-openclaw-send-work-completion-v1','UTF8')||decode('00','hex')
      ||app_private.openclaw_jcs_bytes_v1(v_completion_evidence),'sha256'),'hex');
  v_result:=jsonb_build_object(
    'version',1,'workItemId',v_work.id,'claimGeneration',v_work.claim_generation,
    'outcome','COMPLETED','canonicalEvidenceHash',v_completion_hash,
    'completedAt',v_now,'retryNotBefore',null
  );
  v_internal_evidence:=jsonb_build_object(
    'version',1,'claimTokenHash',v_work.claim_token_hash,
    'sourceSnapshotHash',v_work.source_hash,'clientEvidence',v_completion_evidence,
    'result',v_result
  );
  insert into public.openclaw_send_work_attempts(
    organization_id,account_id,cell_id,work_item_id,claim_generation,fencing_token,
    session_generation,credential_generation,runtime_lease_generation,
    attempt_number,outcome,evidence,evidence_hash
  ) values (
    v_org,v_account,v_work.cell_id,v_work.id,v_work.claim_generation,v_work.fencing_token,
    v_work.session_generation,v_work.credential_generation,v_work.runtime_lease_generation,
    v_work.attempt_count,'COMPLETE',v_internal_evidence,v_completion_hash
  );
  update public.openclaw_send_work_items work set state='COMPLETE',claim_token_hash=null,
    lease_expires_at=null,retry_not_before=null,terminal_at=v_now,updated_at=v_now
  where work.organization_id=v_org and work.id=v_work.id and work.state='LEASED'
    and work.claim_generation=v_work.claim_generation;
  if not found then raise exception 'atomic work completion CAS failed' using errcode='40001'; end if;
  return v_result;
end;
$function$;

create or replace function app_private.run_openclaw_maintenance_jobs_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_lock bigint := pg_catalog.hashtextextended('ihome-openclaw-maintenance-runner-v1',0);
  v_result jsonb;
  v_retention_policies integer;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(v_lock) then
    return jsonb_build_object('version',1,'acquired',false,'databaseTime',statement_timestamp());
  end if;
  v_retention_policies:=app_private.ensure_openclaw_retention_contract_v1();
  v_result := jsonb_build_object(
    'version',1,'acquired',true,
    'retentionPoliciesEnsured',v_retention_policies,
    'qrExpired',app_private.expire_openclaw_qr_challenges_v1(),
    'runtimeLeasesExpired',app_private.expire_openclaw_runtime_leases_v1(),
    'maintenanceLeasesExpired',app_private.expire_openclaw_maintenance_leases_v1(),
    'deliverySweep',app_private.sweep_openclaw_delivery_claims_v1(null,null,null),
    'workRebound',app_private.rebind_openclaw_unclaimed_work_v1(500),
    'salesTasksEmitted',app_private.openclaw_sweep_due_sales_tasks_v1(500),
    'scheduleWork',app_private.materialize_openclaw_schedule_work_v1(500),
    'crmWork',app_private.materialize_openclaw_crm_work_v1(500),
    'retentionQuarantine',app_private.materialize_openclaw_retention_quarantine_v1(500),
    'retentionFinalDelete',app_private.materialize_openclaw_retention_final_delete_v1(500),
    'evidenceRetention',app_private.enforce_openclaw_evidence_retention_v1(500),
    'auditRoots',app_private.materialize_openclaw_audit_root_v1(366),
    'databaseTime',statement_timestamp()
  );
  return v_result;
end;
$function$;

do $cron$
declare v_job bigint;
begin
  if pg_catalog.to_regprocedure('cron.schedule(text,text,text)') is not null then
    if not exists (select 1 from cron.job where jobname='openclaw-maintenance-v1') then
      select cron.schedule('openclaw-maintenance-v1','* * * * *',
        'select app_private.run_openclaw_maintenance_jobs_v1()') into v_job;
    end if;
  end if;
end;
$cron$;

do $table_security$
declare v_table text;
begin
  foreach v_table in array array[
    'openclaw_schedule_occurrences','openclaw_retention_policies',
    'openclaw_retention_hold_clocks','openclaw_retention_hold_scopes',
    'openclaw_retention_delete_tickets','openclaw_retention_delete_ticket_lineage',
    'openclaw_retention_gateway_configs',
    'openclaw_audit_signing_configs','openclaw_audit_gateway_tickets',
    'openclaw_retention_evidence_seals'
  ] loop
    execute format('alter table public.%I owner to openclaw_function_owner',v_table);
    execute format('alter table public.%I enable row level security',v_table);
    execute format('alter table public.%I force row level security',v_table);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',v_table);
    execute format('create policy %I on public.%I for all to openclaw_function_owner using (true) with check (true)',
      v_table||'_function_owner_all',v_table);
  end loop;
end;
$table_security$;

create policy openclaw_schedule_occurrences_runtime_select
  on public.openclaw_schedule_occurrences for select to openclaw_runtime_writer using (true);
create policy openclaw_retention_hold_scopes_maintenance_all
  on public.openclaw_retention_hold_scopes for all to openclaw_maintenance_writer
  using (true) with check (true);
create policy openclaw_retention_hold_clocks_maintenance_all
  on public.openclaw_retention_hold_clocks for all to openclaw_maintenance_writer
  using (true) with check (true);
create policy openclaw_retention_delete_tickets_maintenance_all
  on public.openclaw_retention_delete_tickets for all to openclaw_maintenance_writer
  using (true) with check (true);
create policy openclaw_retention_delete_ticket_lineage_maintenance_all
  on public.openclaw_retention_delete_ticket_lineage for all to openclaw_maintenance_writer
  using (true) with check (true);
create policy openclaw_audit_gateway_tickets_maintenance_all
  on public.openclaw_audit_gateway_tickets for all to openclaw_maintenance_writer
  using (true) with check (true);
create policy openclaw_retention_evidence_seals_maintenance_select
  on public.openclaw_retention_evidence_seals for select to openclaw_maintenance_writer
  using (true);
create policy openclaw_retention_evidence_seals_maintenance_insert
  on public.openclaw_retention_evidence_seals for insert to openclaw_maintenance_writer
  with check (true);
create policy openclaw_retention_policies_maintenance_select
  on public.openclaw_retention_policies for select to openclaw_maintenance_writer
  using (true);
create policy openclaw_retention_gateway_configs_maintenance_select
  on public.openclaw_retention_gateway_configs for select to openclaw_maintenance_writer
  using (true);
create policy openclaw_audit_signing_configs_maintenance_select
  on public.openclaw_audit_signing_configs for select to openclaw_maintenance_writer
  using (true);

create policy openclaw_messages_maintenance_retention_select
  on public.openclaw_messages for select to openclaw_maintenance_writer using (true);
create policy openclaw_messages_maintenance_retention_update
  on public.openclaw_messages for update to openclaw_maintenance_writer
  using (true) with check (true);
create policy openclaw_ai_drafts_maintenance_retention_select
  on public.openclaw_ai_drafts for select to openclaw_maintenance_writer using (true);
create policy openclaw_ai_drafts_maintenance_retention_update
  on public.openclaw_ai_drafts for update to openclaw_maintenance_writer
  using (true) with check (true);
create policy openclaw_qr_challenges_maintenance_retention_delete
  on public.openclaw_qr_challenges for delete to openclaw_maintenance_writer
  using (true);

do $retention_source_security$
declare
  v_table text;
begin
  foreach v_table in array array[
    'openclaw_knowledge_versions','openclaw_knowledge_chunks',
    'openclaw_health_events','openclaw_qr_challenges','openclaw_audit_events',
    'openclaw_audit_roots','openclaw_policy_versions','openclaw_automation_versions',
    'openclaw_control_states','openclaw_delivery_attempts','openclaw_unknown_resolutions',
    'openclaw_runtime_credentials','openclaw_maintenance_credentials',
    'openclaw_consents','openclaw_suppressions','openclaw_inbound_automation_decisions'
  ] loop
    execute format(
      'create policy %I on public.%I for select to openclaw_maintenance_writer using (true)',
      v_table||'_retention_writer_select',v_table
    );
    execute format('grant select on public.%I to openclaw_maintenance_writer',v_table);
  end loop;
  foreach v_table in array array[
    'openclaw_knowledge_versions','openclaw_knowledge_chunks',
    'openclaw_health_events','openclaw_policy_versions','openclaw_automation_versions',
    'openclaw_delivery_attempts','openclaw_inbound_automation_decisions'
  ] loop
    execute format(
      'create policy %I on public.%I for update to openclaw_maintenance_writer using (true) with check (true)',
      v_table||'_retention_writer_update',v_table
    );
    execute format('grant update on public.%I to openclaw_maintenance_writer',v_table);
  end loop;
end;
$retention_source_security$;

grant select,insert on public.openclaw_schedule_occurrences to openclaw_runtime_writer;
grant select,insert,update on public.openclaw_retention_hold_clocks,
  public.openclaw_retention_hold_scopes,public.openclaw_retention_delete_tickets,
  public.openclaw_retention_delete_ticket_lineage,
  public.openclaw_audit_gateway_tickets
  to openclaw_maintenance_writer;
grant select,insert on public.openclaw_retention_evidence_seals
  to openclaw_maintenance_writer;
grant select,update on
  public.openclaw_messages,
  public.openclaw_ai_drafts
  to openclaw_maintenance_writer;
grant delete on public.openclaw_qr_challenges to openclaw_maintenance_writer;
grant usage on schema extensions
  to openclaw_function_owner,openclaw_runtime_writer,openclaw_maintenance_writer;
grant select on public.openclaw_retention_policies,
  public.openclaw_retention_gateway_configs,public.openclaw_audit_signing_configs
  to openclaw_maintenance_writer;
grant select on public.openclaw_retention_gateway_configs to openclaw_function_owner;

create or replace function public.openclaw_service_issue_retention_delete_ticket_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal,p_envelope,p_request,'openclaw_issue_retention_delete_ticket_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context,p_envelope,p_request,'RUNTIME'
  );
  return app_private.openclaw_issue_retention_delete_ticket_v1(
    v_context,p_envelope,p_request
  );
end;
$function$;

create or replace function public.openclaw_service_finalize_media_upload_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal,p_envelope,p_request,'openclaw_finalize_media_upload_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context,p_envelope,p_request,'RUNTIME'
  );
  return app_private.openclaw_finalize_media_upload_v1(
    v_context,p_envelope,p_request
  );
end;
$function$;

create or replace function public.openclaw_service_get_work_context_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal,p_envelope,p_request,'openclaw_get_work_context_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context,p_envelope,p_request,'RUNTIME'
  );
  return app_private.openclaw_get_work_context_v1(v_context,p_envelope,p_request);
end;
$function$;

alter function app_private.openclaw_apply_schedule_write_v1(text,uuid,uuid,jsonb)
  owner to openclaw_function_owner;
alter function app_private.openclaw_claim_work_item_v1(jsonb,jsonb,jsonb)
  owner to openclaw_function_owner;
alter function app_private.openclaw_complete_work_item_v1(jsonb,jsonb,jsonb)
  owner to openclaw_function_owner;
alter function app_private.openclaw_complete_maintenance_failure_v1(jsonb,jsonb,jsonb)
  owner to openclaw_maintenance_writer;
alter function app_private.openclaw_get_work_context_v1(jsonb,jsonb,jsonb)
  owner to openclaw_function_owner;
alter function app_private.openclaw_claim_outbox_v1(jsonb,jsonb,jsonb)
  owner to openclaw_runtime_writer;
alter function app_private.openclaw_complete_retention_quarantine_v1(jsonb,jsonb,jsonb)
  owner to openclaw_maintenance_writer;
alter function app_private.openclaw_issue_retention_delete_ticket_v1(jsonb,jsonb,jsonb)
  owner to openclaw_maintenance_writer;
alter function app_private.openclaw_finalize_media_upload_v1(jsonb,jsonb,jsonb)
  owner to openclaw_function_owner;
alter function app_private.openclaw_authorize_retention_delete_v1(jsonb,jsonb,jsonb)
  owner to openclaw_maintenance_writer;
alter function app_private.openclaw_finalize_retention_delete_v1(jsonb,jsonb,jsonb)
  owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_issue_retention_delete_ticket_v1(jsonb,jsonb,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function app_private.openclaw_issue_retention_delete_ticket_v1(jsonb,jsonb,jsonb)
  to openclaw_service_dispatcher;
revoke all on function app_private.openclaw_finalize_media_upload_v1(jsonb,jsonb,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function app_private.openclaw_finalize_media_upload_v1(jsonb,jsonb,jsonb)
  to openclaw_service_dispatcher;
revoke all on function app_private.openclaw_get_work_context_v1(jsonb,jsonb,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function app_private.openclaw_get_work_context_v1(jsonb,jsonb,jsonb)
  to openclaw_service_dispatcher;
revoke all on function app_private.openclaw_complete_maintenance_failure_v1(jsonb,jsonb,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function app_private.openclaw_complete_maintenance_failure_v1(jsonb,jsonb,jsonb)
  to openclaw_service_dispatcher;
alter function public.openclaw_service_issue_retention_delete_ticket_v1(jsonb,jsonb,jsonb)
  owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_issue_retention_delete_ticket_v1(jsonb,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.openclaw_service_issue_retention_delete_ticket_v1(jsonb,jsonb,jsonb)
  to service_role;
alter function public.openclaw_service_finalize_media_upload_v1(jsonb,jsonb,jsonb)
  owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_finalize_media_upload_v1(jsonb,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.openclaw_service_finalize_media_upload_v1(jsonb,jsonb,jsonb)
  to service_role;
alter function public.openclaw_service_get_work_context_v1(jsonb,jsonb,jsonb)
  owner to openclaw_service_dispatcher;
revoke all on function public.openclaw_service_get_work_context_v1(jsonb,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.openclaw_service_get_work_context_v1(jsonb,jsonb,jsonb)
  to service_role;

do $function_security$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'app_private.openclaw_parse_local_recurrence_rule_v1(text)',
    'app_private.openclaw_valid_local_recurrence_rule_v1(text)',
    'app_private.openclaw_next_schedule_occurrence_v1(text,timestamp without time zone)',
    'app_private.openclaw_resolve_local_occurrence_v1(timestamp without time zone,text,text)',
    'app_private.openclaw_sweep_due_sales_tasks_v1(integer)',
    'app_private.materialize_openclaw_schedule_work_v1(integer)',
    'app_private.materialize_openclaw_crm_work_v1(integer)',
    'app_private.rebind_openclaw_unclaimed_work_v1(integer)',
    'app_private.ensure_openclaw_retention_contract_v1()',
    'app_private.openclaw_retention_subject_held_v1(uuid,text,uuid)',
    'app_private.materialize_openclaw_retention_quarantine_v1(integer)',
    'app_private.materialize_openclaw_retention_final_delete_v1(integer)',
    'app_private.openclaw_audit_merkle_root_v1(bigint[],text[])',
    'app_private.openclaw_audit_lineage_root_v1(uuid,date,bigint,bigint,bigint,text,text)',
    'app_private.materialize_openclaw_audit_root_v1(integer)',
    'app_private.expire_openclaw_qr_challenges_v1()',
    'app_private.expire_openclaw_runtime_leases_v1()',
    'app_private.expire_openclaw_maintenance_leases_v1()',
    'app_private.sweep_openclaw_delivery_claims_v1(uuid,uuid,uuid)',
    'app_private.run_openclaw_maintenance_jobs_v1()'
  ] loop
    execute format('alter function %s owner to openclaw_function_owner',v_signature);
    execute format('revoke all on function %s from public,anon,authenticated,service_role',v_signature);
  end loop;
end;
$function_security$;

alter function app_private.guard_openclaw_send_work_insert_v1()
  owner to openclaw_function_owner;
alter function app_private.guard_openclaw_campaign_run_version_v1()
  owner to openclaw_function_owner;
alter function app_private.guard_openclaw_work_attempt_insert_v1()
  owner to openclaw_function_owner;
alter function app_private.guard_openclaw_retention_redaction_v1()
  owner to openclaw_function_owner;
alter function app_private.guard_openclaw_retention_ticket_lineage_v1()
  owner to openclaw_function_owner;
revoke all on function app_private.guard_openclaw_send_work_insert_v1()
  from public,anon,authenticated,service_role;
revoke all on function app_private.guard_openclaw_campaign_run_version_v1()
  from public,anon,authenticated,service_role;
revoke all on function app_private.guard_openclaw_work_attempt_insert_v1()
  from public,anon,authenticated,service_role;
revoke all on function app_private.guard_openclaw_retention_redaction_v1()
  from public,anon,authenticated,service_role;
revoke all on function app_private.guard_openclaw_retention_ticket_lineage_v1()
  from public,anon,authenticated,service_role;
alter function app_private.openclaw_expand_retention_hold_scopes_v1()
  owner to openclaw_function_owner;
alter function app_private.openclaw_persist_retention_hold_scopes_v1()
  owner to openclaw_function_owner;
revoke all on function app_private.openclaw_expand_retention_hold_scopes_v1()
  from public,anon,authenticated,service_role;
revoke all on function app_private.openclaw_persist_retention_hold_scopes_v1()
  from public,anon,authenticated,service_role;
alter function app_private.openclaw_lock_retention_scope_v1(uuid)
  owner to openclaw_function_owner;
revoke all on function app_private.openclaw_lock_retention_scope_v1(uuid)
  from public,anon,authenticated,service_role;
grant execute on function app_private.openclaw_lock_retention_scope_v1(uuid)
  to openclaw_maintenance_writer;
alter function app_private.openclaw_lock_retention_tombstone_v1(uuid,uuid)
  owner to openclaw_function_owner;
revoke all on function app_private.openclaw_lock_retention_tombstone_v1(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function app_private.openclaw_lock_retention_tombstone_v1(uuid,uuid)
  to openclaw_maintenance_writer;
alter function app_private.openclaw_lock_retention_gateway_config_v1(uuid)
  owner to openclaw_function_owner;
revoke all on function app_private.openclaw_lock_retention_gateway_config_v1(uuid)
  from public,anon,authenticated,service_role;
grant execute on function app_private.openclaw_lock_retention_gateway_config_v1(uuid)
  to openclaw_maintenance_writer;
grant execute on function app_private.openclaw_retention_subject_held_v1(uuid,text,uuid)
  to openclaw_maintenance_writer;

alter function app_private.enforce_openclaw_evidence_retention_v1(integer)
  owner to openclaw_maintenance_writer;
revoke all on function app_private.enforce_openclaw_evidence_retention_v1(integer)
  from public,anon,authenticated,service_role;
grant execute on function app_private.enforce_openclaw_evidence_retention_v1(integer)
  to openclaw_function_owner;

revoke all on function app_private.run_openclaw_maintenance_jobs_v1()
  from public, anon, authenticated, service_role;

-- OpenClaw Zalo - watchdog egress surface
--
-- The external watchdog used to be wired to two INBOUND URLs on the OpenClaw VPS
-- (`/openclaw-health/v1/snapshot` and `/openclaw-health/v1/controls`). Those
-- endpoints never existed, and they cannot exist: the frozen design spec states
-- that OpenClaw "chi them rule egress/namespace rieng va khong expose inbound
-- port" on that host. Opening 443 into the machine that holds the Zalo session is
-- exactly the surface the architecture spends its effort avoiding.
--
-- Everything the watchdog needs already travels OUTWARD on an existing path: the
-- cell calls POST /v1/heartbeat every minute, which refreshes
-- openclaw_runtime_cells.last_heartbeat_at and appends content-free metrics to
-- openclaw_health_events. This migration turns that existing flow into the
-- watchdog's data source, and gives capacity controls a durable home that the
-- cell picks up in the response of the same heartbeat call.
--
-- It also gives the Ed25519 watchdog envelope a DURABLE one-time nonce store.
-- An in-process store cannot be a replay guard on Supabase Edge Functions, which
-- run many isolates: a captured envelope replayed against a cold isolate inside
-- its 60-second window would otherwise be accepted, and the notification-only
-- RECORD path (empty events) spends no other nonce.

-- ---------------------------------------------------------------------------
-- 1. Durable one-time nonce store for the watchdog envelope
-- ---------------------------------------------------------------------------

create table public.openclaw_watchdog_envelope_nonces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  key_generation bigint not null check (key_generation > 0),
  operation text not null
    check (operation in ('health.probe', 'health.record', 'host.guard')),
  nonce_hash text not null check (nonce_hash ~ '^[0-9a-f]{64}$'),
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  signed_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz not null default clock_timestamp(),
  unique (organization_id, id),
  -- One row per nonce per organization: the second insert is the replay.
  unique (organization_id, nonce_hash),
  check (expires_at > signed_at and expires_at <= signed_at + interval '2 minutes')
);

create index openclaw_watchdog_envelope_nonces_expiry_idx
  on public.openclaw_watchdog_envelope_nonces (expires_at);

alter table public.openclaw_watchdog_envelope_nonces enable row level security;
alter table public.openclaw_watchdog_envelope_nonces force row level security;

-- ---------------------------------------------------------------------------
-- 2. Capacity controls
-- ---------------------------------------------------------------------------

create table public.openclaw_capacity_controls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  control text not null check (control in (
    'DISABLE_AUTOMATIC_VIDEO_FILE_CACHE',
    'PAUSE_NONCRITICAL_PROACTIVE_GROUP_MEDIA',
    'PAUSE_ALL_OUTBOUND_MEDIA',
    'PAUSE_OUTBOUND_AI_MEDIA'
  )),
  applied_operation_id uuid not null,
  reason_fingerprint text not null check (
    length(reason_fingerprint) between 1 and 128
      and reason_fingerprint !~ '[[:cntrl:]]'
  ),
  -- Health-generated pauses never auto-resume. Only a user holding
  -- openclaw_zalo.manage_operations releases them after reviewing the incident.
  requires_manual_resume boolean not null default true,
  applied_at timestamptz not null default clock_timestamp(),
  released_at timestamptz,
  released_by uuid references auth.users(id) on delete restrict,
  unique (organization_id, id),
  check ((released_at is null) = (released_by is null))
);

-- At most one ACTIVE row per control per organization; re-applying the same
-- control is a no-op instead of a duplicate.
create unique index openclaw_capacity_controls_active_uidx
  on public.openclaw_capacity_controls (organization_id, control)
  where released_at is null;
create index openclaw_capacity_controls_operation_idx
  on public.openclaw_capacity_controls (organization_id, applied_operation_id);

alter table public.openclaw_capacity_controls enable row level security;
alter table public.openclaw_capacity_controls force row level security;

create policy openclaw_capacity_controls_authenticated_audit_select
  on public.openclaw_capacity_controls for select to authenticated
  using (organization_id in (
    select app_private.openclaw_authorized_org_ids_v1('openclaw_zalo.audit')
  ));

create policy openclaw_capacity_controls_maintenance_writer_all
  on public.openclaw_capacity_controls for all to openclaw_maintenance_writer
  using (true) with check (true);

create policy openclaw_watchdog_envelope_nonces_maintenance_writer_all
  on public.openclaw_watchdog_envelope_nonces for all to openclaw_maintenance_writer
  using (true) with check (true);

-- Closed ACL first: every OpenClaw table starts denied to every browser-facing
-- role, and only the exact privileges below are handed back.
revoke all on public.openclaw_capacity_controls,
  public.openclaw_watchdog_envelope_nonces
  from public, anon, authenticated, service_role;

-- The heartbeat wrapper is owned by openclaw_service_dispatcher, so that role
-- needs its own policy AND grant: NOBYPASSRLS means a grant alone reads nothing.
create policy openclaw_capacity_controls_service_dispatcher_select
  on public.openclaw_capacity_controls for select to openclaw_service_dispatcher
  using (true);

-- The snapshot reads heartbeat freshness from openclaw_runtime_cells. The
-- retention loop above already gave openclaw_maintenance_writer select on
-- openclaw_health_events, but never on the cells table.
create policy openclaw_runtime_cells_watchdog_writer_select
  on public.openclaw_runtime_cells for select to openclaw_maintenance_writer
  using (true);

grant select on public.openclaw_capacity_controls to authenticated;
grant select on public.openclaw_capacity_controls to openclaw_service_dispatcher;
grant select on public.openclaw_runtime_cells to openclaw_maintenance_writer;
grant select, insert, update on public.openclaw_capacity_controls
  to openclaw_maintenance_writer;
grant select, insert, delete on public.openclaw_watchdog_envelope_nonces
  to openclaw_maintenance_writer;

-- ---------------------------------------------------------------------------
-- 3. Narrow service context for the watchdog egress operations
-- ---------------------------------------------------------------------------
-- Deliberately NOT a copy of openclaw_validate_service_context_v1: that function
-- is ~270 lines covering every channel operation, and copying it to add two rows
-- to a CASE would be the kind of silent drift this codebase cannot afford. This
-- validator enforces the same properties for exactly the maintenance principal
-- and the exactly-one scope these two operations need.

create or replace function app_private.openclaw_watchdog_service_context_v1(
  p_principal jsonb,
  p_envelope jsonb,
  p_request jsonb,
  p_expected_operation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid;
  v_maintenance uuid;
  v_credential_generation bigint;
  v_lease_generation bigint;
  v_fencing_token bigint;
  v_request_hash text;
  v_iat timestamptz;
  v_exp timestamptz;
  v_operations constant text[] := array[
    'openclaw_watchdog_snapshot_v1', 'openclaw_apply_capacity_controls_v1'
  ];
begin
  if not (p_expected_operation = any(v_operations)) then
    raise exception 'watchdog service operation matrix mismatch' using errcode = '42501';
  end if;
  perform app_private.openclaw_assert_strict_object_v1(
    p_principal,
    array['version','principalKind','organizationId','maintenancePrincipalId',
      'credentialGeneration','leaseGeneration','fencingToken','allowedOperations'],
    array['version','principalKind','organizationId','maintenancePrincipalId',
      'credentialGeneration','leaseGeneration','fencingToken','allowedOperations',
      'accountId','cellId','sessionGeneration','localSessionGeneration','authMode']
  );
  perform app_private.openclaw_assert_strict_object_v1(
    p_envelope,
    array['version','operation','nonce','iat','exp','requestHash'],
    array['version','operation','nonce','iat','exp','requestHash']
  );
  if p_principal ->> 'version' <> '1' or p_envelope ->> 'version' <> '1' then
    raise exception 'service context version mismatch' using errcode = '42501';
  end if;
  -- A maintenance principal carries no session at all. The canonical validator
  -- asserts this too; leaving it out here would be exactly the silent drift the
  -- header comment claims this narrow validator avoids.
  if coalesce(nullif(p_principal ->> 'sessionGeneration', '')::bigint, 0) <> 0
     or coalesce(nullif(p_principal ->> 'localSessionGeneration', '')::bigint, 0) <> 0
     or coalesce(p_principal ->> 'authMode', 'NORMAL') <> 'NORMAL'
  then
    raise exception 'watchdog principal carries channel session state' using errcode = '42501';
  end if;
  if p_envelope ->> 'operation' is distinct from p_expected_operation then
    raise exception 'envelope operation mismatch' using errcode = '42501';
  end if;
  if jsonb_typeof(p_principal -> 'allowedOperations') <> 'array'
     or not ((p_principal -> 'allowedOperations') ? p_expected_operation)
  then
    raise exception 'service operation is not allowed' using errcode = '42501';
  end if;

  v_request_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-service-request-v1', 'UTF8')
      || decode('00', 'hex') || convert_to(p_expected_operation, 'UTF8')
      || decode('00', 'hex') || app_private.openclaw_jcs_bytes_v1(p_request),
    'sha256'
  ), 'hex');
  if p_envelope ->> 'requestHash' is distinct from v_request_hash then
    raise exception 'service request hash mismatch' using errcode = '42501';
  end if;

  v_iat := (p_envelope ->> 'iat')::timestamptz;
  v_exp := (p_envelope ->> 'exp')::timestamptz;
  if statement_timestamp() < v_iat - interval '30 seconds'
     or statement_timestamp() >= v_exp
     or v_exp > v_iat + interval '5 minutes'
  then
    raise exception 'service envelope expired or outside DB time window' using errcode = '42501';
  end if;

  if p_principal ->> 'principalKind' is distinct from 'MAINTENANCE' then
    raise exception 'watchdog principal kind mismatch' using errcode = '42501';
  end if;
  v_org := (p_principal ->> 'organizationId')::uuid;
  v_maintenance := nullif(p_principal ->> 'maintenancePrincipalId', '')::uuid;
  v_credential_generation := (p_principal ->> 'credentialGeneration')::bigint;
  v_lease_generation := (p_principal ->> 'leaseGeneration')::bigint;
  v_fencing_token := (p_principal ->> 'fencingToken')::bigint;

  if v_org is null or v_maintenance is null
     or nullif(p_principal ->> 'accountId', '') is not null
     or nullif(p_principal ->> 'cellId', '') is not null
     or not exists (
       select 1
       from public.openclaw_maintenance_credentials credential
       join public.openclaw_maintenance_principals principal
         on principal.organization_id = credential.organization_id
        and principal.id = credential.maintenance_principal_id
       join public.openclaw_maintenance_leases lease
         on lease.organization_id = credential.organization_id
        and lease.maintenance_principal_id = credential.maintenance_principal_id
       where credential.organization_id = v_org
         and credential.maintenance_principal_id = v_maintenance
         and credential.credential_generation = v_credential_generation
         and credential.revoked_at is null
         and 'watchdog.health' = any(credential.allowed_scopes)
         and lease.lease_generation = v_lease_generation
         and lease.fencing_token = v_fencing_token
         and lease.status = 'ACTIVE'
         and lease.expires_at > statement_timestamp()
         and principal.is_current and principal.revoked_at is null
     )
  then
    raise exception 'credential generation mismatch, lease generation mismatch, fencing token mismatch, or maintenance principal is stale'
      using errcode = '42501';
  end if;

  return jsonb_build_object(
    'version', 1, 'principalKind', 'MAINTENANCE', 'organizationId', v_org,
    'accountId', null, 'cellId', null,
    'maintenancePrincipalId', v_maintenance,
    'credentialGeneration', v_credential_generation,
    'leaseGeneration', v_lease_generation, 'fencingToken', v_fencing_token,
    'operation', p_expected_operation, 'scope', 'watchdog.health',
    'requestHash', v_request_hash, 'iat', v_iat, 'exp', v_exp,
    'nonce', p_envelope ->> 'nonce'
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Snapshot: what the watchdog used to fetch from an inbound port
-- ---------------------------------------------------------------------------

create or replace function app_private.openclaw_watchdog_snapshot_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_now timestamptz := statement_timestamp();
  v_heartbeat timestamptz;
  v_metrics jsonb := '{}'::jsonb;
  v_cells integer := 0;
  v_ready integer := 0;
begin
  if p_request ->> 'version' <> '1' then
    raise exception 'watchdog snapshot version mismatch' using errcode = '22023';
  end if;

  -- Freshest heartbeat across the organization's current cells. This measures the
  -- END-TO-END path that actually matters (can the cell still reach Supabase),
  -- which an inbound probe of the cell's own HTTP port cannot observe: a cell can
  -- answer a probe cheerfully while its link to Supabase has been down for hours.
  select count(*), count(*) filter (where cell.state = 'READY'), max(cell.last_heartbeat_at)
    into v_cells, v_ready, v_heartbeat
  from public.openclaw_runtime_cells cell
  where cell.organization_id = v_org and cell.is_current;

  -- Newest content-free metric bundle the cell pushed with its heartbeat.
  select event.content_free_metrics into v_metrics
  from public.openclaw_health_events event
  where event.organization_id = v_org
    and event.health_kind = 'RUNTIME_HEARTBEAT'
  order by event.observed_at desc, event.created_at desc
  limit 1;

  return jsonb_build_object(
    'version', 1,
    'organizationId', v_org,
    'observedAt', v_now,
    -- probeOk is false when no current cell is READY or nothing has reported yet;
    -- the Worker's own 90-second staleness rule then decides severity.
    'probeOk', v_cells > 0 and v_ready > 0 and v_heartbeat is not null,
    'heartbeatAt', v_heartbeat,
    'currentCells', v_cells,
    'readyCells', v_ready,
    'metrics', coalesce(v_metrics, '{}'::jsonb)
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Capacity controls: what the watchdog used to POST to an inbound port
-- ---------------------------------------------------------------------------

create or replace function app_private.openclaw_apply_capacity_controls_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := (p_principal ->> 'organizationId')::uuid;
  v_operation uuid;
  v_control text;
  v_reason text;
  v_applied integer := 0;
  v_already integer := 0;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','operationId','controls','reasonFingerprint','requiresManualResume'],
    array['version','operationId','controls','reasonFingerprint','requiresManualResume']
  );
  if p_request ->> 'version' <> '1'
     or jsonb_typeof(p_request -> 'controls') <> 'array'
     or jsonb_array_length(p_request -> 'controls') < 1
     or jsonb_array_length(p_request -> 'controls') > 4
     or jsonb_typeof(p_request -> 'requiresManualResume') <> 'boolean'
  then
    raise exception 'bounded capacity controls required' using errcode = '22023';
  end if;
  v_operation := (p_request ->> 'operationId')::uuid;
  v_reason := p_request ->> 'reasonFingerprint';

  for v_control in select value from jsonb_array_elements_text(p_request -> 'controls') loop
    -- Idempotent by construction: the partial unique index collapses a repeat of
    -- an already-active control, so a retried watchdog tick cannot double-apply.
    insert into public.openclaw_capacity_controls(
      organization_id, control, applied_operation_id, reason_fingerprint,
      requires_manual_resume
    ) values (
      v_org, v_control, v_operation, v_reason,
      (p_request ->> 'requiresManualResume')::boolean
    )
    on conflict (organization_id, control) where released_at is null do nothing;
    if found then v_applied := v_applied + 1; else v_already := v_already + 1; end if;
  end loop;

  return jsonb_build_object(
    'version', 1, 'applied', v_applied, 'alreadyActive', v_already,
    'databaseTime', statement_timestamp()
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Watchdog envelope nonce consumption
-- ---------------------------------------------------------------------------
-- No principal is required: the Edge has already proven the Ed25519 signature
-- over the envelope before calling this. The database's only job here is to make
-- "one-time" durable across isolates, which no in-process map can do.

create or replace function app_private.openclaw_consume_watchdog_envelope_nonce_v1(
  p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_nonce_hash text;
  v_signed_at timestamptz;
  v_inserted uuid;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','keyGeneration','operation','nonce','bodySha256','signedAtEpochSeconds'],
    array['version','organizationId','keyGeneration','operation','nonce','bodySha256','signedAtEpochSeconds']
  );
  if p_request ->> 'version' <> '1'
     or p_request ->> 'nonce' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_request ->> 'bodySha256' !~ '^[0-9a-f]{64}$'
     or p_request ->> 'signedAtEpochSeconds' !~ '^[1-9][0-9]{0,14}$'
  then
    raise exception 'watchdog envelope nonce request invalid' using errcode = '22023';
  end if;

  v_signed_at := to_timestamp((p_request ->> 'signedAtEpochSeconds')::bigint);
  -- The Edge already enforces a 60-second skew window; this bound is the
  -- database refusing to store anything it could not have just authenticated.
  if abs(extract(epoch from (statement_timestamp() - v_signed_at))) > 90 then
    raise exception 'watchdog envelope is outside the database clock window'
      using errcode = '42501';
  end if;

  v_nonce_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-watchdog-envelope-nonce-v1', 'UTF8')
      || decode('00', 'hex') || convert_to(p_request ->> 'operation', 'UTF8')
      || decode('00', 'hex') || convert_to(p_request ->> 'nonce', 'UTF8'),
    'sha256'
  ), 'hex');

  insert into public.openclaw_watchdog_envelope_nonces(
    organization_id, key_generation, operation, nonce_hash, body_sha256,
    signed_at, expires_at
  ) values (
    (p_request ->> 'organizationId')::uuid,
    (p_request ->> 'keyGeneration')::bigint,
    p_request ->> 'operation',
    v_nonce_hash,
    p_request ->> 'bodySha256',
    v_signed_at,
    v_signed_at + interval '90 seconds'
  )
  on conflict (organization_id, nonce_hash) do nothing
  returning id into v_inserted;

  if v_inserted is null then
    raise exception 'watchdog envelope nonce replay rejected' using errcode = '42501';
  end if;

  -- Opportunistic prune keeps the table bounded without a scheduled job; the
  -- watchdog runs once a minute, so this stays small.
  delete from public.openclaw_watchdog_envelope_nonces
  where expires_at < statement_timestamp() - interval '10 minutes';

  return jsonb_build_object('version', 1, 'consumed', true);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Public service wrappers
-- ---------------------------------------------------------------------------

create or replace function public.openclaw_service_watchdog_snapshot_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_watchdog_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_watchdog_snapshot_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_watchdog_snapshot_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_apply_capacity_controls_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_context jsonb;
begin
  v_context := app_private.openclaw_watchdog_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_apply_capacity_controls_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  return app_private.openclaw_apply_capacity_controls_v1(v_context, p_envelope, p_request);
end;
$function$;

create or replace function public.openclaw_service_consume_watchdog_envelope_nonce_v1(
  p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return app_private.openclaw_consume_watchdog_envelope_nonce_v1(p_request);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 8. Capacity controls reach the cell in the heartbeat it already makes
-- ---------------------------------------------------------------------------
-- Only the thin public wrapper changes; app_private.openclaw_runtime_heartbeat_v1
-- keeps its exact reviewed body. The cell learns about active controls in the
-- response of the call it already makes every minute, so no inbound port, no new
-- command kind, and no change to the runtime command state machine are needed.

create or replace function public.openclaw_service_runtime_heartbeat_v1(
  p_principal jsonb, p_envelope jsonb, p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_context jsonb;
  v_result jsonb;
  v_controls jsonb;
begin
  v_context := app_private.openclaw_validate_service_context_v1(
    p_principal, p_envelope, p_request, 'openclaw_runtime_heartbeat_v1'
  );
  v_context := app_private.openclaw_consume_service_nonce_v1(
    v_context, p_envelope, p_request, 'RUNTIME'
  );
  v_result := app_private.openclaw_runtime_heartbeat_v1(v_context, p_envelope, p_request);

  select coalesce(jsonb_agg(jsonb_build_object(
    'control', control.control,
    'appliedAt', control.applied_at,
    'reasonFingerprint', control.reason_fingerprint,
    'requiresManualResume', control.requires_manual_resume
  ) order by control.control), '[]'::jsonb) into v_controls
  from public.openclaw_capacity_controls control
  where control.organization_id = (v_context ->> 'organizationId')::uuid
    and control.released_at is null;

  return v_result || jsonb_build_object('capacityControls', v_controls);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 9. Ownership and grants
-- ---------------------------------------------------------------------------

alter table public.openclaw_capacity_controls owner to openclaw_maintenance_writer;
alter table public.openclaw_watchdog_envelope_nonces owner to openclaw_maintenance_writer;

alter function app_private.openclaw_watchdog_service_context_v1(jsonb,jsonb,jsonb,text)
  owner to openclaw_maintenance_writer;
alter function app_private.openclaw_watchdog_snapshot_v1(jsonb,jsonb,jsonb)
  owner to openclaw_maintenance_writer;
alter function app_private.openclaw_apply_capacity_controls_v1(jsonb,jsonb,jsonb)
  owner to openclaw_maintenance_writer;
alter function app_private.openclaw_consume_watchdog_envelope_nonce_v1(jsonb)
  owner to openclaw_maintenance_writer;

revoke all on function app_private.openclaw_watchdog_service_context_v1(jsonb,jsonb,jsonb,text)
  from public, anon, authenticated, service_role;
revoke all on function app_private.openclaw_watchdog_snapshot_v1(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function app_private.openclaw_apply_capacity_controls_v1(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function app_private.openclaw_consume_watchdog_envelope_nonce_v1(jsonb)
  from public, anon, authenticated, service_role;

grant execute on function app_private.openclaw_watchdog_service_context_v1(jsonb,jsonb,jsonb,text)
  to openclaw_service_dispatcher;
grant execute on function app_private.openclaw_watchdog_snapshot_v1(jsonb,jsonb,jsonb)
  to openclaw_service_dispatcher;
grant execute on function app_private.openclaw_apply_capacity_controls_v1(jsonb,jsonb,jsonb)
  to openclaw_service_dispatcher;
grant execute on function app_private.openclaw_consume_watchdog_envelope_nonce_v1(jsonb)
  to openclaw_service_dispatcher;

alter function public.openclaw_service_watchdog_snapshot_v1(jsonb,jsonb,jsonb)
  owner to openclaw_service_dispatcher;
alter function public.openclaw_service_apply_capacity_controls_v1(jsonb,jsonb,jsonb)
  owner to openclaw_service_dispatcher;
alter function public.openclaw_service_consume_watchdog_envelope_nonce_v1(jsonb)
  owner to openclaw_service_dispatcher;

revoke all on function public.openclaw_service_watchdog_snapshot_v1(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.openclaw_service_apply_capacity_controls_v1(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.openclaw_service_consume_watchdog_envelope_nonce_v1(jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.openclaw_service_watchdog_snapshot_v1(jsonb,jsonb,jsonb)
  to service_role;
grant execute on function public.openclaw_service_apply_capacity_controls_v1(jsonb,jsonb,jsonb)
  to service_role;
grant execute on function public.openclaw_service_consume_watchdog_envelope_nonce_v1(jsonb)
  to service_role;


-- ---------------------------------------------------------------------------
-- 10. Migration and recovery facades the two operator adapters call
-- ---------------------------------------------------------------------------
-- openclaw-migration-adapter.mjs and openclaw-recovery-adapter.mjs delegate their
-- state changes here. Without these functions both scripts fail closed at step 1,
-- which is safe but means neither the VPS migration nor the restore drill can ever
-- complete.
--
-- These take p_request only and are granted to service_role alone: they are
-- operator tools run from the host with the service key, not a runtime principal
-- holding a lease. Every one is CAS- or state-guarded so a repeated call from a
-- retried step cannot double-apply, and every one names its exact organization.

create or replace function app_private.openclaw_migration_scope_v1(p_request jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid;
begin
  if p_request ->> 'version' <> '1' then
    raise exception 'migration request version mismatch' using errcode = '22023';
  end if;
  v_org := nullif(p_request ->> 'organizationId', '')::uuid;
  if v_org is null then
    raise exception 'migration request organization is required' using errcode = '22023';
  end if;
  -- Deliberately NO existence probe against public.organizations: that would need a
  -- table grant for this owner, widening it for a check the data model already makes.
  -- Writes are FK-bound to a real organization, and a bogus id simply matches no rows.
  return v_org;
end;
$function$;

create or replace function app_private.openclaw_set_global_stop_v1(
  p_request jsonb, p_stop boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := app_private.openclaw_migration_scope_v1(p_request);
  v_version bigint;
begin
  -- Idempotent by design: a retried step finds the flag already in the target
  -- state and reports success without inventing a second control version.
  insert into public.openclaw_control_states(organization_id, control_key, global_stop, reason)
  values (v_org, 'GLOBAL_STOP', p_stop, left(coalesce(p_request ->> 'reason', ''), 200))
  on conflict (organization_id, control_key) do update
    set global_stop = excluded.global_stop,
        reason = excluded.reason,
        control_version = public.openclaw_control_states.control_version
          + case when public.openclaw_control_states.global_stop is distinct from excluded.global_stop
              then 1 else 0 end,
        updated_at = clock_timestamp()
  returning control_version into v_version;
  return jsonb_build_object(
    'version', 1, 'globalStopActive', p_stop, 'controlVersion', v_version
  );
end;
$function$;

create or replace function app_private.openclaw_drain_outbox_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := app_private.openclaw_migration_scope_v1(p_request);
  v_returned integer;
begin
  -- Return leased-but-not-yet-dispatching work to the queue. DISPATCHING is left
  -- alone on purpose: its outcome is unknown until the provider answers, and
  -- requeueing it would risk a duplicate send.
  with returned as (
    update public.openclaw_outbox
      set state = 'QUEUED', claim_token_hash = null, lease_expires_at = null
      where organization_id = v_org and state = 'LEASED'
      returning 1
  )
  select count(*) into v_returned from returned;
  return jsonb_build_object('version', 1, 'applied', true, 'affected', v_returned);
end;
$function$;

create or replace function app_private.openclaw_freeze_outbox_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := app_private.openclaw_migration_scope_v1(p_request);
  v_states text[];
  v_frozen integer;
begin
  if jsonb_typeof(p_request -> 'states') <> 'array'
     or jsonb_array_length(p_request -> 'states') < 1 then
    raise exception 'freeze states are required' using errcode = '22023';
  end if;
  select array_agg(value) into v_states from jsonb_array_elements_text(p_request -> 'states');
  if not (v_states <@ array['QUEUED','LEASED']::text[]) then
    raise exception 'freeze states must be a subset of QUEUED,LEASED' using errcode = '22023';
  end if;
  -- Freezing IS GLOBAL_STOP plus a drained queue; this step refuses to claim the
  -- outbox is frozen while sends could still start.
  if not exists (
    select 1 from public.openclaw_control_states control
    where control.organization_id = v_org and control.global_stop
  ) then
    raise exception 'outbox cannot be frozen while GLOBAL_STOP is inactive' using errcode = '42501';
  end if;
  select count(*) into v_frozen from public.openclaw_outbox
  where organization_id = v_org and state = any(v_states);
  return jsonb_build_object('version', 1, 'applied', true, 'affected', v_frozen);
end;
$function$;

create or replace function app_private.openclaw_expire_dispatching_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := app_private.openclaw_migration_scope_v1(p_request);
  v_moved integer;
begin
  -- Expired DISPATCHING becomes UNKNOWN and NEVER retries: the provider may have
  -- delivered it already. An operator resolves each one explicitly.
  with moved as (
    update public.openclaw_outbox
      set state = 'UNKNOWN', terminal_at = clock_timestamp(),
          claim_token_hash = null, lease_expires_at = null
      where organization_id = v_org and state = 'DISPATCHING'
        and lease_expires_at is not null and lease_expires_at <= clock_timestamp()
      returning 1
  )
  select count(*) into v_moved from moved;
  return jsonb_build_object('version', 1, 'applied', true, 'affected', v_moved);
end;
$function$;

create or replace function app_private.openclaw_reconcile_migration_gaps_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := app_private.openclaw_migration_scope_v1(p_request);
  v_unresolved integer;
begin
  select count(*) into v_unresolved from public.openclaw_outbox
  where organization_id = v_org and state = 'UNKNOWN' and resolution_version = 0;
  -- Fail closed: an operator must resolve every UNKNOWN before the organization
  -- resumes, otherwise a possibly-delivered message stays ambiguous forever.
  if v_unresolved > 0 then
    raise exception 'migration leaves % unresolved UNKNOWN rows; operator resolution is required',
      v_unresolved using errcode = '42501';
  end if;
  return jsonb_build_object('version', 1, 'applied', true, 'affected', 0);
end;
$function$;

create or replace function public.openclaw_service_begin_global_stop_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return app_private.openclaw_set_global_stop_v1(p_request, true);
end;
$function$;

create or replace function public.openclaw_service_resume_after_migration_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
begin
  -- Resume is the one irreversible step, so it re-checks the gate rather than
  -- trusting that the reconcile step ran earlier in the same script. The check runs
  -- through the app_private helper, whose owner holds the table grant: doing the
  -- count here would need openclaw_service_dispatcher to read openclaw_outbox.
  perform app_private.openclaw_reconcile_migration_gaps_v1(p_request);
  v_result := app_private.openclaw_set_global_stop_v1(p_request, false);
  return v_result || jsonb_build_object('resumed', true);
end;
$function$;

create or replace function public.openclaw_service_drain_outbox_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return app_private.openclaw_drain_outbox_v1(p_request);
end;
$function$;

create or replace function public.openclaw_service_freeze_outbox_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return app_private.openclaw_freeze_outbox_v1(p_request);
end;
$function$;

create or replace function public.openclaw_service_expire_dispatching_to_unknown_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return app_private.openclaw_expire_dispatching_v1(p_request);
end;
$function$;

create or replace function public.openclaw_service_reconcile_migration_gaps_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return app_private.openclaw_reconcile_migration_gaps_v1(p_request);
end;
$function$;

alter function app_private.openclaw_migration_scope_v1(jsonb)
  owner to openclaw_maintenance_writer;
alter function app_private.openclaw_set_global_stop_v1(jsonb, boolean)
  owner to openclaw_maintenance_writer;
alter function app_private.openclaw_drain_outbox_v1(jsonb)
  owner to openclaw_maintenance_writer;
alter function app_private.openclaw_freeze_outbox_v1(jsonb)
  owner to openclaw_maintenance_writer;
alter function app_private.openclaw_expire_dispatching_v1(jsonb)
  owner to openclaw_maintenance_writer;
alter function app_private.openclaw_reconcile_migration_gaps_v1(jsonb)
  owner to openclaw_maintenance_writer;

revoke all on function app_private.openclaw_migration_scope_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function app_private.openclaw_set_global_stop_v1(jsonb, boolean)
  from public, anon, authenticated, service_role;
revoke all on function app_private.openclaw_drain_outbox_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function app_private.openclaw_freeze_outbox_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function app_private.openclaw_expire_dispatching_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function app_private.openclaw_reconcile_migration_gaps_v1(jsonb)
  from public, anon, authenticated, service_role;

alter function public.openclaw_service_begin_global_stop_v1(jsonb)
  owner to openclaw_service_dispatcher;
alter function public.openclaw_service_resume_after_migration_v1(jsonb)
  owner to openclaw_service_dispatcher;
alter function public.openclaw_service_drain_outbox_v1(jsonb)
  owner to openclaw_service_dispatcher;
alter function public.openclaw_service_freeze_outbox_v1(jsonb)
  owner to openclaw_service_dispatcher;
alter function public.openclaw_service_expire_dispatching_to_unknown_v1(jsonb)
  owner to openclaw_service_dispatcher;
alter function public.openclaw_service_reconcile_migration_gaps_v1(jsonb)
  owner to openclaw_service_dispatcher;

revoke all on function public.openclaw_service_begin_global_stop_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.openclaw_service_resume_after_migration_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.openclaw_service_drain_outbox_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.openclaw_service_freeze_outbox_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.openclaw_service_expire_dispatching_to_unknown_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.openclaw_service_reconcile_migration_gaps_v1(jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.openclaw_service_begin_global_stop_v1(jsonb)
  to service_role;
grant execute on function public.openclaw_service_resume_after_migration_v1(jsonb)
  to service_role;
grant execute on function public.openclaw_service_drain_outbox_v1(jsonb)
  to service_role;
grant execute on function public.openclaw_service_freeze_outbox_v1(jsonb)
  to service_role;
grant execute on function public.openclaw_service_expire_dispatching_to_unknown_v1(jsonb)
  to service_role;
grant execute on function public.openclaw_service_reconcile_migration_gaps_v1(jsonb)
  to service_role;

create policy openclaw_control_states_migration_writer_all
  on public.openclaw_control_states for all to openclaw_maintenance_writer
  using (true) with check (true);
create policy openclaw_outbox_migration_writer_all
  on public.openclaw_outbox for all to openclaw_maintenance_writer
  using (true) with check (true);
grant select, insert, update on public.openclaw_control_states
  to openclaw_maintenance_writer;
grant select, update on public.openclaw_outbox to openclaw_maintenance_writer;


-- ---------------------------------------------------------------------------
-- 11. Credential, lease and session facades for the migration adapter
-- ---------------------------------------------------------------------------
-- Same contract as section 10: p_request only, service_role only, every step
-- guarded so a retried invocation cannot double-apply.

create or replace function app_private.openclaw_migration_cells_v1(p_request jsonb)
returns table(organization_id uuid, old_cell uuid, new_cell uuid)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := app_private.openclaw_migration_scope_v1(p_request);
  v_old uuid := nullif(p_request ->> 'oldCellId', '')::uuid;
  v_new uuid := nullif(p_request ->> 'newCellId', '')::uuid;
begin
  if v_old is null or v_new is null or v_old = v_new then
    raise exception 'migration requires distinct old and new cell ids' using errcode = '22023';
  end if;
  return query select v_org, v_old, v_new;
end;
$function$;

create or replace function public.openclaw_service_acquire_migration_lease_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_scope record;
  v_account uuid;
  v_old_token bigint;
  v_old_generation bigint;
  v_new_token bigint;
begin
  select * into v_scope from app_private.openclaw_migration_cells_v1(p_request);

  -- The new cell must fence STRICTLY above every lease the organization has ever
  -- issued, not merely above the old cell's: a lease left behind by an earlier
  -- failed migration would otherwise still out-rank the new one.
  select lease.account_id, max(lease.fencing_token), max(lease.lease_generation)
    into v_account, v_old_token, v_old_generation
  from public.openclaw_runtime_leases lease
  where lease.organization_id = v_scope.organization_id
  group by lease.account_id
  order by max(lease.fencing_token) desc
  limit 1;

  if v_account is null then
    raise exception 'no existing lease to advance from' using errcode = 'P0002';
  end if;

  -- Idempotent: a retry finds the new cell already holding the higher lease.
  select lease.fencing_token into v_new_token
  from public.openclaw_runtime_leases lease
  where lease.organization_id = v_scope.organization_id
    and lease.cell_id = v_scope.new_cell and lease.status = 'ACTIVE'
    and lease.fencing_token > v_old_token;

  if v_new_token is null then
    insert into public.openclaw_runtime_leases(
      organization_id, account_id, cell_id, lease_generation, fencing_token,
      status, expires_at
    ) values (
      v_scope.organization_id, v_account, v_scope.new_cell,
      v_old_generation + 1, v_old_token + 1, 'ACTIVE',
      clock_timestamp() + interval '1 hour'
    )
    returning fencing_token into v_new_token;
  end if;

  if v_new_token <= v_old_token then
    raise exception 'new fencing token did not advance' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'version', 1, 'oldFencingToken', v_old_token, 'newFencingToken', v_new_token
  );
end;
$function$;

create or replace function public.openclaw_service_revoke_migration_lease_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_scope record;
  v_revoked integer;
begin
  select * into v_scope from app_private.openclaw_migration_cells_v1(p_request);

  -- Refuse to fence the old cell before the new one actually holds a higher lease;
  -- doing it in the wrong order leaves the organization with no active cell at all.
  if not exists (
    select 1 from public.openclaw_runtime_leases new_lease
    where new_lease.organization_id = v_scope.organization_id
      and new_lease.cell_id = v_scope.new_cell and new_lease.status = 'ACTIVE'
  ) then
    raise exception 'new cell holds no active lease; refusing to revoke the old one'
      using errcode = '42501';
  end if;

  with revoked as (
    update public.openclaw_runtime_leases
      set status = 'REVOKED', released_at = clock_timestamp()
      where organization_id = v_scope.organization_id
        and cell_id = v_scope.old_cell and status = 'ACTIVE'
      returning 1
  )
  select count(*) into v_revoked from revoked;

  update public.openclaw_runtime_credentials
    set revoked_at = clock_timestamp(), revoked_reason = 'vps-migration'
    where organization_id = v_scope.organization_id
      and cell_id = v_scope.old_cell and revoked_at is null;

  return jsonb_build_object('version', 1, 'applied', true, 'affected', v_revoked);
end;
$function$;

create or replace function public.openclaw_service_rotate_migration_credentials_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_scope record;
  v_rotated integer;
begin
  select * into v_scope from app_private.openclaw_migration_cells_v1(p_request);
  -- Rotation here means retiring the OLD cell's credentials. The new credential is
  -- minted out of band and never travels through this facade: a credential value
  -- in a request body would end up in logs and evidence.
  with rotated as (
    update public.openclaw_runtime_credentials
      set revoked_at = clock_timestamp(), revoked_reason = 'vps-migration-rotate'
      where organization_id = v_scope.organization_id
        and cell_id = v_scope.old_cell and revoked_at is null
      returning 1
  )
  select count(*) into v_rotated from rotated;
  return jsonb_build_object('version', 1, 'applied', true, 'affected', v_rotated);
end;
$function$;

create or replace function public.openclaw_service_require_fresh_qr_login_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := app_private.openclaw_migration_scope_v1(p_request);
  v_accounts integer;
begin
  -- A session is never copied or restored: advancing session_generation invalidates
  -- every credential, ticket and challenge bound to the old one, so the only way
  -- back is a fresh QR scan by a human.
  with invalidated as (
    update public.openclaw_accounts
      set session_generation = session_generation + 1,
          connection_state = 'RECONNECT_REQUIRED',
          session_risk_state = 'INVALID',
          updated_at = clock_timestamp()
      where organization_id = v_org and is_active
      returning 1
  )
  select count(*) into v_accounts from invalidated;

  update public.openclaw_qr_challenges
    set revoked_at = clock_timestamp()
    where organization_id = v_org and revoked_at is null and consumed_at is null;

  return jsonb_build_object(
    'version', 1, 'sessionInvalidated', true, 'affected', v_accounts
  );
end;
$function$;

alter function app_private.openclaw_migration_cells_v1(jsonb)
  owner to openclaw_maintenance_writer;
revoke all on function app_private.openclaw_migration_cells_v1(jsonb)
  from public, anon, authenticated, service_role;

alter function public.openclaw_service_acquire_migration_lease_v1(jsonb)
  owner to openclaw_service_dispatcher;
alter function public.openclaw_service_revoke_migration_lease_v1(jsonb)
  owner to openclaw_service_dispatcher;
alter function public.openclaw_service_rotate_migration_credentials_v1(jsonb)
  owner to openclaw_service_dispatcher;
alter function public.openclaw_service_require_fresh_qr_login_v1(jsonb)
  owner to openclaw_service_dispatcher;

revoke all on function public.openclaw_service_acquire_migration_lease_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.openclaw_service_revoke_migration_lease_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.openclaw_service_rotate_migration_credentials_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.openclaw_service_require_fresh_qr_login_v1(jsonb)
  from public, anon, authenticated, service_role;

grant execute on function public.openclaw_service_acquire_migration_lease_v1(jsonb)
  to service_role;
grant execute on function public.openclaw_service_revoke_migration_lease_v1(jsonb)
  to service_role;
grant execute on function public.openclaw_service_rotate_migration_credentials_v1(jsonb)
  to service_role;
grant execute on function public.openclaw_service_require_fresh_qr_login_v1(jsonb)
  to service_role;

create policy openclaw_runtime_leases_migration_writer_all
  on public.openclaw_runtime_leases for all to openclaw_maintenance_writer
  using (true) with check (true);
create policy openclaw_accounts_migration_writer_all
  on public.openclaw_accounts for all to openclaw_maintenance_writer
  using (true) with check (true);
grant select, insert, update on public.openclaw_runtime_leases
  to openclaw_maintenance_writer;
grant select, update on public.openclaw_accounts to openclaw_maintenance_writer;
grant update on public.openclaw_qr_challenges to openclaw_maintenance_writer;


-- The public facades are owned by openclaw_service_dispatcher, which is NOINHERIT
-- and holds no membership in openclaw_maintenance_writer. Revoking without granting
-- left every one of them raising 42501 at runtime, invisible to a suite that runs
-- PGlite as superuser.
grant execute on function app_private.openclaw_migration_scope_v1(jsonb)
  to openclaw_service_dispatcher;
grant execute on function app_private.openclaw_set_global_stop_v1(jsonb, boolean)
  to openclaw_service_dispatcher;
grant execute on function app_private.openclaw_drain_outbox_v1(jsonb)
  to openclaw_service_dispatcher;
grant execute on function app_private.openclaw_freeze_outbox_v1(jsonb)
  to openclaw_service_dispatcher;
grant execute on function app_private.openclaw_expire_dispatching_v1(jsonb)
  to openclaw_service_dispatcher;
grant execute on function app_private.openclaw_reconcile_migration_gaps_v1(jsonb)
  to openclaw_service_dispatcher;
grant execute on function app_private.openclaw_migration_cells_v1(jsonb)
  to openclaw_service_dispatcher;


-- ---------------------------------------------------------------------------
-- 12. Lease handover, corrected
-- ---------------------------------------------------------------------------
-- The first version was unrunnable and unsafe in two ways.
--
-- `openclaw_runtime_leases_one_effective_uidx` is a partial UNIQUE INDEX on
-- (organization_id, account_id) where status='ACTIVE'. Indexes are checked per
-- statement, so "insert the new ACTIVE lease, then in a LATER step revoke the old
-- one" can never work: the insert always collides. And the revoke step refused to
-- run until the new lease existed, so neither step could go first - the migration
-- deadlocked at step 8 every time.
--
-- The second flaw: the old version picked ONE account by `max(fencing_token)`,
-- while the revoke step retired the old cell's leases for EVERY account. An
-- organization with N accounts lost N-1 leases with nothing to replace them.
--
-- Acquire is therefore the atomic HANDOVER, per account, in one statement pair
-- inside one function. Revoke then only retires credentials and verifies.

create or replace function app_private.openclaw_handover_leases_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_scope record;
  v_account uuid;
  v_old_token bigint;
  v_old_generation bigint;
  v_moved integer := 0;
  v_already integer := 0;
begin
  select * into v_scope from app_private.openclaw_migration_cells_v1(p_request);

  -- The account is derived FROM THE NEW CELL, not guessed from fencing tokens:
  -- openclaw_runtime_cells rows are per (organization, account), so a --new-cell id
  -- belongs to exactly one account, and the lease FK is (org, account, cell).
  -- Guessing by max(fencing_token) could pick an account the new cell is not for,
  -- which the foreign key then rejects.
  for v_account in
    select cell.account_id
    from public.openclaw_runtime_cells cell
    where cell.organization_id = v_scope.organization_id
      and cell.id = v_scope.new_cell
  loop
    -- Idempotent: a retried step finds this account already handed over.
    if exists (
      select 1 from public.openclaw_runtime_leases lease
      where lease.organization_id = v_scope.organization_id
        and lease.account_id = v_account
        and lease.cell_id = v_scope.new_cell
        and lease.status = 'ACTIVE' and lease.released_at is null
    ) then
      v_already := v_already + 1;
      continue;
    end if;

    -- Fence strictly above every lease this account has EVER held, not merely above
    -- the old cell's: a lease left behind by an aborted migration would otherwise
    -- still out-rank the new one.
    select max(lease.fencing_token), max(lease.lease_generation)
      into v_old_token, v_old_generation
    from public.openclaw_runtime_leases lease
    where lease.organization_id = v_scope.organization_id
      and lease.account_id = v_account;

    update public.openclaw_runtime_leases
      set status = 'REVOKED', released_at = clock_timestamp()
      where organization_id = v_scope.organization_id
        and account_id = v_account
        and status = 'ACTIVE' and released_at is null;

    insert into public.openclaw_runtime_leases(
      organization_id, account_id, cell_id, lease_generation, fencing_token,
      status, expires_at
    ) values (
      v_scope.organization_id, v_account, v_scope.new_cell,
      coalesce(v_old_generation, 0) + 1, coalesce(v_old_token, 0) + 1, 'ACTIVE',
      clock_timestamp() + interval '1 hour'
    );
    v_moved := v_moved + 1;
  end loop;

  if v_moved = 0 and v_already = 0 then
    raise exception 'no lease exists to hand over' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'version', 1, 'movedAccounts', v_moved, 'alreadyOnNewCell', v_already
  );
end;
$function$;

create or replace function app_private.openclaw_retire_old_cell_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_scope record;
  v_pending integer;
  v_credentials integer;
begin
  select * into v_scope from app_private.openclaw_migration_cells_v1(p_request);

  -- Refuse while ANY account still lacks an active lease on the new cell. The old
  -- version checked only that SOME lease existed, which a stale lower-token lease
  -- from an aborted migration would satisfy while the organization still had
  -- accounts pointing nowhere.
  -- Only accounts that still hold an ACTIVE lease need a replacement. Counting
  -- every account that ever had a lease row blocked revoke and rotate FOREVER:
  -- replacing an account deactivates the old one (one active account per
  -- organization), and its historical REVOKED lease can never move to the new
  -- cell, because the lease FK ties a cell to exactly one account.
  select count(*) into v_pending
  from (
    select distinct lease.account_id
    from public.openclaw_runtime_leases lease
    where lease.organization_id = v_scope.organization_id
      and lease.status = 'ACTIVE' and lease.released_at is null
  ) account
  where not exists (
    select 1 from public.openclaw_runtime_leases lease
    where lease.organization_id = v_scope.organization_id
      and lease.account_id = account.account_id
      and lease.cell_id = v_scope.new_cell
      and lease.status = 'ACTIVE' and lease.released_at is null
  );
  if v_pending > 0 then
    raise exception '% account(s) still hold no active lease on the new cell', v_pending
      using errcode = '42501';
  end if;

  with retired as (
    update public.openclaw_runtime_credentials
      set revoked_at = clock_timestamp(), revoked_reason = 'vps-migration'
      where organization_id = v_scope.organization_id
        and cell_id = v_scope.old_cell and revoked_at is null
      returning 1
  )
  select count(*) into v_credentials from retired;

  return jsonb_build_object('version', 1, 'applied', true, 'affected', v_credentials);
end;
$function$;

create or replace function public.openclaw_service_acquire_migration_lease_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return app_private.openclaw_handover_leases_v1(p_request);
end;
$function$;

create or replace function public.openclaw_service_revoke_migration_lease_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return app_private.openclaw_retire_old_cell_v1(p_request);
end;
$function$;

create or replace function public.openclaw_service_rotate_migration_credentials_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Rotation retires the OLD cell's credentials. The new credential is minted out of
  -- band and never travels through this facade: a credential value in a request body
  -- would land in logs and evidence.
  return app_private.openclaw_retire_old_cell_v1(p_request);
end;
$function$;

create or replace function app_private.openclaw_require_fresh_qr_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid := app_private.openclaw_migration_scope_v1(p_request);
  v_accounts integer;
begin
  -- A session is never copied or restored: advancing session_generation invalidates
  -- every credential, ticket and challenge bound to the old one, so the only way back
  -- is a fresh QR scan by a human.
  with invalidated as (
    update public.openclaw_accounts
      set session_generation = session_generation + 1,
          connection_state = 'RECONNECT_REQUIRED',
          session_risk_state = 'INVALID',
          updated_at = clock_timestamp()
      where organization_id = v_org and is_active
        -- Idempotent: a retried step after the human already re-scanned must not
        -- kill the fresh session.
        and connection_state <> 'RECONNECT_REQUIRED'
      returning 1
  )
  select count(*) into v_accounts from invalidated;

  update public.openclaw_qr_challenges
    set revoked_at = clock_timestamp()
    where organization_id = v_org and revoked_at is null and consumed_at is null;

  return jsonb_build_object(
    'version', 1, 'sessionInvalidated', true, 'affected', v_accounts
  );
end;
$function$;

create or replace function public.openclaw_service_require_fresh_qr_login_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return app_private.openclaw_require_fresh_qr_v1(p_request);
end;
$function$;

alter function app_private.openclaw_handover_leases_v1(jsonb)
  owner to openclaw_maintenance_writer;
alter function app_private.openclaw_retire_old_cell_v1(jsonb)
  owner to openclaw_maintenance_writer;
alter function app_private.openclaw_require_fresh_qr_v1(jsonb)
  owner to openclaw_maintenance_writer;

revoke all on function app_private.openclaw_handover_leases_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function app_private.openclaw_retire_old_cell_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function app_private.openclaw_require_fresh_qr_v1(jsonb)
  from public, anon, authenticated, service_role;

grant execute on function app_private.openclaw_handover_leases_v1(jsonb)
  to openclaw_service_dispatcher;
grant execute on function app_private.openclaw_retire_old_cell_v1(jsonb)
  to openclaw_service_dispatcher;
grant execute on function app_private.openclaw_require_fresh_qr_v1(jsonb)
  to openclaw_service_dispatcher;

grant select, insert, update on public.openclaw_runtime_credentials
  to openclaw_maintenance_writer;
create policy openclaw_runtime_credentials_migration_writer_all
  on public.openclaw_runtime_credentials for all to openclaw_maintenance_writer
  using (true) with check (true);


-- ---------------------------------------------------------------------------
-- 13. A dedicated role for the migration surface
-- ---------------------------------------------------------------------------
-- The migration helpers were owned by openclaw_maintenance_writer, the role the
-- retention/audit CRON runs as. Every policy they needed therefore widened that
-- role: the cron job ended up with cross-organization write authority over
-- GLOBAL_STOP, the outbox, leases, credentials and account session state - none of
-- which it has any business touching.
--
-- Ownership moves to a role that exists only for the VPS migration surface, so the
-- blast radius of these policies is exactly the migration facades.

do $migration_role$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'openclaw_migration_writer') then
    create role openclaw_migration_writer with NOLOGIN NOINHERIT NOBYPASSRLS;
  else
    alter role openclaw_migration_writer with NOLOGIN NOINHERIT NOBYPASSRLS;
  end if;
end;
$migration_role$;

grant usage on schema public, app_private, extensions to openclaw_migration_writer;

-- Re-own the migration helpers.
alter function app_private.openclaw_migration_scope_v1(jsonb)
  owner to openclaw_migration_writer;
alter function app_private.openclaw_migration_cells_v1(jsonb)
  owner to openclaw_migration_writer;
alter function app_private.openclaw_set_global_stop_v1(jsonb, boolean)
  owner to openclaw_migration_writer;
alter function app_private.openclaw_drain_outbox_v1(jsonb)
  owner to openclaw_migration_writer;
alter function app_private.openclaw_freeze_outbox_v1(jsonb)
  owner to openclaw_migration_writer;
alter function app_private.openclaw_expire_dispatching_v1(jsonb)
  owner to openclaw_migration_writer;
alter function app_private.openclaw_reconcile_migration_gaps_v1(jsonb)
  owner to openclaw_migration_writer;
alter function app_private.openclaw_handover_leases_v1(jsonb)
  owner to openclaw_migration_writer;
alter function app_private.openclaw_retire_old_cell_v1(jsonb)
  owner to openclaw_migration_writer;
alter function app_private.openclaw_require_fresh_qr_v1(jsonb)
  owner to openclaw_migration_writer;

-- Re-grant execute: changing the owner does not carry the previous grants.
grant execute on function app_private.openclaw_migration_scope_v1(jsonb),
  app_private.openclaw_migration_cells_v1(jsonb),
  app_private.openclaw_set_global_stop_v1(jsonb, boolean),
  app_private.openclaw_drain_outbox_v1(jsonb),
  app_private.openclaw_freeze_outbox_v1(jsonb),
  app_private.openclaw_expire_dispatching_v1(jsonb),
  app_private.openclaw_reconcile_migration_gaps_v1(jsonb),
  app_private.openclaw_handover_leases_v1(jsonb),
  app_private.openclaw_retire_old_cell_v1(jsonb),
  app_private.openclaw_require_fresh_qr_v1(jsonb)
  to openclaw_service_dispatcher;

-- Retire the policies that widened the retention role.
drop policy if exists openclaw_control_states_migration_writer_all
  on public.openclaw_control_states;
drop policy if exists openclaw_outbox_migration_writer_all
  on public.openclaw_outbox;
drop policy if exists openclaw_runtime_leases_migration_writer_all
  on public.openclaw_runtime_leases;
drop policy if exists openclaw_accounts_migration_writer_all
  on public.openclaw_accounts;
drop policy if exists openclaw_runtime_credentials_migration_writer_all
  on public.openclaw_runtime_credentials;

-- Revoke ONLY what section 10/11 granted, verb by verb. A blanket
-- `revoke all ... from openclaw_maintenance_writer` also stripped grants that
-- PRE-DATE this task - select/update on openclaw_outbox (rpc_surface), and select
-- on openclaw_control_states / openclaw_runtime_credentials from the retention
-- source loop above - which broke the smoke cleanup and retention scanning cron
-- with 42501 in production.
revoke insert, update on public.openclaw_control_states from openclaw_maintenance_writer;
revoke select, insert, update on public.openclaw_runtime_leases from openclaw_maintenance_writer;
revoke select, update on public.openclaw_accounts from openclaw_maintenance_writer;
revoke insert, update on public.openclaw_runtime_credentials from openclaw_maintenance_writer;
revoke update on public.openclaw_qr_challenges from openclaw_maintenance_writer;

-- Grant the migration role exactly the verbs its facades use, no more.
grant select, insert, update on public.openclaw_control_states
  to openclaw_migration_writer;
grant select, update on public.openclaw_outbox to openclaw_migration_writer;
grant select, insert, update on public.openclaw_runtime_leases
  to openclaw_migration_writer;
grant select, update on public.openclaw_accounts to openclaw_migration_writer;
grant select, update on public.openclaw_runtime_credentials
  to openclaw_migration_writer;
grant select on public.openclaw_runtime_cells to openclaw_migration_writer;
grant update on public.openclaw_qr_challenges to openclaw_migration_writer;

create policy openclaw_control_states_migration_writer_all
  on public.openclaw_control_states for all to openclaw_migration_writer
  using (true) with check (true);
create policy openclaw_outbox_migration_writer_all
  on public.openclaw_outbox for all to openclaw_migration_writer
  using (true) with check (true);
create policy openclaw_runtime_leases_migration_writer_all
  on public.openclaw_runtime_leases for all to openclaw_migration_writer
  using (true) with check (true);
create policy openclaw_accounts_migration_writer_all
  on public.openclaw_accounts for all to openclaw_migration_writer
  using (true) with check (true);
create policy openclaw_runtime_credentials_migration_writer_all
  on public.openclaw_runtime_credentials for all to openclaw_migration_writer
  using (true) with check (true);
create policy openclaw_runtime_cells_migration_writer_select
  on public.openclaw_runtime_cells for select to openclaw_migration_writer
  using (true);
create policy openclaw_qr_challenges_migration_writer_update
  on public.openclaw_qr_challenges for update to openclaw_migration_writer
  using (true) with check (true);


-- ---------------------------------------------------------------------------
-- 14. Every migration facade leaves a trace
-- ---------------------------------------------------------------------------
-- These facades stop an entire organization's outbound and force an org-wide QR
-- re-login. Anyone holding the service key could run them, against any
-- organization, and leave nothing behind: no actor, no evidence, no way to tell a
-- planned migration from an abuse of the key.
--
-- They now append to the SAME hash-chained audit log the rest of the product uses,
-- so a missing or altered entry breaks the chain rather than passing unnoticed.

create or replace function app_private.openclaw_audit_migration_step_v1(
  p_organization_id uuid,
  p_step text,
  p_request jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_evidence jsonb;
  v_actor uuid;
  v_caller text;
  v_run record;
  v_request_id uuid;
begin
  -- ATTRIBUTION IS TAKEN FROM THE SESSION, NEVER FROM THE REQUEST.
  --
  -- A record whose actor is whatever the caller typed proves nothing: the party we
  -- are trying to distinguish - someone holding the service key - writes the
  -- request. Everything recorded below is either set by PostgREST from a verified
  -- JWT, or read from the database itself.
  --
  -- Be clear about what that buys HERE: these facades are granted to
  -- `service_role` only, and a service-key JWT carries no `sub`, so `actorId` is
  -- null on every invocation these functions can currently receive. It is recorded
  -- anyway because the value is free, and because the day a member role is granted
  -- one of these, an unattributed step must look different from an attributed one.
  -- The load-bearing signal is `rolloutRunId` below, not this.
  begin
    v_actor := nullif(
      current_setting('request.jwt.claims', true)::jsonb ->> 'sub', ''
    )::uuid;
  exception when others then
    v_actor := null;
  end;
  -- Who ran it, at three levels, because one of them is uninformative in each of
  -- the two call paths. Over PostgREST the `role` GUC is the answer and reads
  -- `service_role`; over a direct psql connection nothing sets it and it reads the
  -- literal 'none', which is why session_user/current_user are recorded too.
  -- SECURITY DEFINER changes current_user but not the GUC.
  v_caller := coalesce(nullif(current_setting('role', true), ''), 'unset');

  -- The canonical rollout run that AUTHORIZES this step - restricted to RUNNING.
  --
  -- Matching COMPLETE runs too made this worthless: `openclaw_rollout_runs_one_active_uidx`
  -- bounds RUNNING to one per organization, but COMPLETE rows accumulate forever, so
  -- once an organization finished its first rollout EVERY later step - planned or
  -- not - inherited that run's id and `rolloutRunId: null` could never appear again.
  -- A finished rollout authorizes nothing; only a run still in flight does.
  select run.id, run.stage, run.started_at
    into v_run
  from public.openclaw_rollout_runs run
  where run.organization_id = p_organization_id
    and run.status = 'RUNNING'
  order by run.started_at desc, run.id desc
  limit 1;

  -- Correlates the steps of ONE adapter invocation; ignored unless it is a uuid,
  -- because a caller-supplied string must never widen what the audit accepts.
  v_request_id := case
    when coalesce(p_request ->> 'requestId', '')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (p_request ->> 'requestId')::uuid
  end;

  -- Content-free by construction: the step, the organization, and a digest of the
  -- request. Never the request itself, which can carry cell ids and operator text.
  --
  -- Everything forensic lives in the EVIDENCE, not in the neighbouring columns:
  -- append_openclaw_audit_v1 hashes previous_hash|sequence|event_type|evidence_hash,
  -- so actor_id/request_id/correlation_id sit outside the chain and could be edited
  -- without breaking it. They are still written for indexing, but the copies here
  -- are the tamper-evident ones.
  v_evidence := jsonb_build_object(
    'version', 3,
    'step', p_step,
    'organizationId', p_organization_id,
    'requestDigest', encode(
      extensions.digest(app_private.openclaw_jcs_bytes_v1(p_request), 'sha256'), 'hex'
    ),
    'actorId', v_actor,
    'callerRole', v_caller,
    'sessionUser', session_user,
    'currentUser', current_user,
    'requestId', v_request_id,
    'rolloutRunId', v_run.id,
    'rolloutStage', v_run.stage
  );
  perform app_private.append_openclaw_audit_v1(
    p_organization_id,
    'OPENCLAW_MIGRATION_STEP',
    v_actor,
    'openclaw-migration-adapter',
    v_request_id,
    v_run.id,
    v_evidence,
    convert_to(v_evidence::text, 'UTF8')
  );
end;
$function$;

-- `force row level security` applies to the owner too, so the definer function
-- needs both the grant and a policy to read the run that authorizes the step.
--
-- The grant is a COLUMN LIST, not the table: the audit only needs to know which run
-- is in flight and how far it has got. A table-wide grant would hand this role
-- `reviewed_commit_sha`, `artifact_digests`, `upstream_sri` and `project_ref` for
-- every tenant, and every future definer function owned by it would inherit that.
grant select (id, organization_id, stage, status, started_at)
  on public.openclaw_rollout_runs to openclaw_migration_writer;
create policy openclaw_rollout_runs_migration_writer_select
  on public.openclaw_rollout_runs for select to openclaw_migration_writer
  using (true);

alter function app_private.openclaw_audit_migration_step_v1(uuid, text, jsonb)
  owner to openclaw_migration_writer;
revoke all on function app_private.openclaw_audit_migration_step_v1(uuid, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_audit_migration_step_v1(uuid, text, jsonb)
  to openclaw_service_dispatcher, openclaw_migration_writer;

-- No grant or policy on public.openclaw_audit_events: append_openclaw_audit_v1 is
-- SECURITY DEFINER owned by openclaw_function_owner, so the migration role needs
-- none. Granting them added an org-wide SELECT over the hash-chained audit log
-- that nothing reads.

-- The audit call sits at the END of each facade: a step that raised has not
-- happened, and must not leave a record claiming it did.
create or replace function public.openclaw_service_begin_global_stop_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_result jsonb;
begin
  v_result := app_private.openclaw_set_global_stop_v1(p_request, true);
  perform app_private.openclaw_audit_migration_step_v1(
    (p_request ->> 'organizationId')::uuid, 'global-stop', p_request
  );
  return v_result;
end;
$function$;

create or replace function public.openclaw_service_drain_outbox_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_result jsonb;
begin
  v_result := app_private.openclaw_drain_outbox_v1(p_request);
  perform app_private.openclaw_audit_migration_step_v1(
    (p_request ->> 'organizationId')::uuid, 'drain-outbox', p_request
  );
  return v_result;
end;
$function$;

create or replace function public.openclaw_service_freeze_outbox_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_result jsonb;
begin
  v_result := app_private.openclaw_freeze_outbox_v1(p_request);
  perform app_private.openclaw_audit_migration_step_v1(
    (p_request ->> 'organizationId')::uuid, 'freeze-outbox', p_request
  );
  return v_result;
end;
$function$;

create or replace function public.openclaw_service_expire_dispatching_to_unknown_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_result jsonb;
begin
  v_result := app_private.openclaw_expire_dispatching_v1(p_request);
  perform app_private.openclaw_audit_migration_step_v1(
    (p_request ->> 'organizationId')::uuid, 'move-expired-dispatching-to-unknown', p_request
  );
  return v_result;
end;
$function$;

create or replace function public.openclaw_service_reconcile_migration_gaps_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_result jsonb;
begin
  v_result := app_private.openclaw_reconcile_migration_gaps_v1(p_request);
  perform app_private.openclaw_audit_migration_step_v1(
    (p_request ->> 'organizationId')::uuid, 'reconcile-gaps-and-unknown', p_request
  );
  return v_result;
end;
$function$;

create or replace function public.openclaw_service_acquire_migration_lease_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_result jsonb;
begin
  v_result := app_private.openclaw_handover_leases_v1(p_request);
  perform app_private.openclaw_audit_migration_step_v1(
    (p_request ->> 'organizationId')::uuid, 'acquire-higher-fencing-lease', p_request
  );
  return v_result;
end;
$function$;

create or replace function public.openclaw_service_revoke_migration_lease_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_result jsonb;
begin
  v_result := app_private.openclaw_retire_old_cell_v1(p_request);
  perform app_private.openclaw_audit_migration_step_v1(
    (p_request ->> 'organizationId')::uuid, 'revoke-old-credential-and-lease', p_request
  );
  return v_result;
end;
$function$;

create or replace function public.openclaw_service_rotate_migration_credentials_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_result jsonb;
begin
  v_result := app_private.openclaw_retire_old_cell_v1(p_request);
  perform app_private.openclaw_audit_migration_step_v1(
    (p_request ->> 'organizationId')::uuid, 'rotate-workload-credentials', p_request
  );
  return v_result;
end;
$function$;

create or replace function public.openclaw_service_require_fresh_qr_login_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_result jsonb;
begin
  v_result := app_private.openclaw_require_fresh_qr_v1(p_request);
  perform app_private.openclaw_audit_migration_step_v1(
    (p_request ->> 'organizationId')::uuid, 'require-fresh-qr-login', p_request
  );
  return v_result;
end;
$function$;

create or replace function public.openclaw_service_resume_after_migration_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_result jsonb;
begin
  perform app_private.openclaw_reconcile_migration_gaps_v1(p_request);
  v_result := app_private.openclaw_set_global_stop_v1(p_request, false);
  perform app_private.openclaw_audit_migration_step_v1(
    (p_request ->> 'organizationId')::uuid, 'resume-organization', p_request
  );
  return v_result || jsonb_build_object('resumed', true);
end;
$function$;


-- The audit helper leans on two shared functions; changing the owner of the
-- migration surface means it needs its own execute grant on both.
grant execute on function app_private.openclaw_jcs_bytes_v1(jsonb)
  to openclaw_migration_writer;
grant execute on function app_private.append_openclaw_audit_v1(
  uuid, text, uuid, text, uuid, uuid, jsonb, bytea)
  to openclaw_migration_writer;


grant execute on function app_private.openclaw_jcs_text_v1(jsonb)
  to openclaw_migration_writer;


-- ---------------------------------------------------------------------------
-- 15. rotate and revoke are different steps and must do different work
-- ---------------------------------------------------------------------------
-- Both used to call openclaw_retire_old_cell_v1, so whichever ran second reported
-- `affected: 0` - migration evidence claiming a credential rotation that had
-- already happened one step earlier, or none at all. migrate-cell.sh runs rotate
-- (step 7) BEFORE acquire (8) and revoke (9), so rotate retires the credentials and
-- revoke verifies the handover finished and left nothing usable behind.

create or replace function app_private.openclaw_verify_old_cell_retired_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_scope record;
  v_pending integer;
  v_live_credentials integer;
begin
  select * into v_scope from app_private.openclaw_migration_cells_v1(p_request);

  select count(*) into v_pending
  from (
    select distinct lease.account_id
    from public.openclaw_runtime_leases lease
    where lease.organization_id = v_scope.organization_id
      and lease.status = 'ACTIVE' and lease.released_at is null
  ) account
  where not exists (
    select 1 from public.openclaw_runtime_leases lease
    where lease.organization_id = v_scope.organization_id
      and lease.account_id = account.account_id
      and lease.cell_id = v_scope.new_cell
      and lease.status = 'ACTIVE' and lease.released_at is null
  );
  if v_pending > 0 then
    raise exception '% account(s) still hold no active lease on the new cell', v_pending
      using errcode = '42501';
  end if;

  -- The old cell must be unusable: a live credential on it would let a fenced cell
  -- keep authenticating.
  select count(*) into v_live_credentials
  from public.openclaw_runtime_credentials credential
  where credential.organization_id = v_scope.organization_id
    and credential.cell_id = v_scope.old_cell and credential.revoked_at is null;
  if v_live_credentials > 0 then
    raise exception 'old cell still holds % unrevoked credential(s); rotate first',
      v_live_credentials using errcode = '42501';
  end if;

  return jsonb_build_object('version', 1, 'applied', true, 'affected', 0);
end;
$function$;

alter function app_private.openclaw_verify_old_cell_retired_v1(jsonb)
  owner to openclaw_migration_writer;
revoke all on function app_private.openclaw_verify_old_cell_retired_v1(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_verify_old_cell_retired_v1(jsonb)
  to openclaw_service_dispatcher;

create or replace function public.openclaw_service_revoke_migration_lease_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_result jsonb;
begin
  v_result := app_private.openclaw_verify_old_cell_retired_v1(p_request);
  perform app_private.openclaw_audit_migration_step_v1(
    (p_request ->> 'organizationId')::uuid, 'revoke-old-credential-and-lease', p_request
  );
  return v_result;
end;
$function$;

commit;
