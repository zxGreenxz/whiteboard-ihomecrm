-- ============================================================================
-- T2 PREPARED TEST 90 — resolver v3 decision matrix (disposable harness only).
-- Runs entirely in one transaction and ROLLS BACK: zero residue.
-- Every assertion raises on failure; script exit 0 = all pass.
-- ============================================================================

begin;

do $tests$
declare
  v_org uuid;
  v_org_b uuid;
  v_owner uuid;
  v_owner_membership uuid;
  v_building uuid;
  v_building_b uuid;
  v_cashbook uuid;
  v_stranger uuid := gen_random_uuid();
  r record;
  v_deny_id uuid;
  v_scope_bld uuid;
begin
  -- fixtures from restored production data
  select organization_id, user_id, id
    into v_org, v_owner, v_owner_membership
    from public.organization_memberships
   where status = 'ACTIVE' and member_type = 'OWNER'
     and organization_id = 'aaaa0000-0000-4000-8000-000000000001'
   limit 1;
  if v_owner is null then
    -- prod org has no OWNER membership in dump; fall back to demo org
    select organization_id, user_id, id
      into v_org, v_owner, v_owner_membership
      from public.organization_memberships
     where status = 'ACTIVE' and member_type = 'OWNER' limit 1;
  end if;
  select id into v_org_b from public.organizations where id <> v_org limit 1;
  select id into v_building from public.buildings
   where organization_id = v_org limit 1;
  select id into v_building_b from public.buildings
   where organization_id = v_org_b limit 1;
  select id into v_cashbook from public.accounts
   where organization_id = v_org and deleted_at is null limit 1;

  -- writer-protocol statement 1
  perform app_private.lock_org_for_decision_v1(v_org);

  -- T1: owner ALLOW via TENANT_OWNER binding for income_expenses.create
  select * into r from app_private.authorize_tenant_action_v3(
    v_owner, v_org, 'income_expenses.create', v_building, null);
  if not r.allowed or r.decision_reason <> 'ROLE_ALLOW' then
    raise exception 'T1 owner allow failed: % %', r.allowed, r.decision_reason;
  end if;
  if r.evaluated_at is null or r.authorization_version is null then
    raise exception 'T1 missing evaluated_at/version';
  end if;

  -- T2: required dimension omitted → REQUIRED_DIMENSION_MISSING (fix #4)
  select * into r from app_private.authorize_tenant_action_v3(
    v_owner, v_org, 'income_expenses.create', null, null);
  if r.allowed or r.decision_reason <> 'REQUIRED_DIMENSION_MISSING' then
    raise exception 'T2 omitted-dimension not denied: % %', r.allowed, r.decision_reason;
  end if;

  -- T3: cross-org target → TARGET_CROSS_ORG_OR_MISSING
  if v_building_b is not null then
    select * into r from app_private.authorize_tenant_action_v3(
      v_owner, v_org, 'income_expenses.create', v_building_b, null);
    if r.allowed or r.decision_reason <> 'TARGET_CROSS_ORG_OR_MISSING' then
      raise exception 'T3 cross-org not denied: % %', r.allowed, r.decision_reason;
    end if;
  end if;

  -- T4: stranger (no membership) → MEMBERSHIP_INACTIVE_OR_MISSING
  select * into r from app_private.authorize_tenant_action_v3(
    v_stranger, v_org, 'income_expenses.create', v_building, null);
  if r.allowed or r.decision_reason <> 'MEMBERSHIP_INACTIVE_OR_MISSING' then
    raise exception 'T4 stranger not denied: % %', r.allowed, r.decision_reason;
  end if;

  -- T5: cashbooks.post = permission-without-possession → POSSESSION_MISSING
  select * into r from app_private.authorize_tenant_action_v3(
    v_owner, v_org, 'cashbooks.post', null, v_cashbook);
  if r.allowed or r.decision_reason <> 'POSSESSION_MISSING' then
    raise exception 'T5 possession gate failed: % %', r.allowed, r.decision_reason;
  end if;

  -- T6: grant possession → ROLE_ALLOW
  insert into public.cashbook_possession_bindings
    (organization_id, cashbook_id, membership_id, possession_kind)
  values (v_org, v_cashbook, v_owner_membership, 'CUSTODIAN');
  select * into r from app_private.authorize_tenant_action_v3(
    v_owner, v_org, 'cashbooks.post', null, v_cashbook);
  if not r.allowed or r.decision_reason <> 'ROLE_ALLOW' then
    raise exception 'T6 possession+permission failed: % %', r.allowed, r.decision_reason;
  end if;

  -- T7: ORGANIZATION-mode member DENY beats role ALLOW (fix #1 + #2)
  insert into public.member_permission_overrides
    (organization_id, membership_id, permission_key, effect, reason, scope_mode)
  values (v_org, v_owner_membership, 'income_expenses.create', 'DENY',
          'test deny', 'ORGANIZATION')
  returning id into v_deny_id;
  insert into public.member_override_scopes (organization_id, override_id, scope_id)
  select v_org, v_deny_id, s.id from public.authorization_scopes s
   where s.organization_id = v_org and s.scope_type = 'ORGANIZATION';
  select * into r from app_private.authorize_tenant_action_v3(
    v_owner, v_org, 'income_expenses.create', v_building, null);
  if r.allowed or r.decision_reason <> 'MEMBER_DENY' then
    raise exception 'T7 org-mode DENY not enforced: % %', r.allowed, r.decision_reason;
  end if;

  -- T8: revoke the deny (lifecycle close) → allow returns
  update public.member_permission_overrides
     set revoked_at = clock_timestamp() where id = v_deny_id;
  select * into r from app_private.authorize_tenant_action_v3(
    v_owner, v_org, 'income_expenses.create', v_building, null);
  if not r.allowed then
    raise exception 'T8 revoked deny still active: %', r.decision_reason;
  end if;

  -- T9: re-grant into the same slot works (partial unique on open rows only)
  insert into public.member_permission_overrides
    (organization_id, membership_id, permission_key, effect, reason, scope_mode)
  values (v_org, v_owner_membership, 'income_expenses.create', 'DENY',
          'test re-grant', 'ORGANIZATION')
  returning id into v_deny_id;
  insert into public.member_override_scopes (organization_id, override_id, scope_id)
  select v_org, v_deny_id, s.id from public.authorization_scopes s
   where s.organization_id = v_org and s.scope_type = 'ORGANIZATION';
  update public.member_permission_overrides
     set revoked_at = clock_timestamp() where id = v_deny_id;

  -- T10: BUILDING-scoped DENY denies that building, not others (fix #2 breadth)
  select id into v_scope_bld from public.authorization_scopes
   where organization_id = v_org and scope_type = 'BUILDING'
     and building_id = v_building limit 1;
  if v_scope_bld is null then
    insert into public.authorization_scopes (organization_id, scope_type, building_id)
    values (v_org, 'BUILDING', v_building) returning id into v_scope_bld;
  end if;
  insert into public.member_permission_overrides
    (organization_id, membership_id, permission_key, effect, reason, scope_mode)
  values (v_org, v_owner_membership, 'income_expenses.create', 'DENY',
          'test scoped deny', 'SCOPED')
  returning id into v_deny_id;
  insert into public.member_override_scopes (organization_id, override_id, scope_id)
  values (v_org, v_deny_id, v_scope_bld);
  select * into r from app_private.authorize_tenant_action_v3(
    v_owner, v_org, 'income_expenses.create', v_building, null);
  if r.allowed or r.decision_reason <> 'MEMBER_DENY' then
    raise exception 'T10 scoped DENY not enforced: % %', r.allowed, r.decision_reason;
  end if;

  -- T11: emergency deny beats everything
  update public.member_permission_overrides
     set revoked_at = clock_timestamp() where id = v_deny_id;
  insert into app_private.tenant_emergency_denies (organization_id, permission_key, reason)
  values (v_org, null, 'test freeze');
  select * into r from app_private.authorize_tenant_action_v3(
    v_owner, v_org, 'income_expenses.create', v_building, null);
  if r.allowed or r.decision_reason <> 'EMERGENCY_DENY' then
    raise exception 'T11 emergency deny failed: % %', r.allowed, r.decision_reason;
  end if;
  delete from app_private.tenant_emergency_denies where organization_id = v_org;

  -- T12: future emergency deny → still allowed but deadline = activation (F8)
  insert into app_private.tenant_emergency_denies
    (organization_id, permission_key, active_from, reason)
  values (v_org, null, clock_timestamp() + interval '1 hour', 'future freeze');
  select * into r from app_private.authorize_tenant_action_v3(
    v_owner, v_org, 'income_expenses.create', v_building, null);
  if not r.allowed then
    raise exception 'T12 future deny active too early: %', r.decision_reason;
  end if;
  if r.nearest_deadline is null
     or r.nearest_deadline > clock_timestamp() + interval '61 minutes' then
    raise exception 'T12 activation deadline missing: %', r.nearest_deadline;
  end if;

  -- T13: unknown permission → PERMISSION_INACTIVE_OR_MISSING
  select * into r from app_private.authorize_tenant_action_v3(
    v_owner, v_org, 'nonexistent.key', v_building, null);
  if r.allowed or r.decision_reason <> 'PERMISSION_INACTIVE_OR_MISSING' then
    raise exception 'T13 unknown key not denied: % %', r.allowed, r.decision_reason;
  end if;

  -- T14: possession on cashbook A does not grant cashbook B
  select * into r from app_private.authorize_tenant_action_v3(
    v_owner, v_org, 'cashbooks.post', null,
    (select id from public.accounts
      where organization_id = v_org and deleted_at is null and id <> v_cashbook limit 1));
  if r.allowed then
    raise exception 'T14 cashbook A possession granted B';
  end if;

  raise notice 'ALL 14 RESOLVER DECISION TESTS PASSED';
end;
$tests$;

rollback;
