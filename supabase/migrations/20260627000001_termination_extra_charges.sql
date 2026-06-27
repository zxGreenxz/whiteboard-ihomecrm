-- =====================================================================
-- THU THÊM khi thanh lý hợp đồng (move-out & bỏ cọc)
--
-- Bổ sung tham số `p_extra_charges jsonb` cho 2 RPC thanh lý để ghi nhận các
-- khoản thu thêm itemize (tiền phòng+nước+PDV theo ngày ở thêm, tiền điện chốt
-- cuối kỳ, tiền vệ sinh, khoản tuỳ ý) thay cho ô "Phí phạt" mơ hồ.
--
-- Định dạng p_extra_charges (mảng):
--   [{"kind":"PRORATED","description":"...","amount":850000,"unit_price":850000,"days":5},
--    {"kind":"ELECTRIC","description":"...","amount":196000,"previous_reading":1234,
--     "current_reading":1290,"unit_price":3500,"meter_id":"<uuid|null>"},
--    {"kind":"CLEANING","description":"Tiền vệ sinh","amount":200000},
--    {"kind":"CUSTOM","description":"...","amount":120000}]
--   Map kind → invoice_items.type: PRORATED→RENT, ELECTRIC→SERVICE, còn lại→OTHER.
--
-- Hành vi 2 chế độ (chốt với user):
--   • MOVE_OUT: thu thêm GỘP vào 1 hoá đơn thanh lý duy nhất, cộng vào v_charges
--     (cấn vào cọc) — thay vai trò của phí phạt cũ.
--   • FORFEIT : thu thêm tạo 1 hoá đơn AR THU TIỀN KHÁCH RIÊNG (chờ thu), TÁCH
--     biệt với hoá đơn thanh lý bù cọc-vào-doanh-thu (giữ nguyên logic cũ).
--
-- ELECTRIC item → tạo thêm 1 bản ghi meter_readings đã duyệt (chốt số điện);
-- không có trigger nào tự sinh invoice từ meter_reading nên không trùng tiền.
--
-- Thêm param → phải DROP chữ ký cũ rồi CREATE lại cả wrapper + impl (tránh
-- overload nhập nhằng cho PostgREST). Giữ nguyên trigger trg_forfeit_settle_on_approve
-- và các helper _ensure_initial_deposit_voucher / _termination_pick_account / ...
-- =====================================================================

-- ── Helper dùng chung: ghi các khoản thu thêm vào 1 hoá đơn + chốt điện ──
CREATE OR REPLACE FUNCTION public._termination_apply_extra_charges(
  p_invoice_id    uuid,
  p_extra_charges jsonb,
  p_date          date,
  p_user_id       uuid,
  p_contract_id   uuid
) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec      RECORD;
  v_total  numeric(15,2) := 0;
  v_sort   integer;
  v_kind   text;
  v_desc   text;
  v_amount numeric(15,2);
  v_prev   numeric(10,2);
  v_curr   numeric(10,2);
  v_unit   numeric(15,2);
  v_meter  uuid;
  v_type   invoice_item_type;
BEGIN
  IF p_invoice_id IS NULL
     OR p_extra_charges IS NULL
     OR jsonb_typeof(p_extra_charges) <> 'array' THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(MAX(sort_order), 0) + 1 INTO v_sort
    FROM invoice_items WHERE invoice_id = p_invoice_id;

  FOR rec IN SELECT j FROM jsonb_array_elements(p_extra_charges) AS t(j) LOOP
    v_amount := NULLIF(rec.j->>'amount', '')::numeric;
    IF v_amount IS NULL OR v_amount <= 0 THEN CONTINUE; END IF;

    v_kind := COALESCE(rec.j->>'kind', 'CUSTOM');
    v_desc := COALESCE(NULLIF(btrim(rec.j->>'description'), ''), 'Khoản thu thêm');
    v_unit := NULLIF(rec.j->>'unit_price', '')::numeric;
    v_prev := NULLIF(rec.j->>'previous_reading', '')::numeric;
    v_curr := NULLIF(rec.j->>'current_reading', '')::numeric;
    v_type := CASE v_kind
                WHEN 'PRORATED' THEN 'RENT'
                WHEN 'ELECTRIC' THEN 'SERVICE'
                ELSE 'OTHER' END::invoice_item_type;

    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, previous_reading, current_reading, sort_order)
    VALUES (p_invoice_id, v_type, v_desc, COALESCE(v_unit, v_amount), 1, 1, v_amount, v_prev, v_curr, v_sort);
    v_sort  := v_sort + 1;
    v_total := v_total + v_amount;

    -- Chốt số điện → ghi 1 bản ghi meter_readings đã duyệt. Không chặn thanh lý
    -- nếu chèn lỗi (vd trùng chỉ số tháng) — bọc trong sub-block.
    IF v_kind = 'ELECTRIC' AND v_curr IS NOT NULL THEN
      v_meter := NULLIF(rec.j->>'meter_id', '')::uuid;
      IF v_meter IS NOT NULL THEN
        BEGIN
          -- reading_code unique TOÀN CỤC nhưng generator mặc định đánh số theo
          -- user → đụng mã giữa các user. Cấp mã riêng (prefix TLY = thanh lý)
          -- để bỏ qua trigger auto_generate_reading_code và không đụng độ.
          INSERT INTO meter_readings (user_id, contract_id, meter_id, reading_code, reading_date, previous_reading, current_reading, status, approved_by, approved_at)
          VALUES (p_user_id, p_contract_id, v_meter,
                  'TLY' || to_char(p_date,'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8)),
                  p_date, COALESCE(v_prev, 0), v_curr, 'APPROVED', auth.uid(), NOW());
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      END IF;
    END IF;
  END LOOP;

  IF v_total > 0 THEN
    UPDATE invoices
       SET subtotal     = COALESCE(subtotal, 0) + v_total,
           total_amount = COALESCE(total_amount, 0) + v_total,
           updated_at   = NOW()
     WHERE id = p_invoice_id;
  END IF;

  RETURN v_total;
END $$;
REVOKE ALL ON FUNCTION public._termination_apply_extra_charges(uuid, jsonb, date, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ── Helper: tìm billing_month "trống" cho HĐ (né unique partial index) ──
-- invoices có UNIQUE (contract_id, billing_month) WHERE not-deleted & <>CANCELLED.
-- Forfeit cần 2 hoá đơn (bù cọc + thu thêm) → hoá đơn thứ 2 phải sang tháng kế
-- chưa bị chiếm. Trả tháng đầu tiên còn trống tính từ p_start (dạng 'YYYY-MM').
CREATE OR REPLACE FUNCTION public._termination_free_billing_month(p_contract_id uuid, p_start text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE m text := p_start; i int := 0;
BEGIN
  WHILE i < 60 AND EXISTS (
    SELECT 1 FROM invoices
     WHERE contract_id = p_contract_id AND billing_month = m
       AND deleted_at IS NULL AND status <> 'CANCELLED'
  ) LOOP
    m := to_char((to_date(m || '-01','YYYY-MM-DD') + interval '1 month'), 'YYYY-MM');
    i := i + 1;
  END LOOP;
  RETURN m;
END $$;
REVOKE ALL ON FUNCTION public._termination_free_billing_month(uuid, text) FROM PUBLIC, anon, authenticated;

-- =====================================================================
-- 1. terminate_contract_move_out_impl  (thêm p_extra_charges)
-- =====================================================================
DROP FUNCTION IF EXISTS public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text);
DROP FUNCTION IF EXISTS public.terminate_contract_move_out_impl(uuid, date, numeric, numeric, numeric, numeric, text);

CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_impl(
  p_contract_id      uuid,
  p_move_out_date    date,
  p_deposit_refund   numeric DEFAULT 0,
  p_penalty_fee      numeric DEFAULT 0,
  p_excess_rent      numeric DEFAULT 0,
  p_outstanding_debt numeric DEFAULT 0,
  p_notes            text    DEFAULT NULL,
  p_extra_charges    jsonb   DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contract  RECORD;
  v_building  uuid;
  v_acc_op    uuid;   -- sổ vận hành (HKDHUY...)
  v_acc_dep   uuid;   -- sổ CỌC (hoặc sổ đang chứa cọc HĐ)
  v_billing   text;
  v_cnumber   text;
  v_deposit   numeric(15,2) := COALESCE(p_deposit_refund, 0);
  v_penalty   numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess    numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt      numeric(15,2) := COALESCE(p_outstanding_debt, 0);
  v_extra     numeric(15,2) := 0;
  v_charges   numeric(15,2);
  v_pool      numeric(15,2);
  v_applied   numeric(15,2);
  v_S         numeric(15,2);
  v_settle_inv uuid;
  v_next_sort integer;
  v_type_inc  uuid;
  v_type_off  uuid;
  v_type_dep  uuid;
  v_voucher   uuid;
  rec         RECORD;
BEGIN
  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hợp đồng không tồn tại'; END IF;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn'; END IF;
  IF v_contract.room_id IS NULL THEN RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý'; END IF;
  SELECT building_id INTO v_building FROM rooms WHERE id = v_contract.room_id;
  IF v_building IS NULL THEN RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng'; END IF;

  v_billing := to_char(COALESCE(p_move_out_date, CURRENT_DATE), 'YYYY-MM');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_acc_op  := public._termination_pick_account(v_contract.user_id, v_building);
  v_acc_dep := public._ensure_initial_deposit_voucher(p_contract_id);   -- đảm bảo cọc trên sổ + lấy sổ cọc
  IF v_acc_dep IS NULL THEN v_acc_dep := public._deposit_account(v_contract.user_id); END IF;

  -- Tổng thu thêm (cấn vào cọc cùng công nợ/phạt).
  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(SUM((j->>'amount')::numeric), 0) INTO v_extra
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE (j->>'amount') IS NOT NULL AND (j->>'amount') <> ''
       AND (j->>'amount')::numeric > 0;
  END IF;

  v_charges := v_debt + v_penalty + v_extra;
  v_pool    := v_deposit + v_excess;
  v_applied := LEAST(v_pool, v_charges);
  v_S       := v_pool - v_charges;

  -- 1. Hoá đơn công nợ tháng + gộp phí phạt + thu thêm.
  SELECT id INTO v_settle_inv FROM invoices
   WHERE contract_id = p_contract_id AND billing_month = v_billing
     AND deleted_at IS NULL AND status <> 'CANCELLED'
   ORDER BY (status = 'PAID'), created_at LIMIT 1;

  -- Tạo hoá đơn thanh lý nếu có phí phạt HOẶC thu thêm mà chưa có hoá đơn tháng.
  IF (v_penalty > 0 OR v_extra > 0) AND v_settle_inv IS NULL THEN
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, billing_month, issue_date, due_date, status, subtotal, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building, v_contract.room_id, v_billing, p_move_out_date, p_move_out_date, 'APPROVED'::invoice_status, 0, 0,
      'Hoá đơn thanh lý — khách rời phòng ngày ' || to_char(p_move_out_date,'DD/MM/YYYY') || COALESCE(E'\n' || p_notes, ''))
    RETURNING id INTO v_settle_inv;
  END IF;

  IF v_penalty > 0 THEN
    SELECT COALESCE(MAX(sort_order),0)+1 INTO v_next_sort FROM invoice_items WHERE invoice_id = v_settle_inv;
    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
    VALUES (v_settle_inv, 'PENALTY', 'Phí phạt thanh lý', v_penalty, 1, 1, v_penalty, v_next_sort);
    UPDATE invoices SET subtotal = COALESCE(subtotal,0)+v_penalty, total_amount = COALESCE(total_amount,0)+v_penalty, updated_at = NOW() WHERE id = v_settle_inv;
  END IF;

  -- Thu thêm itemize (cập nhật subtotal/total + chốt số điện).
  IF v_extra > 0 THEN
    PERFORM public._termination_apply_extra_charges(v_settle_inv, p_extra_charges, p_move_out_date, v_contract.user_id, p_contract_id);
  END IF;

  -- 2. Đánh dấu mọi hoá đơn còn nợ → PAID (payments = AR; doanh thu ghi ở B3-4).
  FOR rec IN
    SELECT id, (total_amount - paid_amount) AS remaining FROM invoices
     WHERE contract_id = p_contract_id AND deleted_at IS NULL AND status <> 'CANCELLED'
       AND (total_amount - paid_amount) > 0
     ORDER BY billing_month, created_at
  LOOP
    INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)
    VALUES (v_contract.user_id, rec.id, rec.remaining, 'TM'::payment_method, p_move_out_date,
            'Quyết toán khi thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY'));
  END LOOP;

  -- 3. CHUYỂN KHOẢN nội bộ: applied từ sổ CỌC → sổ vận hành (ghi doanh thu).
  IF v_applied > 0 THEN
    v_type_off := public._termination_ensure_type(v_contract.user_id, 'expense', 'Cấn cọc chuyển doanh thu');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    -- CHI sổ CỌC (is_deposit, ngoài KQKD) — cọc rời sổ CỌC.
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'EXPENSE', 'Cấn cọc → chuyển doanh thu — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_dep, p_move_out_date, v_applied, 'APPROVED',
      '[CHUYỂN KHOẢN] Cọc cấn nợ/phạt, chuyển sang sổ vận hành thành doanh thu.')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_off, 'Cấn cọc chuyển doanh thu', 1, v_applied, p_move_out_date, p_move_out_date);

    -- THU sổ vận hành (KQKD) — doanh thu thanh lý vào toà.
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_op, v_settle_inv, p_move_out_date, v_applied, 'APPROVED',
      '[CHUYỂN KHOẢN] Doanh thu thanh lý (cọc cấn nợ/phạt) — chuyển từ sổ CỌC.')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Doanh thu thanh lý (cấn cọc)', 1, v_applied, p_move_out_date, p_move_out_date);
  END IF;

  -- 4. Quyết toán ròng.
  IF v_S > 0 THEN
    -- Chủ trả khách: CHI từ sổ CỌC = S (is_deposit, ngoài KQKD) — phiếu trả khách thực tế.
    v_type_dep := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn cọc thanh lý');
    UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type_dep AND is_deposit IS DISTINCT FROM TRUE;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'EXPENSE', 'Trả khách thanh lý (hoàn cọc sau khấu trừ) — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_dep, p_move_out_date, v_S, 'APPROVED',
      'Chủ nhà trả lại khách khi thanh lý (đã trừ công nợ/phạt) — chi từ sổ CỌC.' || COALESCE(E'\n' || p_notes, ''))
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_dep, 'Trả lại khách (cọc sau khấu trừ)', 1, v_S, p_move_out_date, p_move_out_date);

  ELSIF v_S < 0 THEN
    -- Khách trả thêm: THU sổ vận hành = |S| (doanh thu, KQKD).
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Thu thanh lý (khách trả thêm)');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'INCOME', 'Khách trả thêm khi thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_op, v_settle_inv, p_move_out_date, -v_S, 'APPROVED',
      'Khách trả thêm phần công nợ vượt tiền cọc khi thanh lý.' || COALESCE(E'\n' || p_notes, ''))
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Khách trả thêm khi thanh lý', 1, -v_S, p_move_out_date, p_move_out_date);
  END IF;

  -- 5. Hoá đơn → PAID.
  IF v_settle_inv IS NOT NULL THEN PERFORM public.recompute_invoice_for_id(v_settle_inv); END IF;

  -- 6. Thanh lý hợp đồng.
  UPDATE contracts
     SET status = 'TERMINATED', actual_end_date = p_move_out_date,
         notes = CASE WHEN notes IS NULL OR length(btrim(notes)) = 0
                        THEN '[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '')
                        ELSE notes || E'\n[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '') END,
         updated_at = NOW()
   WHERE id = p_contract_id;

  -- 7. Audit.
  BEGIN
    INSERT INTO contract_terminations (user_id, contract_id, termination_date, actual_move_out_date, termination_type, outstanding_debt, early_termination_fee, total_deposit, total_deductions, refund_amount, status, approved_by, approved_at, notes)
    VALUES (v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date, 'NORMAL', v_debt, v_penalty + v_extra, COALESCE(v_contract.total_deposit, 0), v_applied, GREATEST(v_S, 0), 'COMPLETED', auth.uid(), NOW(), p_notes);
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object(
    'contract_id', p_contract_id, 'settlement_invoice_id', v_settle_inv,
    'charges', v_charges, 'extra_charges_total', v_extra, 'applied', v_applied, 'net_settlement', v_S,
    'acc_op', v_acc_op, 'acc_deposit', v_acc_dep
  );
END $$;

-- Wrapper authz move_out (thêm p_extra_charges).
CREATE OR REPLACE FUNCTION public.terminate_contract_move_out(
  p_contract_id     uuid,
  p_move_out_date   date,
  p_deposit_refund  numeric DEFAULT 0,
  p_penalty_fee     numeric DEFAULT 0,
  p_excess_rent     numeric DEFAULT 0,
  p_outstanding_debt numeric DEFAULT 0,
  p_notes           text    DEFAULT NULL,
  p_extra_charges   jsonb   DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
    p_excess_rent, p_outstanding_debt, p_notes, p_extra_charges);
END $$;

REVOKE ALL     ON FUNCTION public.terminate_contract_move_out_impl(uuid, date, numeric, numeric, numeric, numeric, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text, jsonb)      FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text, jsonb)      TO authenticated;

-- =====================================================================
-- 2. terminate_contract_forfeit_impl  (thêm p_extra_charges → hoá đơn AR riêng)
-- =====================================================================
DROP FUNCTION IF EXISTS public.terminate_contract_forfeit(uuid, date);
DROP FUNCTION IF EXISTS public.terminate_contract_forfeit_impl(uuid, date);

CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit_impl(
  p_contract_id   uuid,
  p_forfeit_date  date,
  p_extra_charges jsonb DEFAULT '[]'::jsonb
)
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
  v_acc_dep        uuid;            -- sổ chứa cọc (sổ thật của phiếu cọc, fallback sổ CỌC)
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

  -- Cọc forfeit = cọc THỰC đã thu (không thể giữ tiền khách chưa đưa).
  v_deposit := LEAST(COALESCE(v_contract.total_deposit, 0), COALESCE(v_contract.deposit_paid, 0));
  v_billing := to_char(COALESCE(p_forfeit_date, CURRENT_DATE), 'YYYY-MM');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_marker  := '[CẤN CỌC BỎ CỌC ' || p_contract_id::text || ']';

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

  -- ── Hoá đơn thanh lý — PENALTY = cọc THỰC bị bỏ ───────────────────────
  IF v_deposit > 0 THEN
    -- Hoá đơn thanh lý (bù cọc) GIỮ tháng forfeit (chính). Hoá đơn thu thêm
    -- sẽ lấy tháng trống kế tiếp (xem dưới) để né unique (contract, billing_month).
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

    -- ── Cặp phiếu chuyển khoản nội bộ CHỜ DUYỆT (cọc → doanh thu) ───────
    v_type_off := public._termination_ensure_type(v_contract.user_id, 'expense', 'Cấn cọc chuyển doanh thu');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu bỏ cọc');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    -- CHI sổ chứa cọc (is_deposit, ngoài KQKD) — cọc rời sổ khi duyệt.
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'EXPENSE', 'Cấn cọc bỏ cọc → chuyển doanh thu — HĐ ' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_dep, p_forfeit_date, v_deposit, 'UNAPPROVED',
            v_marker || ' Cọc khách bỏ rời sổ, chuyển sang doanh thu (chờ duyệt).')
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

  -- ── Thu thêm → HOÁ ĐƠN AR RIÊNG (chờ thu), TÁCH với hoá đơn bù cọc ─────
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
    NULL;
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
    'pending_expense_voucher_id', v_chi_id
  );
END;
$function$;

-- Wrapper authz forfeit (thêm p_extra_charges).
CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit(
  p_contract_id   uuid,
  p_forfeit_date  date,
  p_extra_charges jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  RETURN public.terminate_contract_forfeit_impl(p_contract_id, p_forfeit_date, p_extra_charges);
END $$;

REVOKE ALL     ON FUNCTION public.terminate_contract_forfeit_impl(uuid, date, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.terminate_contract_forfeit(uuid, date, jsonb)      FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.terminate_contract_forfeit(uuid, date, jsonb)      TO authenticated;

NOTIFY pgrst, 'reload schema';
