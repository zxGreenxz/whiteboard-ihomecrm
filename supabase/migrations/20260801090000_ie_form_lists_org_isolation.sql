-- =====================================================================
-- ie_form_buildings / ie_form_rooms — nguồn danh sách toà & phòng của
-- trang Thanh toán và các form thu chi
--
-- ─────────────────────────────────────────────────────────────────────
-- VÌ SAO BA BẢN VÁ TRƯỚC KHÔNG BẮT ĐƯỢC CHỖ NÀY — và phép đo đã lừa tôi
--
-- Sau `20260801060000/070000/080000`, chủ mở lại /thanh-toan thì "Tòa DEMO A"
-- và "Tòa DEMO B" VẪN hiện. Đo lại tận nơi mới ra:
--
--     ie_form_buildings()      →  21 toà  (có Tòa DEMO A, Tòa DEMO B, Chung (Demo))
--     đọc thẳng public.buildings →  18 toà  (đúng — RLS chặn tốt)
--
-- Trước đó tôi đã đo hàm này và kết luận "0 toà org khác — SẠCH". **Kết luận đó
-- SAI**, vì tôi đếm bằng cách nối kết quả hàm sang chính bảng `public.buildings`:
--
--     FROM ie_form_buildings() g JOIN public.buildings b ON b.id = g.id
--      WHERE b.organization_id <> <org thật>          -- luôn ra 0
--
-- Bảng `buildings` có RLS, nên phép JOIN đã **ẩn đúng những dòng tôi đang muốn
-- đếm**. Hàm rò 3 toà mà phép đo báo sạch.
--
-- ⇒ BÀI HỌC ghi lại: khi đo một hàm `SECURITY DEFINER` (vốn đi vòng qua RLS),
--   TUYỆT ĐỐI không phân loại kết quả bằng cách nối sang bảng CÓ RLS. Phải so
--   trực tiếp trên dữ liệu hàm trả về, hoặc phân loại ở một truy vấn riêng chạy
--   dưới quyền quản trị. Đây là lần thứ hai phép đo đánh lừa trong cùng sự cố:
--   lần đầu là quên `SET LOCAL ROLE authenticated` (báo rò nhầm), lần này là
--   nối qua RLS (báo sạch nhầm).
--
-- ─────────────────────────────────────────────────────────────────────
-- CÁCH SỬA
--
-- Hai hàm này đơn giản, chỉ lọc bằng quyền theo toà. Chèn thẳng hai mệnh đề của
-- RLS vào. CỐ Ý viết thẳng thay vì gọi `app_private.building_org_visible_v1`:
-- hàm đó khai VOLATILE, còn hai hàm này STABLE và được gọi trong danh sách dài —
-- giữ STABLE thì kế hoạch truy vấn không đổi.
-- =====================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.sandbox_org_ids()') IS NULL
     OR to_regprocedure('public.demo_user_ids()') IS NULL THEN
    RAISE EXCEPTION 'Thiếu sandbox_org_ids/demo_user_ids. DỪNG.';
  END IF;
  IF to_regprocedure('public.ie_form_buildings()') IS NULL THEN
    RAISE EXCEPTION 'Thiếu ie_form_buildings. DỪNG.';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.ie_form_buildings()
RETURNS TABLE(id uuid, name text, code text, is_virtual boolean, user_id uuid, managed boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT b.id, b.name, b.code, b.is_virtual, b.user_id,
         public.can_access_building(b.id) AS managed
  FROM public.buildings b
  WHERE b.deleted_at IS NULL
    AND (
      public.can_access_building(b.id)
      OR public.ie_all_buildings_scope(b.id)
    )
    -- ORG_ISOLATION_V1: hai mệnh đề RESTRICTIVE của RLS trên public.buildings.
    AND NOT (public.is_super_admin()
             AND b.organization_id = ANY(public.sandbox_org_ids()))
    AND NOT ((public.is_super_admin() OR public.is_admin())
             AND b.user_id = ANY(public.demo_user_ids()));
$function$;

COMMENT ON FUNCTION public.ie_form_buildings() IS
  'Danh sách toà cho form thu chi và trang Thanh toán. Từ 01/08/2026 áp thêm hai '
  'mệnh đề RESTRICTIVE của RLS — trước đó hàm trả 21 toà trong khi đọc thẳng bảng '
  'chỉ ra 18, tức toà của tổ chức khác lọt vào ô chọn.';

CREATE OR REPLACE FUNCTION public.ie_form_rooms(_building_id uuid DEFAULT NULL::uuid)
RETURNS SETOF rooms
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
  SELECT r.*
  FROM public.rooms r
  WHERE r.deleted_at IS NULL
    AND (_building_id IS NULL OR r.building_id = _building_id)
    AND (
      public.can_access_building(r.building_id)
      OR public.ie_all_buildings_scope(r.building_id)
    )
    -- ORG_ISOLATION_V1: cùng hai mệnh đề, tra qua toà của phòng.
    AND EXISTS (
      SELECT 1 FROM public.buildings b
       WHERE b.id = r.building_id
         AND NOT (public.is_super_admin()
                  AND b.organization_id = ANY(public.sandbox_org_ids()))
         AND NOT ((public.is_super_admin() OR public.is_admin())
                  AND b.user_id = ANY(public.demo_user_ids()))
    );
$function$;

COMMENT ON FUNCTION public.ie_form_rooms(uuid) IS
  'Danh sách phòng cho form thu chi. Áp cùng hai mệnh đề RESTRICTIVE của RLS như '
  'ie_form_buildings, tra qua toà của phòng.';

-- ─────────────────────────────────────────────────────────────────────
-- TỰ KIỂM
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE v_src text; v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['ie_form_buildings','ie_form_rooms'] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_src IS NULL THEN RAISE EXCEPTION 'Mất hàm %. DỪNG.', v_name; END IF;
    IF position('ORG_ISOLATION_V1' IN v_src) = 0 THEN
      RAISE EXCEPTION '% chưa áp chốt tổ chức. DỪNG.', v_name;
    END IF;
    IF position('sandbox_org_ids' IN v_src) = 0 OR position('demo_user_ids' IN v_src) = 0 THEN
      RAISE EXCEPTION '% thiếu một trong hai mệnh đề. DỪNG.', v_name;
    END IF;
    -- Luật quyền cũ phải còn nguyên: đây là THÊM, không phải THAY.
    IF position('can_access_building' IN v_src) = 0
       OR position('ie_all_buildings_scope' IN v_src) = 0 THEN
      RAISE EXCEPTION '% mất luật quyền cũ. DỪNG.', v_name;
    END IF;
  END LOOP;
END
$verify$;

COMMIT;
