import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

const migration = 'supabase/migrations/20260928015735_room_turnover_workflow.sql';
const sql = existsSync(migration)?readFileSync(migration,'utf8'):'';
const db = new PGlite();
const org='dddd0000-0000-4000-8000-000000000001',other='dddd0000-0000-4000-8000-000000000002';
const actor='00000000-0000-4000-8000-000000000010',building='00000000-0000-4000-8000-000000000011';
const room='00000000-0000-4000-8000-000000000012',sourceA='00000000-0000-4000-8000-000000000013',sourceB='00000000-0000-4000-8000-000000000014';

beforeAll(async()=>{
  await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;
    CREATE SCHEMA auth;CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES ('${actor}');
    CREATE TABLE organizations(id uuid PRIMARY KEY,status text DEFAULT 'ACTIVE');
    INSERT INTO organizations VALUES ('${org}'),('${other}');
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,name text DEFAULT 'Toà A',deleted_at timestamptz);
    INSERT INTO buildings(id,organization_id) VALUES ('${building}','${org}');
    CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,name text DEFAULT '101',status text DEFAULT 'AVAILABLE',updated_at timestamptz DEFAULT '2026-09-01',deleted_at timestamptz,UNIQUE(organization_id,id));
    INSERT INTO rooms(id,organization_id,building_id) VALUES ('${room}','${org}','${building}');
    CREATE TABLE contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,status text DEFAULT 'TERMINATED',actual_end_date date DEFAULT '2026-09-27',deleted_at timestamptz);
    INSERT INTO contracts(id,organization_id,room_id) VALUES ('${sourceA}','${org}','${room}'),('${sourceB}','${org}','${room}');
    CREATE TABLE organization_memberships(id uuid DEFAULT gen_random_uuid(),organization_id uuid,user_id uuid,status text DEFAULT 'ACTIVE',valid_from timestamptz DEFAULT '2026-01-01',valid_to timestamptz);
    INSERT INTO organization_memberships(organization_id,user_id) VALUES ('${org}','${actor}');
    CREATE TABLE test_money(id int PRIMARY KEY,amount numeric);INSERT INTO test_money VALUES (1,4000000);
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY['${org}','${other}']::uuid[] $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY[]::uuid[] $$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.access',true)='yes' $$;
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql STABLE AS $$ SELECT '2026-09-28'::date $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean)
      LANGUAGE sql AS $$ SELECT $1=auth.uid() AND $2='${org}' AND $3='rooms.edit' AND current_setting('test.edit',true)='yes' $$;
    CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[]) LANGUAGE sql STABLE AS $$ SELECT false,CASE WHEN $1='rooms.view' AND current_setting('test.view',true)='yes' THEN ARRAY['${building}']::uuid[] ELSE ARRAY[]::uuid[] END,ARRAY[]::uuid[] $$;
    GRANT USAGE ON SCHEMA auth,app_private TO authenticated;GRANT SELECT ON rooms,buildings TO authenticated;
  `);
  await db.exec(sql);await db.exec(sql);
},30000);
afterAll(()=>db.close());
beforeEach(async()=>{
  await db.exec(`SELECT set_config('test.actor','${actor}',false),set_config('test.access','yes',false),set_config('test.view','yes',false),set_config('test.edit','yes',false);
    DELETE FROM room_turnover_events;DELETE FROM room_turnovers;
    UPDATE contracts SET status='TERMINATED',actual_end_date='2026-09-27',organization_id='${org}';
    UPDATE rooms SET status='AVAILABLE';UPDATE organization_memberships SET status='ACTIVE';`);
});
const payload=(fields:Record<string,unknown>={})=>({status:'PENDING',expected_ready_on:null,responsible_user_id:null,source_contract_id:sourceA,reason:'Dọn phòng',start_new_cycle:false,...fields});
const save=(version=0,fields:Record<string,unknown>={},organization=org)=>db.query<{result:{turnover:{version:number;epoch:number;status:string};history:unknown[];today:string}}>(
  'SELECT save_room_turnover_v1($1,$2,$3,$4) AS result',[organization,room,version,JSON.stringify(payload(fields))]);
const read=()=>db.query<{result:{turnover:unknown;history:unknown[]}}>('SELECT read_room_turnover_v1($1,$2) AS result',[org,room]);
const queue=()=>db.query<{result:{today:string;total:number;items:Array<{expected_ready_on:string|null}>}}>('SELECT list_room_turnover_queue_v1($1) AS result',[org]);

it('reapplies twice and saves work with no date or assignee without changing occupancy, room timestamp or money',async()=>{
  const before=(await db.query('SELECT status,updated_at FROM rooms')).rows;
  const result=(await save()).rows[0]!.result;
  expect(result.turnover).toMatchObject({version:1,epoch:1,status:'PENDING',expected_ready_on:null,responsible_user_id:null});
  expect((await db.query('SELECT status,updated_at FROM rooms')).rows).toEqual(before);
  expect((await db.query('SELECT * FROM test_money')).rows).toEqual([{id:1,amount:'4000000'}]);
});
it('CAS rejects a second initial create and a stale edit while keeping one current work per room',async()=>{
  await save();await expect(save()).rejects.toMatchObject({code:'PT409'});
  await save(1,{expected_ready_on:'2026-10-01'});
  await expect(save(1,{expected_ready_on:'2026-10-02'})).rejects.toMatchObject({code:'PT409'});
  expect((await db.query('SELECT count(*)::int AS count FROM room_turnovers')).rows[0]).toEqual({count:1});
});
it('separates a new vacant phase from a READY old phase and retains actor, reason and old/new audit',async()=>{
  await save();await save(1,{status:'READY'});
  await save(2,{source_contract_id:sourceB,start_new_cycle:true,reason:'Đợt khách tiếp theo'});
  const state=(await read()).rows[0]!.result;
  expect(state.turnover).toMatchObject({epoch:2,version:3,source_contract_id:sourceB,status:'PENDING'});
  expect(state.history).toHaveLength(3);
  expect(state.history[0]).toMatchObject({epoch:2,actor_id:actor,reason:'Đợt khách tiếp theo',previous_state:{epoch:1,source_contract_id:sourceA,status:'READY'},new_state:{epoch:2,source_contract_id:sourceB,status:'PENDING'}});
  await expect(save(3,{source_contract_id:sourceA})).rejects.toMatchObject({code:'55000'});
});
it('persists missing/due/overdue work across reads and removes only READY work from the action queue',async()=>{
  await save();expect((await queue()).rows[0]!.result).toMatchObject({today:'2026-09-28',total:1,items:[{expected_ready_on:null}]});
  await read();await queue();expect((await queue()).rows[0]!.result.total).toBe(1);
  await save(1,{expected_ready_on:'2026-09-27'});expect((await queue()).rows[0]!.result.total).toBe(1);
  await save(2,{expected_ready_on:'2026-10-01'});expect((await queue()).rows[0]!.result.total).toBe(0);
  await save(3,{status:'READY'});expect((await queue()).rows[0]!.result.total).toBe(0);
});
it('denies wrong selected org, absent auth/building/edit/view and cross-org responsibility/source',async()=>{
  await expect(save(0,{},other)).rejects.toMatchObject({code:'42501'});
  await expect(db.query('SELECT read_room_turnover_v1($1,$2)',[other,room])).rejects.toMatchObject({code:'42501'});
  for(const [key,value] of [['test.actor',''],['test.access','no'],['test.edit','no']]){
    await db.query('SELECT set_config($1,$2,false)',[key,value]);await expect(save()).rejects.toMatchObject({code:'42501'});
    await db.exec(`SELECT set_config('test.actor','${actor}',false),set_config('test.access','yes',false),set_config('test.edit','yes',false)`);
  }
  await db.exec("SELECT set_config('test.view','no',false)");await expect(read()).rejects.toMatchObject({code:'42501'});
  await db.exec("SELECT set_config('test.view','yes',false);UPDATE organization_memberships SET status='REVOKED'");
  await expect(save(0,{responsible_user_id:actor})).rejects.toMatchObject({code:'42501'});
  await db.exec(`UPDATE contracts SET organization_id='${other}'`);await expect(save()).rejects.toMatchObject({code:'42501'});
});
it('refuses a new work cycle for an occupied room and refuses invalid date or missing reason',async()=>{
  await db.exec(`UPDATE contracts SET status='ACTIVE',actual_end_date=NULL WHERE id='${sourceA}'`);
  await expect(save(0,{source_contract_id:null})).rejects.toMatchObject({code:'55000'});
  await db.exec("UPDATE contracts SET status='TERMINATED',actual_end_date='2026-09-27'");
  await expect(save(0,{expected_ready_on:'2026-02-30'})).rejects.toMatchObject({code:'22023'});
  await expect(save(0,{reason:' '})).rejects.toMatchObject({code:'22023'});
});
it('rolls back the work change when audit fails and denies direct client writes',async()=>{
  await db.exec("ALTER TABLE room_turnover_events ADD CONSTRAINT test_audit_failure CHECK(reason IS DISTINCT FROM 'fail-audit')");
  try{await expect(save(0,{reason:'fail-audit'})).rejects.toMatchObject({code:'23514'});
    expect((await db.query('SELECT * FROM room_turnovers')).rows).toEqual([]);
  }finally{await db.exec('ALTER TABLE room_turnover_events DROP CONSTRAINT test_audit_failure');}
  await save();await db.exec('SET ROLE authenticated');
  try{await expect(db.exec("UPDATE room_turnovers SET status='READY'")).rejects.toMatchObject({code:'42501'});
    await expect(db.exec('DELETE FROM room_turnover_events')).rejects.toMatchObject({code:'42501'});
  }finally{await db.exec('RESET ROLE');}
});
