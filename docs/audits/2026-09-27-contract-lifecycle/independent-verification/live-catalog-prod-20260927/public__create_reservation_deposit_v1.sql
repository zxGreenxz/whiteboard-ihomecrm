-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.create_reservation_deposit_v1(p_room_id uuid, p_amount numeric, p_idempotency_key text) md5(prosrc)=cac5ff6dd42792de7b1b24d21e1b3c63
CREATE OR REPLACE FUNCTION public.create_reservation_deposit_v1(p_room_id uuid, p_amount numeric, p_idempotency_key text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_org uuid; v_building uuid;
  v_authz boolean; v_key text; v_hash text;
  v_op app_private.canonical_write_operations%rowtype; v_route text;
  v_hold uuid; v_resp json;
  c_op constant text := 'deposit.hold.v1';
begin
  if v_actor is null then raise exception 'Chưa đăng nhập' using errcode='42501'; end if;
  v_key := btrim(coalesce(p_idempotency_key,''));
  if v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' then
    raise exception 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'; end if;
  if p_amount is null or p_amount <= 0 or round(p_amount,2) <> p_amount then
    raise exception 'Số tiền cọc không hợp lệ'; end if;

  -- room → building → org; lock the room FOR NO KEY UPDATE (avoid the reconcile
  -- lock-upgrade deadlock).
  select r.building_id into v_building from public.rooms r
   where r.id=p_room_id and r.deleted_at is null for no key update;
  if not found then raise exception 'Không tìm thấy phòng' using errcode='42501'; end if;
  select b.organization_id into v_org from public.buildings b
    join public.organizations o on o.id=b.organization_id and o.status='ACTIVE'
   where b.id=v_building and b.deleted_at is null for share of o,b;
  if v_org is null then raise exception 'Toà nhà không thuộc tổ chức đang hoạt động' using errcode='42501'; end if;

  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'deposits.create', v_building, null);
  if not coalesce(v_authz,false) then
    raise exception 'Không có quyền đặt cọc giữ chỗ (deposits.create)' using errcode='42501'; end if;

  v_hash := md5(jsonb_build_object('room',p_room_id,'org',v_org,'amount',p_amount)::text);
  insert into app_private.canonical_write_operations
    (organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash)
  values (v_org, c_op, p_room_id::text, v_actor, v_key, v_hash)
  on conflict (organization_id, operation, subject_scope, actor_id, idempotency_key) do nothing;
  select * into v_op from app_private.canonical_write_operations o
   where o.organization_id=v_org and o.operation=c_op and o.subject_scope=p_room_id::text
     and o.actor_id=v_actor and o.idempotency_key=v_key for update;
  if v_op.payload_hash <> v_hash then raise exception 'idempotency_key đã dùng với nội dung khác' using errcode='23505'; end if;
  if v_op.completed_at is not null then return v_op.response_payload::json; end if;

  v_route := app_private.evaluate_feature_route(c_op, v_org);
  if v_route <> 'CANONICAL' then raise exception 'Writer cọc giữ chỗ chưa bật' using errcode='55000'; end if;

  -- the exclusion constraint enforces no-double-hold; a concurrent live hold on
  -- the same room raises 23P01 (exclusion_violation) → surface as "đã có cọc giữ".
  begin
    insert into public.room_reservation_holds
      (organization_id, building_id, room_id, amount, held_by, expires_at)
    values (v_org, v_building, p_room_id, p_amount, v_actor,
            clock_timestamp() + interval '24 hours')
    returning id into v_hold;
  exception when exclusion_violation then
    raise exception 'Phòng đang có cọc giữ chỗ còn hiệu lực' using errcode='55000';
  end;

  v_resp := json_build_object('hold_id', v_hold, 'room_id', p_room_id,
    'expires_at', (clock_timestamp() + interval '24 hours'));
  update app_private.canonical_write_operations
     set subject_id=v_hold, response_payload=to_jsonb(v_resp), completed_at=now()
   where organization_id=v_org and operation=c_op and subject_scope=p_room_id::text
     and actor_id=v_actor and idempotency_key=v_key;
  return v_resp;
end;
$function$

