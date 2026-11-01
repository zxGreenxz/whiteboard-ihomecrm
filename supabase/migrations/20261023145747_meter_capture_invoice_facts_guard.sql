-- A captured meter source must continue to describe the current invoice line.
-- Changing readings requires a new approved source and an explicit document revision;
-- the ordinary draft/adjustment writers may still change unrelated invoice facts.
BEGIN;
LOCK TABLE public.invoices,public.invoice_items,app_private.meter_capture_evidence_links IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS app_private.meter_capture_invoice_facts (
 evidence_link_id uuid PRIMARY KEY REFERENCES app_private.meter_capture_evidence_links(id),
 invoice_id uuid NOT NULL, sort_order integer, scope_snapshot jsonb NOT NULL,
 line_snapshot jsonb NOT NULL, amount_scale smallint NOT NULL DEFAULT 2 CHECK(amount_scale IN (0,2)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(invoice_id,sort_order)
);
ALTER TABLE app_private.meter_capture_invoice_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.meter_capture_invoice_facts FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_private.meter_capture_invoice_scope_v1(p_invoice public.invoices)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('organizationId',p_invoice.organization_id,'contractId',p_invoice.contract_id,
  'buildingId',p_invoice.building_id,'roomId',to_jsonb(p_invoice)->'room_id','month',p_invoice.billing_month)
$$;
CREATE OR REPLACE FUNCTION app_private.meter_capture_invoice_line_v1(p_item public.invoice_items)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('organizationId',to_jsonb(p_item)->'organization_id','serviceId',p_item.service_id,'sortOrder',p_item.sort_order,
  'previousReading',p_item.previous_reading,'currentReading',p_item.current_reading,
  'fromDate',to_jsonb(p_item)->'from_date','toDate',to_jsonb(p_item)->'to_date','type',to_jsonb(p_item)->'type')
$$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_snapshot_invoice_link_v1(p_link uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE l app_private.meter_capture_evidence_links%ROWTYPE;i public.invoices%ROWTYPE;it public.invoice_items%ROWTYPE;
 r public.meter_readings%ROWTYPE;v_count integer;
BEGIN
 SELECT * INTO l FROM app_private.meter_capture_evidence_links WHERE id=p_link;
 IF NOT FOUND OR l.document_kind<>'INVOICE' THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM app_private.meter_capture_invoice_facts WHERE evidence_link_id=l.id) THEN RETURN; END IF;
 SELECT * INTO i FROM public.invoices WHERE id=l.document_id FOR UPDATE;
 IF NOT FOUND OR i.organization_id IS DISTINCT FROM l.organization_id OR i.contract_id IS DISTINCT FROM l.contract_id
  OR (l.source->>'purpose' IS DISTINCT FROM 'MOVE_OUT' AND i.billing_month IS DISTINCT FROM l.source->>'month') THEN
  RAISE EXCEPTION 'Meter evidence invoice scope changed; restore the approved source before migration' USING ERRCODE='55000'; END IF;
 SELECT * INTO r FROM public.meter_readings WHERE id=l.end_reading_id;
 IF NOT FOUND OR r.organization_id IS DISTINCT FROM l.organization_id OR r.contract_id IS DISTINCT FROM l.contract_id
  OR r.meter_id IS DISTINCT FROM l.meter_id OR (r.building_id IS NOT NULL AND r.building_id IS DISTINCT FROM i.building_id)
  OR (r.room_id IS NOT NULL AND to_jsonb(i)->>'room_id' IS NOT NULL AND r.room_id::text IS DISTINCT FROM to_jsonb(i)->>'room_id') THEN
  RAISE EXCEPTION 'Meter evidence no longer matches the invoice contract/location' USING ERRCODE='55000'; END IF;
 -- The termination writer omits zero-value charges. Retain a zero-consumption
 -- source on the document without pretending that it belongs to another line.
 IF l.source->>'invoiceEvidenceOnly'='true' THEN
  IF l.source->>'purpose' IS DISTINCT FROM 'MOVE_OUT' OR l.source->>'sortOrder' IS NOT NULL
   OR (l.source->>'previousReading')::numeric IS DISTINCT FROM (l.source->>'currentReading')::numeric THEN
   RAISE EXCEPTION 'Only zero consumption may have invoice evidence without a line' USING ERRCODE='55000';END IF;
  INSERT INTO app_private.meter_capture_invoice_facts(evidence_link_id,invoice_id,sort_order,scope_snapshot,line_snapshot,amount_scale)
   VALUES(l.id,i.id,NULL,app_private.meter_capture_invoice_scope_v1(i),jsonb_build_object('serviceId',r.service_id,'evidenceOnly',true),0);
  RETURN;
 END IF;
 SELECT count(*) INTO v_count FROM public.invoice_items WHERE invoice_id=i.id AND sort_order=(l.source->>'sortOrder')::int;
 SELECT * INTO it FROM public.invoice_items WHERE invoice_id=i.id AND sort_order=(l.source->>'sortOrder')::int;
 IF v_count<>1 OR it.previous_reading IS DISTINCT FROM (l.source->>'previousReading')::numeric
  OR it.current_reading IS DISTINCT FROM (l.source->>'currentReading')::numeric
  OR (r.service_id IS NOT NULL AND r.service_id IS DISTINCT FROM it.service_id) THEN
  RAISE EXCEPTION 'Meter evidence no longer matches the invoice line; approve a new source and revise the document' USING ERRCODE='55000'; END IF;
 INSERT INTO app_private.meter_capture_invoice_facts(evidence_link_id,invoice_id,sort_order,scope_snapshot,line_snapshot,amount_scale)
 VALUES(l.id,i.id,it.sort_order,app_private.meter_capture_invoice_scope_v1(i),app_private.meter_capture_invoice_line_v1(it),
  CASE WHEN l.source->>'purpose'='MOVE_OUT' THEN 0 ELSE 2 END);
END $$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_assert_invoice_facts_v1(p_invoice uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE i public.invoices%ROWTYPE;f app_private.meter_capture_invoice_facts%ROWTYPE;it public.invoice_items%ROWTYPE;
 v_count integer;v_item jsonb;v_quantity numeric;v_rate numeric;v_coefficient numeric;v_amount numeric;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.meter_capture_evidence_links WHERE document_kind='INVOICE' AND document_id=p_invoice) THEN RETURN; END IF;
 -- Serialize direct line writes with draft/adjustment writers, which lock this parent.
 SELECT * INTO i FROM public.invoices WHERE id=p_invoice FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'An invoice with meter evidence must retain its document history' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM app_private.meter_capture_evidence_links l WHERE l.document_kind='INVOICE' AND l.document_id=p_invoice
  AND NOT EXISTS(SELECT 1 FROM app_private.meter_capture_invoice_facts stored WHERE stored.evidence_link_id=l.id)) THEN
  RAISE EXCEPTION 'Meter invoice evidence facts are missing' USING ERRCODE='55000'; END IF;
 FOR f IN SELECT * FROM app_private.meter_capture_invoice_facts WHERE invoice_id=p_invoice LOOP
  IF app_private.meter_capture_invoice_scope_v1(i) IS DISTINCT FROM f.scope_snapshot THEN
   RAISE EXCEPTION 'Invoice contract, location or period is fixed by meter evidence; use a new approved source and document revision' USING ERRCODE='55000'; END IF;
  IF f.sort_order IS NULL THEN CONTINUE;END IF;
  SELECT count(*) INTO v_count FROM public.invoice_items WHERE invoice_id=p_invoice AND sort_order=f.sort_order;
  SELECT * INTO it FROM public.invoice_items WHERE invoice_id=p_invoice AND sort_order=f.sort_order;
  IF v_count<>1 OR app_private.meter_capture_invoice_line_v1(it) IS DISTINCT FROM f.line_snapshot THEN
   RAISE EXCEPTION 'Invoice meter readings and source are fixed; approve a new source and revise the document before changing them' USING ERRCODE='55000'; END IF;
  v_item:=to_jsonb(it);v_quantity:=(v_item->>'quantity')::numeric;v_rate:=(v_item->>'unit_price')::numeric;
  v_coefficient:=(v_item->>'coefficient')::numeric;v_amount:=(v_item->>'amount')::numeric;
  IF v_quantity IS NULL OR v_rate IS NULL OR v_coefficient IS NULL OR v_amount IS NULL
   OR EXISTS(SELECT 1 FROM unnest(ARRAY[v_quantity,v_rate,v_coefficient,v_amount]) n WHERE n::text IN ('NaN','Infinity','-Infinity'))
   OR v_quantity IS DISTINCT FROM it.current_reading-it.previous_reading OR v_rate<0 OR v_coefficient<0 OR v_amount<0
   OR v_amount IS DISTINCT FROM round(v_quantity*v_rate*v_coefficient,f.amount_scale) THEN
   RAISE EXCEPTION 'Meter invoice quantity and amount must match approved consumption' USING ERRCODE='55000'; END IF;
 END LOOP;
 -- Another unlinked row for the same metered service would duplicate consumption.
 IF EXISTS(SELECT 1 FROM app_private.meter_capture_invoice_facts stored WHERE stored.invoice_id=p_invoice
  AND (SELECT count(*) FROM public.invoice_items current_item WHERE current_item.invoice_id=p_invoice
    AND current_item.service_id IS NOT DISTINCT FROM (stored.line_snapshot->>'serviceId')::uuid
    AND (current_item.previous_reading IS NOT NULL OR current_item.current_reading IS NOT NULL))
   <> (SELECT count(*) FROM app_private.meter_capture_invoice_facts same_service WHERE same_service.invoice_id=p_invoice
    AND same_service.sort_order IS NOT NULL
    AND same_service.line_snapshot->'serviceId' IS NOT DISTINCT FROM stored.line_snapshot->'serviceId')) THEN
  RAISE EXCEPTION 'An additional metered line needs its own approved source' USING ERRCODE='55000'; END IF;
END $$;

-- The established termination helper appends positive extra charges, skips zero
-- amounts, uses quantity=1 and does not set service_id. Match its actual output
-- in original charge order before normalising only capture-backed electric rows.
CREATE OR REPLACE FUNCTION app_private.meter_capture_map_exit_invoice_v1(p_org uuid,p_invoice uuid,p_contract uuid,p_charges jsonb,p_sources jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE q record;it public.invoice_items%ROWTYPE;s jsonb;v_sources jsonb:='[]';v_items uuid[];
 v_count integer;v_position integer:=0;v_next integer;v_service uuid;v_quantity numeric;v_sort integer;
BEGIN
 PERFORM 1 FROM public.invoices WHERE id=p_invoice AND organization_id=p_org AND contract_id=p_contract FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Settlement invoice scope mismatch' USING ERRCODE='55000';END IF;
 SELECT count(*) INTO v_count FROM jsonb_array_elements(p_charges) x WHERE (x->>'amount')::numeric>0;
 SELECT array_agg(id ORDER BY sort_order,id) INTO v_items FROM
  (SELECT id,sort_order FROM public.invoice_items WHERE invoice_id=p_invoice ORDER BY sort_order DESC,id DESC LIMIT v_count) tail;
 IF COALESCE(array_length(v_items,1),0)<>v_count THEN
  RAISE EXCEPTION 'Settlement writer omitted a positive charge' USING ERRCODE='55000';END IF;
 SELECT COALESCE(max(sort_order),0)+1 INTO v_next FROM public.invoice_items WHERE invoice_id=p_invoice;
 FOR q IN SELECT x,n FROM jsonb_array_elements(p_charges) WITH ORDINALITY t(x,n) ORDER BY n LOOP
  s:=q.x->'meter_source';v_sort:=NULL;
  IF (q.x->>'amount')::numeric>0 THEN
   v_position:=v_position+1;
   SELECT * INTO it FROM public.invoice_items WHERE id=v_items[v_position];
   IF it.previous_reading IS DISTINCT FROM NULLIF(q.x->>'previous_reading','')::numeric
    OR it.current_reading IS DISTINCT FROM NULLIF(q.x->>'current_reading','')::numeric
    OR it.amount IS DISTINCT FROM (q.x->>'amount')::numeric
    OR it.unit_price IS DISTINCT FROM COALESCE(NULLIF(q.x->>'unit_price','')::numeric,(q.x->>'amount')::numeric)
    OR it.description IS DISTINCT FROM COALESCE(NULLIF(btrim(q.x->>'description'),''),'Khoản thu thêm')
    OR it.type::text IS DISTINCT FROM (CASE COALESCE(q.x->>'kind','CUSTOM') WHEN 'PRORATED' THEN 'RENT' WHEN 'ELECTRIC' THEN 'SERVICE' ELSE 'OTHER' END)
    OR (SELECT count(*) FROM public.invoice_items WHERE invoice_id=p_invoice AND sort_order=it.sort_order)<>1 THEN
    RAISE EXCEPTION 'Settlement writer charge does not match the approved meter source' USING ERRCODE='55000';END IF;
   v_sort:=it.sort_order;
  END IF;
  IF s IS NULL THEN CONTINUE;END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_sources) x WHERE x=s)
   OR q.x->>'kind' IS DISTINCT FROM 'ELECTRIC' OR s->>'purpose' IS DISTINCT FROM 'MOVE_OUT'
   OR (q.x->>'previous_reading')::numeric IS DISTINCT FROM (s->>'previousReading')::numeric
   OR (q.x->>'current_reading')::numeric IS DISTINCT FROM (s->>'currentReading')::numeric THEN
   RAISE EXCEPTION 'Settlement source mapping mismatch' USING ERRCODE='55000';END IF;
  v_quantity:=(s->>'currentReading')::numeric-(s->>'previousReading')::numeric;
  IF v_quantity IS NULL OR v_quantity<0 OR v_quantity::text IN ('NaN','Infinity','-Infinity') THEN
   RAISE EXCEPTION 'Settlement consumption is invalid' USING ERRCODE='55000';END IF;
  SELECT service_id INTO v_service FROM public.meter_readings WHERE id=(s->>'endReadingId')::uuid
   AND organization_id=p_org AND contract_id=p_contract AND meter_id=(s->>'meterId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Settlement approved reading scope mismatch' USING ERRCODE='55000';END IF;
  IF v_sort IS NOT NULL THEN
   UPDATE public.invoice_items SET service_id=v_service,quantity=v_quantity,coefficient=1 WHERE id=it.id;
  ELSIF v_quantity>0 THEN
   -- A free/tiny rounded charge still has positive consumption. Keep a real
   -- zero-amount meter line, so it can never masquerade as evidence-only zero use.
   IF (q.x->>'amount')::numeric IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Settlement writer omitted a positive meter amount' USING ERRCODE='55000';END IF;
   v_sort:=v_next;v_next:=v_next+1;
   INSERT INTO public.invoice_items(invoice_id,type,description,service_id,previous_reading,current_reading,quantity,unit_price,coefficient,amount,sort_order)
    VALUES(p_invoice,'SERVICE',COALESCE(NULLIF(btrim(q.x->>'description'),''),'Khoản thu thêm'),v_service,
     (s->>'previousReading')::numeric,(s->>'currentReading')::numeric,v_quantity,(q.x->>'unit_price')::numeric,1,0,v_sort);
  END IF;
  v_sources:=v_sources||jsonb_build_array((s-'invoiceEvidenceOnly')||jsonb_build_object('sortOrder',v_sort,'invoiceEvidenceOnly',v_sort IS NULL));
 END LOOP;
 IF jsonb_array_length(v_sources)<>jsonb_array_length(p_sources) THEN
  RAISE EXCEPTION 'Settlement invoice did not map every approved source' USING ERRCODE='55000';END IF;
 RETURN v_sources;
END $$;

CREATE OR REPLACE FUNCTION app_private.meter_capture_invoice_link_snapshot_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
BEGIN PERFORM app_private.meter_capture_snapshot_invoice_link_v1(NEW.id);RETURN NEW;END $$;
CREATE OR REPLACE FUNCTION app_private.meter_capture_invoice_consistency_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE v_old uuid;v_new uuid;
BEGIN
 IF TG_TABLE_NAME='invoices' THEN
  IF TG_OP<>'INSERT' THEN v_old:=OLD.id;END IF;IF TG_OP<>'DELETE' THEN v_new:=NEW.id;END IF;
 ELSIF TG_TABLE_NAME='invoice_items' THEN
  IF TG_OP<>'INSERT' THEN v_old:=OLD.invoice_id;END IF;IF TG_OP<>'DELETE' THEN v_new:=NEW.invoice_id;END IF;
 ELSE
  IF NEW.document_kind='INVOICE' THEN v_new:=NEW.document_id;END IF;
 END IF;
 IF v_old IS NOT NULL THEN PERFORM app_private.meter_capture_assert_invoice_facts_v1(v_old);END IF;
 IF v_new IS NOT NULL AND v_new IS DISTINCT FROM v_old THEN PERFORM app_private.meter_capture_assert_invoice_facts_v1(v_new);END IF;
 RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS meter_capture_invoice_facts_immutable ON app_private.meter_capture_invoice_facts;
CREATE TRIGGER meter_capture_invoice_facts_immutable BEFORE UPDATE OR DELETE ON app_private.meter_capture_invoice_facts
 FOR EACH ROW EXECUTE FUNCTION app_private.meter_capture_immutable_v1();
DROP TRIGGER IF EXISTS meter_capture_invoice_link_snapshot ON app_private.meter_capture_evidence_links;
CREATE TRIGGER meter_capture_invoice_link_snapshot AFTER INSERT ON app_private.meter_capture_evidence_links
 FOR EACH ROW EXECUTE FUNCTION app_private.meter_capture_invoice_link_snapshot_v1();
DROP TRIGGER IF EXISTS meter_capture_invoice_header_consistent ON public.invoices;
CREATE CONSTRAINT TRIGGER meter_capture_invoice_header_consistent AFTER INSERT OR UPDATE OR DELETE ON public.invoices
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.meter_capture_invoice_consistency_v1();
DROP TRIGGER IF EXISTS meter_capture_invoice_items_consistent ON public.invoice_items;
CREATE CONSTRAINT TRIGGER meter_capture_invoice_items_consistent AFTER INSERT OR UPDATE OR DELETE ON public.invoice_items
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.meter_capture_invoice_consistency_v1();
DROP TRIGGER IF EXISTS zzz_meter_capture_invoice_link_consistent ON app_private.meter_capture_evidence_links;
CREATE CONSTRAINT TRIGGER zzz_meter_capture_invoice_link_consistent AFTER INSERT ON app_private.meter_capture_evidence_links
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app_private.meter_capture_invoice_consistency_v1();

-- Existing mismatches abort the migration instead of recording altered facts as history.
DO $$ DECLARE l record;BEGIN
 FOR l IN SELECT id FROM app_private.meter_capture_evidence_links WHERE document_kind='INVOICE' ORDER BY document_id,id LOOP
  PERFORM app_private.meter_capture_snapshot_invoice_link_v1(l.id);
 END LOOP;
 FOR l IN SELECT DISTINCT invoice_id FROM app_private.meter_capture_invoice_facts LOOP
  PERFORM app_private.meter_capture_assert_invoice_facts_v1(l.invoice_id);
 END LOOP;
END $$;

-- Both established writers replace rows. Defer only this invariant through that
-- replacement, then assert before returning, even if the caller set ALL IMMEDIATE.
DO $$ DECLARE p record;v_definition text;v_anchor text;v_return text;BEGIN
 FOR p IN SELECT oid,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('update_invoice_v1','adjust_invoice_v2') LOOP
  v_definition:=pg_get_functiondef(p.oid);
  IF strpos(v_definition,'meter_capture_assert_invoice_facts_v1(p_invoice_id)')>0 THEN CONTINUE;END IF;
  IF p.proname='update_invoice_v1' THEN
   v_anchor:='delete from public.invoice_items where invoice_id = p_invoice_id;';v_return:='return v_row;';
  ELSE
   v_anchor:='DELETE FROM public.invoice_items WHERE invoice_id=p_invoice_id;';v_return:='  RETURN result;';
  END IF;
  IF strpos(v_definition,v_anchor)=0 OR strpos(v_definition,v_return)=0 THEN
   RAISE EXCEPTION 'Meter guard cannot locate replacement/final-return in %',p.proname USING ERRCODE='55000';END IF;
  v_definition:=replace(v_definition,v_anchor,'SET CONSTRAINTS public.meter_capture_invoice_items_consistent DEFERRED;'||chr(10)||v_anchor);
  v_definition:=replace(v_definition,v_return,'PERFORM app_private.meter_capture_assert_invoice_facts_v1(p_invoice_id);'||chr(10)||v_return);
  EXECUTE v_definition;
 END LOOP;
END $$;

-- Keep multiple meter links atomic even for callers using ALL IMMEDIATE, and
-- route settlement evidence through the actual writer output (not UI indexes).
DO $$ DECLARE p record;v_definition text;v_anchor text;BEGIN
 FOR p IN SELECT oid,proname FROM pg_proc WHERE pronamespace='app_private'::regnamespace AND proname='meter_capture_attach_v1' LOOP
  v_definition:=pg_get_functiondef(p.oid);
  IF strpos(v_definition,'meter_capture_assert_invoice_facts_v1(p_document)')>0 THEN CONTINUE;END IF;
  v_anchor:=' FOR s IN SELECT value FROM jsonb_array_elements(p_sources) LOOP';
  IF strpos(v_definition,v_anchor)=0 OR strpos(v_definition,' END LOOP;')=0 THEN
   RAISE EXCEPTION 'Meter guard cannot locate evidence attachment body' USING ERRCODE='55000';END IF;
  v_definition:=replace(v_definition,v_anchor,' IF p_kind=''INVOICE'' THEN SET CONSTRAINTS app_private.zzz_meter_capture_invoice_link_consistent DEFERRED;END IF;'||chr(10)||v_anchor);
  v_definition:=replace(v_definition,' END LOOP;',' END LOOP;'||chr(10)||' IF p_kind=''INVOICE'' THEN PERFORM app_private.meter_capture_assert_invoice_facts_v1(p_document);END IF;');
  EXECUTE v_definition;
 END LOOP;
 FOR p IN SELECT oid FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='meter_capture_exit_v1' LOOP
  v_definition:=pg_get_functiondef(p.oid);
  IF strpos(v_definition,'meter_capture_map_exit_invoice_v1(')>0 THEN CONTINUE;END IF;
  -- FORFEIT returns both a deposit invoice and a separate extra-charge invoice.
  -- The latter can be null (all zero charges); never attach electricity to deposit.
  v_anchor:='jsonb_build_array(v_settlement->>''settlement_invoice_id'',v_settlement->>''extra_invoice_id'')';
  IF strpos(v_definition,v_anchor)=0 THEN RAISE EXCEPTION 'Meter guard cannot locate settlement invoice selection' USING ERRCODE='55000';END IF;
  v_definition:=replace(v_definition,v_anchor,'jsonb_build_array(CASE WHEN v_settlement ? ''extra_invoice_id'' THEN v_settlement->>''extra_invoice_id'' ELSE v_settlement->>''settlement_invoice_id'' END)');
  v_anchor:='PERFORM app_private.meter_capture_attach_v1(p_organization_id,''INVOICE'',v_invoice,v_contract,p_sources);';
  IF strpos(v_definition,v_anchor)=0 THEN RAISE EXCEPTION 'Meter guard cannot locate settlement attachment' USING ERRCODE='55000';END IF;
  v_definition:=replace(v_definition,v_anchor,'PERFORM app_private.meter_capture_attach_v1(p_organization_id,''INVOICE'',v_invoice,v_contract,'||
   'app_private.meter_capture_map_exit_invoice_v1(p_organization_id,v_invoice,v_contract,p_arguments#>''{p_settlement,extra_charges}'',p_sources));');
  EXECUTE v_definition;
 END LOOP;
END $$;

REVOKE ALL ON FUNCTION app_private.meter_capture_invoice_scope_v1(public.invoices),app_private.meter_capture_invoice_line_v1(public.invoice_items),
 app_private.meter_capture_snapshot_invoice_link_v1(uuid),app_private.meter_capture_assert_invoice_facts_v1(uuid),
 app_private.meter_capture_invoice_link_snapshot_v1(),app_private.meter_capture_invoice_consistency_v1(),
 app_private.meter_capture_map_exit_invoice_v1(uuid,uuid,uuid,jsonb,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
