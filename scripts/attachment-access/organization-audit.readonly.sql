-- Organization audit only. No inserts, updates, temporary objects or policy changes.
-- Run against tryymsxyyckgbrmmvozx; save results outside the repository.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout='30s';

SELECT m.organization_id,m.member_type,m.status,m.valid_from,m.valid_to
FROM public.organization_memberships m
WHERE m.user_id='90450d5f-29b6-4897-bdef-cdb5fb53f339';

SELECT * FROM app_private.derive_uploader_org_v1('90450d5f-29b6-4897-bdef-cdb5fb53f339');

SELECT l.bucket_id,count(*) AS unclassified,
 count(*) FILTER (WHERE EXISTS (
   SELECT 1 FROM public.income_expenses v
   WHERE v.deleted_at IS NULL AND v.organization_id='aaaa0000-0000-4000-8000-000000000001'
     AND v.attachments @> jsonb_build_array(
       'https://tryymsxyyckgbrmmvozx.supabase.co/storage/v1/object/public/'||l.bucket_id||'/'||l.object_name)
 )) AS referenced_by_ihome_voucher
FROM app_private.storage_object_links l
WHERE l.owner_user_id='90450d5f-29b6-4897-bdef-cdb5fb53f339'
  AND l.organization_id IS NULL
GROUP BY l.bucket_id;

SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
 md5(pg_get_functiondef(p.oid)) AS definition_digest,
 pg_get_functiondef(p.oid) AS definition
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE p.prokind='f' AND n.nspname IN ('public','app_private')
 AND p.proname IN (
 '_autofill_org','_autofill_org_salary','derive_uploader_org_v1','storage_object_link_maintain',
 'current_admin_org_v1','get_authorization_context_v1','resolve_ie_type_org_for_user_v1',
 'resolve_finance_actor_v2','get_ie_auto_approve_threshold_v1','set_ie_auto_approve_threshold_v1',
 'get_organization_profile_v1','update_organization_profile_v1','list_organization_members_v1',
 'list_organization_roles_v1','list_authorization_catalog_v1','get_member_authorization_v1',
 'upsert_organization_role_v1','invite_organization_member_v1','revoke_organization_invitation_v1',
 'set_membership_status_v1','get_notification_org_config_v1','set_notification_org_config_v1',
 'lucky_admin_org_v1','copilot_salary_org_of_staff_v1','copilot_preview_salary_chi_luong_v1',
 'create_cashbook_v1','create_income_expense_v1','ie_compat_insert_v2','annotate_income_expense_v1',
 'adopt_voucher_attachments_as_evidence_v2','finalize_finance_evidence_v2'
 )
ORDER BY n.nspname,p.proname,arguments;

SELECT c.relname AS table_name,t.tgname,pg_get_triggerdef(t.oid) AS trigger_definition
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname='public' AND p.proname='_autofill_org'
ORDER BY c.relname,t.tgname;

-- Nullable columns are candidates, not proof of exposure: RPCs/RLS may protect them.
SELECT c.table_name,c.is_nullable,c.column_default,
 (SELECT jsonb_agg(t.tgname) FROM pg_trigger t JOIN pg_class cl ON cl.oid=t.tgrelid
  JOIN pg_namespace ns ON ns.oid=cl.relnamespace
  WHERE ns.nspname='public' AND cl.relname=c.table_name
    AND NOT t.tgisinternal AND (t.tgtype & 4)=4) AS insert_triggers
FROM information_schema.columns c
JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
WHERE c.table_schema='public' AND c.column_name='organization_id' AND t.table_type='BASE TABLE'
ORDER BY c.table_name;

SELECT table_name,count(*) FROM public.authorization_migration_exceptions
WHERE reason='PROD_DEFAULT_FALLBACK at insert' GROUP BY table_name;
ROLLBACK;
