// Real canonical collection and repair, DEMO-only, in one rollback transaction.
import { readFileSync, writeFileSync } from 'node:fs';
import { fixtureInvoiceSql, actAsFixtureActorSql, runQuery } from './lib/v5-collection-harness.mjs';
import { stripMigrationTransactionControl } from './apply-accounting-rollout.mjs';

const file = process.argv.slice(2).find(x=>!x.startsWith('--')) || 'supabase/migrations/20260908052713_repair_invoice_deposit_classification_history.sql';
const source = readFileSync(file,'utf8');
// Optional integration proof: definitions compile in the same rollback transaction.
// Usage: --with-release-migrations=path/to/rounding.sql,path/to/writer.sql
const releaseArgument = process.argv.find(x=>x.startsWith('--with-release-migrations='));
const releaseMigrationSql = releaseArgument ? releaseArgument.split('=').slice(1).join('=').split(',').map(path=>{
 if(!/202609080(41231_invoice_actual_change_rounding_report|51659_invoice_deposit_classification)\.sql$/.test(path)) throw new Error('Only reviewed rounding/writer release definitions may be prepended');
 return stripMigrationTransactionControl(readFileSync(path,'utf8'),path);
}).join('\n') : '';
let repair = stripMigrationTransactionControl(source,file)
  .replaceAll('d502976f-c0eb-4585-ad00-67caf8b017e6','271b01f7-fa19-4607-b07a-982db43999ea')
  .replaceAll('c053bbcd-37ae-4986-92d4-008a5223baf7','65fb6162-c49e-419c-a576-5da6adaff187')
  .replace("'aaaa0000-0000-4000-8000-000000000001'", "'dddd0000-0000-4000-8000-000000000001'")
  .replace(/v_manifest constant jsonb := '[^']+'::jsonb;/, 'v_manifest constant jsonb := (SELECT jsonb_agg(data ORDER BY ordinal) FROM pg_temp.history_fixture_manifest);');
if(repair.includes('aaaa0000-0000-4000-8000-000000000001')) throw new Error('Unsafe real-organization repair in harness');
const cases = [[7450000,3600000],[7490000,2200000],[4720000,1600000],[3900000,3900000]];
const setup = cases.map(([total,deposit],i)=>`
${fixtureInvoiceSql({marker:`[E2E-V5-HARNESS:deposit-history-${i}]`,billingMonth:`2094-0${i+1}`,rent:total-deposit,deposit})}
DO $damage$
DECLARE old_item public.invoice_items%ROWTYPE; new_id uuid; event_at timestamptz;
BEGIN
 SELECT * INTO STRICT old_item FROM public.invoice_items WHERE invoice_id=current_setting('v5h.invoice')::uuid AND accounting_class='DEPOSIT';
 DELETE FROM public.invoice_items WHERE id=old_item.id;
 new_id:=gen_random_uuid();
 INSERT INTO public.invoice_items(id,organization_id,invoice_id,type,description,quantity,coefficient,unit_price,amount,accounting_class,sort_order)
 VALUES(new_id,old_item.organization_id,old_item.invoice_id,'OTHER',old_item.description,1,1,${deposit},${deposit},'REVENUE',old_item.sort_order);
 SELECT created_at INTO STRICT event_at FROM public.invoice_audit_log WHERE entity_id=new_id AND action='INSERT' AND entity='item';
 INSERT INTO pg_temp.history_fixture_manifest(ordinal,data) VALUES(${i},jsonb_build_object('invoice_id',old_item.invoice_id,'item_id',new_id,'old_item_id',old_item.id,'event_at',event_at,'deposit',${deposit},'total',${total}));
END $damage$;
INSERT INTO public.cashbook_possession_bindings(organization_id,cashbook_id,membership_id,possession_kind,valid_from,reason)
SELECT m.organization_id,current_setting('v5h.account_tm')::uuid,m.id,'KNOWER',now()-interval '1 minute','rollback-only history fixture'
FROM public.organization_memberships m WHERE m.organization_id='dddd0000-0000-4000-8000-000000000001'
 AND m.user_id=current_setting('v5h.actor')::uuid AND m.status='ACTIVE'
 AND NOT app_private.ie_has_cashbook_possession_v1(m.organization_id,current_setting('v5h.account_tm')::uuid,m.id);
${actAsFixtureActorSql()}
SELECT public.record_invoice_collection_v5(current_setting('v5h.invoice')::uuid,
 public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),
 jsonb_build_array(jsonb_build_object('payment_method','TM','gross_amount',${total},'account_id',current_setting('v5h.account_tm')::uuid)),
 'REFUND',true,'deposit history rollback fixture',NULL,0,'deposit-history-${i}');
RESET ROLE;
UPDATE pg_temp.history_fixture_manifest m SET data=data||jsonb_build_object(
 'contract_id',v.contract_id,'voucher_id',v.id,'line_id',it.id,'payment_id',v.payment_id,
 'collection_id',v.payment_collection_id,'account_id',v.account_id,'voucher_date',v.voucher_date)
FROM public.income_expenses v JOIN public.income_expense_items it ON it.income_expense_id=v.id
WHERE m.ordinal=${i} AND v.invoice_id=(m.data->>'invoice_id')::uuid;
`).join('\n');
const sqlString = value => "'"+value.replaceAll("'","''")+"'";
const negativeTests = `
DO $negative$
DECLARE failed boolean; original_closure text;
BEGIN
 -- Fail after the first cohort was actually changed: subtransaction restores rows AND DDL.
 failed:=false;
 BEGIN
  UPDATE history_fixture_manifest SET data=jsonb_set(data,'{total}','7490001') WHERE ordinal=1;
  EXECUTE ${sqlString(repair)};
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE 'deposit repair cohort precondition failed %' THEN RAISE; END IF;
  failed:=true;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'Changed cohort was accepted'; END IF;
 failed:=false;
 BEGIN
  UPDATE history_fixture_manifest SET data=jsonb_set(data,'{invoice_id}',to_jsonb(gen_random_uuid())) WHERE ordinal=1;
  EXECUTE ${sqlString(repair)};
 EXCEPTION WHEN no_data_found THEN failed:=true;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'Missing one cohort was accepted'; END IF;
 IF EXISTS(SELECT 1 FROM history_guard_before WHERE pg_get_functiondef(oid) IS DISTINCT FROM definition)
  OR EXISTS(SELECT 1 FROM history_fixture_manifest m JOIN public.invoice_items i ON i.id=(m.data->>'item_id')::uuid WHERE i.accounting_class<>'REVENUE') THEN
  RAISE EXCEPTION 'Failure leaked temporary guard or partial repair'; END IF;
 -- Fault injection at the canonical recognition-period boundary, rolled back on rejection.
 original_closure:=pg_get_functiondef('app_private.finance_v2_is_recognition_period_open(uuid,date)'::regprocedure);
 failed:=false;
 BEGIN
  EXECUTE 'CREATE OR REPLACE FUNCTION app_private.finance_v2_is_recognition_period_open(p_org uuid,p_period date) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS ''SELECT false''';
  EXECUTE ${sqlString(repair)};
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE 'deposit repair closed period %' THEN RAISE; END IF;
  failed:=true;
 END;
 IF NOT failed OR pg_get_functiondef('app_private.finance_v2_is_recognition_period_open(uuid,date)'::regprocedure) IS DISTINCT FROM original_closure THEN
  RAISE EXCEPTION 'Closed-period gate or rollback failed'; END IF;
END $negative$;
`;
const sql = `BEGIN;
SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s';
${releaseMigrationSql}
CREATE TEMP TABLE history_fixture_manifest(ordinal integer PRIMARY KEY,data jsonb);
GRANT SELECT ON history_fixture_manifest TO authenticated;
CREATE TEMP TABLE history_guard_before AS SELECT oid,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid IN
 ('app_private.guard_income_expense_owned_payload()'::regprocedure,'app_private.guard_income_expense_owned_items()'::regprocedure);
${setup}
DO $settlement_fixture$
DECLARE t public.contract_terminations%ROWTYPE; v_id uuid;
BEGIN
 INSERT INTO public.contract_terminations(organization_id,user_id,contract_id,actual_move_out_date,termination_type,total_deposit,status,
   outstanding_debt,prorated_rent,prorated_services,prorated_days,other_fees,rent_refund_amount)
 SELECT 'dddd0000-0000-4000-8000-000000000001',current_setting('v5h.actor')::uuid,(data->>'contract_id')::uuid,
  '2094-12-31','NORMAL',0,'COMPLETED',0,0,0,0,58500,1950000 FROM history_fixture_manifest WHERE ordinal=3
 RETURNING * INTO t;
 INSERT INTO public.income_expenses(organization_id,user_id,contract_id,building_id,room_id,account_id,type,name,total_amount,approval_status,voucher_date)
 SELECT i.organization_id,current_setting('v5h.actor')::uuid,i.contract_id,i.building_id,i.room_id,current_setting('v5h.account_tm')::uuid,
  'EXPENSE','DEMO pending rent refund',1891500,'UNAPPROVED',CURRENT_DATE FROM public.invoices i WHERE i.id=current_setting('v5h.invoice')::uuid
 RETURNING id INTO v_id;
 UPDATE history_fixture_manifest SET data=data||jsonb_build_object('termination_id',t.id,'termination_digest',md5(to_jsonb(t)::text),
  'settlement_vouchers',jsonb_build_array(jsonb_build_object('id',v_id,'digest',(SELECT md5(to_jsonb(v)::text) FROM public.income_expenses v WHERE v.id=v_id)))) WHERE ordinal=3;
END $settlement_fixture$;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT set_config('history.deposit_before',public.contract_deposit_paid_derived(current_setting('v5h.contract')::uuid)::text,true);
${process.argv.includes('--red')?'':negativeTests}
${process.argv.includes('--red')?'':repair}
DO $assert$
DECLARE r record;
BEGIN
 FOR r IN SELECT data FROM pg_temp.history_fixture_manifest LOOP
  IF (SELECT accounting_class FROM public.invoice_items WHERE id=(r.data->>'item_id')::uuid) IS DISTINCT FROM 'DEPOSIT' THEN
   RAISE EXCEPTION 'RED: audit-proven deposit was not restored'; END IF;
  IF (SELECT sum(amount) FROM public.income_expense_items WHERE income_expense_id=(r.data->>'voucher_id')::uuid AND accounting_class='DEPOSIT') IS DISTINCT FROM (r.data->>'deposit')::numeric THEN
   RAISE EXCEPTION 'Receipt deposit amount wrong'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM history_guard_before WHERE pg_get_functiondef(oid) IS DISTINCT FROM definition) THEN
  RAISE EXCEPTION 'Original guards not restored'; END IF;
 IF (SELECT count(*) FROM public.accounting_integrity_exceptions e WHERE e.organization_id='dddd0000-0000-4000-8000-000000000001'
   AND e.entity_id=current_setting('v5h.contract')::uuid AND e.exception_code='RESTORED_DEPOSIT_REQUIRES_SETTLEMENT_REVIEW' AND e.status='OPEN') <> 1 THEN
  RAISE EXCEPTION 'Completed settlement requires exactly one durable exception'; END IF;
 IF public.contract_deposit_paid_derived(current_setting('v5h.contract')::uuid) IS DISTINCT FROM current_setting('history.deposit_before')::numeric+11300000 THEN
  RAISE EXCEPTION 'Derived deposit lost or duplicated money'; END IF;
 BEGIN
  UPDATE public.income_expense_items SET amount=amount+1 WHERE id=(SELECT (data->>'line_id')::uuid FROM history_fixture_manifest WHERE ordinal=0);
  RAISE EXCEPTION 'Restored canonical item guard admitted arbitrary update';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
 BEGIN
  UPDATE public.income_expenses SET total_amount=total_amount+1 WHERE id=(SELECT (data->>'voucher_id')::uuid FROM history_fixture_manifest WHERE ordinal=0);
  RAISE EXCEPTION 'Restored canonical header guard admitted arbitrary update';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
END $assert$;
CREATE TEMP TABLE history_audit_first AS SELECT * FROM public.accounting_repair_audit WHERE repair_code='INVOICE_DEPOSIT_CLASS_HISTORY_20260908' AND organization_id='dddd0000-0000-4000-8000-000000000001';
${process.argv.includes('--red')?'':repair}
DO $repeat$
BEGIN
 IF EXISTS((SELECT * FROM history_audit_first EXCEPT SELECT * FROM public.accounting_repair_audit) UNION ALL
 (SELECT * FROM public.accounting_repair_audit WHERE repair_code='INVOICE_DEPOSIT_CLASS_HISTORY_20260908' AND organization_id='dddd0000-0000-4000-8000-000000000001' EXCEPT SELECT * FROM history_audit_first)) THEN
 RAISE EXCEPTION 'Repeat changed durable audit'; END IF;
END $repeat$;
${actAsFixtureActorSql()}
DO $reverse$
DECLARE r record;
BEGIN
 FOR r IN SELECT ordinal,data FROM history_fixture_manifest ORDER BY ordinal LOOP
  PERFORM public.reverse_invoice_collection_v5((r.data->>'collection_id')::uuid,
   public.org_today_v1('dddd0000-0000-4000-8000-000000000001'),'history rollback reversal','history-reverse-'||r.ordinal);
 END LOOP;
END $reverse$;
RESET ROLE;
DO $reversed$
BEGIN
 IF public.contract_deposit_paid_derived(current_setting('v5h.contract')::uuid) IS DISTINCT FROM current_setting('history.deposit_before')::numeric THEN
 RAISE EXCEPTION 'Reversal did not remove restored deposits'; END IF;
END $reversed$;
SELECT 'PASS: four canonical receipts, full/mixed deposits, cash/payment/posting invariants, completed settlement+pending refund unchanged, one exception, error rollback, closure rejection, original guards, repeat, reversal' result;
ROLLBACK;`;
if(process.argv.includes('--sql')) {writeFileSync('.tmp/history-harness.sql',sql);process.exit(0);}
const result=await runQuery(sql);
console.log(JSON.stringify(result));
