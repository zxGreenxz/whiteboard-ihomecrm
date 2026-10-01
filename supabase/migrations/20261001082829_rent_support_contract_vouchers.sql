-- Sale support without a preselected payee targets canonical vouchers of the same contract.
-- Existing non-null bindings remain enforced. No historical plans or payouts are rewritten.

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

CREATE OR REPLACE FUNCTION app_private.rent_support_allocate_funding_v1(
 p_payer text,p_party uuid,p_policy text,p_total numeric,p_committed numeric,p_sources jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE s jsonb; rows jsonb:='[]'; issues jsonb:='[]'; gross numeric; paid numeric; held numeric;
 reserved numeric; remaining numeric; available numeric; due numeric; capacity numeric:=0;
 left_due numeric; take numeric; state text:='READY'; source_count integer;
BEGIN
 IF p_payer IS NULL OR p_payer NOT IN ('BUILDING','SALE') OR p_policy IS NULL OR p_policy NOT IN ('COMMISSION_ONLY','BONUS_THEN_COMMISSION')
 OR p_total IS NULL OR p_committed IS NULL OR p_total<0 OR p_committed<0
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
  IF p_payer='SALE' AND p_party IS NOT NULL AND (s->>'party_id')::uuid IS DISTINCT FROM p_party THEN
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
 OR (r.withheld>0 AND (p.payer<>'SALE' OR (p.sale_party_id IS NOT NULL AND s.party_id IS DISTINCT FROM p.sale_party_id) OR (p.deduction_policy='COMMISSION_ONLY' AND s.kind<>'COMMISSION')))
 OR h<0 OR h+reserved>s.gross_original OR r.gross<>s.gross_original
 OR r.withheld IS DISTINCT FROM h OR r.gross<>r.net+r.withheld THEN RAISE EXCEPTION 'Invalid authoritative source withholding' USING ERRCODE='23514';END IF;
 IF r.net>0 AND NOT EXISTS(SELECT 1 FROM public.income_expenses v WHERE v.organization_id=r.organization_id AND v.id=r.voucher_id AND v.contract_id=s.contract_id AND v.total_amount=r.net AND v.commission_kind=CASE WHEN s.kind='COMMISSION' THEN 'broker' ELSE 'sale' END AND v.deleted_at IS NULL AND v.approval_status<>'CANCELLED') THEN RAISE EXCEPTION 'Voucher net does not match immutable payout result' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app_private.rent_support_source_quote_core_v1(p_org uuid,p_contract uuid,p_draft uuid,p_plan jsonb,p_due numeric,p_context jsonb,p_salary_bridge boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b uuid;ctx jsonb;i jsonb;facts jsonb:='[]';issues jsonb:='[]';fingerprints jsonb:='[]';s record;v record;
 f jsonb;cash jsonb;allocated jsonb;party app_private.rent_support_parties%ROWTYPE;source_kind text;live_ids uuid[];sid uuid;
 signed boolean:=false;gross numeric;locked boolean;route text;profile uuid;
BEGIN
 b:=app_private.rent_support_subject_v1(p_org,p_contract,p_draft,true);ctx:=app_private.rent_support_payout_context_v1(p_context);
 IF p_contract IS NOT NULL THEN SELECT c.status::text<>'DRAFT' INTO signed FROM public.contracts c WHERE c.id=p_contract AND c.organization_id=p_org AND c.deleted_at IS NULL;END IF;
 IF NOT COALESCE(signed,false) THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','UNSIGNED_ENTITLEMENT','message','Quyền lợi cần hợp đồng đã ký.'));END IF;
 IF p_plan->>'payer'='SALE' AND p_plan->>'sale_party_id' IS NOT NULL AND NOT app_private.rent_support_party_in_building_v1(p_org,b,(p_plan->>'sale_party_id')::uuid) THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','PARTY_UNVERIFIED','message','Cần xác minh người chịu hỗ trợ.'));END IF;
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
  IF p_salary_bridge AND source_kind='BONUS' AND i->>'action'='ADOPT_DEPOSIT_BONUS' THEN
   f:=public.read_rent_support_deposit_candidate_v1(p_org,p_contract);
   IF f->>'state'<>'READY' OR (i-ARRAY['intent_id','reason']) IS DISTINCT FROM f->'candidate'->'intent_template' THEN
    issues:=issues||jsonb_build_array(jsonb_build_object('code','DEPOSIT_ADOPTION_REVIEW','message','Nguồn thưởng cọc cần xác minh hoặc đã đổi.'));CONTINUE;END IF;
   sid:=(i->>'source_id')::uuid;
   facts:=facts||jsonb_build_array(jsonb_build_object('source_id',sid,'kind','BONUS','party_id',i->>'party_id','gross_original',i->>'gross_amount',
    'already_paid','0','prior_withheld','0','reserved','0','verified',true,'locked',false,'route','CASHBOOK','origin','EXISTING','intent_id',i->>'intent_id'));
   fingerprints:=fingerprints||jsonb_build_array(jsonb_build_object('deposit',f,'intent',i));CONTINUE;
  END IF;
  IF p_salary_bridge AND source_kind='BONUS' AND i IS NULL AND s.id IS NULL AND cardinality(live_ids)>0 THEN
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
   IF i->>'route'='MANAGER_PAYROLL' THEN
    IF NOT p_salary_bridge THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','PAYROLL_BRIDGE_PENDING','message','Luồng lương cần được đối chiếu trước khi chi.'));
    ELSIF i->>'kind'<>'COMMISSION' OR i->>'account_id' IS NOT NULL THEN RAISE EXCEPTION 'Payroll route requires commission and server-owned book' USING ERRCODE='22023';END IF;
   END IF;
   IF source_kind='BONUS' AND app_private.sale_bonus_cap_for_v1(p_org,b,public.org_today_v1(p_org)) < (i->>'gross_amount')::numeric THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','BONUS_CAP_EXCEEDED','message','Thưởng vượt mức đã công bố.'));END IF;
   IF NOT app_private.rent_support_party_scope_v1(p_org,b,true) OR NOT(app_private.rent_support_scope_v1(p_org,b,'contracts.create') OR app_private.rent_support_scope_v1(p_org,b,'contracts.edit')) THEN RAISE EXCEPTION 'Không có quyền đề xuất nguồn chi.' USING ERRCODE='42501';END IF;
   SELECT * INTO party FROM app_private.rent_support_parties WHERE id=(i->>'party_id')::uuid AND organization_id=p_org;
   IF party.id IS NULL OR NOT app_private.rent_support_party_in_building_v1(p_org,b,party.id) THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','PARTY_UNVERIFIED','message','Cần xác minh bên nhận.'));CONTINUE;END IF;
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
   IF gross<>(i->>'gross_amount')::numeric OR gross<>held+net OR held<0 OR net<0 OR (held>0 AND (p.payer<>'SALE' OR (p.sale_party_id IS NOT NULL AND p.sale_party_id IS DISTINCT FROM (i->>'party_id')::uuid) OR (p.deduction_policy='COMMISSION_ONLY' AND i->>'kind'<>'COMMISSION'))) THEN RAISE EXCEPTION 'Source allocation mismatch' USING ERRCODE='23514';END IF;
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
