import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll,afterAll,beforeEach,afterEach,expect,it } from 'vitest';
import { buildRenewNoticeArgs,buildTransferRoomNoticeArgs } from '../noticeTransitions';
const id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
const [org,user,building,room,newRoom,contract]=[1,2,3,4,5,6].map(id);const at='2026-09-28T00:00:00+00:00';const db=new PGlite();
beforeAll(async()=>{
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT '${user}'::uuid$$;
    CREATE TABLE organizations(id uuid PRIMARY KEY);INSERT INTO organizations VALUES('${org}');
    CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid);INSERT INTO buildings VALUES('${building}','${org}');
    CREATE TABLE rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid);INSERT INTO rooms VALUES('${room}','${org}','${building}'),('${newRoom}','${org}','${building}');
    CREATE TABLE contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,expected_move_out_date date,updated_at timestamptz,deleted_at timestamptz,end_date date,status text);
    INSERT INTO contracts VALUES('${contract}','${org}','${room}','2026-10-01','${at}',null,'2026-12-31','ACTIVE');
    CREATE TABLE contract_move_out_notice_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,contract_id uuid,actor_id uuid,previous_date date,new_date date,reason text,contract_updated_at timestamptz);
    CREATE TABLE canonical_calls(operation text,args jsonb);
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$SELECT ARRAY['${org}'::uuid]$$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$SELECT '{}'::uuid[]$$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT $1='${building}'::uuid AND coalesce(current_setting('test.denied',true),'')<>'yes'$$;
    CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT public.can_access_building($3)$$;
    CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[]) LANGUAGE sql AS $$SELECT public.can_access_building('${building}'),ARRAY['${building}'::uuid]$$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid) RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$SELECT public.can_access_building($4) AND coalesce(current_setting('test.module_denied',true),'')<>'yes'$$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE plpgsql AS $$BEGIN RETURN;END$$;
    CREATE FUNCTION public.renew_contract(uuid,date,numeric DEFAULT null,numeric DEFAULT null,text DEFAULT null) RETURNS uuid LANGUAGE plpgsql AS $$BEGIN
      IF current_setting('test.fail',true)='yes' THEN RAISE EXCEPTION 'Existing core rejected' USING ERRCODE='22023';END IF;
      INSERT INTO canonical_calls VALUES('RENEW',jsonb_build_object('new_rent',$3,'new_deposit',$4,'notes',$5));UPDATE contracts SET end_date=$2,updated_at=clock_timestamp() WHERE id=$1;RETURN $1;END$$;
    CREATE FUNCTION public.transfer_room(uuid,uuid,numeric DEFAULT null,date DEFAULT current_date,text DEFAULT null) RETURNS uuid LANGUAGE plpgsql AS $$BEGIN
      IF current_setting('test.fail',true)='yes' THEN RAISE EXCEPTION 'Existing core rejected' USING ERRCODE='22023';END IF;
      INSERT INTO canonical_calls SELECT 'TRANSFER',jsonb_build_object('notice_seen_by_core',expected_move_out_date,'new_rent',$3,'date',$4,'notes',$5) FROM contracts WHERE id=$1;
      UPDATE contracts SET room_id=$2,updated_at=clock_timestamp() WHERE id=$1;RETURN $1;END$$;
  `);const sql=readFileSync('supabase/migrations/20260928035250_contract_notice_action_adapters.sql','utf8');await db.exec(sql);await db.exec(sql);
},30000);
afterAll(()=>db.close());beforeEach(()=>db.exec('BEGIN'));afterEach(()=>db.exec('ROLLBACK'));
const renew=(choice:string,key=id(20))=>db.query(`SELECT public.renew_contract_with_notice_v1($1,$2,$3,'2027-12-31',$4,$5,100,200,'Same notes','Notice decision')`,[org,contract,at,choice,key]);
async function rejects(run:()=>Promise<unknown>,code:string){await db.exec('SAVEPOINT failure');await expect(run()).rejects.toMatchObject({code});await db.exec('ROLLBACK TO SAVEPOINT failure');}
it('explicit KEEP retains the date and forwards existing renewal options untouched; exact replay invokes core once',async()=>{
  await renew('KEEP');await renew('KEEP');expect((await db.query<{expected_move_out_date:string}>('SELECT expected_move_out_date::text FROM contracts')).rows[0].expected_move_out_date).toBe('2026-10-01');
  expect((await db.query<{args:unknown}>('SELECT args FROM canonical_calls')).rows).toEqual([{args:{new_rent:100,new_deposit:200,notes:'Same notes'}}]);
  expect((await db.query<{notice_choice:string}>('SELECT notice_choice FROM contract_notice_transition_events')).rows[0].notice_choice).toBe('KEEP');
  expect((await db.query('SELECT * FROM contract_move_out_notice_events')).rows).toHaveLength(0);
});
it('CANCEL is atomic and keeps the existing cancellation event/actor/reason without a room operation',async()=>{
  await renew('CANCEL');expect((await db.query<{expected_move_out_date:string|null;room_id:string}>('SELECT expected_move_out_date,room_id FROM contracts')).rows[0]).toEqual({expected_move_out_date:null,room_id:room});
  expect((await db.query<{previous_date:string;new_date:null;actor_id:string;reason:string}>('SELECT previous_date::text,new_date,actor_id,reason FROM contract_move_out_notice_events')).rows[0]).toEqual({previous_date:'2026-10-01',new_date:null,actor_id:user,reason:'Notice decision'});
});
it('transfer clears the old-room notice before current core runs; same request cannot transfer twice',async()=>{
  const run=()=>db.query('SELECT public.transfer_room_with_notice_v1($1,$2,$3,$4,$5,$6,100,$7,$8)',[org,contract,at,newRoom,'2026-10-01',id(20),'Keep transfer notes','Hủy báo dọn phòng cũ']);
  await run();await run();expect((await db.query<{room_id:string;expected_move_out_date:null}>('SELECT room_id,expected_move_out_date FROM contracts')).rows[0]).toEqual({room_id:newRoom,expected_move_out_date:null});
  expect((await db.query<{args:Record<string,unknown>}>('SELECT args FROM canonical_calls')).rows).toEqual([{args:{notice_seen_by_core:null,new_rent:100,date:'2026-10-01',notes:'Keep transfer notes'}}]);
});
it('stale snapshots, invalid decisions, permission denial and cross-org never reach current core',async()=>{
  await rejects(()=>renew(''), '22023');await db.exec("SET test.module_denied='yes'");await rejects(()=>renew('KEEP'),'42501');await db.exec("SET test.module_denied=''");
  await db.exec(`UPDATE contracts SET updated_at=updated_at+interval '1 second'`);await rejects(()=>renew('KEEP'),'PT409');
  await db.exec("SET test.denied='yes'");await rejects(()=>renew('KEEP'),'42501');await db.exec("SET test.denied=''");
  await rejects(()=>db.query(`SELECT public.renew_contract_with_notice_v1($1,$2,$3,'2027-12-31','KEEP',$4)`,[id(99),contract,at,id(21)]),'42501');
  expect((await db.query('SELECT * FROM canonical_calls')).rows).toHaveLength(0);
});
it('current core failure rolls cancellation and audit back; adapter introduces no alternate renewal eligibility',async()=>{
  await db.exec("SET test.fail='yes'");await rejects(()=>renew('CANCEL'),'22023');
  expect((await db.query<{expected_move_out_date:string}>('SELECT expected_move_out_date::text FROM contracts')).rows[0].expected_move_out_date).toBe('2026-10-01');expect((await db.query('SELECT * FROM contract_move_out_notice_events')).rows).toHaveLength(0);
  await db.exec("SET test.fail=''");await db.exec("UPDATE contracts SET status='EXTENDED'");await renew('CANCEL');
});
it('builders require snapshot/decision/retry identity while preserving original money parameters',()=>{
  expect(buildRenewNoticeArgs({contractId:contract,expectedUpdatedAt:at,newEndDate:'2027-12-31',noticeChoice:'CANCEL',requestId:id(20),newRentPrice:100,newDeposit:200,notes:'Note'},org)).toMatchObject({p_notice_choice:'CANCEL',p_new_rent_price:100,p_new_deposit:200,p_expected_updated_at:at});
  expect(buildTransferRoomNoticeArgs({contractId:contract,expectedUpdatedAt:at,newRoomId:newRoom,transferDate:'2026-10-01',requestId:id(20),notes:'Note'},org)).toMatchObject({p_new_room_id:newRoom,p_notes:'Note'});
});
