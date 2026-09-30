-- Read-only funding arithmetic. Inputs are private canonical facts, never public evidence.
CREATE OR REPLACE FUNCTION app_private.rent_support_allocate_funding_v1(
 p_payer text,p_party uuid,p_policy text,p_total numeric,p_committed numeric,p_sources jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE s jsonb; rows jsonb:='[]'; issues jsonb:='[]'; gross numeric; paid numeric; held numeric;
 reserved numeric; remaining numeric; available numeric; due numeric; capacity numeric:=0;
 left_due numeric; take numeric; state text:='READY'; source_count integer;
BEGIN
 IF p_payer IS NULL OR p_payer NOT IN ('BUILDING','SALE') OR p_policy IS NULL OR p_policy NOT IN ('COMMISSION_ONLY','BONUS_THEN_COMMISSION')
 OR (p_payer='SALE' AND p_party IS NULL) OR p_total IS NULL OR p_committed IS NULL OR p_total<0 OR p_committed<0
 OR p_total::text IN ('NaN','Infinity','-Infinity') OR p_committed::text IN ('NaN','Infinity','-Infinity')
 OR jsonb_typeof(p_sources) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid funding facts' USING ERRCODE='22023';END IF;
 SELECT count(DISTINCT value->>'source_id') INTO source_count FROM jsonb_array_elements(p_sources);
 IF source_count<>jsonb_array_length(p_sources) THEN RAISE EXCEPTION 'Duplicate or absent source identity' USING ERRCODE='22023';END IF;
 due:=CASE WHEN p_payer='BUILDING' THEN 0 ELSE greatest(p_total-p_committed,0) END;
 IF p_committed>p_total THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','FUNDING_REVERSAL_REVIEW','message','Cần đối chiếu phần hỗ trợ đã giữ.'));END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p_sources) ORDER BY CASE WHEN p_policy='BONUS_THEN_COMMISSION' AND value->>'kind'='BONUS' THEN 0 ELSE 1 END,value->>'source_id' LOOP
  IF s->>'kind' IS NULL OR s->>'kind' NOT IN ('COMMISSION','BONUS') OR s->>'route' IS NULL OR s->>'route' NOT IN ('CASHBOOK','MANAGER_PAYROLL')
   OR EXISTS(SELECT 1 FROM unnest(ARRAY['gross_original','already_paid','prior_withheld','reserved']) k WHERE jsonb_typeof(s->k) IS DISTINCT FROM 'string' OR s->>k !~ '^[0-9]+(\.[0-9]+)?$')
   THEN RAISE EXCEPTION 'Invalid source facts' USING ERRCODE='22023';END IF;
  PERFORM (s->>'source_id')::uuid;PERFORM (s->>'party_id')::uuid;
  gross:=(s->>'gross_original')::numeric;paid:=(s->>'already_paid')::numeric;held:=(s->>'prior_withheld')::numeric;reserved:=(s->>'reserved')::numeric;
  remaining:=gross-paid-held;
  IF remaining<0 OR reserved>greatest(remaining,0) THEN RAISE EXCEPTION 'Source capacity is inconsistent' USING ERRCODE='22023';END IF;
  available:=greatest(remaining-reserved,0);
  IF COALESCE((s->>'issued')::boolean,false) THEN available:=0;END IF;
  IF (s->>'verified')::boolean IS DISTINCT FROM true THEN
   state:='LEGACY_REVIEW';available:=0;issues:=issues||jsonb_build_array(jsonb_build_object('code','LEGACY_REVIEW','message','Cần đối chiếu chứng cứ quyền lợi.'));
  END IF;
  IF p_payer='SALE' AND (s->>'party_id')::uuid IS DISTINCT FROM p_party THEN
   available:=0; -- An unrelated payout is never a funding source.
  END IF;
  IF COALESCE((s->>'locked')::boolean,true) THEN
   available:=0;issues:=issues||jsonb_build_array(jsonb_build_object('code','SOURCE_LOCKED','message','Nguồn đã vào kỳ khóa hoặc cần đối chiếu.'));
  END IF;
  IF reserved>0 THEN available:=0;issues:=issues||jsonb_build_array(jsonb_build_object('code','SOURCE_RESERVED','message','Nguồn đang được một thao tác khác giữ.'));END IF;
  IF p_payer='BUILDING' OR NOT (p_policy='BONUS_THEN_COMMISSION' OR s->>'kind'='COMMISSION') THEN available:=0;END IF;
  capacity:=capacity+available;
  rows:=rows||jsonb_build_array(jsonb_build_object('source_id',s->>'source_id','kind',s->>'kind','gross_original',trim_scale(gross)::text,
    'already_paid',trim_scale(paid)::text,'prior_withheld',trim_scale(held)::text,'remaining_payable',trim_scale(remaining)::text,
    'available_to_withhold',trim_scale(available)::text,'current_withheld','0','net_this_operation',trim_scale(remaining)::text,'route',s->>'route'));
 END LOOP;
 IF capacity<due THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','INSUFFICIENT_SOURCE','message','Nguồn được chọn chưa đủ hỗ trợ cam kết.'));END IF;
 IF jsonb_array_length(issues)>0 AND state<>'LEGACY_REVIEW' THEN state:='NEEDS_REVIEW';END IF;
 left_due:=due;
 IF state='READY' THEN
  p_sources:=rows;rows:='[]';
  FOR s IN SELECT value FROM jsonb_array_elements(p_sources) LOOP
   take:=CASE WHEN p_policy='BONUS_THEN_COMMISSION' OR s->>'kind'='COMMISSION' THEN least(left_due,(s->>'available_to_withhold')::numeric) ELSE 0 END;
   left_due:=left_due-take;
   rows:=rows||jsonb_build_array(s||jsonb_build_object('current_withheld',trim_scale(take)::text,'net_this_operation',trim_scale((s->>'remaining_payable')::numeric-take)::text));
  END LOOP;
 END IF;
 RETURN jsonb_build_object('due_upfront',trim_scale(due)::text,'sources',rows,'unallocated',trim_scale(greatest(due-capacity,0))::text,'state',state,'issues',issues);
END $$;
ALTER FUNCTION app_private.rent_support_allocate_funding_v1(text,uuid,text,numeric,numeric,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.rent_support_allocate_funding_v1(text,uuid,text,numeric,numeric,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Durable funding storage
CREATE TABLE IF NOT EXISTS app_private.rent_support_funding_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, contract_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES auth.users(id), operation text NOT NULL DEFAULT 'CREATE_PAYOUTS' CHECK(operation='CREATE_PAYOUTS'), request_id uuid NOT NULL,
 plan_id uuid NOT NULL, plan_revision bigint NOT NULL, quote_hash text NOT NULL, payload jsonb NOT NULL, payload_hash text NOT NULL,
 state text NOT NULL DEFAULT 'READY' CHECK(state IN ('READY','COMPLETED')), result jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 UNIQUE(organization_id,id), UNIQUE(organization_id,actor_id,operation,request_id),
 FOREIGN KEY(organization_id,contract_id,plan_id) REFERENCES app_private.contract_rent_support_plans(organization_id,contract_id,id),
 CHECK((state='COMPLETED' AND result IS NOT NULL AND completed_at IS NOT NULL) OR (state='READY' AND result IS NULL AND completed_at IS NULL))
);
CREATE TABLE IF NOT EXISTS app_private.rent_support_payout_request_links (
 organization_id uuid NOT NULL, operation_id uuid NOT NULL, contract_id uuid NOT NULL, kind text NOT NULL, request_id uuid NOT NULL,
 PRIMARY KEY(organization_id,contract_id,kind,request_id), UNIQUE(organization_id,operation_id,kind),
 FOREIGN KEY(organization_id,operation_id) REFERENCES app_private.rent_support_funding_operations(organization_id,id),
 FOREIGN KEY(organization_id,contract_id,kind,request_id) REFERENCES public.contract_commission_requests(organization_id,contract_id,kind,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS rent_support_voucher_org_id ON public.income_expenses(organization_id,id);
CREATE TABLE IF NOT EXISTS app_private.rent_support_payout_results (
 organization_id uuid NOT NULL, operation_id uuid NOT NULL, source_id uuid NOT NULL,
 gross numeric NOT NULL CHECK(gross>0 AND gross::text NOT IN ('NaN','Infinity','-Infinity')),
 withheld numeric NOT NULL CHECK(withheld>=0 AND withheld::text NOT IN ('NaN','Infinity','-Infinity')),
 net numeric NOT NULL CHECK(net>=0 AND net::text NOT IN ('NaN','Infinity','-Infinity')),
 voucher_id uuid, status text NOT NULL CHECK(status IN ('COMPLETED','SETTLED_BY_SUPPORT')),
 PRIMARY KEY(organization_id,operation_id,source_id),
 UNIQUE(organization_id,source_id),
 FOREIGN KEY(organization_id,operation_id) REFERENCES app_private.rent_support_funding_operations(organization_id,id),
 FOREIGN KEY(organization_id,source_id) REFERENCES app_private.rent_support_payout_sources(organization_id,id),
 FOREIGN KEY(organization_id,voucher_id) REFERENCES public.income_expenses(organization_id,id),
 CHECK(gross=withheld+net), CHECK((net=0 AND status='SETTLED_BY_SUPPORT' AND voucher_id IS NULL) OR (net>0 AND status='COMPLETED' AND voucher_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS app_private.rent_support_withholding_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,operation_id uuid NOT NULL,source_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('RESERVED','COMMITTED','RELEASED','REVERSED')),
 amount numeric NOT NULL CHECK(amount>0 AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
 actor_id uuid NOT NULL REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),reason text NOT NULL,
 UNIQUE(organization_id,operation_id,source_id,action),
 FOREIGN KEY(organization_id,operation_id,source_id) REFERENCES app_private.rent_support_payout_results(organization_id,operation_id,source_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS app_private.rent_support_payout_executions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,operation_id uuid NOT NULL,
 executor_id uuid NOT NULL REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 outcome text NOT NULL CHECK(outcome IN ('COMPLETED','FAILED','REPLAY')),reason text,
 FOREIGN KEY(organization_id,operation_id) REFERENCES app_private.rent_support_funding_operations(organization_id,id)
);
-- Only the money writer can open this exact transaction/backend/source capability.
CREATE TABLE IF NOT EXISTS app_private.rent_support_payout_authorizations (
 organization_id uuid NOT NULL,contract_id uuid NOT NULL,kind text NOT NULL,operation_id uuid NOT NULL,
 gross numeric NOT NULL,net numeric NOT NULL,xid xid8 NOT NULL,backend_pid integer NOT NULL,
 PRIMARY KEY(organization_id,contract_id,kind),
 FOREIGN KEY(organization_id,operation_id) REFERENCES app_private.rent_support_funding_operations(organization_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['rent_support_funding_operations','rent_support_payout_request_links','rent_support_payout_results','rent_support_withholding_events','rent_support_payout_executions','rent_support_payout_authorizations'] LOOP
  EXECUTE format('ALTER TABLE app_private.%I OWNER TO postgres',t);
  EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('DROP POLICY IF EXISTS %I ON app_private.%I',t||'_hide_sandbox_admin',t);
  EXECUTE format('CREATE POLICY %I ON app_private.%I AS RESTRICTIVE FOR ALL TO authenticated USING(NOT COALESCE(public.is_super_admin() AND organization_id=ANY(public.sandbox_org_ids()),false))',t||'_hide_sandbox_admin',t);
  IF t NOT IN ('rent_support_funding_operations','rent_support_payout_authorizations') THEN
   EXECUTE format('DROP TRIGGER IF EXISTS immutable_snapshot ON app_private.%I',t);
   EXECUTE format('CREATE TRIGGER immutable_snapshot BEFORE UPDATE OR DELETE ON app_private.%I FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_immutable_v1()',t);
  END IF;
  IF t<>'rent_support_payout_authorizations' THEN
   EXECUTE format('DROP TRIGGER IF EXISTS immutable_truncate ON app_private.%I',t);
   EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON app_private.%I FOR EACH STATEMENT EXECUTE FUNCTION app_private.rent_support_immutable_v1()',t);
  END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION app_private.rent_support_operation_immutable_v1() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.state='COMPLETED' OR (to_jsonb(NEW)-ARRAY['state','result','completed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','result','completed_at']) THEN RAISE EXCEPTION 'Funding operation is immutable' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_operation ON app_private.rent_support_funding_operations;
CREATE TRIGGER immutable_operation BEFORE UPDATE OR DELETE ON app_private.rent_support_funding_operations FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_operation_immutable_v1();
CREATE OR REPLACE FUNCTION app_private.rent_support_withholding_guard_v1() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s app_private.rent_support_payout_sources; h numeric; reserved numeric; r app_private.rent_support_payout_results; o app_private.rent_support_funding_operations; p app_private.contract_rent_support_plans;
BEGIN
 SELECT * INTO s FROM app_private.rent_support_payout_sources WHERE organization_id=NEW.organization_id AND id=NEW.source_id FOR UPDATE;
 SELECT * INTO r FROM app_private.rent_support_payout_results WHERE organization_id=NEW.organization_id AND operation_id=NEW.operation_id AND source_id=NEW.source_id;
 SELECT * INTO o FROM app_private.rent_support_funding_operations WHERE organization_id=NEW.organization_id AND id=NEW.operation_id;
 SELECT * INTO p FROM app_private.contract_rent_support_plans WHERE organization_id=o.organization_id AND id=o.plan_id;
 SELECT COALESCE(sum(CASE WHEN action='COMMITTED' THEN amount WHEN action='REVERSED' THEN -amount ELSE 0 END),0),greatest(COALESCE(sum(CASE WHEN action='RESERVED' THEN amount WHEN action IN ('COMMITTED','RELEASED') THEN -amount ELSE 0 END),0),0)
 INTO h,reserved FROM app_private.rent_support_withholding_events WHERE organization_id=NEW.organization_id AND source_id=NEW.source_id;
 IF s.id IS NULL OR r.source_id IS NULL OR o.state<>'COMPLETED' OR s.contract_id<>o.contract_id
 OR (r.withheld>0 AND (p.payer<>'SALE' OR s.party_id IS DISTINCT FROM p.sale_party_id OR (p.deduction_policy='COMMISSION_ONLY' AND s.kind<>'COMMISSION')))
 OR h<0 OR h+reserved>s.gross_original OR r.gross<>s.gross_original
 OR r.withheld IS DISTINCT FROM h OR r.gross<>r.net+r.withheld THEN RAISE EXCEPTION 'Invalid authoritative source withholding' USING ERRCODE='23514';END IF;
 IF r.net>0 AND NOT EXISTS(SELECT 1 FROM public.income_expenses v WHERE v.organization_id=r.organization_id AND v.id=r.voucher_id AND v.contract_id=s.contract_id AND v.total_amount=r.net AND v.commission_kind=CASE WHEN s.kind='COMMISSION' THEN 'broker' ELSE 'sale' END AND v.deleted_at IS NULL AND v.approval_status<>'CANCELLED') THEN RAISE EXCEPTION 'Voucher net does not match immutable payout result' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS withholding_commit_guard ON app_private.rent_support_withholding_events;
CREATE CONSTRAINT TRIGGER withholding_commit_guard AFTER INSERT ON app_private.rent_support_withholding_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_withholding_guard_v1();
DROP TRIGGER IF EXISTS payout_result_commit_guard ON app_private.rent_support_payout_results;
CREATE CONSTRAINT TRIGGER payout_result_commit_guard AFTER INSERT ON app_private.rent_support_payout_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_withholding_guard_v1();

-- Preserve preview v1; only strict v2 can prepare a money operation.
DO $$ BEGIN
 IF to_regprocedure('app_private.rent_support_payout_preview_context_v1(jsonb)') IS NULL THEN
  ALTER FUNCTION app_private.rent_support_payout_context_v1(jsonb) RENAME TO rent_support_payout_preview_context_v1;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION app_private.rent_support_payout_context_v1(p jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE i jsonb;k text;preview jsonb:='[]';BEGIN
 IF p IS NULL OR p->'version'='1'::jsonb THEN RETURN app_private.rent_support_payout_preview_context_v1(p);END IF;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->'version' IS DISTINCT FROM '2'::jsonb OR jsonb_typeof(p->'intents') IS DISTINCT FROM 'array'
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) keyval WHERE keyval NOT IN ('version','intents')) OR jsonb_array_length(p->'intents') NOT BETWEEN 1 AND 2 THEN RAISE EXCEPTION 'Invalid actionable payout context' USING ERRCODE='22023';END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(p->'intents') LOOP
  IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR NOT(i ?& ARRAY['intent_id','source_id','kind','party_id','gross_amount','route','manager_id','account_id','voucher_date','payer_name','recipient_name','recipient_bank','recipient_account','item_description','attachments'])
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(i) keyval WHERE keyval<>ALL(ARRAY['intent_id','source_id','kind','party_id','gross_amount','route','manager_id','account_id','voucher_date','payer_name','recipient_name','recipient_bank','recipient_account','item_description','attachments'])) THEN RAISE EXCEPTION 'Incomplete payout intent' USING ERRCODE='22023';END IF;
  FOREACH k IN ARRAY ARRAY['source_id','manager_id','account_id','payer_name','recipient_name','recipient_bank','recipient_account','item_description'] LOOP
   IF jsonb_typeof(i->k) NOT IN ('string','null') THEN RAISE EXCEPTION 'Invalid payout field' USING ERRCODE='22023';END IF;
  END LOOP;
  PERFORM (i->>'source_id')::uuid;
  IF jsonb_typeof(i->'attachments') IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(i->'attachments') x WHERE jsonb_typeof(x)<>'string') THEN RAISE EXCEPTION 'Invalid payout attachments' USING ERRCODE='22023';END IF;
  preview:=preview||jsonb_build_array(i-ARRAY['source_id','payer_name','recipient_name','recipient_bank','recipient_account','item_description','attachments']);
 END LOOP;
 PERFORM app_private.rent_support_payout_preview_context_v1(jsonb_build_object('version',1,'intents',preview));
 RETURN p;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'Invalid payout identity/date' USING ERRCODE='22023';
END $$;

CREATE OR REPLACE FUNCTION app_private.rent_support_source_funding_evidence_v1(p_org uuid,p_source uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r app_private.rent_support_payout_results;h numeric;reserved numeric;BEGIN
 SELECT x.* INTO r FROM app_private.rent_support_payout_results x JOIN app_private.rent_support_funding_operations o ON o.organization_id=x.organization_id AND o.id=x.operation_id AND o.state='COMPLETED'
 JOIN app_private.rent_support_payout_sources s ON s.organization_id=x.organization_id AND s.id=x.source_id AND s.evidence->>'operation_id'=o.id::text AND s.gross_original=x.gross
 WHERE x.organization_id=p_org AND x.source_id=p_source;
 IF r.source_id IS NULL THEN RETURN jsonb_build_object('verified',false);END IF;
 SELECT COALESCE(sum(CASE WHEN action='COMMITTED' THEN amount WHEN action='REVERSED' THEN -amount ELSE 0 END),0),
 COALESCE(sum(CASE WHEN action='RESERVED' THEN amount WHEN action IN ('RELEASED','COMMITTED') THEN -amount ELSE 0 END),0)
 INTO h,reserved FROM app_private.rent_support_withholding_events WHERE organization_id=p_org AND source_id=p_source;
 IF h<>r.withheld OR h<0 OR h>r.gross THEN RETURN jsonb_build_object('verified',false);END IF;
 RETURN jsonb_build_object('verified',true,'prior_withheld',trim_scale(h)::text,'reserved',trim_scale(greatest(reserved,0))::text,'settled_by_support',r.status='SETTLED_BY_SUPPORT','operation_id',r.operation_id,'facts_hash',md5(to_jsonb(r)::text));
END $$;
CREATE OR REPLACE FUNCTION app_private.rent_support_funding_evidence_v1(p_org uuid,p_contract uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('verified',NOT EXISTS(SELECT 1 FROM app_private.rent_support_payout_sources s WHERE s.organization_id=p_org AND s.contract_id=p_contract AND NOT COALESCE((app_private.rent_support_source_funding_evidence_v1(p_org,s.id)->>'verified')::boolean,false)),
 'has_funding',EXISTS(SELECT 1 FROM app_private.rent_support_funding_operations o JOIN app_private.rent_support_withholding_events e ON e.organization_id=o.organization_id AND e.operation_id=o.id WHERE o.organization_id=p_org AND o.contract_id=p_contract AND o.state='COMPLETED' AND e.action='COMMITTED'),
 'identities',COALESCE((SELECT jsonb_agg(jsonb_build_object('payer',x.payer,'sale_party_id',x.sale_party_id,'deduction_policy',x.deduction_policy,'net_committed_withholding',trim_scale(x.amount)::text)) FROM (
 SELECT p.payer,p.sale_party_id,p.deduction_policy,sum(CASE WHEN e.action='COMMITTED' THEN e.amount WHEN e.action='REVERSED' THEN -e.amount ELSE 0 END) amount
 FROM app_private.rent_support_funding_operations o JOIN app_private.contract_rent_support_plans p ON p.organization_id=o.organization_id AND p.id=o.plan_id
 JOIN app_private.rent_support_withholding_events e ON e.organization_id=o.organization_id AND e.operation_id=o.id
 WHERE o.organization_id=p_org AND o.contract_id=p_contract AND o.state='COMPLETED' GROUP BY p.payer,p.sale_party_id,p.deduction_policy) x),'[]'::jsonb))
$$;
-- Operation adapters share the commission receipt ledger, not a second queue.
CREATE OR REPLACE FUNCTION app_private.rent_support_payout_lock_v1(p_org uuid,p_contract uuid) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b uuid;s uuid;v uuid;BEGIN
 b:=app_private.authorize_commission_request_v1(p_org,p_contract);
 PERFORM 1 FROM public.contracts WHERE organization_id=p_org AND id=p_contract FOR UPDATE;
 -- Legacy callers retain canonical authority; v2 scope is rechecked after the
 -- contract lock so a concurrently installed plan cannot bypass strict scope.
 IF EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans WHERE organization_id=p_org AND contract_id=p_contract) THEN
  PERFORM app_private.rent_support_subject_v1(p_org,p_contract,NULL,true);
 END IF;
 PERFORM 1 FROM app_private.contract_rent_support_plans WHERE organization_id=p_org AND contract_id=p_contract ORDER BY revision FOR UPDATE;
 FOR s IN SELECT app_private.rent_support_source_id_v1(p_org,p_contract,k) FROM unnest(ARRAY['COMMISSION','BONUS']) k ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('rent-support-source:'||p_org::text||':'||s::text,0));
  PERFORM 1 FROM app_private.rent_support_payout_sources WHERE organization_id=p_org AND id=s FOR UPDATE;
 END LOOP;
 PERFORM pg_advisory_xact_lock(hashtext('commission:'||p_contract::text||':broker'));
 PERFORM pg_advisory_xact_lock(hashtext('commission:'||p_contract::text||':sale'));
 FOR v IN SELECT id FROM public.income_expenses WHERE organization_id=p_org AND (contract_id=p_contract OR id IN (
 SELECT c.bonus_voucher_id FROM app_private.sale_bonus_claims c JOIN public.income_expenses d ON d.id=c.deposit_voucher_id AND d.organization_id=c.organization_id WHERE c.organization_id=p_org AND d.contract_id=p_contract)) ORDER BY id LOOP
  PERFORM 1 FROM public.income_expenses WHERE id=v AND organization_id=p_org FOR UPDATE;
 END LOOP;
 RETURN b;
END $$;
CREATE OR REPLACE FUNCTION public.prepare_contract_payouts_with_support_v1(p_organization_id uuid,p_contract_id uuid,p_plan_revision bigint,p_quote_hash text,p_payload jsonb,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b uuid;p app_private.contract_rent_support_plans;o app_private.rent_support_funding_operations;h text;q jsonb;i jsonb;k text;ctx jsonb;
BEGIN
 b:=app_private.rent_support_payout_lock_v1(p_organization_id,p_contract_id);
 ctx:=app_private.rent_support_payout_context_v1(p_payload);
 IF ctx->'version' IS DISTINCT FROM '2'::jsonb OR p_request_id IS NULL OR p_plan_revision IS NULL OR p_quote_hash IS NULL THEN RAISE EXCEPTION 'A complete saved payout request is required' USING ERRCODE='22023';END IF;
 h:=md5(jsonb_build_object('contract',p_contract_id,'revision',p_plan_revision,'quote_hash',p_quote_hash,'payload',ctx)::text);
 SELECT * INTO o FROM app_private.rent_support_funding_operations WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND operation='CREATE_PAYOUTS' AND request_id=p_request_id;
 IF FOUND THEN IF o.payload_hash<>h THEN RAISE EXCEPTION 'Payout request payload changed' USING ERRCODE='PT409';END IF;RETURN jsonb_build_object('operation_id',o.id,'status',o.state);END IF;
 SELECT * INTO p FROM app_private.contract_rent_support_plans WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND state='ACTIVE' ORDER BY revision DESC LIMIT 1;
 IF p.id IS NULL OR p.revision<>p_plan_revision THEN RAISE EXCEPTION 'Support revision changed' USING ERRCODE='PT409';END IF;
 q:=public.quote_contract_rent_support_v1(p_organization_id,p_contract_id,NULL,p.payload,NULL,ctx);
 IF q->>'quote_hash' IS DISTINCT FROM p_quote_hash OR q->>'state'<>'READY' THEN RAISE EXCEPTION 'Support quote changed or requires review' USING ERRCODE='PT409';END IF;
 INSERT INTO app_private.rent_support_funding_operations(organization_id,contract_id,actor_id,request_id,plan_id,plan_revision,quote_hash,payload,payload_hash)
 VALUES(p_organization_id,p_contract_id,auth.uid(),p_request_id,p.id,p_plan_revision,p_quote_hash,ctx,h) RETURNING * INTO o;
 FOR i IN SELECT value FROM jsonb_array_elements(ctx->'intents') LOOP
  k:=CASE WHEN i->>'kind'='COMMISSION' THEN 'broker' ELSE 'sale' END;
  INSERT INTO public.contract_commission_requests(organization_id,contract_id,kind,request_id,payload,actor_id)
  VALUES(p_organization_id,p_contract_id,k,(i->>'intent_id')::uuid,jsonb_build_object('rent_support_operation_id',o.id,'intent',i),auth.uid());
  INSERT INTO app_private.rent_support_payout_request_links VALUES(p_organization_id,o.id,p_contract_id,k,(i->>'intent_id')::uuid);
  INSERT INTO public.contract_commission_events(organization_id,contract_id,building_id,kind,action,request_id,amount,actor_id,actor_name)
  VALUES(p_organization_id,p_contract_id,b,k,'ATTEMPTED',(i->>'intent_id')::uuid,(i->>'gross_amount')::numeric,auth.uid(),(SELECT full_name FROM public.profiles WHERE id=auth.uid()));
 END LOOP;
 RETURN jsonb_build_object('operation_id',o.id,'status',o.state);
END $$;
CREATE OR REPLACE FUNCTION public.read_contract_payout_operation_v1(p_organization_id uuid,p_operation_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o app_private.rent_support_funding_operations;BEGIN
 IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'No organization access' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM app_private.rent_support_funding_operations WHERE organization_id=p_organization_id AND id=p_operation_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','NOT_FOUND','operation_id',p_operation_id);END IF;
 PERFORM app_private.rent_support_subject_v1(p_organization_id,o.contract_id,NULL,true);
 IF EXISTS(SELECT 1 FROM app_private.rent_support_payout_results r WHERE r.organization_id=p_organization_id AND r.operation_id=o.id AND r.voucher_id IS NOT NULL AND NOT COALESCE(app_private.ie_supplement_can_read_v1(r.voucher_id),false)) THEN RAISE EXCEPTION 'No financial receipt access' USING ERRCODE='42501';END IF;
 IF o.result IS NOT NULL THEN RETURN o.result;END IF;
 IF EXISTS(SELECT 1 FROM app_private.rent_support_payout_executions e WHERE e.organization_id=p_organization_id AND e.operation_id=o.id AND e.outcome='FAILED') THEN
  RETURN jsonb_build_object('operation_id',o.id,'status','FAILED','sources','[]'::jsonb,'issue',jsonb_build_object('code','PAYOUT_FAILED','message','Chưa hoàn tất được bộ phiếu. Kiểm tra thông tin rồi dùng Tạo lại.'));
 END IF;
 RETURN jsonb_build_object('operation_id',o.id,'status','READY','sources','[]'::jsonb);
END $$;
CREATE OR REPLACE FUNCTION public.execute_contract_payout_operation_v1(p_organization_id uuid,p_operation_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o app_private.rent_support_funding_operations;p app_private.contract_rent_support_plans;b uuid;q jsonb;i jsonb;s jsonb;k text;v jsonb;sid uuid;
 rows jsonb:='[]';receipt jsonb;failure text;gross numeric;held numeric;net numeric;
BEGIN
 SELECT * INTO o FROM app_private.rent_support_funding_operations WHERE organization_id=p_organization_id AND id=p_operation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Saved payout operation not found' USING ERRCODE='PT409';END IF;
 b:=app_private.rent_support_payout_lock_v1(p_organization_id,o.contract_id);
 SELECT * INTO o FROM app_private.rent_support_funding_operations WHERE organization_id=p_organization_id AND id=p_operation_id FOR UPDATE;
 IF o.state='COMPLETED' THEN
  INSERT INTO app_private.rent_support_payout_executions(organization_id,operation_id,executor_id,outcome) VALUES(p_organization_id,o.id,auth.uid(),'REPLAY');
  RETURN public.read_contract_payout_operation_v1(p_organization_id,o.id);
 END IF;
 IF NOT app_private.rent_support_writers_enabled_v1() THEN RAISE EXCEPTION 'Support payout integration is not enabled' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM app_private.contract_rent_support_plans WHERE organization_id=p_organization_id AND id=o.plan_id;
 q:=public.quote_contract_rent_support_v1(p_organization_id,o.contract_id,NULL,p.payload,NULL,o.payload);
 IF q->>'quote_hash' IS DISTINCT FROM o.quote_hash OR q->>'state'<>'READY' OR (q->>'plan_revision')::bigint<>o.plan_revision THEN RAISE EXCEPTION 'Saved payout quote changed; review required' USING ERRCODE='PT409';END IF;
 -- A single subtransaction owns ALL financial side effects. Durable receipt
 -- intent/attempt exists before this block, including after an early failure.
 BEGIN
  FOR i IN SELECT value FROM jsonb_array_elements(o.payload->'intents') ORDER BY CASE WHEN value->>'kind'='BONUS' THEN 0 ELSE 1 END LOOP
   SELECT value INTO s FROM jsonb_array_elements(q->'sources') WHERE value->>'intent_id'=i->>'intent_id';
   IF s IS NULL OR s->>'origin'<>'PROPOSED' OR i->>'source_id' IS NOT NULL THEN RAISE EXCEPTION 'Existing payout liability requires adjustment' USING ERRCODE='PT409';END IF;
   sid:=(s->>'source_id')::uuid;gross:=(s->>'gross_original')::numeric;held:=(s->>'current_withheld')::numeric;net:=(s->>'net_this_operation')::numeric;
   IF gross<>(i->>'gross_amount')::numeric OR gross<>held+net OR held<0 OR net<0 OR (held>0 AND (p.payer<>'SALE' OR p.sale_party_id IS DISTINCT FROM (i->>'party_id')::uuid OR (p.deduction_policy='COMMISSION_ONLY' AND i->>'kind'<>'COMMISSION'))) THEN RAISE EXCEPTION 'Source allocation mismatch' USING ERRCODE='23514';END IF;
   k:=CASE WHEN i->>'kind'='COMMISSION' THEN 'broker' ELSE 'sale' END;
   INSERT INTO app_private.rent_support_payout_sources(id,organization_id,contract_id,party_id,kind,gross_original,evidence,created_by)
   VALUES(sid,p_organization_id,o.contract_id,(i->>'party_id')::uuid,i->>'kind',gross,jsonb_build_object('operation_id',o.id,'kind','CANONICAL_INTENT','intent_id',i->>'intent_id'),auth.uid());
   PERFORM app_private.rent_support_link_source_alias_v1(p_organization_id,sid,CASE WHEN k='broker' THEN 'CONTRACT_COMMISSION' ELSE 'CONTRACT_BONUS' END,o.contract_id,'');
   v:=NULL;
   IF net>0 THEN
    INSERT INTO app_private.rent_support_payout_authorizations VALUES(p_organization_id,o.contract_id,k,o.id,gross,net,pg_current_xact_id(),pg_backend_pid());
    v:=public.create_commission_voucher(o.contract_id,k,net,(i->>'voucher_date')::date,(i->>'account_id')::uuid,i->>'payer_name',i->>'recipient_name',i->>'recipient_bank',i->>'recipient_account',i->>'item_description',i->'attachments');
    DELETE FROM app_private.rent_support_payout_authorizations WHERE organization_id=p_organization_id AND contract_id=o.contract_id AND kind=k AND xid=pg_current_xact_id() AND backend_pid=pg_backend_pid();
    IF v->>'id' IS NULL THEN RAISE EXCEPTION 'Canonical payout returned no voucher';END IF;
    PERFORM app_private.rent_support_link_source_alias_v1(p_organization_id,sid,'VOUCHER',(v->>'id')::uuid,'');
   END IF;
   receipt:=jsonb_build_object('source_id',sid,'gross',trim_scale(gross)::text,'withheld',trim_scale(held)::text,'net',trim_scale(net)::text,
    'status',CASE WHEN net=0 THEN 'SETTLED_BY_SUPPORT' ELSE 'COMPLETED' END,'voucher_id',v->>'id','id',v->>'id','code',v->>'code','operation_id',o.id,'kind',k);
   INSERT INTO app_private.rent_support_payout_results VALUES(p_organization_id,o.id,sid,gross,held,net,(v->>'id')::uuid,receipt->>'status');
   IF held>0 THEN INSERT INTO app_private.rent_support_withholding_events(organization_id,operation_id,source_id,action,amount,actor_id,reason) VALUES(p_organization_id,o.id,sid,'COMMITTED',held,auth.uid(),'Upfront committed support');END IF;
   UPDATE public.contract_commission_requests SET completed_at=clock_timestamp(),result=receipt WHERE organization_id=p_organization_id AND contract_id=o.contract_id AND kind=k AND request_id=(i->>'intent_id')::uuid AND completed_at IS NULL;
   INSERT INTO public.contract_commission_events(organization_id,contract_id,building_id,kind,action,request_id,amount,actor_id,actor_name)
   VALUES(p_organization_id,o.contract_id,b,k,'COMPLETED',(i->>'intent_id')::uuid,gross,auth.uid(),(SELECT full_name FROM public.profiles WHERE id=auth.uid())) ON CONFLICT DO NOTHING;
   rows:=rows||jsonb_build_array(receipt);
  END LOOP;
  receipt:=jsonb_build_object('operation_id',o.id,'status','COMPLETED','sources',rows);
  UPDATE app_private.rent_support_funding_operations SET state='COMPLETED',result=receipt,completed_at=clock_timestamp() WHERE organization_id=p_organization_id AND id=o.id;
 EXCEPTION WHEN OTHERS THEN failure:=left(SQLERRM,1500); END;
 IF failure IS NOT NULL THEN
  FOR i IN SELECT value FROM jsonb_array_elements(o.payload->'intents') LOOP
   INSERT INTO public.contract_commission_events(organization_id,contract_id,building_id,kind,action,request_id,amount,reason,actor_id,actor_name)
   VALUES(p_organization_id,o.contract_id,b,CASE WHEN i->>'kind'='COMMISSION' THEN 'broker' ELSE 'sale' END,'FAILED',(i->>'intent_id')::uuid,(i->>'gross_amount')::numeric,'Không hoàn tất được bộ phiếu. Kiểm tra kết quả trước khi tạo lại.',auth.uid(),(SELECT full_name FROM public.profiles WHERE id=auth.uid())) ON CONFLICT DO NOTHING;
  END LOOP;
  INSERT INTO app_private.rent_support_payout_executions(organization_id,operation_id,executor_id,outcome,reason) VALUES(p_organization_id,o.id,auth.uid(),'FAILED',failure);
  RETURN jsonb_build_object('operation_id',o.id,'status','FAILED','sources','[]'::jsonb);
 END IF;
 INSERT INTO app_private.rent_support_payout_executions(organization_id,operation_id,executor_id,outcome) VALUES(p_organization_id,o.id,auth.uid(),'COMPLETED');
 RETURN public.read_contract_payout_operation_v1(p_organization_id,o.id);
END $$;
CREATE OR REPLACE FUNCTION public.create_contract_payouts_with_support_v1(p_organization_id uuid,p_contract_id uuid,p_plan_revision bigint,p_quote_hash text,p_payload jsonb,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o app_private.rent_support_funding_operations;h text;BEGIN
 PERFORM app_private.rent_support_payout_lock_v1(p_organization_id,p_contract_id);
 PERFORM app_private.rent_support_payout_context_v1(p_payload);
 h:=md5(jsonb_build_object('contract',p_contract_id,'revision',p_plan_revision,'quote_hash',p_quote_hash,'payload',p_payload)::text);
 SELECT * INTO o FROM app_private.rent_support_funding_operations WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND operation='CREATE_PAYOUTS' AND request_id=p_request_id;
 IF o.id IS NULL OR o.payload_hash IS DISTINCT FROM h THEN RAISE EXCEPTION 'Saved payout request missing or changed' USING ERRCODE='PT409';END IF;
 RETURN public.execute_contract_payout_operation_v1(p_organization_id,o.id);
END $$;

-- Source facts distinguish issued liability from available cash capacity.
CREATE OR REPLACE FUNCTION app_private.rent_support_source_quote_v1(p_org uuid,p_contract uuid,p_draft uuid,p_plan jsonb,p_due numeric,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b uuid;ctx jsonb;i jsonb;facts jsonb:='[]';issues jsonb:='[]';fingerprints jsonb:='[]';s record;v record;
 f jsonb;cash jsonb;allocated jsonb;party app_private.rent_support_parties%ROWTYPE;source_kind text;live_ids uuid[];sid uuid;
 signed boolean:=false;gross numeric;locked boolean;route text;profile uuid;
BEGIN
 b:=app_private.rent_support_subject_v1(p_org,p_contract,p_draft,true);ctx:=app_private.rent_support_payout_context_v1(p_context);
 IF p_contract IS NOT NULL THEN SELECT c.status::text<>'DRAFT' INTO signed FROM public.contracts c WHERE c.id=p_contract AND c.organization_id=p_org AND c.deleted_at IS NULL;END IF;
 IF NOT COALESCE(signed,false) THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','UNSIGNED_ENTITLEMENT','message','Quyền lợi cần hợp đồng đã ký.'));END IF;
 IF p_plan->>'payer'='SALE' AND NOT app_private.rent_support_party_valid_v1(p_org,(p_plan->>'sale_party_id')::uuid) THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','PARTY_UNVERIFIED','message','Cần xác minh người chịu hỗ trợ.'));END IF;
 FOR source_kind IN SELECT unnest(ARRAY['COMMISSION','BONUS']) LOOP
  i:=NULL;SELECT value INTO i FROM jsonb_array_elements(ctx->'intents') WHERE value->>'kind'=source_kind;
  SELECT COALESCE(array_agg(DISTINCT ie.id ORDER BY ie.id),'{}'::uuid[]) INTO live_ids FROM public.income_expenses ie
   WHERE ie.organization_id=p_org AND ie.type='EXPENSE' AND ie.commission_kind=(CASE WHEN source_kind='COMMISSION' THEN 'broker' ELSE 'sale' END)
    AND ie.deleted_at IS NULL AND ie.approval_status<>'CANCELLED' AND (ie.contract_id=p_contract OR (source_kind='BONUS' AND EXISTS(
     SELECT 1 FROM app_private.sale_bonus_claims c JOIN public.income_expenses d ON d.id=c.deposit_voucher_id AND d.organization_id=c.organization_id
      WHERE c.organization_id=p_org AND c.bonus_voucher_id=ie.id AND d.contract_id=p_contract)));
  SELECT * INTO s FROM app_private.rent_support_payout_sources r WHERE r.organization_id=p_org AND r.contract_id=p_contract AND r.kind=source_kind;
  fingerprints:=fingerprints||jsonb_build_array(jsonb_build_object('kind',source_kind,'live_ids',live_ids,'source_id',s.id));
  IF cardinality(live_ids)>0 OR s.id IS NOT NULL THEN
   IF cardinality(live_ids)>1 OR s.id IS NULL THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','LEGACY_REVIEW','message','Cần đối chiếu nguồn quyền lợi hiện có.'));CONTINUE;END IF;
   -- Both the domain scope and parent financial reader are mandatory before any facts.
   IF EXISTS(SELECT 1 FROM unnest(live_ids) id WHERE NOT app_private.ie_supplement_can_read_v1(id)) THEN
    issues:=issues||jsonb_build_array(jsonb_build_object('code','SOURCE_NOT_READABLE','message','Nguồn cần người có quyền xử lý.'));CONTINUE;
   END IF;
   f:=app_private.rent_support_source_funding_evidence_v1(p_org,s.id);
   IF COALESCE((f->>'verified')::boolean,false) IS NOT TRUE THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','FUNDING_PROVIDER_UNVERIFIED','message','Nguồn cần được đối chiếu phần đã giữ.'));CONTINUE;END IF;
   IF i IS NOT NULL THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','SOURCE_ALREADY_ISSUED','message','Quyền lợi đã có kết quả; cần đối chiếu thao tác hiện có.'));END IF;
   IF cardinality(live_ids)=0 AND COALESCE((f->>'settled_by_support')::boolean,false) THEN
    facts:=facts||jsonb_build_array(jsonb_build_object('source_id',s.id,'kind',source_kind,'party_id',s.party_id,'gross_original',trim_scale(s.gross_original)::text,'already_paid','0',
     'prior_withheld',f->>'prior_withheld','reserved','0','verified',true,'locked',false,'issued',true,'route','CASHBOOK','origin','EXISTING','intent_id',i->>'intent_id'));
    fingerprints:=fingerprints||jsonb_build_array(jsonb_build_object('source',to_jsonb(s),'funding',f));CONTINUE;
   END IF;
   -- A source's voucher set must be exact; a free-standing new intent cannot replace it.
   IF cardinality(live_ids)<>1 OR NOT EXISTS(SELECT 1 FROM app_private.rent_support_source_aliases a WHERE a.organization_id=p_org AND a.source_id=s.id AND a.alias_kind='VOUCHER' AND a.alias_id=live_ids[1]) THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','LEGACY_REVIEW','message','Cần đối chiếu liên kết nguồn.'));CONTINUE;END IF;
   SELECT * INTO v FROM public.income_expenses WHERE id=live_ids[1] AND organization_id=p_org;
   cash:=app_private.rent_support_voucher_cash_v1(p_org,v.id);
   IF (cash->>'verified')::boolean IS DISTINCT FROM true THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','LEGACY_REVIEW','message','Cần đối chiếu chứng cứ thanh toán.'));CONTINUE;END IF;
   SELECT profile_id INTO profile FROM app_private.rent_support_parties WHERE id=s.party_id AND organization_id=p_org;
   route:=CASE WHEN EXISTS(SELECT 1 FROM app_private.commission_manager_links l WHERE l.organization_id=p_org AND l.voucher_id=v.id) THEN 'MANAGER_PAYROLL' ELSE 'CASHBOOK' END;
   locked:=EXISTS(SELECT 1 FROM app_private.salary_commission_inclusions x WHERE x.organization_id=p_org AND x.voucher_id=v.id)
    OR EXISTS(SELECT 1 FROM public.salary_earning_consumptions x WHERE x.organization_id=p_org AND x.source_id=v.id AND x.consumption_state<>'RELEASED')
    OR EXISTS(SELECT 1 FROM app_private.commission_manager_links l WHERE l.organization_id=p_org AND l.voucher_id=v.id AND l.manager_id IS DISTINCT FROM profile)
    OR (v.account_id IS NOT NULL AND NOT app_private.finance_v2_is_cashbook_period_open(p_org,v.account_id,v.voucher_date));
   facts:=facts||jsonb_build_array(jsonb_build_object('source_id',s.id,'kind',source_kind,'party_id',s.party_id,'gross_original',trim_scale(s.gross_original)::text,'already_paid',cash->>'already_paid',
    'prior_withheld',f->>'prior_withheld','reserved',f->>'reserved','verified',true,'locked',locked,'issued',true,'route',route,'origin','EXISTING','intent_id',i->>'intent_id'));
   fingerprints:=fingerprints||jsonb_build_array(jsonb_build_object('source',to_jsonb(s),'funding',f,'cash',cash,'locked',locked,'voucher',to_jsonb(v)-ARRAY['notes','payer_name','receive_bank_name','receive_bank_account']));
  ELSIF i IS NOT NULL THEN
   IF i->>'source_id' IS NOT NULL THEN RAISE EXCEPTION 'Source identity changed' USING ERRCODE='PT409';END IF;
   IF i->>'route'='MANAGER_PAYROLL' THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','PAYROLL_BRIDGE_PENDING','message','Luồng lương cần được đối chiếu trước khi chi.'));END IF;
   IF source_kind='BONUS' AND app_private.sale_bonus_cap_for_v1(p_org,b,public.org_today_v1(p_org)) < (i->>'gross_amount')::numeric THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','BONUS_CAP_EXCEEDED','message','Thưởng vượt mức đã công bố.'));END IF;
   IF NOT app_private.rent_support_party_scope_v1(p_org,b,true) OR NOT(app_private.rent_support_scope_v1(p_org,b,'contracts.create') OR app_private.rent_support_scope_v1(p_org,b,'contracts.edit')) THEN RAISE EXCEPTION 'Không có quyền đề xuất nguồn chi.' USING ERRCODE='42501';END IF;
   SELECT * INTO party FROM app_private.rent_support_parties WHERE id=(i->>'party_id')::uuid AND organization_id=p_org AND (rent_support_parties.kind='INTERNAL' OR building_id=b);
   IF party.id IS NULL OR NOT app_private.rent_support_party_valid_v1(p_org,party.id) THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','PARTY_UNVERIFIED','message','Cần xác minh bên nhận.'));CONTINUE;END IF;
   IF i->>'route'='MANAGER_PAYROLL' AND (party.profile_id IS DISTINCT FROM (i->>'manager_id')::uuid OR NOT EXISTS(SELECT 1 FROM public.manager_salary_config m WHERE m.organization_id=p_org AND m.staff_id=party.profile_id AND m.is_active)) THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','PAYEE_MISMATCH','message','Bên nhận không khớp quản lý hưởng lương.'));CONTINUE;END IF;
   IF i->>'account_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=(i->>'account_id')::uuid AND a.organization_id=p_org AND a.deleted_at IS NULL AND (a.user_id=auth.uid() OR EXISTS(
    SELECT 1 FROM public.cashbook_possession_bindings cb JOIN public.organization_memberships m ON m.id=cb.membership_id AND m.organization_id=cb.organization_id
     WHERE cb.organization_id=p_org AND cb.cashbook_id=a.id AND m.user_id=auth.uid() AND m.status='ACTIVE' AND m.revoked_at IS NULL AND m.valid_from<=now() AND (m.valid_to IS NULL OR m.valid_to>now()) AND cb.valid_to IS NULL AND cb.possession_kind IN ('CUSTODIAN','OPERATOR')))) THEN RAISE EXCEPTION 'Không có quyền dùng sổ quỹ.' USING ERRCODE='42501';END IF;
   locked:=(i->>'account_id' IS NOT NULL AND NOT app_private.finance_v2_is_cashbook_period_open(p_org,(i->>'account_id')::uuid,(i->>'voucher_date')::date))
    OR (i->>'route'='MANAGER_PAYROLL' AND EXISTS(SELECT 1 FROM public.salary_monthly m WHERE m.organization_id=p_org AND m.staff_id=party.profile_id AND m.period_month=date_trunc('month',(i->>'voucher_date')::date)::date AND m.status='LOCKED'));
   sid:=app_private.rent_support_source_id_v1(p_org,COALESCE(p_contract,p_draft),source_kind);
   facts:=facts||jsonb_build_array(jsonb_build_object('source_id',sid,'kind',source_kind,'party_id',party.id,'gross_original',i->>'gross_amount','already_paid','0','prior_withheld','0','reserved','0','verified',true,'locked',locked,'route',i->>'route','origin','PROPOSED','intent_id',i->>'intent_id'));
   fingerprints:=fingerprints||jsonb_build_array(jsonb_build_object('party',party.id,'profile',party.profile_id,'intent',i,'locked',locked));
  END IF;
 END LOOP;
 allocated:=app_private.rent_support_allocate_funding_v1(p_plan->>'payer',(p_plan->>'sale_party_id')::uuid,p_plan->>'deduction_policy',p_due,0,facts);
 SELECT COALESCE(jsonb_agg(q.value||jsonb_build_object('origin',f.value->>'origin','intent_id',f.value->>'intent_id') ORDER BY q.ordinality),'[]'::jsonb) INTO facts
  FROM jsonb_array_elements(allocated->'sources') WITH ORDINALITY q(value,ordinality) JOIN jsonb_array_elements(facts) f(value) ON f.value->>'source_id'=q.value->>'source_id';
 issues:=issues||(allocated->'issues');
 RETURN allocated||jsonb_build_object('sources',facts,'issues',issues,'state',CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(issues) x WHERE x->>'code'='LEGACY_REVIEW') THEN 'LEGACY_REVIEW' WHEN jsonb_array_length(issues)>0 THEN 'NEEDS_REVIEW' ELSE allocated->>'state' END,'facts_hash',md5(jsonb_build_object('facts',fingerprints,'context',ctx)::text));
END $$;

-- Stable cursorless pagination also orders unregistered internal candidates.
CREATE OR REPLACE FUNCTION public.list_rent_support_parties_v1(p_organization_id uuid,p_building_id uuid,p_offset integer DEFAULT 0,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;BEGIN
 IF NOT app_private.rent_support_party_scope_v1(p_organization_id,p_building_id,false) THEN RAISE EXCEPTION 'Không có quyền xem bên nhận.' USING ERRCODE='42501';END IF;
 IF p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Trang không hợp lệ.' USING ERRCODE='22023';END IF;
 WITH eligible AS MATERIALIZED (
  SELECT p.id party_id,p.kind,p.profile_id,p.display_name FROM app_private.rent_support_parties p
   WHERE p.organization_id=p_organization_id AND (p.kind='INTERNAL' OR p.building_id=p_building_id) AND app_private.rent_support_party_valid_v1(p_organization_id,p.id)
  UNION ALL SELECT NULL::uuid,'INTERNAL',pr.id,pr.full_name FROM public.profiles pr
   WHERE pr.is_active IS DISTINCT FROM false AND length(btrim(pr.full_name))>0 AND EXISTS(SELECT 1 FROM public.organization_memberships m
    WHERE m.user_id=pr.id AND m.organization_id=p_organization_id AND m.status='ACTIVE' AND m.revoked_at IS NULL AND m.valid_from<=now() AND (m.valid_to IS NULL OR m.valid_to>now()))
   AND NOT EXISTS(SELECT 1 FROM app_private.rent_support_parties p WHERE p.organization_id=p_organization_id AND p.profile_id=pr.id)
 ), page AS (SELECT * FROM eligible ORDER BY display_name,party_id,profile_id LIMIT p_limit OFFSET p_offset)
 SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY display_name,party_id,profile_id) FROM page),'[]'::jsonb),'total',(SELECT count(*) FROM eligible)) INTO result;
 RETURN result;
END $$;

-- Preserve reviewed canonical bodies in private helpers; public adapters retain
-- their signatures. Forward succession evidence belongs to this migration.
DO $canonical$ DECLARE pair text[];f text;BEGIN
 FOREACH pair SLICE 1 IN ARRAY ARRAY[
  ARRAY['public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)','app_private.rent_support_legacy_commission_v1'],
  ARRAY['public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)','app_private.rent_support_legacy_deposit_bonus_v1'],
  ARRAY['public.prepare_commission_requests_v1(uuid,jsonb)','app_private.rent_support_legacy_prepare_commissions_v1'],
  ARRAY['public.execute_commission_request_v1(uuid,uuid,text,uuid)','app_private.rent_support_legacy_execute_commission_v1']
 ] LOOP
  IF to_regprocedure(pair[2]||substring(pair[1] FROM '\(.*$')) IS NULL THEN
   f:=pg_get_functiondef(pair[1]::regprocedure);
   f:=replace(f,split_part(pair[1],'(',1)||'(',pair[2]||'(');
   IF pair[2]='app_private.rent_support_legacy_commission_v1' THEN
    -- Autopay eligibility remains based on the accepted gross entitlement;
    -- the canonical voucher and posting receive only the positive net.
    IF (length(f)-length(replace(f,'app_private.commission_autopay_check_v1(p_contract_id, p_amount)','')))/length('app_private.commission_autopay_check_v1(p_contract_id, p_amount)')<>1 THEN RAISE EXCEPTION 'Canonical commission autopay definition drift';END IF;
    f:=replace(f,'app_private.commission_autopay_check_v1(p_contract_id, p_amount)',
      'app_private.commission_autopay_check_v1(p_contract_id, app_private.rent_support_autopay_gross_v1(p_contract_id,p_kind,p_amount))');
    -- The insert guard checks the actual header net before item recalculation.
    -- Canonical legacy header omitted total_amount; initialize it to the same
    -- amount its single item will compute, without changing legacy semantics.
    IF position('total_amount' IN split_part(split_part(f,'INSERT INTO public.income_expenses',2),'VALUES',1))=0 THEN
     IF position(E') VALUES (\n    v_uid,' IN f)=0 OR position('INSERT INTO public.income_expenses (' IN f)=0 THEN RAISE EXCEPTION 'Canonical commission insert definition drift';END IF;
     f:=replace(f,'INSERT INTO public.income_expenses (','INSERT INTO public.income_expenses (total_amount,');
     f:=replace(f,E') VALUES (\n    v_uid,',E') VALUES (\n    p_amount,\n    v_uid,');
    END IF;
   END IF;
   EXECUTE f;
  END IF;
  EXECUTE 'ALTER FUNCTION '||pair[2]||substring(pair[1] FROM '\(.*$')||' OWNER TO postgres';
  EXECUTE 'REVOKE ALL ON FUNCTION '||pair[2]||substring(pair[1] FROM '\(.*$')||' FROM PUBLIC,anon,authenticated,service_role';
 END LOOP;
END $canonical$;
CREATE OR REPLACE FUNCTION app_private.rent_support_autopay_gross_v1(p_contract uuid,p_kind text,p_net numeric) RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT a.gross FROM app_private.rent_support_payout_authorizations a WHERE a.contract_id=p_contract AND a.kind=p_kind AND a.net=p_net AND a.xid=pg_current_xact_id() AND a.backend_pid=pg_backend_pid()),p_net)
$$;
CREATE OR REPLACE FUNCTION public.create_commission_voucher(p_contract_id uuid,p_kind text,p_amount numeric,p_voucher_date date,p_account_id uuid DEFAULT NULL,p_payer_name text DEFAULT NULL,p_recipient_name text DEFAULT NULL,p_recipient_bank text DEFAULT NULL,p_recipient_account text DEFAULT NULL,p_item_description text DEFAULT NULL,p_attachments jsonb DEFAULT '[]')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid;BEGIN
 SELECT organization_id INTO org FROM public.contracts WHERE id=p_contract_id AND deleted_at IS NULL;
 -- All callers enter the same order before any legacy commission advisory lock.
 PERFORM app_private.rent_support_payout_lock_v1(org,p_contract_id);
 IF EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans WHERE organization_id=org AND contract_id=p_contract_id) THEN
  IF NOT EXISTS(SELECT 1 FROM app_private.rent_support_payout_authorizations a WHERE a.organization_id=org AND a.contract_id=p_contract_id AND a.kind=p_kind AND a.net=p_amount AND a.xid=pg_current_xact_id() AND a.backend_pid=pg_backend_pid()) THEN RAISE EXCEPTION 'Use the saved rent support payout operation' USING ERRCODE='PT409';END IF;
 END IF;
 RETURN app_private.rent_support_legacy_commission_v1(p_contract_id,p_kind,p_amount,p_voucher_date,p_account_id,p_payer_name,p_recipient_name,p_recipient_bank,p_recipient_account,p_item_description,p_attachments);
END $$;
CREATE OR REPLACE FUNCTION public.create_sale_bonus_from_deposit_v1(p_deposit_voucher_id uuid,p_amount numeric,p_recipient text DEFAULT NULL,p_account_number text DEFAULT NULL,p_bank text DEFAULT NULL,p_voucher_date date DEFAULT NULL,p_account_id uuid DEFAULT NULL,p_attachments jsonb DEFAULT '[]')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d public.income_expenses;org uuid;contract uuid;BEGIN
 SELECT * INTO d FROM public.income_expenses WHERE id=p_deposit_voucher_id;
 IF d.id IS NULL THEN RAISE EXCEPTION 'Deposit not found' USING ERRCODE='P0002';END IF;
 org:=d.organization_id;contract:=d.contract_id;
 PERFORM app_private.lock_org_for_decision_v1(org);
 IF contract IS NOT NULL THEN
  PERFORM 1 FROM public.contracts WHERE organization_id=org AND id=contract FOR UPDATE;
  IF EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans WHERE organization_id=org AND contract_id=contract) THEN
   PERFORM app_private.authorize_commission_request_v1(org,contract);
   RAISE EXCEPTION 'Use the saved rent support payout operation' USING ERRCODE='PT409';
  END IF;
 END IF;
 SELECT * INTO d FROM public.income_expenses WHERE id=p_deposit_voucher_id AND organization_id=org FOR UPDATE;
 IF d.contract_id IS DISTINCT FROM contract THEN RAISE EXCEPTION 'Deposit contract changed; retry after readback' USING ERRCODE='PT409';END IF;
 RETURN app_private.rent_support_legacy_deposit_bonus_v1(p_deposit_voucher_id,p_amount,p_recipient,p_account_number,p_bank,p_voucher_date,p_account_id,p_attachments);
END $$;
CREATE OR REPLACE FUNCTION public.prepare_commission_requests_v1(p_organization_id uuid,p_intents jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i jsonb;BEGIN
 IF jsonb_typeof(p_intents) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid payout intents' USING ERRCODE='22023';END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(p_intents) ORDER BY value->>'contract_id',value->>'kind' LOOP
  PERFORM app_private.rent_support_payout_lock_v1(p_organization_id,(i->>'contract_id')::uuid);
  IF EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans WHERE organization_id=p_organization_id AND contract_id=(i->>'contract_id')::uuid) THEN
   RAISE EXCEPTION 'Prepare the complete rent support payout bundle' USING ERRCODE='PT409';
  END IF;
 END LOOP;
 RETURN app_private.rent_support_legacy_prepare_commissions_v1(p_organization_id,p_intents);
END $$;
CREATE OR REPLACE FUNCTION public.execute_commission_request_v1(p_organization_id uuid,p_contract_id uuid,p_kind text,p_request_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE op uuid;r jsonb;BEGIN
 PERFORM app_private.rent_support_payout_lock_v1(p_organization_id,p_contract_id);
 SELECT operation_id INTO op FROM app_private.rent_support_payout_request_links WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND kind=p_kind AND request_id=p_request_id;
 IF op IS NOT NULL THEN
  r:=public.execute_contract_payout_operation_v1(p_organization_id,op);
  IF r->>'status'='FAILED' THEN RETURN jsonb_build_object('status','FAILED','id',NULL,'code',NULL,'operation_id',op);END IF;
  RETURN (SELECT value FROM jsonb_array_elements(r->'sources') WHERE value->>'kind'=p_kind);
 END IF;
 IF EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans WHERE organization_id=p_organization_id AND contract_id=p_contract_id) THEN
  PERFORM app_private.rent_support_payout_lock_v1(p_organization_id,p_contract_id);
  RAISE EXCEPTION 'Legacy request needs support payout review' USING ERRCODE='PT409';
 END IF;
 RETURN app_private.rent_support_legacy_execute_commission_v1(p_organization_id,p_contract_id,p_kind,p_request_id);
END $$;
CREATE OR REPLACE FUNCTION app_private.rent_support_commission_insert_guard_v1() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.commission_kind IS NOT NULL AND EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans p WHERE p.organization_id=NEW.organization_id AND p.contract_id=NEW.contract_id)
 AND NOT EXISTS(SELECT 1 FROM app_private.rent_support_payout_authorizations a
 JOIN app_private.rent_support_funding_operations o ON o.organization_id=a.organization_id AND o.id=a.operation_id AND o.contract_id=a.contract_id AND o.state='READY'
 JOIN app_private.rent_support_payout_sources s ON s.organization_id=a.organization_id AND s.contract_id=a.contract_id AND s.id=app_private.rent_support_source_id_v1(a.organization_id,a.contract_id,CASE WHEN a.kind='broker' THEN 'COMMISSION' ELSE 'BONUS' END)
  AND s.evidence->>'operation_id'=o.id::text AND s.gross_original=a.gross
 WHERE a.organization_id=NEW.organization_id AND a.contract_id=NEW.contract_id AND a.kind=NEW.commission_kind AND NEW.type='EXPENSE' AND NEW.total_amount=a.net AND a.net>0 AND a.xid=pg_current_xact_id() AND a.backend_pid=pg_backend_pid()) THEN
  RAISE EXCEPTION 'Use the atomic support payout operation' USING ERRCODE='PT409';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rent_support_commission_insert_guard ON public.income_expenses;
CREATE TRIGGER rent_support_commission_insert_guard BEFORE INSERT ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_commission_insert_guard_v1();
CREATE OR REPLACE FUNCTION public.read_contract_payout_request_v1(p_organization_id uuid,p_request_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE op uuid;BEGIN
 IF auth.uid() IS NULL OR NOT COALESCE(p_organization_id=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'No organization access' USING ERRCODE='42501';END IF;
 SELECT id INTO op FROM app_private.rent_support_funding_operations WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND operation='CREATE_PAYOUTS' AND request_id=p_request_id;
 IF op IS NULL THEN RETURN jsonb_build_object('status','NOT_FOUND','operation_id',NULL);END IF;
 RETURN public.read_contract_payout_operation_v1(p_organization_id,op);
END $$;
DO $acl$ DECLARE f regprocedure;BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE (n.nspname='app_private' AND p.proname IN ('rent_support_operation_immutable_v1','rent_support_withholding_guard_v1','rent_support_payout_context_v1','rent_support_payout_preview_context_v1','rent_support_source_funding_evidence_v1','rent_support_funding_evidence_v1','rent_support_payout_lock_v1','rent_support_source_quote_v1','rent_support_autopay_gross_v1','rent_support_commission_insert_guard_v1'))
 OR (n.nspname='public' AND p.proname IN ('prepare_contract_payouts_with_support_v1','create_contract_payouts_with_support_v1','read_contract_payout_operation_v1','read_contract_payout_request_v1','execute_contract_payout_operation_v1')) LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=f AND n.nspname='public') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f);END IF;
 END LOOP;
END $acl$;
NOTIFY pgrst,'reload schema';

CREATE OR REPLACE FUNCTION app_private.rent_support_commission_settled_v1(p_org uuid,p_contract uuid,p_kind text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM app_private.rent_support_payout_sources s JOIN app_private.rent_support_payout_results r ON r.organization_id=s.organization_id AND r.source_id=s.id
 JOIN app_private.rent_support_funding_operations o ON o.organization_id=r.organization_id AND o.id=r.operation_id AND o.state='COMPLETED'
 WHERE s.organization_id=p_org AND s.contract_id=p_contract AND s.kind=CASE WHEN p_kind='broker' THEN 'COMMISSION' WHEN p_kind='sale' THEN 'BONUS' END
 AND r.status='SETTLED_BY_SUPPORT' AND r.net=0 AND r.voucher_id IS NULL AND COALESCE((app_private.rent_support_source_funding_evidence_v1(p_org,s.id)->>'verified')::boolean,false))
$$;
ALTER FUNCTION app_private.rent_support_commission_settled_v1(uuid,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.rent_support_commission_settled_v1(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
DO $followup$ DECLARE f text;anchor text:='CASE WHEN v.id IS NOT NULL THEN ''VOUCHER_CREATED''';BEGIN
 f:=pg_get_functiondef('public.list_contract_commission_followups_v2(uuid,uuid[],uuid[],integer,integer,boolean,text,text,date,date)'::regprocedure);
 IF position('rent_support_commission_settled_v1' IN f)=0 THEN
  IF (length(f)-length(replace(f,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Commission followup state definition drift';END IF;
  EXECUTE replace(f,anchor,'CASE WHEN app_private.rent_support_commission_settled_v1(p_organization_id,e.contract_id,e.kind) THEN ''SETTLED_BY_SUPPORT'' WHEN v.id IS NOT NULL THEN ''VOUCHER_CREATED''');
 END IF;
 IF to_regprocedure('app_private.rent_support_legacy_sale_status_v1(uuid)') IS NULL THEN
  f:=pg_get_functiondef('public.sale_bonus_status_v1(uuid)'::regprocedure);
  EXECUTE replace(f,'public.sale_bonus_status_v1(','app_private.rent_support_legacy_sale_status_v1(');
 END IF;
END $followup$;
ALTER FUNCTION app_private.rent_support_legacy_sale_status_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.rent_support_legacy_sale_status_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.sale_bonus_status_v1(p_contract_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid;r jsonb;settled boolean:=false;BEGIN
 SELECT organization_id INTO org FROM public.contracts WHERE id=p_contract_id AND deleted_at IS NULL;
 IF EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans WHERE organization_id=org AND contract_id=p_contract_id) THEN
  PERFORM app_private.rent_support_subject_v1(org,p_contract_id,NULL,true);
  settled:=app_private.rent_support_commission_settled_v1(org,p_contract_id,'sale');
 END IF;
 r:=app_private.rent_support_legacy_sale_status_v1(p_contract_id)||jsonb_build_object('settledBySupport',settled);
 IF settled THEN r:=r||jsonb_build_object('status','SETTLED_BY_SUPPORT','note','Quyền lợi đã hoàn tất bằng khoản hỗ trợ tiền thuê.');END IF;
 RETURN r;
END $$;
NOTIFY pgrst,'reload schema';
