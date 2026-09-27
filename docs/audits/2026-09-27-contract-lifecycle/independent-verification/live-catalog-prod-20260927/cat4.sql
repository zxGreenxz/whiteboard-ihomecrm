-- @@ active_contract_room_status_drift
select case c.organization_id when 'aaaa0000-0000-4000-8000-000000000001' then 'THAT' when 'dddd0000-0000-4000-8000-000000000001' then 'DEMO' else 'OTHER' end org, r.status room_status, count(*)
from public.contracts c join public.rooms r on r.id=c.room_id
where c.deleted_at is null and c.status in ('ACTIVE','EXTENDED') and r.status <> 'OCCUPIED' group by 1,2
-- @@ occupied_rooms_without_active
select case r.organization_id when 'aaaa0000-0000-4000-8000-000000000001' then 'THAT' when 'dddd0000-0000-4000-8000-000000000001' then 'DEMO' else 'OTHER' end org, count(*)
from public.rooms r where r.deleted_at is null and r.status='OCCUPIED'
and not exists (select 1 from public.contracts c where c.room_id=r.id and c.deleted_at is null and c.status in ('ACTIVE','EXTENDED')) group by 1
-- @@ credit_cols
select table_schema, table_name, string_agg(column_name||':'||udt_name, ', ' order by ordinal_position) cols
from information_schema.columns where table_name in ('customer_credit_lots','customer_credit_applications','public_room_share_tokens','room_pass_listings','contract_transfers','contract_extensions','deposits') and table_schema='public' group by 1,2
-- @@ credit_lots_summary
select case organization_id when 'aaaa0000-0000-4000-8000-000000000001' then 'THAT' when 'dddd0000-0000-4000-8000-000000000001' then 'DEMO' else 'OTHER' end org, count(*) from public.customer_credit_lots group by 1
-- @@ pass_listings_summary
select status, count(*) from public.room_pass_listings group by 1
-- @@ share_tokens_summary
select count(*) total, count(*) filter (where revoked_at is null) not_revoked from public.public_room_share_tokens
-- @@ deposits_table_summary
select status, count(*), count(*) filter (where contract_id is null and deleted_at is null) unlinked from public.deposits group by 1
