-- ĐỢT E (mở khoá sớm) — PHIẾU THU TỪ HOÁ ĐƠN ĐƯỢC ĐỔI SỔ QUỸ
--
-- Chủ chỉ ra đúng: quyết định #6 ("cho đổi sổ quỹ sau ghi sổ") KHÔNG có ngoại
-- lệ nào cho phiếu thu hoá đơn. Việc chặn INVOICE_COLLECTION_V5 đến từ ghi chú
-- kỹ thuật S2 thời điểm trigger đóng băng còn chặn cột account_id — rào đó đã
-- gỡ ở 20260802130000 (năng lực CASHBOOK_MOVE) mà điều kiện không được nới
-- theo. 128 phiếu thu hoá đơn đang sống (106 org THẬT) bị khoá oan; chủ vừa
-- đụng ca thật: PT2608046, nathan giữ cả hai sổ MBHIEP/TKHIEP vẫn bị chặn.
--
-- Mở khoá kèm ràng buộc đồng bộ: đổi sổ trên phiếu thì đổi CẢ dòng thu của đợt
-- (invoice_payment_tenders.account_id). Cả hai bộ đếm toàn vẹn
-- (count_invalid_payment_reversals_counter_v1 / _in_place_v1) đều so sổ trên
-- phiếu với sổ trên dòng thu — lệch một bên là bộ đếm khác 0 và kẹt
-- assert_accounting_feature_activation_v1. Quan hệ 1 phiếu ↔ 1 dòng thu đã đo
-- trên prod (max = 1); payments không có cột sổ nên không phải đụng.
--
-- Giữ nguyên mọi luật khác của cửa đổi sổ: sổ đi CUSTODIAN (∨ chủ), sổ đến
-- CUSTODIAN∪KNOWER, phải đang POSTED, chặn sổ ảo hai đầu, ba khoá thời gian,
-- ba hậu điều kiện tiền, lý do ≥ 8 ký tự.
--
-- ⚠ KHÔNG bọc BEGIN/COMMIT; kết thúc bằng SELECT xác nhận (án lệ: Management
-- API im lặng không ghi khi lệnh cuối không trả dòng — đã cắn 3 lần).

CREATE OR REPLACE FUNCTION public.move_income_voucher_cashbook_v1(p_voucher uuid, p_new_account uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $function$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_actor uuid := auth.uid();
  v_is_super boolean;
  v_bypass boolean;
  v_membership uuid;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_flow text;
  v_old_acc public.accounts%ROWTYPE;
  v_new_acc public.accounts%ROWTYPE;
  v_to_kind text;
  v_after public.income_expenses%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < 8 THEN
    RAISE EXCEPTION 'Phải ghi lý do đổi sổ quỹ (ít nhất 8 ký tự) để còn đối soát về sau.'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v FROM public.income_expenses
   WHERE id = p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002';
  END IF;

  v_is_super := public.is_super_admin();
  SELECT m.id INTO v_membership FROM public.organization_memberships m
   WHERE m.user_id = v_actor AND m.organization_id = v.organization_id
     AND m.status = 'ACTIVE' LIMIT 1;
  IF v_membership IS NULL AND NOT v_is_super THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
  END IF;

  IF v.type <> 'INCOME' THEN
    RAISE EXCEPTION 'Cửa này chỉ đổi sổ quỹ cho phiếu THU.' USING ERRCODE = 'P0001';
  END IF;
  IF v.approval_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Phiếu đã huỷ — không đổi sổ quỹ được nữa.' USING ERRCODE = 'P0001';
  END IF;
  IF v.account_id IS NULL THEN
    RAISE EXCEPTION 'Phiếu chưa có sổ quỹ — dùng chức năng duyệt để chọn sổ lần đầu.'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_new_account IS NULL OR p_new_account = v.account_id THEN
    RAISE EXCEPTION 'Hãy chọn một sổ quỹ khác sổ hiện tại.' USING ERRCODE = '22023';
  END IF;

  -- Phiếu do luồng NGHIỆP VỤ khác sở hữu: sổ quỹ đi theo nghiệp vụ nguồn.
  -- CANONICAL_INCOME_EXPENSE (phiếu thủ công tạo qua writer canonical) KHÔNG
  -- thuộc nhóm này — nó chính là phiếu mà chức năng này phục vụ.
  SELECT o.flow_kind INTO v_flow
  FROM app_private.income_expense_flow_ownership o
  WHERE o.income_expense_id = p_voucher;
  -- ĐỢT E: quyết định #6 của chủ không có ngoại lệ cho phiếu thu hoá đơn —
  -- INVOICE_COLLECTION_V5 được đổi sổ. Đổi thì phải đổi CẢ dòng thu của đợt
  -- (invoice_payment_tenders.account_id): cả hai bộ đếm toàn vẹn đều so sổ
  -- trên phiếu với sổ trên dòng thu, lệch một bên là kẹt cổng bật tính năng.
  -- Các luồng khác (cặp bỏ cọc, chia lợi nhuận…) vẫn đi theo nghiệp vụ nguồn.
  IF v_flow IS NOT NULL
     AND v_flow NOT IN ('CANONICAL_INCOME_EXPENSE', 'INVOICE_COLLECTION_V5') THEN
    RAISE EXCEPTION 'Phiếu thu này gắn với nghiệp vụ % nên sổ quỹ đi theo nghiệp vụ đó. Muốn đổi sổ thì huỷ khoản thu rồi thu lại vào đúng sổ.',
      v_flow USING ERRCODE = 'P0001';
  END IF;

  -- Phải ĐANG ghi sổ thì mới có gì để chuyển. Không có hai chặn dưới đây thì
  -- phiếu UNPOSTED/NOT_APPLICABLE (điển hình: phiếu nằm trên SỔ ẢO) đi qua cửa
  -- này sẽ SINH TIỀN: nhánh (a) của cầu a85 không chạy vì không có bút toán để
  -- đảo, còn nhánh (b) thấy phiếu APPROVED + sổ mới là sổ thật nên ghi một
  -- POSTING mới ⇒ sổ quỹ thật tăng đúng total_amount mà không đồng nào vào két.
  -- Đo trên prod: 109 phiếu THU đang nằm sổ ảo đủ điều kiện đi cửa này.
  IF COALESCE(v.posting_status, 'UNPOSTED') <> 'POSTED' OR v.active_posting_id_v2 IS NULL THEN
    RAISE EXCEPTION 'Phiếu chưa ghi sổ nên không có bút toán nào để chuyển. Muốn ghi nhận tiền vào sổ quỹ thì lập phiếu thu thật.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_old_acc FROM public.accounts WHERE id = v.account_id;
  IF COALESCE(v_old_acc.is_virtual, false) THEN
    RAISE EXCEPTION 'Phiếu đang ghi trên sổ nội bộ (sổ ảo) — chuyển sang sổ quỹ thật ở đây là ghi nhận tiền mới, không phải đổi sổ. Hãy lập phiếu thu thật.'
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_new_acc FROM public.accounts WHERE id = p_new_account;
  IF v_new_acc.id IS NULL
     OR v_new_acc.organization_id IS DISTINCT FROM v.organization_id
     OR v_new_acc.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Sổ quỹ đích không tồn tại trong tổ chức này.' USING ERRCODE = '22023';
  END IF;
  -- Sổ ẢO không có bút toán tiền mặt: cầu a85 sẽ đảo sổ cũ rồi KHÔNG ghi lại,
  -- phiếu rơi vào trạng thái lửng. Chặn thẳng thay vì để lệch âm thầm.
  IF COALESCE(v_new_acc.is_virtual, false) THEN
    RAISE EXCEPTION 'Không chuyển phiếu đã ghi sổ sang sổ ảo được — chọn một sổ quỹ thật.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Quyền (quyết định #10): rút tiền KHỎI sổ nào thì phải đang GIỮ sổ đó;
  -- sổ nhận chỉ cần GIỮ hoặc BIẾT. Chủ tổ chức / super admin đi thẳng.
  -- Hai lớp, cố ý KHÔNG bọc BEGIN...EXCEPTION quanh assert (bọc sẽ nuốt cả lỗi
  -- hệ thống — deadlock, 25006 — rồi báo nhầm thành "thiếu quyền"):
  --   lớp 1  đọc thẳng possession để có câu tiếng Việt nêu đích danh tên sổ;
  --   lớp 2  assert_cashbook_access_v2 để lớp DENY phủ (thu hồi quyền tường
  --          minh) vẫn có tiếng nói — kind truyền vào là kind mình THỰC SỰ có
  --          nên hàm không bao giờ ném vì lý do "sai kind".
  v_bypass := v_is_super OR app_private.is_org_owner_v1(v.organization_id, v_actor);
  IF NOT v_bypass THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.cashbook_possession_bindings b
      WHERE b.organization_id = v.organization_id
        AND b.cashbook_id = v.account_id
        AND b.membership_id = v_membership
        AND b.valid_to IS NULL
        AND b.possession_kind = 'CUSTODIAN'
    ) THEN
      RAISE EXCEPTION 'Bạn không phải người giữ sổ "%" nên không chuyển tiền ra khỏi sổ đó được.',
        COALESCE(v_old_acc.name, 'không rõ') USING ERRCODE = '42501';
    END IF;
    PERFORM app_private.assert_cashbook_access_v2(
      v.organization_id, v.account_id, 'CUSTODIAN', v_membership);

    SELECT b.possession_kind INTO v_to_kind
    FROM public.cashbook_possession_bindings b
    WHERE b.organization_id = v.organization_id
      AND b.cashbook_id = p_new_account
      AND b.membership_id = v_membership
      AND b.valid_to IS NULL
      AND b.possession_kind IN ('CUSTODIAN', 'KNOWER')
    ORDER BY (b.possession_kind = 'CUSTODIAN') DESC
    LIMIT 1;
    IF v_to_kind IS NULL THEN
      RAISE EXCEPTION 'Sổ quỹ "%" không nằm trong các sổ bạn giữ hoặc biết — nhờ người giữ sổ chia sẻ sổ cho bạn trước.',
        COALESCE(v_new_acc.name, 'không rõ') USING ERRCODE = '42501';
    END IF;
    PERFORM app_private.assert_cashbook_access_v2(
      v.organization_id, p_new_account, v_to_kind, v_membership);
  END IF;

  -- Ba khoá thời gian, xét trên trạng thái HIỆN TẠI (sổ đi). Trigger
  -- income_expenses_check_lock sẽ xét lại cả sổ ĐẾN khi UPDATE chạy.
  PERFORM app_private.assert_period_open_for_edit_v1(p_voucher, 'đổi sổ quỹ');

  -- Năng lực hẹp: qua được trigger đóng băng nhưng KHÔNG tắt cầu a85, để
  -- chính a85 đảo bút toán sổ cũ rồi ghi generation mới ở sổ mới (kèm đủ dòng
  -- MAIN/CHANGE/ROUNDING). Xem migration này phần (2).
  PERFORM app_private.begin_ie_flex_write_v1(p_voucher, 'CASHBOOK_MOVE');

  UPDATE public.income_expenses
     SET account_id = p_new_account,
         updated_at = now()
   WHERE id = p_voucher;

  PERFORM app_private.end_ie_flex_write_v1(p_voucher);

  -- Phiếu của đợt thu hoá đơn: dòng thu (tender) phải trỏ cùng sổ với phiếu.
  -- Quan hệ 1 phiếu ↔ 1 dòng thu đã đo trên prod (max = 1).
  IF v.payment_collection_id IS NOT NULL THEN
    UPDATE public.invoice_payment_tenders t
       SET account_id = p_new_account
     WHERE t.voucher_id = p_voucher;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Phiếu thuộc đợt thu nhưng không tìm thấy dòng thu tương ứng — dừng lại, báo quản trị.'
        USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.invoice_payment_tenders t
      WHERE t.voucher_id = p_voucher AND t.account_id IS DISTINCT FROM p_new_account
    ) THEN
      RAISE EXCEPTION 'Đổi sổ nhưng dòng thu của đợt vẫn trỏ sổ cũ — dừng lại, báo quản trị.'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  SELECT * INTO v_after FROM public.income_expenses WHERE id = p_voucher;

  -- Hậu điều kiện: tiền phải rời hẳn sổ cũ và có mặt đủ ở sổ mới.
  IF COALESCE(v.posting_status, 'UNPOSTED') = 'POSTED'
     AND COALESCE(v_after.posting_status, '') <> 'POSTED' THEN
    RAISE EXCEPTION 'Đổi sổ nhưng phiếu không ghi sổ lại được (trạng thái %) — dừng lại, báo quản trị.',
      COALESCE(v_after.posting_status, 'không rõ') USING ERRCODE = '55000';
  END IF;
  IF COALESCE((
       SELECT sum(l.signed_amount) FROM public.income_expense_posting_lines l
       JOIN public.income_expense_postings p ON p.id = l.posting_id
       WHERE p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = p_voucher
         AND l.account_id = v.account_id), 0) <> 0 THEN
    RAISE EXCEPTION 'Đổi sổ nhưng sổ quỹ cũ vẫn còn số dư của phiếu này — dừng lại, báo quản trị.'
      USING ERRCODE = '55000';
  END IF;
  IF COALESCE((
       SELECT sum(l.signed_amount) FROM public.income_expense_posting_lines l
       JOIN public.income_expense_postings p ON p.id = l.posting_id
       WHERE p.posting_subject_kind = 'VOUCHER' AND p.posting_subject_id = p_voucher
         AND l.account_id = p_new_account), 0) = 0 THEN
    RAISE EXCEPTION 'Đổi sổ nhưng sổ quỹ mới không nhận được khoản nào — dừng lại, báo quản trị.'
      USING ERRCODE = '55000';
  END IF;

  PERFORM app_private.append_income_expense_event_v1(
    v.organization_id, p_voucher, 'CASHBOOK_MOVED', v_actor, NULL,
    COALESCE(v_old_acc.name, v.account_id::text),
    COALESCE(v_new_acc.name, p_new_account::text),
    v_reason);

  RETURN jsonb_build_object(
    'id', p_voucher, 'changed', true,
    'from_account_id', v.account_id, 'from_account_name', v_old_acc.name,
    'to_account_id', p_new_account, 'to_account_name', v_new_acc.name,
    'posting_status', v_after.posting_status);
END
$function$
;

REVOKE ALL ON FUNCTION public.move_income_voucher_cashbook_v1(uuid, uuid, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.move_income_voucher_cashbook_v1(uuid, uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Cửa xác nhận: cả hai cột phải true.
SELECT
  (SELECT pg_get_functiondef(p.oid) LIKE '%INVOICE_COLLECTION_V5%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='move_income_voucher_cashbook_v1')::text AS mo_khoa_v5,
  (SELECT pg_get_functiondef(p.oid) LIKE '%dòng thu của đợt vẫn trỏ sổ cũ%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='move_income_voucher_cashbook_v1')::text AS dong_bo_tender;
