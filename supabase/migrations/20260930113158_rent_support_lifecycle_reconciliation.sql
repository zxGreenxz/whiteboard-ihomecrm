-- Task8: append-only review and explicit attestation; no historical backfill.
CREATE TABLE IF NOT EXISTS app_private.rent_support_lifecycle_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,contract_id uuid NOT NULL,
 source_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES auth.users(id),request_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('CANCEL','RESTORE','REVISE')),payload_hash text NOT NULL,
 reason text NOT NULL,proof_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,request_id),FOREIGN KEY(organization_id,source_id) REFERENCES app_private.rent_support_payout_sources(organization_id,id),
 FOREIGN KEY(organization_id,contract_id) REFERENCES public.contracts(organization_id,id)
);
CREATE TABLE IF NOT EXISTS app_private.rent_support_reconciliation_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES public.organizations(id),
 actor_id uuid NOT NULL REFERENCES auth.users(id),request_id uuid NOT NULL,payload_hash text NOT NULL,
 entries jsonb NOT NULL,reason text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,request_id),UNIQUE(organization_id,id)
);
CREATE TABLE IF NOT EXISTS app_private.rent_support_reconciliations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,contract_id uuid NOT NULL,source_id uuid NOT NULL,
 voucher_id uuid NOT NULL,party_id uuid NOT NULL,plan_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('COMMISSION','BONUS')),
 gross numeric NOT NULL,withheld numeric NOT NULL,net numeric NOT NULL,batch_id uuid NOT NULL,
 evidence jsonb NOT NULL,created_by uuid NOT NULL REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 provenance text NOT NULL CHECK(provenance='MANUALLY_ATTESTED'),CHECK(gross>0 AND withheld>=0 AND net>=0 AND gross=withheld+net),
 CHECK(gross::text NOT IN ('NaN','Infinity','-Infinity')),
 UNIQUE(organization_id,source_id),UNIQUE(organization_id,voucher_id),UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,contract_id) REFERENCES public.contracts(organization_id,id),
 FOREIGN KEY(organization_id,source_id) REFERENCES app_private.rent_support_payout_sources(organization_id,id),
 FOREIGN KEY(organization_id,party_id) REFERENCES app_private.rent_support_parties(organization_id,id),
 FOREIGN KEY(organization_id,voucher_id) REFERENCES public.income_expenses(organization_id,id),
 FOREIGN KEY(organization_id,contract_id,plan_id) REFERENCES app_private.contract_rent_support_plans(organization_id,contract_id,id),
 FOREIGN KEY(organization_id,batch_id) REFERENCES app_private.rent_support_reconciliation_batches(organization_id,id) DEFERRABLE INITIALLY DEFERRED
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['rent_support_lifecycle_requests','rent_support_reconciliation_batches','rent_support_reconciliations'] LOOP
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

CREATE OR REPLACE FUNCTION app_private.rent_support_termination_v1(p_org uuid,p_contract uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c public.contracts; dates date[]; effective date; review boolean:=false; facts jsonb;BEGIN
 SELECT * INTO c FROM public.contracts WHERE organization_id=p_org AND id=p_contract;
 IF c.id IS NULL THEN RAISE EXCEPTION 'Subject denied' USING ERRCODE='42501';END IF;
 SELECT array_agg(DISTINCT actual_move_out_date ORDER BY actual_move_out_date) INTO dates
 FROM public.contract_terminations WHERE organization_id=p_org AND contract_id=p_contract AND status IN ('APPROVED','COMPLETED');
 effective:=c.actual_end_date;
 IF c.status::text='TERMINATED' THEN
  IF effective IS NULL AND cardinality(dates)=1 THEN effective:=dates[1];END IF;
  review:=effective IS NULL OR NOT isfinite(effective) OR effective<c.start_date
   OR (cardinality(dates)>0 AND (cardinality(dates)<>1 OR dates[1] IS DISTINCT FROM effective));
 ELSIF effective IS NOT NULL OR cardinality(dates)>0 THEN review:=true;effective:=NULL;
 END IF;
 facts:=jsonb_build_object('status',c.status,'actual_end_date',c.actual_end_date,'termination_dates',dates);
 RETURN jsonb_build_object('effective_date',effective,'cutoff_month',to_char(effective,'YYYY-MM'),'review',review,'proof_hash',md5(facts::text));
END $$;

DO $$ BEGIN
 IF to_regprocedure('app_private.invoice_rent_support_quote_before_lifecycle_v1(uuid,uuid,text,text,jsonb,numeric,numeric,bigint)') IS NULL THEN
 ALTER FUNCTION app_private.invoice_rent_support_quote_v1(uuid,uuid,text,text,jsonb,numeric,numeric,bigint) RENAME TO invoice_rent_support_quote_before_lifecycle_v1;END IF;
 IF to_regprocedure('app_private.invoice_rent_support_restore_before_lifecycle_v1(uuid)') IS NULL THEN
 ALTER FUNCTION app_private.invoice_rent_support_restore_v1(uuid) RENAME TO invoice_rent_support_restore_before_lifecycle_v1;END IF;
END $$;
CREATE OR REPLACE FUNCTION app_private.invoice_rent_support_quote_v1(p_org uuid,p_contract uuid,p_month text,p_kind text,p_items jsonb,p_manual numeric,p_credit numeric,p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q jsonb;t jsonb;BEGIN
 q:=app_private.invoice_rent_support_quote_before_lifecycle_v1(p_org,p_contract,p_month,p_kind,p_items,p_manual,p_credit,p_revision);
 IF q->>'plan_revision' IS NULL THEN RETURN q;END IF;
 t:=app_private.rent_support_termination_v1(p_org,p_contract);
 IF (t->>'review')::boolean OR (COALESCE(p_kind,'MONTHLY')='MONTHLY' AND p_month>t->>'cutoff_month') THEN
 RETURN q||jsonb_build_object('invoice_support','0','state','NEEDS_REVIEW','issue','TERMINATION_REVIEW');END IF;
 RETURN q;
END $$;
CREATE OR REPLACE FUNCTION app_private.invoice_rent_support_restore_v1(p_invoice uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE inv public.invoices;t jsonb;BEGIN
 PERFORM app_private.invoice_rent_support_lock_v1(p_invoice);
 SELECT * INTO inv FROM public.invoices WHERE id=p_invoice FOR UPDATE;
 IF inv.invoice_support_amount>0 THEN
 t:=app_private.rent_support_termination_v1(inv.organization_id,inv.contract_id);
 IF (t->>'review')::boolean OR inv.billing_month>t->>'cutoff_month' THEN RAISE EXCEPTION 'TERMINATION_REVIEW' USING ERRCODE='PT409';END IF;END IF;
 PERFORM app_private.invoice_rent_support_restore_before_lifecycle_v1(p_invoice);
END $$;

CREATE OR REPLACE FUNCTION app_private.rent_support_lifecycle_authorize_v1(p_org uuid,p_contract uuid,p_write boolean)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b uuid;BEGIN
 b:=app_private.rent_support_subject_v1(p_org,p_contract,NULL,true);
 IF p_write AND (NOT app_private.rent_support_scope_v1(p_org,b,'income_expenses.create')
 OR NOT app_private.rent_support_scope_v1(p_org,b,'contracts.edit')) THEN RAISE EXCEPTION 'Financial reconciliation denied' USING ERRCODE='42501';END IF;
 RETURN b;
END $$;
CREATE OR REPLACE FUNCTION app_private.rent_support_lifecycle_source_v1(p_org uuid,p_source uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s app_private.rent_support_payout_sources;v public.income_expenses;f jsonb;cash jsonb;payroll jsonb:='{}';payroll_evidence jsonb:='{}';frozen boolean;vh uuid; facts jsonb;historical_settlement boolean:=false;BEGIN
 SELECT * INTO s FROM app_private.rent_support_payout_sources WHERE organization_id=p_org AND id=p_source;
 IF s.id IS NULL THEN RAISE EXCEPTION 'Source denied' USING ERRCODE='42501';END IF;
 IF (SELECT count(*) FROM app_private.rent_support_source_aliases WHERE organization_id=p_org AND source_id=s.id AND alias_kind='VOUCHER')>1 THEN RAISE EXCEPTION 'Source aliases require review' USING ERRCODE='PT409';END IF;
 SELECT alias_id INTO vh FROM app_private.rent_support_source_aliases WHERE organization_id=p_org AND source_id=s.id AND alias_kind='VOUCHER';
 IF vh IS NOT NULL THEN
  IF NOT app_private.ie_supplement_can_read_v1(vh) THEN RAISE EXCEPTION 'Source denied' USING ERRCODE='42501';END IF;
  SELECT * INTO v FROM public.income_expenses WHERE organization_id=p_org AND id=vh;
  cash:=app_private.rent_support_voucher_cash_v1(p_org,vh);
 END IF;
 f:=app_private.rent_support_source_funding_evidence_v1(p_org,s.id);
 IF to_regprocedure('app_private.rent_support_salary_source_state_v1(uuid,uuid)') IS NOT NULL THEN
 EXECUTE 'SELECT app_private.rent_support_salary_source_state_v1($1,$2)' INTO payroll USING p_org,s.id;
 END IF;
 payroll_evidence:=payroll;
 IF to_regprocedure('app_private.rent_support_salary_state_before_lifecycle_v1(uuid,uuid)') IS NOT NULL THEN
 EXECUTE 'SELECT app_private.rent_support_salary_state_before_lifecycle_v1($1,$2)' INTO payroll_evidence USING p_org,s.id;
 END IF;
 -- A fully adopted bonus keeps its cancelled original voucher only as audit evidence.
 -- Net zero requires the immutable adoption and completed receipt, never cancellation alone.
 IF vh IS NOT NULL AND to_regclass('app_private.rent_support_deposit_adoptions') IS NOT NULL
 AND (f->>'settled_by_support')::boolean IS TRUE AND (f->>'reserved')::numeric=0
 AND (cash->>'verified')::boolean IS TRUE AND (cash->>'already_paid')::numeric=0
 AND v.approval_status='CANCELLED' AND v.deleted_at IS NULL
 AND NOT COALESCE((payroll_evidence->>'locked')::boolean,false) AND NOT COALESCE((payroll_evidence->>'review_required')::boolean,false)
 AND NOT COALESCE((payroll_evidence->>'pending')::boolean,false) AND NOT COALESCE((payroll_evidence->>'posted')::boolean,false) THEN
 EXECUTE 'SELECT EXISTS(SELECT 1 FROM app_private.rent_support_deposit_adoptions a
 JOIN app_private.rent_support_payout_results r ON r.organization_id=a.organization_id AND r.operation_id=a.operation_id AND r.source_id=a.source_id
 JOIN app_private.rent_support_funding_operations o ON o.organization_id=r.organization_id AND o.id=r.operation_id AND o.state=''COMPLETED''
 WHERE a.organization_id=$1 AND a.source_id=$2 AND a.original_bonus_voucher_id=$3 AND a.original_gross=$4
 AND a.after_facts_hash=$5 AND r.status=''SETTLED_BY_SUPPORT'' AND r.voucher_id IS NULL AND r.net=0
 AND r.gross=$4 AND r.withheld=$4 AND o.contract_id=$6 AND o.id=$7)'
 INTO historical_settlement USING p_org,s.id,vh,s.gross_original,md5(to_jsonb(v)::text),s.contract_id,(s.evidence->>'operation_id')::uuid;
 END IF;
 IF (f->>'verified')::boolean IS DISTINCT FROM true
 OR (vh IS NULL AND (f->>'settled_by_support')::boolean IS DISTINCT FROM true)
 OR (vh IS NOT NULL AND NOT historical_settlement AND (v.id IS NULL OR v.total_amount IS DISTINCT FROM s.gross_original-(f->>'prior_withheld')::numeric))
 THEN RAISE EXCEPTION 'Authoritative source amounts require review' USING ERRCODE='PT409';END IF;
 frozen:=EXISTS(SELECT 1 FROM app_private.rent_support_lifecycle_requests WHERE organization_id=p_org AND source_id=s.id);
 facts:=jsonb_build_object('source',s.id,'evidence',s.evidence,'gross',s.gross_original,'voucher',to_jsonb(v)-ARRAY['notes','payer_name','receive_bank_name','receive_bank_account'],'funding',f,'cash',cash,'payroll',payroll);
 RETURN jsonb_build_object('source_id',s.id,'voucher_id',vh,'gross',trim_scale(s.gross_original)::text,'withheld',COALESCE(f->>'prior_withheld','0'),
 'net',trim_scale(CASE WHEN historical_settlement THEN 0 ELSE COALESCE(v.total_amount,0) END)::text,'state',CASE WHEN frozen OR COALESCE((payroll->>'locked')::boolean,false) OR (f->>'verified')::boolean IS DISTINCT FROM true THEN 'NEEDS_REVIEW' ELSE 'READY' END,
 'proof_hash',md5(facts::text));
END $$;
CREATE OR REPLACE FUNCTION public.read_contract_rent_support_lifecycle_v1(p_organization_id uuid,p_contract_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p app_private.contract_rent_support_plans;t jsonb;consumed numeric;held numeric;src jsonb;issues jsonb:='[]';BEGIN
 PERFORM app_private.rent_support_lifecycle_authorize_v1(p_organization_id,p_contract_id,false);
 SELECT * INTO p FROM app_private.contract_rent_support_plans WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND state='ACTIVE' ORDER BY revision DESC LIMIT 1;
 t:=app_private.rent_support_termination_v1(p_organization_id,p_contract_id);
 SELECT COALESCE(sum(claimed_amount),0) INTO consumed FROM app_private.rent_support_invoice_claims WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND released_at IS NULL;
 SELECT COALESCE(jsonb_agg(app_private.rent_support_lifecycle_source_v1(p_organization_id,id) ORDER BY id),'[]') INTO src
 FROM app_private.rent_support_payout_sources WHERE organization_id=p_organization_id AND contract_id=p_contract_id;
 SELECT COALESCE(sum((value->>'withheld')::numeric),0) INTO held FROM jsonb_array_elements(src);
 IF (t->>'review')::boolean OR t->>'effective_date' IS NOT NULL THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','TERMINATION_REVIEW','message','Phần hỗ trợ chưa dùng cần được đối chiếu; chưa tự hoàn hoặc tạo nợ.'));END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(src) x WHERE x->>'state'='NEEDS_REVIEW') THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','REVERSAL_REVIEW','message','Nguồn hỗ trợ đang cần đối chiếu; không tự mở lại hạn mức.'));END IF;
 RETURN jsonb_build_object('version',1,'contract_id',p_contract_id,'plan_revision',p.revision,'termination',CASE WHEN t->>'effective_date' IS NOT NULL THEN t-'review' ELSE NULL END,
 'committed',trim_scale(COALESCE(p.committed_total,0))::text,'consumed',trim_scale(consumed)::text,'unused_committed',trim_scale(greatest(held-consumed,0))::text,
 'state',CASE WHEN jsonb_array_length(issues)>0 THEN 'NEEDS_REVIEW' ELSE 'READY' END,'issues',issues,'sources',src);
END $$;
CREATE OR REPLACE FUNCTION public.request_rent_support_source_lifecycle_v1(p_organization_id uuid,p_source_id uuid,p_action text,p_expected_facts_hash text,p_reason text,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s app_private.rent_support_payout_sources;r app_private.rent_support_lifecycle_requests;facts jsonb;h text;result jsonb;BEGIN
 SELECT * INTO s FROM app_private.rent_support_payout_sources WHERE organization_id=p_organization_id AND id=p_source_id;
 PERFORM app_private.rent_support_lifecycle_authorize_v1(p_organization_id,s.contract_id,true);
 IF EXISTS(SELECT 1 FROM app_private.rent_support_source_aliases WHERE organization_id=p_organization_id AND source_id=s.id AND alias_kind='VOUCHER' AND NOT app_private.ie_supplement_can_read_v1(alias_id)) THEN RAISE EXCEPTION 'Source denied' USING ERRCODE='42501';END IF;
 IF p_action IS NULL OR p_action NOT IN ('CANCEL','RESTORE','REVISE') OR p_request_id IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 8 AND 2000 OR p_expected_facts_hash IS NULL THEN RAISE EXCEPTION 'Lifecycle intent required' USING ERRCODE='22023';END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
 PERFORM 1 FROM public.contracts WHERE organization_id=p_organization_id AND id=s.contract_id FOR UPDATE;
 PERFORM 1 FROM app_private.rent_support_payout_sources WHERE organization_id=p_organization_id AND id=s.id FOR UPDATE;
 h:=md5(jsonb_build_object('source',p_source_id,'action',p_action,'proof',p_expected_facts_hash,'reason',p_reason)::text);
 SELECT * INTO r FROM app_private.rent_support_lifecycle_requests WHERE organization_id=p_organization_id AND request_id=p_request_id;
 IF FOUND THEN IF r.payload_hash<>h THEN RAISE EXCEPTION 'Request changed' USING ERRCODE='PT409';END IF;RETURN r.result;END IF;
 facts:=app_private.rent_support_lifecycle_source_v1(p_organization_id,s.id);
 IF facts->>'proof_hash'<>p_expected_facts_hash THEN RAISE EXCEPTION 'Source changed' USING ERRCODE='PT409';END IF;
 result:=jsonb_build_object('request_id',p_request_id,'state','NEEDS_REVIEW','issue','REVERSAL_REVIEW');
 INSERT INTO app_private.rent_support_lifecycle_requests(organization_id,contract_id,source_id,actor_id,request_id,action,payload_hash,reason,proof_hash,result)
 VALUES(p_organization_id,s.contract_id,s.id,auth.uid(),p_request_id,p_action,h,p_reason,p_expected_facts_hash,result);
 RETURN result;
END $$;

-- Guard all existing writers at their first destructive data effect. No money reversal is authorized.
-- Task7 is applied first. Preserve its helpers and add only the lifecycle overlay.
DO $install$ BEGIN
 IF to_regprocedure('app_private.rent_support_salary_part_v1(uuid,uuid,date,uuid)') IS NOT NULL THEN
 IF to_regprocedure('app_private.rent_support_salary_part_before_lifecycle_v1(uuid,uuid,date,uuid)') IS NULL THEN
 ALTER FUNCTION app_private.rent_support_salary_part_v1(uuid,uuid,date,uuid) RENAME TO rent_support_salary_part_before_lifecycle_v1;
 ALTER FUNCTION app_private.rent_support_salary_source_state_v1(uuid,uuid) RENAME TO rent_support_salary_state_before_lifecycle_v1;
 END IF;
 EXECUTE $create$ CREATE OR REPLACE FUNCTION app_private.rent_support_salary_part_v1(p_org uuid,p_voucher uuid,p_period date,p_staff uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$ BEGIN
 IF EXISTS(SELECT 1 FROM app_private.rent_support_source_aliases a JOIN app_private.rent_support_lifecycle_requests r ON r.organization_id=a.organization_id AND r.source_id=a.source_id
 WHERE a.organization_id=p_org AND a.alias_kind='VOUCHER' AND a.alias_id=p_voucher) THEN RAISE EXCEPTION 'LIFECYCLE_REVIEW_REQUIRED' USING ERRCODE='PT409';END IF;
 RETURN app_private.rent_support_salary_part_before_lifecycle_v1(p_org,p_voucher,p_period,p_staff);END $body$ $create$;
 EXECUTE $create$ CREATE OR REPLACE FUNCTION app_private.rent_support_salary_source_state_v1(p_org uuid,p_source uuid)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $body$ DECLARE r jsonb;BEGIN
 r:=app_private.rent_support_salary_state_before_lifecycle_v1(p_org,p_source);
 IF EXISTS(SELECT 1 FROM app_private.rent_support_lifecycle_requests WHERE organization_id=p_org AND source_id=p_source) THEN
 r:=r||jsonb_build_object('locked',true,'review_required',true);END IF;RETURN r;END $body$ $create$;
 REVOKE ALL ON FUNCTION app_private.rent_support_salary_part_v1(uuid,uuid,date,uuid),app_private.rent_support_salary_source_state_v1(uuid,uuid),
 app_private.rent_support_salary_part_before_lifecycle_v1(uuid,uuid,date,uuid),app_private.rent_support_salary_state_before_lifecycle_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
 END IF;
END $install$;

CREATE OR REPLACE FUNCTION app_private.rent_support_voucher_lifecycle_guard_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE vid uuid;sid uuid;org uuid;destructive boolean:=false;payroll_frozen boolean:=false;BEGIN
 IF TG_TABLE_NAME='income_expenses' THEN
 vid:=OLD.id;org:=OLD.organization_id;
 destructive:=TG_OP='DELETE';
 IF TG_OP='UPDATE' THEN destructive:=(to_jsonb(NEW)->'organization_id') IS DISTINCT FROM (to_jsonb(OLD)->'organization_id')
 OR (to_jsonb(NEW)->'contract_id') IS DISTINCT FROM (to_jsonb(OLD)->'contract_id')
 OR NEW.type IS DISTINCT FROM OLD.type OR NEW.commission_kind IS DISTINCT FROM OLD.commission_kind
 OR NEW.total_amount IS DISTINCT FROM OLD.total_amount OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
 OR ((NEW.approval_status='CANCELLED') IS DISTINCT FROM (OLD.approval_status='CANCELLED'))
 OR (NEW.posting_status='REVERSED' AND OLD.posting_status IS DISTINCT FROM NEW.posting_status);END IF;
 ELSIF TG_TABLE_NAME='income_expense_items' THEN
 vid:=CASE WHEN TG_OP='INSERT' THEN NEW.income_expense_id ELSE OLD.income_expense_id END;
 destructive:=TG_OP<>'UPDATE';
 IF TG_OP='UPDATE' THEN destructive:=(to_jsonb(NEW)-ARRAY['description','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['description','updated_at']);END IF;
 ELSE
 IF TG_OP='INSERT' THEN vid:=NEW.voucher_id;org:=NEW.organization_id;destructive:=NEW.reversal_of_id IS NOT NULL;
 ELSE vid:=OLD.voucher_id;org:=OLD.organization_id;destructive:=true;END IF;
 -- Serialize with lifecycle requests before checking a pending salary payment.
 PERFORM app_private.lock_org_for_decision_v1(org);
 IF to_regclass('app_private.rent_support_salary_payments') IS NOT NULL THEN
 EXECUTE 'SELECT EXISTS(SELECT 1 FROM app_private.rent_support_salary_payments p
 JOIN app_private.rent_support_salary_parts s ON s.organization_id=p.organization_id AND s.salary_monthly_id=p.salary_monthly_id
 JOIN app_private.rent_support_lifecycle_requests r ON r.organization_id=s.organization_id AND r.source_id=s.source_id
 WHERE p.organization_id=$1 AND p.salary_voucher_id=$2)' INTO payroll_frozen USING org,vid;
 IF payroll_frozen THEN RAISE EXCEPTION 'LIFECYCLE_REVIEW_REQUIRED: dependent salary cash frozen' USING ERRCODE='PT409';END IF;
 END IF;
 END IF;
 SELECT a.source_id,a.organization_id INTO sid,org FROM app_private.rent_support_source_aliases a
 WHERE a.alias_kind='VOUCHER' AND a.alias_id=vid AND (org IS NULL OR a.organization_id=org);
 IF sid IS NULL AND TG_TABLE_NAME='income_expense_items' AND TG_OP='UPDATE' THEN
 SELECT a.source_id,a.organization_id INTO sid,org FROM app_private.rent_support_source_aliases a
 WHERE a.alias_kind='VOUCHER' AND a.alias_id=NEW.income_expense_id;END IF;
 IF sid IS NOT NULL AND (destructive OR (TG_TABLE_NAME='income_expense_postings' AND EXISTS(SELECT 1 FROM app_private.rent_support_lifecycle_requests WHERE organization_id=org AND source_id=sid))) THEN
 RAISE EXCEPTION 'REVERSAL_REVIEW: preserve authoritative support; request financial review' USING ERRCODE='PT409';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS a00_rent_support_lifecycle ON public.income_expenses;
CREATE TRIGGER a00_rent_support_lifecycle BEFORE UPDATE OR DELETE ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_voucher_lifecycle_guard_v1();
DROP TRIGGER IF EXISTS a00_rent_support_lifecycle ON public.income_expense_items;
CREATE TRIGGER a00_rent_support_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON public.income_expense_items FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_voucher_lifecycle_guard_v1();
DROP TRIGGER IF EXISTS a00_rent_support_lifecycle ON public.income_expense_postings;
CREATE TRIGGER a00_rent_support_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON public.income_expense_postings FOR EACH ROW EXECUTE FUNCTION app_private.rent_support_voucher_lifecycle_guard_v1();


CREATE OR REPLACE FUNCTION app_private.rent_support_reconciliation_entry_v1(p_org uuid,e jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v public.income_expenses;p app_private.contract_rent_support_plans;d jsonb;g numeric;h numeric;n numeric;items numeric;cash jsonb;issue text;facts jsonb;profile uuid;k text;BEGIN
 IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR NOT(e ?& ARRAY['source_id','contract_id','voucher_id','party_id','kind','gross','previous_withheld','net','documents','confirmed','expected_approval_version','expected_posting_version','reason'])
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(e) x WHERE x<>ALL(ARRAY['source_id','contract_id','voucher_id','party_id','kind','gross','previous_withheld','net','documents','confirmed','expected_approval_version','expected_posting_version','reason'])) THEN RAISE EXCEPTION 'Complete reconciliation entry required' USING ERRCODE='22023';END IF;
 PERFORM app_private.rent_support_lifecycle_authorize_v1(p_org,(e->>'contract_id')::uuid,true);
 IF NOT app_private.ie_supplement_can_read_v1((e->>'voucher_id')::uuid) THEN RAISE EXCEPTION 'Evidence denied' USING ERRCODE='42501';END IF;
 FOREACH k IN ARRAY ARRAY['gross','previous_withheld','net'] LOOP
 IF jsonb_typeof(e->k) IS DISTINCT FROM 'string' OR e->>k !~ '^[0-9]+(\.[0-9]+)?$' THEN RAISE EXCEPTION 'Invalid decimal money' USING ERRCODE='22023';END IF;END LOOP;
 IF e->>'kind' NOT IN ('COMMISSION','BONUS') OR jsonb_typeof(e->'confirmed') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(e->'documents') IS DISTINCT FROM 'array' OR jsonb_array_length(e->'documents')>20
 OR length(btrim(COALESCE(e->>'reason',''))) NOT BETWEEN 8 AND 2000
 OR e->>'expected_approval_version' !~ '^[0-9]+$' OR e->>'expected_posting_version' !~ '^[0-9]+$'
 THEN RAISE EXCEPTION 'Invalid attestation intent' USING ERRCODE='22023';END IF;
 IF (e->>'source_id')::uuid IS DISTINCT FROM app_private.rent_support_source_id_v1(p_org,(e->>'contract_id')::uuid,e->>'kind') THEN RAISE EXCEPTION 'Source identity changed' USING ERRCODE='PT409';END IF;
 g:=(e->>'gross')::numeric;h:=(e->>'previous_withheld')::numeric;n:=(e->>'net')::numeric;
 IF g<=0 OR g<>h+n THEN RAISE EXCEPTION 'Gross must equal withheld plus net' USING ERRCODE='22023';END IF;
 SELECT * INTO v FROM public.income_expenses WHERE organization_id=p_org AND id=(e->>'voucher_id')::uuid;
 IF v.id IS NULL OR v.contract_id IS DISTINCT FROM (e->>'contract_id')::uuid OR v.type<>'EXPENSE'
 OR v.commission_kind IS DISTINCT FROM (CASE WHEN e->>'kind'='COMMISSION' THEN 'broker' ELSE 'sale' END) THEN RAISE EXCEPTION 'Voucher identity denied' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM app_private.contract_rent_support_plans WHERE organization_id=p_org AND contract_id=v.contract_id AND state='ACTIVE' ORDER BY revision DESC LIMIT 1;
 IF p.id IS NULL OR p.payer<>'SALE' OR p.sale_party_id IS DISTINCT FROM (e->>'party_id')::uuid
 OR NOT app_private.rent_support_party_valid_v1(p_org,(e->>'party_id')::uuid)
 OR (h>0 AND p.deduction_policy='COMMISSION_ONLY' AND e->>'kind'<>'COMMISSION') THEN issue:='PAYEE_MISMATCH';END IF;
 IF EXISTS(SELECT 1 FROM app_private.rent_support_payout_sources WHERE organization_id=p_org AND id=(e->>'source_id')::uuid)
 OR EXISTS(SELECT 1 FROM app_private.rent_support_source_aliases WHERE organization_id=p_org AND alias_kind='VOUCHER' AND alias_id=v.id) THEN issue:='SOURCE_ALREADY_ISSUED';END IF;
 SELECT sum(amount) INTO items FROM public.income_expense_items WHERE income_expense_id=v.id;
 cash:=app_private.rent_support_voucher_cash_v1(p_org,v.id);
 IF n<=0 OR v.total_amount IS DISTINCT FROM n OR items IS DISTINCT FROM n OR v.deleted_at IS NOT NULL OR v.approval_status='CANCELLED'
 OR (cash->>'verified')::boolean IS DISTINCT FROM true OR (cash->>'already_paid')::numeric>n
 OR v.approval_version IS DISTINCT FROM (e->>'expected_approval_version')::bigint OR v.posting_version IS DISTINCT FROM (e->>'expected_posting_version')::bigint THEN issue:='ENGINE_NET_REVIEW';END IF;
 SELECT profile_id INTO profile FROM app_private.rent_support_parties WHERE organization_id=p_org AND id=(e->>'party_id')::uuid;
 IF EXISTS(SELECT 1 FROM app_private.commission_manager_links WHERE organization_id=p_org AND voucher_id=v.id AND manager_id IS DISTINCT FROM profile)
 OR EXISTS(SELECT 1 FROM app_private.salary_commission_inclusions WHERE organization_id=p_org AND voucher_id=v.id)
 OR EXISTS(SELECT 1 FROM public.salary_earning_consumptions WHERE organization_id=p_org AND source_id=v.id AND consumption_state<>'RELEASED')
 OR (v.account_id IS NOT NULL AND NOT app_private.finance_v2_is_cashbook_period_open(p_org,v.account_id,v.voucher_date)) THEN issue:='REVERSAL_REVIEW';END IF;
 IF e->'confirmed' IS DISTINCT FROM 'true'::jsonb OR jsonb_array_length(e->'documents')=0 THEN issue:='LEGACY_REVIEW';END IF;
 FOR d IN SELECT value FROM jsonb_array_elements(e->'documents') LOOP
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d ?& ARRAY['signing_id','document_id','sha256'])
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(d) x WHERE x<>ALL(ARRAY['signing_id','document_id','sha256']))
 OR d->>'sha256' !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Exact evidence document required' USING ERRCODE='22023';END IF;
 -- Stored signed lineage verifies subject/digest. Amounts remain the authorized
 -- actor's explicit attestation; no text, filename or document-data extraction.
 IF NOT EXISTS(SELECT 1 FROM public.contract_draft_signings s JOIN public.contract_draft_documents doc
 ON doc.id=s.document_id AND doc.organization_id=s.organization_id AND doc.draft_id=s.draft_id AND doc.revision=s.revision
 WHERE s.organization_id=p_org AND s.contract_id=v.contract_id AND s.id=(d->>'signing_id')::uuid
 AND s.document_id=(d->>'document_id')::uuid AND s.document_sha256=d->>'sha256' AND doc.document_sha256=d->>'sha256'
 AND s.signed_by IS NOT NULL AND doc.created_by IS NOT NULL) THEN issue:='EVIDENCE_REVIEW';END IF;
 END LOOP;
 IF p.id IS NOT NULL AND h>p.committed_total-COALESCE((SELECT sum((x->>'net_committed_withholding')::numeric) FROM jsonb_array_elements(app_private.rent_support_funding_evidence_v1(p_org,v.contract_id)->'identities') x),0) THEN issue:='COMMITMENT_REVIEW';END IF;
 facts:=jsonb_build_object('entry',e,'voucher',to_jsonb(v),'items',items,'cash',cash,'plan',p.id,'plan_revision',p.revision);
 RETURN jsonb_build_object('source_id',e->>'source_id','contract_id',v.contract_id,'voucher_id',v.id,'party_id',e->>'party_id','kind',e->>'kind','plan_id',p.id,
 'gross',trim_scale(g)::text,'previous_withheld',trim_scale(h)::text,'net',trim_scale(n)::text,'engine_net',trim_scale(v.total_amount)::text,
 'already_paid',cash->>'already_paid','state',CASE WHEN issue IS NULL THEN 'READY' ELSE 'NEEDS_REVIEW' END,'issue',issue,'proof_hash',md5(facts::text));
END $$;
CREATE OR REPLACE FUNCTION public.dry_run_rent_support_reconciliation_v1(p_organization_id uuid,p_entries jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e jsonb;r jsonb;rows jsonb:='[]';state text:='READY';g numeric:=0;h numeric:=0;n numeric:=0;BEGIN
 IF jsonb_typeof(p_entries) IS DISTINCT FROM 'array' OR jsonb_array_length(p_entries) NOT BETWEEN 1 AND 100
 OR (SELECT count(DISTINCT x->>'source_id') FROM jsonb_array_elements(p_entries) x)<>jsonb_array_length(p_entries)
 OR (SELECT count(DISTINCT x->>'voucher_id') FROM jsonb_array_elements(p_entries) x)<>jsonb_array_length(p_entries) THEN RAISE EXCEPTION 'Unique explicit batch of 1-100 entries required' USING ERRCODE='22023';END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
 r:=app_private.rent_support_reconciliation_entry_v1(p_organization_id,e);rows:=rows||jsonb_build_array(r);
 IF r->>'state'<>'READY' THEN state:='NEEDS_REVIEW';END IF;
 g:=g+(r->>'gross')::numeric;h:=h+(r->>'previous_withheld')::numeric;n:=n+(r->>'net')::numeric;
 END LOOP;
 -- Simultaneous commission+bonus attestations must not each spend the same commitment.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(rows) entryrow JOIN app_private.contract_rent_support_plans plan ON plan.id=(entryrow->>'plan_id')::uuid
 GROUP BY entryrow->>'contract_id',plan.committed_total HAVING sum((entryrow->>'previous_withheld')::numeric)>plan.committed_total) THEN
 state:='NEEDS_REVIEW';rows:=(SELECT jsonb_agg(x||jsonb_build_object('state','NEEDS_REVIEW','issue','COMMITMENT_REVIEW')) FROM jsonb_array_elements(rows) x);END IF;
 RETURN jsonb_build_object('version',1,'state',state,'batch_hash',md5(jsonb_build_object('org',p_organization_id,'entries',p_entries,'facts',rows)::text),
 'rows',rows,'totals',jsonb_build_object('gross',trim_scale(g)::text,'previous_withheld',trim_scale(h)::text,'net',trim_scale(n)::text));
END $$;
CREATE OR REPLACE FUNCTION public.apply_rent_support_reconciliation_v1(p_organization_id uuid,p_batch_hash text,p_entries jsonb,p_reason text,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE e jsonb;r jsonb;q jsonb;result jsonb;batch uuid:=gen_random_uuid();h text;old app_private.rent_support_reconciliation_batches;cid uuid;sid uuid;vid uuid;rid uuid;BEGIN
 IF p_request_id IS NULL OR p_batch_hash IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 8 AND 2000
 OR jsonb_typeof(p_entries) IS DISTINCT FROM 'array' OR jsonb_array_length(p_entries) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Explicit reconciliation intent required' USING ERRCODE='22023';END IF;
 FOR cid IN SELECT DISTINCT (x->>'contract_id')::uuid FROM jsonb_array_elements(p_entries) x ORDER BY 1 LOOP
 PERFORM app_private.rent_support_lifecycle_authorize_v1(p_organization_id,cid,true);END LOOP;
 FOR vid IN SELECT (x->>'voucher_id')::uuid FROM jsonb_array_elements(p_entries) x LOOP
 IF NOT app_private.ie_supplement_can_read_v1(vid) THEN RAISE EXCEPTION 'Evidence denied' USING ERRCODE='42501';END IF;END LOOP;
 PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
 h:=md5(jsonb_build_object('entries',p_entries,'batch_hash',p_batch_hash,'reason',p_reason)::text);
 SELECT * INTO old FROM app_private.rent_support_reconciliation_batches WHERE organization_id=p_organization_id AND request_id=p_request_id;
 IF FOUND THEN IF old.payload_hash<>h THEN RAISE EXCEPTION 'Reconciliation request changed' USING ERRCODE='PT409';END IF;RETURN old.result;END IF;
 IF NOT app_private.rent_support_writers_enabled_v1() THEN RAISE EXCEPTION 'RENT_SUPPORT_WRITERS_DISABLED' USING ERRCODE='55000';END IF;
 FOR cid IN SELECT DISTINCT (x->>'contract_id')::uuid FROM jsonb_array_elements(p_entries) x ORDER BY 1 LOOP
 PERFORM 1 FROM public.contracts WHERE organization_id=p_organization_id AND id=cid FOR UPDATE;END LOOP;
 FOR sid IN SELECT (x->>'source_id')::uuid FROM jsonb_array_elements(p_entries) x ORDER BY 1 LOOP
 PERFORM pg_advisory_xact_lock(hashtextextended('rent-support-source:'||p_organization_id::text||':'||sid::text,0));
 PERFORM 1 FROM app_private.rent_support_payout_sources WHERE organization_id=p_organization_id AND id=sid FOR UPDATE;END LOOP;
 FOR vid IN SELECT (x->>'voucher_id')::uuid FROM jsonb_array_elements(p_entries) x ORDER BY 1 LOOP
 PERFORM 1 FROM public.income_expenses WHERE organization_id=p_organization_id AND id=vid FOR UPDATE;
 PERFORM 1 FROM public.income_expense_items WHERE income_expense_id=vid ORDER BY id FOR UPDATE;END LOOP;
 q:=public.dry_run_rent_support_reconciliation_v1(p_organization_id,p_entries);
 IF q->>'batch_hash' IS DISTINCT FROM p_batch_hash THEN RAISE EXCEPTION 'Reconciliation facts changed' USING ERRCODE='PT409';END IF;
 IF q->>'state'='READY' THEN
 FOR e IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
 SELECT value INTO r FROM jsonb_array_elements(q->'rows') WHERE value->>'source_id'=e->>'source_id';rid:=gen_random_uuid();
 INSERT INTO app_private.rent_support_payout_sources(id,organization_id,contract_id,party_id,kind,gross_original,evidence,created_by)
 VALUES((e->>'source_id')::uuid,p_organization_id,(e->>'contract_id')::uuid,(e->>'party_id')::uuid,e->>'kind',(e->>'gross')::numeric,
 jsonb_build_object('reconciliation_id',rid,'provenance','MANUALLY_ATTESTED'),auth.uid());
 PERFORM app_private.rent_support_link_source_alias_v1(p_organization_id,(e->>'source_id')::uuid,CASE WHEN e->>'kind'='COMMISSION' THEN 'CONTRACT_COMMISSION' ELSE 'CONTRACT_BONUS' END,(e->>'contract_id')::uuid);
 PERFORM app_private.rent_support_link_source_alias_v1(p_organization_id,(e->>'source_id')::uuid,'VOUCHER',(e->>'voucher_id')::uuid);
 INSERT INTO app_private.rent_support_reconciliations(id,organization_id,contract_id,source_id,voucher_id,party_id,plan_id,kind,gross,withheld,net,batch_id,evidence,created_by,provenance)
 VALUES(rid,p_organization_id,(e->>'contract_id')::uuid,(e->>'source_id')::uuid,(e->>'voucher_id')::uuid,(e->>'party_id')::uuid,(r->>'plan_id')::uuid,e->>'kind',
 (e->>'gross')::numeric,(e->>'previous_withheld')::numeric,(e->>'net')::numeric,batch,jsonb_build_object('attestation',e,'engine_facts',r),auth.uid(),'MANUALLY_ATTESTED');
 END LOOP;END IF;
 result:=jsonb_build_object('version',1,'batch_id',batch,'request_id',p_request_id,'state',CASE WHEN q->>'state'='READY' THEN 'COMPLETED' ELSE 'NEEDS_REVIEW' END,'rows',q->'rows');
 INSERT INTO app_private.rent_support_reconciliation_batches(id,organization_id,actor_id,request_id,payload_hash,entries,reason,result)
 VALUES(batch,p_organization_id,auth.uid(),p_request_id,h,p_entries,p_reason,result);
 RETURN result;
END $$;

-- Compose with Task6 and Task7, retaining their original authoritative bodies.
DO $$ BEGIN
 IF to_regprocedure('app_private.rent_support_source_funding_before_lifecycle_v1(uuid,uuid)') IS NULL THEN
 ALTER FUNCTION app_private.rent_support_source_funding_evidence_v1(uuid,uuid) RENAME TO rent_support_source_funding_before_lifecycle_v1;END IF;
 IF to_regprocedure('app_private.rent_support_funding_before_lifecycle_v1(uuid,uuid)') IS NULL THEN
 ALTER FUNCTION app_private.rent_support_funding_evidence_v1(uuid,uuid) RENAME TO rent_support_funding_before_lifecycle_v1;END IF;
 IF to_regprocedure('app_private.rent_support_source_quote_before_lifecycle_v1(uuid,uuid,uuid,jsonb,numeric,jsonb)') IS NULL THEN
 ALTER FUNCTION app_private.rent_support_source_quote_v1(uuid,uuid,uuid,jsonb,numeric,jsonb) RENAME TO rent_support_source_quote_before_lifecycle_v1;END IF;
END $$;
CREATE OR REPLACE FUNCTION app_private.rent_support_source_funding_evidence_v1(p_org uuid,p_source uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r app_private.rent_support_reconciliations;BEGIN
 SELECT * INTO r FROM app_private.rent_support_reconciliations WHERE organization_id=p_org AND source_id=p_source;
 IF r.id IS NULL THEN RETURN app_private.rent_support_source_funding_before_lifecycle_v1(p_org,p_source);END IF;
 RETURN jsonb_build_object('verified',true,'provenance',r.provenance,'prior_withheld',trim_scale(r.withheld)::text,'reserved','0','settled_by_support',false,
 'reconciliation_id',r.id,'facts_hash',md5(to_jsonb(r)::text));
END $$;
CREATE OR REPLACE FUNCTION app_private.rent_support_funding_evidence_v1(p_org uuid,p_contract uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE base jsonb;extra jsonb;BEGIN
 base:=app_private.rent_support_funding_before_lifecycle_v1(p_org,p_contract);
 SELECT COALESCE(jsonb_agg(jsonb_build_object('payer',x.payer,'sale_party_id',x.sale_party_id,'deduction_policy',x.deduction_policy,'net_committed_withholding',trim_scale(x.amount)::text)),'[]') INTO extra FROM
 (SELECT p.payer,p.sale_party_id,p.deduction_policy,sum(r.withheld) amount FROM app_private.rent_support_reconciliations r
 JOIN app_private.contract_rent_support_plans p ON p.organization_id=r.organization_id AND p.id=r.plan_id
 WHERE r.organization_id=p_org AND r.contract_id=p_contract GROUP BY p.payer,p.sale_party_id,p.deduction_policy) x;
 RETURN base||jsonb_build_object('has_funding',COALESCE((base->>'has_funding')::boolean,false) OR jsonb_array_length(extra)>0,'identities',COALESCE(base->'identities','[]')||extra);
END $$;
CREATE OR REPLACE FUNCTION app_private.rent_support_source_quote_v1(p_org uuid,p_contract uuid,p_draft uuid,p_plan jsonb,p_due numeric,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q jsonb;t jsonb;issues jsonb;frozen boolean;BEGIN
 q:=app_private.rent_support_source_quote_before_lifecycle_v1(p_org,p_contract,p_draft,p_plan,p_due,p_context);issues:=q->'issues';
 IF p_contract IS NULL THEN RETURN q;END IF;
 t:=app_private.rent_support_termination_v1(p_org,p_contract);
 frozen:=EXISTS(SELECT 1 FROM app_private.rent_support_lifecycle_requests WHERE organization_id=p_org AND contract_id=p_contract);
 IF frozen THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','REVERSAL_REVIEW','message','Nguồn cần đối chiếu trước thay đổi tiền.'));END IF;
 IF (t->>'review')::boolean OR t->>'effective_date' IS NOT NULL THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','TERMINATION_REVIEW','message','Hợp đồng đã thanh lý; phần hỗ trợ chưa dùng cần xử lý.'));END IF;
 RETURN q||jsonb_build_object('issues',issues,'state',CASE WHEN jsonb_array_length(issues)>0 AND q->>'state'<>'LEGACY_REVIEW' THEN 'NEEDS_REVIEW' ELSE q->>'state' END,
 'facts_hash',md5(jsonb_build_object('original',q->>'facts_hash','termination',t,'frozen',frozen)::text));
END $$;
CREATE OR REPLACE FUNCTION public.read_rent_support_reconciliation_context_v1(p_organization_id uuid,p_contract_id uuid,p_voucher_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v public.income_expenses;p app_private.contract_rent_support_plans;k text;docs jsonb;BEGIN
 PERFORM app_private.rent_support_lifecycle_authorize_v1(p_organization_id,p_contract_id,true);
 IF NOT app_private.ie_supplement_can_read_v1(p_voucher_id) THEN RAISE EXCEPTION 'Evidence denied' USING ERRCODE='42501';END IF;
 SELECT * INTO v FROM public.income_expenses WHERE organization_id=p_organization_id AND id=p_voucher_id AND contract_id=p_contract_id;
 IF v.id IS NULL THEN RAISE EXCEPTION 'Voucher subject denied' USING ERRCODE='42501';END IF;
 IF v.type<>'EXPENSE' OR v.commission_kind IS NULL OR v.commission_kind NOT IN ('broker','sale') THEN RETURN NULL;END IF;
 SELECT * INTO p FROM app_private.contract_rent_support_plans WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND state='ACTIVE' ORDER BY revision DESC LIMIT 1;
 IF p.id IS NULL OR p.payer<>'SALE' OR EXISTS(SELECT 1 FROM app_private.rent_support_source_aliases WHERE organization_id=p_organization_id AND alias_kind='VOUCHER' AND alias_id=v.id) THEN RETURN NULL;END IF;
 k:=CASE WHEN v.commission_kind='broker' THEN 'COMMISSION' ELSE 'BONUS' END;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('signing_id',s.id,'document_id',s.document_id,'sha256',s.document_sha256) ORDER BY s.id),'[]') INTO docs
 FROM public.contract_draft_signings s JOIN public.contract_draft_documents d ON d.id=s.document_id AND d.organization_id=s.organization_id AND d.draft_id=s.draft_id AND d.revision=s.revision
 WHERE s.organization_id=p_organization_id AND s.contract_id=p_contract_id AND s.document_sha256=d.document_sha256 AND s.document_sha256 ~ '^[0-9a-f]{64}$';
 RETURN jsonb_build_object('source_id',app_private.rent_support_source_id_v1(p_organization_id,p_contract_id,k),'contract_id',p_contract_id,'voucher_id',v.id,'party_id',p.sale_party_id,'kind',k,
 'engine_net',trim_scale(v.total_amount)::text,'expected_approval_version',v.approval_version,'expected_posting_version',v.posting_version,'documents',docs);
END $$;
DO $$ DECLARE f regprocedure;BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE
 (n.nspname='app_private' AND p.proname IN ('rent_support_lifecycle_authorize_v1','rent_support_lifecycle_source_v1','rent_support_voucher_lifecycle_guard_v1',
 'invoice_rent_support_quote_before_lifecycle_v1','invoice_rent_support_restore_before_lifecycle_v1','rent_support_source_funding_before_lifecycle_v1','rent_support_funding_before_lifecycle_v1','rent_support_source_quote_before_lifecycle_v1',
 'rent_support_termination_v1','rent_support_reconciliation_entry_v1','rent_support_source_funding_evidence_v1','rent_support_funding_evidence_v1','rent_support_source_quote_v1','invoice_rent_support_quote_v1','invoice_rent_support_restore_v1'))
 OR (n.nspname='public' AND p.proname IN ('read_contract_rent_support_lifecycle_v1','read_rent_support_reconciliation_context_v1','request_rent_support_source_lifecycle_v1','dry_run_rent_support_reconciliation_v1','apply_rent_support_reconciliation_v1')) LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
 IF f::text LIKE '%read_contract_rent_support_lifecycle_v1(%' OR f::text LIKE '%read_rent_support_reconciliation_context_v1(%' OR f::text LIKE '%request_rent_support_source_lifecycle_v1(%' OR f::text LIKE '%dry_run_rent_support_reconciliation_v1(%' OR f::text LIKE '%apply_rent_support_reconciliation_v1(%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f);END IF;
 END LOOP;END $$;
