-- GỠ HỆ CHIA SẺ SỔ CŨ KHỎI ĐƯỜNG ĐỌC
--
-- Sau 20260802190000, quyền NHÌN sổ đã chạy bằng possession. Bản này gỡ nốt
-- `account_shared_users` khỏi hai đường đọc còn lại:
--   1. `accessible_account_ids()` — nền của RLS xem phiếu
--      (`income_expenses_select_fund_member`).
--   2. `verify_income_expense` / `_v1` — kiểm phiếu.
--
-- Đo trước khi viết (giả lập RLS 15 thành viên × 3 org): nhánh fund_member chỉ
-- NỞ RA, không ai mất phiếu nào — vì possession giờ là tập cha của legacy. Các
-- policy RESTRICTIVE (ẩn demo/sandbox, hạn chế hạng mục nhạy cảm) không đổi nên
-- vẫn chặn như cũ.
--
-- CHƯA xoá bảng `account_shared_users` và CHƯA drop `is_account_shared_with_me`
-- trong bản này: `create_income_expense_v1` (writer tạo phiếu tay, 3.6k dòng)
-- vẫn kiểm quyền sổ bằng bảng cũ. Gỡ nốt ở bản sau, khi writer đã chuyển sang
-- assert_cashbook_access_v2 — tránh gộp hai thay đổi rủi ro vào một lần.
--
-- ⚠ KHÔNG bọc BEGIN/COMMIT khi áp qua Management API. Kiểm lại catalog sau đó.

-- ── 1. accessible_account_ids: chủ sổ ∪ possession ───────────────────────────
CREATE OR REPLACE FUNCTION public.accessible_account_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id FROM public.accounts WHERE user_id = auth.uid()
  UNION
  SELECT app_private.my_possessed_cashbook_ids_v1();
$function$;

-- ── 2. shared_account_ids: dùng cho các policy GHI ───────────────────────────
-- Giữ tên hàm (nhiều policy tham chiếu) nhưng đổi nguồn sang possession.
CREATE OR REPLACE FUNCTION public.shared_account_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT app_private.my_possessed_cashbook_ids_v1();
$function$;

-- ── 3. verify_income_expense (bản không hậu tố, anon vẫn gọi được) ───────────
-- Chỉ đổi ĐÚNG nhánh quyền sổ; chốt "Phải đăng nhập" và phần còn lại giữ nguyên.
CREATE OR REPLACE FUNCTION public.verify_income_expense(p_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_voucher record;
  v_can_see boolean;
  v_full_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Phải đăng nhập';
  END IF;

  SELECT id, building_id, account_id, verified_at, verified_by, verified_by_name
    INTO v_voucher
    FROM public.income_expenses
   WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu';
  END IF;

  -- Caller phải có quyền xem phiếu (đồng bộ với policy SELECT)
  SELECT (
    public.is_super_admin()
    OR public.is_admin()
    OR (v_voucher.building_id IS NOT NULL AND public.can_access_building(v_voucher.building_id))
    OR (v_voucher.account_id IS NOT NULL
        AND v_voucher.account_id IN (SELECT app_private.my_possessed_cashbook_ids_v1()))
  ) INTO v_can_see;
  IF NOT v_can_see THEN
    RAISE EXCEPTION 'Không có quyền xem phiếu này';
  END IF;

  -- Đã có người kiểm trước đó → toggle bỏ kiểm (chỉ chủ kiểm hoặc super admin).
  IF v_voucher.verified_at IS NOT NULL THEN
    IF v_voucher.verified_by = v_uid OR public.is_super_admin() THEN
      UPDATE public.income_expenses
         SET verified_at = NULL,
             verified_by = NULL,
             verified_by_name = NULL,
             verified_note = NULL
       WHERE id = p_id;
      RETURN;
    ELSE
      RAISE EXCEPTION 'Phiếu đã được % kiểm — chỉ super admin hoặc người kiểm mới bỏ được', COALESCE(v_voucher.verified_by_name, 'người khác');
    END IF;
  END IF;

  SELECT COALESCE(full_name, email, 'Người dùng') INTO v_full_name
    FROM public.profiles WHERE id = v_uid;

  UPDATE public.income_expenses
     SET verified_at = now(),
         verified_by = v_uid,
         verified_by_name = v_full_name,
         verified_note = NULLIF(BTRIM(COALESCE(p_note, '')), '')
   WHERE id = p_id;
END;
$function$;

-- Hàm này từng hứng default privileges lúc DROP+CREATE (án lệ: đổi chữ ký là
-- anon/service_role tự được EXECUTE). Nó có chốt "Phải đăng nhập" nên anon vô
-- hại, nhưng không có lý do gì để anon giữ quyền gọi.
REVOKE EXECUTE ON FUNCTION public.verify_income_expense(uuid, text) FROM anon;
