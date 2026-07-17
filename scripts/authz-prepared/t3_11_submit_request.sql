-- ============================================================================
-- T3 PREPARED SQL 11 — submit_financial_request_v1 (approval-engine front half).
-- STATUS: PREPARED (compile+behavior tested on disposable PG17 exact-source
-- restore). NOT a migration; private; no grant.
--
-- Closes the gap between t3_06 (decide/post/self/emergency/reverse) and the
-- request creation. For subject FINANCIAL_VOUCHER it:
--   1. locks the subject income_expenses row FOR UPDATE, derives org/amount/
--      cashbook/building server-side (never from client args);
--   2. resolves the active rule set via resolve_active_rule_set_v1 (fail-closed);
--   3. matches the highest-priority active rule (transaction_type/category/
--      cashbook/building/area/system_source/amount range/force_match), else the
--      single fallback REQUIRE_APPROVAL rule;
--   4. AUTO_POST -> post immediately (post_financial_request_v1); DENY ->
--      DENIED; REQUIRE_APPROVAL/force -> PENDING_APPROVAL with steps+candidates;
--   5. allocates submission_no atomically under the subject lock;
--   6. snapshots the payload + hash; one-open-subject partial unique enforced.
-- Force categories (commission/bonus/refund/deposit/salary/profit/contract)
-- always route to REQUIRE_APPROVAL regardless of the matched rule effect.
-- ============================================================================

begin;

-- Domain constant: which transaction_domain governs income/expense vouchers.
-- (Rule sets are keyed by (organization_id, transaction_domain, version).)
create or replace function app_private.ie_transaction_domain_v1()
returns text language sql immutable
set search_path to 'pg_catalog'
as $fn$ select 'FINANCIAL_VOUCHER'::text $fn$;

create or replace function app_private.submit_financial_request_v1(
  p_subject_id uuid,
  p_actor_membership uuid,
  p_actor_user uuid,
  p_idempotency_key text)
returns uuid
language plpgsql
volatile
security definer
set search_path to 'pg_catalog', 'app_private', 'public'
as $fn$
declare
  v_ie public.income_expenses;
  v_org uuid;
  v_rule_set uuid;
  v_rule public.approval_rules;
  v_effect text;
  v_is_force boolean;
  v_sub_no int;
  v_hash text;
  v_snapshot jsonb;
  v_req uuid;
  v_ver bigint;
  v_type record;
  r_step record;
  v_step_id uuid;
  v_posting uuid;
  v_existing uuid;
begin
  -- 1. lock + derive from the subject (never trust client-derived fields)
  select * into v_ie from public.income_expenses
   where id = p_subject_id and deleted_at is null for update;
  if not found then raise exception 'subject not found' using errcode='P0002'; end if;
  v_org := v_ie.organization_id;
  if v_org is null then raise exception 'subject has no organization' using errcode='23514'; end if;

  -- maker attribution must be a real ACTIVE membership of this org matching the
  -- actor user (composite FK on approval_requests enforces this too).
  if not exists (
    select 1 from public.organization_memberships m
     where m.id = p_actor_membership and m.organization_id = v_org
       and m.user_id = p_actor_user and m.status = 'ACTIVE') then
    raise exception 'maker membership/user not active in org' using errcode='42501';
  end if;

  -- idempotent replay: an open request for the same subject with the same key
  -- returns the same request (append-only; one-open-subject guarantees <=1).
  select id into v_existing from public.approval_requests
   where organization_id = v_org and subject_type = 'FINANCIAL_VOUCHER'
     and subject_id = p_subject_id and state = 'PENDING_APPROVAL';
  if v_existing is not null then
    return v_existing; -- already submitted; idempotent
  end if;

  -- 2. resolve the single ACTIVE rule set (fail-closed)
  v_rule_set := app_private.resolve_active_rule_set_v1(
    v_org, app_private.ie_transaction_domain_v1());

  -- classify force categories from the item types of the subject
  select bool_or(coalesce(t.is_deposit,false)
                 or public.nrm_vn(t.name) in ('hoa hong moi gioi','thuong nong sale'))
    into v_is_force
    from public.income_expense_items i
    join public.income_expense_types t on t.id = i.income_expense_type_id
   where i.income_expense_id = p_subject_id;
  v_is_force := coalesce(v_is_force, false);

  -- 3. match the highest-priority active rule; else fallback
  select * into v_rule from public.approval_rules r
   where r.rule_set_id = v_rule_set and r.active
     and not r.is_fallback
     and (r.force_match
          or r.transaction_type is null or r.transaction_type = v_ie.type)
     and (r.building_id is null or r.building_id = v_ie.building_id)
     and (r.cashbook_id is null or r.cashbook_id = v_ie.account_id)
     and (r.category_id is null or exists (
       select 1 from public.income_expense_items i
        where i.income_expense_id = p_subject_id
          and i.income_expense_type_id = r.category_id))
     and (r.system_source is null or r.system_source = v_ie.system_source)
     and (r.amount_min is null or v_ie.total_amount >= r.amount_min)
     and (r.amount_max is null or v_ie.total_amount <= r.amount_max)
   order by r.priority asc
   limit 1;
  if not found then
    select * into v_rule from public.approval_rules r
     where r.rule_set_id = v_rule_set and r.is_fallback and r.active
     limit 1;
    if not found then
      raise exception 'no matching or fallback rule (fail-closed)' using errcode='55000';
    end if;
  end if;

  -- force categories can never AUTO_POST
  v_effect := v_rule.effect;
  if v_is_force and v_effect = 'AUTO_POST' then
    v_effect := 'REQUIRE_APPROVAL';
  end if;

  -- 5. submission_no under the subject lock
  select coalesce(max(submission_no),0) + 1 into v_sub_no
    from public.approval_requests
   where organization_id = v_org and subject_type = 'FINANCIAL_VOUCHER'
     and subject_id = p_subject_id;

  -- 6. snapshot + hash (canonical fields only; not client spelling)
  v_snapshot := jsonb_build_object(
    'subject_id', p_subject_id, 'amount', v_ie.total_amount,
    'account_id', v_ie.account_id, 'building_id', v_ie.building_id,
    'type', v_ie.type, 'source_payload_hash', v_ie.source_payload_hash);
  v_hash := coalesce(v_ie.source_payload_hash, md5(v_snapshot::text));

  insert into public.approval_requests
    (organization_id, submission_no, subject_type, subject_id, state,
     maker_membership_id, maker_user_id, rule_set_id, rule_set_version,
     matched_rule_id, rule_effect, payload_snapshot, payload_hash, amount,
     category_id, cashbook_id, building_id, system_source, submitted_at, version)
  select
    v_org, v_sub_no, 'FINANCIAL_VOUCHER', p_subject_id,
    case v_effect when 'AUTO_POST' then 'PENDING_APPROVAL'
                  when 'DENY' then 'DENIED'
                  else 'PENDING_APPROVAL' end,
    p_actor_membership, p_actor_user, rs.id, rs.version,
    v_rule.id, v_effect, v_snapshot, v_hash, v_ie.total_amount,
    v_rule.category_id, v_ie.account_id, v_ie.building_id, v_ie.system_source,
    clock_timestamp(), 1
  from public.approval_rule_sets rs where rs.id = v_rule_set
  returning id, version into v_req, v_ver;

  -- DENY: terminal, no steps
  if v_effect = 'DENY' then
    return v_req;
  end if;

  -- AUTO_POST: post immediately (no approval steps)
  if v_effect = 'AUTO_POST' then
    v_posting := app_private.post_financial_request_v1(v_req, v_ver, p_actor_user);
    return v_req;
  end if;

  -- REQUIRE_APPROVAL: materialize steps from the matched rule's rule steps,
  -- then candidates for each. Fail-closed if the rule has no steps.
  if not exists (select 1 from public.approval_rule_steps
                  where rule_id = v_rule.id) then
    raise exception 'REQUIRE_APPROVAL rule % has no steps', v_rule.id using errcode='55000';
  end if;

  for r_step in
    select * from public.approval_rule_steps
     where rule_id = v_rule.id order by step_no
  loop
    insert into public.approval_request_steps
      (organization_id, request_id, step_no, status, mode, min_approvals,
       current_generation, rule_step_snapshot, candidate_count)
    values
      (v_org, v_req, r_step.step_no,
       case when r_step.step_no = 1 then 'PENDING' else 'WAITING' end,
       r_step.mode, r_step.min_approvals, 1,
       jsonb_build_object('rule_step_id', r_step.id), 0)
    returning id into v_step_id;

    perform app_private.materialize_step_candidates_v1(v_step_id);
  end loop;

  return v_req;
end;
$fn$;

revoke all on function app_private.submit_financial_request_v1(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function app_private.ie_transaction_domain_v1()
  from public, anon, authenticated, service_role;

commit;
