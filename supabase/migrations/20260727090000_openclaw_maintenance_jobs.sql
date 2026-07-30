begin;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('ihome-openclaw-maintenance-jobs-v1', 0)
);

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
    v_week := floor(extract(epoch from (date_trunc('day',v_candidate)-date_trunc('day',v_start))) / 604800)::integer;
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
  add constraint openclaw_send_work_crm_occurrence_fkey
    foreign key (organization_id,crm_occurrence_id)
    references public.openclaw_crm_event_occurrences(organization_id,id) on delete restrict;

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
  add constraint openclaw_maintenance_work_items_state_check
    check (state in ('QUEUED','LEASED','DELETE_AUTHORIZED','COMPLETE','FAILED','DEAD_LETTER')),
  add column source_key text,
  add column credential_generation bigint,
  add column binding_defer_reason text,
  add constraint openclaw_maintenance_work_credential_binding_fkey
    foreign key (organization_id,maintenance_principal_id,credential_generation)
    references public.openclaw_maintenance_credentials(
      organization_id,maintenance_principal_id,credential_generation
    ) on delete restrict,
  add constraint openclaw_maintenance_work_lease_binding_fkey
    foreign key (organization_id,maintenance_principal_id,maintenance_lease_generation,fencing_token)
    references public.openclaw_maintenance_leases(
      organization_id,maintenance_principal_id,lease_generation,fencing_token
    ) on delete restrict;

create unique index openclaw_maintenance_work_source_key_uidx
  on public.openclaw_maintenance_work_items(organization_id,source_key)
  where source_key is not null;

alter table public.openclaw_outbox
  add column credential_generation bigint,
  add column runtime_lease_generation bigint,
  add constraint openclaw_outbox_claim_credential_fkey
    foreign key (organization_id,account_id,claimed_cell_id,credential_generation)
    references public.openclaw_runtime_credentials(
      organization_id,account_id,cell_id,credential_generation
    ) on delete restrict,
  add constraint openclaw_outbox_claim_lease_fkey
    foreign key (organization_id,account_id,claimed_cell_id,runtime_lease_generation,fencing_token)
    references public.openclaw_runtime_leases(
      organization_id,account_id,cell_id,lease_generation,fencing_token
    ) on delete restrict;

create or replace function app_private.guard_openclaw_send_work_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_binding_changed boolean := row(
    NEW.account_id,NEW.cell_id,NEW.credential_generation,NEW.runtime_lease_generation,
    NEW.fencing_token,NEW.session_generation
  ) is distinct from row(
    OLD.account_id,OLD.cell_id,OLD.credential_generation,OLD.runtime_lease_generation,
    OLD.fencing_token,OLD.session_generation
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
    NEW.maintenance_lease_generation,NEW.fencing_token
  ) is distinct from row(
    OLD.maintenance_principal_id,OLD.credential_generation,
    OLD.maintenance_lease_generation,OLD.fencing_token
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
    nullif(p_request->>'targetId','') is null or nullif(p_request->>'campaignId','') is not null
  ) then
    raise exception 'V1 schedules support a direct target only; campaign version model is unavailable'
      using errcode='0A000';
  end if;

  if p_action='UPSERT' then
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
      schedule_version,status,timezone,local_recurrence_rule,next_run_at,
      occurrence_grace_seconds,dst_fold_policy,next_nominal_local,next_resolved_local,
      next_utc_offset_seconds,next_resolution,cursor_version,binding_defer_reason
    ) values (
      v_schedule_id,p_organization_id,v_account,(p_request->>'automationVersionId')::uuid,
      (p_request->>'targetId')::uuid,null,1,v_status,v_timezone,v_rule,v_resolved.planned_for,
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
      campaign_id=case when p_action='UPSERT' then null else schedule.campaign_id end,
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
    target_id,campaign_id,status,timezone,local_recurrence_rule,missed_occurrence_policy,
    occurrence_grace_seconds,dst_fold_policy,snapshot,snapshot_bytes,snapshot_hash,created_by
  ) values (
    p_organization_id,v_schedule.account_id,v_schedule.id,v_schedule.schedule_version,
    v_schedule.automation_version_id,v_schedule.target_id,null,v_schedule.status,
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
  v_created integer := 0;
begin
  for schedule in
    select schedule.*
    from public.openclaw_schedules schedule
    where schedule.status='ACTIVE' and schedule.next_run_at is not null
      and schedule.next_run_at<=v_now
    order by schedule.next_run_at,schedule.id
    for update of schedule skip locked
    limit greatest(1,least(coalesce(p_limit,100),500))
  loop
    if schedule.campaign_id is not null or schedule.target_id is null then
      update public.openclaw_schedules set binding_defer_reason='DIRECT_TARGET_REQUIRED',
        status='PAUSED',updated_at=v_now
      where organization_id=schedule.organization_id and id=schedule.id;
      continue;
    end if;

    v_status := case when v_now>schedule.next_run_at
      + make_interval(secs=>schedule.occurrence_grace_seconds)
      then 'SKIPPED_MISSED' else 'MATERIALIZED' end;
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
      limit 1;
      select snapshot.snapshot_hash into v_snapshot_hash
      from public.openclaw_schedule_snapshots snapshot
      where snapshot.organization_id=schedule.organization_id
        and snapshot.account_id=schedule.account_id and snapshot.schedule_id=schedule.id
        and snapshot.schedule_version=schedule.schedule_version;
      if v_cell is not null then
        insert into public.openclaw_send_work_items(
          organization_id,account_id,cell_id,work_kind,source_id,source_version,source_key,
          source_hash,payload,payload_hash,state,claim_generation,fencing_token,
          session_generation,target_id,credential_generation,runtime_lease_generation,
          schedule_id,schedule_version,schedule_occurrence_id
        ) values (
          schedule.organization_id,schedule.account_id,v_cell,'SCHEDULE_OCCURRENCE',
          v_occurrence_id,schedule.schedule_version::text,
          'schedule:'||schedule.id||':'||schedule.schedule_version||':'||v_occurrence_id||':'||schedule.target_id,
          v_snapshot_hash,
          jsonb_build_object('version',1,'scheduleId',schedule.id,
            'scheduleVersion',schedule.schedule_version,'occurrenceId',v_occurrence_id,
            'automationVersionId',schedule.automation_version_id,'targetId',schedule.target_id,
            'occurrenceEvidenceHash',v_hash),
          encode(extensions.digest(v_bytes,'sha256'),'hex'),'QUEUED',1,v_fence,v_session,
          schedule.target_id,v_credential,v_lease,schedule.id,schedule.schedule_version,v_occurrence_id
        ) on conflict (organization_id,schedule_id,schedule_version,schedule_occurrence_id,target_id)
          where work_kind='SCHEDULE_OCCURRENCE' do nothing;
        v_created := v_created+1;
      else
        update public.openclaw_schedules set binding_defer_reason='NO_CURRENT_CHANNEL_BINDING'
        where organization_id=schedule.organization_id and id=schedule.id;
      end if;
    end if;

    v_next_local := app_private.openclaw_next_schedule_occurrence_v1(
      schedule.local_recurrence_rule,schedule.next_nominal_local);
    if v_status='SKIPPED_MISSED' then
      while v_next_local is not null loop
        select * into strict v_next from app_private.openclaw_resolve_local_occurrence_v1(
          v_next_local,schedule.timezone,schedule.dst_fold_policy);
        exit when v_next.planned_for>v_now;
        v_next_local := app_private.openclaw_next_schedule_occurrence_v1(
          schedule.local_recurrence_rule,v_next_local);
      end loop;
    elsif v_next_local is not null then
      select * into strict v_next from app_private.openclaw_resolve_local_occurrence_v1(
        v_next_local,schedule.timezone,schedule.dst_fold_policy);
    end if;
    update public.openclaw_schedules current_schedule set
      next_nominal_local=v_next_local,
      next_resolved_local=case when v_next_local is null then null else v_next.resolved_local end,
      next_run_at=case when v_next_local is null then null else v_next.planned_for end,
      next_utc_offset_seconds=case when v_next_local is null then null else v_next.utc_offset_seconds end,
      next_resolution=case when v_next_local is null then null else v_next.resolution end,
      cursor_version=current_schedule.cursor_version+1,
      status=case when v_next_local is null then 'COMPLETE' else current_schedule.status end,
      updated_at=v_now
    where current_schedule.organization_id=schedule.organization_id
      and current_schedule.id=schedule.id
      and current_schedule.schedule_version=schedule.schedule_version;
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
  v_created integer := 0;
begin
  for item in
    select occurrence.id crm_occurrence_id,occurrence.organization_id,
      occurrence.event_type,occurrence.event_subtype,occurrence.source_snapshot,
      occurrence.snapshot_hash,subscription.id subscription_id,
      subscription.account_id,subscription.subscription_version,
      subscription.automation_version_id,subscription.destination_target_id,
      snapshot.snapshot_hash subscription_snapshot_hash
    from public.openclaw_crm_event_occurrences occurrence
    join public.openclaw_crm_event_subscriptions subscription
      on subscription.organization_id=occurrence.organization_id
     and subscription.event_type=occurrence.event_type and subscription.is_active
    join public.openclaw_crm_event_subscription_snapshots snapshot
      on snapshot.organization_id=subscription.organization_id
     and snapshot.account_id=subscription.account_id and snapshot.subscription_id=subscription.id
     and snapshot.subscription_version=subscription.subscription_version
    join public.openclaw_control_states control
      on control.organization_id=subscription.organization_id and control.control_key='GLOBAL_STOP'
     and control.feature_enabled and not control.global_stop
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
      'version',1,'subscriptionId',item.subscription_id,
      'subscriptionVersion',item.subscription_version,'occurrenceId',item.crm_occurrence_id,
      'eventType',item.event_type,'eventSubtype',item.event_subtype,
      'automationVersionId',item.automation_version_id,
      'targetId',item.destination_target_id,'sourceSnapshot',item.source_snapshot,
      'snapshotHash',item.snapshot_hash,'subscriptionSnapshotHash',item.subscription_snapshot_hash
    );
    v_payload_bytes := app_private.openclaw_jcs_bytes_v1(v_payload);
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
      item.subscription_snapshot_hash,v_payload,
      encode(extensions.digest(v_payload_bytes,'sha256'),'hex'),'QUEUED',1,
      v_fence,v_session,item.destination_target_id,v_credential,v_lease,
      item.subscription_id,item.subscription_version,item.crm_occurrence_id
    ) on conflict (organization_id,subscription_id,subscription_version,crm_occurrence_id,target_id)
      where work_kind='CRM_EVENT' do nothing;
    v_created := v_created+1;
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
begin
  if p_request->>'version'<>'1' or v_kind not in ('CHANNEL','MAINTENANCE') then
    raise exception 'work claim version or principal kind invalid' using errcode='22023';
  end if;
  v_token_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-work-claim-v1','UTF8')||decode('00','hex')
      ||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');
  if v_kind='CHANNEL' then
    select least(lease.expires_at,statement_timestamp()+make_interval(secs=>v_seconds))
    into v_principal_expires
    from public.openclaw_runtime_credentials credential
    join public.openclaw_runtime_leases lease
      on lease.organization_id=credential.organization_id and lease.account_id=credential.account_id
     and lease.cell_id=credential.cell_id
    where credential.organization_id=v_org
      and credential.account_id=(p_principal->>'accountId')::uuid
      and credential.cell_id=(p_principal->>'cellId')::uuid
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
        and work.work_kind<>'INBOUND_AUTOMATION' and work.state='QUEUED'
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
      'workItemId',id,'workKind',work_kind,'sourceKey',source_key,
      'targetId',target_id,'claimGeneration',claim_generation,
      'leaseExpiresAt',lease_expires_at,'sourceId',source_id,
      'sourceVersion',source_version,'sourceHash',source_hash,
      'payload',payload,'payloadHash',payload_hash
    ) order by id),'[]'::jsonb) into v_items from claimed;
  else
    select least(lease.expires_at,statement_timestamp()+make_interval(secs=>v_seconds))
    into v_principal_expires
    from public.openclaw_maintenance_credentials credential
    join public.openclaw_maintenance_leases lease
      on lease.organization_id=credential.organization_id
     and lease.maintenance_principal_id=credential.maintenance_principal_id
    where credential.organization_id=v_org
      and credential.maintenance_principal_id=(p_principal->>'maintenancePrincipalId')::uuid
      and credential.credential_generation=(p_principal->>'credentialGeneration')::bigint
      and credential.revoked_at is null
      and lease.lease_generation=(p_principal->>'leaseGeneration')::bigint
      and lease.fencing_token=(p_principal->>'fencingToken')::bigint
      and lease.status='ACTIVE' and lease.expires_at>statement_timestamp();
    if v_principal_expires is null then
      raise exception 'maintenance credential or principal lease is stale' using errcode='42501';
    end if;
    with candidates as (
      select work.id from public.openclaw_maintenance_work_items work
      where work.organization_id=v_org
        and work.maintenance_principal_id=(p_principal->>'maintenancePrincipalId')::uuid
        and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
        and work.maintenance_lease_generation=(p_principal->>'leaseGeneration')::bigint
        and work.fencing_token=(p_principal->>'fencingToken')::bigint
        and work.state='QUEUED' and work.claim_token_hash is null
        and work.lease_expires_at is null and work.terminal_at is null
        and (work.retry_not_before is null or work.retry_not_before<=statement_timestamp())
      order by work.created_at,work.id for update skip locked limit v_limit
    ), claimed as (
      update public.openclaw_maintenance_work_items work set
        state='LEASED',claim_token_hash=v_token_hash,
        claim_generation=work.claim_generation+1,lease_expires_at=v_principal_expires,
        attempt_count=work.attempt_count+1,updated_at=statement_timestamp()
      from candidates where work.organization_id=v_org and work.id=candidates.id
      returning work.*
    ) select coalesce(jsonb_agg(jsonb_build_object(
      'workItemId',id,'workKind',work_kind,'workPhase',work_phase,
      'sourceKey',source_key,'claimGeneration',claim_generation,
      'leaseExpiresAt',lease_expires_at,'sourceId',source_id,
      'sourceVersion',source_version,'sourceHash',source_hash,
      'payload',payload,'payloadHash',payload_hash
    ) order by id),'[]'::jsonb) into v_items from claimed;
  end if;
  return jsonb_build_object('version',1,'principalKind',v_kind,
    'credentialGeneration',(p_principal->>'credentialGeneration')::bigint,
    'leaseGeneration',(p_principal->>'leaseGeneration')::bigint,
    'fencingToken',(p_principal->>'fencingToken')::bigint,'items',v_items);
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
  v_kind text := p_principal->>'principalKind';
  v_org uuid := (p_principal->>'organizationId')::uuid;
  v_work uuid := (p_request->>'workItemId')::uuid;
  v_claim bigint := (p_request->>'claimGeneration')::bigint;
  v_outcome text := p_request->>'outcome';
  v_token text;
  v_attempt integer;
  v_evidence jsonb := coalesce(p_request->'evidence','{}'::jsonb);
begin
  if p_request->>'version'<>'1' or v_outcome not in ('COMPLETE','RETRY','FAILED','DEAD_LETTER') then
    raise exception 'work completion version or outcome invalid' using errcode='22023';
  end if;
  v_token := encode(extensions.digest(convert_to('ihome-openclaw-work-claim-v1','UTF8')
    ||decode('00','hex')||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');
  if v_kind='CHANNEL' then
    select work.attempt_count into v_attempt from public.openclaw_send_work_items work
    where work.organization_id=v_org and work.id=v_work and work.state='LEASED'
      and work.account_id=(p_principal->>'accountId')::uuid
      and work.cell_id=(p_principal->>'cellId')::uuid
      and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
      and work.runtime_lease_generation=(p_principal->>'leaseGeneration')::bigint
      and work.fencing_token=(p_principal->>'fencingToken')::bigint
      and work.session_generation=(p_principal->>'sessionGeneration')::bigint
      and work.claim_generation=v_claim and work.claim_token_hash=v_token
      and work.lease_expires_at>statement_timestamp() for update;
    if not found then raise exception 'channel work completion binding CAS failed' using errcode='40001'; end if;
    insert into public.openclaw_send_work_attempts(
      organization_id,account_id,cell_id,work_item_id,claim_generation,fencing_token,
      session_generation,attempt_number,outcome,evidence,evidence_hash
    ) values (
      v_org,(p_principal->>'accountId')::uuid,(p_principal->>'cellId')::uuid,v_work,v_claim,
      (p_principal->>'fencingToken')::bigint,(p_principal->>'sessionGeneration')::bigint,
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
  elsif v_kind='MAINTENANCE' then
    select work.attempt_count into v_attempt from public.openclaw_maintenance_work_items work
    where work.organization_id=v_org and work.id=v_work and work.state='LEASED'
      and work.maintenance_principal_id=(p_principal->>'maintenancePrincipalId')::uuid
      and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
      and work.maintenance_lease_generation=(p_principal->>'leaseGeneration')::bigint
      and work.fencing_token=(p_principal->>'fencingToken')::bigint
      and work.claim_generation=v_claim and work.claim_token_hash=v_token
      and work.lease_expires_at>statement_timestamp()
      and work.work_kind not in ('RETENTION_DELETE','AUDIT_ANCHOR') for update;
    if not found then
      raise exception 'retention or audit work requires its specialized completion CAS'
        using errcode='42501';
    end if;
    insert into public.openclaw_maintenance_work_attempts(
      organization_id,maintenance_principal_id,work_item_id,claim_generation,
      maintenance_lease_generation,fencing_token,attempt_number,outcome,evidence,evidence_hash
    ) values (
      v_org,(p_principal->>'maintenancePrincipalId')::uuid,v_work,v_claim,
      (p_principal->>'leaseGeneration')::bigint,(p_principal->>'fencingToken')::bigint,
      v_attempt,v_outcome,v_evidence,
      encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_evidence),'sha256'),'hex')
    );
    update public.openclaw_maintenance_work_items work set
      state=case when v_outcome='RETRY' then 'QUEUED' else v_outcome end,
      claim_token_hash=null,lease_expires_at=null,
      retry_not_before=case when v_outcome='RETRY' then statement_timestamp()
        +make_interval(secs=>greatest(1,least(coalesce((p_request->>'retryAfterSeconds')::integer,5),3600))) end,
      terminal_at=case when v_outcome='RETRY' then null else statement_timestamp() end,
      updated_at=statement_timestamp()
    where work.organization_id=v_org and work.id=v_work and work.state='LEASED'
      and work.claim_generation=v_claim;
  else
    raise exception 'principalKind must be CHANNEL or MAINTENANCE' using errcode='42501';
  end if;
  return jsonb_build_object('version',1,'principalKind',v_kind,'workItemId',v_work,'outcome',v_outcome);
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
  add constraint openclaw_retention_holds_target_kind_check
    check (target_kind in (
      'ORGANIZATION','CONVERSATION','MESSAGE','MEDIA','AI_DRAFT',
      'KNOWLEDGE','AUDIT','DELIVERY'
    ));

create table public.openclaw_retention_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  policy_version bigint not null check (policy_version>0),
  subject_kind text not null check (subject_kind in ('MESSAGE','AI_DRAFT','MEDIA')),
  retain_for_seconds bigint not null check (retain_for_seconds between 86400 and 315576000),
  is_active boolean not null default false,
  activated_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  unique (organization_id,id),
  unique (organization_id,subject_kind,policy_version),
  check ((is_active and activated_at is not null and retired_at is null) or not is_active)
);

create unique index openclaw_retention_policies_one_active_uidx
  on public.openclaw_retention_policies(organization_id,subject_kind)
  where is_active;

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
  insert into public.openclaw_retention_hold_clocks(organization_id,hold_version,updated_at)
  values(NEW.organization_id,1,statement_timestamp())
  on conflict (organization_id) do update
    set hold_version=public.openclaw_retention_hold_clocks.hold_version+1,
        updated_at=statement_timestamp()
  returning hold_version into v_version;
  NEW.hold_version := v_version;

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
    NEW.organization_id,NEW.id,NEW.hold_version,NEW.target_kind,
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
    ) select NEW.organization_id,NEW.id,NEW.hold_version,'MESSAGE',message.id,v_active
      from public.openclaw_messages message
      where message.organization_id=NEW.organization_id and message.conversation_id=NEW.target_id
    on conflict (organization_id,hold_id,scope_kind,scope_id) do update
      set hold_version=excluded.hold_version,is_active=excluded.is_active,
          updated_at=statement_timestamp();
    insert into public.openclaw_retention_hold_scopes(
      organization_id,hold_id,hold_version,scope_kind,scope_id,is_active
    ) select NEW.organization_id,NEW.id,NEW.hold_version,'MEDIA',media.id,v_active
      from public.openclaw_message_media media
      where media.organization_id=NEW.organization_id and media.conversation_id=NEW.target_id
    on conflict (organization_id,hold_id,scope_kind,scope_id) do update
      set hold_version=excluded.hold_version,is_active=excluded.is_active,
          updated_at=statement_timestamp();
    insert into public.openclaw_retention_hold_scopes(
      organization_id,hold_id,hold_version,scope_kind,scope_id,is_active
    ) select NEW.organization_id,NEW.id,NEW.hold_version,'AI_DRAFT',draft.id,v_active
      from public.openclaw_ai_drafts draft
      where draft.organization_id=NEW.organization_id and draft.conversation_id=NEW.target_id
    on conflict (organization_id,hold_id,scope_kind,scope_id) do update
      set hold_version=excluded.hold_version,is_active=excluded.is_active,
          updated_at=statement_timestamp();
  elsif NEW.target_kind='MESSAGE' then
    insert into public.openclaw_retention_hold_scopes(
      organization_id,hold_id,hold_version,scope_kind,scope_id,is_active
    ) select NEW.organization_id,NEW.id,NEW.hold_version,'MEDIA',media.id,v_active
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
    where scope.organization_id=p_organization_id and scope.is_active
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
      )
  );
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
  claim_generation bigint not null check (claim_generation>0),
  credential_generation bigint not null check (credential_generation>0),
  maintenance_lease_generation bigint not null check (maintenance_lease_generation>0),
  fencing_token bigint not null check (fencing_token>0),
  hold_version bigint not null check (hold_version>=0),
  quarantine_version bigint not null check (quarantine_version>0),
  signing_key_generation bigint not null check (signing_key_generation>0),
  domain_hash text not null check (domain_hash ~ '^[0-9a-f]{64}$'),
  ticket_payload jsonb not null check (jsonb_typeof(ticket_payload)='object'),
  ticket_bytes bytea not null,
  ticket_hash text not null check (ticket_hash ~ '^[0-9a-f]{64}$'),
  expected_receipt_claims jsonb not null check (jsonb_typeof(expected_receipt_claims)='object'),
  state text not null default 'DELETE_AUTHORIZED'
    check (state in ('DELETE_AUTHORIZED','FINALIZED')),
  authorized_at timestamptz not null default statement_timestamp(),
  receipt jsonb,
  receipt_hash text check (receipt_hash is null or receipt_hash ~ '^[0-9a-f]{64}$'),
  gateway_outcome text check (gateway_outcome is null or gateway_outcome in ('DELETED','NOT_FOUND')),
  finalized_at timestamptz,
  unique (organization_id,id),
  unique (organization_id,ticket_jti),
  unique (organization_id,work_item_id),
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
  check ((state='FINALIZED')=(finalized_at is not null)),
  check ((receipt is null)=(receipt_hash is null)),
  check ((receipt is null)=(gateway_outcome is null))
);

create table public.openclaw_retention_gateway_configs (
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

create unique index openclaw_retention_gateway_one_active_uidx
  on public.openclaw_retention_gateway_configs(organization_id) where is_active;

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
    select subject.* from subjects subject
    where not app_private.openclaw_retention_subject_held_v1(
      subject.organization_id,subject.subject_kind,subject.subject_id)
      and not exists (select 1 from public.openclaw_maintenance_work_items work
        where work.organization_id=subject.organization_id
          and work.source_key='retention:quarantine:'||subject.subject_kind||':'
            ||subject.subject_id||':'||subject.policy_version)
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
    v_payload := jsonb_build_object('version',1,'subjectKind',candidate.subject_kind,
      'subjectId',candidate.subject_id,'retentionVersion',candidate.policy_version,
      'scopeVersion',coalesce((select clock.hold_version
        from public.openclaw_retention_hold_clocks clock
        where clock.organization_id=candidate.organization_id),0));
    v_bytes := app_private.openclaw_jcs_bytes_v1(v_payload);
    v_hash := encode(extensions.digest(v_bytes,'sha256'),'hex');
    insert into public.openclaw_maintenance_work_items(
      organization_id,maintenance_principal_id,work_kind,work_phase,source_id,
      source_version,source_key,source_hash,payload,payload_hash,state,claim_generation,
      maintenance_lease_generation,fencing_token,credential_generation
    ) values (
      candidate.organization_id,binding.maintenance_principal_id,'RETENTION_DELETE','QUARANTINE',
      candidate.subject_id,candidate.policy_version::text,
      'retention:quarantine:'||candidate.subject_kind||':'||candidate.subject_id||':'||candidate.policy_version,
      v_hash,v_payload,v_hash,'QUEUED',1,binding.lease_generation,
      binding.fencing_token,binding.credential_generation
    ) on conflict (organization_id,source_key) where source_key is not null do nothing;
    v_created:=v_created+1;
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
  v_scope_version := (v_work.payload->>'scopeVersion')::bigint;
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
  tombstone record;
  binding record;
  v_payload jsonb;
  v_bytes bytea;
  v_hash text;
  v_created integer := 0;
begin
  for tombstone in
    select tombstone.* from public.openclaw_retention_tombstones tombstone
    where tombstone.subject_kind='MEDIA'
      and tombstone.final_delete_not_before<=statement_timestamp()
      and tombstone.object_key is not null
      and not app_private.openclaw_retention_subject_held_v1(
        tombstone.organization_id,'MEDIA',tombstone.subject_id)
      and not exists (select 1 from public.openclaw_retention_delete_tickets ticket
        where ticket.organization_id=tombstone.organization_id
          and ticket.tombstone_id=tombstone.id)
      and not exists (select 1 from public.openclaw_maintenance_work_items work
        where work.organization_id=tombstone.organization_id
          and work.source_key='retention:final:'||tombstone.id||':'||tombstone.quarantine_version)
    order by tombstone.final_delete_not_before,tombstone.id
    for update of tombstone skip locked
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
    where principal.organization_id=tombstone.organization_id
      and principal.is_current and principal.revoked_at is null
    order by lease.lease_generation desc,credential.credential_generation desc limit 1;
    if binding.maintenance_principal_id is null then continue; end if;
    v_payload := jsonb_build_object('version',1,'subjectKind','MEDIA',
      'subjectId',tombstone.subject_id,'tombstoneId',tombstone.id,
      'quarantineVersion',tombstone.quarantine_version,
      'finalDeleteNotBefore',tombstone.final_delete_not_before,
      'scopeVersion',coalesce((select clock.hold_version
        from public.openclaw_retention_hold_clocks clock
        where clock.organization_id=tombstone.organization_id),0));
    v_bytes := app_private.openclaw_jcs_bytes_v1(v_payload);
    v_hash := encode(extensions.digest(v_bytes,'sha256'),'hex');
    insert into public.openclaw_maintenance_work_items(
      organization_id,maintenance_principal_id,work_kind,work_phase,source_id,
      source_version,source_key,source_hash,payload,payload_hash,state,claim_generation,
      maintenance_lease_generation,fencing_token,credential_generation
    ) values (
      tombstone.organization_id,binding.maintenance_principal_id,'RETENTION_DELETE','FINAL_DELETE',
      tombstone.id,tombstone.quarantine_version::text,
      'retention:final:'||tombstone.id||':'||tombstone.quarantine_version,
      v_hash,v_payload,v_hash,'QUEUED',1,binding.lease_generation,
      binding.fencing_token,binding.credential_generation
    ) on conflict (organization_id,source_key) where source_key is not null do nothing;
    v_created:=v_created+1;
  end loop;
  return v_created;
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
  v_token text;
  v_hold_version bigint;
  v_signing bigint;
  v_ticket uuid := gen_random_uuid();
  v_ticket_jti uuid := gen_random_uuid();
  v_domain_hash text;
  v_claims jsonb;
  v_payload jsonb;
  v_bytes bytea;
  v_hash text;
begin
  if p_request->>'version'<>'1' then
    raise exception 'retention authorization version mismatch' using errcode='22023';
  end if;
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
    and work.work_phase='FINAL_DELETE' and work.state='LEASED'
    and work.claim_generation=(p_request->>'claimGeneration')::bigint
    and work.claim_token_hash=v_token
    and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
    and work.maintenance_lease_generation=(p_principal->>'leaseGeneration')::bigint
    and work.fencing_token=(p_principal->>'fencingToken')::bigint
    and work.lease_expires_at>statement_timestamp() and lease.expires_at>statement_timestamp()
  for update of work;
  if not found then raise exception 'retention delete binding CAS failed' using errcode='40001'; end if;
  select tombstone.* into v_tomb from public.openclaw_retention_tombstones tombstone
  where tombstone.organization_id=v_org
    and tombstone.id=(v_work.payload->>'tombstoneId')::uuid
    and tombstone.subject_kind='MEDIA'
    and tombstone.subject_id=(v_work.payload->>'subjectId')::uuid
    and tombstone.quarantine_version=(v_work.payload->>'quarantineVersion')::bigint
    and tombstone.final_delete_not_before<=statement_timestamp()
    and tombstone.object_key is not null for update;
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
  select config.signing_key_generation into v_signing
  from public.openclaw_retention_gateway_configs config
  where config.organization_id=v_org and config.is_active
    and config.retired_at is null for share;
  if not found then raise exception 'active secret-free retention gateway signing generation required'
    using errcode='42501'; end if;
  v_domain_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-retention-delete-domain-v1','UTF8')||decode('00','hex')
      ||convert_to(v_org::text||':'||v_ticket_jti||':'||v_tomb.object_key,'UTF8'),
    'sha256'),'hex');
  v_claims := jsonb_build_object('version',1,'organizationId',v_org,
    'ticketJti',v_ticket_jti,'objectKey',v_tomb.object_key,'domainHash',v_domain_hash,
    'signingKeyGeneration',v_signing);
  v_payload := v_claims||jsonb_build_object('workItemId',v_work.id,
    'tombstoneId',v_tomb.id,'subjectId',v_tomb.subject_id,
    'holdVersion',v_hold_version,'quarantineVersion',v_tomb.quarantine_version,
    'authorizedAt',statement_timestamp());
  v_bytes := app_private.openclaw_jcs_bytes_v1(v_payload);
  v_hash := encode(extensions.digest(
    convert_to('ihome-openclaw-retention-delete-ticket-v1','UTF8')||decode('00','hex')
      ||v_bytes,'sha256'),'hex');
  insert into public.openclaw_retention_delete_tickets(
    id,organization_id,maintenance_principal_id,work_item_id,tombstone_id,subject_id,
    object_key,ticket_jti,claim_generation,credential_generation,
    maintenance_lease_generation,fencing_token,hold_version,quarantine_version,
    signing_key_generation,domain_hash,ticket_payload,ticket_bytes,ticket_hash,
    expected_receipt_claims
  ) values (
    v_ticket,v_org,v_maintenance,v_work.id,v_tomb.id,v_tomb.subject_id,v_tomb.object_key,
    v_ticket_jti,v_work.claim_generation,v_work.credential_generation,
    v_work.maintenance_lease_generation,v_work.fencing_token,v_hold_version,
    v_tomb.quarantine_version,v_signing,v_domain_hash,v_payload,v_bytes,v_hash,v_claims
  );
  update public.openclaw_maintenance_work_items work set state='DELETE_AUTHORIZED',
    claim_token_hash=null,lease_expires_at=null,retry_not_before=null,updated_at=statement_timestamp()
  where work.organization_id=v_org and work.id=v_work.id and work.state='LEASED'
    and work.claim_generation=v_work.claim_generation;
  if not found then raise exception 'DELETE_AUTHORIZED work transition CAS failed' using errcode='40001'; end if;
  return jsonb_build_object('version',1,'ticketId',v_ticket,'ticket',v_payload,
    'ticketHash',v_hash,'state','DELETE_AUTHORIZED');
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
begin
  if p_request->>'version'<>'1' or jsonb_typeof(v_receipt)<>'object' then
    raise exception 'retention finalize version or receipt invalid' using errcode='22023';
  end if;
  v_hash := encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_receipt),'sha256'),'hex');
  select ticket.* into v_ticket from public.openclaw_retention_delete_tickets ticket
  where ticket.organization_id=v_org and ticket.id=(p_request->>'ticketId')::uuid
  for update;
  if not found then raise exception 'retention delete ticket not found' using errcode='40001'; end if;
  if v_ticket.state='FINALIZED' then
    if v_ticket.receipt_hash<>v_hash then
      raise exception 'finalized retention ticket replay mismatch' using errcode='40001';
    end if;
    return jsonb_build_object('version',1,'ticketId',v_ticket.id,
      'gatewayOutcome',v_ticket.gateway_outcome,'receiptHash',v_ticket.receipt_hash,
      'finalized',true,'idempotentReplay',true);
  end if;
  v_outcome := v_receipt->>'outcome';
  if v_outcome not in ('DELETED','NOT_FOUND')
    or coalesce((v_receipt->>'preverified')::boolean,false) is not true
    or v_receipt->>'version'<>'1'
    or v_receipt->>'organizationId'<>v_ticket.organization_id::text
    or v_receipt->>'ticketJti'<>v_ticket.ticket_jti::text
    or v_receipt->>'objectKey'<>v_ticket.object_key
    or v_receipt->>'domainHash'<>v_ticket.domain_hash
    or (v_receipt->>'signingKeyGeneration')::bigint<>v_ticket.signing_key_generation
    or coalesce(v_receipt->>'signatureHash','') !~ '^[0-9a-f]{64}$'
  then
    raise exception 'gateway receipt claims do not exactly match preverified delete ticket'
      using errcode='42501';
  end if;
  update public.openclaw_message_media media set byte_state='DELETED',
    retention_delete_not_before=null,updated_at=statement_timestamp()
  from public.openclaw_retention_tombstones tombstone
  where tombstone.organization_id=v_org and tombstone.id=v_ticket.tombstone_id
    and media.organization_id=tombstone.organization_id and media.id=tombstone.subject_id
    and media.object_key is null and media.byte_state='QUARANTINED';
  if not found and v_outcome<>'NOT_FOUND' then
    raise exception 'media final delete CAS failed' using errcode='40001';
  end if;
  update public.openclaw_retention_delete_tickets ticket set state='FINALIZED',
    receipt=v_receipt,receipt_hash=v_hash,gateway_outcome=v_outcome,
    finalized_at=statement_timestamp()
  where ticket.organization_id=v_org and ticket.id=v_ticket.id
    and ticket.state='DELETE_AUTHORIZED';
  select work.attempt_count into v_attempt from public.openclaw_maintenance_work_items work
  where work.organization_id=v_org and work.id=v_ticket.work_item_id
    and work.state='DELETE_AUTHORIZED' for update;
  if not found then raise exception 'authorized retention work CAS failed' using errcode='40001'; end if;
  insert into public.openclaw_maintenance_work_attempts(
    organization_id,maintenance_principal_id,work_item_id,claim_generation,
    maintenance_lease_generation,fencing_token,attempt_number,outcome,
    gateway_receipt,receipt_hash,evidence,evidence_hash
  ) values (
    v_org,v_ticket.maintenance_principal_id,v_ticket.work_item_id,v_ticket.claim_generation,
    v_ticket.maintenance_lease_generation,v_ticket.fencing_token,v_attempt,'COMPLETE',
    v_receipt,v_hash,jsonb_build_object('ticketId',v_ticket.id,'gatewayOutcome',v_outcome),v_hash
  );
  update public.openclaw_maintenance_work_items work set state='COMPLETE',
    terminal_at=statement_timestamp(),updated_at=statement_timestamp()
  where work.organization_id=v_org and work.id=v_ticket.work_item_id
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
  v_created integer := 0;
begin
  for day in
    select event.organization_id,(event.occurred_at at time zone 'UTC')::date root_date,
      min(event.organization_sequence) first_sequence,
      max(event.organization_sequence) last_sequence,count(*) event_count,
      (array_agg(event.event_hash order by event.organization_sequence desc))[1] root_hash,
      config.signing_key_generation
    from public.openclaw_audit_events event
    join public.openclaw_audit_signing_configs config
      on config.organization_id=event.organization_id and config.is_active
     and config.retired_at is null
    where (event.occurred_at at time zone 'UTC')::date
      < (statement_timestamp() at time zone 'UTC')::date
      and not exists (select 1 from public.openclaw_audit_roots root
        where root.organization_id=event.organization_id
          and root.root_date=(event.occurred_at at time zone 'UTC')::date)
    group by event.organization_id,(event.occurred_at at time zone 'UTC')::date,
      config.signing_key_generation
    order by root_date,event.organization_id
    limit greatest(1,least(coalesce(p_limit,31),366))
  loop
    insert into public.openclaw_audit_roots(
      organization_id,root_date,first_sequence,last_sequence,root_hash,event_count,
      signing_key_generation,r2_anchor_key
    ) values (
      day.organization_id,day.root_date,day.first_sequence,day.last_sequence,
      day.root_hash,day.event_count,day.signing_key_generation,
      'v1/org/'||day.organization_id||'/audit/'||day.root_date||'/'||day.root_hash
    ) on conflict (organization_id,root_date) do nothing returning id into v_root;
    if v_root is null then continue; end if;
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
    v_payload := jsonb_build_object('version',1,'auditRootId',v_root,
      'rootDate',day.root_date,'rootHash',day.root_hash,
      'firstSequence',day.first_sequence,'lastSequence',day.last_sequence,
      'eventCount',day.event_count,'signingKeyGeneration',day.signing_key_generation);
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
    v_created:=v_created+1;
  end loop;
  return v_created;
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
  if OLD.state='UNKNOWN' and (to_jsonb(NEW)-'resolution_version')
    is distinct from (to_jsonb(OLD)-'resolution_version') then
    raise exception 'historical UNKNOWN evidence cannot be rewritten' using errcode='55000';
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
  with candidates as (
    select outbox.id from public.openclaw_outbox outbox
    where outbox.organization_id=v_org and outbox.account_id=v_account
      and outbox.state='QUEUED'
      and (outbox.retry_not_before is null or outbox.retry_not_before<=statement_timestamp())
    order by outbox.created_at,outbox.id for update skip locked limit v_limit
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
  ) select coalesce(jsonb_agg(jsonb_build_object('outboxId',id,
    'claimGeneration',claim_generation,'leaseExpiresAt',lease_expires_at,
    'targetId',target_id,'sourceKind',source_kind,'canonicalPayload',canonical_payload,
    'payloadHash',payload_hash) order by id),'[]'::jsonb) into v_items from claimed;
  return jsonb_build_object('version',1,'items',v_items,'databaseTime',statement_timestamp());
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
  v_work public.openclaw_send_work_items%rowtype;
  v_payload jsonb := p_request->'canonicalPayload';
  v_payload_hash text;
  v_token text;
  v_inbound_token text;
  v_target uuid;
  v_source_kind text;
  v_automation uuid;
  v_control bigint;
  v_takeover bigint;
  v_outbox uuid;
begin
  if p_request->>'version'<>'1' or jsonb_typeof(v_payload)<>'object' then
    raise exception 'version 1 canonical payload required' using errcode='22023';
  end if;
  v_token:=encode(extensions.digest(convert_to('ihome-openclaw-work-claim-v1','UTF8')
    ||decode('00','hex')||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');
  v_inbound_token:=encode(extensions.digest(
    convert_to('ihome-openclaw-inbound-automation-claim-v1','UTF8')||decode('00','hex')
      ||convert_to(p_request->>'claimToken','UTF8'),'sha256'),'hex');
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
    and work.id=(p_request->>'workItemId')::uuid and work.state='LEASED'
    and work.claim_generation=(p_request->>'claimGeneration')::bigint
    and work.claim_token_hash in (v_token,v_inbound_token)
    and work.cell_id=(p_principal->>'cellId')::uuid
    and work.credential_generation=(p_principal->>'credentialGeneration')::bigint
    and work.runtime_lease_generation=(p_principal->>'leaseGeneration')::bigint
    and work.fencing_token=(p_principal->>'fencingToken')::bigint
    and work.session_generation=(p_principal->>'sessionGeneration')::bigint
    and work.lease_expires_at>statement_timestamp() and lease.expires_at>statement_timestamp()
  for update of work;
  if not found then raise exception 'create outbox stored work binding CAS failed' using errcode='40001'; end if;
  v_payload_hash:=app_private.openclaw_send_payload_hash_v1(v_payload);
  if v_payload_hash is distinct from p_request->>'payloadHash'
    or v_work.source_hash is distinct from p_request->>'sourceSnapshotHash' then
    raise exception 'canonical payload or frozen source hash mismatch' using errcode='40001';
  end if;
  select target.id into v_target from public.openclaw_targets target
  where target.organization_id=v_org and target.account_id=v_account
    and target.kind=v_payload#>>'{target,kind}'
    and target.provider_id=v_payload#>>'{target,providerId}' and target.is_active;
  if not found or (v_work.target_id is not null and v_target<>v_work.target_id) then
    raise exception 'canonical target differs from frozen work target' using errcode='42501';
  end if;
  if v_work.work_kind='INBOUND_AUTOMATION' then
    v_source_kind:='INBOUND_REPLY';
    v_automation:=nullif(v_work.payload->>'automationVersionId','')::uuid;
  elsif v_work.work_kind='SCHEDULE_OCCURRENCE' then
    v_source_kind:='SCHEDULE';
    if v_work.schedule_id is null or v_work.schedule_version is null
      or v_work.schedule_occurrence_id is null or v_work.target_id is null then
      raise exception 'typed schedule work identity is incomplete' using errcode='55000';
    end if;
    select snapshot.automation_version_id into v_automation
    from public.openclaw_schedule_snapshots snapshot
    where snapshot.organization_id=v_org and snapshot.account_id=v_account
      and snapshot.schedule_id=v_work.schedule_id
      and snapshot.schedule_version=v_work.schedule_version
      and snapshot.snapshot_hash=v_work.source_hash;
  elsif v_work.work_kind='CRM_EVENT' then
    v_source_kind:='CRM_EVENT';
    if v_work.subscription_id is null or v_work.subscription_version is null
      or v_work.crm_occurrence_id is null or v_work.target_id is null then
      raise exception 'typed CRM work identity is incomplete' using errcode='55000';
    end if;
    select snapshot.automation_version_id into v_automation
    from public.openclaw_crm_event_subscription_snapshots snapshot
    where snapshot.organization_id=v_org and snapshot.account_id=v_account
      and snapshot.subscription_id=v_work.subscription_id
      and snapshot.subscription_version=v_work.subscription_version
      and snapshot.snapshot_hash=v_work.source_hash;
  else raise exception 'unsupported work kind' using errcode='22023';
  end if;
  if v_automation is null then raise exception 'frozen source snapshot is unavailable' using errcode='40001'; end if;
  select control.control_version into v_control from public.openclaw_control_states control
  where control.organization_id=v_org and control.control_key='GLOBAL_STOP';
  if not found then raise exception 'OpenClaw control state is missing' using errcode='42501'; end if;
  select coalesce(max(takeover.takeover_version),0) into v_takeover
  from public.openclaw_takeovers takeover
  join public.openclaw_conversations conversation
    on conversation.organization_id=takeover.organization_id
   and conversation.account_id=takeover.account_id and conversation.id=takeover.conversation_id
  where takeover.organization_id=v_org and takeover.account_id=v_account
    and conversation.target_id=v_target;
  insert into public.openclaw_outbox(
    organization_id,account_id,target_id,source_kind,inbound_event_id,
    automation_version_id,schedule_id,schedule_version,subscription_id,
    subscription_version,occurrence_id,idempotency_key,canonical_payload,
    canonical_payload_bytes,payload_hash,fencing_token,session_generation,
    control_version,takeover_version,smoke_run_id
  ) values (
    v_org,v_account,v_target,v_source_kind,
    case when v_source_kind='INBOUND_REPLY' then v_work.source_id end,
    v_automation,v_work.schedule_id,v_work.schedule_version,v_work.subscription_id,
    v_work.subscription_version,coalesce(v_work.schedule_occurrence_id,v_work.crm_occurrence_id),
    v_payload->>'idempotencyKey',v_payload,
    app_private.openclaw_canonical_send_payload_bytes_v1(v_payload),v_payload_hash,
    v_work.fencing_token,v_work.session_generation,v_control,v_takeover,v_work.smoke_run_id
  ) on conflict (organization_id,account_id,idempotency_key) do update
    set updated_at=public.openclaw_outbox.updated_at returning id into v_outbox;
  return jsonb_build_object('version',1,'workItemId',v_work.id,'outboxId',v_outbox,
    'sourceKind',v_source_kind,'sourceSnapshotHash',v_work.source_hash,
    'payloadHash',v_payload_hash);
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
begin
  if not pg_catalog.pg_try_advisory_lock(v_lock) then
    return jsonb_build_object('version',1,'acquired',false,'databaseTime',statement_timestamp());
  end if;
  begin
    v_result := jsonb_build_object(
      'version',1,'acquired',true,
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
      'auditRoots',app_private.materialize_openclaw_audit_root_v1(366),
      'databaseTime',statement_timestamp()
    );
    perform pg_catalog.pg_advisory_unlock(v_lock);
    return v_result;
  exception when others then
    perform pg_catalog.pg_advisory_unlock(v_lock);
    raise;
  end;
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
    'openclaw_retention_delete_tickets','openclaw_retention_gateway_configs',
    'openclaw_audit_signing_configs'
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

grant select,insert on public.openclaw_schedule_occurrences to openclaw_runtime_writer;
grant select,insert,update on public.openclaw_retention_hold_clocks,
  public.openclaw_retention_hold_scopes,public.openclaw_retention_delete_tickets
  to openclaw_maintenance_writer;
grant select on public.openclaw_retention_policies,
  public.openclaw_retention_gateway_configs,public.openclaw_audit_signing_configs
  to openclaw_maintenance_writer;

alter function app_private.openclaw_apply_schedule_write_v1(text,uuid,uuid,jsonb)
  owner to openclaw_function_owner;
alter function app_private.openclaw_claim_work_item_v1(jsonb,jsonb,jsonb)
  owner to openclaw_function_owner;
alter function app_private.openclaw_complete_work_item_v1(jsonb,jsonb,jsonb)
  owner to openclaw_function_owner;
alter function app_private.openclaw_claim_outbox_v1(jsonb,jsonb,jsonb)
  owner to openclaw_runtime_writer;
alter function app_private.openclaw_complete_retention_quarantine_v1(jsonb,jsonb,jsonb)
  owner to openclaw_maintenance_writer;
alter function app_private.openclaw_authorize_retention_delete_v1(jsonb,jsonb,jsonb)
  owner to openclaw_maintenance_writer;
alter function app_private.openclaw_finalize_retention_delete_v1(jsonb,jsonb,jsonb)
  owner to openclaw_maintenance_writer;

do $function_security$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'app_private.openclaw_parse_local_recurrence_rule_v1(text)',
    'app_private.openclaw_valid_local_recurrence_rule_v1(text)',
    'app_private.openclaw_next_schedule_occurrence_v1(text,timestamp without time zone)',
    'app_private.openclaw_resolve_local_occurrence_v1(timestamp without time zone,text,text)',
    'app_private.materialize_openclaw_schedule_work_v1(integer)',
    'app_private.materialize_openclaw_crm_work_v1(integer)',
    'app_private.rebind_openclaw_unclaimed_work_v1(integer)',
    'app_private.openclaw_retention_subject_held_v1(uuid,text,uuid)',
    'app_private.materialize_openclaw_retention_quarantine_v1(integer)',
    'app_private.materialize_openclaw_retention_final_delete_v1(integer)',
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

revoke all on function app_private.run_openclaw_maintenance_jobs_v1()
  from public, anon, authenticated, service_role;

commit;
