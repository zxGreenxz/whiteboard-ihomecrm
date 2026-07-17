-- ============================================================================
-- T3 PREPARED SQL 08 — Emergency owner override (T3 §4.9).
-- STATUS: PREPARED (compile+behavior tested on disposable PG17 exact-source
-- restore). NOT a migration; private; no grant. Separate endpoint — never a
-- client-selectable decision enum on the normal decide path.
--
-- Conditions (all required): actor is ACTIVE OWNER membership; request is
-- PENDING_APPROVAL; actor holds approvals.emergency_override via T2 resolver;
-- reason >= 20 chars; re-auth freshness token within window; owner-is-maker
-- cannot use emergency to bypass force-approval. BYPASSES active + subsequent
-- steps, posts in the same transaction, records EMERGENCY_APPROVE decision +
-- a security event. Frequency alerting is a downstream concern (event emitted).
-- ============================================================================

begin;

-- security events table (private, append-only)
create table if not exists app_private.emergency_override_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  request_id uuid not null,
  actor_membership_id uuid not null,
  actor_user_id uuid not null,
  reason text not null,
  created_at timestamptz not null default clock_timestamp()
);
revoke all on app_private.emergency_override_events
  from public, anon, authenticated, service_role;

create or replace function app_private.guard_emergency_events_immutable()
returns trigger language plpgsql security definer
set search_path to 'pg_catalog' as $fn$
begin raise exception 'emergency override events are append-only' using errcode='55000'; end;
$fn$;
revoke all on function app_private.guard_emergency_events_immutable()
  from public, anon, authenticated, service_role;
drop trigger if exists a00_emergency_events_immutable on app_private.emergency_override_events;
create trigger a00_emergency_events_immutable
before update or delete on app_private.emergency_override_events
for each row execute function app_private.guard_emergency_events_immutable();
alter table app_private.emergency_override_events
  enable always trigger a00_emergency_events_immutable;

create or replace function app_private.emergency_approve_financial_v1(
  p_request_id uuid, p_expected_version bigint,
  p_actor_membership uuid, p_actor_user uuid,
  p_reason text, p_reauth_fresh boolean)
returns uuid
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_req public.approval_requests;
  v_member public.organization_memberships;
  v_allowed boolean;
  v_posting uuid;
begin
  if not p_reauth_fresh then
    raise exception 're-authentication required' using errcode='42501';
  end if;
  if coalesce(length(btrim(p_reason)), 0) < 20 then
    raise exception 'emergency reason must be >= 20 chars' using errcode='22023';
  end if;

  select * into v_req from public.approval_requests
   where id = p_request_id for update;
  if not found then raise exception 'request not found' using errcode='P0002'; end if;
  if v_req.version <> p_expected_version then
    raise exception 'version conflict' using errcode='40001'; end if;
  if v_req.state <> 'PENDING_APPROVAL' then
    raise exception 'request not pending' using errcode='55000'; end if;

  -- actor must be an ACTIVE OWNER membership
  select * into v_member from public.organization_memberships
   where id = p_actor_membership and organization_id = v_req.organization_id
     and status = 'ACTIVE' and member_type = 'OWNER';
  if not found then
    raise exception 'emergency override requires active OWNER' using errcode='42501';
  end if;
  if v_member.user_id is distinct from p_actor_user then
    raise exception 'membership/user mismatch' using errcode='42501';
  end if;

  -- owner-is-maker cannot use emergency to bypass force-approval
  if p_actor_membership = v_req.maker_membership_id then
    raise exception 'maker cannot self-emergency-approve' using errcode='42501';
  end if;

  -- must hold approvals.emergency_override per the T2 resolver
  perform app_private.lock_org_for_decision_v1(v_req.organization_id);
  select allowed into v_allowed
    from app_private.authorize_tenant_action_v3(
      p_actor_user, v_req.organization_id, 'approvals.emergency_override',
      v_req.building_id, v_req.cashbook_id);
  if not coalesce(v_allowed, false) then
    raise exception 'actor lacks approvals.emergency_override' using errcode='42501';
  end if;

  -- BYPASS all open steps
  update public.approval_request_steps
     set status = 'BYPASSED'
   where request_id = p_request_id and status in ('WAITING','PENDING');

  insert into public.approval_decisions
    (organization_id, request_id, request_step_id, actor_membership_id,
     actor_user_id, decision, reason, request_version)
  select v_req.organization_id, p_request_id, s.id, p_actor_membership,
         p_actor_user, 'EMERGENCY_APPROVE', p_reason, v_req.version
    from public.approval_request_steps s
   where s.request_id = p_request_id
   order by s.step_no limit 1;

  insert into app_private.emergency_override_events
    (organization_id, request_id, actor_membership_id, actor_user_id, reason)
  values (v_req.organization_id, p_request_id, p_actor_membership, p_actor_user, p_reason);

  v_posting := app_private.post_financial_request_v1(
    p_request_id, v_req.version, p_actor_user);
  return v_posting;
end;
$fn$;
revoke all on function app_private.emergency_approve_financial_v1(
  uuid, bigint, uuid, uuid, text, boolean)
  from public, anon, authenticated, service_role;

commit;
