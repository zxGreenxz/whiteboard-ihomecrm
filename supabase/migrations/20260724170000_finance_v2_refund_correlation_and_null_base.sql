-- Finance V2 — 2 fix tầng cơ chế từ đợt sweep 24/07 (fleet 10 agents):
--
-- 7aa: resolver effective_profit_contributions_v2 lọc recognition_source_mode
--   = 'BASE' nhưng writer COMPAT (ie_compat_insert_v2 — đường tạo phiếu Chờ
--   duyệt thật của UI) để cột này NULL → phiếu pending compat KHÔNG lọt vào
--   finance_v2_pending_kqkd_blockers (close gate sẽ đếm hụt khi mở profit_close).
--   Quy mô: org thật 134 APPROVED + 25 UNAPPROVED NULL; DEMO 17+7.
--   Fix đọc-phía-resolver: COALESCE(mode,'BASE') — chữa cả lịch sử lẫn tương lai,
--   không UPDATE hàng loạt (tránh freeze-guard), ADJUSTMENT_ONLY giữ nguyên nghĩa.
--
-- 7ab: reserve_invoice_refund_obligation_v2 có 2 lỗi day-one trong INSERT
--   income_expense_flow_ownership (luồng hoàn tiền hoá đơn VỠ 100% từ khi
--   adapter ra đời 23/07 — bug tiền tồn, không do trigger 24/07):
--   (i) nhét p_idempotency_key (TEXT 'refund-<uuid>'/'refund:<id>:<md5>') vào
--       correlation_id (UUID) → 42804. Idempotency thật đã nằm ở
--       invoice_refund_reservations.idempotency_key (unique org+key) →
--       correlation_id để NULL, không mất tính idempotent.
--   (ii) payload_hash_scheme = 'md5' vi phạm CHECK (chỉ nhận
--       'PG_MD5_JSONB_TEXT_V1' — 79/79 row hiện hữu đều dùng giá trị này) → 23514.

BEGIN;

-- ============ 7aa: resolver COALESCE NULL → BASE ============
DO $patch_resolver$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private' AND p.proname = 'effective_profit_contributions_v2';

  IF v_def IS NULL THEN
    RAISE EXCEPTION '7aa: effective_profit_contributions_v2 không tồn tại';
  END IF;
  IF v_def LIKE '%7aa: null-mode = BASE%' THEN
    RETURN; -- đã vá
  END IF;

  v_def := replace(v_def,
    $$AND ie.recognition_source_mode = 'BASE'$$,
    $$AND COALESCE(ie.recognition_source_mode, 'BASE') = 'BASE' /* 7aa: null-mode = BASE — writer compat không stamp mode; NULL nghĩa là phiếu thường, không phải ADJUSTMENT_ONLY */$$);

  IF v_def NOT LIKE '%7aa: null-mode = BASE%' THEN
    RAISE EXCEPTION '7aa: pattern filter BASE không khớp — kiểm tra thủ công';
  END IF;
  EXECUTE v_def;
END
$patch_resolver$;

-- Smoke 7aa (probe tự-rollback): phiếu UNAPPROVED + kqkd ≠ 0 + mode NULL phải
-- xuất hiện trong resolver của kỳ tương ứng.
DO $smoke_resolver$
DECLARE
  v_org uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_uid uuid;
  v_bld uuid;
  v_typ uuid;
  v_id  uuid := gen_random_uuid();
  v_hit int;
BEGIN
  SELECT m.user_id INTO v_uid FROM public.organization_memberships m
  WHERE m.organization_id = v_org AND m.status = 'ACTIVE' LIMIT 1;
  SELECT b.id INTO v_bld FROM public.buildings b
  WHERE b.organization_id = v_org AND b.deleted_at IS NULL LIMIT 1;
  SELECT t.id INTO v_typ FROM public.income_expense_types t LIMIT 1;
  IF v_uid IS NULL OR v_bld IS NULL OR v_typ IS NULL THEN
    RAISE NOTICE '7aa smoke: DEMO thiếu membership/building/type — bỏ qua probe';
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.income_expenses
      (id, user_id, type, name, building_id, voucher_date, total_amount,
       approval_status, organization_id, counts_in_business_result, kqkd_amount,
       recognition_date, recognition_source_mode)
    VALUES
      (v_id, v_uid, 'EXPENSE', '[SMOKE 7aa] null-mode pending', v_bld,
       CURRENT_DATE, 12345, 'UNAPPROVED', v_org, true, -12345,
       CURRENT_DATE, NULL);
    -- Resolver phân bổ theo ITEM PNL (không theo header) → probe phải có item;
    -- trigger auto_recalc tính total = quantity×unit_price nên phải set cả 2
    -- (unit_price=0 sẽ kéo total về 0 và counts về false → probe giả).
    INSERT INTO public.income_expense_items
      (income_expense_id, income_expense_type_id, quantity, unit_price, amount, accounting_class)
    VALUES (v_id, v_typ, 1, 12345, 12345, 'PNL');

    SELECT count(*) INTO v_hit
    FROM app_private.effective_profit_contributions_v2(v_org, date_trunc('month', CURRENT_DATE)::date)
    WHERE source_voucher_id = v_id;

    IF v_hit < 1 THEN
      RAISE EXCEPTION '7aa smoke FAIL: phiếu mode-NULL vẫn không lọt resolver';
    END IF;
    RAISE EXCEPTION 'SMOKE_ROLLBACK_7AA'; -- chủ đích: huỷ probe
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'SMOKE_ROLLBACK_7AA' THEN RAISE; END IF;
      -- probe rollback sạch, không persist
  END;
  RAISE NOTICE '7aa smoke PASS: phiếu mode-NULL lọt resolver, probe đã rollback';
END
$smoke_resolver$;

-- ============ 7ab: refund correlation_id 42804 ============
DO $patch_refund$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app_private' AND p.proname = 'reserve_invoice_refund_obligation_v2';

  IF v_def IS NULL THEN
    RAISE EXCEPTION '7ab: reserve_invoice_refund_obligation_v2 không tồn tại';
  END IF;
  IF v_def LIKE '%7ab: correlation uuid%' THEN
    RETURN; -- đã vá
  END IF;

  v_def := replace(v_def,
    $$'invoice.refund.reserve.v2', 'md5', v_hash, p_actor_user, p_actor_user,
    p_idempotency_key
  );$$,
    $$'invoice.refund.reserve.v2', 'PG_MD5_JSONB_TEXT_V1', v_hash, p_actor_user, p_actor_user,
    NULL /* 7ab: correlation uuid + hash scheme — idempotency TEXT đã unique ở invoice_refund_reservations (nhét vào cột uuid gây 42804); scheme 'md5' vi phạm CHECK chỉ nhận PG_MD5_JSONB_TEXT_V1 (23514) */
  );$$);

  IF v_def NOT LIKE '%7ab: correlation uuid%' THEN
    RAISE EXCEPTION '7ab: pattern correlation_id không khớp — kiểm tra thủ công';
  END IF;
  EXECUTE v_def;
END
$patch_refund$;

-- Smoke 7ab (probe tự-rollback): reserve refund trên 1 hoá đơn DEMO có paid > 0
-- phải trả jsonb HELD (hết 42804), rồi rollback toàn bộ.
DO $smoke_refund$
DECLARE
  v_org uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_inv record;
  v_mem record;
  v_out jsonb;
BEGIN
  SELECT i.id, i.building_id INTO v_inv
  FROM public.invoices i
  WHERE i.organization_id = v_org AND i.deleted_at IS NULL AND i.paid_amount > 0
  ORDER BY i.created_at DESC LIMIT 1;
  IF v_inv.id IS NULL THEN
    RAISE NOTICE '7ab smoke: DEMO không có hoá đơn paid>0 — bỏ qua probe';
    RETURN;
  END IF;
  SELECT m.user_id, m.id AS membership_id INTO v_mem
  FROM public.organization_memberships m
  WHERE m.organization_id = v_org AND m.status = 'ACTIVE' LIMIT 1;

  BEGIN
    v_out := app_private.reserve_invoice_refund_obligation_v2(
      v_org, v_inv.id, v_inv.building_id, 1000, 'DEPOSIT',
      'invoice.refund', v_mem.user_id, v_mem.membership_id,
      'smoke-7ab-' || gen_random_uuid()::text);
    IF v_out IS NULL OR (v_out->>'reservationState') IS DISTINCT FROM 'HELD' THEN
      RAISE EXCEPTION '7ab smoke FAIL: reserve không trả HELD: %', v_out;
    END IF;
    RAISE EXCEPTION 'SMOKE_ROLLBACK_7AB';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'SMOKE_ROLLBACK_7AB' THEN RAISE; END IF;
  END;
  RAISE NOTICE '7ab smoke PASS: reserve refund HELD (hết 42804), probe đã rollback';
END
$smoke_refund$;

COMMIT;

NOTIFY pgrst, 'reload schema';
