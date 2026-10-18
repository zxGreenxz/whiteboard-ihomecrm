-- zalo_conversation_list_v1 — công thức DUY NHẤT của danh sách hội thoại màn Chat Zalo (/chat-zalo),
-- dùng chung cho web, Hermes và báo cáo (chủ chốt 17/10/2026; cùng nguyên tắc customer_list_v1).
--
-- Trước đây công thức nằm ở hai chỗ của web (vùng hermes-parity zalo-conversations):
--  - src/hooks/useZaloChat.ts (useZaloConversations): PostgREST zalo_conversations (RLS) lọc công ty,
--    order last_message_at desc nulls last, limit 5000 (max_rows 1000 của PostgREST cắt trước), rồi sắp
--    ổn định "ghim lên đầu" ở trình duyệt.
--  - src/pages/chat-zalo/ChatZaloPage.tsx (filtered): lọc tài khoản đang chọn (hội thoại chưa gắn tài
--    khoản luôn hiện), nhãn Zalo (accountId:labelId), thẻ Tất cả/Chưa đọc/Khách trọ/Lead/Danh bạ, ẩn
--    hội thoại chưa có tin khi không tìm (thẻ Danh bạ thì ngược lại), tìm `search.trim().toLowerCase()`
--    bằng `includes` trong tên, SĐT, nhãn phụ (sub_label) và tên phòng của profile (profile.room).
--
-- SECURITY INVOKER — đọc zalo_conversations (và rooms khi thu hẹp toà) BẰNG RLS CỦA NGƯỜI GỌI
-- (zalo_conversations_org_select = zalo_authorized_org_ids('view') + org_boundary + hide_sandbox_admin),
-- nên tập dòng trùng tập web thấy theo cấu trúc chứ không theo bản sao luật. Policy đã bọc InitPlan ⇒
-- hàm quyền chạy một lần mỗi câu, không theo dòng. Cấm gọi từ thân hàm SECURITY DEFINER (INVOKER khi
-- đó chạy bằng quyền chủ hàm và bỏ qua RLS) ⇒ hàm tự chặn khi current_user không phải `authenticated`.
--
-- Tham số (NULL = không lọc theo tham số đó):
--  p_filter          NULL = danh sách nền (MỌI hội thoại, kể cả danh bạ chưa có tin) — nguồn web dùng
--                    cho khung chat, dialog chuyển tiếp/gửi hàng loạt/soạn tin. 'all' | 'unread' |
--                    'tenant' | 'lead' | 'contacts' = đúng thẻ lọc của cột danh sách.
--  p_search          tối đa 200 ký tự; chỉ khoảng trắng = không tìm.
--  p_account_ids     NULL = mọi tài khoản (web: đang chọn đủ mọi tài khoản); mảng = hội thoại của các
--                    tài khoản này + hội thoại chưa gắn tài khoản (như web); '{}' = chỉ hội thoại chưa gắn.
--  p_label_account_id + p_label_id   nhãn Zalo; mã nhãn chỉ duy nhất trong một tài khoản nên phải đi đôi.
--  p_building_ids    chỉ THU HẸP: giữ hội thoại gắn phòng (room_id) thuộc các toà này, phòng đọc bằng
--                    RLS người gọi. BẪY: NULL = toàn phạm vi RLS (không lọc toà), '{}' = rỗng; caller thu
--                    hẹp theo tập toà của mình phải truyền COALESCE(ids, '{}').
--  p_limit/p_offset  phân trang trong SQL; thứ tự ghim trước, tin mới nhất trước (chưa có tin cuối),
--                    id giảm dần cho dòng trùng giờ. `total` = số dòng khớp trước phân trang.
--
-- Mỗi dòng trả đúng các cột mà danh sách web đọc (CONV_FIELDS của src/lib/zaloConversationList.ts)
-- và `profile` thu gọn về các khoá nhỏ (PROFILE_FIELDS) — không kéo memberProfiles (quy tắc egress #2).
BEGIN;

CREATE OR REPLACE FUNCTION public.zalo_conversation_list_v1(
  p_organization_id uuid,
  p_filter text DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_account_ids uuid[] DEFAULT NULL,
  p_label_account_id uuid DEFAULT NULL,
  p_label_id integer DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL,
  p_limit integer DEFAULT NULL,
  p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_query text;
  v_result jsonb;
BEGIN
  IF current_user IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'zalo_conversation_list_v1 chỉ chạy bằng JWT người dùng' USING ERRCODE = '42501';
  END IF;
  -- Không đặt trần p_limit: caller tự đặt (web: danh sách nền 1000 = trần max_rows cũ, cột danh sách
  -- 300); kết quả là MỘT jsonb nên max_rows của PostgREST không cắt. Tập dòng vốn giới hạn bởi RLS + công ty.
  IF p_organization_id IS NULL OR p_offset IS NULL OR p_offset < 0 OR p_limit < 0
     OR char_length(p_search) > 200
     OR (p_filter IS NOT NULL AND p_filter NOT IN ('all', 'unread', 'tenant', 'lead', 'contacts'))
     OR (p_label_account_id IS NULL) <> (p_label_id IS NULL)
     OR array_position(p_account_ids, NULL) IS NOT NULL OR cardinality(p_account_ids) > 500
     OR array_position(p_building_ids, NULL) IS NOT NULL OR cardinality(p_building_ids) > 500 THEN
    RAISE EXCEPTION 'Tham số danh sách hội thoại Zalo không hợp lệ' USING ERRCODE = '22023';
  END IF;

  -- search.trim().toLowerCase(): khoảng trắng của String.prototype.trim (cùng tập với
  -- customer_search_patterns_v1); rỗng sau trim = không tìm.
  v_query := NULLIF(lower(pg_catalog.btrim(p_search,
    chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760)
    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198)
    || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239)
    || chr(8287) || chr(12288) || chr(65279))), '');

  WITH base AS MATERIALIZED (
    -- Chỉ cột cần để lọc/đếm/sắp; dòng đầy đủ chỉ đọc lại cho trang (cùng RLS, cùng snapshot).
    SELECT z.id, z.is_pinned, z.last_message_at
    FROM public.zalo_conversations z
    WHERE z.organization_id = p_organization_id
      -- Bỏ chọn một số tài khoản: hội thoại chưa gắn tài khoản vẫn hiện (như web).
      AND (p_account_ids IS NULL OR z.account_id IS NULL OR z.account_id = ANY (p_account_ids))
      AND (p_label_id IS NULL OR (z.account_id = p_label_account_id AND EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements_text(
                   CASE WHEN jsonb_typeof(z.label_ids) = 'array' THEN z.label_ids ELSE '[]'::jsonb END) AS l(label_id)
            WHERE l.label_id = p_label_id::text)))
      -- "Danh bạ" = đã đồng bộ bạn bè nhưng CHƯA từng có tin; thẻ khác ẩn nhóm này trừ khi đang tìm.
      AND CASE
            WHEN p_filter IS NULL THEN true
            WHEN p_filter = 'contacts' THEN z.last_message_at IS NULL
            ELSE z.last_message_at IS NOT NULL OR v_query IS NOT NULL
          END
      AND (p_filter IS DISTINCT FROM 'unread' OR z.unread_count > 0 OR z.marked_unread)
      AND (p_filter IS DISTINCT FROM 'tenant' OR z.contract_id IS NOT NULL OR z.room_id IS NOT NULL)
      AND (p_filter IS DISTINCT FROM 'lead' OR z.lead_id IS NOT NULL)
      -- includes() trên chữ thường: strpos theo ký tự, không phải LIKE (% và _ là chữ thường).
      AND (v_query IS NULL
           OR strpos(lower(z.peer_name), v_query) > 0
           OR strpos(lower(COALESCE(z.peer_phone, '')), v_query) > 0
           OR strpos(lower(COALESCE(z.sub_label, '')), v_query) > 0
           OR (jsonb_typeof(z.profile -> 'room') = 'string' AND strpos(lower(z.profile ->> 'room'), v_query) > 0))
      AND (p_building_ids IS NULL OR EXISTS (
            SELECT 1
            FROM public.rooms r
            WHERE r.id = z.room_id
              AND r.organization_id = p_organization_id
              AND r.building_id = ANY (p_building_ids)))
  ), page AS MATERIALIZED (
    SELECT b.id, b.is_pinned, b.last_message_at
    FROM base b
    ORDER BY b.is_pinned DESC, b.last_message_at DESC NULLS LAST, b.id DESC
    OFFSET p_offset
    LIMIT p_limit
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM base),
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', z.id, 'account_id', z.account_id, 'peer_zalo_uid', z.peer_zalo_uid, 'label_ids', z.label_ids,
               'peer_name', z.peer_name, 'initials', z.initials, 'peer_avatar_url', z.peer_avatar_url, 'tone', z.tone,
               'last_message_at', z.last_message_at, 'sub_label', z.sub_label, 'sub_tone', z.sub_tone,
               'last_message_text', z.last_message_text, 'unread_count', z.unread_count, 'list_tag', z.list_tag,
               'is_online', z.is_online, 'header_tag', z.header_tag, 'header_sub', z.header_sub,
               'peer_phone', z.peer_phone, 'is_pinned', z.is_pinned, 'is_muted', z.is_muted,
               'marked_unread', z.marked_unread, 'thread_type', z.thread_type, 'customer_id', z.customer_id,
               'lead_id', z.lead_id, 'contract_id', z.contract_id, 'room_id', z.room_id,
               'is_sale_partner', z.is_sale_partner,
               -- Khoá nhỏ của profile mà danh sách hiển thị; bỏ giá trị null như projection cũ.
               'profile', COALESCE((
                 SELECT jsonb_object_agg(p.key, p.value)
                 FROM pg_catalog.jsonb_each(
                        CASE WHEN jsonb_typeof(z.profile) = 'object' THEN z.profile ELSE '{}'::jsonb END) AS p(key, value)
                 WHERE p.key = ANY (ARRAY['kind', 'room', 'roomSub', 'price', 'contractCode', 'contractTerm',
                                          'contractStatus', 'debt', 'issue', 'stage', 'source', 'company', 'phone',
                                          'rooms', 'stats', 'isGroup', 'members', 'desc', 'staff', 'tags'])
                   AND jsonb_typeof(p.value) <> 'null'), '{}'::jsonb))
             ORDER BY pg.is_pinned DESC, pg.last_message_at DESC NULLS LAST, pg.id DESC)
      FROM page pg
      JOIN public.zalo_conversations z ON z.id = pg.id), '[]'::jsonb))
  INTO v_result;

  RETURN v_result;
END
$fn$;

ALTER FUNCTION public.zalo_conversation_list_v1(uuid, text, text, uuid[], uuid, integer, uuid[], integer, integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.zalo_conversation_list_v1(uuid, text, text, uuid[], uuid, integer, uuid[], integer, integer)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.zalo_conversation_list_v1(uuid, text, text, uuid[], uuid, integer, uuid[], integer, integer)
  TO authenticated;

COMMENT ON FUNCTION public.zalo_conversation_list_v1(uuid, text, text, uuid[], uuid, integer, uuid[], integer, integer) IS
  'Danh sách + tổng hội thoại màn Chat Zalo. INVOKER: RLS của người gọi; chỉ gọi bằng JWT người dùng. p_filter NULL = danh sách nền (kể cả danh bạ chưa có tin). p_building_ids chỉ thu hẹp: NULL = toàn phạm vi RLS; ''{}'' = rỗng; caller thu hẹp phải COALESCE(ids,''{}''). p_search tối đa 200 ký tự.';

COMMIT;
NOTIFY pgrst, 'reload schema';
