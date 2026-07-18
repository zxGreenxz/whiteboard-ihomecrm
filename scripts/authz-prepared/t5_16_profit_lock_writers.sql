-- t5_16_profit_lock_writers.sql — Chốt/Mở-khoá lợi nhuận tháng (atomic + vá org-NULL)
--
-- Thay client-cascade writeLockedMonth (useShareholderProfit.ts:340): upsert
-- profit_monthly + delete&insert 2 bảng allocation KHÔNG atomic, và KHÔNG stamp
-- organization_id → khoá THÁNG MỚI sẽ ghi org NULL (latent bug — xem
-- TRANCHE-PROFIT-SURVEY-2026-07-18.md §3).
--
-- Thiết kế parity-first: CLIENT VẪN TÍNH (lương điều hành, distributable,
-- Math.round) — writer nhận snapshot ĐÃ TÍNH qua p_rows jsonb và chỉ đảm nhiệm:
--   • authorize: authorize_tenant_action_v3(actor, org, 'shareholder_profit.lock')
--     (permission catalog đã ALLOW cả 2 org — verified survey §2)
--   • cross-org guard: MỌI building trong p_rows phải cùng 1 org ACTIVE
--   • ATOMIC 1-tx: upsert profit_monthly (LOCKED, stamp org) → delete 2 bảng
--     allocation theo pm_ids → insert snapshot mới (stamp org)
-- TODO tranche sau: chuyển thẩm quyền TÍNH TOÁN (làm tròn/quy tắc lương) về
-- server — tranche này chỉ gói atomicity + org + permission.
--
-- p_rows: [{building_id, computed_profit, adjusted_profit, management_salary,
--           allocations:[{shareholder_id, percent, amount}],
--           manager_allocations:[{manager_id, amount}]}]

begin;

create or replace function public.lock_profit_month_v1(
  p_period_month text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_authz boolean;
  v_row jsonb;
  v_building uuid;
  v_pm_id uuid;
  v_pm_ids uuid[] := '{}';
  v_alloc jsonb;
  v_locked int := 0;
  v_allocs int := 0;
  v_period date;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  if p_period_month is null or p_period_month !~ '^\d{4}-\d{2}(-\d{2})?$' then
    raise exception 'period_month phải dạng YYYY-MM hoặc YYYY-MM-DD';
  end if;
  -- Cột period_month là DATE — chuẩn hoá YYYY-MM về ngày đầu tháng.
  v_period := (case when length(p_period_month) = 7
                    then p_period_month || '-01' else p_period_month end)::date;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'Không có dữ liệu để chốt';
  end if;

  -- Org suy từ building đầu tiên; mọi building phải cùng org ACTIVE.
  select b.organization_id into v_org
    from public.buildings b
   where b.id = (p_rows->0->>'building_id')::uuid and b.deleted_at is null;
  if v_org is null then
    raise exception 'Toà nhà không hợp lệ hoặc chưa có tổ chức';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) r
    left join public.buildings b on b.id = (r->>'building_id')::uuid and b.deleted_at is null
    where b.id is null or b.organization_id is distinct from v_org
  ) then
    raise exception 'Danh sách toà chứa toà không thuộc cùng tổ chức' using errcode = '42501';
  end if;

  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'shareholder_profit.lock', null, null);
  if not coalesce(v_authz, false) then
    raise exception 'Không có quyền chốt lợi nhuận (shareholder_profit.lock)' using errcode = '42501';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_building := (v_row->>'building_id')::uuid;

    insert into public.profit_monthly as pm
      (user_id, building_id, period_month, computed_profit, adjusted_profit,
       management_salary, status, locked_at, locked_by, organization_id)
    values
      (v_actor, v_building, v_period,
       coalesce((v_row->>'computed_profit')::numeric, 0),
       coalesce((v_row->>'adjusted_profit')::numeric, 0),
       coalesce((v_row->>'management_salary')::numeric, 0),
       'LOCKED', now(), v_actor, v_org)
    on conflict (building_id, period_month) do update
      set computed_profit  = excluded.computed_profit,
          adjusted_profit  = excluded.adjusted_profit,
          management_salary = excluded.management_salary,
          status = 'LOCKED', locked_at = now(), locked_by = v_actor,
          organization_id = v_org
    returning pm.id into v_pm_id;

    v_pm_ids := v_pm_ids || v_pm_id;
    v_locked := v_locked + 1;
  end loop;

  delete from public.profit_allocations where profit_monthly_id = any (v_pm_ids);
  delete from public.profit_manager_allocations where profit_monthly_id = any (v_pm_ids);

  for v_row in select * from jsonb_array_elements(p_rows) loop
    select pm.id into v_pm_id from public.profit_monthly pm
     where pm.building_id = (v_row->>'building_id')::uuid
       and pm.period_month = v_period;

    for v_alloc in select * from jsonb_array_elements(coalesce(v_row->'allocations', '[]'::jsonb)) loop
      insert into public.profit_allocations
        (user_id, profit_monthly_id, shareholder_id, percent, amount, organization_id)
      values (v_actor, v_pm_id, (v_alloc->>'shareholder_id')::uuid,
              coalesce((v_alloc->>'percent')::numeric, 0),
              coalesce((v_alloc->>'amount')::numeric, 0), v_org);
      v_allocs := v_allocs + 1;
    end loop;

    for v_alloc in select * from jsonb_array_elements(coalesce(v_row->'manager_allocations', '[]'::jsonb)) loop
      continue when coalesce((v_alloc->>'amount')::numeric, 0) = 0;
      insert into public.profit_manager_allocations
        (user_id, profit_monthly_id, manager_id, amount, organization_id)
      values (v_actor, v_pm_id, (v_alloc->>'manager_id')::uuid,
              (v_alloc->>'amount')::numeric, v_org);
    end loop;
  end loop;

  return jsonb_build_object('locked', v_locked, 'allocations', v_allocs);
end;
$$;

revoke all on function public.lock_profit_month_v1(text, jsonb) from public;
revoke all on function public.lock_profit_month_v1(text, jsonb) from anon;
grant execute on function public.lock_profit_month_v1(text, jsonb) to authenticated;

create or replace function public.unlock_profit_month_v1(
  p_period_month text,
  p_building_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'app_private'
as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_authz boolean;
  v_pm_ids uuid[];
  v_count int;
  v_period date;
begin
  if v_actor is null then
    raise exception 'Chưa đăng nhập' using errcode = '42501';
  end if;
  if p_building_ids is null or array_length(p_building_ids, 1) is null then
    return 0;
  end if;
  if p_period_month is null or p_period_month !~ '^\d{4}-\d{2}(-\d{2})?$' then
    raise exception 'period_month phải dạng YYYY-MM hoặc YYYY-MM-DD';
  end if;
  v_period := (case when length(p_period_month) = 7
                    then p_period_month || '-01' else p_period_month end)::date;

  select b.organization_id into v_org
    from public.buildings b where b.id = p_building_ids[1] and b.deleted_at is null;
  if v_org is null then
    raise exception 'Toà nhà không hợp lệ';
  end if;
  if exists (
    select 1 from unnest(p_building_ids) bid
    left join public.buildings b on b.id = bid and b.deleted_at is null
    where b.id is null or b.organization_id is distinct from v_org
  ) then
    raise exception 'Danh sách toà chứa toà không thuộc cùng tổ chức' using errcode = '42501';
  end if;

  perform app_private.lock_org_for_decision_v1(v_org);
  select allowed into v_authz from app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'shareholder_profit.unlock', null, null);
  if not coalesce(v_authz, false) then
    raise exception 'Không có quyền mở khoá lợi nhuận (shareholder_profit.unlock)' using errcode = '42501';
  end if;

  select array_agg(id) into v_pm_ids from public.profit_monthly
   where period_month = v_period and building_id = any (p_building_ids);
  if v_pm_ids is null then return 0; end if;

  delete from public.profit_allocations where profit_monthly_id = any (v_pm_ids);
  delete from public.profit_manager_allocations where profit_monthly_id = any (v_pm_ids);
  update public.profit_monthly
     set status = 'DRAFT', management_salary = 0, locked_at = null, locked_by = null,
         organization_id = coalesce(organization_id, v_org)
   where id = any (v_pm_ids);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.unlock_profit_month_v1(text, uuid[]) from public;
revoke all on function public.unlock_profit_month_v1(text, uuid[]) from anon;
grant execute on function public.unlock_profit_month_v1(text, uuid[]) to authenticated;

commit;
