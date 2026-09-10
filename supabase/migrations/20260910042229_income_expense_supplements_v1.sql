-- Supplemental narrative is separate from machine-read voucher notes. No header
-- UPDATE, accounting capability, financial guard replacement or legacy RPC change.
BEGIN;

CREATE TABLE public.income_expense_supplements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  income_expense_id uuid NOT NULL REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  note text,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  actor_id uuid NOT NULL,
  actor_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (note IS NULL OR length(note)<=5000),
  CHECK (jsonb_typeof(attachments)='array' AND jsonb_array_length(attachments)<=20),
  CHECK (NULLIF(btrim(note),'') IS NOT NULL OR jsonb_array_length(attachments)>0)
);
CREATE INDEX income_expense_supplements_voucher_order ON public.income_expense_supplements(income_expense_id,created_at,id);
CREATE INDEX income_expense_supplements_org ON public.income_expense_supplements(organization_id);
ALTER TABLE public.income_expense_supplements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.income_expense_supplements FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.income_expense_supplements TO authenticated;

CREATE TABLE app_private.ie_supplement_requests (
  income_expense_id uuid NOT NULL REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  request_payload jsonb NOT NULL,
  supplement_id uuid NOT NULL REFERENCES public.income_expense_supplements(id) ON DELETE RESTRICT,
  PRIMARY KEY(income_expense_id,actor_id,idempotency_key)
);
-- Actual object identities avoid reparsing JSON for every Storage policy check.
CREATE TABLE app_private.ie_supplement_objects (
  supplement_id uuid NOT NULL REFERENCES public.income_expense_supplements(id) ON DELETE RESTRICT,
  object_id uuid NOT NULL REFERENCES storage.objects(id) ON DELETE RESTRICT,
  bucket_id text NOT NULL,
  object_name text NOT NULL,
  PRIMARY KEY(supplement_id,object_id)
);
CREATE INDEX ie_supplement_objects_path ON app_private.ie_supplement_objects(bucket_id,object_name);
CREATE INDEX ie_supplement_objects_id ON app_private.ie_supplement_objects(object_id);
REVOKE ALL ON app_private.ie_supplement_requests,app_private.ie_supplement_objects FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app_private.ie_supplement_can_read_v1(p_voucher uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
  SELECT EXISTS(SELECT 1 FROM public.income_expenses v WHERE v.id=p_voucher
    AND auth.uid() IS NOT NULL AND v.deleted_at IS NULL
    AND (EXISTS(SELECT 1 FROM public.organization_memberships m WHERE m.organization_id=v.organization_id
      AND m.user_id=auth.uid() AND m.status='ACTIVE'
      AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=now() AND (m.valid_to IS NULL OR m.valid_to>now()))
      OR public.is_super_admin())
    AND NOT(public.is_super_admin() AND COALESCE(v.organization_id=ANY(public.sandbox_org_ids()),false))
    AND NOT((public.is_super_admin() OR public.is_admin()) AND COALESCE(v.user_id=ANY(public.demo_user_ids()),false))
    AND (v.building_id IS NULL OR public.can_access_building(v.building_id))
    -- Match the existing permissive read routes after the tenant/building gate.
    AND (public.is_super_admin() OR public.is_admin()
      OR (v.building_id IS NOT NULL AND (public.has_full_building_scope() OR v.building_id IN(SELECT public.accessible_building_ids())))
      OR v.account_id IN(SELECT public.accessible_account_ids())
      OR v.change_account_id IN(SELECT public.accessible_account_ids())
      OR v.rounding_account_id IN(SELECT public.accessible_account_ids())
      OR v.profit_manager_id=public.current_profit_manager_id()
      OR v.salary_staff_id=auth.uid() OR v.shareholder_id=public.current_shareholder_id())
    AND (v.has_restricted_item=false OR v.user_id=auth.uid() OR public.can_view_restricted_ie()));
$$;
REVOKE ALL ON FUNCTION app_private.ie_supplement_can_read_v1(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION app_private.ie_supplement_can_read_v1(uuid) TO authenticated;
CREATE POLICY income_expense_supplements_select ON public.income_expense_supplements FOR SELECT TO authenticated
  USING(app_private.ie_supplement_can_read_v1(income_expense_id));
CREATE POLICY income_expense_supplements_hide_sandbox_admin ON public.income_expense_supplements AS RESTRICTIVE FOR SELECT TO authenticated
  USING(NOT((SELECT public.is_super_admin()) AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)));

CREATE FUNCTION app_private.ie_supplement_immutable_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Nội dung bổ sung đã lưu không được sửa hoặc xóa' USING ERRCODE='55000'; END $$;
REVOKE ALL ON FUNCTION app_private.ie_supplement_immutable_v1() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER ie_supplement_immutable BEFORE UPDATE OR DELETE ON public.income_expense_supplements
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_supplement_immutable_v1();
CREATE TRIGGER ie_supplement_no_truncate BEFORE TRUNCATE ON public.income_expense_supplements
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.ie_supplement_immutable_v1();
CREATE TRIGGER ie_supplement_objects_immutable BEFORE UPDATE OR DELETE ON app_private.ie_supplement_objects
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_supplement_immutable_v1();
CREATE TRIGGER ie_supplement_objects_no_truncate BEFORE TRUNCATE ON app_private.ie_supplement_objects
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.ie_supplement_immutable_v1();
CREATE TRIGGER ie_supplement_requests_immutable BEFORE UPDATE OR DELETE ON app_private.ie_supplement_requests
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_supplement_immutable_v1();

CREATE FUNCTION app_private.ie_storage_is_supplement_v1(p_bucket text,p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
  SELECT EXISTS(SELECT 1 FROM app_private.ie_supplement_objects WHERE bucket_id=p_bucket AND object_name=p_name);
$$;
REVOKE ALL ON FUNCTION app_private.ie_storage_is_supplement_v1(text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION app_private.ie_storage_is_supplement_v1(text,text) TO authenticated;
CREATE POLICY ie_supplement_storage_no_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
  USING(NOT app_private.ie_storage_is_supplement_v1(bucket_id,name));
CREATE POLICY ie_supplement_storage_no_replace ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
  USING(NOT app_private.ie_storage_is_supplement_v1(bucket_id,name))
  WITH CHECK(NOT app_private.ie_storage_is_supplement_v1(bucket_id,name));
-- Storage service paths can bypass RLS. Keep object identity/content metadata and
-- the tenant link immutable at the database boundary as well as client policies.
CREATE FUNCTION app_private.ie_supplement_storage_guard_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
BEGIN
  IF TG_TABLE_SCHEMA='storage' THEN
    IF EXISTS(SELECT 1 FROM app_private.ie_supplement_objects WHERE object_id=OLD.id) THEN
      RAISE EXCEPTION 'Chứng từ bổ sung đã lưu không được thay thế hoặc xóa' USING ERRCODE='55000';
    END IF;
  ELSIF app_private.ie_storage_is_supplement_v1(OLD.bucket_id,OLD.object_name) THEN
    RAISE EXCEPTION 'Liên kết chứng từ bổ sung không được thay đổi' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.ie_supplement_storage_guard_v1() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER a00_ie_supplement_storage_guard BEFORE UPDATE OR DELETE ON storage.objects
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_supplement_storage_guard_v1();
CREATE TRIGGER a00_ie_supplement_link_guard BEFORE UPDATE OR DELETE ON app_private.storage_object_links
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_supplement_storage_guard_v1();

CREATE FUNCTION public.append_income_expense_supplement_v1(p_voucher uuid,p_note text DEFAULT NULL,
  p_attachments jsonb DEFAULT '[]',p_idempotency_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE v public.income_expenses; membership uuid; key text; narrative text; refs jsonb; payload jsonb;
  previous app_private.ie_supplement_requests; entry_id uuid:=gen_random_uuid(); actor_name text;
  item jsonb; ref text; path text; stored storage.objects; object_ids uuid[]:=ARRAY[]::uuid[];
BEGIN
  IF auth.uid() IS NULL OR NOT app_private.ie_supplement_can_read_v1(p_voucher) THEN
    RAISE EXCEPTION 'Không có quyền bổ sung phiếu này' USING ERRCODE='42501';
  END IF;
  -- Lock only; touching even notes/updated_at would enter financial/source guards.
  SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher FOR UPDATE;
  IF NOT FOUND OR NOT app_private.ie_supplement_can_read_v1(p_voucher) THEN
    RAISE EXCEPTION 'Không có quyền bổ sung phiếu này' USING ERRCODE='42501';
  END IF;
  SELECT m.id INTO membership FROM public.organization_memberships m WHERE m.user_id=auth.uid()
    AND m.organization_id=v.organization_id AND m.status='ACTIVE'
    AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=now() AND (m.valid_to IS NULL OR m.valid_to>now());
  IF NOT (public.is_super_admin() OR app_private.is_org_owner_v1(v.organization_id,auth.uid())
    OR app_private.ie_can_edit_money_axis_v1(v.organization_id,v.building_id)
    OR v.user_id=auth.uid() OR app_private.ie_has_cashbook_possession_v1(v.organization_id,v.account_id,membership)) THEN
    RAISE EXCEPTION 'Không có quyền bổ sung ảnh hoặc ghi chú' USING ERRCODE='42501';
  END IF;
  key:=NULLIF(btrim(p_idempotency_key),'');
  IF key IS NULL OR length(p_idempotency_key)>200 OR length(p_note)>5000
    OR jsonb_typeof(p_attachments) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Nội dung bổ sung không hợp lệ' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_attachments)>20 THEN RAISE EXCEPTION 'Tối đa 20 tệp mỗi lần bổ sung' USING ERRCODE='22023'; END IF;
  narrative:=CASE WHEN NULLIF(btrim(p_note),'') IS NULL THEN NULL ELSE p_note END;
  FOR item IN SELECT value FROM jsonb_array_elements(p_attachments) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Đường dẫn chứng từ không hợp lệ' USING ERRCODE='22023'; END IF;
    ref:=item #>> '{}';
    -- This project's durable public-reference shape. Signed URLs and arbitrary
    -- hosts are rejected; the private bucket is still signed only at read time.
    IF length(ref)>2048 OR ref !~ '^https://tryymsxyyckgbrmmvozx[.]supabase[.]co/storage/v1/object/public/income-expense-attachments/[0-9a-f-]{36}/[A-Za-z0-9_.-]+[.](jpg|jpeg|png|webp|pdf)$'
      OR ref LIKE '%..%' OR split_part(split_part(ref,'/income-expense-attachments/',2),'/',1)<>auth.uid()::text THEN
      RAISE EXCEPTION 'Đường dẫn chứng từ không hợp lệ' USING ERRCODE='22023';
    END IF;
  END LOOP;
  SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]'::jsonb) INTO refs FROM(SELECT DISTINCT value FROM jsonb_array_elements(p_attachments)) x;
  IF narrative IS NULL AND jsonb_array_length(refs)=0 THEN RAISE EXCEPTION 'Vui lòng thêm ghi chú hoặc ảnh' USING ERRCODE='22023'; END IF;
  payload:=jsonb_build_object('note',narrative,'attachments',refs);
  SELECT * INTO previous FROM app_private.ie_supplement_requests WHERE income_expense_id=p_voucher AND actor_id=auth.uid() AND idempotency_key=key;
  IF FOUND THEN
    IF previous.request_payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'Mã yêu cầu đã dùng với nội dung khác' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('id',previous.supplement_id,'income_expense_id',p_voucher,'changed',false,'replayed',true);
  END IF;
  FOR ref IN SELECT value FROM jsonb_array_elements_text(refs) ORDER BY value LOOP
    path:=split_part(ref,'/income-expense-attachments/',2);
    SELECT * INTO stored FROM storage.objects WHERE bucket_id='income-expense-attachments' AND name=path FOR UPDATE;
    IF NOT FOUND OR COALESCE(stored.owner_id,stored.owner::text) IS DISTINCT FROM auth.uid()::text
      OR stored.archived_at IS NOT NULL OR COALESCE(stored.is_delete_marker,false) THEN
      RAISE EXCEPTION 'Chứng từ phải là tệp đã tải lên còn tồn tại của bạn' USING ERRCODE='22023';
    END IF;
    INSERT INTO app_private.storage_object_links AS link(bucket_id,object_name,organization_id,owner_user_id,derivation)
      VALUES(stored.bucket_id,stored.name,v.organization_id,auth.uid(),'IE_SUPPLEMENT')
      ON CONFLICT(bucket_id,object_name) DO UPDATE SET organization_id=EXCLUDED.organization_id,derivation=EXCLUDED.derivation
      WHERE link.organization_id IS NULL AND link.owner_user_id=auth.uid();
    PERFORM 1 FROM app_private.storage_object_links WHERE bucket_id=stored.bucket_id AND object_name=stored.name
      AND organization_id=v.organization_id AND owner_user_id=auth.uid() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Chứng từ không thuộc tổ chức của phiếu' USING ERRCODE='22023'; END IF;
    object_ids:=array_append(object_ids,stored.id);
  END LOOP;
  SELECT COALESCE(NULLIF(btrim(full_name),''),NULLIF(btrim(email),''),'Người dùng') INTO actor_name FROM public.profiles WHERE id=auth.uid();
  INSERT INTO public.income_expense_supplements(id,organization_id,income_expense_id,note,attachments,actor_id,actor_name)
    VALUES(entry_id,v.organization_id,v.id,narrative,refs,auth.uid(),COALESCE(actor_name,'Người dùng'));
  INSERT INTO app_private.ie_supplement_objects(supplement_id,object_id,bucket_id,object_name)
    SELECT entry_id,id,bucket_id,name FROM storage.objects WHERE id=ANY(object_ids);
  INSERT INTO app_private.ie_supplement_requests(income_expense_id,actor_id,idempotency_key,request_payload,supplement_id)
    VALUES(v.id,auth.uid(),key,payload,entry_id);
  RETURN jsonb_build_object('id',entry_id,'income_expense_id',v.id,'changed',true,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.append_income_expense_supplement_v1(uuid,text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.append_income_expense_supplement_v1(uuid,text,jsonb,text) TO authenticated;
ALTER PUBLICATION supabase_realtime ADD TABLE public.income_expense_supplements;

COMMIT;
