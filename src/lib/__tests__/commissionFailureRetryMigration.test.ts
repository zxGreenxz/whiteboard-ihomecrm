import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const path = 'supabase/migrations/20260929130117_contract_commission_followups.sql';
const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = id(1), otherOrg = id(2), actor = id(3), otherActor = id(4), building = id(5), hiddenBuilding = id(6);
const room = id(7), hiddenRoom = id(8), contract = id(9), hiddenContract = id(10), foreignContract = id(11), voucher = id(12), deposit = id(13);
type Event = { action: string; reason: string | null; amount: number | null; actor_name: string | null; created_at: string };
type Row = { contract_id: string; kind: string; state: string; last_reason: string | null; last_actor: string | null; attempted_amount: number | null; voucher_id: string | null; voucher_code: string | null; voucher_status: string | null; can_manage: boolean; events: Event[] };
type Page = { rows: Row[]; total: number };

beforeAll(async () => {
  // Real PostgreSQL roles/RLS and transaction-local JWT claims. The permission
  // catalog boundary is represented by explicit grants, not a blanket allow.
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES('${actor}'),('${otherActor}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
    CREATE TABLE organizations(id uuid PRIMARY KEY); INSERT INTO organizations VALUES('${org}'),('${otherOrg}');
    CREATE TABLE memberships(organization_id uuid,user_id uuid); INSERT INTO memberships VALUES('${org}','${actor}'),('${org}','${otherActor}');
    CREATE TABLE grants(user_id uuid,organization_id uuid,building_id uuid,permission text,org_wide boolean DEFAULT false);
    INSERT INTO grants SELECT '${actor}','${org}','${building}',p FROM unnest(ARRAY['contracts.view','contracts.edit','income_expenses.view','income_expenses.create']) p;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT coalesce(array_agg(organization_id),'{}') FROM memberships WHERE user_id=auth.uid() $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM grants WHERE user_id=auth.uid() AND building_id=$1) $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.super_admin',true),'')='yes' $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT CASE WHEN coalesce(current_setting('test.sandbox',true),'')='yes' THEN ARRAY['${org}'::uuid] ELSE '{}'::uuid[] END $$;
    CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT bool_or(org_wide),array_agg(building_id),'{}'::uuid[] FROM grants WHERE user_id=auth.uid() AND permission=$1 AND organization_id=$2 HAVING count(*)>0 $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM grants WHERE user_id=$1 AND organization_id=$2 AND permission=$3 AND building_id=$4) $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid NOT NULL,name text,deleted_at timestamptz);
    INSERT INTO buildings VALUES('${building}','${org}','Visible',NULL),('${hiddenBuilding}','${org}','Hidden',NULL);
    CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid NOT NULL,building_id uuid,name text,deleted_at timestamptz);
    INSERT INTO rooms VALUES('${room}','${org}','${building}','101',NULL),('${hiddenRoom}','${org}','${hiddenBuilding}','102',NULL);
    CREATE TABLE contracts(id uuid PRIMARY KEY,organization_id uuid NOT NULL,room_id uuid,contract_number text,status text,signed_date date DEFAULT '2026-09-29',created_at timestamptz DEFAULT now(),deleted_at timestamptz,UNIQUE(organization_id,id));
    INSERT INTO contracts(id,organization_id,room_id,contract_number,status) VALUES('${contract}','${org}','${room}','OLD-01','TERMINATED'),('${hiddenContract}','${org}','${hiddenRoom}','HIDDEN','ACTIVE'),('${foreignContract}','${otherOrg}','${room}','FOREIGN','ACTIVE');
    CREATE TABLE profiles(id uuid PRIMARY KEY,full_name text); INSERT INTO profiles VALUES('${actor}','Người xử lý'),('${otherActor}','Khác');
    CREATE TABLE income_expenses(id uuid PRIMARY KEY,organization_id uuid NOT NULL,contract_id uuid,building_id uuid,commission_kind text,code text,approval_status text,deleted_at timestamptz,created_at timestamptz DEFAULT now(),visible boolean DEFAULT true);
    CREATE TABLE app_private.sale_bonus_claims(organization_id uuid,deposit_voucher_id uuid,bonus_voucher_id uuid);
    CREATE FUNCTION app_private.ie_supplement_can_read_v1(uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM income_expenses v JOIN grants g ON g.organization_id=v.organization_id AND g.building_id=v.building_id WHERE v.id=$1 AND v.visible AND g.user_id=auth.uid() AND g.permission='income_expenses.view') $$;
    GRANT USAGE ON SCHEMA public,auth,app_private TO authenticated,anon,service_role;
  `);
  await db.exec('GRANT SELECT ON income_expenses TO authenticated');
  await db.exec(readFileSync(path, 'utf8'));
  await db.exec(`CREATE FUNCTION public.create_commission_voucher(p_contract_id uuid,p_kind text,p_amount numeric,p_voucher_date date,p_account_id uuid DEFAULT NULL,p_payer_name text DEFAULT NULL,p_recipient_name text DEFAULT NULL,p_recipient_bank text DEFAULT NULL,p_recipient_account text DEFAULT NULL,p_item_description text DEFAULT NULL,p_attachments jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$ DECLARE v_id uuid:=gen_random_uuid(); v_code text:='PC-NEW'; v_contract record; BEGIN SELECT '${org}'::uuid organization_id INTO v_contract; IF p_item_description='SERVER_FAIL' THEN RAISE EXCEPTION 'Fixture rejected'; END IF; INSERT INTO income_expenses(id,organization_id,contract_id,building_id,commission_kind,code,approval_status) VALUES(v_id,'${org}',p_contract_id,'${building}',p_kind,'PC-NEW','UNAPPROVED'); RETURN jsonb_build_object('id', v_id, 'code', v_code); END $$;`);
  const hotfix='supabase/migrations/20260929154941_commission_failure_retry.sql';
  if (existsSync(hotfix)) { await db.exec(readFileSync(hotfix,'utf8')); await db.exec(readFileSync(hotfix,'utf8')); }
}, 30_000);
afterAll(() => db.close());

async function tx(run: () => Promise<void>) {
  await db.exec(`BEGIN; SET LOCAL request.jwt.claims='{"sub":"${actor}","role":"authenticated"}'; SET LOCAL ROLE authenticated;`);
  try { await run(); } finally { await db.exec('ROLLBACK'); }
}
async function denied(run: () => Promise<unknown>, code: string) {
  await db.exec('SAVEPOINT denied');
  try { await expect(run()).rejects.toMatchObject({ code }); } finally { await db.exec('ROLLBACK TO SAVEPOINT denied; RELEASE SAVEPOINT denied'); }
}
async function owner(sql: string) { await db.exec(`RESET ROLE; ${sql}; SET LOCAL ROLE authenticated;`); }
async function list(options: { org?: string | null; ids?: string[] | null; buildings?: string[] | null; offset?: number; limit?: number; unresolved?: boolean } = {}) {
  return (await db.query<{ result: Page }>('SELECT public.list_contract_commission_followups_v2($1,$2::uuid[],$3::uuid[],$4,$5,$6) result', [options.org === undefined ? org : options.org, options.ids ?? null, options.buildings ?? null, options.offset ?? 0, options.limit ?? 50, options.unresolved ?? false])).rows[0].result;
}
async function record(action: string, request = id(100), amount: number | string | null = 100, reason: string | null = null, kind = 'broker', contractId = contract, organization = org) {
  return (await db.query<{ result: { id: string; action: string } }>('SELECT public.record_contract_commission_event_v1($1,$2,$3,$4,$5,$6::numeric,$7) result', [organization, contractId, kind, action, request, amount, reason])).rows[0].result;
}
async function broker() { return (await list()).rows.find(row => row.contract_id === contract && row.kind === 'broker')!; }
async function liveVoucher(kind = 'broker', linkedContract: string | null = contract) {
  await owner(`INSERT INTO income_expenses(id,organization_id,contract_id,building_id,commission_kind,code,approval_status) VALUES('${voucher}','${org}',${linkedContract ? `'${linkedContract}'` : 'NULL'},'${building}','${kind}','PC-01','APPROVED')`);
}


const intent = (kind='broker', request=id(100), description='Commission') => ({ request_id: request, contract_id: contract, kind, amount: 100, voucher_date: '2026-09-29', item_description: description });
async function prepare(intents=[intent()]) { return (await db.query<{result: unknown}>("select public.prepare_commission_requests_v1($1,$2::jsonb) result",[org,JSON.stringify(intents)])).rows[0].result; }
async function execute(request=id(100),kind='broker') { return (await db.query<{result: {status: string; id?: string; code?: string}}>("select public.execute_commission_request_v1($1,$2,$3,$4) result",[org,contract,kind,request])).rows[0].result; }
async function age() { await owner("ALTER TABLE contract_commission_events DISABLE TRIGGER guard_contract_commission_events; UPDATE contract_commission_events SET created_at=now()-interval '10 minutes'; ALTER TABLE contract_commission_events ENABLE TRIGGER guard_contract_commission_events"); }

describe('actual failed/interrupted issuance, never historical backlog',()=>{
 it('hundreds of unattempted subjects yield zero unresolved failures',()=>tx(async()=>{
  await owner(`INSERT INTO contracts(id,organization_id,room_id,contract_number,status) SELECT gen_random_uuid(),'${org}','${room}','legacy-'||g,'ACTIVE' FROM generate_series(1,350) g`);
  expect((await list({unresolved:true})).total).toBe(0);
  expect((await list()).total).toBe(702);
 }));
 it('distinguishes processing from interrupted intent; matched failure is one',()=>tx(async()=>{
  await record('ATTEMPTED'); expect((await list({unresolved:true})).total).toBe(0);
  expect((await broker()).state).toBe('PROCESSING'); await age();
  expect((await list({unresolved:true})).rows).toMatchObject([{state:'UNKNOWN'}]);
  await record('FAILED',id(100),100,'Connection failed');
  expect((await list({unresolved:true})).rows).toMatchObject([{state:'FAILED'}]);
 }));
 it('saves every selected intent atomically and does not issue until execute',()=>tx(async()=>{
  await prepare([intent(),intent('sale',id(101))]);
  expect((await list()).rows.map(r=>r.state)).toEqual(['PROCESSING','PROCESSING']);
  expect((await db.query('select * from income_expenses')).rows).toHaveLength(0);
  await age(); expect((await list({unresolved:true})).total).toBe(2);
 }));
 it('rejects zero or changed payload and preserves original identity',()=>tx(async()=>{
  await denied(()=>prepare([{...intent(),amount:0}]),'22023');
  await prepare(); await prepare();
  await denied(()=>prepare([{...intent(),amount:101}]),'PT409');
  const a=await execute(); expect(a.status).toBe('COMPLETED'); expect(await execute()).toEqual(a);
  expect((await db.query('select * from income_expenses')).rows).toHaveLength(1);
 }));
 it('durable success survives cancellation/delete and late older errors',()=>tx(async()=>{
  await record('ATTEMPTED',id(90)); await prepare(); const a=await execute();
  await owner(`UPDATE income_expenses SET approval_status='CANCELLED',deleted_at=now() WHERE id='${a.id}'`);
  await record('FAILED',id(90),100,'Late error'); await age();
  expect((await list({unresolved:true})).total).toBe(0); expect(await execute()).toEqual(a);
 }));
 it('reconciles existing direct or deposit-linked vouchers',()=>tx(async()=>{
  await liveVoucher(); await prepare(); expect(await execute()).toMatchObject({status:'ALREADY_EXISTS',id:voucher});
  await owner(`INSERT INTO income_expenses(id,organization_id,contract_id,building_id,code,approval_status) VALUES('${deposit}','${org}','${contract}','${building}','DEP','APPROVED'); INSERT INTO app_private.sale_bonus_claims VALUES('${org}','${deposit}','${voucher}')`);
  await prepare([intent('sale',id(101))]); expect((await execute(id(101),'sale')).id).toBe(voucher);
 }));
 it('stores actual server failure without rolling back the prepared intent',()=>tx(async()=>{
  await prepare([intent('broker',id(100),'SERVER_FAIL')]); expect((await execute()).status).toBe('FAILED');
  expect((await list({unresolved:true})).rows).toMatchObject([{state:'FAILED'}]);
 }));
 it('blocks foreign org, inaccessible building and raw payload reads',()=>tx(async()=>{
  await denied(()=>prepare([{...intent(),contract_id:hiddenContract}]),'42501');
  await denied(()=>prepare([{...intent(),contract_id:foreignContract}]),'42501');
  await denied(()=>db.query('select * from public.contract_commission_requests'),'42501');
 }));
});

describe('queue filters and financial redaction',()=>{
 it('applies filters before count and pagination using attempted local date',()=>tx(async()=>{
  await prepare([intent(),intent('sale',id(101))]); await age();
  const read=async(extra: string,offset=0)=>(await db.query<{result:Page}>(`select public.list_contract_commission_followups_v2('${org}',NULL,NULL,${offset},1,true,${extra}) result`)).rows[0].result;
  expect((await read("NULL,NULL,NULL,NULL")).total).toBe(2);
  expect((await read("NULL,NULL,NULL,NULL",1)).rows).toHaveLength(1);
  expect((await read("'sale','OLD-01',NULL,NULL")).total).toBe(1);
  expect((await read("NULL,'missing',NULL,NULL")).total).toBe(0);
  expect((await read("NULL,NULL,'2000-01-01','2000-12-31'")).total).toBe(0);
  await owner("ALTER TABLE contract_commission_events DISABLE TRIGGER guard_contract_commission_events; UPDATE contract_commission_events SET created_at='2026-09-28 18:00:00+00' WHERE action='ATTEMPTED'; ALTER TABLE contract_commission_events ENABLE TRIGGER guard_contract_commission_events");
  expect((await read("NULL,NULL,'2026-09-29','2026-09-29'")).total).toBe(2);
 }));
 it('hides amount/reason and receipt identity without financial read',()=>tx(async()=>{
  await prepare([intent('broker',id(100),'SERVER_FAIL')]); await execute();
  await owner(`DELETE FROM grants WHERE permission='income_expenses.view'`);
  const row=await broker(); expect(row.attempted_amount).toBeNull();expect(row.last_reason).toBeNull();expect(row.events.every(e=>e.amount===null && e.reason===null)).toBe(true);
  await liveVoucher(); expect(await execute()).toMatchObject({status:'ALREADY_EXISTS',id:null,code:null});
 }));
 it('does not partially persist a batch containing forbidden or zero intent',()=>tx(async()=>{
  await denied(()=>prepare([intent(),{...intent('sale',id(101)),amount:0}]),'22023');
  expect((await broker()).events).toHaveLength(0);
 }));
});

it('keeps v1 deployed-client enums compatible while excluding processing from unresolved',()=>tx(async()=>{
 await prepare();
 const legacy=async(unresolved=false)=>(await db.query<{result:Page}>('select public.list_contract_commission_followups_v1($1,NULL,NULL,0,50,$2) result',[org,unresolved])).rows[0].result;
 expect((await legacy()).rows.find(r=>r.kind==='broker')?.state).toBe('PENDING'); expect((await legacy(true)).total).toBe(0);
 await execute(); expect((await legacy()).rows.every(r=>r.events.every(e=>e.action!=='COMPLETED'))).toBe(true);
}));

it('cancelled completed receipt suppresses errors but permits an explicit new normal issuance',()=>tx(async()=>{
 await prepare();const original=await execute();await owner(`UPDATE income_expenses SET approval_status='CANCELLED' WHERE id='${original.id}'`);
 expect((await broker()).state).toBe('PENDING');expect((await list({unresolved:true})).total).toBe(0);expect(await execute()).toEqual(original);
 await prepare([intent('broker',id(102))]);const replacement=await execute(id(102));expect(replacement.status).toBe('COMPLETED');expect(replacement.id).not.toBe(original.id);
}));

it('old deployed app direct canonical success survives lost response and later cancellation',()=>tx(async()=>{
 await record('ATTEMPTED');
 const r=(await db.query<{result:{id:string}}>(`select public.create_commission_voucher('${contract}','broker',100,'2026-09-29') result`)).rows[0].result;
 await record('FAILED',id(100),100,'Lost response');await owner(`UPDATE income_expenses SET approval_status='CANCELLED' WHERE id='${r.id}'`);
 expect((await list({unresolved:true})).total).toBe(0);expect((await broker()).state).toBe('PENDING');
}));

describe('completed lifecycle reconciles every intent that predates cancellation',()=>{
 it.each([false,true])('does not replace a cancelled voucher from delayed intent; B prepared first=%s', reverse=>tx(async()=>{
  const a=intent('broker',id(201)),b=intent('broker',id(202));
  if(reverse){await prepare([b]);await prepare([a]);}else{await prepare([a]);await prepare([b]);}
  const original=await execute(id(201));
  await owner(`UPDATE income_expenses SET approval_status='CANCELLED',deleted_at=now() WHERE id='${original.id}'`);
  const delayed=await execute(id(202));expect(delayed).toMatchObject({status:'ALREADY_EXISTS',id:original.id});
  expect((await db.query('select * from income_expenses')).rows).toHaveLength(1);
  await prepare([intent('broker',id(203))]);const fresh=await execute(id(203));expect(fresh.status).toBe('COMPLETED');expect(fresh.id).not.toBe(original.id);
  expect((await db.query('select * from income_expenses')).rows).toHaveLength(2);
 }));
 it('captures existing receipt during prepare before cancellation, without extending the issuance lifecycle on retry',()=>tx(async()=>{
  await prepare([intent('broker',id(201))]);const original=await execute(id(201));
  await prepare([intent('broker',id(202))]);
  await owner(`UPDATE income_expenses SET approval_status='CANCELLED',deleted_at=now() WHERE id='${original.id}'`);
  expect(await execute(id(202))).toMatchObject({status:'ALREADY_EXISTS',id:original.id});
  await prepare([intent('broker',id(203))]);
  expect(await execute(id(202))).toMatchObject({status:'ALREADY_EXISTS',id:original.id});
  const fresh=await execute(id(203));expect(fresh.status).toBe('COMPLETED');expect(fresh.id).not.toBe(original.id);
  expect((await db.query('select * from income_expenses')).rows).toHaveLength(2);
 }));
});
