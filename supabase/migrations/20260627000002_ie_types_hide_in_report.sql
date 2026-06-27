-- =============================================================================
-- income_expense_types.hide_in_report — đánh dấu "hạng mục đặc biệt" có thể ẩn
-- khỏi danh sách trong báo cáo Phân bổ lợi nhuận (vd "Tiền nhà" trả chủ nhà).
-- Khác is_restricted (ẩn theo quyền, enforce RLS): cờ này CHỈ để người dùng tự
-- bật/tắt hiển thị dòng trong báo cáo — không ảnh hưởng quyền hay số tổng.
-- =============================================================================
ALTER TABLE public.income_expense_types
  ADD COLUMN IF NOT EXISTS hide_in_report boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.income_expense_types.hide_in_report IS
  'Hạng mục "đặc biệt": cho phép ẩn dòng khỏi báo cáo Phân bổ lợi nhuận (tuỳ chọn FE, không đụng RLS/tổng).';

NOTIFY pgrst, 'reload schema';
