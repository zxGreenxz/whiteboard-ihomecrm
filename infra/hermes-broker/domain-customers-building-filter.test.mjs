import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN_READS, DOMAIN_FAMILIES, domainInput, domainResult } from './domain-contract.mjs';
import { domainFastResult } from './domain-read-fast.mjs';

// 21/10/2026 (sau B5d): crm_read_customers {buildingId} — kể cả buildingId hợp lệ — trả backend_unavailable với mọi toà
// trên production. Nguyên nhân: validator đòi MỌI dòng có buildingId = toà lọc, nhưng với khách bộ lọc toà nghĩa là
// "từng có hợp đồng ở toà" (lõi customer_list_core_v1: p_location_building_ids) còn dòng mang toà của hợp đồng ĐANG
// hiệu lực — khách đã chuyển đi (null) hay đang ở toà khác trong phạm vi làm cả trang bị từ chối. Các miền khác
// (hợp đồng, hoá đơn, việc…) dòng thuộc đúng toà lọc nên vẫn đòi trùng. Kiểm phạm vi (toà của dòng ⊆ phạm vi) giữ nguyên.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id(1), BUILDING = id(2), OTHER = id(3), ROOM = id(4), USER = id(5), CONNECTION = id(6), ITEM = id(10), OUTSIDE = id(99);
const SCOPE = [BUILDING, OTHER];
const envelope = (operation, rows) => {
  const family = DOMAIN_FAMILIES[DOMAIN_READS[operation].family];
  return { organizationId: ORG, domain: operation, items: rows, nextCursor: null,
    ...(family.resultKeys.includes('source') ? { source: DOMAIN_READS[operation].source } : {}),
    ...(family.resultKeys.includes('fetchedAt') ? { fetchedAt: '2026-10-21T00:00:00.000Z' } : {}) };
};
const identity = operation => ({ row: { id: CONNECTION, organizationId: ORG, userId: USER },
  scopesByPermission: { [DOMAIN_READS[operation].permission]: { buildingIds: SCOPE, cashbookIds: [] } } });
// Đường nhanh: phong bì {authority, result} với authority sống của chính kết nối (domain-read-fast.mjs).
const fast = (operation, rows) => ({ authority: { organizationId: ORG, userId: USER, connectionId: CONNECTION,
  permission: DOMAIN_READS[operation].permission, buildingIds: SCOPE, cashbookIds: [] }, result: envelope(operation, rows) });
let seq = 20;
const customer = (buildingId, roomId) => ({ id: id(seq++), name: 'Khách mẫu', phone: null, contractId: buildingId ? id(11) : null,
  buildingId, buildingName: buildingId ? 'Toà' : '', roomId, roomName: roomId ? 'P101' : null });

test('customers filtered by buildingId: rows whose current building differs or is empty pass (filter = ever had a contract there)', () => {
  const who = identity('customers'), input = domainInput('customers', { buildingId: BUILDING });
  const rows = [customer(BUILDING, ROOM), customer(OTHER, ROOM), customer(null, null)];
  assert.deepEqual(domainResult('customers', envelope('customers', rows), who, input), envelope('customers', rows));
  assert.deepEqual(domainFastResult('customers', fast('customers', rows), who, input), envelope('customers', rows));
  // Phạm vi vẫn là hàng rào: toà của dòng ngoài phạm vi ⇒ từ chối cả trang.
  assert.throws(() => domainResult('customers', envelope('customers', [customer(OUTSIDE, ROOM)]), who, input));
  assert.throws(() => domainFastResult('customers', fast('customers', [customer(OUTSIDE, ROOM)]), who, input));
});

test('other domains still require every row to belong to the filtered building', () => {
  const who = identity('contracts'), input = domainInput('contracts', { buildingId: BUILDING });
  const row = { id: ITEM, number: 'HD1', status: 'ACTIVE', buildingId: OTHER, buildingName: 'Toà', roomId: ROOM, roomName: 'P101', startDate: '2026-01-01', endDate: null };
  assert.throws(() => domainResult('contracts', envelope('contracts', [row]), who, input));
  assert.throws(() => domainFastResult('contracts', fast('contracts', [row]), who, input));
  const same = { ...row, buildingId: BUILDING };
  assert.deepEqual(domainResult('contracts', envelope('contracts', [same]), who, input), envelope('contracts', [same]));
});
