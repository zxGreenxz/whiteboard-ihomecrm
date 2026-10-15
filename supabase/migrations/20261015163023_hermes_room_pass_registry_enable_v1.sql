-- Bật registry Thao tác Hermes 'sale_phong.manage_pass_listings' (tin "Khách nhờ
-- sale"): xem/bật-ẩn (hermes_room_pass_action_v1) và tra phòng/tạo-sửa tin pass
-- (hermes_room_pass_upsert_v1, apply file 20261015162454 trước file này).
-- Registry chỉ là trần toàn hệ: mỗi kết nối vẫn phải tự chọn Thao tác này cùng
-- phạm vi toà trong overlay, chính sách công ty và quyền CRM hiện tại của user
-- (sale_phong.manage_pass_listings theo toà) vẫn áp dụng và được kiểm lại mỗi
-- lượt gọi. Không đổi chính sách, kết nối hay quyền user nào; chỉ UPDATE đúng
-- một dòng, chặn nếu dòng registry hoặc RPC upsert (đúng chữ ký) chưa có.
-- Tắt lại: UPDATE … SET enabled=false bằng một migration forward khác.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $enable$
DECLARE missing int;
BEGIN
  SELECT 1-count(*) INTO missing FROM app_private.hermes_capabilities
    WHERE capability='sale_phong.manage_pass_listings' AND mode='action';
  IF missing<>0 THEN
    RAISE EXCEPTION 'hermes_room_pass_registry_missing: % dòng', missing;
  END IF;
  IF to_regprocedure('public.hermes_room_pass_upsert_v1(jsonb,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'hermes_room_pass_upsert_missing: apply 20261015162454_hermes_room_pass_upsert_v1 trước';
  END IF;
  UPDATE app_private.hermes_capabilities SET enabled=true
    WHERE capability='sale_phong.manage_pass_listings' AND mode='action' AND NOT enabled;
END
$enable$;
COMMIT;
NOTIFY pgrst,'reload schema';
