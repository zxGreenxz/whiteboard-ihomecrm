import { roomSaleFacts, roomSaleListedPrice, roomSalePassLabel, roomSalePassStatusLines, ROOM_SALE_LISTED_STATUSES }
  from '../../src/lib/roomSaleFacts.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && UUID.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const invalid = () => fail('rooms_response_invalid');
// Bounded tool output: long free text keeps its start; the page itself is unchanged.
const CELL = 240;
const cell = value => value.length > CELL ? `${value.slice(0, CELL - 1)}…` : value;
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
    if (raw.length > 200) invalid();
    return raw.map(item => typeof item === 'string' ? item : record(item) ? String(item.name ?? item.label ?? '') : String(item)).filter(Boolean);
  }
  if (record(raw)) return Object.keys(raw).filter(key => raw[key]);
  return [];
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
 * vacant and customer-pass rooms. Columns mirror the "Danh sách phòng trống" image
 * (price, type, furniture, sale policy, status) through the shared sale formatter;
 * pass contact is only what the public page prints (contact_manager hides it).
 * Images/URLs, floor plans and internal notes never reach this payload.
 * The source RPC has a 2,000-row cap; reaching it is explicitly incomplete.
 */
export function projectAvailableRooms(payload, options) {
  if (!record(options) || Object.keys(options).some(key => !['allowedBuildingIds', 'buildingName', 'offset', 'limit', 'readAt'].includes(key)) ||
      !Array.isArray(options.allowedBuildingIds) || options.allowedBuildingIds.length > 2000 ||
      Array.from(options.allowedBuildingIds).some(value => !id(value)) ||
      new Set(options.allowedBuildingIds).size !== options.allowedBuildingIds.length ||
      !Number.isSafeInteger(options.readAt) || options.readAt <= 0 || options.readAt > 8_640_000_000_000_000) fail('rooms_projection_request_invalid');
  if (options.allowedBuildingIds.length === 0) fail('rooms_scope_empty');
  const offset = options.offset ?? 0, limit = options.limit ?? 50, query = options.buildingName ?? '';
  if (!Number.isInteger(offset) || offset < 0 || offset > 2000 || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      typeof query !== 'string' || query.length > 120) fail('rooms_projection_request_invalid');
  if (!record(payload) || ['error', 'error_code', 'error_description'].some(key => Object.hasOwn(payload, key)) ||
      !Number.isSafeInteger(payload.pages) || payload.pages < 0 || payload.pages > 1000 ||
      !Array.isArray(payload.buildings) || !Array.isArray(payload.rooms) ||
      payload.buildings.length > 2000 || payload.rooms.length > 2000) invalid();
  const allowed = new Set(options.allowedBuildingIds), buildings = new Map(), policies = new Set();
  for (const row of payload.buildings) {
    if (!record(row) || !id(row.id)) invalid();
    if (!allowed.has(row.id)) continue;
    if (buildings.has(row.id)) invalid();
    const pageName = text(row.page_contact_name, 256, true)?.trim() || '', pagePhone = text(row.page_contact_phone, 256, true)?.trim() || '';
    const policy = text(row.page_sale_policy, 2000, true)?.trim();
    // Card/table contact: the building's own manager first, else the page hotline.
    const name = text(row.public_contact_name, 256, true)?.trim() || pageName, phone = text(row.public_contact_phone, 256, true)?.trim() || pagePhone;
    buildings.set(row.id, { building: { id: row.id, name: text(row.name, 500), code: text(row.code, 256, true) },
      detail: { id: row.id, name: row.name, code: row.code, address: text(row.address, 1000, true), contact: { name: name || null, phone: phone || null } },
      policy: policy || null });
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
    if (!(row.floor === null || (Number.isSafeInteger(row.floor) && row.floor >= -100 && row.floor <= 1000))) invalid();
    const status = row.status_public, area = number(row.area, true), rent = number(row.rent_price, true);
    const pass = status === 'pass', contact = { contactManager: flag(row.pass_contact_manager),
      phone: text(row.pass_contact_phone, 256, true) || null, name: text(row.pass_contact_name, 256, true) || null };
    const fact = roomSaleFacts({ status, state: text(row.sale_state, 64, true),
      today: day(row.sale_today), availableOn: day(row.avail_date), expectedReadyOn: day(row.expected_ready_on) });
    const passPrice = number(row.pass_price, true), passOn = day(row.pass_avail_date);
    const type = text(row.room_type, 256, true)?.trim(), description = text(row.description, 8000, true)?.trim();
    const saleNote = text(row.sale_note, 4000, true)?.trim(), passPolicy = text(row.pass_sale_policy, 4000, true)?.trim();
    const roundedArea = Math.round(area ?? 0);
    rooms.push({ id: row.id, code: text(row.code, 256, true), name: text(row.name, 500),
      building: { ...owner.building }, floor: row.floor, areaM2: area,
      priceVnd: roomSaleListedPrice(status, rent, passPrice), rentVnd: rent, depositVnd: number(row.deposit_amount, true), status,
      availability: pass ? { kind: 'pass', label: roomSalePassLabel(contact), availableOn: passOn }
        : { kind: fact.kind, label: fact.label, availableOn: fact.availableOn },
      // Columns of the "DANH SÁCH PHÒNG TRỐNG" table (roomListTable): TÌNH TRẠNG,
      // LOẠI PHÒNG, NỘI THẤT and CHÍNH SÁCH SALE as the page prints them.
      statusLines: pass ? roomSalePassStatusLines(contact) : [fact.label.toLocaleUpperCase('vi-VN')],
      roomType: [roundedArea > 0 ? `Phòng ${roundedArea}m²` : '', type || ''].filter(Boolean).join(', ') || null,
      amenities: cell(amenityList(row.amenities).join(', ').trim() || description || '') || null,
      salePolicy: cell(saleNote || (pass ? passPolicy : '') || '') || null });
    if (owner.policy) policies.add(owner.policy);
  }
  const next = offset + limit, page = rooms.slice(offset, next);
  const used = new Set(page.map(room => room.building.id));
  return {
    source: 'hermes_sale_listing_rooms_v1', readAt: new Date(options.readAt).toISOString(), currency: 'VND',
    completeness: payload.rooms.length === 2000 || payload.buildings.length === 2000 ? 'source_capped' : 'complete',
    publishedPages: payload.pages, totalInSnapshot: rooms.length, offset, nextOffset: next < rooms.length ? next : null,
    salePolicies: [...policies],
    buildings: [...buildings.values()].filter(row => used.has(row.detail.id)).map(row => structuredClone(row.detail)),
    rooms: page,
  };
}
