-- A financial request owns one receipt. The reservation is attached before commit.
CREATE TABLE IF NOT EXISTS app_private.deposit_income_requests (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  request_key text NOT NULL, input_hash text NOT NULL,
  voucher_id uuid REFERENCES public.income_expenses(id),
  reservation_id uuid REFERENCES public.room_reservations(id),
  PRIMARY KEY (organization_id,actor_id,request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS deposit_income_once_per_lead ON app_private.deposit_income_requests(organization_id,request_key)
  WHERE request_key LIKE 'lead-income-%';
REVOKE ALL ON app_private.deposit_income_requests FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.attach_deposit_income_v1(
  p_voucher uuid, p_terms jsonb, p_actor uuid, p_allowed_sources uuid[] DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE
  v public.income_expenses%ROWTYPE; rm public.rooms%ROWTYPE; h public.room_reservations%ROWTYPE;
  existing uuid; move_in date; key text := 'receipt-' || p_voucher::text;
  snapshot jsonb; already uuid; baseline jsonb; field text;
BEGIN
  SELECT * INTO STRICT v FROM public.income_expenses WHERE id=p_voucher;
  IF v.type<>'INCOME' OR v.deleted_at IS NOT NULL OR v.approval_status='CANCELLED' OR v.contract_id IS NOT NULL
     OR app_private.reservation_deposit_is_settled_v1(v.id) OR NOT public.ie_has_deposit_item(v.id)
     OR EXISTS (SELECT 1 FROM public.contract_deposit_links WHERE income_expense_id=v.id) THEN RETURN NULL; END IF;
  SELECT * INTO STRICT rm FROM public.rooms WHERE id=v.room_id AND building_id=v.building_id
    AND organization_id=v.organization_id AND deleted_at IS NULL FOR NO KEY UPDATE;
  PERFORM app_private.lock_org_for_decision_v1(rm.organization_id);
  SELECT reservation_id INTO already FROM public.reservation_receipts WHERE source_voucher_id=v.id LIMIT 1;
  IF already IS NOT NULL THEN RETURN already; END IF;
  SELECT r.* INTO h FROM public.room_reservations r JOIN public.room_next_claims c ON c.reservation_id=r.id
    WHERE c.organization_id=rm.organization_id AND c.room_id=rm.id AND c.status='LIVE' AND r.status='HOLD' FOR UPDATE OF c,r;
  existing:=h.id;
  IF p_terms ? 'expected_hold' AND NULLIF(p_terms->>'expected_hold','')::uuid IS DISTINCT FROM existing THEN
    RAISE EXCEPTION 'Đợt giữ chỗ của phòng đã đổi. Tải lại và chọn đúng lượt thu.' USING ERRCODE='PT409';
  END IF;
  IF p_terms ? 'expected_revision' AND (p_terms->>'expected_revision')::bigint IS DISTINCT FROM h.revision THEN
    SELECT response INTO baseline FROM app_private.room_reservation_history
      WHERE reservation_id=h.id AND revision=(p_terms->>'expected_revision')::bigint;
    IF baseline IS NULL OR NOT (p_terms ? 'expected_hold') THEN
      RAISE EXCEPTION 'Hồ sơ giữ chỗ đã thay đổi. Tải lại trước khi bổ sung.' USING ERRCODE='PT409';
    END IF;
    -- Old tabs send the entire displayed schedule. Ignore unchanged fields and preserve newer dates.
    FOREACH field IN ARRAY ARRAY['hold_until','intended_move_in_on','topup_due_on','deposit_target'] LOOP
      IF p_terms ? field THEN
        IF (p_terms->field) IS DISTINCT FROM (baseline->field) THEN
          RAISE EXCEPTION 'Lịch hoặc mức cọc đã thay đổi. Tải lại trước khi sửa.' USING ERRCODE='PT409';
        END IF;
        p_terms:=p_terms-field;
      END IF;
    END LOOP;
  END IF;
  move_in:=CASE WHEN p_terms?'intended_move_in_on' THEN NULLIF(p_terms->>'intended_move_in_on','')::date ELSE h.intended_move_in_on END;
  IF existing IS NULL OR move_in IS DISTINCT FROM h.intended_move_in_on THEN
    IF EXISTS(SELECT 1 FROM public.contracts c WHERE c.organization_id=rm.organization_id AND c.room_id=rm.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED')) THEN
      IF move_in IS NULL OR rm.status NOT IN ('AVAILABLE','RESERVED','OCCUPIED')
        OR (SELECT count(*) FROM public.contracts c WHERE c.organization_id=rm.organization_id AND c.room_id=rm.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED'))<>1
        OR EXISTS(SELECT 1 FROM public.contracts c WHERE c.organization_id=rm.organization_id AND c.room_id=rm.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED')
          AND (c.expected_move_out_date IS NULL OR c.actual_end_date IS NOT NULL OR move_in<c.expected_move_out_date)) THEN
        RAISE EXCEPTION 'Phòng đang thuê. Chọn hợp đồng hiện tại hoặc ngày vào của lượt thuê kế tiếp sau ngày báo trả.' USING ERRCODE='PT409';
      END IF;
    ELSIF rm.status NOT IN ('AVAILABLE','RESERVED') THEN RAISE EXCEPTION 'Phòng chưa sẵn sàng để giữ chỗ' USING ERRCODE='PT409';
    END IF;
  END IF;
  IF existing IS NULL THEN
    PERFORM app_private.assert_room_reservation_legacy_sources_v1(rm.organization_id,rm.id,coalesce(p_allowed_sources,ARRAY[v.id]));
    INSERT INTO public.room_reservations(organization_id,building_id,room_id,customer_hint,hold_until,intended_move_in_on,topup_due_on,deposit_target,notes,created_by,idempotency_key,payload_hash)
    VALUES(v.organization_id,v.building_id,v.room_id,coalesce(nullif(left(btrim(v.payer_name),120),''),'Chưa ghi người gửi'),
      nullif(p_terms->>'hold_until','')::date,move_in,nullif(p_terms->>'topup_due_on','')::date,
      (p_terms->>'deposit_target')::numeric,p_terms->>'notes',p_actor,key,md5(v.id::text)) RETURNING * INTO h;
    INSERT INTO public.room_next_claims(organization_id,room_id,reservation_id) VALUES(v.organization_id,v.room_id,h.id);
    UPDATE public.room_sale_locks SET released_at=expires_at,release_reason='EXPIRED'
      WHERE organization_id=v.organization_id AND room_id=v.room_id AND released_at IS NULL AND expires_at<=clock_timestamp();
    UPDATE public.room_sale_locks SET released_at=clock_timestamp(),released_by=p_actor,release_reason='RESERVED',reservation_id=h.id
      WHERE organization_id=v.organization_id AND room_id=v.room_id AND released_at IS NULL;
  ELSE
    UPDATE public.room_reservations SET revision=revision+1,updated_at=clock_timestamp(),
      intended_move_in_on=move_in,
      hold_until=CASE WHEN p_terms?'hold_until' THEN nullif(p_terms->>'hold_until','')::date ELSE hold_until END,
      topup_due_on=CASE WHEN p_terms?'topup_due_on' THEN nullif(p_terms->>'topup_due_on','')::date ELSE topup_due_on END,
      deposit_target=CASE WHEN p_terms?'deposit_target' THEN (p_terms->>'deposit_target')::numeric ELSE deposit_target END
      WHERE id=h.id RETURNING * INTO h;
  END IF;
  IF NOT COALESCE(((app_private.reservation_settlement_basis_v1(v.id)->>'amount')::numeric>0),false)
     OR COALESCE((app_private.reservation_settlement_basis_v1(v.id)->>'mismatch')::boolean,true) THEN
    RAISE EXCEPTION 'Phiếu % thiếu dòng cọc hợp lệ',v.code USING ERRCODE='22023';
  END IF;
  INSERT INTO public.reservation_receipts(organization_id,reservation_id,customer_id,source_voucher_id,source_item_id,created_by)
    SELECT v.organization_id,h.id,h.customer_id,v.id,i.id,p_actor FROM public.income_expense_items i
      JOIN public.income_expense_types t ON t.id=i.income_expense_type_id AND t.organization_id=v.organization_id
      WHERE i.income_expense_id=v.id AND i.organization_id=v.organization_id AND t.is_deposit AND i.accounting_class='DEPOSIT';
  IF NOT FOUND THEN RAISE EXCEPTION 'Phiếu % chưa có dòng tiền cọc',v.code USING ERRCODE='22023'; END IF;
  snapshot:=app_private.room_reservation_response_v1(h.id);
  INSERT INTO app_private.room_reservation_history(reservation_id,revision,action,actor_id,idempotency_key,payload_hash,response)
    VALUES(h.id,h.revision,CASE WHEN existing IS NULL THEN 'CREATE' ELSE 'TOPUP' END,p_actor,key,md5(v.id::text),snapshot);
  IF existing IS NULL THEN UPDATE public.room_reservations SET initial_response=app_private.room_reservation_response_v1(h.id) WHERE id=h.id; END IF;
  RETURN h.id;
END $fn$;
REVOKE ALL ON FUNCTION app_private.attach_deposit_income_v1(uuid,jsonb,uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.write_deposit_income_v1(p_organization_id uuid,p_request_key text,p_row jsonb,p_items jsonb,p_terms jsonb,p_legacy_hold uuid,p_cash_owner uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE
  actor uuid:=auth.uid(); rm public.rooms%ROWTYPE; req app_private.deposit_income_requests%ROWTYPE;
  basis text:=md5(jsonb_build_array(p_row,p_items,p_terms)::text); items jsonb:=p_items;
  category uuid; ie public.income_expenses%ROWTYPE; receipt jsonb; terms jsonb:=coalesce(p_terms,'{}');
  compat boolean; err text; args jsonb; hold uuid; display jsonb; item jsonb; amount numeric;
  day date:=(p_row->>'voucher_date')::date; book uuid:=(p_row->>'account_id')::uuid;
  ct uuid:=(p_row->>'contract_id')::uuid; payer text:=nullif(btrim(p_row->>'payer_name'),'');
BEGIN
  IF actor IS NULL OR p_organization_id IS NULL OR NOT coalesce(p_organization_id=ANY(public.my_org_ids()),false)
    OR (public.is_super_admin() AND coalesce(p_organization_id=ANY(public.sandbox_org_ids()),false)) THEN
    RAISE EXCEPTION 'Chưa chọn tổ chức được phép' USING ERRCODE='42501'; END IF;
  IF p_request_key IS NULL OR p_request_key !~ '^[A-Za-z0-9._:-]{8,200}$' OR jsonb_typeof(p_row) IS DISTINCT FROM 'object'
    OR jsonb_typeof(items) IS DISTINCT FROM 'array' OR jsonb_typeof(terms) IS DISTINCT FROM 'object'
    OR (p_row->>'type') IS DISTINCT FROM 'INCOME' OR day IS NULL OR coalesce(p_row->>'name','')=''
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(terms) k WHERE k NOT IN ('expected_hold','expected_revision','hold_until','intended_move_in_on','topup_due_on','deposit_target','notes','channel'))
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_row) k WHERE k NOT IN ('id','type','name','room_id','building_id','contract_id','tenant_id','payer_name','account_id','voucher_date','attachments','notes','amount','description','receive_bank_account','receive_bank_name','business_result_accounting','repeat_cycle','repeat_count','repeat_infinity','repeat_auto_approve','repeat_remaining','repeat_next_date','batch_child'))
    THEN RAISE EXCEPTION 'Dữ liệu phiếu thu cọc không hợp lệ' USING ERRCODE='22023'; END IF;
  SELECT * INTO rm FROM public.rooms WHERE id=(p_row->>'room_id')::uuid AND organization_id=p_organization_id AND deleted_at IS NULL FOR NO KEY UPDATE;
  IF NOT FOUND OR ((p_row->>'building_id') IS NOT NULL AND (p_row->>'building_id')::uuid IS DISTINCT FROM rm.building_id) THEN
    RAISE EXCEPTION 'Phòng không thuộc tòa hoặc tổ chức đã chọn' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  IF coalesce(terms->>'channel','finance') IN ('reservation','sale') THEN
    PERFORM app_private.authorize_room_reservation_writer_v1(p_organization_id,rm.building_id,'deposits.create');
  END IF;
  IF coalesce(terms->>'channel','finance') NOT IN ('finance','reservation','sale') OR
     ((p_row->>'tenant_id') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tenants WHERE id=(p_row->>'tenant_id')::uuid AND organization_id=p_organization_id AND deleted_at IS NULL)) THEN
    RAISE EXCEPTION 'Thông tin người nộp hoặc kênh thu không hợp lệ' USING ERRCODE='42501'; END IF;
  IF p_request_key LIKE 'lead-income-%' THEN
    IF NOT EXISTS(SELECT 1 FROM public.leads l WHERE l.id=substring(p_request_key FROM 13)::uuid
       AND l.organization_id=p_organization_id AND l.deleted_at IS NULL
       AND (l.building_id IS NULL OR l.building_id=rm.building_id)
       AND coalesce(public.can_do_on_building('leads','convert',coalesce(l.building_id,rm.building_id)),false)) THEN
      RAISE EXCEPTION 'Không thể chuyển khách hẹn tại tòa này' USING ERRCODE='42501';
    END IF;
  END IF;
  IF ct IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=ct AND c.organization_id=p_organization_id AND c.room_id=rm.id AND c.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Hợp đồng không khớp với phòng' USING ERRCODE='42501'; END IF;
  IF book IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=book AND a.organization_id=p_organization_id AND a.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Sổ quỹ không thuộc tổ chức' USING ERRCODE='42501'; END IF;
  INSERT INTO app_private.deposit_income_requests(organization_id,actor_id,request_key,input_hash) VALUES(p_organization_id,actor,p_request_key,basis)
    ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM app_private.deposit_income_requests WHERE organization_id=p_organization_id AND actor_id=actor AND request_key=p_request_key) THEN
    RAISE EXCEPTION 'Đã có phiếu cho khách hẹn này. Mở lại để đối chiếu.' USING ERRCODE='PT409';
  END IF;
  SELECT * INTO STRICT req FROM app_private.deposit_income_requests WHERE organization_id=p_organization_id AND actor_id=actor AND request_key=p_request_key FOR UPDATE;
  IF req.input_hash<>basis THEN RAISE EXCEPTION 'Mã yêu cầu đã dùng cho nội dung khác' USING ERRCODE='PT409'; END IF;
  IF req.voucher_id IS NOT NULL THEN
    IF NOT coalesce(app_private.ie_supplement_can_read_v1(req.voucher_id),false) THEN RAISE EXCEPTION 'Không có quyền đọc phiếu đã tạo' USING ERRCODE='42501'; END IF;
    SELECT * INTO STRICT ie FROM public.income_expenses WHERE id=req.voucher_id AND organization_id=p_organization_id;
    hold:=req.reservation_id;
  ELSE
    IF p_legacy_hold IS NULL AND ct IS NULL AND terms->>'channel' IN ('sale','reservation')
       AND EXISTS (SELECT 1 FROM public.room_reservations r WHERE r.organization_id=p_organization_id AND r.created_by=actor AND r.idempotency_key=p_request_key) THEN
      RAISE EXCEPTION 'Đã ghi giữ chỗ bằng mã yêu cầu này. Mở lại phiếu đã lưu để đối chiếu.' USING ERRCODE='PT409';
    END IF;
    IF jsonb_array_length(items)=0 THEN
      SELECT id INTO category FROM public.income_expense_types WHERE organization_id=p_organization_id AND lower(type)='income' AND is_deposit ORDER BY id LIMIT 1;
      amount:=(p_row->>'amount')::numeric;
      IF category IS NULL OR amount IS NULL OR amount<=0 OR amount<>trunc(amount) THEN RAISE EXCEPTION 'Chọn hạng mục và nhập tiền cọc dương' USING ERRCODE='22023'; END IF;
      items:=jsonb_build_array(jsonb_build_object('income_expense_type_id',category,'description',p_row->>'description','quantity',1,'unit_price',amount,'start_date',day,'end_date',day));
    END IF;
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(items) j JOIN public.income_expense_types t ON t.id=(j->>'income_expense_type_id')::uuid WHERE t.organization_id=p_organization_id AND t.is_deposit AND lower(t.type)='income')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(items) j WHERE NOT EXISTS(SELECT 1 FROM public.income_expense_types t WHERE t.id=(j->>'income_expense_type_id')::uuid AND t.organization_id=p_organization_id AND lower(t.type)='income'))
      THEN RAISE EXCEPTION 'Hạng mục thu cọc không thuộc tổ chức' USING ERRCODE='42501'; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(items) LOOP
      IF jsonb_typeof(item)<>'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(item) k WHERE k NOT IN
          ('income_expense_type_id','description','quantity','unit_price','start_date','end_date','accounting_class'))
        OR coalesce((item->>'quantity')::numeric,0)<=0 OR coalesce((item->>'unit_price')::numeric,-1)<0
        OR (item->>'quantity')::numeric * (item->>'unit_price')::numeric > 9007199254740991 THEN
        RAISE EXCEPTION 'Kiểm tra hạng mục, số lượng và đơn giá của từng dòng phiếu.' USING ERRCODE='22023';
      END IF;
    END LOOP;
    SELECT jsonb_agg(j.value-'accounting_class' ORDER BY j.n) INTO items FROM jsonb_array_elements(items) WITH ORDINALITY j(value,n);
    compat:=coalesce((p_row->>'batch_child')::boolean,false) OR coalesce(p_row->>'repeat_cycle','NONE')<>'NONE'
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(items) j WHERE j->>'start_date' IS NULL OR j->>'end_date' IS NULL)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(p_row->'attachments','[]')) a WHERE a !~ '^https://');
    IF p_cash_owner IS NOT NULL THEN
      -- Collection at signing retains its system origin and posting/approval semantics.
      IF ct IS NULL OR book IS NULL OR NOT coalesce((SELECT allowed FROM app_private.authorize_tenant_action_v3(actor,p_organization_id,'thu_tien.collect',rm.building_id,book)),false) THEN
        RAISE EXCEPTION 'Không có quyền ghi tiền cọc khi ký' USING ERRCODE='42501'; END IF;
      amount:=(p_row->>'amount')::numeric;
      INSERT INTO public.income_expenses(user_id,organization_id,type,name,building_id,room_id,contract_id,account_id,voucher_date,total_amount,approval_status,approved_by,approved_at,attachments,creator_name,system_source,idempotency_key,payer_name)
        VALUES(p_cash_owner,p_organization_id,'INCOME',p_row->>'name',rm.building_id,rm.id,ct,book,day,amount,'APPROVED',actor,clock_timestamp(),coalesce(p_row->'attachments','[]'),terms->>'notes','contract.create.v2',p_request_key,payer) RETURNING * INTO ie;
      INSERT INTO public.income_expense_items(income_expense_id,organization_id,income_expense_type_id,description,quantity,unit_price,amount,start_date,end_date,accounting_class)
        VALUES(ie.id,p_organization_id,(items->0->>'income_expense_type_id')::uuid,p_row->>'description',1,amount,amount,day,day,'DEPOSIT');
      compat:=false;
    ELSIF NOT compat THEN
      BEGIN
        ie:=public.create_income_expense_v1('INCOME',p_row->>'name',rm.building_id,rm.id,(p_row->>'tenant_id')::uuid,ct,payer,
          p_row->>'receive_bank_account',p_row->>'receive_bank_name',book,coalesce(p_row->'attachments','[]'),
          (p_row->>'business_result_accounting')::boolean,p_row->>'notes',day,items,p_request_key);
      EXCEPTION WHEN SQLSTATE '0A000' OR SQLSTATE '42501' OR SQLSTATE '55000' THEN
        GET STACKED DIAGNOSTICS err=MESSAGE_TEXT;
        IF SQLSTATE='0A000' OR (SQLSTATE='42501' AND (
          err='Không có quyền tạo phiếu thu/chi cho toà này'
          OR err ~ '(Không có quyền sử dụng sổ quỹ này|Quyền sử dụng sổ quỹ đã bị thu hồi)'))
         OR (SQLSTATE='55000' AND err LIKE '%chưa bật%') THEN compat:=true; ELSE RAISE; END IF;
      END;
    END IF;
    IF compat THEN
      -- Legacy holders and current tenant-role grants must both address the selected building.
      -- The financial writer independently verifies actual custody/receive-only possession of the book.
      IF NOT coalesce(public.can_access_building(rm.building_id),false) OR NOT (
        coalesce(app_private.authorize_collaborative_income_expense_v1(actor,p_organization_id,'create',rm.building_id),false)
        OR coalesce((SELECT allowed FROM app_private.authorize_tenant_action_v3(
          actor,p_organization_id,'income_expenses.create',rm.building_id,book)),false)
      ) THEN RAISE EXCEPTION 'Không có quyền tạo phiếu thu/chi cho toà này' USING ERRCODE='42501'; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(items) j JOIN public.income_expense_types t
          ON t.id=(j->>'income_expense_type_id')::uuid WHERE t.system_only OR (t.is_restricted
          AND NOT coalesce(app_private.authorize_collaborative_income_expense_v1(actor,p_organization_id,'restricted_create',rm.building_id),false)
          AND NOT coalesce((SELECT allowed FROM app_private.authorize_tenant_action_v3(
            actor,p_organization_id,'income_expenses.restricted_create',rm.building_id,book)),false)))
      THEN RAISE EXCEPTION 'Không có quyền lập phiếu tay cho hạng mục này' USING ERRCODE='42501'; END IF;
      SELECT jsonb_agg(j.value||jsonb_build_object('accounting_class',CASE WHEN t.is_deposit THEN 'DEPOSIT' ELSE 'PNL' END) ORDER BY j.n)
        INTO args FROM jsonb_array_elements(items) WITH ORDINALITY j(value,n) JOIN public.income_expense_types t ON t.id=(j.value->>'income_expense_type_id')::uuid;
      receipt:=public.ie_compat_insert_v2(jsonb_strip_nulls(jsonb_build_object(
        'type','INCOME','name',p_row->>'name','id',p_row->>'id','organization_id',p_organization_id,
        'building_id',rm.building_id,'room_id',rm.id,'contract_id',ct,'tenant_id',p_row->>'tenant_id',
        'payer_name',payer,'account_id',book,'voucher_date',day,'attachments',p_row->'attachments',
        'notes',p_row->>'notes','receive_bank_name',p_row->>'receive_bank_name',
        'receive_bank_account',p_row->>'receive_bank_account','business_result_accounting',p_row->'business_result_accounting',
        'repeat_cycle',p_row->>'repeat_cycle','repeat_count',p_row->'repeat_count','repeat_infinity',p_row->'repeat_infinity',
        'repeat_auto_approve',p_row->'repeat_auto_approve','repeat_remaining',p_row->'repeat_remaining',
        'repeat_next_date',p_row->>'repeat_next_date')),args);
      SELECT * INTO STRICT ie FROM public.income_expenses WHERE id=(receipt->>'id')::uuid AND organization_id=p_organization_id;
    END IF;
    IF ie.id IS NULL OR ie.organization_id IS DISTINCT FROM p_organization_id OR ie.room_id IS DISTINCT FROM rm.id OR ie.contract_id IS DISTINCT FROM ct THEN
      RAISE EXCEPTION 'Chưa xác nhận được đích của phiếu thu cọc' USING ERRCODE='PT409'; END IF;
    IF p_legacy_hold IS NOT NULL THEN
      -- The enclosing historical RPC already owns the revision, history and claim.
      PERFORM app_private.bind_reservation_source_voucher_v1(p_legacy_hold,ie.id);
      hold:=p_legacy_hold;
    ELSIF ct IS NULL THEN
      hold:=app_private.attach_deposit_income_v1(ie.id,terms,actor);
    END IF;
    UPDATE app_private.deposit_income_requests SET voucher_id=ie.id,reservation_id=hold WHERE organization_id=p_organization_id AND actor_id=actor AND request_key=p_request_key;
  END IF;
  IF hold IS NOT NULL AND coalesce(terms->>'channel','finance') IN ('reservation','sale') THEN
    PERFORM app_private.authorize_room_reservation_writer_v1(p_organization_id,rm.building_id,'deposits.create');
    display:=app_private.room_reservation_response_v1(hold);
    IF NOT coalesce(public.can_do_on_building('deposits','view',rm.building_id),false) THEN
      display:=display||jsonb_build_object('customer_id',NULL,'customer_phone',NULL,'customer_name',coalesce(payer,''),
        'customer_hint',payer,'notes',NULL,'history','[]'::jsonb,
        'received_amount',coalesce((SELECT sum((p->>'amount')::numeric) FROM jsonb_array_elements(display->'receipts') p
          WHERE p->>'source_voucher_id'=ie.id::text AND (p->>'received')::boolean),0),
        'receipts',coalesce((SELECT jsonb_agg(p) FROM jsonb_array_elements(display->'receipts') p WHERE p->>'source_voucher_id'=ie.id::text),'[]'::jsonb),
        'source_voucher_ids',coalesce((SELECT jsonb_agg(p) FROM jsonb_array_elements(display->'source_voucher_ids') p WHERE p#>>'{}'=ie.id::text),'[]'::jsonb));
    END IF;
  END IF;
  RETURN jsonb_build_object('id',ie.id,'code',ie.code,'approval_status',ie.approval_status,'reservation_id',hold,'reservation',display);
END $fn$;
REVOKE ALL ON FUNCTION app_private.write_deposit_income_v1(uuid,text,jsonb,jsonb,jsonb,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.create_deposit_income_v1(p_organization_id uuid,p_request_key text,p_row jsonb,p_items jsonb,p_terms jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $fn$
  SELECT app_private.write_deposit_income_v1(p_organization_id,p_request_key,p_row,p_items,p_terms,NULL)
$fn$;
REVOKE ALL ON FUNCTION public.create_deposit_income_v1(uuid,text,jsonb,jsonb,jsonb) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.create_deposit_income_v1(uuid,text,jsonb,jsonb,jsonb) TO authenticated;

-- Cancel and sign both acquire the room before locking a source voucher.
DO $cancel_lock$
DECLARE target regprocedure:='public.cancel_income_voucher_v1(uuid,text)'::regprocedure;
 body text:=pg_get_functiondef(target);
 marker text:='SELECT * INTO v FROM public.income_expenses';
 prelock text:=$sql$PERFORM 1 FROM public.rooms rm JOIN public.income_expenses source
      ON rm.id=source.room_id AND rm.organization_id=source.organization_id
      WHERE source.id=p_voucher AND source.contract_id IS NULL AND source.type='INCOME'
        AND source.deleted_at IS NULL AND source.organization_id=ANY(public.my_org_ids())
        AND public.ie_has_deposit_item(source.id)
      FOR NO KEY UPDATE OF rm;
  IF FOUND THEN
    PERFORM app_private.lock_org_for_decision_v1(source.organization_id) FROM public.income_expenses source WHERE source.id=p_voucher;
  END IF;

  $sql$;
BEGIN
 IF position(prelock in body)>0 THEN RETURN; END IF;
 IF (length(body)-length(replace(body,marker,'')))<>length(marker) THEN RAISE EXCEPTION 'Unexpected cancellation lock precondition'; END IF;
 EXECUTE replace(body,marker,prelock||marker);
END $cancel_lock$;

-- Release only a paid reservation whose whole set of original sources is now inactive.
CREATE OR REPLACE FUNCTION app_private.close_empty_deposit_reservation_v1(p_hold uuid,p_actor uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE h public.room_reservations%ROWTYPE;
BEGIN
  SELECT * INTO h FROM public.room_reservations WHERE id=p_hold;
  IF NOT FOUND OR h.status<>'HOLD' THEN RETURN false; END IF;
  BEGIN
    PERFORM 1 FROM public.rooms WHERE id=h.room_id AND organization_id=h.organization_id FOR NO KEY UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'Phòng đang được xử lý. Tải lại phiếu cọc trước khi tiếp tục.' USING ERRCODE='PT409';
  END;
  PERFORM app_private.lock_org_for_decision_v1(h.organization_id);
  SELECT * INTO h FROM public.room_reservations WHERE id=p_hold AND status='HOLD' FOR UPDATE;
  IF NOT FOUND OR coalesce(jsonb_array_length(h.initial_response->'receipts'),0)=0
    OR NOT EXISTS(SELECT 1 FROM public.reservation_receipts rr WHERE rr.reservation_id=h.id)
    OR EXISTS(SELECT 1 FROM public.reservation_receipts rr JOIN public.income_expenses ie ON ie.id=rr.source_voucher_id
       WHERE rr.reservation_id=h.id AND ie.deleted_at IS NULL AND ie.approval_status IS DISTINCT FROM 'CANCELLED'
       AND NOT app_private.reservation_deposit_is_settled_v1(ie.id)) THEN RETURN false; END IF;
  UPDATE public.room_next_claims SET status='CANCELLED',updated_at=clock_timestamp() WHERE reservation_id=h.id AND status='LIVE';
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.room_reservations SET status='CANCELLED',revision=revision+1,updated_at=clock_timestamp() WHERE id=h.id RETURNING * INTO h;
  INSERT INTO app_private.room_reservation_history(reservation_id,revision,action,actor_id,idempotency_key,payload_hash,response)
    VALUES(h.id,h.revision,'CANCEL',coalesce(p_actor,h.created_by),'source-closed-'||h.revision,md5(h.id::text||h.revision::text),app_private.room_reservation_response_v1(h.id));
  RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION app_private.close_empty_deposit_reservation_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.release_cancelled_deposit_income_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE h uuid;
BEGIN
  FOR h IN SELECT DISTINCT rr.reservation_id FROM public.reservation_receipts rr WHERE rr.source_voucher_id=NEW.id LOOP
    PERFORM app_private.close_empty_deposit_reservation_v1(h,auth.uid());
  END LOOP;
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION app_private.release_cancelled_deposit_income_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS release_cancelled_deposit_income ON public.income_expenses;
CREATE TRIGGER release_cancelled_deposit_income AFTER UPDATE OF approval_status,deleted_at ON public.income_expenses
  FOR EACH ROW WHEN ((NEW.approval_status='CANCELLED' AND OLD.approval_status IS DISTINCT FROM NEW.approval_status)
    OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)) EXECUTE FUNCTION app_private.release_cancelled_deposit_income_v1();

-- Compatibility with open tabs, finance import, recurring receipts and Hermes.
-- End-of-transaction inspection lets existing receipt binders finish first.
CREATE OR REPLACE FUNCTION app_private.bind_unlinked_deposit_income_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v public.income_expenses%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.income_expenses WHERE id=NEW.income_expense_id;
  IF v.id IS NULL OR v.system_source IS NOT NULL OR v.type<>'INCOME' OR v.deleted_at IS NOT NULL OR v.contract_id IS NOT NULL
     OR v.approval_status='CANCELLED' OR NOT public.ie_has_deposit_item(v.id)
     OR NOT EXISTS(SELECT 1 FROM public.income_expense_items i WHERE i.id=NEW.id AND i.accounting_class='DEPOSIT')
     OR EXISTS(SELECT 1 FROM public.reservation_receipts rr WHERE rr.source_voucher_id=v.id)
     OR EXISTS(SELECT 1 FROM public.deposit_management_exclusions ex WHERE ex.voucher_id=v.id) THEN RETURN NULL; END IF;
  PERFORM app_private.attach_deposit_income_v1(v.id,'{}'::jsonb,coalesce(auth.uid(),v.user_id));
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION app_private.bind_unlinked_deposit_income_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS bind_unlinked_deposit_income ON public.income_expense_items;
CREATE CONSTRAINT TRIGGER bind_unlinked_deposit_income AFTER INSERT OR UPDATE ON public.income_expense_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.accounting_class='DEPOSIT') EXECUTE FUNCTION app_private.bind_unlinked_deposit_income_v1();

-- Date reminders may extend beyond hold_until; retain all other validations.
DO $patch$
DECLARE f regprocedure:='public.set_reservation_hold_terms_v1(uuid,date,date,numeric)'::regprocedure; body text;
BEGIN
  body:=pg_get_functiondef(f);
  IF position('OR (p_hold_until IS NOT NULL AND p_topup_due_date>p_hold_until)' IN body)>0 THEN
    EXECUTE replace(body,'OR (p_hold_until IS NOT NULL AND p_topup_due_date>p_hold_until)','');
  END IF;
END $patch$;

-- Migrate metadata only. Never group separate historical receipts by payer name.
DO $backfill$
DECLARE h record; batch record; allowed uuid[]; source uuid; actor uuid; found_hold uuid; terms jsonb;
BEGIN
  FOR h IN SELECT id,created_by FROM public.room_reservations WHERE status='HOLD'
    AND jsonb_array_length(coalesce(initial_response->'receipts','[]'))>0 ORDER BY organization_id,room_id LOOP
    PERFORM app_private.close_empty_deposit_reservation_v1(h.id,h.created_by);
  END LOOP;
  FOR batch IN
    SELECT v.organization_id,v.room_id,rm.name AS room_name,b.name AS building_name,
      min(v.voucher_date) first_day, min(v.created_at) first_created,
      array_agg(v.id ORDER BY v.voucher_date,v.created_at,v.id) ids,array_agg(v.code ORDER BY v.code) codes
    FROM public.income_expenses v JOIN public.rooms rm ON rm.id=v.room_id AND rm.organization_id=v.organization_id AND rm.deleted_at IS NULL
    JOIN public.buildings b ON b.id=rm.building_id AND b.id=v.building_id AND b.deleted_at IS NULL
    WHERE v.deleted_at IS NULL AND v.system_source IS NULL AND v.type='INCOME' AND v.contract_id IS NULL AND v.approval_status IS DISTINCT FROM 'CANCELLED'
      AND rm.status IN ('AVAILABLE','RESERVED') AND public.ie_has_deposit_item(v.id)
      AND NOT app_private.reservation_deposit_is_settled_v1(v.id)
      AND NOT EXISTS(SELECT 1 FROM public.reservation_receipts rr WHERE rr.source_voucher_id=v.id)
      AND NOT EXISTS(SELECT 1 FROM public.deposit_management_exclusions ex WHERE ex.voucher_id=v.id)
      AND NOT EXISTS(SELECT 1 FROM public.contract_deposit_links l WHERE l.income_expense_id=v.id)
      AND NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.room_id=rm.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED'))
      AND NOT EXISTS(SELECT 1 FROM public.room_next_claims c WHERE c.room_id=rm.id AND c.status='LIVE')
      AND (v.approval_status='UNAPPROVED' OR coalesce((app_private.reservation_settlement_basis_v1(v.id)->>'received')::boolean,false))
      AND NOT coalesce((app_private.reservation_settlement_basis_v1(v.id)->>'mismatch')::boolean,true)
    GROUP BY v.organization_id,v.room_id,rm.name,b.name ORDER BY v.organization_id,v.room_id
  LOOP
    PERFORM 1 FROM public.rooms WHERE id=batch.room_id AND organization_id=batch.organization_id
      AND status IN ('AVAILABLE','RESERVED') AND deleted_at IS NULL FOR NO KEY UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    PERFORM app_private.lock_org_for_decision_v1(batch.organization_id);
    IF EXISTS(SELECT 1 FROM public.room_sale_locks x WHERE x.room_id=batch.room_id AND x.organization_id=batch.organization_id
        AND x.released_at IS NULL AND x.expires_at>clock_timestamp())
      OR EXISTS(SELECT 1 FROM public.room_next_claims x WHERE x.room_id=batch.room_id AND x.status='LIVE')
      OR EXISTS(SELECT 1 FROM public.contracts x WHERE x.room_id=batch.room_id AND x.deleted_at IS NULL AND x.status<>'DRAFT'
          AND (x.status IN ('ACTIVE','EXTENDED') OR greatest(x.start_date,coalesce(x.actual_end_date,
              (SELECT ct.actual_move_out_date FROM public.contract_terminations ct WHERE ct.contract_id=x.id AND ct.status='COMPLETED'),
              x.end_date))>=batch.first_day))
      OR EXISTS(SELECT 1 FROM public.room_reservations x WHERE x.room_id=batch.room_id AND x.created_at>=batch.first_created)
      THEN CONTINUE; END IF;
    IF cardinality(batch.ids)<>1 AND NOT (batch.room_name='05' AND batch.building_name='481NVK'
      AND batch.codes::text[]=ARRAY['PT2611447','PT2611448']::text[] AND EXISTS (
        SELECT 1 FROM public.income_expenses old JOIN public.reservation_receipts rr ON rr.source_voucher_id=old.id
        JOIN public.room_reservations r ON r.id=rr.reservation_id
        WHERE old.organization_id=batch.organization_id AND old.room_id=batch.room_id AND old.code='PT2611428'
          AND old.approval_status='CANCELLED' AND r.status='CANCELLED')) THEN CONTINUE; END IF;
    allowed:=batch.ids;found_hold:=NULL;
    BEGIN
      PERFORM app_private.assert_room_reservation_legacy_sources_v1(batch.organization_id,batch.room_id,allowed);
    EXCEPTION WHEN SQLSTATE '55000' THEN CONTINUE; END;
    FOREACH source IN ARRAY allowed LOOP
      SELECT user_id INTO STRICT actor FROM public.income_expenses WHERE id=source;
      SELECT jsonb_strip_nulls(jsonb_build_object('hold_until',hold_until,'topup_due_on',topup_due_date,'deposit_target',deposit_target))
        INTO terms FROM public.reservation_hold_deadlines WHERE income_expense_id=source;
      found_hold:=app_private.attach_deposit_income_v1(source,coalesce(terms,'{}')||jsonb_build_object('expected_hold',found_hold),actor,allowed);
    END LOOP;
  END LOOP;
END $backfill$;

CREATE OR REPLACE FUNCTION public.get_deposit_income_hold_v1(p_organization_id uuid,p_room_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE building uuid; result jsonb;
BEGIN
  SELECT building_id INTO building FROM public.rooms WHERE id=p_room_id AND organization_id=p_organization_id AND deleted_at IS NULL;
  IF building IS NULL OR auth.uid() IS NULL OR NOT coalesce(p_organization_id=ANY(public.my_org_ids()),false)
    OR (public.is_super_admin() AND coalesce(p_organization_id=ANY(public.sandbox_org_ids()),false))
    OR NOT coalesce(public.can_access_building(building),false)
    OR NOT (coalesce(public.can_do_on_building('income_expenses','create',building),false) OR coalesce(public.can_do_on_building('deposits','create',building),false)) THEN
    RAISE EXCEPTION 'Không có quyền nhận cọc tại phòng này' USING ERRCODE='42501'; END IF;
  SELECT jsonb_build_object('id',h.id,'revision',h.revision,'payer',h.customer_hint,'hold_until',h.hold_until,
    'intended_move_in_on',h.intended_move_in_on,'topup_due_on',h.topup_due_on,'deposit_target',h.deposit_target,
    'received_amount',CASE WHEN coalesce(public.can_do_on_building('deposits','view',building),false) THEN
      (SELECT coalesce(sum(p.amount),0) FROM app_private.reservation_receipt_projection_v1(h.id) p WHERE p.received AND NOT p.released) END)
    INTO result FROM public.room_reservations h JOIN public.room_next_claims c ON c.reservation_id=h.id
    WHERE h.room_id=p_room_id AND h.organization_id=p_organization_id AND c.status='LIVE' AND h.status='HOLD';
  RETURN jsonb_build_object('hold',result);
END $fn$;
REVOKE ALL ON FUNCTION public.get_deposit_income_hold_v1(uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.get_deposit_income_hold_v1(uuid,uuid) TO authenticated;

-- Historical/Hermes requests keep their original replay, claim and revision.
CREATE OR REPLACE FUNCTION app_private.create_reservation_source_receipt_v1(p_reservation uuid,p_receipt jsonb,p_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE h public.room_reservations%ROWTYPE; payer text; result jsonb;
BEGIN
  IF jsonb_typeof(p_receipt) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_receipt) k
    WHERE k NOT IN ('amount','account_id','voucher_date','name','description','attachments'))
    OR jsonb_typeof(p_receipt->'amount') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'Thông tin phiếu thu cọc không hợp lệ' USING ERRCODE='22023';
  END IF;
  SELECT * INTO STRICT h FROM public.room_reservations WHERE id=p_reservation;
  SELECT full_name INTO payer FROM public.customers WHERE id=h.customer_id AND organization_id=h.organization_id;
  result:=app_private.write_deposit_income_v1(h.organization_id,p_key,p_receipt||jsonb_build_object(
    'type','INCOME','name',coalesce(nullif(btrim(p_receipt->>'name'),''),'Cọc giữ chỗ'),'room_id',h.room_id,
    'building_id',h.building_id,'payer_name',coalesce(h.customer_hint,payer)),'[]','{"channel":"reservation"}',h.id);
  RETURN (result->>'id')::uuid;
END $fn$;
REVOKE ALL ON FUNCTION app_private.create_reservation_source_receipt_v1(uuid,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

DO $projection$
DECLARE f regprocedure:='app_private.room_reservation_response_v1(uuid)'::regprocedure; body text:=pg_get_functiondef(f);
BEGIN
  IF position('jsonb_agg(to_jsonb(p) ORDER BY' IN body)>0 THEN
    EXECUTE replace(body,'jsonb_agg(to_jsonb(p) ORDER BY',
      'jsonb_agg((to_jsonb(p)||jsonb_build_object(''payer_name'',(SELECT ie.payer_name FROM public.income_expenses ie WHERE ie.id=p.source_voucher_id))) ORDER BY');
  ELSIF position('ie.payer_name FROM public.income_expenses ie' IN body)=0 THEN
    RAISE EXCEPTION 'Unexpected reservation receipt projection';
  END IF;
END $projection$;

-- Resolve an interrupted browser request by its exact actor-scoped key.
CREATE OR REPLACE FUNCTION public.get_own_deposit_income_v1(p_organization_id uuid,p_request_key text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
  SELECT req.voucher_id FROM app_private.deposit_income_requests req
    WHERE req.organization_id=p_organization_id AND req.actor_id=auth.uid() AND req.request_key=p_request_key
      AND p_organization_id=ANY(public.my_org_ids())
      AND NOT (public.is_super_admin() AND p_organization_id=ANY(public.sandbox_org_ids()))
      AND coalesce(app_private.ie_supplement_can_read_v1(req.voucher_id),false)
$fn$;
REVOKE ALL ON FUNCTION public.get_own_deposit_income_v1(uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.get_own_deposit_income_v1(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_lead_deposit_income_v1(p_organization_id uuid,p_lead_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
  SELECT req.voucher_id FROM app_private.deposit_income_requests req
    JOIN public.leads l ON l.id=p_lead_id AND l.organization_id=req.organization_id AND l.deleted_at IS NULL
    JOIN public.income_expenses ie ON ie.id=req.voucher_id AND ie.organization_id=req.organization_id
    WHERE req.request_key='lead-income-'||l.id AND req.organization_id=p_organization_id
      AND p_organization_id=ANY(public.my_org_ids()) AND NOT (public.is_super_admin() AND p_organization_id=ANY(public.sandbox_org_ids()))
      AND coalesce(public.can_do_on_building('leads','convert',coalesce(l.building_id,ie.building_id)),false)
      AND coalesce(app_private.ie_supplement_can_read_v1(req.voucher_id),false)
$fn$;
REVOKE ALL ON FUNCTION public.get_lead_deposit_income_v1(uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.get_lead_deposit_income_v1(uuid,uuid) TO authenticated;

DO $active$
DECLARE target regprocedure; old_body text; new_body text;
BEGIN
  FOREACH target IN ARRAY ARRAY['public.get_held_deposit_summary(uuid[],numeric)'::regprocedure,
      'public.deposit_held_contracts_v1(uuid,numeric,uuid[])'::regprocedure] LOOP
    old_body:=pg_get_functiondef(target);
    new_body:=regexp_replace(old_body,'c[.]status(::text)?[[:space:]]*=[[:space:]]*''ACTIVE''',
      'c.status IN (''ACTIVE'',''EXTENDED'')','i');
    IF new_body<>old_body THEN EXECUTE new_body;
    ELSIF position('c.status IN (''ACTIVE'',''EXTENDED'')' in old_body)=0 THEN
      RAISE EXCEPTION 'Unsupported held-deposit reader %',target;
    END IF;
  END LOOP;
END $active$;

-- Signing still sees unresolved vouchers, with their individual codes for reconciliation.
DO $sign$
DECLARE f regprocedure:='app_private.contract_room_deposit_sources_v1(uuid,uuid,uuid)'::regprocedure;
  body text:=pg_get_functiondef(f);
  marker text:='AND NOT COALESCE((basis.fact->>''mismatch'')::boolean,true)';
BEGIN
  IF position('rr.reservation_id=p_hold AND rr.source_voucher_id=v.id' IN body)=0 THEN
    IF position(marker IN body)=0 THEN RAISE EXCEPTION 'Unexpected contract deposit source definition'; END IF;
    EXECUTE replace(body,marker,marker||'
         AND (EXISTS (SELECT 1 FROM public.reservation_receipts rr WHERE rr.reservation_id=p_hold AND rr.source_voucher_id=v.id)
              OR EXISTS (SELECT 1 FROM public.deposit_management_exclusions ex WHERE ex.voucher_id=v.id AND p_hold IS NULL))');
  END IF;
END $sign$;

DO $cash$
DECLARE f regprocedure:='public.create_contract_v2(jsonb,text)'::regprocedure; body text:=pg_get_functiondef(f);
  prev text:=$old$    INSERT INTO public.income_expenses (
      user_id, organization_id, type, name, building_id, room_id, contract_id,
      account_id, voucher_date, total_amount, approval_status, approved_by,
      approved_at, attachments, business_result_accounting, creator_name,
      system_source, idempotency_key
    ) VALUES (
      v_owner, v_org, 'INCOME',
      'Cọc giữ phòng ' || COALESCE(v_room_name, '') || ' ' || COALESCE(v_building_name, ''),
      v_building_id, v_room_id, v_contract_id, v_account_id,
      COALESCE(NULLIF(v_receipt->>'received_date', '')::date, v_signed_date),
      v_amount, 'APPROVED', v_actor, clock_timestamp(),
      COALESCE(v_receipt->'attachments', '[]'::jsonb), NULL,
      COALESCE(NULLIF(v_receipt->>'creator_name', ''), 'Contract V2'),
      'contract.create.v2', v_key || ':deposit:' || v_idx
    ) RETURNING id INTO v_voucher_id;

    INSERT INTO public.income_expense_items (
      income_expense_id, organization_id, income_expense_type_id, description,
      quantity, unit_price, amount, start_date, end_date, accounting_class
    ) VALUES (
      v_voucher_id, v_org, v_deposit_type_id, 'Tiền cọc hợp đồng',
      1, v_amount, v_amount,
      COALESCE(NULLIF(v_receipt->>'received_date', '')::date, v_signed_date),
      COALESCE(NULLIF(v_receipt->>'received_date', '')::date, v_signed_date),
      'DEPOSIT'
    );
$old$;
  replacement text:=$new$    SELECT (app_private.write_deposit_income_v1(v_org,v_key||':deposit:'||v_idx,
      jsonb_build_object('type','INCOME','name','Cọc giữ phòng '||coalesce(v_room_name,'')||' '||coalesce(v_building_name,''),
        'room_id',v_room_id,'building_id',v_building_id,'contract_id',v_contract_id,'account_id',v_account_id,
        'voucher_date',coalesce(nullif(v_receipt->>'received_date','')::date,v_signed_date),'amount',v_amount,
        'description','Tiền cọc hợp đồng','attachments',coalesce(v_receipt->'attachments','[]'::jsonb)),
      jsonb_build_array(jsonb_build_object('income_expense_type_id',v_deposit_type_id,'quantity',1,'unit_price',v_amount)),
      jsonb_build_object('notes',coalesce(nullif(v_receipt->>'creator_name',''),'Contract V2')),NULL,v_owner)->>'id')::uuid INTO v_voucher_id;
$new$;
BEGIN
  IF position(prev IN body)>0 THEN EXECUTE replace(body,prev,replacement);
  ELSIF position(replacement IN body)=0 THEN RAISE EXCEPTION 'Unexpected signing receipt writer'; END IF;
END $cash$;

DO $inventory$
DECLARE f record; body text; anchor text;
BEGIN
  FOR f IN SELECT * FROM (VALUES
    (coalesce(to_regprocedure('public.get_my_available_rooms(uuid)'),to_regprocedure('public.get_my_available_rooms()')),'rm'),
    ('public.get_sale_room_inventory_v1(uuid,uuid,uuid)'::regprocedure,'r')
  ) AS x(func,alias) LOOP
    body:=pg_get_functiondef(f.func);
    IF position('AS has_deposit_hold' IN body)>0 THEN CONTINUE; END IF;
    anchor:=format('app_private.room_exit_hold_json_v1(%s.organization_id,%s.id) AS exit_hold',f.alias,f.alias);
    IF position(anchor IN body)=0 THEN RAISE EXCEPTION 'Unexpected authenticated sale inventory'; END IF;
    body:=replace(body,anchor,anchor||format(', EXISTS(SELECT 1 FROM public.room_next_claims dc WHERE dc.organization_id=%s.organization_id AND dc.room_id=%s.id AND dc.status=''LIVE'') AS has_deposit_hold',f.alias,f.alias));
    IF f.alias='rm' THEN body:=replace(body,'OR exit_hold IS NOT NULL','OR exit_hold IS NOT NULL OR has_deposit_hold'); END IF;
    EXECUTE body;
  END LOOP;
END $inventory$;

-- A pending receipt can retain its item identity through ordinary header edits.
-- Changing its financial destination or replacing its bound items needs cancellation and reissue.
DO $revision$
DECLARE f regprocedure:='app_private.commission_reason_revise_before_v1(uuid,bigint,jsonb,jsonb,text,text)'::regprocedure;
 body text:=pg_get_functiondef(f); anchor text:='PERFORM app_private.begin_ie_flex_write_v1(p_voucher, ''REVISE'');';
 guard text:=$guard$IF EXISTS(SELECT 1 FROM public.reservation_receipts rr WHERE rr.source_voucher_id=p_voucher)
    AND (v_items_changed OR t_room IS DISTINCT FROM v_row.room_id OR t_building IS DISTINCT FROM v_row.building_id
         OR t_contract IS DISTINCT FROM v_row.contract_id OR t_type IS DISTINCT FROM v_row.type) THEN
    RAISE EXCEPTION 'Phiếu % đã nối vào đợt giữ chỗ. Hủy phiếu ghi sai rồi lập phiếu thay thế cho đúng đợt.',v_row.code USING ERRCODE='PT409';
  END IF;
  $guard$;
BEGIN
  IF position(guard IN body)=0 THEN
    IF position(anchor IN body)=0 THEN RAISE EXCEPTION 'Unexpected financial revision writer'; END IF;
    EXECUTE replace(body,anchor,guard||anchor);
  END IF;
END $revision$;

-- Cursor on (created_at,id) preserves the existing list's authorization and ordering.
DO $paging$
DECLARE oldbody text:=pg_get_functiondef('public.list_room_reservations_v1(uuid,uuid,uuid,text,integer)'::regprocedure);
  declaration_end integer:=position(' RETURNS jsonb' IN oldbody);
BEGIN
  IF declaration_end=0 OR position('r.organization_id=p_organization_id' IN oldbody)=0 THEN RAISE EXCEPTION 'Unexpected reservation list definition'; END IF;
  oldbody:= 'CREATE OR REPLACE FUNCTION public.list_deposit_income_holds_v1(p_organization_id uuid,p_room_id uuid,p_customer_id uuid,p_status text,p_limit integer,p_before_created timestamptz,p_after_id uuid,p_buildings uuid[])'||chr(10)||substr(oldbody,declaration_end);
  oldbody:=replace(oldbody,'r.organization_id=p_organization_id',
    'r.organization_id=p_organization_id AND (coalesce(cardinality(p_buildings),0)=0 OR r.building_id=ANY(p_buildings)) AND (p_before_created IS NULL OR r.created_at<p_before_created OR (r.created_at=p_before_created AND r.id>p_after_id))');
  EXECUTE oldbody;
END $paging$;
REVOKE ALL ON FUNCTION public.list_deposit_income_holds_v1(uuid,uuid,uuid,text,integer,timestamptz,uuid,uuid[]) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.list_deposit_income_holds_v1(uuid,uuid,uuid,text,integer,timestamptz,uuid,uuid[]) TO authenticated;

-- Prove the named correction if the operator's three original documents still match.
-- A contract signed since the audit is reconciled separately.
DO $verify_room$
DECLARE target record; open_hold uuid; actual numeric; snapshot jsonb;
BEGIN
  FOR target IN SELECT v.organization_id,v.room_id,array_agg(v.id ORDER BY v.code) ids
    FROM public.income_expenses v JOIN public.rooms rm ON rm.id=v.room_id AND rm.organization_id=v.organization_id
    JOIN public.buildings b ON b.id=rm.building_id AND b.organization_id=rm.organization_id
    WHERE rm.name='05' AND b.name='481NVK' AND v.code IN ('PT2611447','PT2611448')
      AND v.contract_id IS NULL AND v.approval_status='APPROVED' AND v.deleted_at IS NULL
      AND NOT app_private.reservation_deposit_is_settled_v1(v.id)
      AND NOT EXISTS(SELECT 1 FROM public.contract_deposit_links l WHERE l.income_expense_id=v.id)
      AND NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.room_id=rm.id AND c.deleted_at IS NULL AND c.status IN ('ACTIVE','EXTENDED'))
      AND EXISTS(SELECT 1 FROM public.income_expenses old JOIN public.reservation_receipts oldrr ON oldrr.source_voucher_id=old.id
        WHERE old.organization_id=v.organization_id AND old.room_id=v.room_id AND old.code='PT2611428' AND old.approval_status='CANCELLED')
    GROUP BY v.organization_id,v.room_id HAVING count(DISTINCT v.code)=2
  LOOP
    SELECT r.id INTO open_hold FROM public.room_reservations r JOIN public.room_next_claims cl ON cl.reservation_id=r.id
      WHERE r.room_id=target.room_id AND r.organization_id=target.organization_id AND r.status='HOLD' AND cl.status='LIVE';
    SELECT sum((app_private.reservation_settlement_basis_v1(v)->>'amount')::numeric) INTO actual FROM unnest(target.ids) v;
    snapshot:=app_private.room_reservation_response_v1(open_hold);
    IF open_hold IS NULL OR (snapshot->>'received_amount')::numeric IS DISTINCT FROM actual
       OR (SELECT count(DISTINCT source_voucher_id) FROM public.reservation_receipts WHERE reservation_id=open_hold AND source_voucher_id=ANY(target.ids))<>2
       OR EXISTS(SELECT 1 FROM public.income_expenses old JOIN public.reservation_receipts rr ON rr.source_voucher_id=old.id
          JOIN public.room_next_claims c ON c.reservation_id=rr.reservation_id AND c.status='LIVE'
          WHERE old.organization_id=target.organization_id AND old.room_id=target.room_id AND old.code='PT2611428') THEN
      RAISE EXCEPTION 'Phòng 05 cần đối chiếu trước khi chuyển dữ liệu.';
    END IF;
  END LOOP;
END $verify_room$;

NOTIFY pgrst, 'reload schema';
