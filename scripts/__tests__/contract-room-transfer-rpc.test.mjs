import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { splitSqlStatements } from '../network-center-function-bodies.mjs';

const db = new PGlite();
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [org, actor, building, oldRoom, newRoom, contract, otherBuilding, otherRoom, request, owner] =
  Array.from({ length: 10 }, (_, i) => id(i + 1));
const snapshot = '2026-01-04T12:00:00Z';
const reason = 'Khách đổi sang phòng trống';
const date = '2026-02-10';
const notice = '2026-03-01';
const migration = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');

// Run the relevant production DDL from multi-domain migrations without installing unrelated writers.
async function installStatements(name, prefixes) {
  const statements = splitSqlStatements(migration(name));
  for (const prefix of prefixes) {
    const matches = statements.filter(statement => statement.split('\n').some(line => line.startsWith(prefix)));
    expect(matches, prefix).toHaveLength(1);
    await db.exec(matches[0]);
  }
}

beforeAll(async () => {
  // The actor's membership and building grants are fixture data. Writers, permission guard,
  // notice cancellation, transfer history and commission audit execute their repository SQL.
  await db.exec(`
    CREATE SCHEMA auth; CREATE SCHEMA app_private;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
    CREATE TABLE organizations(id uuid PRIMARY KEY);
    CREATE TABLE profiles(id uuid PRIMARY KEY, full_name text);
    CREATE TABLE buildings(id uuid PRIMARY KEY, organization_id uuid, name text);
    CREATE TABLE rooms(id uuid PRIMARY KEY, building_id uuid, organization_id uuid, name text,
      status text, updated_at timestamptz, deleted_at timestamptz);
    CREATE TABLE contracts(id uuid PRIMARY KEY, organization_id uuid, user_id uuid, room_id uuid,
      contract_number text, status text, start_date date, end_date date, actual_end_date date, rent_price numeric, notes text,
      commission_change_reason text, expected_move_out_date date, updated_at timestamptz, deleted_at timestamptz);
    CREATE TABLE contract_transfers(contract_id uuid, user_id uuid, transfer_type text, transfer_date date,
      old_room_id uuid, new_room_id uuid, new_rent_price numeric, move_out_date date, move_in_date date,
      reason text, notes text, status text, approved_at timestamptz, approved_by uuid);
    CREATE TABLE contract_move_out_notice_events(organization_id uuid, contract_id uuid, actor_id uuid,
      previous_date date, new_date date, reason text, contract_updated_at timestamptz);
    CREATE TABLE room_next_claims(organization_id uuid,room_id uuid,status text);
    CREATE TABLE room_reservation_holds(organization_id uuid,room_id uuid,status text,contract_id uuid,expires_at timestamptz);
    CREATE TABLE room_turnovers(organization_id uuid,room_id uuid,status text,expected_ready_on date);
    CREATE TABLE room_sale_locks(id uuid DEFAULT gen_random_uuid(),organization_id uuid,room_id uuid,
      released_at timestamptz,expires_at timestamptz);
    CREATE TABLE deposit_held_rooms(room_id uuid);
    CREATE FUNCTION public.org_today_v1(uuid) RETURNS date LANGUAGE sql AS $$SELECT DATE '2026-02-20'$$;
    CREATE FUNCTION public.room_has_holding_deposit(uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT EXISTS(SELECT FROM deposit_held_rooms WHERE room_id=$1)$$;
    CREATE TABLE grants_by_building(building_id uuid, permission text, PRIMARY KEY (building_id, permission));
    CREATE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$SELECT ARRAY['${org}'::uuid]$$;
    CREATE FUNCTION public.sandbox_org_ids() RETURNS uuid[] LANGUAGE sql AS $$SELECT '{}'::uuid[]$$;
    CREATE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    CREATE FUNCTION public.can_access_building(uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT EXISTS(SELECT FROM grants_by_building WHERE building_id=$1)$$;
    CREATE FUNCTION public.can_do_on_building(text,text,uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT EXISTS(SELECT FROM grants_by_building WHERE building_id=$3 AND permission=$1||'.'||$2)$$;
    CREATE FUNCTION app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)
      RETURNS TABLE(allowed boolean) LANGUAGE sql AS $$ SELECT $1=auth.uid() AND $2=ANY(public.my_org_ids())
        AND EXISTS(SELECT FROM grants_by_building WHERE building_id=$4 AND permission=$3) $$;
    CREATE FUNCTION app_private.authorized_scope_v3(text,uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[])
      LANGUAGE sql AS $$SELECT false, ARRAY(SELECT building_id FROM grants_by_building WHERE permission=$1)$$;
    CREATE FUNCTION app_private.lock_org_for_decision_v1(uuid) RETURNS void LANGUAGE sql AS $$
      SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0)) $$;
    INSERT INTO organizations VALUES ('${org}');
    INSERT INTO profiles VALUES ('${actor}','Người chuyển thử');
    INSERT INTO buildings VALUES ('${building}','${org}','Tòa A'), ('${otherBuilding}','${org}','Tòa B');
    INSERT INTO rooms(id,building_id,organization_id,name,status) VALUES
      ('${oldRoom}','${building}','${org}','P1','OCCUPIED'),
      ('${newRoom}','${building}','${org}','P2','AVAILABLE'),
      ('${otherRoom}','${otherBuilding}','${org}','P2','AVAILABLE');
    INSERT INTO contracts(id,organization_id,user_id,room_id,contract_number,status,start_date,end_date,
      rent_price,notes,expected_move_out_date,updated_at) VALUES
      ('${contract}','${org}','${owner}','${oldRoom}','HD-TEST','ACTIVE','2026-01-01','2026-12-31',
       150,'Ghi chú cũ','${notice}','${snapshot}');
    INSERT INTO grants_by_building VALUES ('${building}','contracts.edit'), ('${building}','contracts.transfer'),
      ('${otherBuilding}','contracts.edit'), ('${otherBuilding}','contracts.transfer');
  `);
  await installStatements('20260731050000_contract_transfer_audit_hardening', [
    'CREATE OR REPLACE FUNCTION public.transfer_room(',
  ]);
  await db.exec(migration('20260928035250_contract_notice_action_adapters'));
  await installStatements('20261010114500_giu_cho_ten_goi_nho_va_lock_tam_phong', [
    'CREATE OR REPLACE FUNCTION app_private.room_sale_workflow_base_fact_v1(',
    'CREATE OR REPLACE FUNCTION app_private.room_sale_lock_open_id_v1(',
    'CREATE OR REPLACE FUNCTION app_private.room_sale_workflow_fact_v1(',
  ]);
  // The October migration preserves the July core under this private name before wrapping it.
  await db.exec(`ALTER FUNCTION public.transfer_room(uuid,uuid,numeric,date,text) SET SCHEMA app_private;
    ALTER FUNCTION app_private.transfer_room(uuid,uuid,numeric,date,text) RENAME TO commission_reason_transfer_room_before_v1`);
  await installStatements('20261011074456_commission_reason_audit_flow', [
    'CREATE TABLE IF NOT EXISTS app_private.commission_reason_contexts',
    'CREATE TABLE IF NOT EXISTS app_private.commission_intervention_events',
    'CREATE OR REPLACE FUNCTION app_private.commission_reason_v1(',
    'CREATE OR REPLACE FUNCTION app_private.begin_commission_reason_v1(',
    'CREATE OR REPLACE FUNCTION app_private.commission_reason_snapshot_names_v1(',
    'CREATE OR REPLACE FUNCTION app_private.append_commission_intervention_v1(',
    'CREATE OR REPLACE FUNCTION app_private.guard_commission_basis_v1(',
    'CREATE TRIGGER z98_commission_basis BEFORE UPDATE ON public.contracts',
    'CREATE OR REPLACE FUNCTION public.transfer_room(',
  ]);
  await installStatements('20261021231237_chan_tu_duyet_phieu_chi_vuot_nguong_v1', [
    'CREATE OR REPLACE FUNCTION app_private.has_building_perm_v1(',
    'CREATE OR REPLACE FUNCTION app_private.require_building_perm_v1(',
  ]);
  const forward = migration('20261120083952_chuyen_phong_quyen_va_trang_thai');
  await db.exec(forward);
  await db.exec(forward);
}, 30000);

beforeEach(() => db.exec('BEGIN'));
afterEach(() => db.exec('ROLLBACK'));
afterAll(() => db.close());

function transfer({ target = newRoom, at = snapshot, key = request, price = 220, notes = reason,
  orgId = org, contractId = contract, transferDate = date } = {}) {
  return db.query(`SELECT public.transfer_room_with_notice_v1($1,$2,$3,$4,$5,$6,$7,$8,$8) AS contract`,
    [orgId, contractId, at, target, transferDate, key, price, notes]);
}

function directTransfer() {
  return db.query('SELECT public.transfer_room($1,$2,NULL,$3,$4)', [contract, newRoom, date, reason]);
}

async function rejects(run, error) {
  await db.exec('SAVEPOINT rejected_transfer');
  await expect(run()).rejects.toMatchObject(error);
  await db.exec('ROLLBACK TO SAVEPOINT rejected_transfer');
}

async function expectNoEffects() {
  const state = await db.query(`SELECT room_id, rent_price::int, expected_move_out_date::text FROM contracts WHERE id=$1`, [contract]);
  expect(state.rows).toEqual([{ room_id: oldRoom, rent_price: 150, expected_move_out_date: notice }]);
  expect((await db.query(`SELECT
    (SELECT count(*) FROM contract_transfers) + (SELECT count(*) FROM contract_move_out_notice_events) +
    (SELECT count(*) FROM contract_notice_transition_events) +
    (SELECT count(*) FROM app_private.commission_intervention_events) AS events`)).rows).toEqual([{ events: 0 }]);
}

it('commits the move, history, notice cancellation and commission basis once, including exact retry', async () => {
  expect((await transfer()).rows).toEqual([{ contract }]);
  expect((await transfer()).rows).toEqual([{ contract }]);
  const core = await db.query(`SELECT room_id, status, start_date::text, end_date::text, rent_price::int,
    expected_move_out_date, notes FROM contracts WHERE id=$1`, [contract]);
  expect(core.rows).toEqual([{ room_id: newRoom, status: 'ACTIVE', start_date: '2026-01-01', end_date: '2026-12-31',
    rent_price: 220, expected_move_out_date: null, notes: `Ghi chú cũ\n[Chuyển phòng 10/02/2026] ${reason}` }]);
  expect((await db.query('SELECT status FROM rooms WHERE id IN ($1,$2) ORDER BY id', [oldRoom, newRoom])).rows)
    .toEqual([{ status: 'AVAILABLE' }, { status: 'OCCUPIED' }]);
  expect((await db.query(`SELECT old_room_id, new_room_id, approved_by, transfer_type, status,
    move_in_date::text, move_out_date::text, reason FROM contract_transfers`)).rows).toEqual([{
    old_room_id: oldRoom, new_room_id: newRoom, approved_by: actor, transfer_type: 'ROOM_CHANGE',
    status: 'COMPLETED', move_in_date: date, move_out_date: date, reason,
  }]);
  expect((await db.query(`SELECT previous_room_id, operation, notice_choice, request_id FROM contract_notice_transition_events`)).rows)
    .toEqual([{ previous_room_id: oldRoom, operation: 'TRANSFER_ROOM', notice_choice: 'CANCEL', request_id: request }]);
  expect((await db.query('SELECT previous_date::text, new_date, actor_id FROM contract_move_out_notice_events')).rows)
    .toEqual([{ previous_date: notice, new_date: null, actor_id: actor }]);
  expect((await db.query(`SELECT contract_id, actor_id, reason, before_snapshot->>'room_id' AS old_room,
    after_snapshot->>'room_id' AS new_room FROM app_private.commission_intervention_events`)).rows)
    .toEqual([{ contract_id: contract, actor_id: actor, reason, old_room: oldRoom, new_room: newRoom }]);
  await rejects(() => transfer({ price: 350 }), { code: '23505' });
});

it('keeps the current rent when blank and moves a contract with no notice', async () => {
  await db.exec('UPDATE contracts SET expected_move_out_date=NULL');
  await transfer({ price: null });
  expect((await db.query('SELECT room_id,rent_price::int FROM contracts')).rows).toEqual([{ room_id: newRoom, rent_price: 150 }]);
  expect((await db.query('SELECT * FROM contract_move_out_notice_events')).rows).toEqual([]);
});

it.each(['edit', 'transfer'])('requires contracts.%s at the source building, even with both rights elsewhere', async permission => {
  await db.query('DELETE FROM grants_by_building WHERE building_id=$1 AND permission=$2', [building, `contracts.${permission}`]);
  await rejects(() => transfer(), { code: '42501' });
  await expectNoEffects();
});

it('rejects a retry after transfer permission has been withdrawn', async () => {
  await transfer();
  await db.query("DELETE FROM grants_by_building WHERE building_id=$1 AND permission='contracts.transfer'", [building]);
  await rejects(() => transfer(), { code: '42501' });
  expect((await db.query('SELECT contract_id FROM contract_transfers')).rows).toEqual([{ contract_id: contract }]);
});

it('also enforces the transfer permission when a caller uses the older public RPC', async () => {
  await db.query("DELETE FROM grants_by_building WHERE building_id=$1 AND permission='contracts.transfer'", [building]);
  await rejects(directTransfer, { code: '42501' });
  await expectNoEffects();
});

it.each(['RESERVED', 'MAINTENANCE', 'UNAVAILABLE', 'OCCUPIED'])('rejects a destination that became %s after selection', async status => {
  await db.query('UPDATE rooms SET status=$2 WHERE id=$1', [newRoom, status]);
  await rejects(() => transfer(), { code: '55000' });
  await expectNoEffects();
  expect((await db.query('SELECT status FROM rooms WHERE id=$1', [newRoom])).rows).toEqual([{ status }]);
});

it.each([
  ['hold', "INSERT INTO room_next_claims VALUES($1,$2,'LIVE')"],
  ['turnover', "INSERT INTO room_turnovers VALUES($1,$2,'PENDING',NULL)"],
  ['sale lock', "INSERT INTO room_sale_locks(organization_id,room_id,expires_at) VALUES($1,$2,now()+interval '1 hour')"],
])('rejects a physically available room with a live %s', async (_, seed) => {
  await db.query(seed, [org, newRoom]);
  await rejects(() => transfer(), { code: '55000' });
  await expectNoEffects();
});

it('rejects a physically available room with a holding deposit', async () => {
  await db.query('INSERT INTO deposit_held_rooms VALUES($1)', [newRoom]);
  await rejects(() => transfer(), { code: '55000' });
  await expectNoEffects();
});

it.each(['PENDING_APPROVAL', 'APPROVED'])('rejects a live legacy %s reservation with no contract', async status => {
  await db.query("INSERT INTO room_reservation_holds VALUES($1,$2,$3,NULL,now()+interval '1 day')", [org, newRoom, status]);
  await rejects(() => transfer(), { code: '55000' });
  await expectNoEffects();
});

it.each([
  ['expired', 'PENDING_APPROVAL', null, '-1 hour'],
  ['converted', 'APPROVED', id(92), '1 hour'],
  ['cancelled', 'CANCELLED', null, '1 hour'],
])('accepts a room with a historical %s reservation', async (_, status, linkedContract, expiry) => {
  await db.query('INSERT INTO room_reservation_holds VALUES($1,$2,$3,$4,now()+$5::interval)',
    [org, newRoom, status, linkedContract, expiry]);
  expect((await transfer()).rows).toEqual([{ contract }]);
});

it('can retry the same request once the reservation is released and the room is ready', async () => {
  await db.query("INSERT INTO room_sale_locks(organization_id,room_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [org, newRoom]);
  await rejects(() => transfer(), { code: '55000' });
  await db.query('UPDATE room_sale_locks SET released_at=now() WHERE room_id=$1', [newRoom]);
  expect((await transfer()).rows).toEqual([{ contract }]);
  expect((await db.query('SELECT request_id FROM contract_notice_transition_events')).rows).toEqual([{ request_id: request }]);
});

it('rejects a second contract claiming the same room after an earlier transfer', async () => {
  const second = id(11);
  await db.query(`INSERT INTO contracts(id,organization_id,user_id,room_id,status,start_date,rent_price,updated_at)
    VALUES($1,$2,$3,$4,'ACTIVE','2026-01-01',150,$5)`, [second, org, owner, otherRoom, snapshot]);
  await db.query('UPDATE rooms SET building_id=$1 WHERE id=$2', [building, otherRoom]);
  await transfer();
  await rejects(() => transfer({ contractId: second, key: id(12) }), { message: expect.stringContaining('đã có hợp đồng') });
  expect((await db.query('SELECT room_id FROM contracts WHERE id=$1', [second])).rows).toEqual([{ room_id: otherRoom }]);
  expect((await db.query('SELECT contract_id FROM contract_transfers')).rows).toEqual([{ contract_id: contract }]);
});

it.each([
  ['same room', { target: oldRoom }, { message: expect.stringContaining('trùng') }],
  ['different building', { target: otherRoom }, { code: '42501', message: expect.stringContaining('toà khác') }],
  ['different organization', { orgId: id(88) }, { code: '42501' }],
  ['missing room', { target: id(87) }, { message: expect.stringContaining('không tồn tại') }],
  ['stale contract', { at: '2026-01-04T11:00:00Z' }, { code: 'PT409' }],
  ['missing move date', { transferDate: null }, { code: '22023' }],
  ['before the contract starts', { transferDate: '2025-12-31' }, { code: '22023' }],
  ['after today in the organization', { transferDate: '2026-02-21' }, { code: '22023' }],
  ['short commission reason', { notes: 'ab' }, { code: '22023' }],
])('rejects %s and rolls the contract and audits back', async (_, input, error) => {
  await rejects(() => transfer(input), error);
  await expectNoEffects();
});

it('rejects a terminated contract', async () => {
  await db.exec("UPDATE contracts SET status='TERMINATED'");
  await rejects(() => transfer(), { message: expect.stringContaining('hiệu lực') });
  await expectNoEffects();
});

it('rejects a room that was deleted after loading the picker', async () => {
  await db.query('UPDATE rooms SET deleted_at=now() WHERE id=$1', [newRoom]);
  await rejects(() => transfer(), { message: expect.stringContaining('không tồn tại') });
  await expectNoEffects();
});

it('keeps a room in another organization outside the destination lookup', async () => {
  const remoteOrg = id(88);
  await db.query('INSERT INTO organizations VALUES ($1)', [remoteOrg]);
  await db.query('UPDATE buildings SET organization_id=$1 WHERE id=$2', [remoteOrg, otherBuilding]);
  await db.query('UPDATE rooms SET organization_id=$1 WHERE id=$2', [remoteOrg, otherRoom]);
  await rejects(() => transfer({ target: otherRoom }), { message: expect.stringContaining('không tồn tại') });
  await expectNoEffects();
});

it('preserves dated residence order across repeat moves', async () => {
  await transfer();
  const { at } = (await db.query('SELECT updated_at::text AS at FROM contracts WHERE id=$1', [contract])).rows[0];
  const again = { at, target: oldRoom, key: id(25) };
  for (const transferDate of ['2026-02-09', date]) {
    await rejects(() => transfer({ ...again, transferDate }), { code: '22023' });
  }
  expect((await transfer({ ...again, transferDate: '2026-02-20' })).rows).toEqual([{ contract }]);
  expect((await db.query('SELECT transfer_date::text, old_room_id, new_room_id FROM contract_transfers ORDER BY transfer_date')).rows)
    .toEqual([{ transfer_date: date, old_room_id: oldRoom, new_room_id: newRoom },
      { transfer_date: '2026-02-20', old_room_id: newRoom, new_room_id: oldRoom }]);
});

it('rolls back the notice, rooms, rent and commission when final receipt insertion fails', async () => {
  await db.exec(`ALTER TABLE contract_notice_transition_events ADD CHECK (operation <> 'TRANSFER_ROOM')`);
  await rejects(() => transfer(), { code: '23514' });
  await expectNoEffects();
  expect((await db.query('SELECT status FROM rooms WHERE id IN ($1,$2) ORDER BY id', [oldRoom, newRoom])).rows)
    .toEqual([{ status: 'OCCUPIED' }, { status: 'AVAILABLE' }]);
});
