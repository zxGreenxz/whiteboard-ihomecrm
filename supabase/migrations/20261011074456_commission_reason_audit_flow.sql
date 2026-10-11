-- Commission exceptions are explained by the human changing them. Evidence is
-- created by the server in the same transaction, never reconstructed for old rows.
BEGIN;

CREATE TABLE IF NOT EXISTS app_private.commission_intervention_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
 voucher_id uuid, contract_id uuid, building_id uuid, scope text NOT NULL,
 stage text NOT NULL, reason text, actor_id uuid, actor_name text,
 happened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 before_snapshot jsonb, after_snapshot jsonb, baseline jsonb,
 CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 2000)
);
CREATE INDEX IF NOT EXISTS commission_intervention_voucher_time ON app_private.commission_intervention_events(voucher_id,happened_at,id);
CREATE INDEX IF NOT EXISTS commission_intervention_basis_time ON app_private.commission_intervention_events(contract_id,building_id,happened_at);
CREATE TABLE IF NOT EXISTS app_private.commission_reason_contexts (
 context_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), xid xid8 NOT NULL, backend_pid integer NOT NULL,
 actor_id uuid NOT NULL, voucher_id uuid, contract_id uuid, kind text,
 stage text NOT NULL, reason text, baseline jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS commission_reason_context_transaction ON app_private.commission_reason_contexts(xid,backend_pid,voucher_id);
-- Even legacy direct creation/transfer paths leave no persisted authorization
-- token. Deferred cleanup runs after all nested canonical work has completed.
CREATE OR REPLACE FUNCTION app_private.commission_reason_context_cleanup_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 DELETE FROM app_private.commission_reason_contexts WHERE context_id=NEW.context_id;RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS commission_reason_context_cleanup ON app_private.commission_reason_contexts;
CREATE CONSTRAINT TRIGGER commission_reason_context_cleanup AFTER INSERT ON app_private.commission_reason_contexts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.commission_reason_context_cleanup_v1();
CREATE TABLE IF NOT EXISTS app_private.commission_request_basis (
 organization_id uuid NOT NULL, contract_id uuid NOT NULL, kind text NOT NULL, request_id uuid NOT NULL,
 actor_id uuid NOT NULL, reason text, baseline jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,contract_id,kind,request_id)
);
CREATE OR REPLACE FUNCTION app_private.commission_evidence_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 RAISE EXCEPTION 'Lịch sử hoa hồng chỉ được ghi thêm' USING ERRCODE='42501';
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['commission_intervention_events','commission_request_basis','commission_reason_contexts'] LOOP
  EXECUTE format('ALTER TABLE app_private.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON app_private.%I FROM PUBLIC,anon,authenticated,service_role',t);
  IF t<>'commission_reason_contexts' THEN
   EXECUTE format('DROP TRIGGER IF EXISTS commission_evidence_immutable ON app_private.%I',t);
   EXECUTE format('CREATE TRIGGER commission_evidence_immutable BEFORE UPDATE OR DELETE ON app_private.%I FOR EACH ROW EXECUTE FUNCTION app_private.commission_evidence_immutable_v1()',t);
   EXECUTE format('DROP TRIGGER IF EXISTS commission_evidence_no_truncate ON app_private.%I',t);
   EXECUTE format('CREATE TRIGGER commission_evidence_no_truncate BEFORE TRUNCATE ON app_private.%I FOR EACH STATEMENT EXECUTE FUNCTION app_private.commission_evidence_immutable_v1()',t);
  END IF;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app_private.commission_reason_v1(p_reason text,p_required boolean DEFAULT true) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE r text:=nullif(btrim(p_reason,E' \t\n\r'||chr(160)||chr(8203)||chr(65279)),''); BEGIN
 IF (p_required AND (r IS NULL OR length(r)<8)) OR length(r)>2000 THEN
  RAISE EXCEPTION 'Cần ghi rõ lý do thay đổi hoa hồng (từ 8 đến 2000 ký tự).' USING ERRCODE='22023'; END IF;
 RETURN r;
END $$;

-- Match differenceInMonths, including its end-of-February and one-month EOM rules.
CREATE OR REPLACE FUNCTION app_private.commission_months_v1(s date,e date) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE m integer; shifted date; adjusted date:=e; BEGIN
 IF s IS NULL OR e IS NULL OR e<s THEN RETURN 0; END IF;
 m:=(extract(year FROM e)::integer-extract(year FROM s)::integer)*12+extract(month FROM e)::integer-extract(month FROM s)::integer;
 IF m<1 THEN RETURN 0; END IF;
 IF extract(month FROM e)=2 AND extract(day FROM e)>27 THEN adjusted:=date_trunc('month',e)::date+29; END IF;
 -- JS setMonth preserves overflowing days rather than clamping them.
 shifted:=(date_trunc('month',adjusted)-make_interval(months=>m))::date+extract(day FROM adjusted)::integer-1;
 IF m=1 AND e=(date_trunc('month',e)+interval '1 month - 1 day')::date THEN RETURN 1; END IF;
 RETURN greatest(m-CASE WHEN shifted<s THEN 1 ELSE 0 END,0);
END $$;

CREATE OR REPLACE FUNCTION app_private.commission_baseline_v1(p_contract uuid,p_kind text,p_amount numeric) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE c record; tiers jsonb; tier jsonb; m integer; expected numeric; BEGIN
 SELECT ct.id,ct.organization_id,ct.start_date,ct.end_date,ct.rent_price,b.id building_id,b.commission_tiers
 INTO c FROM public.contracts ct JOIN public.rooms r ON r.id=ct.room_id AND r.organization_id=ct.organization_id
 JOIN public.buildings b ON b.id=r.building_id AND b.organization_id=ct.organization_id
 WHERE ct.id=p_contract AND ct.deleted_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Không đọc được cơ sở tính hoa hồng' USING ERRCODE='22023'; END IF;
 IF p_kind IS NULL OR p_kind NOT IN ('broker','sale') OR p_amount IS NULL OR p_amount<=0 OR p_amount::text IN('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'Dữ kiện hoa hồng không hợp lệ' USING ERRCODE='22023'; END IF;
 m:=app_private.commission_months_v1(c.start_date,c.end_date);
 tiers:=CASE WHEN jsonb_typeof(c.commission_tiers)='array' THEN c.commission_tiers ELSE '[]'::jsonb END;
 IF p_kind='broker' THEN
  SELECT value INTO tier FROM jsonb_array_elements(tiers) WITH ORDINALITY t(value,n)
   WHERE jsonb_typeof(value->'min_months')='number' AND jsonb_typeof(value->'max_months')='number' AND jsonb_typeof(value->'rate_percent')='number'
   AND m BETWEEN (value->>'min_months')::numeric AND (value->>'max_months')::numeric ORDER BY n LIMIT 1;
  IF tier IS NULL THEN
   SELECT value INTO tier FROM jsonb_array_elements(tiers) WITH ORDINALITY t(value,n)
    WHERE jsonb_typeof(value->'min_months')='number' AND jsonb_typeof(value->'max_months')='number' AND jsonb_typeof(value->'rate_percent')='number'
    ORDER BY (value->>'max_months')::numeric DESC,n LIMIT 1;
   IF m<=COALESCE((tier->>'max_months')::numeric,m) THEN tier:=NULL; END IF;
  END IF;
  IF tier IS NOT NULL THEN expected:=round(c.rent_price*(tier->>'rate_percent')::numeric/100); END IF;
 END IF;
 RETURN jsonb_build_object('source',CASE WHEN p_kind='sale' THEN 'MANUAL_SALE' ELSE 'BUILDING_TIERS' END,
  'organization_id',c.organization_id,'contract_id',c.id,'building_id',c.building_id,'kind',p_kind,
  'start_date',c.start_date,'end_date',c.end_date,'rent_price',c.rent_price,'months',m,'commission_tiers',tiers,
  'rate_percent',(tier->>'rate_percent')::numeric,'default_amount',expected,'submitted_amount',p_amount,
  'requires_reason',expected IS NULL OR expected IS DISTINCT FROM p_amount);
END $$;

CREATE OR REPLACE FUNCTION app_private.begin_commission_reason_v1(p_voucher uuid,p_contract uuid,p_kind text,p_stage text,p_reason text,p_baseline jsonb DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i uuid; BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE='42501'; END IF;
 INSERT INTO app_private.commission_reason_contexts(xid,backend_pid,actor_id,voucher_id,contract_id,kind,stage,reason,baseline)
 VALUES(pg_current_xact_id(),pg_backend_pid(),auth.uid(),p_voucher,p_contract,p_kind,p_stage,p_reason,p_baseline) RETURNING context_id INTO i;
 RETURN i;
END $$;

CREATE OR REPLACE FUNCTION app_private.is_commission_voucher_v1(p_voucher uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM public.income_expenses v WHERE v.id=p_voucher AND
  (v.commission_kind IN('broker','sale') OR v.system_source='contract.commission' OR app_private.ie_has_commission_item_v1(v.id)))
$$;

CREATE OR REPLACE FUNCTION app_private.commission_reason_snapshot_names_v1(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb:=p;room_name text;building_name text;BEGIN
 IF p IS NULL THEN RETURN NULL;END IF;
 IF p?'account_id' THEN result:=result||jsonb_build_object('account_name',(SELECT a.name FROM public.accounts a WHERE a.id=(p->>'account_id')::uuid));END IF;
 IF p?'room_id' THEN
  SELECT r.name,b.name INTO room_name,building_name FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id WHERE r.id=(p->>'room_id')::uuid;
  result:=result||jsonb_build_object('room_name',room_name,'building_name',building_name);
 END IF;
 IF p?'building_id' THEN result:=result||jsonb_build_object('building_name',(SELECT b.name FROM public.buildings b WHERE b.id=(p->>'building_id')::uuid));END IF;
 IF p?'contract_id' THEN result:=result||jsonb_build_object('contract_number',(SELECT c.contract_number FROM public.contracts c WHERE c.id=(p->>'contract_id')::uuid));END IF;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION app_private.append_commission_intervention_v1(p_org uuid,p_voucher uuid,p_contract uuid,p_building uuid,p_scope text,p_stage text,p_reason text,p_before jsonb,p_after jsonb,p_baseline jsonb DEFAULT NULL) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 INSERT INTO app_private.commission_intervention_events(organization_id,voucher_id,contract_id,building_id,scope,stage,reason,actor_id,actor_name,before_snapshot,after_snapshot,baseline)
 VALUES(p_org,p_voucher,p_contract,p_building,p_scope,p_stage,p_reason,auth.uid(),
 (SELECT nullif(btrim(full_name),'') FROM public.profiles WHERE id=auth.uid()),
 app_private.commission_reason_snapshot_names_v1(p_before),app_private.commission_reason_snapshot_names_v1(p_after),p_baseline);
END $$;

-- Every existing writer still owns authorization, locking, posting and idempotency.
-- A private transaction context conveys explanations; request GUCs are not trusted.
CREATE OR REPLACE FUNCTION app_private.guard_commission_intervention_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v public.income_expenses; ctx app_private.commission_reason_contexts; b jsonb; before_j jsonb; after_j jsonb; changed text[]; st text;r text;support record;saved app_private.commission_request_basis;
 business_cols constant text[]:=ARRAY['type','name','building_id','room_id','tenant_id','contract_id','payer_name','recipient_name','receive_bank_account','receive_bank_name','account_id','attachments','notes','voucher_date','business_result_accounting','total_amount','commission_kind','deleted_at','salary_staff_id'];
BEGIN
 IF TG_TABLE_NAME='income_expenses' THEN
  IF TG_OP='DELETE' THEN v:=OLD; ELSE v:=NEW; END IF;
  IF NOT COALESCE(v.commission_kind IN('broker','sale') OR v.system_source='contract.commission'
   OR (TG_OP<>'INSERT' AND (OLD.commission_kind IN('broker','sale') OR OLD.system_source='contract.commission' OR app_private.ie_has_commission_item_v1(v.id))),false) THEN RETURN COALESCE(NEW,OLD); END IF;
 ELSE
  SELECT * INTO v FROM public.income_expenses WHERE id=COALESCE(NEW.income_expense_id,OLD.income_expense_id);
  IF TG_OP='UPDATE' AND OLD.income_expense_id IS DISTINCT FROM NEW.income_expense_id
   AND (app_private.is_commission_voucher_v1(OLD.income_expense_id) OR app_private.is_commission_voucher_v1(NEW.income_expense_id)) THEN
   RAISE EXCEPTION 'Không được chuyển hạng mục hoa hồng sang phiếu khác.' USING ERRCODE='22023';END IF;
  IF NOT app_private.is_commission_voucher_v1(v.id) THEN
   -- A new commission item must not convert an ordinary/manual voucher into a
   -- commission after the header insert escaped classification.
   IF EXISTS(SELECT 1 FROM public.income_expense_types t WHERE t.id=COALESCE(NEW.income_expense_type_id,OLD.income_expense_type_id)
    AND (t.category='commission' OR lower(t.name) LIKE '%hoa hồng%' OR lower(t.name) LIKE '%thưởng sale%')) THEN
    RAISE EXCEPTION 'Hoa hồng phải lập từ luồng Hợp đồng có cơ sở và lý do; không tạo hạng mục thủ công.' USING ERRCODE='22023'; END IF;
   RETURN COALESCE(NEW,OLD);
  END IF;
 END IF;
 SELECT * INTO ctx FROM app_private.commission_reason_contexts c
 WHERE c.xid=pg_current_xact_id() AND c.backend_pid=pg_backend_pid() AND c.actor_id=auth.uid()
 AND (c.voucher_id=v.id OR (c.voucher_id IS NULL AND c.contract_id IS NOT DISTINCT FROM v.contract_id AND c.kind=v.commission_kind))
 ORDER BY c.created_at DESC,c.context_id DESC LIMIT 1;
 IF TG_TABLE_NAME='income_expenses' AND TG_OP='INSERT' THEN
  b:=ctx.baseline;
  IF b IS NULL THEN
   SELECT a.*,i.value intent INTO support FROM app_private.rent_support_payout_authorizations a
    JOIN app_private.rent_support_funding_operations o ON o.id=a.operation_id AND o.organization_id=a.organization_id
    CROSS JOIN LATERAL jsonb_array_elements(o.payload->'intents') i
    WHERE a.organization_id=v.organization_id AND a.contract_id=v.contract_id AND a.kind=v.commission_kind
    AND a.net=v.total_amount AND a.xid=pg_current_xact_id() AND a.backend_pid=pg_backend_pid()
    AND CASE WHEN i.value->>'kind'='COMMISSION' THEN 'broker' ELSE 'sale' END=v.commission_kind;
   IF FOUND THEN
    SELECT * INTO saved FROM app_private.commission_request_basis WHERE organization_id=v.organization_id AND contract_id=v.contract_id
     AND kind=v.commission_kind AND request_id=(support.intent->>'intent_id')::uuid;
    IF saved.request_id IS NULL OR saved.baseline IS DISTINCT FROM app_private.commission_baseline_v1(v.contract_id,v.commission_kind,support.gross) THEN
     RAISE EXCEPTION 'Cơ sở hoa hồng hỗ trợ đã thay đổi hoặc chưa có lý do. Lập yêu cầu mới.' USING ERRCODE='PT409'; END IF;
    b:=saved.baseline||jsonb_build_object('gross_amount',support.gross,'withheld_amount',support.gross-support.net,'submitted_amount',support.net,'support_operation_id',support.operation_id);
    ctx.reason:=saved.reason;ctx.stage:='CREATE_WITH_SUPPORT';
   END IF;
  END IF;
  IF b IS NULL THEN
   IF v.contract_id IS NULL THEN
    RAISE EXCEPTION 'Phiếu thưởng Sale cần lập qua luồng có ghi lý do.' USING ERRCODE='22023'; END IF;
   b:=app_private.commission_baseline_v1(v.contract_id,v.commission_kind,v.total_amount);
  END IF;
  r:=app_private.commission_reason_v1(ctx.reason,COALESCE((b->>'requires_reason')::boolean,true));
  IF (b->>'organization_id')::uuid IS DISTINCT FROM v.organization_id THEN RAISE EXCEPTION 'Sai tổ chức của cơ sở hoa hồng' USING ERRCODE='42501';END IF;
  IF (b->>'submitted_amount')::numeric IS DISTINCT FROM v.total_amount THEN RAISE EXCEPTION 'Số tiền khác yêu cầu hoa hồng đã lưu' USING ERRCODE='PT409'; END IF;
  PERFORM app_private.begin_commission_reason_v1(v.id,v.contract_id,v.commission_kind,COALESCE(ctx.stage,'CREATE'),r,b);
  PERFORM app_private.append_commission_intervention_v1(v.organization_id,v.id,v.contract_id,v.building_id,'VOUCHER',COALESCE(ctx.stage,'CREATE'),r,NULL,to_jsonb(v),b);
  RETURN NEW;
 END IF;
 before_j:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 after_j:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 IF TG_OP='UPDATE' THEN
  SELECT array_agg(key) INTO changed FROM jsonb_each(after_j) WHERE value IS DISTINCT FROM before_j->key;
  IF changed IS NULL THEN RETURN NEW; END IF;
  -- Ignore server housekeeping; the existing logs retain raw writer provenance.
  IF TG_TABLE_NAME='income_expenses' AND NOT(changed && (business_cols||ARRAY['approval_status','posting_status','review_state','verified_at'])) THEN RETURN NEW; END IF;
  SELECT jsonb_object_agg(k,before_j->k),jsonb_object_agg(k,after_j->k) INTO before_j,after_j FROM unnest(changed) k;
 END IF;
 st:=ctx.stage; r:=ctx.reason;
 IF ctx.stage LIKE 'CREATE%' AND TG_TABLE_NAME='income_expenses' AND TG_OP='UPDATE' THEN
  IF OLD.approval_status IS DISTINCT FROM NEW.approval_status AND NEW.approval_status='APPROVED' THEN st:='AUTO_APPROVE';
  ELSIF OLD.posting_status IS DISTINCT FROM NEW.posting_status AND NEW.posting_status='POSTED' THEN st:='AUTO_POST';END IF;
 END IF;
 IF ctx.context_id IS NULL THEN
  IF TG_TABLE_NAME='income_expenses' AND TG_OP='UPDATE'
   AND (NOT(changed&&business_cols) OR (OLD.account_id IS NULL AND NEW.approval_status='APPROVED' AND NOT(changed&&array_remove(business_cols,'account_id'))))
   AND NOT(OLD.approval_status IS DISTINCT FROM NEW.approval_status AND NEW.approval_status IN('UNAPPROVED','CANCELLED'))
   AND OLD.approval_status IS DISTINCT FROM 'CANCELLED'
   AND OLD.posting_status IS DISTINCT FROM 'REVERSED'
   AND NEW.posting_status IS DISTINCT FROM 'REVERSED' THEN
   st:=CASE WHEN OLD.approval_status IS DISTINCT FROM NEW.approval_status THEN 'APPROVE' WHEN OLD.posting_status IS DISTINCT FROM NEW.posting_status THEN 'POST' ELSE 'REVIEW' END;
   r:=NULLIF(to_jsonb(NEW)->>'review_reason','');
  ELSE
   RAISE EXCEPTION 'Can thiệp phiếu hoa hồng phải ghi lý do qua đúng luồng; không được sửa trực tiếp.' USING ERRCODE='22023';
  END IF;
 END IF;
 PERFORM app_private.append_commission_intervention_v1(v.organization_id,v.id,v.contract_id,v.building_id,
  CASE WHEN TG_TABLE_NAME='income_expenses' THEN 'VOUCHER' ELSE 'ITEM' END,st,r,before_j,after_j,ctx.baseline);
 RETURN COALESCE(NEW,OLD);
END $$;
DROP TRIGGER IF EXISTS z98_commission_reason ON public.income_expenses;
CREATE TRIGGER z98_commission_reason BEFORE INSERT OR UPDATE OR DELETE ON public.income_expenses FOR EACH ROW EXECUTE FUNCTION app_private.guard_commission_intervention_v1();
DROP TRIGGER IF EXISTS z98_commission_item_reason ON public.income_expense_items;
CREATE TRIGGER z98_commission_item_reason BEFORE INSERT OR UPDATE OR DELETE ON public.income_expense_items FOR EACH ROW EXECUTE FUNCTION app_private.guard_commission_intervention_v1();

ALTER TABLE public.buildings ADD COLUMN IF NOT EXISTS commission_change_reason text;
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS commission_change_reason text;
CREATE OR REPLACE FUNCTION app_private.guard_commission_basis_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cols text[];r text;b uuid;changed boolean;BEGIN
 IF TG_TABLE_NAME='buildings' THEN cols:=ARRAY['commission_tiers'];b:=NEW.id;
 ELSE cols:=ARRAY['rent_price','start_date','end_date','room_id'];SELECT building_id INTO b FROM public.rooms WHERE id=NEW.room_id;
 END IF;
 SELECT EXISTS(SELECT 1 FROM unnest(cols) k WHERE to_jsonb(OLD)->k IS DISTINCT FROM to_jsonb(NEW)->k) INTO changed;
 IF changed THEN
  SELECT c.reason INTO r FROM app_private.commission_reason_contexts c WHERE c.xid=pg_current_xact_id() AND c.backend_pid=pg_backend_pid()
   AND c.actor_id=auth.uid() AND c.contract_id=NEW.id AND c.stage='CONTRACT_CHANGED' ORDER BY c.created_at DESC LIMIT 1;
  r:=app_private.commission_reason_v1(COALESCE(NEW.commission_change_reason,r),true);
  PERFORM app_private.append_commission_intervention_v1(NEW.organization_id,NULL,CASE WHEN TG_TABLE_NAME='contracts' THEN NEW.id END,b,'BASIS',
   CASE WHEN TG_TABLE_NAME='buildings' THEN 'CONFIG_CHANGED' ELSE 'CONTRACT_CHANGED' END,r,
   (SELECT jsonb_object_agg(k,to_jsonb(OLD)->k) FROM unnest(cols) k)||CASE WHEN TG_TABLE_NAME='contracts' THEN jsonb_build_object('contract_number',to_jsonb(OLD)->'contract_number') ELSE jsonb_build_object('building_name',to_jsonb(OLD)->'name') END,
   (SELECT jsonb_object_agg(k,to_jsonb(NEW)->k) FROM unnest(cols) k)||CASE WHEN TG_TABLE_NAME='contracts' THEN jsonb_build_object('contract_number',to_jsonb(NEW)->'contract_number') ELSE jsonb_build_object('building_name',to_jsonb(NEW)->'name') END);
 END IF;
 NEW.commission_change_reason:=NULL; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS z98_commission_basis ON public.buildings;
CREATE TRIGGER z98_commission_basis BEFORE UPDATE ON public.buildings FOR EACH ROW EXECUTE FUNCTION app_private.guard_commission_basis_v1();
DROP TRIGGER IF EXISTS z98_commission_basis ON public.contracts;
CREATE TRIGGER z98_commission_basis BEFORE UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION app_private.guard_commission_basis_v1();

-- Public read uses the existing voucher visibility boundary, including building
-- scope, inactive memberships and hidden/deleted vouchers. No org-only shortcut.
CREATE OR REPLACE FUNCTION public.read_commission_interventions_v1(p_voucher_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v public.income_expenses;out jsonb;BEGIN
 IF auth.uid() IS NULL OR NOT COALESCE(app_private.ie_supplement_can_read_v1(p_voucher_id),false) THEN RAISE EXCEPTION 'Không có quyền xem lịch sử hoa hồng' USING ERRCODE='42501'; END IF;
 SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher_id;
 IF NOT app_private.is_commission_voucher_v1(p_voucher_id) THEN RETURN '[]'::jsonb; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',e.id,'stage',e.stage,'scope',e.scope,'reason',e.reason,
  'actor_id',e.actor_id,'actor_name',e.actor_name,'at',e.happened_at,'before',e.before_snapshot,'after',e.after_snapshot,'baseline',e.baseline)
  ORDER BY e.happened_at DESC,e.id DESC),'[]'::jsonb) INTO out
 FROM app_private.commission_intervention_events e WHERE e.organization_id=v.organization_id AND
  (e.voucher_id=v.id OR (e.scope='REQUEST' AND e.contract_id=v.contract_id AND e.baseline->>'kind'=v.commission_kind)
   OR (e.scope='BASIS' AND (e.contract_id=v.contract_id OR (e.contract_id IS NULL AND (e.building_id=v.building_id OR e.building_id IS NULL)))));
 RETURN out;
END $$;

-- WRITER ADAPTERS
DO $copy$ DECLARE pair text[];f text;BEGIN
 FOREACH pair SLICE 1 IN ARRAY ARRAY[
  ARRAY['public.prepare_commission_requests_v1(uuid,jsonb)','app_private.commission_reason_prepare_before_v1'],
  ARRAY['public.execute_commission_request_v1(uuid,uuid,text,uuid)','app_private.commission_reason_execute_before_v1'],
  ARRAY['public.list_contract_commission_followups_v2(uuid,uuid[],uuid[],integer,integer,boolean,text,text,date,date)','app_private.commission_reason_followups_before_v1'],
  ARRAY['public.revise_pending_income_expense_v1(uuid,bigint,jsonb,jsonb,text,text)','app_private.commission_reason_revise_before_v1'],
  ARRAY['public.cancel_income_expense_flex_v1(uuid,text,bigint,bigint)','app_private.commission_reason_cancel_flex_before_v1'],
  ARRAY['public.cancel_income_expense_v1(uuid,text)','app_private.commission_reason_cancel_before_v1'],
  ARRAY['public.cancel_unposted_income_expense_v2(uuid,bigint,bigint,text,text)','app_private.commission_reason_cancel_unposted_before_v1'],
  ARRAY['public.ie_compat_cancel_v2(uuid[],text)','app_private.commission_reason_compat_cancel_before_v1'],
  ARRAY['public.reverse_posted_income_expense_v2(uuid,uuid,date,text,text)','app_private.commission_reason_reverse_before_v1'],
  ARRAY['public.renew_contract(uuid,date,numeric,numeric,text)','app_private.commission_reason_renew_before_v1'],
  ARRAY['public.transfer_room(uuid,uuid,numeric,date,text)','app_private.commission_reason_transfer_room_before_v1'],
  ARRAY['public.record_contract_commission_event_v1(uuid,uuid,text,text,uuid,numeric,text)','app_private.commission_reason_event_before_v1'],
  ARRAY['app_private.rent_support_payout_context_v1(jsonb)','app_private.commission_reason_support_context_before_v1'],
  ARRAY['app_private.rent_support_adopt_deposit_v1(uuid,uuid,jsonb,numeric,jsonb)','app_private.commission_reason_adopt_deposit_before_v1'],
  ARRAY['public.execute_contract_payout_operation_v1(uuid,uuid)','app_private.commission_reason_support_execute_before_v1'],
  ARRAY['public.prepare_contract_payouts_with_support_v1(uuid,uuid,bigint,text,jsonb,uuid)','app_private.commission_reason_support_prepare_before_v1']
 ] LOOP
  IF to_regprocedure(pair[2]||substring(pair[1] FROM '\(.*$')) IS NULL THEN
   IF to_regprocedure(pair[1]) IS NULL THEN RAISE EXCEPTION 'Thiếu writer phụ thuộc: %',pair[1]; END IF;
   f:=pg_get_functiondef(pair[1]::regprocedure);
   f:=replace(f,split_part(pair[1],'(',1)||'(',pair[2]||'(');
   EXECUTE f;
  END IF;
  EXECUTE 'ALTER FUNCTION '||pair[2]||substring(pair[1] FROM '\(.*$')||' OWNER TO postgres';
  EXECUTE 'REVOKE ALL ON FUNCTION '||pair[2]||substring(pair[1] FROM '\(.*$')||' FROM PUBLIC,anon,authenticated,service_role';
 END LOOP;
END $copy$;

CREATE OR REPLACE FUNCTION app_private.save_commission_request_basis_v1(p_org uuid,p_contract uuid,p_kind text,p_request uuid,p_amount numeric,p_reason text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous app_private.commission_request_basis;old_request public.contract_commission_requests;b jsonb;r text;BEGIN
 PERFORM app_private.rent_support_payout_lock_v1(p_org,p_contract);
 PERFORM 1 FROM public.contracts WHERE id=p_contract AND organization_id=p_org FOR SHARE;
 PERFORM 1 FROM public.buildings WHERE id=(SELECT rm.building_id FROM public.contracts c JOIN public.rooms rm ON rm.id=c.room_id WHERE c.id=p_contract) FOR SHARE;
 SELECT * INTO previous FROM app_private.commission_request_basis WHERE organization_id=p_org AND contract_id=p_contract AND kind=p_kind AND request_id=p_request;
 IF FOUND THEN
  r:=app_private.commission_reason_v1(p_reason,COALESCE((previous.baseline->>'requires_reason')::boolean,true));
  IF previous.actor_id IS DISTINCT FROM auth.uid() OR previous.reason IS DISTINCT FROM r OR (previous.baseline->>'submitted_amount')::numeric IS DISTINCT FROM p_amount THEN
   RAISE EXCEPTION 'Yêu cầu đã lưu dùng nội dung hoặc lý do khác; hãy lập yêu cầu mới.' USING ERRCODE='PT409'; END IF;
  RETURN;
 END IF;
 b:=app_private.commission_baseline_v1(p_contract,p_kind,p_amount);
 SELECT * INTO old_request FROM public.contract_commission_requests WHERE organization_id=p_org AND contract_id=p_contract AND kind=p_kind
  AND request_id<>p_request AND completed_at IS NULL ORDER BY created_at DESC LIMIT 1;
 r:=app_private.commission_reason_v1(p_reason,old_request.request_id IS NOT NULL OR COALESCE((b->>'requires_reason')::boolean,true));
 INSERT INTO app_private.commission_request_basis(organization_id,contract_id,kind,request_id,actor_id,reason,baseline)
 VALUES(p_org,p_contract,p_kind,p_request,auth.uid(),r,b);
 IF old_request.request_id IS NOT NULL THEN
  PERFORM app_private.append_commission_intervention_v1(p_org,NULL,p_contract,(b->>'building_id')::uuid,'REQUEST','REPREPARE',r,
   jsonb_build_object('request_id',old_request.request_id,'amount',old_request.payload->'amount','prepared_by',old_request.actor_id),
   jsonb_build_object('request_id',p_request,'amount',p_amount),b);
 ELSE
  PERFORM app_private.append_commission_intervention_v1(p_org,NULL,p_contract,(b->>'building_id')::uuid,'REQUEST','PREPARE',r,NULL,
   jsonb_build_object('request_id',p_request,'amount',p_amount),b);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.prepare_commission_requests_v1(p_organization_id uuid,p_intents jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i jsonb;clean jsonb:='[]';result jsonb;BEGIN
 IF jsonb_typeof(p_intents) IS DISTINCT FROM 'array' OR jsonb_array_length(p_intents) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Danh sách yêu cầu không hợp lệ' USING ERRCODE='22023';END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(p_intents) ORDER BY value->>'contract_id',value->>'kind' LOOP
  IF i?'commission_reason' AND jsonb_typeof(i->'commission_reason') NOT IN('string','null') THEN RAISE EXCEPTION 'Lý do phải là nội dung văn bản' USING ERRCODE='22023';END IF;
  PERFORM app_private.save_commission_request_basis_v1(p_organization_id,(i->>'contract_id')::uuid,i->>'kind',(i->>'request_id')::uuid,(i->>'amount')::numeric,i->>'commission_reason');
  clean:=clean||jsonb_build_array(i-'commission_reason');
 END LOOP;
 result:=app_private.commission_reason_prepare_before_v1(p_organization_id,clean);
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.execute_commission_request_v1(p_organization_id uuid,p_contract_id uuid,p_kind text,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE saved app_private.commission_request_basis;req public.contract_commission_requests;fresh jsonb;ctx uuid;r jsonb;b uuid;failure text;BEGIN
 b:=app_private.rent_support_payout_lock_v1(p_organization_id,p_contract_id);
 IF p_kind IS NULL OR p_kind NOT IN('broker','sale') OR p_request_id IS NULL THEN RAISE EXCEPTION 'Yêu cầu không hợp lệ' USING ERRCODE='22023';END IF;
 -- The support bridge owns its whole bundle, including adopting a deposit
 -- bonus which intentionally has no ISSUE_NEW commission baseline.
 IF EXISTS(SELECT 1 FROM app_private.rent_support_payout_request_links WHERE organization_id=p_organization_id
  AND contract_id=p_contract_id AND kind=p_kind AND request_id=p_request_id) THEN
  RETURN app_private.commission_reason_execute_before_v1(p_organization_id,p_contract_id,p_kind,p_request_id);END IF;
 -- Keep current canonical lock order through rent_support_payout_lock_v1;
 -- request row and basis rows follow it. Completed/live lifecycles still replay.
 PERFORM pg_advisory_xact_lock(hashtext('commission:'||p_contract_id::text||':'||p_kind));
 SELECT * INTO req FROM public.contract_commission_requests WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND kind=p_kind AND request_id=p_request_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy yêu cầu đã ghi nhận' USING ERRCODE='PT409';END IF;
 IF req.completed_at IS NOT NULL OR EXISTS(SELECT 1 FROM public.contract_commission_requests prior
  WHERE prior.organization_id=p_organization_id AND prior.contract_id=p_contract_id AND prior.kind=p_kind AND prior.completed_at>=req.created_at)
  OR EXISTS(SELECT 1 FROM app_private.contract_commission_live_voucher_v1(p_organization_id,p_contract_id,p_kind)) THEN
  RETURN app_private.commission_reason_execute_before_v1(p_organization_id,p_contract_id,p_kind,p_request_id); END IF;
 SELECT * INTO saved FROM app_private.commission_request_basis WHERE organization_id=p_organization_id AND contract_id=p_contract_id AND kind=p_kind AND request_id=p_request_id;
 IF NOT FOUND THEN failure:='Yêu cầu cũ chưa có cơ sở và lý do hoa hồng. Mở lại form và lập yêu cầu mới.';
 ELSE
  PERFORM 1 FROM public.contracts WHERE id=p_contract_id AND organization_id=p_organization_id FOR SHARE;
  PERFORM 1 FROM public.buildings WHERE id=(saved.baseline->>'building_id')::uuid FOR SHARE;
  fresh:=app_private.commission_baseline_v1(p_contract_id,p_kind,(saved.baseline->>'submitted_amount')::numeric);
  IF fresh IS DISTINCT FROM saved.baseline THEN failure:='Cơ sở hoa hồng đã thay đổi. Mở lại form và lập yêu cầu mới có lý do.';END IF;
 END IF;
 IF failure IS NOT NULL THEN
  -- Match canonical execution failure: retain immutable intent and commit its
  -- FAILED evidence so every client can immediately offer an explained reprepare.
  INSERT INTO public.contract_commission_events(organization_id,contract_id,building_id,kind,action,request_id,amount,reason,actor_id,actor_name)
   VALUES(p_organization_id,p_contract_id,b,p_kind,'FAILED',p_request_id,(req.payload->>'amount')::numeric,failure,
    auth.uid(),(SELECT full_name FROM public.profiles WHERE id=auth.uid())) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('status','FAILED','id',NULL,'code',NULL);
 END IF;
 ctx:=app_private.begin_commission_reason_v1(NULL,p_contract_id,p_kind,'CREATE',saved.reason,
  saved.baseline||jsonb_build_object('prepared_by',saved.actor_id,'prepared_at',saved.created_at,'request_id',saved.request_id));
 r:=app_private.commission_reason_execute_before_v1(p_organization_id,p_contract_id,p_kind,p_request_id);
 DELETE FROM app_private.commission_reason_contexts WHERE xid=pg_current_xact_id() AND backend_pid=pg_backend_pid() AND contract_id=p_contract_id AND kind=p_kind;
 RETURN r;
END $$;

CREATE OR REPLACE FUNCTION app_private.begin_existing_commission_reason_v1(p_voucher uuid,p_stage text,p_reason text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v public.income_expenses;BEGIN
 IF NOT app_private.is_commission_voucher_v1(p_voucher) THEN RETURN NULL; END IF;
 IF auth.uid() IS NULL OR NOT(COALESCE(app_private.ie_supplement_can_read_v1(p_voucher),false)
  OR(p_stage='RESTORE' AND COALESCE(public.is_super_admin(),false))) THEN RAISE EXCEPTION 'Không có quyền xử lý phiếu hoa hồng' USING ERRCODE='42501';END IF;
 SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher;
 RETURN app_private.begin_commission_reason_v1(v.id,v.contract_id,v.commission_kind,p_stage,app_private.commission_reason_v1(p_reason,true));
END $$;

CREATE OR REPLACE FUNCTION public.revise_pending_income_expense_v1(p_voucher uuid,p_expected_approval_version bigint,p_patch jsonb,p_items jsonb DEFAULT NULL,p_reason text DEFAULT NULL,p_idempotency_key text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx uuid;r jsonb;BEGIN
 ctx:=app_private.begin_existing_commission_reason_v1(p_voucher,'EDIT_PENDING',p_reason);
 r:=app_private.commission_reason_revise_before_v1(p_voucher,p_expected_approval_version,p_patch,p_items,p_reason,p_idempotency_key);
 DELETE FROM app_private.commission_reason_contexts WHERE context_id=ctx;RETURN r;
END $$;
CREATE OR REPLACE FUNCTION public.cancel_income_expense_flex_v1(p_voucher uuid,p_reason text,p_expected_approval_version bigint DEFAULT NULL,p_expected_posting_version bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx uuid;r jsonb;BEGIN
 ctx:=app_private.begin_existing_commission_reason_v1(p_voucher,'CANCEL',p_reason);
 r:=app_private.commission_reason_cancel_flex_before_v1(p_voucher,p_reason,p_expected_approval_version,p_expected_posting_version);
 DELETE FROM app_private.commission_reason_contexts WHERE context_id=ctx;RETURN r;
END $$;
CREATE OR REPLACE FUNCTION public.cancel_income_expense_v1(p_voucher_id uuid,p_reason text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx uuid;BEGIN
 ctx:=app_private.begin_existing_commission_reason_v1(p_voucher_id,'CANCEL',p_reason);
 PERFORM app_private.commission_reason_cancel_before_v1(p_voucher_id,p_reason);
 DELETE FROM app_private.commission_reason_contexts WHERE context_id=ctx;
END $$;
CREATE OR REPLACE FUNCTION public.cancel_unposted_income_expense_v2(p_voucher uuid,p_expected_review_version bigint,p_expected_approval_version bigint,p_reason text,p_idempotency_key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx uuid;r jsonb;BEGIN
 ctx:=app_private.begin_existing_commission_reason_v1(p_voucher,'CANCEL',p_reason);
 r:=app_private.commission_reason_cancel_unposted_before_v1(p_voucher,p_expected_review_version,p_expected_approval_version,p_reason,p_idempotency_key);
 DELETE FROM app_private.commission_reason_contexts WHERE context_id=ctx;RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.intervene_commission_v1(p_voucher_id uuid,p_stage text,p_reason text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx uuid;r jsonb;before_j jsonb;after_j jsonb;v public.income_expenses;allowed text[];BEGIN
 IF auth.uid() IS NULL OR NOT(COALESCE(app_private.ie_supplement_can_read_v1(p_voucher_id),false)
  OR(p_stage='RESTORE' AND COALESCE(public.is_super_admin(),false))) THEN RAISE EXCEPTION 'Không có quyền xử lý phiếu' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR p_stage IS NULL THEN RAISE EXCEPTION 'Dữ kiện can thiệp không hợp lệ' USING ERRCODE='22023';END IF;
 allowed:=CASE p_stage
  WHEN 'EDIT_PENDING' THEN ARRAY['expected_approval_version','patch','items','idempotency_key']
  WHEN 'ASSIGN_MANAGER' THEN ARRAY['manager_id','expected_approval_version','idempotency_key']
  WHEN 'ANNOTATE' THEN ARRAY['add_attachments','remove_attachments','notes','note_mode','idempotency_key']
  WHEN 'UNAPPROVE' THEN ARRAY['expected_approval_version'] WHEN 'RESTORE' THEN ARRAY[]::text[] END;
 IF allowed IS NULL OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k<>ALL(allowed)) THEN RAISE EXCEPTION 'Giai đoạn hoặc dữ kiện can thiệp không hợp lệ' USING ERRCODE='22023';END IF;
 ctx:=app_private.begin_existing_commission_reason_v1(p_voucher_id,p_stage,p_reason);
 SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher_id;
 IF p_stage='ASSIGN_MANAGER' THEN
  SELECT to_jsonb(l) INTO before_j FROM app_private.commission_manager_links l WHERE voucher_id=p_voucher_id;
  r:=public.assign_commission_manager_v1(p_voucher_id,(p_payload->>'manager_id')::uuid,(p_payload->>'expected_approval_version')::bigint,p_payload->>'idempotency_key');
  SELECT to_jsonb(l) INTO after_j FROM app_private.commission_manager_links l WHERE voucher_id=p_voucher_id;
 ELSIF p_stage='EDIT_PENDING' THEN r:=public.revise_pending_income_expense_v1(p_voucher_id,(p_payload->>'expected_approval_version')::bigint,p_payload->'patch',p_payload->'items',p_reason,p_payload->>'idempotency_key');
 ELSIF p_stage='ANNOTATE' THEN r:=public.annotate_income_expense_v1(p_voucher_id,p_payload->'add_attachments',p_payload->'remove_attachments',p_payload->>'notes',COALESCE(p_payload->>'note_mode','REPLACE'),p_payload->>'idempotency_key');
 ELSIF p_stage='UNAPPROVE' THEN PERFORM public.unapprove_voucher(p_voucher_id,(p_payload->>'expected_approval_version')::bigint);r:=jsonb_build_object('id',p_voucher_id);
 ELSE r:=public.restore_income_expense(p_voucher_id);
 END IF;
 DELETE FROM app_private.commission_reason_contexts WHERE context_id=ctx;RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.ie_compat_cancel_v2(p_ids uuid[],p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v uuid;r jsonb;ids uuid[]:='{}';ctx uuid;BEGIN
 FOREACH v IN ARRAY p_ids LOOP ctx:=app_private.begin_existing_commission_reason_v1(v,'CANCEL',p_reason);ids:=array_append(ids,ctx);END LOOP;
 r:=app_private.commission_reason_compat_cancel_before_v1(p_ids,p_reason);
 DELETE FROM app_private.commission_reason_contexts WHERE context_id=ANY(ids);RETURN r;
END $$;
CREATE OR REPLACE FUNCTION public.reverse_posted_income_expense_v2(p_voucher uuid,p_cashbook uuid,p_posted_on date,p_reason text,p_idempotency_key text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx uuid;creation uuid;r jsonb;v public.income_expenses;b jsonb;BEGIN
 ctx:=app_private.begin_existing_commission_reason_v1(p_voucher,'REVERSE',p_reason);
 IF ctx IS NOT NULL THEN
  SELECT * INTO v FROM public.income_expenses WHERE id=p_voucher;
  b:=jsonb_build_object('source','REVERSAL','organization_id',v.organization_id,'contract_id',v.contract_id,'building_id',v.building_id,
   'kind',v.commission_kind,'default_amount',v.total_amount,'submitted_amount',v.total_amount,'requires_reason',true,'reversal_of',v.id);
  creation:=app_private.begin_commission_reason_v1(NULL,v.contract_id,v.commission_kind,'REVERSE',app_private.commission_reason_v1(p_reason,true),b);
 END IF;
 r:=app_private.commission_reason_reverse_before_v1(p_voucher,p_cashbook,p_posted_on,p_reason,p_idempotency_key);
 DELETE FROM app_private.commission_reason_contexts WHERE context_id IN(ctx,creation);RETURN r;
END $$;
CREATE OR REPLACE FUNCTION public.renew_contract(p_contract_id uuid,p_new_end_date date,p_new_rent_price numeric DEFAULT NULL,p_new_deposit numeric DEFAULT NULL,p_notes text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx uuid;r uuid;BEGIN
 ctx:=app_private.begin_commission_reason_v1(NULL,p_contract_id,NULL,'CONTRACT_CHANGED',p_notes);
 r:=app_private.commission_reason_renew_before_v1(p_contract_id,p_new_end_date,p_new_rent_price,p_new_deposit,p_notes);
 DELETE FROM app_private.commission_reason_contexts WHERE context_id=ctx;RETURN r;
END $$;
CREATE OR REPLACE FUNCTION public.transfer_room(p_contract_id uuid,p_new_room_id uuid,p_new_rent_price numeric DEFAULT NULL,p_transfer_date date DEFAULT CURRENT_DATE,p_notes text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx uuid;r uuid;BEGIN
 ctx:=app_private.begin_commission_reason_v1(NULL,p_contract_id,NULL,'CONTRACT_CHANGED',p_notes);
 r:=app_private.commission_reason_transfer_room_before_v1(p_contract_id,p_new_room_id,p_new_rent_price,p_transfer_date,p_notes);
 DELETE FROM app_private.commission_reason_contexts WHERE context_id=ctx;RETURN r;
END $$;
CREATE OR REPLACE FUNCTION public.record_contract_commission_event_v1(p_organization_id uuid,p_contract_id uuid,p_kind text,p_action text,p_request_id uuid,p_amount numeric DEFAULT NULL,p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r jsonb;b uuid;reason text:=p_reason;BEGIN
 IF p_action IN('NOT_APPLICABLE','REOPENED') THEN
  PERFORM app_private.authorize_commission_request_v1(p_organization_id,p_contract_id);
  reason:=app_private.commission_reason_v1(p_reason,true);
 END IF;
 r:=app_private.commission_reason_event_before_v1(p_organization_id,p_contract_id,p_kind,p_action,p_request_id,p_amount,reason);
 RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.create_sale_bonus_from_deposit_with_reason_v1(p_deposit_voucher_id uuid,p_amount numeric,p_commission_reason text,
 p_recipient text DEFAULT NULL,p_account_number text DEFAULT NULL,p_bank text DEFAULT NULL,p_voucher_date date DEFAULT NULL,p_account_id uuid DEFAULT NULL,p_attachments jsonb DEFAULT '[]') RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE d public.income_expenses;ctx uuid;r jsonb;b jsonb;BEGIN
 IF auth.uid() IS NULL OR NOT COALESCE(app_private.ie_supplement_can_read_v1(p_deposit_voucher_id),false) THEN RAISE EXCEPTION 'Không có quyền phiếu cọc' USING ERRCODE='42501';END IF;
 SELECT * INTO d FROM public.income_expenses WHERE id=p_deposit_voucher_id;
 b:=jsonb_build_object('source','DEPOSIT_SALE','organization_id',d.organization_id,'contract_id',d.contract_id,'building_id',d.building_id,
  'kind','sale','default_amount',NULL,'submitted_amount',p_amount,'requires_reason',true,'deposit_voucher_id',d.id);
 ctx:=app_private.begin_commission_reason_v1(NULL,d.contract_id,'sale','CREATE_FROM_DEPOSIT',app_private.commission_reason_v1(p_commission_reason,true),b);
 r:=public.create_sale_bonus_from_deposit_v1(p_deposit_voucher_id,p_amount,p_recipient,p_account_number,p_bank,p_voucher_date,p_account_id,p_attachments);
 DELETE FROM app_private.commission_reason_contexts WHERE xid=pg_current_xact_id() AND backend_pid=pg_backend_pid() AND kind='sale';RETURN r;
END $$;

CREATE OR REPLACE FUNCTION app_private.guard_commission_manager_reason_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx app_private.commission_reason_contexts;v public.income_expenses;BEGIN
 IF TG_OP='UPDATE' AND OLD.manager_id IS NOT DISTINCT FROM NEW.manager_id THEN RETURN NEW;END IF;
 SELECT * INTO v FROM public.income_expenses WHERE id=COALESCE(NEW.voucher_id,OLD.voucher_id);
 SELECT * INTO ctx FROM app_private.commission_reason_contexts c WHERE c.xid=pg_current_xact_id() AND c.backend_pid=pg_backend_pid() AND c.actor_id=auth.uid()
  AND (c.voucher_id=v.id OR(c.voucher_id IS NULL AND c.contract_id=v.contract_id AND c.kind=v.commission_kind)) ORDER BY c.created_at DESC LIMIT 1;
 IF ctx.context_id IS NULL THEN RAISE EXCEPTION 'Gán hoặc đổi quản lý nhận hoa hồng phải ghi lý do.' USING ERRCODE='22023';END IF;
 IF ctx.stage NOT IN('CREATE','CREATE_WITH_SUPPORT','CREATE_FROM_DEPOSIT') THEN PERFORM app_private.commission_reason_v1(ctx.reason,true); END IF;
 PERFORM app_private.append_commission_intervention_v1(v.organization_id,v.id,v.contract_id,v.building_id,'MANAGER',
  CASE WHEN ctx.stage LIKE 'CREATE%' THEN ctx.stage ELSE 'ASSIGN_MANAGER' END,ctx.reason,
  CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD)||jsonb_build_object('manager_name',(SELECT full_name FROM public.profiles WHERE id=OLD.manager_id)) END,
  CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW)||jsonb_build_object('manager_name',(SELECT full_name FROM public.profiles WHERE id=NEW.manager_id)) END,ctx.baseline);
 RETURN COALESCE(NEW,OLD);
END $$;
DROP TRIGGER IF EXISTS commission_manager_reason ON app_private.commission_manager_links;
CREATE TRIGGER commission_manager_reason BEFORE INSERT OR UPDATE OR DELETE ON app_private.commission_manager_links FOR EACH ROW EXECUTE FUNCTION app_private.guard_commission_manager_reason_v1();

CREATE OR REPLACE FUNCTION app_private.rent_support_adopt_deposit_v1(p_org uuid,p_operation uuid,p_intent jsonb,p_net numeric,p_before jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ctx uuid;r jsonb;BEGIN
 ctx:=app_private.begin_existing_commission_reason_v1((p_intent->>'bonus_voucher_id')::uuid,'ADOPT_DEPOSIT_BONUS',p_intent->>'reason');
 -- The canonical body still checks the saved intent, its verified claim,
 -- operation, source proof, actor, lock state and optimistic versions.
 r:=app_private.commission_reason_adopt_deposit_before_v1(p_org,p_operation,p_intent,p_net,p_before);
 DELETE FROM app_private.commission_reason_contexts WHERE context_id=ctx;RETURN r;
END $$;
REVOKE ALL ON FUNCTION app_private.rent_support_adopt_deposit_v1(uuid,uuid,jsonb,numeric,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.guard_published_commission_reason_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous jsonb;r text;BEGIN
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['status','retired_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','retired_at']) OR NEW.status<>'RETIRED' THEN
   RAISE EXCEPTION 'Cấu hình hoa hồng đã công bố phải tạo phiên bản mới có lý do.' USING ERRCODE='22023';END IF;RETURN NEW;
 END IF;
 r:=app_private.commission_reason_v1(NEW.note,true);
 EXECUTE format('SELECT jsonb_agg(to_jsonb(t)) FROM app_private.%I t WHERE organization_id=$1 AND building_id IS NOT DISTINCT FROM $2 AND effective_from_month=$3',TG_TABLE_NAME)
 INTO previous USING NEW.organization_id,NEW.building_id,NEW.effective_from_month;
 PERFORM app_private.append_commission_intervention_v1(NEW.organization_id,NULL,NULL,NEW.building_id,'BASIS',
 CASE WHEN TG_TABLE_NAME='commission_tier_versions' THEN 'PUBLISHED_TIER' ELSE 'PUBLISHED_SALE_CAP' END,r,
 jsonb_build_object('versions',COALESCE(previous,'[]'::jsonb)),to_jsonb(NEW));
 NEW.note:=r;RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS published_commission_reason ON app_private.commission_tier_versions;
CREATE TRIGGER published_commission_reason BEFORE INSERT OR UPDATE ON app_private.commission_tier_versions FOR EACH ROW EXECUTE FUNCTION app_private.guard_published_commission_reason_v1();
DROP TRIGGER IF EXISTS published_commission_reason ON app_private.sale_bonus_cap_versions;
CREATE TRIGGER published_commission_reason BEFORE INSERT OR UPDATE ON app_private.sale_bonus_cap_versions FOR EACH ROW EXECUTE FUNCTION app_private.guard_published_commission_reason_v1();

-- Transfer fees have their own authoritative basis (half the previous deposit).
-- Carry the already-entered transfer explanation through its existing writer.
DO $transfer$ DECLARE f text;anchor text:='v_result:=public.create_commission_voucher(l.new_contract_id';addition text;BEGIN
 f:=pg_get_functiondef('public.create_contract_transfer_commission_v1(uuid,uuid,bigint,uuid,uuid,text,text)'::regprocedure);
 addition:='PERFORM app_private.begin_commission_reason_v1(NULL,l.new_contract_id,''broker'',''CREATE_TRANSFER'',l.reason,jsonb_build_object(''source'',''TRANSFER_DEPOSIT'',''organization_id'',l.organization_id,''contract_id'',l.new_contract_id,''building_id'',l.building_id,''kind'',''broker'',''default_amount'',l.broker_fee,''submitted_amount'',l.broker_fee,''deposit_base'',l.deposit_base,''transfer_link_id'',l.id,''requires_reason'',false));';
 IF strpos(f,addition)=0 THEN
  IF (length(f)-length(replace(f,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'Transfer commission writer drift; review before applying';END IF;
  EXECUTE replace(f,anchor,addition||chr(10)||'    '||anchor);
 END IF;
END $transfer$;

-- Private helpers never expose an authorization context to a client.
DO $acl$ DECLARE f record;sig text;BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='app_private' AND (p.proname LIKE '%commission%reason%' OR p.proname IN('commission_evidence_immutable_v1','commission_months_v1','commission_baseline_v1','is_commission_voucher_v1','append_commission_intervention_v1','guard_commission_intervention_v1','guard_commission_basis_v1','save_commission_request_basis_v1')) LOOP
  EXECUTE 'ALTER FUNCTION '||f.signature||' OWNER TO postgres';
  EXECUTE 'REVOKE ALL ON FUNCTION '||f.signature||' FROM PUBLIC,anon,authenticated,service_role';
 END LOOP;
 FOREACH sig IN ARRAY ARRAY[
  'public.read_commission_interventions_v1(uuid)','public.intervene_commission_v1(uuid,text,text,jsonb)',
  'public.create_sale_bonus_from_deposit_with_reason_v1(uuid,numeric,text,text,text,text,date,uuid,jsonb)',
  'public.prepare_commission_requests_v1(uuid,jsonb)','public.execute_commission_request_v1(uuid,uuid,text,uuid)',
  'public.revise_pending_income_expense_v1(uuid,bigint,jsonb,jsonb,text,text)',
  'public.cancel_income_expense_flex_v1(uuid,text,bigint,bigint)','public.cancel_income_expense_v1(uuid,text)',
  'public.cancel_unposted_income_expense_v2(uuid,bigint,bigint,text,text)','public.ie_compat_cancel_v2(uuid[],text)',
  'public.reverse_posted_income_expense_v2(uuid,uuid,date,text,text)','public.renew_contract(uuid,date,numeric,numeric,text)',
  'public.transfer_room(uuid,uuid,numeric,date,text)','public.record_contract_commission_event_v1(uuid,uuid,text,text,uuid,numeric,text)',
  'public.prepare_contract_payouts_with_support_v1(uuid,uuid,bigint,text,jsonb,uuid)'] LOOP
  EXECUTE 'ALTER FUNCTION '||sig||' OWNER TO postgres';
  EXECUTE 'REVOKE ALL ON FUNCTION '||sig||' FROM PUBLIC,anon,authenticated,service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION '||sig||' TO authenticated';
 END LOOP;
END $acl$;
-- Accept and retain explanations in both support payload versions. The old
-- parser validates the unchanged financial shape, and canonical hashes include
-- the new text because the validated original payload is returned.
CREATE OR REPLACE FUNCTION app_private.rent_support_payout_context_v1(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE i jsonb;clean jsonb:='[]';BEGIN
 IF p->'version' NOT IN('2'::jsonb,'3'::jsonb) THEN RETURN app_private.commission_reason_support_context_before_v1(p);END IF;
 FOR i IN SELECT value FROM jsonb_array_elements(p->'intents') LOOP
  IF i?'commission_reason' AND jsonb_typeof(i->'commission_reason') NOT IN('string','null') THEN RAISE EXCEPTION 'Lý do phải là văn bản' USING ERRCODE='22023';END IF;
  PERFORM app_private.commission_reason_v1(i->>'commission_reason',false);
  clean:=clean||jsonb_build_array(i-'commission_reason');
 END LOOP;
 PERFORM app_private.commission_reason_support_context_before_v1(jsonb_set(p,'{intents}',clean));RETURN p;
END $$;
CREATE OR REPLACE FUNCTION public.prepare_contract_payouts_with_support_v1(p_organization_id uuid,p_contract_id uuid,p_plan_revision bigint,p_quote_hash text,p_payload jsonb,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i jsonb;r jsonb;BEGIN
 PERFORM app_private.rent_support_payout_lock_v1(p_organization_id,p_contract_id);
 PERFORM app_private.rent_support_payout_context_v1(p_payload);
 FOR i IN SELECT value FROM jsonb_array_elements(p_payload->'intents') LOOP
  IF COALESCE(i->>'action','ISSUE_NEW')='ISSUE_NEW' THEN
   PERFORM app_private.save_commission_request_basis_v1(p_organization_id,p_contract_id,CASE WHEN i->>'kind'='COMMISSION' THEN 'broker' ELSE 'sale' END,
    (i->>'intent_id')::uuid,(i->>'gross_amount')::numeric,i->>'commission_reason');
  END IF;
 END LOOP;
 r:=app_private.commission_reason_support_prepare_before_v1(p_organization_id,p_contract_id,p_plan_revision,p_quote_hash,p_payload,p_request_id);RETURN r;
END $$;
-- Validate gross intent even when support withholds the entire amount and no
-- voucher/header trigger runs. Keep the original operation auth, locks, replay
-- and financial subtransaction; failure evidence follows its canonical shape.
CREATE OR REPLACE FUNCTION public.execute_contract_payout_operation_v1(p_organization_id uuid,p_operation_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o app_private.rent_support_funding_operations;b uuid;i jsonb;k text;saved app_private.commission_request_basis;
 failure text;r jsonb;settled record;
BEGIN
 SELECT * INTO o FROM app_private.rent_support_funding_operations WHERE organization_id=p_organization_id AND id=p_operation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Saved payout operation not found' USING ERRCODE='PT409';END IF;
 b:=app_private.rent_support_payout_lock_v1(p_organization_id,o.contract_id);
 SELECT * INTO o FROM app_private.rent_support_funding_operations WHERE organization_id=p_organization_id AND id=p_operation_id FOR UPDATE;
 IF o.state='COMPLETED' THEN RETURN app_private.commission_reason_support_execute_before_v1(p_organization_id,p_operation_id);END IF;
 PERFORM 1 FROM public.buildings WHERE id=b AND organization_id=p_organization_id FOR SHARE;
 FOR i IN SELECT value FROM jsonb_array_elements(o.payload->'intents') LOOP
  IF COALESCE(i->>'action','ISSUE_NEW')='ISSUE_NEW' THEN
   k:=CASE WHEN i->>'kind'='COMMISSION' THEN 'broker' ELSE 'sale' END;
   SELECT * INTO saved FROM app_private.commission_request_basis WHERE organization_id=p_organization_id
    AND contract_id=o.contract_id AND kind=k AND request_id=(i->>'intent_id')::uuid;
   IF NOT FOUND OR saved.baseline IS DISTINCT FROM app_private.commission_baseline_v1(o.contract_id,k,(i->>'gross_amount')::numeric) THEN
    failure:='Cơ sở hoa hồng hỗ trợ đã thay đổi hoặc chưa được ghi nhận. Mở lại form và lập yêu cầu mới có lý do.';EXIT;
   END IF;
  END IF;
 END LOOP;
 IF failure IS NOT NULL THEN
  FOR i IN SELECT value FROM jsonb_array_elements(o.payload->'intents') LOOP
   INSERT INTO public.contract_commission_events(organization_id,contract_id,building_id,kind,action,request_id,amount,reason,actor_id,actor_name)
    VALUES(p_organization_id,o.contract_id,b,CASE WHEN i->>'kind'='COMMISSION' THEN 'broker' ELSE 'sale' END,'FAILED',
     (i->>'intent_id')::uuid,(i->>'gross_amount')::numeric,failure,auth.uid(),(SELECT full_name FROM public.profiles WHERE id=auth.uid())) ON CONFLICT DO NOTHING;
  END LOOP;
  INSERT INTO app_private.rent_support_payout_executions(organization_id,operation_id,executor_id,outcome,reason)
   VALUES(p_organization_id,o.id,auth.uid(),'FAILED',failure);
  RETURN jsonb_build_object('operation_id',o.id,'status','FAILED','sources','[]'::jsonb);
 END IF;
 r:=app_private.commission_reason_support_execute_before_v1(p_organization_id,p_operation_id);
 IF r->>'status'='COMPLETED' THEN
  FOR settled IN SELECT res.*,j.value intent FROM app_private.rent_support_payout_results res
   JOIN LATERAL jsonb_array_elements(o.payload->'intents') j ON COALESCE(j.value->>'action','ISSUE_NEW')='ISSUE_NEW'
   JOIN app_private.rent_support_payout_sources source ON source.id=res.source_id AND source.organization_id=res.organization_id
    AND source.kind=j.value->>'kind'
   WHERE res.organization_id=p_organization_id AND res.operation_id=o.id AND res.status='SETTLED_BY_SUPPORT' AND res.net=0 LOOP
   SELECT * INTO saved FROM app_private.commission_request_basis WHERE organization_id=p_organization_id AND contract_id=o.contract_id
    AND kind=CASE WHEN settled.intent->>'kind'='COMMISSION' THEN 'broker' ELSE 'sale' END AND request_id=(settled.intent->>'intent_id')::uuid;
   PERFORM app_private.append_commission_intervention_v1(p_organization_id,NULL,o.contract_id,b,'REQUEST','SETTLED_BY_SUPPORT',saved.reason,NULL,
    jsonb_build_object('request_id',saved.request_id,'operation_id',o.id,'gross_amount',settled.gross,'withheld_amount',settled.withheld,'net_amount',settled.net),saved.baseline);
  END LOOP;
 END IF;
 RETURN r;
END $$;
-- The stored explanation must be reviewable before execution, including failed
-- requests without a voucher. Keep the canonical reader's financial visibility:
-- scoped finance read plus author/org-wide scope until a visible voucher exists.
CREATE OR REPLACE FUNCTION public.list_contract_commission_followups_v2(
 p_organization_id uuid,p_contract_ids uuid[] DEFAULT NULL,p_building_ids uuid[] DEFAULT NULL,
 p_offset integer DEFAULT 0,p_limit integer DEFAULT 50,p_unresolved_only boolean DEFAULT false,
 p_kind text DEFAULT NULL,p_search text DEFAULT NULL,p_period_from date DEFAULT NULL,p_period_to date DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result jsonb;row_j jsonb;rows_j jsonb:='[]';preparation jsonb;finance record;ev app_private.commission_intervention_events;
BEGIN
 result:=app_private.commission_reason_followups_before_v1(p_organization_id,p_contract_ids,p_building_ids,
  p_offset,p_limit,p_unresolved_only,p_kind,p_search,p_period_from,p_period_to);
 SELECT * INTO finance FROM app_private.authorized_scope_v3('income_expenses.view',p_organization_id);
 FOR row_j IN SELECT value FROM jsonb_array_elements(result->'rows') LOOP
  preparation:=NULL;
  IF COALESCE((row_j->>'can_manage')::boolean,false) AND row_j->>'request_id' IS NOT NULL
   AND (COALESCE(finance.org_wide,false) OR (row_j->>'building_id')::uuid=ANY(finance.building_ids)) THEN
   SELECT * INTO ev FROM app_private.commission_intervention_events e
    WHERE e.organization_id=p_organization_id AND e.contract_id=(row_j->>'contract_id')::uuid
     AND e.scope='REQUEST' AND e.stage IN('PREPARE','REPREPARE')
     AND e.baseline->>'kind'=row_j->>'kind'
     AND e.after_snapshot->>'request_id'=row_j->>'request_id'
    ORDER BY e.happened_at DESC,e.id DESC LIMIT 1;
   IF FOUND AND ((row_j->>'voucher_id' IS NOT NULL)
    OR (row_j->>'state'<>'VOUCHER_CREATED' AND (COALESCE(finance.org_wide,false) OR ev.actor_id=auth.uid()))) THEN
    preparation:=jsonb_build_object('request_id',row_j->>'request_id','reason',ev.reason,
     'actor_name',ev.actor_name,'created_at',ev.happened_at,'stage',ev.stage);
   END IF;
  END IF;
  rows_j:=rows_j||jsonb_build_array(row_j||jsonb_build_object('preparation',preparation));
 END LOOP;
 RETURN jsonb_set(result,'{rows}',rows_j);
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
