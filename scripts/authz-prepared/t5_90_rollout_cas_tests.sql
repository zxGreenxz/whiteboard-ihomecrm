-- ============================================================================
-- T5 PREPARED TEST 90 — rollout CAS + ledger immutability (harness only).
-- ROLLBACK at the end.
-- ============================================================================

begin;

do $tests$
declare
  v_key text := 'income_expense.create_draft.v1';
  v_ver bigint;
  v_new bigint;
  v_actor uuid := gen_random_uuid();
begin
  select config_version into v_ver from app_private.server_feature_flags
   where feature_key = v_key;

  -- T1: stale config_version → 40001
  begin
    perform app_private.set_feature_route_v1(
      v_key, v_ver + 99, 'SHADOW', null, null, 0, 0, 0,
      null, null, null, null, v_actor, 'stale');
    raise exception 'T1 FAILED: stale CAS accepted';
  exception when serialization_failure then null;
  end;

  -- T2: ON without release identity → 22023
  begin
    perform app_private.set_feature_route_v1(
      v_key, v_ver, 'ON', null, null, 0, 0, 0,
      null, null, null, null, v_actor, 'no-id');
    raise exception 'T2 FAILED: ON without identity accepted';
  exception when invalid_parameter_value then null;
  end;

  -- T3: CANARY without finite window → 22023
  begin
    perform app_private.set_feature_route_v1(
      v_key, v_ver, 'CANARY', null, null, 10, 1000, 100000,
      repeat('a',40), repeat('b',64), 'W', 'A', v_actor, 'no-window');
    raise exception 'T3 FAILED: CANARY without window accepted';
  exception when invalid_parameter_value then null;
  end;

  -- T4: valid ON bumps config_version and emits an event
  v_new := app_private.set_feature_route_v1(
    v_key, v_ver, 'ON', null, null, 0, 0, 0,
    repeat('a',40), repeat('b',64), 'WINDOW-1', 'APPROVAL-1', v_actor, 'go');
  if v_new <> v_ver + 1 then raise exception 'T4 FAILED: version not bumped'; end if;
  if (select config_version from app_private.server_feature_flags where feature_key=v_key) <> v_new then
    raise exception 'T4 FAILED: flag not updated';
  end if;
  if (select count(*) from app_private.server_feature_flag_events
       where feature_key=v_key and after_version=v_new) <> 1 then
    raise exception 'T4 FAILED: no event emitted';
  end if;

  -- T5: second CAS with the OLD version now fails (monotonic)
  begin
    perform app_private.set_feature_route_v1(
      v_key, v_ver, 'OFF', null, null, 0, 0, 0,
      null, null, null, null, v_actor, 'reuse');
    raise exception 'T5 FAILED: reused old version';
  exception when serialization_failure then null;
  end;

  -- T6: event ledger is append-only
  begin
    update app_private.server_feature_flag_events set after_mode='HACK'
     where feature_key=v_key;
    raise exception 'T6 FAILED: event mutable';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T7: cap ledger rejects negative amount
  begin
    insert into app_private.server_feature_flag_operations
      (feature_key, config_version, operation_key, organization_id, amount_vnd)
    values (v_key, v_new, 'neg-op', gen_random_uuid(), -1);
    raise exception 'T7 FAILED: negative cap amount accepted';
  exception when check_violation then null;
  end;

  -- T8: cap ledger is append-only
  insert into app_private.server_feature_flag_operations
    (feature_key, config_version, operation_key, organization_id, amount_vnd)
  values (v_key, v_new, 'op-1', gen_random_uuid(), 1000);
  begin
    delete from app_private.server_feature_flag_operations where operation_key='op-1';
    raise exception 'T8 FAILED: cap ledger deletable';
  exception when object_not_in_prerequisite_state then null;
  end;

  raise notice 'ALL 8 ROLLOUT CAS TESTS PASSED';
end;
$tests$;

rollback;
