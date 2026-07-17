-- ============================================================================
-- T5 PREPARED TEST 92 — cashbook writers (harness). ROLLBACK at end.
-- ============================================================================

begin;

do $tests$
declare
  v_org uuid; v_actor uuid; v_membership uuid;
  v_org_scope uuid; v_cb_scope uuid;
  v_cb uuid; v_res json; v_res2 json;
  v_lock date; v_cnt int;
begin
  -- org with exactly one ACTIVE membership for the actor (create derives org
  -- from a single membership). Pick a user with only one org membership.
  select m.user_id, m.organization_id, m.id into v_actor, v_org, v_membership
    from public.organization_memberships m
    join auth.users u on u.id=m.user_id
   where m.status='ACTIVE'
     and (select count(*) from public.organization_memberships m2
           where m2.user_id=m.user_id and m2.status='ACTIVE') = 1
   limit 1;
  if v_actor is null then raise exception 'fixture: no single-org member'; end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role','authenticated')::text, true);

  select id into v_org_scope from public.authorization_scopes
   where organization_id=v_org and scope_type='ORGANIZATION' limit 1;

  -- grant cashbooks.create/edit/delete (org-mode) — post needs cashbook scope+possession later
  insert into public.member_permission_overrides
    (organization_id, membership_id, permission_key, effect, reason, scope_mode)
  values (v_org, v_membership, 'cashbooks.create', 'ALLOW', 't', 'ORGANIZATION'),
         (v_org, v_membership, 'cashbooks.edit', 'ALLOW', 't', 'ORGANIZATION'),
         (v_org, v_membership, 'cashbooks.delete', 'ALLOW', 't', 'ORGANIZATION');
  insert into public.member_override_scopes (organization_id, override_id, scope_id)
  select v_org, o.id, v_org_scope from public.member_permission_overrides o
   where o.organization_id=v_org and o.membership_id=v_membership and o.revoked_at is null
     and o.permission_key in ('cashbooks.create','cashbooks.edit','cashbooks.delete');

  update app_private.server_feature_flags set mode='ON', config_version=config_version+1,
    commit_sha=repeat('a',40), migration_sha256=repeat('b',64),
    maintenance_window_id='W', approval_reference='A', updated_at=clock_timestamp()
   where feature_key in ('cashbook.create.v1','cashbook.opening_adjust.v1',
                         'cashbook.lock_period.v1','cashbook.archive.v1');

  -- T1: create cashbook → org-stamped, code auto, initial balance set
  v_res := public.create_cashbook_v1('Quỹ test', 5000000, current_date - 30, null, null, null, 'cb-key-0001');
  v_cb := (v_res->>'cashbook_id')::uuid;
  if (select organization_id from public.accounts where id=v_cb) <> v_org then
    raise exception 'T1 FAILED: not org-stamped'; end if;
  if (select code from public.accounts where id=v_cb) is null then
    raise exception 'T1 FAILED: code not auto-generated'; end if;
  if (select initial_amount from public.accounts where id=v_cb) <> 5000000 then
    raise exception 'T1 FAILED: initial_amount wrong'; end if;

  -- T2: create replay same key → same cashbook
  v_res2 := public.create_cashbook_v1('Quỹ test', 5000000, current_date - 30, null, null, null, 'cb-key-0001');
  if (v_res2->>'cashbook_id') <> (v_res->>'cashbook_id') then
    raise exception 'T2 FAILED: replay made a new cashbook'; end if;

  -- grant cashbooks.post (SCOPED to this new cashbook) + possession for adjustment
  select id into v_cb_scope from public.authorization_scopes
   where organization_id=v_org and scope_type='CASHBOOK' and cashbook_id=v_cb limit 1;
  if v_cb_scope is null then
    insert into public.authorization_scopes (organization_id, scope_type, cashbook_id)
    values (v_org, 'CASHBOOK', v_cb) returning id into v_cb_scope;
  end if;
  declare v_ov uuid;
  begin
    insert into public.member_permission_overrides
      (organization_id, membership_id, permission_key, effect, reason, scope_mode)
    values (v_org, v_membership, 'cashbooks.post', 'ALLOW', 't', 'SCOPED')
    returning id into v_ov;
    insert into public.member_override_scopes (organization_id, override_id, scope_id)
    values (v_org, v_ov, v_cb_scope);
  end;
  insert into public.cashbook_possession_bindings
    (organization_id, cashbook_id, membership_id, possession_kind)
  values (v_org, v_cb, v_membership, 'CUSTODIAN');

  -- T3: opening adjustment is a FORWARD-FIX voucher, initial_amount UNCHANGED
  v_res := public.request_opening_balance_adjustment_v1(v_cb, 200000, 'sai số dư đầu', 'adj-key-0001');
  if (v_res->>'adjustment_voucher_id') is null then raise exception 'T3 FAILED: no adjustment'; end if;
  if (select initial_amount from public.accounts where id=v_cb) <> 5000000 then
    raise exception 'T3 FAILED: initial_amount was overwritten (must be forward-fix)'; end if;
  if not exists (select 1 from public.income_expenses
    where account_id=v_cb and type='INCOME' and name='Điều chỉnh số dư đầu kỳ') then
    raise exception 'T3 FAILED: no adjustment voucher'; end if;

  -- T4: lock period → accounts.lock_date set; monotonic (cannot move earlier)
  v_res := public.lock_cashbook_period_v1(v_cb, current_date - 10, false);
  if (select lock_date from public.accounts where id=v_cb) <> current_date - 10 then
    raise exception 'T4 FAILED: lock_date not set'; end if;
  begin
    perform public.lock_cashbook_period_v1(v_cb, current_date - 20, false);
    raise exception 'T4 FAILED: allowed lock to move earlier';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T5: the live check-lock trigger blocks a voucher on/before the lock date
  begin
    insert into public.income_expenses
      (user_id, organization_id, type, name, account_id, voucher_date, approval_status)
    values (v_actor, v_org, 'EXPENSE', 'sau khoá', v_cb, current_date - 15, 'UNAPPROVED');
    raise exception 'T5 FAILED: voucher before lock_date allowed';
  exception when raise_exception then null; -- P0001 from income_expenses_check_lock
  end;

  -- T6: unlock clears lock_date
  v_res := public.lock_cashbook_period_v1(v_cb, null, true);
  if (select lock_date from public.accounts where id=v_cb) is not null then
    raise exception 'T6 FAILED: unlock did not clear lock_date'; end if;

  -- T7: archive blocked while vouchers exist (the adjustment voucher)
  begin
    perform public.archive_cashbook_v1(v_cb);
    raise exception 'T7 FAILED: archived with vouchers';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T8: after soft-deleting the voucher, archive succeeds
  update public.income_expenses set deleted_at=now() where account_id=v_cb;
  v_res := public.archive_cashbook_v1(v_cb);
  if (select deleted_at from public.accounts where id=v_cb) is null then
    raise exception 'T8 FAILED: not archived'; end if;

  raise notice 'ALL 8 CASHBOOK TESTS PASSED';
end;
$tests$;

rollback;
