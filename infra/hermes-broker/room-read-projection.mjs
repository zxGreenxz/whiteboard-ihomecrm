import { roomSaleFacts } from '../../src/lib/roomSaleFacts.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && UUID.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const invalid = () => fail('rooms_response_invalid');
function text(value, cap, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > cap) invalid();
  return value;
}
function number(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) invalid();
  return value;
}
function day(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid();
  return value;
}

/** Pure output projection for copilot_available_rooms_v1, NOT authorization.
 * The caller must first map the assistant's authorization_scopes IDs to BUILDING
 * IDs and intersect with the current rooms.view CRM scope in the selected org.
 * Never supply raw scope IDs, names, a wildcard or a union of other permissions.
 * The caller owns JWT RPC execution, rollout and final live authorization checks.
 * This module exposes no tool and performs no DB/model/network operation.
 *
 * Reuses the CRM sale-fact formatter; prices remain VND without recalculation.
 * Only free/soon rooms are returned, matching the existing phong_trong tool.
 * Policy text, images/URLs, contacts, descriptions and internal notes are excluded.
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
      !Array.isArray(payload.buildings) || !Array.isArray(payload.rooms) ||
      payload.buildings.length > 2000 || payload.rooms.length > 2000) invalid();
  const allowed = new Set(options.allowedBuildingIds), buildings = new Map();
  for (const row of payload.buildings) {
    if (!record(row) || !id(row.id)) invalid();
    if (!allowed.has(row.id)) continue;
    if (buildings.has(row.id)) invalid();
    buildings.set(row.id, { id: row.id, name: text(row.name, 500), code: text(row.code, 256, true) });
  }
  const rooms = [], seen = new Set();
  for (const row of payload.rooms) {
    if (!record(row) || !id(row.id) || !id(row.building_id)) invalid();
    if (!allowed.has(row.building_id)) continue;
    if (seen.has(row.id)) invalid();
    seen.add(row.id);
    const building = buildings.get(row.building_id);
    if (!building || !['free', 'soon', 'pass'].includes(row.status_public)) invalid();
    if (row.status_public === 'pass' || !building.name.toLowerCase().includes(query.toLowerCase())) continue;
    if (!(row.floor === null || (Number.isSafeInteger(row.floor) && row.floor >= -100 && row.floor <= 1000))) invalid();
    const fact = roomSaleFacts({ status: row.status_public, state: text(row.sale_state, 64, true),
      today: day(row.sale_today), availableOn: day(row.avail_date), expectedReadyOn: day(row.expected_ready_on) });
    rooms.push({ id: row.id, code: text(row.code, 256, true), name: text(row.name, 500),
      building: { ...building }, floor: row.floor, areaM2: number(row.area, true),
      rentVnd: number(row.rent_price, true), depositVnd: number(row.deposit_amount, true),
      status: row.status_public, availability: { kind: fact.kind, label: fact.label, availableOn: fact.availableOn } });
  }
  // Stable pagination within this response only. A later RPC is a new snapshot.
  rooms.sort((a, b) => a.building.id.localeCompare(b.building.id) || a.id.localeCompare(b.id));
  const next = offset + limit;
  return {
    source: 'copilot_available_rooms_v1', readAt: new Date(options.readAt).toISOString(), currency: 'VND',
    completeness: payload.rooms.length === 2000 || payload.buildings.length === 2000 ? 'source_capped' : 'complete',
    totalInSnapshot: rooms.length, offset, nextOffset: next < rooms.length ? next : null,
    rooms: rooms.slice(offset, next),
  };
}
