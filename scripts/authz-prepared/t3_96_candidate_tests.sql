-- ============================================================================
-- T3 PREPARED TEST 96 — candidate materialization + ANY/ALL/QUORUM (harness).
-- ROLLBACK at the end.
-- ============================================================================

begin;

do $tests$
declare
  v_org uuid;
  v_maker_m uuid; v_maker_u uuid;
  v_m2 uuid; v_m3 uuid; v_m4 uuid;
  v_building uuid; v_cashbook uuid;
  v_rs uuid; v_rsv int; v_rule uuid; v_rule_step uuid;
  v_subject uuid; v_req uuid; v_step uuid;
  v_count int;
begin
  select organization_id into v_org from public.organization_memberships
   where status='ACTIVE' group by organization_id
   having count(*) >= 4 limit 1;
  select id, user_id into v_maker_m, v_maker_u from public.organization_memberships
   where organization_id=v_org and status='ACTIVE' order by id limit 1;
  select array_agg(id) into strict v_m2 from (
    select id from public.organization_memberships
     where organization_id=v_org and status='ACTIVE' and id<>v_maker_m
     order by id limit 1) q;
  select id into v_m2 from public.organization_memberships
   where organization_id=v_org and status='ACTIVE' and id<>v_maker_m order by id offset 0 limit 1;
  select id into v_m3 from public.organization_memberships
   where organization_id=v_org and status='ACTIVE' and id<>v_maker_m order by id offset 1 limit 1;
  select id into v_m4 from public.organization_memberships
   where organization_id=v_org and status='ACTIVE' and id<>v_maker_m order by id offset 2 limit 1;
  select id into v_building from public.buildings where organization_id=v_org limit 1;
  select id into v_cashbook from public.accounts where organization_id=v_org and deleted_at is null limit 1;
  select rs.id, rs.version, r.id into v_rs, v_rsv, v_rule
    from public.approval_rules r
    join public.approval_rule_sets rs on rs.id = r.rule_set_id
   where r.organization_id = v_org limit 1;

  -- create a rule step + three MEMBER approvers (m2,m3,m4)
  insert into public.approval_rule_steps (organization_id, rule_id, step_no, min_approvals, mode)
  values (v_org, v_rule, 1, 2, 'QUORUM') returning id into v_rule_step;
  insert into public.approval_step_approvers (organization_id, step_id, approver_type, membership_id)
  values (v_org, v_rule_step, 'MEMBER', v_m2),
         (v_org, v_rule_step, 'MEMBER', v_m3),
         (v_org, v_rule_step, 'MEMBER', v_m4);

  insert into public.income_expenses
    (organization_id, user_id, type, name, building_id, approval_status,
     voucher_date, total_amount, source_payload_hash)
  values (v_org, v_maker_u, 'EXPENSE', 'cand subject', v_building,
          'UNAPPROVED', current_date, 1000, md5('c1')) returning id into v_subject;
  insert into public.approval_requests
    (organization_id, submission_no, subject_type, subject_id, state,
     maker_membership_id, maker_user_id, rule_set_id, rule_set_version,
     matched_rule_id, rule_effect, payload_snapshot, payload_hash, amount,
     cashbook_id, building_id, system_source, submitted_at, version)
  values (v_org, 1, 'FINANCIAL_VOUCHER', v_subject, 'PENDING_APPROVAL',
          v_maker_m, v_maker_u, v_rs, v_rsv, v_rule, 'REQUIRE_APPROVAL',
          '{}'::jsonb, md5('c1'), 1000, v_cashbook, v_building, 'manual',
          clock_timestamp(), 1) returning id into v_req;
  insert into public.approval_request_steps
    (organization_id, request_id, step_no, status, mode, min_approvals,
     current_generation, rule_step_snapshot, candidate_count)
  values (v_org, v_req, 1, 'PENDING', 'QUORUM', 2, 1,
          jsonb_build_object('rule_step_id', v_rule_step), 0)
  returning id into v_step;

  -- T1: materialize → 3 candidates (excludes maker), generation bumps 1→2
  v_count := app_private.materialize_step_candidates_v1(v_step);
  if v_count <> 3 then raise exception 'T1 FAILED: % candidates', v_count; end if;
  if (select current_generation from public.approval_request_steps where id=v_step) <> 2 then
    raise exception 'T1 FAILED: generation not bumped';
  end if;

  -- T2: maker is not a candidate even if added as approver
  insert into public.approval_step_approvers (organization_id, step_id, approver_type, membership_id)
  values (v_org, v_rule_step, 'MEMBER', v_maker_m);
  v_count := app_private.materialize_step_candidates_v1(v_step);
  if v_count <> 3 then raise exception 'T2 FAILED: maker leaked in (%)', v_count; end if;
  if exists (select 1 from public.approval_request_step_candidates
              where request_step_id=v_step and membership_id=v_maker_m and valid_to is null) then
    raise exception 'T2 FAILED: maker is a candidate';
  end if;

  -- T3: rematerialize closes the prior generation
  if (select count(*) from public.approval_request_step_candidates
       where request_step_id=v_step and generation=2 and valid_to is not null) <> 3 then
    raise exception 'T3 FAILED: gen 2 not closed';
  end if;
  if (select current_generation from public.approval_request_steps where id=v_step) <> 3 then
    raise exception 'T3 FAILED: gen not 3';
  end if;

  -- T4: eligibility check honours current generation only
  if not app_private.is_eligible_current_candidate_v1(v_step, v_m2) then
    raise exception 'T4 FAILED: m2 not eligible';
  end if;
  if app_private.is_eligible_current_candidate_v1(v_step, v_maker_m) then
    raise exception 'T4 FAILED: maker eligible';
  end if;

  -- T5: QUORUM(2) satisfaction — one approval not enough, two is
  insert into public.approval_decisions
    (organization_id, request_id, request_step_id, actor_membership_id,
     actor_user_id, decision, request_version)
  values (v_org, v_req, v_step, v_m2,
          (select user_id from public.organization_memberships where id=v_m2),
          'CHECKER_APPROVE', 1);
  if app_private.step_is_satisfied_v1(v_step) then
    raise exception 'T5 FAILED: satisfied with 1/2';
  end if;
  insert into public.approval_decisions
    (organization_id, request_id, request_step_id, actor_membership_id,
     actor_user_id, decision, request_version)
  values (v_org, v_req, v_step, v_m3,
          (select user_id from public.organization_memberships where id=v_m3),
          'CHECKER_APPROVE', 1);
  if not app_private.step_is_satisfied_v1(v_step) then
    raise exception 'T5 FAILED: not satisfied with 2/2';
  end if;

  -- T6: impossible quorum fails closed
  update public.approval_request_steps set mode='QUORUM', min_approvals=99 where id=v_step;
  begin
    perform app_private.materialize_step_candidates_v1(v_step);
    raise exception 'T6 FAILED: impossible quorum accepted';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T7: zero eligible candidates fails closed
  update public.approval_request_steps set mode='ANY', min_approvals=1 where id=v_step;
  delete from public.approval_step_approvers where step_id=v_rule_step;
  begin
    perform app_private.materialize_step_candidates_v1(v_step);
    raise exception 'T7 FAILED: zero candidates accepted';
  exception when object_not_in_prerequisite_state then null;
  end;

  raise notice 'ALL 7 CANDIDATE MATERIALIZATION TESTS PASSED';
end;
$tests$;

rollback;
