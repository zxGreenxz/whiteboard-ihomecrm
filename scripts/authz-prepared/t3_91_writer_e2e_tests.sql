-- ============================================================================
-- T3 PREPARED TEST 91 — end-to-end: create_income_expense_v1 (re-owned, claim
-- integrated) creates a draft, claims the marker atomically, replays
-- immutably, and the created row is frozen.
-- Disposable harness only. ROLLBACK at the end.
-- ============================================================================

begin;

do $tests$
declare
  v_org uuid;
  v_actor uuid;
  v_membership uuid;
  v_building uuid;
  v_type uuid;
  v_row public.income_expenses;
  v_row2 public.income_expenses;
  v_items jsonb;
  v_key text := 'e2e-writer-claim-0001';
  v_cnt int;
begin
  -- actor must exist in auth.users (writer resolves display name from it)
  select m.organization_id, m.user_id, m.id
    into v_org, v_actor, v_membership
    from public.organization_memberships m
    join auth.users u on u.id = m.user_id
    join public.staff_assignments sa on sa.staff_id = m.user_id
   where m.status = 'ACTIVE'
   limit 1;
  if v_actor is null then
    select m.organization_id, m.user_id, m.id
      into v_org, v_actor, v_membership
      from public.organization_memberships m
      join auth.users u on u.id = m.user_id
     where m.status = 'ACTIVE' limit 1;
  end if;
  select b.id into v_building from public.buildings b
    join public.organizations o on o.id = b.organization_id and o.status = 'ACTIVE'
   where b.organization_id = v_org and b.deleted_at is null limit 1;
  -- type must be org-matched, EXPENSE-direction, live, non-deposit/commission
  select t.id into v_type from public.income_expense_types t
   where t.organization_id = v_org
     and lower(coalesce(t.type, 'expense')) = 'expense'
     and coalesce(t.is_deposit, false) = false
     and public.nrm_vn(t.name) not in ('hoa hong moi gioi','thuong nong sale')
   limit 1;
  if v_type is null then
    raise exception 'fixture: no eligible EXPENSE type in org %', v_org;
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);

  -- Rollout: flip the harness flag to ON with full release identity so the
  -- strict evaluator admits the operation (identity-checked path).
  update app_private.server_feature_flags
     set mode = 'ON',
         config_version = config_version + 1,
         commit_sha = repeat('a', 40),
         migration_sha256 = repeat('b', 64),
         maintenance_window_id = 'HARNESS-WINDOW',
         approval_reference = 'HARNESS-E2E',
         updated_at = clock_timestamp()
   where feature_key = 'income_expense.create_draft.v1';
  if not found then
    raise exception 'feature flag row missing on harness';
  end if;

  v_items := jsonb_build_array(jsonb_build_object(
    'income_expense_type_id', v_type,
    'description', 'e2e claim item',
    'quantity', 1,
    'unit_price', 250000,
    'start_date', to_char(current_date, 'YYYY-MM-DD'),
    'end_date', to_char(current_date, 'YYYY-MM-DD')));

  -- T1: create succeeds and returns the final row
  select * into v_row from public.create_income_expense_v1(
    'EXPENSE', 'E2E claim test voucher', v_building,
    null, null, null, null, null, null, null,
    '[]'::jsonb, null, 'e2e note', current_date, v_items, v_key);
  if v_row.id is null then raise exception 'T1 FAILED: no row returned'; end if;
  if v_row.approval_status <> 'UNAPPROVED' then
    raise exception 'T1 FAILED: status %', v_row.approval_status;
  end if;

  -- T2: marker exists (claim ran in-transaction)
  if not app_private.is_income_expense_flow_owned(v_row.id) then
    raise exception 'T2 FAILED: marker missing after create';
  end if;
  select count(*) into v_cnt
    from app_private.income_expense_flow_ownership_events
   where income_expense_id = v_row.id and event_type = 'FLOW_CLAIMED';
  if v_cnt <> 1 then raise exception 'T2 FAILED: % claim events', v_cnt; end if;

  -- T3: ledger completed exactly once
  select count(*) into v_cnt from app_private.canonical_write_operations
   where organization_id = v_org
     and idempotency_key = v_key and completed_at is not null;
  if v_cnt <> 1 then raise exception 'T3 FAILED: % completed ops', v_cnt; end if;

  -- T4: replay same key + same payload returns the original row, no new voucher
  select * into v_row2 from public.create_income_expense_v1(
    'EXPENSE', 'E2E claim test voucher', v_building,
    null, null, null, null, null, null, null,
    '[]'::jsonb, null, 'e2e note', current_date, v_items, v_key);
  if v_row2.id is distinct from v_row.id then
    raise exception 'T4 FAILED: replay created a second voucher';
  end if;
  select count(*) into v_cnt from public.income_expenses
   where name = 'E2E claim test voucher';
  if v_cnt <> 1 then raise exception 'T4 FAILED: % vouchers', v_cnt; end if;

  -- T5: same key + different payload → conflict (23505)
  begin
    perform public.create_income_expense_v1(
      'EXPENSE', 'DIFFERENT NAME', v_building,
      null, null, null, null, null, null, null,
      '[]'::jsonb, null, 'e2e note', current_date, v_items, v_key);
    raise exception 'T5 FAILED: different payload accepted';
  exception when unique_violation then null;
  end;

  -- T6: created row is frozen against direct mutation
  begin
    update public.income_expenses set name = 'hack' where id = v_row.id;
    raise exception 'T6 FAILED: canonical row mutable';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T7: items of the created row are frozen
  begin
    delete from public.income_expense_items where income_expense_id = v_row.id;
    raise exception 'T7 FAILED: canonical items mutable';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T8: direct call as a non-writer role is denied (ACL)
  set local role authenticated;
  begin
    perform public.create_income_expense_v1(
      'EXPENSE', 'ACL probe', v_building,
      null, null, null, null, null, null, null,
      '[]'::jsonb, null, null, current_date, v_items, 'acl-probe-1');
    raise exception 'T8 FAILED: authenticated could call revoked writer';
  exception when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'ALL 8 WRITER E2E TESTS PASSED';
end;
$tests$;

rollback;
