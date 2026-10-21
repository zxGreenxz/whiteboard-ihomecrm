import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN_READS, DOMAIN_FAMILIES, DOMAIN_SUMMARIES, DOMAIN_SUMMARY_TOLERANT, domainInput, domainResult } from './domain-contract.mjs';
import { domainFastResult, FAST_READ_OPERATIONS } from './domain-read-fast.mjs';
import { REPORTS } from './full-read-contract.mjs';

// Khuôn dòng CHÍNH XÁC sau B5c. Cửa sổ phát hành B5c (21/10/2026: ba migration 20261020171321, 20261020173818,
// 20261020173819 và connector không đổi cùng lúc) từng cho validator chấp nhận VẮNG các khoá mới (`tolerant`, đúng một
// bản phát hành). Production đã áp đủ ba migration ⇒ `tolerant` đã gỡ ở mọi miền (21/10): dòng thiếu buildingName,
// roomName hay buildingCode nay bị từ chối như thiếu bất kỳ khoá đã khai nào; cơ chế `tolerant` trong define()/
// domainResult vẫn còn cho lần đổi khuôn sau. File này khoá: không miền nào khai `tolerant`, khoá B5c bắt buộc có mặt,
// khoá lạ/sai kiểu vẫn bị từ chối, đường nhanh (domainFastResult) cùng luật.
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
// Khoá B5c theo miền (từng là `tolerant` trong cửa sổ phát hành): buildingName khắp nơi, buildingCode ở receivables,
// roomName ở miền trước đây chưa có. Nay bắt buộc như mọi khoá đã khai.
const B5C_KEYS = {
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

test('exact shape: no domain declares tolerant keys any more; the B5c keys are declared fields; the mechanism stays frozen and empty', () => {
  const declared = Object.entries(DOMAIN_READS).filter(([, definition]) => definition.tolerant?.length).map(([key]) => key);
  assert.deepEqual(declared, [], 'tolerant was removed on 21/10 after production applied the three B5c migrations');
  for (const operation of Object.keys(DOMAIN_READS)) {
    const { tolerant } = DOMAIN_READS[operation];
    if (tolerant !== undefined) assert.ok(Array.isArray(tolerant) && tolerant.length === 0 && Object.isFrozen(tolerant), `${operation}: tolerant is a frozen empty list`);
  }
  for (const [operation, keys] of Object.entries(B5C_KEYS)) for (const key of keys) assert.ok(Object.hasOwn(DOMAIN_READS[operation].fields, key), `${operation}.${key} is a declared field`);
});

for (const [operation, row] of Object.entries(ROWS)) {
  test(`exact shape ${operation}: the full row passes; a row missing any declared key (B5c keys included), an unknown key or a wrong type fails`, () => {
    const input = domainInput(operation, {}), who = identity(operation), fields = DOMAIN_READS[operation].fields;
    const full = envelope(operation, row);
    assert.deepEqual(domainResult(operation, full, who, input), full, 'row after the three migrations (every key present)');
    assert.throws(() => domainResult(operation, envelope(operation, without(row, B5C_KEYS[operation])), who, input), 'row of the SQL before the migrations (B5c keys absent) is refused');
    assert.throws(() => domainResult(operation, envelope(operation, { ...row, notes: 'x' }), who, input), 'unknown key');
    for (const key of B5C_KEYS[operation]) {
      assert.throws(() => domainResult(operation, envelope(operation, without(row, [key])), who, input), `${key} absent`);
      assert.throws(() => domainResult(operation, envelope(operation, { ...row, [key]: 7 }), who, input), `${key} present but not text`);
      if (key === 'buildingName') assert.throws(() => domainResult(operation, envelope(operation, { ...row, [key]: null }), who, input), 'buildingName null');
    }
    // Mọi khoá đã khai bắt buộc — khoá cũ lẫn khoá B5c, không còn ngoại lệ.
    for (const key of Object.keys(fields)) assert.throws(() => domainResult(operation, envelope(operation, without(row, [key])), who, input), `${key} is required`);
    // Toà không tên (chuỗi rỗng), phòng/mã toà null vẫn là dòng đầy đủ hợp lệ: kiểm kiểu, không phải vắng khoá.
    const unnamed = { ...row, buildingName: '', roomName: null, ...(Object.hasOwn(row, 'buildingCode') ? { buildingCode: null } : {}) };
    const unnamedEnvelope = envelope(operation, unnamed);
    assert.deepEqual(domainResult(operation, unnamedEnvelope, who, input), unnamedEnvelope, 'unnamed building and room without a name are valid full rows');
  });
}

// R2a (21/10/2026): cửa sổ phát hành của `summary` (20261020233934 + 20261021004841 lên SAU connector). Bản connector này
// chấp nhận VẮNG summary ở ĐÚNG 13 tool danh sách (DOMAIN_SUMMARY_TOLERANT) và vắng CẢ NHÓM bốn tổng của monthly_pnl
// (summaryTolerant); có mặt thì kiểm chính xác. Bản kế (sau khi production áp hai migration): đưa cả hai danh sách về [] —
// summary bắt buộc như khoá B5c ở trên — và đổi test này theo.
test('R2a release window: an absent summary passes on exactly the 13 list tools and the monthly_pnl totals, for this release only', () => {
  const lists = Object.keys(DOMAIN_READS).filter(operation => typeof DOMAIN_READS[operation].result !== 'function' && DOMAIN_READS[operation].family !== 'w2');
  assert.equal(lists.length, 13);
  assert.deepEqual([...DOMAIN_SUMMARY_TOLERANT].sort(), [...lists].sort(), 'next release: []');
  assert.deepEqual(Object.keys(DOMAIN_SUMMARIES).sort(), [...lists].sort(), 'every list tool declares its summary shape');
  assert.ok(Object.isFrozen(DOMAIN_SUMMARY_TOLERANT));
  const pnl = REPORTS.monthly_pnl.reports.by_month;
  assert.deepEqual([...pnl.summaryTolerant], ['revenue', 'expense', 'net', 'rows'], 'next release: summaryTolerant removed');
  assert.ok(Object.isFrozen(pnl.summaryTolerant));
  const tolerantReports = Object.entries(REPORTS).flatMap(([domain, { reports }]) => Object.entries(reports).filter(([, spec]) => spec.summaryTolerant?.length).map(([name]) => `${domain}:${name}`));
  assert.deepEqual(tolerantReports, ['monthly_pnl:by_month'], 'no other report is in a release window');
  // Vắng summary: qua (SQL trước R2a); khoá lạ trong phong bì vẫn bị từ chối.
  for (const operation of ['customers', 'receivables']) {
    const input = domainInput(operation, {}), who = identity(operation), legacy = envelope(operation, ROWS[operation]);
    assert.deepEqual(domainResult(operation, legacy, who, input), legacy, `${operation}: SQL before R2a`);
    assert.throws(() => domainResult(operation, { ...legacy, summaryV2: {} }, who, input), `${operation}: unknown envelope key`);
  }
});

test('exact shape on the fast lane: domainFastResult applies the same row rule', () => {
  for (const operation of FAST_READ_OPERATIONS) {
    const row = ROWS[operation], input = domainInput(operation, {}), who = identity(operation);
    const authority = { organizationId: ORG, userId: USER, connectionId: CONNECTION, permission: DOMAIN_READS[operation].permission, buildingIds: [BUILDING], cashbookIds: [] };
    const full = { authority, result: envelope(operation, row) };
    assert.deepEqual(domainFastResult(operation, full, who, input), full.result, `${operation}: every key present`);
    assert.throws(() => domainFastResult(operation, { authority, result: envelope(operation, without(row, B5C_KEYS[operation])) }, who, input), `${operation}: B5c keys absent`);
    for (const key of B5C_KEYS[operation])
      assert.throws(() => domainFastResult(operation, { authority, result: envelope(operation, without(row, [key])) }, who, input), `${operation}: ${key} absent`);
    assert.throws(() => domainFastResult(operation, { authority, result: envelope(operation, { ...row, notes: 'x' }) }, who, input), `${operation}: unknown key`);
    assert.throws(() => domainFastResult(operation, { authority, result: envelope(operation, { ...row, buildingName: 7 }) }, who, input), `${operation}: buildingName not text`);
  }
});
