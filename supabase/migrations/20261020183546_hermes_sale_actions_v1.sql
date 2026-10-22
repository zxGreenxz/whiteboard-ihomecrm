-- Hermes Sale actions: caller JWT, live authority and scope, canonical CRM
-- writers, one durable receipt per user/request. Registry starts disabled.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
INSERT INTO app_private.hermes_capabilities(capability,mode,enabled) VALUES
 ('rooms.edit','action',false),('sale_phong.manage_images','action',false),
 ('sale_phong.lock_room','action',false),('deposits.create','action',false),('deposits.edit','action',false)
ON CONFLICT(capability) DO NOTHING;
CREATE TABLE IF NOT EXISTS app_private.hermes_sale_action_receipts(
 organization_id uuid NOT NULL REFERENCES public.organizations(id),
 user_id uuid NOT NULL REFERENCES auth.users(id),request_id uuid NOT NULL,
 connection_id uuid NOT NULL REFERENCES app_private.hermes_connections(id),
 operation text NOT NULL,room_id uuid NOT NULL,building_id uuid NOT NULL,
 input jsonb NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,user_id,request_id)
);
ALTER TABLE app_private.hermes_sale_action_receipts OWNER TO postgres;
ALTER TABLE app_private.hermes_sale_action_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app_private.hermes_sale_action_receipts FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

CREATE OR REPLACE FUNCTION app_private.hermes_sale_binding_v1(p_binding jsonb)
RETURNS app_private.hermes_connections LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections;s app_private.hermes_sessions;policy app_private.hermes_org_policies;
 member jsonb;context jsonb;k text;
BEGIN
 PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion',
  'expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
 IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
 PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId');PERFORM app_private.hermes_uuid_v1(p_binding->'expectedMembershipId');
 FOREACH k IN ARRAY ARRAY['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
  IF app_private.hermes_integer_v1(p_binding->k)<1 THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF p_binding->'expectedPolicyVersion' IS DISTINCT FROM '0'::jsonb THEN PERFORM app_private.hermes_integer_v1(p_binding->'expectedPolicyVersion'); END IF;
 c:=app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
 SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
 IF c.user_id IS DISTINCT FROM auth.uid() OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
  OR NOT app_private.hermes_session_gate_v1(s) OR app_private.is_actor_offboarded_v1()
  THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
 member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
 policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
 IF c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch'
  OR s.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision' OR policy.version::text IS DISTINCT FROM p_binding->>'expectedPolicyVersion'
  OR member->>'membershipId' IS DISTINCT FROM p_binding->>'expectedMembershipId'
  OR member->>'authorizationVersion' IS DISTINCT FROM p_binding->>'expectedAuthorizationVersion'
  THEN RAISE EXCEPTION 'hermes_sale_context_changed' USING ERRCODE='PT409'; END IF;
 context:=public.get_authorization_context_v1(c.organization_id);
 IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
  OR context->>'organizationId' IS DISTINCT FROM c.organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
  THEN RAISE EXCEPTION 'hermes_sale_context_changed' USING ERRCODE='PT409'; END IF;
 RETURN c;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_sale_buildings_v1(c app_private.hermes_connections,p_key text)
RETURNS uuid[] LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE policy app_private.hermes_org_policies;context jsonb;ids uuid[];
BEGIN
 policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
 context:=public.get_authorization_context_v1(c.organization_id);
 PERFORM 1 FROM app_private.hermes_capabilities WHERE capability=p_key AND mode='action' AND enabled FOR SHARE;
 IF NOT FOUND OR NOT policy.enabled OR context->'permissions'->p_key IS DISTINCT FROM 'true'::jsonb
  OR NOT(p_key=ANY(c.action_capabilities)) OR NOT(p_key=ANY(policy.action_capabilities)) THEN RETURN '{}'::uuid[]; END IF;
 SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO ids FROM public.buildings b
  CROSS JOIN app_private.authorized_scope_v3(p_key,c.organization_id) scope
  WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL
   AND (COALESCE(scope.org_wide,false) OR b.id=ANY(COALESCE(scope.building_ids,'{}'::uuid[])))
   AND EXISTS(SELECT 1 FROM public.authorization_scopes overlay WHERE overlay.organization_id=c.organization_id
    AND overlay.id=ANY(c.scope_ids) AND overlay.id=ANY(policy.scope_ids) AND overlay.cashbook_id IS NULL AND
    (overlay.scope_type='ORGANIZATION' OR overlay.scope_type='BUILDING' AND overlay.building_id=b.id
     OR overlay.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a ON a.id=ab.area_id
      AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
      WHERE ab.organization_id=c.organization_id AND ab.area_id=overlay.area_id AND ab.building_id=b.id)));
 IF cardinality(ids)>256 THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
 RETURN ids;
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_sale_keys_v1(p_operation text,p_input jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT CASE
 WHEN p_operation='patch' THEN CASE WHEN p_input ? 'images' AND NOT EXISTS(
  SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('requestId','roomId','expectedRevision','images'))
  THEN ARRAY['rooms.edit','sale_phong.manage_images'] ELSE ARRAY['rooms.edit'] END
 WHEN p_operation='lock' THEN ARRAY['sale_phong.lock_room']
 WHEN p_operation='release' THEN ARRAY['sale_phong.lock_room','deposits.create']
 WHEN p_operation IN ('reservation_create','reservation_topup') THEN ARRAY['deposits.create']
 WHEN p_operation IN ('reservation_update','reservation_assign') THEN ARRAY['deposits.edit']
 WHEN p_operation='options' THEN ARRAY[p_input->>'action']
 WHEN p_operation='observe' THEN ARRAY['rooms.edit','sale_phong.manage_images']
 ELSE ARRAY['rooms.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit'] END
$fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_sale_receipt_input_v1(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
 PERFORM app_private.hermes_request_v1(p_input,ARRAY['amount','accountId','voucherDate','name','description']);
 IF jsonb_typeof(p_input->'amount') IS DISTINCT FROM 'number' OR (p_input->>'amount') !~ '^[1-9][0-9]{0,12}$'
  OR (p_input->'name'<>'null'::jsonb AND (jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR char_length(p_input->>'name') NOT BETWEEN 1 AND 200))
  OR (p_input->'description'<>'null'::jsonb AND (jsonb_typeof(p_input->'description') IS DISTINCT FROM 'string' OR char_length(p_input->>'description')>1000))
  THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
 IF p_input->'accountId'<>'null'::jsonb THEN PERFORM app_private.hermes_uuid_v1(p_input->'accountId'); END IF;
 IF app_private.hermes_domain_date_v2(p_input->'voucherDate') IS NULL THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('amount',p_input->'amount','account_id',p_input->'accountId','voucher_date',p_input->'voucherDate',
  'name',p_input->'name','description',p_input->'description','attachments','[]'::jsonb);
END $fn$;

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
  -- The CRM maker may auto-approve at birth; that effect requires the same
  -- explicit approve capability AND building scope in the Hermes overlay.
  IF app_private.can_v3('income_expenses.approve',v_building) AND
   NOT(v_building=ANY(app_private.hermes_sale_buildings_v1(c,'income_expenses.approve')))
   THEN RAISE EXCEPTION 'hermes_sale_approval_overlay_required' USING ERRCODE='42501'; END IF;
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
  IF p_input->>'action' NOT IN ('rooms.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit')
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
  v_edit:=v_building=ANY(app_private.hermes_sale_buildings_v1(c,'rooms.edit'));
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
   THEN RAISE EXCEPTION 'hermes_sale_receipt_invalid' USING ERRCODE='PT409'; END IF;
  v_receipt:=jsonb_build_object('id',v_room,'roomId',v_room,'buildingId',v_building,'revision',v_raw->'revision','state','UPDATED',
   'receivedAmount',NULL,'receipts','[]'::jsonb,'expiresAt',NULL,'fields',v_raw->'fields');
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

CREATE OR REPLACE FUNCTION public.hermes_sale_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb;context jsonb;policy app_private.hermes_org_policies;enabled boolean;allowed boolean;key text;
 buildings uuid[];permissions jsonb:='{}';
BEGIN
 IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
 member:=app_private.hermes_member_v1(auth.uid(),p_organization_id);
 IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
 context:=public.get_authorization_context_v1(p_organization_id);
 IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
  OR context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
  THEN RAISE EXCEPTION 'hermes_sale_context_changed' USING ERRCODE='PT409'; END IF;
 policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,'{}'::text[],ARRAY['rooms.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit'],NULL);
 FOREACH key IN ARRAY ARRAY['rooms.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit'] LOOP
  enabled:=policy.enabled AND key=ANY(policy.action_capabilities) AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities cap WHERE cap.capability=key AND cap.mode='action' AND cap.enabled);
  allowed:=COALESCE(enabled AND context->'permissions'->key='true'::jsonb,false);
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings FROM public.buildings b
   CROSS JOIN app_private.authorized_scope_v3(key,p_organization_id) scope WHERE allowed AND b.organization_id=p_organization_id AND b.deleted_at IS NULL
    AND (COALESCE(scope.org_wide,false) OR b.id=ANY(COALESCE(scope.building_ids,'{}'::uuid[])));
  IF cardinality(buildings)>256 THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
  permissions:=permissions||jsonb_build_object(key,jsonb_build_object('allowed',allowed,'companyEnabled',COALESCE(enabled,false),'buildingIds',to_jsonb(buildings)));
 END LOOP;
 RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,'permissions',permissions);
END $fn$;

ALTER FUNCTION app_private.hermes_sale_binding_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_sale_buildings_v1(app_private.hermes_connections,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_sale_keys_v1(text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_sale_receipt_input_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_sale_binding_v1(jsonb),app_private.hermes_sale_buildings_v1(app_private.hermes_connections,text),
 app_private.hermes_sale_keys_v1(text,jsonb),app_private.hermes_sale_receipt_input_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION public.hermes_sale_actions_v1(jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_sale_capabilities_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_sale_actions_v1(jsonb,text,jsonb),public.hermes_sale_capabilities_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_sale_actions_v1(jsonb,text,jsonb),public.hermes_sale_capabilities_v1(uuid) TO authenticated;

-- v8 wraps v7: every existing read capability/projection is preserved.
CREATE OR REPLACE FUNCTION app_private.hermes_sale_extend_options_v1(p_result jsonb,p_kind text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb:=p_result;org uuid;member jsonb;caps jsonb;key text;cap jsonb;
 policy app_private.hermes_org_policies;cap_buildings uuid[];choices jsonb;combined jsonb;
 action_keys constant text[]:=ARRAY['rooms.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit'];
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN ('org_options','connection_options','context') OR jsonb_typeof(result) IS DISTINCT FROM 'object'
  OR auth.role() IS DISTINCT FROM 'authenticated' OR result->>'userId' IS DISTINCT FROM auth.uid()::text
  THEN RAISE EXCEPTION 'hermes_sale_denied' USING ERRCODE='42501'; END IF;
 org:=app_private.hermes_uuid_v1(result->'organizationId');PERFORM app_private.lock_org_for_decision_v1(org);
 member:=app_private.hermes_member_v1(auth.uid(),org);
 IF member->>'membershipId' IS DISTINCT FROM result->>'membershipId' OR member->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
  OR member->'isSuperadmin' IS DISTINCT FROM result->'isSuperadmin' THEN RAISE EXCEPTION 'hermes_sale_context_changed' USING ERRCODE='PT409'; END IF;
 IF p_kind='org_options' THEN
  FOREACH key IN ARRAY action_keys LOOP
   IF EXISTS(SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=key AND h.mode='action' AND h.enabled)
    AND NOT(result#>'{choices,action}' ? key) THEN
    result:=jsonb_set(result,'{choices,action}',(result#>'{choices,action}')||to_jsonb(key),false);
   END IF;
  END LOOP;RETURN result;
 END IF;
 caps:=public.hermes_sale_capabilities_v1(org);
 IF caps->>'membershipId' IS DISTINCT FROM result->>'membershipId' OR caps->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
  OR caps->>'policyVersion' IS DISTINCT FROM result->>'policyVersion' OR caps->'isSuperadmin' IS DISTINCT FROM result->'isSuperadmin'
  THEN RAISE EXCEPTION 'hermes_sale_context_changed' USING ERRCODE='PT409'; END IF;
 IF p_kind='connection_options' AND result->'enabled' IS DISTINCT FROM 'true'::jsonb THEN RETURN result; END IF;
 policy:=app_private.hermes_effective_org_policy_v1(org,NULL,NULL,NULL);
 FOREACH key IN ARRAY action_keys LOOP
  cap:=caps->'permissions'->key;CONTINUE WHEN cap->'allowed' IS DISTINCT FROM 'true'::jsonb;
  SELECT COALESCE(array_agg(value::uuid),'{}'::uuid[]) INTO cap_buildings FROM jsonb_array_elements_text(cap->'buildingIds');
  -- Calculate selectable scopes per capability, never use another key's union.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('scopeId',scope.id,'scopeType',scope.scope_type,
   'label',CASE scope.scope_type WHEN 'ORGANIZATION' THEN 'Toàn tổ chức' WHEN 'BUILDING' THEN 'Toà: '||COALESCE(b.name,'(chưa đặt tên)')
    WHEN 'AREA' THEN 'Khu vực: '||COALESCE(a.name,'(chưa đặt tên)') END,
   'buildingId',scope.building_id,'areaId',scope.area_id,'cashbookId',NULL) ORDER BY scope.id),'[]') INTO choices
   FROM public.authorization_scopes scope
   LEFT JOIN public.buildings b ON b.id=scope.building_id AND b.organization_id=org AND b.deleted_at IS NULL
   LEFT JOIN public.areas a ON a.id=scope.area_id AND a.organization_id=org AND a.deleted_at IS NULL
   WHERE scope.organization_id=org AND scope.id=ANY(policy.scope_ids) AND scope.cashbook_id IS NULL
    AND (p_kind<>'context' OR result->'scopeIds' ? scope.id::text) AND (
    (scope.scope_type='ORGANIZATION' AND scope.building_id IS NULL AND scope.area_id IS NULL AND cardinality(cap_buildings)>0) OR
    (scope.scope_type='BUILDING' AND b.id=ANY(cap_buildings) AND scope.area_id IS NULL) OR
    (scope.scope_type='AREA' AND a.id IS NOT NULL AND scope.building_id IS NULL AND EXISTS(SELECT 1 FROM public.area_buildings ab
      WHERE ab.organization_id=org AND ab.area_id=a.id AND ab.building_id=ANY(cap_buildings))));
  CONTINUE WHEN jsonb_array_length(choices)=0;
  IF p_kind='context' THEN
   IF result#>'{restrictions,action}' ? key AND result#>'{companyCeilings,action}' ? key AND NOT(result#>'{effective,action}' ? key)
    THEN result:=jsonb_set(result,'{effective,action}',(result#>'{effective,action}')||to_jsonb(key),false);END IF;
  ELSE
   IF NOT(result->'action' ? key) THEN result:=jsonb_set(result,'{action}',(result->'action')||to_jsonb(key),false);END IF;
   SELECT COALESCE(jsonb_agg(value ORDER BY value->>'scopeId'),'[]') INTO combined FROM (
    SELECT DISTINCT ON (value->>'scopeId') value FROM jsonb_array_elements((result->'scopes')||choices) ORDER BY value->>'scopeId') selected;
   IF jsonb_array_length(combined)>256 THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023';END IF;
   result:=jsonb_set(result,'{scopes}',combined,false);
  END IF;
 END LOOP;RETURN result;
END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_org_policy_options_v8(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_sale_extend_options_v1(public.hermes_org_policy_options_v7(p_org),'org_options');END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_connection_options_v8(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_sale_extend_options_v1(public.hermes_connection_options_v7(p_org),'connection_options');END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_connection_context_v8(p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_sale_extend_options_v1(public.hermes_connection_context_v7(p_connection_id),'context');END $fn$;
ALTER FUNCTION app_private.hermes_sale_extend_options_v1(jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_sale_extend_options_v1(jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION public.hermes_org_policy_options_v8(uuid) OWNER TO postgres;
ALTER FUNCTION public.hermes_connection_options_v8(uuid) OWNER TO postgres;
ALTER FUNCTION public.hermes_connection_context_v8(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_org_policy_options_v8(uuid),public.hermes_connection_options_v8(uuid),public.hermes_connection_context_v8(uuid)
 FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_org_policy_options_v8(uuid),public.hermes_connection_options_v8(uuid),public.hermes_connection_context_v8(uuid) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
