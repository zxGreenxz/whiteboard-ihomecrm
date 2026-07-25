-- Thanh lý BỎ CỌC (hướng A) — dọn TỒN: duyệt các cặp bút toán còn treo + huỷ
-- hoá đơn thanh lý của cặp đã bị huỷ.
--
-- Đi kèm 20260725010000 (writer từ nay tự duyệt). Migration này chỉ đụng DỮ LIỆU.
--
-- HIỆN TRẠNG đo thật 25/07 (org thật aaaa…0001):
--   • 4 cặp forfeit còn UNAPPROVED — 4,2tr + 5,7tr + 6,0tr + 2,9tr = 18,8tr.
--     Kèm theo là 4 hoá đơn thanh lý treo (3 OVERDUE + 1 APPROVED) dù khách đã
--     mất cọc từ 11/07–24/07. Owner chốt: duyệt hết.
--   • 1 cặp (3,8tr, HĐ HĐT-094321) owner đã tự HUỶ trên app lúc 25/07 02:09.
--     Phiếu bỏ cọc đã huỷ là terminal (guard 'Cancelled forfeit vouchers are
--     terminal') → không khôi phục. Nhưng huỷ phiếu KHÔNG tự huỷ hoá đơn nên
--     INV-2026-00295 vẫn treo OVERDUE 3,8tr. Owner chốt: huỷ hoá đơn cho khớp.
--
-- CÁCH LÀM (bám đúng đường của luồng thanh lý, không đi cửa sau):
--   • Duyệt = đóng dấu NON_CASH/NOT_APPLICABLE/RESOLVED cho cả 2 chân, cấp token
--     per-xid cho từng chân (guard a05 đòi), rồi UPDATE chân doanh thu →
--     APPROVED. Cascade trg_forfeit_settle_on_approve tự duyệt chân đối ứng và
--     tạo payment tất toán hoá đơn — y hệt đường writer đã kiểm trên DEMO.
--   • Huỷ hoá đơn = gọi RPC cancel_invoice_with_credit_v1 (đúng đường app dùng),
--     không UPDATE thẳng status.
--
-- Set-based theo trạng thái tại thời điểm apply (KHÔNG hardcode id phiếu) —
-- owner vẫn đang thao tác trên app nên phải chịu được dữ liệu đổi.
--
-- Migration TỰ KIỂM: sai bất kỳ khẳng định nào là abort toàn bộ.

BEGIN;

DO $fix$
DECLARE
  v_org        uuid := 'aaaa0000-0000-4000-8000-000000000001';
  r            record;
  v_opened     boolean := false;
  v_n          integer := 0;
  v_bal_before numeric;
  v_bal_after  numeric;
  v_left       integer;
  v_bad        integer;
  v_inv        uuid;
  v_inv_user   uuid;
  v_inv_status text;
BEGIN
  -- Số dư MỌI sổ quỹ THẬT trước khi đụng vào (chốt chặn cuối: phải không đổi).
  SELECT COALESCE(sum(l.signed_amount), 0) INTO v_bal_before
  FROM public.income_expense_posting_lines l
  JOIN public.accounts a ON a.id = l.account_id
  WHERE a.organization_id = v_org AND NOT COALESCE(a.is_virtual, false);

  -- Guard a05 đòi capability writer thanh lý cho MỌI thao tác trên phiếu bỏ cọc.
  IF NOT EXISTS (
    SELECT 1 FROM app_private.accounting_chain_writer_xids c
    WHERE c.transaction_id = txid_current() AND c.backend_pid = pg_backend_pid()
  ) THEN
    PERFORM app_private.begin_accounting_chain_write_v1();
    v_opened := true;
  END IF;

  FOR r IN
    SELECT fa.revenue_voucher_id AS rev_id, fa.offset_voucher_id AS off_id,
           rev.user_id AS owner_uid, rev.code AS rev_code, rev.total_amount
    FROM app_private.termination_forfeit_authorizations fa
    JOIN public.income_expenses rev ON rev.id = fa.revenue_voucher_id
    JOIN public.income_expenses off ON off.id = fa.offset_voucher_id
    WHERE rev.approval_status = 'UNAPPROVED' AND rev.deleted_at IS NULL
      AND off.approval_status = 'UNAPPROVED' AND off.deleted_at IS NULL
    ORDER BY rev.voucher_date, rev.code
  LOOP
    -- (1) Đóng dấu bản chất nội bộ — hết lọt vào luồng tiền thật Finance V2.
    UPDATE public.income_expenses
       SET posting_mode   = 'NON_CASH',
           posting_status = 'NOT_APPLICABLE',
           review_state   = 'RESOLVED'
     WHERE id IN (r.rev_id, r.off_id);

    -- (2) Token cho cả hai chân (chân đối ứng do cascade đổi trạng thái).
    INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
    VALUES (r.rev_id, pg_current_xact_id(), 'APPROVED'),
           (r.off_id, pg_current_xact_id(), 'APPROVED');

    -- (3) Duyệt chân doanh thu → cascade duyệt chân đối ứng + tất toán hoá đơn.
    UPDATE public.income_expenses
       SET approval_status = 'APPROVED',
           approved_by     = r.owner_uid,
           approved_at     = now()
     WHERE id = r.rev_id;

    DELETE FROM app_private.ie_transition_authorization
     WHERE income_expense_id IN (r.rev_id, r.off_id)
       AND xid = pg_current_xact_id();

    v_n := v_n + 1;
    RAISE NOTICE 'đã duyệt cặp % (%đ)', r.rev_code, r.total_amount;
  END LOOP;

  IF v_opened THEN
    PERFORM app_private.end_accounting_chain_write_v1();
    v_opened := false;
  END IF;

  -- (4) Huỷ hoá đơn thanh lý của cặp bút toán đã bị huỷ (owner chốt 25/07).
  SELECT i.id, i.user_id, i.status::text INTO v_inv, v_inv_user, v_inv_status
  FROM public.invoices i
  WHERE i.invoice_number = 'INV-2026-00295' AND i.deleted_at IS NULL;

  IF v_inv IS NULL THEN
    RAISE NOTICE 'INV-2026-00295 không còn — bỏ qua';
  ELSIF v_inv_status = 'CANCELLED' THEN
    RAISE NOTICE 'INV-2026-00295 đã huỷ trước đó — bỏ qua';
  ELSE
    -- Chỉ huỷ khi ĐÚNG là hoá đơn của cặp bỏ cọc đã huỷ và chưa thu đồng nào.
    PERFORM 1
    FROM app_private.termination_forfeit_authorizations fa
    JOIN public.income_expenses rev ON rev.id = fa.revenue_voucher_id
    JOIN public.income_expenses off ON off.id = fa.offset_voucher_id
    WHERE fa.invoice_id = v_inv
      AND rev.approval_status = 'CANCELLED'
      AND off.approval_status = 'CANCELLED';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INV-2026-00295: cặp bút toán KHÔNG ở trạng thái đã huỷ — dừng, kiểm tra tay';
    END IF;
    IF EXISTS (SELECT 1 FROM public.payments p WHERE p.invoice_id = v_inv) THEN
      RAISE EXCEPTION 'INV-2026-00295: đã có thanh toán — dừng, không tự huỷ';
    END IF;

    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_inv_user::text, 'role', 'authenticated')::text, true);
    PERFORM public.cancel_invoice_with_credit_v1(v_inv, 'forfeit-cleanup-inv-295');
    PERFORM set_config('request.jwt.claims', NULL, true);
    RAISE NOTICE 'đã huỷ INV-2026-00295';
  END IF;

  -- ================== TỰ KIỂM ==================

  -- A. Không còn cặp bỏ cọc nào treo chờ duyệt.
  SELECT count(*) INTO v_left
  FROM public.income_expenses ie
  WHERE ie.system_source IN ('termination.forfeit_revenue', 'termination.forfeit_offset')
    AND ie.approval_status = 'UNAPPROVED' AND ie.deleted_at IS NULL;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'smoke A FAIL: còn % phiếu bỏ cọc chờ duyệt', v_left;
  END IF;

  -- B. Mọi phiếu bỏ cọc ĐÃ DUYỆT phải là nội bộ và KHÔNG có bút toán tiền.
  SELECT count(*) INTO v_bad
  FROM public.income_expenses ie
  WHERE ie.system_source IN ('termination.forfeit_revenue', 'termination.forfeit_offset')
    AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
    AND (ie.posting_mode IS DISTINCT FROM 'NON_CASH'
         OR ie.posting_status IS DISTINCT FROM 'NOT_APPLICABLE'
         OR ie.active_posting_id_v2 IS NOT NULL
         OR ie.posting_id IS NOT NULL);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'smoke B FAIL: % phiếu bỏ cọc đã duyệt nhưng sai dấu nội bộ/có bút toán', v_bad;
  END IF;

  -- C. Hoá đơn thanh lý của các cặp vừa duyệt phải tất toán hết.
  SELECT count(*) INTO v_bad
  FROM app_private.termination_forfeit_authorizations fa
  JOIN public.income_expenses rev ON rev.id = fa.revenue_voucher_id
  JOIN public.invoices i ON i.id = fa.invoice_id
  WHERE rev.approval_status = 'APPROVED' AND rev.deleted_at IS NULL
    AND (COALESCE(i.paid_amount, 0) <> i.total_amount
         OR COALESCE(i.remaining_amount, i.total_amount) <> 0);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'smoke C FAIL: % hoá đơn thanh lý chưa tất toán sau khi duyệt', v_bad;
  END IF;

  -- D. Số dư MỌI sổ quỹ thật KHÔNG được nhúc nhích (đây là bút toán nội bộ).
  SELECT COALESCE(sum(l.signed_amount), 0) INTO v_bal_after
  FROM public.income_expense_posting_lines l
  JOIN public.accounts a ON a.id = l.account_id
  WHERE a.organization_id = v_org AND NOT COALESCE(a.is_virtual, false);
  IF v_bal_after IS DISTINCT FROM v_bal_before THEN
    RAISE EXCEPTION 'smoke D FAIL: sổ quỹ thật lệch % đ (trước %, sau %)',
      v_bal_after - v_bal_before, v_bal_before, v_bal_after;
  END IF;

  RAISE NOTICE 'DỌN TỒN OK: duyệt % cặp, sổ quỹ thật không đổi (%đ)', v_n, v_bal_after;
END
$fix$;

COMMIT;
