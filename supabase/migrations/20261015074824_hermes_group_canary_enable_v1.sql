-- Bật registry đọc nhóm / gửi nhóm Zalo cho Hermes (canary gửi nhóm, chủ dự án
-- cho phép 15/10/2026). Registry chỉ là trần toàn hệ: mỗi kết nối vẫn phải tự
-- chọn chat_zalo.view (Đọc) + chat_zalo.send (Thao tác) trong overlay, quyền CRM
-- hiện tại của user và chính sách công ty vẫn áp dụng, worker kiểm quyền lại
-- ngay trước provider call. Không đổi chính sách, kết nối hay quyền user nào.
-- Tắt lại: UPDATE … SET enabled=false bằng một migration forward khác.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $enable$
DECLARE missing int;
BEGIN
  SELECT 2-count(*) INTO missing FROM app_private.hermes_capabilities
    WHERE (capability,mode) IN (('chat_zalo.view','read'),('chat_zalo.send','action'));
  IF missing<>0 THEN
    RAISE EXCEPTION 'hermes_group_canary_registry_missing: % dòng', missing;
  END IF;
  UPDATE app_private.hermes_capabilities SET enabled=true
    WHERE (capability,mode) IN (('chat_zalo.view','read'),('chat_zalo.send','action')) AND NOT enabled;
END
$enable$;
COMMIT;
NOTIFY pgrst,'reload schema';
