import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { sharedW2d, D, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, USER, ORG, FOREIGN, CONTRACT_A, SERVICE } from './wave2-d-sql-fixture.mjs';
import { assertPackageParity } from './wave2-sql-fixture.mjs';
import { changedFunctions } from './full-read-sql-fixture.mjs';
import { W2D_REPORTS } from './wave2-d-contract.mjs';
import { W2, W2_READ_KEY_LIST } from './wave2-registry.mjs';
import { w2Params } from './wave2-kit.mjs';
import { W2_RANGES } from './wave2-sql-paths.mjs';

// Gói D đợt 2 — test RIÊNG của Gói D (chỉ Gói D sửa). MỘT PGlite cho cả file, mỗi ca BEGIN … ROLLBACK.
// Mô hình INVOKER + RLS (quyết định 18/10): hàm dùng chung public.<miền>_*_v1 và hàm gói app_private.hermes_w2d_*
// chạy dưới vai authenticated, RLS (giả lập trong fixture) quyết như web; ctx của cổng chỉ THU HẸP (toà của khoá
// báo cáo ∩ overlay, khoá phụ của kết nối). Cổng INVOKER mới của Gói 0 chưa có ⇒ ca ở đây gọi thẳng
// hermes_w2d_read_v1 với ctx đúng khuôn cổng; ca đầu–cuối qua cổng chạy lại sau khi rebase lên Gói 0.
// Không chứng minh RLS thật của production, JWT thật hay PostgREST; thân get_room_cash_lifecycle_v1 là cổng tổng hợp.
const MIGRATION = readdirSync('supabase/migrations').filter(name => W2_RANGES.d.test(name)).sort();
const LIVE_PATH = `supabase/migrations/${MIGRATION[0]}`;
const live = readFileSync(LIVE_PATH, 'utf8');
const stripComments = sql => sql.replace(/--[^\n]*/g, '');
let shared;
before(async () => { shared = await sharedW2d(); });
after(async () => { await shared?.close(); });
const inCase = work => shared.isolated(work);
const code = expected => error => error.code === expected;
const acl = (db, keys, allowed = true) => Promise.all(keys.map(key => db.query(`INSERT INTO public.fixture_acl(permission,allowed,building_ids) VALUES($1,$2,$3)
  ON CONFLICT(permission) DO UPDATE SET allowed=EXCLUDED.allowed`, [key, allowed, [BUILDING, OTHER_BUILDING]])));
// Khoá phụ mặc định của "kết nối": customers.view và contracts.view phủ toà A (overlay A); khoá khác chưa chọn.
const DEFAULT_SCOPES = { 'customers.view': [BUILDING], 'contracts.view': [BUILDING] };
// Gọi hàm gói đúng như cổng sẽ gọi: ctx {toà của khoá ∩ overlay (mặc định chỉ A), khoá phụ, hôm nay của công ty}.
async function direct(env, report, values = {}, { buildings = [BUILDING], orgWide = false, scopes = {}, userId = USER, role = 'authenticated', actor = USER } = {}) {
  const spec = W2D_REPORTS[report];
  const params = w2Params(spec, values);
  const ctx = { organizationId: ORG, userId, report, permission: spec.permission, scope: spec.scope,
    buildings: params.buildingId ? [params.buildingId] : buildings, requestedBuildingId: params.buildingId ?? null, overlayOrg: orgWide, orgWide,
    isSuperadmin: false, today: '2026-10-16',
    scopes: Object.fromEntries(spec.scopeKeys.map(key => [key, Object.hasOwn(scopes, key) ? scopes[key] : DEFAULT_SCOPES[key] ?? null])) };
  return env.call('SELECT app_private.hermes_w2d_read_v1($1,$2::jsonb,$3::jsonb) result', [report, JSON.stringify(params), JSON.stringify(ctx)], { role, actor });
}
const ids = (rows, key = 'id') => rows.map(row => row[key]);
// Rào thứ hai của broker trên kết quả SQL thật (khuôn từng trường, toà ∈ phạm vi CRM của khoá), trang đầu như cổng cắt.
function fence(report, raw, values = {}) {
  const spec = W2D_REPORTS[report];
  const identity = { effective: { read: [spec.permission] }, scopesByPermission: { [spec.permission]: { buildingIds: [BUILDING, OTHER_BUILDING] } } };
  const input = W2.reads.report.input({ report, params: w2Params(spec, values), limit: 50, offset: 0 });
  const items = raw.rows.slice(0, 50);
  return W2.reads.report.result({ report, source: spec.source, unavailable: raw.unavailable, summary: raw.summary, items, offset: 0,
    nextOffset: raw.rows.length > 50 ? 50 : null, sourceCapped: raw.sourceCapped }, identity, input);
}
const ALL_ACL = ['categories.view', 'suppliers.view', 'hotline.view', 'task_types.view', 'service_quotas.view', 'meters.view', 'buildings.view'];

test('gói D: bảng báo cáo SQL (hermes_w2d_catalog_v1) khớp khai báo JS (W2D_REPORTS)', () => inCase(env => assertPackageParity(env, 'd')));

test('cấu trúc: một migration trong dải D; hàm dùng chung INVOKER search_path rỗng chỉ cho authenticated; helper khu DEFINER; gói INVOKER; không copilot, không ghi', () => inCase(async ({ db }) => {
  assert.equal(MIGRATION.length, 1, 'đúng một migration gói D');
  const body = stripComments(live);
  assert.doesNotMatch(body, /copilot/i);
  assert.doesNotMatch(body, /\bDROP\b|ALTER TABLE|\bINSERT\s+INTO\b|\bUPDATE\s+[a-z_]+\.|\bDELETE\s+FROM\b|CREATE TEMP|check_function_bodies/i);
  const created = [...body.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+\.[a-z0-9_]+)\(/g)].map(match => match[1]);
  const pub = created.filter(name => name.startsWith('public.')), pkg = created.filter(name => name.startsWith('app_private.'));
  assert.equal(created.length, pub.length + pkg.length);
  assert.ok(pkg.every(name => /^app_private\.hermes_w2d_[a-z0-9_]+$/.test(name)), 'gói chỉ tạo app_private.hermes_w2d_*');
  assert.ok(pub.every(name => /^public\.[a-z]+(?:_[a-z0-9]+)*_v1$/.test(name) && !name.includes('hermes')), 'hàm dùng chung public.<miền>_*_v1');
  for (const [report, spec] of Object.entries(W2D_REPORTS)) {
    const source = spec.source.replace(/^crm\./, 'public.');
    assert.ok(pub.includes(source) || source === 'public.get_room_cash_lifecycle_v1', `${report}: ${spec.source}`);
    assert.ok(W2_READ_KEY_LIST.includes(spec.permission) || ['assets.view', 'services.view', 'rooms.view'].includes(spec.permission), spec.permission);
  }
  const procs = (await db.query(`SELECT n.nspname||'.'||p.proname name,p.prosecdef definer,p.proconfig config,p.prosrc src,
      has_function_privilege('authenticated',p.oid,'EXECUTE') auth,has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('service_role',p.oid,'EXECUTE') service
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=ANY($1)`, [created])).rows;
  assert.equal(procs.length, created.length);
  for (const proc of procs) {
    assert.deepEqual([proc.anon, proc.service], [false, false], `${proc.name}: không anon/service_role`);
    if (proc.name === 'app_private.hermes_w2d_catalog_v1') { assert.equal(proc.definer, true); continue; }
    if (proc.name === 'public.areas_in_scope_v1') {
      assert.equal(proc.definer, true, 'helper khu là DEFINER duy nhất');
      assert.match(proc.src, /auth\.uid\(\) IS NULL/);
      assert.match(proc.src, /accessible_building_ids\(\)/);
    } else assert.equal(proc.definer, false, `${proc.name}: INVOKER`);
    assert.deepEqual(proc.config, ['search_path=""'], `${proc.name}: search_path rỗng`);
    if (proc.name.startsWith('public.')) {
      assert.equal(proc.auth, true, `${proc.name}: authenticated`);
      if (proc.name !== 'public.areas_in_scope_v1') assert.match(proc.src, /current_user<>'authenticated' OR auth\.uid\(\) IS NULL/, `${proc.name}: chỉ authenticated`);
    }
  }
}));

test('hàm dùng chung: chỉ authenticated; p_building_ids NULL = toàn phạm vi RLS, {} = rỗng; RLS của người gọi quyết, không chép policy', () => inCase(async env => {
  const { db } = env;
  const call = (sql, args, options) => env.call(sql, args, { role: 'authenticated', ...options });
  assert.deepEqual(await call('SELECT jsonb_agg(room_name ORDER BY room_name) result FROM public.real_estate_vacant_rooms_v1($1,NULL,NULL,$2)', [ORG, '2026-10-16']),
    ['P102', 'P204'], 'NULL: mọi toà RLS cho thấy (P201/P202 có HĐ ACTIVE)');
  assert.equal(await call("SELECT count(*)::int result FROM public.rooms_list_v1($1,'{}'::uuid[])", [ORG]), 0, '{} = rỗng');
  assert.equal(await call('SELECT count(*)::int result FROM public.rooms_list_v1($1,NULL)', [ORG]), 7);
  await db.query('DELETE FROM public.fixture_building_access WHERE building_id=$1', [OTHER_BUILDING]);
  assert.equal(await call('SELECT count(*)::int result FROM public.rooms_list_v1($1,NULL)', [ORG]), 5, 'RLS toà của người gọi');
  assert.equal(await call('SELECT count(*)::int result FROM public.rooms_list_v1($1,$2)', [ORG, [OTHER_BUILDING]]), 0, 'thu hẹp không nới được RLS');
  assert.equal(await call('SELECT count(*)::int result FROM public.rooms_list_v1($1,NULL)', [FOREIGN]), 0, 'công ty khác ⇒ 0');
  await assert.rejects(env.call('SELECT count(*)::int result FROM public.rooms_list_v1($1,NULL)', [ORG], { role: 'postgres' }), code('42501'), 'gọi từ DEFINER/chủ bảng bị từ chối');
  await assert.rejects(env.call('SELECT count(*)::int result FROM public.rooms_list_v1($1,NULL)', [ORG], { role: 'anon' }), /permission denied/);
  await assert.rejects(env.call('SELECT count(*)::int result FROM public.rooms_list_v1($1,NULL)', [ORG], { role: 'authenticated', actor: '' }), code('42501'), 'không JWT');
}));

test('rào broker: kết quả SQL thật của cả 22 báo cáo qua được khuôn JS (trường, toà ∈ phạm vi)', () => inCase(async env => {
  await acl(env.db, ALL_ACL); await acl(env.db, ['thu_tien.view']);
  for (const [report, spec] of Object.entries(W2D_REPORTS)) {
    const values = report === 'building_detail' ? { buildingId: BUILDING } : spec.required.includes('roomId') ? { roomId: ROOM } : {};
    const raw = await direct(env, report, values, { buildings: [BUILDING, OTHER_BUILDING], orgWide: true,
      scopes: { 'customers.view': [BUILDING], 'categories.view': [BUILDING], 'suppliers.view': [BUILDING], 'tasks.view': [BUILDING] } });
    assert.equal(raw.unavailable, null, report);
    assert.ok(raw.rows.length > 0, `${report}: có hàng`);
    assert.doesNotThrow(() => fence(report, raw, values), report);
  }
}));

test('BĐS phòng trống: không HĐ ACTIVE (bỏ HĐ đã xoá), trừ giữ chỗ; số ngày trống; toà theo ctx; tầng; không cắt 1000', () => inCase(async env => {
  const value = await direct(env, 're_vacant_rooms');
  assert.deepEqual(ids(value.rows, 'roomId'), [D.ROOM_A2, D.ROOM_A4], 'P102 (HĐ ACTIVE đã xoá không tính), P204 bảo trì vẫn trống như web');
  assert.deepEqual(value.rows.map(row => [row.daysVacant, row.lastEndDate]), [[6, '2026-10-10'], [76, '2026-08-01']]);
  assert.deepEqual(value.summary, { total: 2, vacantUpTo7Days: 1, vacant8To30Days: 0, vacantOver30Days: 1, unknownSince: 0 });
  assert.deepEqual(ids((await direct(env, 're_vacant_rooms', { floor: 2 })).rows, 'roomId'), [D.ROOM_A4]);
  await env.db.query(`INSERT INTO public.rooms(id,organization_id,building_id,name,status,rent_price,floor)
    SELECT gen_random_uuid(),$1,$2,'Z'||lpad(n::text,5,'0'),'AVAILABLE',1,3 FROM generate_series(1,2001) n`, [ORG, BUILDING]);
  const big = await direct(env, 're_vacant_rooms');
  assert.deepEqual([big.sourceCapped, big.rows.length, big.summary.total, big.summary.unknownSince], [true, 2000, 2003, 2001]);
}));

test('BĐS sắp hết hạn: ACTIVE chưa xoá trong N ngày; tên khách cần RLS customers (khoá + chủ hồ sơ) VÀ customers.view của kết nối', () => inCase(async env => {
  const { db } = env;
  let value = await direct(env, 're_expiring');
  assert.deepEqual(value.rows.map(row => [row.contractId, row.daysLeft, row.customerName, row.customerPhone]),
    [[D.C_SOON, 9, 'Khách Chưa Hợp Đồng', '0955555555']], 'HĐ toà B và HĐ đã xoá không có');
  assert.deepEqual(value.summary, { days: 30, total: 1, within7Days: 0, within8To15Days: 1, within16To30Days: 0 });
  assert.equal((await direct(env, 're_expiring', { days: 7 })).rows.length, 0);
  value = await direct(env, 're_expiring', {}, { scopes: { 'customers.view': null } });
  assert.deepEqual([value.rows[0].customerName, value.rows.length], [null, 1], 'kết nối không chọn customers.view');
  await db.exec('DELETE FROM public.fixture_visible_owners');
  value = await direct(env, 're_expiring');
  assert.deepEqual([value.rows[0].customerName, value.rows[0].customerPhone], [null, null], 'RLS: chủ hồ sơ không còn trong công ty');
}));

test('BĐS gia hạn & chuyển nhượng; khuyến mại; HĐ mới; thanh lý — số như bộ lọc web', () => inCase(async env => {
  let value = await direct(env, 're_renewals_transfers');
  assert.deepEqual(value.rows.map(row => [row.kind, row.eventId, row.eventDate, row.rentPrice, row.customerName]),
    [['RENEWAL', D.EXT_A, '2026-09-20', '3800000.00', 'Nguyễn Văn An'], ['TRANSFER', D.C_TRANSFER, '2026-09-16', '3600000.00', 'Nguyễn Văn An']]);
  assert.deepEqual(value.summary, { total: 2, renewals: 1, transfers: 1 });
  assert.deepEqual(ids((await direct(env, 're_renewals_transfers', { fromDate: '2026-09-17' })).rows, 'eventId'), [D.EXT_A]);
  value = await direct(env, 're_promotions');
  const byId = Object.fromEntries(value.rows.map(row => [row.contractId, row]));
  assert.deepEqual(Object.keys(byId).sort(), [CONTRACT_A, D.C_END, D.C_SOON].sort(), 'discounts IS NOT NULL như web (kể cả [])');
  assert.deepEqual([byId[CONTRACT_A].discountType, byId[CONTRACT_A].savings, byId[CONTRACT_A].effectiveRent], ['percent', '350000.00', '3150000.00']);
  assert.deepEqual([byId[D.C_SOON].savings, byId[D.C_SOON].discountMonths, byId[D.C_SOON].amountPerMonth], ['0.00', 3, '500000.00']);
  assert.deepEqual(value.summary, { total: 3, active: 2, totalSavings: '350000.00', avgSavings: '116666.67', withDiscountTerms: 2 });
  value = await direct(env, 're_new_leases');
  assert.deepEqual(value.rows.map(row => [row.contractId, row.status, row.durationMonths, row.totalValue]), [[D.C_DRAFT, 'DRAFT', 12, '36000000.00']]);
  assert.deepEqual(value.summary, { fromDate: '2026-10-01', toDate: '2026-10-31', total: 1, totalValue: '36000000.00', avgRent: '3000000.00', avgDurationMonths: 12 });
  assert.deepEqual(ids((await direct(env, 're_new_leases', { fromDate: '2026-01-01', toDate: '2026-10-31' })).rows, 'contractId'),
    [D.C_DRAFT, D.C_TRANSFER, D.C_SOON, CONTRACT_A]);
  value = await direct(env, 're_terminations');
  assert.deepEqual(value.rows.map(row => [row.contractId, row.terminationType, row.note, row.durationDays, row.customerName]),
    [[D.C_END, 'EARLY', 'Khách chuyển đi sớm', 374, 'Lê Ở Ghép']], 'không khách đại diện ⇒ khách đầu tiên như repName của web');
  assert.deepEqual(value.summary, { fromDate: '2026-10-01', toDate: '2026-10-16', total: 1, terminated: 1, expired: 0, totalContracts: 5, terminationRatePct: '20.0' });
  value = await direct(env, 're_terminations', { fromDate: '2026-08-01', toDate: '2026-10-16' });
  assert.deepEqual([ids(value.rows, 'contractId'), value.summary.expired], [[D.C_END, D.C_EXP], 1]);
}));

test('BĐS tỷ lệ chi phí: RLS web (loại cần categories.view, phiếu hạn chế theo quyền xem hạn chế) + thu hẹp theo khoá phụ của kết nối', () => inCase(async env => {
  const { db } = env;
  const cat = { 'categories.view': [BUILDING] };
  let value = await direct(env, 're_expense_ratio', {}, { scopes: cat });
  assert.equal(value.summary.totalExpense, '0.00', 'RLS: thiếu categories.view ⇒ phần chi = 0 như web');
  await acl(db, ['categories.view']);
  value = await direct(env, 're_expense_ratio', {}, { scopes: cat });
  assert.deepEqual(value.rows.map(row => [row.month, row.revenue, row.expense, row.ratioPct]), [['2026-05', '0.00', '0.00', null],
    ['2026-06', '0.00', '0.00', null], ['2026-07', '0.00', '0.00', null], ['2026-08', '0.00', '300000.00', null], ['2026-09', '8000000.00', '0.00', '0.00'],
    ['2026-10', '10000000.00', '1200000.00', '12.00']]);
  assert.deepEqual(value.summary, { fromMonth: '2026-05', toMonth: '2026-10', totalRevenue: '18000000.00', totalExpense: '1500000.00', avgRatioPct: '6.00',
    peakMonth: '2026-10', peakRatioPct: '12.00', categories: ['Bảo trì', 'Nhân sự'], expenseTypesVisible: true, category: null });
  assert.deepEqual((await direct(env, 're_expense_ratio', { kind: 'type' }, { scopes: cat })).rows.map(row => [row.category, row.typeName, row.expense]),
    [['Bảo trì', 'Sửa chữa', '1200000.00'], ['Nhân sự', 'Ứng lương', '300000.00']]);
  assert.deepEqual((await direct(env, 're_expense_ratio', { kind: 'category', query: 'Bảo trì' }, { scopes: cat })).rows.map(row => [row.month, row.expense]),
    [['2026-10', '1200000.00']]);
  await db.query('INSERT INTO public.fixture_restricted_viewers VALUES($1)', [USER]);
  assert.equal((await direct(env, 're_expense_ratio', {}, { scopes: cat })).summary.totalExpense, '1500000.00', 'web thấy phiếu hạn chế, kết nối không chọn khoá');
  value = await direct(env, 're_expense_ratio', {}, { scopes: { ...cat, 'income_expenses.restricted_view': [BUILDING] } });
  assert.equal(value.summary.totalExpense, '2000000.00', 'RLS + khoá hạn chế trong kết nối ⇒ +500 000 tháng 10');
  value = await direct(env, 're_expense_ratio', {}, { scopes: { 'categories.view': null } });
  assert.deepEqual([value.summary.totalExpense, value.summary.totalRevenue, value.summary.expenseTypesVisible], ['0.00', '18000000.00', false],
    'kết nối không chọn categories.view');
}));

test('tài sản: toà theo ctx, giá trị = giá × SL, NCC cần RLS suppliers + suppliers.view của kết nối; chưa gắn toà chỉ Toàn tổ chức; không ảnh/mô tả', () => inCase(async env => {
  const { db } = env;
  await acl(db, ['suppliers.view']);
  const sup = { 'suppliers.view': [BUILDING] };
  let value = await direct(env, 'assets', {}, { scopes: sup });
  assert.deepEqual(value.rows.map(row => [row.id, row.quantity, row.totalValue, row.supplierName]),
    [[D.ASSET_BROKEN, 1, '0.00', null], [D.ASSET_A, 2, '2000000.00', 'Điện máy Xanh']], 'NCC của chủ hồ sơ ngoài công ty bị RLS ẩn');
  assert.deepEqual(value.summary, { total: 2, totalValue: '2000000.00', goodOrNew: 1, poorOrBroken: 1 });
  assert.ok(value.rows.every(row => !('images' in row) && !('description' in row)));
  assert.deepEqual(ids((await direct(env, 'assets', { query: 'điều' }, { scopes: sup })).rows), [D.ASSET_A], 'tìm theo tên loại như web');
  assert.deepEqual(ids((await direct(env, 'assets', { status: 'BROKEN' })).rows), [D.ASSET_BROKEN]);
  assert.deepEqual(ids((await direct(env, 'assets', { roomId: ROOM })).rows), [D.ASSET_A]);
  assert.equal((await direct(env, 'assets')).rows[1].supplierName, null, 'kết nối không chọn suppliers.view');
  value = await direct(env, 'assets', {}, { buildings: [BUILDING, OTHER_BUILDING], orgWide: true });
  assert.deepEqual(ids(value.rows), [D.ASSET_FREE, D.ASSET_B, D.ASSET_BROKEN, D.ASSET_A], 'Toàn tổ chức: thêm toà B + chưa gắn toà; không công ty khác');
  await assert.rejects(direct(env, 'assets', { roomId: OTHER_ROOM }), code('42501'), 'phòng ngoài toà của ctx');
}));

test('dịch vụ, định mức, NCC, công tơ, tầng: toà theo ctx; RLS org-entity; NCC chỉ id+tên; công tơ không serial', () => inCase(async env => {
  const { db } = env;
  await acl(db, ['service_quotas.view', 'suppliers.view']);
  assert.deepEqual((await direct(env, 'services')).rows.map(row => [row.id, row.buildingIds]), [[SERVICE, [BUILDING]]]);
  const all = await direct(env, 'services', {}, { buildings: [BUILDING, OTHER_BUILDING], orgWide: true });
  assert.deepEqual(all.rows.map(row => [row.id, row.buildingIds.length]).sort(), [[SERVICE, 2], [D.SERVICE_B, 1], [D.SERVICE_FREE, 0]].sort());
  assert.deepEqual(ids((await direct(env, 'services', { kind: 'TIEN_NUOC' }, { buildings: [BUILDING, OTHER_BUILDING], orgWide: true })).rows), [D.SERVICE_B]);
  assert.deepEqual((await direct(env, 'service_quotas', {}, { orgWide: true })).rows.map(row => [row.id, row.tierCount, row.tiers.map(tier => tier.tierNumber)]),
    [[D.QUOTA, 2, [1, 2]]], 'định mức công ty khác không có');
  assert.deepEqual((await direct(env, 'suppliers', {}, { orgWide: true })).rows, [{ id: D.SUPPLIER, name: 'Điện máy Xanh' }]);
  await acl(db, ['service_quotas.view'], false);
  assert.deepEqual((await direct(env, 'service_quotas', {}, { orgWide: true })).rows, [], 'RLS: mất khoá web ⇒ rỗng');
  const meters = await direct(env, 'meters');
  assert.deepEqual(meters.rows.map(row => [row.id, row.latestReading, row.latestReadingDate]), [[D.METER_A, '240.00', '2026-10-15']]);
  assert.ok(!('serialNumber' in meters.rows[0]));
  assert.deepEqual((await direct(env, 'floors')).rows.map(row => [row.id, row.floorNumber]), [[D.FLOOR_A1, 1], [D.FLOOR_A2, 2]]);
}));

test('toà, khu, chi tiết toà: danh sách trắng; khu qua helper phạm vi toà thật (RLS areas lệch chỉ cho quản trị)', () => inCase(async env => {
  const { db } = env;
  let value = await direct(env, 'buildings');
  assert.deepEqual(ids(value.rows, 'buildingId'), [BUILDING]);
  const row = value.rows[0];
  for (const key of ['commissionTiers', 'commissionChangeReason', 'defaultAccountIdTt', 'publicContactPhone', 'latitude']) assert.ok(!(key in row), key);
  assert.ok(!JSON.stringify(value).includes('bí mật') && !JSON.stringify(value).includes('0909000000'), 'không lộ giá trị cột bị loại');
  assert.deepEqual([row.address, row.areaNames, row.roomsTotal, row.roomsOccupied, row.updatedOn],
    ['12 Lê Lợi, Phường 1, Quận 3, TP HCM', ['Khu Trung tâm'], 5, 2, '2026-10-16'], 'tên khu có dù RLS areas không cho người không quản trị');
  assert.equal(await env.call('SELECT count(*)::int result FROM public.areas', [], { role: 'authenticated' }), 0, 'RLS areas lệch (giả lập)');
  assert.deepEqual(ids((await direct(env, 'buildings', { areaId: D.AREA_B })).rows, 'buildingId'), []);
  assert.deepEqual((await direct(env, 'areas')).rows.map(area => [area.id, area.buildingIds]), [[D.AREA_AB, [BUILDING]]]);
  assert.equal((await direct(env, 'building_detail', { buildingId: BUILDING })).rows[0].description, 'Toà mẫu');
  await db.query('DELETE FROM public.fixture_building_access WHERE building_id=$1', [BUILDING]);
  assert.deepEqual(ids((await direct(env, 'areas', {}, { buildings: [BUILDING, OTHER_BUILDING], orgWide: true })).rows), [D.AREA_B, D.AREA_AB],
    'helper: chỉ khu có toà người hỏi thấy (B); khu trống cần toàn phạm vi toà');
  await db.query('INSERT INTO public.fixture_admins VALUES($1)', [USER]);
  assert.deepEqual(ids((await direct(env, 'areas', {}, { buildings: [BUILDING, OTHER_BUILDING], orgWide: true })).rows),
    [D.AREA_EMPTY, D.AREA_B, D.AREA_AB]);
  await assert.rejects(env.call('SELECT count(*)::int result FROM public.areas_in_scope_v1($1)', [FOREIGN], { role: 'authenticated' }), code('42501'),
    'helper: công ty không phải của người hỏi');
}));

test('phòng: trạng thái hiển thị như getRoomDisplayStatus; chi tiết phòng: HĐ cần contracts.view, người ở cần customers.view của kết nối', () => inCase(async env => {
  let value = await direct(env, 'rooms');
  assert.deepEqual(value.rows.map(row => [row.name, row.displayStatus]), [['P101', 'OCCUPIED'], ['P102', 'AVAILABLE'], ['P103', 'RESERVED'],
    ['P204', 'MAINTENANCE'], ['P205', 'EXPIRING_SOON']]);
  assert.deepEqual(value.summary, { total: 5, available: 1, expiringSoon: 1, reserved: 1 });
  assert.deepEqual(ids((await direct(env, 'rooms', { status: 'ACTIVE' })).rows, 'name'), ['P102'], 'ACTIVE = AVAILABLE như web');
  assert.deepEqual(ids((await direct(env, 'rooms', { query: 'a10' })).rows, 'name'), ['P101', 'P102']);
  value = await direct(env, 'room_detail', { roomId: ROOM });
  assert.deepEqual([value.rows[0].contract.contractNumber, value.rows[0].tenants.map(tenant => tenant.name)], ['HD-A', ['Nguyễn Văn An', 'Lê Ở Ghép']]);
  value = await direct(env, 'room_detail', { roomId: ROOM }, { scopes: { 'customers.view': null, 'contracts.view': null } });
  assert.deepEqual([value.rows[0].contractVisible, value.rows[0].contract, value.rows[0].tenantsVisible, value.rows[0].tenants], [false, null, false, []]);
  await assert.rejects(direct(env, 'room_detail', { roomId: OTHER_ROOM }), code('42501'), 'phòng toà B ngoài ctx');
}));

test('dòng tiền phòng: RPC web gọi thẳng; bỏ meta/tên bảng tenants/segments; RPC tự kiểm can_access_building', () => inCase(async env => {
  const { db } = env;
  const value = await direct(env, 'room_cash_lifecycle', { roomId: ROOM });
  assert.deepEqual(value.rows.map(row => [row.type, row.amount, row.trusted]), [['CONTRACT_OPENED', null, true], ['COMMISSION_PAID', '350000.00', false]]);
  const text = JSON.stringify(value);
  for (const secret of ['Hoa hồng cho', 'PC-HH', 'sourcePath', 'Tên bảng tenants cũ', 'diagnostic']) assert.ok(!text.includes(secret), secret);
  await db.exec(`DELETE FROM public.fixture_building_access WHERE building_id='${BUILDING}'`);
  await assert.rejects(direct(env, 'room_cash_lifecycle', { roomId: ROOM }), code('42501'), 'RLS + RPC web');
}));

test('loại thu chi, loại việc, hotline: ẩn hạn chế/lương; khử trùng như web; không bonus/lương; bộ phận/nhóm theo RLS + khoá phụ', () => inCase(async env => {
  const { db } = env;
  await acl(db, ['categories.view', 'task_types.view', 'hotline.view']);
  await db.query('INSERT INTO public.fixture_restricted_viewers VALUES($1)', [USER]);
  let value = await direct(env, 'ie_types', {}, { orgWide: true });
  assert.deepEqual(value.rows.map(row => row.name), ['Sửa chữa', 'Ẩn', 'Tiền phòng'], 'bỏ Lương (hạn chế, dù RLS cho xem), Ứng lương (rule lương), bản trùng, công ty khác');
  assert.deepEqual(ids((await direct(env, 'ie_types', { kind: 'income' }, { orgWide: true })).rows, 'name'), ['Tiền phòng']);
  value = await direct(env, 'task_types', {}, { orgWide: true, scopes: { 'tasks.view': [BUILDING] } });
  assert.deepEqual(value.rows.map(row => [row.name, row.departmentName, row.jobGroupName]), [['Dọn phòng', null, null], ['Sửa điện', 'Kỹ thuật', 'Sửa chữa']],
    'bộ phận của người khác ẩn như RLS departments');
  assert.ok(!JSON.stringify(value).includes('bonus') && !JSON.stringify(value).includes('50000') && !JSON.stringify(value).includes('counts'));
  await db.query('INSERT INTO public.fixture_admins VALUES($1)', [USER]);
  assert.equal((await direct(env, 'task_types', {}, { orgWide: true })).rows[0].departmentName, 'Phòng người khác', 'quản trị thấy mọi bộ phận như RLS');
  assert.equal((await direct(env, 'task_types', {}, { orgWide: true })).rows[1].jobGroupName, null, 'kết nối không chọn tasks.view');
  assert.deepEqual(ids((await direct(env, 'task_types', { query: 'điện' }, { orgWide: true })).rows, 'name'), ['Sửa điện']);
  assert.deepEqual((await direct(env, 'hotlines', {}, { orgWide: true })).rows.map(row => row.id), [D.HOTLINE], 'RLS: hotline của chủ hồ sơ ngoài công ty ẩn');
}));

test('hàm gói: chỉ authenticated đúng người của ctx; ctx sai báo cáo/khoá ⇒ 22023; không hàng nào của công ty khác', () => inCase(async env => {
  await acl(env.db, ALL_ACL); await acl(env.db, ['thu_tien.view']);
  await assert.rejects(direct(env, 'rooms', {}, { role: 'postgres' }), code('42501'), 'gọi từ DEFINER bị từ chối');
  await assert.rejects(direct(env, 'rooms', {}, { userId: FOREIGN }), code('42501'), 'ctx của người khác');
  await assert.rejects(env.call('SELECT app_private.hermes_w2d_read_v1($1,$2::jsonb,$3::jsonb) result', ['rooms', '{}', JSON.stringify({ userId: USER,
    report: 'rooms', permission: 'buildings.view' })], { role: 'authenticated' }), code('22023'), 'khoá không khớp báo cáo');
  for (const [report, spec] of Object.entries(W2D_REPORTS)) {
    const values = report === 'building_detail' ? { buildingId: BUILDING } : spec.required.includes('roomId') ? { roomId: ROOM } : {};
    const text = JSON.stringify(await direct(env, report, values, { buildings: [BUILDING, OTHER_BUILDING], orgWide: true }));
    for (const foreign of ['Công ty khác', 'Khác công ty', 'Việc công ty khác', 'Loại công ty khác', 'Toà ngoài', 'HD-F']) assert.ok(!text.includes(foreign), `${report}: ${foreign}`);
  }
}));

// Đột biến: mỗi bản bỏ MỘT hàng rào của gói D; phép thử mà bản sống từ chối thì bản đột biến phải lọt.
const replaceExactly = (from, to) => { assert.equal(live.split(from).length, 2, `anchor: ${from}`); return live.replace(from, () => to); };
const probes = [
  { name: 'phòng trống: HĐ ACTIVE đã xoá không chiếm phòng', sql: replaceExactly(
    `    AND NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.room_id=r.id AND c.deleted_at IS NULL AND c.status::text='ACTIVE')`,
    `    AND NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.room_id=r.id AND c.status::text='ACTIVE')`),
    run: async env => !ids((await direct(env, 're_vacant_rooms')).rows, 'roomId').includes(D.ROOM_A2) },
  { name: 'phòng trống: bỏ phòng giữ chỗ', sql: replaceExactly(`AND r.deleted_at IS NULL AND r.status::text<>'RESERVED'`, `AND r.deleted_at IS NULL`),
    run: async env => ids((await direct(env, 're_vacant_rooms')).rows, 'roomId').includes(D.ROOM_A3) },
  { name: 'hàm dùng chung chỉ chạy dưới vai authenticated', sql: replaceExactly(`RETURNS TABLE(supplier_id uuid,name text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;`,
    `RETURNS TABLE(supplier_id uuid,name text)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN`),
    run: async env => (await env.call('SELECT count(*)::int result FROM public.suppliers_list_v1($1)', [ORG], { role: 'postgres' })) > 1 },
  { name: 'hàm gói: ctx phải của chính người hỏi', sql: replaceExactly(
    `  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text`,
    `  IF current_user<>'authenticated' OR auth.uid() IS NULL`),
    run: async env => (await direct(env, 'rooms', {}, { userId: FOREIGN })).rows.length > 0 },
  { name: 'PII: tên khách cần customers.view của kết nối', sql: replaceExactly(
    `  v_customers uuid[]:=COALESCE(app_private.hermes_w2d_scope_v1(p_ctx,'customers.view'),'{}'::uuid[]);`,
    `  v_customers uuid[]:=app_private.hermes_w2d_buildings_v1(p_ctx);`),
    run: async env => (await direct(env, 're_expiring', {}, { scopes: { 'customers.view': null } })).rows[0].customerName !== null },
  { name: 'tỷ lệ chi phí: phiếu hạn chế cần khoá hạn chế của kết nối', sql: replaceExactly(
    `      AND (p_restricted_building_ids IS NULL OR NOT COALESCE(ie.has_restricted_item,true) OR ie.building_id=ANY(p_restricted_building_ids))),`, `),`),
    run: async env => { await acl(env.db, ['categories.view']); await env.db.query('INSERT INTO public.fixture_restricted_viewers VALUES($1)', [USER]);
      return (await direct(env, 're_expense_ratio', {}, { scopes: { 'categories.view': [BUILDING] } })).summary.totalExpense !== '1500000.00'; } },
  { name: 'tỷ lệ chi phí: phần chi cần categories.view của kết nối', sql: replaceExactly(`      WHERE r.row_kind='revenue' OR v_cat_visible),`, `      WHERE true),`),
    run: async env => { await acl(env.db, ['categories.view']); return (await direct(env, 're_expense_ratio')).summary.totalExpense !== '0.00'; } },
  { name: 'tài sản: tên NCC cần suppliers.view của kết nối', sql: replaceExactly(`'supplierName',CASE WHEN v_suppliers THEN`, `'supplierName',CASE WHEN true THEN`),
    run: async env => { await acl(env.db, ['suppliers.view']); return (await direct(env, 'assets')).rows.some(row => row.supplierName !== null); } },
  { name: 'loại thu chi: ẩn hạn chế', sql: replaceExactly(`        WHERE NOT COALESCE(t.is_restricted,true)
          AND`, `        WHERE true
          AND`),
    run: async env => { await acl(env.db, ['categories.view']); await env.db.query('INSERT INTO public.fixture_restricted_viewers VALUES($1)', [USER]);
      return ids((await direct(env, 'ie_types', {}, { orgWide: true })).rows, 'name').includes('Lương'); } },
  { name: 'loại thu chi: ẩn hạng mục lương theo rule_key', sql: replaceExactly(
    `          AND COALESCE(t.rule_key,'') NOT IN ('luong_dieu_hanh','luong_quan_ly','ung_luong','chia_loi_nhuan')) x;`, `) x;`),
    run: async env => { await acl(env.db, ['categories.view']); return ids((await direct(env, 'ie_types', {}, { orgWide: true })).rows, 'name').includes('Ứng lương'); } },
  { name: 'chi tiết phòng: HĐ cần contracts.view của kết nối', sql: replaceExactly(`'contract',CASE WHEN r.building_id=ANY(v_contracts) THEN`, `'contract',CASE WHEN true THEN`),
    run: async env => (await direct(env, 'room_detail', { roomId: ROOM }, { scopes: { 'contracts.view': null } })).rows[0].contract !== null },
  { name: 'roomId phải thuộc toà của ctx', sql: replaceExactly(`    IF v_room_building IS NULL OR NOT(v_room_building=ANY(v_buildings)) THEN`, `    IF v_room_building IS NULL THEN`),
    run: async env => direct(env, 'assets', { roomId: OTHER_ROOM }).then(() => true) },
  { name: 'helper khu: chỉ khu có toà trong phạm vi toà thật', sql: replaceExactly(`    AND (v_full OR EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.buildings b ON b.id=ab.building_id`,
    `    AND (true OR EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.buildings b ON b.id=ab.building_id`),
    run: async env => { await env.db.query('DELETE FROM public.fixture_building_access WHERE building_id=$1', [OTHER_BUILDING]);
      return (await env.call('SELECT count(*)::int result FROM public.areas_in_scope_v1($1)', [ORG], { role: 'authenticated' })) > 1; } },
  { name: 'helper khu: người hỏi phải là thành viên công ty', sql: replaceExactly(
    `  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT (p_organization_id=ANY(COALESCE(public.my_org_ids(),'{}'::uuid[])))`,
    `  IF auth.uid() IS NULL OR p_organization_id IS NULL`),
    run: async env => (await env.call('SELECT count(*)::int result FROM public.areas_in_scope_v1($1)', [FOREIGN], { role: 'authenticated' })) >= 0 },
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
