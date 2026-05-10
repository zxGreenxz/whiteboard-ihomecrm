-- =============================================
-- Migration: Phiếu Thu/Chi Tổng (Batch)
-- Tạo 2 bảng MỚI để gom nhóm nhiều phiếu thu/chi cùng đợt thanh toán
-- (vd: 1 lần trả thợ vệ sinh máy lạnh ở 4 nhà + sửa máy giặt 1 nhà).
-- KHÔNG sửa cấu trúc bảng income_expenses.
-- =============================================

-- ============================================================
-- BẢNG 1: income_expense_batches  (metadata đợt thu/chi tổng)
-- ============================================================
CREATE TABLE IF NOT EXISTS income_expense_batches (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('INCOME','EXPENSE')),
  payer_name   TEXT,
  attachments  JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ,
  CONSTRAINT income_expense_batches_name_not_empty CHECK (char_length(name) > 0)
);

CREATE INDEX IF NOT EXISTS idx_ie_batches_user
  ON income_expense_batches(user_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ie_batches_created
  ON income_expense_batches(created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TRIGGER trg_ie_batches_updated_at
  BEFORE UPDATE ON income_expense_batches
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE income_expense_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ie_batches_select_own" ON income_expense_batches
  FOR SELECT USING (auth.uid() = user_id AND deleted_at IS NULL);
CREATE POLICY "ie_batches_insert_own" ON income_expense_batches
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ie_batches_update_own" ON income_expense_batches
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "ie_batches_delete_own" ON income_expense_batches
  FOR DELETE USING (auth.uid() = user_id);

COMMENT ON TABLE income_expense_batches IS
  'Phiếu Thu/Chi Tổng: metadata đợt thanh toán gộp nhiều phiếu lẻ (cùng người nhận, cùng ngày, cùng ảnh đính kèm).';

-- ============================================================
-- BẢNG 2: income_expense_batch_items  (junction batch ↔ voucher)
-- ============================================================
CREATE TABLE IF NOT EXISTS income_expense_batch_items (
  batch_id          UUID NOT NULL REFERENCES income_expense_batches(id) ON DELETE CASCADE,
  income_expense_id UUID NOT NULL REFERENCES income_expenses(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (batch_id, income_expense_id)
);

-- Mỗi voucher chỉ thuộc tối đa 1 batch
CREATE UNIQUE INDEX IF NOT EXISTS idx_ie_batch_items_voucher_unique
  ON income_expense_batch_items(income_expense_id);

CREATE INDEX IF NOT EXISTS idx_ie_batch_items_batch
  ON income_expense_batch_items(batch_id);

-- RLS — derive từ batch ownership
ALTER TABLE income_expense_batch_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ie_batch_items_all_own" ON income_expense_batch_items
  FOR ALL USING (
    batch_id IN (SELECT id FROM income_expense_batches WHERE user_id = auth.uid())
  ) WITH CHECK (
    batch_id IN (SELECT id FROM income_expense_batches WHERE user_id = auth.uid())
  );

COMMENT ON TABLE income_expense_batch_items IS
  'Junction: liên kết 1 batch (income_expense_batches) với N phiếu lẻ (income_expenses).';
