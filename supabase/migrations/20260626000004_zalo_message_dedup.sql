-- =============================================================
-- Chat Zalo — chống trùng tin nhắn khi đồng bộ (worker requestOldMessages →
-- old_messages có thể đẩy lại tin đã có). Unique theo (account_id, zalo_msg_id);
-- zalo_msg_id NULL (phiếu đang gửi / tin chưa có id) vẫn cho phép nhiều dòng vì
-- NULL là DISTINCT trong unique index Postgres.
-- Idempotent.
-- =============================================================

BEGIN;

-- Dọn '' về NULL (không coi chuỗi rỗng là id thật) để index không đụng nhau
UPDATE public.zalo_messages SET zalo_msg_id = NULL WHERE zalo_msg_id = '';

-- Dọn bản trùng (giữ dòng mới nhất theo created_at) trước khi tạo unique
DELETE FROM public.zalo_messages a
USING public.zalo_messages b
WHERE a.id < b.id
  AND a.account_id = b.account_id
  AND a.zalo_msg_id = b.zalo_msg_id
  AND a.zalo_msg_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS zalo_messages_acct_msgid_uniq
  ON public.zalo_messages(account_id, zalo_msg_id);

COMMIT;
