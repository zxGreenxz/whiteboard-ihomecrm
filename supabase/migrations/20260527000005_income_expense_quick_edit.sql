-- =============================================================
-- Quick edit phiếu thu/chi: cho người tạo phiếu (và super admin)
-- chỉnh 3 field "non-financial" trên phiếu đã ghi nhận/đã huỷ:
--   - account_id  (sổ quỹ)
--   - attachments (hình ảnh đính kèm)
--   - notes       (ghi chú)
--
-- Trước đây phiếu APPROVED/CANCELLED chỉ super admin sửa được
-- (UI chặn nút bút). Yêu cầu mới: cho phép user tự sửa các thông
-- tin không động đến số tiền/hạng mục để không phải nhờ admin.
--
-- RPC SECURITY DEFINER:
--   - Chỉ update đúng 3 field — không động vào total_amount,
--     items, payment_id, type, building_id, v.v.
--   - Cho phép caller là (a) chủ phiếu (user_id = auth.uid())
--     hoặc (b) super admin (is_super_admin()).
--   - Trả về row đã cập nhật để FE đồng bộ.
-- =============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.update_income_expense_quick(
  p_id uuid,
  p_account_id uuid,
  p_attachments text[],
  p_notes text
)
RETURNS public.income_expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.income_expenses;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  UPDATE public.income_expenses
  SET
    account_id  = p_account_id,
    attachments = COALESCE(p_attachments, ARRAY[]::text[]),
    notes       = p_notes
  WHERE id = p_id
    AND deleted_at IS NULL
    AND (user_id = auth.uid() OR public.is_super_admin())
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu hoặc bạn không có quyền sửa'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_income_expense_quick(uuid, uuid, text[], text)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
