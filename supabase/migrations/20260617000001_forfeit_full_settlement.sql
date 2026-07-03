-- =====================================================================
-- ⚠️⚠️⚠️  SUPERSEDED — KHÔNG APPLY RIÊNG LÊN DB ĐANG CHẠY  ⚠️⚠️⚠️
--
-- Đây là BẢN GỐC của terminate_contract_forfeit_impl (17/06). Thân hàm ở đây
-- dùng `v_deposit := COALESCE(total_deposit, 0)` và payment `'TM'` — CẢ HAI ĐÃ
-- BỊ THAY bởi các migration SAU (đã chạy live):
--   • 20260618000001_forfeit_use_paid_deposit.sql → v_deposit = LEAST(total_deposit,
--     deposit_paid)  (tránh CHI sổ thật phần cọc khách CHƯA đóng → sổ âm + doanh
--     thu bỏ cọc KHỐNG).
--   • payment 'TM' → 'CT' (Cấn trừ)  (tránh phồng ô Tiền mặt dashboard).
--   • 20260627000001_termination_extra_charges.sql → thêm p_extra_charges.
-- File này CHỈ giữ cho lịch sử migration đầy đủ (nó cũng là nơi ĐỊNH NGHĨA trigger
-- trg_forfeit_settle_on_approve). Khi rebuild tuần tự, các migration sau sẽ
-- CREATE OR REPLACE đè lại hàm này → trạng thái cuối đúng. TUYỆT ĐỐI KHÔNG chạy
-- riêng file này qua Management API lên DB production — sẽ HỒI QUY 2 lỗi tiền.
-- =====================================================================
-- terminate_contract_forfeit_impl — HẠCH TOÁN ĐẦY ĐỦ khi khách BỎ CỌC
--
-- VẤN ĐỀ bản cũ (20260530000001, nay là *_impl): forfeit làm DỞ DANG so với
-- move-out:
--   • Chỉ huỷ hoá đơn ĐÚNG THÁNG forfeit (billing_month = tháng bỏ cọc) →
--     hoá đơn còn nợ của THÁNG KHÁC (vd tiền phòng tháng kế đã xuất trước) bị
--     bỏ rơi, treo OVERDUE vĩnh viễn.
--   • Tạo "hoá đơn thanh lý" (PENALTY = cọc) rồi DỪNG: KHÔNG tạo phiếu thu, cọc
--     KHÔNG thành doanh thu (không vào KQKD), hoá đơn thanh lý treo nợ ảo.
--
-- YÊU CẦU (user):
--   1. Huỷ MỌI hoá đơn còn nợ của HĐ (mọi tháng). Đã thu 1 phần → giữ phần đã
--      thu làm doanh thu, huỷ phần nợ. Đã trả đủ → giữ nguyên.
--   2. Hoá đơn thanh lý (cọc bỏ → doanh thu): tạo SẴN cặp phiếu chuyển khoản
--      nội bộ từ sổ CỌC ở trạng thái CHỜ DUYỆT (UNAPPROVED). User vào DUYỆT →
--      cọc thành doanh thu (KQKD) + hoá đơn thanh lý → PAID. Trước khi duyệt:
--      chưa vào KQKD, chưa tất toán.
--   3. Kỳ ghi nhận = voucher_date của phiếu (sửa được trước khi duyệt).
--
-- Mô hình tiền giống move-out (20260603000022): cọc nằm ở sổ "CỌC (giữ hộ
-- khách)"; thanh lý = CHI sổ CỌC (is_deposit, ngoài KQKD) + THU sổ vận hành
-- (doanh thu, KQKD). Khác move-out ở chỗ: forfeit để CHỜ DUYỆT (không auto).
--
-- Cơ chế "duyệt → tất toán": invoices.paid_amount chỉ tính từ bảng payments
-- (recompute_invoice_for_id). Phiếu thu INCOME không tự cộng paid. Nên thêm
-- trigger: khi phiếu THU (marker [CẤN CỌC BỎ CỌC ...]) được duyệt → INSERT 1
-- dòng payments → trigger có sẵn flip hoá đơn thanh lý → PAID; đồng thời duyệt
-- nốt phiếu CHI cùng nhóm (1 cú bấm xong cả cặp). Đảo duyệt thì gỡ đối xứng.
-- =====================================================================

-- ── 1. Rewrite terminate_contract_forfeit_impl ────────────────────────
CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit_impl(p_contract_id uuid, p_forfeit_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract       RECORD;
  v_building_id    uuid;
  v_invoice_id     uuid;
  v_deposit        numeric(15,2);
  v_billing        text;
  v_cnumber        text;
  v_marker         text;
  v_acc_dep        uuid;            -- sổ CỌC (hoặc sổ đang chứa cọc HĐ)
  v_acc_op         uuid;            -- sổ vận hành của toà
  v_type_off       uuid;
  v_type_inc       uuid;
  v_chi_id         uuid;
  v_thu_id         uuid;
  v_kept_paid      numeric(15,2);   -- tổng đã thu (HĐ thu 1 phần) GIỮ làm doanh thu
  v_paid_cnt       integer;
  v_unpaid_cnt     integer;
  v_cancelled_cnt  integer;
BEGIN
  SELECT * INTO v_contract
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN
    RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn';
  END IF;
  IF v_contract.room_id IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý';
  END IF;
  SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;
  IF v_building_id IS NULL THEN
    RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng';
  END IF;

  v_deposit := COALESCE(v_contract.total_deposit, 0);
  v_billing := to_char(COALESCE(p_forfeit_date, CURRENT_DATE), 'YYYY-MM');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_marker  := '[CẤN CỌC BỎ CỌC ' || p_contract_id::text || ']';

  -- Đảm bảo cọc nằm trong sổ CỌC (backfill nếu HĐ cũ chưa có phiếu cọc) + lấy
  -- sổ đang chứa cọc; sổ vận hành để ghi doanh thu.
  v_acc_dep := public._ensure_initial_deposit_voucher(p_contract_id);
  IF v_acc_dep IS NULL THEN v_acc_dep := public._deposit_account(v_contract.user_id); END IF;
  v_acc_op  := public._termination_pick_account(v_contract.user_id, v_building_id);

  -- ── Tổng đã thu của các HĐ thu-1-phần sắp huỷ (giữ làm doanh thu) ──────
  SELECT COALESCE(SUM(paid_amount), 0)
    INTO v_kept_paid
    FROM invoices
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN ('APPROVED','OVERDUE','PARTIAL_PAID')
     AND COALESCE(paid_amount, 0) > 0;

  -- ── Huỷ HĐ ĐÃ THU một phần — GIỮ payment/phiếu thu làm doanh thu ───────
  -- (mọi tháng; total_amount hạ về paid_amount → remaining = 0)
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

  -- ── Huỷ mọi HĐ CHƯA thu của HĐ (mọi tháng; total_amount → 0) ──────────
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

  -- ── Hoá đơn thanh lý — PENALTY = cọc bị bỏ ────────────────────────────
  IF v_deposit > 0 THEN
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id,
      billing_month, issue_date, due_date,
      status, subtotal, discount_amount, total_amount,
      notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id,
      v_billing, p_forfeit_date, p_forfeit_date,
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
      'Phí phạt khách bỏ cọc (giữ tiền cọc)',
      v_deposit, 1, 1, v_deposit, 1
    );

    -- ── Cặp phiếu chuyển khoản nội bộ CHỜ DUYỆT (cọc → doanh thu) ───────
    v_type_off := public._termination_ensure_type(v_contract.user_id, 'expense', 'Cấn cọc chuyển doanh thu');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu bỏ cọc');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    -- CHI sổ CỌC (is_deposit, ngoài KQKD) — cọc rời sổ CỌC khi duyệt.
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'EXPENSE', 'Cấn cọc bỏ cọc → chuyển doanh thu — HĐ ' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_dep, p_forfeit_date, v_deposit, 'UNAPPROVED',
            v_marker || ' Cọc khách bỏ rời sổ CỌC, chuyển sang doanh thu (chờ duyệt).')
    RETURNING id INTO v_chi_id;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_chi_id, v_type_off, 'Cấn cọc bỏ cọc chuyển doanh thu', 1, v_deposit, p_forfeit_date, p_forfeit_date);

    -- THU sổ vận hành (KQKD) — doanh thu bỏ cọc; gắn hoá đơn thanh lý.
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu bỏ cọc — HĐ ' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_op, v_invoice_id, p_forfeit_date, v_deposit, 'UNAPPROVED',
            v_marker || ' Cọc khách bỏ ghi nhận doanh thu (chờ duyệt → tất toán hoá đơn thanh lý).')
    RETURNING id INTO v_thu_id;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_thu_id, v_type_inc, 'Doanh thu bỏ cọc (cọc khách bỏ)', 1, v_deposit, p_forfeit_date, p_forfeit_date);
  END IF;

  -- ── Thanh lý hợp đồng (trigger giải phóng phòng) ──────────────────────
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

  -- ── Audit row ─────────────────────────────────────────────────────────
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date,
      termination_type, total_deposit, status, approved_by, approved_at, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, p_forfeit_date, p_forfeit_date,
      'FORFEIT', v_deposit, 'COMPLETED', auth.uid(), NOW(),
      'Khách bỏ cọc — đã tạo phiếu thu "Doanh thu bỏ cọc" (chờ duyệt) từ sổ CỌC.'
        || CASE WHEN v_kept_paid > 0
                  THEN ' Đã giữ lại ' || round(v_kept_paid)::bigint
                       || 'đ đã thu làm doanh thu.'
                  ELSE '' END
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'contract_id',                p_contract_id,
    'invoice_id',                 v_invoice_id,
    'settlement_invoice_id',      v_invoice_id,
    'forfeit_amount',             v_deposit,
    'cancelled_invoices',         v_cancelled_cnt,
    'kept_paid_amount',           v_kept_paid,
    'pending_income_voucher_id',  v_thu_id,
    'pending_expense_voucher_id', v_chi_id
  );
END;
$function$;

-- ── 2. Trigger: duyệt phiếu "cấn cọc bỏ cọc" → tất toán hoá đơn + cascade ──
CREATE OR REPLACE FUNCTION public.trg_forfeit_settle_on_approve()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  v_pay_note text;
BEGIN
  -- Chỉ xử lý phiếu thuộc nhóm "cấn cọc bỏ cọc".
  IF NEW.notes IS NULL OR NEW.notes NOT LIKE '[CẤN CỌC BỎ CỌC %' THEN
    RETURN NULL;
  END IF;

  -- DUYỆT: UNAPPROVED → APPROVED
  IF NEW.approval_status = 'APPROVED'
     AND COALESCE(OLD.approval_status,'') <> 'APPROVED'
     AND NEW.deleted_at IS NULL THEN
    -- Duyệt nốt phiếu còn lại cùng nhóm (1 cú bấm xong cả cặp).
    UPDATE income_expenses
       SET approval_status = 'APPROVED',
           approved_by     = NEW.approved_by,
           approved_at     = NEW.approved_at,
           updated_at      = NOW()
     WHERE contract_id = NEW.contract_id
       AND id <> NEW.id
       AND notes LIKE '[CẤN CỌC BỎ CỌC %'
       AND deleted_at IS NULL
       AND approval_status = 'UNAPPROVED';

    -- Phiếu THU gắn hoá đơn → INSERT payments để hoá đơn thanh lý → PAID.
    IF NEW.type = 'INCOME' AND NEW.invoice_id IS NOT NULL AND COALESCE(NEW.total_amount,0) > 0 THEN
      v_pay_note := '[CẤN CỌC BỎ CỌC PAYMENT ' || NEW.id::text || ']';
      INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)
      SELECT NEW.user_id, NEW.invoice_id, NEW.total_amount, 'TM'::payment_method,
             COALESCE(NEW.voucher_date, CURRENT_DATE), v_pay_note
       WHERE NOT EXISTS (
         SELECT 1 FROM payments WHERE invoice_id = NEW.invoice_id AND notes = v_pay_note
       );
    END IF;
    RETURN NULL;
  END IF;

  -- ĐẢO DUYỆT: APPROVED → UNAPPROVED/CANCELLED (gỡ đối xứng)
  IF COALESCE(OLD.approval_status,'') = 'APPROVED'
     AND NEW.approval_status IN ('UNAPPROVED','CANCELLED') THEN
    IF NEW.type = 'INCOME' AND NEW.invoice_id IS NOT NULL THEN
      DELETE FROM payments
       WHERE invoice_id = NEW.invoice_id
         AND notes = '[CẤN CỌC BỎ CỌC PAYMENT ' || NEW.id::text || ']';
    END IF;
    UPDATE income_expenses
       SET approval_status = NEW.approval_status, updated_at = NOW()
     WHERE contract_id = NEW.contract_id
       AND id <> NEW.id
       AND notes LIKE '[CẤN CỌC BỎ CỌC %'
       AND deleted_at IS NULL
       AND approval_status = 'APPROVED';
    RETURN NULL;
  END IF;

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_forfeit_settle_on_approve ON income_expenses;
CREATE TRIGGER trg_forfeit_settle_on_approve
AFTER UPDATE OF approval_status ON income_expenses
FOR EACH ROW
EXECUTE FUNCTION public.trg_forfeit_settle_on_approve();

REVOKE ALL ON FUNCTION public.trg_forfeit_settle_on_approve() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
