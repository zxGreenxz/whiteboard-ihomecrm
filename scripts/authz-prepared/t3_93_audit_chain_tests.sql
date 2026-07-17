-- ============================================================================
-- T3 PREPARED TEST 93 — audit chain behavior (disposable harness only).
-- ROLLBACK at the end.
-- ============================================================================

begin;

do $tests$
declare
  v_org uuid;
  v_actor uuid;
  v_voucher uuid;
  v_e1 uuid;
  v_e2 uuid;
  v_verify record;
begin
  select m.organization_id, m.user_id into v_org, v_actor
    from public.organization_memberships m
    join auth.users u on u.id = m.user_id
   where m.status = 'ACTIVE' limit 1;
  select id into v_voucher from public.income_expenses
   where organization_id = v_org limit 1;

  -- T1: append two events; chain links correctly
  v_e1 := app_private.append_income_expense_event_v1(
    v_org, v_voucher, 'NOTE', v_actor, 'Tester', null, null, 'event 1');
  v_e2 := app_private.append_income_expense_event_v1(
    v_org, v_voucher, 'NOTE', v_actor, 'Tester', null, null, 'event 2');
  if (select count(*) from public.income_expense_audit_log
       where id in (v_e1, v_e2) and event_hash is not null) <> 2 then
    raise exception 'T1 FAILED: chained rows missing';
  end if;
  if (select prev_event_hash from public.income_expense_audit_log where id = v_e2)
     <> (select event_hash from public.income_expense_audit_log where id = v_e1) then
    raise exception 'T1 FAILED: chain link broken';
  end if;

  -- T2: verifier passes
  select * into v_verify
    from app_private.verify_income_expense_audit_chain_v1(v_org);
  if not v_verify.valid or v_verify.checked_events < 2 then
    raise exception 'T2 FAILED: verify % events=%', v_verify.valid, v_verify.checked_events;
  end if;

  -- T3: direct INSERT without hash rejected (writer monopoly)
  begin
    insert into public.income_expense_audit_log
      (income_expense_id, action, actor_id, actor_name, organization_id)
    values (v_voucher, 'FORGED', v_actor, 'Forger', v_org);
    raise exception 'T3 FAILED: unchained insert allowed';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T4: UPDATE/DELETE rejected (append-only)
  begin
    update public.income_expense_audit_log set note = 'tamper' where id = v_e1;
    raise exception 'T4 FAILED: audit update allowed';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    delete from public.income_expense_audit_log where id = v_e1;
    raise exception 'T4 FAILED: audit delete allowed';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T5: legacy client RPC routes through the chain with action allowlist
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);
  perform public.log_income_expense_action(v_voucher, 'NOTE', 'client note');
  if (select count(*) from public.income_expense_audit_log
       where income_expense_id = v_voucher and note = 'client note'
         and event_hash is not null) <> 1 then
    raise exception 'T5 FAILED: RPC did not chain';
  end if;
  begin
    perform public.log_income_expense_action(v_voucher, 'POSTED', 'forge lifecycle');
    raise exception 'T5 FAILED: lifecycle forge allowed';
  exception when insufficient_privilege then null;
  end;

  -- T6: subject hard-delete leaves audit intact (FK dropped)
  declare v_tmp uuid;
  begin
    insert into public.income_expenses
      (organization_id, user_id, type, name, building_id,
       approval_status, voucher_date, total_amount)
    values (v_org, v_actor, 'EXPENSE', 'audit-retention probe',
            (select id from public.buildings where organization_id = v_org limit 1),
            'UNAPPROVED', current_date, 0)
    returning id into v_tmp;
    perform app_private.append_income_expense_event_v1(
      v_org, v_tmp, 'NOTE', v_actor, 'Tester', null, null, 'pre-delete');
    delete from public.income_expenses where id = v_tmp;
    if (select count(*) from public.income_expense_audit_log
         where income_expense_id = v_tmp) <> 1 then
      raise exception 'T6 FAILED: audit vanished with subject';
    end if;
  end;

  raise notice 'ALL 6 AUDIT CHAIN TESTS PASSED';
end;
$tests$;

rollback;
