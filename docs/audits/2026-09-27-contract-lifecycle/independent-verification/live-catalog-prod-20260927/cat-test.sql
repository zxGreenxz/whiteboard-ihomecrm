-- @@ server
select current_setting('server_version') v, (select string_agg(extname||' '||extversion, ', ' order by extname) from pg_extension) ext, (select count(*) from pg_available_extensions where name='pg_cron') pg_cron_available
-- @@ cron_jobs
select jobname, schedule, active from cron.job order by 1
-- @@ migration_ledger_tail
select version, name from supabase_migrations.schema_migrations order by version desc limit 12
-- @@ fn_md5_compare
select n.nspname||'.'||p.proname name, md5(p.prosrc) src_md5 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where (n.nspname,p.proname) in (('public','create_contract_v2'),('public','update_room_status_on_contract_change'),('public','get_public_available_rooms'),('public','approve_contract_termination_v1'),('public','terminate_contract_move_out'),('public','v5_tick_from_job'),('app_private','ie_spend_gate_v1'),('app_private','ie_spend_decide_v1'),('public','renew_contract_impl'),('public','transfer_room'))
order by 1
-- @@ spend_flags
select feature_key, mode from app_private.server_feature_flags where feature_key like 'spend.%' or feature_key like 'contract.%' or feature_key like 'customer.credit%' order by 1
