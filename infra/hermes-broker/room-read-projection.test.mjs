import assert from 'node:assert/strict';
import test from 'node:test';
import { projectAvailableRooms } from './room-read-projection.mjs';

// Synthetic data only (public repo): names, prices and phone numbers are invented.
const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = uuid(1), B = uuid(2), C = uuid(20), D = uuid(21), E = uuid(22), NOW = Date.parse('2026-10-12T08:00:00Z');
const building = (id = A, fields = {}) => ({ id, name: 'Tòa cùng tên', code: 'SYNTHETIC', district: null, ward: null, address: 'Đường Thử, Phường 1',
  public_contact_name: null, public_contact_phone: null, public_lift_type: null,
  page_contact_name: 'Hotline thử', page_contact_phone: '0900000001', page_sale_policy: 'Chính sách chung thử', ...fields });
const room = (id = uuid(3), building_id = A, fields = {}) => ({ id, building_id, code: 'P101', name: 'Phòng thử', floor: 1,
  area: 25.5, rent_price: 4000000, deposit_amount: 8000000, amenities: [], description: null, sale_note: null, room_type: null,
  status_public: 'free', sale_state: 'READY', sale_today: '2026-10-12', avail_date: null, expected_ready_on: null,
  pass_contact_name: null, pass_contact_phone: null, pass_sale_policy: null, pass_price: null, pass_avail_date: null,
  pass_contact_manager: false, ...fields });
const payload = (rooms, buildings) => ({ pages: 1, rooms: rooms ?? [room()], buildings: buildings ?? [building(), building(B)] });
const options = values => ({ allowedBuildingIds: [A], readAt: NOW, ...values });
const project = (data = payload(), config = options()) => projectAvailableRooms(data, config);
const code = expected => error => error.code === expected;

test('sale page list: vacant rooms and both customer-pass rooms, contact exactly as the public page prints it', () => {
  const data = payload([
    room(uuid(3), A, { code: 'A1', rent_price: 3000000 }),
    room(uuid(4), C, { code: 'C1', rent_price: 3100000, amenities: ['Máy lạnh', { name: 'Tủ lạnh' }], room_type: 'Gác', sale_note: ' Khuyến mãi thử ' }),
    room(uuid(5), D, { code: 'D1', rent_price: 3200000, description: 'Mô tả thử' }),
    // contact_manager: the reader already nulled the customer's name/phone.
    room(uuid(6), E, { code: 'E1', rent_price: 3300000, status_public: 'pass', sale_state: 'PASS', pass_price: 2900000,
      pass_contact_manager: true, pass_sale_policy: 'Chính sách khách thử' }),
    room(uuid(7), B, { code: 'B1', rent_price: 3400000, status_public: 'pass', sale_state: 'PASS', pass_price: 2800000,
      pass_contact_manager: false, pass_contact_phone: '0900000002', pass_contact_name: 'Khách Thử', pass_avail_date: '2026-10-20' }),
  ], [building(), building(B), building(C, { public_contact_name: 'Quản lý C', public_contact_phone: '0900000003' }), building(D), building(E)]);
  const out = project(data, options({ allowedBuildingIds: [A, B, C, D, E] }));
  assert.equal(out.source, 'hermes_sale_listing_rooms_v1'); assert.equal(out.publishedPages, 1); assert.equal(out.totalInSnapshot, 5);
  assert.deepEqual(out.rooms.map(r => [r.code, r.status, r.priceVnd]),
    [['A1', 'free', 3000000], ['C1', 'free', 3100000], ['D1', 'free', 3200000], ['E1', 'pass', 2900000], ['B1', 'pass', 2800000]]);
  const [a, c, d, admin, customer] = out.rooms;
  assert.deepEqual(a.statusLines, ['TRỐNG SẴN']); assert.deepEqual(a.availability, { kind: 'ready', label: 'Trống sẵn', availableOn: null });
  assert.equal(c.roomType, 'Phòng 26m², Gác'); assert.equal(c.amenities, 'Máy lạnh, Tủ lạnh'); assert.equal(c.salePolicy, 'Khuyến mãi thử');
  assert.equal(d.amenities, 'Mô tả thử'); assert.equal(d.salePolicy, null);
  assert.deepEqual(admin.availability, { kind: 'pass', label: 'Khách pass phòng · Liên hệ admin iHome mở cửa', availableOn: null });
  assert.deepEqual(admin.statusLines, ['KHÁCH PASS PHÒNG', 'LIÊN HỆ ADMIN IHOME MỞ CỬA']);
  assert.equal(admin.rentVnd, 3300000); assert.equal(admin.salePolicy, 'Chính sách khách thử');
  assert.deepEqual(customer.availability, { kind: 'pass', label: 'Khách pass phòng: 0900000002 (Khách Thử)', availableOn: '2026-10-20' });
  assert.deepEqual(customer.statusLines, ['KHÁCH PASS PHÒNG:', '0900000002 (Khách Thử)']);
  assert.deepEqual(out.buildings.find(b => b.id === C).contact, { name: 'Quản lý C', phone: '0900000003' });
  assert.deepEqual(out.buildings.find(b => b.id === A).contact, { name: 'Hotline thử', phone: '0900000001' });
  assert.deepEqual(out.salePolicies, ['Chính sách chung thử']);
});
test('assistant scope filters by building ID even when names match; media and internal fields never cross', () => {
  const out = project(payload([room(uuid(3), A, { images: ['https://example.invalid/private'], sale_bonus_note: 'PRIVATE_BONUS',
    sale_lock: { id: uuid(9) }, sale_status_note: 'PRIVATE_STATUS', token: 'PRIVATE_TOKEN' }), room(uuid(4), B, { name: 'PRIVATE_FOREIGN', code: 'PRIVATE_FOREIGN' })],
  [building(A, { floor_layouts: { 1: 'PRIVATE_LAYOUT' }, images: ['https://example.invalid/b'] }), building(B, { name: 'Tòa cùng tên', address: 'PRIVATE_ADDRESS' })]));
  assert.equal(out.rooms.length, 1); assert.equal(out.rooms[0].building.id, A);
  assert.deepEqual(out.buildings.map(b => b.id), [A]);
  assert(!JSON.stringify(out).includes('PRIVATE')); assert(!JSON.stringify(out).includes('example.invalid'));
  assert.deepEqual(Object.keys(out.rooms[0]), ['id', 'code', 'name', 'building', 'floor', 'areaM2', 'priceVnd', 'rentVnd', 'depositVnd', 'status',
    'availability', 'statusLines', 'roomType', 'amenities', 'salePolicy']);
});
test('reuse CRM sale facts for ready, preparing, future notice and overdue notice', () => {
  const out = project(payload([
    room(uuid(3)), room(uuid(4), A, { sale_state: 'PREPARING', expected_ready_on: '2026-10-15' }),
    room(uuid(5), A, { status_public: 'soon', sale_state: 'NOTICE', avail_date: '2026-10-16' }),
    room(uuid(6), A, { status_public: 'soon', sale_state: 'NOTICE_OVERDUE', avail_date: '2026-10-11' }),
  ]));
  assert.deepEqual(out.rooms.map(r => r.availability.kind), ['ready', 'preparing', 'notice', 'confirm_notice']);
  assert.equal(out.rooms[1].availability.availableOn, '2026-10-15');
  assert.deepEqual(out.rooms[2].statusLines, ['SẮP TRỐNG · 16/10/2026']);
  assert.equal(out.rooms[3].availability.availableOn, null);
});
test('money remains the backend value in VND; pass price falls back to rent; unknown values remain null', () => {
  const out = project(payload([room(uuid(3)), room(uuid(4), A, { area: null, rent_price: null, deposit_amount: null }),
    room(uuid(5), A, { status_public: 'pass', pass_price: null })]));
  assert.equal(out.currency, 'VND'); assert.equal(out.rooms[0].priceVnd, 4000000); assert.equal(out.rooms[0].depositVnd, 8000000);
  assert.equal(out.rooms[1].priceVnd, null); assert.equal(out.rooms[1].areaM2, null); assert.equal(out.rooms[1].roomType, null);
  assert.equal(out.rooms[2].priceVnd, 4000000);
});
test('no scope, wildcard, names and malformed IDs never become org-wide reads', () => {
  assert.throws(() => project(payload(), options({ allowedBuildingIds: [] })), code('rooms_scope_empty'));
  for (const allowedBuildingIds of [null, ['*'], ['Tòa cùng tên'], [A, A], ['not-an-id'], Array(1)]) {
    assert.throws(() => project(payload(), options({ allowedBuildingIds })), code('rooms_projection_request_invalid'));
  }
});
test('no live share link is reported as no_sale_page, never as an empty published list', () => {
  const none = project({ pages: 0, rooms: [], buildings: [] });
  assert.deepEqual([none.listing, none.publishedPages, none.totalInSnapshot], ['no_sale_page', 0, 0]);
  assert.match(none.notice, /chưa có trang Sale phòng\/link chia sẻ còn hiệu lực/); assert.match(none.notice, /không phải là hết phòng/);
  const empty = project({ pages: 1, rooms: [], buildings: [] });
  assert.deepEqual([empty.listing, empty.notice, empty.totalInSnapshot], ['published', null, 0]);
  assert.deepEqual([project().listing, project().notice], ['published', null]);
});
test('valid empty response is distinguished from malformed/error payload, old source shape and unknown status', () => {
  const out = project({ pages: 0, rooms: [], buildings: [] });
  assert.equal(out.totalInSnapshot, 0); assert.equal(out.completeness, 'complete'); assert.equal(out.publishedPages, 0);
  for (const data of [null, { error: 'permission_denied' }, { pages: 1, rooms: [], buildings: [], error: 'not_permitted' },
    { pages: 1, rooms: null, buildings: [] }, { rooms: [], buildings: [] }, { pages: -1, rooms: [], buildings: [] },
    payload([room(uuid(3), A, { status_public: 'rented' })]), payload([room(uuid(3), A, { status_public: 'unknown' })])]) {
    assert.throws(() => project(data), code('rooms_response_invalid'));
  }
});
test('reject missing relation, duplicate room or duplicate building instead of inventing a complete list', () => {
  for (const data of [{ ...payload(), buildings: [] }, payload([room(), room()]), payload(undefined, [building(), building()])]) {
    assert.throws(() => project(data), code('rooms_response_invalid'));
  }
});
test('strict quantities, flags and dates fail closed; no coercion of missing/bad data to zero or today', () => {
  for (const fields of [{ rent_price: '4000000' }, { rent_price: -1 }, { area: Infinity }, { deposit_amount: Number.MAX_SAFE_INTEGER + 1 },
    { floor: '1' }, { sale_today: '2026-02-30' }, { expected_ready_on: 'tomorrow' }, { name: null }, { pass_price: -1 },
    { pass_contact_manager: 'true' }, { pass_avail_date: '2026-13-01' }, { sale_note: 1 }, { description: ['x'] }, { pass_contact_phone: 9 }]) {
    assert.throws(() => project(payload([room(uuid(3), A, fields)])), code('rooms_response_invalid'));
  }
});
test('over-long public text is clipped with "…" instead of failing the whole company list', () => {
  const long = n => 'x'.repeat(n);
  const out = project(payload([
    room(uuid(3), A, { sale_note: long(5000), description: long(9000), room_type: long(400), amenities: Array(500).fill('Máy lạnh') }),
    room(uuid(4), A, { status_public: 'pass', pass_contact_phone: long(300), pass_contact_name: long(300), pass_sale_policy: long(5000) }),
  ], [building(A, { address: long(2000), page_contact_name: long(400), page_contact_phone: long(400), page_sale_policy: long(3000) })]));
  const [first, pass] = out.rooms, [b] = out.buildings;
  assert.equal(out.totalInSnapshot, 2);
  for (const value of [first.salePolicy, pass.salePolicy]) { assert.equal(value.length, 240); assert(value.endsWith('…')); }
  assert.equal(first.amenities.length, 240); assert.equal(first.roomType.length, 'Phòng 26m², '.length + 120);
  assert.equal(pass.availability.label, `Khách pass phòng: ${long(79)}… (${long(79)}…)`);
  assert.deepEqual([b.address.length, b.contact.name.length, b.contact.phone.length], [300, 120, 64]);
  assert.equal(out.salePolicies[0].length, 2000);
  assert(Buffer.byteLength(JSON.stringify(out)) < 16_384, 'clipped page stays within the default tool result limit');
});
test('pagination keeps the page order and reports the source cap without claiming all rooms were returned', () => {
  const data = payload(Array.from({ length: 2000 }, (_, i) => room(uuid(10 + i))));
  const out = project(data, options({ offset: 1, limit: 2 }));
  assert.deepEqual(out.rooms.map(r => r.id), [uuid(11), uuid(12)]);
  assert.equal(out.totalInSnapshot, 2000); assert.equal(out.nextOffset, 3); assert.equal(out.completeness, 'source_capped');
  assert.equal(out.readAt, '2026-10-12T08:00:00.000Z');
  assert.equal(project(data, options({ offset: 1999, limit: 2 })).nextOffset, null);
  assert.throws(() => project(payload(Array.from({ length: 2001 }, (_, i) => room(uuid(10 + i))))), code('rooms_response_invalid'));
});
test('building-name filter cannot expand ID scope; request and response are independent objects', () => {
  const data = payload([room(), room(uuid(4), B)]), config = options({ buildingName: 'CÙNG' });
  const out = project(data, config); assert.equal(out.rooms.length, 1);
  out.rooms[0].building.name = 'changed'; out.buildings[0].contact.name = 'changed';
  assert.equal(data.buildings[0].name, 'Tòa cùng tên'); assert.equal(data.buildings[0].page_contact_name, 'Hotline thử');
  assert.deepEqual(config.allowedBuildingIds, [A]);
  assert.equal(project(data, options({ buildingName: 'nonexistent' })).totalInSnapshot, 0);
});
test('caller cannot forward actor, org, RPC, URLs or an unbounded result request through options', () => {
  for (const change of [{ organizationId: A }, { userId: A }, { rpc: 'other' }, { limit: 101 }, { offset: -1 },
    { readAt: 0 }, { readAt: Number.MAX_SAFE_INTEGER }, { buildingName: 'A'.repeat(121) }]) {
    assert.throws(() => project(payload(), options(change)), code('rooms_projection_request_invalid'));
  }
});
