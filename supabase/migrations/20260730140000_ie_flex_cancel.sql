-- =====================================================================
-- Đợt 4 — HUỶ PHIẾU MỘT NHÁT, KHÔNG SINH PHIẾU ĐỐI ỨNG
--
-- Đúng yêu cầu của chủ: "khi hủy phiếu không cần tạo đối ứng sẽ làm rối giao
-- diện thu chi với quy mô nhỏ, cho hủy trực tiếp như cũ trừ thẳng khỏi sổ quỹ,
-- đổi lại kiểm soát bằng ghi chú rõ trong phiếu đã hủy thời điểm tạo, duyệt và
-- hủy phiếu, lý do hủy để đối soát lại khi cần."
--
-- Hiệu ứng sổ cái GIỐNG HỆT đường hai bước hiện tại (hoàn tác rồi huỷ), nhưng
-- gộp vào một transaction và BẮT BUỘC có lý do.
--
-- ⚠ ĐIỂM CHẾT NGƯỜI — vì sao writer TỰ phát sinh bút toán đảo:
--   Thân hàm ĐANG CHẠY của cầu a85 (không nằm trong bất kỳ file migration nào,
--   xem 20260723240000) mở đầu bằng một early-return: hễ transaction có token
--   `FINANCE_V2_LIFECYCLE` cho phiếu này thì cầu TỰ TẮT. Mà token đó lại BẮT
--   BUỘC phải có để qua được trigger đóng băng trên phiếu canonical.
--   ⇒ Không có nấc giữa: viết theo nếp nhà thì cầu tắt và TIỀN KHÔNG NHÚC
--     NHÍCH trong im lặng; không có token thì 55000. Nên hàm này tự dựng
--     REVERSAL + dòng bút toán, y như reverse_posted_income_expense_v2, và tự
--     kiểm hậu điều kiện tổng bằng 0.
-- =====================================================================

BEGIN;

-- ── 1. Dấu vết huỷ (bảng riêng, KHÔNG thêm cột vào income_expenses) ──
-- Thêm cột vào phiếu sẽ buộc phải nới allowlist của trigger đóng băng thêm một
-- lần nữa, mà bản snapshot của guard trong scripts/authz-prepared ĐÃ LẠC HẬU
-- và tự nhận là "an toàn chạy lại" — chạy lại nó sẽ làm hỏng mọi writer V2.
CREATE TABLE IF NOT EXISTS app_private.income_expense_cancellations (
  income_expense_id  uuid PRIMARY KEY REFERENCES public.income_expenses(id) ON DELETE CASCADE,
  organization_id    uuid NOT NULL,
  cancelled_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_by       uuid,
  cancel_reason      text NOT NULL,
  cancellation_kind  text NOT NULL,
  created_at_snap    timestamptz,
  approved_at_snap   timestamptz,
  amount_snap        numeric(15,2),
  cashbook_snap      uuid
);

REVOKE ALL ON app_private.income_expense_cancellations
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.guard_ie_cancellations_append_only()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'income_expense_cancellations là append-only (thao tác %)', TG_OP
    USING ERRCODE = '55000';
END
$fn$;

DROP TRIGGER IF EXISTS a00_ie_cancellations_append_only ON app_private.income_expense_cancellations;
CREATE TRIGGER a00_ie_cancellations_append_only
  BEFORE UPDATE OR DELETE ON app_private.income_expense_cancellations
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_ie_cancellations_append_only();

-- ── 2. Phiếu nào ĐƯỢC huỷ linh hoạt ─────────────────────────────────
-- Danh sách CHO PHÉP (không phải danh sách cấm): phiếu thủ công thuần. Mọi
-- phiếu gắn với một luồng khác đều phải huỷ ở đúng luồng đó, nếu không sẽ có
-- trigger bên kia âm thầm làm việc khác — ví dụ a70_salary_paid_accrual cộng
-- lương lần hai khi phiếu có salary_staff_id bị đụng.
CREATE OR REPLACE FUNCTION app_private.assert_manual_voucher_v1(p_voucher uuid, p_action text DEFAULT 'huỷ')
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_flow text;
BEGIN
  SELECT * INTO v FROM public.income_expenses WHERE id = p_voucher;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002'; END IF;

  SELECT o.flow_kind INTO v_flow
  FROM app_private.income_expense_flow_ownership o WHERE o.income_expense_id = p_voucher;

  -- Đọc flow_kind TRỰC TIẾP: assert_income_expense_flow_owner_v2 trả về im
  -- lặng khi KHÔNG có dòng sở hữu, nên nó không phải là hàng rào.
  IF v_flow IS NOT NULL AND v_flow <> 'CANONICAL_INCOME_EXPENSE' THEN
    RAISE EXCEPTION '[NOT_MANUAL] Phiếu thuộc luồng % — phải % ở đúng màn hình nguồn.', v_flow, p_action
      USING ERRCODE = '42501';
  END IF;

  IF v.payment_id IS NOT NULL OR v.payment_collection_id IS NOT NULL OR v.invoice_id IS NOT NULL THEN
    RAISE EXCEPTION '[NOT_MANUAL] Phiếu gắn với hoá đơn/thanh toán — dùng chức năng hoàn tác thu tiền.'
      USING ERRCODE = '42501';
  END IF;
  IF v.salary_staff_id IS NOT NULL THEN
    RAISE EXCEPTION '[NOT_MANUAL] Phiếu gắn lương nhân sự — sửa ở màn hình lương, nếu không hệ thống sẽ cộng lương lần nữa.'
      USING ERRCODE = '42501';
  END IF;
  IF v.shareholder_id IS NOT NULL OR v.profit_manager_id IS NOT NULL THEN
    RAISE EXCEPTION '[NOT_MANUAL] Phiếu chia lợi nhuận — xử lý ở màn hình phân bổ lợi nhuận.'
      USING ERRCODE = '42501';
  END IF;
  IF v.reversal_of_income_expense_id IS NOT NULL THEN
    RAISE EXCEPTION '[NOT_MANUAL] Đây là bút toán đối ứng — không huỷ riêng.' USING ERRCODE = '42501';
  END IF;
  IF v.handover_id IS NOT NULL THEN
    RAISE EXCEPTION '[HANDOVER_LOCKED] Phiếu nằm trong phiên bàn giao — huỷ phiên trước.' USING ERRCODE = '42501';
  END IF;
  IF v.system_source IS NOT NULL THEN
    RAISE EXCEPTION '[NOT_MANUAL] Phiếu do hệ thống sinh (%) — xử lý ở luồng nguồn.', v.system_source
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profit_payout_reservations r WHERE r.payout_voucher_id = p_voucher) THEN
    RAISE EXCEPTION '[NOT_MANUAL] Phiếu đang giữ chỗ chi trả lợi nhuận.' USING ERRCODE = '42501';
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION app_private.assert_manual_voucher_v1(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. Huỷ linh hoạt ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_income_expense_flex_v1(
  p_voucher uuid,
  p_reason text,
  p_expected_approval_version bigint DEFAULT NULL,
  p_expected_posting_version bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v public.income_expenses%ROWTYPE;
  v_actor uuid := auth.uid();
  v_membership uuid;
  v_is_super boolean;
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_active public.income_expense_postings%ROWTYPE;
  v_rev uuid;
  v_sum numeric;
  v_kind text;
  v_next_posting text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  IF char_length(v_reason) < 8 THEN
    RAISE EXCEPTION 'Phải ghi lý do huỷ (ít nhất 8 ký tự) để còn đối soát về sau.'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v FROM public.income_expenses WHERE id = p_voucher AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phiếu không tồn tại' USING ERRCODE = 'P0002'; END IF;

  IF v.approval_status = 'CANCELLED' THEN
    RETURN jsonb_build_object('id', p_voucher, 'changed', false, 'reason', 'đã huỷ trước đó');
  END IF;

  IF NOT app_private.ie_flex_mode_enabled_v1(v.organization_id) THEN
    RAISE EXCEPTION '[STRICT_MODE] Tổ chức đang bật Chuẩn kế toán — dùng đường Hoàn tác rồi Huỷ như cũ.'
      USING ERRCODE = '55000';
  END IF;

  PERFORM app_private.assert_manual_voucher_v1(p_voucher, 'huỷ');
  PERFORM app_private.assert_period_open_for_edit_v1(p_voucher, 'huỷ');

  v_is_super := public.is_super_admin();
  SELECT m.id INTO v_membership FROM public.organization_memberships m
   WHERE m.user_id = v_actor AND m.organization_id = v.organization_id AND m.status = 'ACTIVE' LIMIT 1;
  IF v_membership IS NULL AND NOT v_is_super THEN
    RAISE EXCEPTION 'Không thuộc tổ chức của phiếu' USING ERRCODE = '42501';
  END IF;

  -- Quyền: huỷ thu chi trên toà + đang GIỮ đúng sổ. Chủ tổ chức / super admin
  -- được vào thẳng (quyết định #4). Chế độ linh hoạt nới TRẠNG THÁI, không nới
  -- quyền: income_expenses.cancel vẫn là điều kiện như đường cũ.
  IF NOT v_is_super AND NOT app_private.is_org_owner_v1(v.organization_id, v_actor) THEN
    DECLARE v_allowed boolean;
    BEGIN
      SELECT allowed INTO v_allowed FROM app_private.authorize_tenant_action_v3(
        v_actor, v.organization_id, 'income_expenses.cancel', v.building_id, v.account_id);
      IF NOT COALESCE(v_allowed, false) THEN
        RAISE EXCEPTION 'Không có quyền huỷ phiếu thu chi trên toà này' USING ERRCODE = '42501';
      END IF;
      IF v.account_id IS NOT NULL THEN
        PERFORM app_private.assert_cashbook_access_v2(
          v.organization_id, v.account_id, 'CUSTODIAN', v_membership);
      END IF;
    END;
  END IF;

  IF COALESCE(v.has_restricted_item, false)
     AND v.user_id IS DISTINCT FROM v_actor
     AND NOT public.can_view_restricted_ie() AND NOT v_is_super THEN
    RAISE EXCEPTION 'Phiếu chứa hạng mục hạn chế — không có quyền huỷ' USING ERRCODE = '42501';
  END IF;

  IF p_expected_approval_version IS NOT NULL
     AND COALESCE(v.approval_version, 1) <> p_expected_approval_version THEN
    RAISE EXCEPTION 'Phiếu vừa được người khác thay đổi — hãy tải lại' USING ERRCODE = '40001';
  END IF;
  IF p_expected_posting_version IS NOT NULL
     AND COALESCE(v.posting_version, 1) <> p_expected_posting_version THEN
    RAISE EXCEPTION 'Phiếu vừa được người khác ghi sổ — hãy tải lại' USING ERRCODE = '40001';
  END IF;

  -- Token: vừa qua được trigger đóng băng, vừa TẮT cầu a85 để nó không đảo
  -- chồng lên bút toán mà hàm này sắp tự viết.
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
      -- Phiếu POSTED mà con trỏ rỗng là ca thật: nhánh BRIDGE_UNRESOLVED_POSTER
      -- của cầu a85 ghi dòng ngoại lệ rồi trả về mà không tạo posting.
      RAISE EXCEPTION 'Phiếu ghi nhận đã ghi sổ nhưng không tìm thấy bút toán gốc — báo quản trị trước khi huỷ.'
        USING ERRCODE = '55000';
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
       COALESCE(v_membership, v_active.posted_by_membership_id), v_actor,
       COALESCE(v.approval_version, 1), 'REVERSAL',
       'flexcancel:' || v_active.id::text, 'MANUAL', v_active.posting_generation,
       v_active.id, v_reason)
    RETURNING id INTO v_rev;

    INSERT INTO public.income_expense_posting_lines
      (organization_id, posting_id, account_id, line_kind, signed_amount)
    SELECT l.organization_id, v_rev, l.account_id, 'REVERSAL', -l.signed_amount
    FROM public.income_expense_posting_lines l
    WHERE l.posting_id = v_active.id;

    -- Hậu điều kiện: mọi bút toán của phiếu này phải triệt tiêu về 0.
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
    (p_voucher, v.organization_id, v_actor, v_reason, v_kind,
     v.created_at, v.approved_at, v.total_amount, v.account_id)
  ON CONFLICT (income_expense_id) DO NOTHING;

  PERFORM app_private.append_income_expense_event_v1(
    v.organization_id, p_voucher, 'CANCELLED', v_actor, NULL,
    v.approval_status, 'CANCELLED', v_reason);

  RETURN jsonb_build_object(
    'id', p_voucher, 'changed', true,
    'cancellation_kind', v_kind,
    'reversal_posting_id', v_rev
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.cancel_income_expense_flex_v1(uuid, text, bigint, bigint)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_income_expense_flex_v1(uuid, text, bigint, bigint)
  TO authenticated;

-- ── 4. Phiếu huỷ sau khi đã chi thì KHÔNG khôi phục được ────────────
-- restore_income_expense chỉ lật trục phê duyệt mà không ghi sổ lại, nên khôi
-- phục một phiếu đã đảo bút toán sẽ để phiếu "sống" mà tiền không bao giờ ra.
DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'restore_income_expense';
  IF v_def IS NULL THEN RAISE NOTICE 'Không có restore_income_expense'; RETURN; END IF;
  IF position('CANCELLED_AFTER_POSTING' IN v_def) > 0 THEN RETURN; END IF;

  DECLARE
    v_anchor text := 'if not found then raise exception ''Không tìm thấy phiếu'' using errcode=''P0002''; end if;';
  BEGIN
    IF position(v_anchor IN v_def) = 0 THEN
      RAISE EXCEPTION 'Không khớp mẫu neo trong restore_income_expense — DỪNG, không vá mù';
    END IF;

    v_def := replace(
      v_def,
      v_anchor,
      v_anchor || chr(10)
        || '  if v_rec.cancellation_kind_check is null then null; end if;' || chr(10)
        || '  if exists (select 1 from public.income_expenses x where x.id = p_id'
        || ' and x.cancellation_kind = ''CANCELLED_AFTER_POSTING'') then' || chr(10)
        || '    raise exception ''Phiếu đã chi rồi mới huỷ — không khôi phục được vì bút toán đã đảo về sổ. Hãy lập phiếu mới.'''
        || ' using errcode = ''55000'';' || chr(10)
        || '  end if;'
    );
    -- Dòng no-op ở trên chỉ để giữ chỗ dễ đọc; bỏ đi cho sạch.
    v_def := replace(v_def, '  if v_rec.cancellation_kind_check is null then null; end if;' || chr(10), '');

    IF position('CANCELLED_AFTER_POSTING' IN v_def) = 0 THEN
      RAISE EXCEPTION 'Vá restore_income_expense thất bại';
    END IF;
    EXECUTE v_def;
  END;
END
$patch$;

-- ── 5. Giao diện hỏi trước khi bày nút ──────────────────────────────
CREATE OR REPLACE FUNCTION public.can_flex_cancel_v1(p_ids uuid[])
RETURNS TABLE(id uuid, eligible boolean, reason_code text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_id uuid;
  v_org uuid;
  v_msg text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501'; END IF;

  FOREACH v_id IN ARRAY COALESCE(p_ids, ARRAY[]::uuid[]) LOOP
    SELECT ie.organization_id INTO v_org FROM public.income_expenses ie WHERE ie.id = v_id;
    CONTINUE WHEN v_org IS NULL;
    IF NOT public.is_super_admin() AND NOT EXISTS (
      SELECT 1 FROM public.organization_memberships m
       WHERE m.user_id = auth.uid() AND m.organization_id = v_org AND m.status = 'ACTIVE'
    ) THEN CONTINUE; END IF;

    IF NOT app_private.ie_flex_mode_enabled_v1(v_org) THEN
      id := v_id; eligible := false; reason_code := 'STRICT_MODE'; RETURN NEXT; CONTINUE;
    END IF;

    BEGIN
      PERFORM app_private.assert_manual_voucher_v1(v_id, 'huỷ');
      PERFORM app_private.assert_period_open_for_edit_v1(v_id, 'huỷ');
      id := v_id; eligible := true; reason_code := NULL; RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      v_msg := SQLERRM;
      id := v_id; eligible := false;
      reason_code := CASE
        WHEN v_msg LIKE '%NOT_MANUAL%'       THEN 'NOT_MANUAL'
        WHEN v_msg LIKE '%CASHBOOK_CLOSED%'  THEN 'CASHBOOK_CLOSED'
        WHEN v_msg LIKE '%HANDOVER_LOCKED%'  THEN 'HANDOVER_LOCKED'
        WHEN v_msg LIKE '%PROFIT_LOCKED%'    THEN 'PROFIT_LOCKED'
        ELSE 'UNKNOWN' END;
      RETURN NEXT;
    END;
  END LOOP;
END
$fn$;

REVOKE ALL ON FUNCTION public.can_flex_cancel_v1(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.can_flex_cancel_v1(uuid[]) TO authenticated;

-- Dấu vết huỷ cho màn chi tiết phiếu.
CREATE OR REPLACE FUNCTION public.get_voucher_cancellation_v1(p_voucher uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_org uuid;
  v_out jsonb;
BEGIN
  SELECT ie.organization_id INTO v_org FROM public.income_expenses ie WHERE ie.id = p_voucher;
  IF v_org IS NULL THEN RETURN NULL; END IF;
  IF NOT public.is_super_admin() AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
     WHERE m.user_id = auth.uid() AND m.organization_id = v_org AND m.status = 'ACTIVE'
  ) THEN RETURN NULL; END IF;

  SELECT jsonb_build_object(
    'cancelled_at', c.cancelled_at,
    'cancelled_by', c.cancelled_by,
    'cancelled_by_name', p.full_name,
    'cancel_reason', c.cancel_reason,
    'cancellation_kind', c.cancellation_kind,
    'created_at', c.created_at_snap,
    'approved_at', c.approved_at_snap,
    'amount', c.amount_snap
  ) INTO v_out
  FROM app_private.income_expense_cancellations c
  LEFT JOIN public.profiles p ON p.id = c.cancelled_by
  WHERE c.income_expense_id = p_voucher;

  RETURN v_out;
END
$fn$;

REVOKE ALL ON FUNCTION public.get_voucher_cancellation_v1(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_voucher_cancellation_v1(uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
