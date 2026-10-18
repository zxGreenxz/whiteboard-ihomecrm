import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedW2b, FOREIGN_ORG_BOOK, OWNER_BOOK, SH_ME, SH_OTHER, OTHER_USER, EVENT_1, EVENT_2, WALLET, WALLET_HIDDEN, VIRTUAL } from './wave2-b-sql-fixture.mjs';
import { assertPackageParity, grantRead, BUILDING, OTHER_BUILDING, ORG_SCOPE, USER, ORG, FOREIGN } from './wave2-sql-fixture.mjs';
import { CASHBOOK, FOREIGN_CASHBOOK, CATEGORY, RESTRICTED_CATEGORY } from './finance-fixture.mjs';
import { changedFunctions } from './full-read-sql-fixture.mjs';
import { W2 } from './wave2-registry.mjs';
import { W2B_REPORTS } from './wave2-b-contract.mjs';
import { w2CatalogEntry } from './wave2-kit.mjs';

// Gói B đợt 2 — test RIÊNG của Gói B. MỘT PGlite cho cả file, mỗi ca BEGIN … ROLLBACK. Mọi báo cáo đi đúng đường thật:
// lối vào INVOKER public.hermes_w2_read_v1 dưới vai authenticated (cổng Gói 0: kiểm quyền DEFINER → hàm đọc gói
// INVOKER dưới RLS → kết thúc DEFINER rào đầu ra) rồi rào đầu ra của broker. Mỗi báo cáo: số khớp RPC/hàm web gọi
// trực tiếp như người dùng (vai authenticated, cùng tham số/toà), có/không khoá, khác công ty, toà ∩ overlay, sổ quỹ
// chỉ trong sổ nhìn thấy (chặt hơn web ở chốt sổ), phiếu/hạng mục hạn chế, riêng tư (cổ đông, ví, biến động số dư) và
// đột biến SQL trên hàng rào riêng của gói (rào toà của hàng đã do bước kết thúc của cổng chặn). Dữ liệu tổng hợp; RPC
// web là định nghĩa thật (trừ cụm Hiệu quả kinh doanh: cổng tổng hợp cùng chữ ký — xem wave2-b-sql-fixture.mjs).
const MAIN_PATH = 'supabase/migrations/20261018020200_hermes_w2b_finance_read_v1.sql';
// Hàm dùng chung CRM nằm ở file riêng (nội dung không nhắc trợ lý); test xét hai file như một khối của gói.
const SHARED_PATH = 'supabase/migrations/20261018020050_hermes_w2b_finance_shared_v1.sql';
// Sửa sau review PR #208: thay bản định nghĩa của hai file trên (áp sau, hai file kia giữ nguyên) — hàm dùng chung (file riêng,
// không nhắc hàm của trợ lý) rồi hàm đọc gói.
const SHARED_FIX_PATH = 'supabase/migrations/20261018020250_hermes_w2b_finance_shared_fixes_v1.sql';
const MAIN_FIX_PATH = 'supabase/migrations/20261018020300_hermes_w2b_finance_read_fixes_v1.sql';
const sharedFix = readFileSync(SHARED_FIX_PATH, 'utf8'), mainFix = readFileSync(MAIN_FIX_PATH, 'utf8');
const main = [readFileSync(SHARED_PATH, 'utf8'), readFileSync(MAIN_PATH, 'utf8'), sharedFix, mainFix].join('\n');
// Bản SỐNG: định nghĩa CUỐI của từng hàm theo thứ tự áp. Đột biến đo trên đây — đột biến bản đã bị thay sẽ đè bản sống
// bằng một bản cũ, đo sai thứ.
const live = (() => {
  const last = new Map();
  for (const [sql] of main.matchAll(/CREATE OR REPLACE FUNCTION[\s\S]*?\$fn\$;/g)) last.set(sql.match(/^CREATE OR REPLACE FUNCTION ([a-z_]+\.[a-z0-9_]+)\(/)[1], sql);
  return [...last.values()].join('\n\n');
})();
let shared;
before(async () => { shared = await sharedW2b(); });
after(async () => { await shared?.close(); });
const inCase = work => shared.isolated(work);
const code = expected => error => error.code === expected;
const sorted = values => [...values].sort();
const stripComments = sql => sql.replace(/--[^\n]*/g, '');
const RESTRICTED = 'income_expenses.restricted_view';
const block = (sql, name) => {
  const found = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}\\([\\s\\S]*?\\$fn\\$;`, 'g'));
  assert.ok(found, name); return found.at(-1);
};

// Broker → SQL → broker: tham số chuẩn hoá bằng khai báo JS; kết quả (kèm fence của cổng) qua rào của broker. Phạm vi
// CRM của khoá trong ảnh chụp broker = mọi toà của công ty (cổng SQL thu hẹp theo overlay; broker kiểm fence ⊆ đó).
const identity = permission => ({ row: { organizationId: ORG }, effective: { read: [permission], action: [] },
  scopesByPermission: { [permission]: { buildingIds: [BUILDING, OTHER_BUILDING, VIRTUAL], cashbookIds: [] } } });
async function run(env, report, params = {}, { limit = 50, offset = 0, actor = USER } = {}) {
  const input = W2.reads.report.input({ report, params, limit, offset });
  const value = await env.report(report, input.params, { limit, offset }, undefined, { actor });
  return W2.reads.report.result(value, identity(W2B_REPORTS[report].permission), input);
}
async function all(env, report, params = {}) {
  const items = []; let offset = 0, last;
  do { last = await run(env, report, params, { offset }); items.push(...last.items); offset = last.nextOffset; } while (offset !== null);
  return { ...last, items };
}
async function orgOverlay(db, on = true) {
  for (const table of ['hermes_connections', 'hermes_org_policies'])
    await db.query(on ? `UPDATE app_private.${table} SET scope_ids=array_append(scope_ids,$1::uuid)` : `UPDATE app_private.${table} SET scope_ids=array_remove(scope_ids,$1::uuid)`, [ORG_SCOPE]);
}
// Gọi RPC/hàm web như người dùng: vai authenticated + jwt sub = USER (bảng chịu RLS cổng tổng hợp).
const web = (env, sql, args = [], actor = USER) => env.call(`SELECT (${sql}) result`, args, { role: 'authenticated', actor });
const webRows = (env, sql, args = [], actor = USER) => env.call(`SELECT COALESCE(jsonb_agg(to_jsonb(x)),'[]'::jsonb) result FROM (${sql}) x`, args, { role: 'authenticated', actor });
const num = value => Number(value);
// Người hỏi thuộc thêm công ty khác (web lọc my_org_ids() ⇒ trộn hai công ty). Chỉ đổi my_org_ids: cổng Hermes từ chối
// người có hai membership thường (hermes_ordinary_org_ambiguous), còn RPC web/RLS chỉ đọc my_org_ids().
const secondOrg = db => db.exec(`CREATE OR REPLACE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$
    SELECT CASE WHEN auth.uid()='${USER}'::uuid THEN ARRAY['${ORG}'::uuid,'${FOREIGN}'::uuid] ELSE '{}'::uuid[] END$$;`);
// Quyền CRM thuần (không phải khoá đọc của Hermes — không đụng registry/kết nối): toàn công ty hoặc chỉ toà A.
const crmGrant = (permission, orgWide = true) => `INSERT INTO public.fixture_acl(permission,allowed,org_wide,building_ids)
  VALUES('${permission}',true,${orgWide},${orgWide ? "'{}'::uuid[]" : `ARRAY['${BUILDING}'::uuid]`})
  ON CONFLICT(permission) DO UPDATE SET allowed=true,org_wide=EXCLUDED.org_wide,building_ids=EXCLUDED.building_ids`;
// 101 phiếu chi hạn chế của người khác, lớn hơn mọi phiếu hợp lệ của toà A (PC-402 5tr + 100 phiếu ~10tr).
const restrictedAhead = db => db.exec(`INSERT INTO public.income_expenses(organization_id,user_id,code,type,name,building_id,voucher_date,total_amount,
    approval_status,kqkd_amount,has_restricted_item)
  SELECT '${ORG}','${OTHER_USER}','PC-R'||lpad(g::text,3,'0'),'EXPENSE','Lương '||g,'${BUILDING}','2026-10-15',10000000+g,'APPROVED',10000000+g,true
  FROM generate_series(1,100) g`);
const extraWallets = (db, n) => db.exec(`INSERT INTO public.personal_wallets(id,user_id,name,kind,opening_balance)
  SELECT gen_random_uuid(),'${USER}','Ví '||lpad(g::text,4,'0'),'cash',1 FROM generate_series(1,${n}) g`);

test('gói B: bảng báo cáo SQL (hermes_w2b_catalog_v1) khớp khai báo JS (W2B_REPORTS)', () => shared.isolated(env => assertPackageParity(env, 'b')));

const SHARED = ['public.cashbook_daily_v1', 'public.cashbook_cash_flow_v1', 'public.cashbook_list_v1', 'public.cashbook_closings_v1',
  'public.finance_analysis_type_breakdown_v1', 'public.finance_analysis_top_expenses_v1', 'public.finance_analysis_top_expenses_v2', 'public.profit_my_share_v1',
  'public.profit_shareholder_summary_v1', 'public.report_text_v1'];
test('cấu trúc: hàm đọc gói INVOKER (pg_catalog,public) không gọi app_private; hàm dùng chung INVOKER search_path rỗng tự từ chối ngoài vai authenticated; hai helper DEFINER nhỏ (phạm vi của chính người gọi, cờ hạn chế của hạng mục)', () => inCase(async ({ db }) => {
  const created = sql => [...new Set([...stripComments(sql).matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+\.[a-z0-9_]+)\(/g)].map(match => match[1]))];
  const mine = created(main);
  assert.deepEqual(sorted(mine), sorted([...SHARED, 'public.finance_my_scope_v1', 'public.finance_type_restricted_v1',
    'app_private.hermes_w2b_catalog_v1', 'app_private.hermes_w2b_read_v1']));
  // Hai file sửa sau review chỉ THAY định nghĩa của gói (hàm mới duy nhất: hàm dùng chung _v2); file hàm dùng chung không nêu
  // hàm của trợ lý (như 20261018020050).
  assert.deepEqual(sorted(created(sharedFix)), sorted(['public.finance_my_scope_v1', 'public.finance_type_restricted_v1', 'public.report_text_v1',
    'public.finance_analysis_top_expenses_v2', 'public.finance_analysis_top_expenses_v1', 'public.profit_shareholder_summary_v1']));
  assert.doesNotMatch(sharedFix, /\bhermes_/i);
  assert.deepEqual(created(mainFix), ['app_private.hermes_w2b_read_v1']);
  assert.doesNotMatch(main, /copilot/i, 'không có chữ của trợ lý cũ');
  assert.doesNotMatch(stripComments(main), /\bDROP\b|ALTER TABLE|INSERT INTO|UPDATE public|DELETE FROM|hermes_capabilities SET/i);
  const reader = stripComments(block(main, 'app_private.hermes_w2b_read_v1'));
  assert.match(reader, /LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS/);
  assert.doesNotMatch(reader.replace(/^CREATE OR REPLACE FUNCTION app_private\.hermes_w2b_read_v1/, ''), /app_private\./, 'thân không gọi app_private.*');
  for (const name of SHARED) assert.doesNotMatch(stripComments(block(main, name)), /app_private\./, `${name}: không gọi app_private`);
  const procs = (await db.query(`SELECT n.nspname||'.'||p.proname name,p.prosecdef definer,p.proconfig config,
      has_function_privilege('authenticated',p.oid,'EXECUTE') auth,has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('service_role',p.oid,'EXECUTE') service FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname||'.'||p.proname=ANY($1)`, [mine])).rows;
  assert.equal(procs.length, mine.length);
  const expected = { 'public.finance_my_scope_v1': [true, 'search_path=pg_catalog, public, app_private'],
    'public.finance_type_restricted_v1': [true, 'search_path=pg_catalog, public'],
    'app_private.hermes_w2b_catalog_v1': [true, 'search_path=pg_catalog, app_private'], 'app_private.hermes_w2b_read_v1': [false, 'search_path=pg_catalog, public'],
    ...Object.fromEntries(SHARED.map(name => [name, [false, 'search_path=""']])) };
  for (const proc of procs) {
    assert.deepEqual([proc.definer, proc.config.join(',').replace(/,\s*/g, ', ')], expected[proc.name], proc.name);
    // authenticated: hàm dùng chung + helper + hàm đọc (cổng nền cấp); bảng gom giữ ACL của nền.
    assert.deepEqual([proc.auth, proc.anon, proc.service], [proc.name !== 'app_private.hermes_w2b_catalog_v1', false, false], proc.name);
  }
  // Hàm dùng chung tự từ chối khi KHÔNG chạy dưới vai authenticated (vd. bị một hàm DEFINER gọi: bỏ qua RLS).
  for (const sql of ['SELECT count(*) FROM public.cashbook_list_v1($1::uuid)', 'SELECT count(*) FROM public.finance_analysis_top_expenses_v1($1::uuid,current_date,current_date)',
    'SELECT count(*) FROM public.finance_analysis_top_expenses_v2($1::uuid,current_date,current_date)', "SELECT public.report_text_v1('x',10)",
    'SELECT public.profit_my_share_v1($1::uuid)', 'SELECT public.profit_shareholder_summary_v1($1::uuid)',
    "SELECT count(*) FROM public.cashbook_daily_v1($1::uuid,'2026-10-01','2026-10-02')", 'SELECT count(*) FROM public.cashbook_cash_flow_v1($1::uuid,2026)',
    'SELECT count(*) FROM public.cashbook_closings_v1($1::uuid)', "SELECT public.finance_analysis_type_breakdown_v1($1::uuid,'2026-10-01','2026-10-02')"]) {
    await db.exec('SAVEPOINT role_check');
    const failed = await db.exec(`SELECT set_config('request.jwt.claim.sub','${USER}',true); ${sql.replace('$1', `'${ORG}'`)}`).then(() => null, error => error);
    await db.exec('ROLLBACK TO SAVEPOINT role_check; RELEASE SAVEPOINT role_check');
    assert.equal(failed?.code, '42501', sql);
  }
}));

test('mục lục: MỌI báo cáo gói B là private (số liệu tài chính nội bộ) — khai báo JS và mục lục crm_read_report_list', () => inCase(async env => {
  const { db } = env;
  assert.equal(Object.keys(W2B_REPORTS).length, 19);
  for (const [report, spec] of Object.entries(W2B_REPORTS)) {
    assert.equal(spec.private, true, report);
    assert.equal(w2CatalogEntry(report, spec, 'b').private, true, report);
  }
  const keys = [...new Set(Object.values(W2B_REPORTS).map(spec => spec.permission))];
  await grantRead(db, keys);
  await db.exec(`INSERT INTO public.super_admins VALUES('${USER}')`);
  const input = W2.reads.report_list.input({ topic: 'tai_chinh' });
  const listed = W2.reads.report_list.result(await env.reportList(input.topic), { effective: { read: keys, action: [] } }, input).items;
  assert.deepEqual(sorted(listed.map(entry => entry.report)), sorted(Object.keys(W2B_REPORTS)), 'mục lục đủ 19 báo cáo khi đủ khoá');
  assert.ok(listed.every(entry => entry.private === true), 'mọi mục private=true');
}));

test('report_text_v1: cùng công thức chữ an toàn (giữ xuống dòng, bỏ ký tự điều khiển, cắt theo ký tự) dưới vai authenticated', () => inCase(async env => {
  const text = (value, max) => web(env, 'public.report_text_v1($1::text,$2::integer)', [value, max]);
  const raw = `  a\r\nb c\u0007d\u009f  `;
  assert.deepEqual([await text(raw, 100), await text(raw, 3), await text(null, 5), await text('abc', -1)], ['a\nb\ncd', 'a\nb', null, '']);
}));

test('cờ hạn chế (DEFINER) chỉ trả lời cho hạng mục thuộc công ty của chính người gọi: id công ty khác hoặc id lạ ⇒ NULL', () => inCase(async env => {
  const { db } = env;
  const FOREIGN_TYPE = '0b0b0b0b-0000-4000-8000-000000000901', UNKNOWN_TYPE = '0b0b0b0b-0000-4000-8000-000000000902';
  await db.exec(`INSERT INTO public.income_expense_types(id,organization_id,type,name,is_restricted) VALUES('${FOREIGN_TYPE}','${FOREIGN}','expense','Lương công ty khác',true)`);
  const flag = (typeId, merged = true, actor = USER) => web(env, 'public.finance_type_restricted_v1($1::uuid,$2::boolean)', [typeId, merged], actor);
  assert.deepEqual([await flag(RESTRICTED_CATEGORY), await flag(CATEGORY), await flag(FOREIGN_TYPE), await flag(UNKNOWN_TYPE)], [true, false, null, null]);
  assert.equal(await flag(RESTRICTED_CATEGORY, true, OTHER_USER), null, 'người gọi không thuộc công ty của hạng mục (my_org_ids của fixture rỗng) ⇒ NULL');
  // Hạng mục hạn chế gộp vào hạng mục thường: chỉ khi hỏi kèm nguồn gộp (chế độ cash).
  await db.exec(`UPDATE public.income_expense_types SET merged_into_id='${CATEGORY}' WHERE id='${RESTRICTED_CATEGORY}'`);
  assert.deepEqual([await flag(CATEGORY, true), await flag(CATEGORY, false)], [true, false]);
  // Phạm vi = my_org_ids(): người hỏi thuộc thêm công ty kia thì được trả lời cho hạng mục của công ty đó.
  await secondOrg(db);
  assert.equal(await flag(FOREIGN_TYPE), true);
}));

test('B1 sổ quỹ theo ngày = RPC web cashbook_opening_balance + cashflow_by_day (từng toà khi kết nối theo toà; một chuỗi "Tất cả" khi Toàn tổ chức)', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await grantRead(db, ['reports_finance.daily_cashbook'], { orgWide: true });
  const range = { fromDate: '2026-10-01', toDate: '2026-10-12' };
  let value = await all(env, 'cashbook_daily', range);
  const webOpeningA = num(await web(env, 'public.cashbook_opening_balance($1::date,$2::uuid,NULL)', [range.fromDate, BUILDING]));
  const webDaysA = await webRows(env, 'SELECT * FROM public.cashflow_by_day($1::date,$2::date,$3::uuid,NULL)', [range.fromDate, range.toDate, BUILDING]);
  assert.deepEqual([webOpeningA, webDaysA.map(row => [row.day, num(row.income), num(row.expense)])],
    [540000, [['2026-10-02', 1200000, 0], ['2026-10-10', 0, 50000]]], 'web: toà A, bút toán REVERSAL tính, OTHER không');
  assert.equal(value.items.length, 12, 'mỗi ngày một dòng như web, ngày không phát sinh = 0');
  assert.ok(value.items.every(row => row.buildingId === BUILDING), 'kết nối chỉ toà A: chuỗi của toà A');
  assert.deepEqual(value.summary, { fromDate: '2026-10-01', toDate: '2026-10-12', cashbookId: null, openingBalance: '540000.00', totalIncome: '1200000.00',
    totalExpense: '50000.00', closingBalance: '1690000.00' });
  const day = date => value.items.find(row => row.date === date);
  assert.deepEqual(day('2026-10-02'), { buildingId: BUILDING, date: '2026-10-02', opening: '540000.00', income: '1200000.00', expense: '0', closing: '1740000.00' });
  assert.equal(day('2026-10-12').closing, '1690000.00');
  // Toàn tổ chức + khoá toàn công ty: như "Tất cả" của web (gồm bút toán không gắn toà).
  await orgOverlay(db);
  value = await all(env, 'cashbook_daily', range);
  const webOpening = num(await web(env, 'public.cashbook_opening_balance($1::date,NULL,NULL)', [range.fromDate]));
  const webTotals = await web(env, 'public.cashbook_period_totals($1::date,$2::date,NULL,NULL)', [range.fromDate, range.toDate]);
  assert.deepEqual([num(value.summary.openingBalance), num(value.summary.totalIncome), num(value.summary.totalExpense)],
    [webOpening, num(webTotals.income), num(webTotals.expense)]);
  assert.deepEqual([webOpening, num(webTotals.income), num(webTotals.expense)], [540000, 1300000, 350000]);
  assert.ok(value.items.every(row => row.buildingId === null) && value.items.length === 12, 'một chuỗi buildingId null');
  value = await all(env, 'cashbook_daily', { ...range, buildingId: OTHER_BUILDING });
  assert.deepEqual([value.summary.totalIncome, value.summary.totalExpense, value.items[0].buildingId], ['0', '300000.00', OTHER_BUILDING], 'buildingId thu hẹp về một toà');
  // Sổ người khác: không nhìn thấy (RLS) ⇒ 42501; được giao giữ sổ ⇒ có, như web.
  await assert.rejects(run(env, 'cashbook_daily', { ...range, cashbookId: FOREIGN_CASHBOOK }), code('42501'));
  await db.exec(`INSERT INTO public.cashbook_possession_bindings(organization_id,cashbook_id,membership_id,possession_kind) VALUES('${ORG}','${FOREIGN_CASHBOOK}','${USER}','OPERATOR')`);
  value = await all(env, 'cashbook_daily', { ...range, cashbookId: FOREIGN_CASHBOOK });
  assert.deepEqual([value.summary.cashbookId, value.summary.totalIncome], [FOREIGN_CASHBOOK, '700000.00']);
  assert.equal((await all(env, 'cashbook_daily', range)).summary.totalIncome, '2000000.00', '"Tất cả" gồm sổ được giữ');
  // Mặc định đầu tháng → hôm nay (org_today = 16/10); khoảng > 366 ngày ⇒ 22023.
  value = await all(env, 'cashbook_daily');
  assert.deepEqual([value.items.length, value.summary.fromDate], [16, '2026-10-01']);
  await assert.rejects(run(env, 'cashbook_daily', { fromDate: '2025-01-01' }), code('22023'));
}));

test('B1/B2: người nhiều công ty — RPC web (lọc my_org_ids) trộn công ty khác, Hermes gọi từng sổ của ĐÚNG công ty kết nối', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await grantRead(db, ['reports_finance.daily_cashbook', 'reports_finance.cash_flow'], { orgWide: true });
  await orgOverlay(db);
  await secondOrg(db);
  const range = { fromDate: '2026-10-01', toDate: '2026-10-12' };
  const webMixed = await web(env, 'public.cashbook_period_totals($1::date,$2::date,NULL,NULL)', [range.fromDate, range.toDate]);
  assert.equal(num(webMixed.income), 1309999, 'web "Tất cả" cộng cả sổ của công ty khác');
  assert.equal((await all(env, 'cashbook_daily', range)).summary.totalIncome, '1300000.00', 'Hermes chỉ công ty của kết nối');
  await assert.rejects(run(env, 'cashbook_daily', { ...range, cashbookId: FOREIGN_ORG_BOOK }), code('42501'), 'sổ công ty khác (cổng chặn)');
  assert.equal((await all(env, 'cash_flow', { year: 2026 })).summary.income, '1840000.00');
}));

test('B2 dòng tiền năm = cashflow_by_day cả năm gộp 12 tháng + 4 quý như CashFlowReport', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await grantRead(db, ['reports_finance.cash_flow'], { orgWide: true });
  await orgOverlay(db);
  const value = await all(env, 'cash_flow', { year: 2026 });
  const webDays = await webRows(env, "SELECT * FROM public.cashflow_by_day('2026-01-01','2026-12-31',NULL,NULL)");
  const byMonth = Array.from({ length: 12 }, (_, i) => webDays.filter(row => Number(row.day.slice(5, 7)) === i + 1)
    .reduce((sum, row) => [sum[0] + num(row.income), sum[1] + num(row.expense)], [0, 0]));
  assert.deepEqual(value.items.slice(0, 12).map(row => [row.buildingId, row.period, num(row.income), num(row.expense), num(row.net)]),
    byMonth.map(([income, expense], i) => [null, `2026-${String(i + 1).padStart(2, '0')}`, income, expense, income - expense]));
  assert.deepEqual(value.items.slice(12).map(row => [row.period, num(row.income), num(row.expense)]),
    [['2026-Q1', 40000, 0], ['2026-Q2', 0, 0], ['2026-Q3', 500000, 0], ['2026-Q4', 1300000, 350000]]);
  assert.deepEqual(value.summary, { year: 2026, income: '1840000.00', expense: '350000.00', net: '1490000.00' });
  assert.equal((await all(env, 'cash_flow')).summary.year, 2026, 'mặc định năm của hôm nay');
  await orgOverlay(db, false);
  const perBuilding = await all(env, 'cash_flow', { year: 2026 });
  assert.deepEqual([perBuilding.items.length, [...new Set(perBuilding.items.map(row => row.buildingId))], perBuilding.summary.income],
    [16, [BUILDING], '1740000.00'], 'kết nối toà A: chuỗi toà A, không gồm bút toán không gắn toà');
  await db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='reports_finance.cash_flow'");
  await assert.rejects(run(env, 'cash_flow', { year: 2026 }), code('42501'), 'không còn quyền CRM');
}));

test('B3 sổ quỹ = hàm dùng chung cashbook_list_v1 dưới RLS: sổ nhìn thấy của đúng công ty, tồn chỉ khi balanceVisible, không số tài khoản', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await grantRead(db, ['cashbooks.view'], { orgWide: true });
  assert.equal((await run(env, 'cashbooks')).unavailable, 'organization_scope_required', 'sổ quỹ: cần Toàn tổ chức hoặc sổ CRM cấp');
  await orgOverlay(db);
  let value = await all(env, 'cashbooks');
  assert.deepEqual(value.items, [{ cashbookId: CASHBOOK, code: 'TM01', name: 'Quỹ VCB 0123456789', ownerName: 'Chủ Sổ', isVirtual: false, balanceVisible: true,
    initialAmount: '1000000.00', currentAmount: '2490000.00', note: 'Quỹ tiền mặt' }], 'chỉ sổ của mình (RLS accounts)');
  assert.doesNotMatch(JSON.stringify(value), /bank|accountNumber|VCB"/i, 'không trường số tài khoản/ngân hàng');
  const webList = await webRows(env, 'SELECT cashbook_id,current_amount FROM public.cashbook_list_v1($1::uuid)', [ORG]);
  assert.deepEqual(webList.map(row => [row.cashbook_id, num(row.current_amount)]), [[CASHBOOK, 2490000]], 'web gọi cùng hàm');
  // Chủ công ty đọc mọi sổ của công ty (accounts_select_company_owner); sổ công ty khác không bao giờ.
  await db.exec(`INSERT INTO public.fixture_company_owners VALUES('${ORG}','${USER}')`);
  await secondOrg(db);
  value = await all(env, 'cashbooks');
  assert.deepEqual(sorted(value.items.map(row => row.cashbookId)), sorted([CASHBOOK, FOREIGN_CASHBOOK, OWNER_BOOK]));
  assert.deepEqual((await all(env, 'cashbooks', { query: 'nh01' })).items.map(row => row.code), ['NH01']);
  // Công ty chạy đọc chuẩn (CANONICAL): tồn chỉ cho người giữ sổ (CUSTODIAN) như list_cashbook_visibility_v2.
  await db.exec(`INSERT INTO app_private.server_feature_flags(feature_key,mode) VALUES('income_expense.read_semantics.v2','ON')`);
  value = await all(env, 'cashbooks');
  assert.ok(value.items.every(row => row.balanceVisible === false && row.initialAmount === null && row.currentAmount === null));
  await db.exec(`INSERT INTO public.cashbook_possession_bindings(organization_id,cashbook_id,membership_id,possession_kind) VALUES('${ORG}','${OWNER_BOOK}','${USER}','CUSTODIAN')`);
  assert.deepEqual((await all(env, 'cashbooks')).items.filter(row => row.balanceVisible).map(row => row.cashbookId), [OWNER_BOOK]);
  // Khoá web cashbooks.view: cổng kiểm, và hàm dùng chung tự kiểm khi web gọi thẳng.
  await db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='cashbooks.view'");
  await assert.rejects(run(env, 'cashbooks'), code('42501'));
  await assert.rejects(web(env, 'SELECT count(*) FROM public.cashbook_list_v1($1::uuid)', [ORG]), code('42501'));
}));

test('B4 chốt sổ: web list_cashbook_closings_v1 lộ chênh lệch MỌI sổ cho mọi thành viên; Hermes chỉ sổ người hỏi nhìn thấy', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await grantRead(db, ['cashbooks.view'], { orgWide: true });
  await orgOverlay(db);
  const webAll = await web(env, 'public.list_cashbook_closings_v1(NULL)');
  assert.deepEqual(sorted(webAll.closures.map(row => row.cashbook_id)), sorted([CASHBOOK, FOREIGN_CASHBOOK]), 'web: lộ sổ người khác (lỗ hổng ghi nhận)');
  const value = await all(env, 'cashbook_closings');
  assert.deepEqual(value.items.map(row => [row.state, row.cashbookId, row.difference, row.mineToConfirm]),
    [['PENDING', CASHBOOK, '-10000.00', true], ['CONFIRMED', CASHBOOK, '-10000.00', false]]);
  const closure = value.items[1];
  assert.deepEqual([closure.closedThrough, closure.countedBalance, closure.systemBalance, closure.proposedByName, closure.confirmerName, closure.confirmedAt,
    closure.basis, typeof closure.closureId], ['2026-09-30', '1490000.00', '1500000.00', 'Chủ Sổ', 'Kế toán B', '2026-10-01T02:00:00.000Z', 'POSTING_TRUTH_BY_POSTED_ON', 'number']);
  assert.equal(value.items[0].note, 'thiếu 10k');
  assert.deepEqual((await all(env, 'cashbook_closings', { status: 'CONFIRMED' })).items.map(row => row.state), ['CONFIRMED']);
  assert.deepEqual((await all(env, 'cashbook_closings', { cashbookId: FOREIGN_CASHBOOK })).items, [], 'sổ không nhìn thấy: không biên bản nào');
  await db.exec(`INSERT INTO public.fixture_company_owners VALUES('${ORG}','${USER}')`);
  assert.equal((await all(env, 'cashbook_closings')).items.length, 4, 'chủ công ty thấy mọi sổ ⇒ mọi biên bản');
}));

test('B7 hạng mục thu/chi = fa_type_breakdown(_accrual) web trên toà kết nối; hạng mục HẠN CHẾ chỉ khi restricted_view phủ mọi toà (chặt hơn web)', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  const range = { fromDate: '2026-10-01', toDate: '2026-10-31' };
  const project = rows => rows.map(row => [row.month, row.side, row.typeName, num(row.totalAmount), row.voucherCount]);
  const webBreak = async (fn, buildings) => (await webRows(env, `SELECT * FROM public.${fn}($1::date,$2::date,$3::uuid[]) ORDER BY 1,2,6 DESC,4`,
    [range.fromDate, range.toDate, buildings])).map(row => [row.month, row.side, row.type_name, num(row.total_amount), Number(row.voucher_count)]);
  let value = await all(env, 'fa_type_breakdown', { ...range, basis: 'cash' });
  const webCash = await webBreak('fa_type_breakdown', [BUILDING]);
  assert.deepEqual(webCash, [['2026-10-01', 'EXPENSE', 'Lương', 5300000, 2], ['2026-10-01', 'EXPENSE', 'Sửa chữa', 800000, 1]], 'web lộ tổng Lương (hạn chế)');
  assert.deepEqual([project(value.items), value.items[0].buildingId], [[['2026-10-01', 'EXPENSE', 'Sửa chữa', 800000, 1]], BUILDING]);
  assert.deepEqual(value.summary, { basis: 'cash', restrictedIncluded: false });
  await grantRead(db, [RESTRICTED]);
  value = await all(env, 'fa_type_breakdown', { ...range, basis: 'cash' });
  assert.deepEqual([project(value.items), value.summary.restrictedIncluded], [webCash, true], 'đủ quyền ⇒ đúng bằng web');
  value = await all(env, 'fa_type_breakdown', range);
  assert.deepEqual([project(value.items), value.summary.basis], [await webBreak('fa_type_breakdown_accrual', [BUILDING]), 'accrual'], 'mặc định dồn tích như web');
  // Toàn tổ chức nhưng restricted_view chỉ ở toà A ⇒ không phủ toà B ⇒ ẩn hạng mục hạn chế (khoá analysis theo toà ⇒ từng toà).
  await orgOverlay(db);
  await db.exec(`UPDATE public.fixture_acl SET building_ids=ARRAY['${BUILDING}'::uuid] WHERE permission='${RESTRICTED}'`);
  value = await all(env, 'fa_type_breakdown', { ...range, basis: 'cash' });
  assert.deepEqual([value.items.map(row => [row.buildingId, row.typeName, num(row.totalAmount)]), value.summary.restrictedIncluded],
    [[[BUILDING, 'Sửa chữa', 800000], [OTHER_BUILDING, 'Sửa chữa', 600000]], false]);
  // Khoá analysis toàn công ty + Toàn tổ chức ⇒ một chuỗi gộp buildingId null như web.
  await db.exec("UPDATE public.fixture_acl SET org_wide=true WHERE permission IN ('reports_finance.analysis','income_expenses.restricted_view')");
  value = await all(env, 'fa_type_breakdown', { ...range, basis: 'cash' });
  assert.deepEqual([value.items.map(row => [row.buildingId, row.typeName, num(row.totalAmount)]), value.summary.restrictedIncluded],
    [[[null, 'Lương', 5300000], [null, 'Sửa chữa', 1400000]], true]);
  // Hàm dùng chung tự kiểm phủ phiếu hạn chế khi web gọi thẳng.
  await db.exec(`UPDATE public.fixture_acl SET org_wide=false,building_ids=ARRAY['${OTHER_BUILDING}'::uuid] WHERE permission='${RESTRICTED}'`);
  const direct = await web(env, "public.finance_analysis_type_breakdown_v1($1::uuid,'2026-10-01','2026-10-31',false,$2::uuid[])", [ORG, [BUILDING]]);
  assert.deepEqual([direct.restricted_included, direct.rows.map(row => row.type_name)], [false, ['Sửa chữa']]);
}));

test('B7 hạng mục hạn chế dưới RLS hạng mục như production (giấu chính hạng mục hạn chế) và hạng mục hạn chế gộp vào hạng mục thường — vẫn chặn', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  const range = { fromDate: '2026-10-01', toDate: '2026-10-31' };
  const pick = value => [value.items.map(row => [row.typeName, num(row.totalAmount)]), value.summary.restrictedIncluded];
  // Không có restricted_view ở đâu: RLS giấu "Lương" ⇒ kiểm dưới RLS sẽ tưởng không hạn chế; Hermes vẫn chặn (cash, dồn tích).
  assert.equal((await web(env, "(SELECT count(*) FROM public.income_expense_types WHERE is_restricted)")), 0, 'RLS giấu hạng mục hạn chế');
  assert.deepEqual(pick(await all(env, 'fa_type_breakdown', { ...range, basis: 'cash' })), [[['Sửa chữa', 800000]], false]);
  assert.deepEqual(pick(await all(env, 'fa_type_breakdown', range)), [[['Sửa chữa', 800000]], false]);
  // restricted_view chỉ ở toà B (kết nối toà A), "Lương" gộp vào "Sửa chữa": cash dồn số hạn chế vào dòng thường ⇒ bỏ cả dòng;
  // dồn tích theo hạng mục gốc ⇒ "Sửa chữa" giữ đúng số của chính nó.
  await db.exec(`INSERT INTO public.fixture_acl(permission,building_ids) VALUES('${RESTRICTED}',ARRAY['${OTHER_BUILDING}'::uuid])`);
  await db.exec(`UPDATE public.income_expense_types SET merged_into_id='${CATEGORY}' WHERE id='${RESTRICTED_CATEGORY}'`);
  assert.deepEqual((await webRows(env, "SELECT type_name,total_amount FROM public.fa_type_breakdown('2026-10-01','2026-10-31',$1::uuid[])", [[BUILDING]]))
    .map(row => [row.type_name, num(row.total_amount)]), [['Sửa chữa', 6100000]], 'web: số hạn chế dồn vào hạng mục thường');
  assert.deepEqual(pick(await all(env, 'fa_type_breakdown', { ...range, basis: 'cash' })), [[], false]);
  assert.deepEqual(pick(await all(env, 'fa_type_breakdown', range)), [[['Sửa chữa', 800000]], false]);
}));

test('B7 bốn RPC Phân tích tài chính (snapshot, lấp đầy, sự kiện HĐ, thu hồi HĐ) = web trên đúng toà kết nối', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  const range = { fromDate: '2026-01-01', toDate: '2026-12-31' };
  await db.exec(`INSERT INTO public.contract_terminations(contract_id,status,termination_date) SELECT id,'COMPLETED','2026-06-15' FROM public.contracts WHERE contract_number='HD-B'`);
  for (const buildings of [[BUILDING], [BUILDING, OTHER_BUILDING]]) {
    if (buildings.length === 2) await orgOverlay(db);
    const snap = await all(env, 'fa_snapshot_kpis');
    const webSnap = await webRows(env, 'SELECT * FROM public.fa_snapshot_kpis($1::uuid[]) ORDER BY building_name', [buildings]);
    assert.deepEqual(snap.items.map(row => [row.buildingId, row.totalRooms, row.activeContracts, num(row.depositHeld), num(row.receivableTotal)]),
      webSnap.map(row => [row.building_id, row.total_rooms, Number(row.active_contracts), num(row.deposit_held), num(row.receivable_total)]), `snapshot ${buildings.length}`);
    const occ = await all(env, 'fa_occupancy_monthly', range);
    const webOcc = await webRows(env, 'SELECT * FROM public.fa_occupancy_monthly($1::date,$2::date,$3::uuid[]) ORDER BY 1,3', [range.fromDate, range.toDate, buildings]);
    assert.deepEqual(occ.items.map(row => [row.month, row.buildingId, row.occupiedRooms, num(row.occupancyPct)]),
      webOcc.map(row => [row.month, row.building_id, row.occupied_rooms, num(row.occupancy_pct)]));
    assert.equal(occ.items.length, 12 * buildings.length);
    const lease = await all(env, 'fa_lease_events', range);
    const webLease = await webRows(env, 'SELECT * FROM public.fa_lease_events($1::date,$2::date,$3::uuid[]) ORDER BY 1,3', [range.fromDate, range.toDate, buildings]);
    assert.deepEqual(lease.items.map(row => [row.month, row.buildingId, row.newContracts, row.terminations]),
      webLease.map(row => [row.month, row.building_id, Number(row.new_contracts), Number(row.terminations)]));
    const coll = await all(env, 'fa_invoice_collection', { fromDate: '2026-10-01', toDate: '2026-10-31' });
    const webColl = await webRows(env, "SELECT * FROM public.fa_invoice_collection('2026-10','2026-10',$1::uuid[]) ORDER BY 1,3", [buildings]);
    assert.deepEqual(coll.items.map(row => [row.billingMonth, row.buildingId, num(row.billed), num(row.collected), row.invoiceCount]),
      webColl.map(row => [row.billing_month, row.building_id, num(row.billed), num(row.collected), Number(row.invoice_count)]));
  }
  assert.deepEqual((await all(env, 'fa_snapshot_kpis', { buildingId: OTHER_BUILDING })).items.map(row => row.buildingId), [OTHER_BUILDING]);
}));

test('rào công ty (20261018000700): hàng của RPC web nêu công ty theo bảng buildings dưới RLS — toà RPC trả mà RLS giấu ⇒ cổng từ chối 42501, không chép công ty kết nối', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await orgOverlay(db);
  assert.equal((await all(env, 'fa_snapshot_kpis')).items.length, 2);
  // RPC web (DEFINER, can_access_building) vẫn trả toà B; RLS buildings của người hỏi giấu toà B.
  await db.exec(`ALTER POLICY fixture_buildings_select ON public.buildings USING (id<>'${OTHER_BUILDING}'::uuid)`);
  assert.deepEqual((await all(env, 'fa_snapshot_kpis', { buildingId: BUILDING })).items.map(row => row.buildingId), [BUILDING]);
  await assert.rejects(all(env, 'fa_snapshot_kpis'), code('42501'));
}));

test('B7 10 khoản chi lớn = hàm dùng chung (INVOKER, RLS) trên toà kết nối; phiếu hạn chế của người khác chỉ khi restricted_view phủ mọi toà', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  const pick = rows => rows.map(row => [row.code, num(row.totalAmount)]);
  let value = await all(env, 'top_expenses', { month: '2026-10' });
  assert.deepEqual(pick(value.items), [['PC-401', 800000], ['PC-404', 300000]], 'phiếu hạn chế của CHÍNH mình vẫn thấy (như RLS web); chưa duyệt không tính');
  // Có restricted_view ở toà B (web can_view_restricted_ie = có ở bất kỳ đâu ⇒ thấy hết); Hermes: không phủ toà A ⇒ ẩn.
  await db.exec(`INSERT INTO public.fixture_acl(permission,building_ids) VALUES('${RESTRICTED}',ARRAY['${OTHER_BUILDING}'::uuid])`);
  const webTop = await webRows(env, "SELECT * FROM public.finance_analysis_top_expenses_v1($1::uuid,'2026-10-01','2026-10-31',$2::uuid[],10)", [ORG, [BUILDING]]);
  assert.deepEqual(webTop.map(row => [row.code, num(row.total_amount)]), [['PC-402', 5000000], ['PC-401', 800000], ['PC-404', 300000]]);
  assert.deepEqual(pick((await all(env, 'top_expenses', { month: '2026-10' })).items), [['PC-401', 800000], ['PC-404', 300000]]);
  await grantRead(db, [RESTRICTED]);
  value = await all(env, 'top_expenses', { month: '2026-10' });
  assert.deepEqual(pick(value.items), [['PC-402', 5000000], ['PC-401', 800000], ['PC-404', 300000]]);
  assert.deepEqual([value.items[0].buildingId, value.items[0].itemTypes, value.items[0].voucherDate], [BUILDING, 'Lương', '2026-10-04']);
  await orgOverlay(db);
  assert.deepEqual(pick((await all(env, 'top_expenses', { month: '2026-10' })).items).map(([c]) => c), ['PC-402', 'PC-401', 'PC-403', 'PC-404']);
  assert.equal((await webRows(env, "SELECT * FROM public.finance_analysis_top_expenses_v1($1::uuid,'2026-10-01','2026-10-31',NULL,10)", [ORG])).length, 4,
    'NULL = toàn phạm vi khoá ∩ RLS');
  assert.equal((await webRows(env, "SELECT * FROM public.finance_analysis_top_expenses_v1($1::uuid,'2026-10-01','2026-10-31','{}',10)", [ORG])).length, 0, "'{}' = rỗng");
}));

test('B7 10 khoản chi lớn: 101 phiếu hạn chế của người khác lớn hơn đứng trước — vẫn ra đúng phiếu hợp lệ (lọc trong hàm nguồn, TRƯỚC khi xếp/cắt)', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  const pick = rows => rows.map(row => [row.code, num(row.totalAmount ?? row.total_amount)]);
  // restricted_view chỉ ở toà B: RLS web cho thấy phiếu hạn chế (có quyền ở đâu đó); kết nối toà A ⇒ Hermes phải ẩn.
  await db.exec(`INSERT INTO public.fixture_acl(permission,building_ids) VALUES('${RESTRICTED}',ARRAY['${OTHER_BUILDING}'::uuid])`);
  await restrictedAhead(db);
  const source = (limit, narrow) => webRows(env, 'SELECT * FROM public.finance_analysis_top_expenses_v2($1::uuid,$2::date,$3::date,$4::uuid[],$5::integer,$6::boolean)',
    [ORG, '2026-10-01', '2026-10-31', [BUILDING], limit, narrow]);
  const top100 = await source(100, null);
  assert.ok(top100.length === 100 && top100.every(row => row.has_restricted_item && row.user_id === OTHER_USER), '100 phiếu đầu đều là phiếu hạn chế của người khác');
  assert.deepEqual(pick(await source(10, false)), [['PC-401', 800000], ['PC-404', 300000]], 'hàm nguồn thu hẹp trước LIMIT');
  assert.deepEqual(pick(await source(10, true)), pick(top100.slice(0, 10)), 'true = như RLS (không mở rộng)');
  assert.deepEqual(pick((await all(env, 'top_expenses', { month: '2026-10' })).items), [['PC-401', 800000], ['PC-404', 300000]]);
  // Phủ mọi toà ⇒ 10 phiếu lớn nhất, kể cả phiếu hạn chế (như web).
  await grantRead(db, [RESTRICTED]);
  assert.deepEqual((await all(env, 'top_expenses', { month: '2026-10' })).items.map(row => row.code),
    Array.from({ length: 10 }, (_, i) => `PC-R${String(100 - i).padStart(3, '0')}`));
  // Bản _v1 (web gọi được) = _v2 không thu hẹp.
  assert.deepEqual(pick(await webRows(env, "SELECT * FROM public.finance_analysis_top_expenses_v1($1::uuid,'2026-10-01','2026-10-31',$2::uuid[],100)", [ORG, [BUILDING]])),
    pick(await source(100, null)));
}));

test('B8 Hiệu quả kinh doanh: RPC web "tất cả hoặc không" chỉ nhận toà web cho phép ∩ restricted_view của CRM và kết nối', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await db.exec(`INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,voucher_date,total_amount,approval_status,kqkd_amount) VALUES
    (gen_random_uuid(),'${ORG}','${USER}','PT-9','INCOME','Thu tiền phòng','${OTHER_BUILDING}','2026-10-02',4000000,'APPROVED',4000000)`);
  const range = { fromDate: '2026-10-01', toDate: '2026-10-31', basis: 'cash' };
  await orgOverlay(db);
  await assert.rejects(run(env, 'bp_pnl', range), code('42501'), 'không quyền phiếu hạn chế ⇒ từ chối như web');
  await grantRead(db, [RESTRICTED]);
  let value = await all(env, 'bp_pnl', range);
  const webPnl = await webRows(env, "SELECT * FROM public.business_performance_pnl_v1($1::uuid,'VOUCHER_DATE','2026-10-01','2026-10-31',$2::uuid[]) ORDER BY 1,3",
    [ORG, [BUILDING, OTHER_BUILDING]]);
  assert.deepEqual(value.items.map(row => [row.buildingId, num(row.revenue), num(row.expense)]), webPnl.map(row => [row.building_id, num(row.revenue), num(row.expense)]));
  assert.deepEqual(value.items.map(row => [row.buildingId, num(row.revenue), num(row.expense)]), [[BUILDING, 0, 6100000], [OTHER_BUILDING, 4000000, 600000]]);
  // CRM chỉ cho phiếu hạn chế ở toà A ⇒ chỉ toà A (web: chọn cả hai ⇒ 42501).
  await db.exec(`UPDATE public.fixture_acl SET building_ids=ARRAY['${BUILDING}'::uuid] WHERE permission='${RESTRICTED}'`);
  await assert.rejects(web(env, "SELECT count(*) FROM public.business_performance_pnl_v1($1::uuid,'ACCRUAL','2026-10-01','2026-10-31',$2::uuid[])", [ORG, [BUILDING, OTHER_BUILDING]]), code('42501'));
  assert.deepEqual((await all(env, 'bp_pnl', range)).items.map(row => row.buildingId), [BUILDING]);
  assert.deepEqual((await all(env, 'bp_cohort', { month: '2026-10' })).items.map(row => [row.buildingId, row.billed, row.collected, row.cohortMonth]),
    [[BUILDING, '1000000.00', '500000.00', '2026-10-01']]);
  assert.deepEqual((await all(env, 'bp_cash_received', { month: '2026-10' })).items.map(row => [row.buildingId, row.cashReceived]), [[BUILDING, '700000.00']]);
  assert.deepEqual((await all(env, 'bp_categories', range)).items.map(row => [row.buildingId, row.typeName, num(row.totalAmount)]),
    [[BUILDING, 'Lương', 5300000], [BUILDING, 'Sửa chữa', 800000]], 'cơ cấu từng toà được phép');
  // Kết nối KHÔNG chọn restricted_view (dù CRM có) ⇒ 42501: overlay là hàng rào.
  await db.exec(`UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'${RESTRICTED}')`);
  await assert.rejects(run(env, 'bp_pnl', range), code('42501'));
  // Toà ảo không bao giờ vào RPC (web roster chỉ toà thật); kết nối không còn toà ⇒ no_building_scope.
  await orgOverlay(db, false);
  await db.exec(`UPDATE public.fixture_acl SET building_ids=ARRAY['${OTHER_BUILDING}'::uuid] WHERE permission='reports_finance.analysis'`);
  assert.equal((await run(env, 'bp_pnl', range)).unavailable, 'no_building_scope');
}));

test('B10 cổ đông tự xem: chỉ phần của CHÍNH người hỏi trong công ty, theo toà kết nối; luỹ kế được chia/đã ứng/còn lại như ShareholderSelfView', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await grantRead(db, ['reports_finance.profit_distribution'], { orgWide: true });
  let value = await all(env, 'profit_my_share');
  assert.deepEqual(value.items.map(row => [row.periodMonth, row.buildingId, row.status, row.amount, row.buildingName]),
    [['2026-09-01', BUILDING, 'LOCKED', '3000000', 'Toà A'], ['2025-10-01', BUILDING, 'LOCKED', '600000', 'Toà A']], 'kết nối chỉ toà A');
  assert.deepEqual(value.summary, { isShareholder: true, shareholderName: 'Cổ đông Tôi', accrued: '3600000', paid: '1000000.00', remaining: '2600000.00',
    allocations: 2, payouts: 1 });
  assert.deepEqual((await all(env, 'profit_my_share', { year: 2026 })).items.map(row => row.periodMonth), ['2026-09-01']);
  await orgOverlay(db);
  value = await all(env, 'profit_my_share');
  const webShare = await web(env, 'public.profit_my_share_v1($1::uuid,NULL)', [ORG]);
  const sum = (rows, key) => rows.reduce((total, row) => total + num(row[key]), 0);
  assert.deepEqual([num(value.summary.accrued), num(value.summary.paid)], [sum(webShare.allocations, 'amount'), sum(webShare.payouts, 'total_amount')]);
  assert.deepEqual([num(value.summary.accrued), num(value.summary.paid), value.items.length], [4800000, 1200000, 3]);
  assert.ok(!JSON.stringify(value).includes('7000000'), 'không phần của cổ đông khác');
  await db.exec(`UPDATE public.shareholders SET auth_user_id=NULL WHERE id='${SH_ME}'`);
  value = await all(env, 'profit_my_share');
  assert.deepEqual([value.items, value.summary.isShareholder, value.summary.accrued], [[], false, '0'], 'không phải cổ đông của công ty này (cổ đông công ty khác không tính)');
  await db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='reports_finance.profit_distribution'");
  await assert.rejects(run(env, 'profit_my_share'), code('42501'));
  await assert.rejects(web(env, 'public.profit_my_share_v1($1::uuid,NULL)', [ORG]), code('42501'), 'hàm dùng chung tự kiểm khoá web');
}));

test('B10 quản lý: như tab "Tổng quan" quản lý của web — shareholder_profit.view VÀ isManager (super admin, chốt/mở chốt LN, chia LN, quản lý cổ đông) + Toàn tổ chức; dòng nhìn thấy do RLS quyết', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  const summaryOf = (actor = USER) => web(env, 'public.profit_shareholder_summary_v1($1::uuid,NULL)', [ORG], actor);
  const mine = value => value.items.map(row => [row.shareholderId, row.accrued, row.paid, row.remaining, row.yearAccrued]);
  await grantRead(db, ['shareholder_profit.view'], { orgWide: true });
  assert.equal((await run(env, 'profit_shareholders')).unavailable, 'organization_scope_required');
  await orgOverlay(db);
  // Chỉ quyền xem: web không phải isManager ⇒ không có tab ⇒ 42501 ở Hermes lẫn hàm dùng chung.
  await assert.rejects(run(env, 'profit_shareholders'), code('42501'), 'chỉ quyền xem');
  await assert.rejects(summaryOf(), code('42501'), 'chỉ quyền xem: hàm dùng chung');
  // Từng quyền quản lý một, mỗi quyền đủ mở tab (ProfitHubPage.tsx:51).
  for (const [label, on, off] of [
    ['super admin', `INSERT INTO public.super_admins VALUES('${USER}')`, `DELETE FROM public.super_admins WHERE user_id='${USER}'`],
    ['chốt LN', `INSERT INTO public.fixture_profit_close VALUES('${USER}','${ORG}',true,false)`, 'DELETE FROM public.fixture_profit_close'],
    ['mở chốt LN', `INSERT INTO public.fixture_profit_close VALUES('${USER}','${ORG}',false,true)`, 'DELETE FROM public.fixture_profit_close'],
    ['chia LN (chỉ ở một toà, như canUse không hỏi toà)', crmGrant('shareholder_profit.distribute', false), "DELETE FROM public.fixture_acl WHERE permission='shareholder_profit.distribute'"],
    ['quản lý cổ đông', crmGrant('shareholder_profit.manage_shareholders'), "DELETE FROM public.fixture_acl WHERE permission='shareholder_profit.manage_shareholders'"],
  ]) {
    await db.exec(on);
    const value = await all(env, 'profit_shareholders', { year: 2026 });
    if (label === 'super admin') assert.deepEqual(value.items.map(row => row.shareholderId), [SH_OTHER, SH_ME], 'super admin: RLS cho mọi dòng của công ty');
    else assert.deepEqual(mine(value), [[SH_ME, '4800000', '1200000.00', '3600000.00', '4200000']], `${label}: không phải chủ/người tạo ⇒ chỉ dòng của mình (RLS self)`);
    assert.ok((await summaryOf()).shareholders.length > 0, `${label}: hàm dùng chung`);
    await db.exec(off);
    await assert.rejects(run(env, 'profit_shareholders'), code('42501'), `${label}: gỡ ⇒ hết quyền`);
  }
  // Chốt LN ở công ty KHÁC: web (some() mọi công ty) vẫn coi là quản lý; Hermes chỉ xét đúng công ty ⇒ 42501.
  await db.exec(`INSERT INTO public.fixture_profit_close VALUES('${USER}','${FOREIGN}',true,true)`);
  await assert.rejects(run(env, 'profit_shareholders'), code('42501'), 'chốt LN ở công ty khác');
  // Quản lý bị thu hồi.
  await db.exec(crmGrant('shareholder_profit.distribute'));
  let value = await all(env, 'profit_shareholders', { year: 2026 });
  assert.equal(value.summary.lockedProfit, '16000000', 'chỉ kỳ chốt có phần của mình');
  await db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='shareholder_profit.distribute'");
  await assert.rejects(run(env, 'profit_shareholders'), code('42501'), 'quản lý bị thu hồi');
  await assert.rejects(summaryOf(), code('42501'), 'quản lý bị thu hồi: hàm dùng chung');
  // Người tạo cũ (OTHER_USER tạo các dòng: RLS owner_all cho đọc hết) mà không còn quyền quản lý ⇒ 42501; còn quyền chốt ⇒ đọc như RLS.
  await assert.rejects(summaryOf(OTHER_USER), code('42501'), 'người tạo cũ, chỉ quyền xem');
  await db.exec(`INSERT INTO public.fixture_profit_close VALUES('${OTHER_USER}','${ORG}',true,false)`);
  assert.equal((await summaryOf(OTHER_USER)).shareholders.length, 2, 'người tạo còn quyền chốt LN: thấy mọi dòng (RLS owner_all)');
  await db.exec(`DELETE FROM public.fixture_profit_close WHERE user_id='${OTHER_USER}'`);
  await assert.rejects(summaryOf(OTHER_USER), code('42501'), 'người tạo cũ mất quyền chốt LN');
  // Chủ công ty (RLS owner) + quyền quản lý: mọi cổ đông, tổng các cột.
  await db.exec("UPDATE public.fixture_acl SET allowed=true WHERE permission='shareholder_profit.distribute'");
  await db.exec(`INSERT INTO public.fixture_company_owners VALUES('${ORG}','${USER}')`);
  value = await all(env, 'profit_shareholders');
  assert.deepEqual(value.items.map(row => [row.name, row.accrued, row.paid, row.yearAccrued]),
    [['Cổ đông Khác', '7000000', '2500000.00', null], ['Cổ đông Tôi', '4800000', '1200000.00', null]]);
  assert.deepEqual(value.summary, { lockedProfit: '16000000', accrued: '11800000', paid: '3700000.00', remaining: '8100000.00' });
  assert.deepEqual((await summaryOf()).shareholders.map(row => num(row.remaining)), value.items.map(row => num(row.remaining)));
  await db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='shareholder_profit.view'");
  await assert.rejects(run(env, 'profit_shareholders'), code('42501'));
  await assert.rejects(summaryOf(), code('42501'), 'hàm dùng chung tự kiểm khoá web');
}));

test('B12 ví cá nhân = personal_finance_snapshot của CHÍNH người hỏi (không theo công ty/toà, không gọi bootstrap)', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await grantRead(db, ['personal_finance.view']);
  await db.exec(`UPDATE app_private.hermes_connections SET scope_ids='{}'; UPDATE app_private.hermes_org_policies SET scope_ids='{}'`);
  const wallets = await all(env, 'personal_wallets');
  const snap = await web(env, 'public.personal_finance_snapshot()');
  assert.deepEqual(wallets.items.map(row => [row.walletId, row.balance]), snap.wallets.map(row => [row.id, String(row.balance)]));
  assert.deepEqual(wallets.items.map(row => [row.walletId, row.name, row.balance, row.hidden]),
    [[WALLET, 'Ví chính', '1900000', false], [WALLET_HIDDEN, 'Ví ẩn', '5000', true]]);
  // Tổng = selectBalance của trang Ví cá nhân: cộng mọi ví của snapshot, kể cả ví ẩn.
  assert.deepEqual(wallets.summary, { totalBalance: String(snap.wallets.reduce((sum, row) => sum + Number(row.balance), 0)), wallets: 2 });
  assert.equal(wallets.summary.totalBalance, '1905000');
  const tx = await all(env, 'personal_transactions');
  assert.deepEqual(tx.items.map(row => [row.date, row.type, row.amount, row.categoryName, row.walletName]),
    [['2026-10-06', 'EXPENSE', '150000', 'Ăn uống', 'Ví chính'], ['2026-10-05', 'INCOME', '2000000', null, 'Ví chính'], ['2026-09-30', 'EXPENSE', '50000', 'Ăn uống', 'Ví chính']]);
  assert.deepEqual(tx.summary, { income: '2000000', expense: '200000', transactions: 3 });
  assert.equal((await all(env, 'personal_transactions', { kind: 'EXPENSE', fromDate: '2026-10-01' })).items.length, 1);
  assert.equal((await all(env, 'personal_transactions', { query: 'ăn uống' })).items.length, 2);
  assert.ok(!JSON.stringify([wallets, tx]).includes('777777') && !JSON.stringify(tx).includes('123456'), 'không bao giờ dữ liệu người khác');
  assert.equal((await db.query('SELECT count(*)::int n FROM public.personal_wallets')).rows[0].n, 3, 'không ghi (không bootstrap)');
}));

test('B12 ví cá nhân nhiều ví (1999/2000/2001): tổng trên MỌI ví, hàng sắp như snapshot, cắt 2000, sourceCapped theo tổng thật', { timeout: 180000 }, () => inCase(async env => {
  const { db } = env;
  await grantRead(db, ['personal_finance.view']);
  await db.exec(`UPDATE app_private.hermes_connections SET scope_ids='{}'; UPDATE app_private.hermes_org_policies SET scope_ids='{}'`);
  for (const total of [1999, 2000, 2001]) {
    await db.exec('SAVEPOINT wallets');
    await extraWallets(db, total - 2);
    const snap = await web(env, 'public.personal_finance_snapshot()');
    assert.equal(snap.wallets.length, total);
    const first = await run(env, 'personal_wallets');
    const last = await run(env, 'personal_wallets', {}, { offset: 1950 });
    const kept = Math.min(total, 2000);
    assert.deepEqual([first.items.map(row => row.walletId), last.items.map(row => row.walletId)],
      [snap.wallets.slice(0, 50).map(row => row.id), snap.wallets.slice(1950, kept).map(row => row.id)], `${total}: thứ tự như snapshot (mặc định, tên, id)`);
    assert.deepEqual([first.nextOffset, last.nextOffset, last.sourceCapped, first.sourceCapped], [50, null, total > 2000, total > 2000], `${total}: trang/trần`);
    // Tổng trên mọi ví (kể cả ví bị cắt): 2 ví nền 1 905 000 + mỗi ví thêm 1.
    assert.deepEqual(last.summary, { totalBalance: String(1905000 + total - 2), wallets: total }, `${total}: tổng`);
    await db.exec('ROLLBACK TO SAVEPOINT wallets; RELEASE SAVEPOINT wallets');
  }
}));

test('B11 biến động số dư (scope platform): chỉ super admin; chỉ siêu dữ liệu (không bản mã, không số tiền), không ghi dấu vết xem nội dung', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await grantRead(db, ['assistant.bank_events.read']);
  await assert.rejects(run(env, 'bank_event_feed'), code('42501'), 'không phải super admin');
  await db.exec(`INSERT INTO public.super_admins VALUES('${USER}')`);
  const value = await all(env, 'bank_event_feed');
  assert.deepEqual(value.items.map(row => [row.eventId, row.eventType, row.duplicateCount, row.receivedAt]),
    [[EVENT_2, 'notification.received', 2, '2026-10-16T02:00:03.000Z'], [EVENT_1, 'sms.received', 0, '2026-10-15T01:00:05.000Z']]);
  assert.deepEqual(value.summary, { totalSources: 1, enabledSources: 1, totalEvents: 2, lastReceivedAt: '2026-10-16T02:00:03.000Z', amountsAvailable: false });
  assert.doesNotMatch(JSON.stringify(value), /CIPHERTEXT|ciphertext|payloadHash|externalId/);
  assert.deepEqual((await all(env, 'bank_event_feed', { kind: 'sms' })).items.map(row => row.eventId), [EVENT_1]);
  assert.deepEqual((await all(env, 'bank_event_feed', { fromDate: '2026-10-16', toDate: '2026-10-16' })).items.map(row => row.eventId), [EVENT_2], 'ngày theo giờ VN');
  assert.equal((await db.query('SELECT count(*)::int n FROM app_private.bank_event_audit')).rows[0].n, 0);
}));

test('rào đầu ra broker: hàng nêu toà ngoài fence/phạm vi CRM, sai nguồn, trường lạ; báo cáo không theo toà không nêu toà', () => {
  const input = W2.reads.report.input({ report: 'fa_snapshot_kpis', params: {}, limit: 20, offset: 0 });
  const row = { buildingId: BUILDING, buildingName: 'Toà A', totalRooms: 1, roomsAvailable: 0, roomsOccupied: 1, roomsReserved: 0, roomsMaintenance: 0,
    roomsUnavailable: 0, vacancyLossMonth: '0', activeContracts: 1, avgRent: '1', depositHeld: '0', receivableTotal: '0', agingNotDue: '0', aging1To30: '0',
    aging31To60: '0', aging61To90: '0', agingOver90: '0' };
  const value = { organizationId: ORG, domain: 'report', fetchedAt: '2026-10-18T00:00:00.000Z', report: 'fa_snapshot_kpis', source: 'crm.fa_snapshot_kpis',
    unavailable: null, summary: null, items: [row], offset: 0, nextOffset: null, sourceCapped: false, fence: { buildings: [BUILDING], cashbooks: [], orgWide: false } };
  assert.equal(W2.reads.report.result(value, identity('reports_finance.analysis'), input).items.length, 1);
  for (const bad of [{ ...value, items: [{ ...row, buildingId: OTHER_BUILDING }] }, { ...value, items: [{ ...row, buildingId: null }] },
    { ...value, source: 'crm.fa_monthly_pnl' }, { ...value, items: [{ ...row, phone: '1' }] }, { ...value, fence: { buildings: [FOREIGN], cashbooks: [], orgWide: false } }])
    assert.throws(() => W2.reads.report.result(bad, identity('reports_finance.analysis'), input));
  for (const [report, spec] of Object.entries(W2B_REPORTS)) {
    if (['self', 'organization', 'cashbooks', 'platform'].includes(spec.scope)) assert.ok(!Object.hasOwn(spec.fields, 'buildingId'), `${report}: không nêu toà`);
    else assert.ok(Object.hasOwn(spec.fields, 'buildingId'), `${report}: mọi hàng theo toà nêu buildingId`);
  }
});

// Đột biến: mỗi bản bỏ MỘT hàng rào riêng của gói B; cùng phép thử mà bản sống từ chối thì bản đột biến phải lọt. Rào toà
// của hàng (buildingId ∈ ctx.buildings, null chỉ khi org_wide) do bước kết thúc của cổng chặn — test nền Gói 0 có đột biến.
// Hàng rơi ra ngoài công ty/sổ nhìn thấy mà rào công ty của cổng (20261018000700) còn bắt được thì đột biến đo ở hàm dùng
// chung (web gọi thẳng, không có rào của cổng) VÀ đòi cổng từ chối 42501 — organizationId lấy từ cột nguồn, không chép ctx.
const gateCode = promise => promise.then(() => 'ok', error => error.code);
const replaceExactly = (sql, from, to) => { assert.equal(sql.split(from).length, 2, `anchor: ${from}`); return sql.replace(from, () => to); };
const mutate = (...pairs) => pairs.reduce((sql, [from, to]) => replaceExactly(sql, from, to), live);
const probes = [
  { name: 'chốt sổ chỉ sổ nhìn thấy (chặt hơn web)', sql: mutate([`    WHERE (p_status IS NULL OR p_status='CONFIRMED') AND (e->>'cashbook_id')::uuid=ANY(v_books)`,
    `    WHERE (p_status IS NULL OR p_status='CONFIRMED')`]),
    run: async env => { await grantRead(env.db, ['cashbooks.view'], { orgWide: true }); await orgOverlay(env.db);
      // Hai sổ nhìn thấy ⇒ RPC web gọi không tham số (trả mọi sổ): chỉ còn hàng rào lọc theo sổ nhìn thấy.
      await env.db.exec(`INSERT INTO public.cashbook_possession_bindings(organization_id,cashbook_id,membership_id,possession_kind) VALUES('${ORG}','${OWNER_BOOK}','${USER}','OPERATOR')`);
      const direct = (await webRows(env, 'SELECT cashbook_id FROM public.cashbook_closings_v1($1::uuid)', [ORG])).some(row => row.cashbook_id === FOREIGN_CASHBOOK);
      // Sổ không nhìn thấy ⇒ không có công ty (RLS accounts) ⇒ cổng từ chối, không lộ.
      return direct && await gateCode(all(env, 'cashbook_closings')) === '42501'; } },
  { name: 'sổ quỹ ngày: sổ của đúng công ty', sql: mutate([`  SELECT COALESCE(array_agg(a.id ORDER BY a.id),'{}'::uuid[]) INTO v_books FROM public.accounts a
    WHERE a.organization_id=p_organization_id AND a.deleted_at IS NULL;
  IF p_cashbook_id IS NOT NULL THEN`, `  SELECT COALESCE(array_agg(a.id ORDER BY a.id),'{}'::uuid[]) INTO v_books FROM public.accounts a
    WHERE a.deleted_at IS NULL;
  IF p_cashbook_id IS NOT NULL THEN`]),
    run: async env => { await grantRead(env.db, ['reports_finance.daily_cashbook'], { orgWide: true }); await orgOverlay(env.db); await secondOrg(env.db);
      return (await all(env, 'cashbook_daily', { fromDate: '2026-10-01', toDate: '2026-10-12' })).summary.totalIncome !== '1300000.00'; } },
  { name: 'sổ quỹ ngày: người nhiều công ty gọi từng sổ thay vì "Tất cả" của web', sql: mutate([`  ELSIF cardinality(v_books)=0 THEN v_accounts:='{}'::uuid[];
  -- "Tất cả" của web (RPC lọc sổ nhìn thấy ∩ my_org_ids()) chỉ khi người gọi thuộc ĐÚNG công ty này và không thấy sổ nào
  -- ngoài nó; không thì gọi từng sổ (luôn đúng công ty) — RLS accounts có thể hẹp hơn tập sổ RPC web cộng (super admin).
  ELSIF public.my_org_ids() IS DISTINCT FROM ARRAY[p_organization_id]
    OR EXISTS(SELECT 1 FROM public.accounts x WHERE x.deleted_at IS NULL AND NOT x.id=ANY(v_books)) THEN v_accounts:=v_books;
  ELSE v_accounts:=ARRAY[NULL::uuid];
  END IF;
  IF p_building_ids IS NULL AND v_scope->'orgWide'='true'::jsonb THEN v_buildings:=ARRAY[NULL::uuid];
  ELSE
    SELECT COALESCE(array_agg(DISTINCT x ORDER BY x),'{}'::uuid[]) INTO v_buildings
      FROM unnest(COALESCE(p_building_ids,ARRAY(SELECT jsonb_array_elements_text(v_scope->'buildingIds')::uuid))) x
      WHERE v_scope->'buildingIds' ? x::text;
  END IF;
  RETURN QUERY
  WITH bl AS (
    SELECT b.id AS bid FROM unnest(v_buildings) b(id)
  ), opening AS (`, `  ELSIF cardinality(v_books)=0 THEN v_accounts:='{}'::uuid[];
  ELSE v_accounts:=ARRAY[NULL::uuid];
  END IF;
  IF p_building_ids IS NULL AND v_scope->'orgWide'='true'::jsonb THEN v_buildings:=ARRAY[NULL::uuid];
  ELSE
    SELECT COALESCE(array_agg(DISTINCT x ORDER BY x),'{}'::uuid[]) INTO v_buildings
      FROM unnest(COALESCE(p_building_ids,ARRAY(SELECT jsonb_array_elements_text(v_scope->'buildingIds')::uuid))) x
      WHERE v_scope->'buildingIds' ? x::text;
  END IF;
  RETURN QUERY
  WITH bl AS (
    SELECT b.id AS bid FROM unnest(v_buildings) b(id)
  ), opening AS (`]),
    run: async env => { await grantRead(env.db, ['reports_finance.daily_cashbook'], { orgWide: true }); await orgOverlay(env.db); await secondOrg(env.db);
      return (await all(env, 'cashbook_daily', { fromDate: '2026-10-01', toDate: '2026-10-12' })).summary.totalIncome !== '1300000.00'; } },
  { name: 'hạng mục hạn chế: restricted_view của KẾT NỐI phủ mọi toà', sql: mutate([`  v_ok:=cardinality(v_buildings)>0 AND jsonb_typeof(p_ctx->'scopes'->'income_expenses.restricted_view')='array'`,
    `  v_ok:=true OR cardinality(v_buildings)>0 AND jsonb_typeof(p_ctx->'scopes'->'income_expenses.restricted_view')='array'`]),
    run: async env => { await grantRead(env.db, [RESTRICTED]);
      await env.db.exec(`UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'${RESTRICTED}')`);
      return (await all(env, 'fa_type_breakdown', { fromDate: '2026-10-01', toDate: '2026-10-31', basis: 'cash' })).items.some(row => row.typeName === 'Lương'); } },
  { name: 'hạng mục hạn chế: hàm dùng chung tự kiểm restricted_view CRM phủ mọi toà', sql: mutate([`
    AND NOT EXISTS(SELECT 1 FROM unnest(v_buildings) b(id) WHERE NOT (v_restricted->'buildingIds') ? b.id::text);`, ';']),
    run: async env => { await env.db.exec(`INSERT INTO public.fixture_acl(permission,building_ids) VALUES('${RESTRICTED}',ARRAY['${OTHER_BUILDING}'::uuid])`);
      const value = await web(env, "public.finance_analysis_type_breakdown_v1($1::uuid,'2026-10-01','2026-10-31',false,$2::uuid[])", [ORG, [BUILDING]]);
      return value.rows.some(row => row.type_name === 'Lương'); } },
  { name: 'hạng mục hạn chế: cờ hạn chế kiểm ngoài RLS hạng mục (DEFINER)', sql: mutate([
    `    WHERE v_ok OR t.type_id IS NULL OR NOT public.finance_type_restricted_v1(t.type_id,NOT COALESCE(p_accrual,true));`,
    `    WHERE v_ok OR t.type_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.income_expense_types it WHERE it.id=t.type_id AND it.is_restricted);`]),
    run: async env => (await all(env, 'fa_type_breakdown', { fromDate: '2026-10-01', toDate: '2026-10-31', basis: 'cash' })).items.some(row => row.typeName === 'Lương') },
  { name: 'hạng mục hạn chế: hạng mục hạn chế gộp vào hạng mục thường (cash)', sql: mutate([
    `    AND (r.id=p_type_id OR COALESCE(p_merged,true) AND r.merged_into_id=p_type_id));`, `    AND r.id=p_type_id);`]),
    run: async env => { await env.db.exec(`UPDATE public.income_expense_types SET merged_into_id='${CATEGORY}' WHERE id='${RESTRICTED_CATEGORY}'`);
      return (await all(env, 'fa_type_breakdown', { fromDate: '2026-10-01', toDate: '2026-10-31', basis: 'cash' })).items.some(row => num(row.totalAmount) > 800000); } },
  { name: 'sổ quỹ ngày: "Tất cả" chỉ khi người hỏi thuộc đúng công ty (RLS sổ hẹp hơn tập sổ RPC web cộng)', sql: mutate([
    `    v_accounts:=ARRAY[p_cashbook_id];
  ELSIF cardinality(v_books)=0 THEN v_accounts:='{}'::uuid[];
  -- "Tất cả" của web (RPC lọc sổ nhìn thấy ∩ my_org_ids()) chỉ khi người gọi thuộc ĐÚNG công ty này và không thấy sổ nào
  -- ngoài nó; không thì gọi từng sổ (luôn đúng công ty) — RLS accounts có thể hẹp hơn tập sổ RPC web cộng (super admin).
  ELSIF public.my_org_ids() IS DISTINCT FROM ARRAY[p_organization_id]
    OR EXISTS(SELECT 1 FROM public.accounts x WHERE x.deleted_at IS NULL AND NOT x.id=ANY(v_books)) THEN v_accounts:=v_books;`, `    v_accounts:=ARRAY[p_cashbook_id];
  ELSIF cardinality(v_books)=0 THEN v_accounts:='{}'::uuid[];
  ELSIF EXISTS(SELECT 1 FROM public.accounts x WHERE x.deleted_at IS NULL AND NOT x.id=ANY(v_books)) THEN v_accounts:=v_books;`]),
    run: async env => { await grantRead(env.db, ['reports_finance.daily_cashbook'], { orgWide: true }); await orgOverlay(env.db); await secondOrg(env.db);
      // Sổ công ty khác bị RLS giấu (như policy RESTRICTIVE ẩn demo/sandbox với super admin) nhưng RPC web vẫn cộng.
      await env.db.exec(`CREATE POLICY probe_hide_book ON public.accounts AS RESTRICTIVE FOR SELECT TO authenticated USING (id<>'${FOREIGN_ORG_BOOK}'::uuid)`);
      return (await all(env, 'cashbook_daily', { fromDate: '2026-10-01', toDate: '2026-10-12' })).summary.totalIncome !== '1300000.00'; } },
  { name: 'dòng tiền: "Tất cả" chỉ khi người hỏi thuộc đúng công ty (RLS sổ hẹp hơn tập sổ RPC web cộng)', sql: mutate([
    `  IF cardinality(v_books)=0 THEN v_accounts:='{}'::uuid[];
  -- "Tất cả" của web (RPC lọc sổ nhìn thấy ∩ my_org_ids()) chỉ khi người gọi thuộc ĐÚNG công ty này và không thấy sổ nào
  -- ngoài nó; không thì gọi từng sổ (luôn đúng công ty) — RLS accounts có thể hẹp hơn tập sổ RPC web cộng (super admin).
  ELSIF public.my_org_ids() IS DISTINCT FROM ARRAY[p_organization_id]
    OR EXISTS(SELECT 1 FROM public.accounts x WHERE x.deleted_at IS NULL AND NOT x.id=ANY(v_books)) THEN v_accounts:=v_books;`, `  IF cardinality(v_books)=0 THEN v_accounts:='{}'::uuid[];
  ELSIF EXISTS(SELECT 1 FROM public.accounts x WHERE x.deleted_at IS NULL AND NOT x.id=ANY(v_books)) THEN v_accounts:=v_books;`]),
    run: async env => { await grantRead(env.db, ['reports_finance.cash_flow'], { orgWide: true }); await orgOverlay(env.db);
      const one = (await all(env, 'cash_flow', { year: 2026 })).summary;
      await secondOrg(env.db);
      await env.db.exec(`CREATE POLICY probe_hide_book ON public.accounts AS RESTRICTIVE FOR SELECT TO authenticated USING (id<>'${FOREIGN_ORG_BOOK}'::uuid)`);
      return JSON.stringify((await all(env, 'cash_flow', { year: 2026 })).summary) !== JSON.stringify(one); } },
  { name: 'chi lớn: hàm đọc truyền restricted_view của kết nối (v_ok) vào hàm nguồn', sql: mutate([`v_buildings,10,v_ok) t) x;`, `v_buildings,10,NULL) t) x;`]),
    run: async env => { await env.db.exec(`INSERT INTO public.fixture_acl(permission,building_ids) VALUES('${RESTRICTED}',ARRAY['${OTHER_BUILDING}'::uuid])`);
      return (await all(env, 'top_expenses', { month: '2026-10' })).items.some(row => row.code === 'PC-402'); } },
  { name: 'chi lớn: hàm nguồn bỏ phiếu hạn chế của người khác khi được thu hẹp', sql: mutate([`
    AND (p_include_restricted IS NOT FALSE OR NOT ie.has_restricted_item OR ie.user_id=auth.uid())`, '']),
    run: async env => { await env.db.exec(`INSERT INTO public.fixture_acl(permission,building_ids) VALUES('${RESTRICTED}',ARRAY['${OTHER_BUILDING}'::uuid])`);
      return (await all(env, 'top_expenses', { month: '2026-10' })).items.some(row => row.code === 'PC-402'); } },
  { name: 'chi lớn: lọc phiếu hạn chế TRƯỚC khi xếp/cắt (không lọc sau 100 phiếu của hàm nguồn)', sql: mutate([
    `v_buildings,10,v_ok) t) x;`, `v_buildings,100,NULL) t
      WHERE (NOT t.has_restricted_item OR t.user_id=auth.uid() OR v_ok)
      ORDER BY t.total_amount DESC,t.voucher_date DESC,t.voucher_id LIMIT 10) x;`]),
    run: async env => { await env.db.exec(`INSERT INTO public.fixture_acl(permission,building_ids) VALUES('${RESTRICTED}',ARRAY['${OTHER_BUILDING}'::uuid])`);
      await restrictedAhead(env.db);
      return JSON.stringify((await all(env, 'top_expenses', { month: '2026-10' })).items.map(row => row.code)) !== JSON.stringify(['PC-401', 'PC-404']); } },
  { name: 'chi lớn: hàm dùng chung chỉ trên toà của khoá', sql: mutate([`    AND ie.voucher_date BETWEEN p_start_date AND p_end_date AND ie.building_id=ANY(v_buildings)`,
    `    AND ie.voucher_date BETWEEN p_start_date AND p_end_date`]),
    run: async env => { await env.db.exec(`UPDATE public.fixture_acl SET building_ids=ARRAY['${BUILDING}'::uuid] WHERE permission='reports_finance.analysis'`);
      return (await webRows(env, "SELECT * FROM public.finance_analysis_top_expenses_v1($1::uuid,'2026-10-01','2026-10-31',NULL,10)", [ORG])).some(row => row.code === 'PC-403'); } },
  { name: 'Hiệu quả kinh doanh: restricted_view của kết nối', sql: mutate([`
          AND jsonb_typeof(p_ctx->'scopes'->'income_expenses.restricted_view')='array'
          AND (p_ctx->'scopes'->'income_expenses.restricted_view') ? (e->>'id')),'{}'::uuid[])`, `),'{}'::uuid[])`]),
    run: async env => { await orgOverlay(env.db); await grantRead(env.db, [RESTRICTED]);
      await env.db.exec(`UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'${RESTRICTED}')`);
      return (await all(env, 'bp_pnl', { fromDate: '2026-10-01', toDate: '2026-10-31' })).items.length > 0; } },
  { name: 'tổng quan cổ đông: chỉ cổ đông của đúng công ty', sql: mutate([`    SELECT s.id,s.name,s.organization_id FROM public.shareholders s WHERE s.organization_id=p_organization_id AND s.deleted_at IS NULL`,
    `    SELECT s.id,s.name,s.organization_id FROM public.shareholders s WHERE s.deleted_at IS NULL`]),
    run: async env => { await grantRead(env.db, ['shareholder_profit.view'], { orgWide: true }); await orgOverlay(env.db);
      await env.db.exec(crmGrant('shareholder_profit.distribute'));
      const direct = (await web(env, 'public.profit_shareholder_summary_v1($1::uuid)', [ORG])).shareholders.some(row => row.name === 'Cổ đông ngoài');
      // Cổ đông công ty khác mang organization_id của công ty đó ⇒ rào công ty của cổng từ chối.
      return direct && await gateCode(all(env, 'profit_shareholders')) === '42501'; } },
  { name: 'cổ đông tự xem: luỹ kế chỉ trên toà kết nối', sql: mutate([`    v_raw:=public.profit_my_share_v1(v_org,v_buildings);`, `    v_raw:=public.profit_my_share_v1(v_org,NULL);`],
    [`      SELECT COALESCE(sum((a->>'amount')::numeric),0),count(*) INTO v_a,v_n FROM jsonb_array_elements(v_raw->'allocations') a
        WHERE (a->>'building_id')::uuid=ANY(v_buildings);`, `      SELECT COALESCE(sum((a->>'amount')::numeric),0),count(*) INTO v_a,v_n FROM jsonb_array_elements(v_raw->'allocations') a;`]),
    run: async env => { await grantRead(env.db, ['reports_finance.profit_distribution'], { orgWide: true });
      return (await all(env, 'profit_my_share')).summary.accrued !== '3600000'; } },
  { name: 'hàm dùng chung sổ quỹ: đúng một công ty', sql: mutate([`  JOIN public.accounts o ON o.id=a.id AND o.organization_id=p_organization_id`, `  JOIN public.accounts o ON o.id=a.id`]),
    run: async env => { await secondOrg(env.db); await grantRead(env.db, ['cashbooks.view'], { orgWide: true });
      return (await webRows(env, 'SELECT cashbook_id FROM public.cashbook_list_v1($1::uuid)', [ORG])).some(row => row.cashbook_id === FOREIGN_ORG_BOOK); } },
  { name: 'hàm dùng chung sổ quỹ: tự kiểm khoá web cashbooks.view', sql: mutate([`  IF public.finance_my_scope_v1(p_organization_id,'cashbooks.view')->'allowed' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'cashbook_list_denied' USING ERRCODE='42501';`, `  IF false THEN
    RAISE EXCEPTION 'cashbook_list_denied' USING ERRCODE='42501';`]),
    run: async env => { await env.db.exec("DELETE FROM public.fixture_acl WHERE permission='cashbooks.view'");
      return (await webRows(env, 'SELECT cashbook_id FROM public.cashbook_list_v1($1::uuid)', [ORG])).length > 0; } },
  { name: 'hàm dùng chung: chỉ chạy dưới vai authenticated (không bị DEFINER gọi bỏ qua RLS)', sql: mutate([`  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'profit_summary_denied'`, `  IF auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'profit_summary_denied'`]),
    run: async env => { await grantRead(env.db, ['shareholder_profit.view'], { orgWide: true }); await env.db.exec(crmGrant('shareholder_profit.distribute'));
      await env.db.exec(`SELECT set_config('request.jwt.claim.sub','${USER}',true)`);
      return (await env.db.query(`SELECT jsonb_array_length(public.profit_shareholder_summary_v1('${ORG}')->'shareholders') n`)).rows[0].n > 1; } },
  // Sửa sau review PR #208 (20261018020300).
  { name: 'tổng quan cổ đông: điều kiện isManager của web (chỉ quyền xem ⇒ không có tab)', sql: mutate([`  -- isManager: RPC chốt LN chỉ gọi khi ba điều kiện rẻ hơn đều không có.
  IF NOT (COALESCE(public.is_super_admin(),false)`, `  IF false AND NOT (COALESCE(public.is_super_admin(),false)`]),
    run: async env => { await grantRead(env.db, ['shareholder_profit.view'], { orgWide: true }); await orgOverlay(env.db);
      return (await all(env, 'profit_shareholders')).items.length > 0; } },
  { name: 'tổng quan cổ đông: quyền chốt/mở chốt LN chỉ tính ở ĐÚNG công ty', sql: mutate([`        WHERE o->>'organization_id'=p_organization_id::text
          AND (COALESCE`, `        WHERE (COALESCE`]),
    run: async env => { await grantRead(env.db, ['shareholder_profit.view'], { orgWide: true }); await orgOverlay(env.db);
      await env.db.exec(`INSERT INTO public.fixture_profit_close VALUES('${USER}','${FOREIGN}',true,true)`);
      return (await all(env, 'profit_shareholders')).items.length > 0; } },
  { name: 'cờ hạn chế: chỉ trả lời cho hạng mục thuộc công ty của người gọi', sql: mutate([
    `  IF auth.uid() IS NULL OR v_org IS NULL OR NOT COALESCE(v_org=ANY(public.my_org_ids()),false) THEN RETURN NULL; END IF;`, `  IF v_org IS NULL THEN RETURN NULL; END IF;`]),
    run: async env => { await env.db.exec(`INSERT INTO public.income_expense_types(id,organization_id,type,name,is_restricted)
        VALUES('0b0b0b0b-0000-4000-8000-000000000901','${FOREIGN}','expense','Lương công ty khác',true)`);
      return await web(env, "public.finance_type_restricted_v1('0b0b0b0b-0000-4000-8000-000000000901',true)") !== null; } },
  { name: 'report_text_v1: chỉ chạy dưới vai authenticated', sql: mutate([
    `  IF current_user<>'authenticated' THEN RAISE EXCEPTION 'report_text_denied' USING ERRCODE='42501'; END IF;\n`, '']),
    run: async env => (await env.db.query("SELECT public.report_text_v1('a'||chr(7)||'b',10) t")).rows[0].t === 'ab' },
  { name: 'ví cá nhân: cắt 2000 hàng (trần của cổng)', sql: mutate([`            FROM wal ORDER BY wal.is_default DESC,wal.wname,wal.wid LIMIT 2000) p),`,
    `            FROM wal ORDER BY wal.is_default DESC,wal.wname,wal.wid) p),`]),
    run: async env => { await grantRead(env.db, ['personal_finance.view']); await extraWallets(env.db, 1999);
      return await gateCode(run(env, 'personal_wallets')) !== 'ok'; } },
  { name: 'ví cá nhân: tổng và số ví trên MỌI ví, không chỉ phần trả về', sql: mutate([`        INTO v_rows,v_a,v_n FROM wal;`,
    `        INTO v_rows,v_a,v_n FROM (SELECT * FROM wal ORDER BY wal.is_default DESC,wal.wname,wal.wid LIMIT 2000) wal;`]),
    run: async env => { await grantRead(env.db, ['personal_finance.view']); await extraWallets(env.db, 1999);
      const { summary } = await run(env, 'personal_wallets');
      return summary.totalBalance !== '1906999' || summary.wallets !== 2001; } },
  { name: 'ví cá nhân: sourceCapped theo tổng thật (đúng 2000 ví không bị cắt)', sql: mutate([`      v_summary:=jsonb_build_object('totalBalance',v_a::text,'wallets',v_n);
      v_capped:=v_n>2000;`, `      v_summary:=jsonb_build_object('totalBalance',v_a::text,'wallets',v_n);
      v_capped:=v_n>=2000;`]),
    run: async env => { await grantRead(env.db, ['personal_finance.view']); await extraWallets(env.db, 1998);
      return (await run(env, 'personal_wallets')).sourceCapped; } },
];
for (const probe of probes) {
  const changed = changedFunctions(live, probe.sql);
  test(`mutation is caught: ${probe.name}`, { timeout: 120000 }, async () => {
    await inCase(async env => assert.equal(await probe.run(env).catch(() => false), false, 'bản sống từ chối'));
    await inCase(async env => {
      for (const sql of changed) await env.db.exec(sql);
      assert.equal(await probe.run(env), true, 'bản đột biến lọt');
    });
  });
}
