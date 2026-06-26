-- =============================================================
-- Chat Zalo — Broadcast/Chia sẻ: gửi 1 nội dung tới NHIỀU hội thoại (chọn theo
-- nhãn phân loại). Mỗi hội thoại = 1 message 'out' + 1 job trong zalo_send_queue;
-- worker gửi tuần tự (có rải nhịp chống spam). Idempotent.
-- =============================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.zalo_broadcast(p_conversation_ids uuid[], p_body text)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  c        public.zalo_conversations;
  v_msg_id uuid;
  v_count  int := 0;
  v_channel text;
  v_cid    uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  IF p_body IS NULL OR btrim(p_body) = '' THEN RAISE EXCEPTION 'Nội dung trống'; END IF;
  IF p_conversation_ids IS NULL OR array_length(p_conversation_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Chưa chọn hội thoại nào';
  END IF;

  FOREACH v_cid IN ARRAY p_conversation_ids LOOP
    SELECT * INTO c FROM public.zalo_conversations WHERE id = v_cid;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF NOT (c.user_id = auth.uid() OR public.zalo_can('send')) THEN CONTINUE; END IF;

    INSERT INTO public.zalo_messages(user_id, conversation_id, account_id, direction, msg_type, body, status, sent_by, sent_at)
    VALUES (c.user_id, c.id, c.account_id, 'out', 'text', p_body, 'pending', auth.uid(), now())
    RETURNING id INTO v_msg_id;

    UPDATE public.zalo_conversations
       SET last_message_text = p_body, last_message_at = now(), last_message_dir = 'out', updated_at = now()
     WHERE id = c.id;

    SELECT COALESCE(kind, 'personal') INTO v_channel FROM public.zalo_accounts WHERE id = c.account_id;
    INSERT INTO public.zalo_send_queue(user_id, conversation_id, message_id, account_id, channel, payload, status)
    VALUES (c.user_id, c.id, v_msg_id, c.account_id, COALESCE(v_channel, 'personal'),
            jsonb_build_object('type', 'text', 'body', p_body), 'queued');

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_broadcast(uuid[], text) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_broadcast(uuid[], text) FROM anon;

NOTIFY pgrst, 'reload schema';
COMMIT;
