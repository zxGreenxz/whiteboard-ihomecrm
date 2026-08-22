-- =============================================================================
-- HẠN BỔ SUNG CỌC cho phiếu giữ chỗ (mốc thứ hai, khác hạn làm hợp đồng)
--
-- CA CÓ THẬT chủ nêu 22/08/2026:
--     phòng 5tr · thu 2tr ngày 22/08 · PHẢI ĐỦ 5tr trước 25/08 · nhận phòng 29/08
--     quá 25/08 mà chưa đủ ⇒ huỷ phiếu và khách mất cọc.
--
-- Hệ thống đang mù đúng mốc đắt nhất. `reservation_hold_deadlines` (migration
-- 20260822010000) chỉ mang MỘT mốc: `hold_until` = hạn phải ký hợp đồng (29/08).
-- Mốc 25/08 — cái mà lỡ là mất tiền — không nằm ở đâu cả. Bên hợp đồng đã có
-- `contracts.deposit_topup_due_date` cho đúng việc này, nhưng phiếu giữ chỗ thì
-- CHƯA CÓ hợp đồng, nên nó không dùng được đường đó.
--
-- HAI MỐC LÀ HAI VIỆC KHÁC NHAU, đừng gộp:
--     topup_due_date  25/08  quá hạn ⇒ nguy cơ MẤT TIỀN của khách
--     hold_until      29/08  quá hạn ⇒ nguy cơ MẤT PHÒNG của chủ
-- Gộp làm một thì mất khả năng nói "còn 3 ngày nữa là mất cọc" trong khi phòng
-- vẫn đang được giữ bình thường.
--
-- `deposit_target` = số cọc PHẢI ĐỦ (5tr). Không suy ra được từ đâu khác: giá
-- phòng nằm ở `rooms.rent_price` nhưng lệ "cọc = 1 tháng" chỉ là lệ — có chỗ cọc
-- hai tháng, có chỗ cọc thoả thuận. Form lấy giá phòng làm MẶC ĐỊNH rồi cho sửa
-- (quyết định của chủ 22/08), nên con số cuối cùng phải được ghi lại.
--
-- KHÔNG TỰ HUỶ, KHÔNG TỰ TỊCH THU (quyết định của chủ 22/08). Quá hạn thì phiếu
-- nổi lên bàn xử lý thành thẻ đỏ kèm nút, người quyết. Máy không biết khách vừa
-- gọi xin khất; và "huỷ + ghi mất cọc" là bút toán tiền thật, không lùi được
-- bằng một cú bấm.
--
-- LÙI ĐƯỢC: chỉ THÊM cột (nullable) + nới một ràng buộc NOT NULL. Không sửa,
-- không xoá dữ liệu nào.
-- =============================================================================

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.reservation_hold_deadlines') IS NULL THEN
    RAISE EXCEPTION 'Thiếu bảng reservation_hold_deadlines. DỪNG.';
  END IF;
  IF to_regprocedure('public.set_reservation_hold_deadline_v1(uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu writer set_reservation_hold_deadline_v1. DỪNG.';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- 1. Hai cột mới + nới hold_until
-- ---------------------------------------------------------------------------
ALTER TABLE public.reservation_hold_deadlines
  ADD COLUMN IF NOT EXISTS topup_due_date date,
  ADD COLUMN IF NOT EXISTS deposit_target numeric;

-- Nới NOT NULL: một phiếu có thể chỉ đặt hạn bổ sung cọc mà chưa chốt ngày ký
-- hợp đồng. Nới là mở rộng miền giá trị nên không dòng nào đang có bị ảnh hưởng.
ALTER TABLE public.reservation_hold_deadlines
  ALTER COLUMN hold_until DROP NOT NULL;

-- Dòng rỗng hoàn toàn là rác: không mốc nào, không số nào thì xoá hẳn dòng.
ALTER TABLE public.reservation_hold_deadlines
  DROP CONSTRAINT IF EXISTS reservation_hold_deadlines_co_it_nhat_mot_ky_han;
ALTER TABLE public.reservation_hold_deadlines
  ADD CONSTRAINT reservation_hold_deadlines_co_it_nhat_mot_ky_han
  CHECK (hold_until IS NOT NULL OR topup_due_date IS NOT NULL OR deposit_target IS NOT NULL);

ALTER TABLE public.reservation_hold_deadlines
  DROP CONSTRAINT IF EXISTS reservation_hold_deadlines_deposit_target_duong;
ALTER TABLE public.reservation_hold_deadlines
  ADD CONSTRAINT reservation_hold_deadlines_deposit_target_duong
  CHECK (deposit_target IS NULL OR deposit_target > 0);

COMMENT ON COLUMN public.reservation_hold_deadlines.topup_due_date IS
  'Hạn khách phải BỔ SUNG CỌC cho đủ deposit_target. Quá hạn thì nguy cơ huỷ phiếu và mất cọc; hệ thống CHỈ đẩy lên bàn xử lý, KHÔNG tự huỷ.';
COMMENT ON COLUMN public.reservation_hold_deadlines.deposit_target IS
  'Số cọc phải đủ (đồng). Form lấy giá phòng làm mặc định rồi cho sửa — lệ "cọc 1 tháng" không phải luật.';
COMMENT ON TABLE public.reservation_hold_deadlines IS
  'Kỳ hạn của phiếu cọc giữ chỗ: hold_until = hạn ký hợp đồng (mất PHÒNG), topup_due_date + deposit_target = hạn bổ sung cọc cho đủ (mất TIỀN). Ghi qua set_reservation_hold_terms_v1; RLS chỉ mở SELECT.';

CREATE INDEX IF NOT EXISTS reservation_hold_deadlines_org_topup_idx
  ON public.reservation_hold_deadlines (organization_id, topup_due_date)
  WHERE topup_due_date IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Writer đầy đủ
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_reservation_hold_terms_v1(
  p_income_expense_id uuid,
  p_hold_until        date    DEFAULT NULL::date,
  p_topup_due_date    date    DEFAULT NULL::date,
  p_deposit_target    numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_ie    public.income_expenses;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ie FROM public.income_expenses
   WHERE id = p_income_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu cọc' USING ERRCODE = 'P0002';
  END IF;
  IF v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu đã xoá' USING ERRCODE = '55000';
  END IF;
  IF v_ie.type IS DISTINCT FROM 'INCOME' THEN
    RAISE EXCEPTION 'Chỉ đặt kỳ hạn cho phiếu THU cọc giữ chỗ' USING ERRCODE = '22023';
  END IF;
  IF v_ie.contract_id IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu đã gắn hợp đồng — kỳ hạn cọc theo hợp đồng, không theo phiếu'
      USING ERRCODE = '55000';
  END IF;

  IF NOT (public.can_access_building(v_ie.building_id)
          OR public.ie_all_buildings_scope(v_ie.building_id)
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền trên toà của phiếu này' USING ERRCODE = '42501';
  END IF;

  -- Bỏ hết kỳ hạn thì xoá dòng. Đây là hành vi hợp lệ, không phải lỗi.
  IF p_hold_until IS NULL AND p_topup_due_date IS NULL AND p_deposit_target IS NULL THEN
    DELETE FROM public.reservation_hold_deadlines
     WHERE income_expense_id = p_income_expense_id;
    RETURN jsonb_build_object('incomeExpenseId', p_income_expense_id, 'cleared', true);
  END IF;

  -- Mốc nằm TRƯỚC ngày lập phiếu là đã trễ ngay lúc tạo — gần như chắc chắn gõ
  -- nhầm, và nó đẻ ra một thẻ đỏ giả trên bàn xử lý.
  IF p_hold_until IS NOT NULL AND p_hold_until < v_ie.voucher_date THEN
    RAISE EXCEPTION 'Hạn làm hợp đồng (%) không được trước ngày lập phiếu (%)',
      p_hold_until, v_ie.voucher_date USING ERRCODE = '23514';
  END IF;
  IF p_topup_due_date IS NOT NULL AND p_topup_due_date < v_ie.voucher_date THEN
    RAISE EXCEPTION 'Hạn bổ sung cọc (%) không được trước ngày lập phiếu (%)',
      p_topup_due_date, v_ie.voucher_date USING ERRCODE = '23514';
  END IF;
  -- Bổ sung cọc SAU khi đã hết hạn giữ phòng là vô nghĩa: tới ngày đó phòng đã
  -- nhả khoá rồi. Chặn ở đây thay vì để hai thẻ đỏ mâu thuẫn nhau trên bàn.
  IF p_hold_until IS NOT NULL AND p_topup_due_date IS NOT NULL
     AND p_topup_due_date > p_hold_until THEN
    RAISE EXCEPTION 'Hạn bổ sung cọc (%) không được sau hạn làm hợp đồng (%)',
      p_topup_due_date, p_hold_until USING ERRCODE = '23514';
  END IF;
  IF p_deposit_target IS NOT NULL AND p_deposit_target <= 0 THEN
    RAISE EXCEPTION 'Cọc cần đủ phải lớn hơn 0' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.reservation_hold_deadlines
    (income_expense_id, organization_id, hold_until, topup_due_date, deposit_target, created_by)
  VALUES (p_income_expense_id, v_ie.organization_id,
          p_hold_until, p_topup_due_date, p_deposit_target, v_actor)
  ON CONFLICT (income_expense_id) DO UPDATE
    SET hold_until     = EXCLUDED.hold_until,
        topup_due_date = EXCLUDED.topup_due_date,
        deposit_target = EXCLUDED.deposit_target,
        updated_at     = now();

  RETURN jsonb_build_object(
    'incomeExpenseId', p_income_expense_id,
    'holdUntil',       p_hold_until,
    'topupDueDate',    p_topup_due_date,
    'depositTarget',   p_deposit_target);
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_reservation_hold_terms_v1(uuid, date, date, numeric)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_reservation_hold_terms_v1(uuid, date, date, numeric)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.set_reservation_hold_terms_v1(uuid, date, date, numeric) IS
  'Đặt/đổi/xoá kỳ hạn của phiếu cọc giữ chỗ: hạn ký hợp đồng, hạn bổ sung cọc, số cọc phải đủ. Bỏ hết thì xoá dòng. Đường ghi DUY NHẤT vào reservation_hold_deadlines.';

-- ---------------------------------------------------------------------------
-- 3. Writer cũ thành lớp mỏng — KHÔNG xoá, và KHÔNG được đụng hạn bổ sung cọc.
--
--    Bản FE đang chạy trên production gọi hàm này. DROP nó bây giờ là làm gãy
--    nút "Đặt hạn" của người dùng thật trong khoảng từ lúc apply migration tới
--    lúc bản FE mới lên (qua CI, hàng chục phút). Giữ lại và uỷ quyền xuống
--    writer đầy đủ để chỉ có MỘT nơi kiểm quyền.
--
--    COALESCE ngầm qua biến: đặt lại hạn ký hợp đồng KHÔNG được âm thầm xoá mất
--    hạn bổ sung cọc mà ai đó vừa đặt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_reservation_hold_deadline_v1(
  p_income_expense_id uuid,
  p_hold_until        date DEFAULT NULL::date
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_topup  date;
  v_target numeric;
BEGIN
  SELECT topup_due_date, deposit_target INTO v_topup, v_target
    FROM public.reservation_hold_deadlines
   WHERE income_expense_id = p_income_expense_id;

  RETURN public.set_reservation_hold_terms_v1(
    p_income_expense_id, p_hold_until, v_topup, v_target);
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_reservation_hold_deadline_v1(uuid, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_reservation_hold_deadline_v1(uuid, date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.set_reservation_hold_deadline_v1(uuid, date) IS
  'THAY THẾ BỞI set_reservation_hold_terms_v1. Giữ lại cho bản FE cũ còn đang chạy: chỉ đổi hạn ký hợp đồng, giữ nguyên hạn bổ sung cọc.';

-- ---------------------------------------------------------------------------
-- TỰ KIỂM
-- ---------------------------------------------------------------------------
DO $tk$
DECLARE v_n int; v_src text;
BEGIN
  IF to_regprocedure('public.set_reservation_hold_terms_v1(uuid,date,date,numeric)') IS NULL THEN
    RAISE EXCEPTION 'Writer đầy đủ không tồn tại. DỪNG.';
  END IF;

  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'reservation_hold_deadlines'
     AND column_name IN ('topup_due_date', 'deposit_target');
  IF v_n <> 2 THEN RAISE EXCEPTION 'Thiếu cột mới. DỪNG.'; END IF;

  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'reservation_hold_deadlines'
     AND column_name = 'hold_until' AND is_nullable = 'YES';
  IF v_n <> 1 THEN RAISE EXCEPTION 'hold_until chưa nới NOT NULL. DỪNG.'; END IF;

  -- Lớp mỏng phải THẬT SỰ giữ hạn bổ sung cọc, không chỉ nói là giữ.
  SELECT pg_get_functiondef(to_regprocedure('public.set_reservation_hold_deadline_v1(uuid,date)')::oid)
    INTO v_src;
  IF position('set_reservation_hold_terms_v1' IN v_src) = 0
     OR position('topup_due_date' IN v_src) = 0 THEN
    RAISE EXCEPTION 'Writer cũ không uỷ quyền hoặc không giữ hạn bổ sung cọc. DỪNG.';
  END IF;

  IF has_function_privilege('anon',
       'public.set_reservation_hold_terms_v1(uuid,date,date,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon còn EXECUTE trên writer mới. DỪNG.';
  END IF;

  SELECT count(*) INTO v_n
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'reservation_hold_deadlines'
     AND grantee = 'authenticated' AND privilege_type <> 'SELECT';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'authenticated có quyền ghi trực tiếp nên bỏ qua kiểm quyền toà. DỪNG.';
  END IF;
END
$tk$;

COMMIT;

NOTIFY pgrst, 'reload schema';
