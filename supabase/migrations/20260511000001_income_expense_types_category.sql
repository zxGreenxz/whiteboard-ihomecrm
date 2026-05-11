-- =============================================
-- Add `category` (grouping label) to income_expense_types
-- Users gom các hạng mục thu/chi vào cùng một nhóm để tổng hợp dễ hơn,
-- vd Loại = "Bảo trì máy lạnh" gom "Vệ sinh máy lạnh", "Sửa máy lạnh", "Bơm gas".
-- =============================================

ALTER TABLE public.income_expense_types
  ADD COLUMN IF NOT EXISTS category TEXT;

-- Index để query distinct categories nhanh trong combobox
CREATE INDEX IF NOT EXISTS idx_income_expense_types_user_category
  ON public.income_expense_types (user_id, type, category)
  WHERE category IS NOT NULL;
