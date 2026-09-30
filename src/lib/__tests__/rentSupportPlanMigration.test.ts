import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, expect, it } from 'vitest';
const db = new PGlite();
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org=uid(1), other=uid(2), actor=uid(3), building=uid(4), room=uid(5), contract=uid(6), foreign=uid(7), draft=uid(8);
const plan={version:2,start_billing_month:'2026-09',payer:'BUILDING',sale_party_id:null,deduction_policy:'COMMISSION_ONLY',collection_mode:'UPFRONT_COMMITTED',segments:[{month_count:3,monthly_amount:'300000'},{month_count:9,monthly_amount:'100000'}]};
async function quote(payload=plan, subject=contract, organization=org) { return (await db.query<{result:Record<string,unknown>}>('SELECT public.quote_contract_rent_support_v1($1,$2,NULL,$3,NULL,NULL) result',[organization,subject,JSON.stringify(payload)])).rows[0].result; }
async function revise(payload=plan, revision=1, request=uid(20)) { return (await db.query<{result:Record<string,unknown>}>('SELECT public.revise_contract_rent_support_v1($1,$2,$3,$4,$5,$6) result',[org,contract,revision,JSON.stringify(payload),'review reason',request])).rows[0].result; }
beforeAll(async()=>{
 await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA app_private;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${actor}'::uuid $$;
 CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${org}'::uuid] $$;
 CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
 CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT '{}'::uuid[] $$;
 CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1='${building}'::uuid AND current_setting('test.deny_building',true) IS DISTINCT FROM 'yes' $$;
 CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql STABLE AS $$ SELECT false, CASE WHEN current_setting('test.deny',true) IS DISTINCT FROM $1 THEN ARRAY['${building}'::uuid] ELSE '{}'::uuid[] END,'{}'::uuid[] $$;
 CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN;END $$;
 CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$ SELECT $2='${org}'::uuid AND $4='${building}'::uuid $$;
 CREATE TABLE public.organizations(id uuid PRIMARY KEY,status text);INSERT INTO public.organizations VALUES('${org}','ACTIVE'),('${other}','ACTIVE');
 CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz,status text DEFAULT 'ACTIVE');
 INSERT INTO public.buildings VALUES('${building}','${org}',NULL,'ACTIVE'),('${uid(51)}','${other}',NULL,'ACTIVE'),('${uid(52)}','${org}',now(),'ACTIVE'),('${uid(53)}','${org}',NULL,'INACTIVE');
 CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,deleted_at timestamptz);
 INSERT INTO public.rooms VALUES('${room}','${org}','${building}',NULL);
 CREATE TABLE public.contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,start_date date,end_date date,discounts jsonb,deleted_at timestamptz,UNIQUE(organization_id,id));
 INSERT INTO public.contracts VALUES('${contract}','${org}','${room}','2026-09-01','2027-09-01','{}',NULL),('${foreign}','${other}','${room}','2026-09-01','2027-09-01','{}',NULL);
 CREATE TABLE public.contract_drafts(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,payload jsonb,revision integer);
 INSERT INTO public.contract_drafts VALUES('${draft}','${org}','${building}','{}',1);`);
 const files=readdirSync('supabase/migrations').filter(x=>x.endsWith('_contract_rent_support_plans.sql'));
 for(const name of files){const sql=readFileSync(`supabase/migrations/${name}`,'utf8');await db.exec(sql);await db.exec(sql);}
 const scope=readFileSync('supabase/migrations/20260929154150_contract_rent_support_draft_privacy.sql','utf8').split('-- Private versioned funding input')[0];await db.exec(scope);await db.exec(scope);
},30000);
afterAll(async()=>{await db.close();});
it('quotes literal twelve months, never trusts supplied payout evidence or pretends enabled writers',async()=>{
 const q=await quote();expect(q.committed_total).toBe('1800000');expect(q.state).toBe('NEEDS_REVIEW');
 expect(q.months).toHaveLength(12);expect((q.months as Record<string,unknown>[])[0]).toMatchObject({billing_month:'2026-09',agreed_amount:'300000'});
 expect((q.months as Record<string,unknown>[])[11]).toMatchObject({billing_month:'2027-08',agreed_amount:'100000'});
 await expect(db.query('SELECT public.quote_contract_rent_support_v1($1,$2,NULL,$3,NULL,$4)',[org,contract,JSON.stringify(plan),'{"already_paid":0}'])).rejects.toMatchObject({code:'22023'});
});
it('rejects wrong org and inaccessible building with explicit authorization errors',async()=>{
 await expect(quote(plan,foreign,org)).rejects.toMatchObject({code:'42501'});
 await expect(quote(plan,contract,other)).rejects.toMatchObject({code:'42501'});
 await db.exec("SELECT set_config('test.deny_building','yes',false)");
 try {await expect(quote()).rejects.toMatchObject({code:'42501'});}finally{await db.exec("SELECT set_config('test.deny_building','',false)");}
});
it('rejects unknown keys, nonfinite and nonstring amounts',async()=>{
 for(const invalid of [{...plan,extra:true},{...plan,segments:[{month_count:1,monthly_amount:'NaN'}]},{...plan,segments:[{month_count:1,monthly_amount:1}]},{...plan,segments:[{month_count:1,monthly_amount:'Infinity'}]}]) await expect(quote(invalid as typeof plan)).rejects.toMatchObject({code:'22023'});
});
it('persists immutable twelve month schedule, reads legacy and preserves replay identity',async()=>{
 await db.query('SELECT app_private.persist_contract_rent_support_v1($1,$2,$3)',[org,contract,JSON.stringify(plan)]);
 const result=(await db.query<{result:{total:number;rows:{months:unknown[]}[]}}>('SELECT public.read_contract_rent_support_v1($1,$2,NULL,0,50) result',[org,[contract]])).rows[0].result;
 expect(result.total).toBe(1);expect(result.rows[0].months).toHaveLength(12);
 const next={...plan,deduction_policy:'BONUS_THEN_COMMISSION'};const a=await revise(next);expect(a.state).toBe('ACTIVE');expect(await revise(next)).toEqual(a);
 await expect(revise({...next,payer:'SALE',sale_party_id:uid(30)} as typeof plan)).rejects.toMatchObject({code:'PT409'});
 expect((await db.query('SELECT * FROM app_private.contract_rent_support_months')).rows).toHaveLength(24);
 await expect(db.exec("UPDATE app_private.contract_rent_support_months SET agreed_amount=1")).rejects.toMatchObject({code:'42501'});
});
it('keeps signed customer obligations active until amendment evidence exists',async()=>{
 const before=await quote();
 const result=await revise({...plan,segments:[{month_count:3,monthly_amount:'300000'}]},2,uid(21));
 expect(result.state).toBe('NEEDS_REVIEW');
 expect((await quote()).quote_hash).not.toBe(before.quote_hash);
 const stored=(await db.query<{committed_total:string}>('SELECT committed_total FROM app_private.contract_rent_support_plans WHERE state=\'ACTIVE\' ORDER BY revision DESC LIMIT 1')).rows[0];expect(stored.committed_total).toBe('1800000');
});
it('contract-only read redacts financial identity and reasons; raw private tables remain inaccessible',async()=>{
 await db.exec("SELECT set_config('test.deny','income_expenses.view',false)");
 try{
  await expect(quote()).rejects.toMatchObject({code:'42501'});
  const result=JSON.stringify((await db.query('SELECT public.read_contract_rent_support_v1($1,$2,NULL,0,50)',[org,[contract]])).rows);
  expect(result).not.toContain('sale_party_id');expect(result).not.toContain('review reason');expect(result).not.toContain('deduction_policy');
 }finally{await db.exec("SELECT set_config('test.deny','',false)");}
 await db.exec('SET ROLE authenticated');try{await expect(db.query('SELECT * FROM app_private.contract_rent_support_plans')).rejects.toMatchObject({code:'42501'});}finally{await db.exec('RESET ROLE');}
});
it('carries forward only same-identity funding, never crosses payees or refunds a decrease',async()=>{
 const evidence={verified:true,has_funding:true,identities:[{payer:'SALE',sale_party_id:uid(30),deduction_policy:'COMMISSION_ONLY',net_committed_withholding:'300000'}]};
 await db.exec(`CREATE OR REPLACE FUNCTION app_private.rent_support_funding_evidence_v1(p_org uuid,p_contract uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '${JSON.stringify(evidence)}'::jsonb $$`);
 const same=await quote({...plan,payer:'SALE',sale_party_id:uid(30)} as typeof plan);expect(same.due_upfront).toBe('1500000');
 const different=await quote({...plan,payer:'SALE',sale_party_id:uid(31)} as typeof plan);expect(different.due_upfront).toBe('1800000');
 const decrease=await quote({...plan,payer:'SALE',sale_party_id:uid(30),segments:[{month_count:1,monthly_amount:'100000'}]} as typeof plan);expect(decrease.due_upfront).toBe('0');expect(decrease.state).toBe('NEEDS_REVIEW');expect(decrease.issues).toContainEqual(expect.objectContaining({code:'FUNDING_REVERSAL_REVIEW'}));
 const r=await revise({...plan,payer:'SALE',sale_party_id:uid(31)} as typeof plan,2,uid(22));expect(r.state).toBe('NEEDS_REVIEW');expect(r.active_revision).toBe(2);
});
it('reads legacy explicitly and calculates total independently of pagination',async()=>{
 await db.query('INSERT INTO public.contracts VALUES($1,$2,$3,$4,$5,$6,NULL)',[uid(40),org,room,'2026-09-01','2027-09-01',JSON.stringify({months:3,amount_per_month:300000})]);
 const result=(await db.query<{result:{total:number;rows:Record<string,unknown>[]}}>('SELECT public.read_contract_rent_support_v1($1,NULL,NULL,1,1) result',[org])).rows[0].result;
 expect(result.total).toBe(2);expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject({kind:'LEGACY',legacy:{months:3,amount_per_month:300000},months:[]});
});
it('denies an organization outside membership even with a permitted building and permission',async()=>{
 const result=(await db.query<{allowed:boolean}>('SELECT app_private.rent_support_scope_v1($1,$2,$3) allowed',[other,building,'contracts.view'])).rows[0];
 expect(result.allowed).toBe(false);
});

it('rejects an explicit building belonging to another org even with access to both orgs',async()=>{
 await db.exec(`CREATE OR REPLACE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${org}'::uuid,'${other}'::uuid] $$;
 CREATE OR REPLACE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
 CREATE OR REPLACE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql STABLE AS $$ SELECT true,'{}'::uuid[],'{}'::uuid[] $$;`);
 await expect(db.query('SELECT public.read_contract_rent_support_v1($1,NULL,$2,0,50)',[org,[uid(51)]])).rejects.toMatchObject({code:'42501'});
 await expect(db.query('SELECT public.read_contract_rent_support_v1($1,NULL,$2,0,50)',[org,[uid(52)]])).rejects.toMatchObject({code:'42501'});
 await expect(db.query('SELECT public.read_contract_rent_support_v1($1,NULL,$2,0,50)',[org,[uid(53)]])).rejects.toMatchObject({code:'42501'});
 await db.query('UPDATE public.organizations SET status=$1 WHERE id=$2',['SUSPENDED',org]);
 try {await expect(db.query('SELECT public.read_contract_rent_support_v1($1,NULL,$2,0,50)',[org,[building]])).rejects.toMatchObject({code:'42501'});}finally{await db.query('UPDATE public.organizations SET status=$1 WHERE id=$2',['ACTIVE',org]);}
});
