-- =====================================================================
-- A9 — bỏ cọc lấy nhầm số 0, ghi 0đ doanh thu trên tiền đang giữ
--
-- BUG: terminate_contract_forfeit_impl tính phần tịch thu bằng
--   v_deposit := LEAST(total_deposit, deposit_paid)
-- rồi bọc toàn bộ nghiệp vụ trong `IF v_deposit > 0`. Hợp đồng HĐT-062953 khai
-- ô "Tiền cọc" = 0 trong khi thực thu 4.000.000đ ⇒ LEAST = 0 ⇒ bấm bỏ cọc
-- chạy "thành công" nhưng KHÔNG hoá đơn, KHÔNG phiếu, 0đ doanh thu. Im lặng.
-- Ghi chú ngay trên dòng đó còn viết nguồn sự thật là `deposit_paid` — code làm
-- ngược với chính ghi chú của nó.
--
-- VÌ SAO KHÔNG đổi thành COALESCE(deposit_paid, 0):
-- đo trên production, 4 hợp đồng ACTIVE có deposit_paid > total_deposit, và
-- 3/4 phần dôi đến từ phiếu "[Accounting repair] Contract deposit" ĐẾM TRÙNG
-- với phiếu thu cọc tường minh:
--   HD-2026-00001 +2.000.000 (2 mục repair) · HD-2026-00012 +1.500.000 (1)
--   HD-2026-00024   +300.000 (2 mục repair)          → cộng 3.800.000đ
-- Lấy thẳng deposit_paid = ghi KHỐNG 3.800.000đ doanh thu vào KQKD, và KQKD
-- chảy thẳng sang engine chia lợi nhuận cổ đông (tiền chi THẬT).
-- Chỉ HĐT-062953 (0 mục repair) mới là ca thật.
--
-- CÁCH SỬA: giữ nguyên công thức, thêm guard DỪNG khi hai số lệch nhau, kèm
-- thông báo nói rõ cả hai khả năng và cảnh báo đừng nâng "Tiền cọc" để lách.
-- Biến im lặng mất 4.000.000đ thành lỗi nhìn thấy được.
--
-- Chữ ký GIỮ NGUYÊN 100% ⇒ CREATE OR REPLACE thay tại chỗ.
-- =====================================================================

begin;

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
  -- [A9] Cọc đã thu > cọc theo hợp đồng ⇒ DỪNG, không đoán.
  -- Công thức LEAST() bên dưới lấy số NHỎ hơn, nên khi ô "Tiền cọc" trên hợp
  -- đồng khai 0 mà thực đã thu (vd HĐT-062953: 0 / 4.000.000) thì v_deposit = 0
  -- và TOÀN BỘ khối doanh thu bị bỏ qua trong im lặng: không hoá đơn, không
  -- phiếu, 0đ doanh thu trên tiền đang giữ trong két.
  --
  -- KHÔNG sửa thành COALESCE(deposit_paid,0): đo được 3/4 hợp đồng dôi ra là do
  -- phiếu "[Accounting repair] Contract deposit" ĐẾM TRÙNG với phiếu thu cọc
  -- tường minh (2.000.000 + 1.500.000 + 300.000 = 3.800.000đ). Lấy thẳng
  -- deposit_paid sẽ ghi KHỐNG đúng số đó vào KQKD rồi chảy sang chia lợi nhuận.
  IF COALESCE(v_contract.deposit_paid, 0) > COALESCE(v_contract.total_deposit, 0) THEN
    RAISE EXCEPTION 'Không thanh lý được: cọc ĐÃ THU (% đ) lớn hơn cọc THEO HỢP ĐỒNG (% đ), dôi % đ. Hệ thống không tự đoán số nào đúng. Hãy kiểm tra sổ cọc của hợp đồng: nếu có phiếu cọc bị ĐẾM TRÙNG thì huỷ/điều chỉnh phiếu đó; nếu ô "Tiền cọc" trên hợp đồng khai thiếu thì sửa lại cho khớp số THỰC NHẬN. Đừng nâng "Tiền cọc" chỉ để chạy được lệnh — làm vậy sẽ ghi khống phần dôi thành doanh thu.',
      round(COALESCE(v_contract.deposit_paid, 0))::bigint,
      round(COALESCE(v_contract.total_deposit, 0))::bigint,
      round(COALESCE(v_contract.deposit_paid,0) - COALESCE(v_contract.total_deposit,0))::bigint
      USING ERRCODE = '55000';
  END IF;
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
    -- v4: hoá đơn bù cọc mang ĐÚNG kỳ tháng bỏ cọc (kind='SETTLEMENT' —
    -- partial unique không còn chặn; thôi mượn slot tháng trống).
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id,
      kind, billing_month, issue_date, due_date,
      status, subtotal, discount_amount, total_amount,
      notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id,
      'SETTLEMENT', v_billing, p_forfeit_date, p_forfeit_date,
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

    -- Cặp bút toán nội bộ TỰ DUYỆT — CẢ 2 CHÂN trên sổ nội bộ (net 0).
    v_type_off := public._termination_ensure_type(v_contract.user_id, 'expense', 'Cấn cọc chuyển doanh thu');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu bỏ cọc');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', 'Cấn cọc bỏ cọc → chuyển doanh thu — HĐ ' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_int, p_forfeit_date, v_deposit, 'UNAPPROVED',
            v_marker || ' Bút toán nội bộ: cọc khách bỏ chuyển thành doanh thu (tự duyệt; không phải tiền thật — không vào sổ quỹ).',
            'termination.forfeit_offset')
    RETURNING id INTO v_chi_id;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_chi_id, v_type_off, 'Cấn cọc bỏ cọc chuyển doanh thu', 1, v_deposit, p_forfeit_date, p_forfeit_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu bỏ cọc — HĐ ' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_int, v_invoice_id, p_forfeit_date, v_deposit, 'UNAPPROVED',
            v_marker || ' Bút toán nội bộ: doanh thu bỏ cọc (tự duyệt → tất toán hoá đơn thanh lý; KQKD đếm theo hạng mục).',
            'termination.forfeit_revenue')
    RETURNING id INTO v_thu_id;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_thu_id, v_type_inc, 'Doanh thu bỏ cọc (cọc khách bỏ)', 1, v_deposit, p_forfeit_date, p_forfeit_date);

    -- 7af: cặp bút toán nội bộ TỰ DUYỆT ngay trong writer (hướng A).
    -- Đóng dấu bản chất trước — Finance V2 hết coi đây là phiếu tiền thật.
    UPDATE public.income_expenses
       SET posting_mode   = 'NON_CASH',
           posting_status = 'NOT_APPLICABLE',
           review_state   = 'RESOLVED'
     WHERE id IN (v_chi_id, v_thu_id);

    -- Token cho CẢ HAI chân: chân doanh thu do lệnh dưới đổi, chân đối ứng do
    -- cascade trg_forfeit_settle_on_approve đổi — guard a05 đòi token từng phiếu.
    INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
    VALUES (v_thu_id, pg_current_xact_id(), 'APPROVED'),
           (v_chi_id, pg_current_xact_id(), 'APPROVED');

    -- Duyệt chân doanh thu → cascade duyệt chân đối ứng + tất toán hoá đơn.
    UPDATE public.income_expenses
       SET approval_status = 'APPROVED',
           approved_by     = COALESCE(auth.uid(), v_contract.user_id),
           approved_at     = now()
     WHERE id = v_thu_id;

    DELETE FROM app_private.ie_transition_authorization
     WHERE income_expense_id IN (v_thu_id, v_chi_id)
       AND xid = pg_current_xact_id();
  END IF;

  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(SUM((j->>'amount')::numeric), 0) INTO v_extra
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE (j->>'amount') IS NOT NULL AND (j->>'amount') <> ''
       AND (j->>'amount')::numeric > 0;
  END IF;

  IF v_extra > 0 THEN
    -- v4: hoá đơn thu thêm cũng mang ĐÚNG kỳ tháng bỏ cọc, kind='SETTLEMENT'.
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, kind, billing_month, issue_date, due_date, status, subtotal, discount_amount, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building_id, v_contract.room_id, 'SETTLEMENT', v_billing, p_forfeit_date, p_forfeit_date,
            'APPROVED'::invoice_status, 0, 0, 0,
            'Hoá đơn thu thêm khi thanh lý — khách bỏ cọc ngày ' || to_char(p_forfeit_date,'DD/MM/YYYY')
              || ' (thu riêng — không liên quan hoá đơn bù cọc).')
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
$function$
;

notify pgrst, 'reload schema';

commit;
