-- PR-7b · §E.1 — Bật realtime cho public.notifications.
--
-- Vì sao AN TOÀN bây giờ mới bật: 20260729130000_notifications_rls_own_row.sql đã siết
-- RLS về own-row (4 policy PERMISSIVE user_id = auth.uid() + 1 RESTRICTIVE org boundary).
-- Realtime của Supabase áp đúng RLS đó cho từng subscriber, nên thêm bảng vào publication
-- KHÔNG phát dòng của người khác. Bật TRƯỚC khi siết RLS thì mọi máy đang mở app sẽ nhận
-- được thông báo của toàn tổ chức — đó là lý do §E.1 ghi "CHỈ bật sau khi §A đã lên prod".
--
-- Frontend chỉ dùng sự kiện làm TÍN HIỆU invalidate cache (useNotificationsRealtime), không
-- đọc payload, nên không cần đổi REPLICA IDENTITY (mặc định 'd' đủ cho INSERT: WAL chứa
-- toàn bộ dòng mới, filter user_id=eq.<uid> hoạt động).
--
-- Idempotent theo đúng khuôn 20260726030000_business_performance_realtime_sources.sql:
-- advisory lock khoá theo timestamp migration (chống hai writer cùng sửa publication) +
-- kiểm tra pg_publication_tables trước khi ALTER (ALTER PUBLICATION không có IF NOT EXISTS).

BEGIN;

-- Khoá riêng cho migration này, tự nhả khi transaction kết thúc.
SELECT pg_advisory_xact_lock(20260729180000::bigint);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'notifications'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications';
  END IF;
END $$;

COMMIT;
