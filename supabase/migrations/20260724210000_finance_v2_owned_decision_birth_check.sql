-- Finance V2 — 7ac(c): decide_owned_income_expense_v2 fail 55000 với MỌI phiếu
-- refund vì assert_committed_birth_boundary_v2 tra op 'income_expense.create.v2'
-- — nhưng birth của phiếu refund đăng ký dưới op 'invoice.refund.reserve.v2'
-- (wrapper public), không có row create.v2 → "create operation not found".
--
-- Fix: với flow refund (đã whitelist), kiểm committed-birth bằng bất biến GỐC
-- của §6.1: birth_txid NOT NULL và ≠ pg_current_xact_id() (create đã commit ở
-- transaction trước). Không nới gì khác — flow whitelist + quyền + dispatch giữ
-- nguyên.

BEGIN;

DO $patch$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'decide_owned_income_expense_v2';

  IF v_def IS NULL THEN
    RAISE EXCEPTION '7ac(c): decide_owned_income_expense_v2 không tồn tại';
  END IF;
  IF v_def LIKE '%7ac(c): txid birth check%' THEN
    RETURN;
  END IF;

  v_def := replace(v_def,
    $$  PERFORM app_private.assert_committed_birth_boundary_v2(v_ie.birth_operation_id, p_voucher);$$,
    $$  -- 7ac(c): txid birth check — refund birth đăng ký op 'invoice.refund.reserve.v2'
  -- (không có row create.v2) nên assert_committed_birth_boundary_v2 luôn fail;
  -- bất biến cần giữ là "create đã COMMIT ở txn trước" = birth_txid ≠ txid này.
  IF v_ie.birth_txid IS NULL OR v_ie.birth_txid = pg_current_xact_id() THEN
    RAISE EXCEPTION 'decide_owned_income_expense_v2: birth chưa commit ở transaction trước (voucher %)', p_voucher
      USING ERRCODE = '55000';
  END IF;$$);

  IF v_def NOT LIKE '%7ac(c): txid birth check%' THEN
    RAISE EXCEPTION '7ac(c): pattern assert birth không khớp — kiểm tra thủ công';
  END IF;
  EXECUTE v_def;
END
$patch$;

COMMIT;

NOTIFY pgrst, 'reload schema';
