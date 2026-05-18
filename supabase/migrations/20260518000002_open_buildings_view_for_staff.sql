-- =============================================================
-- Mở buildings SELECT cho staff bất kể building scope
--
-- Bối cảnh
-- ────────
-- Migration 20260427_apply_staff_visibility tạo `buildings_select_staff`
-- với điều kiện kép: vừa thuộc owner-set, vừa nằm trong staff_building_scope.
-- Hậu quả: Joey được tick 6 tòa → chỉ SELECT được 6 row buildings → rooms
-- (RLS qua EXISTS buildings) cũng bị chặn → mọi hợp đồng/khách hàng/phương
-- tiện ở tòa khác về client thiếu thông tin tòa nhà & căn hộ (vì
-- contract.room null). Dropdown lọc tòa của 3 trang cũng chỉ thấy 6 tòa.
--
-- Yêu cầu (2026-05-18): các trang hợp đồng/khách hàng/phương tiện cho
-- staff XEM ĐẦY ĐỦ. Chỉ thao tác bị khoá theo building scope (đã thắt ở
-- migration 20260518000001).
--
-- Fix
-- ───
-- Thay `buildings_select_staff` bằng policy mở: cho phép SELECT mọi tòa
-- thuộc owner-set của caller. Việc khoá WRITE theo building scope đã được
-- xử lý ở các policy *_staff_insert/update/delete cho từng bảng nghiệp vụ
-- (buildings cũng có sẵn từ 20260510000006), nên mở SELECT không làm staff
-- sửa được tòa khác.
--
-- Idempotent.
-- =============================================================

BEGIN;

DROP POLICY IF EXISTS buildings_select_staff ON buildings;
CREATE POLICY buildings_select_staff ON buildings
  FOR SELECT
  USING (user_id = ANY (public.current_visible_owner_ids()));

NOTIFY pgrst, 'reload schema';
COMMIT;
