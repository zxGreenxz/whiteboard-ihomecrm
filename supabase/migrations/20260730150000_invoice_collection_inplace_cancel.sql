-- =====================================================================
-- Đợt 5 — HUỶ TẠI CHỖ PHIẾU THU HOÁ ĐƠN (quyết định #5 của chủ)
--
-- Hôm nay hoàn tác một khoản thu hoá đơn đẻ ra MỘT PHIẾU CHI "Hoàn tác thu
-- tiền" cho MỖI dòng tender, nằm chình ình trong danh sách thu chi, trong khi
-- phiếu thu gốc vẫn hiện "Đã thu". Với quy mô nhỏ đó là rác thuần tuý.
--
-- Sau migration này, khi tổ chức ở chế độ LINH HOẠT và kỳ CÒN MỞ:
--   → lật CHÍNH phiếu thu gốc sang CANCELLED, tự phát sinh bút toán đảo.
--   → KHÔNG sinh phiếu đối ứng nào.
--
-- Khi kỳ ĐÃ ĐÓNG (sổ quỹ đã chốt / đang trong phiên bàn giao / lợi nhuận
-- tháng đã chốt & đã chia cho cổ đông): **CHẶN, nêu đúng lý do và chỉ đường**.
-- Quyết định của chủ 29/07/2026: "không cho hủy, không làm gì hết, chỉ thông
-- báo để biết mà tự tạo tay lại nếu cần". Hệ thống KHÔNG tự ý sinh phiếu đối
-- ứng thay người dùng nữa — một khoản tiền rời khỏi tháng đã chia lợi nhuận
-- phải là quyết định có người ký, không phải tác dụng phụ của một cú bấm.
--
-- Tổ chức ở chế độ CHUẨN KẾ TOÁN giữ nguyên 100% đường cũ (sinh phiếu đối ứng).
--
-- ⚠ BỐN ĐIỂM CHẾT NGƯỜI — đã đo trên prod 29/07/2026, đừng bỏ qua:
--
--  1. `guard_income_expense_owned_items` KHÔNG có cửa token/scope nào cả.
--     Hạng mục của phiếu flow-owned đóng băng TUYỆT ĐỐI. Nên writer này không
--     đụng `income_expense_items`, và do đó `total_amount` cũng bất biến
--     (nó chỉ đổi qua trigger từ items) — vốn cũng không nằm trong allowlist.
--
--  2. `income_expense_flow_ownership` bất biến tuyệt đối
--     (`a00_flow_ownership_immutable` raise 55000 vô điều kiện, kể cả với
--     postgres), và bảng sự kiện của nó có CHECK (event_type='FLOW_CLAIMED').
--     ⇒ Sau khi huỷ, dòng sở hữu vẫn ghi lifecycle_state='APPROVED' vĩnh viễn.
--     Trạng thái huỷ THẬT nằm ở income_expenses + income_expense_cancellations.
--     ĐỪNG viết predicate mới nào dựa vào lifecycle_state.
--
--  3. Token `purpose='FINANCE_V2_LIFECYCLE'` vừa mở được guard đóng băng vừa
--     TẮT cầu a85 (early-return ở đầu thân hàm thật, không nằm trong file
--     migration nào — xem 20260723240000). Không có nấc giữa ⇒ writer PHẢI tự
--     dựng REVERSAL + dòng bút toán, y như cancel_income_expense_flex_v1.
--     Bút toán gốc có thể có NHIỀU DÒNG: đo trên prod, PT2607259 = MAIN
--     2.655.000 ở "Hiệp Thu" + CHANGE 45.000 ở sổ ảo "Hiệp Thối". Soi gương
--     TỪNG DÒNG, không bao giờ dựng lại từ total_amount.
--
--  4. `count_invalid_payment_reversals_v1()` được gọi KHÔNG THAM SỐ trong
--     `assert_accounting_feature_activation_v1` và chặn cứng khi <> 0. Nhánh
--     hiện có của nó đòi phiếu-đối-ứng là EXPENSE/APPROVED và phiếu gốc là
--     INCOME/APPROVED. Huỷ tại chỗ làm phiếu gốc thành CANCELLED ⇒ nếu không
--     tách nhánh trong CÙNG migration này thì 4 công tắc an toàn
--     (invoice.collection.v5, contract.create.v2, customer.credit.apply.v1,
--     shareholder_profit.distribute.v2) KẸT VĨNH VIỄN, không bật/tắt được khi
--     có sự cố.
-- =====================================================================

BEGIN;

-- ── 0. Chốt mốc: hai hàm sắp đụng phải đúng bản đã khảo sát ──────────
-- Cả hai đều được viết lại NGUYÊN KHỐI bên dưới (không vá theo neo), nên nếu
-- prod đã trôi khỏi bản tôi đọc thì dừng lại còn hơn đè mất bản vá của người
-- khác. Chạy lại migration sau khi đã apply thì md5 mới khớp nhánh "đã áp
-- dụng" và bước này tự bỏ qua.
DO $guard$
DECLARE
  v_md5_reverse text;
  v_md5_count   text;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5_reverse
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reverse_invoice_collection_v5';

  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private' AND p.proname = 'count_invalid_payment_reversals_v1';

  IF v_md5_reverse IS NULL OR v_md5_count IS NULL THEN
    RAISE EXCEPTION 'Thiếu reverse_invoice_collection_v5 hoặc count_invalid_payment_reversals_v1 — DỪNG';
  END IF;

  -- Bản gốc đã khảo sát 29/07/2026.
  IF v_md5_reverse <> '78423815266587a2864ace6558a8fd8a'
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app_private'
         AND p.proname = 'count_invalid_payment_reversals_counter_v1'
     ) THEN
    RAISE EXCEPTION
      'reverse_invoice_collection_v5 trên prod đã trôi khỏi bản khảo sát (md5=%) — đọc lại pg_get_functiondef trước khi chạy',
      v_md5_reverse;
  END IF;
END
$guard$;

-- ── 1. Phân loại dấu vết hoàn tác ───────────────────────────────────
-- 8 dòng đang có đều là đường phiếu-đối-ứng nên DEFAULT backfill đúng.
ALTER TABLE app_private.payment_reversals
  ADD COLUMN IF NOT EXISTS reversal_kind text NOT NULL DEFAULT 'COUNTER_VOUCHER';

ALTER TABLE app_private.payment_reversals
  DROP CONSTRAINT IF EXISTS payment_reversals_kind_chk;
ALTER TABLE app_private.payment_reversals
  ADD CONSTRAINT payment_reversals_kind_chk
  CHECK (reversal_kind IN ('COUNTER_VOUCHER', 'IN_PLACE_CANCEL'));

COMMENT ON COLUMN app_private.payment_reversals.reversal_kind IS
  'COUNTER_VOUCHER: reversal_voucher_id trỏ tới phiếu chi đối ứng riêng (đường cũ, chế độ Chuẩn kế toán). '
  'IN_PLACE_CANCEL: trỏ về CHÍNH phiếu thu gốc đã bị huỷ tại chỗ (Đợt 5). '
  'Cột này quyết định count_invalid_payment_reversals_v1 soi dòng đó bằng bộ quy tắc nào.';

-- ── 2. Tách bộ đếm tính toàn vẹn thành hai nhánh ─────────────────────
-- Nhánh cũ được BÊ NGUYÊN từ định nghĩa ĐANG CHẠY (pg_get_functiondef) chứ
-- không chép tay: thân hàm 300 dòng đó chứa vài ngoại lệ hardcode theo
-- payment_id/voucher_id có thật trên prod (di sản dọn dữ liệu cũ). Chép tay là
-- đánh rơi chúng và bộ đếm lập tức khác 0.
DO $split$
DECLARE
  v_def text;
  v_anchor text :=
    '  WHERE (' || chr(10) ||
    '    p_payment_id IS NULL' || chr(10) ||
    '    OR reversal.original_payment_id = p_payment_id' || chr(10) ||
    '  )' || chr(10) ||
    '  AND (' || chr(10);
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app_private'
      AND p.proname = 'count_invalid_payment_reversals_counter_v1'
  ) THEN
    RAISE NOTICE 'count_invalid_payment_reversals_counter_v1 đã có — bỏ qua bước tách';
    RETURN;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private' AND p.proname = 'count_invalid_payment_reversals_v1';

  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'Không khớp mẫu neo WHERE trong count_invalid_payment_reversals_v1 — DỪNG, không vá mù';
  END IF;

  -- (a) đổi tên: chuỗi này chỉ xuất hiện đúng một lần, ở dòng CREATE.
  IF (length(v_def) - length(replace(v_def, 'count_invalid_payment_reversals_v1', ''))) / 34 <> 1 THEN
    RAISE EXCEPTION 'Tên hàm xuất hiện nhiều hơn một lần — đổi tên bằng replace sẽ sai';
  END IF;
  v_def := replace(v_def,
    'count_invalid_payment_reversals_v1',
    'count_invalid_payment_reversals_counter_v1');

  -- (b) giới hạn nhánh cũ đúng vào dòng kiểu phiếu-đối-ứng.
  v_def := replace(v_def, v_anchor,
    '  WHERE (' || chr(10) ||
    '    p_payment_id IS NULL' || chr(10) ||
    '    OR reversal.original_payment_id = p_payment_id' || chr(10) ||
    '  )' || chr(10) ||
    '  AND reversal.reversal_kind = ''COUNTER_VOUCHER''' || chr(10) ||
    '  AND (' || chr(10));

  IF position('reversal_kind = ''COUNTER_VOUCHER''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Vá bộ lọc reversal_kind thất bại';
  END IF;

  EXECUTE v_def;
END
$split$;

REVOKE ALL ON FUNCTION app_private.count_invalid_payment_reversals_counter_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Nhánh MỚI: dòng audit trỏ về chính phiếu thu gốc đã huỷ tại chỗ.
-- Bộ quy tắc là ảnh phản chiếu của nhánh cũ, dịch sang ngữ nghĩa "không có
-- phiếu đối ứng": phiếu phải là chính phiếu thu (INCOME) đã CANCELLED/REVERSED,
-- vẫn neo đúng payment/collection/tender, và bút toán của nó phải triệt tiêu.
CREATE OR REPLACE FUNCTION app_private.count_invalid_payment_reversals_in_place_v1(
  p_payment_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
  SELECT count(*)::integer
  FROM app_private.payment_reversals reversal
  LEFT JOIN public.payments payment
    ON payment.id = reversal.original_payment_id
  LEFT JOIN public.invoices invoice
    ON invoice.id = payment.invoice_id
  LEFT JOIN public.invoice_payment_collections collection
    ON collection.id = payment.collection_id
  LEFT JOIN public.invoice_payment_tenders tender
    ON tender.id = payment.tender_id
  LEFT JOIN public.income_expenses voucher
    ON voucher.id = reversal.reversal_voucher_id
  LEFT JOIN public.accounts account_row
    ON account_row.id = voucher.account_id
  LEFT JOIN LATERAL (
    -- Bút toán của phiếu phải triệt tiêu về 0: đây là hậu điều kiện TIỀN,
    -- thứ duy nhất chứng minh huỷ tại chỗ đã thật sự rút tiền khỏi sổ quỹ.
    SELECT COALESCE(sum(line.signed_amount), 0) AS net,
           count(*) FILTER (WHERE posting.event_kind = 'REVERSAL')::integer AS reversal_count
    FROM public.income_expense_posting_lines line
    JOIN public.income_expense_postings posting ON posting.id = line.posting_id
    WHERE posting.posting_subject_kind = 'VOUCHER'
      AND posting.posting_subject_id = voucher.id
  ) posting_net ON true
  WHERE reversal.reversal_kind = 'IN_PLACE_CANCEL'
    AND (p_payment_id IS NULL OR reversal.original_payment_id = p_payment_id)
    AND (
      -- Danh tính khoản thanh toán
      payment.id IS NULL
      OR payment.invoice_id IS NULL
      OR payment.reversed_at IS NULL
      OR payment.received_amount IS NULL
      OR payment.organization_id IS DISTINCT FROM reversal.organization_id
      OR invoice.id IS NULL
      OR invoice.organization_id IS DISTINCT FROM reversal.organization_id
      -- Huỷ tại chỗ CHỈ tồn tại trên đường collection V5
      OR payment.collection_id IS NULL
      OR collection.id IS NULL
      OR collection.organization_id IS DISTINCT FROM reversal.organization_id
      OR collection.invoice_id IS DISTINCT FROM payment.invoice_id
      OR collection.status IS DISTINCT FROM 'REVERSED'
      OR collection.reversed_at IS NULL
      OR payment.reversed_by_collection_id IS DISTINCT FROM collection.id
      OR tender.id IS NULL
      OR tender.organization_id IS DISTINCT FROM reversal.organization_id
      OR tender.collection_id IS DISTINCT FROM collection.id
      OR tender.payment_id IS DISTINCT FROM payment.id
      -- Dòng audit PHẢI trỏ về CHÍNH phiếu thu gốc, không phải phiếu nào khác
      OR voucher.id IS NULL
      OR tender.voucher_id IS DISTINCT FROM voucher.id
      OR voucher.organization_id IS DISTINCT FROM reversal.organization_id
      OR voucher.type IS DISTINCT FROM 'INCOME'
      OR voucher.deleted_at IS NOT NULL
      OR voucher.payment_id IS DISTINCT FROM payment.id
      OR voucher.payment_collection_id IS DISTINCT FROM collection.id
      OR voucher.invoice_id IS DISTINCT FROM payment.invoice_id
      OR voucher.contract_id IS DISTINCT FROM invoice.contract_id
      OR voucher.building_id IS DISTINCT FROM invoice.building_id
      OR voucher.room_id IS DISTINCT FROM invoice.room_id
      -- Trạng thái sau khi huỷ tại chỗ
      OR voucher.approval_status IS DISTINCT FROM 'CANCELLED'
      OR voucher.posting_status IS DISTINCT FROM 'REVERSED'
      OR voucher.active_posting_id_v2 IS NOT NULL
      OR voucher.reversed_by_posting_id IS NULL
      -- Sổ quỹ
      OR voucher.account_id IS NULL
      OR voucher.account_id IS DISTINCT FROM tender.account_id
      OR account_row.id IS NULL
      OR account_row.organization_id IS DISTINCT FROM reversal.organization_id
      OR account_row.deleted_at IS NOT NULL
      -- Số tiền phiếu phải khớp khoản đã thu
      OR abs(
           voucher.total_amount
           - CASE WHEN payment.received_amount = 0 THEN payment.amount
                  ELSE payment.received_amount END
         ) >= 0.01
      -- KHÔNG được vừa huỷ tại chỗ vừa có phiếu đối ứng còn sống: đảo hai lần
      OR EXISTS (
        SELECT 1 FROM public.income_expenses counter
        WHERE counter.reversal_of_income_expense_id = voucher.id
          AND counter.deleted_at IS NULL
          AND counter.approval_status <> 'CANCELLED'
      )
      -- Hậu điều kiện tiền
      OR posting_net.reversal_count < 1
      OR posting_net.net <> 0
    );
$fn$;

REVOKE ALL ON FUNCTION app_private.count_invalid_payment_reversals_in_place_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Mặt tiền giữ NGUYÊN chữ ký và ngữ nghĩa: assert_accounting_feature_activation_v1
-- gọi nó không tham số và chặn khi <> 0.
CREATE OR REPLACE FUNCTION app_private.count_invalid_payment_reversals_v1(
  p_payment_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
  SELECT app_private.count_invalid_payment_reversals_counter_v1(p_payment_id)
       + app_private.count_invalid_payment_reversals_in_place_v1(p_payment_id);
$fn$;

REVOKE ALL ON FUNCTION app_private.count_invalid_payment_reversals_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. Vì sao KHÔNG huỷ được: mã ổn định cho giao diện ───────────────
-- assert_period_open_for_edit_v1 (Đợt 3) ném thông báo có tiền tố
-- [CASHBOOK_CLOSED] / [HANDOVER_LOCKED] / [PROFIT_LOCKED]. Hàm này biến một
-- phiếu bất kỳ thành MÃ để RPC quyết định đường đi, và để FE hỏi trước khi bày
-- nút. Trả NULL nghĩa là kỳ còn mở.
CREATE OR REPLACE FUNCTION app_private.period_block_code_v1(p_voucher uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE v_msg text;
BEGIN
  PERFORM app_private.assert_period_open_for_edit_v1(p_voucher, 'huỷ');
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  v_msg := SQLERRM;
  RETURN CASE
    WHEN v_msg LIKE '%CASHBOOK_CLOSED%' THEN 'CASHBOOK_CLOSED'
    WHEN v_msg LIKE '%HANDOVER_LOCKED%' THEN 'HANDOVER_LOCKED'
    WHEN v_msg LIKE '%PROFIT_LOCKED%'   THEN 'PROFIT_LOCKED'
    ELSE 'UNKNOWN' END;
END
$fn$;

REVOKE ALL ON FUNCTION app_private.period_block_code_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 4. Huỷ tại chỗ MỘT phiếu thu gốc ────────────────────────────────
-- Tách riêng để reverse_invoice_collection_v5 chỉ phải gọi một dòng cho mỗi
-- tender, và để probe kiểm được từng phiếu.
--
-- KHÔNG kiểm quyền ở đây: hàm chỉ gọi được từ trong reverse_invoice_collection_v5
-- (đã REVOKE khỏi mọi role), nơi đã kiểm thu_tien.undo ở cả cấp toà lẫn cấp sổ.
CREATE OR REPLACE FUNCTION app_private.cancel_collection_voucher_in_place_v1(
  p_voucher uuid,
  p_reason text,
  p_actor uuid,
  p_membership uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_active public.income_expense_postings%ROWTYPE;
  v_rev uuid;
  v_lines integer;
  v_sum numeric;
BEGIN
  SELECT * INTO v FROM public.income_expenses
   WHERE id = p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu thu gốc % không tồn tại', p_voucher USING ERRCODE = 'P0002';
  END IF;
  IF v.approval_status = 'CANCELLED' THEN
    RETURN NULL;   -- đã huỷ ở vòng trước của cùng transaction
  END IF;

  -- Token: vừa qua được trigger đóng băng, vừa TẮT cầu a85 để nó không đảo
  -- chồng lên bút toán mà hàm này sắp tự viết.
  INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  VALUES (p_voucher, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
  ON CONFLICT (income_expense_id) DO UPDATE
    SET xid = excluded.xid, purpose = excluded.purpose, granted_at = now();

  IF COALESCE(v.posting_status, 'UNPOSTED') <> 'POSTED' THEN
    RAISE EXCEPTION
      'Phiếu thu % chưa ghi sổ (posting_status=%) — không huỷ tại chỗ được, báo quản trị.',
      p_voucher, COALESCE(v.posting_status, 'UNPOSTED') USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_active FROM public.income_expense_postings p
   WHERE p.id = v.active_posting_id_v2 FOR UPDATE;
  IF v_active.id IS NULL THEN
    -- Phiếu POSTED mà con trỏ rỗng là ca thật: nhánh BRIDGE_UNRESOLVED_POSTER
    -- của cầu a85 ghi dòng ngoại lệ rồi trả về mà không tạo posting.
    RAISE EXCEPTION
      'Phiếu thu % đã ghi sổ nhưng không tìm thấy bút toán gốc — báo quản trị trước khi huỷ.',
      p_voucher USING ERRCODE = '55000';
  END IF;
  IF v_active.event_kind <> 'POSTING' THEN
    RAISE EXCEPTION 'Bút toán đang trỏ tới không phải bút toán gốc' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.income_expense_postings
    (organization_id, voucher_id, posting_subject_kind, posting_subject_id, direction,
     account_id, gross_amount, voucher_amount_snapshot, amount_basis, net_cash_effect,
     posted_on, posted_by_membership_id, posted_by_user_id, approval_version,
     event_kind, idempotency_key, source_kind, posting_generation, reversal_of_id, reversal_reason)
  VALUES
    (v_active.organization_id, v_active.voucher_id, v_active.posting_subject_kind,
     v_active.posting_subject_id, v_active.direction, v_active.account_id,
     v_active.gross_amount, v_active.voucher_amount_snapshot, v_active.amount_basis,
     -v_active.net_cash_effect, current_date,
     COALESCE(p_membership, v_active.posted_by_membership_id), p_actor,
     COALESCE(v.approval_version, 1), 'REVERSAL',
     'collinplace:' || v_active.id::text, 'MANUAL', v_active.posting_generation,
     v_active.id, p_reason)
  RETURNING id INTO v_rev;

  -- Soi gương TỪNG DÒNG. Phiếu thu có tiền thối mang hai dòng nằm ở HAI SỔ
  -- khác nhau (MAIN ở sổ thu, CHANGE ở sổ ảo "Thối"); dựng lại từ total_amount
  -- sẽ để sổ Thối lệch vĩnh viễn.
  INSERT INTO public.income_expense_posting_lines
    (organization_id, posting_id, account_id, line_kind, signed_amount)
  SELECT l.organization_id, v_rev, l.account_id, 'REVERSAL', -l.signed_amount
  FROM public.income_expense_posting_lines l
  WHERE l.posting_id = v_active.id;

  GET DIAGNOSTICS v_lines = ROW_COUNT;
  IF v_lines = 0 THEN
    RAISE EXCEPTION 'Bút toán gốc của phiếu % không có dòng nào — dừng lại', p_voucher
      USING ERRCODE = '55000';
  END IF;

  -- Hậu điều kiện: mọi bút toán của phiếu này phải triệt tiêu về 0.
  SELECT COALESCE(sum(l.signed_amount), 0) INTO v_sum
  FROM public.income_expense_posting_lines l
  JOIN public.income_expense_postings p ON p.id = l.posting_id
  WHERE p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = p_voucher;
  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'Huỷ phiếu thu % nhưng bút toán không triệt tiêu (còn lệch %) — dừng lại',
      p_voucher, v_sum USING ERRCODE = '55000';
  END IF;

  -- CHỈ các cột nằm trong allowlist của guard đóng băng. Đụng cột ngoài
  -- allowlist là 55000 "authorized transition may only change lifecycle columns".
  UPDATE public.income_expenses SET
    approval_status        = 'CANCELLED',
    review_state           = 'RESOLVED',
    posting_status         = 'REVERSED',
    cancellation_kind      = 'CANCELLED_AFTER_POSTING',
    active_posting_id_v2   = NULL,
    reversed_by_posting_id = v_rev,
    approval_version       = COALESCE(approval_version, 1) + 1,
    posting_version        = COALESCE(posting_version, 1) + 1
  WHERE id = p_voucher;

  DELETE FROM app_private.ie_transition_authorization WHERE income_expense_id = p_voucher;

  INSERT INTO app_private.income_expense_cancellations
    (income_expense_id, organization_id, cancelled_by, cancel_reason, cancellation_kind,
     created_at_snap, approved_at_snap, amount_snap, cashbook_snap)
  VALUES
    (p_voucher, v.organization_id, p_actor, p_reason, 'CANCELLED_AFTER_POSTING',
     v.created_at, v.approved_at, v.total_amount, v.account_id)
  ON CONFLICT (income_expense_id) DO NOTHING;

  PERFORM app_private.append_income_expense_event_v1(
    v.organization_id, p_voucher, 'CANCELLED', p_actor, NULL,
    v.approval_status, 'CANCELLED', p_reason);

  RETURN v_rev;
END
$fn$;

REVOKE ALL ON FUNCTION app_private.cancel_collection_voucher_in_place_v1(uuid, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 5. Hoàn tác thu tiền: rẽ nhánh theo chế độ + trạng thái kỳ ───────
-- Viết lại NGUYÊN KHỐI từ định nghĩa đang chạy (md5 78423815… đã assert ở mục
-- 0). Toàn bộ phần gánh tiền giữ NGUYÊN VĂN: LIFO, guard credit, credit lot,
-- excess_amounts, payments.reversed_at, collection REVERSED,
-- recompute_invoice_for_id, recompute_contract_deposit_paid — vì
-- recompute_invoice_for_id tính paid_amount TỪ public.payments chứ không từ
-- approval_status của phiếu, bỏ bất kỳ cái nào là hoá đơn vẫn hiện "đã thu".
CREATE OR REPLACE FUNCTION public.reverse_invoice_collection_v5(
  p_collection_id uuid,
  p_reversal_date date,
  p_reason text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_collection public.invoice_payment_collections%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_org uuid;
  v_authz boolean;
  v_route text;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_tender public.invoice_payment_tenders%ROWTYPE;
  v_allocation record;
  v_reversal_voucher_id uuid;
  v_reversal_item_id uuid;
  v_expense_type_id uuid;
  v_credit_lot public.customer_credit_lots%ROWTYPE;
  v_response jsonb;
  v_reversal_vouchers jsonb := '[]'::jsonb;
  -- Đợt 5
  v_in_place boolean := false;
  v_membership uuid;
  v_block text;
  v_rev_posting uuid;
  v_mode text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF p_reversal_date IS NULL OR char_length(v_reason) NOT BETWEEN 8 AND 1000 THEN
    RAISE EXCEPTION 'Ngày hoàn tác hoặc lý do 8-1000 ký tự không hợp lệ'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_collection
  FROM public.invoice_payment_collections
  WHERE id = p_collection_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy collection' USING ERRCODE = '42501';
  END IF;
  IF p_reversal_date < v_collection.collection_date THEN
    RAISE EXCEPTION 'Reversal date cannot be earlier than collection date'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = v_collection.invoice_id
  FOR UPDATE;

  SELECT building_row.organization_id INTO v_org
  FROM public.buildings building_row
  JOIN public.organizations organization_row
    ON organization_row.id = building_row.organization_id
   AND organization_row.status = 'ACTIVE'
  WHERE building_row.id = v_invoice.building_id
    AND building_row.deleted_at IS NULL
  FOR SHARE OF building_row, organization_row;
  IF v_org IS NULL
     OR v_invoice.organization_id <> v_org
     OR v_collection.organization_id <> v_org THEN
    RAISE EXCEPTION 'Collection không thuộc tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'thu_tien.undo',
    v_invoice.building_id, NULL
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Không có quyền hoàn tác thu tiền' USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object(
    'collection_id', p_collection_id,
    'reversal_date', p_reversal_date,
    'reason', v_reason
  )::text);

  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id, idempotency_key, payload_hash
  ) VALUES (
    v_org, 'invoice.collection.reverse.v5',
    p_collection_id::text, v_actor, v_key, v_hash
  ) ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
    DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'invoice.collection.reverse.v5'
    AND operation_row.subject_scope = p_collection_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;

  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác' USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  v_route := app_private.evaluate_feature_route('invoice.collection.reverse.v5', v_org);
  IF v_route = 'FROZEN' THEN
    RAISE EXCEPTION 'Writer hoàn tác invoice.collection.v5 đang bị đóng băng'
      USING ERRCODE = '55000';
  ELSIF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Writer hoàn tác invoice.collection.v5 chưa bật'
      USING ERRCODE = '55000';
  END IF;

  IF v_collection.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Collection đã được hoàn tác' USING ERRCODE = '23505';
  END IF;

  -- Allocation is revenue-first then deposit. Reversing an older collection
  -- would leave newer allocation rows attached to the wrong accounting class.
  IF abs(
    COALESCE(v_invoice.paid_amount, 0)
    - (v_collection.expected_paid_amount + v_collection.applied_amount)
  ) >= 0.01 THEN
    RAISE EXCEPTION 'Phải hoàn tác khoản thu mới hơn trước (thứ tự LIFO)'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_credit_lot
  FROM public.customer_credit_lots lot
  WHERE lot.source_collection_id = p_collection_id
  FOR UPDATE;
  IF FOUND AND v_credit_lot.remaining_amount <> v_credit_lot.amount THEN
    RAISE EXCEPTION 'Credit của collection đã được sử dụng; phải unwind trước khi hoàn tác'
      USING ERRCODE = '55000';
  END IF;

  -- ══ ĐỢT 5: chọn đường ═════════════════════════════════════════════
  -- Chế độ linh hoạt → huỷ tại chỗ. Nhưng kỳ đã đóng thì DỪNG HẲN, không
  -- lặng lẽ rơi về đường sinh phiếu đối ứng: một khoản tiền rời khỏi tháng đã
  -- chia lợi nhuận cho cổ đông phải là quyết định có người ký.
  v_in_place := app_private.ie_flex_mode_enabled_v1(v_org);

  IF v_in_place THEN
    SELECT m.id INTO v_membership FROM public.organization_memberships m
     WHERE m.user_id = v_actor AND m.organization_id = v_org AND m.status = 'ACTIVE'
     LIMIT 1;

    FOR v_tender IN
      SELECT * FROM public.invoice_payment_tenders
      WHERE collection_id = p_collection_id
      ORDER BY line_index
    LOOP
      CONTINUE WHEN v_tender.voucher_id IS NULL;
      v_block := app_private.period_block_code_v1(v_tender.voucher_id);
      IF v_block IS NOT NULL THEN
        RAISE EXCEPTION '%',
          CASE v_block
            WHEN 'PROFIT_LOCKED' THEN
              '[PROFIT_LOCKED] Lợi nhuận của tháng chứa khoản thu này đã chốt và đã chia cho cổ đông — hệ thống không tự huỷ khoản thu của tháng đó. Nếu thật sự cần điều chỉnh, hãy liên hệ quản trị để lập phiếu chi đối ứng ở kỳ hiện tại.'
            WHEN 'CASHBOOK_CLOSED' THEN
              '[CASHBOOK_CLOSED] Sổ quỹ chứa khoản thu này đã chốt & bàn giao — kỳ đó khoá vĩnh viễn. Nếu thật sự cần điều chỉnh, hãy liên hệ quản trị để lập phiếu chi đối ứng ở kỳ hiện tại.'
            WHEN 'HANDOVER_LOCKED' THEN
              '[HANDOVER_LOCKED] Phiếu thu này nằm trong một phiên bàn giao đã xác nhận — phải huỷ phiên đó trước (cần cả hai bên đồng ý).'
            ELSE
              '[PERIOD_CLOSED] Kỳ kế toán của khoản thu này đã đóng nên không huỷ được. Nếu thật sự cần điều chỉnh, hãy liên hệ quản trị để lập phiếu chi đối ứng ở kỳ hiện tại.'
          END
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  END IF;

  -- Đường CŨ cần hạng mục "Hoàn tác thu tiền"; đường huỷ tại chỗ thì không,
  -- và cố ý KHÔNG tạo hạng mục rác cho tổ chức chưa từng dùng nó.
  IF NOT v_in_place THEN
    SELECT type_row.id INTO v_expense_type_id
    FROM public.income_expense_types type_row
    WHERE type_row.organization_id = v_collection.organization_id
      AND lower(type_row.type) = 'expense'
      AND lower(btrim(type_row.name)) = 'hoàn tác thu tiền'
    LIMIT 1 FOR SHARE;
    IF v_expense_type_id IS NULL THEN
      INSERT INTO public.income_expense_types (
        organization_id, user_id, name, type, description, is_default, is_deposit
      ) VALUES (
        v_collection.organization_id, v_invoice.user_id,
        'Hoàn tác thu tiền', 'expense',
        'Bút toán đối ứng cho collection đã hoàn tác', false, false
      ) RETURNING id INTO v_expense_type_id;
    END IF;
  END IF;

  PERFORM app_private.begin_accounting_chain_write_v1();

  FOR v_tender IN
    SELECT * FROM public.invoice_payment_tenders
    WHERE collection_id = p_collection_id
    ORDER BY line_index
    FOR UPDATE
  LOOP
    IF v_tender.voucher_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT allowed INTO v_authz
    FROM app_private.authorize_tenant_action_v3(
      v_actor, v_collection.organization_id, 'thu_tien.undo',
      v_invoice.building_id, v_tender.account_id
    );
    IF NOT COALESCE(v_authz, false) THEN
      RAISE EXCEPTION 'Không có quyền hoàn tác trên sổ quỹ nguồn' USING ERRCODE = '42501';
    END IF;

    IF v_in_place THEN
      -- ── HUỶ TẠI CHỖ: không sinh phiếu nào ──────────────────────────
      v_rev_posting := app_private.cancel_collection_voucher_in_place_v1(
        v_tender.voucher_id, v_reason, v_actor, v_membership);
      v_reversal_voucher_id := v_tender.voucher_id;

      v_reversal_vouchers := v_reversal_vouchers || jsonb_build_array(jsonb_build_object(
        'source_voucher_id', v_tender.voucher_id,
        'reversal_voucher_id', NULL,
        'reversal_posting_id', v_rev_posting,
        'mode', 'IN_PLACE_CANCEL',
        'account_id', v_tender.account_id,
        'amount', v_tender.retained_amount
      ));
    ELSE
      -- ── ĐƯỜNG CŨ: sinh phiếu chi đối ứng (chế độ Chuẩn kế toán) ────
      INSERT INTO public.income_expenses (
        user_id, organization_id, type, name, building_id, room_id, contract_id,
        account_id, invoice_id, payment_collection_id, reversal_of_income_expense_id,
        voucher_date, total_amount, approval_status, approved_by, approved_at,
        notes, business_result_accounting, creator_name, system_source,
        idempotency_key, change_amount, change_account_id,
        rounding_amount, rounding_account_id
      ) VALUES (
        v_invoice.user_id, v_collection.organization_id, 'EXPENSE',
        'Hoàn tác thu tiền ' || COALESCE(v_invoice.invoice_number, ''),
        v_invoice.building_id, v_invoice.room_id, v_invoice.contract_id,
        v_tender.account_id, NULL, p_collection_id, v_tender.voucher_id,
        p_reversal_date, v_tender.retained_amount, 'APPROVED', v_actor,
        clock_timestamp(), v_reason, NULL, 'Invoice Collection V5',
        'invoice.collection.reverse.v5', v_key || ':tender:' || v_tender.line_index,
        -v_tender.change_amount, v_tender.change_account_id,
        -v_tender.rounding_amount, v_tender.rounding_account_id
      ) RETURNING id INTO v_reversal_voucher_id;

      FOR v_allocation IN
        SELECT allocation.accounting_class, allocation.amount
        FROM public.invoice_payment_allocations allocation
        WHERE allocation.tender_id = v_tender.id
        ORDER BY allocation.id
      LOOP
        INSERT INTO public.income_expense_items (
          income_expense_id, organization_id, income_expense_type_id, description,
          quantity, unit_price, amount, start_date, end_date, accounting_class
        ) VALUES (
          v_reversal_voucher_id, v_collection.organization_id, v_expense_type_id,
          CASE v_allocation.accounting_class
            WHEN 'PNL' THEN 'Hoàn tác doanh thu hóa đơn'
            WHEN 'DEPOSIT' THEN 'Hoàn tác tiền cọc'
            WHEN 'CUSTOMER_CREDIT' THEN 'Hoàn tác credit khách hàng'
            ELSE 'Hoàn tác khoản ngoài KQKD'
          END,
          1, v_allocation.amount, v_allocation.amount,
          p_reversal_date, p_reversal_date, v_allocation.accounting_class
        ) RETURNING id INTO v_reversal_item_id;
      END LOOP;

      INSERT INTO app_private.income_expense_flow_ownership (
        income_expense_id, organization_id, flow_kind, flow_version,
        lifecycle_owner, lifecycle_state, writer_operation,
        payload_hash_scheme, payload_hash_value, maker_user_id,
        claimed_by_user_id, correlation_id
      ) VALUES (
        v_reversal_voucher_id, v_collection.organization_id,
        'INVOICE_COLLECTION_REVERSAL_V5', 5,
        'INVOICE_COLLECTION_V5', 'APPROVED', 'invoice.collection.reverse.v5',
        'PG_MD5_JSONB_TEXT_V1', v_hash, v_actor, v_actor, p_collection_id
      ) ON CONFLICT (income_expense_id) DO NOTHING;

      v_reversal_vouchers := v_reversal_vouchers || jsonb_build_array(jsonb_build_object(
        'source_voucher_id', v_tender.voucher_id,
        'reversal_voucher_id', v_reversal_voucher_id,
        'mode', 'COUNTER_VOUCHER',
        'account_id', v_tender.account_id,
        'amount', v_tender.retained_amount
      ));
    END IF;

    -- Hai lệnh dưới đây gánh TIỀN THẬT và phải chạy ở CẢ HAI đường:
    -- recompute_invoice_for_id đọc public.payments (reversed_at IS NULL) chứ
    -- không đọc approval_status của phiếu.
    IF v_tender.payment_id IS NOT NULL THEN
      UPDATE public.payments
         SET reversed_at = clock_timestamp(),
             reversed_by_collection_id = p_collection_id,
             updated_at = now()
       WHERE id = v_tender.payment_id;

      INSERT INTO app_private.payment_reversals (
        original_payment_id, reversal_voucher_id, organization_id, actor_id, reason,
        reversal_kind
      ) VALUES (
        v_tender.payment_id, v_reversal_voucher_id,
        v_collection.organization_id, v_actor, v_reason,
        CASE WHEN v_in_place THEN 'IN_PLACE_CANCEL' ELSE 'COUNTER_VOUCHER' END
      ) ON CONFLICT (original_payment_id) DO NOTHING;
    END IF;
  END LOOP;

  IF v_credit_lot.id IS NOT NULL THEN
    UPDATE public.customer_credit_lots
       SET remaining_amount = 0, status = 'REVERSED', reversed_at = clock_timestamp()
     WHERE id = v_credit_lot.id;

    INSERT INTO public.excess_amounts (
      organization_id, user_id, contract_id, amount, description,
      source_invoice_id, source_payment_id, credit_lot_id
    ) VALUES (
      v_collection.organization_id, v_invoice.user_id, v_collection.contract_id,
      -v_credit_lot.amount, 'Hoàn tác credit collection',
      v_invoice.id, v_credit_lot.source_payment_id, v_credit_lot.id
    );
  END IF;

  UPDATE public.invoice_payment_collections
     SET status = 'REVERSED', reversed_at = clock_timestamp(), reversed_by = v_actor,
         reversal_date = p_reversal_date, reversal_reason = v_reason,
         reversal_idempotency_key = v_key
   WHERE id = p_collection_id;

  PERFORM public.recompute_invoice_for_id(v_invoice.id);
  PERFORM public.recompute_contract_deposit_paid(v_invoice.contract_id);

  v_mode := CASE WHEN v_in_place THEN 'IN_PLACE_CANCEL' ELSE 'COUNTER_VOUCHER' END;

  SELECT jsonb_build_object(
    'collection_id', p_collection_id,
    'status', 'REVERSED',
    'reversal_mode', v_mode,
    'reversal_date', p_reversal_date,
    'reversal_vouchers', v_reversal_vouchers,
    'invoice', to_jsonb(invoice_row)
  ) INTO v_response
  FROM public.invoices invoice_row
  WHERE invoice_row.id = v_invoice.id;

  UPDATE app_private.canonical_write_operations
     SET subject_id = p_collection_id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_collection.organization_id
     AND operation = 'invoice.collection.reverse.v5'
     AND subject_scope = p_collection_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;

  PERFORM app_private.end_accounting_chain_write_v1();
  RETURN v_response;
END;
$function$;

-- Giữ nguyên bộ quyền cũ của hàm (CREATE OR REPLACE không đổi ACL, khai lại
-- cho tường minh và để migration chạy được trên môi trường mới).
REVOKE ALL ON FUNCTION public.reverse_invoice_collection_v5(uuid, date, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_invoice_collection_v5(uuid, date, text, text)
  TO authenticated, service_role;

-- ── 6. Giao diện hỏi trước khi bày nút ──────────────────────────────
-- can_flex_cancel_v1 (Đợt 4) trả NOT_MANUAL cho MỌI phiếu thu V5 vì
-- assert_manual_voucher_v1 chặn theo flow_kind + invoice_id + system_source.
-- Luồng hoá đơn cần vị ngữ riêng.
CREATE OR REPLACE FUNCTION public.can_reverse_collection_v1(p_collection_ids uuid[])
RETURNS TABLE(collection_id uuid, mode text, reason_code text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_id uuid;
  v_org uuid;
  v_status text;
  v_block text;
  v_worst text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;

  FOREACH v_id IN ARRAY COALESCE(p_collection_ids, ARRAY[]::uuid[]) LOOP
    SELECT c.organization_id, c.status INTO v_org, v_status
    FROM public.invoice_payment_collections c WHERE c.id = v_id;
    CONTINUE WHEN v_org IS NULL;

    -- Không rò rỉ trạng thái sang tổ chức khác.
    IF NOT public.is_super_admin() AND NOT EXISTS (
      SELECT 1 FROM public.organization_memberships m
       WHERE m.user_id = auth.uid() AND m.organization_id = v_org AND m.status = 'ACTIVE'
    ) THEN CONTINUE; END IF;

    IF v_status <> 'ACTIVE' THEN
      collection_id := v_id; mode := 'BLOCKED'; reason_code := 'ALREADY_REVERSED';
      RETURN NEXT; CONTINUE;
    END IF;

    IF NOT app_private.ie_flex_mode_enabled_v1(v_org) THEN
      collection_id := v_id; mode := 'COUNTER_VOUCHER'; reason_code := NULL;
      RETURN NEXT; CONTINUE;
    END IF;

    -- Một collection nhiều tender: chỉ cần MỘT phiếu kẹt là cả collection kẹt.
    v_worst := NULL;
    FOR v_block IN
      SELECT app_private.period_block_code_v1(t.voucher_id)
      FROM public.invoice_payment_tenders t
      WHERE t.collection_id = v_id AND t.voucher_id IS NOT NULL
    LOOP
      IF v_block IS NOT NULL THEN v_worst := v_block; EXIT; END IF;
    END LOOP;

    collection_id := v_id;
    IF v_worst IS NULL THEN
      mode := 'IN_PLACE_CANCEL'; reason_code := NULL;
    ELSE
      mode := 'BLOCKED'; reason_code := v_worst;
    END IF;
    RETURN NEXT;
  END LOOP;
END
$fn$;

REVOKE ALL ON FUNCTION public.can_reverse_collection_v1(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.can_reverse_collection_v1(uuid[]) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
