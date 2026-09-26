-- =============================================================================
-- bao_cao_bong_v2_tra_v1_ve_kieu_goc — sửa tính chạy-lại của 20260926150000 (26/09/2026)
-- =============================================================================
-- VÌ SAO
--   Gate "Migration forward chạy lại được lần hai" (security-gates, push main e6445fc2) đỏ:
--   20260926170000 đã DROP + CREATE spend_shadow_report_v1 với kiểu trả về MỚI (thêm
--   cashbook_ok, fee_categories), nên chạy lại 20260926150000 trên trạng thái production báo
--   42P13 "cannot change return type of existing function". Lỗi thiết kế của chính chuỗi này:
--   RPC đã phát hành thì không đổi kiểu trả về — phải ra phiên bản mới.
--
-- LÀM GÌ
--   1. spend_shadow_report_v1 trở về ĐÚNG kiểu + thân của 20260926150000 (nguyên văn) ⇒ file
--      150000 chạy lại được trên trạng thái sống.
--   2. Cột mới đi qua spend_shadow_report_v2 (thân nguyên văn của 20260926170000). Màn "Cam kết
--      chi" gọi v2. v1/v2 chưa có caller nào trên web production (màn chưa phát hành).
--
-- TÊN FILE
--   Đặt tay 20260926170100 thay vì scripts/tao-ten-migration.mjs: công cụ cấp theo giờ thật
--   (≈ 142336) — NHỎ hơn 20260926170000 đã áp, nên Restore Drill sẽ replay file này TRƯỚC 170000
--   trong khi production áp SAU ⇒ bản dựng lại lệch production (v1 mang kiểu mới). Hệ quả của việc
--   170000 được đặt tay mốc tròn trong tương lai; đã kiểm không trùng version ở mọi worktree.
--
-- Chạy được hai lượt; trên DB rỗng của Restore Drill (sau 150000/170000 theo thứ tự tên).
-- =============================================================================

BEGIN;

DO $truoc$
BEGIN
  IF to_regclass('app_private.spend_decisions') IS NULL THEN
    RAISE EXCEPTION 'Thiếu app_private.spend_decisions — chạy bo_may_chi_so_tieu_va_quyet_dinh_bong trước'
      USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- 1. v1 về kiểu gốc (DROP vì kiểu trả về đang là bản mở rộng của 170000).
DROP FUNCTION IF EXISTS public.spend_shadow_report_v1(uuid, date, date);

CREATE OR REPLACE FUNCTION public.spend_shadow_report_v1(
  p_organization_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (voucher_id uuid, code text, voucher_date date, building_name text, writer text,
               amount numeric, birth_status text, engine_status text, engine_reason text,
               match boolean, enforced boolean, route text, decided_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_super_admin()
     OR app_private.ie_actor_is_company_owner_v1(p_organization_id, auth.uid())) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT d.income_expense_id, e.code, e.voucher_date, b.name, d.writer, d.amount,
         d.birth_status, d.engine_status, d.engine_reason, d.match, d.enforced, d.route, d.decided_at
    FROM app_private.spend_decisions d
    LEFT JOIN public.income_expenses e ON e.id = d.income_expense_id
    LEFT JOIN public.buildings b ON b.id = d.building_id
   WHERE d.organization_id = p_organization_id
     AND (p_from IS NULL OR d.decided_at >= p_from)
     AND (p_to IS NULL OR d.decided_at < p_to + 1)
   ORDER BY d.decided_at DESC
   LIMIT 2000;
END
$fn$;

REVOKE ALL ON FUNCTION public.spend_shadow_report_v1(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.spend_shadow_report_v1(uuid, date, date) TO authenticated;

-- 2. v2 mang cột cảnh báo sổ (G6) + khoá phí.
CREATE OR REPLACE FUNCTION public.spend_shadow_report_v2(
  p_organization_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (voucher_id uuid, code text, voucher_date date, building_name text, writer text,
               amount numeric, birth_status text, engine_status text, engine_reason text,
               match boolean, enforced boolean, route text, decided_at timestamptz,
               cashbook_ok boolean, fee_categories text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_super_admin()
     OR app_private.ie_actor_is_company_owner_v1(p_organization_id, auth.uid())) THEN
    RAISE EXCEPTION 'Chỉ chủ công ty hoặc quản trị hệ thống' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT d.income_expense_id, e.code, e.voucher_date, b.name, d.writer, d.amount,
         d.birth_status, d.engine_status, d.engine_reason, d.match, d.enforced, d.route, d.decided_at,
         CASE WHEN d.facts->>'actor_cashbook_ok' IS NULL THEN NULL
              ELSE (d.facts->>'actor_cashbook_ok')::boolean END,
         (SELECT string_agg(DISTINCT l->>'fee_category', ', ')
            FROM jsonb_array_elements(COALESCE(d.facts->'lines', '[]'::jsonb)) l
           WHERE l->>'fee_category' IS NOT NULL)
    FROM app_private.spend_decisions d
    LEFT JOIN public.income_expenses e ON e.id = d.income_expense_id
    LEFT JOIN public.buildings b ON b.id = d.building_id
   WHERE d.organization_id = p_organization_id
     AND (p_from IS NULL OR d.decided_at >= p_from)
     AND (p_to IS NULL OR d.decided_at < p_to + 1)
   ORDER BY d.decided_at DESC
   LIMIT 2000;
END
$fn$;

REVOKE ALL ON FUNCTION public.spend_shadow_report_v2(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.spend_shadow_report_v2(uuid, date, date) TO authenticated;

-- 3. Tự kiểm: v1 đúng 13 cột kiểu gốc, v2 đủ 15 cột; anon không gọi được.
DO $sau$
DECLARE
  v_n1 int;
  v_n2 int;
BEGIN
  SELECT array_length(p.proallargtypes, 1) - p.pronargs INTO v_n1
    FROM pg_proc p WHERE p.oid = 'public.spend_shadow_report_v1(uuid,date,date)'::regprocedure;
  SELECT array_length(p.proallargtypes, 1) - p.pronargs INTO v_n2
    FROM pg_proc p WHERE p.oid = 'public.spend_shadow_report_v2(uuid,date,date)'::regprocedure;
  IF v_n1 <> 13 OR v_n2 <> 15 THEN
    RAISE EXCEPTION 'Số cột trả về lệch: v1=% (phải 13), v2=% (phải 15)', v_n1, v_n2 USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('anon', 'public.spend_shadow_report_v1(uuid,date,date)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.spend_shadow_report_v2(uuid,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon còn EXECUTE trên báo cáo bóng' USING ERRCODE = '55000';
  END IF;
END
$sau$;

COMMIT;
