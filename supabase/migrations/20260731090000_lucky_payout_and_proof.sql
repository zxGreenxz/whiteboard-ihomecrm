-- =============================================
-- Migration: Hồ sơ nhận thưởng của từng đội — giấy cọc + số tài khoản.
--
-- Mỗi đội sau khi điểm danh tự nộp:
-- - Ảnh/PDF giấy cọc (bucket riêng `lucky-proofs`, PRIVATE)
-- - Số tài khoản nhận thưởng (STK + ngân hàng + chủ tài khoản)
--
-- Bảo mật:
-- - Payload PUBLIC chỉ trả hồ sơ của CHÍNH đội đang xem (p_viewer_team).
--   Đội khác tuyệt đối không thấy STK/giấy cọc của nhau.
-- - Bucket private, anon chỉ có quyền INSERT (upload), KHÔNG có SELECT →
--   không ai liệt kê/đọc chéo file được. Quản trị đọc qua signed URL.
-- - Đường dẫn file = <event_id>/<uuid ngẫu nhiên>.<ext>: policy INSERT bắt
--   thư mục gốc phải là một sự kiện CÒN MỞ, chặn đổ rác vào bucket.
-- =============================================

-- ========== 1) Cột hồ sơ nhận thưởng ==========

alter table public.lucky_event_teams
  add column if not exists payout_account text,
  add column if not exists payout_bank text,
  add column if not exists payout_holder text,
  add column if not exists proof_path text,
  add column if not exists proof_name text,
  add column if not exists proof_uploaded_at timestamptz;

-- ========== 2) Bucket riêng cho giấy cọc ==========

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lucky-proofs', 'lucky-proofs', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Anon/authenticated được UPLOAD, nhưng chỉ vào thư mục của sự kiện còn mở.
drop policy if exists "lucky proofs upload" on storage.objects;
create policy "lucky proofs upload"
  on storage.objects for insert to anon, authenticated
  with check (
    bucket_id = 'lucky-proofs'
    and exists (
      select 1 from public.lucky_events e
      where e.id::text = (storage.foldername(name))[1]
        and e.status <> 'closed'
    )
  );

-- CHỈ người đăng nhập (quản trị) đọc được. KHÔNG cấp SELECT cho anon:
-- có SELECT là liệt kê được toàn bộ đường dẫn → lộ giấy cọc chéo đội.
drop policy if exists "lucky proofs read by staff" on storage.objects;
create policy "lucky proofs read by staff"
  on storage.objects for select to authenticated
  using (bucket_id = 'lucky-proofs' and public.lucky_admin_org_v1() is not null);

-- ========== 3) Payload: chỉ trả hồ sơ của chính đội đang xem ==========

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
    -- Hồ sơ nhận thưởng: CHỈ lộ cho chính đội đó.
    'payoutAccount', case when t.id = p_viewer_team then t.payout_account end,
    'payoutBank',    case when t.id = p_viewer_team then t.payout_bank end,
    'payoutHolder',  case when t.id = p_viewer_team then t.payout_holder end,
    'proofName',     case when t.id = p_viewer_team then t.proof_name end,
    'hasProof',      t.proof_path is not null
  ) order by coalesce(t.top_rank, 99), t.created_at), '[]'::jsonb)
  into v_teams
  from public.lucky_event_teams t
  where t.event_id = p_event;

  return jsonb_build_object('ok', true, 'event', v_event, 'teams', v_teams);
end;
$$;

revoke execute on function public.lucky_event_payload_v1(uuid, uuid) from public, anon, authenticated;

-- ========== 4) RPC public: lưu hồ sơ nhận thưởng ==========

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

  update public.lucky_event_teams set
    payout_account = case when p ? 'payoutAccount' then nullif(btrim(p->>'payoutAccount'), '') else payout_account end,
    payout_bank    = case when p ? 'payoutBank'    then nullif(btrim(p->>'payoutBank'), '')    else payout_bank end,
    payout_holder  = case when p ? 'payoutHolder'  then nullif(btrim(p->>'payoutHolder'), '')  else payout_holder end,
    -- Đường dẫn file phải nằm đúng thư mục sự kiện này, chặn ghi đè chéo đội.
    proof_path     = case
                       when p ? 'proofPath' and (p->>'proofPath') like v_event::text || '/%'
                         then p->>'proofPath'
                       else proof_path
                     end,
    proof_name     = case
                       when p ? 'proofPath' and (p->>'proofPath') like v_event::text || '/%'
                         then left(coalesce(nullif(btrim(p->>'proofName'), ''), 'giay-coc'), 120)
                       else proof_name
                     end,
    proof_uploaded_at = case
                          when p ? 'proofPath' and (p->>'proofPath') like v_event::text || '/%'
                            then now()
                          else proof_uploaded_at
                        end
  where id = v_team;

  return public.lucky_event_payload_v1(v_event, v_team);
end;
$$;

comment on function public.lucky_save_payout_v1(text, jsonb) is
'Đội tự nộp hồ sơ nhận thưởng (STK + đường dẫn giấy cọc đã upload). Chỉ đội đã điểm danh mới gọi được; proofPath bắt buộc nằm trong thư mục của đúng sự kiện.';

revoke execute on function public.lucky_save_payout_v1(text, jsonb) from public;
grant execute on function public.lucky_save_payout_v1(text, jsonb) to anon, authenticated;

-- ========== 5) Payload quản trị: thấy đủ hồ sơ mọi đội ==========

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
          'proofPath', t.proof_path,
          'proofName', t.proof_name,
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
