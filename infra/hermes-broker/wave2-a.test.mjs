import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedW2a, BUILDING, OTHER_BUILDING, USER, ORG, FOREIGN, CUSTOMER_C, CONTRACT_A, INVOICE_A, INVOICE_B, ROOM2,
  INV_OVER, INV_OVER_CANCELLED, INV_OVER_DELETED, INV_OVER_B, INV_C_PAID, INV_C_REV, PAY_A,
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
// Số liệu tính tay theo đúng bộ lọc web (vùng hermes-parity dẫn trong migration gói A); ca đầu-cuối qua lối vào thật
// public.hermes_w2_read_v1 (bước kiểm quyền → hàm gói → rào đầu ra); rào broker (domainInput/domainResult của
// crm_read_report) nhận đúng phong bì SQL thật; đột biến SQL trên chính migration gói A (gọi thẳng hàm gói/hàm dùng
// chung bằng vai authenticated). Không chứng minh RLS thật/JWT thật/PostgREST: phần đó đo trên TEST.
const MIGRATION_PATH = 'supabase/migrations/20261018010000_hermes_w2a_receivables_read_v1.sql';
const migration = readFileSync(MIGRATION_PATH, 'utf8');
// Sửa sau review PR #207: thay thân hàm đọc gói (định nghĩa sống cuối cùng); 8 hàm dùng chung vẫn ở MIGRATION_PATH.
const FIX_PATH = 'supabase/migrations/20261018010100_hermes_w2a_review_fixes_v1.sql';
const fixes = readFileSync(FIX_PATH, 'utf8');
// Gói Z (20261018080100) thay thân hàm đọc gói lần cuối; fixture mặc định chạy chuỗi a + z (review PR #215 P3-1).
const Z_PATH = 'supabase/migrations/20261018080100_hermes_w2z_receivables_pii_v1.sql';
const zFix = readFileSync(Z_PATH, 'utf8');
// Sau phát hành (19/10): phiếu cọc giữ chỗ theo đúng tập web (RLS, gồm phiếu vào sổ quỹ người hỏi giữ) — thay thân hàm đọc gói
// lần cuối và hàm dùng chung public.deposit_reservation_vouchers_v1 (test riêng: wave2-a-coc-quy.test.mjs).
const POST_PATH = 'supabase/migrations/20261018182656_hermes_w2a_reservation_fund_member_v1.sql';
const postFix = readFileSync(POST_PATH, 'utf8');
const READ_HEAD = 'CREATE OR REPLACE FUNCTION app_private.hermes_w2a_read_v1(';
const readBodyOf = sql => sql.slice(sql.indexOf(READ_HEAD)).split('$fn$')[1];
const KEYS = [...new Set(Object.values(W2A_REPORTS).map(spec => spec.permission))];
const REPORTS = Object.keys(W2A_REPORTS);
// Toà của công ty khác có trong fixture đọc đầy đủ (u(12) của full-read-sql-fixture) và một hoá đơn tạo trong ca.
const OTHER_ORG_BUILDING = '0e0e0e0e-0000-4000-8000-000000000012', FOREIGN_INVOICE = '0a0a0a0a-0000-4000-8000-000000000130';
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
const direct = (env, report, values = {}, ctx = {}, options) => env.call('SELECT public.fixture_w2a_read($1,$2::jsonb,$3::jsonb) result',
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

test('cấu trúc: chỉ hàm gói A + 8 hàm dùng chung; INVOKER, chỉ authenticated, tự từ chối vai khác; hàm đọc không gọi app_private, không đổi ACL; không copilot, không chép policy', () => inCase(async env => {
  const { db } = env;
  const stripped = migration.replace(/--[^\n]*/g, '');
  const created = [...stripped.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+\.[a-z0-9_]+)\(/g)].map(match => match[1]).sort();
  const SHARED = ['public.cashbook_change_ledger_v1', 'public.deposit_held_contracts_v1', 'public.deposit_refunds_forfeits_v1', 'public.deposit_reservation_vouchers_v1',
    'public.finance_overpayment_invoices_v1', 'public.finance_payment_schedule_v1', 'public.invoice_detail_v1', 'public.thu_tien_collection_v1'];
  assert.deepEqual(created, ['app_private.hermes_w2a_catalog_v1', 'app_private.hermes_w2a_read_v1', ...SHARED].sort());
  assert.doesNotMatch(stripped, /copilot|\bDROP\b|ALTER TABLE|UPDATE |INSERT |DELETE /i);
  assert.doesNotMatch(stripped, /current_visible_owner_ids|can_view_restricted_ie|has_restricted_item|ie_visible_cashbook_ids/, 'không chép policy RLS');
  assert.doesNotMatch(stripped, /\bGRANT\b/i, 'không GRANT: authenticated giữ quyền mặc định schema public; hàm đọc do nền cấp');
  assert.doesNotMatch(stripped, /(?:GRANT|REVOKE)[^;]*hermes_w2a_read_v1/i, 'không đổi ACL hàm đọc');
  const readBody = stripped.slice(stripped.indexOf('CREATE OR REPLACE FUNCTION app_private.hermes_w2a_read_v1(')).split('$fn$')[1];
  assert.doesNotMatch(readBody, /app_private\./i, 'hàm đọc INVOKER không gọi app_private.*');
  assert.match(stripped, /CREATE OR REPLACE FUNCTION app_private\.hermes_w2a_read_v1\(p_report text,p_params jsonb,p_ctx jsonb\)\s+RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS/);
  // Bản sửa sau review: CHỈ thay thân hàm đọc (cùng dòng đầu INVOKER), không đổi ACL/hàm dùng chung. Bản sống là bản Z
  // (080100, cùng dòng đầu) — trước review PR #215 test này chạy chuỗi chỉ gói A nên so với bản sửa sau review.
  const fixed = fixes.replace(/--[^\n]*/g, '');
  assert.deepEqual([...fixed.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+\.[a-z0-9_]+)\(/g)].map(match => match[1]), ['app_private.hermes_w2a_read_v1']);
  assert.doesNotMatch(fixed, /copilot|\bDROP\b|ALTER TABLE|UPDATE |INSERT |DELETE |\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(fixed, /current_visible_owner_ids|can_view_restricted_ie|has_restricted_item|ie_visible_cashbook_ids/, 'không chép policy RLS');
  assert.doesNotMatch(readBodyOf(fixed), /app_private\./i, 'hàm đọc INVOKER không gọi app_private.*');
  assert.match(fixed, /CREATE OR REPLACE FUNCTION app_private\.hermes_w2a_read_v1\(p_report text,p_params jsonb,p_ctx jsonb\)\s+RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS/);
  assert.equal((await db.query("SELECT prosrc FROM pg_proc WHERE oid='app_private.hermes_w2a_read_v1(text,jsonb,jsonb)'::regprocedure")).rows[0].prosrc,
    readBodyOf(postFix), 'thân sống = bản sau phát hành (phiếu cọc giữ chỗ theo web), thay bản Z (080100)');
  assert.notEqual(readBodyOf(zFix), readBodyOf(fixes), 'bản Z thay thân bản sửa sau review');
  assert.notEqual(readBodyOf(postFix), readBodyOf(zFix), 'bản sau phát hành thay thân bản Z');
  const procs = (await db.query(`SELECT n.nspname||'.'||p.proname name,p.prosecdef definer,p.proconfig config,p.provolatile vol,
      has_function_privilege('authenticated',p.oid,'EXECUTE') auth,has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('service_role',p.oid,'EXECUTE') service FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname||'.'||p.proname=ANY($1)`, [created])).rows;
  assert.equal(procs.length, created.length);
  for (const proc of procs) {
    const catalog = proc.name === 'app_private.hermes_w2a_catalog_v1';
    assert.equal(proc.definer, catalog, `${proc.name}: ${catalog ? 'DEFINER (bảng hằng)' : 'INVOKER'}`);
    if (SHARED.includes(proc.name)) assert.deepEqual(proc.config, ['search_path=""'], proc.name);
    else if (!catalog) assert.deepEqual(proc.config, ['search_path=pg_catalog, public'], proc.name);
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

test('hàm dùng chung tự kiểm khoá của trang theo toà (web gọi thẳng cũng đúng quyền); p_building_ids chỉ thu hẹp, {} = rỗng', () => inCase(async env => {
  const calls = { 'reports_finance.payment_schedule': ['public.finance_payment_schedule_v1($1,$2,$3)', [ORG, '2027-10-16']],
    'reports_finance.overpayment': ['public.finance_overpayment_invoices_v1($1,$2)', [ORG]],
    'thu_tien.view': ['public.thu_tien_collection_v1($1,$2,NULL,NULL,$3,$4)', [ORG, '2026-10', '2026-10-16']],
    'deposits.view': ['public.deposit_held_contracts_v1($1,10000,$2)', [ORG]] };
  for (const [key, [fn, args]] of Object.entries(calls)) {
    assert.ok((await sharedFn(env, fn, [...args, null])).length > 0, `${key}: NULL = toàn phạm vi RLS`);
    assert.equal((await sharedFn(env, fn, [...args, []])).length, 0, `${key}: {} = rỗng`);
    await env.db.query('UPDATE public.fixture_acl SET allowed=false WHERE permission=$1', [key]);
    assert.equal((await sharedFn(env, fn, [...args, null])).length, 0, `${key}: thiếu khoá trang ⇒ không hàng nào`);
    await env.db.query('UPDATE public.fixture_acl SET allowed=true WHERE permission=$1', [key]);
  }
  await env.db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='invoices.view'");
  assert.equal(await env.call(`SELECT public.invoice_detail_v1('${ORG}','${INVOICE_A}',NULL) result`, []), null, 'invoices.view thiếu ⇒ không thấy hoá đơn');
}));

test('cổng đầu-cuối (public.hermes_w2_read_v1): số như gọi thẳng; thiếu khoá/toà ngoài overlay/hoá đơn toà khác ⇒ 42501; Toàn tổ chức ⇒ có toà B', () => inCase(async env => {
  const viaGate = await env.report('overpayment', params('overpayment'), { limit: 50 });
  assert.deepEqual([ids(viaGate.items, 'invoiceId'), viaGate.summary, viaGate.fence], [[INV_OVER, INV_OVER_CANCELLED], { total: '300000.00', count: 2 },
    { buildings: [BUILDING], cashbooks: [], orgWide: false }]);
  const detail = await env.report('invoice_detail', params('invoice_detail', { invoiceId: INVOICE_A }), { limit: 50 });
  assert.deepEqual([detail.summary.found, detail.summary.customerName, detail.items.length], [true, 'Nguyễn Văn An', 8]);
  await assert.rejects(env.report('invoice_detail', params('invoice_detail', { invoiceId: INVOICE_B })), code('42501'), 'hoá đơn toà B ngoài overlay');
  await assert.rejects(env.report('overpayment', params('overpayment', { buildingId: OTHER_BUILDING })), code('42501'), 'toà B ngoài overlay');
  await assert.rejects(env.report('change_ledger', params('change_ledger', { cashbookId: '0a0a0a0a-0000-4000-8000-000000000999' })), code('42501'), 'sổ không thuộc công ty');
  await env.db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='deposits.view'");
  await assert.rejects(env.report('held_deposits', params('held_deposits')), code('42501'), 'thiếu khoá CRM');
  await env.db.exec("UPDATE public.fixture_acl SET allowed=true,org_wide=true WHERE permission='reports_finance.payment_schedule'");
  for (const table of ['hermes_connections', 'hermes_org_policies'])
    await env.db.query(`UPDATE app_private.${table} SET scope_ids=array_append(scope_ids,$1::uuid)`, ['00000000-0000-4000-8000-0000000000a1']);
  const wide = await env.report('payment_schedule', params('payment_schedule'), { limit: 50 });
  assert.ok(wide.fence.orgWide && wide.items.some(row => row.buildingId === OTHER_BUILDING), 'Toàn tổ chức ⇒ có toà B');
}));

test('rào công ty (000700): mọi hàng của 9 báo cáo mang organizationId từ cột nguồn; cổng gỡ trước khi trả; thân hàm đọc không chép ctx', () => inCase(async env => {
  for (const report of REPORTS) {
    const raw = await direct(env, report);
    assert.ok(raw.rows.length > 0, `${report}: có hàng để kiểm`);
    assert.ok(raw.rows.every(row => row.organizationId === ORG), `${report}: organizationId = công ty`);
    const viaGate = await env.report(report, params(report, DEFAULTS[report]), { limit: 50 });
    assert.ok(viaGate.items.length > 0 && viaGate.items.every(row => !Object.hasOwn(row, 'organizationId')), `${report}: cổng gỡ trường rào`);
    assert.ok(!Object.hasOwn(W2A_REPORTS[report].fields, 'organizationId'), `${report}: fields không khai organizationId`);
  }
  const readBody = readBodyOf(fixes.replace(/--[^\n]*/g, ''));
  const sources = [...readBody.matchAll(/'organizationId',([^,]+)/g)].map(match => match[1].trim());
  assert.equal(sources.length, 11, '8 báo cáo bảng + 3 loại dòng chi tiết hoá đơn');
  for (const source of sources) assert.match(source, /^\(SELECT src\.organization_id FROM public\.[a-z_]+ src WHERE src\.id=|^v_head->'organizationId'$|^e->'organizationId'$/, source);
}));

test('rào công ty: hàm dùng chung lỡ bỏ lọc công ty ⇒ cột nguồn làm bước kết thúc chặn cả lượt (42501); chép ctx.organizationId thì lọt', async () => {
  const swap = (sql, from, to) => { assert.equal(sql.split(from).length, 2, `anchor: ${from}`); return sql.replace(from, () => to); };
  const noFilter = swap(migration, `  WHERE i.organization_id=p_organization_id AND i.deleted_at IS NULL AND i.paid_amount>0`, `  WHERE i.deleted_at IS NULL AND i.paid_amount>0`);
  const copyCtx = swap(fixes, `'organizationId',(SELECT src.organization_id FROM public.invoices src WHERE src.id=s.invoice_id),
          'invoiceNumber',s.invoice_number`, `'organizationId',v_org,
          'invoiceNumber',s.invoice_number`);
  // Dữ liệu lệch: hoá đơn nêu công ty khác nhưng nằm ở toà của công ty kết nối (RLS theo toà vẫn cho thấy).
  const seeded = async (env, ...variants) => {
    for (const [base, variant] of variants) for (const sql of changedFunctions(base, variant)) await env.db.exec(sql);
    await env.db.exec(`INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount)
      VALUES('${FOREIGN_INVOICE}','${FOREIGN}','INV-F3','APPROVED','${BUILDING}',null,'2026-10','2026-10-01',100,500)`);
    return env.report('overpayment', params('overpayment'), { limit: 50 });
  };
  await inCase(async env => assert.ok(!ids((await seeded(env)).items, 'invoiceId').includes(FOREIGN_INVOICE), 'bản sống: lọc công ty'));
  await inCase(async env => assert.rejects(seeded(env, [migration, noFilter]), error => error.code === '42501' && error.message === 'hermes_w2_row_outside_scope',
    'bỏ lọc công ty: cột nguồn ⇒ bước kết thúc 42501'));
  await inCase(async env => assert.ok(ids((await seeded(env, [migration, noFilter], [fixes, copyCtx])).items, 'invoiceId').includes(FOREIGN_INVOICE),
    'chép ctx: lọt (phép thử nhạy)'));
});

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

test('collection: cả kỳ / hôm nay / khoảng ngày như ThuTien.tsx; tab Đã thu/Chưa thu; người thu bỏ trùng, RLS ẩn phiếu hạn chế; khoản đã hoàn tác không cộng (web #209, bản Z)', () => inCase(async env => {
  let value = await run(env, 'collection', { month: '2026-10' });
  assert.deepEqual(value.summary, { mode: 'all', invoiceCount: 4, collectedSum: '3000000.00', remainingSum: '4800000.00', paidRooms: 1, dueRooms: 3 });
  assert.deepEqual(value.items.map(row => [row.roomName, row.collectStatus, row.collectors]),
    [['P101', 'partial', 'Kế toán A'], ['P102', 'paid', 'Thu Ngân A'], ['P103', 'unpaid', null], ['P104', 'unpaid', null]]);
  assert.equal(value.items[0].customerName, 'Nguyễn Văn An');
  assert.deepEqual(ids((await run(env, 'collection', { month: '2026-10', status: 'paid' })).items, 'invoiceId'), [INV_C_PAID]);
  value = await run(env, 'collection', { month: '2026-10', fromDate: '2026-10-16', toDate: '2026-10-16' });
  // Kỳ vọng cũ của gói A ("khoản đã hoàn tác: web vẫn cộng" ⇒ 2,8tr, 2 phòng đã thu) lỗi thời từ web #209: bản Z
  // (080000, thu_tien_collection_v1) lọc payments.reversed_at như useThuTienInvoices ⇒ P104 (800k thu rồi hoàn tác) chưa thu.
  assert.deepEqual(value.summary, { mode: 'today', invoiceCount: 4, collectedSum: '2000000', remainingSum: '4800000.00', paidRooms: 1, dueRooms: 3 },
    'hôm nay: thu 2tr (khoản 800k đã hoàn tác không cộng); còn nợ P101 + P103 + P104');
  assert.deepEqual(ids((await run(env, 'collection', { month: '2026-10', fromDate: '2026-10-16', toDate: '2026-10-16', status: 'paid' })).items, 'invoiceId'),
    [INV_C_PAID]);
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
    value.summary.contractNumber, value.summary.adjustmentCount, value.summary.notes],
  ['INV-A', '3500000.00', '1000000.00', '2500000.00', 'Nguyễn Văn An', 'HD-A', 1, 'Khách hẹn trả cuối tháng']);
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

test('reservation_vouchers: phiếu cọc giữ chỗ (bỏ loại trừ, đã vào HĐ, không cọc, toà B), số cọc = Σ hạng mục cọc; tìm mã/phòng; tổng từ RPC', () => inCase(async env => {
  const value = await run(env, 'reservation_vouchers');
  assert.deepEqual(value.items.map(row => [row.voucherId, row.depositAmount, row.settled]),
    [[RV2, '500000', false], [RV1, '2000000', false], [RV_SETTLED, '700000', true], [RV3, '300000', false]]);
  assert.deepEqual([value.items[1].holdUntil, value.items[1].topupDueDate, value.items[1].depositTarget, value.items[1].code],
    ['2026-10-20', '2026-10-18', '2500000', 'PT-G1']);
  assert.ok(value.items.every(row => row.payerName === null && row.name === null),
    'người nộp/tên phiếu chép tên khách: không nối được hồ sơ khách dưới RLS người hỏi ⇒ NULL kể cả khi đủ quyền');
  assert.deepEqual(value.summary, { holdingAmount: '2000000', approvedCount: 1, unapprovedCount: 1, cancelledCount: 1 }, 'RPC bỏ phiếu đã quyết toán');
  assert.deepEqual(ids((await run(env, 'reservation_vouchers', { status: 'APPROVED' })).items, 'voucherId'), [RV1, RV_SETTLED]);
  assert.deepEqual(ids((await run(env, 'reservation_vouchers', { query: 'p104' })).items, 'voucherId'), [RV3], 'tìm theo tên phòng');
  assert.deepEqual(ids((await run(env, 'reservation_vouchers', { query: 'pt-g2' })).items, 'voucherId'), [RV2], 'tìm theo mã phiếu');
  for (const query of ['TRẦN cọc', 'Cọc huỷ'])
    assert.deepEqual((await run(env, 'reservation_vouchers', { query })).items, [], `không tìm theo người nộp/tên phiếu: ${query}`);
  assert.ok(!ids(value.items, 'voucherId').includes(RV_EXCL));
}));

test('reservation_settlements: gọi thẳng get_reservation_settlements_v1 (toà tường minh), trạng thái hoàn, tổng từ RPC; nhiều hơn một trang 200 vẫn đủ', () => inCase(async env => {
  let value = await run(env, 'reservation_settlements');
  assert.deepEqual(value.items.map(row => [row.settlementId, row.refundState, row.refundRemaining, row.payerName]),
    [[S2, 'PENDING', '300000', null], [S1, 'PAID', '0', null]], 'người nộp của phiếu cọc nguồn: không nối được hồ sơ khách ⇒ NULL');
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
  assert.deepEqual(value.items.map(row => [row.voucherId, row.amount, row.payerName, row.notes]), [[L2, '3000', null, null], [L1, '5000', 'Khách Lẻ', 'thối 5k']],
    'L1 nối hoá đơn → HĐ → khách nhìn thấy; L2 không nối được hồ sơ khách ⇒ NULL');
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
  for (const report of REPORTS.filter(report => report !== 'reservation_vouchers'))
    assert.equal((await run(env, report, DEFAULTS[report])).unavailable, 'no_building_scope', report);
  // Phiếu cọc giữ chỗ (19/10, như web): không giao buildings.view — RLS income_expenses quyết; không giữ sổ quỹ ⇒ không phiếu nào.
  const reservation = await run(env, 'reservation_vouchers');
  assert.deepEqual([reservation.unavailable, reservation.items, reservation.summary.approvedCount, reservation.summary.holdingAmount], [null, [], 0, '0']);
  await env.db.exec('INSERT INTO public.fixture_super_scope VALUES(true)');
  assert.equal((await run(env, 'overpayment')).items.length, 2, 'toàn quyền toà (super admin) không thu hẹp');
}));

test('riêng tư: không customers.view ở toà (ctx) hoặc RLS customers ẩn ⇒ mọi tên khách/người nộp/ghi chú null, tìm người nộp không lọt', () => inCase(async env => {
  const names = async ctx => {
    const out = [];
    for (const report of REPORTS) {
      const value = await run(env, report, DEFAULTS[report], { ctx });
      for (const row of [...value.items, value.summary ?? {}]) {
        for (const key of ['customerName', 'payerName', 'notes', 'name']) if (Object.hasOwn(row, key) && row[key] !== null) out.push(`${report}.${key}`);
        if (row.kind === 'voucher' && row.label !== null) out.push(`${report}.voucher.label`);
      }
    }
    return out;
  };
  assert.ok((await names({})).length > 0, 'có tên khi đủ quyền');
  assert.deepEqual(await names({ scopes: { 'customers.view': [OTHER_BUILDING] } }), [], 'customers.view chỉ ở toà B');
  assert.deepEqual(await names({ scopes: {} }), [], 'kết nối không giữ customers.view');
  assert.deepEqual((await run(env, 'reservation_vouchers', { query: 'Trần Cọc' }, { ctx: { scopes: {} } })).items, [], 'không dò được người nộp');
  await env.db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='customers.view'");
  for (const report of ['payment_schedule', 'held_deposits', 'deposit_refunds', 'invoice_detail', 'change_ledger'])
    assert.ok((await run(env, report, DEFAULTS[report])).items.concat([(await run(env, report, DEFAULTS[report])).summary])
      .every(row => !row || ['customerName', 'payerName', 'notes'].every(key => row[key] === undefined || row[key] === null)), `${report}: RLS customers ẩn`);
}));

test('PII chép trên phiếu: gỡ chủ hồ sơ khỏi visible owners ⇒ RLS customers rỗng, 3 báo cáo snapshot hết người nộp/ghi chú/tên phiếu, không tìm theo người nộp', () => inCase(async env => {
  const pii = async () => {
    const out = [];
    for (const report of ['reservation_vouchers', 'reservation_settlements', 'change_ledger'])
      for (const row of (await run(env, report, DEFAULTS[report], { limit: 2000 })).items)
        for (const key of ['payerName', 'notes', 'name']) if (Object.hasOwn(row, key) && row[key] !== null) out.push(`${report}.${key}`);
    return out;
  };
  assert.deepEqual(await pii(), ['change_ledger.payerName', 'change_ledger.notes'], 'trước khi gỡ: chỉ phiếu nối được tới khách nhìn thấy');
  await env.db.exec('DELETE FROM public.fixture_visible_owners');
  assert.equal(await env.call('SELECT count(*)::int result FROM public.customers', []), 0, 'RLS customers: không còn hồ sơ nào');
  assert.deepEqual(await pii(), []);
  for (const query of ['Trần Cọc', 'Ngô Quyết', 'Khách Lẻ'])
    assert.deepEqual((await run(env, 'reservation_vouchers', { query })).items, [], `không dò được người nộp: ${query}`);
}));

test('invoice_detail: ghi chú hoá đơn và tên phiếu chỉ khi toà ∈ customers.view VÀ hồ sơ khách nhìn thấy dưới RLS; mô tả dòng hoá đơn giữ nguyên', () => inCase(async env => {
  const view = async ctx => {
    const value = await run(env, 'invoice_detail', {}, { ctx });
    return [value.summary.notes, value.items.filter(row => row.kind === 'voucher').map(row => row.label), value.items.filter(row => row.kind === 'item').map(row => row.label)];
  };
  const ITEMS = ['Tiền phòng', 'Tiền điện T10', 'Tiền nước T10', 'Phí dịch vụ'];
  assert.deepEqual(await view({}), ['Khách hẹn trả cuối tháng', ['Thu có thối', 'Thu INV-A'], ITEMS]);
  assert.deepEqual(await view({ scopes: {} }), [null, [null, null], ITEMS], 'không customers.view ở toà');
  await env.db.exec('DELETE FROM public.fixture_visible_owners');
  assert.deepEqual(await view({}), [null, [null, null], ITEMS], 'hồ sơ khách của hoá đơn không nhìn thấy dưới RLS');
}));

test('trần nguồn invoice_detail: hơn 2001 dòng ⇒ đúng 2000 hàng đầu đã sắp + sourceCapped; đầu hoá đơn không đổi', () => inCase(async env => {
  await env.db.exec(`INSERT INTO public.invoice_items(invoice_id,type,description,amount,unit_price,quantity,sort_order)
    SELECT '${INVOICE_A}','SERVICE','Dòng '||n,1,1,1,100+n FROM generate_series(1,2001) n`);
  const raw = await direct(env, 'invoice_detail');
  assert.deepEqual([raw.rows.length, raw.sourceCapped, raw.rows[0].label, raw.rows[1999].label, raw.summary.totalAmount],
    [2000, true, 'Tiền phòng', 'Dòng 1996', '3500000.00'], '4 + 2001 dòng hoá đơn + 2 khoản thu + 2 phiếu = 2009 dòng');
}));

test('rào broker: kết quả SQL thật của cả 9 báo cáo qua domainInput/domainResult của crm_read_report; hàng toà ngoài phạm vi bị chặn', () => inCase(async env => {
  for (const report of REPORTS) {
    const input = domainInput('report', { report, params: DEFAULTS[report] ?? {}, limit: 50 });
    // Phong bì THẬT của lối vào (có fence); broker rào theo fence rồi bỏ fence khỏi đầu ra.
    const value = await env.report(report, input.params, { limit: input.limit, offset: input.offset });
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
// Hàm dùng chung đột biến trên MIGRATION_PATH; hàm đọc gói đột biến trên FIX_PATH (định nghĩa sống) — base: fixes.
const replaceIn = base => (from, to) => { assert.equal(base.split(from).length, 2, `anchor: ${from}`); return base.replace(from, () => to); };
const replaceExactly = replaceIn(migration), replaceRead = replaceIn(fixes);
const hideOwners = env => env.db.exec('DELETE FROM public.fixture_visible_owners');
const replaceEach = pairs => pairs.reduce((sql, [from, to]) => { assert.equal(sql.split(from).length, 2, `anchor: ${from}`); return sql.replace(from, () => to); }, migration);
const rowsOf = async (env, report, values, ctx) => (await direct(env, report, values, ctx)).rows;
const probes = [
  { name: 'payment_schedule: bỏ hoá đơn huỷ', sql: replaceExactly(`i.status::text<>'CANCELLED'
      AND i.due_date<=p_due_until`, `true
      AND i.due_date<=p_due_until`),
    run: async env => (await rowsOf(env, 'payment_schedule'))[0].billedThrough === '2027-01-10' },
  { name: 'payment_schedule: trần hôm nay+365', sql: replaceExactly(`AND i.due_date<=p_due_until AND`, `AND`),
    run: async env => (await rowsOf(env, 'payment_schedule'))[0].billedThrough === '2027-12-10' },
  { name: 'hàm dùng chung: thu hẹp về đúng công ty (RLS trải mọi công ty của người dùng)', sql: replaceEach([[`    WHERE i.organization_id=p_organization_id AND i.deleted_at IS NULL AND i.status::text<>'CANCELLED'
      AND i.due_date`, `    WHERE i.deleted_at IS NULL AND i.status::text<>'CANCELLED'
      AND i.due_date`], [`    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('reports_finance','payment_schedule',b.id);`, `    WHERE (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('reports_finance','payment_schedule',b.id);`]]),
    run: async env => {
      // Người dùng thuộc hai công ty: RLS cho thấy toà + hoá đơn của công ty kia.
      await env.db.exec(`INSERT INTO public.fixture_building_access VALUES('${OTHER_ORG_BUILDING}');
        UPDATE public.fixture_acl SET building_ids=building_ids||'${OTHER_ORG_BUILDING}'::uuid WHERE permission='reports_finance.payment_schedule';
        INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount)
          VALUES('${FOREIGN_INVOICE}','${FOREIGN}','INV-F2','APPROVED','${OTHER_ORG_BUILDING}',null,'2026-10','2026-10-01',1,0)`);
      return (await sharedFn(env, 'public.finance_payment_schedule_v1($1,$2,NULL)', [ORG, '2027-10-16'])).some(row => row.invoice_id === FOREIGN_INVOICE); } },
  { name: 'hàm dùng chung: từ chối vai không phải authenticated', sql: replaceExactly(`  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'shared_read_requires_authenticated' USING ERRCODE='42501'; END IF;
  -- Như web: khoá của trang (RequirePermission) xét theo từng toà, trên toà RLS buildings của người gọi thấy.
  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('reports_finance','overpayment',b.id);`, `  SELECT COALESCE(array_agg(b.id),'{}'::uuid[]) INTO v_b FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('reports_finance','overpayment',b.id);`),
    run: async env => (await sharedFn(env, 'public.finance_overpayment_invoices_v1($1,NULL)', [ORG], { role: 'postgres' })).length > 0 },
  { name: 'hàm dùng chung: tự kiểm khoá của trang theo toà', sql: replaceExactly(`
      AND public.can_do_on_building('reports_finance','overpayment',b.id);`, `;`),
    run: async env => { await env.db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='reports_finance.overpayment'");
      return (await sharedFn(env, 'public.finance_overpayment_invoices_v1($1,NULL)', [ORG])).length > 0; } },
  { name: 'payment_schedule: tên khách theo customers.view của toà', base: fixes, sql: replaceRead(`'customerName',CASE WHEN s.building_id=ANY(v_cust) THEN s.customer_name END,
          'billedThrough'`, `'customerName',s.customer_name,
          'billedThrough'`),
    run: async env => (await rowsOf(env, 'payment_schedule', {}, { scopes: {} }))[0].customerName !== null },
  { name: 'overpayment: bỏ hoá đơn đã xoá', sql: replaceExactly(`i.deleted_at IS NULL AND i.paid_amount>0`, `i.paid_amount>0`),
    run: async env => ids(await rowsOf(env, 'overpayment'), 'invoiceId').includes(INV_OVER_DELETED) },
  { name: 'overpayment: tổng theo toà đã giao', base: fixes, sql: replaceRead(`v_raw:=public.get_overpayment_summary(v_b);`, `v_raw:=public.get_overpayment_summary(NULL);`),
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
  // [P1 review #207] PII chép trên phiếu: chỉ khi nối được hồ sơ khách nhìn thấy dưới RLS ⇒ phiếu cọc/quyết toán luôn NULL.
  { name: 'reservation_vouchers: người nộp không nối được hồ sơ khách ⇒ NULL', base: fixes, sql: replaceRead(`          'payerName',NULL,
          'depositAmount'`, `          'payerName',CASE WHEN v.building_id=ANY(v_cust) THEN v.payer_name END,
          'depositAmount'`),
    run: async env => { await hideOwners(env); return (await rowsOf(env, 'reservation_vouchers')).some(row => row.payerName !== null); } },
  { name: 'reservation_vouchers: tên phiếu (luồng bổ sung cọc ghi tên khách) ⇒ NULL', base: fixes, sql: replaceRead(`'code',v.code,'name',NULL,`,
    `'code',v.code,'name',v.name,`),
    run: async env => { await hideOwners(env); return (await rowsOf(env, 'reservation_vouchers')).some(row => row.name !== null); } },
  { name: 'reservation_vouchers: không tìm theo người nộp', base: fixes, sql: replaceRead(`          OR position(v_query IN lower(COALESCE(v.room_name,'')))>0)`,
    `          OR position(v_query IN lower(COALESCE(v.room_name,'')))>0 OR v.building_id=ANY(v_cust) AND position(v_query IN lower(COALESCE(v.payer_name,'')))>0)`),
    run: async env => { await hideOwners(env); return (await rowsOf(env, 'reservation_vouchers', { query: 'trần cọc' })).length > 0; } },
  { name: 'reservation_settlements: người nộp không nối được hồ sơ khách ⇒ NULL', base: fixes, sql: replaceRead(`        'payerName',NULL,
        'depositAmount',to_jsonb(`, `        'payerName',CASE WHEN (e->>'buildingId')::uuid=ANY(v_cust) THEN to_jsonb(e->>'payerName') ELSE 'null'::jsonb END,
        'depositAmount',to_jsonb(`),
    run: async env => { await hideOwners(env); return (await rowsOf(env, 'reservation_settlements')).some(row => row.payerName !== null); } },
  { name: 'change_ledger: người nộp/ghi chú cần hồ sơ khách nhìn thấy dưới RLS', base: fixes, sql: replaceRead(`CROSS JOIN LATERAL (SELECT l.building_id=ANY(v_cust) AND EXISTS(
          SELECT 1 FROM public.income_expenses src LEFT JOIN public.invoices inv ON inv.id=src.invoice_id
            JOIN public.contract_customers cc ON cc.contract_id=COALESCE(src.contract_id,inv.contract_id)
            JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=v_org
          WHERE src.id=l.voucher_id) linked) k) x;`, `CROSS JOIN LATERAL (SELECT l.building_id=ANY(v_cust) linked) k) x;`),
    run: async env => { await hideOwners(env); return (await rowsOf(env, 'change_ledger')).some(row => row.payerName !== null || row.notes !== null); } },
  { name: 'change_ledger: hồ sơ khách nối được phải cùng công ty', base: fixes, sql: replaceRead(`JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=v_org`,
    `JOIN public.customers cu ON cu.id=cc.customer_id`),
    run: async env => { await env.db.exec(`UPDATE public.customers SET organization_id='${FOREIGN}' WHERE organization_id='${ORG}'`);
      return (await rowsOf(env, 'change_ledger')).some(row => row.payerName !== null); } },
  // [P1 review #207] Ghi chú hoá đơn / tên phiếu: cùng điều kiện tên khách (customers.view ở toà + hồ sơ khách nhìn thấy).
  { name: 'invoice_detail: ghi chú hoá đơn theo hồ sơ khách', base: fixes, sql: replaceRead(
    `'notes',CASE WHEN v_inv_cust THEN to_jsonb(v_head->>'notes') ELSE 'null'::jsonb END,`, `'notes',to_jsonb(v_head->>'notes'),`),
    run: async env => (await direct(env, 'invoice_detail', {}, { scopes: {} })).summary.notes !== null },
  { name: 'invoice_detail: tên phiếu theo hồ sơ khách', base: fixes, sql: replaceRead(
    `'label',CASE WHEN v_inv_cust THEN to_jsonb(e->>'name') ELSE 'null'::jsonb END,`, `'label',to_jsonb(e->>'name'),`),
    run: async env => (await rowsOf(env, 'invoice_detail', {}, { scopes: {} })).some(row => row.kind === 'voucher' && row.label !== null) },
  { name: 'invoice_detail: hồ sơ khách nhìn thấy, không chỉ customers.view ở toà', base: fixes, sql: replaceRead(
    `v_inv_cust:=(v_head->>'buildingId')::uuid=ANY(v_cust) AND v_head->>'customerId' IS NOT NULL;`, `v_inv_cust:=(v_head->>'buildingId')::uuid=ANY(v_cust);`),
    run: async env => { await hideOwners(env); return (await direct(env, 'invoice_detail')).summary.notes !== null; } },
  // [P2 review #207] Trần 2000: cắt toàn bộ phần sau 2000, không chỉ một phần tử.
  { name: 'trần 2000: cắt toàn bộ phần sau 2000', base: fixes, sql: replaceRead(`  IF jsonb_array_length(v_rows)>2000 THEN
    v_rows:=(SELECT jsonb_agg(e ORDER BY n) FROM jsonb_array_elements(v_rows) WITH ORDINALITY a(e,n) WHERE n<=2000);
  END IF;`, `  IF jsonb_array_length(v_rows)>2000 THEN v_rows:=v_rows-2000; END IF;`),
    run: async env => { await env.db.exec(`INSERT INTO public.invoice_items(invoice_id,type,description,amount,sort_order)
      SELECT '${INVOICE_A}','SERVICE','Dòng '||n,1,100+n FROM generate_series(1,2001) n`);
      return (await rowsOf(env, 'invoice_detail')).length > 2000; } },
  { name: 'reservation_settlements: truyền trạng thái hoàn', base: fixes, sql: replaceRead(`get_reservation_settlements_v1(v_b,v_status,v_cursor,200,NULL)`,
    `get_reservation_settlements_v1(v_b,NULL,v_cursor,200,NULL)`),
    run: async env => ids(await rowsOf(env, 'reservation_settlements', { status: 'PENDING' }), 'settlementId').includes(S1) },
  { name: 'held_deposits: chỉ HĐ hiệu lực', sql: replaceExactly(`c.status::text='ACTIVE' AND c.deleted_at IS NULL`, `c.deleted_at IS NULL`),
    run: async env => ids(await rowsOf(env, 'held_deposits'), 'contractId').includes(CONTRACT_TERM) },
  { name: 'deposit_refunds: chỉ phiếu đã vào sổ', sql: replaceExactly(`AND ie.approval_status='APPROVED' AND ie.posting_status='POSTED' AND`, `AND ie.approval_status='APPROVED' AND`),
    run: async env => (await rowsOf(env, 'deposit_refunds')).find(row => row.terminationId === T1).postedRefund !== '1500000.00' },
  { name: 'deposit_refunds: toà trong hàm dùng chung', sql: replaceExactly(`WHERE t.organization_id=p_organization_id AND r.building_id=ANY(v_b);`,
    `WHERE t.organization_id=p_organization_id;`),
    run: async env => (await sharedFn(env, 'public.deposit_refunds_forfeits_v1($1,$2)', [ORG, [BUILDING]])).some(row => row.termination_id === T3) },
  { name: 'change_ledger: sổ phải nhìn thấy như web', base: fixes, sql: replaceRead(`    IF NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=v_target AND a.organization_id=v_org AND a.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501';
    END IF;
`, ''),
    run: async env => Array.isArray((await direct(env, 'change_ledger', { cashbookId: OTHER_BOOK })).rows) },
  { name: 'read: giao thêm buildings.view như RLS web', base: fixes, sql: replaceRead(`jsonb_array_elements_text(p_ctx->'buildings') x
    WHERE public.has_full_building_scope() OR x::uuid IN (SELECT public.accessible_building_ids());`, `jsonb_array_elements_text(p_ctx->'buildings') x;`),
    run: async env => { await env.db.exec(`DELETE FROM public.fixture_building_access WHERE building_id='${BUILDING}'`);
      return (await direct(env, 'overpayment')).unavailable === null; } },
  { name: 'read: chỉ đúng người hỏi', base: fixes, sql: replaceRead(`  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  v_org:=`, `  v_org:=`),
    run: async env => Array.isArray((await direct(env, 'overpayment', {}, { userId: CUSTOMER_C })).rows) },
];
for (const probe of probes) {
  const changed = changedFunctions(probe.base ?? migration, probe.sql);
  assert.equal(changed.length, 1, `${probe.name}: đúng một hàm đổi`);
  test(`mutation is caught: ${probe.name}`, { timeout: 120000 }, async () => {
    await inCase(async env => assert.equal(await probe.run(env).catch(() => false), false, 'bản sống từ chối'));
    await inCase(async env => {
      for (const sql of changed) await env.db.exec(sql);
      assert.equal(await probe.run(env), true, 'bản đột biến lọt');
    });
  });
}
