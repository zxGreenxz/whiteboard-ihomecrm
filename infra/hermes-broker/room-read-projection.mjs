import { roomSaleFacts, roomSaleListedPrice, roomSalePassLabel, roomSalePassStatusLines, ROOM_SALE_LISTED_STATUSES }
  from '../../src/lib/roomSaleFacts.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && UUID.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const invalid = () => fail('rooms_response_invalid');
// Bounded tool output: long free text keeps its start; the page itself is unchanged.
// One over-long public text never fails the whole company's list.
const CELL = 240;
// Pass contact shortening must stay identical to SQL hermes_group_room_fact_v1 (20261016085117).
export const PASS_CONTACT_CHARS = 80;
export const NO_SALE_PAGE_NOTICE = 'Công ty chưa có trang Sale phòng/link chia sẻ còn hiệu lực nên không có danh sách phòng đang đăng. Đây không phải là hết phòng.';
/** Deepest offset the tool accepts; a page read beyond it is reported as source_capped. */
export const MAX_OFFSET = 2000;
export const PAGE_SOURCE = 'hermes_available_rooms_page_v1';
const PAGE_RESULT_KEYS = ['publishedPages', 'totalCount', 'offset', 'limit', 'nextOffset', 'rooms', 'buildings', 'salePolicies'];
const PAGE_ROOM_KEYS = ['id', 'building_id', 'floor', 'name', 'code', 'area', 'rent_price', 'deposit_amount', 'amenities', 'description',
  'sale_note', 'room_type', 'status_public', 'sale_state', 'avail_date', 'sale_today', 'expected_ready_on', 'pass_contact_name',
  'pass_contact_phone', 'pass_sale_policy', 'pass_price', 'pass_avail_date', 'pass_contact_manager'];
const PAGE_BUILDING_KEYS = ['id', 'name', 'code', 'address', 'public_contact_name', 'public_contact_phone', 'page_contact_name', 'page_contact_phone'];
const clip = (value, cap) => value.length > cap ? `${value.slice(0, cap - 1)}…` : value;
const cell = value => clip(value, CELL);
/** Public free text: null stays null, a non-string is malformed, a long string is clipped. */
function freeText(value, cap) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') invalid();
  return clip(value, cap);
}
function text(value, cap, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || value.length > cap) invalid();
  return value;
}
function number(value, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) invalid();
  return value;
}
function flag(value) {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'boolean') invalid();
  return value;
}
function day(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid();
  return value;
}
// Same reading of rooms.amenities as the sale page (supabaseData toAmenities).
function amenityList(raw) {
  if (Array.isArray(raw)) {
    return raw.slice(0, 200).map(item => typeof item === 'string' ? item : record(item) ? String(item.name ?? item.label ?? '') : String(item)).filter(Boolean);
  }
  if (record(raw)) return Object.keys(raw).filter(key => raw[key]);
  return [];
}
/** One public building row (either source) into the fixed card/table shape. */
function buildingView(row) {
  const pageName = freeText(row.page_contact_name, 120)?.trim() || '', pagePhone = freeText(row.page_contact_phone, 64)?.trim() || '';
  const policy = freeText(row.page_sale_policy, 2000)?.trim();
  // Card/table contact: the building's own manager first, else the page hotline.
  const name = freeText(row.public_contact_name, 120)?.trim() || pageName, phone = freeText(row.public_contact_phone, 64)?.trim() || pagePhone;
  return { building: { id: row.id, name: text(row.name, 500), code: text(row.code, 256, true) },
    detail: { id: row.id, name: row.name, code: row.code, address: freeText(row.address, 300), contact: { name: name || null, phone: phone || null } },
    policy: policy || null };
}
/** One listed room row (either source) into the fixed tool shape; owner is its building view. */
function roomView(row, owner) {
  if (!ROOM_SALE_LISTED_STATUSES.includes(row.status_public)) invalid();
  if (!(row.floor === null || (Number.isSafeInteger(row.floor) && row.floor >= -100 && row.floor <= 1000))) invalid();
  const status = row.status_public, area = number(row.area, true), rent = number(row.rent_price, true);
  const pass = status === 'pass', contact = { contactManager: flag(row.pass_contact_manager),
    phone: freeText(row.pass_contact_phone, PASS_CONTACT_CHARS) || null, name: freeText(row.pass_contact_name, PASS_CONTACT_CHARS) || null };
  const fact = roomSaleFacts({ status, state: text(row.sale_state, 64, true),
    today: day(row.sale_today), availableOn: day(row.avail_date), expectedReadyOn: day(row.expected_ready_on) });
  const passPrice = number(row.pass_price, true), passOn = day(row.pass_avail_date);
  const type = freeText(row.room_type, 120)?.trim(), description = freeText(row.description, CELL)?.trim();
  const saleNote = freeText(row.sale_note, CELL)?.trim(), passPolicy = freeText(row.pass_sale_policy, CELL)?.trim();
  const roundedArea = Math.round(area ?? 0);
  return { id: row.id, code: text(row.code, 256, true), name: text(row.name, 500),
    building: { ...owner.building }, floor: row.floor, areaM2: area,
    priceVnd: roomSaleListedPrice(status, rent, passPrice), rentVnd: rent, depositVnd: number(row.deposit_amount, true), status,
    availability: pass ? { kind: 'pass', label: roomSalePassLabel(contact), availableOn: passOn }
      : { kind: fact.kind, label: fact.label, availableOn: fact.availableOn },
    // Columns of the "DANH SÁCH PHÒNG TRỐNG" table (roomListTable): TÌNH TRẠNG,
    // LOẠI PHÒNG, NỘI THẤT and CHÍNH SÁCH SALE as the page prints them.
    statusLines: pass ? roomSalePassStatusLines(contact) : [fact.label.toLocaleUpperCase('vi-VN')],
    roomType: [roundedArea > 0 ? `Phòng ${roundedArea}m²` : '', type || ''].filter(Boolean).join(', ') || null,
    amenities: cell(amenityList(row.amenities).join(', ').trim() || description || '') || null,
    salePolicy: cell(saleNote || (pass ? passPolicy : '') || '') || null };
}
function pageWindow(offset, limit) {
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('rooms_projection_request_invalid');
}
function readAt(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000_000) fail('rooms_projection_request_invalid');
  return new Date(value).toISOString();
}

/** Pure output projection for hermes_sale_listing_rooms_v1, NOT authorization.
 * The caller must first map the assistant's authorization_scopes IDs to BUILDING
 * IDs and intersect with the current rooms.view CRM scope in the selected org.
 * Never supply raw scope IDs, names, a wildcard or a union of other permissions.
 * The caller owns JWT RPC execution, rollout and final live authorization checks.
 * This module exposes no tool and performs no DB/model/network operation.
 *
 * The source is the company's published sale page (get_public_available_rooms per
 * live share link), so the rooms are exactly those the page lists: vacant, soon
 * vacant and customer-pass rooms. Price, type, furniture and sale policy columns
 * follow the "Danh sách phòng trống" table through the shared sale formatter; the
 * status text is the automatic one the public link shows (a TÌNH TRẠNG typed in the
 * app is not part of the public reader). Pass contact is only what the public page
 * prints (contact_manager hides it). pages=0 means no live share link: listing is
 * 'no_sale_page', which is not the same as "no rooms".
 * Images/URLs, floor plans and internal notes never reach this payload.
 * The source RPC has a 2,000-row cap; reaching it is explicitly incomplete.
 */
export function projectAvailableRooms(payload, options) {
  if (!record(options) || Object.keys(options).some(key => !['allowedBuildingIds', 'buildingName', 'offset', 'limit', 'readAt'].includes(key)) ||
      !Array.isArray(options.allowedBuildingIds) || options.allowedBuildingIds.length > 2000 ||
      Array.from(options.allowedBuildingIds).some(value => !id(value)) ||
      new Set(options.allowedBuildingIds).size !== options.allowedBuildingIds.length) fail('rooms_projection_request_invalid');
  const at = readAt(options.readAt);
  if (options.allowedBuildingIds.length === 0) fail('rooms_scope_empty');
  const offset = options.offset ?? 0, limit = options.limit ?? 50, query = options.buildingName ?? '';
  pageWindow(offset, limit);
  if (typeof query !== 'string' || query.length > 120) fail('rooms_projection_request_invalid');
  if (!record(payload) || ['error', 'error_code', 'error_description'].some(key => Object.hasOwn(payload, key)) ||
      !Number.isSafeInteger(payload.pages) || payload.pages < 0 || payload.pages > 1000 ||
      !Array.isArray(payload.buildings) || !Array.isArray(payload.rooms) ||
      payload.buildings.length > 2000 || payload.rooms.length > 2000) invalid();
  const allowed = new Set(options.allowedBuildingIds), buildings = new Map(), policies = new Set();
  for (const row of payload.buildings) {
    if (!record(row) || !id(row.id)) invalid();
    if (!allowed.has(row.id)) continue;
    if (buildings.has(row.id)) invalid();
    buildings.set(row.id, buildingView(row));
  }
  const rooms = [], seen = new Set();
  for (const row of payload.rooms) {
    if (!record(row) || !id(row.id) || !id(row.building_id)) invalid();
    if (!allowed.has(row.building_id)) continue;
    if (seen.has(row.id)) invalid();
    seen.add(row.id);
    const owner = buildings.get(row.building_id);
    if (!owner || !ROOM_SALE_LISTED_STATUSES.includes(row.status_public)) invalid();
    if (!owner.building.name.toLowerCase().includes(query.toLowerCase())) continue;
    rooms.push(roomView(row, owner));
    if (owner.policy) policies.add(owner.policy);
  }
  const next = offset + limit, page = rooms.slice(offset, next);
  const used = new Set(page.map(room => room.building.id));
  return {
    source: 'hermes_sale_listing_rooms_v1', readAt: at, currency: 'VND',
    completeness: payload.rooms.length === 2000 || payload.buildings.length === 2000 ? 'source_capped' : 'complete',
    listing: payload.pages > 0 ? 'published' : 'no_sale_page',
    notice: payload.pages > 0 ? null : NO_SALE_PAGE_NOTICE,
    publishedPages: payload.pages, totalInSnapshot: rooms.length, offset, nextOffset: next < rooms.length ? next : null,
    salePolicies: [...policies],
    buildings: [...buildings.values()].filter(row => used.has(row.detail.id)).map(row => structuredClone(row.detail)),
    rooms: page,
  };
}

/** Pure output projection of ONE page from hermes_available_rooms_page_v1.result, NOT
 * authorization: the RPC already admitted the connection, derived the building set
 * from rooms.view and the assistant scope, applied the sale-page rules, the building
 * name filter, the status filter and the page window in SQL. This function never
 * re-slices: the rows are the page; totalCount is the whole filtered set. Every row
 * goes through the same formatter as the legacy projection, so a page equals the
 * matching slice of projectAvailableRooms over the same data (parity test).
 * A total above the deepest tool offset is reported as source_capped: the count is
 * exact, but the tool cannot page past offset 2000.
 */
export function projectAvailableRoomsPage(payload, options) {
  if (!exact(options, ['offset', 'limit', 'readAt'])) fail('rooms_projection_request_invalid');
  const { offset, limit } = options, at = readAt(options.readAt);
  pageWindow(offset, limit);
  if (!exact(payload, PAGE_RESULT_KEYS) || payload.offset !== offset || payload.limit !== limit ||
      !Number.isSafeInteger(payload.publishedPages) || payload.publishedPages < 0 || payload.publishedPages > 1000 ||
      !Number.isSafeInteger(payload.totalCount) || payload.totalCount < 0 ||
      !Array.isArray(payload.rooms) || !Array.isArray(payload.buildings) || !Array.isArray(payload.salePolicies) ||
      payload.rooms.length !== Math.min(limit, Math.max(0, payload.totalCount - offset)) ||
      payload.buildings.length > payload.rooms.length || payload.salePolicies.length > 1000 ||
      (payload.publishedPages === 0 && payload.totalCount !== 0)) invalid();
  const next = offset + limit, expectedNext = next < payload.totalCount && next <= MAX_OFFSET ? next : null;
  if (payload.nextOffset !== expectedNext) invalid();
  const buildings = new Map();
  for (const row of payload.buildings) {
    if (!exact(row, PAGE_BUILDING_KEYS) || !id(row.id) || buildings.has(row.id)) invalid();
    buildings.set(row.id, buildingView(row));
  }
  const rooms = [], seen = new Set(), used = new Set();
  for (const row of payload.rooms) {
    if (!exact(row, PAGE_ROOM_KEYS) || !id(row.id) || !id(row.building_id) || seen.has(row.id)) invalid();
    seen.add(row.id);
    const owner = buildings.get(row.building_id);
    if (!owner) invalid();
    used.add(row.building_id);
    rooms.push(roomView(row, owner));
  }
  // Only buildings of this page, in the SQL order; a building without a page room is malformed.
  if (used.size !== buildings.size) invalid();
  const policies = new Set();
  for (const policy of payload.salePolicies) {
    const value = text(policy, 2000).trim();
    if (value) policies.add(value);
  }
  return {
    source: PAGE_SOURCE, readAt: at, currency: 'VND',
    completeness: payload.totalCount > MAX_OFFSET ? 'source_capped' : 'complete',
    listing: payload.publishedPages > 0 ? 'published' : 'no_sale_page',
    notice: payload.publishedPages > 0 ? null : NO_SALE_PAGE_NOTICE,
    publishedPages: payload.publishedPages, totalInSnapshot: payload.totalCount, offset, nextOffset: expectedNext,
    salePolicies: [...policies],
    buildings: [...buildings.values()].map(row => structuredClone(row.detail)),
    rooms,
  };
}
