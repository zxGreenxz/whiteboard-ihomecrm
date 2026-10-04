-- Personal ledger: owner identity survives organization changes. No historical rewrites.
-- Register actor ownership before DDL so the existing org event trigger cannot reattach its policy.
INSERT INTO app_private.org_boundary_exemptions(table_name,reason,decided_by,expires_at,replacement_policy)
VALUES('personal_transactions',
 'Actor-owned personal ledger. TEST: 5 real JWT actors; 4 other actors (same/different org, org owner, super admin) read 0 owner rows; owner retains history after membership removal. organization_id is historical metadata, not ownership.',
 'Product owner: approved personal-finance design 2026-10-05',DATE '2027-01-05','personal_txn_own: user_id = auth.uid(); personal_transactions_hide_sandbox_admin retained; RPC-only DML after app rollout')
ON CONFLICT(table_name) DO UPDATE SET reason=excluded.reason,decided_by=excluded.decided_by,expires_at=excluded.expires_at,replacement_policy=excluded.replacement_policy;
CREATE TABLE IF NOT EXISTS public.personal_wallets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80), kind text NOT NULL DEFAULT 'cash' CHECK(kind IN ('cash','bank','ewallet','saving','other')),
 icon text NOT NULL DEFAULT '👛' CHECK(length(icon) BETWEEN 1 AND 32), opening_balance numeric(15,2) NOT NULL DEFAULT 0 CHECK(abs(opening_balance)<=1000000000000),
 hidden boolean NOT NULL DEFAULT false, is_default boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1 CHECK(version>0), UNIQUE(id,user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS personal_wallets_name ON public.personal_wallets(user_id,lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS personal_wallets_default ON public.personal_wallets(user_id) WHERE is_default;
ALTER TABLE public.personal_wallets DROP CONSTRAINT IF EXISTS personal_wallets_kind_check;
ALTER TABLE public.personal_wallets ADD CONSTRAINT personal_wallets_kind_check CHECK(kind IN ('cash','bank','ewallet','saving','other'));
CREATE TABLE IF NOT EXISTS public.personal_categories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 type text NOT NULL CHECK(type IN ('INCOME','EXPENSE')), name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),
 icon text NOT NULL DEFAULT '🧾' CHECK(length(icon) BETWEEN 1 AND 32), color text NOT NULL DEFAULT '#adafa7' CHECK(color ~ '^#[0-9a-fA-F]{6}$'),
 hidden boolean NOT NULL DEFAULT false, seed_key text, legacy_name text, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(id,user_id), UNIQUE(id,user_id,type), UNIQUE(user_id,seed_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS personal_categories_name ON public.personal_categories(user_id,type,lower(btrim(name)));
CREATE TABLE IF NOT EXISTS public.personal_legacy_category_map (
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, type text NOT NULL, legacy_name text NOT NULL, category_id uuid NOT NULL,
 PRIMARY KEY(user_id,type,legacy_name), FOREIGN KEY(category_id,user_id,type) REFERENCES public.personal_categories(id,user_id,type)
);
CREATE TABLE IF NOT EXISTS public.personal_budget_limits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 category_id uuid, type text NOT NULL DEFAULT 'EXPENSE' CHECK(type='EXPENSE'), amount numeric(15,2) NOT NULL CHECK(amount>0 AND amount<=1000000000000),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), FOREIGN KEY(category_id,user_id,type) REFERENCES public.personal_categories(id,user_id,type)
);
CREATE UNIQUE INDEX IF NOT EXISTS personal_budget_limits_scope ON public.personal_budget_limits(user_id,coalesce(category_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE TABLE IF NOT EXISTS public.personal_goals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80), icon text NOT NULL DEFAULT '🎯' CHECK(length(icon) BETWEEN 1 AND 32),
 target numeric(15,2) NOT NULL CHECK(target>0 AND target<=1000000000000), target_date date CHECK(target_date BETWEEN '1900-01-01' AND '9999-12-31'),
 wallet_id uuid NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(id,user_id,wallet_id), FOREIGN KEY(wallet_id,user_id) REFERENCES public.personal_wallets(id,user_id)
);
CREATE TABLE IF NOT EXISTS public.personal_wallet_transfers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 source_wallet_id uuid NOT NULL, target_wallet_id uuid NOT NULL, amount numeric(15,2) NOT NULL CHECK(amount>0 AND amount<=1000000000000),
 txn_date date NOT NULL CHECK(txn_date BETWEEN '1900-01-01' AND '9999-12-31'), note text CHECK(length(note)<=500), goal_id uuid,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), deleted_at timestamptz,
 CHECK(source_wallet_id<>target_wallet_id), FOREIGN KEY(source_wallet_id,user_id) REFERENCES public.personal_wallets(id,user_id),
 FOREIGN KEY(target_wallet_id,user_id) REFERENCES public.personal_wallets(id,user_id),
 FOREIGN KEY(goal_id,user_id,target_wallet_id) REFERENCES public.personal_goals(id,user_id,wallet_id)
);
CREATE TABLE IF NOT EXISTS public.personal_finance_requests (
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, request_key uuid NOT NULL, payload jsonb NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,request_key)
);
CREATE INDEX IF NOT EXISTS personal_goals_owner ON public.personal_goals(user_id);
CREATE INDEX IF NOT EXISTS personal_transfers_owner ON public.personal_wallet_transfers(user_id,txn_date);
ALTER TABLE public.personal_transactions ADD COLUMN IF NOT EXISTS wallet_id uuid;
ALTER TABLE public.personal_transactions ADD COLUMN IF NOT EXISTS category_id uuid;
ALTER TABLE public.personal_transactions ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
DO $constraints$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='personal_txn_wallet_owner' AND conrelid='public.personal_transactions'::regclass) THEN
  ALTER TABLE public.personal_transactions ADD CONSTRAINT personal_txn_wallet_owner FOREIGN KEY(wallet_id,user_id) REFERENCES public.personal_wallets(id,user_id);
  ALTER TABLE public.personal_transactions ADD CONSTRAINT personal_txn_category_owner_type FOREIGN KEY(category_id,user_id,type) REFERENCES public.personal_categories(id,user_id,type);
 END IF;
END $constraints$;

DO $rls$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['personal_wallets','personal_categories','personal_legacy_category_map','personal_budget_limits','personal_goals','personal_wallet_transfers','personal_finance_requests'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS personal_owner ON public.%I',t);
  EXECUTE format('CREATE POLICY personal_owner ON public.%I FOR SELECT TO authenticated USING (user_id=(select auth.uid()))',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
  EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
 END LOOP;
END $rls$;
-- Legacy table DML is revoked in the companion post-app hardening migration.

CREATE OR REPLACE FUNCTION public.personal_finance_bootstrap() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE u uuid:=auth.uid(); r record; c uuid;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'personal_permission' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(u::text,741));
 INSERT INTO public.personal_wallets(user_id,name,is_default) VALUES(u,'Ví chính',true) ON CONFLICT DO NOTHING;
 INSERT INTO public.personal_categories(user_id,type,seed_key,name,icon,color)
 SELECT u,v.type,v.key,v.name,v.icon,v.color FROM (VALUES
 ('EXPENSE','food','Ăn uống','🍜','#efbb72'),('EXPENSE','grocery','Thực phẩm','🛒','#b6cba1'),
 ('EXPENSE','home','Nhà cửa','🏠','#779d8f'),('EXPENSE','transport','Đi lại','🚕','#8eafd0'),
 ('EXPENSE','shopping','Mua sắm','🛍️','#c3a0bc'),('EXPENSE','bills','Điện, nước & mạng','💡','#e7cc73'),
 ('EXPENSE','health','Sức khỏe','💊','#d39793'),('EXPENSE','education','Giáo dục','🎓','#9d9cc8'),
 ('EXPENSE','fun','Giải trí','🎮','#aaa6d0'),('EXPENSE','travel','Du lịch','✈️','#8bbdc6'),
 ('EXPENSE','beauty','Làm đẹp','💄','#d9b0c3'),('EXPENSE','sport','Thể thao','⚽','#a5bd8d'),
 ('EXPENSE','pets','Thú cưng','🐾','#cbb096'),('EXPENSE','electronics','Điện tử','📱','#99b1b9'),
 ('EXPENSE','family','Gia đình & quà tặng','🎁','#d5ae88'),('EXPENSE','other','Chi khác','🧾','#adafa7'),
 ('INCOME','salary','Lương','💼','#8bae9c'),('INCOME','bonus','Thưởng','🌟','#e7cc73'),
 ('INCOME','business','Kinh doanh','🏪','#9db9c0'),('INCOME','invest','Lãi & đầu tư','🌱','#a5bd8d'),
 ('INCOME','gift','Được tặng','🎁','#d9b0c3'),('INCOME','refund','Hoàn tiền','↩️','#9d9cc8'),
 ('INCOME','other-income','Thu khác','💰','#adafa7')) v(type,key,name,icon,color) ON CONFLICT DO NOTHING;
 -- Stable exact text mapping, including deleted history; never modify original category.
 FOR r IN SELECT DISTINCT type,category FROM public.personal_transactions WHERE user_id=u AND category_id IS NULL AND category IS NOT NULL LOOP
  IF NOT EXISTS(SELECT 1 FROM public.personal_legacy_category_map WHERE user_id=u AND type=r.type AND legacy_name=r.category) THEN
   SELECT id INTO c FROM public.personal_categories WHERE user_id=u AND type=r.type AND lower(btrim(name))=lower(btrim(r.category));
   IF c IS NULL THEN
    INSERT INTO public.personal_categories(user_id,type,name,legacy_name) VALUES(u,r.type,
     CASE WHEN length(btrim(r.category)) BETWEEN 1 AND 80 THEN btrim(r.category) ELSE 'Danh mục cũ '||substr(md5(r.category),1,16) END,r.category) RETURNING id INTO c;
   END IF;
   INSERT INTO public.personal_legacy_category_map VALUES(u,r.type,r.category,c);
  END IF;
 END LOOP;
END $fn$;

-- One SQL statement gives one MVCC snapshot and aggregates inside PostgreSQL, beyond REST row caps.
CREATE OR REPLACE FUNCTION public.personal_finance_snapshot() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
 WITH tx AS (
 SELECT t.*,coalesce(t.wallet_id,(SELECT id FROM public.personal_wallets WHERE is_default AND user_id=auth.uid())) AS resolved_wallet_id,
 coalesce(t.category_id,m.category_id) AS resolved_category_id
 FROM public.personal_transactions t LEFT JOIN public.personal_legacy_category_map m ON m.user_id=t.user_id AND m.type=t.type AND m.legacy_name=t.category
 WHERE t.user_id=auth.uid() AND t.deleted_at IS NULL
 ), tr AS (SELECT * FROM public.personal_wallet_transfers WHERE user_id=auth.uid() AND deleted_at IS NULL),
 wallets AS (SELECT w.*,w.opening_balance+coalesce((SELECT sum(CASE WHEN type='INCOME' THEN amount ELSE -amount END) FROM tx WHERE resolved_wallet_id=w.id),0)
 +coalesce((SELECT sum(CASE WHEN target_wallet_id=w.id THEN amount ELSE -amount END) FROM tr WHERE source_wallet_id=w.id OR target_wallet_id=w.id),0) AS balance
 FROM public.personal_wallets w WHERE user_id=auth.uid()),
 goals AS (SELECT g.*,coalesce((SELECT sum(amount) FROM tr WHERE goal_id=g.id),0) AS saved FROM public.personal_goals g WHERE user_id=auth.uid())
 SELECT jsonb_build_object('owner_id',auth.uid(),'schema_version',1,
 'wallets',coalesce((SELECT jsonb_agg(to_jsonb(w) ORDER BY is_default DESC,name,id) FROM wallets w),'[]'),
 'categories',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY type,name,id) FROM public.personal_categories c WHERE user_id=auth.uid()),'[]'),
 'transactions',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY txn_date DESC,id) FROM tx t),'[]'),
 'transfers',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY txn_date DESC,id) FROM tr t),'[]'),
 'budgets',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM public.personal_budget_limits b WHERE user_id=auth.uid()),'[]'),
 'goals',coalesce((SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM goals g),'[]'));
$fn$;

-- Internal routine; outer RPC owns authentication, serialization and durable replay.
CREATE OR REPLACE FUNCTION public.personal_finance_apply(p_action text,p_data jsonb,p_id uuid DEFAULT NULL,p_version integer DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE u uuid:=auth.uid(); entity text:=split_part(p_action,'.',1); op text:=split_part(p_action,'.',2);
 tab text; allowed text[]; cols text; vals text; changes text; old jsonb; result jsonb; d jsonb:=p_data; k text; v jsonb; cat public.personal_categories; n numeric;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'personal_permission' USING ERRCODE='42501'; END IF;
 CASE entity
 WHEN 'wallet' THEN tab:='personal_wallets'; allowed:=ARRAY['name','kind','icon','opening_balance','hidden'];
 WHEN 'category' THEN tab:='personal_categories'; allowed:=ARRAY['type','name','icon','color','hidden'];
 WHEN 'budget' THEN tab:='personal_budget_limits'; allowed:=ARRAY['category_id','amount'];
 WHEN 'goal' THEN tab:='personal_goals'; allowed:=ARRAY['name','icon','target','target_date','wallet_id'];
 WHEN 'transfer' THEN tab:='personal_wallet_transfers'; allowed:=ARRAY['source_wallet_id','target_wallet_id','amount','txn_date','note','goal_id'];
 WHEN 'transaction' THEN tab:='personal_transactions'; allowed:=ARRAY['type','amount','txn_date','description','wallet_id','category_id'];
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

CREATE OR REPLACE FUNCTION public.personal_finance_mutate(p_request_key uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE u uuid:=auth.uid(); payload jsonb:=p_payload; cached public.personal_finance_requests; result jsonb; results jsonb:='[]'; r jsonb; k text; v jsonb; data jsonb;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'personal_permission' USING ERRCODE='42501'; END IF;
 IF p_request_key IS NULL OR jsonb_typeof(payload)<>'object' OR payload->>'action' IS NULL THEN RAISE EXCEPTION 'personal_validation: request' USING ERRCODE='22023'; END IF;
 -- Normalize human strings before receipt equality; arrays deliberately retain order and duplicates.
 IF payload->>'action'='transaction.batch' THEN
  IF (payload-ARRAY['action','rows'])<>'{}' OR jsonb_typeof(payload->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'rows') NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'personal_validation: batch' USING ERRCODE='22023'; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(payload->'rows') LOOP
   IF jsonb_typeof(r)<>'object' THEN RAISE EXCEPTION 'personal_validation: batch row' USING ERRCODE='22023'; END IF;
   FOR k,v IN SELECT * FROM jsonb_each(r) LOOP IF jsonb_typeof(v)='string' THEN r:=jsonb_set(r,ARRAY[k],to_jsonb(btrim(v#>>'{}'))); END IF; END LOOP;
   results:=results||jsonb_build_array(r);
  END LOOP;
  payload:=jsonb_set(payload,'{rows}',results);
 ELSE
  IF (payload-ARRAY['action','data','id','expected_version'])<>'{}' OR jsonb_typeof(payload->'data') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'personal_validation: payload' USING ERRCODE='22023'; END IF;
  data:=payload->'data';
  FOR k,v IN SELECT * FROM jsonb_each(data) LOOP IF jsonb_typeof(v)='string' THEN data:=jsonb_set(data,ARRAY[k],to_jsonb(btrim(v#>>'{}'))); END IF; END LOOP;
  payload:=jsonb_set(payload,'{data}',data);
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(u::text,741));
 SELECT * INTO cached FROM public.personal_finance_requests WHERE user_id=u AND request_key=p_request_key;
 IF cached.user_id IS NOT NULL THEN
  IF cached.payload<>payload THEN RAISE EXCEPTION 'personal_conflict: request key' USING ERRCODE='23505'; END IF;
  RETURN cached.result;
 END IF;
 PERFORM public.personal_finance_bootstrap();
 results:='[]';
 IF payload->>'action'='transaction.batch' THEN
  FOR r IN SELECT * FROM jsonb_array_elements(payload->'rows') LOOP results:=results||jsonb_build_array(public.personal_finance_apply('transaction.create',r)); END LOOP;
 ELSE results:=jsonb_build_array(public.personal_finance_apply(payload->>'action',payload->'data',(payload->>'id')::uuid,(payload->>'expected_version')::integer)); END IF;
 result:=jsonb_build_object('owner_id',u,'request_key',p_request_key,'action',payload->>'action','entities',results);
 INSERT INTO public.personal_finance_requests(user_id,request_key,payload,result) VALUES(u,p_request_key,payload,result);
 RETURN result;
END $fn$;

REVOKE ALL ON FUNCTION public.personal_finance_apply(text,jsonb,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.personal_finance_bootstrap(),public.personal_finance_snapshot(),public.personal_finance_mutate(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.personal_finance_bootstrap(),public.personal_finance_snapshot(),public.personal_finance_mutate(uuid,jsonb) TO authenticated;
-- Last DDL on this legacy table: retain own/hide_sandbox, remove only membership coupling.
DROP POLICY IF EXISTS personal_transactions_org_boundary ON public.personal_transactions;
NOTIFY pgrst,'reload schema';
