import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedW2c, STAFF2, OUTSIDER, VEHICLE, HIDDEN_CUSTOMER, CATEGORY, MATERIAL, SUPPLIER, HIDDEN_SUPPLIER, PURCHASE, JOB_A, JOB_B, USAGE,
  ADJUSTMENT, WAREHOUSE, NOTE, SALARY, ROUTER, INCIDENT, SNAPSHOT, CLIENT, ARUBA, H196A, COMMAND, AUDIT } from './wave2-c-sql-fixture.mjs';
import { assertPackageParity, grantRead, BUILDING, OTHER_BUILDING, ROOM, USER, ORG, FOREIGN } from './wave2-sql-fixture.mjs';
import { CUSTOMER_A, CUSTOMER_B, CONTRACT_A, changedFunctions } from './full-read-sql-fixture.mjs';
import { W2 } from './wave2-registry.mjs';
import { W2C_REPORTS } from './wave2-c-contract.mjs';

// Gói C đợt 2 — test RIÊNG của Gói C. MỘT PGlite cho cả file, mỗi ca BEGIN … ROLLBACK.
// Đường thật: lối vào INVOKER public.hermes_w2_read_v1 (Gói 0, 20261018000600) bằng vai authenticated → bước kiểm
// quyền DEFINER dựng ctx → app_private.hermes_w2c_read_v1 (INVOKER, RLS THẬT chép nguyên văn trong fixture) → bước
// kết thúc rào đầu ra/phân trang; rồi rào broker (W2.reads.report.result). authenticated KHÔNG có USAGE trên
// app_private: thân hàm đọc mà gọi app_private.* là ca đỏ. Ca "ctx không mở rộng RLS" gọi hàm đọc trực tiếp (cấp
// USAGE tạm trong ca). Đột biến SQL trên định nghĩa SỐNG (file sau cùng định nghĩa hàm) của bốn migration của gói.
// Rào công ty (nền 20261018000700): hàm dùng chung trả cột organization_id (030300), hàm đọc gắn organizationId (030400).
const read = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8');
const sharedSql = read('20261018030100_hermes_w2c_shared_v1'), sharedOrgSql = read('20261018030300_hermes_w2c_shared_org_v1');
const packageSql = read('20261018030200_hermes_w2c_ops_read_v1'), fenceSql = read('20261018030400_hermes_w2c_org_fence_v1');
const SHARED_SOURCES = [sharedOrgSql, sharedSql], PACKAGE_SOURCES = [fenceSql, packageSql];
let shared;
before(async () => { shared = await sharedW2c(); });
after(async () => { await shared?.close(); });
const inCase = work => shared.isolated(work);
const code = expected => error => error.code === expected;
const ids = value => value.items.map(row => row.id);
const ALL = [BUILDING, OTHER_BUILDING];
const C_KEYS = [...new Set(Object.values(W2C_REPORTS).map(spec => spec.permission))];
const IDENTITY = { effective: { read: C_KEYS }, scopesByPermission: Object.fromEntries(C_KEYS.map(key => [key, { buildingIds: ALL }])) };
const full = (reportId, values = {}) => ({ ...Object.fromEntries(W2.reports[reportId].params.map(name => [name, null])), ...values });
// Qua cổng thật + rào broker trên trang trả về.
async function run(env, reportId, values = {}, extra = {}) {
  const params = full(reportId, values), limit = extra.limit ?? 50, offset = extra.offset ?? 0;
  const value = await env.report(reportId, params, { limit, offset });
  const input = W2.reads.report.input({ report: reportId, params, limit, offset });
  const checked = W2.reads.report.result(value, IDENTITY, input);
  assert.deepEqual(checked.items, value.items, `broker: ${reportId}`);
  return value;
}
const asUser = (env, sql, args = []) => env.call(`SELECT COALESCE(jsonb_agg(x.id),'[]') result FROM (${sql}) x`, args);
const acl = (db, permission, orgWide = false, buildings = ALL) => db.query(`INSERT INTO public.fixture_acl(permission,allowed,org_wide,building_ids)
  VALUES($1,true,$2,$3) ON CONFLICT(permission) DO UPDATE SET allowed=true,org_wide=EXCLUDED.org_wide,building_ids=EXCLUDED.building_ids`,
  [permission, orgWide, buildings]);
// Gọi thẳng hàm đọc (không qua cổng) với ctx khuôn hermes_w2_scope_v1, cho ca chứng minh ctx không vượt RLS.
async function direct(env, report, values, ctx, actor = USER) {
  await env.db.exec('GRANT USAGE ON SCHEMA app_private TO authenticated');
  const spec = W2.reports[report];
  const base = { organizationId: ORG, userId: actor, report, permission: spec.permission, scope: spec.scope, buildings: ALL, requestedBuildingId: null,
    overlayOrg: true, orgWide: true, isSuperadmin: false, today: '2026-10-16', scopes: Object.fromEntries(spec.scopeKeys.map(key => [key, ALL])), cashbooks: [] };
  return env.call('SELECT app_private.hermes_w2c_read_v1($1,$2::jsonb,$3::jsonb) result',
    [report, JSON.stringify(full(report, values)), JSON.stringify({ ...base, ...ctx })], { actor });
}

test('gói C: bảng báo cáo SQL (hermes_w2c_catalog_v1) khớp khai báo JS (W2C_REPORTS)', () => shared.isolated(env => assertPackageParity(env, 'c')));

test('cấu trúc: hàm dùng chung INVOKER (trừ helper salary_is_admin_v1), chỉ authenticated; hàm đọc INVOKER pg_catalog,public không gọi app_private', () => inCase(async env => {
  const { db } = env;
  const strip = sql => sql.replace(/--[^\n]*/g, '');
  const created = sql => [...strip(sql).matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+\.[a-z0-9_]+)\(/g)].map(match => match[1]);
  // DROP duy nhất được phép: 030300 bỏ hàm dùng chung CỦA GÓI để đổi kiểu trả về rồi tạo lại ngay trong cùng file.
  const dropped = [...strip(sharedOrgSql).matchAll(/DROP FUNCTION IF EXISTS ([a-z_]+\.[a-z0-9_]+)\(/g)].map(match => match[1]);
  assert.deepEqual(dropped, created(sharedOrgSql), '030300: mỗi DROP đi liền CREATE cùng hàm');
  for (const sql of [sharedSql, sharedOrgSql, packageSql, fenceSql]) {
    assert.doesNotMatch(strip(sql), /copilot/i);
    assert.doesNotMatch(strip(sql).replace(/DROP FUNCTION IF EXISTS public\.[a-z0-9_]+\([^)]*\);/g, ''),
      /\bDROP\b|ALTER TABLE|UPDATE app_private\.hermes_capabilities|INSERT INTO|current_visible_owner_ids/i, 'không chép policy');
  }
  for (const sql of [sharedSql, sharedOrgSql]) assert.doesNotMatch(sql, /hermes_/i, 'hàm dùng chung không thuộc trợ lý');
  assert.deepEqual(created(packageSql).sort(), ['app_private.hermes_w2c_catalog_v1', 'app_private.hermes_w2c_read_v1']);
  assert.deepEqual(created(fenceSql), ['app_private.hermes_w2c_read_v1']);
  const SHARED = created(sharedSql);
  assert.equal(SHARED.length, 14);
  assert.ok(created(sharedOrgSql).every(name => SHARED.includes(name)), '030300 không thêm hàm mới');
  // Hàm dùng chung của báo cáo công ty trả cột nguồn organization_id (tám hàm của 030300).
  const outputs = (await db.query(`SELECT n.nspname||'.'||p.proname name,p.proargnames names,p.proargmodes modes FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=ANY($1)`, [created(sharedOrgSql)])).rows;
  assert.equal(outputs.length, 8);
  for (const row of outputs) assert.equal(row.modes[row.names.indexOf('organization_id')], 't', `${row.name}: cột organization_id`);
  assert.ok(SHARED.every(name => /^public\.[a-z][a-z0-9_]*_v1$/.test(name) && !name.startsWith('public.hermes_')));
  const procs = (await db.query(`SELECT n.nspname||'.'||p.proname name,p.prosecdef definer,p.proconfig config,p.prosrc src,
      has_function_privilege('authenticated',p.oid,'EXECUTE') auth,has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('service_role',p.oid,'EXECUTE') service
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=ANY($1)`, [[...SHARED, ...created(packageSql)]])).rows;
  for (const proc of procs) {
    if (proc.name === 'app_private.hermes_w2c_read_v1') {
      assert.deepEqual([proc.definer, proc.config, proc.auth, proc.anon], [false, ['search_path=pg_catalog, public'], true, false]);
      assert.doesNotMatch(proc.src.replace(/--[^\n]*/g, ''), /app_private\./i, 'thân hàm đọc không gọi app_private');
    } else if (proc.name === 'app_private.hermes_w2c_catalog_v1') {
      assert.deepEqual([proc.definer, proc.config, proc.auth, proc.anon], [true, ['search_path=pg_catalog, app_private'], false, false]);
    } else {
      assert.deepEqual([proc.config, proc.auth, proc.anon, proc.service], [['search_path=""'], true, false, false], proc.name);
      assert.equal(proc.definer, proc.name === 'public.salary_is_admin_v1', `${proc.name}: chỉ helper lương là DEFINER`);
    }
  }
  // Hàm dùng chung từ chối khi không chạy bằng vai authenticated (vd. bị gọi trong một hàm DEFINER) hoặc không có người gọi.
  await assert.rejects(env.call('SELECT count(*)::int result FROM public.vehicles_list_v1($1)', [ORG], { role: 'postgres' }), code('42501'));
  await assert.rejects(env.call('SELECT count(*)::int result FROM public.vehicles_list_v1($1)', [ORG], { role: 'anon' }), /permission denied/);
  // Tự kiểm khoá khi web gọi thẳng: không materials.view ⇒ 42501.
  await assert.rejects(env.call('SELECT count(*)::int result FROM public.materials_items_v1($1)', [ORG]), code('42501'));
}));

test('mục lục qua cổng: đủ 20 báo cáo Gói C khi giữ đủ khoá; topic van_hanh = gói c', () => inCase(async env => {
  await env.grant(C_KEYS);
  assert.deepEqual((await env.reportList('c')).items.map(row => row.report), Object.keys(W2C_REPORTS).sort());
  assert.equal(Object.keys(W2C_REPORTS).length, 20);
}));

test('C1 xe: RLS + vehicles.view theo toà; ctx thu hẹp (overlay, khách theo customers.view, xe không toà khi toàn công ty)', () => inCase(async env => {
  const { db } = env;
  await env.grant(['vehicles.view']);
  let page = await run(env, 'vehicles');
  assert.deepEqual(ids(page), [VEHICLE.mine, VEHICLE.hidden], 'toà A; RLS bỏ xe xoá/khác công ty/không toà của chủ khác');
  assert.deepEqual(page.summary, { total: 2 });
  const mine = page.items[0];
  assert.deepEqual([mine.plate, mine.kind, mine.parkingFee, mine.buildingId, mine.roomId, mine.customerId, mine.customerName, mine.customerPhone],
    ['59A1-11111', 'MOTORBIKE', '150000.00', BUILDING, ROOM, CUSTOMER_A, 'Nguyễn Văn An', '0901234567']);
  assert.deepEqual([page.items[1].customerId, page.items[1].customerName], [null, null], 'RLS customers: chủ hồ sơ ngoài phạm vi');
  assert.deepEqual(ids(await run(env, 'vehicles', { query: 'nguyễn văn' })), [VEHICLE.mine], 'tìm theo tên khách nhìn thấy');
  assert.deepEqual(ids(await run(env, 'vehicles', { query: 'Khách Chủ' })), [], 'không tìm ra qua khách bị ẩn');
  assert.deepEqual(ids(await run(env, 'vehicles', { query: '66666' })), [VEHICLE.hidden]);
  assert.deepEqual(ids(await run(env, 'vehicles', { kind: 'ELECTRIC_BIKE' })), [VEHICLE.hidden]);
  assert.deepEqual(ids(await run(env, 'vehicles', { customerId: CUSTOMER_A })), [VEHICLE.mine]);
  await assert.rejects(run(env, 'vehicles', { customerId: HIDDEN_CUSTOMER }), code('42501'), 'cổng: khách ngoài phạm vi');
  await db.query("UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'customers.view')");
  page = await run(env, 'vehicles');
  assert.deepEqual([page.items[0].customerName, page.items[0].customerPhone, page.items[0].customerId], [null, null, null], 'kết nối không customers.view');
  assert.deepEqual(ids(await run(env, 'vehicles', { query: 'Nguyễn' })), []);
  assert.deepEqual(ids(await run(env, 'vehicles', { query: 'chủ xe' })), [VEHICLE.mine], 'tên chủ xe là cột của xe');
  await db.query("UPDATE app_private.hermes_connections SET read_capabilities=read_capabilities||ARRAY['customers.view']");
  await env.orgWide('vehicles.view');
  page = await run(env, 'vehicles');
  assert.deepEqual(ids(page), [VEHICLE.mine, VEHICLE.other, VEHICLE.unassigned, VEHICLE.hidden]);
  assert.equal(page.items[1].customerId, CUSTOMER_B);
  // Bộ lọc web (useVehicles.ts:39-57) dưới RLS của chính người dùng = cùng tập.
  assert.deepEqual(ids(page), await asUser(env, 'SELECT id FROM public.vehicles WHERE deleted_at IS NULL ORDER BY created_at DESC'));
  assert.deepEqual(ids(await run(env, 'vehicles', { buildingId: OTHER_BUILDING })), [VEHICLE.other], 'buildingId bỏ xe không toà');
  assert.deepEqual(ids(await run(env, 'vehicles', { roomId: ROOM })), [VEHICLE.mine]);
  // vehicles.view chỉ toà B trên CRM ⇒ hàm dùng chung tự kiểm khoá theo toà.
  await db.exec(`UPDATE public.fixture_acl SET org_wide=false,building_ids=ARRAY['${OTHER_BUILDING}'::uuid] WHERE permission='vehicles.view'`);
  assert.deepEqual(ids(await direct(env, 'vehicles', {}, {}).then(rows => ({ items: rows.rows }))), [VEHICLE.other, VEHICLE.unassigned]);
  // ctx không mở rộng được quyền: người không có RLS/khoá xe nhận rỗng dù ctx nêu đủ toà.
  assert.deepEqual((await direct(env, 'vehicles', {}, {}, STAFF2)).rows, []);
}));

test('C2–C5 kho vật tư: cần CRM toàn công ty ∩ Toàn tổ chức; NCC theo suppliers.view (RLS + kết nối), việc theo tasks.view', () => inCase(async env => {
  const { db } = env;
  await env.grant(['materials.view']);
  assert.equal((await run(env, 'materials')).unavailable, 'organization_scope_required');
  await env.orgWide('materials.view');
  let page = await run(env, 'materials');
  assert.deepEqual(ids(page), [MATERIAL.low, MATERIAL.ok], 'sắp tên; không xoá/công ty khác');
  assert.deepEqual(page.summary, { total: 2, lowStock: 1 });
  assert.deepEqual([page.items[0].onHand, page.items[0].reorderLevel, page.items[0].lowStock, page.items[0].avgUnitCost, page.items[0].categoryName],
    ['2.00', '5.00', true, '45000.00', 'Điện']);
  assert.deepEqual(ids(page), await asUser(env, 'SELECT id FROM public.materials WHERE deleted_at IS NULL ORDER BY name,id'), 'khớp useMaterials dưới RLS');
  assert.deepEqual(ids(await run(env, 'materials', { lowStock: true })), [MATERIAL.low]);
  assert.deepEqual(ids(await run(env, 'materials', { query: 'led' })), [MATERIAL.low]);
  assert.deepEqual(ids(await run(env, 'materials', { query: 'vt-02' })), [MATERIAL.ok]);
  assert.deepEqual((await run(env, 'material_categories')).items, [{ id: CATEGORY, name: 'Điện', description: 'Vật tư điện', materialCount: 2 }]);
  page = await run(env, 'material_purchases');
  assert.deepEqual(ids(page), [PURCHASE.hidden, PURCHASE.visible]);
  assert.deepEqual(page.summary, { total: 2, amount: '125000.00' });
  assert.deepEqual(page.items.map(row => row.supplierName), [null, null], 'kết nối chưa có suppliers.view');
  assert.deepEqual(page.items[1].items.map(line => [line.materialName, line.quantity, line.unitPrice, line.lineTotal]),
    [['Bóng đèn LED', '1.00', '45000.00', '45000.00'], ['Ổ cắm', '2.00', '25000.00', '50000.00']]);
  await env.grant(['suppliers.view']);
  page = await run(env, 'material_purchases');
  assert.deepEqual(page.items.map(row => row.supplierName), [null, 'NCC Ánh Sáng'], 'RLS suppliers: chủ hồ sơ ngoài phạm vi vẫn ẩn');
  assert.deepEqual(ids(await run(env, 'material_purchases', { supplierId: SUPPLIER })), [PURCHASE.visible]);
  assert.deepEqual(ids(await run(env, 'material_purchases', { supplierId: HIDDEN_SUPPLIER })), []);
  assert.deepEqual(ids(await run(env, 'material_purchases', { fromDate: '2026-10-11', toDate: '2026-10-31' })), [PURCHASE.hidden]);
  page = await run(env, 'material_usages');
  assert.deepEqual(ids(page), [USAGE.b, USAGE.a]);
  assert.deepEqual(page.items.map(row => [row.jobCode, row.creatorName, row.totalCost]), [[null, 'Quản lý Hai', '30000.00'], [null, 'Quản lý Một', '90000.00']]);
  assert.deepEqual(page.summary, { total: 2, cost: '120000.00' });
  await grantRead(db, ['tasks.view'], { buildings: [BUILDING] });
  page = await run(env, 'material_usages');
  assert.deepEqual(page.items.map(row => [row.jobId, row.jobCode]), [[null, null], [JOB_A, 'CV-A']], 'việc toà B ngoài tasks.view: ẩn');
  assert.equal(JSON.stringify(page).includes(JOB_B), false);
  page = await run(env, 'material_adjustments');
  assert.deepEqual(page.items.map(row => [row.id, row.type, row.reason, row.items.length]), [[ADJUSTMENT.out, 'OUT', 'Hỏng', 1], [ADJUSTMENT.in, 'IN', 'Kiểm kê thừa', 1]]);
  assert.deepEqual(ids(await run(env, 'material_adjustments', { kind: 'IN' })), [ADJUSTMENT.in]);
  await db.exec("UPDATE public.fixture_acl SET org_wide=false WHERE permission='materials.view'");
  assert.equal((await run(env, 'materials')).unavailable, 'organization_scope_required', 'CRM không toàn công ty');
}));

test('C6 kho tài sản: toà overlay ∩ warehouses.view; kho không gắn toà chỉ khi toàn công ty', () => inCase(async env => {
  await env.grant(['warehouses.view']);
  assert.deepEqual(ids(await run(env, 'warehouses')), [WAREHOUSE.a]);
  await env.orgWide('warehouses.view');
  assert.deepEqual(ids(await run(env, 'warehouses')), [WAREHOUSE.a, WAREHOUSE.b, WAREHOUSE.free]);
  assert.deepEqual(ids(await run(env, 'warehouses', { query: 'văn phòng' })), [WAREHOUSE.free]);
}));

test('C9 thông báo: RLS chính mình; IN_APP; công ty kết nối (chặt hơn web); chưa đọc = PENDING; trần 200', () => inCase(async env => {
  const { db } = env;
  await env.grant(['notifications.view']);
  let page = await run(env, 'notifications');
  assert.deepEqual(ids(page), [NOTE.unread, NOTE.read, NOTE.legacy, NOTE.lifecycle]);
  assert.deepEqual(page.summary, { total: 4, unread: 2 });
  assert.deepEqual(page.items[0], { id: NOTE.unread, type: 'NEW_INVOICE', subject: 'Hoá đơn mới', content: 'Phòng P101 có hoá đơn T10', unread: true,
    createdAt: '2026-10-16T07:59:00.000Z' });
  assert.deepEqual(ids(await run(env, 'notifications', { unreadOnly: true })), [NOTE.unread, NOTE.legacy]);
  assert.deepEqual(ids(await run(env, 'notifications', { kind: 'APPROVAL_RESULT' })), [NOTE.read]);
  // Người dùng thuộc cả công ty khác: web (useNotifications.ts:97-107, công ty đang chọn ORG) còn hiện thông báo thường
  // của công ty kia; Hermes chỉ công ty của kết nối.
  await db.exec(`CREATE OR REPLACE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$
    SELECT CASE WHEN auth.uid()='${USER}'::uuid THEN ARRAY['${ORG}'::uuid,'${FOREIGN}'::uuid] ELSE '{}'::uuid[] END$$`);
  const web = await asUser(env, `SELECT id FROM public.notifications WHERE user_id=$1 AND channel='IN_APP' AND (metadata->>'event' IS DISTINCT FROM 'LIFECYCLE'
    OR organization_id=$2) ORDER BY created_at DESC LIMIT 200`, [USER, ORG]);
  page = await run(env, 'notifications');
  assert.ok(web.includes(NOTE.otherOrg), 'khác biệt đã ghi: web hiện thông báo công ty khác');
  assert.deepEqual(web.filter(id => id !== NOTE.otherOrg), ids(page));
}));

test('C8 lương của tôi: chỉ auth.uid(), tháng ĐÃ CHỐT; chưa chốt/sau trần ⇒ source_unavailable; dòng thưởng-trừ và bảng kê', () => inCase(async env => {
  const { db } = env;
  await env.grant(['assistant.salary.self']);
  let page = await run(env, 'my_salary', { month: '2026-09' });
  assert.deepEqual(page.summary, { month: '2026-09', status: 'LOCKED', lockedAt: '2026-10-05T03:00:00.000Z', roleTitle: 'Quản lý toà',
    workBonus: '1200000.00', contractBonus: '300000.00', adjustmentsTotal: '300000.00', baseSalary: '8000000.00', bonus: '1800000.00',
    investment: '400000.00', commission: '2500000.00', grossTotal: '12700000.00', advances: '1000000.00', roomRent: '1500000.00',
    takeHome: '10200000.00', paid: '4000000.00', remaining: '6200000.00' });
  assert.deepEqual(page.items.map(row => [row.type, row.label, row.amount]), [['BONUS', 'Thưởng KPI', '500000.00'], ['DEDUCTION', 'Đi trễ', '-200000.00']]);
  page = await run(env, 'my_salary', { month: '2026-09', kind: 'ledger' });
  assert.deepEqual(page.items.map(row => [row.type, row.date, row.label, row.amount]),
    [['JOB', '2026-09-03', 'Sửa vòi nước', '30000.00'], ['DAY_BONUS', '2026-09-07', 'CN có sửa chữa', '20000.00']]);
  assert.equal((await run(env, 'my_salary', { month: '2026-10' })).unavailable, 'source_unavailable', 'tháng chưa chốt: không đoán');
  assert.equal((await run(env, 'my_salary', { month: '2026-08' })).unavailable, 'source_unavailable');
  await db.exec(`UPDATE public.salary_monthly SET status='LOCKED',locked_at='2026-11-01T00:00:00Z' WHERE id='${SALARY.mineOct}'`);
  assert.equal((await run(env, 'my_salary', { month: '2026-10' })).summary.grossTotal, '8888888.00');
  assert.equal((await run(env, 'my_salary', { month: '2026-11' })).unavailable, 'source_unavailable', 'sau tháng hiện tại');
  await db.exec(`INSERT INTO public.salary_bonus_rules(user_id,rules,organization_id) VALUES('${USER}','{"staffMonths":{"2026-10":false,"2026-09":false}}','${ORG}')`);
  for (const month of ['2026-10', '2026-09']) assert.equal((await run(env, 'my_salary', { month })).unavailable, 'source_unavailable', month);
  await db.exec(`UPDATE public.salary_bonus_rules SET rules='{"staffMonths":{"2026-10":false}}'`);
  assert.equal((await run(env, 'my_salary', { month: '2026-09' })).unavailable, null, 'trần 09 (salary_staff_months)');
  // Nhân viên khác (gọi thẳng): chỉ dòng của chính họ (RLS sm_self_select); tháng 09 của STAFF2 còn nháp.
  assert.equal((await direct(env, 'my_salary', { month: '2026-09' }, { scope: 'self', buildings: [], orgWide: false }, STAFF2)).unavailable,
    'source_unavailable');
  await db.exec(`UPDATE public.manager_salary_config SET is_active=false WHERE staff_id='${USER}'`);
  assert.equal((await run(env, 'my_salary', { month: '2026-09' })).unavailable, 'source_unavailable', 'không còn là quản lý hưởng lương');
}));

test('C7 lương quản lý: admin trang lương (salary.lock|manage_salary|distribute toàn công ty) thấy mọi người dưới RLS; người khác chỉ mình', () => inCase(async env => {
  const { db } = env;
  await env.grant(['salary.view']);
  assert.equal((await run(env, 'salary_month', { month: '2026-09' })).unavailable, 'organization_scope_required');
  await env.orgWide('salary.view');
  let page = await run(env, 'salary_month', { month: '2026-09' });
  assert.deepEqual(page.items.map(row => [row.staffId, row.status, row.takeHome]), [[USER, 'LOCKED', '10200000.00']], 'không phải admin: chỉ mình');
  await acl(db, 'salary.lock', true);
  page = await run(env, 'salary_month', { month: '2026-09' });
  assert.deepEqual(page.items.map(row => [row.name, row.status, row.grossTotal, row.remaining]),
    [['Quản lý Hai', 'DRAFT', null, null], ['Quản lý Một', 'LOCKED', '12700000.00', '6200000.00']], 'admin: mọi quản lý; nháp không số');
  assert.deepEqual(page.summary, { month: '2026-09', managers: 2, locked: 1, notLocked: 1, grossTotal: '12700000.00', takeHomeTotal: '10200000.00',
    paidTotal: '4000000.00', remainingTotal: '6200000.00' });
  assert.equal(JSON.stringify(page).includes(OUTSIDER), false, 'không người công ty khác');
  assert.equal((await run(env, 'salary_month', { month: '2026-09', staffId: STAFF2 })).unavailable, 'source_unavailable', 'chỉ người chưa chốt');
  await assert.rejects(run(env, 'salary_month', { month: '2026-09', staffId: OUTSIDER }), code('42501'), 'cổng: không là thành viên công ty');
  assert.equal((await run(env, 'salary_month', { month: '2026-08' })).unavailable, 'source_unavailable');
  // Như web: admin nhưng KHÔNG là chủ bảng lương của người kia ⇒ RLS không cho thấy (msc_owner_all).
  await db.exec(`UPDATE public.manager_salary_config SET user_id='${OUTSIDER}' WHERE staff_id='${STAFF2}'`);
  assert.deepEqual((await run(env, 'salary_month', { month: '2026-09' })).items.map(row => row.staffId), [USER]);
  await db.exec("UPDATE public.fixture_acl SET org_wide=false WHERE permission='salary.lock'");
  assert.equal(await env.call('SELECT public.salary_is_admin_v1($1) result', [ORG]), false, 'khoá admin phải toàn công ty');
  assert.equal(await env.call('SELECT public.salary_is_admin_v1($1) result', [FOREIGN]), false);
  const lines = (staff, options) => env.call("SELECT COALESCE(jsonb_agg(l),'[]') result FROM public.salary_locked_lines_v1($1,$2,$3,'adjustments') l",
    [ORG, '2026-09-01', staff], options);
  assert.equal((await lines(USER)).length, 2);
  await assert.rejects(lines(STAFF2), code('42501'), 'không admin: không xem dòng người khác');
  await assert.rejects(lines(USER, { role: 'anon' }), /permission denied/);
  await assert.rejects(lines(USER, { role: 'postgres' }), code('42501'), 'chỉ vai authenticated');
}));

test('C10–C14 Network Center: RPC web gọi thẳng, giữ đúng toà ctx; khách hotspot cần customers.view (chặt hơn web); che người thực hiện', () => inCase(async env => {
  const { db } = env;
  await env.grant(['network_center.view']);
  const rawFleet = await env.call('SELECT public.network_center_list_fleet_v1() result', []);
  assert.deepEqual(rawFleet.items.map(item => item.buildingId).sort(), [...ALL].sort(), 'RPC web trả mọi toà được xem');
  let page = await run(env, 'network_fleet');
  assert.deepEqual(page.items.map(row => row.buildingId), [BUILDING], 'Hermes giữ toà overlay');
  assert.deepEqual([page.items[0].routerIdentity, page.items[0].healthStatus, page.items[0].reachable, page.items[0].openIncidents,
    page.items[0].activeClients, page.items[0].rolloutState, page.items[0].cpuPercent], ['Router A', 'HEALTHY', true, 1, 3, 'READ_ONLY', 12.5]);
  await env.orgWide('network_center.view');
  assert.deepEqual((await run(env, 'network_fleet')).items.map(row => row.buildingId), ALL);
  await env.orgWide('network_center.view', false);
  await assert.rejects(run(env, 'network_building', { buildingId: OTHER_BUILDING }), code('42501'), 'toà ngoài overlay');
  page = await run(env, 'network_building', { buildingId: BUILDING });
  assert.deepEqual(ids(page), [INCIDENT]);
  assert.deepEqual([page.summary.router.identity, page.summary.openIncidents, page.summary.ports, page.summary.backups, page.summary.rolloutState],
    ['rb-toa-a', 1, 2, 2, 'READ_ONLY']);
  assert.equal((await run(env, 'network_ports', { buildingId: BUILDING })).items.length, 2);
  assert.deepEqual(ids(await run(env, 'network_backups', { buildingId: BUILDING })), [SNAPSHOT.new, SNAPSHOT.old]);
  const rawClients = await env.call('SELECT public.network_center_list_clients_v1($1,null,null,100) result', [BUILDING]);
  assert.equal(rawClients.items.find(item => item.id === CLIENT.hidden).customerName, 'Khách Chủ Khác', 'lỗ web đã ghi: RPC không kiểm customers.view');
  page = await run(env, 'network_clients', { buildingId: BUILDING });
  assert.deepEqual(ids(page), [CLIENT.linked, CLIENT.hidden, CLIENT.loose]);
  const [linked, hidden] = page.items;
  assert.deepEqual([linked.customerName, linked.customerId, linked.contractId, linked.roomId, linked.macAddress, linked.address],
    ['Nguyễn Văn An', CUSTOMER_A, CONTRACT_A, ROOM, 'aa:bb:cc:00:00:01', '10.0.0.101']);
  assert.deepEqual([hidden.customerName, hidden.customerId], [null, null], 'RLS customers: chủ hồ sơ ngoài phạm vi');
  assert.equal(JSON.stringify(page).includes('Khách Chủ Khác'), false);
  assert.deepEqual(ids(await run(env, 'network_clients', { buildingId: BUILDING, query: 'IPHONE' })), [CLIENT.linked]);
  await db.query("UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'customers.view')");
  page = await run(env, 'network_clients', { buildingId: BUILDING });
  assert.deepEqual([page.items[0].customerName, page.items[0].customerId, page.items[0].contractId, page.summary.customerNamesShown], [null, null, null, false]);
  assert.deepEqual((await run(env, 'network_aruba', { buildingId: BUILDING })).items.map(row => [row.id, row.address, row.healthStatus]),
    [[ARUBA, '10.0.0.21', 'HEALTHY']]);
  assert.deepEqual((await run(env, 'network_h196a', { buildingId: BUILDING })).items.map(row => [row.id, row.address, row.healthStatus]),
    [[H196A, '10.0.0.30', 'ONLINE']]);
  const commands = await run(env, 'network_commands', { buildingId: BUILDING });
  assert.deepEqual(commands.items.map(row => [row.id, row.action, row.status, row.byMe]), [[COMMAND, 'FLUSH_DNS_CACHE', 'SUCCEEDED', true]]);
  assert.equal(JSON.stringify(commands).includes('secret'), false, 'không trả JSON result');
  const audit = await run(env, 'network_audit', { buildingId: BUILDING });
  assert.deepEqual(audit.items.map(row => [row.id, row.action, row.status, row.actorType, row.byMe]), [[AUDIT, 'settings.update', 'SUCCEEDED', 'USER', false]]);
  assert.equal(JSON.stringify(audit).includes(OUTSIDER), false, 'che actorId');
  const diff = await run(env, 'network_config_diff', { buildingId: BUILDING, fromId: SNAPSHOT.old, toId: SNAPSHOT.new });
  assert.deepEqual(diff.items.map(row => [row.kind, row.text]), [['removed', 'add address=10.0.0.1/24'], ['added', 'add address=10.0.0.2/24']]);
  assert.equal((await run(env, 'network_config_diff', { buildingId: BUILDING, fromId: SNAPSHOT.old, toId: ROUTER.a })).unavailable, 'source_unavailable');
}));

// Đột biến: mỗi bản bỏ MỘT hàng rào của Gói C; cùng phép thử mà bản sống từ chối thì bản đột biến phải lọt.
const mutate = (source, from, to) => { assert.equal(source.split(from).length, 2, `anchor: ${from}`); return [source, source.replace(from, () => to)]; };
// Định nghĩa SỐNG: file sau cùng chứa neo (030300 trước 030100, 030400 trước 030200).
const live = (sources, from) => sources.find(sql => sql.includes(from)) ?? sources[0];
const S = (from, to) => mutate(live(SHARED_SOURCES, from), from, to), P = (from, to) => mutate(live(PACKAGE_SOURCES, from), from, to);
// Hàm dùng chung HỎNG (bỏ lọc công ty tường minh) + super admin (RLS phủ công ty khác): dựng nguồn rò cho ca rào công ty.
const leak = async (env, from, to) => {
  await env.db.exec(`INSERT INTO public.super_admins VALUES('${USER}')`);
  for (const sql of changedFunctions(...S(from, to))) await env.db.exec(sql);
};
const items = async (env, report, values) => ids(await env.report(report, full(report, values), { limit: 50, offset: 0 }));
const probes = [
  { name: 'hàm dùng chung: chỉ vai authenticated', pair: S(
    `  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'vehicles_list_denied' USING ERRCODE='42501'; END IF;\n`, ''),
    run: async env => { await acl(env.db, 'vehicles.view');
      return (await env.call('SELECT count(*)::int result FROM public.vehicles_list_v1($1)', [ORG], { role: 'postgres' })) > 0; } },
  { name: 'xe: tự kiểm vehicles.view theo toà', pair: S(`      AND public.can_do_on_building('vehicles','view',b.id);`, `;`),
    run: async env => { await env.grant(['vehicles.view']);
      await env.db.exec(`UPDATE public.fixture_acl SET building_ids=ARRAY['${OTHER_BUILDING}'::uuid] WHERE permission='vehicles.view'`);
      return (await direct(env, 'vehicles', {}, {})).rows.some(row => row.id === VEHICLE.mine); } },
  { name: 'xe: thu hẹp theo toà ctx', pair: S(`WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('vehicles','view',b.id);`, `WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL
      AND public.can_do_on_building('vehicles','view',b.id);`),
    // Qua cổng, bước kết thúc còn rào toà (42501); gọi thẳng để thấy riêng hàng rào của hàm dùng chung.
    run: async env => { await env.grant(['vehicles.view']);
      return (await direct(env, 'vehicles', {}, { buildings: [BUILDING], orgWide: false })).rows.some(row => row.id === VEHICLE.other); } },
  { name: 'xe: không gắn toà chỉ khi toàn công ty', pair: P(`FROM public.vehicles_list_v1(v_org,v_buildings,v_customers,p_ctx->'orgWide'='true'::jsonb,`,
    `FROM public.vehicles_list_v1(v_org,v_buildings,v_customers,true,`),
    run: async env => { await env.grant(['vehicles.view']);
      return (await direct(env, 'vehicles', {}, { buildings: [BUILDING], orgWide: false })).rows.some(row => row.id === VEHICLE.unassigned); } },
  { name: 'xe: khách theo toà customers.view của kết nối', pair: S(
    `(cu.id IS NOT NULL AND (p_customer_building_ids IS NULL OR v.building_id=ANY(p_customer_building_ids)))`, `(cu.id IS NOT NULL)`),
    run: async env => { await env.grant(['vehicles.view']);
      await env.db.query("UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'customers.view')");
      return (await env.report('vehicles', full('vehicles'), { limit: 50, offset: 0 })).items[0].customerName !== null; } },
  { name: 'kho vật tư: tự kiểm materials.view', pair: S(`  IF current_user<>'authenticated' OR auth.uid() IS NULL OR NOT public.can_access_org_entity('materials','view')
    THEN RAISE EXCEPTION 'materials_items_denied' USING ERRCODE='42501'; END IF;`, `  IF current_user<>'authenticated' OR auth.uid() IS NULL
    THEN RAISE EXCEPTION 'materials_items_denied' USING ERRCODE='42501'; END IF;`),
    run: async env => (await env.call('SELECT count(*)::int result FROM public.materials_items_v1($1)', [ORG])) >= 0 },
  { name: 'phiếu nhập: NCC chỉ khi kết nối có suppliers.view', pair: S(`ON COALESCE(p_show_suppliers,true) AND s.id=p.supplier_id`, `ON s.id=p.supplier_id`),
    run: async env => { await env.grant(['materials.view']); await env.orgWide('materials.view'); await acl(env.db, 'suppliers.view', true);
      return (await env.report('material_purchases', full('material_purchases'), { limit: 50, offset: 0 })).items[1].supplierName !== null; } },
  { name: 'phiếu xuất: việc theo toà tasks.view', pair: S(`    AND (p_job_building_ids IS NULL OR j.building_id=ANY(p_job_building_ids))\n`, ''),
    run: async env => { await env.grant(['materials.view']); await env.orgWide('materials.view');
      return (await env.report('material_usages', full('material_usages'), { limit: 50, offset: 0 })).items[0].jobCode !== null; } },
  { name: 'kho tài sản: thu hẹp theo toà ctx', pair: S(`WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND (p_building_ids IS NULL OR b.id=ANY(p_building_ids))
      AND public.can_do_on_building('warehouses','view',b.id);`, `WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL
      AND public.can_do_on_building('warehouses','view',b.id);`),
    run: async env => { await env.grant(['warehouses.view']);
      return (await direct(env, 'warehouses', {}, { buildings: [BUILDING], orgWide: false })).rows.some(row => row.id === WAREHOUSE.b); } },
  { name: 'thông báo: công ty kết nối', pair: S(
    `    AND (n.organization_id=p_organization_id OR n.organization_id IS NULL AND COALESCE(n.metadata->>'event','')<>'LIFECYCLE')\n`, ''),
    run: async env => { await env.grant(['notifications.view']); await env.db.exec(`CREATE OR REPLACE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql AS $$
      SELECT CASE WHEN auth.uid()='${USER}'::uuid THEN ARRAY['${ORG}'::uuid,'${FOREIGN}'::uuid] ELSE '{}'::uuid[] END$$`);
      return (await items(env, 'notifications')).includes(NOTE.otherOrg); } },
  { name: 'lương: người khác chỉ khi admin trang lương', pair: S(`      AND (v_admin OR c.staff_id=v_uid) AND`, `      AND`),
    run: async env => { await env.grant(['salary.view']); await env.orgWide('salary.view');
      return (await items(env, 'salary_month', { month: '2026-09' })).length > 1 || (await env.report('salary_month', full('salary_month', { month: '2026-09' }),
        { limit: 50, offset: 0 })).items.length > 1; } },
  { name: 'lương: số chỉ khi LOCKED', pair: S(`    CASE WHEN sm.status='LOCKED' THEN sm.gross_total END`, `    sm.gross_total`),
    run: async env => { await env.grant(['salary.view']); await env.orgWide('salary.view'); await acl(env.db, 'salary.lock', true);
      return (await env.report('salary_month', full('salary_month', { month: '2026-09' }), { limit: 50, offset: 0 })).items[0].grossTotal !== null; } },
  { name: 'lương: admin phải toàn công ty', pair: S(`CROSS JOIN LATERAL app_private.authorized_scope_v3(k.key,p_organization_id) s WHERE s.org_wide);`,
    `CROSS JOIN LATERAL app_private.authorized_scope_v3(k.key,p_organization_id) s);`),
    run: async env => { await acl(env.db, 'salary.lock', false); return env.call('SELECT public.salary_is_admin_v1($1) result', [ORG]); } },
  { name: 'lương của tôi: tháng chưa chốt không có số', pair: P(` OR v_row.status IS DISTINCT FROM 'LOCKED' THEN`, ` THEN`),
    run: async env => { await env.grant(['assistant.salary.self']);
      return (await env.report('my_salary', full('my_salary', { month: '2026-10' }), { limit: 50, offset: 0 })).unavailable === null; } },
  { name: 'lương của tôi: trần tháng salary_staff_months', pair: P(`      IF v_month>v_ceiling THEN
        RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','source_unavailable');
      END IF;
      SELECT * INTO v_row`, `      SELECT * INTO v_row`),
    run: async env => { await env.grant(['assistant.salary.self']); await env.db.exec(`INSERT INTO public.salary_bonus_rules(user_id,rules,organization_id)
      VALUES('${USER}','{"staffMonths":{"2026-10":false,"2026-09":false}}','${ORG}')`);
      return (await env.report('my_salary', full('my_salary', { month: '2026-09' }), { limit: 50, offset: 0 })).unavailable === null; } },
  { name: 'dòng lương: không admin chỉ chính mình', pair: S(
    `  IF NOT v_admin AND p_staff_id IS DISTINCT FROM v_uid THEN RAISE EXCEPTION 'salary_locked_lines_denied' USING ERRCODE='42501'; END IF;\n`, ''),
    run: async env => (await env.call("SELECT count(*)::int result FROM public.salary_locked_lines_v1($1,$2,$3,'adjustments')", [ORG, '2026-09-01', STAFF2])) === 0 },
  { name: 'Network Center: giữ đúng toà ctx', pair: P(`      WHERE (item->>'buildingId')::uuid=ANY(v_buildings);`, `      ;`),
    run: async env => { await env.grant(['network_center.view']);
      return (await direct(env, 'network_fleet', {}, { buildings: [BUILDING], orgWide: false })).rows.some(row => row.buildingId === OTHER_BUILDING); } },
  { name: 'Network Center: một toà phải nằm trong ctx', pair: P(`  IF v_building IS NULL OR NOT(v_building=ANY(v_buildings)) THEN`, `  IF v_building IS NULL THEN`),
    run: async env => { await env.grant(['network_center.view']);
      return (await direct(env, 'network_building', { buildingId: OTHER_BUILDING }, { buildings: [BUILDING], orgWide: false })).summary !== null; } },
  { name: 'khách hotspot: cần customers.view ở toà', pair: P(`(SELECT v_building=ANY(v_customers) AND cu.id IS NOT NULL AS visible)`, `(SELECT cu.id IS NOT NULL AS visible)`),
    run: async env => { await env.grant(['network_center.view']);
      await env.db.query("UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'customers.view')");
      return (await env.report('network_clients', full('network_clients', { buildingId: BUILDING }), { limit: 50, offset: 0 })).items[0].customerName !== null; } },
  { name: 'rào công ty: xe nêu organizationId cột nguồn (không chép ctx)', pair: P(`'organizationId',x.organization_id)
        ORDER BY x.created_at DESC,x.id DESC)`, `'organizationId',v_org)
        ORDER BY x.created_at DESC,x.id DESC)`),
    run: async env => { await env.grant(['vehicles.view']); await env.orgWide('vehicles.view');
      await leak(env, `    WHERE v.organization_id=p_organization_id AND v.deleted_at IS NULL\n`, `    WHERE v.deleted_at IS NULL\n`);
      return (await items(env, 'vehicles')).includes(VEHICLE.foreignFree); } },
  { name: 'rào công ty: vật tư nêu organizationId cột nguồn (không chép ctx)', pair: P(`'avgUnitCost',x.avg_unit_cost::text,
          'organizationId',x.organization_id)`, `'avgUnitCost',x.avg_unit_cost::text,
          'organizationId',v_org)`),
    run: async env => { await env.grant(['materials.view']); await env.orgWide('materials.view');
      await leak(env, `  WHERE m.organization_id=p_organization_id AND m.deleted_at IS NULL\n    AND (p_category_id`, `  WHERE m.deleted_at IS NULL\n    AND (p_category_id`);
      return (await items(env, 'materials')).includes(MATERIAL.foreign); } },
  { name: 'hàm đọc: chỉ vai authenticated của chính người hỏi', pair: P(`  IF current_user<>'authenticated' OR v_uid IS NULL OR p_ctx->>'userId' IS DISTINCT FROM v_uid::text`,
    `  IF v_uid IS NULL`),
    run: async env => { await env.grant(['network_center.view']);
      return (await direct(env, 'network_fleet', {}, { userId: OUTSIDER })).rows.length >= 0; } },
];
for (const probe of probes) {
  const changed = changedFunctions(...probe.pair);
  test(`mutation is caught: ${probe.name}`, { timeout: 120000 }, async () => {
    await inCase(async env => assert.equal(await probe.run(env).catch(() => false), false, 'bản sống từ chối'));
    await inCase(async env => {
      for (const sql of changed) await env.db.exec(sql);
      assert.equal(await probe.run(env), true, 'bản đột biến lọt');
    });
  });
}
void [JOB_B, CLIENT.loose, ROUTER.foreign, HIDDEN_SUPPLIER];
