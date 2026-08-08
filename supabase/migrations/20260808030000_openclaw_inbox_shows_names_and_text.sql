-- Hộp thư hiển thị người và lời, không còn là bảng UUID.
--
-- Đặc tả sản phẩm (§ "Hộp thư đến theo conversation, tin nhắn văn bản và media")
-- yêu cầu thread hiện nội dung. Bản cài đặt đầu dừng ở siêu dữ liệu: RPC trả
-- đúng id/direction/eventKind/timestamps, nên màn hình chỉ có "KHÁCH GỬI ·
-- MESSAGE" lặp lại, còn danh sách hội thoại là một cột UUID. Toàn bộ dữ liệu để
-- làm đúng đã nằm sẵn trong Postgres:
--
--   * `openclaw_messages.text_content` đầy đủ 354/354 dòng.
--   * Tên người gửi có trong `raw_envelope->'data'->>'dName'` ở 396/396 sự kiện
--     MESSAGE — Zalo gửi kèm sẵn, không phải đi hỏi lại provider.
--
-- Tên NHÓM thì Zalo không đính trong envelope tin nhắn. Nhóm vì thế lấy tên theo
-- thành viên đã thấy, đúng cách Zalo Web hiển thị nhóm chưa đặt tên, thay vì bịa
-- một cái tên hoặc bỏ trống.

begin;

-- 1) Ghi tên hiển thị ngay khi tin vào, từ dName của chính sự kiện đó.
--
-- Đặt ở inbound_events chứ không ở messages: envelope thô là nơi DUY NHẤT còn
-- giữ dName; `openclaw_messages` đã chuẩn hoá mất trường này.
create or replace function app_private.openclaw_capture_sender_name_v1()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_name text;
  v_conversation uuid;
begin
  v_name := nullif(btrim(coalesce(new.raw_envelope -> 'data' ->> 'dName', '')), '');
  if v_name is null or new.provider_sender_id is null then
    return new;
  end if;

  -- Danh bạ: chỉ ghi đè khi tên còn là chỗ giữ chỗ (đang bằng chính provider id),
  -- để một lần đổi tên bên Zalo không ghi đè tên người dùng đã sửa tay.
  update public.openclaw_contacts contact
  set display_name = v_name,
      updated_at = now()
  where contact.organization_id = new.organization_id
    and contact.account_id = new.account_id
    and contact.provider_id = new.provider_sender_id
    and (contact.display_name is null or contact.display_name = contact.provider_id);

  select conversation.id into v_conversation
  from public.openclaw_conversations conversation
  where conversation.organization_id = new.organization_id
    and conversation.account_id = new.account_id
    and conversation.provider_conversation_id = new.provider_conversation_id;

  if v_conversation is null then
    return new;
  end if;

  insert into public.openclaw_conversation_members as member (
    organization_id, account_id, conversation_id, provider_member_id, display_name, member_role
  )
  values (
    new.organization_id, new.account_id, v_conversation, new.provider_sender_id, v_name, 'MEMBER'
  )
  on conflict (organization_id, account_id, conversation_id, provider_member_id)
  do update set display_name = excluded.display_name
  where member.display_name is distinct from excluded.display_name;

  return new;
end;
$function$;

drop trigger if exists openclaw_capture_sender_name on public.openclaw_inbound_events;
create trigger openclaw_capture_sender_name
after insert on public.openclaw_inbound_events
for each row
execute function app_private.openclaw_capture_sender_name_v1();

-- 2) Backfill từ những gì đã nhận, để Hộp thư có tên ngay chứ không phải đợi tin mới.
insert into public.openclaw_conversation_members (
  organization_id, account_id, conversation_id, provider_member_id, display_name, member_role
)
select distinct on (event.organization_id, event.account_id, conversation.id, event.provider_sender_id)
  event.organization_id, event.account_id, conversation.id, event.provider_sender_id,
  btrim(event.raw_envelope -> 'data' ->> 'dName'), 'MEMBER'
from public.openclaw_inbound_events event
join public.openclaw_conversations conversation
  on conversation.organization_id = event.organization_id
 and conversation.account_id = event.account_id
 and conversation.provider_conversation_id = event.provider_conversation_id
where event.provider_sender_id is not null
  and nullif(btrim(coalesce(event.raw_envelope -> 'data' ->> 'dName', '')), '') is not null
order by event.organization_id, event.account_id, conversation.id, event.provider_sender_id,
         event.created_at desc
on conflict (organization_id, account_id, conversation_id, provider_member_id) do nothing;

update public.openclaw_contacts contact
set display_name = named.display_name,
    updated_at = now()
from (
  select distinct on (event.organization_id, event.account_id, event.provider_sender_id)
    event.organization_id, event.account_id, event.provider_sender_id,
    btrim(event.raw_envelope -> 'data' ->> 'dName') as display_name
  from public.openclaw_inbound_events event
  where event.provider_sender_id is not null
    and nullif(btrim(coalesce(event.raw_envelope -> 'data' ->> 'dName', '')), '') is not null
  order by event.organization_id, event.account_id, event.provider_sender_id, event.created_at desc
) named
where contact.organization_id = named.organization_id
  and contact.account_id = named.account_id
  and contact.provider_id = named.provider_sender_id
  and (contact.display_name is null or contact.display_name = contact.provider_id);

-- 3) Danh sách hội thoại kèm tên và loại, để cột trái đọc được như Zalo Web.
create or replace function public.openclaw_list_conversations_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_context jsonb;
  v_org uuid;
  v_account uuid;
  v_limit integer;
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_items jsonb;
begin
  perform app_private.openclaw_assert_strict_object_v1(
    p_request,
    array['version','organizationId','accountId','cursorLastReceivedAt','cursorId','limit'],
    array['version','organizationId','accountId']
  );
  v_context := app_private.openclaw_browser_context_v1(
    p_request, 'openclaw_zalo.view', 'xem hội thoại OpenClaw Zalo'
  );
  v_org := (v_context ->> 'organizationId')::uuid;
  v_account := (p_request ->> 'accountId')::uuid;
  v_limit := greatest(1, least(coalesce((p_request ->> 'limit')::integer, 50), 100));
  v_cursor_at := nullif(p_request ->> 'cursorLastReceivedAt', '')::timestamptz;
  v_cursor_id := nullif(p_request ->> 'cursorId', '')::uuid;
  select coalesce(jsonb_agg(item.payload order by item.last_received_at desc, item.id desc), '[]'::jsonb)
  into v_items
  from (
    select conversation.id, conversation.last_received_at,
      jsonb_build_object(
        'conversationId', conversation.id, 'targetId', conversation.target_id,
        'status', conversation.status, 'assignedMembershipId', conversation.assigned_membership_id,
        'unreadCount', conversation.unread_count,
        'lastReceivedAt', conversation.last_received_at,
        'lastMessageId', conversation.last_message_id, 'version', conversation.version,
        'targetKind', target.kind,
        'displayName', coalesce(
          nullif(contact.display_name, contact.provider_id),
          nullif(sales_group.display_name, sales_group.provider_id),
          -- Nhóm chưa đặt tên: gọi theo thành viên đã thấy.
          (
            select string_agg(member.display_name, ', ' order by member.display_name)
            from (
              select distinct member_row.display_name
              from public.openclaw_conversation_members member_row
              where member_row.organization_id = conversation.organization_id
                and member_row.account_id = conversation.account_id
                and member_row.conversation_id = conversation.id
                and member_row.display_name is not null
              limit 3
            ) member
          )
        ),
        'lastMessagePreview', (
          select left(message.text_content, 120)
          from public.openclaw_messages message
          where message.organization_id = conversation.organization_id
            and message.account_id = conversation.account_id
            and message.conversation_id = conversation.id
            and message.text_content is not null
          order by message.received_at desc
          limit 1
        )
      ) as payload
    from public.openclaw_conversations conversation
    left join public.openclaw_targets target
      on target.organization_id = conversation.organization_id
     and target.id = conversation.target_id
    left join public.openclaw_contacts contact on contact.id = target.contact_id
    left join public.openclaw_sales_groups sales_group on sales_group.id = target.sales_group_id
    where conversation.organization_id = v_org and conversation.account_id = v_account
      and (v_cursor_at is null or (conversation.last_received_at, conversation.id) < (v_cursor_at, v_cursor_id))
    order by conversation.last_received_at desc, conversation.id desc
    limit v_limit
  ) item;
  return jsonb_build_object('version', 1, 'items', v_items, 'limit', v_limit);
end;
$function$;

-- 4) Thread trả nội dung và người gửi.
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
        'senderName', member.display_name
      ) as payload
    from public.openclaw_messages m
    left join public.openclaw_conversation_members member
      on member.organization_id = m.organization_id
     and member.account_id = m.account_id
     and member.conversation_id = m.conversation_id
     and member.provider_member_id = m.provider_sender_id
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
