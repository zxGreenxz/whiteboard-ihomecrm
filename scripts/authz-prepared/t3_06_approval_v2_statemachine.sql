-- ============================================================================
-- T3 PREPARED SQL 06 — Approval contract v2 private state machine.
-- STATUS: PREPARED (compile+behavior tested on disposable PG17 exact-source
-- restore). NOT a migration; NON-CALLABLE by app roles; production apply +
-- any EXECUTE grant gated by owner per T3 doc (§4.16: helpers stay private).
--
-- Scope (matches T3 §4.3–4.11): REVERSED state + reversal link, exactly-once
-- posting with GET DIAGNOSTICS assertions, snapshot-hash revalidation on
-- decide, submission_no allocation, maker-checker enforcement, self-approve-
-- within-limit exception (server-derived, held-cashbook + versioned limit),
-- append-only decision + chained audit. All routines private; no grant.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Schema: add REVERSED state + reversal link + self-approve limit config
-- ---------------------------------------------------------------------------

alter table public.approval_requests
  drop constraint if exists approval_requests_state_check,
  add constraint approval_requests_state_check
    check (state in ('PENDING_APPROVAL','POSTED','DENIED','REJECTED','CANCELLED','REVERSED'));

alter table public.approval_requests
  add column if not exists reverses_request_id uuid,
  add column if not exists reversed_by_request_id uuid;

-- Reversal requests carry rule_effect='REVERSAL'.
alter table public.approval_requests
  drop constraint if exists approval_requests_rule_effect_check,
  add constraint approval_requests_rule_effect_check
    check (rule_effect in ('AUTO_POST','REQUIRE_APPROVAL','DENY','REVERSAL'));

-- Widen the decision enum to cover self-approve + reversal, and relax the
-- candidate_id requirement for these server-derived decision kinds.
alter table public.approval_decisions
  drop constraint if exists approval_decisions_decision_check,
  drop constraint if exists approval_decisions_decision_candidate_check,
  drop constraint if exists approval_decisions_check,
  add constraint approval_decisions_decision_check
    check (decision in ('APPROVE','REJECT','EMERGENCY_APPROVE',
                        'CHECKER_APPROVE','CHECKER_REJECT',
                        'SELF_APPROVED_WITHIN_LIMIT','REVERSAL_POSTED')),
  add constraint approval_decisions_decision_candidate_check check (
    (decision in ('APPROVE','REJECT') and candidate_id is not null)
    or (decision in ('EMERGENCY_APPROVE','CHECKER_APPROVE','CHECKER_REJECT',
                     'SELF_APPROVED_WITHIN_LIMIT','REVERSAL_POSTED')
        and candidate_id is null)
  );

-- one original reversed at most once
create unique index if not exists approval_requests_one_reversal_uidx
  on public.approval_requests (organization_id, reverses_request_id)
  where reverses_request_id is not null;

-- Versioned self-approve limit config (private; default 0 = disabled).
create table if not exists app_private.self_approve_limits (
  organization_id uuid not null references public.organizations(id) on delete restrict,
  version bigint not null default 1,
  max_single_amount_vnd numeric(15,2) not null default 0
    check (max_single_amount_vnd >= 0),
  updated_by uuid,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, version)
);
revoke all on app_private.self_approve_limits
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. submission_no allocation under subject lock (atomic, gap-free per subject)
-- ---------------------------------------------------------------------------

create or replace function app_private.next_submission_no_v1(
  p_organization_id uuid, p_subject_type text, p_subject_id uuid)
returns integer
language sql
volatile
security definer
set search_path to 'pg_catalog', 'public'
as $fn$
  select coalesce(max(submission_no), 0) + 1
    from public.approval_requests
   where organization_id = p_organization_id
     and subject_type = p_subject_type
     and subject_id = p_subject_id;
$fn$;
revoke all on function app_private.next_submission_no_v1(uuid, text, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Posting routine: exactly-once, transition-checked (replaces _post_...)
-- ---------------------------------------------------------------------------

create or replace function app_private.post_financial_request_v1(
  p_request_id uuid, p_expected_version bigint, p_actor uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_req public.approval_requests;
  v_ie public.income_expenses;
  v_posting uuid := gen_random_uuid();
  v_rows int;
begin
  select * into v_req from public.approval_requests
   where id = p_request_id for update;
  if not found then raise exception 'request not found' using errcode='P0002'; end if;
  if v_req.version <> p_expected_version then
    raise exception 'version conflict' using errcode='40001';
  end if;
  if v_req.state <> 'PENDING_APPROVAL' then
    raise exception 'request not postable from state %', v_req.state using errcode='55000';
  end if;
  if v_req.posted_event_id is not null then
    raise exception 'request already posted' using errcode='55000';
  end if;

  -- lock + transition the subject voucher; assert exactly one row
  select * into v_ie from public.income_expenses
   where id = v_req.subject_id and organization_id = v_req.organization_id
   for update;
  if not found then raise exception 'subject missing' using errcode='P0002'; end if;
  if v_ie.approval_status = 'APPROVED' or v_ie.posting_id is not null then
    raise exception 'subject already posted' using errcode='55000';
  end if;

  -- Transition the subject voucher through the freeze-exempt canonical path
  -- (t3_10). Only lifecycle columns move; the financial payload stays frozen.
  -- For canonical-marked subjects this is the ONLY legal write path; for legacy
  -- unmarked subjects the plain UPDATE below applies (the guard is a no-op).
  if app_private.is_income_expense_flow_owned(v_req.subject_id) then
    perform app_private.transition_canonical_income_expense_v1(
      v_req.subject_id, 'APPROVED', v_posting, null);
  else
    update public.income_expenses
       set approval_status = 'APPROVED', posting_id = v_posting,
           posted_at_v2 = clock_timestamp()
     where id = v_req.subject_id;
  end if;

  update public.approval_requests
     set state = 'POSTED', posted_at = clock_timestamp(),
         posted_event_id = v_posting, version = version + 1
   where id = p_request_id and version = p_expected_version;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'posting affected % request rows (expected 1)', v_rows
      using errcode='55000';
  end if;

  return v_posting;
end;
$fn$;
revoke all on function app_private.post_financial_request_v1(uuid, bigint, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Decide: maker-checker + snapshot-hash revalidation + CAS
-- ---------------------------------------------------------------------------

create or replace function app_private.decide_financial_request_v1(
  p_request_id uuid, p_expected_version bigint,
  p_actor_membership uuid, p_actor_user uuid,
  p_decision text, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_req public.approval_requests;
  v_ie public.income_expenses;
  v_posting uuid;
  v_step public.approval_request_steps;
  v_next_pending uuid;
begin
  if p_decision not in ('APPROVE','REJECT') then
    raise exception 'invalid decision %', p_decision using errcode='22023';
  end if;
  select * into v_req from public.approval_requests
   where id = p_request_id for update;
  if not found then raise exception 'request not found' using errcode='P0002'; end if;
  if v_req.version <> p_expected_version then
    raise exception 'version conflict' using errcode='40001';
  end if;
  if v_req.state <> 'PENDING_APPROVAL' then
    raise exception 'request not decidable from %', v_req.state using errcode='55000';
  end if;

  -- maker-checker: decider must not be the maker (membership OR user)
  if p_actor_membership = v_req.maker_membership_id
     or p_actor_user = v_req.maker_user_id then
    raise exception 'maker cannot approve own request' using errcode='42501';
  end if;

  -- snapshot revalidation FAIL-CLOSED (H2): a request always has a payload_hash
  -- (NOT NULL column). If the subject lost its hash or drifted, reject.
  select * into v_ie from public.income_expenses
   where id = v_req.subject_id and organization_id = v_req.organization_id
   for update;
  if not found then raise exception 'subject missing' using errcode='P0002'; end if;
  if v_ie.source_payload_hash is null
     or v_req.payload_hash is null
     or v_req.payload_hash <> v_ie.source_payload_hash then
    raise exception 'subject changed or lost its snapshot hash (fail-closed)'
      using errcode='55000';
  end if;

  -- the CURRENT open step is the lowest step_no still PENDING; a request in
  -- PENDING_APPROVAL always has exactly one (submit sets step 1 PENDING, later
  -- steps WAITING, and each satisfied step promotes the next).
  select * into v_step from public.approval_request_steps
   where request_id = p_request_id and status = 'PENDING'
   order by step_no limit 1;
  if not found then
    raise exception 'no PENDING step to decide' using errcode='55000';
  end if;

  -- ELIGIBILITY (C1/H5): the decider must be a current-generation candidate of
  -- THIS step. Non-candidates cannot approve or reject.
  if not app_private.is_eligible_current_candidate_v1(v_step.id, p_actor_membership) then
    raise exception 'actor is not an eligible candidate for this step'
      using errcode='42501';
  end if;

  insert into public.approval_decisions
    (organization_id, request_id, request_step_id, actor_membership_id,
     actor_user_id, decision, reason, request_version)
  values
    (v_req.organization_id, p_request_id, v_step.id, p_actor_membership,
     p_actor_user,
     case p_decision when 'APPROVE' then 'CHECKER_APPROVE' else 'CHECKER_REJECT' end,
     p_reason, v_req.version);

  -- REJECT: any single reject terminates the request.
  if p_decision = 'REJECT' then
    update public.approval_request_steps set status = 'REJECTED' where id = v_step.id;
    update public.approval_requests
       set state = 'REJECTED', version = version + 1
     where id = p_request_id and version = p_expected_version;
    return null;
  end if;

  -- APPROVE: only advance when the step's mode/min_approvals are satisfied by
  -- current-generation candidate approvals (H5 counts correctly).
  if not app_private.step_is_satisfied_v1(v_step.id) then
    -- step not yet satisfied (e.g. QUORUM needs more approvals) — record and stop.
    return null;
  end if;
  update public.approval_request_steps set status = 'APPROVED' where id = v_step.id;

  -- promote the next WAITING step to PENDING, if any (multi-step).
  select id into v_next_pending from public.approval_request_steps
   where request_id = p_request_id and status = 'WAITING'
   order by step_no limit 1;
  if v_next_pending is not null then
    update public.approval_request_steps set status = 'PENDING' where id = v_next_pending;
    return null; -- more approvals required at the next step; not posted yet
  end if;

  -- all steps approved → post exactly once.
  v_posting := app_private.post_financial_request_v1(
    p_request_id, v_req.version, p_actor_user);
  return v_posting;
end;
$fn$;
revoke all on function app_private.decide_financial_request_v1(
  uuid, bigint, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Self-approve within limit (closed exception): server-derived, held-cashbook
-- ---------------------------------------------------------------------------

create or replace function app_private.self_approve_within_limit_v1(
  p_request_id uuid, p_expected_version bigint,
  p_actor_membership uuid, p_actor_user uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_req public.approval_requests;
  v_limit numeric(15,2);
  v_posting uuid;
  v_holds boolean;
  v_is_force boolean;
  v_batch_total numeric(15,2);
  v_allowed boolean;
begin
  select * into v_req from public.approval_requests
   where id = p_request_id for update;
  if not found then raise exception 'request not found' using errcode='P0002'; end if;
  if v_req.version <> p_expected_version then
    raise exception 'version conflict' using errcode='40001'; end if;
  if v_req.state <> 'PENDING_APPROVAL' then
    raise exception 'not pending' using errcode='55000'; end if;

  -- must be the maker (this is a self-approval)
  if p_actor_membership <> v_req.maker_membership_id then
    raise exception 'self-approve requires maker' using errcode='42501';
  end if;

  -- H3 fix: force-approval class is derived from the SUBJECT'S item types
  -- (schema-owned is_deposit + commission/bonus names), NOT from a client-
  -- settable system_source. Force categories can never self-approve.
  select bool_or(coalesce(t.is_deposit,false)
                 or public.nrm_vn(t.name) in ('hoa hong moi gioi','thuong nong sale'))
    into v_is_force
    from public.income_expense_items i
    join public.income_expense_types t on t.id = i.income_expense_type_id
   where i.income_expense_id = v_req.subject_id;
  if coalesce(v_is_force,false) then
    raise exception 'force-approval class cannot self-approve' using errcode='42501';
  end if;

  -- M8 fix: exact permissions via the T2 resolver (self_approve_within_limit
  -- AND cashbooks.post), not just possession.
  perform app_private.lock_org_for_decision_v1(v_req.organization_id);
  select allowed into v_allowed from app_private.authorize_tenant_action_v3(
    p_actor_user, v_req.organization_id,
    'income_expenses.self_approve_within_limit', v_req.building_id, v_req.cashbook_id);
  if not coalesce(v_allowed,false) then
    raise exception 'actor lacks income_expenses.self_approve_within_limit' using errcode='42501';
  end if;
  select allowed into v_allowed from app_private.authorize_tenant_action_v3(
    p_actor_user, v_req.organization_id, 'cashbooks.post',
    v_req.building_id, v_req.cashbook_id);
  if not coalesce(v_allowed,false) then
    raise exception 'actor lacks cashbooks.post' using errcode='42501';
  end if;

  -- versioned limit (default 0 disables self-approval entirely)
  select max_single_amount_vnd into v_limit
    from app_private.self_approve_limits
   where organization_id = v_req.organization_id
   order by version desc limit 1;
  v_limit := coalesce(v_limit, 0);
  if v_limit = 0 then
    raise exception 'self-approve disabled (limit 0)' using errcode='42501';
  end if;
  -- H4 fix: anti-split. Sum this maker's OTHER self-approved-or-pending requests
  -- for the SAME subject (correlation) plus this one; the aggregate must be
  -- within the limit, so splitting one business event into N vouchers is caught.
  select coalesce(sum(r.amount),0) into v_batch_total
    from public.approval_requests r
   where r.organization_id = v_req.organization_id
     and r.subject_id = v_req.subject_id
     and r.maker_membership_id = v_req.maker_membership_id
     and r.state in ('PENDING_APPROVAL','POSTED')
     and r.id <> v_req.id;
  if coalesce(v_req.amount,0) + v_batch_total > v_limit then
    raise exception 'aggregate self-approve amount exceeds limit (% > %)',
      coalesce(v_req.amount,0) + v_batch_total, v_limit using errcode='42501';
  end if;

  -- must hold the cashbook the request posts to
  if v_req.cashbook_id is null then
    raise exception 'self-approve requires a held cashbook' using errcode='42501';
  end if;
  select exists (
    select 1 from public.cashbook_possession_bindings cp
     where cp.organization_id = v_req.organization_id
       and cp.cashbook_id = v_req.cashbook_id
       and cp.membership_id = p_actor_membership
       and cp.possession_kind in ('CUSTODIAN','OPERATOR')
       and cp.valid_from <= clock_timestamp()
       and (cp.valid_to is null or cp.valid_to > clock_timestamp())
  ) into v_holds;
  if not v_holds then
    raise exception 'maker does not hold the target cashbook' using errcode='42501';
  end if;

  declare v_step uuid;
  begin
    select id into v_step from public.approval_request_steps
     where request_id = p_request_id
     order by (status = 'PENDING') desc, step_no limit 1;
    insert into public.approval_decisions
      (organization_id, request_id, request_step_id, actor_membership_id,
       actor_user_id, decision, reason, request_version)
    values
      (v_req.organization_id, p_request_id, v_step, p_actor_membership,
       p_actor_user, 'SELF_APPROVED_WITHIN_LIMIT', 'within versioned limit',
       v_req.version);
  end;

  v_posting := app_private.post_financial_request_v1(
    p_request_id, v_req.version, p_actor_user);
  return v_posting;
end;
$fn$;
revoke all on function app_private.self_approve_within_limit_v1(uuid, bigint, uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Reverse: compensating linked request, original immutable, anti-double
-- ---------------------------------------------------------------------------

create or replace function app_private.reverse_financial_request_v1(
  p_original_request_id uuid, p_actor_membership uuid, p_actor_user uuid,
  p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_orig public.approval_requests;
  v_rev_id uuid;
  v_sub_no int;
begin
  select * into v_orig from public.approval_requests
   where id = p_original_request_id for update;
  if not found then raise exception 'original not found' using errcode='P0002'; end if;
  if v_orig.state <> 'POSTED' then
    raise exception 'only POSTED requests can be reversed' using errcode='55000';
  end if;
  if v_orig.reversed_by_request_id is not null then
    raise exception 'request already reversed' using errcode='55000';
  end if;

  v_sub_no := app_private.next_submission_no_v1(
    v_orig.organization_id, v_orig.subject_type, v_orig.subject_id);

  insert into public.approval_requests
    (organization_id, submission_no, subject_type, subject_id, state,
     maker_membership_id, maker_user_id, rule_set_id, rule_set_version,
     matched_rule_id, rule_effect, payload_snapshot, payload_hash,
     amount, category_id, cashbook_id, building_id, system_source,
     submitted_at, reverses_request_id)
  values
    (v_orig.organization_id, v_sub_no, v_orig.subject_type, v_orig.subject_id,
     'POSTED', p_actor_membership, p_actor_user, v_orig.rule_set_id,
     v_orig.rule_set_version, v_orig.matched_rule_id, 'REVERSAL',
     v_orig.payload_snapshot, v_orig.payload_hash,
     -coalesce(v_orig.amount, 0), v_orig.category_id, v_orig.cashbook_id,
     v_orig.building_id, 'reversal', clock_timestamp(), p_original_request_id)
  returning id into v_rev_id;

  update public.approval_requests
     set state = 'REVERSED', reversed_by_request_id = v_rev_id,
         version = version + 1
   where id = p_original_request_id;

  -- Reversal provenance is the reverses_request_id link + the (chained) audit
  -- event appended by the calling public wrapper; the decision table requires a
  -- step row, and a reversal has no approval step, so we do not write one here.
  -- The full T3 wrapper appends a REVERSAL audit event via the A.5 primitive.

  return v_rev_id;
end;
$fn$;
revoke all on function app_private.reverse_financial_request_v1(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;

commit;
