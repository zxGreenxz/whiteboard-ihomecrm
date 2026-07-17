-- ============================================================================
-- T3 PREPARED TEST 99 — freeze-exempt canonical transition (harness).
-- ROLLBACK at the end.
-- ============================================================================

begin;

do $tests$
declare
  v_org uuid; v_actor uuid; v_building uuid; v_type uuid;
  v_subject uuid;
  v_hash text := md5('trans-1');
begin
  select m.organization_id, m.user_id into v_org, v_actor
    from public.organization_memberships m
    join auth.users u on u.id=m.user_id
   where m.status='ACTIVE' limit 1;
  select id into v_building from public.buildings where organization_id=v_org limit 1;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role','authenticated')::text, true);

  -- make + claim a canonical draft
  insert into public.income_expenses
    (organization_id, user_id, type, name, building_id, approval_status,
     voucher_date, total_amount, source_payload_hash)
  values (v_org, v_actor, 'EXPENSE', 'transition subject', v_building,
          'UNAPPROVED', current_date, 777000, v_hash) returning id into v_subject;
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, 'income_expense.create_draft.v1', v_building::text, v_actor,
          'trans-key-1', v_hash);
  set local role ie_canonical_writer;
  perform app_private.claim_canonical_income_expense_draft_v1(v_subject, 'trans-key-1');
  reset role;

  -- T1: direct UPDATE still frozen (no token)
  begin
    update public.income_expenses set approval_status='APPROVED' where id=v_subject;
    raise exception 'T1 FAILED: direct transition allowed';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T2: authorized transition posts the row
  perform app_private.transition_canonical_income_expense_v1(
    v_subject, 'APPROVED', gen_random_uuid(), null);
  if (select approval_status from public.income_expenses where id=v_subject) <> 'APPROVED' then
    raise exception 'T2 FAILED: not APPROVED';
  end if;
  if (select posted_at_v2 from public.income_expenses where id=v_subject) is null then
    raise exception 'T2 FAILED: posted_at_v2 not set';
  end if;

  -- T3: token did not leak — a subsequent direct UPDATE is frozen again
  begin
    update public.income_expenses set approval_status='CANCELLED' where id=v_subject;
    raise exception 'T3 FAILED: token leaked';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T4: authorized transition is an ALLOWLIST — NO non-lifecycle column may
  -- change under a token. Probe several columns the old denylist missed.
  declare v_col text;
  begin
    foreach v_col in array array[
      'total_amount = 1',
      'voucher_date = ''2099-01-01''',
      'deleted_at = now()',
      'user_id = gen_random_uuid()',
      'change_amount = 500',
      'rounding_amount = 500',
      'notes = ''smuggled'''
    ] loop
      begin
        insert into app_private.ie_transition_authorization (income_expense_id, xid, purpose)
        values (v_subject, pg_current_xact_id(), 'test');
        execute format('update public.income_expenses set %s where id=%L', v_col, v_subject);
        raise exception 'T4 FAILED: allowlist let through %', v_col;
      exception when object_not_in_prerequisite_state then
        delete from app_private.ie_transition_authorization where income_expense_id=v_subject;
      end;
    end loop;
  end;

  -- T5: items remain frozen throughout (freeze on items unchanged)
  begin
    insert into public.income_expense_items
      (income_expense_id, income_expense_type_id, description, quantity, unit_price)
    values (v_subject, (select id from public.income_expense_types limit 1),
            'smuggle', 1, 1);
    raise exception 'T5 FAILED: item inserted under canonical parent';
  exception when object_not_in_prerequisite_state then null;
  end;

  raise notice 'ALL 5 CANONICAL TRANSITION TESTS PASSED';
end;
$tests$;

rollback;
