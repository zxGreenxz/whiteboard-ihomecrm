-- =====================================================================
-- HOÀN LẠI KHÁCH KHI THANH LÝ (move-out) — chốt với chủ dự án 22/08/2026
--
-- VẤN ĐỀ: khách đóng tiền phòng cả tháng rồi đi sớm. Hộp thoại thanh lý không
-- có chỗ nào nhập khoản phải trả lại. Ba ô tiền đang có đều chặn đúng theo
-- thiết kế của chúng: hoàn cọc kẹp ở cọc thực thu, credit kẹp ở lot đang có,
-- "Thu thêm" chỉ nhận số dương. Công thức quyết toán thiếu hẳn vế "mình nợ
-- khách".
--
-- CÁCH SỬA: thêm tham số p_refund_items (mảng jsonb, cùng hình dạng với
-- p_extra_charges) chạy suốt ba lớp hàm, và một vế mới trong phép quyết toán.
--
-- ⚠ BA ĐIỂM PHẢI GIỮ — đã đo trên prod trước khi viết file này:
--
--  1. contract_terminations.refund_amount là cột GENERATED ALWAYS
--       = total_deposit − (outstanding_debt + prorated_rent + prorated_services
--         + early_termination_fee + notice_violation_fee + damage_fee
--         + cleaning_fee + other_fees)
--     và preview_termination_refund_v1 đối chiếu chính nó với cọc thật đang giữ
--     để gắn cờ VUOT_COC_THAT. Nên v_refund_dep PHẢI giữ nguyên
--     GREATEST(v_deposit − v_charges, 0) và KHÔNG được phụ thuộc khoản hoàn.
--     Vì thế khoản hoàn chỉ cấn vào v_charges_left — phần công nợ CÒN LẠI sau
--     khi cọc và credit đã cấn xong.
--     ⇒ TUYỆT ĐỐI KHÔNG ghi khoản hoàn vào prorated_rent/prorated_services dù
--       tên chúng nghe rất hợp: chúng nằm ở vế TRỪ và sẽ làm refund_amount teo.
--       Khoản hoàn đi vào CỘT MỚI, THƯỜNG: rent_refund_amount.
--
--  2. system_source='termination.refund' là dấu hiệu "tổng tiền TRẢ LẠI KHÁCH",
--     không phải "chỉ hoàn cọc". get_refund_forfeit_summary tự ghi trong chú
--     thích rằng nó cố ý lấy total_amount của CẢ PHIẾU, và nó ĐÃ gộp sẵn dòng
--     hoàn cọc + dòng hoàn tiền thừa. ⇒ dòng hoàn tiền phòng đi CHUNG phiếu đó,
--     không tách phiếu mới. Một phiếu, một lần duyệt, một lần chi.
--
--  3. KQKD đếm theo HẠNG MỤC (income_expense_types.is_deposit), không theo
--     phiếu. Hoàn cọc is_deposit=TRUE (ngoài KQKD, tiền giữ hộ). Hoàn tiền
--     phòng phải is_deposit=FALSE — tiền đó đã ghi thành doanh thu, trả lại là
--     giảm lãi thật. Dùng nhầm loại của hoàn cọc sẽ thổi phồng lợi nhuận.
--
-- VÌ SAO DROP RỒI CREATE, KHÔNG PHẢI CREATE OR REPLACE: Postgres không thêm
-- tham số được bằng CREATE OR REPLACE — nó đẻ overload thứ hai và PostgREST sẽ
-- chọn nhầm. ACL được cấp lại ĐÚNG như đã đo trên prod (impl không có
-- authenticated; _with_credit_v1 không có service_role).
--
-- KHÔNG đụng nhánh bỏ cọc (guard_termination_forfeit_voucher_v1 khoá cứng).
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- ── Dấu vết audit: cột MỚI, THƯỜNG. Không generated, không nằm trong công
--    thức refund_amount. Xem điểm 1 ở đầu file.
ALTER TABLE public.contract_terminations
  ADD COLUMN IF NOT EXISTS rent_refund_amount numeric(15,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.contract_terminations.rent_refund_amount IS
  'Tổng khoản HOÀN LẠI KHÁCH khi thanh lý (tiền phòng ngày không ở…). Cột thường, '
  'CỐ Ý nằm ngoài công thức generated refund_amount: refund_amount đo nghĩa vụ '
  'hoàn CỌC và được đối chiếu với cọc thật đang giữ.';

-- Preflight chấp nhận CẢ HAI trạng thái: chữ ký CŨ (lượt đầu) hoặc chữ ký MỚI
-- (chạy lại). Gate check-forward-migration-idempotent dán thân file này hai lần
-- trong một transaction, nên một preflight chỉ biết trạng thái "trước" sẽ ném ở
-- lượt hai và làm gate đỏ oan.
DO $preflight$
BEGIN
  IF to_regprocedure('public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid)') IS NULL
     AND to_regprocedure('public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Không thấy _impl ở cả chữ ký cũ lẫn mới — cây mã đã lệch. DỪNG.';
  END IF;
  IF to_regprocedure('public.terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid)') IS NULL
     AND to_regprocedure('public.terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Không thấy terminate_contract_move_out ở cả hai chữ ký. DỪNG.';
  END IF;
  IF to_regprocedure('public.terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text)') IS NULL
     AND to_regprocedure('public.terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Không thấy _with_credit_v1 ở cả hai chữ ký. DỪNG.';
  END IF;
END
$preflight$;

-- IF EXISTS: lượt hai không còn chữ ký cũ để drop. Thứ tự ngoài → trong để
-- không drop mất hàm đang được hàm khác gọi.
DROP FUNCTION IF EXISTS public.terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text);
DROP FUNCTION IF EXISTS public.terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid);
DROP FUNCTION IF EXISTS public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid);

CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_impl(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric DEFAULT 0, p_penalty_fee numeric DEFAULT 0, p_excess_rent numeric DEFAULT 0, p_outstanding_debt numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_extra_charges jsonb DEFAULT '[]'::jsonb, p_shortfall_mode text DEFAULT 'PAID'::text, p_receipt_account_id uuid DEFAULT NULL::uuid, p_refund_items jsonb DEFAULT '[]'::jsonb)
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
  v_owed      numeric(15,2) := 0;   -- tổng "Hoàn lại khách" (mình nợ khách)
  v_charges_left numeric(15,2);
  v_owed_applied numeric(15,2);
  v_refund_owed  numeric(15,2);
  v_type_rentref uuid;
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

  v_billing := to_char(COALESCE(p_move_out_date, public.org_today_v1(NULL)), 'YYYY-MM');
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

  IF jsonb_typeof(COALESCE(p_refund_items, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(SUM((j->>'amount')::numeric), 0) INTO v_owed
      FROM jsonb_array_elements(p_refund_items) AS t(j)
     WHERE (j->>'amount') IS NOT NULL AND (j->>'amount') <> ''
       AND (j->>'amount')::numeric > 0;
  END IF;

  v_charges     := v_debt + v_penalty + v_extra;
  v_pool        := v_deposit + v_excess;
  v_applied     := LEAST(v_pool + v_owed, v_charges);
  v_applied_dep := LEAST(v_deposit, v_charges);
  v_refund_dep  := v_deposit - v_applied_dep;
  v_refund_exc  := v_excess - LEAST(v_excess, GREATEST(v_charges - v_deposit, 0));
  -- "Hoàn lại khách" CHỈ được cấn vào phần công nợ CÒN LẠI sau khi cọc và credit
  -- đã cấn xong. Cấn sớm hơn sẽ làm v_refund_dep xê dịch — mà con số đó phải
  -- khớp cột GENERATED contract_terminations.refund_amount, nền của cảnh báo
  -- VUOT_COC_THAT trong nghĩa vụ hoàn cọc (preview_termination_refund_v1).
  v_charges_left := GREATEST(v_charges - v_deposit - v_excess, 0);
  v_owed_applied := LEAST(v_owed, v_charges_left);
  v_refund_owed  := v_owed - v_owed_applied;
  v_S           := v_pool + v_owed - v_charges;

  v_breakdown :=
       'QUYẾT TOÁN THANH LÝ ' || to_char(p_move_out_date,'DD/MM/YYYY') || ' — HĐ ' || v_cnumber
    || E'\n• Cọc đã thu: ' || to_char(v_deposit, 'FM999G999G999G990') || 'đ'
    || E'\n• Khấu trừ: công nợ ' || to_char(v_debt, 'FM999G999G999G990') || 'đ'
    || CASE WHEN v_penalty > 0 THEN ' + phí phạt ' || to_char(v_penalty, 'FM999G999G999G990') || 'đ' ELSE '' END
    || CASE WHEN v_extra   > 0 THEN ' + thu thêm ' || to_char(v_extra, 'FM999G999G999G990') || 'đ' ELSE '' END
    || ' = ' || to_char(v_charges, 'FM999G999G999G990') || 'đ'
    || E'\n• Cọc cấn vào khấu trừ: ' || to_char(v_applied_dep, 'FM999G999G999G990') || 'đ (bút toán nội bộ, không đụng sổ tiền thật)'
    || CASE WHEN v_excess > 0 THEN E'\n• Tiền thừa (credit) áp dụng: ' || to_char(v_excess, 'FM999G999G999G990') || 'đ (cấn ' || to_char(v_excess - v_refund_exc, 'FM999G999G999G990') || 'đ, hoàn ' || to_char(v_refund_exc, 'FM999G999G999G990') || 'đ)' ELSE '' END
    || CASE WHEN v_owed > 0 THEN E'\n• Hoàn lại khách (tiền phòng ngày không ở…): ' || to_char(v_owed, 'FM999G999G999G990') || 'đ (cấn ' || to_char(v_owed_applied, 'FM999G999G999G990') || 'đ, chi ' || to_char(v_refund_owed, 'FM999G999G999G990') || 'đ)' ELSE '' END
    || E'\n• Hoàn cọc lại khách: ' || to_char(v_refund_dep, 'FM999G999G999G990') || 'đ'
    || CASE WHEN v_S < 0 THEN E'\n• Khách còn phải trả: ' || to_char(-v_S, 'FM999G999G999G990') || 'đ ('
         || CASE WHEN p_shortfall_mode = 'PAID' THEN 'đã thu ngay khi thanh lý' ELSE 'GHI NỢ — chờ thu' END || ')'
       ELSE '' END
    || CASE WHEN v_refund_dep + v_refund_exc + v_refund_owed > 0 THEN E'\n• Tổng chi hoàn khách: ' || to_char(v_refund_dep + v_refund_exc + v_refund_owed, 'FM999G999G999G990') || 'đ (phiếu chi chờ duyệt — chọn sổ quỹ khi duyệt)' ELSE '' END;

  -- 1. HOÁ ĐƠN THANH LÝ RIÊNG (kind='SETTLEMENT', ĐÚNG kỳ tháng trả phòng).
  --    v4: KHÔNG đụng hoá đơn tháng nữa — dù nó chưa/đã PAID. Công nợ của nó
  --    vẫn được gạch ở bước 2 bằng payments 'CT' (không sửa nội dung hoá đơn).
  IF v_penalty > 0 OR v_extra > 0 THEN
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, kind, billing_month, issue_date, due_date, status, subtotal, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building, v_contract.room_id, 'SETTLEMENT',
      v_billing, p_move_out_date, p_move_out_date, 'APPROVED'::invoice_status, 0, 0,
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

  -- 3b. KHOẢN HOÀN BỊ CẤN VÀO CÔNG NỢ — cặp bút toán nội bộ, net 0 trên sổ nội
  --     bộ, KHÔNG đụng sổ tiền thật. Gương của cặp cấn cọc ở bước 3, khác ở chỗ
  --     chân chi mang loại is_deposit=FALSE: tiền phòng đã ghi doanh thu rồi nên
  --     trả lại là GIẢM LÃI THẬT, còn cọc là tiền giữ hộ nên nằm ngoài KQKD.
  IF v_owed_applied > 0 THEN
    v_type_rentref := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền phòng thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_rentref AND is_deposit IS DISTINCT FROM FALSE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', 'Hoàn tiền phòng cấn công nợ — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_owed_applied, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: khoản hoàn cho khách được cấn vào công nợ còn lại (không phải tiền thật).' || E'\n\n' || v_breakdown,
      'termination.rent_refund_offset')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_rentref, 'Hoàn tiền phòng (cấn công nợ)', 1, v_owed_applied, p_move_out_date, p_move_out_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu thanh lý (khoản hoàn cấn nợ) — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_owed_applied, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu từ phần công nợ được khoản hoàn cấn trừ.',
      'termination.rent_refund_revenue')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Doanh thu thanh lý (khoản hoàn cấn nợ)', 1, v_owed_applied, p_move_out_date, p_move_out_date);
  END IF;

  -- 4. HOÀN KHÁCH = TIỀN THẬT: 1 phiếu chi NHÁP, SỔ TRỐNG (chọn khi duyệt).
  IF v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', 'Trả khách thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, NULL, p_move_out_date, v_refund_dep + v_refund_exc + v_refund_owed, 'UNAPPROVED',
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

    IF v_refund_owed > 0 THEN
      v_type_rentref := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền phòng thanh lý');
      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_rentref AND is_deposit IS DISTINCT FROM FALSE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_rentref, 'Hoàn tiền phòng ngày khách không ở', 1, v_refund_owed, p_move_out_date, p_move_out_date);
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
      total_deposit, rent_refund_amount, refund_method, status, approved_by, approved_at, notes)
    VALUES (
      v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date, 'NORMAL',
      v_debt, v_penalty + v_extra, 0, 0, 0,
      v_deposit, v_owed,
      CASE WHEN v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN 'TM'::payment_method ELSE NULL END,
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
    'customer_refund_total', v_owed, 'customer_refund_applied', v_owed_applied,
    'refund_customer', v_refund_owed,
    'refund_voucher_id', v_refund_voucher,
    'net_settlement', v_S, 'shortfall_mode', p_shortfall_mode,
    'receipt_account_id', CASE WHEN v_S < 0 AND p_shortfall_mode = 'PAID' THEN v_acc_rcpt END,
    'acc_op', v_acc_op, 'acc_internal', v_acc_int
  );
END $function$
;

CREATE OR REPLACE FUNCTION public.terminate_contract_move_out(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric DEFAULT 0, p_penalty_fee numeric DEFAULT 0, p_excess_rent numeric DEFAULT 0, p_outstanding_debt numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_extra_charges jsonb DEFAULT '[]'::jsonb, p_shortfall_mode text DEFAULT 'PAID'::text, p_receipt_account_id uuid DEFAULT NULL::uuid, p_refund_items jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_room uuid;
  v_org uuid;
  v_owner uuid;
  v_building uuid;
  v_deposit_paid numeric;
  v_extra numeric := 0;
  v_cash_shortfall numeric := 0;
  v_receipt_account uuid;
  v_cash_authz boolean;
  v_core_writer boolean;
  v_opened_writer boolean := false;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT
    contract_row.room_id,
    contract_row.organization_id,
    contract_row.user_id,
    room_row.building_id,
    contract_row.deposit_paid
    INTO v_room, v_org, v_owner, v_building, v_deposit_paid
  FROM public.contracts contract_row
  LEFT JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE OF contract_row;

  IF NOT (
    public.is_super_admin()
    OR (
      v_room IS NOT NULL
      AND public.can_do_on_building(
        'contracts', 'edit',
        (SELECT room_row.building_id
         FROM public.rooms room_row
         WHERE room_row.id = v_room)
      )
    )
  ) THEN
    RAISE EXCEPTION 'Missing permission to terminate contract'
      USING ERRCODE = '42501';
  END IF;

  IF p_receipt_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.accounts account_row
    WHERE account_row.id = p_receipt_account_id
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
  ) THEN
    RAISE EXCEPTION 'Receipt account is outside the contract organization or is not a real active cashbook'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(sum((entry->>'amount')::numeric), 0)
      INTO v_extra
    FROM jsonb_array_elements(COALESCE(p_extra_charges, '[]'::jsonb)) item(entry)
    WHERE NULLIF(entry->>'amount', '') IS NOT NULL
      AND (entry->>'amount')::numeric > 0;
  END IF;

  v_cash_shortfall := GREATEST(
    COALESCE(p_outstanding_debt, 0)
      + COALESCE(p_penalty_fee, 0)
      + v_extra
      - LEAST(
          GREATEST(COALESCE(p_deposit_refund, 0), 0),
          COALESCE(v_deposit_paid, 0)
        )
      - GREATEST(COALESCE(p_excess_rent, 0), 0)
      - COALESCE((
          SELECT SUM((entry->>'amount')::numeric)
          FROM jsonb_array_elements(COALESCE(p_refund_items, '[]'::jsonb)) item(entry)
          WHERE jsonb_typeof(COALESCE(p_refund_items, '[]'::jsonb)) = 'array'
            AND NULLIF(entry->>'amount', '') IS NOT NULL
            AND (entry->>'amount')::numeric > 0
        ), 0),
    0
  );

  IF upper(COALESCE(p_shortfall_mode, 'PAID')) = 'PAID'
     AND v_cash_shortfall > 0 THEN
    v_receipt_account := COALESCE(
      p_receipt_account_id,
      public._collector_thu_account(auth.uid()),
      public._termination_pick_account(v_owner, v_building)
    );

    IF v_receipt_account IS NULL THEN
      RAISE EXCEPTION 'Cannot resolve an active real receipt account in the contract organization'
        USING ERRCODE = '42501';
    END IF;
    PERFORM 1
    FROM public.accounts account_row
    WHERE account_row.id = v_receipt_account
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cannot resolve an active real receipt account in the contract organization'
        USING ERRCODE = '42501';
    END IF;

    PERFORM app_private.lock_org_for_decision_v1(v_org);
    SELECT decision.allowed
      INTO v_cash_authz
    FROM app_private.authorize_tenant_action_v3(
      auth.uid(), v_org, 'thu_tien.collect', v_building, v_receipt_account
    ) decision;
    IF NOT COALESCE(v_cash_authz, false) THEN
      RAISE EXCEPTION 'Missing receipt permission or cashbook possession for termination collection'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    v_receipt_account := p_receipt_account_id;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_core_writer;

  IF NOT v_core_writer THEN
    PERFORM app_private.assert_contract_has_no_customer_credit_v1(
      p_contract_id, v_org
    );
    PERFORM app_private.begin_accounting_chain_write_v1();
    v_opened_writer := true;
  END IF;

  INSERT INTO app_private.termination_move_out_writer_context (
    transaction_id, backend_pid, organization_id, user_id,
    contract_id, building_id, room_id, move_out_date, opened_at
  ) VALUES (
    txid_current(), pg_backend_pid(), v_org, v_owner,
    p_contract_id, v_building, v_room, p_move_out_date, clock_timestamp()
  ) ON CONFLICT (transaction_id, backend_pid) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      user_id = EXCLUDED.user_id,
      contract_id = EXCLUDED.contract_id,
      building_id = EXCLUDED.building_id,
      room_id = EXCLUDED.room_id,
      move_out_date = EXCLUDED.move_out_date,
      opened_at = EXCLUDED.opened_at;

  BEGIN
    v_result := public.terminate_contract_move_out_impl(
      p_contract_id, p_move_out_date, COALESCE(p_deposit_refund, 0),
      COALESCE(p_penalty_fee, 0), COALESCE(p_excess_rent, 0),
      COALESCE(p_outstanding_debt, 0), p_notes,
      COALESCE(p_extra_charges, '[]'::jsonb),
      COALESCE(p_shortfall_mode, 'PAID'), v_receipt_account,
      COALESCE(p_refund_items, '[]'::jsonb)
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM app_private.termination_move_out_writer_context
    WHERE transaction_id = txid_current()
      AND backend_pid = pg_backend_pid();
    IF v_opened_writer THEN
      PERFORM app_private.end_accounting_chain_write_v1();
    END IF;
    RAISE;
  END;

  DELETE FROM app_private.termination_move_out_writer_context
  WHERE transaction_id = txid_current()
    AND backend_pid = pg_backend_pid();

  IF v_opened_writer THEN
    PERFORM app_private.end_accounting_chain_write_v1();
  END IF;
  RETURN v_result;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_with_credit_v1(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric, p_penalty_fee numeric, p_excess_rent numeric, p_outstanding_debt numeric, p_notes text, p_extra_charges jsonb, p_shortfall_mode text, p_receipt_account_id uuid, p_idempotency_key text, p_refund_items jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_credit_amount numeric(15,2) := round(COALESCE(p_excess_rent, 0), 2);
  v_org uuid;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_termination jsonb;
  v_credit jsonb;
  v_response jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_excess_rent = 'NaN'::numeric
     OR COALESCE(p_excess_rent, 0) < 0
     OR COALESCE(p_excess_rent, 0) IS DISTINCT FROM round(
       COALESCE(p_excess_rent, 0), 2
     ) THEN
    RAISE EXCEPTION 'Move-out credit amount must be non-negative with at most two decimals'
      USING ERRCODE = '22023';
  END IF;

  SELECT contract_row.organization_id INTO v_org
  FROM public.contracts contract_row
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Contract not found' USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object(
    'contract_id', p_contract_id,
    'move_out_date', p_move_out_date,
    'deposit_refund', p_deposit_refund,
    'penalty_fee', p_penalty_fee,
    'excess_rent', p_excess_rent,
    'outstanding_debt', p_outstanding_debt,
    'notes', p_notes,
    'extra_charges', COALESCE(p_extra_charges, '[]'::jsonb),
    'shortfall_mode', p_shortfall_mode,
    'receipt_account_id', p_receipt_account_id,
    'refund_items', COALESCE(p_refund_items, '[]'::jsonb)
  )::text);
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id,
    idempotency_key, payload_hash
  ) VALUES (
    v_org, 'contract.terminate.move_out.credit.v1', p_contract_id::text,
    v_actor, v_key, v_hash
  ) ON CONFLICT (
    organization_id, operation, subject_scope, actor_id, idempotency_key
  ) DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'contract.terminate.move_out.credit.v1'
    AND operation_row.subject_scope = p_contract_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;
  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key was reused with a different payload'
      USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  -- [A2] Tính năng áp credit chưa bật ⇒ CHẶN SỚM, trước khi ghi bất cứ thứ gì.
  -- Không sao chép nhánh deferred của forfeit sang đây: terminate_contract_move_out
  -- đã TIÊU credit trên trục tiền (cấn nợ CT + phiếu hoàn) NGAY trong lệnh dưới,
  -- nên hoãn burn-down = chi HAI LẦN. Chặn trước là cách duy nhất đúng.
  IF v_credit_amount > 0
     AND app_private.evaluate_feature_route('customer.credit.apply.v1', v_org)
         IS DISTINCT FROM 'CANONICAL' THEN
    RAISE EXCEPTION 'Tính năng áp tiền trả dư (credit) vào quyết toán chưa được kích hoạt, nên không thể thanh lý kèm % đ tiền thừa. Hãy để ô "Tiền phòng thừa" bằng 0 rồi thanh lý; khoản dư giữ nguyên trên sổ và xử lý riêng.',
      round(v_credit_amount)::bigint
      USING ERRCODE = '55000';
  END IF;
  PERFORM app_private.begin_accounting_chain_write_v1();
  v_termination := public.terminate_contract_move_out(
    p_contract_id, p_move_out_date, COALESCE(p_deposit_refund, 0),
    COALESCE(p_penalty_fee, 0), COALESCE(p_excess_rent, 0),
    COALESCE(p_outstanding_debt, 0), p_notes,
    COALESCE(p_extra_charges, '[]'::jsonb),
    COALESCE(p_shortfall_mode, 'PAID'), p_receipt_account_id,
    COALESCE(p_refund_items, '[]'::jsonb)
  );
  PERFORM app_private.end_accounting_chain_write_v1();

  IF v_credit_amount > 0 THEN
    v_credit := app_private.apply_customer_credit_fifo_v1(
      v_actor, p_contract_id, v_credit_amount, NULL, 'MOVE_OUT',
      'Apply customer credit during move-out settlement', v_key
    );
  ELSE
    v_credit := jsonb_build_object(
      'contract_id', p_contract_id,
      'application_kind', 'MOVE_OUT',
      'applied_amount', 0,
      'applications', '[]'::jsonb
    );
  END IF;

  v_response := jsonb_build_object(
    'termination', v_termination,
    'credit', v_credit
  );
  UPDATE app_private.canonical_write_operations
     SET subject_id = p_contract_id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_org
     AND operation = 'contract.terminate.move_out.credit.v1'
     AND subject_scope = p_contract_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;
  RETURN v_response;
END;
$function$
;

-- ── ACL: cấp lại ĐÚNG như đã đo trên prod trước khi drop. ──────────────────
REVOKE ALL ON FUNCTION public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text,jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text,jsonb) TO authenticated;

DO $postflight$
BEGIN
  -- Đúng MỘT overload mỗi tên: nếu còn hai, PostgREST sẽ chọn nhầm.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'terminate_contract_move_out') <> 1 THEN
    RAISE EXCEPTION 'terminate_contract_move_out có overload — PostgREST sẽ chọn nhầm. DỪNG.';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'terminate_contract_move_out_with_credit_v1') <> 1 THEN
    RAISE EXCEPTION '_with_credit_v1 có overload. DỪNG.';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'terminate_contract_move_out_impl') <> 1 THEN
    RAISE EXCEPTION '_impl có overload. DỪNG.';
  END IF;

  IF has_function_privilege('anon', 'public.terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.terminate_contract_move_out_with_credit_v1(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ACL _with_credit_v1 lệch so với bản đo trước khi drop. DỪNG.';
  END IF;
  IF has_function_privilege('authenticated', 'public.terminate_contract_move_out_impl(uuid,date,numeric,numeric,numeric,numeric,text,jsonb,text,uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '_impl không được mở cho authenticated. DỪNG.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contract_terminations'
      AND column_name = 'rent_refund_amount' AND is_generated = 'NEVER'
  ) THEN
    RAISE EXCEPTION 'rent_refund_amount phải là cột THƯỜNG, không generated. DỪNG.';
  END IF;
END
$postflight$;

COMMIT;

NOTIFY pgrst, 'reload schema';
