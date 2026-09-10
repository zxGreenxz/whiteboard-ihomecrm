BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='60s';
SELECT jsonb_build_object(
  'captured_at',clock_timestamp(),
  'functions',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),'definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl,'digest',md5(pg_get_functiondef(p.oid)))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind='f' AND n.nspname IN ('public','app_private')),
  'policies',(SELECT jsonb_agg(to_jsonb(p)) FROM pg_policies p WHERE p.schemaname IN ('public','app_private','storage')),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',t.tgname,'definition',pg_get_triggerdef(t.oid))) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('public','app_private','storage')),
  'columns',(SELECT jsonb_agg(to_jsonb(c)) FROM information_schema.columns c WHERE c.table_schema IN ('public','app_private','storage')),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',k.conname,'definition',pg_get_constraintdef(k.oid))) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','app_private','storage')),
  'grants',(SELECT jsonb_agg(to_jsonb(g)) FROM information_schema.role_table_grants g WHERE g.table_schema IN ('public','app_private','storage')),
  'uploader_memberships',(SELECT jsonb_agg(to_jsonb(m)) FROM public.organization_memberships m WHERE m.user_id='90450d5f-29b6-4897-bdef-cdb5fb53f339'),
  'unclassified_attachments',(SELECT jsonb_agg(jsonb_build_object(
    'object_name',l.object_name,'original_link',to_jsonb(l),'storage_object_id',s.id,
    'storage_owner',coalesce(s.owner_id,s.owner::text),'archived_at',s.archived_at,'is_delete_marker',s.is_delete_marker,
    'is_supplement',app_private.ie_storage_is_supplement_v1(l.bucket_id,l.object_name),
    'vouchers',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'org',v.organization_id,'deleted',v.deleted_at)) FROM public.income_expenses v WHERE v.attachments @> jsonb_build_array('https://tryymsxyyckgbrmmvozx.supabase.co/storage/v1/object/public/'||l.bucket_id||'/'||l.object_name)),'[]'::jsonb),
    'finance_evidence',coalesce((SELECT jsonb_agg(jsonb_build_object('org',f.organization_id,'state',f.state)) FROM public.finance_evidence_objects f WHERE f.bucket_id=l.bucket_id AND f.object_name=l.object_name),'[]'::jsonb)
  )) FROM app_private.storage_object_links l LEFT JOIN storage.objects s ON s.bucket_id=l.bucket_id AND s.name=l.object_name WHERE l.bucket_id='income-expense-attachments' AND l.organization_id IS NULL AND l.owner_user_id='90450d5f-29b6-4897-bdef-cdb5fb53f339')
) AS snapshot;
ROLLBACK;
