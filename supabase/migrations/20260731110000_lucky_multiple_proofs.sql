-- =============================================
-- Migration: Cho phép nộp NHIỀU giấy cọc (một hợp đồng thường 2–4 tấm ảnh).
--
-- Trước: mỗi đội 1 file (proof_path/proof_name) → nộp tấm sau đè tấm trước.
-- Sau: cột `proofs` jsonb = [{path, name, at}], client gửi lên NGUYÊN danh sách
--      (thay thế toàn bộ) nên thêm/bớt đều dùng chung một đường.
--
-- Giữ nguyên proof_path/proof_name để không vỡ dữ liệu cũ; đã backfill sang
-- `proofs` bên dưới. Mọi chỗ đọc mới đều dùng `proofs`.
-- =============================================

alter table public.lucky_event_teams
  add column if not exists proofs jsonb not null default '[]'::jsonb;

-- Backfill file đơn đã nộp trước đó.
update public.lucky_event_teams
   set proofs = jsonb_build_array(jsonb_build_object(
         'path', proof_path,
         'name', coalesce(proof_name, 'giay-coc'),
         'at', coalesce(proof_uploaded_at, now())))
 where proof_path is not null
   and jsonb_array_length(proofs) = 0;

-- ========== Payload public: hồ sơ chỉ lộ cho chính đội đang xem ==========

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

-- ========== Lưu hồ sơ: nhận nguyên danh sách giấy cọc ==========

create or replace function public.lucky_save_payout_v1(p_code text, p jsonb)
returns jsonb
language plpgsql
volatile security definer
set search_path to 'pg_catalog', 'public'
as $$
declare
  v_team uuid;
  v_event uuid;
  v_checked timestamptz;
  v_proofs jsonb;
begin
  if p_code is null or p_code = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_code');
  end if;

  select t.id, t.event_id, t.checked_in_at
    into v_team, v_event, v_checked
  from public.lucky_event_teams t
  join public.lucky_events e on e.id = t.event_id
  where t.code = p_code and e.status <> 'closed'
  order by e.created_at desc
  limit 1
  for update of t;

  if v_team is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_code');
  end if;
  if v_checked is null then
    return jsonb_build_object('ok', false, 'reason', 'not_checked_in');
  end if;

  -- Lọc danh sách gửi lên: chỉ giữ file nằm ĐÚNG thư mục của sự kiện này
  -- (chặn trỏ sang giấy cọc của sự kiện/đội khác), tối đa 10 tấm.
  if p ? 'proofs' and jsonb_typeof(p->'proofs') = 'array' then
    select coalesce(jsonb_agg(x order by ord), '[]'::jsonb) into v_proofs
    from (
      select jsonb_build_object(
               'path', el->>'path',
               'name', left(coalesce(nullif(btrim(el->>'name'), ''), 'giay-coc'), 120),
               'at',   coalesce(el->>'at', now()::text)) as x,
             ord
      from jsonb_array_elements(p->'proofs') with ordinality as t2(el, ord)
      where el->>'path' like v_event::text || '/%'
      limit 10
    ) s;
  else
    v_proofs := null;
  end if;

  update public.lucky_event_teams set
    payout_account = case when p ? 'payoutAccount' then nullif(btrim(p->>'payoutAccount'), '') else payout_account end,
    payout_bank    = case when p ? 'payoutBank'    then nullif(btrim(p->>'payoutBank'), '')    else payout_bank end,
    payout_holder  = case when p ? 'payoutHolder'  then nullif(btrim(p->>'payoutHolder'), '')  else payout_holder end,
    proofs         = coalesce(v_proofs, proofs),
    -- Giữ 2 cột cũ đồng bộ với tấm đầu tiên cho dữ liệu/báo cáo cũ.
    proof_path     = case when v_proofs is null then proof_path else v_proofs->0->>'path' end,
    proof_name     = case when v_proofs is null then proof_name else v_proofs->0->>'name' end,
    proof_uploaded_at = case
                          when v_proofs is null then proof_uploaded_at
                          when jsonb_array_length(v_proofs) = 0 then null
                          else now()
                        end
  where id = v_team;

  return public.lucky_event_payload_v1(v_event, v_team);
end;
$$;

comment on function public.lucky_save_payout_v1(text, jsonb) is
'Đội tự nộp hồ sơ nhận thưởng. `proofs` là NGUYÊN danh sách giấy cọc (thay thế toàn bộ, tối đa 10 tấm); mọi path phải nằm trong thư mục của đúng sự kiện.';

revoke execute on function public.lucky_save_payout_v1(text, jsonb) from public;
grant execute on function public.lucky_save_payout_v1(text, jsonb) to anon, authenticated;

-- ========== Payload quản trị: thấy đủ danh sách giấy cọc ==========

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
