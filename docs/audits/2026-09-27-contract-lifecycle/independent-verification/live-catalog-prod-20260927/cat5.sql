-- @@ pass_listings_summary
select active, contact_manager, count(*), count(*) filter (where avail_date < current_date) avail_past, count(*) filter (where exists (select 1 from public.contracts c where c.room_id=p.room_id and c.deleted_at is null and c.status in ('ACTIVE','EXTENDED'))) on_active_room from public.room_pass_listings p group by 1,2
-- @@ share_tokens_summary
select count(*) total, count(*) filter (where not revoked) not_revoked, count(distinct owner_id) owners, count(*) filter (where organization_id is null) no_org from public.public_room_share_tokens
-- @@ deposits_rows
select count(*) from public.deposits
