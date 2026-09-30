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
  IF (s->>'verified')::boolean IS DISTINCT FROM true THEN
   state:='LEGACY_REVIEW';available:=0;issues:=issues||jsonb_build_array(jsonb_build_object('code','LEGACY_REVIEW','message','Cần đối chiếu chứng cứ quyền lợi.'));
  END IF;
  IF p_payer='SALE' AND (s->>'party_id')::uuid IS DISTINCT FROM p_party THEN
   available:=0;issues:=issues||jsonb_build_array(jsonb_build_object('code','PAYEE_MISMATCH','message','Nguồn không thuộc người chịu hỗ trợ.'));
  END IF;
  IF COALESCE((s->>'locked')::boolean,true) THEN
   available:=0;issues:=issues||jsonb_build_array(jsonb_build_object('code','SOURCE_LOCKED','message','Nguồn đã vào kỳ khóa hoặc cần đối chiếu.'));
  END IF;
  IF reserved>0 THEN available:=0;issues:=issues||jsonb_build_array(jsonb_build_object('code','SOURCE_RESERVED','message','Nguồn đang được một thao tác khác giữ.'));END IF;
  IF p_policy='BONUS_THEN_COMMISSION' OR s->>'kind'='COMMISSION' THEN capacity:=capacity+available;END IF;
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
-- Registry and canonical providers
CREATE TABLE IF NOT EXISTS app_private.rent_support_parties (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES public.organizations(id),
 building_id uuid NOT NULL REFERENCES public.buildings(id),kind text NOT NULL CHECK(kind IN ('INTERNAL','EXTERNAL')),
 profile_id uuid REFERENCES public.profiles(id),display_name text NOT NULL CHECK(length(btrim(display_name)) BETWEEN 1 AND 200),
 verified_reason text NOT NULL CHECK(length(btrim(verified_reason)) BETWEEN 1 AND 2000),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='INTERNAL')=(profile_id IS NOT NULL)),UNIQUE(organization_id,id),UNIQUE(organization_id,profile_id)
);
CREATE TABLE IF NOT EXISTS app_private.rent_support_party_requests (
 organization_id uuid NOT NULL REFERENCES public.organizations(id),actor_id uuid NOT NULL,request_id uuid NOT NULL,
 payload_hash text NOT NULL,party_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(organization_id,actor_id,request_id),
 FOREIGN KEY(organization_id,party_id) REFERENCES app_private.rent_support_parties(organization_id,id)
);
CREATE TABLE IF NOT EXISTS app_private.rent_support_payout_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES public.organizations(id),
 contract_id uuid NOT NULL REFERENCES public.contracts(id),party_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('COMMISSION','BONUS')),
 entitlement_version bigint NOT NULL DEFAULT 1 CHECK(entitlement_version>0),gross_original numeric NOT NULL CHECK(gross_original>0 AND gross_original::text NOT IN ('NaN','Infinity','-Infinity')),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id),UNIQUE(organization_id,contract_id,kind),FOREIGN KEY(organization_id,party_id) REFERENCES app_private.rent_support_parties(organization_id,id)
);
CREATE TABLE IF NOT EXISTS app_private.rent_support_source_aliases (
 organization_id uuid NOT NULL,source_id uuid NOT NULL,alias_kind text NOT NULL CHECK(alias_kind IN ('CONTRACT_COMMISSION','CONTRACT_BONUS','VOUCHER','DEPOSIT_BONUS_CLAIM','MANAGER_COMMISSION','SALARY_INCLUSION')),
 alias_id uuid NOT NULL,period_key text NOT NULL DEFAULT '',created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,alias_kind,alias_id,period_key),
 CHECK((alias_kind='SALARY_INCLUSION' AND period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') OR (alias_kind<>'SALARY_INCLUSION' AND period_key='')),
 FOREIGN KEY(organization_id,source_id) REFERENCES app_private.rent_support_payout_sources(organization_id,id)
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['rent_support_parties','rent_support_party_requests','rent_support_payout_sources','rent_support_source_aliases'] LOOP
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
CREATE OR REPLACE FUNCTION app_private.rent_support_party_scope_v1(p_org uuid,p_building uuid,p_write boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=p_building AND b.organization_id=p_org AND NOT COALESCE(b.is_virtual,false) AND b.status='ACTIVE' AND b.deleted_at IS NULL)
 AND app_private.rent_support_scope_v1(p_org,p_building,'contracts.view') AND app_private.rent_support_scope_v1(p_org,p_building,'income_expenses.view')
 AND (NOT p_write OR app_private.rent_support_scope_v1(p_org,p_building,'income_expenses.create'));
$$;
CREATE OR REPLACE FUNCTION app_private.rent_support_party_valid_v1(p_org uuid,p_party uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM app_private.rent_support_parties p WHERE p.id=p_party AND p.organization_id=p_org AND
  (p.kind='EXTERNAL' OR EXISTS(SELECT 1 FROM public.profiles pr JOIN public.organization_memberships m ON m.user_id=pr.id
   WHERE pr.id=p.profile_id AND pr.is_active IS DISTINCT FROM false AND m.organization_id=p_org AND m.status='ACTIVE'
   AND m.valid_from<=now() AND (m.valid_to IS NULL OR m.valid_to>now()) AND m.revoked_at IS NULL)));
$$;
CREATE OR REPLACE FUNCTION public.register_rent_support_party_v1(p_organization_id uuid,p_building_id uuid,p_profile_id uuid,p_display_name text,p_reason text,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE h text;r app_private.rent_support_party_requests%ROWTYPE;p app_private.rent_support_parties%ROWTYPE;label text;
BEGIN
 IF NOT app_private.rent_support_party_scope_v1(p_organization_id,p_building_id,true) THEN RAISE EXCEPTION 'Không có quyền xác minh bên nhận.' USING ERRCODE='42501';END IF;
 IF p_request_id IS NULL OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 OR p_display_name IS NULL OR length(btrim(p_display_name)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Thiếu thông tin xác minh danh tính.' USING ERRCODE='22023';END IF;
 PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
 IF p_profile_id IS NOT NULL THEN
  SELECT pr.full_name INTO label FROM public.profiles pr WHERE pr.id=p_profile_id AND pr.is_active IS DISTINCT FROM false AND EXISTS(
   SELECT 1 FROM public.organization_memberships m WHERE m.user_id=pr.id AND m.organization_id=p_organization_id AND m.status='ACTIVE'
    AND m.valid_from<=now() AND (m.valid_to IS NULL OR m.valid_to>now()) AND m.revoked_at IS NULL);
  IF label IS NULL OR length(btrim(label))=0 THEN RAISE EXCEPTION 'Danh tính không còn là thành viên hợp lệ.' USING ERRCODE='42501';END IF;
 ELSE label:=btrim(p_display_name);END IF;
 h:=md5(jsonb_build_object('building',p_building_id,'profile',p_profile_id,'label',p_display_name,'reason',p_reason)::text);
 SELECT * INTO r FROM app_private.rent_support_party_requests WHERE organization_id=p_organization_id AND actor_id=auth.uid() AND request_id=p_request_id;
 IF FOUND THEN
  IF r.payload_hash<>h THEN RAISE EXCEPTION 'Yêu cầu đã đổi nội dung.' USING ERRCODE='PT409';END IF;
  SELECT * INTO p FROM app_private.rent_support_parties WHERE id=r.party_id AND organization_id=p_organization_id;
 ELSE
  IF p_profile_id IS NOT NULL THEN SELECT * INTO p FROM app_private.rent_support_parties WHERE organization_id=p_organization_id AND profile_id=p_profile_id;END IF;
  IF p.id IS NULL THEN
   INSERT INTO app_private.rent_support_parties(organization_id,building_id,kind,profile_id,display_name,verified_reason,created_by)
   VALUES(p_organization_id,p_building_id,CASE WHEN p_profile_id IS NULL THEN 'EXTERNAL' ELSE 'INTERNAL' END,p_profile_id,label,btrim(p_reason),auth.uid()) RETURNING * INTO p;
  END IF;
  INSERT INTO app_private.rent_support_party_requests(organization_id,actor_id,request_id,payload_hash,party_id) VALUES(p_organization_id,auth.uid(),p_request_id,h,p.id);
 END IF;
 RETURN jsonb_build_object('party_id',p.id,'kind',p.kind,'profile_id',p.profile_id,'display_name',p.display_name);
END $$;
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
 ), page AS (SELECT * FROM eligible ORDER BY display_name,party_id LIMIT p_limit OFFSET p_offset)
 SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(to_jsonb(page)) FROM page),'[]'::jsonb),'total',(SELECT count(*) FROM eligible)) INTO result;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION app_private.rent_support_link_source_alias_v1(p_org uuid,p_source uuid,p_kind text,p_alias uuid,p_period text DEFAULT '')
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s app_private.rent_support_payout_sources%ROWTYPE;found_source uuid;v public.income_expenses%ROWTYPE;profile uuid;
BEGIN
 SELECT * INTO s FROM app_private.rent_support_payout_sources WHERE organization_id=p_org AND id=p_source;
 IF s.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=s.contract_id AND c.organization_id=p_org) THEN RAISE EXCEPTION 'Source scope mismatch' USING ERRCODE='42501';END IF;
 SELECT profile_id INTO profile FROM app_private.rent_support_parties WHERE organization_id=p_org AND id=s.party_id;
 IF p_kind IN ('CONTRACT_COMMISSION','CONTRACT_BONUS') THEN
  IF p_alias<>s.contract_id OR (p_kind='CONTRACT_COMMISSION')<>(s.kind='COMMISSION') THEN RAISE EXCEPTION 'Invalid contract source alias' USING ERRCODE='23514';END IF;
 ELSIF p_kind IN ('VOUCHER','MANAGER_COMMISSION','SALARY_INCLUSION','DEPOSIT_BONUS_CLAIM') THEN
  IF p_kind='DEPOSIT_BONUS_CLAIM' THEN
   SELECT ie.* INTO v FROM app_private.sale_bonus_claims c JOIN public.income_expenses ie ON ie.id=c.bonus_voucher_id AND ie.organization_id=c.organization_id
   WHERE c.id=p_alias AND c.organization_id=p_org;
  ELSE SELECT * INTO v FROM public.income_expenses WHERE id=p_alias AND organization_id=p_org;END IF;
  IF v.id IS NULL OR v.type<>'EXPENSE' OR v.commission_kind IS DISTINCT FROM (CASE WHEN s.kind='COMMISSION' THEN 'broker' ELSE 'sale' END)
   OR (v.contract_id IS NOT NULL AND v.contract_id<>s.contract_id) OR (v.contract_id=s.contract_id OR EXISTS(SELECT 1 FROM app_private.sale_bonus_claims c JOIN public.income_expenses d ON d.id=c.deposit_voucher_id AND d.organization_id=c.organization_id
      WHERE c.organization_id=p_org AND c.bonus_voucher_id=v.id AND d.contract_id=s.contract_id)) IS DISTINCT FROM true
   THEN RAISE EXCEPTION 'Voucher source alias is not verified' USING ERRCODE='23514';END IF;
  IF p_kind='MANAGER_COMMISSION' AND NOT EXISTS(SELECT 1 FROM app_private.commission_manager_links l WHERE l.organization_id=p_org AND l.voucher_id=v.id AND l.manager_id=profile) THEN RAISE EXCEPTION 'Manager identity mismatch' USING ERRCODE='23514';END IF;
  IF p_kind='SALARY_INCLUSION' AND NOT EXISTS(SELECT 1 FROM app_private.salary_commission_inclusions i WHERE i.organization_id=p_org AND i.voucher_id=v.id AND i.staff_id=profile AND to_char(i.period_month,'YYYY-MM')=p_period) THEN RAISE EXCEPTION 'Salary identity mismatch' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'Unknown source alias' USING ERRCODE='22023';END IF;
 INSERT INTO app_private.rent_support_source_aliases(organization_id,source_id,alias_kind,alias_id,period_key,created_by)
 VALUES(p_org,p_source,p_kind,p_alias,p_period,auth.uid()) ON CONFLICT(organization_id,alias_kind,alias_id,period_key) DO NOTHING;
 SELECT source_id INTO found_source FROM app_private.rent_support_source_aliases WHERE organization_id=p_org AND alias_kind=p_kind AND alias_id=p_alias AND period_key=p_period;
 IF found_source IS DISTINCT FROM p_source THEN RAISE EXCEPTION 'Source alias already assigned' USING ERRCODE='PT409';END IF;
 RETURN found_source;
END $$;
DO $$ DECLARE f regprocedure;BEGIN
 FOREACH f IN ARRAY ARRAY['app_private.rent_support_party_scope_v1(uuid,uuid,boolean)'::regprocedure,'app_private.rent_support_party_valid_v1(uuid,uuid)'::regprocedure,'app_private.rent_support_link_source_alias_v1(uuid,uuid,text,uuid,text)'::regprocedure] LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);END LOOP;
 FOREACH f IN ARRAY ARRAY['public.register_rent_support_party_v1(uuid,uuid,uuid,text,text,uuid)'::regprocedure,'public.list_rent_support_parties_v1(uuid,uuid,integer,integer)'::regprocedure] LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,service_role',f);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f);END LOOP;
END $$;
-- Canonical source facts
CREATE OR REPLACE FUNCTION app_private.rent_support_source_id_v1(p_org uuid,p_contract uuid,p_kind text) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT md5('rent-support-source-v1|'||p_org::text||'|'||p_contract::text||'|'||p_kind)::uuid $$;
CREATE OR REPLACE FUNCTION app_private.rent_support_voucher_cash_v1(p_org uuid,p_voucher uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p record;n integer:=0;paid numeric:=0;line_sum numeric;line_count integer;invalid boolean;facts jsonb:='[]';
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.income_expenses v WHERE v.id=p_voucher AND v.organization_id=p_org AND v.type='EXPENSE') THEN RETURN jsonb_build_object('verified',false);END IF;
 FOR p IN SELECT x.* FROM public.income_expense_postings x WHERE x.organization_id=p_org AND x.voucher_id=p_voucher
  AND x.event_kind='POSTING' AND NOT EXISTS(SELECT 1 FROM public.income_expense_postings r WHERE r.reversal_of_id=x.id) ORDER BY x.id LOOP
  n:=n+1;
  SELECT count(*),sum(l.signed_amount),bool_or(l.organization_id IS DISTINCT FROM p_org OR a.organization_id IS DISTINCT FROM p_org OR a.id IS NULL OR a.is_virtual IS DISTINCT FROM false)
   INTO line_count,line_sum,invalid FROM public.income_expense_posting_lines l LEFT JOIN public.accounts a ON a.id=l.account_id WHERE l.posting_id=p.id;
  IF p.posting_subject_kind<>'VOUCHER' OR p.posting_subject_id<>p_voucher OR p.direction<>'EXPENSE' OR p.net_cash_effect>0
   OR line_count=0 OR COALESCE(invalid,true) OR line_sum IS DISTINCT FROM p.net_cash_effect
   THEN RETURN jsonb_build_object('verified',false);END IF;
  paid:=paid-p.net_cash_effect;facts:=facts||jsonb_build_array(jsonb_build_object('posting_id',p.id,'net_cash_effect',p.net_cash_effect,'line_sum',line_sum));
 END LOOP;
 -- Multiple cash generations without reversal cannot be assigned as partial entitlement.
 IF n>1 THEN RETURN jsonb_build_object('verified',false);END IF;
 RETURN jsonb_build_object('verified',true,'already_paid',trim_scale(paid)::text,'facts_hash',md5(facts::text));
END $$;
-- Task6 replaces this with authoritative immutable event/operation evidence. Unknown is not zero.
CREATE OR REPLACE FUNCTION app_private.rent_support_source_funding_evidence_v1(p_org uuid,p_source uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT jsonb_build_object('verified',false) $$;
CREATE OR REPLACE FUNCTION app_private.rent_support_payout_context_v1(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE i jsonb;BEGIN
 IF p IS NULL THEN RETURN jsonb_build_object('version',1,'intents','[]'::jsonb);END IF;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p->'intents') IS DISTINCT FROM 'array'
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('version','intents')) OR jsonb_array_length(p->'intents')>2 THEN RAISE EXCEPTION 'Invalid payout preview context' USING ERRCODE='22023';END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(p->'intents') LOOP
  IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR NOT(i ?& ARRAY['intent_id','kind','party_id','gross_amount','route','manager_id','account_id','voucher_date'])
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(i) k WHERE k NOT IN ('intent_id','kind','party_id','gross_amount','route','manager_id','account_id','voucher_date'))
   OR jsonb_typeof(i->'kind') IS DISTINCT FROM 'string' OR i->>'kind' NOT IN ('COMMISSION','BONUS') OR jsonb_typeof(i->'route') IS DISTINCT FROM 'string' OR i->>'route' NOT IN ('CASHBOOK','MANAGER_PAYROLL')
   OR jsonb_typeof(i->'gross_amount') IS DISTINCT FROM 'string' OR i->>'gross_amount' !~ '^[0-9]+(\.[0-9]+)?$' OR (i->>'gross_amount')::numeric<=0
   OR i->>'voucher_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   THEN RAISE EXCEPTION 'Invalid payout preview intent' USING ERRCODE='22023';END IF;
  IF (i->>'intent_id')::uuid IS NULL OR (i->>'party_id')::uuid IS NULL OR (i->>'voucher_date')::date IS NULL THEN RAISE EXCEPTION 'Missing payout identity' USING ERRCODE='22023';END IF;
  PERFORM (i->>'account_id')::uuid;PERFORM (i->>'manager_id')::uuid;
  IF (i->>'route'='MANAGER_PAYROLL') IS DISTINCT FROM (i->>'manager_id' IS NOT NULL) THEN RAISE EXCEPTION 'Manager route mismatch' USING ERRCODE='22023';END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value->>'kind') FROM jsonb_array_elements(p->'intents'))<>jsonb_array_length(p->'intents')
 OR (SELECT count(DISTINCT value->>'intent_id') FROM jsonb_array_elements(p->'intents'))<>jsonb_array_length(p->'intents') THEN RAISE EXCEPTION 'Repeated payout identity' USING ERRCODE='22023';END IF;
 RETURN p;
END $$;
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
    'prior_withheld',f->>'prior_withheld','reserved',f->>'reserved','verified',true,'locked',locked,'route',route,'origin','EXISTING','intent_id',i->>'intent_id'));
   fingerprints:=fingerprints||jsonb_build_array(jsonb_build_object('source',to_jsonb(s),'funding',f,'cash',cash,'locked',locked,'voucher',to_jsonb(v)-ARRAY['notes','payer_name','receive_bank_name','receive_bank_account']));
  ELSIF i IS NOT NULL THEN
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
DO $$ DECLARE f regprocedure;BEGIN
 FOREACH f IN ARRAY ARRAY['app_private.rent_support_source_id_v1(uuid,uuid,text)'::regprocedure,'app_private.rent_support_voucher_cash_v1(uuid,uuid)'::regprocedure,'app_private.rent_support_source_funding_evidence_v1(uuid,uuid)'::regprocedure,'app_private.rent_support_payout_context_v1(jsonb)'::regprocedure,'app_private.rent_support_source_quote_v1(uuid,uuid,uuid,jsonb,numeric,jsonb)'::regprocedure] LOOP
 EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f);EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);END LOOP;
END $$;
-- Public quote integration

DO $guard$ DECLARE f text; BEGIN
 f:=pg_get_functiondef('public.quote_contract_rent_support_v1(uuid,uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
 IF md5(f)<>'0b8f0c04820c286d8c62239ca1c63e76' AND position('RENT_SUPPORT_SOURCE_QUOTE_V1' in f)=0 THEN RAISE EXCEPTION 'Rent support quote definition drift';END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.quote_contract_rent_support_v1(p_organization_id uuid, p_contract_id uuid, p_draft_id uuid, p_payload jsonb, p_invoice_context jsonb, p_payout_context jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE b uuid; v jsonb; e jsonb; f jsonb; previous app_private.contract_rent_support_plans%ROWTYPE; total numeric; paid numeric:=0; due numeric; issues jsonb:='[]'; rev bigint:=0; latest_revision bigint:=0;
BEGIN
 -- RENT_SUPPORT_INVOICE_QUOTE_V1
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
 b:=app_private.rent_support_subject_v1(p_organization_id,p_contract_id,p_draft_id,true);
 -- RENT_SUPPORT_SOURCE_QUOTE_V1: invoice branch above is unchanged.
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
 f:=app_private.rent_support_source_quote_v1(p_organization_id,p_contract_id,p_draft_id,v->'payload',due,p_payout_context);
 issues:=issues||(f->'issues');
 IF NOT COALESCE((e->>'verified')::boolean,false) THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','FUNDING_PROVIDER_UNVERIFIED','message','Cần đối chiếu chứng cứ funding trước khi thực hiện.'));END IF;
 IF NOT app_private.rent_support_writers_enabled_v1() THEN issues:=issues||jsonb_build_array(jsonb_build_object('code','WRITERS_DISABLED','message','Tích hợp nguồn chi chưa được bật.'));END IF;
 RETURN v||jsonb_build_object('quote_hash',md5(jsonb_build_object('org',p_organization_id,'contract',p_contract_id,'draft',p_draft_id,'revision',rev,'latest_revision',latest_revision,'payload',v->'payload','evidence',e,'source_facts',f,'payout_context',p_payout_context)::text),
 'payload_hash',md5((v->'payload')::text),'plan_revision',rev,'due_upfront',trim_scale(due)::text,'sources',f->'sources','unallocated',f->>'unallocated','state',CASE WHEN f->>'state'='LEGACY_REVIEW' THEN 'LEGACY_REVIEW' WHEN jsonb_array_length(issues)>0 THEN 'NEEDS_REVIEW' ELSE 'READY' END,'issues',issues);
END $function$
;
ALTER FUNCTION public.quote_contract_rent_support_v1(uuid,uuid,uuid,jsonb,jsonb,jsonb) STABLE;
