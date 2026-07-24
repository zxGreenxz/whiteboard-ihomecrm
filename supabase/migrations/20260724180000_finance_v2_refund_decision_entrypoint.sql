-- Finance V2 — 7ac: entrypoint public cho quyết định phiếu REFUND (nối dây §8).
--
-- GAP (fleet 24/07, lộ sau khi 7ab thông đường tạo): adapter duyệt/huỷ refund
-- (dispatch_finance_decision_v2 → INVOICE_REFUND) hoàn chỉnh nhưng MỒ CÔI —
-- không RPC public nào gọi tới, refund birth không tạo approval_request →
-- phiếu "Hoàn tiền hoá đơn" tạo xong KẸT UNAPPROVED: approve v2 42501 (owned
-- by system flow — đúng thiết kế), compat cancel cũng từ chối flow-owned.
--
-- Fix đúng thiết kế §7.2/§8 "public RPC chỉ dispatch theo flow owner":
-- public.decide_owned_income_expense_v2(voucher, decision, reason, idem):
--   - decision ∈ ('approve','cancel') — các quyết định ĐỤNG TIỀN (post/reverse)
--     KHÔNG expose (cần posting linkage, chưa có đường sinh posting refund).
--   - CHỈ nhận flow INVOICE_REFUND / TERMINATION_REFUND (conservative: các flow
--     pair forfeit/move-out có RPC pair riêng, không cho đi cửa này).
--   - Quyền: income_expenses.approve trong scope toà của phiếu (đúng check của
--     approve_income_expense_v2 — duyệt/huỷ nghĩa vụ là hành động approver).
--   - Idempotency qua canonical_write_operations như mọi writer V2.
--   - cancel: tự tra reservation HELD theo refund_voucher_id để dựng payload
--     (client không đọc được app_private).

BEGIN;

DROP FUNCTION IF EXISTS public.decide_owned_income_expense_v2(uuid, text, text, text);
CREATE FUNCTION public.decide_owned_income_expense_v2(
  p_voucher uuid, p_decision text, p_reason text, p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $decide_owned$
DECLARE
  v_uid uuid;
  v_mid uuid;
  v_ie public.income_expenses;
  v_flow text;
  v_res record;
  v_payload jsonb := '{}'::jsonb;
  v_hash text := md5(jsonb_build_object('voucher', p_voucher, 'decision', p_decision)::text);
  v_op app_private.canonical_write_operations;
  v_resp jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 THEN
    RAISE EXCEPTION 'decide_owned_income_expense_v2: idempotency key is required' USING ERRCODE = '22023';
  END IF;
  IF p_decision NOT IN ('approve', 'cancel') THEN
    RAISE EXCEPTION 'decide_owned_income_expense_v2: decision % not exposed (approve|cancel)', p_decision
      USING ERRCODE = '22023';
  END IF;

  -- Fixed lock order: voucher first (như approve v2).
  SELECT * INTO v_ie FROM public.income_expenses ie WHERE ie.id = p_voucher FOR UPDATE;
  IF NOT FOUND OR v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'decide_owned_income_expense_v2: voucher % not found', p_voucher USING ERRCODE = 'P0002';
  END IF;

  SELECT o.flow_kind INTO v_flow
  FROM app_private.income_expense_flow_ownership o WHERE o.income_expense_id = p_voucher;
  IF v_flow IS NULL THEN
    RAISE EXCEPTION 'decide_owned_income_expense_v2: voucher % is MANUAL — dùng RPC thường', p_voucher
      USING ERRCODE = '42501';
  END IF;
  IF v_flow NOT IN ('INVOICE_REFUND', 'TERMINATION_REFUND') THEN
    RAISE EXCEPTION 'decide_owned_income_expense_v2: flow % không đi cửa này (fail closed)', v_flow
      USING ERRCODE = '42501';
  END IF;

  SELECT r.user_id, r.membership_id INTO v_uid, v_mid
  FROM app_private.resolve_finance_actor_v2(v_ie.organization_id) r;

  v_op := app_private.finance_v2_begin_canonical_op(
    v_ie.organization_id, 'income_expense.owned_decision.v2', p_voucher::text, v_uid, v_mid,
    p_idempotency_key, v_hash, p_voucher);
  IF v_op.completed_at IS NOT NULL THEN
    RETURN COALESCE(v_op.response_payload, '{}'::jsonb);
  END IF;

  -- Approver capability trong scope toà của phiếu (đồng bộ approve v2).
  IF NOT (SELECT allowed FROM app_private.authorize_tenant_action_v3(
            v_uid, v_ie.organization_id, 'income_expenses.approve', v_ie.building_id, NULL)) THEN
    RAISE EXCEPTION 'decide_owned_income_expense_v2: income_expenses.approve required in scope' USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.assert_committed_birth_boundary_v2(v_ie.birth_operation_id, p_voucher);

  -- cancel: dựng payload reservation (adapter cần reservationId + expectedStateVersion).
  IF p_decision = 'cancel' THEN
    SELECT r.id, r.state_version INTO v_res
    FROM app_private.invoice_refund_reservations r
    WHERE r.refund_voucher_id = p_voucher AND r.reservation_state = 'HELD'
    ORDER BY r.created_at DESC LIMIT 1;
    IF v_res.id IS NULL THEN
      RAISE EXCEPTION 'decide_owned_income_expense_v2: không tìm thấy reservation HELD của phiếu %', p_voucher
        USING ERRCODE = 'P0002';
    END IF;
    v_payload := jsonb_build_object(
      'reservationId', v_res.id, 'expectedStateVersion', v_res.state_version,
      'reason', COALESCE(p_reason, 'Huỷ nghĩa vụ hoàn tiền'));
  END IF;

  v_resp := app_private.dispatch_finance_decision_v2(p_voucher, p_decision, v_payload);

  PERFORM app_private.finance_v2_finish_canonical_op(v_op.id, v_resp);
  RETURN v_resp;
END
$decide_owned$;

REVOKE ALL ON FUNCTION public.decide_owned_income_expense_v2(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_owned_income_expense_v2(uuid, text, text, text) TO authenticated;

-- Smoke (probe tự-rollback, JWT giả lập CHUNHA DEMO): reserve refund → approve
-- qua RPC public → APPROVED, reservation GIỮ HELD → cancel qua RPC public →
-- CANCELLED + RELEASED. Toàn bộ rollback.
DO $smoke$
DECLARE
  v_org uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_inv record;
  v_mem record;
  v_out jsonb;
  v_voucher uuid;
  v_ie record;
  v_state text;
BEGIN
  SELECT i.id, i.building_id INTO v_inv
  FROM public.invoices i
  WHERE i.organization_id = v_org AND i.deleted_at IS NULL AND i.paid_amount > 0
  ORDER BY i.created_at DESC LIMIT 1;
  SELECT m.user_id, m.id AS membership_id INTO v_mem
  FROM public.organization_memberships m
  JOIN public.profiles p ON p.id = m.user_id
  WHERE m.organization_id = v_org AND m.status = 'ACTIVE'
  ORDER BY (p.full_name ILIKE '%chủ nhà%') DESC, p.created_at LIMIT 1;
  IF v_inv.id IS NULL OR v_mem.user_id IS NULL THEN
    RAISE NOTICE '7ac smoke: DEMO thiếu invoice paid>0/membership — bỏ qua probe';
    RETURN;
  END IF;

  BEGIN
    -- Giả lập JWT của user DEMO cho auth.uid() trong probe (local, rollback cùng txn).
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_mem.user_id, 'role', 'authenticated')::text, true);

    v_out := app_private.reserve_invoice_refund_obligation_v2(
      v_org, v_inv.id, v_inv.building_id, 1000, 'DEPOSIT',
      'invoice.refund', v_mem.user_id, v_mem.membership_id,
      'smoke-7ac-' || gen_random_uuid()::text);
    v_voucher := (v_out->>'refundVoucherId')::uuid;

    -- Same-txn probe KHÔNG thể qua birth-boundary (create phải commit ở txn
    -- TRƯỚC — đúng thiết kế §6.1). Smoke khẳng định WIRING: gọi approve phải
    -- đi QUA flow-guard + permission và chặn ĐÚNG ở birth-boundary (chứ không
    -- phải 42501 flow/permission hay lỗi khác). End-to-end thật verify qua
    -- REST sau khi áp (transaction tách rời).
    BEGIN
      v_out := public.decide_owned_income_expense_v2(
        v_voucher, 'approve', NULL, 'smoke-7ac-appr-' || gen_random_uuid()::text);
      RAISE EXCEPTION '7ac smoke FAIL: mong birth-boundary chặn same-txn nhưng approve đi lọt';
    EXCEPTION WHEN others THEN
      IF SQLERRM NOT LIKE '%birth%' AND SQLERRM NOT LIKE '%create operation not found%' THEN
        RAISE;
      END IF;
    END;

    -- Flow-guard: decision ngoài whitelist phải 22023.
    BEGIN
      v_out := public.decide_owned_income_expense_v2(
        v_voucher, 'post', NULL, 'smoke-7ac-post-' || gen_random_uuid()::text);
      RAISE EXCEPTION '7ac smoke FAIL: decision post phải bị chặn 22023';
    EXCEPTION WHEN others THEN
      IF SQLERRM NOT LIKE '%not exposed%' THEN RAISE; END IF;
    END;

    RAISE EXCEPTION 'SMOKE_ROLLBACK_7AC';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'SMOKE_ROLLBACK_7AC' THEN RAISE; END IF;
  END;
  RAISE NOTICE '7ac smoke PASS: wiring qua flow-guard+permission, chặn đúng birth-boundary; probe đã rollback';
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';
