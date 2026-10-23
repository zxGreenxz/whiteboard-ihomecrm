import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { sharedW2d, D, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, USER, ORG, FOREIGN, CONTRACT_A, SERVICE } from './wave2-d-sql-fixture.mjs';
import { assertPackageParity, binding } from './wave2-sql-fixture.mjs';
import { changedFunctions } from './full-read-sql-fixture.mjs';
import { W2D_REPORTS } from './wave2-d-contract.mjs';
import { W2, W2_READ_KEY_LIST } from './wave2-registry.mjs';
import { w2Params } from './wave2-kit.mjs';
import { W2_RANGES, w2FenceViolations, w2AllMigrations } from './wave2-sql-paths.mjs';

// Gói D đợt 2 — test RIÊNG của Gói D (chỉ Gói D sửa). MỘT PGlite cho cả file, mỗi ca BEGIN … ROLLBACK.
// Mô hình INVOKER + RLS (cổng chính thức Gói 0 @ 2cb3d466): lối vào public.hermes_w2_read_v1 (vai authenticated) →
// bước kiểm quyền DEFINER của nền → app_private.hermes_w2d_read_v1 (INVOKER) → hàm dùng chung public.<miền>_*_v1
// dưới RLS giả lập của fixture → bước kết thúc (rào đầu ra, phân trang). Không chứng minh RLS thật của production,
// JWT thật hay PostgREST; thân get_room_cash_lifecycle_v1 là cổng tổng hợp.
const FILES = readdirSync('supabase/migrations').filter(name => W2_RANGES.d.test(name)).sort();
const SHARED_SQL = readFileSync(`supabase/migrations/${FILES[0]}`, 'utf8');
const CATALOG_SQL = readFileSync(`supabase/migrations/${FILES[1]}`, 'utf8');
// Sửa sau review PR #203: 040200 = bản CUỐI của report_text_v1, areas_in_scope_v1 (file hàm dùng chung, không chữ hermes_);
// 040300 = bản CUỐI của hàm đọc. Đột biến neo vào bản cuối.
const SHARED_FIX_SQL = readFileSync(`supabase/migrations/${FILES[2]}`, 'utf8');
const READER_SQL = readFileSync(`supabase/migrations/${FILES[3]}`, 'utf8');
// Đợt 2 trang Hợp đồng: file hàm dùng chung mới (không chữ hermes_) rồi bản cuối của bảng báo cáo và hàm đọc (ba báo cáo đọc bù).
const CONTRACT_SHARED_SQL = readFileSync(`supabase/migrations/${FILES[4]}`, 'utf8');
const CONTRACT_READS_SQL = readFileSync(`supabase/migrations/${FILES[5]}`, 'utf8');
// Mốc 5: bản cuối của bảng báo cáo + hàm đọc (thêm báo cáo nháp HĐ chưa ký), dựng từ thân 043617.
const CONTRACT_DRAFTS_SQL = readFileSync(`supabase/migrations/${FILES[6]}`, 'utf8');
const stripComments = sql => sql.replace(/--[^\n]*/g, '');
let shared;
before(async () => { shared = await sharedW2d(); });
after(async () => { await shared?.close(); });
const inCase = work => shared.isolated(work);
const code = expected => error => error.code === expected;
const ORG_SCOPE = '00000000-0000-4000-8000-0000000000a1';
const FOREIGN_AREA = '0d0d0d0d-0000-4000-8000-0000000000f1';
const GLOBAL_IE_TYPES = ['0d0d0d0d-0000-4000-8000-0000000000f2', '0d0d0d0d-0000-4000-8000-0000000000f3', '0d0d0d0d-0000-4000-8000-0000000000f4'];
// Quyền CRM/RLS giả lập (fixture_acl) mà KHÔNG đổi Read của kết nối.
const acl = (db, keys, allowed = true) => Promise.all(keys.map(key => db.query(`INSERT INTO public.fixture_acl(permission,allowed,building_ids) VALUES($1,$2,$3)
  ON CONFLICT(permission) DO UPDATE SET allowed=EXCLUDED.allowed`, [key, allowed, [BUILDING, OTHER_BUILDING]])));
const dropRead = (db, key) => db.query('UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,$1)', [key]);
// Toàn tổ chức cho các khoá: CRM org_wide + overlay ORGANIZATION ở kết nối và chính sách.
async function orgWide(env, keys) {
  for (const key of keys) await env.db.query('UPDATE public.fixture_acl SET org_wide=true WHERE permission=$1', [key]);
  for (const table of ['hermes_connections', 'hermes_org_policies'])
    await env.db.query(`UPDATE app_private.${table} SET scope_ids=ARRAY(SELECT DISTINCT unnest(array_append(scope_ids,$1::uuid)))`, [ORG_SCOPE]);
}
const run = (env, report, values = {}, extra = {}, options) =>
  env.report(report, w2Params(W2D_REPORTS[report], values), { limit: 50, ...extra }, binding, options);
const ids = (rows, key = 'id') => rows.map(row => row[key]);
const valuesFor = (report, spec) => report === 'building_detail' ? { buildingId: BUILDING } : spec.required.includes('roomId') ? { roomId: ROOM } : {};
// Rào thứ hai của broker trên kết quả thật của cổng (khuôn từng trường, fence, toà ∈ phạm vi CRM của khoá).
function fence(report, value, values = {}) {
  const spec = W2D_REPORTS[report];
  const identity = { effective: { read: [spec.permission] }, scopesByPermission: { [spec.permission]: { buildingIds: [BUILDING, OTHER_BUILDING] } } };
  return W2.reads.report.result(value, identity, W2.reads.report.input({ report, params: w2Params(spec, values), limit: 50 }));
}
const KEYS = [...new Set(Object.values(W2D_REPORTS).map(spec => spec.permission))];
const ORG_KEYS = [...new Set(Object.values(W2D_REPORTS).filter(spec => spec.scope === 'organization').map(spec => spec.permission))];

test('gói D: bảng báo cáo SQL (hermes_w2d_catalog_v1) khớp khai báo JS (W2D_REPORTS)', () => inCase(env => assertPackageParity(env, 'd')));

test('cấu trúc: ba file dải D; hàng rào gói; hàm dùng chung INVOKER search_path rỗng, chỉ authenticated, tự kiểm khoá web; không DEFINER; hàm đọc INVOKER không gọi app_private', () => inCase(async ({ db }) => {
  assert.deepEqual(FILES, ['20261018040000_hermes_w2d_catalog_read_v1.sql', '20261018040100_hermes_w2d_reader_v1.sql',
    '20261018040200_hermes_w2d_shared_fixes_v1.sql', '20261018040300_hermes_w2d_reader_fixes_v1.sql',
    // Đợt 2 trang Hợp đồng (sau công tắc, tên giờ thực): hai hàm dùng chung mới, rồi bảng báo cáo + hàm đọc (ba báo cáo đọc bù).
    '20261022032205_hermes_w2d_contract_shared_v1.sql', '20261022043617_hermes_w2d_contract_reads_v1.sql',
    '20261022075119_hermes_w2d_contract_drafts_v1.sql']);
  assert.deepEqual(w2FenceViolations(w2AllMigrations()), [], 'hàng rào gói của nền (P2-4)');
  for (const sql of [SHARED_SQL, CATALOG_SQL, SHARED_FIX_SQL, READER_SQL, CONTRACT_SHARED_SQL, CONTRACT_READS_SQL, CONTRACT_DRAFTS_SQL]) {
    assert.doesNotMatch(stripComments(sql), /copilot/i);
    assert.doesNotMatch(stripComments(sql), /\bDROP\b|ALTER TABLE|\bINSERT\s+INTO\b|\bUPDATE\s+[a-z_]+\.|\bDELETE\s+FROM\b|CREATE TEMP|check_function_bodies|\bGRANT\b[^;]*hermes_w2d|\bREVOKE\b[^;]*hermes_w2d_read/i);
  }
  const created = sql => [...stripComments(sql).matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+\.[a-z0-9_]+)\(/g)].map(match => match[1]);
  const pub = [...created(SHARED_SQL), ...created(CONTRACT_SHARED_SQL)].filter(name => name.startsWith('public.'));
  assert.deepEqual(created(SHARED_SQL).filter(name => !name.startsWith('public.')), [], 'file hàm dùng chung không có hàm nội bộ');
  for (const sql of [SHARED_SQL, SHARED_FIX_SQL, CONTRACT_SHARED_SQL]) assert.doesNotMatch(sql, /hermes_/i, 'file hàm dùng chung (RPC web) không chứa hàm Hermes nào');
  assert.deepEqual(created(CATALOG_SQL), ['app_private.hermes_w2d_catalog_v1', 'app_private.hermes_w2d_read_v1']);
  assert.deepEqual(created(SHARED_FIX_SQL), ['public.report_text_v1', 'public.areas_in_scope_v1'], 'sửa review: chỉ thay thân hàm dùng chung');
  assert.deepEqual(created(READER_SQL), ['app_private.hermes_w2d_read_v1'], 'sửa review: chỉ thay thân hàm đọc');
  assert.deepEqual(created(CONTRACT_SHARED_SQL), ['public.real_estate_contracts_ending_v1', 'public.contract_move_out_notices_v1'], 'đọc bù Hợp đồng: hai hàm dùng chung mới');
  assert.deepEqual(created(CONTRACT_READS_SQL), ['app_private.hermes_w2d_catalog_v1', 'app_private.hermes_w2d_read_v1'], 'đọc bù Hợp đồng: bản cuối của gói');
  for (const [report, spec] of Object.entries(W2D_REPORTS)) {
    const source = spec.source.replace(/^crm\./, 'public.');
    // RPC web gọi thẳng: dòng tiền phòng; hàng đợi trả phòng (bảng contract_exit_cases không cấp SELECT cho authenticated).
    assert.ok(pub.includes(source) || ['public.get_room_cash_lifecycle_v1', 'public.list_contract_exit_cases_v1', 'public.list_contract_drafts'].includes(source),
      `${report}: ${spec.source}`);
    assert.ok(W2_READ_KEY_LIST.includes(spec.permission) || ['assets.view', 'services.view', 'rooms.view', 'contracts.view'].includes(spec.permission), spec.permission);
  }
  const procs = (await db.query(`SELECT n.nspname||'.'||p.proname name,p.prosecdef definer,p.proconfig config,p.prosrc src,
      p.proretset retset,pg_get_function_result(p.oid) result,has_function_privilege('authenticated',p.oid,'EXECUTE') auth,has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('service_role',p.oid,'EXECUTE') service
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=ANY($1)`, [[...pub, 'app_private.hermes_w2d_read_v1']])).rows;
  assert.equal(procs.length, pub.length + 1);
  for (const proc of procs) {
    assert.deepEqual([proc.auth, proc.anon, proc.service], [true, false, false], `${proc.name}: chỉ authenticated`);
    if (proc.name === 'app_private.hermes_w2d_read_v1') {
      assert.deepEqual([proc.definer, proc.config], [false, ['search_path=pg_catalog, public']]);
      assert.doesNotMatch(proc.src, /app_private/, 'thân không nhắc app_private (authenticated không USAGE)');
      continue;
    }
    // Review P1: không hàm nào của gói trả payload vượt RLS (helper khu cũ là DEFINER).
    assert.equal(proc.definer, false, `${proc.name}: INVOKER`);
    assert.deepEqual(proc.config, ['search_path=""'], `${proc.name}: search_path rỗng`);
    // Rào công ty 000700: hàng nào cũng mang công ty của cột nguồn (bảng neo đã lọc p_organization_id).
    if (proc.retset) assert.match(proc.result, /[(,] ?organization_id uuid\)$/, `${proc.name}: trả organization_id`);
    assert.match(proc.src, /current_user<>'authenticated' OR auth\.uid\(\) IS NULL/, `${proc.name}: chỉ authenticated`);
    if (proc.name === 'public.report_text_v1') continue;
    assert.match(proc.src, /public\.can_access_org_entity\('[a-z_]+','[a-z_]+'\)/, `${proc.name}: tự kiểm khoá web`);
  }
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_proc WHERE proname IN ('hermes_w2d_text_v1','hermes_w2d_items_v1','hermes_w2d_customer_ok_v1')")).rows[0].n, 0);
}));

test('hàm dùng chung: chỉ authenticated có khoá web; p_building_ids NULL = toàn phạm vi RLS, {} = rỗng; RLS người gọi quyết', () => inCase(async env => {
  const { db } = env;
  const call = (sql, args, options) => env.call(sql, args, { role: 'authenticated', ...options });
  await acl(db, ['reports_real_estate.vacant_rooms', 'rooms.view']);
  assert.deepEqual(await call('SELECT jsonb_agg(room_name ORDER BY room_name) result FROM public.real_estate_vacant_rooms_v1($1,NULL,NULL,$2)', [ORG, '2026-10-16']),
    ['P102', 'P204'], 'NULL: mọi toà RLS cho thấy (P201/P202 có HĐ ACTIVE)');
  assert.equal(await call("SELECT count(*)::int result FROM public.rooms_list_v1($1,'{}'::uuid[])", [ORG]), 0, '{} = rỗng');
  assert.equal(await call('SELECT count(*)::int result FROM public.rooms_list_v1($1,NULL)', [ORG]), 7);
  await db.query('DELETE FROM public.fixture_building_access WHERE building_id=$1', [OTHER_BUILDING]);
  assert.equal(await call('SELECT count(*)::int result FROM public.rooms_list_v1($1,NULL)', [ORG]), 5, 'RLS toà của người gọi');
  assert.equal(await call('SELECT count(*)::int result FROM public.rooms_list_v1($1,$2)', [ORG, [OTHER_BUILDING]]), 0, 'thu hẹp không nới được RLS');
  assert.equal(await call('SELECT count(*)::int result FROM public.rooms_list_v1($1,NULL)', [FOREIGN]), 0, 'công ty khác ⇒ 0');
  await acl(db, ['rooms.view'], false);
  await assert.rejects(call('SELECT count(*)::int result FROM public.rooms_list_v1($1,NULL)', [ORG]), code('42501'), 'web gọi thẳng thiếu khoá rooms.view');
  await assert.rejects(env.call('SELECT count(*)::int result FROM public.real_estate_vacant_rooms_v1($1,NULL)', [ORG], { role: 'postgres' }), code('42501'),
    'gọi từ DEFINER/chủ bảng bị từ chối');
  await assert.rejects(env.call('SELECT count(*)::int result FROM public.real_estate_vacant_rooms_v1($1,NULL)', [ORG], { role: 'anon' }), /permission denied/);
  await assert.rejects(env.call('SELECT count(*)::int result FROM public.real_estate_vacant_rooms_v1($1,NULL)', [ORG], { role: 'authenticated', actor: '' }),
    code('42501'), 'không JWT');
  assert.equal(await call('SELECT public.report_text_v1($1,5) result', ['a\u0007b\r\nc dddd']), 'ab\nc\n', 'bỏ ký tự điều khiển, CRLF/U+2028 thành xuống dòng, cắt theo ký tự');
  await assert.rejects(env.call('SELECT public.report_text_v1($1,5) result', ['x'], { role: 'postgres' }), code('42501'), 'report_text_v1: chỉ authenticated (review P3)');
}));

test('đầu–cuối qua cổng: cả 27 báo cáo qua rào đầu ra của nền và khuôn JS của broker (fence, toà ∈ phạm vi)', () => inCase(async env => {
  await env.grant([...KEYS, 'suppliers.view', 'categories.view', 'tasks.view']);
  await orgWide(env, KEYS);
  // RLS areas (giả lập) chỉ cho quản trị: không có quản trị thì báo cáo khu rỗng đúng như web (review P1).
  await env.db.query('INSERT INTO public.fixture_admins VALUES($1)', [USER]);
  for (const [report, spec] of Object.entries(W2D_REPORTS)) {
    const values = valuesFor(report, spec);
    const value = await run(env, report, values);
    assert.equal(value.unavailable, null, report);
    assert.ok(value.items.length > 0, `${report}: có hàng`);
    assert.doesNotThrow(() => fence(report, value, values), report);
  }
}));

test('BĐS phòng trống: không HĐ ACTIVE (bỏ HĐ đã xoá), trừ giữ chỗ; số ngày trống; overlay toà A; tầng; không cắt 1000', () => inCase(async env => {
  await env.grant(['reports_real_estate.vacant_rooms']);
  const value = await run(env, 're_vacant_rooms');
  assert.deepEqual(ids(value.items, 'roomId'), [D.ROOM_A2, D.ROOM_A4], 'P102 (HĐ ACTIVE đã xoá không tính), P204 bảo trì vẫn trống như web');
  assert.deepEqual(value.items.map(row => [row.daysVacant, row.lastEndDate]), [[6, '2026-10-10'], [76, '2026-08-01']]);
  assert.deepEqual(value.summary, { total: 2, vacantUpTo7Days: 1, vacant8To30Days: 0, vacantOver30Days: 1, unknownSince: 0 });
  assert.deepEqual(ids((await run(env, 're_vacant_rooms', { floor: 2 })).items, 'roomId'), [D.ROOM_A4]);
  await assert.rejects(run(env, 're_vacant_rooms', { buildingId: OTHER_BUILDING }), code('42501'), 'toà B ngoài overlay');
  await env.db.query(`INSERT INTO public.rooms(id,organization_id,building_id,name,status,rent_price,floor)
    SELECT gen_random_uuid(),$1,$2,'Z'||lpad(n::text,5,'0'),'AVAILABLE',1,3 FROM generate_series(1,2001) n`, [ORG, BUILDING]);
  const big = await run(env, 're_vacant_rooms', {}, { limit: 20 });
  assert.deepEqual([big.sourceCapped, big.items.length, big.nextOffset, big.summary.total, big.summary.unknownSince], [true, 20, 20, 2003, 2001]);
}));

test('BĐS sắp hết hạn: ACTIVE chưa xoá trong N ngày; tên khách cần RLS customers (khoá + chủ hồ sơ) VÀ customers.view của kết nối', () => inCase(async env => {
  const { db } = env;
  await env.grant(['reports_real_estate.expiring']);
  let value = await run(env, 're_expiring');
  assert.deepEqual(value.items.map(row => [row.contractId, row.daysLeft, row.customerName, row.customerPhone]),
    [[D.C_SOON, 9, 'Khách Chưa Hợp Đồng', '0955555555']], 'HĐ toà B và HĐ đã xoá không có');
  assert.deepEqual(value.summary, { days: 30, total: 1, within7Days: 0, within8To15Days: 1, within16To30Days: 0 });
  assert.equal((await run(env, 're_expiring', { days: 7 })).items.length, 0);
  await db.exec('DELETE FROM public.fixture_visible_owners');
  value = await run(env, 're_expiring');
  assert.deepEqual([value.items[0].customerName, value.items[0].customerPhone], [null, null], 'RLS: chủ hồ sơ không còn trong công ty');
  await db.query('INSERT INTO public.fixture_visible_owners VALUES($1)', [USER]);
  await dropRead(db, 'customers.view');
  value = await run(env, 're_expiring');
  assert.deepEqual([value.items[0].customerName, value.items.length], [null, 1], 'kết nối không chọn customers.view');
}));

// Đợt 2 trang Hợp đồng (HOP-DONG-THAO-TAC-GHI.md mục 6): đọc bù a/b + hồ sơ chờ quyết toán. Không tên/SĐT khách ở cả ba.
test('Hợp đồng — kết thúc trong khoảng (mặc định tháng này, gồm quá hạn), báo dọn đi (khác ngày hết hạn), hồ sơ chờ quyết toán', () => inCase(async env => {
  const { db } = env;
  await env.grant(['contracts.view']);
  let value = await run(env, 're_contracts_ending');
  assert.deepEqual(value.items.map(row => [row.contractId, row.endDate, row.daysLeft, row.expectedMoveOutDate]), [[D.C_SOON, '2026-10-25', 9, '2026-10-24']],
    'tháng này: HĐ toà ngoài phạm vi, HĐ đã xoá, HĐ đã thanh lý không có');
  const building = value.items[0].buildingName;
  assert.deepEqual(value.summary, { fromDate: '2026-10-01', toDate: '2026-10-31', total: 1, overdue: 0, withNotice: 1, topBuildingName: building, topBuildingCount: 1 });
  assert.ok(value.items.every(row => !Object.hasOwn(row, 'customerName')));
  assert.deepEqual((await run(env, 're_contracts_ending', { fromDate: '2027-01-01', toDate: '2027-01-31' })).items.map(row => row.contractId), [CONTRACT_A],
    'tháng X: đúng khoảng ngày kết thúc');
  // Review #270: chỉ một đầu khoảng ⇒ để mở phía kia (trước đây hàm dùng chung kẹp đầu còn lại về tháng này ⇒ rỗng im lặng).
  value = await run(env, 're_contracts_ending', { fromDate: '2027-01-01' });
  assert.ok(value.items.some(row => row.contractId === CONTRACT_A), 'chỉ fromDate sau tháng này vẫn ra HĐ');
  assert.ok(value.items.every(row => row.endDate >= '2027-01-01'));
  assert.deepEqual([value.summary.fromDate, value.summary.toDate], ['2027-01-01', null]);
  value = await run(env, 're_contracts_ending', { toDate: '2026-10-31' });
  assert.ok(value.items.some(row => row.contractId === D.C_SOON) && value.items.every(row => row.endDate <= '2026-10-31'), 'chỉ toDate: mở phía trước');
  await db.query("UPDATE public.contracts SET end_date='2026-10-10' WHERE id=$1", [D.C_SOON]);
  value = await run(env, 're_contracts_ending');
  assert.deepEqual([value.items[0].daysLeft, value.summary.overdue], [-6, 1], 'đã qua ngày kết thúc mà chưa thanh lý vẫn tính trong tháng');
  value = await run(env, 're_move_out_notices');
  assert.deepEqual(value.items.map(row => [row.contractId, row.expectedMoveOutDate, row.daysUntil, row.endDate]), [[D.C_SOON, '2026-10-24', 8, '2026-10-10']]);
  assert.deepEqual(value.summary, { fromDate: null, toDate: null, total: 1, overdue: 0, within30Days: 1 });
  assert.equal((await run(env, 're_move_out_notices', { fromDate: '2026-11-01', toDate: '2026-11-30' })).items.length, 0, 'lọc theo NGÀY BÁO dọn đi');
  value = await run(env, 're_exit_cases_pending');
  assert.deepEqual(value.items.map(row => [row.contractId, row.actualMoveOutOn, row.kind, row.settlementMode, row.daysWaiting]),
    [[D.C_END, '2026-10-10', 'EARLY_RETURN', 'DEFERRED', 6]], 'chỉ PENDING, chỉ toà trong phạm vi');
  assert.deepEqual(value.summary, { total: 1, oldestDays: 6 });
  assert.ok(value.items.every(row => !Object.hasOwn(row, 'customerName')), 'nguồn DEFINER: không tên khách');
  // Review #270: nguồn trả tối đa 100 hồ sơ ⇒ summary.total là tổng thật của nguồn, không phải số dòng đã nhận.
  await db.query(`INSERT INTO public.contract_exit_cases(id,organization_id,building_id,contract_id,room_at_handover_id,actual_move_out_on,
      initial_kind,current_kind,settlement_mode,state,contract_number,building_name,room_name)
    SELECT gen_random_uuid(),$1,$2,gen_random_uuid(),$3,'2026-10-15','EARLY_RETURN','EARLY_RETURN','DEFERRED','PENDING','HD-X'||n,'Toà A','P202'
    FROM generate_series(1,120) n`, [ORG, BUILDING, D.ROOM_A2]);
  value = await run(env, 're_exit_cases_pending', {}, { limit: 50 });
  assert.deepEqual([value.summary.total, value.summary.oldestDays, value.sourceCapped], [121, 6, true]);
  await db.query("DELETE FROM public.contract_exit_cases WHERE contract_number LIKE 'HD-X%'");
  await db.query("UPDATE public.contract_exit_cases SET state='FINALIZED' WHERE id=$1", [D.EXIT_A]);
  assert.deepEqual((await run(env, 're_exit_cases_pending')).summary, { total: 0, oldestDays: null });
}));

// Mốc 5: nháp HĐ chưa ký qua RPC web list_contract_drafts; chỉ EDITABLE; không dữ liệu khách của nháp (payload có tên/SĐT/CCCD).
test('Hợp đồng — nháp chưa ký (contract_drafts): chỉ nháp còn sửa được trong phạm vi, không dữ liệu khách; khoá contracts.view', () => inCase(async env => {
  const { db } = env;
  await env.grant(['contracts.view']);
  const today = (await db.query('SELECT public.org_today_v1()::text d')).rows[0].d;
  const days = created => Math.round((Date.parse(today) - Date.parse(created)) / 86_400_000);
  const rows = value => value.items.map(row => [row.draftId, row.roomName, row.startDate, row.endDate, row.rentPrice, row.customerCount,
    row.hasRepresentative, row.documentCount, row.daysOpen]);
  const A = [D.DRAFT_A, 'P102', '2026-11-01', '2027-10-31', '3200000.00', 1, true, 1, days('2026-10-12')];
  let value = await run(env, 'contract_drafts');
  assert.deepEqual(rows(value), [A], 'chỉ toà trong phạm vi; đã ký / đã xoá không có');
  assert.deepEqual(value.summary, { total: 1, exported: 1, withoutCustomer: 0, oldestDays: days('2026-10-12') });
  const text = JSON.stringify(value);
  for (const secret of ['Khách Nháp', '0900000999', '079000000001']) assert.ok(!text.includes(secret), `không lộ ${secret}`);
  await orgWide(env, ['contracts.view']);
  value = await run(env, 'contract_drafts');
  assert.deepEqual(rows(value), [[D.DRAFT_B, 'P202', null, null, '2500000.00', 0, false, 0, days('2026-10-15')], A], 'mới sửa trước; ngày rỗng ⇒ null');
  assert.deepEqual(value.summary, { total: 2, exported: 1, withoutCustomer: 1, oldestDays: days('2026-10-12') });
  assert.deepEqual((await run(env, 'contract_drafts', { buildingId: BUILDING })).items.map(row => row.draftId), [D.DRAFT_A], 'lọc toà');
  await db.query("UPDATE public.contract_drafts SET status='SIGNED' WHERE id=$1", [D.DRAFT_B]);
  assert.equal((await run(env, 'contract_drafts')).summary.total, 1, 'ký rồi thì không còn chờ');
}));

// Mốc 3 (vai quản lý): đếm phòng theo toà bằng khoá xem phòng, khớp từng số với báo cáo rooms (cùng rooms_list_v1, cùng phạm vi).
test('Phòng theo toà (rooms_occupancy): chỉ cần rooms.view; đang cho thuê = có HĐ hiệu lực (gồm sắp hết hạn); khớp báo cáo rooms', () => inCase(async env => {
  await env.grant(['rooms.view']);
  const occupancy = await run(env, 'rooms_occupancy'), rooms = await run(env, 'rooms', {}, { limit: 50 });
  assert.equal(occupancy.unavailable, null);
  assert.ok(occupancy.items.length > 0 && occupancy.items.every(row => row.total >= row.rented + row.available + row.reserved + row.maintenance),
    'tổng ≥ các nhóm (phần còn lại là trạng thái khác)');
  const sum = key => occupancy.items.reduce((total, row) => total + row[key], 0);
  for (const key of ['total', 'rented', 'expiringSoon', 'available', 'reserved', 'maintenance']) assert.equal(occupancy.summary[key], sum(key), key);
  assert.equal(occupancy.summary.buildings, occupancy.items.length);
  assert.deepEqual([occupancy.summary.total, occupancy.summary.available, occupancy.summary.expiringSoon, occupancy.summary.reserved],
    [rooms.summary.total, rooms.summary.available, rooms.summary.expiringSoon, rooms.summary.reserved], 'cùng số với báo cáo rooms');
  const display = rooms.items.reduce((counts, row) => ({ ...counts, [row.displayStatus]: (counts[row.displayStatus] ?? 0) + 1 }), {});
  assert.equal(occupancy.summary.rented, (display.OCCUPIED ?? 0) + (display.EXPIRING_SOON ?? 0), 'đang cho thuê = OCCUPIED + EXPIRING_SOON của trang Phòng');
  assert.ok(occupancy.summary.rented > 0, 'fixture có phòng đang cho thuê');
}));

test('BĐS gia hạn & chuyển nhượng; khuyến mại; HĐ mới; thanh lý — số như bộ lọc web', () => inCase(async env => {
  await env.grant(['reports_real_estate.renewals_transfers', 'reports_real_estate.promotions', 'reports_real_estate.new_leases', 'reports_real_estate.terminations']);
  let value = await run(env, 're_renewals_transfers');
  assert.deepEqual(value.items.map(row => [row.kind, row.eventId, row.eventDate, row.rentPrice, row.customerName]),
    [['RENEWAL', D.EXT_A, '2026-09-20', '3800000.00', 'Nguyễn Văn An'], ['TRANSFER', D.C_TRANSFER, '2026-09-16', '3600000.00', 'Nguyễn Văn An']]);
  assert.deepEqual(value.summary, { total: 2, renewals: 1, transfers: 1 });
  assert.deepEqual(ids((await run(env, 're_renewals_transfers', { fromDate: '2026-09-17' })).items, 'eventId'), [D.EXT_A]);
  value = await run(env, 're_promotions');
  const byId = Object.fromEntries(value.items.map(row => [row.contractId, row]));
  assert.deepEqual(Object.keys(byId).sort(), [CONTRACT_A, D.C_END, D.C_SOON].sort(), 'discounts IS NOT NULL như web (kể cả [])');
  assert.deepEqual([byId[CONTRACT_A].discountType, byId[CONTRACT_A].savings, byId[CONTRACT_A].effectiveRent], ['percent', '350000.00', '3150000.00']);
  assert.deepEqual([byId[D.C_SOON].savings, byId[D.C_SOON].discountMonths, byId[D.C_SOON].amountPerMonth], ['0.00', 3, '500000.00']);
  assert.deepEqual(value.summary, { total: 3, active: 2, totalSavings: '350000.00', avgSavings: '116666.67', withDiscountTerms: 2 });
  value = await run(env, 're_new_leases');
  assert.deepEqual(value.items.map(row => [row.contractId, row.status, row.durationMonths, row.totalValue]), [[D.C_DRAFT, 'DRAFT', 12, '36000000.00']]);
  assert.deepEqual(value.summary, { fromDate: '2026-10-01', toDate: '2026-10-31', total: 1, totalValue: '36000000.00', avgRent: '3000000.00', avgDurationMonths: 12 });
  assert.deepEqual(ids((await run(env, 're_new_leases', { fromDate: '2026-01-01', toDate: '2026-10-31' })).items, 'contractId'),
    [D.C_DRAFT, D.C_TRANSFER, D.C_SOON, CONTRACT_A]);
  value = await run(env, 're_terminations');
  assert.deepEqual(value.items.map(row => [row.contractId, row.terminationType, row.note, row.durationDays, row.customerName]),
    [[D.C_END, 'EARLY', 'Khách chuyển đi sớm', 374, 'Lê Ở Ghép']], 'không khách đại diện ⇒ khách đầu tiên như repName của web');
  assert.deepEqual(value.summary, { fromDate: '2026-10-01', toDate: '2026-10-16', total: 1, terminated: 1, expired: 0, totalContracts: 5, terminationRatePct: '20.0' });
  value = await run(env, 're_terminations', { fromDate: '2026-08-01', toDate: '2026-10-16' });
  assert.deepEqual([ids(value.items, 'contractId'), value.summary.expired], [[D.C_END, D.C_EXP], 1]);
}));

test('BĐS thanh lý (review P1/P2): ghi chú theo rào PII như tên khách; tỉ lệ = tử/mẫu cùng tập toà (khác web: web lấy mẫu số toàn công ty)', () => inCase(async env => {
  const { db } = env;
  await env.grant(['reports_real_estate.terminations']);
  let value = await run(env, 're_terminations');
  assert.deepEqual(value.items.map(row => [row.contractId, row.note, row.customerName]), [[D.C_END, 'Khách chuyển đi sớm', 'Lê Ở Ghép']]);
  assert.deepEqual([value.summary.total, value.summary.totalContracts, value.summary.terminationRatePct], [1, 5, '20.0'], 'overlay toà A: tử và mẫu cùng toà A');
  await acl(db, ['customers.view'], false);
  value = await run(env, 're_terminations');
  assert.deepEqual([value.items[0].note, value.items[0].customerName, value.items[0].terminationType], [null, null, 'EARLY'], 'tắt quyền khách ⇒ không ghi chú');
  await acl(db, ['customers.view']);
  await db.exec('DELETE FROM public.fixture_visible_owners');
  value = await run(env, 're_terminations');
  assert.deepEqual([value.items[0].note, value.items[0].customerName], [null, null], 'chủ hồ sơ ngoài phạm vi thấy ⇒ không ghi chú');
  await db.query('INSERT INTO public.fixture_visible_owners VALUES($1)', [USER]);
  assert.equal((await run(env, 're_terminations')).items[0].note, 'Khách chuyển đi sớm');
  await dropRead(db, 'customers.view');
  assert.equal((await run(env, 're_terminations')).items[0].note, null, 'kết nối không chọn customers.view ⇒ không ghi chú');
  // Hai toà: toà A có 5 HĐ (1 thanh lý trong kỳ), toà B có 2 HĐ ACTIVE. Web chia cho toàn công ty dù lọc toà.
  await orgWide(env, ['reports_real_estate.terminations']);
  value = await run(env, 're_terminations');
  assert.deepEqual([value.summary.total, value.summary.totalContracts, value.summary.terminationRatePct], [1, 7, '14.3'], 'Toàn tổ chức: mẫu số hai toà');
  value = await run(env, 're_terminations', { buildingId: BUILDING });
  assert.deepEqual([value.summary.total, value.summary.totalContracts, value.summary.terminationRatePct], [1, 5, '20.0'], 'lọc toà A: mẫu số chỉ toà A');
  value = await run(env, 're_terminations', { buildingId: OTHER_BUILDING });
  assert.deepEqual([value.summary.total, value.summary.totalContracts, value.summary.terminationRatePct], [0, 2, '0.0']);
}));

test('BĐS tỷ lệ chi phí: RLS web (loại cần categories.view, phiếu hạn chế theo quyền xem hạn chế) + thu hẹp theo khoá phụ của kết nối', () => inCase(async env => {
  const { db } = env;
  await env.grant(['reports_real_estate.expense_ratio']);
  let value = await run(env, 're_expense_ratio');
  assert.deepEqual([value.summary.totalExpense, value.summary.expenseTypesVisible], ['0.00', false], 'thiếu categories.view: phần chi = 0 như web');
  await env.grant(['categories.view']);
  value = await run(env, 're_expense_ratio');
  assert.deepEqual(value.items.map(row => [row.month, row.revenue, row.expense, row.ratioPct]), [['2026-05', '0.00', '0.00', null],
    ['2026-06', '0.00', '0.00', null], ['2026-07', '0.00', '0.00', null], ['2026-08', '0.00', '300000.00', null], ['2026-09', '8000000.00', '0.00', '0.00'],
    ['2026-10', '10000000.00', '1200000.00', '12.00']]);
  assert.deepEqual(value.summary, { fromMonth: '2026-05', toMonth: '2026-10', totalRevenue: '18000000.00', totalExpense: '1500000.00', avgRatioPct: '6.00',
    peakMonth: '2026-10', peakRatioPct: '12.00', categories: ['Bảo trì', 'Nhân sự'], expenseTypesVisible: true, category: null,
    byMonth: value.items.map(row => ({ month: row.month, revenue: row.revenue, expense: row.expense, ratioPct: row.ratioPct })) }, 'một toà: byMonth = hàng');
  assert.ok(value.items.every(row => row.buildingId === BUILDING), 'mọi hàng nêu toà');
  assert.deepEqual((await run(env, 're_expense_ratio', { kind: 'type' })).items.map(row => [row.category, row.typeName, row.expense]),
    [['Bảo trì', 'Sửa chữa', '1200000.00'], ['Nhân sự', 'Ứng lương', '300000.00']]);
  assert.deepEqual((await run(env, 're_expense_ratio', { kind: 'category', query: 'Bảo trì' })).items.map(row => [row.month, row.expense]),
    [['2026-10', '1200000.00']]);
  await db.query('INSERT INTO public.fixture_restricted_viewers VALUES($1)', [USER]);
  assert.equal((await run(env, 're_expense_ratio')).summary.totalExpense, '1500000.00', 'web thấy phiếu hạn chế, kết nối không chọn khoá');
  await env.grant(['income_expenses.restricted_view']);
  assert.equal((await run(env, 're_expense_ratio')).summary.totalExpense, '2000000.00', 'RLS + khoá hạn chế trong kết nối ⇒ +500 000 tháng 10');
  await dropRead(db, 'categories.view');
  value = await run(env, 're_expense_ratio');
  assert.deepEqual([value.summary.totalExpense, value.summary.totalRevenue, value.summary.expenseTypesVisible], ['0.00', '18000000.00', false],
    'kết nối không chọn categories.view');
}));

test('tài sản: toà theo ctx, giá trị = giá × SL, NCC cần RLS suppliers + suppliers.view của kết nối; chưa gắn toà chỉ Toàn tổ chức; loại phải của công ty', () => inCase(async env => {
  const { db } = env;
  await env.grant(['assets.view', 'suppliers.view']);
  let value = await run(env, 'assets');
  assert.deepEqual(value.items.map(row => [row.id, row.quantity, row.totalValue, row.supplierName]),
    [[D.ASSET_BROKEN, 1, '0.00', null], [D.ASSET_A, 2, '2000000.00', 'Điện máy Xanh']], 'NCC của chủ hồ sơ ngoài công ty bị RLS ẩn');
  assert.deepEqual(value.summary, { total: 2, totalValue: '2000000.00', goodOrNew: 1, poorOrBroken: 1 });
  assert.ok(value.items.every(row => !('images' in row) && !('description' in row)));
  assert.deepEqual(ids((await run(env, 'assets', { query: 'điều' })).items), [D.ASSET_A], 'tìm theo tên loại như web');
  assert.deepEqual(ids((await run(env, 'assets', { status: 'BROKEN' })).items), [D.ASSET_BROKEN]);
  assert.deepEqual(ids((await run(env, 'assets', { roomId: ROOM })).items), [D.ASSET_A]);
  assert.deepEqual(ids((await run(env, 'assets', { categoryId: D.ASSET_CAT })).items), [D.ASSET_A]);
  await assert.rejects(run(env, 'assets', { categoryId: D.SUPPLIER }), code('42501'), 'loại tài sản không có trong công ty');
  await assert.rejects(run(env, 'assets', { roomId: OTHER_ROOM }), code('42501'), 'phòng ngoài toà của kết nối');
  await dropRead(db, 'suppliers.view');
  assert.equal((await run(env, 'assets')).items[1].supplierName, null, 'kết nối không chọn suppliers.view');
  await orgWide(env, ['assets.view']);
  value = await run(env, 'assets');
  assert.deepEqual(ids(value.items), [D.ASSET_FREE, D.ASSET_B, D.ASSET_BROKEN, D.ASSET_A], 'Toàn tổ chức: thêm toà B + chưa gắn toà; không công ty khác');
}));

test('dịch vụ, định mức, NCC, công tơ, tầng: toà theo ctx; tổ chức cần Toàn tổ chức; RLS org-entity; NCC chỉ id+tên; công tơ không serial', () => inCase(async env => {
  const { db } = env;
  await env.grant(['services.view', 'service_quotas.view', 'suppliers.view', 'meters.view', 'categories.view', 'buildings.view']);
  assert.deepEqual((await run(env, 'services')).items.map(row => [row.buildingId, row.id]), [[BUILDING, SERVICE]], 'hàng theo toà × dịch vụ');
  const meters = await run(env, 'meters');
  assert.deepEqual(meters.items.map(row => [row.id, row.latestReading, row.latestReadingDate]), [[D.METER_A, '240.00', '2026-10-15']]);
  assert.ok(!('serialNumber' in meters.items[0]));
  assert.deepEqual((await run(env, 'floors')).items.map(row => [row.id, row.floorNumber]), [[D.FLOOR_A1, 1], [D.FLOOR_A2, 2]]);
  for (const report of ['service_quotas', 'suppliers']) assert.equal((await run(env, report)).unavailable, 'organization_scope_required', report);
  await orgWide(env, ['services.view', 'service_quotas.view', 'suppliers.view']);
  const all = await run(env, 'services');
  assert.deepEqual(all.items.map(row => `${row.buildingId}|${row.id}`).sort(), [`null|${D.SERVICE_FREE}`, `${BUILDING}|${SERVICE}`,
    `${OTHER_BUILDING}|${D.SERVICE_B}`, `${OTHER_BUILDING}|${SERVICE}`].sort(), 'chưa gắn toà = buildingId null (Toàn tổ chức)');
  assert.deepEqual(all.summary, { total: 3, links: 3 });
  assert.deepEqual(ids((await run(env, 'services', { kind: 'TIEN_NUOC' })).items), [D.SERVICE_B]);
  assert.deepEqual((await run(env, 'service_quotas')).items.map(row => [row.id, row.tierCount, row.tiers.map(tier => tier.tierNumber)]),
    [[D.QUOTA, 2, [1, 2]]], 'định mức công ty khác không có');
  assert.deepEqual((await run(env, 'suppliers')).items, [{ id: D.SUPPLIER, name: 'Điện máy Xanh' }]);
  await acl(db, ['service_quotas.view'], false);
  await assert.rejects(run(env, 'service_quotas'), code('42501'), 'mất quyền CRM');
}));

test('toà, khu, chi tiết toà: danh sách trắng; khu DƯỚI RLS areas của người hỏi như web — RLS chặn thì Hermes cũng không thấy (review P1)', () => inCase(async env => {
  const { db } = env;
  await env.grant(['buildings.view']);
  let value = await run(env, 'buildings');
  assert.deepEqual(ids(value.items, 'buildingId'), [BUILDING]);
  const row = value.items[0];
  for (const key of ['commissionTiers', 'commissionChangeReason', 'defaultAccountIdTt', 'publicContactPhone', 'latitude']) assert.ok(!(key in row), key);
  assert.ok(!JSON.stringify(value).includes('bí mật') && !JSON.stringify(value).includes('0909000000'), 'không lộ giá trị cột bị loại');
  assert.deepEqual([row.address, row.areaNames, row.roomsTotal, row.roomsOccupied, row.updatedOn],
    ['12 Lê Lợi, Phường 1, Quận 3, TP HCM', [], 5, 2, '2026-10-16'], 'RLS areas (giả lập: chỉ quản trị) chặn ⇒ không tên khu');
  assert.equal(await env.call('SELECT count(*)::int result FROM public.areas', [], { role: 'authenticated' }), 0, 'RLS areas chặn người không quản trị');
  assert.equal(await env.call('SELECT count(*)::int result FROM public.areas_in_scope_v1($1)', [ORG], { role: 'authenticated' }), 0, 'helper không vượt RLS');
  assert.deepEqual((await run(env, 'areas')).items, [], 'RLS chặn ⇒ báo cáo khu rỗng');
  assert.equal((await run(env, 'building_detail', { buildingId: BUILDING })).items[0].description, 'Toà mẫu');
  await assert.rejects(run(env, 'building_detail', { buildingId: OTHER_BUILDING }), code('42501'));
  await assert.rejects(run(env, 'buildings', { areaId: D.AREA_B }), code('42501'), 'cổng: khu không có toà trong phạm vi');
  await db.query('INSERT INTO public.fixture_admins VALUES($1)', [USER]);
  assert.deepEqual((await run(env, 'buildings')).items[0].areaNames, ['Khu Trung tâm'], 'RLS cho quản trị ⇒ có tên khu');
  assert.deepEqual((await run(env, 'areas')).items.map(area => [area.id, area.buildingId]), [[D.AREA_AB, BUILDING]], 'hàng theo khu × toà trong phạm vi');
  await orgWide(env, ['buildings.view']);
  assert.deepEqual(ids((await run(env, 'buildings', { areaId: D.AREA_B })).items, 'buildingId'), [OTHER_BUILDING]);
  assert.deepEqual((await run(env, 'areas')).items.map(area => `${area.id}|${area.buildingId}`).sort(),
    [`${D.AREA_EMPTY}|null`, `${D.AREA_B}|${OTHER_BUILDING}`, `${D.AREA_AB}|${BUILDING}`, `${D.AREA_AB}|${OTHER_BUILDING}`].sort(), 'Toàn tổ chức: khu trống = buildingId null');
  await db.query("INSERT INTO public.areas(id,organization_id,name,code) VALUES($1,$2,'Khu công ty khác','KF')", [FOREIGN_AREA, FOREIGN]);
  assert.equal(await env.call('SELECT count(*)::int result FROM public.areas_in_scope_v1($1) WHERE area_id=$2', [ORG, FOREIGN_AREA], { role: 'authenticated' }), 0,
    'RLS quản trị thấy mọi công ty: lọc organization_id tường minh');
}));

test('phòng: trạng thái hiển thị như getRoomDisplayStatus; chi tiết phòng: HĐ cần contracts.view, người ở cần customers.view của kết nối', () => inCase(async env => {
  const { db } = env;
  await env.grant(['rooms.view']);
  let value = await run(env, 'rooms');
  assert.deepEqual(value.items.map(row => [row.name, row.displayStatus]), [['P101', 'OCCUPIED'], ['P102', 'AVAILABLE'], ['P103', 'RESERVED'],
    ['P204', 'MAINTENANCE'], ['P205', 'EXPIRING_SOON']]);
  assert.deepEqual(value.summary, { total: 5, available: 1, expiringSoon: 1, reserved: 1 });
  assert.deepEqual(ids((await run(env, 'rooms', { status: 'ACTIVE' })).items, 'name'), ['P102'], 'ACTIVE = AVAILABLE như web');
  assert.deepEqual(ids((await run(env, 'rooms', { query: 'a10' })).items, 'name'), ['P101', 'P102']);
  value = await run(env, 'room_detail', { roomId: ROOM });
  assert.deepEqual([value.items[0].contract.contractNumber, value.items[0].tenants.map(tenant => tenant.name)], ['HD-A', ['Nguyễn Văn An', 'Lê Ở Ghép']]);
  await dropRead(db, 'customers.view');
  await dropRead(db, 'contracts.view');
  value = await run(env, 'room_detail', { roomId: ROOM });
  assert.deepEqual([value.items[0].contractVisible, value.items[0].contract, value.items[0].tenantsVisible, value.items[0].tenants], [false, null, false, []]);
  await assert.rejects(run(env, 'room_detail', { roomId: OTHER_ROOM }), code('42501'), 'phòng toà B ngoài overlay');
}));

test('dòng tiền phòng: chỉ với thu_tien.view (RPC web không kiểm khoá module); bỏ meta/tên bảng tenants/segments; RPC tự kiểm can_access_building', () => inCase(async env => {
  const { db } = env;
  await env.grant(['rooms.view']);
  await assert.rejects(run(env, 'room_cash_lifecycle', { roomId: ROOM }), code('42501'), 'rooms.view không đủ');
  await env.grant(['thu_tien.view']);
  const value = await run(env, 'room_cash_lifecycle', { roomId: ROOM });
  assert.deepEqual(value.items.map(row => [row.type, row.amount, row.trusted]), [['CONTRACT_OPENED', null, true], ['COMMISSION_PAID', '350000.00', false]]);
  const text = JSON.stringify(value);
  for (const secret of ['Hoa hồng cho', 'PC-HH', 'sourcePath', 'Tên bảng tenants cũ', 'diagnostic']) assert.ok(!text.includes(secret), secret);
  await db.exec(`DELETE FROM public.fixture_building_access WHERE building_id='${BUILDING}'`);
  await assert.rejects(run(env, 'room_cash_lifecycle', { roomId: ROOM }), code('42501'), 'RLS + RPC web');
}));

test('loại thu chi, loại việc, hotline: ẩn hạn chế/lương; khử trùng như web; không bonus/lương; bộ phận/nhóm theo RLS + khoá phụ', () => inCase(async env => {
  const { db } = env;
  await env.grant(['categories.view', 'task_types.view', 'hotline.view', 'tasks.view']);
  await orgWide(env, ['categories.view', 'task_types.view', 'hotline.view']);
  await db.query('INSERT INTO public.fixture_restricted_viewers VALUES($1)', [USER]);
  let value = await run(env, 'ie_types');
  assert.deepEqual(value.items.map(row => row.name), ['Sửa chữa', 'Ẩn', 'Tiền phòng'], 'bỏ Lương (hạn chế, dù RLS cho xem), Ứng lương (rule lương), bản trùng, công ty khác');
  assert.deepEqual(ids((await run(env, 'ie_types', { kind: 'income' })).items, 'name'), ['Tiền phòng']);
  value = await run(env, 'task_types');
  assert.deepEqual(value.items.map(row => [row.name, row.departmentName, row.jobGroupName]), [['Dọn phòng', null, null], ['Sửa điện', 'Kỹ thuật', 'Sửa chữa']],
    'bộ phận của người khác ẩn như RLS departments');
  assert.ok(!JSON.stringify(value).includes('bonus') && !JSON.stringify(value).includes('50000') && !JSON.stringify(value).includes('counts'));
  await db.query('INSERT INTO public.fixture_admins VALUES($1)', [USER]);
  assert.equal((await run(env, 'task_types')).items[0].departmentName, 'Phòng người khác', 'quản trị thấy mọi bộ phận như RLS');
  await dropRead(db, 'tasks.view');
  assert.equal((await run(env, 'task_types')).items[1].jobGroupName, null, 'kết nối không chọn tasks.view');
  assert.deepEqual(ids((await run(env, 'task_types', { query: 'điện' })).items, 'name'), ['Sửa điện']);
  assert.deepEqual((await run(env, 'hotlines')).items.map(row => row.id), [D.HOTLINE], 'RLS: hotline của chủ hồ sơ ngoài công ty ẩn');
}));

test('loại thu chi (review P2): hạng mục dùng chung (organization_id NULL) tạm không trả, đếm globalRowsOmitted; công ty khác không lọt; không 42501', () => inCase(async env => {
  const { db } = env;
  await env.grant(['categories.view']);
  await orgWide(env, ['categories.view']);
  await db.query(`INSERT INTO public.income_expense_types(id,organization_id,type,name,category,is_restricted,rule_key,created_at) VALUES
    ($1,NULL,'expense','Điện nước chung','Tiện ích',false,null,'2025-01-01T00:00:00Z'),($2,NULL,'income','Thu dùng chung','Doanh thu',false,null,'2025-01-01T00:00:00Z'),
    ($3,NULL,'expense','Hạn chế dùng chung','Nhân sự',true,null,'2025-01-01T00:00:00Z')`, GLOBAL_IE_TYPES);
  const value = await run(env, 'ie_types');
  assert.deepEqual(value.items.map(row => row.name), ['Sửa chữa', 'Ẩn', 'Tiền phòng'], 'chỉ hạng mục của công ty');
  assert.deepEqual(value.summary, { total: 3, globalRowsOmitted: 2 }, 'đếm dùng chung theo cùng bộ lọc hiển thị (bỏ hạn chế)');
  assert.ok(!JSON.stringify(value).includes('Loại công ty khác') && !JSON.stringify(value).includes('chung'));
  assert.deepEqual((await run(env, 'ie_types', { kind: 'income' })).summary, { total: 1, globalRowsOmitted: 1 });
  await db.exec('DELETE FROM public.income_expense_types WHERE organization_id IS NULL');
  assert.deepEqual((await run(env, 'ie_types')).summary, { total: 3, globalRowsOmitted: 0 });
}));

test('quyền: thiếu khoá/không chọn khoá ⇒ 42501; người khác cầm token ⇒ 42501; tổ chức cần Toàn tổ chức; không hàng nào của công ty khác', () => inCase(async env => {
  const { db } = env;
  await env.grant([...KEYS, 'suppliers.view', 'categories.view', 'tasks.view']);
  for (const report of Object.keys(W2D_REPORTS).filter(id => W2D_REPORTS[id].scope === 'organization'))
    assert.equal((await run(env, report)).unavailable, 'organization_scope_required', report);
  await orgWide(env, KEYS);
  for (const [report, spec] of Object.entries(W2D_REPORTS)) {
    const values = valuesFor(report, spec);
    const text = JSON.stringify(await run(env, report, values));
    for (const foreign of ['Công ty khác', 'Khác công ty', 'Việc công ty khác', 'Loại công ty khác', 'Toà ngoài', 'HD-F']) assert.ok(!text.includes(foreign), `${report}: ${foreign}`);
    await assert.rejects(run(env, report, values, {}, { actor: FOREIGN }), code('42501'), `${report}: token người khác`);
  }
  await dropRead(db, 'reports_real_estate.vacant_rooms');
  await assert.rejects(run(env, 're_vacant_rooms'), code('42501'), 'kết nối không chọn khoá');
  await db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='assets.view'");
  await assert.rejects(run(env, 'assets'), code('42501'), 'mất quyền CRM');
  assert.ok(ORG_KEYS.length === 5);
}));

// Đột biến: mỗi bản bỏ MỘT hàng rào của gói D; phép thử mà bản sống từ chối thì bản đột biến phải lọt.
const fnDefinition = (sql, name) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert.ok(start >= 0, `definition: ${name}`);
  return sql.slice(start, sql.indexOf('END $fn$;', start) + 'END $fn$;'.length);
};
const mutate = (sql, from, to) => { assert.equal(sql.split(from).length, 2, `anchor: ${from}`); return { live: sql, mutant: sql.replace(from, () => to) }; };
const GUARD_SUPPLIERS = `RETURNS TABLE(supplier_id uuid,name text,organization_id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $fn$
#variable_conflict use_column
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;`;
const probes = [
  { name: 'phòng trống: HĐ ACTIVE đã xoá không chiếm phòng', ...mutate(SHARED_SQL,
    `    AND NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.room_id=r.id AND c.organization_id=p_organization_id AND c.deleted_at IS NULL\n      AND c.status::text='ACTIVE')`,
    `    AND NOT EXISTS(SELECT 1 FROM public.contracts c WHERE c.room_id=r.id AND c.organization_id=p_organization_id\n      AND c.status::text='ACTIVE')`),
    run: async env => { await env.grant(['reports_real_estate.vacant_rooms']); return !ids((await run(env, 're_vacant_rooms')).items, 'roomId').includes(D.ROOM_A2); } },
  { name: 'phòng trống: bỏ phòng giữ chỗ', ...mutate(SHARED_SQL, `AND r.deleted_at IS NULL AND r.status::text<>'RESERVED'`, `AND r.deleted_at IS NULL`),
    run: async env => { await env.grant(['reports_real_estate.vacant_rooms']); return ids((await run(env, 're_vacant_rooms')).items, 'roomId').includes(D.ROOM_A3); } },
  { name: 'hàm dùng chung chỉ chạy dưới vai authenticated', ...mutate(SHARED_SQL, GUARD_SUPPLIERS, GUARD_SUPPLIERS.split('\n').slice(0, 4).join('\n')),
    run: async env => { await acl(env.db, ['suppliers.view']); return (await env.call('SELECT count(*)::int result FROM public.suppliers_list_v1($1)', [ORG], { role: 'postgres' })) > 0; } },
  { name: 'hàm dùng chung tự kiểm khoá web khi web gọi thẳng', ...mutate(SHARED_SQL,
    `  IF NOT COALESCE(public.can_access_org_entity('hotline','view'),false) THEN RAISE EXCEPTION 'w2d_permission_denied' USING ERRCODE='42501'; END IF;\n`, ''),
    run: async env => (await env.call('SELECT count(*)::int result FROM public.hotlines_list_v1($1)', [ORG], { role: 'authenticated' })) >= 0 },
  { name: 'PII: tên khách cần customers.view của kết nối', ...mutate(READER_SQL,
    `  v_customers:=ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_ctx#>ARRAY['scopes','customers.view'])='array'\n    THEN p_ctx#>ARRAY['scopes','customers.view'] ELSE '[]'::jsonb END) x);`,
    `  v_customers:=v_buildings;`),
    run: async env => { await env.grant(['reports_real_estate.expiring']); await dropRead(env.db, 'customers.view');
      return (await run(env, 're_expiring')).items[0].customerName !== null; } },
  { name: 'tỷ lệ chi phí: phiếu hạn chế cần khoá hạn chế của kết nối', ...mutate(SHARED_SQL,
    `      AND (p_restricted_building_ids IS NULL OR NOT COALESCE(ie.has_restricted_item,true) OR ie.building_id=ANY(p_restricted_building_ids))),`, `),`),
    run: async env => { await env.grant(['reports_real_estate.expense_ratio', 'categories.view']);
      await env.db.query('INSERT INTO public.fixture_restricted_viewers VALUES($1)', [USER]);
      return (await run(env, 're_expense_ratio')).summary.totalExpense !== '1500000.00'; } },
  { name: 'tỷ lệ chi phí: phần chi cần categories.view của kết nối', ...mutate(READER_SQL, `AND (r.row_kind='revenue' OR v_cat_visible)),`, `AND true),`),
    run: async env => { await env.grant(['reports_real_estate.expense_ratio']); await acl(env.db, ['categories.view']);
      return (await run(env, 're_expense_ratio')).summary.totalExpense !== '0.00'; } },
  { name: 'tài sản: tên NCC cần suppliers.view của kết nối', ...mutate(READER_SQL, `'supplierName',CASE WHEN v_suppliers THEN`, `'supplierName',CASE WHEN true THEN`),
    run: async env => { await env.grant(['assets.view']); await acl(env.db, ['suppliers.view']);
      return (await run(env, 'assets')).items.some(row => row.supplierName !== null); } },
  { name: 'tài sản: loại tài sản phải của công ty', ...mutate(READER_SQL,
    `  IF v_category IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.asset_categories c WHERE c.id=v_category`,
    `  IF false AND NOT EXISTS(SELECT 1 FROM public.asset_categories c WHERE c.id=v_category`),
    run: async env => { await env.grant(['assets.view']); return run(env, 'assets', { categoryId: D.SUPPLIER }).then(() => true); } },
  { name: 'loại thu chi: ẩn hạn chế', ...mutate(READER_SQL, `        WHERE NOT COALESCE(t.is_restricted,true)
          AND`, `        WHERE true
          AND`),
    run: async env => { await env.grant(['categories.view']); await orgWide(env, ['categories.view']);
      await env.db.query('INSERT INTO public.fixture_restricted_viewers VALUES($1)', [USER]);
      return ids((await run(env, 'ie_types')).items, 'name').includes('Lương'); } },
  { name: 'loại thu chi: ẩn hạng mục lương theo rule_key', ...mutate(READER_SQL,
    `          AND COALESCE(t.rule_key,'') NOT IN ('luong_dieu_hanh','luong_quan_ly','ung_luong','chia_loi_nhuan'))\n    SELECT`, `)\n    SELECT`),
    run: async env => { await env.grant(['categories.view']); await orgWide(env, ['categories.view']);
      return ids((await run(env, 'ie_types')).items, 'name').includes('Ứng lương'); } },
  { name: 'chi tiết phòng: HĐ cần contracts.view của kết nối', ...mutate(READER_SQL, `'contract',CASE WHEN r.building_id=ANY(v_contracts) THEN`, `'contract',CASE WHEN true THEN`),
    run: async env => { await env.grant(['rooms.view']); await dropRead(env.db, 'contracts.view');
      return (await run(env, 'room_detail', { roomId: ROOM })).items[0].contract !== null; } },
  // Review P1: bản DEFINER cũ của 040000 (tự chép phạm vi, vượt RLS areas) thay bản INVOKER ⇒ người không quản trị thấy tên khu.
  { name: 'khu: đọc dưới RLS của người hỏi, không DEFINER vượt RLS', ...mutate(SHARED_FIX_SQL, fnDefinition(SHARED_FIX_SQL, 'public.areas_in_scope_v1'),
    fnDefinition(SHARED_SQL, 'public.areas_in_scope_v1')),
    run: async env => { await env.grant(['buildings.view']); return (await run(env, 'buildings')).items[0].areaNames.length > 0; } },
  { name: 'khu: lọc organization_id tường minh', ...mutate(SHARED_FIX_SQL,
    `  WHERE a.organization_id=p_organization_id AND a.deleted_at IS NULL\n  ORDER BY a.created_at DESC,a.id;`, `  WHERE a.deleted_at IS NULL\n  ORDER BY a.created_at DESC,a.id;`),
    run: async env => { await env.db.query('INSERT INTO public.fixture_admins VALUES($1)', [USER]);
      await env.db.query("INSERT INTO public.areas(id,organization_id,name,code) VALUES($1,$2,'Khu công ty khác','KF')", [FOREIGN_AREA, FOREIGN]);
      return (await env.call('SELECT count(*)::int result FROM public.areas_in_scope_v1($1) WHERE area_id=$2', [ORG, FOREIGN_AREA], { role: 'authenticated' })) > 0; } },
  { name: 'thanh lý: ghi chú cần rào PII (customers.view của kết nối)', ...mutate(READER_SQL,
    `'note',CASE WHEN pii.ok THEN public.report_text_v1(v.termination_note,300) END,`, `'note',public.report_text_v1(v.termination_note,300),`),
    run: async env => { await env.grant(['reports_real_estate.terminations']); await dropRead(env.db, 'customers.view');
      return (await run(env, 're_terminations')).items[0].note !== null; } },
  { name: 'thanh lý: mẫu số cùng tập toà với tử số', ...mutate(READER_SQL,
    `    v_total:=public.real_estate_contract_count_v1(v_org,v_buildings);`, `    v_total:=public.real_estate_contract_count_v1(v_org,NULL);`),
    run: async env => { await env.grant(['reports_real_estate.terminations']); return (await run(env, 're_terminations')).summary.totalContracts !== 5; } },
  { name: 'loại thu chi: bỏ hạng mục dùng chung (không làm cả báo cáo 42501)', ...mutate(READER_SQL,
    `        FROM shown t WHERE t.organization_id=v_org) x;`, `        FROM shown t) x;`),
    run: async env => { await env.grant(['categories.view']); await orgWide(env, ['categories.view']);
      await env.db.query(`INSERT INTO public.income_expense_types(id,organization_id,type,name,category,is_restricted,created_at)
        VALUES($1,NULL,'expense','Điện nước chung','Tiện ích',false,'2025-01-01T00:00:00Z')`, [GLOBAL_IE_TYPES[0]]);
      return run(env, 'ie_types').then(() => false, error => error.code === '42501'); } },
  { name: 'report_text_v1: chỉ authenticated', ...mutate(SHARED_FIX_SQL,
    `  IF current_user<>'authenticated' OR auth.uid() IS NULL THEN RAISE EXCEPTION 'w2d_authenticated_only' USING ERRCODE='42501'; END IF;\n  RETURN CASE`, `  RETURN CASE`),
    run: async env => env.call('SELECT public.report_text_v1($1,5) result', ['x'], { role: 'postgres' }).then(() => true) },
];
for (const probe of probes) {
  const changed = changedFunctions(probe.live, probe.mutant);
  test(`mutation is caught: ${probe.name}`, { timeout: 120000 }, async () => {
    await inCase(async env => assert.equal(await probe.run(env).catch(() => false), false, 'bản sống từ chối'));
    await inCase(async env => {
      for (const sql of changed) await env.db.exec(sql);
      assert.equal(await probe.run(env), true, 'bản đột biến lọt');
    });
  });
}
