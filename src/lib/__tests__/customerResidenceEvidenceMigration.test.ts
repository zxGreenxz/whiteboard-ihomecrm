import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from 'vitest';
const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const [org, actor, building, room, contract, customer, other, room2, hidden] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id);
const correction = 'supabase/migrations/20261007160000_customer_residence_evidence.sql';
const migration = 'supabase/migrations/20261007064802_customer_residence_history.sql';
beforeAll(async () => {
  await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA app_private;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT '${actor}'::uuid$$;
 CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$SELECT ARRAY['${org}'::uuid]$$;
 CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$SELECT $1<>'${hidden}' AND coalesce(current_setting('test.denied',true),'')<>'yes'$$;
 CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(current_setting('test.role_denied',true),'')<>'yes'$$;
 CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
 CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$SELECT '{}'::uuid[]$$;
 CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql AS $$SELECT '2026-10-07'::date$$;
 CREATE TYPE public.customer_status_v2 AS ENUM ('RENTING','MOVED_OUT','WALK_IN');CREATE TABLE customers(id uuid PRIMARY KEY,organization_id uuid,full_name text,deleted_at timestamptz,status_v2 public.customer_status_v2 DEFAULT 'WALK_IN',updated_at timestamptz,customer_type text DEFAULT 'INDIVIDUAL',is_foreign boolean DEFAULT false,phone text,email text,id_number text);
 CREATE TABLE profiles(id uuid PRIMARY KEY,full_name text);
 CREATE TABLE buildings(id uuid PRIMARY KEY,organization_id uuid,name text);
 CREATE TABLE rooms(id uuid PRIMARY KEY,building_id uuid,name text);
 CREATE TABLE contracts(id uuid PRIMARY KEY,organization_id uuid,room_id uuid,status text,contract_number text,start_date date,end_date date,actual_end_date date,created_at timestamptz DEFAULT now(),deleted_at timestamptz,notes text);
 CREATE TABLE contract_customers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contract_id uuid REFERENCES contracts(id) ON DELETE CASCADE,customer_id uuid REFERENCES customers(id),organization_id uuid,is_representative boolean DEFAULT false,notes text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(contract_id,customer_id));
 CREATE TABLE contract_draft_signings(id uuid PRIMARY KEY,organization_id uuid,contract_id uuid,party_snapshot jsonb,received_on date,signed_at timestamptz,signed_by uuid);
 CREATE TABLE contract_exit_cases(id uuid PRIMARY KEY,organization_id uuid,contract_id uuid,party_snapshot jsonb,actual_move_out_on date,initial_kind text,return_note text,physical_actor uuid,created_at timestamptz DEFAULT now());
 CREATE TABLE contract_terminations(id uuid PRIMARY KEY,contract_id uuid,actual_move_out_date date,termination_type text,status text,notes text,approved_by uuid,created_at timestamptz DEFAULT now());
 CREATE TABLE contract_transfers(id uuid PRIMARY KEY,contract_id uuid,transfer_type text,status text,transfer_date date,old_room_id uuid,new_room_id uuid,reason text,approved_by uuid,created_at timestamptz DEFAULT now());
 CREATE TABLE contract_extensions(id uuid PRIMARY KEY,contract_id uuid,status text,extension_date date,notes text,approved_by uuid,created_at timestamptz DEFAULT now());
 INSERT INTO customers(id,organization_id,full_name,deleted_at) VALUES('${customer}','${org}','Customer',null),('${other}','${org}','Other',null);
 INSERT INTO profiles VALUES('${actor}','Actor');INSERT INTO buildings VALUES('${building}','${org}','Building'),('${hidden}','${org}','Hidden');
 INSERT INTO rooms VALUES('${room}','${building}','101'),('${room2}','${building}','102');
 INSERT INTO contracts(id,organization_id,room_id,status,contract_number,start_date,end_date,created_at) VALUES('${contract}','${org}','${room}','ACTIVE','HD1','2020-01-01','2026-01-01','2020-01-01');
 INSERT INTO contract_customers(contract_id,customer_id,organization_id) VALUES('${contract}','${customer}','${org}');`);
  await db.exec(`ALTER TABLE contracts ADD COLUMN signed_date date, ADD COLUMN parent_contract_id uuid;
    ALTER TABLE contract_extensions ADD COLUMN extension_type text, ADD COLUMN new_contract_id uuid;
    ALTER TABLE contract_transfers ADD COLUMN approved_at timestamptz, ADD COLUMN move_out_date date, ADD COLUMN move_in_date date, ADD COLUMN old_tenant_id uuid, ADD COLUMN new_tenant_id uuid;
    CREATE FUNCTION public.ie_all_buildings_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;`);
  const segmentSource = readFileSync('supabase/migrations/20260921085952_restore_before_contract_settlement.sql', 'utf8');
  const segmentStart = segmentSource.indexOf('CREATE OR REPLACE FUNCTION public.get_room_residence_segments_v1(');
  const segmentEnd = segmentSource.indexOf('$function$\n;', segmentStart) + '$function$\n;'.length;
  await db.exec(segmentSource.slice(segmentStart, segmentEnd));
  await db.exec(readFileSync(migration, 'utf8'));
  await db.exec(readFileSync(correction, 'utf8'));
  await db.exec(readFileSync(correction, 'utf8'));
}, 30000);
afterAll(() => db.close());
beforeEach(() => db.exec('BEGIN'));
afterEach(() => db.exec('ROLLBACK'));
const flush = () => db.exec('SET CONSTRAINTS ALL IMMEDIATE');
const history = async (c = customer) => (await db.query<{
  value: {
    events: Array<Record<string, unknown>>;
    next_before_id: number | null;
  };
}>('SELECT public.get_customer_residence_history_v1($1,$2,null,50) value', [org, c])).rows[0].value.events;
const summary = async (c = customer) => (await db.query<{
  value: Array<Record<string, unknown>>;
}>('SELECT public.get_customer_residence_summaries_v1($1,$2) value', [org, [c]])).rows[0].value[0];
const rows = (c = customer, notes: null | string = null) => [{ customer_id: c, is_representative: false, notes }];
const reconcile = async (expected = rows(), desired = rows()) => db.query('SELECT public.reconcile_contract_customers_v1($1,$2,$3,$4)', [org, contract, expected, desired]);
async function rejects(sql: string, args: unknown[], code: string) {
  await db.exec('SAVEPOINT failure');
  await expect(db.query(sql, args)).rejects.toMatchObject({ code });
  await db.exec('ROLLBACK TO SAVEPOINT failure');
}

const page = async (before: number | null = null, limit = 50) =>
  (await db.query<{ value: { events: Array<Record<string, unknown>>; contract_contexts: Array<Record<string, unknown>>; next_before_id: number | null } }>(
    'SELECT public.get_customer_residence_history_v1($1,$2,$3,$4) value', [org, customer, before, limit])).rows[0].value;

// Reproduce pre-ledger legacy state without turning the fixture setup itself
// into a new physical event. This helper is never a production write path.
async function legacyContract(fields: string) {
  await db.exec(`ALTER TABLE contracts DISABLE TRIGGER record_residence_contract_update;
    UPDATE contracts SET ${fields} WHERE id='${contract}';
    ALTER TABLE contracts ENABLE TRIGGER record_residence_contract_update;`);
}

it('adds known contract dates and canonical contract-room segments without inventing a personal arrival', async () => {
  await legacyContract("signed_date='2026-10-02',start_date='2026-10-03',end_date='2027-08-30'");
  const result = await page();
  expect(result.events).toMatchObject([{ kind: 'OBSERVED', effective_date: null }]);
  expect(result.contract_contexts).toMatchObject([{ contract_id: contract, signed_date: '2026-10-02', start_date: '2026-10-03', end_date: '2027-08-30', actual_end_date: null,
    room_segments: [{ room_id: room, from_date: '2026-10-03', source_path: 'CONTRACT_START', trusted: true }] }]);
  expect(await summary()).toMatchObject({ state: 'CURRENT', departure_kind: null, last_contract_end: null });
});

it('labels only the actual contract end for OBSERVED-only legacy linkage, never a physical departure', async () => {
  await legacyContract("status='TERMINATED',actual_end_date='2026-06-27',end_date='2026-06-30'");
  expect(await summary()).toMatchObject({ state: 'DEPARTED', departure_date: null, departure_kind: null,
    last_contract_end: { contract_id: contract, date: '2026-06-27' } });
  expect((await page()).contract_contexts).toMatchObject([{ actual_end_date: '2026-06-27', end_date: '2026-06-30' }]);
  expect(await history()).toMatchObject([{ kind: 'OBSERVED', effective_date: null }]);
});

it('never turns a scheduled end into actual departure or contract-end fallback', async () => {
  await legacyContract("status='TERMINATED',actual_end_date=null,end_date='2026-06-30'");
  expect(await summary()).toMatchObject({ departure_date: null, last_contract_end: null });
});

it('suppresses old contract-end fallback after any personal event, even hidden evidence', async () => {
  await legacyContract("status='TERMINATED',actual_end_date='2026-06-27'");
  await db.query('SELECT app_private.append_customer_residence_v1($1,$2,$3,null)', [contract, customer, 'CONTRACT_ACTIVATED']);
  expect(await summary()).toMatchObject({ last_contract_end: null });
  await db.exec(`INSERT INTO rooms VALUES('${id(60)}','${hidden}','secret')`);
  await db.query('SELECT app_private.append_customer_residence_v1($1,$2,$3,null,null,null,null,true,$4)', [contract, customer, 'MEMBER_ADDED', id(60)]);
  expect(await summary()).toMatchObject({ state: 'UNKNOWN', last_contract_end: null, departure_kind: null });
});

it('does not expose current contract context when only an old event building is visible', async () => {
  await db.exec(`INSERT INTO rooms VALUES('${id(60)}','${hidden}','secret')`);
  await legacyContract(`room_id='${id(60)}',status='TERMINATED',actual_end_date='2026-06-27'`);
  expect((await page()).events).toHaveLength(1);
  expect((await page()).contract_contexts).toEqual([]);
  expect(await summary()).toMatchObject({ last_contract_end: null });
  await legacyContract('room_id=null');
  expect((await page()).contract_contexts).toEqual([]);
});

it('filters canonical historical room segments through historical building and organization permissions', async () => {
  await db.exec(`INSERT INTO rooms VALUES('${id(60)}','${hidden}','secret');
    ALTER TABLE contract_transfers DISABLE TRIGGER record_residence_source;
    INSERT INTO contract_transfers(id,contract_id,transfer_type,status,transfer_date,old_room_id,new_room_id) VALUES('${id(61)}','${contract}','ROOM_CHANGE','COMPLETED','2026-10-01','${id(60)}','${room}');
    ALTER TABLE contract_transfers ENABLE TRIGGER record_residence_source;`);
  const contexts = (await page()).contract_contexts;
  expect(contexts).toHaveLength(1);
  expect(contexts[0].room_segments).toMatchObject([{ room_id: room, from_date: '2026-10-01' }]);
  expect(contexts[0].room_segments).toHaveLength(1);
  await db.exec(`UPDATE buildings SET organization_id='${id(90)}' WHERE id='${building}'`);
  expect((await page()).contract_contexts).toEqual([]);
});

it('bounds contexts to event-page references plus first-page linked contracts', async () => {
  await db.exec(`INSERT INTO contracts(id,organization_id,room_id,status,contract_number) VALUES('${id(62)}','${org}','${room2}','ACTIVE','HD2');
    INSERT INTO contract_customers(contract_id,customer_id,organization_id) VALUES('${id(62)}','${customer}','${org}')`);
  await flush();
  const first = await page(null, 1);
  expect(first.contract_contexts.map(context => context.contract_id).sort()).toEqual([contract, id(62)].sort());
  const second = await page(first.next_before_id, 1);
  expect(second.events).toHaveLength(1);
  expect(second.contract_contexts.map(context => context.contract_id)).toEqual([contract]);
});

it('returns only finite four-digit ISO dates in context and fallback', async () => {
  await legacyContract("signed_date='-infinity',start_date='infinity',end_date='10000-01-01',status='TERMINATED',actual_end_date='infinity'");
  expect((await page()).contract_contexts).toMatchObject([{ signed_date: null, start_date: null, end_date: null, actual_end_date: null }]);
  expect(await summary()).toMatchObject({ last_contract_end: null });
});

it.each(['contract_extensions', 'contract_transfers', 'contract_terminations'])('metadata UPDATE of final %s never attributes history to a later member', async table => {
  if (table === 'contract_extensions') await db.exec(`INSERT INTO contract_extensions(id,contract_id,status,extension_date,notes,created_at) VALUES('${id(80)}','${contract}','COMPLETED','2026-01-01','old','2026-01-01')`);
  if (table === 'contract_transfers') await db.exec(`INSERT INTO contract_transfers(id,contract_id,transfer_type,status,transfer_date,old_room_id,new_room_id,reason,created_at) VALUES('${id(80)}','${contract}','ROOM_CHANGE','COMPLETED','2026-01-01','${room2}','${room}','old','2026-01-01')`);
  if (table === 'contract_terminations') await db.exec(`UPDATE contracts SET status='TERMINATED',actual_end_date='2026-01-01' WHERE id='${contract}'; INSERT INTO contract_terminations(id,contract_id,actual_move_out_date,termination_type,status,notes,created_at) VALUES('${id(80)}','${contract}','2026-01-01','NORMAL','COMPLETED','old','2026-01-01')`);
  await flush();
  await db.exec(`INSERT INTO contract_customers(contract_id,customer_id,organization_id) VALUES('${contract}','${other}','${org}')`);
  expect((await history(other)).filter(event => event.effective_date === '2026-01-01')).toEqual([]);
  const field = table === 'contract_transfers' ? 'reason' : 'notes';
  await db.exec(`UPDATE ${table} SET ${field}='metadata corrected' WHERE id='${id(80)}'`);
  expect((await history(other)).filter(event => event.effective_date === '2026-01-01')).toEqual([]);
});

it('delayed draft approval records one dated transfer, and completion never attributes newly added members', async () => {
  await db.exec(`INSERT INTO contract_transfers(id,contract_id,transfer_type,status,transfer_date,old_room_id,new_room_id,created_at) VALUES('${id(81)}','${contract}','ROOM_CHANGE','DRAFT','2026-10-06','${room}','${room2}','2026-10-01');
    UPDATE contracts SET room_id='${room2}' WHERE id='${contract}';
    UPDATE contract_transfers SET status='APPROVED',approved_at=clock_timestamp() WHERE id='${id(81)}'`);
  await flush();
  expect((await history()).filter(event => event.kind === 'ROOM_CHANGED')).toMatchObject([{ effective_date: '2026-10-06' }]);
  expect((await history()).filter(event => event.kind === 'ROOM_CHANGED')).toHaveLength(1);
  await db.exec(`INSERT INTO contract_customers(contract_id,customer_id,organization_id) VALUES('${contract}','${other}','${org}'); UPDATE contract_transfers SET status='COMPLETED' WHERE id='${id(81)}'`);
  expect((await history(other)).filter(event => event.kind === 'ROOM_CHANGED')).toEqual([]);
});

it('direct creation and generic activation are administrative, while signing proves received_on', async () => {
  await db.exec(`INSERT INTO contracts(id,organization_id,room_id,status) VALUES('${id(82)}','${org}','${room2}','ACTIVE');
    INSERT INTO contract_customers(contract_id,customer_id,organization_id) VALUES('${id(82)}','${other}','${org}')`);
  await flush();
  expect(await history(other)).toMatchObject([{ kind: 'MEMBER_ADDED', effective_date: '2026-10-07' }]);
  await legacyContract("status='DRAFT'");
  await db.exec(`UPDATE contracts SET status='ACTIVE' WHERE id='${contract}'`);
  await flush();
  expect((await history())[0]).toMatchObject({ kind: 'CONTRACT_ACTIVATED', effective_date: '2026-10-07' });
  await db.exec(`SET CONSTRAINTS ALL DEFERRED; INSERT INTO contracts(id,organization_id,room_id,status) VALUES('${id(83)}','${org}','${room2}','ACTIVE');
    INSERT INTO contract_customers(contract_id,customer_id,organization_id) VALUES('${id(83)}','${other}','${org}');
    INSERT INTO contract_draft_signings VALUES('${id(84)}','${org}','${id(83)}','[{"id":"${other}"}]','2026-09-30',clock_timestamp(),'${actor}')`);
  await flush();
  const events = (await history(other)).filter(event => event.contract_id === id(83));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: 'CHECKED_IN', effective_date: '2026-09-30' });
});

it('excludes only an EXPIRED predecessor proven by matching extension and successor-parent links', async () => {
  await legacyContract("status='EXPIRED'");
  expect(await summary()).toMatchObject({ state: 'CURRENT' });
  await db.exec(`INSERT INTO contracts(id,organization_id,room_id,status,parent_contract_id) VALUES('${id(82)}','${org}','${room}','ACTIVE','${contract}');
    INSERT INTO contract_customers(contract_id,customer_id,organization_id) VALUES('${id(82)}','${customer}','${org}');
    INSERT INTO contract_extensions(id,contract_id,status,extension_type,new_contract_id,extension_date) VALUES('${id(83)}','${contract}','COMPLETED','CREATE_NEW','${id(82)}','2026-10-01')`);
  await flush();
  expect((await summary()).current_accommodations).toHaveLength(1);
  await db.exec(`UPDATE contracts SET status='TERMINATED',actual_end_date='2026-10-06' WHERE id='${id(82)}'`);
  await flush();
  expect(await summary()).toMatchObject({ state: 'DEPARTED', departure_date: '2026-10-06', departure_kind: 'TERMINATED' });
  expect((await db.query<{status_v2:string}>('SELECT status_v2 FROM customers WHERE id=$1',[customer])).rows[0].status_v2).toBe('MOVED_OUT');
  expect((await db.query<{value:unknown}>('SELECT get_customer_residence_location_ids_v1($1,$2,null,false) value',[org,building])).rows[0].value).toEqual([]);
  expect((await db.query<{value:boolean}>('SELECT customer_residence_matches_location_v1($1,$2,$3,null,false) value',[org,customer,building])).rows[0].value).toBe(false);
  await db.exec(`UPDATE contracts SET parent_contract_id=null WHERE id='${id(82)}'`);
  expect(await summary()).toMatchObject({ state: 'CURRENT' });
});

it('returns the selected departure kind so administrative removal is not called physical departure', async () => {
  await reconcile(rows(), []);
  await flush();
  expect(await summary()).toMatchObject({ state: 'DEPARTED', departure_date: '2026-10-07', departure_kind: 'MEMBER_REMOVED', last_contract_end: null });
});

it('retains organization and permission denial before returning any extra context', async () => {
  await rejects('SELECT public.get_customer_residence_history_v1($1,$2,null,50)', [id(90),customer], '42501');
  await db.exec("SELECT set_config('test.role_denied','yes',true)");
  expect((await page()).contract_contexts).toEqual([]);
  expect(await summary()).toMatchObject({ state:'UNKNOWN', last_contract_end:null, departure_kind:null });
});


it.each(['unknown', 'hidden', 'missing', 'deleted'])('never borrows an old contract end when another OBSERVED contract is %s', async state => {
  await legacyContract("status='TERMINATED',actual_end_date='2026-06-27'");
  await db.exec(`INSERT INTO rooms VALUES('${id(60)}','${hidden}','secret');
    INSERT INTO contracts(id,organization_id,room_id,status,actual_end_date) VALUES('${id(85)}','${org}','${room}','TERMINATED','2026-09-30');
    INSERT INTO contract_customers(contract_id,customer_id,organization_id) VALUES('${id(85)}','${customer}','${org}')`);
  await db.query('SELECT app_private.append_customer_residence_v1($1,$2,$3,null)', [id(85), customer, 'OBSERVED']);
  // Simulate legacy context changes without manufacturing an event in the fixture.
  await db.exec('ALTER TABLE contracts DISABLE TRIGGER record_residence_contract_update; ALTER TABLE contracts DISABLE TRIGGER record_residence_contract');
  if (state === 'unknown') await db.exec(`UPDATE contracts SET actual_end_date=null WHERE id='${id(85)}'`);
  if (state === 'hidden') await db.exec(`UPDATE contracts SET room_id='${id(60)}' WHERE id='${id(85)}'`);
  if (state === 'missing') await db.exec(`DELETE FROM contracts WHERE id='${id(85)}'`);
  if (state === 'deleted') await db.exec(`UPDATE contracts SET deleted_at=now() WHERE id='${id(85)}'`);
  await db.exec('ALTER TABLE contracts ENABLE TRIGGER record_residence_contract_update; ALTER TABLE contracts ENABLE TRIGGER record_residence_contract');
  expect(await summary()).toMatchObject({ departure_date: null, last_contract_end: null });
});

it.each(['update', 'delete-insert'])('delayed representative approval deduplicates %s membership changes', async mode => {
  await db.exec(`INSERT INTO contract_transfers(id,contract_id,transfer_type,status,transfer_date,old_tenant_id,new_tenant_id,created_at)
    VALUES('${id(86)}','${contract}','TENANT_CHANGE','DRAFT','2026-10-06','${customer}','${other}','2026-10-01')`);
  if (mode === 'update') await db.exec(`UPDATE contract_customers SET customer_id='${other}' WHERE contract_id='${contract}'`);
  else await db.exec(`DELETE FROM contract_customers WHERE contract_id='${contract}'; INSERT INTO contract_customers(contract_id,customer_id,organization_id) VALUES('${contract}','${other}','${org}')`);
  await db.exec(`UPDATE contract_transfers SET status='APPROVED',approved_at=clock_timestamp() WHERE id='${id(86)}'`);
  await flush();
  expect((await history()).filter(event => event.kind !== 'OBSERVED')).toMatchObject([{kind:'TENANT_TRANSFER_OUT',effective_date:'2026-10-06'}]);
  expect((await history()).filter(event => event.kind !== 'OBSERVED')).toHaveLength(1);
  expect(await history(other)).toMatchObject([{kind:'TENANT_TRANSFER_IN',effective_date:'2026-10-06'}]);
  expect(await history(other)).toHaveLength(1);
});


it('keeps the context reader authenticated-only without granting access to the private schema', async () => {
  await db.exec('SET LOCAL ROLE authenticated');
  expect((await page()).contract_contexts).toMatchObject([{ contract_id: contract }]);
  await rejects('SELECT app_private.residence_contract_current_v2($1)', [contract], '42501');
  await db.exec('RESET ROLE; SET LOCAL ROLE anon');
  await rejects('SELECT public.get_customer_residence_history_v1($1,$2,null,50)', [org,customer], '42501');
  await db.exec('RESET ROLE');
});

it('uses the latest actual contract end only when every observed association has a known visible end', async () => {
  await legacyContract("status='TERMINATED',actual_end_date='2026-06-27'");
  await db.exec(`INSERT INTO contracts(id,organization_id,room_id,status,actual_end_date) VALUES('${id(85)}','${org}','${room}','TERMINATED','2026-09-30');
    INSERT INTO contract_customers(contract_id,customer_id,organization_id) VALUES('${id(85)}','${customer}','${org}')`);
  await db.query('SELECT app_private.append_customer_residence_v1($1,$2,$3,null)', [id(85), customer, 'OBSERVED']);
  expect(await summary()).toMatchObject({ departure_date:null, departure_kind:null, last_contract_end:{contract_id:id(85), date:'2026-09-30'} });
});
