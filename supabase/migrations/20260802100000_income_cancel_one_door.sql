-- ĐỢT A — HUỶ PHIẾU THU: MỘT CỬA DUY NHẤT, HUỶ Ở ĐÂU CŨNG ĐƯỢC
--
-- Chủ (01/08/2026): "với phiếu thu bỏ hết toàn bộ ràng buộc hủy đi, cho phép
-- hủy ở mọi nơi trong trang thu chi hay thu tiền luôn; ở page thu chi bạn tự
-- link với hóa đơn đi để hóa đơn đánh dấu phiếu thu đó bị hủy như cách làm của
-- page thu tiền. Hủy ở đâu cũng là hủy."
--
-- Bệnh đang có: phiếu thu do luồng hệ thống sinh ra bị TỪ CHỐI ở trang Thu chi
--   * cancel_income_expense_flex_v1 → assert_manual_voucher_v1 → [NOT_MANUAL]
--     (chặn cả `payment_id/invoice_id IS NOT NULL`, tức MỌI phiếu thu hoá đơn)
--   * cancel_income_expense_v1      → 42501 'owned by system flow ...'
--   * ie_compat_cancel_v2           → 42501 flow-owned / 55000 đã ghi sổ
--   * decide_owned_income_expense_v2→ 42501 (chỉ nhận INVOICE_REFUND/TERMINATION_REFUND)
-- ⇒ Người dùng thấy nguyên văn tiếng Anh của DB và không có đường nào đi tiếp.
--
-- ĐO PROD TRƯỚC KHI VIẾT (01/08/2026, read-only):
--   * Phiếu THU phần lớn KHÔNG flow-owned — rẽ nhánh phải theo `system_source`
--     chứ không chỉ `flow_kind`:
--       invoice.payment 1542 · (null) 884 · contract.deposit 574
--       invoice.collection.v5 56 · termination.* 52 · handover.transfer 20 · …
--     Chỉ 136 phiếu THU có dòng flow_ownership (100 CANONICAL + 36 V5).
--   * `recompute_invoice_for_id` tính paid_amount TỪ public.payments
--     (reversed_at IS NULL) — KHÔNG đọc approval_status của phiếu. Muốn hoá đơn
--     mở lại nợ thì BẮT BUỘC phải đụng payments.
--   * `guard_payment_canonical_link` chỉ cho core-writer đổi `reversed_at`
--     ⇒ phải bọc begin/end_accounting_chain_write_v1.
--   * Allowlist của `guard_income_expense_owned_payload` đã có đủ cột lifecycle
--     mà lõi huỷ cần (approval_status/review_state/posting_status/…), nhưng
--     KHÔNG có `account_id` — đó là lý do Đợt C không đổi sổ phiếu flow-owned.
--   * route income_expense.posting.v2 = CANONICAL cho cả 3 org (auto-post sẵn).
--   * org TEST cccc… đang STRICT_MODE ⇒ reverse_v5 rơi nhánh sinh phiếu đối
--     ứng. Quyết định #3 của chủ: phiếu THU bỏ hẳn hai chế độ.
--
-- LÀM GÌ TRONG FILE NÀY
--   1. Vá `reverse_invoice_collection_v5`: bỏ 3 gate quyền (org-level
--      thu_tien.undo, per-tender thu_tien.undo, "sổ được nhìn"), GIỮ đúng luật
--      #8 "chỉ chính người đã thu ∨ chủ tổ chức ∨ super admin"; và ép huỷ tại
--      chỗ (bỏ rẽ nhánh STRICT_MODE).
--   2. Lõi `app_private.cancel_income_voucher_core_v1` — bản sao có chủ đích
--      của phần thi hành trong cancel_income_expense_flex_v1, KHÔNG gate.
--      Cố ý COPY chứ không refactor dùng chung: chủ yêu cầu tách hẳn đường THU
--      khỏi đường CHI ("gộp chung một máy sẽ rất dễ xảy ra xung đột"), và
--      cancel_income_expense_flex_v1 vẫn đang phục vụ phiếu CHI.
--   3. Dispatcher `public.cancel_income_voucher_v1` — CHỈ nhận type='INCOME'.
--   4. Reader `public.can_cancel_income_voucher_v1` để UI gate nút + báo lý do.
--
-- GIỮ NGUYÊN (quyết định #2 và #9 của chủ): ba khoá thời gian
-- [CASHBOOK_CLOSED]/[HANDOVER_LOCKED]/[PROFIT_LOCKED] qua
-- assert_period_open_for_edit_v1, thứ tự LIFO, và chặn credit đã tiêu.
--
-- Mọi lỗi nghiệp vụ dùng ERRCODE P0001: 55000 hiện ra HTTP 500 ở client nên
-- người dùng chỉ thấy "lỗi hệ thống" thay vì câu tiếng Việt.

BEGIN;

-- ── 1. Vá reverse_invoice_collection_v5 ──────────────────────────────
-- Vá bằng replace() trên pg_get_functiondef vì thân thật trên prod đã chồng
-- nhiều lớp vá (20260730250000 collector-only, 20260801001000 WP2…) mà file
-- migration không còn phản ánh. Mất neo là RAISE dừng, không vá mù.
DO $patch$
DECLARE
  v_def text;
  v_before text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reverse_invoice_collection_v5';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ĐỢT A: reverse_invoice_collection_v5 không tồn tại';
  END IF;
  IF v_def LIKE '%ĐỢT A: luật huỷ thống nhất%' THEN
    RETURN; -- đã vá
  END IF;

  -- (a) Gate quyền cấp tổ chức.
  v_before := v_def;
  v_def := replace(v_def,
$old$  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'thu_tien.undo',
    v_invoice.building_id, NULL
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Không có quyền hoàn tác thu tiền' USING ERRCODE = '42501';
  END IF;$old$,
$new$  -- ĐỢT A: luật huỷ thống nhất (quyết định #8 của chủ 01/08/2026) — huỷ
  -- khoản thu KHÔNG còn hỏi quyền 'thu_tien.undo'. Điều kiện duy nhất là
  -- CHÍNH NGƯỜI ĐÃ THU (hoặc chủ tổ chức / super admin), kiểm ở vòng tender
  -- bên dưới. Cùng một luật cho cả trang Thu tiền lẫn trang Thu chi.$new$);
  IF v_def = v_before THEN
    RAISE EXCEPTION 'ĐỢT A: mất neo (a) gate thu_tien.undo cấp tổ chức';
  END IF;

  -- (b) Gate quyền theo từng tender.
  v_before := v_def;
  v_def := replace(v_def,
$old$    SELECT allowed INTO v_authz
    FROM app_private.authorize_tenant_action_v3(
      v_actor, v_collection.organization_id, 'thu_tien.undo',
      v_tender_building, v_tender.account_id
    );
    IF NOT COALESCE(v_authz, false) THEN
      RAISE EXCEPTION 'Không có quyền hoàn tác trên sổ quỹ nguồn' USING ERRCODE = '42501';
    END IF;$old$,
$new$    -- ĐỢT A: bỏ gate quyền theo sổ quỹ nguồn (quyết định #8).$new$);
  IF v_def = v_before THEN
    RAISE EXCEPTION 'ĐỢT A: mất neo (b) gate thu_tien.undo theo tender';
  END IF;

  -- (c) Gate "sổ được nhìn" (WP2_UNDO_VISIBLE_BOOK).
  v_before := v_def;
  v_def := replace(v_def,
$old$    IF NOT v_book_bypass AND NOT EXISTS (
      SELECT 1 FROM app_private.ie_visible_cashbook_ids_v1() visible_book
      WHERE visible_book.cashbook_id = v_tender.account_id
    ) THEN
      SELECT book_row.name INTO v_book_name FROM public.accounts book_row
       WHERE book_row.id = v_tender.account_id;
      RAISE EXCEPTION 'Sổ quỹ "%" không nằm trong các sổ bạn được nhìn — không hoàn tác được khoản thu của sổ này. Hãy nhờ người giữ sổ chia sẻ sổ cho bạn trước.',
        COALESCE(v_book_name, 'không rõ')
        USING ERRCODE = '42501';
    END IF;$old$,
$new$    -- ĐỢT A: bỏ gate "sổ được nhìn" (quyết định #8) — danh tính người thu
    -- đã là điều kiện đủ; không bắt thêm quan hệ với sổ quỹ.$new$);
  IF v_def = v_before THEN
    RAISE EXCEPTION 'ĐỢT A: mất neo (c) gate sổ được nhìn';
  END IF;

  -- (d) Bỏ rẽ nhánh STRICT_MODE — phiếu thu chỉ còn MỘT chế độ (quyết định #3).
  v_before := v_def;
  v_def := replace(v_def,
    'v_in_place := app_private.ie_flex_mode_enabled_v1(v_org);',
    'v_in_place := true;  -- ĐỢT A: phiếu thu luôn huỷ tại chỗ (quyết định #3)');
  IF v_def = v_before THEN
    RAISE EXCEPTION 'ĐỢT A: mất neo (d) rẽ nhánh STRICT_MODE';
  END IF;

  EXECUTE v_def;
END
$patch$;

-- ── 2. Lõi huỷ phiếu thu (không gate) ────────────────────────────────
-- Đảo bút toán + đóng phiếu + ghi dấu vết. Người gọi chịu trách nhiệm kiểm
-- quyền/kỳ TRƯỚC — hàm này REVOKE khỏi mọi role, chỉ dispatcher gọi được.
CREATE OR REPLACE FUNCTION app_private.cancel_income_voucher_core_v1(
  p_voucher    uuid,
  p_reason     text,
  p_actor      uuid,
  p_membership uuid
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE                       -- lấy khoá dòng: PostgREST chạy STABLE trong
SECURITY DEFINER               -- transaction READ ONLY → 25006 (án lệ repo)
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_active public.income_expense_postings%ROWTYPE;
  v_rev uuid;
  v_sum numeric;
  v_kind text;
  v_next_posting text;
BEGIN
  SELECT * INTO v FROM public.income_expenses
   WHERE id = p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;
  IF v.approval_status = 'CANCELLED' THEN
    RETURN jsonb_build_object('id', p_voucher, 'changed', false);
  END IF;

  -- Token: vừa qua trigger đóng băng phiếu flow-owned, vừa TẮT cầu a85 để nó
  -- không đảo chồng lên bút toán mà hàm này sắp tự viết.
  INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
  VALUES (p_voucher, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
  ON CONFLICT (income_expense_id) DO UPDATE
    SET xid = excluded.xid, purpose = excluded.purpose, granted_at = now();

  v_kind := 'CANCELLED_UNPOSTED';
  v_next_posting := CASE WHEN v.posting_mode = 'NON_CASH' THEN 'NOT_APPLICABLE' ELSE 'UNPOSTED' END;

  IF COALESCE(v.posting_status, 'UNPOSTED') = 'POSTED' THEN
    SELECT * INTO v_active FROM public.income_expense_postings p
     WHERE p.id = v.active_posting_id_v2 FOR UPDATE;

    IF v_active.id IS NULL THEN
      RAISE EXCEPTION 'Phiếu ghi nhận đã ghi sổ nhưng không tìm thấy bút toán gốc — báo quản trị trước khi huỷ.'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_active.event_kind <> 'POSTING' THEN
      RAISE EXCEPTION 'Bút toán đang trỏ tới không phải bút toán gốc — báo quản trị.'
        USING ERRCODE = 'P0001';
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
       -v_active.net_cash_effect, public.org_today_v1(NULL),
       COALESCE(p_membership, v_active.posted_by_membership_id), p_actor,
       COALESCE(v.approval_version, 1), 'REVERSAL',
       'inccancel:' || v_active.id::text, 'MANUAL', v_active.posting_generation,
       v_active.id, p_reason)
    RETURNING id INTO v_rev;

    -- Soi gương TỪNG DÒNG: phiếu có tiền thối / làm tròn mang 2-3 dòng nằm ở
    -- các sổ quỹ KHÁC nhau; đảo mỗi dòng chính thì sổ thối vĩnh viễn lệch.
    INSERT INTO public.income_expense_posting_lines
      (organization_id, posting_id, account_id, line_kind, signed_amount)
    SELECT l.organization_id, v_rev, l.account_id, 'REVERSAL', -l.signed_amount
    FROM public.income_expense_posting_lines l
    WHERE l.posting_id = v_active.id;

    SELECT COALESCE(sum(l.signed_amount), 0) INTO v_sum
    FROM public.income_expense_posting_lines l
    JOIN public.income_expense_postings p ON p.id = l.posting_id
    WHERE p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = p_voucher;
    IF v_sum <> 0 THEN
      RAISE EXCEPTION 'Huỷ phiếu nhưng bút toán không triệt tiêu (còn lệch %) — dừng lại', v_sum
        USING ERRCODE = '55000';
    END IF;

    v_kind := 'CANCELLED_AFTER_POSTING';
    v_next_posting := 'REVERSED';
  END IF;

  UPDATE public.income_expenses SET
    approval_status = 'CANCELLED',
    review_state = 'RESOLVED',
    posting_status = v_next_posting,
    cancellation_kind = v_kind,
    active_posting_id_v2 = CASE WHEN v_rev IS NOT NULL THEN NULL ELSE active_posting_id_v2 END,
    reversed_by_posting_id = COALESCE(v_rev, reversed_by_posting_id),
    approval_version = COALESCE(approval_version, 1) + 1,
    posting_version = COALESCE(posting_version, 1) + CASE WHEN v_rev IS NOT NULL THEN 1 ELSE 0 END
  WHERE id = p_voucher;

  DELETE FROM app_private.ie_transition_authorization WHERE income_expense_id = p_voucher;

  INSERT INTO app_private.income_expense_cancellations
    (income_expense_id, organization_id, cancelled_by, cancel_reason, cancellation_kind,
     created_at_snap, approved_at_snap, amount_snap, cashbook_snap)
  VALUES
    (p_voucher, v.organization_id, p_actor, p_reason, v_kind,
     v.created_at, v.approved_at, v.total_amount, v.account_id)
  ON CONFLICT (income_expense_id) DO NOTHING;

  PERFORM app_private.append_income_expense_event_v1(
    v.organization_id, p_voucher, 'CANCELLED', p_actor, NULL,
    v.approval_status, 'CANCELLED', p_reason);

  RETURN jsonb_build_object(
    'id', p_voucher, 'changed', true,
    'cancellation_kind', v_kind,
    'reversal_posting_id', v_rev);
END
$fn$;

REVOKE ALL ON FUNCTION app_private.cancel_income_voucher_core_v1(uuid, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. Dispatcher: cửa DUY NHẤT để huỷ phiếu thu ─────────────────────
CREATE OR REPLACE FUNCTION public.cancel_income_voucher_v1(
  p_voucher uuid,
  p_reason  text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_actor uuid := auth.uid();
  v_is_super boolean;
  v_membership uuid;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_flow text;
  v_coll public.invoice_payment_collections%ROWTYPE;
  v_inv public.invoices%ROWTYPE;
  v_lot public.customer_credit_lots%ROWTYPE;
  v_blocker record;
  v_core jsonb;
  v_paid numeric;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < 8 THEN
    RAISE EXCEPTION 'Phải ghi lý do huỷ (ít nhất 8 ký tự) để còn đối soát về sau.'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v FROM public.income_expenses
   WHERE id = p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;

  -- Kiểm THÀNH VIÊN ngay sau khi tìm thấy phiếu: mọi thông điệp phía dưới (tên
  -- sổ quỹ, mã phiên bàn giao, mã phiếu chặn) đều là thông tin của tổ chức sở
  -- hữu phiếu — người ngoài không được nghe. Đọc thẳng bảng membership, KHÔNG
  -- join qua bảng có RLS (nếu không phép đo rò chéo tổ chức sẽ báo sạch nhầm).
  v_is_super := public.is_super_admin();
  SELECT m.id INTO v_membership FROM public.organization_memberships m
   WHERE m.user_id = v_actor AND m.organization_id = v.organization_id
     AND m.status = 'ACTIVE' LIMIT 1;
  IF v_membership IS NULL AND NOT v_is_super THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
  END IF;

  IF v.type <> 'INCOME' THEN
    RAISE EXCEPTION 'Đây là phiếu CHI — huỷ ở luồng phiếu chi, cửa này chỉ dành cho phiếu thu.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v.approval_status = 'CANCELLED' THEN
    RETURN jsonb_build_object('id', p_voucher, 'changed', false, 'reason', 'đã huỷ trước đó');
  END IF;

  -- Luật #8 (chủ chốt 01/08/2026, áp cho CẢ trang Thu chi lẫn trang Thu tiền):
  -- chỉ chính người đã thu/lập phiếu, chủ tổ chức, hoặc super admin.
  IF NOT v_is_super
     AND NOT app_private.is_org_owner_v1(v.organization_id, v_actor)
     AND v.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Chỉ người đã thu khoản này (hoặc chủ tổ chức) mới huỷ được. Nhờ người thu hoặc chủ tổ chức thực hiện.'
      USING ERRCODE = '42501';
  END IF;

  -- Ba khoá thời gian — GIỮ NGUYÊN theo quyết định #2 của chủ.
  PERFORM app_private.assert_period_open_for_edit_v1(p_voucher, 'huỷ');

  SELECT o.flow_kind INTO v_flow
  FROM app_private.income_expense_flow_ownership o
  WHERE o.income_expense_id = p_voucher;

  -- ══ NHÁNH 1: khoản thu hoá đơn V5 (đi theo cả ĐỢT THU) ═════════════
  -- Bộ đếm toàn vẹn count_invalid_payment_reversals_in_place_v1 định nghĩa
  -- bất biến ở mức COLLECTION (collection phải REVERSED, payment phải trỏ về
  -- đúng collection…). Huỷ lẻ MỘT phiếu của đợt thu nhiều phiếu sẽ làm bộ đếm
  -- khác 0 và kẹt vĩnh viễn assert_accounting_feature_activation_v1.
  -- ⇒ luôn đi qua reverse_invoice_collection_v5 nguyên đợt.
  IF v.payment_collection_id IS NOT NULL OR v_flow = 'INVOICE_COLLECTION_V5' THEN
    SELECT * INTO v_coll FROM public.invoice_payment_collections
     WHERE id = v.payment_collection_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Phiếu thu gắn đợt thu hoá đơn nhưng không tìm thấy đợt thu — báo quản trị.'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_coll.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Đợt thu của phiếu này đã được hoàn tác trước đó.' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_inv FROM public.invoices WHERE id = v_coll.invoice_id;

    -- LIFO — GIỮ theo quyết định #9. reverse_v5 cũng chặn ở trong, nhưng câu
    -- của nó không nói phải huỷ phiếu NÀO trước; ở đây nêu đích danh.
    IF abs(COALESCE(v_inv.paid_amount, 0)
           - (v_coll.expected_paid_amount + v_coll.applied_amount)) >= 0.01 THEN
      SELECT ie.code, ie.voucher_date INTO v_blocker
      FROM public.invoice_payment_collections c2
      JOIN public.invoice_payment_tenders t2 ON t2.collection_id = c2.id
      JOIN public.income_expenses ie ON ie.id = t2.voucher_id
      WHERE c2.invoice_id = v_coll.invoice_id
        AND c2.status = 'ACTIVE'
        AND c2.id <> v_coll.id
      ORDER BY c2.collection_date DESC, c2.created_at DESC, ie.code DESC
      LIMIT 1;

      IF v_blocker.code IS NOT NULL THEN
        RAISE EXCEPTION 'Phải huỷ khoản thu mới hơn trước: phiếu % ngày %. Hệ thống gỡ khoản thu theo thứ tự ngược thời gian để công nợ của hoá đơn không bị lệch.',
          v_blocker.code, to_char(v_blocker.voucher_date, 'DD/MM/YYYY')
          USING ERRCODE = 'P0001';
      END IF;
      RAISE EXCEPTION 'Hoá đơn còn khoản thu mới hơn phải huỷ trước (thứ tự ngược thời gian).'
        USING ERRCODE = 'P0001';
    END IF;

    -- Tiền thừa đã đem cấn sang hoá đơn khác thì máy không tự gỡ được.
    SELECT * INTO v_lot FROM public.customer_credit_lots
     WHERE source_collection_id = v_coll.id;
    IF FOUND AND v_lot.remaining_amount <> v_lot.amount THEN
      RAISE EXCEPTION 'Tiền thừa của lần thu này đã được cấn vào hoá đơn khác — phải gỡ khoản đã cấn trước rồi mới huỷ được.'
        USING ERRCODE = 'P0001';
    END IF;

    -- Ngày hoàn tác: reverse_v5 chặn cả hai đầu (không sớm hơn ngày thu, không
    -- ở tương lai). Kẹp vào khoảng hợp lệ thay vì để nó ném 22023.
    PERFORM public.reverse_invoice_collection_v5(
      v_coll.id,
      GREATEST(LEAST(public.org_today_v1(v.organization_id), CURRENT_DATE),
               v_coll.collection_date),
      v_reason,
      'inccancel-' || replace(p_voucher::text, '-', '') || '-' || substr(md5(v_reason), 1, 8));

    RETURN jsonb_build_object(
      'id', p_voucher, 'changed', true, 'mode', 'COLLECTION',
      'collection_id', v_coll.id);
  END IF;

  -- ══ NHÁNH 2: cặp phiếu bỏ cọc (thu + chi cấn nhau) ═════════════════
  -- Huỷ một chân mà để chân kia sống thì hai sổ lệch nhau vĩnh viễn; hàm
  -- chuyên trách khoá và lật CẢ CẶP theo đúng thứ tự.
  IF v.system_source IN ('termination.forfeit_revenue', 'termination.forfeit_offset')
     OR COALESCE(v.notes, '') LIKE '[CẤN CỌC BỎ CỌC%'
     OR EXISTS (SELECT 1 FROM app_private.termination_forfeit_authorizations f
                 WHERE f.revenue_voucher_id = p_voucher OR f.offset_voucher_id = p_voucher) THEN
    PERFORM public.set_termination_forfeit_status_v1(p_voucher, 'CANCELLED');
    RETURN jsonb_build_object('id', p_voucher, 'changed', true, 'mode', 'FORFEIT_PAIR');
  END IF;

  -- ══ NHÁNH 3: mọi phiếu thu còn lại ═════════════════════════════════
  -- Thủ công, thu cọc hợp đồng, thu hoá đơn LEGACY (system_source
  -- 'invoice.payment' — 1542 phiếu, nhóm lớn nhất), thu thanh lý…
  -- Không còn hỏi luồng nào sở hữu phiếu: "huỷ ở đâu cũng là huỷ".
  IF v.reversal_of_income_expense_id IS NOT NULL THEN
    RAISE EXCEPTION 'Đây là bút toán đối ứng của một phiếu khác — huỷ phiếu gốc chứ không huỷ riêng phiếu này.'
      USING ERRCODE = 'P0001';
  END IF;

  -- begin/end_accounting_chain_write_v1: guard_payment_canonical_link chỉ cho
  -- core-writer đổi payments.reversed_at.
  PERFORM app_private.begin_accounting_chain_write_v1();

  v_core := app_private.cancel_income_voucher_core_v1(p_voucher, v_reason, v_actor, v_membership);

  -- Hoá đơn mở lại nợ (quyết định #4). recompute_invoice_for_id dẫn xuất
  -- paid_amount TỪ payments chứ không đọc trạng thái phiếu, nên phải đánh dấu
  -- khoản thanh toán. Đánh dấu `reversed_at` thay vì xoá — giữ dấu vết, đúng
  -- cách đường thu tiền V5 đang làm (client cũ xoá thẳng payments).
  IF v.payment_id IS NOT NULL THEN
    UPDATE public.payments
       SET reversed_at = COALESCE(reversed_at, clock_timestamp()),
           updated_at = now()
     WHERE id = v.payment_id;
  END IF;

  PERFORM app_private.end_accounting_chain_write_v1();

  -- Trigger trg_payments_recompute_invoice / trg_voucher_recompute_invoice /
  -- trg_ie_recompute_contract_deposit đã tự chạy, nhưng gọi lại tường minh cho
  -- ca phiếu gắn hoá đơn mà KHÔNG có payment (thu cọc ghi thẳng vào hợp đồng).
  IF v.invoice_id IS NOT NULL THEN
    PERFORM public.recompute_invoice_for_id(v.invoice_id);
  END IF;
  IF v.contract_id IS NOT NULL THEN
    PERFORM public.recompute_contract_deposit_paid(v.contract_id);
  END IF;

  RETURN v_core || jsonb_build_object('mode', 'MANUAL');
END
$fn$;

REVOKE ALL ON FUNCTION public.cancel_income_voucher_v1(uuid, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_income_voucher_v1(uuid, text) TO authenticated;

-- ── 4. Reader cho UI: huỷ được không, vì sao không ───────────────────
-- STABLE và KHÔNG lấy khoá dòng: PostgREST chạy hàm non-volatile trong
-- transaction READ ONLY, mọi `FOR SHARE/UPDATE` trong thân sẽ ném 25006 —
-- gọi bằng SQL thì xanh, gọi từ trình duyệt thì hỏng (án lệ đã cắn 5 lần).
CREATE OR REPLACE FUNCTION public.can_cancel_income_voucher_v1(p_ids uuid[])
RETURNS TABLE (
  id uuid,
  eligible boolean,
  mode text,
  reason_code text,
  blocking_voucher_code text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_actor uuid := auth.uid();
  v_is_super boolean := public.is_super_admin();
  v_flow text;
  v_coll public.invoice_payment_collections%ROWTYPE;
  v_inv public.invoices%ROWTYPE;
  v_lot public.customer_credit_lots%ROWTYPE;
  v_id uuid;
  v_code text;
  v_mode text;
  v_block text;
BEGIN
  IF v_actor IS NULL OR p_ids IS NULL THEN RETURN; END IF;

  FOREACH v_id IN ARRAY p_ids LOOP
    id := v_id;
    eligible := false; mode := NULL; reason_code := NULL; blocking_voucher_code := NULL;

    SELECT * INTO v FROM public.income_expenses WHERE income_expenses.id = v_id;
    -- Bỏ qua IM LẶNG phiếu của tổ chức khác: trả về dòng "không đủ điều kiện"
    -- cũng đã là xác nhận phiếu đó tồn tại.
    CONTINUE WHEN NOT FOUND;
    CONTINUE WHEN NOT v_is_super AND NOT EXISTS (
      SELECT 1 FROM public.organization_memberships m
       WHERE m.user_id = v_actor AND m.organization_id = v.organization_id
         AND m.status = 'ACTIVE');

    IF v.deleted_at IS NOT NULL THEN reason_code := 'DELETED';
    ELSIF v.type <> 'INCOME' THEN reason_code := 'NOT_INCOME';
    ELSIF v.approval_status = 'CANCELLED' THEN reason_code := 'ALREADY_CANCELLED';
    ELSIF NOT v_is_super
          AND NOT app_private.is_org_owner_v1(v.organization_id, v_actor)
          AND v.user_id IS DISTINCT FROM v_actor THEN
      reason_code := 'NOT_OWNER';
    ELSE
      v_block := app_private.period_block_code_v1(v_id);
      IF v_block IS NOT NULL THEN
        reason_code := v_block;   -- CASHBOOK_CLOSED / HANDOVER_LOCKED / PROFIT_LOCKED
      ELSE
        SELECT o.flow_kind INTO v_flow FROM app_private.income_expense_flow_ownership o
         WHERE o.income_expense_id = v_id;

        IF v.payment_collection_id IS NOT NULL OR v_flow = 'INVOICE_COLLECTION_V5' THEN
          v_mode := 'COLLECTION';
          SELECT * INTO v_coll FROM public.invoice_payment_collections
           WHERE invoice_payment_collections.id = v.payment_collection_id;
          IF NOT FOUND OR v_coll.status <> 'ACTIVE' THEN
            reason_code := 'ALREADY_CANCELLED';
          ELSE
            SELECT * INTO v_inv FROM public.invoices WHERE invoices.id = v_coll.invoice_id;
            IF abs(COALESCE(v_inv.paid_amount, 0)
                   - (v_coll.expected_paid_amount + v_coll.applied_amount)) >= 0.01 THEN
              reason_code := 'LIFO_ORDER';
              SELECT ie.code INTO v_code
              FROM public.invoice_payment_collections c2
              JOIN public.invoice_payment_tenders t2 ON t2.collection_id = c2.id
              JOIN public.income_expenses ie ON ie.id = t2.voucher_id
              WHERE c2.invoice_id = v_coll.invoice_id AND c2.status = 'ACTIVE'
                AND c2.id <> v_coll.id
              ORDER BY c2.collection_date DESC, c2.created_at DESC, ie.code DESC
              LIMIT 1;
              blocking_voucher_code := v_code;
            ELSE
              SELECT * INTO v_lot FROM public.customer_credit_lots
               WHERE source_collection_id = v_coll.id;
              IF FOUND AND v_lot.remaining_amount <> v_lot.amount THEN
                reason_code := 'CREDIT_SPENT';
              ELSE
                eligible := true;
              END IF;
            END IF;
          END IF;
        ELSIF v.system_source IN ('termination.forfeit_revenue', 'termination.forfeit_offset')
              OR COALESCE(v.notes, '') LIKE '[CẤN CỌC BỎ CỌC%' THEN
          v_mode := 'FORFEIT_PAIR';
          eligible := true;
        ELSIF v.reversal_of_income_expense_id IS NOT NULL THEN
          v_mode := 'MANUAL';
          reason_code := 'IS_REVERSAL';
        ELSE
          v_mode := 'MANUAL';
          eligible := true;
        END IF;
      END IF;
    END IF;

    mode := v_mode;
    v_mode := NULL; v_code := NULL; v_flow := NULL;
    RETURN NEXT;
  END LOOP;
END
$fn$;

REVOKE ALL ON FUNCTION public.can_cancel_income_voucher_v1(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.can_cancel_income_voucher_v1(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.cancel_income_voucher_v1(uuid, text) IS
  'ĐỢT A: cửa DUY NHẤT huỷ phiếu THU (mọi trang). Rẽ nhánh đợt thu V5 / cặp bỏ cọc / thủ công. '
  'Quyền: chính người thu ∨ chủ tổ chức ∨ super admin. Giữ 3 khoá thời gian + LIFO.';

COMMIT;

NOTIFY pgrst, 'reload schema';
