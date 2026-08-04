-- ĐỢT C — ĐỔI SỔ QUỸ CỦA PHIẾU THU ĐÃ GHI SỔ
--
-- Chủ (01/08/2026): "sau đó cho phép chỉnh sửa sổ quỹ (đổi trong các sổ quỹ mà
-- người đó biết hoặc giữ), hình ảnh chỉ cần ghi lại chi tiết chỉnh sửa là được".
-- Chốt thêm (quyết định #10): sổ ĐI phải đang GIỮ (CUSTODIAN) — rút tiền khỏi
-- sổ người khác đang giữ là đụng vào két của họ; sổ ĐẾN chỉ cần GIỮ hoặc BIẾT.
--
-- TRƯỚC ĐỢT NÀY KHÔNG CÓ ĐƯỜNG NÀO:
--   * ie_compat_update_pending_v2 chỉ cho đụng trục tiền khi phiếu còn Chờ duyệt
--     VÀ chưa ghi sổ.
--   * update_income_expense_quick chặn thẳng: "Phiếu đã ghi sổ — không đổi sổ
--     quỹ ở đây. Hoàn tác rồi lập lại phiếu."
--   * Hộp thoại Sửa nhanh đã GỠ hẳn ô sổ quỹ.
--   * Đường vòng reverse_posted_v2 → post_approved_v2 vào sổ khác thì KHÔNG ghi
--     lại income_expenses.account_id ⇒ header lệch sổ cái vĩnh viễn.
--
-- CÁCH LÀM (đo thân cầu a85 trên prod 01/08/2026 rồi mới chọn):
-- chỉ UPDATE `account_id`, KHÔNG cấp token — để trigger BEFORE UPDATE
-- a85_finance_v2_auto_posting_bridge tự lo bút toán. Nó đã làm sẵn đúng việc:
--   (a) thấy `v_active.account_id IS DISTINCT FROM NEW.account_id` → sinh
--       REVERSAL soi gương TỪNG DÒNG của posting cũ;
--   (b) sinh POSTING generation mới trên sổ mới, kèm đủ dòng MAIN + CHANGE +
--       ROUNDING (nên phiếu có tiền thối vẫn đúng).
-- Cấp token FINANCE_V2_LIFECYCLE sẽ TẮT cầu a85 (early-return) — đúng thứ
-- KHÔNG được làm ở đây.
--
-- Vì không có token nên phiếu FLOW-OWNED không đi cửa này được:
-- `guard_income_expense_owned_payload` chỉ cho đổi các cột lifecycle và
-- `account_id` KHÔNG nằm trong allowlist. Đó là chủ ý — sổ quỹ của phiếu thu
-- hoá đơn đi theo đợt thu, đổi lẻ sẽ làm lệch bộ đếm toàn vẹn của đợt.
--
-- Ba khoá thời gian vẫn nguyên (quyết định #2): assert_period_open_for_edit_v1
-- kiểm trước, và trigger income_expenses_check_lock còn quét cả 6 cặp
-- (OLD/NEW × account/change/rounding) nên không thể "đổi sang sổ chưa khoá để
-- thoát kỳ đã chốt".
--
-- Nhật ký: trigger z99_ie_change_log đã ghi sẵn before/after từng cột (đọc qua
-- get_voucher_change_log_v1), cộng thêm một dòng audit nêu rõ sổ đi → sổ đến.

BEGIN;

CREATE OR REPLACE FUNCTION public.move_income_voucher_cashbook_v1(
  p_voucher     uuid,
  p_new_account uuid,
  p_reason      text
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
  v_bypass boolean;
  v_membership uuid;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_flow text;
  v_old_acc public.accounts%ROWTYPE;
  v_new_acc public.accounts%ROWTYPE;
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

  -- Phiếu do luồng hệ thống sở hữu: sổ quỹ đi theo nghiệp vụ nguồn.
  SELECT o.flow_kind INTO v_flow
  FROM app_private.income_expense_flow_ownership o
  WHERE o.income_expense_id = p_voucher;
  IF v_flow IS NOT NULL AND v_flow <> 'CANONICAL_INCOME_EXPENSE' THEN
    RAISE EXCEPTION 'Phiếu thu này gắn với nghiệp vụ % nên sổ quỹ đi theo nghiệp vụ đó. Muốn đổi sổ thì huỷ khoản thu rồi thu lại vào đúng sổ.',
      v_flow USING ERRCODE = 'P0001';
  END IF;
  IF v.payment_collection_id IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu thu này thuộc một đợt thu hoá đơn — sổ quỹ đi theo đợt thu. Muốn đổi sổ thì huỷ khoản thu rồi thu lại vào đúng sổ.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_old_acc FROM public.accounts WHERE id = v.account_id;
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
  v_bypass := v_is_super OR app_private.is_org_owner_v1(v.organization_id, v_actor);
  IF NOT v_bypass THEN
    BEGIN
      PERFORM app_private.assert_cashbook_access_v2(
        v.organization_id, v.account_id, 'CUSTODIAN', v_membership);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Bạn không phải người giữ sổ "%s" nên không chuyển tiền ra khỏi sổ đó được.',
        COALESCE(v_old_acc.name, 'không rõ') USING ERRCODE = '42501';
    END;

    IF NOT EXISTS (
      SELECT 1 FROM public.cashbook_possession_bindings b
      WHERE b.organization_id = v.organization_id
        AND b.cashbook_id = p_new_account
        AND b.membership_id = v_membership
        AND b.valid_to IS NULL
        AND b.possession_kind IN ('CUSTODIAN', 'KNOWER')
    ) THEN
      RAISE EXCEPTION 'Sổ quỹ "%s" không nằm trong các sổ bạn giữ hoặc biết — nhờ người giữ sổ chia sẻ sổ cho bạn trước.',
        COALESCE(v_new_acc.name, 'không rõ') USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Ba khoá thời gian, xét trên trạng thái HIỆN TẠI (sổ đi). Trigger
  -- income_expenses_check_lock sẽ xét lại cả sổ ĐẾN khi UPDATE chạy.
  PERFORM app_private.assert_period_open_for_edit_v1(p_voucher, 'đổi sổ quỹ');

  -- KHÔNG cấp token: để cầu a85 tự đảo bút toán sổ cũ + ghi bút toán sổ mới.
  UPDATE public.income_expenses
     SET account_id = p_new_account,
         updated_at = now()
   WHERE id = p_voucher;

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
$fn$;

REVOKE ALL ON FUNCTION public.move_income_voucher_cashbook_v1(uuid, uuid, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.move_income_voucher_cashbook_v1(uuid, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.move_income_voucher_cashbook_v1(uuid, uuid, text) IS
  'ĐỢT C: đổi sổ quỹ phiếu THU đã ghi sổ. Sổ đi cần CUSTODIAN, sổ đến CUSTODIAN∪KNOWER. '
  'Bút toán do cầu a85 tự đảo + ghi lại (kể cả dòng tiền thối/làm tròn).';

COMMIT;

NOTIFY pgrst, 'reload schema';
