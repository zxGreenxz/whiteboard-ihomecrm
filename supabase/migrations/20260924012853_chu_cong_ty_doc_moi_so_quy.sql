-- CHỦ CÔNG TY ĐỌC ĐƯỢC MỌI SỔ QUỸ CỦA CÔNG TY MÌNH
--
-- Lỗi (đo production 24/09/2026 bằng nick thật `nguyentam`, vai "Chủ công ty", chỉ đọc):
--   policy SELECT của public.accounts chỉ mở ba đường — chủ sổ (`user_id`), possession
--   (CUSTODIAN/OPERATOR/KNOWER, 20260802190000) và super admin. Chủ công ty không giữ sổ
--   nào ⇒ thấy 0/24 sổ. Danh sách Thu chi nối `accounts!inner` để loại sổ ảo, nên tab
--   "Tiền thật" của chủ công ty TRỐNG dù RLS của income_expenses cho đọc 3.389 phiếu đã
--   duyệt. Cùng gốc: app_private.ie_visible_cashbook_ids_v1 (quyền xem TỒN QUỸ, 11 hàm
--   số dư / dòng tiền / báo cáo Copilot gọi nó) cũng giấu số dư khỏi chủ công ty.
--   Bắt được nhờ .e2e-fleet/specs/income-cancel-permission-matrix.spec.ts chạy trên
--   môi trường TEST.
--
-- Sửa (chủ chọn 24/09/2026): vai chủ công ty ĐỌC được mọi sổ của công ty mình.
--   - Neo theo VAI bằng app_private.ie_actor_is_company_owner_v1 (TENANT_OWNER, hoặc vai
--     tự tạo "Chủ công ty"/"Chủ sở hữu tổ chức" — is_org_owner_v1 trả FALSE cho vai tự tạo).
--   - CHỈ ĐỌC. Thu/Chi vào sổ vẫn do assert_cashbook_access_v2 canh theo possession;
--     policy INSERT/UPDATE/DELETE của accounts không đổi.
--   - Tập lọt cửa đo trên production trước khi viết: đúng 2 người thấy thêm sổ —
--     nguyentam 0 → 24 sổ (org THẬT), demo.chunha 2 → 4 sổ (org DEMO). nguyentamca165
--     là super admin nên vốn đã thấy hết. Không Quản Lý Tòa/Partner nào lọt.
--   - Giới hạn theo ORG: helper chỉ trả org mà người gọi là chủ; policy RESTRICTIVE
--     accounts_org_boundary vẫn chặn org khác.
--
-- Chạy lại được (lane chạy thân file hai lần): CREATE OR REPLACE, DROP POLICY IF EXISTS,
-- chốt md5 nhận cả thân cũ lẫn thân mới. Nghiệm thu chỉ đọc catalog nên chạy được trên
-- database rỗng của Migration Restore Drill.

-- ── 0. Chốt: thân ie_visible_cashbook_ids_v1 phải đúng bản đã đọc ─────────────
-- Đọc trên production 24/09/2026: md5(prosrc) = 44ee95bf74d408ccd56bb65b2dd3258f (bản
-- 20260802190000). Lệch nghĩa là có người sửa hàm này sau lần đo — dừng, đừng đè.
-- ACL chụp lại để nghiệm thu chứng minh CREATE OR REPLACE không đổi quyền gọi.
DO $chot$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('app_private.ie_visible_cashbook_ids_v1()');
  IF v_md5 IS NULL THEN
    RAISE EXCEPTION 'chot: khong thay app_private.ie_visible_cashbook_ids_v1()';
  END IF;
  IF v_md5 NOT IN ('44ee95bf74d408ccd56bb65b2dd3258f', 'a524490b65993d3224151474b8ffee1a') THEN
    RAISE EXCEPTION 'chot: ie_visible_cashbook_ids_v1 da bi doi (md5 %) - doc lai ban dang chay truoc khi de', v_md5;
  END IF;
  PERFORM set_config(
    'app.chu_so_quy_acl_visible',
    (SELECT COALESCE(p.proacl::text, '<acl_null>')
       FROM pg_proc p
      WHERE p.oid = to_regprocedure('app_private.ie_visible_cashbook_ids_v1()')),
    true);
END
$chot$;

-- ── 1. Tập org mà người gọi là chủ công ty ────────────────────────────────────
-- Set-based như my_possessed_cashbook_ids_v1: policy gọi MỘT lần mỗi truy vấn rồi
-- hash-join, không gọi hàm trên từng dòng (danh sách Thu chi nối accounts cho cả
-- nghìn phiếu khi đếm count=exact). SECURITY DEFINER vì ie_actor_is_company_owner_v1
-- chỉ postgres gọi được. TUYỆT ĐỐI không khoá dòng trong thân (án lệ 25006).
CREATE OR REPLACE FUNCTION app_private.my_company_owner_org_ids_v1()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT m.organization_id
  FROM public.organization_memberships m
  WHERE m.user_id = auth.uid()
    AND m.status = 'ACTIVE'
    AND app_private.ie_actor_is_company_owner_v1(m.organization_id, m.user_id);
$fn$;

-- REVOKE FROM PUBLIC không cắt anon trên Supabase — thu riêng từng vai rồi chỉ cấp
-- authenticated (policy chạy bằng quyền của người truy vấn).
REVOKE ALL ON FUNCTION app_private.my_company_owner_org_ids_v1() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_private.my_company_owner_org_ids_v1() TO authenticated;

-- ── 2. Policy đọc sổ cho chủ công ty ─────────────────────────────────────────
-- PERMISSIVE cộng thêm (OR) vào ba đường cũ; ba policy RESTRICTIVE (ranh giới org,
-- ẩn demo, ẩn sandbox) vẫn áp như trước.
DROP POLICY IF EXISTS accounts_select_company_owner ON public.accounts;

CREATE POLICY accounts_select_company_owner ON public.accounts
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (organization_id IN (SELECT app_private.my_company_owner_org_ids_v1()));

-- ── 3. Quyền xem TỒN QUỸ: thêm nhánh chủ công ty ─────────────────────────────
-- Giữ nguyên ba nhánh cũ và hai bộ lọc (sổ chưa xoá, trong org của người gọi).
CREATE OR REPLACE FUNCTION app_private.ie_visible_cashbook_ids_v1()
 RETURNS TABLE(cashbook_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
  SELECT a.id
  FROM public.accounts a
  WHERE a.deleted_at IS NULL
    AND a.organization_id = ANY (public.my_org_ids())
    AND (
      public.is_super_admin()
      OR a.user_id = auth.uid()
      OR a.id IN (SELECT app_private.my_possessed_cashbook_ids_v1())
      OR a.organization_id IN (SELECT app_private.my_company_owner_org_ids_v1())
    );
$function$;

-- ── 4. Nghiệm thu (chỉ đọc catalog) ──────────────────────────────────────────
DO $nghiem_thu$
DECLARE
  v_fn regprocedure := to_regprocedure('app_private.my_company_owner_org_ids_v1()');
  v_vis regprocedure := to_regprocedure('app_private.ie_visible_cashbook_ids_v1()');
  v_pol record;
  v_src text;
BEGIN
  -- a) Helper: definer, STABLE, anon/PUBLIC không gọi được, authenticated gọi được.
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'nghiem_thu: thieu app_private.my_company_owner_org_ids_v1()';
  END IF;
  IF NOT (SELECT p.prosecdef AND p.provolatile = 's' FROM pg_proc p WHERE p.oid = v_fn) THEN
    RAISE EXCEPTION 'nghiem_thu: my_company_owner_org_ids_v1 phai SECURITY DEFINER + STABLE';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'nghiem_thu: anon goi duoc my_company_owner_org_ids_v1';
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'nghiem_thu: authenticated khong goi duoc my_company_owner_org_ids_v1 - policy se loi 42501';
  END IF;

  -- b) Policy: đúng một policy SELECT permissive cho authenticated, dạng set-based.
  SELECT * INTO v_pol
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'accounts'
     AND policyname = 'accounts_select_company_owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'nghiem_thu: thieu policy accounts_select_company_owner';
  END IF;
  IF v_pol.permissive <> 'PERMISSIVE' OR v_pol.cmd <> 'SELECT'
     OR v_pol.roles <> ARRAY['authenticated']::name[]
     OR v_pol.qual NOT LIKE '%my_company_owner_org_ids_v1%'
     OR v_pol.with_check IS NOT NULL THEN
    RAISE EXCEPTION 'nghiem_thu: accounts_select_company_owner sai hinh (%, %, %, %)',
      v_pol.permissive, v_pol.cmd, v_pol.roles, v_pol.qual;
  END IF;

  -- c) Chỉ ĐỌC: không policy nào khác (ghi, hay bảng khác) dựa vào helper mới.
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE (coalesce(qual, '') LIKE '%my_company_owner_org_ids_v1%'
                     OR coalesce(with_check, '') LIKE '%my_company_owner_org_ids_v1%')
                AND NOT (schemaname = 'public' AND tablename = 'accounts'
                         AND policyname = 'accounts_select_company_owner')) THEN
    RAISE EXCEPTION 'nghiem_thu: co policy khac dung my_company_owner_org_ids_v1';
  END IF;

  -- d) Tồn quỹ: đủ bốn nhánh, hai bộ lọc còn nguyên, ACL không đổi.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_vis;
  IF v_src NOT LIKE '%my_company_owner_org_ids_v1%'
     OR v_src NOT LIKE '%my_possessed_cashbook_ids_v1%'
     OR v_src NOT LIKE '%is_super_admin%'
     OR v_src NOT LIKE '%a.user_id = auth.uid()%'
     OR v_src NOT LIKE '%a.deleted_at IS NULL%'
     OR v_src NOT LIKE '%my_org_ids()%' THEN
    RAISE EXCEPTION 'nghiem_thu: ie_visible_cashbook_ids_v1 thieu nhanh hoac bo loc';
  END IF;
  IF (SELECT COALESCE(p.proacl::text, '<acl_null>') FROM pg_proc p WHERE p.oid = v_vis)
     IS DISTINCT FROM current_setting('app.chu_so_quy_acl_visible', true) THEN
    RAISE EXCEPTION 'nghiem_thu: ACL ie_visible_cashbook_ids_v1 bi doi';
  END IF;
END
$nghiem_thu$;
