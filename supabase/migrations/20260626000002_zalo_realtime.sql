-- =============================================================
-- Chat Zalo — bật Supabase Realtime cho conversations + messages.
-- App subscribe postgres_changes để cập nhật danh sách & luồng tin tức thì
-- (worker zca-js ghi inbound vào DB → Realtime đẩy sang browser).
-- Idempotent (chỉ ADD nếu chưa có trong publication).
-- =============================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'zalo_conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.zalo_conversations;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'zalo_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.zalo_messages;
  END IF;
END $$;

COMMIT;
