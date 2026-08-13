-- =============================================================================
-- Chat Zalo — bộ RPC tiện ích: pin/mute/đánh dấu chưa đọc, soạn tin theo SĐT,
-- xoá phía mình, seen/typing outbound, CRUD mẫu tin, tìm sticker.
--
-- Nguyên tắc chung (nối tiếp 20260813100000 + 110000):
--   • Mọi guard đi qua public.zalo_can(action, org) — RBAC v3 theo tổ chức.
--   • Job async (find_user / sticker_list) trả kết quả qua cột
--     zalo_send_queue.result; FE poll dòng queue theo id qua RLS org — KHÔNG
--     thêm channel realtime nào.
--   • "Xoá phía mình" là ẩn ở PHÍA SHOP (cả khu chat của công ty) — cột
--     hidden_at; KHÔNG xoá dòng để giữ lịch sử đối soát.
-- Idempotent.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. Chuẩn hoá SĐT Việt Nam về dạng 0xxxxxxxxx (IMMUTABLE — dùng được cho index)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phone_digits(p text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT NULLIF(
    CASE
      WHEN d = '' THEN ''
      WHEN d LIKE '84%' AND length(d) >= 10 THEN '0' || substr(d, 3)
      ELSE d
    END, '')
  FROM (SELECT regexp_replace(COALESCE(p, ''), '\D', '', 'g') AS d) s;
$$;
COMMENT ON FUNCTION public.phone_digits(text) IS
  'Bỏ mọi ký tự không phải số, 84xxxxxxxxx → 0xxxxxxxxx. Dùng cho match SĐT Zalo ↔ CRM và index biểu thức.';
GRANT EXECUTE ON FUNCTION public.phone_digits(text) TO authenticated, service_role;

ALTER TABLE public.zalo_messages ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
COMMENT ON COLUMN public.zalo_messages.hidden_at IS 'Tin đã "xoá phía mình" (ẩn khỏi khu chat của công ty, vẫn giữ dòng để đối soát).';

-- ---------------------------------------------------------------------------
-- 1. Ghim / tắt thông báo / đánh dấu chưa đọc — chỉ đổi cột KHÔNG NULL
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_set_conversation_flags(
  p_conversation_id uuid,
  p_pinned          boolean DEFAULT NULL,
  p_muted           boolean DEFAULT NULL,
  p_marked_unread   boolean DEFAULT NULL
)
RETURNS public.zalo_conversations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_conv public.zalo_conversations;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_conv FROM public.zalo_conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hội thoại không tồn tại'; END IF;
  IF NOT public.zalo_can('view', v_conv.organization_id) THEN
    RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE = '42501';
  END IF;
  UPDATE public.zalo_conversations
     SET is_pinned     = COALESCE(p_pinned, is_pinned),
         is_muted      = COALESCE(p_muted, is_muted),
         marked_unread = COALESCE(p_marked_unread, marked_unread),
         updated_at    = now()
   WHERE id = p_conversation_id
   RETURNING * INTO v_conv;
  RETURN v_conv;
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_set_conversation_flags(uuid, boolean, boolean, boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_set_conversation_flags(uuid, boolean, boolean, boolean) FROM anon;

-- zalo_mark_read xoá luôn cờ đánh-dấu-chưa-đọc thủ công
CREATE OR REPLACE FUNCTION public.zalo_mark_read(p_conversation_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_org uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  SELECT organization_id INTO v_org FROM public.zalo_conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT public.zalo_can('view', v_org) THEN
    RAISE EXCEPTION 'Bạn không có quyền xem hội thoại này' USING ERRCODE = '42501';
  END IF;
  UPDATE public.zalo_conversations
     SET unread_count = 0, marked_unread = false, updated_at = now()
   WHERE id = p_conversation_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Xoá phía mình (ẩn khỏi khu chat công ty + deleteForMe trên Zalo nếu được)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_delete_message_for_me(p_message_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE m public.zalo_messages; c public.zalo_conversations;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT * INTO m FROM public.zalo_messages WHERE id = p_message_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tin nhắn không tồn tại'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id = m.conversation_id;
  IF NOT public.zalo_can('send', c.organization_id) THEN
    RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE = '42501';
  END IF;

  UPDATE public.zalo_messages SET hidden_at = now() WHERE id = p_message_id;

  -- Tin đã có mặt trên Zalo thì nhờ worker deleteForMe; tin pending/failed thì thôi.
  IF m.zalo_msg_id IS NOT NULL THEN
    INSERT INTO public.zalo_send_queue(user_id, organization_id, conversation_id, account_id, channel, payload, status)
    VALUES (c.user_id, c.organization_id, c.id, c.account_id, 'personal',
      jsonb_build_object('action','delete_for_me',
        'target_msg_id', m.zalo_msg_id, 'target_cli_msg_id', m.cli_msg_id,
        'target_uid_from', CASE WHEN m.direction = 'in' THEN m.zalo_raw->>'uidFrom' END,
        'thread_id', c.thread_id, 'thread_type', c.thread_type),
      'queued');
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_delete_message_for_me(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_delete_message_for_me(uuid) FROM anon;

-- ---------------------------------------------------------------------------
-- 3. Soạn tin mới theo SĐT — async qua worker (zca findUser cần phiên sống)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_start_chat_by_phone(p_account_id uuid, p_phone text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_acc    public.zalo_accounts;
  v_digits text := public.phone_digits(p_phone);
  v_conv   uuid;
  v_job    uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  IF v_digits IS NULL OR length(v_digits) < 9 THEN
    RAISE EXCEPTION 'Số điện thoại không hợp lệ';
  END IF;
  SELECT * INTO v_acc FROM public.zalo_accounts WHERE id = p_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tài khoản không tồn tại'; END IF;
  IF NOT public.zalo_can('send', v_acc.organization_id) THEN
    RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE = '42501';
  END IF;

  -- Đã có hội thoại 1-1 cùng SĐT trên account này → trả luôn.
  SELECT id INTO v_conv FROM public.zalo_conversations
   WHERE account_id = p_account_id AND thread_type = 'user'
     AND public.phone_digits(peer_phone) = v_digits
   ORDER BY last_message_at DESC NULLS LAST LIMIT 1;
  IF v_conv IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'ready', 'conversation_id', v_conv);
  END IF;

  IF v_acc.status <> 'connected' THEN
    RAISE EXCEPTION 'Tài khoản Zalo chưa kết nối — kết nối lại trước khi soạn tin mới';
  END IF;

  INSERT INTO public.zalo_send_queue(user_id, organization_id, account_id, channel, payload, status)
  VALUES (v_acc.user_id, v_acc.organization_id, p_account_id, 'personal',
          jsonb_build_object('action','find_user','phone', v_digits), 'queued')
  RETURNING id INTO v_job;

  RETURN jsonb_build_object('status', 'pending', 'job_id', v_job);
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_start_chat_by_phone(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_start_chat_by_phone(uuid, text) FROM anon;

-- ---------------------------------------------------------------------------
-- 4. Seen / typing outbound — best-effort (worker poll 2s nên trễ ≤2s, chấp nhận)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_send_seen(p_conversation_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE c public.zalo_conversations; v_last text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT public.zalo_can('view', c.organization_id) THEN
    RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE = '42501';
  END IF;
  SELECT zalo_msg_id INTO v_last FROM public.zalo_messages
   WHERE conversation_id = p_conversation_id AND direction = 'in' AND zalo_msg_id IS NOT NULL
   ORDER BY created_at DESC LIMIT 1;
  IF v_last IS NULL THEN RETURN; END IF;
  INSERT INTO public.zalo_send_queue(user_id, organization_id, conversation_id, account_id, channel, payload, status)
  VALUES (c.user_id, c.organization_id, c.id, c.account_id, 'personal',
          jsonb_build_object('action','seen','thread_id',c.thread_id,'thread_type',c.thread_type,'target_msg_id',v_last),
          'queued');
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_send_seen(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_send_seen(uuid) FROM anon;

CREATE OR REPLACE FUNCTION public.zalo_send_typing(p_conversation_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE c public.zalo_conversations;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT public.zalo_can('send', c.organization_id) THEN RETURN; END IF; -- best-effort, không nổ
  -- Chống dồn job: 1 job typing / hội thoại đang chờ là đủ.
  IF EXISTS (SELECT 1 FROM public.zalo_send_queue
              WHERE conversation_id = p_conversation_id AND status = 'queued'
                AND payload->>'action' = 'typing') THEN
    RETURN;
  END IF;
  INSERT INTO public.zalo_send_queue(user_id, organization_id, conversation_id, account_id, channel, payload, status)
  VALUES (c.user_id, c.organization_id, c.id, c.account_id, 'personal',
          jsonb_build_object('action','typing','thread_id',c.thread_id,'thread_type',c.thread_type),
          'queued');
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_send_typing(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_send_typing(uuid) FROM anon;

-- ---------------------------------------------------------------------------
-- 5. CRUD mẫu tin (nguồn sự thật là DB — không đồng bộ 2 chiều quick message Zalo)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_save_template(
  p_title           text,
  p_body            text,
  p_id              uuid DEFAULT NULL,
  p_category        text DEFAULT NULL,
  p_color           text DEFAULT NULL,
  p_sort_order      int  DEFAULT 0,
  p_is_active       boolean DEFAULT true,
  p_organization_id uuid DEFAULT NULL
)
RETURNS public.zalo_message_templates
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row  public.zalo_message_templates;
  v_org  uuid;
  v_orgs uuid[];
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  IF btrim(COALESCE(p_title,'')) = '' THEN RAISE EXCEPTION 'Tiêu đề trống'; END IF;
  IF btrim(COALESCE(p_body,'')) = '' THEN RAISE EXCEPTION 'Nội dung trống'; END IF;

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_row FROM public.zalo_message_templates WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Mẫu tin không tồn tại'; END IF;
    IF NOT public.zalo_can('manage_templates', v_row.organization_id) THEN
      RAISE EXCEPTION 'Bạn không có quyền quản lý mẫu tin' USING ERRCODE = '42501';
    END IF;
    UPDATE public.zalo_message_templates
       SET title = btrim(p_title), body = p_body, category = p_category, color = p_color,
           sort_order = COALESCE(p_sort_order, sort_order), is_active = COALESCE(p_is_active, is_active),
           updated_at = now()
     WHERE id = p_id RETURNING * INTO v_row;
    RETURN v_row;
  END IF;

  IF p_organization_id IS NOT NULL THEN
    IF NOT public.zalo_can('manage_templates', p_organization_id) THEN
      RAISE EXCEPTION 'Bạn không có quyền quản lý mẫu tin trong tổ chức này' USING ERRCODE = '42501';
    END IF;
    v_org := p_organization_id;
  ELSE
    SELECT array_agg(o) INTO v_orgs FROM public.zalo_authorized_org_ids('manage_templates') o;
    IF v_orgs IS NULL OR array_length(v_orgs, 1) IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'Không xác định được tổ chức — truyền p_organization_id.' USING ERRCODE = '23502';
    END IF;
    v_org := v_orgs[1];
  END IF;

  INSERT INTO public.zalo_message_templates(user_id, organization_id, title, body, category, color, sort_order, is_active)
  VALUES (auth.uid(), v_org, btrim(p_title), p_body, p_category, p_color, COALESCE(p_sort_order, 0), COALESCE(p_is_active, true))
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_save_template(text, text, uuid, text, text, int, boolean, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_save_template(text, text, uuid, text, text, int, boolean, uuid) FROM anon;

CREATE OR REPLACE FUNCTION public.zalo_delete_template(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_org uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT organization_id INTO v_org FROM public.zalo_message_templates WHERE id = p_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT public.zalo_can('manage_templates', v_org) THEN
    RAISE EXCEPTION 'Bạn không có quyền quản lý mẫu tin' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.zalo_message_templates WHERE id = p_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_delete_template(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_delete_template(uuid) FROM anon;

-- ---------------------------------------------------------------------------
-- 6. Tìm sticker — async qua worker (zca getStickers), kết quả về queue.result
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_sticker_search(p_account_id uuid, p_keyword text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_acc public.zalo_accounts; v_job uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  IF btrim(COALESCE(p_keyword,'')) = '' THEN RAISE EXCEPTION 'Từ khoá trống'; END IF;
  SELECT * INTO v_acc FROM public.zalo_accounts WHERE id = p_account_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tài khoản không tồn tại'; END IF;
  IF NOT public.zalo_can('send', v_acc.organization_id) THEN
    RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE = '42501';
  END IF;
  IF v_acc.status <> 'connected' THEN
    RAISE EXCEPTION 'Tài khoản Zalo chưa kết nối';
  END IF;
  INSERT INTO public.zalo_send_queue(user_id, organization_id, account_id, channel, payload, status)
  VALUES (v_acc.user_id, v_acc.organization_id, p_account_id, 'personal',
          jsonb_build_object('action','sticker_list','keyword', left(btrim(p_keyword), 60)), 'queued')
  RETURNING id INTO v_job;
  RETURN jsonb_build_object('status', 'pending', 'job_id', v_job);
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_sticker_search(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_sticker_search(uuid, text) FROM anon;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE v_bad int;
BEGIN
  -- phone_digits: đủ các dạng đầu vào
  IF public.phone_digits('+84 378 160 165') IS DISTINCT FROM '0378160165' THEN
    RAISE EXCEPTION 'phone_digits(+84…) sai: %', public.phone_digits('+84 378 160 165');
  END IF;
  IF public.phone_digits('0378-160-165') IS DISTINCT FROM '0378160165' THEN
    RAISE EXCEPTION 'phone_digits(0378-…) sai';
  END IF;
  IF public.phone_digits('84378160165') IS DISTINCT FROM '0378160165' THEN
    RAISE EXCEPTION 'phone_digits(84…) sai';
  END IF;
  IF public.phone_digits('abc') IS NOT NULL THEN
    RAISE EXCEPTION 'phone_digits(rác) phải NULL';
  END IF;
  IF public.phone_digits(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'phone_digits(NULL) phải NULL';
  END IF;

  -- đủ 8 RPC mới/cập nhật
  SELECT 8 - count(DISTINCT p.proname) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('zalo_set_conversation_flags','zalo_mark_read','zalo_delete_message_for_me',
                       'zalo_start_chat_by_phone','zalo_send_seen','zalo_send_typing',
                       'zalo_save_template','zalo_delete_template');
  IF v_bad <> 0 THEN RAISE EXCEPTION 'Thiếu % RPC tiện ích. DỪNG.', v_bad; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='zalo_sticker_search') THEN
    RAISE EXCEPTION 'Thiếu zalo_sticker_search. DỪNG.';
  END IF;

  RAISE NOTICE 'Nghiệm thu M3 đạt: phone_digits chuẩn, đủ 9 RPC tiện ích.';
END
$nghiem_thu$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- =============================================================================
-- ROLLBACK (tay): DROP 8 hàm mới (giữ zalo_mark_read bản 20260813100000),
-- DROP COLUMN zalo_messages.hidden_at, DROP FUNCTION phone_digits (sau khi M4
-- rollback trước vì index M4 phụ thuộc).
-- =============================================================================
