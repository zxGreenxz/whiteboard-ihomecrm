-- =============================================================
-- Chat Zalo — schema (Supabase-native, không VPS cho phần web)
--
-- App chỉ nói chuyện với Supabase. Connector Zalo thật = worker zca-js
-- (chạy LOCAL trước, VPS sau) đọc zalo_send_queue + ghi zalo_messages bằng
-- service-role key. OA/ZNS để sau (cột zns_template_id/channel đã chừa).
--
-- Bảng: zalo_accounts, zalo_conversations, zalo_messages,
--        zalo_message_templates, zalo_automations, zalo_send_queue.
-- Quy ước: owner-scoped user_id (= auth.uid), RLS owner + staff + admin/super,
--          RPC SECURITY DEFINER có guard quyền chat_zalo.
-- Idempotent.
-- =============================================================

BEGIN;

-- ── zalo_accounts: tài khoản Zalo kết nối (personal / oa) ──
CREATE TABLE IF NOT EXISTS public.zalo_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal','oa')),
  name        text NOT NULL,
  zalo_uid    text,
  avatar_url  text,
  status      text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected','disconnected','error')),
  oa_id       text,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zalo_accounts_user_idx ON public.zalo_accounts(user_id);

-- ── zalo_conversations: 1 thread / (account, peer) ──
CREATE TABLE IF NOT EXISTS public.zalo_conversations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id        uuid REFERENCES public.zalo_accounts(id) ON DELETE SET NULL,
  thread_id         text,
  thread_type       text NOT NULL DEFAULT 'user' CHECK (thread_type IN ('user','group')),
  peer_name         text NOT NULL,
  peer_avatar_url   text,
  peer_phone        text,
  peer_zalo_uid     text,
  initials          text,
  tone              text NOT NULL DEFAULT 'emerald',
  kind              text NOT NULL DEFAULT 'unknown' CHECK (kind IN ('tenant','lead','broker','unknown')),
  customer_id       uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  lead_id           uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  contract_id       uuid REFERENCES public.contracts(id) ON DELETE SET NULL,
  room_id           uuid REFERENCES public.rooms(id) ON DELETE SET NULL,
  assigned_staff_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  sub_label         text,
  sub_tone          text,
  list_tag          jsonb,              -- {l,t} badge trạng thái ở danh sách
  header_tag        jsonb,              -- {l,t} badge ở đầu khung chat
  header_sub        text,
  profile           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- snapshot panel thông tin (room/debt/staff/tags…)
  last_message_text text,
  last_message_at   timestamptz,
  last_message_dir  text,
  unread_count      int NOT NULL DEFAULT 0,
  is_online         boolean NOT NULL DEFAULT false,
  is_pinned         boolean NOT NULL DEFAULT false,
  is_muted          boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, thread_id)
);
CREATE INDEX IF NOT EXISTS zalo_conversations_user_idx  ON public.zalo_conversations(user_id, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS zalo_conversations_staff_idx ON public.zalo_conversations(assigned_staff_id);

-- ── zalo_messages ──
CREATE TABLE IF NOT EXISTS public.zalo_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.zalo_conversations(id) ON DELETE CASCADE,
  account_id      uuid REFERENCES public.zalo_accounts(id) ON DELETE SET NULL,
  direction       text NOT NULL CHECK (direction IN ('in','out')),
  msg_type        text NOT NULL DEFAULT 'text' CHECK (msg_type IN ('text','image','file','sticker','sys')),
  body            text,
  media_url       text,
  media_label     text,
  media_tone      text,               -- gradient tile: neutral/room/warm
  media_meta      jsonb,
  reply_to        jsonb,              -- {name,text}
  reactions       jsonb NOT NULL DEFAULT '{}'::jsonb,
  reaction_emoji  text,               -- emoji hiển thị nhanh (demo 1 reaction)
  status          text NOT NULL DEFAULT 'sent' CHECK (status IN ('pending','sent','delivered','seen','failed')),
  zalo_msg_id     text,
  cli_msg_id      text,
  sent_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zalo_messages_conv_idx ON public.zalo_messages(conversation_id, created_at);

-- ── zalo_message_templates (Thư viện mẫu tin + ZNS) ──
CREATE TABLE IF NOT EXISTS public.zalo_message_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title           text NOT NULL,
  body            text,
  category        text,
  color           text,
  zns_template_id text,               -- để sau cho OA/ZNS
  variables       jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active       boolean NOT NULL DEFAULT true,
  sort_order      int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zalo_templates_user_idx ON public.zalo_message_templates(user_id);

-- ── zalo_automations (2 luồng: gửi ảnh trống + tự động trả lời) ──
CREATE TABLE IF NOT EXISTS public.zalo_automations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('broadcast_vacant','auto_reply')),
  enabled     boolean NOT NULL DEFAULT false,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind)
);

-- ── zalo_send_queue (hàng đợi gửi → worker zca-js đọc) ──
CREATE TABLE IF NOT EXISTS public.zalo_send_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.zalo_conversations(id) ON DELETE CASCADE,
  message_id      uuid REFERENCES public.zalo_messages(id) ON DELETE CASCADE,
  account_id      uuid REFERENCES public.zalo_accounts(id) ON DELETE SET NULL,
  channel         text NOT NULL DEFAULT 'personal' CHECK (channel IN ('personal','oa')),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','sent','failed')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS zalo_send_queue_status_idx ON public.zalo_send_queue(status, created_at);

-- ── Triggers: updated_at + auto user_id audit ──
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['zalo_accounts','zalo_conversations','zalo_message_templates','zalo_automations']) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'set_'||t||'_updated_at', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', 'set_'||t||'_updated_at', t);
  END LOOP;
  FOR t IN SELECT unnest(ARRAY['zalo_accounts','zalo_conversations','zalo_messages','zalo_message_templates','zalo_automations','zalo_send_queue']) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t||'_set_user_id_audit', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth()', t||'_set_user_id_audit', t);
  END LOOP;
END $$;

-- ── Helper: caller có quyền chat_zalo.{action}? (owner check riêng trong RPC) ──
CREATE OR REPLACE FUNCTION public.zalo_can(_action text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.is_super_admin() OR public.is_admin() OR EXISTS (
    SELECT 1
    FROM public.staff_assignments sa
    LEFT JOIN public.roles r ON r.id = sa.role_id
    WHERE sa.staff_id = auth.uid()
      AND COALESCE((COALESCE(sa.permissions, r.permissions) -> 'chat_zalo' ->> _action)::boolean, false)
  );
$$;
GRANT EXECUTE ON FUNCTION public.zalo_can(text) TO authenticated, service_role;

-- ── RLS ──
ALTER TABLE public.zalo_accounts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zalo_conversations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zalo_messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zalo_message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zalo_automations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zalo_send_queue        ENABLE ROW LEVEL SECURITY;

-- accounts / templates / automations / send_queue: owner + admin/super (ALL)
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['zalo_accounts','zalo_message_templates','zalo_automations','zalo_send_queue']) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_owner_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (user_id = auth.uid() OR public.is_super_admin() OR public.is_admin()) WITH CHECK (user_id = auth.uid() OR public.is_super_admin() OR public.is_admin())',
      t||'_owner_all', t);
  END LOOP;
END $$;

-- conversations: SELECT owner + staff được giao + admin/super; WRITE owner + admin/super
DROP POLICY IF EXISTS zalo_conversations_select ON public.zalo_conversations;
CREATE POLICY zalo_conversations_select ON public.zalo_conversations
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR assigned_staff_id = auth.uid() OR public.is_super_admin() OR public.is_admin());

DROP POLICY IF EXISTS zalo_conversations_write ON public.zalo_conversations;
CREATE POLICY zalo_conversations_write ON public.zalo_conversations
  FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.is_super_admin() OR public.is_admin())
  WITH CHECK (user_id = auth.uid() OR public.is_super_admin() OR public.is_admin());

-- messages: SELECT owner/admin/super + staff được giao hội thoại; WRITE owner/admin/super
DROP POLICY IF EXISTS zalo_messages_select ON public.zalo_messages;
CREATE POLICY zalo_messages_select ON public.zalo_messages
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid() OR public.is_super_admin() OR public.is_admin()
    OR EXISTS (SELECT 1 FROM public.zalo_conversations c
               WHERE c.id = conversation_id AND c.assigned_staff_id = auth.uid())
  );

DROP POLICY IF EXISTS zalo_messages_write ON public.zalo_messages;
CREATE POLICY zalo_messages_write ON public.zalo_messages
  FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.is_super_admin() OR public.is_admin())
  WITH CHECK (user_id = auth.uid() OR public.is_super_admin() OR public.is_admin());

-- Grants
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['zalo_accounts','zalo_conversations','zalo_messages','zalo_message_templates','zalo_automations','zalo_send_queue']) LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated, service_role', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
  END LOOP;
END $$;

-- ============ RPCs ============

-- Gửi tin (out): insert message + cập nhật conversation + enqueue worker.
CREATE OR REPLACE FUNCTION public.zalo_send_message(
  p_conversation_id uuid,
  p_type            text DEFAULT 'text',
  p_body            text DEFAULT NULL,
  p_media_url       text DEFAULT NULL,
  p_reply_to        jsonb DEFAULT NULL,
  p_cli_msg_id      text DEFAULT NULL
)
RETURNS public.zalo_messages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_conv    public.zalo_conversations;
  v_msg     public.zalo_messages;
  v_channel text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_conv FROM public.zalo_conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hội thoại không tồn tại';
  END IF;

  -- Guard quyền: chủ hội thoại luôn được; còn lại cần quyền chat_zalo.send (admin/super cũng qua zalo_can)
  IF NOT (v_conv.user_id = auth.uid() OR public.zalo_can('send')) THEN
    RAISE EXCEPTION 'Bạn không có quyền gửi tin trong hội thoại này' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(kind, 'personal') INTO v_channel FROM public.zalo_accounts WHERE id = v_conv.account_id;
  v_channel := COALESCE(v_channel, 'personal');

  INSERT INTO public.zalo_messages(
    user_id, conversation_id, account_id, direction, msg_type, body, media_url,
    reply_to, status, cli_msg_id, sent_by, sent_at
  ) VALUES (
    v_conv.user_id, p_conversation_id, v_conv.account_id, 'out', COALESCE(p_type,'text'),
    p_body, p_media_url, p_reply_to, 'pending', p_cli_msg_id, auth.uid(), now()
  ) RETURNING * INTO v_msg;

  UPDATE public.zalo_conversations
     SET last_message_text = COALESCE(NULLIF(p_body,''), CASE WHEN p_type='image' THEN '[Hình ảnh]' ELSE last_message_text END),
         last_message_at   = now(),
         last_message_dir  = 'out',
         updated_at        = now()
   WHERE id = p_conversation_id;

  INSERT INTO public.zalo_send_queue(user_id, conversation_id, message_id, account_id, channel, payload, status)
  VALUES (
    v_conv.user_id, p_conversation_id, v_msg.id, v_conv.account_id, v_channel,
    jsonb_build_object('type', COALESCE(p_type,'text'), 'body', p_body, 'media_url', p_media_url, 'reply_to', p_reply_to),
    'queued'
  );

  RETURN v_msg;
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_send_message(uuid, text, text, text, jsonb, text) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_send_message(uuid, text, text, text, jsonb, text) FROM anon;

-- Đánh dấu đã đọc.
CREATE OR REPLACE FUNCTION public.zalo_mark_read(p_conversation_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  UPDATE public.zalo_conversations
     SET unread_count = 0, updated_at = now()
   WHERE id = p_conversation_id
     AND (user_id = auth.uid() OR assigned_staff_id = auth.uid() OR public.is_super_admin() OR public.is_admin());
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_mark_read(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_mark_read(uuid) FROM anon;

-- Bật/tắt luồng tự động hoá (owner-level).
CREATE OR REPLACE FUNCTION public.zalo_toggle_automation(p_kind text, p_enabled boolean)
RETURNS public.zalo_automations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_row public.zalo_automations;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF NOT public.zalo_can('manage_automation') THEN
    RAISE EXCEPTION 'Bạn không có quyền quản lý tự động hoá' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.zalo_automations(user_id, kind, enabled)
  VALUES (auth.uid(), p_kind, p_enabled)
  ON CONFLICT (user_id, kind) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_toggle_automation(text, boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_toggle_automation(text, boolean) FROM anon;

NOTIFY pgrst, 'reload schema';
COMMIT;
