-- REVIEW ONLY. Production application requires the reviewed migration lane and a fresh full backup.

BEGIN;

SET LOCAL search_path=pg_catalog,public;

SET LOCAL lock_timeout='5s';

SET LOCAL statement_timeout='60s';

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(E'app_private.active_working_membership_v1(uuid,uuid)') AND md5(prosrc)<>E'48e180667fd2c164beddb078b8c5f37c') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %',E'app_private.active_working_membership_v1(uuid,uuid)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(E'app_private.working_organization_v1(boolean)') AND md5(prosrc)<>E'a752313fbb34358a0983b97b64e19c32') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %',E'app_private.working_organization_v1(boolean)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(E'app_private.salary_subject_organization_v1(uuid,date,uuid,uuid)') AND md5(prosrc)<>E'ff46bfe9947b50aa8664cda21d565a76') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %',E'app_private.salary_subject_organization_v1(uuid,date,uuid,uuid)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(E'app_private.fill_business_organization_v1()') AND md5(prosrc)<>E'02eee8ffcaee8f1938add532e734b911') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %',E'app_private.fill_business_organization_v1()';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(E'app_private.bind_finance_storage_org_v1(uuid,text,text)') AND md5(prosrc)<>E'91b101ad5ee7f9b8e32fa3c7c3d3c0e8') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %',E'app_private.bind_finance_storage_org_v1(uuid,text,text)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(E'app_private.bind_voucher_attachment_links_v1()') AND md5(prosrc)<>E'cebfd374821d0079134960f8abde855c') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %',E'app_private.bind_voucher_attachment_links_v1()';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(E'app_private.ensure_termination_type_in_org_v1(uuid,text,text,uuid)') AND md5(prosrc)<>E'38ca05c56ab237865da3f3eead6c6de3') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %',E'app_private.ensure_termination_type_in_org_v1(uuid,text,text,uuid)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(E'app_private.resolve_fixed_expense_type_in_org_v1(uuid,text,uuid)') AND md5(prosrc)<>E'1e468daf8f26f3db6d9d413db9b598fb') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %',E'app_private.resolve_fixed_expense_type_in_org_v1(uuid,text,uuid)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(E'app_private.chung_building_in_org_v1(uuid,uuid)') AND md5(prosrc)<>E'91c28964a91c76040d37688ea0a84ee8') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %',E'app_private.chung_building_in_org_v1(uuid,uuid)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(E'app_private.deposit_account_in_org_v1(uuid,uuid)') AND md5(prosrc)<>E'342f5b0567b04d1c04bd3af22b947467') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %',E'app_private.deposit_account_in_org_v1(uuid,uuid)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(E'app_private.internal_settlement_account_in_org_v1(uuid,uuid)') AND md5(prosrc)<>E'7a8280f2b8dc60cf85d00fc235dfd438') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %',E'app_private.internal_settlement_account_in_org_v1(uuid,uuid)';
  END IF;
END $guard$;

DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(E'app_private.has_any_scope_for_org_v1(text,uuid)') AND md5(prosrc)<>E'176b37a44f797e422911d48dd811fc84') THEN
    RAISE EXCEPTION 'Existing helper differs from reviewed body: %',E'app_private.has_any_scope_for_org_v1(text,uuid)';
  END IF;
END $guard$;

DO $source_guard$ BEGIN
  IF md5(pg_get_functiondef(E'app_private.has_any_scope_v3(text)'::regprocedure))<>E'2a7502dbd68cc07fd277d4584bf82e54' THEN
    RAISE EXCEPTION 'Live membership permission rule changed; refresh the review';
  END IF;
END $source_guard$;

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

-- Only attached to the reviewed business tables. Parent identifiers come from
-- trigger arguments owned by this migration, never from a client table name.
CREATE OR REPLACE FUNCTION app_private.fill_business_organization_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE
  j jsonb := to_jsonb(NEW);
  v_org uuid := NEW.organization_id;
  v_parent uuid;
  v_orgs uuid[];
  i integer := 0;
BEGIN
  IF TG_OP='UPDATE' AND OLD.organization_id IS NOT NULL
    AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'Không thể đổi công ty của bản ghi đã có công ty' USING ERRCODE='42501';
  END IF;
  WHILE i<TG_NARGS LOOP
    IF j->>TG_ARGV[i] IS NOT NULL THEN
      EXECUTE format('SELECT organization_id FROM public.%I WHERE id=$1',TG_ARGV[i+1])
        INTO v_parent USING (j->>TG_ARGV[i])::uuid;
      IF v_parent IS NULL THEN
        RAISE EXCEPTION 'Hồ sơ liên kết chưa xác định được công ty' USING ERRCODE='22023';
      END IF;
      IF v_org IS NOT NULL AND v_org<>v_parent THEN
        RAISE EXCEPTION 'Các hồ sơ liên kết phải thuộc cùng công ty' USING ERRCODE='42501';
      END IF;
      v_org := v_parent;
    END IF;
    i := i+2;
  END LOOP;
  IF v_org IS NULL AND auth.uid() IS NOT NULL THEN
    v_org := app_private.working_organization_v1();
  ELSIF v_org IS NULL AND j->>'user_id' IS NOT NULL THEN
    -- Service writers may retain one proven owner company, never a default.
    SELECT array_agg(DISTINCT m.organization_id) INTO v_orgs
      FROM public.organization_memberships m
     WHERE m.user_id=(j->>'user_id')::uuid
       AND app_private.active_working_membership_v1(m.user_id,m.organization_id);
    IF cardinality(v_orgs)=1 THEN v_org := v_orgs[1]; END IF;
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Chưa xác định được công ty cho bản ghi' USING ERRCODE='22023';
  END IF;
  NEW.organization_id := v_org;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION app_private.fill_business_organization_v1() FROM PUBLIC,anon,authenticated,service_role;

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

CREATE OR REPLACE FUNCTION app_private.has_any_scope_for_org_v1(p_permission_key text, p_org uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
  select exists (
    select 1
      from public.permission_definitions pd
      join public.organization_memberships m
        on m.user_id = (select auth.uid())
       and m.organization_id = p_org
       and m.status = 'ACTIVE'
       and coalesce(m.valid_from, '-infinity'::timestamptz) <= now()
       and (m.valid_to is null or m.valid_to > now())
      join public.organizations o
        on o.id = m.organization_id and o.status = 'ACTIVE'
     where pd.key = p_permission_key
       and pd.permission_domain = 'TENANT'
       and pd.is_active
       -- (1) không bị cấm khẩn cấp
       and not exists (
         select 1 from app_private.tenant_emergency_denies d
          where d.organization_id = m.organization_id
            and (d.permission_key is null or d.permission_key = p_permission_key)
            and d.active_from <= now()
            and (d.expires_at is null or d.expires_at > now()))
       -- (2) không có CẤM ở phạm vi toàn tổ chức (cấm hẹp hơn vẫn còn chỗ khác)
       and not exists (
         select 1
           from public.member_permission_overrides ov
           join public.member_override_scopes mos on mos.override_id = ov.id
           join public.authorization_scopes s on s.id = mos.scope_id
          where ov.membership_id = m.id and ov.permission_key = p_permission_key
            and ov.effect = 'DENY' and ov.revoked_at is null
            and (ov.expires_at is null or ov.expires_at > now())
            and s.scope_type = 'ORGANIZATION')
       and not exists (
         select 1
           from public.role_bindings rb
           join public.role_permissions rp
             on rp.role_id = rb.role_id and rp.organization_id = rb.organization_id
            and rp.permission_key = p_permission_key and rp.effect = 'DENY'
           join public.role_binding_scopes rbs on rbs.role_binding_id = rb.id
           join public.authorization_scopes s on s.id = rbs.scope_id
          where rb.membership_id = m.id and rb.valid_to is null
            and s.scope_type = 'ORGANIZATION')
       -- (3) có ít nhất một cạnh CHO khớp loại phạm vi mà quyền này chấp nhận
       and (
         exists (
           select 1
             from public.member_permission_overrides ov
             join public.member_override_scopes mos on mos.override_id = ov.id
             join public.authorization_scopes s on s.id = mos.scope_id
            where ov.membership_id = m.id and ov.permission_key = p_permission_key
              and ov.effect = 'ALLOW' and ov.revoked_at is null
              and (ov.expires_at is null or ov.expires_at > now())
              and s.scope_type = any(pd.scope_kinds)
              and (not pd.requires_cashbook_possession or (
                    s.scope_type = 'CASHBOOK' and exists (
                      select 1 from public.cashbook_possession_bindings cp
                       where cp.membership_id = m.id and cp.cashbook_id = s.cashbook_id
                         and cp.possession_kind = any(pd.accepted_possession_kinds)
                         and cp.valid_from <= now()
                         and (cp.valid_to is null or cp.valid_to > now())))))
         or exists (
           select 1
             from public.role_bindings rb
             join public.role_permissions rp
               on rp.role_id = rb.role_id and rp.organization_id = rb.organization_id
              and rp.permission_key = p_permission_key and rp.effect = 'ALLOW'
             join public.organization_roles orl
               on orl.id = rb.role_id and coalesce(orl.status,'ACTIVE') = 'ACTIVE'
             join public.role_binding_scopes rbs on rbs.role_binding_id = rb.id
             join public.authorization_scopes s on s.id = rbs.scope_id
            where rb.membership_id = m.id
              and coalesce(rb.valid_from, '-infinity'::timestamptz) <= now()
              and (rb.valid_to is null or rb.valid_to > now())
              and s.scope_type = any(pd.scope_kinds)
              and (not pd.requires_cashbook_possession or (
                    s.scope_type = 'CASHBOOK' and exists (
                      select 1 from public.cashbook_possession_bindings cp
                       where cp.membership_id = m.id and cp.cashbook_id = s.cashbook_id
                         and cp.possession_kind = any(pd.accepted_possession_kinds)
                         and cp.valid_from <= now()
                         and (cp.valid_to is null or cp.valid_to > now())))))
       )
  );
$function$;
REVOKE ALL ON FUNCTION app_private.has_any_scope_for_org_v1(text,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- public._termination_ensure_type(uuid,text,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public._termination_ensure_type(uuid,text,text)'::regprocedure);
  IF md5(definition) = E'56ff93c15c5deecdd2b9e028eb42af85' THEN RETURN; END IF;
  IF md5(definition) <> E'1970ff23b826557e50f319ef91535fe6' THEN RAISE EXCEPTION 'Live function changed: %',E'public._termination_ensure_type(uuid,text,text)'; END IF;
  definition := replace(definition,E'\ndeclare\n  v_id uuid; v_org uuid;\nbegin\n  -- org của người thao tác: 1 membership → dùng luôn; nhiều → ưu tiên org\n  -- mà user giữ role "Chủ sở hữu tổ chức" (owner thật thuộc cả demo).\n  select min(m.organization_id::text)::uuid into v_org\n    from organization_memberships m\n   where m.user_id = p_user_id and m.status = ''ACTIVE'';\n  if (select count(distinct m.organization_id) from organization_memberships m\n       where m.user_id = p_user_id and m.status = ''ACTIVE'') > 1 then\n    select rb.organization_id into v_org\n      from role_bindings rb\n      join organization_memberships m\n        on m.id = rb.membership_id and m.organization_id = rb.organization_id\n       and m.user_id = p_user_id and m.status = ''ACTIVE''\n      join organization_roles r on r.id = rb.role_id and r.name = ''Chủ sở hữu tổ chức''\n     limit 1;\n  end if;\n\n  -- (1) TRA THEO ĐÚNG PHẠM VI MÀ UNIQUE INDEX CHẶN.\n  --     income_expense_types_org_side_normalized_name_uq =\n  --       (organization_id, lower(btrim(type)), normalize_income_expense_type_name(name))\n  --     Tra theo user_id như bản cũ là tra hẹp hơn chỗ bị chặn ⇒ loại phiếu do\n  --     người KHÁC trong cùng org đứng tên thì tra không thấy, INSERT xuống là\n  --     23505. Đúng lỗi làm confirm_cash_handover chết với mọi người.\n  if v_org is not null then\n    select t.id into v_id\n      from income_expense_types t\n     where t.organization_id = v_org\n       and lower(btrim(t.type)) = lower(btrim(p_type))\n       and normalize_income_expense_type_name(t.name)\n           = normalize_income_expense_type_name(p_name)\n     limit 1;\n\n    if v_id is not null then\n      update income_expense_types\n         set force_approval = true\n       where id = v_id and force_approval = false;\n      return v_id;\n    end if;\n  end if;\n\n  -- (2) Nhánh cũ, giữ lại cho những dòng còn organization_id IS NULL (chưa được\n  --     gắn org) — index không chặn chúng nên vẫn phải tự tìm theo người tạo.\n  select id into v_id\n    from income_expense_types\n   where user_id = p_user_id\n     and lower(name) = lower(p_name)\n     and lower(type) = lower(p_type)\n   limit 1;\n\n  if v_id is not null then\n    update income_expense_types\n       set force_approval = true,\n           organization_id = coalesce(organization_id, v_org)\n     where id = v_id and (force_approval = false or organization_id is null);\n    return v_id;\n  end if;\n\n  insert into income_expense_types (user_id, organization_id, type, name, description, force_approval)\n  values (p_user_id, v_org, lower(p_type), p_name,\n          ''Tự tạo khi thanh lý hợp đồng'', true)\n  returning id into v_id;\n\n  return v_id;\nend;\n',E'\nBEGIN RETURN app_private.ensure_termination_type_in_org_v1(p_user_id,p_type,p_name,app_private.working_organization_v1()); END;\n');
  IF md5(definition) <> E'56ff93c15c5deecdd2b9e028eb42af85' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.resolve_fixed_expense_type(uuid,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.resolve_fixed_expense_type(uuid,text)'::regprocedure);
  IF md5(definition) = E'f7238f267290d28f52c9b9f039b701d1' THEN RETURN; END IF;
  IF md5(definition) <> E'e6c68ad3c2c98bfe93c4ff0b357ea16e' THEN RAISE EXCEPTION 'Live function changed: %',E'public.resolve_fixed_expense_type(uuid,text)'; END IF;
  definition := replace(definition,E'\nDECLARE\n  v_type uuid;\n  v_name text;\n  v_category text;\n  v_organization_id uuid;\nBEGIN\n  IF p_category_key NOT IN (\n    ''tien_nha'', ''dien'', ''nuoc'', ''internet'', ''quan_ly'',\n    ''ve_sinh'', ''cong_an'', ''rac'', ''thang_may''\n  ) THEN\n    RAISE EXCEPTION ''Hạng mục phí không hợp lệ: %'', p_category_key\n      USING ERRCODE = ''23514'';\n  END IF;\n\n  v_organization_id := app_private.resolve_ie_type_org_for_user_v1(p_owner);\n\n  SELECT type_row.id\n    INTO v_type\n  FROM public.income_expense_types type_row\n  WHERE type_row.organization_id = v_organization_id\n    AND lower(btrim(type_row.type)) = ''expense''\n    AND public.fee_type_matches(\n      p_category_key,\n      type_row.category,\n      type_row.name\n    )\n  ORDER BY\n    COALESCE(type_row.is_default, false) DESC,\n    type_row.created_at,\n    type_row.id\n  LIMIT 1;\n\n  IF v_type IS NOT NULL THEN\n    RETURN v_type;\n  END IF;\n\n  v_name := CASE p_category_key\n    WHEN ''tien_nha''  THEN ''Tiền nhà''\n    WHEN ''dien''      THEN ''Đóng tiền điện''\n    WHEN ''nuoc''      THEN ''Đóng tiền nước''\n    WHEN ''internet''  THEN ''Internet''\n    WHEN ''quan_ly''   THEN ''Quản Lý''\n    WHEN ''ve_sinh''   THEN ''Vệ sinh tòa nhà định kỳ''\n    WHEN ''cong_an''   THEN ''Công an''\n    WHEN ''rac''       THEN ''Tiền rác''\n    WHEN ''thang_may'' THEN ''Bảo trì thang máy''\n  END;\n  v_category := CASE p_category_key\n    WHEN ''tien_nha''  THEN ''Tiền nhà''\n    WHEN ''dien''      THEN ''Điện''\n    WHEN ''nuoc''      THEN ''Nước''\n    WHEN ''internet''  THEN ''Internet''\n    WHEN ''quan_ly''   THEN ''Quản Lý''\n    WHEN ''ve_sinh''   THEN ''Vệ sinh''\n    WHEN ''cong_an''   THEN ''Công an''\n    WHEN ''rac''       THEN ''Rác''\n    WHEN ''thang_may'' THEN ''Bảo Trì Thang Máy''\n  END;\n\n  RETURN app_private.ensure_income_expense_type_v1(\n    p_organization_id => v_organization_id,\n    p_user_id => p_owner,\n    p_name => v_name,\n    p_type => ''expense'',\n    p_category => v_category,\n    p_is_restricted => (p_category_key = ''quan_ly'')\n  );\nEND\n',E'\nBEGIN RETURN app_private.resolve_fixed_expense_type_in_org_v1(p_owner,p_category_key,app_private.working_organization_v1()); END;\n');
  IF md5(definition) <> E'f7238f267290d28f52c9b9f039b701d1' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public._chung_building(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public._chung_building(uuid)'::regprocedure);
  IF md5(definition) = E'd4e8bd7f37c7779bfd67bc7115c206a5' THEN RETURN; END IF;
  IF md5(definition) <> E'4b6ef6c84b56d79b257dc79e94afa6b5' THEN RAISE EXCEPTION 'Live function changed: %',E'public._chung_building(uuid)'; END IF;
  definition := replace(definition,E'\nDECLARE\n  v_id uuid;\nBEGIN\n  -- Tenant thật: toà chung hệ thống = toà ảo không thuộc demo (hiện là\n  -- "Kho Văn Phòng Chung") TRONG ĐÚNG ORG p_user có membership ACTIVE.\n  -- Không lọc org từng đúng khi cả hệ chỉ có một org thật (20260704210000);\n  -- clone_org_sync (20260801060000) nhân bản tòa ảo sang org Test và COPY\n  -- NGUYÊN created_at ⇒ ORDER BY created_at không tiebreaker thành\n  -- nondeterministic và vớ tòa org Test ⇒ phiếu bàn giao/điều chỉnh số dư\n  -- sinh nhầm tenant, bridge V2 không resolve được poster. Thêm b.id làm\n  -- tiebreaker cho ổn định.\n  IF NOT (p_user_id = ANY (public.demo_user_ids())) THEN\n    SELECT b.id INTO v_id FROM buildings b\n     WHERE b.is_virtual = true AND b.deleted_at IS NULL\n       AND NOT (b.user_id = ANY (public.demo_user_ids()))\n       AND EXISTS (\n         SELECT 1 FROM organization_memberships m\n          WHERE m.user_id = p_user_id\n            AND m.status = ''ACTIVE''\n            AND m.organization_id = b.organization_id)\n     ORDER BY b.created_at, b.id LIMIT 1;\n    IF v_id IS NOT NULL THEN RETURN v_id; END IF;\n  END IF;\n\n  -- Fallback (demo, hoặc tenant chưa có toà chung): hành vi cũ\n  SELECT id INTO v_id FROM buildings\n   WHERE user_id = p_user_id AND is_virtual = true AND name = ''Chung''\n     AND deleted_at IS NULL\n   ORDER BY created_at LIMIT 1;\n  IF v_id IS NOT NULL THEN RETURN v_id; END IF;\n\n  INSERT INTO buildings (user_id, name, type, status, province, district, ward, is_virtual)\n  VALUES (p_user_id, ''Chung'', ''APARTMENT''::building_type, ''ACTIVE''::building_status, ''—'', ''—'', ''—'', true)\n  RETURNING id INTO v_id;\n  RETURN v_id;\nEND;\n',E'\nBEGIN RETURN app_private.chung_building_in_org_v1(p_user_id,app_private.working_organization_v1()); END;\n');
  IF md5(definition) <> E'd4e8bd7f37c7779bfd67bc7115c206a5' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public._deposit_account(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public._deposit_account(uuid)'::regprocedure);
  IF md5(definition) = E'5a6c7e022a72a3c7b7a29ae5810b0c9d' THEN RETURN; END IF;
  IF md5(definition) <> E'4a9869ab27533ca80dec02020c0ad9ea' THEN RAISE EXCEPTION 'Live function changed: %',E'public._deposit_account(uuid)'; END IF;
  definition := replace(definition,E'\nDECLARE v_id uuid;\nBEGIN\n  SELECT id INTO v_id\n    FROM accounts\n   WHERE user_id = p_user_id AND deleted_at IS NULL\n     AND name = ''CỌC (giữ hộ khách)''\n   LIMIT 1;\n  IF v_id IS NOT NULL THEN RETURN v_id; END IF;\n\n  INSERT INTO accounts (user_id, name, description, initial_amount)\n  VALUES (p_user_id, ''CỌC (giữ hộ khách)'',\n          ''Sổ giữ tiền cọc của khách (mọi toà). Số dư = tổng cọc đang giữ. Thanh lý: chi trả khách + chuyển phần cấn nợ sang sổ vận hành.'', 0)\n  RETURNING id INTO v_id;\n  RETURN v_id;\nEND ',E'\nBEGIN RETURN app_private.deposit_account_in_org_v1(p_user_id,app_private.working_organization_v1()); END;\n');
  IF md5(definition) <> E'5a6c7e022a72a3c7b7a29ae5810b0c9d' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public._internal_settlement_account(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public._internal_settlement_account(uuid)'::regprocedure);
  IF md5(definition) = E'e511d0a1dacf43274264e384c03150f3' THEN RETURN; END IF;
  IF md5(definition) <> E'c5e635908345ee651fd105ed69c7504c' THEN RAISE EXCEPTION 'Live function changed: %',E'public._internal_settlement_account(uuid)'; END IF;
  definition := replace(definition,E'\nDECLARE v_id uuid;\nBEGIN\n  SELECT id INTO v_id\n    FROM accounts\n   WHERE user_id = p_user_id AND deleted_at IS NULL\n     AND name = ''Cấn trừ thanh lý (nội bộ)''\n   ORDER BY created_at LIMIT 1;\n  IF v_id IS NOT NULL THEN\n    UPDATE accounts SET is_virtual = true WHERE id = v_id AND is_virtual IS DISTINCT FROM true;\n    RETURN v_id;\n  END IF;\n\n  INSERT INTO accounts (user_id, name, description, initial_amount, is_virtual)\n  VALUES (p_user_id, ''Cấn trừ thanh lý (nội bộ)'',\n          ''Sổ BÚT TOÁN (không phải tiền thật): cặp cấn cọc → doanh thu khi thanh lý/bỏ cọc chạy cả 2 chân trên sổ này, mỗi thương vụ net 0.'',\n          0, true)\n  RETURNING id INTO v_id;\n  RETURN v_id;\nEND ',E'\nBEGIN RETURN app_private.internal_settlement_account_in_org_v1(p_user_id,app_private.working_organization_v1()); END;\n');
  IF md5(definition) <> E'e511d0a1dacf43274264e384c03150f3' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.terminate_contract_forfeit_impl(uuid,date,jsonb)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.terminate_contract_forfeit_impl(uuid,date,jsonb)'::regprocedure);
  IF md5(definition) = E'73be158a92b0c01871d6e03387e8a71c' THEN RETURN; END IF;
  IF md5(definition) <> E'7e90f0f91f1d57ec51da82bd6bce7003' THEN RAISE EXCEPTION 'Live function changed: %',E'public.terminate_contract_forfeit_impl(uuid,date,jsonb)'; END IF;
  definition := replace(definition,E'CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit_impl(p_contract_id uuid, p_forfeit_date date, p_extra_charges jsonb DEFAULT ''[]''::jsonb)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''public''\nAS $function$\nDECLARE\n  v_contract       RECORD;\n  v_building_id    uuid;\n  v_invoice_id     uuid;\n  v_extra_inv      uuid;\n  v_extra          numeric(15,2) := 0;\n  v_deposit        numeric(15,2);\n  v_billing        text;\n  v_cnumber        text;\n  v_marker         text;\n  v_acc_int        uuid;\n  v_type_off       uuid;\n  v_type_inc       uuid;\n  v_chi_id         uuid;\n  v_thu_id         uuid;\n  v_kept_paid      numeric(15,2);\n  v_paid_cnt       integer;\n  v_unpaid_cnt     integer;\n  v_cancelled_cnt  integer;\nBEGIN\n  SELECT * INTO v_contract\n    FROM contracts\n   WHERE id = p_contract_id\n     AND deleted_at IS NULL\n   FOR UPDATE;\n\n  IF NOT FOUND THEN\n    RAISE EXCEPTION ''Hợp đồng không tồn tại'';\n  END IF;\n  IF v_contract.status IN (''TERMINATED'',''EXPIRED'') THEN\n    RAISE EXCEPTION ''Hợp đồng đã thanh lý/hết hạn'';\n  END IF;\n  IF v_contract.room_id IS NULL THEN\n    RAISE EXCEPTION ''Hợp đồng chưa gán phòng — không thể thanh lý'';\n  END IF;\n  IF p_forfeit_date < v_contract.start_date THEN\n    RAISE EXCEPTION ''Ngày bỏ cọc (%) không được trước ngày bắt đầu hợp đồng (%)'',\n      to_char(p_forfeit_date,''DD/MM/YYYY''), to_char(v_contract.start_date,''DD/MM/YYYY'');\n  END IF;\n  SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;\n  IF v_building_id IS NULL THEN\n    RAISE EXCEPTION ''Không xác định được toà nhà của hợp đồng'';\n  END IF;\n\n  -- Cọc forfeit = cọc THỰC đã thu (nguồn sự thật: contracts.deposit_paid).\n  -- [A9] Cọc đã thu > cọc theo hợp đồng ⇒ DỪNG, không đoán.\n  -- Công thức LEAST() bên dưới lấy số NHỎ hơn, nên khi ô "Tiền cọc" trên hợp\n  -- đồng khai 0 mà thực đã thu (vd HĐT-062953: 0 / 4.000.000) thì v_deposit = 0\n  -- và TOÀN BỘ khối doanh thu bị bỏ qua trong im lặng: không hoá đơn, không\n  -- phiếu, 0đ doanh thu trên tiền đang giữ trong két.\n  --\n  -- KHÔNG sửa thành COALESCE(deposit_paid,0): đo được 3/4 hợp đồng dôi ra là do\n  -- phiếu "[Accounting repair] Contract deposit" ĐẾM TRÙNG với phiếu thu cọc\n  -- tường minh (2.000.000 + 1.500.000 + 300.000 = 3.800.000đ). Lấy thẳng\n  -- deposit_paid sẽ ghi KHỐNG đúng số đó vào KQKD rồi chảy sang chia lợi nhuận.\n  IF COALESCE(v_contract.deposit_paid, 0) > COALESCE(v_contract.total_deposit, 0) THEN\n    RAISE EXCEPTION ''Không thanh lý được: cọc ĐÃ THU (% đ) lớn hơn cọc THEO HỢP ĐỒNG (% đ), dôi % đ. Hệ thống không tự đoán số nào đúng. Hãy kiểm tra sổ cọc của hợp đồng: nếu có phiếu cọc bị ĐẾM TRÙNG thì huỷ/điều chỉnh phiếu đó; nếu ô "Tiền cọc" trên hợp đồng khai thiếu thì sửa lại cho khớp số THỰC NHẬN. Đừng nâng "Tiền cọc" chỉ để chạy được lệnh — làm vậy sẽ ghi khống phần dôi thành doanh thu.'',\n      round(COALESCE(v_contract.deposit_paid, 0))::bigint,\n      round(COALESCE(v_contract.total_deposit, 0))::bigint,\n      round(COALESCE(v_contract.deposit_paid,0) - COALESCE(v_contract.total_deposit,0))::bigint\n      USING ERRCODE = ''55000'';\n  END IF;\n  v_deposit := LEAST(COALESCE(v_contract.total_deposit, 0), COALESCE(v_contract.deposit_paid, 0));\n  v_billing := to_char(COALESCE(p_forfeit_date, public.org_today_v1(NULL)), ''YYYY-MM'');\n  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);\n  v_marker  := ''[CẤN CỌC BỎ CỌC '' || p_contract_id::text || '']'';\n\n  v_acc_int := public._internal_settlement_account(v_contract.user_id);\n\n  SELECT COALESCE(SUM(paid_amount), 0)\n    INTO v_kept_paid\n    FROM invoices\n   WHERE contract_id = p_contract_id\n     AND deleted_at  IS NULL\n     AND status      IN (''APPROVED'',''OVERDUE'',''PARTIAL_PAID'')\n     AND COALESCE(paid_amount, 0) > 0;\n\n  UPDATE invoices\n     SET status       = ''CANCELLED'',\n         total_amount = COALESCE(paid_amount, 0),\n         notes        = CASE\n                        WHEN notes IS NULL OR length(btrim(notes)) = 0\n                          THEN ''[Huỷ — thanh lý bỏ cọc ngày ''\n                               || to_char(p_forfeit_date,''DD/MM/YYYY'')\n                               || ''; giữ lại '' || round(COALESCE(paid_amount,0))::bigint\n                               || ''đ đã thu làm doanh thu, huỷ phần nợ ''\n                               || round(COALESCE(remaining_amount,0))::bigint || ''đ]''\n                        ELSE notes\n                             || E''\\n[Huỷ — thanh lý bỏ cọc ngày ''\n                             || to_char(p_forfeit_date,''DD/MM/YYYY'')\n                             || ''; giữ lại '' || round(COALESCE(paid_amount,0))::bigint\n                             || ''đ đã thu làm doanh thu, huỷ phần nợ ''\n                             || round(COALESCE(remaining_amount,0))::bigint || ''đ]''\n                      END,\n         updated_at = NOW()\n   WHERE contract_id = p_contract_id\n     AND deleted_at  IS NULL\n     AND status      IN (''APPROVED'',''OVERDUE'',''PARTIAL_PAID'')\n     AND COALESCE(paid_amount, 0) > 0;\n  GET DIAGNOSTICS v_paid_cnt = ROW_COUNT;\n\n  UPDATE invoices\n     SET status       = ''CANCELLED'',\n         total_amount = 0,\n         notes        = CASE\n                        WHEN notes IS NULL OR length(btrim(notes)) = 0\n                          THEN ''[Huỷ tự động — thanh lý bỏ cọc ngày ''\n                               || to_char(p_forfeit_date,''DD/MM/YYYY'') || '']''\n                        ELSE notes\n                             || E''\\n[Huỷ tự động — thanh lý bỏ cọc ngày ''\n                             || to_char(p_forfeit_date,''DD/MM/YYYY'') || '']''\n                      END,\n         updated_at   = NOW()\n   WHERE contract_id = p_contract_id\n     AND deleted_at  IS NULL\n     AND status      IN (''APPROVED'',''OVERDUE'',''PARTIAL_PAID'')\n     AND COALESCE(paid_amount, 0) = 0;\n  GET DIAGNOSTICS v_unpaid_cnt = ROW_COUNT;\n\n  v_cancelled_cnt := COALESCE(v_paid_cnt, 0) + COALESCE(v_unpaid_cnt, 0);\n\n  IF v_deposit > 0 THEN\n    -- v4: hoá đơn bù cọc mang ĐÚNG kỳ tháng bỏ cọc (kind=''SETTLEMENT'' —\n    -- partial unique không còn chặn; thôi mượn slot tháng trống).\n    INSERT INTO invoices (\n      user_id, contract_id, building_id, room_id,\n      kind, billing_month, issue_date, due_date,\n      status, subtotal, discount_amount, total_amount,\n      notes\n    ) VALUES (\n      v_contract.user_id, p_contract_id,\n      v_building_id, v_contract.room_id,\n      ''SETTLEMENT'', v_billing, p_forfeit_date, p_forfeit_date,\n      ''APPROVED''::invoice_status, v_deposit, 0, v_deposit,\n      ''Hoá đơn thanh lý — khách bỏ cọc ngày '' || to_char(p_forfeit_date,''DD/MM/YYYY'')\n        || CASE WHEN v_cancelled_cnt > 0\n                  THEN E''\\n(Đã huỷ '' || v_cancelled_cnt || '' hoá đơn còn nợ''\n                       || CASE WHEN v_kept_paid > 0\n                                 THEN ''; giữ lại '' || round(v_kept_paid)::bigint\n                                      || ''đ đã thu làm doanh thu''\n                                 ELSE '''' END\n                       || '')''\n                  ELSE '''' END\n    )\n    RETURNING id INTO v_invoice_id;\n\n    INSERT INTO invoice_items (\n      invoice_id, type, description,\n      unit_price, quantity, coefficient, amount, sort_order\n    ) VALUES (\n      v_invoice_id, ''PENALTY'',\n      ''Phí phạt khách bỏ cọc (giữ tiền cọc đã thu)'',\n      v_deposit, 1, 1, v_deposit, 1\n    );\n\n    -- Cặp bút toán nội bộ TỰ DUYỆT — CẢ 2 CHÂN trên sổ nội bộ (net 0).\n    v_type_off := public._termination_ensure_type(v_contract.user_id, ''expense'', ''Cấn cọc chuyển doanh thu'');\n    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;\n    v_type_inc := public._termination_ensure_type(v_contract.user_id, ''income'', ''Doanh thu bỏ cọc'');\n    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;\n\n    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)\n    VALUES (v_contract.user_id, ''EXPENSE'', ''Cấn cọc bỏ cọc → chuyển doanh thu — HĐ '' || v_cnumber,\n            v_building_id, v_contract.room_id, p_contract_id, v_acc_int, p_forfeit_date, v_deposit, ''UNAPPROVED'',\n            v_marker || '' Bút toán nội bộ: cọc khách bỏ chuyển thành doanh thu (tự duyệt; không phải tiền thật — không vào sổ quỹ).'',\n            ''termination.forfeit_offset'')\n    RETURNING id INTO v_chi_id;\n    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n    VALUES (v_chi_id, v_type_off, ''Cấn cọc bỏ cọc chuyển doanh thu'', 1, v_deposit, p_forfeit_date, p_forfeit_date);\n\n    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)\n    VALUES (v_contract.user_id, ''INCOME'', ''Doanh thu bỏ cọc — HĐ '' || v_cnumber,\n            v_building_id, v_contract.room_id, p_contract_id, v_acc_int, v_invoice_id, p_forfeit_date, v_deposit, ''UNAPPROVED'',\n            v_marker || '' Bút toán nội bộ: doanh thu bỏ cọc (tự duyệt → tất toán hoá đơn thanh lý; KQKD đếm theo hạng mục).'',\n            ''termination.forfeit_revenue'')\n    RETURNING id INTO v_thu_id;\n    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n    VALUES (v_thu_id, v_type_inc, ''Doanh thu bỏ cọc (cọc khách bỏ)'', 1, v_deposit, p_forfeit_date, p_forfeit_date);\n\n    -- 7af: cặp bút toán nội bộ TỰ DUYỆT ngay trong writer (hướng A).\n    -- Đóng dấu bản chất trước — Finance V2 hết coi đây là phiếu tiền thật.\n    -- 7b1: review_state đi CÙNG cú duyệt, KHÔNG đi trước. Ở nhịp này cả 2\n    -- chân còn UNAPPROVED, mà ie_unapproved_review_state_ck cấm cặp\n    -- (UNAPPROVED, RESOLVED) — đặt ở đây là 23514, chặn cứng thanh lý.\n    UPDATE public.income_expenses\n       SET posting_mode   = ''NON_CASH'',\n           posting_status = ''NOT_APPLICABLE''\n     WHERE id IN (v_chi_id, v_thu_id);\n\n    -- Token cho CẢ HAI chân: chân doanh thu do lệnh dưới đổi, chân đối ứng do\n    -- cascade trg_forfeit_settle_on_approve đổi — guard a05 đòi token từng phiếu.\n    INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)\n    VALUES (v_thu_id, pg_current_xact_id(), ''APPROVED''),\n           (v_chi_id, pg_current_xact_id(), ''APPROVED'');\n\n    -- Duyệt chân doanh thu → cascade duyệt chân đối ứng + tất toán hoá đơn.\n    UPDATE public.income_expenses\n       SET approval_status = ''APPROVED'',\n           approved_by     = COALESCE(auth.uid(), v_contract.user_id),\n           approved_at     = now(),\n           review_state    = ''RESOLVED'',\n           review_version  = income_expenses.review_version + 1\n     WHERE id = v_thu_id;\n\n    DELETE FROM app_private.ie_transition_authorization\n     WHERE income_expense_id IN (v_thu_id, v_chi_id)\n       AND xid = pg_current_xact_id();\n  END IF;\n\n  IF jsonb_typeof(COALESCE(p_extra_charges, ''[]''::jsonb)) = ''array'' THEN\n    SELECT COALESCE(SUM((j->>''amount'')::numeric), 0) INTO v_extra\n      FROM jsonb_array_elements(p_extra_charges) AS t(j)\n     WHERE (j->>''amount'') IS NOT NULL AND (j->>''amount'') <> ''''\n       AND (j->>''amount'')::numeric > 0;\n  END IF;\n\n  IF v_extra > 0 THEN\n    -- v4: hoá đơn thu thêm cũng mang ĐÚNG kỳ tháng bỏ cọc, kind=''SETTLEMENT''.\n    INSERT INTO invoices (user_id, contract_id, building_id, room_id, kind, billing_month, issue_date, due_date, status, subtotal, discount_amount, total_amount, notes)\n    VALUES (v_contract.user_id, p_contract_id, v_building_id, v_contract.room_id, ''SETTLEMENT'', v_billing, p_forfeit_date, p_forfeit_date,\n            ''APPROVED''::invoice_status, 0, 0, 0,\n            ''Hoá đơn thu thêm khi thanh lý — khách bỏ cọc ngày '' || to_char(p_forfeit_date,''DD/MM/YYYY'')\n              || '' (thu riêng — không liên quan hoá đơn bù cọc).'')\n    RETURNING id INTO v_extra_inv;\n    PERFORM public._termination_apply_extra_charges(v_extra_inv, p_extra_charges, p_forfeit_date, v_contract.user_id, p_contract_id);\n    PERFORM public.recompute_invoice_for_id(v_extra_inv);\n  END IF;\n\n  UPDATE contracts\n     SET status          = ''TERMINATED'',\n         actual_end_date = p_forfeit_date,\n         notes           = CASE\n                             WHEN notes IS NULL OR length(btrim(notes)) = 0\n                               THEN ''[Thanh lý — khách bỏ cọc '' || to_char(p_forfeit_date,''DD/MM/YYYY'') || '']''\n                             ELSE notes || E''\\n[Thanh lý — khách bỏ cọc '' || to_char(p_forfeit_date,''DD/MM/YYYY'') || '']''\n                           END,\n         updated_at      = NOW()\n   WHERE id = p_contract_id;\n\n  BEGIN\n    INSERT INTO contract_terminations (\n      user_id, contract_id, termination_date, actual_move_out_date,\n      termination_type,\n      outstanding_debt, early_termination_fee, prorated_rent, prorated_days, prorated_services,\n      total_deposit, status, approved_by, approved_at, notes\n    ) VALUES (\n      v_contract.user_id, p_contract_id, p_forfeit_date, p_forfeit_date,\n      ''FORFEIT'',\n      0, v_deposit, 0, 0, 0,\n      v_deposit, ''COMPLETED'', auth.uid(), NOW(),\n      ''Khách bỏ cọc — đã tạo phiếu thu "Doanh thu bỏ cọc" (chờ duyệt) cho phần cọc thực thu '' || round(v_deposit)::bigint || ''đ.''\n        || CASE WHEN v_kept_paid > 0\n                  THEN '' Đã giữ lại '' || round(v_kept_paid)::bigint\n                       || ''đ đã thu làm doanh thu.''\n                  ELSE '''' END\n        || CASE WHEN v_extra > 0\n                  THEN '' Hoá đơn thu thêm riêng '' || round(v_extra)::bigint || ''đ (chờ thu).''\n                  ELSE '''' END\n    );\n  EXCEPTION WHEN OTHERS THEN\n    RAISE WARNING ''terminate_contract_forfeit_impl: audit insert failed for %: %'', p_contract_id, SQLERRM;\n  END;\n\n  RETURN jsonb_build_object(\n    ''contract_id'',                p_contract_id,\n    ''invoice_id'',                 v_invoice_id,\n    ''settlement_invoice_id'',      v_invoice_id,\n    ''extra_invoice_id'',           v_extra_inv,\n    ''extra_charges_total'',        v_extra,\n    ''forfeit_amount'',             v_deposit,\n    ''cancelled_invoices'',         v_cancelled_cnt,\n    ''kept_paid_amount'',           v_kept_paid,\n    ''pending_income_voucher_id'',  v_thu_id,\n    ''pending_expense_voucher_id'', v_chi_id,\n    ''acc_internal'',               v_acc_int\n  );\nEND;\n$function$\n',E'CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit_impl(p_contract_id uuid, p_forfeit_date date, p_extra_charges jsonb DEFAULT ''[]''::jsonb)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''public''\nAS $function$\nDECLARE\n  v_contract       RECORD;\n  v_building_id    uuid;\n  v_invoice_id     uuid;\n  v_extra_inv      uuid;\n  v_extra          numeric(15,2) := 0;\n  v_deposit        numeric(15,2);\n  v_billing        text;\n  v_cnumber        text;\n  v_marker         text;\n  v_acc_int        uuid;\n  v_type_off       uuid;\n  v_type_inc       uuid;\n  v_chi_id         uuid;\n  v_thu_id         uuid;\n  v_kept_paid      numeric(15,2);\n  v_paid_cnt       integer;\n  v_unpaid_cnt     integer;\n  v_cancelled_cnt  integer;\nBEGIN\n  SELECT * INTO v_contract\n    FROM contracts\n   WHERE id = p_contract_id\n     AND deleted_at IS NULL\n   FOR UPDATE;\n\n  IF NOT FOUND THEN\n    RAISE EXCEPTION ''Hợp đồng không tồn tại'';\n  END IF;\n  IF v_contract.status IN (''TERMINATED'',''EXPIRED'') THEN\n    RAISE EXCEPTION ''Hợp đồng đã thanh lý/hết hạn'';\n  END IF;\n  IF v_contract.room_id IS NULL THEN\n    RAISE EXCEPTION ''Hợp đồng chưa gán phòng — không thể thanh lý'';\n  END IF;\n  IF p_forfeit_date < v_contract.start_date THEN\n    RAISE EXCEPTION ''Ngày bỏ cọc (%) không được trước ngày bắt đầu hợp đồng (%)'',\n      to_char(p_forfeit_date,''DD/MM/YYYY''), to_char(v_contract.start_date,''DD/MM/YYYY'');\n  END IF;\n  SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;\n  IF v_building_id IS NULL THEN\n    RAISE EXCEPTION ''Không xác định được toà nhà của hợp đồng'';\n  END IF;\n\n  -- Cọc forfeit = cọc THỰC đã thu (nguồn sự thật: contracts.deposit_paid).\n  -- [A9] Cọc đã thu > cọc theo hợp đồng ⇒ DỪNG, không đoán.\n  -- Công thức LEAST() bên dưới lấy số NHỎ hơn, nên khi ô "Tiền cọc" trên hợp\n  -- đồng khai 0 mà thực đã thu (vd HĐT-062953: 0 / 4.000.000) thì v_deposit = 0\n  -- và TOÀN BỘ khối doanh thu bị bỏ qua trong im lặng: không hoá đơn, không\n  -- phiếu, 0đ doanh thu trên tiền đang giữ trong két.\n  --\n  -- KHÔNG sửa thành COALESCE(deposit_paid,0): đo được 3/4 hợp đồng dôi ra là do\n  -- phiếu "[Accounting repair] Contract deposit" ĐẾM TRÙNG với phiếu thu cọc\n  -- tường minh (2.000.000 + 1.500.000 + 300.000 = 3.800.000đ). Lấy thẳng\n  -- deposit_paid sẽ ghi KHỐNG đúng số đó vào KQKD rồi chảy sang chia lợi nhuận.\n  IF COALESCE(v_contract.deposit_paid, 0) > COALESCE(v_contract.total_deposit, 0) THEN\n    RAISE EXCEPTION ''Không thanh lý được: cọc ĐÃ THU (% đ) lớn hơn cọc THEO HỢP ĐỒNG (% đ), dôi % đ. Hệ thống không tự đoán số nào đúng. Hãy kiểm tra sổ cọc của hợp đồng: nếu có phiếu cọc bị ĐẾM TRÙNG thì huỷ/điều chỉnh phiếu đó; nếu ô "Tiền cọc" trên hợp đồng khai thiếu thì sửa lại cho khớp số THỰC NHẬN. Đừng nâng "Tiền cọc" chỉ để chạy được lệnh — làm vậy sẽ ghi khống phần dôi thành doanh thu.'',\n      round(COALESCE(v_contract.deposit_paid, 0))::bigint,\n      round(COALESCE(v_contract.total_deposit, 0))::bigint,\n      round(COALESCE(v_contract.deposit_paid,0) - COALESCE(v_contract.total_deposit,0))::bigint\n      USING ERRCODE = ''55000'';\n  END IF;\n  v_deposit := LEAST(COALESCE(v_contract.total_deposit, 0), COALESCE(v_contract.deposit_paid, 0));\n  v_billing := to_char(COALESCE(p_forfeit_date, public.org_today_v1(NULL)), ''YYYY-MM'');\n  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);\n  v_marker  := ''[CẤN CỌC BỎ CỌC '' || p_contract_id::text || '']'';\n\n  v_acc_int := app_private.internal_settlement_account_in_org_v1(v_contract.user_id,v_contract.organization_id);\n\n  SELECT COALESCE(SUM(paid_amount), 0)\n    INTO v_kept_paid\n    FROM invoices\n   WHERE contract_id = p_contract_id\n     AND deleted_at  IS NULL\n     AND status      IN (''APPROVED'',''OVERDUE'',''PARTIAL_PAID'')\n     AND COALESCE(paid_amount, 0) > 0;\n\n  UPDATE invoices\n     SET status       = ''CANCELLED'',\n         total_amount = COALESCE(paid_amount, 0),\n         notes        = CASE\n                        WHEN notes IS NULL OR length(btrim(notes)) = 0\n                          THEN ''[Huỷ — thanh lý bỏ cọc ngày ''\n                               || to_char(p_forfeit_date,''DD/MM/YYYY'')\n                               || ''; giữ lại '' || round(COALESCE(paid_amount,0))::bigint\n                               || ''đ đã thu làm doanh thu, huỷ phần nợ ''\n                               || round(COALESCE(remaining_amount,0))::bigint || ''đ]''\n                        ELSE notes\n                             || E''\\n[Huỷ — thanh lý bỏ cọc ngày ''\n                             || to_char(p_forfeit_date,''DD/MM/YYYY'')\n                             || ''; giữ lại '' || round(COALESCE(paid_amount,0))::bigint\n                             || ''đ đã thu làm doanh thu, huỷ phần nợ ''\n                             || round(COALESCE(remaining_amount,0))::bigint || ''đ]''\n                      END,\n         updated_at = NOW()\n   WHERE contract_id = p_contract_id\n     AND deleted_at  IS NULL\n     AND status      IN (''APPROVED'',''OVERDUE'',''PARTIAL_PAID'')\n     AND COALESCE(paid_amount, 0) > 0;\n  GET DIAGNOSTICS v_paid_cnt = ROW_COUNT;\n\n  UPDATE invoices\n     SET status       = ''CANCELLED'',\n         total_amount = 0,\n         notes        = CASE\n                        WHEN notes IS NULL OR length(btrim(notes)) = 0\n                          THEN ''[Huỷ tự động — thanh lý bỏ cọc ngày ''\n                               || to_char(p_forfeit_date,''DD/MM/YYYY'') || '']''\n                        ELSE notes\n                             || E''\\n[Huỷ tự động — thanh lý bỏ cọc ngày ''\n                             || to_char(p_forfeit_date,''DD/MM/YYYY'') || '']''\n                      END,\n         updated_at   = NOW()\n   WHERE contract_id = p_contract_id\n     AND deleted_at  IS NULL\n     AND status      IN (''APPROVED'',''OVERDUE'',''PARTIAL_PAID'')\n     AND COALESCE(paid_amount, 0) = 0;\n  GET DIAGNOSTICS v_unpaid_cnt = ROW_COUNT;\n\n  v_cancelled_cnt := COALESCE(v_paid_cnt, 0) + COALESCE(v_unpaid_cnt, 0);\n\n  IF v_deposit > 0 THEN\n    -- v4: hoá đơn bù cọc mang ĐÚNG kỳ tháng bỏ cọc (kind=''SETTLEMENT'' —\n    -- partial unique không còn chặn; thôi mượn slot tháng trống).\n    INSERT INTO invoices (\n      user_id, contract_id, building_id, room_id,\n      kind, billing_month, issue_date, due_date,\n      status, subtotal, discount_amount, total_amount,\n      notes\n    ) VALUES (\n      v_contract.user_id, p_contract_id,\n      v_building_id, v_contract.room_id,\n      ''SETTLEMENT'', v_billing, p_forfeit_date, p_forfeit_date,\n      ''APPROVED''::invoice_status, v_deposit, 0, v_deposit,\n      ''Hoá đơn thanh lý — khách bỏ cọc ngày '' || to_char(p_forfeit_date,''DD/MM/YYYY'')\n        || CASE WHEN v_cancelled_cnt > 0\n                  THEN E''\\n(Đã huỷ '' || v_cancelled_cnt || '' hoá đơn còn nợ''\n                       || CASE WHEN v_kept_paid > 0\n                                 THEN ''; giữ lại '' || round(v_kept_paid)::bigint\n                                      || ''đ đã thu làm doanh thu''\n                                 ELSE '''' END\n                       || '')''\n                  ELSE '''' END\n    )\n    RETURNING id INTO v_invoice_id;\n\n    INSERT INTO invoice_items (\n      invoice_id, type, description,\n      unit_price, quantity, coefficient, amount, sort_order\n    ) VALUES (\n      v_invoice_id, ''PENALTY'',\n      ''Phí phạt khách bỏ cọc (giữ tiền cọc đã thu)'',\n      v_deposit, 1, 1, v_deposit, 1\n    );\n\n    -- Cặp bút toán nội bộ TỰ DUYỆT — CẢ 2 CHÂN trên sổ nội bộ (net 0).\n    v_type_off := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''expense'', ''Cấn cọc chuyển doanh thu'',v_contract.organization_id);\n    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;\n    v_type_inc := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''income'', ''Doanh thu bỏ cọc'',v_contract.organization_id);\n    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;\n\n    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)\n    VALUES (v_contract.user_id, ''EXPENSE'', ''Cấn cọc bỏ cọc → chuyển doanh thu — HĐ '' || v_cnumber,\n            v_building_id, v_contract.room_id, p_contract_id, v_acc_int, p_forfeit_date, v_deposit, ''UNAPPROVED'',\n            v_marker || '' Bút toán nội bộ: cọc khách bỏ chuyển thành doanh thu (tự duyệt; không phải tiền thật — không vào sổ quỹ).'',\n            ''termination.forfeit_offset'')\n    RETURNING id INTO v_chi_id;\n    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n    VALUES (v_chi_id, v_type_off, ''Cấn cọc bỏ cọc chuyển doanh thu'', 1, v_deposit, p_forfeit_date, p_forfeit_date);\n\n    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)\n    VALUES (v_contract.user_id, ''INCOME'', ''Doanh thu bỏ cọc — HĐ '' || v_cnumber,\n            v_building_id, v_contract.room_id, p_contract_id, v_acc_int, v_invoice_id, p_forfeit_date, v_deposit, ''UNAPPROVED'',\n            v_marker || '' Bút toán nội bộ: doanh thu bỏ cọc (tự duyệt → tất toán hoá đơn thanh lý; KQKD đếm theo hạng mục).'',\n            ''termination.forfeit_revenue'')\n    RETURNING id INTO v_thu_id;\n    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n    VALUES (v_thu_id, v_type_inc, ''Doanh thu bỏ cọc (cọc khách bỏ)'', 1, v_deposit, p_forfeit_date, p_forfeit_date);\n\n    -- 7af: cặp bút toán nội bộ TỰ DUYỆT ngay trong writer (hướng A).\n    -- Đóng dấu bản chất trước — Finance V2 hết coi đây là phiếu tiền thật.\n    -- 7b1: review_state đi CÙNG cú duyệt, KHÔNG đi trước. Ở nhịp này cả 2\n    -- chân còn UNAPPROVED, mà ie_unapproved_review_state_ck cấm cặp\n    -- (UNAPPROVED, RESOLVED) — đặt ở đây là 23514, chặn cứng thanh lý.\n    UPDATE public.income_expenses\n       SET posting_mode   = ''NON_CASH'',\n           posting_status = ''NOT_APPLICABLE''\n     WHERE id IN (v_chi_id, v_thu_id);\n\n    -- Token cho CẢ HAI chân: chân doanh thu do lệnh dưới đổi, chân đối ứng do\n    -- cascade trg_forfeit_settle_on_approve đổi — guard a05 đòi token từng phiếu.\n    INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)\n    VALUES (v_thu_id, pg_current_xact_id(), ''APPROVED''),\n           (v_chi_id, pg_current_xact_id(), ''APPROVED'');\n\n    -- Duyệt chân doanh thu → cascade duyệt chân đối ứng + tất toán hoá đơn.\n    UPDATE public.income_expenses\n       SET approval_status = ''APPROVED'',\n           approved_by     = COALESCE(auth.uid(), v_contract.user_id),\n           approved_at     = now(),\n           review_state    = ''RESOLVED'',\n           review_version  = income_expenses.review_version + 1\n     WHERE id = v_thu_id;\n\n    DELETE FROM app_private.ie_transition_authorization\n     WHERE income_expense_id IN (v_thu_id, v_chi_id)\n       AND xid = pg_current_xact_id();\n  END IF;\n\n  IF jsonb_typeof(COALESCE(p_extra_charges, ''[]''::jsonb)) = ''array'' THEN\n    SELECT COALESCE(SUM((j->>''amount'')::numeric), 0) INTO v_extra\n      FROM jsonb_array_elements(p_extra_charges) AS t(j)\n     WHERE (j->>''amount'') IS NOT NULL AND (j->>''amount'') <> ''''\n       AND (j->>''amount'')::numeric > 0;\n  END IF;\n\n  IF v_extra > 0 THEN\n    -- v4: hoá đơn thu thêm cũng mang ĐÚNG kỳ tháng bỏ cọc, kind=''SETTLEMENT''.\n    INSERT INTO invoices (user_id, contract_id, building_id, room_id, kind, billing_month, issue_date, due_date, status, subtotal, discount_amount, total_amount, notes)\n    VALUES (v_contract.user_id, p_contract_id, v_building_id, v_contract.room_id, ''SETTLEMENT'', v_billing, p_forfeit_date, p_forfeit_date,\n            ''APPROVED''::invoice_status, 0, 0, 0,\n            ''Hoá đơn thu thêm khi thanh lý — khách bỏ cọc ngày '' || to_char(p_forfeit_date,''DD/MM/YYYY'')\n              || '' (thu riêng — không liên quan hoá đơn bù cọc).'')\n    RETURNING id INTO v_extra_inv;\n    PERFORM public._termination_apply_extra_charges(v_extra_inv, p_extra_charges, p_forfeit_date, v_contract.user_id, p_contract_id);\n    PERFORM public.recompute_invoice_for_id(v_extra_inv);\n  END IF;\n\n  UPDATE contracts\n     SET status          = ''TERMINATED'',\n         actual_end_date = p_forfeit_date,\n         notes           = CASE\n                             WHEN notes IS NULL OR length(btrim(notes)) = 0\n                               THEN ''[Thanh lý — khách bỏ cọc '' || to_char(p_forfeit_date,''DD/MM/YYYY'') || '']''\n                             ELSE notes || E''\\n[Thanh lý — khách bỏ cọc '' || to_char(p_forfeit_date,''DD/MM/YYYY'') || '']''\n                           END,\n         updated_at      = NOW()\n   WHERE id = p_contract_id;\n\n  BEGIN\n    INSERT INTO contract_terminations (\n      user_id, contract_id, termination_date, actual_move_out_date,\n      termination_type,\n      outstanding_debt, early_termination_fee, prorated_rent, prorated_days, prorated_services,\n      total_deposit, status, approved_by, approved_at, notes\n    ) VALUES (\n      v_contract.user_id, p_contract_id, p_forfeit_date, p_forfeit_date,\n      ''FORFEIT'',\n      0, v_deposit, 0, 0, 0,\n      v_deposit, ''COMPLETED'', auth.uid(), NOW(),\n      ''Khách bỏ cọc — đã tạo phiếu thu "Doanh thu bỏ cọc" (chờ duyệt) cho phần cọc thực thu '' || round(v_deposit)::bigint || ''đ.''\n        || CASE WHEN v_kept_paid > 0\n                  THEN '' Đã giữ lại '' || round(v_kept_paid)::bigint\n                       || ''đ đã thu làm doanh thu.''\n                  ELSE '''' END\n        || CASE WHEN v_extra > 0\n                  THEN '' Hoá đơn thu thêm riêng '' || round(v_extra)::bigint || ''đ (chờ thu).''\n                  ELSE '''' END\n    );\n  EXCEPTION WHEN OTHERS THEN\n    RAISE WARNING ''terminate_contract_forfeit_impl: audit insert failed for %: %'', p_contract_id, SQLERRM;\n  END;\n\n  RETURN jsonb_build_object(\n    ''contract_id'',                p_contract_id,\n    ''invoice_id'',                 v_invoice_id,\n    ''settlement_invoice_id'',      v_invoice_id,\n    ''extra_invoice_id'',           v_extra_inv,\n    ''extra_charges_total'',        v_extra,\n    ''forfeit_amount'',             v_deposit,\n    ''cancelled_invoices'',         v_cancelled_cnt,\n    ''kept_paid_amount'',           v_kept_paid,\n    ''pending_income_voucher_id'',  v_thu_id,\n    ''pending_expense_voucher_id'', v_chi_id,\n    ''acc_internal'',               v_acc_int\n  );\nEND;\n$function$\n');
  IF md5(definition) <> E'73be158a92b0c01871d6e03387e8a71c' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)'::regprocedure);
  IF md5(definition) = E'7ff469cae791132bd43022177add0713' THEN RETURN; END IF;
  IF md5(definition) <> E'6b5d7e0ce200868ee63dacfb53c1e9a6' THEN RAISE EXCEPTION 'Live function changed: %',E'public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)'; END IF;
  definition := replace(definition,E'CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_impl(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric DEFAULT 0, p_penalty_fee numeric DEFAULT 0, p_excess_rent numeric DEFAULT 0, p_outstanding_debt numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_extra_charges jsonb DEFAULT ''[]''::jsonb, p_shortfall_mode text DEFAULT ''PAID''::text, p_receipt_account_id uuid DEFAULT NULL::uuid, p_refund_items jsonb DEFAULT ''[]''::jsonb)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''public''\nAS $function$\nDECLARE\n  v_contract  RECORD;\n  v_building  uuid;\n  v_acc_op    uuid;   -- sổ vận hành (fallback nhận tiền thật)\n  v_acc_int   uuid;   -- sổ bút toán nội bộ (cả 2 chân cấn cọc)\n  v_acc_rcpt  uuid;   -- sổ NHẬN "khách trả thêm" (tiền thật)\n  v_billing   text;\n  v_cnumber   text;\n  v_deposit   numeric(15,2);\n  v_penalty   numeric(15,2) := COALESCE(p_penalty_fee,    0);\n  v_excess    numeric(15,2) := COALESCE(p_excess_rent,    0);\n  v_debt      numeric(15,2) := COALESCE(p_outstanding_debt, 0);\n  v_extra     numeric(15,2) := 0;\n  v_owed      numeric(15,2) := 0;   -- tổng "Hoàn lại khách" (mình nợ khách)\n  v_charges_left numeric(15,2);\n  v_owed_applied numeric(15,2);\n  v_refund_owed  numeric(15,2);\n  v_type_rentref uuid;\n  v_charges   numeric(15,2);\n  v_pool      numeric(15,2);\n  v_applied   numeric(15,2);\n  v_applied_dep numeric(15,2);\n  v_refund_dep  numeric(15,2);\n  v_refund_exc  numeric(15,2);\n  v_S         numeric(15,2);\n  v_budget    numeric(15,2);\n  v_pay       numeric(15,2);\n  v_settle_inv uuid;\n  v_next_sort integer;\n  v_type_inc  uuid;\n  v_type_off  uuid;\n  v_type_dep  uuid;\n  v_type_excr uuid;\n  v_voucher   uuid;\n  v_refund_voucher uuid;\n  v_breakdown text;\n  rec         RECORD;\nBEGIN\n  IF p_shortfall_mode NOT IN (''PAID'', ''DEBT'') THEN\n    RAISE EXCEPTION ''p_shortfall_mode phải là PAID hoặc DEBT'';\n  END IF;\n\n  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL FOR UPDATE;\n  IF NOT FOUND THEN RAISE EXCEPTION ''Hợp đồng không tồn tại''; END IF;\n  IF v_contract.status IN (''TERMINATED'',''EXPIRED'') THEN RAISE EXCEPTION ''Hợp đồng đã thanh lý/hết hạn''; END IF;\n  IF v_contract.room_id IS NULL THEN RAISE EXCEPTION ''Hợp đồng chưa gán phòng — không thể thanh lý''; END IF;\n  IF p_move_out_date < v_contract.start_date THEN\n    RAISE EXCEPTION ''Ngày chuyển đi (%) không được trước ngày bắt đầu hợp đồng (%)'',\n      to_char(p_move_out_date,''DD/MM/YYYY''), to_char(v_contract.start_date,''DD/MM/YYYY'');\n  END IF;\n  SELECT building_id INTO v_building FROM rooms WHERE id = v_contract.room_id;\n  IF v_building IS NULL THEN RAISE EXCEPTION ''Không xác định được toà nhà của hợp đồng''; END IF;\n\n  v_billing := to_char(COALESCE(p_move_out_date, public.org_today_v1(NULL)), ''YYYY-MM'');\n  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);\n  v_acc_op  := public._termination_pick_account(v_contract.user_id, v_building);\n  v_acc_int := public._internal_settlement_account(v_contract.user_id);\n\n  -- Sổ NHẬN "khách trả thêm" (tiền thật): form chọn > sổ %Thu của người bấm > sổ vận hành toà.\n  v_acc_rcpt := COALESCE(p_receipt_account_id, public._collector_thu_account(auth.uid()), v_acc_op);\n  IF p_receipt_account_id IS NOT NULL THEN\n    PERFORM 1 FROM accounts a WHERE a.id = p_receipt_account_id AND a.deleted_at IS NULL AND a.is_virtual = false;\n    IF NOT FOUND THEN\n      RAISE EXCEPTION ''Sổ nhận tiền không hợp lệ (không tồn tại hoặc là sổ ảo)'';\n    END IF;\n  END IF;\n\n  -- A1: hoàn/cấn cọc tối đa bằng cọc THỰC THU (deposit_paid).\n  v_deposit := LEAST(GREATEST(COALESCE(p_deposit_refund, 0), 0), COALESCE(v_contract.deposit_paid, 0));\n\n  IF jsonb_typeof(COALESCE(p_extra_charges, ''[]''::jsonb)) = ''array'' THEN\n    SELECT COALESCE(SUM((j->>''amount'')::numeric), 0) INTO v_extra\n      FROM jsonb_array_elements(p_extra_charges) AS t(j)\n     WHERE (j->>''amount'') IS NOT NULL AND (j->>''amount'') <> ''''\n       AND (j->>''amount'')::numeric > 0;\n  END IF;\n\n  IF jsonb_typeof(COALESCE(p_refund_items, ''[]''::jsonb)) = ''array'' THEN\n    SELECT COALESCE(SUM((j->>''amount'')::numeric), 0) INTO v_owed\n      FROM jsonb_array_elements(p_refund_items) AS t(j)\n     WHERE (j->>''amount'') IS NOT NULL AND (j->>''amount'') <> ''''\n       AND (j->>''amount'')::numeric > 0;\n  END IF;\n\n  v_charges     := v_debt + v_penalty + v_extra;\n  v_pool        := v_deposit + v_excess;\n  v_applied     := LEAST(v_pool + v_owed, v_charges);\n  v_applied_dep := LEAST(v_deposit, v_charges);\n  v_refund_dep  := v_deposit - v_applied_dep;\n  v_refund_exc  := v_excess - LEAST(v_excess, GREATEST(v_charges - v_deposit, 0));\n  -- "Hoàn lại khách" CHỈ được cấn vào phần công nợ CÒN LẠI sau khi cọc và credit\n  -- đã cấn xong. Cấn sớm hơn sẽ làm v_refund_dep xê dịch — mà con số đó phải\n  -- khớp cột GENERATED contract_terminations.refund_amount, nền của cảnh báo\n  -- VUOT_COC_THAT trong nghĩa vụ hoàn cọc (preview_termination_refund_v1).\n  v_charges_left := GREATEST(v_charges - v_deposit - v_excess, 0);\n  v_owed_applied := LEAST(v_owed, v_charges_left);\n  v_refund_owed  := v_owed - v_owed_applied;\n  v_S           := v_pool + v_owed - v_charges;\n\n  v_breakdown :=\n       ''QUYẾT TOÁN THANH LÝ '' || to_char(p_move_out_date,''DD/MM/YYYY'') || '' — HĐ '' || v_cnumber\n    || E''\\n• Cọc đã thu: '' || to_char(v_deposit, ''FM999G999G999G990'') || ''đ''\n    || E''\\n• Khấu trừ: công nợ '' || to_char(v_debt, ''FM999G999G999G990'') || ''đ''\n    || CASE WHEN v_penalty > 0 THEN '' + phí phạt '' || to_char(v_penalty, ''FM999G999G999G990'') || ''đ'' ELSE '''' END\n    || CASE WHEN v_extra   > 0 THEN '' + thu thêm '' || to_char(v_extra, ''FM999G999G999G990'') || ''đ'' ELSE '''' END\n    || '' = '' || to_char(v_charges, ''FM999G999G999G990'') || ''đ''\n    || E''\\n• Cọc cấn vào khấu trừ: '' || to_char(v_applied_dep, ''FM999G999G999G990'') || ''đ (bút toán nội bộ, không đụng sổ tiền thật)''\n    || CASE WHEN v_excess > 0 THEN E''\\n• Tiền thừa (credit) áp dụng: '' || to_char(v_excess, ''FM999G999G999G990'') || ''đ (cấn '' || to_char(v_excess - v_refund_exc, ''FM999G999G999G990'') || ''đ, hoàn '' || to_char(v_refund_exc, ''FM999G999G999G990'') || ''đ)'' ELSE '''' END\n    || CASE WHEN v_owed > 0 THEN E''\\n• Hoàn lại khách (tiền phòng ngày không ở…): '' || to_char(v_owed, ''FM999G999G999G990'') || ''đ (cấn '' || to_char(v_owed_applied, ''FM999G999G999G990'') || ''đ, chi '' || to_char(v_refund_owed, ''FM999G999G999G990'') || ''đ)'' ELSE '''' END\n    || E''\\n• Hoàn cọc lại khách: '' || to_char(v_refund_dep, ''FM999G999G999G990'') || ''đ''\n    || CASE WHEN v_S < 0 THEN E''\\n• Khách còn phải trả: '' || to_char(-v_S, ''FM999G999G999G990'') || ''đ (''\n         || CASE WHEN p_shortfall_mode = ''PAID'' THEN ''đã thu ngay khi thanh lý'' ELSE ''GHI NỢ — chờ thu'' END || '')''\n       ELSE '''' END\n    || CASE WHEN v_refund_dep + v_refund_exc + v_refund_owed > 0 THEN E''\\n• Tổng chi hoàn khách: '' || to_char(v_refund_dep + v_refund_exc + v_refund_owed, ''FM999G999G999G990'') || ''đ (phiếu chi chờ duyệt — chọn sổ quỹ khi duyệt)'' ELSE '''' END;\n\n  -- 1. HOÁ ĐƠN THANH LÝ RIÊNG (kind=''SETTLEMENT'', ĐÚNG kỳ tháng trả phòng).\n  --    v4: KHÔNG đụng hoá đơn tháng nữa — dù nó chưa/đã PAID. Công nợ của nó\n  --    vẫn được gạch ở bước 2 bằng payments ''CT'' (không sửa nội dung hoá đơn).\n  IF v_penalty > 0 OR v_extra > 0 THEN\n    INSERT INTO invoices (user_id, contract_id, building_id, room_id, kind, billing_month, issue_date, due_date, status, subtotal, total_amount, notes)\n    VALUES (v_contract.user_id, p_contract_id, v_building, v_contract.room_id, ''SETTLEMENT'',\n      v_billing, p_move_out_date, p_move_out_date, ''APPROVED''::invoice_status, 0, 0,\n      ''Hoá đơn thanh lý — khách rời phòng ngày '' || to_char(p_move_out_date,''DD/MM/YYYY'') || COALESCE(E''\\n'' || p_notes, ''''))\n    RETURNING id INTO v_settle_inv;\n  END IF;\n\n  IF v_penalty > 0 THEN\n    SELECT COALESCE(MAX(sort_order),0)+1 INTO v_next_sort FROM invoice_items WHERE invoice_id = v_settle_inv;\n    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)\n    VALUES (v_settle_inv, ''PENALTY'', ''Phí phạt thanh lý'', v_penalty, 1, 1, v_penalty, v_next_sort);\n    UPDATE invoices SET subtotal = COALESCE(subtotal,0)+v_penalty, total_amount = COALESCE(total_amount,0)+v_penalty, updated_at = NOW() WHERE id = v_settle_inv;\n  END IF;\n\n  IF v_extra > 0 THEN\n    PERFORM public._termination_apply_extra_charges(v_settle_inv, p_extra_charges, p_move_out_date, v_contract.user_id, p_contract_id);\n  END IF;\n\n  IF v_settle_inv IS NOT NULL THEN\n    UPDATE invoices\n       SET notes = COALESCE(notes || E''\\n\\n'', '''') || v_breakdown,\n           updated_at = NOW()\n     WHERE id = v_settle_inv;\n  END IF;\n\n  -- 2. Quyết toán hoá đơn còn nợ bằng CẤN TRỪ ''CT'' (PAID: gạch hết; DEBT: trong pool).\n  v_budget := CASE WHEN p_shortfall_mode = ''DEBT'' THEN v_applied ELSE NULL END;\n  FOR rec IN\n    SELECT id, (total_amount - paid_amount) AS remaining FROM invoices\n     WHERE contract_id = p_contract_id AND deleted_at IS NULL AND status <> ''CANCELLED''\n       AND (total_amount - paid_amount) > 0\n     ORDER BY billing_month, created_at\n  LOOP\n    v_pay := rec.remaining;\n    IF v_budget IS NOT NULL THEN\n      EXIT WHEN v_budget <= 0;\n      v_pay := LEAST(v_pay, v_budget);\n      v_budget := v_budget - v_pay;\n    END IF;\n    IF v_pay > 0 THEN\n      INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)\n      VALUES (v_contract.user_id, rec.id, v_pay, ''CT''::payment_method, p_move_out_date,\n              ''Quyết toán khi thanh lý '' || to_char(p_move_out_date,''DD/MM/YYYY''));\n    END IF;\n  END LOOP;\n\n  -- 3. CẶP BÚT TOÁN NỘI BỘ (cấn cọc → doanh thu) — CẢ 2 CHÂN trên sổ nội bộ,\n  --    net 0/thương vụ; KHÔNG đụng sổ tiền thật (mô hình chốt 04/07).\n  IF v_applied_dep > 0 THEN\n    v_type_off := public._termination_ensure_type(v_contract.user_id, ''expense'', ''Cấn cọc chuyển doanh thu'');\n    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;\n    v_type_inc := public._termination_ensure_type(v_contract.user_id, ''income'', ''Doanh thu thanh lý'');\n    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;\n\n    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)\n    VALUES (v_contract.user_id, ''EXPENSE'', ''Cấn cọc → chuyển doanh thu — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_applied_dep, ''APPROVED'',\n      ''[CHUYỂN KHOẢN] Bút toán nội bộ: cọc cấn công nợ/phạt (không phải tiền thật).'' || E''\\n\\n'' || v_breakdown,\n      ''termination.offset'')\n    RETURNING id INTO v_voucher;\n    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n    VALUES (v_voucher, v_type_off, ''Cấn cọc chuyển doanh thu'', 1, v_applied_dep, p_move_out_date, p_move_out_date);\n\n    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)\n    VALUES (v_contract.user_id, ''INCOME'', ''Doanh thu thanh lý — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_applied_dep, ''APPROVED'',\n      ''[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu thanh lý từ cọc cấn nợ/phạt (KQKD đếm theo hạng mục).'',\n      ''termination.revenue'')\n    RETURNING id INTO v_voucher;\n    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n    VALUES (v_voucher, v_type_inc, ''Doanh thu thanh lý (cấn cọc)'', 1, v_applied_dep, p_move_out_date, p_move_out_date);\n  END IF;\n\n  -- 3b. KHOẢN HOÀN BỊ CẤN VÀO CÔNG NỢ — cặp bút toán nội bộ, net 0 trên sổ nội\n  --     bộ, KHÔNG đụng sổ tiền thật. Gương của cặp cấn cọc ở bước 3, khác ở chỗ\n  --     chân chi mang loại is_deposit=FALSE: tiền phòng đã ghi doanh thu rồi nên\n  --     trả lại là GIẢM LÃI THẬT, còn cọc là tiền giữ hộ nên nằm ngoài KQKD.\n  IF v_owed_applied > 0 THEN\n    v_type_rentref := public._termination_ensure_type(v_contract.user_id, ''expense'', ''Hoàn tiền phòng thanh lý'');\n    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_rentref AND is_deposit IS DISTINCT FROM FALSE;\n    v_type_inc := public._termination_ensure_type(v_contract.user_id, ''income'', ''Doanh thu thanh lý'');\n    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;\n\n    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)\n    VALUES (v_contract.user_id, ''EXPENSE'', ''Hoàn tiền phòng cấn công nợ — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_owed_applied, ''APPROVED'',\n      ''[CHUYỂN KHOẢN] Bút toán nội bộ: khoản hoàn cho khách được cấn vào công nợ còn lại (không phải tiền thật).'' || E''\\n\\n'' || v_breakdown,\n      ''termination.rent_refund_offset'')\n    RETURNING id INTO v_voucher;\n    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n    VALUES (v_voucher, v_type_rentref, ''Hoàn tiền phòng (cấn công nợ)'', 1, v_owed_applied, p_move_out_date, p_move_out_date);\n\n    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)\n    VALUES (v_contract.user_id, ''INCOME'', ''Doanh thu thanh lý (khoản hoàn cấn nợ) — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_owed_applied, ''APPROVED'',\n      ''[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu từ phần công nợ được khoản hoàn cấn trừ.'',\n      ''termination.rent_refund_revenue'')\n    RETURNING id INTO v_voucher;\n    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n    VALUES (v_voucher, v_type_inc, ''Doanh thu thanh lý (khoản hoàn cấn nợ)'', 1, v_owed_applied, p_move_out_date, p_move_out_date);\n  END IF;\n\n  -- 4. HOÀN KHÁCH = TIỀN THẬT: 1 phiếu chi NHÁP, SỔ TRỐNG (chọn khi duyệt).\n  IF v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN\n    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)\n    VALUES (v_contract.user_id, ''EXPENSE'', COALESCE(app_private.termination_refund_name_v1(p_contract_id, p_move_out_date), ''Trả khách thanh lý — HĐ '' || v_cnumber), v_building, v_contract.room_id, p_contract_id, NULL, p_move_out_date, v_refund_dep + v_refund_exc + v_refund_owed, ''UNAPPROVED'',\n      ''[HOÀN KHÁCH THANH LÝ] Phiếu chi hoàn khách (tiền thật). CHỌN SỔ QUỸ chi tiền (Sửa phiếu) rồi mới duyệt được.'' || E''\\n\\n'' || v_breakdown || COALESCE(E''\\n'' || p_notes, ''''),\n      ''termination.refund'')\n    RETURNING id INTO v_refund_voucher;\n\n    IF v_refund_dep > 0 THEN\n      v_type_dep := public._termination_ensure_type(v_contract.user_id, ''expense'', ''Hoàn cọc thanh lý'');\n      UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type_dep AND is_deposit IS DISTINCT FROM TRUE;\n      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n      VALUES (v_refund_voucher, v_type_dep, ''Trả lại khách (cọc sau khấu trừ)'', 1, v_refund_dep, p_move_out_date, p_move_out_date);\n    END IF;\n\n    IF v_refund_exc > 0 THEN\n      v_type_excr := public._termination_ensure_type(v_contract.user_id, ''expense'', ''Hoàn tiền thừa thanh lý'');\n      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_excr AND is_deposit IS DISTINCT FROM FALSE;\n      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n      VALUES (v_refund_voucher, v_type_excr, ''Hoàn tiền thừa khi thanh lý'', 1, v_refund_exc, p_move_out_date, p_move_out_date);\n    END IF;\n\n    IF v_refund_owed > 0 THEN\n      v_type_rentref := public._termination_ensure_type(v_contract.user_id, ''expense'', ''Hoàn tiền phòng thanh lý'');\n      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_rentref AND is_deposit IS DISTINCT FROM FALSE;\n      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n      VALUES (v_refund_voucher, v_type_rentref, ''Hoàn tiền phòng ngày khách không ở'', 1, v_refund_owed, p_move_out_date, p_move_out_date);\n    END IF;\n  END IF;\n\n  -- 4c. Khách trả thêm (TIỀN THẬT) — chế độ PAID: vào SỔ NHẬN đã chọn.\n  IF v_S < 0 AND p_shortfall_mode = ''PAID'' THEN\n    v_type_inc := public._termination_ensure_type(v_contract.user_id, ''income'', ''Thu thanh lý (khách trả thêm)'');\n    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;\n    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)\n    VALUES (v_contract.user_id, ''INCOME'', ''Khách trả thêm khi thanh lý — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_rcpt, v_settle_inv, p_move_out_date, -v_S, ''APPROVED'',\n      ''Khách trả thêm phần công nợ vượt tiền cọc khi thanh lý (tiền thật vào sổ nhận).'' || COALESCE(E''\\n'' || p_notes, ''''),\n      ''termination.extra_receipt'')\n    RETURNING id INTO v_voucher;\n    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n    VALUES (v_voucher, v_type_inc, ''Khách trả thêm khi thanh lý'', 1, -v_S, p_move_out_date, p_move_out_date);\n  END IF;\n\n  -- 5. Recompute hoá đơn quyết toán.\n  IF v_settle_inv IS NOT NULL THEN PERFORM public.recompute_invoice_for_id(v_settle_inv); END IF;\n\n  -- 6. Thanh lý hợp đồng (ghi chú kèm bản quyết toán đầy đủ).\n  UPDATE contracts\n     SET status = ''TERMINATED'', actual_end_date = p_move_out_date,\n         notes = CASE WHEN notes IS NULL OR length(btrim(notes)) = 0\n                        THEN ''[Thanh lý '' || to_char(p_move_out_date,''DD/MM/YYYY'') || '']'' || COALESCE(E''\\n'' || p_notes, '''') || E''\\n'' || v_breakdown\n                        ELSE notes || E''\\n[Thanh lý '' || to_char(p_move_out_date,''DD/MM/YYYY'') || '']'' || COALESCE(E''\\n'' || p_notes, '''') || E''\\n'' || v_breakdown END,\n         updated_at = NOW()\n   WHERE id = p_contract_id;\n\n  -- 7. Audit.\n  BEGIN\n    INSERT INTO contract_terminations (\n      user_id, contract_id, termination_date, actual_move_out_date, termination_type,\n      outstanding_debt, early_termination_fee, prorated_rent, prorated_days, prorated_services,\n      total_deposit, rent_refund_amount, refund_method, status, approved_by, approved_at, notes)\n    VALUES (\n      v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date, ''NORMAL'',\n      v_debt, v_penalty + v_extra, 0, 0, 0,\n      v_deposit, v_owed,\n      CASE WHEN v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN ''TM''::payment_method ELSE NULL END,\n      ''COMPLETED'', auth.uid(), NOW(),\n      COALESCE(p_notes || E''\\n'', '''') || v_breakdown);\n  EXCEPTION WHEN OTHERS THEN\n    RAISE WARNING ''terminate_contract_move_out_impl: audit insert failed for %: %'', p_contract_id, SQLERRM;\n  END;\n\n  RETURN jsonb_build_object(\n    ''contract_id'', p_contract_id, ''settlement_invoice_id'', v_settle_inv,\n    ''charges'', v_charges, ''extra_charges_total'', v_extra,\n    ''applied'', v_applied, ''applied_deposit'', v_applied_dep,\n    ''refund_deposit'', v_refund_dep, ''refund_excess'', v_refund_exc,\n    ''customer_refund_total'', v_owed, ''customer_refund_applied'', v_owed_applied,\n    ''refund_customer'', v_refund_owed,\n    ''refund_voucher_id'', v_refund_voucher,\n    ''net_settlement'', v_S, ''shortfall_mode'', p_shortfall_mode,\n    ''receipt_account_id'', CASE WHEN v_S < 0 AND p_shortfall_mode = ''PAID'' THEN v_acc_rcpt END,\n    ''acc_op'', v_acc_op, ''acc_internal'', v_acc_int\n  );\nEND $function$\n',E'CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_impl(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric DEFAULT 0, p_penalty_fee numeric DEFAULT 0, p_excess_rent numeric DEFAULT 0, p_outstanding_debt numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_extra_charges jsonb DEFAULT ''[]''::jsonb, p_shortfall_mode text DEFAULT ''PAID''::text, p_receipt_account_id uuid DEFAULT NULL::uuid, p_refund_items jsonb DEFAULT ''[]''::jsonb)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''public''\nAS $function$\nDECLARE\n  v_contract  RECORD;\n  v_building  uuid;\n  v_acc_op    uuid;   -- sổ vận hành (fallback nhận tiền thật)\n  v_acc_int   uuid;   -- sổ bút toán nội bộ (cả 2 chân cấn cọc)\n  v_acc_rcpt  uuid;   -- sổ NHẬN "khách trả thêm" (tiền thật)\n  v_billing   text;\n  v_cnumber   text;\n  v_deposit   numeric(15,2);\n  v_penalty   numeric(15,2) := COALESCE(p_penalty_fee,    0);\n  v_excess    numeric(15,2) := COALESCE(p_excess_rent,    0);\n  v_debt      numeric(15,2) := COALESCE(p_outstanding_debt, 0);\n  v_extra     numeric(15,2) := 0;\n  v_owed      numeric(15,2) := 0;   -- tổng "Hoàn lại khách" (mình nợ khách)\n  v_charges_left numeric(15,2);\n  v_owed_applied numeric(15,2);\n  v_refund_owed  numeric(15,2);\n  v_type_rentref uuid;\n  v_charges   numeric(15,2);\n  v_pool      numeric(15,2);\n  v_applied   numeric(15,2);\n  v_applied_dep numeric(15,2);\n  v_refund_dep  numeric(15,2);\n  v_refund_exc  numeric(15,2);\n  v_S         numeric(15,2);\n  v_budget    numeric(15,2);\n  v_pay       numeric(15,2);\n  v_settle_inv uuid;\n  v_next_sort integer;\n  v_type_inc  uuid;\n  v_type_off  uuid;\n  v_type_dep  uuid;\n  v_type_excr uuid;\n  v_voucher   uuid;\n  v_refund_voucher uuid;\n  v_breakdown text;\n  rec         RECORD;\nBEGIN\n  IF p_shortfall_mode NOT IN (''PAID'', ''DEBT'') THEN\n    RAISE EXCEPTION ''p_shortfall_mode phải là PAID hoặc DEBT'';\n  END IF;\n\n  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL FOR UPDATE;\n  IF NOT FOUND THEN RAISE EXCEPTION ''Hợp đồng không tồn tại''; END IF;\n  IF v_contract.status IN (''TERMINATED'',''EXPIRED'') THEN RAISE EXCEPTION ''Hợp đồng đã thanh lý/hết hạn''; END IF;\n  IF v_contract.room_id IS NULL THEN RAISE EXCEPTION ''Hợp đồng chưa gán phòng — không thể thanh lý''; END IF;\n  IF p_move_out_date < v_contract.start_date THEN\n    RAISE EXCEPTION ''Ngày chuyển đi (%) không được trước ngày bắt đầu hợp đồng (%)'',\n      to_char(p_move_out_date,''DD/MM/YYYY''), to_char(v_contract.start_date,''DD/MM/YYYY'');\n  END IF;\n  SELECT building_id INTO v_building FROM rooms WHERE id = v_contract.room_id;\n  IF v_building IS NULL THEN RAISE EXCEPTION ''Không xác định được toà nhà của hợp đồng''; END IF;\n\n  v_billing := to_char(COALESCE(p_move_out_date, public.org_today_v1(NULL)), ''YYYY-MM'');\n  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);\n  v_acc_op  := public._termination_pick_account(v_contract.user_id, v_building);\n  v_acc_int := app_private.internal_settlement_account_in_org_v1(v_contract.user_id,v_contract.organization_id);\n\n  -- Sổ NHẬN "khách trả thêm" (tiền thật): form chọn > sổ %Thu của người bấm > sổ vận hành toà.\n  v_acc_rcpt := COALESCE(p_receipt_account_id, public._collector_thu_account(auth.uid()), v_acc_op);\n  IF p_receipt_account_id IS NOT NULL THEN\n    PERFORM 1 FROM accounts a WHERE a.id = p_receipt_account_id AND a.deleted_at IS NULL AND a.is_virtual = false;\n    IF NOT FOUND THEN\n      RAISE EXCEPTION ''Sổ nhận tiền không hợp lệ (không tồn tại hoặc là sổ ảo)'';\n    END IF;\n  END IF;\n\n  -- A1: hoàn/cấn cọc tối đa bằng cọc THỰC THU (deposit_paid).\n  v_deposit := LEAST(GREATEST(COALESCE(p_deposit_refund, 0), 0), COALESCE(v_contract.deposit_paid, 0));\n\n  IF jsonb_typeof(COALESCE(p_extra_charges, ''[]''::jsonb)) = ''array'' THEN\n    SELECT COALESCE(SUM((j->>''amount'')::numeric), 0) INTO v_extra\n      FROM jsonb_array_elements(p_extra_charges) AS t(j)\n     WHERE (j->>''amount'') IS NOT NULL AND (j->>''amount'') <> ''''\n       AND (j->>''amount'')::numeric > 0;\n  END IF;\n\n  IF jsonb_typeof(COALESCE(p_refund_items, ''[]''::jsonb)) = ''array'' THEN\n    SELECT COALESCE(SUM((j->>''amount'')::numeric), 0) INTO v_owed\n      FROM jsonb_array_elements(p_refund_items) AS t(j)\n     WHERE (j->>''amount'') IS NOT NULL AND (j->>''amount'') <> ''''\n       AND (j->>''amount'')::numeric > 0;\n  END IF;\n\n  v_charges     := v_debt + v_penalty + v_extra;\n  v_pool        := v_deposit + v_excess;\n  v_applied     := LEAST(v_pool + v_owed, v_charges);\n  v_applied_dep := LEAST(v_deposit, v_charges);\n  v_refund_dep  := v_deposit - v_applied_dep;\n  v_refund_exc  := v_excess - LEAST(v_excess, GREATEST(v_charges - v_deposit, 0));\n  -- "Hoàn lại khách" CHỈ được cấn vào phần công nợ CÒN LẠI sau khi cọc và credit\n  -- đã cấn xong. Cấn sớm hơn sẽ làm v_refund_dep xê dịch — mà con số đó phải\n  -- khớp cột GENERATED contract_terminations.refund_amount, nền của cảnh báo\n  -- VUOT_COC_THAT trong nghĩa vụ hoàn cọc (preview_termination_refund_v1).\n  v_charges_left := GREATEST(v_charges - v_deposit - v_excess, 0);\n  v_owed_applied := LEAST(v_owed, v_charges_left);\n  v_refund_owed  := v_owed - v_owed_applied;\n  v_S           := v_pool + v_owed - v_charges;\n\n  v_breakdown :=\n       ''QUYẾT TOÁN THANH LÝ '' || to_char(p_move_out_date,''DD/MM/YYYY'') || '' — HĐ '' || v_cnumber\n    || E''\\n• Cọc đã thu: '' || to_char(v_deposit, ''FM999G999G999G990'') || ''đ''\n    || E''\\n• Khấu trừ: công nợ '' || to_char(v_debt, ''FM999G999G999G990'') || ''đ''\n    || CASE WHEN v_penalty > 0 THEN '' + phí phạt '' || to_char(v_penalty, ''FM999G999G999G990'') || ''đ'' ELSE '''' END\n    || CASE WHEN v_extra   > 0 THEN '' + thu thêm '' || to_char(v_extra, ''FM999G999G999G990'') || ''đ'' ELSE '''' END\n    || '' = '' || to_char(v_charges, ''FM999G999G999G990'') || ''đ''\n    || E''\\n• Cọc cấn vào khấu trừ: '' || to_char(v_applied_dep, ''FM999G999G999G990'') || ''đ (bút toán nội bộ, không đụng sổ tiền thật)''\n    || CASE WHEN v_excess > 0 THEN E''\\n• Tiền thừa (credit) áp dụng: '' || to_char(v_excess, ''FM999G999G999G990'') || ''đ (cấn '' || to_char(v_excess - v_refund_exc, ''FM999G999G999G990'') || ''đ, hoàn '' || to_char(v_refund_exc, ''FM999G999G999G990'') || ''đ)'' ELSE '''' END\n    || CASE WHEN v_owed > 0 THEN E''\\n• Hoàn lại khách (tiền phòng ngày không ở…): '' || to_char(v_owed, ''FM999G999G999G990'') || ''đ (cấn '' || to_char(v_owed_applied, ''FM999G999G999G990'') || ''đ, chi '' || to_char(v_refund_owed, ''FM999G999G999G990'') || ''đ)'' ELSE '''' END\n    || E''\\n• Hoàn cọc lại khách: '' || to_char(v_refund_dep, ''FM999G999G999G990'') || ''đ''\n    || CASE WHEN v_S < 0 THEN E''\\n• Khách còn phải trả: '' || to_char(-v_S, ''FM999G999G999G990'') || ''đ (''\n         || CASE WHEN p_shortfall_mode = ''PAID'' THEN ''đã thu ngay khi thanh lý'' ELSE ''GHI NỢ — chờ thu'' END || '')''\n       ELSE '''' END\n    || CASE WHEN v_refund_dep + v_refund_exc + v_refund_owed > 0 THEN E''\\n• Tổng chi hoàn khách: '' || to_char(v_refund_dep + v_refund_exc + v_refund_owed, ''FM999G999G999G990'') || ''đ (phiếu chi chờ duyệt — chọn sổ quỹ khi duyệt)'' ELSE '''' END;\n\n  -- 1. HOÁ ĐƠN THANH LÝ RIÊNG (kind=''SETTLEMENT'', ĐÚNG kỳ tháng trả phòng).\n  --    v4: KHÔNG đụng hoá đơn tháng nữa — dù nó chưa/đã PAID. Công nợ của nó\n  --    vẫn được gạch ở bước 2 bằng payments ''CT'' (không sửa nội dung hoá đơn).\n  IF v_penalty > 0 OR v_extra > 0 THEN\n    INSERT INTO invoices (user_id, contract_id, building_id, room_id, kind, billing_month, issue_date, due_date, status, subtotal, total_amount, notes)\n    VALUES (v_contract.user_id, p_contract_id, v_building, v_contract.room_id, ''SETTLEMENT'',\n      v_billing, p_move_out_date, p_move_out_date, ''APPROVED''::invoice_status, 0, 0,\n      ''Hoá đơn thanh lý — khách rời phòng ngày '' || to_char(p_move_out_date,''DD/MM/YYYY'') || COALESCE(E''\\n'' || p_notes, ''''))\n    RETURNING id INTO v_settle_inv;\n  END IF;\n\n  IF v_penalty > 0 THEN\n    SELECT COALESCE(MAX(sort_order),0)+1 INTO v_next_sort FROM invoice_items WHERE invoice_id = v_settle_inv;\n    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)\n    VALUES (v_settle_inv, ''PENALTY'', ''Phí phạt thanh lý'', v_penalty, 1, 1, v_penalty, v_next_sort);\n    UPDATE invoices SET subtotal = COALESCE(subtotal,0)+v_penalty, total_amount = COALESCE(total_amount,0)+v_penalty, updated_at = NOW() WHERE id = v_settle_inv;\n  END IF;\n\n  IF v_extra > 0 THEN\n    PERFORM public._termination_apply_extra_charges(v_settle_inv, p_extra_charges, p_move_out_date, v_contract.user_id, p_contract_id);\n  END IF;\n\n  IF v_settle_inv IS NOT NULL THEN\n    UPDATE invoices\n       SET notes = COALESCE(notes || E''\\n\\n'', '''') || v_breakdown,\n           updated_at = NOW()\n     WHERE id = v_settle_inv;\n  END IF;\n\n  -- 2. Quyết toán hoá đơn còn nợ bằng CẤN TRỪ ''CT'' (PAID: gạch hết; DEBT: trong pool).\n  v_budget := CASE WHEN p_shortfall_mode = ''DEBT'' THEN v_applied ELSE NULL END;\n  FOR rec IN\n    SELECT id, (total_amount - paid_amount) AS remaining FROM invoices\n     WHERE contract_id = p_contract_id AND deleted_at IS NULL AND status <> ''CANCELLED''\n       AND (total_amount - paid_amount) > 0\n     ORDER BY billing_month, created_at\n  LOOP\n    v_pay := rec.remaining;\n    IF v_budget IS NOT NULL THEN\n      EXIT WHEN v_budget <= 0;\n      v_pay := LEAST(v_pay, v_budget);\n      v_budget := v_budget - v_pay;\n    END IF;\n    IF v_pay > 0 THEN\n      INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)\n      VALUES (v_contract.user_id, rec.id, v_pay, ''CT''::payment_method, p_move_out_date,\n              ''Quyết toán khi thanh lý '' || to_char(p_move_out_date,''DD/MM/YYYY''));\n    END IF;\n  END LOOP;\n\n  -- 3. CẶP BÚT TOÁN NỘI BỘ (cấn cọc → doanh thu) — CẢ 2 CHÂN trên sổ nội bộ,\n  --    net 0/thương vụ; KHÔNG đụng sổ tiền thật (mô hình chốt 04/07).\n  IF v_applied_dep > 0 THEN\n    v_type_off := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''expense'', ''Cấn cọc chuyển doanh thu'',v_contract.organization_id);\n    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;\n    v_type_inc := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''income'', ''Doanh thu thanh lý'',v_contract.organization_id);\n    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;\n\n    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)\n    VALUES (v_contract.user_id, ''EXPENSE'', ''Cấn cọc → chuyển doanh thu — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_applied_dep, ''APPROVED'',\n      ''[CHUYỂN KHOẢN] Bút toán nội bộ: cọc cấn công nợ/phạt (không phải tiền thật).'' || E''\\n\\n'' || v_breakdown,\n      ''termination.offset'')\n    RETURNING id INTO v_voucher;\n    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n    VALUES (v_voucher, v_type_off, ''Cấn cọc chuyển doanh thu'', 1, v_applied_dep, p_move_out_date, p_move_out_date);\n\n    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)\n    VALUES (v_contract.user_id, ''INCOME'', ''Doanh thu thanh lý — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_applied_dep, ''APPROVED'',\n      ''[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu thanh lý từ cọc cấn nợ/phạt (KQKD đếm theo hạng mục).'',\n      ''termination.revenue'')\n    RETURNING id INTO v_voucher;\n    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n    VALUES (v_voucher, v_type_inc, ''Doanh thu thanh lý (cấn cọc)'', 1, v_applied_dep, p_move_out_date, p_move_out_date);\n  END IF;\n\n  -- 3b. KHOẢN HOÀN BỊ CẤN VÀO CÔNG NỢ — cặp bút toán nội bộ, net 0 trên sổ nội\n  --     bộ, KHÔNG đụng sổ tiền thật. Gương của cặp cấn cọc ở bước 3, khác ở chỗ\n  --     chân chi mang loại is_deposit=FALSE: tiền phòng đã ghi doanh thu rồi nên\n  --     trả lại là GIẢM LÃI THẬT, còn cọc là tiền giữ hộ nên nằm ngoài KQKD.\n  IF v_owed_applied > 0 THEN\n    v_type_rentref := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''expense'', ''Hoàn tiền phòng thanh lý'',v_contract.organization_id);\n    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_rentref AND is_deposit IS DISTINCT FROM FALSE;\n    v_type_inc := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''income'', ''Doanh thu thanh lý'',v_contract.organization_id);\n    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;\n\n    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)\n    VALUES (v_contract.user_id, ''EXPENSE'', ''Hoàn tiền phòng cấn công nợ — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_owed_applied, ''APPROVED'',\n      ''[CHUYỂN KHOẢN] Bút toán nội bộ: khoản hoàn cho khách được cấn vào công nợ còn lại (không phải tiền thật).'' || E''\\n\\n'' || v_breakdown,\n      ''termination.rent_refund_offset'')\n    RETURNING id INTO v_voucher;\n    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n    VALUES (v_voucher, v_type_rentref, ''Hoàn tiền phòng (cấn công nợ)'', 1, v_owed_applied, p_move_out_date, p_move_out_date);\n\n    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)\n    VALUES (v_contract.user_id, ''INCOME'', ''Doanh thu thanh lý (khoản hoàn cấn nợ) — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_owed_applied, ''APPROVED'',\n      ''[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu từ phần công nợ được khoản hoàn cấn trừ.'',\n      ''termination.rent_refund_revenue'')\n    RETURNING id INTO v_voucher;\n    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n    VALUES (v_voucher, v_type_inc, ''Doanh thu thanh lý (khoản hoàn cấn nợ)'', 1, v_owed_applied, p_move_out_date, p_move_out_date);\n  END IF;\n\n  -- 4. HOÀN KHÁCH = TIỀN THẬT: 1 phiếu chi NHÁP, SỔ TRỐNG (chọn khi duyệt).\n  IF v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN\n    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)\n    VALUES (v_contract.user_id, ''EXPENSE'', COALESCE(app_private.termination_refund_name_v1(p_contract_id, p_move_out_date), ''Trả khách thanh lý — HĐ '' || v_cnumber), v_building, v_contract.room_id, p_contract_id, NULL, p_move_out_date, v_refund_dep + v_refund_exc + v_refund_owed, ''UNAPPROVED'',\n      ''[HOÀN KHÁCH THANH LÝ] Phiếu chi hoàn khách (tiền thật). CHỌN SỔ QUỸ chi tiền (Sửa phiếu) rồi mới duyệt được.'' || E''\\n\\n'' || v_breakdown || COALESCE(E''\\n'' || p_notes, ''''),\n      ''termination.refund'')\n    RETURNING id INTO v_refund_voucher;\n\n    IF v_refund_dep > 0 THEN\n      v_type_dep := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''expense'', ''Hoàn cọc thanh lý'',v_contract.organization_id);\n      UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type_dep AND is_deposit IS DISTINCT FROM TRUE;\n      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n      VALUES (v_refund_voucher, v_type_dep, ''Trả lại khách (cọc sau khấu trừ)'', 1, v_refund_dep, p_move_out_date, p_move_out_date);\n    END IF;\n\n    IF v_refund_exc > 0 THEN\n      v_type_excr := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''expense'', ''Hoàn tiền thừa thanh lý'',v_contract.organization_id);\n      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_excr AND is_deposit IS DISTINCT FROM FALSE;\n      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n      VALUES (v_refund_voucher, v_type_excr, ''Hoàn tiền thừa khi thanh lý'', 1, v_refund_exc, p_move_out_date, p_move_out_date);\n    END IF;\n\n    IF v_refund_owed > 0 THEN\n      v_type_rentref := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''expense'', ''Hoàn tiền phòng thanh lý'',v_contract.organization_id);\n      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_rentref AND is_deposit IS DISTINCT FROM FALSE;\n      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n      VALUES (v_refund_voucher, v_type_rentref, ''Hoàn tiền phòng ngày khách không ở'', 1, v_refund_owed, p_move_out_date, p_move_out_date);\n    END IF;\n  END IF;\n\n  -- 4c. Khách trả thêm (TIỀN THẬT) — chế độ PAID: vào SỔ NHẬN đã chọn.\n  IF v_S < 0 AND p_shortfall_mode = ''PAID'' THEN\n    v_type_inc := app_private.ensure_termination_type_in_org_v1(v_contract.user_id, ''income'', ''Thu thanh lý (khách trả thêm)'',v_contract.organization_id);\n    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;\n    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)\n    VALUES (v_contract.user_id, ''INCOME'', ''Khách trả thêm khi thanh lý — HĐ '' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_rcpt, v_settle_inv, p_move_out_date, -v_S, ''APPROVED'',\n      ''Khách trả thêm phần công nợ vượt tiền cọc khi thanh lý (tiền thật vào sổ nhận).'' || COALESCE(E''\\n'' || p_notes, ''''),\n      ''termination.extra_receipt'')\n    RETURNING id INTO v_voucher;\n    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n    VALUES (v_voucher, v_type_inc, ''Khách trả thêm khi thanh lý'', 1, -v_S, p_move_out_date, p_move_out_date);\n  END IF;\n\n  -- 5. Recompute hoá đơn quyết toán.\n  IF v_settle_inv IS NOT NULL THEN PERFORM public.recompute_invoice_for_id(v_settle_inv); END IF;\n\n  -- 6. Thanh lý hợp đồng (ghi chú kèm bản quyết toán đầy đủ).\n  UPDATE contracts\n     SET status = ''TERMINATED'', actual_end_date = p_move_out_date,\n         notes = CASE WHEN notes IS NULL OR length(btrim(notes)) = 0\n                        THEN ''[Thanh lý '' || to_char(p_move_out_date,''DD/MM/YYYY'') || '']'' || COALESCE(E''\\n'' || p_notes, '''') || E''\\n'' || v_breakdown\n                        ELSE notes || E''\\n[Thanh lý '' || to_char(p_move_out_date,''DD/MM/YYYY'') || '']'' || COALESCE(E''\\n'' || p_notes, '''') || E''\\n'' || v_breakdown END,\n         updated_at = NOW()\n   WHERE id = p_contract_id;\n\n  -- 7. Audit.\n  BEGIN\n    INSERT INTO contract_terminations (\n      user_id, contract_id, termination_date, actual_move_out_date, termination_type,\n      outstanding_debt, early_termination_fee, prorated_rent, prorated_days, prorated_services,\n      total_deposit, rent_refund_amount, refund_method, status, approved_by, approved_at, notes)\n    VALUES (\n      v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date, ''NORMAL'',\n      v_debt, v_penalty + v_extra, 0, 0, 0,\n      v_deposit, v_owed,\n      CASE WHEN v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN ''TM''::payment_method ELSE NULL END,\n      ''COMPLETED'', auth.uid(), NOW(),\n      COALESCE(p_notes || E''\\n'', '''') || v_breakdown);\n  EXCEPTION WHEN OTHERS THEN\n    RAISE WARNING ''terminate_contract_move_out_impl: audit insert failed for %: %'', p_contract_id, SQLERRM;\n  END;\n\n  RETURN jsonb_build_object(\n    ''contract_id'', p_contract_id, ''settlement_invoice_id'', v_settle_inv,\n    ''charges'', v_charges, ''extra_charges_total'', v_extra,\n    ''applied'', v_applied, ''applied_deposit'', v_applied_dep,\n    ''refund_deposit'', v_refund_dep, ''refund_excess'', v_refund_exc,\n    ''customer_refund_total'', v_owed, ''customer_refund_applied'', v_owed_applied,\n    ''refund_customer'', v_refund_owed,\n    ''refund_voucher_id'', v_refund_voucher,\n    ''net_settlement'', v_S, ''shortfall_mode'', p_shortfall_mode,\n    ''receipt_account_id'', CASE WHEN v_S < 0 AND p_shortfall_mode = ''PAID'' THEN v_acc_rcpt END,\n    ''acc_op'', v_acc_op, ''acc_internal'', v_acc_int\n  );\nEND $function$\n');
  IF md5(definition) <> E'7ff469cae791132bd43022177add0713' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public._ensure_initial_deposit_voucher(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public._ensure_initial_deposit_voucher(uuid)'::regprocedure);
  IF md5(definition) = E'8be94160f6af5b5052663c866ae93627' THEN RETURN; END IF;
  IF md5(definition) <> E'e48a71ade7802880e3d5d5a04252befb' THEN RAISE EXCEPTION 'Live function changed: %',E'public._ensure_initial_deposit_voucher(uuid)'; END IF;
  definition := replace(definition,E'CREATE OR REPLACE FUNCTION public._ensure_initial_deposit_voucher(p_contract_id uuid)\n RETURNS uuid\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''public''\nAS $function$\nDECLARE\n  v_c RECORD; v_building uuid; v_account uuid; v_type uuid;\n  v_amount numeric(15,2); v_date date; v_existing_acc uuid;\nBEGIN\n  SELECT * INTO v_c FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL;\n  IF NOT FOUND THEN RETURN NULL; END IF;\n\n  -- Đã có phiếu thu cọc? → dùng đúng sổ đang chứa cọc.\n  SELECT ie.account_id INTO v_existing_acc\n    FROM income_expenses ie\n   WHERE ie.contract_id = p_contract_id AND ie.type = ''INCOME''\n     AND ie.approval_status = ''APPROVED'' AND ie.deleted_at IS NULL\n     AND public.ie_has_deposit_item(ie.id)\n   ORDER BY ie.voucher_date LIMIT 1;\n  IF v_existing_acc IS NOT NULL THEN RETURN v_existing_acc; END IF;\n\n  v_amount := COALESCE(v_c.deposit_paid, 0);\n  v_account := public._deposit_account(v_c.user_id);   -- sổ CỌC\n  IF v_amount <= 0 OR v_c.room_id IS NULL THEN RETURN v_account; END IF;\n\n  SELECT building_id INTO v_building FROM rooms WHERE id = v_c.room_id;\n  IF v_building IS NULL THEN RETURN v_account; END IF;\n\n  v_date := COALESCE(v_c.signed_date, v_c.start_date, public.org_today_v1(NULL));\n  v_type := public._termination_ensure_type(v_c.user_id, ''income'', ''Tiền cọc'');\n  UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type AND is_deposit IS DISTINCT FROM TRUE;\n\n  INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)\n  VALUES (v_c.user_id, ''INCOME'', ''Cọc giữ phòng (ghi nhận ban đầu) — HĐ '' || COALESCE(v_c.contract_number, p_contract_id::text),\n          v_building, v_c.room_id, p_contract_id, v_account, v_date, v_amount, ''APPROVED'',\n          ''[BACKFILL_INITIAL_DEPOSIT] Ghi nhận cọc ban đầu (giả định đã thu đủ) vào sổ CỌC.'');\n  -- item\n  INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n  SELECT ie.id, v_type, ''Tiền cọc giữ phòng (ghi nhận ban đầu)'', 1, v_amount, v_date, v_date\n    FROM income_expenses ie WHERE ie.contract_id = p_contract_id AND ie.account_id = v_account\n      AND ie.notes LIKE ''[BACKFILL_INITIAL_DEPOSIT]%'' AND ie.deleted_at IS NULL\n    ORDER BY ie.created_at DESC LIMIT 1;\n\n  RETURN v_account;\nEND $function$\n',E'CREATE OR REPLACE FUNCTION public._ensure_initial_deposit_voucher(p_contract_id uuid)\n RETURNS uuid\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''public''\nAS $function$\nDECLARE\n  v_c RECORD; v_building uuid; v_account uuid; v_type uuid;\n  v_amount numeric(15,2); v_date date; v_existing_acc uuid;\nBEGIN\n  SELECT * INTO v_c FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL;\n  IF NOT FOUND THEN RETURN NULL; END IF;\n\n  -- Đã có phiếu thu cọc? → dùng đúng sổ đang chứa cọc.\n  SELECT ie.account_id INTO v_existing_acc\n    FROM income_expenses ie\n   WHERE ie.contract_id = p_contract_id AND ie.type = ''INCOME''\n     AND ie.approval_status = ''APPROVED'' AND ie.deleted_at IS NULL\n     AND public.ie_has_deposit_item(ie.id)\n   ORDER BY ie.voucher_date LIMIT 1;\n  IF v_existing_acc IS NOT NULL THEN RETURN v_existing_acc; END IF;\n\n  v_amount := COALESCE(v_c.deposit_paid, 0);\n  v_account := app_private.deposit_account_in_org_v1(v_c.user_id,v_c.organization_id);   -- sổ CỌC\n  IF v_amount <= 0 OR v_c.room_id IS NULL THEN RETURN v_account; END IF;\n\n  SELECT building_id INTO v_building FROM rooms WHERE id = v_c.room_id;\n  IF v_building IS NULL THEN RETURN v_account; END IF;\n\n  v_date := COALESCE(v_c.signed_date, v_c.start_date, public.org_today_v1(NULL));\n  v_type := app_private.ensure_termination_type_in_org_v1(v_c.user_id, ''income'', ''Tiền cọc'',v_c.organization_id);\n  UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type AND is_deposit IS DISTINCT FROM TRUE;\n\n  INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)\n  VALUES (v_c.user_id, ''INCOME'', ''Cọc giữ phòng (ghi nhận ban đầu) — HĐ '' || COALESCE(v_c.contract_number, p_contract_id::text),\n          v_building, v_c.room_id, p_contract_id, v_account, v_date, v_amount, ''APPROVED'',\n          ''[BACKFILL_INITIAL_DEPOSIT] Ghi nhận cọc ban đầu (giả định đã thu đủ) vào sổ CỌC.'');\n  -- item\n  INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n  SELECT ie.id, v_type, ''Tiền cọc giữ phòng (ghi nhận ban đầu)'', 1, v_amount, v_date, v_date\n    FROM income_expenses ie WHERE ie.contract_id = p_contract_id AND ie.account_id = v_account\n      AND ie.notes LIKE ''[BACKFILL_INITIAL_DEPOSIT]%'' AND ie.deleted_at IS NULL\n    ORDER BY ie.created_at DESC LIMIT 1;\n\n  RETURN v_account;\nEND $function$\n');
  IF md5(definition) <> E'8be94160f6af5b5052663c866ae93627' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.create_opening_adjustment(uuid,numeric,date)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.create_opening_adjustment(uuid,numeric,date)'::regprocedure);
  IF md5(definition) = E'18f5e82d1c6966eb640a79ceddbf8ac8' THEN RETURN; END IF;
  IF md5(definition) <> E'abdb8252db7b049b7e47e2823b2edb73' THEN RAISE EXCEPTION 'Live function changed: %',E'public.create_opening_adjustment(uuid,numeric,date)'; END IF;
  definition := replace(definition,E'CREATE OR REPLACE FUNCTION public.create_opening_adjustment(p_account_id uuid, p_counted_balance numeric, p_as_of date DEFAULT org_today_v1(NULL::uuid))\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''public''\nAS $function$\nDECLARE\n  v_acc        accounts%ROWTYPE;\n  v_system     numeric;\n  v_diff       numeric;\n  v_type_id    uuid;\n  v_voucher_id uuid;\n  v_kind       text;\nBEGIN\n  SELECT * INTO v_acc FROM accounts WHERE id = p_account_id FOR UPDATE;\n  IF NOT FOUND THEN\n    RAISE EXCEPTION ''Không tìm thấy sổ quỹ'';\n  END IF;\n  IF v_acc.user_id <> auth.uid() AND NOT public.is_super_admin() THEN\n    RAISE EXCEPTION ''Bạn không có quyền chốt sổ này'';\n  END IF;\n  IF COALESCE(v_acc.is_virtual, FALSE) THEN\n    RAISE EXCEPTION ''Sổ theo dõi (ảo) không kiểm kê tiền thật — không cần điều chỉnh'';\n  END IF;\n  IF p_as_of > public.org_today_v1(NULL) THEN\n    RAISE EXCEPTION ''Ngày chốt không được ở tương lai'';\n  END IF;\n  IF v_acc.lock_date IS NOT NULL AND v_acc.lock_date > p_as_of THEN\n    RAISE EXCEPTION ''Sổ đã khoá tới % — không thể chốt lùi về %'',\n      v_acc.lock_date, p_as_of;\n  END IF;\n\n  SELECT current_amount INTO v_system\n  FROM accounts_with_balance WHERE id = p_account_id;\n  v_diff := COALESCE(p_counted_balance, 0) - COALESCE(v_system, 0);\n\n  IF abs(v_diff) >= 1 THEN\n    -- Trigger khoá sổ chặn phiếu có ngày ≤ lock_date — phiếu điều chỉnh ngày D\n    -- chính là ngày khoá, nên TẠM GỠ lock trong transaction (row đã FOR UPDATE)\n    -- rồi khoá lại ở cuối. Chốt lại lần 2 cùng ngày cũng đi đường này.\n    IF v_acc.lock_date IS NOT NULL THEN\n      UPDATE accounts SET lock_date = NULL WHERE id = p_account_id;\n    END IF;\n    v_kind := CASE WHEN v_diff > 0 THEN ''income'' ELSE ''expense'' END;\n    -- Hạng mục "Điều chỉnh số dư" (get-or-create) — ẩn khỏi báo cáo P&L.\n    v_type_id := public._termination_ensure_type(\n      v_acc.user_id, v_kind, ''Điều chỉnh số dư'');\n    UPDATE income_expense_types\n       SET hide_in_report = TRUE\n     WHERE id = v_type_id AND hide_in_report IS DISTINCT FROM TRUE;\n\n    INSERT INTO income_expenses (\n      user_id, type, name, building_id, account_id, voucher_date,\n      total_amount, approval_status, business_result_accounting,\n      system_source, notes\n    ) VALUES (\n      v_acc.user_id,\n      CASE WHEN v_diff > 0 THEN ''INCOME'' ELSE ''EXPENSE'' END,\n      ''Điều chỉnh số dư đầu kỳ — '' || v_acc.name || '' (kiểm kê '' ||\n        to_char(p_as_of, ''DD/MM/YYYY'') || '')'',\n      public._chung_building(v_acc.user_id),\n      p_account_id,\n      p_as_of,\n      abs(v_diff),\n      ''APPROVED'',\n      FALSE,  -- ép ngoài-KQKD: kqkd_amount = 0, không lọt Phân bổ LN\n      ''adjustment.opening_balance'',\n      ''[ĐIỀU CHỈNH SỐ DƯ ĐẦU KỲ] Đếm thực tế '' || p_counted_balance ||\n        '' − hệ thống '' || COALESCE(v_system, 0) || '' = '' || v_diff ||\n        ''. Kiểm kê ngày '' || to_char(p_as_of, ''DD/MM/YYYY'') ||\n        '' theo quy trình chuẩn hoá két (không tính vào lợi nhuận).''\n    ) RETURNING id INTO v_voucher_id;\n\n    INSERT INTO income_expense_items (\n      income_expense_id, income_expense_type_id, description,\n      quantity, unit_price\n    ) VALUES (\n      v_voucher_id, v_type_id,\n      ''Chênh lệch kiểm kê '' || to_char(p_as_of, ''DD/MM/YYYY''),\n      1, abs(v_diff)\n    );\n  END IF;\n\n  UPDATE accounts SET lock_date = p_as_of WHERE id = p_account_id;\n\n  RETURN jsonb_build_object(\n    ''account_id'', p_account_id,\n    ''system_balance'', COALESCE(v_system, 0),\n    ''counted_balance'', COALESCE(p_counted_balance, 0),\n    ''diff'', v_diff,\n    ''voucher_id'', v_voucher_id,\n    ''locked_to'', p_as_of\n  );\nEND;\n$function$\n',E'CREATE OR REPLACE FUNCTION public.create_opening_adjustment(p_account_id uuid, p_counted_balance numeric, p_as_of date DEFAULT org_today_v1(NULL::uuid))\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''public''\nAS $function$\nDECLARE\n  v_acc        accounts%ROWTYPE;\n  v_system     numeric;\n  v_diff       numeric;\n  v_type_id    uuid;\n  v_voucher_id uuid;\n  v_kind       text;\nBEGIN\n  SELECT * INTO v_acc FROM accounts WHERE id = p_account_id FOR UPDATE;\n  IF NOT FOUND THEN\n    RAISE EXCEPTION ''Không tìm thấy sổ quỹ'';\n  END IF;\n  IF v_acc.user_id <> auth.uid() AND NOT public.is_super_admin() THEN\n    RAISE EXCEPTION ''Bạn không có quyền chốt sổ này'';\n  END IF;\n  IF COALESCE(v_acc.is_virtual, FALSE) THEN\n    RAISE EXCEPTION ''Sổ theo dõi (ảo) không kiểm kê tiền thật — không cần điều chỉnh'';\n  END IF;\n  IF p_as_of > public.org_today_v1(NULL) THEN\n    RAISE EXCEPTION ''Ngày chốt không được ở tương lai'';\n  END IF;\n  IF v_acc.lock_date IS NOT NULL AND v_acc.lock_date > p_as_of THEN\n    RAISE EXCEPTION ''Sổ đã khoá tới % — không thể chốt lùi về %'',\n      v_acc.lock_date, p_as_of;\n  END IF;\n\n  SELECT current_amount INTO v_system\n  FROM accounts_with_balance WHERE id = p_account_id;\n  v_diff := COALESCE(p_counted_balance, 0) - COALESCE(v_system, 0);\n\n  IF abs(v_diff) >= 1 THEN\n    -- Trigger khoá sổ chặn phiếu có ngày ≤ lock_date — phiếu điều chỉnh ngày D\n    -- chính là ngày khoá, nên TẠM GỠ lock trong transaction (row đã FOR UPDATE)\n    -- rồi khoá lại ở cuối. Chốt lại lần 2 cùng ngày cũng đi đường này.\n    IF v_acc.lock_date IS NOT NULL THEN\n      UPDATE accounts SET lock_date = NULL WHERE id = p_account_id;\n    END IF;\n    v_kind := CASE WHEN v_diff > 0 THEN ''income'' ELSE ''expense'' END;\n    -- Hạng mục "Điều chỉnh số dư" (get-or-create) — ẩn khỏi báo cáo P&L.\n    v_type_id := app_private.ensure_termination_type_in_org_v1(\n      v_acc.user_id, v_kind, ''Điều chỉnh số dư'',v_acc.organization_id);\n    UPDATE income_expense_types\n       SET hide_in_report = TRUE\n     WHERE id = v_type_id AND hide_in_report IS DISTINCT FROM TRUE;\n\n    INSERT INTO income_expenses (\n      user_id, type, name, building_id, account_id, voucher_date,\n      total_amount, approval_status, business_result_accounting,\n      system_source, notes\n    ) VALUES (\n      v_acc.user_id,\n      CASE WHEN v_diff > 0 THEN ''INCOME'' ELSE ''EXPENSE'' END,\n      ''Điều chỉnh số dư đầu kỳ — '' || v_acc.name || '' (kiểm kê '' ||\n        to_char(p_as_of, ''DD/MM/YYYY'') || '')'',\n      app_private.chung_building_in_org_v1(v_acc.user_id,v_acc.organization_id),\n      p_account_id,\n      p_as_of,\n      abs(v_diff),\n      ''APPROVED'',\n      FALSE,  -- ép ngoài-KQKD: kqkd_amount = 0, không lọt Phân bổ LN\n      ''adjustment.opening_balance'',\n      ''[ĐIỀU CHỈNH SỐ DƯ ĐẦU KỲ] Đếm thực tế '' || p_counted_balance ||\n        '' − hệ thống '' || COALESCE(v_system, 0) || '' = '' || v_diff ||\n        ''. Kiểm kê ngày '' || to_char(p_as_of, ''DD/MM/YYYY'') ||\n        '' theo quy trình chuẩn hoá két (không tính vào lợi nhuận).''\n    ) RETURNING id INTO v_voucher_id;\n\n    INSERT INTO income_expense_items (\n      income_expense_id, income_expense_type_id, description,\n      quantity, unit_price\n    ) VALUES (\n      v_voucher_id, v_type_id,\n      ''Chênh lệch kiểm kê '' || to_char(p_as_of, ''DD/MM/YYYY''),\n      1, abs(v_diff)\n    );\n  END IF;\n\n  UPDATE accounts SET lock_date = p_as_of WHERE id = p_account_id;\n\n  RETURN jsonb_build_object(\n    ''account_id'', p_account_id,\n    ''system_balance'', COALESCE(v_system, 0),\n    ''counted_balance'', COALESCE(p_counted_balance, 0),\n    ''diff'', v_diff,\n    ''voucher_id'', v_voucher_id,\n    ''locked_to'', p_as_of\n  );\nEND;\n$function$\n');
  IF md5(definition) <> E'18f5e82d1c6966eb640a79ceddbf8ac8' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.confirm_cash_handover(uuid,uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.confirm_cash_handover(uuid,uuid)'::regprocedure);
  IF md5(definition) = E'bb53cfda938e5ec6ddd092ec937fd30c' THEN RETURN; END IF;
  IF md5(definition) <> E'72174160f40571e8ab0056234260c06c' THEN RAISE EXCEPTION 'Live function changed: %',E'public.confirm_cash_handover(uuid,uuid)'; END IF;
  definition := replace(definition,E'CREATE OR REPLACE FUNCTION public.confirm_cash_handover(p_handover_id uuid, p_to_account_id uuid DEFAULT NULL::uuid)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''public''\nAS $function$\nDECLARE\n  v_h         cash_handovers%ROWTYPE;\n  v_to        uuid;\n  v_net       numeric;\n  v_cnt       int;\n  v_type_exp  uuid;\n  v_type_inc  uuid;\n  v_bld_giver uuid;\n  v_bld_recv  uuid;\n  v_caller    text;\n  v_recv      text;\n  v_giver     text;\n  v_exp       uuid;\n  v_inc       uuid;\n  v_lines_in  text;\n  v_lines_ex  text;\n  v_lines     text;\n  v_item_desc text;\n  v_handover_date date;   -- Đợt 6: ngày MỞ đầu tiên chung cho cả hai chân\nBEGIN\n  IF auth.uid() IS NULL THEN\n    RAISE EXCEPTION ''Bạn chưa đăng nhập'' USING ERRCODE = ''42501'';\n  END IF;\n\n  SELECT * INTO v_h FROM cash_handovers WHERE id = p_handover_id FOR UPDATE;\n  IF NOT FOUND THEN RAISE EXCEPTION ''Không tìm thấy phiên bàn giao''; END IF;\n  IF v_h.receiver_id <> auth.uid() THEN\n    RAISE EXCEPTION ''Chỉ người nhận mới được xác nhận đã nhận tiền'';\n  END IF;\n  IF v_h.status <> ''PENDING'' THEN\n    RAISE EXCEPTION ''Phiên % không ở trạng thái chờ nhận'', v_h.code;\n  END IF;\n  IF v_h.cancel_requested_by IS NOT NULL THEN\n    RAISE EXCEPTION ''Phiên % đang có yêu cầu hủy — xử lý yêu cầu hủy trước'', v_h.code;\n  END IF;\n\n  -- Sổ đích: truyền vào (phải của receiver) hoặc fallback sổ "…Thu" của receiver\n  IF p_to_account_id IS NOT NULL THEN\n    SELECT id INTO v_to FROM accounts\n     WHERE id = p_to_account_id AND user_id = auth.uid() AND deleted_at IS NULL;\n    IF v_to IS NULL THEN\n      RAISE EXCEPTION ''Sổ nhận không hợp lệ (phải là sổ quỹ do bạn sở hữu)'';\n    END IF;\n  ELSE\n    SELECT id INTO v_to FROM accounts\n     WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE ''%Thu''\n     ORDER BY is_default DESC NULLS LAST, name LIMIT 1;\n    IF v_to IS NULL THEN\n      RAISE EXCEPTION ''Bạn chưa có sổ quỹ nhận — hãy chọn sổ khi xác nhận'';\n    END IF;\n  END IF;\n\n  -- Re-validate: danh sách phiếu còn nguyên, NET (Σthu − Σchi) khớp snapshot\n  SELECT COALESCE(sum(CASE WHEN ie.type = ''INCOME'' THEN ie.total_amount\n                           ELSE -ie.total_amount END), 0),\n         count(*)\n    INTO v_net, v_cnt\n    FROM cash_handover_items it\n    JOIN income_expenses ie ON ie.id = it.voucher_id\n   WHERE it.handover_id = p_handover_id\n     AND ie.approval_status = ''APPROVED'' AND ie.deleted_at IS NULL\n     AND ie.handover_id = p_handover_id\n     AND ie.account_id = v_h.from_account_id;\n  IF v_cnt <> v_h.voucher_count OR v_net <> v_h.total_amount THEN\n    RAISE EXCEPTION ''Danh sách phiếu của phiên % đã thay đổi — hãy hủy phiên và tạo lại'', v_h.code;\n  END IF;\n\n  -- Loại thu/chi "bàn giao" (ngoài KQKD) + tòa ảo Chung\n  v_type_exp := public._termination_ensure_type(v_h.giver_id, ''expense'', ''Bàn giao tiền mặt'');\n  UPDATE income_expense_types SET is_deposit = FALSE\n   WHERE id = v_type_exp AND is_deposit IS DISTINCT FROM FALSE;\n  v_type_inc := public._termination_ensure_type(v_h.receiver_id, ''income'', ''Nhận bàn giao tiền mặt'');\n  UPDATE income_expense_types SET is_deposit = FALSE\n   WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;\n  v_bld_giver := public._chung_building(v_h.giver_id);\n  v_bld_recv  := public._chung_building(v_h.receiver_id);\n\n  SELECT COALESCE(full_name, '''') INTO v_caller FROM profiles WHERE id = auth.uid();\n  v_recv  := COALESCE(v_h.receiver_name, '''');\n  v_giver := COALESCE(v_h.giver_name, '''');\n\n  -- ── Nhóm THU: phòng · tòa · tiền · kỳ · HĐ ──\n  SELECT string_agg(\n           ''• '' || COALESCE(NULLIF(btrim(it.room_name), ''''), ''?'')\n                || '' · '' || COALESCE(NULLIF(btrim(it.building_name), ''''), ''?'')\n                || '' · '' || replace(to_char(it.amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ''\n                || COALESCE('' · kỳ '' || to_char(to_date(inv.billing_month, ''YYYY-MM''), ''MM/YYYY''), '''')\n                || COALESCE('' · HĐ '' || NULLIF(btrim(inv.invoice_number), ''''), ''''),\n           E''\\n'' ORDER BY it.building_name, it.room_name)\n    INTO v_lines_in\n    FROM cash_handover_items it\n    LEFT JOIN income_expenses ie ON ie.id = it.voucher_id\n    LEFT JOIN invoices inv ON inv.id = ie.invoice_id\n   WHERE it.handover_id = p_handover_id AND it.voucher_type = ''INCOME'';\n\n  -- ── Nhóm CHI: tên khoản · tiền ──\n  SELECT string_agg(\n           ''• '' || COALESCE(NULLIF(btrim(ie.name), ''''), ''Khoản chi'')\n                || '' · '' || replace(to_char(it.amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ'',\n           E''\\n'' ORDER BY it.amount DESC)\n    INTO v_lines_ex\n    FROM cash_handover_items it\n    LEFT JOIN income_expenses ie ON ie.id = it.voucher_id\n   WHERE it.handover_id = p_handover_id AND it.voucher_type = ''EXPENSE'';\n\n  v_lines := ''Đã thu ('' || replace(to_char(v_h.gross_amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ):''\n             || E''\\n'' || COALESCE(v_lines_in, ''—'')\n             || CASE WHEN v_h.expense_amount > 0\n                  THEN E''\\n'' || ''Đã chi ('' || replace(to_char(v_h.expense_amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ):''\n                       || E''\\n'' || COALESCE(v_lines_ex, ''—'')\n                  ELSE '''' END;\n\n  v_item_desc := ''Bàn giao số dư: thu ''\n                 || replace(to_char(v_h.gross_amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ''\n                 || CASE WHEN v_h.expense_amount > 0\n                      THEN '' − chi '' || replace(to_char(v_h.expense_amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ''\n                      ELSE '''' END;\n\n  -- Đợt 6: kỳ đã chốt thì cặp phiếu bàn giao rơi vào ngày MỞ đầu tiên.\n  -- MỘT ngày chung cho cả hai chân, nếu không sẽ có cửa sổ "tiền trên đường".\n  v_handover_date := GREATEST(\n    public.org_today_v1(NULL),\n    app_private.cashbook_closed_through_v1(v_h.from_account_id) + 1,\n    app_private.cashbook_closed_through_v1(v_to) + 1);\n  IF v_handover_date > public.org_today_v1(NULL) + 31 THEN\n    RAISE EXCEPTION ''[CASHBOOK_CLOSED] Sổ quỹ đã chốt tới % — phiên bàn giao này phải xử lý tay, hệ thống không lập phiếu ở ngày quá xa.'',\n      v_handover_date - 1 USING ERRCODE = ''P0001'';\n  END IF;\n\n  -- ── 1 phiếu CHI tổng (sổ người giao) = NET ──\n  INSERT INTO income_expenses\n    (user_id, type, name, building_id, account_id, voucher_date,\n     total_amount, approval_status, business_result_accounting, notes, creator_name,\n     system_source)\n  VALUES\n    (v_h.giver_id, ''EXPENSE'',\n     ''Bàn giao tiền mặt → '' || v_recv || '' — '' || v_h.code,\n     v_bld_giver, v_h.from_account_id, v_handover_date,\n     v_h.total_amount, ''APPROVED'', FALSE,\n     ''[BÀN GIAO] Nộp tiền sang sổ '' || v_recv || '' (phiên '' || v_h.code || ''):'' || E''\\n'' || v_lines,\n     v_caller,\n     ''handover.transfer'')\n  RETURNING id INTO v_exp;\n\n  -- ── 1 phiếu THU tổng (sổ người nhận) = NET ──\n  INSERT INTO income_expenses\n    (user_id, type, name, building_id, account_id, voucher_date,\n     total_amount, approval_status, business_result_accounting, notes, creator_name,\n     system_source)\n  VALUES\n    (v_h.receiver_id, ''INCOME'',\n     ''Nhận bàn giao tiền mặt ← '' || v_giver || '' — '' || v_h.code,\n     v_bld_recv, v_to, v_handover_date,\n     v_h.total_amount, ''APPROVED'', FALSE,\n     ''[BÀN GIAO] Nhận tiền từ '' || v_giver || '' (phiên '' || v_h.code || ''):'' || E''\\n'' || v_lines,\n     v_caller,\n     ''handover.transfer'')\n  RETURNING id INTO v_inc;\n\n  -- ── 1 hạng mục GỘP = net trên mỗi phiếu (auto_recalc giữ total = net) ──\n  INSERT INTO income_expense_items\n    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n  VALUES (v_exp, v_type_exp, v_item_desc, 1, v_h.total_amount, NULL, NULL);\n  INSERT INTO income_expense_items\n    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n  VALUES (v_inc, v_type_inc, v_item_desc, 1, v_h.total_amount, NULL, NULL);\n\n  -- Khoá cặp phiếu chuyển bằng handover_transfer_id (SAU khi nạp hạng mục)\n  UPDATE income_expenses\n     SET handover_transfer_id = p_handover_id\n   WHERE id IN (v_exp, v_inc);\n\n  UPDATE cash_handovers\n     SET status = ''CONFIRMED'', to_account_id = v_to, confirmed_at = now()\n   WHERE id = p_handover_id;\n\n  RETURN jsonb_build_object(''id'', p_handover_id, ''code'', v_h.code,\n                            ''total_amount'', v_h.total_amount, ''to_account_id'', v_to,\n                            ''voucher_count'', v_h.voucher_count);\nEND;\n$function$\n',E'CREATE OR REPLACE FUNCTION public.confirm_cash_handover(p_handover_id uuid, p_to_account_id uuid DEFAULT NULL::uuid)\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''public''\nAS $function$\nDECLARE\n  v_h         cash_handovers%ROWTYPE;\n  v_to        uuid;\n  v_net       numeric;\n  v_cnt       int;\n  v_type_exp  uuid;\n  v_type_inc  uuid;\n  v_bld_giver uuid;\n  v_bld_recv  uuid;\n  v_caller    text;\n  v_recv      text;\n  v_giver     text;\n  v_exp       uuid;\n  v_inc       uuid;\n  v_lines_in  text;\n  v_lines_ex  text;\n  v_lines     text;\n  v_item_desc text;\n  v_handover_date date;   -- Đợt 6: ngày MỞ đầu tiên chung cho cả hai chân\nBEGIN\n  IF auth.uid() IS NULL THEN\n    RAISE EXCEPTION ''Bạn chưa đăng nhập'' USING ERRCODE = ''42501'';\n  END IF;\n\n  SELECT * INTO v_h FROM cash_handovers WHERE id = p_handover_id FOR UPDATE;\n  IF NOT FOUND THEN RAISE EXCEPTION ''Không tìm thấy phiên bàn giao''; END IF;\n  IF v_h.receiver_id <> auth.uid() THEN\n    RAISE EXCEPTION ''Chỉ người nhận mới được xác nhận đã nhận tiền'';\n  END IF;\n  IF v_h.status <> ''PENDING'' THEN\n    RAISE EXCEPTION ''Phiên % không ở trạng thái chờ nhận'', v_h.code;\n  END IF;\n  IF v_h.cancel_requested_by IS NOT NULL THEN\n    RAISE EXCEPTION ''Phiên % đang có yêu cầu hủy — xử lý yêu cầu hủy trước'', v_h.code;\n  END IF;\n\n  -- Sổ đích: truyền vào (phải của receiver) hoặc fallback sổ "…Thu" của receiver\n  IF p_to_account_id IS NOT NULL THEN\n    SELECT id INTO v_to FROM accounts\n     WHERE id = p_to_account_id AND organization_id = v_h.organization_id AND user_id = auth.uid() AND deleted_at IS NULL;\n    IF v_to IS NULL THEN\n      RAISE EXCEPTION ''Sổ nhận không hợp lệ (phải là sổ quỹ do bạn sở hữu)'';\n    END IF;\n  ELSE\n    SELECT id INTO v_to FROM accounts\n     WHERE organization_id = v_h.organization_id AND user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE ''%Thu''\n     ORDER BY is_default DESC NULLS LAST, name LIMIT 1;\n    IF v_to IS NULL THEN\n      RAISE EXCEPTION ''Bạn chưa có sổ quỹ nhận — hãy chọn sổ khi xác nhận'';\n    END IF;\n  END IF;\n\n  -- Re-validate: danh sách phiếu còn nguyên, NET (Σthu − Σchi) khớp snapshot\n  SELECT COALESCE(sum(CASE WHEN ie.type = ''INCOME'' THEN ie.total_amount\n                           ELSE -ie.total_amount END), 0),\n         count(*)\n    INTO v_net, v_cnt\n    FROM cash_handover_items it\n    JOIN income_expenses ie ON ie.id = it.voucher_id\n   WHERE it.handover_id = p_handover_id\n     AND ie.approval_status = ''APPROVED'' AND ie.deleted_at IS NULL\n     AND ie.handover_id = p_handover_id\n     AND ie.account_id = v_h.from_account_id AND ie.organization_id = v_h.organization_id;\n  IF v_cnt <> v_h.voucher_count OR v_net <> v_h.total_amount THEN\n    RAISE EXCEPTION ''Danh sách phiếu của phiên % đã thay đổi — hãy hủy phiên và tạo lại'', v_h.code;\n  END IF;\n\n  -- Loại thu/chi "bàn giao" (ngoài KQKD) + tòa ảo Chung\n  v_type_exp := app_private.ensure_termination_type_in_org_v1(v_h.giver_id, ''expense'', ''Bàn giao tiền mặt'',v_h.organization_id);\n  UPDATE income_expense_types SET is_deposit = FALSE\n   WHERE id = v_type_exp AND is_deposit IS DISTINCT FROM FALSE;\n  v_type_inc := app_private.ensure_termination_type_in_org_v1(v_h.receiver_id, ''income'', ''Nhận bàn giao tiền mặt'',v_h.organization_id);\n  UPDATE income_expense_types SET is_deposit = FALSE\n   WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;\n  v_bld_giver := app_private.chung_building_in_org_v1(v_h.giver_id,v_h.organization_id);\n  v_bld_recv  := app_private.chung_building_in_org_v1(v_h.receiver_id,v_h.organization_id);\n\n  SELECT COALESCE(full_name, '''') INTO v_caller FROM profiles WHERE id = auth.uid();\n  v_recv  := COALESCE(v_h.receiver_name, '''');\n  v_giver := COALESCE(v_h.giver_name, '''');\n\n  -- ── Nhóm THU: phòng · tòa · tiền · kỳ · HĐ ──\n  SELECT string_agg(\n           ''• '' || COALESCE(NULLIF(btrim(it.room_name), ''''), ''?'')\n                || '' · '' || COALESCE(NULLIF(btrim(it.building_name), ''''), ''?'')\n                || '' · '' || replace(to_char(it.amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ''\n                || COALESCE('' · kỳ '' || to_char(to_date(inv.billing_month, ''YYYY-MM''), ''MM/YYYY''), '''')\n                || COALESCE('' · HĐ '' || NULLIF(btrim(inv.invoice_number), ''''), ''''),\n           E''\\n'' ORDER BY it.building_name, it.room_name)\n    INTO v_lines_in\n    FROM cash_handover_items it\n    LEFT JOIN income_expenses ie ON ie.id = it.voucher_id\n    LEFT JOIN invoices inv ON inv.id = ie.invoice_id\n   WHERE it.handover_id = p_handover_id AND it.voucher_type = ''INCOME'';\n\n  -- ── Nhóm CHI: tên khoản · tiền ──\n  SELECT string_agg(\n           ''• '' || COALESCE(NULLIF(btrim(ie.name), ''''), ''Khoản chi'')\n                || '' · '' || replace(to_char(it.amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ'',\n           E''\\n'' ORDER BY it.amount DESC)\n    INTO v_lines_ex\n    FROM cash_handover_items it\n    LEFT JOIN income_expenses ie ON ie.id = it.voucher_id\n   WHERE it.handover_id = p_handover_id AND it.voucher_type = ''EXPENSE'';\n\n  v_lines := ''Đã thu ('' || replace(to_char(v_h.gross_amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ):''\n             || E''\\n'' || COALESCE(v_lines_in, ''—'')\n             || CASE WHEN v_h.expense_amount > 0\n                  THEN E''\\n'' || ''Đã chi ('' || replace(to_char(v_h.expense_amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ):''\n                       || E''\\n'' || COALESCE(v_lines_ex, ''—'')\n                  ELSE '''' END;\n\n  v_item_desc := ''Bàn giao số dư: thu ''\n                 || replace(to_char(v_h.gross_amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ''\n                 || CASE WHEN v_h.expense_amount > 0\n                      THEN '' − chi '' || replace(to_char(v_h.expense_amount::bigint, ''FM999,999,999''), '','', ''.'') || ''đ''\n                      ELSE '''' END;\n\n  -- Đợt 6: kỳ đã chốt thì cặp phiếu bàn giao rơi vào ngày MỞ đầu tiên.\n  -- MỘT ngày chung cho cả hai chân, nếu không sẽ có cửa sổ "tiền trên đường".\n  v_handover_date := GREATEST(\n    public.org_today_v1(NULL),\n    app_private.cashbook_closed_through_v1(v_h.from_account_id) + 1,\n    app_private.cashbook_closed_through_v1(v_to) + 1);\n  IF v_handover_date > public.org_today_v1(NULL) + 31 THEN\n    RAISE EXCEPTION ''[CASHBOOK_CLOSED] Sổ quỹ đã chốt tới % — phiên bàn giao này phải xử lý tay, hệ thống không lập phiếu ở ngày quá xa.'',\n      v_handover_date - 1 USING ERRCODE = ''P0001'';\n  END IF;\n\n  -- ── 1 phiếu CHI tổng (sổ người giao) = NET ──\n  INSERT INTO income_expenses\n    (user_id, type, name, building_id, account_id, voucher_date,\n     total_amount, approval_status, business_result_accounting, notes, creator_name,\n     system_source)\n  VALUES\n    (v_h.giver_id, ''EXPENSE'',\n     ''Bàn giao tiền mặt → '' || v_recv || '' — '' || v_h.code,\n     v_bld_giver, v_h.from_account_id, v_handover_date,\n     v_h.total_amount, ''APPROVED'', FALSE,\n     ''[BÀN GIAO] Nộp tiền sang sổ '' || v_recv || '' (phiên '' || v_h.code || ''):'' || E''\\n'' || v_lines,\n     v_caller,\n     ''handover.transfer'')\n  RETURNING id INTO v_exp;\n\n  -- ── 1 phiếu THU tổng (sổ người nhận) = NET ──\n  INSERT INTO income_expenses\n    (user_id, type, name, building_id, account_id, voucher_date,\n     total_amount, approval_status, business_result_accounting, notes, creator_name,\n     system_source)\n  VALUES\n    (v_h.receiver_id, ''INCOME'',\n     ''Nhận bàn giao tiền mặt ← '' || v_giver || '' — '' || v_h.code,\n     v_bld_recv, v_to, v_handover_date,\n     v_h.total_amount, ''APPROVED'', FALSE,\n     ''[BÀN GIAO] Nhận tiền từ '' || v_giver || '' (phiên '' || v_h.code || ''):'' || E''\\n'' || v_lines,\n     v_caller,\n     ''handover.transfer'')\n  RETURNING id INTO v_inc;\n\n  -- ── 1 hạng mục GỘP = net trên mỗi phiếu (auto_recalc giữ total = net) ──\n  INSERT INTO income_expense_items\n    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n  VALUES (v_exp, v_type_exp, v_item_desc, 1, v_h.total_amount, NULL, NULL);\n  INSERT INTO income_expense_items\n    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)\n  VALUES (v_inc, v_type_inc, v_item_desc, 1, v_h.total_amount, NULL, NULL);\n\n  -- Khoá cặp phiếu chuyển bằng handover_transfer_id (SAU khi nạp hạng mục)\n  UPDATE income_expenses\n     SET handover_transfer_id = p_handover_id\n   WHERE id IN (v_exp, v_inc);\n\n  UPDATE cash_handovers\n     SET status = ''CONFIRMED'', to_account_id = v_to, confirmed_at = now()\n   WHERE id = p_handover_id;\n\n  RETURN jsonb_build_object(''id'', p_handover_id, ''code'', v_h.code,\n                            ''total_amount'', v_h.total_amount, ''to_account_id'', v_to,\n                            ''voucher_count'', v_h.voucher_count);\nEND;\n$function$\n');
  IF md5(definition) <> E'bb53cfda938e5ec6ddd092ec937fd30c' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public._termination_pick_account(uuid,uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public._termination_pick_account(uuid,uuid)'::regprocedure);
  IF md5(definition) = E'cfd33486a65e51d966c4c43f6cd5dc05' THEN RETURN; END IF;
  IF md5(definition) <> E'fae19a59566c0f3fe027ee1020aa292a' THEN RAISE EXCEPTION 'Live function changed: %',E'public._termination_pick_account(uuid,uuid)'; END IF;
  definition := replace(definition,E'CREATE OR REPLACE FUNCTION public._termination_pick_account(p_user_id uuid, p_building_id uuid)\n RETURNS uuid\n LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO ''public''\nAS $function$\n  SELECT COALESCE(\n    -- 1) Sổ tiền mặt cấu hình cho toà (nơi thu tiền thuê).\n    (SELECT b.default_account_id_tt FROM buildings b\n      WHERE b.id = p_building_id AND b.default_account_id_tt IS NOT NULL\n        AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = b.default_account_id_tt AND a.deleted_at IS NULL AND a.is_virtual = false)),\n    -- 2) Sổ ngân hàng cấu hình cho toà.\n    (SELECT b.default_account_id_tk FROM buildings b\n      WHERE b.id = p_building_id AND b.default_account_id_tk IS NOT NULL\n        AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = b.default_account_id_tk AND a.deleted_at IS NULL AND a.is_virtual = false)),\n    -- 3) Fallback: trùng tên toà → is_default → tạo sớm nhất; né sổ ảo bằng CỜ.\n    (SELECT a.id\n       FROM accounts a, (SELECT name FROM buildings WHERE id = p_building_id) bld\n      WHERE a.user_id = p_user_id\n        AND a.deleted_at IS NULL\n        AND a.is_virtual = false\n        AND a.name NOT IN (''Cấn trừ thanh lý (nội bộ)'', ''Làm tròn tiền thiếu'')\n      ORDER BY (a.name = bld.name) DESC, a.is_default DESC NULLS LAST, a.created_at\n      LIMIT 1)\n  );\n$function$\n',E'CREATE OR REPLACE FUNCTION public._termination_pick_account(p_user_id uuid, p_building_id uuid)\n RETURNS uuid\n LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO ''public''\nAS $function$\n  SELECT COALESCE(\n    -- 1) Sổ tiền mặt cấu hình cho toà (nơi thu tiền thuê).\n    (SELECT b.default_account_id_tt FROM buildings b\n      WHERE b.id = p_building_id AND b.default_account_id_tt IS NOT NULL\n        AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = b.default_account_id_tt AND a.organization_id = b.organization_id AND a.deleted_at IS NULL AND a.is_virtual = false)),\n    -- 2) Sổ ngân hàng cấu hình cho toà.\n    (SELECT b.default_account_id_tk FROM buildings b\n      WHERE b.id = p_building_id AND b.default_account_id_tk IS NOT NULL\n        AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = b.default_account_id_tk AND a.organization_id = b.organization_id AND a.deleted_at IS NULL AND a.is_virtual = false)),\n    -- 3) Fallback: trùng tên toà → is_default → tạo sớm nhất; né sổ ảo bằng CỜ.\n    (SELECT a.id\n       FROM accounts a, (SELECT name,organization_id FROM buildings WHERE id = p_building_id) bld\n      WHERE a.user_id = p_user_id AND a.organization_id = bld.organization_id\n        AND a.deleted_at IS NULL\n        AND a.is_virtual = false\n        AND a.name NOT IN (''Cấn trừ thanh lý (nội bộ)'', ''Làm tròn tiền thiếu'')\n      ORDER BY (a.name = bld.name) DESC, a.is_default DESC NULLS LAST, a.created_at\n      LIMIT 1)\n  );\n$function$\n');
  IF md5(definition) <> E'cfd33486a65e51d966c4c43f6cd5dc05' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.copilot_preview_salary_chi_luong_v1(uuid,jsonb)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.copilot_preview_salary_chi_luong_v1(uuid,jsonb)'::regprocedure);
  IF md5(definition) = E'8fb7594d59590ccdc3cfdba2c038a38f' THEN RETURN; END IF;
  IF md5(definition) <> E'ef607bb38eb9ef1c11ba61b9ec1c30ca' THEN RAISE EXCEPTION 'Live function changed: %',E'public.copilot_preview_salary_chi_luong_v1(uuid,jsonb)'; END IF;
  definition := replace(definition,E'app_private.copilot_salary_org_of_staff_v1(v_staff_id)',E'app_private.salary_subject_organization_v1(v_staff_id,v_period,v_account,p_organization_id)');
  IF md5(definition) <> E'8fb7594d59590ccdc3cfdba2c038a38f' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.copilot_preview_salary_khoa_thang_v1(uuid,jsonb)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.copilot_preview_salary_khoa_thang_v1(uuid,jsonb)'::regprocedure);
  IF md5(definition) = E'edc7b8ae982cf4f8e5fa7f49acea9ff3' THEN RETURN; END IF;
  IF md5(definition) <> E'd7b8e4de47cf46d185b523ebae55d10b' THEN RAISE EXCEPTION 'Live function changed: %',E'public.copilot_preview_salary_khoa_thang_v1(uuid,jsonb)'; END IF;
  definition := replace(definition,E'app_private.copilot_salary_org_of_staff_v1(v_first_staff)',E'app_private.salary_subject_organization_v1(v_first_staff,v_period,NULL,p_organization_id)');
  IF md5(definition) <> E'edc7b8ae982cf4f8e5fa7f49acea9ff3' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.copilot_execute_salary_chi_luong_v1(text,jsonb)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.copilot_execute_salary_chi_luong_v1(text,jsonb)'::regprocedure);
  IF md5(definition) = E'431f62feb220a680f77f0c7f12afcf28' THEN RETURN; END IF;
  IF md5(definition) <> E'39645b5c92d9210bfdf9f103b79d0359' THEN RAISE EXCEPTION 'Live function changed: %',E'public.copilot_execute_salary_chi_luong_v1(text,jsonb)'; END IF;
  definition := replace(definition,E'app_private.copilot_salary_org_of_staff_v1(v_staff_id)',E'app_private.salary_subject_organization_v1(v_staff_id,v_period,v_account,v_org)');
  IF md5(definition) <> E'431f62feb220a680f77f0c7f12afcf28' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.copilot_execute_salary_khoa_thang_v1(text,jsonb)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.copilot_execute_salary_khoa_thang_v1(text,jsonb)'::regprocedure);
  IF md5(definition) = E'88f10f5fa9ab15a7069beae31ab2d8c7' THEN RETURN; END IF;
  IF md5(definition) <> E'a8cef4d654eaa033c78e0445b0cd5108' THEN RAISE EXCEPTION 'Live function changed: %',E'public.copilot_execute_salary_khoa_thang_v1(text,jsonb)'; END IF;
  definition := replace(definition,E'app_private.copilot_salary_org_of_staff_v1(v_first_staff)',E'app_private.salary_subject_organization_v1(v_first_staff,v_period,NULL,v_org)');
  IF md5(definition) <> E'88f10f5fa9ab15a7069beae31ab2d8c7' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.get_or_create_deposit_account()
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.get_or_create_deposit_account()'::regprocedure);
  IF md5(definition) = E'42bbd21de6f5a14972372fc2a77a4185' THEN RETURN; END IF;
  IF md5(definition) <> E'ff2a1a571527be002a4be6fc9bca26fe' THEN RAISE EXCEPTION 'Live function changed: %',E'public.get_or_create_deposit_account()'; END IF;
  definition := replace(definition,E'CREATE OR REPLACE FUNCTION public.get_or_create_deposit_account()\n RETURNS uuid\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''public''\nAS $function$\nDECLARE\n  v_acc uuid;\nBEGIN\n  -- 1. Sổ "%Thu" mặc định của chính người gọi.\n  SELECT id INTO v_acc FROM accounts\n  WHERE user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual\n    AND name ILIKE ''%thu'' AND is_default\n  ORDER BY created_at LIMIT 1;\n  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;\n\n  -- 2. Sổ "%Thu" bất kỳ của người gọi.\n  SELECT id INTO v_acc FROM accounts\n  WHERE user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual\n    AND name ILIKE ''%thu''\n  ORDER BY created_at LIMIT 1;\n  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;\n\n  -- 3. Sổ mặc định bất kỳ của người gọi.\n  SELECT id INTO v_acc FROM accounts\n  WHERE user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual\n    AND is_default\n  ORDER BY created_at LIMIT 1;\n  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;\n\n  -- 4. Sổ thật đầu tiên của người gọi.\n  SELECT id INTO v_acc FROM accounts\n  WHERE user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual\n  ORDER BY created_at LIMIT 1;\n  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;\n\n  RAISE EXCEPTION ''Bạn chưa có sổ quỹ nào — tạo sổ "%% Thu" trong Tài chính → Sổ quỹ trước khi thu cọc'';\nEND;\n$function$\n',E'CREATE OR REPLACE FUNCTION public.get_or_create_deposit_account()\n RETURNS uuid\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO ''public''\nAS $function$\nDECLARE\n  v_acc uuid;\nBEGIN\n  -- 1. Sổ "%Thu" mặc định của chính người gọi.\n  SELECT id INTO v_acc FROM accounts\n  WHERE organization_id = app_private.working_organization_v1() AND user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual\n    AND name ILIKE ''%thu'' AND is_default\n  ORDER BY created_at LIMIT 1;\n  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;\n\n  -- 2. Sổ "%Thu" bất kỳ của người gọi.\n  SELECT id INTO v_acc FROM accounts\n  WHERE organization_id = app_private.working_organization_v1() AND user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual\n    AND name ILIKE ''%thu''\n  ORDER BY created_at LIMIT 1;\n  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;\n\n  -- 3. Sổ mặc định bất kỳ của người gọi.\n  SELECT id INTO v_acc FROM accounts\n  WHERE organization_id = app_private.working_organization_v1() AND user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual\n    AND is_default\n  ORDER BY created_at LIMIT 1;\n  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;\n\n  -- 4. Sổ thật đầu tiên của người gọi.\n  SELECT id INTO v_acc FROM accounts\n  WHERE organization_id = app_private.working_organization_v1() AND user_id = auth.uid() AND deleted_at IS NULL AND NOT is_virtual\n  ORDER BY created_at LIMIT 1;\n  IF v_acc IS NOT NULL THEN RETURN v_acc; END IF;\n\n  RAISE EXCEPTION ''Bạn chưa có sổ quỹ nào — tạo sổ "%% Thu" trong Tài chính → Sổ quỹ trước khi thu cọc'';\nEND;\n$function$\n');
  IF md5(definition) <> E'42bbd21de6f5a14972372fc2a77a4185' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.set_salary_v5_config(jsonb)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.set_salary_v5_config(jsonb)'::regprocedure);
  IF md5(definition) = E'bf661c1ab94d2101451477f986b1ba1d' THEN RETURN; END IF;
  IF md5(definition) <> E'1159731faff8327cea5cf7e011c3eabd' THEN RAISE EXCEPTION 'Live function changed: %',E'public.set_salary_v5_config(jsonb)'; END IF;
  definition := replace(definition,E'  SELECT rules INTO v_rules FROM public.salary_bonus_rules WHERE user_id = v_owner FOR UPDATE;',E'  SELECT rules INTO v_rules FROM public.salary_bonus_rules\n    WHERE user_id = v_owner AND organization_id = app_private.working_organization_v1() FOR UPDATE;\n  IF NOT FOUND THEN RAISE EXCEPTION ''Cấu hình lương V5 này không thuộc công ty đang chọn'' USING ERRCODE=''42501''; END IF;');
  IF md5(definition) <> E'bf661c1ab94d2101451477f986b1ba1d' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- app_private.storage_object_link_maintain()
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'app_private.storage_object_link_maintain()'::regprocedure);
  IF md5(definition) = E'a830d2f0bd10ebc4659105f619f6b342' THEN RETURN; END IF;
  IF md5(definition) <> E'ea328e925a0f7c6f1f8094f171bf059c' THEN RAISE EXCEPTION 'Live function changed: %',E'app_private.storage_object_link_maintain()'; END IF;
  definition := replace(definition,E'declare v_uploader uuid; v_org uuid; v_how text;\nbegin\n  if new.bucket_id not in (''customer-id-cards'',''customer-images'',''income-expense-attachments'',\n                           ''job-attachments'',''payment-receipts'',''meter-images'',''document-templates'') then\n    return new;\n  end if;\n  v_uploader := coalesce(new.owner_id::uuid, new.owner, nullif(split_part(new.name,''/'',1),'''')::uuid);\n  select org, how into v_org, v_how from app_private.derive_uploader_org_v1(v_uploader);\n  insert into app_private.storage_object_links (bucket_id, object_name, organization_id, owner_user_id, derivation)\n  values (new.bucket_id, new.name, v_org, v_uploader, coalesce(v_how,''quarantine''))\n  on conflict (bucket_id, object_name) do update set organization_id=excluded.organization_id,\n    owner_user_id=excluded.owner_user_id, derivation=excluded.derivation;\n  return new;\nend;',E'declare\n  v_uploader uuid;\n  v_org uuid;\n  v_how text;\n  v_requested text;\n  v_intent_org uuid;\n  v_intent_user uuid;\nbegin\n  if new.bucket_id not in (''customer-id-cards'',''customer-images'',''income-expense-attachments'',\n                           ''job-attachments'',''payment-receipts'',''meter-images'',''document-templates'') then\n    return new;\n  end if;\n  v_uploader := coalesce(new.owner_id::uuid,new.owner);\n  if v_uploader is null and split_part(new.name,''/'',1) ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'' then\n    v_uploader := split_part(new.name,''/'',1)::uuid;\n  end if;\n  -- A server-issued finance intent owns the company, including v2/org paths.\n  if exists (select 1 from public.finance_evidence_objects e where e.bucket_id=new.bucket_id and e.object_name=new.name and e.state=''QUARANTINED'')\n     or (select count(*) from public.finance_evidence_objects e where e.bucket_id=new.bucket_id and e.object_name=new.name)>1 then\n    raise exception ''Chứng từ của đường dẫn ảnh bị cách ly hoặc mâu thuẫn công ty'' using errcode=''42501'';\n  end if;\n  select e.organization_id,e.uploader_user_id into v_intent_org,v_intent_user\n    from public.finance_evidence_objects e\n    where e.bucket_id=new.bucket_id and e.object_name=new.name\n      and e.state in (''UPLOAD_INTENT'',''FINALIZED'',''ATTACHED'');\n  v_requested := nullif(new.user_metadata->>''ihomecrm_organization_id'','''');\n  if v_intent_org is not null then\n    if v_intent_user is distinct from v_uploader then\n      raise exception ''Người tải không khớp chứng từ'' using errcode=''42501'';\n    end if;\n    v_org := v_intent_org;\n    if v_requested is not null and v_requested::uuid is distinct from v_org then\n      raise exception ''Công ty ảnh không khớp chứng từ'' using errcode=''42501'';\n    end if;\n    v_how := ''finance-intent'';\n  elsif v_requested is not null then\n    v_org := v_requested::uuid;\n    v_how := ''explicit-upload'';\n  else\n    -- Old clients keep the existing unambiguous derivation/quarantine behavior.\n    select org,how into v_org,v_how from app_private.derive_uploader_org_v1(v_uploader);\n  end if;\n  if v_org is not null and not app_private.active_working_membership_v1(v_uploader,v_org) then\n    raise exception ''Người tải không còn quyền trong công ty của ảnh'' using errcode=''42501'';\n  end if;\n  insert into app_private.storage_object_links(bucket_id,object_name,organization_id,owner_user_id,derivation)\n    values(new.bucket_id,new.name,v_org,v_uploader,coalesce(v_how,''quarantine''))\n    on conflict (bucket_id,object_name) do update set\n      organization_id=coalesce(storage_object_links.organization_id,excluded.organization_id),\n      derivation=case when storage_object_links.organization_id is null then excluded.derivation else storage_object_links.derivation end\n    where storage_object_links.owner_user_id is not distinct from excluded.owner_user_id\n      and (storage_object_links.organization_id is null or storage_object_links.organization_id is not distinct from excluded.organization_id);\n  if not found then raise exception ''Đường dẫn ảnh đã thuộc chủ hoặc công ty khác'' using errcode=''42501''; end if;\n  return new;\nend;');
  IF md5(definition) <> E'a830d2f0bd10ebc4659105f619f6b342' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- app_private.current_admin_org_v1()
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'app_private.current_admin_org_v1()'::regprocedure);
  IF md5(definition) = E'5f653b5d6da32ea46f678fcbfdab0496' THEN RETURN; END IF;
  IF md5(definition) <> E'46d46cca36fbe938b3692969c2cb4f3c' THEN RAISE EXCEPTION 'Live function changed: %',E'app_private.current_admin_org_v1()'; END IF;
  definition := replace(definition,E'select m.organization_id into v_org\n    from public.organization_memberships m\n    join public.organizations o on o.id = m.organization_id and o.status = ''ACTIVE''\n   where m.user_id = (select auth.uid()) and m.status = ''ACTIVE''\n   order by coalesce(o.is_demo, false), m.organization_id\n   limit 1;',E'v_org := app_private.working_organization_v1();');
  definition := replace(definition,E'app_private.has_any_scope_v3(''users.view'')',E'app_private.has_any_scope_for_org_v1(''users.view'',v_org)');
  IF md5(definition) <> E'5f653b5d6da32ea46f678fcbfdab0496' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.invite_organization_member_v1(text,text,uuid,uuid[],integer)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.invite_organization_member_v1(text,text,uuid,uuid[],integer)'::regprocedure);
  IF md5(definition) = E'76b41c4eddb73713860a3d82a8a111d3' THEN RETURN; END IF;
  IF md5(definition) <> E'103bf9f65fa34ffa35c8d6fa7e2822e1' THEN RAISE EXCEPTION 'Live function changed: %',E'public.invite_organization_member_v1(text,text,uuid,uuid[],integer)'; END IF;
  definition := replace(definition,E'select m.organization_id into v_org\n    from public.organization_memberships m\n    join public.organizations o on o.id = m.organization_id and o.status = ''ACTIVE''\n   where m.user_id = v_actor and m.status = ''ACTIVE''\n   order by coalesce(o.is_demo,false), m.organization_id limit 1;',E'v_org := app_private.working_organization_v1();');
  IF md5(definition) <> E'76b41c4eddb73713860a3d82a8a111d3' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.upsert_organization_role_v1(uuid,text,jsonb,bigint,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.upsert_organization_role_v1(uuid,text,jsonb,bigint,text)'::regprocedure);
  IF md5(definition) = E'452786bad1f28b1cdadf8af1c2c6e832' THEN RETURN; END IF;
  IF md5(definition) <> E'dc817be77e05bdc2b6debdab75d78552' THEN RAISE EXCEPTION 'Live function changed: %',E'public.upsert_organization_role_v1(uuid,text,jsonb,bigint,text)'; END IF;
  definition := replace(definition,E'select m.organization_id into v_org\n      from public.organization_memberships m\n      join public.organizations o on o.id = m.organization_id and o.status = ''ACTIVE''\n     where m.user_id = v_actor and m.status = ''ACTIVE''\n     order by coalesce(o.is_demo,false), m.organization_id limit 1;',E'v_org := app_private.working_organization_v1();');
  IF md5(definition) <> E'452786bad1f28b1cdadf8af1c2c6e832' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.lucky_admin_org_v1()
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.lucky_admin_org_v1()'::regprocedure);
  IF md5(definition) = E'2a682223e676dc641491b1cc27484468' THEN RETURN; END IF;
  IF md5(definition) <> E'40f5baff53943c42a630345fe6324586' THEN RAISE EXCEPTION 'Live function changed: %',E'public.lucky_admin_org_v1()'; END IF;
  definition := replace(definition,E'select m.organization_id into v_org\n    from public.organization_memberships m\n    join public.organizations o on o.id = m.organization_id and o.status = ''ACTIVE''\n   where m.user_id = (select auth.uid())\n     and m.status = ''ACTIVE''\n     and m.member_type in (''OWNER'', ''STAFF'')\n   order by coalesce(o.is_demo, false), m.organization_id\n   limit 1;',E'v_org := app_private.working_organization_v1(false);\n  if not exists (select 1 from public.organization_memberships m\n    where m.user_id=auth.uid() and m.organization_id=v_org and m.status=''ACTIVE''\n      and m.member_type in (''OWNER'',''STAFF'')) then return null; end if;');
  IF md5(definition) <> E'2a682223e676dc641491b1cc27484468' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.get_authorization_context_v1(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.get_authorization_context_v1(uuid)'::regprocedure);
  IF md5(definition) = E'722b3c46d26c38a53df563b94486604c' THEN RETURN; END IF;
  IF md5(definition) <> E'2651fa5739beed6c732925dc4324289a' THEN RAISE EXCEPTION 'Live function changed: %',E'public.get_authorization_context_v1(uuid)'; END IF;
  definition := replace(definition,E'select m.organization_id into v_org\r\n    from public.organization_memberships m\r\n    join public.organizations o on o.id = m.organization_id and o.status = ''ACTIVE''\r\n   where m.user_id = v_actor\r\n     and m.status = ''ACTIVE''\r\n     and coalesce(m.valid_from, ''-infinity''::timestamptz) <= now()\r\n     and (m.valid_to is null or m.valid_to > now())\r\n     and (p_organization_id is null or m.organization_id = p_organization_id)\r\n   order by coalesce(o.is_demo, false) asc,\r\n            coalesce(m.activated_at, m.valid_from, ''infinity''::timestamptz) asc,\r\n            m.organization_id asc\r\n   limit 1;',E'v_org := coalesce(p_organization_id,app_private.working_organization_v1(false));\n  if not app_private.active_working_membership_v1(v_actor,v_org) then v_org := null; end if;');
  IF md5(definition) <> E'722b3c46d26c38a53df563b94486604c' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.get_ie_auto_approve_threshold_v1()
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.get_ie_auto_approve_threshold_v1()'::regprocedure);
  IF md5(definition) = E'9ddd8df410367b83ff8374fd15d6cfed' THEN RETURN; END IF;
  IF md5(definition) <> E'0b77ee5a205a65e07327e87d9fceb95c' THEN RAISE EXCEPTION 'Live function changed: %',E'public.get_ie_auto_approve_threshold_v1()'; END IF;
  definition := replace(definition,E'select count(distinct m.organization_id), min(m.organization_id::text)::uuid\n    into v_cnt, v_org\n    from public.organization_memberships m\n   where m.user_id = v_actor and m.status = ''ACTIVE'';\n  if coalesce(v_cnt,0) = 0 then raise exception ''Không thuộc tổ chức nào'' using errcode=''42501''; end if;\n  if v_cnt > 1 then\n    select rb.organization_id into v_owner_org\n      from public.role_bindings rb\n      join public.organization_memberships m\n        on m.id = rb.membership_id and m.organization_id = rb.organization_id\n       and m.user_id = v_actor and m.status = ''ACTIVE''\n      join public.organization_roles r\n        on r.id = rb.role_id and r.name = ''Chủ sở hữu tổ chức''\n     limit 1;\n    if v_owner_org is not null then v_org := v_owner_org; end if;\n  end if;',E'v_org := app_private.working_organization_v1();');
  IF md5(definition) <> E'9ddd8df410367b83ff8374fd15d6cfed' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.set_ie_auto_approve_threshold_v1(numeric)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.set_ie_auto_approve_threshold_v1(numeric)'::regprocedure);
  IF md5(definition) = E'd1b160e64641f360749c7cca960737b6' THEN RETURN; END IF;
  IF md5(definition) <> E'c0d115f634a8c553aa8c4d86e6bc62fc' THEN RAISE EXCEPTION 'Live function changed: %',E'public.set_ie_auto_approve_threshold_v1(numeric)'; END IF;
  definition := replace(definition,E'select count(distinct m.organization_id), min(m.organization_id::text)::uuid\n    into v_cnt, v_org\n    from public.organization_memberships m\n   where m.user_id = v_actor and m.status = ''ACTIVE'';\n  if coalesce(v_cnt,0) = 0 then raise exception ''Không thuộc tổ chức nào'' using errcode=''42501''; end if;\n  if v_cnt > 1 then\n    select rb.organization_id into v_owner_org\n      from public.role_bindings rb\n      join public.organization_memberships m\n        on m.id = rb.membership_id and m.organization_id = rb.organization_id\n       and m.user_id = v_actor and m.status = ''ACTIVE''\n      join public.organization_roles r\n        on r.id = rb.role_id and r.name = ''Chủ sở hữu tổ chức''\n     limit 1;\n    if v_owner_org is not null then v_org := v_owner_org; end if;\n  end if;',E'v_org := app_private.working_organization_v1();');
  IF md5(definition) <> E'd1b160e64641f360749c7cca960737b6' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.create_cashbook_v1(text,numeric,date,text,text,uuid,text,text,boolean,uuid,uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.create_cashbook_v1(text,numeric,date,text,text,uuid,text,text,boolean,uuid,uuid)'::regprocedure);
  IF md5(definition) = E'194d42191d8d431528853e6849e592d1' THEN RETURN; END IF;
  IF md5(definition) <> E'6c5a68c165c9db8d0ac329cd2415b123' THEN RAISE EXCEPTION 'Live function changed: %',E'public.create_cashbook_v1(text,numeric,date,text,text,uuid,text,text,boolean,uuid,uuid)'; END IF;
  definition := replace(definition,E'if p_organization_id is not null then\n    v_org := p_organization_id;\n  elsif v_org_count = 1 then\n    select distinct m.organization_id into v_org\n      from public.organization_memberships m\n     where m.user_id=v_actor and m.status=''ACTIVE'';\n  else\n    -- Nhiều org: chỉ profiles.organization_id được phá thế hoà, và phải khớp\n    -- một membership ACTIVE — profile org sai/mốc thì coi như không có.\n    select p.organization_id into v_org\n      from public.profiles p\n     where p.id=v_actor\n       and p.organization_id is not null\n       and exists (select 1 from public.organization_memberships m\n                    where m.user_id=v_actor and m.status=''ACTIVE''\n                      and m.organization_id=p.organization_id);\n    if v_org is null then\n      raise exception ''Bạn thuộc % tổ chức đang hoạt động; phải chỉ rõ tổ chức tạo sổ quỹ (p_organization_id)'',\n        v_org_count using errcode=''42501''; end if;\n  end if;',E'v_org := coalesce(p_organization_id,app_private.working_organization_v1());');
  IF md5(definition) <> E'194d42191d8d431528853e6849e592d1' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.create_finance_evidence_upload_intent_v2(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.create_finance_evidence_upload_intent_v2(uuid)'::regprocedure);
  IF md5(definition) = E'cea9fc61803215196a2a1719125c53e1' THEN RETURN; END IF;
  IF md5(definition) <> E'd0841543ebc13e0e35e4e663f6feed6c' THEN RAISE EXCEPTION 'Live function changed: %',E'public.create_finance_evidence_upload_intent_v2(uuid)'; END IF;
  definition := replace(definition,E'SELECT m.organization_id INTO v_org FROM public.organization_memberships m\n    WHERE m.user_id = auth.uid() AND m.status = ''ACTIVE'' LIMIT 1;',E'v_org := app_private.working_organization_v1();');
  IF md5(definition) <> E'cea9fc61803215196a2a1719125c53e1' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.ie_compat_insert_v2(jsonb,jsonb)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.ie_compat_insert_v2(jsonb,jsonb)'::regprocedure);
  IF md5(definition) = E'79298fdc2aed8cbee2de06cfa1b774e4' THEN RETURN; END IF;
  IF md5(definition) <> E'c71d528be728ead127207b77250f1504' THEN RAISE EXCEPTION 'Live function changed: %',E'public.ie_compat_insert_v2(jsonb,jsonb)'; END IF;
  definition := replace(definition,E'SELECT m.organization_id INTO v_org\n        FROM public.organization_memberships m\n       WHERE m.user_id = auth.uid()\n         AND m.status = ''ACTIVE''\n       LIMIT 1;',E'v_org := app_private.working_organization_v1();');
  IF md5(definition) <> E'79298fdc2aed8cbee2de06cfa1b774e4' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- app_private.resolve_finance_actor_v2()
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'app_private.resolve_finance_actor_v2()'::regprocedure);
  IF md5(definition) = E'a8250632b24dd10865a177df1140bd33' THEN RETURN; END IF;
  IF md5(definition) <> E'b95ceecadba70fe6c24304ce8e5a7e4f' THEN RAISE EXCEPTION 'Live function changed: %',E'app_private.resolve_finance_actor_v2()'; END IF;
  definition := replace(definition,E'SELECT count(DISTINCT m.organization_id) INTO v_count\n  FROM public.organization_memberships m\n  WHERE m.user_id = v_uid\n    AND m.status = ''ACTIVE''\n    AND COALESCE(m.valid_from, ''-infinity''::timestamptz) <= now()\n    AND (m.valid_to IS NULL OR m.valid_to > now());\n\n  IF v_count = 0 THEN\n    RAISE EXCEPTION ''resolve_finance_actor_v2: no active membership for actor''\n      USING ERRCODE = ''42501'';\n  ELSIF v_count > 1 THEN\n    RAISE EXCEPTION ''resolve_finance_actor_v2: ambiguous membership; org-scoped resolution required''\n      USING ERRCODE = ''42501'';\n  END IF;\n\n  SELECT m.organization_id INTO v_org\n  FROM public.organization_memberships m\n  WHERE m.user_id = v_uid\n    AND m.status = ''ACTIVE''\n    AND COALESCE(m.valid_from, ''-infinity''::timestamptz) <= now()\n    AND (m.valid_to IS NULL OR m.valid_to > now())\n  LIMIT 1;',E'v_org := app_private.working_organization_v1();');
  IF md5(definition) <> E'a8250632b24dd10865a177df1140bd33' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.set_sale_bonus_cap_v1(numeric,uuid,text,uuid,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.set_sale_bonus_cap_v1(numeric,uuid,text,uuid,text)'::regprocedure);
  IF md5(definition) = E'79645453f0e2435b93bb58fc0e485c4a' THEN RETURN; END IF;
  IF md5(definition) <> E'68ba4c30fc4f623c2d634c6a6ace067a' THEN RAISE EXCEPTION 'Live function changed: %',E'public.set_sale_bonus_cap_v1(numeric,uuid,text,uuid,text)'; END IF;
  definition := replace(definition,E'SELECT m.organization_id INTO v_org FROM public.organization_memberships m\r\n       WHERE m.user_id = v_actor AND m.status = ''ACTIVE'' LIMIT 1;',E'v_org := app_private.working_organization_v1();');
  IF md5(definition) <> E'79645453f0e2435b93bb58fc0e485c4a' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.set_commission_tier_v1(integer,integer,numeric,uuid,text,uuid,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.set_commission_tier_v1(integer,integer,numeric,uuid,text,uuid,text)'::regprocedure);
  IF md5(definition) = E'bfc0120ea73be775e9742292e389fd2f' THEN RETURN; END IF;
  IF md5(definition) <> E'3b7070ff2ab786c834faf8a4bc8f4caf' THEN RAISE EXCEPTION 'Live function changed: %',E'public.set_commission_tier_v1(integer,integer,numeric,uuid,text,uuid,text)'; END IF;
  definition := replace(definition,E'SELECT m.organization_id INTO v_org FROM public.organization_memberships m\r\n       WHERE m.user_id = v_actor AND m.status = ''ACTIVE'' LIMIT 1;',E'v_org := app_private.working_organization_v1();');
  IF md5(definition) <> E'bfc0120ea73be775e9742292e389fd2f' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.set_utility_ceiling_v1(text,numeric,numeric,uuid,text,uuid,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.set_utility_ceiling_v1(text,numeric,numeric,uuid,text,uuid,text)'::regprocedure);
  IF md5(definition) = E'ef815f38388d9e46ec3c71cf2a86c84a' THEN RETURN; END IF;
  IF md5(definition) <> E'd34815ff21be27282515c7f8c8eb3c1f' THEN RAISE EXCEPTION 'Live function changed: %',E'public.set_utility_ceiling_v1(text,numeric,numeric,uuid,text,uuid,text)'; END IF;
  definition := replace(definition,E'(SELECT m.organization_id FROM public.organization_memberships m\n        WHERE m.user_id = v_actor AND m.status=''ACTIVE'' LIMIT 1)',E'app_private.working_organization_v1()');
  IF md5(definition) <> E'ef815f38388d9e46ec3c71cf2a86c84a' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.set_maintenance_rule_v1(text,numeric,numeric,integer,boolean,text,uuid,text,uuid,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.set_maintenance_rule_v1(text,numeric,numeric,integer,boolean,text,uuid,text,uuid,text)'::regprocedure);
  IF md5(definition) = E'88089b73a6e6ca6110f94c372459c4c8' THEN RETURN; END IF;
  IF md5(definition) <> E'06c169c7432d22cdd09bd150850a84ea' THEN RAISE EXCEPTION 'Live function changed: %',E'public.set_maintenance_rule_v1(text,numeric,numeric,integer,boolean,text,uuid,text,uuid,text)'; END IF;
  definition := replace(definition,E'(SELECT m.organization_id FROM public.organization_memberships m\n        WHERE m.user_id = v_actor AND m.status=''ACTIVE'' LIMIT 1)',E'app_private.working_organization_v1()');
  IF md5(definition) <> E'88089b73a6e6ca6110f94c372459c4c8' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public._autofill_org_salary()
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public._autofill_org_salary()'::regprocedure);
  IF md5(definition) = E'f62d7740896be46d9db1135a20547940' THEN RETURN; END IF;
  IF md5(definition) <> E'6472fd09cdb2ecd1c4a1b61c1c172baa' THEN RAISE EXCEPTION 'Live function changed: %',E'public._autofill_org_salary()'; END IF;
  definition := replace(definition,E'DECLARE\n  j jsonb := to_jsonb(NEW);\n  v uuid;\n  n_orgs int;\nBEGIN\n  IF NEW.organization_id IS NOT NULL THEN RETURN NEW; END IF;\n\n  -- salary_monthly: staff_id nằm ngay trên dòng.\n  IF (j->>''staff_id'') IS NOT NULL THEN\n    SELECT organization_id INTO v\n      FROM public.manager_salary_config\n     WHERE staff_id = (j->>''staff_id'')::uuid AND organization_id IS NOT NULL\n     ORDER BY is_active DESC, created_at DESC\n     LIMIT 1;\n\n    IF v IS NULL THEN\n      SELECT (array_agg(DISTINCT organization_id))[1], count(DISTINCT organization_id)\n        INTO v, n_orgs\n        FROM public.organization_memberships\n       WHERE user_id = (j->>''staff_id'')::uuid AND status = ''ACTIVE'';\n      IF n_orgs IS DISTINCT FROM 1 THEN v := NULL; END IF;\n    END IF;\n  END IF;\n\n  -- salary_adjustments: đi qua bản ghi lương tháng mà nó treo vào.\n  IF v IS NULL AND (j->>''salary_monthly_id'') IS NOT NULL THEN\n    SELECT organization_id INTO v\n      FROM public.salary_monthly\n     WHERE id = (j->>''salary_monthly_id'')::uuid;\n  END IF;\n\n  -- KHÔNG có nhánh fallback org mặc định: thà chặn dòng ghi còn hơn dán nhãn\n  -- đoán lên một dòng tiền. NOT NULL ở đây là cố ý gây lỗi cho người gọi.\n  IF v IS NULL THEN\n    RAISE EXCEPTION\n      ''Không suy được tổ chức cho dòng % — thiếu manager_salary_config cho nhân viên?'',\n      TG_TABLE_NAME\n      USING ERRCODE = ''23502'';\n  END IF;\n\n  NEW.organization_id := v;\n  RETURN NEW;\nEND;',E'DECLARE\n  j jsonb := to_jsonb(NEW);\n  v uuid;\n  v_orgs uuid[];\nBEGIN\n  -- A linked monthly row is authoritative, including historical employment.\n  IF j->>''salary_monthly_id'' IS NOT NULL THEN\n    SELECT organization_id INTO v FROM public.salary_monthly\n      WHERE id=(j->>''salary_monthly_id'')::uuid;\n    IF v IS NULL THEN RAISE EXCEPTION ''Bảng lương liên kết chưa có công ty rõ ràng'' USING ERRCODE=''22023''; END IF;\n  ELSIF auth.uid() IS NOT NULL AND j->>''staff_id'' IS NOT NULL AND j->>''period_month'' IS NOT NULL THEN\n    v := app_private.salary_subject_organization_v1((j->>''staff_id'')::uuid,(j->>''period_month'')::date,NULL,NEW.organization_id);\n  ELSIF NEW.organization_id IS NOT NULL THEN\n    -- Trusted background writers already supply an explicit organization.\n    RETURN NEW;\n  ELSIF j->>''staff_id'' IS NOT NULL THEN\n    SELECT array_agg(DISTINCT organization_id) INTO v_orgs\n      FROM public.manager_salary_config\n     WHERE staff_id=(j->>''staff_id'')::uuid AND organization_id IS NOT NULL AND is_active\n       AND effective_from<=(j->>''period_month'')::date\n       AND (effective_to IS NULL OR effective_to>=(j->>''period_month'')::date);\n    IF cardinality(v_orgs)=1 THEN v := v_orgs[1];\n    ELSIF cardinality(v_orgs)>1 THEN\n      RAISE EXCEPTION ''Nhân viên có cấu hình lương ở nhiều công ty; đường ghi phải chỉ rõ công ty'' USING ERRCODE=''22023'';\n    ELSE\n      SELECT array_agg(DISTINCT organization_id) INTO v_orgs\n        FROM public.organization_memberships\n       WHERE user_id=(j->>''staff_id'')::uuid\n         AND app_private.active_working_membership_v1(user_id,organization_id);\n      IF cardinality(v_orgs)=1 THEN v := v_orgs[1]; END IF;\n    END IF;\n  END IF;\n  IF v IS NULL THEN RAISE EXCEPTION ''Không xác định được công ty cho dòng lương'' USING ERRCODE=''22023''; END IF;\n  IF NEW.organization_id IS NOT NULL AND NEW.organization_id<>v THEN\n    RAISE EXCEPTION ''Công ty không khớp bảng lương đã có'' USING ERRCODE=''42501'';\n  END IF;\n  NEW.organization_id := v;\n  RETURN NEW;\nEND;');
  IF md5(definition) <> E'f62d7740896be46d9db1135a20547940' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- app_private.autofill_org_strict()
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'app_private.autofill_org_strict()'::regprocedure);
  IF md5(definition) = E'3c811872b3ae1cb17a93daf64997dae0' THEN RETURN; END IF;
  IF md5(definition) <> E'9a2edc1dca31c6a4cd25e3fbe41de464' THEN RAISE EXCEPTION 'Live function changed: %',E'app_private.autofill_org_strict()'; END IF;
  definition := replace(definition,E'  IF v_org IS NULL THEN\n    FOR i IN 1 .. array_length(nguoi, 1) LOOP',E'  IF v_org IS NULL AND TG_TABLE_NAME=''settings'' AND auth.uid() IS NOT NULL THEN\n    v_org := app_private.working_organization_v1();\n  END IF;\n  IF v_org IS NULL THEN\n    FOR i IN 1 .. array_length(nguoi, 1) LOOP');
  IF md5(definition) <> E'3c811872b3ae1cb17a93daf64997dae0' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public._autofill_org()
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public._autofill_org()'::regprocedure);
  IF md5(definition) = E'2efc1e4069562b34b03e996740160c7c' THEN RETURN; END IF;
  IF md5(definition) <> E'db63306771f7c32846f77c641e26edce' THEN RAISE EXCEPTION 'Live function changed: %',E'public._autofill_org()'; END IF;
  definition := replace(definition,E'  PROD constant uuid := ''aaaa0000-0000-4000-8000-000000000001'';',E'');
  definition := replace(definition,E'  -- Membership: CHỈ khi user thuộc đúng MỘT org ACTIVE (uuid-safe, không dùng min()).',E'  -- Parent record identity wins. An authenticated root insert uses the chosen company.\n  IF v IS NULL AND auth.uid() IS NOT NULL THEN v := app_private.working_organization_v1(); END IF;\n  -- Background writers without an authenticated actor may use one unambiguous owner membership.');
  definition := replace(definition,E'  IF v IS NULL THEN\n    BEGIN\n      INSERT INTO public.authorization_migration_exceptions(table_name, reason, details)\n      VALUES (TG_TABLE_NAME, ''PROD_DEFAULT_FALLBACK at insert'',\n              jsonb_build_object(''source'', ''_autofill_org'', ''at'', now(),\n                                 ''new_row_keys'', (SELECT jsonb_object_agg(k, j->k)\n                                                  FROM unnest(ARRAY[''id'',''user_id'',''building_id'',''room_id'',''contract_id'',''invoice_id'',''account_id'',''customer_id'']) AS k\n                                                  WHERE j ? k)));\n    EXCEPTION WHEN OTHERS THEN\n      NULL;\n    END;\n    v := PROD;\n  END IF;',E'  IF v IS NULL THEN RAISE EXCEPTION ''Không xác định được công ty cho bản ghi mới'' USING ERRCODE=''22023''; END IF;');
  IF md5(definition) <> E'2efc1e4069562b34b03e996740160c7c' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.set_membership_status_v1(uuid,text,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.set_membership_status_v1(uuid,text,text)'::regprocedure);
  IF md5(definition) = E'f83cdb6638f011a3d2db73d1e8744fbb' THEN RETURN; END IF;
  IF md5(definition) <> E'99098ec230f03522f30e8688f05ca4a5' THEN RAISE EXCEPTION 'Live function changed: %',E'public.set_membership_status_v1(uuid,text,text)'; END IF;
  definition := replace(definition,E'   where m.user_id = p_user_id',E'   where m.user_id = p_user_id\n     and m.organization_id = app_private.working_organization_v1()');
  definition := replace(definition,E'  -- org: nơi người thao tác giữ role Chủ sở hữu tổ chức và đối tượng là thành viên',E'  -- Serialize decisions about the last owner inside the selected organization.\n  perform 1 from public.organizations where id=app_private.working_organization_v1() for update;\n  -- Retain the existing owner/superadmin and self-change checks.');
  IF md5(definition) <> E'f83cdb6638f011a3d2db73d1e8744fbb' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.delete_staff_member(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.delete_staff_member(uuid)'::regprocedure);
  IF md5(definition) = E'8291dc1e8d2dc4ad0375f1334db91669' THEN RETURN; END IF;
  IF md5(definition) <> E'5c1e2b6fadd47bbca14eaa6b4fccb148' THEN RAISE EXCEPTION 'Live function changed: %',E'public.delete_staff_member(uuid)'; END IF;
  definition := replace(definition,E'  v_sa int := 0; v_memb int := 0;',E'  v_sa int := 0; v_memb int := 0; v_org uuid;');
  definition := replace(definition,E'  if p_staff_id = auth.uid() then',E'  v_org := app_private.working_organization_v1();\n  perform 1 from public.organizations where id=v_org for update;\n  if p_staff_id = auth.uid() then');
  definition := replace(definition,E'     where staff_id = p_staff_id and user_id = auth.uid()',E'     where staff_id = p_staff_id and user_id = auth.uid() and organization_id = v_org');
  definition := replace(definition,E'  -- 1) gỡ phân công legacy (trigger a80 đóng role_binding chuẩn hoá)',E'  -- A selected-company removal must retain the last effective owner.\n  if exists (\n    select 1 from public.role_bindings rb\n    join public.organization_memberships m on m.id=rb.membership_id and m.organization_id=rb.organization_id\n    join public.organization_roles r on r.id=rb.role_id and r.organization_id=rb.organization_id\n    where rb.organization_id=v_org and m.user_id=p_staff_id and r.name=''Chủ sở hữu tổ chức''\n      and coalesce(rb.valid_from,''-infinity''::timestamptz)<=now() and (rb.valid_to is null or rb.valid_to>now())\n  ) and not exists (\n    select 1 from public.role_bindings rb\n    join public.organization_memberships m on m.id=rb.membership_id and m.organization_id=rb.organization_id\n    join public.organization_roles r on r.id=rb.role_id and r.organization_id=rb.organization_id\n    where rb.organization_id=v_org and m.user_id<>p_staff_id and r.name=''Chủ sở hữu tổ chức''\n      and app_private.active_working_membership_v1(m.user_id,v_org)\n      and coalesce(rb.valid_from,''-infinity''::timestamptz)<=now() and (rb.valid_to is null or rb.valid_to>now())\n  ) then raise exception ''Không thể thu hồi CHỦ SỞ HỮU CUỐI CÙNG của công ty'' using errcode=''42501''; end if;\n  -- 1) gỡ phân công legacy (trigger a80 đóng role_binding chuẩn hoá)');
  definition := replace(definition,E'  delete from public.staff_assignments where staff_id = p_staff_id;',E'  delete from public.staff_assignments where staff_id = p_staff_id and organization_id = v_org;');
  definition := replace(definition,E'   where user_id = p_staff_id and status <> ''REVOKED'';',E'   where user_id = p_staff_id and organization_id = v_org and status <> ''REVOKED'';');
  definition := replace(definition,E'  delete from public.roles where user_id = p_staff_id;',E'  delete from public.roles where user_id = p_staff_id\n    and not exists (select 1 from public.organization_memberships m\n      where m.user_id=p_staff_id and m.organization_id<>v_org and m.status<>''REVOKED'');');
  definition := replace(definition,E'   where exists (select 1 from public.organization_memberships m',E'   where o.id=v_org and exists (select 1 from public.organization_memberships m');
  IF md5(definition) <> E'8291dc1e8d2dc4ad0375f1334db91669' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.salary_payout_v1(uuid,date,numeric,uuid,date,text,text,uuid,numeric)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.salary_payout_v1(uuid,date,numeric,uuid,date,text,text,uuid,numeric)'::regprocedure);
  IF md5(definition) = E'9e41721e7ff590f9014bc8ad6cc2d520' THEN RETURN; END IF;
  IF md5(definition) <> E'75d7f087387b593f470ad5f5442f985a' THEN RAISE EXCEPTION 'Live function changed: %',E'public.salary_payout_v1(uuid,date,numeric,uuid,date,text,text,uuid,numeric)'; END IF;
  definition := replace(definition,E'  select organization_id into v_org from public.manager_salary_config\n   where staff_id = p_staff_id and organization_id is not null\n   order by is_active desc, created_at desc limit 1;\n  if v_org is null then\n    select organization_id into v_org from public.organization_memberships\n     where user_id = p_staff_id and status=''ACTIVE'' limit 1;\n  end if;\n  if v_org is null then raise exception ''Không xác định được tổ chức của nhân viên'' using errcode=''42501''; end if;',E'  v_org := app_private.salary_subject_organization_v1(p_staff_id,p_period_month,p_account_id);');
  definition := replace(definition,E'    -- P5: clamp về phần còn nợ (mirror legacy; tránh excess ngoài ý muốn).',E'    if v_inv.organization_id is distinct from v_org then\n      raise exception ''Hoá đơn khấu trừ không thuộc công ty của bảng lương'' using errcode=''42501''; end if;\n    -- P5: clamp về phần còn nợ (mirror legacy; tránh excess ngoài ý muốn).');
  definition := replace(definition,E'    organization_id   = coalesce(public.salary_monthly.organization_id, excluded.organization_id);',E'    organization_id   = coalesce(public.salary_monthly.organization_id, excluded.organization_id)\n  where public.salary_monthly.organization_id = excluded.organization_id;\n  if not found then raise exception ''Bảng lương đã thuộc công ty khác'' using errcode=''40001''; end if;');
  IF md5(definition) <> E'9e41721e7ff590f9014bc8ad6cc2d520' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.lock_salary_month_v1(date,jsonb,text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.lock_salary_month_v1(date,jsonb,text)'::regprocedure);
  IF md5(definition) = E'b084db67a3033672fbb07795e1194619' THEN RETURN; END IF;
  IF md5(definition) <> E'4dd21e9c38ddb3249ce144a543d27764' THEN RAISE EXCEPTION 'Live function changed: %',E'public.lock_salary_month_v1(date,jsonb,text)'; END IF;
  definition := replace(definition,E'    select organization_id into v_org from public.manager_salary_config\n     where staff_id = v_first_staff and organization_id is not null\n     order by is_active desc, created_at desc limit 1;\n    if v_org is null then\n      select organization_id into v_org from public.organization_memberships\n       where user_id = v_first_staff and status=''ACTIVE'' limit 1;\n    end if;\n    if v_org is null then raise exception ''Không xác định được tổ chức của nhân viên''; end if;',E'    v_org := app_private.salary_subject_organization_v1(v_first_staff,p_period_month);');
  definition := replace(definition,E'    -- mọi staff còn lại phải cùng org',E'    -- Every persisted salary period, not only its staff membership, must match.\n    if exists (select 1 from jsonb_array_elements(p_managers) mg\n      where app_private.salary_subject_organization_v1(nullif(mg->>''staff_id'','''')::uuid,p_period_month) is distinct from v_org) then\n      raise exception ''Danh sách bảng lương chứa công ty khác'' using errcode=''42501''; end if;\n    if exists (select 1 from jsonb_array_elements(p_managers) mg\n      cross join lateral jsonb_array_elements_text(coalesce(mg->''commission_voucher_ids'',''[]''::jsonb)) ids(id)\n      join public.income_expenses ie on ie.id=nullif(ids.id,'''')::uuid\n      where ie.organization_id is distinct from v_org) then\n      raise exception ''Phiếu hoa hồng không thuộc công ty của bảng lương'' using errcode=''42501''; end if;\n    -- mọi staff còn lại phải cùng org');
  definition := replace(definition,E'     where staff_id = v_staff and is_active = true',E'     where staff_id = v_staff and organization_id = v_org and is_active = true');
  definition := replace(definition,E'      select user_id into v_owner from public.super_admins order by created_at limit 1;',E'      select (array_agg(distinct user_id))[1] into v_owner from public.organization_memberships\n       where organization_id=v_org and member_type=''OWNER''\n         and app_private.active_working_membership_v1(user_id,v_org)\n       having count(distinct user_id)=1;');
  definition := replace(definition,E'    returning id into v_monthly_id;',E'    where public.salary_monthly.organization_id = excluded.organization_id\n    returning id into v_monthly_id;\n    if not found then raise exception ''Bảng lương đã thuộc công ty khác'' using errcode=''40001''; end if;');
  IF md5(definition) <> E'b084db67a3033672fbb07795e1194619' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.unlock_salary_month_v1(date,uuid[],text)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.unlock_salary_month_v1(date,uuid[],text)'::regprocedure);
  IF md5(definition) = E'fdc4351a6a1ec48b20d971958d0d1cc4' THEN RETURN; END IF;
  IF md5(definition) <> E'6496dc3c3beb8cc043e70d6f814fcc3c' THEN RAISE EXCEPTION 'Live function changed: %',E'public.unlock_salary_month_v1(date,uuid[],text)'; END IF;
  definition := replace(definition,E'  select organization_id into v_org from public.organization_memberships\n   where user_id = p_staff_ids[1] and status=''ACTIVE'' limit 1;\n  if v_org is null then\n    select organization_id into v_org from public.manager_salary_config\n     where staff_id = p_staff_ids[1] and organization_id is not null order by created_at desc limit 1;\n  end if;\n  if v_org is null then raise exception ''Không xác định được tổ chức của nhân viên''; end if;',E'  v_org := app_private.salary_subject_organization_v1(p_staff_ids[1],p_period_month);\n  if exists (select 1 from unnest(p_staff_ids) ids(staff_id)\n    where app_private.salary_subject_organization_v1(ids.staff_id,p_period_month) is distinct from v_org) then\n    raise exception ''Danh sách bảng lương chứa công ty khác'' using errcode=''42501''; end if;');
  definition := replace(definition,E'   where period_month = p_period_month and staff_id = any(p_staff_ids) and status = ''LOCKED''',E'   where organization_id = v_org and period_month = p_period_month and staff_id = any(p_staff_ids) and status = ''LOCKED''');
  definition := replace(definition,E'   where period_month = p_period_month\n     and staff_id = any(p_staff_ids)',E'   where organization_id = v_org and period_month = p_period_month\n     and staff_id = any(p_staff_ids)');
  IF md5(definition) <> E'fdc4351a6a1ec48b20d971958d0d1cc4' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid)'::regprocedure);
  IF md5(definition) = E'58e2f511bdccf89260441aa122532345' THEN RETURN; END IF;
  IF md5(definition) <> E'b6a36737c5fc1aeadf759f89aee552ee' THEN RAISE EXCEPTION 'Live function changed: %',E'public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid)'; END IF;
  definition := replace(definition,E'public._termination_ensure_type(v_owner, ''expense'', v_type_nm)',E'app_private.ensure_termination_type_in_org_v1(v_owner, ''expense'', v_type_nm,v_org)');
  definition := replace(definition,E'WHERE id = p_account_id AND deleted_at IS NULL',E'WHERE id = p_account_id AND organization_id = v_org AND deleted_at IS NULL');
  definition := replace(definition,E'WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE ''%Thu''',E'WHERE user_id = auth.uid() AND organization_id = v_org AND deleted_at IS NULL AND btrim(name) LIKE ''%Thu''');
  IF md5(definition) <> E'58e2f511bdccf89260441aa122532345' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)'::regprocedure);
  IF md5(definition) = E'6e092a2c9171c10b89d8ce5408bba866' THEN RETURN; END IF;
  IF md5(definition) <> E'6545b554ba8732eb4362b95fbcd040e4' THEN RAISE EXCEPTION 'Live function changed: %',E'public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean)'; END IF;
  definition := replace(definition,E'public.resolve_fixed_expense_type(v_owner, p_category_key)',E'app_private.resolve_fixed_expense_type_in_org_v1(v_owner, p_category_key,v_org)');
  definition := replace(definition,E'WHERE id = p_account_id AND deleted_at IS NULL',E'WHERE id = p_account_id AND organization_id = v_org AND deleted_at IS NULL');
  definition := replace(definition,E'WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE ''%Thu''',E'WHERE user_id = auth.uid() AND organization_id = v_org AND deleted_at IS NULL AND btrim(name) LIKE ''%Thu''');
  definition := replace(definition,E'JOIN accounts a ON a.id = fa.default_account_id AND a.deleted_at IS NULL',E'JOIN accounts a ON a.id = fa.default_account_id AND a.organization_id = v_org AND a.deleted_at IS NULL');
  IF md5(definition) <> E'6e092a2c9171c10b89d8ce5408bba866' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.adopt_voucher_attachments_as_evidence_v2(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.adopt_voucher_attachments_as_evidence_v2(uuid)'::regprocedure);
  IF md5(definition) = E'b1e67cd92391db80064ba31f52319d46' THEN RETURN; END IF;
  IF md5(definition) <> E'f2d71ddb1733fd863276efa9c31c0a18' THEN RAISE EXCEPTION 'Live function changed: %',E'public.adopt_voucher_attachments_as_evidence_v2(uuid)'; END IF;
  definition := replace(definition,E'INSERT INTO app_private.storage_object_links\n      (bucket_id, object_name, organization_id, owner_user_id, derivation)\n    VALUES (v_bucket, v_object, v_ie.organization_id, v_actor.user_id, ''FINANCE_V2_EVIDENCE'')\n    ON CONFLICT DO NOTHING;',E'IF v_bucket = ''income-expense-attachments'' THEN PERFORM app_private.bind_finance_storage_org_v1(v_ie.organization_id,v_bucket,v_object); ELSE INSERT INTO app_private.storage_object_links\n      (bucket_id, object_name, organization_id, owner_user_id, derivation)\n    VALUES (v_bucket, v_object, v_ie.organization_id, v_actor.user_id, ''FINANCE_V2_EVIDENCE'')\n    ON CONFLICT DO NOTHING; END IF;');
  definition := replace(definition,E'IF v_row.state <> ''FINALIZED'' THEN',E'IF v_bucket = ''income-expense-attachments'' AND v_row.state = ''ATTACHED'' THEN\n      PERFORM app_private.bind_finance_storage_org_v1(v_ie.organization_id,v_bucket,v_object);\n    END IF;\n    IF v_row.state <> ''FINALIZED'' THEN');
  IF md5(definition) <> E'b1e67cd92391db80064ba31f52319d46' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

-- public.finalize_finance_evidence_v2(uuid)
DO $repair$ DECLARE definition text; BEGIN
  definition := pg_get_functiondef(E'public.finalize_finance_evidence_v2(uuid)'::regprocedure);
  IF md5(definition) = E'109d2bea650e8902baf3a495e31bb952' THEN RETURN; END IF;
  IF md5(definition) <> E'64ea72286787e0877f4c774af9cb4247' THEN RAISE EXCEPTION 'Live function changed: %',E'public.finalize_finance_evidence_v2(uuid)'; END IF;
  definition := replace(definition,E'INSERT INTO app_private.storage_object_links (bucket_id, object_name, organization_id, owner_user_id, derivation)\n  VALUES (v_row.bucket_id, v_row.object_name, v_row.organization_id, auth.uid(), ''FINANCE_V2_EVIDENCE'')\n  ON CONFLICT DO NOTHING;',E'IF v_row.bucket_id = ''income-expense-attachments'' THEN PERFORM app_private.bind_finance_storage_org_v1(v_row.organization_id,v_row.bucket_id,v_row.object_name); ELSE INSERT INTO app_private.storage_object_links (bucket_id, object_name, organization_id, owner_user_id, derivation)\n  VALUES (v_row.bucket_id, v_row.object_name, v_row.organization_id, auth.uid(), ''FINANCE_V2_EVIDENCE'')\n  ON CONFLICT DO NOTHING; END IF;');
  definition := replace(definition,E'IF v_row.state = ''FINALIZED'' THEN',E'IF v_row.state = ''FINALIZED'' THEN\n    IF v_row.bucket_id = ''income-expense-attachments'' THEN PERFORM app_private.bind_finance_storage_org_v1(v_row.organization_id,v_row.bucket_id,v_row.object_name); END IF;');
  IF md5(definition) <> E'109d2bea650e8902baf3a495e31bb952' THEN RAISE EXCEPTION 'Patch integrity failure'; END IF;
  EXECUTE definition;
END $repair$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.buildings'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT ON public.buildings FOR EACH ROW EXECUTE FUNCTION _autofill_org()' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.buildings'::regclass AND NOT tgisinternal;
  IF actual<>E'a82926e6d5cc64e4c7b5d29e84788b11' THEN RAISE EXCEPTION 'Live triggers changed on public.buildings'; END IF;
  EXECUTE E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT ON public.buildings FOR EACH ROW EXECUTE FUNCTION public._autofill_org()';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.areas'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT ON public.areas FOR EACH ROW EXECUTE FUNCTION _autofill_org()' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.areas'::regclass AND NOT tgisinternal;
  IF actual<>E'5ccfa6ce0a824a75bddad79af0e9411d' THEN RAISE EXCEPTION 'Live triggers changed on public.areas'; END IF;
  EXECUTE E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT ON public.areas FOR EACH ROW EXECUTE FUNCTION public._autofill_org()';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.building_utility_accounts'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT ON public.building_utility_accounts FOR EACH ROW EXECUTE FUNCTION _autofill_org()' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.building_utility_accounts'::regclass AND NOT tgisinternal;
  IF actual<>E'7de038ebf3383862882eb8ef2801b9ab' THEN RAISE EXCEPTION 'Live triggers changed on public.building_utility_accounts'; END IF;
  EXECUTE E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT ON public.building_utility_accounts FOR EACH ROW EXECUTE FUNCTION public._autofill_org()';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.area_buildings'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, area_id, building_id ON public.area_buildings FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''area_id'', ''areas'', ''building_id'', ''buildings'')' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.area_buildings'::regclass AND NOT tgisinternal;
  IF actual<>E'688f695eee9b50cf2191be41e1e20415' THEN RAISE EXCEPTION 'Live triggers changed on public.area_buildings'; END IF;
  EXECUTE E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, area_id, building_id ON public.area_buildings FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''area_id'', ''areas'', ''building_id'', ''buildings'')';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.asset_handovers'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, contract_id ON public.asset_handovers FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''contract_id'', ''contracts'')' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.asset_handovers'::regclass AND NOT tgisinternal;
  IF actual<>E'beae1763ff38773519bb68ffdf1ba98a' THEN RAISE EXCEPTION 'Live triggers changed on public.asset_handovers'; END IF;
  EXECUTE E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, contract_id ON public.asset_handovers FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''contract_id'', ''contracts'')';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.asset_movements'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, asset_id, from_room_id, to_room_id ON public.asset_movements FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''asset_id'', ''assets'', ''from_room_id'', ''rooms'', ''to_room_id'', ''rooms'')' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.asset_movements'::regclass AND NOT tgisinternal;
  IF actual<>E'c5555a49ec06c593546346c07930ee9a' THEN RAISE EXCEPTION 'Live triggers changed on public.asset_movements'; END IF;
  EXECUTE E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, asset_id, from_room_id, to_room_id ON public.asset_movements FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''asset_id'', ''assets'', ''from_room_id'', ''rooms'', ''to_room_id'', ''rooms'')';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.asset_maintenance'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, asset_id ON public.asset_maintenance FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''asset_id'', ''assets'')' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.asset_maintenance'::regclass AND NOT tgisinternal;
  IF actual<>E'39c283e5dd0dd4cac440df817cf39674' THEN RAISE EXCEPTION 'Live triggers changed on public.asset_maintenance'; END IF;
  EXECUTE E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, asset_id ON public.asset_maintenance FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''asset_id'', ''assets'')';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.asset_warehouses'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, building_id ON public.asset_warehouses FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''building_id'', ''buildings'')' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.asset_warehouses'::regclass AND NOT tgisinternal;
  IF actual<>E'11fe3059dbb3d357c6439ee3d6a2f0fd' THEN RAISE EXCEPTION 'Live triggers changed on public.asset_warehouses'; END IF;
  EXECUTE E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, building_id ON public.asset_warehouses FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''building_id'', ''buildings'')';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.auto_debt_config'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, building_id ON public.auto_debt_config FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''building_id'', ''buildings'')' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.auto_debt_config'::regclass AND NOT tgisinternal;
  IF actual<>E'86772735f243c5e257cb8fbf8d75275d' THEN RAISE EXCEPTION 'Live triggers changed on public.auto_debt_config'; END IF;
  EXECUTE E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, building_id ON public.auto_debt_config FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''building_id'', ''buildings'')';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.hotlines'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id ON public.hotlines FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1()' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.hotlines'::regclass AND NOT tgisinternal;
  IF actual<>E'c4af0e6998b12462062db3748c09baa0' THEN RAISE EXCEPTION 'Live triggers changed on public.hotlines'; END IF;
  EXECUTE E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id ON public.hotlines FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1()';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.job_groups'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id ON public.job_groups FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1()' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.job_groups'::regclass AND NOT tgisinternal;
  IF actual<>E'a3d983640ed01c00a1d01c906872d99b' THEN RAISE EXCEPTION 'Live triggers changed on public.job_groups'; END IF;
  EXECUTE E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id ON public.job_groups FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1()';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.job_types'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, job_group_id, default_department_id ON public.job_types FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''job_group_id'', ''job_groups'', ''default_department_id'', ''departments'')' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.job_types'::regclass AND NOT tgisinternal;
  IF actual<>E'0337c8532d8e146187c94a40367f865c' THEN RAISE EXCEPTION 'Live triggers changed on public.job_types'; END IF;
  EXECUTE E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, job_group_id, default_department_id ON public.job_types FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''job_group_id'', ''job_groups'', ''default_department_id'', ''departments'')';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.lead_activities'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, lead_id ON public.lead_activities FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''lead_id'', ''leads'')' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.lead_activities'::regclass AND NOT tgisinternal;
  IF actual<>E'da3202e293748de5c2b69822bba8e4ca' THEN RAISE EXCEPTION 'Live triggers changed on public.lead_activities'; END IF;
  EXECUTE E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, lead_id ON public.lead_activities FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''lead_id'', ''leads'')';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.salary_work_ledger_snapshot'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, salary_monthly_id ON public.salary_work_ledger_snapshot FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''salary_monthly_id'', ''salary_monthly'')' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.salary_work_ledger_snapshot'::regclass AND NOT tgisinternal;
  IF actual<>E'd41d8cd98f00b204e9800998ecf8427e' THEN RAISE EXCEPTION 'Live triggers changed on public.salary_work_ledger_snapshot'; END IF;
  EXECUTE E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, salary_monthly_id ON public.salary_work_ledger_snapshot FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''salary_monthly_id'', ''salary_monthly'')';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.service_quotas'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id ON public.service_quotas FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1()' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.service_quotas'::regclass AND NOT tgisinternal;
  IF actual<>E'ce57301bcbf8edd4b39dbf54accc6fd7' THEN RAISE EXCEPTION 'Live triggers changed on public.service_quotas'; END IF;
  EXECUTE E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id ON public.service_quotas FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1()';
END $trigger_guard$;

DO $trigger_guard$ DECLARE actual text; BEGIN
  SELECT pg_get_triggerdef(oid) INTO actual FROM pg_trigger WHERE tgrelid='public.service_quota_tiers'::regclass AND tgname='a10_working_organization_insert';
  IF actual IS NOT NULL THEN
    IF actual<>E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, quota_id ON public.service_quota_tiers FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''quota_id'', ''service_quotas'')' THEN RAISE EXCEPTION 'Existing organization trigger differs'; END IF;
    RETURN;
  END IF;
  SELECT md5(coalesce(string_agg(pg_get_triggerdef(oid),E'\n' ORDER BY tgname),'')) INTO actual
    FROM pg_trigger WHERE tgrelid='public.service_quota_tiers'::regclass AND NOT tgisinternal;
  IF actual<>E'd41d8cd98f00b204e9800998ecf8427e' THEN RAISE EXCEPTION 'Live triggers changed on public.service_quota_tiers'; END IF;
  EXECUTE E'CREATE TRIGGER a10_working_organization_insert BEFORE INSERT OR UPDATE OF organization_id, quota_id ON public.service_quota_tiers FOR EACH ROW EXECUTE FUNCTION app_private.fill_business_organization_v1(''quota_id'', ''service_quotas'')';
END $trigger_guard$;

ROLLBACK;
