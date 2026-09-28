import { existsSync,readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
const path='supabase/migrations/20260928023413_contract_meter_boundaries.sql';
const org='00000000-0000-4000-8000-000000000001',actor='00000000-0000-4000-8000-000000000002',room='00000000-0000-4000-8000-000000000003',building='00000000-0000-4000-8000-000000000004',meter='00000000-0000-4000-8000-000000000005',a='00000000-0000-4000-8000-000000000006',b='00000000-0000-4000-8000-000000000007';
const db=new PGlite();
beforeAll(async()=>{
  await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA app_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES('${actor}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
    CREATE TABLE organizations(id uuid PRIMARY KEY);INSERT INTO organizations VALUES('${org}');
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid);INSERT INTO buildings VALUES('${building}','${org}');
    CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,status text);INSERT INTO rooms VALUES('${room}','${org}','${building}','AVAILABLE');
    CREATE TABLE contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,status text,deleted_at timestamptz,start_date date,actual_end_date date,created_at timestamptz DEFAULT now());
    INSERT INTO contracts(id,organization_id,room_id,status,deleted_at,start_date,actual_end_date) VALUES('${a}','${org}','${room}','TERMINATED',NULL,'2026-01-01','2026-09-28'),('${b}','${org}','${room}','ACTIVE',NULL,'2026-09-28',NULL);
    CREATE TABLE meters(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,building_id uuid,status text,deleted_at timestamptz,code text,meter_type text);
    INSERT INTO meters VALUES('${meter}','${org}','${room}','${building}','ACTIVE',NULL,'E1','ELECTRICITY');
    CREATE TABLE meter_readings(id uuid PRIMARY KEY,meter_id uuid,contract_id uuid,organization_id uuid,room_id uuid,building_id uuid);
    CREATE TABLE invoices(id uuid PRIMARY KEY,organization_id uuid,contract_id uuid,billing_month text,status text,approved_at timestamptz,deleted_at timestamptz);
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY['${org}'::uuid] $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${building}'::uuid AND coalesce(current_setting('test.denied',true),'')<>'yes' $$;
    CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT can_access_building($3) AND NOT ($2='edit' AND coalesce(current_setting('test.create_only',true),'')='yes') $$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY[]::uuid[] $$;
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql AS $$ SELECT '2026-09-28'::date $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN PERFORM 1 FROM organizations WHERE id=$1 FOR NO KEY UPDATE;RETURN 1;END $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$ SELECT $1=auth.uid() AND $2=ANY(my_org_ids()) AND $3 IN ('contracts.edit','contracts.create') AND can_do_on_building('contracts',split_part($3,'.',2),$4) $$;
  `);
  if(existsSync(path)){await db.exec(readFileSync(path,'utf8'));await db.exec(readFileSync(path,'utf8'));}
},30000);
afterAll(()=>db.close());
async function tx(fn:()=>Promise<void>){await db.exec('BEGIN');try{await fn();}finally{await db.exec('ROLLBACK');}}
async function record(contract:string,kind:string,payload:unknown){return (await db.query<{result:Record<string,unknown>}>('SELECT app_private.record_contract_meter_boundary_set_v1($1,$2,$3,$4,$5,$6::jsonb) AS result',[org,contract,room,kind,'2026-09-28',JSON.stringify(payload)])).rows[0].result;}
const incoming={state:'VERIFIED',reason:null,readings:[{meter_id:meter,reading:0,measured_at:'2026-09-28T09:00:00+07:00',evidence:'Đã xác minh bàn giao'}]};
async function denied(fn:()=>Promise<unknown>,code:string){await db.exec('SAVEPOINT denied');try{await expect(fn()).rejects.toMatchObject({code});}finally{await db.exec('ROLLBACK TO SAVEPOINT denied;RELEASE SAVEPOINT denied');}}
describe('B1 handover boundary SQL',()=>{
  it('exists and applies twice',()=>expect(existsSync(path)).toBe(true));
  it('records missing outgoing A without touching room/contract/readings or any charge',()=>tx(async()=>{
    const before=(await db.query('SELECT to_jsonb(c) FROM contracts c')).rows;
    const result=await record(a,'MOVE_OUT',{state:'MISSING',reason:'Chưa đo',readings:[]});expect(result).toMatchObject({state:'MISSING',revision:1,readings:[{meter_id:meter,reading:null,state:'MISSING'}]});
    expect((await db.query('SELECT to_jsonb(c) FROM contracts c')).rows).toEqual(before);
    expect((await db.query<{n:number}>('SELECT count(*)::int AS n FROM meter_readings')).rows[0].n).toBe(0);
    expect((await db.query<{status:string}>('SELECT status FROM rooms')).rows[0].status).toBe('AVAILABLE');
    await denied(()=>db.query('SELECT app_private.assert_contract_move_in_boundaries_v1($1,$2)',[org,b]),'55000');
  }));
  it('requires B own complete verified incoming reading; zero is valid and A stays missing',()=>tx(async()=>{
    const out=await record(a,'MOVE_OUT',{state:'MISSING',reason:'Chưa đo',readings:[]});
    await denied(()=>record(b,'MOVE_IN',{state:'VERIFIED',readings:[]}), '22023');
    const start=await record(b,'MOVE_IN',incoming);expect(start).toMatchObject({state:'VERIFIED',readings:[{reading:0,state:'VERIFIED'}]});
    await db.query('SELECT app_private.assert_contract_move_in_boundaries_v1($1,$2)',[org,b]);
    expect((await db.query<{result:Record<string,unknown>}>('SELECT read_contract_meter_boundary_set_v1($1,$2,$3) AS result',[org,a,'MOVE_OUT'])).rows[0].result).toEqual(out);
    expect(await record(b,'MOVE_IN',incoming)).toEqual(start);
    await denied(()=>record(b,'MOVE_IN',{...incoming,readings:[{...incoming.readings[0],reading:10}]}),'23505');
  }));
  it('isolates meter/room/org and scopes reads/replay after revoked access',()=>tx(async()=>{
    await denied(()=>record(b,'MOVE_IN',{...incoming,readings:[{...incoming.readings[0],meter_id:a}]}),'42501');
    const start=await record(b,'MOVE_IN',incoming);
    await denied(()=>db.query('SELECT read_contract_meter_boundary_set_v1($1,$2,$3)',[a,b,'MOVE_IN']),'42501');
    await db.exec("SET LOCAL test.denied='yes'");await denied(()=>record(b,'MOVE_IN',incoming),'42501');
    await denied(()=>db.query('SELECT revise_contract_meter_boundary_set_v1($1,$2,$3,$4,$5,$6::jsonb)',[org,start.id,1,'meter-key-0001','Correction',JSON.stringify(incoming)]),'42501');
  }));
  it('late revision uses CAS/history/replay and marks issued invoice impact REVIEW without updating debt',()=>tx(async()=>{
    const start=await record(b,'MOVE_IN',incoming);
    await db.exec(`INSERT INTO invoices VALUES('${a}','${org}','${b}','2026-09','APPROVED',now(),NULL)`);
    const invoiceBefore=(await db.query('SELECT to_jsonb(i) FROM invoices i')).rows;
    const args=[org,start.id,1,'meter-key-0001','Correct reading',JSON.stringify({...incoming,readings:[{...incoming.readings[0],reading:5}]})];
    const revised=(await db.query<{result:Record<string,unknown>}>('SELECT revise_contract_meter_boundary_set_v1($1,$2,$3,$4,$5,$6::jsonb) AS result',args)).rows[0].result;
    expect(revised).toMatchObject({state:'REVIEW',revision:2,affected_invoice_ids:[a],readings:[{reading:5,state:'REVIEW'}]});
    expect((await db.query('SELECT to_jsonb(i) FROM invoices i')).rows).toEqual(invoiceBefore);
    expect((await db.query<{result:unknown}>('SELECT revise_contract_meter_boundary_set_v1($1,$2,$3,$4,$5,$6::jsonb) AS result',args)).rows[0].result).toEqual(revised);
    await denied(()=>db.query('SELECT revise_contract_meter_boundary_set_v1($1,$2,$3,$4,$5,$6::jsonb)',[org,start.id,1,'meter-key-0002','Correction',JSON.stringify(incoming)]),'PT409');
    await denied(()=>db.query('SELECT app_private.assert_contract_move_in_boundaries_v1($1,$2)',[org,b]),'55000');
  }));
  it('interval reader uses B own incoming boundary and never substitutes A or latest global meter',()=>tx(async()=>{
    await record(a,'MOVE_OUT',{state:'VERIFIED',readings:[{...incoming.readings[0],reading:100,measured_at:'2026-09-28T08:00:00+07:00'}]});
    await record(b,'MOVE_IN',incoming);
    const result=(await db.query<{result:Record<string,unknown>}>('SELECT read_contract_meter_interval_v1($1,$2,$3,$4) AS result',[org,b,meter,'2026-09-28T10:00:00+07:00'])).rows[0].result;
    expect(result).toMatchObject({contract_id:b,meter_id:meter,predecessor:{reading:0,kind:'MOVE_IN'},state:'VERIFIED'});
    await denied(()=>db.query('SELECT read_contract_meter_interval_v1($1,$2,$3,$4)',[org,b,meter,'2026-09-28T08:00:00+07:00']),'55000');
  }));
  it('preserves create-only authority for fresh B in the signing transaction without permitting existing B edits',()=>tx(async()=>{
    await db.exec("SET LOCAL test.create_only='yes'");
    await denied(()=>record(b,'MOVE_IN',incoming),'42501');
    await denied(()=>db.query('SELECT app_private.record_contract_meter_boundary_set_v1($1,$2,$3,$4,$5,$6::jsonb,$7)',[org,b,room,'MOVE_IN','2026-09-28',JSON.stringify(incoming),'contracts.create']),'42501');
    await db.exec(`UPDATE contracts SET status='ACTIVE' WHERE id='${b}'`);
    await denied(()=>db.query('SELECT app_private.record_contract_meter_boundary_set_v1($1,$2,$3,$4,$5,$6::jsonb,$7)',[org,b,room,'MOVE_IN','2026-09-28',JSON.stringify(incoming),'contracts.create']),'42501');
    const fresh='00000000-0000-4000-8000-000000000009';
    await db.exec('SAVEPOINT core_create');
    await db.exec(`INSERT INTO contracts(id,organization_id,room_id,status,start_date) VALUES('${fresh}','${org}','${room}','ACTIVE','2026-09-28')`);
    await db.exec('RELEASE SAVEPOINT core_create');
    await db.query('SELECT app_private.record_contract_meter_boundary_set_v1($1,$2,$3,$4,$5,$6::jsonb,$7)',[org,fresh,room,'MOVE_IN','2026-09-28',JSON.stringify(incoming),'contracts.create']);
    await db.query('SELECT app_private.assert_contract_move_in_boundaries_v1($1,$2,$3)',[org,fresh,'contracts.create']);
  }));
  it('keeps physical rows/history immutable and rejects cross-contract monthly references; readers work read-only',()=>tx(async()=>{
    const start=await record(b,'MOVE_IN',incoming);
    const readings=start.readings as {id:string}[];
    await denied(()=>db.query('UPDATE contract_meter_boundaries SET reading=999 WHERE set_id=$1',[start.id]),'42501');
    await denied(()=>db.query('DELETE FROM contract_meter_boundary_sets WHERE id=$1',[start.id]),'42501');
    await denied(()=>db.query('INSERT INTO meter_readings(id,organization_id,contract_id,room_id,building_id,meter_id,boundary_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[a,org,a,room,building,meter,readings[0].id]),'42501');
    expect((await db.query<{allowed:boolean;helper:boolean}>("SELECT has_table_privilege('authenticated','contract_meter_boundaries','SELECT') AS allowed,has_function_privilege('authenticated','app_private.record_contract_meter_boundary_set_v1(uuid,uuid,uuid,text,date,jsonb,text)','EXECUTE') AS helper")).rows[0]).toEqual({allowed:false,helper:false});
    await db.exec('GRANT INSERT ON meter_readings TO authenticated; SET LOCAL ROLE authenticated');
    await db.query('INSERT INTO meter_readings(id,organization_id,contract_id,room_id,building_id,meter_id,boundary_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[a,org,b,room,building,meter,readings[0].id]);
  }));
  it('does not invent a verified outgoing interval when the return reading is missing or the meter rolls backwards',()=>tx(async()=>{
    await record(b,'MOVE_IN',incoming);
    await db.exec(`UPDATE contracts SET status='TERMINATED',actual_end_date='2026-09-28' WHERE id='${b}'`);
    const out=await record(b,'MOVE_OUT',{state:'MISSING',reason:'Không có số',readings:[]});
    await denied(()=>db.query('SELECT read_contract_meter_interval_v1($1,$2,$3,$4)',[org,b,meter,'2026-09-28T10:00:00+07:00']),'55000');
    await db.query('SELECT revise_contract_meter_boundary_set_v1($1,$2,$3,$4,$5,$6::jsonb)',[org,out.id,1,'meter-out-key-0001','Đã đo',JSON.stringify({...incoming,readings:[{...incoming.readings[0],reading:10,measured_at:'2026-09-28T09:30:00+07:00'}]})]);
    await denied(()=>db.query('SELECT read_contract_meter_interval_v1($1,$2,$3,$4)',[org,b,meter,'2026-09-28T10:00:00+07:00']),'55000');
  }));
  it('readers run in a read-only transaction without authorization row locks',async()=>{
    await db.exec('BEGIN READ ONLY');
    try {expect((await db.query<{result:unknown}>('SELECT read_contract_meter_boundary_set_v1($1,$2,$3) AS result',[org,b,'MOVE_IN'])).rows[0].result).toBeNull();}
    finally{await db.exec('ROLLBACK');}
  });
});
