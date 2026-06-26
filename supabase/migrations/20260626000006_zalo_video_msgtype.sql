-- =============================================================
-- Chat Zalo — cho phép msg_type='video' (tin video Zalo: href=URL video,
-- thumb=ảnh poster lưu trong media_meta). Idempotent.
-- =============================================================
BEGIN;
ALTER TABLE public.zalo_messages DROP CONSTRAINT IF EXISTS zalo_messages_msg_type_check;
ALTER TABLE public.zalo_messages ADD CONSTRAINT zalo_messages_msg_type_check
  CHECK (msg_type IN ('text','image','file','sticker','sys','video'));
COMMIT;
