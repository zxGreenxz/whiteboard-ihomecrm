-- =============================================
-- Migration: Sự kiện trao thưởng + vòng xoay may mắn (/quayso).
--
-- Mô hình:
-- - Quản trị (đăng nhập, OWNER/STAFF của org) setup sự kiện: danh sách đội,
--   2 đội TOP nhận giải (không quay), giờ mở thưởng (draw_at), giá trị giải.
-- - Mỗi đội được CẤP SẴN MÃ 6 SỐ (trigger, unique TOÀN CỤC) — sale không đăng
--   nhập, vào /quayso nhập mã là định danh được cả đội lẫn sự kiện.
-- - Tới giờ draw_at, bất kỳ client nào gọi lucky_draw_v1 → server chọn ngẫu
--   nhiên 1 đội trong số ĐÃ ĐIỂM DANH và in_wheel, ghi winner MỘT LẦN
--   (FOR UPDATE + status machine) → mọi máy poll thấy cùng một kết quả.
--
-- Bảo mật:
-- - RLS bật trên cả 2 bảng, KHÔNG có policy → mọi truy cập trực tiếp bị chặn;
--   cổng duy nhất là các RPC SECURITY DEFINER dưới đây.
-- - RPC public không bao giờ trả về mã của đội khác.
-- - Mô hình "ai có mã/link thì xem được" giống contracts.public_code (xem
--   20260530000003): 12 mã trong không gian 10^6, payload chỉ có tên đội.
-- - Án lệ khoá dòng: lucky_draw_v1 / lucky_checkin_v1 lấy khoá → khai VOLATILE
--   (supabase.rpc + fetch đều POST). Hàm chỉ đọc mới để STABLE.
-- - Án lệ default privileges (DROP+CREATE hứng EXECUTE): mọi hàm đều REVOKE
--   PUBLIC trước khi GRANT đúng đối tượng.
-- =============================================

-- ========== 1) Bảng ==========

create table if not exists public.lucky_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  title text not null default 'IHOME · Trao thưởng',
  prize_label text not null default 'Giải may mắn',
  prize_amount numeric not null default 500000 check (prize_amount >= 0),
  draw_at timestamptz,
  status text not null default 'open' check (status in ('open', 'drawn', 'closed')),
  winner_team_id uuid,
  drawn_at timestamptz,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lucky_event_teams (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.lucky_events(id) on delete cascade,
  name text not null,
  deals int not null default 1 check (deals >= 0),
  code text not null default '',
  top_rank int check (top_rank between 1 and 3),
  top_prize_amount numeric check (top_prize_amount >= 0),
  in_wheel boolean not null default true,
  checked_in_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, name)
);

-- Mã unique TOÀN CỤC (không chỉ trong event) → nhập mã là đủ tìm ra sự kiện.
create unique index if not exists lucky_event_teams_code_key
  on public.lucky_event_teams(code);
create index if not exists lucky_event_teams_event_idx
  on public.lucky_event_teams(event_id);

alter table public.lucky_events
  drop constraint if exists lucky_events_winner_fk;
alter table public.lucky_events
  add constraint lucky_events_winner_fk
  foreign key (winner_team_id) references public.lucky_event_teams(id)
  on delete set null;

alter table public.lucky_events enable row level security;
alter table public.lucky_event_teams enable row level security;

-- ========== 2) Cấp mã 6 số ==========

create or replace function public.lucky_gen_code()
returns text
language plpgsql
volatile
set search_path to 'pg_catalog', 'public'
as $$
declare
  candidate text;
  tries int := 0;
begin
  loop
    -- 6 chữ số, cho phép 0 dẫn đầu ("042919" hợp lệ).
    candidate := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from public.lucky_event_teams where code = candidate);
    tries := tries + 1;
    if tries >= 20 then
      -- Không gian 10^6 gần cạn (không bao giờ xảy ra với vài chục đội) → nới 8 số.
      candidate := lpad((floor(random() * 100000000))::int::text, 8, '0');
      exit;
    end if;
  end loop;
  return candidate;
end;
$$;

create or replace function public.lucky_set_team_code()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $$
begin
  if new.code is null or new.code = '' then
    new.code := public.lucky_gen_code();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_lucky_set_team_code on public.lucky_event_teams;
create trigger trg_lucky_set_team_code
  before insert on public.lucky_event_teams
  for each row execute function public.lucky_set_team_code();

-- ========== 3) Resolver org cho RPC quản trị ==========
-- Cùng thứ tự chọn org như app_private.current_admin_org_v1 (membership ACTIVE,
-- org ACTIVE, ưu tiên org thật hơn DEMO) nhưng gate theo member_type
-- OWNER/STAFF thay vì quyền users.view — trang sự kiện không nằm trong ma trận
-- phân quyền theo sổ/toà.

create or replace function public.lucky_admin_org_v1()
returns uuid
language plpgsql
stable security definer
set search_path to 'pg_catalog', 'public'
as $$
declare v_org uuid;
begin
  if (select auth.uid()) is null then return null; end if;
  select m.organization_id into v_org
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id and o.status = 'ACTIVE'
   where m.user_id = (select auth.uid())
     and m.status = 'ACTIVE'
     and m.member_type in ('OWNER', 'STAFF')
   order by coalesce(o.is_demo, false), m.organization_id
   limit 1;
  return v_org;
end;
$$;

revoke execute on function public.lucky_admin_org_v1() from public, anon;
grant execute on function public.lucky_admin_org_v1() to authenticated;

-- ========== 4) Payload dùng chung ==========
-- p_viewer_team: đội của người xem (từ mã) để đánh dấu "đội của bạn".
-- KHÔNG trả code của bất kỳ đội nào.

create or replace function public.lucky_event_payload_v1(p_event uuid, p_viewer_team uuid default null)
returns jsonb
language plpgsql
stable security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_event jsonb;
  v_teams jsonb;
begin
  select jsonb_build_object(
    'id', e.id,
    'title', e.title,
    'prizeLabel', e.prize_label,
    'prizeAmount', e.prize_amount,
    'drawAt', e.draw_at,
    'status', e.status,
    'drawnAt', e.drawn_at,
    'winnerTeamId', e.winner_team_id,
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
    'deals', t.deals,
    'topRank', t.top_rank,
    'topPrizeAmount', t.top_prize_amount,
    'inWheel', t.in_wheel,
    'checkedIn', t.checked_in_at is not null,
    'checkedInAt', t.checked_in_at,
    'isMine', t.id = p_viewer_team
  ) order by coalesce(t.top_rank, 99), t.created_at), '[]'::jsonb)
  into v_teams
  from public.lucky_event_teams t
  where t.event_id = p_event;

  return jsonb_build_object('ok', true, 'event', v_event, 'teams', v_teams);
end;
$$;

-- Hàm lõi nội bộ: chỉ các RPC cổng gọi (SECURITY DEFINER chạy quyền owner).
revoke execute on function public.lucky_event_payload_v1(uuid, uuid) from public, anon, authenticated;

-- ========== 5) RPC PUBLIC (anon) ==========

-- Trạng thái sự kiện: theo link ?e=<uuid> hoặc theo mã đội.
create or replace function public.lucky_public_state_v1(p_event uuid default null, p_code text default null)
returns jsonb
language plpgsql
stable security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_event uuid := p_event;
  v_team uuid;
begin
  if p_code is not null and p_code <> '' then
    select t.event_id, t.id into v_event, v_team
    from public.lucky_event_teams t
    join public.lucky_events e on e.id = t.event_id
    where t.code = p_code and e.status <> 'closed'
    order by e.created_at desc
    limit 1;
    if v_team is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_code');
    end if;
    -- Mã thuộc sự kiện khác với link đang mở → link thắng, mã bị từ chối.
    if p_event is not null and v_event <> p_event then
      return jsonb_build_object('ok', false, 'reason', 'code_other_event');
    end if;
  end if;

  if v_event is null then
    return jsonb_build_object('ok', false, 'reason', 'missing_event');
  end if;

  return public.lucky_event_payload_v1(v_event, v_team);
end;
$$;

revoke execute on function public.lucky_public_state_v1(uuid, text) from public;
grant execute on function public.lucky_public_state_v1(uuid, text) to anon, authenticated;

-- Điểm danh bằng mã 6 số (one-way; quản trị mới gỡ được).
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
begin
  if p_code is null or p_code = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_code');
  end if;

  select t.id, t.event_id, e.status into v_team, v_event, v_status
  from public.lucky_event_teams t
  join public.lucky_events e on e.id = t.event_id
  where t.code = p_code and e.status <> 'closed'
  order by e.created_at desc
  limit 1
  for update of t;

  if v_team is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_code');
  end if;

  update public.lucky_event_teams
     set checked_in_at = coalesce(checked_in_at, now())
   where id = v_team;

  return public.lucky_event_payload_v1(v_event, v_team);
end;
$$;

revoke execute on function public.lucky_checkin_v1(text) from public;
grant execute on function public.lucky_checkin_v1(text) to anon, authenticated;

-- Mở thưởng: BẤT KỲ client nào gọi khi tới giờ; server chốt MỘT lần.
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
  if v_draw_at is null or now() < v_draw_at then
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

revoke execute on function public.lucky_draw_v1(uuid) from public;
grant execute on function public.lucky_draw_v1(uuid) to anon, authenticated;

-- ========== 6) RPC QUẢN TRỊ (authenticated, OWNER/STAFF) ==========

create or replace function public.lucky_admin_assert_event_v1(p_event uuid)
returns uuid
language plpgsql
stable security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_org uuid := public.lucky_admin_org_v1();
begin
  if v_org is null then
    raise exception 'Bạn không có quyền quản trị sự kiện.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.lucky_events where id = p_event and organization_id = v_org) then
    raise exception 'Sự kiện không thuộc tổ chức của bạn.' using errcode = '42501';
  end if;
  return v_org;
end;
$$;

revoke execute on function public.lucky_admin_assert_event_v1(uuid) from public, anon, authenticated;

-- Danh sách sự kiện của org (kèm MÃ — chỉ quản trị thấy).
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
      'title', e.title,
      'prizeLabel', e.prize_label,
      'prizeAmount', e.prize_amount,
      'drawAt', e.draw_at,
      'status', e.status,
      'drawnAt', e.drawn_at,
      'winnerTeamId', e.winner_team_id,
      'createdAt', e.created_at,
      'serverNow', now(),
      'teams', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', t.id, 'name', t.name, 'deals', t.deals, 'code', t.code,
          'topRank', t.top_rank, 'topPrizeAmount', t.top_prize_amount,
          'inWheel', t.in_wheel,
          'checkedIn', t.checked_in_at is not null, 'checkedInAt', t.checked_in_at
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

-- Tạo/sửa sự kiện.
create or replace function public.lucky_admin_upsert_event_v1(p jsonb)
returns jsonb
language plpgsql
volatile security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_org uuid := public.lucky_admin_org_v1();
  v_id uuid := nullif(p->>'id', '')::uuid;
begin
  if v_org is null then
    raise exception 'Bạn không có quyền quản trị sự kiện.' using errcode = '42501';
  end if;

  if v_id is null then
    insert into public.lucky_events (organization_id, title, prize_label, prize_amount, draw_at)
    values (
      v_org,
      coalesce(nullif(p->>'title', ''), 'IHOME · Trao thưởng'),
      coalesce(nullif(p->>'prizeLabel', ''), 'Giải may mắn'),
      coalesce((p->>'prizeAmount')::numeric, 500000),
      nullif(p->>'drawAt', '')::timestamptz
    )
    returning id into v_id;
  else
    perform public.lucky_admin_assert_event_v1(v_id);
    update public.lucky_events set
      title        = coalesce(nullif(p->>'title', ''), title),
      prize_label  = coalesce(nullif(p->>'prizeLabel', ''), prize_label),
      prize_amount = coalesce((p->>'prizeAmount')::numeric, prize_amount),
      -- drawAt gửi lên (kể cả rỗng = xoá hẹn giờ) mới đụng vào; vắng key thì giữ.
      draw_at      = case when p ? 'drawAt' then nullif(p->>'drawAt', '')::timestamptz else draw_at end,
      status       = case when p ? 'status' and (p->>'status') in ('open', 'closed') then p->>'status' else status end,
      updated_at   = now()
    where id = v_id;
  end if;

  return jsonb_build_object('ok', true, 'eventId', v_id);
end;
$$;

revoke execute on function public.lucky_admin_upsert_event_v1(jsonb) from public, anon;
grant execute on function public.lucky_admin_upsert_event_v1(jsonb) to authenticated;

-- Thêm đội (mã tự cấp qua trigger; trả về kèm mã).
create or replace function public.lucky_admin_add_team_v1(
  p_event uuid, p_name text, p_deals int default 1,
  p_top_rank int default null, p_top_prize numeric default null,
  p_in_wheel boolean default true
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
    raise exception 'Tên đội không được rỗng.' using errcode = '22023';
  end if;

  insert into public.lucky_event_teams (event_id, name, deals, top_rank, top_prize_amount, in_wheel)
  values (p_event, btrim(p_name), coalesce(p_deals, 1), p_top_rank, p_top_prize, coalesce(p_in_wheel, true))
  returning * into v_row;

  return jsonb_build_object('ok', true, 'teamId', v_row.id, 'code', v_row.code);
end;
$$;

revoke execute on function public.lucky_admin_add_team_v1(uuid, text, int, int, numeric, boolean) from public, anon;
grant execute on function public.lucky_admin_add_team_v1(uuid, text, int, int, numeric, boolean) to authenticated;

-- Sửa đội: name/deals/topRank/topPrizeAmount/inWheel/checkedIn/regenCode.
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

create or replace function public.lucky_admin_delete_team_v1(p_team uuid)
returns jsonb
language plpgsql
volatile security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_event uuid;
begin
  select event_id into v_event from public.lucky_event_teams where id = p_team;
  if v_event is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  perform public.lucky_admin_assert_event_v1(v_event);

  -- Đội đang là winner → FK on delete set null tự gỡ khỏi lucky_events.
  delete from public.lucky_event_teams where id = p_team;
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.lucky_admin_delete_team_v1(uuid) from public, anon;
grant execute on function public.lucky_admin_delete_team_v1(uuid) to authenticated;

-- Quay tay NGAY (MC bấm, bỏ qua giờ hẹn) — vẫn chỉ chọn trong đội đã điểm danh.
create or replace function public.lucky_admin_force_draw_v1(p_event uuid)
returns jsonb
language plpgsql
volatile security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_status text;
  v_winner uuid;
begin
  perform public.lucky_admin_assert_event_v1(p_event);

  select status into v_status from public.lucky_events where id = p_event for update;
  if v_status = 'drawn' then
    return public.lucky_event_payload_v1(p_event);
  end if;
  if v_status <> 'open' then
    return jsonb_build_object('ok', false, 'reason', 'closed');
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

revoke execute on function public.lucky_admin_force_draw_v1(uuid) from public, anon;
grant execute on function public.lucky_admin_force_draw_v1(uuid) to authenticated;

-- Huỷ kết quả để quay lại (sự kiện thử nháp / sự cố sân khấu).
create or replace function public.lucky_admin_reset_draw_v1(p_event uuid)
returns jsonb
language plpgsql
volatile security definer
set search_path to 'pg_catalog', 'public'
as $$
begin
  perform public.lucky_admin_assert_event_v1(p_event);
  update public.lucky_events
     set status = 'open', winner_team_id = null, drawn_at = null, updated_at = now()
   where id = p_event;
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.lucky_admin_reset_draw_v1(uuid) from public, anon;
grant execute on function public.lucky_admin_reset_draw_v1(uuid) to authenticated;

-- Hàm sinh mã / trigger: không cho gọi thẳng từ ngoài.
revoke execute on function public.lucky_gen_code() from public, anon, authenticated;
revoke execute on function public.lucky_set_team_code() from public, anon, authenticated;
