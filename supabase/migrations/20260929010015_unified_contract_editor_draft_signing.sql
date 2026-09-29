-- Additive versioned editor metadata; preserve legacy drafts and existing signing policy.
-- Metadata only: never creates a receipt, invoice, claim or contract.
CREATE OR REPLACE FUNCTION app_private.validate_contract_draft_editor_state_v1(p_state jsonb,p_organization_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
DECLARE f jsonb; row_data jsonb; item jsonb; field_name text;
BEGIN
  IF jsonb_typeof(p_state) IS DISTINCT FROM 'object'
    OR p_state->'version' IS DISTINCT FROM '1'::jsonb
    OR NOT (p_state ?& ARRAY['version','form','deposit_rows','invoice_items','selected_services','rent_unlocked','deposit_unlocked'])
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_state) k WHERE k NOT IN
      ('version','form','deposit_rows','invoice_items','selected_services','rent_unlocked','deposit_unlocked'))
    OR jsonb_typeof(p_state->'form') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_state->'deposit_rows') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_state->'invoice_items') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_state->'selected_services') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_state->'rent_unlocked') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p_state->'deposit_unlocked') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'Trạng thái trình soạn nháp không hợp lệ' USING ERRCODE='22023';
  END IF;
  f:=p_state->'form';
  IF NOT (f ?& ARRAY['deposit_debt_acknowledged','deposit_debt_reason','deposit_topup_due_date','invoice_template_id'])
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(f) k WHERE k NOT IN
      ('deposit_debt_acknowledged','deposit_debt_mode','deposit_debt_reason','deposit_topup_due_date','invoice_template_id'))
    OR jsonb_typeof(f->'deposit_debt_acknowledged') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(f->'deposit_debt_reason') IS DISTINCT FROM 'string'
    OR jsonb_typeof(f->'deposit_topup_due_date') IS DISTINCT FROM 'string'
    OR jsonb_typeof(f->'invoice_template_id') NOT IN ('string','null')
    OR (f ? 'deposit_debt_mode' AND jsonb_typeof(f->'deposit_debt_mode') IS DISTINCT FROM 'string')
    OR (f ? 'deposit_debt_mode' AND f->>'deposit_debt_mode' NOT IN ('DEBT','FIRST_INVOICE')) THEN
    RAISE EXCEPTION 'Lựa chọn trong nháp không hợp lệ' USING ERRCODE='22023';
  END IF;
  IF f->>'invoice_template_id' IS NOT NULL AND f->>'invoice_template_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Mẫu hoá đơn nháp không hợp lệ' USING ERRCODE='22023';
  END IF;
  FOR row_data IN SELECT value FROM jsonb_array_elements(p_state->'deposit_rows') LOOP
    IF jsonb_typeof(row_data) IS DISTINCT FROM 'object'
      OR NOT (row_data ?& ARRAY['uid','amount','account_id','received_date','images'])
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(row_data) k WHERE k NOT IN ('uid','amount','account_id','received_date','images'))
      OR jsonb_typeof(row_data->'uid') IS DISTINCT FROM 'string'
      OR jsonb_typeof(row_data->'amount') IS DISTINCT FROM 'number'
      OR jsonb_typeof(row_data->'account_id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(row_data->'received_date') IS DISTINCT FROM 'string'
      OR jsonb_typeof(row_data->'images') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Dòng cọc nháp không hợp lệ' USING ERRCODE='22023';
    END IF;
    IF (row_data->>'amount')::numeric<0 OR (row_data->>'amount')::numeric>1.7976931348623157e308::numeric
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(row_data->'images') image WHERE jsonb_typeof(image) IS DISTINCT FROM 'string') THEN
      RAISE EXCEPTION 'Dòng cọc nháp không hợp lệ' USING ERRCODE='22023';
    END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(p_state->'invoice_items') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR NOT (item ?& ARRAY['id','type','accounting_class','description','unit_price','quantity'])
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(item) k WHERE k NOT IN
        ('id','type','accounting_class','description','unit_price','quantity','service_id','from_date','to_date'))
      OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'type') IS DISTINCT FROM 'string'
      OR item->>'type' NOT IN ('RENT','SERVICE','DISCOUNT','OTHER')
      OR jsonb_typeof(item->'accounting_class') IS DISTINCT FROM 'string'
      OR item->>'accounting_class' NOT IN ('REVENUE','DEPOSIT')
      OR jsonb_typeof(item->'description') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'unit_price') IS DISTINCT FROM 'number'
      OR jsonb_typeof(item->'quantity') IS DISTINCT FROM 'number'
      OR (item ? 'service_id' AND jsonb_typeof(item->'service_id') NOT IN ('string','null'))
      OR (item ? 'from_date' AND jsonb_typeof(item->'from_date') NOT IN ('string','null'))
      OR (item ? 'to_date' AND jsonb_typeof(item->'to_date') NOT IN ('string','null')) THEN
      RAISE EXCEPTION 'Dòng xem trước hoá đơn nháp không hợp lệ' USING ERRCODE='22023';
    END IF;
    FOREACH field_name IN ARRAY ARRAY['unit_price','quantity'] LOOP
      IF (item->>field_name)::numeric<0 OR (item->>field_name)::numeric>1.7976931348623157e308::numeric THEN
        RAISE EXCEPTION 'Số xem trước hoá đơn nháp không hợp lệ' USING ERRCODE='22023';
      END IF;
    END LOOP;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(p_state->'selected_services') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR NOT (item ?& ARRAY['id','name','unit_price','unit','type','pricing_type','initial_reading','quantity'])
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(item) k WHERE k NOT IN
        ('id','name','unit_price','unit','type','pricing_type','initial_reading','quantity'))
      OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'type') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'unit') NOT IN ('string','null')
      OR jsonb_typeof(item->'pricing_type') NOT IN ('string','null') THEN
      RAISE EXCEPTION 'Dịch vụ chọn trong nháp không hợp lệ' USING ERRCODE='22023';
    END IF;
    FOREACH field_name IN ARRAY ARRAY['unit_price','initial_reading','quantity'] LOOP
      IF jsonb_typeof(item->field_name) IS DISTINCT FROM 'number'
        OR (item->>field_name)::numeric<0 OR (item->>field_name)::numeric>1.7976931348623157e308::numeric THEN
        RAISE EXCEPTION 'Số dịch vụ chọn trong nháp không hợp lệ' USING ERRCODE='22023';
      END IF;
    END LOOP;
    IF NOT EXISTS(SELECT 1 FROM public.services s WHERE s.id::text=item->>'id' AND s.organization_id=p_organization_id AND s.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Dịch vụ nháp không thuộc tổ chức' USING ERRCODE='42501';
    END IF;
  END LOOP;
END $fn$;
REVOKE ALL ON FUNCTION app_private.validate_contract_draft_editor_state_v1(jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.save_contract_draft(
  p_organization_id uuid, p_building_id uuid, p_room_id uuid, p_payload jsonb,
  p_template_id uuid DEFAULT NULL, p_draft_id uuid DEFAULT NULL, p_expected_revision integer DEFAULT NULL,
  p_request_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_draft public.contract_drafts%ROWTYPE; v_item jsonb; v_form jsonb; v_key text;
  v_replay public.contract_draft_versions%ROWTYPE; v_action text; v_allowed boolean;
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'Thiếu định danh lần lưu nháp' USING ERRCODE = '22023'; END IF;
  v_action := CASE WHEN p_expected_revision IS NULL THEN 'contracts.create' ELSE 'contracts.edit' END;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  IF NOT app_private.contract_draft_scope_allowed(p_organization_id, p_building_id,
    v_action) THEN
    RAISE EXCEPTION 'Không có quyền lưu bản nháp' USING ERRCODE = '42501';
  END IF;
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,v_action,p_building_id,NULL);
  IF NOT COALESCE(v_allowed,false) THEN RAISE EXCEPTION 'Không có quyền lưu bản nháp' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_replay FROM public.contract_draft_versions WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_replay.organization_id <> p_organization_id OR v_replay.building_id <> p_building_id
      OR v_replay.created_by <> auth.uid() OR v_replay.draft_id IS DISTINCT FROM p_draft_id
      OR v_replay.revision <> COALESCE(p_expected_revision + 1,1) OR v_replay.payload IS DISTINCT FROM p_payload
      OR v_replay.template_id IS DISTINCT FROM p_template_id OR v_replay.room_id IS DISTINCT FROM p_room_id THEN
      RAISE EXCEPTION 'Định danh lần lưu đã dùng cho nội dung khác' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_draft FROM public.contract_drafts WHERE id = v_replay.draft_id;
    RETURN to_jsonb(v_draft) || jsonb_build_object('revision',v_replay.revision,'payload',v_replay.payload,'template_id',v_replay.template_id,'room_id',v_replay.room_id,
      'updated_at',v_replay.created_at,'documents',COALESCE((SELECT jsonb_agg(to_jsonb(x) - 'document_data' ORDER BY x.created_at DESC) FROM public.contract_draft_documents x WHERE x.draft_id=v_replay.draft_id),'[]'::jsonb));
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload::text) > 262144
    OR NOT (p_payload ?& ARRAY['form','customers','services','use_custom_services'])
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('form','customers','services','use_custom_services','owner','editor_state'))
    OR jsonb_typeof(p_payload->'form') <> 'object' OR jsonb_typeof(p_payload->'customers') <> 'array'
    OR jsonb_typeof(p_payload->'services') <> 'array' OR jsonb_typeof(p_payload->'use_custom_services') <> 'boolean' THEN
    RAISE EXCEPTION 'Thông tin nháp không hợp lệ' USING ERRCODE = '22023';
  END IF;
  v_form := p_payload->'form';
  IF p_payload ? 'owner' THEN
    IF jsonb_typeof(p_payload->'owner') <> 'object' OR NOT ((p_payload->'owner') ?& ARRAY['name','phone','birthday','id_number','id_issue_place','id_issue_date'])
      OR EXISTS (SELECT 1 FROM jsonb_each(p_payload->'owner') e WHERE e.key NOT IN ('name','phone','birthday','id_number','id_issue_place','id_issue_date') OR jsonb_typeof(e.value) <> 'string') THEN
      RAISE EXCEPTION 'Thông tin chủ nhà nháp không hợp lệ' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF NOT (v_form ?& ARRAY['room_id','signed_date','start_date','end_date','rent_price','total_deposit','payment_cycle','start_billing_date','end_billing_date','notes','discount_months','discount_amount_per_month'])
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_form) k WHERE k NOT IN ('room_id','signed_date','start_date','end_date','rent_price','total_deposit','payment_cycle','start_billing_date','end_billing_date','notes','discount_months','discount_amount_per_month'))
    OR COALESCE(v_form->>'room_id','') IS DISTINCT FROM COALESCE(p_room_id::text,'')
    OR COALESCE(v_form->>'payment_cycle','') NOT IN ('MONTHLY','QUARTERLY','SEMI_ANNUAL','ANNUAL') THEN
    RAISE EXCEPTION 'Thông tin nháp không hợp lệ' USING ERRCODE = '22023';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['rent_price','total_deposit','discount_months','discount_amount_per_month'] LOOP
    IF jsonb_typeof(v_form->v_key) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Số tiền nháp không hợp lệ' USING ERRCODE = '22023';
    END IF;
    IF (v_form->>v_key)::numeric < 0 OR (v_form->>v_key)::numeric > 1.7976931348623157e308::numeric THEN
      RAISE EXCEPTION 'Số tiền nháp không hợp lệ' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF (v_form->>'discount_months')::numeric <> trunc((v_form->>'discount_months')::numeric) THEN
    RAISE EXCEPTION 'Số tháng nháp không hợp lệ' USING ERRCODE = '22023';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['room_id','signed_date','start_date','end_date','start_billing_date','end_billing_date','notes'] LOOP
    IF jsonb_typeof(v_form->v_key) <> 'string' THEN RAISE EXCEPTION 'Trường nháp không hợp lệ' USING ERRCODE = '22023'; END IF;
  END LOOP;
  IF p_room_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.rooms r WHERE r.id = p_room_id
    AND r.building_id = p_building_id AND r.organization_id = p_organization_id AND r.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Phòng không thuộc phạm vi bản nháp' USING ERRCODE = '42501';
  END IF;
  IF p_template_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.document_templates t
    WHERE t.id = p_template_id AND t.organization_id = p_organization_id AND t.deleted_at IS NULL AND t.is_active
    AND t.type = 'lease_contract') THEN RAISE EXCEPTION 'Mẫu không thuộc tổ chức' USING ERRCODE = '42501'; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_payload->'customers') LOOP
    IF jsonb_typeof(v_item) <> 'object' OR NOT (v_item ?& ARRAY['id','full_name','phone','id_number','is_representative','notes'])
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_item) k WHERE k NOT IN ('id','full_name','phone','id_number','is_representative','notes')) THEN
      RAISE EXCEPTION 'Thông tin khách nháp không hợp lệ' USING ERRCODE = '22023';
    END IF;
    -- Nested types must match the draft reader boundary before persisting.
    IF jsonb_typeof(v_item->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item->'full_name') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item->'phone') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item->'is_representative') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(v_item->'id_number') NOT IN ('string','null')
      OR jsonb_typeof(v_item->'notes') NOT IN ('string','null') THEN
      RAISE EXCEPTION 'Thông tin khách nháp không hợp lệ' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id::text = v_item->>'id' AND c.organization_id = p_organization_id AND c.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Khách hàng nháp không thuộc tổ chức' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_payload->'services') LOOP
    IF jsonb_typeof(v_item) <> 'object' OR NOT (v_item ?& ARRAY['id','name','unit_price','unit','type','pricing_type','initial_reading','quantity'])
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_item) k WHERE k NOT IN ('id','name','unit_price','unit','type','pricing_type','initial_reading','quantity')) THEN
      RAISE EXCEPTION 'Thông tin dịch vụ nháp không hợp lệ' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_item->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item->'name') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item->'type') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_item->'unit') NOT IN ('string','null')
      OR jsonb_typeof(v_item->'pricing_type') NOT IN ('string','null') THEN
      RAISE EXCEPTION 'Thông tin dịch vụ nháp không hợp lệ' USING ERRCODE = '22023';
    END IF;
    FOREACH v_key IN ARRAY ARRAY['unit_price','initial_reading','quantity'] LOOP
      IF jsonb_typeof(v_item->v_key) IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'Số dịch vụ nháp không hợp lệ' USING ERRCODE = '22023';
      END IF;
      IF (v_item->>v_key)::numeric < 0 OR (v_item->>v_key)::numeric > 1.7976931348623157e308::numeric THEN
        RAISE EXCEPTION 'Số dịch vụ nháp không hợp lệ' USING ERRCODE = '22023';
      END IF;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM public.services s WHERE s.id::text = v_item->>'id' AND s.organization_id = p_organization_id AND s.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Dịch vụ nháp không thuộc tổ chức' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF p_payload ? 'editor_state' THEN PERFORM app_private.validate_contract_draft_editor_state_v1(p_payload->'editor_state',p_organization_id); END IF;
  IF p_expected_revision IS NULL THEN
    IF p_draft_id IS NULL THEN RAISE EXCEPTION 'Thiếu định danh bản nháp' USING ERRCODE = '22023'; END IF;
    IF EXISTS (SELECT 1 FROM public.contract_drafts WHERE id=p_draft_id) THEN RAISE EXCEPTION 'Bản nháp đã tồn tại' USING ERRCODE='40001'; END IF;
    INSERT INTO public.contract_drafts(id,organization_id, building_id, room_id, payload, template_id, created_by)
      VALUES(p_draft_id,p_organization_id, p_building_id, p_room_id, p_payload, p_template_id, auth.uid()) RETURNING * INTO v_draft;
  ELSE
    SELECT * INTO v_draft FROM public.contract_drafts WHERE id = p_draft_id AND organization_id = p_organization_id FOR UPDATE;
    IF NOT FOUND OR v_draft.building_id <> p_building_id THEN RAISE EXCEPTION 'Không có quyền sửa bản nháp' USING ERRCODE = '42501'; END IF;
    IF p_expected_revision IS NULL OR v_draft.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'Bản nháp đã thay đổi' USING ERRCODE = '40001';
    END IF;
    UPDATE public.contract_drafts SET room_id = p_room_id, payload = p_payload, template_id = p_template_id,
      revision = revision + 1, updated_at = now() WHERE id = p_draft_id RETURNING * INTO v_draft;
  END IF;
  INSERT INTO public.contract_draft_versions(draft_id, revision, organization_id, building_id, room_id, payload, template_id, created_by,request_id)
    VALUES(v_draft.id, v_draft.revision, v_draft.organization_id, v_draft.building_id, v_draft.room_id, v_draft.payload, v_draft.template_id, auth.uid(),p_request_id);
  RETURN to_jsonb(v_draft) || jsonb_build_object('documents', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM public.contract_draft_documents x WHERE x.draft_id = v_draft.id), '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION public.sign_and_checkin_contract_draft_v1(
  p_organization_id uuid,p_draft_id uuid,p_expected_revision integer,p_document_id uuid,p_document_sha256 text,
  p_request_id uuid,p_received_on date,p_room_ready boolean,p_terms_confirmed boolean,p_boundary jsonb,p_creation_options jsonb,
  p_reservation_id uuid DEFAULT NULL,p_reservation_revision bigint DEFAULT NULL,p_source_voucher_ids uuid[] DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE d public.contract_drafts%ROWTYPE; a public.contract_draft_documents%ROWTYPE; s public.contract_draft_signings%ROWTYPE;
  r public.rooms%ROWTYPE; c public.contracts%ROWTYPE; v_room_id uuid; v_building_id uuid; v_allowed boolean;
  v_hash text; v_terms jsonb; f jsonb; v_party jsonb; v_payload jsonb; v_result jsonb; v_id uuid:=gen_random_uuid(); v_count integer; v_rep_count integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_request_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<1 OR p_document_id IS NULL
    OR p_document_sha256 IS NULL OR p_document_sha256 !~ '^[a-f0-9]{64}$'
    OR p_received_on IS NULL OR NOT isfinite(p_received_on) OR p_room_ready IS DISTINCT FROM true OR p_terms_confirmed IS DISTINCT FROM true
    OR jsonb_typeof(p_boundary) IS DISTINCT FROM 'object' OR p_boundary->>'state' IS DISTINCT FROM 'VERIFIED'
    OR jsonb_typeof(p_creation_options) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Cần xác nhận ngày nhận, phòng sẵn sàng, điều khoản và đủ mốc chỉ số' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_creation_options) k WHERE k NOT IN
    ('deposit_debt_mode','deposit_debt_reason','deposit_topup_due_date','first_invoice','deposit_receipts','existing_deposit_voucher_ids','invoice_template_id')) THEN
    RAISE EXCEPTION 'Lựa chọn tạo hợp đồng không hợp lệ; nhánh này không chuyển giữ chỗ hoặc thu cọc' USING ERRCODE='22023';
  END IF;
  IF (p_creation_options ? 'deposit_receipts' AND jsonb_typeof(p_creation_options->'deposit_receipts') IS DISTINCT FROM 'array')
    OR (p_creation_options ? 'existing_deposit_voucher_ids' AND jsonb_typeof(p_creation_options->'existing_deposit_voucher_ids') IS DISTINCT FROM 'array')
    OR (p_creation_options ? 'invoice_template_id' AND jsonb_typeof(p_creation_options->'invoice_template_id') NOT IN ('string','null'))
    OR (p_creation_options->>'invoice_template_id' IS NOT NULL AND p_creation_options->>'invoice_template_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_creation_options->'deposit_receipts')='array' THEN p_creation_options->'deposit_receipts' ELSE '[]'::jsonb END) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'object')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_creation_options->'existing_deposit_voucher_ids')='array' THEN p_creation_options->'existing_deposit_voucher_ids' ELSE '[]'::jsonb END) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR x#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'Lựa chọn nguồn cọc hoặc mẫu hoá đơn không hợp lệ' USING ERRCODE='22023';
  END IF;
  IF (p_reservation_id IS NULL AND (p_reservation_revision IS NOT NULL OR cardinality(COALESCE(p_source_voucher_ids,ARRAY[]::uuid[]))>0))
    OR (p_reservation_id IS NOT NULL AND (p_reservation_revision IS NULL OR p_reservation_revision<1 OR p_source_voucher_ids IS NULL))
    OR array_position(p_source_voucher_ids,NULL) IS NOT NULL
    OR cardinality(p_source_voucher_ids)<>(SELECT count(DISTINCT x) FROM unnest(p_source_voucher_ids) x) THEN
    RAISE EXCEPTION 'Nguồn giữ chỗ cần đúng ID, phiên bản và danh sách chứng từ không trùng' USING ERRCODE='22023';
  END IF;
  SELECT room_id,building_id INTO v_room_id,v_building_id FROM public.contract_drafts WHERE id=p_draft_id AND organization_id=p_organization_id;
  IF NOT FOUND OR v_room_id IS NULL OR NOT app_private.contract_draft_scope_allowed(p_organization_id,v_building_id,'contracts.create') THEN
    RAISE EXCEPTION 'Không có quyền tạo hợp đồng từ bản nháp' USING ERRCODE='42501';
  END IF;
  -- Existing create_v2 locks room then organization. Keep that order for sign versus direct-create.
  SELECT * INTO r FROM public.rooms WHERE id=v_room_id AND organization_id=p_organization_id AND building_id=v_building_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phòng không còn thuộc phạm vi bản nháp' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'contracts.create',v_building_id,NULL);
  IF NOT COALESCE(v_allowed,false) OR NOT app_private.contract_draft_scope_allowed(p_organization_id,v_building_id,'contracts.create') THEN
    RAISE EXCEPTION 'Không có quyền tạo hợp đồng' USING ERRCODE='42501';
  END IF;
  SELECT * INTO d FROM public.contract_drafts WHERE id=p_draft_id AND organization_id=p_organization_id FOR UPDATE;
  IF d.room_id IS DISTINCT FROM v_room_id OR d.building_id<>v_building_id OR d.revision<>p_expected_revision THEN
    RAISE EXCEPTION 'Bản nháp đã đổi phiên bản hoặc phòng; tải lại trước khi ký' USING ERRCODE='40001';
  END IF;
  SELECT * INTO a FROM public.contract_draft_documents WHERE id=p_document_id AND draft_id=d.id AND revision=d.revision
    AND organization_id=p_organization_id AND building_id=d.building_id AND document_sha256=p_document_sha256;
  IF NOT FOUND OR a.template_snapshot->>'id' IS DISTINCT FROM d.template_id::text THEN
    RAISE EXCEPTION 'Tài liệu đã xuất không khớp phiên bản nháp' USING ERRCODE='40001';
  END IF;
  v_hash:=md5(jsonb_build_object('org',p_organization_id,'draft',p_draft_id,'revision',p_expected_revision,'document',p_document_id,
    'document_sha256',p_document_sha256,'received_on',p_received_on,'boundary',p_boundary,'options',p_creation_options,
    'reservation_id',p_reservation_id,'reservation_revision',p_reservation_revision,'source_voucher_ids',COALESCE(p_source_voucher_ids,ARRAY[]::uuid[]))::text);
  SELECT * INTO s FROM public.contract_draft_signings WHERE request_id=p_request_id;
  IF FOUND AND s.draft_id<>d.id THEN RAISE EXCEPTION 'Định danh ký đã dùng cho nháp khác' USING ERRCODE='23505'; END IF;
  SELECT * INTO s FROM public.contract_draft_signings WHERE draft_id=d.id;
  IF FOUND THEN
    IF s.draft_id<>d.id OR s.intent_hash<>v_hash THEN RAISE EXCEPTION 'Định danh ký hoặc bản nháp đã dùng với nội dung khác' USING ERRCODE='23505'; END IF;
    RETURN to_jsonb(s)-'intent_hash';
  END IF;
  IF d.status<>'EDITABLE' THEN RAISE EXCEPTION 'Bản nháp không còn có thể ký' USING ERRCODE='55000'; END IF;
  SELECT payload INTO v_terms FROM public.contract_draft_versions WHERE draft_id=d.id AND revision=d.revision;
  IF v_terms IS DISTINCT FROM d.payload THEN RAISE EXCEPTION 'Nội dung nháp không khớp phiên bản đã lưu' USING ERRCODE='40001'; END IF;
  f:=v_terms->'form';
  IF f->>'room_id' IS DISTINCT FROM r.id::text OR p_received_on IS DISTINCT FROM (f->>'start_date')::date
    OR p_received_on>public.org_today_v1(p_organization_id) OR (f->>'signed_date')::date>public.org_today_v1(p_organization_id) THEN
    RAISE EXCEPTION 'Ngày nhận phải là ngày bắt đầu đã xuất, không được ở tương lai; sửa và xuất lại nháp nếu đổi ngày' USING ERRCODE='22023';
  END IF;
  IF r.status::text<>'AVAILABLE' AND NOT (r.status::text='RESERVED' AND p_reservation_id IS NOT NULL) THEN RAISE EXCEPTION 'Phòng chưa sẵn sàng nhận khách mới' USING ERRCODE='55000'; END IF;
  IF EXISTS (SELECT 1 FROM public.contracts old WHERE old.organization_id=p_organization_id AND old.room_id=r.id AND old.deleted_at IS NULL
    AND old.status::text IN ('ACTIVE','EXTENDED') AND old.actual_end_date IS NULL) THEN
    RAISE EXCEPTION 'Phòng vẫn có lượt ở chưa trả' USING ERRCODE='55000';
  END IF;
  IF (p_reservation_id IS NULL AND public.room_has_holding_deposit(r.id)) OR EXISTS (SELECT 1 FROM public.room_reservation_holds h WHERE h.room_id=r.id
    AND h.status='PENDING_APPROVAL' AND h.expires_at>clock_timestamp() AND (p_reservation_id IS NULL OR h.held_by<>auth.uid())) THEN
    RAISE EXCEPTION 'Phòng có cọc hoặc giữ chỗ; chưa hỗ trợ chuyển nguồn này từ nháp' USING ERRCODE='55P03';
  END IF;
  PERFORM 1 FROM public.room_turnovers t WHERE t.organization_id=p_organization_id AND t.room_id=r.id FOR SHARE;
  IF EXISTS (SELECT 1 FROM public.room_turnovers t WHERE t.organization_id=p_organization_id AND t.room_id=r.id AND t.status<>'READY') THEN
    RAISE EXCEPTION 'Phòng đang chuẩn bị; xác nhận sẵn sàng trước khi nhận khách' USING ERRCODE='55000';
  END IF;
  SELECT count(*),count(*) FILTER (WHERE (j->>'is_representative')::boolean) INTO v_count,v_rep_count FROM jsonb_array_elements(v_terms->'customers') j;
  IF v_count=0 OR v_rep_count<>1 OR v_count<>(SELECT count(DISTINCT j->>'id') FROM jsonb_array_elements(v_terms->'customers') j) THEN
    RAISE EXCEPTION 'Danh sách khách chưa đủ điều kiện ký' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.customers p WHERE p.id IN (SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_terms->'customers') j) ORDER BY p.id FOR SHARE;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_terms->'customers') j LEFT JOIN public.customers p ON p.id=(j->>'id')::uuid
    WHERE p.id IS NULL OR p.organization_id<>p_organization_id OR p.deleted_at IS NOT NULL
      OR p.full_name IS DISTINCT FROM j->>'full_name' OR COALESCE(p.phone,'') IS DISTINCT FROM j->>'phone'
      OR p.id_number IS DISTINCT FROM j->>'id_number') THEN
    RAISE EXCEPTION 'Thông tin khách đã thay đổi; lưu và xuất lại đúng bản được ký' USING ERRCODE='40001';
  END IF;
  -- No-claim remains usable before P9 exists; conversion never pretends support when its assertion/consumer is absent.
  IF p_reservation_id IS NOT NULL AND (to_regprocedure('app_private.assert_room_next_claim_for_signing_v1(uuid,uuid,uuid,bigint,uuid[],uuid[])') IS NULL
    OR to_regprocedure('app_private.consume_room_next_claim_v1(uuid,uuid,bigint,uuid)') IS NULL) THEN
    RAISE EXCEPTION 'Chưa hỗ trợ chuyển nguồn giữ chỗ đã chọn' USING ERRCODE='55000';
  END IF;
  IF to_regprocedure('app_private.assert_room_next_claim_for_signing_v1(uuid,uuid,uuid,bigint,uuid[],uuid[])') IS NOT NULL THEN
    PERFORM app_private.assert_room_next_claim_for_signing_v1(p_organization_id,r.id,p_reservation_id,p_reservation_revision,
      ARRAY(SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_terms->'customers') j),COALESCE(p_source_voucher_ids,ARRAY[]::uuid[]));
  END IF;
  SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) INTO v_party FROM public.customers p WHERE p.id IN (SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_terms->'customers') j);
  -- The handover is separate from printed terms. Current create_v2 stores one
  -- incoming scalar per service, so use B's actual verified room measurements.
  PERFORM 1 FROM public.meters m WHERE m.organization_id=p_organization_id AND m.room_id=r.id AND m.building_id=d.building_id
    AND m.status='ACTIVE' AND m.deleted_at IS NULL ORDER BY m.id FOR SHARE;
  PERFORM app_private.validate_meter_boundary_payload_v1(p_organization_id,r.id,d.building_id,p_boundary);
  IF COALESCE((v_terms->>'use_custom_services')::boolean,false) AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_terms->'services') j
    WHERE (j->>'type'='METER_READING' OR j->>'pricing_type'='METER') AND NOT EXISTS (
      SELECT 1 FROM public.meters m WHERE m.organization_id=p_organization_id AND m.room_id=r.id AND m.building_id=d.building_id
        AND m.service_id=(j->>'id')::uuid AND m.status='ACTIVE' AND m.deleted_at IS NULL)) THEN
    RAISE EXCEPTION 'Dịch vụ đo chỉ số chưa có đồng hồ đang hoạt động gắn đúng phòng và dịch vụ' USING ERRCODE='22023';
  END IF;
  IF COALESCE((v_terms->>'use_custom_services')::boolean,false) AND EXISTS (SELECT m.service_id FROM public.meters m JOIN jsonb_array_elements(p_boundary->'readings') b ON m.id=(b->>'meter_id')::uuid
    WHERE m.organization_id=p_organization_id AND m.room_id=r.id AND m.building_id=d.building_id AND m.status='ACTIVE' AND m.deleted_at IS NULL
      AND m.service_id IN (SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_terms->'services') j)
    GROUP BY m.service_id HAVING count(DISTINCT (b->>'reading')::numeric)>1) THEN
    RAISE EXCEPTION 'Nhiều đồng hồ của cùng dịch vụ có số đầu khác nhau; chưa thể ánh xạ vào dịch vụ hiện hành' USING ERRCODE='22023';
  END IF;
  v_payload:=jsonb_build_object('contract',jsonb_build_object('room_id',r.id,'signed_date',f->>'signed_date','start_date',f->>'start_date',
    'end_date',f->>'end_date','rent_price',f->'rent_price','total_deposit',f->'total_deposit','payment_cycle',f->>'payment_cycle',
    'start_billing_date',NULLIF(f->>'start_billing_date',''),'end_billing_date',NULLIF(f->>'end_billing_date',''),'notes',f->>'notes',
    'contract_template_id',d.template_id,'discounts',jsonb_build_object('months',f->'discount_months','amount_per_month',f->'discount_amount_per_month'))
    ||(p_creation_options-'first_invoice'-'deposit_receipts'-'existing_deposit_voucher_ids'),
    'customers',(SELECT jsonb_agg(jsonb_build_object('customer_id',j->>'id','is_representative',j->'is_representative','notes',j->'notes')) FROM jsonb_array_elements(v_terms->'customers') j),
    'services',CASE WHEN COALESCE((v_terms->>'use_custom_services')::boolean,false) THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('service_id',j->>'id','unit_price',j->'unit_price','initial_reading',
      COALESCE((SELECT to_jsonb(min((b->>'reading')::numeric)) FROM public.meters m JOIN jsonb_array_elements(p_boundary->'readings') b ON m.id=(b->>'meter_id')::uuid
        WHERE m.organization_id=p_organization_id AND m.room_id=r.id AND m.building_id=d.building_id AND m.service_id=(j->>'id')::uuid
          AND m.status='ACTIVE' AND m.deleted_at IS NULL),j->'initial_reading'))) FROM jsonb_array_elements(v_terms->'services') j),'[]'::jsonb) ELSE '[]'::jsonb END,
    'deposit_receipts',COALESCE(p_creation_options->'deposit_receipts','[]'::jsonb),
    'existing_deposit_voucher_ids',to_jsonb(ARRAY(
      SELECT DISTINCT voucher_id FROM (
        SELECT unnest(COALESCE(p_source_voucher_ids,ARRAY[]::uuid[])) AS voucher_id
        UNION ALL
        SELECT (value#>>'{}')::uuid FROM jsonb_array_elements(COALESCE(p_creation_options->'existing_deposit_voucher_ids','[]'::jsonb))
      ) sources ORDER BY voucher_id)));
  IF p_reservation_id IS NOT NULL THEN v_payload:=v_payload||jsonb_build_object('reservation_id',p_reservation_id,'reservation_revision',p_reservation_revision); END IF;
  IF p_creation_options ? 'first_invoice' THEN v_payload:=v_payload||jsonb_build_object('first_invoice',p_creation_options->'first_invoice'); END IF;
  v_result:=public.create_contract_v2(v_payload,'draft-sign:'||d.id::text);
  IF COALESCE((v_result->>'deposit_shortfall')::numeric,0)>=0.01 AND NULLIF(p_creation_options->>'deposit_debt_mode','') IS NULL THEN
    RAISE EXCEPTION 'Cọc còn thiếu cần chọn cách bổ sung hiện hành' USING ERRCODE='22023';
  END IF;
  SELECT * INTO c FROM public.contracts WHERE id=(v_result->'contract'->>'id')::uuid;
  IF NOT FOUND OR c.organization_id<>p_organization_id OR c.room_id<>r.id OR c.status::text<>'ACTIVE' OR c.actual_end_date IS NOT NULL
    OR NULLIF(btrim(c.contract_number),'') IS NULL OR NOT EXISTS (SELECT 1 FROM public.rooms current_room WHERE current_room.id=r.id AND current_room.status::text='OCCUPIED') THEN
    RAISE EXCEPTION 'Core chưa tạo hợp đồng nhận phòng hợp lệ' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contracts old WHERE old.organization_id=p_organization_id AND old.contract_number=c.contract_number AND old.id<>c.id) THEN
    RAISE EXCEPTION 'Số hợp đồng mới bị trùng; không ghi nhận ký' USING ERRCODE='23505';
  END IF;
  PERFORM app_private.record_contract_meter_boundary_set_v1(p_organization_id,c.id,r.id,'MOVE_IN',p_received_on,p_boundary,'contracts.create');
  PERFORM app_private.assert_contract_move_in_boundaries_v1(p_organization_id,c.id,'contracts.create');
  IF p_reservation_id IS NOT NULL THEN PERFORM app_private.consume_room_next_claim_v1(p_organization_id,p_reservation_id,p_reservation_revision,c.id); END IF;
  INSERT INTO public.contract_draft_signings(id,organization_id,building_id,room_id,draft_id,revision,document_id,document_sha256,template_sha256,
    template_path,template_snapshot,document_data,terms,party_snapshot,creation_options,reservation_id,reservation_revision,source_voucher_ids,received_on,contract_id,contract_number,request_id,intent_hash,signed_by,official_document_path)
  VALUES(v_id,p_organization_id,d.building_id,r.id,d.id,d.revision,a.id,a.document_sha256,a.template_sha256,a.template_path,a.template_snapshot,
    (a.document_data-'DRAFT_TITLE'-'DRAFT_REVISION')||jsonb_build_object('CONTRACT_NUMBER',c.contract_number),v_terms,v_party,p_creation_options,p_reservation_id,p_reservation_revision,COALESCE(p_source_voucher_ids,ARRAY[]::uuid[]),
    p_received_on,c.id,c.contract_number,p_request_id,v_hash,auth.uid(),p_organization_id::text||'/'||d.building_id::text||'/'||v_id::text||'/document.docx') RETURNING * INTO s;
  UPDATE public.contract_drafts SET status='SIGNED',converted_contract_id=c.id WHERE id=d.id;
  RETURN to_jsonb(s)-'intent_hash';
END $$;

REVOKE ALL ON FUNCTION public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[]) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[]) TO authenticated;
