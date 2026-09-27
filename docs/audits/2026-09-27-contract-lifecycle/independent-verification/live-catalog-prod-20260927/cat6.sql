-- @@ spend_objects
select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname ~ '^ie_spend|spend_ledger|spend_decide' order by 2
-- @@ spend_tables
select table_schema, table_name from information_schema.tables where table_name ~ 'spend' order by 2
-- @@ counts
select (select count(*) from public.contracts) contracts, (select count(*) from public.income_expenses) vouchers, (select max(created_at) from public.income_expenses) last_voucher_created
-- @@ spend_flags
select feature_key, mode from app_private.server_feature_flags where feature_key like 'spend.%' or feature_key like 'contract.%' or feature_key like 'customer.credit%' or feature_key like 'reservation%' or feature_key like 'termination%' order by 1
-- @@ spend_errors
select count(*) from app_private.spend_engine_errors
