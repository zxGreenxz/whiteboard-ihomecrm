-- REVIEW ONLY. Production application requires the reviewed migration lane and a fresh full backup.

BEGIN;

SET LOCAL search_path=pg_catalog,public;

SET LOCAL lock_timeout='5s';

SET LOCAL statement_timeout='60s';

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('app_private.active_working_membership_v1(uuid,uuid)') AND md5(prosrc)<>'48e180667fd2c164beddb078b8c5f37c') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %','app_private.active_working_membership_v1(uuid,uuid)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('app_private.working_organization_v1(boolean)') AND md5(prosrc)<>'a752313fbb34358a0983b97b64e19c32') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %','app_private.working_organization_v1(boolean)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('app_private.salary_subject_organization_v1(uuid,date,uuid,uuid)') AND md5(prosrc)<>'ff46bfe9947b50aa8664cda21d565a76') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %','app_private.salary_subject_organization_v1(uuid,date,uuid,uuid)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('app_private.bind_finance_storage_org_v1(uuid,text,text)') AND md5(prosrc)<>'91b101ad5ee7f9b8e32fa3c7c3d3c0e8') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %','app_private.bind_finance_storage_org_v1(uuid,text,text)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('app_private.bind_voucher_attachment_links_v1()') AND md5(prosrc)<>'cebfd374821d0079134960f8abde855c') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %','app_private.bind_voucher_attachment_links_v1()';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('app_private.ensure_termination_type_in_org_v1(uuid,text,text,uuid)') AND md5(prosrc)<>'38ca05c56ab237865da3f3eead6c6de3') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %','app_private.ensure_termination_type_in_org_v1(uuid,text,text,uuid)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('app_private.resolve_fixed_expense_type_in_org_v1(uuid,text,uuid)') AND md5(prosrc)<>'1e468daf8f26f3db6d9d413db9b598fb') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %','app_private.resolve_fixed_expense_type_in_org_v1(uuid,text,uuid)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('app_private.chung_building_in_org_v1(uuid,uuid)') AND md5(prosrc)<>'91c28964a91c76040d37688ea0a84ee8') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %','app_private.chung_building_in_org_v1(uuid,uuid)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('app_private.deposit_account_in_org_v1(uuid,uuid)') AND md5(prosrc)<>'342f5b0567b04d1c04bd3af22b947467') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %','app_private.deposit_account_in_org_v1(uuid,uuid)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('app_private.internal_settlement_account_in_org_v1(uuid,uuid)') AND md5(prosrc)<>'7a8280f2b8dc60cf85d00fc235dfd438') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %','app_private.internal_settlement_account_in_org_v1(uuid,uuid)';
  END IF;
END $guard$;

-- Private helpers only. They provide identity; existing RPC permission and
-- possession checks remain authoritative. No RLS policy is replaced here.
CREATE OR REPLACE FUNCTION app_private.active_working_membership_v1(p_user uuid, p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    JOIN public.organizations o ON o.id=m.organization_id AND o.status='ACTIVE'
    WHERE m.user_id=p_user AND m.organization_id=p_org AND m.status='ACTIVE'
      AND coalesce(m.valid_from,'-infinity'::timestamptz)<=now()
      AND (m.valid_to IS NULL OR m.valid_to>now())
  );
$fn$;
REVOKE ALL ON FUNCTION app_private.active_working_membership_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.working_organization_v1(p_required boolean DEFAULT true)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_requested text;
  v_org uuid;
  v_orgs uuid[];
BEGIN
  IF v_actor IS NULL THEN
    IF p_required THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
    RETURN NULL;
  END IF;
  v_requested := nullif(nullif(current_setting('request.headers',true),'')::jsonb->>'x-ihomecrm-organization-id','');
  IF v_requested IS NOT NULL THEN
    BEGIN v_org := v_requested::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Công ty làm việc không hợp lệ' USING ERRCODE='22023';
    END;
    IF NOT app_private.active_working_membership_v1(v_actor,v_org) THEN
      RAISE EXCEPTION 'Không còn quyền làm việc trong công ty đã chọn' USING ERRCODE='42501';
    END IF;
    RETURN v_org;
  END IF;
  SELECT array_agg(DISTINCT m.organization_id) INTO v_orgs
  FROM public.organization_memberships m
  WHERE m.user_id=v_actor AND app_private.active_working_membership_v1(v_actor,m.organization_id);
  IF cardinality(v_orgs)=1 THEN RETURN v_orgs[1]; END IF;
  IF p_required THEN
    RAISE EXCEPTION 'Hãy chọn công ty làm việc trong Tài khoản trước khi tiếp tục' USING ERRCODE='22023';
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION app_private.working_organization_v1(boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.salary_subject_organization_v1(p_staff uuid,p_period date,p_account uuid DEFAULT NULL,p_selected uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_org uuid; v_orgs uuid[]; v_selected uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_staff IS NULL OR p_period IS NULL THEN RAISE EXCEPTION 'Thiếu nhân viên hoặc kỳ lương' USING ERRCODE='22023'; END IF;
  -- A persisted monthly row owns its company, even after a staff member moves.
  SELECT array_agg(DISTINCT organization_id) INTO v_orgs
    FROM public.salary_monthly WHERE staff_id=p_staff AND period_month=p_period;
  IF v_orgs IS NOT NULL THEN
    IF cardinality(v_orgs)<>1 OR v_orgs[1] IS NULL THEN
      RAISE EXCEPTION 'Bảng lương chưa có công ty rõ ràng; cần kiểm tra trước khi thao tác' USING ERRCODE='22023';
    END IF;
    v_org := v_orgs[1];
  ELSE
    v_selected := coalesce(p_selected,app_private.working_organization_v1(false));
    SELECT array_agg(DISTINCT organization_id) INTO v_orgs
      FROM public.manager_salary_config
     WHERE staff_id=p_staff AND organization_id IS NOT NULL AND is_active
       AND effective_from<=p_period AND (effective_to IS NULL OR effective_to>=p_period)
       AND (v_selected IS NULL OR organization_id=v_selected);
    IF cardinality(v_orgs)=1 THEN v_org := v_orgs[1];
    ELSIF cardinality(v_orgs)>1 THEN
      RAISE EXCEPTION 'Nhân viên có cấu hình lương ở nhiều công ty; hãy chọn công ty' USING ERRCODE='22023';
    ELSIF v_selected IS NOT NULL AND app_private.active_working_membership_v1(p_staff,v_selected) THEN
      v_org := v_selected;
    ELSE
      SELECT array_agg(DISTINCT organization_id) INTO v_orgs
        FROM public.organization_memberships
       WHERE user_id=p_staff AND app_private.active_working_membership_v1(p_staff,organization_id);
      IF cardinality(v_orgs)=1 AND (v_selected IS NULL OR v_selected=v_orgs[1]) THEN v_org := v_orgs[1]; END IF;
    END IF;
  END IF;
  IF v_org IS NULL OR NOT app_private.active_working_membership_v1(auth.uid(),v_org) THEN
    RAISE EXCEPTION 'Không xác định được công ty lương hợp lệ cho thao tác này' USING ERRCODE='42501';
  END IF;
  IF p_account IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.accounts WHERE id=p_account AND organization_id=v_org AND deleted_at IS NULL
  ) THEN RAISE EXCEPTION 'Sổ quỹ không thuộc công ty của bảng lương' USING ERRCODE='42501'; END IF;
  RETURN v_org;
END;
$fn$;
REVOKE ALL ON FUNCTION app_private.salary_subject_organization_v1(uuid,date,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.bind_finance_storage_org_v1(
  p_org uuid, p_bucket text, p_object text
)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app_private,public,storage AS $bind$
DECLARE
  stored storage.objects;
  link app_private.storage_object_links;
  uploader uuid;
BEGIN
  IF auth.uid() IS NULL OR p_org IS NULL OR p_bucket IS DISTINCT FROM 'income-expense-attachments'
     OR NOT app_private.active_working_membership_v1(auth.uid(),p_org) THEN
    RAISE EXCEPTION 'Active membership and finance storage context required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO stored FROM storage.objects WHERE bucket_id=p_bucket AND name=p_object FOR SHARE;
  IF NOT FOUND OR stored.archived_at IS NOT NULL OR stored.is_delete_marker IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Active storage object required' USING ERRCODE='55000';
  END IF;
  SELECT * INTO link FROM app_private.storage_object_links
    WHERE bucket_id=p_bucket AND object_name=p_object FOR UPDATE;
  IF FOUND AND link.organization_id IS NOT NULL THEN
    IF link.organization_id <> p_org THEN
      RAISE EXCEPTION 'Storage object belongs to another organization' USING ERRCODE='42501';
    END IF;
    RETURN; -- Already bound: retain its owner, provenance and all existing rules.
  END IF;
  uploader := COALESCE(NULLIF(stored.owner_id,'' )::uuid,stored.owner);
  IF uploader IS DISTINCT FROM auth.uid()
     OR (split_part(p_object,'/',1) IS DISTINCT FROM uploader::text AND NOT EXISTS (
       SELECT 1 FROM public.finance_evidence_objects f
        WHERE f.bucket_id=p_bucket AND f.object_name=p_object AND f.organization_id=p_org
          AND f.uploader_user_id=uploader AND f.state IN ('UPLOAD_INTENT','FINALIZED','ATTACHED')
          AND p_object LIKE 'v2/'||p_org::text||'/%'
     ))
     OR (link.object_name IS NOT NULL AND
        (link.owner_user_id IS DISTINCT FROM uploader OR link.derivation <> 'quarantine')) THEN
    RAISE EXCEPTION 'Only the uploader may bind an unclassified storage object' USING ERRCODE='42501';
  END IF;
  IF app_private.ie_storage_is_supplement_v1(p_bucket,p_object) THEN
    RAISE EXCEPTION 'Protected supplemental proof cannot be relinked' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.finance_evidence_objects
      WHERE bucket_id=p_bucket AND object_name=p_object
        AND (organization_id IS DISTINCT FROM p_org OR state='QUARANTINED')) THEN
    RAISE EXCEPTION 'Conflicting or quarantined finance evidence' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM public.income_expenses v
      WHERE v.organization_id IS DISTINCT FROM p_org
        AND v.attachments @> jsonb_build_array(
          'https://tryymsxyyckgbrmmvozx.supabase.co/storage/v1/object/public/'||p_bucket||'/'||p_object)) THEN
    RAISE EXCEPTION 'Storage object referenced by another organization' USING ERRCODE='42501';
  END IF;
  INSERT INTO app_private.storage_object_links AS existing
    (bucket_id,object_name,organization_id,owner_user_id,derivation)
  VALUES(p_bucket,p_object,p_org,uploader,'FINANCE_V2_EVIDENCE')
  ON CONFLICT(bucket_id,object_name) DO UPDATE
    SET organization_id=EXCLUDED.organization_id,derivation=EXCLUDED.derivation
    WHERE existing.organization_id IS NULL AND existing.derivation='quarantine'
      AND existing.owner_user_id=uploader;
  IF NOT EXISTS(SELECT 1 FROM app_private.storage_object_links
     WHERE bucket_id=p_bucket AND object_name=p_object AND organization_id=p_org
       AND owner_user_id=uploader) THEN
    RAISE EXCEPTION 'Concurrent storage ownership change' USING ERRCODE='40001';
  END IF;
END $bind$;
REVOKE ALL ON FUNCTION app_private.bind_finance_storage_org_v1(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;

-- Every new/additional voucher attachment is bound within the same transaction
-- as its parent. This covers create/compat/annotation paths, not just posting.
CREATE OR REPLACE FUNCTION app_private.bind_voucher_attachment_links_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app_private,public,storage AS $parent$
DECLARE v_url text; v_object text;
  v_prefix constant text := 'https://tryymsxyyckgbrmmvozx.supabase.co/storage/v1/object/public/income-expense-attachments/';
BEGIN
  IF NEW.attachments IS NULL OR jsonb_typeof(NEW.attachments)<>'array' THEN RETURN NEW; END IF;
  FOR v_url IN SELECT jsonb_array_elements_text(NEW.attachments) LOOP
    IF TG_OP='UPDATE' AND OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id
       AND coalesce(OLD.attachments,'[]'::jsonb) @> jsonb_build_array(v_url) THEN CONTINUE; END IF;
    IF left(v_url,length(v_prefix))<>v_prefix THEN CONTINUE; END IF;
    v_object := split_part(substring(v_url FROM length(v_prefix)+1),'?',1);
    PERFORM app_private.bind_finance_storage_org_v1(NEW.organization_id,'income-expense-attachments',v_object);
  END LOOP;
  RETURN NEW;
END $parent$;
REVOKE ALL ON FUNCTION app_private.bind_voucher_attachment_links_v1() FROM PUBLIC,anon,authenticated,service_role;
DO $parent_trigger$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.income_expenses'::regclass AND tgname='a90_bind_voucher_attachment_links') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.income_expenses'::regclass AND t.tgname='a90_bind_voucher_attachment_links'
        AND t.tgfoid='app_private.bind_voucher_attachment_links_v1()'::regprocedure
        AND t.tgtype=21 AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgenabled='O'
        AND t.tgattr::text=(SELECT string_agg(attnum::text,' ' ORDER BY array_position(ARRAY['attachments','organization_id'],attname::text))
          FROM pg_attribute WHERE attrelid=t.tgrelid AND attname IN ('attachments','organization_id'))
    ) THEN RAISE EXCEPTION 'Existing attachment trigger differs from reviewed definition'; END IF;
  ELSE
    CREATE TRIGGER a90_bind_voucher_attachment_links
    AFTER INSERT OR UPDATE OF attachments,organization_id ON public.income_expenses
    FOR EACH ROW EXECUTE FUNCTION app_private.bind_voucher_attachment_links_v1();
  END IF;
END $parent_trigger$;



CREATE OR REPLACE FUNCTION app_private.ensure_termination_type_in_org_v1(p_user_id uuid, p_type text, p_name text, p_org uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_org uuid;
begin

  IF p_org IS NULL THEN RAISE EXCEPTION 'Dữ liệu gốc chưa có công ty' USING ERRCODE='22023'; END IF;
  IF auth.uid() IS NOT NULL AND NOT app_private.active_working_membership_v1(auth.uid(),p_org) THEN
    RAISE EXCEPTION 'Không có quyền trong công ty của dữ liệu gốc' USING ERRCODE='42501'; END IF;
  v_org := p_org;

  -- (1) TRA THEO ĐÚNG PHẠM VI MÀ UNIQUE INDEX CHẶN.
  --     income_expense_types_org_side_normalized_name_uq =
  --       (organization_id, lower(btrim(type)), normalize_income_expense_type_name(name))
  --     Tra theo user_id như bản cũ là tra hẹp hơn chỗ bị chặn ⇒ loại phiếu do
  --     người KHÁC trong cùng org đứng tên thì tra không thấy, INSERT xuống là
  --     23505. Đúng lỗi làm confirm_cash_handover chết với mọi người.
  if v_org is not null then
    select t.id into v_id
      from income_expense_types t
     where t.organization_id = v_org
       and lower(btrim(t.type)) = lower(btrim(p_type))
       and normalize_income_expense_type_name(t.name)
           = normalize_income_expense_type_name(p_name)
     limit 1;

    if v_id is not null then
      update income_expense_types
         set force_approval = true
       where id = v_id and force_approval = false;
      return v_id;
    end if;
  end if;

  -- Unclassified historical types are not claimed without parent proof.
  insert into income_expense_types (user_id, organization_id, type, name, description, force_approval)
  values (p_user_id, v_org, lower(p_type), p_name,
          'Tự tạo khi thanh lý hợp đồng', true)
  returning id into v_id;

  return v_id;
end;
$function$;
REVOKE ALL ON FUNCTION app_private.ensure_termination_type_in_org_v1(uuid,text,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.resolve_fixed_expense_type_in_org_v1(p_owner uuid, p_category_key text, p_org uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v_type uuid;
  v_name text;
  v_category text;
  v_organization_id uuid;
BEGIN

  IF p_org IS NULL THEN RAISE EXCEPTION 'Dữ liệu gốc chưa có công ty' USING ERRCODE='22023'; END IF;
  IF auth.uid() IS NOT NULL AND NOT app_private.active_working_membership_v1(auth.uid(),p_org) THEN
    RAISE EXCEPTION 'Không có quyền trong công ty của dữ liệu gốc' USING ERRCODE='42501'; END IF;
  IF p_category_key NOT IN (
    'tien_nha', 'dien', 'nuoc', 'internet', 'quan_ly',
    've_sinh', 'cong_an', 'rac', 'thang_may'
  ) THEN
    RAISE EXCEPTION 'Hạng mục phí không hợp lệ: %', p_category_key
      USING ERRCODE = '23514';
  END IF;

  v_organization_id := p_org;

  SELECT type_row.id
    INTO v_type
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_organization_id
    AND lower(btrim(type_row.type)) = 'expense'
    AND public.fee_type_matches(
      p_category_key,
      type_row.category,
      type_row.name
    )
  ORDER BY
    COALESCE(type_row.is_default, false) DESC,
    type_row.created_at,
    type_row.id
  LIMIT 1;

  IF v_type IS NOT NULL THEN
    RETURN v_type;
  END IF;

  v_name := CASE p_category_key
    WHEN 'tien_nha'  THEN 'Tiền nhà'
    WHEN 'dien'      THEN 'Đóng tiền điện'
    WHEN 'nuoc'      THEN 'Đóng tiền nước'
    WHEN 'internet'  THEN 'Internet'
    WHEN 'quan_ly'   THEN 'Quản Lý'
    WHEN 've_sinh'   THEN 'Vệ sinh tòa nhà định kỳ'
    WHEN 'cong_an'   THEN 'Công an'
    WHEN 'rac'       THEN 'Tiền rác'
    WHEN 'thang_may' THEN 'Bảo trì thang máy'
  END;
  v_category := CASE p_category_key
    WHEN 'tien_nha'  THEN 'Tiền nhà'
    WHEN 'dien'      THEN 'Điện'
    WHEN 'nuoc'      THEN 'Nước'
    WHEN 'internet'  THEN 'Internet'
    WHEN 'quan_ly'   THEN 'Quản Lý'
    WHEN 've_sinh'   THEN 'Vệ sinh'
    WHEN 'cong_an'   THEN 'Công an'
    WHEN 'rac'       THEN 'Rác'
    WHEN 'thang_may' THEN 'Bảo Trì Thang Máy'
  END;

  RETURN app_private.ensure_income_expense_type_v1(
    p_organization_id => v_organization_id,
    p_user_id => p_owner,
    p_name => v_name,
    p_type => 'expense',
    p_category => v_category,
    p_is_restricted => (p_category_key = 'quan_ly')
  );
END
$function$;
REVOKE ALL ON FUNCTION app_private.resolve_fixed_expense_type_in_org_v1(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.chung_building_in_org_v1(p_user_id uuid, p_org uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN

  IF p_org IS NULL THEN RAISE EXCEPTION 'Dữ liệu gốc chưa có công ty' USING ERRCODE='22023'; END IF;
  IF auth.uid() IS NOT NULL AND NOT app_private.active_working_membership_v1(auth.uid(),p_org) THEN
    RAISE EXCEPTION 'Không có quyền trong công ty của dữ liệu gốc' USING ERRCODE='42501'; END IF;
  -- Tenant thật: toà chung hệ thống = toà ảo không thuộc demo (hiện là
  -- "Kho Văn Phòng Chung") TRONG ĐÚNG ORG p_user có membership ACTIVE.
  -- Không lọc org từng đúng khi cả hệ chỉ có một org thật (20260704210000);
  -- clone_org_sync (20260801060000) nhân bản tòa ảo sang org Test và COPY
  -- NGUYÊN created_at ⇒ ORDER BY created_at không tiebreaker thành
  -- nondeterministic và vớ tòa org Test ⇒ phiếu bàn giao/điều chỉnh số dư
  -- sinh nhầm tenant, bridge V2 không resolve được poster. Thêm b.id làm
  -- tiebreaker cho ổn định.
  IF NOT (p_user_id = ANY (public.demo_user_ids())) THEN
    SELECT b.id INTO v_id FROM buildings b
     WHERE b.organization_id = p_org AND b.is_virtual = true AND b.deleted_at IS NULL
       AND NOT (b.user_id = ANY (public.demo_user_ids()))
       AND EXISTS (
         SELECT 1 FROM organization_memberships m
          WHERE m.user_id = p_user_id
            AND m.status = 'ACTIVE'
            AND m.organization_id = b.organization_id)
     ORDER BY b.created_at, b.id LIMIT 1;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;

  -- Fallback (demo, hoặc tenant chưa có toà chung): hành vi cũ
  SELECT id INTO v_id FROM buildings
   WHERE organization_id = p_org AND user_id = p_user_id AND is_virtual = true AND name = 'Chung'
     AND deleted_at IS NULL
   ORDER BY created_at LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO buildings (organization_id, user_id, name, type, status, province, district, ward, is_virtual)
  VALUES (p_org, p_user_id, 'Chung', 'APARTMENT'::building_type, 'ACTIVE'::building_status, '—', '—', '—', true)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;
REVOKE ALL ON FUNCTION app_private.chung_building_in_org_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.deposit_account_in_org_v1(p_user_id uuid, p_org uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN

  IF p_org IS NULL THEN RAISE EXCEPTION 'Dữ liệu gốc chưa có công ty' USING ERRCODE='22023'; END IF;
  IF auth.uid() IS NOT NULL AND NOT app_private.active_working_membership_v1(auth.uid(),p_org) THEN
    RAISE EXCEPTION 'Không có quyền trong công ty của dữ liệu gốc' USING ERRCODE='42501'; END IF;
  SELECT id INTO v_id
    FROM accounts
   WHERE organization_id = p_org AND user_id = p_user_id AND deleted_at IS NULL
     AND name = 'CỌC (giữ hộ khách)'
   LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO accounts (organization_id, user_id, name, description, initial_amount)
  VALUES (p_org, p_user_id, 'CỌC (giữ hộ khách)',
          'Sổ giữ tiền cọc của khách (mọi toà). Số dư = tổng cọc đang giữ. Thanh lý: chi trả khách + chuyển phần cấn nợ sang sổ vận hành.', 0)
  RETURNING id INTO v_id;
  RETURN v_id;
END $function$;
REVOKE ALL ON FUNCTION app_private.deposit_account_in_org_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.internal_settlement_account_in_org_v1(p_user_id uuid, p_org uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN

  IF p_org IS NULL THEN RAISE EXCEPTION 'Dữ liệu gốc chưa có công ty' USING ERRCODE='22023'; END IF;
  IF auth.uid() IS NOT NULL AND NOT app_private.active_working_membership_v1(auth.uid(),p_org) THEN
    RAISE EXCEPTION 'Không có quyền trong công ty của dữ liệu gốc' USING ERRCODE='42501'; END IF;
  SELECT id INTO v_id
    FROM accounts
   WHERE organization_id = p_org AND user_id = p_user_id AND deleted_at IS NULL
     AND name = 'Cấn trừ thanh lý (nội bộ)'
   ORDER BY created_at LIMIT 1;
  IF v_id IS NOT NULL THEN
    UPDATE accounts SET is_virtual = true WHERE id = v_id AND is_virtual IS DISTINCT FROM true;
    RETURN v_id;
  END IF;

  INSERT INTO accounts (organization_id, user_id, name, description, initial_amount, is_virtual)
  VALUES (p_org, p_user_id, 'Cấn trừ thanh lý (nội bộ)',
          'Sổ BÚT TOÁN (không phải tiền thật): cặp cấn cọc → doanh thu khi thanh lý/bỏ cọc chạy cả 2 chân trên sổ này, mỗi thương vụ net 0.',
          0, true)
  RETURNING id INTO v_id;
  RETURN v_id;
END $function$;
REVOKE ALL ON FUNCTION app_private.internal_settlement_account_in_org_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- public._termination_ensure_type(uuid,text,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public._termination_ensure_type(uuid,text,text)'::regprocedure);
  IF md5(definition) = '56ff93c15c5deecdd2b9e028eb42af85' THEN RETURN; END IF;
  IF md5(definition) <> '1970ff23b826557e50f319ef91535fe6' THEN RAISE EXCEPTION 'Live function changed: %','public._termination_ensure_type(uuid,text,text)'; END IF;
  definition := replace(definition,'
declare
  v_id uuid; v_org uuid;
begin
  -- org của người thao tác: 1 membership → dùng luôn; nhiều → ưu tiên org
  -- mà user giữ role "Chủ sở hữu tổ chức" (owner thật thuộc cả demo).
  select min(m.organization_id::text)::uuid into v_org
    from organization_memberships m
   where m.user_id = p_user_id and m.status = ''ACTIVE'';
  if (select count(distinct m.organization_id) from organization_memberships m
       where m.user_id = p_user_id and m.status = ''ACTIVE'') > 1 then
    select rb.organization_id into v_org
      from role_bindings rb
      join organization_memberships m
        on m.id = rb.membership_id and m.organization_id = rb.organization_id
       and m.user_id = p_user_id and m.status = ''ACTIVE''
      join organization_roles r on r.id = rb.role_id and r.name = ''Chủ sở hữu tổ chức''
     limit 1;
  end if;

  -- (1) TRA THEO ĐÚNG PHẠM VI MÀ UNIQUE INDEX CHẶN.
  --     income_expense_types_org_side_normalized_name_uq =
  --       (organization_id, lower(btrim(type)), normalize_income_expense_type_name(name))
  --     Tra theo user_id như bản cũ là tra hẹp hơn chỗ bị chặn ⇒ loại phiếu do
  --     người KHÁC trong cùng org đứng tên thì tra không thấy, INSERT xuống là
  --     23505. Đúng lỗi làm confirm_cash_handover chết với mọi người.
  if v_org is not null then
    select t.id into v_id
      from income_expense_types t
     where t.organization_id = v_org
       and lower(btrim(t.type)) = lower(btrim(p_type))
       and normalize_income_expense_type_name(t.name)
           = normalize_income_expense_type_name(p_name)
     limit 1;

    if v_id is not null then
      update income_expense_types
         set force_approval = true
       where id = v_id and force_approval = false;
      return v_id;
    end if;
  end if;

  -- (2) Nhánh cũ, giữ lại cho những dòng còn organization_id IS NULL (chưa được
  --     gắn org) — index không chặn chúng nên vẫn phải tự tìm theo người tạo.
  select id into v_id
    from income_expense_types
   where user_id = p_user_id
     and lower(name) = lower(p_name)
     and lower(type) = lower(p_type)
   limit 1;

  if v_id is not null then
    update income_expense_types
       set force_approval = true,
           organization_id = coalesce(organization_id, v_org)
     where id = v_id and (force_approval = false or organization_id is null);
    return v_id;
  end if;

  insert into income_expense_types (user_id, organization_id, type, name, description, force_approval)
  values (p_user_id, v_org, lower(p_type), p_name,
          ''Tự tạo khi thanh lý hợp đồng'', true)
  returning id into v_id;

  return v_id;
end;
','
BEGIN RETURN app_private.ensure_termination_type_in_org_v1(p_user_id,p_type,p_name,app_private.working_organization_v1()); END;
');
  IF md5(definition) <> '56ff93c15c5deecdd2b9e028eb42af85' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.resolve_fixed_expense_type(uuid,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.resolve_fixed_expense_type(uuid,text)'::regprocedure);
  IF md5(definition) = 'f7238f267290d28f52c9b9f039b701d1' THEN RETURN; END IF;
  IF md5(definition) <> 'e6c68ad3c2c98bfe93c4ff0b357ea16e' THEN RAISE EXCEPTION 'Live function changed: %','public.resolve_fixed_expense_type(uuid,text)'; END IF;
  definition := replace(definition,'
DECLARE
  v_type uuid;
  v_name text;
  v_category text;
  v_organization_id uuid;
BEGIN
  IF p_category_key NOT IN (
    ''tien_nha'', ''dien'', ''nuoc'', ''internet'', ''quan_ly'',
    ''ve_sinh'', ''cong_an'', ''rac'', ''thang_may''
  ) THEN
    RAISE EXCEPTION ''Hạng mục phí không hợp lệ: %'', p_category_key
      USING ERRCODE = ''23514'';
  END IF;

  v_organization_id := app_private.resolve_ie_type_org_for_user_v1(p_owner);

  SELECT type_row.id
    INTO v_type
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_organization_id
    AND lower(btrim(type_row.type)) = ''expense''
    AND public.fee_type_matches(
      p_category_key,
      type_row.category,
      type_row.name
    )
  ORDER BY
    COALESCE(type_row.is_default, false) DESC,
    type_row.created_at,
    type_row.id
  LIMIT 1;

  IF v_type IS NOT NULL THEN
    RETURN v_type;
  END IF;

  v_name := CASE p_category_key
    WHEN ''tien_nha''  THEN ''Tiền nhà''
    WHEN ''dien''      THEN ''Đóng tiền điện''
    WHEN ''nuoc''      THEN ''Đóng tiền nước''
    WHEN ''internet''  THEN ''Internet''
    WHEN ''quan_ly''   THEN ''Quản Lý''
    WHEN ''ve_sinh''   THEN ''Vệ sinh tòa nhà định kỳ''
    WHEN ''cong_an''   THEN ''Công an''
    WHEN ''rac''       THEN ''Tiền rác''
    WHEN ''thang_may'' THEN ''Bảo trì thang máy''
  END;
  v_category := CASE p_category_key
    WHEN ''tien_nha''  THEN ''Tiền nhà''
    WHEN ''dien''      THEN ''Điện''
    WHEN ''nuoc''      THEN ''Nước''
    WHEN ''internet''  THEN ''Internet''
    WHEN ''quan_ly''   THEN ''Quản Lý''
    WHEN ''ve_sinh''   THEN ''Vệ sinh''
    WHEN ''cong_an''   THEN ''Công an''
    WHEN ''rac''       THEN ''Rác''
    WHEN ''thang_may'' THEN ''Bảo Trì Thang Máy''
  END;

  RETURN app_private.ensure_income_expense_type_v1(
    p_organization_id => v_organization_id,
    p_user_id => p_owner,
    p_name => v_name,
    p_type => ''expense'',
    p_category => v_category,
    p_is_restricted => (p_category_key = ''quan_ly'')
  );
END
','
BEGIN RETURN app_private.resolve_fixed_expense_type_in_org_v1(p_owner,p_category_key,app_private.working_organization_v1()); END;
');
  IF md5(definition) <> 'f7238f267290d28f52c9b9f039b701d1' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public._chung_building(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public._chung_building(uuid)'::regprocedure);
  IF md5(definition) = 'd4e8bd7f37c7779bfd67bc7115c206a5' THEN RETURN; END IF;
  IF md5(definition) <> '4b6ef6c84b56d79b257dc79e94afa6b5' THEN RAISE EXCEPTION 'Live function changed: %','public._chung_building(uuid)'; END IF;
  definition := replace(definition,'
DECLARE
  v_id uuid;
BEGIN
  -- Tenant thật: toà chung hệ thống = toà ảo không thuộc demo (hiện là
  -- "Kho Văn Phòng Chung") TRONG ĐÚNG ORG p_user có membership ACTIVE.
  -- Không lọc org từng đúng khi cả hệ chỉ có một org thật (20260704210000);
  -- clone_org_sync (20260801060000) nhân bản tòa ảo sang org Test và COPY
  -- NGUYÊN created_at ⇒ ORDER BY created_at không tiebreaker thành
  -- nondeterministic và vớ tòa org Test ⇒ phiếu bàn giao/điều chỉnh số dư
  -- sinh nhầm tenant, bridge V2 không resolve được poster. Thêm b.id làm
  -- tiebreaker cho ổn định.
  IF NOT (p_user_id = ANY (public.demo_user_ids())) THEN
    SELECT b.id INTO v_id FROM buildings b
     WHERE b.is_virtual = true AND b.deleted_at IS NULL
       AND NOT (b.user_id = ANY (public.demo_user_ids()))
       AND EXISTS (
         SELECT 1 FROM organization_memberships m
          WHERE m.user_id = p_user_id
            AND m.status = ''ACTIVE''
            AND m.organization_id = b.organization_id)
     ORDER BY b.created_at, b.id LIMIT 1;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;

  -- Fallback (demo, hoặc tenant chưa có toà chung): hành vi cũ
  SELECT id INTO v_id FROM buildings
   WHERE user_id = p_user_id AND is_virtual = true AND name = ''Chung''
     AND deleted_at IS NULL
   ORDER BY created_at LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO buildings (user_id, name, type, status, province, district, ward, is_virtual)
  VALUES (p_user_id, ''Chung'', ''APARTMENT''::building_type, ''ACTIVE''::building_status, ''—'', ''—'', ''—'', true)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
','
BEGIN RETURN app_private.chung_building_in_org_v1(p_user_id,app_private.working_organization_v1()); END;
');
  IF md5(definition) <> 'd4e8bd7f37c7779bfd67bc7115c206a5' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public._deposit_account(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public._deposit_account(uuid)'::regprocedure);
  IF md5(definition) = '5a6c7e022a72a3c7b7a29ae5810b0c9d' THEN RETURN; END IF;
  IF md5(definition) <> '4a9869ab27533ca80dec02020c0ad9ea' THEN RAISE EXCEPTION 'Live function changed: %','public._deposit_account(uuid)'; END IF;
  definition := replace(definition,'
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id
    FROM accounts
   WHERE user_id = p_user_id AND deleted_at IS NULL
     AND name = ''CỌC (giữ hộ khách)''
   LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO accounts (user_id, name, description, initial_amount)
  VALUES (p_user_id, ''CỌC (giữ hộ khách)'',
          ''Sổ giữ tiền cọc của khách (mọi toà). Số dư = tổng cọc đang giữ. Thanh lý: chi trả khách + chuyển phần cấn nợ sang sổ vận hành.'', 0)
  RETURNING id INTO v_id;
  RETURN v_id;
END ','
BEGIN RETURN app_private.deposit_account_in_org_v1(p_user_id,app_private.working_organization_v1()); END;
');
  IF md5(definition) <> '5a6c7e022a72a3c7b7a29ae5810b0c9d' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public._internal_settlement_account(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public._internal_settlement_account(uuid)'::regprocedure);
  IF md5(definition) = 'e511d0a1dacf43274264e384c03150f3' THEN RETURN; END IF;
  IF md5(definition) <> 'c5e635908345ee651fd105ed69c7504c' THEN RAISE EXCEPTION 'Live function changed: %','public._internal_settlement_account(uuid)'; END IF;
  definition := replace(definition,'
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id
    FROM accounts
   WHERE user_id = p_user_id AND deleted_at IS NULL
     AND name = ''Cấn trừ thanh lý (nội bộ)''
   ORDER BY created_at LIMIT 1;
  IF v_id IS NOT NULL THEN
    UPDATE accounts SET is_virtual = true WHERE id = v_id AND is_virtual IS DISTINCT FROM true;
    RETURN v_id;
  END IF;

  INSERT INTO accounts (user_id, name, description, initial_amount, is_virtual)
  VALUES (p_user_id, ''Cấn trừ thanh lý (nội bộ)'',
          ''Sổ BÚT TOÁN (không phải tiền thật): cặp cấn cọc → doanh thu khi thanh lý/bỏ cọc chạy cả 2 chân trên sổ này, mỗi thương vụ net 0.'',
          0, true)
  RETURNING id INTO v_id;
  RETURN v_id;
END ','
BEGIN RETURN app_private.internal_settlement_account_in_org_v1(p_user_id,app_private.working_organization_v1()); END;
');
  IF md5(definition) <> 'e511d0a1dacf43274264e384c03150f3' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.terminate_contract_forfeit_impl(uuid,date,jsonb)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.terminate_contract_forfeit_impl(uuid,date,jsonb)'::regprocedure);
  IF md5(definition) = '73be158a92b0c01871d6e03387e8a71c' THEN RETURN; END IF;
  IF md5(definition) <> '7e90f0f91f1d57ec51da82bd6bce7003' THEN RAISE EXCEPTION 'Live function changed: %','public.terminate_contract_forfeit_impl(uuid,date,jsonb)'; END IF;
  definition := replace(definition,'CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit_impl(p_contract_id uuid, p_forfeit_date date, p_extra_charges jsonb DEFAULT ''[]''::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE
  v_contract       RECORD;
  v_building_id    uuid;
  v_invoice_id     uuid;
  v_extra_inv      uuid;
  v_extra          numeric(15,2) := 0;
  v_deposit        numeric(15,2);
  v_billing        text;
  v_cnumber        text;
  v_marker         text;
  v_acc_int        uuid;
  v_type_off       uuid;
  v_type_inc       uuid;
  v_chi_id         uuid;
  v_thu_id         uuid;
  v_kept_paid      numeric(15,2);
  v_paid_cnt       integer;
  v_unpaid_cnt     integer;
  v_cancelled_cnt  integer;
BEGIN
  SELECT * INTO v_contract
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION ''Hợp đồng không tồn tại'';
  END IF;
  IF v_contract.status IN (''TERMINATED'',''EXPIRED'') THEN
    RAISE EXCEPTION ''Hợp đồng đã thanh lý/hết hạn'';
  END IF;
  IF v_contract.room_id IS NULL THEN
    RAISE EXCEPTION ''Hợp đồng chưa gán phòng — không thể thanh lý'';
  END IF;
  IF p_forfeit_date < v_contract.start_date THEN
    RAISE EXCEPTION ''Ngày bỏ cọc (%) không được trước ngày bắt đầu hợp đồng (%)'',
      to_char(p_forfeit_date,''DD/MM/YYYY''), to_char(v_contract.start_date,''DD/MM/YYYY'');
  END IF;
  SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;
  IF v_building_id IS NULL THEN
    RAISE EXCEPTION ''Không xác định được toà nhà của hợp đồng'';
  END IF;

  -- Cọc forfeit = cọc THỰC đã thu (nguồn sự thật: contracts.deposit_paid).
  -- [A9] Cọc đã thu > cọc theo hợp đồng ⇒ DỪNG, không đoán.
  -- Công thức LEAST() bên dưới lấy số NHỎ hơn, nên khi ô "Tiền cọc" trên hợp
  -- đồng khai 0 mà thực đã thu (vd HĐT-062953: 0 / 4.000.000) thì v_deposit = 0
  -- và TOÀN BỘ khối doanh thu bị bỏ qua trong im lặng: không hoá đơn, không
  -- phiếu, 0đ doanh thu trên tiền đang giữ trong két.
  --
  -- KHÔNG sửa thành COALESCE(deposit_paid,0): đo được 3/4 hợp đồng dôi ra là do
  -- phiếu "[Accounting repair] Contract deposit" ĐẾM TRÙNG với phiếu thu cọc
  -- tường minh (2.000.000 + 1.500.000 + 300.000 = 3.800.000đ). Lấy thẳng
  -- deposit_paid sẽ ghi KHỐNG đúng số đó vào KQKD rồi chảy sang chia lợi nhuận.
  IF COALESCE(v_contract.deposit_paid, 0) > COALESCE(v_contract.total_deposit, 0) THEN
    RAISE EXCEPTION ''Không thanh lý được: cọc ĐÃ THU (% đ) lớn hơn cọc THEO HỢP ĐỒNG (% đ), dôi % đ. Hệ thống không tự đoán số nào đúng. Hãy kiểm tra sổ cọc của hợp đồng: nếu có phiếu cọc bị ĐẾM TRÙNG thì huỷ/điều chỉnh phiếu đó; nếu ô "Tiền cọc" trên hợp đồng khai thiếu thì sửa lại cho khớp số THỰC NHẬN. Đừng nâng "Tiền cọc" chỉ để chạy được lệnh — làm vậy sẽ ghi khống phần dôi thành doanh thu.'',
      round(COALESCE(v_contract.deposit_paid, 0))::bigint,
      round(COALESCE(v_contract.total_deposit, 0))::bigint,
      round(COALESCE(v_contract.deposit_paid,0) - COALESCE(v_contract.total_deposit,0))::bigint
      USING ERRCODE = ''55000'';
  END IF;
  v_deposit := LEAST(COALESCE(v_contract.total_deposit, 0), COALESCE(v_contract.deposit_paid, 0));
  v_billing := to_char(COALESCE(p_forfeit_date, public.org_today_v1(NULL)), ''YYYY-MM'');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_marker  := ''[CẤN CỌC BỎ CỌC '' || p_contract_id::text || '']'';

  v_acc_int := public._internal_settlement_account(v_contract.user_id);

  SELECT COALESCE(SUM(paid_amount), 0)
    INTO v_kept_paid
    FROM invoices
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN (''APPROVED'',''OVERDUE'',''PARTIAL_PAID'')
     AND COALESCE(paid_amount, 0) > 0;

  UPDATE invoices
     SET status       = ''CANCELLED'',
         total_amount = COALESCE(paid_amount, 0),
         notes        = CASE
                        WHEN notes IS NULL OR length(btrim(notes)) = 0
                          THEN ''[Huỷ — thanh lý bỏ cọc ngày ''
                               || to_char(p_forfeit_date,''DD/MM/YYYY'')
                               || ''; giữ lại '' || round(COALESCE(paid_amount,0))::bigint
                               || ''đ đã thu làm doanh thu, huỷ phần nợ ''
                               || round(COALESCE(remaining_amount,0))::bigint || ''đ]''
                        ELSE notes
                             || E''\n[Huỷ — thanh lý bỏ cọc ngày ''
                             || to_char(p_forfeit_date,''DD/MM/YYYY'')
                             || ''; giữ lại '' || round(COALESCE(paid_amount,0))::bigint
                             || ''đ đã thu làm doanh thu, huỷ phần nợ ''
                             || round(COALESCE(remaining_amount,0))::bigint || ''đ]''
                      END,
         updated_at = NOW()
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN (''APPROVED'',''OVERDUE'',''PARTIAL_PAID'')
     AND COALESCE(paid_amount, 0) > 0;
  GET DIAGNOSTICS v_paid_cnt = ROW_COUNT;

  UPDATE invoices
     SET status       = ''CANCELLED'',
         total_amount = 0,
         notes        = CASE
                        WHEN notes IS NULL OR length(btrim(notes)) = 0
                          THEN ''[Huỷ tự động — thanh lý bỏ cọc ngày ''
                               || to_char(p_forfeit_date,''DD/MM/YYYY'') || '']''
                        ELSE notes
                             || E''\n[Huỷ tự động — thanh lý bỏ cọc ngày ''
                             || to_char(p_forfeit_date,''DD/MM/YYYY'') || '']''
                      END,
         updated_at   = NOW()
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN (''APPROVED'',''OVERDUE'',''PARTIAL_PAID'')
     AND COALESCE(paid_amount, 0) = 0;
  GET DIAGNOSTICS v_unpaid_cnt = ROW_COUNT;

  v_cancelled_cnt := COALESCE(v_paid_cnt, 0) + COALESCE(v_unpaid_cnt, 0);

  IF v_deposit > 0 THEN
    -- v4: hoá đơn bù cọc mang ĐÚNG kỳ tháng bỏ cọc (kind=''SETTLEMENT'' —
    -- partial unique không còn chặn; thôi mượn slot tháng trống).
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id,
      kind, billing_month, issue_date, due_date,
      status, subtotal, discount_amount, total_amount,
      notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id,
      ''SETTLEMENT'', v_billing, p_forfeit_date, p_forfeit_date,
      ''APPROVED''::invoice_status, v_deposit, 0, v_deposit,
      ''Hoá đơn thanh lý — khách bỏ cọc ngày '' || to_char(p_forfeit_date,''DD/MM/YYYY'')
        || CASE WHEN v_cancelled_cnt > 0
                  THEN E''\n(Đã huỷ '' || v_cancelled_cnt || '' hoá đơn còn nợ''
                       || CASE WHEN v_kept_paid > 0
                                 THEN ''; giữ lại '' || round(v_kept_paid)::bigint
                                      || ''đ đã thu làm doanh thu''
                                 ELSE '''' END
                       || '')''
                  ELSE '''' END
    )
    RETURNING id INTO v_invoice_id;

    INSERT INTO invoice_items (
      invoice_id, type, description,
      unit_price, quantity, coefficient, amount, sort_order
    ) VALUES (
      v_invoice_id, ''PENALTY'',
      ''Phí phạt khách bỏ cọc (giữ tiền cọc đã thu)'',
      v_deposit, 1, 1, v_deposit, 1
    );

    -- Cặp bút toán nội bộ TỰ DUYỆT — CẢ 2 CHÂN trên sổ nội bộ (net 0).
    v_type_off := public._termination_ensure_type(v_contract.user_id, ''expense'', ''Cấn cọc chuyển doanh thu'');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, ''income'', ''Doanh thu bỏ cọc'');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, ''EXPENSE'', ''Cấn cọc bỏ cọc → chuyển doanh thu — HĐ '' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_int, p_forfeit_date, v_deposit, ''UNAPPROVED'',
            v_marker || '' Bút toán nội bộ: cọc khách bỏ chuyển thành doanh thu (tự duyệt; không phải tiền thật — không vào sổ quỹ).'',
            ''termination.forfeit_offset'')
    RETURNING id INTO v_chi_id;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_chi_id, v_type_off, ''Cấn cọc bỏ cọc chuyển doanh thu'', 1, v_deposit, p_forfeit_date, p_forfeit_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, ''INCOME'', ''Doanh thu bỏ cọc — HĐ '' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_int, v_invoice_id, p_forfeit_date, v_deposit, ''UNAPPROVED'',
            v_marker || '' Bút toán nội bộ: doanh thu bỏ cọc (tự duyệt → tất toán hoá đơn thanh lý; KQKD đếm theo hạng mục).'',
            ''termination.forfeit_revenue'')
    RETURNING id INTO v_thu_id;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_thu_id, v_type_inc, ''Doanh thu bỏ cọc (cọc khách bỏ)'', 1, v_deposit, p_forfeit_date, p_forfeit_date);

    -- 7af: cặp bút toán nội bộ TỰ DUYỆT ngay trong writer (hướng A).
    -- Đóng dấu bản chất trước — Finance V2 hết coi đây là phiếu tiền thật.
    -- 7b1: review_state đi CÙNG cú duyệt, KHÔNG đi trước. Ở nhịp này cả 2
    -- chân còn UNAPPROVED, mà ie_unapproved_review_state_ck cấm cặp
    -- (UNAPPROVED, RESOLVED) — đặt ở đây là 23514, chặn cứng thanh lý.
    UPDATE public.income_expenses
       SET posting_mode   = ''NON_CASH'',
           posting_status = ''NOT_APPLICABLE''
     WHERE id IN (v_chi_id, v_thu_id);

    -- Token cho CẢ HAI chân: chân doanh thu do lệnh dưới đổi, chân đối ứng do
    -- cascade trg_forfeit_settle_on_approve đổi — guard a05 đòi token từng phiếu.
    INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
    VALUES (v_thu_id, pg_current_xact_id(), ''APPROVED''),
           (v_chi_id, pg_current_xact_id(), ''APPROVED'');

    -- Duyệt chân doanh thu → cascade duyệt chân đối ứng + tất toán hoá đơn.
    UPDATE public.income_expenses
       SET approval_status = ''APPROVED'',
           approved_by     = COALESCE(auth.uid(), v_contract.user_id),
           approved_at     = now(),
           review_state    = ''RESOLVED'',
           review_version  = income_expenses.review_version + 1
     WHERE id = v_thu_id;

    DELETE FROM app_private.ie_transition_authorization
     WHERE income_expense_id IN (v_thu_id, v_chi_id)
       AND xid = pg_current_xact_id();
  END IF;

  IF jsonb_typeof(COALESCE(p_extra_charges, ''[]''::jsonb)) = ''array'' THEN
    SELECT COALESCE(SUM((j->>''amount'')::numeric), 0) INTO v_extra
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE (j->>''amount'') IS NOT NULL AND (j->>''amount'') <> ''''
       AND (j->>''amount'')::numeric > 0;
  END IF;

  IF v_extra > 0 THEN
    -- v4: hoá đơn thu thêm cũng mang ĐÚNG kỳ tháng bỏ cọc, kind=''SETTLEMENT''.
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, kind, billing_month, issue_date, due_date, status, subtotal, discount_amount, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building_id, v_contract.room_id, ''SETTLEMENT'', v_billing, p_forfeit_date, p_forfeit_date,
            ''APPROVED''::invoice_status, 0, 0, 0,
            ''Hoá đơn thu thêm khi thanh lý — khách bỏ cọc ngày '' || to_char(p_forfeit_date,''DD/MM/YYYY'')
              || '' (thu riêng — không liên quan hoá đơn bù cọc).'')
    RETURNING id INTO v_extra_inv;
    PERFORM public._termination_apply_extra_charges(v_extra_inv, p_extra_charges, p_forfeit_date, v_contract.user_id, p_contract_id);
    PERFORM public.recompute_invoice_for_id(v_extra_inv);
  END IF;

  UPDATE contracts
     SET status          = ''TERMINATED'',
         actual_end_date = p_forfeit_date,
         notes           = CASE
                             WHEN notes IS NULL OR length(btrim(notes)) = 0
                               THEN ''[Thanh lý — khách bỏ cọc '' || to_char(p_forfeit_date,''DD/MM/YYYY'') || '']''
                             ELSE notes || E''\n[Thanh lý — khách bỏ cọc '' || to_char(p_forfeit_date,''DD/MM/YYYY'') || '']''
                           END,
         updated_at      = NOW()
   WHERE id = p_contract_id;

  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date,
      termination_type,
      outstanding_debt, early_termination_fee, prorated_rent, prorated_days, prorated_services,
      total_deposit, status, approved_by, approved_at, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, p_forfeit_date, p_forfeit_date,
      ''FORFEIT'',
      0, v_deposit, 0, 0, 0,
      v_deposit, ''COMPLETED'', auth.uid(), NOW(),
      ''Khách bỏ cọc — đã tạo phiếu thu "Doanh thu bỏ cọc" (chờ duyệt) cho phần cọc thực thu '' || round(v_deposit)::bigint || ''đ.''
        || CASE WHEN v_kept_paid > 0
                  THEN '' Đã giữ lại '' || round(v_kept_paid)::bigint
                       || ''đ đã thu làm doanh thu.''
                  ELSE '''' END
        || CASE WHEN v_extra > 0
                  THEN '' Hoá đơn thu thêm riêng '' || round(v_extra)::bigint || ''đ (chờ thu).''
                  ELSE '''' END
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING ''terminate_contract_forfeit_impl: audit insert failed for %: %'', p_contract_id, SQLERRM;
  END;

  RETURN jsonb_build_object(
    ''contract_id'',                p_contract_id,
    ''invoice_id'',                 v_invoice_id,
    ''settlement_invoice_id'',      v_invoice_id,
    ''extra_invoice_id'',           v_extra_inv,
    ''extra_charges_total'',        v_extra,
    ''forfeit_amount'',             v_deposit,
    ''cancelled_invoices'',         v_cancelled_cnt,
    ''kept_paid_amount'',           v_kept_paid,
    ''pending_income_voucher_id'',  v_thu_id,
    ''pending_expense_voucher_id'', v_chi_id,
    ''acc_internal'',               v_acc_int
  );
END;
$function$
','CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit_impl(p_contract_id uuid, p_forfeit_date date, p_extra_charges jsonb DEFAULT ''[]''::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE
  v_contract       RECORD;
  v_building_id    uuid;
  v_invoice_id     uuid;
  v_extra_inv      uuid;
  v_extra          numeric(15,2) := 0;
  v_deposit        numeric(15,2);
  v_billing        text;
  v_cnumber        text;
  v_marker         text;
  v_acc_int        uuid;
  v_type_off       uuid;
  v_type_inc       uuid;
  v_chi_id         uuid;
  v_thu_id         uuid;
  v_kept_paid      numeric(15,2);
  v_paid_cnt       integer;
  v_unpaid_cnt     integer;
  v_cancelled_cnt  integer;
BEGIN
  SELECT * INTO v_contract
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION ''Hợp đồng không tồn tại'';
  END IF;
  IF v_contract.status IN (''TERMINATED'',''EXPIRED'') THEN
    RAISE EXCEPTION ''Hợp đồng đã thanh lý/hết hạn'';
  END IF;
  IF v_contract.room_id IS NULL THEN
    RAISE EXCEPTION ''Hợp đồng chưa gán phòng — không thể thanh lý'';
  END IF;
  IF p_forfeit_date < v_contract.start_date THEN
    RAISE EXCEPTION ''Ngày bỏ cọc (%) không được trước ngày bắt đầu hợp đồng (%)'',
      to_char(p_forfeit_date,''DD/MM/YYYY''), to_char(v_contract.start_date,''DD/MM/YYYY'');
  END IF;
  SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;
  IF v_building_id IS NULL THEN
    RAISE EXCEPTION ''Không xác định được toà nhà của hợp đồng'';
  END IF;

  -- Cọc forfeit = cọc THỰC đã thu (nguồn sự thật: contracts.deposit_paid).
  -- [A9] Cọc đã thu > cọc theo hợp đồng ⇒ DỪNG, không đoán.
  -- Công thức LEAST() bên dưới lấy số NHỎ hơn, nên khi ô "Tiền cọc" trên hợp
  -- đồng khai 0 mà thực đã thu (vd HĐT-062953: 0 / 4.000.000) thì v_deposit = 0
  -- và TOÀN BỘ khối doanh thu bị bỏ qua trong im lặng: không hoá đơn, không
  -- phiếu, 0đ doanh thu trên tiền đang giữ trong két.
  --
  -- KHÔNG sửa thành COALESCE(deposit_paid,0): đo được 3/4 hợp đồng dôi ra là do
  -- phiếu "[Accounting repair] Contract deposit" ĐẾM TRÙNG với phiếu thu cọc
  -- tường minh (2.000.000 + 1.500.000 + 300.000 = 3.800.000đ). Lấy thẳng
  -- deposit_paid sẽ ghi KHỐNG đúng số đó vào KQKD rồi chảy sang chia lợi nhuận.
  IF COALESCE(v_contract.deposit_paid, 0) > COALESCE(v_contract.total_deposit, 0) THEN
    RAISE EXCEPTION ''Không thanh lý được: cọc ĐÃ THU (% đ) lớn hơn cọc THEO HỢP ĐỒNG (% đ), dôi % đ. Hệ thống không tự đoán số nào đúng. Hãy kiểm tra sổ cọc của hợp đồng: nếu có phiếu cọc bị ĐẾM TRÙNG thì huỷ/điều chỉnh phiếu đó; nếu ô "Tiền cọc" trên hợp đồng khai thiếu thì sửa lại cho khớp số THỰC NHẬN. Đừng nâng "Tiền cọc" chỉ để chạy được lệnh — làm vậy sẽ ghi khống phần dôi thành doanh thu.'',
      round(COALESCE(v_contract.deposit_paid, 0))::bigint,
      round(COALESCE(v_contract.total_deposit, 0))::bigint,
      round(COALESCE(v_contract.deposit_paid,0) - COALESCE(v_contract.total_deposit,0))::bigint
      USING ERRCODE = ''55000'';
  END IF;
  v_deposit := LEAST(COALESCE(v_contract.total_deposit, 0), COALESCE(v_contract.deposit_paid, 0));
  v_billing := to_char(COALESCE(p_forfeit_date, public.org_today_v1(NULL)), ''YYYY-MM'');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_marker  := ''[CẤN CỌC BỎ CỌC '' || p_contract_id::text || '']'';

  v_acc_int := app_private.internal_settlement_account_in_org_v1(v_contract.user_id,v_contract.organization_id);

  SELECT COALESCE(SUM(paid_amount), 0)
    INTO v_kept_paid
    FROM invoices
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN (''APPROVED'',''OVERDUE'',''PARTIAL_PAID'')
     AND COALESCE(paid_amount, 0) > 0;

  UPDATE invoices
     SET status       = ''CANCELLED'',
         total_amount = COALESCE(paid_amount, 0),
         notes        = CASE
                        WHEN notes IS NULL OR length(btrim(notes)) = 0
                          THEN ''[Huỷ — thanh lý bỏ cọc ngày ''
                               || to_char(p_forfeit_date,''DD/MM/YYYY'')
                               || ''; giữ lại '' || round(COALESCE(paid_amount,0))::bigint
                               || ''đ đã thu làm doanh thu, huỷ phần nợ ''
                               || round(COALESCE(remaining_amount,0))::bigint || ''đ]''
                        ELSE notes
                             || E''\n[Huỷ — thanh lý bỏ cọc ngày ''
                             || to_char(p_forfeit_date,''DD/MM/YYYY'')
                             || ''; giữ lại '' || round(COALESCE(paid_amount,0))::bigint
                             || ''đ đã thu làm doanh thu, huỷ phần nợ ''
                             || round(COALESCE(remaining_amount,0))::bigint || ''đ]''
                      END,
         updated_at = NOW()
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN (''APPROVED'',''OVERDUE'',''PARTIAL_PAID'')
     AND COALESCE(paid_amount, 0) > 0;
  GET DIAGNOSTICS v_paid_cnt = ROW_COUNT;

  UPDATE invoices
     SET status       = ''CANCELLED'',
         total_amount = 0,
         notes        = CASE
                        WHEN notes IS NULL OR length(btrim(notes)) = 0
                          THEN ''[Huỷ tự động — thanh lý bỏ cọc ngày ''
                               || to_char(p_forfeit_date,''DD/MM/YYYY'') || '']''
                        ELSE notes
                             || E''\n[Huỷ tự động — thanh lý bỏ cọc ngày ''
                             || to_char(p_forfeit_date,''DD/MM/YYYY'') || '']''
                      END,
         updated_at   = NOW()
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN (''APPROVED'',''OVERDUE'',''PARTIAL_PAID'')
     AND COALESCE(paid_amount, 0) = 0;
  GET DIAGNOSTICS v_unpaid_cnt = ROW_COUNT;

  v_cancelled_cnt := COALESCE(v_paid_cnt, 0) + COALESCE(v_unpaid_cnt, 0);

  IF v_deposit > 0 THEN
    -- v4: hoá đơn bù cọc mang ĐÚNG kỳ tháng bỏ cọc (kind=''SETTLEMENT'' —
    -- partial unique không còn chặn; thôi mượn slot tháng trống).
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id,
      kind, billing_month, issue_date, due_date,
      status, subtotal, discount_amount, total_amount,
      notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id,
      ''SETTLEMENT'', v_billing, p_forfeit_date, p_forfeit_date,
      ''APPROVED''::invoice_status, v_deposit, 0, v_deposit,
      ''Hoá đơn thanh lý — khách bỏ cọc ngày '' || to_char(p_forfeit_date,''DD/MM/YYYY'')
        || CASE WHEN v_cancelled_cnt > 0
                  THEN E''\n(Đã huỷ '' || v_cancelled_cnt || '' hoá đơn còn nợ''
                       || CASE WHEN v_kept_paid > 0
                                 THEN ''; giữ lại '' || round(v_kept_paid)::bigint
                                      || ''đ đã thu làm doanh thu''
                                 ELSE '''' END
                       || '')''
                  ELSE '''' END
    )
    RETURNING id INTO v_invoice_id;

    INSERT INTO invoice_items (
      invoice_id, type, description,
      unit_price, quantity, coefficient, amount, sort_order
    ) VALUES (
      v_invoice_id, ''PENALTY'',
      ''Phí phạt khách bỏ cọc (giữ tiền cọc đã thu)'',
      v_deposit, 1, 1, v_deposit, 1
    );

    -- Cặp bút toán nội bộ TỰ DUYỆT — CẢ 2 CHÂN trên sổ nội bộ (net 0).
    v_type_off := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''expense'', ''Cấn cọc chuyển doanh thu'',v_contract.organization_id);
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''income'', ''Doanh thu bỏ cọc'',v_contract.organization_id);
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, ''EXPENSE'', ''Cấn cọc bỏ cọc → chuyển doanh thu — HĐ '' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_int, p_forfeit_date, v_deposit, ''UNAPPROVED'',
            v_marker || '' Bút toán nội bộ: cọc khách bỏ chuyển thành doanh thu (tự duyệt; không phải tiền thật — không vào sổ quỹ).'',
            ''termination.forfeit_offset'')
    RETURNING id INTO v_chi_id;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_chi_id, v_type_off, ''Cấn cọc bỏ cọc chuyển doanh thu'', 1, v_deposit, p_forfeit_date, p_forfeit_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, ''INCOME'', ''Doanh thu bỏ cọc — HĐ '' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_int, v_invoice_id, p_forfeit_date, v_deposit, ''UNAPPROVED'',
            v_marker || '' Bút toán nội bộ: doanh thu bỏ cọc (tự duyệt → tất toán hoá đơn thanh lý; KQKD đếm theo hạng mục).'',
            ''termination.forfeit_revenue'')
    RETURNING id INTO v_thu_id;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_thu_id, v_type_inc, ''Doanh thu bỏ cọc (cọc khách bỏ)'', 1, v_deposit, p_forfeit_date, p_forfeit_date);

    -- 7af: cặp bút toán nội bộ TỰ DUYỆT ngay trong writer (hướng A).
    -- Đóng dấu bản chất trước — Finance V2 hết coi đây là phiếu tiền thật.
    -- 7b1: review_state đi CÙNG cú duyệt, KHÔNG đi trước. Ở nhịp này cả 2
    -- chân còn UNAPPROVED, mà ie_unapproved_review_state_ck cấm cặp
    -- (UNAPPROVED, RESOLVED) — đặt ở đây là 23514, chặn cứng thanh lý.
    UPDATE public.income_expenses
       SET posting_mode   = ''NON_CASH'',
           posting_status = ''NOT_APPLICABLE''
     WHERE id IN (v_chi_id, v_thu_id);

    -- Token cho CẢ HAI chân: chân doanh thu do lệnh dưới đổi, chân đối ứng do
    -- cascade trg_forfeit_settle_on_approve đổi — guard a05 đòi token từng phiếu.
    INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
    VALUES (v_thu_id, pg_current_xact_id(), ''APPROVED''),
           (v_chi_id, pg_current_xact_id(), ''APPROVED'');

    -- Duyệt chân doanh thu → cascade duyệt chân đối ứng + tất toán hoá đơn.
    UPDATE public.income_expenses
       SET approval_status = ''APPROVED'',
           approved_by     = COALESCE(auth.uid(), v_contract.user_id),
           approved_at     = now(),
           review_state    = ''RESOLVED'',
           review_version  = income_expenses.review_version + 1
     WHERE id = v_thu_id;

    DELETE FROM app_private.ie_transition_authorization
     WHERE income_expense_id IN (v_thu_id, v_chi_id)
       AND xid = pg_current_xact_id();
  END IF;

  IF jsonb_typeof(COALESCE(p_extra_charges, ''[]''::jsonb)) = ''array'' THEN
    SELECT COALESCE(SUM((j->>''amount'')::numeric), 0) INTO v_extra
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE (j->>''amount'') IS NOT NULL AND (j->>''amount'') <> ''''
       AND (j->>''amount'')::numeric > 0;
  END IF;

  IF v_extra > 0 THEN
    -- v4: hoá đơn thu thêm cũng mang ĐÚNG kỳ tháng bỏ cọc, kind=''SETTLEMENT''.
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, kind, billing_month, issue_date, due_date, status, subtotal, discount_amount, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building_id, v_contract.room_id, ''SETTLEMENT'', v_billing, p_forfeit_date, p_forfeit_date,
            ''APPROVED''::invoice_status, 0, 0, 0,
            ''Hoá đơn thu thêm khi thanh lý — khách bỏ cọc ngày '' || to_char(p_forfeit_date,''DD/MM/YYYY'')
              || '' (thu riêng — không liên quan hoá đơn bù cọc).'')
    RETURNING id INTO v_extra_inv;
    PERFORM public._termination_apply_extra_charges(v_extra_inv, p_extra_charges, p_forfeit_date, v_contract.user_id, p_contract_id);
    PERFORM public.recompute_invoice_for_id(v_extra_inv);
  END IF;

  UPDATE contracts
     SET status          = ''TERMINATED'',
         actual_end_date = p_forfeit_date,
         notes           = CASE
                             WHEN notes IS NULL OR length(btrim(notes)) = 0
                               THEN ''[Thanh lý — khách bỏ cọc '' || to_char(p_forfeit_date,''DD/MM/YYYY'') || '']''
                             ELSE notes || E''\n[Thanh lý — khách bỏ cọc '' || to_char(p_forfeit_date,''DD/MM/YYYY'') || '']''
                           END,
         updated_at      = NOW()
   WHERE id = p_contract_id;

  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date,
      termination_type,
      outstanding_debt, early_termination_fee, prorated_rent, prorated_days, prorated_services,
      total_deposit, status, approved_by, approved_at, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, p_forfeit_date, p_forfeit_date,
      ''FORFEIT'',
      0, v_deposit, 0, 0, 0,
      v_deposit, ''COMPLETED'', auth.uid(), NOW(),
      ''Khách bỏ cọc — đã tạo phiếu thu "Doanh thu bỏ cọc" (chờ duyệt) cho phần cọc thực thu '' || round(v_deposit)::bigint || ''đ.''
        || CASE WHEN v_kept_paid > 0
                  THEN '' Đã giữ lại '' || round(v_kept_paid)::bigint
                       || ''đ đã thu làm doanh thu.''
                  ELSE '''' END
        || CASE WHEN v_extra > 0
                  THEN '' Hoá đơn thu thêm riêng '' || round(v_extra)::bigint || ''đ (chờ thu).''
                  ELSE '''' END
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING ''terminate_contract_forfeit_impl: audit insert failed for %: %'', p_contract_id, SQLERRM;
  END;

  RETURN jsonb_build_object(
    ''contract_id'',                p_contract_id,
    ''invoice_id'',                 v_invoice_id,
    ''settlement_invoice_id'',      v_invoice_id,
    ''extra_invoice_id'',           v_extra_inv,
    ''extra_charges_total'',        v_extra,
    ''forfeit_amount'',             v_deposit,
    ''cancelled_invoices'',         v_cancelled_cnt,
    ''kept_paid_amount'',           v_kept_paid,
    ''pending_income_voucher_id'',  v_thu_id,
    ''pending_expense_voucher_id'', v_chi_id,
    ''acc_internal'',               v_acc_int
  );
END;
$function$
');
  IF md5(definition) <> '73be158a92b0c01871d6e03387e8a71c' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)'::regprocedure);
  IF md5(definition) = '7ff469cae791132bd43022177add0713' THEN RETURN; END IF;
  IF md5(definition) <> '6b5d7e0ce200868ee63dacfb53c1e9a6' THEN RAISE EXCEPTION 'Live function changed: %','public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)'; END IF;
  definition := replace(definition,'CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_impl(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric DEFAULT 0, p_penalty_fee numeric DEFAULT 0, p_excess_rent numeric DEFAULT 0, p_outstanding_debt numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_extra_charges jsonb DEFAULT ''[]''::jsonb, p_shortfall_mode text DEFAULT ''PAID''::text, p_receipt_account_id uuid DEFAULT NULL::uuid, p_refund_items jsonb DEFAULT ''[]''::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE
  v_contract  RECORD;
  v_building  uuid;
  v_acc_op    uuid;   -- sổ vận hành (fallback nhận tiền thật)
  v_acc_int   uuid;   -- sổ bút toán nội bộ (cả 2 chân cấn cọc)
  v_acc_rcpt  uuid;   -- sổ NHẬN "khách trả thêm" (tiền thật)
  v_billing   text;
  v_cnumber   text;
  v_deposit   numeric(15,2);
  v_penalty   numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess    numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt      numeric(15,2) := COALESCE(p_outstanding_debt, 0);
  v_extra     numeric(15,2) := 0;
  v_owed      numeric(15,2) := 0;   -- tổng "Hoàn lại khách" (mình nợ khách)
  v_charges_left numeric(15,2);
  v_owed_applied numeric(15,2);
  v_refund_owed  numeric(15,2);
  v_type_rentref uuid;
  v_charges   numeric(15,2);
  v_pool      numeric(15,2);
  v_applied   numeric(15,2);
  v_applied_dep numeric(15,2);
  v_refund_dep  numeric(15,2);
  v_refund_exc  numeric(15,2);
  v_S         numeric(15,2);
  v_budget    numeric(15,2);
  v_pay       numeric(15,2);
  v_settle_inv uuid;
  v_next_sort integer;
  v_type_inc  uuid;
  v_type_off  uuid;
  v_type_dep  uuid;
  v_type_excr uuid;
  v_voucher   uuid;
  v_refund_voucher uuid;
  v_breakdown text;
  rec         RECORD;
BEGIN
  IF p_shortfall_mode NOT IN (''PAID'', ''DEBT'') THEN
    RAISE EXCEPTION ''p_shortfall_mode phải là PAID hoặc DEBT'';
  END IF;

  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION ''Hợp đồng không tồn tại''; END IF;
  IF v_contract.status IN (''TERMINATED'',''EXPIRED'') THEN RAISE EXCEPTION ''Hợp đồng đã thanh lý/hết hạn''; END IF;
  IF v_contract.room_id IS NULL THEN RAISE EXCEPTION ''Hợp đồng chưa gán phòng — không thể thanh lý''; END IF;
  IF p_move_out_date < v_contract.start_date THEN
    RAISE EXCEPTION ''Ngày chuyển đi (%) không được trước ngày bắt đầu hợp đồng (%)'',
      to_char(p_move_out_date,''DD/MM/YYYY''), to_char(v_contract.start_date,''DD/MM/YYYY'');
  END IF;
  SELECT building_id INTO v_building FROM rooms WHERE id = v_contract.room_id;
  IF v_building IS NULL THEN RAISE EXCEPTION ''Không xác định được toà nhà của hợp đồng''; END IF;

  v_billing := to_char(COALESCE(p_move_out_date, public.org_today_v1(NULL)), ''YYYY-MM'');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_acc_op  := public._termination_pick_account(v_contract.user_id, v_building);
  v_acc_int := public._internal_settlement_account(v_contract.user_id);

  -- Sổ NHẬN "khách trả thêm" (tiền thật): form chọn > sổ %Thu của người bấm > sổ vận hành toà.
  v_acc_rcpt := COALESCE(p_receipt_account_id, public._collector_thu_account(auth.uid()), v_acc_op);
  IF p_receipt_account_id IS NOT NULL THEN
    PERFORM 1 FROM accounts a WHERE a.id = p_receipt_account_id AND a.deleted_at IS NULL AND a.is_virtual = false;
    IF NOT FOUND THEN
      RAISE EXCEPTION ''Sổ nhận tiền không hợp lệ (không tồn tại hoặc là sổ ảo)'';
    END IF;
  END IF;

  -- A1: hoàn/cấn cọc tối đa bằng cọc THỰC THU (deposit_paid).
  v_deposit := LEAST(GREATEST(COALESCE(p_deposit_refund, 0), 0), COALESCE(v_contract.deposit_paid, 0));

  IF jsonb_typeof(COALESCE(p_extra_charges, ''[]''::jsonb)) = ''array'' THEN
    SELECT COALESCE(SUM((j->>''amount'')::numeric), 0) INTO v_extra
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE (j->>''amount'') IS NOT NULL AND (j->>''amount'') <> ''''
       AND (j->>''amount'')::numeric > 0;
  END IF;

  IF jsonb_typeof(COALESCE(p_refund_items, ''[]''::jsonb)) = ''array'' THEN
    SELECT COALESCE(SUM((j->>''amount'')::numeric), 0) INTO v_owed
      FROM jsonb_array_elements(p_refund_items) AS t(j)
     WHERE (j->>''amount'') IS NOT NULL AND (j->>''amount'') <> ''''
       AND (j->>''amount'')::numeric > 0;
  END IF;

  v_charges     := v_debt + v_penalty + v_extra;
  v_pool        := v_deposit + v_excess;
  v_applied     := LEAST(v_pool + v_owed, v_charges);
  v_applied_dep := LEAST(v_deposit, v_charges);
  v_refund_dep  := v_deposit - v_applied_dep;
  v_refund_exc  := v_excess - LEAST(v_excess, GREATEST(v_charges - v_deposit, 0));
  -- "Hoàn lại khách" CHỈ được cấn vào phần công nợ CÒN LẠI sau khi cọc và credit
  -- đã cấn xong. Cấn sớm hơn sẽ làm v_refund_dep xê dịch — mà con số đó phải
  -- khớp cột GENERATED contract_terminations.refund_amount, nền của cảnh báo
  -- VUOT_COC_THAT trong nghĩa vụ hoàn cọc (preview_termination_refund_v1).
  v_charges_left := GREATEST(v_charges - v_deposit - v_excess, 0);
  v_owed_applied := LEAST(v_owed, v_charges_left);
  v_refund_owed  := v_owed - v_owed_applied;
  v_S           := v_pool + v_owed - v_charges;

  v_breakdown :=
       ''QUYẾT TOÁN THANH LÝ '' || to_char(p_move_out_date,''DD/MM/YYYY'') || '' — HĐ '' || v_cnumber
    || E''\n• Cọc đã thu: '' || to_char(v_deposit, ''FM999G999G999G990'') || ''đ''
    || E''\n• Khấu trừ: công nợ '' || to_char(v_debt, ''FM999G999G999G990'') || ''đ''
    || CASE WHEN v_penalty > 0 THEN '' + phí phạt '' || to_char(v_penalty, ''FM999G999G999G990'') || ''đ'' ELSE '''' END
    || CASE WHEN v_extra   > 0 THEN '' + thu thêm '' || to_char(v_extra, ''FM999G999G999G990'') || ''đ'' ELSE '''' END
    || '' = '' || to_char(v_charges, ''FM999G999G999G990'') || ''đ''
    || E''\n• Cọc cấn vào khấu trừ: '' || to_char(v_applied_dep, ''FM999G999G999G990'') || ''đ (bút toán nội bộ, không đụng sổ tiền thật)''
    || CASE WHEN v_excess > 0 THEN E''\n• Tiền thừa (credit) áp dụng: '' || to_char(v_excess, ''FM999G999G999G990'') || ''đ (cấn '' || to_char(v_excess - v_refund_exc, ''FM999G999G999G990'') || ''đ, hoàn '' || to_char(v_refund_exc, ''FM999G999G999G990'') || ''đ)'' ELSE '''' END
    || CASE WHEN v_owed > 0 THEN E''\n• Hoàn lại khách (tiền phòng ngày không ở…): '' || to_char(v_owed, ''FM999G999G999G990'') || ''đ (cấn '' || to_char(v_owed_applied, ''FM999G999G999G990'') || ''đ, chi '' || to_char(v_refund_owed, ''FM999G999G999G990'') || ''đ)'' ELSE '''' END
    || E''\n• Hoàn cọc lại khách: '' || to_char(v_refund_dep, ''FM999G999G999G990'') || ''đ''
    || CASE WHEN v_S < 0 THEN E''\n• Khách còn phải trả: '' || to_char(-v_S, ''FM999G999G999G990'') || ''đ (''
         || CASE WHEN p_shortfall_mode = ''PAID'' THEN ''đã thu ngay khi thanh lý'' ELSE ''GHI NỢ — chờ thu'' END || '')''
       ELSE '''' END
    || CASE WHEN v_refund_dep + v_refund_exc + v_refund_owed > 0 THEN E''\n• Tổng chi hoàn khách: '' || to_char(v_refund_dep + v_refund_exc + v_refund_owed, ''FM999G999G999G990'') || ''đ (phiếu chi chờ duyệt — chọn sổ quỹ khi duyệt)'' ELSE '''' END;

  -- 1. HOÁ ĐƠN THANH LÝ RIÊNG (kind=''SETTLEMENT'', ĐÚNG kỳ tháng trả phòng).
  --    v4: KHÔNG đụng hoá đơn tháng nữa — dù nó chưa/đã PAID. Công nợ của nó
  --    vẫn được gạch ở bước 2 bằng payments ''CT'' (không sửa nội dung hoá đơn).
  IF v_penalty > 0 OR v_extra > 0 THEN
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, kind, billing_month, issue_date, due_date, status, subtotal, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building, v_contract.room_id, ''SETTLEMENT'',
      v_billing, p_move_out_date, p_move_out_date, ''APPROVED''::invoice_status, 0, 0,
      ''Hoá đơn thanh lý — khách rời phòng ngày '' || to_char(p_move_out_date,''DD/MM/YYYY'') || COALESCE(E''\n'' || p_notes, ''''))
    RETURNING id INTO v_settle_inv;
  END IF;

  IF v_penalty > 0 THEN
    SELECT COALESCE(MAX(sort_order),0)+1 INTO v_next_sort FROM invoice_items WHERE invoice_id = v_settle_inv;
    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
    VALUES (v_settle_inv, ''PENALTY'', ''Phí phạt thanh lý'', v_penalty, 1, 1, v_penalty, v_next_sort);
    UPDATE invoices SET subtotal = COALESCE(subtotal,0)+v_penalty, total_amount = COALESCE(total_amount,0)+v_penalty, updated_at = NOW() WHERE id = v_settle_inv;
  END IF;

  IF v_extra > 0 THEN
    PERFORM public._termination_apply_extra_charges(v_settle_inv, p_extra_charges, p_move_out_date, v_contract.user_id, p_contract_id);
  END IF;

  IF v_settle_inv IS NOT NULL THEN
    UPDATE invoices
       SET notes = COALESCE(notes || E''\n\n'', '''') || v_breakdown,
           updated_at = NOW()
     WHERE id = v_settle_inv;
  END IF;

  -- 2. Quyết toán hoá đơn còn nợ bằng CẤN TRỪ ''CT'' (PAID: gạch hết; DEBT: trong pool).
  v_budget := CASE WHEN p_shortfall_mode = ''DEBT'' THEN v_applied ELSE NULL END;
  FOR rec IN
    SELECT id, (total_amount - paid_amount) AS remaining FROM invoices
     WHERE contract_id = p_contract_id AND deleted_at IS NULL AND status <> ''CANCELLED''
       AND (total_amount - paid_amount) > 0
     ORDER BY billing_month, created_at
  LOOP
    v_pay := rec.remaining;
    IF v_budget IS NOT NULL THEN
      EXIT WHEN v_budget <= 0;
      v_pay := LEAST(v_pay, v_budget);
      v_budget := v_budget - v_pay;
    END IF;
    IF v_pay > 0 THEN
      INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)
      VALUES (v_contract.user_id, rec.id, v_pay, ''CT''::payment_method, p_move_out_date,
              ''Quyết toán khi thanh lý '' || to_char(p_move_out_date,''DD/MM/YYYY''));
    END IF;
  END LOOP;

  -- 3. CẶP BÚT TOÁN NỘI BỘ (cấn cọc → doanh thu) — CẢ 2 CHÂN trên sổ nội bộ,
  --    net 0/thương vụ; KHÔNG đụng sổ tiền thật (mô hình chốt 04/07).
  IF v_applied_dep > 0 THEN
    v_type_off := public._termination_ensure_type(v_contract.user_id, ''expense'', ''Cấn cọc chuyển doanh thu'');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, ''income'', ''Doanh thu thanh lý'');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, ''EXPENSE'', ''Cấn cọc → chuyển doanh thu — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_applied_dep, ''APPROVED'',
      ''[CHUYỂN KHOẢN] Bút toán nội bộ: cọc cấn công nợ/phạt (không phải tiền thật).'' || E''\n\n'' || v_breakdown,
      ''termination.offset'')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_off, ''Cấn cọc chuyển doanh thu'', 1, v_applied_dep, p_move_out_date, p_move_out_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, ''INCOME'', ''Doanh thu thanh lý — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_applied_dep, ''APPROVED'',
      ''[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu thanh lý từ cọc cấn nợ/phạt (KQKD đếm theo hạng mục).'',
      ''termination.revenue'')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, ''Doanh thu thanh lý (cấn cọc)'', 1, v_applied_dep, p_move_out_date, p_move_out_date);
  END IF;

  -- 3b. KHOẢN HOÀN BỊ CẤN VÀO CÔNG NỢ — cặp bút toán nội bộ, net 0 trên sổ nội
  --     bộ, KHÔNG đụng sổ tiền thật. Gương của cặp cấn cọc ở bước 3, khác ở chỗ
  --     chân chi mang loại is_deposit=FALSE: tiền phòng đã ghi doanh thu rồi nên
  --     trả lại là GIẢM LÃI THẬT, còn cọc là tiền giữ hộ nên nằm ngoài KQKD.
  IF v_owed_applied > 0 THEN
    v_type_rentref := public._termination_ensure_type(v_contract.user_id, ''expense'', ''Hoàn tiền phòng thanh lý'');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_rentref AND is_deposit IS DISTINCT FROM FALSE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, ''income'', ''Doanh thu thanh lý'');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, ''EXPENSE'', ''Hoàn tiền phòng cấn công nợ — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_owed_applied, ''APPROVED'',
      ''[CHUYỂN KHOẢN] Bút toán nội bộ: khoản hoàn cho khách được cấn vào công nợ còn lại (không phải tiền thật).'' || E''\n\n'' || v_breakdown,
      ''termination.rent_refund_offset'')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_rentref, ''Hoàn tiền phòng (cấn công nợ)'', 1, v_owed_applied, p_move_out_date, p_move_out_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, ''INCOME'', ''Doanh thu thanh lý (khoản hoàn cấn nợ) — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_owed_applied, ''APPROVED'',
      ''[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu từ phần công nợ được khoản hoàn cấn trừ.'',
      ''termination.rent_refund_revenue'')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, ''Doanh thu thanh lý (khoản hoàn cấn nợ)'', 1, v_owed_applied, p_move_out_date, p_move_out_date);
  END IF;

  -- 4. HOÀN KHÁCH = TIỀN THẬT: 1 phiếu chi NHÁP, SỔ TRỐNG (chọn khi duyệt).
  IF v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, ''EXPENSE'', COALESCE(app_private.termination_refund_name_v1(p_contract_id, p_move_out_date), ''Trả khách thanh lý — HĐ '' || v_cnumber), v_building, v_contract.room_id, p_contract_id, NULL, p_move_out_date, v_refund_dep + v_refund_exc + v_refund_owed, ''UNAPPROVED'',
      ''[HOÀN KHÁCH THANH LÝ] Phiếu chi hoàn khách (tiền thật). CHỌN SỔ QUỸ chi tiền (Sửa phiếu) rồi mới duyệt được.'' || E''\n\n'' || v_breakdown || COALESCE(E''\n'' || p_notes, ''''),
      ''termination.refund'')
    RETURNING id INTO v_refund_voucher;

    IF v_refund_dep > 0 THEN
      v_type_dep := public._termination_ensure_type(v_contract.user_id, ''expense'', ''Hoàn cọc thanh lý'');
      UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type_dep AND is_deposit IS DISTINCT FROM TRUE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_dep, ''Trả lại khách (cọc sau khấu trừ)'', 1, v_refund_dep, p_move_out_date, p_move_out_date);
    END IF;

    IF v_refund_exc > 0 THEN
      v_type_excr := public._termination_ensure_type(v_contract.user_id, ''expense'', ''Hoàn tiền thừa thanh lý'');
      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_excr AND is_deposit IS DISTINCT FROM FALSE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_excr, ''Hoàn tiền thừa khi thanh lý'', 1, v_refund_exc, p_move_out_date, p_move_out_date);
    END IF;

    IF v_refund_owed > 0 THEN
      v_type_rentref := public._termination_ensure_type(v_contract.user_id, ''expense'', ''Hoàn tiền phòng thanh lý'');
      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_rentref AND is_deposit IS DISTINCT FROM FALSE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_rentref, ''Hoàn tiền phòng ngày khách không ở'', 1, v_refund_owed, p_move_out_date, p_move_out_date);
    END IF;
  END IF;

  -- 4c. Khách trả thêm (TIỀN THẬT) — chế độ PAID: vào SỔ NHẬN đã chọn.
  IF v_S < 0 AND p_shortfall_mode = ''PAID'' THEN
    v_type_inc := public._termination_ensure_type(v_contract.user_id, ''income'', ''Thu thanh lý (khách trả thêm)'');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, ''INCOME'', ''Khách trả thêm khi thanh lý — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_rcpt, v_settle_inv, p_move_out_date, -v_S, ''APPROVED'',
      ''Khách trả thêm phần công nợ vượt tiền cọc khi thanh lý (tiền thật vào sổ nhận).'' || COALESCE(E''\n'' || p_notes, ''''),
      ''termination.extra_receipt'')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, ''Khách trả thêm khi thanh lý'', 1, -v_S, p_move_out_date, p_move_out_date);
  END IF;

  -- 5. Recompute hoá đơn quyết toán.
  IF v_settle_inv IS NOT NULL THEN PERFORM public.recompute_invoice_for_id(v_settle_inv); END IF;

  -- 6. Thanh lý hợp đồng (ghi chú kèm bản quyết toán đầy đủ).
  UPDATE contracts
     SET status = ''TERMINATED'', actual_end_date = p_move_out_date,
         notes = CASE WHEN notes IS NULL OR length(btrim(notes)) = 0
                        THEN ''[Thanh lý '' || to_char(p_move_out_date,''DD/MM/YYYY'') || '']'' || COALESCE(E''\n'' || p_notes, '''') || E''\n'' || v_breakdown
                        ELSE notes || E''\n[Thanh lý '' || to_char(p_move_out_date,''DD/MM/YYYY'') || '']'' || COALESCE(E''\n'' || p_notes, '''') || E''\n'' || v_breakdown END,
         updated_at = NOW()
   WHERE id = p_contract_id;

  -- 7. Audit.
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date, termination_type,
      outstanding_debt, early_termination_fee, prorated_rent, prorated_days, prorated_services,
      total_deposit, rent_refund_amount, refund_method, status, approved_by, approved_at, notes)
    VALUES (
      v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date, ''NORMAL'',
      v_debt, v_penalty + v_extra, 0, 0, 0,
      v_deposit, v_owed,
      CASE WHEN v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN ''TM''::payment_method ELSE NULL END,
      ''COMPLETED'', auth.uid(), NOW(),
      COALESCE(p_notes || E''\n'', '''') || v_breakdown);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING ''terminate_contract_move_out_impl: audit insert failed for %: %'', p_contract_id, SQLERRM;
  END;

  RETURN jsonb_build_object(
    ''contract_id'', p_contract_id, ''settlement_invoice_id'', v_settle_inv,
    ''charges'', v_charges, ''extra_charges_total'', v_extra,
    ''applied'', v_applied, ''applied_deposit'', v_applied_dep,
    ''refund_deposit'', v_refund_dep, ''refund_excess'', v_refund_exc,
    ''customer_refund_total'', v_owed, ''customer_refund_applied'', v_owed_applied,
    ''refund_customer'', v_refund_owed,
    ''refund_voucher_id'', v_refund_voucher,
    ''net_settlement'', v_S, ''shortfall_mode'', p_shortfall_mode,
    ''receipt_account_id'', CASE WHEN v_S < 0 AND p_shortfall_mode = ''PAID'' THEN v_acc_rcpt END,
    ''acc_op'', v_acc_op, ''acc_internal'', v_acc_int
  );
END $function$
','CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_impl(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric DEFAULT 0, p_penalty_fee numeric DEFAULT 0, p_excess_rent numeric DEFAULT 0, p_outstanding_debt numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_extra_charges jsonb DEFAULT ''[]''::jsonb, p_shortfall_mode text DEFAULT ''PAID''::text, p_receipt_account_id uuid DEFAULT NULL::uuid, p_refund_items jsonb DEFAULT ''[]''::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE
  v_contract  RECORD;
  v_building  uuid;
  v_acc_op    uuid;   -- sổ vận hành (fallback nhận tiền thật)
  v_acc_int   uuid;   -- sổ bút toán nội bộ (cả 2 chân cấn cọc)
  v_acc_rcpt  uuid;   -- sổ NHẬN "khách trả thêm" (tiền thật)
  v_billing   text;
  v_cnumber   text;
  v_deposit   numeric(15,2);
  v_penalty   numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess    numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt      numeric(15,2) := COALESCE(p_outstanding_debt, 0);
  v_extra     numeric(15,2) := 0;
  v_owed      numeric(15,2) := 0;   -- tổng "Hoàn lại khách" (mình nợ khách)
  v_charges_left numeric(15,2);
  v_owed_applied numeric(15,2);
  v_refund_owed  numeric(15,2);
  v_type_rentref uuid;
  v_charges   numeric(15,2);
  v_pool      numeric(15,2);
  v_applied   numeric(15,2);
  v_applied_dep numeric(15,2);
  v_refund_dep  numeric(15,2);
  v_refund_exc  numeric(15,2);
  v_S         numeric(15,2);
  v_budget    numeric(15,2);
  v_pay       numeric(15,2);
  v_settle_inv uuid;
  v_next_sort integer;
  v_type_inc  uuid;
  v_type_off  uuid;
  v_type_dep  uuid;
  v_type_excr uuid;
  v_voucher   uuid;
  v_refund_voucher uuid;
  v_breakdown text;
  rec         RECORD;
BEGIN
  IF p_shortfall_mode NOT IN (''PAID'', ''DEBT'') THEN
    RAISE EXCEPTION ''p_shortfall_mode phải là PAID hoặc DEBT'';
  END IF;

  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION ''Hợp đồng không tồn tại''; END IF;
  IF v_contract.status IN (''TERMINATED'',''EXPIRED'') THEN RAISE EXCEPTION ''Hợp đồng đã thanh lý/hết hạn''; END IF;
  IF v_contract.room_id IS NULL THEN RAISE EXCEPTION ''Hợp đồng chưa gán phòng — không thể thanh lý''; END IF;
  IF p_move_out_date < v_contract.start_date THEN
    RAISE EXCEPTION ''Ngày chuyển đi (%) không được trước ngày bắt đầu hợp đồng (%)'',
      to_char(p_move_out_date,''DD/MM/YYYY''), to_char(v_contract.start_date,''DD/MM/YYYY'');
  END IF;
  SELECT building_id INTO v_building FROM rooms WHERE id = v_contract.room_id;
  IF v_building IS NULL THEN RAISE EXCEPTION ''Không xác định được toà nhà của hợp đồng''; END IF;

  v_billing := to_char(COALESCE(p_move_out_date, public.org_today_v1(NULL)), ''YYYY-MM'');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_acc_op  := public._termination_pick_account(v_contract.user_id, v_building);
  v_acc_int := app_private.internal_settlement_account_in_org_v1(v_contract.user_id,v_contract.organization_id);

  -- Sổ NHẬN "khách trả thêm" (tiền thật): form chọn > sổ %Thu của người bấm > sổ vận hành toà.
  v_acc_rcpt := COALESCE(p_receipt_account_id, public._collector_thu_account(auth.uid()), v_acc_op);
  IF p_receipt_account_id IS NOT NULL THEN
    PERFORM 1 FROM accounts a WHERE a.id = p_receipt_account_id AND a.deleted_at IS NULL AND a.is_virtual = false;
    IF NOT FOUND THEN
      RAISE EXCEPTION ''Sổ nhận tiền không hợp lệ (không tồn tại hoặc là sổ ảo)'';
    END IF;
  END IF;

  -- A1: hoàn/cấn cọc tối đa bằng cọc THỰC THU (deposit_paid).
  v_deposit := LEAST(GREATEST(COALESCE(p_deposit_refund, 0), 0), COALESCE(v_contract.deposit_paid, 0));

  IF jsonb_typeof(COALESCE(p_extra_charges, ''[]''::jsonb)) = ''array'' THEN
    SELECT COALESCE(SUM((j->>''amount'')::numeric), 0) INTO v_extra
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE (j->>''amount'') IS NOT NULL AND (j->>''amount'') <> ''''
       AND (j->>''amount'')::numeric > 0;
  END IF;

  IF jsonb_typeof(COALESCE(p_refund_items, ''[]''::jsonb)) = ''array'' THEN
    SELECT COALESCE(SUM((j->>''amount'')::numeric), 0) INTO v_owed
      FROM jsonb_array_elements(p_refund_items) AS t(j)
     WHERE (j->>''amount'') IS NOT NULL AND (j->>''amount'') <> ''''
       AND (j->>''amount'')::numeric > 0;
  END IF;

  v_charges     := v_debt + v_penalty + v_extra;
  v_pool        := v_deposit + v_excess;
  v_applied     := LEAST(v_pool + v_owed, v_charges);
  v_applied_dep := LEAST(v_deposit, v_charges);
  v_refund_dep  := v_deposit - v_applied_dep;
  v_refund_exc  := v_excess - LEAST(v_excess, GREATEST(v_charges - v_deposit, 0));
  -- "Hoàn lại khách" CHỈ được cấn vào phần công nợ CÒN LẠI sau khi cọc và credit
  -- đã cấn xong. Cấn sớm hơn sẽ làm v_refund_dep xê dịch — mà con số đó phải
  -- khớp cột GENERATED contract_terminations.refund_amount, nền của cảnh báo
  -- VUOT_COC_THAT trong nghĩa vụ hoàn cọc (preview_termination_refund_v1).
  v_charges_left := GREATEST(v_charges - v_deposit - v_excess, 0);
  v_owed_applied := LEAST(v_owed, v_charges_left);
  v_refund_owed  := v_owed - v_owed_applied;
  v_S           := v_pool + v_owed - v_charges;

  v_breakdown :=
       ''QUYẾT TOÁN THANH LÝ '' || to_char(p_move_out_date,''DD/MM/YYYY'') || '' — HĐ '' || v_cnumber
    || E''\n• Cọc đã thu: '' || to_char(v_deposit, ''FM999G999G999G990'') || ''đ''
    || E''\n• Khấu trừ: công nợ '' || to_char(v_debt, ''FM999G999G999G990'') || ''đ''
    || CASE WHEN v_penalty > 0 THEN '' + phí phạt '' || to_char(v_penalty, ''FM999G999G999G990'') || ''đ'' ELSE '''' END
    || CASE WHEN v_extra   > 0 THEN '' + thu thêm '' || to_char(v_extra, ''FM999G999G999G990'') || ''đ'' ELSE '''' END
    || '' = '' || to_char(v_charges, ''FM999G999G999G990'') || ''đ''
    || E''\n• Cọc cấn vào khấu trừ: '' || to_char(v_applied_dep, ''FM999G999G999G990'') || ''đ (bút toán nội bộ, không đụng sổ tiền thật)''
    || CASE WHEN v_excess > 0 THEN E''\n• Tiền thừa (credit) áp dụng: '' || to_char(v_excess, ''FM999G999G999G990'') || ''đ (cấn '' || to_char(v_excess - v_refund_exc, ''FM999G999G999G990'') || ''đ, hoàn '' || to_char(v_refund_exc, ''FM999G999G999G990'') || ''đ)'' ELSE '''' END
    || CASE WHEN v_owed > 0 THEN E''\n• Hoàn lại khách (tiền phòng ngày không ở…): '' || to_char(v_owed, ''FM999G999G999G990'') || ''đ (cấn '' || to_char(v_owed_applied, ''FM999G999G999G990'') || ''đ, chi '' || to_char(v_refund_owed, ''FM999G999G999G990'') || ''đ)'' ELSE '''' END
    || E''\n• Hoàn cọc lại khách: '' || to_char(v_refund_dep, ''FM999G999G999G990'') || ''đ''
    || CASE WHEN v_S < 0 THEN E''\n• Khách còn phải trả: '' || to_char(-v_S, ''FM999G999G999G990'') || ''đ (''
         || CASE WHEN p_shortfall_mode = ''PAID'' THEN ''đã thu ngay khi thanh lý'' ELSE ''GHI NỢ — chờ thu'' END || '')''
       ELSE '''' END
    || CASE WHEN v_refund_dep + v_refund_exc + v_refund_owed > 0 THEN E''\n• Tổng chi hoàn khách: '' || to_char(v_refund_dep + v_refund_exc + v_refund_owed, ''FM999G999G999G990'') || ''đ (phiếu chi chờ duyệt — chọn sổ quỹ khi duyệt)'' ELSE '''' END;

  -- 1. HOÁ ĐƠN THANH LÝ RIÊNG (kind=''SETTLEMENT'', ĐÚNG kỳ tháng trả phòng).
  --    v4: KHÔNG đụng hoá đơn tháng nữa — dù nó chưa/đã PAID. Công nợ của nó
  --    vẫn được gạch ở bước 2 bằng payments ''CT'' (không sửa nội dung hoá đơn).
  IF v_penalty > 0 OR v_extra > 0 THEN
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, kind, billing_month, issue_date, due_date, status, subtotal, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building, v_contract.room_id, ''SETTLEMENT'',
      v_billing, p_move_out_date, p_move_out_date, ''APPROVED''::invoice_status, 0, 0,
      ''Hoá đơn thanh lý — khách rời phòng ngày '' || to_char(p_move_out_date,''DD/MM/YYYY'') || COALESCE(E''\n'' || p_notes, ''''))
    RETURNING id INTO v_settle_inv;
  END IF;

  IF v_penalty > 0 THEN
    SELECT COALESCE(MAX(sort_order),0)+1 INTO v_next_sort FROM invoice_items WHERE invoice_id = v_settle_inv;
    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
    VALUES (v_settle_inv, ''PENALTY'', ''Phí phạt thanh lý'', v_penalty, 1, 1, v_penalty, v_next_sort);
    UPDATE invoices SET subtotal = COALESCE(subtotal,0)+v_penalty, total_amount = COALESCE(total_amount,0)+v_penalty, updated_at = NOW() WHERE id = v_settle_inv;
  END IF;

  IF v_extra > 0 THEN
    PERFORM public._termination_apply_extra_charges(v_settle_inv, p_extra_charges, p_move_out_date, v_contract.user_id, p_contract_id);
  END IF;

  IF v_settle_inv IS NOT NULL THEN
    UPDATE invoices
       SET notes = COALESCE(notes || E''\n\n'', '''') || v_breakdown,
           updated_at = NOW()
     WHERE id = v_settle_inv;
  END IF;

  -- 2. Quyết toán hoá đơn còn nợ bằng CẤN TRỪ ''CT'' (PAID: gạch hết; DEBT: trong pool).
  v_budget := CASE WHEN p_shortfall_mode = ''DEBT'' THEN v_applied ELSE NULL END;
  FOR rec IN
    SELECT id, (total_amount - paid_amount) AS remaining FROM invoices
     WHERE contract_id = p_contract_id AND deleted_at IS NULL AND status <> ''CANCELLED''
       AND (total_amount - paid_amount) > 0
     ORDER BY billing_month, created_at
  LOOP
    v_pay := rec.remaining;
    IF v_budget IS NOT NULL THEN
      EXIT WHEN v_budget <= 0;
      v_pay := LEAST(v_pay, v_budget);
      v_budget := v_budget - v_pay;
    END IF;
    IF v_pay > 0 THEN
      INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)
      VALUES (v_contract.user_id, rec.id, v_pay, ''CT''::payment_method, p_move_out_date,
              ''Quyết toán khi thanh lý '' || to_char(p_move_out_date,''DD/MM/YYYY''));
    END IF;
  END LOOP;

  -- 3. CẶP BÚT TOÁN NỘI BỘ (cấn cọc → doanh thu) — CẢ 2 CHÂN trên sổ nội bộ,
  --    net 0/thương vụ; KHÔNG đụng sổ tiền thật (mô hình chốt 04/07).
  IF v_applied_dep > 0 THEN
    v_type_off := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''expense'', ''Cấn cọc chuyển doanh thu'',v_contract.organization_id);
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''income'', ''Doanh thu thanh lý'',v_contract.organization_id);
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, ''EXPENSE'', ''Cấn cọc → chuyển doanh thu — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_applied_dep, ''APPROVED'',
      ''[CHUYỂN KHOẢN] Bút toán nội bộ: cọc cấn công nợ/phạt (không phải tiền thật).'' || E''\n\n'' || v_breakdown,
      ''termination.offset'')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_off, ''Cấn cọc chuyển doanh thu'', 1, v_applied_dep, p_move_out_date, p_move_out_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, ''INCOME'', ''Doanh thu thanh lý — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_applied_dep, ''APPROVED'',
      ''[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu thanh lý từ cọc cấn nợ/phạt (KQKD đếm theo hạng mục).'',
      ''termination.revenue'')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, ''Doanh thu thanh lý (cấn cọc)'', 1, v_applied_dep, p_move_out_date, p_move_out_date);
  END IF;

  -- 3b. KHOẢN HOÀN BỊ CẤN VÀO CÔNG NỢ — cặp bút toán nội bộ, net 0 trên sổ nội
  --     bộ, KHÔNG đụng sổ tiền thật. Gương của cặp cấn cọc ở bước 3, khác ở chỗ
  --     chân chi mang loại is_deposit=FALSE: tiền phòng đã ghi doanh thu rồi nên
  --     trả lại là GIẢM LÃI THẬT, còn cọc là tiền giữ hộ nên nằm ngoài KQKD.
  IF v_owed_applied > 0 THEN
    v_type_rentref := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''expense'', ''Hoàn tiền phòng thanh lý'',v_contract.organization_id);
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_rentref AND is_deposit IS DISTINCT FROM FALSE;
    v_type_inc := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''income'', ''Doanh thu thanh lý'',v_contract.organization_id);
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, ''EXPENSE'', ''Hoàn tiền phòng cấn công nợ — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_owed_applied, ''APPROVED'',
      ''[CHUYỂN KHOẢN] Bút toán nội bộ: khoản hoàn cho khách được cấn vào công nợ còn lại (không phải tiền thật).'' || E''\n\n'' || v_breakdown,
      ''termination.rent_refund_offset'')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_rentref, ''Hoàn tiền phòng (cấn công nợ)'', 1, v_owed_applied, p_move_out_date, p_move_out_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, ''INCOME'', ''Doanh thu thanh lý (khoản hoàn cấn nợ) — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_owed_applied, ''APPROVED'',
      ''[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu từ phần công nợ được khoản hoàn cấn trừ.'',
      ''termination.rent_refund_revenue'')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, ''Doanh thu thanh lý (khoản hoàn cấn nợ)'', 1, v_owed_applied, p_move_out_date, p_move_out_date);
  END IF;

  -- 4. HOÀN KHÁCH = TIỀN THẬT: 1 phiếu chi NHÁP, SỔ TRỐNG (chọn khi duyệt).
  IF v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, ''EXPENSE'', COALESCE(app_private.termination_refund_name_v1(p_contract_id, p_move_out_date), ''Trả khách thanh lý — HĐ '' || v_cnumber), v_building, v_contract.room_id, p_contract_id, NULL, p_move_out_date, v_refund_dep + v_refund_exc + v_refund_owed, ''UNAPPROVED'',
      ''[HOÀN KHÁCH THANH LÝ] Phiếu chi hoàn khách (tiền thật). CHỌN SỔ QUỸ chi tiền (Sửa phiếu) rồi mới duyệt được.'' || E''\n\n'' || v_breakdown || COALESCE(E''\n'' || p_notes, ''''),
      ''termination.refund'')
    RETURNING id INTO v_refund_voucher;

    IF v_refund_dep > 0 THEN
      v_type_dep := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''expense'', ''Hoàn cọc thanh lý'',v_contract.organization_id);
      UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type_dep AND is_deposit IS DISTINCT FROM TRUE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_dep, ''Trả lại khách (cọc sau khấu trừ)'', 1, v_refund_dep, p_move_out_date, p_move_out_date);
    END IF;

    IF v_refund_exc > 0 THEN
      v_type_excr := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''expense'', ''Hoàn tiền thừa thanh lý'',v_contract.organization_id);
      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_excr AND is_deposit IS DISTINCT FROM FALSE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_excr, ''Hoàn tiền thừa khi thanh lý'', 1, v_refund_exc, p_move_out_date, p_move_out_date);
    END IF;

    IF v_refund_owed > 0 THEN
      v_type_rentref := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''expense'', ''Hoàn tiền phòng thanh lý'',v_contract.organization_id);
      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_rentref AND is_deposit IS DISTINCT FROM FALSE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_rentref, ''Hoàn tiền phòng ngày khách không ở'', 1, v_refund_owed, p_move_out_date, p_move_out_date);
    END IF;
  END IF;

  -- 4c. Khách trả thêm (TIỀN THẬT) — chế độ PAID: vào SỔ NHẬN đã chọn.
  IF v_S < 0 AND p_shortfall_mode = ''PAID'' THEN
    v_type_inc := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''income'', ''Thu thanh lý (khách trả thêm)'',v_contract.organization_id);
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, ''INCOME'', ''Khách trả thêm khi thanh lý — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_rcpt, v_settle_inv, p_move_out_date, -v_S, ''APPROVED'',
      ''Khách trả thêm phần công nợ vượt tiền cọc khi thanh lý (tiền thật vào sổ nhận).'' || COALESCE(E''\n'' || p_notes, ''''),
      ''termination.extra_receipt'')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, ''Khách trả thêm khi thanh lý'', 1, -v_S, p_move_out_date, p_move_out_date);
  END IF;

  -- 5. Recompute hoá đơn quyết toán.
  IF v_settle_inv IS NOT NULL THEN PERFORM public.recompute_invoice_for_id(v_settle_inv); END IF;

  -- 6. Thanh lý hợp đồng (ghi chú kèm bản quyết toán đầy đủ).
  UPDATE contracts
     SET status = ''TERMINATED'', actual_end_date = p_move_out_date,
         notes = CASE WHEN notes IS NULL OR length(btrim(notes)) = 0
                        THEN ''[Thanh lý '' || to_char(p_move_out_date,''DD/MM/YYYY'') || '']'' || COALESCE(E''\n'' || p_notes, '''') || E''\n'' || v_breakdown
                        ELSE notes || E''\n[Thanh lý '' || to_char(p_move_out_date,''DD/MM/YYYY'') || '']'' || COALESCE(E''\n'' || p_notes, '''') || E''\n'' || v_breakdown END,
         updated_at = NOW()
   WHERE id = p_contract_id;

  -- 7. Audit.
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date, termination_type,
      outstanding_debt, early_termination_fee, prorated_rent, prorated_days, prorated_services,
      total_deposit, rent_refund_amount, refund_method, status, approved_by, approved_at, notes)
    VALUES (
      v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date, ''NORMAL'',
      v_debt, v_penalty + v_extra, 0, 0, 0,
      v_deposit, v_owed,
      CASE WHEN v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN ''TM''::payment_method ELSE NULL END,
      ''COMPLETED'', auth.uid(), NOW(),
      COALESCE(p_notes || E''\n'', '''') || v_breakdown);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING ''terminate_contract_move_out_impl: audit insert failed for %: %'', p_contract_id, SQLERRM;
  END;

  RETURN jsonb_build_object(
    ''contract_id'', p_contract_id, ''settlement_invoice_id'', v_settle_inv,
    ''charges'', v_charges, ''extra_charges_total'', v_extra,
    ''applied'', v_applied, ''applied_deposit'', v_applied_dep,
    ''refund_deposit'', v_refund_dep, ''refund_excess'', v_refund_exc,
    ''customer_refund_total'', v_owed, ''customer_refund_applied'', v_owed_applied,
    ''refund_customer'', v_refund_owed,
    ''refund_voucher_id'', v_refund_voucher,
    ''net_settlement'', v_S, ''shortfall_mode'', p_shortfall_mode,
    ''receipt_account_id'', CASE WHEN v_S < 0 AND p_shortfall_mode = ''PAID'' THEN v_acc_rcpt END,
    ''acc_op'', v_acc_op, ''acc_internal'', v_acc_int
  );
END $function$
');
  IF md5(definition) <> '7ff469cae791132bd43022177add0713' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public._ensure_initial_deposit_voucher(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public._ensure_initial_deposit_voucher(uuid)'::regprocedure);
  IF md5(definition) = '8be94160f6af5b5052663c866ae93627' THEN RETURN; END IF;
  IF md5(definition) <> 'e48a71ade7802880e3d5d5a04252befb' THEN RAISE EXCEPTION 'Live function changed: %','public._ensure_initial_deposit_voucher(uuid)'; END IF;
  definition := replace(definition,'CREATE OR REPLACE FUNCTION public._ensure_initial_deposit_voucher(p_contract_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE
  v_c RECORD; v_building uuid; v_account uuid; v_type uuid;
  v_amount numeric(15,2); v_date date; v_existing_acc uuid;
BEGIN
  SELECT * INTO v_c FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Đã có phiếu thu cọc? → dùng đúng sổ đang chứa cọc.
  SELECT ie.account_id INTO v_existing_acc
    FROM income_expenses ie
   WHERE ie.contract_id = p_contract_id AND ie.type = ''INCOME''
     AND ie.approval_status = ''APPROVED'' AND ie.deleted_at IS NULL
     AND public.ie_has_deposit_item(ie.id)
   ORDER BY ie.voucher_date LIMIT 1;
  IF v_existing_acc IS NOT NULL THEN RETURN v_existing_acc; END IF;

  v_amount := COALESCE(v_c.deposit_paid, 0);
  v_account := public._deposit_account(v_c.user_id);   -- sổ CỌC
  IF v_amount <= 0 OR v_c.room_id IS NULL THEN RETURN v_account; END IF;

  SELECT building_id INTO v_building FROM rooms WHERE id = v_c.room_id;
  IF v_building IS NULL THEN RETURN v_account; END IF;

  v_date := COALESCE(v_c.signed_date, v_c.start_date, public.org_today_v1(NULL));
  v_type := public._termination_ensure_type(v_c.user_id, ''income'', ''Tiền cọc'');
  UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type AND is_deposit IS DISTINCT FROM TRUE;

  INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)
  VALUES (v_c.user_id, ''INCOME'', ''Cọc giữ phòng (ghi nhận ban đầu) — HĐ '' || COALESCE(v_c.contract_number, p_contract_id::text),
          v_building, v_c.room_id, p_contract_id, v_account, v_date, v_amount, ''APPROVED'',
          ''[BACKFILL_INITIAL_DEPOSIT] Ghi nhận cọc ban đầu (giả định đã thu đủ) vào sổ CỌC.'');
  -- item
  INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  SELECT ie.id, v_type, ''Tiền cọc giữ phòng (ghi nhận ban đầu)'', 1, v_amount, v_date, v_date
    FROM income_expenses ie WHERE ie.contract_id = p_contract_id AND ie.account_id = v_account
      AND ie.notes LIKE ''[BACKFILL_INITIAL_DEPOSIT]%'' AND ie.deleted_at IS NULL
    ORDER BY ie.created_at DESC LIMIT 1;

  RETURN v_account;
END $function$
','CREATE OR REPLACE FUNCTION public._ensure_initial_deposit_voucher(p_contract_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE
  v_c RECORD; v_building uuid; v_account uuid; v_type uuid;
  v_amount numeric(15,2); v_date date; v_existing_acc uuid;
BEGIN
  SELECT * INTO v_c FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Đã có phiếu thu cọc? → dùng đúng sổ đang chứa cọc.
  SELECT ie.account_id INTO v_existing_acc
    FROM income_expenses ie
   WHERE ie.contract_id = p_contract_id AND ie.type = ''INCOME''
     AND ie.approval_status = ''APPROVED'' AND ie.deleted_at IS NULL
     AND public.ie_has_deposit_item(ie.id)
   ORDER BY ie.voucher_date LIMIT 1;
  IF v_existing_acc IS NOT NULL THEN RETURN v_existing_acc; END IF;

  v_amount := COALESCE(v_c.deposit_paid, 0);
  v_account := app_private.deposit_account_in_org_v1(v_c.user_id,v_c.organization_id);   -- sổ CỌC
  IF v_amount <= 0 OR v_c.room_id IS NULL THEN RETURN v_account; END IF;

  SELECT building_id INTO v_building FROM rooms WHERE id = v_c.room_id;
  IF v_building IS NULL THEN RETURN v_account; END IF;

  v_date := COALESCE(v_c.signed_date, v_c.start_date, public.org_today_v1(NULL));
  v_type := app_private.ensure_termination_type_in_org_v1(v_c.user_id, ''income'', ''Tiền cọc'',v_c.organization_id);
  UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type AND is_deposit IS DISTINCT FROM TRUE;

  INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)
  VALUES (v_c.user_id, ''INCOME'', ''Cọc giữ phòng (ghi nhận ban đầu) — HĐ '' || COALESCE(v_c.contract_number, p_contract_id::text),
          v_building, v_c.room_id, p_contract_id, v_account, v_date, v_amount, ''APPROVED'',
          ''[BACKFILL_INITIAL_DEPOSIT] Ghi nhận cọc ban đầu (giả định đã thu đủ) vào sổ CỌC.'');
  -- item
  INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  SELECT ie.id, v_type, ''Tiền cọc giữ phòng (ghi nhận ban đầu)'', 1, v_amount, v_date, v_date
    FROM income_expenses ie WHERE ie.contract_id = p_contract_id AND ie.account_id = v_account
      AND ie.notes LIKE ''[BACKFILL_INITIAL_DEPOSIT]%'' AND ie.deleted_at IS NULL
    ORDER BY ie.created_at DESC LIMIT 1;

  RETURN v_account;
END $function$
');
  IF md5(definition) <> '8be94160f6af5b5052663c866ae93627' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.create_opening_adjustment(uuid,numeric,date)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.create_opening_adjustment(uuid,numeric,date)'::regprocedure);
  IF md5(definition) = '18f5e82d1c6966eb640a79ceddbf8ac8' THEN RETURN; END IF;
  IF md5(definition) <> 'abdb8252db7b049b7e47e2823b2edb73' THEN RAISE EXCEPTION 'Live function changed: %','public.create_opening_adjustment(uuid,numeric,date)'; END IF;
  definition := replace(definition,'CREATE OR REPLACE FUNCTION public.create_opening_adjustment(p_account_id uuid, p_counted_balance numeric, p_as_of date DEFAULT org_today_v1(NULL::uuid))
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE
  v_acc        accounts%ROWTYPE;
  v_system     numeric;
  v_diff       numeric;
  v_type_id    uuid;
  v_voucher_id uuid;
  v_kind       text;
BEGIN
  SELECT * INTO v_acc FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION ''Không tìm thấy sổ quỹ'';
  END IF;
  IF v_acc.user_id <> auth.uid() AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION ''Bạn không có quyền chốt sổ này'';
  END IF;
  IF COALESCE(v_acc.is_virtual, FALSE) THEN
    RAISE EXCEPTION ''Sổ theo dõi (ảo) không kiểm kê tiền thật — không cần điều chỉnh'';
  END IF;
  IF p_as_of > public.org_today_v1(NULL) THEN
    RAISE EXCEPTION ''Ngày chốt không được ở tương lai'';
  END IF;
  IF v_acc.lock_date IS NOT NULL AND v_acc.lock_date > p_as_of THEN
    RAISE EXCEPTION ''Sổ đã khoá tới % — không thể chốt lùi về %'',
      v_acc.lock_date, p_as_of;
  END IF;

  SELECT current_amount INTO v_system
  FROM accounts_with_balance WHERE id = p_account_id;
  v_diff := COALESCE(p_counted_balance, 0) - COALESCE(v_system, 0);

  IF abs(v_diff) >= 1 THEN
    -- Trigger khoá sổ chặn phiếu có ngày ≤ lock_date — phiếu điều chỉnh ngày D
    -- chính là ngày khoá, nên TẠM GỠ lock trong transaction (row đã FOR UPDATE)
    -- rồi khoá lại ở cuối. Chốt lại lần 2 cùng ngày cũng đi đường này.
    IF v_acc.lock_date IS NOT NULL THEN
      UPDATE accounts SET lock_date = NULL WHERE id = p_account_id;
    END IF;
    v_kind := CASE WHEN v_diff > 0 THEN ''income'' ELSE ''expense'' END;
    -- Hạng mục "Điều chỉnh số dư" (get-or-create) — ẩn khỏi báo cáo P&L.
    v_type_id := public._termination_ensure_type(
      v_acc.user_id, v_kind, ''Điều chỉnh số dư'');
    UPDATE income_expense_types
       SET hide_in_report = TRUE
     WHERE id = v_type_id AND hide_in_report IS DISTINCT FROM TRUE;

    INSERT INTO income_expenses (
      user_id, type, name, building_id, account_id, voucher_date,
      total_amount, approval_status, business_result_accounting,
      system_source, notes
    ) VALUES (
      v_acc.user_id,
      CASE WHEN v_diff > 0 THEN ''INCOME'' ELSE ''EXPENSE'' END,
      ''Điều chỉnh số dư đầu kỳ — '' || v_acc.name || '' (kiểm kê '' ||
        to_char(p_as_of, ''DD/MM/YYYY'') || '')'',
      public._chung_building(v_acc.user_id),
      p_account_id,
      p_as_of,
      abs(v_diff),
      ''APPROVED'',
      FALSE,  -- ép ngoài-KQKD: kqkd_amount = 0, không lọt Phân bổ LN
      ''adjustment.opening_balance'',
      ''[ĐIỀU CHỈNH SỐ DƯ ĐẦU KỲ] Đếm thực tế '' || p_counted_balance ||
        '' − hệ thống '' || COALESCE(v_system, 0) || '' = '' || v_diff ||
        ''. Kiểm kê ngày '' || to_char(p_as_of, ''DD/MM/YYYY'') ||
        '' theo quy trình chuẩn hoá két (không tính vào lợi nhuận).''
    ) RETURNING id INTO v_voucher_id;

    INSERT INTO income_expense_items (
      income_expense_id, income_expense_type_id, description,
      quantity, unit_price
    ) VALUES (
      v_voucher_id, v_type_id,
      ''Chênh lệch kiểm kê '' || to_char(p_as_of, ''DD/MM/YYYY''),
      1, abs(v_diff)
    );
  END IF;

  UPDATE accounts SET lock_date = p_as_of WHERE id = p_account_id;

  RETURN jsonb_build_object(
    ''account_id'', p_account_id,
    ''system_balance'', COALESCE(v_system, 0),
    ''counted_balance'', COALESCE(p_counted_balance, 0),
    ''diff'', v_diff,
    ''voucher_id'', v_voucher_id,
    ''locked_to'', p_as_of
  );
END;
$function$
','CREATE OR REPLACE FUNCTION public.create_opening_adjustment(p_account_id uuid, p_counted_balance numeric, p_as_of date DEFAULT org_today_v1(NULL::uuid))
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE
  v_acc        accounts%ROWTYPE;
  v_system     numeric;
  v_diff       numeric;
  v_type_id    uuid;
  v_voucher_id uuid;
  v_kind       text;
BEGIN
  SELECT * INTO v_acc FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION ''Không tìm thấy sổ quỹ'';
  END IF;
  IF v_acc.user_id <> auth.uid() AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION ''Bạn không có quyền chốt sổ này'';
  END IF;
  IF COALESCE(v_acc.is_virtual, FALSE) THEN
    RAISE EXCEPTION ''Sổ theo dõi (ảo) không kiểm kê tiền thật — không cần điều chỉnh'';
  END IF;
  IF p_as_of > public.org_today_v1(NULL) THEN
    RAISE EXCEPTION ''Ngày chốt không được ở tương lai'';
  END IF;
  IF v_acc.lock_date IS NOT NULL AND v_acc.lock_date > p_as_of THEN
    RAISE EXCEPTION ''Sổ đã khoá tới % — không thể chốt lùi về %'',
      v_acc.lock_date, p_as_of;
  END IF;

  SELECT current_amount INTO v_system
  FROM accounts_with_balance WHERE id = p_account_id;
  v_diff := COALESCE(p_counted_balance, 0) - COALESCE(v_system, 0);

  IF abs(v_diff) >= 1 THEN
    -- Trigger khoá sổ chặn phiếu có ngày ≤ lock_date — phiếu điều chỉnh ngày D
    -- chính là ngày khoá, nên TẠM GỠ lock trong transaction (row đã FOR UPDATE)
    -- rồi khoá lại ở cuối. Chốt lại lần 2 cùng ngày cũng đi đường này.
    IF v_acc.lock_date IS NOT NULL THEN
      UPDATE accounts SET lock_date = NULL WHERE id = p_account_id;
    END IF;
    v_kind := CASE WHEN v_diff > 0 THEN ''income'' ELSE ''expense'' END;
    -- Hạng mục "Điều chỉnh số dư" (get-or-create) — ẩn khỏi báo cáo P&L.
    v_type_id := app_private.ensure_termination_type_in_org_v1(
      v_acc.user_id, v_kind, ''Điều chỉnh số dư'',v_acc.organization_id);
    UPDATE income_expense_types
       SET hide_in_report = TRUE
     WHERE id = v_type_id AND hide_in_report IS DISTINCT FROM TRUE;

    INSERT INTO income_expenses (
      user_id, type, name, building_id, account_id, voucher_date,
      total_amount, approval_status, business_result_accounting,
      system_source, notes
    ) VALUES (
      v_acc.user_id,
      CASE WHEN v_diff > 0 THEN ''INCOME'' ELSE ''EXPENSE'' END,
      ''Điều chỉnh số dư đầu kỳ — '' || v_acc.name || '' (kiểm kê '' ||
        to_char(p_as_of, ''DD/MM/YYYY'') || '')'',
      app_private.chung_building_in_org_v1(v_acc.user_id,v_acc.organization_id),
      p_account_id,
      p_as_of,
      abs(v_diff),
      ''APPROVED'',
      FALSE,  -- ép ngoài-KQKD: kqkd_amount = 0, không lọt Phân bổ LN
      ''adjustment.opening_balance'',
      ''[ĐIỀU CHỈNH SỐ DƯ ĐẦU KỲ] Đếm thực tế '' || p_counted_balance ||
        '' − hệ thống '' || COALESCE(v_system, 0) || '' = '' || v_diff ||
        ''. Kiểm kê ngày '' || to_char(p_as_of, ''DD/MM/YYYY'') ||
        '' theo quy trình chuẩn hoá két (không tính vào lợi nhuận).''
    ) RETURNING id INTO v_voucher_id;

    INSERT INTO income_expense_items (
      income_expense_id, income_expense_type_id, description,
      quantity, unit_price
    ) VALUES (
      v_voucher_id, v_type_id,
      ''Chênh lệch kiểm kê '' || to_char(p_as_of, ''DD/MM/YYYY''),
      1, abs(v_diff)
    );
  END IF;

  UPDATE accounts SET lock_date = p_as_of WHERE id = p_account_id;

  RETURN jsonb_build_object(
    ''account_id'', p_account_id,
    ''system_balance'', COALESCE(v_system, 0),
    ''counted_balance'', COALESCE(p_counted_balance, 0),
    ''diff'', v_diff,
    ''voucher_id'', v_voucher_id,
    ''locked_to'', p_as_of
  );
END;
$function$
');
  IF md5(definition) <> '18f5e82d1c6966eb640a79ceddbf8ac8' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.confirm_cash_handover(uuid,uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.confirm_cash_handover(uuid,uuid)'::regprocedure);
  IF md5(definition) = 'bb53cfda938e5ec6ddd092ec937fd30c' THEN RETURN; END IF;
  IF md5(definition) <> '72174160f40571e8ab0056234260c06c' THEN RAISE EXCEPTION 'Live function changed: %','public.confirm_cash_handover(uuid,uuid)'; END IF;
  definition := replace(definition,'CREATE OR REPLACE FUNCTION public.confirm_cash_handover(p_handover_id uuid, p_to_account_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE
  v_h         cash_handovers%ROWTYPE;
  v_to        uuid;
  v_net       numeric;
  v_cnt       int;
  v_type_exp  uuid;
  v_type_inc  uuid;
  v_bld_giver uuid;
  v_bld_recv  uuid;
  v_caller    text;
  v_recv      text;
  v_giver     text;
  v_exp       uuid;
  v_inc       uuid;
  v_lines_in  text;
  v_lines_ex  text;
  v_lines     text;
  v_item_desc text;
  v_handover_date date;   -- Đợt 6: ngày MỞ đầu tiên chung cho cả hai chân
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION ''Bạn chưa đăng nhập'' USING ERRCODE = ''42501'';
  END IF;

  SELECT * INTO v_h FROM cash_handovers WHERE id = p_handover_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION ''Không tìm thấy phiên bàn giao''; END IF;
  IF v_h.receiver_id <> auth.uid() THEN
    RAISE EXCEPTION ''Chỉ người nhận mới được xác nhận đã nhận tiền'';
  END IF;
  IF v_h.status <> ''PENDING'' THEN
    RAISE EXCEPTION ''Phiên % không ở trạng thái chờ nhận'', v_h.code;
  END IF;
  IF v_h.cancel_requested_by IS NOT NULL THEN
    RAISE EXCEPTION ''Phiên % đang có yêu cầu hủy — xử lý yêu cầu hủy trước'', v_h.code;
  END IF;

  -- Sổ đích: truyền vào (phải của receiver) hoặc fallback sổ "…Thu" của receiver
  IF p_to_account_id IS NOT NULL THEN
    SELECT id INTO v_to FROM accounts
     WHERE id = p_to_account_id AND user_id = auth.uid() AND deleted_at IS NULL;
    IF v_to IS NULL THEN
      RAISE EXCEPTION ''Sổ nhận không hợp lệ (phải là sổ quỹ do bạn sở hữu)'';
    END IF;
  ELSE
    SELECT id INTO v_to FROM accounts
     WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE ''%Thu''
     ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
    IF v_to IS NULL THEN
      RAISE EXCEPTION ''Bạn chưa có sổ quỹ nhận — hãy chọn sổ khi xác nhận'';
    END IF;
  END IF;

  -- Re-validate: danh sách phiếu còn nguyên, NET (Σthu − Σchi) khớp snapshot
  SELECT COALESCE(sum(CASE WHEN ie.type = ''INCOME'' THEN ie.total_amount
                           ELSE -ie.total_amount END), 0),
         count(*)
    INTO v_net, v_cnt
    FROM cash_handover_items it
    JOIN income_expenses ie ON ie.id = it.voucher_id
   WHERE it.handover_id = p_handover_id
     AND ie.approval_status = ''APPROVED'' AND ie.deleted_at IS NULL
     AND ie.handover_id = p_handover_id
     AND ie.account_id = v_h.from_account_id;
  IF v_cnt <> v_h.voucher_count OR v_net <> v_h.total_amount THEN
    RAISE EXCEPTION ''Danh sách phiếu của phiên % đã thay đổi — hãy hủy phiên và tạo lại'', v_h.code;
  END IF;

  -- Loại thu/chi "bàn giao" (ngoài KQKD) + tòa ảo Chung
  v_type_exp := public._termination_ensure_type(v_h.giver_id, ''expense'', ''Bàn giao tiền mặt'');
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type_exp AND is_deposit IS DISTINCT FROM FALSE;
  v_type_inc := public._termination_ensure_type(v_h.receiver_id, ''income'', ''Nhận bàn giao tiền mặt'');
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
  v_bld_giver := public._chung_building(v_h.giver_id);
  v_bld_recv  := public._chung_building(v_h.receiver_id);

  SELECT COALESCE(full_name, '''') INTO v_caller FROM profiles WHERE id = auth.uid();
  v_recv  := COALESCE(v_h.receiver_name, '''');
  v_giver := COALESCE(v_h.giver_name, '''');

  -- ── Nhóm THU: phòng · tòa · tiền · kỳ · HĐ ──
  SELECT string_agg(
           ''• '' || COALESCE(NULLIF(btrim(it.room_name), ''''), ''?'')
                || '' · '' || COALESCE(NULLIF(btrim(it.building_name), ''''), ''?'')
                || '' · '' || replace(to_char(it.amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ''
                || COALESCE('' · kỳ '' || to_char(to_date(inv.billing_month, ''YYYY-MM''), ''MM/YYYY''), '''')
                || COALESCE('' · HĐ '' || NULLIF(btrim(inv.invoice_number), ''''), ''''),
           E''\n'' ORDER BY it.building_name, it.room_name)
    INTO v_lines_in
    FROM cash_handover_items it
    LEFT JOIN income_expenses ie ON ie.id = it.voucher_id
    LEFT JOIN invoices inv ON inv.id = ie.invoice_id
   WHERE it.handover_id = p_handover_id AND it.voucher_type = ''INCOME'';

  -- ── Nhóm CHI: tên khoản · tiền ──
  SELECT string_agg(
           ''• '' || COALESCE(NULLIF(btrim(ie.name), ''''), ''Khoản chi'')
                || '' · '' || replace(to_char(it.amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ'',
           E''\n'' ORDER BY it.amount DESC)
    INTO v_lines_ex
    FROM cash_handover_items it
    LEFT JOIN income_expenses ie ON ie.id = it.voucher_id
   WHERE it.handover_id = p_handover_id AND it.voucher_type = ''EXPENSE'';

  v_lines := ''Đã thu ('' || replace(to_char(v_h.gross_amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ):''
             || E''\n'' || COALESCE(v_lines_in, ''—'')
             || CASE WHEN v_h.expense_amount > 0
                  THEN E''\n'' || ''Đã chi ('' || replace(to_char(v_h.expense_amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ):''
                       || E''\n'' || COALESCE(v_lines_ex, ''—'')
                  ELSE '''' END;

  v_item_desc := ''Bàn giao số dư: thu ''
                 || replace(to_char(v_h.gross_amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ''
                 || CASE WHEN v_h.expense_amount > 0
                      THEN '' − chi '' || replace(to_char(v_h.expense_amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ''
                      ELSE '''' END;

  -- Đợt 6: kỳ đã chốt thì cặp phiếu bàn giao rơi vào ngày MỞ đầu tiên.
  -- MỘT ngày chung cho cả hai chân, nếu không sẽ có cửa sổ "tiền trên đường".
  v_handover_date := GREATEST(
    public.org_today_v1(NULL),
    app_private.cashbook_closed_through_v1(v_h.from_account_id) + 1,
    app_private.cashbook_closed_through_v1(v_to) + 1);
  IF v_handover_date > public.org_today_v1(NULL) + 31 THEN
    RAISE EXCEPTION ''[CASHBOOK_CLOSED] Sổ quỹ đã chốt tới % — phiên bàn giao này phải xử lý tay, hệ thống không lập phiếu ở ngày quá xa.'',
      v_handover_date - 1 USING ERRCODE = ''P0001'';
  END IF;

  -- ── 1 phiếu CHI tổng (sổ người giao) = NET ──
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name,
     system_source)
  VALUES
    (v_h.giver_id, ''EXPENSE'',
     ''Bàn giao tiền mặt → '' || v_recv || '' — '' || v_h.code,
     v_bld_giver, v_h.from_account_id, v_handover_date,
     v_h.total_amount, ''APPROVED'', FALSE,
     ''[BÀN GIAO] Nộp tiền sang sổ '' || v_recv || '' (phiên '' || v_h.code || ''):'' || E''\n'' || v_lines,
     v_caller,
     ''handover.transfer'')
  RETURNING id INTO v_exp;

  -- ── 1 phiếu THU tổng (sổ người nhận) = NET ──
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name,
     system_source)
  VALUES
    (v_h.receiver_id, ''INCOME'',
     ''Nhận bàn giao tiền mặt ← '' || v_giver || '' — '' || v_h.code,
     v_bld_recv, v_to, v_handover_date,
     v_h.total_amount, ''APPROVED'', FALSE,
     ''[BÀN GIAO] Nhận tiền từ '' || v_giver || '' (phiên '' || v_h.code || ''):'' || E''\n'' || v_lines,
     v_caller,
     ''handover.transfer'')
  RETURNING id INTO v_inc;

  -- ── 1 hạng mục GỘP = net trên mỗi phiếu (auto_recalc giữ total = net) ──
  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES (v_exp, v_type_exp, v_item_desc, 1, v_h.total_amount, NULL, NULL);
  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES (v_inc, v_type_inc, v_item_desc, 1, v_h.total_amount, NULL, NULL);

  -- Khoá cặp phiếu chuyển bằng handover_transfer_id (SAU khi nạp hạng mục)
  UPDATE income_expenses
     SET handover_transfer_id = p_handover_id
   WHERE id IN (v_exp, v_inc);

  UPDATE cash_handovers
     SET status = ''CONFIRMED'', to_account_id = v_to, confirmed_at = now()
   WHERE id = p_handover_id;

  RETURN jsonb_build_object(''id'', p_handover_id, ''code'', v_h.code,
                            ''total_amount'', v_h.total_amount, ''to_account_id'', v_to,
                            ''voucher_count'', v_h.voucher_count);
END;
$function$
','CREATE OR REPLACE FUNCTION public.confirm_cash_handover(p_handover_id uuid, p_to_account_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE
  v_h         cash_handovers%ROWTYPE;
  v_to        uuid;
  v_net       numeric;
  v_cnt       int;
  v_type_exp  uuid;
  v_type_inc  uuid;
  v_bld_giver uuid;
  v_bld_recv  uuid;
  v_caller    text;
  v_recv      text;
  v_giver     text;
  v_exp       uuid;
  v_inc       uuid;
  v_lines_in  text;
  v_lines_ex  text;
  v_lines     text;
  v_item_desc text;
  v_handover_date date;   -- Đợt 6: ngày MỞ đầu tiên chung cho cả hai chân
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION ''Bạn chưa đăng nhập'' USING ERRCODE = ''42501'';
  END IF;

  SELECT * INTO v_h FROM cash_handovers WHERE id = p_handover_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION ''Không tìm thấy phiên bàn giao''; END IF;
  IF v_h.receiver_id <> auth.uid() THEN
    RAISE EXCEPTION ''Chỉ người nhận mới được xác nhận đã nhận tiền'';
  END IF;
  IF v_h.status <> ''PENDING'' THEN
    RAISE EXCEPTION ''Phiên % không ở trạng thái chờ nhận'', v_h.code;
  END IF;
  IF v_h.cancel_requested_by IS NOT NULL THEN
    RAISE EXCEPTION ''Phiên % đang có yêu cầu hủy — xử lý yêu cầu hủy trước'', v_h.code;
  END IF;

  -- Sổ đích: truyền vào (phải của receiver) hoặc fallback sổ "…Thu" của receiver
  IF p_to_account_id IS NOT NULL THEN
    SELECT id INTO v_to FROM accounts
     WHERE id = p_to_account_id AND organization_id = v_h.organization_id AND user_id = auth.uid() AND deleted_at IS NULL;
    IF v_to IS NULL THEN
      RAISE EXCEPTION ''Sổ nhận không hợp lệ (phải là sổ quỹ do bạn sở hữu)'';
    END IF;
  ELSE
    SELECT id INTO v_to FROM accounts
     WHERE organization_id = v_h.organization_id AND user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE ''%Thu''
     ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
    IF v_to IS NULL THEN
      RAISE EXCEPTION ''Bạn chưa có sổ quỹ nhận — hãy chọn sổ khi xác nhận'';
    END IF;
  END IF;

  -- Re-validate: danh sách phiếu còn nguyên, NET (Σthu − Σchi) khớp snapshot
  SELECT COALESCE(sum(CASE WHEN ie.type = ''INCOME'' THEN ie.total_amount
                           ELSE -ie.total_amount END), 0),
         count(*)
    INTO v_net, v_cnt
    FROM cash_handover_items it
    JOIN income_expenses ie ON ie.id = it.voucher_id
   WHERE it.handover_id = p_handover_id
     AND ie.approval_status = ''APPROVED'' AND ie.deleted_at IS NULL
     AND ie.handover_id = p_handover_id
     AND ie.account_id = v_h.from_account_id AND ie.organization_id = v_h.organization_id;
  IF v_cnt <> v_h.voucher_count OR v_net <> v_h.total_amount THEN
    RAISE EXCEPTION ''Danh sách phiếu của phiên % đã thay đổi — hãy hủy phiên và tạo lại'', v_h.code;
  END IF;

  -- Loại thu/chi "bàn giao" (ngoài KQKD) + tòa ảo Chung
  v_type_exp := app_private.ensure_termination_type_in_org_v1(v_h.giver_id, ''expense'', ''Bàn giao tiền mặt'',v_h.organization_id);
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type_exp AND is_deposit IS DISTINCT FROM FALSE;
  v_type_inc := app_private.ensure_termination_type_in_org_v1(v_h.receiver_id, ''income'', ''Nhận bàn giao tiền mặt'',v_h.organization_id);
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
  v_bld_giver := app_private.chung_building_in_org_v1(v_h.giver_id,v_h.organization_id);
  v_bld_recv  := app_private.chung_building_in_org_v1(v_h.receiver_id,v_h.organization_id);

  SELECT COALESCE(full_name, '''') INTO v_caller FROM profiles WHERE id = auth.uid();
  v_recv  := COALESCE(v_h.receiver_name, '''');
  v_giver := COALESCE(v_h.giver_name, '''');

  -- ── Nhóm THU: phòng · tòa · tiền · kỳ · HĐ ──
  SELECT string_agg(
           ''• '' || COALESCE(NULLIF(btrim(it.room_name), ''''), ''?'')
                || '' · '' || COALESCE(NULLIF(btrim(it.building_name), ''''), ''?'')
                || '' · '' || replace(to_char(it.amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ''
                || COALESCE('' · kỳ '' || to_char(to_date(inv.billing_month, ''YYYY-MM''), ''MM/YYYY''), '''')
                || COALESCE('' · HĐ '' || NULLIF(btrim(inv.invoice_number), ''''), ''''),
           E''\n'' ORDER BY it.building_name, it.room_name)
    INTO v_lines_in
    FROM cash_handover_items it
    LEFT JOIN income_expenses ie ON ie.id = it.voucher_id
    LEFT JOIN invoices inv ON inv.id = ie.invoice_id
   WHERE it.handover_id = p_handover_id AND it.voucher_type = ''INCOME'';

  -- ── Nhóm CHI: tên khoản · tiền ──
  SELECT string_agg(
           ''• '' || COALESCE(NULLIF(btrim(ie.name), ''''), ''Khoản chi'')
                || '' · '' || replace(to_char(it.amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ'',
           E''\n'' ORDER BY it.amount DESC)
    INTO v_lines_ex
    FROM cash_handover_items it
    LEFT JOIN income_expenses ie ON ie.id = it.voucher_id
   WHERE it.handover_id = p_handover_id AND it.voucher_type = ''EXPENSE'';

  v_lines := ''Đã thu ('' || replace(to_char(v_h.gross_amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ):''
             || E''\n'' || COALESCE(v_lines_in, ''—'')
             || CASE WHEN v_h.expense_amount > 0
                  THEN E''\n'' || ''Đã chi ('' || replace(to_char(v_h.expense_amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ):''
                       || E''\n'' || COALESCE(v_lines_ex, ''—'')
                  ELSE '''' END;

  v_item_desc := ''Bàn giao số dư: thu ''
                 || replace(to_char(v_h.gross_amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ''
                 || CASE WHEN v_h.expense_amount > 0
                      THEN '' − chi '' || replace(to_char(v_h.expense_amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ''
                      ELSE '''' END;

  -- Đợt 6: kỳ đã chốt thì cặp phiếu bàn giao rơi vào ngày MỞ đầu tiên.
  -- MỘT ngày chung cho cả hai chân, nếu không sẽ có cửa sổ "tiền trên đường".
  v_handover_date := GREATEST(
    public.org_today_v1(NULL),
    app_private.cashbook_closed_through_v1(v_h.from_account_id) + 1,
    app_private.cashbook_closed_through_v1(v_to) + 1);
  IF v_handover_date > public.org_today_v1(NULL) + 31 THEN
    RAISE EXCEPTION ''[CASHBOOK_CLOSED] Sổ quỹ đã chốt tới % — phiên bàn giao này phải xử lý tay, hệ thống không lập phiếu ở ngày quá xa.'',
      v_handover_date - 1 USING ERRCODE = ''P0001'';
  END IF;

  -- ── 1 phiếu CHI tổng (sổ người giao) = NET ──
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name,
     system_source)
  VALUES
    (v_h.giver_id, ''EXPENSE'',
     ''Bàn giao tiền mặt → '' || v_recv || '' — '' || v_h.code,
     v_bld_giver, v_h.from_account_id, v_handover_date,
     v_h.total_amount, ''APPROVED'', FALSE,
     ''[BÀN GIAO] Nộp tiền sang sổ '' || v_recv || '' (phiên '' || v_h.code || ''):'' || E''\n'' || v_lines,
     v_caller,
     ''handover.transfer'')
  RETURNING id INTO v_exp;

  -- ── 1 phiếu THU tổng (sổ người nhận) = NET ──
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name,
     system_source)
  VALUES
    (v_h.receiver_id, ''INCOME'',
     ''Nhận bàn giao tiền mặt ← '' || v_giver || '' — '' || v_h.code,
     v_bld_recv, v_to, v_handover_date,
     v_h.total_amount, ''APPROVED'', FALSE,
     ''[BÀN GIAO] Nhận tiền từ '' || v_giver || '' (phiên '' || v_h.code || ''):'' || E''\n'' || v_lines,
     v_caller,
     ''handover.transfer'')
  RETURNING id INTO v_inc;

  -- ── 1 hạng mục GỘP = net trên mỗi phiếu (auto_recalc giữ total = net) ──
  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES (v_exp, v_type_exp, v_item_desc, 1, v_h.total_amount, NULL, NULL);
  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES (v_inc, v_type_inc, v_item_desc, 1, v_h.total_amount, NULL, NULL);

  -- Khoá cặp phiếu chuyển bằng handover_transfer_id (SAU khi nạp hạng mục)
  UPDATE income_expenses
     SET handover_transfer_id = p_handover_id
   WHERE id IN (v_exp, v_inc);

  UPDATE cash_handovers
     SET status = ''CONFIRMED'', to_account_id = v_to, confirmed_at = now()
   WHERE id = p_handover_id;

  RETURN jsonb_build_object(''id'', p_handover_id, ''code'', v_h.code,
                            ''total_amount'', v_h.total_amount, ''to_account_id'', v_to,
                            ''voucher_count'', v_h.voucher_count);
END;
$function$
');
  IF md5(definition) <> 'bb53cfda938e5ec6ddd092ec937fd30c' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public._termination_pick_account(uuid,uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public._termination_pick_account(uuid,uuid)'::regprocedure);
  IF md5(definition) = 'cfd33486a65e51d966c4c43f6cd5dc05' THEN RETURN; END IF;
  IF md5(definition) <> 'fae19a59566c0f3fe027ee1020aa292a' THEN RAISE EXCEPTION 'Live function changed: %','public._termination_pick_account(uuid,uuid)'; END IF;
  definition := replace(definition,'CREATE OR REPLACE FUNCTION public._termination_pick_account(p_user_id uuid, p_building_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
  SELECT COALESCE(
    -- 1) Sổ tiền mặt cấu hình cho toà (nơi thu tiền thuê).
    (SELECT b.default_account_id_tt FROM buildings b
      WHERE b.id = p_building_id AND b.default_account_id_tt IS NOT NULL
        AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = b.default_account_id_tt AND a.deleted_at IS NULL AND a.is_virtual = false)),
    -- 2) Sổ ngân hàng cấu hình cho toà.
    (SELECT b.default_account_id_tk FROM buildings b
      WHERE b.id = p_building_id AND b.default_account_id_tk IS NOT NULL
        AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = b.default_account_id_tk AND a.deleted_at IS NULL AND a.is_virtual = false)),
    -- 3) Fallback: trùng tên toà → is_default → tạo sớm nhất; né sổ ảo bằng CỜ.
    (SELECT a.id
       FROM accounts a, (SELECT name FROM buildings WHERE id = p_building_id) bld
      WHERE a.user_id = p_user_id
        AND a.deleted_at IS NULL
        AND a.is_virtual = false
        AND a.name NOT IN (''Cấn trừ thanh lý (nội bộ)'', ''Làm tròn tiền thiếu'')
      ORDER BY (a.name = bld.name) DESC, a.is_default DESC NULLS LAST, a.created_at
      LIMIT 1)
  );
$function$
','CREATE OR REPLACE FUNCTION public._termination_pick_account(p_user_id uuid, p_building_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
  SELECT COALESCE(
    -- 1) Sổ tiền mặt cấu hình cho toà (nơi thu tiền thuê).
    (SELECT b.default_account_id_tt FROM buildings b
      WHERE b.id = p_building_id AND b.default_account_id_tt IS NOT NULL
        AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = b.default_account_id_tt AND a.organization_id = b.organization_id AND a.deleted_at IS NULL AND a.is_virtual = false)),
    -- 2) Sổ ngân hàng cấu hình cho toà.
    (SELECT b.default_account_id_tk FROM buildings b
      WHERE b.id = p_building_id AND b.default_account_id_tk IS NOT NULL
        AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = b.default_account_id_tk AND a.organization_id = b.organization_id AND a.deleted_at IS NULL AND a.is_virtual = false)),
    -- 3) Fallback: trùng tên toà → is_default → tạo sớm nhất; né sổ ảo bằng CỜ.
    (SELECT a.id
       FROM accounts a, (SELECT name,organization_id FROM buildings WHERE id = p_building_id) bld
      WHERE a.user_id = p_user_id AND a.organization_id = bld.organization_id
        AND a.deleted_at IS NULL
        AND a.is_virtual = false
        AND a.name NOT IN (''Cấn trừ thanh lý (nội bộ)'', ''Làm tròn tiền thiếu'')
      ORDER BY (a.name = bld.name) DESC, a.is_default DESC NULLS LAST, a.created_at
      LIMIT 1)
  );
$function$
');
  IF md5(definition) <> 'cfd33486a65e51d966c4c43f6cd5dc05' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.copilot_preview_salary_chi_luong_v1(uuid,jsonb)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.copilot_preview_salary_chi_luong_v1(uuid,jsonb)'::regprocedure);
  IF md5(definition) = '8fb7594d59590ccdc3cfdba2c038a38f' THEN RETURN; END IF;
  IF md5(definition) <> 'ef607bb38eb9ef1c11ba61b9ec1c30ca' THEN RAISE EXCEPTION 'Live function changed: %','public.copilot_preview_salary_chi_luong_v1(uuid,jsonb)'; END IF;
  definition := replace(definition,'app_private.copilot_salary_org_of_staff_v1(v_staff_id)','app_private.salary_subject_organization_v1(v_staff_id,v_period,v_account,p_organization_id)');
  IF md5(definition) <> '8fb7594d59590ccdc3cfdba2c038a38f' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.copilot_preview_salary_khoa_thang_v1(uuid,jsonb)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.copilot_preview_salary_khoa_thang_v1(uuid,jsonb)'::regprocedure);
  IF md5(definition) = 'edc7b8ae982cf4f8e5fa7f49acea9ff3' THEN RETURN; END IF;
  IF md5(definition) <> 'd7b8e4de47cf46d185b523ebae55d10b' THEN RAISE EXCEPTION 'Live function changed: %','public.copilot_preview_salary_khoa_thang_v1(uuid,jsonb)'; END IF;
  definition := replace(definition,'app_private.copilot_salary_org_of_staff_v1(v_first_staff)','app_private.salary_subject_organization_v1(v_first_staff,v_period,NULL,p_organization_id)');
  IF md5(definition) <> 'edc7b8ae982cf4f8e5fa7f49acea9ff3' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.copilot_execute_salary_chi_luong_v1(text,jsonb)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.copilot_execute_salary_chi_luong_v1(text,jsonb)'::regprocedure);
  IF md5(definition) = '431f62feb220a680f77f0c7f12afcf28' THEN RETURN; END IF;
  IF md5(definition) <> '39645b5c92d9210bfdf9f103b79d0359' THEN RAISE EXCEPTION 'Live function changed: %','public.copilot_execute_salary_chi_luong_v1(text,jsonb)'; END IF;
  definition := replace(definition,'app_private.copilot_salary_org_of_staff_v1(v_staff_id)','app_private.salary_subject_organization_v1(v_staff_id,v_period,v_account,v_org)');
  IF md5(definition) <> '431f62feb220a680f77f0c7f12afcf28' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.copilot_execute_salary_khoa_thang_v1(text,jsonb)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.copilot_execute_salary_khoa_thang_v1(text,jsonb)'::regprocedure);
  IF md5(definition) = '88f10f5fa9ab15a7069beae31ab2d8c7' THEN RETURN; END IF;
  IF md5(definition) <> 'a8cef4d654eaa033c78e0445b0cd5108' THEN RAISE EXCEPTION 'Live function changed: %','public.copilot_execute_salary_khoa_thang_v1(text,jsonb)'; END IF;
  definition := replace(definition,'app_private.copilot_salary_org_of_staff_v1(v_first_staff)','app_private.salary_subject_organization_v1(v_first_staff,v_period,NULL,v_org)');
  IF md5(definition) <> '88f10f5fa9ab15a7069beae31ab2d8c7' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.get_or_create_deposit_account()
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.get_or_create_deposit_account()'::regprocedure);
  IF md5(definition) = '42bbd21de6f5a14972372fc2a77a4185' THEN RETURN; END IF;
  IF md5(definition) <> 'ff2a1a571527be002a4be6fc9bca26fe' THEN RAISE EXCEPTION 'Live function changed: %','public.get_or_create_deposit_account()'; END IF;
  definition := replace(definition,'CREATE OR REPLACE FUNCTION public.get_or_create_deposit_account()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE
  v_acc uuid;
BEGIN
  -- 1. Sổ "%Thu" mặc định của chính người gọi.
  SELECT id INTO v_acc FROM accounts
  WHERE user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual
    AND name ILIKE ''%thu'' AND is_default
  ORDER BY created_at LIMIT 1;
  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;

  -- 2. Sổ "%Thu" bất kỳ của người gọi.
  SELECT id INTO v_acc FROM accounts
  WHERE user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual
    AND name ILIKE ''%thu''
  ORDER BY created_at LIMIT 1;
  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;

  -- 3. Sổ mặc định bất kỳ của người gọi.
  SELECT id INTO v_acc FROM accounts
  WHERE user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual
    AND is_default
  ORDER BY created_at LIMIT 1;
  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;

  -- 4. Sổ thật đầu tiên của người gọi.
  SELECT id INTO v_acc FROM accounts
  WHERE user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual
  ORDER BY created_at LIMIT 1;
  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;

  RAISE EXCEPTION ''Bạn chưa có sổ quỹ nào — tạo sổ "%% Thu" trong Tài chính → Sổ quỹ trước khi thu cọc'';
END;
$function$
','CREATE OR REPLACE FUNCTION public.get_or_create_deposit_account()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE
  v_acc uuid;
BEGIN
  -- 1. Sổ "%Thu" mặc định của chính người gọi.
  SELECT id INTO v_acc FROM accounts
  WHERE organization_id = app_private.working_organization_v1() AND user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual
    AND name ILIKE ''%thu'' AND is_default
  ORDER BY created_at LIMIT 1;
  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;

  -- 2. Sổ "%Thu" bất kỳ của người gọi.
  SELECT id INTO v_acc FROM accounts
  WHERE organization_id = app_private.working_organization_v1() AND user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual
    AND name ILIKE ''%thu''
  ORDER BY created_at LIMIT 1;
  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;

  -- 3. Sổ mặc định bất kỳ của người gọi.
  SELECT id INTO v_acc FROM accounts
  WHERE organization_id = app_private.working_organization_v1() AND user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual
    AND is_default
  ORDER BY created_at LIMIT 1;
  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;

  -- 4. Sổ thật đầu tiên của người gọi.
  SELECT id INTO v_acc FROM accounts
  WHERE organization_id = app_private.working_organization_v1() AND user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual
  ORDER BY created_at LIMIT 1;
  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;

  RAISE EXCEPTION ''Bạn chưa có sổ quỹ nào — tạo sổ "%% Thu" trong Tài chính → Sổ quỹ trước khi thu cọc'';
END;
$function$
');
  IF md5(definition) <> '42bbd21de6f5a14972372fc2a77a4185' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.set_salary_v5_config(jsonb)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.set_salary_v5_config(jsonb)'::regprocedure);
  IF md5(definition) = 'bf661c1ab94d2101451477f986b1ba1d' THEN RETURN; END IF;
  IF md5(definition) <> '1159731faff8327cea5cf7e011c3eabd' THEN RAISE EXCEPTION 'Live function changed: %','public.set_salary_v5_config(jsonb)'; END IF;
  definition := replace(definition,'  SELECT rules INTO v_rules FROM public.salary_bonus_rules WHERE user_id = v_owner FOR UPDATE;','  SELECT rules INTO v_rules FROM public.salary_bonus_rules
    WHERE user_id = v_owner AND organization_id = app_private.working_organization_v1() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION ''Cấu hình lương V5 này không thuộc công ty đang chọn'' USING ERRCODE=''42501''; END IF;');
  IF md5(definition) <> 'bf661c1ab94d2101451477f986b1ba1d' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- app_private.storage_object_link_maintain()
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('app_private.storage_object_link_maintain()'::regprocedure);
  IF md5(definition) = 'a830d2f0bd10ebc4659105f619f6b342' THEN RETURN; END IF;
  IF md5(definition) <> 'ea328e925a0f7c6f1f8094f171bf059c' THEN RAISE EXCEPTION 'Live function changed: %','app_private.storage_object_link_maintain()'; END IF;
  definition := replace(definition,'declare v_uploader uuid; v_org uuid; v_how text;
begin
  if new.bucket_id not in (''customer-id-cards'',''customer-images'',''income-expense-attachments'',
                           ''job-attachments'',''payment-receipts'',''meter-images'',''document-templates'') then
    return new;
  end if;
  v_uploader := coalesce(new.owner_id::uuid, new.owner, nullif(split_part(new.name,''/'',1),'''')::uuid);
  select org, how into v_org, v_how from app_private.derive_uploader_org_v1(v_uploader);
  insert into app_private.storage_object_links (bucket_id, object_name, organization_id, owner_user_id, derivation)
  values (new.bucket_id, new.name, v_org, v_uploader, coalesce(v_how,''quarantine''))
  on conflict (bucket_id, object_name) do update set organization_id=excluded.organization_id,
    owner_user_id=excluded.owner_user_id, derivation=excluded.derivation;
  return new;
end;','declare
  v_uploader uuid;
  v_org uuid;
  v_how text;
  v_requested text;
  v_intent_org uuid;
  v_intent_user uuid;
begin
  if new.bucket_id not in (''customer-id-cards'',''customer-images'',''income-expense-attachments'',
                           ''job-attachments'',''payment-receipts'',''meter-images'',''document-templates'') then
    return new;
  end if;
  v_uploader := coalesce(new.owner_id::uuid,new.owner);
  if v_uploader is null and split_part(new.name,''/'',1) ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'' then
    v_uploader := split_part(new.name,''/'',1)::uuid;
  end if;
  -- A server-issued finance intent owns the company, including v2/org paths.
  if exists (select 1 from public.finance_evidence_objects e where e.bucket_id=new.bucket_id and e.object_name=new.name and e.state=''QUARANTINED'')
     or (select count(*) from public.finance_evidence_objects e where e.bucket_id=new.bucket_id and e.object_name=new.name)>1 then
    raise exception ''Chứng từ của đường dẫn ảnh bị cách ly hoặc mâu thuẫn công ty'' using errcode=''42501'';
  end if;
  select e.organization_id,e.uploader_user_id into v_intent_org,v_intent_user
    from public.finance_evidence_objects e
    where e.bucket_id=new.bucket_id and e.object_name=new.name
      and e.state in (''UPLOAD_INTENT'',''FINALIZED'',''ATTACHED'');
  v_requested := nullif(new.user_metadata->>''ihomecrm_organization_id'','''');
  if v_intent_org is not null then
    if v_intent_user is distinct from v_uploader then
      raise exception ''Người tải không khớp chứng từ'' using errcode=''42501'';
    end if;
    v_org := v_intent_org;
    if v_requested is not null and v_requested::uuid is distinct from v_org then
      raise exception ''Công ty ảnh không khớp chứng từ'' using errcode=''42501'';
    end if;
    v_how := ''finance-intent'';
  elsif v_requested is not null then
    v_org := v_requested::uuid;
    v_how := ''explicit-upload'';
  else
    -- Old clients keep the existing unambiguous derivation/quarantine behavior.
    select org,how into v_org,v_how from app_private.derive_uploader_org_v1(v_uploader);
  end if;
  if v_org is not null and not app_private.active_working_membership_v1(v_uploader,v_org) then
    raise exception ''Người tải không còn quyền trong công ty của ảnh'' using errcode=''42501'';
  end if;
  insert into app_private.storage_object_links(bucket_id,object_name,organization_id,owner_user_id,derivation)
    values(new.bucket_id,new.name,v_org,v_uploader,coalesce(v_how,''quarantine''))
    on conflict (bucket_id,object_name) do update set
      organization_id=coalesce(storage_object_links.organization_id,excluded.organization_id),
      derivation=case when storage_object_links.organization_id is null then excluded.derivation else storage_object_links.derivation end
    where storage_object_links.owner_user_id is not distinct from excluded.owner_user_id
      and (storage_object_links.organization_id is null or storage_object_links.organization_id is not distinct from excluded.organization_id);
  if not found then raise exception ''Đường dẫn ảnh đã thuộc chủ hoặc công ty khác'' using errcode=''42501''; end if;
  return new;
end;');
  IF md5(definition) <> 'a830d2f0bd10ebc4659105f619f6b342' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- app_private.current_admin_org_v1()
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('app_private.current_admin_org_v1()'::regprocedure);
  IF md5(definition) = '12e2f5e83821352ecb43583d53aebd95' THEN RETURN; END IF;
  IF md5(definition) <> '46d46cca36fbe938b3692969c2cb4f3c' THEN RAISE EXCEPTION 'Live function changed: %','app_private.current_admin_org_v1()'; END IF;
  definition := replace(definition,'select m.organization_id into v_org
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id and o.status = ''ACTIVE''
   where m.user_id = (select auth.uid()) and m.status = ''ACTIVE''
   order by coalesce(o.is_demo, false), m.organization_id
   limit 1;','v_org := app_private.working_organization_v1();');
  IF md5(definition) <> '12e2f5e83821352ecb43583d53aebd95' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.invite_organization_member_v1(text,text,uuid,uuid[],integer)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.invite_organization_member_v1(text,text,uuid,uuid[],integer)'::regprocedure);
  IF md5(definition) = '76b41c4eddb73713860a3d82a8a111d3' THEN RETURN; END IF;
  IF md5(definition) <> '103bf9f65fa34ffa35c8d6fa7e2822e1' THEN RAISE EXCEPTION 'Live function changed: %','public.invite_organization_member_v1(text,text,uuid,uuid[],integer)'; END IF;
  definition := replace(definition,'select m.organization_id into v_org
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id and o.status = ''ACTIVE''
   where m.user_id = v_actor and m.status = ''ACTIVE''
   order by coalesce(o.is_demo,false), m.organization_id limit 1;','v_org := app_private.working_organization_v1();');
  IF md5(definition) <> '76b41c4eddb73713860a3d82a8a111d3' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.upsert_organization_role_v1(uuid,text,jsonb,bigint,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.upsert_organization_role_v1(uuid,text,jsonb,bigint,text)'::regprocedure);
  IF md5(definition) = '452786bad1f28b1cdadf8af1c2c6e832' THEN RETURN; END IF;
  IF md5(definition) <> 'dc817be77e05bdc2b6debdab75d78552' THEN RAISE EXCEPTION 'Live function changed: %','public.upsert_organization_role_v1(uuid,text,jsonb,bigint,text)'; END IF;
  definition := replace(definition,'select m.organization_id into v_org
      from public.organization_memberships m
      join public.organizations o on o.id = m.organization_id and o.status = ''ACTIVE''
     where m.user_id = v_actor and m.status = ''ACTIVE''
     order by coalesce(o.is_demo,false), m.organization_id limit 1;','v_org := app_private.working_organization_v1();');
  IF md5(definition) <> '452786bad1f28b1cdadf8af1c2c6e832' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.lucky_admin_org_v1()
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.lucky_admin_org_v1()'::regprocedure);
  IF md5(definition) = '2a682223e676dc641491b1cc27484468' THEN RETURN; END IF;
  IF md5(definition) <> '40f5baff53943c42a630345fe6324586' THEN RAISE EXCEPTION 'Live function changed: %','public.lucky_admin_org_v1()'; END IF;
  definition := replace(definition,'select m.organization_id into v_org
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id and o.status = ''ACTIVE''
   where m.user_id = (select auth.uid())
     and m.status = ''ACTIVE''
     and m.member_type in (''OWNER'', ''STAFF'')
   order by coalesce(o.is_demo, false), m.organization_id
   limit 1;','v_org := app_private.working_organization_v1(false);
  if not exists (select 1 from public.organization_memberships m
    where m.user_id=auth.uid() and m.organization_id=v_org and m.status=''ACTIVE''
      and m.member_type in (''OWNER'',''STAFF'')) then return null; end if;');
  IF md5(definition) <> '2a682223e676dc641491b1cc27484468' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.get_authorization_context_v1(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.get_authorization_context_v1(uuid)'::regprocedure);
  IF md5(definition) = '722b3c46d26c38a53df563b94486604c' THEN RETURN; END IF;
  IF md5(definition) <> '2651fa5739beed6c732925dc4324289a' THEN RAISE EXCEPTION 'Live function changed: %','public.get_authorization_context_v1(uuid)'; END IF;
  definition := replace(definition,'select m.organization_id into v_org
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id and o.status = ''ACTIVE''
   where m.user_id = v_actor
     and m.status = ''ACTIVE''
     and coalesce(m.valid_from, ''-infinity''::timestamptz) <= now()
     and (m.valid_to is null or m.valid_to > now())
     and (p_organization_id is null or m.organization_id = p_organization_id)
   order by coalesce(o.is_demo, false) asc,
            coalesce(m.activated_at, m.valid_from, ''infinity''::timestamptz) asc,
            m.organization_id asc
   limit 1;','v_org := coalesce(p_organization_id,app_private.working_organization_v1(false));
  if not app_private.active_working_membership_v1(v_actor,v_org) then v_org := null; end if;');
  IF md5(definition) <> '722b3c46d26c38a53df563b94486604c' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.get_ie_auto_approve_threshold_v1()
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.get_ie_auto_approve_threshold_v1()'::regprocedure);
  IF md5(definition) = '9ddd8df410367b83ff8374fd15d6cfed' THEN RETURN; END IF;
  IF md5(definition) <> '0b77ee5a205a65e07327e87d9fceb95c' THEN RAISE EXCEPTION 'Live function changed: %','public.get_ie_auto_approve_threshold_v1()'; END IF;
  definition := replace(definition,'select count(distinct m.organization_id), min(m.organization_id::text)::uuid
    into v_cnt, v_org
    from public.organization_memberships m
   where m.user_id = v_actor and m.status = ''ACTIVE'';
  if coalesce(v_cnt,0) = 0 then raise exception ''Không thuộc tổ chức nào'' using errcode=''42501''; end if;
  if v_cnt > 1 then
    select rb.organization_id into v_owner_org
      from public.role_bindings rb
      join public.organization_memberships m
        on m.id = rb.membership_id and m.organization_id = rb.organization_id
       and m.user_id = v_actor and m.status = ''ACTIVE''
      join public.organization_roles r
        on r.id = rb.role_id and r.name = ''Chủ sở hữu tổ chức''
     limit 1;
    if v_owner_org is not null then v_org := v_owner_org; end if;
  end if;','v_org := app_private.working_organization_v1();');
  IF md5(definition) <> '9ddd8df410367b83ff8374fd15d6cfed' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.set_ie_auto_approve_threshold_v1(numeric)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.set_ie_auto_approve_threshold_v1(numeric)'::regprocedure);
  IF md5(definition) = 'd1b160e64641f360749c7cca960737b6' THEN RETURN; END IF;
  IF md5(definition) <> 'c0d115f634a8c553aa8c4d86e6bc62fc' THEN RAISE EXCEPTION 'Live function changed: %','public.set_ie_auto_approve_threshold_v1(numeric)'; END IF;
  definition := replace(definition,'select count(distinct m.organization_id), min(m.organization_id::text)::uuid
    into v_cnt, v_org
    from public.organization_memberships m
   where m.user_id = v_actor and m.status = ''ACTIVE'';
  if coalesce(v_cnt,0) = 0 then raise exception ''Không thuộc tổ chức nào'' using errcode=''42501''; end if;
  if v_cnt > 1 then
    select rb.organization_id into v_owner_org
      from public.role_bindings rb
      join public.organization_memberships m
        on m.id = rb.membership_id and m.organization_id = rb.organization_id
       and m.user_id = v_actor and m.status = ''ACTIVE''
      join public.organization_roles r
        on r.id = rb.role_id and r.name = ''Chủ sở hữu tổ chức''
     limit 1;
    if v_owner_org is not null then v_org := v_owner_org; end if;
  end if;','v_org := app_private.working_organization_v1();');
  IF md5(definition) <> 'd1b160e64641f360749c7cca960737b6' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.create_cashbook_v1(text,numeric,date,text,text,uuid,text,text,boolean,uuid,uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.create_cashbook_v1(text,numeric,date,text,text,uuid,text,text,boolean,uuid,uuid)'::regprocedure);
  IF md5(definition) = '194d42191d8d431528853e6849e592d1' THEN RETURN; END IF;
  IF md5(definition) <> '6c5a68c165c9db8d0ac329cd2415b123' THEN RAISE EXCEPTION 'Live function changed: %','public.create_cashbook_v1(text,numeric,date,text,text,uuid,text,text,boolean,uuid,uuid)'; END IF;
  definition := replace(definition,'if p_organization_id is not null then
    v_org := p_organization_id;
  elsif v_org_count = 1 then
    select distinct m.organization_id into v_org
      from public.organization_memberships m
     where m.user_id=v_actor and m.status=''ACTIVE'';
  else
    -- Nhiều org: chỉ profiles.organization_id được phá thế hoà, và phải khớp
    -- một membership ACTIVE — profile org sai/mốc thì coi như không có.
    select p.organization_id into v_org
      from public.profiles p
     where p.id=v_actor
       and p.organization_id is not null
       and exists (select 1 from public.organization_memberships m
                    where m.user_id=v_actor and m.status=''ACTIVE''
                      and m.organization_id=p.organization_id);
    if v_org is null then
      raise exception ''Bạn thuộc % tổ chức đang hoạt động; phải chỉ rõ tổ chức tạo sổ quỹ (p_organization_id)'',
        v_org_count using errcode=''42501''; end if;
  end if;','v_org := coalesce(p_organization_id,app_private.working_organization_v1());');
  IF md5(definition) <> '194d42191d8d431528853e6849e592d1' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.create_finance_evidence_upload_intent_v2(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.create_finance_evidence_upload_intent_v2(uuid)'::regprocedure);
  IF md5(definition) = 'cea9fc61803215196a2a1719125c53e1' THEN RETURN; END IF;
  IF md5(definition) <> 'd0841543ebc13e0e35e4e663f6feed6c' THEN RAISE EXCEPTION 'Live function changed: %','public.create_finance_evidence_upload_intent_v2(uuid)'; END IF;
  definition := replace(definition,'SELECT m.organization_id INTO v_org FROM public.organization_memberships m
    WHERE m.user_id = auth.uid() AND m.status = ''ACTIVE'' LIMIT 1;','v_org := app_private.working_organization_v1();');
  IF md5(definition) <> 'cea9fc61803215196a2a1719125c53e1' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.ie_compat_insert_v2(jsonb,jsonb)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.ie_compat_insert_v2(jsonb,jsonb)'::regprocedure);
  IF md5(definition) = '79298fdc2aed8cbee2de06cfa1b774e4' THEN RETURN; END IF;
  IF md5(definition) <> 'c71d528be728ead127207b77250f1504' THEN RAISE EXCEPTION 'Live function changed: %','public.ie_compat_insert_v2(jsonb,jsonb)'; END IF;
  definition := replace(definition,'SELECT m.organization_id INTO v_org
        FROM public.organization_memberships m
       WHERE m.user_id = auth.uid()
         AND m.status = ''ACTIVE''
       LIMIT 1;','v_org := app_private.working_organization_v1();');
  IF md5(definition) <> '79298fdc2aed8cbee2de06cfa1b774e4' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- app_private.resolve_finance_actor_v2()
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('app_private.resolve_finance_actor_v2()'::regprocedure);
  IF md5(definition) = 'a8250632b24dd10865a177df1140bd33' THEN RETURN; END IF;
  IF md5(definition) <> 'b95ceecadba70fe6c24304ce8e5a7e4f' THEN RAISE EXCEPTION 'Live function changed: %','app_private.resolve_finance_actor_v2()'; END IF;
  definition := replace(definition,'SELECT count(DISTINCT m.organization_id) INTO v_count
  FROM public.organization_memberships m
  WHERE m.user_id = v_uid
    AND m.status = ''ACTIVE''
    AND COALESCE(m.valid_from, ''-infinity''::timestamptz) <= now()
    AND (m.valid_to IS NULL OR m.valid_to > now());

  IF v_count = 0 THEN
    RAISE EXCEPTION ''resolve_finance_actor_v2: no active membership for actor''
      USING ERRCODE = ''42501'';
  ELSIF v_count > 1 THEN
    RAISE EXCEPTION ''resolve_finance_actor_v2: ambiguous membership; org-scoped resolution required''
      USING ERRCODE = ''42501'';
  END IF;

  SELECT m.organization_id INTO v_org
  FROM public.organization_memberships m
  WHERE m.user_id = v_uid
    AND m.status = ''ACTIVE''
    AND COALESCE(m.valid_from, ''-infinity''::timestamptz) <= now()
    AND (m.valid_to IS NULL OR m.valid_to > now())
  LIMIT 1;','v_org := app_private.working_organization_v1();');
  IF md5(definition) <> 'a8250632b24dd10865a177df1140bd33' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.set_sale_bonus_cap_v1(numeric,uuid,text,uuid,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.set_sale_bonus_cap_v1(numeric,uuid,text,uuid,text)'::regprocedure);
  IF md5(definition) = '79645453f0e2435b93bb58fc0e485c4a' THEN RETURN; END IF;
  IF md5(definition) <> '68ba4c30fc4f623c2d634c6a6ace067a' THEN RAISE EXCEPTION 'Live function changed: %','public.set_sale_bonus_cap_v1(numeric,uuid,text,uuid,text)'; END IF;
  definition := replace(definition,'SELECT m.organization_id INTO v_org FROM public.organization_memberships m
       WHERE m.user_id = v_actor AND m.status = ''ACTIVE'' LIMIT 1;','v_org := app_private.working_organization_v1();');
  IF md5(definition) <> '79645453f0e2435b93bb58fc0e485c4a' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.set_commission_tier_v1(integer,integer,numeric,uuid,text,uuid,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.set_commission_tier_v1(integer,integer,numeric,uuid,text,uuid,text)'::regprocedure);
  IF md5(definition) = 'bfc0120ea73be775e9742292e389fd2f' THEN RETURN; END IF;
  IF md5(definition) <> '3b7070ff2ab786c834faf8a4bc8f4caf' THEN RAISE EXCEPTION 'Live function changed: %','public.set_commission_tier_v1(integer,integer,numeric,uuid,text,uuid,text)'; END IF;
  definition := replace(definition,'SELECT m.organization_id INTO v_org FROM public.organization_memberships m
       WHERE m.user_id = v_actor AND m.status = ''ACTIVE'' LIMIT 1;','v_org := app_private.working_organization_v1();');
  IF md5(definition) <> 'bfc0120ea73be775e9742292e389fd2f' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.set_utility_ceiling_v1(text,numeric,numeric,uuid,text,uuid,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.set_utility_ceiling_v1(text,numeric,numeric,uuid,text,uuid,text)'::regprocedure);
  IF md5(definition) = 'ef815f38388d9e46ec3c71cf2a86c84a' THEN RETURN; END IF;
  IF md5(definition) <> 'd34815ff21be27282515c7f8c8eb3c1f' THEN RAISE EXCEPTION 'Live function changed: %','public.set_utility_ceiling_v1(text,numeric,numeric,uuid,text,uuid,text)'; END IF;
  definition := replace(definition,'(SELECT m.organization_id FROM public.organization_memberships m
        WHERE m.user_id = v_actor AND m.status=''ACTIVE'' LIMIT 1)','app_private.working_organization_v1()');
  IF md5(definition) <> 'ef815f38388d9e46ec3c71cf2a86c84a' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.set_maintenance_rule_v1(text,numeric,numeric,integer,boolean,text,uuid,text,uuid,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.set_maintenance_rule_v1(text,numeric,numeric,integer,boolean,text,uuid,text,uuid,text)'::regprocedure);
  IF md5(definition) = '88089b73a6e6ca6110f94c372459c4c8' THEN RETURN; END IF;
  IF md5(definition) <> '06c169c7432d22cdd09bd150850a84ea' THEN RAISE EXCEPTION 'Live function changed: %','public.set_maintenance_rule_v1(text,numeric,numeric,integer,boolean,text,uuid,text,uuid,text)'; END IF;
  definition := replace(definition,'(SELECT m.organization_id FROM public.organization_memberships m
        WHERE m.user_id = v_actor AND m.status=''ACTIVE'' LIMIT 1)','app_private.working_organization_v1()');
  IF md5(definition) <> '88089b73a6e6ca6110f94c372459c4c8' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public._autofill_org()
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public._autofill_org()'::regprocedure);
  IF md5(definition) = '2efc1e4069562b34b03e996740160c7c' THEN RETURN; END IF;
  IF md5(definition) <> 'db63306771f7c32846f77c641e26edce' THEN RAISE EXCEPTION 'Live function changed: %','public._autofill_org()'; END IF;
  definition := replace(definition,'  PROD constant uuid := ''aaaa0000-0000-4000-8000-000000000001'';','');
  definition := replace(definition,'  -- Membership: CHỈ khi user thuộc đúng MỘT org ACTIVE (uuid-safe, không dùng min()).','  -- Parent record identity wins. An authenticated root insert uses the chosen company.
  IF v IS NULL AND auth.uid() IS NOT NULL THEN v := app_private.working_organization_v1(); END IF;
  -- Background writers without an authenticated actor may use one unambiguous owner membership.');
  definition := replace(definition,'  IF v IS NULL THEN
    BEGIN
      INSERT INTO public.authorization_migration_exceptions(table_name, reason, details)
      VALUES (TG_TABLE_NAME, ''PROD_DEFAULT_FALLBACK at insert'',
              jsonb_build_object(''source'', ''_autofill_org'', ''at'', now(),
                                 ''new_row_keys'', (SELECT jsonb_object_agg(k, j->k)
                                                  FROM unnest(ARRAY[''id'',''user_id'',''building_id'',''room_id'',''contract_id'',''invoice_id'',''account_id'',''customer_id'']) AS k
                                                  WHERE j ? k)));
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    v := PROD;
  END IF;','  IF v IS NULL THEN RAISE EXCEPTION ''Không xác định được công ty cho bản ghi mới'' USING ERRCODE=''22023''; END IF;');
  IF md5(definition) <> '2efc1e4069562b34b03e996740160c7c' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.set_membership_status_v1(uuid,text,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.set_membership_status_v1(uuid,text,text)'::regprocedure);
  IF md5(definition) = 'f83cdb6638f011a3d2db73d1e8744fbb' THEN RETURN; END IF;
  IF md5(definition) <> '99098ec230f03522f30e8688f05ca4a5' THEN RAISE EXCEPTION 'Live function changed: %','public.set_membership_status_v1(uuid,text,text)'; END IF;
  definition := replace(definition,'   where m.user_id = p_user_id','   where m.user_id = p_user_id
     and m.organization_id = app_private.working_organization_v1()');
  definition := replace(definition,'  -- org: nơi người thao tác giữ role Chủ sở hữu tổ chức và đối tượng là thành viên','  -- Serialize decisions about the last owner inside the selected organization.
  perform 1 from public.organizations where id=app_private.working_organization_v1() for update;
  -- Retain the existing owner/superadmin and self-change checks.');
  IF md5(definition) <> 'f83cdb6638f011a3d2db73d1e8744fbb' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.delete_staff_member(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.delete_staff_member(uuid)'::regprocedure);
  IF md5(definition) = '8291dc1e8d2dc4ad0375f1334db91669' THEN RETURN; END IF;
  IF md5(definition) <> '5c1e2b6fadd47bbca14eaa6b4fccb148' THEN RAISE EXCEPTION 'Live function changed: %','public.delete_staff_member(uuid)'; END IF;
  definition := replace(definition,'  v_sa int := 0; v_memb int := 0;','  v_sa int := 0; v_memb int := 0; v_org uuid;');
  definition := replace(definition,'  if p_staff_id = auth.uid() then','  v_org := app_private.working_organization_v1();
  perform 1 from public.organizations where id=v_org for update;
  if p_staff_id = auth.uid() then');
  definition := replace(definition,'     where staff_id = p_staff_id and user_id = auth.uid()','     where staff_id = p_staff_id and user_id = auth.uid() and organization_id = v_org');
  definition := replace(definition,'  -- 1) gỡ phân công legacy (trigger a80 đóng role_binding chuẩn hoá)','  -- A selected-company removal must retain the last effective owner.
  if exists (
    select 1 from public.role_bindings rb
    join public.organization_memberships m on m.id=rb.membership_id and m.organization_id=rb.organization_id
    join public.organization_roles r on r.id=rb.role_id and r.organization_id=rb.organization_id
    where rb.organization_id=v_org and m.user_id=p_staff_id and r.name=''Chủ sở hữu tổ chức''
      and coalesce(rb.valid_from,''-infinity''::timestamptz)<=now() and (rb.valid_to is null or rb.valid_to>now())
  ) and not exists (
    select 1 from public.role_bindings rb
    join public.organization_memberships m on m.id=rb.membership_id and m.organization_id=rb.organization_id
    join public.organization_roles r on r.id=rb.role_id and r.organization_id=rb.organization_id
    where rb.organization_id=v_org and m.user_id<>p_staff_id and r.name=''Chủ sở hữu tổ chức''
      and app_private.active_working_membership_v1(m.user_id,v_org)
      and coalesce(rb.valid_from,''-infinity''::timestamptz)<=now() and (rb.valid_to is null or rb.valid_to>now())
  ) then raise exception ''Không thể thu hồi CHỦ SỞ HỮU CUỐI CÙNG của công ty'' using errcode=''42501''; end if;
  -- 1) gỡ phân công legacy (trigger a80 đóng role_binding chuẩn hoá)');
  definition := replace(definition,'  delete from public.staff_assignments where staff_id = p_staff_id;','  delete from public.staff_assignments where staff_id = p_staff_id and organization_id = v_org;');
  definition := replace(definition,'   where user_id = p_staff_id and status <> ''REVOKED'';','   where user_id = p_staff_id and organization_id = v_org and status <> ''REVOKED'';');
  definition := replace(definition,'  delete from public.roles where user_id = p_staff_id;','  delete from public.roles where user_id = p_staff_id
    and not exists (select 1 from public.organization_memberships m
      where m.user_id=p_staff_id and m.organization_id<>v_org and m.status<>''REVOKED'');');
  definition := replace(definition,'   where exists (select 1 from public.organization_memberships m','   where o.id=v_org and exists (select 1 from public.organization_memberships m');
  IF md5(definition) <> '8291dc1e8d2dc4ad0375f1334db91669' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.salary_payout_v1(uuid,date,numeric,uuid,date,text,text,uuid,numeric)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.salary_payout_v1(uuid,date,numeric,uuid,date,text,text,uuid,numeric)'::regprocedure);
  IF md5(definition) = '9e41721e7ff590f9014bc8ad6cc2d520' THEN RETURN; END IF;
  IF md5(definition) <> '75d7f087387b593f470ad5f5442f985a' THEN RAISE EXCEPTION 'Live function changed: %','public.salary_payout_v1(uuid,date,numeric,uuid,date,text,text,uuid,numeric)'; END IF;
  definition := replace(definition,'  select organization_id into v_org from public.manager_salary_config
   where staff_id = p_staff_id and organization_id is not null
   order by is_active desc, created_at desc limit 1;
  if v_org is null then
    select organization_id into v_org from public.organization_memberships
     where user_id = p_staff_id and status=''ACTIVE'' limit 1;
  end if;
  if v_org is null then raise exception ''Không xác định được tổ chức của nhân viên'' using errcode=''42501''; end if;','  v_org := app_private.salary_subject_organization_v1(p_staff_id,p_period_month,p_account_id);');
  definition := replace(definition,'    -- P5: clamp về phần còn nợ (mirror legacy; tránh excess ngoài ý muốn).','    if v_inv.organization_id is distinct from v_org then
      raise exception ''Hoá đơn khấu trừ không thuộc công ty của bảng lương'' using errcode=''42501''; end if;
    -- P5: clamp về phần còn nợ (mirror legacy; tránh excess ngoài ý muốn).');
  definition := replace(definition,'    organization_id   = coalesce(public.salary_monthly.organization_id, excluded.organization_id);','    organization_id   = coalesce(public.salary_monthly.organization_id, excluded.organization_id)
  where public.salary_monthly.organization_id = excluded.organization_id;
  if not found then raise exception ''Bảng lương đã thuộc công ty khác'' using errcode=''40001''; end if;');
  IF md5(definition) <> '9e41721e7ff590f9014bc8ad6cc2d520' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.lock_salary_month_v1(date,jsonb,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.lock_salary_month_v1(date,jsonb,text)'::regprocedure);
  IF md5(definition) = 'b084db67a3033672fbb07795e1194619' THEN RETURN; END IF;
  IF md5(definition) <> '4dd21e9c38ddb3249ce144a543d27764' THEN RAISE EXCEPTION 'Live function changed: %','public.lock_salary_month_v1(date,jsonb,text)'; END IF;
  definition := replace(definition,'    select organization_id into v_org from public.manager_salary_config
     where staff_id = v_first_staff and organization_id is not null
     order by is_active desc, created_at desc limit 1;
    if v_org is null then
      select organization_id into v_org from public.organization_memberships
       where user_id = v_first_staff and status=''ACTIVE'' limit 1;
    end if;
    if v_org is null then raise exception ''Không xác định được tổ chức của nhân viên''; end if;','    v_org := app_private.salary_subject_organization_v1(v_first_staff,p_period_month);');
  definition := replace(definition,'    -- mọi staff còn lại phải cùng org','    -- Every persisted salary period, not only its staff membership, must match.
    if exists (select 1 from jsonb_array_elements(p_managers) mg
      where app_private.salary_subject_organization_v1(nullif(mg->>''staff_id'','''')::uuid,p_period_month) is distinct from v_org) then
      raise exception ''Danh sách bảng lương chứa công ty khác'' using errcode=''42501''; end if;
    if exists (select 1 from jsonb_array_elements(p_managers) mg
      cross join lateral jsonb_array_elements_text(coalesce(mg->''commission_voucher_ids'',''[]''::jsonb)) ids(id)
      join public.income_expenses ie on ie.id=nullif(ids.id,'''')::uuid
      where ie.organization_id is distinct from v_org) then
      raise exception ''Phiếu hoa hồng không thuộc công ty của bảng lương'' using errcode=''42501''; end if;
    -- mọi staff còn lại phải cùng org');
  definition := replace(definition,'     where staff_id = v_staff and is_active = true','     where staff_id = v_staff and organization_id = v_org and is_active = true');
  definition := replace(definition,'      select user_id into v_owner from public.super_admins order by created_at limit 1;','      select (array_agg(distinct user_id))[1] into v_owner from public.organization_memberships
       where organization_id=v_org and member_type=''OWNER''
         and app_private.active_working_membership_v1(user_id,v_org)
       having count(distinct user_id)=1;');
  definition := replace(definition,'    returning id into v_monthly_id;','    where public.salary_monthly.organization_id = excluded.organization_id
    returning id into v_monthly_id;
    if not found then raise exception ''Bảng lương đã thuộc công ty khác'' using errcode=''40001''; end if;');
  IF md5(definition) <> 'b084db67a3033672fbb07795e1194619' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.unlock_salary_month_v1(date,uuid[],text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.unlock_salary_month_v1(date,uuid[],text)'::regprocedure);
  IF md5(definition) = 'fdc4351a6a1ec48b20d971958d0d1cc4' THEN RETURN; END IF;
  IF md5(definition) <> '6496dc3c3beb8cc043e70d6f814fcc3c' THEN RAISE EXCEPTION 'Live function changed: %','public.unlock_salary_month_v1(date,uuid[],text)'; END IF;
  definition := replace(definition,'  select organization_id into v_org from public.organization_memberships
   where user_id = p_staff_ids[1] and status=''ACTIVE'' limit 1;
  if v_org is null then
    select organization_id into v_org from public.manager_salary_config
     where staff_id = p_staff_ids[1] and organization_id is not null order by created_at desc limit 1;
  end if;
  if v_org is null then raise exception ''Không xác định được tổ chức của nhân viên''; end if;','  v_org := app_private.salary_subject_organization_v1(p_staff_ids[1],p_period_month);
  if exists (select 1 from unnest(p_staff_ids) ids(staff_id)
    where app_private.salary_subject_organization_v1(ids.staff_id,p_period_month) is distinct from v_org) then
    raise exception ''Danh sách bảng lương chứa công ty khác'' using errcode=''42501''; end if;');
  definition := replace(definition,'   where period_month = p_period_month and staff_id = any(p_staff_ids) and status = ''LOCKED''','   where organization_id = v_org and period_month = p_period_month and staff_id = any(p_staff_ids) and status = ''LOCKED''');
  definition := replace(definition,'   where period_month = p_period_month
     and staff_id = any(p_staff_ids)','   where organization_id = v_org and period_month = p_period_month
     and staff_id = any(p_staff_ids)');
  IF md5(definition) <> 'fdc4351a6a1ec48b20d971958d0d1cc4' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid)'::regprocedure);
  IF md5(definition) = '58e2f511bdccf89260441aa122532345' THEN RETURN; END IF;
  IF md5(definition) <> 'b6a36737c5fc1aeadf759f89aee552ee' THEN RAISE EXCEPTION 'Live function changed: %','public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid)'; END IF;
  definition := replace(definition,'public._termination_ensure_type(v_owner, ''expense'', v_type_nm)','app_private.ensure_termination_type_in_org_v1(v_owner, ''expense'', v_type_nm,v_org)');
  definition := replace(definition,'WHERE id = p_account_id AND deleted_at IS NULL','WHERE id = p_account_id AND organization_id = v_org AND deleted_at IS NULL');
  definition := replace(definition,'WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE ''%Thu''','WHERE user_id = auth.uid() AND organization_id = v_org AND deleted_at IS NULL AND btrim(name) LIKE ''%Thu''');
  IF md5(definition) <> '58e2f511bdccf89260441aa122532345' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)'::regprocedure);
  IF md5(definition) = '6e092a2c9171c10b89d8ce5408bba866' THEN RETURN; END IF;
  IF md5(definition) <> '6545b554ba8732eb4362b95fbcd040e4' THEN RAISE EXCEPTION 'Live function changed: %','public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)'; END IF;
  definition := replace(definition,'public.resolve_fixed_expense_type(v_owner, p_category_key)','app_private.resolve_fixed_expense_type_in_org_v1(v_owner, p_category_key,v_org)');
  definition := replace(definition,'WHERE id = p_account_id AND deleted_at IS NULL','WHERE id = p_account_id AND organization_id = v_org AND deleted_at IS NULL');
  definition := replace(definition,'WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE ''%Thu''','WHERE user_id = auth.uid() AND organization_id = v_org AND deleted_at IS NULL AND btrim(name) LIKE ''%Thu''');
  definition := replace(definition,'JOIN accounts a ON a.id = fa.default_account_id AND a.deleted_at IS NULL','JOIN accounts a ON a.id = fa.default_account_id AND a.organization_id = v_org AND a.deleted_at IS NULL');
  IF md5(definition) <> '6e092a2c9171c10b89d8ce5408bba866' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.adopt_voucher_attachments_as_evidence_v2(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.adopt_voucher_attachments_as_evidence_v2(uuid)'::regprocedure);
  IF md5(definition) = 'b1e67cd92391db80064ba31f52319d46' THEN RETURN; END IF;
  IF md5(definition) <> 'f2d71ddb1733fd863276efa9c31c0a18' THEN RAISE EXCEPTION 'Live function changed: %','public.adopt_voucher_attachments_as_evidence_v2(uuid)'; END IF;
  definition := replace(definition,'INSERT INTO app_private.storage_object_links
      (bucket_id, object_name, organization_id, owner_user_id, derivation)
    VALUES (v_bucket, v_object, v_ie.organization_id, v_actor.user_id, ''FINANCE_V2_EVIDENCE'')
    ON CONFLICT DO NOTHING;','IF v_bucket = ''income-expense-attachments'' THEN PERFORM app_private.bind_finance_storage_org_v1(v_ie.organization_id,v_bucket,v_object); ELSE INSERT INTO app_private.storage_object_links
      (bucket_id, object_name, organization_id, owner_user_id, derivation)
    VALUES (v_bucket, v_object, v_ie.organization_id, v_actor.user_id, ''FINANCE_V2_EVIDENCE'')
    ON CONFLICT DO NOTHING; END IF;');
  definition := replace(definition,'IF v_row.state <> ''FINALIZED'' THEN','IF v_bucket = ''income-expense-attachments'' AND v_row.state = ''ATTACHED'' THEN
      PERFORM app_private.bind_finance_storage_org_v1(v_ie.organization_id,v_bucket,v_object);
    END IF;
    IF v_row.state <> ''FINALIZED'' THEN');
  IF md5(definition) <> 'b1e67cd92391db80064ba31f52319d46' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.finalize_finance_evidence_v2(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef('public.finalize_finance_evidence_v2(uuid)'::regprocedure);
  IF md5(definition) = '109d2bea650e8902baf3a495e31bb952' THEN RETURN; END IF;
  IF md5(definition) <> '64ea72286787e0877f4c774af9cb4247' THEN RAISE EXCEPTION 'Live function changed: %','public.finalize_finance_evidence_v2(uuid)'; END IF;
  definition := replace(definition,'INSERT INTO app_private.storage_object_links (bucket_id, object_name, organization_id, owner_user_id, derivation)
  VALUES (v_row.bucket_id, v_row.object_name, v_row.organization_id, auth.uid(), ''FINANCE_V2_EVIDENCE'')
  ON CONFLICT DO NOTHING;','IF v_row.bucket_id = ''income-expense-attachments'' THEN PERFORM app_private.bind_finance_storage_org_v1(v_row.organization_id,v_row.bucket_id,v_row.object_name); ELSE INSERT INTO app_private.storage_object_links (bucket_id, object_name, organization_id, owner_user_id, derivation)
  VALUES (v_row.bucket_id, v_row.object_name, v_row.organization_id, auth.uid(), ''FINANCE_V2_EVIDENCE'')
  ON CONFLICT DO NOTHING; END IF;');
  definition := replace(definition,'IF v_row.state = ''FINALIZED'' THEN','IF v_row.state = ''FINALIZED'' THEN
    IF v_row.bucket_id = ''income-expense-attachments'' THEN PERFORM app_private.bind_finance_storage_org_v1(v_row.organization_id,v_row.bucket_id,v_row.object_name); END IF;');
  IF md5(definition) <> '109d2bea650e8902baf3a495e31bb952' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.buildings'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT ON public.buildings FOR EACH ROW EXECUTE FUNCTION _autofill_org()' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.buildings'::regclass AND NOT tgisinternal;
  IF actual<>'a82926e6d5cc64e4c7b5d29e84788b11' THEN RAISE EXCEPTION 'Live triggers changed on public.buildings'; END IF;
  EXECUTE 'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT ON public.buildings FOR EACH ROW EXECUTE FUNCTION public._autofill_org()';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.areas'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT ON public.areas FOR EACH ROW EXECUTE FUNCTION _autofill_org()' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.areas'::regclass AND NOT tgisinternal;
  IF actual<>'5ccfa6ce0a824a75bddad79af0e9411d' THEN RAISE EXCEPTION 'Live triggers changed on public.areas'; END IF;
  EXECUTE 'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT ON public.areas FOR EACH ROW EXECUTE FUNCTION public._autofill_org()';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.building_utility_accounts'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT ON public.building_utility_accounts FOR EACH ROW EXECUTE FUNCTION _autofill_org()' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.building_utility_accounts'::regclass AND NOT tgisinternal;
  IF actual<>'7de038ebf3383862882eb8ef2801b9ab' THEN RAISE EXCEPTION 'Live triggers changed on public.building_utility_accounts'; END IF;
  EXECUTE 'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT ON public.building_utility_accounts FOR EACH ROW EXECUTE FUNCTION public._autofill_org()';
END $trigger_guard$;

ROLLBACK;
