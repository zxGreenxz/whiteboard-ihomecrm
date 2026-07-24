-- Finance V2 — 7ac(b): cancel_income_expense_v1 phải TỪ CHỐI phiếu do flow
-- HỆ THỐNG sở hữu (INVOICE_REFUND/TERMINATION_REFUND/pair...).
--
-- Lỗ hổng (phát hiện khi nối dây 7ac): cancel v1 chỉ check
-- is_income_expense_flow_owned (EXISTS bất kỳ flow row nào) rồi huỷ thẳng —
-- với phiếu refund sẽ CANCELLED voucher nhưng BỎ QUÊN reservation HELD →
-- refundable cap của hoá đơn bị chiếm vĩnh viễn. Đường huỷ đúng là
-- decide_owned_income_expense_v2 → dispatcher → adapter (release reservation
-- atomic, 20260724180000).
--
-- Fix: chèn assert_income_expense_flow_owner_v2(id,'CANONICAL_INCOME_EXPENSE')
-- ngay sau check flow-owned — phiếu flow hệ thống nhận 42501
-- "owned by system flow ..." (client statusMutations bắt đúng chuỗi này để
-- chuyển sang decide_owned).

BEGIN;

DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'cancel_income_expense_v1';

  IF v_def IS NULL THEN
    RAISE EXCEPTION '7ac(b): cancel_income_expense_v1 không tồn tại';
  END IF;
  IF v_def LIKE '%7ac: system-flow guard%' THEN
    RETURN; -- đã vá
  END IF;

  v_def := replace(v_def,
    $$  if not app_private.is_income_expense_flow_owned(v_row.id) then
    raise exception 'Phiếu chưa thuộc luồng canonical — dùng đường legacy'
      using errcode = '55000';
  end if;$$,
    $$  if not app_private.is_income_expense_flow_owned(v_row.id) then
    raise exception 'Phiếu chưa thuộc luồng canonical — dùng đường legacy'
      using errcode = '55000';
  end if;

  -- 7ac: system-flow guard — phiếu do flow HỆ THỐNG sở hữu (refund/pair) không
  -- huỷ ở đây (sẽ bỏ quên reservation); 42501 'owned by system flow' để client
  -- chuyển sang decide_owned_income_expense_v2 (dispatcher §8).
  perform app_private.assert_income_expense_flow_owner_v2(v_row.id, 'CANONICAL_INCOME_EXPENSE');$$);

  IF v_def NOT LIKE '%7ac: system-flow guard%' THEN
    RAISE EXCEPTION '7ac(b): pattern cancel v1 không khớp — kiểm tra thủ công';
  END IF;
  EXECUTE v_def;
END
$patch$;

-- Smoke (probe tự-rollback): reserve refund DEMO rồi gọi cancel v1 (JWT giả lập
-- CHUNHA) → PHẢI 42501 'owned by system flow', reservation vẫn HELD.
DO $smoke$
DECLARE
  v_org uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_inv record;
  v_mem record;
  v_out jsonb;
  v_voucher uuid;
  v_state text;
BEGIN
  SELECT i.id, i.building_id INTO v_inv
  FROM public.invoices i
  WHERE i.organization_id = v_org AND i.deleted_at IS NULL AND i.paid_amount > 0
  ORDER BY i.created_at DESC LIMIT 1;
  SELECT m.user_id, m.id AS membership_id INTO v_mem
  FROM public.organization_memberships m
  WHERE m.organization_id = v_org AND m.status = 'ACTIVE' LIMIT 1;
  IF v_inv.id IS NULL OR v_mem.user_id IS NULL THEN
    RAISE NOTICE '7ac(b) smoke: DEMO thiếu dữ liệu — bỏ qua probe';
    RETURN;
  END IF;

  BEGIN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_mem.user_id, 'role', 'authenticated')::text, true);

    v_out := app_private.reserve_invoice_refund_obligation_v2(
      v_org, v_inv.id, v_inv.building_id, 1000, 'DEPOSIT',
      'invoice.refund', v_mem.user_id, v_mem.membership_id,
      'smoke-7acb-' || gen_random_uuid()::text);
    v_voucher := (v_out->>'refundVoucherId')::uuid;

    BEGIN
      PERFORM public.cancel_income_expense_v1(v_voucher, 'smoke');
      RAISE EXCEPTION '7ac(b) smoke FAIL: cancel v1 huỷ lọt phiếu refund';
    EXCEPTION WHEN others THEN
      IF SQLERRM NOT LIKE '%owned by system flow%' THEN RAISE; END IF;
    END;

    SELECT reservation_state INTO v_state
    FROM app_private.invoice_refund_reservations WHERE refund_voucher_id = v_voucher;
    IF v_state IS DISTINCT FROM 'HELD' THEN
      RAISE EXCEPTION '7ac(b) smoke FAIL: reservation bị đụng (%)', v_state;
    END IF;

    RAISE EXCEPTION 'SMOKE_ROLLBACK_7ACB';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'SMOKE_ROLLBACK_7ACB' THEN RAISE; END IF;
  END;
  RAISE NOTICE '7ac(b) smoke PASS: cancel v1 chặn refund voucher, reservation giữ HELD; probe rollback';
END
$smoke$;

COMMIT;

NOTIFY pgrst, 'reload schema';
