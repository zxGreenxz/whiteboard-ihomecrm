-- Tắt cảnh báo "chưa có phiếu" theo TỪNG toà cho các hạng mục chi cố định
-- không áp dụng với toà đó (vd toà xài nước giếng → khỏi báo thiếu Nước).
-- Giá trị = mảng `key` của FIXED_EXPENSE_CATEGORIES (src/lib/fixedExpenseCategories.ts):
--   tien_nha | dien | nuoc | internet | quan_ly | ve_sinh | cong_an | rac | thang_may
-- Cấu hình qua nút bánh răng ở panel "Khoản chi" của BC Doanh Thu Chi Phí.
ALTER TABLE public.buildings
  ADD COLUMN IF NOT EXISTS hidden_fixed_expenses text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.buildings.hidden_fixed_expenses IS
  'Key hạng mục chi cố định TẮT cảnh báo "chưa có phiếu" trên BC lợi nhuận (vd {nuoc} cho toà xài nước giếng)';
