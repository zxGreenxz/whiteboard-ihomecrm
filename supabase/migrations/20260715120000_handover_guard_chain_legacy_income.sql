-- =====================================================================
-- ie_handover_guard: cho phiếu THU chuyển ERA LEGACY được bàn giao tiếp.
--
-- BUG (án lệ 15/07): quét 250 phiếu sổ Hiệp Thu → [HANDOVER_LOCKED] BG2606001.
--   * BG2606001 (13/06, era 20260610/0613) là phiên CONFIRMED CŨ có set
--     transfer_income_id = PT2606136 ("Nhận bàn giao tiền mặt ← NG TÂM").
--   * FE + create_cash_handover CHỦ Ý cho phiếu THU chuyển quét bàn giao tiếp
--     (chain) — guard nhánh (c) đã cho phép qua handover_transfer_id.
--   * NHƯNG nhánh (b) chạy TRƯỚC (c): phiếu khớp transfer_income_id của phiên
--     CONFIRMED → v_code set, v_allow_handover_change vẫn false → chặn luôn
--     UPDATE handover_id → cả phiên 250 phiếu fail.
--   * Era mới (20260619+) không set transfer_income_id nên không dính; chỉ
--     phiên legacy còn sót (hiện tại đúng 1 phiếu PT2606136).
--
-- SỬA: nhánh (b) khi khớp qua transfer_INCOME_id thì cũng bật
-- v_allow_handover_change (đồng ngữ nghĩa nhánh (c)). Vẫn khoá xoá/sửa
-- tiền/ngày/sổ/duyệt; phiếu CHI chuyển (transfer_expense_id) khoá nguyên.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.ie_handover_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code text;
  v_allow_handover_change boolean := false;
BEGIN
  -- (a) phiếu GỐC đang nằm trong phiên chưa CANCELLED
  IF OLD.handover_id IS NOT NULL THEN
    SELECT code INTO v_code FROM cash_handovers
     WHERE id = OLD.handover_id AND status <> 'CANCELLED';
  END IF;
  -- (b) cặp phiếu chuyển LEGACY (1 cặp) của phiên CONFIRMED.
  -- Phiếu THU chuyển ("Nhận bàn giao") được đổi handover_id để bàn giao tiếp
  -- — cùng ngữ nghĩa nhánh (c); phiếu CHI chuyển khoá cả handover_id.
  IF v_code IS NULL THEN
    SELECT code, (transfer_income_id = OLD.id)
      INTO v_code, v_allow_handover_change
      FROM cash_handovers
     WHERE status = 'CONFIRMED'
       AND (transfer_expense_id = OLD.id OR transfer_income_id = OLD.id)
     LIMIT 1;
    v_allow_handover_change := COALESCE(v_allow_handover_change, false);
  END IF;
  -- (c) phiếu chuyển LẺ (mới) do 1 phiên chưa CANCELLED tạo ra
  IF v_code IS NULL AND OLD.handover_transfer_id IS NOT NULL THEN
    SELECT code INTO v_code FROM cash_handovers
     WHERE id = OLD.handover_transfer_id AND status <> 'CANCELLED';
    IF v_code IS NOT NULL THEN
      v_allow_handover_change := true;  -- cho phép set handover_id để bàn giao tiếp (chain)
    END IF;
  END IF;

  IF v_code IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION '[HANDOVER_LOCKED] Phiếu thuộc phiên bàn giao % — hủy phiên (2 bên xác nhận) trước khi xoá.', v_code;
    END IF;
    IF (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
       OR NEW.approval_status      IS DISTINCT FROM OLD.approval_status
       OR NEW.account_id           IS DISTINCT FROM OLD.account_id
       OR NEW.total_amount         IS DISTINCT FROM OLD.total_amount
       OR NEW.voucher_date         IS DISTINCT FROM OLD.voucher_date
       OR NEW.handover_transfer_id IS DISTINCT FROM OLD.handover_transfer_id
       OR (NOT v_allow_handover_change AND NEW.handover_id IS DISTINCT FROM OLD.handover_id) THEN
      RAISE EXCEPTION '[HANDOVER_LOCKED] Phiếu thuộc phiên bàn giao % — hủy phiên (2 bên xác nhận) trước khi hoàn tác/sửa.', v_code;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

COMMIT;
