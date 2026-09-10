-- REVIEW DRAFT, NOT AN APPLIED MIGRATION. Ends with ROLLBACK intentionally.
-- Issue: upload creates a NULL-org quarantine link for a multi-org uploader.
-- Both finance finalizers then use ON CONFLICT DO NOTHING and never bind it.
-- Preserve their existing authorization, accounting, and state transitions.
-- Scope: income-expense-attachments ONLY. Other buckets retain the original code.
-- Only the uploader may bind a previously unclassified object to an active org.
-- Existing links to another org and protected supplemental proofs are immutable.
-- Production deployment requires the backup/provenance lane in PROJECT_CONTRACT §4.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE OR REPLACE FUNCTION app_private.bind_finance_storage_org_v1(
  p_org uuid, p_bucket text, p_object text
)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app_private,public,storage AS $bind$
DECLARE
  stored storage.objects;
  link app_private.storage_object_links;
  uploader uuid;
BEGIN
  IF auth.uid() IS NULL OR p_org IS NULL OR p_bucket IS DISTINCT FROM 'income-expense-attachments'
     OR NOT app_private.active_working_membership_v1(auth.uid(),p_org) THEN
    RAISE EXCEPTION 'Active membership and finance storage context required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO stored FROM storage.objects WHERE bucket_id=p_bucket AND name=p_object FOR SHARE;
  IF NOT FOUND OR stored.archived_at IS NOT NULL OR stored.is_delete_marker IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Active storage object required' USING ERRCODE='55000';
  END IF;
  SELECT * INTO link FROM app_private.storage_object_links
    WHERE bucket_id=p_bucket AND object_name=p_object FOR UPDATE;
  IF FOUND AND link.organization_id IS NOT NULL THEN
    IF link.organization_id <> p_org THEN
      RAISE EXCEPTION 'Storage object belongs to another organization' USING ERRCODE='42501';
    END IF;
    RETURN; -- Already bound: retain its owner, provenance and all existing rules.
  END IF;
  uploader := COALESCE(NULLIF(stored.owner_id,'' )::uuid,stored.owner);
  IF uploader IS DISTINCT FROM auth.uid()
     OR (split_part(p_object,'/',1) IS DISTINCT FROM uploader::text AND NOT EXISTS (
       SELECT 1 FROM public.finance_evidence_objects f
        WHERE f.bucket_id=p_bucket AND f.object_name=p_object AND f.organization_id=p_org
          AND f.uploader_user_id=uploader AND f.state IN ('UPLOAD_INTENT','FINALIZED','ATTACHED')
          AND p_object LIKE 'v2/'||p_org::text||'/%'
     ))
     OR (link.object_name IS NOT NULL AND
        (link.owner_user_id IS DISTINCT FROM uploader OR link.derivation <> 'quarantine')) THEN
    RAISE EXCEPTION 'Only the uploader may bind an unclassified storage object' USING ERRCODE='42501';
  END IF;
  IF app_private.ie_storage_is_supplement_v1(p_bucket,p_object) THEN
    RAISE EXCEPTION 'Protected supplemental proof cannot be relinked' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.finance_evidence_objects
      WHERE bucket_id=p_bucket AND object_name=p_object
        AND (organization_id IS DISTINCT FROM p_org OR state='QUARANTINED')) THEN
    RAISE EXCEPTION 'Conflicting or quarantined finance evidence' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM public.income_expenses v
      WHERE v.organization_id IS DISTINCT FROM p_org
        AND v.attachments @> jsonb_build_array(
          'https://tryymsxyyckgbrmmvozx.supabase.co/storage/v1/object/public/'||p_bucket||'/'||p_object)) THEN
    RAISE EXCEPTION 'Storage object referenced by another organization' USING ERRCODE='42501';
  END IF;
  INSERT INTO app_private.storage_object_links AS existing
    (bucket_id,object_name,organization_id,owner_user_id,derivation)
  VALUES(p_bucket,p_object,p_org,uploader,'FINANCE_V2_EVIDENCE')
  ON CONFLICT(bucket_id,object_name) DO UPDATE
    SET organization_id=EXCLUDED.organization_id,derivation=EXCLUDED.derivation
    WHERE existing.organization_id IS NULL AND existing.derivation='quarantine'
      AND existing.owner_user_id=uploader;
  IF NOT EXISTS(SELECT 1 FROM app_private.storage_object_links
     WHERE bucket_id=p_bucket AND object_name=p_object AND organization_id=p_org
       AND owner_user_id=uploader) THEN
    RAISE EXCEPTION 'Concurrent storage ownership change' USING ERRCODE='40001';
  END IF;
END $bind$;
REVOKE ALL ON FUNCTION app_private.bind_finance_storage_org_v1(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;

-- Every new/additional voucher attachment is bound within the same transaction
-- as its parent. This covers create/compat/annotation paths, not just posting.
CREATE OR REPLACE FUNCTION app_private.bind_voucher_attachment_links_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app_private,public,storage AS $parent$
DECLARE v_url text; v_object text;
  v_prefix constant text := 'https://tryymsxyyckgbrmmvozx.supabase.co/storage/v1/object/public/income-expense-attachments/';
BEGIN
  IF NEW.attachments IS NULL OR jsonb_typeof(NEW.attachments)<>'array' THEN RETURN NEW; END IF;
  FOR v_url IN SELECT jsonb_array_elements_text(NEW.attachments) LOOP
    IF TG_OP='UPDATE' AND OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id
       AND coalesce(OLD.attachments,'[]'::jsonb) @> jsonb_build_array(v_url) THEN CONTINUE; END IF;
    IF left(v_url,length(v_prefix))<>v_prefix THEN CONTINUE; END IF;
    v_object := split_part(substring(v_url FROM length(v_prefix)+1),'?',1);
    PERFORM app_private.bind_finance_storage_org_v1(NEW.organization_id,'income-expense-attachments',v_object);
  END LOOP;
  RETURN NEW;
END $parent$;
REVOKE ALL ON FUNCTION app_private.bind_voucher_attachment_links_v1() FROM PUBLIC,anon,authenticated,service_role;
DO $parent_trigger$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.income_expenses'::regclass AND tgname='a90_bind_voucher_attachment_links') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.income_expenses'::regclass AND t.tgname='a90_bind_voucher_attachment_links'
        AND t.tgfoid='app_private.bind_voucher_attachment_links_v1()'::regprocedure
        AND t.tgtype=21 AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgenabled='O'
        AND t.tgattr::text=(SELECT string_agg(attnum::text,' ' ORDER BY array_position(ARRAY['attachments','organization_id'],attname::text))
          FROM pg_attribute WHERE attrelid=t.tgrelid AND attname IN ('attachments','organization_id'))
    ) THEN RAISE EXCEPTION 'Existing attachment trigger differs from reviewed definition'; END IF;
  ELSE
    CREATE TRIGGER a90_bind_voucher_attachment_links
    AFTER INSERT OR UPDATE OF attachments,organization_id ON public.income_expenses
    FOR EACH ROW EXECUTE FUNCTION app_private.bind_voucher_attachment_links_v1();
  END IF;
END $parent_trigger$;

-- Surgical replacements in the CURRENT definitions: no copied/older RPC body can
-- overwrite an authorization guard added elsewhere. Unexpected definitions fail.
DO $patch$
DECLARE
  r record;
  original text;
  updated text;
  pattern text;
  replacement text;
  matches integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.adopt_voucher_attachments_as_evidence_v2(uuid)',
     'v_bucket,[[:space:]]*v_object,[[:space:]]*v_ie\.organization_id,[[:space:]]*v_actor\.user_id',
     'PERFORM app_private.bind_finance_storage_org_v1(v_ie.organization_id,v_bucket,v_object);',
     'v_bucket'),
    ('public.finalize_finance_evidence_v2(uuid)',
     'v_row\.bucket_id,[[:space:]]*v_row\.object_name,[[:space:]]*v_row\.organization_id,[[:space:]]*auth\.uid\(\)',
     'PERFORM app_private.bind_finance_storage_org_v1(v_row.organization_id,v_row.bucket_id,v_row.object_name);',
     'v_row.bucket_id')
  ) patches(signature,arguments,call_statement,bucket_expression) LOOP
    original := pg_get_functiondef(r.signature::regprocedure);
    pattern := 'INSERT[[:space:]]+INTO[[:space:]]+app_private\.storage_object_links[[:space:]]*'
      || '\(bucket_id,[[:space:]]*object_name,[[:space:]]*organization_id,[[:space:]]*owner_user_id,[[:space:]]*derivation\)'
      || '[[:space:]]*VALUES[[:space:]]*\('||r.arguments||',[[:space:]]*''FINANCE_V2_EVIDENCE''\)'
      || '[[:space:]]*ON[[:space:]]+CONFLICT[[:space:]]+DO[[:space:]]+NOTHING;';
    SELECT count(*) INTO matches FROM regexp_matches(original,pattern,'g');
    IF strpos(original,r.call_statement)>0 THEN CONTINUE; END IF;
    IF matches<>1 THEN RAISE EXCEPTION 'Unexpected live RPC definition: %',r.signature; END IF;
    replacement := 'IF '||r.bucket_expression||' = ''income-expense-attachments'' THEN '
      ||r.call_statement||' ELSE '||substring(original FROM pattern)||' END IF;';
    updated := regexp_replace(original,pattern,replacement);
    IF r.signature='public.adopt_voucher_attachments_as_evidence_v2(uuid)' THEN
      IF strpos(updated,'IF v_row.state <> ''FINALIZED'' THEN')=0 THEN RAISE EXCEPTION 'Adoption state guard changed'; END IF;
      updated := replace(updated,'IF v_row.state <> ''FINALIZED'' THEN',
        'IF v_bucket = ''income-expense-attachments'' AND v_row.state = ''ATTACHED'' THEN
           PERFORM app_private.bind_finance_storage_org_v1(v_ie.organization_id,v_bucket,v_object);
         END IF;
         IF v_row.state <> ''FINALIZED'' THEN');
    ELSE
      IF strpos(updated,'IF v_row.state = ''FINALIZED'' THEN')=0 THEN RAISE EXCEPTION 'Finalization state guard changed'; END IF;
      updated := replace(updated,'IF v_row.state = ''FINALIZED'' THEN',
        'IF v_row.state = ''FINALIZED'' THEN
           IF v_row.bucket_id = ''income-expense-attachments'' THEN
             PERFORM app_private.bind_finance_storage_org_v1(v_row.organization_id,v_row.bucket_id,v_row.object_name);
           END IF;');
    END IF;
    EXECUTE updated;
  END LOOP;
END $patch$;
ROLLBACK;
