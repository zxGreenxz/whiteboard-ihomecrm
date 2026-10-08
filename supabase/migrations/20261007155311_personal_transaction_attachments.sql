-- Owner-private receipt images for personal transactions; forward-only migration.
ALTER TABLE public.personal_transactions ADD COLUMN IF NOT EXISTS attachment_paths text[] NOT NULL DEFAULT '{}';
DO $constraint$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.personal_transactions'::regclass AND conname='personal_txn_attachment_count') THEN
  ALTER TABLE public.personal_transactions ADD CONSTRAINT personal_txn_attachment_count
   CHECK(cardinality(attachment_paths)<=20 AND array_position(attachment_paths,NULL) IS NULL);
 END IF;
END $constraint$;

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('personal-finance-attachments','personal-finance-attachments',false,5242880,ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

DROP POLICY IF EXISTS personal_attachment_read ON storage.objects;
CREATE POLICY personal_attachment_read ON storage.objects FOR SELECT TO authenticated
USING(bucket_id='personal-finance-attachments' AND owner_id=(select auth.uid())::text AND split_part(name,'/',1)=(select auth.uid())::text);
DROP POLICY IF EXISTS personal_attachment_insert ON storage.objects;
CREATE POLICY personal_attachment_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK(bucket_id='personal-finance-attachments' AND owner_id=(select auth.uid())::text AND
 name ~ ('^'||(select auth.uid())::text||'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$'));

-- Generic storage policies are permissive (OR). These fences also cover anonymous policies.
DROP POLICY IF EXISTS personal_attachment_read_fence ON storage.objects;
CREATE POLICY personal_attachment_read_fence ON storage.objects AS RESTRICTIVE FOR SELECT TO public
USING(bucket_id<>'personal-finance-attachments' OR (owner_id=(select auth.uid())::text AND split_part(name,'/',1)=(select auth.uid())::text));
DROP POLICY IF EXISTS personal_attachment_insert_fence ON storage.objects;
CREATE POLICY personal_attachment_insert_fence ON storage.objects AS RESTRICTIVE FOR INSERT TO public
WITH CHECK(bucket_id<>'personal-finance-attachments' OR (owner_id=(select auth.uid())::text AND
 name ~ ('^'||(select auth.uid())::text||'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$')));
DROP POLICY IF EXISTS personal_attachment_no_replace ON storage.objects;
CREATE POLICY personal_attachment_no_replace ON storage.objects AS RESTRICTIVE FOR UPDATE TO public
USING(bucket_id<>'personal-finance-attachments') WITH CHECK(bucket_id<>'personal-finance-attachments');
DROP POLICY IF EXISTS personal_attachment_no_delete ON storage.objects;
CREATE POLICY personal_attachment_no_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO public
USING(bucket_id<>'personal-finance-attachments');

-- Files are immutable. Removing an attachment changes its transaction reference only:
-- other transactions and immutable replay receipts can still refer to the same file.

CREATE OR REPLACE FUNCTION public.personal_finance_apply(p_action text,p_data jsonb,p_id uuid DEFAULT NULL,p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE u uuid:=auth.uid(); entity text:=split_part(p_action,'.',1); op text:=split_part(p_action,'.',2);
 tab text; allowed text[]; cols text; vals text; changes text; old jsonb; result jsonb; d jsonb:=p_data; k text; v jsonb; cat public.personal_categories; n numeric; attachment jsonb; attachment_path text;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'personal_permission' USING ERRCODE='42501'; END IF;
 CASE entity
 WHEN 'wallet' THEN tab:='personal_wallets'; allowed:=ARRAY['name','kind','icon','opening_balance','hidden'];
 WHEN 'category' THEN tab:='personal_categories'; allowed:=ARRAY['type','name','icon','color','hidden'];
 WHEN 'budget' THEN tab:='personal_budget_limits'; allowed:=ARRAY['category_id','amount'];
 WHEN 'goal' THEN tab:='personal_goals'; allowed:=ARRAY['name','icon','target','target_date','wallet_id'];
 WHEN 'transfer' THEN tab:='personal_wallet_transfers'; allowed:=ARRAY['source_wallet_id','target_wallet_id','amount','txn_date','note','goal_id'];
 WHEN 'transaction' THEN tab:='personal_transactions'; allowed:=ARRAY['type','amount','txn_date','description','wallet_id','category_id','attachment_paths'];
 ELSE RAISE EXCEPTION 'personal_validation: entity' USING ERRCODE='22023'; END CASE;
 IF op NOT IN ('create','update','delete') OR cardinality(string_to_array(p_action,'.'))<>2 OR jsonb_typeof(d) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'personal_validation: action/data' USING ERRCODE='22023'; END IF;
 IF op='create' AND (p_id IS NOT NULL OR p_version IS NOT NULL) THEN RAISE EXCEPTION 'personal_validation: create identity' USING ERRCODE='22023'; END IF;
 FOR k,v IN SELECT * FROM jsonb_each(d) LOOP
  IF NOT(k=ANY(allowed)) THEN RAISE EXCEPTION 'personal_validation: field' USING ERRCODE='22023'; END IF;
  IF k IN ('name','icon','type','kind','color','description','note') AND jsonb_typeof(v) NOT IN ('string','null') THEN RAISE EXCEPTION 'personal_validation: text' USING ERRCODE='22023'; END IF;
  IF k IN ('amount','opening_balance','target') THEN
   IF jsonb_typeof(v)<>'number' THEN RAISE EXCEPTION 'personal_validation: money' USING ERRCODE='22023'; END IF;
   n:=(v#>>'{}')::numeric;
   IF n<>trunc(n) OR abs(n)>1000000000000 OR (k<>'opening_balance' AND n<=0) THEN RAISE EXCEPTION 'personal_validation: money' USING ERRCODE='22023'; END IF;
  END IF;
  IF k IN ('txn_date','target_date') AND v<>'null'::jsonb THEN
   IF jsonb_typeof(v)<>'string' OR (v#>>'{}')!~'^\d{4}-\d{2}-\d{2}$' OR (v#>>'{}')::date NOT BETWEEN '1900-01-01' AND '9999-12-31' THEN RAISE EXCEPTION 'personal_validation: date' USING ERRCODE='22023'; END IF;
  END IF;
  IF k='attachment_paths' THEN
   IF jsonb_typeof(v) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'personal_validation: attachments must be an array' USING ERRCODE='22023'; END IF;
   IF jsonb_array_length(v)>20 THEN RAISE EXCEPTION 'personal_validation: attachment limit' USING ERRCODE='22023'; END IF;
   FOR attachment IN SELECT value FROM jsonb_array_elements(v) LOOP
    attachment_path:=attachment#>>'{}';
    IF jsonb_typeof(attachment)<>'string' OR attachment_path !~ ('^'||u::text||'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$') THEN
     RAISE EXCEPTION 'personal_validation: attachment path' USING ERRCODE='22023';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='personal-finance-attachments' AND o.name=attachment_path AND o.owner_id=u::text) THEN
     RAISE EXCEPTION 'personal_permission: attachment owner' USING ERRCODE='42501';
    END IF;
   END LOOP;
  END IF;
  IF k='hidden' AND jsonb_typeof(v)<>'boolean' THEN RAISE EXCEPTION 'personal_validation: hidden' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF op<>'create' THEN
  IF p_id IS NULL OR p_version IS NULL OR p_version<1 THEN RAISE EXCEPTION 'personal_validation: expected_version' USING ERRCODE='22023'; END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 AND user_id=$2',tab) INTO old USING p_id,u;
  IF old IS NULL THEN RAISE EXCEPTION 'personal_permission: entity' USING ERRCODE='42501'; END IF;
  IF (old->>'version')::integer<>p_version OR old->>'deleted_at' IS NOT NULL THEN RAISE EXCEPTION 'personal_conflict: version' USING ERRCODE='PT409'; END IF;
  IF entity='transfer' AND old->>'goal_id' IS NOT NULL THEN RAISE EXCEPTION 'personal_conflict: goal contributions are immutable' USING ERRCODE='23514'; END IF;
  IF entity='category' AND d ? 'type' AND d->>'type'<>old->>'type' THEN RAISE EXCEPTION 'personal_validation: category type is immutable' USING ERRCODE='22023'; END IF;
 END IF;
 IF op='delete' THEN
  IF d<>'{}'::jsonb THEN RAISE EXCEPTION 'personal_validation: delete data' USING ERRCODE='22023'; END IF;
  IF entity='wallet' AND ((old->>'is_default')::boolean OR EXISTS(SELECT 1 FROM public.personal_transactions WHERE user_id=u AND wallet_id=p_id) OR EXISTS(SELECT 1 FROM public.personal_wallet_transfers WHERE user_id=u AND (source_wallet_id=p_id OR target_wallet_id=p_id)) OR EXISTS(SELECT 1 FROM public.personal_goals WHERE user_id=u AND wallet_id=p_id)) THEN RAISE EXCEPTION 'personal_conflict: wallet in use' USING ERRCODE='23514'; END IF;
  IF entity='category' AND (old->>'seed_key' IS NOT NULL OR EXISTS(SELECT 1 FROM public.personal_transactions WHERE user_id=u AND category_id=p_id) OR EXISTS(SELECT 1 FROM public.personal_legacy_category_map WHERE user_id=u AND category_id=p_id) OR EXISTS(SELECT 1 FROM public.personal_budget_limits WHERE user_id=u AND category_id=p_id)) THEN RAISE EXCEPTION 'personal_conflict: category in use' USING ERRCODE='23514'; END IF;
  IF entity='goal' AND EXISTS(SELECT 1 FROM public.personal_wallet_transfers WHERE user_id=u AND goal_id=p_id) THEN RAISE EXCEPTION 'personal_conflict: goal has contributions' USING ERRCODE='23514'; END IF;
 END IF;
 IF entity='category' AND op<>'create' AND (op='delete' OR coalesce((d->>'hidden')::boolean,false)) AND NOT coalesce((old->>'hidden')::boolean,false) AND NOT EXISTS(SELECT 1 FROM public.personal_categories WHERE user_id=u AND type=old->>'type' AND NOT hidden AND id<>p_id) THEN RAISE EXCEPTION 'personal_conflict: last visible category' USING ERRCODE='23514'; END IF;
 IF op<>'delete' THEN
  IF entity='transaction' THEN
   IF op='create' AND NOT(d ?& ARRAY['type','amount','txn_date','wallet_id','category_id']) THEN RAISE EXCEPTION 'personal_validation: transaction required fields' USING ERRCODE='22023'; END IF;
   IF d ? 'wallet_id' AND d->>'wallet_id' IS NULL OR d ? 'category_id' AND d->>'category_id' IS NULL THEN RAISE EXCEPTION 'personal_validation: references' USING ERRCODE='22023'; END IF;
   IF length(d->>'description')>500 THEN RAISE EXCEPTION 'personal_validation: description' USING ERRCODE='22023'; END IF;
   IF d ? 'category_id' OR d ? 'type' THEN
    SELECT * INTO cat FROM public.personal_categories WHERE id=coalesce(d->>'category_id',old->>'category_id')::uuid AND user_id=u AND type=coalesce(d->>'type',old->>'type');
    IF cat.id IS NULL THEN RAISE EXCEPTION 'personal_permission: category/type' USING ERRCODE='42501'; END IF;
    d:=d||jsonb_build_object('category',cat.name);
   END IF;
  END IF;
  IF entity='transfer' AND op='update' AND d->>'goal_id' IS NOT NULL THEN RAISE EXCEPTION 'personal_validation: cannot convert transfer to contribution' USING ERRCODE='22023'; END IF;
  -- All FK references include user_id; an administrator has no cross-owner escape.
  SELECT string_agg(format('%I',key),','),string_agg(format('r.%I',key),','),string_agg(format('%I=r.%I',key,key),',') INTO cols,vals,changes FROM jsonb_object_keys(d) key;
  IF op='create' THEN
   IF cols IS NULL THEN RAISE EXCEPTION 'personal_validation: empty data' USING ERRCODE='22023'; END IF;
   EXECUTE format('WITH r AS (SELECT * FROM jsonb_populate_record(NULL::public.%I,$1)), ins AS (INSERT INTO public.%I (user_id,%s) SELECT $2,%s FROM r RETURNING *) SELECT to_jsonb(ins) FROM ins',tab,tab,cols,vals) INTO result USING d,u;
  ELSE
   IF cols IS NULL THEN RAISE EXCEPTION 'personal_validation: empty update' USING ERRCODE='22023'; END IF;
   EXECUTE format('WITH r AS (SELECT * FROM jsonb_populate_record(NULL::public.%I,$1)), upd AS (UPDATE public.%I t SET %s,version=t.version+1 FROM r WHERE t.id=$2 AND t.user_id=$3 RETURNING t.*) SELECT to_jsonb(upd) FROM upd',tab,tab,changes) INTO result USING d,p_id,u;
  END IF;
 ELSE
  IF entity IN ('transaction','transfer') THEN
   EXECUTE format('UPDATE public.%I SET deleted_at=now(),version=version+1 WHERE id=$1 AND user_id=$2',tab) USING p_id,u;
  ELSE EXECUTE format('DELETE FROM public.%I WHERE id=$1 AND user_id=$2',tab) USING p_id,u; END IF;
  result:=jsonb_build_object('id',p_id,'user_id',u,'version',p_version+1,'deleted',true);
 END IF;
 RETURN result;
END $fn$;

REVOKE ALL ON FUNCTION public.personal_finance_apply(text,jsonb,uuid,integer) FROM PUBLIC,anon,authenticated;
-- Retain actor ownership after table DDL in installations with an org-boundary event trigger.
DROP POLICY IF EXISTS personal_transactions_org_boundary ON public.personal_transactions;
NOTIFY pgrst,'reload schema';
