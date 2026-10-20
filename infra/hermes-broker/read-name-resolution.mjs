// B5d (21/10/2026): giải TÊN toà/phòng → ID cho tool đọc danh sách, ở lớp chuẩn bị gọi (bound-user-operation
// prepare, sau khi có JWT người hỏi + identity, trước validator). Sự cố 21/10 00:11: "khách nào đang ở phòng
// London 5 950NK" → crm_read_customers {buildingId, query:"LONDON 5"} → 0 dòng vì lõi chỉ khớp tên/SĐT khách và
// không tool nào nhận tên toà/phòng. Danh bạ: hermes_building_directory_v1 / hermes_room_directory_v1 (INVOKER,
// RLS của người hỏi, chỉ các toà trong phạm vi của khoá tool) và hermes_organization_name_v1 (20261020175803).
// Thông điệp lỗi (read_name_unresolved.detail) chỉ nêu chuỗi mô hình gửi và tên toà/phòng mà danh bạ — tức RLS
// của chính người hỏi trong phạm vi khoá — đã trả; không bao giờ nêu toà ngoài phạm vi.
import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { DOMAIN_READS, READ_NAMES, READ_NAME_LIMITS, domainId, domainInput, domainRecord, domainExact } from './domain-contract.mjs';
import { W2 } from './wave2-registry.mjs';
import { isW2ReportId } from './wave2-kit.mjs';

export const DIRECTORY_RPCS = Object.freeze(['hermes_building_directory_v1', 'hermes_room_directory_v1', 'hermes_organization_name_v1']);
// Như web (hoá đơn/thu chi/công việc/chỉ số gộp room_ids của mọi toà cùng tên): tới 5 phòng trùng tên đi cùng
// một lần; hơn thì hỏi lại. Trang SQL 50 dòng, tối đa 4 trang một lượt gọi (≤ 200 dòng quét) khi lọc hàng.
export const ROOM_MATCH_LIMIT = 5, ROOM_FILTER_PAGE_LIMIT = 50, ROOM_FILTER_MAX_PAGES = 4;
const LIST_CAP = 8, TEXT_CAP = 500;
const fail = code => { throw new BrokerError(code); };
const CONTROL = /[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}]/u;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= TEXT_CAP && !CONTROL.test(value);
const nullableText = value => value === null || (typeof value === 'string' && value.length <= TEXT_CAP && !CONTROL.test(value));
const canonical = value => domainId(value) && value === value.toLowerCase();
const fold = value => value.normalize('NFC').toLowerCase().trim();
const list = values => values.slice(0, LIST_CAP).join(', ') + (values.length > LIST_CAP ? ', …' : '');
export function unresolved(detail) {
  const error = new BrokerError('read_name_unresolved');
  error.detail = detail;
  throw error;
}
// Danh bạ trả object (transport bound-user-rpc chỉ nhận object): {buildings:[...]} / {rooms:[...]} / {id,name}.
function rows(data, key, check, max) {
  if (!domainExact(data, [key]) || !Array.isArray(data[key]) || data[key].length > max) fail('backend_unavailable');
  const seen = new Set();
  for (const row of data[key]) {
    if (!check(row) || seen.has(row.id)) fail('backend_unavailable');
    seen.add(row.id);
  }
  return data[key].map(row => structuredClone(row));
}
const building = row => domainExact(row, ['id', 'name', 'code']) && canonical(row.id) && text(row.name) && nullableText(row.code);
const room = row => domainExact(row, ['id', 'name', 'code', 'floor', 'buildingId']) && canonical(row.id) && text(row.name) && nullableText(row.code) &&
  (row.floor === null || Number.isSafeInteger(row.floor)) && canonical(row.buildingId);
const matches = (entry, needle) => fold(entry.name) === needle || (entry.code !== null && fold(entry.code) === needle);
const contains = (entry, needle) => fold(entry.name).includes(needle) || (entry.code !== null && fold(entry.code).includes(needle));
/** Khớp bằng (tên hoặc mã, không phân biệt hoa thường) trước; không có thì chứa. */
export function matchBuildings(directory, name) {
  const needle = fold(name);
  const exact = directory.filter(entry => matches(entry, needle));
  return exact.length ? exact : directory.filter(entry => contains(entry, needle));
}

/** Kế hoạch lọc hàng theo phòng cho tool mà SQL không nhận ID phòng: trang SQL 50 dòng, lấy thêm trang (cursor
 * hoặc offset) tới khi đủ `requested` hàng khớp hoặc hết trang/hết quota; gộp giữ thứ tự SQL. Cắt bớt thì
 * cursor = id hàng cuối giữ lại (keyset vẫn đúng) / nextOffset = vị trí tuyệt đối sau hàng cuối giữ lại. */
function rowsPlan(spec, resolved, rooms) {
  const requested = resolved.limit, ids = new Set(rooms.map(entry => entry.id)), offset = spec.paging === 'offset';
  resolved.limit = ROOM_FILTER_PAGE_LIMIT;
  const keep = page => page.items.filter(row => typeof row.roomId === 'string' && ids.has(row.roomId));
  let collected = 0;
  const note = (scanned, pages, more) => ({ roomIds: rooms.map(entry => entry.id), roomNames: rooms.map(entry => entry.name),
    buildingIds: [...new Set(rooms.map(entry => entry.buildingId))], scannedRows: scanned, pages, more, filteredOn: 'page' });
  return Object.freeze({ maxPages: ROOM_FILTER_MAX_PAGES,
    next(page, input) {
      collected += keep(page).length;
      if (collected >= requested) return null;
      if (offset) return page.nextOffset === null || page.nextOffset > 2000 ? null : { ...input, offset: page.nextOffset };
      return page.nextCursor === null ? null : { ...input, cursor: page.nextCursor };
    },
    merge(pages) {
      const last = pages.at(-1); let scanned = 0, items = [];
      for (const page of pages) {
        scanned += page.items.length;
        items.push(...keep(page).map(row => offset ? { row, at: page.offset + page.items.indexOf(row) } : { row }));
      }
      const cut = items.length > requested;
      items = items.slice(0, requested);
      if (offset) {
        const nextOffset = cut ? items.at(-1).at + 1 : last.nextOffset;
        return { ...last, items: items.map(entry => entry.row), offset: pages[0].offset, nextOffset,
          sourceCapped: pages.some(page => page.sourceCapped), roomFilter: note(scanned, pages.length, nextOffset !== null) };
      }
      const nextCursor = cut ? items.at(-1).row.id : last.nextCursor;
      return { ...last, items: items.map(entry => entry.row), nextCursor, roomFilter: note(scanned, pages.length, nextCursor !== null) };
    } });
}

/** rpc(name, accessToken, args, {signal}) = transport bound-user (JWT người hỏi). Cache danh bạ toà 5 phút theo
 * tokenDigest + khoá quyền, bỏ khi contextVersion hay tập toà đổi; phòng không cache (một RPC mỗi lượt có roomName). */
export function createReadNameResolver({ rpc, clock = Date.now, ttlMs = 300_000, maxEntries = 512 } = {}) {
  if (typeof rpc !== 'function' || typeof clock !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000 ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096) throw new TypeError('invalid_read_name_resolver');
  const cache = new Map();
  const remember = (key, contextVersion, fingerprint, value) => {
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
    cache.set(key, { contextVersion, fingerprint, until: clock() + ttlMs, value });
    return value;
  };
  const cached = (key, contextVersion, fingerprint) => {
    const hit = cache.get(key);
    if (hit && hit.contextVersion === contextVersion && hit.fingerprint === fingerprint && hit.until > clock()) return hit.value;
    cache.delete(key);
    return undefined; // (a cached null — directory absent — is a hit too)
  };
  const check = signal => { if (!(signal instanceof AbortSignal)) fail('invalid_request'); if (signal.aborted) fail('timeout'); };
  // optional (crm_auth_context only): a directory RPC not yet deployed (PGRST202) yields null instead of failing the
  // call — the connector may run before the migration is applied. Name resolution itself never degrades (fails closed).
  async function directory({ accessToken, organizationId, buildingIds, tokenDigest, contextVersion, label, signal, optional = false }) {
    check(signal);
    if (!domainId(organizationId) || !Array.isArray(buildingIds) || !buildingIds.length || buildingIds.length > 256 || buildingIds.some(id => !canonical(id)) ||
        typeof tokenDigest !== 'string' || typeof contextVersion !== 'string' || typeof label !== 'string' || typeof optional !== 'boolean') fail('invalid_request');
    const ids = [...new Set(buildingIds)], key = `${tokenDigest}:${label}`;
    const fingerprint = createHash('sha256').update(JSON.stringify([organizationId, ...ids].sort())).digest('hex');
    const hit = cached(key, contextVersion, fingerprint);
    if (hit !== undefined) return hit;
    const data = await rpc('hermes_building_directory_v1', accessToken, { p_organization_id: organizationId, p_building_ids: ids }, { signal }, { optional }); check(signal);
    if (data === null && optional) return remember(key, contextVersion, fingerprint, null);
    const value = rows(data, 'buildings', building, 256);
    if (value.some(entry => !ids.includes(entry.id))) fail('backend_unavailable');
    return remember(key, contextVersion, fingerprint, value);
  }
  async function organizationName({ accessToken, organizationId, tokenDigest, contextVersion, signal, optional = false }) {
    check(signal);
    if (!domainId(organizationId) || typeof tokenDigest !== 'string' || typeof contextVersion !== 'string' || typeof optional !== 'boolean') fail('invalid_request');
    const key = `${tokenDigest}:organization`, hit = cached(key, contextVersion, organizationId);
    if (hit !== undefined) return hit;
    const data = await rpc('hermes_organization_name_v1', accessToken, { p_organization_id: organizationId }, { signal }, { optional }); check(signal);
    if (data === null && optional) return remember(key, contextVersion, organizationId, null);
    if (!domainExact(data, ['id', 'name']) || data.id !== organizationId || !text(data.name)) fail('backend_unavailable');
    return remember(key, contextVersion, organizationId, data.name);
  }
  async function resolve({ operation, input, names, lane = 'legacy', accessToken, identity, tokenDigest, signal }) {
    check(signal);
    const spec = Object.hasOwn(READ_NAMES, operation) ? READ_NAMES[operation] : null;
    if (!domainRecord(names) || !Object.keys(names).length || Object.keys(names).some(key => !Object.hasOwn(READ_NAME_LIMITS, key)) ||
        Object.values(names).some(value => typeof value !== 'string' || value.trim() === '' || CONTROL.test(value)) ||
        !['legacy', 'fast'].includes(lane) || !domainRecord(input)) fail('invalid_request');
    if (!spec) unresolved(`crm_read_${operation} không nhận buildingName/roomName.`);
    const w2 = spec.room === 'param';
    // The input may still be the model's (a report whose roomId is required cannot pass the validator before
    // the names are ids): list tools are normalised here, crm_read_report only as far as report/params go;
    // the caller validates the resolved input afterwards either way.
    let base;
    if (w2) {
      if (!isW2ReportId(input.report) || !Object.hasOwn(W2.reports, input.report) || !(input.params === undefined || input.params === null || domainRecord(input.params))) fail('invalid_request');
      base = { ...input, params: { ...(input.params ?? {}) } };
    } else { try { base = domainInput(operation, input); } catch { fail('invalid_request'); } }
    const report = w2 ? W2.reports[base.report] : null;
    const permission = w2 ? report.permission : DOMAIN_READS[operation].permission;
    const scope = identity?.scopesByPermission?.[permission]?.buildingIds, organizationId = identity?.row?.organizationId, contextVersion = identity?.contextVersion;
    if (!Array.isArray(scope) || !domainId(organizationId) || typeof contextVersion !== 'string') fail('backend_unavailable');
    const resolved = structuredClone(base), target = w2 ? resolved.params : resolved;
    const buildings = () => directory({ accessToken, organizationId, buildingIds: scope, tokenDigest, contextVersion, label: permission, signal });
    let chosen = null;
    if (names.buildingName !== undefined) {
      const wanted = names.buildingName.trim();
      // A report without a buildingId slot may still take the building to narrow a roomName lookup (room_detail).
      const slot = !w2 || report.params.includes('buildingId');
      if (!slot && !(report.params.includes('roomId') && names.roomName !== undefined)) unresolved(`Báo cáo ${base.report} không lọc theo toà.`);
      if (!scope.length) unresolved(`Kết nối không có toà nào để tìm '${wanted}'.`);
      const matched = matchBuildings(await buildings(), wanted);
      if (!matched.length) unresolved(`Không thấy toà '${wanted}' trong phạm vi được xem.`);
      if (matched.length > 1) unresolved(`Nhiều toà khớp '${wanted}': ${list(matched.map(entry => entry.name))} — nêu rõ.`);
      chosen = matched[0];
      if (slot) {
        if (target.buildingId !== null && target.buildingId !== undefined && target.buildingId !== chosen.id)
          unresolved(`buildingId không phải toà '${wanted}' (${chosen.name}).`);
        target.buildingId = chosen.id;
      }
    }
    let plan = null;
    if (names.roomName !== undefined) {
      const wanted = names.roomName.trim();
      if (spec.room === null) unresolved(`crm_read_${operation} không lọc theo phòng; dùng crm_read_customers, crm_read_contracts hoặc crm_read_contract_search.`);
      if (w2 && !report.params.includes('roomId')) unresolved(`Báo cáo ${base.report} không lọc theo phòng.`);
      if (spec.reports && !spec.reports.includes(resolved.report)) unresolved(`roomName chỉ dùng với report=${spec.reports.join('/')}.`);
      const within = chosen ? [chosen.id] : typeof target.buildingId === 'string' ? [target.buildingId] : scope;
      if (!within.length) unresolved(`Kết nối không có toà nào để tìm phòng '${wanted}'.`);
      if (within.some(id => !scope.includes(id))) fail('forbidden');
      const data = await rpc('hermes_room_directory_v1', accessToken, { p_organization_id: organizationId, p_building_ids: within, p_room_name: wanted }, { signal }); check(signal);
      const found = rows(data, 'rooms', room, 50);
      if (found.some(entry => !within.includes(entry.buildingId))) fail('backend_unavailable');
      const where = chosen ? ` ở toà ${chosen.name}` : ' trong phạm vi được xem';
      if (!found.length) unresolved(`Không thấy phòng '${wanted}'${where}.`);
      const limit = w2 ? 1 : ROOM_MATCH_LIMIT;
      if (found.length > limit) {
        const labels = new Map((await buildings()).map(entry => [entry.id, entry.name]));
        const towers = [...new Set(found.map(entry => labels.get(entry.buildingId) ?? 'toà ngoài danh bạ'))];
        if (towers.length > 1) unresolved(`Phòng '${wanted}' có ở toà ${list(towers)} — nêu toà.`);
        unresolved(`Phòng '${wanted}' khớp ${found.length} phòng ở toà ${towers[0]}: ${list(found.map(entry => entry.name))} — nêu tên đầy đủ.`);
      }
      if (w2) {
        if (typeof target.roomId === 'string' && target.roomId !== found[0].id) unresolved(`roomId không phải phòng '${wanted}'${where}.`);
        target.roomId = found[0].id;
      } else {
        const needle = fold(wanted);
        if ((spec.queryRoom === 'always' || spec.queryRoom === lane) && resolved.query === '' && found.every(entry => fold(entry.name).includes(needle))) resolved.query = wanted;
        plan = rowsPlan(spec, resolved, found);
      }
    }
    return { input: resolved, plan };
  }
  return Object.freeze({ resolve, directory, organizationName });
}
