-- =============================================
-- Migration: Đường dẫn ngắn cho sự kiện quay số.
--
-- Trước: /quayso?e=1379804c-94db-4cd7-94e0-7e7e93352bda (UUID 36 ký tự, dán
--        vào group Zalo nhìn như link rác).
-- Sau:   /quayso/nodeal
--
-- - `slug` unique toàn cục, chữ thường + số + gạch ngang, 2–32 ký tự.
-- - Tự sinh mã 6 ký tự nếu quản trị không đặt tên riêng.
-- - 'admin' là slug CẤM (đụng route /quayso/admin).
-- - Link cũ ?e=<uuid> vẫn chạy: RPC nhận cả hai.
-- =============================================

alter table public.lucky_events
  add column if not exists slug text;

create or replace function public.lucky_gen_slug()
returns text
language plpgsql
volatile
set search_path to 'pg_catalog', 'public'
as $$
declare
  alphabet text := 'abcdefghijkmnpqrstuvwxyz23456789';   -- bỏ o/l/0/1 dễ nhầm
  alen int := length(alphabet);
  candidate text;
  raw text;
  bytes bytea;
  i int;
  tries int := 0;
begin
  loop
    raw := '';
    while length(raw) < 12 loop
      raw := raw || replace(gen_random_uuid()::text, '-', '');
    end loop;
    bytes := decode(substr(raw, 1, 12), 'hex');
    candidate := '';
    for i in 0..5 loop
      candidate := candidate || substr(alphabet, (get_byte(bytes, i) % alen) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.lucky_events where slug = candidate);
    tries := tries + 1;
    exit when tries >= 20;
  end loop;
  return candidate;
end;
$$;

revoke execute on function public.lucky_gen_slug() from public, anon, authenticated;

-- Backfill + ràng buộc
update public.lucky_events set slug = public.lucky_gen_slug() where slug is null;
alter table public.lucky_events alter column slug set not null;
create unique index if not exists lucky_events_slug_key on public.lucky_events(slug);

alter table public.lucky_events drop constraint if exists lucky_events_slug_format;
alter table public.lucky_events add constraint lucky_events_slug_format
  check (slug ~ '^[a-z0-9][a-z0-9-]{1,31}$' and slug <> 'admin');

create or replace function public.lucky_set_event_slug()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $$
begin
  if new.slug is null or btrim(new.slug) = '' then
    new.slug := public.lucky_gen_slug();
  else
    new.slug := lower(btrim(new.slug));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_lucky_set_event_slug on public.lucky_events;
create trigger trg_lucky_set_event_slug
  before insert or update of slug on public.lucky_events
  for each row execute function public.lucky_set_event_slug();

revoke execute on function public.lucky_set_event_slug() from public, anon, authenticated;

-- ========== Payload: kèm slug để FE dựng link ==========

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
    'slug', e.slug,
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

  return jsonb_build_object('ok', true, 'event', v_event, 'teams', v_teams);
end;
$$;

revoke execute on function public.lucky_event_payload_v1(uuid, uuid) from public, anon, authenticated;

-- ========== RPC public: nhận slug ==========

create or replace function public.lucky_public_state_v1(
  p_event uuid default null,
  p_code text default null,
  p_slug text default null
)
returns jsonb
language plpgsql
stable security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_event uuid := p_event;
  v_team uuid;
begin
  -- Slug → event id (ưu tiên thấp hơn p_event nếu cả hai cùng gửi).
  if v_event is null and p_slug is not null and p_slug <> '' then
    select id into v_event from public.lucky_events where slug = lower(btrim(p_slug));
    if v_event is null then
      return jsonb_build_object('ok', false, 'reason', 'not_found');
    end if;
  end if;

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
    if v_event is not null and p_event is not null and v_event <> p_event then
      return jsonb_build_object('ok', false, 'reason', 'code_other_event');
    end if;
  end if;

  if v_event is null then
    return jsonb_build_object('ok', false, 'reason', 'missing_event');
  end if;

  return public.lucky_event_payload_v1(v_event, v_team);
end;
$$;

revoke execute on function public.lucky_public_state_v1(uuid, text, text) from public;
grant execute on function public.lucky_public_state_v1(uuid, text, text) to anon, authenticated;

-- Bỏ chữ ký 2 tham số cũ để PostgREST không phân vân giữa hai overload.
drop function if exists public.lucky_public_state_v1(uuid, text);

-- ========== Quản trị: đặt/sửa slug ==========

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

  if v_id is null then
    insert into public.lucky_events (organization_id, title, prize_label, prize_amount, draw_at, slug)
    values (
      v_org,
      coalesce(nullif(p->>'title', ''), 'IHOME · Trao thưởng'),
      coalesce(nullif(p->>'prizeLabel', ''), 'Giải may mắn'),
      coalesce((p->>'prizeAmount')::numeric, 500000),
      nullif(p->>'drawAt', '')::timestamptz,
      nullif(v_slug, '')
    )
    returning id into v_id;
  else
    perform public.lucky_admin_assert_event_v1(v_id);
    update public.lucky_events set
      title        = coalesce(nullif(p->>'title', ''), title),
      prize_label  = coalesce(nullif(p->>'prizeLabel', ''), prize_label),
      prize_amount = coalesce((p->>'prizeAmount')::numeric, prize_amount),
      slug         = case when v_slug <> '' then v_slug else slug end,
      draw_at      = case when p ? 'drawAt' then nullif(p->>'drawAt', '')::timestamptz else draw_at end,
      status       = case when p ? 'status' and (p->>'status') in ('open', 'closed') then p->>'status' else status end,
      updated_at   = now()
    where id = v_id;
  end if;

  return jsonb_build_object('ok', true, 'eventId', v_id,
                            'slug', (select slug from public.lucky_events where id = v_id));
end;
$$;

revoke execute on function public.lucky_admin_upsert_event_v1(jsonb) from public, anon;
grant execute on function public.lucky_admin_upsert_event_v1(jsonb) to authenticated;

-- ========== Payload quản trị: kèm slug ==========

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
      'createdAt', e.created_at,
      'serverNow', now(),
      'teams', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', t.id, 'name', t.name, 'deals', t.deals, 'code', t.code,
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
