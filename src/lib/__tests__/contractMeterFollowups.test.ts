import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, expect, it } from 'vitest';
const db = new PGlite();
const id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
beforeAll(async()=>{
  await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA app_private;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT '${id(1)}'::uuid$$;
  CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$SELECT ARRAY['${id(2)}'::uuid]$$;
  CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$SELECT COALESCE(current_setting('test.super_admin',true),'')='yes'$$;
  CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$SELECT ARRAY['${id(2)}'::uuid]$$;
  CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT $1='${id(3)}'::uuid$$;
  CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[]) LANGUAGE sql AS $$SELECT false,ARRAY['${id(3)}'::uuid]$$;
  CREATE TABLE contracts(id uuid,organization_id uuid,contract_number text,deleted_at timestamptz,status text);
  CREATE TABLE rooms(id uuid,organization_id uuid,name text,deleted_at timestamptz);
  CREATE TABLE buildings(id uuid,organization_id uuid,name text,deleted_at timestamptz);
  CREATE TABLE contract_meter_boundary_sets(id uuid,organization_id uuid,contract_id uuid,room_id uuid,building_id uuid,kind text,effective_on date,state text);
  INSERT INTO buildings VALUES('${id(3)}','${id(2)}','B',null),('${id(4)}','${id(2)}','Out of scope',null);
  INSERT INTO rooms VALUES('${id(5)}','${id(2)}','101',null);
  INSERT INTO contracts VALUES('${id(6)}','${id(2)}','OLD',null,'TERMINATED');
  INSERT INTO contract_meter_boundary_sets VALUES('${id(7)}','${id(2)}','${id(6)}','${id(5)}','${id(3)}','MOVE_OUT','2026-09-27','MISSING'),
   ('${id(8)}','${id(2)}','${id(6)}','${id(5)}','${id(4)}','MOVE_OUT','2026-09-27','MISSING'),
   ('${id(9)}','${id(2)}','${id(6)}','${id(5)}','${id(3)}','MOVE_IN','2026-09-27','VERIFIED');`);
  const sql=readFileSync('supabase/migrations/20260928035400_contract_meter_followups.sql','utf8');
  await db.exec(sql);await db.exec(sql);
},30_000);
afterAll(()=>db.close());
it('keeps missing outgoing readings visible independently of settlement and building outsiders hidden',async()=>{
  const r=(await db.query<{v:{total:number;items:{contract_id:string;state:string}[]}}>('SELECT public.list_contract_meter_followups_v1($1) v',[id(2)])).rows[0].v;
  expect(r.total).toBe(1);expect(r.items).toMatchObject([{contract_id:id(6),state:'MISSING'}]);
});
it('rejects other organization and bad pagination; authenticated reader cannot call via anon',async()=>{
  await expect(db.query('SELECT public.list_contract_meter_followups_v1($1)',[id(20)])).rejects.toMatchObject({code:'42501'});
  await expect(db.query('SELECT public.list_contract_meter_followups_v1($1,null,0,0)',[id(2)])).rejects.toMatchObject({code:'22023'});
  expect((await db.query<{allowed:boolean}>("SELECT has_function_privilege('anon','public.list_contract_meter_followups_v1(uuid,uuid[],integer,integer)','EXECUTE') allowed")).rows[0].allowed).toBe(false);
});
it('preserves the existing sandbox-admin exclusion of physical meter readers',async()=>{
  await db.exec("SET test.super_admin='yes'");
  try {expect((await db.query<{v:{total:number}}>('SELECT public.list_contract_meter_followups_v1($1) v',[id(2)])).rows[0].v.total).toBe(0);}
  finally {await db.exec("SET test.super_admin='no'");}
});
it('verified outgoing reading disappears; read never changes the old contract',async()=>{
  await db.exec(`UPDATE contract_meter_boundary_sets SET state='VERIFIED' WHERE id='${id(7)}'`);
  expect((await db.query<{v:{total:number}}>('SELECT public.list_contract_meter_followups_v1($1) v',[id(2)])).rows[0].v.total).toBe(0);
  expect((await db.query<{status:string}>('SELECT status FROM contracts')).rows[0].status).toBe('TERMINATED');
});
