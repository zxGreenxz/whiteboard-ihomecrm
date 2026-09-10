-- Supplemental narrative is separate from machine-read voucher notes. No header
-- UPDATE, accounting capability, financial guard replacement or legacy RPC change.
BEGIN;

-- The protected lane executes the candidate twice in one rollback transaction.
-- Existing table/index names are accepted only when their complete shape agrees;
-- IF NOT EXISTS alone could silently reuse an unrelated or weakened object.
DO $shape$
DECLARE spec record; relation_id oid; actual jsonb; previous_path text:=current_setting('search_path');
BEGIN
  PERFORM set_config('search_path','pg_catalog,public,app_private',true);
  FOR spec IN SELECT * FROM (VALUES
    ('public.income_expense_supplements',
      '["id:uuid:true:gen_random_uuid()","organization_id:uuid:true:-","income_expense_id:uuid:true:-","note:text:false:-","attachments:jsonb:true:''[]''::jsonb","actor_id:uuid:true:-","actor_name:text:true:-","created_at:timestamp with time zone:true:clock_timestamp()"]'::jsonb,
      '["CHECK (((NULLIF(btrim(note), ''''::text) IS NOT NULL) OR (jsonb_array_length(attachments) > 0)))","CHECK (((jsonb_typeof(attachments) = ''array''::text) AND (jsonb_array_length(attachments) <= 20)))","CHECK (((note IS NULL) OR (length(note) <= 5000)))","FOREIGN KEY (income_expense_id) REFERENCES income_expenses(id) ON DELETE RESTRICT","FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT","PRIMARY KEY (id)"]'::jsonb),
    ('app_private.ie_supplement_requests',
      '["income_expense_id:uuid:true:-","actor_id:uuid:true:-","idempotency_key:text:true:-","request_payload:jsonb:true:-","supplement_id:uuid:true:-"]'::jsonb,
      '["CHECK (((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 200)))","FOREIGN KEY (income_expense_id) REFERENCES income_expenses(id) ON DELETE RESTRICT","FOREIGN KEY (supplement_id) REFERENCES income_expense_supplements(id) ON DELETE RESTRICT","PRIMARY KEY (income_expense_id, actor_id, idempotency_key)"]'::jsonb),
    ('app_private.ie_supplement_objects',
      '["supplement_id:uuid:true:-","object_id:uuid:true:-","bucket_id:text:true:-","object_name:text:true:-"]'::jsonb,
      '["FOREIGN KEY (object_id) REFERENCES storage.objects(id) ON DELETE RESTRICT","FOREIGN KEY (supplement_id) REFERENCES income_expense_supplements(id) ON DELETE RESTRICT","PRIMARY KEY (supplement_id, object_id)"]'::jsonb)
  ) expected(name,columns,constraints) LOOP
    relation_id:=to_regclass(spec.name);
    IF relation_id IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=relation_id AND relkind='r' AND NOT relispartition
        AND relowner=current_user::regrole AND (spec.name<>'public.income_expense_supplements' OR relrowsecurity))
      OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=relation_id AND attnum>0
        AND (attisdropped OR attidentity<>'' OR attgenerated<>'' OR attacl IS NOT NULL)) THEN
      RAISE EXCEPTION 'Supplement schema mismatch: table %',spec.name USING ERRCODE='55000';
    END IF;
    SELECT jsonb_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||COALESCE(pg_get_expr(d.adbin,d.adrelid),'-') ORDER BY a.attnum)
      INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=relation_id AND a.attnum>0 AND NOT a.attisdropped;
    IF actual IS DISTINCT FROM spec.columns THEN
      RAISE EXCEPTION 'Supplement schema mismatch: columns %',spec.name USING ERRCODE='55000';
    END IF;
    SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) INTO actual
      FROM pg_constraint WHERE conrelid=relation_id;
    IF actual IS DISTINCT FROM spec.constraints THEN
      RAISE EXCEPTION 'Supplement schema mismatch: constraints %',spec.name USING ERRCODE='55000';
    END IF;
    -- Unknown policies could OR around our SELECT predicate. Unknown custom
    -- triggers/rules or grants could also create behavior this migration did not review.
    IF EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=relation_id AND
      (spec.name<>'public.income_expense_supplements' OR polname NOT IN
        ('income_expense_supplements_select','income_expense_supplements_hide_sandbox_admin','income_expense_supplements_org_boundary')))
      OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=relation_id
        AND polname='income_expense_supplements_org_boundary' AND polpermissive)
      OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=relation_id AND NOT tgisinternal AND tgname<>ALL(
        CASE spec.name WHEN 'public.income_expense_supplements' THEN ARRAY['ie_supplement_immutable','ie_supplement_no_truncate']
          WHEN 'app_private.ie_supplement_objects' THEN ARRAY['ie_supplement_objects_immutable','ie_supplement_objects_no_truncate']
          ELSE ARRAY['ie_supplement_requests_immutable'] END))
      OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=relation_id)
      OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl
        WHERE c.oid=relation_id AND acl.grantee<>c.relowner AND NOT
          (spec.name='public.income_expense_supplements' AND acl.grantee='authenticated'::regrole AND acl.privilege_type='SELECT' AND NOT acl.is_grantable)) THEN
      RAISE EXCEPTION 'Supplement schema mismatch: policies/triggers/ACL %',spec.name USING ERRCODE='55000';
    END IF;
    IF EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=relation_id
      AND c.relname<>ALL(CASE spec.name
        WHEN 'public.income_expense_supplements' THEN ARRAY['income_expense_supplements_pkey','income_expense_supplements_voucher_order','income_expense_supplements_org']
        WHEN 'app_private.ie_supplement_objects' THEN ARRAY['ie_supplement_objects_pkey','ie_supplement_objects_path','ie_supplement_objects_id']
        ELSE ARRAY['ie_supplement_requests_pkey'] END)) THEN
      RAISE EXCEPTION 'Supplement schema mismatch: unexpected index %',spec.name USING ERRCODE='55000';
    END IF;
  END LOOP;
  FOR spec IN SELECT * FROM (VALUES
    ('public.income_expense_supplements_voucher_order','CREATE INDEX income_expense_supplements_voucher_order ON public.income_expense_supplements USING btree (income_expense_id, created_at, id)'),
    ('public.income_expense_supplements_org','CREATE INDEX income_expense_supplements_org ON public.income_expense_supplements USING btree (organization_id)'),
    ('app_private.ie_supplement_objects_path','CREATE INDEX ie_supplement_objects_path ON app_private.ie_supplement_objects USING btree (bucket_id, object_name)'),
    ('app_private.ie_supplement_objects_id','CREATE INDEX ie_supplement_objects_id ON app_private.ie_supplement_objects USING btree (object_id)')
  ) expected(name,definition) LOOP
    relation_id:=to_regclass(spec.name);
    IF relation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=relation_id
      AND indisvalid AND indisready AND pg_get_indexdef(indexrelid)=spec.definition) THEN
      RAISE EXCEPTION 'Supplement schema mismatch: index %',spec.name USING ERRCODE='55000';
    END IF;
  END LOOP;
  PERFORM set_config('search_path',previous_path,true);
END $shape$;

CREATE TABLE IF NOT EXISTS public.income_expense_supplements (
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
CREATE INDEX IF NOT EXISTS income_expense_supplements_voucher_order ON public.income_expense_supplements(income_expense_id,created_at,id);
CREATE INDEX IF NOT EXISTS income_expense_supplements_org ON public.income_expense_supplements(organization_id);
ALTER TABLE public.income_expense_supplements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.income_expense_supplements FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.income_expense_supplements TO authenticated;

CREATE TABLE IF NOT EXISTS app_private.ie_supplement_requests (
  income_expense_id uuid NOT NULL REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  request_payload jsonb NOT NULL,
  supplement_id uuid NOT NULL REFERENCES public.income_expense_supplements(id) ON DELETE RESTRICT,
  PRIMARY KEY(income_expense_id,actor_id,idempotency_key)
);
-- Actual object identities avoid reparsing JSON for every Storage policy check.
CREATE TABLE IF NOT EXISTS app_private.ie_supplement_objects (
  supplement_id uuid NOT NULL REFERENCES public.income_expense_supplements(id) ON DELETE RESTRICT,
  object_id uuid NOT NULL REFERENCES storage.objects(id) ON DELETE RESTRICT,
  bucket_id text NOT NULL,
  object_name text NOT NULL,
  PRIMARY KEY(supplement_id,object_id)
);
CREATE INDEX IF NOT EXISTS ie_supplement_objects_path ON app_private.ie_supplement_objects(bucket_id,object_name);
CREATE INDEX IF NOT EXISTS ie_supplement_objects_id ON app_private.ie_supplement_objects(object_id);
REVOKE ALL ON app_private.ie_supplement_requests,app_private.ie_supplement_objects FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.ie_supplement_can_read_v1(p_voucher uuid)
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
DROP POLICY IF EXISTS income_expense_supplements_select ON public.income_expense_supplements;
CREATE POLICY income_expense_supplements_select ON public.income_expense_supplements FOR SELECT TO authenticated
  USING(app_private.ie_supplement_can_read_v1(income_expense_id));
DROP POLICY IF EXISTS income_expense_supplements_hide_sandbox_admin ON public.income_expense_supplements;
CREATE POLICY income_expense_supplements_hide_sandbox_admin ON public.income_expense_supplements AS RESTRICTIVE FOR SELECT TO authenticated
  USING(NOT((SELECT public.is_super_admin()) AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)));

CREATE OR REPLACE FUNCTION app_private.ie_supplement_immutable_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Nội dung bổ sung đã lưu không được sửa hoặc xóa' USING ERRCODE='55000'; END $$;
REVOKE ALL ON FUNCTION app_private.ie_supplement_immutable_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS ie_supplement_immutable ON public.income_expense_supplements;
CREATE TRIGGER ie_supplement_immutable BEFORE UPDATE OR DELETE ON public.income_expense_supplements
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_supplement_immutable_v1();
DROP TRIGGER IF EXISTS ie_supplement_no_truncate ON public.income_expense_supplements;
CREATE TRIGGER ie_supplement_no_truncate BEFORE TRUNCATE ON public.income_expense_supplements
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.ie_supplement_immutable_v1();
DROP TRIGGER IF EXISTS ie_supplement_objects_immutable ON app_private.ie_supplement_objects;
CREATE TRIGGER ie_supplement_objects_immutable BEFORE UPDATE OR DELETE ON app_private.ie_supplement_objects
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_supplement_immutable_v1();
DROP TRIGGER IF EXISTS ie_supplement_objects_no_truncate ON app_private.ie_supplement_objects;
CREATE TRIGGER ie_supplement_objects_no_truncate BEFORE TRUNCATE ON app_private.ie_supplement_objects
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.ie_supplement_immutable_v1();
DROP TRIGGER IF EXISTS ie_supplement_requests_immutable ON app_private.ie_supplement_requests;
CREATE TRIGGER ie_supplement_requests_immutable BEFORE UPDATE OR DELETE ON app_private.ie_supplement_requests
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_supplement_immutable_v1();

CREATE OR REPLACE FUNCTION app_private.ie_storage_is_supplement_v1(p_bucket text,p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $$
  SELECT EXISTS(SELECT 1 FROM app_private.ie_supplement_objects WHERE bucket_id=p_bucket AND object_name=p_name);
$$;
REVOKE ALL ON FUNCTION app_private.ie_storage_is_supplement_v1(text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION app_private.ie_storage_is_supplement_v1(text,text) TO authenticated;
CREATE OR REPLACE FUNCTION app_private.ie_supplement_storage_can_read_v1(p_bucket text,p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private,public AS $$
  -- Existing bucket/org policies still apply. A supplemental proof additionally
  -- needs a visible parent; a shared object may be read via any visible parent.
  -- No storage.objects query here: that would recurse into this SELECT policy.
  SELECT NOT app_private.ie_storage_is_supplement_v1(p_bucket,p_name)
    OR EXISTS(SELECT 1 FROM app_private.ie_supplement_objects o
      JOIN public.income_expense_supplements s ON s.id=o.supplement_id
      WHERE o.bucket_id=p_bucket AND o.object_name=p_name
        AND app_private.ie_supplement_can_read_v1(s.income_expense_id));
$$;
REVOKE ALL ON FUNCTION app_private.ie_supplement_storage_can_read_v1(text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION app_private.ie_supplement_storage_can_read_v1(text,text) TO authenticated;
DROP POLICY IF EXISTS ie_supplement_storage_parent_read ON storage.objects;
CREATE POLICY ie_supplement_storage_parent_read ON storage.objects AS RESTRICTIVE FOR SELECT TO authenticated
  USING(app_private.ie_supplement_storage_can_read_v1(bucket_id,name));
DROP POLICY IF EXISTS ie_supplement_storage_no_delete ON storage.objects;
CREATE POLICY ie_supplement_storage_no_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
  USING(NOT app_private.ie_storage_is_supplement_v1(bucket_id,name));
DROP POLICY IF EXISTS ie_supplement_storage_no_replace ON storage.objects;
CREATE POLICY ie_supplement_storage_no_replace ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
  USING(NOT app_private.ie_storage_is_supplement_v1(bucket_id,name))
  WITH CHECK(NOT app_private.ie_storage_is_supplement_v1(bucket_id,name));
-- Storage service paths can bypass RLS. Keep object identity/content metadata and
-- the tenant link immutable at the database boundary as well as client policies.
CREATE OR REPLACE FUNCTION app_private.ie_supplement_storage_guard_v1()
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
DROP TRIGGER IF EXISTS a00_ie_supplement_storage_guard ON storage.objects;
CREATE TRIGGER a00_ie_supplement_storage_guard BEFORE UPDATE OR DELETE ON storage.objects
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_supplement_storage_guard_v1();
DROP TRIGGER IF EXISTS a00_ie_supplement_link_guard ON app_private.storage_object_links;
CREATE TRIGGER a00_ie_supplement_link_guard BEFORE UPDATE OR DELETE ON app_private.storage_object_links
  FOR EACH ROW EXECUTE FUNCTION app_private.ie_supplement_storage_guard_v1();

CREATE OR REPLACE FUNCTION public.append_income_expense_supplement_v1(p_voucher uuid,p_note text DEFAULT NULL,
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
DO $publication$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime'
    AND schemaname='public' AND tablename='income_expense_supplements') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.income_expense_supplements;
  END IF;
END $publication$;

COMMIT;
