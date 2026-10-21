import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN_READS, DOMAIN_FAMILIES, DOMAIN_SUMMARIES, DOMAIN_SUMMARY_TOLERANT, DOMAIN_SUMMARY_ENTRY_TOLERANT, DOMAIN_SUMMARY_KEY_TOLERANT, domainInput, domainResult,
  summarizeRows } from './domain-contract.mjs';
import { domainFastResult, FAST_READ_OPERATIONS } from './domain-read-fast.mjs';
import { REPORTS } from './full-read-contract.mjs';

// Khuôn dòng CHÍNH XÁC sau B5c. Cửa sổ phát hành B5c (21/10/2026: ba migration 20261020171321, 20261020173818,
// 20261020173819 và connector không đổi cùng lúc) từng cho validator chấp nhận VẮNG các khoá mới (`tolerant`, đúng một
// bản phát hành). Production đã áp đủ ba migration ⇒ `tolerant` đã gỡ ở mọi miền (21/10): dòng thiếu buildingName,
// roomName hay buildingCode nay bị từ chối như thiếu bất kỳ khoá đã khai nào; cơ chế `tolerant` trong define()/
// domainResult vẫn còn cho lần đổi khuôn sau. File này khoá: không miền nào khai `tolerant`, khoá B5c bắt buộc có mặt,
// khoá lạ/sai kiểu vẫn bị từ chối, đường nhanh (domainFastResult) cùng luật. Bản R2d (21/10, sau khi production áp đủ
// bốn migration R2c): đóng cửa sổ R2c (assets.createdAt, byType.*.largest, assets.latest) và mở cửa sổ một bản cho hai khoá
// summary mới customers.withoutContract, assets.latestCount.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id(1), BUILDING = id(2), ROOM = id(3), USER = id(4), CONNECTION = id(5), ITEM = id(10);
// Dòng ĐẦY ĐỦ (sau ba migration) của từng miền; dữ liệu tổng hợp.
const ROWS = {
  customers: { id: ITEM, name: 'Khách mẫu', phone: null, contractId: id(11), buildingId: BUILDING, buildingName: 'Toà A', roomId: ROOM, roomName: 'P101' },
  leads: { id: ITEM, name: 'Khách hẹn', status: 'B1_LEAD', buildingId: BUILDING, buildingName: 'Toà A', roomId: ROOM, roomName: 'P101', nextFollowUp: null },
  contracts: { id: ITEM, number: 'HD1', status: 'ACTIVE', buildingId: BUILDING, buildingName: 'Toà A', roomId: ROOM, roomName: 'P101', startDate: '2026-01-01', endDate: null },
  invoices: { id: ITEM, number: 'INV1', status: 'APPROVED', buildingId: BUILDING, buildingName: 'Toà A', roomId: ROOM, roomName: 'P101', billingMonth: '2026-10', totalAmount: '1' },
  assets: { id: ITEM, name: 'Tài sản', code: null, condition: null, buildingId: BUILDING, buildingName: 'Toà A', roomId: ROOM, roomName: 'P101', quantity: '1',
    createdAt: '2026-10-21' },
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
// Phong bì SQL trước R2a (không summary) và sau R2a/R2c: summary BẮT BUỘC từ khi cửa sổ R2a đóng, nên phong bì đầy đủ mang
// summary của dòng ĐẦY ĐỦ của miền (dòng bị cắt khoá vẫn bị từ chối vì chính dòng, không vì summary).
const bare = (operation, row) => {
  const family = DOMAIN_FAMILIES[DOMAIN_READS[operation].family];
  return { organizationId: ORG, domain: operation, items: [row], nextCursor: null,
    ...(family.resultKeys.includes('source') ? { source: DOMAIN_READS[operation].source } : {}),
    ...(family.resultKeys.includes('fetchedAt') ? { fetchedAt: '2026-10-21T00:00:00.000Z' } : {}) };
};
const envelope = (operation, row) => ({ ...bare(operation, row), summary: summarizeRows(operation, [ROWS[operation]]) });
const identity = operation => ({ row: { id: CONNECTION, organizationId: ORG, userId: USER },
  scopesByPermission: { [DOMAIN_READS[operation].permission]: { buildingIds: [BUILDING], cashbookIds: [] } } });

test('exact shape: the B5c keys and assets.createdAt are declared fields with no window; no domain declares tolerant keys', () => {
  const declared = Object.fromEntries(Object.entries(DOMAIN_READS).filter(([, definition]) => definition.tolerant?.length).map(([key, definition]) => [key, [...definition.tolerant]]));
  assert.deepEqual(declared, {}, 'B5c window closed 21/10; the R2c part 2 window (assets.createdAt, 20261021044801) closed by the R2d connector');
  for (const operation of Object.keys(DOMAIN_READS)) {
    const { tolerant } = DOMAIN_READS[operation];
    if (tolerant !== undefined) assert.ok(Array.isArray(tolerant) && Object.isFrozen(tolerant) && tolerant.every(key => Object.hasOwn(DOMAIN_READS[operation].fields, key)),
      `${operation}: tolerant is a frozen list of declared fields`);
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
    // Mọi khoá đã khai bắt buộc — khoá cũ lẫn khoá B5c; khoá của cửa sổ phát hành (tolerant) có test riêng bên dưới.
    for (const key of Object.keys(fields).filter(key => !DOMAIN_READS[operation].tolerant.includes(key)))
      assert.throws(() => domainResult(operation, envelope(operation, without(row, [key])), who, input), `${key} is required`);
    // Toà không tên (chuỗi rỗng), phòng/mã toà null vẫn là dòng đầy đủ hợp lệ: kiểm kiểu, không phải vắng khoá.
    const unnamed = { ...row, buildingName: '', roomName: null, ...(Object.hasOwn(row, 'buildingCode') ? { buildingCode: null } : {}) };
    const unnamedEnvelope = envelope(operation, unnamed);
    assert.deepEqual(domainResult(operation, unnamedEnvelope, who, input), unnamedEnvelope, 'unnamed building and room without a name are valid full rows');
  });
}

// R2a (21/10/2026): cửa sổ phát hành của `summary` (20261020233934 + 20261021004841 lên SAU connector) ĐÃ ĐÓNG — production
// áp hai migration 09:46–09:51 21/10, nên bản connector R2c đưa DOMAIN_SUMMARY_TOLERANT về [] và gỡ summaryTolerant của
// monthly_pnl: summary bắt buộc ở 13 tool danh sách như khoá B5c ở trên, bốn tổng của monthly_pnl bắt buộc
// (full-read-report.test.mjs kiểm khuôn báo cáo).
test('R2a window closed: summary is required on all 13 list tools; no report keeps summaryTolerant', () => {
  const lists = Object.keys(DOMAIN_READS).filter(operation => typeof DOMAIN_READS[operation].result !== 'function' && DOMAIN_READS[operation].family !== 'w2');
  assert.equal(lists.length, 13);
  assert.deepEqual([...DOMAIN_SUMMARY_TOLERANT], [], 'closed on 21/10 after production applied both R2a migrations');
  assert.ok(Object.isFrozen(DOMAIN_SUMMARY_TOLERANT));
  assert.deepEqual(Object.keys(DOMAIN_SUMMARIES).sort(), [...lists].sort(), 'every list tool declares its summary shape');
  assert.equal(Object.hasOwn(REPORTS.monthly_pnl.reports.by_month, 'summaryTolerant'), false, 'monthly_pnl: the four totals are required');
  const tolerantReports = Object.entries(REPORTS).flatMap(([domain, { reports }]) => Object.entries(reports).filter(([, spec]) => spec.summaryTolerant !== undefined).map(([name]) => `${domain}:${name}`));
  assert.deepEqual(tolerantReports, [], 'no report is in a release window');
  // Vắng summary (SQL trước R2a) bị từ chối ở mọi miền; có summary thì qua; khoá lạ trong phong bì vẫn bị từ chối.
  for (const operation of Object.keys(ROWS)) {
    const input = domainInput(operation, {}), who = identity(operation), full = envelope(operation, ROWS[operation]);
    assert.throws(() => domainResult(operation, bare(operation, ROWS[operation]), who, input), `${operation}: SQL before R2a is refused`);
    assert.deepEqual(domainResult(operation, full, who, input), full, `${operation}: SQL after R2a`);
    assert.throws(() => domainResult(operation, { ...full, summaryV2: {} }, who, input), `${operation}: unknown envelope key`);
  }
  for (const operation of FAST_READ_OPERATIONS) {
    const authority = { organizationId: ORG, userId: USER, connectionId: CONNECTION, permission: DOMAIN_READS[operation].permission, buildingIds: [BUILDING], cashbookIds: [] };
    assert.throws(() => domainFastResult(operation, { authority, result: bare(operation, ROWS[operation]) }, identity(operation), domainInput(operation, {})), `${operation}: fast lane too`);
  }
});

// R2c (21/10/2026): cửa sổ phát hành của khoá con byType.<INCOME|EXPENSE>.largest (income_expenses, 20261021035022) ĐÃ
// ĐÓNG ở bản R2d — production áp 21/10: largest bắt buộc ở mọi phần tử byType; byType kiểu R2a (không largest) bị từ chối.
test('R2c window closed: byType entries of income_expenses must name their largest voucher; the R2a entries, mixed or mistyped are refused', () => {
  assert.deepEqual(DOMAIN_SUMMARY_ENTRY_TOLERANT, {}, 'closed by the R2d connector');
  assert.ok(Object.isFrozen(DOMAIN_SUMMARY_ENTRY_TOLERANT));
  const operation = 'income_expenses', who = identity(operation), input = domainInput(operation, {});
  const income = { ...ROWS.income_expenses, id: id(12), code: 'PT1', type: 'INCOME', name: 'Thu', totalAmount: '5' };
  const rows = [ROWS.income_expenses, income], summary = summarizeRows(operation, rows);
  const value = summaryValue => ({ ...bare(operation, rows[0]), items: rows, summary: summaryValue });
  assert.deepEqual(Object.keys(summary.byType).sort(), ['EXPENSE', 'INCOME']);
  assert.deepEqual(domainResult(operation, value(summary), who, input).summary, summary, 'R2c SQL: largest in every entry');
  const r2a = { ...summary, byType: Object.fromEntries(Object.entries(summary.byType).map(([type, { largest, ...rest }]) => [type, rest])) };
  assert.throws(() => domainResult(operation, value(r2a), who, input), 'R2a SQL (no largest in any entry): refused since the window closed');
  assert.throws(() => domainResult(operation, value({ ...r2a, byType: { ...r2a.byType, INCOME: summary.byType.INCOME } }), who, input), 'mixed: one entry only');
  assert.throws(() => domainResult(operation, value({ ...summary, byType: { ...summary.byType, EXPENSE: { ...summary.byType.EXPENSE, largest: 7 } } }), who, input), 'largest not a voucher');
  assert.throws(() => domainResult(operation, value({ ...summary, byType: { ...summary.byType, EXPENSE: { ...summary.byType.EXPENSE, top: summary.byType.EXPENSE.largest } } }), who, input), 'unknown entry key');
  // Đường nhanh không có income_expenses; luật nằm ở domainResult cho mọi lane.
  assert.equal(FAST_READ_OPERATIONS.includes(operation), false);
});

// R2c phần 2 (21/10/2026): cửa sổ phát hành của assets (dòng createdAt + summary.latest, 20261021044801) ĐÃ ĐÓNG ở bản R2d
// — production áp 21/10: dòng thiếu createdAt hay summary thiếu latest đều bị từ chối. customers.byStatus không cần cửa sổ:
// {} của SQL trước vẫn hợp lệ.
test('R2c part 2 window closed: assets rows need createdAt and the summary needs latest; customers keep the tabs, {} or null', () => {
  assert.equal(Object.hasOwn(DOMAIN_SUMMARY_KEY_TOLERANT, 'assets') && DOMAIN_SUMMARY_KEY_TOLERANT.assets.includes('latest'), false, 'assets.latest has no window');
  const operation = 'assets', who = identity(operation), input = domainInput(operation, {});
  const second = { ...ROWS.assets, id: id(12), name: 'Tài sản 2', createdAt: '2026-10-25' }, rows = [ROWS.assets, second];
  const value = (items, summary) => ({ ...bare(operation, items[0]), items, summary });
  const fresh = summarizeRows(operation, rows), old = rows.map(row => without(row, ['createdAt'])), withoutLatest = without(fresh, ['latest']);
  assert.equal(fresh.latest.id, id(12));
  assert.deepEqual(domainResult(operation, value(rows, fresh), who, input).summary, fresh, 'SQL 20261021044801: createdAt and latest');
  for (const [label, items, summary] of [['SQL before it: neither', old, withoutLatest], ['rows dated, summary without latest', rows, withoutLatest],
    ['rows not dated, summary with latest', old, fresh], ['one row dated, one not', [ROWS.assets, old[1]], fresh],
    ['latest of the wrong shape', rows, { ...fresh, latest: { ...fresh.latest, quantity: '1' } }]])
    assert.throws(() => domainResult(operation, value(items, summary), who, input), label);
  // customers: the contract-status tabs or null (fast lane with a query); never another key, never above count.
  const customers = 'customers', base = summarizeRows(customers, [ROWS.customers]);
  for (const byStatus of [{}, null, { RENTING: 1 }, { WALK_IN: 1 }])
    assert.deepEqual(domainResult(customers, { ...bare(customers, ROWS.customers), summary: { ...base, byStatus } }, identity(customers), domainInput(customers, {})).summary.byStatus, byStatus);
  for (const byStatus of [{ ACTIVE: 1 }, { RENTING: 1, WALK_IN: 1 }, { RENTING: -1 }, []])
    assert.throws(() => domainResult(customers, { ...bare(customers, ROWS.customers), summary: { ...base, byStatus } }, identity(customers), domainInput(customers, {})), JSON.stringify(byStatus));
});

// R2d (21/10/2026): cửa sổ phát hành MỚI cho hai khoá summary cấp một — customers.withoutContract (20261021063452 đường
// nhanh, 20261021063453 v3) và assets.latestCount (20261021063452) — lên SAU connector này. Bản này nhận SQL R2c (vắng) và
// SQL R2d (có mặt, đúng kiểu, đúng bất biến); khoá lạ, sai kiểu vẫn bị từ chối. Bản kế (sau khi production áp hai migration):
// DOMAIN_SUMMARY_KEY_TOLERANT = {} — hai khoá bắt buộc — và đổi test này theo.
test('R2d release window: customers.withoutContract and assets.latestCount may be absent this release; present means checked', () => {
  assert.deepEqual(DOMAIN_SUMMARY_KEY_TOLERANT, { customers: ['withoutContract'], assets: ['latestCount'] }, 'next release: {}');
  assert.ok(Object.isFrozen(DOMAIN_SUMMARY_KEY_TOLERANT) && Object.values(DOMAIN_SUMMARY_KEY_TOLERANT).every(Object.isFrozen));
  for (const [operation, key, fresh] of [['customers', 'withoutContract', 0], ['assets', 'latestCount', 1]]) {
    const who = identity(operation), input = domainInput(operation, {}), base = summarizeRows(operation, [ROWS[operation]]);
    const value = summary => ({ ...bare(operation, ROWS[operation]), summary });
    assert.ok(Object.hasOwn(DOMAIN_SUMMARIES[operation].fields, key), `${operation}.${key} is a declared summary key`);
    assert.deepEqual(domainResult(operation, value({ ...base, [key]: fresh }), who, input).summary[key], fresh, `${operation}: R2d SQL`);
    assert.equal(domainResult(operation, value({ ...base, [key]: null }), who, input).summary[key], null, `${operation}: unknown (null)`);
    assert.equal(Object.hasOwn(domainResult(operation, value(without(base, [key])), who, input).summary, key), false, `${operation}: R2c SQL (window)`);
    for (const bad of ['1', -1, 2.5, true, [], {}])
      assert.throws(() => domainResult(operation, value({ ...base, [key]: bad }), who, input), `${operation}.${key} = ${JSON.stringify(bad)}`);
    assert.throws(() => domainResult(operation, value({ ...base, [key]: fresh, [`${key}V2`]: fresh }), who, input), `${operation}: unknown summary key`);
  }
  // The invariants hold in the window too: the one customer on the page holds a contract; one asset ⇒ a batch of one.
  assert.throws(() => domainResult('customers', { ...bare('customers', ROWS.customers), summary: { ...summarizeRows('customers', [ROWS.customers]), withoutContract: 1 } },
    identity('customers'), domainInput('customers', {})), 'the page row with a contract cannot be without one');
  assert.throws(() => domainResult('assets', { ...bare('assets', ROWS.assets), summary: { ...summarizeRows('assets', [ROWS.assets]), latestCount: 0 } },
    identity('assets'), domainInput('assets', {})), 'a latest asset with an empty batch');
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
