-- Gộp 4 HEAD-count của khối thống kê trang Hợp đồng / Khách hàng thành 1 RPC
-- mỗi trang (1 scan + count(*) filter thay 4 HTTP request).
--
-- Vì sao: mỗi count exact là 1 request + 1 lần plan RLS (~20-44ms CPU trên
-- instance nhỏ); 4 request/khối stats góp vào burst khiến pool nghẽn và mọi
-- request giãn 2-8s. SECURITY INVOKER → RLS áp per-user y như count PostgREST
-- cũ, KHÔNG đổi phạm vi dữ liệu.

-- =============================================================
-- 1) get_contract_stats — thay 4 count trong contractStatsQuery
--    (useContracts.ts). Điều kiện copy nguyên văn:
--    - expiring: status ∉ (TERMINATED,TRANSFERRED,DRAFT), chưa có
--      expected_move_out_date, end_date ∈ [p_today, p_in30]
--    - expired : như trên nhưng end_date < p_today
--    - terminated: status = TERMINATED
--    p_today/p_in30 do FE truyền (giữ đúng local-date logic của FE, tránh
--    lệch múi giờ giữa now() server và toLocalISODate client).
-- =============================================================
create or replace function public.get_contract_stats(
  p_building_ids uuid[] default null,
  p_today date default null,
  p_in30 date default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with base as (
    select c.status::text as status, c.end_date, c.expected_move_out_date
    from contracts c
    where c.deleted_at is null
      and (
        p_building_ids is null
        or exists (
          select 1 from rooms r
          where r.id = c.room_id
            and r.building_id = any(p_building_ids)
        )
      )
  )
  select jsonb_build_object(
    'total', count(*),
    'expiring', count(*) filter (
      where status not in ('TERMINATED','TRANSFERRED','DRAFT')
        and expected_move_out_date is null
        and end_date >= p_today
        and end_date <= p_in30
    ),
    'expired', count(*) filter (
      where status not in ('TERMINATED','TRANSFERRED','DRAFT')
        and expected_move_out_date is null
        and end_date < p_today
    ),
    'terminated', count(*) filter (where status = 'TERMINATED')
  )
  from base;
$$;

revoke all on function public.get_contract_stats(uuid[], date, date) from public, anon;
grant execute on function public.get_contract_stats(uuid[], date, date) to authenticated;

-- =============================================================
-- 2) get_customer_stats — thay 4 count + resolve location trùng lặp trong
--    useCustomerStats (useCustomers.ts). loc_ids = khách có HĐ ACTIVE tại
--    toà/phòng lọc (copy resolveCustomerIdsByLocation: contracts inner-join
--    rooms, chỉ status ACTIVE, chưa xoá).
-- =============================================================
create or replace function public.get_customer_stats(
  p_status text default null,
  p_search text default null,
  p_building_id uuid default null,
  p_room_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with loc_ids as (
    select distinct cc.customer_id
    from contracts c
    join rooms r on r.id = c.room_id
    join contract_customers cc on cc.contract_id = c.id
    where c.deleted_at is null
      and c.status::text = 'ACTIVE'
      and (p_room_id is null or c.room_id = p_room_id)
      and (p_building_id is null or r.building_id = p_building_id)
  ),
  base as (
    select cu.customer_type::text as customer_type, cu.is_foreign
    from customers cu
    where cu.deleted_at is null
      and (p_status is null or cu.status_v2::text = p_status)
      and (
        (p_building_id is null and p_room_id is null)
        or cu.id in (select customer_id from loc_ids)
      )
      and (
        p_search is null or btrim(p_search) = ''
        or cu.full_name ilike '%' || p_search || '%'
        or cu.phone ilike '%' || p_search || '%'
        or cu.email ilike '%' || p_search || '%'
        or cu.id_number ilike '%' || p_search || '%'
      )
  )
  select jsonb_build_object(
    'total', count(*),
    'individual', count(*) filter (where customer_type = 'INDIVIDUAL'),
    'organization', count(*) filter (where customer_type = 'ORGANIZATION'),
    'foreign', count(*) filter (where is_foreign = true)
  )
  from base;
$$;

revoke all on function public.get_customer_stats(text, text, uuid, uuid) from public, anon;
grant execute on function public.get_customer_stats(text, text, uuid, uuid) to authenticated;
