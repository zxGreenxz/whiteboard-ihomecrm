import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN_READS, DOMAIN_FAMILIES, DOMAIN_SUMMARIES, DOMAIN_SUMMARY_TOLERANT, DOMAIN_SUMMARY_ENTRY_TOLERANT, DOMAIN_TOOLS, completeListSummary, domainInput, domainResult,
  summarizeRows } from './domain-contract.mjs';
import { domainFastResult, FAST_READ_OPERATIONS } from './domain-read-fast.mjs';
import { createReadNameResolver } from './read-name-resolution.mjs';

// R2a (21/10/2026), phía connector của `summary` (SQL: domain-summary-sql.test.mjs trên PostgreSQL 17 và các test PGlite
// v1/v2/v3): khuôn chính xác theo miền, bất biến giữa summary và trang (count ≥ số dòng, byStatus đúng bộ lọc, byBuilding
// trong phạm vi khoá, largest trong kỳ), summary BẮT BUỘC (cửa sổ phát hành R2a đã đóng 21/10), summarizeRows khớp từng ký
// tự cách SQL cộng numeric, lọc phòng ở connector thay summary. R2c: byType.<loại>.largest của income_expenses (cửa sổ phát
// hành đã đóng ở bản R2d). R2d: customers.withoutContract, assets.latestCount (bất biến + cửa sổ một bản). Dữ liệu tổng hợp,
// không có dữ liệu khách thật.
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
  assets: [{ id: id(11), name: 'Máy lạnh', code: 'ML', condition: 'GOOD', ...place(1), quantity: '2', createdAt: '2026-10-01' },
    { id: id(12), name: 'Bàn', code: null, condition: 'BROKEN', ...place(2, B), quantity: '1.5', createdAt: '2026-10-15' },
    { id: id(13), name: 'Ghế', code: null, condition: null, ...place(3), quantity: '4', createdAt: '2026-10-15' }],
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

test('R2a contract: one summary shape per list tool, required since the release window closed; tools/list unchanged by R2a/R2c', () => {
  assert.equal(LIST.length, 13);
  assert.deepEqual(sorted(Object.keys(DOMAIN_SUMMARIES)), sorted(LIST));
  assert.deepEqual([...DOMAIN_SUMMARY_TOLERANT], [], 'R2a window closed (production applied both migrations 21/10): summary is required');
  assert.ok(Object.isFrozen(DOMAIN_SUMMARIES) && Object.isFrozen(DOMAIN_SUMMARY_TOLERANT));
  // summary is a result key only: no tool input, schema or description mentions it (0 byte on tools/list).
  for (const tool of DOMAIN_TOOLS) assert.equal(JSON.stringify(tool.inputSchema).includes('summary'), false, tool.name);
});

for (const operation of Object.keys(ROWS)) {
  test(`R2a ${operation}: the full-set summary passes, is projected right after domain, and an absent one is refused`, () => {
    const summary = full(operation), value = envelope(operation, ROWS[operation], summary);
    const result = check(operation, summary);
    assert.deepEqual(result, value);
    assert.deepEqual(Object.keys(result).slice(0, 3), ['organizationId', 'domain', 'summary']);
    result.summary.count += 1; assert.equal(summary.count, ROWS[operation].length, 'the projection is a copy');
    assert.throws(() => check(operation, undefined), 'SQL before 20261020233934/20261021004841: refused since the R2a window closed');
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
  // The fast lane of contracts (and, since R2c part 2, customers) has no byStatus when the core matched a query (null, not {}).
  assert.equal(check('contracts', { ...full('contracts'), byStatus: null }).summary.byStatus, null);
  assert.equal(check('customers', { ...full('customers'), byStatus: null }).summary.byStatus, null);
  assert.throws(() => check('invoices', { ...full('invoices'), byStatus: null }), 'only contracts and customers may send null');
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
  const voucher = row => ({ id: row.id, code: row.code, name: row.name, type: row.type, totalAmount: row.totalAmount, voucherDate: row.voucherDate });
  assert.deepEqual(full('income_expenses'), { count: 4, byStatus: { APPROVED: 2, UNAPPROVED: 1, CANCELLED: 1 }, sum: { totalAmount: '3150000.50' },
    byType: { INCOME: { count: 1, sum: '2500000.00', largest: voucher(ROWS.income_expenses[0]) },
      EXPENSE: { count: 2, sum: '650000.50', largest: voucher(ROWS.income_expenses[3]) } }, largest: voucher(ROWS.income_expenses[0]) },
  'R2c: the largest EXPENSE is 500 000.5 (the 9 999 999 one is CANCELLED); the largest of all stays the income voucher');
  assert.equal(full('income_expenses').largest.id, id(11), 'the 9 999 999 voucher is CANCELLED');
  const cancelled = ROWS.income_expenses.filter(row => row.approvalStatus === 'CANCELLED');
  assert.deepEqual(summarizeRows('income_expenses', cancelled), { count: 1, byStatus: { CANCELLED: 1 }, sum: { totalAmount: '0' }, byType: {}, largest: null });
  const tie = [{ ...ROWS.income_expenses[1], id: id(31), totalAmount: '10.0' }, { ...ROWS.income_expenses[1], id: id(30), totalAmount: '10' }];
  assert.equal(summarizeRows('income_expenses', tie).largest.id, id(30), 'equal amounts: the smaller id, like ORDER BY total_amount DESC, id');
  assert.equal(summarizeRows('income_expenses', tie).byType.EXPENSE.largest.id, id(30), 'per type too');
  assert.deepEqual(summarizeRows('income_expenses', []), { count: 0, byStatus: {}, sum: { totalAmount: '0' }, byType: {}, largest: null }, 'empty set: {} and 0, never null');
  assert.deepEqual(full('meter_readings'), { count: 3, byStatus: { APPROVED: 2, UNAPPROVED: 1 }, sum: { consumption: '53.50' }, byType: { ELECTRICITY: 1, WATER: 2 }, rooms: 1 });
  assert.deepEqual(full('tasks'), { count: 4, byStatus: { IN_PROGRESS: 3, COMPLETED: 1 }, sum: {}, overdue: 1 }, 'past deadline and still IN_PROGRESS');
  assert.deepEqual(full('assets'), { count: 3, byStatus: { GOOD: 1, BROKEN: 1 }, sum: { quantity: '7.5' },
    latest: { id: id(12), name: 'Bàn', code: null, buildingId: B, buildingName: 'Toà B', roomName: 'P2', createdAt: '2026-10-15' }, latestCount: null },
  'condition null counts in count only; latest: the newest day, the smaller id within it (SQL orders the real instant); latestCount: rows carry no instant');
  assert.deepEqual(full('occupancy'), { count: 2, total: 15, occupied: 12, available: 2 });
  assert.deepEqual(full('deposits_held'), { count: 2, sum: { expected: '10000000', held: '7000000.50', shortfallAll: '2999999.50' }, contractCount: 4, fullCount: 3, shortCount: 1 });
  assert.deepEqual(full('building_profit'), { count: 2, sum: { revenue: '2500000.00', expense: '770000.50', net: '1729999.50' } });
  assert.deepEqual(full('contracts'), { count: 3, byStatus: { ACTIVE: 2, TERMINATED: 1 }, sum: {} });
  for (const operation of ['invoices', 'services']) assert.deepEqual(full(operation), { count: ROWS[operation].length, byStatus: {}, sum: {} });
  assert.deepEqual(full('customers'), { count: ROWS.customers.length, byStatus: null, sum: {}, withoutContract: null },
    'customer rows carry no contract status nor contract history: unknown, not {} or 0');
  // 55 buildings: k = 0..4 hold two rows (2 × (100 + k) = 200..208), k = 5..54 one row (105..154).
  const many = Array.from({ length: 60 }, (_, n) => ({ ...ROWS.receivables[0], id: id(1000 + n), buildingId: id(2000 + (n % 55)), remainingAmount: String(100 + (n % 55)) }));
  const capped = summarizeRows('receivables', many).byBuilding;
  assert.equal(capped.length, 50, 'top 50 buildings');
  assert.deepEqual([capped[0].remainingAmount, capped[0].count, capped[0].buildingId, capped.at(-1).remainingAmount], ['208', 2, id(2004), '110'],
    'two rows of the top building, the five smallest (105..109) dropped');
  assert.deepEqual(summarizeRows('receivables', [{ ...ROWS.receivables[0], remainingAmount: '-1.5' }, { ...ROWS.receivables[2], remainingAmount: '1' }]).sum.remainingAmount, '-0.5');
  assert.throws(() => summarizeRows('customer_detail', []), 'detail tools have no summary');
});

// R2c (21/10/2026; SQL 20261021035022, PostgreSQL 17 in domain-summary-sql.test.mjs, PGlite in domain-v2.test.mjs): every
// byType entry names the largest live voucher of its type. Production asked "khoản chi lớn nhất tháng này" with
// {fromDate,toDate} only: summary.largest (both types) was an income voucher; byType.EXPENSE.largest is the answer.
test('R2c byType.<type>.largest: the largest live voucher of each type; invariants against the type, its sum, the period and summary.largest', () => {
  const money = full('income_expenses'), month = { fromDate: '2026-10-01', toDate: '2026-10-31' };
  assert.deepEqual(check('income_expenses', money, ROWS.income_expenses, month).summary, money);
  assert.deepEqual([money.largest.type, money.byType.EXPENSE.largest.id], ['INCOME', id(14)], 'the question of production: summary.largest is income, the answer is byType.EXPENSE.largest');
  const entry = (type, change) => ({ ...money, byType: { ...money.byType, [type]: { ...money.byType[type], ...change } } });
  const expense = money.byType.EXPENSE.largest, income = money.byType.INCOME.largest;
  for (const [label, changed] of [
    ['largest of another type', entry('EXPENSE', { largest: { ...expense, type: 'INCOME' } })],
    ['summary.largest above the largest of its type', { ...money, largest: { ...income, id: id(9), totalAmount: '2600000.00' } }],
    ['largest above the sum of its type', entry('EXPENSE', { largest: { ...expense, totalAmount: '650000.51' } })],
    ['largest above summary.largest', entry('EXPENSE', { sum: '9999999.00', largest: { ...expense, totalAmount: '2500000.01' } })],
    ['tie with summary.largest broken the wrong way', entry('EXPENSE', { sum: '9999999.00', largest: { ...expense, id: id(10), totalAmount: '2500000.00' } })],
    ['null largest for a type with vouchers', entry('EXPENSE', { largest: null })],
    ['largest outside the period', entry('EXPENSE', { largest: { ...expense, voucherDate: '2026-09-30' } })],
    ['largest with an extra field', entry('EXPENSE', { largest: { ...expense, payer: 'x' } })],
    ['largest without its code', entry('EXPENSE', { largest: (({ code, ...rest }) => rest)(expense) })],
    ['largest amount as a number', entry('EXPENSE', { largest: { ...expense, totalAmount: 500000.5 } })],
    ['summary.largest is not the largest of its type', { ...money, largest: { ...income, id: id(15) } }],
    ['summary.largest of a type absent from byType', { ...money, byType: { EXPENSE: money.byType.EXPENSE }, largest: income }],
    ['no live voucher but a largest', { ...money, byType: {} }],
    ['live vouchers but no largest', { ...money, largest: null }],
    ['largest in one entry only', entry('INCOME', { largest: undefined })],
  ]) assert.throws(() => check('income_expenses', JSON.parse(JSON.stringify(changed)), ROWS.income_expenses, month), label);
  // count 0 is the only entry that may name no voucher (SQL never sends one; the shape allows it like summary.largest).
  const zero = { ...money, byType: { ...money.byType, EXPENSE: { count: 0, sum: '0', largest: null } } };
  assert.deepEqual(check('income_expenses', zero, ROWS.income_expenses, month).summary.byType.EXPENSE, { count: 0, sum: '0', largest: null });
  assert.throws(() => check('income_expenses', { ...zero, byType: { ...zero.byType, EXPENSE: { count: 0, sum: '0', largest: expense } } }, ROWS.income_expenses, month), 'count 0 naming a voucher');
  // Ties inside one type: the smaller id; a tie across types with summary.largest keeps the smaller id there too.
  const tie = [{ ...ROWS.income_expenses[0], id: id(41), type: 'EXPENSE', code: 'PC9', totalAmount: '2500000.00' }, ...ROWS.income_expenses];
  const tied = summarizeRows('income_expenses', tie);
  assert.deepEqual([tied.largest.id, tied.byType.EXPENSE.largest.id, tied.byType.INCOME.largest.id], [id(11), id(41), id(11)]);
  assert.deepEqual(check('income_expenses', tied, [...ROWS.income_expenses, tie[0]].sort((a, b) => a.id < b.id ? -1 : 1), month).summary, tied);
  // Release window (DOMAIN_SUMMARY_ENTRY_TOLERANT) closed by the R2d connector (production applied 20261021035022 on
  // 21/10): the R2a shape {count, sum} without largest is refused, in every entry or in one.
  assert.deepEqual(DOMAIN_SUMMARY_ENTRY_TOLERANT, {}, 'closed: largest is required in every byType entry');
  const r2a = { ...money, byType: Object.fromEntries(Object.entries(money.byType).map(([type, { largest, ...rest }]) => [type, rest])) };
  assert.throws(() => check('income_expenses', r2a, ROWS.income_expenses, month), 'the R2a entries (no largest anywhere) are refused');
});

// R2c part 2 (SQL 20261021044801/20261021044814; PostgreSQL 17 in domain-summary-sql.test.mjs, PGlite in
// domain-composition/domain-v3): assets.latest — the most recently added asset of the whole set — and customers.byStatus —
// the contract-status tabs of /customers (RENTING đang thuê, MOVED_OUT đã chuyển đi, WALK_IN vãng lai = chưa có hợp đồng).
test('R2c part 2 invariants: assets.latest of the whole set (null only when empty, in the key scope and building filter, never older than a page row); customer tabs', () => {
  const assets = full('assets'), latest = assets.latest;
  assert.deepEqual(check('assets', assets).summary.latest, latest);
  for (const [label, changed, items = ROWS.assets, extra = {}] of [
    ['null latest for a non-empty set', { ...assets, latest: null }],
    ['a latest for an empty set', { count: 0, byStatus: {}, sum: { quantity: '0' }, latest }, []],
    ['latest older than a page row', { ...assets, latest: { ...latest, createdAt: '2026-10-14' } }],
    ['latest outside the key scope', { ...assets, latest: { ...latest, buildingId: OUT } }],
    ['latest of another building than the filter', { ...summarizeRows('assets', ROWS.assets.filter(row => row.buildingId === A)), latest },
      ROWS.assets.filter(row => row.buildingId === A), { buildingId: A }],
    ['latest with an extra field', { ...assets, latest: { ...latest, quantity: '1' } }],
    ['latest without its room', { ...assets, latest: (({ roomName, ...rest }) => rest)(latest) }],
    ['latest date not a date', { ...assets, latest: { ...latest, createdAt: '15/10/2026' } }],
  ]) assert.throws(() => check('assets', changed, items, extra), label);
  // Unassigned (company-wide) assets have no building: such a latest is not fenced by building.
  assert.equal(check('assets', { ...assets, latest: { ...latest, createdAt: '2026-10-20', buildingId: null, buildingName: '', roomName: null } }).summary.latest.buildingId, null);
  assert.deepEqual(summarizeRows('assets', []), { count: 0, byStatus: {}, sum: { quantity: '0' }, latest: null, latestCount: null }, 'empty set: latest null');
  // Customers: the three tabs only, their total never above count; null (fast lane with a query) or {} (SQL before part 2).
  const customers = full('customers');
  for (const byStatus of [{ RENTING: 1, WALK_IN: 1 }, { MOVED_OUT: 2 }, {}, null])
    assert.deepEqual(check('customers', { ...customers, byStatus }).summary.byStatus, byStatus);
  for (const byStatus of [{ RENTING: 2, WALK_IN: 1 }, { ACTIVE: 1 }, { WALK_IN: 1.5 }])
    assert.throws(() => check('customers', { ...customers, byStatus }), JSON.stringify(byStatus));
});

// R2d (SQL 20261021063452/20261021063453; PostgreSQL 17 in domain-summary-sql.test.mjs, PGlite in domain-composition/
// domain-v3): customers.withoutContract — customers of the whole set without any contract in the connection's contract scope
// (production: no WALK_IN customer, byStatus could not answer) — and assets.latestCount — the assets sharing the latest
// asset's exact created_at (production imported every asset in one batch). Both may be absent this release (the window)
// and null (unknown: fast lane with a query or an uncovered scope; summarizeRows, whose rows carry no history/instant).
test('R2d invariants: customers.withoutContract never counts a customer shown with a contract; assets.latestCount is 0 exactly without latest, never above count', () => {
  const customers = full('customers'), withContract = ROWS.customers.filter(row => row.contractId !== null).length;
  assert.equal(withContract, 1, 'fixture: one page row holds an active contract');
  for (const withoutContract of [0, 1, null])
    assert.equal(check('customers', { ...customers, withoutContract }).summary.withoutContract, withoutContract);
  assert.equal(check('customers', { ...customers, count: 9, withoutContract: 8 }).summary.withoutContract, 8, 'the rest of the set may lack one');
  assert.equal(Object.hasOwn(check('customers', (({ withoutContract, ...rest }) => rest)(customers)).summary, 'withoutContract'), false, 'absent (window): SQL before R2d');
  for (const [label, withoutContract, count = customers.count] of [['the contract holder counted', 2], ['above count', 3, 2], ['negative', -1], ['fraction', 0.5],
    ['text', '1'], ['boolean', false], ['object', {}]])
    assert.throws(() => check('customers', { ...customers, count, withoutContract }), label);
  assert.throws(() => check('customers', { ...customers, withoutContract: 0, withContract: 1 }), 'unknown key');
  // assets: SQL counts the batch of the latest instant (>= 1 when there is a latest, 0 for an empty set).
  const assets = { ...full('assets'), latestCount: 2 };
  assert.equal(check('assets', assets).summary.latestCount, 2);
  assert.equal(check('assets', { ...assets, latestCount: 3 }).summary.latestCount, 3, 'the whole set may share one instant');
  assert.equal(check('assets', { ...assets, latestCount: null }).summary.latestCount, null, 'unknown');
  assert.equal(Object.hasOwn(check('assets', (({ latestCount, ...rest }) => rest)(assets)).summary, 'latestCount'), false, 'absent (window): SQL before R2d');
  const empty = { count: 0, byStatus: {}, sum: { quantity: '0' }, latest: null };
  assert.deepEqual(check('assets', { ...empty, latestCount: 0 }, []).summary, { ...empty, latestCount: 0 }, 'empty set: 0');
  for (const [label, changed, items = ROWS.assets] of [['a batch without latest', { ...empty, latestCount: 1 }, []], ['latest without a batch', { ...assets, latestCount: 0 }],
    ['batch above count', { ...assets, latestCount: 4 }], ['negative', { ...assets, latestCount: -1 }], ['fraction', { ...assets, latestCount: 1.5 }],
    ['text', { ...assets, latestCount: '2' }]])
    assert.throws(() => check('assets', changed, items), label);
  // The fast lane carries the same customers rule.
  const authority = { organizationId: ORG, userId: USER, connectionId: CONNECTION, permission: 'customers.view', buildingIds: [A, B], cashbookIds: [] };
  const result = envelope('customers', ROWS.customers, { ...customers, withoutContract: 1 });
  assert.equal(domainFastResult('customers', { authority, result }, identity('customers'), input('customers')).summary.withoutContract, 1);
  assert.throws(() => domainFastResult('customers', { authority, result: { ...result, summary: { ...customers, withoutContract: 2 } } }, identity('customers'), input('customers')));
});

// Hậu xử lý sau validator (21/10; full50e câu 14, production: crm_read_occupancy_report {report:upcoming, days:60} trả 15
// dòng, summary null ⇒ mô hình tự đếm bảng và nói "14 hợp đồng"): báo cáo phân trang offset mà SQL không có tổng riêng được
// connector cấp summary = {count: items.length} khi tập đã TRỌN; một phần thì không bao giờ.
test('completeListSummary: a complete offset-paged report without a summary of its own gets {count: items.length}; a part, a summary of its own and cursor lists are left alone', () => {
  const upcomingRow = n => ({ contractId: id(800 + n), contractNumber: `HD${n}`, buildingId: n % 2 ? A : B, buildingName: n % 2 ? 'Toà A' : 'Toà B', roomId: id(900 + n),
    roomName: `P${n}`, effectiveEndDate: '2026-11-30', daysRemaining: 40, rentPrice: '3000000', extensionApplied: false });
  const report = (operation, name, source, items, extra = {}) => ({ organizationId: ORG, domain: operation, fetchedAt: '2026-10-21T00:00:00.000Z', report: name, source,
    unavailable: null, summary: null, items, offset: 0, nextOffset: null, sourceCapped: false, ...extra });
  const upcoming = (items, extra) => report('occupancy_report', 'upcoming', 'crm.occupancy_upcoming_vacancy_v2', items, extra);
  const fifteen = Array.from({ length: 15 }, (_, n) => upcomingRow(n + 1));
  const validated = domainResult('occupancy_report', upcoming(fifteen), identity('occupancy_report'),
    domainInput('occupancy_report', { report: 'upcoming', days: 60, limit: 50 }));
  assert.equal(validated.summary, null, 'the validator is unchanged: this report has no summary of its own');
  const complete = completeListSummary(validated);
  assert.deepEqual(complete.summary, { count: 15 }, 'the production question: 15 contracts, read from summary.count');
  assert.deepEqual(Object.keys(complete), Object.keys(validated), 'same keys in the same order');
  assert.deepEqual({ ...complete, summary: null }, validated, 'nothing else changes');
  assert.equal(validated.summary, null, 'the validated result is not mutated');
  assert.deepEqual(completeListSummary(upcoming([])).summary, { count: 0 }, 'a complete empty report: 0');
  for (const [label, extra, items = fifteen] of [['a next page (nextOffset)', { nextOffset: 15 }], ['the source capped', { sourceCapped: true }],
    ['a later page (offset > 0: the earlier rows are not in it)', { offset: 20 }], ['unavailable (no building: not a 0)', { unavailable: 'no_building_scope' }, []],
    ['sourceCapped not a boolean', { sourceCapped: undefined }]])
    assert.equal(completeListSummary(upcoming(items, extra)).summary, null, label);
  // Another report of the same shape (v3 invoice search) and a crm_read_report run (wave 2, same items/offset/summary shape).
  const invoices = report('invoice_report', 'search', 'crm.invoices', [{ id: id(801) }, { id: id(802) }]);
  assert.deepEqual(completeListSummary(invoices).summary, { count: 2 });
  const run = report('report', 'room_detail', 'crm.rooms', [{ id: id(803) }]);
  assert.deepEqual(completeListSummary(run).summary, { count: 1 });
  // A summary of its own is never replaced (invoice stats, monthly_pnl, Zalo).
  const stats = report('invoice_report', 'stats', 'crm.invoices', [], { summary: { totalCount: 3 } });
  assert.equal(completeListSummary(stats), stats, 'returned as is');
  // Cursor lists keep the SQL summary (required since R2a); a room-filter merge with rows left keeps null.
  const list = { organizationId: ORG, domain: 'contracts', summary: full('contracts'), items: ROWS.contracts, nextCursor: null };
  assert.equal(completeListSummary(list), list);
  const partial = { ...list, summary: null, nextCursor: id(13) };
  assert.equal(completeListSummary(partial), partial);
  assert.equal(completeListSummary({ ...partial, nextCursor: null }).summary, null, 'a cursor list never gets a count from here');
  for (const other of [null, [], 'x', { items: [] }, { organizationId: ORG, domain: 'customer_detail', item: null }]) assert.equal(completeListSummary(other), other);
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
  // merge() itself is pure: a page without summary keeps none. Such a page never reaches it now — every page is validated
  // first (bound-user-operation.finalize) and the R2a window is closed, so a summary-less page is backend_unavailable.
  const legacy = plan.merge([{ ...envelope('receivables', pageRows), nextCursor: null }]);
  assert.equal(Object.hasOwn(legacy, 'summary'), false, 'a page without summary: nothing to replace');
  assert.deepEqual(legacy.items.map(row => row.id), [id(11), id(13)]);
  const sortedPage = [...pageRows].sort((a, b) => a.id < b.id ? -1 : 1);
  const valid = { ...envelope('receivables', sortedPage, summarizeRows('receivables', sortedPage)), nextCursor: null };
  assert.equal(domainResult('receivables', valid, who, resolved).items.length, 3, 'the same page with its summary is accepted');
  assert.throws(() => domainResult('receivables', (({ summary, ...rest }) => rest)(valid), who, resolved), 'without summary the validator refuses it first');
});

test('R2c room filter: income_expenses rows filtered by room get the summary of the kept rows, byType.<type>.largest included', async () => {
  const rooms = [{ id: ROOM, name: 'P1', code: null, floor: 1, buildingId: A }];
  const rpc = async (name, accessToken, args) => name === 'hermes_building_directory_v1'
    ? { buildings: [{ id: A, name: 'Toà A', code: 'A' }, { id: B, name: 'Toà B', code: 'B' }].filter(row => args.p_building_ids.includes(row.id)) }
    : { rooms: rooms.filter(room => args.p_building_ids.includes(room.buildingId)) };
  const who = { row: { id: CONNECTION, organizationId: ORG, userId: USER }, contextVersion: 'c'.repeat(64),
    scopesByPermission: { 'income_expenses.view': { buildingIds: [A, B], cashbookIds: [] } } };
  const { input: resolved, plan } = await createReadNameResolver({ rpc }).resolve({ operation: 'income_expenses', input: domainInput('income_expenses', { limit: 5 }),
    names: { roomName: 'P1' }, lane: 'legacy', accessToken: 'bearer-fixture', identity: who, tokenDigest: 'd'.repeat(64), signal: new AbortController().signal });
  assert.deepEqual([resolved.limit, resolved.query], [50, ''], 'SQL does not match rooms in query for vouchers: the connector filters the page');
  // Page of the SQL (ids ascending): the 9 000 000 expense is in another room, so the kept rows' largest expense is 500 000.5.
  const other = { ...ROWS.income_expenses[3], id: id(15), code: 'PC9', roomId: id(99), roomName: 'P9', totalAmount: '9000000.00' };
  const pageRows = [ROWS.income_expenses[0], ROWS.income_expenses[3], other];
  const done = plan.merge([{ ...envelope('income_expenses', pageRows, summarizeRows('income_expenses', pageRows)), nextCursor: null }]);
  assert.deepEqual(done.items.map(row => row.id), [id(11), id(14)]);
  assert.deepEqual(done.summary, summarizeRows('income_expenses', [ROWS.income_expenses[0], ROWS.income_expenses[3]]));
  assert.deepEqual([done.summary.byType.EXPENSE.largest.id, done.summary.byType.INCOME.largest.id, done.summary.largest.id], [id(14), id(11), id(11)],
    'never the SQL figure of the unfiltered page (the other room\'s 9 000 000)');
});
