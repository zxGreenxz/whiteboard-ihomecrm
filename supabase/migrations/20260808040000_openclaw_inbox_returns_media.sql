-- Hộp thư hiện ảnh, video, ghi âm và tệp — không chỉ chữ.
--
-- Dữ liệu đã nằm sẵn trong envelope thô, chưa ai đưa ra:
--   chat.photo      1452 dòng, đủ href + thumb
--   chat.video.msg    59 dòng, href = video, thumb = ảnh bìa
--   chat.voice         2 dòng, href
--   share.file         1 dòng, href
--   chat.ecard         1 dòng, href + thumb
--
-- `openclaw_message_media` KHÔNG giữ URL gốc (theo đặc tả nó chỉ giữ object
-- key/checksum, và cả 470 dòng vẫn ở byte_state=PENDING vì media gateway chưa
-- từng được dựng). Nên URL lấy từ `raw_envelope`, là nơi duy nhất còn có.
--
-- Trình duyệt sẽ tải bytes trực tiếp từ CDN Zalo. Đó đúng là cách Zalo Web làm,
-- và cũng là cách web2/zalo của nhà đang chạy thật. Đánh đổi đã biết: ảnh sống
-- đúng bằng tuổi link. Khi media gateway có thật, chỉ cần đổi nguồn URL ở hàm
-- này — giao diện không phải sửa, vì nó chỉ cần một URL.

begin;

create or replace function public.openclaw_list_messages_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_account uuid;
  v_conversation uuid;
  v_requested_limit integer;
  v_limit integer;
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_items jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','conversationId','cursorReceivedAt','cursorId','limit'],
    array['version','organizationId','accountId','conversationId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.view', 'xem tin nhắn OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_account := (p_request ->> 'accountId')::uuid;
  v_conversation := (p_request ->> 'conversationId')::uuid;
  v_requested_limit := (p_request ->> 'limit')::integer;
  v_limit := greatest(1, least(coalesce(v_requested_limit, 50), 100));
  v_cursor_at := nullif(p_request ->> 'cursorReceivedAt', '')::timestamptz;
  v_cursor_id := nullif(p_request ->> 'cursorId', '')::uuid;
  select coalesce(jsonb_agg(item.payload order by item.received_at desc, item.id desc), '[]'::jsonb)
  into v_items
  from (
    select m.id, m.received_at,
      jsonb_build_object(
        'messageId', m.id, 'direction', m.direction, 'eventKind', m.event_kind,
        'providerTimestamp', m.provider_timestamp, 'receivedAt', m.received_at,
        'createdAt', m.created_at,
        'textContent', m.text_content,
        'providerSenderId', m.provider_sender_id,
        'senderName', member.display_name,
        'providerEventType', source_event.provider_event_type,
        'media', case
          when nullif(source_event.raw_envelope -> 'data' -> 'content' ->> 'href', '') is null
            then '[]'::jsonb
          else jsonb_build_array(jsonb_build_object(
            'kind', case source_event.provider_event_type
              when 'chat.video.msg' then 'video'
              when 'chat.voice' then 'audio'
              when 'share.file' then 'file'
              else 'image'
            end,
            'url', source_event.raw_envelope -> 'data' -> 'content' ->> 'href',
            'thumb', nullif(source_event.raw_envelope -> 'data' -> 'content' ->> 'thumb', ''),
            'title', nullif(source_event.raw_envelope -> 'data' -> 'content' ->> 'title', '')
          ))
        end
      ) as payload
    from public.openclaw_messages m
    left join public.openclaw_conversation_members member
      on member.organization_id = m.organization_id
     and member.account_id = m.account_id
     and member.conversation_id = m.conversation_id
     and member.provider_member_id = m.provider_sender_id
    left join public.openclaw_inbound_events source_event
      on source_event.id = m.source_inbound_event_id
    where m.organization_id = v_org and m.account_id = v_account
      and m.conversation_id = v_conversation
      and (v_cursor_at is null or (m.received_at, m.id) < (v_cursor_at, v_cursor_id))
    order by m.received_at desc, m.id desc
    limit v_limit
  ) item;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

commit;
