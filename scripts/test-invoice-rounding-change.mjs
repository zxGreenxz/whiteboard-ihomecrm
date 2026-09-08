// DEMO-only, rollback-only payment/report regression harness.
// Optional reviewed migration compiles inside the SAME transaction; never commits DDL.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSupabaseAdminConfig, stripMigrationTransactionControl } from './apply-accounting-rollout.mjs';
import { runQuery, fixtureInvoiceSql, actAsFixtureActorSql } from './lib/v5-collection-harness.mjs';

const migrationPath = process.argv[2];
const body = migrationPath ? stripMigrationTransactionControl(readFileSync(resolve(migrationPath), 'utf8'), migrationPath) : '';
const migration = process.argv.includes('--repeat-migration') ? body + '\n' + body : body;
// The schema-only restore baseline omits ACLs and recreates default grants.
// Reproduce that starting state only inside this rollback transaction.
const simulateRestoreAcl = process.argv.includes('--simulate-restore-acl');
if (simulateRestoreAcl && !body) throw new Error('Restore ACL probe requires a migration');
if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(migration)) throw new Error('Migration must not control transactions');
const sql = `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
${simulateRestoreAcl ? "GRANT EXECUTE ON FUNCTION public.record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text) TO anon;" : ''}
${migration}
${fixtureInvoiceSql({marker:'[E2E-V5-HARNESS:rounding-change]',billingMonth:'2093-09',rent:4805000,deposit:0})}
SELECT set_config('v5h.foreign_building',(SELECT id::text FROM public.buildings
  WHERE organization_id='aaaa0000-0000-4000-8000-000000000001' AND deleted_at IS NULL
  ORDER BY id LIMIT 1),true);
WITH second_virtual AS (
  INSERT INTO public.accounts(organization_id,user_id,code,name,is_virtual,initial_amount)
  SELECT organization_id,user_id,'RH-'||substr(gen_random_uuid()::text,1,8),
    'Rollback rounding account',true,0
  FROM public.accounts WHERE id=current_setting('v5h.virtual_account')::uuid
    AND organization_id='dddd0000-0000-4000-8000-000000000001'
  RETURNING id
) SELECT set_config('v5h.other_virtual',(SELECT id::text FROM second_virtual),true);
-- Grant only this rollback fixture's DEMO actor/account the real possession gate.
INSERT INTO public.cashbook_possession_bindings
 (organization_id, cashbook_id, membership_id, possession_kind, valid_from, reason)
SELECT m.organization_id, current_setting('v5h.account_tm')::uuid, m.id,
 'KNOWER', now() - interval '1 minute', 'rollback-only rounding fixture'
FROM public.organization_memberships m
WHERE m.organization_id = 'dddd0000-0000-4000-8000-000000000001'
 AND m.user_id = current_setting('v5h.actor')::uuid AND m.status = 'ACTIVE'
 AND NOT app_private.ie_has_cashbook_possession_v1(m.organization_id,
   current_setting('v5h.account_tm')::uuid,m.id);
${actAsFixtureActorSql()}
DO $test$
DECLARE
  v_invoice uuid := current_setting('v5h.invoice')::uuid;
  v_account uuid := current_setting('v5h.account_tm')::uuid;
  v_virtual uuid := current_setting('v5h.virtual_account')::uuid;
  v_payload jsonb;
  v_result jsonb;
  v_report jsonb;
  v_retry jsonb;
  v_collection uuid;
  v_delta integer;
  v_expected numeric;
  v_bad jsonb;
  v_i integer := 0;
BEGIN
  v_payload := jsonb_build_array(jsonb_build_object('payment_method','TM',
    'gross_amount',5000000,'requested_change_amount',200000,
    'account_id',v_account,'change_account_id',v_virtual,'rounding_account_id',v_virtual));
  v_result := public.record_invoice_collection_v5(v_invoice,public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),v_payload,
    'REFUND',true,'rounding harness',NULL,0,'rounding-change-0001');
  IF (v_result->>'applied_amount')::numeric IS DISTINCT FROM 4800000
     OR (v_result->>'change_amount')::numeric IS DISTINCT FROM 200000
     OR (v_result->>'rounding_amount')::numeric IS DISTINCT FROM 5000
     OR v_result->'invoice'->>'status' IS DISTINCT FROM 'PAID' THEN
    RAISE EXCEPTION 'Actual-change accounting failed: applied %, change %, rounding %, status %',
      v_result->>'applied_amount',v_result->>'change_amount',v_result->>'rounding_amount',v_result->'invoice'->>'status';
  END IF;
  v_report := public.get_invoice_rounding_report_v1('2093-09',current_setting('v5h.actor')::uuid,
    current_setting('v5h.building')::uuid,0,100);
  IF (v_report->>'total_amount')::numeric IS DISTINCT FROM 5000
     OR (v_report->>'invoice_count')::integer IS DISTINCT FROM 1
     OR v_report->'rows'->0->>'reason' IS DISTINCT FROM 'EXTRA_CHANGE' THEN
    RAISE EXCEPTION 'Rounding report does not reflect collection: %', v_report;
  END IF;
  v_collection := (v_result->>'collection_id')::uuid;
  v_retry := public.record_invoice_collection_v5(v_invoice,public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),v_payload,
    'REFUND',true,'rounding harness',NULL,0,'rounding-change-0001');
  IF v_retry IS DISTINCT FROM v_result THEN RAISE EXCEPTION 'Identical retry changed response'; END IF;
  BEGIN
    PERFORM public.record_invoice_collection_v5(v_invoice,public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),
      jsonb_set(v_payload,'{0,requested_change_amount}','201000'),
      'REFUND',true,'rounding harness',NULL,0,'rounding-change-0001');
    RAISE EXCEPTION 'Changed refund reused idempotency key';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  v_report := public.get_invoice_rounding_report_v1('2093-09',NULL,
    current_setting('v5h.building')::uuid,1,1);
  IF jsonb_array_length(v_report->'rows') IS DISTINCT FROM 0 OR (v_report->>'total_amount')::numeric IS DISTINCT FROM 5000 THEN
    RAISE EXCEPTION 'Pagination changed total'; END IF;
  v_report := public.get_invoice_rounding_report_v1('2093-09',gen_random_uuid(),
    current_setting('v5h.building')::uuid,0,100);
  IF (v_report->>'total_count')::integer IS DISTINCT FROM 0 OR jsonb_array_length(v_report->'by_collector') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Collector filter must preserve selector summary'; END IF;
  PERFORM public.reverse_invoice_collection_v5(v_collection,public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),'rounding reversal','rounding-reverse-0001');
  v_report := public.get_invoice_rounding_report_v1('2093-09',NULL,current_setting('v5h.building')::uuid,0,100);
  IF (v_report->>'total_amount')::numeric IS DISTINCT FROM 0 OR (SELECT paid_amount FROM public.invoices WHERE id=v_invoice) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Reversal did not remove report/paid money'; END IF;

  -- Strict boundary: 0, 1, 9,999 and exactly 10,000; actual net is the only basis.
  FOREACH v_delta IN ARRAY ARRAY[0,1,9999,10000] LOOP
    v_payload := jsonb_build_array(jsonb_build_object('payment_method','TM',
      'gross_amount',5000000,'requested_change_amount',195000+v_delta,
      'account_id',v_account,'change_account_id',v_virtual,'rounding_account_id',v_virtual));
    v_result := public.record_invoice_collection_v5(v_invoice,public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),v_payload,
      'REFUND',true,'boundary',NULL,0,'rounding-boundary-'||v_delta);
    v_expected := CASE WHEN v_delta < 10000 THEN v_delta ELSE 0 END;
    IF (v_result->>'rounding_amount')::numeric IS DISTINCT FROM v_expected
      OR (v_result->>'applied_amount')::numeric IS DISTINCT FROM 4805000-v_delta
      OR ((v_result->'invoice'->>'status' = 'PAID') IS DISTINCT FROM (v_delta < 10000)) THEN
      RAISE EXCEPTION 'Rounding boundary % failed',v_delta;
    END IF;
    PERFORM public.reverse_invoice_collection_v5((v_result->>'collection_id')::uuid,
      public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),'boundary reversal','rounding-boundary-reverse-'||v_delta);
  END LOOP;

  -- Custom refund when gross is exactly due still produces an underpayment waiver.
  v_payload := jsonb_build_array(jsonb_build_object('payment_method','TM',
    'gross_amount',4805000,'requested_change_amount',5000,
    'account_id',v_account,'change_account_id',v_virtual,'rounding_account_id',v_virtual));
  v_result := public.record_invoice_collection_v5(v_invoice,public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),v_payload,
    'REFUND',true,'equal gross',NULL,0,'rounding-equal-gross');
  IF (v_result->>'rounding_amount')::numeric IS DISTINCT FROM 5000 THEN RAISE EXCEPTION 'Equal gross custom refund ignored'; END IF;
  PERFORM public.reverse_invoice_collection_v5((v_result->>'collection_id')::uuid,
    public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),'equal reversal','rounding-equal-reverse');

  -- TM/TK/TM: the last tender is entirely returned; rounding must reach a real payment.
  v_payload := jsonb_build_array(
    jsonb_build_object('payment_method','TM','gross_amount',500000,'requested_change_amount',100000,
      'account_id',v_account,'change_account_id',v_virtual),
    jsonb_build_object('payment_method','TK','gross_amount',4400000,'account_id',v_account,
      'rounding_account_id',current_setting('v5h.other_virtual')::uuid),
    jsonb_build_object('payment_method','TM','gross_amount',100000,'requested_change_amount',100000,
      'account_id',v_account,'change_account_id',v_virtual,'rounding_account_id',v_virtual));
  v_result := public.record_invoice_collection_v5(v_invoice,public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),v_payload,
    'REFUND',true,'last tender zero',NULL,0,'rounding-last-tender-zero');
  v_collection := (v_result->>'collection_id')::uuid;
  IF v_result->'invoice'->>'status' IS DISTINCT FROM 'PAID'
    OR (SELECT sum(rounding_amount) FROM public.payments WHERE collection_id=v_collection) IS DISTINCT FROM 5000
    OR (SELECT rounding_amount FROM public.invoice_payment_tenders WHERE collection_id=v_collection AND line_index=1) IS DISTINCT FROM 5000
    OR (SELECT rounding_account_id FROM public.invoice_payment_tenders WHERE collection_id=v_collection AND line_index=1) IS DISTINCT FROM v_virtual
    OR (SELECT change_amount FROM public.invoice_payment_tenders WHERE collection_id=v_collection AND line_index=2) IS DISTINCT FROM 100000 THEN
    RAISE EXCEPTION 'Zero-applied final tender lost or duplicated rounding/change'; END IF;
  -- Posting tables have their own RLS. Audit ledger sums as the original
  -- harness session, then restore authenticated before every business RPC.
  PERFORM set_config('role','none',true);
  IF (SELECT sum(l.signed_amount) FROM public.income_expense_posting_lines l
      JOIN public.income_expense_postings post ON post.id=l.posting_id
      JOIN public.income_expenses ie ON ie.id=post.voucher_id
      JOIN public.accounts a ON a.id=l.account_id
      WHERE ie.payment_collection_id=v_collection AND NOT a.is_virtual) IS DISTINCT FROM 4800000
     OR (SELECT sum(l.signed_amount) FROM public.income_expense_posting_lines l
      JOIN public.income_expense_postings post ON post.id=l.posting_id
      JOIN public.income_expenses ie ON ie.id=post.voucher_id
      WHERE ie.payment_collection_id=v_collection AND l.line_kind='CHANGE') IS DISTINCT FROM 200000 THEN
    RAISE EXCEPTION 'Refund-only audit changed real cash or lost virtual change'; END IF;
  PERFORM set_config('role','authenticated',true);
  PERFORM public.reverse_invoice_collection_v5(v_collection,public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),'mixed reversal','rounding-mixed-reverse');
  PERFORM set_config('role','none',true);
  IF (SELECT sum(l.signed_amount) FROM public.income_expense_posting_lines l
      JOIN public.income_expense_postings post ON post.id=l.posting_id
      JOIN public.income_expenses ie ON ie.id=post.voucher_id
      WHERE ie.payment_collection_id=v_collection) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Mixed-tender reversal did not neutralize every posting'; END IF;
  PERFORM set_config('role','authenticated',true);

  -- No explicit fields preserves ordinary underpayment and old default refund.
  v_payload := jsonb_build_array(jsonb_build_object('payment_method','TM','gross_amount',4800000,
    'account_id',v_account,'rounding_account_id',v_virtual));
  v_result := public.record_invoice_collection_v5(v_invoice,public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),v_payload,
    'REJECT',true,'legacy client',NULL,0,'rounding-legacy-client');
  v_report := public.get_invoice_rounding_report_v1('2093-09',NULL,current_setting('v5h.building')::uuid,0,100);
  IF (v_result->>'rounding_amount')::numeric IS DISTINCT FROM 5000 OR v_report->'rows'->0->>'reason' IS DISTINCT FROM 'UNDERPAYMENT' THEN
    RAISE EXCEPTION 'Legacy underpayment semantics changed'; END IF;
  PERFORM public.reverse_invoice_collection_v5((v_result->>'collection_id')::uuid,
    public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),'legacy reversal','rounding-legacy-reverse');

  -- Payload validation: no under-refund, cash overrun, nonpositive net,
  -- fractional precision, strings/nulls, incomplete TM lines, or non-TM change.
  v_payload := jsonb_build_array(jsonb_build_object('payment_method','TM','gross_amount',5000000,
    'requested_change_amount',200000,'account_id',v_account,'change_account_id',v_virtual,'rounding_account_id',v_virtual));
  FOR v_bad IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    jsonb_set(v_payload,'{0,requested_change_amount}','194999'),
    jsonb_set(v_payload,'{0,requested_change_amount}','5000001'),
    jsonb_set(v_payload,'{0,requested_change_amount}','5000000'),
    jsonb_set(v_payload,'{0,requested_change_amount}','200000.001'),
    jsonb_set(v_payload,'{0,requested_change_amount}','"200000"'),
    jsonb_set(v_payload,'{0,requested_change_amount}','null'),
    jsonb_set(v_payload,'{0,payment_method}','"TK"'),
    v_payload || jsonb_build_array(jsonb_build_object('payment_method','TM','gross_amount',1000,'account_id',v_account))
  )) LOOP
    v_i := v_i + 1;
    BEGIN
      PERFORM public.record_invoice_collection_v5(v_invoice,public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),v_bad,
        'REFUND',true,'invalid',NULL,0,'rounding-invalid-'||v_i);
      RAISE EXCEPTION 'Invalid refund payload % was accepted',v_i;
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  END LOOP;
  BEGIN
    PERFORM public.record_invoice_collection_v5(v_invoice,public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),v_payload,
      'CREDIT',true,'invalid credit',NULL,0,'rounding-invalid-credit');
    RAISE EXCEPTION 'Explicit cash refund combined with credit';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM public.record_invoice_collection_v5(v_invoice,public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),v_payload,
      'REFUND',true,'stale expected',NULL,1,'rounding-stale-paid');
    RAISE EXCEPTION 'Stale expected paid was accepted';
  EXCEPTION WHEN serialization_failure THEN NULL; END;
  BEGIN
    PERFORM public.get_invoice_rounding_report_v1('2093-09',NULL,gen_random_uuid(),0,100);
    RAISE EXCEPTION 'Unscoped report building was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.get_invoice_rounding_report_v1('2093-09',NULL,
      current_setting('v5h.foreign_building')::uuid,0,100);
    RAISE EXCEPTION 'Foreign-organization report building was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.record_invoice_collection_v5(v_invoice,public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),
      jsonb_set(v_payload,'{0,account_id}',to_jsonb(current_setting('v5h.cross_org_account'))),
      'REFUND',true,'foreign receiving account',NULL,0,'rounding-foreign-account');
    RAISE EXCEPTION 'Foreign receiving account was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
RESET ROLE;
${fixtureInvoiceSql({marker:'[E2E-V5-HARNESS:rounding-deposit]',billingMonth:'2093-10',rent:4800000,deposit:5000})}
${actAsFixtureActorSql()}
DO $deposit$
BEGIN
  BEGIN
    PERFORM public.record_invoice_collection_v5(current_setting('v5h.invoice')::uuid,
      public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),
      jsonb_build_array(jsonb_build_object('payment_method','TM','gross_amount',5000000,
        'requested_change_amount',200000,'account_id',current_setting('v5h.account_tm')::uuid,
        'change_account_id',current_setting('v5h.virtual_account')::uuid,
        'rounding_account_id',current_setting('v5h.virtual_account')::uuid)),
      'REFUND',true,'deposit guard',NULL,0,'rounding-deposit-guard');
    RAISE EXCEPTION 'Deposit shortage was waived';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $deposit$;
RESET ROLE;
${fixtureInvoiceSql({marker:'[E2E-V5-HARNESS:rounding-legacy]',billingMonth:'2093-11',rent:4805000,deposit:0})}
DO $legacy_fixture$
DECLARE
  v_invoice public.invoices%ROWTYPE;
  v_payment uuid;
BEGIN
  SELECT * INTO v_invoice FROM public.invoices WHERE id=current_setting('v5h.invoice')::uuid
    AND organization_id='dddd0000-0000-4000-8000-000000000001';
  IF v_invoice.id IS NULL THEN RAISE EXCEPTION 'Legacy fixture must be DEMO'; END IF;
  PERFORM app_private.begin_accounting_chain_write_v1();
  INSERT INTO public.payments(organization_id,user_id,invoice_id,amount,received_amount,
    payment_method,payment_date,rounding_amount)
  VALUES(v_invoice.organization_id,v_invoice.user_id,v_invoice.id,4800000,4800000,
    'TM',public.org_today_v1(v_invoice.organization_id),5000) RETURNING id INTO v_payment;
  INSERT INTO public.income_expenses(organization_id,user_id,building_id,room_id,
    contract_id,invoice_id,payment_id,account_id,type,name,voucher_date,total_amount,
    approval_status,approved_by,approved_at,maker_user_id,rounding_amount,rounding_account_id)
  VALUES(v_invoice.organization_id,v_invoice.user_id,v_invoice.building_id,v_invoice.room_id,
    v_invoice.contract_id,v_invoice.id,v_payment,current_setting('v5h.account_tm')::uuid,
    'INCOME','Legacy rounding fixture',public.org_today_v1(v_invoice.organization_id),4800000,
    'APPROVED',current_setting('v5h.actor')::uuid,now(),current_setting('v5h.actor')::uuid,
    5000,current_setting('v5h.virtual_account')::uuid);
  PERFORM app_private.end_accounting_chain_write_v1();
END $legacy_fixture$;
${actAsFixtureActorSql()}
DO $legacy_report$
DECLARE v_report jsonb;
BEGIN
  v_report:=public.get_invoice_rounding_report_v1('2093-11',NULL,current_setting('v5h.building')::uuid,0,100);
  IF (v_report->>'total_amount')::numeric IS DISTINCT FROM 5000 OR (v_report->>'total_count')::integer IS DISTINCT FROM 1
    OR v_report->'rows'->0->>'collector_id' IS DISTINCT FROM current_setting('v5h.actor') THEN
    RAISE EXCEPTION 'Legacy receipt rounding duplicated or collector lost: %',v_report; END IF;
END $legacy_report$;
RESET ROLE;
DO $report_authz_fixture$
DECLARE
  v_org constant uuid := 'dddd0000-0000-4000-8000-000000000001';
  v_member uuid;
  v_actor uuid;
  v_scope uuid;
  v_override uuid;
  v_permission text;
BEGIN
  SELECT m.id,m.user_id INTO v_member,v_actor FROM public.organization_memberships m
  WHERE m.organization_id=v_org AND m.status='ACTIVE'
    AND NOT app_private.is_org_owner_v1(v_org,m.user_id)
    AND NOT EXISTS(SELECT 1 FROM public.super_admins sa WHERE sa.user_id=m.user_id)
  ORDER BY m.id LIMIT 1;
  SELECT id INTO v_scope FROM public.authorization_scopes
  WHERE organization_id=v_org AND scope_type='BUILDING' AND building_id=current_setting('v5h.building')::uuid;
  IF v_actor IS NULL OR v_scope IS NULL THEN RAISE EXCEPTION 'Missing DEMO role fixture'; END IF;
  FOREACH v_permission IN ARRAY ARRAY['buildings.view','thu_tien.collect','thu_tien.report'] LOOP
    INSERT INTO public.member_permission_overrides
      (organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode)
    VALUES(v_org,v_member,v_permission,CASE WHEN v_permission='thu_tien.report' THEN 'DENY' ELSE 'ALLOW' END,
      'rollback-only rounding report matrix',current_setting('v5h.actor')::uuid,'SCOPED')
    RETURNING id INTO v_override;
    INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id)
    VALUES(v_org,v_override,v_scope);
  END LOOP;
  IF NOT COALESCE((SELECT allowed FROM app_private.authorize_tenant_action_v3(
    v_actor,v_org,'thu_tien.collect',current_setting('v5h.building')::uuid,NULL)),false) THEN
    RAISE EXCEPTION 'Report-denied fixture must still have collection permission'; END IF;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::text,true);
END $report_authz_fixture$;
SET LOCAL ROLE authenticated;
DO $report_denied$
BEGIN
  IF NOT public.can_access_building(current_setting('v5h.building')::uuid) THEN
    RAISE EXCEPTION 'Report-denied fixture must still have building visibility'; END IF;
  BEGIN
    PERFORM public.get_invoice_rounding_report_v1('2093-09',NULL,current_setting('v5h.building')::uuid,0,100);
    RAISE EXCEPTION 'Collector without report permission accessed report';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $report_denied$;
RESET ROLE;
DO $acl$
BEGIN
  IF has_function_privilege('anon','public.get_invoice_rounding_report_v1(text,uuid,uuid,integer,integer)','EXECUTE')
    OR has_function_privilege('service_role','public.get_invoice_rounding_report_v1(text,uuid,uuid,integer,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'Report ACL is broader than authenticated'; END IF;
END $acl$;
ROLLBACK;`;
const config = loadSupabaseAdminConfig();
await runQuery(sql, config);
console.log('PASS: refund boundaries, mixed tenders, retry, stale paid, reversal, report sums/paging/filter scope; transaction rolled back');
