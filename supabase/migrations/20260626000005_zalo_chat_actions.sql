-- =============================================================
-- Chat Zalo — RPC thao tác từ web: thả reaction, thu hồi, tải thêm tin cũ.
-- Đều ENQUEUE vào zalo_send_queue với payload.action; worker zca-js xử lý:
--   react        → api.addReaction
--   recall       → api.undo
--   load_history → api.getGroupChatHistory (chỉ NHÓM)
-- Idempotent.
-- =============================================================

BEGIN;

-- Thả reaction (cập nhật lạc quan reaction_emoji + enqueue)
CREATE OR REPLACE FUNCTION public.zalo_react_message(p_message_id uuid, p_emoji text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m public.zalo_messages; c public.zalo_conversations;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT * INTO m FROM public.zalo_messages WHERE id = p_message_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tin nhắn không tồn tại'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id = m.conversation_id;
  IF NOT (c.user_id = auth.uid() OR public.zalo_can('send')) THEN
    RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE = '42501';
  END IF;
  UPDATE public.zalo_messages SET reaction_emoji = p_emoji WHERE id = p_message_id;
  INSERT INTO public.zalo_send_queue(user_id, conversation_id, account_id, channel, payload, status)
  VALUES (c.user_id, c.id, c.account_id, 'personal',
    jsonb_build_object('action','react','emoji',p_emoji,'target_msg_id',m.zalo_msg_id,'target_cli_msg_id',m.cli_msg_id,'thread_id',c.thread_id,'thread_type',c.thread_type),
    'queued');
END; $$;
GRANT EXECUTE ON FUNCTION public.zalo_react_message(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_react_message(uuid, text) FROM anon;

-- Thu hồi tin của mình
CREATE OR REPLACE FUNCTION public.zalo_recall_message(p_message_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m public.zalo_messages; c public.zalo_conversations;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT * INTO m FROM public.zalo_messages WHERE id = p_message_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tin nhắn không tồn tại'; END IF;
  IF m.direction <> 'out' THEN RAISE EXCEPTION 'Chỉ thu hồi được tin do bạn gửi'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id = m.conversation_id;
  IF NOT (c.user_id = auth.uid() OR public.zalo_can('send')) THEN
    RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE = '42501';
  END IF;
  UPDATE public.zalo_messages SET body = '(Tin đã được thu hồi)', msg_type = 'sys', reaction_emoji = NULL WHERE id = p_message_id;
  INSERT INTO public.zalo_send_queue(user_id, conversation_id, account_id, channel, payload, status)
  VALUES (c.user_id, c.id, c.account_id, 'personal',
    jsonb_build_object('action','recall','target_msg_id',m.zalo_msg_id,'target_cli_msg_id',m.cli_msg_id,'thread_id',c.thread_id,'thread_type',c.thread_type),
    'queued');
END; $$;
GRANT EXECUTE ON FUNCTION public.zalo_recall_message(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_recall_message(uuid) FROM anon;

-- Tải thêm tin cũ (chỉ NHÓM — zca-js không có API lịch sử 1-1)
CREATE OR REPLACE FUNCTION public.zalo_load_history(p_conversation_id uuid, p_count int DEFAULT 50)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.zalo_conversations;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hội thoại không tồn tại'; END IF;
  IF c.thread_type <> 'group' THEN RAISE EXCEPTION 'Chỉ tải thêm được tin cũ của NHÓM'; END IF;
  IF NOT (c.user_id = auth.uid() OR public.zalo_can('view')) THEN
    RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.zalo_send_queue(user_id, conversation_id, account_id, channel, payload, status)
  VALUES (c.user_id, c.id, c.account_id, 'personal',
    jsonb_build_object('action','load_history','thread_id',c.thread_id,'thread_type',c.thread_type,'count',LEAST(COALESCE(p_count,50),200)),
    'queued');
END; $$;
GRANT EXECUTE ON FUNCTION public.zalo_load_history(uuid, int) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_load_history(uuid, int) FROM anon;

NOTIFY pgrst, 'reload schema';
COMMIT;
