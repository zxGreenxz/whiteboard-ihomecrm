-- =====================================================================
-- Bàn giao tiền mặt theo SỐ DƯ RÒNG (net-sweep) — gộp cả phiếu CHI.
--
-- VÌ SAO: Quản lý (Hiển/Hiệp) vừa THU vừa CHI từ chính sổ "…Thu" của mình
-- → tiền mặt thực cầm = số dư ròng = Σthu − Σchi (KHÔNG phải Σ phiếu thu).
-- Mô hình cũ chỉ bó phiếu THU (gross) → bàn giao lớn hơn tiền thật, sổ âm.
--
-- NAY: 1 phiên gộp được CẢ phiếu THU lẫn phiếu CHI chưa bàn giao trong 1 sổ;
--   total_amount(net) = gross(Σthu) − expense(Σchi). Vẫn KHÓA & liệt kê từng
--   phiếu (phòng nào / chi gì) qua cash_handover_items để chủ truy vết rõ.
--
-- BẤT BIẾN giữ nguyên:
--   * Sổ giao về 0 (gốc +Σthu −Σchi, trừ tiếp 1 phiếu CHI = net), sổ nhận +net.
--   * Cặp phiếu chuyển business_result_accounting=FALSE → NGOÀI KQKD (doanh thu
--     & chi phí đã đếm 1 lần ở phiếu gốc).
--   * Gắn handover_transfer_id SAU khi nạp hạng mục (né ie_handover_guard nhánh c).
--   * Hạng mục phiếu chuyển: 1 hạng mục GỘP = net (CHECK unit_price>=0 chặn item
--     âm nên KHÔNG nhồi item chi âm; chi tiết để ở notes + cash_handover_items).
--
-- KÈM: nới guard cho phép quản lý NỘP TIỀN CHO CHỦ (người nhận ∈ super_admins)
-- dù không cùng đội (Joey không ở "Đội thu tiền").
--
-- Tương thích ngược: sổ không có phiếu chi ⇒ net = gross ⇒ y hệt hành vi cũ.
-- Phiên CONFIRMED cũ không đụng; backfill gross_amount cho bản ghi cũ.
-- =====================================================================

BEGIN;

-- ── 1. Bổ sung cột phân loại + tổng gross/expense ─────────────────────
ALTER TABLE public.cash_handover_items
  ADD COLUMN IF NOT EXISTS voucher_type text NOT NULL DEFAULT 'INCOME';
ALTER TABLE public.cash_handover_items
  DROP CONSTRAINT IF EXISTS cash_handover_items_voucher_type_chk;
ALTER TABLE public.cash_handover_items
  ADD CONSTRAINT cash_handover_items_voucher_type_chk
  CHECK (voucher_type IN ('INCOME', 'EXPENSE'));

ALTER TABLE public.cash_handovers
  ADD COLUMN IF NOT EXISTS gross_amount   numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expense_amount numeric(15,2) NOT NULL DEFAULT 0;

-- Backfill: phiên cũ chỉ gồm phiếu thu ⇒ gross = total, expense = 0.
UPDATE public.cash_handovers
   SET gross_amount = total_amount
 WHERE gross_amount = 0 AND total_amount <> 0;

-- Backfill handover_transfer_id cho phiếu chuyển ERA LEGACY (chỉ có
-- transfer_expense_id/transfer_income_id trên phiên, chưa gắn handover_transfer_id
-- trên phiếu) → để bộ lọc "phiếu CHI chuyển" của net-sweep nhận diện ĐỦ mọi era,
-- không cho phiếu "Bàn giao tiền mặt →" cũ lọt vào danh sách quét (trừ trùng).
-- Tắt guard tạm thời (chỉ đổi đúng cột này trên phiếu chuyển lịch sử).
ALTER TABLE public.income_expenses DISABLE TRIGGER trg_ie_handover_guard;
UPDATE public.income_expenses ie
   SET handover_transfer_id = ch.id
  FROM public.cash_handovers ch
 WHERE ie.handover_transfer_id IS NULL
   AND (ch.transfer_expense_id = ie.id OR ch.transfer_income_id = ie.id);
ALTER TABLE public.income_expenses ENABLE TRIGGER trg_ie_handover_guard;

-- ── 2. create_cash_handover: nhận cả THU & CHI, tính net, nới guard ───
CREATE OR REPLACE FUNCTION public.create_cash_handover(
  p_receiver_id uuid, p_voucher_ids uuid[], p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ids         uuid[];
  v_cnt         int;
  v_from_acc    uuid;
  v_acc_owner   uuid;
  v_gross       numeric;
  v_expense     numeric;
  v_net         numeric;
  v_recv_name   text;
  v_recv_active boolean;
  v_giver_name  text;
  v_month       text;
  v_seq         int;
  v_code        text;
  v_id          uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_receiver_id IS NULL OR p_receiver_id = auth.uid() THEN
    RAISE EXCEPTION 'Người nhận không hợp lệ (không thể tự bàn giao cho chính mình)';
  END IF;

  SELECT full_name, is_active INTO v_recv_name, v_recv_active
    FROM profiles WHERE id = p_receiver_id;
  IF NOT FOUND OR v_recv_active IS FALSE THEN
    RAISE EXCEPTION 'Người nhận không tồn tại hoặc đã bị khoá';
  END IF;

  -- Cho bàn giao trong đội HOẶC nộp cho CHỦ (super admin) — quản lý nộp cho chủ
  -- dù không cùng đội.
  IF NOT (public.is_super_admin()
          OR public.same_team(p_receiver_id)
          OR EXISTS (SELECT 1 FROM public.super_admins sa WHERE sa.user_id = p_receiver_id)) THEN
    RAISE EXCEPTION 'Người nhận không cùng đội với bạn';
  END IF;

  v_ids := ARRAY(SELECT DISTINCT unnest(p_voucher_ids));
  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Chưa chọn phiếu nào để bàn giao';
  END IF;

  -- Khoá các phiếu chống race 2 phiên cùng lúc
  PERFORM 1 FROM income_expenses WHERE id = ANY(v_ids) FOR UPDATE;

  -- Hợp lệ: phiếu THU hoặc CHI đã duyệt, chưa bàn giao, có sổ.
  -- Loại phiếu CHI chuyển (handover_transfer_id IS NOT NULL, type=EXPENSE) — đó
  -- là phiếu "Bàn giao tiền mặt →" do confirm sinh ra, KHÔNG được quét lại (sẽ
  -- trừ trùng). Phiếu THU chuyển ("Nhận bàn giao") VẪN cho quét để bàn giao tiếp.
  SELECT count(*) INTO v_cnt
    FROM income_expenses
   WHERE id = ANY(v_ids)
     AND type IN ('INCOME', 'EXPENSE') AND approval_status = 'APPROVED'
     AND deleted_at IS NULL AND handover_id IS NULL AND account_id IS NOT NULL
     AND (handover_transfer_id IS NULL OR type = 'INCOME');
  IF v_cnt <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'Có phiếu không hợp lệ (đã xoá / đã nằm trong phiên bàn giao khác / chưa duyệt)';
  END IF;

  SELECT count(DISTINCT account_id) INTO v_cnt FROM income_expenses WHERE id = ANY(v_ids);
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Các phiếu bàn giao phải cùng MỘT sổ quỹ';
  END IF;

  SELECT account_id,
         COALESCE(sum(total_amount) FILTER (WHERE type = 'INCOME'), 0),
         COALESCE(sum(total_amount) FILTER (WHERE type = 'EXPENSE'), 0)
    INTO v_from_acc, v_gross, v_expense
    FROM income_expenses WHERE id = ANY(v_ids) GROUP BY account_id;
  v_net := v_gross - v_expense;
  IF v_net < 0 THEN
    RAISE EXCEPTION 'Phần đã chi lớn hơn phần đã thu — không thể bàn giao số âm. Thêm phiếu thu hoặc bớt phiếu chi.';
  END IF;

  SELECT user_id INTO v_acc_owner FROM accounts
   WHERE id = v_from_acc AND deleted_at IS NULL;
  IF v_acc_owner IS NULL OR v_acc_owner <> auth.uid() THEN
    RAISE EXCEPTION 'Chỉ bàn giao được phiếu nằm trong sổ quỹ do chính bạn sở hữu';
  END IF;

  SELECT COALESCE(full_name, '') INTO v_giver_name FROM profiles WHERE id = auth.uid();

  -- Mã BG{YYMM}{seq3} — advisory lock chống trùng khi 2 phiên tạo song song
  PERFORM pg_advisory_xact_lock(hashtext('cash_handover_code'));
  v_month := to_char(CURRENT_DATE, 'YYMM');
  SELECT COALESCE(MAX(
           CASE WHEN code ~ ('^BG' || v_month || '\d+$')
                THEN substring(code FROM 7)::int ELSE 0 END
         ), 0) + 1
    INTO v_seq
    FROM cash_handovers WHERE code LIKE 'BG' || v_month || '%';
  v_code := 'BG' || v_month || lpad(v_seq::text, 3, '0');

  INSERT INTO cash_handovers
    (code, giver_id, receiver_id, giver_name, receiver_name, from_account_id,
     total_amount, gross_amount, expense_amount, voucher_count, note)
  VALUES
    (v_code, auth.uid(), p_receiver_id, v_giver_name, v_recv_name, v_from_acc,
     v_net, v_gross, v_expense, array_length(v_ids, 1), NULLIF(btrim(p_note), ''))
  RETURNING id INTO v_id;

  INSERT INTO cash_handover_items
    (handover_id, voucher_id, amount, voucher_code, voucher_date, room_name, building_name, voucher_type)
  SELECT v_id, ie.id, ie.total_amount, ie.code, ie.voucher_date, r.name, b.name, ie.type
    FROM income_expenses ie
    LEFT JOIN rooms r     ON r.id = ie.room_id
    LEFT JOIN buildings b ON b.id = ie.building_id
   WHERE ie.id = ANY(v_ids);

  UPDATE income_expenses SET handover_id = v_id WHERE id = ANY(v_ids);

  RETURN jsonb_build_object(
    'id', v_id, 'code', v_code, 'total_amount', v_net,
    'gross_amount', v_gross, 'expense_amount', v_expense,
    'voucher_count', array_length(v_ids, 1));
END;
$function$;

REVOKE ALL ON FUNCTION public.create_cash_handover(uuid, uuid[], text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_cash_handover(uuid, uuid[], text) TO authenticated;

-- ── 3. confirm_cash_handover: tạo cặp phiếu = NET, ghi chú 2 nhóm thu/chi ─
CREATE OR REPLACE FUNCTION public.confirm_cash_handover(
  p_handover_id uuid, p_to_account_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_h         cash_handovers%ROWTYPE;
  v_to        uuid;
  v_net       numeric;
  v_cnt       int;
  v_type_exp  uuid;
  v_type_inc  uuid;
  v_bld_giver uuid;
  v_bld_recv  uuid;
  v_caller    text;
  v_recv      text;
  v_giver     text;
  v_exp       uuid;
  v_inc       uuid;
  v_lines_in  text;
  v_lines_ex  text;
  v_lines     text;
  v_item_desc text;
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

  -- Re-validate: danh sách phiếu còn nguyên, NET (Σthu − Σchi) khớp snapshot
  SELECT COALESCE(sum(CASE WHEN ie.type = 'INCOME' THEN ie.total_amount
                           ELSE -ie.total_amount END), 0),
         count(*)
    INTO v_net, v_cnt
    FROM cash_handover_items it
    JOIN income_expenses ie ON ie.id = it.voucher_id
   WHERE it.handover_id = p_handover_id
     AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
     AND ie.handover_id = p_handover_id
     AND ie.account_id = v_h.from_account_id;
  IF v_cnt <> v_h.voucher_count OR v_net <> v_h.total_amount THEN
    RAISE EXCEPTION 'Danh sách phiếu của phiên % đã thay đổi — hãy hủy phiên và tạo lại', v_h.code;
  END IF;

  -- Loại thu/chi "bàn giao" (ngoài KQKD) + tòa ảo Chung
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

  -- ── Nhóm THU: phòng · tòa · tiền · kỳ · HĐ ──
  SELECT string_agg(
           '• ' || COALESCE(NULLIF(btrim(it.room_name), ''), '?')
                || ' · ' || COALESCE(NULLIF(btrim(it.building_name), ''), '?')
                || ' · ' || replace(to_char(it.amount::bigint, 'FM999,999,999'), ',', '.') || 'đ'
                || COALESCE(' · kỳ ' || to_char(to_date(inv.billing_month, 'YYYY-MM'), 'MM/YYYY'), '')
                || COALESCE(' · HĐ ' || NULLIF(btrim(inv.invoice_number), ''), ''),
           E'\n' ORDER BY it.building_name, it.room_name)
    INTO v_lines_in
    FROM cash_handover_items it
    LEFT JOIN income_expenses ie ON ie.id = it.voucher_id
    LEFT JOIN invoices inv ON inv.id = ie.invoice_id
   WHERE it.handover_id = p_handover_id AND it.voucher_type = 'INCOME';

  -- ── Nhóm CHI: tên khoản · tiền ──
  SELECT string_agg(
           '• ' || COALESCE(NULLIF(btrim(ie.name), ''), 'Khoản chi')
                || ' · ' || replace(to_char(it.amount::bigint, 'FM999,999,999'), ',', '.') || 'đ',
           E'\n' ORDER BY it.amount DESC)
    INTO v_lines_ex
    FROM cash_handover_items it
    LEFT JOIN income_expenses ie ON ie.id = it.voucher_id
   WHERE it.handover_id = p_handover_id AND it.voucher_type = 'EXPENSE';

  v_lines := 'Đã thu (' || replace(to_char(v_h.gross_amount::bigint, 'FM999,999,999'), ',', '.') || 'đ):'
             || E'\n' || COALESCE(v_lines_in, '—')
             || CASE WHEN v_h.expense_amount > 0
                  THEN E'\n' || 'Đã chi (' || replace(to_char(v_h.expense_amount::bigint, 'FM999,999,999'), ',', '.') || 'đ):'
                       || E'\n' || COALESCE(v_lines_ex, '—')
                  ELSE '' END;

  v_item_desc := 'Bàn giao số dư: thu '
                 || replace(to_char(v_h.gross_amount::bigint, 'FM999,999,999'), ',', '.') || 'đ'
                 || CASE WHEN v_h.expense_amount > 0
                      THEN ' − chi ' || replace(to_char(v_h.expense_amount::bigint, 'FM999,999,999'), ',', '.') || 'đ'
                      ELSE '' END;

  -- ── 1 phiếu CHI tổng (sổ người giao) = NET ──
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name)
  VALUES
    (v_h.giver_id, 'EXPENSE',
     'Bàn giao tiền mặt → ' || v_recv || ' — ' || v_h.code,
     v_bld_giver, v_h.from_account_id, CURRENT_DATE,
     v_h.total_amount, 'APPROVED', FALSE,
     '[BÀN GIAO] Nộp tiền sang sổ ' || v_recv || ' (phiên ' || v_h.code || '):' || E'\n' || v_lines,
     v_caller)
  RETURNING id INTO v_exp;

  -- ── 1 phiếu THU tổng (sổ người nhận) = NET ──
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name)
  VALUES
    (v_h.receiver_id, 'INCOME',
     'Nhận bàn giao tiền mặt ← ' || v_giver || ' — ' || v_h.code,
     v_bld_recv, v_to, CURRENT_DATE,
     v_h.total_amount, 'APPROVED', FALSE,
     '[BÀN GIAO] Nhận tiền từ ' || v_giver || ' (phiên ' || v_h.code || '):' || E'\n' || v_lines,
     v_caller)
  RETURNING id INTO v_inc;

  -- ── 1 hạng mục GỘP = net trên mỗi phiếu (auto_recalc giữ total = net) ──
  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES (v_exp, v_type_exp, v_item_desc, 1, v_h.total_amount, NULL, NULL);
  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES (v_inc, v_type_inc, v_item_desc, 1, v_h.total_amount, NULL, NULL);

  -- Khoá cặp phiếu chuyển bằng handover_transfer_id (SAU khi nạp hạng mục)
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
$function$;

REVOKE ALL ON FUNCTION public.confirm_cash_handover(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.confirm_cash_handover(uuid, uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
