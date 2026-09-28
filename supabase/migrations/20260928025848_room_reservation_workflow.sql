-- P9: party-owned holds and exact next-room claims. Money remains owned by the
-- existing create/settlement writers. Expiry is a reminder, never a release.
CREATE TABLE IF NOT EXISTS public.room_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id),
 building_id uuid NOT NULL REFERENCES public.buildings(id),room_id uuid NOT NULL REFERENCES public.rooms(id),
 customer_id uuid NOT NULL REFERENCES public.customers(id),status text NOT NULL DEFAULT 'HOLD' CHECK(status IN ('HOLD','CONVERTED','CANCELLED')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),hold_until date,intended_move_in_on date,topup_due_on date,
 deposit_target numeric CHECK(deposit_target>=0 AND deposit_target<=9007199254740991 AND deposit_target=trunc(deposit_target)),notes text,
 converted_contract_id uuid REFERENCES public.contracts(id),created_by uuid NOT NULL REFERENCES auth.users(id),
 idempotency_key text NOT NULL,payload_hash text NOT NULL,initial_response jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,created_by,idempotency_key),CHECK((status='CONVERTED')=(converted_contract_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS public.room_next_claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES public.organizations(id),
 room_id uuid NOT NULL REFERENCES public.rooms(id),reservation_id uuid NOT NULL UNIQUE REFERENCES public.room_reservations(id),
 status text NOT NULL DEFAULT 'LIVE' CHECK(status IN ('LIVE','CONSUMED','CANCELLED')),
 consumed_contract_id uuid REFERENCES public.contracts(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((status='CONSUMED')=(consumed_contract_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS room_next_claims_one_live_idx ON public.room_next_claims(organization_id,room_id) WHERE status='LIVE';
CREATE TABLE IF NOT EXISTS public.reservation_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES public.organizations(id),
 reservation_id uuid NOT NULL REFERENCES public.room_reservations(id),customer_id uuid NOT NULL REFERENCES public.customers(id),
 source_voucher_id uuid NOT NULL REFERENCES public.income_expenses(id),source_item_id uuid NOT NULL UNIQUE REFERENCES public.income_expense_items(id),
 created_by uuid NOT NULL REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(reservation_id,source_voucher_id,source_item_id)
);
CREATE TABLE IF NOT EXISTS app_private.room_reservation_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),reservation_id uuid NOT NULL REFERENCES public.room_reservations(id),
 revision bigint NOT NULL,action text NOT NULL,actor_id uuid NOT NULL REFERENCES auth.users(id),idempotency_key text NOT NULL,
 payload_hash text NOT NULL,response jsonb NOT NULL,changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(reservation_id,revision),UNIQUE(reservation_id,actor_id,idempotency_key)
);
REVOKE ALL ON public.room_reservations,public.room_next_claims,public.reservation_receipts,app_private.room_reservation_history FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.room_reservations ENABLE ROW LEVEL SECURITY;ALTER TABLE public.room_next_claims ENABLE ROW LEVEL SECURITY;ALTER TABLE public.reservation_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS room_reservations_scope_select ON public.room_reservations;
CREATE POLICY room_reservations_scope_select ON public.room_reservations FOR SELECT TO authenticated USING(organization_id=ANY(public.my_org_ids()) AND public.can_access_building(building_id) AND public.can_do_on_building('deposits','view',building_id));
DROP POLICY IF EXISTS room_reservations_hide_sandbox_admin ON public.room_reservations;
CREATE POLICY room_reservations_hide_sandbox_admin ON public.room_reservations AS RESTRICTIVE FOR SELECT TO authenticated USING(NOT(public.is_super_admin() AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)));
DROP POLICY IF EXISTS room_next_claims_hide_sandbox_admin ON public.room_next_claims;
CREATE POLICY room_next_claims_hide_sandbox_admin ON public.room_next_claims AS RESTRICTIVE FOR SELECT TO authenticated USING(NOT(public.is_super_admin() AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)));
DROP POLICY IF EXISTS reservation_receipts_hide_sandbox_admin ON public.reservation_receipts;
CREATE POLICY reservation_receipts_hide_sandbox_admin ON public.reservation_receipts AS RESTRICTIVE FOR SELECT TO authenticated USING(NOT(public.is_super_admin() AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)));

CREATE OR REPLACE FUNCTION app_private.assert_room_reservation_scope_v1(p_org uuid,p_building uuid,p_action text)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
 IF auth.uid() IS NULL OR NOT COALESCE(p_org=ANY(public.my_org_ids()),false) OR NOT COALESCE(public.can_access_building(p_building),false)
  OR NOT COALESCE(public.can_do_on_building(split_part(p_action,'.',1),split_part(p_action,'.',2),p_building),false)
  OR (split_part(p_action,'.',2)='view' AND public.is_super_admin() AND COALESCE(p_org=ANY(public.sandbox_org_ids()),false)) THEN
  RAISE EXCEPTION 'Không có quyền giữ chỗ trong tổ chức/tòa nhà này' USING ERRCODE='42501';END IF;
END $fn$;
CREATE OR REPLACE FUNCTION app_private.authorize_room_reservation_writer_v1(p_org uuid,p_building uuid,p_action text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
 IF p_action IS NULL OR p_action NOT IN ('deposits.create','deposits.edit','deposits.delete','contracts.create') THEN RAISE EXCEPTION 'Unknown reservation authority' USING ERRCODE='42501';END IF;
 PERFORM app_private.assert_room_reservation_scope_v1(p_org,p_building,p_action);
 IF NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_org,p_action,p_building,NULL)),false) THEN
  RAISE EXCEPTION 'Quyền giữ chỗ đã thay đổi' USING ERRCODE='42501';END IF;
END $fn$;
CREATE OR REPLACE FUNCTION app_private.reservation_receipt_projection_v1(p_reservation uuid)
RETURNS TABLE(source_voucher_id uuid,source_item_id uuid,amount numeric,received boolean,approval_status text,code text,released boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
 SELECT v.id,i.id,i.amount,COALESCE((app_private.reservation_settlement_basis_v1(v.id)->>'received')::boolean,false)
   AND NOT app_private.reservation_deposit_is_settled_v1(v.id) AND v.contract_id IS NULL,
   v.approval_status,v.code,v.deleted_at IS NOT NULL OR v.approval_status='CANCELLED' OR app_private.reservation_deposit_is_settled_v1(v.id)
 FROM public.reservation_receipts r JOIN public.income_expenses v ON v.id=r.source_voucher_id AND v.organization_id=r.organization_id
 JOIN public.income_expense_items i ON i.id=r.source_item_id AND i.income_expense_id=v.id
 WHERE r.reservation_id=p_reservation
$fn$;
CREATE OR REPLACE FUNCTION app_private.room_reservation_response_v1(p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
 SELECT jsonb_build_object('id',r.id,'organization_id',r.organization_id,'building_id',r.building_id,'room_id',r.room_id,'customer_id',r.customer_id,
 'customer_name',c.full_name,'customer_phone',c.phone,'building_name',b.name,'room_name',rm.name,'status',r.status,'claim_status',cl.status,'revision',r.revision,
 'hold_until',r.hold_until,'intended_move_in_on',r.intended_move_in_on,'topup_due_on',r.topup_due_on,'deposit_target',r.deposit_target,'notes',r.notes,
 'converted_contract_id',r.converted_contract_id,'overdue',r.status='HOLD' AND COALESCE(r.hold_until<public.org_today_v1(r.organization_id),false),
 'received_amount',COALESCE((SELECT sum(p.amount) FROM app_private.reservation_receipt_projection_v1(r.id) p WHERE p.received),0),
 'source_voucher_ids',COALESCE((SELECT jsonb_agg(v ORDER BY v) FROM(SELECT DISTINCT p.source_voucher_id v FROM app_private.reservation_receipt_projection_v1(r.id) p WHERE p.received) s),'[]'::jsonb),
 'receipts',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.source_voucher_id,p.source_item_id) FROM app_private.reservation_receipt_projection_v1(r.id) p),'[]'::jsonb),
 'created_at',r.created_at,'updated_at',r.updated_at,'history',COALESCE((SELECT jsonb_agg(jsonb_build_object('revision',h.revision,'action',h.action,'changed_by',h.actor_id,'changed_at',h.changed_at) ORDER BY h.revision) FROM app_private.room_reservation_history h WHERE h.reservation_id=r.id),'[]'::jsonb))
 FROM public.room_reservations r JOIN public.room_next_claims cl ON cl.reservation_id=r.id JOIN public.customers c ON c.id=r.customer_id
 JOIN public.rooms rm ON rm.id=r.room_id JOIN public.buildings b ON b.id=r.building_id WHERE r.id=p_id
$fn$;

-- Legacy sources have no reliable customer UUID. Only explicitly selected
-- whole source vouchers may be adopted; the operator must choose the party.
CREATE OR REPLACE FUNCTION app_private.assert_room_reservation_legacy_sources_v1(p_org uuid,p_room uuid,p_allowed_vouchers uuid[] DEFAULT '{}'::uuid[])
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM public.deposits d WHERE d.room_id=p_room AND d.organization_id=p_org AND d.contract_id IS NULL AND d.deleted_at IS NULL AND d.status IN ('PENDING','CONFIRMED'))
  OR EXISTS(SELECT 1 FROM public.room_reservation_holds h WHERE h.room_id=p_room AND h.contract_id IS NULL AND h.status IN ('PENDING_APPROVAL','APPROVED') AND h.expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'Phòng có giữ chỗ/cọc cũ chưa xác định khách. Cần xử lý nguồn cũ trước.' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM public.income_expenses v WHERE v.organization_id=p_org AND v.room_id=p_room AND v.contract_id IS NULL AND v.deleted_at IS NULL AND v.type='INCOME'
  AND COALESCE(v.approval_status,'')<>'CANCELLED' AND public.ie_has_deposit_item(v.id) AND NOT app_private.reservation_deposit_is_settled_v1(v.id)
  AND NOT(v.id=ANY(COALESCE(p_allowed_vouchers,'{}'::uuid[])))) THEN
  RAISE EXCEPTION 'Phòng có phiếu cọc khác chưa gắn đúng khách giữ chỗ. Không thể tự nhận nguồn tiền.' USING ERRCODE='55000';END IF;
END $fn$;
CREATE OR REPLACE FUNCTION app_private.bind_reservation_source_voucher_v1(p_reservation uuid,p_voucher uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE r public.room_reservations%ROWTYPE;v public.income_expenses%ROWTYPE;basis jsonb;
BEGIN
 SELECT * INTO STRICT r FROM public.room_reservations WHERE id=p_reservation;
 SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher FOR UPDATE;
 IF NOT FOUND OR v.organization_id IS DISTINCT FROM r.organization_id OR v.building_id IS DISTINCT FROM r.building_id OR v.room_id IS DISTINCT FROM r.room_id
  OR v.contract_id IS NOT NULL OR v.deleted_at IS NOT NULL OR v.type<>'INCOME' OR COALESCE(v.approval_status,'')='CANCELLED'
  OR app_private.reservation_deposit_is_settled_v1(v.id) OR EXISTS(SELECT 1 FROM public.contract_deposit_links WHERE income_expense_id=v.id)
  OR EXISTS(SELECT 1 FROM public.reservation_receipts WHERE source_voucher_id=v.id AND reservation_id<>r.id) THEN
  RAISE EXCEPTION 'Phiếu cọc nguồn không còn thuộc khách/phòng giữ chỗ này' USING ERRCODE='42501';END IF;
 basis:=app_private.reservation_settlement_basis_v1(v.id);
 IF COALESCE((basis->>'amount')::numeric,0)<=0 OR COALESCE((basis->>'mismatch')::boolean,true) THEN RAISE EXCEPTION 'Nguồn cọc không có dòng cọc hợp lệ' USING ERRCODE='55000';END IF;
 INSERT INTO public.reservation_receipts(organization_id,reservation_id,customer_id,source_voucher_id,source_item_id,created_by)
 SELECT r.organization_id,r.id,r.customer_id,v.id,i.id,auth.uid() FROM public.income_expense_items i JOIN public.income_expense_types t ON t.id=i.income_expense_type_id
 WHERE i.income_expense_id=v.id AND i.accounting_class='DEPOSIT' AND t.is_deposit ON CONFLICT(source_item_id) DO NOTHING;
END $fn$;
CREATE OR REPLACE FUNCTION app_private.create_reservation_source_receipt_v1(p_reservation uuid,p_receipt jsonb,p_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE r public.room_reservations%ROWTYPE;v public.income_expenses%ROWTYPE;type_id uuid;account_id uuid;amt numeric;day date;items jsonb;customer_name text;result jsonb;
 error_code text;error_message text;
BEGIN
 IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_receipt) k WHERE k NOT IN ('amount','account_id','voucher_date','name','description','attachments'))
  OR jsonb_typeof(p_receipt->'amount') IS DISTINCT FROM 'number' OR jsonb_typeof(COALESCE(p_receipt->'attachments','[]'::jsonb))<>'array' THEN RAISE EXCEPTION 'Invalid positive deposit receipt' USING ERRCODE='22023';END IF;
 amt:=(p_receipt->>'amount')::numeric;day:=(p_receipt->>'voucher_date')::date;account_id:=NULLIF(p_receipt->>'account_id','')::uuid;
 IF amt IS NULL OR amt<=0 OR amt>9007199254740991 OR amt<>trunc(amt) OR amt::text IN ('NaN','Infinity','-Infinity') OR day IS NULL THEN
  RAISE EXCEPTION 'Cọc phải là số tiền VND dương thực tế; giữ chỗ 0 đồng không tạo phiếu' USING ERRCODE='22023';END IF;
 SELECT * INTO STRICT r FROM public.room_reservations WHERE id=p_reservation;
 SELECT full_name INTO customer_name FROM public.customers WHERE id=r.customer_id AND organization_id=r.organization_id;
 IF account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.accounts WHERE id=account_id AND organization_id=r.organization_id AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Sổ quỹ không thuộc tổ chức' USING ERRCODE='42501';END IF;
 SELECT id INTO type_id FROM public.income_expense_types WHERE organization_id=r.organization_id AND lower(type)='income' AND is_deposit ORDER BY id LIMIT 1;
 IF type_id IS NULL THEN RAISE EXCEPTION 'Tổ chức chưa có hạng mục thu cọc hiện hành' USING ERRCODE='55000';END IF;
 items:=jsonb_build_array(jsonb_build_object('income_expense_type_id',type_id,'description',p_receipt->>'description','quantity',1,'unit_price',amt,'start_date',day,'end_date',day));
 -- Exact current frontend canonical/fallback dispatch, including the two
 -- existing cashbook fallback messages. All other denial/conflict errors rise.
 BEGIN
  v:=public.create_income_expense_v1('INCOME',COALESCE(NULLIF(btrim(p_receipt->>'name'),''),'Cọc giữ chỗ'),r.building_id,r.room_id,NULL,NULL,customer_name,NULL,NULL,account_id,
    COALESCE(p_receipt->'attachments','[]'::jsonb),NULL,NULL,day,items,p_key);
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS error_code=RETURNED_SQLSTATE,error_message=MESSAGE_TEXT;
  IF NOT(error_code='0A000' OR (error_code='55000' AND position('chưa bật' IN error_message)>0)
   OR (error_code='42501' AND error_message ~ '(Không có quyền sử dụng sổ quỹ này|Quyền sử dụng sổ quỹ đã bị thu hồi)')) THEN RAISE;END IF;
  result:=public.ie_compat_insert_v2(jsonb_build_object('type','INCOME','name',COALESCE(NULLIF(btrim(p_receipt->>'name'),''),'Cọc giữ chỗ'),
   'building_id',r.building_id,'room_id',r.room_id,'tenant_id',NULL,'contract_id',NULL,'payer_name',customer_name,'account_id',account_id,'attachments',COALESCE(p_receipt->'attachments','[]'::jsonb),
   'voucher_date',day,'business_result_accounting',NULL,'repeat_cycle','NONE','repeat_infinity',false,'repeat_count',0),
   jsonb_build_array((items->0)||jsonb_build_object('accounting_class','DEPOSIT')));
  SELECT * INTO v FROM public.income_expenses WHERE id=(result->>'id')::uuid;
 END;
 IF v.id IS NULL THEN RAISE EXCEPTION 'Writer cọc không trả phiếu nguồn' USING ERRCODE='55000';END IF;
 PERFORM app_private.bind_reservation_source_voucher_v1(r.id,v.id);RETURN v.id;
END $fn$;

CREATE OR REPLACE FUNCTION public.create_room_reservation_v1(p_organization_id uuid,p_idempotency_key text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE r public.rooms%ROWTYPE;res public.room_reservations%ROWTYPE;cust uuid;rid uuid;hash text;response jsonb;ids uuid[];v uuid;
BEGIN
 IF p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Chưa chọn tổ chức được phép' USING ERRCODE='42501';END IF;
 IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('room_id','customer_id','hold_until','intended_move_in_on','topup_due_on','deposit_target','notes','receipt','existing_voucher_ids')) THEN RAISE EXCEPTION 'Invalid reservation intent' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM public.rooms WHERE id=(p_payload->>'room_id')::uuid AND organization_id=p_organization_id AND deleted_at IS NULL FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phòng trong tổ chức' USING ERRCODE='42501';END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
 PERFORM app_private.authorize_room_reservation_writer_v1(p_organization_id,r.building_id,'deposits.create');
 cust:=(p_payload->>'customer_id')::uuid;
 PERFORM 1 FROM public.customers WHERE id=cust AND organization_id=p_organization_id AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Phải chọn khách cụ thể trong tổ chức' USING ERRCODE='42501';END IF;
 hash:=md5(p_payload::text);
 SELECT * INTO res FROM public.room_reservations WHERE organization_id=p_organization_id AND created_by=auth.uid() AND idempotency_key=p_idempotency_key FOR UPDATE;
 IF FOUND THEN IF res.payload_hash<>hash THEN RAISE EXCEPTION 'Khóa giữ chỗ đã dùng cho nội dung khác' USING ERRCODE='23505';END IF;RETURN res.initial_response;END IF;
 IF EXISTS(SELECT 1 FROM public.room_next_claims WHERE organization_id=p_organization_id AND room_id=r.id AND status='LIVE') THEN RAISE EXCEPTION 'Phòng đã có khách giữ chỗ tiếp theo' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM public.contracts WHERE organization_id=p_organization_id AND room_id=r.id AND deleted_at IS NULL AND status IN ('ACTIVE','EXTENDED')) THEN
  IF r.status NOT IN ('AVAILABLE','RESERVED','OCCUPIED') OR (p_payload->>'intended_move_in_on')::date IS NULL
   OR (SELECT count(*) FROM public.contracts WHERE organization_id=p_organization_id AND room_id=r.id AND deleted_at IS NULL AND status IN ('ACTIVE','EXTENDED'))<>1
   OR EXISTS(SELECT 1 FROM public.contracts c WHERE c.organization_id=p_organization_id AND c.room_id=r.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED')
    AND (c.expected_move_out_date IS NULL OR c.actual_end_date IS NOT NULL OR (p_payload->>'intended_move_in_on')::date<c.expected_move_out_date)) THEN
   RAISE EXCEPTION 'Phòng đang có khách: cần báo trả rõ ràng và ngày dự kiến vào từ ngày báo trả trở đi' USING ERRCODE='55000';END IF;
 ELSE
  IF r.status NOT IN ('AVAILABLE','RESERVED') THEN RAISE EXCEPTION 'Phòng chưa sẵn sàng để giữ chỗ' USING ERRCODE='55000';END IF;
 END IF;
 IF jsonb_typeof(COALESCE(p_payload->'existing_voucher_ids','[]'::jsonb))<>'array' THEN RAISE EXCEPTION 'Invalid source voucher IDs' USING ERRCODE='22023';END IF;
 SELECT COALESCE(array_agg((value#>>'{}')::uuid),'{}'::uuid[]) INTO ids FROM jsonb_array_elements(COALESCE(p_payload->'existing_voucher_ids','[]'::jsonb));
 IF cardinality(ids)<>(SELECT count(DISTINCT x) FROM unnest(ids) x) THEN RAISE EXCEPTION 'Duplicate source voucher IDs' USING ERRCODE='22023';END IF;
 IF NOT(p_payload?'receipt') AND cardinality(ids)=0 AND NULLIF(p_payload->>'hold_until','') IS NULL THEN
  RAISE EXCEPTION 'Giữ chỗ chưa nhận tiền phải chọn hạn giữ chỗ' USING ERRCODE='22023';END IF;
 PERFORM app_private.assert_room_reservation_legacy_sources_v1(p_organization_id,r.id,ids);
 INSERT INTO public.room_reservations(organization_id,building_id,room_id,customer_id,hold_until,intended_move_in_on,topup_due_on,deposit_target,notes,created_by,idempotency_key,payload_hash)
 VALUES(p_organization_id,r.building_id,r.id,cust,(p_payload->>'hold_until')::date,(p_payload->>'intended_move_in_on')::date,(p_payload->>'topup_due_on')::date,(p_payload->>'deposit_target')::numeric,p_payload->>'notes',auth.uid(),p_idempotency_key,hash) RETURNING id INTO rid;
 INSERT INTO public.room_next_claims(organization_id,room_id,reservation_id) VALUES(p_organization_id,r.id,rid);
 FOREACH v IN ARRAY ids LOOP PERFORM app_private.bind_reservation_source_voucher_v1(rid,v);END LOOP;
 IF p_payload ? 'receipt' THEN PERFORM app_private.create_reservation_source_receipt_v1(rid,p_payload->'receipt','res-deposit-'||rid::text);END IF;
 response:=app_private.room_reservation_response_v1(rid);
 INSERT INTO app_private.room_reservation_history(reservation_id,revision,action,actor_id,idempotency_key,payload_hash,response) VALUES(rid,1,'CREATE',auth.uid(),p_idempotency_key,hash,response);
 response:=app_private.room_reservation_response_v1(rid);UPDATE public.room_reservations SET initial_response=response WHERE id=rid;RETURN response;
END $fn$;
CREATE OR REPLACE FUNCTION public.update_room_reservation_v1(p_organization_id uuid,p_reservation_id uuid,p_expected_revision bigint,p_idempotency_key text,p_action text,p_changes jsonb DEFAULT '{}'::jsonb,p_receipt jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE r public.room_reservations%ROWTYPE;h app_private.room_reservation_history%ROWTYPE;hash text;response jsonb;changed_at timestamptz:=clock_timestamp();
BEGIN
 IF p_organization_id IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Chưa chọn tổ chức được phép' USING ERRCODE='42501';END IF;
 IF p_action IS NULL OR p_action NOT IN ('UPDATE','TOPUP','CANCEL') OR p_expected_revision IS NULL OR p_expected_revision<1 OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
  OR jsonb_typeof(p_changes) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k NOT IN ('hold_until','intended_move_in_on','topup_due_on','deposit_target','notes'))
  OR (p_action='TOPUP') IS DISTINCT FROM (p_receipt IS NOT NULL AND p_receipt<>'null'::jsonb) OR (p_action<>'UPDATE' AND p_changes<>'{}'::jsonb) THEN RAISE EXCEPTION 'Invalid reservation change' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM public.room_reservations WHERE id=p_reservation_id AND organization_id=p_organization_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy giữ chỗ trong tổ chức' USING ERRCODE='42501';END IF;
 PERFORM app_private.assert_room_reservation_scope_v1(p_organization_id,r.building_id,CASE p_action WHEN 'TOPUP' THEN 'deposits.create' WHEN 'CANCEL' THEN 'deposits.delete' ELSE 'deposits.edit' END);
 PERFORM 1 FROM public.rooms WHERE id=r.room_id FOR NO KEY UPDATE;
 PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
 PERFORM app_private.authorize_room_reservation_writer_v1(p_organization_id,r.building_id,CASE p_action WHEN 'TOPUP' THEN 'deposits.create' WHEN 'CANCEL' THEN 'deposits.delete' ELSE 'deposits.edit' END);
 SELECT * INTO r FROM public.room_reservations WHERE id=p_reservation_id FOR UPDATE;
 hash:=md5(jsonb_build_object('revision',p_expected_revision,'action',p_action,'changes',p_changes,'receipt',p_receipt)::text);
 SELECT * INTO h FROM app_private.room_reservation_history WHERE reservation_id=r.id AND actor_id=auth.uid() AND idempotency_key=p_idempotency_key;
 IF FOUND THEN IF h.payload_hash<>hash THEN RAISE EXCEPTION 'Khóa sửa giữ chỗ đã dùng với nội dung khác' USING ERRCODE='23505';END IF;RETURN h.response;END IF;
 IF r.revision<>p_expected_revision THEN RAISE EXCEPTION 'Giữ chỗ đã thay đổi' USING ERRCODE='PT409';END IF;
 IF r.status<>'HOLD' OR NOT EXISTS(SELECT 1 FROM public.room_next_claims WHERE reservation_id=r.id AND status='LIVE') THEN RAISE EXCEPTION 'Giữ chỗ đã được xử lý' USING ERRCODE='55000';END IF;
 IF p_action='UPDATE' AND NOT EXISTS(SELECT 1 FROM public.reservation_receipts WHERE reservation_id=r.id)
  AND (CASE WHEN p_changes?'hold_until' THEN NULLIF(p_changes->>'hold_until','')::date ELSE r.hold_until END) IS NULL THEN
  RAISE EXCEPTION 'Giữ chỗ chưa nhận tiền phải giữ hạn do người dùng chọn' USING ERRCODE='22023';END IF;
 IF p_action='CANCEL' THEN
  IF EXISTS(SELECT 1 FROM app_private.reservation_receipt_projection_v1(r.id) WHERE NOT released) THEN RAISE EXCEPTION 'Cọc còn hiệu lực. Xử lý phiếu nguồn bằng luồng hiện tại trước khi hủy giữ chỗ.' USING ERRCODE='55000';END IF;
  UPDATE public.room_next_claims SET status='CANCELLED',updated_at=clock_timestamp() WHERE reservation_id=r.id;
  UPDATE public.room_reservations SET status='CANCELLED',revision=revision+1,updated_at=clock_timestamp() WHERE id=r.id;
 ELSE
  IF p_action='TOPUP' THEN
   PERFORM app_private.assert_room_reservation_legacy_sources_v1(p_organization_id,r.room_id,ARRAY(SELECT DISTINCT source_voucher_id FROM public.reservation_receipts WHERE reservation_id=r.id));
   PERFORM app_private.create_reservation_source_receipt_v1(r.id,p_receipt,'res-topup-'||r.id::text||'-'||(r.revision+1)::text);
  END IF;
  UPDATE public.room_reservations SET hold_until=CASE WHEN p_changes?'hold_until' THEN (p_changes->>'hold_until')::date ELSE hold_until END,
   intended_move_in_on=CASE WHEN p_changes?'intended_move_in_on' THEN (p_changes->>'intended_move_in_on')::date ELSE intended_move_in_on END,
   topup_due_on=CASE WHEN p_changes?'topup_due_on' THEN (p_changes->>'topup_due_on')::date ELSE topup_due_on END,
   deposit_target=CASE WHEN p_changes?'deposit_target' THEN (p_changes->>'deposit_target')::numeric ELSE deposit_target END,
   notes=CASE WHEN p_changes?'notes' THEN p_changes->>'notes' ELSE notes END,revision=revision+1,updated_at=clock_timestamp() WHERE id=r.id;
 END IF;
 response:=app_private.room_reservation_response_v1(r.id);
 response:=jsonb_set(response,'{history}',(response->'history')||jsonb_build_array(jsonb_build_object('revision',r.revision+1,'action',p_action,'changed_by',auth.uid(),'changed_at',changed_at)));
 INSERT INTO app_private.room_reservation_history(reservation_id,revision,action,actor_id,idempotency_key,payload_hash,response,changed_at) VALUES(r.id,r.revision+1,p_action,auth.uid(),p_idempotency_key,hash,response,changed_at);
 RETURN response;
END $fn$;
CREATE OR REPLACE FUNCTION public.list_room_reservations_v1(p_organization_id uuid,p_room_id uuid DEFAULT NULL,p_customer_id uuid DEFAULT NULL,p_status text DEFAULT NULL,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
 IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) OR (public.is_super_admin() AND COALESCE(p_organization_id=ANY(public.sandbox_org_ids()),false)) THEN RAISE EXCEPTION 'Không có quyền đọc giữ chỗ trong tổ chức' USING ERRCODE='42501';END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR (p_status IS NOT NULL AND p_status NOT IN ('HOLD','CONVERTED','CANCELLED')) THEN RAISE EXCEPTION 'Invalid reservation list filter' USING ERRCODE='22023';END IF;
 IF p_room_id IS NOT NULL THEN
  PERFORM app_private.assert_room_reservation_scope_v1(p_organization_id,(SELECT building_id FROM public.rooms WHERE id=p_room_id AND organization_id=p_organization_id AND deleted_at IS NULL),'deposits.view');
 END IF;
 RETURN jsonb_build_object('server_today',public.org_today_v1(p_organization_id),'reservations',COALESCE((SELECT jsonb_agg(app_private.room_reservation_response_v1(id) ORDER BY created_at DESC,id) FROM(
  SELECT r.id,r.created_at FROM public.room_reservations r WHERE r.organization_id=p_organization_id AND (p_room_id IS NULL OR r.room_id=p_room_id) AND (p_customer_id IS NULL OR r.customer_id=p_customer_id)
  AND (p_status IS NULL OR r.status=p_status) AND public.can_access_building(r.building_id) AND public.can_do_on_building('deposits','view',r.building_id)
  ORDER BY r.created_at DESC,r.id LIMIT p_limit) s),'[]'::jsonb));
END $fn$;

CREATE OR REPLACE FUNCTION app_private.assert_room_next_claim_for_signing_v1(p_org uuid,p_room uuid,p_reservation uuid,p_expected_revision bigint,p_customer_ids uuid[],p_voucher_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE roomrow public.rooms%ROWTYPE;r public.room_reservations%ROWTYPE;expected uuid[];provided uuid[];
BEGIN
 SELECT * INTO roomrow FROM public.rooms WHERE id=p_room AND organization_id=p_org AND deleted_at IS NULL FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Phòng ký không thuộc tổ chức' USING ERRCODE='42501';END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_org);
 PERFORM app_private.authorize_room_reservation_writer_v1(p_org,roomrow.building_id,'contracts.create');
 SELECT r0.* INTO r FROM public.room_next_claims c JOIN public.room_reservations r0 ON r0.id=c.reservation_id WHERE c.organization_id=p_org AND c.room_id=p_room AND c.status='LIVE' FOR UPDATE OF c,r0;
 IF NOT FOUND THEN
  IF p_reservation IS NOT NULL THEN RAISE EXCEPTION 'Claim giữ chỗ không còn hiệu lực' USING ERRCODE='55000';END IF;
  PERFORM app_private.assert_room_reservation_legacy_sources_v1(p_org,p_room,COALESCE(p_voucher_ids,'{}'::uuid[]));RETURN;
 END IF;
 IF p_reservation IS NULL OR r.id<>p_reservation THEN RAISE EXCEPTION 'Phải chọn đúng khách đang giữ chỗ phòng này' USING ERRCODE='55000';END IF;
 IF p_expected_revision IS NULL OR r.revision<>p_expected_revision THEN RAISE EXCEPTION 'Claim giữ chỗ đã thay đổi' USING ERRCODE='PT409';END IF;
 IF r.status<>'HOLD' OR NOT COALESCE(r.customer_id=ANY(p_customer_ids),false) THEN RAISE EXCEPTION 'Khách ký không khớp khách giữ chỗ' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.income_expenses v WHERE v.id IN(SELECT source_voucher_id FROM public.reservation_receipts WHERE reservation_id=r.id) ORDER BY v.id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM app_private.reservation_receipt_projection_v1(r.id) p WHERE NOT p.released AND NOT p.received) THEN RAISE EXCEPTION 'Cọc giữ chỗ còn chờ duyệt/chưa nhận. Xử lý nguồn hiện tại trước khi ký.' USING ERRCODE='55000';END IF;
 SELECT COALESCE(array_agg(DISTINCT p.source_voucher_id ORDER BY p.source_voucher_id),'{}'::uuid[]) INTO expected FROM app_private.reservation_receipt_projection_v1(r.id) p WHERE p.received;
 SELECT COALESCE(array_agg(DISTINCT x ORDER BY x),'{}'::uuid[]) INTO provided FROM unnest(COALESCE(p_voucher_ids,'{}'::uuid[])) x;
 IF cardinality(provided)<>cardinality(COALESCE(p_voucher_ids,'{}'::uuid[])) OR provided<>expected THEN RAISE EXCEPTION 'Nguồn cọc ký phải khớp đúng hồ sơ giữ chỗ' USING ERRCODE='55000';END IF;
 PERFORM app_private.assert_room_reservation_legacy_sources_v1(p_org,p_room,expected);
END $fn$;
CREATE OR REPLACE FUNCTION app_private.consume_room_next_claim_v1(p_org uuid,p_reservation uuid,p_expected_revision bigint,p_contract uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE r public.room_reservations%ROWTYPE;c public.contracts%ROWTYPE;
BEGIN
 IF p_reservation IS NULL THEN RETURN;END IF;
 SELECT * INTO r FROM public.room_reservations WHERE id=p_reservation AND organization_id=p_org;
 IF NOT FOUND THEN RAISE EXCEPTION 'Claim không thuộc tổ chức ký' USING ERRCODE='42501';END IF;
 PERFORM app_private.assert_room_reservation_scope_v1(p_org,r.building_id,'contracts.create');
 PERFORM 1 FROM public.rooms WHERE id=r.room_id FOR NO KEY UPDATE;
 PERFORM app_private.lock_org_for_decision_v1(p_org);
 PERFORM app_private.authorize_room_reservation_writer_v1(p_org,r.building_id,'contracts.create');
 SELECT * INTO r FROM public.room_reservations WHERE id=p_reservation FOR UPDATE;
 IF r.status='CONVERTED' AND r.converted_contract_id=p_contract THEN RETURN;END IF;
 SELECT * INTO c FROM public.contracts WHERE id=p_contract AND organization_id=p_org AND room_id=r.room_id AND deleted_at IS NULL;
 -- Only trusted core/signing callers can execute this private helper. Tuple
 -- xmin can belong to a savepoint child transaction, so it is not a reliable
 -- freshness comparison with the parent txid. Keep date, party and source checks.
 IF NOT FOUND OR c.status NOT IN ('ACTIVE','EXTENDED') OR c.created_at<transaction_timestamp() THEN RAISE EXCEPTION 'Claim chỉ nhận đúng hợp đồng mới tạo trong giao dịch ký' USING ERRCODE='42501';END IF;
 IF r.status<>'HOLD' OR p_expected_revision IS NULL OR r.revision<>p_expected_revision OR NOT EXISTS(SELECT 1 FROM public.room_next_claims WHERE reservation_id=r.id AND status='LIVE') THEN RAISE EXCEPTION 'Claim giữ chỗ đã thay đổi' USING ERRCODE='PT409';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.contract_customers WHERE contract_id=c.id AND customer_id=r.customer_id)
  OR EXISTS(SELECT 1 FROM public.reservation_receipts a JOIN public.income_expenses v ON v.id=a.source_voucher_id WHERE a.reservation_id=r.id AND v.deleted_at IS NULL AND v.approval_status<>'CANCELLED'
   AND NOT app_private.reservation_deposit_is_settled_v1(v.id) AND (v.contract_id IS DISTINCT FROM c.id OR NOT EXISTS(SELECT 1 FROM public.contract_deposit_links l WHERE l.contract_id=c.id AND l.income_expense_id=v.id))) THEN
  RAISE EXCEPTION 'Hợp đồng mới chưa nhận đúng khách và nguồn cọc claim' USING ERRCODE='42501';END IF;
 UPDATE public.room_next_claims SET status='CONSUMED',consumed_contract_id=c.id,updated_at=clock_timestamp() WHERE reservation_id=r.id;
 UPDATE public.room_reservations SET status='CONVERTED',converted_contract_id=c.id,revision=revision+1,updated_at=clock_timestamp() WHERE id=r.id;
 INSERT INTO app_private.room_reservation_history(reservation_id,revision,action,actor_id,idempotency_key,payload_hash,response)
 VALUES(r.id,r.revision+1,'CONVERT',auth.uid(),'sign-'||c.id::text,md5(c.id::text),app_private.room_reservation_response_v1(r.id));
END $fn$;

-- Direct old create callers must not bypass the same LIVE claim. Patch only
-- these two structural seams; retain every money block of the current core.
DO $patch$
DECLARE source text;patched text;anchor text;injection text;
BEGIN
 source:=pg_get_functiondef('public.create_contract_v2(jsonb,text)'::regprocedure);patched:=source;
 IF position('app_private.assert_room_next_claim_for_signing_v1' IN source)=0 THEN
  anchor:=E'UPDATE public.room_reservation_holds\n     SET status = ''EXPIRED''';
  IF position(anchor IN patched)=0 THEN anchor:=replace(anchor,E'\n',E'\r\n');END IF;
  injection:=E'PERFORM app_private.assert_room_next_claim_for_signing_v1(v_org,v_room_id,NULLIF(p_payload->>''reservation_id'','''')::uuid,NULLIF(p_payload->>''reservation_revision'','''')::bigint,ARRAY(SELECT (value->>''customer_id'')::uuid FROM jsonb_array_elements(COALESCE(p_payload->''customers'',''[]''::jsonb))),ARRAY(SELECT (value#>>''{}'')::uuid FROM jsonb_array_elements(COALESCE(p_payload->''existing_deposit_voucher_ids'',''[]''::jsonb))));\n  ';
  IF position(anchor IN patched)=0 OR (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Current contract create claim seam changed; review direct source';END IF;
  patched:=replace(patched,anchor,injection||anchor);
 END IF;
 IF position('app_private.consume_room_next_claim_v1' IN source)=0 THEN
  anchor:='v_response := jsonb_build_object(';
  injection:=E'PERFORM app_private.consume_room_next_claim_v1(v_org,NULLIF(p_payload->>''reservation_id'','''')::uuid,NULLIF(p_payload->>''reservation_revision'','''')::bigint,v_contract_id);\n  ';
  IF position(anchor IN patched)=0 OR (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Current contract create response seam changed; review direct source';END IF;
  patched:=replace(patched,anchor,injection||anchor);
 END IF;
 IF patched<>source THEN EXECUTE patched;END IF;
END $patch$;
-- Identity-free legacy writes cannot invent a customer or a 1-dong source.
CREATE OR REPLACE FUNCTION public.create_reservation_deposit_v1(p_room_id uuid,p_amount numeric,p_idempotency_key text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RAISE EXCEPTION 'Giữ chỗ cần khách cụ thể. Dùng luồng Giữ chỗ/Cọc mới; không tạo giữ chỗ vô danh.' USING ERRCODE='55000';END $fn$;
CREATE OR REPLACE FUNCTION app_private.reservation_identity_history_immutable_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RAISE EXCEPTION 'Reservation identity history is immutable' USING ERRCODE='42501';END $fn$;
DROP TRIGGER IF EXISTS reservation_receipts_immutable ON public.reservation_receipts;
CREATE TRIGGER reservation_receipts_immutable BEFORE UPDATE OR DELETE ON public.reservation_receipts FOR EACH ROW EXECUTE FUNCTION app_private.reservation_identity_history_immutable_v1();
DROP TRIGGER IF EXISTS room_reservation_history_immutable ON app_private.room_reservation_history;
CREATE TRIGGER room_reservation_history_immutable BEFORE UPDATE OR DELETE ON app_private.room_reservation_history FOR EACH ROW EXECUTE FUNCTION app_private.reservation_identity_history_immutable_v1();
DO $acl$
DECLARE f record;
BEGIN
 FOR f IN SELECT p.oid::regprocedure AS identity FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app_private' AND p.proname IN(
  'assert_room_reservation_scope_v1','authorize_room_reservation_writer_v1','reservation_receipt_projection_v1','room_reservation_response_v1','assert_room_reservation_legacy_sources_v1','bind_reservation_source_voucher_v1','create_reservation_source_receipt_v1','assert_room_next_claim_for_signing_v1','consume_room_next_claim_v1','reservation_identity_history_immutable_v1') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.identity);END LOOP;
END $acl$;
REVOKE ALL ON FUNCTION public.create_room_reservation_v1(uuid,text,jsonb),public.update_room_reservation_v1(uuid,uuid,bigint,text,text,jsonb,jsonb),public.list_room_reservations_v1(uuid,uuid,uuid,text,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.create_room_reservation_v1(uuid,text,jsonb),public.update_room_reservation_v1(uuid,uuid,bigint,text,text,jsonb,jsonb),public.list_room_reservations_v1(uuid,uuid,uuid,text,integer) TO authenticated;
