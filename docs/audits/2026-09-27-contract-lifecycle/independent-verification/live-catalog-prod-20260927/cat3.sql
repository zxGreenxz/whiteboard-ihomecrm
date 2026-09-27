-- @@ orgs
select id, case id when 'aaaa0000-0000-4000-8000-000000000001' then 'THAT' when 'dddd0000-0000-4000-8000-000000000001' then 'DEMO' else 'OTHER' end as org_label, status from public.organizations order by 2
-- @@ contracts_by_status
select case organization_id when 'aaaa0000-0000-4000-8000-000000000001' then 'THAT' when 'dddd0000-0000-4000-8000-000000000001' then 'DEMO' else coalesce(organization_id::text,'NULL') end org, status, count(*)
from public.contracts where deleted_at is null group by 1,2 order by 1,2
-- @@ notice_dates_active
select case c.organization_id when 'aaaa0000-0000-4000-8000-000000000001' then 'THAT' when 'dddd0000-0000-4000-8000-000000000001' then 'DEMO' else 'OTHER' end org,
  count(*) filter (where c.expected_move_out_date is not null) as with_expected,
  count(*) filter (where c.expected_move_out_date < public.org_today_v1(c.organization_id)) as expected_past,
  count(*) filter (where c.expected_move_out_date = public.org_today_v1(c.organization_id)) as expected_today,
  count(*) filter (where c.expected_move_out_date > public.org_today_v1(c.organization_id)) as expected_future,
  count(*) filter (where c.end_date < public.org_today_v1(c.organization_id)) as end_date_past_still_active,
  count(*) filter (where c.start_date > public.org_today_v1(c.organization_id)) as start_in_future,
  count(*) filter (where c.start_billing_date is distinct from c.start_date) as billing_start_differs,
  count(*) as active_total
from public.contracts c where c.deleted_at is null and c.status in ('ACTIVE','EXTENDED') group by 1 order by 1
-- @@ rooms_multi_active
select count(*) as rooms_with_2plus_active from (select room_id from public.contracts where deleted_at is null and status in ('ACTIVE','EXTENDED') group by room_id having count(*)>1) x
-- @@ terminated_without_actual_end
select case organization_id when 'aaaa0000-0000-4000-8000-000000000001' then 'THAT' when 'dddd0000-0000-4000-8000-000000000001' then 'DEMO' else 'OTHER' end org, status, count(*) filter (where actual_end_date is null) as no_actual_end, count(*) total
from public.contracts where deleted_at is null and status in ('TERMINATED','EXPIRED','TRANSFERRED') group by 1,2 order by 1,2
-- @@ holds_by_status
select case organization_id when 'aaaa0000-0000-4000-8000-000000000001' then 'THAT' when 'dddd0000-0000-4000-8000-000000000001' then 'DEMO' else 'OTHER' end org, status,
  count(*) total, count(*) filter (where expires_at > now()) live_now, count(*) filter (where contract_id is not null) consumed, min(amount) min_amount, count(*) filter (where amount = 1) amount_eq_1
from public.room_reservation_holds group by 1,2 order by 1,2
-- @@ rooms_by_status
select case organization_id when 'aaaa0000-0000-4000-8000-000000000001' then 'THAT' when 'dddd0000-0000-4000-8000-000000000001' then 'DEMO' else 'OTHER' end org, status, count(*) from public.rooms where deleted_at is null group by 1,2 order by 1,2
-- @@ terminations_by_status_type
select case organization_id when 'aaaa0000-0000-4000-8000-000000000001' then 'THAT' when 'dddd0000-0000-4000-8000-000000000001' then 'DEMO' else 'OTHER' end org, status, termination_type, count(*)
from public.contract_terminations group by 1,2,3 order by 1,2,3
-- @@ terminated_contracts_without_termination_row
select case c.organization_id when 'aaaa0000-0000-4000-8000-000000000001' then 'THAT' when 'dddd0000-0000-4000-8000-000000000001' then 'DEMO' else 'OTHER' end org, c.status, count(*)
from public.contracts c where c.deleted_at is null and c.status in ('TERMINATED','EXPIRED')
and not exists (select 1 from public.contract_terminations t where t.contract_id=c.id) group by 1,2 order by 1,2
-- @@ open_invoices_on_ended_contracts
select case c.organization_id when 'aaaa0000-0000-4000-8000-000000000001' then 'THAT' when 'dddd0000-0000-4000-8000-000000000001' then 'DEMO' else 'OTHER' end org, c.status contract_status, i.status invoice_status, count(*)
from public.invoices i join public.contracts c on c.id=i.contract_id
where c.deleted_at is null and c.status in ('TERMINATED','EXPIRED','TRANSFERRED') and i.status in ('APPROVED','PARTIAL_PAID','OVERDUE','PENDING_APPROVAL','DRAFT')
group by 1,2,3 order by 1,2,3
-- @@ customers_multi_active
select count(*) customers_with_2plus_active_contracts from (
 select cc.customer_id from public.contract_customers cc join public.contracts c on c.id=cc.contract_id
 where c.deleted_at is null and c.status in ('ACTIVE','EXTENDED') group by cc.customer_id having count(distinct c.id)>1) x
-- @@ customers_active_and_ended
select count(*) customers_with_active_and_ended_contract from (
 select cc.customer_id from public.contract_customers cc join public.contracts c on c.id=cc.contract_id
 where c.deleted_at is null group by cc.customer_id
 having bool_or(c.status in ('ACTIVE','EXTENDED')) and bool_or(c.status in ('TERMINATED','EXPIRED','TRANSFERRED'))) x
-- @@ credit_and_token_tables
select table_schema, table_name from information_schema.tables where (table_name ~ '(credit|token|pass|listing|sale_)' ) and table_schema in ('public','app_private') order by 1,2
-- @@ orphan_deposit_vouchers
select case ie.organization_id when 'aaaa0000-0000-4000-8000-000000000001' then 'THAT' when 'dddd0000-0000-4000-8000-000000000001' then 'DEMO' else 'OTHER' end org, ie.approval_status, count(*),
  count(*) filter (where not app_private.reservation_deposit_is_settled_v1(ie.id)) unsettled
from public.income_expenses ie
where ie.deleted_at is null and ie.contract_id is null and ie.type='INCOME' and public.ie_has_deposit_item(ie.id)
group by 1,2 order by 1,2
-- @@ jobs_summary
select case organization_id when 'aaaa0000-0000-4000-8000-000000000001' then 'THAT' when 'dddd0000-0000-4000-8000-000000000001' then 'DEMO' else 'OTHER' end org, status, exclude_from_salary, count(*) from public.jobs group by 1,2,3 order by 1,2,3
-- @@ meter_readings_final_after_move_out
select count(*) filter (where mr.reading_date > c.actual_end_date) readings_after_end, count(*) total_readings_on_ended
from public.meter_readings mr join public.contracts c on c.id=mr.contract_id
where mr.deleted_at is null and c.deleted_at is null and c.status='TERMINATED' and c.actual_end_date is not null
