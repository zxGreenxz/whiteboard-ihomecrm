-- Task 3: the rollout switch intentionally remains false in the preceding migration.
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS invoice_support_amount numeric NOT NULL DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS manual_discount_amount numeric;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS credit_discount_amount numeric;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS rent_support_plan_revision bigint;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS rent_support_request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_support_org_contract_id ON public.invoices(organization_id,contract_id,id);
-- A transaction-scoped capability is issued only by authenticated canonical
-- adapters, never by recompute triggers. Explicit close handles RPC return;
-- deferred cleanup is a backstop against any row surviving COMMIT.
CREATE TABLE IF NOT EXISTS app_private.invoice_rent_support_item_capabilities (
 transaction_id bigint NOT NULL,actor_id uuid NOT NULL,organization_id uuid NOT NULL,invoice_id uuid NOT NULL,
 PRIMARY KEY(transaction_id,actor_id,organization_id,invoice_id),
 FOREIGN KEY(organization_id,invoice_id) REFERENCES public.invoices(organization_id,id)
);
CREATE TABLE IF NOT EXISTS app_private.rent_support_invoice_claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, contract_id uuid NOT NULL,
 billing_month text NOT NULL, support_month_id uuid NOT NULL, invoice_id uuid NOT NULL,
 invoice_revision bigint NOT NULL, claimed_amount numeric NOT NULL CHECK(claimed_amount>0 AND claimed_amount::text NOT IN ('NaN','Infinity','-Infinity')),
 version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), released_at timestamptz,
 UNIQUE(organization_id,contract_id,id),
 FOREIGN KEY(organization_id,contract_id,support_month_id) REFERENCES app_private.contract_rent_support_months(organization_id,contract_id,id),
 FOREIGN KEY(organization_id,contract_id,invoice_id) REFERENCES public.invoices(organization_id,contract_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS rent_support_invoice_live_month ON app_private.rent_support_invoice_claims(organization_id,contract_id,billing_month) WHERE released_at IS NULL;
CREATE TABLE IF NOT EXISTS app_private.rent_support_invoice_update_requests (
 organization_id uuid NOT NULL,actor_id uuid NOT NULL,request_id uuid NOT NULL,invoice_id uuid NOT NULL,
 payload_hash text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(organization_id,actor_id,request_id),
 FOREIGN KEY(organization_id,invoice_id) REFERENCES public.invoices(organization_id,id)
);
CREATE TABLE IF NOT EXISTS app_private.rent_support_invoice_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, contract_id uuid NOT NULL,
 claim_id uuid NOT NULL, invoice_id uuid NOT NULL, actor_id uuid NOT NULL, request_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('CLAIMED','APPLIED','RELEASED','REVERSED')), payload_hash text NOT NULL,
 before_snapshot jsonb, after_snapshot jsonb NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,actor_id,request_id,action),
 FOREIGN KEY(organization_id,contract_id,claim_id) REFERENCES app_private.rent_support_invoice_claims(organization_id,contract_id,id),
 FOREIGN KEY(organization_id,contract_id,invoice_id) REFERENCES public.invoices(organization_id,contract_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['rent_support_invoice_claims','rent_support_invoice_events','rent_support_invoice_update_requests','invoice_rent_support_item_capabilities'] LOOP
 EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC,anon,authenticated,service_role',t);
 EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('DROP POLICY IF EXISTS %I ON app_private.%I',t||'_hide_sandbox_admin',t);
 EXECUTE format('CREATE POLICY %I ON app_private.%I AS RESTRICTIVE FOR ALL TO authenticated USING (NOT (public.is_super_admin() AND COALESCE(organization_id=ANY(public.sandbox_org_ids()),false)))',t||'_hide_sandbox_admin',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION app_private.invoice_rent_support_items_open_v1(p_invoice uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Item writer requires actor' USING ERRCODE='42501';END IF;
 INSERT INTO app_private.invoice_rent_support_item_capabilities(transaction_id,actor_id,organization_id,invoice_id)
 SELECT txid_current(),auth.uid(),organization_id,id FROM public.invoices WHERE id=p_invoice AND rent_support_plan_revision IS NOT NULL
 ON CONFLICT DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION app_private.invoice_rent_support_items_close_v1(p_invoice uuid) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 DELETE FROM app_private.invoice_rent_support_item_capabilities WHERE transaction_id=txid_current() AND actor_id=auth.uid() AND invoice_id=p_invoice
$$;
CREATE OR REPLACE FUNCTION app_private.invoice_rent_support_items_expire_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 DELETE FROM app_private.invoice_rent_support_item_capabilities WHERE transaction_id=NEW.transaction_id AND actor_id=NEW.actor_id AND organization_id=NEW.organization_id AND invoice_id=NEW.invoice_id;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS expire_item_capability ON app_private.invoice_rent_support_item_capabilities;
CREATE CONSTRAINT TRIGGER expire_item_capability AFTER INSERT ON app_private.invoice_rent_support_item_capabilities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.invoice_rent_support_items_expire_v1();
CREATE OR REPLACE FUNCTION app_private.invoice_rent_support_items_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE parents uuid[]:='{}'; inv record; BEGIN
 IF TG_OP IN ('UPDATE','DELETE') THEN parents:=array_append(parents,OLD.invoice_id);END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN parents:=array_append(parents,NEW.invoice_id);END IF;
 FOR inv IN SELECT i.* FROM public.invoices i WHERE i.id=ANY(parents) LOOP
 IF inv.rent_support_plan_revision IS NOT NULL OR EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans WHERE organization_id=inv.organization_id AND contract_id=inv.contract_id)
 OR EXISTS(SELECT 1 FROM public.contracts WHERE id=inv.contract_id AND organization_id=inv.organization_id AND discounts->>'version'='2') THEN
 IF NOT EXISTS(SELECT 1 FROM app_private.invoice_rent_support_item_capabilities WHERE transaction_id=txid_current() AND actor_id=auth.uid() AND organization_id=inv.organization_id AND invoice_id=inv.id) THEN
 RAISE EXCEPTION 'V2 invoice items require canonical writer capability' USING ERRCODE='42501';END IF;
 END IF;END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rent_support_items_guard ON public.invoice_items;
CREATE TRIGGER rent_support_items_guard BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION app_private.invoice_rent_support_items_guard_v1();
DROP TRIGGER IF EXISTS immutable_snapshot ON app_private.rent_support_invoice_events;
CREATE TRIGGER immutable_snapshot BEFORE UPDATE OR DELETE ON app_private.rent_support_invoice_events FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_immutable_v1();
DROP TRIGGER IF EXISTS immutable_truncate ON app_private.rent_support_invoice_events;
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON app_private.rent_support_invoice_events FOR EACH STATEMENT EXECUTE FUNCTION app_private.rent_support_immutable_v1();

CREATE OR REPLACE FUNCTION app_private.invoice_rent_support_context_v1(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR NOT(p ?& ARRAY['version','expected_plan_revision','manual_discount_amount','request_id'])
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('version','expected_plan_revision','manual_discount_amount','request_id'))
 OR p->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p->'expected_plan_revision') IS DISTINCT FROM 'number'
 OR p->>'expected_plan_revision' !~ '^[1-9][0-9]*$' OR (p->>'expected_plan_revision')::numeric>9007199254740991
 OR jsonb_typeof(p->'manual_discount_amount') IS DISTINCT FROM 'string' OR p->>'manual_discount_amount' !~ '^[0-9]+(\.[0-9]{1,2})?$'
 OR jsonb_typeof(p->'request_id') IS DISTINCT FROM 'string' OR p->>'request_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 THEN RAISE EXCEPTION 'Explicit rent support context required' USING ERRCODE='22023'; END IF;
 RETURN p;
END $$;

-- Pure read over canonical request items. No invoice count, payment_cycle, or caller revenue cap.
CREATE OR REPLACE FUNCTION app_private.invoice_rent_support_quote_v1(p_org uuid,p_contract uuid,p_month text,p_kind text,p_items jsonb,p_manual numeric,p_credit numeric,p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b uuid; p app_private.contract_rent_support_plans%ROWTYPE; amount numeric:=0; revenue numeric; BEGIN
 b:=app_private.rent_support_subject_v1(p_org,p_contract,NULL,false);
 IF NOT (app_private.rent_support_scope_v1(p_org,b,'invoices.create') OR app_private.rent_support_scope_v1(p_org,b,'invoices.edit')) THEN
 RAISE EXCEPTION 'Invoice support permission denied' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM app_private.contract_rent_support_plans WHERE organization_id=p_org AND contract_id=p_contract AND state='ACTIVE' ORDER BY revision DESC LIMIT 1;
 IF p.id IS NULL THEN
 IF p_revision IS NOT NULL THEN RAISE EXCEPTION 'Support plan no longer exists' USING ERRCODE='PT409';END IF;
 RETURN jsonb_build_object('invoice_support','0','agreed_amount','0','plan_revision',NULL,'state','READY');END IF;
 IF p_revision IS DISTINCT FROM p.revision THEN RAISE EXCEPTION 'Support plan revision changed' USING ERRCODE='PT409';END IF;
 IF EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans WHERE organization_id=p_org AND contract_id=p_contract AND revision>p.revision) THEN
 RAISE EXCEPTION 'AMENDMENT_REVIEW' USING ERRCODE='PT409';END IF;
 IF p_month IS NULL OR p_month !~ '^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$' OR p_manual IS NULL OR p_credit IS NULL
 OR p_manual<0 OR p_credit<0 OR p_manual::text IN ('NaN','Infinity','-Infinity') OR p_credit::text IN ('NaN','Infinity','-Infinity')
 OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid canonical invoice context' USING ERRCODE='22023';END IF;
 IF COALESCE(p_kind,'MONTHLY')='MONTHLY' THEN
 SELECT COALESCE(m.agreed_amount,0) INTO amount FROM app_private.contract_rent_support_months m WHERE m.plan_id=p.id AND m.billing_month=p_month;
 amount:=COALESCE(amount,0);END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
 OR COALESCE(x->>'accounting_class','REVENUE') NOT IN ('REVENUE','DEPOSIT','NON_PNL')
 OR COALESCE((x->>'amount')::numeric,COALESCE((x->>'unit_price')::numeric,0)*COALESCE((x->>'quantity')::numeric,1)*COALESCE((x->>'coefficient')::numeric,1))::text IN ('NaN','Infinity','-Infinity')) THEN
 RAISE EXCEPTION 'Invalid invoice revenue items' USING ERRCODE='22023';END IF;
 SELECT COALESCE(sum(COALESCE((x->>'amount')::numeric,COALESCE((x->>'unit_price')::numeric,0)*COALESCE((x->>'quantity')::numeric,1)*COALESCE((x->>'coefficient')::numeric,1))) FILTER(WHERE COALESCE(x->>'accounting_class','REVENUE')='REVENUE'),0)
 INTO revenue FROM jsonb_array_elements(p_items) x;
 IF amount>greatest(revenue-p_manual-p_credit,0) THEN
 RETURN jsonb_build_object('invoice_support','0','agreed_amount',trim_scale(amount)::text,'plan_revision',p.revision,'state','NEEDS_REVIEW','issue','REVENUE_CAP_REVIEW');END IF;
 RETURN jsonb_build_object('invoice_support',trim_scale(amount)::text,'agreed_amount',trim_scale(amount)::text,'plan_revision',p.revision,'state','READY');
END $$;

CREATE OR REPLACE FUNCTION app_private.resolve_invoice_rent_support_v1(p_org uuid,p_contract uuid,p_invoice uuid,p_billing_month text,p_eligible_periods jsonb,p_expected_plan_revision bigint,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE inv public.invoices%ROWTYPE; c app_private.rent_support_invoice_claims%ROWTYPE; e app_private.rent_support_invoice_events%ROWTYPE;
 q jsonb; items jsonb; h text; mid uuid; result jsonb; BEGIN
 IF auth.uid() IS NULL OR p_request_id IS NULL THEN RAISE EXCEPTION 'Claim actor and request required' USING ERRCODE='42501';END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_org);
 PERFORM 1 FROM public.contracts WHERE organization_id=p_org AND id=p_contract FOR UPDATE;
 SELECT * INTO inv FROM public.invoices WHERE organization_id=p_org AND contract_id=p_contract AND id=p_invoice FOR UPDATE;
 IF NOT FOUND OR inv.billing_month IS DISTINCT FROM p_billing_month OR inv.deleted_at IS NOT NULL OR inv.status::text='CANCELLED' THEN
 RAISE EXCEPTION 'Claim invoice scope or period mismatch' USING ERRCODE='42501';END IF;
 -- This canonical writer supports exactly its one recorded billing month. Arbitrary subperiods are not evidence.
 IF p_eligible_periods IS DISTINCT FROM jsonb_build_array(jsonb_build_object('billing_month',p_billing_month)) THEN
 RAISE EXCEPTION 'Unverified invoice subperiods' USING ERRCODE='22023';END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('amount',i.amount,'accounting_class',i.accounting_class) ORDER BY i.id),'[]') INTO items FROM public.invoice_items i WHERE i.organization_id=p_org AND i.invoice_id=p_invoice;
 q:=app_private.invoice_rent_support_quote_v1(p_org,p_contract,p_billing_month,inv.kind,items,inv.manual_discount_amount,inv.credit_discount_amount,p_expected_plan_revision);
 IF q->>'state'<>'READY' THEN RAISE EXCEPTION 'REVENUE_CAP_REVIEW' USING ERRCODE='PT409',DETAIL=q::text;END IF;
 IF inv.rent_support_plan_revision IS DISTINCT FROM p_expected_plan_revision OR inv.invoice_support_amount IS DISTINCT FROM (q->>'invoice_support')::numeric
 OR inv.discount_amount IS DISTINCT FROM inv.invoice_support_amount+inv.manual_discount_amount+inv.credit_discount_amount THEN
 RAISE EXCEPTION 'Invoice support components changed' USING ERRCODE='PT409';END IF;
 IF NOT app_private.rent_support_writers_enabled_v1() THEN RAISE EXCEPTION 'RENT_SUPPORT_WRITERS_DISABLED' USING ERRCODE='55000';END IF;
 result:=q||jsonb_build_object('invoice_id',p_invoice,'billing_month',p_billing_month);
 IF (q->>'invoice_support')::numeric=0 THEN RETURN result;END IF;
 h:=md5(jsonb_build_object('org',p_org,'contract',p_contract,'invoice',p_invoice,'month',p_billing_month,'revision',p_expected_plan_revision,'invoice_revision',inv.adjustment_revision,'items',items,'discount',inv.discount_amount,'manual',inv.manual_discount_amount,'credit',inv.credit_discount_amount)::text);
 SELECT * INTO e FROM app_private.rent_support_invoice_events WHERE organization_id=p_org AND actor_id=auth.uid() AND request_id=p_request_id AND action='CLAIMED';
 IF FOUND THEN
   IF e.payload_hash<>h THEN RAISE EXCEPTION 'Claim request changed' USING ERRCODE='PT409';END IF;
   -- Historical CLAIMED events are not live reservations. In particular, a draft
   -- update releases before resolving: reusing its create key must roll back.
   SELECT * INTO c FROM app_private.rent_support_invoice_claims
   WHERE id=e.claim_id AND organization_id=p_org AND contract_id=p_contract
     AND invoice_id=p_invoice AND billing_month=p_billing_month AND released_at IS NULL
     AND invoice_revision=inv.adjustment_revision AND claimed_amount=(q->>'invoice_support')::numeric
   FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Claim request no longer has its live claim' USING ERRCODE='PT409';END IF;
   RETURN e.after_snapshot;
 END IF;
 SELECT * INTO c FROM app_private.rent_support_invoice_claims WHERE organization_id=p_org AND contract_id=p_contract AND billing_month=p_billing_month AND released_at IS NULL FOR UPDATE;
 IF FOUND THEN RAISE EXCEPTION 'Support month already claimed' USING ERRCODE='PT409';END IF;
 SELECT m.id INTO mid FROM app_private.contract_rent_support_months m JOIN app_private.contract_rent_support_plans p ON p.id=m.plan_id
 WHERE m.organization_id=p_org AND m.contract_id=p_contract AND m.billing_month=p_billing_month AND p.revision=p_expected_plan_revision;
 BEGIN
 INSERT INTO app_private.rent_support_invoice_claims(organization_id,contract_id,billing_month,support_month_id,invoice_id,invoice_revision,claimed_amount)
 VALUES(p_org,p_contract,p_billing_month,mid,p_invoice,inv.adjustment_revision,(q->>'invoice_support')::numeric) RETURNING * INTO c;
 EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'Support month already claimed' USING ERRCODE='PT409';END;
 INSERT INTO app_private.rent_support_invoice_events(organization_id,contract_id,claim_id,invoice_id,actor_id,request_id,action,payload_hash,after_snapshot,reason)
 VALUES(p_org,p_contract,c.id,p_invoice,auth.uid(),p_request_id,'CLAIMED',h,result,'Canonical invoice support');
 RETURN result;
END $$;

DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app_private' AND (p.proname LIKE 'invoice_rent_support_%' OR p.proname='resolve_invoice_rent_support_v1') LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.signature);
 END LOOP;
END $$;

-- CANONICAL WRITER ADAPTERS
CREATE OR REPLACE FUNCTION app_private.invoice_rent_support_lock_v1(p_invoice uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE r record; BEGIN
 SELECT organization_id,contract_id INTO r FROM public.invoices WHERE id=p_invoice;
 IF r.contract_id IS NOT NULL THEN
 PERFORM app_private.lock_org_for_decision_v1(r.organization_id);
 PERFORM 1 FROM public.contracts WHERE organization_id=r.organization_id AND id=r.contract_id FOR UPDATE;END IF;
END $$;
CREATE OR REPLACE FUNCTION app_private.invoice_rent_support_release_v1(p_invoice uuid,p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE c app_private.rent_support_invoice_claims%ROWTYPE; rid uuid; BEGIN
 PERFORM app_private.invoice_rent_support_lock_v1(p_invoice);
 FOR c IN SELECT * FROM app_private.rent_support_invoice_claims WHERE invoice_id=p_invoice AND released_at IS NULL FOR UPDATE LOOP
 rid:=md5('support.release|'||c.id::text||'|'||c.version::text)::uuid;
 INSERT INTO app_private.rent_support_invoice_events(organization_id,contract_id,claim_id,invoice_id,actor_id,request_id,action,payload_hash,before_snapshot,after_snapshot,reason)
 VALUES(c.organization_id,c.contract_id,c.id,p_invoice,auth.uid(),rid,'RELEASED',md5(to_jsonb(c)::text),to_jsonb(c),jsonb_build_object('released',true),p_reason);
 UPDATE app_private.rent_support_invoice_claims SET released_at=clock_timestamp(),version=version+1 WHERE id=c.id;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION app_private.invoice_rent_support_restore_v1(p_invoice uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ DECLARE inv public.invoices%ROWTYPE; c app_private.rent_support_invoice_claims%ROWTYPE; new_id uuid; revenue numeric; BEGIN
 PERFORM app_private.invoice_rent_support_lock_v1(p_invoice);
 SELECT * INTO inv FROM public.invoices WHERE id=p_invoice FOR UPDATE;
 IF inv.invoice_support_amount=0 THEN RETURN;END IF;
 IF NOT app_private.rent_support_writers_enabled_v1() THEN RAISE EXCEPTION 'RENT_SUPPORT_WRITERS_DISABLED' USING ERRCODE='55000';END IF;
 SELECT * INTO c FROM app_private.rent_support_invoice_claims WHERE organization_id=inv.organization_id AND invoice_id=p_invoice AND released_at IS NOT NULL ORDER BY released_at DESC LIMIT 1;
 IF c.id IS NULL OR c.claimed_amount<>inv.invoice_support_amount OR c.billing_month<>inv.billing_month THEN RAISE EXCEPTION 'Support snapshot requires review' USING ERRCODE='PT409';END IF;
 IF EXISTS(SELECT 1 FROM app_private.rent_support_invoice_claims WHERE organization_id=inv.organization_id AND contract_id=inv.contract_id AND billing_month=inv.billing_month AND released_at IS NULL) THEN RAISE EXCEPTION 'Support month already claimed' USING ERRCODE='PT409';END IF;
 SELECT COALESCE(sum(amount) FILTER(WHERE accounting_class='REVENUE'),0) INTO revenue FROM public.invoice_items WHERE invoice_id=p_invoice AND organization_id=inv.organization_id;
 IF inv.invoice_support_amount>greatest(revenue-inv.manual_discount_amount-inv.credit_discount_amount,0) THEN RAISE EXCEPTION 'REVENUE_CAP_REVIEW' USING ERRCODE='PT409';END IF;
 INSERT INTO app_private.rent_support_invoice_claims(organization_id,contract_id,billing_month,support_month_id,invoice_id,invoice_revision,claimed_amount)
 VALUES(c.organization_id,c.contract_id,c.billing_month,c.support_month_id,p_invoice,inv.adjustment_revision,c.claimed_amount) RETURNING id INTO new_id;
 INSERT INTO app_private.rent_support_invoice_events(organization_id,contract_id,claim_id,invoice_id,actor_id,request_id,action,payload_hash,before_snapshot,after_snapshot,reason)
 VALUES(c.organization_id,c.contract_id,new_id,p_invoice,auth.uid(),md5('restore|'||c.id::text)::uuid,'APPLIED',md5(to_jsonb(inv)::text),to_jsonb(c),jsonb_build_object('claim_id',new_id,'amount',c.claimed_amount),'Restore original invoice support snapshot');
END $$;

-- Invoker trigger distinguishes authenticated table DML from postgres-owned canonical
-- writers. No caller-controlled GUC or client metadata can impersonate a writer.
CREATE OR REPLACE FUNCTION app_private.invoice_rent_support_guard_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF current_user<>'postgres' AND (NEW.rent_support_plan_revision IS NOT NULL OR NEW.invoice_support_amount<>0
 OR EXISTS(SELECT 1 FROM public.contracts WHERE id=NEW.contract_id AND organization_id=NEW.organization_id AND discounts->>'version'='2')
 OR (TG_OP='UPDATE' AND OLD.rent_support_plan_revision IS NOT NULL)) THEN
 RAISE EXCEPTION 'V2 support requires canonical invoice writer' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rent_support_canonical_guard ON public.invoices;
CREATE TRIGGER rent_support_canonical_guard BEFORE INSERT OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION app_private.invoice_rent_support_guard_v1();
CREATE OR REPLACE FUNCTION app_private.invoice_rent_support_validate_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 -- The MONTHLY invoice index is checked before AFTER triggers. Translate a
 -- restore collision under the canonical org/contract locks before that index.
 IF TG_OP='UPDATE' AND NEW.invoice_support_amount>0 AND NEW.deleted_at IS NULL AND NEW.status::text<>'CANCELLED'
 AND (OLD.deleted_at IS NOT NULL OR OLD.status::text='CANCELLED') THEN
 PERFORM app_private.invoice_rent_support_lock_v1(OLD.id);
 IF EXISTS(SELECT 1 FROM app_private.rent_support_invoice_claims WHERE organization_id=NEW.organization_id AND contract_id=NEW.contract_id AND billing_month=NEW.billing_month AND released_at IS NULL AND invoice_id<>NEW.id) THEN
 RAISE EXCEPTION 'Support month already claimed' USING ERRCODE='PT409';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans WHERE organization_id=NEW.organization_id AND contract_id=NEW.contract_id)
 OR EXISTS(SELECT 1 FROM public.contracts WHERE id=NEW.contract_id AND organization_id=NEW.organization_id AND discounts->>'version'='2') THEN
 IF NEW.rent_support_plan_revision IS NULL OR NEW.rent_support_request_id IS NULL OR NEW.manual_discount_amount IS NULL OR NEW.credit_discount_amount IS NULL
 OR NEW.invoice_support_amount<0 OR NEW.manual_discount_amount<0 OR NEW.credit_discount_amount<0
 OR NEW.discount_amount IS DISTINCT FROM NEW.invoice_support_amount+NEW.manual_discount_amount+NEW.credit_discount_amount THEN
 RAISE EXCEPTION 'V2 invoice requires canonical support components' USING ERRCODE='42501';END IF;
 END IF;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rent_support_component_validation ON public.invoices;
CREATE TRIGGER rent_support_component_validation BEFORE INSERT OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION app_private.invoice_rent_support_validate_v1();
CREATE OR REPLACE FUNCTION app_private.invoice_rent_support_lifecycle_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 IF OLD.rent_support_plan_revision IS NOT NULL AND OLD.deleted_at IS NULL AND OLD.status::text<>'CANCELLED'
 AND (NEW.deleted_at IS NOT NULL OR NEW.status::text='CANCELLED') THEN
 PERFORM app_private.invoice_rent_support_release_v1(NEW.id,'Canonical invoice cancellation');
 ELSIF NEW.rent_support_plan_revision IS NOT NULL AND NEW.deleted_at IS NULL AND NEW.status::text<>'CANCELLED'
 AND (OLD.deleted_at IS NOT NULL OR OLD.status::text='CANCELLED') THEN
 PERFORM app_private.invoice_rent_support_restore_v1(NEW.id);END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rent_support_lifecycle ON public.invoices;
CREATE TRIGGER rent_support_lifecycle AFTER UPDATE OF status,deleted_at ON public.invoices FOR EACH ROW EXECUTE FUNCTION app_private.invoice_rent_support_lifecycle_v1();

CREATE OR REPLACE FUNCTION app_private.invoice_rent_support_before_v1(p_org uuid,p_contract uuid,p_month text,p_kind text,p_items jsonb,p_discount numeric,p_credit numeric,p_context jsonb,p_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q jsonb; BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.organization_id=p_org AND c.id=p_contract AND c.discounts->>'version'='2')
 AND NOT EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans WHERE organization_id=p_org AND contract_id=p_contract) THEN
 IF p_context IS NOT NULL THEN RAISE EXCEPTION 'Context requires a rent support plan' USING ERRCODE='22023';END IF;RETURN NULL;END IF;
 IF NOT app_private.rent_support_writers_enabled_v1() THEN RAISE EXCEPTION 'RENT_SUPPORT_WRITERS_DISABLED' USING ERRCODE='55000';END IF;
 PERFORM app_private.invoice_rent_support_context_v1(p_context);
 IF p_key IS NOT NULL AND p_key IS DISTINCT FROM lower(p_context->>'request_id') THEN RAISE EXCEPTION 'Support request must match canonical request identity' USING ERRCODE='PT409';END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_org);
 PERFORM 1 FROM public.contracts WHERE organization_id=p_org AND id=p_contract FOR UPDATE;
 q:=app_private.invoice_rent_support_quote_v1(p_org,p_contract,p_month,p_kind,p_items,(p_context->>'manual_discount_amount')::numeric,p_credit,(p_context->>'expected_plan_revision')::bigint);
 IF q->>'state'<>'READY' THEN RAISE EXCEPTION 'REVENUE_CAP_REVIEW' USING ERRCODE='PT409',DETAIL=q::text;END IF;
 IF p_discount IS DISTINCT FROM (q->>'invoice_support')::numeric+(p_context->>'manual_discount_amount')::numeric+p_credit THEN
 RAISE EXCEPTION 'Discount must equal support plus manual discount plus credit' USING ERRCODE='22023';END IF;
 RETURN q;
END $$;

-- Replacing signatures is atomic in the forward/TEST lane. RESTRICT deliberately
-- fails if a new database dependency has appeared since the catalog inspection.
DO $migration$ DECLARE f text; old regprocedure; args text; argnames text; public_args text; sig text; anchor text; BEGIN
 old:=to_regprocedure('public.create_invoice_v1(uuid,uuid,uuid,text,date,date,text,numeric,numeric,numeric,numeric,jsonb,text,numeric,text,boolean,jsonb,uuid,text,numeric,text)');
 IF old IS NOT NULL THEN
 SELECT pg_get_functiondef(old),pg_get_function_arguments(old),array_to_string(proargnames,',') INTO f,args,argnames FROM pg_proc WHERE oid=old;
 IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=old)<>'postgres' THEN RAISE EXCEPTION 'Unexpected canonical invoice owner';END IF;
 public_args:=args||', p_rent_support_context jsonb DEFAULT NULL::jsonb';
 f:=replace(f,'public.create_invoice_v1('||args||')','app_private.create_invoice_rent_support_core_v1('||public_args||', p_credit_adapter boolean DEFAULT false)');
 IF position('app_private.create_invoice_rent_support_core_v1' IN f)=0 THEN RAISE EXCEPTION 'Missing canonical create signature anchor';END IF;
 anchor:='  v_actor uuid := auth.uid();';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing create declaration anchor';END IF;
 f:=replace(f,anchor,anchor||E'\n  v_support jsonb;');
 anchor:='  -- derive + lock:';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing create lock anchor';END IF;
 f:=replace(f,anchor,E'  select organization_id into v_org from public.buildings where id=p_building_id;\n  perform app_private.lock_org_for_decision_v1(v_org);\n'||anchor);
 f:=replace(f,'and c.organization_id=v_org for share;','and c.organization_id=v_org for update;');
 anchor:='  v_hash := md5(jsonb_build_object(''contract'',p_contract_id,''month'',p_billing_month,'||E'\n    ''total'',p_total_amount,''org'',v_org)::text);';
 IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing canonical create request hash anchor';END IF;
 f:=replace(f,anchor,$patch$  IF p_rent_support_context IS NOT NULL THEN PERFORM app_private.invoice_rent_support_context_v1(p_rent_support_context);END IF;
  v_hash := md5(jsonb_build_object('contract',p_contract_id,'month',p_billing_month,'org',v_org,'building',p_building_id,'room',p_room_id,'issue',p_issue_date,'due',p_due_date,'kind',p_kind,'subtotal',p_subtotal,'discount',p_discount_amount,'total',p_total_amount,'debt',p_previous_debt,'items',p_items,'prepaid',p_prepaid_amount,'discount_notes',p_discount_notes,'electricity',p_electricity_prev_overridden,'debt_sources',p_previous_debt_sources,'template',p_template_id,'notes',p_notes,'credit',p_applied_credit,'creator',p_creator_name,'support_context',p_rent_support_context,'credit_adapter',p_credit_adapter)::text);$patch$);
 -- Legacy request hashes retain the original protocol; a replay written before this migration stays valid.
 f:=replace(f,'  insert into app_private.canonical_write_operations',$patch$  IF p_rent_support_context IS NULL THEN v_hash:=md5(jsonb_build_object('contract',p_contract_id,'month',p_billing_month,'total',p_total_amount,'org',v_org)::text);END IF;
  insert into app_private.canonical_write_operations$patch$);
 anchor:='  if v_op.completed_at is not null then return v_op.response_payload::json; end if;';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing create replay anchor';END IF;
 f:=replace(f,anchor,anchor||$patch$
  v_support := app_private.invoice_rent_support_before_v1(v_org,p_contract_id,p_billing_month,p_kind,p_items,p_discount_amount,coalesce(p_applied_credit,0),p_rent_support_context,v_key);
  IF v_support IS NOT NULL AND coalesce(p_applied_credit,0)>0 AND NOT p_credit_adapter THEN RAISE EXCEPTION 'Use canonical FIFO credit writer' USING ERRCODE='22023';END IF;
$patch$);
 anchor:='  -- create the invoice;';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing create insert anchor';END IF;
 f:=replace(f,anchor,$patch$  IF (v_support->>'invoice_support')::numeric>0 AND EXISTS(SELECT 1 FROM app_private.rent_support_invoice_claims WHERE organization_id=v_org AND contract_id=p_contract_id AND billing_month=p_billing_month AND released_at IS NULL) THEN RAISE EXCEPTION 'Support month already claimed' USING ERRCODE='PT409';END IF;
  -- create the invoice;$patch$);
 anchor:='     approved_by, approved_at)';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing create columns anchor';END IF;
 f:=replace(f,anchor,'     approved_by, approved_at,invoice_support_amount,manual_discount_amount,credit_discount_amount,rent_support_plan_revision,rent_support_request_id)');
 anchor:='     case when v_auto then now() else null end)';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing create values anchor';END IF;
 f:=replace(f,anchor,'     case when v_auto then now() else null end,coalesce((v_support->>''invoice_support'')::numeric,0),(p_rent_support_context->>''manual_discount_amount'')::numeric,CASE WHEN v_support IS NOT NULL THEN coalesce(p_applied_credit,0) END,(v_support->>''plan_revision'')::bigint,(p_rent_support_context->>''request_id'')::uuid)');
 f:=replace(f,'  if v_applied > 0 and p_contract_id is not null then','  if v_applied > 0 and p_contract_id is not null and NOT p_credit_adapter then');
 anchor:='  v_resp := json_build_object';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing create claim anchor';END IF;
 f:=replace(f,anchor,$patch$  IF v_support IS NOT NULL THEN PERFORM app_private.resolve_invoice_rent_support_v1(v_org,p_contract_id,v_invoice,p_billing_month,jsonb_build_array(jsonb_build_object('billing_month',p_billing_month)),(v_support->>'plan_revision')::bigint,(p_rent_support_context->>'request_id')::uuid);END IF;
  v_resp := json_build_object$patch$);
 EXECUTE f;
 EXECUTE format('DROP FUNCTION %s RESTRICT',old);
 EXECUTE 'CREATE FUNCTION public.create_invoice_v1('||public_args||') RETURNS json LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $wrapper$ SELECT app_private.create_invoice_rent_support_core_v1('||argnames||',p_rent_support_context,false) $wrapper$';
 END IF;

 old:=to_regprocedure('public.create_invoice_with_credit_v1(uuid,uuid,uuid,text,date,date,text,numeric,numeric,numeric,numeric,jsonb,text,numeric,text,boolean,jsonb,uuid,text,numeric,numeric,text)');
 IF old IS NOT NULL THEN
 SELECT pg_get_functiondef(old),pg_get_function_arguments(old) INTO f,args FROM pg_proc WHERE oid=old;
 f:=replace(f,'public.create_invoice_with_credit_v1('||args||')','public.create_invoice_with_credit_v1('||args||', p_rent_support_context jsonb DEFAULT NULL::jsonb)');
 anchor:='  v_invoice_result := public.create_invoice_v1(';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing FIFO core call anchor';END IF;
 f:=replace(f,anchor,'  v_invoice_result := app_private.create_invoice_rent_support_core_v1(');
 anchor:='    p_previous_debt_sources, p_template_id, p_notes, 0, p_creator_name';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing FIFO credit argument anchor';END IF;
 f:=replace(f,anchor,'    p_previous_debt_sources, p_template_id, p_notes, p_applied_credit, p_creator_name, p_rent_support_context, true');
 EXECUTE format('DROP FUNCTION %s RESTRICT',old);EXECUTE f;
 END IF;
END $migration$;

-- Both exposed batch RPCs converge here. Only the v2 branch changes; the old
-- rent/service arithmetic is used to build the canonical request, one month only.
DO $migration$ DECLARE f text; anchor text; BEGIN
 f:=pg_get_functiondef('public.generate_invoices_for_building(uuid,uuid,text,text)'::regprocedure);
 IF position('RENT_SUPPORT_GENERATE_V1' IN f)=0 THEN
 anchor:='  v_contract RECORD;';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing batch declaration';END IF;
 f:=replace(f,anchor,anchor||E'\n  v_support_items jsonb; v_support_context jsonb; v_support_quote jsonb; v_support_revision bigint; v_support_org uuid; v_support_key uuid;');
 anchor:='    INSERT INTO invoices (';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing batch invoice anchor';END IF;
 f:=replace(f,anchor,$patch$    -- RENT_SUPPORT_GENERATE_V1
    IF EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans WHERE contract_id=v_contract.contract_id) THEN
      SELECT organization_id INTO v_support_org FROM public.contracts WHERE id=v_contract.contract_id;
      PERFORM app_private.lock_org_for_decision_v1(v_support_org);
      PERFORM 1 FROM public.contracts WHERE id=v_contract.contract_id AND organization_id=v_support_org FOR UPDATE;
      SELECT revision INTO v_support_revision FROM app_private.contract_rent_support_plans WHERE organization_id=v_support_org AND contract_id=v_contract.contract_id AND state='ACTIVE' ORDER BY revision DESC LIMIT 1;
      v_support_items:='[]';
      IF p_invoice_type IN ('rent_only','both') THEN v_support_items:=v_support_items||jsonb_build_array(jsonb_build_object('type','RENT','description','Tiền thuê phòng','unit_price',v_contract.rent_price,'quantity',1,'coefficient',1,'amount',v_contract.rent_price,'accounting_class','REVENUE'));END IF;
      IF p_invoice_type IN ('service_only','both') THEN
        FOR v_service IN SELECT cs.service_id,cs.unit_price,s.name AS service_name FROM public.contract_services cs JOIN public.services s ON s.id=cs.service_id WHERE cs.contract_id=v_contract.contract_id LOOP
          v_support_items:=v_support_items||jsonb_build_array(jsonb_build_object('service_id',v_service.service_id,'type','SERVICE','description',v_service.service_name,'unit_price',v_service.unit_price,'quantity',1,'coefficient',1,'amount',v_service.unit_price,'accounting_class','REVENUE'));
        END LOOP;
      END IF;
      v_support_quote:=app_private.invoice_rent_support_quote_v1(v_support_org,v_contract.contract_id,p_billing_month,'MONTHLY',v_support_items,0,0,v_support_revision);
      IF v_support_quote->>'state'<>'READY' THEN RAISE EXCEPTION 'REVENUE_CAP_REVIEW' USING ERRCODE='PT409',DETAIL=v_support_quote::text;END IF;
      v_support_key:=md5('generate.support|'||v_support_org::text||'|'||v_contract.contract_id::text||'|'||p_billing_month||'|'||p_invoice_type||'|'||auth.uid()::text)::uuid;
      v_support_context:=jsonb_build_object('version',1,'expected_plan_revision',v_support_revision,'manual_discount_amount','0','request_id',v_support_key);
      SELECT COALESCE(sum((x->>'amount')::numeric),0) INTO v_subtotal FROM jsonb_array_elements(v_support_items) x;
      PERFORM public.create_invoice_v1(p_contract_id=>v_contract.contract_id,p_building_id=>p_building_id,p_room_id=>v_contract.room_id,p_billing_month=>p_billing_month,
        p_issue_date=>public.org_today_v1(v_support_org),p_due_date=>public.org_today_v1(v_support_org)+5,p_kind=>'MONTHLY',p_subtotal=>v_subtotal,
        p_discount_amount=>(v_support_quote->>'invoice_support')::numeric,p_total_amount=>app_private.round_invoice_total_v1(v_subtotal-(v_support_quote->>'invoice_support')::numeric),
        p_previous_debt=>0,p_items=>v_support_items,p_idempotency_key=>v_support_key::text,p_rent_support_context=>v_support_context);
      v_created_count:=v_created_count+1;CONTINUE;
    END IF;
    INSERT INTO invoices ($patch$);EXECUTE f;
 END IF;
END $migration$;

-- Acquire support locks before existing lifecycle row locks, preserving each
-- function's paid/status/credit authorization and transactional unwind logic.
DO $migration$ DECLARE r record; f text; pos integer; BEGIN
 FOR r IN SELECT p.oid::regprocedure signature FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN
 ('cancel_invoice_v1','restore_invoice_v1','cancel_invoice_with_credit_v1','restore_invoice_with_credit_v1','soft_delete_invoice_v1','soft_delete_invoice_with_credit_v1','super_admin_force_cancel_invoice_with_credit_v1','adjust_invoice_v2') LOOP
 f:=pg_get_functiondef(r.signature);
 IF position('RENT_SUPPORT_LIFECYCLE_LOCK_V1' IN f)=0 THEN
 pos:=position(E'BEGIN\n' IN f);IF pos=0 THEN RAISE EXCEPTION 'Missing lifecycle BEGIN for %',r.signature;END IF;
 f:=overlay(f placing E'BEGIN\n  -- RENT_SUPPORT_LIFECYCLE_LOCK_V1\n  PERFORM app_private.invoice_rent_support_lock_v1(p_invoice_id);\n' from pos for length(E'BEGIN\n'));EXECUTE f;
 END IF;END LOOP;
END $migration$;

DO $migration$ DECLARE f text; anchor text; BEGIN
 f:=pg_get_functiondef('public.adjust_invoice_v2(uuid,jsonb,numeric,text,text,text,bigint,numeric,timestamp with time zone,text)'::regprocedure);
 IF position('RENT_SUPPORT_ADJUSTMENT_V1' IN f)=0 THEN
 anchor:='  -- Capture the original revision before replacing its current document.';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing adjustment review anchor';END IF;
 f:=replace(f,anchor,$patch$  -- RENT_SUPPORT_ADJUSTMENT_V1: support snapshot stays fixed across the invoice revision.
  IF inv.rent_support_plan_revision IS NOT NULL THEN
    IF inv.invoice_support_amount>0 AND discount IS DISTINCT FROM inv.discount_amount THEN RAISE EXCEPTION 'Support discount changes require reconciliation' USING ERRCODE='PT409';END IF;
    IF discount<inv.invoice_support_amount+coalesce(inv.credit_discount_amount,0)
    OR inv.invoice_support_amount>greatest((SELECT coalesce(sum((support_line.value->>'amount')::numeric) FILTER(WHERE support_line.value->>'accounting_class'='REVENUE'),0) FROM jsonb_array_elements(items) support_line(value))-coalesce(inv.manual_discount_amount,0)-coalesce(inv.credit_discount_amount,0),0) THEN
    RAISE EXCEPTION 'REVENUE_CAP_REVIEW' USING ERRCODE='PT409';END IF;
  END IF;
  -- Capture the original revision before replacing its current document.$patch$);
 anchor:='  UPDATE public.invoices SET subtotal=v_subtotal, total_amount=total,discount_amount=discount,';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing adjustment components anchor';END IF;
 f:=replace(f,anchor,'  UPDATE public.invoices SET manual_discount_amount=CASE WHEN inv.rent_support_plan_revision IS NOT NULL THEN discount-inv.invoice_support_amount-coalesce(inv.credit_discount_amount,0) ELSE manual_discount_amount END,subtotal=v_subtotal, total_amount=total,discount_amount=discount,');
 anchor:='  RETURN result;';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing adjustment return anchor';END IF;
 -- Only the final return gains an audit event; replay exits before this point.
 f:=replace(f,E'  PERFORM public.recompute_invoice_for_id(p_invoice_id);\n  RETURN result;',$patch$  PERFORM public.recompute_invoice_for_id(p_invoice_id);
  IF inv.invoice_support_amount>0 THEN
    INSERT INTO app_private.rent_support_invoice_events(organization_id,contract_id,claim_id,invoice_id,actor_id,request_id,action,payload_hash,before_snapshot,after_snapshot,reason)
    SELECT c.organization_id,c.contract_id,c.id,p_invoice_id,actor,md5('support.adjust|'||p_invoice_id::text||'|'||key)::uuid,'APPLIED',fingerprint,to_jsonb(c),jsonb_build_object('invoice_revision',result.revision,'claimed_amount',c.claimed_amount),p_reason
    FROM app_private.rent_support_invoice_claims c WHERE c.invoice_id=p_invoice_id AND c.released_at IS NULL;
    UPDATE app_private.rent_support_invoice_claims SET invoice_revision=result.revision,version=version+1 WHERE invoice_id=p_invoice_id AND released_at IS NULL;
  END IF;
  RETURN result;$patch$);EXECUTE f;
 END IF;
END $migration$;

DO $migration$ DECLARE f text; old regprocedure; args text; anchor text; BEGIN
 old:=to_regprocedure('public.update_invoice_v1(uuid,uuid,uuid,uuid,text,date,date,numeric,numeric,numeric,numeric,jsonb,numeric,text,boolean,jsonb,uuid,text)');
 IF old IS NOT NULL THEN
 SELECT pg_get_functiondef(old),pg_get_function_arguments(old) INTO f,args FROM pg_proc WHERE oid=old;
 f:=replace(f,'public.update_invoice_v1('||args||')','public.update_invoice_v1('||args||', p_rent_support_context jsonb DEFAULT NULL::jsonb)');
 anchor:='  v_actor uuid := auth.uid();';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing update declaration';END IF;
 f:=replace(f,anchor,anchor||E'\n  v_support jsonb; v_support_credit numeric; v_support_hash text; v_support_replay app_private.rent_support_invoice_update_requests%ROWTYPE;');
 anchor:='  select * into v_row from public.invoices';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing update lock anchor';END IF;
 f:=replace(f,anchor,E'  perform app_private.invoice_rent_support_lock_v1(p_invoice_id);\n'||anchor);
 anchor:='  -- recalc total + assert';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing update calculation anchor';END IF;
 f:=replace(f,anchor,$patch$  v_support_credit:=coalesce(v_row.credit_discount_amount,0);
  IF v_row.rent_support_plan_revision IS NOT NULL THEN
    PERFORM app_private.invoice_rent_support_context_v1(p_rent_support_context);
    v_support_hash:=md5(jsonb_build_object('invoice',p_invoice_id,'contract',p_contract_id,'building',p_building_id,'room',p_room_id,'month',p_billing_month,'issue',p_issue_date,'due',p_due_date,'subtotal',p_subtotal,'discount',p_discount_amount,'total',p_total_amount,'debt',p_previous_debt,'items',p_items,'prepaid',p_prepaid_amount,'discount_notes',p_discount_notes,'electricity',p_electricity_prev_overridden,'debt_sources',p_previous_debt_sources,'template',p_template_id,'notes',p_notes,'context',p_rent_support_context)::text);
    SELECT * INTO v_support_replay FROM app_private.rent_support_invoice_update_requests WHERE organization_id=v_org AND actor_id=v_actor AND request_id=(p_rent_support_context->>'request_id')::uuid;
    IF FOUND THEN IF v_support_replay.payload_hash<>v_support_hash THEN RAISE EXCEPTION 'Support update request changed' USING ERRCODE='PT409';END IF;RETURN jsonb_populate_record(NULL::public.invoices,v_support_replay.result);END IF;
  END IF;
  IF v_row.rent_support_plan_revision IS NOT NULL AND (p_contract_id IS DISTINCT FROM v_row.contract_id OR p_building_id IS DISTINCT FROM v_row.building_id) THEN RAISE EXCEPTION 'Support invoice cannot change subject' USING ERRCODE='PT409';END IF;
  v_support:=app_private.invoice_rent_support_before_v1(v_org,p_contract_id,p_billing_month,v_row.kind,v_normalized_items,p_discount_amount,v_support_credit,p_rent_support_context);
  IF v_support IS NOT NULL THEN PERFORM app_private.invoice_rent_support_release_v1(p_invoice_id,'Canonical draft invoice update');END IF;
  -- recalc total + assert$patch$);
 anchor:='     set contract_id                 = p_contract_id,';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing update columns anchor';END IF;
 f:=replace(f,anchor,$patch$     set invoice_support_amount=coalesce((v_support->>'invoice_support')::numeric,0),
         manual_discount_amount=(p_rent_support_context->>'manual_discount_amount')::numeric,
         credit_discount_amount=CASE WHEN v_support IS NOT NULL THEN v_support_credit END,
         rent_support_plan_revision=(v_support->>'plan_revision')::bigint,
         rent_support_request_id=(p_rent_support_context->>'request_id')::uuid,
         contract_id                 = p_contract_id,$patch$);
 anchor:='  return v_row;';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing update result anchor';END IF;
 f:=replace(f,anchor,$patch$  IF v_support IS NOT NULL THEN
    PERFORM app_private.resolve_invoice_rent_support_v1(v_org,p_contract_id,p_invoice_id,p_billing_month,jsonb_build_array(jsonb_build_object('billing_month',p_billing_month)),(v_support->>'plan_revision')::bigint,(p_rent_support_context->>'request_id')::uuid);
    INSERT INTO app_private.rent_support_invoice_update_requests VALUES(v_org,v_actor,(p_rent_support_context->>'request_id')::uuid,p_invoice_id,v_support_hash,to_jsonb(v_row));
  END IF;
  return v_row;$patch$);
 EXECUTE format('DROP FUNCTION %s RESTRICT',old);EXECUTE f;
 END IF;
END $migration$;

-- Canonical contract creation has its own first-invoice calculation/rounding.
-- Preserve it and join the same quote/claim helper inside that transaction.
DO $migration$ DECLARE f text; anchor text; BEGIN
 f:=pg_get_functiondef('public.create_contract_v2(jsonb,text)'::regprocedure);
 IF position('RENT_SUPPORT_FIRST_INVOICE_V1' IN f)=0 THEN
 anchor:='  v_first_invoice jsonb := p_payload->''first_invoice'';';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing first invoice declaration';END IF;
 f:=replace(f,anchor,anchor||E'\n  v_support jsonb; v_support_context jsonb; v_support_revision bigint;');
 anchor:='    v_discount := COALESCE((v_first_invoice->>''discount_amount'')::numeric, 0);';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing first invoice discount anchor';END IF;
 f:=replace(f,anchor,$patch$    -- RENT_SUPPORT_FIRST_INVOICE_V1
    v_billing_month := public.compute_first_billing_month_v2(v_start_billing, v_end_billing);
    IF v_contract_json ? 'rent_support' THEN
      SELECT revision INTO v_support_revision FROM app_private.contract_rent_support_plans WHERE organization_id=v_org AND contract_id=v_contract_id AND state='ACTIVE' ORDER BY revision DESC LIMIT 1;
      IF jsonb_typeof(v_first_invoice->'manual_discount_amount') IS DISTINCT FROM 'string' OR v_first_invoice->>'manual_discount_amount' !~ '^[0-9]+(\.[0-9]{1,2})?$' THEN RAISE EXCEPTION 'Explicit first invoice manual discount required' USING ERRCODE='22023';END IF;
      v_support_context:=jsonb_build_object('version',1,'expected_plan_revision',v_support_revision,'manual_discount_amount',v_first_invoice->>'manual_discount_amount','request_id',md5('contract.first_invoice|'||v_key)::uuid);
      v_support:=app_private.invoice_rent_support_before_v1(v_org,v_contract_id,v_billing_month,'MONTHLY',v_first_invoice->'items',COALESCE((v_first_invoice->>'discount_amount')::numeric,0),0,v_support_context);
    END IF;
    v_discount := COALESCE((v_first_invoice->>'discount_amount')::numeric, 0);$patch$);
 anchor:='      approved_at, approved_by, kind';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing first invoice columns anchor';END IF;
 f:=replace(f,anchor,'      approved_at, approved_by, kind,invoice_support_amount,manual_discount_amount,credit_discount_amount,rent_support_plan_revision,rent_support_request_id');
 anchor:='      clock_timestamp(), v_actor, ''MONTHLY''';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing first invoice values anchor';END IF;
 f:=replace(f,anchor,'      clock_timestamp(), v_actor, ''MONTHLY'',coalesce((v_support->>''invoice_support'')::numeric,0),(v_support_context->>''manual_discount_amount'')::numeric,CASE WHEN v_support IS NOT NULL THEN 0 END,(v_support->>''plan_revision'')::bigint,(v_support_context->>''request_id'')::uuid');
 anchor:='    SELECT to_jsonb(invoice_row) INTO v_invoice_row';IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing first invoice claim anchor';END IF;
 f:=replace(f,anchor,$patch$    IF v_support IS NOT NULL THEN PERFORM app_private.resolve_invoice_rent_support_v1(v_org,v_contract_id,v_invoice_id,v_billing_month,jsonb_build_array(jsonb_build_object('billing_month',v_billing_month)),v_support_revision,(v_support_context->>'request_id')::uuid);END IF;
    SELECT to_jsonb(invoice_row) INTO v_invoice_row$patch$);
 EXECUTE f;
 END IF;
END $migration$;

-- Invoice-context quote exposes only the customer month and discount components.
DO $migration$ DECLARE f text; anchor text; BEGIN
 f:=pg_get_functiondef('public.quote_contract_rent_support_v1(uuid,uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
 IF position('RENT_SUPPORT_INVOICE_QUOTE_V1' IN f)=0 THEN
 anchor:=' b:=app_private.rent_support_subject_v1(p_organization_id,p_contract_id,p_draft_id,true);';
 IF position(anchor IN f)=0 THEN RAISE EXCEPTION 'Missing public quote scope anchor';END IF;
 f:=replace(f,anchor,$patch$ -- RENT_SUPPORT_INVOICE_QUOTE_V1
 IF p_invoice_context IS NOT NULL THEN
   IF p_contract_id IS NULL OR p_draft_id IS NOT NULL OR p_payout_context IS NOT NULL OR p_payload IS NOT NULL THEN RAISE EXCEPTION 'Invoice quote requires canonical contract context only' USING ERRCODE='22023';END IF;
   IF jsonb_typeof(p_invoice_context) IS DISTINCT FROM 'object' OR NOT(p_invoice_context ?& ARRAY['version','billing_month','kind','items','manual_discount_amount','credit_discount_amount','expected_plan_revision'])
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_invoice_context) k WHERE k NOT IN ('version','billing_month','kind','items','manual_discount_amount','credit_discount_amount','expected_plan_revision'))
   OR p_invoice_context->'version' IS DISTINCT FROM '1'::jsonb
   OR jsonb_typeof(p_invoice_context->'manual_discount_amount') IS DISTINCT FROM 'string' OR p_invoice_context->>'manual_discount_amount' !~ '^[0-9]+(\.[0-9]{1,2})?$'
   OR jsonb_typeof(p_invoice_context->'credit_discount_amount') IS DISTINCT FROM 'string' OR p_invoice_context->>'credit_discount_amount' !~ '^[0-9]+(\.[0-9]{1,2})?$'
   OR jsonb_typeof(p_invoice_context->'expected_plan_revision') IS DISTINCT FROM 'number' OR p_invoice_context->>'expected_plan_revision' !~ '^[1-9][0-9]*$'
   THEN RAISE EXCEPTION 'Invalid invoice quote context' USING ERRCODE='22023';END IF;
   v:=app_private.invoice_rent_support_quote_v1(p_organization_id,p_contract_id,p_invoice_context->>'billing_month',p_invoice_context->>'kind',p_invoice_context->'items',
     (p_invoice_context->>'manual_discount_amount')::numeric,(p_invoice_context->>'credit_discount_amount')::numeric,(p_invoice_context->>'expected_plan_revision')::bigint);
   RETURN v||jsonb_build_object('quote_hash',md5(jsonb_build_object('org',p_organization_id,'contract',p_contract_id,'context',p_invoice_context,'quote',v)::text),'billing_month',p_invoice_context->>'billing_month');
 END IF;
 b:=app_private.rent_support_subject_v1(p_organization_id,p_contract_id,p_draft_id,true);$patch$);EXECUTE f;
 END IF;
END $migration$;

-- Quotes use readonly scope projections. Only writers authorize under locks.
ALTER FUNCTION public.quote_contract_rent_support_v1(uuid,uuid,uuid,jsonb,jsonb,jsonb) STABLE;

-- Only these four authorized engines may open item capabilities. Signing and
-- generation delegate to them; recompute and lifecycle triggers never open one.
DO $migration$ DECLARE r record; f text; anchor text; ending text; invoice_var text; BEGIN
 FOR r IN SELECT p.oid::regprocedure signature,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE
 (n.nspname='app_private' AND p.proname='create_invoice_rent_support_core_v1')
 OR (n.nspname='public' AND p.proname IN ('update_invoice_v1','create_contract_v2','adjust_invoice_v2')) LOOP
 f:=pg_get_functiondef(r.signature);
 IF position('RENT_SUPPORT_ITEM_CAPABILITY_V1' IN f)=0 THEN
 CASE r.proname
 WHEN 'create_invoice_rent_support_core_v1' THEN anchor:='  returning id, invoice_number into v_invoice, v_invoice_number;';ending:='  v_resp := json_build_object';invoice_var:='v_invoice';
 WHEN 'update_invoice_v1' THEN anchor:='  delete from public.invoice_items where invoice_id = p_invoice_id;';ending:='  return v_row;';invoice_var:='p_invoice_id';
 WHEN 'create_contract_v2' THEN anchor:='    ) RETURNING id INTO v_invoice_id;';ending:='    SELECT to_jsonb(invoice_row) INTO v_invoice_row';invoice_var:='v_invoice_id';
 WHEN 'adjust_invoice_v2' THEN anchor:='  DELETE FROM public.invoice_items WHERE invoice_id=p_invoice_id;';ending:='  PERFORM public.recompute_invoice_for_id(p_invoice_id);';invoice_var:='p_invoice_id';
 END CASE;
 IF position(anchor IN f)=0 OR position(ending IN f)=0 THEN RAISE EXCEPTION 'Missing capability adapter anchors for %',r.signature;END IF;
 IF r.proname IN ('update_invoice_v1','adjust_invoice_v2') THEN
 f:=replace(f,anchor,E'  -- RENT_SUPPORT_ITEM_CAPABILITY_V1\n  PERFORM app_private.invoice_rent_support_items_open_v1('||invoice_var||E');\n'||anchor);
 ELSE f:=replace(f,anchor,anchor||E'\n  -- RENT_SUPPORT_ITEM_CAPABILITY_V1\n  PERFORM app_private.invoice_rent_support_items_open_v1('||invoice_var||');');END IF;
 f:=replace(f,ending,E'  PERFORM app_private.invoice_rent_support_items_close_v1('||invoice_var||E');\n'||ending);
 EXECUTE f;
 END IF;END LOOP;
END $migration$;

-- Preserve the captured public ACLs, including service_role on the two existing
-- core interfaces. Private helpers and tables remain inaccessible to every API role.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT p.oid::regprocedure signature,n.nspname,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE
 (n.nspname='app_private' AND (p.proname LIKE 'invoice_rent_support_%' OR p.proname IN ('create_invoice_rent_support_core_v1','resolve_invoice_rent_support_v1')))
 OR (n.nspname='public' AND p.proname IN ('create_invoice_v1','create_invoice_with_credit_v1','update_invoice_v1')) LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',r.signature);
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',r.signature);
 IF r.nspname='public' THEN
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',r.signature);
 IF r.proname IN ('create_invoice_v1','update_invoice_v1') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',r.signature);END IF;
 END IF;
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
