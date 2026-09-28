-- Persisted drafts are isolated from official contracts, reservations and accounting.
-- Only the additive draft tables and a private immutable document bucket are written.
CREATE TABLE IF NOT EXISTS public.contract_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  building_id uuid NOT NULL REFERENCES public.buildings(id),
  room_id uuid REFERENCES public.rooms(id),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  template_id uuid,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_drafts_scope_idx ON public.contract_drafts(organization_id, building_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS public.contract_draft_versions (
  draft_id uuid NOT NULL REFERENCES public.contract_drafts(id),
  revision integer NOT NULL CHECK (revision > 0),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  building_id uuid NOT NULL REFERENCES public.buildings(id),
  room_id uuid,
  payload jsonb NOT NULL,
  template_id uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  request_id uuid NOT NULL UNIQUE,
  PRIMARY KEY (draft_id, revision)
);
CREATE TABLE IF NOT EXISTS public.contract_draft_documents (
  id uuid PRIMARY KEY,
  draft_id uuid NOT NULL,
  revision integer NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  building_id uuid NOT NULL REFERENCES public.buildings(id),
  document_path text NOT NULL UNIQUE,
  template_path text NOT NULL UNIQUE,
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[a-f0-9]{64}$'),
  template_sha256 text NOT NULL CHECK (template_sha256 ~ '^[a-f0-9]{64}$'),
  template_snapshot jsonb NOT NULL,
  document_data jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, revision),
  FOREIGN KEY (draft_id, revision) REFERENCES public.contract_draft_versions(draft_id, revision)
);

CREATE OR REPLACE FUNCTION app_private.contract_draft_scope_allowed(p_organization_id uuid, p_building_id uuid, p_action text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL
    AND p_action IN ('contracts.view', 'contracts.create', 'contracts.edit', 'contracts.print')
    AND p_organization_id = ANY(public.my_org_ids())
    AND NOT COALESCE(public.is_super_admin() AND p_organization_id = ANY(public.sandbox_org_ids()), false)
    AND EXISTS (SELECT 1 FROM public.buildings b JOIN public.organizations o ON o.id = b.organization_id
      WHERE b.id = p_building_id AND b.organization_id = p_organization_id AND b.deleted_at IS NULL
      AND o.status = 'ACTIVE' AND public.can_access_building(b.id))
    AND COALESCE((SELECT s.org_wide OR p_building_id = ANY(s.building_ids)
      FROM app_private.authorized_scope_v3(p_action, p_organization_id) s), false)
$$;
REVOKE ALL ON FUNCTION app_private.contract_draft_scope_allowed(uuid, uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION app_private.contract_draft_scope_allowed(uuid, uuid, text) TO authenticated;

ALTER TABLE public.contract_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_draft_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_draft_documents ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE v_table text; BEGIN
  FOREACH v_table IN ARRAY ARRAY['contract_drafts','contract_draft_versions','contract_draft_documents'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_table || '_read', v_table);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (app_private.contract_draft_scope_allowed(organization_id, building_id, ''contracts.view''))', v_table || '_read', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_table || '_hide_sandbox_admin', v_table);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (NOT COALESCE(public.is_super_admin() AND organization_id = ANY(public.sandbox_org_ids()), false)) WITH CHECK (NOT COALESCE(public.is_super_admin() AND organization_id = ANY(public.sandbox_org_ids()), false))', v_table || '_hide_sandbox_admin', v_table);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role', v_table);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_table);
  END LOOP;
END $$;

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
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('form','customers','services','use_custom_services','owner'))
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

CREATE OR REPLACE FUNCTION public.list_contract_drafts(p_organization_id uuid, p_building_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id = ANY(public.my_org_ids()), false) THEN
    RAISE EXCEPTION 'Không có quyền đọc bản nháp' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(d) || jsonb_build_object('documents',
      COALESCE((SELECT jsonb_agg(to_jsonb(x) - 'document_data' ORDER BY x.created_at DESC) FROM public.contract_draft_documents x WHERE x.draft_id = d.id), '[]'::jsonb)) ORDER BY d.updated_at DESC)
    FROM public.contract_drafts d WHERE d.organization_id = p_organization_id
      AND (p_building_id IS NULL OR d.building_id = p_building_id)
      AND app_private.contract_draft_scope_allowed(d.organization_id, d.building_id, 'contracts.view')), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.register_contract_draft_document(
  p_organization_id uuid, p_draft_id uuid, p_expected_revision integer, p_document_id uuid,
  p_template_id uuid, p_template_snapshot jsonb, p_document_sha256 text, p_template_sha256 text, p_document_data jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_draft public.contract_drafts%ROWTYPE; v_root text; v_document public.contract_draft_documents%ROWTYPE; v_form jsonb; v_rep jsonb; v_allowed boolean;
BEGIN
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT * INTO v_draft FROM public.contract_drafts WHERE id = p_draft_id AND organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND OR NOT app_private.contract_draft_scope_allowed(p_organization_id, v_draft.building_id, 'contracts.print')
    OR NOT (app_private.contract_draft_scope_allowed(p_organization_id, v_draft.building_id, 'contracts.create')
      OR app_private.contract_draft_scope_allowed(p_organization_id, v_draft.building_id, 'contracts.edit')) THEN
    RAISE EXCEPTION 'Không có quyền xuất bản nháp' USING ERRCODE = '42501';
  END IF;
  SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'contracts.print',v_draft.building_id,NULL);
  IF NOT COALESCE(v_allowed,false) THEN RAISE EXCEPTION 'Không có quyền xuất bản nháp' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_document FROM public.contract_draft_documents WHERE draft_id=p_draft_id AND revision=p_expected_revision;
  IF FOUND THEN RETURN to_jsonb(v_document) - 'document_data'; END IF;
  IF p_expected_revision IS NULL OR v_draft.revision <> p_expected_revision THEN RAISE EXCEPTION 'Bản nháp đã thay đổi' USING ERRCODE = '40001'; END IF;
  v_form := v_draft.payload->'form';
  SELECT value INTO v_rep FROM jsonb_array_elements(v_draft.payload->'customers') WHERE value->>'is_representative' = 'true';
  IF v_draft.room_id IS NULL OR COALESCE(v_form->>'signed_date','') = '' OR COALESCE(v_form->>'start_date','') = ''
    OR COALESCE(v_form->>'end_date','') = '' OR COALESCE(v_rep->>'full_name','') = '' OR COALESCE(v_rep->>'id_number','') = ''
    OR (SELECT count(*) FROM jsonb_array_elements(v_draft.payload->'customers') WHERE value->>'is_representative' = 'true') <> 1 THEN
    RAISE EXCEPTION 'Thiếu thông tin tài liệu nháp' USING ERRCODE = '22023';
  END IF;
  BEGIN
    IF (v_form->>'end_date')::date <= (v_form->>'start_date')::date THEN RAISE EXCEPTION 'Hạn hợp đồng không hợp lệ' USING ERRCODE = '22023'; END IF;
    PERFORM (v_form->>'signed_date')::date;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'Ngày nháp không hợp lệ' USING ERRCODE = '22023'; END;
  IF v_draft.template_id IS DISTINCT FROM p_template_id OR NOT EXISTS (SELECT 1 FROM public.document_templates t WHERE t.id = p_template_id
    AND t.organization_id = p_organization_id AND t.deleted_at IS NULL AND t.is_active AND t.type = 'lease_contract')
    OR p_template_snapshot->>'id' IS DISTINCT FROM p_template_id::text
    OR jsonb_typeof(p_template_snapshot) <> 'object' OR jsonb_typeof(p_document_data) <> 'object'
    OR p_document_sha256 !~ '^[a-f0-9]{64}$' OR p_template_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Snapshot tài liệu không hợp lệ' USING ERRCODE = '22023';
  END IF;
  v_root := p_organization_id::text || '/' || v_draft.building_id::text || '/' || p_draft_id::text || '/' || p_expected_revision::text || '/' || p_document_id::text;
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'contract-draft-documents' AND name = v_root || '/document.docx' AND owner_id = auth.uid()::text)
    OR NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'contract-draft-documents' AND name = v_root || '/template.docx' AND owner_id = auth.uid()::text) THEN
    RAISE EXCEPTION 'Chưa lưu đủ tài liệu nháp' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.contract_draft_documents(id,draft_id,revision,organization_id,building_id,document_path,template_path,document_sha256,template_sha256,template_snapshot,document_data,created_by)
    VALUES(p_document_id,p_draft_id,p_expected_revision,p_organization_id,v_draft.building_id,v_root || '/document.docx',v_root || '/template.docx',p_document_sha256,p_template_sha256,p_template_snapshot,p_document_data,auth.uid())
    RETURNING * INTO v_document;
  RETURN to_jsonb(v_document) - 'document_data';
END $$;

REVOKE ALL ON FUNCTION public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.list_contract_drafts(uuid,uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.register_contract_draft_document(uuid,uuid,integer,uuid,uuid,jsonb,text,text,jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.save_contract_draft(uuid,uuid,uuid,jsonb,uuid,uuid,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_contract_drafts(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_contract_draft_document(uuid,uuid,integer,uuid,uuid,jsonb,text,text,jsonb) TO authenticated;

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('contract-draft-documents','contract-draft-documents',false,10485760,ARRAY['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
ON CONFLICT(id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE OR REPLACE FUNCTION app_private.contract_draft_storage_allowed(p_name text, p_write boolean)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_parts text[] := string_to_array(p_name, '/'); v_draft public.contract_drafts%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  IF array_length(v_parts,1) <> 6 OR v_parts[1] !~ '^[a-f0-9-]{36}$' OR v_parts[2] !~ '^[a-f0-9-]{36}$'
    OR v_parts[3] !~ '^[a-f0-9-]{36}$' OR v_parts[4] !~ '^[1-9][0-9]{0,8}$' OR v_parts[5] !~ '^[a-f0-9-]{36}$'
    OR v_parts[6] NOT IN ('document.docx','template.docx') THEN RETURN false; END IF;
  SELECT * INTO v_draft FROM public.contract_drafts WHERE id = v_parts[3]::uuid AND organization_id = v_parts[1]::uuid AND building_id = v_parts[2]::uuid;
  IF NOT FOUND OR NOT app_private.contract_draft_scope_allowed(v_draft.organization_id,v_draft.building_id,'contracts.view')
    OR NOT app_private.contract_draft_scope_allowed(v_draft.organization_id,v_draft.building_id,'contracts.print') THEN RETURN false; END IF;
  IF NOT p_write THEN RETURN true; END IF;
  RETURN v_draft.revision = v_parts[4]::integer
    AND (app_private.contract_draft_scope_allowed(v_draft.organization_id,v_draft.building_id,'contracts.create') OR app_private.contract_draft_scope_allowed(v_draft.organization_id,v_draft.building_id,'contracts.edit'));
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION app_private.contract_draft_storage_allowed(text,boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION app_private.contract_draft_storage_allowed(text,boolean) TO authenticated;
DROP POLICY IF EXISTS contract_draft_documents_read ON storage.objects;
CREATE POLICY contract_draft_documents_read ON storage.objects FOR SELECT TO authenticated
USING(bucket_id = 'contract-draft-documents' AND app_private.contract_draft_storage_allowed(name,false));
DROP POLICY IF EXISTS contract_draft_documents_insert ON storage.objects;
CREATE POLICY contract_draft_documents_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK(bucket_id = 'contract-draft-documents' AND app_private.contract_draft_storage_allowed(name,true));
DROP POLICY IF EXISTS contract_draft_documents_cleanup ON storage.objects;
CREATE POLICY contract_draft_documents_cleanup ON storage.objects FOR DELETE TO authenticated
USING(bucket_id = 'contract-draft-documents' AND owner_id = auth.uid()::text AND app_private.contract_draft_storage_allowed(name,false)
  AND NOT EXISTS (SELECT 1 FROM public.contract_draft_documents d WHERE d.document_path = name OR d.template_path = name));
-- Existing generic storage policies are permissive (OR). Fence only this new bucket.
DROP POLICY IF EXISTS contract_draft_storage_read_scope ON storage.objects;
CREATE POLICY contract_draft_storage_read_scope ON storage.objects AS RESTRICTIVE FOR SELECT TO authenticated
USING(bucket_id <> 'contract-draft-documents' OR app_private.contract_draft_storage_allowed(name,false));
DROP POLICY IF EXISTS contract_draft_storage_insert_scope ON storage.objects;
CREATE POLICY contract_draft_storage_insert_scope ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK(bucket_id <> 'contract-draft-documents' OR app_private.contract_draft_storage_allowed(name,true));
DROP POLICY IF EXISTS contract_draft_storage_no_replace ON storage.objects;
CREATE POLICY contract_draft_storage_no_replace ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
USING(bucket_id <> 'contract-draft-documents') WITH CHECK(bucket_id <> 'contract-draft-documents');
DROP POLICY IF EXISTS contract_draft_storage_delete_scope ON storage.objects;
CREATE POLICY contract_draft_storage_delete_scope ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
USING(bucket_id <> 'contract-draft-documents' OR (owner_id = auth.uid()::text AND app_private.contract_draft_storage_allowed(name,false)
  AND NOT EXISTS (SELECT 1 FROM public.contract_draft_documents d WHERE d.document_path = name OR d.template_path = name)));
