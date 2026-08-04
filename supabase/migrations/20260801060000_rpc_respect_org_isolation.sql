-- =====================================================================
-- BỊT LỖ LẪN DỮ LIỆU GIỮA CÁC TỔ CHỨC TRÊN TRANG /thanh-toan
--
-- Chủ báo 01/08/2026: mở /thanh-toan của tổ chức THẬT thì thấy hợp đồng của
-- tổ chức DEMO ("Tòa DEMO A", khách "[7Z] test KH") lẫn vào, VÀ mọi dòng nhân đôi.
--
-- ─────────────────────────────────────────────────────────────────────
-- GỐC RỄ: HỆ CÓ HAI LỚP BẢO VỆ, TRANG NÀY CHỈ ĐI QUA LỚP BỊ HỞ
--
-- Lớp 1 — RLS trên bảng `buildings`: ĐÃ đúng. Hai policy RESTRICTIVE:
--     `buildings_hide_sandbox_admin` : NOT (is_super_admin() AND org ∈ sandbox_org_ids())
--     `buildings_hide_demo_admin`    : NOT ((is_super_admin() OR is_admin())
--                                            AND chủ toà ∈ demo_user_ids())
--   Và cả hai danh sách ĐÃ khai đúng: `sandbox_org_ids()` trả về đúng org
--   `cccc0000-…` (bản sao "iHome CRM (Test)"), còn 3/3 toà của org DEMO đều
--   thuộc `demo_user_ids()`.
--
-- Lớp 2 — các RPC nạp dữ liệu cho trang. **Cả 5 hàm đều `SECURITY DEFINER`**
--   ⇒ chúng **đi vòng hoàn toàn qua RLS**, và bên trong chỉ kiểm quyền theo
--   TỪNG TOÀ (`can_access_building` / `ie_all_buildings_scope`), không hề biết
--   tới tổ chức. Chủ là super admin nên có quyền trên toà của cả ba tổ chức
--   ⇒ thấy hết, trộn lẫn.
--
-- Vì sao MỌI DÒNG NHÂN ĐÔI: org "iHome CRM (Test)" tạo lúc 17:04 ngày 31/07 là
-- bản SAO của org thật — 18 toà TRÙNG TÊN, hợp đồng TRÙNG SỐ (đã kiểm:
-- HD-2026-00282 tồn tại ở cả hai org). Mỗi hợp đồng thật vì thế hiện hai lần.
--
-- ─────────────────────────────────────────────────────────────────────
-- CÁCH SỬA: cho lớp 2 áp ĐÚNG luật mà lớp 1 đang áp
--
-- KHÔNG bịa luật mới, KHÔNG thêm tham số org bắt giao diện phải truyền (client
-- không được quyết định phạm vi bảo mật). Chỉ dựng một hàm nói lại đúng hai
-- mệnh đề RESTRICTIVE của RLS, rồi chèn vào cả 5 hàm.
--
-- Nhờ vậy khi chủ khai thêm org sandbox mới, hoặc thêm tài khoản demo, thì cả
-- hai lớp cùng đổi theo — không còn cảnh RLS biết mà RPC không biết.
-- =====================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.sandbox_org_ids()') IS NULL THEN
    RAISE EXCEPTION 'Thiếu sandbox_org_ids() — không tái lập được luật RLS. DỪNG.';
  END IF;
  IF to_regprocedure('public.demo_user_ids()') IS NULL THEN
    RAISE EXCEPTION 'Thiếu demo_user_ids(). DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- 1. MỘT NƠI DUY NHẤT NÓI "TOÀ NÀY CÓ ĐƯỢC HIỆN CHO NGƯỜI ĐANG ĐĂNG NHẬP KHÔNG"
--
-- Trả TRUE = được hiện. Đây là bản sao ĐÚNG NGHĨA của hai policy RESTRICTIVE
-- trên `public.buildings`; sửa luật thì sửa cả hai chỗ cho khớp.
--
-- VOLATILE: chuỗi quyền bên dưới có chạm khoá dòng, khai STABLE là ném 25006
-- qua PostgREST (án lệ đã cắn 5 lần, xem CLAUDE.md).
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.building_org_visible_v1(p_building uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
  SELECT NOT EXISTS (
    SELECT 1
      FROM public.buildings b
     WHERE b.id = p_building
       AND (
         -- Bản sao/sandbox: super admin KHÔNG được thấy.
         (public.is_super_admin() AND b.organization_id = ANY(public.sandbox_org_ids()))
         -- Toà của tài khoản demo: admin và super admin KHÔNG được thấy.
         OR ((public.is_super_admin() OR public.is_admin())
             AND b.user_id = ANY(public.demo_user_ids()))
       )
  );
$fn$;

REVOKE ALL ON FUNCTION app_private.building_org_visible_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.building_org_visible_v1(uuid) IS
  'Toà này có được hiện cho người đang đăng nhập không. Nói lại ĐÚNG hai policy '
  'RESTRICTIVE của RLS trên public.buildings, để các RPC SECURITY DEFINER (vốn đi '
  'vòng qua RLS) áp cùng một luật. Sửa luật thì phải sửa cả hai chỗ.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. CHÈN VÀO CẢ 5 HÀM NẠP DỮ LIỆU
--
-- Vá theo NEO bằng regexp: cả 5 hàm dùng chung khuôn
--     AND (public.can_access_building(<bí danh>.id)
--          OR public.ie_all_buildings_scope(<bí danh>.id) ...)
-- Chèn một mệnh đề AND đứng TRƯỚC nhóm đó — không đụng vào bên trong nhóm nên
-- dấu ngoặc vẫn cân, và luật quyền cũ giữ nguyên không suy suyển.
-- ─────────────────────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_names text[] := ARRAY[
    'get_period_commissions',
    'get_period_fee_status',
    'get_period_maintenance',
    'get_fee_config_matrix_v1',
    'preview_special_fees_v1'
  ];
  v_name  text;
  v_def   text;
  v_new   text;
  v_hits  int;
  v_done  int := 0;
BEGIN
  FOREACH v_name IN ARRAY v_names LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;

    IF v_def IS NULL THEN
      RAISE EXCEPTION 'Không thấy public.% — DỪNG.', v_name;
    END IF;

    IF position('building_org_visible_v1' IN v_def) > 0 THEN
      RAISE NOTICE '% đã vá — bỏ qua', v_name;
      CONTINUE;
    END IF;

    -- Đếm neo trước khi thay: 0 neo = hàm đã đổi hình dạng ⇒ DỪNG, không vá mù.
    SELECT count(*) INTO v_hits
      FROM regexp_matches(v_def, 'AND \(public\.can_access_building\((\w+)\.id\)', 'g');
    IF v_hits = 0 THEN
      RAISE EXCEPTION '%: không khớp neo điều kiện quyền — DỪNG, không vá mù.', v_name;
    END IF;

    v_new := regexp_replace(
      v_def,
      'AND \(public\.can_access_building\((\w+)\.id\)',
      E'AND app_private.building_org_visible_v1(\\1.id)\n       AND (public.can_access_building(\\1.id)',
      'g');

    EXECUTE v_new;
    v_done := v_done + 1;
    RAISE NOTICE 'ĐÃ VÁ % (% chỗ)', v_name, v_hits;
  END LOOP;

  RAISE NOTICE 'Tổng cộng vá % hàm.', v_done;
END
$patch$;

-- ─────────────────────────────────────────────────────────────────────
-- TỰ KIỂM
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_name text;
  v_names text[] := ARRAY[
    'get_period_commissions','get_period_fee_status','get_period_maintenance',
    'get_fee_config_matrix_v1','preview_special_fees_v1'
  ];
  v_src text;
BEGIN
  FOREACH v_name IN ARRAY v_names LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_src IS NULL THEN
      RAISE EXCEPTION 'Mất hàm % sau khi vá. DỪNG.', v_name;
    END IF;
    IF position('building_org_visible_v1' IN v_src) = 0 THEN
      RAISE EXCEPTION '% chưa áp chốt tổ chức. DỪNG.', v_name;
    END IF;
    -- Luật quyền cũ phải còn nguyên — chốt mới là THÊM, không phải THAY.
    IF position('can_access_building' IN v_src) = 0
       OR position('ie_all_buildings_scope' IN v_src) = 0 THEN
      RAISE EXCEPTION '% mất luật quyền cũ — bản vá đã thay nhầm chứ không phải thêm. DỪNG.', v_name;
    END IF;
  END LOOP;

  -- Hàm chốt phải VOLATILE, không thì PostgREST ném 25006.
  IF (SELECT p.provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app_private' AND p.proname = 'building_org_visible_v1') <> 'v' THEN
    RAISE EXCEPTION 'building_org_visible_v1 không VOLATILE. DỪNG.';
  END IF;

  RAISE NOTICE 'ĐÃ KIỂM: cả 5 hàm áp chốt tổ chức, luật quyền cũ còn nguyên.';
END
$verify$;

COMMIT;
