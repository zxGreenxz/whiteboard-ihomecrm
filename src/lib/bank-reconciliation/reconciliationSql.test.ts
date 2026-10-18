import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Execute the live SQL, including row locks, joins, grants and money boundaries.
// The canonical collection writer is stubbed here; the real writer must also pass TEST before release.
const db=new PGlite();
const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=uid(1),actor=uid(2),building=uid(3),room=uid(4),account=uid(5),source=uid(6),customer=uid(7),contract=uid(8),invoice=uid(9);
const sql=readdirSync('supabase/migrations').sort().filter(f=>f.endsWith('.sql')).map(f=>readFileSync(`supabase/migrations/${f}`,'utf8'))
  .filter(s=>s.includes('CREATE OR REPLACE FUNCTION public.bank_reconciliation_v1(')).at(-1)!;
const input={id:uid(20),sourceId:source,eventType:'notification.received',origin:'com.bank.fixture',accountHint:'',contains:'',accountId:account,method:'TK',validFrom:'2026-01-01T00:00:00+07:00',enabled:true,revision:0};
let inTransaction=false;
async function rpc(action:string,data:Record<string,unknown>={},organization=org){
 if(inTransaction)await db.exec('SAVEPOINT rpc_attempt');
 try {const value=(await db.query<{r:Record<string,unknown>}>('select public.bank_reconciliation_v1($1,$2,$3::jsonb) r',[organization,action,JSON.stringify(data)])).rows[0].r;
 if(inTransaction)await db.exec('RELEASE SAVEPOINT rpc_attempt');return value;
 }catch(error){if(inTransaction)await db.exec('ROLLBACK TO SAVEPOINT rpc_attempt');throw error;}
}
async function event(n:number,amount=100000,description='KHACH MAU phong A01 TESTHOUSE',extra:Record<string,unknown>={}){
 await db.query('insert into app_private.bank_inbound_events(id,source_id,event_type,occurred_at) values($1,$2,$3,$4)',[uid(n),source,'notification.received','2026-10-01T09:00:00+07:00']);
 await db.query('insert into app_private.bank_reconciliation_facts(event_id,facts) values($1,$2::jsonb)',[uid(n),JSON.stringify({origin:'com.bank.fixture',amount,direction:'in',transactedAt:'2026-10-01T09:00:00+07:00',description,account:'••1234',bank:'DEMO',balance:null,reference:null,...extra})]);
}
async function rollback(work:()=>Promise<void>){await db.exec('BEGIN');inTransaction=true;try{await work();}finally{await db.exec('ROLLBACK');inTransaction=false;}}
const action=(n:number,extra:Record<string,unknown>={})=>({eventId:uid(n),revision:0,accountId:account,method:'TK',invoiceId:invoice,customerId:customer,expectedPaid:0,expectedRemaining:100000,invoiceRevision:0,reason:'Đã kiểm tra khách mẫu',...extra});
beforeAll(async()=>{
 await db.exec(`CREATE SCHEMA auth; CREATE SCHEMA app_private; CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('fixture.actor',true),'')::uuid $$;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('fixture.role',true) $$;
 CREATE FUNCTION is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('fixture.admin',true)='yes' $$;
 CREATE FUNCTION sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT '{}'::uuid[] $$;
 CREATE FUNCTION can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('fixture.building',true)='yes' $$;
 CREATE FUNCTION org_today_v1(uuid) RETURNS date LANGUAGE sql AS $$ SELECT '2026-10-18'::date $$;
 CREATE TABLE organizations(id uuid PRIMARY KEY);
 CREATE TABLE organization_memberships(organization_id uuid,user_id uuid,status text);
 CREATE TABLE accounts(id uuid PRIMARY KEY,organization_id uuid,name text,deleted_at timestamptz,is_virtual boolean,bank_name text,account_number text);
 CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,name text,deleted_at timestamptz);
 CREATE TABLE rooms(id uuid PRIMARY KEY,building_id uuid,name text,deleted_at timestamptz);
 CREATE TABLE customers(id uuid PRIMARY KEY,organization_id uuid,full_name text);
 CREATE TABLE contract_customers(contract_id uuid,customer_id uuid,is_representative boolean);
 CREATE TABLE invoices(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,room_id uuid,contract_id uuid,invoice_number text,billing_month text,
  remaining_amount numeric,paid_amount numeric,adjustment_revision int,previous_debt numeric,status text,deleted_at timestamptz,issue_date date,previous_debt_sources jsonb DEFAULT '[]',created_at timestamptz DEFAULT '2026-09-01');
 CREATE TABLE invoice_payment_collections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,invoice_id uuid,status text,collection_date date,retained_amount numeric);
 CREATE TABLE invoice_payment_tenders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),collection_id uuid,account_id uuid,payment_method text,retained_amount numeric);
 CREATE TABLE app_private.bank_event_sources(id uuid PRIMARY KEY,organization_id uuid,name text,revoked_at timestamptz);
 CREATE TABLE app_private.bank_inbound_events(id uuid PRIMARY KEY,source_id uuid,event_type text,occurred_at timestamptz,received_at timestamptz DEFAULT now());
 CREATE TABLE app_private.bank_event_audit(actor_id uuid,action text,source_id uuid,event_id uuid,detail jsonb);
 CREATE FUNCTION app_private.receiving_cashbook_ids_v1(uuid,uuid,text,uuid) RETURNS uuid[] LANGUAGE sql AS $$ SELECT CASE WHEN $3='TK' THEN ARRAY['${account}'::uuid] ELSE '{}'::uuid[] END $$;
 CREATE FUNCTION record_invoice_collection_v5(uuid,date,jsonb,text,boolean,text,text,numeric,text) RETURNS jsonb LANGUAGE plpgsql AS $$
 DECLARE cid uuid; amt numeric:=($3->0->>'gross_amount')::numeric; BEGIN
 INSERT INTO invoice_payment_collections(organization_id,invoice_id,status,collection_date,retained_amount) VALUES('${org}',$1,'ACTIVE',$2,amt) RETURNING id INTO cid;
 INSERT INTO invoice_payment_tenders(collection_id,account_id,payment_method,retained_amount) VALUES(cid,($3->0->>'account_id')::uuid,$3->0->>'payment_method',amt);
 UPDATE invoices SET paid_amount=paid_amount+amt,remaining_amount=remaining_amount-amt WHERE id=$1;
 RETURN jsonb_build_object('collection_id',cid); END $$;
 CREATE FUNCTION reverse_invoice_collection_v5(uuid,date,text,text) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
 IF length(btrim($3)) NOT BETWEEN 8 AND 1000 THEN RAISE EXCEPTION 'Invalid canonical reversal reason'; END IF;
 UPDATE invoice_payment_collections SET status='REVERSED' WHERE id=$1; RETURN '{}'; END $$;
 INSERT INTO organizations VALUES('${org}'),('${uid(100)}');
 INSERT INTO organization_memberships VALUES('${org}','${actor}','ACTIVE');
 INSERT INTO accounts VALUES('${account}','${org}','DEMO Bank',NULL,false,'DEMO','0000000000');
 INSERT INTO buildings VALUES('${building}','${org}','TESTHOUSE',NULL);
 INSERT INTO rooms VALUES('${room}','${building}','A01',NULL);
 INSERT INTO customers VALUES('${customer}','${org}','Khách Mẫu');
 INSERT INTO contract_customers VALUES('${contract}','${customer}',true);
 INSERT INTO invoices VALUES('${invoice}','${org}','${building}','${room}','${contract}','INV-TEST-01','2026-10',100000,0,0,0,'APPROVED',NULL,'2026-10-01','[]','2026-09-01');
 INSERT INTO app_private.bank_event_sources VALUES('${source}',NULL,'DEMO source',NULL);
 SELECT set_config('fixture.actor','${actor}',false),set_config('fixture.admin','yes',false),set_config('fixture.building','yes',false),set_config('fixture.role','authenticated',false);`);
 await db.exec(sql);
 await rpc('save_rule',input);
},30000);
afterAll(()=>db.close());
describe('real reconciliation SQL',()=>{
 it('isolates org membership and building scope',()=>rollback(async()=>{
  await expect(rpc('settings',{},uid(100))).rejects.toThrow(/quyền/);
  await event(30); await db.exec("select set_config('fixture.building','no',true)");
  expect((await rpc('detail',{eventId:uid(30)})).candidates).toEqual([]);
 }));
 it('reads settings, route and filtered transactions',()=>rollback(async()=>{
  await event(31);const settings=await rpc('settings');expect(settings.books).toHaveLength(1);
  const rows=(await rpc('list',{accountId:account,minAmount:99999,maxAmount:100001})).events as {book:string;state:string}[];
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({book:'DEMO Bank',state:'pending'});
 }));
 it('uses only the invoice contract representative and exact threshold',()=>rollback(async()=>{
  for(const [n,amt] of [[32,100000],[33,90000],[34,110000],[35,89999],[36,110001]])await event(n,amt);
  for(const n of [32,33,34])expect((await rpc('detail',{eventId:uid(n)})).candidates).toHaveLength(1);
  for(const n of [35,36])expect((await rpc('detail',{eventId:uid(n)})).candidates).toEqual([]);
  await db.exec(`UPDATE contract_customers SET is_representative=false;`);
  expect((await rpc('detail',{eventId:uid(32)})).candidates).toEqual([]);
 }));
 it('excludes outgoing, future-issued, deposit and wrong TK/TT invoices',()=>rollback(async()=>{
  await event(37,100000,'tien coc phong A01');await event(38,100000,'KHACH MAU',{direction:'out'});
  for(const n of [37,38])expect((await rpc('detail',{eventId:uid(n)})).candidates).toEqual([]);
  await event(39);await db.exec("UPDATE invoices SET issue_date='2026-10-02'");expect((await rpc('detail',{eventId:uid(39)})).candidates).toEqual([]);
  await db.exec("UPDATE invoices SET issue_date='2026-10-01'; UPDATE app_private.bank_reconciliation_rules SET method='TT'");expect((await rpc('detail',{eventId:uid(39)})).candidates).toEqual([]);
 }));
 it('blocks ambiguous routing and stale config writes',()=>rollback(async()=>{
  await event(40);await rpc('save_rule',{...input,id:uid(21),method:'TT'});
  expect((await rpc('detail',{eventId:uid(40)})).routeCount).toBe(2);
  expect((await rpc('list')).events).toEqual([expect.objectContaining({accountId:null,book:null,method:null,state:'conflict'})]);
  expect((await rpc('list',{method:'TK'})).events).toEqual([]);
  await expect(rpc('collect',action(40))).rejects.toThrow(/Nguồn/);
 }));
 it('collects once, blocks retry and cross-channel duplicate',()=>rollback(async()=>{
  await event(41);await event(42);
  expect(await rpc('collect',action(41))).toMatchObject({saved:true,revision:1});
  await expect(rpc('collect',action(41))).rejects.toThrow(/xử lý/);
  await expect(rpc('collect',action(42))).rejects.toThrow(/trùng/);
  expect((await db.query('select * from invoice_payment_collections')).rows).toHaveLength(1);
 }));
 it('requires explicit excess choice and revalidates invoice revisions',()=>rollback(async()=>{
  await event(43,105000);await expect(rpc('collect',action(43))).rejects.toThrow(/tiền dư/);
 }));
 it('rejects stale invoice before creating money',()=>rollback(async()=>{
  await event(44);await expect(rpc('collect',action(44,{expectedPaid:1}))).rejects.toThrow(/thay đổi/);
  await expect(rpc('collect',action(44,{expectedRemaining:95000,overpayAction:'CREDIT'}))).rejects.toThrow(/thay đổi/);
 }));
 it('classifies other and undoes without creating a receipt',()=>rollback(async()=>{
  await event(45);expect(await rpc('classify',action(45,{state:'other'}))).toMatchObject({revision:1});
  expect(await rpc('undo',action(45,{revision:1}))).toMatchObject({revision:2});
  expect((await db.query('select * from invoice_payment_collections')).rows).toEqual([]);
 }));
 it('authenticated users cannot cache forged money facts',()=>rollback(async()=>{
  await expect(db.query('select bank_reconciliation_cache_v1($1,$2)',[uid(1),{amount:1,direction:'in'}])).rejects.toThrow(/Forbidden/);
 }));
 it('excludes a clear bare room code even when the amount matches',()=>rollback(async()=>{
  await db.query('insert into rooms values($1,$2,$3,NULL)',[uid(50),building,'A02']);
  await event(51,100000,'A02 TESTHOUSE tien phong');
  expect((await rpc('detail',{eventId:uid(51)})).candidates).toEqual([]);
 }));
 it('rejects undo of a pending event and short reasons before any writer',()=>rollback(async()=>{
  await event(52);await expect(rpc('undo',action(52))).rejects.toThrow(/trạng thái/);
  await expect(rpc('collect',action(52,{reason:'sai KH'}))).rejects.toThrow(/8 đến 500/);
  expect((await db.query('select * from invoice_payment_collections')).rows).toEqual([]);
  await rpc('collect',action(52));await rpc('undo',action(52,{revision:1}));
  expect((await db.query('select status from invoice_payment_collections')).rows).toEqual([{status:'REVERSED'}]);
 }));
 it('links an existing receipt and undo only removes its bank association',()=>rollback(async()=>{
  await event(53);
  const receipt=(await db.query<{id:string}>('insert into invoice_payment_collections(organization_id,invoice_id,status,collection_date,retained_amount) values($1,$2,\'ACTIVE\',\'2026-10-01\',100000) returning id',[org,invoice])).rows[0].id;
  await db.query('insert into invoice_payment_tenders(collection_id,account_id,payment_method,retained_amount) values($1,$2,\'TK\',100000)',[receipt,account]);
  await expect(rpc('collect',action(53))).rejects.toThrow(/phiếu thu/);
  expect(await rpc('link',action(53,{collectionId:receipt}))).toMatchObject({revision:1});
  await rpc('undo',action(53,{revision:1}));
  expect((await db.query('select status from invoice_payment_collections')).rows).toEqual([{status:'ACTIVE'}]);
  expect((await db.query('select paid_amount from invoices where id=$1',[invoice])).rows).toEqual([{paid_amount:'0'}]);
 }));
 it('rejects changed customer identity and old invoices carried into a newer bill',()=>rollback(async()=>{
  await event(54);
  await expect(rpc('collect',action(54,{customerId:uid(99)}))).rejects.toThrow(/thay đổi/);
  await db.query('insert into invoices(id,organization_id,status,previous_debt_sources) values($1,$2,\'APPROVED\',$3)',[uid(55),org,JSON.stringify([{type:'invoice',id:invoice,amount:100000}])]);
  expect((await rpc('detail',{eventId:uid(54)})).candidates).toEqual([]);
 }));
 it('rolls back the money writer if saving the reconciliation decision fails',()=>rollback(async()=>{
  await event(56);
  await db.exec(`CREATE FUNCTION app_private.fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture decision failure'; END $$;
   CREATE TRIGGER fixture_decision_failure BEFORE INSERT ON app_private.bank_reconciliation_decisions FOR EACH ROW EXECUTE FUNCTION app_private.fixture_failure();`);
  await expect(rpc('collect',action(56))).rejects.toThrow(/fixture decision failure/);
  expect((await db.query('select * from invoice_payment_collections')).rows).toEqual([]);
  expect((await db.query('select paid_amount from invoices where id=$1',[invoice])).rows).toEqual([{paid_amount:'0'}]);
 }));
 it('does not grant authenticated clients direct access to private facts',()=>rollback(async()=>{
  await db.exec('SET LOCAL ROLE authenticated');
  await expect(db.query('select * from app_private.bank_reconciliation_facts')).rejects.toThrow(/permission denied/);
 }));
 it('uses the current book and method after undo, while preserving active decisions',()=>rollback(async()=>{
  await event(57);await rpc('classify',action(57,{state:'other'}));
  await db.query('insert into accounts values($1,$2,\'Other DEMO Bank\',NULL,false,\'DEMO\',\'1111111111\')',[uid(58),org]);
  await rpc('save_rule',{...input,revision:1,accountId:uid(58),method:'TT'});
  expect((await rpc('list')).events).toEqual([expect.objectContaining({accountId:account,method:'TK',state:'other'})]);
  await rpc('undo',action(57,{revision:1}));
  expect((await rpc('list',{accountId:uid(58),method:'TT'})).events).toEqual([expect.objectContaining({accountId:uid(58),method:'TT',book:'Other DEMO Bank',state:'reversed'})]);
  expect((await rpc('list',{accountId:account})).events).toEqual([]);
  await expect(rpc('classify',action(57,{revision:2,state:'other'}))).rejects.toThrow(/Cấu hình nguồn/);
  expect(await rpc('classify',action(57,{revision:2,accountId:uid(58),method:'TT',state:'other'}))).toMatchObject({revision:3});
  await rpc('undo',action(57,{revision:3}));
  await rpc('save_rule',{...input,id:uid(59)});
  expect((await rpc('list')).events).toEqual([expect.objectContaining({accountId:null,method:null,book:null,state:'reversed'})]);
  expect((await rpc('detail',{eventId:uid(57)})).routeCount).toBe(2);
 }));
});
