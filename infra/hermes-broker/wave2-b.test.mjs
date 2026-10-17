import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedW2b, FOREIGN_ORG_BOOK, OWNER_BOOK, SH_ME, SH_OTHER, OTHER_USER, EVENT_1, EVENT_2, WALLET, WALLET_HIDDEN } from './wave2-b-sql-fixture.mjs';
import { assertPackageParity, grantRead, BUILDING, OTHER_BUILDING, ORG_SCOPE, USER, ORG, FOREIGN } from './wave2-sql-fixture.mjs';
import { CASHBOOK, FOREIGN_CASHBOOK } from './finance-fixture.mjs';
import { changedFunctions } from './full-read-sql-fixture.mjs';
import { W2 } from './wave2-registry.mjs';
import { W2B_REPORTS } from './wave2-b-contract.mjs';

// Gói B đợt 2 — test RIÊNG của Gói B. MỘT PGlite cho cả file, mỗi ca BEGIN … ROLLBACK. Mỗi báo cáo: số khớp
// RPC/hàm web gọi trực tiếp như người dùng (cùng tham số/toà), có/không khoá, khác công ty, toà ∩ overlay, sổ
// quỹ chỉ trong sổ nhìn thấy (chặt hơn web ở chốt sổ), phiếu/hạng mục hạn chế, riêng tư (cổ đông, ví, biến
// động số dư), rào đầu ra broker và đột biến SQL của gói B. Dữ liệu tổng hợp; RPC web là định nghĩa thật
// (trừ cụm Hiệu quả kinh doanh: cổng tổng hợp cùng chữ ký — xem wave2-b-sql-fixture.mjs).
// Mô hình INVOKER + RLS (quyết định 18/10): gói chạy dưới vai authenticated. Cổng của Gói 0 trên nhánh này còn
// DEFINER nên run() dùng CHÍNH cổng đó để kiểm quyền và dựng ctx (hàm đọc gói tạm thay bằng bản ghi ctx), rồi
// gọi hàm đọc thật dưới vai authenticated với ctx đó — đúng như cổng INVOKER mới sẽ làm. Rebase lên cổng mới
// thì run() gọi thẳng env.report().
const MAIN_PATH = 'supabase/migrations/20261018020000_hermes_w2b_finance_read_v1.sql';
const Q4_PATH = 'supabase/migrations/20261018020100_hermes_w2b_monthly_pnl_keys_v1.sql';
const main = readFileSync(MAIN_PATH, 'utf8');
let shared;
before(async () => { shared = await sharedW2b(); });
after(async () => { await shared?.close(); });
const inCase = work => shared.isolated(work);
const code = expected => error => error.code === expected;
const sorted = values => [...values].sort();
const stripComments = sql => sql.replace(/--[^\n]*/g, '');
const RESTRICTED = 'income_expenses.restricted_view';

// Broker → SQL → broker: tham số chuẩn hoá bằng chính khai báo JS, kết quả qua rào đầu ra của broker.
const identity = (permission, buildings = [BUILDING, OTHER_BUILDING]) => ({ row: { organizationId: ORG }, effective: { read: [permission], action: [] },
  scopesByPermission: { [permission]: { buildingIds: buildings, cashbookIds: [] } } });
const block = (sql, name) => {
  const found = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}\\([\\s\\S]*?\\$fn\\$;`, 'g'));
  assert.ok(found, name); return found.at(-1);
};
const READER = block(main, 'app_private.hermes_w2b_read_v1');
const RECORDER = `CREATE OR REPLACE FUNCTION app_private.hermes_w2b_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
  RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  BEGIN INSERT INTO public.fixture_w2b_ctx(ctx) VALUES(p_ctx);
    RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable',NULL); END $fn$;`;
// Cổng (quyền, tham số, toà, khoá phụ) → ctx; gói dưới vai authenticated; trang như cổng; rào đầu ra broker.
async function run(env, report, params = {}, { limit = 50, offset = 0, actor = USER } = {}) {
  const input = W2.reads.report.input({ report, params, limit, offset });
  await env.db.exec(RECORDER);
  let gate;
  try { gate = await env.report(report, input.params, { limit, offset }, undefined, { actor }); } finally { await env.db.exec(READER); }
  const check = value => W2.reads.report.result(value, identity(W2B_REPORTS[report].permission), input);
  if (gate.unavailable !== null) return check(gate);
  const ctx = (await env.db.query('SELECT ctx FROM public.fixture_w2b_ctx ORDER BY n DESC LIMIT 1')).rows[0].ctx;
  const raw = await env.call('SELECT app_private.hermes_w2b_read_v1($1,$2::jsonb,$3::jsonb) result', [report, JSON.stringify(input.params), JSON.stringify(ctx)],
    { role: 'authenticated', actor });
  const items = raw.unavailable === null ? raw.rows.slice(offset, offset + limit) : [];
  return check({ ...gate, unavailable: raw.unavailable, summary: raw.unavailable === null ? raw.summary : null, items,
    nextOffset: raw.unavailable === null && offset + items.length < raw.rows.length && items.length > 0 ? offset + items.length : null,
    sourceCapped: raw.unavailable === null ? raw.sourceCapped : false });
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
// Người hỏi thuộc thêm công ty khác (web lọc my_org_ids() ⇒ trộn hai công ty). Chỉ đổi my_org_ids: cổng Hermes
// từ chối người có hai membership thường (hermes_ordinary_org_ambiguous), còn RPC web chỉ đọc my_org_ids().
const secondOrg = db => db.exec(`CREATE OR REPLACE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$
    SELECT CASE WHEN auth.uid()='${USER}'::uuid THEN ARRAY['${ORG}'::uuid,'${FOREIGN}'::uuid] ELSE '{}'::uuid[] END$$;`);

test('gói B: bảng báo cáo SQL (hermes_w2b_catalog_v1) khớp khai báo JS (W2B_REPORTS)', () => shared.isolated(env => assertPackageParity(env, 'b')));

test('cấu trúc: chỉ hàm hermes_w2b_* và bốn hàm dùng chung public; Q4 chỉ hai hàm đọc báo cáo; mọi hàm gói INVOKER search_path rỗng; ACL; không trợ lý cũ', () => inCase(async ({ db }) => {
  const created = sql => [...stripComments(sql).matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+\.[a-z0-9_]+)\(/g)].map(match => match[1]);
  const SHARED = ['public.cashbook_list_v1', 'public.finance_analysis_top_expenses_v1', 'public.profit_my_share_v1', 'public.profit_shareholder_summary_v1'];
  const mine = created(main);
  assert.ok(mine.every(name => SHARED.includes(name) || /^app_private\.hermes_w2b_[a-z0-9_]+$/.test(name)), mine.join(','));
  assert.ok(mine.includes('app_private.hermes_w2b_catalog_v1') && mine.includes('app_private.hermes_w2b_read_v1'));
  assert.deepEqual(sorted(created(readFileSync(Q4_PATH, 'utf8'))), ['app_private.hermes_report_catalog_v1', 'app_private.hermes_report_read_v2']);
  for (const sql of [main, readFileSync(Q4_PATH, 'utf8')]) {
    assert.doesNotMatch(sql, /copilot/i, 'không có chữ của trợ lý cũ');
    assert.doesNotMatch(stripComments(sql), /\bDROP\b|ALTER TABLE|INSERT INTO|UPDATE public|DELETE FROM|hermes_capabilities SET/i);
  }
  const procs = (await db.query(`SELECT n.nspname||'.'||p.proname name,p.prosecdef definer,p.proconfig config,p.provolatile vol,
      has_function_privilege('authenticated',p.oid,'EXECUTE') auth,has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('service_role',p.oid,'EXECUTE') service FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname||'.'||p.proname=ANY($1)`, [[...new Set(mine)]])).rows;
  assert.equal(procs.length, new Set(mine).size);
  const FRAME = ['app_private.hermes_w2b_catalog_v1', 'app_private.hermes_w2b_read_v1'];
  const live = (await db.query("SELECT has_function_privilege('authenticated','app_private.hermes_w2b_read_v1(text,jsonb,jsonb)','EXECUTE') v")).rows[0].v;
  for (const proc of procs) {
    // Hai hàm khung giữ ACL của nền (fixture cấp EXECUTE cho hàm đọc để giả lập cổng INVOKER mới).
    assert.deepEqual([proc.auth, proc.anon, proc.service], [FRAME.includes(proc.name) ? proc.name.endsWith('read_v1') && live : true, false, false], proc.name);
    assert.equal(proc.definer, false, `${proc.name}: INVOKER`);
    assert.deepEqual(proc.config, ['search_path=""'], `${proc.name}: search_path rỗng`);
  }
  assert.doesNotMatch(stripComments(main), /SECURITY DEFINER/, 'không hàm DEFINER nào trong gói');
  // Hàm dùng chung và hàm đọc gói tự từ chối khi KHÔNG chạy dưới vai authenticated (vd. bị cổng DEFINER gọi).
  for (const sql of ['SELECT count(*) FROM public.cashbook_list_v1($1::uuid)', 'SELECT count(*) FROM public.finance_analysis_top_expenses_v1($1::uuid,current_date,current_date)',
    'SELECT public.profit_my_share_v1($1::uuid)', 'SELECT public.profit_shareholder_summary_v1($1::uuid)'])
  {
    await db.exec('SAVEPOINT role_check');
    const failed = await db.exec(`SELECT set_config('request.jwt.claim.sub','${USER}',true); ${sql.replace('$1', `'${ORG}'`)}`).then(() => null, error => error);
    await db.exec('ROLLBACK TO SAVEPOINT role_check; RELEASE SAVEPOINT role_check');
    assert.equal(failed?.code, '42501', sql);
  }
}));

test('B1 sổ quỹ theo ngày = RPC web cashbook_opening_balance + cashflow_by_day (từng toà khi kết nối theo toà; "Tất cả" khi Toàn tổ chức)', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await grantRead(db, ['reports_finance.daily_cashbook'], { orgWide: true });
  const range = { fromDate: '2026-10-01', toDate: '2026-10-12' };
  // Kết nối chỉ toà A: Hermes = RPC web với p_building_id = A.
  let value = await all(env, 'cashbook_daily', range);
  const webOpeningA = num(await web(env, 'public.cashbook_opening_balance($1::date,$2::uuid,NULL)', [range.fromDate, BUILDING]));
  const webDaysA = await webRows(env, 'SELECT * FROM public.cashflow_by_day($1::date,$2::date,$3::uuid,NULL)', [range.fromDate, range.toDate, BUILDING]);
  assert.deepEqual([webOpeningA, webDaysA.map(row => [row.day, num(row.income), num(row.expense)])],
    [540000, [['2026-10-02', 1200000, 0], ['2026-10-10', 0, 50000]]], 'web: toà A, bút toán REVERSAL tính, OTHER không');
  assert.equal(value.items.length, 12, 'mỗi ngày một dòng như web, ngày không phát sinh = 0');
  assert.deepEqual(value.summary, { fromDate: '2026-10-01', toDate: '2026-10-12', cashbookId: null, openingBalance: '540000.00', totalIncome: '1200000.00',
    totalExpense: '50000.00', closingBalance: '1690000.00' });
  const day = date => value.items.find(row => row.date === date);
  assert.deepEqual(day('2026-10-02'), { date: '2026-10-02', opening: '540000.00', income: '1200000.00', expense: '0', closing: '1740000.00' });
  assert.equal(day('2026-10-12').closing, '1690000.00');
  // Toàn tổ chức + khoá toàn công ty: như "Tất cả" của web (gồm bút toán không gắn toà).
  await orgOverlay(db);
  value = await all(env, 'cashbook_daily', range);
  const webOpening = num(await web(env, 'public.cashbook_opening_balance($1::date,NULL,NULL)', [range.fromDate]));
  const webTotals = await web(env, 'public.cashbook_period_totals($1::date,$2::date,NULL,NULL)', [range.fromDate, range.toDate]);
  assert.deepEqual([num(value.summary.openingBalance), num(value.summary.totalIncome), num(value.summary.totalExpense)],
    [webOpening, num(webTotals.income), num(webTotals.expense)]);
  assert.deepEqual([webOpening, num(webTotals.income), num(webTotals.expense)], [540000, 1300000, 350000]);
  value = await all(env, 'cashbook_daily', { ...range, buildingId: OTHER_BUILDING });
  assert.deepEqual([value.summary.totalIncome, value.summary.totalExpense], ['0', '300000.00'], 'buildingId thu hẹp về một toà');
  // Sổ người khác: không nhìn thấy ⇒ 42501; được giao giữ sổ (possession) ⇒ có, như web.
  await assert.rejects(run(env, 'cashbook_daily', { ...range, cashbookId: FOREIGN_CASHBOOK }), code('42501'));
  await db.exec(`INSERT INTO public.cashbook_possession_bindings(organization_id,cashbook_id,membership_id,possession_kind) VALUES('${ORG}','${FOREIGN_CASHBOOK}','${USER}','OPERATOR')`);
  value = await all(env, 'cashbook_daily', { ...range, cashbookId: FOREIGN_CASHBOOK });
  assert.deepEqual([value.summary.cashbookId, value.summary.totalIncome], [FOREIGN_CASHBOOK, '700000.00']);
  assert.equal((await all(env, 'cashbook_daily', range)).summary.totalIncome, '2000000.00', '"Tất cả" gồm sổ được giữ');
  // Mặc định đầu tháng → hôm nay (org_today = 16/10); khoảng > 366 ngày ⇒ 22023.
  assert.deepEqual([(await all(env, 'cashbook_daily')).items.length, (await all(env, 'cashbook_daily')).summary.fromDate], [16, '2026-10-01']);
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
  const daily = await all(env, 'cashbook_daily', range);
  assert.equal(daily.summary.totalIncome, '1300000.00', 'Hermes chỉ công ty của kết nối');
  await assert.rejects(run(env, 'cashbook_daily', { ...range, cashbookId: FOREIGN_ORG_BOOK }), code('42501'), 'sổ công ty khác');
  const flow = await all(env, 'cash_flow', { year: 2026 });
  assert.equal(flow.summary.income, '1840000.00');
}));

test('B2 dòng tiền năm = cashflow_by_day cả năm gộp 12 tháng + 4 quý như CashFlowReport', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await grantRead(db, ['reports_finance.cash_flow'], { orgWide: true });
  await orgOverlay(db);
  const value = await all(env, 'cash_flow', { year: 2026 });
  const webDays = await webRows(env, "SELECT * FROM public.cashflow_by_day('2026-01-01','2026-12-31',NULL,NULL)");
  const byMonth = Array.from({ length: 12 }, (_, i) => webDays.filter(row => Number(row.day.slice(5, 7)) === i + 1)
    .reduce((sum, row) => [sum[0] + num(row.income), sum[1] + num(row.expense)], [0, 0]));
  assert.deepEqual(value.items.slice(0, 12).map(row => [row.period, num(row.income), num(row.expense), num(row.net)]),
    byMonth.map(([income, expense], i) => [`2026-${String(i + 1).padStart(2, '0')}`, income, expense, income - expense]));
  assert.deepEqual(value.items.slice(12).map(row => [row.period, num(row.income), num(row.expense)]),
    [['2026-Q1', 40000, 0], ['2026-Q2', 0, 0], ['2026-Q3', 500000, 0], ['2026-Q4', 1300000, 350000]]);
  assert.deepEqual(value.summary, { year: 2026, income: '1840000.00', expense: '350000.00', net: '1490000.00' });
  assert.equal((await all(env, 'cash_flow')).summary.year, 2026, 'mặc định năm của hôm nay');
  await db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='reports_finance.cash_flow'");
  await assert.rejects(run(env, 'cash_flow', { year: 2026 }), code('42501'), 'không còn quyền CRM');
}));

test('B3 sổ quỹ = hàm dùng chung cashbook_list_v1: sổ nhìn thấy của đúng công ty, tồn chỉ khi balanceVisible, không số tài khoản', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await grantRead(db, ['cashbooks.view'], { orgWide: true });
  assert.equal((await run(env, 'cashbooks')).unavailable, 'organization_scope_required', 'sổ quỹ không theo toà ⇒ cần Toàn tổ chức');
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
  // Khoá web cashbooks.view: cổng Hermes kiểm; hàm dùng chung chỉ dựa RLS (không chép policy, không tự kiểm khoá).
  await db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='cashbooks.view'");
  await assert.rejects(run(env, 'cashbooks'), code('42501'));
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
  await assert.rejects(run(env, 'cashbook_closings', { cashbookId: FOREIGN_CASHBOOK }), code('42501'));
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
  assert.deepEqual(project(value.items), [['2026-10-01', 'EXPENSE', 'Sửa chữa', 800000, 1]]);
  assert.deepEqual(value.summary, { basis: 'cash', restrictedIncluded: false });
  await grantRead(db, [RESTRICTED]);
  value = await all(env, 'fa_type_breakdown', { ...range, basis: 'cash' });
  assert.deepEqual([project(value.items), value.summary.restrictedIncluded], [webCash, true], 'đủ quyền ⇒ đúng bằng web');
  value = await all(env, 'fa_type_breakdown', range);
  assert.deepEqual([project(value.items), value.summary.basis], [await webBreak('fa_type_breakdown_accrual', [BUILDING]), 'accrual'], 'mặc định dồn tích như web');
  // Toàn tổ chức nhưng restricted_view chỉ ở toà A ⇒ không phủ toà B ⇒ ẩn hạng mục hạn chế.
  await orgOverlay(db);
  await db.exec(`UPDATE public.fixture_acl SET building_ids=ARRAY['${BUILDING}'::uuid] WHERE permission='${RESTRICTED}'`);
  value = await all(env, 'fa_type_breakdown', { ...range, basis: 'cash' });
  assert.deepEqual([project(value.items), value.summary.restrictedIncluded], [[['2026-10-01', 'EXPENSE', 'Sửa chữa', 1400000, 2]], false]);
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
    assert.ok(snap.items.every(row => buildings.includes(row.buildingId)) && coll.items.every(row => buildings.includes(row.buildingId)));
  }
  assert.deepEqual((await all(env, 'fa_snapshot_kpis', { buildingId: OTHER_BUILDING })).items.map(row => row.buildingId), [OTHER_BUILDING]);
}));

test('B7 10 khoản chi lớn = hàm dùng chung (INVOKER) trên toà kết nối; phiếu hạn chế của người khác chỉ khi restricted_view phủ mọi toà', { timeout: 120000 }, () => inCase(async env => {
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
  assert.equal((await webRows(env, "SELECT * FROM public.finance_analysis_top_expenses_v1($1::uuid,'2026-10-01','2026-10-31',NULL,10)", [ORG])).length, 4, 'NULL = toàn phạm vi RLS');
  assert.equal((await webRows(env, "SELECT * FROM public.finance_analysis_top_expenses_v1($1::uuid,'2026-10-01','2026-10-31','{}',10)", [ORG])).length, 0, "'{}' = rỗng");
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
  assert.deepEqual((await all(env, 'bp_categories', range)).items.map(row => [row.typeName, num(row.totalAmount)]), [['Lương', 5300000], ['Sửa chữa', 800000]]);
  // Kết nối KHÔNG chọn restricted_view (dù CRM có) ⇒ 42501: overlay là hàng rào.
  await db.exec(`UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'${RESTRICTED}')`);
  await assert.rejects(run(env, 'bp_pnl', range), code('42501'));
  // Toà ảo không bao giờ vào RPC (web roster chỉ toà thật).
  await orgOverlay(db, false);
  await db.exec(`UPDATE public.fixture_acl SET building_ids=ARRAY['${OTHER_BUILDING}'::uuid] WHERE permission='reports_finance.analysis'`);
  assert.equal((await run(env, 'bp_pnl', range)).unavailable, 'no_building_scope');
}));

test('B10 cổ đông tự xem: chỉ phần của CHÍNH người hỏi trong công ty, theo toà kết nối; luỹ kế được chia/đã ứng/còn lại như ShareholderSelfView', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await grantRead(db, ['reports_finance.profit_distribution'], { orgWide: true });
  let value = await all(env, 'profit_my_share');
  assert.deepEqual(value.items.map(row => [row.periodMonth, row.buildingId, row.status, row.amount]),
    [['2026-09-01', BUILDING, 'LOCKED', '3000000'], ['2025-10-01', BUILDING, 'LOCKED', '600000']], 'kết nối chỉ toà A');
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
}));

test('B10 quản lý: cần shareholder_profit.view + Toàn tổ chức; dòng nhìn thấy như RLS (người tạo, chủ công ty, super admin, chính cổ đông)', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await grantRead(db, ['shareholder_profit.view'], { orgWide: true });
  assert.equal((await run(env, 'profit_shareholders')).unavailable, 'organization_scope_required');
  await orgOverlay(db);
  let value = await all(env, 'profit_shareholders', { year: 2026 });
  assert.deepEqual(value.items.map(row => [row.shareholderId, row.accrued, row.paid, row.remaining, row.yearAccrued]),
    [[SH_ME, '4800000', '1200000.00', '3600000.00', '4200000']], 'không phải chủ/người tạo: chỉ dòng của chính mình (RLS self)');
  assert.equal(value.summary.lockedProfit, '16000000', 'chỉ kỳ chốt có phần của mình');
  await db.exec(`INSERT INTO public.fixture_company_owners VALUES('${ORG}','${USER}')`);
  value = await all(env, 'profit_shareholders');
  assert.deepEqual(value.items.map(row => [row.name, row.accrued, row.paid, row.yearAccrued]),
    [['Cổ đông Khác', '7000000', '2500000.00', null], ['Cổ đông Tôi', '4800000', '1200000.00', null]]);
  assert.deepEqual(value.summary, { lockedProfit: '16000000', accrued: '11800000', paid: '3700000.00', remaining: '8100000.00' });
  const webSummary = await web(env, 'public.profit_shareholder_summary_v1($1::uuid,NULL)', [ORG]);
  assert.deepEqual(webSummary.shareholders.map(row => num(row.remaining)), value.items.map(row => num(row.remaining)));
  await db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='shareholder_profit.view'");
  await assert.rejects(run(env, 'profit_shareholders'), code('42501'));
  // Hàm dùng chung chỉ dựa RLS: người không phải cổ đông/chủ/người tạo không thấy dòng nào.
  assert.deepEqual((await web(env, 'public.profit_shareholder_summary_v1($1::uuid,NULL)', [ORG], FOREIGN)).shareholders, []);
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
  assert.deepEqual(wallets.summary, { totalBalance: '1900000', wallets: 2 });
  let tx = await all(env, 'personal_transactions');
  assert.deepEqual(tx.items.map(row => [row.date, row.type, row.amount, row.categoryName, row.walletName]),
    [['2026-10-06', 'EXPENSE', '150000', 'Ăn uống', 'Ví chính'], ['2026-10-05', 'INCOME', '2000000', null, 'Ví chính'], ['2026-09-30', 'EXPENSE', '50000', 'Ăn uống', 'Ví chính']]);
  assert.deepEqual(tx.summary, { income: '2000000', expense: '200000', transactions: 3 });
  assert.equal((await all(env, 'personal_transactions', { kind: 'EXPENSE', fromDate: '2026-10-01' })).items.length, 1);
  assert.equal((await all(env, 'personal_transactions', { query: 'ăn uống' })).items.length, 2);
  assert.ok(!JSON.stringify([wallets, tx]).includes('777777') && !JSON.stringify(tx).includes('123456'), 'không bao giờ dữ liệu người khác');
  assert.equal((await db.query("SELECT count(*)::int n FROM public.personal_wallets")).rows[0].n, 3, 'không ghi (không bootstrap)');
}));

test('B11 biến động số dư: chỉ super admin; chỉ siêu dữ liệu (không bản mã, không số tiền), không ghi dấu vết xem nội dung', { timeout: 120000 }, () => inCase(async env => {
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

test('rào đầu ra broker: hàng nêu toà ngoài phạm vi CRM của khoá, sai nguồn hoặc trường lạ ⇒ từ chối', () => {
  const input = W2.reads.report.input({ report: 'fa_snapshot_kpis', params: {}, limit: 20, offset: 0 });
  const row = { buildingId: BUILDING, buildingName: 'Toà A', totalRooms: 1, roomsAvailable: 0, roomsOccupied: 1, roomsReserved: 0, roomsMaintenance: 0,
    roomsUnavailable: 0, vacancyLossMonth: '0', activeContracts: 1, avgRent: '1', depositHeld: '0', receivableTotal: '0', agingNotDue: '0', aging1To30: '0',
    aging31To60: '0', aging61To90: '0', agingOver90: '0' };
  const value = { organizationId: ORG, domain: 'report', fetchedAt: '2026-10-18T00:00:00.000Z', report: 'fa_snapshot_kpis', source: 'crm.fa_snapshot_kpis',
    unavailable: null, summary: null, items: [row], offset: 0, nextOffset: null, sourceCapped: false };
  assert.equal(W2.reads.report.result(value, identity('reports_finance.analysis'), input).items.length, 1);
  for (const bad of [{ ...value, items: [{ ...row, buildingId: FOREIGN }] }, { ...value, source: 'crm.fa_monthly_pnl' }, { ...value, items: [{ ...row, phone: '1' }] }])
    assert.throws(() => W2.reads.report.result(bad, identity('reports_finance.analysis'), input));
  assert.throws(() => W2.reads.report.result(value, identity('reports_finance.analysis', [OTHER_BUILDING]), input), 'phạm vi CRM rào đầu ra');
  for (const [report, spec] of Object.entries(W2B_REPORTS))
    if (['self', 'organization'].includes(spec.scope)) assert.ok(!Object.hasOwn(spec.fields, 'buildingId'), `${report}: self/organization không nêu toà`);
});

// Đột biến: mỗi bản bỏ MỘT hàng rào của gói B; cùng phép thử mà bản sống từ chối thì bản đột biến phải lọt.
const replaceExactly = (from, to) => { assert.equal(main.split(from).length, 2, `anchor: ${from}`); return main.replace(from, () => to); };
const probes = [
  { name: 'chốt sổ chỉ sổ nhìn thấy (chặt hơn web)', sql: replaceExactly(`    WHERE (v_status IS NULL OR v_status='CONFIRMED') AND (e->>'cashbook_id')::uuid=ANY(v_books)`,
    `    WHERE (v_status IS NULL OR v_status='CONFIRMED')`),
    run: async env => { await grantRead(env.db, ['cashbooks.view'], { orgWide: true }); await orgOverlay(env.db);
      return (await all(env, 'cashbook_closings')).items.some(row => row.cashbookId === FOREIGN_CASHBOOK); } },
  { name: 'sổ quỹ chỉ của công ty kết nối', sql: replaceExactly(`  WHERE a.organization_id=(p_ctx->>'organizationId')::uuid AND a.deleted_at IS NULL
    AND (NOT (p_ctx ? 'cashbookIds')`, `  WHERE a.deleted_at IS NULL
    AND (NOT (p_ctx ? 'cashbookIds')`),
    run: async env => { await grantRead(env.db, ['reports_finance.daily_cashbook'], { orgWide: true }); await orgOverlay(env.db); await secondOrg(env.db);
      return (await all(env, 'cashbook_daily', { fromDate: '2026-10-01', toDate: '2026-10-12' })).summary.totalIncome !== '1300000.00'; } },
  { name: 'người nhiều công ty: gọi từng sổ thay vì "Tất cả" của web', sql: replaceExactly(
    `  ELSIF EXISTS(SELECT 1 FROM public.accounts v WHERE v.deleted_at IS NULL AND NOT v.id=ANY(v_books)) THEN v_accounts:=v_books;\n`, ''),
    run: async env => { await grantRead(env.db, ['reports_finance.daily_cashbook'], { orgWide: true }); await orgOverlay(env.db); await secondOrg(env.db);
      return (await all(env, 'cashbook_daily', { fromDate: '2026-10-01', toDate: '2026-10-12' })).summary.totalIncome !== '1300000.00'; } },
  { name: '"Tất cả toà" chỉ khi Toàn tổ chức', sql: replaceExactly(`  v_buildings:=CASE WHEN p_ctx->'orgWide'='true'::jsonb THEN ARRAY[NULL::uuid]`, `  v_buildings:=CASE WHEN true THEN ARRAY[NULL::uuid]`),
    run: async env => { await grantRead(env.db, ['reports_finance.daily_cashbook'], { orgWide: true });
      return (await all(env, 'cashbook_daily', { fromDate: '2026-10-01', toDate: '2026-10-12' })).summary.totalExpense !== '50000.00'; } },
  { name: 'sổ được hỏi phải thuộc sổ của báo cáo', sql: replaceExactly(`    IF NOT v_book=ANY(v_books) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    v_accounts:=ARRAY[v_book];`, `    v_accounts:=ARRAY[v_book];`),
    run: async env => { await grantRead(env.db, ['reports_finance.daily_cashbook'], { orgWide: true }); await orgOverlay(env.db); await secondOrg(env.db);
      return (await all(env, 'cashbook_daily', { fromDate: '2026-10-01', toDate: '2026-10-12', cashbookId: FOREIGN_ORG_BOOK })).summary.totalIncome === '9999.00'; } },
  { name: 'hạng mục hạn chế cần restricted_view phủ mọi toà', sql: replaceExactly(` SELECT cardinality(COALESCE(p_buildings,'{}'::uuid[]))>0
   AND jsonb_typeof(`, ` SELECT true OR cardinality(COALESCE(p_buildings,'{}'::uuid[]))>0
   AND jsonb_typeof(`),
    run: async env => (await all(env, 'fa_type_breakdown', { fromDate: '2026-10-01', toDate: '2026-10-31', basis: 'cash' })).items.some(row => row.typeName === 'Lương') },
  { name: 'chi lớn: phiếu hạn chế người khác cần restricted_view phủ toà', sql: replaceExactly(` AND (NOT t.has_restricted_item OR t.user_id=auth.uid() OR v_ok)`, ''),
    run: async env => { await env.db.exec(`INSERT INTO public.fixture_acl(permission,building_ids) VALUES('${RESTRICTED}',ARRAY['${OTHER_BUILDING}'::uuid])`);
      return (await all(env, 'top_expenses', { month: '2026-10' })).items.some(row => row.code === 'PC-402'); } },
  { name: 'Hiệu quả kinh doanh: restricted_view của kết nối', sql: replaceExactly(`
        AND app_private.hermes_w2b_restricted_ok_v1(p_ctx,ARRAY[(e->>'id')::uuid])),'{}'::uuid[])`, `),'{}'::uuid[])`),
    run: async env => { await orgOverlay(env.db); await grantRead(env.db, [RESTRICTED]);
      await env.db.exec(`UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'${RESTRICTED}')`);
      return (await all(env, 'bp_pnl', { fromDate: '2026-10-01', toDate: '2026-10-31' })).items.length > 0; } },
  { name: 'toà của báo cáo = ctx.buildings', sql: replaceExactly(`   FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_ctx->'buildings')='array' THEN p_ctx->'buildings' ELSE '[]'::jsonb END) x`,
    `   FROM (SELECT id::text FROM public.buildings) b(x)`),
    run: async env => (await all(env, 'fa_type_breakdown', { fromDate: '2026-10-01', toDate: '2026-10-31', basis: 'cash' })).items.some(row => num(row.totalAmount) === 1400000) },
  { name: 'tổng quan cổ đông: chỉ cổ đông của đúng công ty', sql: replaceExactly(`    SELECT s.id,s.name FROM public.shareholders s WHERE s.organization_id=p_organization_id AND s.deleted_at IS NULL`,
    `    SELECT s.id,s.name FROM public.shareholders s WHERE s.deleted_at IS NULL`),
    run: async env => { await grantRead(env.db, ['shareholder_profit.view'], { orgWide: true }); await orgOverlay(env.db);
      return (await all(env, 'profit_shareholders')).items.some(row => row.name === 'Cổ đông ngoài'); } },
  { name: 'cổ đông tự xem: chỉ toà kết nối', sql: replaceExactly(`    v_raw:=public.profit_my_share_v1(v_org,v_buildings);`, `    v_raw:=public.profit_my_share_v1(v_org,NULL); v_buildings:=ARRAY(SELECT id FROM public.buildings);`),
    run: async env => { await grantRead(env.db, ['reports_finance.profit_distribution'], { orgWide: true });
      return (await all(env, 'profit_my_share')).items.some(row => row.buildingId === OTHER_BUILDING); } },
  { name: 'hàm dùng chung sổ quỹ: đúng một công ty', sql: replaceExactly(`  JOIN public.accounts o ON o.id=a.id AND o.organization_id=p_organization_id`, `  JOIN public.accounts o ON o.id=a.id`),
    run: async env => { await secondOrg(env.db);
      return (await webRows(env, 'SELECT cashbook_id FROM public.cashbook_list_v1($1::uuid)', [ORG])).some(row => row.cashbook_id === FOREIGN_ORG_BOOK); } },
  { name: 'hàm dùng chung: chỉ chạy dưới vai authenticated', sql: replaceExactly(`  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'profit_summary_denied'`, `  IF auth.uid() IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'profit_summary_denied'`),
    run: async env => { await env.db.exec(`SELECT set_config('request.jwt.claim.sub','${USER}',true)`);
      return (await env.db.query(`SELECT jsonb_array_length(public.profit_shareholder_summary_v1('${ORG}')->'shareholders') n`)).rows[0].n > 1; } },
  { name: 'biến động số dư chỉ super admin ở gói (ngoài cổng)', sql: replaceExactly(`  IF p_ctx->'isSuperadmin' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;\n  v_status`, '  v_status'),
    run: async env => { await env.db.exec(`INSERT INTO public.super_admins VALUES('${USER}')`);
      const ctx = { organizationId: ORG, userId: USER, report: 'bank_event_feed', permission: 'assistant.bank_events.read', scope: 'self', buildings: [],
        requestedBuildingId: null, overlayOrg: false, orgWide: false, isSuperadmin: false, today: '2026-10-16', scopes: {} };
      const value = await env.call('SELECT app_private.hermes_w2b_read_v1($1,$2::jsonb,$3::jsonb) result', ['bank_event_feed',
        JSON.stringify({ fromDate: null, toDate: null, kind: null }), JSON.stringify(ctx)], { role: 'authenticated' });
      return value.rows.length > 0; } },
];
for (const probe of probes) {
  const changed = changedFunctions(main, probe.sql);
  test(`mutation is caught: ${probe.name}`, { timeout: 120000 }, async () => {
    await inCase(async env => assert.equal(await probe.run(env).catch(() => false), false, 'bản sống từ chối'));
    await inCase(async env => {
      for (const sql of changed) await env.db.exec(sql);
      assert.equal(await probe.run(env), true, 'bản đột biến lọt');
    });
  });
}
