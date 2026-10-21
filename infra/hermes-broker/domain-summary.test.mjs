import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN_READS, DOMAIN_FAMILIES, DOMAIN_SUMMARIES, DOMAIN_SUMMARY_TOLERANT, DOMAIN_TOOLS, domainInput, domainResult, summarizeRows } from './domain-contract.mjs';
import { domainFastResult, FAST_READ_OPERATIONS } from './domain-read-fast.mjs';
import { createReadNameResolver } from './read-name-resolution.mjs';

// R2a (21/10/2026), phía connector của `summary` (SQL: domain-summary-sql.test.mjs trên PostgreSQL 17 và các test PGlite
// v1/v2/v3): khuôn chính xác theo miền, bất biến giữa summary và trang (count ≥ số dòng, byStatus đúng bộ lọc, byBuilding
// trong phạm vi khoá, largest trong kỳ), cửa sổ phát hành (vắng summary vẫn qua đúng một bản), summarizeRows khớp từng ký tự
// cách SQL cộng numeric, lọc phòng ở connector thay summary. Dữ liệu tổng hợp, không có dữ liệu khách thật.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id(1), A = id(2), B = id(3), OUT = id(4), ROOM = id(5), USER = id(6), CONNECTION = id(7);
const NOW = Date.parse('2026-10-21T00:00:00.000Z');
const LIST = Object.keys(DOMAIN_READS).filter(operation => typeof DOMAIN_READS[operation].result !== 'function' && DOMAIN_READS[operation].family !== 'w2');
const sorted = values => [...values].sort();
const identity = operation => ({ row: { id: CONNECTION, organizationId: ORG, userId: USER },
  scopesByPermission: { [DOMAIN_READS[operation].permission]: { buildingIds: [A, B], cashbookIds: [] } } });
const input = (operation, extra = {}) => domainInput(operation, { ...(DOMAIN_READS[operation].requiresDates ? { fromDate: '2026-10-01', toDate: '2026-10-31' } : {}), ...extra });
const place = (n, building = A) => ({ buildingId: building, buildingName: building === A ? 'Toà A' : 'Toà B', roomId: ROOM, roomName: `P${n}` });
// Hai–ba dòng hợp lệ mỗi miền (id tăng dần như keyset của SQL).
const ROWS = {
  customers: [{ id: id(11), name: 'Khách 1', phone: null, contractId: id(21), ...place(1) }, { id: id(12), name: 'Khách 2', phone: null, contractId: null,
    buildingId: null, buildingName: '', roomId: null, roomName: null }],
  leads: [{ id: id(11), name: 'Hẹn 1', status: 'B1_LEAD', ...place(1), nextFollowUp: null }, { id: id(12), name: 'Hẹn 2', status: 'CONVERTED', ...place(2, B), nextFollowUp: null }],
  contracts: [{ id: id(11), number: 'HD1', status: 'ACTIVE', ...place(1), startDate: '2026-01-01', endDate: null },
    { id: id(12), number: 'HD2', status: 'TERMINATED', ...place(2, B), startDate: '2025-01-01', endDate: '2026-01-01' },
    { id: id(13), number: 'HD3', status: 'ACTIVE', ...place(3, B), startDate: '2026-02-01', endDate: null }],
  invoices: [{ id: id(11), number: 'INV1', status: 'APPROVED', ...place(1), billingMonth: '2026-10', totalAmount: '100.50' },
    { id: id(12), number: 'INV2', status: 'CANCELLED', ...place(2, B), billingMonth: '2026-10', totalAmount: '7' }],
  assets: [{ id: id(11), name: 'Máy lạnh', code: 'ML', condition: 'GOOD', ...place(1), quantity: '2' },
    { id: id(12), name: 'Bàn', code: null, condition: 'BROKEN', ...place(2, B), quantity: '1.5' }, { id: id(13), name: 'Ghế', code: null, condition: null, ...place(3), quantity: '4' }],
  services: [{ id: id(11), name: 'Điện', code: 'DIEN', unit: 'kWh', unitPrice: '3500', buildingIds: [A, B] }],
  tasks: [{ id: id(11), title: 'Sửa vòi', code: null, status: 'IN_PROGRESS', ...place(1), deadline: '2026-10-20T03:00:00+00:00' },
    { id: id(12), title: 'Thay đèn', code: null, status: 'IN_PROGRESS', ...place(2), deadline: '2026-10-22T03:00:00+00:00' },
    { id: id(13), title: 'Dọn kho', code: null, status: 'COMPLETED', ...place(3, B), deadline: '2026-10-01T03:00:00+00:00' },
    { id: id(14), title: 'Không hạn', code: null, status: 'IN_PROGRESS', ...place(4, B), deadline: null }],
  occupancy: [{ id: A, buildingId: A, name: 'Toà A', total: 10, occupied: 7, available: 2 }, { id: B, buildingId: B, name: 'Toà B', total: 5, occupied: 5, available: 0 }],
  income_expenses: [{ id: id(11), code: 'PT1', type: 'INCOME', name: 'Thu phòng', ...place(1), voucherDate: '2026-10-05', totalAmount: '2500000.00', approvalStatus: 'APPROVED' },
    { id: id(12), code: 'PC1', type: 'EXPENSE', name: 'Sửa điện', ...place(2), voucherDate: '2026-10-02', totalAmount: '150000.00', approvalStatus: 'UNAPPROVED' },
    { id: id(13), code: 'PC2', type: 'EXPENSE', name: 'Huỷ', ...place(3, B), voucherDate: '2026-10-03', totalAmount: '9999999.00', approvalStatus: 'CANCELLED' },
    { id: id(14), code: 'PC3', type: 'EXPENSE', name: 'Vật tư', ...place(4, B), voucherDate: '2026-10-04', totalAmount: '500000.5', approvalStatus: 'APPROVED' }],
  receivables: [
    { id: id(11), number: 'HD1', status: 'APPROVED', ...place(1), buildingCode: 'A', billingMonth: '2026-10', dueDate: '2026-10-10', totalAmount: '3000', paidAmount: '1000', remainingAmount: '2000' },
    { id: id(12), number: 'HD2', status: 'OVERDUE', ...place(2, B), buildingCode: null, billingMonth: '2026-09', dueDate: null, totalAmount: '4500.25', paidAmount: '0', remainingAmount: '4500.25' },
    { id: id(13), number: 'HD3', status: 'PARTIAL_PAID', ...place(3), buildingCode: 'A', billingMonth: '2026-10', dueDate: '2026-10-15', totalAmount: '600', paidAmount: '100', remainingAmount: '500' }],
  meter_readings: [{ id: id(11), code: 'CS1', ...place(1), meterType: 'ELECTRICITY', settlementMonth: '2026-10', readingDate: '2026-10-01', previousReading: '100.00', currentReading: '150.00', consumption: '50.00', status: 'APPROVED' },
    { id: id(12), code: 'CS2', ...place(1), meterType: 'WATER', settlementMonth: '2026-10', readingDate: '2026-10-01', previousReading: '10', currentReading: '12', consumption: '2', status: 'UNAPPROVED' },
    { id: id(13), code: 'CS3', buildingId: B, buildingName: 'Toà B', roomId: null, roomName: null, meterType: 'WATER', settlementMonth: null, readingDate: '2026-10-02',
      previousReading: '0', currentReading: '1.5', consumption: '1.5', status: 'APPROVED' }],
  deposits_held: [{ id: A, buildingId: A, name: 'Toà A', contractCount: 3, expected: '9000000', held: '6000000.50', shortfallAll: '2999999.50', shortfallShort: '2999999.50', fullCount: 2, shortCount: 1, firstInvoiceCount: 0 },
    { id: B, buildingId: B, name: 'Toà B', contractCount: 1, expected: '1000000', held: '1000000', shortfallAll: '0', shortfallShort: '0', fullCount: 1, shortCount: 0, firstInvoiceCount: 1 }],
  building_profit: [{ id: A, buildingId: A, name: 'Toà A', revenue: '2500000.00', expense: '650000.50', net: '1849999.50', months: 1 },
    { id: B, buildingId: B, name: 'Toà B', revenue: '0', expense: '120000', net: '-120000', months: 2 }],
};
const envelope = (operation, items, summary) => {
  const family = DOMAIN_FAMILIES[DOMAIN_READS[operation].family];
  return { organizationId: ORG, domain: operation, ...(summary === undefined ? {} : { summary }), items, nextCursor: null,
    ...(family.resultKeys.includes('source') ? { source: DOMAIN_READS[operation].source } : {}),
    ...(family.resultKeys.includes('fetchedAt') ? { fetchedAt: '2026-10-21T00:00:00.000Z' } : {}) };
};
const check = (operation, summary, items = ROWS[operation], extra = {}) => domainResult(operation, envelope(operation, items, summary), identity(operation), input(operation, extra));
const full = operation => summarizeRows(operation, ROWS[operation], { now: NOW });

test('R2a contract: one summary shape per list tool, all tolerant for exactly this release; tools/list unchanged by R2a', () => {
  assert.equal(LIST.length, 13);
  assert.deepEqual(sorted(Object.keys(DOMAIN_SUMMARIES)), sorted(LIST));
  assert.deepEqual(sorted(DOMAIN_SUMMARY_TOLERANT), sorted(LIST), 'release window: an absent summary still passes; the next connector empties this list');
  assert.ok(Object.isFrozen(DOMAIN_SUMMARIES) && Object.isFrozen(DOMAIN_SUMMARY_TOLERANT));
  // summary is a result key only: no tool input, schema or description mentions it (0 byte on tools/list).
  for (const tool of DOMAIN_TOOLS) assert.equal(JSON.stringify(tool.inputSchema).includes('summary'), false, tool.name);
});

for (const operation of Object.keys(ROWS)) {
  test(`R2a ${operation}: the full-set summary passes, is projected right after domain, and an absent one passes only by the release window`, () => {
    const summary = full(operation), value = envelope(operation, ROWS[operation], summary);
    const result = check(operation, summary);
    assert.deepEqual(result, value);
    assert.deepEqual(Object.keys(result).slice(0, 3), ['organizationId', 'domain', 'summary']);
    result.summary.count += 1; assert.equal(summary.count, ROWS[operation].length, 'the projection is a copy');
    assert.deepEqual(check(operation, undefined), envelope(operation, ROWS[operation]), 'tolerant: SQL before 20261020233934/20261021004841');
    for (const [label, changed] of [['unknown key', { ...summary, extra: 1 }], ['count missing', (({ count, ...rest }) => rest)(summary)],
      ['count text', { ...summary, count: String(summary.count) }], ['count below the page rows', { ...summary, count: ROWS[operation].length - 1 }],
      ['negative count', { ...summary, count: -1 }], ['null summary', null], ['array summary', []]])
      assert.throws(() => check(operation, changed), label);
    if (summary.sum) for (const key of Object.keys(summary.sum)) {
      assert.throws(() => check(operation, { ...summary, sum: { ...summary.sum, [key]: Number(summary.sum[key]) } }), `${key} as a number`);
      assert.throws(() => check(operation, { ...summary, sum: (({ [key]: _, ...rest }) => rest)(summary.sum) }), `${key} missing`);
    }
    if (summary.sum) assert.throws(() => check(operation, { ...summary, sum: { ...summary.sum, other: '1' } }), 'unknown money key');
    if (summary.byStatus && Object.keys(summary.byStatus).length) {
      const [key] = Object.keys(summary.byStatus);
      assert.throws(() => check(operation, { ...summary, byStatus: { ...summary.byStatus, [key]: -1 } }), 'negative status count');
      assert.throws(() => check(operation, { ...summary, byStatus: { ...summary.byStatus, [key]: summary.count + 1 } }), 'status counts above count');
    }
  });
}

test('R2a invariants: status filter, scope and building filter of byBuilding, order, period of largest, partial counts', () => {
  // byStatus counts the filtered column: a filtered read lists only that value.
  const debts = ROWS.receivables.filter(row => row.status === 'OVERDUE');
  assert.equal(check('receivables', summarizeRows('receivables', debts), debts, { status: 'OVERDUE' }).summary.byStatus.OVERDUE, 1);
  assert.throws(() => check('receivables', { ...summarizeRows('receivables', debts), byStatus: { OVERDUE: 1, APPROVED: 0 } }, debts, { status: 'OVERDUE' }));
  const vouchers = ROWS.income_expenses.filter(row => row.approvalStatus === 'APPROVED');
  assert.equal(check('income_expenses', summarizeRows('income_expenses', vouchers), vouchers, { status: 'APPROVED' }).summary.count, 2);
  assert.throws(() => check('income_expenses', full('income_expenses'), ROWS.income_expenses.slice(0, 1), { status: 'APPROVED' }), 'other statuses under a status filter');
  for (const [label, key, value] of [['status outside the debt set', 'byStatus', { PAID: 1 }], ['voucher status outside the enum', 'byStatus', { DRAFT: 1 }]])
    assert.throws(() => check(label.startsWith('voucher') ? 'income_expenses' : 'receivables', { ...full(label.startsWith('voucher') ? 'income_expenses' : 'receivables'), [key]: value }), label);
  // byBuilding: the building of each group is in the key's scope, matches buildingId, order remainingAmount desc then id.
  const debtSummary = full('receivables');
  assert.deepEqual(debtSummary.byBuilding, [{ buildingId: B, buildingName: 'Toà B', count: 1, remainingAmount: '4500.25' },
    { buildingId: A, buildingName: 'Toà A', count: 2, remainingAmount: '2500' }]);
  for (const [label, byBuilding] of [
    ['building outside the scope', [{ ...debtSummary.byBuilding[0], buildingId: OUT }, debtSummary.byBuilding[1]]],
    ['ascending order', [...debtSummary.byBuilding].reverse()],
    ['same building twice', [debtSummary.byBuilding[0], debtSummary.byBuilding[0]]],
    ['empty group', [{ ...debtSummary.byBuilding[0], count: 0 }, debtSummary.byBuilding[1]]],
    ['settled group', [debtSummary.byBuilding[0], { ...debtSummary.byBuilding[1], remainingAmount: '0' }]],
    ['groups above count', [{ ...debtSummary.byBuilding[0], count: 3 }, debtSummary.byBuilding[1]]],
    ['more than 50 buildings', Array.from({ length: 51 }, (_, n) => ({ buildingId: id(900 + n), buildingName: 'x', count: 1, remainingAmount: '1' }))],
    ['unknown field', [{ ...debtSummary.byBuilding[0], code: 'B' }, debtSummary.byBuilding[1]]]])
    assert.throws(() => check('receivables', { ...debtSummary, byBuilding }), label);
  const tie = [{ buildingId: A, buildingName: 'Toà A', count: 1, remainingAmount: '5.0' }, { buildingId: B, buildingName: 'Toà B', count: 1, remainingAmount: '5' }];
  assert.equal(check('receivables', { ...debtSummary, byBuilding: tie }).summary.byBuilding.length, 2, 'equal amounts (any scale) order by building id');
  assert.throws(() => check('receivables', { ...debtSummary, byBuilding: [...tie].reverse() }), 'tie broken the wrong way');
  const onlyA = ROWS.receivables.filter(row => row.buildingId === A);
  assert.throws(() => check('receivables', { ...summarizeRows('receivables', onlyA), byBuilding: debtSummary.byBuilding }, onlyA, { buildingId: A }), 'another building under a building filter');
  // income_expenses: largest is a live voucher inside the period; byType only INCOME/EXPENSE.
  const money = full('income_expenses');
  assert.deepEqual(money.largest, { id: id(11), code: 'PT1', name: 'Thu phòng', type: 'INCOME', totalAmount: '2500000.00', voucherDate: '2026-10-05' });
  assert.throws(() => check('income_expenses', money, ROWS.income_expenses, { fromDate: '2026-10-06' }), 'largest before the period');
  assert.throws(() => check('income_expenses', money, ROWS.income_expenses, { toDate: '2026-10-04' }), 'largest after the period');
  assert.throws(() => check('income_expenses', { ...money, count: 0, byStatus: {}, byType: {} }, []), 'largest of an empty set');
  assert.throws(() => check('income_expenses', { ...money, byType: { ...money.byType, TRANSFER: { count: 1, sum: '1' } } }), 'type outside INCOME/EXPENSE');
  assert.throws(() => check('income_expenses', { ...money, byType: { INCOME: { count: 5, sum: '1' } } }), 'typed counts above count');
  assert.throws(() => check('income_expenses', { ...money, largest: { ...money.largest, payer: 'x' } }), 'largest with an extra field');
  // Partial counts never exceed the whole set.
  assert.throws(() => check('tasks', { ...full('tasks'), overdue: 5 }), 'overdue above count');
  assert.throws(() => check('meter_readings', { ...full('meter_readings'), rooms: 4 }), 'rooms above count');
  assert.throws(() => check('meter_readings', { ...full('meter_readings'), byType: { WATER: 4 } }), 'meter types above count');
  assert.throws(() => check('meter_readings', { ...full('meter_readings'), byType: { STEAM: 1 } }), 'unknown meter type');
  assert.throws(() => check('occupancy', { ...full('occupancy'), occupied: 15, available: 1 }), 'occupied + available above total');
  // The fast lane of contracts has no byStatus when the core matched a query (null, not {}).
  assert.equal(check('contracts', { ...full('contracts'), byStatus: null }).summary.byStatus, null);
  assert.throws(() => check('customers', { ...full('customers'), byStatus: null }), 'only contracts may send null');
  // The core's count may exceed the projected rows (rows without a room): count above items is fine.
  assert.equal(check('invoices', { ...full('invoices'), count: 9 }).summary.count, 9);
});

test('R2a fast lane: domainFastResult carries the same summary rule', () => {
  for (const operation of FAST_READ_OPERATIONS) {
    const authority = { organizationId: ORG, userId: USER, connectionId: CONNECTION, permission: DOMAIN_READS[operation].permission, buildingIds: [A, B], cashbookIds: [] };
    const summary = full(operation), result = envelope(operation, ROWS[operation], summary);
    assert.deepEqual(domainFastResult(operation, { authority, result }, identity(operation), input(operation)), result, operation);
    assert.throws(() => domainFastResult(operation, { authority, result: { ...result, summary: { ...summary, count: -1 } } }, identity(operation), input(operation)), operation);
  }
  const authority = { organizationId: ORG, userId: USER, connectionId: CONNECTION, permission: 'invoices.view', buildingIds: [A], cashbookIds: [] };
  const onlyA = ROWS.receivables.filter(row => row.buildingId === A);
  assert.throws(() => domainFastResult('receivables', { authority, result: envelope('receivables', onlyA, { ...summarizeRows('receivables', onlyA), byBuilding: full('receivables').byBuilding }) },
    identity('receivables'), input('receivables')), 'the live scope of the statement fences byBuilding too');
});

test('R2a summarizeRows: numeric sums keep the largest scale like PostgreSQL, CANCELLED money is left out, ties and caps follow SQL', () => {
  assert.deepEqual(full('receivables').sum, { totalAmount: '8100.25', paidAmount: '1100', remainingAmount: '7000.25' });
  assert.deepEqual(full('income_expenses'), { count: 4, byStatus: { APPROVED: 2, UNAPPROVED: 1, CANCELLED: 1 }, sum: { totalAmount: '3150000.50' },
    byType: { INCOME: { count: 1, sum: '2500000.00' }, EXPENSE: { count: 2, sum: '650000.50' } }, largest: full('income_expenses').largest });
  assert.equal(full('income_expenses').largest.id, id(11), 'the 9 999 999 voucher is CANCELLED');
  const cancelled = ROWS.income_expenses.filter(row => row.approvalStatus === 'CANCELLED');
  assert.deepEqual(summarizeRows('income_expenses', cancelled), { count: 1, byStatus: { CANCELLED: 1 }, sum: { totalAmount: '0' }, byType: {}, largest: null });
  const tie = [{ ...ROWS.income_expenses[1], id: id(31), totalAmount: '10.0' }, { ...ROWS.income_expenses[1], id: id(30), totalAmount: '10' }];
  assert.equal(summarizeRows('income_expenses', tie).largest.id, id(30), 'equal amounts: the smaller id, like ORDER BY total_amount DESC, id');
  assert.deepEqual(summarizeRows('income_expenses', []), { count: 0, byStatus: {}, sum: { totalAmount: '0' }, byType: {}, largest: null }, 'empty set: {} and 0, never null');
  assert.deepEqual(full('meter_readings'), { count: 3, byStatus: { APPROVED: 2, UNAPPROVED: 1 }, sum: { consumption: '53.50' }, byType: { ELECTRICITY: 1, WATER: 2 }, rooms: 1 });
  assert.deepEqual(full('tasks'), { count: 4, byStatus: { IN_PROGRESS: 3, COMPLETED: 1 }, sum: {}, overdue: 1 }, 'past deadline and still IN_PROGRESS');
  assert.deepEqual(full('assets'), { count: 3, byStatus: { GOOD: 1, BROKEN: 1 }, sum: { quantity: '7.5' } }, 'condition null counts in count only');
  assert.deepEqual(full('occupancy'), { count: 2, total: 15, occupied: 12, available: 2 });
  assert.deepEqual(full('deposits_held'), { count: 2, sum: { expected: '10000000', held: '7000000.50', shortfallAll: '2999999.50' }, contractCount: 4, fullCount: 3, shortCount: 1 });
  assert.deepEqual(full('building_profit'), { count: 2, sum: { revenue: '2500000.00', expense: '770000.50', net: '1729999.50' } });
  assert.deepEqual(full('contracts'), { count: 3, byStatus: { ACTIVE: 2, TERMINATED: 1 }, sum: {} });
  for (const operation of ['customers', 'invoices', 'services']) assert.deepEqual(full(operation), { count: ROWS[operation].length, byStatus: {}, sum: {} });
  // 55 buildings: k = 0..4 hold two rows (2 × (100 + k) = 200..208), k = 5..54 one row (105..154).
  const many = Array.from({ length: 60 }, (_, n) => ({ ...ROWS.receivables[0], id: id(1000 + n), buildingId: id(2000 + (n % 55)), remainingAmount: String(100 + (n % 55)) }));
  const capped = summarizeRows('receivables', many).byBuilding;
  assert.equal(capped.length, 50, 'top 50 buildings');
  assert.deepEqual([capped[0].remainingAmount, capped[0].count, capped[0].buildingId, capped.at(-1).remainingAmount], ['208', 2, id(2004), '110'],
    'two rows of the top building, the five smallest (105..109) dropped');
  assert.deepEqual(summarizeRows('receivables', [{ ...ROWS.receivables[0], remainingAmount: '-1.5' }, { ...ROWS.receivables[2], remainingAmount: '1' }]).sum.remainingAmount, '-0.5');
  assert.throws(() => summarizeRows('customer_detail', []), 'detail tools have no summary');
});

test('R2a room filter: the connector filters rows by room, so the merge replaces the SQL summary with the kept rows (complete) or null (more to read)', async () => {
  const rooms = [{ id: ROOM, name: 'P1', code: null, floor: 1, buildingId: A }];
  const rpc = async (name, accessToken, args) => name === 'hermes_building_directory_v1'
    ? { buildings: [{ id: A, name: 'Toà A', code: 'A' }, { id: B, name: 'Toà B', code: 'B' }].filter(row => args.p_building_ids.includes(row.id)) }
    : { rooms: rooms.filter(room => args.p_building_ids.includes(room.buildingId)) };
  const resolver = createReadNameResolver({ rpc });
  const who = { row: { id: CONNECTION, organizationId: ORG, userId: USER }, contextVersion: 'c'.repeat(64),
    scopesByPermission: { 'invoices.view': { buildingIds: [A, B], cashbookIds: [] } } };
  const { input: resolved, plan } = await resolver.resolve({ operation: 'receivables', input: domainInput('receivables', { limit: 5 }), names: { buildingName: 'Toà A', roomName: 'P1' },
    lane: 'fast', accessToken: 'bearer-fixture', identity: who, tokenDigest: 'd'.repeat(64), signal: new AbortController().signal });
  assert.equal(resolved.limit, 50);
  const other = { ...ROWS.receivables[0], id: id(14), roomId: id(99), roomName: 'P9', remainingAmount: '777' };
  const pageRows = [ROWS.receivables[0], other, ROWS.receivables[2]];
  const sqlSummary = summarizeRows('receivables', pageRows);
  const page = (items, nextCursor, summary = sqlSummary) => ({ ...envelope('receivables', items, summary), nextCursor });
  const done = plan.merge([page(pageRows, null)]);
  assert.deepEqual(done.items.map(row => row.id), [id(11), id(13)]);
  assert.deepEqual(done.summary, summarizeRows('receivables', [ROWS.receivables[0], ROWS.receivables[2]]), 'every matching row was read: the summary of the kept rows');
  assert.notDeepEqual(done.summary, sqlSummary, 'never the SQL figure of the unfiltered set');
  assert.deepEqual(Object.keys(done), ['organizationId', 'domain', 'summary', 'items', 'nextCursor', 'source', 'fetchedAt', 'roomFilter']);
  const more = plan.merge([page(pageRows, id(13))]);
  assert.deepEqual([more.nextCursor, more.summary, more.roomFilter.more], [id(13), null, true], 'rows left unread: no figure rather than a wrong one');
  const legacy = plan.merge([{ ...envelope('receivables', pageRows), nextCursor: null }]);
  assert.equal(Object.hasOwn(legacy, 'summary'), false, 'SQL before R2a: nothing to replace');
  assert.deepEqual(legacy.items.map(row => row.id), [id(11), id(13)]);
});
