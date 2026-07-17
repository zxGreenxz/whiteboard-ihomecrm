-- ============================================================================
-- T5 PREPARED TEST 94 — contract + 24h deposit-hold (harness). ROLLBACK at end.
-- ============================================================================

begin;

do $tests$
declare
  v_org uuid; v_actor uuid; v_membership uuid;
  v_building uuid; v_room uuid; v_room2 uuid; v_customer uuid;
  v_org_scope uuid; v_ov1 uuid; v_ov2 uuid;
  v_res json; v_res2 json; v_hold uuid; v_contract uuid;
begin
  -- fixture: an AVAILABLE-ish room with a building in an org, plus a customer
  select r.organization_id, r.building_id, r.id
    into v_org, v_building, v_room
    from public.rooms r
    join public.buildings b on b.id=r.building_id and b.deleted_at is null
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where r.deleted_at is null and r.organization_id is not null
     and not exists (select 1 from public.contracts c
       where c.room_id=r.id and c.deleted_at is null and c.status='ACTIVE')
   limit 1;
  if v_room is null then raise exception 'fixture: no free room'; end if;
  select r.id into v_room2 from public.rooms r
   where r.organization_id=v_org and r.building_id=v_building and r.id<>v_room and r.deleted_at is null limit 1;
  select m.user_id, m.id into v_actor, v_membership
    from public.organization_memberships m join auth.users u on u.id=m.user_id
   where m.organization_id=v_org and m.status='ACTIVE' limit 1;
  select id into v_customer from public.customers
   where organization_id=v_org or organization_id is null limit 1;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role','authenticated')::text, true);

  select id into v_org_scope from public.authorization_scopes
   where organization_id=v_org and scope_type='ORGANIZATION' limit 1;
  insert into public.member_permission_overrides
    (organization_id, membership_id, permission_key, effect, reason, scope_mode)
  values (v_org, v_membership, 'contracts.create', 'ALLOW', 't', 'ORGANIZATION'),
         (v_org, v_membership, 'deposits.create', 'ALLOW', 't', 'ORGANIZATION'),
         (v_org, v_membership, 'invoices.create', 'ALLOW', 't', 'ORGANIZATION');
  insert into public.member_override_scopes (organization_id, override_id, scope_id)
  select v_org, o.id, v_org_scope from public.member_permission_overrides o
   where o.organization_id=v_org and o.membership_id=v_membership and o.revoked_at is null
     and o.permission_key in ('contracts.create','deposits.create','invoices.create');

  update app_private.server_feature_flags set mode='ON', config_version=config_version+1,
    commit_sha=repeat('a',40), migration_sha256=repeat('b',64),
    maintenance_window_id='W', approval_reference='A', updated_at=clock_timestamp()
   where feature_key in ('contract.create.v1','deposit.hold.v1','invoice.create.v1');

  -- T1: 24h deposit hold → creates a hold with expires_at ~24h ahead
  v_res := public.create_reservation_deposit_v1(v_room, 2000000, 'dep-key-0001');
  v_hold := (v_res->>'hold_id')::uuid;
  if v_hold is null then raise exception 'T1 FAILED: no hold'; end if;
  if (select expires_at from public.room_reservation_holds where id=v_hold)
     <= clock_timestamp() + interval '23 hours' then
    raise exception 'T1 FAILED: hold not ~24h'; end if;

  -- T2: NO double-hold — a second live hold on the same room is rejected
  begin
    perform public.create_reservation_deposit_v1(v_room, 1000000, 'dep-key-0002');
    raise exception 'T2 FAILED: double-hold allowed';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T3: hold replay same key → same hold
  v_res2 := public.create_reservation_deposit_v1(v_room, 2000000, 'dep-key-0001');
  if (v_res2->>'hold_id') <> (v_res->>'hold_id') then
    raise exception 'T3 FAILED: replay made a new hold'; end if;

  -- T4: a DIFFERENT room can be held independently
  if v_room2 is not null then
    v_res := public.create_reservation_deposit_v1(v_room2, 500000, 'dep-key-0003');
    if (v_res->>'hold_id') is null then raise exception 'T4 FAILED: independent room hold'; end if;
  end if;

  -- T5: create contract → consumes the hold, sets room OCCUPIED, org-stamped
  v_res := public.create_contract_v1(
    v_room, array[v_customer], current_date, current_date, current_date + 365,
    3000000, 2000000, '[]'::jsonb, null, 'con-key-0001');
  v_contract := (v_res->>'contract_id')::uuid;
  if v_contract is null then raise exception 'T5 FAILED: no contract'; end if;
  if (select status from public.rooms where id=v_room) <> 'OCCUPIED' then
    raise exception 'T5 FAILED: room not OCCUPIED'; end if;
  if (select status from public.room_reservation_holds where id=v_hold) <> 'APPROVED' then
    raise exception 'T5 FAILED: hold not consumed'; end if;
  if (select organization_id from public.contracts where id=v_contract) <> v_org then
    raise exception 'T5 FAILED: contract not org-stamped'; end if;
  if not exists (select 1 from public.contract_customers where contract_id=v_contract and customer_id=v_customer) then
    raise exception 'T5 FAILED: customer not linked'; end if;

  -- T6: second ACTIVE contract on the same room rejected
  begin
    perform public.create_contract_v1(
      v_room, array[v_customer], current_date, current_date, current_date + 365,
      3000000, 0, '[]'::jsonb, null, 'con-key-0002');
    raise exception 'T6 FAILED: second active contract on room';
  exception when object_not_in_prerequisite_state then null;
  end;

  -- T7: contract replay same key → same contract
  v_res2 := public.create_contract_v1(
    v_room, array[v_customer], current_date, current_date, current_date + 365,
    3000000, 2000000, '[]'::jsonb, null, 'con-key-0001');
  if (v_res2->>'contract_id') <> (v_res->>'contract_id') then
    raise exception 'T7 FAILED: replay made a new contract'; end if;

  -- T8: a principal without contracts.create is denied — and the writer
  -- authorizes BEFORE it inspects room state, so denial is insufficient_privilege
  -- (42501), never a room-occupancy leak (55000). Use a stranger identity so the
  -- assertion is deterministic regardless of the fixture actor's role grants or
  -- v_room's occupancy (override-revocation precedence is covered by t2_90).
  perform set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role','authenticated')::text, true);
  begin
    perform public.create_contract_v1(
      v_room, array[v_customer], current_date, current_date, current_date + 365,
      1000000, 0, '[]'::jsonb, null, 'con-key-0003');
    raise exception 'T8 FAILED: created without contracts.create';
  exception when insufficient_privilege then null;
  end;

  raise notice 'ALL 8 CONTRACT/DEPOSIT TESTS PASSED';
end;
$tests$;

rollback;
