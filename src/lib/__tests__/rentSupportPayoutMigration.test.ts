import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { setupPayoutDb, org, actor, room, uuid } from './fixtures/rentSupportPayoutDb';

const migration = 'supabase/migrations/20260930101338_rent_support_upfront_payouts.sql';
const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const source = (kind: string, party: string, gross: string) => ({
 source_id: id(kind === 'COMMISSION' ? 10 : 11), kind, party_id: party, gross_original: gross,
 already_paid: '0', prior_withheld: '0', reserved: '0', verified: true, locked: false, route: 'CASHBOOK',
});
async function allocate(policy: string, sources: unknown[]) {
 return (await db.query<{result: {state: string; sources: Array<{kind: string; current_withheld: string; net_this_operation: string}>; unallocated: string}}>(
  'SELECT app_private.rent_support_allocate_funding_v1($1,$2,$3,1800000,0,$4) result', ['SALE', id(1), policy, JSON.stringify(sources)])).rows[0].result;
}
beforeAll(async () => {
 await db.exec('CREATE SCHEMA app_private; CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;');
 await db.exec(readFileSync('supabase/migrations/20260930085304_rent_support_payout_sources.sql', 'utf8').split('-- Registry and canonical providers')[0]);
 if (existsSync(migration)) await db.exec(readFileSync(migration, 'utf8').split('-- Durable funding storage')[0]);
}, 30000);
afterAll(async () => db.close());

it.each(['COMMISSION_ONLY', 'BONUS_THEN_COMMISSION'])('does not reject or deduct unrelated Sale bonus under %s', async policy => {
 const result = await allocate(policy, [source('COMMISSION', id(1), '3000000'), source('BONUS', id(2), '500000')]);
 expect(result.state).toBe('READY');
 expect(result.sources.find(x => x.kind === 'COMMISSION')).toMatchObject({current_withheld:'1800000', net_this_operation:'1200000'});
 expect(result.sources.find(x => x.kind === 'BONUS')).toMatchObject({current_withheld:'0', net_this_operation:'500000'});
});
it('never takes unrelated commission to cover a shortfall', async () => {
 const result = await allocate('BONUS_THEN_COMMISSION', [source('COMMISSION', id(2), '3000000'), source('BONUS', id(1), '500000')]);
 expect(result.state).toBe('NEEDS_REVIEW');expect(result.unallocated).toBe('1300000');
 expect(result.sources.every(x => x.current_withheld === '0')).toBe(true);
});
it('keeps a fully withheld source at zero net without negative payout', async () => {
 const result = await allocate('BONUS_THEN_COMMISSION', [source('COMMISSION', id(1), '1300000'), source('BONUS', id(1), '500000')]);
 expect(result.state).toBe('READY');expect(result.sources.map(x => x.net_this_operation)).toEqual(['0','0']);
});

const bundleDb = new PGlite();
beforeAll(async () => { await setupPayoutDb(bundleDb,migration); },30000);
afterAll(async () => bundleDb.close());
type Receipt = {operation_id:string;status:string;sources:Array<{source_id:string;gross:string;withheld:string;net:string;status:string;voucher_id:string|null}>};
async function fixture(commission='3000000', bonus='500000', policy='COMMISSION_ONLY') {
 const contract=crypto.randomUUID(),request=crypto.randomUUID();
 await bundleDb.query(`INSERT INTO public.contracts(id,organization_id,room_id,start_date,end_date,discounts,status,deleted_at) VALUES($1,$2,$3,'2026-09-01','2027-09-01','{}','ACTIVE',NULL)`,[contract,org,room]);
 const party=(await bundleDb.query<{result:{party_id:string}}>(`SELECT public.register_rent_support_party_v1($1,$2,NULL,'Verified party','Test verification',$3) result`,[org,uuid(102),crypto.randomUUID()])).rows[0].result.party_id;
 const plan={version:2,start_billing_month:'2026-09',payer:'SALE',sale_party_id:party,deduction_policy:policy,collection_mode:'UPFRONT_COMMITTED',segments:[{month_count:3,monthly_amount:'300000'},{month_count:9,monthly_amount:'100000'}]};
 await bundleDb.query('SELECT app_private.persist_contract_rent_support_v1($1,$2,$3)',[org,contract,JSON.stringify(plan)]);
 const intents=[['COMMISSION',commission],['BONUS',bonus]].filter(([,gross])=>gross!=='0').map(([kind,gross])=>({intent_id:crypto.randomUUID(),source_id:null,kind,party_id:party,gross_amount:gross,route:'CASHBOOK',manager_id:null,account_id:null,voucher_date:'2026-09-30',payer_name:null,recipient_name:'Verified party',recipient_bank:null,recipient_account:null,item_description:null,attachments:[]}));
 const payload={version:2,intents};
 return {contract,request,plan,payload};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
it('preserves canonical legacy authority on inactive buildings while v2 remains strict',async()=>{
 const f=await fixture();
 const legacy=crypto.randomUUID();
 await bundleDb.query(`INSERT INTO public.contracts(id,organization_id,room_id,status) VALUES($1,$2,$3,'ACTIVE')`,[legacy,org,room]);
 await bundleDb.exec(`UPDATE public.buildings SET status='INACTIVE'`);
 try {
  await expect(bundleDb.query(`SELECT public.create_commission_voucher($1,'broker',100,'2026-09-30')`,[legacy])).resolves.toBeDefined();
  await expect(bundleDb.query(`SELECT app_private.rent_support_payout_lock_v1($1,$2)`,[org,f.contract])).rejects.toMatchObject({code:'42501'});
 } finally {await bundleDb.exec(`UPDATE public.buildings SET status='ACTIVE'`);}
});
async function quote(f:Fixture) {
 return (await bundleDb.query<{result:{quote_hash:string;state:string}}>('SELECT public.quote_contract_rent_support_v1($1,$2,NULL,$3,NULL,$4) result',[org,f.contract,JSON.stringify(f.plan),JSON.stringify(f.payload)])).rows[0].result;
}
async function prepare(f:Fixture,hash:string) {
 return (await bundleDb.query<{result:{operation_id:string}}>('SELECT public.prepare_contract_payouts_with_support_v1($1,$2,1,$3,$4,$5) result',[org,f.contract,hash,JSON.stringify(f.payload),f.request])).rows[0].result;
}
async function execute(f:Fixture,hash:string) {
 return (await bundleDb.query<{result:Receipt}>('SELECT public.create_contract_payouts_with_support_v1($1,$2,1,$3,$4,$5) result',[org,f.contract,hash,JSON.stringify(f.payload),f.request])).rows[0].result;
}
it('executes one atomic bundle and replays immutable operation/source/voucher IDs after lost response',async()=>{
 const f=await fixture(),q=await quote(f);expect(q.state).toBe('READY');
 const prepared=await prepare(f,q.quote_hash),result=await execute(f,q.quote_hash);
 expect(result).toMatchObject({operation_id:prepared.operation_id,status:'COMPLETED'});
 expect(result.sources.find(s=>s.gross==='3000000')).toMatchObject({withheld:'1800000',net:'1200000',status:'COMPLETED'});
 expect(await execute(f,q.quote_hash)).toEqual(result);
 const read=(await bundleDb.query<{result:Receipt}>('SELECT public.read_contract_payout_operation_v1($1,$2) result',[org,result.operation_id])).rows[0].result;
 expect(read).toEqual(result);
 expect((await bundleDb.query('SELECT count(*)::int n FROM public.income_expenses WHERE contract_id=$1',[f.contract])).rows[0]).toEqual({n:2});
 f.payload.intents[0].recipient_bank='changed';
 await expect(execute(f,q.quote_hash)).rejects.toMatchObject({code:'PT409'});
});
it('settles net zero with completed receipt and no zero voucher',async()=>{
 const f=await fixture('1800000','0'),q=await quote(f);await prepare(f,q.quote_hash);
 const result=await execute(f,q.quote_hash);
 expect(result.sources[0]).toMatchObject({gross:'1800000',withheld:'1800000',net:'0',status:'SETTLED_BY_SUPPORT',voucher_id:null});
 expect((await bundleDb.query('SELECT count(*)::int n FROM public.income_expenses WHERE contract_id=$1',[f.contract])).rows[0]).toEqual({n:0});
 expect((await bundleDb.query<{result:{due_upfront:string}}> ('SELECT public.quote_contract_rent_support_v1($1,$2,NULL,$3,NULL,NULL) result',[org,f.contract,JSON.stringify(f.plan)])).rows[0].result.due_upfront).toBe('0');
});
it('rolls back bonus and withholding if commission later fails while durable attempt remains retryable',async()=>{
 const f=await fixture(),q=await quote(f),prepared=await prepare(f,q.quote_hash);
 await bundleDb.exec("SELECT set_config('test.fail_broker','yes',false)");
 try {expect((await execute(f,q.quote_hash)).status).toBe('FAILED');} finally {await bundleDb.exec("SELECT set_config('test.fail_broker','',false)");}
 expect((await bundleDb.query('SELECT count(*)::int n FROM public.income_expenses WHERE contract_id=$1',[f.contract])).rows[0]).toEqual({n:0});
 expect((await bundleDb.query('SELECT count(*)::int n FROM app_private.rent_support_payout_sources WHERE contract_id=$1',[f.contract])).rows[0]).toEqual({n:0});
 expect((await bundleDb.query<{result:{status:string;issue:{code:string;message:string}}}>('SELECT public.read_contract_payout_operation_v1($1,$2) result',[org,prepared.operation_id])).rows[0].result).toMatchObject({status:'FAILED',issue:{code:'PAYOUT_FAILED'}});
 // Another authorized operator executes the saved operation, not a new actor key.
 await bundleDb.exec(`SELECT set_config('test.actor','${uuid(104)}',false)`);
 try {
 const result=(await bundleDb.query<{result:Receipt}>('SELECT public.execute_contract_payout_operation_v1($1,$2) result',[org,prepared.operation_id])).rows[0].result;
 expect(result).toMatchObject({operation_id:prepared.operation_id,status:'COMPLETED'});
 } finally {await bundleDb.exec(`SELECT set_config('test.actor','${actor}',false)`);}
});
it('does not issue another net voucher for the same outstanding liability',async()=>{
 const f=await fixture(),q=await quote(f);await prepare(f,q.quote_hash);await execute(f,q.quote_hash);
 f.request=crypto.randomUUID();f.payload.intents.forEach(i=>{i.intent_id=crypto.randomUUID();});
 const next=await quote(f);expect(next.state).toBe('NEEDS_REVIEW');
 await expect(prepare(f,next.quote_hash)).rejects.toMatchObject({code:'PT409'});
});
it('rejects legacy direct commission and generic commission inserts for v2 contracts',async()=>{
 const f=await fixture();
 await expect(bundleDb.query(`SELECT public.create_commission_voucher($1,'broker',3000000,'2026-09-30')`,[f.contract])).rejects.toMatchObject({code:'PT409'});
 await expect(bundleDb.query(`INSERT INTO public.income_expenses(organization_id,contract_id,commission_kind,type,approval_status,total_amount) VALUES($1,$2,'sale','EXPENSE','UNAPPROVED',500000)`,[org,f.contract])).rejects.toMatchObject({code:'PT409'});
});
it('reads equal-name internal candidate pages in stable profile-ID order',async()=>{
 for(const n of [202,201]) {
 await bundleDb.query(`INSERT INTO public.profiles VALUES($1,'AAA same',true)`,[uuid(n)]);
 await bundleDb.query(`INSERT INTO public.organization_memberships VALUES($1,$2,$3,'ACTIVE',now()-interval '1 day',NULL,NULL)`,[crypto.randomUUID(),uuid(n),org]);
 }
 const pages=[];
 for(const offset of [0,1]) pages.push((await bundleDb.query<{result:{rows:Array<{profile_id:string}>}}>('SELECT public.list_rent_support_parties_v1($1,$2,$3,1) result',[org,uuid(102),offset])).rows[0].result.rows[0].profile_id);
 expect(pages).toEqual([uuid(201),uuid(202)]);
});
it('requires complete payload and invalidates quote for recipient/bank/attachment changes',async()=>{
 const f=await fixture(),q=await quote(f);
 f.payload.intents[0].recipient_bank='new bank';expect((await quote(f)).quote_hash).not.toBe(q.quote_hash);
 await expect(prepare(f,q.quote_hash)).rejects.toMatchObject({code:'PT409'});
 const incomplete={...f.payload,intents:[{...f.payload.intents[0],attachments:undefined}]};
 await expect(bundleDb.query('SELECT app_private.rent_support_payout_context_v1($1)',[JSON.stringify(incomplete)])).rejects.toMatchObject({code:'22023'});
});
it('checks current authorization on prepared operation execution and reads',async()=>{
 const f=await fixture(),q=await quote(f),p=await prepare(f,q.quote_hash);
 await bundleDb.exec("SELECT set_config('test.deny','yes',false)");
 try {
 await expect(bundleDb.query('SELECT public.execute_contract_payout_operation_v1($1,$2)',[org,p.operation_id])).rejects.toMatchObject({code:'42501'});
 await expect(bundleDb.query('SELECT public.read_contract_payout_operation_v1($1,$2)',[org,p.operation_id])).rejects.toMatchObject({code:'42501'});
 } finally {await bundleDb.exec("SELECT set_config('test.deny','',false)");}
 await expect(bundleDb.query('SELECT public.read_contract_payout_operation_v1($1,$2)',[uuid(999),p.operation_id])).rejects.toMatchObject({code:'42501'});
});
it('shows net-zero completion in existing followup and sale status readers without claiming cash paid',async()=>{
 const f=await fixture('0','1800000','BONUS_THEN_COMMISSION'),q=await quote(f);await prepare(f,q.quote_hash);await execute(f,q.quote_hash);
 const rows=(await bundleDb.query<{result:{rows:Array<{kind:string;state:string;can_retry:boolean;voucher_id:string|null}>}}>('SELECT public.list_contract_commission_followups_v2($1,$2) result',[org,[f.contract]])).rows[0].result.rows;
 expect(rows.find(r=>r.kind==='sale')).toMatchObject({state:'SETTLED_BY_SUPPORT',can_retry:false,voucher_id:null});
 const bonus=(await bundleDb.query<{result:unknown}>('SELECT public.sale_bonus_status_v1($1) result',[f.contract])).rows[0].result;
 expect(bonus).toMatchObject({alreadyPaid:false,settledBySupport:true,voucherId:null});
});
it('reads the saved request after a lost prepare response and rejects a competing stale intent',async()=>{
 const f=await fixture(),q=await quote(f);
 expect((await bundleDb.query<{result:{status:string}}>('SELECT public.read_contract_payout_request_v1($1,$2) result',[org,f.request])).rows[0].result.status).toBe('NOT_FOUND');
 const p=await prepare(f,q.quote_hash);
 expect((await bundleDb.query<{result:unknown}>('SELECT public.read_contract_payout_request_v1($1,$2) result',[org,f.request])).rows[0].result).toMatchObject({status:'READY',operation_id:p.operation_id});
 await execute(f,q.quote_hash);
 f.request=crypto.randomUUID();f.payload.intents.forEach(i=>{i.intent_id=crypto.randomUUID();});
 await expect(prepare(f,q.quote_hash)).rejects.toMatchObject({code:'PT409'});
});
it('enforces source cap at commit independently of the application allocator',async()=>{
 const f=await fixture(),q=await quote(f);await prepare(f,q.quote_hash);const result=await execute(f,q.quote_hash);
 const s=result.sources.find(x=>x.gross==='3000000')!;
 await expect(bundleDb.query(`INSERT INTO app_private.rent_support_withholding_events(organization_id,operation_id,source_id,action,amount,actor_id,reason) VALUES($1,$2,$3,'RESERVED',4000000,$4,'invalid over-reservation')`,[org,result.operation_id,s.source_id,actor])).rejects.toMatchObject({code:'23514'});
 await expect(bundleDb.query(`UPDATE app_private.rent_support_payout_results SET net=-1 WHERE organization_id=$1 AND operation_id=$2`,[org,result.operation_id])).rejects.toMatchObject({code:'42501'});
 await expect(bundleDb.query(`UPDATE app_private.rent_support_funding_operations SET payload='{}' WHERE id=$1`,[result.operation_id])).rejects.toMatchObject({code:'42501'});
});
it('keeps private ledger/core inaccessible to API roles and replays migration without replacing completed receipts',async()=>{
 const f=await fixture(),q=await quote(f);await prepare(f,q.quote_hash);const result=await execute(f,q.quote_hash);
 await bundleDb.exec(readFileSync(migration,'utf8'));
 expect(await execute(f,q.quote_hash)).toEqual(result);
 await bundleDb.exec('SET ROLE authenticated');
 try {
 await expect(bundleDb.exec('SELECT * FROM app_private.rent_support_funding_operations')).rejects.toMatchObject({code:'42501'});
 await expect(bundleDb.query('SELECT app_private.rent_support_source_funding_evidence_v1($1,$2)',[org,result.sources[0].source_id])).rejects.toMatchObject({code:'42501'});
 } finally {await bundleDb.exec('RESET ROLE');}
});
it('rejects wrong net even inside a private authorized transaction for the same contract/kind',async()=>{
 const f=await fixture(),q=await quote(f),p=await prepare(f,q.quote_hash);
 await bundleDb.exec('BEGIN');
 try {
 await bundleDb.query(`INSERT INTO app_private.rent_support_payout_sources(id,organization_id,contract_id,party_id,kind,gross_original,evidence,created_by) VALUES(app_private.rent_support_source_id_v1($1,$2,'COMMISSION'),$1,$2,$3,'COMMISSION',3000000,jsonb_build_object('operation_id',$4::text),$5)`,[org,f.contract,f.payload.intents[0].party_id,p.operation_id,actor]);
 await bundleDb.query(`INSERT INTO app_private.rent_support_payout_authorizations VALUES($1,$2,'broker',$3,3000000,1200000,pg_current_xact_id(),pg_backend_pid())`,[org,f.contract,p.operation_id]);
 await expect(bundleDb.query(`INSERT INTO public.income_expenses(organization_id,contract_id,commission_kind,type,approval_status,total_amount) VALUES($1,$2,'broker','EXPENSE','UNAPPROVED',3000000)`,[org,f.contract])).rejects.toMatchObject({code:'PT409'});
 } finally {await bundleDb.exec('ROLLBACK');}
});
