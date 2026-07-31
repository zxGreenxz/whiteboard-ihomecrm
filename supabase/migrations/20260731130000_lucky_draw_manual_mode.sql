-- =============================================
-- Migration: Cho phép quay tay khi BTC chưa đặt giờ mở thưởng.
--
-- Trước: lucky_draw_v1 chỉ chạy khi `now() >= draw_at`; draw_at NULL → 'not_time'
--        ⇒ màn quay công khai không bấm quay được, phải vào trang quản trị.
-- Sau:   draw_at NULL = CHẾ ĐỘ QUAY TAY, ai mở màn quay cũng bấm được.
--        draw_at có giá trị thì vẫn phải tới giờ (giữ nguyên luật hẹn giờ).
--
-- Đánh đổi đã cân nhắc: link màn quay là link công khai, nên ai có link cũng
-- chốt được kết quả khi ở chế độ quay tay. Chấp nhận được vì (1) kết quả chốt
-- MỘT LẦN duy nhất rồi khoá — gọi lại chỉ trả về kết quả cũ, (2) chỉ bốc trong
-- các đội ĐÃ ĐIỂM DANH, (3) chủ sự kiện tự quyết lúc nào phát link. Muốn chặt
-- hơn thì đặt draw_at.
-- =============================================

create or replace function public.lucky_draw_v1(p_event uuid)
returns jsonb
language plpgsql
volatile security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_status text;
  v_draw_at timestamptz;
  v_winner uuid;
begin
  select status, draw_at into v_status, v_draw_at
  from public.lucky_events
  where id = p_event
  for update;

  if v_status is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_status = 'drawn' then
    return public.lucky_event_payload_v1(p_event);  -- idempotent: trả kết quả đã chốt
  end if;
  if v_status <> 'open' then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  -- draw_at NULL = quay tay, cho phép. Có hẹn giờ thì phải tới giờ.
  if v_draw_at is not null and now() < v_draw_at then
    return jsonb_build_object('ok', false, 'reason', 'not_time');
  end if;

  select id into v_winner
  from public.lucky_event_teams
  where event_id = p_event and in_wheel and checked_in_at is not null
  order by gen_random_uuid()
  limit 1;

  if v_winner is null then
    return jsonb_build_object('ok', false, 'reason', 'no_checked_in_teams');
  end if;

  update public.lucky_events
     set status = 'drawn', winner_team_id = v_winner,
         drawn_at = now(), updated_at = now()
   where id = p_event;

  return public.lucky_event_payload_v1(p_event);
end;
$$;

comment on function public.lucky_draw_v1(uuid) is
'Chốt đội trúng MỘT LẦN. draw_at NULL = quay tay (màn quay công khai bấm được); có draw_at thì phải tới giờ. Gọi lại khi đã drawn chỉ trả kết quả cũ.';

revoke execute on function public.lucky_draw_v1(uuid) from public;
grant execute on function public.lucky_draw_v1(uuid) to anon, authenticated;
