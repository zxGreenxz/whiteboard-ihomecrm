-- =============================================================================
-- /quayso: MỖI SỰ KIỆN CHỌN MỘT TRÒ CHƠI
--
-- Trước đây trang công khai chỉ có một cách công bố: vòng xoay. Từ 21/08/2026
-- chủ giải chọn trò lúc tổ chức — hiện có 'wheel' (vòng xoay) và 'race' (đua
-- thú), sau này thêm trò khác thì nới CHECK ở đây là xong.
--
-- ĐIỀU KHÔNG ĐỔI, và đây mới là phần quan trọng: kết quả VẪN do
-- `lucky_draw_v1` chốt một lần trên server, ngẫu nhiên trong số đội đã điểm
-- danh + in_wheel. Trò chơi CHỈ là cách diễn lại kết quả đó cho đẹp. Không có
-- trò nào được phép ảnh hưởng tới ai trúng — nếu sau này có trò cần luật chốt
-- khác thì phải sửa `lucky_draw_v1`, không được nhét vào client.
--
-- Vì sao mặc định 'wheel': mọi sự kiện đang tồn tại đều đang chạy vòng xoay, và
-- một số link đã phát ra ngoài. Đổi mặc định là đổi trải nghiệm sau lưng người
-- đã cầm link.
--
-- Ba hàm phải thay vì payload của chúng phải kèm `game` cho client biết vẽ gì:
--   - lucky_event_payload_v1        (nguồn chung của mọi RPC công khai)
--   - lucky_admin_get_v1            (trang quản trị)
--   - lucky_admin_upsert_event_v1   (chỗ chủ giải chọn trò)
-- GỐC THÂN HÀM: bản mới nhất trong repo — `20260731120000_lucky_event_slug.sql`.
-- Án lệ "vá guard nuốt cửa": chép nguyên khối bản hiện hành rồi mới thêm phần
-- mới, không viết lại từ trí nhớ.
--
-- Án lệ default privileges: mọi hàm REVOKE PUBLIC trước khi GRANT đúng đối tượng.
-- =============================================================================

-- ========== 1) Cột `game` ==========

alter table public.lucky_events
  add column if not exists game text not null default 'wheel';

alter table public.lucky_events
  drop constraint if exists lucky_events_game_check;
alter table public.lucky_events
  add constraint lucky_events_game_check check (game in ('wheel', 'race'));

comment on column public.lucky_events.game is
  'Trò chơi dùng để CÔNG BỐ kết quả: wheel = vòng xoay, race = đua thú. Không ảnh hưởng tới việc chốt đội trúng (lucky_draw_v1).';

-- ========== 2) Payload công khai: kèm `game` ==========

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
    'game', e.game,
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

-- ========== 3) Quản trị: chọn trò khi tạo/sửa sự kiện ==========

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

  -- Kiểm ngay ở đây thay vì để CHECK constraint bắn ra lỗi 23514 khó đọc.
  if v_game is not null and v_game not in ('wheel', 'race') then
    raise exception 'Trò chơi "%" không có trong danh sách (wheel, race).', v_game
      using errcode = '22023';
  end if;

  if v_id is null then
    insert into public.lucky_events (organization_id, title, prize_label, prize_amount, draw_at, slug, game)
    values (
      v_org,
      coalesce(nullif(p->>'title', ''), 'IHOME · Trao thưởng'),
      coalesce(nullif(p->>'prizeLabel', ''), 'Giải may mắn'),
      coalesce((p->>'prizeAmount')::numeric, 500000),
      nullif(p->>'drawAt', '')::timestamptz,
      nullif(v_slug, ''),
      coalesce(v_game, 'wheel')
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

-- ========== 4) Payload quản trị: kèm `game` ==========

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
