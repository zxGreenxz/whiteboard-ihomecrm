-- Hermes: tách cổng báo cọc Sale khỏi khoá Thu chi income_expenses.create (review chéo PR #349, phương án b).
-- crm_sale_reservation_create / crm_sale_reservation_topup ghi phiếu THU cọc một bước: không bản xem trước, không confirmToken, bộ
-- ghi CRM có thể tự duyệt lúc sinh. Từ khi bật Sale (20261022121254, cố ý không bật income_expenses.*) hai thao tác này chỉ đóng
-- vì income_expenses.create TẮT; migration bật trang Thu chi (20261027234414, PR #349) bật khoá đó nên sẽ mở luôn chúng.
-- File này:
--   1. thay public.hermes_sale_actions_v1 bằng đúng thân 20261021064112 cộng MỘT điều kiện: reservation_create / reservation_topup
--      (cả lượt đối soát status của chúng) đòi thêm khoá riêng deposits.create_receipt có mặt và bật trong registry, chính sách công ty và
--      khoá của kết nối, NGOÀI deposits.create + income_expenses.create (+ overlay duyệt) như cũ. Chỉ siết, không nới;
--   2. seed deposits.create_receipt ở trạng thái TẮT (dòng có sẵn giữ nguyên, kể cả khi đã bật; khoá TẮT không vào phép chiếu kết nối nào).
-- Connector cùng đợt (sale-action-contract.mjs) đòi cùng khoá; chưa lớp quyền nào cấp khoá đó nên hai tool vẫn ẩn.
-- Thứ tự phát hành: file này + connector có SALE_DEPOSIT_RECEIPT_KEY lên TRƯỚC 20261027234414 (tên file muộn hơn nhưng phải ÁP trước;
-- provenance catalog-proven vì hàm đã có ⇒ áp đích danh).
-- $requires$ ghim md5 thân đang chạy (bỏ CR): thân 20261021064112 hoặc thân của chính file này (chạy lại được); thân khác ⇒ dừng,
-- không ghi đè bản vá của PR khác. Không DROP, không đổi chữ ký / kiểu trả về / quyền EXECUTE (CREATE OR REPLACE giữ ACL), không ghi
-- bảng nghiệp vụ. Lùi: chạy lại định nghĩa hàm vỏ Sale của 20261021064112 CHỈ khi income_expenses.create còn TẮT (file Thu chi chưa áp
-- hoặc đã lùi) — nếu không, lùi là mở lại hai tool báo cọc; dòng khoá TẮT để lại, vô hại.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE body_md5 text;
BEGIN
  IF to_regclass('app_private.hermes_capabilities') IS NULL
    OR to_regclass('app_private.hermes_connections') IS NULL
    OR to_regclass('app_private.hermes_sale_action_receipts') IS NULL
    OR to_regprocedure('app_private.hermes_effective_org_policy_v1(uuid,text[],text[],uuid[])') IS NULL
    OR to_regprocedure('app_private.hermes_sale_buildings_v1(app_private.hermes_connections,text)') IS NULL THEN
    RAISE EXCEPTION 'hermes_sale_deposit_key_dependencies_missing';
  END IF;
  SELECT md5(replace(p.prosrc,chr(13),'')) INTO body_md5 FROM pg_proc p
    WHERE p.oid=to_regprocedure('public.hermes_sale_actions_v1(jsonb,text,jsonb)') AND p.prosecdef AND p.provolatile='v';
  -- 664ef0889be1fd6bdac6e1226d1d887b = thân 20261021064112 (production 22/10); c0167b3e3b81d1074522bd990ca41611 = thân dưới đây.
  IF body_md5 IS NULL OR body_md5 NOT IN ('664ef0889be1fd6bdac6e1226d1d887b','c0167b3e3b81d1074522bd990ca41611') THEN
    RAISE EXCEPTION 'hermes_sale_deposit_key_body_unexpected: %',COALESCE(body_md5,'missing');
  END IF;
  IF EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='deposits.create_receipt' AND mode<>'action') THEN
    RAISE EXCEPTION 'hermes_sale_deposit_key_mode_conflict';
  END IF;
END
$requires$;

CREATE OR REPLACE FUNCTION public.hermes_sale_actions_v1(p_binding jsonb,p_operation text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections;candidate app_private.hermes_connections;r app_private.hermes_sale_action_receipts;
 v_room uuid;v_building uuid;v_request uuid;v_target uuid;v_op text:=p_operation;v_input jsonb:=p_input;v_ids uuid[]:='{}';
 k text;v_result jsonb;v_raw jsonb;v_receipt jsonb;v_fields jsonb;v_payload jsonb;v_limit int;v_cursor uuid;v_rows jsonb;v_revision bigint;
 v_edit boolean;v_images boolean;v_any boolean:=false;
BEGIN
 IF p_operation IS NULL OR p_operation NOT IN ('options','observe','patch','lock','release','reservation_create',
  'reservation_update','reservation_topup','reservation_assign','status') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
 IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
 -- A nonlocking owner lookup only selects the room to lock. It grants nothing.
 -- Canonical sale writers lock room before org, so do the same before full
 -- binding admission (which locks org and connection/session/policy).
 SELECT * INTO candidate FROM app_private.hermes_connections
  WHERE id=app_private.hermes_uuid_v1(p_binding->'connectionId') AND user_id=auth.uid();
 IF NOT FOUND THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
 IF p_operation IN ('patch','lock','reservation_create','observe') THEN v_room:=app_private.hermes_uuid_v1(p_input->'roomId');
 ELSIF p_operation='release' THEN
  v_target:=app_private.hermes_uuid_v1(p_input->'lockId');
  SELECT room_id INTO v_room FROM public.room_sale_locks WHERE id=v_target AND organization_id=candidate.organization_id;
 ELSIF p_operation IN ('reservation_update','reservation_topup','reservation_assign') THEN
  v_target:=app_private.hermes_uuid_v1(p_input->'reservationId');
  SELECT room_id INTO v_room FROM public.room_reservations WHERE id=v_target AND organization_id=candidate.organization_id;
 END IF;
 IF p_operation NOT IN ('options','status') THEN
  IF p_operation='observe' THEN
   SELECT building_id INTO v_building FROM public.rooms WHERE id=v_room AND organization_id=candidate.organization_id AND deleted_at IS NULL;
  ELSE
   SELECT building_id INTO v_building FROM public.rooms WHERE id=v_room AND organization_id=candidate.organization_id AND deleted_at IS NULL FOR NO KEY UPDATE;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
 END IF;
 c:=app_private.hermes_sale_binding_v1(p_binding);
 IF c.id IS DISTINCT FROM candidate.id OR c.organization_id IS DISTINCT FROM candidate.organization_id
  THEN RAISE EXCEPTION 'hermes_sale_context_changed' USING ERRCODE='PT409'; END IF;
 IF p_operation NOT IN ('options','observe') THEN
  v_request:=app_private.hermes_uuid_v1(p_input->'requestId');
  SELECT * INTO r FROM app_private.hermes_sale_action_receipts WHERE organization_id=c.organization_id AND user_id=c.user_id AND request_id=v_request FOR UPDATE;
  IF FOUND THEN
   IF r.connection_id IS DISTINCT FROM c.id THEN RAISE EXCEPTION 'hermes_sale_context_changed' USING ERRCODE='PT409'; END IF;
   IF p_operation='status' THEN v_op:=r.operation;v_input:=r.input;v_room:=r.room_id;v_building:=r.building_id;
   ELSIF r.operation IS DISTINCT FROM p_operation OR r.input IS DISTINCT FROM p_input OR r.room_id IS DISTINCT FROM v_room OR r.building_id IS DISTINCT FROM v_building
    THEN RAISE EXCEPTION 'hermes_sale_intent_changed' USING ERRCODE='PT409'; END IF;
  END IF;
 END IF;
 FOREACH k IN ARRAY app_private.hermes_sale_keys_v1(v_op,v_input) LOOP
  v_ids:=v_ids||app_private.hermes_sale_buildings_v1(c,k);
 END LOOP;
 IF cardinality(v_ids)=0 OR v_building IS NOT NULL AND NOT(v_building=ANY(v_ids)) THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
 IF v_op IN ('reservation_create','reservation_topup') THEN
  IF NOT(v_building=ANY(app_private.hermes_sale_buildings_v1(c,'income_expenses.create'))) THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
  -- A one-step money receipt (no preview, no confirm token) also needs its own
  -- Hermes key in the registry, company policy and this connection, so the Thu
  -- chi page key income_expenses.create alone never opens these two operations.
  PERFORM 1 FROM app_private.hermes_capabilities WHERE capability='deposits.create_receipt' AND mode='action' AND enabled FOR SHARE;
  IF NOT FOUND OR NOT('deposits.create_receipt'=ANY(c.action_capabilities)) OR NOT EXISTS(SELECT 1 FROM app_private.hermes_effective_org_policy_v1(
   c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids) policy WHERE policy.enabled AND 'deposits.create_receipt'=ANY(policy.action_capabilities))
   THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
  -- The CRM maker may auto-approve at birth; that effect requires the same
  -- explicit approve capability AND building scope in the Hermes overlay.
  IF app_private.can_v3('income_expenses.approve',v_building) AND
   NOT(v_building=ANY(app_private.hermes_sale_buildings_v1(c,'income_expenses.approve')))
   THEN RAISE EXCEPTION 'hermes_sale_approval_overlay_required' USING ERRCODE='42501'; END IF;
 END IF;
 -- The canonical quick writer returns the exact patch object. Early Hermes
 -- receipts stored that object where the public contract requires field names.
 -- Normalize only a receipt proven to match its saved intent, after live auth.
 IF r.operation='patch' AND jsonb_typeof(r.result#>'{receipt,fields}')='object' THEN
  IF r.result#>'{receipt,fields}' IS DISTINCT FROM r.input-ARRAY['requestId','roomId','expectedRevision']
   THEN RAISE EXCEPTION 'hermes_sale_receipt_invalid' USING ERRCODE='PT409'; END IF;
  SELECT jsonb_agg(field_key ORDER BY field_key) INTO v_rows FROM jsonb_object_keys(r.result#>'{receipt,fields}') fields(field_key);
  r.result:=jsonb_set(r.result,'{receipt,fields}',v_rows);
 END IF;
 IF p_operation='status' THEN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['requestId']);
  PERFORM app_private.hermes_sale_binding_v1(p_binding);
  RETURN COALESCE(r.result,jsonb_build_object('organizationId',c.organization_id,'requestId',v_request,'operation',NULL,
   'outcome',CASE WHEN r.request_id IS NULL THEN 'not_found' ELSE 'unknown' END,'receipt',NULL));
 END IF;
 IF r.request_id IS NOT NULL THEN
  IF r.result IS NULL THEN RAISE EXCEPTION 'hermes_sale_outcome_unknown' USING ERRCODE='PT409'; END IF;
  PERFORM app_private.hermes_sale_binding_v1(p_binding);RETURN r.result;
 END IF;
 IF p_operation='options' THEN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['action','buildingId','query','limit','cursor']);
  IF p_input->>'action' NOT IN ('rooms.edit','sale_phong.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit')
   OR jsonb_typeof(p_input->'query') IS DISTINCT FROM 'string' OR char_length(p_input->>'query')>100
   THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
  v_limit:=app_private.hermes_integer_v1(p_input->'limit');
  IF v_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
  IF p_input->'buildingId'<>'null'::jsonb THEN
   v_building:=app_private.hermes_uuid_v1(p_input->'buildingId');
   IF NOT(v_building=ANY(v_ids)) THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
  END IF;
  IF p_input->'cursor'<>'null'::jsonb THEN v_cursor:=app_private.hermes_uuid_v1(p_input->'cursor'); END IF;
  SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO v_rows FROM (
   SELECT room.id,jsonb_build_object('id',room.id,'buildingId',b.id,'label',app_private.hermes_domain_text_v1(COALESCE(room.name,'')),
    'buildingLabel',app_private.hermes_domain_text_v1(COALESCE(b.name,''))) item
   FROM public.rooms room JOIN public.buildings b ON b.id=room.building_id AND b.organization_id=room.organization_id
   WHERE room.organization_id=c.organization_id AND room.deleted_at IS NULL AND b.deleted_at IS NULL AND b.id=ANY(v_ids)
    AND (v_building IS NULL OR b.id=v_building) AND (v_cursor IS NULL OR room.id>v_cursor)
    AND strpos(lower(COALESCE(room.name,'')||' '||COALESCE(room.code,'')||' '||COALESCE(b.name,'')),lower(btrim(p_input->>'query')))>0
   ORDER BY room.id LIMIT v_limit+1) selected;
  v_result:=jsonb_build_object('organizationId',c.organization_id,'items',v_rows,'nextCursor',NULL);
  IF jsonb_array_length(v_rows)>v_limit THEN
   SELECT jsonb_agg(value ORDER BY ordinality) INTO v_rows FROM jsonb_array_elements(v_rows) WITH ORDINALITY WHERE ordinality<=v_limit;
   v_result:=v_result||jsonb_build_object('items',v_rows,'nextCursor',v_rows->(v_limit-1)->'id');
  END IF;
  PERFORM app_private.hermes_sale_binding_v1(p_binding);RETURN v_result;
 END IF;
 IF p_operation='observe' THEN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['roomId']);
  v_edit:=v_building=ANY(app_private.hermes_sale_buildings_v1(c,'rooms.edit')||app_private.hermes_sale_buildings_v1(c,'sale_phong.edit'));
  v_images:=v_building=ANY(app_private.hermes_sale_buildings_v1(c,'sale_phong.manage_images'));
  IF NOT(v_edit OR v_images) THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
  v_raw:=public.get_sale_room_inventory_v1(c.organization_id,v_building,v_room);
  SELECT value INTO v_payload FROM jsonb_array_elements(v_raw->'rooms') WHERE value->>'id'=v_room::text AND value->>'building_id'=v_building::text;
  IF v_payload IS NULL OR (v_payload->>'revision') !~ '^[a-f0-9]{32}$' THEN RAISE EXCEPTION 'hermes_sale_context_changed' USING ERRCODE='PT409'; END IF;
  SELECT COALESCE(jsonb_object_agg(key,value),'{}') INTO v_fields FROM jsonb_each(v_payload) WHERE
   key='images' OR v_edit AND key IN ('rent_price','area','room_type','amenities','sale_note','sale_bonus_note','description');
  PERFORM app_private.hermes_sale_binding_v1(p_binding);
  RETURN jsonb_build_object('organizationId',c.organization_id,'room',jsonb_build_object('id',v_room,'buildingId',v_building,
   'revision',v_payload->'revision','updatedAt',v_payload->'updated_at','fields',v_fields));
 END IF;
 INSERT INTO app_private.hermes_sale_action_receipts(organization_id,user_id,request_id,connection_id,operation,room_id,building_id,input)
  VALUES(c.organization_id,c.user_id,v_request,c.id,p_operation,v_room,v_building,p_input);
 IF p_operation='patch' THEN
  v_fields:=p_input-ARRAY['requestId','roomId','expectedRevision'];
  IF COALESCE(p_input->>'expectedRevision','') !~ '^[a-f0-9]{32}$' OR v_fields='{}' OR EXISTS(
   SELECT 1 FROM jsonb_object_keys(v_fields) fields(field_key) WHERE fields.field_key NOT IN ('rent_price','area','room_type','amenities','sale_note','sale_bonus_note','images','description'))
   THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
  v_raw:=public.update_room_sale_info_v1(c.organization_id,v_room,p_input->>'expectedRevision',v_request,v_fields);
  IF v_raw->>'room_id' IS DISTINCT FROM v_room::text OR v_raw->>'building_id' IS DISTINCT FROM v_building::text OR
   v_raw->>'request_id' IS DISTINCT FROM v_request::text OR (v_raw->>'revision') !~ '^[a-f0-9]{32}$'
   OR v_raw->'fields' IS DISTINCT FROM v_fields
   THEN RAISE EXCEPTION 'hermes_sale_receipt_invalid' USING ERRCODE='PT409'; END IF;
  SELECT jsonb_agg(field_key ORDER BY field_key) INTO v_rows FROM jsonb_object_keys(v_fields) fields(field_key);
  v_receipt:=jsonb_build_object('id',v_room,'roomId',v_room,'buildingId',v_building,'revision',v_raw->'revision','state','UPDATED',
   'receivedAmount',NULL,'receipts','[]'::jsonb,'expiresAt',NULL,'fields',v_rows);
 ELSIF p_operation='lock' THEN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['requestId','roomId','hours','note']);
  IF p_input->'hours' NOT IN ('6'::jsonb,'12'::jsonb,'24'::jsonb) OR
   p_input->'note'<>'null'::jsonb AND (jsonb_typeof(p_input->'note') IS DISTINCT FROM 'string' OR char_length(p_input->>'note')>300)
   THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
  v_raw:=public.lock_room_for_sale_v1(c.organization_id,v_room,(p_input->>'hours')::int,p_input->>'note');
 ELSIF p_operation='release' THEN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['requestId','lockId']);
  v_raw:=public.release_room_sale_lock_v1(c.organization_id,v_target);
 ELSIF p_operation='reservation_create' THEN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['requestId','roomId','customerId','customerHint','intendedMoveInOn','topupDueOn','depositTarget','notes','receipt']);
  IF p_input->'customerId'<>'null'::jsonb THEN PERFORM app_private.hermes_uuid_v1(p_input->'customerId'); END IF;
  IF (p_input->'customerId'='null'::jsonb)=(p_input->'customerHint'='null'::jsonb) THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
  v_payload:=jsonb_build_object('room_id',v_room,'customer_id',p_input->'customerId','customer_hint',p_input->'customerHint',
   'hold_until',NULL,'intended_move_in_on',p_input->'intendedMoveInOn','topup_due_on',p_input->'topupDueOn','deposit_target',p_input->'depositTarget',
   'notes',p_input->'notes','existing_voucher_ids','[]'::jsonb,'receipt',app_private.hermes_sale_receipt_input_v1(p_input->'receipt'));
  v_raw:=public.create_room_reservation_v1(c.organization_id,'hermes-sale:'||v_request::text,v_payload);
 ELSE
  v_revision:=app_private.hermes_integer_v1(p_input->'expectedRevision');
  IF p_operation='reservation_assign' THEN
   PERFORM app_private.hermes_request_v1(p_input,ARRAY['requestId','reservationId','expectedRevision','customerId']);
   v_raw:=public.assign_room_reservation_customer_v1(c.organization_id,v_target,v_revision,app_private.hermes_uuid_v1(p_input->'customerId'),'hermes-sale:'||v_request::text);
  ELSE
   PERFORM app_private.hermes_request_v1(p_input,CASE WHEN p_operation='reservation_topup'
    THEN ARRAY['requestId','reservationId','expectedRevision','receipt'] ELSE ARRAY['requestId','reservationId','expectedRevision','changes'] END);
   IF p_operation='reservation_topup' THEN v_payload:=app_private.hermes_sale_receipt_input_v1(p_input->'receipt');v_fields:='{}';
   ELSE
    v_fields:=p_input->'changes';
    IF jsonb_typeof(v_fields) IS DISTINCT FROM 'object' OR v_fields='{}' OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_fields) fields(field_key)
     WHERE fields.field_key NOT IN ('hold_until','intended_move_in_on','topup_due_on','deposit_target','notes')) THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
   END IF;
   v_raw:=public.update_room_reservation_v1(c.organization_id,v_target,v_revision,'hermes-sale:'||v_request::text,
    CASE WHEN p_operation='reservation_topup' THEN 'TOPUP' ELSE 'UPDATE' END,v_fields,v_payload);
  END IF;
 END IF;
 IF p_operation IN ('lock','release') THEN
  IF v_raw->>'organization_id' IS DISTINCT FROM c.organization_id::text OR v_raw->>'building_id' IS DISTINCT FROM v_building::text OR
   v_raw->>'room_id' IS DISTINCT FROM v_room::text THEN RAISE EXCEPTION 'hermes_sale_receipt_invalid' USING ERRCODE='PT409'; END IF;
  v_receipt:=jsonb_build_object('id',v_raw->'id','roomId',v_room,'buildingId',v_building,'revision',NULL,
   'state',CASE WHEN v_raw->'active'='true'::jsonb THEN 'LOCKED' ELSE 'RELEASED' END,'receivedAmount',NULL,'receipts','[]'::jsonb,'expiresAt',v_raw->'expires_at','fields','[]'::jsonb);
 ELSIF p_operation LIKE 'reservation_%' THEN
  IF v_raw->>'organization_id' IS DISTINCT FROM c.organization_id::text OR v_raw->>'building_id' IS DISTINCT FROM v_building::text OR
   v_raw->>'room_id' IS DISTINCT FROM v_room::text THEN RAISE EXCEPTION 'hermes_sale_receipt_invalid' USING ERRCODE='PT409'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('voucherId',value->'source_voucher_id','amount',value->'amount',
   'received',value->'received','approvalStatus',value->'approval_status')),'[]') INTO v_rows FROM jsonb_array_elements(v_raw->'receipts');
  v_receipt:=jsonb_build_object('id',v_raw->'id','roomId',v_room,'buildingId',v_building,'revision',v_raw->'revision',
   'state',v_raw->'status','receivedAmount',v_raw->'received_amount','receipts',v_rows,'expiresAt',NULL,'fields','[]'::jsonb);
 END IF;
 PERFORM app_private.hermes_sale_binding_v1(p_binding);
 -- Re-evaluate current scope after canonical writer hooks, before storing ACK.
 v_any:=false;FOREACH k IN ARRAY app_private.hermes_sale_keys_v1(p_operation,p_input) LOOP
  v_any:=v_any OR v_building=ANY(app_private.hermes_sale_buildings_v1(c,k));END LOOP;
 IF NOT v_any THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
 v_result:=jsonb_build_object('organizationId',c.organization_id,'requestId',v_request,'operation',p_operation,'outcome','applied','receipt',v_receipt);
 UPDATE app_private.hermes_sale_action_receipts SET result=v_result WHERE organization_id=c.organization_id AND user_id=c.user_id AND request_id=v_request;
 PERFORM app_private.append_authz_audit_v1(c.organization_id,'HERMES_SALE_ACTION','room',v_room,NULL,
  jsonb_build_object('connectionId',c.id,'requestId',v_request,'operation',p_operation),'Hermes bounded sale action');
 RETURN v_result;
END $fn$;

DO $seed$
BEGIN
  -- Chỉ chèn khi chưa có: chạy lại không bắn trigger chiếu lại kết nối, không tắt khoá đã bật.
  IF NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='deposits.create_receipt') THEN
    INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES('deposits.create_receipt','action',false);
  END IF;
END
$seed$;

DO $check$
BEGIN
  IF (SELECT count(*) FROM app_private.hermes_capabilities WHERE capability='deposits.create_receipt' AND mode='action')<>1
    OR (SELECT md5(replace(prosrc,chr(13),'')) FROM pg_proc WHERE oid='public.hermes_sale_actions_v1(jsonb,text,jsonb)'::regprocedure)<>'c0167b3e3b81d1074522bd990ca41611' THEN
    RAISE EXCEPTION 'hermes_sale_deposit_key_incomplete';
  END IF;
END
$check$;
COMMIT;
NOTIFY pgrst,'reload schema';
