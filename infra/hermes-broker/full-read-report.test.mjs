import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { sharedFullRead, changedFunctions, fullReadParitySql, fullReadOwnerSql, FULL_READ_PARITY_PATH, FULL_READ_OWNER_PATH, REPORT_KEYS, USER, BUILDING, OTHER_BUILDING, ROOM, ORG_SCOPE, binding, ORG, FOREIGN,
  CONTRACT_A, CONTRACT_B, INVOICE_A, INVOICE_B, INVOICE_CANCELLED, INVOICE_PARTIAL, PENDING, FOREIGN_PENDING, VOUCHER, CONVERSATION, ZALO_PHONE,
  PHONE_A, CO_TENANT, CUSTOMER_A } from './full-read-sql-fixture.mjs';
import { CATEGORY } from './finance-fixture.mjs';
import { DOMAIN_READS, DOMAIN_TOOLS, domainInput, domainResult, mayUseDomain } from './domain-contract.mjs';
import { REPORTS, PRIVATE_HINT } from './full-read-contract.mjs';
import { W2_FOUNDATION_PATH } from './wave2-sql-paths.mjs';

// Báo cáo khớp màn web (họ v3, 20261017021554): nguồn là RPC web THẬT (định nghĩa cuối
// trong baseline/migration, nạp vào PGlite) hoặc SQL theo bộ lọc web; không hàm copilot_*
// nào tồn tại trong fixture. Khoá ĐÃ CÓ, lọc theo toà đã giao, Toàn tổ chức cho nguồn
// không lọc được theo toà. Hộp duyệt list_my_pending_approvals_v1 là cổng tổng hợp cùng chữ ký.
const code = expected => error => error.code === expected;
const uid = n => `0e0e0e0e-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`;
const identity = permission => ({ row: { organizationId: ORG }, scopesByPermission: { [permission]: { buildingIds: [BUILDING, OTHER_BUILDING] } } });
// Một PGlite cho cả file; mỗi ca chạy trong BEGIN … ROLLBACK (inCase), đột biến chỉ thay thân hàm trong ca.
let shared;
before(async () => { shared = await sharedFullRead({ reads: REPORT_KEYS }); });
after(async () => { await shared?.close(); });
const inCase = work => shared.isolated(work);
const sorted = values => [...values].sort();
async function run(env, domain, args) {
  const input = domainInput(domain, args), value = await env.read3(domain, input);
  return { value, checked: domainResult(domain, value, identity(DOMAIN_READS[domain].permission), input) };
}
async function orgWideOverlay(db, on = true, crm = on) {
  for (const table of ['hermes_connections', 'hermes_org_policies'])
    await db.query(on ? `UPDATE app_private.${table} SET scope_ids=array_append(scope_ids,$1::uuid)` : `UPDATE app_private.${table} SET scope_ids=array_remove(scope_ids,$1::uuid)`, [ORG_SCOPE]);
  await db.query('UPDATE public.fixture_acl SET org_wide=$1', [crm]);
}
const grantCustomers = db => db.exec(`UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='customers.view';
  UPDATE app_private.hermes_org_policies SET read_capabilities=read_capabilities||ARRAY['customers.view'];
  UPDATE app_private.hermes_connections SET read_capabilities=read_capabilities||ARRAY['customers.view']`);
// Gọi thẳng RPC web như người dùng (jwt sub = USER) để so từng con số với Hermes.
const web = (env, sql, args = []) => env.call(sql, args, { role: 'postgres' });

// Phòng toà A thêm cho lấp đầy: P102 ghi OCCUPIED nhưng không có hợp đồng (snapshot web xếp
// "không khai thác", rooms.status đếm là đang ở), P103 trống có giá, P104 giữ chỗ.
const P102 = uid(1), P103 = uid(2), P104 = uid(3);
const seedRooms = db => db.exec(`INSERT INTO public.rooms(id,organization_id,building_id,name,status,rent_price) VALUES
  ('${P102}','${ORG}','${BUILDING}','P102','OCCUPIED',null),('${P103}','${ORG}','${BUILDING}','P103','AVAILABLE',2000000),
  ('${P104}','${ORG}','${BUILDING}','P104','RESERVED',1800000)`);
// Phiếu cho lãi lỗ: V1 thu 1,2tr phân bổ T8–T10, V2 chi 0,3tr T9 không hạng mục (đã duyệt);
// chờ duyệt: V3 chi 0,5tr T10 không kỳ, V5 thu 0,9tr phân bổ T9–T11, V4 thu 0,7tr ở toà B.
const [V1, V2, V3, V4, V5] = [11, 12, 13, 14, 15].map(uid);
const seedPnl = db => db.exec(`INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,voucher_date,total_amount,approval_status,kqkd_amount) VALUES
  ('${V1}','${ORG}','${USER}','PT-1','INCOME','Thu thuê 3 tháng','${BUILDING}','2026-08-10',1200000,'APPROVED',1200000),
  ('${V2}','${ORG}','${USER}','PC-2','EXPENSE','Sửa điện','${BUILDING}','2026-09-05',300000,'APPROVED',300000),
  ('${V3}','${ORG}','${USER}','PC-3','EXPENSE','Sơn lại','${BUILDING}','2026-10-02',500000,'UNAPPROVED',500000),
  ('${V4}','${ORG}','${USER}','PT-4','INCOME','Thu toà B','${OTHER_BUILDING}','2026-10-03',700000,'UNAPPROVED',700000),
  ('${V5}','${ORG}','${USER}','PT-5','INCOME','Thu trước 3 tháng','${BUILDING}','2026-09-20',900000,'UNAPPROVED',900000);
  INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,amount,accounting_class,start_date,end_date) VALUES
  ('${V1}','${CATEGORY}',1200000,'PNL','2026-08-01','2026-10-31'),('${V3}','${CATEGORY}',500000,'PNL',null,null),
  ('${V5}','${CATEGORY}',900000,'PNL','2026-09-01','2026-11-30')`);
// Hoá đơn thêm ở toà A: một huỷ, một thu một phần.
const seedInvoices = db => db.exec(`INSERT INTO public.invoices(id,organization_id,invoice_number,status,building_id,room_id,billing_month,due_date,total_amount,paid_amount) VALUES
  ('${INVOICE_CANCELLED}','${ORG}','INV-C','CANCELLED','${BUILDING}','${ROOM}','2026-10','2026-10-10',800000,0),
  ('${INVOICE_PARTIAL}','${ORG}','INV-P','PARTIAL_PAID','${BUILDING}','${ROOM}','2026-10','2026-10-10',600000,200000)`);
// Hợp đồng thêm ở P101 cho nhãn/bộ lọc web (hôm nay theo fixture = 2026-10-16).
const [C_EXPIRED, C_EXPIRING, C_MOVING, C_TERMINATED, C_TRANSFERRED] = [21, 22, 23, 24, 25].map(uid);
const seedContracts = db => db.exec(`INSERT INTO public.contracts(id,organization_id,room_id,status,total_deposit,deposit_paid,deposit_remaining,contract_number,
    start_date,end_date,expected_move_out_date,actual_end_date,rent_price) VALUES
  ('${C_EXPIRED}','${ORG}','${ROOM}','ACTIVE',0,0,0,'HD-QUA','2025-10-01','2026-10-01',null,null,1),
  ('${C_EXPIRING}','${ORG}','${ROOM}','ACTIVE',0,0,0,'HD-SAP','2025-11-10','2026-11-10',null,null,1),
  ('${C_MOVING}','${ORG}','${ROOM}','ACTIVE',0,0,0,'HD-DI','2025-11-05','2026-11-05','2026-10-30',null,1),
  ('${C_TERMINATED}','${ORG}','${ROOM}','TERMINATED',0,0,0,'HD-TL','2025-05-01','2026-05-01',null,'2026-05-01',1),
  ('${C_TRANSFERRED}','${ORG}','${ROOM}','TRANSFERRED',0,0,0,'HD-NH','2025-12-31','2026-12-31',null,null,1)`);

test('contract: one tool per existing permission key, SQL catalog matches the JS table, tools/list fragment stays small', () => inCase(async env => {
  const { db } = env;
  const expected = { occupancy_report: 'reports_real_estate.occupancy', invoice_report: 'invoices.view', monthly_pnl: 'reports_finance.analysis',
    pending_approvals: 'income_expenses.view', zalo_conversations: 'chat_zalo.view', contract_search: 'contracts.view' };
  assert.deepEqual(Object.fromEntries(Object.entries(REPORTS).map(([key, value]) => [key, value.permission])), expected);
  for (const [domain, { reports, permission }] of Object.entries(REPORTS)) {
    assert.equal(DOMAIN_READS[domain].permission, permission); assert.equal(DOMAIN_READS[domain].family, 'v3');
    assert.ok(mayUseDomain({ read: [permission] }, domain)); assert.equal(mayUseDomain({ read: ['rooms.view'] }, domain), false);
    for (const [name, spec] of Object.entries(reports)) {
      const sql = (await db.query('SELECT app_private.hermes_report_catalog_v1($1,$2) spec', [domain, name])).rows[0].spec;
      assert.deepEqual([sql.permission, sql.source, sql.scope, Boolean(sql.buildingFilter), Boolean(sql.month), Boolean(sql.fromDate), Boolean(sql.toDate),
        Boolean(sql.requiresDates), Boolean(sql.days), Boolean(sql.basis), sql.statuses ?? null],
      [permission, spec.source, spec.scope, spec.buildingFilter, spec.month, spec.fromDate, spec.toDate, spec.requiresDates, spec.days, spec.basis,
        spec.statuses ? [...spec.statuses] : null], `${domain}:${name}`);
      assert.doesNotMatch(spec.source, /copilot/, 'sources are the web RPCs/tables');
    }
    assert.equal((await db.query('SELECT app_private.hermes_report_catalog_v1($1,$2) spec', [domain, 'nope'])).rows[0].spec, null);
  }
  const tools = DOMAIN_TOOLS.filter(tool => Object.hasOwn(REPORTS, tool.name.slice(9)));
  assert.equal(tools.length, 6);
  assert.ok(Buffer.byteLength(JSON.stringify(tools)) < 8000, 'six report tools fit the remaining tools/list budget');
  for (const tool of tools) assert.doesNotMatch(tool.description, /copilot|hermes_|SELECT/i, tool.name);
  assert.match(DOMAIN_TOOLS.find(tool => tool.name === 'crm_read_zalo_conversations').description, new RegExp(PRIVATE_HINT));
  // R2b (21/10): câu đầu ≤ 60 ký tự chỉ sang thu chi (danh sách tool_search của Hermes chỉ hiện chừng đó).
  assert.match(DOMAIN_TOOLS.find(tool => tool.name === 'crm_read_pending_approvals').description, /^Chỉ "việc chờ TÔI duyệt"; phiếu chờ duyệt: income_expenses\./);
  assert.match(DOMAIN_TOOLS.find(tool => tool.name === 'crm_read_pending_approvals').description, /crm_read_income_expenses status=UNAPPROVED/);
  for (const bad of [{ report: 'nope' }, { report: 'search', status: 'PAID' }, { report: 'stats', days: 3 }, { report: 'search', month: '2026-13' },
    { report: 'search', limit: 51 }, { report: 'search', offset: -1 }, { report: 'search', query: 'a\nb' }, { report: 'search', organizationId: ORG },
    { report: 'search', basis: 'cash' }])
    assert.throws(() => domainInput('invoice_report', bad), JSON.stringify(bad));
  assert.throws(() => domainInput('monthly_pnl', { fromDate: '2026-01-01' }), 'requires both dates');
  assert.throws(() => domainInput('monthly_pnl', { fromDate: '2025-01-01', toDate: '2026-10-01' }), '≤ 366 days');
  assert.throws(() => domainInput('monthly_pnl', { fromDate: '2026-01-01', toDate: '2026-02-01', basis: 'kqkd' }), 'basis is accrual|cash');
  assert.equal(domainInput('monthly_pnl', { fromDate: '2026-01-01', toDate: '2026-02-01' }).basis, null, 'SQL defaults to accrual');
  assert.throws(() => domainInput('pending_approvals', { buildingId: BUILDING }), 'organization-only report has no building filter');
  assert.throws(() => domainInput('contract_search', { status: 'TRANSFERRED' }), 'only the web filter values');
  assert.equal(domainInput('contract_search', { buildingId: BUILDING }).buildingId, BUILDING, 'contract search filters by building');
}));

test('no copilot_*: the final Hermes full-read definitions (migrations and PGlite) never call a copilot function', () => inCase(async env => {
  const files = readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort();
  const names = ['public.hermes_domain_read_v3', 'app_private.hermes_report_read_v2', 'app_private.hermes_report_read_v1', 'app_private.hermes_report_catalog_v1',
    'app_private.hermes_pnl_pending_v1', 'app_private.hermes_full_read_scope_v1'];
  for (const name of names) {
    const pattern = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name.replaceAll('.', '\\.')}\\([\\s\\S]*?\\$fn\\$;`, 'g');
    const last = files.map(file => [file, [...readFileSync(`supabase/migrations/${file}`, 'utf8').matchAll(pattern)].at(-1)?.[0]]).filter(([, body]) => body).at(-1);
    assert.ok(last, name);
    if (['app_private.hermes_report_catalog_v1', 'app_private.hermes_pnl_pending_v1'].includes(name))
      assert.equal(`supabase/migrations/${last[0]}`, FULL_READ_PARITY_PATH, `${name} lives in the web-parity migration`);
    if (name === 'app_private.hermes_report_read_v2')
      assert.equal(`supabase/migrations/${last[0]}`, FULL_READ_OWNER_PATH, `${name} lives in the review-fix migration`);
    // Đợt 2 thay v3 MỘT lần (20261018000000): thêm định tuyến report/report_list, phần còn lại giữ nguyên
    // bản review-fix (wave2-foundation.test.mjs so từng ký tự); đột biến ở file này vẫn nhắm bản review-fix.
    // B5c bước 2 (20261020173819, dải nền hermes_w2_): customers thêm buildingName, mọi dòng khác giữ bản nền.
    if (name === 'public.hermes_domain_read_v3')
      assert.equal(`supabase/migrations/${last[0]}`, 'supabase/migrations/20261020173819_hermes_w2_customers_building_name_v1.sql', `${name} lives in the B5c wave-2 successor`);
    assert.doesNotMatch(last[1].replace(/--[^\n]*/g, ''), /copilot_/i, `${name} (${last[0]})`);
  }
  for (const sql of [fullReadParitySql(), fullReadOwnerSql(), readFileSync(W2_FOUNDATION_PATH, 'utf8')])
    assert.doesNotMatch(sql.replace(/--[^\n]*/g, ''), /copilot_/i, 'no copilot function call');
  // Bản thật trong PGlite sau cả ba migration: không thân hàm nào của chuỗi đọc đầy đủ nhắc copilot_.
  const { db } = env;
  const rows = (await db.query(`SELECT p.proname,p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('public','app_private') AND p.proname=ANY($1)`, [names.map(name => name.split('.')[1])])).rows;
  assert.equal(rows.length, names.length);
  for (const row of rows) assert.doesNotMatch(row.prosrc.replace(/--[^\n]*/g, ''), /copilot_/i, row.proname);
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_proc WHERE proname LIKE 'copilot%'")).rows[0].n, 0, 'fixture defines no copilot function');
}));

test('occupancy: snapshot/upcoming are the web RPCs on the connection buildings; crm_read_occupancy counts like the snapshot, not rooms.status', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await seedRooms(db);
  const snapshot = await run(env, 'occupancy_report', { report: 'snapshot' });
  assert.deepEqual(snapshot.value.items, [{ buildingId: BUILDING, buildingName: 'Toà A', total: 4, occupied: 1, reserved: 1, maintenance: 0, unavailable: 1,
    available: 1, occupancyPct: '25.00', committedPct: '50.00', missedRevenue: '2000000.00' }], 'overlay drops OTHER_BUILDING');
  assert.equal(snapshot.value.source, 'crm.occupancy_snapshot_v2');
  // Cùng con số với RPC web của trang Báo cáo lấp đầy (useOccupancyDashboard.ts, hermes-parity:occupancy-snapshot) hôm nay.
  const direct = await web(env, `SELECT jsonb_agg(jsonb_build_object('total',total,'occupied',occupied,'reserved',reserved,'maintenance',maintenance,
    'unavailable',unavailable,'available',available)) result FROM public.occupancy_snapshot_v2('2026-10-16',$1::uuid[])`, [[BUILDING]]);
  const [hermes] = snapshot.value.items;
  assert.deepEqual(direct, [{ total: hermes.total, occupied: hermes.occupied, reserved: hermes.reserved, maintenance: hermes.maintenance,
    unavailable: hermes.unavailable, available: hermes.available }]);
  // crm_read_occupancy (v3) dùng cùng snapshot: P102 ghi OCCUPIED nhưng không có hợp đồng ⇒ không đếm là đang ở.
  const statusCount = (await db.query(`SELECT count(*)::int n FROM public.rooms WHERE building_id=$1 AND status='OCCUPIED'`, [BUILDING])).rows[0].n;
  assert.equal(statusCount, 2, 'rooms.status would say two occupied');
  const input = domainInput('occupancy', {}), domain = await env.read3('occupancy', input);
  assert.deepEqual(domain.items, [{ id: BUILDING, buildingId: BUILDING, name: 'Toà A', total: 4, occupied: 1, available: 1 }]);
  assert.deepEqual(domainResult('occupancy', domain, identity('reports_real_estate.occupancy'), input).items, domain.items);
  // Phòng sắp trống: hợp đồng gia hạn đã duyệt đẩy ngày trống như web (contract_extensions).
  const upcoming = await run(env, 'occupancy_report', { report: 'upcoming', fromDate: '2026-12-15', days: 30 });
  assert.deepEqual(upcoming.value.items.map(row => [row.contractId, row.daysRemaining, row.extensionApplied]), [[CONTRACT_A, 17, false]]);
  await db.exec(`INSERT INTO public.contract_extensions(contract_id,status,new_end_date) VALUES('${CONTRACT_A}','APPROVED','2027-03-01')`);
  assert.deepEqual((await run(env, 'occupancy_report', { report: 'upcoming', fromDate: '2026-12-15', days: 30 })).value.items, []);
  const extended = (await run(env, 'occupancy_report', { report: 'upcoming', fromDate: '2026-12-15', days: 90 })).value.items;
  assert.deepEqual(extended.map(row => [row.contractId, row.effectiveEndDate, row.daysRemaining, row.extensionApplied]), [[CONTRACT_A, '2027-03-01', 76, true]]);
  // Toàn tổ chức: cả toà B (P201 có hợp đồng B đang hiệu lực).
  await orgWideOverlay(db);
  const both = (await run(env, 'occupancy_report', { report: 'snapshot' })).value.items;
  assert.deepEqual(both.map(row => [row.buildingId, row.total, row.occupied]), [[BUILDING, 4, 1], [OTHER_BUILDING, 1, 1]]);
  assert.deepEqual((await run(env, 'occupancy_report', { report: 'snapshot', buildingId: OTHER_BUILDING })).value.items.map(row => row.buildingId), [OTHER_BUILDING]);
}));

test('invoice search like /invoices: cancelled hidden by default, unpaid = no money collected, customer-name search needs customers.view', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  // Tổng kỳ trên toà kết nối (trước khi thêm hoá đơn): không phải phạm vi CRM toàn bộ.
  const stats = await run(env, 'invoice_report', { report: 'stats', month: '2026-10' });
  assert.deepEqual(stats.value.summary, { totalCount: 1, totalAmount: '3500000.00', totalPaid: '1000000.00', totalRemaining: '2500000.00', totalRefunded: '0',
    rentAmount: '3000000', electricAmount: '350000', waterAmount: '100000', serviceAmount: '50000' });
  assert.equal(stats.value.source, 'crm.invoices');
  await seedInvoices(db);
  const search = await run(env, 'invoice_report', { report: 'search', month: '2026-10' });
  assert.deepEqual(sorted(search.value.items.map(row => row.id)), sorted([INVOICE_A, INVOICE_PARTIAL]), 'default hides cancelled (view_status active)');
  assert.deepEqual(search.value.items.find(row => row.id === INVOICE_A), { id: INVOICE_A, number: 'INV-A', billingMonth: '2026-10', dueDate: '2026-10-10',
    totalAmount: '3500000.00', paidAmount: '1000000.00', remainingAmount: '2500000.00', status: 'APPROVED', buildingId: BUILDING, buildingName: 'Toà A',
    roomId: ROOM, roomName: 'P101' });
  const byStatus = async status => (await run(env, 'invoice_report', { report: 'search', status })).value.items.map(row => row.id);
  assert.deepEqual(await byStatus('unpaid'), [INVOICE_A], 'unpaid excludes PARTIAL_PAID and CANCELLED (useInvoices.ts)');
  assert.deepEqual(await byStatus('partial'), [INVOICE_PARTIAL]);
  assert.deepEqual(await byStatus('cancelled'), [INVOICE_CANCELLED]);
  assert.deepEqual(await byStatus('paid'), []);
  assert.deepEqual((await run(env, 'invoice_report', { report: 'search', query: 'inv-a' })).value.items.map(row => row.id), [INVOICE_A]);
  assert.deepEqual((await run(env, 'invoice_report', { report: 'search', query: 'văn an' })).value.items, [], 'no customers.view ⇒ no name search');
  await grantCustomers(db);
  assert.deepEqual((await run(env, 'invoice_report', { report: 'search', query: 'văn an' })).value.items.map(row => row.id), [INVOICE_A]);
  // Toàn tổ chức thấy cả toà B; buildingId ngoài overlay bị từ chối.
  await assert.rejects(env.read3('invoice_report', domainInput('invoice_report', { report: 'search', buildingId: OTHER_BUILDING })), code('42501'));
  await orgWideOverlay(db);
  assert.deepEqual(sorted((await run(env, 'invoice_report', { report: 'search' })).value.items.map(row => row.id)), sorted([INVOICE_A, INVOICE_B, INVOICE_PARTIAL]));
  assert.deepEqual((await run(env, 'invoice_report', { report: 'search', buildingId: OTHER_BUILDING })).value.items.map(row => row.id), [INVOICE_B]);
  assert.equal((await run(env, 'invoice_report', { report: 'stats' })).value.summary.totalCount, 3, 'stats exclude cancelled');
}));

test('monthly_pnl = the Phân tích tài chính RPC (accrual by default, cash on request) plus the pending part BC Doanh Thu Chi Phí adds', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await seedPnl(db);
  const range = { fromDate: '2026-08-01', toDate: '2026-10-31' };
  const accrual = await run(env, 'monthly_pnl', range);
  const money = rows => rows.map(row => [row.month, row.buildingId, Number(row.revenue), Number(row.expense), Number(row.net)]);
  assert.deepEqual(money(accrual.value.items), [['2026-08-01', BUILDING, 400000, 0, 400000], ['2026-09-01', BUILDING, 400000, 300000, 100000],
    ['2026-10-01', BUILDING, 400000, 0, 400000]], 'approved only, re-perioded like fa_monthly_pnl_accrual');
  assert.deepEqual([accrual.value.summary.basis, Number(accrual.value.summary.pendingIncome), Number(accrual.value.summary.pendingExpense),
    accrual.value.summary.pendingVouchers], ['accrual', 600000, 500000, 2], 'pending V5 (T9+T10 of T9–T11) and V3; V4 is outside the overlay');
  // Từng hàng bằng RPC web (useFinancialAnalysis.ts, hermes-parity:monthly-pnl) trên cùng tập toà.
  const direct = await web(env, `SELECT jsonb_agg(jsonb_build_object('month',month,'buildingId',building_id,'revenue',revenue::text,'expense',expense::text,
    'net',net::text) ORDER BY month) result FROM public.fa_monthly_pnl_accrual($1::date,$2::date,$3::uuid[])`, [range.fromDate, range.toDate, [BUILDING]]);
  assert.deepEqual(accrual.value.items.map(({ month, buildingId, revenue, expense, net }) => ({ month, buildingId, revenue, expense, net })), direct);
  const cash = await run(env, 'monthly_pnl', { ...range, basis: 'cash' });
  assert.deepEqual(money(cash.value.items), [['2026-08-01', BUILDING, 1200000, 0, 1200000], ['2026-09-01', BUILDING, 0, 300000, -300000]]);
  assert.deepEqual([cash.value.summary.basis, Number(cash.value.summary.pendingIncome), Number(cash.value.summary.pendingExpense)], ['cash', 900000, 500000]);
  const page = await run(env, 'monthly_pnl', { ...range, limit: 2 });
  assert.deepEqual([page.value.items.map(row => row.month), page.value.nextOffset], [['2026-08-01', '2026-09-01'], 2]);
  const next = await run(env, 'monthly_pnl', { ...range, limit: 2, offset: 2 });
  assert.deepEqual([next.value.items.map(row => row.month), next.value.nextOffset], [['2026-10-01'], null]);
  // Phần chờ duyệt phân bổ đúng như bản canonical: duyệt xong thì hàng tăng đúng bằng nó.
  await db.exec(`UPDATE public.income_expenses SET approval_status='APPROVED' WHERE id IN ('${V3}','${V5}')`);
  const approved = await run(env, 'monthly_pnl', range);
  const total = (rows, key) => rows.reduce((sum, row) => sum + Number(row[key]), 0);
  assert.equal(total(approved.value.items, 'revenue') - total(accrual.value.items, 'revenue'), 600000);
  assert.equal(total(approved.value.items, 'expense') - total(accrual.value.items, 'expense'), 500000);
  assert.deepEqual([Number(approved.value.summary.pendingIncome), Number(approved.value.summary.pendingExpense), approved.value.summary.pendingVouchers], [0, 0, 0]);
  // Toàn tổ chức: phiếu chờ duyệt toà B vào phần chờ duyệt.
  await orgWideOverlay(db);
  const wide = await run(env, 'monthly_pnl', range);
  assert.deepEqual([Number(wide.value.summary.pendingIncome), wide.value.summary.pendingVouchers], [700000, 1]);
}));

test('organization reports: approvals inbox of the asker in this company; Zalo needs Chat Zalo company-wide like the web', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  for (const [domain, args] of [['pending_approvals', {}], ['zalo_conversations', {}]]) {
    const { value, checked } = await run(env, domain, args);
    assert.deepEqual([value.unavailable, value.items, value.summary], ['organization_scope_required', [], null], domain);
    assert.equal(checked.unavailable, 'organization_scope_required');
  }
  await orgWideOverlay(db, true, false);
  const pending = await run(env, 'pending_approvals', {});
  assert.equal(pending.value.source, 'crm.list_my_pending_approvals_v1');
  assert.deepEqual(pending.value.items, [{ requestId: PENDING, submissionNo: 1, submittedAt: '2026-10-15T03:04:05.678Z', amount: '2500000', voucherId: VOUCHER,
    voucherCode: 'PC-9', voucherName: 'Sửa máy bơm', voucherType: 'EXPENSE', makerName: 'Kế toán A', stepNo: 1 }], 'other company inbox rows dropped');
  assert.deepEqual((await run(env, 'pending_approvals', { query: 'bơm' })).value.items.map(row => row.requestId), [PENDING]);
  // CRM chat_zalo.view chỉ theo toà: web không mở Chat Zalo ⇒ nói rõ, không "0 hội thoại".
  assert.equal((await run(env, 'zalo_conversations', {})).value.unavailable, 'organization_scope_required');
  await db.exec("UPDATE public.fixture_acl SET org_wide=true WHERE permission='chat_zalo.view'");
  const zalo = await run(env, 'zalo_conversations', {});
  assert.equal(zalo.value.source, 'crm.zalo_conversations');
  // Công ty có hai hội thoại (một của fixture nền, không tin); hội thoại công ty khác bị bỏ.
  assert.deepEqual(zalo.value.summary, { conversations: 2, unreadConversations: 1, unreadMessages: 4, pinned: 0 }, 'own company only');
  assert.equal(zalo.value.items.length, 2);
  assert.deepEqual(zalo.value.items.slice(0, 1), [{ conversationId: CONVERSATION, peerName: 'Khách Zalo', phone: ZALO_PHONE, threadType: 'user', kind: 'customer', unread: 4,
    markedUnread: false, pinned: false, roomName: 'P101', buildingName: 'Toà A', label: null, lastMessageAt: '2026-10-16T01:02:03.000Z', lastMessageDir: 'in',
    lastMessage: 'Anh ơi\nphòng còn không?' }]);
  assert.deepEqual((await run(env, 'zalo_conversations', { query: 'khach zalo' })).value.items.map(row => row.conversationId), [CONVERSATION], 'accent-folded name');
  assert.deepEqual((await run(env, 'zalo_conversations', { query: ZALO_PHONE.slice(0, 6) })).value.items.map(row => row.conversationId), [CONVERSATION]);
  assert.deepEqual((await run(env, 'zalo_conversations', { query: 'phòng còn' })).value.items, [], 'message text is not searched');
}));

test('contract_search like the Hợp đồng list: building-scoped rows, web filters, getContractDisplayStatus labels, names need customers.view', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  const first = await run(env, 'contract_search', {});
  assert.deepEqual(first.value.items.map(row => row.contractId), [CONTRACT_A], 'connection building only (CONTRACT_B is in toà B)');
  assert.deepEqual([first.value.items[0].displayStatus, first.value.items[0].displayLabel, first.value.items[0].customerName], ['ACTIVE', 'Còn hạn', null]);
  await seedContracts(db);
  const labels = Object.fromEntries((await run(env, 'contract_search', {})).value.items.map(row => [row.contractId, [row.displayStatus, row.displayLabel]]));
  // src/types/contract.ts (hermes-parity:contract-search) tại hôm nay 2026-10-16.
  assert.deepEqual(labels, { [CONTRACT_A]: ['ACTIVE', 'Còn hạn'], [C_EXPIRED]: ['EXPIRED', 'Quá hạn'], [C_EXPIRING]: ['EXPIRING', 'Sắp hết hạn'],
    [C_MOVING]: ['MOVING_OUT', 'Sắp chuyển đi'], [C_TERMINATED]: ['TERMINATED', 'Đã thanh lý'], [C_TRANSFERRED]: ['TRANSFERRED', 'Đã nhượng'] });
  const byStatus = async status => sorted((await run(env, 'contract_search', { status })).value.items.map(row => row.contractId));
  assert.deepEqual(await byStatus('ACTIVE'), sorted([CONTRACT_A, C_EXPIRED, C_EXPIRING, C_MOVING, C_TRANSFERRED]), 'ACTIVE = all but TERMINATED (useContracts.ts)');
  assert.deepEqual(await byStatus('TERMINATED'), [C_TERMINATED]);
  assert.deepEqual(await byStatus('EXPIRING'), [C_EXPIRING], 'moving-out and transferred are not "sắp hết hạn"');
  assert.deepEqual(await byStatus('EXPIRED'), [C_EXPIRED]);
  assert.deepEqual((await run(env, 'contract_search', { query: 'hd-a' })).value.items.map(row => row.contractId), [CONTRACT_A]);
  assert.equal((await run(env, 'contract_search', { query: 'p101' })).value.items.length, 6, 'room name search');
  assert.deepEqual((await run(env, 'contract_search', { query: 'văn an' })).value.items, [], 'no customers.view ⇒ no name search');
  await grantCustomers(db);
  const named = await run(env, 'contract_search', { query: 'văn an' });
  assert.deepEqual(named.value.items.map(row => [row.contractId, row.customerName]), [[CONTRACT_A, 'Nguyễn Văn An']]);
  assert.deepEqual((await run(env, 'contract_search', { query: PHONE_A })).value.items.map(row => row.contractId), [CONTRACT_A], 'customer phone search');
  await orgWideOverlay(db);
  assert.deepEqual((await run(env, 'contract_search', { buildingId: OTHER_BUILDING })).value.items.map(row => [row.contractId, row.customerName]),
    [[CONTRACT_B, 'Phạm Toà Khác']]);
  // customers.view chỉ ở toà A: báo cáo phủ cả hai toà thì không tên khách nào; lọc toà A thì có.
  await db.exec(`UPDATE public.fixture_acl SET org_wide=false,building_ids=ARRAY['${BUILDING}'::uuid] WHERE permission='customers.view'`);
  assert.ok((await run(env, 'contract_search', {})).value.items.every(row => row.customerName === null), 'customers.view must cover every building of the report');
  assert.equal((await run(env, 'contract_search', { buildingId: BUILDING, query: 'hd-a' })).value.items[0].customerName, 'Nguyễn Văn An');
}));

// P2-2 (review 85280779): RLS customers_select_rbac của web — chủ hồ sơ (customers.user_id) phải là
// thành viên ACTIVE của công ty (current_visible_owner_ids), kể cả khi tra qua báo cáo.
const STRANGER = '0e0e0e0e-0000-4000-8000-000000000041';
const strangerOwnsA = db => db.exec(`UPDATE public.customers SET user_id='${STRANGER}' WHERE id='${CUSTOMER_A}'`);
test('P2-2 reports: a customer whose owner is not an active member is never named or matched', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await grantCustomers(db);
  assert.equal((await run(env, 'contract_search', {})).value.items[0].customerName, 'Nguyễn Văn An');
  await strangerOwnsA(db);
  const rows = (await run(env, 'contract_search', {})).value.items;
  assert.deepEqual(rows.map(row => [row.contractId, row.customerName]), [[CONTRACT_A, 'Lê Ở Ghép']], 'the visible co-tenant represents the contract');
  for (const query of ['văn an', PHONE_A]) assert.deepEqual((await run(env, 'contract_search', { query })).value.items, [], query);
  assert.deepEqual((await run(env, 'invoice_report', { report: 'search', query: 'văn an' })).value.items, []);
  await db.exec(`INSERT INTO public.fixture_visible_owners VALUES('${STRANGER}')`);
  assert.deepEqual((await run(env, 'contract_search', { query: 'văn an' })).value.items.map(row => row.contractId), [CONTRACT_A]);
}));

test('P3-5 monthly_pnl: the pending part covers exactly the buildings of the rows (query on building name)', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await seedPnl(db); await orgWideOverlay(db);
  const range = { fromDate: '2026-08-01', toDate: '2026-10-31' };
  assert.equal(Number((await run(env, 'monthly_pnl', range)).value.summary.pendingIncome), 1300000, 'both buildings: V5 600k + V4 700k');
  const onlyA = (await run(env, 'monthly_pnl', { ...range, query: 'toà a' })).value;
  assert.ok(onlyA.items.every(row => row.buildingId === BUILDING));
  assert.deepEqual([Number(onlyA.summary.pendingIncome), Number(onlyA.summary.pendingExpense), onlyA.summary.pendingVouchers], [600000, 500000, 2]);
  const cashB = (await run(env, 'monthly_pnl', { ...range, basis: 'cash', query: 'toà b' })).value;
  assert.deepEqual([cashB.items, Number(cashB.summary.pendingIncome), cashB.summary.pendingVouchers], [[], 700000, 1]);
}));

// P3-7: ngân sách trang đo SAU escape JSON, như broker bọc kết quả (chuỗi trong chuỗi).
const seedQuotedZalo = db => db.exec(`INSERT INTO public.zalo_conversations(id,organization_id,thread_type,thread_id,peer_name,last_message_text,unread_count,is_pinned,last_message_at)
  SELECT gen_random_uuid(),'${ORG}','user','q'||n,repeat('"',60),repeat('"',65),0,false,'2026-10-01T00:00:00Z'::timestamptz+n*interval '1 minute'
  FROM generate_series(1,50) n`);
test('P3-7: report pages are sized after JSON escaping, so the wrapped tool result always fits the broker cap', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await orgWideOverlay(db); await seedQuotedZalo(db);
  const input = domainInput('zalo_conversations', { limit: 50 }), value = await env.read3('zalo_conversations', input);
  const raw = value.items.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
  assert.ok(value.items.length < 50 && value.nextOffset === value.items.length, 'page stops early on the escaped size');
  assert.ok(raw < 40000, 'unescaped the same page would have fit: the escaping is what is measured');
  const wrapped = Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(domainResult('zalo_conversations', value, identity('chat_zalo.view'), input)) }] }));
  assert.ok(wrapped < 65_536, `wrapped ${wrapped}`);
  // Trần cuối của v3 cũng đo sau escape và trả PT413 (HTTP 413 ⇒ result_too_large), không phải 22023.
  const tiny = fullReadOwnerSql().split('  IF octet_length(to_jsonb(v_result::text)::text)>60000 THEN').join('  IF octet_length(to_jsonb(v_result::text)::text)>500 THEN');
  for (const sql of changedFunctions(fullReadOwnerSql(), tiny)) await db.exec(sql);
  const capped = env;
  await assert.rejects(capped.read3('invoice_report', domainInput('invoice_report', { report: 'search' })), error => error.code === 'PT413' && /limit/.test(error.hint));
}));

test('P3a stats: company owner without staff_assignments gets the real numbers from the invoices.view scope; empty scope is unavailable', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  await orgWideOverlay(db);
  // The canonical get_invoice_statistics_v2 scopes by staff_assignments: zero for this owner.
  await db.exec('SAVEPOINT legacy_stats');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [USER]);
  const legacy = (await db.query("SELECT public.get_invoice_statistics_v2(NULL,NULL,NULL,NULL,NULL,'2026-10',NULL,NULL)::jsonb AS v")).rows[0].v;
  await db.exec('ROLLBACK TO SAVEPOINT legacy_stats; RELEASE SAVEPOINT legacy_stats');
  assert.equal(legacy.total_count, 0, 'fixture reproduces the staff_assignments scope');
  const stats = (await run(env, 'invoice_report', { report: 'stats', month: '2026-10' })).value.summary;
  assert.deepEqual([stats.totalCount, stats.totalAmount, stats.totalPaid, stats.totalRemaining, stats.rentAmount], [2, '12600000.00', '1000000.00', '11600000.00', '12100000']);
  await db.exec("UPDATE public.invoices SET status='CANCELLED' WHERE invoice_number='INV-B'");
  assert.equal((await run(env, 'invoice_report', { report: 'stats', month: '2026-10' })).value.summary.totalCount, 1, 'cancelled invoices excluded like the canonical stats');
  // Connection and CRM scope no longer share a building: say so instead of zeros.
  await orgWideOverlay(db, false);
  await db.exec(`UPDATE public.fixture_acl SET building_ids=ARRAY['${OTHER_BUILDING}'::uuid] WHERE permission IN ('invoices.view','contracts.view','reports_finance.analysis')`);
  for (const [domain, args] of [['invoice_report', { report: 'stats' }], ['invoice_report', { report: 'search' }], ['contract_search', {}],
    ['monthly_pnl', { fromDate: '2026-08-01', toDate: '2026-10-31' }]]) {
    const { value, checked } = await run(env, domain, args);
    assert.deepEqual([value.unavailable, value.summary, value.items], ['no_building_scope', null, []], `${domain}:${args.report}`);
    assert.equal(checked.unavailable, 'no_building_scope');
  }
}));

test('P3c: a status or basis sent to a report that does not declare it is refused by SQL itself', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  for (const [domain, report] of [['occupancy_report', 'snapshot'], ['monthly_pnl', 'by_month'], ['pending_approvals', 'inbox'], ['invoice_report', 'stats']]) {
    const base = domainInput(domain, { report, ...(domain === 'monthly_pnl' ? { fromDate: '2026-01-01', toDate: '2026-02-01' } : {}) });
    await assert.rejects(env.read3(domain, { ...base, status: 'paid' }), code('22023'), `${domain}:${report}`);
  }
  await assert.rejects(env.read3('invoice_report', { ...domainInput('invoice_report', { report: 'search' }), status: 'PAID' }), code('22023'));
  await assert.rejects(env.read3('invoice_report', { ...domainInput('invoice_report', { report: 'search' }), basis: 'cash' }), code('22023'));
  await assert.rejects(env.read3('monthly_pnl', { ...domainInput('monthly_pnl', { fromDate: '2026-01-01', toDate: '2026-02-01' }), basis: 'kqkd' }), code('22023'));
  await assert.rejects(env.read3('contract_search', { ...domainInput('contract_search', {}), status: 'TRANSFERRED' }), code('22023'));
  assert.equal((await env.read3('invoice_report', domainInput('invoice_report', { report: 'search', status: 'unpaid' }))).items.length, 1);
}));

test('SQL report denials: CRM grant, registry, connection overlay, caller and other company', { timeout: 120000 }, () => inCase(async env => {
  const { db } = env;
  const probe = () => env.read3('invoice_report', domainInput('invoice_report', { report: 'search' }));
  assert.equal((await probe()).items.length, 1);
  for (const [label, off, on] of [
    ['CRM grant', "UPDATE public.fixture_acl SET allowed=false WHERE permission='invoices.view'", "UPDATE public.fixture_acl SET allowed=true WHERE permission='invoices.view'"],
    ['registry', "UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='invoices.view'", "UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='invoices.view'"],
    ['connection overlay', "UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'invoices.view')", "UPDATE app_private.hermes_connections SET read_capabilities=read_capabilities||ARRAY['invoices.view']"],
  ]) { await db.exec(off); try { await assert.rejects(probe(), code('42501'), label); } finally { await db.exec(on); } }
  await db.exec("UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'chat_zalo.view')");
  await assert.rejects(env.read3('zalo_conversations', domainInput('zalo_conversations', {})), code('42501'));
  await assert.rejects(env.read3('invoice_report', domainInput('invoice_report', { report: 'search' }), binding, { actor: FOREIGN }), code('42501'));
  for (const input of [{ ...domainInput('invoice_report', { report: 'search' }), report: 'drop' }, { ...domainInput('invoice_report', { report: 'search' }), days: 3 },
    { ...domainInput('pending_approvals', {}), buildingId: BUILDING }, (({ offset, ...rest }) => rest)(domainInput('monthly_pnl', { fromDate: '2026-01-01', toDate: '2026-02-01' }))])
    await assert.rejects(env.read3(input.report === 'by_month' || !input.report ? 'monthly_pnl' : input.report === 'inbox' ? 'pending_approvals' : 'invoice_report', input), code('22023'), JSON.stringify(input));
}));

test('broker fence: report rows outside the CRM scope, wrong source or forged unavailable reasons are refused', () => {
  const input = domainInput('invoice_report', { report: 'search' });
  const row = { id: INVOICE_A, number: 'INV-A', billingMonth: '2026-10', dueDate: '2026-10-10', totalAmount: '1', paidAmount: '0', remainingAmount: '1', status: 'APPROVED',
    buildingId: BUILDING, buildingName: 'Toà A', roomId: INVOICE_B, roomName: 'P' };
  const value = { organizationId: ORG, domain: 'invoice_report', fetchedAt: '2026-10-16T00:00:00.000Z', report: 'search', source: 'crm.invoices',
    unavailable: null, summary: null, items: [row], offset: 0, nextOffset: null, sourceCapped: false };
  assert.deepEqual(domainResult('invoice_report', value, identity('invoices.view'), input).items, [row]);
  for (const bad of [{ ...value, source: 'crm.copilot_invoice_search_v1' }, { ...value, items: [{ ...row, buildingId: FOREIGN }] }, { ...value, items: [{ ...row, phone: '0900000000' }] },
    { ...value, unavailable: 'organization_scope_required', items: [] }, { ...value, unavailable: 'copilot_feature_disabled', items: [] }, { ...value, nextOffset: 5 },
    { ...value, report: 'stats' }, { ...value, organizationId: FOREIGN }])
    assert.throws(() => domainResult('invoice_report', bad, identity('invoices.view'), input), JSON.stringify(bad).slice(0, 80));
  const unavailable = { ...value, unavailable: 'no_building_scope', items: [] };
  assert.equal(domainResult('invoice_report', unavailable, identity('invoices.view'), input).unavailable, 'no_building_scope');
  assert.throws(() => domainResult('pending_approvals', { ...unavailable, domain: 'pending_approvals', report: 'inbox', source: 'crm.list_my_pending_approvals_v1' },
    identity('income_expenses.view'), domainInput('pending_approvals', {})), 'organization reports never claim a building scope');
  const narrow = { row: { organizationId: ORG }, scopesByPermission: { 'invoices.view': { buildingIds: [OTHER_BUILDING] } } };
  assert.throws(() => domainResult('invoice_report', value, narrow, input), 'earlier CRM scope fences output');
  // P3-8: ảnh chụp không có phạm vi của khoá ⇒ đóng (trước đây coi là mở).
  assert.throws(() => domainResult('invoice_report', value, { row: { organizationId: ORG }, scopesByPermission: {} }, input), 'no scope for the key ⇒ refused');
  const pnlInput = domainInput('monthly_pnl', { fromDate: '2026-08-01', toDate: '2026-08-31' });
  const pnl = { ...value, domain: 'monthly_pnl', report: 'by_month', source: 'crm.fa_monthly_pnl', items: [],
    summary: { basis: 'accrual', pendingIncome: '0', pendingExpense: '1', pendingVouchers: 1 } };
  assert.equal(domainResult('monthly_pnl', pnl, identity('reports_finance.analysis'), pnlInput).summary.basis, 'accrual');
  for (const summary of [{ ...pnl.summary, basis: 'kqkd' }, { ...pnl.summary, pendingExpense: 1 }, (({ basis, ...rest }) => rest)(pnl.summary)])
    assert.throws(() => domainResult('monthly_pnl', { ...pnl, summary }, identity('reports_finance.analysis'), pnlInput), JSON.stringify(summary));
});

// Mutation evidence: v3 / reader live in the review-fix file (20261017033630); catalog and the
// pending helper live in the web-parity file (20261017021554).
const live = { owner: fullReadOwnerSql(), parity: fullReadParitySql() };
const replaceExactly = (sql, from, to, count = 1) => {
  assert.equal(sql.split(from).length, count + 1, `anchor: ${from}`); return sql.split(from).join(to);
};
const mutate = (...pairs) => ({ owner: pairs.reduce((sql, [from, to, count]) => replaceExactly(sql, from, to, count), live.owner) });
const mutateParity = (...pairs) => ({ parity: pairs.reduce((sql, [from, to, count]) => replaceExactly(sql, from, to, count), live.parity) });
const searchIds = async (env, args) => (await env.read3('invoice_report', domainInput('invoice_report', { report: 'search', ...args }))).items.map(row => row.id);
const pnlSummary = async env => (await env.read3('monthly_pnl', domainInput('monthly_pnl', { fromDate: '2026-08-01', toDate: '2026-10-31' }))).summary;
for (const probe of [
  { name: 'row reports filter by the connection buildings', sql: mutate([`inv.building_id=ANY(p_buildings)
        AND (v_month IS NULL OR inv.billing_month=v_month)
        AND CASE v_status`, `true
        AND (v_month IS NULL OR inv.billing_month=v_month)
        AND CASE v_status`]),
    run: async env => (await searchIds(env, {})).includes(INVOICE_B) },
  { name: 'organization-only reports need Toàn tổ chức', sql: mutate(["  IF v_spec->>'scope'='organization' AND NOT COALESCE(p_overlay_org,false) THEN", '  IF false THEN']),
    run: async env => (await env.read3('pending_approvals', domainInput('pending_approvals', {}))).items.length > 0 },
  { name: 'stats stay inside the connection buildings', sql: mutate([`      FROM public.invoices inv WHERE inv.organization_id=p_org AND inv.deleted_at IS NULL AND inv.building_id=ANY(p_buildings)
        AND inv.status::text<>'CANCELLED' AND (v_month IS NULL OR inv.billing_month=v_month);
    SELECT`, `      FROM public.invoices inv WHERE inv.organization_id=p_org AND inv.deleted_at IS NULL
        AND inv.status::text<>'CANCELLED' AND (v_month IS NULL OR inv.billing_month=v_month);
    SELECT`]),
    run: async env => (await env.read3('invoice_report', domainInput('invoice_report', { report: 'stats' }))).summary.totalCount === 2 },
  { name: 'P3a empty building scope is unavailable, not zeros', sql: mutate([`  IF v_spec->>'scope' IN ('rows','buildings') AND cardinality(p_buildings)=0 THEN`, '  IF false THEN']),
    run: async env => {
      await env.db.exec(`UPDATE public.fixture_acl SET building_ids=ARRAY['${OTHER_BUILDING}'::uuid] WHERE permission='invoices.view'`);
      return (await env.read3('invoice_report', domainInput('invoice_report', { report: 'stats' }))).unavailable === null;
    } },
  { name: 'P3c status needs declared statuses', sql: mutate([`        OR NOT COALESCE(v_report->'statuses' ? (p_input->>'status'),false))`, `        OR NOT (v_report->'statuses' ? (p_input->>'status')))`]),
    run: async env => (await env.read3('occupancy_report', { ...domainInput('occupancy_report', { report: 'snapshot' }), status: 'paid' })).items.length > 0 },
  { name: 'invoice search hides cancelled by default', sql: mutate([`          ELSE inv.status::text<>'CANCELLED' END`, '          ELSE true END']),
    run: async env => { await seedInvoices(env.db); return (await searchIds(env, {})).includes(INVOICE_CANCELLED); } },
  { name: 'unpaid excludes partial and cancelled', sql: mutate([`WHEN 'unpaid' THEN inv.status::text NOT IN ('PAID','PARTIAL_PAID','CANCELLED')`, `WHEN 'unpaid' THEN inv.status::text<>'PAID'`]),
    run: async env => { await seedInvoices(env.db); return (await searchIds(env, { status: 'unpaid' })).length > 1; } },
  { name: 'invoice customer-name search needs customers.view', sql: mutate([`COALESCE(p_customers_visible,false) AND EXISTS(SELECT 1 FROM public.contract_customers cc
`, `true AND EXISTS(SELECT 1 FROM public.contract_customers cc
`]),
    run: async env => (await searchIds(env, { query: 'văn an' })).length > 0 },
  { name: 'monthly_pnl defaults to accrual like Phân tích tài chính', sql: mutate([`v_basis text:=COALESCE(p_input->>'basis','accrual')`, `v_basis text:=COALESCE(p_input->>'basis','cash')`]),
    run: async env => {
      await seedPnl(env.db);
      const rows = (await env.read3('monthly_pnl', domainInput('monthly_pnl', { fromDate: '2026-08-01', toDate: '2026-10-31' }))).items;
      return !rows.some(row => row.month === '2026-10-01');
    } },
  { name: 'pending part counts only UNAPPROVED vouchers', sql: mutateParity([`voucher.approval_status='UNAPPROVED' AND voucher.business_result_accounting`,
    `voucher.approval_status IN ('UNAPPROVED','APPROVED') AND voucher.business_result_accounting`]),
    run: async env => { await seedPnl(env.db); return Number((await pnlSummary(env)).pendingIncome) > 600000; } },
  { name: 'pending part stays inside the connection buildings', sql: mutateParity([`WHERE b.deleted_at IS NULL AND b.id=ANY(COALESCE(p_building_ids,'{}'::uuid[])) AND public.can_access_building(b.id)
    ),`, `WHERE b.deleted_at IS NULL AND public.can_access_building(b.id)
    ),`]),
    run: async env => { await seedPnl(env.db); return Number((await pnlSummary(env)).pendingIncome) > 600000; } },
  { name: 'approvals inbox keeps only this company', sql: mutate([`      WHERE p.organization_id=p_org
`, `      WHERE true
`]),
    run: async env => {
      await orgWideOverlay(env.db, true, false);
      return (await env.read3('pending_approvals', domainInput('pending_approvals', {}))).items.some(row => row.requestId === FOREIGN_PENDING);
    } },
  { name: 'Zalo needs Chat Zalo company-wide', sql: mutate(
    [`    IF NOT EXISTS(SELECT 1 FROM public.zalo_authorized_org_ids('view') allowed(org_id) WHERE allowed.org_id=p_org) THEN`, '    IF false THEN'],
    [` AND p_org IN (SELECT public.zalo_authorized_org_ids('view'))`, '', 2]),
    run: async env => {
      await orgWideOverlay(env.db, true, false);
      return (await env.read3('zalo_conversations', domainInput('zalo_conversations', {}))).items.length > 0;
    } },
  { name: 'Zalo keeps only this company', sql: mutate([`WHERE z.organization_id=p_org AND`, 'WHERE', 2]),
    run: async env => {
      await orgWideOverlay(env.db);
      return (await env.read3('zalo_conversations', domainInput('zalo_conversations', {}))).summary.conversations > 2;
    } },
  { name: 'P1 contract_search names need customers.view', sql: mutate([`'customerName',CASE WHEN p_customers_visible THEN`, `'customerName',CASE WHEN true THEN`]),
    run: async env => (await env.read3('contract_search', domainInput('contract_search', {}))).items.some(row => row.customerName !== null) },
  { name: 'P1 contract_search does not match customer names without customers.view', sql: mutate([`OR COALESCE(p_customers_visible,false) AND EXISTS(SELECT 1 FROM public.contract_customers cc2`,
    `OR true AND EXISTS(SELECT 1 FROM public.contract_customers cc2`]),
    run: async env => (await env.read3('contract_search', domainInput('contract_search', { query: 'văn an' }))).items.length > 0 },
  { name: 'contract ACTIVE filter is every status but TERMINATED', sql: mutate([`WHEN 'ACTIVE' THEN ct.status::text<>'TERMINATED'`, `WHEN 'ACTIVE' THEN ct.status::text='ACTIVE'`]),
    run: async env => { await seedContracts(env.db); return !(await env.read3('contract_search', domainInput('contract_search', { status: 'ACTIVE' }))).items.some(row => row.contractId === C_TRANSFERRED); } },
  { name: 'P2-2 contract_search customer name needs a visible owner', sql: mutate([`JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=p_org AND cu.deleted_at IS NULL AND cu.user_id=ANY(v_owners)
          WHERE cc.contract_id=ct.id`, `JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=p_org AND cu.deleted_at IS NULL
          WHERE cc.contract_id=ct.id`]),
    run: async env => { await grantCustomers(env.db); await strangerOwnsA(env.db);
      return (await env.read3('contract_search', domainInput('contract_search', {}))).items.some(row => row.customerName === 'Nguyễn Văn An'); } },
  { name: 'P2-2 contract_search name/phone search needs a visible owner', sql: mutate([`cu2.deleted_at IS NULL AND cu2.user_id=ANY(v_owners)`, 'cu2.deleted_at IS NULL']),
    run: async env => { await grantCustomers(env.db); await strangerOwnsA(env.db);
      return (await env.read3('contract_search', domainInput('contract_search', { query: PHONE_A }))).items.length > 0; } },
  { name: 'P2-2 invoice customer-name search needs a visible owner', sql: mutate([`cu.deleted_at IS NULL AND cu.user_id=ANY(v_owners)
            WHERE cc.contract_id=inv.contract_id`, `cu.deleted_at IS NULL
            WHERE cc.contract_id=inv.contract_id`]),
    run: async env => { await grantCustomers(env.db); await strangerOwnsA(env.db); return (await searchIds(env, { query: 'văn an' })).length > 0; } },
  { name: 'P3-5 pending part uses the same buildings as the rows', sql: mutate([`app_private.hermes_pnl_pending_v1(v_from,v_to,v_pnl_buildings,v_basis='accrual')`,
    `app_private.hermes_pnl_pending_v1(v_from,v_to,p_buildings,v_basis='accrual')`]),
    run: async env => { await seedPnl(env.db); await orgWideOverlay(env.db);
      const summary = (await env.read3('monthly_pnl', domainInput('monthly_pnl', { fromDate: '2026-08-01', toDate: '2026-10-31', query: 'Toà A' }))).summary;
      return Number(summary.pendingIncome) > 600000; } },
  { name: 'P3-7 page budget counts JSON escaping', sql: mutate([`    v_size:=octet_length(to_jsonb(v_item::text)::text);`, `    v_size:=octet_length(v_item::text);`]),
    run: async env => { await orgWideOverlay(env.db); await seedQuotedZalo(env.db);
      return (await env.read3('zalo_conversations', domainInput('zalo_conversations', { limit: 50 }))).items.length === 50; } },
  { name: 'P3-10 names need customers.view over EVERY building of the report', sql: mutate([`COALESCE(v_customer_scope@>buildings,false)`, `v_customer_scope IS NOT NULL`]),
    run: async env => { await grantCustomers(env.db); await orgWideOverlay(env.db);
      await env.db.exec(`UPDATE public.fixture_acl SET org_wide=false,building_ids=ARRAY['${BUILDING}'::uuid] WHERE permission='customers.view'`);
      return (await env.read3('contract_search', domainInput('contract_search', {}))).items.some(row => row.customerName !== null); } },
  { name: 'moving-out wins over the end-date labels', sql: mutate([` WHEN ct.expected_move_out_date IS NOT NULL THEN 'MOVING_OUT'`, '']),
    run: async env => { await seedContracts(env.db); return (await env.read3('contract_search', domainInput('contract_search', {}))).items.find(row => row.contractId === C_MOVING).displayStatus !== 'MOVING_OUT'; } },
]) {
  // Bản đột biến: chỉ các hàm khác bản sống, tính ngay khi nạp file (neo sai ⇒ đỏ sớm).
  const [file, text] = Object.entries(probe.sql)[0], changed = changedFunctions(live[file], text);
  test(`mutation is caught: ${probe.name}`, { timeout: 120000 }, async () => {
    await inCase(async env => assert.equal(await probe.run(env).catch(() => false), false, 'reviewed SQL refuses'));
    await inCase(async env => {
      for (const sql of changed) await env.db.exec(sql);
      assert.equal(await probe.run(env), true, 'mutant breaches');
    });
  });
}
