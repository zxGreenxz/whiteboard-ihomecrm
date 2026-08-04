-- =============================================
-- Migration: Đóng cửa điểm danh khi tới giờ quay.
--
-- Luật nghiệp vụ (chủ chốt 31/07/2026):
-- - Điểm danh chỉ hợp lệ TRƯỚC giờ mở thưởng (draw_at) và trước khi đã quay.
-- - Bấm mã sau đó → 'too_late', đội KHÔNG được tham gia quay thưởng.
-- - NGOẠI LỆ: đội ĐÃ điểm danh từ trước vẫn nhập mã vào xem bình thường
--   (đổi máy/mở lại trang sau khi quay xong để xem lại kết quả) — chỉ đội
--   CHƯA điểm danh mới bị từ chối.
--
-- Án lệ giữ nguyên: hàm lấy khoá dòng nên phải VOLATILE (25006).
-- =============================================

create or replace function public.lucky_checkin_v1(p_code text)
returns jsonb
language plpgsql
volatile security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_team uuid;
  v_event uuid;
  v_status text;
  v_draw_at timestamptz;
  v_checked timestamptz;
begin
  if p_code is null or p_code = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_code');
  end if;

  select t.id, t.event_id, e.status, e.draw_at, t.checked_in_at
    into v_team, v_event, v_status, v_draw_at, v_checked
  from public.lucky_event_teams t
  join public.lucky_events e on e.id = t.event_id
  where t.code = p_code and e.status <> 'closed'
  order by e.created_at desc
  limit 1
  for update of t;

  if v_team is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_code');
  end if;

  -- Cửa đã đóng: đã quay xong, HOẶC đã qua giờ hẹn mở thưởng.
  if v_checked is null
     and (v_status = 'drawn' or (v_draw_at is not null and now() >= v_draw_at)) then
    return jsonb_build_object('ok', false, 'reason', 'too_late');
  end if;

  update public.lucky_event_teams
     set checked_in_at = coalesce(checked_in_at, now())
   where id = v_team;

  return public.lucky_event_payload_v1(v_event, v_team);
end;
$$;

comment on function public.lucky_checkin_v1(text) is
'Điểm danh bằng mã 6 số. Trả too_late nếu đội CHƯA điểm danh mà đã qua draw_at hoặc sự kiện đã quay; đội đã điểm danh trước đó vẫn vào xem được.';

revoke execute on function public.lucky_checkin_v1(text) from public;
grant execute on function public.lucky_checkin_v1(text) to anon, authenticated;
