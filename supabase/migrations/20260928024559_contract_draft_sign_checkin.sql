-- P11a: exact persisted draft, no reservation/claim branch until P9 is available.
-- The official writer, its permissions, number allocator and money behavior stay unchanged.
ALTER TABLE public.contract_drafts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'EDITABLE';
ALTER TABLE public.contract_drafts ADD COLUMN IF NOT EXISTS converted_contract_id uuid REFERENCES public.contracts(id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.contract_drafts'::regclass AND conname='contract_drafts_signing_state_check') THEN
    ALTER TABLE public.contract_drafts ADD CONSTRAINT contract_drafts_signing_state_check CHECK
      ((status='EDITABLE' AND converted_contract_id IS NULL) OR (status='SIGNED' AND converted_contract_id IS NOT NULL));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS contract_drafts_converted_contract_unique ON public.contract_drafts(converted_contract_id) WHERE converted_contract_id IS NOT NULL;

-- A business source snapshot, not a second generic operation store. Canonical create_v2 handles its own operation identity.
CREATE TABLE IF NOT EXISTS public.contract_draft_signings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  building_id uuid NOT NULL REFERENCES public.buildings(id),
  room_id uuid NOT NULL REFERENCES public.rooms(id),
  draft_id uuid NOT NULL UNIQUE REFERENCES public.contract_drafts(id),
  revision integer NOT NULL CHECK (revision>0),
  document_id uuid NOT NULL REFERENCES public.contract_draft_documents(id),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[a-f0-9]{64}$'),
  template_sha256 text NOT NULL CHECK (template_sha256 ~ '^[a-f0-9]{64}$'),
  template_path text NOT NULL,
  template_snapshot jsonb NOT NULL,
  document_data jsonb NOT NULL,
  terms jsonb NOT NULL,
  party_snapshot jsonb NOT NULL,
  creation_options jsonb NOT NULL,
  reservation_id uuid,
  reservation_revision bigint,
  source_voucher_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  received_on date NOT NULL,
  contract_id uuid NOT NULL UNIQUE REFERENCES public.contracts(id),
  contract_number text NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  intent_hash text NOT NULL,
  signed_by uuid NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  official_document_path text NOT NULL UNIQUE,
  official_document_sha256 text CHECK (official_document_sha256 ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (draft_id,revision) REFERENCES public.contract_draft_versions(draft_id,revision),
  CHECK ((reservation_id IS NULL AND reservation_revision IS NULL AND cardinality(source_voucher_ids)=0)
    OR (reservation_id IS NOT NULL AND reservation_revision>0))
);
ALTER TABLE public.contract_draft_signings ADD COLUMN IF NOT EXISTS reservation_id uuid;
ALTER TABLE public.contract_draft_signings ADD COLUMN IF NOT EXISTS reservation_revision bigint;
ALTER TABLE public.contract_draft_signings ADD COLUMN IF NOT EXISTS source_voucher_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[];
ALTER TABLE public.contract_draft_signings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contract_draft_signings_read ON public.contract_draft_signings;
CREATE POLICY contract_draft_signings_read ON public.contract_draft_signings FOR SELECT TO authenticated
  USING (app_private.contract_draft_scope_allowed(organization_id,building_id,'contracts.view'));
DROP POLICY IF EXISTS contract_draft_signings_hide_sandbox_admin ON public.contract_draft_signings;
CREATE POLICY contract_draft_signings_hide_sandbox_admin ON public.contract_draft_signings AS RESTRICTIVE FOR ALL TO authenticated
  USING (NOT COALESCE(public.is_super_admin() AND organization_id=ANY(public.sandbox_org_ids()),false))
  WITH CHECK (NOT COALESCE(public.is_super_admin() AND organization_id=ANY(public.sandbox_org_ids()),false));
REVOKE ALL ON public.contract_draft_signings FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.contract_draft_signings TO authenticated;

CREATE OR REPLACE FUNCTION app_private.guard_contract_draft_signing_source_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP='DELETE' OR (to_jsonb(NEW)-'official_document_sha256') IS DISTINCT FROM (to_jsonb(OLD)-'official_document_sha256')
    OR (OLD.official_document_sha256 IS NOT NULL AND NEW.official_document_sha256 IS DISTINCT FROM OLD.official_document_sha256) THEN
    RAISE EXCEPTION 'Nguồn hợp đồng đã ký và bản tải đã đăng ký là bất biến' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_contract_draft_signing_source_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS guard_contract_draft_signing_source_v1 ON public.contract_draft_signings;
CREATE TRIGGER guard_contract_draft_signing_source_v1 BEFORE UPDATE OR DELETE ON public.contract_draft_signings FOR EACH ROW EXECUTE FUNCTION app_private.guard_contract_draft_signing_source_v1();

CREATE OR REPLACE FUNCTION app_private.guard_signed_contract_draft_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF OLD.status='SIGNED' THEN RAISE EXCEPTION 'Bản nháp đã ký không thể sửa hoặc xoá' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.status='SIGNED' THEN
    IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.revision<>OLD.revision OR NEW.room_id IS DISTINCT FROM OLD.room_id
      OR NEW.building_id<>OLD.building_id OR NEW.organization_id<>OLD.organization_id OR NEW.template_id IS DISTINCT FROM OLD.template_id
      OR NOT EXISTS (SELECT 1 FROM public.contract_draft_signings s WHERE s.draft_id=OLD.id AND s.revision=OLD.revision
        AND s.contract_id=NEW.converted_contract_id AND s.organization_id=OLD.organization_id AND s.building_id=OLD.building_id AND s.room_id=OLD.room_id) THEN
      RAISE EXCEPTION 'Nguồn hợp đồng đã ký không khớp bản nháp' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.converted_contract_id IS NOT NULL THEN RAISE EXCEPTION 'Liên kết hợp đồng chỉ được ghi khi ký' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.guard_signed_contract_draft_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS guard_signed_contract_draft_v1 ON public.contract_drafts;
CREATE TRIGGER guard_signed_contract_draft_v1 BEFORE UPDATE OR DELETE ON public.contract_drafts FOR EACH ROW EXECUTE FUNCTION app_private.guard_signed_contract_draft_v1();

CREATE OR REPLACE FUNCTION public.read_contract_draft_signing_v1(p_organization_id uuid,p_draft_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE d public.contract_drafts%ROWTYPE; s public.contract_draft_signings%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.contract_drafts WHERE id=p_draft_id AND organization_id=p_organization_id;
  IF NOT FOUND OR NOT app_private.contract_draft_scope_allowed(p_organization_id,d.building_id,'contracts.view') THEN
    RAISE EXCEPTION 'Không có quyền xem nguồn ký hợp đồng' USING ERRCODE='42501';
  END IF;
  SELECT * INTO s FROM public.contract_draft_signings WHERE draft_id=d.id;
  RETURN jsonb_build_object('server_today',public.org_today_v1(p_organization_id),'signing',CASE WHEN s.id IS NULL THEN NULL ELSE to_jsonb(s)-'intent_hash' END);
END $$;

DROP FUNCTION IF EXISTS public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb);
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
    ('deposit_debt_mode','deposit_debt_reason','deposit_topup_due_date','first_invoice')) THEN
    RAISE EXCEPTION 'Lựa chọn tạo hợp đồng không hợp lệ; nhánh này không chuyển giữ chỗ hoặc thu cọc' USING ERRCODE='22023';
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
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_terms->'services') j
    WHERE (j->>'type'='METER_READING' OR j->>'pricing_type'='METER') AND NOT EXISTS (
      SELECT 1 FROM public.meters m WHERE m.organization_id=p_organization_id AND m.room_id=r.id AND m.building_id=d.building_id
        AND m.service_id=(j->>'id')::uuid AND m.status='ACTIVE' AND m.deleted_at IS NULL)) THEN
    RAISE EXCEPTION 'Dịch vụ đo chỉ số chưa có đồng hồ đang hoạt động gắn đúng phòng và dịch vụ' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT m.service_id FROM public.meters m JOIN jsonb_array_elements(p_boundary->'readings') b ON m.id=(b->>'meter_id')::uuid
    WHERE m.organization_id=p_organization_id AND m.room_id=r.id AND m.building_id=d.building_id AND m.status='ACTIVE' AND m.deleted_at IS NULL
      AND m.service_id IN (SELECT (j->>'id')::uuid FROM jsonb_array_elements(v_terms->'services') j)
    GROUP BY m.service_id HAVING count(DISTINCT (b->>'reading')::numeric)>1) THEN
    RAISE EXCEPTION 'Nhiều đồng hồ của cùng dịch vụ có số đầu khác nhau; chưa thể ánh xạ vào dịch vụ hiện hành' USING ERRCODE='22023';
  END IF;
  v_payload:=jsonb_build_object('contract',jsonb_build_object('room_id',r.id,'signed_date',f->>'signed_date','start_date',f->>'start_date',
    'end_date',f->>'end_date','rent_price',f->'rent_price','total_deposit',f->'total_deposit','payment_cycle',f->>'payment_cycle',
    'start_billing_date',NULLIF(f->>'start_billing_date',''),'end_billing_date',NULLIF(f->>'end_billing_date',''),'notes',f->>'notes',
    'contract_template_id',d.template_id,'discounts',jsonb_build_object('months',f->'discount_months','amount_per_month',f->'discount_amount_per_month'))
    ||(p_creation_options-'first_invoice'),
    'customers',(SELECT jsonb_agg(jsonb_build_object('customer_id',j->>'id','is_representative',j->'is_representative','notes',j->'notes')) FROM jsonb_array_elements(v_terms->'customers') j),
    'services',COALESCE((SELECT jsonb_agg(jsonb_build_object('service_id',j->>'id','unit_price',j->'unit_price','initial_reading',
      COALESCE((SELECT to_jsonb(min((b->>'reading')::numeric)) FROM public.meters m JOIN jsonb_array_elements(p_boundary->'readings') b ON m.id=(b->>'meter_id')::uuid
        WHERE m.organization_id=p_organization_id AND m.room_id=r.id AND m.building_id=d.building_id AND m.service_id=(j->>'id')::uuid
          AND m.status='ACTIVE' AND m.deleted_at IS NULL),j->'initial_reading'))) FROM jsonb_array_elements(v_terms->'services') j),'[]'::jsonb),
    'deposit_receipts','[]'::jsonb,'existing_deposit_voucher_ids',to_jsonb(COALESCE(p_source_voucher_ids,ARRAY[]::uuid[])));
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

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('contract-signed-documents','contract-signed-documents',false,20971520,ARRAY['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=EXCLUDED.file_size_limit,allowed_mime_types=EXCLUDED.allowed_mime_types;
CREATE OR REPLACE FUNCTION app_private.contract_signed_storage_allowed_v1(p_name text,p_write boolean)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS (SELECT 1 FROM public.contract_draft_signings s WHERE s.official_document_path=p_name
    AND app_private.contract_draft_scope_allowed(s.organization_id,s.building_id,'contracts.view')
    AND app_private.contract_draft_scope_allowed(s.organization_id,s.building_id,'contracts.print')
    AND (NOT p_write OR s.official_document_sha256 IS NULL))
$$;
REVOKE ALL ON FUNCTION app_private.contract_signed_storage_allowed_v1(text,boolean) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION app_private.contract_signed_storage_allowed_v1(text,boolean) TO authenticated;
DROP POLICY IF EXISTS contract_signed_documents_select ON storage.objects;
CREATE POLICY contract_signed_documents_select ON storage.objects FOR SELECT TO authenticated USING(bucket_id='contract-signed-documents' AND app_private.contract_signed_storage_allowed_v1(name,false));
DROP POLICY IF EXISTS contract_signed_documents_insert ON storage.objects;
CREATE POLICY contract_signed_documents_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK(bucket_id='contract-signed-documents' AND app_private.contract_signed_storage_allowed_v1(name,true));
DROP POLICY IF EXISTS contract_signed_documents_select_fence ON storage.objects;
CREATE POLICY contract_signed_documents_select_fence ON storage.objects AS RESTRICTIVE FOR SELECT TO public USING(bucket_id<>'contract-signed-documents' OR app_private.contract_signed_storage_allowed_v1(name,false));
DROP POLICY IF EXISTS contract_signed_documents_insert_fence ON storage.objects;
CREATE POLICY contract_signed_documents_insert_fence ON storage.objects AS RESTRICTIVE FOR INSERT TO public WITH CHECK(bucket_id<>'contract-signed-documents' OR app_private.contract_signed_storage_allowed_v1(name,true));
DROP POLICY IF EXISTS contract_signed_documents_update_fence ON storage.objects;
CREATE POLICY contract_signed_documents_update_fence ON storage.objects AS RESTRICTIVE FOR UPDATE TO public USING(bucket_id<>'contract-signed-documents') WITH CHECK(bucket_id<>'contract-signed-documents');
DROP POLICY IF EXISTS contract_signed_documents_delete_fence ON storage.objects;
CREATE POLICY contract_signed_documents_delete_fence ON storage.objects AS RESTRICTIVE FOR DELETE TO public USING(bucket_id<>'contract-signed-documents');

CREATE OR REPLACE FUNCTION public.register_contract_signed_document_v1(p_organization_id uuid,p_signing_id uuid,p_document_sha256 text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.contract_draft_signings%ROWTYPE;
BEGIN
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO s FROM public.contract_draft_signings WHERE id=p_signing_id AND organization_id=p_organization_id FOR UPDATE;
  IF NOT FOUND OR NOT app_private.contract_draft_scope_allowed(p_organization_id,s.building_id,'contracts.view')
    OR NOT app_private.contract_draft_scope_allowed(p_organization_id,s.building_id,'contracts.print') THEN
    RAISE EXCEPTION 'Không có quyền tạo bản tải hợp đồng' USING ERRCODE='42501';
  END IF;
  IF p_document_sha256 IS NULL OR p_document_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Hash tài liệu không hợp lệ' USING ERRCODE='22023'; END IF;
  IF s.official_document_sha256 IS NOT NULL THEN
    IF s.official_document_sha256<>p_document_sha256 THEN RAISE EXCEPTION 'Bản tải đã đăng ký với nội dung khác' USING ERRCODE='23505'; END IF;
    RETURN to_jsonb(s)-'intent_hash';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='contract-signed-documents' AND name=s.official_document_path) THEN
    RAISE EXCEPTION 'Chưa tải lên bản hợp đồng' USING ERRCODE='22023';
  END IF;
  UPDATE public.contract_draft_signings SET official_document_sha256=p_document_sha256 WHERE id=s.id RETURNING * INTO s;
  RETURN to_jsonb(s)-'intent_hash';
END $$;
REVOKE ALL ON FUNCTION public.read_contract_draft_signing_v1(uuid,uuid) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[]) FROM PUBLIC,anon,service_role;
REVOKE ALL ON FUNCTION public.register_contract_signed_document_v1(uuid,uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.read_contract_draft_signing_v1(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sign_and_checkin_contract_draft_v1(uuid,uuid,integer,uuid,text,uuid,date,boolean,boolean,jsonb,jsonb,uuid,bigint,uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_contract_signed_document_v1(uuid,uuid,text) TO authenticated;
