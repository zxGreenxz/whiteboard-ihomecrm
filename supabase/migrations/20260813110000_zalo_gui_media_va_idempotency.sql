-- =============================================================================
-- Chat Zalo — gửi MEDIA từ web + idempotency gửi tin + hạ tầng job async.
--
-- Bốn bài học từ đặc tả WEB2 (docs/superpowers/plans/ZALO-WEB2-FEATURE-SPEC.md
-- §13) được cài vào schema ở đây:
--   • §13.15/16 — cli_msg_id phải là khoá idempotency THẬT: cột riêng
--     client_dedup_key + unique partial index theo hội thoại. KHÔNG dùng cột
--     cli_msg_id sẵn có vì worker GHI ĐÈ nó bằng cid của zca sau khi gửi
--     (worker/index.js) — một cột không thể vừa là khoá chống trùng vừa bị
--     ghi đè.
--   • §13.17 — reply thật cần object quote THÔ (uidFrom/ts/msgType/content):
--     cột zalo_raw lưu subset thô của tin inbound để dựng quote khi trả lời.
--   • §13.12 — zca upload media lên CDN Zalo nhưng KHÔNG trả URL → media
--     SHOP GỬI phải tự host (bucket private `zalo-media`, đường dẫn
--     <account_id>/<conversation_id>/<file>), media_url lưu URL tự host để
--     reload vẫn render được vĩnh viễn.
--   • §13.22 — 2 instance worker "đấu" phiên → kick 3000/3003 vô hạn: bảng
--     lease đơn-instance zalo_worker_lease (chỉ service_role).
--
-- Job async trả kết quả (find_user, sticker_list — M3): cột result/not_before
-- trên zalo_send_queue; FE poll dòng queue theo id qua RLS org — CỐ Ý không
-- thêm channel realtime nào (giữ nguyên contracts/surfaces/realtime-surface.json).
-- Idempotent. Chạy SAU 20260813100000 (org-scoped foundation).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Cột mới
-- ---------------------------------------------------------------------------
ALTER TABLE public.zalo_messages DROP CONSTRAINT IF EXISTS zalo_messages_msg_type_check;
ALTER TABLE public.zalo_messages ADD CONSTRAINT zalo_messages_msg_type_check
  CHECK (msg_type IN ('text','image','file','sticker','sys','video','voice'));

ALTER TABLE public.zalo_messages ADD COLUMN IF NOT EXISTS client_dedup_key text;
ALTER TABLE public.zalo_messages ADD COLUMN IF NOT EXISTS zalo_raw jsonb;
COMMENT ON COLUMN public.zalo_messages.client_dedup_key IS
  'Khoá idempotency do client sinh (crypto.randomUUID). Unique theo hội thoại — retry/double-click cùng khoá trả dòng cũ, không gửi lần 2.';
COMMENT ON COLUMN public.zalo_messages.zalo_raw IS
  'Subset THÔ của tin inbound từ zca ({uidFrom,ts,msgType,content≤2KB}) — đủ dựng object quote khi reply. Chỉ ghi cho tin có zalo_msg_id.';

CREATE UNIQUE INDEX IF NOT EXISTS zalo_messages_client_dedup_uidx
  ON public.zalo_messages(conversation_id, client_dedup_key)
  WHERE client_dedup_key IS NOT NULL;

ALTER TABLE public.zalo_conversations ADD COLUMN IF NOT EXISTS marked_unread boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.zalo_conversations.marked_unread IS 'Đánh dấu chưa đọc THỦ CÔNG (khác unread_count do tin đến). zalo_mark_read xoá cờ này.';

ALTER TABLE public.zalo_send_queue ADD COLUMN IF NOT EXISTS result jsonb;
ALTER TABLE public.zalo_send_queue ADD COLUMN IF NOT EXISTS not_before timestamptz;
COMMENT ON COLUMN public.zalo_send_queue.result IS 'Kết quả job async (find_user → {conversation_id}, sticker_list → [...]). FE poll dòng này theo id qua RLS org.';
COMMENT ON COLUMN public.zalo_send_queue.not_before IS 'Worker bỏ qua job chưa tới giờ — chỗ neo cho retry/backoff sau này.';

-- ---------------------------------------------------------------------------
-- 2. Lease đơn-instance cho worker (chỉ service_role — không policy, không grant
--    authenticated, không realtime; RLS bật để mặc định-từ-chối mọi role khác)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.zalo_worker_lease (
  id           text PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
  instance_id  uuid NOT NULL,
  hostname     text,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  claimed_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.zalo_worker_lease IS
  'Khoá đơn-instance của worker zca-js: 2 instance cùng chạy sẽ luân phiên đá phiên Zalo của nhau (close 3000/3003). Chỉ service_role đụng vào.';
ALTER TABLE public.zalo_worker_lease ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zalo_worker_lease FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zalo_worker_lease TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Bucket media tự host cho chiều GỬI (private, 25MB/file)
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('zalo-media', 'zalo-media', false, 26214400)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = excluded.file_size_limit;

-- Upload: người có chat_zalo.send trong org của TÀI KHOẢN nằm ở thư mục gốc path.
-- Path bắt buộc: <account_id>/<conversation_id>/<file>
DROP POLICY IF EXISTS "zalo media upload theo org" ON storage.objects;
CREATE POLICY "zalo media upload theo org"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'zalo-media'
    AND EXISTS (
      SELECT 1 FROM public.zalo_accounts a
       WHERE a.id::text = (storage.foldername(name))[1]
         AND ((SELECT public.is_super_admin())
              OR a.organization_id IN (SELECT public.zalo_authorized_org_ids('send')))
    )
  );

-- Đọc: người có chat_zalo.view trong org của tài khoản đó (signed URL cũng đi
-- qua policy này khi tạo từ client).
DROP POLICY IF EXISTS "zalo media doc theo org" ON storage.objects;
CREATE POLICY "zalo media doc theo org"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'zalo-media'
    AND EXISTS (
      SELECT 1 FROM public.zalo_accounts a
       WHERE a.id::text = (storage.foldername(name))[1]
         AND ((SELECT public.is_super_admin())
              OR a.organization_id IN (SELECT public.zalo_authorized_org_ids('view')))
    )
  );

-- ---------------------------------------------------------------------------
-- 4. zalo_send_message — thêm mentions + reply thật + idempotency
--    (DROP chữ ký cũ để tránh nhập nhằng overload trên PostgREST)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.zalo_send_message(uuid, text, text, text, jsonb, text);
CREATE FUNCTION public.zalo_send_message(
  p_conversation_id     uuid,
  p_type                text  DEFAULT 'text',
  p_body                text  DEFAULT NULL,
  p_media_url           text  DEFAULT NULL,
  p_reply_to            jsonb DEFAULT NULL,
  p_cli_msg_id          text  DEFAULT NULL,
  p_mentions            jsonb DEFAULT NULL,
  p_reply_to_message_id uuid  DEFAULT NULL
)
RETURNS public.zalo_messages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_conv    public.zalo_conversations;
  v_msg     public.zalo_messages;
  v_orig    public.zalo_messages;
  v_channel text;
  v_dedup   text := NULLIF(btrim(COALESCE(p_cli_msg_id, '')), '');
  v_payload jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_conv FROM public.zalo_conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hội thoại không tồn tại';
  END IF;

  IF NOT public.zalo_can('send', v_conv.organization_id) THEN
    RAISE EXCEPTION 'Bạn không có quyền gửi tin Zalo trong tổ chức này' USING ERRCODE = '42501';
  END IF;

  -- Idempotency: cùng (hội thoại, cli id) → trả dòng cũ, KHÔNG enqueue lần 2.
  IF v_dedup IS NOT NULL THEN
    SELECT * INTO v_msg FROM public.zalo_messages
     WHERE conversation_id = p_conversation_id AND client_dedup_key = v_dedup;
    IF FOUND THEN RETURN v_msg; END IF;
  END IF;

  -- Reply THẬT: lấy nguyên liệu quote thô từ tin gốc (phải cùng hội thoại).
  IF p_reply_to_message_id IS NOT NULL THEN
    SELECT * INTO v_orig FROM public.zalo_messages
     WHERE id = p_reply_to_message_id AND conversation_id = p_conversation_id;
  END IF;

  SELECT COALESCE(kind, 'personal') INTO v_channel FROM public.zalo_accounts WHERE id = v_conv.account_id;
  v_channel := COALESCE(v_channel, 'personal');

  INSERT INTO public.zalo_messages(
    user_id, organization_id, conversation_id, account_id, direction, msg_type, body, media_url,
    reply_to, status, cli_msg_id, client_dedup_key, sent_by, sent_at
  ) VALUES (
    v_conv.user_id, v_conv.organization_id, p_conversation_id, v_conv.account_id, 'out', COALESCE(p_type,'text'),
    p_body, p_media_url, p_reply_to, 'pending', p_cli_msg_id, v_dedup, auth.uid(), now()
  )
  ON CONFLICT (conversation_id, client_dedup_key) WHERE client_dedup_key IS NOT NULL
  DO NOTHING
  RETURNING * INTO v_msg;

  -- Thua cuộc đua với một request song song cùng cli id → trả dòng thắng cuộc.
  IF v_msg.id IS NULL THEN
    SELECT * INTO v_msg FROM public.zalo_messages
     WHERE conversation_id = p_conversation_id AND client_dedup_key = v_dedup;
    RETURN v_msg;
  END IF;

  UPDATE public.zalo_conversations
     SET last_message_text = COALESCE(NULLIF(p_body,''), CASE WHEN p_type='image' THEN '[Hình ảnh]' ELSE last_message_text END),
         last_message_at   = now(),
         last_message_dir  = 'out',
         updated_at        = now()
   WHERE id = p_conversation_id;

  v_payload := jsonb_build_object(
    'type', COALESCE(p_type,'text'),
    'body', p_body,
    'media_url', p_media_url,
    'reply_to', p_reply_to
  );
  IF p_mentions IS NOT NULL AND jsonb_typeof(p_mentions) = 'array' AND jsonb_array_length(p_mentions) > 0 THEN
    v_payload := v_payload || jsonb_build_object('mentions', p_mentions);
  END IF;
  IF v_orig.id IS NOT NULL THEN
    v_payload := v_payload || jsonb_build_object(
      'target_msg_id',     v_orig.zalo_msg_id,
      'target_cli_msg_id', v_orig.cli_msg_id,
      'target_raw',        v_orig.zalo_raw,
      'target_body',       left(COALESCE(v_orig.body,''), 200)
    );
  END IF;

  INSERT INTO public.zalo_send_queue(user_id, organization_id, conversation_id, message_id, account_id, channel, payload, status)
  VALUES (v_conv.user_id, v_conv.organization_id, p_conversation_id, v_msg.id, v_conv.account_id, v_channel, v_payload, 'queued');

  RETURN v_msg;
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_send_message(uuid, text, text, text, jsonb, text, jsonb, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_send_message(uuid, text, text, text, jsonb, text, jsonb, uuid) FROM anon;

-- ---------------------------------------------------------------------------
-- 5. zalo_send_media — ảnh (album ≤12) / file / voice / sticker
--    N dòng message + MỘT job (giữ nhịp rải anti-spam của worker cho cả album)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_send_media(
  p_conversation_id uuid,
  p_kind            text,
  p_media           jsonb DEFAULT '[]'::jsonb,  -- [{url,path,mime,size,filename,width,height,duration_ms}]
  p_caption         text  DEFAULT NULL,
  p_cli_msg_id      text  DEFAULT NULL,
  p_sticker         jsonb DEFAULT NULL          -- {id,cateId,type}
)
RETURNS SETOF public.zalo_messages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_conv     public.zalo_conversations;
  v_channel  text;
  v_dedup    text := NULLIF(btrim(COALESCE(p_cli_msg_id, '')), '');
  v_ids      uuid[] := '{}';
  v_msg      public.zalo_messages;
  v_item     jsonb;
  v_i        int := 0;
  v_count    int;
  v_type     text;
  v_preview  text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('image','file','voice','sticker') THEN
    RAISE EXCEPTION 'Loại media không hỗ trợ: %', p_kind;
  END IF;

  SELECT * INTO v_conv FROM public.zalo_conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hội thoại không tồn tại'; END IF;
  IF NOT public.zalo_can('send', v_conv.organization_id) THEN
    RAISE EXCEPTION 'Bạn không có quyền gửi tin Zalo trong tổ chức này' USING ERRCODE = '42501';
  END IF;

  -- Idempotency cấp lô: cùng (hội thoại, cli id) → trả lại đúng lô cũ.
  IF v_dedup IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.zalo_messages
                WHERE conversation_id = p_conversation_id AND client_dedup_key = v_dedup) THEN
      RETURN QUERY
        SELECT m.* FROM public.zalo_messages m
         WHERE m.conversation_id = p_conversation_id
           AND (m.client_dedup_key = v_dedup OR m.client_dedup_key LIKE v_dedup || ':%')
         ORDER BY m.created_at;
      RETURN;
    END IF;
  END IF;

  v_count := CASE WHEN p_kind = 'sticker' THEN 1
                  ELSE COALESCE(jsonb_array_length(p_media), 0) END;
  IF p_kind = 'sticker' THEN
    IF p_sticker IS NULL OR p_sticker->>'id' IS NULL THEN
      RAISE EXCEPTION 'Thiếu sticker';
    END IF;
  ELSE
    IF v_count < 1 THEN RAISE EXCEPTION 'Chưa có tệp nào'; END IF;
    IF p_kind = 'image' AND v_count > 12 THEN RAISE EXCEPTION 'Tối đa 12 ảnh mỗi lần gửi'; END IF;
    IF p_kind IN ('file','voice') AND v_count > 1 THEN RAISE EXCEPTION 'Chỉ gửi được 1 tệp mỗi lần'; END IF;
  END IF;

  v_type    := CASE p_kind WHEN 'sticker' THEN 'sticker' WHEN 'voice' THEN 'voice'
                           WHEN 'file' THEN 'file' ELSE 'image' END;
  v_preview := CASE p_kind WHEN 'sticker' THEN '[Sticker]' WHEN 'voice' THEN '[Tin nhắn thoại]'
                           WHEN 'file' THEN '[Tệp đính kèm]' ELSE '[Hình ảnh]' END;

  SELECT COALESCE(kind, 'personal') INTO v_channel FROM public.zalo_accounts WHERE id = v_conv.account_id;
  v_channel := COALESCE(v_channel, 'personal');

  IF p_kind = 'sticker' THEN
    INSERT INTO public.zalo_messages(
      user_id, organization_id, conversation_id, account_id, direction, msg_type, body,
      media_meta, status, client_dedup_key, sent_by, sent_at)
    VALUES (v_conv.user_id, v_conv.organization_id, p_conversation_id, v_conv.account_id, 'out', 'sticker', '[Sticker]',
            p_sticker, 'pending', v_dedup, auth.uid(), now())
    RETURNING * INTO v_msg;
    v_ids := array_append(v_ids, v_msg.id);
    RETURN NEXT v_msg;
  ELSE
    FOR v_item IN SELECT jsonb_array_elements(p_media) LOOP
      IF v_item->>'url' IS NULL THEN RAISE EXCEPTION 'Tệp thứ % thiếu url', v_i + 1; END IF;
      IF COALESCE((v_item->>'size')::bigint, 0) > 26214400 THEN
        RAISE EXCEPTION 'Tệp "%" vượt 25MB', COALESCE(v_item->>'filename', v_i + 1::text);
      END IF;
      INSERT INTO public.zalo_messages(
        user_id, organization_id, conversation_id, account_id, direction, msg_type, body,
        media_url, media_meta, status, client_dedup_key, sent_by, sent_at)
      VALUES (v_conv.user_id, v_conv.organization_id, p_conversation_id, v_conv.account_id, 'out', v_type,
              CASE WHEN v_i = 0 THEN NULLIF(btrim(COALESCE(p_caption,'')), '') END,
              v_item->>'url',
              v_item - 'url',
              'pending',
              CASE WHEN v_dedup IS NULL THEN NULL
                   WHEN v_i = 0 THEN v_dedup
                   ELSE v_dedup || ':' || v_i END,
              auth.uid(), now())
      RETURNING * INTO v_msg;
      v_ids := array_append(v_ids, v_msg.id);
      v_i := v_i + 1;
      RETURN NEXT v_msg;
    END LOOP;
  END IF;

  UPDATE public.zalo_conversations
     SET last_message_text = COALESCE(NULLIF(btrim(COALESCE(p_caption,'')), ''), v_preview),
         last_message_at   = now(),
         last_message_dir  = 'out',
         updated_at        = now()
   WHERE id = p_conversation_id;

  INSERT INTO public.zalo_send_queue(user_id, organization_id, conversation_id, message_id, account_id, channel, payload, status)
  VALUES (v_conv.user_id, v_conv.organization_id, p_conversation_id, v_ids[1], v_conv.account_id, v_channel,
          jsonb_build_object(
            'type', v_type,
            'body', NULLIF(btrim(COALESCE(p_caption,'')), ''),
            'attachments', CASE WHEN p_kind = 'sticker' THEN '[]'::jsonb ELSE p_media END,
            'sticker', p_sticker,
            'message_ids', to_jsonb(v_ids)
          ),
          'queued');

  RETURN;
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_send_media(uuid, text, jsonb, text, text, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_send_media(uuid, text, jsonb, text, text, jsonb) FROM anon;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  ORG_DEMO constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_uid  uuid;
  v_acc  uuid;
  v_conv uuid;
  v_m1   uuid;
  v_n    bigint;
BEGIN
  -- (a) hạ tầng có mặt
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'zalo-media' AND public = false) THEN
    RAISE EXCEPTION 'Bucket zalo-media chưa tồn tại hoặc đang public. DỪNG.';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
       AND policyname IN ('zalo media upload theo org','zalo media doc theo org')) <> 2 THEN
    RAISE EXCEPTION 'Thiếu policy storage cho zalo-media. DỪNG.';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE tablename = 'zalo_worker_lease') <> 0 THEN
    RAISE EXCEPTION 'zalo_worker_lease không được có policy nào (chỉ service_role bypass). DỪNG.';
  END IF;

  -- (b) idempotency ở tầng dữ liệu: 2 dòng cùng (conversation, dedup key) phải bị chặn
  SELECT m.user_id INTO v_uid
    FROM public.organization_memberships m
   WHERE m.organization_id = ORG_DEMO AND m.status = 'ACTIVE'
   ORDER BY m.user_id LIMIT 1;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Không có người dùng org DEMO. DỪNG.'; END IF;

  INSERT INTO public.zalo_accounts(user_id, organization_id, kind, name, status)
  VALUES (v_uid, ORG_DEMO, 'personal', 'ZZ nghiệm thu M2', 'disconnected') RETURNING id INTO v_acc;
  INSERT INTO public.zalo_conversations(user_id, account_id, thread_id, peer_name)
  VALUES (v_uid, v_acc, 'zz_nghiem_thu_m2', 'ZZ M2') RETURNING id INTO v_conv;

  INSERT INTO public.zalo_messages(user_id, conversation_id, account_id, direction, msg_type, body, status, client_dedup_key)
  VALUES (v_uid, v_conv, v_acc, 'out', 'text', 'lần 1', 'pending', 'zz-dedup-1') RETURNING id INTO v_m1;
  BEGIN
    INSERT INTO public.zalo_messages(user_id, conversation_id, account_id, direction, msg_type, body, status, client_dedup_key)
    VALUES (v_uid, v_conv, v_acc, 'out', 'text', 'lần 2', 'pending', 'zz-dedup-1');
    RAISE EXCEPTION 'Chèn được 2 tin cùng client_dedup_key trong 1 hội thoại. DỪNG.';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- (c) msg_type mới 'voice' hợp lệ
  INSERT INTO public.zalo_messages(user_id, conversation_id, account_id, direction, msg_type, body, status)
  VALUES (v_uid, v_conv, v_acc, 'out', 'voice', '[Tin nhắn thoại]', 'pending');

  -- dọn fixture (messages CASCADE theo conversation)
  DELETE FROM public.zalo_conversations WHERE id = v_conv;
  DELETE FROM public.zalo_accounts WHERE id = v_acc;

  -- (d) hai RPC tồn tại đúng chữ ký
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'zalo_send_message';
  IF v_n <> 1 THEN RAISE EXCEPTION 'zalo_send_message phải có ĐÚNG 1 bản (thấy %) — overload thừa làm PostgREST nhập nhằng. DỪNG.', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'zalo_send_media') THEN
    RAISE EXCEPTION 'Thiếu zalo_send_media. DỪNG.';
  END IF;

  RAISE NOTICE 'Nghiệm thu M2 đạt: bucket + policy storage, lease kín, dedup unique hoạt động, voice hợp lệ, RPC đủ.';
END
$nghiem_thu$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- =============================================================================
-- ROLLBACK (tay): DROP FUNCTION zalo_send_media; dựng lại zalo_send_message
-- chữ ký 6 tham số (bản 20260813100000); DROP INDEX zalo_messages_client_dedup_uidx;
-- ALTER TABLE zalo_messages DROP COLUMN client_dedup_key, zalo_raw; DROP COLUMN
-- zalo_conversations.marked_unread; DROP COLUMN zalo_send_queue.result/not_before;
-- DROP TABLE zalo_worker_lease; DROP 2 policy storage + DELETE bucket zalo-media
-- (sau khi dọn object); khôi phục CHECK msg_type không có 'voice'.
-- =============================================================================
