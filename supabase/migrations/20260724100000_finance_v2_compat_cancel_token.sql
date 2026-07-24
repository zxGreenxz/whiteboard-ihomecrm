-- Finance V2 — Hotfix 7u: token transition STALE + compat cancel thiếu token.
--
-- E2E bắt 2 lỗi chồng nhau:
-- (1) ie_compat_cancel_v2 UPDATE thẳng không cấp token ⇒ 55000 "is frozen".
-- (2) NGHIÊM TRỌNG HƠN: ie_transition_authorization PK = (income_expense_id)
--     ĐƠN, mọi writer cấp token bằng ON CONFLICT DO NOTHING ⇒ phiếu TỪNG có
--     token (xid cũ) giữ row stale vĩnh viễn ⇒ lần transition SAU cùng phiếu
--     không ghi được xid mới ⇒ guard so xid hiện tại lệch ⇒ frozen. Mọi phiếu
--     đã đi qua 1 lifecycle V2 sẽ chết ở lifecycle tiếp theo trong txn khác.
-- Fix: token grant = UPSERT xid (DO UPDATE) ở cả begin_canonical_op (7j),
-- compat cancel (mới thêm), và backfill dọn. Allowlist nhận 'notes' (compat
-- cancel append "[Hủy] <lý do>"; cột server-owned từ Stage-7).

BEGIN;

DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p WHERE p.proname='ie_compat_cancel_v2'
    AND p.pronamespace='public'::regnamespace;
  IF v_def NOT LIKE '%FINANCE_V2_LIFECYCLE%' THEN
    v_def := replace(v_def,
      'UPDATE public.income_expenses SET
      approval_status=''CANCELLED''',
      '-- Token per-xid: guard freeze đòi trước khi cho transition (7u).
    INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
    VALUES (v_id, pg_current_xact_id(), ''FINANCE_V2_LIFECYCLE'')
    ON CONFLICT (income_expense_id) DO UPDATE
      SET xid = EXCLUDED.xid, purpose = EXCLUDED.purpose, granted_at = now();
    UPDATE public.income_expenses SET
      approval_status=''CANCELLED''');
    IF v_def NOT LIKE '%FINANCE_V2_LIFECYCLE%' THEN
      RAISE EXCEPTION 'compat cancel token: pattern không khớp — kiểm tra thủ công';
    END IF;
    EXECUTE v_def;
  END IF;
END
$patch$;

-- (7u-b) begin_canonical_op (7j): token grant DO NOTHING → UPSERT xid mới.
DO $begintok$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='app_private' AND p.proname='finance_v2_begin_canonical_op';
  IF v_def LIKE '%FINANCE_V2_LIFECYCLE%' AND v_def NOT LIKE '%granted_at = now()%' THEN
    v_def := replace(v_def,
      'VALUES (p_subject_id, pg_current_xact_id(), ''FINANCE_V2_LIFECYCLE'')
    ON CONFLICT DO NOTHING;',
      'VALUES (p_subject_id, pg_current_xact_id(), ''FINANCE_V2_LIFECYCLE'')
    ON CONFLICT (income_expense_id) DO UPDATE
      SET xid = EXCLUDED.xid, purpose = EXCLUDED.purpose, granted_at = now();');
    IF v_def NOT LIKE '%granted_at = now()%' THEN
      RAISE EXCEPTION 'begin_canonical_op token upsert: pattern không khớp';
    END IF;
    EXECUTE v_def;
  END IF;
END
$begintok$;

DO $widen$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p WHERE p.proname='guard_income_expense_owned_payload';
  IF v_def NOT LIKE '%''notes''%' THEN
    v_def := replace(v_def,
      '''cancellation_kind'',''deleted_at'',''approval_request_id''',
      '''cancellation_kind'',''deleted_at'',''approval_request_id'',''notes''');
    IF v_def NOT LIKE '%''notes''%' THEN
      RAISE EXCEPTION 'allowlist notes: pattern không khớp — kiểm tra thủ công';
    END IF;
    EXECUTE v_def;
  END IF;
END
$widen$;

-- Backfill dọn: các phiếu E2E treo (APPROVED/REVERSED, chưa xoá) giờ huỷ được.
DO $clean$
DECLARE v_row record; v_n int := 0;
BEGIN
  FOR v_row IN
    SELECT id FROM public.income_expenses
    WHERE (name LIKE '[E2E-V2]%' OR name LIKE '[SMOKE%')
      AND organization_id='dddd0000-0000-4000-8000-000000000001'
      AND deleted_at IS NULL AND approval_status <> 'CANCELLED'
      AND COALESCE(posting_status,'UNPOSTED') <> 'POSTED'
  LOOP
    INSERT INTO app_private.ie_transition_authorization (income_expense_id, xid, purpose)
    VALUES (v_row.id, pg_current_xact_id(), 'FINANCE_V2_LIFECYCLE')
    ON CONFLICT (income_expense_id) DO UPDATE
      SET xid = EXCLUDED.xid, purpose = EXCLUDED.purpose, granted_at = now();
    UPDATE public.income_expenses
       SET approval_status='CANCELLED', review_state='RESOLVED',
           cancellation_kind=COALESCE(cancellation_kind,'COMPAT_BATCH_CANCEL')
     WHERE id = v_row.id;
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE 'e2e stranded cleanup: % phiếu', v_n;
END
$clean$;

COMMIT;

NOTIFY pgrst, 'reload schema';
