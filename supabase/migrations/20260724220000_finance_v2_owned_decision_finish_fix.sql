-- Finance V2 — 7ac(d): decide_owned_income_expense_v2 gọi finish_canonical_op
-- sai chữ ký (`v_op.id` — record canonical op không có field id; chữ ký thật là
-- (org, operation, subject_scope, actor, idempotency_key, subject, response,
-- outcome, review_ver, approval_ver, posting_ver)) → 42703 ngay sau khi dispatch
-- thành công. Lộ khi verify end-to-end tách transaction (smoke same-txn dừng ở
-- birth-boundary trước khi chạm dòng này — bài học: smoke phải phủ tới RETURN).

BEGIN;

DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'decide_owned_income_expense_v2';

  IF v_def LIKE '%7ac(d): finish signature%' THEN
    RETURN;
  END IF;

  v_def := replace(v_def,
    $$  PERFORM app_private.finance_v2_finish_canonical_op(v_op.id, v_resp);$$,
    $$  -- 7ac(d): finish signature — khớp finish_canonical_op 11 tham số.
  PERFORM app_private.finance_v2_finish_canonical_op(
    v_ie.organization_id, 'income_expense.owned_decision.v2', p_voucher::text, v_uid,
    p_idempotency_key, p_voucher, v_resp, upper(p_decision), NULL, NULL, NULL);$$);

  IF v_def NOT LIKE '%7ac(d): finish signature%' THEN
    RAISE EXCEPTION '7ac(d): pattern finish không khớp — kiểm tra thủ công';
  END IF;
  EXECUTE v_def;
END
$patch$;

COMMIT;

NOTIFY pgrst, 'reload schema';
