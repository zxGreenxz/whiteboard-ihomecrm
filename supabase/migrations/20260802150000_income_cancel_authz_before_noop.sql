-- ĐỢT A (siết) — KIỂM QUYỀN TRƯỚC NHÁNH "ĐÃ HUỶ RỒI"
--
-- Ma trận quyền chạy trên org TEST (4 người × 8 loại phiếu × 3 hành động = 96
-- ca) phát hiện đúng MỘT ô lệch giữa reader và writer:
--
--   đối tượng "phiếu THU đã huỷ trước đó"
--     reader can_cancel_income_voucher_v1 → CHẶN [ALREADY_CANCELLED]  (mọi người)
--     writer cancel_income_voucher_v1     → CHO PHÉP {changed:false}  (mọi người)
--
-- Nhánh idempotent đứng TRƯỚC luật quyền nên người KHÔNG phải người thu (và
-- không phải chủ tổ chức) gọi thẳng API vẫn nhận HTTP 200. Không đổi dữ liệu và
-- không rò thêm thông tin (họ đã là thành viên tổ chức, thấy phiếu trong danh
-- sách), nhưng mã trả về nói sai về quyền — thứ mà mã nguồn sau này dễ tin nhầm.
--
-- Viết lại NGUYÊN KHỐI thay vì vá replace(): hàm này do chính đợt này tạo
-- (20260802100000), chưa ai chồng bản vá nào lên, nên chép lại toàn bộ là an
-- toàn và đọc được — khác với các hàm cũ buộc phải vá theo neo.
--
-- Sau khi vá:
--   người có quyền   + phiếu đã huỷ → {changed:false}  (vẫn idempotent)
--   người không quyền + phiếu đã huỷ → 42501            (khớp reader)
--
-- ⚠ KHÔNG bọc BEGIN/COMMIT trong file này. Áp qua Management API với
-- BEGIN…COMMIT, hàm KHÔNG đổi dù HTTP 200 và không lỗi gì — đúng án lệ "object
-- biến mất sau khi apply" của repo. Bỏ hai lệnh đó thì ăn ngay. Luôn kiểm lại
-- catalog (pg_get_functiondef) sau khi apply, đừng tin mã trạng thái.

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

  -- Luật #8 (chủ chốt 01/08/2026, áp cho CẢ trang Thu chi lẫn trang Thu tiền):
  -- chỉ chính người đã thu/lập phiếu, chủ tổ chức, hoặc super admin.
  IF NOT v_is_super
     AND NOT app_private.is_org_owner_v1(v.organization_id, v_actor)
     AND v.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Chỉ người đã thu khoản này (hoặc chủ tổ chức) mới huỷ được. Nhờ người thu hoặc chủ tổ chức thực hiện.'
      USING ERRCODE = '42501';
  END IF;

  -- Đã huỷ rồi thì không còn gì để làm. Nhánh này đứng SAU khối quyền: ma trận
  -- quyền 02/08/2026 cho thấy đặt trước sẽ trả HTTP 200 cho người KHÔNG có
  -- quyền, lệch với reader (reader nói ALREADY_CANCELLED cho mọi người, nhưng
  -- mã 200 của writer thì nói sai về quyền).
  IF v.approval_status = 'CANCELLED' THEN
    RETURN jsonb_build_object('id', p_voucher, 'changed', false, 'reason', 'đã huỷ trước đó');
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

NOTIFY pgrst, 'reload schema';
