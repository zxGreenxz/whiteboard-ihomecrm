import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from 'vitest';
const db = new PGlite();
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const [org, actor, building, room, contract, customer, other, room2, hidden] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id);
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
  await db.exec(readFileSync(migration, 'utf8'));
  await db.exec(readFileSync(migration, 'utf8'));
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
it('replay preserves one incomplete legacy observation without inventing a start date', async () => {
  const h = await history();
  expect(h).toHaveLength(1);
  expect(h[0]).toMatchObject({ kind: 'OBSERVED', effective_date: null, incomplete: true });
  expect(await summary()).toMatchObject({ state: 'CURRENT', incomplete: true });
});
it('metadata-only save and no-op preserve history, add/remove/re-add have real dates', async () => {
  const before = await history();
  await reconcile(rows(), rows(customer, 'note'));
  await flush();
  expect(await history()).toEqual(before);
  await reconcile(rows(customer, 'note'), [...rows(customer, 'note'), ...rows(other)]);
  await flush();
  expect((await history(other))[0]).toMatchObject({ kind: 'MEMBER_ADDED', effective_date: '2026-10-07' });
  await reconcile([...rows(customer, 'note'), ...rows(other)], rows(customer, 'note'));
  await flush();
  expect(await summary(other)).toMatchObject({ state: 'DEPARTED', departure_date: '2026-10-07' });
  await reconcile(rows(customer, 'note'), [...rows(customer, 'note'), ...rows(other)]);
  await flush();
  expect(await summary(other)).toMatchObject({ state: 'CURRENT', departure_date: null });
  expect(await history(other)).toHaveLength(3);
});
it('rejects concurrent baseline, forbidden organization, building and role without partial writes', async () => {
  await rejects('SELECT public.reconcile_contract_customers_v1($1,$2,$3,$4)', [org, contract, [], rows(other)], 'PT409');
  await rejects('SELECT public.get_customer_residence_summaries_v1($1,$2)', [id(99), [customer]], '42501');
  await db.exec("SET test.denied='yes'");
  await rejects('SELECT public.reconcile_contract_customers_v1($1,$2,$3,$4)', [org, contract, rows(), []], '42501');
  expect(await summary()).toMatchObject({ state: 'UNKNOWN' });
  expect(await history()).toEqual([]);
  await db.exec("SET test.denied=''; SET test.role_denied='yes'");
  await rejects('SELECT public.reconcile_contract_customers_v1($1,$2,$3,$4)', [org, contract, rows(), []], '42501');
  expect(await history()).toEqual([]);
});
it('rolls history back with membership writes and prohibits ledger mutation', async () => {
  await db.exec('SAVEPOINT changes');
  await reconcile(rows(), []);
  await flush();
  expect(await history()).toHaveLength(2);
  await db.exec('ROLLBACK TO SAVEPOINT changes');
  expect(await history()).toHaveLength(1);
  await rejects('UPDATE app_private.customer_residence_events SET reason=$1', ['fake'], '55000');
  await rejects('DELETE FROM app_private.customer_residence_events', [], '55000');
  await db.exec('SET LOCAL ROLE authenticated');
  await rejects('INSERT INTO app_private.customer_residence_events DEFAULT VALUES', [], '42501');
  await db.exec('RESET ROLE');
});
it('expiration alone does not imply departure; actual exit preserves date and reason', async () => {
  await db.exec(`UPDATE contracts SET status='EXPIRED' WHERE id='${contract}'`);
  expect(await summary()).toMatchObject({ state: 'CURRENT' });
  await db.exec(`INSERT INTO contract_exit_cases(id,organization_id,contract_id,party_snapshot,actual_move_out_on,initial_kind,return_note,physical_actor) VALUES('${id(20)}','${org}','${contract}','{"customers":[{"customer_id":"${customer}"}]}','2026-10-06','EARLY_RETURN','Job moved','${actor}'); UPDATE contracts SET status='TERMINATED',actual_end_date='2026-10-06' WHERE id='${contract}'`);
  await flush();
  expect(await summary()).toMatchObject({ state: 'DEPARTED', departure_date: '2026-10-06' });
  expect((await history()).filter(x => x.kind === 'EARLY_RETURN')).toHaveLength(1);
  expect((await history())[0]).toMatchObject({ reason: 'Job moved' });
});
it('deleted contracts preserve evidence but deletion never invents physical exit date', async () => {
  await db.exec(`DELETE FROM contracts WHERE id='${contract}'`);
  await flush();
  expect(await summary()).toMatchObject({ state: 'DEPARTED', departure_date: null, incomplete: true });
  expect((await history())[0]).toMatchObject({ kind: 'CONTRACT_DELETED', effective_date: null });
});
it('room transfer uses audit date and renewal records once without a fake exit', async () => {
  await db.exec(`INSERT INTO contract_transfers VALUES('${id(21)}','${contract}','ROOM_CHANGE','COMPLETED','2026-10-05','${room}','${room2}','Move','${actor}',now());UPDATE contracts SET room_id='${room2}' WHERE id='${contract}';INSERT INTO contract_extensions VALUES('${id(22)}','${contract}','COMPLETED','2026-10-07','Renew','${actor}',now())`);
  await flush();
  expect((await history()).filter(x => x.kind === 'ROOM_CHANGED')).toHaveLength(1);
  expect((await history()).find(x => x.kind === 'ROOM_CHANGED')).toMatchObject({ effective_date: '2026-10-05', room_name: '102' });
  expect((await history()).filter(x => x.kind === 'RENEWED')).toHaveLength(1);
  expect(await summary()).toMatchObject({ state: 'CURRENT' });
});
it('signing snapshot dates only evidenced parties, late additions use today', async () => {
  await db.exec(`INSERT INTO contract_draft_signings VALUES('${id(23)}','${org}','${contract}','[{"id":"${customer}"}]','2020-01-01',now(),'${actor}')`);
  await reconcile(rows(), [...rows(), ...rows(other)]);
  await flush();
  expect((await history()).find(x => x.kind === 'CHECKED_IN')).toMatchObject({ effective_date: '2020-01-01' });
  expect((await history(other))[0]).toMatchObject({ effective_date: '2026-10-07', kind: 'MEMBER_ADDED' });
});
it('keyset paging is deterministic and remains complete when a newer event is added', async () => {
  for (let i = 0; i < 4; i++) {
    await reconcile(i % 2 ? [] : rows(), i % 2 ? rows() : []);
    await flush();
  }
  const first = (await db.query<{
    v: {
      events: Array<{
        id: number;
      }>;
      next_before_id: number;
    };
  }>('SELECT get_customer_residence_history_v1($1,$2,null,2) v', [org, customer])).rows[0].v;
  await reconcile(rows(), []);
  await flush();
  const next = (await db.query<{
    v: {
      events: Array<{
        id: number;
      }>;
    };
  }>('SELECT get_customer_residence_history_v1($1,$2,$3,50) v', [org, customer, first.next_before_id])).rows[0].v;
  expect(new Set([...first.events, ...next.events].map(x => x.id)).size).toBe(5);
});
it('membership departure and return update customer list tabs after commit', async () => {
  await reconcile(rows(), []);
  await flush();
  expect((await db.query<{
    status_v2: string;
  }>(`SELECT status_v2 FROM customers WHERE id='${customer}'`)).rows[0].status_v2).toBe('MOVED_OUT');
  await reconcile([], rows());
  await flush();
  expect((await db.query<{
    status_v2: string;
  }>(`SELECT status_v2 FROM customers WHERE id='${customer}'`)).rows[0].status_v2).toBe('RENTING');
});
it('natural expiry and forfeit retain actual exit evidence, and a hidden current room prevents a false departure', async () => {
  await db.exec(`INSERT INTO contract_exit_cases(id,organization_id,contract_id,party_snapshot,actual_move_out_on,initial_kind,physical_actor) VALUES('${id(30)}','${org}','${contract}','{"customers":[{"customer_id":"${customer}"}]}','2026-10-06','NATURAL_EXPIRY','${actor}'); UPDATE contracts SET status='TERMINATED',actual_end_date='2026-10-06' WHERE id='${contract}'`);
  await flush();
  expect(await summary()).toMatchObject({ departure_date: '2026-10-06' });
  await db.exec(`INSERT INTO rooms VALUES('${id(31)}','${hidden}','secret');INSERT INTO contracts(id,organization_id,room_id,status,start_date,end_date) VALUES('${id(32)}','${org}','${id(31)}','ACTIVE','2026-10-07','2027-10-07');INSERT INTO contract_customers(contract_id,customer_id,organization_id) VALUES('${id(32)}','${customer}','${org}')`);
  await flush();
  expect(await summary()).toMatchObject({ state: 'UNKNOWN', departure_date: null });
  expect(JSON.stringify(await history())).not.toContain('secret');
});
it('historical location reader finds departed members after their links are removed', async () => {
  await reconcile(rows(), []);
  await flush();
  const result = await db.query<{
    value: string[];
  }>('SELECT get_customer_residence_location_ids_v1($1,$2,null,true,null,500) value', [org, building]);
  expect(result.rows[0].value).toEqual([customer]);
});
it('customer statistics use the same historical location predicate as the departed list', async () => {
  await reconcile(rows(), []);
  await flush();
  const result = await db.query<{
    value: {
      total: number;
    };
  }>('SELECT get_customer_stats($1,null,$2,null) value', ['MOVED_OUT', building]);
  expect(result.rows[0].value.total).toBe(1);
});
it('legacy representative transfer evidence survives replaced links and is not attributed to unrelated members', async () => {
  await db.exec(`ALTER TABLE contract_transfers ADD COLUMN old_tenant_id uuid;ALTER TABLE contract_transfers ADD COLUMN new_tenant_id uuid;INSERT INTO contract_transfers(id,contract_id,transfer_type,status,transfer_date,old_room_id,new_room_id,reason,approved_by,old_tenant_id,new_tenant_id) VALUES('${id(40)}','${contract}','TENANT_CHANGE','COMPLETED','2026-10-04','${room}','${room}','Transfer','${actor}','${customer}','${other}')`);
  await db.query('SELECT app_private.ingest_residence_source_v1($1,to_jsonb(t),true) FROM contract_transfers t WHERE id=$2', ['contract_transfers', id(40)]);
  expect((await history()).find(e => e.kind === 'TENANT_TRANSFER_OUT')).toMatchObject({ effective_date: '2026-10-04' });
  expect((await history(other)).find(e => e.kind === 'TENANT_TRANSFER_IN')).toMatchObject({ effective_date: '2026-10-04' });
});
it('legacy termination following its contract status update creates one actual exit, retained after deletion', async () => {
  await db.exec(`UPDATE contracts SET status='TERMINATED',actual_end_date='2026-10-06' WHERE id='${contract}';INSERT INTO contract_terminations(id,contract_id,actual_move_out_date,termination_type,status,notes,approved_by) VALUES('${id(41)}','${contract}','2026-10-06','FORFEIT','COMPLETED','Deposit forfeited','${actor}')`);
  await flush();
  expect((await history()).filter(e => ['TERMINATED', 'FORFEIT'].includes(String(e.kind)))).toHaveLength(1);
  await db.exec(`DELETE FROM contracts WHERE id='${contract}'`);
  await flush();
  expect(await summary()).toMatchObject({ departure_date: '2026-10-06' });
});
it('draft membership is not residence until activation; activation records the known observation date', async () => {
  await db.exec(`UPDATE contracts SET status='DRAFT' WHERE id='${contract}';INSERT INTO contract_customers(contract_id,customer_id,organization_id) VALUES('${contract}','${other}','${org}')`);
  await flush();
  expect(await history(other)).toEqual([]);
  await db.exec(`UPDATE contracts SET status='ACTIVE' WHERE id='${contract}'`);
  await flush();
  expect((await history(other))[0]).toMatchObject({ kind: 'CHECKED_IN', effective_date: '2026-10-07' });
});
it('legacy same-contract customer identity update records old departure and new arrival atomically', async () => {
  await db.exec(`UPDATE contract_customers SET customer_id='${other}' WHERE contract_id='${contract}' AND customer_id='${customer}'`);
  await flush();
  expect((await history())[0]).toMatchObject({ kind: 'MEMBER_REMOVED', effective_date: '2026-10-07' });
  expect((await history(other))[0]).toMatchObject({ kind: 'MEMBER_ADDED', effective_date: '2026-10-07' });
});
it('an accessible building from another organization cannot supply residence details', async () => {
  await db.exec(`INSERT INTO buildings VALUES('${id(51)}','${id(99)}','Other organization');INSERT INTO rooms VALUES('${id(52)}','${id(51)}','private');UPDATE contracts SET room_id='${id(52)}' WHERE id='${contract}'`);
  await flush();
  const result = await summary();
  expect(result).toMatchObject({ state: 'UNKNOWN', current_accommodations: [] });
  expect(JSON.stringify(await history())).not.toContain('Other organization');
});
it('statistics remain callable by authenticated without access to the private schema', async () => {
  await db.exec('GRANT SELECT ON customers TO authenticated;SET LOCAL ROLE authenticated');
  const response = await db.query<{
    value: {
      total: number;
    };
  }>('SELECT get_customer_stats(null,null,$1,null) value', [building]);
  expect(response.rows[0].value.total).toBe(1);
  await db.exec('RESET ROLE');
});
it('latest departure follows effective dates when exit snapshots are ingested in reverse order', async () => {
  await db.exec(`INSERT INTO contracts(id,organization_id,room_id,status,contract_number,start_date,end_date) VALUES('${id(61)}','${org}','${room}','TERMINATED','HD2','2025-01-01','2026-10-01');UPDATE contracts SET status='TERMINATED',actual_end_date='2026-10-06' WHERE id='${contract}';INSERT INTO contract_exit_cases(id,organization_id,contract_id,party_snapshot,actual_move_out_on,initial_kind) VALUES('${id(62)}','${org}','${contract}','{"customers":[{"customer_id":"${customer}"}]}','2026-10-06','NATURAL_EXPIRY'),('${id(63)}','${org}','${id(61)}','{"customers":[{"customer_id":"${customer}"}]}','2025-10-06','NATURAL_EXPIRY')`);
  await flush();
  expect(await summary()).toMatchObject({ state: 'DEPARTED', departure_date: '2026-10-06' });
});
it('unknown deletion after returning never borrows a date from the previous residence', async () => {
  await reconcile(rows(), []);
  await flush();
  await reconcile([], rows());
  await flush();
  await db.exec(`DELETE FROM contracts WHERE id='${contract}'`);
  await flush();
  expect(await summary()).toMatchObject({ departure_date: null, incomplete: true });
});
it('exit source display snapshots and timestamp survive current room and contract renames', async () => {
  await db.exec(`ALTER TABLE contract_exit_cases ADD COLUMN building_name text;ALTER TABLE contract_exit_cases ADD COLUMN room_name text;ALTER TABLE contract_exit_cases ADD COLUMN contract_number text;INSERT INTO contract_exit_cases(id,organization_id,contract_id,party_snapshot,actual_move_out_on,initial_kind,building_name,room_name,contract_number,created_at) VALUES('${id(64)}','${org}','${contract}','{"customers":[{"customer_id":"${customer}"}]}','2025-10-06','EARLY_RETURN','Original building','Original room','Original contract','2025-10-07T12:00:00Z')`);
  const recorded = (await history())[0];
  expect(new Date(String(recorded.recorded_at)).toISOString()).toBe('2025-10-07T12:00:00.000Z');
  expect(recorded).toMatchObject({ building_name: 'Original building', room_name: 'Original room', contract_number: 'Original contract' });
});

it('legacy representative transfer without physical exit never invents a departure date', async () => {
  await db.exec(`ALTER TABLE contract_transfers ADD COLUMN old_tenant_id uuid; ALTER TABLE contract_transfers ADD COLUMN new_tenant_id uuid;
    ALTER TABLE contract_customers DISABLE TRIGGER ALL; DELETE FROM contract_customers WHERE customer_id='${customer}'; ALTER TABLE contract_customers ENABLE TRIGGER ALL;
    INSERT INTO contract_transfers(id,contract_id,transfer_type,status,transfer_date,old_tenant_id,new_tenant_id) VALUES('${id(70)}','${contract}','TENANT_CHANGE','COMPLETED','2026-10-04','${customer}','${other}')`);
  await db.query('SELECT app_private.ingest_residence_source_v1($1,to_jsonb(t),true) FROM contract_transfers t WHERE id=$2', ['contract_transfers', id(70)]);
  expect(await summary()).toMatchObject({ state: 'DEPARTED', departure_date: null });
});
