-- =============================================================================
-- Chat Zalo — chuyển từ OWNER-scoped sang ORG-scoped: mỗi công ty một khu Zalo
-- riêng, nhiều tài khoản Zalo / công ty, tách bạch tuyệt đối giữa các công ty.
--
-- VÌ SAO (đo thật 2026-08-13, trước file này):
--   • 7 bảng zalo_* có cột organization_id (sprint3a 20260713120000) + policy
--     RESTRICTIVE *_org_boundary, NHƯNG policy còn nhánh thoát
--     `organization_id IS NULL`, KHÔNG có trigger autofill, và mọi đường ghi
--     (RPC lẫn worker) không set cột đó → mọi dòng TƯƠNG LAI sẽ NULL org
--     = lộ cho mọi tổ chức, im lặng. (Dòng hiện có: 0 NULL — backfill sprint3a
--     đã phủ, toàn bộ thuộc org aaaa. Đo: accounts 2 · conversations 1832 ·
--     messages 2883 · send_queue 20 · labels 8 · templates 4 · automations 2.)
--   • Policy PERMISSIVE là `user_id = auth.uid() OR is_admin() OR is_super…`
--     — owner-scoped: hai đồng nghiệp CÙNG công ty không thấy hội thoại của
--     nhau. Yêu cầu nghiệp vụ là khu chat CHUNG của công ty.
--   • zalo_can() đọc staff_assignments/roles (RBAC v1) — nguồn đã CẮT khỏi
--     đồng bộ từ cutover 2026-07-25 (20260725230000): quyền cấp qua màn phân
--     quyền v3 KHÔNG có tác dụng với chat, dòng legacy sót vẫn cấp quyền.
--
-- LÀM GÌ:
--   1. organization_id NOT NULL cả 7 bảng (0 NULL nên không cần backfill;
--      vẫn có bước backfill-qua-account phòng dòng lọt giữa lúc đo và lúc áp).
--   2. Trigger autofill FAIL-CLOSED app_private.autofill_org_zalo() cho 6 bảng
--      (trừ zalo_accounts — RPC set tường minh). Nguồn suy theo thứ tự tin cậy:
--      account_id → conversation_id → client tự khai (kiểm membership) →
--      membership duy nhất → NỔ. Khai org KHÁC org của account = NỔ (42501).
--   3. Đóng nhánh `organization_id IS NULL` trong 7 policy *_org_boundary.
--   4. Thay policy owner-scoped bằng ORG-scoped gắn quyền v3:
--      public.zalo_authorized_org_ids(action) = các org caller có quyền
--      `chat_zalo.<action>` scope org_wide (my_org_ids ⨯ authorized_scope_v3).
--      Đặt ở PUBLIC schema có chủ đích: authenticated KHÔNG có USAGE trên
--      app_private (đo pg_namespace 2026-08-13) — policy openclaw gọi thẳng
--      app_private.* từ RLS là bẫy tiềm ẩn, không lặp lại ở đây.
--   5. zalo_can() viết lại theo v3 (+ overload nhận org); gỡ is_admin() khỏi
--      mọi policy/RPC zalo (nó ≡ is_super_admin từ 20260710150000, nhưng nhúng
--      lại là giữ một quả mìn nếu ai khôi phục bản cũ).
--   6. zalo_automations: UNIQUE(user_id,kind) → UNIQUE(organization_id,kind)
--      — automation là của CÔNG TY, không phải của người.
--   7. Viết lại toàn bộ RPC: guard org-scoped, stamp organization_id vào mọi
--      dòng sinh ra; zalo_request_connect/zalo_toggle_automation nhận
--      p_organization_id (người thuộc nhiều org thì chỉ client biết ngữ cảnh).
--
-- KHÔNG đụng: openclaw_* (hệ riêng), realtime publication (giữ nguyên 4 bảng).
-- Idempotent. Nghiệm thu chạy THẬT bằng role authenticated ở cuối file.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. organization_id NOT NULL (backfill phòng hờ qua account → membership)
-- ---------------------------------------------------------------------------
DO $notnull$
DECLARE t text; v_n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['zalo_conversations','zalo_messages','zalo_send_queue','zalo_labels'] LOOP
    -- các bảng có account_id: suy qua tài khoản trước
    EXECUTE format(
      'UPDATE public.%I x SET organization_id = a.organization_id
         FROM public.zalo_accounts a
        WHERE a.id = x.account_id AND x.organization_id IS NULL AND a.organization_id IS NOT NULL', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['zalo_accounts','zalo_conversations','zalo_messages','zalo_send_queue',
                           'zalo_labels','zalo_message_templates','zalo_automations'] LOOP
    -- còn sót: membership ACTIVE duy nhất của user_id
    EXECUTE format(
      'UPDATE public.%I x SET organization_id = m.org
         FROM (SELECT user_id, (array_agg(DISTINCT organization_id))[1] AS org
                 FROM public.organization_memberships
                WHERE status = ''ACTIVE''
                GROUP BY user_id
               HAVING count(DISTINCT organization_id) = 1) m
        WHERE m.user_id = x.user_id AND x.organization_id IS NULL', t);
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL', t) INTO v_n;
    IF v_n > 0 THEN
      RAISE EXCEPTION 'Bảng % còn % dòng không suy được tổ chức — DỪNG, xử lý tay trước khi NOT NULL.', t, v_n;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN organization_id SET NOT NULL', t);
  END LOOP;
END
$notnull$;

-- ---------------------------------------------------------------------------
-- 2. Helper quyền v3 (đặt ở public — xem đầu file vì sao không app_private)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zalo_authorized_org_ids(p_action text)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT candidate.organization_id
    FROM pg_catalog.unnest(public.my_org_ids()) AS candidate(organization_id)
   CROSS JOIN LATERAL app_private.authorized_scope_v3(
     'chat_zalo.' || p_action, candidate.organization_id) AS scope
   WHERE scope.org_wide
$$;
COMMENT ON FUNCTION public.zalo_authorized_org_ids(text) IS
  'Các tổ chức mà caller có quyền chat_zalo.<action> phạm vi org_wide (RBAC v3). Nguồn quyền duy nhất của khu Zalo.';
REVOKE ALL ON FUNCTION public.zalo_authorized_org_ids(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.zalo_authorized_org_ids(text) TO authenticated, service_role;

-- zalo_can viết lại theo v3. Giữ chữ ký 1 tham số cho tương thích; thêm bản 2
-- tham số kiểm đúng một tổ chức — RPC bên dưới dùng bản này.
CREATE OR REPLACE FUNCTION public.zalo_can(_action text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.is_super_admin()
      OR EXISTS (SELECT 1 FROM public.zalo_authorized_org_ids(_action));
$$;
CREATE OR REPLACE FUNCTION public.zalo_can(_action text, _org uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.is_super_admin()
      OR _org IN (SELECT public.zalo_authorized_org_ids(_action));
$$;
COMMENT ON FUNCTION public.zalo_can(text, uuid) IS
  'Caller có quyền chat_zalo.<action> trong tổ chức _org? (RBAC v3 — thay bản cũ đọc staff_assignments đã chết từ cutover 25/07).';
REVOKE ALL ON FUNCTION public.zalo_can(text) FROM public, anon;
REVOKE ALL ON FUNCTION public.zalo_can(text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.zalo_can(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.zalo_can(text, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Trigger autofill FAIL-CLOSED cho 6 bảng con
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.autofill_org_zalo()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $f$
DECLARE
  j       jsonb := to_jsonb(NEW);
  v_org   uuid;
  v_uid   uuid;
  v_n     int;
  v_thuoc boolean;
BEGIN
  -- (1) account_id là nguồn TIN CẬY NHẤT: tài khoản Zalo LÀ kênh của công ty.
  IF (j ? 'account_id') AND (j->>'account_id') IS NOT NULL THEN
    SELECT a.organization_id INTO v_org
      FROM public.zalo_accounts a WHERE a.id = (j->>'account_id')::uuid;
  END IF;

  -- (2) chưa có: kế thừa hội thoại cha (giữ mọi tin trong 1 thread cùng 1 org).
  IF v_org IS NULL AND (j ? 'conversation_id') AND (j->>'conversation_id') IS NOT NULL THEN
    SELECT c.organization_id INTO v_org
      FROM public.zalo_conversations c WHERE c.id = (j->>'conversation_id')::uuid;
  END IF;

  IF v_org IS NOT NULL THEN
    -- Khai org KHÁC org của account/hội thoại = bug ở tầng gọi → NỔ, không đoán.
    IF NEW.organization_id IS NOT NULL AND NEW.organization_id IS DISTINCT FROM v_org THEN
      RAISE EXCEPTION '% : dòng khai tổ chức % nhưng tài khoản/hội thoại cha thuộc tổ chức % — từ chối ghi chéo công ty.',
        TG_TABLE_NAME, NEW.organization_id, v_org USING ERRCODE = '42501';
    END IF;
    NEW.organization_id := v_org;
    RETURN NEW;
  END IF;

  v_uid := COALESCE(NEW.user_id, auth.uid());

  -- (3) client tự khai — phải CHỨNG MINH membership, không tin suông.
  IF NEW.organization_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.organization_memberships m
                    WHERE m.user_id = v_uid
                      AND m.organization_id = NEW.organization_id
                      AND m.status = 'ACTIVE')
      INTO v_thuoc;
    IF NOT v_thuoc THEN
      RAISE EXCEPTION '% : người dùng % không có membership ACTIVE ở tổ chức % — không được ghi dữ liệu Zalo vào tổ chức mình không thuộc.',
        TG_TABLE_NAME, v_uid, NEW.organization_id USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- (4) membership, CHỈ khi không mập mờ.
  IF v_uid IS NOT NULL THEN
    SELECT (array_agg(DISTINCT m.organization_id))[1], count(DISTINCT m.organization_id)
      INTO v_org, v_n
      FROM public.organization_memberships m
     WHERE m.user_id = v_uid AND m.status = 'ACTIVE';
    IF v_n IS DISTINCT FROM 1 THEN v_org := NULL; END IF;
  END IF;

  -- FAIL-CLOSED: nổ tốt hơn đoán — một hội thoại dán nhầm nhãn công ty là dữ
  -- liệu sai vĩnh viễn trong khu chat của công ty khác.
  IF v_org IS NULL THEN
    RAISE EXCEPTION '% : không xác định được tổ chức cho dòng Zalo của người dùng %. Tầng gọi phải kèm organization_id hoặc account_id.',
      TG_TABLE_NAME, v_uid USING ERRCODE = '23502';
  END IF;

  NEW.organization_id := v_org;
  RETURN NEW;
END;
$f$;
COMMENT ON FUNCTION app_private.autofill_org_zalo() IS
  'Điền organization_id cho zalo_* (trừ zalo_accounts). FAIL-CLOSED, ưu tiên org của account > hội thoại cha > client khai (kiểm membership) > membership duy nhất.';

DO $trg$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zalo_conversations','zalo_messages','zalo_send_queue',
                           'zalo_labels','zalo_message_templates','zalo_automations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_autofill_org_zalo ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_autofill_org_zalo BEFORE INSERT ON public.%I
                    FOR EACH ROW EXECUTE FUNCTION app_private.autofill_org_zalo()', t);
  END LOOP;
END
$trg$;

-- ---------------------------------------------------------------------------
-- 4. Đóng cửa thoát `organization_id IS NULL` trong biên giới (cột đã NOT NULL)
-- ---------------------------------------------------------------------------
DO $rao$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zalo_accounts','zalo_conversations','zalo_messages','zalo_send_queue',
                           'zalo_labels','zalo_message_templates','zalo_automations'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_org_boundary', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING ((SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids()))) '
      'WITH CHECK ((SELECT public.is_super_admin()) OR organization_id IN (SELECT unnest(public.my_org_ids())))',
      t || '_org_boundary', t);
  END LOOP;
END
$rao$;

-- ---------------------------------------------------------------------------
-- 5. Policy PERMISSIVE: owner-scoped → org-scoped gắn quyền v3
--    (đọc = chat_zalo.view; ghi = send, riêng templates/automations = manage_*)
-- ---------------------------------------------------------------------------
DO $pol$
DECLARE
  t      text;
  w_act  text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zalo_accounts','zalo_conversations','zalo_messages','zalo_send_queue',
                           'zalo_labels','zalo_message_templates','zalo_automations'] LOOP
    w_act := CASE t
               WHEN 'zalo_message_templates' THEN 'manage_templates'
               WHEN 'zalo_automations'       THEN 'manage_automation'
               ELSE 'send'
             END;
    -- dọn policy owner-scoped cũ (đủ mọi tên từng tồn tại)
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_all', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_org_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_org_write', t);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated '
      'USING ((SELECT public.is_super_admin()) OR organization_id IN (SELECT public.zalo_authorized_org_ids(''view'')))',
      t || '_org_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated '
      'USING ((SELECT public.is_super_admin()) OR organization_id IN (SELECT public.zalo_authorized_org_ids(%L))) '
      'WITH CHECK ((SELECT public.is_super_admin()) OR organization_id IN (SELECT public.zalo_authorized_org_ids(%L)))',
      t || '_org_write', t, w_act, w_act);
  END LOOP;
END
$pol$;

-- ---------------------------------------------------------------------------
-- 6. Automation là của CÔNG TY: UNIQUE(organization_id, kind)
-- ---------------------------------------------------------------------------
DO $auto$
DECLARE v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM (
    SELECT organization_id, kind FROM public.zalo_automations
     GROUP BY organization_id, kind HAVING count(*) > 1) d;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'zalo_automations có % cặp (organization_id, kind) trùng — DỪNG, xử lý tay (không tự xoá dữ liệu công ty thật).', v_n;
  END IF;
  ALTER TABLE public.zalo_automations DROP CONSTRAINT IF EXISTS zalo_automations_user_id_kind_key;
  CREATE UNIQUE INDEX IF NOT EXISTS zalo_automations_org_kind_uidx
    ON public.zalo_automations(organization_id, kind);
END
$auto$;

-- ---------------------------------------------------------------------------
-- 7. Viết lại RPC — guard v3 theo org + stamp organization_id
-- ---------------------------------------------------------------------------

-- 7.1 Gửi tin
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

  IF NOT public.zalo_can('send', v_conv.organization_id) THEN
    RAISE EXCEPTION 'Bạn không có quyền gửi tin Zalo trong tổ chức này' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(kind, 'personal') INTO v_channel FROM public.zalo_accounts WHERE id = v_conv.account_id;
  v_channel := COALESCE(v_channel, 'personal');

  INSERT INTO public.zalo_messages(
    user_id, organization_id, conversation_id, account_id, direction, msg_type, body, media_url,
    reply_to, status, cli_msg_id, sent_by, sent_at
  ) VALUES (
    v_conv.user_id, v_conv.organization_id, p_conversation_id, v_conv.account_id, 'out', COALESCE(p_type,'text'),
    p_body, p_media_url, p_reply_to, 'pending', p_cli_msg_id, auth.uid(), now()
  ) RETURNING * INTO v_msg;

  UPDATE public.zalo_conversations
     SET last_message_text = COALESCE(NULLIF(p_body,''), CASE WHEN p_type='image' THEN '[Hình ảnh]' ELSE last_message_text END),
         last_message_at   = now(),
         last_message_dir  = 'out',
         updated_at        = now()
   WHERE id = p_conversation_id;

  INSERT INTO public.zalo_send_queue(user_id, organization_id, conversation_id, message_id, account_id, channel, payload, status)
  VALUES (
    v_conv.user_id, v_conv.organization_id, p_conversation_id, v_msg.id, v_conv.account_id, v_channel,
    jsonb_build_object('type', COALESCE(p_type,'text'), 'body', p_body, 'media_url', p_media_url, 'reply_to', p_reply_to),
    'queued'
  );

  RETURN v_msg;
END;
$$;

-- 7.2 Đánh dấu đã đọc
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
     SET unread_count = 0, updated_at = now()
   WHERE id = p_conversation_id;
END;
$$;

-- 7.3 Reaction
CREATE OR REPLACE FUNCTION public.zalo_react_message(p_message_id uuid, p_emoji text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m public.zalo_messages; c public.zalo_conversations;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT * INTO m FROM public.zalo_messages WHERE id = p_message_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tin nhắn không tồn tại'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id = m.conversation_id;
  IF NOT public.zalo_can('send', c.organization_id) THEN
    RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE = '42501';
  END IF;
  UPDATE public.zalo_messages SET reaction_emoji = p_emoji WHERE id = p_message_id;
  INSERT INTO public.zalo_send_queue(user_id, organization_id, conversation_id, account_id, channel, payload, status)
  VALUES (c.user_id, c.organization_id, c.id, c.account_id, 'personal',
    jsonb_build_object('action','react','emoji',p_emoji,'target_msg_id',m.zalo_msg_id,'target_cli_msg_id',m.cli_msg_id,'thread_id',c.thread_id,'thread_type',c.thread_type),
    'queued');
END; $$;

-- 7.4 Thu hồi
CREATE OR REPLACE FUNCTION public.zalo_recall_message(p_message_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m public.zalo_messages; c public.zalo_conversations;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT * INTO m FROM public.zalo_messages WHERE id = p_message_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tin nhắn không tồn tại'; END IF;
  IF m.direction <> 'out' THEN RAISE EXCEPTION 'Chỉ thu hồi được tin do bạn gửi'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id = m.conversation_id;
  IF NOT public.zalo_can('send', c.organization_id) THEN
    RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE = '42501';
  END IF;
  UPDATE public.zalo_messages SET body = '(Tin đã được thu hồi)', msg_type = 'sys', reaction_emoji = NULL WHERE id = p_message_id;
  INSERT INTO public.zalo_send_queue(user_id, organization_id, conversation_id, account_id, channel, payload, status)
  VALUES (c.user_id, c.organization_id, c.id, c.account_id, 'personal',
    jsonb_build_object('action','recall','target_msg_id',m.zalo_msg_id,'target_cli_msg_id',m.cli_msg_id,'thread_id',c.thread_id,'thread_type',c.thread_type),
    'queued');
END; $$;

-- 7.5 Tải thêm tin cũ (chỉ NHÓM)
CREATE OR REPLACE FUNCTION public.zalo_load_history(p_conversation_id uuid, p_count int DEFAULT 50)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.zalo_conversations;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hội thoại không tồn tại'; END IF;
  IF c.thread_type <> 'group' THEN RAISE EXCEPTION 'Chỉ tải thêm được tin cũ của NHÓM'; END IF;
  IF NOT public.zalo_can('view', c.organization_id) THEN
    RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.zalo_send_queue(user_id, organization_id, conversation_id, account_id, channel, payload, status)
  VALUES (c.user_id, c.organization_id, c.id, c.account_id, 'personal',
    jsonb_build_object('action','load_history','thread_id',c.thread_id,'thread_type',c.thread_type,'count',LEAST(COALESCE(p_count,50),200)),
    'queued');
END; $$;

-- 7.6 Broadcast
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
    IF NOT public.zalo_can('send', c.organization_id) THEN CONTINUE; END IF;

    INSERT INTO public.zalo_messages(user_id, organization_id, conversation_id, account_id, direction, msg_type, body, status, sent_by, sent_at)
    VALUES (c.user_id, c.organization_id, c.id, c.account_id, 'out', 'text', p_body, 'pending', auth.uid(), now())
    RETURNING id INTO v_msg_id;

    UPDATE public.zalo_conversations
       SET last_message_text = p_body, last_message_at = now(), last_message_dir = 'out', updated_at = now()
     WHERE id = c.id;

    SELECT COALESCE(kind, 'personal') INTO v_channel FROM public.zalo_accounts WHERE id = c.account_id;
    INSERT INTO public.zalo_send_queue(user_id, organization_id, conversation_id, message_id, account_id, channel, payload, status)
    VALUES (c.user_id, c.organization_id, c.id, v_msg_id, c.account_id, COALESCE(v_channel, 'personal'),
            jsonb_build_object('type', 'text', 'body', p_body), 'queued');

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- 7.7 Bật/tắt tự động hoá — theo TỔ CHỨC (đổi chữ ký: thêm p_organization_id)
DROP FUNCTION IF EXISTS public.zalo_toggle_automation(text, boolean);
CREATE FUNCTION public.zalo_toggle_automation(p_kind text, p_enabled boolean, p_organization_id uuid DEFAULT NULL)
RETURNS public.zalo_automations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row  public.zalo_automations;
  v_org  uuid;
  v_orgs uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_organization_id IS NOT NULL THEN
    IF NOT public.zalo_can('manage_automation', p_organization_id) THEN
      RAISE EXCEPTION 'Bạn không có quyền quản lý tự động hoá trong tổ chức này' USING ERRCODE = '42501';
    END IF;
    v_org := p_organization_id;
  ELSE
    SELECT array_agg(o) INTO v_orgs FROM public.zalo_authorized_org_ids('manage_automation') o;
    IF v_orgs IS NULL OR array_length(v_orgs, 1) IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'Không xác định được tổ chức — truyền p_organization_id (bạn thuộc nhiều tổ chức hoặc chưa được cấp quyền).' USING ERRCODE = '23502';
    END IF;
    v_org := v_orgs[1];
  END IF;

  INSERT INTO public.zalo_automations(user_id, organization_id, kind, enabled)
  VALUES (auth.uid(), v_org, p_kind, p_enabled)
  ON CONFLICT (organization_id, kind) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_toggle_automation(text, boolean, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_toggle_automation(text, boolean, uuid) FROM anon;

-- 7.8 Kết nối tài khoản — theo TỔ CHỨC (đổi chữ ký: thêm p_organization_id)
DROP FUNCTION IF EXISTS public.zalo_request_connect(uuid, text);
CREATE FUNCTION public.zalo_request_connect(p_account_id uuid DEFAULT NULL, p_name text DEFAULT NULL, p_organization_id uuid DEFAULT NULL)
RETURNS public.zalo_accounts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row  public.zalo_accounts;
  v_org  uuid;
  v_orgs uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  IF p_account_id IS NULL THEN
    -- tạo tài khoản mới: PHẢI biết thuộc công ty nào
    IF p_organization_id IS NOT NULL THEN
      IF NOT public.zalo_can('send', p_organization_id) THEN
        RAISE EXCEPTION 'Bạn không có quyền kết nối Zalo cho tổ chức này' USING ERRCODE = '42501';
      END IF;
      v_org := p_organization_id;
    ELSE
      SELECT array_agg(o) INTO v_orgs FROM public.zalo_authorized_org_ids('send') o;
      IF v_orgs IS NULL OR array_length(v_orgs, 1) IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION 'Không xác định được tổ chức — truyền p_organization_id (bạn thuộc nhiều tổ chức hoặc chưa được cấp quyền chat_zalo.send).' USING ERRCODE = '23502';
      END IF;
      v_org := v_orgs[1];
    END IF;

    INSERT INTO public.zalo_accounts(user_id, organization_id, kind, name, status, login_requested_at)
    VALUES (auth.uid(), v_org, 'personal', COALESCE(NULLIF(btrim(p_name),''), 'Zalo cá nhân'), 'connecting', now())
    RETURNING * INTO v_row;
  ELSE
    SELECT * INTO v_row FROM public.zalo_accounts WHERE id = p_account_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tài khoản không tồn tại'; END IF;
    IF NOT public.zalo_can('send', v_row.organization_id) THEN
      RAISE EXCEPTION 'Bạn không có quyền với tài khoản này' USING ERRCODE = '42501';
    END IF;
    UPDATE public.zalo_accounts
       SET status='connecting', qr_data=NULL, last_error=NULL, login_requested_at=now(),
           name=COALESCE(NULLIF(btrim(p_name),''), name), updated_at=now()
     WHERE id = p_account_id
     RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;
GRANT EXECUTE ON FUNCTION public.zalo_request_connect(uuid, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_request_connect(uuid, text, uuid) FROM anon;

-- 7.9 Ngắt kết nối
CREATE OR REPLACE FUNCTION public.zalo_disconnect_account(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_org uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  SELECT organization_id INTO v_org FROM public.zalo_accounts WHERE id = p_account_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT public.zalo_can('send', v_org) THEN
    RAISE EXCEPTION 'Bạn không có quyền với tài khoản này' USING ERRCODE = '42501';
  END IF;
  UPDATE public.zalo_accounts
     SET status='disconnected', qr_data=NULL, qr_expires_at=NULL, updated_at=now()
   WHERE id = p_account_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — chạy thật, không suy từ mã. Fixture ghi vào org DEMO, tự dọn.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  ORG_DEMO constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  ORG_THAT constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  v_uid_demo uuid;
  v_acc      uuid;
  v_conv     uuid;
  v_n        bigint;
  v_notnull  int;
  v_bad      int;
BEGIN
  -- (a) organization_id NOT NULL đủ 7 bảng
  SELECT count(*) INTO v_notnull
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('zalo_accounts','zalo_conversations','zalo_messages','zalo_send_queue',
                       'zalo_labels','zalo_message_templates','zalo_automations')
     AND a.attname = 'organization_id' AND a.attnotnull;
  IF v_notnull <> 7 THEN
    RAISE EXCEPTION 'Chỉ %/7 bảng zalo có organization_id NOT NULL. DỪNG.', v_notnull;
  END IF;

  -- (b) biên giới không còn nhánh thoát IS NULL, và policy owner-scoped đã biến mất
  SELECT count(*) INTO v_bad FROM pg_policies
   WHERE schemaname='public' AND tablename LIKE 'zalo\_%'
     AND policyname LIKE '%org_boundary' AND qual ILIKE '%IS NULL%';
  IF v_bad > 0 THEN RAISE EXCEPTION 'Còn % policy biên giới zalo mang nhánh IS NULL. DỪNG.', v_bad; END IF;
  -- policy cũ đã bị 20260710140000 bọc thành (SELECT auth.uid()) nên detector
  -- phải bắt theo 'user_id' trần — không policy org-scoped mới nào nhắc tới nó.
  SELECT count(*) INTO v_bad FROM pg_policies
   WHERE schemaname='public' AND tablename LIKE 'zalo\_%'
     AND (policyname LIKE '%owner_all' OR qual ILIKE '%user_id%' OR with_check ILIKE '%user_id%');
  IF v_bad > 0 THEN RAISE EXCEPTION 'Còn % policy zalo owner-scoped. DỪNG.', v_bad; END IF;

  -- (c) chọn một người dùng thường của org DEMO (không super admin)
  SELECT m.user_id INTO v_uid_demo
    FROM public.organization_memberships m
   WHERE m.organization_id = ORG_DEMO AND m.status = 'ACTIVE'
     AND NOT EXISTS (SELECT 1 FROM public.super_admins s WHERE s.user_id = m.user_id)
   ORDER BY m.user_id LIMIT 1;
  IF v_uid_demo IS NULL THEN
    RAISE EXCEPTION 'Không có người dùng org DEMO để nghiệm thu. DỪNG.';
  END IF;

  -- (d) trigger autofill: hội thoại KHÔNG khai org phải kế thừa org của account
  INSERT INTO public.zalo_accounts(user_id, organization_id, kind, name, status)
  VALUES (v_uid_demo, ORG_DEMO, 'personal', 'ZZ nghiệm thu M1', 'disconnected')
  RETURNING id INTO v_acc;
  INSERT INTO public.zalo_conversations(user_id, account_id, thread_id, peer_name)
  VALUES (v_uid_demo, v_acc, 'zz_nghiem_thu_m1', 'ZZ Khách nghiệm thu')
  RETURNING id INTO v_conv;
  IF (SELECT organization_id FROM public.zalo_conversations WHERE id = v_conv) IS DISTINCT FROM ORG_DEMO THEN
    RAISE EXCEPTION 'Trigger không điền org của account cho hội thoại. DỪNG.';
  END IF;

  -- (e) khai org KHÁC org của account → phải NỔ 42501
  BEGIN
    INSERT INTO public.zalo_conversations(user_id, organization_id, account_id, thread_id, peer_name)
    VALUES (v_uid_demo, ORG_THAT, v_acc, 'zz_cheo_cong_ty', 'ZZ chéo công ty');
    RAISE EXCEPTION 'Ghi được hội thoại khai org khác org của account. DỪNG.';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;

  -- (f) người KHÔNG membership → fail-closed 23502 (không account, không org)
  BEGIN
    INSERT INTO public.zalo_message_templates(user_id, title)
    VALUES ('11111111-2222-4333-8444-555555555555', 'ZZ mồ côi');
    RAISE EXCEPTION 'Người không membership vẫn ghi được template — trigger không fail-closed. DỪNG.';
  EXCEPTION WHEN sqlstate '23502' THEN NULL;
  END;

  -- (g) TÁCH BẠCH THẬT — đóng vai người org DEMO bằng role authenticated:
  --     không được thấy bất kỳ dòng nào của org THẬT.
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', v_uid_demo::text, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  SELECT count(*) INTO v_n FROM public.zalo_conversations WHERE organization_id = ORG_THAT;
  IF v_n > 0 THEN RESET ROLE; RAISE EXCEPTION 'Người org DEMO nhìn thấy % hội thoại của org THẬT. DỪNG.', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.zalo_messages WHERE organization_id = ORG_THAT;
  IF v_n > 0 THEN RESET ROLE; RAISE EXCEPTION 'Người org DEMO nhìn thấy % tin nhắn của org THẬT. DỪNG.', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.zalo_accounts WHERE organization_id = ORG_THAT;
  IF v_n > 0 THEN RESET ROLE; RAISE EXCEPTION 'Người org DEMO nhìn thấy % tài khoản Zalo của org THẬT. DỪNG.', v_n; END IF;

  -- (h) người org DEMO cố ghi hội thoại vào org THẬT → phải bị chặn (42501)
  BEGIN
    INSERT INTO public.zalo_conversations(user_id, organization_id, thread_id, peer_name)
    VALUES (v_uid_demo, ORG_THAT, 'zz_xam_nhap', 'ZZ xâm nhập');
    RESET ROLE;
    RAISE EXCEPTION 'Người org DEMO ghi được hội thoại vào org THẬT. DỪNG.';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;

  RESET ROLE;

  -- dọn sạch fixture
  DELETE FROM public.zalo_conversations WHERE id = v_conv;
  DELETE FROM public.zalo_accounts WHERE id = v_acc;

  RAISE NOTICE 'Nghiệm thu M1 đạt: NOT NULL 7/7, biên giới kín, owner-scoped đã gỡ, autofill fail-closed, org DEMO không thấy/không ghi được org THẬT.';
END
$nghiem_thu$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- =============================================================================
-- ROLLBACK (tay): dựng lại policy owner_all/select/write từ 20260626000001+07,
-- policy *_org_boundary bản có nhánh IS NULL từ 20260808010000, DROP các trigger
-- trg_autofill_org_zalo + hàm app_private.autofill_org_zalo(), DROP 2 hàm
-- zalo_authorized_org_ids/zalo_can(text,uuid), khôi phục zalo_can(text) bản
-- staff_assignments, ALTER COLUMN organization_id DROP NOT NULL (7 bảng),
-- khôi phục UNIQUE(user_id,kind) trên zalo_automations, và dựng lại 2 RPC
-- chữ ký cũ zalo_request_connect(uuid,text)/zalo_toggle_automation(text,boolean).
-- =============================================================================
