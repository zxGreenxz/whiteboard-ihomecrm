-- ============================================================================
-- T3 PREPARED SQL 07 — Candidate materialization + ANY/ALL/QUORUM eligibility
-- (T3 §4.7). STATUS: PREPARED (compile+behavior tested on disposable PG17
-- exact-source restore). NOT a migration; private; no grant.
--
-- Materializes approval_request_step_candidates from approval_step_approvers
-- (MEMBER / ROLE / PERMISSION / CASHBOOK_APPROVER / AREA_APPROVER /
-- BUILDING_APPROVER) using the T2 normalized model. generation bumps on
-- rematerialize (old candidates closed, not overwritten). Fail-closed when a
-- step has no eligible candidate or an impossible quorum. Decide-time
-- eligibility re-check counts current-generation candidates only.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Materialize one step's candidate set (bumps generation, closes old rows)
-- ---------------------------------------------------------------------------

create or replace function app_private.materialize_step_candidates_v1(
  p_request_step_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_step public.approval_request_steps;
  v_req public.approval_requests;
  v_gen integer;
  v_count integer;
  v_rule_step_id uuid;
begin
  select * into v_step from public.approval_request_steps
   where id = p_request_step_id for update;
  if not found then raise exception 'step not found' using errcode='P0002'; end if;

  select * into v_req from public.approval_requests
   where id = v_step.request_id;

  -- the approver spec is attached to the source rule step; the request step's
  -- snapshot carries that id.
  v_rule_step_id := nullif(v_step.rule_step_snapshot->>'rule_step_id','')::uuid;
  v_gen := v_step.current_generation + 1;

  -- F12 fix: take the org share-lock in a PRIOR statement before the resolver is
  -- evaluated as a scalar subquery below, so PERMISSION-type candidate matching
  -- reads a witness snapshot taken after any concurrent mutation's lock wait.
  perform app_private.lock_org_for_decision_v1(v_req.organization_id);

  -- close prior generation (valid_to set; history preserved)
  update public.approval_request_step_candidates
     set valid_to = clock_timestamp()
   where request_step_id = p_request_step_id
     and generation = v_step.current_generation
     and valid_to is null;

  -- materialize the union of all approver specs into distinct memberships,
  -- excluding the maker (a maker can never be their own checker candidate).
  insert into public.approval_request_step_candidates
    (organization_id, request_step_id, membership_id, generation,
     source_kind, source_id, eligible_at_submit, valid_from)
  select distinct on (m.id)
    v_req.organization_id, p_request_step_id, m.id, v_gen,
    sa.approver_type, sa.id, true, clock_timestamp()
  from public.approval_step_approvers sa
  join public.organization_memberships m
    on m.organization_id = v_req.organization_id and m.status = 'ACTIVE'
  where sa.step_id = v_rule_step_id
    -- M10 fix: exclude the maker by BOTH membership AND user_id (a maker with a
    -- second ACTIVE membership must not inflate candidate_count or self-approve).
    and m.id <> v_req.maker_membership_id
    and m.user_id <> v_req.maker_user_id
    and (
      -- MEMBER: the exact membership
      (sa.approver_type = 'MEMBER' and sa.membership_id = m.id)
      -- ROLE: any member bound to the role (nonlegacy binding, active)
      or (sa.approver_type = 'ROLE' and exists (
        select 1 from public.role_bindings rb
         where rb.organization_id = v_req.organization_id
           and rb.membership_id = m.id and rb.role_id = sa.role_id
           and coalesce(rb.valid_from,'-infinity') <= clock_timestamp()
           and (rb.valid_to is null or rb.valid_to > clock_timestamp())))
      -- PERMISSION: any member the T2 resolver would ALLOW for the permission
      or (sa.approver_type = 'PERMISSION' and (
        select allowed from app_private.authorize_tenant_action_v3(
          m.user_id, v_req.organization_id, sa.permission_key,
          v_req.building_id, v_req.cashbook_id)))
      -- CASHBOOK_APPROVER: holds possession on the request cashbook
      or (sa.approver_type = 'CASHBOOK_APPROVER' and v_req.cashbook_id is not null
          and exists (
        select 1 from public.cashbook_possession_bindings cp
         where cp.organization_id = v_req.organization_id
           and cp.cashbook_id = v_req.cashbook_id and cp.membership_id = m.id
           and cp.valid_from <= clock_timestamp()
           and (cp.valid_to is null or cp.valid_to > clock_timestamp())))
      -- BUILDING_APPROVER: role binding scoped to the request building
      or (sa.approver_type = 'BUILDING_APPROVER' and v_req.building_id is not null
          and exists (
        select 1 from public.role_bindings rb
         join public.role_binding_scopes rbs
           on rbs.organization_id = rb.organization_id and rbs.role_binding_id = rb.id
         join public.authorization_scopes s
           on s.organization_id = rbs.organization_id and s.id = rbs.scope_id
         where rb.organization_id = v_req.organization_id and rb.membership_id = m.id
           and s.scope_type = 'BUILDING' and s.building_id = v_req.building_id))
      -- AREA_APPROVER: role binding scoped to an area covering the building
      or (sa.approver_type = 'AREA_APPROVER' and v_req.building_id is not null
          and exists (
        select 1 from public.role_bindings rb
         join public.role_binding_scopes rbs
           on rbs.organization_id = rb.organization_id and rbs.role_binding_id = rb.id
         join public.authorization_scopes s
           on s.organization_id = rbs.organization_id and s.id = rbs.scope_id
         join public.area_buildings ab
           on ab.organization_id = s.organization_id and ab.area_id = s.area_id
         where rb.organization_id = v_req.organization_id and rb.membership_id = m.id
           and s.scope_type = 'AREA' and ab.building_id = v_req.building_id))
    );
  get diagnostics v_count = row_count;

  update public.approval_request_steps
     set current_generation = v_gen, candidate_count = v_count
   where id = p_request_step_id;

  -- fail-closed: no candidate, or quorum impossible
  if v_count = 0 then
    raise exception 'step % has zero eligible candidates', p_request_step_id
      using errcode='55000';
  end if;
  if v_step.mode = 'ALL' and v_step.min_approvals <> v_count then
    -- ALL requires min = candidate_count; adjust or fail. We fail-closed so
    -- the rule author must reconcile min_approvals with the ALL semantics.
    raise exception 'ALL-mode step % min_approvals % <> candidate_count %',
      p_request_step_id, v_step.min_approvals, v_count using errcode='55000';
  end if;
  if v_step.mode = 'QUORUM' and v_step.min_approvals > v_count then
    raise exception 'QUORUM step % needs % approvals but only % candidates',
      p_request_step_id, v_step.min_approvals, v_count using errcode='55000';
  end if;

  return v_count;
end;
$fn$;
revoke all on function app_private.materialize_step_candidates_v1(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Decide-time eligibility check (current generation only)
-- ---------------------------------------------------------------------------

create or replace function app_private.is_eligible_current_candidate_v1(
  p_request_step_id uuid, p_actor_membership uuid)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $fn$
  select exists (
    select 1
      from public.approval_request_step_candidates c
      join public.approval_request_steps s on s.id = c.request_step_id
     where c.request_step_id = p_request_step_id
       and c.membership_id = p_actor_membership
       and c.generation = s.current_generation
       and c.valid_to is null
  );
$fn$;
revoke all on function app_private.is_eligible_current_candidate_v1(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Step satisfaction check: has the step met its mode/min_approvals?
-- ---------------------------------------------------------------------------

create or replace function app_private.step_is_satisfied_v1(p_request_step_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $fn$
  -- H5 fix: count only DISTINCT approvals by members who are current-generation
  -- candidates of THIS step (a member removed on rematerialize no longer counts,
  -- and non-candidate approvals never counted). candidate_count is recomputed
  -- from live current-generation candidates so ALL cannot be satisfied by a
  -- stale ceiling.
  select case s.mode
    when 'ANY' then approvals >= 1
    when 'ALL' then approvals >= live_candidates and live_candidates > 0
    when 'QUORUM' then approvals >= s.min_approvals
    else false
  end
  from public.approval_request_steps s
  cross join lateral (
    select
      count(distinct d.actor_membership_id) filter (
        where d.decision in ('APPROVE','CHECKER_APPROVE')
          and exists (
            select 1 from public.approval_request_step_candidates c
             where c.request_step_id = s.id
               and c.membership_id = d.actor_membership_id
               and c.generation = s.current_generation
               and c.valid_to is null)) as approvals,
      (select count(*) from public.approval_request_step_candidates c
        where c.request_step_id = s.id
          and c.generation = s.current_generation
          and c.valid_to is null) as live_candidates
      from public.approval_decisions d
     where d.request_step_id = p_request_step_id
  ) a
  where s.id = p_request_step_id;
$fn$;
revoke all on function app_private.step_is_satisfied_v1(uuid)
  from public, anon, authenticated, service_role;

commit;
