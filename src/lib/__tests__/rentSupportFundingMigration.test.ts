import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { boChuThichSql } from '../../../scripts/lib/bo-chu-thich.mjs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, expect, it } from 'vitest';
const db = new PGlite();
// Historical registry bootstrap supplies dependencies; the funding provider under
// test always comes from the last CREATE in the complete migration corpus.
function liveDefinitionOf(name: string, corpus?: Array<{file: string; sql: string}>): string {
 const directory = join(process.cwd(), 'supabase', 'migrations');
 const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${escaped}\\s*\\([\\s\\S]*?\\bAS\\s+(\\$[a-zA-Z0-9_]*\\$)[\\s\\S]*?\\1\\s*;`, 'gi');
 let definition: string | undefined;
 const migrations = corpus ?? readdirSync(directory).filter(file => file.endsWith('.sql'))
  .map(file => ({file,sql:readFileSync(join(directory,file),'utf8')}));
 for (const migration of [...migrations].sort((a,b)=>a.file.localeCompare(b.file))) {
  const sql = boChuThichSql(migration.sql);
  for (const match of sql.matchAll(pattern)) definition = match[0];
 }
 if (!definition) throw new Error(`Missing live definition: ${name}`);
 return definition;
}
const liveFundingProvider = liveDefinitionOf('app_private.rent_support_source_funding_evidence_v1');
const party = '00000000-0000-4000-8000-000000000001';
const source = (kind: 'COMMISSION' | 'BONUS', gross: string, extras = {}) => ({
 source_id: kind === 'COMMISSION' ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000003',
 kind, party_id: party, gross_original: gross, already_paid: '0', prior_withheld: '0', reserved: '0',
 route: 'CASHBOOK', verified: true, locked: false, ...extras,
});
async function allocate(payer: string, policy: string, sources: unknown[], total = '1800000', committed = '0') {
 return (await db.query<{ result: any }>('SELECT app_private.rent_support_allocate_funding_v1($1,$2,$3,$4,$5,$6) result',
  [payer, party, policy, total, committed, JSON.stringify(sources)])).rows[0].result;
}
beforeAll(async () => {
 await db.exec('CREATE SCHEMA app_private; CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;');
 const path = 'supabase/migrations/20260930085304_rent_support_payout_sources.sql';
 await db.exec(readFileSync(path, 'utf8').split('-- Registry and canonical providers')[0]);
});
afterAll(async () => db.close());
it('live definition loader ignores fake CREATE comments and preserves SQL literals containing --',async()=>{
 const sql=liveDefinitionOf('app_private.funding_loader_probe',[
  {file:'20260930000003_comment.sql',sql:`
   /* CREATE OR REPLACE FUNCTION app_private.funding_loader_probe() RETURNS text LANGUAGE sql AS $$ SELECT 'block fake'::text $$; */
   -- CREATE OR REPLACE FUNCTION app_private.funding_loader_probe() RETURNS text LANGUAGE sql AS $$ SELECT 'line fake'::text $$;
  `},
  {file:'20260930000002_current.sql',sql:`CREATE OR REPLACE FUNCTION app_private.funding_loader_probe() RETURNS text LANGUAGE sql AS $body$ SELECT 'current--literal'::text $body$;`},
  {file:'20260930000001_old.sql',sql:`CREATE OR REPLACE FUNCTION app_private.funding_loader_probe() RETURNS text LANGUAGE sql AS $$ SELECT 'old'::text $$;`},
 ]);
 await db.exec(sql);
 expect((await db.query<{result:string}>('SELECT app_private.funding_loader_probe() result')).rows[0].result).toBe('current--literal');
 expect(()=>liveDefinitionOf('app_private.funding_loader_missing',[{file:'comment.sql',sql:`/* CREATE FUNCTION app_private.funding_loader_missing() RETURNS text AS $$ SELECT 'fake' $$ LANGUAGE sql; */`}])).toThrow('Missing live definition');
});
it.each([
 ['BUILDING','COMMISSION_ONLY','3000000','500000','READY','0','0','3000000','500000','0'],
 ['SALE','COMMISSION_ONLY','3000000','500000','READY','1800000','0','1200000','500000','0'],
 ['SALE','BONUS_THEN_COMMISSION','3000000','500000','READY','1300000','500000','1700000','0','0'],
 ['SALE','COMMISSION_ONLY','1500000','500000','NEEDS_REVIEW','0','0','1500000','500000','300000'],
 ['SALE','BONUS_THEN_COMMISSION','1000000','500000','NEEDS_REVIEW','0','0','1000000','500000','300000'],
])('allocates %s %s with %s commission and %s bonus atomically',async(payer,policy,commission,bonus,state,cHold,bHold,cNet,bNet,shortfall)=>{
 const result=await allocate(payer,policy,[source('COMMISSION',commission),source('BONUS',bonus)]);
 expect(result.state).toBe(state);expect(result.unallocated).toBe(shortfall);
 expect(result.sources.find((s: any)=>s.kind==='COMMISSION')).toMatchObject({current_withheld:cHold,net_this_operation:cNet});
 expect(result.sources.find((s: any)=>s.kind==='BONUS')).toMatchObject({current_withheld:bHold,net_this_operation:bNet});
});
it('excludes cash already paid and previous withholding from both capacity and net',async()=>{
 const rows=[source('COMMISSION','3000000',{already_paid:'700000',prior_withheld:'300000'})];
 const result=await allocate('SALE','COMMISSION_ONLY',rows,'800000','300000');
 expect(result).toMatchObject({state:'READY',due_upfront:'500000',sources:[{remaining_payable:'2000000',current_withheld:'500000',net_this_operation:'1500000'}]});
 expect(await allocate('SALE','COMMISSION_ONLY',rows,'800000','300000')).toEqual(result);
});
it('paid deposit bonus contributes no capacity and falls through to commission',async()=>{
 const result=await allocate('SALE','BONUS_THEN_COMMISSION',[source('COMMISSION','3000000'),source('BONUS','500000',{already_paid:'500000'})]);
 expect(result.sources.find((s:any)=>s.kind==='BONUS')).toMatchObject({available_to_withhold:'0',current_withheld:'0'});
 expect(result.sources.find((s:any)=>s.kind==='COMMISSION')).toMatchObject({current_withheld:'1800000'});
});
it.each([
 [{party_id:'00000000-0000-4000-8000-000000000099'},'PAYEE_MISMATCH','NEEDS_REVIEW'],
 [{locked:true},'SOURCE_LOCKED','NEEDS_REVIEW'],
 [{reserved:'1'},'SOURCE_RESERVED','NEEDS_REVIEW'],
 [{verified:false},'LEGACY_REVIEW','LEGACY_REVIEW'],
])('blocks unsafe source %j',async(extras,code,state)=>{
 const result=await allocate('SALE','COMMISSION_ONLY',[source('COMMISSION','3000000',extras)]);
 expect(result.state).toBe(state);expect(result.issues.map((x:any)=>x.code)).toContain(code);
 expect(result.sources[0].current_withheld).toBe('0');
});
it('never credits prior funding from a reduced commitment',async()=>{
 const result=await allocate('SALE','COMMISSION_ONLY',[source('COMMISSION','3000000')],'100000','300000');
 expect(result.state).toBe('NEEDS_REVIEW');expect(result.issues.map((x:any)=>x.code)).toContain('FUNDING_REVERSAL_REVIEW');
});
it('rejects duplicate source identities so aliases cannot multiply entitlement',async()=>{
 await expect(allocate('SALE','COMMISSION_ONLY',[source('COMMISSION','3000000'),source('COMMISSION','3000000')])).rejects.toMatchObject({code:'22023'});
});

const registry = new PGlite();
const org='00000000-0000-4000-8000-000000000010',building='00000000-0000-4000-8000-000000000011',contract='00000000-0000-4000-8000-000000000012';
beforeAll(async()=>{
 await registry.exec(`CREATE SCHEMA app_private;CREATE SCHEMA auth;CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${party}'::uuid $$;
 CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
 CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT '{}'::uuid[] $$;
 CREATE FUNCTION app_private.rent_support_scope_v1(uuid,uuid,text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1='${org}'::uuid AND $2='${building}'::uuid AND current_setting('test.deny',true) IS DISTINCT FROM 'yes' $$;
 CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN;END $$;
 CREATE FUNCTION app_private.rent_support_immutable_v1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable' USING ERRCODE='42501';END $$;
 CREATE TABLE public.organizations(id uuid PRIMARY KEY);INSERT INTO public.organizations VALUES('${org}');
 CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,is_virtual boolean,status text,deleted_at timestamptz);
 INSERT INTO public.buildings VALUES('${building}','${org}',false,'ACTIVE',NULL);
 CREATE TABLE public.profiles(id uuid PRIMARY KEY,full_name text,is_active boolean);INSERT INTO public.profiles VALUES('${party}','Internal person',true);
 CREATE TABLE public.organization_memberships(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,status text,valid_from timestamptz,valid_to timestamptz,revoked_at timestamptz);
 INSERT INTO public.organization_memberships VALUES(gen_random_uuid(),'${party}','${org}','ACTIVE',now()-interval '1 day',NULL,NULL);
 CREATE TABLE public.contracts(id uuid PRIMARY KEY,organization_id uuid,status text,deleted_at timestamptz);INSERT INTO public.contracts VALUES('${contract}','${org}','ACTIVE',NULL);
 CREATE TABLE public.income_expenses(id uuid PRIMARY KEY,organization_id uuid,contract_id uuid,commission_kind text,type text,deleted_at timestamptz,approval_status text);
 CREATE TABLE public.accounts(id uuid PRIMARY KEY,organization_id uuid,is_virtual boolean,deleted_at timestamptz);
 CREATE TABLE public.income_expense_postings(id uuid PRIMARY KEY,organization_id uuid,voucher_id uuid,posting_subject_kind text,posting_subject_id uuid,event_kind text,reversal_of_id uuid,net_cash_effect numeric,account_id uuid,direction text);
 CREATE TABLE public.income_expense_posting_lines(id uuid PRIMARY KEY,organization_id uuid,posting_id uuid,account_id uuid,signed_amount numeric);
 CREATE TABLE app_private.sale_bonus_claims(id uuid PRIMARY KEY,organization_id uuid,deposit_voucher_id uuid,contract_id uuid,bonus_voucher_id uuid,amount numeric);
 CREATE TABLE app_private.commission_manager_links(voucher_id uuid PRIMARY KEY,organization_id uuid,manager_id uuid);
 CREATE TABLE app_private.salary_commission_inclusions(voucher_id uuid,organization_id uuid,staff_id uuid,period_month date);
 ALTER TABLE public.accounts ADD COLUMN user_id uuid;
 ALTER TABLE public.income_expenses ADD COLUMN account_id uuid;
 ALTER TABLE public.income_expenses ADD COLUMN voucher_date date;
 CREATE TABLE public.manager_salary_config(organization_id uuid,staff_id uuid,is_active boolean);
 CREATE TABLE public.salary_monthly(organization_id uuid,staff_id uuid,period_month date,status text);
 CREATE TABLE public.salary_earning_consumptions(organization_id uuid,source_id uuid,consumption_state text);
 CREATE TABLE public.cashbook_possession_bindings(organization_id uuid,cashbook_id uuid,membership_id uuid,valid_to timestamptz,possession_kind text);
 CREATE FUNCTION app_private.rent_support_subject_v1(uuid,uuid,uuid,boolean) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${building}'::uuid $$;
 CREATE FUNCTION app_private.ie_supplement_can_read_v1(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.hidden',true) IS DISTINCT FROM 'yes' $$;
 CREATE FUNCTION app_private.finance_v2_is_cashbook_period_open(uuid,uuid,date) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('test.locked',true) IS DISTINCT FROM 'yes' $$;
 `);
 const path='supabase/migrations/20260930085304_rent_support_payout_sources.sql';
 await registry.exec(readFileSync(path,'utf8').split('-- Public quote integration')[0]);
 // Only storage columns read by the live provider are needed here. Full storage
 // constraints and money writers are covered by rentSupportPayoutMigration.
 await registry.exec(`
 CREATE TABLE app_private.rent_support_funding_operations(id uuid PRIMARY KEY,organization_id uuid,state text);
 CREATE TABLE app_private.rent_support_payout_results(organization_id uuid,operation_id uuid,source_id uuid,gross numeric,withheld numeric,net numeric,voucher_id uuid,status text);
 CREATE TABLE app_private.rent_support_withholding_events(organization_id uuid,operation_id uuid,source_id uuid,action text,amount numeric);
 `);
 await registry.exec(liveFundingProvider);
},30000);
afterAll(async()=>registry.close());
async function fundingReceipt(sourceId: string, gross: number, withheld: number, operation: string) {
 await registry.query(`INSERT INTO app_private.rent_support_funding_operations VALUES($1,$2,'COMPLETED')`,[operation,org]);
 await registry.query(`INSERT INTO app_private.rent_support_payout_results VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[org,operation,sourceId,gross,withheld,gross-withheld,withheld===gross?null:crypto.randomUUID(),withheld===gross?'SETTLED_BY_SUPPORT':'COMPLETED']);
 return operation;
}
async function fundedSource(gross: number, withheld: number, kind='COMMISSION', wrongEvidence=false) {
 const person=await register(party),sid=crypto.randomUUID(),c=crypto.randomUUID(),operation=crypto.randomUUID();
 await registry.query(`INSERT INTO public.contracts VALUES($1,$2,'ACTIVE',NULL)`,[c,org]);
 await registry.query(`INSERT INTO app_private.rent_support_payout_sources(id,organization_id,contract_id,party_id,kind,gross_original,evidence,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[sid,org,c,person.party_id,kind,gross,JSON.stringify({operation_id:wrongEvidence?crypto.randomUUID():operation}),party]);
 await fundingReceipt(sid,gross,withheld,operation);
 return {sid,operation};
}
async function fundingEvidence(sourceId: string, organization=org) {
 return (await registry.query<{result:any}>('SELECT app_private.rent_support_source_funding_evidence_v1($1,$2) result',[organization,sourceId])).rows[0].result;
}
async function register(profile:string|null,requestId=crypto.randomUUID(),label='External broker'){
 return (await registry.query<{result:any}>('SELECT public.register_rent_support_party_v1($1,$2,$3,$4,$5,$6) result',[org,building,profile,label,'Explicit identity verification',requestId])).rows[0].result;
}
it('registers internal current membership and replays exact external request',async()=>{
 const internal=await register(party);expect(internal.kind).toBe('INTERNAL');expect(internal.profile_id).toBe(party);
 const key=crypto.randomUUID();const external=await register(null,key);expect(external.kind).toBe('EXTERNAL');expect(await register(null,key)).toEqual(external);
 await expect(register(null,key,'Changed')).rejects.toMatchObject({code:'PT409'});
});
it('rejects profile without current membership and missing finance scope',async()=>{
 await registry.exec(`UPDATE public.organization_memberships SET valid_to=now()-interval '1 second'`);
 await expect(register(party)).rejects.toMatchObject({code:'42501'});
 await registry.exec(`UPDATE public.organization_memberships SET valid_to=NULL;SELECT set_config('test.deny','yes',false)`);
 try{await expect(register(null)).rejects.toMatchObject({code:'42501'});}finally{await registry.exec(`SELECT set_config('test.deny','',false)`);}
});
it('unique typed aliases preserve one source through deposit, contract and manager salary',async()=>{
 const person=await register(party),sid=crypto.randomUUID(),other=crypto.randomUUID(),voucher=crypto.randomUUID(),deposit=crypto.randomUUID(),claim=crypto.randomUUID();
 await registry.query(`INSERT INTO app_private.rent_support_payout_sources(id,organization_id,contract_id,party_id,kind,gross_original,evidence,created_by)
 VALUES($1,$2,$3,$4,'BONUS',500000,'{"kind":"CANONICAL_INTENT"}',$5)`,[sid,org,contract,person.party_id,party]);
 await registry.query(`INSERT INTO public.income_expenses(id,organization_id,contract_id,commission_kind,type,deleted_at,approval_status) VALUES($1,$2,NULL,'sale','EXPENSE',NULL,'UNAPPROVED'),($3,$2,$4,NULL,'INCOME',NULL,'APPROVED')`,[voucher,org,deposit,contract]);
 await registry.query(`INSERT INTO app_private.sale_bonus_claims VALUES($1,$2,$3,NULL,$4,500000)`,[claim,org,deposit,voucher]);
 await registry.query(`INSERT INTO app_private.commission_manager_links VALUES($1,$2,$3)`,[voucher,org,party]);
 await registry.query(`INSERT INTO app_private.salary_commission_inclusions VALUES($1,$2,$3,'2026-09-01')`,[voucher,org,party]);
 for(const [kind,id,period] of [['CONTRACT_BONUS',contract,''],['VOUCHER',voucher,''],['DEPOSIT_BONUS_CLAIM',claim,''],['MANAGER_COMMISSION',voucher,''],['SALARY_INCLUSION',voucher,'2026-09']]){
  await registry.query('SELECT app_private.rent_support_link_source_alias_v1($1,$2,$3,$4,$5)',[org,sid,kind,id,period]);
 }
 expect((await registry.query('SELECT count(DISTINCT source_id)::int count FROM app_private.rent_support_source_aliases')).rows[0]).toEqual({count:1});
 await registry.query(`INSERT INTO app_private.rent_support_payout_sources(id,organization_id,contract_id,party_id,kind,gross_original,evidence,created_by) VALUES($1,$2,$3,$4,'COMMISSION',3000000,'{"kind":"CANONICAL_INTENT"}',$5)`,[other,org,contract,person.party_id,party]);
 await expect(registry.query(`INSERT INTO app_private.rent_support_source_aliases(organization_id,source_id,alias_kind,alias_id,period_key,created_by) VALUES($1,$2,'VOUCHER',$3,'',$4)`,[org,other,voucher,party])).rejects.toMatchObject({code:'23505'});
 await expect(registry.query(`UPDATE app_private.rent_support_source_aliases SET source_id=$1 WHERE alias_kind='VOUCHER'`,[other])).rejects.toMatchObject({code:'42501'});
});

it('reads actual cash posting lines, ignores reversed payments, and never treats approval as cash',async()=>{
 const voucher=crypto.randomUUID(),account=crypto.randomUUID(),posted=crypto.randomUUID(),reversed=crypto.randomUUID();
 await registry.query(`INSERT INTO public.accounts(id,organization_id,is_virtual,deleted_at) VALUES($1,$2,false,NULL)`,[account,org]);
 await registry.query(`INSERT INTO public.income_expenses(id,organization_id,contract_id,commission_kind,type,deleted_at,approval_status) VALUES($1,$2,$3,'broker','EXPENSE',NULL,'APPROVED')`,[voucher,org,contract]);
 const paid=async()=> (await registry.query<{result:any}>('SELECT app_private.rent_support_voucher_cash_v1($1,$2) result',[org,voucher])).rows[0].result;
 expect(await paid()).toMatchObject({verified:true,already_paid:'0'});
 await registry.query(`INSERT INTO public.income_expense_postings VALUES($1,$2,$3,'VOUCHER',$3,'POSTING',NULL,-700000,$4,'EXPENSE')`,[posted,org,voucher,account]);
 await registry.query(`INSERT INTO public.income_expense_posting_lines VALUES($1,$2,$3,$4,-700000)`,[crypto.randomUUID(),org,posted,account]);
 expect(await paid()).toMatchObject({verified:true,already_paid:'700000'});
 await registry.query(`INSERT INTO public.income_expense_postings VALUES($1,$2,$3,'VOUCHER',$3,'REVERSAL',$4,700000,$5,'EXPENSE')`,[reversed,org,voucher,posted,account]);
 expect(await paid()).toMatchObject({verified:true,already_paid:'0'});
});
it('does not count virtual or mismatched posting line evidence as verified cash',async()=>{
 const voucher=crypto.randomUUID(),account=crypto.randomUUID(),posted=crypto.randomUUID();
 await registry.query(`INSERT INTO public.accounts(id,organization_id,is_virtual,deleted_at) VALUES($1,$2,true,NULL)`,[account,org]);
 await registry.query(`INSERT INTO public.income_expenses(id,organization_id,contract_id,commission_kind,type,deleted_at,approval_status) VALUES($1,$2,$3,'broker','EXPENSE',NULL,'APPROVED')`,[voucher,org,contract]);
 await registry.query(`INSERT INTO public.income_expense_postings VALUES($1,$2,$3,'VOUCHER',$3,'POSTING',NULL,-500000,$4,'EXPENSE')`,[posted,org,voucher,account]);
 await registry.query(`INSERT INTO public.income_expense_posting_lines VALUES($1,$2,$3,$4,-400000)`,[crypto.randomUUID(),org,posted,account]);
 const cash=(await registry.query<{result:any}>('SELECT app_private.rent_support_voucher_cash_v1($1,$2) result',[org,voucher])).rows[0].result;
 expect(cash.verified).toBe(false);expect(cash).not.toHaveProperty('already_paid');
});
it('quotes signed proposals without creating entitlements and UUID retries retain source identity',async()=>{
 const c=crypto.randomUUID(),person=await register(party);await registry.query(`INSERT INTO public.contracts VALUES($1,$2,'ACTIVE',NULL)`,[c,org]);
 const intent={intent_id:crypto.randomUUID(),kind:'COMMISSION',party_id:person.party_id,gross_amount:'3000000',route:'CASHBOOK',manager_id:null,account_id:null,voucher_date:'2026-09-30'};
 const plan={payer:'SALE',sale_party_id:person.party_id,deduction_policy:'COMMISSION_ONLY'};
 const quote=async(next=intent)=> (await registry.query<{result:any}>('SELECT app_private.rent_support_source_quote_v1($1,$2,NULL,$3,1800000,$4) result',[org,c,JSON.stringify(plan),JSON.stringify({version:1,intents:[next]})])).rows[0].result;
 const first=await quote();expect(first).toMatchObject({state:'READY',sources:[{origin:'PROPOSED',gross_original:'3000000',current_withheld:'1800000',net_this_operation:'1200000'}]});
 const changed=await quote({...intent,intent_id:crypto.randomUUID()});expect(changed.sources[0].source_id).toBe(first.sources[0].source_id);expect(changed.facts_hash).not.toBe(first.facts_hash);
 expect((await registry.query('SELECT count(*)::int count FROM app_private.rent_support_payout_sources WHERE contract_id=$1',[c])).rows[0]).toEqual({count:0});
 await registry.query(`UPDATE public.contracts SET status='DRAFT' WHERE id=$1`,[c]);expect((await quote()).issues.map((x:any)=>x.code)).toContain('UNSIGNED_ENTITLEMENT');
});
it('existing free-name voucher cannot be replaced by a new gross proposal',async()=>{
 const c=crypto.randomUUID(),person=await register(party),voucher=crypto.randomUUID();await registry.query(`INSERT INTO public.contracts VALUES($1,$2,'ACTIVE',NULL)`,[c,org]);
 await registry.query(`INSERT INTO public.income_expenses(id,organization_id,contract_id,commission_kind,type,deleted_at,approval_status) VALUES($1,$2,$3,'broker','EXPENSE',NULL,'UNAPPROVED')`,[voucher,org,c]);
 const plan={payer:'SALE',sale_party_id:person.party_id,deduction_policy:'COMMISSION_ONLY'},intent={intent_id:crypto.randomUUID(),kind:'COMMISSION',party_id:person.party_id,gross_amount:'3000000',route:'CASHBOOK',manager_id:null,account_id:null,voucher_date:'2026-09-30'};
 const quote=(await registry.query<{result:any}>('SELECT app_private.rent_support_source_quote_v1($1,$2,NULL,$3,1800000,$4) result',[org,c,JSON.stringify(plan),JSON.stringify({version:1,intents:[intent]})])).rows[0].result;
 expect(quote).toMatchObject({state:'LEGACY_REVIEW',sources:[]});
});
it('rejects null kind and non-string nullable identities at the payout boundary',async()=>{
 const intent={intent_id:crypto.randomUUID(),kind:null,party_id:party,gross_amount:'3000000',route:'CASHBOOK',manager_id:null,account_id:null,voucher_date:'2026-09-30'};
 await expect(registry.query('SELECT app_private.rent_support_payout_context_v1($1)',[JSON.stringify({version:1,intents:[intent]})])).rejects.toMatchObject({code:'22023'});
});
it('keeps manager salary inclusion on the same source and unavailable without prorating salary cash',async()=>{
  const person=await register(party),c=crypto.randomUUID(),voucher=crypto.randomUUID(),operation=crypto.randomUUID(),row={id:crypto.randomUUID(),party_id:person.party_id};
  await registry.query(`INSERT INTO public.contracts VALUES($1,$2,'ACTIVE',NULL)`,[c,org]);
  await registry.query(`INSERT INTO app_private.rent_support_payout_sources(id,organization_id,contract_id,party_id,kind,gross_original,evidence,created_by) VALUES($1,$2,$3,$4,'BONUS',500000,$6,$5)`,[row.id,org,c,person.party_id,party,JSON.stringify({operation_id:operation})]);
  await fundingReceipt(row.id,500000,0,operation);
  await registry.query(`INSERT INTO public.income_expenses(id,organization_id,contract_id,commission_kind,type,deleted_at,approval_status) VALUES($1,$2,$3,'sale','EXPENSE',NULL,'UNAPPROVED')`,[voucher,org,c]);
  await registry.query(`INSERT INTO app_private.commission_manager_links VALUES($1,$2,$3)`,[voucher,org,party]);
  await registry.query(`INSERT INTO app_private.salary_commission_inclusions VALUES($1,$2,$3,'2026-09-01')`,[voucher,org,party]);
  await registry.query(`SELECT app_private.rent_support_link_source_alias_v1($1,$2,'VOUCHER',$3,'')`,[org,row.id,voucher]);
  const plan={payer:'SALE',sale_party_id:row.party_id,deduction_policy:'BONUS_THEN_COMMISSION'};
  const quote=(await registry.query<{result:any}>('SELECT app_private.rent_support_source_quote_v1($1,$2,NULL,$3,300000,NULL) result',[org,c,JSON.stringify(plan)])).rows[0].result;
  expect(quote.state).toBe('NEEDS_REVIEW');expect(quote.issues.map((x:any)=>x.code)).toContain('SOURCE_LOCKED');
  expect(quote.sources.find((x:any)=>x.source_id===row.id)).toMatchObject({route:'MANAGER_PAYROLL',available_to_withhold:'0',current_withheld:'0'});
});
it('live funding evidence reconciles committed/reversed and reserved/released ledger amounts',async()=>{
 const {sid,operation}=await fundedSource(3000000,300000);
 for(const [action,amount] of [['RESERVED',900000],['COMMITTED',500000],['REVERSED',200000],['RELEASED',100000]]){
  await registry.query('INSERT INTO app_private.rent_support_withholding_events VALUES($1,$2,$3,$4,$5)',[org,operation,sid,action,amount]);
 }
 expect(await fundingEvidence(sid)).toMatchObject({verified:true,prior_withheld:'300000',reserved:'300000',settled_by_support:false,operation_id:operation,facts_hash:expect.any(String)});
 expect(await fundingEvidence(sid,crypto.randomUUID())).toEqual({verified:false});
});
it.each(['incomplete operation','wrong source operation','gross mismatch','missing committed event','negative withholding','above gross withholding'])('live funding evidence denies %s',async(fault)=>{
 const {sid,operation}=await fundedSource(3000000,300000,'COMMISSION',fault==='wrong source operation');
 await registry.query(`INSERT INTO app_private.rent_support_withholding_events VALUES($1,$2,$3,'COMMITTED',300000)`,[org,operation,sid]);
 if(fault==='incomplete operation') await registry.query(`UPDATE app_private.rent_support_funding_operations SET state='READY' WHERE id=$1`,[operation]);
 if(fault==='gross mismatch') await registry.query(`UPDATE app_private.rent_support_payout_results SET gross=3000001 WHERE source_id=$1`,[sid]);
 if(fault==='missing committed event') await registry.query(`DELETE FROM app_private.rent_support_withholding_events WHERE source_id=$1`,[sid]);
 if(fault==='negative withholding' || fault==='above gross withholding') {
  const held=fault==='negative withholding'?-1:3000001;
  await registry.query(`DELETE FROM app_private.rent_support_withholding_events WHERE source_id=$1`,[sid]);
  await registry.query(`UPDATE app_private.rent_support_payout_results SET withheld=$2 WHERE source_id=$1`,[sid,held]);
  await registry.query(`INSERT INTO app_private.rent_support_withholding_events VALUES($1,$2,$3,$4,$5)`,[org,operation,sid,held<0?'REVERSED':'COMMITTED',Math.abs(held)]);
 }
 expect(await fundingEvidence(sid)).toEqual({verified:false});
});
it('live funding evidence keeps full support settlement cashless and clamps released reservations',async()=>{
 const {sid,operation}=await fundedSource(500000,500000,'BONUS');
 await registry.query(`INSERT INTO app_private.rent_support_withholding_events VALUES($1,$2,$3,'RESERVED',500000),($1,$2,$3,'COMMITTED',500000),($1,$2,$3,'RELEASED',1)`,[org,operation,sid]);
 expect(await fundingEvidence(sid)).toMatchObject({verified:true,prior_withheld:'500000',reserved:'0',settled_by_support:true,operation_id:operation});
});
it('rejects duplicate typed alias independently of helper conflict behavior',async()=>{
 const c=crypto.randomUUID(),person=await register(party),first=crypto.randomUUID(),second=crypto.randomUUID(),alias=crypto.randomUUID();
 await registry.query(`INSERT INTO public.contracts VALUES($1,$2,'ACTIVE',NULL)`,[c,org]);
 await registry.query(`INSERT INTO app_private.rent_support_payout_sources(id,organization_id,contract_id,party_id,kind,gross_original,evidence,created_by) VALUES($1,$3,$4,$5,'COMMISSION',3000000,'{}',$6),($2,$3,$4,$5,'BONUS',500000,'{}',$6)`,[first,second,org,c,person.party_id,party]);
 await registry.query(`INSERT INTO app_private.rent_support_source_aliases(organization_id,source_id,alias_kind,alias_id,created_by) VALUES($1,$2,'VOUCHER',$3,$4)`,[org,first,alias,party]);
 await expect(registry.query(`INSERT INTO app_private.rent_support_source_aliases(organization_id,source_id,alias_kind,alias_id,created_by) VALUES($1,$2,'VOUCHER',$3,$4)`,[org,second,alias,party])).rejects.toMatchObject({code:'23505'});
});
