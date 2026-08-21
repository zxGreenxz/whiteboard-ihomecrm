-- =============================================================================
-- /quayso: MỘT SỰ KIỆN — NHIỀU LƯỢT ĐUA LIÊN TIẾP, MỖI LƯỢT NHIỀU GIẢI
--
-- Trước: một sự kiện = một giải = một đội trúng (`lucky_events.winner_team_id`).
-- Nay:   một sự kiện có DANH SÁCH LƯỢT, mỗi lượt có giá trị giải và SỐ SUẤT.
--        Ví dụ đêm tổng kết: lượt 1 = 100.000 ₫ × 3 suất, lượt 2 = 200.000 ₫ × 2,
--        lượt 3 = 500.000 ₫ × 1. Đua xong lượt này mới sang lượt sau.
--
-- HAI ĐIỀU LÀM NÊN LUẬT CHƠI, ĐỌC KỸ TRƯỚC KHI SỬA:
--
--  1. MỖI LƯỢT BỐC LẠI TỪ TOÀN BỘ VÉ ĐÃ ĐIỂM DANH — không loại vé đã trúng.
--     Đây là CHỦ Ý, không phải quên: chủ giải công bố "1 người trúng được nhiều
--     giải". Trong CÙNG một lượt thì các suất phải khác vé nhau (unique bên
--     dưới), nhưng qua lượt sau thì vé cũ lại vào cơ hội như mọi vé khác.
--
--  2. ĐƠN VỊ THAM GIA LÀ VÉ, KHÔNG PHẢI NGƯỜI. Một sale ôm nhiều vé thì có
--     nhiều cửa — đúng khẩu hiệu "càng nhiều vé cơ hội càng cao". Cột `sale`
--     thêm ở đây chỉ để GOM NHÓM khi cộng sổ và hiển thị, KHÔNG được đem vào
--     phép bốc: bốc theo sale là phá luôn ý nghĩa của tấm vé.
--
-- KHÔNG ĐỔI: sự kiện không khai lượt nào thì chạy y hệt trước — một giải, một
-- đội trúng, `lucky_draw_v1` nguyên vẹn. Toàn bộ sự kiện đang tồn tại rơi vào
-- nhánh này nên không có gì đổi sau lưng người đã cầm link.
--
-- CHỐNG NHẢY CÓC: `lucky_draw_round_v1` nhận SỐ THỨ TỰ LƯỢT chứ không tự tìm
-- "lượt kế tiếp". Nếu tự tìm thì hai máy cùng bấm sẽ thành: máy A chốt lượt 1,
-- máy B (đang chờ khoá) thấy lượt 1 xong bèn chốt luôn lượt 2 — cháy một lượt
-- mà chưa ai kịp xem. Có số thứ tự thì lần gọi thứ hai là idempotent.
--
-- Án lệ default privileges: mọi hàm REVOKE PUBLIC trước khi GRANT đúng đối tượng.
-- Án lệ khoá dòng: hàm lấy khoá phải khai VOLATILE.
-- =============================================================================

-- ========== 1) Vé thuộc về ai + độ dài cuộc đua ==========

alter table public.lucky_event_teams
  add column if not exists sale text;

comment on column public.lucky_event_teams.sale is
  'Mã sale sở hữu tấm vé này (vd 1392QT). CHỈ dùng để gom nhóm khi cộng sổ và hiển thị — KHÔNG được đem vào phép bốc, vì đơn vị tham gia là VÉ chứ không phải người.';

alter table public.lucky_events
  add column if not exists race_seconds int not null default 20;

alter table public.lucky_events
  drop constraint if exists lucky_events_race_seconds_check;
alter table public.lucky_events
  add constraint lucky_events_race_seconds_check
  check (race_seconds between 8 and 45);

comment on column public.lucky_events.race_seconds is
  'Độ dài một lượt đua (giây), 8–45. Ngắn hơn 8 thì chưa kịp nhìn, dài hơn 45 thì người xem bỏ đi.';

-- ========== 2) Lượt đua và kết quả từng lượt ==========

create table if not exists public.lucky_event_rounds (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.lucky_events(id) on delete cascade,
  ordinal int not null check (ordinal >= 1),
  label text not null default '',
  amount numeric not null default 0 check (amount >= 0),
  winners_count int not null default 1 check (winners_count between 1 and 50),
  status text not null default 'pending' check (status in ('pending', 'drawn')),
  drawn_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, ordinal)
);

create index if not exists lucky_event_rounds_event_idx
  on public.lucky_event_rounds(event_id, ordinal);

create table if not exists public.lucky_round_winners (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.lucky_event_rounds(id) on delete cascade,
  event_id uuid not null references public.lucky_events(id) on delete cascade,
  team_id uuid not null references public.lucky_event_teams(id) on delete cascade,
  position int not null check (position >= 1),
  amount numeric not null default 0 check (amount >= 0),
  created_at timestamptz not null default now(),
  -- Trong CÙNG một lượt: mỗi suất một vé, và một vé không ôm hai suất.
  -- Qua lượt khác thì không cấm — xem luật #1 ở đầu file.
  unique (round_id, position),
  unique (round_id, team_id)
);

create index if not exists lucky_round_winners_event_idx
  on public.lucky_round_winners(event_id);

alter table public.lucky_event_rounds enable row level security;
alter table public.lucky_round_winners enable row level security;
-- KHÔNG policy: cổng duy nhất là các RPC SECURITY DEFINER dưới đây, giống hệt
-- hai bảng lucky_* đã có (xem 20260731070000).

-- ========== 3) Payload công khai: kèm lượt + vé trúng + sale ==========

create or replace function public.lucky_event_payload_v1(p_event uuid, p_viewer_team uuid default null)
returns jsonb
language plpgsql
stable security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_event jsonb;
  v_teams jsonb;
  v_rounds jsonb;
begin
  select jsonb_build_object(
    'id', e.id,
    'slug', e.slug,
    'title', e.title,
    'prizeLabel', e.prize_label,
    'prizeAmount', e.prize_amount,
    'drawAt', e.draw_at,
    'status', e.status,
    'drawnAt', e.drawn_at,
    'winnerTeamId', e.winner_team_id,
    'game', e.game,
    'raceSeconds', e.race_seconds,
    'serverNow', now()
  ) into v_event
  from public.lucky_events e
  where e.id = p_event;

  if v_event is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id,
    'name', t.name,
    'sale', t.sale,
    'deals', t.deals,
    'topRank', t.top_rank,
    'topPrizeAmount', t.top_prize_amount,
    'inWheel', t.in_wheel,
    'checkedIn', t.checked_in_at is not null,
    'checkedInAt', t.checked_in_at,
    'isMine', t.id = p_viewer_team,
    'payoutAccount', case when t.id = p_viewer_team then t.payout_account end,
    'payoutBank',    case when t.id = p_viewer_team then t.payout_bank end,
    'payoutHolder',  case when t.id = p_viewer_team then t.payout_holder end,
    'proofs',        case when t.id = p_viewer_team then t.proofs else '[]'::jsonb end,
    'proofCount',    jsonb_array_length(t.proofs)
  ) order by coalesce(t.top_rank, 99), t.created_at), '[]'::jsonb)
  into v_teams
  from public.lucky_event_teams t
  where t.event_id = p_event;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'ordinal', r.ordinal,
    'label', r.label,
    'amount', r.amount,
    'winnersCount', r.winners_count,
    'status', r.status,
    'drawnAt', r.drawn_at,
    'winners', coalesce((
      select jsonb_agg(jsonb_build_object(
        'teamId', w.team_id, 'position', w.position, 'amount', w.amount
      ) order by w.position)
      from public.lucky_round_winners w where w.round_id = r.id), '[]'::jsonb)
  ) order by r.ordinal), '[]'::jsonb)
  into v_rounds
  from public.lucky_event_rounds r
  where r.event_id = p_event;

  return jsonb_build_object('ok', true, 'event', v_event, 'teams', v_teams, 'rounds', v_rounds);
end;
$$;

revoke execute on function public.lucky_event_payload_v1(uuid, uuid) from public, anon, authenticated;

-- ========== 4) Chốt kết quả MỘT LƯỢT ==========

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
  -- Khoá sự kiện: hai máy cùng bấm thì máy sau chờ, rồi thấy lượt đã chốt và
  -- rơi vào nhánh idempotent bên dưới.
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
  -- draw_at NULL = quay tay (án lệ 20260731130000); có hẹn giờ thì phải tới giờ.
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

  -- Không cho nhảy cóc: lượt trước chưa xong thì chưa tới lượt này.
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

  -- Ít vé hơn số suất thì trao hết số vé đang có, còn hơn là không trao được gì.
  v_need := least(v_need, v_co);

  -- `row_number() over (order by gen_random_uuid())` bốc ngẫu nhiên VÀ đánh số
  -- thứ hạng trong cùng một lượt quét. Tách ORDER BY ra ngoài INSERT thì thứ tự
  -- chèn không bảo đảm khớp với `position`.
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

  -- Hết lượt → đóng sổ. `winner_team_id` ghi vé trúng GIẢI CAO NHẤT (lượt cuối,
  -- hạng nhất) để mọi thứ đang đọc trường cũ vẫn thấy một câu trả lời hợp lý.
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
'Chốt kết quả MỘT lượt đua (idempotent theo ordinal). Bốc lại từ TOÀN BỘ vé đã điểm danh — vé trúng lượt trước vẫn có cửa, vì luật là "1 người trúng được nhiều giải". Không cho nhảy cóc lượt.';

revoke execute on function public.lucky_draw_round_v1(uuid, int) from public;
grant execute on function public.lucky_draw_round_v1(uuid, int) to anon, authenticated;

-- ========== 5) Quản trị: khai danh sách lượt ==========

create or replace function public.lucky_admin_set_rounds_v1(p_event uuid, p_rounds jsonb)
returns jsonb
language plpgsql
volatile security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_n int;
begin
  perform public.lucky_admin_assert_event_v1(p_event);

  if p_rounds is null or jsonb_typeof(p_rounds) <> 'array' then
    raise exception 'Danh sách lượt phải là mảng.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rounds) > 20 then
    raise exception 'Tối đa 20 lượt cho một sự kiện.' using errcode = '22023';
  end if;

  -- Đã quay rồi mà đổi thể lệ giữa chừng là thay luật khi cuộc chơi đang chạy.
  if exists (select 1 from public.lucky_event_rounds
             where event_id = p_event and status = 'drawn') then
    raise exception 'Sự kiện đã quay ít nhất một lượt — bấm "Đặt lại kết quả" trước khi đổi thể lệ.'
      using errcode = '22023';
  end if;

  delete from public.lucky_event_rounds where event_id = p_event;

  insert into public.lucky_event_rounds (event_id, ordinal, label, amount, winners_count)
  select p_event,
         (ord.i)::int,
         coalesce(nullif(btrim(r->>'label'), ''), ''),
         greatest(0, coalesce((r->>'amount')::numeric, 0)),
         least(50, greatest(1, coalesce((r->>'winnersCount')::int, 1)))
  from jsonb_array_elements(p_rounds) with ordinality as ord(r, i);

  select count(*) into v_n from public.lucky_event_rounds where event_id = p_event;
  return jsonb_build_object('ok', true, 'rounds', v_n);
end;
$$;

revoke execute on function public.lucky_admin_set_rounds_v1(uuid, jsonb) from public, anon;
grant execute on function public.lucky_admin_set_rounds_v1(uuid, jsonb) to authenticated;

-- ========== 6) Quản trị: vé có chủ (mã sale) ==========

-- VÌ SAO DROP TRƯỚC: thêm tham số DEFAULT vào hàm sẵn có tạo OVERLOAD (6 vs 7
-- tham số) → PostgREST gọi bằng named args dính "function is not unique".
-- Án lệ 20260806090000 và 20260820090000 đã trả giá đúng chỗ này.
drop function if exists public.lucky_admin_add_team_v1(uuid, text, int, int, numeric, boolean);

create or replace function public.lucky_admin_add_team_v1(
  p_event uuid, p_name text, p_deals int default 1,
  p_top_rank int default null, p_top_prize numeric default null,
  p_in_wheel boolean default true, p_sale text default null
)
returns jsonb
language plpgsql
volatile security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_row public.lucky_event_teams;
begin
  perform public.lucky_admin_assert_event_v1(p_event);
  if p_name is null or btrim(p_name) = '' then
    raise exception 'Tên vé không được rỗng.' using errcode = '22023';
  end if;

  insert into public.lucky_event_teams
    (event_id, name, deals, top_rank, top_prize_amount, in_wheel, sale)
  values (p_event, btrim(p_name), coalesce(p_deals, 1), p_top_rank, p_top_prize,
          coalesce(p_in_wheel, true), nullif(btrim(coalesce(p_sale, '')), ''))
  returning * into v_row;

  return jsonb_build_object('ok', true, 'teamId', v_row.id, 'code', v_row.code);
end;
$$;

revoke execute on function public.lucky_admin_add_team_v1(uuid, text, int, int, numeric, boolean, text)
  from public, anon;
grant execute on function public.lucky_admin_add_team_v1(uuid, text, int, int, numeric, boolean, text)
  to authenticated;

-- Sửa vé: thêm khoá `sale` vào payload jsonb (chữ ký không đổi nên không overload).
create or replace function public.lucky_admin_update_team_v1(p_team uuid, p jsonb)
returns jsonb
language plpgsql
volatile security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_event uuid;
  v_code text;
begin
  select event_id into v_event from public.lucky_event_teams where id = p_team;
  if v_event is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  perform public.lucky_admin_assert_event_v1(v_event);

  update public.lucky_event_teams set
    name             = coalesce(nullif(btrim(p->>'name'), ''), name),
    sale             = case when p ? 'sale' then nullif(btrim(coalesce(p->>'sale', '')), '') else sale end,
    deals            = coalesce((p->>'deals')::int, deals),
    top_rank         = case when p ? 'topRank' then nullif(p->>'topRank', '')::int else top_rank end,
    top_prize_amount = case when p ? 'topPrizeAmount' then nullif(p->>'topPrizeAmount', '')::numeric else top_prize_amount end,
    in_wheel         = coalesce((p->>'inWheel')::boolean, in_wheel),
    checked_in_at    = case
                         when p ? 'checkedIn' and (p->>'checkedIn')::boolean then coalesce(checked_in_at, now())
                         when p ? 'checkedIn' then null
                         else checked_in_at
                       end,
    code             = case when coalesce((p->>'regenCode')::boolean, false) then public.lucky_gen_code() else code end
  where id = p_team
  returning code into v_code;

  return jsonb_build_object('ok', true, 'teamId', p_team, 'code', v_code);
end;
$$;

revoke execute on function public.lucky_admin_update_team_v1(uuid, jsonb) from public, anon;
grant execute on function public.lucky_admin_update_team_v1(uuid, jsonb) to authenticated;

-- ========== 7) Payload quản trị: kèm lượt, sale, race_seconds ==========

create or replace function public.lucky_admin_get_v1()
returns jsonb
language plpgsql
stable security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_org uuid := public.lucky_admin_org_v1();
  v_out jsonb;
begin
  if v_org is null then
    raise exception 'Bạn không có quyền quản trị sự kiện.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(ev order by (ev->>'createdAt') desc), '[]'::jsonb) into v_out
  from (
    select jsonb_build_object(
      'id', e.id,
      'slug', e.slug,
      'title', e.title,
      'prizeLabel', e.prize_label,
      'prizeAmount', e.prize_amount,
      'drawAt', e.draw_at,
      'status', e.status,
      'drawnAt', e.drawn_at,
      'winnerTeamId', e.winner_team_id,
      'game', e.game,
      'raceSeconds', e.race_seconds,
      'createdAt', e.created_at,
      'serverNow', now(),
      'rounds', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', r.id, 'ordinal', r.ordinal, 'label', r.label, 'amount', r.amount,
          'winnersCount', r.winners_count, 'status', r.status, 'drawnAt', r.drawn_at,
          'winners', coalesce((
            select jsonb_agg(jsonb_build_object(
              'teamId', w.team_id, 'position', w.position, 'amount', w.amount
            ) order by w.position)
            from public.lucky_round_winners w where w.round_id = r.id), '[]'::jsonb)
        ) order by r.ordinal)
        from public.lucky_event_rounds r where r.event_id = e.id), '[]'::jsonb),
      'teams', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', t.id, 'name', t.name, 'sale', t.sale, 'deals', t.deals, 'code', t.code,
          'topRank', t.top_rank, 'topPrizeAmount', t.top_prize_amount,
          'inWheel', t.in_wheel,
          'checkedIn', t.checked_in_at is not null, 'checkedInAt', t.checked_in_at,
          'payoutAccount', t.payout_account,
          'payoutBank', t.payout_bank,
          'payoutHolder', t.payout_holder,
          'proofs', t.proofs,
          'proofUploadedAt', t.proof_uploaded_at
        ) order by coalesce(t.top_rank, 99), t.created_at)
        from public.lucky_event_teams t where t.event_id = e.id), '[]'::jsonb)
    ) as ev
    from public.lucky_events e
    where e.organization_id = v_org
  ) s;

  return jsonb_build_object('ok', true, 'organizationId', v_org, 'events', v_out);
end;
$$;

revoke execute on function public.lucky_admin_get_v1() from public, anon;
grant execute on function public.lucky_admin_get_v1() to authenticated;

-- ========== 8) Quản trị: đặt độ dài cuộc đua ==========

create or replace function public.lucky_admin_upsert_event_v1(p jsonb)
returns jsonb
language plpgsql
volatile security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_org uuid := public.lucky_admin_org_v1();
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_slug text := lower(btrim(coalesce(p->>'slug', '')));
  v_game text := nullif(btrim(coalesce(p->>'game', '')), '');
  v_secs int := nullif(p->>'raceSeconds', '')::int;
begin
  if v_org is null then
    raise exception 'Bạn không có quyền quản trị sự kiện.' using errcode = '42501';
  end if;

  if v_slug <> '' and (v_slug !~ '^[a-z0-9][a-z0-9-]{1,31}$' or v_slug = 'admin') then
    raise exception 'Đường dẫn chỉ gồm chữ thường, số và gạch ngang (2–32 ký tự), không được là "admin".'
      using errcode = '22023';
  end if;
  if v_slug <> '' and exists (
    select 1 from public.lucky_events where slug = v_slug and (v_id is null or id <> v_id)
  ) then
    raise exception 'Đường dẫn "%" đã có sự kiện khác dùng rồi.', v_slug using errcode = '23505';
  end if;

  if v_game is not null and v_game not in ('wheel', 'race') then
    raise exception 'Trò chơi "%" không có trong danh sách (wheel, race).', v_game
      using errcode = '22023';
  end if;
  if v_secs is not null and (v_secs < 8 or v_secs > 45) then
    raise exception 'Độ dài cuộc đua phải trong khoảng 8–45 giây.' using errcode = '22023';
  end if;

  if v_id is null then
    insert into public.lucky_events
      (organization_id, title, prize_label, prize_amount, draw_at, slug, game, race_seconds)
    values (
      v_org,
      coalesce(nullif(p->>'title', ''), 'IHOME · Trao thưởng'),
      coalesce(nullif(p->>'prizeLabel', ''), 'Giải may mắn'),
      coalesce((p->>'prizeAmount')::numeric, 500000),
      nullif(p->>'drawAt', '')::timestamptz,
      nullif(v_slug, ''),
      coalesce(v_game, 'wheel'),
      coalesce(v_secs, 20)
    )
    returning id into v_id;
  else
    perform public.lucky_admin_assert_event_v1(v_id);
    update public.lucky_events set
      title        = coalesce(nullif(p->>'title', ''), title),
      prize_label  = coalesce(nullif(p->>'prizeLabel', ''), prize_label),
      prize_amount = coalesce((p->>'prizeAmount')::numeric, prize_amount),
      slug         = case when v_slug <> '' then v_slug else slug end,
      game         = coalesce(v_game, game),
      race_seconds = coalesce(v_secs, race_seconds),
      draw_at      = case when p ? 'drawAt' then nullif(p->>'drawAt', '')::timestamptz else draw_at end,
      status       = case when p ? 'status' and (p->>'status') in ('open', 'closed') then p->>'status' else status end,
      updated_at   = now()
    where id = v_id;
  end if;

  return jsonb_build_object('ok', true, 'eventId', v_id,
                            'slug', (select slug from public.lucky_events where id = v_id),
                            'game', (select game from public.lucky_events where id = v_id));
end;
$$;

revoke execute on function public.lucky_admin_upsert_event_v1(jsonb) from public, anon;
grant execute on function public.lucky_admin_upsert_event_v1(jsonb) to authenticated;

-- ========== 9) Đặt lại kết quả cũng phải dọn lượt ==========

create or replace function public.lucky_admin_reset_draw_v1(p_event uuid)
returns jsonb
language plpgsql
volatile security definer
set search_path to 'pg_catalog', 'public'
as $$
begin
  perform public.lucky_admin_assert_event_v1(p_event);

  delete from public.lucky_round_winners where event_id = p_event;
  update public.lucky_event_rounds
     set status = 'pending', drawn_at = null
   where event_id = p_event;

  update public.lucky_events
     set status = 'open', winner_team_id = null, drawn_at = null, updated_at = now()
   where id = p_event;

  -- Giữ NGUYÊN dạng trả về cũ `{ok:true}`: hàm này đã có người gọi, đổi hợp
  -- đồng để trả payload thì được thêm dữ liệu nhưng phải sửa nơi gọi, mà nơi
  -- gọi vốn đã nạp lại danh sách sau khi đặt lại.
  return jsonb_build_object('ok', true);
end;
$$;

comment on function public.lucky_admin_reset_draw_v1(uuid) is
'Đặt lại kết quả để quay lại từ đầu. Từ 21/08/2026 dọn CẢ kết quả từng lượt — bỏ sót chúng thì sự kiện mở lại nhưng mọi lượt vẫn "drawn", bấm quay không lên.';

revoke execute on function public.lucky_admin_reset_draw_v1(uuid) from public, anon;
grant execute on function public.lucky_admin_reset_draw_v1(uuid) to authenticated;
