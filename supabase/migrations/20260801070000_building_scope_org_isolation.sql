-- =====================================================================
-- SỬA TẠI GỐC: phạm vi toà phải tôn trọng ranh giới tổ chức
--
-- Tiếp theo `20260801060000` (mới chỉ vá 5 hàm của trang Thanh toán). Một đợt
-- quét toàn hệ ngày 01/08 tìm được **30 chỗ** cùng khuyết tật, nên vá từng chỗ
-- là không xuể — phải sửa nơi chúng cùng dựa vào.
--
-- ─────────────────────────────────────────────────────────────────────
-- HAI ĐƯỜNG RÒ KHÁC NHAU, ĐỪNG NHẦM LÀM MỘT
--
-- Đo được trên prod 01/08:
--   • Chỉ có ĐÚNG MỘT super admin: nguyentamca165@gmail.com (chủ).
--   • Chủ là thành viên của "iHome CRM" và "iHome CRM (Demo)" — **KHÔNG** phải
--     thành viên "iHome CRM (Test)".
--
-- ⇒ Đường 1 — **DEMO rò**: `app_private.buildings_for_v3` lấy toà theo
--   `public.my_org_ids()`, tức MỌI tổ chức người đó là thành viên. Chủ thuộc hai
--   org nên hàm trả về toà của cả hai, trộn lẫn. Đây là gốc của phần lớn 30 chỗ,
--   vì hầu hết RLS `*_select_rbac` và RPC đều dựng trên primitive này.
--
-- ⇒ Đường 2 — **TEST rò**: chủ không thuộc org Test, nên `my_org_ids()` không
--   đưa nó vào. Nó lọt qua các mệnh đề `OR public.is_super_admin()` rải rác
--   trong từng hàm — "super admin thì thấy hết". File `20260801060000` đã bịt
--   đường này cho 5 hàm của trang Thanh toán; các hàm khác xử tiếp sau khi đo lại.
--
-- File này sửa ĐƯỜNG 1 tại gốc.
--
-- ─────────────────────────────────────────────────────────────────────
-- ÁP ĐÚNG LUẬT ĐÃ CÓ, KHÔNG BỊA LUẬT MỚI
--
-- RLS trên `public.buildings` đã có sẵn hai policy RESTRICTIVE đúng đắn, và hai
-- danh sách đã khai đúng (`sandbox_org_ids()` = org Test; 3/3 toà DEMO thuộc
-- `demo_user_ids()`). Việc ở đây chỉ là cho primitive nói cùng một luật.
--
-- PHẠM VI ẢNH HƯỞNG hẹp hơn vẻ ngoài: cả hai mệnh đề loại trừ chỉ cắn khi
-- `is_super_admin()` (và `is_admin()` trên prod = `is_super_admin()`), mà toàn hệ
-- chỉ có MỘT super admin. Người dùng thường không đổi gì.
--
-- KHÔNG mất năng lực: chủ vốn ĐÃ không thấy toà DEMO khi đọc thẳng bảng (RLS
-- chặn rồi) — chỉ các hàm DEFINER là còn hở. Sửa này làm hai bên khớp nhau.
-- =====================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('app_private.buildings_for_v3(text)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu buildings_for_v3. DỪNG.';
  END IF;
  IF to_regprocedure('app_private.building_org_visible_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu building_org_visible_v1 — chạy 20260801060000 trước. DỪNG.';
  END IF;
  IF to_regprocedure('public.authorized_scope_all_v3(text)') IS NULL
     AND to_regprocedure('app_private.authorized_scope_all_v3(text)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu authorized_scope_all_v3. DỪNG.';
  END IF;
END
$preflight$;

-- ─────────────────────────────────────────────────────────────────────
-- Viết lại buildings_for_v3: giữ NGUYÊN cách tính phạm vi cũ, chỉ LỌC THÊM
-- hai mệnh đề của RLS lên kết quả cuối.
--
-- Lọc ở BƯỚC CUỐI, không lọc trong nhánh `org_wide`, vì nhánh `else` trả
-- `s.building_ids` (danh sách toà cấp riêng) cũng cần lọc y như vậy — quyền cấp
-- riêng trên một toà sandbox vẫn không được phép hiện.
--
-- Giữ STABLE đúng như bản cũ: đổi sang VOLATILE sẽ làm mọi RLS policy dựng trên
-- nó bị đánh giá lại từng dòng, và chính `check-stable-fn-locks` đang xanh với
-- bản STABLE này.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_private.buildings_for_v3(p_permission_key text)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
  with raw as (
    select case when s.org_wide
             then (select coalesce(array_agg(b.id), '{}'::uuid[])
                     from public.buildings b
                    where b.organization_id = any(public.my_org_ids())
                      and b.deleted_at is null)
             else s.building_ids
           end as ids
      from app_private.authorized_scope_all_v3(p_permission_key) s
  ),
  -- Trải mảng ra thành hàng rồi JOIN. Viết `b.id = any((select ids from raw))`
  -- KHÔNG chạy được: Postgres hiểu `any(<subquery>)` là dạng tập hợp chứ không
  -- phải dạng mảng, nên ném 42883 "uuid = uuid[]".
  scope as (
    select unnest(r.ids) as id from raw r
  )
  select coalesce(
    (select array_agg(b.id)
       from public.buildings b
       join scope s2 on s2.id = b.id
      where b.deleted_at is null
        -- ORG_ISOLATION_V1: nói lại đúng hai policy RESTRICTIVE của RLS trên
        -- public.buildings, để nhánh SECURITY DEFINER (vốn đi vòng qua RLS)
        -- không còn rộng hơn nhánh đọc thẳng bảng.
        and not (public.is_super_admin()
                 and b.organization_id = any(public.sandbox_org_ids()))
        and not ((public.is_super_admin() or public.is_admin())
                 and b.user_id = any(public.demo_user_ids()))),
    '{}'::uuid[]);
$function$;

COMMENT ON FUNCTION app_private.buildings_for_v3(text) IS
  'Danh sách toà người đang đăng nhập được thao tác với một quyền. Từ 01/08/2026 '
  'lọc thêm ĐÚNG hai mệnh đề RESTRICTIVE của RLS trên public.buildings (ẩn org '
  'sandbox khỏi super admin, ẩn toà của tài khoản demo khỏi admin) — trước đó '
  'nhánh DEFINER rộng hơn nhánh đọc bảng nên dữ liệu nhiều tổ chức trộn vào nhau.';

-- ─────────────────────────────────────────────────────────────────────
-- TỰ KIỂM
-- ─────────────────────────────────────────────────────────────────────
DO $verify$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app_private' AND p.proname = 'buildings_for_v3';

  IF position('ORG_ISOLATION_V1' IN v_src) = 0 THEN
    RAISE EXCEPTION 'buildings_for_v3 chưa áp chốt tổ chức. DỪNG.';
  END IF;
  -- Cách tính phạm vi cũ phải còn nguyên — đây là THÊM bộ lọc, không phải THAY.
  IF position('authorized_scope_all_v3' IN v_src) = 0
     OR position('my_org_ids' IN v_src) = 0
     OR position('building_ids' IN v_src) = 0 THEN
    RAISE EXCEPTION 'buildings_for_v3 mất cách tính phạm vi cũ — đã thay nhầm. DỪNG.';
  END IF;
  IF (SELECT p.provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app_private' AND p.proname = 'buildings_for_v3') <> 's' THEN
    RAISE EXCEPTION 'buildings_for_v3 phải giữ STABLE. DỪNG.';
  END IF;
END
$verify$;

COMMIT;
