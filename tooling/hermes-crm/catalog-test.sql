-- Metadata only; invoke through db-query.mjs --env test --file ... --json.
-- The existing reader enforces a single READ ONLY transaction. No business rows.
select jsonb_build_object(
  'captured_at', clock_timestamp(),
  'transaction_read_only', current_setting('transaction_read_only'),
  'test_marker_present', to_regclass('test_env.danh_dau') is not null,
  'test_marker_digest', (select md5(ref) from test_env.danh_dau limit 1),
  'functions', (select coalesce(jsonb_agg(jsonb_build_object(
    'schema', n.nspname, 'name', p.proname,
    'arguments', pg_get_function_identity_arguments(p.oid),
    'result', pg_get_function_result(p.oid),
    'security_definer', p.prosecdef,
    'authenticated_execute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
    'anon_execute', has_function_privilege('anon', p.oid, 'EXECUTE'),
    'service_role_execute', has_function_privilege('service_role', p.oid, 'EXECUTE'),
    'definition_digest_md5', md5(pg_get_functiondef(p.oid))
  ) order by n.nspname,p.proname,p.oid), '[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','app_private') and p.prokind='f'),
  'registry', (select coalesce(jsonb_agg(jsonb_build_object(
    'id',action_id,'version',version,'permission',permission_key,'risk',risk,
    'executorKind',executor_kind,'consentRequired',consent_required,
    'previewRpc',preview_rpc,'executeRpc',execute_rpc,'enabled',enabled,
    'grantable',grantable,'pinAlways',pin_always
  ) order by action_id),'[]'::jsonb) from app_private.copilot_action_registry),
  'flags', (select coalesce(jsonb_agg(jsonb_build_object(
    'scope',scope,'contract',contract_id,'state',state,'hasCanary',canary_org is not null,
    'expired',expires_at is not null and expires_at<=now(),'revision',revision
  ) order by scope,contract_id),'[]'::jsonb) from public.copilot_feature_flags),
  'settings', (select jsonb_build_object('org_rows',count(*),
    'chat_enabled_rows',count(*) filter(where chat_enabled),
    'ui_control_enabled_rows',count(*) filter(where ui_control_enabled))
    from public.ai_copilot_settings),
  'migrations', (select coalesce(jsonb_agg(version order by version),'[]'::jsonb)
    from supabase_migrations.schema_migrations)
) as catalog;
