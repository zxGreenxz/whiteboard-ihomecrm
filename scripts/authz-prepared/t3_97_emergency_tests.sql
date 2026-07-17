-- ============================================================================
-- T3 PREPARED TEST 97 — emergency owner override (harness). ROLLBACK at end.
-- ============================================================================

begin;

do $tests$
declare
  v_org uuid;
  v_owner_m uuid; v_owner_u uuid;
  v_maker_m uuid; v_maker_u uuid;
  v_building uuid; v_cashbook uuid;
  v_rs uuid; v_rsv int; v_rule uuid;
  v_subject uuid; v_req uuid; v_step uuid; v_ver bigint;
  v_posting uuid;
begin
  -- org that has an ACTIVE OWNER membership + TENANT_OWNER binding (from t2_02)
  select m.organization_id, m.id, m.user_id into v_org, v_owner_m, v_owner_u
    from public.organization_memberships m
    join public.role_bindings rb on rb.membership_id = m.id
    join public.organization_roles r on r.id = rb.role_id and r.system_key='TENANT_OWNER'
   where m.status='ACTIVE' and m.member_type='OWNER' limit 1;
  if v_owner_u is null then raise exception 'fixture: no owner with TENANT_OWNER binding'; end if;

  select id, user_id into v_maker_m, v_maker_u from public.organization_memberships
   where organization_id=v_org and status='ACTIVE' and id<>v_owner_m order by id limit 1;
  select id into v_building from public.buildings where organization_id=v_org limit 1;
  select id into v_cashbook from public.accounts where organization_id=v_org and deleted_at is null limit 1;
  select rs.id, rs.version, r.id into v_rs, v_rsv, v_rule
    from public.approval_rules r join public.approval_rule_sets rs on rs.id=r.rule_set_id
   where r.organization_id=v_org limit 1;

  insert into public.income_expenses
    (organization_id, user_id, type, name, building_id, approval_status,
     voucher_date, total_amount, source_payload_hash)
  values (v_org, v_maker_u, 'EXPENSE', 'emergency subject', v_building,
          'UNAPPROVED', current_date, 5000000, md5('e1')) returning id into v_subject;
  insert into public.approval_requests
    (organization_id, submission_no, subject_type, subject_id, state,
     maker_membership_id, maker_user_id, rule_set_id, rule_set_version,
     matched_rule_id, rule_effect, payload_snapshot, payload_hash, amount,
     cashbook_id, building_id, system_source, submitted_at, version)
  values (v_org, 1, 'FINANCIAL_VOUCHER', v_subject, 'PENDING_APPROVAL',
          v_maker_m, v_maker_u, v_rs, v_rsv, v_rule, 'REQUIRE_APPROVAL',
          '{}'::jsonb, md5('e1'), 5000000, v_cashbook, v_building, 'manual',
          clock_timestamp(), 1) returning id, version into v_req, v_ver;
  insert into public.approval_request_steps
    (organization_id, request_id, step_no, status, mode, min_approvals,
     current_generation, rule_step_snapshot, candidate_count)
  values (v_org, v_req, 1, 'PENDING', 'ANY', 1, 1, '{}'::jsonb, 1)
  returning id into v_step;

  -- T1: reason too short → 22023
  begin
    perform app_private.emergency_approve_financial_v1(
      v_req, v_ver, v_owner_m, v_owner_u, 'too short', true);
    raise exception 'T1 FAILED: short reason accepted';
  exception when invalid_parameter_value then null;
  end;

  -- T2: stale re-auth → 42501
  begin
    perform app_private.emergency_approve_financial_v1(
      v_req, v_ver, v_owner_m, v_owner_u,
      'emergency override reason exceeding twenty chars', false);
    raise exception 'T2 FAILED: stale reauth accepted';
  exception when insufficient_privilege then null;
  end;

  -- T3: non-owner cannot emergency-approve
  begin
    perform app_private.emergency_approve_financial_v1(
      v_req, v_ver, v_maker_m, v_maker_u,
      'emergency override reason exceeding twenty chars', true);
    raise exception 'T3 FAILED: non-owner emergency approved';
  exception when insufficient_privilege then null;
  end;

  -- T4: valid owner emergency approve → posts, steps bypassed, event recorded
  v_posting := app_private.emergency_approve_financial_v1(
    v_req, v_ver, v_owner_m, v_owner_u,
    'genuine emergency: accountant unavailable, payment deadline today', true);
  if v_posting is null then raise exception 'T4 FAILED: no posting'; end if;
  if (select state from public.approval_requests where id=v_req) <> 'POSTED' then
    raise exception 'T4 FAILED: not posted';
  end if;
  if (select status from public.approval_request_steps where id=v_step) <> 'BYPASSED' then
    raise exception 'T4 FAILED: step not bypassed';
  end if;
  if (select count(*) from app_private.emergency_override_events where request_id=v_req) <> 1 then
    raise exception 'T4 FAILED: no security event';
  end if;
  if (select count(*) from public.approval_decisions
       where request_id=v_req and decision='EMERGENCY_APPROVE') <> 1 then
    raise exception 'T4 FAILED: no emergency decision';
  end if;

  -- T5: emergency event ledger append-only
  begin
    delete from app_private.emergency_override_events where request_id=v_req;
    raise exception 'T5 FAILED: emergency event deletable';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T6: re-emergency after POSTED rejected
  select version into v_ver from public.approval_requests where id=v_req;
  begin
    perform app_private.emergency_approve_financial_v1(
      v_req, v_ver, v_owner_m, v_owner_u,
      'second emergency attempt on already posted request', true);
    raise exception 'T6 FAILED: emergency on posted';
  exception when object_not_in_prerequisite_state then null;
  end;

  raise notice 'ALL 6 EMERGENCY OVERRIDE TESTS PASSED';
end;
$tests$;

rollback;
