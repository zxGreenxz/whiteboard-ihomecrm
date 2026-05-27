-- =============================================
-- Migration: Backfill audit "Làm tròn tiền thiếu" cho HĐ đã PAID với residual < 10K
-- Created: 2026-05-27
-- Description:
--   20260527000001 đã mark status=PAID cho ~60 HĐ đang có residual < 10K
--   nhưng KHÔNG ghi rounding metadata lên voucher INCOME tương ứng.
--   Migration này backfill: gắn rounding_amount + rounding_account_id +
--   append note lên voucher INCOME mới nhất của từng HĐ đó.
--
--   Idempotent: dùng EXISTS check + chỉ update voucher chưa có rounding_amount,
--   notes chỉ append nếu chưa chứa marker "Làm tròn thiếu".
-- =============================================

BEGIN;

DO $$
DECLARE
  v_rounding_account_id UUID;
BEGIN
  -- Lấy sổ "Làm tròn tiền thiếu" duy nhất (đã được seed bởi migration 0001).
  SELECT id INTO v_rounding_account_id
  FROM accounts
  WHERE name = 'Làm tròn tiền thiếu'
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_rounding_account_id IS NULL THEN
    RAISE EXCEPTION 'Account "Làm tròn tiền thiếu" chưa tồn tại — chạy migration 20260527000001 trước.';
  END IF;

  -- Backfill: với mỗi HĐ PAID có residual < 10K (và chưa có rounding metadata),
  -- update voucher INCOME mới nhất.
  WITH targets AS (
    SELECT
      i.id AS invoice_id,
      (i.total_amount - i.paid_amount)::DECIMAL(15,2) AS rounding_amt,
      i.invoice_number,
      (
        SELECT ie.id
        FROM income_expenses ie
        WHERE ie.invoice_id = i.id
          AND ie.type = 'INCOME'
          AND ie.deleted_at IS NULL
        ORDER BY ie.created_at DESC, ie.id DESC
        LIMIT 1
      ) AS latest_voucher_id
    FROM invoices i
    WHERE i.deleted_at IS NULL
      AND i.status = 'PAID'
      AND i.total_amount > i.paid_amount
      AND (i.total_amount - i.paid_amount) > 0
      AND (i.total_amount - i.paid_amount) < 10000
      AND NOT EXISTS (
        -- chưa có voucher nào của HĐ này gắn rounding > 0
        SELECT 1 FROM income_expenses ie2
        WHERE ie2.invoice_id = i.id
          AND ie2.type = 'INCOME'
          AND ie2.deleted_at IS NULL
          AND ie2.rounding_amount > 0
      )
  )
  UPDATE income_expenses ie
  SET
    rounding_amount = t.rounding_amt,
    rounding_account_id = v_rounding_account_id,
    notes = CASE
      WHEN COALESCE(ie.notes, '') ILIKE '%Làm tròn thiếu%' THEN ie.notes
      WHEN COALESCE(ie.notes, '') = '' THEN
        'Làm tròn thiếu ' || trim(to_char(t.rounding_amt, 'FM999G999G999G999'))
      ELSE
        ie.notes || ' — Làm tròn thiếu ' || trim(to_char(t.rounding_amt, 'FM999G999G999G999'))
    END
  FROM targets t
  WHERE ie.id = t.latest_voucher_id;
END $$;

COMMIT;
