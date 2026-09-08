import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSupabaseAdminConfig, stripMigrationTransactionControl } from './apply-accounting-rollout.mjs';
import { runQuery } from './lib/v5-collection-harness.mjs';

const config = loadSupabaseAdminConfig({ readFile: (path, encoding) =>
  readFileSync(String(path).includes('CLAUDE.local.md') && process.env.IHOMECRM_SECRET_FILE
    ? process.env.IHOMECRM_SECRET_FILE : path, encoding) });
const args = process.argv.slice(2);
if (args[0] === '--catalog') {
  const rows = await runQuery(`SELECT n.nspname,p.proname,p.oid::regprocedure::text AS signature,
    md5(pg_get_functiondef(p.oid)) AS definition_md5,pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.proname IN ('create_invoice_v1','update_invoice_v1','contract_deposit_sources_v1',
      'resolve_signed_contract_deposit_basis_v1','derive_contract_deposit_paid')`,config);
  writeFileSync(resolve(args[1]),JSON.stringify(rows,null,2));
  console.log('Read-only live catalog saved:',rows.map(r=>({signature:r.signature,md5:r.definition_md5})));
  process.exit(0);
}
const path = args.find(a=>!a.startsWith('--'));
let migration = path ? stripMigrationTransactionControl(readFileSync(resolve(path),'utf8'),path) : '';
if(args.includes('--mutation=writer')) migration=migration.replaceAll("coalesce(it->>'accounting_class','REVENUE')","'REVENUE'");
if(args.includes('--mutation=basis')) migration=migration.replaceAll('deposit_items.amount','ie.total_amount');
if(args.some(a=>a.startsWith('--mutation=')) && args.includes('--repeat-migration')) throw new Error('Run mutations without repeat');
let sql = readFileSync(new URL('../docs/audits/2026-09-08-invoice-edit-deposit.probe.sql',import.meta.url),'utf8')
  .replaceAll("IS DISTINCT FROM 'REVENUE' THEN RAISE EXCEPTION 'loss not reproduced:","IS DISTINCT FROM 'DEPOSIT' THEN RAISE EXCEPTION 'DEPOSIT classification lost:")
  .replaceAll('BUG_REPRODUCED','PASS');
sql = sql.replace('BEGIN;',()=>`BEGIN;\n${migration}\n${args.includes('--repeat-migration')?migration:''}`);
const updateCall=`PERFORM public.update_invoice_v1(v.id,v.contract_id,v.building_id,v.room_id,v.billing_month,
  v.issue_date,v.due_date,v.subtotal,v.discount_amount,v.total_amount,v.previous_debt,items,
  v.prepaid_amount,v.discount_notes,v.electricity_prev_overridden,v.previous_debt_sources,v.template_id,'classification regression');`;
const cases=`
RESET ROLE;
INSERT INTO public.organization_invoice_settings(organization_id,auto_approve_invoice)
VALUES('dddd0000-0000-4000-8000-000000000001',true)
ON CONFLICT(organization_id) DO UPDATE SET auto_approve_invoice=true;
SET LOCAL ROLE authenticated;
DO $boundary$
DECLARE v public.invoices%ROWTYPE; items jsonb; saved jsonb; bad jsonb; old_building uuid; old_room uuid; result json; id_new uuid;
BEGIN
 SELECT * INTO STRICT v FROM public.invoices WHERE id=current_setting('v5h.invoice')::uuid;
 SELECT jsonb_agg(to_jsonb(i) ORDER BY sort_order) INTO items FROM public.invoice_items i WHERE invoice_id=v.id;
 saved:=items;
 FOREACH bad IN ARRAY ARRAY['null'::jsonb,'"INVALID"'::jsonb,'""'::jsonb,'0'::jsonb] LOOP
  items:=jsonb_set(saved,'{1,accounting_class}',bad);
  BEGIN ${updateCall} RAISE EXCEPTION 'Accepted invalid class'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 END LOOP;
 items:=jsonb_set(saved,'{1,id}',to_jsonb(gen_random_uuid()::text));
 BEGIN ${updateCall} RAISE EXCEPTION 'Accepted foreign item'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 items:=saved; old_building:=v.building_id; v.building_id:=gen_random_uuid();
 BEGIN ${updateCall} RAISE EXCEPTION 'Accepted foreign building'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 v.building_id:=old_building; old_room:=v.room_id; v.room_id:=gen_random_uuid();
 BEGIN ${updateCall} RAISE EXCEPTION 'Accepted foreign room'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
 v.room_id:=old_room;
 -- Matching by identity may edit amount; class survives when omitted by old clients.
 items:=jsonb_set(saved,'{1,unit_price}','2300000') #- '{1,accounting_class}';
 items:=jsonb_set(items,'{1,amount}','2300000');
 ${updateCall}
 IF NOT EXISTS(SELECT 1 FROM public.invoice_items WHERE invoice_id=v.id AND accounting_class='DEPOSIT' AND unit_price=2300000) THEN
  RAISE EXCEPTION 'Legacy amount edit lost deposit'; END IF;
 -- Explicit replacement adds deposit while arbitrary text containing cọc stays revenue.
 items:=jsonb_build_array(jsonb_build_object('type','OTHER','description','New liability','amount',2200000,'accounting_class','DEPOSIT'),
  jsonb_build_object('type','OTHER','description','Dịch vụ có chữ cọc','amount',5290000,'accounting_class','REVENUE'));
 ${updateCall}
 IF (SELECT count(*) FROM public.invoice_items WHERE invoice_id=v.id AND accounting_class='DEPOSIT')<>1 THEN RAISE EXCEPTION 'Name classifier leak'; END IF;
 -- Ambiguous legacy clients cannot delete, rename or duplicate a deposit silently.
 items:=jsonb_build_array(jsonb_build_object('type','OTHER','description','renamed','amount',7490000));
 BEGIN ${updateCall} RAISE EXCEPTION 'Accepted unmappable legacy'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 items:='[]';
 BEGIN ${updateCall} RAISE EXCEPTION 'Accepted legacy empty items'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 items:=jsonb_build_array(jsonb_build_object('type','OTHER','description','Duplicate','amount',2200000,'accounting_class','DEPOSIT'),
  jsonb_build_object('type','OTHER','description','Duplicate','amount',5290000,'accounting_class','REVENUE'));
 ${updateCall}
 items:=items #- '{0,accounting_class}' #- '{1,accounting_class}';
 BEGIN ${updateCall} RAISE EXCEPTION 'Accepted ambiguous legacy names'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 items:=jsonb_build_array(jsonb_build_object('type','OTHER','description','Standalone deposit','amount',2200000,'accounting_class','DEPOSIT'));
 result:=public.create_invoice_v1(v.contract_id,v.building_id,v.room_id,'2094-02','2094-02-01','2094-02-10','MONTHLY',2200000,0,2200000,0,items,'deposit-create-test');
 id_new:=(result->>'invoice_id')::uuid;
 IF NOT EXISTS(SELECT 1 FROM public.invoice_items WHERE invoice_id=id_new AND accounting_class='DEPOSIT') THEN RAISE EXCEPTION 'Create lost explicit deposit'; END IF;
 IF public.create_invoice_v1(v.contract_id,v.building_id,v.room_id,'2094-02','2094-02-01','2094-02-10','MONTHLY',2200000,0,2200000,0,items,'deposit-create-test')::jsonb IS DISTINCT FROM result::jsonb THEN RAISE EXCEPTION 'Create idempotency broken'; END IF;
 items:=jsonb_set(items,'{0,accounting_class}','null');
 BEGIN PERFORM public.create_invoice_v1(v.contract_id,v.building_id,v.room_id,'2094-03','2094-03-01','2094-03-10','MONTHLY',2200000,0,2200000,0,items,'deposit-invalid-test');
  RAISE EXCEPTION 'Create accepted invalid class'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 PERFORM set_config('deposit_test.boundaries','PASS',true);
END $boundary$;
RESET ROLE;
DO $paid_setup$ BEGIN
 UPDATE public.invoices SET status='PAID',paid_amount=7490000 WHERE id=current_setting('v5h.invoice')::uuid
 AND organization_id='dddd0000-0000-4000-8000-000000000001';
END $paid_setup$;
SET LOCAL ROLE authenticated;
DO $paid$
DECLARE v public.invoices%ROWTYPE; items jsonb:='[]'; rejected boolean:=false;
BEGIN
 SELECT * INTO STRICT v FROM public.invoices WHERE id=current_setting('v5h.invoice')::uuid;
 BEGIN ${updateCall} EXCEPTION WHEN SQLSTATE 'P0001' THEN rejected:=true; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Paid invoice editable'; END IF;
END $paid$;
`;
sql=sql.replace("RESET ROLE;\nSELECT jsonb_build_object('mode'",()=>cases+readFileSync(new URL('./lib/invoice-deposit-basis-fixture.sql',import.meta.url),'utf8')+"\nRESET ROLE;\nSELECT jsonb_build_object('mode'");
sql=sql.replace("'mode','DEMO_BEGIN_ROLLBACK_NO_DDL'", "'boundaries',current_setting('deposit_test.boundaries'),'basis',current_setting('deposit_test.basis'),'mode','DEMO_BEGIN_ROLLBACK'");
const result = await runQuery(sql,config);
const proof=result.find(r=>r.proof)?.proof;
if(proof?.boundaries!=='PASS' || proof?.basis!=='PASS' || proof?.results?.length!==2) throw new Error('Missing regression proof');
console.log(JSON.stringify({mode:'DEMO_BEGIN_ROLLBACK',migration:path??null,
  results:proof?.results?.map(r=>({scenario:r.scenario,status:r.status})),boundaries:proof.boundaries,basis:proof.basis,catalog_md5:proof?.catalog?.definition_md5},null,2));
