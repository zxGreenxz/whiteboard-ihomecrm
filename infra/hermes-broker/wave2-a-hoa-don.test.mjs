import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedW2a, BUILDING, ORG, FOREIGN, USER, ROOM, ROOM2, ROOM3, ROOM4, INVOICE_A, INV_A3, INV_A_FAR, INV_ROOM2, INV_OVER, INV_C_PAID,
  INV_C_UNPAID, INV_C_REV, CONTRACT_A, CONTRACT_FULL, CONTRACT_FI, ADJ_PENDING, ADJ_OLD } from './wave2-a-sql-fixture.mjs';
import { changedFunctions } from './full-read-sql-fixture.mjs';
import { W2A_REPORTS } from './wave2-a-contract.mjs';
import { REMINDER_LINK_SENTENCE } from './public-link.mjs';
import { finishDomainResult } from './domain-mount.mjs';

// Đợt 3 trang Hoá đơn — đọc bù (a)–(f) + soạn tin nhắc nợ (docs/plans/hermes-crm/HOA-DON-THAO-TAC-GHI.md mục 7). MỘT PGlite gói A cho
// cả file (sharedW2a: dải a + z, gồm hai migration 20261022051118 / 20261022051620), mỗi ca BEGIN … ROLLBACK. Số liệu tính tay từ fixture
// (hôm nay 16/10/2026, toà A): không học kỳ vọng từ chính kết quả. Không chứng minh RLS/JWT/PostgREST thật — phần đó đo trên TEST (tầng 2).
const SHARED_PATH = 'supabase/migrations/20261022051118_hermes_w2a_invoice_shared_v1.sql';
const READS_PATH = 'supabase/migrations/20261022051620_hermes_w2a_invoice_reads_v1.sql';
const shared = readFileSync(SHARED_PATH, 'utf8'), reads = readFileSync(READS_PATH, 'utf8');
const REPORTS = ['invoice_room_detail', 'invoice_lateness', 'collection_by_method', 'invoice_adjustments', 'invoice_missing', 'invoice_room_debts',
  'invoice_reminders'];
const SHARED = ['public.invoice_adjustments_list_v1', 'public.invoice_collection_by_method_v1', 'public.invoice_lateness_v1', 'public.invoice_missing_v1',
  'public.invoice_open_debts_v1', 'public.invoice_room_invoices_v1'];
const KEYS = [...new Set(Object.values(W2A_REPORTS).map(spec => spec.permission))];
const CTX = { organizationId: ORG, userId: USER, report: null, permission: null, scope: 'rows', buildings: [BUILDING], requestedBuildingId: null,
  overlayOrg: false, orgWide: false, isSuperadmin: false, today: '2026-10-16', scopes: { 'customers.view': [BUILDING] } };
let fixture;
before(async () => { fixture = await sharedW2a(); });
after(async () => { await fixture?.close(); });
const inCase = work => fixture.isolated(async env => { await env.grant(KEYS); return work(env); });
const code = expected => error => error.code === expected;
const params = (report, values = {}) => ({ ...Object.fromEntries(W2A_REPORTS[report].params.map(name => [name, null])), ...values });
const direct = (env, report, values = {}, ctx = {}, options) => env.call('SELECT public.fixture_w2a_read($1,$2::jsonb,$3::jsonb) result',
  [report, JSON.stringify(params(report, values)), JSON.stringify({ ...CTX, report, ...ctx })], options);
const sharedFn = (env, sql, args, options) => env.call(`SELECT COALESCE(jsonb_agg(t),'[]'::jsonb) result FROM ${sql} t`, args, options);
const pick = (rows, keys) => rows.map(row => keys.map(key => row[key]));
// Nợ kéo (TC-I02 / #267): hoá đơn tháng 11 của P104 gánh 800.000đ nợ của INV-C3 (tháng 10) — còn lại 1.800.000đ gồm cả phần kéo.
const CARRIER = '0a0a0a0a-0000-4000-8000-000000000142';
const carry = env => env.db.exec(`INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,
    paid_amount,previous_debt_sources,created_at) VALUES('${CARRIER}','${ORG}','INV-C3N','APPROVED','${BUILDING}','${ROOM4}','2026-11','2026-11-10',1800000,0,
    '[{"type":"invoice","id":"${INV_C_REV}","amount":800000}]','2099-01-01T00:00:00Z')`);

test('cấu trúc: 6 hàm dùng chung INVOKER, STABLE, search_path rỗng, chỉ authenticated, tự từ chối vai khác; file không chứa hàm trợ lý; 7 báo cáo đúng khoá', () => inCase(async env => {
  const stripped = shared.replace(/--[^\n]*/g, '');
  assert.deepEqual([...stripped.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+\.[a-z0-9_]+)\(/g)].map(match => match[1]).sort(), SHARED);
  assert.doesNotMatch(shared, /hermes_/, 'file hàm dùng chung không nhắc hàm của trợ lý (như gói D)');
  assert.doesNotMatch(stripped, /copilot|\bDROP\b|ALTER TABLE|UPDATE |INSERT |DELETE |app_private\./i, 'không ghi, không gọi app_private');
  assert.deepEqual([...reads.replace(/--[^\n]*/g, '').matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+\.[a-z0-9_]+)\(/g)].map(match => match[1]),
    ['app_private.hermes_w2a_catalog_v1', 'app_private.hermes_w2a_read_v1']);
  assert.doesNotMatch(reads.replace(/--[^\n]*/g, ''), /\bGRANT\b|\bREVOKE\b|\bDROP\b|INSERT |UPDATE |DELETE /i, 'không đổi ACL, không ghi');
  const procs = (await env.db.query(`SELECT n.nspname||'.'||p.proname name,p.prosecdef definer,p.proconfig config,p.provolatile vol,
      has_function_privilege('authenticated',p.oid,'EXECUTE') auth,has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('service_role',p.oid,'EXECUTE') service FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname||'.'||p.proname=ANY($1) ORDER BY 1`, [SHARED])).rows;
  assert.deepEqual(procs.map(proc => [proc.name, proc.definer, proc.config, proc.vol, proc.auth, proc.anon, proc.service]),
    SHARED.map(name => [name, false, ['search_path=""'], 's', true, false, false]));
  for (const call of [`public.invoice_room_invoices_v1('${ORG}','${ROOM}')`, `public.invoice_lateness_v1('${ORG}')`, `public.invoice_collection_by_method_v1('${ORG}')`,
    `public.invoice_adjustments_list_v1('${ORG}')`, `public.invoice_missing_v1('${ORG}','2026-11')`, `public.invoice_open_debts_v1('${ORG}')`]) {
    await assert.rejects(sharedFn(env, call, [], { role: 'postgres' }), code('42501'), `${call}: vai postgres (DEFINER gọi) bị từ chối`);
    assert.ok((await sharedFn(env, call, [])).length > 0, `${call}: có hàng`);
  }
  await assert.rejects(sharedFn(env, `public.invoice_missing_v1('${ORG}','2026-13')`, []), code('22023'), 'kỳ sai dạng');
  for (const report of REPORTS) {
    const spec = W2A_REPORTS[report];
    assert.deepEqual([spec.permission, spec.scope, spec.private, spec.scopeKeys], [report === 'collection_by_method' ? 'thu_tien.view' : 'invoices.view', 'rows', true,
      ['customers.view']], report);
  }
}));

test('hàm dùng chung tự kiểm khoá của trang theo toà; p_building_ids chỉ thu hẹp ({} = rỗng); khác công ty không lọt', () => inCase(async env => {
  const calls = [['invoices.view', `public.invoice_open_debts_v1($1,$2)`], ['invoices.view', `public.invoice_missing_v1($1,'2026-11',$2)`],
    ['invoices.view', `public.invoice_lateness_v1($1,$2)`], ['invoices.view', `public.invoice_adjustments_list_v1($1,$2)`],
    ['invoices.view', `public.invoice_room_invoices_v1($1,'${ROOM}',NULL,$2)`], ['thu_tien.view', `public.invoice_collection_by_method_v1($1,$2)`]];
  for (const [key, fn] of calls) {
    assert.ok((await sharedFn(env, fn, [ORG, null])).length > 0, `${fn}: NULL = toàn phạm vi RLS`);
    assert.equal((await sharedFn(env, fn, [ORG, []])).length, 0, `${fn}: {} = rỗng`);
    assert.equal((await sharedFn(env, fn, [FOREIGN, null])).length, 0, `${fn}: công ty khác`);
    await env.db.query('UPDATE public.fixture_acl SET allowed=false WHERE permission=$1', [key]);
    assert.equal((await sharedFn(env, fn, [ORG, null])).length, 0, `${fn}: thiếu ${key} ⇒ không hàng nào`);
    await env.db.query('UPDATE public.fixture_acl SET allowed=true WHERE permission=$1', [key]);
  }
}));

test('invoice_room_detail (a)(b): hoá đơn MỘT phòng theo kỳ — khoản (điện có số tiêu thụ), lần thu (TM, đã hoàn tác), hạn, quá hạn 6 ngày, nợ thực', () => inCase(async env => {
  const value = await direct(env, 'invoice_room_detail', { roomId: ROOM });
  assert.deepEqual([value.summary.found, value.summary.invoiceId, value.summary.billingMonth, value.summary.dueDate, value.summary.isOverdue,
    value.summary.overdueDays, value.summary.totalAmount, value.summary.paidAmount, value.summary.effectiveOutstanding, value.summary.customerName,
    value.summary.otherInvoices], [true, INVOICE_A, '2026-10', '2026-10-10', true, 6, '3500000.00', '1000000.00', '2500000.00', 'Nguyễn Văn An', 0],
    'mặc định tháng của hôm nay (10/2026); hạn 10/10 < 16/10, còn nợ ⇒ quá hạn 6 ngày');
  assert.deepEqual(pick(value.rows, ['kind', 'label', 'amount', 'consumption', 'category', 'status']), [
    ['item', 'Tiền phòng', '3000000', null, 'RENT', null], ['item', 'Tiền điện T10', '350000', '100', 'SERVICE', null],
    ['item', 'Tiền nước T10', '100000', null, 'SERVICE', null], ['item', 'Phí dịch vụ', '50000', null, 'SERVICE', null],
    ['payment', null, '1000000', null, 'TM', 'ACTIVE'], ['payment', null, '500000', null, 'TM', 'REVERSED']]);
  const december = await direct(env, 'invoice_room_detail', { roomId: ROOM, month: '2026-12' });
  assert.deepEqual([december.summary.invoiceId, december.summary.isOverdue, december.summary.overdueDays, december.rows], [INV_A3, false, null, []], 'kỳ chưa tới hạn');
  const none = await direct(env, 'invoice_room_detail', { roomId: ROOM, month: '2026-05' });
  assert.deepEqual([none.summary.found, none.summary.billingMonth, none.rows], [false, '2026-05', []]);
  assert.equal((await direct(env, 'invoice_room_detail', { roomId: ROOM }, { scopes: {} })).summary.customerName, null, 'không customers.view ở toà');
}));

test('invoice_lateness (b): hạn trong 90 ngày qua; ngày trả đủ = lần thu đạt tổng; còn nợ = trễ tới hôm nay; gộp sẵn theo phòng', () => inCase(async env => {
  const value = await direct(env, 'invoice_lateness');
  assert.deepEqual(value.rows.map(row => row.invoiceId).sort(), [INVOICE_A, INV_ROOM2, INV_OVER, INV_C_PAID, INV_C_UNPAID, INV_C_REV].sort());
  const byId = Object.fromEntries(value.rows.map(row => [row.invoiceId, [row.daysLate, row.open, row.late, row.settledDate]]));
  assert.deepEqual([byId[INV_ROOM2], byId[INV_C_PAID], byId[INVOICE_A], byId[INV_OVER]],
    [[45, true, true, null], [6, false, true, '2026-10-16'], [6, true, true, null], [0, false, false, null]],
    'P102 nợ từ 01/09 ⇒ trễ 45; INV-C1 trả đủ 16/10 (hạn 10/10) ⇒ 6; INV-O1 PAID không ngày thu ⇒ không tính trễ');
  assert.equal(value.rows[0].invoiceId, INV_ROOM2, 'trễ nhất trước');
  assert.deepEqual(value.summary, { fromDate: '2026-07-18', toDate: '2026-10-16', invoiceCount: 6, lateCount: 1, openLateCount: 4, avgDaysLate: '13.8',
    rooms: 4, lateRooms: 4, topLateRooms: 'P102 toà Toà A: 2 lần trễ, trung bình 26 ngày; P101 toà Toà A: 1 lần trễ, trung bình 6 ngày; ' +
      'P103 toà Toà A: 1 lần trễ, trung bình 6 ngày; P104 toà Toà A: 1 lần trễ, trung bình 6 ngày' });
  assert.deepEqual((await direct(env, 'invoice_lateness', { roomId: ROOM3 })).rows.map(row => row.invoiceId), [INV_C_UNPAID]);
}));

test('collection_by_method (c): đã thu theo NGÀY THU tách TM/TK như trang Thu tiền (bỏ khoản đã hoàn tác); month = cả tháng', () => inCase(async env => {
  const value = await direct(env, 'collection_by_method');
  assert.deepEqual(pick(value.rows, ['method', 'label', 'paymentCount', 'amount']), [['TK', 'Chuyển khoản', 1, '2000000'], ['TM', 'Tiền mặt', 1, '1000000']]);
  assert.deepEqual(value.summary, { fromDate: '2026-10-01', toDate: '2026-10-31', total: '3000000', tm: '1000000', tk: '2000000', tt: '0', ct: '0', paymentCount: 2 });
  assert.deepEqual((await direct(env, 'collection_by_method', { month: '2026-09' })).rows, [], 'tháng 9 không có lần thu');
  assert.deepEqual((await direct(env, 'collection_by_method', { fromDate: '2026-10-16', toDate: '2026-10-16' })).summary.total, '2000000', 'hôm nay');
}));

test('invoice_adjustments (d): chờ kiểm = phiên bản hiện hành PENDING; bản cũ bị thay không kiểm được; lý do theo hồ sơ khách nhìn thấy', () => inCase(async env => {
  const value = await direct(env, 'invoice_adjustments');
  assert.deepEqual(pick(value.rows, ['adjustmentId', 'reviewStatus', 'current', 'delta', 'adjustedBy', 'adjustedDate']), [
    [ADJ_PENDING, 'PENDING', true, '-50000', 'Quản lý B', '2026-10-14'], [ADJ_OLD, 'PENDING', false, '-50000', 'Quản lý B', '2026-10-13'],
    [value.rows[2].adjustmentId, 'CHECKED', true, '-100000', 'Kế toán A', '2026-10-12']]);
  assert.deepEqual([value.rows[2].reason, value.rows[2].adjustedTime, value.rows[2].checkedBy, value.rows[0].reason], ['Giảm 100k mất nước 2 ngày', '15:20', 'Kế toán A', null],
    'HĐ A: mọi khách nhìn thấy ⇒ có lý do (15:20 giờ VN); HĐ không khách nối được ⇒ lý do null');
  assert.deepEqual(value.summary, { fromDate: '2025-10-15', toDate: '2026-10-16', count: 3, pendingCount: 1, checkedCount: 1,
    oldestPendingDate: '2026-10-14', oldestPendingDays: 2 }, 'mặc định 366 ngày tới hôm nay');
  assert.deepEqual((await direct(env, 'invoice_adjustments', { status: 'CHECKED' })).rows.length, 1);
  assert.equal((await direct(env, 'invoice_adjustments', {}, { scopes: {} })).rows[2].reason, null, 'không customers.view ⇒ không lý do');
}));

test('invoice_missing (e): HĐ hiệu lực chưa có hoá đơn tháng kỳ M (hoá đơn huỷ không tính); summary theo toà', () => inCase(async env => {
  const value = await direct(env, 'invoice_missing', { month: '2026-11' });
  assert.deepEqual(pick(value.rows, ['contractId', 'roomName', 'customerName']), [[CONTRACT_A, 'P101', 'Nguyễn Văn An'],
    [CONTRACT_FULL, 'P102', 'Khách Chưa Hợp Đồng'], [CONTRACT_FI, 'P103', null]], 'đại diện bị RLS ẩn ⇒ khách đầu (như invoice_detail)');
  assert.deepEqual(value.summary, { month: '2026-11', rooms: 3, byBuilding: 'Toà A: 3 phòng' });
  assert.deepEqual((await direct(env, 'invoice_missing', { month: '2026-10' })).rows, [], 'mọi HĐ đã có hoá đơn tháng 10');
  await env.db.exec(`UPDATE public.invoices SET status='CANCELLED' WHERE id='${INV_C_UNPAID}'`);
  assert.deepEqual((await direct(env, 'invoice_missing', { month: '2026-10' })).rows.map(row => row.contractId), [CONTRACT_FI], 'hoá đơn đã huỷ ⇒ thiếu');
}));

test('invoice_room_debts (f): công nợ gộp theo PHÒNG (số phòng phân biệt), quá hạn theo hạn; days=31 ⇒ "quá hạn hơn 1 tháng"', () => inCase(async env => {
  const value = await direct(env, 'invoice_room_debts');
  assert.deepEqual(pick(value.rows, ['roomName', 'invoiceCount', 'debtTotal', 'overdueInvoiceCount', 'overdueTotal', 'maxOverdueDays', 'months', 'customerName']), [
    ['P101', 3, '9500000.00', 1, '2500000.00', 6, '10/2026, 12/2026, 12/2027', 'Nguyễn Văn An'], ['P103', 1, '1500000.00', 1, '1500000.00', 6, '10/2026', null],
    ['P104', 1, '800000.00', 1, '800000.00', 6, '10/2026', null], ['P102', 1, '100000.00', 1, '100000.00', 45, '09/2026', null]]);
  assert.deepEqual(value.summary, { rooms: 4, invoices: 6, debtTotal: '11900000.00', overdueRooms: 4, overdueInvoices: 4, overdueTotal: '4900000.00', minOverdueDays: null });
  const month = await direct(env, 'invoice_room_debts', { days: 31 });
  assert.deepEqual([month.rows.map(row => row.roomName), month.summary.rooms, month.summary.debtTotal], [['P102'], 1, '100000.00']);
  assert.equal((await direct(env, 'invoice_room_debts', {}, { scopes: {} })).rows[0].customerName, null, 'không customers.view');
}));

test('nợ kéo (#267): hoá đơn tháng 11 gánh nợ tháng 10 ⇒ phòng P104 nợ 1.800.000đ (không 2.600.000đ); quá hạn tính theo kỳ phát sinh gốc', () => inCase(async env => {
  await carry(env);
  const p104 = (await direct(env, 'invoice_room_debts', { roomId: ROOM4 })).rows;
  assert.deepEqual(pick(p104, ['invoiceCount', 'debtTotal', 'overdueTotal', 'months']), [[2, '1800000.00', '800000.00', '10/2026, 11/2026']]);
  const remind = (await direct(env, 'invoice_reminders', { roomId: ROOM4 })).rows[0];
  assert.match(remind.messageText, /còn 1\.800\.000đ chưa thanh toán: tháng 10\/2026: 800\.000đ \(hạn 10\/10\/2026, đã quá 6 ngày\); tháng 11\/2026: 1\.000\.000đ \(hạn 10\/11\/2026\)/);
  const room = await direct(env, 'invoice_room_detail', { roomId: ROOM4, month: '2026-11' });
  assert.deepEqual([room.summary.invoiceId, room.summary.remainingAmount, room.summary.effectiveOutstanding], [CARRIER, '1800000.00', '1800000.00'],
    'một kỳ: tập chỉ có hoá đơn gánh ⇒ không có nguồn trong tập để trừ');
  const all = await direct(env, 'invoice_room_detail', { roomId: ROOM4, month: '2026-10' });
  assert.deepEqual([all.summary.invoiceId, all.summary.carriedOutAmount], [INV_C_REV, '0'], 'cạnh chỉ đếm khi hoá đơn gánh nằm trong tập');
}));

test('invoice_reminders (Q18): tin soạn sẵn theo phòng, tổng nợ thực gộp sẵn, publicPath của HĐ hiệu lực, không tên khách trong tin', () => inCase(async env => {
  const value = await direct(env, 'invoice_reminders');
  const p101 = value.rows.find(row => row.roomName === 'P101');
  assert.deepEqual([p101.debtTotal, p101.publicPath, p101.invoiceCount], ['9500000.00', '/c/PUBLIC-CODE-A', 3]);
  assert.equal(p101.messageText, 'Chào anh/chị, phòng P101 toà Toà A hiện còn 9.500.000đ chưa thanh toán: tháng 10/2026: 2.500.000đ (hạn 10/10/2026, đã quá 6 ngày); ' +
    'tháng 12/2026: 3.500.000đ (hạn 10/12/2026); tháng 12/2027: 3.500.000đ (hạn 10/12/2027). Chi tiết hoá đơn xem ở link kèm theo. ' +
    'Anh/chị vui lòng thanh toán giúp. Cảm ơn anh/chị!');
  assert.doesNotMatch(p101.messageText, /Nguyễn/, 'tin không nêu tên khách');
  const p102 = value.rows.find(row => row.roomName === 'P102');
  assert.deepEqual([p102.publicPath, p102.messageText.includes('link')], [null, false], 'không HĐ hiệu lực ⇒ không đường dẫn');
  assert.deepEqual(value.summary, { rooms: 4, debtTotal: '11900000.00', withLink: 1 });
  assert.deepEqual((await direct(env, 'invoice_reminders', { days: 31 })).rows.map(row => row.roomName), ['P102']);
}));

// Lượt 12 (kiểm khói C3 trên TEST): dòng SQL thật qua bước cuối của đường đọc miền (domain-mount finishDomainResult): publicLink tuyệt đối
// theo origin host thay publicPath, tin kèm link thành một khối; vắng origin ⇒ tin không hứa link. Câu SQL "link kèm theo" phải đúng hằng
// connector bỏ đi (đổi câu ở SQL mà quên connector ⇒ đỏ). Mã công khai thật: 6 chữ/số (production 24/10: 472/472).
test('invoice_reminders lượt 12: dòng SQL thật ⇒ publicLink theo origin host, tin kèm link; vắng origin ⇒ không link, tin không hứa link', () => inCase(async env => {
  await env.db.exec("UPDATE public.contracts SET public_code='Ab12Cd' WHERE public_code='PUBLIC-CODE-A'");
  const value = await direct(env, 'invoice_reminders', { roomId: ROOM });
  const result = { report: 'invoice_reminders', source: W2A_REPORTS.invoice_reminders.source, unavailable: null, summary: value.summary, items: value.rows,
    offset: 0, nextOffset: null, sourceCapped: false };
  assert.ok(value.rows[0].messageText.includes(REMINDER_LINK_SENTENCE), 'câu SQL = hằng của connector');
  const [linked] = finishDomainResult(structuredClone(result), 'https://app.example.vn').items;
  assert.deepEqual([linked.publicLink, Object.hasOwn(linked, 'publicPath')], ['https://app.example.vn/c/Ab12Cd', false]);
  assert.match(linked.messageText, /Chi tiết hoá đơn xem ở link kèm theo\. Anh\/chị vui lòng thanh toán giúp\. Cảm ơn anh\/chị!\nhttps:\/\/app\.example\.vn\/c\/Ab12Cd$/);
  const bare = finishDomainResult(structuredClone(result), undefined);
  assert.deepEqual([bare.items[0].publicLink, bare.items[0].messageText.includes('link'), bare.summary.withLink], [null, false, 0]);
  assert.match(bare.items[0].messageText, /\)\. Anh\/chị vui lòng thanh toán giúp\. Cảm ơn anh\/chị!$/, 'câu còn lại liền mạch');
}));

// Review #273 (Mốc 2b).
const OLD_DUE = '0a0a0a0a-0000-4000-8000-000000000144', P102_RECENT = '0a0a0a0a-0000-4000-8000-000000000145';
// P102: thêm hoá đơn quá hạn 10 ngày (300.000đ) bên cạnh hoá đơn quá hạn 45 ngày (100.000đ).
const p102Recent = env => env.db.exec(`INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,
    paid_amount) VALUES('${P102_RECENT}','${ORG}','INV-R2B','APPROVED','${BUILDING}','${ROOM2}','2026-10','2026-10-06',300000,0)`);
const denyCustomers = env => env.db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='customers.view'");

test('review #273 (1): publicPath (trang /c/<mã> hiện tên khách) chỉ khi được xem khách — customers.view của kết nối VÀ quyền CRM ở toà', () => inCase(async env => {
  const p101 = async ctx => (await direct(env, 'invoice_reminders', { roomId: ROOM }, ctx)).rows[0];
  assert.equal((await p101({})).publicPath, '/c/PUBLIC-CODE-A', 'đối chứng: đủ quyền');
  const noScope = await direct(env, 'invoice_reminders', {}, { scopes: {} });
  assert.deepEqual([noScope.rows.every(row => row.publicPath === null && !row.messageText.includes('link')), noScope.summary.withLink], [true, 0],
    'kết nối không giữ customers.view ⇒ không đường dẫn, tin không nhắc link');
  await denyCustomers(env);
  assert.equal((await p101({})).publicPath, null, 'CRM không cho xem khách ở toà ⇒ không đường dẫn');
  assert.ok((await sharedFn(env, `public.invoice_open_debts_v1('${ORG}')`, [])).every(row => row.public_code === null), 'hàm dùng chung cũng giữ mã');
}));

test('review #273 (2): invoice_room_debts có days ⇒ mọi số chỉ cộng hoá đơn quá hạn ≥ N ngày (phòng nhiều hoá đơn)', () => inCase(async env => {
  await p102Recent(env);
  const all = (await direct(env, 'invoice_room_debts', { roomId: ROOM2 })).rows[0];
  assert.deepEqual([all.invoiceCount, all.debtTotal, all.overdueTotal, all.months], [2, '400000.00', '400000.00', '09/2026, 10/2026'], 'đối chứng: không days');
  const month = await direct(env, 'invoice_room_debts', { roomId: ROOM2, days: 31 });
  assert.deepEqual(pick(month.rows, ['invoiceCount', 'debtTotal', 'overdueTotal', 'months', 'maxOverdueDays']), [[1, '100000.00', '100000.00', '09/2026', 45]]);
  assert.deepEqual([month.summary.invoices, month.summary.debtTotal, month.summary.overdueTotal], [1, '100000.00', '100000.00']);
  const remind = (await direct(env, 'invoice_reminders', { roomId: ROOM2, days: 31 })).rows[0];
  assert.equal(remind.debtTotal, '400000.00', 'nhắc nợ: days chỉ chọn phòng, tin nêu TOÀN BỘ nợ của phòng');
}));

test('review #273 (3): $requires$ của 20261022051620 đóng an toàn khi thiếu hàm gọi lúc chạy (áp sai thứ tự)', () => inCase(async env => {
  const body = reads.replace(/^(BEGIN|COMMIT);\s*$/gm, '');
  for (const fn of ['public.invoice_effective_outstanding_v1(uuid[])', 'public.is_overdue(public.invoices)', 'public.can_do_on_building(text,text,uuid)',
    'public.org_today_v1(uuid)']) assert.ok(body.includes(`to_regprocedure('${fn}') IS NULL`), fn);
  await env.db.exec('DROP FUNCTION public.is_overdue(public.invoices)');
  await assert.rejects(env.db.exec(body), /hermes_w2a_invoice_reads_dependency_invalid/, 'thiếu is_overdue ⇒ dừng trước khi thay hàm');
}));

test('review #273 (4) + ghi nhận: khoảng ngày kẹp 366 ngày; điều chỉnh bỏ hoá đơn huỷ; số tiêu thụ âm ⇒ null; tin ≤ 8 hoá đơn', () => inCase(async env => {
  assert.deepEqual([(await direct(env, 'invoice_lateness', { fromDate: '2020-01-01' })).summary.fromDate,
    (await direct(env, 'invoice_lateness', { toDate: '2026-01-31' })).summary.fromDate], ['2025-10-15', '2025-11-02'], 'chỉ fromDate ⇒ kẹp; chỉ toDate ⇒ 90 ngày trước');
  await env.db.exec(`INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount)
    VALUES('${OLD_DUE}','${ORG}','INV-CU','APPROVED','${BUILDING}','${ROOM3}','2024-06','2024-06-10',500000,0)`);
  assert.equal((await sharedFn(env, `public.invoice_lateness_v1('${ORG}',NULL,NULL,'2020-01-01')`, [])).some(row => row.invoice_id === OLD_DUE), false,
    'hàm dùng chung: chỉ p_from không quét cả lịch sử');
  await env.db.exec(`INSERT INTO public.invoice_adjustments(organization_id,invoice_id,review_status,revision,reason,before_total,after_total,delta,adjusted_by,adjusted_at)
    VALUES('${ORG}','${INVOICE_A}','PENDING',0,'Cũ',1,1,0,'${USER}','2025-01-05T03:00:00Z')`);
  assert.equal((await direct(env, 'invoice_adjustments')).rows.length, 3, 'mặc định không đọc điều chỉnh quá 366 ngày');
  assert.equal((await direct(env, 'invoice_adjustments', { fromDate: '2025-01-01', toDate: '2025-12-31' })).rows.length, 1, 'chọn đúng khoảng thì có');
  await env.db.exec(`UPDATE public.invoices SET status='CANCELLED' WHERE id='${INV_C_UNPAID}'`);
  assert.deepEqual((await direct(env, 'invoice_adjustments')).rows.map(row => row.reviewStatus), ['CHECKED'], 'hoá đơn huỷ ⇒ bỏ điều chỉnh của nó');
  await env.db.exec("UPDATE public.invoice_items SET previous_reading=300,current_reading=20 WHERE description='Tiền điện T10'");
  assert.equal((await direct(env, 'invoice_room_detail', { roomId: ROOM })).rows.find(row => row.label === 'Tiền điện T10').consumption, null, 'thay công tơ ⇒ null');
  await env.db.exec(`INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount)
    SELECT gen_random_uuid(),'${ORG}','INV-P4-'||n,'APPROVED','${BUILDING}','${ROOM4}',to_char(date '2026-01-01'+(n-1)*interval '1 month','YYYY-MM'),
      date '2026-01-10'+(n-1)*interval '1 month',1000,0 FROM generate_series(1,9) n`);
  const p104 = (await direct(env, 'invoice_reminders', { roomId: ROOM4 })).rows[0];
  assert.deepEqual([p104.invoiceCount, (p104.details.match(/tháng /g) ?? []).length], [10, 8]);
  assert.match(p104.details, /; và 2 hoá đơn khác$/);
  assert.match(p104.messageText, /Cảm ơn anh\/chị!$/, 'câu kết còn nguyên');
}));

test('cổng đầu-cuối: 7 báo cáo qua public.hermes_w2_read_v1 (cổng gỡ organizationId); phòng toà ngoài phạm vi ⇒ 42501', () => inCase(async env => {
  for (const report of REPORTS) {
    const value = await env.report(report, params(report, { invoice_room_detail: { roomId: ROOM }, invoice_missing: { month: '2026-11' } }[report] ?? {}), { limit: 50 });
    assert.ok(value.items.length > 0 && value.items.every(row => row.buildingId === BUILDING && !Object.hasOwn(row, 'organizationId')), report);
  }
  await assert.rejects(env.report('invoice_room_detail', params('invoice_room_detail', { roomId: '0a0a0a0a-0000-4000-8000-000000000999' })), code('42501'), 'phòng lạ');
  assert.equal((await env.report('invoice_room_debts', params('invoice_room_debts', { roomId: ROOM2 }), { limit: 50 })).items.length, 1);
}));

// Đột biến (Contract §8: tiền, quyền): mỗi bản gỡ MỘT rào/công thức; cùng phép thử mà bản sống từ chối thì bản đột biến phải lọt.
const replaceIn = base => (from, to) => { assert.equal(base.split(from).length, 2, `anchor: ${from}`); return base.replace(from, () => to); };
const sharedMutant = replaceIn(shared), readMutant = replaceIn(reads);
const probes = [
  { name: 'nợ thực: cộng thẳng remaining (nợ kéo đếm hai lần)', base: shared,
    sql: sharedMutant(`    COALESCE(i.remaining_amount,0),e.effective_outstanding,COALESCE(public.is_overdue(i),false),`,
      `    COALESCE(i.remaining_amount,0),COALESCE(i.remaining_amount,0),COALESCE(public.is_overdue(i),false),`),
    run: async env => { await carry(env); return (await direct(env, 'invoice_room_debts', { roomId: ROOM4 })).rows[0].debtTotal === '2600000.00'; } },
  { name: 'quá hạn theo status OVERDUE thay vì hạn', base: shared,
    sql: sharedMutant(`    COALESCE(i.remaining_amount,0),e.effective_outstanding,COALESCE(public.is_overdue(i),false),
    CASE WHEN COALESCE(public.is_overdue(i),false) THEN (v_today-i.due_date)::integer END,`, `    COALESCE(i.remaining_amount,0),e.effective_outstanding,i.status::text='OVERDUE',
    CASE WHEN i.status::text='OVERDUE' THEN (v_today-i.due_date)::integer END,`),
    run: async env => (await direct(env, 'invoice_room_debts')).summary.overdueRooms === 0 },
  { name: 'hàm dùng chung: khoá của trang theo toà', base: shared,
    sql: sharedMutant(`      AND public.can_do_on_building('thu_tien','view',b.id);`, `;`),
    run: async env => { await env.db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='thu_tien.view'");
      return (await sharedFn(env, 'public.invoice_collection_by_method_v1($1)', [ORG])).length > 0; } },
  { name: 'hàm dùng chung: chỉ vai authenticated', base: shared,
    sql: sharedMutant(`DECLARE v_b uuid[]; v_today date; v_ids uuid[];
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('invoices','view',b.id);
  v_today:=COALESCE(p_as_of,public.org_today_v1(p_organization_id));
  SELECT COALESCE(array_agg(i.id),'{}'::uuid[]) INTO v_ids FROM public.invoices i
    WHERE i.organization_id=p_organization_id AND i.deleted_at IS NULL AND i.status::text IN`, `DECLARE v_b uuid[]; v_today date; v_ids uuid[];
BEGIN
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('invoices','view',b.id);
  v_today:=COALESCE(p_as_of,public.org_today_v1(p_organization_id));
  SELECT COALESCE(array_agg(i.id),'{}'::uuid[]) INTO v_ids FROM public.invoices i
    WHERE i.organization_id=p_organization_id AND i.deleted_at IS NULL AND i.status::text IN`),
    run: async env => (await sharedFn(env, 'public.invoice_open_debts_v1($1)', [ORG], { role: 'postgres' })).length > 0 },
  { name: 'phòng thiếu hoá đơn: hoá đơn huỷ không được tính là đã có', base: shared,
    sql: sharedMutant(`      AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED' AND COALESCE(i.kind,'MONTHLY')='MONTHLY')`,
      `      AND i.deleted_at IS NULL AND COALESCE(i.kind,'MONTHLY')='MONTHLY')`),
    run: async env => { await env.db.exec(`UPDATE public.invoices SET status='CANCELLED' WHERE id='${INV_C_UNPAID}'`);
      return (await direct(env, 'invoice_missing', { month: '2026-10' })).rows.length === 0; } },
  { name: 'đóng trễ: ngày trả đủ là lần thu đạt tổng, không phải lần thu đầu', base: shared,
    sql: sharedMutant(`pay.cum>=inv.total`, `pay.cum>0`),
    run: async env => {
      await env.db.exec(`INSERT INTO public.payments(id,organization_id,invoice_id,receipt_number,amount,payment_method,payment_date,created_at) VALUES
        ('0a0a0a0a-0000-4000-8000-000000000143','${ORG}','${INV_C_PAID}','PT-SOM',1000,'TK','2026-10-09','2026-10-09T03:00:00Z')`);
      return (await direct(env, 'invoice_lateness')).rows.find(row => row.invoiceId === INV_C_PAID).settledDate === '2026-10-09'; } },
  { name: 'báo cáo theo phòng: lọc quá hạn ≥ N ngày', base: reads,
    sql: readMutant(`        GROUP BY d.building_id,d.room_id
        HAVING v_days IS NULL OR COALESCE(max(d.overdue_days),0)>=v_days) h) g;`, `        GROUP BY d.building_id,d.room_id) h) g;`),
    run: async env => (await direct(env, 'invoice_reminders', { days: 31 })).rows.length === 4 },
  { name: 'báo cáo theo phòng: tên khách theo customers.view của toà', base: reads,
    sql: readMutant(`'customerName',CASE WHEN d.building_id=ANY(v_cust) THEN (array_agg(d.customer_name ORDER BY d.billing_month DESC,d.invoice_id))[1] END,`,
      `'customerName',(array_agg(d.customer_name ORDER BY d.billing_month DESC,d.invoice_id))[1],`),
    run: async env => (await direct(env, 'invoice_room_debts', {}, { scopes: {} })).rows[0].customerName !== null },
  { name: 'điều chỉnh: lý do chỉ khi mọi khách của HĐ nhìn thấy', base: reads,
    sql: readMutant(`'reason',CASE WHEN k.linked THEN a.reason END,`, `'reason',a.reason,`),
    run: async env => (await direct(env, 'invoice_adjustments', {}, { scopes: {} })).rows.some(row => row.reason !== null) },
  { name: 'review #273: công nợ theo phòng có days chỉ cộng hoá đơn quá hạn ≥ N ngày', base: reads,
    sql: readMutant(`      WHERE v_days IS NULL OR d.overdue_days>=v_days
      GROUP BY d.building_id,d.room_id) g;`, `      GROUP BY d.building_id,d.room_id
      HAVING v_days IS NULL OR COALESCE(max(d.overdue_days),0)>=v_days) g;`),
    run: async env => { await p102Recent(env); return (await direct(env, 'invoice_room_debts', { roomId: ROOM2, days: 31 })).rows[0].debtTotal === '400000.00'; } },
  { name: 'review #273: hàm dùng chung chỉ trả mã tra cứu công khai khi CRM cho xem khách ở toà', base: shared,
    sql: sharedMutant(`
      AND public.can_do_on_building('customers','view',i.building_id) THEN c.public_code END,`, ` THEN c.public_code END,`),
    run: async env => { await denyCustomers(env); return (await sharedFn(env, `public.invoice_open_debts_v1('${ORG}')`, [])).some(row => row.public_code !== null); } },
  { name: 'review #273: publicPath chỉ khi toà thuộc customers.view của kết nối', base: reads,
    sql: readMutant(`CASE WHEN d.building_id=ANY(v_cust) THEN
            (array_agg(d.public_code`, `CASE WHEN true THEN
            (array_agg(d.public_code`),
    run: async env => (await direct(env, 'invoice_reminders', {}, { scopes: {} })).rows.some(row => row.publicPath !== null) },
  { name: 'review #273: khoảng ngày đóng trễ kẹp 366 ngày', base: shared,
    sql: sharedMutant(`v_to:=COALESCE(p_to,v_today); v_from:=GREATEST(COALESCE(p_from,v_to-90),v_to-366);`, `v_to:=COALESCE(p_to,v_today); v_from:=COALESCE(p_from,v_to-90);`),
    run: async env => {
      await env.db.exec(`INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount)
        VALUES('${OLD_DUE}','${ORG}','INV-CU','APPROVED','${BUILDING}','${ROOM3}','2024-06','2024-06-10',500000,0)`);
      return (await sharedFn(env, `public.invoice_lateness_v1('${ORG}',NULL,NULL,'2020-01-01')`, [])).some(row => row.invoice_id === OLD_DUE); } },
  { name: 'điều chỉnh: chờ kiểm chỉ tính phiên bản hiện hành', base: reads,
    sql: readMutant(`COALESCE(a.review_status='PENDING' AND a.is_current,false) pending`, `a.review_status='PENDING' pending`),
    run: async env => (await direct(env, 'invoice_adjustments')).summary.pendingCount === 2 },
];
for (const probe of probes) {
  const changed = changedFunctions(probe.base, probe.sql);
  assert.equal(changed.length, 1, `${probe.name}: đúng một hàm đổi`);
  test(`mutation is caught: ${probe.name}`, { timeout: 120000 }, async () => {
    await inCase(async env => assert.equal(await probe.run(env).catch(() => false), false, 'bản sống từ chối'));
    await inCase(async env => {
      for (const sql of changed) await env.db.exec(sql);
      assert.equal(await probe.run(env), true, 'bản đột biến lọt');
    });
  });
}
