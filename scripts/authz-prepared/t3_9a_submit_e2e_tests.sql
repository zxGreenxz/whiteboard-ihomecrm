-- ============================================================================
-- T3 PREPARED TEST 9A — submit → decide → post end-to-end (harness).
-- ROLLBACK at the end. Uses a fresh transaction_domain rule set so it is
-- deterministic regardless of restored rules.
-- ============================================================================

begin;

do $tests$
declare
  v_org uuid;
  v_maker_m uuid; v_maker_u uuid;
  v_checker_m uuid; v_checker_u uuid;
  v_building uuid; v_cashbook uuid; v_type uuid;
  v_rs uuid; v_rsv int;
  v_rule_req uuid; v_rule_auto uuid; v_rule_deny uuid; v_rule_fb uuid;
  v_rstep uuid;
  v_subject uuid; v_req uuid; v_ver bigint; v_posting uuid;
  v_state text;
begin
  select organization_id into v_org from public.organization_memberships
   where status='ACTIVE' group by organization_id having count(*) >= 2 limit 1;
  select id, user_id into v_maker_m, v_maker_u from public.organization_memberships
   where organization_id=v_org and status='ACTIVE' order by id limit 1;
  select id, user_id into v_checker_m, v_checker_u from public.organization_memberships
   where organization_id=v_org and status='ACTIVE' and id<>v_maker_m order by id limit 1;
  select id into v_building from public.buildings where organization_id=v_org limit 1;
  select id into v_cashbook from public.accounts where organization_id=v_org and deleted_at is null limit 1;
  select id into v_type from public.income_expense_types
   where organization_id=v_org and lower(coalesce(type,'expense'))='expense'
     and coalesce(is_deposit,false)=false
     and public.nrm_vn(name) not in ('hoa hong moi gioi','thuong nong sale') limit 1;

  -- build a fresh ACTIVE rule set with three rules: AUTO_POST(<100k),
  -- DENY(>=10M), REQUIRE_APPROVAL(building), plus a fallback.
  insert into public.approval_rule_sets
    (organization_id, transaction_domain, version, status, effective_from)
  values (v_org, 'FINANCIAL_VOUCHER', 999, 'DRAFT', clock_timestamp())
  returning id, version into v_rs, v_rsv;

  -- non-fallback rules must carry a disambiguator; use force_match + amount.
  insert into public.approval_rules
    (organization_id, rule_set_id, name, priority, effect, amount_max, force_match, active)
  values (v_org, v_rs, 'auto small', 10, 'AUTO_POST', 100000, true, true)
  returning id into v_rule_auto;
  insert into public.approval_rules
    (organization_id, rule_set_id, name, priority, effect, amount_min, force_match, active)
  values (v_org, v_rs, 'deny big', 20, 'DENY', 10000000, true, true)
  returning id into v_rule_deny;
  insert into public.approval_rules
    (organization_id, rule_set_id, name, priority, effect, building_id, force_match, active)
  values (v_org, v_rs, 'require by building', 30, 'REQUIRE_APPROVAL', v_building, true, true)
  returning id into v_rule_req;
  insert into public.approval_rules
    (organization_id, rule_set_id, name, priority, effect, is_fallback, active)
  values (v_org, v_rs, 'fallback', 100, 'REQUIRE_APPROVAL', true, true)
  returning id into v_rule_fb;

  -- one step (ANY) with the checker as a MEMBER approver, on the require rule
  insert into public.approval_rule_steps (organization_id, rule_id, step_no, min_approvals, mode)
  values (v_org, v_rule_req, 1, 1, 'ANY') returning id into v_rstep;
  insert into public.approval_step_approvers (organization_id, step_id, approver_type, membership_id)
  values (v_org, v_rstep, 'MEMBER', v_checker_m);
  -- fallback also needs a step (in case it is chosen)
  insert into public.approval_rule_steps (organization_id, rule_id, step_no, min_approvals, mode)
  values (v_org, v_rule_fb, 1, 1, 'ANY');
  insert into public.approval_step_approvers
    (organization_id, step_id, approver_type, membership_id)
  select v_org, id, 'MEMBER', v_checker_m from public.approval_rule_steps where rule_id=v_rule_fb;

  -- publish the DRAFT → ACTIVE (freezes rules; establishes the single ACTIVE)
  perform app_private.publish_rule_set_v1(v_rs, v_maker_u);

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_maker_u, 'role','authenticated')::text, true);

  -- helper to make a subject voucher of a given amount
  -- T1: AUTO_POST path (amount 50k < 100k) → request POSTED immediately
  insert into public.income_expenses
    (organization_id, user_id, type, name, building_id, approval_status,
     voucher_date, total_amount, account_id, source_payload_hash)
  values (v_org, v_maker_u, 'EXPENSE', 'auto voucher', v_building, 'UNAPPROVED',
          current_date, 50000, v_cashbook, md5('auto1')) returning id into v_subject;
  v_req := app_private.submit_financial_request_v1(v_subject, v_maker_m, v_maker_u, 'k-auto');
  select state into v_state from public.approval_requests where id=v_req;
  if v_state <> 'POSTED' then raise exception 'T1 FAILED: auto not POSTED (%)', v_state; end if;

  -- T2: DENY path (amount 20M >= 10M) → request DENIED, no steps
  insert into public.income_expenses
    (organization_id, user_id, type, name, building_id, approval_status,
     voucher_date, total_amount, account_id, source_payload_hash)
  values (v_org, v_maker_u, 'EXPENSE', 'deny voucher', v_building, 'UNAPPROVED',
          current_date, 20000000, v_cashbook, md5('deny1')) returning id into v_subject;
  v_req := app_private.submit_financial_request_v1(v_subject, v_maker_m, v_maker_u, 'k-deny');
  select state into v_state from public.approval_requests where id=v_req;
  if v_state <> 'DENIED' then raise exception 'T2 FAILED: not DENIED (%)', v_state; end if;
  if exists (select 1 from public.approval_request_steps where request_id=v_req) then
    raise exception 'T2 FAILED: DENY created steps';
  end if;

  -- T3: REQUIRE_APPROVAL path (amount 5M: no auto, no deny, building match)
  insert into public.income_expenses
    (organization_id, user_id, type, name, building_id, approval_status,
     voucher_date, total_amount, account_id, source_payload_hash)
  values (v_org, v_maker_u, 'EXPENSE', 'require voucher', v_building, 'UNAPPROVED',
          current_date, 5000000, v_cashbook, md5('req1')) returning id into v_subject;
  v_req := app_private.submit_financial_request_v1(v_subject, v_maker_m, v_maker_u, 'k-req');
  select state, version into v_state, v_ver from public.approval_requests where id=v_req;
  if v_state <> 'PENDING_APPROVAL' then raise exception 'T3 FAILED: not PENDING (%)', v_state; end if;
  -- step + candidate materialized, checker is a candidate, maker is not
  if (select count(*) from public.approval_request_step_candidates c
       join public.approval_request_steps s on s.id=c.request_step_id
      where s.request_id=v_req and c.membership_id=v_checker_m and c.valid_to is null) <> 1 then
    raise exception 'T3 FAILED: checker not a candidate';
  end if;

  -- T4: idempotent resubmit returns the same open request
  if app_private.submit_financial_request_v1(v_subject, v_maker_m, v_maker_u, 'k-req2') <> v_req then
    raise exception 'T4 FAILED: resubmit created a new request';
  end if;

  -- T5: checker decides APPROVE → request POSTED
  v_posting := app_private.decide_financial_request_v1(
    v_req, v_ver, v_checker_m, v_checker_u, 'APPROVE', 'ok');
  if (select state from public.approval_requests where id=v_req) <> 'POSTED' then
    raise exception 'T5 FAILED: not POSTED after approve';
  end if;

  -- T6: maker cannot submit for a subject that is not theirs / inactive membership
  begin
    perform app_private.submit_financial_request_v1(v_subject, gen_random_uuid(), gen_random_uuid(), 'k-x');
    raise exception 'T6 FAILED: submit with bogus membership';
  exception when insufficient_privilege then null;
  end;

  -- T7: no ACTIVE rule set for a domain → fail closed (retire ours, retry)
  update public.approval_rule_sets set status='RETIRED', effective_to=clock_timestamp()
   where id=v_rs;
  insert into public.income_expenses
    (organization_id, user_id, type, name, building_id, approval_status,
     voucher_date, total_amount, account_id, source_payload_hash)
  values (v_org, v_maker_u, 'EXPENSE', 'norule voucher', v_building, 'UNAPPROVED',
          current_date, 5000000, v_cashbook, md5('nr1')) returning id into v_subject;
  begin
    perform app_private.submit_financial_request_v1(v_subject, v_maker_m, v_maker_u, 'k-nr');
    raise exception 'T7 FAILED: submitted with no ACTIVE rule set';
  exception when object_not_in_prerequisite_state then null;
  end;

  raise notice 'ALL 7 SUBMIT E2E TESTS PASSED';
end;
$tests$;

rollback;
