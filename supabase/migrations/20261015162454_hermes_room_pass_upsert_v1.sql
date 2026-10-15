-- Hermes tạo/sửa tin "Khách nhờ sale" (pass phòng) qua ĐÚNG writer của form
-- "Thêm phòng pass" ở /sale-phong: public.upsert_room_pass_listing chạy với JWT
-- actor thật (guard can_manage_pass_listing theo toà, owner = chủ toà, org do
-- trigger autofill_org_strict). Hermes không ghi bảng trực tiếp, không đổi hợp
-- đồng, khách thuê hay trạng thái phòng.
--
-- Ba thao tác trên một RPC caller-only:
--   lookup  — tra phòng theo toà + tên/mã phòng (kể cả phòng ĐANG CÓ KHÁCH) để
--             lấy roomId; khách đại diện chỉ có SĐT đã che; chỉ trong toà mà
--             người dùng vừa đọc được như form (chủ toà/can_access_building) vừa
--             quản lý được tin pass.
--   upsert  — sửa tin ĐANG HIỆN của phòng, không có thì tạo mới (đúng nhánh
--             p_id NULL của form "Thêm"). Trường vắng = giữ nguyên khi sửa /
--             mặc định khi tạo; null = xoá. Tạo mới mà vắng cả SĐT lẫn tên thì
--             điền khách đại diện như form tự điền.
--   status  — đối soát requestId cho cả biên nhận bật/ẩn (hermes_room_pass_action_v1)
--             lẫn upsert; không bao giờ ghi lại.
-- Quyền mỗi lượt: Action sale_phong.manage_pass_listings (registry, trần công ty,
-- overlay kết nối) ∩ quyền CRM hiện tại (context + authorize_tenant_action_v3 +
-- authorized_scope_v3 + can_manage_pass_listing) ∩ phạm vi toà của overlay.
-- Idempotency: bảng biên nhận app_private.hermes_room_pass_receipts sẵn có, cùng
-- transaction với bản ghi; audit actor/connection, không ghi SĐT vào audit.
-- Registry KHÔNG đổi ở file này (bật ở migration riêng, sau file này).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- Gấp chữ để so khớp tên toà/phòng: bỏ dấu tiếng Việt (NFD + bỏ dấu kết hợp,
-- đ→d) và viết thường. Không đọc bảng nào.
CREATE OR REPLACE FUNCTION app_private.hermes_room_pass_fold_v1(p text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT lower(translate(regexp_replace(normalize(coalesce(p,''),NFD),'[\u0300-\u036f]','','g'),'đĐ','dd'))
$fn$;

-- Quyết định theo toà dùng chung cho lookup/upsert/status: quyết định CRM hiện
-- tại của chính actor (kể cả hạn hiệu lực), tập phạm vi, guard canonical của
-- writer và overlay phạm vi đã lưu của kết nối ∩ chính sách công ty.
CREATE OR REPLACE FUNCTION app_private.hermes_room_pass_building_ok_v1(c app_private.hermes_connections,p_policy_scope_ids uuid[],
  p_authorization_version text,p_building uuid,p_owner uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE decision record; scope record;
BEGIN
 IF c.id IS NULL OR p_building IS NULL OR c.user_id IS DISTINCT FROM auth.uid() THEN RETURN false; END IF;
 SELECT * INTO decision FROM app_private.authorize_tenant_action_v3(auth.uid(),c.organization_id,'sale_phong.manage_pass_listings',p_building,NULL);
 SELECT * INTO scope FROM app_private.authorized_scope_v3('sale_phong.manage_pass_listings',c.organization_id);
 RETURN COALESCE(decision.allowed,false)
   AND decision.authorization_version::text IS NOT DISTINCT FROM p_authorization_version
   AND (decision.nearest_deadline IS NULL OR decision.nearest_deadline>clock_timestamp())
   AND (COALESCE(scope.org_wide,false) OR p_building=ANY(COALESCE(scope.building_ids,'{}'::uuid[])))
   AND COALESCE(public.can_manage_pass_listing(p_building,p_owner),false)
   AND EXISTS(SELECT 1 FROM public.authorization_scopes overlay WHERE overlay.organization_id=c.organization_id
     AND overlay.id=ANY(c.scope_ids) AND overlay.id=ANY(p_policy_scope_ids) AND (overlay.scope_type='ORGANIZATION'
       OR overlay.scope_type='BUILDING' AND overlay.building_id=p_building
       OR overlay.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
         WHERE ab.organization_id=c.organization_id AND ab.area_id=overlay.area_id AND ab.building_id=p_building)));
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_room_pass_upsert_v1(p_binding jsonb,p_operation text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; s app_private.hermes_sessions; policy app_private.hermes_org_policies;
 member jsonb; context jsonb; receipt app_private.hermes_room_pass_receipts; listing public.room_pass_listings; saved public.room_pass_listings;
 k text; v_request uuid; v_room uuid; v_building uuid; v_owner uuid; v_change text; v_result jsonb; v_rooms jsonb; v_more boolean;
 v_name text; v_phone text; v_policy text; v_price numeric; v_date date; v_has_date boolean:=false; v_manager boolean; v_active boolean;
 v_tokens text[]; v_room_query text;
BEGIN
 PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion','expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
 IF p_operation='lookup' THEN PERFORM app_private.hermes_request_v1(p_input,ARRAY['buildingName','roomCode']);
 ELSIF p_operation='status' THEN PERFORM app_private.hermes_request_v1(p_input,ARRAY['requestId']);
 ELSIF p_operation='upsert' THEN
   IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR pg_column_size(p_input)>16384 OR NOT(p_input ?& ARRAY['requestId','roomId'])
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) AS input_key(name) WHERE input_key.name<>ALL(ARRAY['requestId','roomId','customerPhone','customerName',
       'contactManager','passPrice','availDate','salePolicy','active']))
     THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
 ELSE RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
 IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
 PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId');PERFORM app_private.hermes_uuid_v1(p_binding->'expectedMembershipId');
 FOREACH k IN ARRAY ARRAY['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
   IF app_private.hermes_integer_v1(p_binding->k)<1 THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF (CASE WHEN p_binding->'expectedPolicyVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_binding->'expectedPolicyVersion') END)<0
   THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
 IF p_operation='lookup' THEN
   IF jsonb_typeof(p_input->'buildingName') IS DISTINCT FROM 'string' OR jsonb_typeof(p_input->'roomCode') IS DISTINCT FROM 'string'
     OR char_length(btrim(p_input->>'buildingName')) NOT BETWEEN 1 AND 120 OR char_length(btrim(p_input->>'roomCode')) NOT BETWEEN 1 AND 40
     OR (p_input->>'buildingName')||(p_input->>'roomCode') ~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]'
     THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
   v_tokens:=regexp_split_to_array(btrim(regexp_replace(app_private.hermes_room_pass_fold_v1(p_input->>'buildingName'),'\s+',' ','g')),' ');
   v_room_query:=btrim(regexp_replace(app_private.hermes_room_pass_fold_v1(p_input->>'roomCode'),'\s+',' ','g'));
   v_room_query:=COALESCE(NULLIF(regexp_replace(v_room_query,'^(phong|p\.?) ?(?=[0-9])',''),''),v_room_query);
   IF cardinality(v_tokens)>8 THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
 ELSE v_request:=app_private.hermes_uuid_v1(p_input->'requestId'); END IF;
 IF p_operation='upsert' THEN
   v_room:=app_private.hermes_uuid_v1(p_input->'roomId');
   IF p_input ? 'customerPhone' AND p_input->'customerPhone'<>'null'::jsonb AND (jsonb_typeof(p_input->'customerPhone')<>'string'
       OR p_input->>'customerPhone' !~ '^[0-9]{10,11}$')
     OR p_input ? 'customerName' AND p_input->'customerName'<>'null'::jsonb AND (jsonb_typeof(p_input->'customerName')<>'string'
       OR char_length(p_input->>'customerName') NOT BETWEEN 1 AND 120 OR p_input->>'customerName'<>btrim(p_input->>'customerName')
       OR p_input->>'customerName' ~ '[\x01-\x1f\x7f-\x9f\u2028\u2029]')
     OR p_input ? 'salePolicy' AND p_input->'salePolicy'<>'null'::jsonb AND (jsonb_typeof(p_input->'salePolicy')<>'string'
       OR char_length(p_input->>'salePolicy') NOT BETWEEN 1 AND 2000 OR p_input->>'salePolicy'<>btrim(p_input->>'salePolicy')
       OR p_input->>'salePolicy' ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029]')
     OR p_input ? 'passPrice' AND p_input->'passPrice'<>'null'::jsonb AND (jsonb_typeof(p_input->'passPrice')<>'number'
       OR CASE WHEN p_input->>'passPrice' ~ '^[1-9][0-9]{0,9}$' THEN (p_input->>'passPrice')::bigint>1000000000 ELSE true END)
     OR p_input ? 'availDate' AND p_input->'availDate'<>'null'::jsonb AND (jsonb_typeof(p_input->'availDate')<>'string'
       OR p_input->>'availDate' !~ '^(20[0-9]{2}|2100)-[0-9]{2}-[0-9]{2}$')
     OR p_input ? 'contactManager' AND jsonb_typeof(p_input->'contactManager') IS DISTINCT FROM 'boolean'
     OR p_input ? 'active' AND jsonb_typeof(p_input->'active') IS DISTINCT FROM 'boolean'
     THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
   IF p_input ? 'availDate' THEN
     v_has_date:=true;
     IF p_input->'availDate'<>'null'::jsonb THEN
       BEGIN v_date:=(p_input->>'availDate')::date;
       EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END;
       IF to_char(v_date,'YYYY-MM-DD') IS DISTINCT FROM p_input->>'availDate' THEN RAISE EXCEPTION 'hermes_action_invalid' USING ERRCODE='22023'; END IF;
     END IF;
   END IF;
 END IF;
 c:=app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
 SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
 IF c.user_id IS DISTINCT FROM auth.uid() OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
   OR NOT app_private.hermes_session_gate_v1(s) THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
 member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
 policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
 IF c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch'
   OR s.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision' OR policy.version::text IS DISTINCT FROM p_binding->>'expectedPolicyVersion'
   OR member->>'membershipId' IS DISTINCT FROM p_binding->>'expectedMembershipId' OR member->>'authorizationVersion' IS DISTINCT FROM p_binding->>'expectedAuthorizationVersion'
   THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
 context:=public.get_authorization_context_v1(c.organization_id);
 IF context->>'membershipId' IS DISTINCT FROM member->>'membershipId' OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
   OR context->>'organizationId' IS DISTINCT FROM c.organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
   THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
 IF context#>'{permissions,sale_phong.manage_pass_listings}' IS DISTINCT FROM 'true'::jsonb
   OR NOT('sale_phong.manage_pass_listings'=ANY(c.action_capabilities)) OR NOT('sale_phong.manage_pass_listings'=ANY(policy.action_capabilities))
   OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='sale_phong.manage_pass_listings' AND mode='action' AND enabled)
   THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;

 IF p_operation='lookup' THEN
   WITH cand AS MATERIALIZED (
     SELECT r.id,r.name,r.code,r.status::text AS status,b.id AS building_id,b.name AS building_name,b.user_id AS owner_id,
       (regexp_replace(btrim(app_private.hermes_room_pass_fold_v1(r.name)),'^(phong|p\.?) ?(?=[0-9])','')=v_room_query
         OR regexp_replace(btrim(app_private.hermes_room_pass_fold_v1(r.code)),'^(phong|p\.?) ?(?=[0-9])','')=v_room_query) AS exact
     FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id
     WHERE r.organization_id=c.organization_id AND b.organization_id=c.organization_id AND r.deleted_at IS NULL AND b.deleted_at IS NULL
       AND NOT COALESCE(b.is_virtual,false) AND (b.user_id=auth.uid() OR public.can_access_building(b.id))
       AND NOT EXISTS(SELECT 1 FROM unnest(v_tokens) AS tok(word) WHERE strpos(app_private.hermes_room_pass_fold_v1(concat_ws(' ',b.name,b.code,b.street_address)),tok.word)=0)
       AND strpos(app_private.hermes_room_pass_fold_v1(concat_ws(' ',r.name,r.code)),v_room_query)>0
     ORDER BY 8 DESC,b.name,r.name,r.id LIMIT 200
   ), allowed_building AS MATERIALIZED (
     SELECT d.building_id FROM (SELECT DISTINCT cand.building_id,cand.owner_id FROM cand) d
     WHERE app_private.hermes_room_pass_building_ok_v1(c,policy.scope_ids,member->>'authorizationVersion',d.building_id,d.owner_id)
   ), allowed AS MATERIALIZED (
     SELECT cand.* FROM cand JOIN allowed_building USING(building_id)
   ), picked AS MATERIALIZED (
     SELECT a.*,row_number() OVER (ORDER BY a.exact DESC,a.building_name,a.name,a.id) AS rn FROM allowed a
     WHERE a.exact OR NOT EXISTS(SELECT 1 FROM allowed e WHERE e.exact)
   )
   SELECT COALESCE(jsonb_agg(jsonb_build_object('roomId',p.id,'roomName',app_private.hermes_domain_text_v1(p.name),
       'roomCode',app_private.hermes_domain_text_v1(p.code),'roomStatus',p.status,'buildingId',p.building_id,
       'buildingName',app_private.hermes_domain_text_v1(p.building_name),
       'hasActiveContract',EXISTS(SELECT 1 FROM public.contracts ct WHERE ct.room_id=p.id AND ct.deleted_at IS NULL AND ct.status IN ('ACTIVE','EXTENDED')),
       'representative',(SELECT jsonb_build_object('name',app_private.hermes_domain_text_v1(cu.full_name),
           'phoneMasked',CASE WHEN cu.phone IS NULL THEN NULL ELSE '***'||right(regexp_replace(cu.phone,'[^0-9]','','g'),4) END)
         FROM public.contracts ct JOIN public.contract_customers cc ON cc.contract_id=ct.id
         JOIN public.customers cu ON cu.id=cc.customer_id AND cu.deleted_at IS NULL
         WHERE ct.room_id=p.id AND ct.deleted_at IS NULL AND ct.status IN ('ACTIVE','EXTENDED')
         ORDER BY COALESCE(cc.is_representative,false) DESC,cu.full_name,cu.id LIMIT 1),
       'passListing',(SELECT jsonb_build_object('listingId',l.id,'active',l.active,'passPrice',l.pass_price,'availDate',l.avail_date)
         FROM public.room_pass_listings l WHERE l.room_id=p.id AND l.organization_id=c.organization_id
         ORDER BY l.active DESC,l.updated_at DESC,l.id LIMIT 1)) ORDER BY p.rn) FILTER (WHERE p.rn<=10),'[]'::jsonb),
     COALESCE(max(p.rn)>10,false)
   INTO v_rooms,v_more FROM picked p;
   PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
   RETURN jsonb_build_object('organizationId',c.organization_id,'rooms',v_rooms,'truncated',v_more);
 END IF;

 IF p_operation='status' THEN
   SELECT * INTO receipt FROM app_private.hermes_room_pass_receipts r WHERE r.connection_id=c.id AND r.request_id=v_request
     AND r.organization_id=c.organization_id AND r.user_id=c.user_id;
   IF NOT FOUND THEN
     PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
     RETURN jsonb_build_object('requestId',v_request,'outcome','not_found','listing',NULL);
   END IF;
   IF jsonb_typeof(receipt.result->'listing') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'hermes_action_receipt_invalid' USING ERRCODE='PT409'; END IF;
   v_building:=app_private.hermes_uuid_v1(receipt.result#>'{listing,buildingId}');
   SELECT b.user_id INTO v_owner FROM public.buildings b WHERE b.id=v_building AND b.organization_id=c.organization_id AND b.deleted_at IS NULL FOR SHARE;
   IF NOT FOUND OR NOT app_private.hermes_room_pass_building_ok_v1(c,policy.scope_ids,member->>'authorizationVersion',v_building,v_owner)
     THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
   PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
   RETURN receipt.result;
 END IF;

 -- upsert: phòng/toà của chính công ty, khoá chống xoá đồng thời rồi mới quyết.
 SELECT r.building_id INTO v_building FROM public.rooms r WHERE r.id=v_room AND r.organization_id=c.organization_id AND r.deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
 SELECT b.user_id INTO v_owner FROM public.buildings b WHERE b.id=v_building AND b.organization_id=c.organization_id AND b.deleted_at IS NULL
   AND NOT COALESCE(b.is_virtual,false) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.rooms r WHERE r.id=v_room AND r.building_id=v_building AND r.organization_id=c.organization_id AND r.deleted_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
 IF NOT app_private.hermes_room_pass_building_ok_v1(c,policy.scope_ids,member->>'authorizationVersion',v_building,v_owner)
   THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
 PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
 INSERT INTO app_private.hermes_room_pass_receipts(connection_id,request_id,organization_id,user_id,input)
   VALUES(c.id,v_request,c.organization_id,c.user_id,p_input) ON CONFLICT DO NOTHING;
 SELECT * INTO receipt FROM app_private.hermes_room_pass_receipts r WHERE r.connection_id=c.id AND r.request_id=v_request FOR UPDATE;
 IF receipt.organization_id IS DISTINCT FROM c.organization_id OR receipt.user_id IS DISTINCT FROM c.user_id
   OR receipt.input IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'hermes_action_intent_changed' USING ERRCODE='PT409'; END IF;
 IF receipt.result IS NOT NULL THEN RETURN receipt.result; END IF;
 -- Tin đang hiện của phòng (index duy nhất room_id WHERE active ⇒ tối đa một).
 SELECT * INTO listing FROM public.room_pass_listings l WHERE l.room_id=v_room AND l.active FOR UPDATE;
 IF FOUND AND listing.organization_id IS DISTINCT FROM c.organization_id THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501'; END IF;
 v_change:=CASE WHEN listing.id IS NULL THEN 'created' ELSE 'updated' END;
 v_phone:=CASE WHEN p_input ? 'customerPhone' THEN p_input->>'customerPhone' ELSE listing.contact_phone END;
 v_name:=CASE WHEN p_input ? 'customerName' THEN p_input->>'customerName' ELSE listing.contact_name END;
 IF listing.id IS NULL AND NOT(p_input ? 'customerPhone') AND NOT(p_input ? 'customerName') THEN
   -- Như form: tự điền khách đại diện của hợp đồng đang hiệu lực.
   SELECT cu.full_name,cu.phone INTO v_name,v_phone FROM public.contracts ct
     JOIN public.contract_customers cc ON cc.contract_id=ct.id JOIN public.customers cu ON cu.id=cc.customer_id AND cu.deleted_at IS NULL
     WHERE ct.room_id=v_room AND ct.deleted_at IS NULL AND ct.status IN ('ACTIVE','EXTENDED')
     ORDER BY COALESCE(cc.is_representative,false) DESC,cu.full_name,cu.id LIMIT 1;
 END IF;
 v_policy:=CASE WHEN p_input ? 'salePolicy' THEN p_input->>'salePolicy' ELSE listing.sale_policy END;
 v_price:=CASE WHEN p_input ? 'passPrice' THEN (p_input->>'passPrice')::numeric ELSE listing.pass_price END;
 IF NOT v_has_date THEN v_date:=listing.avail_date; END IF;
 v_manager:=CASE WHEN p_input ? 'contactManager' THEN (p_input->>'contactManager')::boolean ELSE COALESCE(listing.contact_manager,false) END;
 v_active:=CASE WHEN p_input ? 'active' THEN (p_input->>'active')::boolean ELSE COALESCE(listing.active,true) END;
 BEGIN
   SELECT * INTO saved FROM public.upsert_room_pass_listing(p_id=>listing.id,p_room_id=>v_room,p_contact_name=>v_name,p_contact_phone=>v_phone,
     p_sale_policy=>v_policy,p_pass_price=>v_price,p_active=>v_active,p_avail_date=>v_date,p_contact_manager=>v_manager);
 EXCEPTION
   WHEN unique_violation THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409';
   WHEN raise_exception THEN RAISE EXCEPTION 'hermes_action_denied' USING ERRCODE='42501';
 END;
 IF saved.id IS NULL OR saved.organization_id IS DISTINCT FROM c.organization_id OR saved.room_id IS DISTINCT FROM v_room
   OR saved.building_id IS DISTINCT FROM v_building OR saved.user_id IS DISTINCT FROM v_owner
   OR (listing.id IS NOT NULL AND saved.id IS DISTINCT FROM listing.id) OR saved.active IS DISTINCT FROM v_active
   OR saved.contact_manager IS DISTINCT FROM v_manager OR saved.contact_phone IS DISTINCT FROM v_phone OR saved.contact_name IS DISTINCT FROM v_name
   OR saved.sale_policy IS DISTINCT FROM v_policy OR saved.pass_price IS DISTINCT FROM v_price OR saved.avail_date IS DISTINCT FROM v_date
   THEN RAISE EXCEPTION 'hermes_action_receipt_invalid' USING ERRCODE='PT409'; END IF;
 v_result:=jsonb_build_object('requestId',v_request,'outcome','applied','change',v_change,
   'listing',jsonb_build_object('listingId',saved.id,'buildingId',saved.building_id,'roomId',saved.room_id,'active',saved.active,
     'revision',app_private.hermes_room_pass_revision_v1(saved.id)),
   'contact',jsonb_build_object('name',app_private.hermes_domain_text_v1(saved.contact_name),
     'phoneMasked',CASE WHEN saved.contact_phone IS NULL THEN NULL ELSE '***'||right(regexp_replace(saved.contact_phone,'[^0-9]','','g'),4) END));
 UPDATE app_private.hermes_room_pass_receipts r SET result=v_result WHERE r.connection_id=c.id AND r.request_id=v_request;
 PERFORM app_private.append_authz_audit_v1(c.organization_id,'HERMES_ROOM_PASS_UPSERT','room_pass_listing',saved.id,
   jsonb_build_object('actor',auth.uid(),'connectionId',c.id,'requestId',v_request,'change',v_change,'active',saved.active));
 RETURN v_result;
END $fn$;

ALTER FUNCTION app_private.hermes_room_pass_fold_v1(text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_room_pass_building_ok_v1(app_private.hermes_connections,uuid[],text,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.hermes_room_pass_upsert_v1(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_room_pass_fold_v1(text),app_private.hermes_room_pass_building_ok_v1(app_private.hermes_connections,uuid[],text,uuid,uuid),public.hermes_room_pass_upsert_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_room_pass_upsert_v1(jsonb,text,jsonb) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
