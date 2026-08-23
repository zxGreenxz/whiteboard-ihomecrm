-- =============================================================================
-- /quayso: CHỐT KẾT QUẢ LÀ QUYỀN QUẢN TRỊ
--
-- LUẬT MỚI, một câu:
--   Chốt kết quả cần quyền quản trị sự kiện. NGOẠI LỆ DUY NHẤT là sự kiện đã
--   HẸN GIỜ và đã TỚI GIỜ — lúc đó trang công khai được phép tự chốt, vì đó
--   chính là cơ chế "quay tự động đúng giờ, không cần ai bấm".
--
-- VÌ SAO PHẢI SỬA
--   Án lệ 20260731130000 mở `lucky_draw_v1` cho `anon` ở CHẾ ĐỘ QUAY TAY
--   (`draw_at` null), với lý lẽ: link màn quay vốn công khai, kết quả chỉ chốt
--   một lần rồi khoá, nên ai bấm cũng như nhau. Lý lẽ đó CHỈ đúng khi sự kiện
--   có đúng MỘT giải.
--
--   Ngày 21/08 tôi bê nguyên án lệ đó sang `lucky_draw_round_v1` cho sự kiện
--   nhiều lượt. Ở đó nó sai hẳn: một người cầm link có thể bấm liên tiếp và
--   ĐỐT SẠCH cả 3 lượt trước khi chủ giải kịp giới thiệu lượt nào. Không mất
--   tiền, không lộ dữ liệu, nhưng buổi trao thưởng thì hỏng — và hỏng theo cách
--   không hoàn tác được trên sân khấu.
--
--   "Giao diện người xem không có nút" KHÔNG phải hàng rào: RPC gọi thẳng được.
--
-- HAI THAY ĐỔI
--   1. `lucky_draw_round_v1`: THU HỒI quyền của `anon`. Nhiều lượt luôn do chủ
--      giải điều nhịp, không có nhu cầu tự chạy theo giờ.
--   2. `lucky_draw_v1`: GIỮ quyền `anon` (bỏ đi là chết cơ chế tự quay đúng
--      giờ, thứ trang điểm danh đang dựa vào), nhưng ở CHẾ ĐỘ QUAY TAY thì đòi
--      quản trị. Hẹn giờ + đã tới giờ vẫn cho anon như cũ.
--
-- Thêm `lucky_is_event_admin_v1` — bản KHÔNG NÉM LỖI của `assert`, để hàm gọi
-- bởi anon hỏi được "người này có phải quản trị không" mà không làm vỡ giao dịch.
--
-- Án lệ default privileges: mọi hàm REVOKE PUBLIC trước khi GRANT đúng đối tượng.
-- =============================================================================

-- ========== 1) Hỏi quyền mà không ném lỗi ==========

create or replace function public.lucky_is_event_admin_v1(p_event uuid)
returns boolean
language plpgsql
stable security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_org uuid := public.lucky_admin_org_v1();
begin
  -- anon → auth.uid() null → v_org null → false. Không ném, không lộ gì.
  if v_org is null then
    return false;
  end if;
  return exists (
    select 1 from public.lucky_events
    where id = p_event and organization_id = v_org
  );
end;
$$;

comment on function public.lucky_is_event_admin_v1(uuid) is
'Bản KHÔNG NÉM LỖI của lucky_admin_assert_event_v1. Dùng bên trong hàm mà anon gọi được, để rẽ nhánh theo quyền thay vì làm vỡ giao dịch.';

revoke execute on function public.lucky_is_event_admin_v1(uuid) from public, anon, authenticated;

-- ========== 2) Nhiều lượt: CHỈ quản trị ==========

create or replace function public.lucky_draw_round_v1(p_event uuid, p_ordinal int)
returns jsonb
language plpgsql
volatile security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_status text;
  v_draw_at timestamptz;
  v_round_id uuid;
  v_round_status text;
  v_need int;
  v_amount numeric;
  v_co int;
  v_con_lai int;
begin
  -- ── CỬA QUYỀN, đặt TRƯỚC mọi thứ khác ──
  -- Không dùng `assert` (ném lỗi) mà trả `reason`: hàm này gọi từ giao diện,
  -- ném 42501 ra thành "Không quay được, thử lại" — vô nghĩa với người bấm.
  if not public.lucky_is_event_admin_v1(p_event) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  select status, draw_at into v_status, v_draw_at
  from public.lucky_events
  where id = p_event
  for update;

  if v_status is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_status = 'closed' then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if v_draw_at is not null and now() < v_draw_at then
    return jsonb_build_object('ok', false, 'reason', 'not_time');
  end if;

  select id, status, winners_count, amount
    into v_round_id, v_round_status, v_need, v_amount
  from public.lucky_event_rounds
  where event_id = p_event and ordinal = p_ordinal;

  if v_round_id is null then
    return jsonb_build_object('ok', false, 'reason', 'round_not_found');
  end if;
  if v_round_status = 'drawn' then
    return public.lucky_event_payload_v1(p_event);  -- idempotent
  end if;

  if exists (
    select 1 from public.lucky_event_rounds
    where event_id = p_event and ordinal < p_ordinal and status <> 'drawn'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'previous_round_pending');
  end if;

  select count(*) into v_co
  from public.lucky_event_teams
  where event_id = p_event and in_wheel and checked_in_at is not null;

  if v_co = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_checked_in_teams');
  end if;

  v_need := least(v_need, v_co);

  with boc as (
    select id, row_number() over (order by gen_random_uuid()) as rn
    from public.lucky_event_teams
    where event_id = p_event and in_wheel and checked_in_at is not null
  )
  insert into public.lucky_round_winners (round_id, event_id, team_id, position, amount)
  select v_round_id, p_event, boc.id, boc.rn, v_amount
  from boc
  where boc.rn <= v_need;

  update public.lucky_event_rounds
     set status = 'drawn', drawn_at = now()
   where id = v_round_id;

  select count(*) into v_con_lai
  from public.lucky_event_rounds
  where event_id = p_event and status <> 'drawn';

  if v_con_lai = 0 then
    update public.lucky_events e
       set status = 'drawn',
           drawn_at = now(),
           updated_at = now(),
           winner_team_id = (
             select w.team_id
             from public.lucky_round_winners w
             join public.lucky_event_rounds r on r.id = w.round_id
             where w.event_id = p_event
             order by r.ordinal desc, w.position asc
             limit 1)
     where e.id = p_event;
  end if;

  return public.lucky_event_payload_v1(p_event);
end;
$$;

comment on function public.lucky_draw_round_v1(uuid, int) is
'Chốt kết quả MỘT lượt (idempotent theo ordinal). CHỈ quản trị sự kiện — người cầm link công khai không chốt được, vì nhiều lượt thì họ đốt sạch được cả buổi. Bốc lại từ TOÀN BỘ vé đã điểm danh: "1 người trúng được nhiều giải".';

-- THU HỒI quyền của anon. Từ đây hàm không còn là public endpoint.
revoke execute on function public.lucky_draw_round_v1(uuid, int) from public, anon;
grant execute on function public.lucky_draw_round_v1(uuid, int) to authenticated;

-- ========== 3) Một giải: quay tay đòi quản trị, hẹn giờ vẫn tự chạy ==========

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
    return public.lucky_event_payload_v1(p_event);  -- idempotent
  end if;
  if v_status <> 'open' then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;

  -- ── CỬA QUYỀN ──
  -- draw_at NULL = quay tay: giờ đòi quản trị. Trước đây ai cầm link cũng chốt
  -- được, và với sự kiện nhiều lượt điều đó đã cho thấy hậu quả thật.
  -- draw_at có giá trị = hẹn giờ: PHẢI giữ cho anon, vì chính trang điểm danh
  -- của người xem là thứ gọi hàm này khi đồng hồ về 0 — đó là cơ chế "quay tự
  -- động đúng giờ, không cần ai bấm". Bỏ đi là chết tính năng.
  if v_draw_at is null then
    if not public.lucky_is_event_admin_v1(p_event) then
      return jsonb_build_object('ok', false, 'reason', 'forbidden');
    end if;
  elsif now() < v_draw_at then
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
'Chốt đội trúng MỘT LẦN. Quay tay (draw_at NULL) CHỈ quản trị bấm được. Hẹn giờ thì trang công khai tự chốt khi tới giờ — anon giữ quyền đúng cho đường này. Gọi lại khi đã drawn chỉ trả kết quả cũ.';

revoke execute on function public.lucky_draw_v1(uuid) from public;
grant execute on function public.lucky_draw_v1(uuid) to anon, authenticated;
