-- =============================================================================
-- Lương — SIẾT LẠI guard đọc lương: bỏ nhánh `session_user = 'postgres'`.
--
-- LỖ TÔI TỰ TẠO RA, VÀ THỨ BẮT ĐƯỢC NÓ
--   16/09/2026, lúc gộp đợt rà soát, tôi thêm vào `app_private.v5_can_view_salary_v1`
--   một mệnh đề mở cửa cho đường nội bộ:
--       WHEN auth.role() = 'service_role' OR session_user = 'postgres' THEN true
--   Vế đầu là cần thiết: job đêm (edge `salary-v5-jobs` → `v5_run_job('close_period')`
--   → `v5_close_period` → `v5_month_money` từng nhân viên) chạy bằng service_role,
--   không có `auth.uid()`, nên thiếu nó thì đóng kỳ lương gãy 42501 ngay đêm đầu.
--
--   Vế SAU thì sai, và sai rộng. `SET ROLE authenticated` đổi `current_user`
--   chứ KHÔNG đổi `session_user`: mọi kết nối mở bằng vai `postgres` — Management
--   API, psql của người quản trị, harness kiểm thử — vẫn giữ `session_user =
--   'postgres'` sau khi đã hạ vai. Mệnh đề ấy vì thế vô hiệu hoá guard trong
--   đúng những phiên có nhiều quyền nhất, tức là biến một bản vá P0 thành hình thức.
--
--   Ma trận âm bản cách ly tenant (`scripts/test-cross-tenant.mjs`, job
--   `cross-tenant-isolation`) bắt đúng chỗ này: 3/10 ca salary đỏ ngay lần chạy
--   đầu sau khi push — `cross_organization_money_denied` và
--   `cross_organization_nchuan_denied` không còn nhận 42501, còn
--   `cross_organization_bulk_empty` quan sát được dữ liệu đáng lẽ phải rỗng.
--   Ba ca đó do chính plan I1 thêm vào ma trận trong cùng đợt.
--
-- SAU FILE NÀY: chỉ còn `auth.role() = 'service_role'` — vai mà PostgREST/edge
--   gán cho service key, và KHÔNG phải vai của một phiên người dùng.
--
-- NGUỒN: thân hàm chép từ `pg_get_functiondef` của production 16/09/2026 (bản
--   vừa apply ở 20260915074852), bỏ đúng một vế của một mệnh đề CASE.
-- IDEMPOTENT: CREATE OR REPLACE, không đổi chữ ký, ACL khẳng định lại.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_private.v5_can_view_salary_v1(p_target uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  SELECT CASE
    WHEN p_target IS NULL THEN false
    -- Job đêm chạy bằng service key: không có auth.uid() để so, nhưng đó không
    -- phải "người lạ đọc lương" — service_role đã là chủ toàn database.
    -- KHÔNG mở theo `session_user`: SET ROLE đổi current_user chứ không đổi
    -- session_user, nên một phiên mở bằng postgres rồi hạ vai vẫn lọt.
    WHEN (SELECT auth.role()) = 'service_role' THEN true
    WHEN (SELECT auth.uid()) IS NULL THEN false
    WHEN p_target = (SELECT auth.uid()) THEN true
    ELSE EXISTS (
      SELECT 1
      FROM public.organization_memberships m
      CROSS JOIN LATERAL app_private.authorized_scope_v3('salary.view', m.organization_id) scope
      WHERE m.user_id = p_target
        AND m.status = 'ACTIVE'
        AND COALESCE(scope.org_wide, false)
    )
  END;
$fn$;

COMMENT ON FUNCTION app_private.v5_can_view_salary_v1(uuid) IS
  'Chinh minh, hoac salary.view org_wide trong mot to chuc cua nguoi duoc xem, hoac service_role (job dem). KHONG mo theo session_user.';

REVOKE ALL ON FUNCTION app_private.v5_can_view_salary_v1(uuid) FROM public, anon, authenticated;

DO $tu_kiem$
-- BỎ CHÚ THÍCH TRƯỚC KHI SOI. `pg_get_functiondef` trả cả chú thích trong thân
-- hàm, mà chú thích ngay trên giải thích VÌ SAO không dùng `session_user` —
-- soi thẳng chuỗi thì phép tự kiểm luôn đỏ vì chính lời giải thích của nó.
-- Đúng cái bẫy đã gặp ở migration quét quá hạn cùng ngày.
DECLARE
  v_def  text := pg_get_functiondef('app_private.v5_can_view_salary_v1(uuid)'::regprocedure);
  v_code text := regexp_replace(v_def, '--[^
]*', '', 'g');
BEGIN
  IF v_code LIKE '%session_user%' THEN
    RAISE EXCEPTION 'v5_can_view_salary_v1 van mo cua theo session_user. DUNG.';
  END IF;
  IF v_code NOT LIKE '%service_role%' THEN
    RAISE EXCEPTION 'v5_can_view_salary_v1 mat duong service_role — job dem se gay 42501. DUNG.';
  END IF;
END
$tu_kiem$;
