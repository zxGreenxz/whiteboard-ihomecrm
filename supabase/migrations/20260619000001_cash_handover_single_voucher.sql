-- =====================================================================
-- Bàn giao tiền mặt — GỘP về 1 PHIẾU TỔNG mỗi bên (thay N phiếu lẻ + batch).
--
-- TRƯỚC (20260613100000): khi người nhận xác nhận, confirm_cash_handover tạo
--   * Sổ người GIAO: N phiếu CHI lẻ + 1 phiếu chi TỔNG (income_expense_batches).
--   * Sổ người NHẬN: N phiếu THU lẻ + 1 phiếu thu TỔNG.
--   → cả 2 sổ quỹ ngập phiếu lẻ trùng lặp với phiếu gốc.
--
-- NAY: confirm tạo ĐÚNG 1 phiếu CHI (sổ giao) + 1 phiếu THU (sổ nhận). Mỗi
-- phiếu mang N HẠNG MỤC (income_expense_items) — 1 hạng mục / phiếu gốc — chính
-- là "chi tiết nội dung các hạng mục" bên trong. total_amount = Σ hạng mục do
-- trigger auto_recalc_total_amount tự tính.
--
-- BẤT BIẾN giữ nguyên:
--   * Số dư: sổ giao −Σ (phiếu gốc vẫn +Σ → net 0), sổ nhận +Σ.
--   * Cặp chuyển business_result_accounting=FALSE → NGOÀI KQKD (doanh thu chỉ
--     đếm 1 lần ở phiếu gốc).
--   * Đánh dấu handover_transfer_id trên CẢ 2 phiếu (KHÔNG set handover_id) →
--     guard khoá sửa/xoá nhưng CHO PHÉP phiếu THU đổi handover_id để bàn giao
--     tiếp (chain) — đúng nhánh (c) của ie_handover_guard.
--   * KHÔNG dùng income_expense_batches và KHÔNG set transfer_expense_id /
--     transfer_income_id (legacy): nếu set transfer_income_id thì nhánh (b) của
--     guard sẽ chặn chain phiếu THU. confirm_cancel_handover (đã có) đảo cặp
--     chuyển theo handover_transfer_id nên KHÔNG cần sửa.
--
-- Phiên CONFIRMED CŨ (batch/legacy) giữ nguyên — chỉ đổi hành vi từ đây về sau.
-- =====================================================================

BEGIN;

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
  v_exp        uuid;     -- phiếu CHI tổng (sổ người giao)
  v_inc        uuid;     -- phiếu THU tổng (sổ người nhận)
  v_desc       text;
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

  -- ── 1 phiếu CHI tổng (sổ người giao) ──────────────────────────────────
  -- building = Chung, room = NULL (gộp nhiều phòng); total_amount sẽ do trigger
  -- auto_recalc_total_amount tính lại = Σ hạng mục bên dưới.
  --
  -- LƯU Ý: CHƯA gắn handover_transfer_id ở bước này. Trigger auto_recalc cập
  -- nhật total_amount sau MỖI hạng mục → nếu phiếu đã bị ie_handover_guard khoá
  -- (handover_transfer_id NOT NULL) thì việc đổi total_amount sẽ bị chặn
  -- [HANDOVER_LOCKED]. Vì vậy gắn handover_transfer_id SAU khi nạp xong hạng mục.
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name)
  VALUES
    (v_h.giver_id, 'EXPENSE',
     'Bàn giao tiền mặt → ' || v_recv || ' — ' || v_h.code,
     v_bld_giver, v_h.from_account_id, CURRENT_DATE,
     v_h.total_amount, 'APPROVED', FALSE,
     '[BÀN GIAO] Chuyển tiền mặt đã thu sang sổ ' || v_recv || ' (phiên ' || v_h.code
       || ', ' || v_h.voucher_count || ' phiếu).',
     v_caller)
  RETURNING id INTO v_exp;

  -- ── 1 phiếu THU tổng (sổ người nhận) ──────────────────────────────────
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name)
  VALUES
    (v_h.receiver_id, 'INCOME',
     'Nhận bàn giao tiền mặt ← ' || v_giver || ' — ' || v_h.code,
     v_bld_recv, v_to, CURRENT_DATE,
     v_h.total_amount, 'APPROVED', FALSE,
     '[BÀN GIAO] Nhận tiền mặt bàn giao từ ' || v_giver || ' (phiên ' || v_h.code
       || ', ' || v_h.voucher_count || ' phiếu).',
     v_caller)
  RETURNING id INTO v_inc;

  -- ── N hạng mục chi tiết: 1 hạng mục / phiếu gốc, gắn vào CẢ 2 phiếu tổng ─
  FOR rec IN
    SELECT ie.name AS src_name, ie.total_amount AS amt,
           it.room_name, it.building_name, it.voucher_code
      FROM cash_handover_items it
      JOIN income_expenses ie ON ie.id = it.voucher_id
     WHERE it.handover_id = p_handover_id
     ORDER BY ie.voucher_date, ie.created_at
  LOOP
    -- Nhãn hạng mục: ưu tiên tên phiếu gốc (đã chứa phòng/HĐ/kỳ); fallback phòng·tòa·mã.
    v_desc := COALESCE(
      NULLIF(btrim(rec.src_name), ''),
      NULLIF(btrim(
        COALESCE(rec.room_name || ' · ', '') ||
        COALESCE(rec.building_name, '') ||
        COALESCE(' — ' || rec.voucher_code, '')
      ), ''),
      'Bàn giao tiền mặt'
    );

    INSERT INTO income_expense_items
      (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_exp, v_type_exp, v_desc, 1, rec.amt, NULL, NULL);

    INSERT INTO income_expense_items
      (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_inc, v_type_inc, v_desc, 1, rec.amt, NULL, NULL);
  END LOOP;

  -- Nạp xong hạng mục (total_amount đã chốt = Σ) → GIỜ mới khoá 2 phiếu chuyển
  -- bằng handover_transfer_id (guard sẽ chặn sửa/xoá; vẫn cho phiếu THU đổi
  -- handover_id để bàn giao tiếp). OLD.handover_transfer_id NULL nên UPDATE này
  -- không tự kích guard.
  UPDATE income_expenses
     SET handover_transfer_id = p_handover_id
   WHERE id IN (v_exp, v_inc);

  UPDATE cash_handovers
     SET status = 'CONFIRMED', to_account_id = v_to, confirmed_at = now()
   WHERE id = p_handover_id;

  RETURN jsonb_build_object('id', p_handover_id, 'code', v_h.code,
                            'total_amount', v_h.total_amount, 'to_account_id', v_to,
                            'voucher_count', v_h.voucher_count);
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_cash_handover(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.confirm_cash_handover(uuid, uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
