-- Task7: immutable source parts and v2-only salary bridges. Legacy writers remain private delegates.
CREATE TABLE IF NOT EXISTS app_private.rent_support_salary_parts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,source_id uuid NOT NULL,operation_id uuid NOT NULL,
 voucher_id uuid NOT NULL REFERENCES public.income_expenses(id),item_id uuid NOT NULL REFERENCES public.income_expense_items(id),
 salary_monthly_id uuid NOT NULL REFERENCES public.salary_monthly(id),staff_id uuid NOT NULL REFERENCES auth.users(id),
 period_month date NOT NULL,generation integer NOT NULL CHECK(generation>0),
 gross numeric NOT NULL CHECK(gross>0),withheld numeric NOT NULL CHECK(withheld>=0),net numeric NOT NULL CHECK(net>=0),
 proof_hash text NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,id),UNIQUE(organization_id,source_id,item_id,salary_monthly_id,generation),
 FOREIGN KEY(organization_id,operation_id,source_id) REFERENCES app_private.rent_support_payout_results(organization_id,operation_id,source_id),
 CHECK(gross=withheld+net),CHECK(period_month=date_trunc('month',period_month)::date)
);
CREATE TABLE IF NOT EXISTS app_private.rent_support_salary_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,salary_monthly_id uuid NOT NULL REFERENCES public.salary_monthly(id),
 actor_id uuid NOT NULL,request_key text NOT NULL,intent_hash text NOT NULL,requested_cash numeric NOT NULL CHECK(requested_cash>0),
 salary_voucher_id uuid NOT NULL REFERENCES public.income_expenses(id),result jsonb NOT NULL,snapshot_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(organization_id,id),
 UNIQUE(organization_id,salary_monthly_id,actor_id,request_key),UNIQUE(organization_id,salary_voucher_id)
);
CREATE TABLE IF NOT EXISTS app_private.rent_support_salary_part_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_order bigint GENERATED ALWAYS AS IDENTITY,
 organization_id uuid NOT NULL,part_id uuid NOT NULL,action text NOT NULL CHECK(action IN('HELD','RELEASED','PAYMENT_PENDING','PAYMENT_POSTED','REVIEW_REQUIRED')),
 salary_payment_id uuid,actor_id uuid NOT NULL,request_key text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,part_id) REFERENCES app_private.rent_support_salary_parts(organization_id,id),
 FOREIGN KEY(organization_id,salary_payment_id) REFERENCES app_private.rent_support_salary_payments(organization_id,id),
 UNIQUE(organization_id,part_id,action,request_key)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['rent_support_salary_parts','rent_support_salary_payments','rent_support_salary_part_events'] LOOP
 EXECUTE format('ALTER TABLE app_private.%I OWNER TO postgres',t);
 EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC,anon,authenticated,service_role',t);
 EXECUTE format('DROP POLICY IF EXISTS %I ON app_private.%I',t||'_hide_sandbox_admin',t);
 EXECUTE format('CREATE POLICY %I ON app_private.%I AS RESTRICTIVE FOR ALL TO authenticated USING(NOT COALESCE(public.is_super_admin() AND organization_id=ANY(public.sandbox_org_ids()),false))',t||'_hide_sandbox_admin',t);
 EXECUTE format('DROP TRIGGER IF EXISTS immutable_snapshot ON app_private.%I',t);
 EXECUTE format('CREATE TRIGGER immutable_snapshot BEFORE UPDATE OR DELETE ON app_private.%I FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_immutable_v1()',t);
 EXECUTE format('DROP TRIGGER IF EXISTS immutable_truncate ON app_private.%I',t);
 EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON app_private.%I FOR EACH STATEMENT EXECUTE FUNCTION app_private.rent_support_immutable_v1()',t);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app_private.rent_support_salary_part_active_v1(p_org uuid,p_part uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE((SELECT e.action<>'RELEASED' FROM app_private.rent_support_salary_part_events e
 WHERE e.organization_id=p_org AND e.part_id=p_part ORDER BY e.event_order DESC LIMIT 1),false)
$$;

CREATE OR REPLACE FUNCTION app_private.rent_support_salary_source_state_v1(p_org uuid,p_source uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('locked',EXISTS(SELECT 1 FROM app_private.rent_support_salary_parts x WHERE x.organization_id=p_org AND x.source_id=p_source AND app_private.rent_support_salary_part_active_v1(p_org,x.id)),
 'review_required',EXISTS(SELECT 1 FROM app_private.rent_support_salary_parts x JOIN app_private.rent_support_salary_part_events e ON e.part_id=x.id AND e.organization_id=x.organization_id WHERE x.organization_id=p_org AND x.source_id=p_source AND e.action='REVIEW_REQUIRED'),
 'pending',EXISTS(SELECT 1 FROM app_private.rent_support_salary_parts x JOIN app_private.rent_support_salary_payments y ON y.organization_id=x.organization_id AND y.salary_monthly_id=x.salary_monthly_id JOIN public.income_expenses v ON v.id=y.salary_voucher_id AND v.organization_id=y.organization_id WHERE x.organization_id=p_org AND x.source_id=p_source AND v.deleted_at IS NULL AND v.approval_status<>'CANCELLED'),
 'posted',EXISTS(SELECT 1 FROM app_private.rent_support_salary_parts x JOIN app_private.rent_support_salary_payments y ON y.organization_id=x.organization_id AND y.salary_monthly_id=x.salary_monthly_id JOIN public.income_expense_postings p ON p.organization_id=y.organization_id AND p.voucher_id=y.salary_voucher_id WHERE x.organization_id=p_org AND x.source_id=p_source AND p.event_kind='POSTING' AND NOT EXISTS(SELECT 1 FROM public.income_expense_postings r WHERE r.reversal_of_id=p.id)))
$$;

-- Same ordering as Task6, deliberately separate from commission-create authorization.
CREATE OR REPLACE FUNCTION app_private.rent_support_salary_lock_v1(p_org uuid,p_contract uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s uuid;v uuid;BEGIN
 PERFORM app_private.lock_org_for_decision_v1(p_org);
 PERFORM 1 FROM public.contracts WHERE organization_id=p_org AND id=p_contract FOR UPDATE;
 PERFORM 1 FROM app_private.contract_rent_support_plans WHERE organization_id=p_org AND contract_id=p_contract ORDER BY revision FOR UPDATE;
 FOR s IN SELECT app_private.rent_support_source_id_v1(p_org,p_contract,k) FROM unnest(ARRAY['COMMISSION','BONUS']) k ORDER BY 1 LOOP
 PERFORM pg_advisory_xact_lock(hashtextextended('rent-support-source:'||p_org::text||':'||s::text,0));
 PERFORM 1 FROM app_private.rent_support_payout_sources WHERE organization_id=p_org AND id=s FOR UPDATE;END LOOP;
 PERFORM pg_advisory_xact_lock(hashtext('commission:'||p_contract::text||':broker'));
 PERFORM pg_advisory_xact_lock(hashtext('commission:'||p_contract::text||':sale'));
 FOR v IN SELECT id FROM public.income_expenses WHERE organization_id=p_org AND contract_id=p_contract ORDER BY id LOOP
 PERFORM 1 FROM public.income_expenses WHERE id=v FOR UPDATE;END LOOP;
END $$;

-- One known item is the exact part; never reconstruct gross parts from net or month counts.
CREATE OR REPLACE FUNCTION app_private.rent_support_salary_part_v1(p_org uuid,p_voucher uuid,p_period date,p_staff uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s app_private.rent_support_payout_sources;r app_private.rent_support_payout_results;v public.income_expenses;
 it public.income_expense_items;f jsonb;c jsonb;n integer;profile uuid;h text;
BEGIN
 SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher AND organization_id=p_org;
 SELECT x.* INTO s FROM app_private.rent_support_source_aliases a JOIN app_private.rent_support_payout_sources x ON x.organization_id=a.organization_id AND x.id=a.source_id
 WHERE a.organization_id=p_org AND a.alias_kind='VOUCHER' AND a.alias_id=p_voucher;
 IF s.id IS NULL THEN
  IF EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans WHERE organization_id=p_org AND contract_id=v.contract_id) THEN RAISE EXCEPTION 'LEGACY_REVIEW: nguồn chưa có bằng chứng' USING ERRCODE='PT409';END IF;
  RETURN NULL;
 END IF;
 IF s.kind<>'COMMISSION' THEN RAISE EXCEPTION 'SOURCE_KIND_REVIEW' USING ERRCODE='PT409';END IF;
 IF v.id IS NULL OR v.deleted_at IS NOT NULL OR v.approval_status='CANCELLED' THEN RAISE EXCEPTION 'SOURCE_CHANGED' USING ERRCODE='PT409';END IF;
 SELECT profile_id INTO profile FROM app_private.rent_support_parties WHERE organization_id=p_org AND id=s.party_id;
 IF profile IS NULL OR profile IS DISTINCT FROM p_staff THEN RAISE EXCEPTION 'PAYEE_MISMATCH' USING ERRCODE='PT409';END IF;
 SELECT * INTO r FROM app_private.rent_support_payout_results WHERE organization_id=p_org AND source_id=s.id;
 f:=app_private.rent_support_source_funding_evidence_v1(p_org,s.id);c:=app_private.rent_support_voucher_cash_v1(p_org,p_voucher);
 IF COALESCE((f->>'verified')::boolean,false) IS NOT TRUE OR r.voucher_id IS DISTINCT FROM p_voucher OR r.net IS DISTINCT FROM v.total_amount
 OR COALESCE((c->>'verified')::boolean,false) IS NOT TRUE OR (c->>'already_paid')::numeric<>0 THEN RAISE EXCEPTION 'PAYMENT_EVIDENCE_REVIEW' USING ERRCODE='PT409';END IF;
 IF EXISTS(SELECT 1 FROM public.salary_earning_consumptions WHERE organization_id=p_org AND source_id=p_voucher AND consumption_state<>'RELEASED') THEN RAISE EXCEPTION 'SALARY_ATTRIBUTION_REVIEW' USING ERRCODE='PT409';END IF;
 SELECT count(*) INTO n FROM public.income_expense_items WHERE income_expense_id=p_voucher;
 SELECT * INTO it FROM public.income_expense_items WHERE income_expense_id=p_voucher ORDER BY id LIMIT 1;
 IF n<>1 OR it.amount IS DISTINCT FROM r.net OR it.organization_id IS DISTINCT FROM p_org OR it.start_date IS NULL
 OR date_trunc('month',it.start_date)::date IS DISTINCT FROM p_period THEN RAISE EXCEPTION 'PART_ATTRIBUTION_REVIEW' USING ERRCODE='PT409';END IF;
 h:=md5(jsonb_build_object('source',to_jsonb(s),'result',to_jsonb(r),'funding',f,'item',to_jsonb(it),'staff',p_staff,'period',p_period)::text);
 RETURN jsonb_build_object('source_id',s.id,'operation_id',r.operation_id,'party_id',s.party_id,'voucher_id',p_voucher,
 'item_id',it.id,'period_month',p_period,'gross',trim_scale(r.gross)::text,'withheld',trim_scale(r.withheld)::text,'net',trim_scale(r.net)::text,'proof_hash',h);
END $$;


CREATE OR REPLACE FUNCTION app_private.rent_support_salary_has_source_v1(p_org uuid,p_staff uuid,p_period date)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM app_private.commission_manager_links l JOIN public.income_expenses v ON v.id=l.voucher_id AND v.organization_id=l.organization_id
 JOIN app_private.contract_rent_support_plans p ON p.contract_id=v.contract_id AND p.organization_id=v.organization_id
 JOIN public.income_expense_items i ON i.income_expense_id=v.id
 WHERE l.organization_id=p_org AND l.manager_id=p_staff AND v.deleted_at IS NULL AND v.approval_status<>'CANCELLED' AND (p_period IS NULL OR date_trunc('month',i.start_date)::date=p_period))
 OR EXISTS(SELECT 1 FROM app_private.rent_support_salary_parts x WHERE x.organization_id=p_org AND x.staff_id=p_staff AND (p_period IS NULL OR x.period_month=p_period) AND app_private.rent_support_salary_part_active_v1(p_org,x.id))
$$;
CREATE TABLE IF NOT EXISTS app_private.rent_support_salary_authorizations(
 organization_id uuid NOT NULL,staff_id uuid NOT NULL,salary_monthly_id uuid NOT NULL,action text NOT NULL CHECK(action IN('PAYOUT','UNLOCK')),
 amount numeric,xid xid8 NOT NULL,backend_pid integer NOT NULL,PRIMARY KEY(organization_id,staff_id,action,xid,backend_pid)
);
ALTER TABLE app_private.rent_support_salary_authorizations OWNER TO postgres;
ALTER TABLE app_private.rent_support_salary_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.rent_support_salary_authorizations FROM PUBLIC,anon,authenticated,service_role;
DROP POLICY IF EXISTS rent_support_salary_authorizations_hide_sandbox_admin ON app_private.rent_support_salary_authorizations;
CREATE POLICY rent_support_salary_authorizations_hide_sandbox_admin ON app_private.rent_support_salary_authorizations AS RESTRICTIVE FOR ALL TO authenticated USING(NOT COALESCE(public.is_super_admin() AND organization_id=ANY(public.sandbox_org_ids()),false));
CREATE OR REPLACE FUNCTION app_private.rent_support_salary_guard_v1() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_NAME='salary_monthly' THEN
 IF EXISTS(SELECT 1 FROM app_private.rent_support_salary_parts x WHERE x.organization_id=OLD.organization_id AND x.salary_monthly_id=OLD.id AND app_private.rent_support_salary_part_active_v1(OLD.organization_id,x.id)) THEN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SALARY_SNAPSHOT_IMMUTABLE' USING ERRCODE='PT409';END IF;
 IF NEW.take_home IS DISTINCT FROM OLD.take_home OR NEW.commission_total IS DISTINCT FROM OLD.commission_total OR NEW.staff_id IS DISTINCT FROM OLD.staff_id OR NEW.period_month IS DISTINCT FROM OLD.period_month OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN RAISE EXCEPTION 'SALARY_SNAPSHOT_IMMUTABLE' USING ERRCODE='PT409';END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS(SELECT 1 FROM app_private.rent_support_salary_authorizations a WHERE a.organization_id=OLD.organization_id AND a.salary_monthly_id=OLD.id AND a.action='UNLOCK' AND a.xid=pg_current_xact_id() AND a.backend_pid=pg_backend_pid()) THEN RAISE EXCEPTION 'SALARY_UNLOCK_REQUIRED' USING ERRCODE='PT409';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN
 IF EXISTS(SELECT 1 FROM app_private.rent_support_salary_payments p WHERE p.organization_id=OLD.organization_id AND p.salary_voucher_id=OLD.id)
 AND ROW(NEW.organization_id,NEW.salary_staff_id,NEW.total_amount,NEW.type) IS DISTINCT FROM ROW(OLD.organization_id,OLD.salary_staff_id,OLD.total_amount,OLD.type) THEN RAISE EXCEPTION 'SALARY_PAYMENT_IMMUTABLE' USING ERRCODE='PT409';END IF;
 IF NEW.salary_staff_id IS NOT DISTINCT FROM OLD.salary_staff_id AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN RETURN NEW;END IF;
 END IF;
 IF NEW.salary_staff_id IS NOT NULL AND app_private.rent_support_salary_has_source_v1(NEW.organization_id,NEW.salary_staff_id,NULL)
 AND NOT EXISTS(SELECT 1 FROM app_private.rent_support_salary_authorizations a WHERE a.organization_id=NEW.organization_id AND a.staff_id=NEW.salary_staff_id AND a.action='PAYOUT' AND a.xid=pg_current_xact_id() AND a.backend_pid=pg_backend_pid()) THEN RAISE EXCEPTION 'SALARY_CANONICAL_PART_REQUIRED' USING ERRCODE='PT409';END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rent_support_salary_snapshot_guard ON public.salary_monthly;
CREATE TRIGGER rent_support_salary_snapshot_guard BEFORE UPDATE OR DELETE ON public.salary_monthly FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_salary_guard_v1();
DROP TRIGGER IF EXISTS rent_support_salary_insert_guard ON public.income_expenses;
CREATE TRIGGER rent_support_salary_insert_guard BEFORE INSERT OR UPDATE ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_salary_guard_v1();

-- Move current entry points behind v2-only bridges once; never expose the delegates.
DO $$ DECLARE row text[];BEGIN
 FOREACH row SLICE 1 IN ARRAY ARRAY[
 ARRAY['public.assign_commission_manager_v1(uuid,uuid,bigint,text)','rent_support_salary_assign_before_v1'],
 ARRAY['public.lock_salary_month_v2(date,jsonb,text)','rent_support_salary_lock_before_v2'],
 ARRAY['public.unlock_salary_month_v2(date,uuid[],text)','rent_support_salary_unlock_before_v2'],
 ARRAY['public.salary_payout_v1(uuid,date,numeric,uuid,date,text,text,uuid,numeric)','rent_support_salary_payout_before_v1']
 ] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app_private' AND p.proname=row[2]) THEN
 EXECUTE format('ALTER FUNCTION %s SET SCHEMA app_private',row[1]);
 EXECUTE format('ALTER FUNCTION app_private.%s RENAME TO %I',substring(row[1] from 8),row[2]);
 END IF;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.assign_commission_manager_v1(p_voucher_id uuid,p_manager_id uuid,p_expected_approval_version bigint,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v public.income_expenses;r jsonb;f jsonb;BEGIN
 SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher_id;
 IF EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans WHERE organization_id=v.organization_id AND contract_id=v.contract_id) THEN
 IF auth.uid() IS NULL OR NOT COALESCE(v.organization_id=ANY(public.my_org_ids()),false) OR NOT app_private.ie_supplement_can_read_v1(v.id) OR NOT public.can_access_building(v.building_id) THEN RAISE EXCEPTION 'Không có quyền nguồn lương' USING ERRCODE='42501';END IF;
 PERFORM app_private.rent_support_salary_lock_v1(v.organization_id,v.contract_id);
 SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher_id;
 f:=app_private.rent_support_salary_part_v1(v.organization_id,v.id,(SELECT date_trunc('month',start_date)::date FROM public.income_expense_items WHERE income_expense_id=v.id ORDER BY id LIMIT 1),p_manager_id);
 IF COALESCE((app_private.rent_support_salary_source_state_v1(v.organization_id,(f->>'source_id')::uuid)->>'locked')::boolean,false)
 OR EXISTS(SELECT 1 FROM app_private.salary_commission_inclusions WHERE organization_id=v.organization_id AND voucher_id=v.id) THEN RAISE EXCEPTION 'SALARY_SOURCE_LOCKED' USING ERRCODE='PT409';END IF;
 END IF;
 r:=app_private.rent_support_salary_assign_before_v1(p_voucher_id,p_manager_id,p_expected_approval_version,p_idempotency_key);
 IF f IS NOT NULL THEN
 PERFORM app_private.rent_support_link_source_alias_v1(v.organization_id,(f->>'source_id')::uuid,'MANAGER_COMMISSION',v.id,'');
 r:=r||jsonb_build_object('support',jsonb_build_object('source_id',f->>'source_id','gross',f->>'gross','withheld',f->>'withheld','net',f->>'net'));END IF;
 RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.lock_salary_month_v2(p_period_month date,p_managers jsonb,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid;ct uuid;m jsonb;f jsonb;allfacts jsonb:='[]';vid uuid;staff uuid;v public.income_expenses;sm public.salary_monthly;
 r jsonb;part uuid;amt numeric;gross numeric;other numeric;has_support boolean;
BEGIN
 org:=app_private.salary_staff_org_v1((p_managers->0->>'staff_id')::uuid);
 PERFORM app_private.lock_org_for_decision_v1(org);
 FOR ct IN SELECT DISTINCT ev.contract_id FROM public.income_expenses ev JOIN app_private.contract_rent_support_plans p ON p.organization_id=ev.organization_id AND p.contract_id=ev.contract_id
 WHERE ev.organization_id=org AND (ev.id IN(SELECT x.value::uuid FROM jsonb_array_elements(p_managers) z CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(z->'commission_voucher_ids','[]')) x)
 OR EXISTS(SELECT 1 FROM app_private.commission_manager_links l WHERE l.voucher_id=ev.id AND l.manager_id IN(SELECT (value->>'staff_id')::uuid FROM jsonb_array_elements(p_managers)))) ORDER BY 1 LOOP
 PERFORM app_private.rent_support_salary_lock_v1(org,ct);END LOOP;
 FOR m IN SELECT value FROM jsonb_array_elements(p_managers) LOOP
 staff:=(m->>'staff_id')::uuid;amt:=0;has_support:=false;
 -- Discover linked sources too: omitting their IDs cannot bypass the bridge.
 IF EXISTS(SELECT 1 FROM app_private.commission_manager_links l JOIN public.income_expenses e ON e.id=l.voucher_id
 JOIN app_private.rent_support_source_aliases a ON a.alias_id=e.id AND a.alias_kind='VOUCHER' AND a.organization_id=org
 JOIN public.income_expense_items i ON i.income_expense_id=e.id
 WHERE l.organization_id=org AND l.manager_id=staff AND date_trunc('month',i.start_date)::date=p_period_month
 AND e.deleted_at IS NULL AND e.approval_status<>'CANCELLED' AND NOT COALESCE(m->'commission_voucher_ids','[]') ? e.id::text)
 THEN RAISE EXCEPTION 'SALARY_SOURCE_MISSING' USING ERRCODE='PT409';END IF;
 FOR vid IN SELECT DISTINCT value::uuid FROM jsonb_array_elements_text(COALESCE(m->'commission_voucher_ids','[]')) LOOP
 SELECT * INTO v FROM public.income_expenses WHERE id=vid AND organization_id=org;
 f:=app_private.rent_support_salary_part_v1(org,vid,p_period_month,staff);
 SELECT amt+COALESCE(sum(i.amount),0) INTO amt FROM public.income_expense_items i WHERE i.income_expense_id=vid AND date_trunc('month',i.start_date)::date=p_period_month;
 IF f IS NOT NULL THEN
 has_support:=true;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(m->'support_parts','[]')) x WHERE x->>'source_id'=f->>'source_id' AND x->>'item_id'=f->>'item_id' AND x->>'proof_hash'=f->>'proof_hash')
 OR NOT EXISTS(SELECT 1 FROM app_private.commission_manager_links WHERE organization_id=org AND voucher_id=vid AND manager_id=staff)
 OR NOT EXISTS(SELECT 1 FROM app_private.salary_commission_books WHERE organization_id=org AND account_id=v.account_id)
 THEN RAISE EXCEPTION 'SALARY_SOURCE_CHANGED' USING ERRCODE='PT409';END IF;
 SELECT * INTO sm FROM public.salary_monthly WHERE organization_id=org AND staff_id=staff AND period_month=p_period_month FOR UPDATE;
 IF sm.status='LOCKED' THEN
 IF NOT EXISTS(SELECT 1 FROM app_private.rent_support_salary_parts x WHERE x.organization_id=org AND x.salary_monthly_id=sm.id AND x.source_id=(f->>'source_id')::uuid AND x.proof_hash=f->>'proof_hash' AND app_private.rent_support_salary_part_active_v1(org,x.id)) THEN RAISE EXCEPTION 'SALARY_PERIOD_LOCKED' USING ERRCODE='PT409';END IF;
 ELSE
 IF (app_private.rent_support_salary_source_state_v1(org,(f->>'source_id')::uuid)->>'locked')::boolean THEN RAISE EXCEPTION 'SALARY_SOURCE_LOCKED' USING ERRCODE='PT409';END IF;
 END IF;
 allfacts:=allfacts||jsonb_build_array(f||jsonb_build_object('staff_id',staff));
 END IF;END LOOP;
 IF has_support THEN
 gross:=COALESCE((m->>'base_salary')::numeric,0)+COALESCE((m->>'work_bonus')::numeric,0)+COALESCE((m->>'contract_bonus')::numeric,0)+amt+COALESCE((m->>'investment_profit')::numeric,0)+COALESCE((m->>'adjustments_total')::numeric,0);
 SELECT COALESCE(sum(i.amount),0) INTO other FROM public.income_expenses e JOIN public.income_expense_items i ON i.income_expense_id=e.id
 WHERE e.id IN(SELECT value::uuid FROM jsonb_array_elements_text(m->'commission_voucher_ids')) AND date_trunc('month',i.start_date)::date=p_period_month
 AND NOT EXISTS(SELECT 1 FROM app_private.salary_commission_books b WHERE b.organization_id=org AND b.account_id=e.account_id);
 IF (m->>'commission_total')::numeric IS DISTINCT FROM amt OR (m->>'gross_total')::numeric IS DISTINCT FROM gross
 OR (m->>'take_home')::numeric IS DISTINCT FROM gross-COALESCE((m->>'advances_total')::numeric,0)-COALESCE((m->>'room_rent')::numeric,0)-other THEN RAISE EXCEPTION 'SALARY_TOTAL_CHANGED' USING ERRCODE='PT409';END IF;
 END IF;
 END LOOP;
 r:=app_private.rent_support_salary_lock_before_v2(p_period_month,p_managers,p_idempotency_key);
 FOR f IN SELECT value FROM jsonb_array_elements(allfacts) LOOP
 SELECT * INTO sm FROM public.salary_monthly WHERE organization_id=org AND staff_id=(f->>'staff_id')::uuid AND period_month=p_period_month AND status='LOCKED';
 IF sm.id IS NULL THEN RAISE EXCEPTION 'SALARY_SNAPSHOT_MISSING' USING ERRCODE='PT409';END IF;
 SELECT x.id INTO part FROM app_private.rent_support_salary_parts x WHERE x.organization_id=org AND x.source_id=(f->>'source_id')::uuid AND app_private.rent_support_salary_part_active_v1(org,x.id);
 IF part IS NULL THEN
 INSERT INTO app_private.rent_support_salary_parts(organization_id,source_id,operation_id,voucher_id,item_id,salary_monthly_id,staff_id,period_month,generation,gross,withheld,net,proof_hash,created_by)
 VALUES(org,(f->>'source_id')::uuid,(f->>'operation_id')::uuid,(f->>'voucher_id')::uuid,(f->>'item_id')::uuid,sm.id,sm.staff_id,p_period_month,
 (SELECT COALESCE(max(generation),0)+1 FROM app_private.rent_support_salary_parts WHERE organization_id=org AND source_id=(f->>'source_id')::uuid),
 (f->>'gross')::numeric,(f->>'withheld')::numeric,(f->>'net')::numeric,f->>'proof_hash',auth.uid()) RETURNING id INTO part;
 INSERT INTO app_private.rent_support_salary_part_events(organization_id,part_id,action,actor_id,request_key,reason) VALUES(org,part,'HELD',auth.uid(),p_idempotency_key,'Locked exact source part');END IF;
 PERFORM app_private.rent_support_link_source_alias_v1(org,(f->>'source_id')::uuid,'SALARY_INCLUSION',(f->>'voucher_id')::uuid,to_char(p_period_month,'YYYY-MM'));
 END LOOP;RETURN r;
END $$;

CREATE OR REPLACE FUNCTION app_private.rent_support_salary_liability_v1(p_org uuid,p_monthly uuid)
RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE x app_private.rent_support_salary_payments;v public.income_expenses;c jsonb;total numeric:=0;sm public.salary_monthly;BEGIN
 SELECT * INTO sm FROM public.salary_monthly WHERE organization_id=p_org AND id=p_monthly;
 IF EXISTS(SELECT 1 FROM app_private.canonical_write_operations o WHERE o.organization_id=p_org AND o.operation='salary.payout.v1' AND o.subject_scope=sm.staff_id::text||'|'||sm.period_month::text AND o.completed_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_private.rent_support_salary_payments history WHERE history.organization_id=p_org AND history.salary_monthly_id=p_monthly AND history.salary_voucher_id=(o.response_payload->>'salary_voucher_id')::uuid)) THEN RAISE EXCEPTION 'SALARY_PAYMENT_HISTORY_REVIEW' USING ERRCODE='PT409';END IF;
 IF sm.payout_voucher_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_private.rent_support_salary_payments WHERE organization_id=p_org AND salary_monthly_id=p_monthly AND salary_voucher_id=sm.payout_voucher_id)
 THEN RAISE EXCEPTION 'SALARY_PAYMENT_HISTORY_REVIEW' USING ERRCODE='PT409';END IF;
 FOR x IN SELECT * FROM app_private.rent_support_salary_payments WHERE organization_id=p_org AND salary_monthly_id=p_monthly LOOP
 SELECT * INTO v FROM public.income_expenses WHERE organization_id=p_org AND id=x.salary_voucher_id;
 c:=app_private.rent_support_voucher_cash_v1(p_org,x.salary_voucher_id);
 IF v.id IS NULL OR v.salary_staff_id IS DISTINCT FROM sm.staff_id OR COALESCE((c->>'verified')::boolean,false) IS NOT TRUE OR (c->>'already_paid')::numeric>x.requested_cash
 THEN RAISE EXCEPTION 'SALARY_PAYMENT_HISTORY_REVIEW' USING ERRCODE='PT409';END IF;
 -- Cash and its pending representation are mutually exclusive buckets.
 IF (c->>'already_paid')::numeric>0 THEN total:=total+x.requested_cash;
 ELSIF v.deleted_at IS NULL AND v.approval_status<>'CANCELLED' THEN total:=total+x.requested_cash;
 ELSE
 -- Cancellation/reversal does not silently release a payroll source.
 RAISE EXCEPTION 'SALARY_REVERSAL_REVIEW' USING ERRCODE='PT409';
 END IF;
 END LOOP;RETURN total;
END $$;

CREATE OR REPLACE FUNCTION public.salary_payout_v1(p_staff_id uuid,p_period_month date,p_take_home numeric,p_account_id uuid,p_voucher_date date,p_note text,p_idempotency_key text,p_rent_invoice_id uuid DEFAULT NULL,p_rent_amount numeric DEFAULT NULL)
RETURNS json LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid;sm public.salary_monthly;ct uuid;r json;h text;old app_private.rent_support_salary_payments;payment uuid;part record;
BEGIN
 org:=app_private.salary_staff_org_v1(p_staff_id);PERFORM app_private.lock_org_for_decision_v1(org);
 FOR ct IN SELECT DISTINCT s.contract_id FROM app_private.rent_support_salary_parts x JOIN app_private.rent_support_payout_sources s ON s.organization_id=x.organization_id AND s.id=x.source_id WHERE x.organization_id=org AND x.staff_id=p_staff_id AND x.period_month=p_period_month ORDER BY 1 LOOP PERFORM app_private.rent_support_salary_lock_v1(org,ct);END LOOP;
 SELECT * INTO sm FROM public.salary_monthly WHERE organization_id=org AND staff_id=p_staff_id AND period_month=p_period_month FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM app_private.rent_support_salary_parts WHERE organization_id=org AND salary_monthly_id=sm.id) THEN
 IF app_private.rent_support_salary_has_source_v1(org,p_staff_id,p_period_month) THEN RAISE EXCEPTION 'SALARY_PART_MAP_REQUIRED' USING ERRCODE='PT409';END IF;
 RETURN app_private.rent_support_salary_payout_before_v1(p_staff_id,p_period_month,p_take_home,p_account_id,p_voucher_date,p_note,p_idempotency_key,p_rent_invoice_id,p_rent_amount);
 END IF;
 IF auth.uid() IS NULL OR NOT COALESCE(org=ANY(public.my_org_ids()),false) THEN RAISE EXCEPTION 'Không có quyền tổ chức' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.buildings b CROSS JOIN LATERAL app_private.authorize_tenant_action_v3(auth.uid(),org,'salary.distribute',b.id,p_account_id) a WHERE b.id=(SELECT id FROM public.buildings WHERE organization_id=org AND is_virtual AND deleted_at IS NULL ORDER BY created_at LIMIT 1) AND a.allowed) THEN RAISE EXCEPTION 'Không có quyền chi lương' USING ERRCODE='42501';END IF;
 h:=md5(jsonb_build_object('staff',p_staff_id,'period',p_period_month,'amount',p_take_home,'account',p_account_id,'date',p_voucher_date,'note',p_note,'rent_invoice',p_rent_invoice_id,'rent_amount',p_rent_amount)::text);
 SELECT * INTO old FROM app_private.rent_support_salary_payments WHERE organization_id=org AND salary_monthly_id=sm.id AND actor_id=auth.uid() AND request_key=p_idempotency_key;
 IF old.id IS NOT NULL THEN IF old.intent_hash<>h THEN RAISE EXCEPTION 'SALARY_REQUEST_CHANGED' USING ERRCODE='PT409';END IF;RETURN old.result::json;END IF;
 IF sm.status<>'LOCKED' OR p_take_home IS NULL OR p_take_home<=0 OR p_take_home::text IN('NaN','Infinity','-Infinity') OR p_take_home+app_private.rent_support_salary_liability_v1(org,sm.id)>sm.take_home THEN RAISE EXCEPTION 'SALARY_CASH_CAP' USING ERRCODE='PT409';END IF;
 IF p_rent_invoice_id IS NOT NULL OR COALESCE(p_rent_amount,0)>0 THEN RAISE EXCEPTION 'SALARY_OFFSET_ATTRIBUTION_REVIEW' USING ERRCODE='PT409';END IF;
 FOR part IN SELECT * FROM app_private.rent_support_salary_parts WHERE organization_id=org AND salary_monthly_id=sm.id AND app_private.rent_support_salary_part_active_v1(org,id) LOOP
 IF NOT app_private.rent_support_salary_part_active_v1(org,part.id) THEN RAISE EXCEPTION 'SALARY_SOURCE_RELEASED' USING ERRCODE='PT409';END IF;
 IF (app_private.rent_support_salary_part_v1(org,part.voucher_id,p_period_month,p_staff_id)->>'proof_hash') IS DISTINCT FROM part.proof_hash THEN RAISE EXCEPTION 'SALARY_PART_CHANGED' USING ERRCODE='PT409';END IF;
 END LOOP;
 INSERT INTO app_private.rent_support_salary_authorizations VALUES(org,p_staff_id,sm.id,'PAYOUT',p_take_home,pg_current_xact_id(),pg_backend_pid());
 r:=app_private.rent_support_salary_payout_before_v1(p_staff_id,p_period_month,p_take_home,p_account_id,p_voucher_date,p_note,p_idempotency_key,p_rent_invoice_id,p_rent_amount);
 DELETE FROM app_private.rent_support_salary_authorizations WHERE organization_id=org AND staff_id=p_staff_id AND action='PAYOUT' AND xid=pg_current_xact_id() AND backend_pid=pg_backend_pid();
 INSERT INTO app_private.rent_support_salary_payments(organization_id,salary_monthly_id,actor_id,request_key,intent_hash,requested_cash,salary_voucher_id,result,snapshot_hash)
 VALUES(org,sm.id,auth.uid(),p_idempotency_key,h,p_take_home,(r->>'salary_voucher_id')::uuid,r::jsonb,md5(to_jsonb(sm)::text)) RETURNING id INTO payment;
 INSERT INTO app_private.rent_support_salary_part_events(organization_id,part_id,action,salary_payment_id,actor_id,request_key,reason)
 SELECT org,id,'PAYMENT_PENDING',payment,auth.uid(),p_idempotency_key,'Salary cash reserved; no per-source partial attribution' FROM app_private.rent_support_salary_parts WHERE organization_id=org AND salary_monthly_id=sm.id AND app_private.rent_support_salary_part_active_v1(org,id);
 RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.unlock_salary_month_v2(p_period_month date,p_staff_ids uuid[],p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE org uuid;ct uuid;sm record;r jsonb;BEGIN
 org:=app_private.salary_staff_org_v1(p_staff_ids[1]);PERFORM app_private.lock_org_for_decision_v1(org);
 FOR ct IN SELECT DISTINCT s.contract_id FROM app_private.rent_support_salary_parts x JOIN app_private.rent_support_payout_sources s ON s.organization_id=x.organization_id AND s.id=x.source_id WHERE x.organization_id=org AND x.staff_id=ANY(p_staff_ids) AND x.period_month=p_period_month ORDER BY 1 LOOP PERFORM app_private.rent_support_salary_lock_v1(org,ct);END LOOP;
 FOR sm IN SELECT m.* FROM public.salary_monthly m WHERE m.organization_id=org AND m.staff_id=ANY(p_staff_ids) AND m.period_month=p_period_month AND EXISTS(SELECT 1 FROM app_private.rent_support_salary_parts x WHERE x.organization_id=org AND x.salary_monthly_id=m.id) FOR UPDATE LOOP
 IF EXISTS(SELECT 1 FROM app_private.rent_support_salary_parts x WHERE x.organization_id=org AND x.salary_monthly_id=sm.id AND (app_private.rent_support_salary_source_state_v1(org,x.source_id)->>'review_required')::boolean) THEN RAISE EXCEPTION 'SALARY_REVIEW_REQUIRED' USING ERRCODE='PT409';END IF;
 IF app_private.rent_support_salary_liability_v1(org,sm.id)>0 THEN RAISE EXCEPTION 'SALARY_PAYMENT_LOCKED' USING ERRCODE='PT409';END IF;
 END LOOP;
 INSERT INTO app_private.rent_support_salary_authorizations SELECT org,m.staff_id,m.id,'UNLOCK',NULL,pg_current_xact_id(),pg_backend_pid() FROM public.salary_monthly m WHERE m.organization_id=org AND m.staff_id=ANY(p_staff_ids) AND m.period_month=p_period_month;
 r:=app_private.rent_support_salary_unlock_before_v2(p_period_month,p_staff_ids,p_idempotency_key);
 DELETE FROM app_private.rent_support_salary_authorizations WHERE organization_id=org AND staff_id=ANY(p_staff_ids) AND action='UNLOCK' AND xid=pg_current_xact_id() AND backend_pid=pg_backend_pid();
 INSERT INTO app_private.rent_support_salary_part_events(organization_id,part_id,action,actor_id,request_key,reason)
 SELECT org,x.id,'RELEASED',auth.uid(),p_idempotency_key,'Unlocked unpaid source part; support withholding unchanged'
 FROM app_private.rent_support_salary_parts x JOIN public.salary_monthly m ON m.id=x.salary_monthly_id AND m.organization_id=x.organization_id
 WHERE x.organization_id=org AND x.staff_id=ANY(p_staff_ids) AND x.period_month=p_period_month AND m.status<>'LOCKED' AND app_private.rent_support_salary_part_active_v1(org,x.id);
 RETURN r;
END $$;

DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app_private' AND p.proname LIKE 'rent_support_salary_%' LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f.signature);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);END LOOP;
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN('assign_commission_manager_v1','lock_salary_month_v2','unlock_salary_month_v2','salary_payout_v1') LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f.signature);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,service_role',f.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f.signature);END LOOP;
END $$;

-- Explicit payee verification: identity evidence only, never a source or spend.
CREATE TABLE IF NOT EXISTS app_private.rent_support_deposit_payee_bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,contract_id uuid NOT NULL,
 source_id uuid NOT NULL,claim_id uuid NOT NULL REFERENCES app_private.sale_bonus_claims(id),
 deposit_voucher_id uuid NOT NULL REFERENCES public.income_expenses(id),bonus_voucher_id uuid NOT NULL REFERENCES public.income_expenses(id),
 party_id uuid NOT NULL,approval_version bigint NOT NULL,posting_version bigint NOT NULL,proof_hash text NOT NULL,
 actor_id uuid NOT NULL,request_id uuid NOT NULL,intent_hash text NOT NULL,reason text NOT NULL,
 status text NOT NULL DEFAULT 'MANUALLY_VERIFIED' CHECK(status='MANUALLY_VERIFIED'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,claim_id),UNIQUE(organization_id,source_id),UNIQUE(organization_id,actor_id,request_id),
 FOREIGN KEY(organization_id,party_id) REFERENCES app_private.rent_support_parties(organization_id,id)
);
CREATE TABLE IF NOT EXISTS app_private.rent_support_deposit_adoptions (
 organization_id uuid NOT NULL,operation_id uuid NOT NULL,source_id uuid NOT NULL,
 claim_id uuid NOT NULL,deposit_voucher_id uuid NOT NULL,original_bonus_voucher_id uuid NOT NULL,
 original_item_ids uuid[] NOT NULL,original_gross numeric NOT NULL,before_approval_version bigint NOT NULL,before_posting_version bigint NOT NULL,
 before_facts_hash text NOT NULL,after_facts_hash text NOT NULL,canonical_result jsonb NOT NULL,
 actor_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,source_id),UNIQUE(organization_id,claim_id),
 FOREIGN KEY(organization_id,operation_id,source_id) REFERENCES app_private.rent_support_payout_results(organization_id,operation_id,source_id) DEFERRABLE INITIALLY DEFERRED
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['rent_support_deposit_payee_bindings','rent_support_deposit_adoptions'] LOOP
 EXECUTE format('ALTER TABLE app_private.%I OWNER TO postgres',t);EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC,anon,authenticated,service_role',t);
 EXECUTE format('DROP POLICY IF EXISTS %I ON app_private.%I',t||'_hide_sandbox_admin',t);
 EXECUTE format('CREATE POLICY %I ON app_private.%I AS RESTRICTIVE FOR ALL TO authenticated USING(NOT COALESCE(public.is_super_admin() AND organization_id=ANY(public.sandbox_org_ids()),false))',t||'_hide_sandbox_admin',t);
 EXECUTE format('DROP TRIGGER IF EXISTS immutable_snapshot ON app_private.%I',t);
 EXECUTE format('CREATE TRIGGER immutable_snapshot BEFORE UPDATE OR DELETE ON app_private.%I FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_immutable_v1()',t);
 EXECUTE format('DROP TRIGGER IF EXISTS immutable_truncate ON app_private.%I',t);
 EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON app_private.%I FOR EACH STATEMENT EXECUTE FUNCTION app_private.rent_support_immutable_v1()',t);END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app_private.rent_support_deposit_facts_v1(p_org uuid,p_contract uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c app_private.sale_bonus_claims;v public.income_expenses;d public.income_expenses;items jsonb;n integer;cash jsonb;h text;sid uuid;
BEGIN
 SELECT count(*) INTO n FROM app_private.sale_bonus_claims x JOIN public.income_expenses dep ON dep.id=x.deposit_voucher_id AND dep.organization_id=x.organization_id
 JOIN public.income_expenses bon ON bon.id=x.bonus_voucher_id AND bon.organization_id=x.organization_id
 WHERE x.organization_id=p_org AND dep.contract_id=p_contract AND bon.deleted_at IS NULL AND bon.approval_status<>'CANCELLED';
 IF n=0 THEN RETURN jsonb_build_object('issue','NO_CANDIDATE');END IF;
 IF n<>1 THEN RETURN jsonb_build_object('issue','AMBIGUOUS_DEPOSIT_CLAIM');END IF;
 SELECT x.* INTO c FROM app_private.sale_bonus_claims x JOIN public.income_expenses dep ON dep.id=x.deposit_voucher_id AND dep.organization_id=x.organization_id
 JOIN public.income_expenses bon ON bon.id=x.bonus_voucher_id AND bon.organization_id=x.organization_id
 WHERE x.organization_id=p_org AND dep.contract_id=p_contract AND bon.deleted_at IS NULL AND bon.approval_status<>'CANCELLED';
 SELECT * INTO v FROM public.income_expenses WHERE id=c.bonus_voucher_id AND organization_id=p_org;
 SELECT * INTO d FROM public.income_expenses WHERE id=c.deposit_voucher_id AND organization_id=p_org;
 IF NOT app_private.ie_supplement_can_read_v1(v.id) OR NOT app_private.ie_supplement_can_read_v1(d.id) THEN RAISE EXCEPTION 'Không có quyền đọc nguồn thưởng cọc' USING ERRCODE='42501';END IF;
 IF v.type<>'EXPENSE' OR v.commission_kind<>'sale' OR d.type<>'INCOME' OR d.deleted_at IS NOT NULL OR d.approval_status='CANCELLED'
 OR (v.contract_id IS NOT NULL AND v.contract_id<>p_contract) OR (c.contract_id IS NOT NULL AND c.contract_id<>p_contract)
 THEN RETURN jsonb_build_object('issue','DEPOSIT_LINKAGE_REVIEW');END IF;
 cash:=app_private.rent_support_voucher_cash_v1(p_org,v.id);
 IF COALESCE((cash->>'verified')::boolean,false) IS NOT TRUE THEN RETURN jsonb_build_object('issue','PAYMENT_EVIDENCE_REVIEW');END IF;
 SELECT count(*),jsonb_agg(to_jsonb(i) ORDER BY i.id) INTO n,items FROM public.income_expense_items i WHERE i.income_expense_id=v.id;
 IF n<>1 OR (items->0->>'amount')::numeric IS DISTINCT FROM c.amount OR v.total_amount IS DISTINCT FROM c.amount OR c.amount<=0 THEN RETURN jsonb_build_object('issue','DEPOSIT_GROSS_REVIEW');END IF;
 sid:=app_private.rent_support_source_id_v1(p_org,p_contract,'BONUS');
 h:=md5(jsonb_build_object('claim',to_jsonb(c),'deposit',to_jsonb(d),'voucher',to_jsonb(v),'items',items,'cash',cash)::text);
 IF (cash->>'already_paid')::numeric>0 THEN
 IF (cash->>'already_paid')::numeric=c.amount THEN RETURN jsonb_build_object('issue','DEPOSIT_ALREADY_PAID','already_paid',cash->>'already_paid','source_id',sid,'gross',trim_scale(c.amount)::text,'proof_hash',h);END IF;
 RETURN jsonb_build_object('issue','PARTIAL_PAYMENT_REVIEW');END IF;
 IF EXISTS(SELECT 1 FROM app_private.rent_support_payout_results WHERE organization_id=p_org AND source_id=sid)
 OR EXISTS(SELECT 1 FROM app_private.rent_support_payout_sources WHERE organization_id=p_org AND id=sid)
 THEN RETURN jsonb_build_object('issue','SOURCE_ALREADY_ISSUED');END IF;
 IF v.approval_status<>'UNAPPROVED' OR COALESCE(v.posting_status,'UNPOSTED')='POSTED' OR v.active_posting_id_v2 IS NOT NULL
 OR EXISTS(SELECT 1 FROM app_private.commission_manager_links WHERE organization_id=p_org AND voucher_id=v.id)
 OR EXISTS(SELECT 1 FROM app_private.salary_commission_inclusions WHERE organization_id=p_org AND voucher_id=v.id)
 OR EXISTS(SELECT 1 FROM public.salary_earning_consumptions WHERE organization_id=p_org AND source_id=v.id AND consumption_state<>'RELEASED')
 OR (v.account_id IS NOT NULL AND NOT app_private.finance_v2_is_cashbook_period_open(p_org,v.account_id,v.voucher_date))
 THEN RETURN jsonb_build_object('issue','DEPOSIT_NOT_MUTABLE');END IF;
 RETURN jsonb_build_object('issue',NULL,'source_id',sid,'claim_id',c.id,'deposit_voucher_id',d.id,'bonus_voucher_id',v.id,
 'item_ids',jsonb_build_array(items->0->>'id'),'approval_version',v.approval_version,'posting_version',COALESCE(v.posting_version,0),
 'gross',trim_scale(c.amount)::text,'current_net',trim_scale(v.total_amount)::text,'already_paid','0','proof_hash',h,
 'voucher_date',v.voucher_date,'account_id',v.account_id,'payer_name',v.payer_name,'recipient_bank',v.receive_bank_name,'recipient_account',v.receive_bank_account,
 'item_description',items->0->>'description','attachments',COALESCE(v.attachments,'[]'));
END $$;

CREATE OR REPLACE FUNCTION public.read_rent_support_deposit_candidate_v1(p_organization_id uuid,p_contract_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f jsonb;p app_private.contract_rent_support_plans;b app_private.rent_support_deposit_payee_bindings;verification jsonb;template jsonb;issue text;BEGIN
 PERFORM app_private.rent_support_subject_v1(p_organization_id,p_contract_id,NULL,false);
 SELECT * INTO p FROM app_private.contract_rent_support_plans WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND state='ACTIVE' ORDER BY revision DESC LIMIT 1;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Không có lịch hỗ trợ hiện hành' USING ERRCODE='PT409';END IF;
 f:=app_private.rent_support_deposit_facts_v1(p_organization_id,p_contract_id);issue:=f->>'issue';
 IF issue IS NOT NULL THEN RETURN jsonb_build_object('version',1,'plan_revision',p.revision,'state',CASE WHEN issue='NO_CANDIDATE' THEN 'NO_CANDIDATE' ELSE 'NEEDS_REVIEW' END,'candidate',NULL,'verification',NULL,'issues',jsonb_build_array(jsonb_build_object('code',issue,'message','Nguồn thưởng cọc cần đối chiếu trước khi xử lý.')));END IF;
 verification:=f-ARRAY['issue','current_net','already_paid','voucher_date','account_id','payer_name','recipient_bank','recipient_account','item_description','attachments'];
 SELECT * INTO b FROM app_private.rent_support_deposit_payee_bindings WHERE organization_id=p_organization_id AND claim_id=(f->>'claim_id')::uuid;
 IF b.id IS NULL OR b.proof_hash<>f->>'proof_hash' OR NOT app_private.rent_support_party_valid_v1(p_organization_id,b.party_id) THEN
 RETURN jsonb_build_object('version',1,'plan_revision',p.revision,'state','NEEDS_REVIEW','candidate',NULL,'verification',verification,'issues',jsonb_build_array(jsonb_build_object('code','PAYEE_UNVERIFIED','message','Xác nhận người hưởng thưởng cọc từ danh sách bên nhận trước khi tiếp nhận nguồn.')));END IF;
 template:=jsonb_build_object('action','ADOPT_DEPOSIT_BONUS','source_id',f->>'source_id','kind','BONUS','party_id',b.party_id,'gross_amount',f->>'gross',
 'route','CASHBOOK','manager_id',NULL,'account_id',f->'account_id','voucher_date',f->>'voucher_date','payer_name',f->'payer_name','recipient_name',NULL,
 'recipient_bank',f->'recipient_bank','recipient_account',f->'recipient_account','item_description',f->'item_description','attachments',f->'attachments',
 'deposit_claim_id',f->>'claim_id','deposit_voucher_id',f->>'deposit_voucher_id','bonus_voucher_id',f->>'bonus_voucher_id',
 'expected_approval_version',f->'approval_version','expected_posting_version',f->'posting_version','item_ids',f->'item_ids','source_facts_hash',f->>'proof_hash');
 RETURN jsonb_build_object('version',1,'plan_revision',p.revision,'state','READY','verification',verification,
 'candidate',verification||jsonb_build_object('current_net',f->>'current_net','already_paid','0','intent_template',template),'issues','[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.verify_rent_support_deposit_payee_v1(
 p_organization_id uuid,p_contract_id uuid,p_claim_id uuid,p_deposit_voucher_id uuid,p_bonus_voucher_id uuid,p_party_id uuid,
 p_expected_approval_version bigint,p_expected_posting_version bigint,p_source_facts_hash text,p_reason text,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f jsonb;b app_private.rent_support_deposit_payee_bindings;h text;building uuid;BEGIN
 building:=app_private.rent_support_payout_lock_v1(p_organization_id,p_contract_id);
 IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 OR p_request_id IS NULL THEN RAISE EXCEPTION 'Cần lý do và mã xác nhận' USING ERRCODE='22023';END IF;
 IF NOT app_private.rent_support_party_scope_v1(p_organization_id,building,true) OR NOT app_private.rent_support_party_valid_v1(p_organization_id,p_party_id)
 OR NOT app_private.ie_supplement_can_read_v1(p_bonus_voucher_id) OR NOT public.can_access_building(building) THEN RAISE EXCEPTION 'Không có quyền xác minh người hưởng' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.income_expenses v CROSS JOIN LATERAL app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'income_expenses.edit',v.building_id,v.account_id) a WHERE v.id=p_bonus_voucher_id AND v.organization_id=p_organization_id AND a.allowed) THEN RAISE EXCEPTION 'Không có quyền sửa phiếu thưởng' USING ERRCODE='42501';END IF;
 h:=md5(jsonb_build_object('contract',p_contract_id,'claim',p_claim_id,'deposit',p_deposit_voucher_id,'bonus',p_bonus_voucher_id,'party',p_party_id,'approval',p_expected_approval_version,'posting',p_expected_posting_version,'proof',p_source_facts_hash,'reason',btrim(p_reason))::text);
 SELECT * INTO b FROM app_private.rent_support_deposit_payee_bindings WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND request_id=p_request_id;
 IF b.id IS NOT NULL THEN IF b.intent_hash<>h THEN RAISE EXCEPTION 'Yêu cầu xác nhận đã đổi nội dung' USING ERRCODE='PT409';END IF;
 RETURN jsonb_build_object('binding_id',b.id,'party_id',b.party_id,'status',b.status,'proof_hash',b.proof_hash);END IF;
 PERFORM 1 FROM public.income_expenses WHERE organization_id=p_organization_id AND id IN(p_deposit_voucher_id,p_bonus_voucher_id) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM app_private.sale_bonus_claims WHERE organization_id=p_organization_id AND id=p_claim_id FOR UPDATE;
 PERFORM app_private.assert_no_engine_request_v1(p_bonus_voucher_id);PERFORM app_private.assert_period_open_for_edit_v1(p_bonus_voucher_id,'xác minh');
 f:=app_private.rent_support_deposit_facts_v1(p_organization_id,p_contract_id);
 IF f->>'issue' IS NOT NULL OR f->>'claim_id' IS DISTINCT FROM p_claim_id::text OR f->>'deposit_voucher_id' IS DISTINCT FROM p_deposit_voucher_id::text OR f->>'bonus_voucher_id' IS DISTINCT FROM p_bonus_voucher_id::text
 OR (f->>'approval_version')::bigint IS DISTINCT FROM p_expected_approval_version OR (f->>'posting_version')::bigint IS DISTINCT FROM p_expected_posting_version OR f->>'proof_hash' IS DISTINCT FROM p_source_facts_hash THEN RAISE EXCEPTION 'Nguồn đã đổi hoặc không còn sửa được' USING ERRCODE='PT409';END IF;
 SELECT * INTO b FROM app_private.rent_support_deposit_payee_bindings WHERE organization_id=p_organization_id AND (claim_id=p_claim_id OR source_id=(f->>'source_id')::uuid);
 IF b.id IS NOT NULL THEN
 IF b.party_id<>p_party_id OR b.proof_hash<>p_source_facts_hash THEN RAISE EXCEPTION 'Người hưởng đã được xác nhận khác; cần đối chiếu' USING ERRCODE='PT409';END IF;
 ELSE
 INSERT INTO app_private.rent_support_deposit_payee_bindings(organization_id,contract_id,source_id,claim_id,deposit_voucher_id,bonus_voucher_id,party_id,approval_version,posting_version,proof_hash,actor_id,request_id,intent_hash,reason)
 VALUES(p_organization_id,p_contract_id,(f->>'source_id')::uuid,p_claim_id,p_deposit_voucher_id,p_bonus_voucher_id,p_party_id,p_expected_approval_version,p_expected_posting_version,p_source_facts_hash,auth.uid(),p_request_id,h,btrim(p_reason)) RETURNING * INTO b;END IF;
 RETURN jsonb_build_object('binding_id',b.id,'party_id',b.party_id,'status',b.status,'proof_hash',b.proof_hash);
END $$;
DO $$ DECLARE f regprocedure;BEGIN
 FOREACH f IN ARRAY ARRAY['app_private.rent_support_deposit_facts_v1(uuid,uuid)'::regprocedure] LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);END LOOP;
 FOREACH f IN ARRAY ARRAY['public.read_rent_support_deposit_candidate_v1(uuid,uuid)'::regprocedure,'public.verify_rent_support_deposit_payee_v1(uuid,uuid,uuid,uuid,uuid,uuid,bigint,bigint,text,text,uuid)'::regprocedure] LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,service_role',f);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f);END LOOP;
END $$;

-- Strict v3 action discriminator. Preview v1 and actionable v2 retain their exact validators.
DO $$ BEGIN
 IF to_regprocedure('app_private.rent_support_payout_context_before_salary_v2(jsonb)') IS NULL THEN
 ALTER FUNCTION app_private.rent_support_payout_context_v1(jsonb) RENAME TO rent_support_payout_context_before_salary_v2;END IF;
 IF to_regprocedure('app_private.rent_support_source_quote_before_salary_v1(uuid,uuid,uuid,jsonb,numeric,jsonb)') IS NULL THEN
 ALTER FUNCTION app_private.rent_support_source_quote_v1(uuid,uuid,uuid,jsonb,numeric,jsonb) RENAME TO rent_support_source_quote_before_salary_v1;END IF;
END $$;
CREATE OR REPLACE FUNCTION app_private.rent_support_payout_context_v1(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE i jsonb;base jsonb:='[]';k text;ids integer;BEGIN
 IF p->'version' IS DISTINCT FROM '3'::jsonb THEN RETURN app_private.rent_support_payout_context_before_salary_v2(p);END IF;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'intents') IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) keyval WHERE keyval NOT IN('version','intents')) THEN RAISE EXCEPTION 'Invalid action context' USING ERRCODE='22023';END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(p->'intents') LOOP
 IF i->>'action'='ISSUE_NEW' THEN
 IF i->>'source_id' IS NOT NULL THEN RAISE EXCEPTION 'New intent already has source' USING ERRCODE='22023';END IF;
 base:=base||jsonb_build_array(i-'action');
 ELSIF i->>'action'='ADOPT_DEPOSIT_BONUS' THEN
 IF i->>'kind' IS DISTINCT FROM 'BONUS' OR i->>'route' IS DISTINCT FROM 'CASHBOOK' OR i->>'manager_id' IS NOT NULL
 OR NOT(i ?& ARRAY['deposit_claim_id','deposit_voucher_id','bonus_voucher_id','expected_approval_version','expected_posting_version','item_ids','source_facts_hash','reason'])
 OR COALESCE(length(btrim(i->>'reason')),0) NOT BETWEEN 1 AND 2000 OR COALESCE(length(i->>'source_facts_hash'),0)=0
 OR jsonb_typeof(i->'expected_approval_version') IS DISTINCT FROM 'number' OR jsonb_typeof(i->'expected_posting_version') IS DISTINCT FROM 'number'
 OR (i->>'expected_approval_version') !~ '^[0-9]+$' OR (i->>'expected_posting_version') !~ '^[0-9]+$'
 OR jsonb_typeof(i->'item_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(i->'item_ids')=0 THEN RAISE EXCEPTION 'Invalid adoption intent' USING ERRCODE='22023';END IF;
 FOREACH k IN ARRAY ARRAY['source_id','deposit_claim_id','deposit_voucher_id','bonus_voucher_id'] LOOP
 IF i->>'source_id' IS NULL OR i->>k IS NULL THEN RAISE EXCEPTION 'Missing adoption identity' USING ERRCODE='22023';END IF;PERFORM(i->>k)::uuid;END LOOP;
 SELECT count(DISTINCT value) INTO ids FROM jsonb_array_elements_text(i->'item_ids');
 IF ids<>jsonb_array_length(i->'item_ids') THEN RAISE EXCEPTION 'Duplicate part identity' USING ERRCODE='22023';END IF;
 PERFORM value::uuid FROM jsonb_array_elements_text(i->'item_ids');
 base:=base||jsonb_build_array(i-ARRAY['action','deposit_claim_id','deposit_voucher_id','bonus_voucher_id','expected_approval_version','expected_posting_version','item_ids','source_facts_hash','reason']);
 ELSE RAISE EXCEPTION 'Unknown payout action' USING ERRCODE='22023';END IF;
 END LOOP;
 PERFORM app_private.rent_support_payout_context_before_salary_v2(jsonb_build_object('version',2,'intents',base));RETURN p;
EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Invalid action identity' USING ERRCODE='22023';
END $$;


CREATE TABLE IF NOT EXISTS app_private.rent_support_adoption_authorizations(
 organization_id uuid NOT NULL,operation_id uuid NOT NULL,source_id uuid NOT NULL,claim_id uuid NOT NULL,bonus_voucher_id uuid NOT NULL,
 contract_id uuid NOT NULL,before_approval_version bigint NOT NULL,before_posting_version bigint NOT NULL,gross numeric NOT NULL,net numeric NOT NULL,
 xid xid8 NOT NULL,backend_pid integer NOT NULL,actor_id uuid NOT NULL,PRIMARY KEY(organization_id,bonus_voucher_id,xid,backend_pid)
);
ALTER TABLE app_private.rent_support_adoption_authorizations ADD COLUMN IF NOT EXISTS actor_id uuid NOT NULL;
ALTER TABLE app_private.rent_support_adoption_authorizations OWNER TO postgres;
ALTER TABLE app_private.rent_support_adoption_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.rent_support_adoption_authorizations FROM PUBLIC,anon,authenticated,service_role;
DROP POLICY IF EXISTS rent_support_adoption_authorizations_hide_sandbox_admin ON app_private.rent_support_adoption_authorizations;
CREATE POLICY rent_support_adoption_authorizations_hide_sandbox_admin ON app_private.rent_support_adoption_authorizations AS RESTRICTIVE FOR ALL TO authenticated USING(NOT COALESCE(public.is_super_admin() AND organization_id=ANY(public.sandbox_org_ids()),false));
CREATE OR REPLACE FUNCTION app_private.rent_support_adoption_guard_v1() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a app_private.rent_support_adoption_authorizations;BEGIN
 IF ROW(NEW.organization_id,NEW.contract_id,NEW.type,NEW.commission_kind,NEW.total_amount,NEW.deleted_at) IS NOT DISTINCT FROM ROW(OLD.organization_id,OLD.contract_id,OLD.type,OLD.commission_kind,OLD.total_amount,OLD.deleted_at) AND NOT(NEW.approval_status='CANCELLED' AND OLD.approval_status<>'CANCELLED') THEN RETURN NEW;END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.sale_bonus_claims c JOIN public.income_expenses d ON d.id=c.deposit_voucher_id AND d.organization_id=c.organization_id JOIN app_private.rent_support_payout_sources s ON s.organization_id=c.organization_id AND s.contract_id=d.contract_id AND s.kind='BONUS' WHERE c.organization_id=OLD.organization_id AND c.bonus_voucher_id=OLD.id) THEN RETURN NEW;END IF;
 SELECT * INTO a FROM app_private.rent_support_adoption_authorizations WHERE organization_id=OLD.organization_id AND bonus_voucher_id=OLD.id AND xid=pg_current_xact_id() AND backend_pid=pg_backend_pid();
 IF a.operation_id IS NULL OR a.actor_id IS DISTINCT FROM auth.uid() OR NOT EXISTS(SELECT 1 FROM app_private.rent_support_funding_operations o JOIN app_private.rent_support_payout_sources s ON s.organization_id=o.organization_id AND s.id=a.source_id WHERE o.organization_id=a.organization_id AND o.id=a.operation_id AND o.state='READY' AND s.evidence->>'operation_id'=o.id::text)
 OR NEW.organization_id IS DISTINCT FROM a.organization_id OR NEW.contract_id IS DISTINCT FROM a.contract_id AND a.net>0 OR NEW.type<>'EXPENSE' OR NEW.commission_kind<>'sale' OR NEW.deleted_at IS NOT NULL OR NEW.total_amount NOT IN(a.gross,a.net,0)
 OR (NEW.approval_status='CANCELLED' AND a.net<>0) THEN RAISE EXCEPTION 'ADOPTION_CAPABILITY_REQUIRED' USING ERRCODE='PT409';END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION app_private.rent_support_adoption_guard_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.rent_support_adoption_guard_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS rent_support_deposit_adoption_guard ON public.income_expenses;
CREATE TRIGGER rent_support_deposit_adoption_guard BEFORE UPDATE ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_adoption_guard_v1();

CREATE OR REPLACE FUNCTION app_private.rent_support_adopt_deposit_v1(p_org uuid,p_operation uuid,p_intent jsonb,p_net numeric,p_before jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o app_private.rent_support_funding_operations;v public.income_expenses;it public.income_expense_items;r jsonb;sid uuid;BEGIN
 SELECT * INTO o FROM app_private.rent_support_funding_operations WHERE organization_id=p_org AND id=p_operation AND state='READY';
 sid:=(p_intent->>'source_id')::uuid;
 IF o.id IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(o.payload->'intents') x WHERE x=p_intent)
 OR NOT EXISTS(SELECT 1 FROM app_private.rent_support_payout_sources WHERE organization_id=p_org AND id=sid AND evidence->>'operation_id'=o.id::text)
 OR p_before->>'proof_hash' IS DISTINCT FROM p_intent->>'source_facts_hash' THEN RAISE EXCEPTION 'Adoption operation mismatch' USING ERRCODE='PT409';END IF;
 SELECT * INTO v FROM public.income_expenses WHERE organization_id=p_org AND id=(p_intent->>'bonus_voucher_id')::uuid FOR UPDATE;
 SELECT * INTO it FROM public.income_expense_items WHERE income_expense_id=v.id ORDER BY id LIMIT 1;
 IF v.approval_version IS DISTINCT FROM (p_intent->>'expected_approval_version')::bigint OR COALESCE(v.posting_version,0) IS DISTINCT FROM (p_intent->>'expected_posting_version')::bigint
 OR v.approval_status<>'UNAPPROVED' OR (app_private.rent_support_voucher_cash_v1(p_org,v.id)->>'already_paid')::numeric IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'Adoption source changed' USING ERRCODE='PT409';END IF;
 PERFORM app_private.assert_no_engine_request_v1(v.id);PERFORM app_private.assert_period_open_for_edit_v1(v.id,'sửa');
 INSERT INTO app_private.rent_support_adoption_authorizations VALUES(p_org,p_operation,(p_intent->>'source_id')::uuid,(p_intent->>'deposit_claim_id')::uuid,v.id,o.contract_id,v.approval_version,v.posting_version,(p_intent->>'gross_amount')::numeric,p_net,pg_current_xact_id(),pg_backend_pid(),auth.uid());
 IF p_net>0 THEN
 IF v.contract_id IS NOT NULL AND v.contract_id IS DISTINCT FROM o.contract_id THEN RAISE EXCEPTION 'ADOPTION_CONTRACT_REBIND_DENIED' USING ERRCODE='PT409';END IF;
 IF v.contract_id IS NULL THEN
  -- Existing canonical LINK_CONTRACT permits only NULL -> proved contract; own
  -- capability additionally binds this claim, saved operation, actor and CAS.
  PERFORM app_private.begin_ie_flex_write_v1(v.id,'LINK_CONTRACT');
  UPDATE public.income_expenses SET contract_id=o.contract_id,updated_at=clock_timestamp()
  WHERE id=v.id AND organization_id=p_org AND contract_id IS NULL AND approval_version=v.approval_version AND posting_version=v.posting_version AND review_version=v.review_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'ADOPTION_LINK_CAS_CHANGED' USING ERRCODE='PT409';END IF;
  PERFORM app_private.end_ie_flex_write_v1(v.id);
  PERFORM app_private.append_income_expense_event_v1(p_org,v.id,'REVISED',auth.uid(),app_private.ie_actor_display_name_v1(auth.uid()),v.approval_status,v.approval_status,'Tiếp nhận thưởng cọc vào hợp đồng từ claim đã xác minh: '||o.contract_id::text);
 END IF;
 r:=public.revise_pending_income_expense_v1(v.id,v.approval_version,'{}'::jsonb,
 jsonb_build_array(jsonb_build_object('income_expense_type_id',it.income_expense_type_id,'description',it.description,'quantity',1,'unit_price',p_net,'start_date',it.start_date,'end_date',it.end_date)),
 p_intent->>'reason','support-adopt-'||o.id::text);
 ELSE
 r:=public.cancel_unposted_income_expense_v2(v.id,v.review_version,v.approval_version,p_intent->>'reason','support-adopt-cancel-'||o.id::text);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.income_expenses e WHERE e.id=v.id AND e.organization_id=p_org AND ((p_net>0 AND e.contract_id=o.contract_id AND e.total_amount=p_net AND e.approval_status='UNAPPROVED') OR (p_net=0 AND e.approval_status='CANCELLED'))) THEN RAISE EXCEPTION 'ADOPTION_CANONICAL_RESULT_CHANGED' USING ERRCODE='PT409';END IF;
 DELETE FROM app_private.rent_support_adoption_authorizations WHERE organization_id=p_org AND bonus_voucher_id=v.id AND xid=pg_current_xact_id() AND backend_pid=pg_backend_pid();
 INSERT INTO app_private.rent_support_deposit_adoptions(organization_id,operation_id,source_id,claim_id,deposit_voucher_id,original_bonus_voucher_id,original_item_ids,original_gross,before_approval_version,before_posting_version,before_facts_hash,after_facts_hash,canonical_result,actor_id,reason)
 VALUES(p_org,o.id,sid,(p_intent->>'deposit_claim_id')::uuid,(p_intent->>'deposit_voucher_id')::uuid,v.id,
 ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p_intent->'item_ids')),(p_before->>'gross')::numeric,v.approval_version,COALESCE(v.posting_version,0),p_before->>'proof_hash',
 (SELECT md5(to_jsonb(e)::text) FROM public.income_expenses e WHERE e.id=v.id),r,auth.uid(),p_intent->>'reason');
 PERFORM app_private.rent_support_link_source_alias_v1(p_org,sid,'DEPOSIT_BONUS_CLAIM',(p_intent->>'deposit_claim_id')::uuid,'');
 PERFORM app_private.rent_support_link_source_alias_v1(p_org,sid,'VOUCHER',v.id,'');
 IF p_net=0 THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('id',v.id,'code',v.code);
END $$;

CREATE OR REPLACE FUNCTION app_private.rent_support_source_quote_salary_v1(p_org uuid,p_contract uuid,p_draft uuid,p_plan jsonb,p_due numeric,p_context jsonb)
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

  -- Existing deposit liability is eligible only under the explicit adoption action.
  IF source_kind='BONUS' AND i->>'action'='ADOPT_DEPOSIT_BONUS' THEN
   f:=public.read_rent_support_deposit_candidate_v1(p_org,p_contract);
   IF f->>'state'<>'READY' OR (i-ARRAY['intent_id','reason']) IS DISTINCT FROM f->'candidate'->'intent_template' THEN
    issues:=issues||jsonb_build_array(jsonb_build_object('code','DEPOSIT_ADOPTION_REVIEW','message','Nguồn thưởng cọc cần xác minh hoặc đã đổi.'));CONTINUE;END IF;
   sid:=(i->>'source_id')::uuid;
   facts:=facts||jsonb_build_array(jsonb_build_object('source_id',sid,'kind','BONUS','party_id',i->>'party_id','gross_original',i->>'gross_amount',
    'already_paid','0','prior_withheld','0','reserved','0','verified',true,'locked',false,'route','CASHBOOK','origin','EXISTING','intent_id',i->>'intent_id'));
   fingerprints:=fingerprints||jsonb_build_array(jsonb_build_object('deposit',f,'intent',i));CONTINUE;
  END IF;
  IF source_kind='BONUS' AND i IS NULL AND s.id IS NULL AND cardinality(live_ids)>0 THEN
   IF p_plan->>'deduction_policy'='COMMISSION_ONLY' THEN
    -- An unselected bonus outside this policy is not a funding source.
    CONTINUE;
   END IF;
   f:=app_private.rent_support_deposit_facts_v1(p_org,p_contract);
   IF f->>'issue'='DEPOSIT_ALREADY_PAID' THEN
    fingerprints:=fingerprints||jsonb_build_array(jsonb_build_object('paid_deposit',f));CONTINUE;END IF;
  END IF;
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
   IF i->>'route'='MANAGER_PAYROLL' AND (i->>'kind'<>'COMMISSION' OR i->>'account_id' IS NOT NULL) THEN RAISE EXCEPTION 'Payroll route requires commission and server-owned book' USING ERRCODE='22023';END IF;
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
CREATE OR REPLACE FUNCTION public.prepare_contract_payouts_with_support_v1(p_organization_id uuid,p_contract_id uuid,p_plan_revision bigint,p_quote_hash text,p_payload jsonb,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b uuid;p app_private.contract_rent_support_plans;o app_private.rent_support_funding_operations;h text;q jsonb;i jsonb;k text;ctx jsonb;
BEGIN
 b:=app_private.rent_support_payout_lock_v1(p_organization_id,p_contract_id);
 ctx:=app_private.rent_support_payout_context_v1(p_payload);
 IF ctx->'version' NOT IN ('2'::jsonb,'3'::jsonb) OR p_request_id IS NULL OR p_plan_revision IS NULL OR p_quote_hash IS NULL THEN RAISE EXCEPTION 'A complete saved payout request is required' USING ERRCODE='22023';END IF;
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
CREATE OR REPLACE FUNCTION public.execute_contract_payout_operation_v1(p_organization_id uuid,p_operation_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o app_private.rent_support_funding_operations;p app_private.contract_rent_support_plans;b uuid;q jsonb;i jsonb;s jsonb;k text;v jsonb;sid uuid;
 rows jsonb:='[]';receipt jsonb;failure text;gross numeric;held numeric;net numeric;adoption boolean;before_facts jsonb;
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
   adoption:=i->>'action'='ADOPT_DEPOSIT_BONUS';adoption:=COALESCE(adoption,false);
   IF s IS NULL OR (NOT adoption AND (s->>'origin'<>'PROPOSED' OR i->>'source_id' IS NOT NULL))
   OR (adoption AND (s->>'origin'<>'EXISTING' OR s->>'source_id' IS DISTINCT FROM i->>'source_id')) THEN RAISE EXCEPTION 'Existing payout liability requires adjustment' USING ERRCODE='PT409';END IF;
   before_facts:=NULL;
   IF adoption THEN
    PERFORM 1 FROM public.income_expenses WHERE organization_id=p_organization_id AND id IN((i->>'deposit_voucher_id')::uuid,(i->>'bonus_voucher_id')::uuid) ORDER BY id FOR UPDATE;
    PERFORM 1 FROM app_private.sale_bonus_claims WHERE organization_id=p_organization_id AND id=(i->>'deposit_claim_id')::uuid FOR UPDATE;
    before_facts:=app_private.rent_support_deposit_facts_v1(p_organization_id,o.contract_id);
    IF before_facts->>'issue' IS NOT NULL OR before_facts->>'proof_hash' IS DISTINCT FROM i->>'source_facts_hash' THEN RAISE EXCEPTION 'Adoption evidence changed' USING ERRCODE='PT409';END IF;
   END IF;
   sid:=(s->>'source_id')::uuid;gross:=(s->>'gross_original')::numeric;held:=(s->>'current_withheld')::numeric;net:=(s->>'net_this_operation')::numeric;
   IF gross<>(i->>'gross_amount')::numeric OR gross<>held+net OR held<0 OR net<0 OR (held>0 AND (p.payer<>'SALE' OR p.sale_party_id IS DISTINCT FROM (i->>'party_id')::uuid OR (p.deduction_policy='COMMISSION_ONLY' AND i->>'kind'<>'COMMISSION'))) THEN RAISE EXCEPTION 'Source allocation mismatch' USING ERRCODE='23514';END IF;
   k:=CASE WHEN i->>'kind'='COMMISSION' THEN 'broker' ELSE 'sale' END;
   INSERT INTO app_private.rent_support_payout_sources(id,organization_id,contract_id,party_id,kind,gross_original,evidence,created_by)
   VALUES(sid,p_organization_id,o.contract_id,(i->>'party_id')::uuid,i->>'kind',gross,jsonb_build_object('operation_id',o.id,'kind','CANONICAL_INTENT','intent_id',i->>'intent_id'),auth.uid());
   PERFORM app_private.rent_support_link_source_alias_v1(p_organization_id,sid,CASE WHEN k='broker' THEN 'CONTRACT_COMMISSION' ELSE 'CONTRACT_BONUS' END,o.contract_id,'');
   v:=NULL;
   IF adoption THEN
    v:=app_private.rent_support_adopt_deposit_v1(p_organization_id,o.id,i,net,before_facts);
   ELSIF net>0 THEN
    INSERT INTO app_private.rent_support_payout_authorizations VALUES(p_organization_id,o.contract_id,k,o.id,gross,net,pg_current_xact_id(),pg_backend_pid());
    v:=public.create_commission_voucher(o.contract_id,k,net,(i->>'voucher_date')::date,(i->>'account_id')::uuid,i->>'payer_name',i->>'recipient_name',i->>'recipient_bank',i->>'recipient_account',i->>'item_description',i->'attachments');
    DELETE FROM app_private.rent_support_payout_authorizations WHERE organization_id=p_organization_id AND contract_id=o.contract_id AND kind=k AND xid=pg_current_xact_id() AND backend_pid=pg_backend_pid();
    IF v->>'id' IS NULL THEN RAISE EXCEPTION 'Canonical payout returned no voucher';END IF;
    PERFORM app_private.rent_support_link_source_alias_v1(p_organization_id,sid,'VOUCHER',(v->>'id')::uuid,'');
    IF i->>'route'='MANAGER_PAYROLL' THEN
     PERFORM app_private.rent_support_salary_assign_before_v1((v->>'id')::uuid,(i->>'manager_id')::uuid,NULL,'support-payroll-'||o.id::text);
     PERFORM app_private.rent_support_link_source_alias_v1(p_organization_id,sid,'MANAGER_COMMISSION',(v->>'id')::uuid,'');
    END IF;
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

CREATE OR REPLACE FUNCTION app_private.rent_support_source_quote_v1(p_org uuid,p_contract uuid,p_draft uuid,p_plan jsonb,p_due numeric,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_context->'version'='3'::jsonb OR p_plan->>'deduction_policy'='COMMISSION_ONLY'
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_context->'intents','[]')) x WHERE x->>'route'='MANAGER_PAYROLL')
 OR EXISTS(SELECT 1 FROM app_private.sale_bonus_claims c JOIN public.income_expenses d ON d.id=c.deposit_voucher_id AND d.organization_id=c.organization_id WHERE c.organization_id=p_org AND d.contract_id=p_contract)
 THEN RETURN app_private.rent_support_source_quote_salary_v1(p_org,p_contract,p_draft,p_plan,p_due,p_context);END IF;
 RETURN app_private.rent_support_source_quote_before_salary_v1(p_org,p_contract,p_draft,p_plan,p_due,p_context);
END $$;
DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app_private' AND p.proname IN('rent_support_payout_context_before_salary_v2','rent_support_payout_context_v1','rent_support_source_quote_before_salary_v1','rent_support_source_quote_salary_v1','rent_support_source_quote_v1','rent_support_adopt_deposit_v1') LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f.signature);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);END LOOP;
END $$;

-- Read facts are server-issued; names and client-computed hashes never establish identity.
CREATE OR REPLACE FUNCTION public.read_rent_support_salary_parts_v1(p_voucher_ids uuid[],p_period_month date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE vid uuid;v public.income_expenses;s app_private.rent_support_payout_sources;profile uuid;f jsonb;rows jsonb:='[]';period date;issue text;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501';END IF;
 IF p_voucher_ids IS NULL OR cardinality(p_voucher_ids)>1000 THEN RAISE EXCEPTION 'Danh sách nguồn không hợp lệ' USING ERRCODE='22023';END IF;
 FOREACH vid IN ARRAY p_voucher_ids LOOP
 SELECT * INTO v FROM public.income_expenses WHERE id=vid;
 IF v.id IS NULL OR NOT COALESCE(v.organization_id=ANY(public.my_org_ids()),false) OR NOT public.can_access_building(v.building_id) OR NOT app_private.ie_supplement_can_read_v1(vid) THEN RAISE EXCEPTION 'Không có quyền xem nguồn hoa hồng' USING ERRCODE='42501';END IF;
 SELECT x.* INTO s FROM app_private.rent_support_source_aliases a JOIN app_private.rent_support_payout_sources x ON x.organization_id=a.organization_id AND x.id=a.source_id WHERE a.organization_id=v.organization_id AND a.alias_kind='VOUCHER' AND a.alias_id=vid;
 IF s.id IS NULL AND NOT EXISTS(SELECT 1 FROM app_private.contract_rent_support_plans WHERE organization_id=v.organization_id AND contract_id=v.contract_id) THEN CONTINUE;END IF;
 SELECT profile_id INTO profile FROM app_private.rent_support_parties WHERE organization_id=v.organization_id AND id=s.party_id;
 SELECT COALESCE(p_period_month,date_trunc('month',start_date)::date) INTO period FROM public.income_expense_items WHERE income_expense_id=vid ORDER BY id LIMIT 1;
 f:=NULL;issue:=NULL;
 BEGIN f:=app_private.rent_support_salary_part_v1(v.organization_id,vid,period,profile);
 EXCEPTION WHEN SQLSTATE 'PT409' THEN issue:='Cần đối chiếu quyền lợi, kỳ hoặc chứng cứ thanh toán.';END;
 rows:=rows||jsonb_build_array(jsonb_build_object('voucher_id',vid,'state',CASE WHEN f IS NOT NULL THEN 'READY' ELSE 'NEEDS_REVIEW' END,'source_id',s.id,'staff_id',profile,'part',f,'issue',issue));
 END LOOP;RETURN rows;
END $$;
CREATE OR REPLACE FUNCTION public.rent_support_salary_bridge_required_v1(p_staff_ids uuid[],p_period_month date)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE staff uuid;org uuid;needed boolean:=false;BEGIN
 IF auth.uid() IS NULL OR p_staff_ids IS NULL OR cardinality(p_staff_ids)>1000 OR p_period_month IS NULL THEN RAISE EXCEPTION 'Không có quyền kỳ lương' USING ERRCODE='42501';END IF;
 FOREACH staff IN ARRAY p_staff_ids LOOP
 org:=app_private.salary_staff_org_v1(staff);
 IF NOT COALESCE(org=ANY(public.my_org_ids()),false) OR NOT (staff=auth.uid() OR EXISTS(SELECT 1 FROM public.buildings b CROSS JOIN LATERAL app_private.authorize_tenant_action_v3(auth.uid(),org,'salary.lock',b.id,NULL) a WHERE b.organization_id=org AND a.allowed) OR EXISTS(SELECT 1 FROM public.buildings b CROSS JOIN LATERAL app_private.authorize_tenant_action_v3(auth.uid(),org,'salary.distribute',b.id,NULL) a WHERE b.organization_id=org AND a.allowed)) THEN RAISE EXCEPTION 'Không có quyền kỳ lương' USING ERRCODE='42501';END IF;
 needed:=needed OR app_private.rent_support_salary_has_source_v1(org,staff,p_period_month);
 END LOOP;RETURN needed;
END $$;
ALTER FUNCTION public.read_rent_support_salary_parts_v1(uuid[],date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.read_rent_support_salary_parts_v1(uuid[],date) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.read_rent_support_salary_parts_v1(uuid[],date) TO authenticated;
ALTER FUNCTION public.rent_support_salary_bridge_required_v1(uuid[],date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.rent_support_salary_bridge_required_v1(uuid[],date) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.rent_support_salary_bridge_required_v1(uuid[],date) TO authenticated;

-- Preserve the pre-bridge public salary entry ACL; all actor checks remain in its body.
GRANT EXECUTE ON FUNCTION public.salary_payout_v1(uuid,date,numeric,uuid,date,text,text,uuid,numeric) TO service_role;
