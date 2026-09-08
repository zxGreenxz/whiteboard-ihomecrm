-- Exact audit-proven cohort; no cash movement, receipt replacement or settlement decision.
-- The two canonical guards are temporarily extended inside this transaction only.
-- Their original definitions are restored before COMMIT (DDL also rolls back on error).
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
DO $repair$
DECLARE
  v_org constant uuid := 'aaaa0000-0000-4000-8000-000000000001';
  v_code constant text := 'INVOICE_DEPOSIT_CLASS_HISTORY_20260908';
  v_manifest constant jsonb := '[{"invoice_id":"00cea782-247f-4634-94a3-2de7ea331aa4","item_id":"cccf5341-fc43-40cc-9c33-da5a3954ceb2","old_item_id":"9ef0a2c3-aa87-4bd7-851f-58b0b346a84a","contract_id":"3ac21d3f-26af-4459-8dc9-e4f43ffd85f1","voucher_id":"f227a22c-5818-43f7-8227-e88f3f80c962","line_id":"f61969a0-c503-4dfe-bbb0-215ae482beea","payment_id":"3ef574a6-36ed-4270-b8c0-3d1fa81a9944","collection_id":"4ec802ea-7e2c-4207-b326-cd10d3d0879d","account_id":"5f31529d-f031-4510-8409-bbd9e29f1c4b","deposit":3600000,"total":7450000,"event_at":"2026-08-01 03:25:15.370952+00","voucher_date":"2026-08-01"},{"invoice_id":"6fc16297-7b1b-4b35-8d5a-2b98ae753f70","item_id":"508994eb-b45f-450b-9253-a44bb66f9ff8","old_item_id":"377576a7-d0a2-48ee-aaea-72b0208fdc2c","contract_id":"6d504199-ed9c-467a-ac5f-c8cac680f544","voucher_id":"b15ae57c-554f-43cb-b7a7-4f13ea4f424b","line_id":"786c94ce-2d31-45b2-90ab-ecd5bf5b94be","payment_id":"e9b79959-9e89-422f-84bf-32382ba40dd0","collection_id":"3c98d08b-918c-4add-89c0-6aeedcf405bc","account_id":"c9df0934-c934-4015-a913-010c6a27fb8b","deposit":2200000,"total":7490000,"event_at":"2026-08-31 03:32:21.425123+00","voucher_date":"2026-08-31"},{"invoice_id":"80b0b20e-994a-4f6e-ab2a-274934366097","item_id":"bac6c197-99d1-4ce7-a3ce-a06f7fe1f4ac","old_item_id":"97675b01-06ef-4260-bb4e-4a055b78c15d","contract_id":"890c9f1b-554d-44be-be2a-7bbd375e1379","voucher_id":"a73b9603-109f-455e-94cf-a260e61271e4","line_id":"d8838ccb-d67e-4e97-a929-00795645af0e","payment_id":"eea6701a-1a3f-4683-be04-bb133d2ccff8","collection_id":"4b91c426-00bb-435c-936a-9561b2a41b80","account_id":"dc45114c-734f-45aa-9946-bed05e0c9051","deposit":1600000,"total":4720000,"event_at":"2026-08-31 16:08:47.510378+00","voucher_date":"2026-09-06"},{"invoice_id":"ef9e4144-2eed-44d0-ba6d-fec8da116e36","item_id":"f78e9a06-4432-4492-b1a2-65a0c42c42cb","old_item_id":"0724af81-cd4c-4cb7-819e-1b82edbc8663","contract_id":"dfb76f81-0e69-4664-b4ed-0d63e1c173db","voucher_id":"fa804836-45c1-4840-9d0c-77990661c522","line_id":"d20fa226-9084-49db-9628-f1c8acfbadb8","payment_id":"8e115e61-9a2b-4288-b0b6-8b3077ca06da","collection_id":"ed28d8a9-a35e-484d-a144-2a280e5a061d","account_id":"c9df0934-c934-4015-a913-010c6a27fb8b","deposit":3900000,"total":3900000,"event_at":"2026-09-04 03:34:40.590263+00","voucher_date":"2026-08-17","termination_id":"5489bd49-b982-4157-a436-cf5a45e567d6","termination_digest":"a6edfa36374d702df6c94fda927684d1","settlement_vouchers":[{"id":"372243ee-da67-47dc-8b6f-39f490b93da8","digest":"3648dd091c18273afdf25807cbf78476"},{"id":"6620712d-a076-4635-950a-bd58c01f5b3a","digest":"65e2347cdff30c3c0f588e3943ed212a"},{"id":"f773c0ab-04e8-42a5-883e-be881e95529d","digest":"8efae584ad9d4e7f74cf9a99a0c7d5be"}]}]'::jsonb;
  r record;
  v_invoice public.invoices%ROWTYPE;
  v_item public.invoice_items%ROWTYPE;
  v_receipt public.income_expenses%ROWTYPE;
  v_line public.income_expense_items%ROWTYPE;
  v_new public.income_expense_items%ROWTYPE;
  v_before jsonb;
  v_after jsonb;
  v_header_guard text := pg_get_functiondef('app_private.guard_income_expense_owned_payload()'::regprocedure);
  v_item_guard text := pg_get_functiondef('app_private.guard_income_expense_owned_items()'::regprocedure);
  v_header_patch text;
  v_item_patch text;
  v_count integer;
BEGIN
  -- Schema-only restore drills have no organizations or business rows at all.
  -- This is the sole no-data exemption; a populated database or missing one cohort fails closed.
  IF NOT EXISTS(SELECT 1 FROM public.organizations)
    AND NOT EXISTS(SELECT 1 FROM public.contracts)
    AND NOT EXISTS(SELECT 1 FROM public.invoices)
    AND NOT EXISTS(SELECT 1 FROM public.payments)
    AND NOT EXISTS(SELECT 1 FROM public.income_expenses)
  THEN
    RAISE NOTICE 'deposit repair: empty schema-only restore, no historical data';
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_code,0));
  -- ACCESS EXCLUSIVE prevents another writer from seeing a transient guard definition.
  -- Row locks below bind the evidence to the exact live rows before any mutation.
  LOCK TABLE public.income_expenses, public.income_expense_items IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE public.profit_close_runs, public.profit_monthly, app_private.cashbook_closures IN SHARE MODE;
  IF md5(v_header_guard) <> 'fb01ae8c9de7b283d19ade8195eba726' OR md5(v_item_guard) <> '1f0d1e2eb19975cdd52693a703ee464a' THEN
    RAISE EXCEPTION 'deposit repair guard definition drift';
  END IF;
  CREATE TEMP TABLE deposit_history_capability (
    xid xid8 NOT NULL, pid integer NOT NULL, table_name text NOT NULL,
    operation text NOT NULL, row_id uuid NOT NULL, before_row jsonb, after_row jsonb,
    PRIMARY KEY(table_name,operation,row_id)
  ) ON COMMIT DROP;
  REVOKE ALL ON pg_temp.deposit_history_capability FROM PUBLIC, anon, authenticated;
  v_header_patch := $patch$
  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM pg_temp.deposit_history_capability c
    WHERE c.xid=pg_current_xact_id() AND c.pid=pg_backend_pid()
      AND c.table_name='income_expenses' AND c.operation=TG_OP AND c.row_id=OLD.id
      AND c.before_row = to_jsonb(OLD)-ARRAY['updated_at','kqkd_amount','counts_in_business_result','has_restricted_item']
      AND c.after_row = to_jsonb(NEW)-ARRAY['updated_at','kqkd_amount','counts_in_business_result','has_restricted_item']
  ) THEN RETURN NEW; END IF;
  $patch$;
  v_item_patch := $patch$
  IF TG_OP IN ('INSERT','UPDATE') AND EXISTS (
    SELECT 1 FROM pg_temp.deposit_history_capability c
    WHERE c.xid=pg_current_xact_id() AND c.pid=pg_backend_pid()
      AND c.table_name='income_expense_items' AND c.operation=TG_OP AND c.row_id=NEW.id
      AND c.after_row=to_jsonb(NEW)
      AND (TG_OP='INSERT' OR c.before_row=to_jsonb(OLD))
  ) THEN RETURN NEW; END IF;
  $patch$;
  EXECUTE regexp_replace(v_header_guard, E'\\mbegin\\M', 'begin'||v_header_patch, 'i');
  EXECUTE regexp_replace(v_item_guard, E'\\mbegin\\M', 'begin'||v_item_patch, 'i');
  FOR r IN SELECT * FROM jsonb_to_recordset(v_manifest) AS m(
    invoice_id uuid,item_id uuid,old_item_id uuid,contract_id uuid,voucher_id uuid,
    line_id uuid,payment_id uuid,collection_id uuid,account_id uuid,
    deposit numeric,total numeric,event_at timestamptz,voucher_date date,
    termination_id uuid,termination_digest text,settlement_vouchers jsonb)
  LOOP
    SELECT * INTO STRICT v_invoice FROM public.invoices WHERE id=r.invoice_id FOR UPDATE;
    SELECT * INTO STRICT v_item FROM public.invoice_items WHERE id=r.item_id FOR UPDATE;
    SELECT * INTO STRICT v_receipt FROM public.income_expenses WHERE id=r.voucher_id FOR UPDATE;
    SELECT * INTO STRICT v_line FROM public.income_expense_items WHERE id=r.line_id FOR UPDATE;
    PERFORM 1 FROM public.contracts WHERE id=r.contract_id FOR UPDATE;
    PERFORM 1 FROM public.payments WHERE id=r.payment_id FOR UPDATE;
    PERFORM 1 FROM public.accounts WHERE id=r.account_id FOR UPDATE;
    PERFORM 1 FROM public.contract_terminations WHERE contract_id=r.contract_id FOR UPDATE;
    IF r.termination_id IS NOT NULL AND (
      NOT EXISTS(SELECT 1 FROM public.contract_terminations t WHERE t.id=r.termination_id
        AND t.contract_id=r.contract_id AND t.organization_id=v_org AND t.status='COMPLETED'
        AND md5(to_jsonb(t)::text)=r.termination_digest)
      OR EXISTS(SELECT 1 FROM jsonb_to_recordset(r.settlement_vouchers) s(id uuid,digest text)
        WHERE NOT EXISTS(SELECT 1 FROM public.income_expenses v WHERE v.id=s.id
          AND v.contract_id=r.contract_id AND v.organization_id=v_org AND md5(to_jsonb(v)::text)=s.digest))
      OR EXISTS(SELECT 1 FROM public.termination_refund_obligations o WHERE o.contract_id=r.contract_id)
    ) THEN RAISE EXCEPTION 'deposit repair completed settlement drift %',r.invoice_id; END IF;
    IF EXISTS (SELECT 1 FROM public.accounting_repair_audit a WHERE a.entity_type='invoice'
      AND a.entity_id=r.invoice_id AND a.repair_code=v_code AND a.organization_id=v_org) THEN
      IF v_item.accounting_class <> 'DEPOSIT' OR
         (SELECT sum(amount) FROM public.income_expense_items WHERE income_expense_id=r.voucher_id AND accounting_class='DEPOSIT') IS DISTINCT FROM r.deposit
         OR v_receipt.total_amount IS DISTINCT FROM r.total
         OR EXISTS(SELECT 1 FROM public.accounting_repair_audit a WHERE a.entity_type='invoice' AND a.entity_id=r.invoice_id AND a.repair_code=v_code
           AND (a.after_snapshot->'invoice_item' IS DISTINCT FROM to_jsonb(v_item)
             OR (a.after_snapshot->'voucher')-'updated_at' IS DISTINCT FROM to_jsonb(v_receipt)-'updated_at'
             OR a.after_snapshot->'items' IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM public.income_expense_items i WHERE i.income_expense_id=r.voucher_id))) THEN
        RAISE EXCEPTION 'deposit repair repeat state drift %',r.invoice_id;
      END IF;
      CONTINUE;
    END IF;
    IF v_invoice.organization_id IS DISTINCT FROM v_org OR v_invoice.contract_id IS DISTINCT FROM r.contract_id
      OR v_invoice.deleted_at IS NOT NULL OR v_invoice.status::text <> 'PAID'
      OR v_invoice.total_amount IS DISTINCT FROM r.total OR v_invoice.paid_amount IS DISTINCT FROM r.total
      OR v_item.organization_id IS DISTINCT FROM v_org OR v_item.invoice_id IS DISTINCT FROM r.invoice_id
      OR v_item.accounting_class <> 'REVENUE' OR v_item.type::text <> 'OTHER' OR v_item.amount IS DISTINCT FROM r.deposit
      OR v_receipt.organization_id IS DISTINCT FROM v_org OR v_receipt.invoice_id IS DISTINCT FROM r.invoice_id
      OR v_receipt.contract_id IS DISTINCT FROM r.contract_id OR v_receipt.payment_id IS DISTINCT FROM r.payment_id
      OR v_receipt.payment_collection_id IS DISTINCT FROM r.collection_id OR v_receipt.account_id IS DISTINCT FROM r.account_id
      OR v_receipt.voucher_date IS DISTINCT FROM r.voucher_date OR v_receipt.total_amount IS DISTINCT FROM r.total
      OR v_receipt.recognition_date IS NOT NULL
      OR v_receipt.type <> 'INCOME' OR v_receipt.approval_status <> 'APPROVED' OR v_receipt.posting_status <> 'POSTED'
      OR v_receipt.deleted_at IS NOT NULL OR v_receipt.system_source IS DISTINCT FROM 'invoice.collection.v5'
      OR v_receipt.business_result_accounting IS NOT NULL OR v_receipt.kqkd_amount IS DISTINCT FROM r.total
      OR v_line.organization_id IS DISTINCT FROM v_org OR v_line.income_expense_id IS DISTINCT FROM r.voucher_id
      OR v_line.accounting_class <> 'PNL' OR v_line.amount IS DISTINCT FROM r.total
      OR v_line.income_expense_type_id IS DISTINCT FROM 'd502976f-c0eb-4585-ad00-67caf8b017e6'::uuid
      OR v_line.quantity IS DISTINCT FROM 1::numeric OR v_line.unit_price IS DISTINCT FROM r.total
      OR (SELECT count(*) FROM public.income_expense_items WHERE income_expense_id=r.voucher_id) <> 1
      OR NOT app_private.is_income_expense_flow_owned(r.voucher_id)
      OR NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=r.contract_id AND c.organization_id=v_org AND c.deleted_at IS NULL)
      OR NOT EXISTS(SELECT 1 FROM public.finance_invoice_component_manifests m WHERE m.invoice_id=r.invoice_id AND m.finalized_at IS NOT NULL)
      OR NOT EXISTS (SELECT 1 FROM public.payments p WHERE p.id=r.payment_id AND p.organization_id=v_org
        AND p.invoice_id=r.invoice_id AND p.collection_id=r.collection_id AND p.amount=r.total AND p.reversed_at IS NULL)
    THEN RAISE EXCEPTION 'deposit repair cohort precondition failed %',r.invoice_id; END IF;
    SELECT count(*) INTO v_count FROM public.invoice_audit_log ins JOIN public.invoice_audit_log del
      ON del.invoice_id=ins.invoice_id AND del.created_at=ins.created_at
      WHERE ins.invoice_id=r.invoice_id AND ins.entity_id=r.item_id AND ins.entity='item' AND ins.action='INSERT'
      AND del.entity_id=r.old_item_id AND del.entity='item' AND del.action='DELETE'
      AND ins.created_at=r.event_at AND ins.after->>'accounting_class'='REVENUE'
      AND del.before->>'accounting_class'='DEPOSIT'
      AND ins.after->>'description'=del.before->>'description' AND ins.after->>'description'=v_item.description
      AND (ins.after->>'amount')::numeric=r.deposit AND (del.before->>'amount')::numeric=r.deposit;
    IF v_count <> 1 THEN RAISE EXCEPTION 'deposit repair audit evidence mismatch %',r.invoice_id; END IF;
    IF app_private.finance_v2_is_recognition_period_open(v_org,r.voucher_date) IS DISTINCT FROM true
      OR app_private.cashbook_closed_through_v1(r.account_id) >= r.voucher_date
      OR EXISTS(SELECT 1 FROM public.profit_monthly p WHERE p.building_id=v_receipt.building_id
        AND p.period_month=date_trunc('month',r.voucher_date)::date AND p.locked_at IS NOT NULL)
    THEN RAISE EXCEPTION 'deposit repair closed period %',r.invoice_id; END IF;
    SELECT jsonb_build_object(
      'invoice',to_jsonb(v_invoice),'invoice_item',to_jsonb(v_item),'voucher',to_jsonb(v_receipt),'items',jsonb_build_array(to_jsonb(v_line)),
      'payments',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.payments p WHERE p.invoice_id=r.invoice_id),
      'postings',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.income_expense_postings p WHERE p.voucher_id=r.voucher_id),
      'posting_lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.income_expense_posting_lines l WHERE l.posting_id IN (SELECT p.id FROM public.income_expense_postings p WHERE p.voucher_id=r.voucher_id)),
      'collection',(SELECT to_jsonb(c) FROM public.invoice_payment_collections c WHERE c.id=r.collection_id),
      'tenders',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.invoice_payment_tenders t WHERE t.collection_id=r.collection_id),
      'ownership',(SELECT to_jsonb(o) FROM app_private.income_expense_flow_ownership o WHERE o.income_expense_id=r.voucher_id),
      'components',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.finance_invoice_components c WHERE c.invoice_id=r.invoice_id),
      'termination',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.contract_terminations t WHERE t.contract_id=r.contract_id),
      'other_vouchers',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM public.income_expenses v WHERE v.contract_id=r.contract_id AND v.id<>r.voucher_id),
      'obligations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM public.termination_refund_obligations o WHERE o.contract_id=r.contract_id),
      'manifests',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM public.finance_invoice_component_manifests m WHERE m.invoice_id=r.invoice_id)
    ) INTO v_before;
    INSERT INTO pg_temp.deposit_history_capability VALUES(pg_current_xact_id(),pg_backend_pid(),'income_expenses','UPDATE',r.voucher_id,
      to_jsonb(v_receipt)-ARRAY['updated_at','kqkd_amount','counts_in_business_result','has_restricted_item'],
      to_jsonb(v_receipt)-ARRAY['updated_at','kqkd_amount','counts_in_business_result','has_restricted_item']);
    v_new := v_line;
    IF r.total=r.deposit THEN
      v_new.accounting_class := 'DEPOSIT';
      v_new.income_expense_type_id := 'c053bbcd-37ae-4986-92d4-008a5223baf7';
    ELSE
      v_new.unit_price := r.total-r.deposit; v_new.amount := r.total-r.deposit;
    END IF;
    INSERT INTO pg_temp.deposit_history_capability VALUES(pg_current_xact_id(),pg_backend_pid(),'income_expense_items','UPDATE',r.line_id,to_jsonb(v_line),to_jsonb(v_new));
    IF r.total>r.deposit THEN
      v_new := v_line; v_new.id := gen_random_uuid(); v_new.amount := r.deposit; v_new.unit_price := r.deposit;
      v_new.accounting_class := 'DEPOSIT'; v_new.income_expense_type_id := 'c053bbcd-37ae-4986-92d4-008a5223baf7';
      INSERT INTO pg_temp.deposit_history_capability VALUES(pg_current_xact_id(),pg_backend_pid(),'income_expense_items','INSERT',v_new.id,NULL,to_jsonb(v_new));
    END IF;
    UPDATE public.invoice_items SET accounting_class='DEPOSIT' WHERE id=r.item_id;
    -- One statement: queued AFTER triggers observe the final total, never a temporary reduction.
    WITH changed AS (
      UPDATE public.income_expense_items SET
        amount=CASE WHEN r.total=r.deposit THEN r.deposit ELSE r.total-r.deposit END,
        unit_price=CASE WHEN r.total=r.deposit THEN r.deposit ELSE r.total-r.deposit END,
        accounting_class=CASE WHEN r.total=r.deposit THEN 'DEPOSIT' ELSE 'PNL' END,
        income_expense_type_id=CASE WHEN r.total=r.deposit THEN 'c053bbcd-37ae-4986-92d4-008a5223baf7'::uuid ELSE income_expense_type_id END
      WHERE id=r.line_id RETURNING id
    ) INSERT INTO public.income_expense_items SELECT v_new.* FROM changed WHERE r.total>r.deposit;
    SET CONSTRAINTS ALL IMMEDIATE;
    SELECT jsonb_build_object(
      'invoice',(SELECT to_jsonb(i) FROM public.invoices i WHERE i.id=r.invoice_id),
      'invoice_item',(SELECT to_jsonb(i) FROM public.invoice_items i WHERE i.id=r.item_id),
      'voucher',(SELECT to_jsonb(v) FROM public.income_expenses v WHERE v.id=r.voucher_id),
      'items',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM public.income_expense_items i WHERE i.income_expense_id=r.voucher_id),
      'payments',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.payments p WHERE p.invoice_id=r.invoice_id),
      'postings',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.income_expense_postings p WHERE p.voucher_id=r.voucher_id),
      'posting_lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM public.income_expense_posting_lines l WHERE l.posting_id IN (SELECT p.id FROM public.income_expense_postings p WHERE p.voucher_id=r.voucher_id)),
      'collection',(SELECT to_jsonb(c) FROM public.invoice_payment_collections c WHERE c.id=r.collection_id),
      'tenders',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.invoice_payment_tenders t WHERE t.collection_id=r.collection_id),
      'ownership',(SELECT to_jsonb(o) FROM app_private.income_expense_flow_ownership o WHERE o.income_expense_id=r.voucher_id),
      'components',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.finance_invoice_components c WHERE c.invoice_id=r.invoice_id),
      'termination',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM public.contract_terminations t WHERE t.contract_id=r.contract_id),
      'other_vouchers',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM public.income_expenses v WHERE v.contract_id=r.contract_id AND v.id<>r.voucher_id),
      'obligations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM public.termination_refund_obligations o WHERE o.contract_id=r.contract_id),
      'manifests',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM public.finance_invoice_component_manifests m WHERE m.invoice_id=r.invoice_id)
    ) INTO v_after;
    IF (v_before-ARRAY['invoice','invoice_item','voucher','items']) IS DISTINCT FROM (v_after-ARRAY['invoice','invoice_item','voucher','items'])
      OR ((v_before->'invoice')-'updated_at') IS DISTINCT FROM ((v_after->'invoice')-'updated_at')
      OR ((v_before->'invoice_item')-'accounting_class') IS DISTINCT FROM ((v_after->'invoice_item')-'accounting_class')
      OR v_after->'invoice_item'->>'accounting_class' IS DISTINCT FROM 'DEPOSIT'
      OR ((v_before->'voucher')-ARRAY['updated_at','kqkd_amount','counts_in_business_result','has_restricted_item']) IS DISTINCT FROM
         ((v_after->'voucher')-ARRAY['updated_at','kqkd_amount','counts_in_business_result','has_restricted_item'])
      OR ((v_after->'voucher')->>'kqkd_amount')::numeric IS DISTINCT FROM r.total-r.deposit
      OR ((v_after->'voucher')->>'counts_in_business_result')::boolean IS DISTINCT FROM (r.total>r.deposit)
      OR ((v_after->'voucher')->>'has_restricted_item')::boolean IS DISTINCT FROM
        (SELECT bool_or(t.is_restricted) FROM public.income_expense_items i JOIN public.income_expense_types t ON t.id=i.income_expense_type_id WHERE i.income_expense_id=r.voucher_id)
      OR (SELECT sum(amount) FROM public.income_expense_items WHERE income_expense_id=r.voucher_id) IS DISTINCT FROM r.total
      OR (SELECT sum(amount) FROM public.income_expense_items WHERE income_expense_id=r.voucher_id AND accounting_class='DEPOSIT') IS DISTINCT FROM r.deposit
    THEN RAISE EXCEPTION 'deposit repair cash/settlement invariant failed %',r.invoice_id; END IF;
    INSERT INTO public.accounting_repair_audit(organization_id,entity_type,entity_id,repair_code,before_snapshot,after_snapshot,details,repaired_by)
    VALUES(v_org,'invoice',r.invoice_id,v_code,v_before,v_after,
      jsonb_build_object('evidence_event',r.event_at,'deposit_amount',r.deposit,'cash_delta',0,'historical_components_preserved',true),auth.uid());
    IF r.termination_id IS NOT NULL THEN
      INSERT INTO public.accounting_integrity_exceptions(organization_id,entity_type,entity_id,exception_code,details)
      VALUES(v_org,'contract',r.contract_id,'RESTORED_DEPOSIT_REQUIRES_SETTLEMENT_REVIEW',
        jsonb_build_object('invoice_id',r.invoice_id,'restored_deposit',r.deposit,'settlement_unchanged',true,
          'required_action','Review held deposit liability separately; no refund or forfeiture inferred'));
    END IF;
    DELETE FROM pg_temp.deposit_history_capability;
  END LOOP;
  EXECUTE v_header_guard;
  EXECUTE v_item_guard;
  IF pg_get_functiondef('app_private.guard_income_expense_owned_payload()'::regprocedure) IS DISTINCT FROM v_header_guard
    OR pg_get_functiondef('app_private.guard_income_expense_owned_items()'::regprocedure) IS DISTINCT FROM v_item_guard
  THEN RAISE EXCEPTION 'deposit repair original guard restoration failed'; END IF;
  DROP TABLE pg_temp.deposit_history_capability;
END;
$repair$;
COMMIT;
