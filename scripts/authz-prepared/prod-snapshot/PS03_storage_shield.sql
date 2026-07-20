-- =====================================================================
-- PS03_storage_shield.sql — SNAPSHOT sinh tự động từ PROD ngày 2026-07-19
-- KHÔNG SỬA TAY. Dùng cho khôi phục thảm hoạ / dựng lại môi trường.
-- Nguồn: catalog PROD (pg_proc / pg_trigger / pg_policies / pg_indexes /
--        pg_constraint / information_schema.columns) — không phải viết tay.
-- =====================================================================
--
-- LÝ DO TỒN TẠI: toàn bộ "lá chắn storage" (org-isolation cho bucket PII) đang
-- sống trong DB nhưng KHÔNG có file SQL nào trên main → mất DB là mất luôn.
--
-- DANH SÁCH ĐỐI TƯỢNG TRONG FILE (46 đối tượng)
--   [1] BẢNG (1)
--       - app_private.storage_object_links (6 cột)
--   [2] CONSTRAINT (1)
--       - storage_object_links_pkey  PRIMARY KEY (bucket_id, object_name)
--   [3] INDEX (1)
--       - storage_object_links_pkey  — index DUY NHẤT của bảng, do PRIMARY KEY
--         tạo ngầm. KHÔNG phát riêng CREATE INDEX (sẽ lỗi trùng tên); mục [2]
--         đã bao trọn. pg_indexes trả đúng 1 dòng và nó chính là dòng này.
--   [4] HÀM (6) — theo thứ tự phụ thuộc
--       - public.my_org_ids()
--       - public.is_super_admin()
--       - public.current_visible_owner_ids()
--       - app_private.derive_uploader_org_v1(uuid)
--       - app_private.can_read_storage_object_v1(text, text)
--       - app_private.storage_object_link_maintain()
--   [5] TRIGGER (1)
--       - a00_storage_object_link  BEFORE INSERT ON storage.objects
--   [6] POLICY trên storage.objects (36) — 35 PERMISSIVE + 1 RESTRICTIVE
--       (RESTRICTIVE = storage_pii_org_isolation, chính là lá chắn)
--   [7] GRANT/REVOKE tường minh (7 khối) — 6 hàm + 1 bảng
--
-- KHÔNG NẰM TRONG FILE (không dump được / ngoài phạm vi) — xem followups:
--   - storage.objects, storage.buckets, storage.foldername(), storage.protect_delete(),
--     storage.update_updated_at_column(), auth.uid(), auth.role()
--     → do Supabase quản lý (managed schema). File này GIẢ ĐỊNH chúng đã có.
--   - 2 trigger Supabase gốc trên storage.objects: protect_objects_delete,
--     update_objects_updated_at → của Supabase, không phải của app, không dump.
--   - Bảng nền mà các hàm đọc: public.organization_memberships, public.super_admins,
--     public.staff_assignments → thuộc migration lõi trong supabase/migrations/.
--   - ACL schema app_private cho role ie_canonical_writer → thuộc snapshot khác.
--   - DỮ LIỆU của app_private.storage_object_links (2.447 dòng lúc snapshot):
--     file này chỉ dựng CẤU TRÚC. Sau restore phải backfill lại link (xem followups).
--   - 3 hàm public.* ở mục [4] cũng có mặt trong supabase/migrations/ (bản migration
--     có thể đã trôi); bản trong file này là ĐỊNH NGHĨA THẬT ĐANG CHẠY TRÊN PROD và
--     là bản chuẩn cho DR. Đều CREATE OR REPLACE nên chạy trùng vô hại.
--
-- CÁCH CHẠY LẠI (idempotent — chạy nhiều lần không lỗi):
--   psql "$PROD" -v ON_ERROR_STOP=1 -f scripts/authz-prepared/prod-snapshot/PS03_storage_shield.sql
--   Yêu cầu: role postgres (owner app_private) và có quyền tạo policy trên
--   storage.objects (owner thật là supabase_storage_admin — trên Supabase role
--   postgres là member nên chạy được; nếu không, mục [5]/[6] sẽ báo lỗi quyền).
--   Sau khi chạy: node scripts/check-view-invoker.mjs (không đụng view nhưng
--   giữ đúng quy trình repo).
-- =====================================================================

\set ON_ERROR_STOP on

-- search_path đúng như phiên đã dump: pg_policies deparse các hàm public.* dạng
-- KHÔNG qualify (is_super_admin(), current_visible_owner_ids()), nên phiên chạy
-- lại phải nhìn thấy schema public để CREATE POLICY parse ra đúng hàm.
SET search_path = public, app_private, storage, pg_catalog;

BEGIN;

-- ---------------------------------------------------------------------
-- [0] Tiền đề: schema app_private
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app_private;

-- ---------------------------------------------------------------------
-- [1] BẢNG app_private.storage_object_links
--     Sổ liên kết object storage -> org/uploader; trigger a00 ghi khi upload,
--     can_read_storage_object_v1 đọc để chặn đọc chéo tenant.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_private.storage_object_links (
  bucket_id       text        NOT NULL,
  object_name     text        NOT NULL,
  organization_id uuid        NULL,
  owner_user_id   uuid        NULL,
  derivation      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- [2] CONSTRAINT (+ [3] index ngầm storage_object_links_pkey)
-- ---------------------------------------------------------------------
DO $ps03$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'storage_object_links_pkey'
       AND conrelid = 'app_private.storage_object_links'::regclass
  ) THEN
    ALTER TABLE app_private.storage_object_links
      ADD CONSTRAINT storage_object_links_pkey PRIMARY KEY (bucket_id, object_name);
  END IF;
END
$ps03$;

-- ---------------------------------------------------------------------
-- [4] HÀM (6) — thứ tự phụ thuộc: helper public.* -> app_private.*
-- ---------------------------------------------------------------------
-- [4.1] public.my_org_ids() — org của user hiện tại (dùng bởi can_read_storage_object_v1)
CREATE OR REPLACE FUNCTION public.my_org_ids()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE(array_agg(organization_id), '{}'::uuid[])
  FROM public.organization_memberships
  WHERE user_id = auth.uid() AND status = 'ACTIVE';
$function$;

-- [4.2] public.is_super_admin() — dùng bởi policy storage_objects_super_admin_all
CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()
  );
$function$;

-- [4.3] public.current_visible_owner_ids() — dùng bởi policy "Tenant can read shared templates"
CREATE OR REPLACE FUNCTION public.current_visible_owner_ids()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH my_employers AS (
    SELECT user_id
    FROM public.staff_assignments
    WHERE staff_id = auth.uid()
  )
  SELECT ARRAY(
    -- self
    SELECT auth.uid()
    UNION
    -- my employers (employers I'm staff under)
    SELECT user_id FROM my_employers
    UNION
    -- my own staff (any one who has me as their employer)
    SELECT staff_id FROM public.staff_assignments
      WHERE user_id = auth.uid()
    UNION
    -- co-staff: anyone who works under the same employers as me
    SELECT staff_id FROM public.staff_assignments
      WHERE user_id IN (SELECT user_id FROM my_employers)
  );
$function$;

-- [4.4] app_private.derive_uploader_org_v1(uuid) — suy ra org của người upload
CREATE OR REPLACE FUNCTION app_private.derive_uploader_org_v1(p_uploader uuid)
 RETURNS TABLE(org uuid, how text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  with owner_org as (
    select m.organization_id
      from public.organization_memberships m
     where m.user_id = p_uploader and m.status = 'ACTIVE' and m.member_type = 'OWNER'
     group by m.organization_id
  ),
  single_owner as (
    select case when (select count(*) from owner_org) = 1
                then (select organization_id from owner_org) end as oid
  ),
  single_mem as (
    select case when (select count(distinct m.organization_id)
                        from public.organization_memberships m
                       where m.user_id = p_uploader and m.status='ACTIVE') = 1
                then (select distinct m.organization_id
                        from public.organization_memberships m
                       where m.user_id = p_uploader and m.status='ACTIVE') end as oid
  )
  select coalesce((select oid from single_owner), (select oid from single_mem)) as org,
         case when (select oid from single_owner) is not null then 'uploader_owner_org'
              when (select oid from single_mem)   is not null then 'uploader_single_org'
              else 'quarantine' end as how;
$function$;

-- [4.5] app_private.can_read_storage_object_v1(text,text) — vị ngữ của RESTRICTIVE policy storage_pii_org_isolation
CREATE OR REPLACE FUNCTION app_private.can_read_storage_object_v1(p_bucket text, p_name text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
  select
    p_bucket not in ('customer-id-cards','customer-images','income-expense-attachments',
                     'job-attachments','payment-receipts','meter-images','document-templates')
    or (select public.is_super_admin())
    or exists (
      select 1 from app_private.storage_object_links l
       where l.bucket_id = p_bucket and l.object_name = p_name
         and ( (l.organization_id is not null and l.organization_id in (select unnest(public.my_org_ids())))
            or (l.organization_id is null and l.owner_user_id = (select auth.uid())) )
    );
$function$;

-- [4.6] app_private.storage_object_link_maintain() — hàm trigger a00_storage_object_link
CREATE OR REPLACE FUNCTION app_private.storage_object_link_maintain()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
declare v_uploader uuid; v_org uuid; v_how text;
begin
  if new.bucket_id not in ('customer-id-cards','customer-images','income-expense-attachments',
                           'job-attachments','payment-receipts','meter-images','document-templates') then
    return new;
  end if;
  v_uploader := coalesce(new.owner_id::uuid, new.owner, nullif(split_part(new.name,'/',1),'')::uuid);
  select org, how into v_org, v_how from app_private.derive_uploader_org_v1(v_uploader);
  insert into app_private.storage_object_links (bucket_id, object_name, organization_id, owner_user_id, derivation)
  values (new.bucket_id, new.name, v_org, v_uploader, coalesce(v_how,'quarantine'))
  on conflict (bucket_id, object_name) do update set organization_id=excluded.organization_id,
    owner_user_id=excluded.owner_user_id, derivation=excluded.derivation;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------
-- [5] TRIGGER a00_storage_object_link ON storage.objects
--     Tên bắt đầu bằng a00 để chạy TRƯỚC mọi trigger khác của storage.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TRIGGER a00_storage_object_link
  BEFORE INSERT ON storage.objects
  FOR EACH ROW EXECUTE FUNCTION app_private.storage_object_link_maintain();

-- ---------------------------------------------------------------------
-- [6] POLICY trên storage.objects (36)
--     RLS trên storage.objects do Supabase bật sẵn; bọc DO để không chết nếu
--     phiên chạy không sở hữu bảng (owner thật: supabase_storage_admin).
-- ---------------------------------------------------------------------
DO $ps03$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.objects'::regclass) THEN
    EXECUTE 'ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PS03: khong du quyen bat RLS tren storage.objects — bo qua (Supabase thuong da bat san)';
END
$ps03$;

DROP POLICY IF EXISTS "Authenticated delete room sale images" ON storage.objects;
CREATE POLICY "Authenticated delete room sale images" ON storage.objects
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING ((bucket_id = 'room-sale-images'::text));

DROP POLICY IF EXISTS "Authenticated update room sale images" ON storage.objects;
CREATE POLICY "Authenticated update room sale images" ON storage.objects
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((bucket_id = 'room-sale-images'::text));

DROP POLICY IF EXISTS "Authenticated upload room sale images" ON storage.objects;
CREATE POLICY "Authenticated upload room sale images" ON storage.objects
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((bucket_id = 'room-sale-images'::text));

DROP POLICY IF EXISTS "Authenticated users can upload UI references" ON storage.objects;
CREATE POLICY "Authenticated users can upload UI references" ON storage.objects
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((bucket_id = 'ui-references'::text));

DROP POLICY IF EXISTS "Authenticated users can upload customer id cards" ON storage.objects;
CREATE POLICY "Authenticated users can upload customer id cards" ON storage.objects
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((bucket_id = 'customer-id-cards'::text));

DROP POLICY IF EXISTS "Authenticated users can upload customer images" ON storage.objects;
CREATE POLICY "Authenticated users can upload customer images" ON storage.objects
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((bucket_id = 'customer-images'::text));

DROP POLICY IF EXISTS "Authenticated users can upload meter images" ON storage.objects;
CREATE POLICY "Authenticated users can upload meter images" ON storage.objects
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((bucket_id = 'meter-images'::text));

DROP POLICY IF EXISTS "Public view room sale images" ON storage.objects;
CREATE POLICY "Public view room sale images" ON storage.objects
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((bucket_id = 'room-sale-images'::text));

DROP POLICY IF EXISTS "Tenant can read shared templates" ON storage.objects;
CREATE POLICY "Tenant can read shared templates" ON storage.objects
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (((bucket_id = 'document-templates'::text) AND (((storage.foldername(name))[1] = (auth.uid())::text) OR (((storage.foldername(name))[1])::uuid = ANY (current_visible_owner_ids())))));

DROP POLICY IF EXISTS "Users can delete customer id cards" ON storage.objects;
CREATE POLICY "Users can delete customer id cards" ON storage.objects
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING ((bucket_id = 'customer-id-cards'::text));

DROP POLICY IF EXISTS "Users can delete customer images" ON storage.objects;
CREATE POLICY "Users can delete customer images" ON storage.objects
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING ((bucket_id = 'customer-images'::text));

DROP POLICY IF EXISTS "Users can delete own UI references" ON storage.objects;
CREATE POLICY "Users can delete own UI references" ON storage.objects
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (((bucket_id = 'ui-references'::text) AND (auth.uid() = owner)));

DROP POLICY IF EXISTS "Users can delete own job attachments" ON storage.objects;
CREATE POLICY "Users can delete own job attachments" ON storage.objects
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (((bucket_id = 'job-attachments'::text) AND (auth.role() = 'authenticated'::text)));

DROP POLICY IF EXISTS "Users can delete own meter images" ON storage.objects;
CREATE POLICY "Users can delete own meter images" ON storage.objects
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING ((bucket_id = 'meter-images'::text));

DROP POLICY IF EXISTS "Users can delete own payment receipts" ON storage.objects;
CREATE POLICY "Users can delete own payment receipts" ON storage.objects
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (((bucket_id = 'payment-receipts'::text) AND (auth.role() = 'authenticated'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS "Users can delete own templates" ON storage.objects;
CREATE POLICY "Users can delete own templates" ON storage.objects
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (((bucket_id = 'document-templates'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS "Users can update customer id cards" ON storage.objects;
CREATE POLICY "Users can update customer id cards" ON storage.objects
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((bucket_id = 'customer-id-cards'::text));

DROP POLICY IF EXISTS "Users can update customer images" ON storage.objects;
CREATE POLICY "Users can update customer images" ON storage.objects
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((bucket_id = 'customer-images'::text));

DROP POLICY IF EXISTS "Users can update own meter images" ON storage.objects;
CREATE POLICY "Users can update own meter images" ON storage.objects
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((bucket_id = 'meter-images'::text));

DROP POLICY IF EXISTS "Users can update own payment receipts" ON storage.objects;
CREATE POLICY "Users can update own payment receipts" ON storage.objects
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (((bucket_id = 'payment-receipts'::text) AND (auth.role() = 'authenticated'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS "Users can update own templates" ON storage.objects;
CREATE POLICY "Users can update own templates" ON storage.objects
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING (((bucket_id = 'document-templates'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS "Users can upload job attachments" ON storage.objects;
CREATE POLICY "Users can upload job attachments" ON storage.objects
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (((bucket_id = 'job-attachments'::text) AND (auth.role() = 'authenticated'::text)));

DROP POLICY IF EXISTS "Users can upload own templates" ON storage.objects;
CREATE POLICY "Users can upload own templates" ON storage.objects
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (((bucket_id = 'document-templates'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS "Users can upload payment receipts" ON storage.objects;
CREATE POLICY "Users can upload payment receipts" ON storage.objects
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (((bucket_id = 'payment-receipts'::text) AND (auth.role() = 'authenticated'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS customer_id_cards_select_authenticated ON storage.objects;
CREATE POLICY customer_id_cards_select_authenticated ON storage.objects
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((bucket_id = 'customer-id-cards'::text));

DROP POLICY IF EXISTS customer_images_select_authenticated ON storage.objects;
CREATE POLICY customer_images_select_authenticated ON storage.objects
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((bucket_id = 'customer-images'::text));

DROP POLICY IF EXISTS ie_attachments_delete ON storage.objects;
CREATE POLICY ie_attachments_delete ON storage.objects
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (((bucket_id = 'income-expense-attachments'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS ie_attachments_insert ON storage.objects;
CREATE POLICY ie_attachments_insert ON storage.objects
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (((bucket_id = 'income-expense-attachments'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS ie_attachments_select_authenticated ON storage.objects;
CREATE POLICY ie_attachments_select_authenticated ON storage.objects
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((bucket_id = 'income-expense-attachments'::text));

DROP POLICY IF EXISTS ie_attachments_update ON storage.objects;
CREATE POLICY ie_attachments_update ON storage.objects
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (((bucket_id = 'income-expense-attachments'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)));

DROP POLICY IF EXISTS job_attachments_select_authenticated ON storage.objects;
CREATE POLICY job_attachments_select_authenticated ON storage.objects
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((bucket_id = 'job-attachments'::text));

DROP POLICY IF EXISTS meter_images_select_authenticated ON storage.objects;
CREATE POLICY meter_images_select_authenticated ON storage.objects
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((bucket_id = 'meter-images'::text));

DROP POLICY IF EXISTS payment_receipts_select_authenticated ON storage.objects;
CREATE POLICY payment_receipts_select_authenticated ON storage.objects
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((bucket_id = 'payment-receipts'::text));

DROP POLICY IF EXISTS storage_objects_super_admin_all ON storage.objects;
CREATE POLICY storage_objects_super_admin_all ON storage.objects
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS storage_pii_org_isolation ON storage.objects;
CREATE POLICY storage_pii_org_isolation ON storage.objects
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (app_private.can_read_storage_object_v1(bucket_id, name));

DROP POLICY IF EXISTS ui_references_select_authenticated ON storage.objects;
CREATE POLICY ui_references_select_authenticated ON storage.objects
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((bucket_id = 'ui-references'::text));

-- ---------------------------------------------------------------------
-- [7] GRANT / REVOKE tường minh (khớp pg_proc.proacl + pg_class.relacl trên PROD)
--     Hàm mới tạo mặc định có EXECUTE cho PUBLIC -> phải REVOKE rồi cấp lại.
--     TIỀN ĐỀ: các role anon / authenticated / service_role phải tồn tại
--     (Supabase tạo sẵn). Trên Postgres trắng không-Supabase phải tạo trước.
-- ---------------------------------------------------------------------

-- [7.1] app_private.can_read_storage_object_v1 — PROD: postgres, authenticated
REVOKE ALL ON FUNCTION app_private.can_read_storage_object_v1(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.can_read_storage_object_v1(text, text) TO authenticated;

-- [7.2] app_private.storage_object_link_maintain — PROD: chỉ postgres
REVOKE ALL ON FUNCTION app_private.storage_object_link_maintain() FROM PUBLIC;

-- [7.3] app_private.derive_uploader_org_v1 — PROD: chỉ postgres
REVOKE ALL ON FUNCTION app_private.derive_uploader_org_v1(uuid) FROM PUBLIC;

-- [7.4] public.my_org_ids — PROD: postgres, authenticated, service_role (KHÔNG có anon/PUBLIC)
REVOKE ALL ON FUNCTION public.my_org_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_org_ids() TO authenticated, service_role;

-- [7.5] public.is_super_admin — PROD giữ mặc định PUBLIC + anon/authenticated/service_role
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO PUBLIC, anon, authenticated, service_role;

-- [7.6] public.current_visible_owner_ids — PROD giữ mặc định PUBLIC + anon/authenticated/service_role
GRANT EXECUTE ON FUNCTION public.current_visible_owner_ids() TO PUBLIC, anon, authenticated, service_role;

-- [7.7] Bảng app_private.storage_object_links — PROD: chỉ owner postgres.
--       Client KHÔNG bao giờ đọc bảng này trực tiếp; chỉ đi qua
--       can_read_storage_object_v1 (SECURITY DEFINER).
REVOKE ALL ON TABLE app_private.storage_object_links FROM PUBLIC;
REVOKE ALL ON TABLE app_private.storage_object_links FROM anon, authenticated;

COMMIT;

-- =====================================================================
-- KIỂM TRA SAU KHI CHẠY (mong đợi: 1 | 1 | 6 | 1 | 36)
-- =====================================================================
-- SELECT
--   (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--     WHERE n.nspname='app_private' AND c.relname='storage_object_links' AND c.relkind='r')      AS tbl,
--   (SELECT count(*) FROM pg_constraint WHERE conname='storage_object_links_pkey')               AS con,
--   (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--     WHERE (n.nspname='app_private' AND p.proname IN ('storage_object_link_maintain',
--            'can_read_storage_object_v1','derive_uploader_org_v1'))
--        OR (n.nspname='public' AND p.proname IN ('my_org_ids','is_super_admin',
--            'current_visible_owner_ids')))                                                      AS fns,
--   (SELECT count(*) FROM pg_trigger WHERE tgname='a00_storage_object_link' AND NOT tgisinternal) AS trg,
--   (SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects')         AS pol;
-- =====================================================================
