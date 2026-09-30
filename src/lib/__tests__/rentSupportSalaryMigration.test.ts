import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { setupPayoutDb, org, actor, room, building, uuid } from './fixtures/rentSupportPayoutDb';
const migration='supabase/migrations/20260930112705_rent_support_salary_source_bridge.sql';
const db=new PGlite();
beforeAll(async()=>{
 await setupPayoutDb(db,'supabase/migrations/20260930101338_rent_support_upfront_payouts.sql');
 await db.exec(`
 CREATE TABLE app_private.canonical_write_operations(organization_id uuid,operation text,subject_scope text,completed_at timestamptz,response_payload jsonb);
 ALTER TABLE public.buildings ADD COLUMN created_at timestamptz DEFAULT now();INSERT INTO public.buildings(id,organization_id,status,is_virtual) VALUES('${uuid(703)}','${org}','ACTIVE',true);
 CREATE OR REPLACE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$ SELECT $2='${org}'::uuid AND $4 IN('${building}'::uuid,'${uuid(703)}'::uuid) AND current_setting('test.deny',true) IS DISTINCT FROM 'yes' $$;
 ALTER TABLE public.income_expenses ADD COLUMN updated_at timestamptz DEFAULT now(),ADD COLUMN review_version bigint DEFAULT 0,ADD COLUMN approval_version bigint DEFAULT 1,ADD COLUMN posting_version bigint DEFAULT 0,ADD COLUMN posting_status text DEFAULT 'UNPOSTED',ADD COLUMN active_posting_id_v2 uuid,ADD COLUMN salary_staff_id uuid,ADD COLUMN building_id uuid DEFAULT '${building}',ADD COLUMN user_id uuid DEFAULT '${actor}',ADD COLUMN payer_name text,ADD COLUMN receive_bank_account text,ADD COLUMN receive_bank_name text,ADD COLUMN attachments jsonb DEFAULT '[]',ADD COLUMN name text,ADD COLUMN system_source text DEFAULT 'contract.commission';
 ALTER TABLE public.income_expense_items ADD COLUMN start_date date DEFAULT '2026-09-30',ADD COLUMN end_date date DEFAULT '2026-09-30',ADD COLUMN organization_id uuid DEFAULT '${org}',ADD COLUMN income_expense_type_id uuid DEFAULT '${uuid(700)}',ADD COLUMN quantity numeric DEFAULT 1,ADD COLUMN unit_price numeric,ADD COLUMN description text;
 CREATE TABLE public.income_expense_types(id uuid PRIMARY KEY,category text,name text);
 INSERT INTO public.income_expense_types VALUES('${uuid(700)}','HOA HỒNG','Hoa hồng');
 ALTER TABLE public.salary_monthly ADD COLUMN id uuid DEFAULT gen_random_uuid() PRIMARY KEY,ADD COLUMN take_home numeric DEFAULT 0,ADD COLUMN commission_total numeric DEFAULT 0,ADD COLUMN paid numeric DEFAULT 0,ADD COLUMN payout_voucher_id uuid;
 CREATE UNIQUE INDEX fixture_salary_unique ON public.salary_monthly(staff_id,period_month);
 CREATE TABLE app_private.salary_commission_books(organization_id uuid PRIMARY KEY,account_id uuid);
 INSERT INTO public.accounts VALUES('${uuid(701)}','${org}',true,NULL,'${actor}');
 INSERT INTO app_private.salary_commission_books VALUES('${org}','${uuid(701)}');
 INSERT INTO public.manager_salary_config VALUES('${org}','${actor}',true);
 INSERT INTO public.organization_memberships VALUES('${uuid(702)}','${actor}','${org}','ACTIVE',now()-interval '1 day',NULL,NULL);
 CREATE FUNCTION app_private.salary_staff_org_v1(uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
 CREATE FUNCTION public.assign_commission_manager_v1(uuid,uuid,bigint,text) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
 UPDATE public.income_expenses SET account_id='${uuid(701)}' WHERE id=$1;
 INSERT INTO app_private.commission_manager_links VALUES($1,'${org}',$2) ON CONFLICT(voucher_id) DO UPDATE SET manager_id=$2;
 RETURN jsonb_build_object('voucher_id',$1,'manager_id',$2,'account_id','${uuid(701)}','approval_version',1,'moved',true,'lap_lai',false);END $$;
 CREATE FUNCTION public.lock_salary_month_v2(date,jsonb,text) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE m jsonb;v uuid;BEGIN
 FOR m IN SELECT value FROM jsonb_array_elements($2) LOOP
 INSERT INTO public.salary_monthly(organization_id,staff_id,period_month,status,take_home,commission_total) VALUES('${org}',(m->>'staff_id')::uuid,$1,'LOCKED',(m->>'take_home')::numeric,(m->>'commission_total')::numeric)
 ON CONFLICT(staff_id,period_month) DO UPDATE SET status='LOCKED',take_home=excluded.take_home,commission_total=excluded.commission_total;
 FOR v IN SELECT value::uuid FROM jsonb_array_elements_text(m->'commission_voucher_ids') LOOP INSERT INTO app_private.salary_commission_inclusions VALUES(v,'${org}',(m->>'staff_id')::uuid,$1);END LOOP;END LOOP;RETURN '{}'::jsonb;END $$;
 CREATE FUNCTION public.unlock_salary_month_v2(date,uuid[],text) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN UPDATE public.salary_monthly SET status='DRAFT' WHERE period_month=$1 AND staff_id=ANY($2);
 DELETE FROM app_private.salary_commission_inclusions WHERE period_month=$1 AND staff_id=ANY($2);RETURN '{}'::jsonb;END $$;
 CREATE FUNCTION public.salary_payout_v1(uuid,date,numeric,uuid,date,text,text,uuid DEFAULT NULL,numeric DEFAULT NULL) RETURNS json LANGUAGE plpgsql AS $$ DECLARE v uuid;BEGIN
 INSERT INTO public.income_expenses(organization_id,salary_staff_id,type,approval_status,total_amount,account_id) VALUES('${org}',$1,'EXPENSE','UNAPPROVED',$3,$4) RETURNING id INTO v;
 RETURN json_build_object('salary_voucher_id',v,'state','PENDING_APPROVAL');END $$;
 `);
 await db.exec("\n CREATE FUNCTION public.revise_pending_income_expense_v1(p_voucher uuid,p_expected_approval_version bigint,p_patch jsonb,p_items jsonb DEFAULT NULL,p_reason text DEFAULT NULL,p_idempotency_key text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN\n IF p_patch ? 'contract_id' THEN RAISE EXCEPTION 'System commission cannot change contract in general revision';END IF;\n UPDATE public.income_expenses SET contract_id=COALESCE((p_patch->>'contract_id')::uuid,contract_id),total_amount=(p_items->0->>'unit_price')::numeric,approval_version=approval_version+1 WHERE id=p_voucher AND approval_version=p_expected_approval_version;\n UPDATE public.income_expense_items SET amount=(p_items->0->>'unit_price')::numeric,unit_price=(p_items->0->>'unit_price')::numeric WHERE income_expense_id=p_voucher;RETURN jsonb_build_object('voucher_id',p_voucher);END $$;\n CREATE FUNCTION public.cancel_income_expense_flex_v1(p_voucher uuid,p_reason text,p_expected_approval_version bigint DEFAULT NULL,p_expected_posting_version bigint DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'STRICT_MODE'; UPDATE public.income_expenses SET approval_status='CANCELLED' WHERE id=p_voucher;RETURN jsonb_build_object('voucher_id',p_voucher);END $$;\n CREATE FUNCTION app_private.assert_no_engine_request_v1(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN;END $$;\n CREATE FUNCTION app_private.assert_period_open_for_edit_v1(uuid,text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN;END $$;\n");
 await db.exec(`CREATE FUNCTION app_private.begin_ie_flex_write_v1(uuid,text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN;END $$;
 CREATE FUNCTION app_private.end_ie_flex_write_v1(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN;END $$;
 CREATE FUNCTION app_private.ie_actor_display_name_v1(uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'Operator' $$;
 CREATE FUNCTION app_private.append_income_expense_event_v1(uuid,uuid,text,uuid,text,text,text,text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN;END $$;
 CREATE FUNCTION public.cancel_unposted_income_expense_v2(uuid,bigint,bigint,text,text) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN UPDATE public.income_expenses SET approval_status='CANCELLED',review_version=review_version+1 WHERE id=$1 AND review_version=$2 AND approval_version=$3;RETURN jsonb_build_object('voucherId',$1);END $$;`);
 if(existsSync(migration))await db.exec(readFileSync(migration,'utf8'));
},30000);
afterAll(async()=>db.close());
async function fixture(){
 const contract=crypto.randomUUID();
 await db.query("INSERT INTO public.contracts(id,organization_id,room_id,start_date,end_date,discounts,status) VALUES($1,$2,$3,'2026-09-01','2027-09-01','{}','ACTIVE')",[contract,org,room]);
 const party=(await db.query<{r:{party_id:string}}>("SELECT public.register_rent_support_party_v1($1,$2,$3,'Operator','Verified internal manager',$4) r",[org,building,actor,crypto.randomUUID()])).rows[0].r.party_id;
 const plan={version:2,start_billing_month:'2026-09',payer:'SALE',sale_party_id:party,deduction_policy:'COMMISSION_ONLY',collection_mode:'UPFRONT_COMMITTED',segments:[{month_count:3,monthly_amount:'600000'}]};
 await db.query('SELECT app_private.persist_contract_rent_support_v1($1,$2,$3)',[org,contract,JSON.stringify(plan)]);
 const payload={version:2,intents:[{intent_id:crypto.randomUUID(),source_id:null,kind:'COMMISSION',party_id:party,gross_amount:'3000000',route:'CASHBOOK',manager_id:null,account_id:null,voucher_date:'2026-09-30',payer_name:null,recipient_name:null,recipient_bank:null,recipient_account:null,item_description:null,attachments:[]}]};
 const q=(await db.query<{r:{quote_hash:string}}>('SELECT public.quote_contract_rent_support_v1($1,$2,NULL,$3,NULL,$4) r',[org,contract,JSON.stringify(plan),JSON.stringify(payload)])).rows[0].r;
 const request=crypto.randomUUID();
 await db.query('SELECT public.prepare_contract_payouts_with_support_v1($1,$2,1,$3,$4,$5)',[org,contract,q.quote_hash,JSON.stringify(payload),request]);
 const r=(await db.query<{r:{status:string;sources:Array<{source_id:string;voucher_id:string}>}}>('SELECT public.create_contract_payouts_with_support_v1($1,$2,1,$3,$4,$5) r',[org,contract,q.quote_hash,JSON.stringify(payload),request])).rows[0].r;
 expect(r.status).toBe('COMPLETED');return {contract,...r.sources[0]};
}
async function facts(voucher:string){return(await db.query<{r:Record<string,unknown>}>('SELECT app_private.rent_support_salary_part_v1($1,$2,$3,$4) r',[org,voucher,'2026-09-01',actor])).rows[0].r;}
it('binds the one real net item to original gross/held without withholding twice',async()=>{
 const f=await fixture(),r=await facts(f.voucher_id);
 expect(r).toMatchObject({source_id:f.source_id,gross:'3000000',withheld:'1800000',net:'1200000',period_month:'2026-09-01'});expect(r.item_id).toEqual(expect.any(String));
});
it('refuses ambiguous parts instead of inventing equal or pro-rata allocation',async()=>{
 const f=await fixture();await db.query('INSERT INTO public.income_expense_items(income_expense_id,amount) VALUES($1,0)',[f.voucher_id]);
 await expect(facts(f.voucher_id)).rejects.toMatchObject({code:'PT409'});
});
it('refuses another manager without generating another economic source',async()=>{
 const f=await fixture();await expect(db.query('SELECT public.assign_commission_manager_v1($1,$2,1,$3)',[f.voucher_id,uuid(104),crypto.randomUUID()])).rejects.toMatchObject({code:'PT409'});
 expect((await db.query('SELECT count(*)::int n FROM app_private.rent_support_payout_sources WHERE contract_id=$1',[f.contract])).rows[0]).toEqual({n:1});
});
it('locks net once, rejects payment over cap and cannot unlock pending cash',async()=>{
 const f=await fixture();await db.query('SELECT public.assign_commission_manager_v1($1,$2,1,$3)',[f.voucher_id,actor,crypto.randomUUID()]);
 await expect(db.query('SELECT public.salary_payout_v1($1,$2,1,NULL,$3,NULL,$4)',[actor,'2026-09-01','2026-09-30',crypto.randomUUID()])).rejects.toMatchObject({code:'PT409'});
 await expect(db.query("INSERT INTO public.income_expenses(organization_id,salary_staff_id,type,approval_status,total_amount) VALUES($1,$2,'EXPENSE','UNAPPROVED',1200000)",[org,actor])).rejects.toMatchObject({code:'PT409'});
 const r=await facts(f.voucher_id),managers=[{staff_id:actor,commission_total:1200000,take_home:1200000,gross_total:1200000,base_salary:0,work_bonus:0,contract_bonus:0,investment_profit:0,adjustments_total:0,advances_total:0,room_rent:0,commission_voucher_ids:[f.voucher_id],support_parts:[{source_id:r.source_id,item_id:r.item_id,proof_hash:r.proof_hash}]}];
 await db.query('SELECT public.lock_salary_month_v2($1,$2,$3)',['2026-09-01',JSON.stringify(managers),crypto.randomUUID()]);
 await db.query('SELECT public.unlock_salary_month_v2($1,$2,$3)',['2026-09-01',[actor],crypto.randomUUID()]);
 await db.query('SELECT public.lock_salary_month_v2($1,$2,$3)',['2026-09-01',JSON.stringify(managers),crypto.randomUUID()]);
 expect((await db.query("SELECT count(*)::int n FROM app_private.rent_support_salary_part_events WHERE action='RELEASED'")).rows[0]).toEqual({n:1});
 await expect(db.query("UPDATE public.salary_monthly SET take_home=3000000 WHERE staff_id=$1 AND period_month='2026-09-01'",[actor])).rejects.toMatchObject({code:'PT409'});
 await expect(db.query("UPDATE public.salary_monthly SET status='DRAFT' WHERE staff_id=$1 AND period_month='2026-09-01'",[actor])).rejects.toMatchObject({code:'PT409'});
 await db.query("UPDATE public.income_expense_items SET description='changed proof' WHERE income_expense_id=$1",[f.voucher_id]);
 await expect(db.query('SELECT public.salary_payout_v1($1,$2,1,NULL,$3,NULL,$4)',[actor,'2026-09-01','2026-09-30',crypto.randomUUID()])).rejects.toMatchObject({code:'PT409'});
 await db.query('UPDATE public.income_expense_items SET description=NULL WHERE income_expense_id=$1',[f.voucher_id]);
 const key=crypto.randomUUID(),args=[actor,'2026-09-01',1200000,null,'2026-09-30',null,key];
 const first=await db.query<{r:{salary_voucher_id:string}}>('SELECT public.salary_payout_v1($1,$2,$3,$4,$5,$6,$7) r',args);
 expect(await db.query('SELECT public.salary_payout_v1($1,$2,$3,$4,$5,$6,$7) r',args)).toEqual(first);
 await expect(db.query('UPDATE public.income_expenses SET total_amount=3000000 WHERE id=$1',[first.rows[0].r.salary_voucher_id])).rejects.toMatchObject({code:'PT409'});
 await expect(db.query('SELECT public.salary_payout_v1($1,$2,$3,$4,$5,$6,$7)',[...args.slice(0,6),crypto.randomUUID()])).rejects.toMatchObject({code:'PT409'});
 await expect(db.query('SELECT public.unlock_salary_month_v2($1,$2,$3)',['2026-09-01',[actor],crypto.randomUUID()])).rejects.toMatchObject({code:'PT409'});
 expect((await db.query('SELECT sum(amount)::text amount FROM app_private.rent_support_withholding_events WHERE source_id=$1',[f.source_id])).rows[0]).toEqual({amount:'1800000'});
});

type Candidate={state:string;verification:{source_id:string;claim_id:string;deposit_voucher_id:string;bonus_voucher_id:string;item_ids:string[];approval_version:number;posting_version:number;proof_hash:string};candidate:unknown;issues:Array<{code:string}>};
async function depositFixture(total=300000,profile:string|null=actor,payer:'SALE'|'BUILDING'='SALE'){
 const contract=crypto.randomUUID(),deposit=crypto.randomUUID(),claim=crypto.randomUUID();
 await db.query("INSERT INTO public.contracts(id,organization_id,room_id,start_date,end_date,discounts,status) VALUES($1,$2,$3,'2026-09-01','2027-09-01','{}','ACTIVE')",[contract,org,room]);
 const bonus=(await db.query<{r:{id:string}}>("SELECT public.create_commission_voucher($1,'sale',500000,'2026-09-30') r",[contract])).rows[0].r.id;
 await db.query("UPDATE public.income_expenses SET contract_id=NULL WHERE id=$1",[bonus]);
 await db.query("INSERT INTO public.income_expenses(id,organization_id,contract_id,type,approval_status,total_amount) VALUES($1,$2,$3,'INCOME','APPROVED',1000000)",[deposit,org,contract]);
 await db.query('INSERT INTO app_private.sale_bonus_claims VALUES($1,$2,$3,NULL,$4,500000)',[claim,org,deposit,bonus]);
 const party=(await db.query<{r:{party_id:string}}>("SELECT public.register_rent_support_party_v1($1,$2,$3,'Operator','Verified person',$4) r",[org,building,profile,crypto.randomUUID()])).rows[0].r.party_id;
 const plan={version:2,start_billing_month:'2026-09',payer,sale_party_id:payer==='SALE'?party:null,deduction_policy:'BONUS_THEN_COMMISSION',collection_mode:'UPFRONT_COMMITTED',segments:[{month_count:1,monthly_amount:String(total)}]};
 await db.query('SELECT app_private.persist_contract_rent_support_v1($1,$2,$3)',[org,contract,JSON.stringify(plan)]);
 return {contract,deposit,claim,bonus,party,plan};
}
async function candidate(contract:string){return(await db.query<{r:Candidate}>('SELECT public.read_rent_support_deposit_candidate_v1($1,$2) r',[org,contract])).rows[0].r;}
it('requires explicit payee evidence and verifies identity without creating capacity or a voucher',async()=>{
 const f=await depositFixture(),c=await candidate(f.contract);
 expect(c.state).toBe('NEEDS_REVIEW');expect(c.issues).toContainEqual(expect.objectContaining({code:'PAYEE_UNVERIFIED'}));
 const args=[org,f.contract,f.claim,f.deposit,f.bonus,f.party,c.verification.approval_version,c.verification.posting_version,c.verification.proof_hash,'Xác nhận người hưởng thưởng theo chứng từ',crypto.randomUUID()];
 const first=await db.query('SELECT public.verify_rent_support_deposit_payee_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r',args);
 expect(await db.query('SELECT public.verify_rent_support_deposit_payee_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r',args)).toEqual(first);
 expect((await candidate(f.contract)).state).toBe('READY');
 expect((await db.query('SELECT count(*)::int n FROM app_private.rent_support_payout_sources WHERE contract_id=$1',[f.contract])).rows[0]).toEqual({n:0});
 expect((await db.query("SELECT count(*)::int n FROM public.income_expenses WHERE commission_kind='sale' AND id=$1",[f.bonus])).rows[0]).toEqual({n:1});
 await expect(db.query('SELECT public.verify_rent_support_deposit_payee_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[...args.slice(0,8),'stale-proof',...args.slice(9)])).rejects.toMatchObject({code:'PT409'});
});

async function verifiedDeposit(total=300000){
 const f=await depositFixture(total),c=await candidate(f.contract),x=c.verification;
 await db.query('SELECT public.verify_rent_support_deposit_payee_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[org,f.contract,f.claim,f.deposit,f.bonus,f.party,x.approval_version,x.posting_version,x.proof_hash,'Xác nhận người hưởng thưởng',crypto.randomUUID()]);
 const ready=await candidate(f.contract),template=(ready.candidate as {intent_template:Record<string,unknown>}).intent_template;
 return {...f,payload:{version:3,intents:[{...template,intent_id:crypto.randomUUID(),reason:'Tiếp nhận thưởng cọc chưa chi'}]}};
}
async function adopt(f:Awaited<ReturnType<typeof verifiedDeposit>>){
 const q=(await db.query<{r:{quote_hash:string;state:string}}>('SELECT public.quote_contract_rent_support_v1($1,$2,NULL,$3,NULL,$4) r',[org,f.contract,JSON.stringify(f.plan),JSON.stringify(f.payload)])).rows[0].r;
 expect(q.state).toBe('READY');
 const request=crypto.randomUUID();
 const op=(await db.query<{r:{operation_id:string}}>('SELECT public.prepare_contract_payouts_with_support_v1($1,$2,1,$3,$4,$5) r',[org,f.contract,q.quote_hash,JSON.stringify(f.payload),request])).rows[0].r.operation_id;
 const r=(await db.query<{r:{status:string;sources:Array<{net:string;withheld:string;voucher_id:string|null;status:string}>}}>('SELECT public.execute_contract_payout_operation_v1($1,$2) r',[org,op])).rows[0].r;
 return {r,op};
}
it('adopts a verified unpaid deposit bonus using the existing voucher, claim and exact gross',async()=>{
 const f=await verifiedDeposit(),{r,op}=await adopt(f);
 expect(r).toMatchObject({status:'COMPLETED',sources:[{net:'200000',withheld:'300000',voucher_id:f.bonus}]});
 expect((await db.query('SELECT total_amount::text amount,contract_id FROM public.income_expenses WHERE id=$1',[f.bonus])).rows[0]).toEqual({amount:'200000',contract_id:f.contract});
 expect((await db.query('SELECT amount::text amount FROM app_private.sale_bonus_claims WHERE id=$1',[f.claim])).rows[0]).toEqual({amount:'500000'});
 expect((await db.query<{r:unknown}>('SELECT public.execute_contract_payout_operation_v1($1,$2) r',[org,op])).rows[0].r).toEqual(r);
});
it('settles fully withheld deposit bonus without zero voucher and retains its history',async()=>{
 const f=await verifiedDeposit(500000),{r}=await adopt(f);
 expect(r).toMatchObject({status:'COMPLETED',sources:[{net:'0',withheld:'500000',voucher_id:null,status:'SETTLED_BY_SUPPORT'}]});
 expect((await db.query('SELECT approval_status,total_amount::text amount FROM public.income_expenses WHERE id=$1',[f.bonus])).rows[0]).toEqual({approval_status:'CANCELLED',amount:'500000'});
});

it('validates adoption version types rather than accepting null CAS',async()=>{
 const f=await verifiedDeposit();const payload={...f.payload,intents:[{...f.payload.intents[0],expected_approval_version:null}]};
 await expect(db.query('SELECT app_private.rent_support_payout_context_v1($1)',[JSON.stringify(payload)])).rejects.toMatchObject({code:'22023'});
});
it('reapplies the migration without renaming wrappers into delegates',async()=>{await db.exec(readFileSync(migration,'utf8'));expect((await candidate((await depositFixture()).contract)).state).toBe('NEEDS_REVIEW');});

it('paid deposit bonus has zero funding capacity and does not block eligible commission',async()=>{
 const f=await depositFixture(),account=crypto.randomUUID(),posting=crypto.randomUUID();
 await db.query('INSERT INTO public.accounts VALUES($1,$2,false,NULL,$3)',[account,org,actor]);
 await db.query("INSERT INTO public.income_expense_postings VALUES($1,$2,$3,'VOUCHER',$3,'POSTING',NULL,-500000,$4,'EXPENSE')",[posting,org,f.bonus,account]);
 await db.query('INSERT INTO public.income_expense_posting_lines VALUES($1,$2,$3,$4,-500000)',[crypto.randomUUID(),org,posting,account]);
 expect((await candidate(f.contract)).issues).toContainEqual(expect.objectContaining({code:'DEPOSIT_ALREADY_PAID'}));
 const payload={version:3,intents:[{action:'ISSUE_NEW',intent_id:crypto.randomUUID(),source_id:null,kind:'COMMISSION',party_id:f.party,gross_amount:'3000000',route:'CASHBOOK',manager_id:null,account_id:null,voucher_date:'2026-09-30',payer_name:null,recipient_name:null,recipient_bank:null,recipient_account:null,item_description:null,attachments:[]}]};
 const q=(await db.query<{r:{state:string;sources:Array<{kind:string;current_withheld:string}>}}>('SELECT public.quote_contract_rent_support_v1($1,$2,NULL,$3,NULL,$4) r',[org,f.contract,JSON.stringify(f.plan),JSON.stringify(payload)])).rows[0].r;
 expect(q.state).toBe('READY');expect(q.sources).toHaveLength(1);expect(q.sources[0]).toMatchObject({kind:'COMMISSION',current_withheld:'300000'});
});
it('checks current financial parent authorization on the salary reader',async()=>{
 const f=await fixture();await db.exec("SET test.deny='yes'");
 try {await expect(db.query('SELECT public.read_rent_support_salary_parts_v1($1,$2)',[[f.voucher_id],'2026-09-01'])).rejects.toMatchObject({code:'42501'});}finally{await db.exec("SET test.deny='no'");}
});

it('preserves the existing service-role entry grant without exposing private salary delegates',async()=>{
 expect((await db.query<{allowed:boolean}>("SELECT has_function_privilege('service_role','public.salary_payout_v1(uuid,date,numeric,uuid,date,text,text,uuid,numeric)','EXECUTE') allowed")).rows[0].allowed).toBe(true);
 expect((await db.query<{allowed:boolean}>("SELECT has_function_privilege('service_role','app_private.rent_support_salary_part_v1(uuid,uuid,date,uuid)','EXECUTE') allowed")).rows[0].allowed).toBe(false);
});


// Round1 regression: removing the building predicate must allow a forged external
// identity and fail these zero-side-effect assertions.
async function otherBuildingParty(){
 const b=crypto.randomUUID(),party=crypto.randomUUID();
 await db.query("INSERT INTO public.buildings(id,organization_id,status,is_virtual) VALUES($1,$2,'ACTIVE',false)",[b,org]);
 await db.query("INSERT INTO app_private.rent_support_parties(id,organization_id,building_id,kind,display_name,verified_reason,created_by) VALUES($1,$2,$3,'EXTERNAL','Other building recipient','Fixture verified in its own building',$4)",[party,org,b,actor]);
 return party;
}
async function verifyArgs(f:Awaited<ReturnType<typeof depositFixture>>,party=f.party){
 const x=(await candidate(f.contract)).verification;
 return [org,f.contract,f.claim,f.deposit,f.bonus,party,x.approval_version,x.posting_version,x.proof_hash,'Xác minh đúng nguồn thưởng cọc',crypto.randomUUID()];
}
const verifySql='SELECT public.verify_rent_support_deposit_payee_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) r';
async function moneyState(f:Awaited<ReturnType<typeof depositFixture>>){
 return (await db.query(
 "SELECT (SELECT count(*) FROM app_private.rent_support_deposit_payee_bindings) bindings,(SELECT count(*) FROM app_private.rent_support_payout_sources) sources,(SELECT count(*) FROM app_private.rent_support_payout_results) results,(SELECT count(*) FROM app_private.rent_support_withholding_events) held,(SELECT count(*) FROM app_private.rent_support_payout_executions) executions,(SELECT count(*) FROM public.contract_commission_events) events,(SELECT count(*) FROM app_private.rent_support_funding_operations) operations,(SELECT to_jsonb(v) FROM public.income_expenses v WHERE id=$1) voucher,(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM public.income_expense_items i WHERE income_expense_id=$1) items",[f.bonus])).rows[0];
}
it('rejects cross-building external payee verification without any source or money changes',async()=>{
 const f=await depositFixture(300000,actor,'BUILDING'),party=await otherBuildingParty(),args=await verifyArgs(f,party),before=await moneyState(f);
 await expect(db.query(verifySql,args)).rejects.toMatchObject({code:'42501'});
 expect(await moneyState(f)).toEqual(before);
});
it.each([null,actor])('keeps valid external/internal adoption and verification replay (%s)',async(profile)=>{
 const f=await depositFixture(300000,profile),args=await verifyArgs(f),first=await db.query(verifySql,args);
 expect(await db.query(verifySql,args)).toEqual(first);
 const ready=await candidate(f.contract);expect(ready.state).toBe('READY');
 const payload={version:3,intents:[{...(ready.candidate as {intent_template:Record<string,unknown>}).intent_template,intent_id:crypto.randomUUID(),reason:'Tiếp nhận thưởng cọc hợp lệ'}]};
 const {r,op}=await adopt({...f,payload});
 expect(r).toMatchObject({status:'COMPLETED',sources:[{net:'200000',withheld:'300000',voucher_id:f.bonus}]});
 expect((await db.query<{r:unknown}>('SELECT public.execute_contract_payout_operation_v1($1,$2) r',[org,op])).rows[0].r).toEqual(r);
});
async function oldCrossBuildingBinding(){
 const f=await depositFixture(300000,actor,'BUILDING'),party=await otherBuildingParty();
 const facts=(await db.query<{r:Record<string,unknown>}>('SELECT app_private.rent_support_deposit_facts_v1($1,$2) r',[org,f.contract])).rows[0].r;
 await db.query("INSERT INTO app_private.rent_support_deposit_payee_bindings(organization_id,contract_id,source_id,claim_id,deposit_voucher_id,bonus_voucher_id,party_id,approval_version,posting_version,proof_hash,actor_id,request_id,intent_hash,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'historical','Pre-fix out-of-scope identity')",
 [org,f.contract,facts.source_id,f.claim,f.deposit,f.bonus,party,facts.approval_version,facts.posting_version,facts.proof_hash,actor,crypto.randomUUID()]);
 const intent={action:'ADOPT_DEPOSIT_BONUS',intent_id:crypto.randomUUID(),source_id:facts.source_id,kind:'BONUS',party_id:party,gross_amount:facts.gross,route:'CASHBOOK',manager_id:null,account_id:facts.account_id,voucher_date:facts.voucher_date,payer_name:facts.payer_name,recipient_name:null,recipient_bank:facts.recipient_bank,recipient_account:facts.recipient_account,item_description:facts.item_description,attachments:facts.attachments,deposit_claim_id:f.claim,deposit_voucher_id:f.deposit,bonus_voucher_id:f.bonus,expected_approval_version:facts.approval_version,expected_posting_version:facts.posting_version,item_ids:facts.item_ids,source_facts_hash:facts.proof_hash,reason:'Tiếp nhận từ binding lịch sử'};
 return {...f,payload:{version:3,intents:[intent]},facts};
}
it('does not expose READY or fund an old out-of-scope external binding',async()=>{
 const f=await oldCrossBuildingBinding(),before=await moneyState(f);
 expect((await candidate(f.contract)).state).toBe('NEEDS_REVIEW');
 const q=(await db.query<{r:{quote_hash:string;state:string}}>('SELECT public.quote_contract_rent_support_v1($1,$2,NULL,$3,NULL,$4) r',[org,f.contract,JSON.stringify(f.plan),JSON.stringify(f.payload)])).rows[0].r;
 expect(q.state).toBe('NEEDS_REVIEW');
 await expect(db.query('SELECT public.prepare_contract_payouts_with_support_v1($1,$2,1,$3,$4,$5)',[org,f.contract,q.quote_hash,JSON.stringify(f.payload),crypto.randomUUID()])).rejects.toMatchObject({code:'PT409'});
 expect(await moneyState(f)).toEqual(before);
});
it('rejects a saved old out-of-scope adoption before money changes',async()=>{
 const f=await oldCrossBuildingBinding();let op:string;
 // Seed a request accepted by the pre-fix identity rule, with a real quote hash.
 // Restore the production helper before exercising the corrected writer.
 const saved=(await db.query<{definition:string}>("SELECT pg_get_functiondef('app_private.rent_support_party_in_building_v1(uuid,uuid,uuid)'::regprocedure) definition")).rows[0].definition;
 try{
 await db.exec("CREATE OR REPLACE FUNCTION app_private.rent_support_party_in_building_v1(p_org uuid,p_building uuid,p_party uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT app_private.rent_support_party_valid_v1(p_org,p_party) $$");
 const q=(await db.query<{r:{quote_hash:string;state:string}}>('SELECT public.quote_contract_rent_support_v1($1,$2,NULL,$3,NULL,$4) r',[org,f.contract,JSON.stringify(f.plan),JSON.stringify(f.payload)])).rows[0].r;
 expect(q.state).toBe('READY');
 op=(await db.query<{r:{operation_id:string}}>('SELECT public.prepare_contract_payouts_with_support_v1($1,$2,1,$3,$4,$5) r',[org,f.contract,q.quote_hash,JSON.stringify(f.payload),crypto.randomUUID()])).rows[0].r.operation_id;
 }finally{await db.exec(saved);}
 const before=await moneyState(f);
 await expect(db.query('SELECT public.execute_contract_payout_operation_v1($1,$2)',[org,op])).rejects.toMatchObject({code:'PT409'});
 expect(await moneyState(f)).toEqual(before);
 // The private canonical adoption boundary must also reject an old binding.
 await db.query("INSERT INTO app_private.rent_support_payout_sources(id,organization_id,contract_id,party_id,kind,gross_original,evidence,created_by) VALUES($1,$2,$3,$4,'BONUS',500000,$5,$6)",[f.facts.source_id,org,f.contract,f.payload.intents[0].party_id,JSON.stringify({operation_id:op}),actor]);
 const seeded=await moneyState(f);
 await expect(db.query('SELECT app_private.rent_support_adopt_deposit_v1($1,$2,$3,500000,$4)',[org,op,JSON.stringify(f.payload.intents[0]),JSON.stringify(f.facts)])).rejects.toMatchObject({code:'42501'});
 expect(await moneyState(f)).toEqual(seeded);
});
it('uses identical authoritative evidence checks in legacy and salary quote adapters',async()=>{
 const f=await fixture();
 const plan=(await db.query<{payload:unknown}>('SELECT payload FROM app_private.contract_rent_support_plans WHERE contract_id=$1',[f.contract])).rows[0].payload;
 const args=[org,f.contract,JSON.stringify(plan),JSON.stringify({version:1,intents:[]})];
 const quote=async(name:string)=>(await db.query<{r:{state:string;sources:Array<{gross_original:string;prior_withheld:string;remaining_payable:string}>;issues:Array<{code:string}>}}>('SELECT app_private.'+name+'($1,$2,NULL,$3,0,$4) r',args)).rows[0].r;
 const legacy=await quote('rent_support_source_quote_before_salary_v1'),bridge=await quote('rent_support_source_quote_salary_v1');
 expect(bridge).toEqual(legacy);expect(bridge).toMatchObject({state:'READY',sources:[{gross_original:'3000000',prior_withheld:'1800000',remaining_payable:'1200000'}]});
 await db.query('INSERT INTO app_private.salary_commission_inclusions VALUES($1,$2,$3,$4)',[f.voucher_id,org,actor,'2026-09-01']);
 for(const name of ['rent_support_source_quote_before_salary_v1','rent_support_source_quote_salary_v1']){
 const result=await quote(name);expect(result.state).toBe('NEEDS_REVIEW');expect(result.issues).toContainEqual(expect.objectContaining({code:'SOURCE_LOCKED'}));
 }
});

it('rejects out-of-scope ISSUE_NEW parties through both quote adapters',async()=>{
 const contract=crypto.randomUUID(),party=await otherBuildingParty();
 await db.query("INSERT INTO public.contracts(id,organization_id,room_id,start_date,end_date,discounts,status) VALUES($1,$2,$3,'2026-09-01','2027-09-01','{}','ACTIVE')",[contract,org,room]);
 const plan={version:2,start_billing_month:'2026-09',payer:'BUILDING',sale_party_id:null,deduction_policy:'BONUS_THEN_COMMISSION',collection_mode:'UPFRONT_COMMITTED',segments:[{month_count:1,monthly_amount:'300000'}]};
 const intent={intent_id:crypto.randomUUID(),source_id:null,kind:'COMMISSION',party_id:party,gross_amount:'3000000',route:'CASHBOOK',manager_id:null,account_id:null,voucher_date:'2026-09-30',payer_name:null,recipient_name:null,recipient_bank:null,recipient_account:null,item_description:null,attachments:[]};
 for(const name of ['rent_support_source_quote_before_salary_v1','rent_support_source_quote_salary_v1']){
 const result=(await db.query<{r:{state:string;sources:unknown[];issues:Array<{code:string}>}}>('SELECT app_private.'+name+'($1,$2,NULL,$3,300000,$4) r',[org,contract,JSON.stringify(plan),JSON.stringify({version:2,intents:[intent]})])).rows[0].r;
 expect(result).toMatchObject({state:'NEEDS_REVIEW',sources:[]});expect(result.issues).toContainEqual(expect.objectContaining({code:'PARTY_UNVERIFIED'}));
 }
});
it('enforces financial reader denial in both quote adapters without disclosing cash facts',async()=>{
 const f=await fixture(),plan=(await db.query<{payload:unknown}>('SELECT payload FROM app_private.contract_rent_support_plans WHERE contract_id=$1',[f.contract])).rows[0].payload;
 // Keep subject/org authority unchanged; only the parent voucher reader is denied.
 await db.exec("CREATE OR REPLACE FUNCTION app_private.ie_supplement_can_read_v1(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$");
 try {
 for(const name of ['rent_support_source_quote_before_salary_v1','rent_support_source_quote_salary_v1']){
 const result=(await db.query<{r:{state:string;sources:unknown[];issues:Array<{code:string}>}}>('SELECT app_private.'+name+'($1,$2,NULL,$3,0,$4) r',[org,f.contract,JSON.stringify(plan),JSON.stringify({version:1,intents:[]})])).rows[0].r;
 expect(result).toMatchObject({state:'NEEDS_REVIEW',sources:[]});expect(result.issues).toContainEqual(expect.objectContaining({code:'SOURCE_NOT_READABLE'}));
 }
 }finally{await db.exec("CREATE OR REPLACE FUNCTION app_private.ie_supplement_can_read_v1(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.deny',true) IS DISTINCT FROM 'yes' $$");}
});

it('preserves legacy payroll review while the salary adapter accepts the exact manager route',async()=>{
 const f=await depositFixture(),contract=crypto.randomUUID();
 await db.query("INSERT INTO public.contracts(id,organization_id,room_id,start_date,end_date,discounts,status) VALUES($1,$2,$3,'2026-09-01','2027-09-01','{}','ACTIVE')",[contract,org,room]);
 const payload={version:2,intents:[{intent_id:crypto.randomUUID(),source_id:null,kind:'COMMISSION',party_id:f.party,gross_amount:'3000000',route:'MANAGER_PAYROLL',manager_id:actor,account_id:null,voucher_date:'2026-10-30',payer_name:null,recipient_name:null,recipient_bank:null,recipient_account:null,item_description:null,attachments:[]}]};
 const args=[org,contract,JSON.stringify({...f.plan,deduction_policy:'COMMISSION_ONLY'}),JSON.stringify(payload)];
 const legacy=(await db.query<{r:{state:string;issues:Array<{code:string}>}}>('SELECT app_private.rent_support_source_quote_before_salary_v1($1,$2,NULL,$3,1800000,$4) r',args)).rows[0].r;
 expect(legacy.state).toBe('NEEDS_REVIEW');expect(legacy.issues).toContainEqual(expect.objectContaining({code:'PAYROLL_BRIDGE_PENDING'}));
 const bridge=(await db.query<{r:unknown}>('SELECT app_private.rent_support_source_quote_salary_v1($1,$2,NULL,$3,1800000,$4) r',args)).rows[0].r;
 expect(bridge).toMatchObject({state:'READY',sources:[{current_withheld:'1800000',net_this_operation:'1200000',route:'MANAGER_PAYROLL'}]});
});
