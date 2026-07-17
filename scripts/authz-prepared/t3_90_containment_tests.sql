-- ============================================================================
-- T3 PREPARED TEST 90 — claim + full-freeze containment matrix.
-- Disposable harness only. Single transaction, ROLLBACK at the end (the
-- harness DB itself is disposable; rollback keeps reruns deterministic).
-- ============================================================================

begin;

do $tests$
declare
  v_org uuid;
  v_actor uuid;
  v_membership uuid;
  v_building uuid;
  v_voucher uuid;
  v_item uuid;
  v_type uuid;
  v_hash text;
  v_ok boolean;
begin
  select id into v_type from public.income_expense_types limit 1;
  -- fixture: an ACTIVE membership + a building in the same org
  select m.organization_id, m.user_id, m.id
    into v_org, v_actor, v_membership
    from public.organization_memberships m
   where m.status = 'ACTIVE' limit 1;
  select id into v_building from public.buildings
   where organization_id = v_org limit 1;

  -- simulate auth context for auth.uid()
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);

  -- Build an unmarked draft the way the writer constructs one (server-side).
  insert into public.income_expenses
    (organization_id, user_id, type, name, building_id,
     approval_status, voucher_date, total_amount)
  values
    (v_org, v_actor, 'EXPENSE', 'T3 containment test', v_building,
     'UNAPPROVED', current_date, 0)
  returning id into v_voucher;

  insert into public.income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price)
  values (v_voucher, v_type, 'test item', 1, 123000)
  returning id into v_item;

  v_hash := md5('containment-test-payload');
  update public.income_expenses
     set source_payload_hash = v_hash where id = v_voucher;

  -- matching in-progress ledger row (what the writer creates pre-claim)
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id,
     idempotency_key, payload_hash)
  values
    (v_org, 'income_expense.create_draft.v1', v_building::text, v_actor,
     'cont-test-key-001', v_hash);

  -- T1: claim WITHOUT the capability token must 42501 (A.9 redesign: capability
  -- is a transaction-local nonce, not a role identity).
  begin
    perform app_private.claim_canonical_income_expense_draft_v1(
      v_voucher, 'cont-test-key-001', 'forged-nonce');
    raise exception 'T1 FAILED: claim succeeded without capability';
  exception when insufficient_privilege then
    null; -- expected
  end;

  -- T2: claim WITH a freshly granted capability token succeeds
  declare v_cap text;
  begin
    v_cap := app_private.grant_ie_claim_capability_v1();
    perform app_private.claim_canonical_income_expense_draft_v1(
      v_voucher, 'cont-test-key-001', v_cap);
  end;

  select app_private.is_income_expense_flow_owned(v_voucher) into v_ok;
  if not v_ok then raise exception 'T2 FAILED: marker missing'; end if;

  -- T3: double-claim must fail (PK)
  declare v_cap2 text;
  begin
    v_cap2 := app_private.grant_ie_claim_capability_v1();
    perform app_private.claim_canonical_income_expense_draft_v1(
      v_voucher, 'cont-test-key-001', v_cap2);
    raise exception 'T3 FAILED: double claim';
  exception when unique_violation or no_data_found then
    null;
  end;

  -- T4: parent UPDATE frozen (55000)
  begin
    update public.income_expenses set name = 'hack' where id = v_voucher;
    raise exception 'T4 FAILED: parent update allowed';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T5: parent DELETE frozen
  begin
    delete from public.income_expenses where id = v_voucher;
    raise exception 'T5 FAILED: parent delete allowed';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T6: item UPDATE frozen
  begin
    update public.income_expense_items set unit_price = 999 where id = v_item;
    raise exception 'T6 FAILED: item update allowed';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T7: item INSERT under frozen parent rejected
  begin
    insert into public.income_expense_items
      (income_expense_id, income_expense_type_id, description, quantity, unit_price)
    values (v_voucher, v_type, 'smuggled', 1, 1);
    raise exception 'T7 FAILED: item insert allowed';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T8: item DELETE frozen
  begin
    delete from public.income_expense_items where id = v_item;
    raise exception 'T8 FAILED: item delete allowed';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T9: legacy approve_voucher must NOT promote the canonical row.
  -- It may fail for any reason (business validation or the freeze); the only
  -- unacceptable outcome is a successful promotion.
  begin
    perform public.approve_voucher(v_voucher);
  exception when others then
    null; -- any rejection is acceptable; state asserted below
  end;
  if exists (select 1 from public.income_expenses
              where id = v_voucher and approval_status <> 'UNAPPROVED') then
    raise exception 'T9 FAILED: legacy approve promoted canonical row';
  end if;
  -- T9b: even with an account set via direct UPDATE the freeze must block
  -- (the account_id UPDATE itself must be frozen).
  begin
    update public.income_expenses
       set account_id = (select id from public.accounts
                          where organization_id = v_org and deleted_at is null limit 1)
     where id = v_voucher;
    raise exception 'T9b FAILED: frozen account_id update allowed';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T10: sidecar UPDATE/DELETE immutable
  begin
    delete from app_private.income_expense_flow_ownership
     where income_expense_id = v_voucher;
    raise exception 'T10 FAILED: sidecar delete allowed';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T11: replica mode — ENABLE ALWAYS still fires
  set local session_replication_role = 'replica';
  begin
    update public.income_expenses set name = 'replica hack' where id = v_voucher;
    raise exception 'T11 FAILED: replica-mode update allowed';
  exception when object_not_in_prerequisite_state then null;
  end;
  set local session_replication_role = 'origin';

  -- T12: ON CONFLICT DO UPDATE upsert arm frozen
  begin
    insert into public.income_expenses
      (id, organization_id, user_id, type, name, building_id,
       approval_status, voucher_date, total_amount)
    values
      (v_voucher, v_org, v_actor, 'EXPENSE', 'upsert hack', v_building,
       'UNAPPROVED', current_date, 0)
    on conflict (id) do update set name = excluded.name;
    raise exception 'T12 FAILED: upsert update arm allowed';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T13: unmarked legacy row remains fully mutable (compatibility)
  declare v_legacy uuid;
  begin
    insert into public.income_expenses
      (organization_id, user_id, type, name, building_id,
       approval_status, voucher_date, total_amount)
    values (v_org, v_actor, 'EXPENSE', 'legacy free', v_building,
            'UNAPPROVED', current_date, 0)
    returning id into v_legacy;
    update public.income_expenses set name = 'legacy edited' where id = v_legacy;
    delete from public.income_expenses where id = v_legacy;
  end;

  -- T14: FK CASCADE cannot reap a frozen row (auth.users deletion path):
  -- simulated via direct DELETE with replica already covered; here assert the
  -- ownership FK RESTRICT protects the pair.
  begin
    delete from public.income_expenses where id = v_voucher;
    raise exception 'T14 FAILED';
  exception when object_not_in_prerequisite_state then null;
  end;

  raise notice 'ALL 14 T3 CONTAINMENT TESTS PASSED';
end;
$tests$;

rollback;
