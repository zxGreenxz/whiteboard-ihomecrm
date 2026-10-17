import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedW2a, BUILDING, OTHER_BUILDING, USER, ORG, CUSTOMER_C, CONTRACT_A, INVOICE_A, INVOICE_B, ROOM2,
  INV_FOREIGN, INV_OVER, INV_OVER_CANCELLED, INV_OVER_DELETED, INV_OVER_B, INV_C_PAID, INV_C_REV, PAY_A,
  CONTRACT_FULL, CONTRACT_FI, CONTRACT_TERM, RV1, RV2, RV3, RV_EXCL, RV_SETTLED, S1, S2, S3, T1, T2, T3, CHANGE_BOOK, ROUND_BOOK, OTHER_BOOK,
  L1, L2, L4, L6, L7, V_DETAIL, V_DETAIL_UNAPPROVED, V_DETAIL_RESTRICTED, V_DETAIL_REVERSED } from './wave2-a-sql-fixture.mjs';
import { assertPackageParity } from './wave2-sql-fixture.mjs';
import { changedFunctions } from './full-read-sql-fixture.mjs';
import { W2A_REPORTS } from './wave2-a-contract.mjs';
import { W2 } from './wave2-registry.mjs';
import { domainInput, domainResult } from './domain-contract.mjs';

// Gói A đợt 2 — test RIÊNG của Gói A (chỉ Gói A sửa). MỘT PGlite cho cả file, mỗi ca BEGIN … ROLLBACK.
// Mô hình INVOKER + RLS (18/10): hàm đọc gói và hàm dùng chung chạy bằng vai authenticated của người hỏi, dưới RLS
// cổng tổng hợp của fixture (ý nghĩa policy sống). ctx như cổng dựng (toà A, customers.view ở A, hôm nay 16/10).
// Số liệu tính tay theo đúng bộ lọc web (vùng hermes-parity dẫn trong migration gói A); rào đầu ra broker
// (domainInput/domainResult của crm_read_report) nhận đúng khuôn SQL thật; đột biến SQL trên chính migration gói A.
// CHƯA kiểm qua cổng chung: cổng đợt 2 đang đổi sang INVOKER dispatcher (Gói 0) — ca đầu-cuối thêm sau khi rebase.
// Không chứng minh RLS thật/JWT thật/PostgREST: phần đó đo trên TEST.
const MIGRATION_PATH = 'supabase/migrations/20261018010000_hermes_w2a_receivables_read_v1.sql';
const migration = readFileSync(MIGRATION_PATH, 'utf8');
const KEYS = [...new Set(Object.values(W2A_REPORTS).map(spec => spec.permission))];
const REPORTS = Object.keys(W2A_REPORTS);
const FOREIGN_BUILDING = '0a0a0a0a-0000-4000-8000-000000000009';
let shared;
before(async () => { shared = await sharedW2a(); });
after(async () => { await shared?.close(); });
const inCase = work => shared.isolated(async env => { await env.grant(KEYS); return work(env); });
const code = expected => error => error.code === expected;
const params = (report, values = {}) => ({ ...Object.fromEntries(W2A_REPORTS[report].params.map(name => [name, null])), ...values });
const ids = (items, key) => items.map(row => row[key]);
const DEFAULTS = { invoice_detail: { invoiceId: INVOICE_A }, collection: { month: '2026-10' }, change_ledger: { cashbookId: CHANGE_BOOK } };
const CTX = { organizationId: ORG, userId: USER, report: null, permission: null, scope: 'rows', buildings: [BUILDING], requestedBuildingId: null,
  overlayOrg: false, orgWide: false, isSuperadmin: false, today: '2026-10-16', scopes: { 'customers.view': [BUILDING] } };
// Hàm đọc của gói, bằng vai authenticated (như cổng INVOKER sẽ gọi).
const direct = (env, report, values = {}, ctx = {}, options) => env.call('SELECT app_private.hermes_w2a_read_v1($1,$2::jsonb,$3::jsonb) result',
  [report, JSON.stringify(params(report, { ...DEFAULTS[report], ...values })), JSON.stringify({ ...CTX, report, ...ctx })], options);
// Như cổng: phân trang ảnh chụp ≤2000 hàng (offset/limit), unavailable đi nguyên.
async function run(env, report, values = {}, { limit = 50, offset = 0, ctx = {} } = {}) {
  const raw = await direct(env, report, values, ctx);
  const items = raw.rows.slice(offset, offset + limit);
  return { report, source: W2A_REPORTS[report].source, unavailable: raw.unavailable, summary: raw.summary, items, offset,
    nextOffset: offset + items.length < raw.rows.length ? offset + items.length : null, sourceCapped: raw.sourceCapped };
}
const sharedFn = (env, sql, args, options) => env.call(`SELECT COALESCE(jsonb_agg(t),'[]'::jsonb) result FROM ${sql} t`, args, options);
const identity = (read, buildings = [BUILDING]) => ({ row: { organizationId: ORG }, effective: { read, action: [] },
  scopesByPermission: Object.fromEntries(read.map(key => [key, { buildingIds: buildings, cashbookIds: [] }])) });

test('gói A: bảng báo cáo SQL (hermes_w2a_catalog_v1) khớp khai báo JS (W2A_REPORTS)', () => shared.isolated(env => assertPackageParity(env, 'a')));

test('khai báo: 9 báo cáo, đều riêng tư, tên khách qua customers.view; nguồn là hàm dùng chung/RPC web có thật; mục lục chủ đề thu_tien', () => inCase(async env => {
  assert.deepEqual([...REPORTS].sort(), ['change_ledger', 'collection', 'deposit_refunds', 'held_deposits', 'invoice_detail', 'overpayment', 'payment_schedule',
    'reservation_settlements', 'reservation_vouchers']);
  for (const [report, spec] of Object.entries(W2A_REPORTS)) {
    assert.equal(spec.private, true, report); assert.deepEqual(spec.scopeKeys, ['customers.view'], report); assert.equal(spec.scope, 'rows', report);
    const fn = spec.source.replace(/^crm\./, '');
    assert.equal((await env.db.query("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1", [fn])).rows[0].n, 1, fn);
  }
  assert.deepEqual(ids((await env.reportList('a')).items, 'report'), [...REPORTS].sort());
}));

test('cấu trúc: chỉ hàm gói A + 8 hàm dùng chung; INVOKER search_path rỗng, chỉ authenticated, tự từ chối vai khác; không copilot, không chép policy', () => inCase(async env => {
  const { db } = env;
  const stripped = migration.replace(/--[^\n]*/g, '');
  const created = [...stripped.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+\.[a-z0-9_]+)\(/g)].map(match => match[1]).sort();
  const SHARED = ['public.cashbook_change_ledger_v1', 'public.deposit_held_contracts_v1', 'public.deposit_refunds_forfeits_v1', 'public.deposit_reservation_vouchers_v1',
    'public.finance_overpayment_invoices_v1', 'public.finance_payment_schedule_v1', 'public.invoice_detail_v1', 'public.thu_tien_collection_v1'];
  assert.deepEqual(created, ['app_private.hermes_w2a_catalog_v1', 'app_private.hermes_w2a_read_v1', ...SHARED].sort());
  assert.doesNotMatch(stripped, /copilot|\bDROP\b|ALTER TABLE|UPDATE |INSERT |DELETE /i);
  assert.doesNotMatch(stripped, /current_visible_owner_ids|can_view_restricted_ie|has_restricted_item|ie_visible_cashbook_ids/, 'không chép policy RLS');
  const procs = (await db.query(`SELECT n.nspname||'.'||p.proname name,p.prosecdef definer,p.proconfig config,p.provolatile vol,
      has_function_privilege('authenticated',p.oid,'EXECUTE') auth,has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('service_role',p.oid,'EXECUTE') service FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname||'.'||p.proname=ANY($1)`, [created])).rows;
  assert.equal(procs.length, created.length);
  for (const proc of procs) {
    const catalog = proc.name === 'app_private.hermes_w2a_catalog_v1';
    assert.equal(proc.definer, catalog, `${proc.name}: ${catalog ? 'DEFINER (bảng hằng)' : 'INVOKER'}`);
    if (!catalog) assert.deepEqual(proc.config, ['search_path=""'], proc.name);
    assert.deepEqual([proc.auth, proc.anon, proc.service], [!catalog, false, false], proc.name);
    if (SHARED.includes(proc.name)) assert.equal(proc.vol, 's', `${proc.name}: STABLE`);
  }
  for (const fn of SHARED) {
    const call = { 'public.invoice_detail_v1': `SELECT public.invoice_detail_v1('${ORG}','${INVOICE_A}',NULL) result` }[fn]
      ?? `SELECT count(*) result FROM ${fn}(${{ 'public.finance_payment_schedule_v1': `'${ORG}','2027-10-16'`, 'public.thu_tien_collection_v1': `'${ORG}','2026-10',NULL,NULL,'2026-10-16'`,
        'public.deposit_held_contracts_v1': `'${ORG}',10000`, 'public.cashbook_change_ledger_v1': `'${ORG}','${CHANGE_BOOK}','2026-10-01','2026-10-31'` }[fn] ?? `'${ORG}'`})`;
    await assert.rejects(env.call(call, [], { role: 'postgres' }), code('42501'), `${fn}: vai postgres (DEFINER gọi) bị từ chối`);
    await env.call(call, []);
  }
  await assert.rejects(direct(env, 'overpayment', {}, {}, { role: 'postgres' }), code('42501'), 'hàm đọc gói: vai khác authenticated');
}));

test('payment_schedule: một dòng/phòng, đến ngày = hạn xa nhất ≤ hôm nay+365 (bỏ huỷ/xoá), khách của hoá đơn đầu, mới nhất trước; lọc ngày', () => inCase(async env => {
  let value = await run(env, 'payment_schedule');
  assert.deepEqual(value.items.map(row => [row.roomName, row.billedThrough, row.customerName]),
    [['P101', '2026-12-10', 'Nguyễn Văn An'], ['P102', '2026-10-10', null], ['P103', '2026-10-10', null], ['P104', '2026-10-10', null]],
    'P101: 10/12 (bỏ huỷ 10/01, xoá 10/02, quá hạn 10/12/2027); P102: khách của hoá đơn đầu (HĐ đủ cọc, đại diện bị RLS ẩn) ⇒ không tên');
  assert.deepEqual(value.summary, { rooms: 4 });
  assert.deepEqual([value.sourceCapped, value.unavailable], [false, null]);
  value = await run(env, 'payment_schedule', { fromDate: '2026-11-01', toDate: '2026-12-31' });
  assert.deepEqual(ids(value.items, 'roomName'), ['P101']);
  value = await run(env, 'payment_schedule', {}, { ctx: { buildings: [BUILDING, OTHER_BUILDING], scopes: { 'customers.view': [BUILDING, OTHER_BUILDING] } } });
  assert.equal(value.items.find(row => row.buildingId === OTHER_BUILDING).customerName, 'Phạm Toà Khác', 'toà B khi ctx có B');
}));

test('overpayment: đã thu > tổng (kể cả hoá đơn huỷ như web, bỏ đã xoá), tổng từ RPC get_overpayment_summary theo đúng toà', () => inCase(async env => {
  const value = await run(env, 'overpayment');
  assert.deepEqual(value.items.map(row => [row.invoiceId, row.overpaidAmount, row.customerName]),
    [[INV_OVER, '200000.00', null], [INV_OVER_CANCELLED, '100000.00', null]]);
  assert.deepEqual(value.summary, { total: '300000.00', count: 2 }, 'không cộng toà B (700k−500k) hay hoá đơn đã xoá');
  assert.ok(!ids(value.items, 'invoiceId').includes(INV_OVER_DELETED) && !ids(value.items, 'invoiceId').includes(INV_OVER_B));
}));

test('collection: cả kỳ / hôm nay / khoảng ngày như ThuTien.tsx; tab Đã thu/Chưa thu; người thu bỏ trùng, RLS ẩn phiếu hạn chế; khoản đã hoàn tác vẫn cộng như web', () => inCase(async env => {
  let value = await run(env, 'collection', { month: '2026-10' });
  assert.deepEqual(value.summary, { mode: 'all', invoiceCount: 4, collectedSum: '3000000.00', remainingSum: '4800000.00', paidRooms: 1, dueRooms: 3 });
  assert.deepEqual(value.items.map(row => [row.roomName, row.collectStatus, row.collectors]),
    [['P101', 'partial', 'Kế toán A'], ['P102', 'paid', 'Thu Ngân A'], ['P103', 'unpaid', null], ['P104', 'unpaid', null]]);
  assert.equal(value.items[0].customerName, 'Nguyễn Văn An');
  assert.deepEqual(ids((await run(env, 'collection', { month: '2026-10', status: 'paid' })).items, 'invoiceId'), [INV_C_PAID]);
  value = await run(env, 'collection', { month: '2026-10', fromDate: '2026-10-16', toDate: '2026-10-16' });
  assert.deepEqual(value.summary, { mode: 'today', invoiceCount: 4, collectedSum: '2800000', remainingSum: '4000000.00', paidRooms: 2, dueRooms: 2 },
    'hôm nay: thu 2tr + 800k (khoản đã hoàn tác: web vẫn cộng); còn nợ P101 + P103');
  assert.deepEqual(ids((await run(env, 'collection', { month: '2026-10', fromDate: '2026-10-16', toDate: '2026-10-16', status: 'paid' })).items, 'invoiceId'),
    [INV_C_PAID, INV_C_REV]);
  value = await run(env, 'collection', { month: '2026-10', fromDate: '2026-10-01', toDate: '2026-10-05' });
  assert.deepEqual(value.summary, { mode: 'date', invoiceCount: 4, collectedSum: '1000000', remainingSum: '4300000.00', paidRooms: 1, dueRooms: 3 },
    'tới 05/10: P102 chưa thu (2tr), P103 1,5tr, P104 800k');
  assert.deepEqual(value.items.map(row => [row.roomName, row.collectedInRange]), [['P101', '1000000'], ['P102', '0'], ['P103', '0'], ['P104', '0']]);
  assert.deepEqual(ids((await run(env, 'collection', { month: '2026-10', fromDate: '2026-10-01', toDate: '2026-10-05', status: 'unpaid' })).items, 'roomName'),
    ['P102', 'P103', 'P104']);
  assert.equal((await run(env, 'collection', { month: '2026-11' })).summary.invoiceCount, 0, 'kỳ khác: không hoá đơn nào');
  await env.db.exec(`INSERT INTO public.fixture_restricted_view VALUES('${USER}')`);
  assert.equal((await run(env, 'collection', { month: '2026-10' })).items[1].collectors, 'Thu Ngân A, Bí Mật', 'được xem phiếu hạn chế ⇒ thấy như web');
}));

test('invoice_detail: đầu hoá đơn + dòng HĐ + khoản thu + phiếu đã duyệt (bỏ chờ duyệt/hạn chế/của lần thu đã hoàn tác); không ảnh, không snapshot', () => inCase(async env => {
  let value = await run(env, 'invoice_detail', { invoiceId: INVOICE_A });
  assert.equal(value.summary.found, true);
  assert.deepEqual([value.summary.invoiceNumber, value.summary.totalAmount, value.summary.paidAmount, value.summary.remainingAmount, value.summary.customerName,
    value.summary.contractNumber, value.summary.adjustmentCount], ['INV-A', '3500000.00', '1000000.00', '2500000.00', 'Nguyễn Văn An', 'HD-A', 1]);
  assert.deepEqual(value.items.map(row => [row.kind, row.label ?? row.code, row.amount, row.status]), [['item', 'Tiền phòng', '3000000', null],
    ['item', 'Tiền điện T10', '350000', null], ['item', 'Tiền nước T10', '100000', null], ['item', 'Phí dịch vụ', '50000', null],
    ['payment', 'PT-A1', '1000000', 'ACTIVE'], ['payment', 'PT-A1R', '500000', 'REVERSED'], ['voucher', 'Thu có thối', '0', 'APPROVED'],
    ['voucher', 'Thu INV-A', '1000000', 'APPROVED']]);
  assert.deepEqual([value.summary.totalReceived, value.summary.totalRefunded], ['1000000', '0'], 'bỏ phiếu của lần thu đã hoàn tác');
  assert.equal(value.items.find(row => row.id === PAY_A).status, 'ACTIVE');
  assert.equal(value.items.find(row => row.id === V_DETAIL).person, 'Kế toán A');
  for (const hidden of [V_DETAIL_UNAPPROVED, V_DETAIL_RESTRICTED, V_DETAIL_REVERSED]) assert.ok(!ids(value.items, 'id').includes(hidden));
  assert.doesNotMatch(JSON.stringify(value), /receipt|snapshot|default_account|0901234567/i);
  value = await run(env, 'invoice_detail', { invoiceId: INVOICE_B });
  assert.deepEqual([value.summary.found, value.items.length], [false, 0], 'hoá đơn toà B ngoài ctx');
  assert.ok(Object.entries(value.summary).every(([key, item]) => key === 'found' || item === null));
}));

test('reservation_vouchers: phiếu cọc giữ chỗ (bỏ loại trừ, đã vào HĐ, không cọc, toà B), số cọc = Σ hạng mục cọc; tìm; tổng từ RPC', () => inCase(async env => {
  const value = await run(env, 'reservation_vouchers');
  assert.deepEqual(value.items.map(row => [row.voucherId, row.depositAmount, row.settled]),
    [[RV2, '500000', false], [RV1, '2000000', false], [RV_SETTLED, '700000', true], [RV3, '300000', false]]);
  assert.deepEqual([value.items[1].holdUntil, value.items[1].topupDueDate, value.items[1].depositTarget, value.items[1].payerName],
    ['2026-10-20', '2026-10-18', '2500000', 'Trần Cọc']);
  assert.deepEqual(value.summary, { holdingAmount: '2000000', approvedCount: 1, unapprovedCount: 1, cancelledCount: 1 }, 'RPC bỏ phiếu đã quyết toán');
  assert.deepEqual(ids((await run(env, 'reservation_vouchers', { status: 'APPROVED' })).items, 'voucherId'), [RV1, RV_SETTLED]);
  assert.deepEqual(ids((await run(env, 'reservation_vouchers', { query: 'p104' })).items, 'voucherId'), [RV3], 'tìm theo tên phòng');
  assert.deepEqual(ids((await run(env, 'reservation_vouchers', { query: 'TRẦN cọc' })).items, 'voucherId'), [RV1], 'tìm theo người nộp');
  assert.ok(!ids(value.items, 'voucherId').includes(RV_EXCL));
}));

test('reservation_settlements: gọi thẳng get_reservation_settlements_v1 (toà tường minh), trạng thái hoàn, tổng từ RPC; nhiều hơn một trang 200 vẫn đủ', () => inCase(async env => {
  let value = await run(env, 'reservation_settlements');
  assert.deepEqual(value.items.map(row => [row.settlementId, row.refundState, row.refundRemaining, row.payerName]),
    [[S2, 'PENDING', '300000', null], [S1, 'PAID', '0', 'Ngô Quyết']]);
  assert.ok(!ids(value.items, 'settlementId').includes(S3));
  assert.doesNotMatch(JSON.stringify(value), /riêng tư/, 'không trả lý do gõ tay');
  assert.deepEqual(value.summary, { retainedAmount: '200000', retainedCount: 1, refundPendingAmount: '300000', refundPendingCount: 1,
    refundPaidAmount: '600000', refundPaidCount: 2 });
  assert.deepEqual(ids((await run(env, 'reservation_settlements', { status: 'PAID' })).items, 'settlementId'), [S1]);
  await env.db.exec(`INSERT INTO public.reservation_deposit_settlements(id,organization_id,source_voucher_id,building_id,room_id,deposit_amount,retained_amount,
      refund_amount,settlement_date,reason_code,created_at)
    SELECT gen_random_uuid(),'${ORG}',gen_random_uuid(),'${BUILDING}','${ROOM2}',1,0,0,'2026-01-01','X','2026-01-01T00:00:00Z'::timestamptz+n*interval '1 minute'
    FROM generate_series(1,205) n`);
  value = await run(env, 'reservation_settlements', {}, { offset: 200 });
  assert.deepEqual([value.items.length, value.nextOffset, value.sourceCapped], [7, null, false], '207 hàng qua hai trang RPC');
}));

test('held_deposits: HĐ hiệu lực, FULL/SHORT/FIRST_INVOICE theo ngưỡng 10.000đ; tên khách đại diện, RLS ẩn thì khách đầu; KPI từ get_held_deposit_summary', () => inCase(async env => {
  const value = await run(env, 'held_deposits');
  assert.deepEqual(value.items.map(row => [row.contractId, row.state, row.depositRemaining, row.customerName]),
    [[CONTRACT_A, 'SHORT', '2000000', 'Nguyễn Văn An'], [CONTRACT_FULL, 'FULL', '5000', 'Khách Chưa Hợp Đồng'], [CONTRACT_FI, 'FIRST_INVOICE', '2000000', null]]);
  assert.deepEqual(value.summary, { contractCount: 3, expected: '11000000', held: '6995000', shortfall: '2000000', shortfallAll: '4005000',
    fullCount: 1, shortCount: 1, firstInvoiceCount: 1 });
  assert.deepEqual(ids((await run(env, 'held_deposits', { status: 'SHORT' })).items, 'contractId'), [CONTRACT_A]);
}));

test('deposit_refunds: "đã hoàn" chỉ phiếu APPROVED+POSTED+còn bút toán, gộp theo HĐ; bỏ cọc; KPI get_refund_forfeit_summary (kể cả phiếu không hồ sơ)', () => inCase(async env => {
  const value = await run(env, 'deposit_refunds');
  assert.deepEqual(value.items.map(row => [row.terminationId, row.kind, row.postedRefund, row.postedRefundCount, row.refundDrift, row.customerName]),
    [[T1, 'REFUND', '1500000.00', 1, '500000.00', 'Khách Chưa Hợp Đồng'], [T2, 'FORFEIT', '0', 0, '0', null]]);
  assert.ok(!ids(value.items, 'terminationId').includes(T3));
  assert.deepEqual(value.summary, { refundTotal: '1750000.00', refundCount: 2, refundLinkedTotal: '1500000.00', refundOrphanTotal: '250000.00',
    refundPendingTotal: '500000.00', forfeitTotal: '1000000', forfeitCount: 1, customerDebtTotal: '0' });
  assert.deepEqual(ids((await run(env, 'deposit_refunds', { kind: 'FORFEIT' })).items, 'terminationId'), [T2]);
}));

test('change_ledger: sổ tiền thối theo change_account_id, sổ "Làm tròn tiền thiếu" theo rounding; mặc định tháng này; sổ RLS không thấy ⇒ 42501', () => inCase(async env => {
  let value = await run(env, 'change_ledger', { cashbookId: CHANGE_BOOK });
  assert.deepEqual(value.items.map(row => [row.voucherId, row.amount, row.payerName]), [[L2, '3000', 'Khách Hai'], [L1, '5000', 'Khách Lẻ']]);
  assert.deepEqual(value.summary, { mode: 'refund', fromDate: '2026-10-01', toDate: '2026-10-31', total: '8000', count: 2 });
  assert.ok(!ids(value.items, 'voucherId').includes(L7), 'phiếu hạn chế của người khác (RLS)');
  value = await run(env, 'change_ledger', { cashbookId: ROUND_BOOK });
  assert.deepEqual([ids(value.items, 'voucherId'), value.summary.mode, value.summary.total], [[L6], 'rounding', '2000']);
  value = await run(env, 'change_ledger', { cashbookId: CHANGE_BOOK, fromDate: '2026-09-01', toDate: '2026-09-30' });
  assert.deepEqual(ids(value.items, 'voucherId'), [L4]);
  await assert.rejects(run(env, 'change_ledger', { cashbookId: OTHER_BOOK }), code('42501'), 'sổ của người khác');
}));

test('quyền như web: chỉ toà buildings.view (RLS các bảng) dù khoá trang rộng hơn ⇒ hết toà = no_building_scope; ctx người khác ⇒ 42501', () => inCase(async env => {
  await assert.rejects(direct(env, 'overpayment', {}, { userId: CUSTOMER_C }), code('42501'));
  await env.db.exec(`DELETE FROM public.fixture_building_access WHERE building_id='${BUILDING}'`);
  for (const report of REPORTS) assert.equal((await run(env, report, DEFAULTS[report])).unavailable, 'no_building_scope', report);
  await env.db.exec('INSERT INTO public.fixture_super_scope VALUES(true)');
  assert.equal((await run(env, 'overpayment')).items.length, 2, 'toàn quyền toà (super admin) không thu hẹp');
}));

test('riêng tư: không customers.view ở toà (ctx) hoặc RLS customers ẩn ⇒ mọi tên khách/người nộp/ghi chú null, tìm người nộp không lọt', () => inCase(async env => {
  const names = async ctx => {
    const out = [];
    for (const report of REPORTS) {
      const value = await run(env, report, DEFAULTS[report], { ctx });
      for (const row of [...value.items, value.summary ?? {}]) for (const key of ['customerName', 'payerName', 'notes']) if (Object.hasOwn(row, key) && row[key] !== null) out.push(`${report}.${key}`);
    }
    return out;
  };
  assert.ok((await names({})).length > 0, 'có tên khi đủ quyền');
  assert.deepEqual(await names({ scopes: { 'customers.view': [OTHER_BUILDING] } }), [], 'customers.view chỉ ở toà B');
  assert.deepEqual(await names({ scopes: {} }), [], 'kết nối không giữ customers.view');
  assert.deepEqual((await run(env, 'reservation_vouchers', { query: 'Trần Cọc' }, { ctx: { scopes: {} } })).items, [], 'không dò được người nộp');
  await env.db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='customers.view'");
  for (const report of ['payment_schedule', 'held_deposits', 'deposit_refunds', 'invoice_detail'])
    assert.ok((await run(env, report, DEFAULTS[report])).items.concat([(await run(env, report, DEFAULTS[report])).summary])
      .every(row => !row || row.customerName === undefined || row.customerName === null), `${report}: RLS customers ẩn`);
}));

test('rào broker: kết quả SQL thật của cả 9 báo cáo qua domainInput/domainResult của crm_read_report; hàng toà ngoài phạm vi bị chặn', () => inCase(async env => {
  for (const report of REPORTS) {
    const input = domainInput('report', { report, params: DEFAULTS[report] ?? {}, limit: 50 });
    const value = { organizationId: ORG, domain: 'report', fetchedAt: '2026-10-18T00:00:00.000Z',
      ...await run(env, report, input.params, { limit: input.limit, offset: input.offset }) };
    const projected = domainResult('report', value, identity(KEYS), input);
    assert.deepEqual(projected.items, value.items, report);
    assert.deepEqual(projected.summary, value.summary, report);
    const row = value.items.find(item => Object.hasOwn(item, 'buildingId'));
    if (row) assert.throws(() => domainResult('report', { ...value, items: [{ ...row, buildingId: OTHER_BUILDING }] }, identity(KEYS), input), report);
  }
  assert.throws(() => domainInput('report', { report: 'collection', params: {} }), 'month bắt buộc ở broker');
  assert.throws(() => domainInput('report', { report: 'held_deposits', params: { status: 'short' } }), 'status ngoài danh sách');
  assert.equal(W2.reports.payment_schedule.package, 'a');
}));

test('trần nguồn: hơn 2000 phòng ⇒ 2000 hàng đầu đã sắp + sourceCapped, summary.rooms vẫn là tổng thật', () => inCase(async env => {
  await env.db.exec(`INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount)
    SELECT gen_random_uuid(),'${ORG}','X'||n,'APPROVED','${BUILDING}',null,'2026-05','2026-05-01'::date+(n%60),1,0 FROM generate_series(1,2001) n`);
  const raw = await direct(env, 'payment_schedule');
  assert.deepEqual([raw.sourceCapped, raw.summary.rooms, raw.rows.length, raw.rows[0].roomName], [true, 2005, 2000, 'P101']);
}));

// Đột biến: mỗi bản bỏ MỘT hàng rào/công thức của migration gói A; cùng phép thử mà bản sống từ chối thì bản đột biến phải lọt.
const replaceExactly = (from, to) => { assert.equal(migration.split(from).length, 2, `anchor: ${from}`); return migration.replace(from, () => to); };
const rowsOf = async (env, report, values, ctx) => (await direct(env, report, values, ctx)).rows;
const probes = [
  { name: 'payment_schedule: bỏ hoá đơn huỷ', sql: replaceExactly(`i.status::text<>'CANCELLED'
      AND i.due_date<=p_due_until`, `true
      AND i.due_date<=p_due_until`),
    run: async env => (await rowsOf(env, 'payment_schedule'))[0].billedThrough === '2027-01-10' },
  { name: 'payment_schedule: trần hôm nay+365', sql: replaceExactly(`AND i.due_date<=p_due_until AND`, `AND`),
    run: async env => (await rowsOf(env, 'payment_schedule'))[0].billedThrough === '2027-12-10' },
  { name: 'hàm dùng chung: thu hẹp về đúng công ty (RLS trải mọi công ty của người dùng)', sql: replaceExactly(`    WHERE i.organization_id=p_organization_id AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED'
      AND i.due_date`, `    WHERE i.deleted_at IS NULL AND i.status::text<>'CANCELLED'
      AND i.due_date`),
    run: async env => { await env.db.exec(`INSERT INTO public.fixture_building_access VALUES('${FOREIGN_BUILDING}')`);
      return (await sharedFn(env, 'public.finance_payment_schedule_v1($1,$2,NULL)', [ORG, '2027-10-16'])).some(row => row.invoice_id === INV_FOREIGN); } },
  { name: 'hàm dùng chung: từ chối vai không phải authenticated', sql: replaceExactly(`  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  RETURN QUERY
  SELECT i.id,i.invoice_number,i.building_id`, `  RETURN QUERY
  SELECT i.id,i.invoice_number,i.building_id`),
    run: async env => (await sharedFn(env, 'public.finance_overpayment_invoices_v1($1,NULL)', [ORG], { role: 'postgres' })).length > 0 },
  { name: 'payment_schedule: tên khách theo customers.view của toà', sql: replaceExactly(`'customerName',CASE WHEN s.building_id=ANY(v_cust) THEN app_private.hermes_full_text_v1(s.customer_name,200) END,
          'billedThrough'`, `'customerName',app_private.hermes_full_text_v1(s.customer_name,200),
          'billedThrough'`),
    run: async env => (await rowsOf(env, 'payment_schedule', {}, { scopes: {} }))[0].customerName !== null },
  { name: 'overpayment: bỏ hoá đơn đã xoá', sql: replaceExactly(`i.deleted_at IS NULL AND i.paid_amount>0`, `i.paid_amount>0`),
    run: async env => ids(await rowsOf(env, 'overpayment'), 'invoiceId').includes(INV_OVER_DELETED) },
  { name: 'overpayment: tổng theo toà đã giao', sql: replaceExactly(`v_raw:=public.get_overpayment_summary(v_b);`, `v_raw:=public.get_overpayment_summary(NULL);`),
    run: async env => (await direct(env, 'overpayment')).summary.total !== '300000.00' },
  { name: 'collection: phòng thu trong ngày vẫn thuộc danh sách ngày', sql: replaceExactly(`s.mode='all' OR s.has_range OR s.owes,`, `s.mode='all' OR s.owes,`),
    run: async env => !ids(await rowsOf(env, 'collection', { fromDate: '2026-10-16', toDate: '2026-10-16' }), 'invoiceId').includes(INV_C_PAID) },
  { name: 'collection: còn nợ tới ngày cuối theo paidAsOf', sql: replaceExactly(`      WHEN s.paid_as_of THEN 0 ELSE GREATEST(0,s.total-s.paid_upto) END,`,
    `      ELSE GREATEST(0,s.rem) END,`),
    run: async env => (await direct(env, 'collection', { fromDate: '2026-10-01', toDate: '2026-10-05' })).summary.remainingSum !== '4300000.00' },
  { name: 'invoice_detail: chỉ phiếu đã duyệt', sql: replaceExactly(`v.organization_id=p_organization_id AND v.approval_status='APPROVED' AND v.deleted_at IS NULL`,
    `v.organization_id=p_organization_id AND v.deleted_at IS NULL`),
    run: async env => ids(await rowsOf(env, 'invoice_detail'), 'id').includes(V_DETAIL_UNAPPROVED) },
  { name: 'invoice_detail: bỏ phiếu của lần thu đã hoàn tác', sql: replaceExactly(`
      AND NOT EXISTS(SELECT 1 FROM public.payments rp WHERE rp.id=v.payment_id AND rp.invoice_id=inv.id AND rp.reversed_at IS NOT NULL))`, `)`),
    run: async env => (await direct(env, 'invoice_detail')).summary.totalReceived !== '1000000' },
  { name: 'reservation_vouchers: loại trừ quản lý', sql: replaceExactly(`    AND NOT EXISTS(SELECT 1 FROM public.deposit_management_exclusions ex WHERE ex.voucher_id=ie.id AND ex.organization_id=ie.organization_id)
`, ''),
    run: async env => ids(await rowsOf(env, 'reservation_vouchers'), 'voucherId').includes(RV_EXCL) },
  { name: 'reservation_vouchers: tìm người nộp cần quyền xem tên khách', sql: replaceExactly(`OR v.building_id=ANY(v_cust) AND position(v_query`, `OR position(v_query`),
    run: async env => (await rowsOf(env, 'reservation_vouchers', { query: 'trần cọc' }, { scopes: {} })).length > 0 },
  { name: 'reservation_settlements: truyền trạng thái hoàn', sql: replaceExactly(`get_reservation_settlements_v1(v_b,v_status,v_cursor,200,NULL)`,
    `get_reservation_settlements_v1(v_b,NULL,v_cursor,200,NULL)`),
    run: async env => ids(await rowsOf(env, 'reservation_settlements', { status: 'PENDING' }), 'settlementId').includes(S1) },
  { name: 'held_deposits: chỉ HĐ hiệu lực', sql: replaceExactly(`c.status::text='ACTIVE' AND c.deleted_at IS NULL`, `c.deleted_at IS NULL`),
    run: async env => ids(await rowsOf(env, 'held_deposits'), 'contractId').includes(CONTRACT_TERM) },
  { name: 'deposit_refunds: chỉ phiếu đã vào sổ', sql: replaceExactly(`AND ie.approval_status='APPROVED' AND ie.posting_status='POSTED' AND`, `AND ie.approval_status='APPROVED' AND`),
    run: async env => (await rowsOf(env, 'deposit_refunds')).find(row => row.terminationId === T1).postedRefund !== '1500000.00' },
  { name: 'deposit_refunds: toà trong hàm dùng chung', sql: replaceExactly(`WHERE t.organization_id=p_organization_id AND (p_building_ids IS NULL OR r.building_id=ANY(p_building_ids))`,
    `WHERE t.organization_id=p_organization_id`),
    run: async env => (await sharedFn(env, 'public.deposit_refunds_forfeits_v1($1,$2)', [ORG, [BUILDING]])).some(row => row.termination_id === T3) },
  { name: 'change_ledger: sổ phải nhìn thấy như web', sql: replaceExactly(`    IF NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=v_target AND a.organization_id=v_org AND a.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501';
    END IF;
`, ''),
    run: async env => Array.isArray((await direct(env, 'change_ledger', { cashbookId: OTHER_BOOK })).rows) },
  { name: 'read: giao thêm buildings.view như RLS web', sql: replaceExactly(`jsonb_array_elements_text(p_ctx->'buildings') x
    WHERE public.has_full_building_scope() OR x::uuid IN (SELECT public.accessible_building_ids());`, `jsonb_array_elements_text(p_ctx->'buildings') x;`),
    run: async env => { await env.db.exec(`DELETE FROM public.fixture_building_access WHERE building_id='${BUILDING}'`);
      return (await direct(env, 'overpayment')).unavailable === null; } },
  { name: 'read: chỉ đúng người hỏi', sql: replaceExactly(`  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  v_org:=`, `  v_org:=`),
    run: async env => Array.isArray((await direct(env, 'overpayment', {}, { userId: CUSTOMER_C })).rows) },
];
for (const probe of probes) {
  const changed = changedFunctions(migration, probe.sql);
  test(`mutation is caught: ${probe.name}`, { timeout: 120000 }, async () => {
    await inCase(async env => assert.equal(await probe.run(env).catch(() => false), false, 'bản sống từ chối'));
    await inCase(async env => {
      for (const sql of changed) await env.db.exec(sql);
      assert.equal(await probe.run(env), true, 'bản đột biến lọt');
    });
  });
}
