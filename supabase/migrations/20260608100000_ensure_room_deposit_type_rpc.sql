-- =====================================================================
-- RPC ensure_room_deposit_type() — phục vụ "Tạo cọc nhanh" ở trang công
-- khai "Phòng trống" (/r/:token). Trả về id loại thu "Tiền cọc" của caller,
-- ĐẢM BẢO is_deposit = TRUE (tạo nếu thiếu). Cần is_deposit=TRUE để
-- ie_has_deposit_item() nhận diện phiếu là cọc → trigger recompute_room_reservation
-- tự set rooms.status = RESERVED (khoá phòng realtime ngay khi nhận cọc).
--
-- Vì sao cần RPC: FE chỉ ĐỌC is_deposit (set DB-side); useCreateIncomeExpenseType
-- không bật is_deposit. Tái dùng helper _termination_ensure_type (get-or-create
-- theo (user, type, name)) rồi bật cờ — y như _ensure_initial_deposit_voucher.
-- Sổ quỹ "CỌC (giữ hộ khách)" đã có RPC get_or_create_deposit_account.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.ensure_room_deposit_type()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  -- get-or-create loại thu "Tiền cọc" của chính caller (owner/staff đều dùng được)
  v_id := public._termination_ensure_type(auth.uid(), 'income', 'Tiền cọc');

  -- Bắt buộc is_deposit=TRUE để khoá phòng (ie_has_deposit_item) + đếm "Cọc đã thu".
  UPDATE income_expense_types
     SET is_deposit = TRUE
   WHERE id = v_id AND is_deposit IS DISTINCT FROM TRUE;

  RETURN v_id;
END;
$$;

REVOKE ALL     ON FUNCTION public.ensure_room_deposit_type() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.ensure_room_deposit_type() TO authenticated;

NOTIFY pgrst, 'reload schema';
