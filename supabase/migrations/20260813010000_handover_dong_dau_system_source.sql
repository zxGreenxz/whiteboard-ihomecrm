-- =============================================================================
-- Bàn giao tiền mặt: đóng dấu system_source ngay lúc SINH phiếu.
--
-- VÌ SAO CẦN
--   Gate check-approver-provenance (§20-10) đòi: từ 23/07/2026, mọi phiếu
--   APPROVED thiếu `approved_by` PHẢI mang nhãn `system_source` thật — vì
--   "APPROVED mà không ai duyệt, cũng không phải bút toán hệ thống" chính là dấu
--   vân tay của writer legacy tự-duyệt mà plan đã chốt phải diệt.
--
--   Luồng bàn giao tiền mặt sinh phiếu KHÔNG có approver theo thiết kế: người
--   giao và người nhận đã xác nhận bằng chính hành vi bàn giao, nên không có
--   bước duyệt thứ ba. Vậy nó PHẢI có nhãn hệ thống. Nó đang không có.
--
-- NGUỒN GỐC LỖ HỔNG (đã truy, không phải suy đoán)
--   Nhãn `handover.transfer` có thật trong repo và đã được dùng cho đúng luồng
--   này — nhưng nó đến từ một cú BACKFILL MỘT LẦN ngày 04/07
--   (20260704110000_income_expenses_system_source.sql dòng 22-23: gán nhãn cho
--   mọi dòng có `handover_transfer_id IS NOT NULL`). Cú đó dán nhãn cho QUÁ KHỨ
--   rồi dừng; writer `confirm_cash_handover` chưa bao giờ được dạy tự dán nhãn,
--   nên mọi phiếu bàn giao sinh SAU 04/07 đều để NULL.
--
--   Đo trên production 13/08/2026: 20 dòng mang nhãn (10/06→01/07, tức đúng
--   phần backfill với tới) và 10 dòng có `handover_transfer_id` mà nhãn NULL.
--   Bốn trong số đó rơi sau cutoff 23/07 và đang làm gate đỏ (BG2608001 ngày
--   07/08, BG2608002 ngày 11/08 — mỗi phiên một cặp CHI/THU cân nhau).
--
--   Bài học đáng ghi: một cú backfill làm sạch số liệu hôm nay nhưng KHÔNG sửa
--   nguồn sinh thì nợ sẽ mọc lại — và mọc im lặng, vì bảng vừa được dọn nên
--   nhìn vào lúc đó thấy sạch.
--
-- LÀM GÌ Ở ĐÂY
--   1. `confirm_cash_handover` đóng dấu `system_source = 'handover.transfer'`
--      lên cả hai phiếu (CHI sổ người giao, THU sổ người nhận) NGAY LÚC INSERT.
--      Thân hàm dưới đây là nguyên văn `pg_get_functiondef` lấy từ production,
--      chỉ thêm một tên cột và một giá trị vào mỗi lệnh INSERT — không đổi bất
--      kỳ nhánh kiểm tra, phép tính, hay thông báo lỗi nào.
--   2. Vá số cũ bằng ĐÚNG luật mà bản 04/07 đã dùng và đã được review:
--      `handover_transfer_id IS NOT NULL` ⇒ `handover.transfer`. Không phải luật
--      mới, không nhặt tay từng dòng theo id.
--
-- KHÔNG LÀM
--   KHÔNG backfill `approved_by`. Plan §4.2 cấm dựng approver giả, và gate cũng
--   sẽ không xanh nhờ cách đó — nó đòi nhãn hệ thống, chứ không đòi có tên ai đó
--   trong ô duyệt. Dán tên người vào phiếu họ chưa từng duyệt là làm hỏng chính
--   thứ mà cột đó dùng để trả lời.
--
--   KHÔNG đụng `create_cash_handover` và `confirm_cancel_handover`: đã đọc
--   `pg_get_functiondef` của cả hai — chúng chỉ UPDATE `handover_id` /
--   `approval_status`, không INSERT phiếu nào, nên không có gì để đóng dấu.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.confirm_cash_handover(p_handover_id uuid, p_to_account_id uuid DEFAULT NULL::uuid)
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
  v_handover_date date;   -- Đợt 6: ngày MỞ đầu tiên chung cho cả hai chân
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

  -- Đợt 6: kỳ đã chốt thì cặp phiếu bàn giao rơi vào ngày MỞ đầu tiên.
  -- MỘT ngày chung cho cả hai chân, nếu không sẽ có cửa sổ "tiền trên đường".
  v_handover_date := GREATEST(
    public.org_today_v1(NULL),
    app_private.cashbook_closed_through_v1(v_h.from_account_id) + 1,
    app_private.cashbook_closed_through_v1(v_to) + 1);
  IF v_handover_date > public.org_today_v1(NULL) + 31 THEN
    RAISE EXCEPTION '[CASHBOOK_CLOSED] Sổ quỹ đã chốt tới % — phiên bàn giao này phải xử lý tay, hệ thống không lập phiếu ở ngày quá xa.',
      v_handover_date - 1 USING ERRCODE = 'P0001';
  END IF;

  -- ── 1 phiếu CHI tổng (sổ người giao) = NET ──
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name,
     system_source)
  VALUES
    (v_h.giver_id, 'EXPENSE',
     'Bàn giao tiền mặt → ' || v_recv || ' — ' || v_h.code,
     v_bld_giver, v_h.from_account_id, v_handover_date,
     v_h.total_amount, 'APPROVED', FALSE,
     '[BÀN GIAO] Nộp tiền sang sổ ' || v_recv || ' (phiên ' || v_h.code || '):' || E'\n' || v_lines,
     v_caller,
     'handover.transfer')
  RETURNING id INTO v_exp;

  -- ── 1 phiếu THU tổng (sổ người nhận) = NET ──
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name,
     system_source)
  VALUES
    (v_h.receiver_id, 'INCOME',
     'Nhận bàn giao tiền mặt ← ' || v_giver || ' — ' || v_h.code,
     v_bld_recv, v_to, v_handover_date,
     v_h.total_amount, 'APPROVED', FALSE,
     '[BÀN GIAO] Nhận tiền từ ' || v_giver || ' (phiên ' || v_h.code || '):' || E'\n' || v_lines,
     v_caller,
     'handover.transfer')
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


-- ── Vá số cũ: cùng một luật với backfill 04/07, không phải luật mới ──────────
--
-- `WHERE system_source IS NULL` giữ cho câu này KHÔNG bao giờ ghi đè một nhãn
-- đã có — nếu sau này có dòng bàn giao được gán nhãn chi tiết hơn thì câu này
-- vẫn để yên. Cũng chính vì thế nó an toàn khi chạy lại.
UPDATE public.income_expenses
   SET system_source = 'handover.transfer'
 WHERE system_source IS NULL
   AND handover_transfer_id IS NOT NULL;

-- Chốt bằng khẳng định thay vì bằng niềm tin: nếu sau khi vá vẫn còn dòng rơi
-- vào đúng bộ lọc của gate thì migration phải NGÃ ngay tại đây, chứ không để
-- CI phát hiện giúp mười phút sau trên một database đã đổi.
DO $kiem_tra$
DECLARE v_con int;
BEGIN
  SELECT count(*) INTO v_con
    FROM public.income_expenses
   WHERE deleted_at IS NULL
     AND approval_status = 'APPROVED'
     AND approved_by IS NULL
     AND created_at >= '2026-07-23'
     AND (
       system_source IS NULL
       OR btrim(system_source) = ''
       OR btrim(system_source) !~ '^[a-z][a-z0-9_]{2,}(\.[a-z0-9_]+)*$'
     );
  IF v_con > 0 THEN
    RAISE EXCEPTION 'Con % phieu APPROVED thieu ca approver lan nhan he thong sau khi va — co nguon sinh khac ngoai ban giao tien mat, phai truy tiep truoc khi coi la xong.', v_con
      USING ERRCODE = 'P0001';
  END IF;
END
$kiem_tra$;
