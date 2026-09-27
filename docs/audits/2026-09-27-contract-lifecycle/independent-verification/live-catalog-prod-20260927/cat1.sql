-- @@ server
select current_setting('server_version') as server_version, now() as db_now, current_user as db_user,
       (select string_agg(extname||' '||extversion, ', ' order by extname) from pg_extension) as extensions
-- @@ columns_key_tables
select table_schema, table_name, string_agg(column_name||':'||udt_name||case when is_generated='ALWAYS' then '[GEN]' else '' end, ', ' order by ordinal_position) as cols
from information_schema.columns
where (table_schema, table_name) in (('public','contracts'),('public','rooms'),('public','room_reservation_holds'),('public','contract_terminations'),('public','jobs'),('public','notifications'),('public','meter_readings'),('app_private','canonical_write_operations'),('public','public_room_tokens'),('public','contract_customers'))
group by table_schema, table_name order by 1,2
-- @@ enums
select t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder) labels
from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace
where n.nspname='public' group by t.typname order by 1
-- @@ contracts_constraints
select conname, contype, pg_get_constraintdef(oid) def from pg_constraint where conrelid='public.contracts'::regclass order by conname
-- @@ contracts_indexes
select indexname, indexdef from pg_indexes where schemaname='public' and tablename in ('contracts','room_reservation_holds','rooms','contract_terminations') order by tablename, indexname
-- @@ holds_constraints
select conrelid::regclass as tbl, conname, contype, pg_get_constraintdef(oid) def from pg_constraint where conrelid in ('public.room_reservation_holds'::regclass,'public.rooms'::regclass,'public.contract_terminations'::regclass) order by 1,2
-- @@ triggers_core
select tgrelid::regclass as tbl, tgname, tgenabled, pg_get_triggerdef(t.oid) def, p.proname fn, p.prosecdef secdef
from pg_trigger t join pg_proc p on p.oid=t.tgfoid
where not tgisinternal and tgrelid in ('public.contracts'::regclass,'public.rooms'::regclass,'public.room_reservation_holds'::regclass,'public.contract_terminations'::regclass,'public.jobs'::regclass,'public.contract_customers'::regclass)
order by 1,2
-- @@ rls_contracts_rooms
select schemaname, tablename, policyname, cmd, roles::text, left(qual,400) qual, left(with_check,400) with_check
from pg_policies where tablename in ('contracts','rooms','room_reservation_holds','jobs','contract_terminations') order by tablename, cmd, policyname
-- @@ table_grants
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) privs
from information_schema.role_table_grants
where table_schema='public' and table_name in ('contracts','rooms','room_reservation_holds','jobs','contract_terminations','notifications') and grantee in ('anon','authenticated','service_role')
group by table_name, grantee order by 1,2
-- @@ column_grants_contracts
select grantee, privilege_type, string_agg(column_name, ',' order by column_name) cols
from information_schema.column_privileges where table_schema='public' and table_name='contracts' and grantee in ('anon','authenticated')
group by grantee, privilege_type order by 1,2
-- @@ functions_inventory
select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) args, p.prosecdef secdef, p.provolatile vol,
       coalesce(array_to_string(p.proconfig, ';'),'') cfg, coalesce(p.proacl::text,'(default)') acl, md5(p.prosrc) src_md5, length(p.prosrc) len
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','app_private')
  and p.proname ~ '(create_contract|terminat|forfeit|move_?out|reservation|available_rooms|room_status|holding_deposit|v5_tick|award_job|lock_org_for_decision|org_today|org_timezone|customer_credit|renew|extend|transfer|expected_move|canonical_write|settle|refund)'
order by 2,3
-- @@ cron_jobs
select jobid, jobname, schedule, active, database,
       (select string_agg(distinct x[1], ',') from regexp_matches(command, '((?:public|app_private|cron|net)\.[a-z0-9_]+)', 'g') as x) as referenced_objects,
       md5(command) cmd_md5
from cron.job order by jobname
-- @@ cron_last_runs
select j.jobname, d.status, d.start_time, d.end_time, left(coalesce(d.return_message,''),120) msg
from cron.job j
left join lateral (select * from cron.job_run_details r where r.jobid=j.jobid order by r.start_time desc limit 1) d on true
order by j.jobname
-- @@ publication
select pubname, schemaname, tablename from pg_publication_tables where pubname like 'supabase_realtime%' order by 2,3
-- @@ flag_tables
select table_schema, table_name from information_schema.tables where table_name ~ '(flag|feature|route|switch)' and table_schema in ('public','app_private') order by 1,2
