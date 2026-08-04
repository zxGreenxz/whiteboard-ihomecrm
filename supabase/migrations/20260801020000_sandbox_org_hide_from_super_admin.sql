-- ============================================================================
-- Giấu ORG SANDBOX (công ty TEST) khỏi tầm nhìn của super admin
-- ============================================================================
-- BỐI CẢNH
--   App KHÔNG có nút chuyển công ty: my_org_ids() trả về mảng và mọi policy biên
--   giới là `organization_id IN my_org_ids()`, nên một user thuộc 2 org sẽ thấy
--   HỢP NHẤT cả hai trên mọi màn hình. Nặng hơn: is_super_admin() có mặt trong
--   hầu hết policy SELECT, nên super admin thấy MỌI org dù không là thành viên.
--
--   Org DEMO đã phải xử lý y hệt bằng 33 policy RESTRICTIVE `*_hide_demo_admin`
--   (20260703110000_hide_demo_from_real_admins.sql) — nhưng nhận diện theo
--   user_id qua demo_user_ids(), nên chỉ phủ được 33 bảng có cột user_id.
--
--   Bản sao công ty TEST mang đủ dữ liệu nghiệp vụ (~110 bảng, gồm invoice_items,
--   income_expense_items, finance_*, profit_* — những bảng KHÔNG có user_id), nên
--   phải nhận diện theo organization_id thì mới phủ kín.
--
-- ÁN LỆ ĐÃ CẮN: ProfitDistributionReport — org DEMO lọt vào engine tính toán làm
--   lệch −17,3tr. Rò rỉ kiểu này im lặng, chỉ lộ ra khi có người đối chiếu tay.
--
-- RESTRICTIVE nên AND với policy sẵn có ⇒ với dữ liệu hiện tại (chưa có org
-- sandbox nào) đây là no-op tuyệt đối. User của org sandbox không phải super
-- admin nên vẫn thấy đủ dữ liệu công ty mình.
-- ============================================================================

-- 1. Danh sách org sandbox ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.sandbox_org_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT ARRAY['cccc0000-0000-4000-8000-000000000001'::uuid];
$$;

COMMENT ON FUNCTION public.sandbox_org_ids() IS
  'Org "hộp cát" (công ty TEST nhân bản). Dữ liệu của các org này bị policy '
  '*_hide_sandbox_admin giấu khỏi super admin để không nhân đôi số liệu công ty thật.';

REVOKE ALL ON FUNCTION public.sandbox_org_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sandbox_org_ids() TO authenticated, service_role;

-- 2. Policy RESTRICTIVE trên MỌI bảng có organization_id đã bật RLS ----------
DO $do$
DECLARE
  r record;
  v_n int := 0;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
      AND c.relrowsecurity
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND a.attnum > 0 AND NOT a.attisdropped
      )
    ORDER BY 1
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = r.tbl
        AND policyname = r.tbl || '_hide_sandbox_admin'
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated '
      'USING (NOT ((SELECT public.is_super_admin()) '
      '            AND organization_id = ANY (public.sandbox_org_ids())))',
      r.tbl || '_hide_sandbox_admin', r.tbl
    );
    v_n := v_n + 1;
  END LOOP;

  RAISE NOTICE 'sandbox hide policies created: %', v_n;
END
$do$;
