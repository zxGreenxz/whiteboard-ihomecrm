-- Company wallets are actor-owned shortcuts to existing company cashbooks.
-- No second balance or personal transaction is written for company vouchers.
ALTER TABLE public.personal_wallets ADD COLUMN IF NOT EXISTS is_preferred boolean NOT NULL DEFAULT false;
ALTER TABLE public.personal_wallets DROP CONSTRAINT IF EXISTS personal_wallets_kind_check;
ALTER TABLE public.personal_wallets ADD CONSTRAINT personal_wallets_kind_check CHECK(kind IN ('cash','bank','ewallet','saving','other','sp_card','credit_card'));
CREATE UNIQUE INDEX IF NOT EXISTS personal_wallets_preferred_kind ON public.personal_wallets(user_id,kind) WHERE is_preferred AND NOT hidden;

-- Extend the existing personal writer, keeping all existing validation and CAS.
DO $patch$ DECLARE body text; BEGIN
 SELECT pg_get_functiondef('public.personal_finance_apply(text,jsonb,uuid,integer)'::regprocedure) INTO body;
 IF position('-- personal-wallet-preferred-kind' IN body)=0 THEN
  IF position('allowed:=ARRAY[''name'',''kind'',''icon'',''opening_balance'',''hidden''];' IN body)=0
   OR position('IF k=''hidden'' AND jsonb_typeof(v)<>''boolean''' IN body)=0
   OR position('  -- All FK references include user_id;' IN body)=0 THEN
   RAISE EXCEPTION 'personal_finance_apply changed: inspect before extending wallet preference';
  END IF;
  body:=replace(body,'allowed:=ARRAY[''name'',''kind'',''icon'',''opening_balance'',''hidden''];','allowed:=ARRAY[''name'',''kind'',''icon'',''opening_balance'',''hidden'',''is_preferred''];');
  body:=replace(body,'IF k=''hidden'' AND jsonb_typeof(v)<>''boolean''','IF k IN (''hidden'',''is_preferred'') AND jsonb_typeof(v)<>''boolean''');
  body:=replace(body,'  -- All FK references include user_id;', $code$
  -- personal-wallet-preferred-kind: outer writer serializes all actor changes.
  IF entity='wallet' THEN
   IF coalesce((d->>'hidden')::boolean,(old->>'hidden')::boolean,false) THEN d:=d||'{"is_preferred":false}'::jsonb; END IF;
   IF coalesce((d->>'is_preferred')::boolean,(old->>'is_preferred')::boolean,false) THEN
    UPDATE public.personal_wallets SET is_preferred=false,version=version+1
    WHERE user_id=u AND kind=coalesce(d->>'kind',old->>'kind','cash') AND is_preferred AND id IS DISTINCT FROM p_id;
   END IF;
  END IF;
  -- All FK references include user_id;$code$);
  EXECUTE body;
 END IF;
END $patch$;

CREATE TABLE IF NOT EXISTS public.company_wallets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id),
 organization_id uuid NOT NULL REFERENCES public.organizations(id), account_id uuid NOT NULL REFERENCES public.accounts(id),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80), icon text NOT NULL DEFAULT '🏢' CHECK(length(icon) BETWEEN 1 AND 32),
 kind text NOT NULL CHECK(kind IN ('cash','bank','sp_card','credit_card')), is_preferred boolean NOT NULL DEFAULT false,
 hidden boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(user_id,organization_id,account_id), UNIQUE(id,user_id,organization_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS company_wallets_preferred_kind ON public.company_wallets(user_id,organization_id,kind) WHERE is_preferred AND NOT hidden;
CREATE TABLE IF NOT EXISTS public.company_wallet_requests (
 user_id uuid NOT NULL REFERENCES auth.users(id), organization_id uuid NOT NULL REFERENCES public.organizations(id),
 request_key uuid NOT NULL, payload jsonb NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,organization_id,request_key)
);
CREATE TABLE IF NOT EXISTS public.company_wallet_voucher_origins (
 voucher_id uuid PRIMARY KEY REFERENCES public.income_expenses(id), wallet_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES auth.users(id), organization_id uuid NOT NULL REFERENCES public.organizations(id),
 source text NOT NULL DEFAULT 'personal_wallet' CHECK(source='personal_wallet'),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,organization_id,idempotency_key),
 FOREIGN KEY(wallet_id,user_id,organization_id) REFERENCES public.company_wallets(id,user_id,organization_id)
);
CREATE INDEX IF NOT EXISTS company_wallet_origins_owner ON public.company_wallet_voucher_origins(user_id,organization_id,created_at DESC);

DO $rls$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['company_wallets','company_wallet_requests','company_wallet_voucher_origins'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS company_wallet_owner ON public.%I',t);
  EXECUTE format('CREATE POLICY company_wallet_owner ON public.%I FOR SELECT TO authenticated USING (user_id=(select auth.uid()) AND EXISTS(SELECT 1 FROM public.organization_memberships m WHERE m.user_id=(select auth.uid()) AND m.organization_id=%I.organization_id AND m.status=''ACTIVE''))',t,t);
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',t||'_hide_sandbox_admin',t);
  EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING(NOT COALESCE(public.is_super_admin() AND organization_id=ANY(public.sandbox_org_ids()),false))',t||'_hide_sandbox_admin',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
  EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
 END LOOP;
END $rls$;
-- Provenance carries the submitted bill; losing voucher visibility also hides this copy.
DROP POLICY IF EXISTS company_wallet_origin_visible ON public.company_wallet_voucher_origins;
CREATE POLICY company_wallet_origin_visible ON public.company_wallet_voucher_origins AS RESTRICTIVE FOR SELECT TO authenticated
USING(EXISTS(SELECT 1 FROM public.income_expenses ie WHERE ie.id=voucher_id AND ie.organization_id=company_wallet_voucher_origins.organization_id));

CREATE OR REPLACE FUNCTION public.company_wallet_snapshot(p_organization_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE u uuid:=auth.uid(); result jsonb;
BEGIN
 IF u IS NULL OR COALESCE(public.is_super_admin() AND p_organization_id=ANY(public.sandbox_org_ids()),false) OR NOT EXISTS(SELECT 1 FROM public.organization_memberships WHERE user_id=u AND organization_id=p_organization_id AND status='ACTIVE') THEN RAISE EXCEPTION 'company_wallet_permission: organization' USING ERRCODE='42501'; END IF;
 WITH wallets AS (
  SELECT w.*,a.name AS account_name,
   (a.id IS NOT NULL AND coalesce(v.balance_visible,false)) AS balance_visible,
   CASE WHEN a.id IS NOT NULL AND coalesce(v.balance_visible,false) THEN a.current_amount ELSE NULL END AS balance,
   (a.id IS NOT NULL AND NOT w.hidden AND EXISTS(SELECT 1 FROM public.list_cashbooks_for_expense_v2() c WHERE c.id=w.account_id)) AS can_use
  FROM public.company_wallets w
  LEFT JOIN public.accounts_with_balance_v2 a ON a.id=w.account_id AND a.organization_id=w.organization_id AND NOT a.is_virtual
  LEFT JOIN public.list_cashbook_visibility_v2() v ON v.cashbook_id=w.account_id
  WHERE w.user_id=u AND w.organization_id=p_organization_id
 ), transactions AS (
  SELECT ie.id,o.wallet_id,o.user_id,o.organization_id,ie.code,ie.type,ie.name,ie.total_amount,ie.voucher_date,
   ie.approval_status,ie.posting_status,ie.review_state,ie.attachments,ie.created_at,ie.deleted_at
  FROM public.company_wallet_voucher_origins o JOIN public.income_expenses ie ON ie.id=o.voucher_id AND ie.organization_id=o.organization_id
  WHERE o.user_id=u AND o.organization_id=p_organization_id AND o.source='personal_wallet'
 ) SELECT jsonb_build_object('owner_id',u,'organization_id',p_organization_id,'schema_version',1,
  'wallets',coalesce((SELECT jsonb_agg(to_jsonb(w) ORDER BY hidden,is_preferred DESC,name,id) FROM wallets w),'[]'::jsonb),
  'transactions',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY voucher_date DESC,created_at DESC,id) FROM transactions t),'[]'::jsonb)) INTO result;
 RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION public.company_wallet_mutate(p_organization_id uuid,p_request_key uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE u uuid:=auth.uid(); action text:=p_payload->>'action'; d jsonb:=p_payload->'data'; wallet public.company_wallets;
 cached public.company_wallet_requests; result jsonb; target uuid; k text; v jsonb; next_kind text;
BEGIN
 IF u IS NULL OR COALESCE(public.is_super_admin() AND p_organization_id=ANY(public.sandbox_org_ids()),false) OR NOT EXISTS(SELECT 1 FROM public.organization_memberships WHERE user_id=u AND organization_id=p_organization_id AND status='ACTIVE') THEN RAISE EXCEPTION 'company_wallet_permission: organization' USING ERRCODE='42501'; END IF;
 IF p_request_key IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR (p_payload-ARRAY['action','id','expected_version','data'])<>'{}'::jsonb OR action IS NULL OR action NOT IN ('create','update','delete') OR jsonb_typeof(d) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'company_wallet_validation: payload' USING ERRCODE='22023'; END IF;
 IF (d-ARRAY['name','icon','kind','account_id','is_preferred','hidden'])<>'{}'::jsonb THEN RAISE EXCEPTION 'company_wallet_validation: fields' USING ERRCODE='22023'; END IF;
 FOR k,v IN SELECT * FROM jsonb_each(d) LOOP
  IF k IN ('is_preferred','hidden') THEN
   IF jsonb_typeof(v)<>'boolean' THEN RAISE EXCEPTION 'company_wallet_validation: boolean' USING ERRCODE='22023'; END IF;
  ELSE
   IF jsonb_typeof(v)<>'string' THEN RAISE EXCEPTION 'company_wallet_validation: text' USING ERRCODE='22023'; END IF;
   d:=jsonb_set(d,ARRAY[k],to_jsonb(btrim(v#>>'{}')));
  END IF;
 END LOOP;
 p_payload:=jsonb_set(p_payload,'{data}',d);
 PERFORM pg_advisory_xact_lock(hashtextextended(u::text||':'||p_organization_id::text,748));
 SELECT * INTO cached FROM public.company_wallet_requests WHERE user_id=u AND organization_id=p_organization_id AND request_key=p_request_key;
 IF cached.user_id IS NOT NULL THEN
  IF cached.payload<>p_payload THEN RAISE EXCEPTION 'company_wallet_conflict: request key' USING ERRCODE='23505'; END IF;
  RETURN cached.result;
 END IF;
 IF action='create' THEN
  IF p_payload ? 'id' OR p_payload ? 'expected_version' OR NOT(d ?& ARRAY['name','kind','account_id']) THEN RAISE EXCEPTION 'company_wallet_validation: create' USING ERRCODE='22023'; END IF;
 ELSE
  IF p_payload->>'id' IS NULL OR p_payload->>'expected_version' IS NULL OR (p_payload->>'expected_version')::integer<1 THEN RAISE EXCEPTION 'company_wallet_validation: expected version' USING ERRCODE='22023'; END IF;
  SELECT * INTO wallet FROM public.company_wallets WHERE id=(p_payload->>'id')::uuid AND user_id=u AND organization_id=p_organization_id FOR UPDATE;
  IF wallet.id IS NULL THEN RAISE EXCEPTION 'company_wallet_permission: wallet' USING ERRCODE='42501'; END IF;
  IF wallet.version<>(p_payload->>'expected_version')::integer THEN RAISE EXCEPTION 'company_wallet_conflict: version' USING ERRCODE='PT409'; END IF;
 END IF;
 IF action='delete' THEN
  IF d<>'{}'::jsonb THEN RAISE EXCEPTION 'company_wallet_validation: delete' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.company_wallet_voucher_origins WHERE wallet_id=wallet.id) THEN RAISE EXCEPTION 'company_wallet_conflict: hide wallet with history' USING ERRCODE='23514'; END IF;
  DELETE FROM public.company_wallets WHERE id=wallet.id;
  result:=jsonb_build_object('id',wallet.id,'user_id',u,'organization_id',p_organization_id,'version',wallet.version+1,'deleted',true);
 ELSE
  IF d='{}'::jsonb THEN RAISE EXCEPTION 'company_wallet_validation: empty update' USING ERRCODE='22023'; END IF;
  target:=coalesce(d->>'account_id',wallet.account_id::text)::uuid;
  -- Once entered, the historical source wallet cannot be rebound to another cashbook.
  IF wallet.id IS NOT NULL AND target<>wallet.account_id AND EXISTS(SELECT 1 FROM public.company_wallet_voucher_origins WHERE wallet_id=wallet.id) THEN RAISE EXCEPTION 'company_wallet_conflict: linked history' USING ERRCODE='23514'; END IF;
  -- Hiding a revoked wallet remains possible; using or rebinding it still requires custody.
  IF action='create' OR target IS DISTINCT FROM wallet.account_id OR NOT coalesce((d->>'hidden')::boolean,wallet.hidden,false) THEN
   IF NOT EXISTS(SELECT 1 FROM public.accounts a JOIN public.list_cashbooks_for_expense_v2() c ON c.id=a.id WHERE a.id=target AND a.organization_id=p_organization_id AND a.deleted_at IS NULL AND NOT a.is_virtual) THEN RAISE EXCEPTION 'company_wallet_permission: cashbook' USING ERRCODE='42501'; END IF;
  END IF;
  next_kind:=coalesce(d->>'kind',wallet.kind);
  IF coalesce((d->>'hidden')::boolean,wallet.hidden,false) THEN d:=d||'{"is_preferred":false}'::jsonb; END IF;
  IF coalesce((d->>'is_preferred')::boolean,wallet.is_preferred,false) THEN
   UPDATE public.company_wallets SET is_preferred=false,version=version+1 WHERE user_id=u AND organization_id=p_organization_id AND kind=next_kind AND is_preferred AND id IS DISTINCT FROM wallet.id;
  END IF;
  IF action='create' THEN
   INSERT INTO public.company_wallets(user_id,organization_id,account_id,name,icon,kind,is_preferred,hidden)
   VALUES(u,p_organization_id,target,d->>'name',coalesce(d->>'icon','🏢'),next_kind,coalesce((d->>'is_preferred')::boolean,false),coalesce((d->>'hidden')::boolean,false)) RETURNING * INTO wallet;
  ELSE
   UPDATE public.company_wallets SET account_id=target,name=coalesce(d->>'name',wallet.name),icon=coalesce(d->>'icon',wallet.icon),kind=next_kind,
    is_preferred=coalesce((d->>'is_preferred')::boolean,wallet.is_preferred),hidden=coalesce((d->>'hidden')::boolean,wallet.hidden),version=version+1 WHERE id=wallet.id RETURNING * INTO wallet;
  END IF;
  result:=to_jsonb(wallet);
 END IF;
 result:=jsonb_build_object('owner_id',u,'organization_id',p_organization_id,'request_key',p_request_key,'action',action,'wallet',result);
 INSERT INTO public.company_wallet_requests(user_id,organization_id,request_key,payload,result) VALUES(u,p_organization_id,p_request_key,p_payload,result);
 RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION public.create_company_wallet_voucher(p_organization_id uuid,p_wallet_id uuid,p_idempotency_key text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE u uuid:=auth.uid(); wallet public.company_wallets; cached public.company_wallet_voucher_origins; voucher public.income_expenses; payload jsonb;
BEGIN
 IF u IS NULL OR COALESCE(public.is_super_admin() AND p_organization_id=ANY(public.sandbox_org_ids()),false) OR NOT EXISTS(SELECT 1 FROM public.organization_memberships WHERE user_id=u AND organization_id=p_organization_id AND status='ACTIVE') THEN RAISE EXCEPTION 'company_wallet_permission: organization' USING ERRCODE='42501'; END IF;
 IF p_wallet_id IS NULL OR p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) NOT BETWEEN 1 AND 200 OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR
  (p_input-ARRAY['type','name','building_id','room_id','tenant_id','contract_id','payer_name','receive_bank_account','receive_bank_name','account_id','attachments','business_result_accounting','notes','voucher_date','items'])<>'{}'::jsonb THEN RAISE EXCEPTION 'company_wallet_validation: input' USING ERRCODE='22023'; END IF;
 payload:=jsonb_build_object('wallet_id',p_wallet_id,'input',p_input);
 PERFORM pg_advisory_xact_lock(hashtextextended(u::text||':'||p_organization_id::text,748));
 SELECT * INTO wallet FROM public.company_wallets WHERE id=p_wallet_id AND user_id=u AND organization_id=p_organization_id;
 IF wallet.id IS NULL THEN RAISE EXCEPTION 'company_wallet_permission: wallet' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.accounts a JOIN public.list_cashbooks_for_expense_v2() c ON c.id=a.id WHERE a.id=wallet.account_id AND a.organization_id=p_organization_id AND a.deleted_at IS NULL AND NOT a.is_virtual) THEN RAISE EXCEPTION 'company_wallet_permission: cashbook' USING ERRCODE='42501'; END IF;
 SELECT * INTO cached FROM public.company_wallet_voucher_origins WHERE user_id=u AND organization_id=p_organization_id AND idempotency_key=p_idempotency_key;
 IF cached.voucher_id IS NOT NULL THEN
  IF cached.payload<>payload THEN RAISE EXCEPTION 'company_wallet_conflict: request key' USING ERRCODE='23505'; END IF;
 END IF;
 IF wallet.hidden AND cached.voucher_id IS NULL THEN RAISE EXCEPTION 'company_wallet_permission: hidden wallet' USING ERRCODE='42501'; END IF;
 IF (p_input ? 'account_id' AND (p_input->>'account_id')::uuid IS DISTINCT FROM wallet.account_id) OR NOT EXISTS(SELECT 1 FROM public.buildings WHERE id=(p_input->>'building_id')::uuid AND organization_id=p_organization_id AND deleted_at IS NULL) THEN RAISE EXCEPTION 'company_wallet_permission: scope' USING ERRCODE='42501'; END IF;
 SELECT * INTO voucher FROM public.create_income_expense_v1(
  p_input->>'type',p_input->>'name',(p_input->>'building_id')::uuid,(p_input->>'room_id')::uuid,(p_input->>'tenant_id')::uuid,(p_input->>'contract_id')::uuid,
  p_input->>'payer_name',p_input->>'receive_bank_account',p_input->>'receive_bank_name',wallet.account_id,coalesce(p_input->'attachments','[]'::jsonb),
  (p_input->>'business_result_accounting')::boolean,p_input->>'notes',(p_input->>'voucher_date')::date,p_input->'items',
  'company-wallet:'||u::text||':'||p_organization_id::text||':'||md5(p_idempotency_key));
 IF voucher.id IS NULL OR voucher.organization_id IS DISTINCT FROM p_organization_id OR voucher.account_id IS DISTINCT FROM wallet.account_id OR coalesce(voucher.maker_user_id,voucher.user_id) IS DISTINCT FROM u THEN RAISE EXCEPTION 'company_wallet_conflict: invalid writer receipt' USING ERRCODE='23514'; END IF;
 IF cached.voucher_id IS NOT NULL THEN
  -- Canonical replay rechecks the current building/restricted-create authority as well as custody.
  IF voucher.id IS DISTINCT FROM cached.voucher_id THEN RAISE EXCEPTION 'company_wallet_conflict: replay receipt' USING ERRCODE='23514'; END IF;
  SELECT * INTO voucher FROM app_private.finance_v2_visible_vouchers() v WHERE v.id=cached.voucher_id AND v.organization_id=p_organization_id;
  IF voucher.id IS NULL THEN RAISE EXCEPTION 'company_wallet_permission: voucher' USING ERRCODE='42501'; END IF;
  RETURN to_jsonb(voucher)||jsonb_build_object('wallet_id',cached.wallet_id,'origin','personal_wallet');
 END IF;
 INSERT INTO public.company_wallet_voucher_origins(voucher_id,wallet_id,user_id,organization_id,idempotency_key,payload) VALUES(voucher.id,wallet.id,u,p_organization_id,p_idempotency_key,payload);
 RETURN to_jsonb(voucher)||jsonb_build_object('wallet_id',wallet.id,'origin','personal_wallet');
END $fn$;

REVOKE ALL ON FUNCTION public.company_wallet_snapshot(uuid),public.company_wallet_mutate(uuid,uuid,jsonb),public.create_company_wallet_voucher(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.company_wallet_snapshot(uuid),public.company_wallet_mutate(uuid,uuid,jsonb),public.create_company_wallet_voucher(uuid,uuid,text,jsonb) TO authenticated;
NOTIFY pgrst,'reload schema';
