import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { id, org, actor, building, oldRoom, newRoom, contract, otherBuilding, otherRoom, request, owner,
  snapshot, reason, date, notice, installRoomTransferFixture } from '../lib/room-transfer-test-fixture.mjs';

const db = new PGlite();
beforeAll(() => installRoomTransferFixture(db), 30000);

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
