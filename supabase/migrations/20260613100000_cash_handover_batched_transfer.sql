-- =====================================================================
-- Bàn giao tiền mặt — chuyển cặp phiếu chuyển sang mô hình PHIẾU TỔNG + LẺ
-- (đối xứng 2 phía), thay cho 1 cặp phiếu "trống ruột" của 20260610130000.
--
-- Khi người nhận xác nhận (confirm_cash_handover), thay vì tạo 1 phiếu CHI +
-- 1 phiếu THU gộp, ta tạo ĐỐI XỨNG:
--   * Sổ người GIAO: N phiếu CHI lẻ (mỗi phiếu gốc 1 phiếu) + 1 phiếu chi
--     TỔNG (income_expense_batches) gom chúng.
--   * Sổ người NHẬN: N phiếu THU lẻ (mang phòng/HĐ + tên gốc + hậu tố
--     "(Đã bàn giao ⇒ <người nhận>)") + 1 phiếu thu TỔNG gom chúng.
-- Phiếu gốc GIỮ NGUYÊN ở sổ người giao (vẫn tính KQKD + giữ dấu vết) → số dư:
-- sổ giao net 0, sổ nhận +Σ. Cặp chuyển business_result_accounting=FALSE nên
-- KQKD vẫn đếm doanh thu 1 lần ở phiếu gốc.
--
-- Phiếu tổng (income_expense_batches) là METADATA không có cột tiền nên KHÔNG
-- bị cộng vào số dư → vừa có phiếu lẻ vừa có phiếu tổng mà không đếm trùng.
--
-- Cột mới income_expenses.handover_transfer_id đánh dấu phiếu CHUYỂN (lẻ) do
-- phiên nào tạo → dùng cho guard (khoá sửa/xoá) + reversal khi hủy. Khác với
-- handover_id (đánh dấu phiếu GỐC đang được bàn giao). Phiếu THU lẻ của người
-- nhận vẫn bàn giao tiếp (chain) được vì guard CHO PHÉP đổi handover_id.
--
-- Giữ tương thích phiên CONFIRMED cũ (transfer_expense_id/transfer_income_id).
-- =====================================================================

BEGIN;

-- ── 1. Cột mới ───────────────────────────────────────────────────────
ALTER TABLE public.cash_handovers
  ADD COLUMN IF NOT EXISTS transfer_expense_batch_id uuid REFERENCES public.income_expense_batches(id),
  ADD COLUMN IF NOT EXISTS transfer_income_batch_id  uuid REFERENCES public.income_expense_batches(id);

ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS handover_transfer_id uuid REFERENCES public.cash_handovers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ie_handover_transfer
  ON public.income_expenses(handover_transfer_id) WHERE handover_transfer_id IS NOT NULL;

COMMENT ON COLUMN public.income_expenses.handover_transfer_id IS
  'Phiếu CHUYỂN (chi/thu lẻ) do phiên bàn giao này tạo ra. Khác handover_id (phiếu GỐC được bàn giao). Dùng cho guard + hoàn tác; phiếu THU lẻ vẫn được set handover_id để bàn giao tiếp.';

-- ── 2. Guard: khoá phiếu trong phiên bàn giao (mở rộng cho phiếu lẻ) ──
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
  -- (b) cặp phiếu chuyển LEGACY (1 cặp) của phiên CONFIRMED
  IF v_code IS NULL THEN
    SELECT code INTO v_code FROM cash_handovers
     WHERE status = 'CONFIRMED'
       AND (transfer_expense_id = OLD.id OR transfer_income_id = OLD.id)
     LIMIT 1;
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

-- ── 3. RPC: người nhận xác nhận — tạo phiếu tổng + lẻ đối xứng ────────
CREATE OR REPLACE FUNCTION public.confirm_cash_handover(
  p_handover_id   uuid,
  p_to_account_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_h          cash_handovers%ROWTYPE;
  v_to         uuid;
  v_sum        numeric;
  v_cnt        int;
  v_type_exp   uuid;
  v_type_inc   uuid;
  v_bld_giver  uuid;
  v_bld_recv   uuid;
  v_caller     text;
  v_recv       text;
  v_giver      text;
  v_batch_exp  uuid;
  v_batch_inc  uuid;
  v_exp        uuid;
  v_inc        uuid;
  rec          record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_h FROM cash_handovers WHERE id = p_handover_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiên bàn giao'; END IF;
  IF v_h.receiver_id <> auth.uid() THEN
    RAISE EXCEPTION 'Chỉ người nhận mới được xác nhận đã nhận tiền';
  END IF;
  IF v_h.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Phiên % không ở trạng thái chờ nhận', v_h.code;
  END IF;
  IF v_h.cancel_requested_by IS NOT NULL THEN
    RAISE EXCEPTION 'Phiên % đang có yêu cầu hủy — xử lý yêu cầu hủy trước', v_h.code;
  END IF;

  -- Sổ đích: truyền vào (phải của receiver) hoặc fallback sổ "…Thu" của receiver
  IF p_to_account_id IS NOT NULL THEN
    SELECT id INTO v_to FROM accounts
     WHERE id = p_to_account_id AND user_id = auth.uid() AND deleted_at IS NULL;
    IF v_to IS NULL THEN
      RAISE EXCEPTION 'Sổ nhận không hợp lệ (phải là sổ quỹ do bạn sở hữu)';
    END IF;
  ELSE
    SELECT id INTO v_to FROM accounts
     WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'
     ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
    IF v_to IS NULL THEN
      RAISE EXCEPTION 'Bạn chưa có sổ quỹ nhận — hãy chọn sổ khi xác nhận';
    END IF;
  END IF;

  -- Re-validate: danh sách phiếu còn nguyên vẹn, tổng khớp snapshot
  SELECT COALESCE(sum(ie.total_amount), 0), count(*) INTO v_sum, v_cnt
    FROM cash_handover_items it
    JOIN income_expenses ie ON ie.id = it.voucher_id
   WHERE it.handover_id = p_handover_id
     AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
     AND ie.handover_id = p_handover_id
     AND ie.account_id = v_h.from_account_id;
  IF v_cnt <> v_h.voucher_count OR v_sum <> v_h.total_amount THEN
    RAISE EXCEPTION 'Danh sách phiếu của phiên % đã thay đổi — hãy hủy phiên và tạo lại', v_h.code;
  END IF;

  -- Loại thu/chi "bàn giao" (ngoài KQKD) + tòa ảo Chung (fallback)
  v_type_exp := public._termination_ensure_type(v_h.giver_id, 'expense', 'Bàn giao tiền mặt');
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type_exp AND is_deposit IS DISTINCT FROM FALSE;
  v_type_inc := public._termination_ensure_type(v_h.receiver_id, 'income', 'Nhận bàn giao tiền mặt');
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
  v_bld_giver := public._chung_building(v_h.giver_id);
  v_bld_recv  := public._chung_building(v_h.receiver_id);

  SELECT COALESCE(full_name, '') INTO v_caller FROM profiles WHERE id = auth.uid();
  v_recv  := COALESCE(v_h.receiver_name, '');
  v_giver := COALESCE(v_h.giver_name, '');

  -- Phiếu TỔNG mỗi bên (metadata, không có tiền → không cộng số dư)
  INSERT INTO income_expense_batches (user_id, name, type, notes)
  VALUES (v_h.giver_id, 'Bàn giao tiền mặt → ' || v_recv || ' — ' || v_h.code, 'EXPENSE',
          '[BÀN GIAO] Phiếu chi tổng chuyển tiền mặt sang sổ người nhận (phiên ' || v_h.code
            || ', ' || v_h.voucher_count || ' phiếu).')
  RETURNING id INTO v_batch_exp;

  INSERT INTO income_expense_batches (user_id, name, type, notes)
  VALUES (v_h.receiver_id, 'Nhận bàn giao tiền mặt ← ' || v_giver || ' — ' || v_h.code, 'INCOME',
          '[BÀN GIAO] Phiếu thu tổng nhận tiền mặt bàn giao (phiên ' || v_h.code
            || ', ' || v_h.voucher_count || ' phiếu).')
  RETURNING id INTO v_batch_inc;

  -- LOOP từng phiếu gốc → 1 phiếu CHI lẻ (sổ giao) + 1 phiếu THU lẻ (sổ nhận)
  FOR rec IN
    SELECT ie.id AS src_id, ie.name AS src_name, ie.room_id AS src_room,
           ie.building_id AS src_bld, ie.total_amount AS amt
      FROM cash_handover_items it
      JOIN income_expenses ie ON ie.id = it.voucher_id
     WHERE it.handover_id = p_handover_id
     ORDER BY ie.voucher_date, ie.created_at
  LOOP
    -- CHI lẻ — trừ quỹ người giao
    INSERT INTO income_expenses
      (user_id, type, name, building_id, room_id, account_id, voucher_date,
       total_amount, approval_status, business_result_accounting, handover_transfer_id, notes, creator_name)
    VALUES
      (v_h.giver_id, 'EXPENSE',
       COALESCE(NULLIF(btrim(rec.src_name), ''), 'Bàn giao tiền mặt') || ' - (Đã bàn giao ⇒ ' || v_recv || ')',
       COALESCE(rec.src_bld, v_bld_giver), rec.src_room, v_h.from_account_id, CURRENT_DATE,
       rec.amt, 'APPROVED', FALSE, p_handover_id,
       '[BÀN GIAO] Chuyển tiền mặt sang sổ ' || v_recv || ' (phiên ' || v_h.code || ').',
       v_caller)
    RETURNING id INTO v_exp;
    INSERT INTO income_expense_items
      (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_exp, v_type_exp, COALESCE(NULLIF(btrim(rec.src_name), ''), 'Bàn giao tiền mặt'),
            1, rec.amt, CURRENT_DATE, CURRENT_DATE);
    INSERT INTO income_expense_batch_items (batch_id, income_expense_id) VALUES (v_batch_exp, v_exp);

    -- THU lẻ — vào quỹ người nhận, giữ phòng/HĐ để đối soát
    INSERT INTO income_expenses
      (user_id, type, name, building_id, room_id, account_id, voucher_date,
       total_amount, approval_status, business_result_accounting, handover_transfer_id, notes, creator_name)
    VALUES
      (v_h.receiver_id, 'INCOME',
       COALESCE(NULLIF(btrim(rec.src_name), ''), 'Nhận bàn giao tiền mặt') || ' - (Đã bàn giao ⇒ ' || v_recv || ')',
       COALESCE(rec.src_bld, v_bld_recv), rec.src_room, v_to, CURRENT_DATE,
       rec.amt, 'APPROVED', FALSE, p_handover_id,
       '[BÀN GIAO] Nhận tiền mặt bàn giao từ ' || v_giver || ' (phiên ' || v_h.code || ').',
       v_caller)
    RETURNING id INTO v_inc;
    INSERT INTO income_expense_items
      (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_inc, v_type_inc, COALESCE(NULLIF(btrim(rec.src_name), ''), 'Nhận bàn giao tiền mặt'),
            1, rec.amt, CURRENT_DATE, CURRENT_DATE);
    INSERT INTO income_expense_batch_items (batch_id, income_expense_id) VALUES (v_batch_inc, v_inc);
  END LOOP;

  UPDATE cash_handovers
     SET status = 'CONFIRMED', to_account_id = v_to, confirmed_at = now(),
         transfer_expense_batch_id = v_batch_exp, transfer_income_batch_id = v_batch_inc
   WHERE id = p_handover_id;

  RETURN jsonb_build_object('id', p_handover_id, 'code', v_h.code,
                            'total_amount', v_h.total_amount, 'to_account_id', v_to,
                            'voucher_count', v_h.voucher_count);
END;
$$;

-- ── 4. RPC: BÊN KIA xác nhận hủy → CANCELLED (đảo phiếu tổng/lẻ + legacy)
CREATE OR REPLACE FUNCTION public.confirm_cancel_handover(p_handover_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_h     cash_handovers%ROWTYPE;
  v_chain text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_h FROM cash_handovers WHERE id = p_handover_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiên bàn giao'; END IF;
  IF v_h.cancel_requested_by IS NULL THEN
    RAISE EXCEPTION 'Phiên % chưa có yêu cầu hủy', v_h.code;
  END IF;
  IF auth.uid() NOT IN (v_h.giver_id, v_h.receiver_id) THEN
    RAISE EXCEPTION 'Chỉ người giao hoặc người nhận mới được xác nhận hủy';
  END IF;
  IF auth.uid() = v_h.cancel_requested_by THEN
    RAISE EXCEPTION 'Hủy phiên cần BÊN KIA xác nhận (bạn là người đã yêu cầu hủy)';
  END IF;
  IF v_h.status NOT IN ('PENDING', 'CONFIRMED') THEN
    RAISE EXCEPTION 'Phiên % đã hủy rồi', v_h.code;
  END IF;

  -- Chain LEGACY: phiếu THU đơn đã được bàn giao tiếp?
  IF v_h.transfer_income_id IS NOT NULL THEN
    SELECT ch.code INTO v_chain
      FROM income_expenses ie
      JOIN cash_handovers ch ON ch.id = ie.handover_id
     WHERE ie.id = v_h.transfer_income_id AND ch.status <> 'CANCELLED';
    IF v_chain IS NOT NULL THEN
      RAISE EXCEPTION 'Tiền của phiên % đã được bàn giao tiếp trong phiên % — hủy phiên đó trước', v_h.code, v_chain;
    END IF;
  END IF;

  -- Chain MỚI (batch): bất kỳ phiếu THU lẻ nào đã được bàn giao tiếp?
  SELECT ch.code INTO v_chain
    FROM income_expenses ie
    JOIN cash_handovers ch ON ch.id = ie.handover_id
   WHERE ie.handover_transfer_id = p_handover_id AND ie.type = 'INCOME'
     AND ch.status <> 'CANCELLED'
   LIMIT 1;
  IF v_chain IS NOT NULL THEN
    RAISE EXCEPTION 'Tiền của phiên % đã được bàn giao tiếp trong phiên % — hủy phiên đó trước', v_h.code, v_chain;
  END IF;

  -- Set CANCELLED TRƯỚC để trigger guard nhả các phiếu liên quan
  UPDATE cash_handovers
     SET status = 'CANCELLED', cancelled_by = auth.uid(), cancelled_at = now()
   WHERE id = p_handover_id;

  IF v_h.status = 'CONFIRMED' THEN
    -- Phiếu chuyển LẺ (mới) → CANCELLED + ẩn 2 phiếu tổng (số dư 2 sổ tự hồi)
    UPDATE income_expenses SET approval_status = 'CANCELLED'
     WHERE handover_transfer_id = p_handover_id;
    UPDATE income_expense_batches SET deleted_at = now()
     WHERE id IN (v_h.transfer_expense_batch_id, v_h.transfer_income_batch_id)
       AND deleted_at IS NULL;
    -- Cặp phiếu LEGACY (phiên cũ) → CANCELLED
    UPDATE income_expenses SET approval_status = 'CANCELLED'
     WHERE id IN (v_h.transfer_expense_id, v_h.transfer_income_id);
  END IF;

  -- Nhả phiếu gốc để có thể bàn giao lại / hoàn tác
  UPDATE income_expenses SET handover_id = NULL WHERE handover_id = p_handover_id;

  RETURN jsonb_build_object('id', p_handover_id, 'code', v_h.code);
END;
$$;

-- ── 5. Grants (chữ ký không đổi — giữ nguyên, re-grant cho chắc) ──────
REVOKE ALL ON FUNCTION public.confirm_cash_handover(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.confirm_cash_handover(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.confirm_cancel_handover(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.confirm_cancel_handover(uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
