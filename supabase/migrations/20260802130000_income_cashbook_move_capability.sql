-- ĐỢT C (vá tiếp) — ĐỔI SỔ QUỸ PHẢI QUA ĐƯỢC TRIGGER ĐÓNG BĂNG
--
-- Bắt được khi chạy E2E thật trên prod: tạo phiếu thu qua giao diện rồi đổi sổ
-- quỹ thì nhận
--   55000  canonical income expense <id> is frozen (update rejected)
--
-- Vì sao: writer canonical (create_income_expense_v1) LUÔN ghi một dòng
-- app_private.income_expense_flow_ownership với flow_kind='CANONICAL_INCOME_EXPENSE'.
-- Trigger a00_ie_owned_payload_freeze chặn MỌI phiếu flow-owned khi không có
-- năng lực, và `account_id` KHÔNG nằm trong allowlist cột lifecycle của nó.
-- ⇒ move_income_voucher_cashbook_v1 (20260802120000) chỉ chạy được với phiếu
-- CŨ chưa có dòng sở hữu; mọi phiếu tạo mới từ nay đều hỏng. Bản thử nghiệm
-- trước đó xanh vì chạy trên phiếu cũ của org TEST — bẫy kinh điển.
--
-- Vì sao KHÔNG dùng ie_transition_authorization: purpose FINANCE_V2_LIFECYCLE
-- làm cầu a85 early-return (tắt hẳn), mà toàn bộ nghiệp vụ đổi sổ dựa vào
-- CHÍNH cầu a85 để đảo bút toán ở sổ cũ rồi ghi generation mới ở sổ mới.
-- Chính comment trong thân guard trên prod cũng đã cảnh báo đúng điều này.
--
-- Cách làm: theo đúng khuôn "năng lực ghi phạm vi hẹp" repo đã có sẵn
-- (app_private.ie_flex_writer_xids + begin/end_ie_flex_write_v1, 20260730120000):
-- thêm scope CASHBOOK_MOVE, và cho nó đổi ĐÚNG `account_id` — không cột nào
-- khác. Bảng năng lực đã REVOKE khỏi mọi role client, chỉ writer SECURITY
-- DEFINER mở được, và dòng biến mất theo transaction nếu rollback.
--
-- KHÔNG nới các khoá khác: income_expenses_check_lock và
-- income_expenses_check_profit_lock chỉ miễn trừ scope ANNOTATE, nên sổ đã
-- chốt / tháng đã chia lợi nhuận vẫn chặn đổi sổ như trước.

BEGIN;

-- ── 1. Cho phép scope mới ────────────────────────────────────────────
ALTER TABLE app_private.ie_flex_writer_xids
  DROP CONSTRAINT IF EXISTS ie_flex_writer_xids_scope_chk;

ALTER TABLE app_private.ie_flex_writer_xids
  ADD CONSTRAINT ie_flex_writer_xids_scope_chk
  CHECK (scope IN ('ANNOTATE', 'FLEX_EDIT', 'LINK_CONTRACT', 'SALE_BONUS_DEPOSIT',
                   'CASHBOOK_MOVE'));

-- ── 2. Guard đóng băng: mở đúng một cửa hẹp cho CASHBOOK_MOVE ────────
DO $patch$
DECLARE
  v_def text;
  v_before text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private' AND p.proname = 'guard_income_expense_owned_payload';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ĐỢT C: guard_income_expense_owned_payload không tồn tại';
  END IF;
  IF v_def LIKE '%CASHBOOK_MOVE%' THEN
    RETURN; -- đã vá
  END IF;

  v_before := v_def;
  v_def := replace(v_def,
$old$    if exists (
      select 1 from app_private.ie_flex_writer_xids w
       where w.income_expense_id = old.id
         and w.transaction_id = pg_current_xact_id()
         and w.backend_pid = pg_backend_pid()
         and w.scope = 'ANNOTATE'
    ) then$old$,
$new$    -- ĐỢT C: cửa ĐỔI SỔ QUỸ của phiếu THU (move_income_voucher_cashbook_v1).
    -- Guard chặn account_id vì cột đó không nằm trong allowlist lifecycle —
    -- đúng với mọi writer khác, nhưng hàm kia tồn tại CHÍNH ĐỂ đổi cột đó, và
    -- nó phải để cầu a85 chạy (đảo bút toán sổ cũ + ghi generation mới ở sổ
    -- mới) nên không dùng được token FINANCE_V2_LIFECYCLE. Cho ĐÚNG
    -- account_id + updated_at, không cột nào khác; mọi khoá kỳ vẫn chặn vì
    -- check_lock / profit_lock chỉ miễn trừ scope ANNOTATE.
    if exists (
      select 1 from app_private.ie_flex_writer_xids w
       where w.income_expense_id = old.id
         and w.transaction_id = pg_current_xact_id()
         and w.backend_pid = pg_backend_pid()
         and w.scope = 'CASHBOOK_MOVE'
    ) then
      if (to_jsonb(old) - array['account_id','updated_at'])
         is distinct from
         (to_jsonb(new) - array['account_id','updated_at']) then
        raise exception 'cashbook move scope may only change account_id of %', old.id
          using errcode = '55000';
      end if;
      return new;
    end if;

    if exists (
      select 1 from app_private.ie_flex_writer_xids w
       where w.income_expense_id = old.id
         and w.transaction_id = pg_current_xact_id()
         and w.backend_pid = pg_backend_pid()
         and w.scope = 'ANNOTATE'
    ) then$new$);
  IF v_def = v_before THEN
    RAISE EXCEPTION 'ĐỢT C: mất neo khối ANNOTATE trong guard_income_expense_owned_payload';
  END IF;

  EXECUTE v_def;
END
$patch$;

-- ── 3. Writer đổi sổ: mở/đóng năng lực quanh đúng lệnh UPDATE ────────
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

COMMIT;

NOTIFY pgrst, 'reload schema';
