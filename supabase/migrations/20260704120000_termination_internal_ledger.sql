-- =============================================================================
-- B3 — Chương trình "Thống nhất tài chính toàn web" (plan 04/07, chủ đã chốt):
-- BÚT TOÁN KHÔNG-TIỀN-THẬT RỜI KHỎI SỔ THỰC.
--
-- 1. Cặp "Cấn cọc → Doanh thu" (move-out & forfeit): CẢ HAI CHÂN chạy trên MỘT
--    sổ ảo duy nhất 'Cấn trừ thanh lý (nội bộ)' (helper get-or-create mới
--    _internal_settlement_account). Mỗi thương vụ net 0 trên sổ này — đọc như
--    nhật ký thanh lý. Sổ thực HẾT bị phồng/lõm bởi bút toán khống
--    (trước: CHI đánh vào sổ chứa cọc [thường sổ thực] + THU vào sổ vận hành).
-- 2. BỎ backfill "Cọc giữ phòng (ghi nhận ban đầu)" trong luồng thanh lý —
--    nghĩa vụ cọc theo dõi DUY NHẤT ở contracts.deposit_paid (nguồn sự thật);
--    vế cấn không còn cần biết cọc nằm sổ nào.
-- 3. "Khách trả thêm khi thanh lý" (TIỀN THẬT): +p_receipt_account_id — chọn sổ
--    NHẬN ngay trong form; mặc định sổ "%Thu" của người bấm (ưu tiên is_default),
--    fallback sổ vận hành toà. Chặn sổ ảo.
-- 4. Đóng số dư sổ ảo 'CỌC (giữ hộ khách)' của TENANT THẬT về 0 bằng cặp bút
--    toán 'adjustment.close_coc' (ngoài KQKD) → số dư cũ đóng băng có kiểm soát.
--    (Tenant demo bỏ qua — sandbox có cơ chế reset riêng.)
-- 5. Mọi phiếu RPC thanh lý sinh từ nay SET system_source (M2).
-- 6. _termination_pick_account: né sổ ảo bằng CỜ is_virtual (giữ danh sách tên
--    làm fallback).
--
-- KHÔNG đổi số quá khứ; KQKD item-level giữ nguyên (doanh thu đếm theo hạng
-- mục, bất kể sổ). Trigger trg_forfeit_settle_on_approve giữ nguyên (marker
-- notes [CẤN CỌC BỎ CỌC ...] vẫn được ghi).
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Helper: sổ bút toán thanh lý (nội bộ) per-owner — get-or-create + is_virtual
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._internal_settlement_account(p_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id
    FROM accounts
   WHERE user_id = p_user_id AND deleted_at IS NULL
     AND name = 'Cấn trừ thanh lý (nội bộ)'
   ORDER BY created_at LIMIT 1;
  IF v_id IS NOT NULL THEN
    UPDATE accounts SET is_virtual = true WHERE id = v_id AND is_virtual IS DISTINCT FROM true;
    RETURN v_id;
  END IF;

  INSERT INTO accounts (user_id, name, description, initial_amount, is_virtual)
  VALUES (p_user_id, 'Cấn trừ thanh lý (nội bộ)',
          'Sổ BÚT TOÁN (không phải tiền thật): cặp cấn cọc → doanh thu khi thanh lý/bỏ cọc chạy cả 2 chân trên sổ này, mỗi thương vụ net 0.',
          0, true)
  RETURNING id INTO v_id;
  RETURN v_id;
END $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. _termination_pick_account: né sổ ảo bằng cờ (giữ tên làm fallback)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._termination_pick_account(p_user_id uuid, p_building_id uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    -- 1) Sổ tiền mặt cấu hình cho toà (nơi thu tiền thuê).
    (SELECT b.default_account_id_tt FROM buildings b
      WHERE b.id = p_building_id AND b.default_account_id_tt IS NOT NULL
        AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = b.default_account_id_tt AND a.deleted_at IS NULL AND a.is_virtual = false)),
    -- 2) Sổ ngân hàng cấu hình cho toà.
    (SELECT b.default_account_id_tk FROM buildings b
      WHERE b.id = p_building_id AND b.default_account_id_tk IS NOT NULL
        AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = b.default_account_id_tk AND a.deleted_at IS NULL AND a.is_virtual = false)),
    -- 3) Fallback: trùng tên toà → is_default → tạo sớm nhất; né sổ ảo bằng CỜ.
    (SELECT a.id
       FROM accounts a, (SELECT name FROM buildings WHERE id = p_building_id) bld
      WHERE a.user_id = p_user_id
        AND a.deleted_at IS NULL
        AND a.is_virtual = false
        AND a.name NOT IN ('Cấn trừ thanh lý (nội bộ)', 'Làm tròn tiền thiếu')
      ORDER BY (a.name = bld.name) DESC, a.is_default DESC NULLS LAST, a.created_at
      LIMIT 1)
  );
$function$;

-- Helper: sổ nhận tiền mặc định của NGƯỜI BẤM (sổ "%Thu", ưu tiên is_default).
CREATE OR REPLACE FUNCTION public._collector_thu_account(p_collector uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT a.id FROM accounts a
   WHERE a.user_id = p_collector AND a.deleted_at IS NULL
     AND a.is_virtual = false AND btrim(a.name) LIKE '%Thu'
   ORDER BY a.is_default DESC NULLS LAST, a.created_at
   LIMIT 1;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. DROP move-out wrapper + impl (đổi chữ ký +p_receipt_account_id)
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text);
DROP FUNCTION IF EXISTS public.terminate_contract_move_out_impl(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. move_out_impl v3: cặp cấn cọc trên sổ nội bộ; sổ nhận cho khách-trả-thêm
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.terminate_contract_move_out_impl(
  p_contract_id uuid,
  p_move_out_date date,
  p_deposit_refund numeric DEFAULT 0,
  p_penalty_fee numeric DEFAULT 0,
  p_excess_rent numeric DEFAULT 0,
  p_outstanding_debt numeric DEFAULT 0,
  p_notes text DEFAULT NULL::text,
  p_extra_charges jsonb DEFAULT '[]'::jsonb,
  p_shortfall_mode text DEFAULT 'PAID',
  p_receipt_account_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract  RECORD;
  v_building  uuid;
  v_acc_op    uuid;   -- sổ vận hành (fallback nhận tiền thật)
  v_acc_int   uuid;   -- sổ bút toán nội bộ (cả 2 chân cấn cọc)
  v_acc_rcpt  uuid;   -- sổ NHẬN "khách trả thêm" (tiền thật)
  v_billing   text;
  v_cnumber   text;
  v_deposit   numeric(15,2);
  v_penalty   numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess    numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt      numeric(15,2) := COALESCE(p_outstanding_debt, 0);
  v_extra     numeric(15,2) := 0;
  v_charges   numeric(15,2);
  v_pool      numeric(15,2);
  v_applied   numeric(15,2);
  v_applied_dep numeric(15,2);
  v_refund_dep  numeric(15,2);
  v_refund_exc  numeric(15,2);
  v_S         numeric(15,2);
  v_budget    numeric(15,2);
  v_pay       numeric(15,2);
  v_settle_inv uuid;
  v_settle_status invoice_status;
  v_next_sort integer;
  v_type_inc  uuid;
  v_type_off  uuid;
  v_type_dep  uuid;
  v_type_excr uuid;
  v_voucher   uuid;
  v_refund_voucher uuid;
  v_breakdown text;
  rec         RECORD;
BEGIN
  IF p_shortfall_mode NOT IN ('PAID', 'DEBT') THEN
    RAISE EXCEPTION 'p_shortfall_mode phải là PAID hoặc DEBT';
  END IF;

  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hợp đồng không tồn tại'; END IF;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn'; END IF;
  IF v_contract.room_id IS NULL THEN RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý'; END IF;
  IF p_move_out_date < v_contract.start_date THEN
    RAISE EXCEPTION 'Ngày chuyển đi (%) không được trước ngày bắt đầu hợp đồng (%)',
      to_char(p_move_out_date,'DD/MM/YYYY'), to_char(v_contract.start_date,'DD/MM/YYYY');
  END IF;
  SELECT building_id INTO v_building FROM rooms WHERE id = v_contract.room_id;
  IF v_building IS NULL THEN RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng'; END IF;

  v_billing := to_char(COALESCE(p_move_out_date, CURRENT_DATE), 'YYYY-MM');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_acc_op  := public._termination_pick_account(v_contract.user_id, v_building);
  v_acc_int := public._internal_settlement_account(v_contract.user_id);

  -- Sổ NHẬN "khách trả thêm" (tiền thật): form chọn > sổ %Thu của người bấm > sổ vận hành toà.
  v_acc_rcpt := COALESCE(p_receipt_account_id, public._collector_thu_account(auth.uid()), v_acc_op);
  IF p_receipt_account_id IS NOT NULL THEN
    PERFORM 1 FROM accounts a WHERE a.id = p_receipt_account_id AND a.deleted_at IS NULL AND a.is_virtual = false;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ nhận tiền không hợp lệ (không tồn tại hoặc là sổ ảo)';
    END IF;
  END IF;

  -- A1: hoàn/cấn cọc tối đa bằng cọc THỰC THU (deposit_paid).
  v_deposit := LEAST(GREATEST(COALESCE(p_deposit_refund, 0), 0), COALESCE(v_contract.deposit_paid, 0));

  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(SUM((j->>'amount')::numeric), 0) INTO v_extra
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE (j->>'amount') IS NOT NULL AND (j->>'amount') <> ''
       AND (j->>'amount')::numeric > 0;
  END IF;

  v_charges     := v_debt + v_penalty + v_extra;
  v_pool        := v_deposit + v_excess;
  v_applied     := LEAST(v_pool, v_charges);
  v_applied_dep := LEAST(v_deposit, v_charges);
  v_refund_dep  := v_deposit - v_applied_dep;
  v_refund_exc  := v_excess - LEAST(v_excess, GREATEST(v_charges - v_deposit, 0));
  v_S           := v_pool - v_charges;

  v_breakdown :=
       'QUYẾT TOÁN THANH LÝ ' || to_char(p_move_out_date,'DD/MM/YYYY') || ' — HĐ ' || v_cnumber
    || E'\n• Cọc đã thu: ' || to_char(v_deposit, 'FM999G999G999G990') || 'đ'
    || E'\n• Khấu trừ: công nợ ' || to_char(v_debt, 'FM999G999G999G990') || 'đ'
    || CASE WHEN v_penalty > 0 THEN ' + phí phạt ' || to_char(v_penalty, 'FM999G999G999G990') || 'đ' ELSE '' END
    || CASE WHEN v_extra   > 0 THEN ' + thu thêm ' || to_char(v_extra, 'FM999G999G999G990') || 'đ' ELSE '' END
    || ' = ' || to_char(v_charges, 'FM999G999G999G990') || 'đ'
    || E'\n• Cọc cấn vào khấu trừ: ' || to_char(v_applied_dep, 'FM999G999G999G990') || 'đ (bút toán nội bộ, không đụng sổ tiền thật)'
    || CASE WHEN v_excess > 0 THEN E'\n• Tiền thừa (credit) áp dụng: ' || to_char(v_excess, 'FM999G999G999G990') || 'đ (cấn ' || to_char(v_excess - v_refund_exc, 'FM999G999G999G990') || 'đ, hoàn ' || to_char(v_refund_exc, 'FM999G999G999G990') || 'đ)' ELSE '' END
    || E'\n• Hoàn cọc lại khách: ' || to_char(v_refund_dep, 'FM999G999G999G990') || 'đ'
    || CASE WHEN v_S < 0 THEN E'\n• Khách còn phải trả: ' || to_char(-v_S, 'FM999G999G999G990') || 'đ ('
         || CASE WHEN p_shortfall_mode = 'PAID' THEN 'đã thu ngay khi thanh lý' ELSE 'GHI NỢ — chờ thu' END || ')'
       ELSE '' END
    || CASE WHEN v_refund_dep + v_refund_exc > 0 THEN E'\n• Tổng chi hoàn khách: ' || to_char(v_refund_dep + v_refund_exc, 'FM999G999G999G990') || 'đ (phiếu chi chờ duyệt — chọn sổ quỹ khi duyệt)' ELSE '' END;

  -- 1. Hoá đơn quyết toán tháng + phạt + thu thêm.
  SELECT id, status INTO v_settle_inv, v_settle_status FROM invoices
   WHERE contract_id = p_contract_id AND billing_month = v_billing
     AND deleted_at IS NULL AND status <> 'CANCELLED'
   ORDER BY (status = 'PAID'), created_at LIMIT 1;

  IF v_settle_inv IS NOT NULL AND v_settle_status = 'PAID' AND (v_penalty > 0 OR v_extra > 0) THEN
    v_settle_inv := NULL;
  END IF;

  IF (v_penalty > 0 OR v_extra > 0) AND v_settle_inv IS NULL THEN
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, billing_month, issue_date, due_date, status, subtotal, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building, v_contract.room_id,
      public._termination_free_billing_month(p_contract_id, v_billing),
      p_move_out_date, p_move_out_date, 'APPROVED'::invoice_status, 0, 0,
      'Hoá đơn thanh lý — khách rời phòng ngày ' || to_char(p_move_out_date,'DD/MM/YYYY') || COALESCE(E'\n' || p_notes, ''))
    RETURNING id INTO v_settle_inv;
  END IF;

  IF v_penalty > 0 THEN
    SELECT COALESCE(MAX(sort_order),0)+1 INTO v_next_sort FROM invoice_items WHERE invoice_id = v_settle_inv;
    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
    VALUES (v_settle_inv, 'PENALTY', 'Phí phạt thanh lý', v_penalty, 1, 1, v_penalty, v_next_sort);
    UPDATE invoices SET subtotal = COALESCE(subtotal,0)+v_penalty, total_amount = COALESCE(total_amount,0)+v_penalty, updated_at = NOW() WHERE id = v_settle_inv;
  END IF;

  IF v_extra > 0 THEN
    PERFORM public._termination_apply_extra_charges(v_settle_inv, p_extra_charges, p_move_out_date, v_contract.user_id, p_contract_id);
  END IF;

  IF v_settle_inv IS NOT NULL THEN
    UPDATE invoices
       SET notes = COALESCE(notes || E'\n\n', '') || v_breakdown,
           updated_at = NOW()
     WHERE id = v_settle_inv;
  END IF;

  -- 2. Quyết toán hoá đơn còn nợ bằng CẤN TRỪ 'CT' (PAID: gạch hết; DEBT: trong pool).
  v_budget := CASE WHEN p_shortfall_mode = 'DEBT' THEN v_applied ELSE NULL END;
  FOR rec IN
    SELECT id, (total_amount - paid_amount) AS remaining FROM invoices
     WHERE contract_id = p_contract_id AND deleted_at IS NULL AND status <> 'CANCELLED'
       AND (total_amount - paid_amount) > 0
     ORDER BY billing_month, created_at
  LOOP
    v_pay := rec.remaining;
    IF v_budget IS NOT NULL THEN
      EXIT WHEN v_budget <= 0;
      v_pay := LEAST(v_pay, v_budget);
      v_budget := v_budget - v_pay;
    END IF;
    IF v_pay > 0 THEN
      INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)
      VALUES (v_contract.user_id, rec.id, v_pay, 'CT'::payment_method, p_move_out_date,
              'Quyết toán khi thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY'));
    END IF;
  END LOOP;

  -- 3. CẶP BÚT TOÁN NỘI BỘ (cấn cọc → doanh thu) — CẢ 2 CHÂN trên sổ nội bộ,
  --    net 0/thương vụ; KHÔNG đụng sổ tiền thật (mô hình chốt 04/07).
  IF v_applied_dep > 0 THEN
    v_type_off := public._termination_ensure_type(v_contract.user_id, 'expense', 'Cấn cọc chuyển doanh thu');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', 'Cấn cọc → chuyển doanh thu — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_applied_dep, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: cọc cấn công nợ/phạt (không phải tiền thật).' || E'\n\n' || v_breakdown,
      'termination.offset')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_off, 'Cấn cọc chuyển doanh thu', 1, v_applied_dep, p_move_out_date, p_move_out_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_applied_dep, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu thanh lý từ cọc cấn nợ/phạt (KQKD đếm theo hạng mục).',
      'termination.revenue')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Doanh thu thanh lý (cấn cọc)', 1, v_applied_dep, p_move_out_date, p_move_out_date);
  END IF;

  -- 4. HOÀN KHÁCH = TIỀN THẬT: 1 phiếu chi NHÁP, SỔ TRỐNG (chọn khi duyệt).
  IF v_refund_dep > 0 OR v_refund_exc > 0 THEN
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', 'Trả khách thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, NULL, p_move_out_date, v_refund_dep + v_refund_exc, 'UNAPPROVED',
      '[HOÀN KHÁCH THANH LÝ] Phiếu chi hoàn khách (tiền thật). CHỌN SỔ QUỸ chi tiền (Sửa phiếu) rồi mới duyệt được.' || E'\n\n' || v_breakdown || COALESCE(E'\n' || p_notes, ''),
      'termination.refund')
    RETURNING id INTO v_refund_voucher;

    IF v_refund_dep > 0 THEN
      v_type_dep := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn cọc thanh lý');
      UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type_dep AND is_deposit IS DISTINCT FROM TRUE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_dep, 'Trả lại khách (cọc sau khấu trừ)', 1, v_refund_dep, p_move_out_date, p_move_out_date);
    END IF;

    IF v_refund_exc > 0 THEN
      v_type_excr := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền thừa thanh lý');
      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_excr AND is_deposit IS DISTINCT FROM FALSE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_excr, 'Hoàn tiền thừa khi thanh lý', 1, v_refund_exc, p_move_out_date, p_move_out_date);
    END IF;
  END IF;

  -- 4c. Khách trả thêm (TIỀN THẬT) — chế độ PAID: vào SỔ NHẬN đã chọn.
  IF v_S < 0 AND p_shortfall_mode = 'PAID' THEN
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Thu thanh lý (khách trả thêm)');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Khách trả thêm khi thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_rcpt, v_settle_inv, p_move_out_date, -v_S, 'APPROVED',
      'Khách trả thêm phần công nợ vượt tiền cọc khi thanh lý (tiền thật vào sổ nhận).' || COALESCE(E'\n' || p_notes, ''),
      'termination.extra_receipt')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Khách trả thêm khi thanh lý', 1, -v_S, p_move_out_date, p_move_out_date);
  END IF;

  -- 5. Recompute hoá đơn quyết toán.
  IF v_settle_inv IS NOT NULL THEN PERFORM public.recompute_invoice_for_id(v_settle_inv); END IF;

  -- 6. Thanh lý hợp đồng (ghi chú kèm bản quyết toán đầy đủ).
  UPDATE contracts
     SET status = 'TERMINATED', actual_end_date = p_move_out_date,
         notes = CASE WHEN notes IS NULL OR length(btrim(notes)) = 0
                        THEN '[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '') || E'\n' || v_breakdown
                        ELSE notes || E'\n[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '') || E'\n' || v_breakdown END,
         updated_at = NOW()
   WHERE id = p_contract_id;

  -- 7. Audit.
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date, termination_type,
      outstanding_debt, early_termination_fee, prorated_rent, prorated_days, prorated_services,
      total_deposit, refund_method, status, approved_by, approved_at, notes)
    VALUES (
      v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date, 'NORMAL',
      v_debt, v_penalty + v_extra, 0, 0, 0,
      v_deposit,
      CASE WHEN v_refund_dep > 0 OR v_refund_exc > 0 THEN 'TM'::payment_method ELSE NULL END,
      'COMPLETED', auth.uid(), NOW(),
      COALESCE(p_notes || E'\n', '') || v_breakdown);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'terminate_contract_move_out_impl: audit insert failed for %: %', p_contract_id, SQLERRM;
  END;

  RETURN jsonb_build_object(
    'contract_id', p_contract_id, 'settlement_invoice_id', v_settle_inv,
    'charges', v_charges, 'extra_charges_total', v_extra,
    'applied', v_applied, 'applied_deposit', v_applied_dep,
    'refund_deposit', v_refund_dep, 'refund_excess', v_refund_exc,
    'refund_voucher_id', v_refund_voucher,
    'net_settlement', v_S, 'shortfall_mode', p_shortfall_mode,
    'receipt_account_id', CASE WHEN v_S < 0 AND p_shortfall_mode = 'PAID' THEN v_acc_rcpt END,
    'acc_op', v_acc_op, 'acc_internal', v_acc_int
  );
END $function$;

REVOKE ALL ON FUNCTION public.terminate_contract_move_out_impl(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.terminate_contract_move_out_impl(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.terminate_contract_move_out_impl(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out_impl(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid) TO service_role;

CREATE FUNCTION public.terminate_contract_move_out(
  p_contract_id uuid,
  p_move_out_date date,
  p_deposit_refund numeric DEFAULT 0,
  p_penalty_fee numeric DEFAULT 0,
  p_excess_rent numeric DEFAULT 0,
  p_outstanding_debt numeric DEFAULT 0,
  p_notes text DEFAULT NULL::text,
  p_extra_charges jsonb DEFAULT '[]'::jsonb,
  p_shortfall_mode text DEFAULT 'PAID',
  p_receipt_account_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_room uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  SELECT room_id INTO v_room FROM public.contracts
   WHERE id = p_contract_id AND deleted_at IS NULL;
  IF NOT (
    public.is_super_admin()
    OR (v_room IS NOT NULL AND public.can_do_on_building('contracts','edit',
          (SELECT building_id FROM public.rooms WHERE id = v_room)))
  ) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên hợp đồng này' USING ERRCODE = '42501';
  END IF;
  RETURN public.terminate_contract_move_out_impl(
    p_contract_id, p_move_out_date, p_deposit_refund, p_penalty_fee,
    p_excess_rent, p_outstanding_debt, p_notes, p_extra_charges,
    p_shortfall_mode, p_receipt_account_id);
END $function$;

REVOKE ALL ON FUNCTION public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text, uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. forfeit_impl v3: cặp cấn cọc bỏ cọc trên sổ nội bộ (chữ ký giữ nguyên)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit_impl(p_contract_id uuid, p_forfeit_date date, p_extra_charges jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract       RECORD;
  v_building_id    uuid;
  v_invoice_id     uuid;
  v_extra_inv      uuid;
  v_extra          numeric(15,2) := 0;
  v_deposit        numeric(15,2);
  v_billing        text;
  v_billing_dep    text;
  v_billing_extra  text;
  v_cnumber        text;
  v_marker         text;
  v_acc_int        uuid;
  v_type_off       uuid;
  v_type_inc       uuid;
  v_chi_id         uuid;
  v_thu_id         uuid;
  v_kept_paid      numeric(15,2);
  v_paid_cnt       integer;
  v_unpaid_cnt     integer;
  v_cancelled_cnt  integer;
BEGIN
  SELECT * INTO v_contract
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN
    RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn';
  END IF;
  IF v_contract.room_id IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý';
  END IF;
  IF p_forfeit_date < v_contract.start_date THEN
    RAISE EXCEPTION 'Ngày bỏ cọc (%) không được trước ngày bắt đầu hợp đồng (%)',
      to_char(p_forfeit_date,'DD/MM/YYYY'), to_char(v_contract.start_date,'DD/MM/YYYY');
  END IF;
  SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;
  IF v_building_id IS NULL THEN
    RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng';
  END IF;

  -- Cọc forfeit = cọc THỰC đã thu (nguồn sự thật: contracts.deposit_paid).
  v_deposit := LEAST(COALESCE(v_contract.total_deposit, 0), COALESCE(v_contract.deposit_paid, 0));
  v_billing := to_char(COALESCE(p_forfeit_date, CURRENT_DATE), 'YYYY-MM');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_marker  := '[CẤN CỌC BỎ CỌC ' || p_contract_id::text || ']';

  v_acc_int := public._internal_settlement_account(v_contract.user_id);

  SELECT COALESCE(SUM(paid_amount), 0)
    INTO v_kept_paid
    FROM invoices
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN ('APPROVED','OVERDUE','PARTIAL_PAID')
     AND COALESCE(paid_amount, 0) > 0;

  UPDATE invoices
     SET status       = 'CANCELLED',
         total_amount = COALESCE(paid_amount, 0),
         notes        = CASE
                        WHEN notes IS NULL OR length(btrim(notes)) = 0
                          THEN '[Huỷ — thanh lý bỏ cọc ngày '
                               || to_char(p_forfeit_date,'DD/MM/YYYY')
                               || '; giữ lại ' || round(COALESCE(paid_amount,0))::bigint
                               || 'đ đã thu làm doanh thu, huỷ phần nợ '
                               || round(COALESCE(remaining_amount,0))::bigint || 'đ]'
                        ELSE notes
                             || E'\n[Huỷ — thanh lý bỏ cọc ngày '
                             || to_char(p_forfeit_date,'DD/MM/YYYY')
                             || '; giữ lại ' || round(COALESCE(paid_amount,0))::bigint
                             || 'đ đã thu làm doanh thu, huỷ phần nợ '
                             || round(COALESCE(remaining_amount,0))::bigint || 'đ]'
                      END,
         updated_at = NOW()
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN ('APPROVED','OVERDUE','PARTIAL_PAID')
     AND COALESCE(paid_amount, 0) > 0;
  GET DIAGNOSTICS v_paid_cnt = ROW_COUNT;

  UPDATE invoices
     SET status       = 'CANCELLED',
         total_amount = 0,
         notes        = CASE
                        WHEN notes IS NULL OR length(btrim(notes)) = 0
                          THEN '[Huỷ tự động — thanh lý bỏ cọc ngày '
                               || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                        ELSE notes
                             || E'\n[Huỷ tự động — thanh lý bỏ cọc ngày '
                             || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                      END,
         updated_at   = NOW()
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN ('APPROVED','OVERDUE','PARTIAL_PAID')
     AND COALESCE(paid_amount, 0) = 0;
  GET DIAGNOSTICS v_unpaid_cnt = ROW_COUNT;

  v_cancelled_cnt := COALESCE(v_paid_cnt, 0) + COALESCE(v_unpaid_cnt, 0);

  IF v_deposit > 0 THEN
    v_billing_dep := public._termination_free_billing_month(p_contract_id, v_billing);
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id,
      billing_month, issue_date, due_date,
      status, subtotal, discount_amount, total_amount,
      notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id,
      v_billing_dep, p_forfeit_date, p_forfeit_date,
      'APPROVED'::invoice_status, v_deposit, 0, v_deposit,
      'Hoá đơn thanh lý — khách bỏ cọc ngày ' || to_char(p_forfeit_date,'DD/MM/YYYY')
        || CASE WHEN v_cancelled_cnt > 0
                  THEN E'\n(Đã huỷ ' || v_cancelled_cnt || ' hoá đơn còn nợ'
                       || CASE WHEN v_kept_paid > 0
                                 THEN '; giữ lại ' || round(v_kept_paid)::bigint
                                      || 'đ đã thu làm doanh thu'
                                 ELSE '' END
                       || ')'
                  ELSE '' END
    )
    RETURNING id INTO v_invoice_id;

    INSERT INTO invoice_items (
      invoice_id, type, description,
      unit_price, quantity, coefficient, amount, sort_order
    ) VALUES (
      v_invoice_id, 'PENALTY',
      'Phí phạt khách bỏ cọc (giữ tiền cọc đã thu)',
      v_deposit, 1, 1, v_deposit, 1
    );

    -- Cặp bút toán nội bộ CHỜ DUYỆT — CẢ 2 CHÂN trên sổ nội bộ (net 0).
    v_type_off := public._termination_ensure_type(v_contract.user_id, 'expense', 'Cấn cọc chuyển doanh thu');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu bỏ cọc');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', 'Cấn cọc bỏ cọc → chuyển doanh thu — HĐ ' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_int, p_forfeit_date, v_deposit, 'UNAPPROVED',
            v_marker || ' Bút toán nội bộ: cọc khách bỏ chuyển thành doanh thu (chờ duyệt; không phải tiền thật).',
            'termination.forfeit_offset')
    RETURNING id INTO v_chi_id;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_chi_id, v_type_off, 'Cấn cọc bỏ cọc chuyển doanh thu', 1, v_deposit, p_forfeit_date, p_forfeit_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu bỏ cọc — HĐ ' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_int, v_invoice_id, p_forfeit_date, v_deposit, 'UNAPPROVED',
            v_marker || ' Bút toán nội bộ: doanh thu bỏ cọc (chờ duyệt → tất toán hoá đơn thanh lý; KQKD đếm theo hạng mục).',
            'termination.forfeit_revenue')
    RETURNING id INTO v_thu_id;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_thu_id, v_type_inc, 'Doanh thu bỏ cọc (cọc khách bỏ)', 1, v_deposit, p_forfeit_date, p_forfeit_date);
  END IF;

  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(SUM((j->>'amount')::numeric), 0) INTO v_extra
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE (j->>'amount') IS NOT NULL AND (j->>'amount') <> ''
       AND (j->>'amount')::numeric > 0;
  END IF;

  IF v_extra > 0 THEN
    v_billing_extra := public._termination_free_billing_month(p_contract_id, v_billing);
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, billing_month, issue_date, due_date, status, subtotal, discount_amount, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building_id, v_contract.room_id, v_billing_extra, p_forfeit_date, p_forfeit_date,
            'APPROVED'::invoice_status, 0, 0, 0,
            'Hoá đơn thu thêm khi thanh lý — khách bỏ cọc ngày ' || to_char(p_forfeit_date,'DD/MM/YYYY')
              || ' (kỳ ' || v_billing || ', thu riêng — không liên quan hoá đơn bù cọc).')
    RETURNING id INTO v_extra_inv;
    PERFORM public._termination_apply_extra_charges(v_extra_inv, p_extra_charges, p_forfeit_date, v_contract.user_id, p_contract_id);
    PERFORM public.recompute_invoice_for_id(v_extra_inv);
  END IF;

  UPDATE contracts
     SET status          = 'TERMINATED',
         actual_end_date = p_forfeit_date,
         notes           = CASE
                             WHEN notes IS NULL OR length(btrim(notes)) = 0
                               THEN '[Thanh lý — khách bỏ cọc ' || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                             ELSE notes || E'\n[Thanh lý — khách bỏ cọc ' || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                           END,
         updated_at      = NOW()
   WHERE id = p_contract_id;

  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date,
      termination_type,
      outstanding_debt, early_termination_fee, prorated_rent, prorated_days, prorated_services,
      total_deposit, status, approved_by, approved_at, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, p_forfeit_date, p_forfeit_date,
      'FORFEIT',
      0, v_deposit, 0, 0, 0,
      v_deposit, 'COMPLETED', auth.uid(), NOW(),
      'Khách bỏ cọc — đã tạo phiếu thu "Doanh thu bỏ cọc" (chờ duyệt) cho phần cọc thực thu ' || round(v_deposit)::bigint || 'đ.'
        || CASE WHEN v_kept_paid > 0
                  THEN ' Đã giữ lại ' || round(v_kept_paid)::bigint
                       || 'đ đã thu làm doanh thu.'
                  ELSE '' END
        || CASE WHEN v_extra > 0
                  THEN ' Hoá đơn thu thêm riêng ' || round(v_extra)::bigint || 'đ (chờ thu).'
                  ELSE '' END
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'terminate_contract_forfeit_impl: audit insert failed for %: %', p_contract_id, SQLERRM;
  END;

  RETURN jsonb_build_object(
    'contract_id',                p_contract_id,
    'invoice_id',                 v_invoice_id,
    'settlement_invoice_id',      v_invoice_id,
    'extra_invoice_id',           v_extra_inv,
    'extra_charges_total',        v_extra,
    'forfeit_amount',             v_deposit,
    'cancelled_invoices',         v_cancelled_cnt,
    'kept_paid_amount',           v_kept_paid,
    'pending_income_voucher_id',  v_thu_id,
    'pending_expense_voucher_id', v_chi_id,
    'acc_internal',               v_acc_int
  );
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Đóng số dư sổ ảo 'CỌC (giữ hộ khách)' của TENANT THẬT về 0 (bút toán khoá,
--    ngoài KQKD, không item). Demo tenants bỏ qua (sandbox reset riêng).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r RECORD;
  v_bal numeric;
  v_int uuid;
  v_bld uuid;
BEGIN
  FOR r IN
    SELECT a.id, a.user_id
      FROM accounts a
      JOIN super_admins sa ON sa.user_id = a.user_id
     WHERE a.name = 'CỌC (giữ hộ khách)' AND a.deleted_at IS NULL
  LOOP
    SELECT current_amount INTO v_bal FROM accounts_with_balance WHERE id = r.id;
    IF COALESCE(v_bal, 0) = 0 THEN CONTINUE; END IF;

    v_int := public._internal_settlement_account(r.user_id);
    v_bld := public._chung_building(r.user_id);

    -- Chân rời sổ CỌC (chiều theo dấu số dư) + chân đối ứng trên sổ nội bộ.
    IF v_bal > 0 THEN
      INSERT INTO income_expenses (user_id, type, name, building_id, account_id, voucher_date, total_amount, approval_status, business_result_accounting, notes, system_source)
      VALUES (r.user_id, 'EXPENSE', 'Khoá sổ CỌC ảo — chuyển theo dõi sang sổ nội bộ', v_bld, r.id, CURRENT_DATE, v_bal, 'APPROVED', FALSE,
              'Bút toán khoá sổ (chương trình thống nhất tài chính 04/07): sổ CỌC ảo ngừng dùng trong luồng thanh lý; nghĩa vụ cọc theo dõi tại contracts.deposit_paid (/deposits). Không phải tiền thật.',
              'adjustment.close_coc'),
             (r.user_id, 'INCOME', 'Khoá sổ CỌC ảo — nhận đối ứng (bút toán)', v_bld, v_int, CURRENT_DATE, v_bal, 'APPROVED', FALSE,
              'Chân đối ứng bút toán khoá sổ CỌC ảo. Không phải tiền thật.',
              'adjustment.close_coc');
    ELSE
      INSERT INTO income_expenses (user_id, type, name, building_id, account_id, voucher_date, total_amount, approval_status, business_result_accounting, notes, system_source)
      VALUES (r.user_id, 'INCOME', 'Khoá sổ CỌC ảo — cân về 0 (bút toán)', v_bld, r.id, CURRENT_DATE, -v_bal, 'APPROVED', FALSE,
              'Bút toán khoá sổ CỌC ảo (số dư âm cân về 0). Không phải tiền thật.',
              'adjustment.close_coc'),
             (r.user_id, 'EXPENSE', 'Khoá sổ CỌC ảo — chân đối ứng (bút toán)', v_bld, v_int, CURRENT_DATE, -v_bal, 'APPROVED', FALSE,
              'Chân đối ứng bút toán khoá sổ CỌC ảo. Không phải tiền thật.',
              'adjustment.close_coc');
    END IF;
  END LOOP;
END $$;
