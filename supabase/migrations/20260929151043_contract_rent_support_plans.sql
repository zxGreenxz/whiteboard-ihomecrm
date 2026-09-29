-- Schedule storage only. Invoice/funding writers remain deliberately disabled.
CREATE TABLE IF NOT EXISTS app_private.contract_rent_support_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
 contract_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0), payload jsonb NOT NULL,
 committed_total numeric NOT NULL CHECK(committed_total>=0 AND committed_total::text NOT IN ('NaN','Infinity','-Infinity')),
 payer text NOT NULL CHECK(payer IN ('BUILDING','SALE')), sale_party_id uuid,
 deduction_policy text NOT NULL CHECK(deduction_policy IN ('COMMISSION_ONLY','BONUS_THEN_COMMISSION')),
 state text NOT NULL CHECK(state IN ('ACTIVE','NEEDS_REVIEW')), reason text,
 customer_hash text NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 supersedes_id uuid, UNIQUE(organization_id,contract_id,revision), UNIQUE(organization_id,contract_id,id),
 FOREIGN KEY(organization_id,contract_id) REFERENCES public.contracts(organization_id,id),
 FOREIGN KEY(organization_id,contract_id,supersedes_id) REFERENCES app_private.contract_rent_support_plans(organization_id,contract_id,id)
);
CREATE TABLE IF NOT EXISTS app_private.contract_rent_support_months (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, contract_id uuid NOT NULL,
 plan_id uuid NOT NULL, billing_month text NOT NULL CHECK(billing_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 agreed_amount numeric NOT NULL CHECK(agreed_amount>=0 AND agreed_amount::text NOT IN ('NaN','Infinity','-Infinity')),
 UNIQUE(plan_id,billing_month), UNIQUE(organization_id,contract_id,id),
 FOREIGN KEY(organization_id,contract_id,plan_id) REFERENCES app_private.contract_rent_support_plans(organization_id,contract_id,id)
);
CREATE TABLE IF NOT EXISTS app_private.rent_support_revision_requests (
 organization_id uuid NOT NULL, actor_id uuid NOT NULL, operation text NOT NULL CHECK(operation='REVISE'),
 request_id uuid NOT NULL, contract_id uuid NOT NULL, payload_hash text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(organization_id,actor_id,operation,request_id),
 FOREIGN KEY(organization_id,contract_id) REFERENCES public.contracts(organization_id,id)
);
CREATE OR REPLACE FUNCTION app_private.rent_support_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'Rent support snapshots are immutable' USING ERRCODE='42501'; END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['contract_rent_support_plans','contract_rent_support_months','rent_support_revision_requests'] LOOP
 EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC,anon,authenticated,service_role',t);
 EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('DROP POLICY IF EXISTS %I ON app_private.%I',t||'_hide_sandbox_admin',t);
 EXECUTE format('CREATE POLICY %I ON app_private.%I AS RESTRICTIVE FOR ALL TO authenticated USING (NOT (public.is_super_admin() AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)))',t||'_hide_sandbox_admin',t);
 EXECUTE format('DROP TRIGGER IF EXISTS immutable_snapshot ON app_private.%I',t);
 EXECUTE format('CREATE TRIGGER immutable_snapshot BEFORE UPDATE OR DELETE ON app_private.%I FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_immutable_v1()',t);
 EXECUTE format('DROP TRIGGER IF EXISTS immutable_truncate ON app_private.%I',t);
 EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON app_private.%I FOR EACH STATEMENT EXECUTE FUNCTION app_private.rent_support_immutable_v1()',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION app_private.rent_support_scope_v1(p_org uuid,p_building uuid,p_permission text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT auth.uid() IS NOT NULL AND COALESCE(p_org=ANY(public.my_org_ids()),false)
 AND COALESCE(public.can_access_building(p_building),false)
 AND NOT COALESCE(public.is_super_admin() AND p_org=ANY(public.sandbox_org_ids()),false)
 AND EXISTS(SELECT 1 FROM app_private.authorized_scope_v3(p_permission,p_org) s WHERE s.org_wide OR p_building=ANY(s.building_ids));
$$;
CREATE OR REPLACE FUNCTION app_private.rent_support_subject_v1(p_org uuid,p_contract uuid,p_draft uuid,p_financial boolean)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b uuid; BEGIN
 IF (p_contract IS NULL)=(p_draft IS NULL) THEN RAISE EXCEPTION 'Exactly one subject is required' USING ERRCODE='22023'; END IF;
 IF p_contract IS NOT NULL THEN
 SELECT r.building_id INTO b FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id AND r.deleted_at IS NULL
 WHERE c.id=p_contract AND c.organization_id=p_org AND c.deleted_at IS NULL;
 ELSE SELECT d.building_id INTO b FROM public.contract_drafts d WHERE d.id=p_draft AND d.organization_id=p_org; END IF;
 IF b IS NULL OR NOT app_private.rent_support_scope_v1(p_org,b,'contracts.view')
 OR (p_financial AND NOT app_private.rent_support_scope_v1(p_org,b,'income_expenses.view')) THEN
 RAISE EXCEPTION 'Rent support subject is outside authorized scope' USING ERRCODE='42501'; END IF;
 RETURN b;
END $$;
-- Customer identity excludes internal funding configuration.
CREATE OR REPLACE FUNCTION app_private.rent_support_customer_v1(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN p IS NULL THEN NULL ELSE jsonb_build_object('version',2,'start_billing_month',p->'start_billing_month','segments',p->'segments') END;
$$;
CREATE OR REPLACE FUNCTION app_private.validate_rent_support_v1(p jsonb,p_start date DEFAULT NULL,p_end date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE s jsonb; m date; n integer:=0; months jsonb:='[]'; segments jsonb:='[]'; amount numeric; count_months integer;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT(p ?& ARRAY['version','start_billing_month','payer','sale_party_id','deduction_policy','collection_mode','segments'])
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('version','start_billing_month','payer','sale_party_id','deduction_policy','collection_mode','segments'))
 OR p->'version' IS DISTINCT FROM '2'::jsonb OR jsonb_typeof(p->'start_billing_month') IS DISTINCT FROM 'string'
 OR p->>'start_billing_month' !~ '^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$'
 OR COALESCE(p->>'payer','') NOT IN ('BUILDING','SALE') OR COALESCE(p->>'deduction_policy','') NOT IN ('COMMISSION_ONLY','BONUS_THEN_COMMISSION')
 OR p->>'collection_mode' IS DISTINCT FROM 'UPFRONT_COMMITTED'
 OR jsonb_typeof(p->'sale_party_id') NOT IN ('string','null')
 OR (p->>'sale_party_id' IS NOT NULL AND p->>'sale_party_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
 OR (p->>'payer'='SALE' AND p->>'sale_party_id' IS NULL)
 OR jsonb_typeof(p->'segments') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid rent support payload' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(p->'segments')=0 OR octet_length(p::text)>262144 THEN RAISE EXCEPTION 'Invalid schedule size' USING ERRCODE='22023';END IF;
 m:=(p->>'start_billing_month'||'-01')::date;
 FOR s IN SELECT value FROM jsonb_array_elements(p->'segments') LOOP
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR NOT(s ?& ARRAY['month_count','monthly_amount'])
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(s) k WHERE k NOT IN ('month_count','monthly_amount'))
 OR jsonb_typeof(s->'month_count') IS DISTINCT FROM 'number' OR s->>'month_count' !~ '^[0-9]+$'
 OR jsonb_typeof(s->'monthly_amount') IS DISTINCT FROM 'string' OR s->>'monthly_amount' !~ '^[0-9]+(\.[0-9]+)?$'
 THEN RAISE EXCEPTION 'Invalid schedule segment' USING ERRCODE='22023'; END IF;
 IF (s->>'month_count')::numeric NOT BETWEEN 1 AND 119988 THEN RAISE EXCEPTION 'Invalid month count' USING ERRCODE='22023';END IF;
 count_months:=(s->>'month_count')::integer;amount:=(s->>'monthly_amount')::numeric;
 segments:=segments||jsonb_build_array(jsonb_build_object('month_count',count_months,'monthly_amount',trim_scale(amount)::text));
 FOR i IN 1..count_months LOOP
 IF m>DATE '9999-12-01' OR (p_start IS NOT NULL AND m<date_trunc('month',p_start)::date) OR (p_end IS NOT NULL AND m>date_trunc('month',p_end)::date) THEN
 RAISE EXCEPTION 'OUTSIDE_CONTRACT_TERM' USING ERRCODE='22023'; END IF;
 months:=months||jsonb_build_array(jsonb_build_object('billing_month',to_char(m,'YYYY-MM'),'agreed_amount',trim_scale(amount)::text,'invoice_period_label',to_char(m,'MM/YYYY'),'eligibility','PLANNED'));
 m:=(m+INTERVAL '1 month')::date;n:=n+1;
 END LOOP;END LOOP;
 RETURN jsonb_build_object('payload',p||jsonb_build_object('segments',segments,'sale_party_id',lower(p->>'sale_party_id')),'months',months,
 'committed_total',(SELECT trim_scale(sum((x->>'agreed_amount')::numeric))::text FROM jsonb_array_elements(months) x));
END $$;
-- Narrow integration boundary for tasks 4/5: replace with authoritative source/event reads.
-- No caller-supplied evidence; absence of provider is never READY.
CREATE OR REPLACE FUNCTION app_private.rent_support_funding_evidence_v1(p_org uuid,p_contract uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('verified',false,'has_funding',false,'identities','[]'::jsonb);
$$;
CREATE OR REPLACE FUNCTION app_private.rent_support_writers_enabled_v1() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION app_private.persist_contract_rent_support_v1(p_org uuid,p_contract uuid,p_payload jsonb)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v jsonb; id uuid; c public.contracts%ROWTYPE; BEGIN
 SELECT * INTO c FROM public.contracts WHERE organization_id=p_org AND public.contracts.id=p_contract FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Contract scope mismatch' USING ERRCODE='42501';END IF;
 v:=app_private.validate_rent_support_v1(p_payload,c.start_date,c.end_date);
 IF EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans p WHERE p.organization_id=p_org AND p.contract_id=p_contract) THEN RAISE EXCEPTION 'Plan already exists' USING ERRCODE='PT409';END IF;
 INSERT INTO app_private.contract_rent_support_plans(organization_id,contract_id,revision,payload,committed_total,payer,sale_party_id,deduction_policy,state,customer_hash,created_by)
 VALUES(p_org,p_contract,1,v->'payload',(v->>'committed_total')::numeric,p_payload->>'payer',(p_payload->>'sale_party_id')::uuid,p_payload->>'deduction_policy','ACTIVE',md5(app_private.rent_support_customer_v1(v->'payload')::text),auth.uid()) RETURNING contract_rent_support_plans.id INTO id;
 INSERT INTO app_private.contract_rent_support_months(organization_id,contract_id,plan_id,billing_month,agreed_amount)
 SELECT p_org,p_contract,id,m->>'billing_month',(m->>'agreed_amount')::numeric FROM jsonb_array_elements(v->'months') m;
 RETURN id;
END $$;
CREATE OR REPLACE FUNCTION public.quote_contract_rent_support_v1(p_organization_id uuid,p_contract_id uuid,p_draft_id uuid,p_payload jsonb,p_invoice_context jsonb,p_payout_context jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b uuid; v jsonb; e jsonb; previous app_private.contract_rent_support_plans%ROWTYPE; total numeric; paid numeric:=0; due numeric; issues jsonb:='[]'; rev bigint:=0; latest_revision bigint:=0;
BEGIN
 b:=app_private.rent_support_subject_v1(p_organization_id,p_contract_id,p_draft_id,true);
 IF p_invoice_context IS NOT NULL OR p_payout_context IS NOT NULL THEN RAISE EXCEPTION 'Canonical context adapters are not enabled' USING ERRCODE='22023';END IF;
 IF p_contract_id IS NOT NULL THEN
 v:=(SELECT app_private.validate_rent_support_v1(p_payload,c.start_date,c.end_date) FROM public.contracts c WHERE c.organization_id=p_organization_id AND c.id=p_contract_id);
 SELECT * INTO previous FROM app_private.contract_rent_support_plans p WHERE p.organization_id=p_organization_id AND p.contract_id=p_contract_id AND p.state='ACTIVE' ORDER BY revision DESC LIMIT 1;rev:=COALESCE(previous.revision,0);
 SELECT COALESCE(max(revision),0) INTO latest_revision FROM app_private.contract_rent_support_plans WHERE organization_id=p_organization_id AND contract_id=p_contract_id;
 ELSE
 v:=(SELECT app_private.validate_rent_support_v1(p_payload,NULLIF(d.payload->'form'->>'start_date','')::date,NULLIF(d.payload->'form'->>'end_date','')::date) FROM public.contract_drafts d WHERE d.id=p_draft_id AND d.organization_id=p_organization_id);SELECT revision INTO rev FROM public.contract_drafts WHERE id=p_draft_id AND organization_id=p_organization_id;
 END IF;
 IF latest_revision>rev THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','AMENDMENT_REVIEW','message','A proposed revision requires reconciliation'));END IF;
 total:=(v->>'committed_total')::numeric;e:=app_private.rent_support_funding_evidence_v1(p_organization_id,p_contract_id);
 SELECT COALESCE(sum((x->>'net_committed_withholding')::numeric),0) INTO paid FROM jsonb_array_elements(e->'identities') x
 WHERE x->>'payer'=p_payload->>'payer' AND x->>'sale_party_id' IS NOT DISTINCT FROM lower(p_payload->>'sale_party_id') AND x->>'deduction_policy'=p_payload->>'deduction_policy';
 IF paid<0 OR paid::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invalid authoritative funding evidence' USING ERRCODE='22023';END IF;
 IF COALESCE((e->>'has_funding')::boolean,false) AND (previous.payer IS DISTINCT FROM p_payload->>'payer' OR previous.sale_party_id IS DISTINCT FROM (p_payload->>'sale_party_id')::uuid OR previous.deduction_policy IS DISTINCT FROM p_payload->>'deduction_policy' OR total<previous.committed_total OR paid>total) THEN
 issues:=issues||jsonb_build_array(jsonb_build_object('code','FUNDING_REVERSAL_REVIEW','message','Funding identity or committed amount requires reconciliation'));
 END IF;
 due:=CASE WHEN p_payload->>'payer'='BUILDING' THEN 0 ELSE greatest(total-paid,0) END;
 issues:=issues||jsonb_build_array(jsonb_build_object('code','WRITERS_DISABLED','message','Invoice and funding integration is not enabled'));
 RETURN v||jsonb_build_object('quote_hash',md5(jsonb_build_object('org',p_organization_id,'contract',p_contract_id,'draft',p_draft_id,'revision',rev,'latest_revision',latest_revision,'payload',v->'payload','evidence',e)::text),
 'payload_hash',md5((v->'payload')::text),'plan_revision',rev,'due_upfront',trim_scale(due)::text,'sources','[]'::jsonb,'unallocated',trim_scale(due)::text,'state','NEEDS_REVIEW','issues',issues);
END $$;
CREATE OR REPLACE FUNCTION public.revise_contract_rent_support_v1(p_organization_id uuid,p_contract_id uuid,p_expected_revision bigint,p_payload jsonb,p_reason text,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b uuid; allowed boolean; old app_private.contract_rent_support_plans%ROWTYPE; replay app_private.rent_support_revision_requests%ROWTYPE;
 v jsonb; e jsonb; h text; state text:='ACTIVE'; new_id uuid; rev bigint; result jsonb;
BEGIN
 b:=app_private.rent_support_subject_v1(p_organization_id,p_contract_id,NULL,true);
 PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
 SELECT a.allowed INTO allowed FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'contracts.edit',b,NULL) a;
 IF NOT COALESCE(allowed,false) OR NOT app_private.rent_support_scope_v1(p_organization_id,b,'income_expenses.create') THEN RAISE EXCEPTION 'No permission to revise support' USING ERRCODE='42501';END IF;
 IF p_request_id IS NULL OR p_expected_revision IS NULL OR p_reason IS NULL OR length(btrim(p_reason))=0 OR length(p_reason)>2000 THEN RAISE EXCEPTION 'Revision, reason and request required' USING ERRCODE='22023';END IF;
 PERFORM 1 FROM public.contracts WHERE organization_id=p_organization_id AND id=p_contract_id FOR UPDATE;
 h:=md5(jsonb_build_object('contract',p_contract_id,'revision',p_expected_revision,'payload',p_payload,'reason',p_reason)::text);
 SELECT * INTO replay FROM app_private.rent_support_revision_requests WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND operation='REVISE' AND request_id=p_request_id;
 IF FOUND THEN IF replay.payload_hash<>h THEN RAISE EXCEPTION 'Request payload changed' USING ERRCODE='PT409';END IF;RETURN replay.result;END IF;
 SELECT * INTO old FROM app_private.contract_rent_support_plans WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND contract_rent_support_plans.state='ACTIVE' ORDER BY revision DESC LIMIT 1;
 IF old.id IS NULL OR old.revision<>p_expected_revision THEN RAISE EXCEPTION 'Plan revision changed' USING ERRCODE='PT409';END IF;
 v:=(SELECT app_private.validate_rent_support_v1(p_payload,c.start_date,c.end_date) FROM public.contracts c WHERE c.id=p_contract_id AND c.organization_id=p_organization_id);
 e:=app_private.rent_support_funding_evidence_v1(p_organization_id,p_contract_id);
 IF md5(app_private.rent_support_customer_v1(v->'payload')::text)<>old.customer_hash
 OR COALESCE((e->>'has_funding')::boolean,false)
 OR NOT COALESCE((e->>'verified')::boolean,false) AND app_private.rent_support_writers_enabled_v1() THEN state:='NEEDS_REVIEW';END IF;
 SELECT max(revision)+1 INTO rev FROM app_private.contract_rent_support_plans WHERE organization_id=p_organization_id AND contract_id=p_contract_id;
 INSERT INTO app_private.contract_rent_support_plans(organization_id,contract_id,revision,payload,committed_total,payer,sale_party_id,deduction_policy,state,reason,customer_hash,created_by,supersedes_id)
 VALUES(p_organization_id,p_contract_id,rev,v->'payload',(v->>'committed_total')::numeric,p_payload->>'payer',(p_payload->>'sale_party_id')::uuid,p_payload->>'deduction_policy',state,p_reason,md5(app_private.rent_support_customer_v1(v->'payload')::text),auth.uid(),old.id) RETURNING id INTO new_id;
 INSERT INTO app_private.contract_rent_support_months(organization_id,contract_id,plan_id,billing_month,agreed_amount)
 SELECT p_organization_id,p_contract_id,new_id,m->>'billing_month',(m->>'agreed_amount')::numeric FROM jsonb_array_elements(v->'months') m;
 result:=jsonb_build_object('id',new_id,'revision',rev,'active_revision',CASE WHEN state='ACTIVE' THEN rev ELSE old.revision END,'state',state,'customer_hash',md5(app_private.rent_support_customer_v1(v->'payload')::text));
 INSERT INTO app_private.rent_support_revision_requests VALUES(p_organization_id,auth.uid(),'REVISE',p_request_id,p_contract_id,h,result);
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.read_contract_rent_support_v1(p_organization_id uuid,p_contract_ids uuid[],p_building_ids uuid[],p_offset integer DEFAULT 0,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cid uuid; b uuid; result jsonb; BEGIN
 IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Organization scope denied' USING ERRCODE='42501';END IF;
 IF p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid pagination' USING ERRCODE='22023';END IF;
 FOREACH cid IN ARRAY COALESCE(p_contract_ids,'{}'::uuid[]) LOOP PERFORM app_private.rent_support_subject_v1(p_organization_id,cid,NULL,false);END LOOP;
 FOREACH b IN ARRAY COALESCE(p_building_ids,'{}'::uuid[]) LOOP IF NOT app_private.rent_support_scope_v1(p_organization_id,b,'contracts.view') THEN RAISE EXCEPTION 'Building scope denied' USING ERRCODE='42501';END IF;END LOOP;
 WITH subjects AS MATERIALIZED (
 SELECT c.id,c.discounts,r.building_id FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id AND r.deleted_at IS NULL
 WHERE c.organization_id=p_organization_id AND c.deleted_at IS NULL AND (p_contract_ids IS NULL OR c.id=ANY(p_contract_ids)) AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids)) AND app_private.rent_support_scope_v1(p_organization_id,r.building_id,'contracts.view')
 ), page AS (SELECT * FROM subjects ORDER BY id OFFSET p_offset LIMIT p_limit)
 SELECT jsonb_build_object('total',(SELECT count(*) FROM subjects),'rows',COALESCE(jsonb_agg(
 jsonb_build_object('contract_id',s.id,'kind',CASE WHEN p.id IS NULL THEN 'LEGACY' ELSE 'V2' END,'revision',p.revision,'customer_hash',p.customer_hash,
 'schedule',app_private.rent_support_customer_v1(p.payload),'legacy',CASE WHEN p.id IS NULL THEN s.discounts ELSE NULL END,
 'months',COALESCE((SELECT jsonb_agg(jsonb_build_object('billing_month',m.billing_month,'agreed_amount',trim_scale(m.agreed_amount)::text) ORDER BY m.billing_month) FROM app_private.contract_rent_support_months m WHERE m.organization_id=p_organization_id AND m.plan_id=p.id),'[]'::jsonb))
 || CASE WHEN app_private.rent_support_scope_v1(p_organization_id,s.building_id,'income_expenses.view') THEN jsonb_build_object('financial',CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('payload',p.payload,'committed_total',trim_scale(p.committed_total)::text,'reason',p.reason,'review',(SELECT jsonb_build_object('revision',proposal.revision,'reason',proposal.reason,'payload',proposal.payload) FROM app_private.contract_rent_support_plans proposal WHERE proposal.organization_id=p_organization_id AND proposal.contract_id=s.id AND proposal.revision>p.revision AND proposal.state='NEEDS_REVIEW' ORDER BY proposal.revision DESC LIMIT 1)) END) ELSE '{}'::jsonb END ORDER BY s.id),'[]'::jsonb)) INTO result
 FROM page s LEFT JOIN LATERAL (SELECT * FROM app_private.contract_rent_support_plans p WHERE p.organization_id=p_organization_id AND p.contract_id=s.id AND p.state='ACTIVE' ORDER BY p.revision DESC LIMIT 1) p ON true;
 RETURN result;
END $$;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT p.oid::regprocedure signature,n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE
 (n.nspname='app_private' AND (p.proname LIKE '%rent_support%')) OR (n.nspname='public' AND p.proname IN ('quote_contract_rent_support_v1','revise_contract_rent_support_v1','read_contract_rent_support_v1')) LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.signature);
 IF r.nspname='public' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',r.signature);END IF;
 END LOOP;
END $$;
