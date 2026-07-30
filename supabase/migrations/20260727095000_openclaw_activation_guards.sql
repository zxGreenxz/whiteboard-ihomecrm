begin;

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('ihome-openclaw-activation-guards-v1',0)
);

-- The canonical artifact authority is the immutable identity on
-- openclaw_rollout_runs.  The exact chain is checked by the activation predicate.
-- 20260727010000_openclaw_catalog_foundation.sql
-- 20260727015000_openclaw_security_principals.sql
-- 20260727020000_openclaw_inbox_schema.sql
-- 20260727025000_openclaw_inbound_automation.sql
-- 20260727030000_openclaw_policy_automation_knowledge.sql
-- 20260727040000_openclaw_delivery_audit_ops.sql
-- 20260727050000_openclaw_access_policies.sql
-- 20260727060000_openclaw_rpc_surface.sql
-- 20260727070000_openclaw_crm_event_sources.sql
-- 20260727080000_openclaw_realtime_allowlist.sql
-- 20260727090000_openclaw_maintenance_jobs.sql
-- 20260727095000_openclaw_activation_guards.sql

drop trigger openclaw_automation_versions_append_only
  on public.openclaw_automation_versions;

create or replace function app_private.openclaw_guard_automation_version_transition_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if TG_OP='DELETE' then
    raise exception 'automation versions cannot be deleted' using errcode='55000';
  end if;
  if OLD.lifecycle_state='DRAFT' and NEW.lifecycle_state='PUBLISHED'
    and OLD.published_at is null and NEW.published_at is not null
    and (to_jsonb(NEW)-array['lifecycle_state','published_at'])
      is not distinct from (to_jsonb(OLD)-array['lifecycle_state','published_at'])
  then return NEW; end if;
  raise exception 'automation version permits only exact DRAFT to PUBLISHED transition'
    using errcode='55000';
end;
$function$;

create trigger openclaw_automation_versions_exact_transition
before update or delete on public.openclaw_automation_versions
for each row execute function app_private.openclaw_guard_automation_version_transition_v1();

drop trigger openclaw_rollout_checkpoints_append_only
  on public.openclaw_rollout_checkpoints;

create or replace function app_private.openclaw_guard_rollout_checkpoint_transition_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if TG_OP='DELETE' then
    raise exception 'rollout checkpoints cannot be deleted' using errcode='55000';
  end if;
  if OLD.status='WAITING' and NEW.status='COMPLETE'
    and OLD.completed_at is null and NEW.completed_at is not null
    and NEW.trusted_evidence_id is not null and NEW.trusted_evidence_hash is not null
    and (to_jsonb(NEW)-array['status','completed_at','trusted_evidence_id','trusted_evidence_hash'])
      is not distinct from
      (to_jsonb(OLD)-array['status','completed_at','trusted_evidence_id','trusted_evidence_hash'])
  then return NEW; end if;
  raise exception 'rollout checkpoint permits only exact WAITING to COMPLETE transition'
    using errcode='55000';
end;
$function$;

create trigger openclaw_rollout_checkpoints_exact_transition
before update or delete on public.openclaw_rollout_checkpoints
for each row execute function app_private.openclaw_guard_rollout_checkpoint_transition_v1();

create or replace function app_private.openclaw_resume_rollout_v1(
  p_principal jsonb,p_envelope jsonb,p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_run public.openclaw_rollout_runs%rowtype;
begin
  if p_request->>'version'<>'1' then
    raise exception 'rollout resume version mismatch' using errcode='22023';
  end if;
  select run.* into v_run from public.openclaw_rollout_runs run
  where run.organization_id=(p_principal->>'organizationId')::uuid
    and run.id=(p_request->>'rolloutRunId')::uuid
    and run.stage_version=(p_request->>'expectedStageVersion')::bigint;
  if not found then raise exception 'rollout resume read CAS failed' using errcode='40001'; end if;
  return jsonb_build_object('version',1,'rolloutRunId',v_run.id,'status',v_run.status,
    'stage',v_run.stage,'stageVersion',v_run.stage_version,
    'stageEnteredAt',v_run.stage_entered_at);
end;
$function$;

create or replace function app_private.openclaw_guard_activation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid;
  v_account uuid;
  v_cell uuid;
  v_credential bigint;
  v_lease bigint;
  v_fence bigint;
  v_required_stage text := 'CONNECTION';
  v_is_activation boolean := false;
  v_run public.openclaw_rollout_runs%rowtype;
  v_stages constant text[] := array[
    'FOUNDATION','INFRASTRUCTURE','WAITING_OWNER_QR','CONNECTION','SHADOW',
    'WAITING_OWNER_INBOUND','LIMITED_OBSERVING','LIMITED_VERIFIED',
    'PROACTIVE','SALES_GROUPS','COMPLETE'
  ];
  v_manifest constant text[] := array[
    '20260727010000_openclaw_catalog_foundation.sql',
    '20260727015000_openclaw_security_principals.sql',
    '20260727020000_openclaw_inbox_schema.sql',
    '20260727025000_openclaw_inbound_automation.sql',
    '20260727030000_openclaw_policy_automation_knowledge.sql',
    '20260727040000_openclaw_delivery_audit_ops.sql',
    '20260727050000_openclaw_access_policies.sql',
    '20260727060000_openclaw_rpc_surface.sql',
    '20260727070000_openclaw_crm_event_sources.sql',
    '20260727080000_openclaw_realtime_allowlist.sql',
    '20260727090000_openclaw_maintenance_jobs.sql',
    '20260727095000_openclaw_activation_guards.sql'
  ];
  v_entry text;
begin
  if TG_TABLE_SCHEMA<>'public' then
    raise exception 'deny unknown activation target %.%',TG_TABLE_SCHEMA,TG_TABLE_NAME
      using errcode='42501';
  end if;
  case TG_TABLE_NAME
    when 'openclaw_control_states' then
      v_org:=NEW.organization_id;
      if NEW.global_stop then return NEW; end if; -- GLOBAL_STOP=true is always allowed.
      v_is_activation := NEW.feature_enabled or NEW.limited_auto_reply_enabled
        or NEW.proactive_enabled or NEW.sales_groups_enabled or NEW.first_contact_enabled
        or (TG_OP='UPDATE' and OLD.global_stop and not NEW.global_stop);
      if NEW.sales_groups_enabled then v_required_stage:='SALES_GROUPS';
      elsif NEW.proactive_enabled or NEW.first_contact_enabled then v_required_stage:='PROACTIVE';
      elsif NEW.limited_auto_reply_enabled then v_required_stage:='LIMITED_VERIFIED';
      else v_required_stage:='SHADOW'; end if;
    when 'openclaw_accounts' then
      v_org:=NEW.organization_id; v_account:=NEW.id;
      v_is_activation := NEW.connection_state='CONNECTED' or NEW.effective_mode<>'DRAFT_ONLY';
      v_required_stage := case NEW.effective_mode
        when 'SALES_GROUPS' then 'SALES_GROUPS' when 'PROACTIVE' then 'PROACTIVE'
        when 'LIMITED_AUTO_REPLY' then 'LIMITED_VERIFIED' else 'CONNECTION' end;
    when 'openclaw_automations' then
      v_org:=NEW.organization_id;v_account:=NEW.account_id;
      v_is_activation:=NEW.lifecycle_state='PUBLISHED';v_required_stage:='LIMITED_VERIFIED';
    when 'openclaw_automation_versions' then
      v_org:=NEW.organization_id;v_account:=NEW.account_id;
      v_is_activation:=NEW.lifecycle_state='PUBLISHED';
      v_required_stage:=case NEW.mode when 'SALES_GROUPS' then 'SALES_GROUPS'
        when 'PROACTIVE' then 'PROACTIVE' else 'LIMITED_VERIFIED' end;
    when 'openclaw_schedules' then
      v_org:=NEW.organization_id;v_account:=NEW.account_id;
      v_is_activation:=NEW.status='ACTIVE';v_required_stage:='PROACTIVE';
      if v_is_activation and (NEW.target_id is null or NEW.campaign_id is not null) then
        raise exception 'campaign schedules fail closed until a versioned campaign model exists'
          using errcode='42501';
      end if;
    when 'openclaw_crm_event_subscriptions' then
      v_org:=NEW.organization_id;v_account:=NEW.account_id;
      v_is_activation:=NEW.is_active;v_required_stage:='PROACTIVE';
    when 'openclaw_campaigns' then
      v_org:=NEW.organization_id;v_account:=NEW.account_id;
      v_is_activation:=NEW.status='ACTIVE';v_required_stage:='SALES_GROUPS';
    when 'openclaw_outbound_authorizations' then
      v_org:=NEW.organization_id;v_account:=NEW.account_id;v_is_activation:=true;
      select outbox.claimed_cell_id,outbox.credential_generation,
        outbox.runtime_lease_generation,outbox.fencing_token,
        case when target.kind='SALES_GROUP' then 'SALES_GROUPS'
          when outbox.source_kind in ('SCHEDULE','CRM_EVENT') then 'PROACTIVE'
          when outbox.source_kind='INBOUND_REPLY' then 'LIMITED_VERIFIED'
          else 'CONNECTION' end
      into v_cell,v_credential,v_lease,v_fence,v_required_stage
      from public.openclaw_outbox outbox
      join public.openclaw_targets target
        on target.organization_id=outbox.organization_id and target.account_id=outbox.account_id
       and target.id=outbox.target_id
      where outbox.organization_id=NEW.organization_id and outbox.account_id=NEW.account_id
        and outbox.id=NEW.outbox_id and outbox.claim_generation=NEW.claim_generation
        and outbox.state='LEASED';
      if not found then raise exception 'outbound authorization has no exact claimed outbox binding'
        using errcode='42501'; end if;
    else
      raise exception 'deny unknown activation target public.%',TG_TABLE_NAME using errcode='42501';
  end case;
  if not v_is_activation then return NEW; end if;

  if exists (select 1 from public.openclaw_outbox unresolved
    where unresolved.organization_id=v_org and unresolved.state='UNKNOWN'
      and unresolved.resolution_version=0) then
    raise exception 'unresolved UNKNOWN blocks releasing or enabling OpenClaw'
      using errcode='42501';
  end if;
  select run.* into v_run from public.openclaw_rollout_runs run
  where run.organization_id=v_org and run.status in ('RUNNING','COMPLETE')
    and run.migration_manifest_sha256 ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(run.artifact_digests)='object'
  order by run.started_at desc,run.id desc limit 1;
  if not found or array_position(v_stages,v_run.stage)<array_position(v_stages,v_required_stage) then
    raise exception 'canonical rollout stage does not permit activation' using errcode='42501';
  end if;
  foreach v_entry in array v_manifest loop
    if not (v_run.artifact_digests ? v_entry)
      or coalesce(v_run.artifact_digests->>v_entry,'') !~ '^[0-9a-f]{64}$' then
      raise exception 'canonical rollout artifact digest missing for %',v_entry using errcode='42501';
    end if;
  end loop;
  if array_position(v_stages,v_required_stage)>=array_position(v_stages,'CONNECTION')
    and not exists (select 1 from public.openclaw_rollout_checkpoints checkpoint
      where checkpoint.organization_id=v_org and checkpoint.rollout_run_id=v_run.id
        and checkpoint.checkpoint_name='WAITING_OWNER_QR' and checkpoint.status='COMPLETE'
        and checkpoint.trusted_evidence_id is not null
        and checkpoint.trusted_evidence_hash is not null) then
    raise exception 'WAITING_OWNER_QR canonical checkpoint is incomplete' using errcode='42501';
  end if;
  if array_position(v_stages,v_required_stage)>=array_position(v_stages,'LIMITED_VERIFIED')
    and not exists (select 1 from public.openclaw_rollout_checkpoints checkpoint
      where checkpoint.organization_id=v_org and checkpoint.rollout_run_id=v_run.id
        and checkpoint.checkpoint_name='WAITING_OWNER_INBOUND' and checkpoint.status='COMPLETE'
        and checkpoint.trusted_evidence_id is not null
        and checkpoint.trusted_evidence_hash is not null) then
    raise exception 'WAITING_OWNER_INBOUND canonical checkpoint is incomplete' using errcode='42501';
  end if;

  if v_account is null then
    select account.id,cell.id,credential.credential_generation,
      lease.lease_generation,lease.fencing_token
    into v_account,v_cell,v_credential,v_lease,v_fence
    from public.openclaw_accounts account
    join public.openclaw_runtime_cells cell
      on cell.organization_id=account.organization_id and cell.account_id=account.id
     and cell.is_current and cell.state='READY' and cell.reviewed_commit_sha=v_run.reviewed_commit_sha
    join public.openclaw_runtime_credentials credential
      on credential.organization_id=cell.organization_id and credential.account_id=cell.account_id
     and credential.cell_id=cell.id and credential.revoked_at is null
    join public.openclaw_runtime_leases lease
      on lease.organization_id=cell.organization_id and lease.account_id=cell.account_id
     and lease.cell_id=cell.id and lease.status='ACTIVE' and lease.expires_at>statement_timestamp()
    where account.organization_id=v_org and account.is_active
    order by lease.lease_generation desc,credential.credential_generation desc limit 1;
  elsif v_cell is null then
    select cell.id,credential.credential_generation,lease.lease_generation,lease.fencing_token
    into v_cell,v_credential,v_lease,v_fence
    from public.openclaw_runtime_cells cell
    join public.openclaw_runtime_credentials credential
      on credential.organization_id=cell.organization_id and credential.account_id=cell.account_id
     and credential.cell_id=cell.id and credential.revoked_at is null
    join public.openclaw_runtime_leases lease
      on lease.organization_id=cell.organization_id and lease.account_id=cell.account_id
     and lease.cell_id=cell.id and lease.status='ACTIVE' and lease.expires_at>statement_timestamp()
    where cell.organization_id=v_org and cell.account_id=v_account
      and cell.is_current and cell.state='READY' and cell.reviewed_commit_sha=v_run.reviewed_commit_sha
    order by lease.lease_generation desc,credential.credential_generation desc limit 1;
  else
    if not exists (select 1 from public.openclaw_runtime_cells cell
      join public.openclaw_runtime_credentials credential
        on credential.organization_id=cell.organization_id and credential.account_id=cell.account_id
       and credential.cell_id=cell.id and credential.credential_generation=v_credential
       and credential.revoked_at is null
      join public.openclaw_runtime_leases lease
        on lease.organization_id=cell.organization_id and lease.account_id=cell.account_id
       and lease.cell_id=cell.id and lease.lease_generation=v_lease
       and lease.fencing_token=v_fence and lease.status='ACTIVE'
       and lease.expires_at>statement_timestamp()
      where cell.organization_id=v_org and cell.account_id=v_account and cell.id=v_cell
        and cell.is_current and cell.state='READY'
        and cell.reviewed_commit_sha=v_run.reviewed_commit_sha) then
      raise exception 'stored outbound cell credential lease fence matrix is stale' using errcode='42501';
    end if;
  end if;
  if v_cell is null or v_credential is null or v_lease is null or v_fence is null then
    raise exception 'current artifact cell credential lease fence matrix is incomplete'
      using errcode='42501';
  end if;
  return NEW;
end;
$function$;

create trigger openclaw_control_states_activation_guard
before insert or update on public.openclaw_control_states
for each row execute function app_private.openclaw_guard_activation_v1();
create trigger openclaw_accounts_activation_guard
before insert or update on public.openclaw_accounts
for each row execute function app_private.openclaw_guard_activation_v1();
create trigger openclaw_automations_activation_guard
before insert or update on public.openclaw_automations
for each row execute function app_private.openclaw_guard_activation_v1();
create trigger openclaw_automation_versions_activation_guard
before insert or update on public.openclaw_automation_versions
for each row execute function app_private.openclaw_guard_activation_v1();
create trigger openclaw_schedules_activation_guard
before insert or update on public.openclaw_schedules
for each row execute function app_private.openclaw_guard_activation_v1();
create trigger openclaw_crm_subscriptions_activation_guard
before insert or update on public.openclaw_crm_event_subscriptions
for each row execute function app_private.openclaw_guard_activation_v1();
create trigger openclaw_campaigns_activation_guard
before insert or update on public.openclaw_campaigns
for each row execute function app_private.openclaw_guard_activation_v1();
create trigger openclaw_outbound_authorizations_activation_guard
before insert on public.openclaw_outbound_authorizations
for each row execute function app_private.openclaw_guard_activation_v1();

create or replace function app_private.openclaw_finalize_account_connection_v1(
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
  v_challenge public.openclaw_qr_challenges%rowtype;
  v_command public.openclaw_runtime_commands%rowtype;
  v_generation bigint;
  v_evidence jsonb;
  v_hash text;
begin
  select challenge.* into v_challenge from public.openclaw_qr_challenges challenge
  where challenge.organization_id=v_org and challenge.account_id=v_account
    and challenge.cell_id=v_cell and challenge.id=(p_request->>'challengeId')::uuid
    and challenge.challenge_status='CONSUMED' and challenge.consumed_at is not null
    and challenge.material_version=0 for share;
  if not found then raise exception 'canonical consumed QR evidence required' using errcode='42501'; end if;
  select command.* into v_command from public.openclaw_runtime_commands command
  where command.organization_id=v_org and command.account_id=v_account and command.cell_id=v_cell
    and command.id=v_challenge.runtime_command_id and command.command_kind='QR_LOGIN'
    and command.state='ACKNOWLEDGED' and command.result_hash is not null for share;
  if not found then raise exception 'canonical QR runtime acknowledgement required' using errcode='42501'; end if;
  select account.connection_generation+1 into v_generation from public.openclaw_accounts account
  where account.organization_id=v_org and account.id=v_account for update;
  v_evidence:=jsonb_build_object('version',1,'challengeId',v_challenge.id,
    'runtimeCommandId',v_command.id,'runtimeResultHash',v_command.result_hash,
    'consumedAt',v_challenge.consumed_at,'cellId',v_cell,
    'credentialGeneration',(p_principal->>'credentialGeneration')::bigint,
    'leaseGeneration',(p_principal->>'leaseGeneration')::bigint,
    'fencingToken',(p_principal->>'fencingToken')::bigint);
  v_hash:=encode(extensions.digest(app_private.openclaw_jcs_bytes_v1(v_evidence),'sha256'),'hex');
  insert into public.openclaw_account_connections(
    organization_id,account_id,connection_generation,connection_state,session_risk_state,
    configured_mode,effective_mode,reason_code,disclosure_version,
    disclosure_acknowledged_version,evidence_hash
  ) select account.organization_id,account.id,v_generation,'CONNECTED',account.session_risk_state,
    account.configured_mode,'DRAFT_ONLY','CANONICAL_QR_FINALIZED',account.disclosure_version,
    account.disclosure_acknowledged_version,v_hash
  from public.openclaw_accounts account
  where account.organization_id=v_org and account.id=v_account;
  update public.openclaw_accounts account set connection_state='CONNECTED',
    connection_generation=v_generation,effective_mode='DRAFT_ONLY',updated_at=statement_timestamp()
  where account.organization_id=v_org and account.id=v_account;
  return jsonb_build_object('version',1,'accountId',v_account,
    'connectionGeneration',v_generation,'connectionState','CONNECTED','evidenceHash',v_hash);
end;
$function$;

alter function app_private.openclaw_guard_activation_v1() owner to openclaw_function_owner;
revoke all on function app_private.openclaw_guard_activation_v1()
  from public, anon, authenticated, service_role;
alter function app_private.openclaw_guard_automation_version_transition_v1()
  owner to openclaw_function_owner;
revoke all on function app_private.openclaw_guard_automation_version_transition_v1()
  from public, anon, authenticated, service_role;
alter function app_private.openclaw_guard_rollout_checkpoint_transition_v1()
  owner to openclaw_function_owner;
revoke all on function app_private.openclaw_guard_rollout_checkpoint_transition_v1()
  from public, anon, authenticated, service_role;
alter function app_private.openclaw_finalize_account_connection_v1(jsonb,jsonb,jsonb)
  owner to openclaw_runtime_writer;
revoke all on function app_private.openclaw_finalize_account_connection_v1(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function app_private.openclaw_finalize_account_connection_v1(jsonb,jsonb,jsonb)
  to openclaw_service_dispatcher;

commit;
