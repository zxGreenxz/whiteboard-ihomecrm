-- =============================================
-- Xu ly thieu coc khi ky HD: ghi nhan admin da xu ly + cach xu ly + ly do + hen ngay.
--
-- Boi canh: khi tao HD ma khach chua dong du coc (deposit_paid < total_deposit),
-- app bat buoc admin chon cach xu ly moi luu duoc (enforce o tang app — KHONG dat
-- CHECK constraint chan luu de renew/transfer RPC va du lieu cu khong vo).
--
--   • deposit_debt_acknowledged  — admin da xu ly viec thieu coc luc ky.
--   • deposit_debt_mode           — cach xu ly khi thieu coc:
--        'DEBT'          = no coc (theo doi + nhac bo sung; co ly do, hen ngay).
--        'FIRST_INVOICE' = khach dong du ngay trong hoa don coc+thang dau
--                          (khong hen, khong nhac bo sung sau).
--   • deposit_debt_reason        — ly do cho no coc (chi mode DEBT).
--   • deposit_topup_due_date     — hen ngay bo sung coc (chi mode DEBT; de nhac).
--
-- Marker "du/thieu coc" suy ra tu contracts.deposit_remaining (cot GENERATED),
-- khong can cot rieng.
-- =============================================

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS deposit_debt_acknowledged BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS deposit_debt_mode TEXT;

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS deposit_debt_reason TEXT;

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS deposit_topup_due_date DATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contracts_deposit_debt_mode_check'
  ) THEN
    ALTER TABLE contracts
      ADD CONSTRAINT contracts_deposit_debt_mode_check
      CHECK (deposit_debt_mode IS NULL OR deposit_debt_mode IN ('DEBT', 'FIRST_INVOICE'));
  END IF;
END $$;

COMMENT ON COLUMN contracts.deposit_debt_acknowledged IS
  'Admin da xu ly viec thieu coc luc ky (deposit_paid < total_deposit).';
COMMENT ON COLUMN contracts.deposit_debt_mode IS
  'Cach xu ly thieu coc: DEBT (no, co nhac) | FIRST_INVOICE (thu du o hoa don dau).';
COMMENT ON COLUMN contracts.deposit_debt_reason IS
  'Ly do cho no coc — bat buoc khi mode = DEBT.';
COMMENT ON COLUMN contracts.deposit_topup_due_date IS
  'Hen ngay khach bo sung du coc (mode DEBT) — dung de nhac (notificationScheduler).';

-- Nhac/danh dau thieu coc query theo HD in-effect con thieu coc → index ho tro.
CREATE INDEX IF NOT EXISTS idx_contracts_deposit_topup_due
  ON contracts (deposit_topup_due_date)
  WHERE deposit_topup_due_date IS NOT NULL;
