-- Bank reconciliation: source routing, immutable bank facts, manual settlement.
-- Raw payload stays encrypted. No automatic payment, no production-data seed.
CREATE TABLE IF NOT EXISTS app_private.bank_reconciliation_facts (
 event_id uuid PRIMARY KEY REFERENCES app_private.bank_inbound_events(id),
 facts jsonb NOT NULL CHECK (jsonb_typeof(facts)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS app_private.bank_reconciliation_rules (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id),
 source_id uuid NOT NULL REFERENCES app_private.bank_event_sources(id),
 event_type text NOT NULL CHECK(event_type IN ('sms.received','notification.received','email.received')),
 origin text NOT NULL CHECK(length(origin) BETWEEN 1 AND 512),
 account_hint text NOT NULL DEFAULT '', description_contains text NOT NULL DEFAULT '',
 account_id uuid NOT NULL REFERENCES public.accounts(id), method text NOT NULL CHECK(method IN ('TK','TT')),
 valid_from timestamptz NOT NULL, enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1, updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS bank_reconciliation_rules_source ON app_private.bank_reconciliation_rules(source_id);
CREATE TABLE IF NOT EXISTS app_private.bank_reconciliation_decisions (
 event_id uuid PRIMARY KEY REFERENCES app_private.bank_inbound_events(id),
 organization_id uuid NOT NULL REFERENCES public.organizations(id),
 account_id uuid NOT NULL REFERENCES public.accounts(id), method text NOT NULL CHECK(method IN ('TK','TT')),
 state text NOT NULL CHECK(state IN ('collected','linked','other','duplicate','reversed')),
 invoice_id uuid REFERENCES public.invoices(id), collection_id uuid REFERENCES public.invoice_payment_collections(id),
 related_event_id uuid REFERENCES app_private.bank_inbound_events(id),
 reason text NOT NULL, actor_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revision integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_reconciliation_one_collection
 ON app_private.bank_reconciliation_decisions(collection_id) WHERE state IN ('collected','linked');
ALTER TABLE app_private.bank_reconciliation_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.bank_reconciliation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.bank_reconciliation_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.bank_reconciliation_facts,app_private.bank_reconciliation_rules,app_private.bank_reconciliation_decisions FROM PUBLIC,anon,authenticated,service_role;
DROP POLICY IF EXISTS bank_reconciliation_rules_hide_sandbox_admin ON app_private.bank_reconciliation_rules;
CREATE POLICY bank_reconciliation_rules_hide_sandbox_admin ON app_private.bank_reconciliation_rules
 AS RESTRICTIVE FOR ALL TO authenticated
 USING (NOT COALESCE(public.is_super_admin() AND organization_id=ANY(public.sandbox_org_ids()),false));
DROP POLICY IF EXISTS bank_reconciliation_decisions_hide_sandbox_admin ON app_private.bank_reconciliation_decisions;
CREATE POLICY bank_reconciliation_decisions_hide_sandbox_admin ON app_private.bank_reconciliation_decisions
 AS RESTRICTIVE FOR ALL TO authenticated
 USING (NOT COALESCE(public.is_super_admin() AND organization_id=ANY(public.sandbox_org_ids()),false));

CREATE OR REPLACE FUNCTION app_private.bank_reconciliation_fold(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT btrim(regexp_replace(translate(lower(COALESCE(p_text,'')),
 'àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ',
 'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd'),'[^a-z0-9]+',' ','g'));
$fn$;

-- Only Edge service-role may persist facts reconstructed from authenticated, encrypted inbox rows.
CREATE OR REPLACE FUNCTION public.bank_reconciliation_cache_v1(p_event_id uuid,p_facts jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF p_event_id IS NULL OR jsonb_typeof(p_facts) IS DISTINCT FROM 'object'
  OR COALESCE(p_facts->>'direction','') NOT IN ('in','out') OR COALESCE((p_facts->>'amount')::numeric,0)<=0
  OR (p_facts->>'amount')::numeric<>trunc((p_facts->>'amount')::numeric)
  OR (p_facts->>'amount')::numeric>9999999999999 OR length(p_facts::text)>4000 THEN
  RAISE EXCEPTION 'Invalid facts' USING ERRCODE='22023'; END IF;
 INSERT INTO app_private.bank_reconciliation_facts(event_id,facts) VALUES(p_event_id,p_facts)
 ON CONFLICT(event_id) DO NOTHING;
 RETURN true;
END;
$fn$;
REVOKE ALL ON FUNCTION public.bank_reconciliation_cache_v1(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_cache_v1(uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION app_private.bank_reconciliation_route(p_org uuid,p_event uuid)
RETURNS TABLE(account_id uuid,method text,rule_ids uuid[]) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
 SELECT r.account_id,r.method,array_agg(r.id ORDER BY r.id)
 FROM app_private.bank_reconciliation_rules r
 JOIN app_private.bank_inbound_events e ON e.source_id=r.source_id AND e.id=p_event
 JOIN app_private.bank_event_sources s ON s.id=e.source_id AND s.organization_id=p_org
 JOIN app_private.bank_reconciliation_facts f ON f.event_id=e.id
 JOIN public.accounts a ON a.id=r.account_id AND a.organization_id=p_org AND a.deleted_at IS NULL AND NOT a.is_virtual
 WHERE r.organization_id=p_org AND r.enabled AND r.event_type=e.event_type
 AND r.origin=lower(f.facts->>'origin')
 AND (r.account_hint='' OR r.account_hint=f.facts->>'account')
 AND (r.description_contains='' OR strpos(app_private.bank_reconciliation_fold(f.facts->>'description'),app_private.bank_reconciliation_fold(r.description_contains))>0)
 AND COALESCE((f.facts->>'transactedAt')::timestamptz,e.occurred_at)>=r.valid_from
 GROUP BY r.account_id,r.method;
$fn$;

CREATE OR REPLACE FUNCTION app_private.bank_reconciliation_candidates(p_org uuid,p_event uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
 WITH route AS (SELECT * FROM app_private.bank_reconciliation_route(p_org,p_event)), facts AS (
 SELECT f.facts,(f.facts->>'amount')::numeric amount,
 (f.facts->>'transactedAt')::timestamptz transaction_time,
 ((f.facts->>'transactedAt')::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS transaction_day,
 app_private.bank_reconciliation_fold(f.facts->>'description') description
 FROM app_private.bank_reconciliation_facts f WHERE event_id=p_event AND f.facts->>'direction'='in'
 ), candidates AS (
 SELECT i.*,b.name building_name,r.name room_name,owner.customer_id,owner.full_name customer_name,
 f.amount-i.remaining_amount delta,
 (' '||f.description||' ') LIKE ('% '||app_private.bank_reconciliation_fold(owner.full_name)||' %') name_match,
 (' '||f.description||' ') LIKE ('% '||app_private.bank_reconciliation_fold(r.name)||' %') room_match,
 (' '||f.description||' ') LIKE ('% '||app_private.bank_reconciliation_fold(b.name)||' %') building_match
 FROM public.invoices i JOIN public.buildings b ON b.id=i.building_id AND b.organization_id=p_org AND b.deleted_at IS NULL
 JOIN public.rooms r ON r.id=i.room_id AND r.building_id=b.id
 CROSS JOIN facts f CROSS JOIN route rt
 JOIN LATERAL (
 SELECT (array_agg(c.id))[1] customer_id,(array_agg(c.full_name))[1] full_name
 FROM public.contract_customers cc JOIN public.customers c ON c.id=cc.customer_id AND c.organization_id=p_org
 WHERE cc.contract_id=i.contract_id AND cc.is_representative HAVING count(*)=1
 ) owner ON true
 WHERE (SELECT count(*) FROM route)=1 AND i.organization_id=p_org AND i.deleted_at IS NULL
 AND COALESCE(public.can_access_building(i.building_id),false)
 AND i.status IN ('APPROVED','PARTIAL_PAID','OVERDUE') AND i.remaining_amount>0
 AND abs(f.amount-i.remaining_amount)<=10000 AND f.transaction_day IS NOT NULL AND i.issue_date<=f.transaction_day AND i.created_at<=f.transaction_time
 AND rt.account_id=ANY(app_private.receiving_cashbook_ids_v1(p_org,i.building_id,rt.method,NULL))
 -- Hóa đơn đã kéo nợ vào hóa đơn khác phải xử lý ở hóa đơn nhận nợ.
 AND NOT EXISTS(SELECT 1 FROM public.invoices newer CROSS JOIN LATERAL jsonb_array_elements(COALESCE(newer.previous_debt_sources,'[]')) debt
   WHERE newer.organization_id=p_org AND newer.deleted_at IS NULL AND newer.id<>i.id
    AND newer.status NOT IN ('CANCELLED','DRAFT') AND debt->>'type'='invoice' AND debt->>'id'=i.id::text AND COALESCE((debt->>'amount')::numeric,0)>0)
 -- Tên khớp rõ một khách khác trong đúng phạm vi nhận tiền là mâu thuẫn, không cộng điểm cho tiền trùng.
 AND NOT EXISTS(SELECT 1 FROM public.invoices other
   JOIN public.contract_customers cc ON cc.contract_id=other.contract_id AND cc.is_representative
   JOIN public.customers c ON c.id=cc.customer_id AND c.organization_id=p_org
   WHERE other.organization_id=p_org AND other.deleted_at IS NULL AND c.id<>owner.customer_id
    AND COALESCE(public.can_access_building(other.building_id),false)
    AND rt.account_id=ANY(app_private.receiving_cashbook_ids_v1(p_org,other.building_id,rt.method,NULL))
    AND length(app_private.bank_reconciliation_fold(c.full_name))>=6
    AND (' '||f.description||' ') LIKE ('% '||app_private.bank_reconciliation_fold(c.full_name)||' %')
    AND (' '||f.description||' ') NOT LIKE ('% '||app_private.bank_reconciliation_fold(owner.full_name)||' %'))
 -- Nếu nội dung nêu rõ một tòa khác, không gợi ý theo tiền trùng.
 AND NOT EXISTS(SELECT 1 FROM public.buildings other WHERE other.organization_id=p_org AND other.id<>b.id AND other.deleted_at IS NULL
   AND length(app_private.bank_reconciliation_fold(other.name))>=3
   AND (' '||f.description||' ') LIKE ('% '||app_private.bank_reconciliation_fold(other.name)||' %'))
 AND NOT EXISTS(SELECT 1 FROM public.rooms other WHERE other.building_id=b.id AND other.id<>r.id AND other.deleted_at IS NULL
   AND length(app_private.bank_reconciliation_fold(other.name))>=2
   AND ((' '||f.description||' ') LIKE ('% phong '||app_private.bank_reconciliation_fold(other.name)||' %')
     OR (app_private.bank_reconciliation_fold(other.name) ~ '[a-z]' AND app_private.bank_reconciliation_fold(other.name) ~ '[0-9]'
       AND (' '||f.description||' ') LIKE ('% '||app_private.bank_reconciliation_fold(other.name)||' %'))))
 AND NOT EXISTS(SELECT 1 FROM public.invoices other WHERE other.organization_id=p_org AND other.id<>i.id AND other.invoice_number IS NOT NULL
   AND length(app_private.bank_reconciliation_fold(other.invoice_number))>=6
   AND (' '||f.description||' ') LIKE ('% '||app_private.bank_reconciliation_fold(other.invoice_number)||' %'))
 AND f.description !~ '(tien coc|dat coc|hoan coc|lai tien gui|tra lai|phi ngan hang)'
 ) SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'number',invoice_number,'building',building_name,'buildingId',building_id,
 'room',room_name,'customerId',customer_id,'customer',customer_name,'month',billing_month,'remaining',remaining_amount,'paid',paid_amount,
 'revision',adjustment_revision,'delta',delta,'nameMatch',name_match,'roomMatch',room_match,'buildingMatch',building_match,
 'hasCarriedDebt',previous_debt>0)
 ORDER BY abs(delta),name_match DESC,building_match DESC,room_match DESC,issue_date,id),'[]'::jsonb) FROM candidates;
$fn$;

CREATE OR REPLACE FUNCTION public.bank_reconciliation_v1(p_organization_id uuid,p_action text,p_input jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE actor uuid:=auth.uid(); v_event app_private.bank_inbound_events; v_facts jsonb; v_route record; rule app_private.bank_reconciliation_rules;
 v_decision app_private.bank_reconciliation_decisions; inv public.invoices; receipt public.invoice_payment_collections;
 rows_json jsonb; books jsonb; rules jsonb; candidates jsonb; existing jsonb; possible jsonb;
 route_count integer; v_event_id uuid; v_account_id uuid; v_method text; v_day date; amount numeric; result jsonb;
 chosen jsonb; expected integer; v_reason text; lim integer; skip integer;
BEGIN
 IF actor IS NULL OR NOT COALESCE(public.is_super_admin(),false) OR p_organization_id IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.organization_memberships WHERE user_id=actor AND organization_id=p_organization_id AND status='ACTIVE') THEN
  RAISE EXCEPTION 'Không có quyền đối chiếu tổ chức này' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid input' USING ERRCODE='22023'; END IF;
 IF p_action='settings' THEN
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.updated_at DESC),'[]') INTO rules FROM app_private.bank_reconciliation_rules r WHERE r.organization_id=p_organization_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'buildings',(
   SELECT COALESCE(jsonb_agg(jsonb_build_object('id',b.id,'name',b.name,'method',m.method)),'[]')
   FROM public.buildings b CROSS JOIN (VALUES('TK'),('TT')) m(method)
   WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND COALESCE(public.can_access_building(b.id),false)
   AND a.id=ANY(app_private.receiving_cashbook_ids_v1(p_organization_id,b.id,m.method,NULL))
  )) ORDER BY a.name),'[]') INTO books FROM public.accounts a
  WHERE a.organization_id=p_organization_id AND a.deleted_at IS NULL AND NOT a.is_virtual
    AND nullif(btrim(a.bank_name),'') IS NOT NULL AND nullif(btrim(a.account_number),'') IS NOT NULL;
  RETURN jsonb_build_object('rules',rules,'books',books);
 ELSIF p_action='save_rule' THEN
  PERFORM 1 FROM app_private.bank_event_sources s WHERE s.id=(p_input->>'sourceId')::uuid AND s.revoked_at IS NULL
   AND (s.organization_id IS NULL OR s.organization_id=p_organization_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Nguồn không thuộc tổ chức hoặc đã thu hồi' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.accounts a WHERE a.id=(p_input->>'accountId')::uuid AND a.organization_id=p_organization_id
   AND a.deleted_at IS NULL AND NOT a.is_virtual AND nullif(btrim(a.bank_name),'') IS NOT NULL AND nullif(btrim(a.account_number),'') IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Phải chọn sổ ngân hàng của tổ chức' USING ERRCODE='42501'; END IF;
  IF COALESCE(p_input->>'method','') NOT IN ('TK','TT') OR COALESCE(p_input->>'eventType','') NOT IN ('sms.received','notification.received','email.received')
   OR length(btrim(COALESCE(p_input->>'origin',''))) NOT BETWEEN 1 AND 512
   OR length(COALESCE(p_input->>'contains',''))>120 OR length(COALESCE(p_input->>'accountHint',''))>40
   OR (btrim(COALESCE(p_input->>'contains',''))<>'' AND app_private.bank_reconciliation_fold(p_input->>'contains')='')
   OR p_input->>'validFrom' IS NULL OR NOT isfinite((p_input->>'validFrom')::timestamptz) THEN RAISE EXCEPTION 'Cấu hình chưa hợp lệ' USING ERRCODE='22023'; END IF;
  SELECT * INTO rule FROM app_private.bank_reconciliation_rules r WHERE r.id=(p_input->>'id')::uuid FOR UPDATE;
  IF (rule.id IS NOT NULL AND (rule.organization_id<>p_organization_id OR rule.revision IS DISTINCT FROM (p_input->>'revision')::int OR rule.source_id IS DISTINCT FROM (p_input->>'sourceId')::uuid))
   OR (rule.id IS NULL AND (p_input->>'revision')::int IS DISTINCT FROM 0) THEN RAISE EXCEPTION 'Cấu hình đã thay đổi hoặc đổi nguồn của điều kiện cũ' USING ERRCODE='PT409'; END IF;
  UPDATE app_private.bank_event_sources SET organization_id=p_organization_id WHERE id=(p_input->>'sourceId')::uuid;
  INSERT INTO app_private.bank_reconciliation_rules(id,organization_id,source_id,event_type,origin,account_hint,description_contains,account_id,method,valid_from,enabled,updated_by)
  VALUES((p_input->>'id')::uuid,p_organization_id,(p_input->>'sourceId')::uuid,p_input->>'eventType',lower(btrim(p_input->>'origin')),
   btrim(COALESCE(p_input->>'accountHint','')),btrim(COALESCE(p_input->>'contains','')),(p_input->>'accountId')::uuid,p_input->>'method',
   (p_input->>'validFrom')::timestamptz,COALESCE((p_input->>'enabled')::boolean,true),actor)
  ON CONFLICT(id) DO UPDATE SET source_id=EXCLUDED.source_id,event_type=EXCLUDED.event_type,origin=EXCLUDED.origin,
   account_hint=EXCLUDED.account_hint,description_contains=EXCLUDED.description_contains,account_id=EXCLUDED.account_id,method=EXCLUDED.method,
   valid_from=EXCLUDED.valid_from,enabled=EXCLUDED.enabled,updated_by=actor,updated_at=clock_timestamp(),revision=bank_reconciliation_rules.revision+1
  RETURNING * INTO rule;
  INSERT INTO app_private.bank_event_audit(actor_id,action,source_id,detail) VALUES(actor,'reconciliation_rule',rule.source_id,to_jsonb(rule));
  RETURN jsonb_build_object('saved',true,'revision',rule.revision);
 ELSIF p_action='list' THEN
  lim:=COALESCE((p_input->>'limit')::integer,50); skip:=COALESCE((p_input->>'offset')::integer,0);
  IF lim NOT BETWEEN 1 AND 100 OR skip<0 OR skip>100000 THEN RAISE EXCEPTION 'Invalid pagination' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(jsonb_agg(x.item ORDER BY x.received_at DESC,x.id DESC),'[]') INTO rows_json FROM (
   SELECT e.id,e.received_at,jsonb_build_object('id',e.id,'sourceId',s.id,'source',s.name,'channel',e.event_type,'receivedAt',e.received_at,
    'facts',f.facts,'accountId',COALESCE(CASE WHEN d.state IN ('collected','linked','other','duplicate') THEN d.account_id END,CASE WHEN route.n=1 THEN route.account_id END),'book',a.name,'method',COALESCE(CASE WHEN d.state IN ('collected','linked','other','duplicate') THEN d.method END,CASE WHEN route.n=1 THEN route.method END),
    'state',COALESCE(d.state,CASE WHEN route.n=1 THEN 'pending' WHEN route.n>1 THEN 'conflict' ELSE 'unmapped' END),
    'revision',COALESCE(d.revision,0),'invoiceId',d.invoice_id,'collectionId',d.collection_id,'reason',d.reason) item
   FROM app_private.bank_inbound_events e JOIN app_private.bank_event_sources s ON s.id=e.source_id AND s.organization_id=p_organization_id
   JOIN app_private.bank_reconciliation_facts f ON f.event_id=e.id
   LEFT JOIN app_private.bank_reconciliation_decisions d ON d.event_id=e.id AND d.organization_id=p_organization_id
   LEFT JOIN LATERAL(SELECT count(*) n,(array_agg(r.account_id))[1] account_id,(array_agg(r.method))[1] method
     FROM app_private.bank_reconciliation_route(p_organization_id,e.id) r) route ON true
   LEFT JOIN public.accounts a ON a.id=COALESCE(CASE WHEN d.state IN ('collected','linked','other','duplicate') THEN d.account_id END,CASE WHEN route.n=1 THEN route.account_id END)
   WHERE (p_input->>'sourceId' IS NULL OR s.id=(p_input->>'sourceId')::uuid)
   AND (p_input->>'accountId' IS NULL OR a.id=(p_input->>'accountId')::uuid)
   AND (p_input->>'method' IS NULL OR COALESCE(CASE WHEN d.state IN ('collected','linked','other','duplicate') THEN d.method END,CASE WHEN route.n=1 THEN route.method END)=p_input->>'method')
   AND (p_input->>'channel' IS NULL OR e.event_type=p_input->>'channel')
   AND (p_input->>'direction' IS NULL OR f.facts->>'direction'=p_input->>'direction')
   AND (p_input->>'from' IS NULL OR (f.facts->>'transactedAt')::timestamptz>=(p_input->>'from')::timestamptz)
   AND (p_input->>'to' IS NULL OR (f.facts->>'transactedAt')::timestamptz<(p_input->>'to')::timestamptz)
   AND (p_input->>'minAmount' IS NULL OR (f.facts->>'amount')::numeric>=(p_input->>'minAmount')::numeric)
   AND (p_input->>'maxAmount' IS NULL OR (f.facts->>'amount')::numeric<=(p_input->>'maxAmount')::numeric)
   AND (p_input->>'query' IS NULL OR strpos(app_private.bank_reconciliation_fold(f.facts->>'description'),app_private.bank_reconciliation_fold(p_input->>'query'))>0)
   AND (p_input->>'state' IS NULL OR COALESCE(d.state,CASE WHEN route.n=1 THEN 'pending' WHEN route.n>1 THEN 'conflict' ELSE 'unmapped' END)=p_input->>'state')
   AND (p_input->>'buildingId' IS NULL OR EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=(p_input->>'buildingId')::uuid
      AND b.organization_id=p_organization_id AND COALESCE(public.can_access_building(b.id),false)
      AND a.id=ANY(app_private.receiving_cashbook_ids_v1(p_organization_id,b.id,COALESCE(CASE WHEN d.state IN ('collected','linked','other','duplicate') THEN d.method END,CASE WHEN route.n=1 THEN route.method END),NULL))))
   ORDER BY e.received_at DESC,e.id DESC LIMIT lim+1 OFFSET skip
  ) x;
  RETURN jsonb_build_object('events',rows_json);
 END IF;
 v_event_id:=(p_input->>'eventId')::uuid;
 -- Match ingest's source -> event order; a duplicate resend updates the existing event.
 PERFORM 1 FROM app_private.bank_event_sources s
 WHERE s.id=(SELECT source_id FROM app_private.bank_inbound_events WHERE id=v_event_id)
 AND s.organization_id=p_organization_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Không có quyền xem giao dịch' USING ERRCODE='42501'; END IF;
 SELECT ev.* INTO v_event FROM app_private.bank_inbound_events ev JOIN app_private.bank_event_sources s ON s.id=ev.source_id
 WHERE ev.id=v_event_id AND s.organization_id=p_organization_id FOR UPDATE OF ev;
 IF NOT FOUND THEN RAISE EXCEPTION 'Không có quyền xem giao dịch' USING ERRCODE='42501'; END IF;
 SELECT facts INTO v_facts FROM app_private.bank_reconciliation_facts WHERE bank_reconciliation_facts.event_id=v_event.id;
 SELECT count(*) INTO route_count FROM app_private.bank_reconciliation_route(p_organization_id,v_event.id);
 SELECT * INTO v_route FROM app_private.bank_reconciliation_route(p_organization_id,v_event.id) LIMIT 1;
 SELECT * INTO v_decision FROM app_private.bank_reconciliation_decisions WHERE bank_reconciliation_decisions.event_id=v_event.id FOR UPDATE;
 v_account_id:=COALESCE(CASE WHEN v_decision.state IN ('collected','linked','other','duplicate') THEN v_decision.account_id END,CASE WHEN route_count=1 THEN v_route.account_id END); v_method:=COALESCE(CASE WHEN v_decision.state IN ('collected','linked','other','duplicate') THEN v_decision.method END,CASE WHEN route_count=1 THEN v_route.method END);
 amount:=(v_facts->>'amount')::numeric; v_day:=((v_facts->>'transactedAt')::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
 IF p_action='detail' THEN
  candidates:=app_private.bank_reconciliation_candidates(p_organization_id,v_event.id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'invoiceId',c.invoice_id,'number',i.invoice_number,'date',c.collection_date,
   'amount',c.retained_amount,'room',r.name,'building',b.name,'alreadyLinked',EXISTS(SELECT 1 FROM app_private.bank_reconciliation_decisions bd WHERE bd.collection_id=c.id AND bd.state IN ('collected','linked')))),'[]') INTO existing
  FROM public.invoice_payment_collections c JOIN public.invoices i ON i.id=c.invoice_id AND i.organization_id=p_organization_id
  JOIN public.rooms r ON r.id=i.room_id JOIN public.buildings b ON b.id=i.building_id
  WHERE c.organization_id=p_organization_id AND c.status='ACTIVE' AND c.collection_date=v_day AND c.retained_amount=amount
   AND COALESCE(public.can_access_building(i.building_id),false)
   AND EXISTS(SELECT 1 FROM public.invoice_payment_tenders t WHERE t.collection_id=c.id AND t.account_id=v_account_id AND t.payment_method::text=v_method AND t.retained_amount=amount);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',ef.event_id,'state',COALESCE(bd.state,'pending'),'source',s.name)),'[]') INTO possible
  FROM app_private.bank_reconciliation_facts ef JOIN app_private.bank_inbound_events ev ON ev.id=ef.event_id
  JOIN app_private.bank_event_sources s ON s.id=ev.source_id AND s.organization_id=p_organization_id
  LEFT JOIN app_private.bank_reconciliation_decisions bd ON bd.event_id=ev.id
  WHERE ef.event_id<>v_event.id AND ef.facts->>'direction'=v_facts->>'direction' AND (ef.facts->>'amount')::numeric=amount
   AND EXISTS(SELECT 1 FROM app_private.bank_reconciliation_route(p_organization_id,ev.id) rr WHERE rr.account_id=v_account_id)
   AND ((nullif(v_facts->>'reference','') IS NOT NULL AND ef.facts->>'reference'=v_facts->>'reference') OR
    (abs(extract(epoch FROM ((ef.facts->>'transactedAt')::timestamptz-(v_facts->>'transactedAt')::timestamptz)))<=120
     AND ((v_facts->>'balance' IS NOT NULL AND ef.facts->>'balance'=v_facts->>'balance')
       OR (nullif(v_facts->>'description','') IS NOT NULL AND app_private.bank_reconciliation_fold(ef.facts->>'description')=app_private.bank_reconciliation_fold(v_facts->>'description')))));
  RETURN jsonb_build_object('candidates',candidates,'existing',existing,'possibleDuplicates',possible,'routeCount',route_count,'decision',to_jsonb(v_decision));
 END IF;
 IF p_action NOT IN ('collect','link','classify','undo') THEN RAISE EXCEPTION 'Unknown action' USING ERRCODE='22023'; END IF;
 expected:=(p_input->>'revision')::integer; v_reason:=btrim(COALESCE(p_input->>'reason',''));
 IF expected IS NULL OR expected<>COALESCE(v_decision.revision,0) THEN RAISE EXCEPTION 'Giao dịch đã được xử lý. Tải lại để kiểm tra.' USING ERRCODE='PT409'; END IF;
 IF length(v_reason) NOT BETWEEN 8 AND 500 THEN RAISE EXCEPTION 'Cần lý do xác nhận từ 8 đến 500 ký tự' USING ERRCODE='22023'; END IF;
 IF p_action='undo' THEN
  IF v_decision.state IS NULL OR v_decision.state NOT IN ('collected','linked','other','duplicate') THEN RAISE EXCEPTION 'Không thể hoàn tác trạng thái này' USING ERRCODE='PT409'; END IF;
  IF v_decision.invoice_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=v_decision.invoice_id AND i.organization_id=p_organization_id AND COALESCE(public.can_access_building(i.building_id),false)) THEN
   RAISE EXCEPTION 'Không có quyền hóa đơn' USING ERRCODE='42501'; END IF;
  IF v_decision.state='collected' THEN
   SELECT * INTO receipt FROM public.invoice_payment_collections c WHERE c.id=v_decision.collection_id AND c.organization_id=p_organization_id;
   IF receipt.status='ACTIVE' THEN result:=public.reverse_invoice_collection_v5(v_decision.collection_id,public.org_today_v1(p_organization_id),v_reason,'bank-undo:'||v_event.id||':'||v_decision.revision); END IF;
  END IF;
  UPDATE app_private.bank_reconciliation_decisions SET state='reversed',revision=revision+1,reason=v_reason,actor_id=actor WHERE bank_reconciliation_decisions.event_id=v_event.id;
 ELSE
  IF v_decision.state IN ('collected','linked','other','duplicate') THEN RAISE EXCEPTION 'Giao dịch đã được xử lý' USING ERRCODE='PT409'; END IF;
  IF route_count<>1 THEN RAISE EXCEPTION 'Nguồn chưa xác định duy nhất sổ quỹ và TK/TT' USING ERRCODE='PT409'; END IF;
  v_account_id:=v_route.account_id; v_method:=v_route.method;
  IF v_account_id IS DISTINCT FROM (p_input->>'accountId')::uuid OR v_method IS DISTINCT FROM p_input->>'method' THEN RAISE EXCEPTION 'Cấu hình nguồn đã đổi. Tải lại.' USING ERRCODE='PT409'; END IF;
  IF p_action IN ('collect','link') THEN
   IF v_facts->>'direction'<>'in' OR v_day IS NULL OR v_day>public.org_today_v1(p_organization_id) THEN RAISE EXCEPTION 'Cần tiền vào và ngày giao dịch ngân hàng hợp lệ' USING ERRCODE='22023'; END IF;
   -- Serialize sibling notifications for one bank account, including concurrent managers.
   PERFORM pg_advisory_xact_lock(hashtextextended('bank-reconciliation:'||v_account_id::text,0));
   result:=public.bank_reconciliation_v1(p_organization_id,'detail',jsonb_build_object('eventId',v_event.id));
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(result->'possibleDuplicates') x WHERE x->>'state' IN ('collected','linked')) THEN
    RAISE EXCEPTION 'Có tin nghi trùng đã được ghi thu. Kiểm tra trước khi xử lý.' USING ERRCODE='PT409'; END IF;
   IF p_action='link' THEN
    -- The canonical reversal locks collection -> invoice; keep that order here too.
    SELECT * INTO receipt FROM public.invoice_payment_collections c WHERE c.id=(p_input->>'collectionId')::uuid
     AND c.organization_id=p_organization_id AND c.invoice_id=(p_input->>'invoiceId')::uuid
     AND c.status='ACTIVE' AND c.collection_date=v_day AND c.retained_amount=amount FOR UPDATE;
    IF receipt.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.invoice_payment_tenders t WHERE t.collection_id=receipt.id AND t.account_id=v_account_id AND t.payment_method::text=v_method AND t.retained_amount=amount) THEN RAISE EXCEPTION 'Phiếu thu không còn phù hợp' USING ERRCODE='PT409'; END IF;
   END IF;
   SELECT * INTO inv FROM public.invoices WHERE id=(p_input->>'invoiceId')::uuid AND organization_id=p_organization_id FOR UPDATE;
   IF inv.id IS NULL OR NOT COALESCE(public.can_access_building(inv.building_id),false) THEN RAISE EXCEPTION 'Không có quyền hóa đơn' USING ERRCODE='42501'; END IF;
   IF p_action='collect' THEN
    IF jsonb_array_length(result->'existing')>0 THEN RAISE EXCEPTION 'Đã có phiếu thu cùng ngày, sổ và tiền. Kiểm tra liên kết phiếu có sẵn.' USING ERRCODE='PT409'; END IF;
    candidates:=app_private.bank_reconciliation_candidates(p_organization_id,v_event.id);
    SELECT x INTO chosen FROM jsonb_array_elements(candidates) x WHERE x->>'id'=inv.id::text;
    IF chosen IS NULL OR chosen->>'customerId' IS DISTINCT FROM p_input->>'customerId' OR inv.paid_amount IS DISTINCT FROM (p_input->>'expectedPaid')::numeric
     OR inv.remaining_amount IS DISTINCT FROM (p_input->>'expectedRemaining')::numeric
     OR inv.adjustment_revision IS DISTINCT FROM (p_input->>'invoiceRevision')::integer THEN RAISE EXCEPTION 'Hóa đơn đã thay đổi hoặc không còn phù hợp' USING ERRCODE='PT409'; END IF;
    IF amount>inv.remaining_amount AND p_input->>'overpayAction' IS DISTINCT FROM 'CREDIT' THEN RAISE EXCEPTION 'Cần xác nhận giữ tiền dư cho khách' USING ERRCODE='22023'; END IF;
    result:=public.record_invoice_collection_v5(inv.id,v_day,jsonb_build_array(jsonb_build_object('payment_method',v_method,'gross_amount',amount,'account_id',v_account_id)),
     CASE WHEN amount>inv.remaining_amount THEN 'CREDIT' ELSE 'REJECT' END,false,'Đối chiếu ngân hàng '||v_event.id||'. '||v_reason,NULL,inv.paid_amount,'bank-event:'||v_event.id||':'||COALESCE(v_decision.revision,0));
    SELECT * INTO receipt FROM public.invoice_payment_collections WHERE id=(result->>'collection_id')::uuid;
    IF receipt.id IS NULL THEN RAISE EXCEPTION 'Missing collection receipt' USING ERRCODE='PT409'; END IF;
   END IF;
  END IF;
  IF p_action='classify' AND COALESCE(p_input->>'state','') NOT IN ('other','duplicate') THEN RAISE EXCEPTION 'Phân loại không hợp lệ' USING ERRCODE='22023'; END IF;
  INSERT INTO app_private.bank_reconciliation_decisions(event_id,organization_id,account_id,method,state,invoice_id,collection_id,reason,actor_id,revision)
  VALUES(v_event.id,p_organization_id,v_account_id,v_method,CASE p_action WHEN 'collect' THEN 'collected' WHEN 'link' THEN 'linked' ELSE p_input->>'state' END,inv.id,receipt.id,v_reason,actor,COALESCE(v_decision.revision,0)+1)
  ON CONFLICT ON CONSTRAINT bank_reconciliation_decisions_pkey DO UPDATE SET account_id=EXCLUDED.account_id,method=EXCLUDED.method,state=EXCLUDED.state,invoice_id=EXCLUDED.invoice_id,
   collection_id=EXCLUDED.collection_id,reason=EXCLUDED.reason,actor_id=EXCLUDED.actor_id,revision=EXCLUDED.revision,created_at=clock_timestamp();
 END IF;
 INSERT INTO app_private.bank_event_audit(actor_id,action,source_id,event_id,detail) VALUES(actor,'reconciliation_'||p_action,v_event.source_id,v_event.id,jsonb_build_object('reason',v_reason,'accountId',v_account_id,'collectionId',receipt.id,'previous',to_jsonb(v_decision),'candidate',chosen,'ruleIds',v_route.rule_ids));
 RETURN jsonb_build_object('saved',true,'eventId',v_event.id,'revision',expected+1);
END;
$fn$;
REVOKE ALL ON FUNCTION app_private.bank_reconciliation_fold(text),app_private.bank_reconciliation_route(uuid,uuid),app_private.bank_reconciliation_candidates(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.bank_reconciliation_v1(uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_v1(uuid,text,jsonb) TO authenticated;
