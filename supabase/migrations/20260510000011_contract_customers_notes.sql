-- Thêm cột notes cho contract_customers để lưu ghi chú riêng cho mỗi khách
-- (vd: ghi chú về đại diện, ngày dọn vào, hoặc thông tin liên quan).
ALTER TABLE contract_customers
  ADD COLUMN IF NOT EXISTS notes text;
