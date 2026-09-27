-- @@ spend_objects
select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname ~ '^ie_spend|spend_ledger|spend_decide' order by 2
-- @@ spend_tables
select table_schema, table_name from information_schema.tables where table_name ~ 'spend' order by 2
-- @@ counts
select (select count(*) from public.contracts) contracts, (select count(*) from public.income_expenses) vouchers, (select max(created_at) from public.income_expenses) last_voucher_created
