-- ============================================================================
-- T5 PREPARED TEST 93 — salary_payout_v1 (harness). ROLLBACK at end.
-- ============================================================================

begin;

do $tests$
declare
  v_org uuid; v_actor uuid; v_membership uuid; v_staff uuid;
  v_building uuid; v_account uuid; v_org_scope uuid; v_ov uuid;
  v_rs uuid; v_rsv int; v_rule uuid;
  v_res json; v_res2 json; v_voucher uuid;
begin
  -- org that HAS a virtual building (salary writer derives org from it)
  select b.organization_id, b.id into v_org, v_building
    from public.buildings b
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.is_virtual=true and b.deleted_at is null and b.organization_id is not null limit 1;
  if v_org is null then raise exception 'fixture: no virtual building'; end if;
  select m.user_id, m.id into v_actor, v_membership
    from public.organization_memberships m join auth.users u on u.id=m.user_id
   where m.organization_id=v_org and m.status='ACTIVE' order by m.id limit 1;
  select user_id into v_staff from public.organization_memberships
   where organization_id=v_org and status='ACTIVE' and user_id<>v_actor limit 1;
  select id into v_account from public.accounts
   where organization_id=v_org and deleted_at is null limit 1;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role','authenticated')::text, true);

  -- grant salary.distribute (org-mode)
  select id into v_org_scope from public.authorization_scopes
   where organization_id=v_org and scope_type='ORGANIZATION' limit 1;
  insert into public.member_permission_overrides
    (organization_id, membership_id, permission_key, effect, reason, scope_mode)
  values (v_org, v_membership, 'salary.distribute', 'ALLOW', 't', 'ORGANIZATION')
  returning id into v_ov;
  insert into public.member_override_scopes (organization_id, override_id, scope_id)
  values (v_org, v_ov, v_org_scope);

  -- publish an ACTIVE FINANCIAL_VOUCHER rule set (fallback REQUIRE_APPROVAL) so
  -- submit routes force-approval to PENDING (not auto-post).
  insert into public.approval_rule_sets (organization_id, transaction_domain, version, status, effective_from)
  values (v_org, 'FINANCIAL_VOUCHER', 998, 'DRAFT', clock_timestamp()) returning id, version into v_rs, v_rsv;
  insert into public.approval_rules (organization_id, rule_set_id, name, priority, effect, is_fallback, active)
  values (v_org, v_rs, 'fallback', 100, 'REQUIRE_APPROVAL', true, true) returning id into v_rule;
  insert into public.approval_rule_steps (organization_id, rule_id, step_no, min_approvals, mode)
  values (v_org, v_rule, 1, 1, 'ANY');
  -- the approver must be a DIFFERENT member than the maker (the actor) — a salary
  -- voucher can never be self-approved. Register a second member as approver.
  declare v_approver_m uuid;
  begin
    select id into v_approver_m from public.organization_memberships
     where organization_id=v_org and status='ACTIVE' and id<>v_membership order by id limit 1;
    insert into public.approval_step_approvers (organization_id, step_id, approver_type, membership_id)
    select v_org, s.id, 'MEMBER', v_approver_m from public.approval_rule_steps s where s.rule_id=v_rule;
  end;
  perform app_private.publish_rule_set_v1(v_rs, v_actor);

  update app_private.server_feature_flags set mode='ON', config_version=config_version+1,
    commit_sha=repeat('a',40), migration_sha256=repeat('b',64),
    maintenance_window_id='W', approval_reference='A', updated_at=clock_timestamp()
   where feature_key='salary.payout.v1';

  -- T1: payout creates an UNAPPROVED salary voucher and submits it (force-approval)
  v_res := public.salary_payout_v1(v_staff, date_trunc('month',current_date)::date,
    8000000, v_account, current_date, 'lương tháng', 'sal-key-0001');
  v_voucher := (v_res->>'salary_voucher_id')::uuid;
  if v_voucher is null then raise exception 'T1 FAILED: no voucher'; end if;
  -- FORCE-APPROVAL: the voucher must NOT be auto-posted/approved on create
  if (select approval_status from public.income_expenses where id=v_voucher) = 'APPROVED' then
    raise exception 'T1 FAILED: salary self-approved (force-approval violated)'; end if;
  if (v_res->>'state') <> 'PENDING_APPROVAL' then
    raise exception 'T1 FAILED: state %', v_res->>'state'; end if;

  -- T2: an approval request exists in PENDING_APPROVAL for the voucher
  if not exists (select 1 from public.approval_requests
    where subject_id=v_voucher and state='PENDING_APPROVAL') then
    raise exception 'T2 FAILED: no pending approval request'; end if;

  -- T3: salary_monthly row ensured
  if not exists (select 1 from public.salary_monthly
    where staff_id=v_staff and period_month=date_trunc('month',current_date)::date) then
    raise exception 'T3 FAILED: no salary_monthly row'; end if;

  -- T4: idempotent replay → same voucher, no second request
  v_res2 := public.salary_payout_v1(v_staff, date_trunc('month',current_date)::date,
    8000000, v_account, current_date, 'lương tháng', 'sal-key-0001');
  if (v_res2->>'salary_voucher_id') <> (v_res->>'salary_voucher_id') then
    raise exception 'T4 FAILED: replay made a new voucher'; end if;
  if (select count(*) from public.income_expenses where name='Chi lương' and salary_staff_id=v_staff) <> 1 then
    raise exception 'T4 FAILED: duplicate salary voucher'; end if;

  -- T5: without salary.distribute → deny
  update public.member_permission_overrides set revoked_at=clock_timestamp()
   where id=v_ov;
  begin
    perform public.salary_payout_v1(v_staff, date_trunc('month',current_date)::date,
      5000000, v_account, current_date, 'x', 'sal-key-0002');
    raise exception 'T5 FAILED: paid without salary.distribute';
  exception when insufficient_privilege then null;
  end;

  raise notice 'ALL 5 SALARY PAYOUT TESTS PASSED';
end;
$tests$;

rollback;
