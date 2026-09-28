import { existsSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const path = 'supabase/migrations/20260928013138_contract_moveout_notice_workflow.sql';
const sql = existsSync(path) ? readFileSync(path, 'utf8') : '';
const db = new PGlite();
const org = 'dddd0000-0000-4000-8000-000000000001';
const other = 'dddd0000-0000-4000-8000-000000000002';
const actor = '00000000-0000-4000-8000-000000000010';
const building = '00000000-0000-4000-8000-000000000011';
const room = '00000000-0000-4000-8000-000000000012';
const contract = '00000000-0000-4000-8000-000000000013';
const version = '2026-09-27T18:00:00.123456Z';

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
    CREATE TABLE public.organizations(id uuid PRIMARY KEY,status text DEFAULT 'ACTIVE');
    CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz,name text DEFAULT 'Toà A');
    CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,deleted_at timestamptz,status text DEFAULT 'OCCUPIED',name text DEFAULT '101');
    CREATE TABLE public.contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,status text DEFAULT 'ACTIVE',
      start_date date DEFAULT '2026-09-01',actual_end_date date,deleted_at timestamptz,
      expected_move_out_date date, updated_at timestamptz,notes text DEFAULT 'Ghi chú hợp đồng',rent_price numeric DEFAULT 4000000,contract_number text DEFAULT 'HD01');
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT current_setting('test.access',true)='yes' $$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT ARRAY[]::uuid[] $$;
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$ SELECT CASE WHEN current_setting('test.multiorg',true)='yes' THEN ARRAY['${org}','${other}']::uuid[] ELSE ARRAY['${org}']::uuid[] END $$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)
      RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$ SELECT $1=auth.uid() AND $2='${org}' AND (($3='contracts.edit' AND current_setting('test.edit',true)='yes') OR $3='contracts.view') $$;
    CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[])
      LANGUAGE sql STABLE AS $$ SELECT false,CASE WHEN $1='contracts.view' AND ($2='${org}' OR current_setting('test.multiorg',true)='yes') AND current_setting('test.view',true)='yes' THEN ARRAY['${building}']::uuid[] ELSE ARRAY[]::uuid[] END, ARRAY[]::uuid[] $$;
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql AS $$ SELECT '2026-09-28'::date $$;
    INSERT INTO public.organizations VALUES ('${org}'),('${other}');
    INSERT INTO public.buildings(id,organization_id,deleted_at) VALUES ('${building}','${org}',NULL);
    INSERT INTO public.rooms(id,organization_id,building_id) VALUES ('${room}','${org}','${building}');
    INSERT INTO public.contracts(id,organization_id,room_id,updated_at) VALUES ('${contract}','${org}','${room}','${version}');
    GRANT USAGE ON SCHEMA auth,app_private TO authenticated;
    GRANT SELECT ON contracts,rooms TO authenticated;
  `);
  await db.exec(sql);
}, 30000);
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`SELECT set_config('test.actor','${actor}',false),set_config('test.access','yes',false),set_config('test.edit','yes',false),set_config('test.view','yes',false),set_config('test.multiorg','no',false);
    UPDATE public.contracts SET status='ACTIVE',actual_end_date=NULL,expected_move_out_date=NULL,updated_at='${version}';`);
});
const write = (date: string | null, reason: string | null = null, token = version, organization = org) => db.query<{ result: Record<string, unknown> }>(
  'SELECT public.set_contract_move_out_notice_v1($1,$2,$3,$4,$5) AS result', [organization, contract, token, date, reason]);

describe('notice RPC behavior in isolated PostgreSQL', () => {
  it('reports, edits, cancels and appends actor/date/old/new/reason without changing occupancy, notes or money', async () => {
    const first = (await write('2026-09-28','Khách báo')).rows[0]!.result;
    expect(first.today).toBe('2026-09-28');
    const second = (await write('2026-10-01','Khách đổi ngày',String(first.updated_at))).rows[0]!.result;
    await write(null,'Khách ở tiếp',String(second.updated_at));
    const history = (await db.query<{ previous_date: string | null; new_date: string | null; actor_id: string; reason: string }>(
      `SELECT previous_date::text,new_date::text,actor_id,reason FROM public.contract_move_out_notice_events WHERE contract_id='${contract}' ORDER BY created_at,id`)).rows;
    expect(history).toEqual([
      {previous_date:null,new_date:'2026-09-28',actor_id:actor,reason:'Khách báo'},
      {previous_date:'2026-09-28',new_date:'2026-10-01',actor_id:actor,reason:'Khách đổi ngày'},
      {previous_date:'2026-10-01',new_date:null,actor_id:actor,reason:'Khách ở tiếp'},
    ]);
    const state = (await db.query(`SELECT c.status,c.actual_end_date,c.notes,c.rent_price,r.status AS room_status FROM contracts c JOIN rooms r ON r.id=c.room_id`)).rows[0];
    expect(state).toEqual({status:'ACTIVE',actual_end_date:null,notes:'Ghi chú hợp đồng',rent_price:'4000000',room_status:'OCCUPIED'});
  });
  it('rejects a stale concurrent version with PT409 and preserves the winning date', async () => {
    await write('2026-09-29');
    await expect(write('2026-09-30')).rejects.toMatchObject({ code:'PT409' });
    expect((await db.query('SELECT expected_move_out_date::text AS date FROM contracts')).rows[0]).toEqual({date:'2026-09-29'});
  });
  it('rejects cross-organization, missing auth, absent building scope and absent edit permission', async () => {
    await expect(write('2026-09-29',null,version,other)).rejects.toMatchObject({code:'42501'});
    for (const [setting,value] of [['test.actor',''],['test.access','no'],['test.edit','no']]) {
      await db.query('SELECT set_config($1,$2,false)',[setting,value]);
      await expect(write('2026-09-29')).rejects.toMatchObject({code:'42501'});
      await db.exec(`SELECT set_config('test.actor','${actor}',false),set_config('test.access','yes',false),set_config('test.edit','yes',false)`);
    }
  });
  it('rejects contracts that no longer reside and dates before the contract starts', async () => {
    await expect(write('2026-08-31')).rejects.toMatchObject({code:'22023'});
    await db.exec("UPDATE contracts SET status='TERMINATED'");
    await expect(write('2026-09-29')).rejects.toMatchObject({code:'55000'});
  });
  it('keeps an overdue date in the read snapshot instead of deriving a vacant state', async () => {
    await write('2026-09-27');
    const data = (await db.query<{ result: Record<string, unknown> }>(
      'SELECT public.get_contract_move_out_notice_v1($1,$2) AS result',[org,contract])).rows[0]!.result;
    expect(data.expected_move_out_date).toBe('2026-09-27');
    expect(data.status).toBe('ACTIVE');
    expect(data.today).toBe('2026-09-28');
  });
  it('requires a cancellation reason and leaves the notice unchanged on failure', async () => {
    const first = (await write('2026-09-29')).rows[0]!.result;
    await expect(write(null,' ',String(first.updated_at))).rejects.toMatchObject({code:'22023'});
    expect((await db.query('SELECT expected_move_out_date::text AS date FROM contracts')).rows[0]).toEqual({date:'2026-09-29'});
  });
  it('lists due and overdue current notices with a server civil date and a total independent of pagination', async () => {
    await write('2026-09-27');
    const queue = async (limit = 25, offset = 0) => (await db.query<{ result: {today:string;total:number;items:unknown[]} }>(
      'SELECT public.list_due_contract_move_out_notices_v1($1,NULL,$2,$3) AS result',[org,limit,offset])).rows[0]!.result;
    expect(await queue()).toMatchObject({today:'2026-09-28',total:1,items:[{contract_id:contract,expected_move_out_date:'2026-09-27',room_name:'101',building_name:'Toà A'}]});
    expect(await queue(1,1)).toMatchObject({total:1,items:[]});
    await expect(queue(101)).rejects.toMatchObject({code:'22023'});
    await db.exec("UPDATE contracts SET status='TERMINATED'");
    expect(await queue()).toMatchObject({total:0,items:[]});
  });
  it('requires contracts.view for both readers and hides events when that scope is absent', async () => {
    await write('2026-09-29');
    await db.exec("SELECT set_config('test.view','no',false)");
    await expect(db.query('SELECT public.get_contract_move_out_notice_v1($1,$2)',[org,contract])).rejects.toMatchObject({code:'42501'});
    const queue = (await db.query<{result:{total:number}}>('SELECT public.list_due_contract_move_out_notices_v1($1) AS result',[org])).rows[0]!.result;
    expect(queue.total).toBe(0);
    await db.exec('SET ROLE authenticated');
    try {
      expect((await db.query('SELECT id FROM contract_move_out_notice_events')).rows).toEqual([]);
      await expect(db.query('DELETE FROM contract_move_out_notice_events')).rejects.toMatchObject({code:'42501'});
    } finally { await db.exec('RESET ROLE'); }
  });
  it('rolls the notice update back if the audit insert fails', async () => {
    await db.exec("ALTER TABLE contract_move_out_notice_events ADD CONSTRAINT test_audit_failure CHECK(reason IS DISTINCT FROM 'fail-audit')");
    try {
      await expect(write('2026-09-29','fail-audit')).rejects.toMatchObject({code:'23514'});
      expect((await db.query('SELECT expected_move_out_date FROM contracts')).rows[0]).toEqual({expected_move_out_date:null});
    } finally { await db.exec('ALTER TABLE contract_move_out_notice_events DROP CONSTRAINT test_audit_failure'); }
  });
  it('rejects a contract from the wrong selected organization even for a member of both organizations', async () => {
    await db.exec("SELECT set_config('test.multiorg','yes',false)");
    await expect(db.query('SELECT public.get_contract_move_out_notice_v1($1,$2)',[other,contract])).rejects.toMatchObject({code:'42501'});
  });
});
