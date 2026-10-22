-- Tắt tạm tool huỷ việc của Hermes (crm_task_cancel) — chủ dự án duyệt 21/10/2026
-- ("Tắt ngay", câu 28 của trang chốt câu hỏi). Lý do: khi thử bot thật trên TEST, quản lý
-- bảo huỷ "việc sửa vòi nước phòng 201 toà 1392QT" (toà ngoài phạm vi của họ), bot xoá
-- nhầm việc cùng tên ở toà 158PVC mà không hỏi lại; huỷ là DELETE jobs, không lùi được.
-- Chưa có bước xem trước/xác nhận ở máy chủ; lời dặn trong SOUL chỉ là rào mềm. Bộ tool
-- ghi dùng chung có xác nhận hai lượt sẽ thay. Người dùng vẫn huỷ việc trên web.
-- Registry chỉ là trần toàn hệ: tắt `tasks.delete` (mode action) thì connector không quảng
-- bá crm_task_cancel và SQL từ chối (hermes_task_follow_v1 kiểm registry bật). Khoá này chỉ
-- dùng cho crm_task_cancel; tạo việc, theo dõi, ghi tiến độ không đổi.
-- CHẶN TRƯỚC (cùng cơ chế review #254 C1): gia hạn token kiểm action_capabilities đã lưu với
-- registry; kết nối `legacy_allowlist` còn giữ khoá này sẽ không gia hạn được ⇒ từ chối khi
-- còn kết nối như vậy. Production 21/10: 0 kết nối legacy ACTIVE.
-- Bật lại: UPDATE … SET enabled=true bằng một forward migration khác.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $disable$
DECLARE legacy int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_private.hermes_capabilities c
                  WHERE c.capability='tasks.delete' AND c.mode='action') THEN
    RAISE EXCEPTION 'hermes_capabilities_disable_missing: tasks.delete';
  END IF;
  SELECT count(*) INTO legacy FROM app_private.hermes_connections h
   WHERE h.state='ACTIVE' AND h.permission_mode='legacy_allowlist'
     AND 'tasks.delete'=ANY(h.action_capabilities);
  IF legacy>0 THEN
    RAISE EXCEPTION 'hermes_task_cancel_disable_blocked: % kết nối legacy_allowlist ACTIVE còn giữ tasks.delete', legacy
      USING HINT='Thu hẹp, chuyển inherit_crm hoặc thu hồi các kết nối đó trước; tắt registry sẽ làm gia hạn token của chúng thất bại.';
  END IF;
  UPDATE app_private.hermes_capabilities c SET enabled=false
    WHERE c.capability='tasks.delete' AND c.mode='action' AND c.enabled;
END
$disable$;
COMMIT;
NOTIFY pgrst,'reload schema';
