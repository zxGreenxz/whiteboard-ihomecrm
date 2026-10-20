import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN_READS, DOMAIN_FAMILIES, domainInput, domainResult } from './domain-contract.mjs';
import { domainFastResult, FAST_READ_OPERATIONS } from './domain-read-fast.mjs';

// Phát hành B5c (21/10/2026): ba migration (20261020171321, 20261020173818, 20261020173819; mỗi migration backup
// ~2,5 phút ⇒ cửa sổ ~8 phút) và connector không đổi cùng lúc. Trong cửa sổ đó SQL cũ trả dòng KHÔNG có khoá mới,
// hoặc connector cũ nhận dòng CÓ khoá mới. Validator vì thế chấp nhận VẮNG các khoá mới (vắng = chưa áp SQL), kiểm
// kiểu khi có mặt và vẫn từ chối khoá lạ. Tolerant MỘT bản phát hành: gỡ `tolerant` ở bản sau khi prod đã áp đủ ba
// migration — khi đó file test này đổi sang khẳng định khuôn chính xác.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id(1), BUILDING = id(2), ROOM = id(3), USER = id(4), CONNECTION = id(5), ITEM = id(10);
// Dòng ĐẦY ĐỦ (sau ba migration) của từng miền; dữ liệu tổng hợp.
const ROWS = {
  customers: { id: ITEM, name: 'Khách mẫu', phone: null, contractId: id(11), buildingId: BUILDING, buildingName: 'Toà A', roomId: ROOM, roomName: 'P101' },
  leads: { id: ITEM, name: 'Khách hẹn', status: 'B1_LEAD', buildingId: BUILDING, buildingName: 'Toà A', roomId: ROOM, roomName: 'P101', nextFollowUp: null },
  contracts: { id: ITEM, number: 'HD1', status: 'ACTIVE', buildingId: BUILDING, buildingName: 'Toà A', roomId: ROOM, roomName: 'P101', startDate: '2026-01-01', endDate: null },
  invoices: { id: ITEM, number: 'INV1', status: 'APPROVED', buildingId: BUILDING, buildingName: 'Toà A', roomId: ROOM, roomName: 'P101', billingMonth: '2026-10', totalAmount: '1' },
  assets: { id: ITEM, name: 'Tài sản', code: null, condition: null, buildingId: BUILDING, buildingName: 'Toà A', roomId: ROOM, roomName: 'P101', quantity: '1' },
  tasks: { id: ITEM, title: 'Việc', code: null, status: 'IN_PROGRESS', buildingId: BUILDING, buildingName: 'Toà A', roomId: ROOM, roomName: 'P101', deadline: null },
  income_expenses: { id: ITEM, code: null, type: 'EXPENSE', name: 'Chi', buildingId: BUILDING, buildingName: 'Toà A', roomId: ROOM, roomName: 'P101',
    voucherDate: '2026-10-02', totalAmount: '1', approvalStatus: 'APPROVED' },
  receivables: { id: ITEM, number: 'INV1', status: 'APPROVED', buildingId: BUILDING, buildingName: 'Toà A', buildingCode: 'A', roomId: ROOM, roomName: 'P101',
    billingMonth: '2026-10', dueDate: null, totalAmount: '2', paidAmount: '1', remainingAmount: '1' },
  meter_readings: { id: ITEM, code: null, buildingId: BUILDING, buildingName: 'Toà A', roomId: ROOM, roomName: 'P101', meterType: 'WATER', settlementMonth: null,
    readingDate: '2026-10-01', previousReading: '0', currentReading: '1', consumption: '1', status: 'APPROVED' },
};
// Khoá MỚI của B5c theo miền: buildingName khắp nơi, buildingCode ở receivables, roomName ở miền trước đây chưa có.
const TOLERANT = {
  customers: ['buildingName'], leads: ['buildingName', 'roomName'], contracts: ['buildingName', 'roomName'], invoices: ['buildingName', 'roomName'],
  assets: ['buildingName', 'roomName'], tasks: ['buildingName', 'roomName'], income_expenses: ['buildingName'],
  receivables: ['buildingName', 'buildingCode'], meter_readings: ['buildingName'],
};
const without = (row, keys) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
const envelope = (operation, row) => {
  const family = DOMAIN_FAMILIES[DOMAIN_READS[operation].family];
  return { organizationId: ORG, domain: operation, items: [row], nextCursor: null,
    ...(family.resultKeys.includes('source') ? { source: DOMAIN_READS[operation].source } : {}),
    ...(family.resultKeys.includes('fetchedAt') ? { fetchedAt: '2026-10-21T00:00:00.000Z' } : {}) };
};
const identity = operation => ({ row: { id: CONNECTION, organizationId: ORG, userId: USER },
  scopesByPermission: { [DOMAIN_READS[operation].permission]: { buildingIds: [BUILDING], cashbookIds: [] } } });

test('release tolerance: exactly the B5c keys are tolerant, each is a declared field, perBuilding/report domains declare none', () => {
  const declared = Object.fromEntries(Object.entries(DOMAIN_READS).filter(([, definition]) => definition.tolerant?.length).map(([key, definition]) => [key, [...definition.tolerant]]));
  assert.deepEqual(declared, TOLERANT);
  for (const [operation, keys] of Object.entries(TOLERANT)) for (const key of keys) assert.ok(Object.hasOwn(DOMAIN_READS[operation].fields, key), `${operation}.${key} is a declared field`);
  for (const operation of Object.keys(DOMAIN_READS)) assert.ok(Object.isFrozen(DOMAIN_READS[operation].tolerant ?? Object.freeze([])), `${operation}: frozen`);
});

for (const [operation, row] of Object.entries(ROWS)) {
  test(`release tolerance ${operation}: rows with or without the new keys pass; unknown keys, wrong types and missing old keys fail`, () => {
    const input = domainInput(operation, {}), who = identity(operation), fields = DOMAIN_READS[operation].fields;
    const full = envelope(operation, row), legacy = envelope(operation, without(row, TOLERANT[operation]));
    assert.deepEqual(domainResult(operation, full, who, input), full, 'row after the three migrations (new keys present)');
    assert.deepEqual(domainResult(operation, legacy, who, input), legacy, 'row of the SQL before the migrations (new keys absent)');
    assert.throws(() => domainResult(operation, envelope(operation, { ...row, notes: 'x' }), who, input), 'unknown key next to the new keys');
    assert.throws(() => domainResult(operation, envelope(operation, { ...without(row, TOLERANT[operation]), notes: 'x' }), who, input), 'unknown key on the old shape');
    for (const key of TOLERANT[operation]) {
      assert.throws(() => domainResult(operation, envelope(operation, { ...row, [key]: 7 }), who, input), `${key} present but not text`);
      if (key === 'buildingName') assert.throws(() => domainResult(operation, envelope(operation, { ...row, [key]: null }), who, input), 'buildingName present but null');
      const partial = envelope(operation, without(row, [key]));
      assert.deepEqual(domainResult(operation, partial, who, input), partial, `${key} alone may be absent`);
    }
    // Mọi khoá đã có từ trước vẫn bắt buộc — kể cả roomName ở miền đã có nó trước B5c.
    for (const key of Object.keys(fields).filter(key => key !== 'id' && !TOLERANT[operation].includes(key)))
      assert.throws(() => domainResult(operation, envelope(operation, without(row, [key])), who, input), `${key} stays required`);
  });
}

test('release tolerance on the fast lane: domainFastResult applies the same row rule', () => {
  for (const operation of FAST_READ_OPERATIONS) {
    const row = ROWS[operation], input = domainInput(operation, {}), who = identity(operation);
    const authority = { organizationId: ORG, userId: USER, connectionId: CONNECTION, permission: DOMAIN_READS[operation].permission, buildingIds: [BUILDING], cashbookIds: [] };
    const full = { authority, result: envelope(operation, row) }, legacy = { authority, result: envelope(operation, without(row, TOLERANT[operation])) };
    assert.deepEqual(domainFastResult(operation, full, who, input), full.result, `${operation}: new keys present`);
    assert.deepEqual(domainFastResult(operation, legacy, who, input), legacy.result, `${operation}: new keys absent`);
    assert.throws(() => domainFastResult(operation, { authority, result: envelope(operation, { ...row, notes: 'x' }) }, who, input), `${operation}: unknown key`);
    assert.throws(() => domainFastResult(operation, { authority, result: envelope(operation, { ...row, buildingName: 7 }) }, who, input), `${operation}: buildingName not text`);
  }
});
