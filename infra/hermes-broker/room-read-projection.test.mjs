import assert from 'node:assert/strict';
import test from 'node:test';
import { projectAvailableRooms } from './room-read-projection.mjs';

const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = uuid(1), B = uuid(2), NOW = Date.parse('2026-10-12T08:00:00Z');
const building = (id = A) => ({ id, name: 'Tòa cùng tên', code: 'SYNTHETIC', internal_note: 'PRIVATE_NOTE', public_contact_phone: 'PRIVATE_PHONE' });
const room = (id = uuid(3), building_id = A, fields = {}) => ({ id, building_id, code: 'P101', name: 'Phòng thử', floor: 1,
  area: 25.5, rent_price: 4000000, deposit_amount: 8000000, status_public: 'free', sale_state: 'VACANT',
  sale_today: '2026-10-12', avail_date: null, expected_ready_on: null, ...fields });
const payload = rooms => ({ rooms: rooms ?? [room()], buildings: [building(), building(B)], areas: [], contact: 'PRIVATE_CONTACT' });
const options = values => ({ allowedBuildingIds: [A], readAt: NOW, ...values });
const project = (data = payload(), config = options()) => projectAvailableRooms(data, config);
const code = expected => error => error.code === expected;

test('projection filters by building ID even when names match and strips every undeclared field', () => {
  const out = project(payload([room(uuid(3), A, { internal_bonus_note: 'PRIVATE_BONUS', pass_contact_phone: 'PRIVATE_PHONE',
    sale_note: 'PRIVATE_POLICY', description: 'PRIVATE_DESCRIPTION', images: ['https://example.invalid/private'], accessToken: 'PRIVATE_TOKEN' }),
  room(uuid(4), B, { name: 'PRIVATE_FOREIGN' })]));
  assert.equal(out.rooms.length, 1); assert.equal(out.rooms[0].building.id, A);
  assert(!JSON.stringify(out).includes('PRIVATE')); assert(!JSON.stringify(out).includes('example.invalid'));
  assert.deepEqual(Object.keys(out.rooms[0]), ['id', 'code', 'name', 'building', 'floor', 'areaM2', 'rentVnd', 'depositVnd', 'status', 'availability']);
  assert.deepEqual(Object.keys(out.rooms[0].availability), ['kind', 'label', 'availableOn']);
});
test('reuse CRM sale facts for ready, preparing, future notice and overdue notice; exclude pass', () => {
  const out = project(payload([
    room(uuid(3)), room(uuid(4), A, { sale_state: 'PREPARING', expected_ready_on: '2026-10-15' }),
    room(uuid(5), A, { status_public: 'soon', sale_state: 'NOTICE_VALID', avail_date: '2026-10-16' }),
    room(uuid(6), A, { status_public: 'soon', sale_state: 'NOTICE_OVERDUE', avail_date: '2026-10-11' }),
    room(uuid(7), A, { status_public: 'pass' }),
  ]));
  assert.deepEqual(out.rooms.map(r => r.availability.kind), ['ready', 'preparing', 'notice', 'confirm_notice']);
  assert.equal(out.rooms[1].availability.availableOn, '2026-10-15');
  assert.equal(out.rooms[3].availability.availableOn, null);
});
test('money remains the backend value in VND, unknown values remain null', () => {
  const out = project(payload([room(uuid(3)), room(uuid(4), A, { area: null, rent_price: null, deposit_amount: null })]));
  assert.equal(out.currency, 'VND'); assert.equal(out.rooms[0].rentVnd, 4000000); assert.equal(out.rooms[0].depositVnd, 8000000);
  assert.equal(out.rooms[1].rentVnd, null); assert.equal(out.rooms[1].areaM2, null);
});
test('no scope, wildcard, names and malformed IDs never become org-wide reads', () => {
  assert.throws(() => project(payload(), options({ allowedBuildingIds: [] })), code('rooms_scope_empty'));
  for (const allowedBuildingIds of [null, ['*'], ['Tòa cùng tên'], [A, A], ['not-an-id'], Array(1)]) {
    assert.throws(() => project(payload(), options({ allowedBuildingIds })), code('rooms_projection_request_invalid'));
  }
});
test('valid empty response is distinguished from malformed/error payload and unknown status', () => {
  const out = project({ rooms: [], buildings: [] });
  assert.equal(out.totalInSnapshot, 0); assert.equal(out.completeness, 'complete');
  for (const data of [null, { error: 'permission_denied' }, { rooms: [], buildings: [], error: 'not_permitted' },
    { rooms: null, buildings: [] }, payload([room(uuid(3), A, { status_public: 'unknown' })])]) {
    assert.throws(() => project(data), code('rooms_response_invalid'));
  }
});
test('reject missing relation, duplicate room or duplicate building instead of inventing a complete list', () => {
  for (const data of [{ ...payload(), buildings: [] }, payload([room(), room()]), { ...payload(), buildings: [building(), building()] }]) {
    assert.throws(() => project(data), code('rooms_response_invalid'));
  }
});
test('strict quantities and dates fail closed; no coercion of missing/bad data to zero or today', () => {
  for (const fields of [{ rent_price: '4000000' }, { rent_price: -1 }, { area: Infinity }, { deposit_amount: Number.MAX_SAFE_INTEGER + 1 },
    { floor: '1' }, { sale_today: '2026-02-30' }, { expected_ready_on: 'tomorrow' }, { name: null }]) {
    assert.throws(() => project(payload([room(uuid(3), A, fields)])), code('rooms_response_invalid'));
  }
});
test('pagination is deterministic and reports the source cap without claiming all rooms were returned', () => {
  const data = payload(Array.from({ length: 2000 }, (_, i) => room(uuid(10 + i))).reverse());
  const out = project(data, options({ offset: 1, limit: 2 }));
  assert.deepEqual(out.rooms.map(r => r.id), [uuid(11), uuid(12)]);
  assert.equal(out.totalInSnapshot, 2000); assert.equal(out.nextOffset, 3); assert.equal(out.completeness, 'source_capped');
  assert.equal(out.readAt, '2026-10-12T08:00:00.000Z');
  assert.equal(project(data, options({ offset: 1999, limit: 2 })).nextOffset, null);
});
test('building-name filter cannot expand ID scope; request and response are independent objects', () => {
  const data = payload([room(), room(uuid(4), B)]), config = options({ buildingName: 'CÙNG' });
  const out = project(data, config); assert.equal(out.rooms.length, 1);
  out.rooms[0].building.name = 'changed'; assert.equal(data.buildings[0].name, 'Tòa cùng tên');
  assert.deepEqual(config.allowedBuildingIds, [A]);
  assert.equal(project(data, options({ buildingName: 'nonexistent' })).totalInSnapshot, 0);
});
test('caller cannot forward actor, org, RPC, URLs or an unbounded result request through options', () => {
  for (const change of [{ organizationId: A }, { userId: A }, { rpc: 'other' }, { limit: 101 }, { offset: -1 },
    { readAt: 0 }, { readAt: Number.MAX_SAFE_INTEGER }, { buildingName: 'A'.repeat(121) }]) {
    assert.throws(() => project(payload(), options(change)), code('rooms_projection_request_invalid'));
  }
});
