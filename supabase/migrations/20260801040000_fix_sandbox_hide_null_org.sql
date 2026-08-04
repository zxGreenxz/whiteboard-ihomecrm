-- ============================================================================
-- SỬA GẤP: policy *_hide_sandbox_admin giấu nhầm cả dòng organization_id IS NULL
-- ============================================================================
-- Predicate cũ:
--     NOT ((SELECT is_super_admin()) AND organization_id = ANY (sandbox_org_ids()))
--
-- Với dòng organization_id IS NULL thì `NULL = ANY(...)` ra NULL, `true AND NULL`
-- ra NULL, `NOT NULL` vẫn NULL — RLS coi NULL là KHÔNG ĐẠT nên GIẤU LUÔN dòng đó.
-- Hậu quả đo được ngay trên công ty thật (đếm qua JWT của chủ tài khoản):
--     inspection_photos      477 → 254
--     building_fee_accounts  133 → 109
--     salary_attendance_day   58 →  37
--     material_usages         47 →  33
--     settings                 8 →   6
-- Đây toàn là dòng CỦA CÔNG TY THẬT còn sót organization_id NULL (autofill chưa
-- phủ hết) — biến mất khỏi màn hình chủ nhà, đúng loại lỗi bản sao phải tránh.
--
-- Predicate mới bọc COALESCE(..., false): NULL ⇒ không phải sandbox ⇒ vẫn hiện.
-- ============================================================================
DO $do$
DECLARE
  r record;
  v_n int := 0;
BEGIN
  FOR r IN
    SELECT tablename AS tbl FROM pg_policies
    WHERE schemaname = 'public' AND policyname LIKE '%\_hide\_sandbox\_admin'
    ORDER BY 1
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', r.tbl || '_hide_sandbox_admin', r.tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated '
      'USING (NOT ((SELECT public.is_super_admin()) '
      '            AND COALESCE(organization_id = ANY (public.sandbox_org_ids()), false)))',
      r.tbl || '_hide_sandbox_admin', r.tbl
    );
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'sandbox hide policies fixed: %', v_n;
END
$do$;
