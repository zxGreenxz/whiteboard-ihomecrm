-- ============================================================================
-- T3 PREPARED TEST 95 — approval v2 state machine (disposable harness only).
-- ROLLBACK at the end. Uses a synthetic PENDING_APPROVAL request over a real
-- income_expenses subject; asserts maker-checker, self-approve limit,
-- exactly-once posting, snapshot revalidation, and reversal linkage.
-- ============================================================================

begin;

do $tests$
declare
  v_org uuid;
  v_maker_m uuid; v_maker_u uuid;
  v_checker_m uuid; v_checker_u uuid;
  v_building uuid;
  v_cashbook uuid;
  v_subject uuid;
  v_req uuid;
  v_ver bigint;
  v_posting uuid;
  v_rev uuid;
  v_cnt int;
  v_rs uuid; v_rsv int; v_rule uuid;
  v_step uuid;
  v_stranger_m uuid; v_stranger_u uuid;
begin
  select organization_id into v_org from public.organization_memberships
   where status='ACTIVE' group by organization_id
   having count(*) filter (where member_type is not null) >= 3 limit 1;
  select id, user_id into v_maker_m, v_maker_u from public.organization_memberships
   where organization_id=v_org and status='ACTIVE' order by id limit 1;
  select id, user_id into v_checker_m, v_checker_u from public.organization_memberships
   where organization_id=v_org and status='ACTIVE' and id<>v_maker_m order by id limit 1;
  select id, user_id into v_stranger_m, v_stranger_u from public.organization_memberships
   where organization_id=v_org and status='ACTIVE'
     and id not in (v_maker_m, v_checker_m) order by id limit 1;
  select id into v_building from public.buildings where organization_id=v_org limit 1;
  select id into v_cashbook from public.accounts
   where organization_id=v_org and deleted_at is null limit 1;
  select id, version into v_rs, v_rsv from public.approval_rule_sets limit 1;
  select id into v_rule from public.approval_rules limit 1;

  insert into public.income_expenses
    (organization_id, user_id, type, name, building_id, approval_status,
     voucher_date, total_amount, source_payload_hash)
  values (v_org, v_maker_u, 'EXPENSE', 'approval v2 subject', v_building,
          'UNAPPROVED', current_date, 500000, md5('snap-v1'))
  returning id into v_subject;

  insert into public.approval_requests
    (organization_id, submission_no, subject_type, subject_id, state,
     maker_membership_id, maker_user_id, rule_set_id, rule_set_version,
     matched_rule_id, rule_effect, payload_snapshot, payload_hash, amount,
     cashbook_id, building_id, system_source, submitted_at, version)
  values (v_org, 1, 'FINANCIAL_VOUCHER', v_subject, 'PENDING_APPROVAL',
          v_maker_m, v_maker_u, v_rs, v_rsv, v_rule, 'REQUIRE_APPROVAL',
          '{}'::jsonb, md5('snap-v1'), 500000, v_cashbook,
          v_building, 'manual', clock_timestamp(), 1)
  returning id, version into v_req, v_ver;

  insert into public.approval_request_steps
    (organization_id, request_id, step_no, status, mode, min_approvals,
     current_generation, rule_step_snapshot, candidate_count)
  values (v_org, v_req, 1, 'PENDING', 'ANY', 1, 1, '{}'::jsonb, 1)
  returning id into v_step;
  -- the checker is the eligible candidate for step 1 (decide now enforces this)
  insert into public.approval_request_step_candidates
    (organization_id, request_step_id, membership_id, generation, source_kind)
  values (v_org, v_step, v_checker_m, 1, 'MEMBER');
  update public.approval_request_steps set candidate_count=1 where id=v_step;

  -- T0b: a non-candidate cannot approve even though not the maker
  begin
    perform app_private.decide_financial_request_v1(
      v_req, v_ver, v_stranger_m, v_stranger_u, 'APPROVE', 'intruder');
    raise exception 'T0b FAILED: non-candidate approved';
  exception when insufficient_privilege then null;
  end;

  -- T1: maker cannot decide own request
  begin
    perform app_private.decide_financial_request_v1(
      v_req, v_ver, v_maker_m, v_maker_u, 'APPROVE', 'self');
    raise exception 'T1 FAILED: maker approved own request';
  exception when insufficient_privilege then null;
  end;

  -- T2: version conflict rejected
  begin
    perform app_private.decide_financial_request_v1(
      v_req, v_ver + 5, v_checker_m, v_checker_u, 'APPROVE', 'stale');
    raise exception 'T2 FAILED: stale version accepted';
  exception when serialization_failure then null;
  end;

  -- T3: snapshot mismatch rejected (subject hash changed after submit)
  update public.income_expenses set source_payload_hash = md5('snap-v2')
   where id = v_subject;
  begin
    perform app_private.decide_financial_request_v1(
      v_req, v_ver, v_checker_m, v_checker_u, 'APPROVE', 'ok');
    raise exception 'T3 FAILED: mismatched snapshot posted';
  exception when object_not_in_prerequisite_state then null;
  end;
  update public.income_expenses set source_payload_hash = md5('snap-v1')
   where id = v_subject;

  -- T4: checker approves → posted exactly once
  select version into v_ver from public.approval_requests where id=v_req;
  v_posting := app_private.decide_financial_request_v1(
    v_req, v_ver, v_checker_m, v_checker_u, 'APPROVE', 'approved');
  if v_posting is null then raise exception 'T4 FAILED: no posting id'; end if;
  select count(*) into v_cnt from public.approval_requests
   where id=v_req and state='POSTED';
  if v_cnt <> 1 then raise exception 'T4 FAILED: not POSTED'; end if;

  -- T5: re-decide after POSTED rejected
  select version into v_ver from public.approval_requests where id=v_req;
  begin
    perform app_private.decide_financial_request_v1(
      v_req, v_ver, v_checker_m, v_checker_u, 'APPROVE', 'again');
    raise exception 'T5 FAILED: decided twice';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T6: reversal creates linked compensating request, original REVERSED once
  v_rev := app_private.reverse_financial_request_v1(
    v_req, v_checker_m, v_checker_u, 'hoàn tác');
  if (select state from public.approval_requests where id=v_req) <> 'REVERSED' then
    raise exception 'T6 FAILED: original not REVERSED';
  end if;
  if (select reverses_request_id from public.approval_requests where id=v_rev) <> v_req then
    raise exception 'T6 FAILED: reversal link missing';
  end if;
  if (select amount from public.approval_requests where id=v_rev) <> -500000 then
    raise exception 'T6 FAILED: reversal amount not negated';
  end if;

  -- T7: double reversal rejected
  begin
    perform app_private.reverse_financial_request_v1(
      v_req, v_checker_m, v_checker_u, 'lần 2');
    raise exception 'T7 FAILED: reversed twice';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T8: self-approve blocked when limit = 0 (default)
  insert into public.income_expenses
    (organization_id, user_id, type, name, building_id, approval_status,
     voucher_date, total_amount, source_payload_hash)
  values (v_org, v_maker_u, 'EXPENSE', 'self-approve subject', v_building,
          'UNAPPROVED', current_date, 100000, md5('sa-1'))
  returning id into v_subject;
  insert into public.approval_requests
    (organization_id, submission_no, subject_type, subject_id, state,
     maker_membership_id, maker_user_id, rule_set_id, rule_set_version,
     matched_rule_id, rule_effect, payload_snapshot, payload_hash, amount,
     cashbook_id, building_id, system_source, submitted_at, version)
  values (v_org, 1, 'FINANCIAL_VOUCHER', v_subject, 'PENDING_APPROVAL',
          v_maker_m, v_maker_u, v_rs, v_rsv, v_rule, 'REQUIRE_APPROVAL',
          '{}'::jsonb, md5('sa-1'), 100000, v_cashbook,
          v_building, 'manual', clock_timestamp(), 1)
  returning id, version into v_req, v_ver;

  insert into public.approval_request_steps
    (organization_id, request_id, step_no, status, mode, min_approvals,
     current_generation, rule_step_snapshot, candidate_count)
  values (v_org, v_req, 1, 'PENDING', 'ANY', 1, 1, '{}'::jsonb, 1);

  begin
    perform app_private.self_approve_within_limit_v1(v_req, v_ver, v_maker_m, v_maker_u);
    raise exception 'T8 FAILED: self-approved with 0 limit';
  exception when insufficient_privilege then null;
  end;

  -- T9: self-approve blocked without possession even under a raised limit
  insert into app_private.self_approve_limits (organization_id, version, max_single_amount_vnd)
  values (v_org, 1, 1000000);
  begin
    perform app_private.self_approve_within_limit_v1(v_req, v_ver, v_maker_m, v_maker_u);
    raise exception 'T9 FAILED: self-approved without possession';
  exception when insufficient_privilege then null;
  end;

  -- T9b: even with limit + possession, missing the exact permission still blocks
  insert into public.cashbook_possession_bindings
    (organization_id, cashbook_id, membership_id, possession_kind)
  values (v_org, v_cashbook, v_maker_m, 'CUSTODIAN');
  begin
    perform app_private.self_approve_within_limit_v1(v_req, v_ver, v_maker_m, v_maker_u);
    raise exception 'T9b FAILED: self-approved without the exact permission';
  exception when insufficient_privilege then null;
  end;

  -- T10: grant the two exact permissions via member ALLOW overrides.
  -- self_approve_within_limit is building-scoped → ORGANIZATION-mode edge is fine;
  -- cashbooks.post is CASHBOOK-scoped + requires possession → SCOPED edge on the
  -- exact cashbook. Then within limit + possession + permission → posts.
  declare v_org_scope uuid; v_cb_scope uuid; v_ov1 uuid; v_ov2 uuid;
  begin
    select id into v_org_scope from public.authorization_scopes
     where organization_id=v_org and scope_type='ORGANIZATION' limit 1;
    select id into v_cb_scope from public.authorization_scopes
     where organization_id=v_org and scope_type='CASHBOOK' and cashbook_id=v_cashbook limit 1;

    insert into public.member_permission_overrides
      (organization_id, membership_id, permission_key, effect, reason, scope_mode)
    values (v_org, v_maker_m, 'income_expenses.self_approve_within_limit', 'ALLOW', 'test', 'ORGANIZATION')
    returning id into v_ov1;
    insert into public.member_override_scopes (organization_id, override_id, scope_id)
    values (v_org, v_ov1, v_org_scope);

    insert into public.member_permission_overrides
      (organization_id, membership_id, permission_key, effect, reason, scope_mode)
    values (v_org, v_maker_m, 'cashbooks.post', 'ALLOW', 'test', 'SCOPED')
    returning id into v_ov2;
    insert into public.member_override_scopes (organization_id, override_id, scope_id)
    values (v_org, v_ov2, v_cb_scope);
  end;
  v_posting := app_private.self_approve_within_limit_v1(v_req, v_ver, v_maker_m, v_maker_u);
  if v_posting is null
     or (select state from public.approval_requests where id=v_req) <> 'POSTED' then
    raise exception 'T10 FAILED: self-approve did not post';
  end if;

  raise notice 'ALL 11 APPROVAL V2 TESTS PASSED';
end;
$tests$;

rollback;
