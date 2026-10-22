import assert from 'node:assert/strict';
import test from 'node:test';
import { projectAvailableRooms, projectAvailableRoomsPage, MAX_OFFSET, PAGE_SOURCE } from './room-read-projection.mjs';

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

// ── B3 page projection (hermes_available_rooms_page_v1.result) ─────────────────────────
const PAGE_ROOM_KEYS = ['id', 'building_id', 'floor', 'name', 'code', 'area', 'rent_price', 'deposit_amount', 'amenities', 'description', 'sale_note', 'room_type',
  'status_public', 'sale_state', 'avail_date', 'sale_today', 'expected_ready_on', 'pass_contact_name', 'pass_contact_phone', 'pass_sale_policy', 'pass_price',
  'pass_avail_date', 'pass_contact_manager'];
const PAGE_BUILDING_KEYS = ['id', 'name', 'code', 'address', 'public_contact_name', 'public_contact_phone', 'page_contact_name', 'page_contact_phone'];
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const floorDesc = (a, b) => a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a;
/** What the SQL page returns for a legacy payload that is already in the wrapper's canonical
 * order: the same owner/status rules, name filter, order and window the legacy JS applies. */
function sqlPage(legacy, { allowedBuildingIds, buildingName = '', offset = 0, limit = 50 }) {
  const blds = new Map(legacy.buildings.filter(b => allowedBuildingIds.includes(b.id)).map(b => [b.id, b]));
  const listed = legacy.rooms.filter(r => blds.has(r.building_id) && ['free', 'soon', 'pass'].includes(r.status_public) &&
    blds.get(r.building_id).name.toLowerCase().includes(buildingName.toLowerCase()))
    .sort((x, y) => { const bx = blds.get(x.building_id), by = blds.get(y.building_id);
      return cmp(bx.name, by.name) || cmp(bx.id, by.id) || floorDesc(x.floor, y.floor) || cmp(x.name, y.name) || cmp(x.id, y.id); });
  const rows = listed.slice(offset, offset + limit), used = new Set(rows.map(r => r.building_id)), next = offset + limit, policies = [];
  for (const r of listed) { const p = blds.get(r.building_id).page_sale_policy?.trim(); if (p && !policies.includes(p)) policies.push(p); }
  return { publishedPages: legacy.pages, totalCount: listed.length, offset, limit, nextOffset: next < listed.length && next <= MAX_OFFSET ? next : null,
    rooms: rows.map(r => Object.fromEntries(PAGE_ROOM_KEYS.map(k => [k, r[k] ?? null]))),
    buildings: [...blds.values()].filter(b => used.has(b.id)).sort((x, y) => cmp(x.name, y.name) || cmp(x.id, y.id)).map(b => Object.fromEntries(PAGE_BUILDING_KEYS.map(k => [k, b[k] ?? null]))),
    salePolicies: policies };
}
const strip = ({ source, ...rest }) => rest;
const B1 = uuid(31), B2 = uuid(32), B3 = uuid(33), B4 = uuid(34), B5 = uuid(35);
// Canonical wrapper order: building name then id, floor desc nulls last, room name, id.
function canonical() {
  return {
    pages: 2,
    buildings: [building(B1, { name: 'Tòa 1', page_sale_policy: 'Chính sách X' }), building(B2, { name: 'Tòa 2', page_sale_policy: 'Chính sách X', public_contact_name: 'Quản lý 2', public_contact_phone: '0900000022' }),
      building(B3, { name: 'Tòa 2', code: null, address: null, page_sale_policy: 'Chính sách X' }), building(B4, { name: 'Tòa chữ', page_sale_policy: ' Chính sách Y ' }),
      building(B5, { name: 'Tòa ẩn', page_sale_policy: 'Hidden' })],
    rooms: [
      room(uuid(41), B1, { code: 'P301', floor: 3, status_public: 'pass', sale_state: 'PASS', pass_price: 2900000, pass_contact_manager: true, pass_sale_policy: 'Pass policy' }),
      room(uuid(42), B1, { code: 'P201', name: 'Phòng 201', floor: 2, status_public: 'soon', sale_state: 'NOTICE', avail_date: '2026-10-20', rent_price: 3100000 }),
      room(uuid(43), B1, { code: 'P202', name: 'Phòng 202', floor: 2, sale_note: ' Khuyến mãi ', amenities: [{ name: 'Tủ lạnh' }, 'Giường'] }),
      room(uuid(44), B1, { code: 'P101', floor: 1, status_public: 'pass', sale_state: 'PASS', pass_contact_phone: '0900000002', pass_contact_name: 'Khách Thử', pass_avail_date: '2026-10-25' }),
      room(uuid(45), B1, { code: 'Pnull', floor: null, area: null, rent_price: null, description: ' Mô tả ' }),
      room(uuid(46), B1, { code: 'P999', floor: 9, status_public: 'rented', sale_state: 'RENTED' }),
      room(uuid(47), B2, { code: 'P101', floor: 1, sale_state: 'PREPARING', expected_ready_on: '2026-10-30' }),
      room(uuid(48), B3, { code: 'P101', floor: 1 }),
      room(uuid(49), B4, { code: 'P1', floor: 1, status_public: 'soon', sale_state: 'NOTICE_OVERDUE', avail_date: '2026-10-01' }),
      room(uuid(50), B5, { code: 'HIDDEN', floor: 1 }),
    ],
  };
}
// The legacy wrapper never ships rented rows; the legacy JS rejects them. Compare on a wrapper-shaped payload.
const wrapperData = () => { const data = canonical(); data.rooms = data.rooms.filter(r => r.status_public !== 'rented'); return data; };
test('B3 page projection equals the legacy projection of the same canonical snapshot (states, contact, text, policies, paging)', () => {
  const data = wrapperData(), all = [B1, B2, B3, B4];
  for (const options of [{ allowedBuildingIds: all }, { allowedBuildingIds: all, offset: 1, limit: 2 }, { allowedBuildingIds: all, offset: 4, limit: 2 },
    { allowedBuildingIds: all, offset: 7, limit: 2 }, { allowedBuildingIds: all, offset: 8, limit: 2 }, { allowedBuildingIds: [B2, B3, B4], buildingName: 'tòa 2' },
    { allowedBuildingIds: all, buildingName: 'CHỮ' }, { allowedBuildingIds: [B1], buildingName: 'nope' }, { allowedBuildingIds: [B5] }, { allowedBuildingIds: all, limit: 1 }]) {
    const legacy = projectAvailableRooms(data, { readAt: NOW, ...options });
    const page = projectAvailableRoomsPage(sqlPage(canonical(), options), { offset: options.offset ?? 0, limit: options.limit ?? 50, readAt: NOW });
    assert.equal(page.source, PAGE_SOURCE); assert.equal(legacy.source, 'hermes_sale_listing_rooms_v1');
    assert.deepEqual(strip(page), strip(legacy), JSON.stringify(options));
  }
  const full = projectAvailableRoomsPage(sqlPage(canonical(), { allowedBuildingIds: all }), { offset: 0, limit: 50, readAt: NOW });
  assert.deepEqual(full.rooms.map(r => r.code), ['P301', 'P201', 'P202', 'P101', 'Pnull', 'P101', 'P101', 'P1']);
  assert.deepEqual(full.rooms.map(r => r.availability.kind), ['pass', 'notice', 'ready', 'pass', 'ready', 'preparing', 'ready', 'confirm_notice']);
  assert.deepEqual([full.totalInSnapshot, full.publishedPages, full.salePolicies, full.buildings.map(b => b.id)], [8, 2, ['Chính sách X', 'Chính sách Y'], [B1, B2, B3, B4]]);
  assert.deepEqual(full.buildings[1].contact, { name: 'Quản lý 2', phone: '0900000022' }); assert.deepEqual(full.buildings[2].contact, { name: 'Hotline thử', phone: '0900000001' });
  assert(!JSON.stringify(full).includes('Hidden') && !JSON.stringify(full).includes('HIDDEN'));
});
test('B3 page projection: exact total above the tool ceiling is source_capped, the window never re-slices and nextOffset stops at 2000', () => {
  const base = sqlPage(canonical(), { allowedBuildingIds: [B1, B2, B3, B4], limit: 2 });
  const at = (offset, limit, totalCount) => ({ ...base, offset, limit, totalCount, nextOffset: offset + limit < totalCount && offset + limit <= MAX_OFFSET ? offset + limit : null,
    rooms: base.rooms.slice(0, Math.min(limit, Math.max(0, totalCount - offset))), buildings: base.buildings.slice(0, 1) });
  const project = (offset, limit, totalCount) => projectAvailableRoomsPage(at(offset, limit, totalCount), { offset, limit, readAt: NOW });
  assert.deepEqual([project(0, 2, 2000).completeness, project(0, 2, 2001).completeness, project(0, 2, 2).completeness], ['complete', 'source_capped', 'complete']);
  assert.deepEqual([project(2000, 2, 2500).nextOffset, project(1998, 2, 2500).nextOffset, project(0, 2, 2500).nextOffset, project(0, 2, 2).nextOffset], [null, 2000, 2, null]);
  assert.deepEqual([project(2000, 2, 2500).totalInSnapshot, project(2000, 2, 2500).rooms.length, project(2000, 2, 2001).rooms.length], [2500, 2, 1]);
  assert.equal(projectAvailableRoomsPage({ ...at(0, 2, 0), buildings: [], rooms: [], salePolicies: [], publishedPages: 0 }, { offset: 0, limit: 2, readAt: NOW }).listing, 'no_sale_page');
});
test('B3 page projection fails closed on any shape drift of the SQL page instead of inventing rows', () => {
  const good = () => sqlPage(canonical(), { allowedBuildingIds: [B1, B2, B3, B4], limit: 3 });
  const options = { offset: 0, limit: 3, readAt: NOW };
  assert.equal(projectAvailableRoomsPage(good(), options).rooms.length, 3);
  for (const mutate of [v => { v.extra = 1; }, v => { delete v.salePolicies; }, v => { v.offset = 1; }, v => { v.limit = 2; }, v => { v.nextOffset = null; },
    v => { v.nextOffset = 4; }, v => { v.totalCount = 2; }, v => { v.totalCount = -1; }, v => { v.rooms.pop(); }, v => { v.buildings.push({ ...v.buildings[0], id: B5 }); },
    v => { v.rooms[0].building_id = B5; }, v => { v.rooms[1].id = v.rooms[0].id; }, v => { v.publishedPages = 0; }, v => { v.rooms[0].images = []; },
    v => { delete v.rooms[0].pass_contact_manager; }, v => { v.buildings[0].floor_layouts = {}; }, v => { v.rooms[0].status_public = 'rented'; },
    v => { v.salePolicies = [1]; }, v => { v.rooms[0].rent_price = '1'; }, v => { v.rooms[0].sale_today = '2026-02-30'; }, v => { v.buildings[0].name = 'x'.repeat(501); },
    v => { v.error = 'PRIVATE'; }, v => { v.rooms = null; }]) {
    const value = good(); mutate(value);
    assert.throws(() => projectAvailableRoomsPage(value, options), code('rooms_response_invalid'));
  }
  for (const bad of [{ offset: 0, limit: 3 }, { ...options, allowedBuildingIds: [B1] }, { ...options, offset: 2001 }, { ...options, limit: 101 }, { ...options, readAt: 0 }]) {
    assert.throws(() => projectAvailableRoomsPage(good(), bad), code('rooms_projection_request_invalid'));
  }
});
