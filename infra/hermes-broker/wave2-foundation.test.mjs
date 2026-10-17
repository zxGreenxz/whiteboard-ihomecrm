import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedW2, grantRead, assertPackageParity, BUILDING, OTHER_BUILDING, SCOPE, ORG_SCOPE, binding, USER, ORG, FOREIGN, SESSION } from './wave2-sql-fixture.mjs';
import { changedFunctions, FULL_READ_OWNER_PATH } from './full-read-sql-fixture.mjs';
import { W2_FOUNDATION_PATH, w2MigrationPaths } from './wave2-sql-paths.mjs';
import { W2_READ_KEY_LIST, W2_SELF_KEYS } from './wave2-registry.mjs';
import { W2_PARAMS, w2Report, w2Params } from './wave2-kit.mjs';
import { DOMAIN_FAMILIES, domainInput } from './domain-contract.mjs';
import { createDomainAuthAdapter, createSupabaseDomainReads } from './domain-adapter.mjs';
import { createDependencyScope } from './dependency-scope.mjs';

// Gói 0 (nền đợt 2) trên PGlite: khoá seed tắt, capabilities v3, lớp options v7, cổng
// hermes_w2_gate_v1 sau public.hermes_domain_read_v3, bảng báo cáo gom bốn gói, từ điển tham số,
// phân trang chung. Báo cáo "thăm dò" chỉ cài TRONG ca (CREATE OR REPLACE catalog/read của gói,
// ROLLBACK sau ca) để chứng minh định tuyến/quyền/phạm vi; không có báo cáo thật nào ở Gói 0.
// Không chứng minh RLS, JWT thật, PostgREST hay chuỗi options thật v1..v6 (cổng tổng hợp).
let shared;
before(async () => {
  shared = await sharedW2({ seed: db => db.exec(`CREATE TABLE public.fixture_w2_reply(package text PRIMARY KEY,value jsonb NOT NULL);
    CREATE TABLE public.fixture_w2_calls(n bigserial PRIMARY KEY,package text,report text,params jsonb,ctx jsonb);
    GRANT SELECT,INSERT ON public.fixture_w2_reply,public.fixture_w2_calls TO authenticated;
    GRANT USAGE ON SEQUENCE public.fixture_w2_calls_n_seq TO authenticated;`) });
});
after(async () => { await shared?.close(); });
const inCase = work => shared.isolated(work);
const code = expected => error => error.code === expected;
const sorted = values => [...values].sort();
const foundation = readFileSync(W2_FOUNDATION_PATH, 'utf8');
const stripComments = sql => sql.replace(/--[^\n]*/g, '');
const block = (sql, name) => {
  const found = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}\\([\\s\\S]*?\\$fn\\$;`, 'g'));
  assert.ok(found, name); return found.at(-1);
};

// Bốn báo cáo thăm dò, mỗi gói một, phủ bốn kiểu phạm vi.
const PROBES = {
  a: ['probe_rows', { permission: 'vehicles.view', source: 'crm.probe_rows', scope: 'rows', params: ['query', 'buildingId', 'fromDate', 'toDate', 'status'],
    required: [], statuses: ['open', 'closed'], kinds: null, scopeKeys: ['customers.view'] }],
  b: ['probe_org', { permission: 'materials.view', source: 'crm.probe_org', scope: 'organization', params: ['query'], required: [], statuses: null, kinds: null, scopeKeys: [] }],
  c: ['probe_self', { permission: 'assistant.salary.self', source: 'crm.probe_self', scope: 'self', params: ['month'], required: ['month'], statuses: null, kinds: null, scopeKeys: [] }],
  d: ['probe_buildings', { permission: 'meters.view', source: 'crm.probe_buildings', scope: 'buildings', params: ['buildingId', 'year', 'kind'], required: [],
    statuses: null, kinds: ['electric', 'water'], scopeKeys: [] }],
};
const PROBE_KEYS = Object.values(PROBES).map(([, spec]) => spec.permission);
const catalogSql = (letter, value) => `CREATE OR REPLACE FUNCTION app_private.hermes_w2${letter}_catalog_v1()
  RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$ SELECT '${JSON.stringify(value).replaceAll("'", "''")}'::jsonb $fn$;`;
// Hàm đọc thăm dò: ghi lại (gói, mã, tham số, ctx) rồi trả câu trả lời cài sẵn hoặc một hàng nêu gói.
const readerSql = letter => `CREATE OR REPLACE FUNCTION app_private.hermes_w2${letter}_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
  RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
  DECLARE v jsonb;
  BEGIN
    INSERT INTO public.fixture_w2_calls(package,report,params,ctx) VALUES('${letter}',p_report,p_params,p_ctx);
    SELECT value INTO v FROM public.fixture_w2_reply WHERE package='${letter}';
    RETURN COALESCE(v,jsonb_build_object('rows',jsonb_build_array(jsonb_build_object('package','${letter}','report',p_report)),
      'summary',NULL,'sourceCapped',false,'unavailable',NULL));
  END $fn$;`;
async function installProbes(db, { readers = true, catalogs = PROBES } = {}) {
  for (const letter of ['a', 'b', 'c', 'd']) {
    await db.exec(catalogSql(letter, Object.fromEntries((catalogs[letter] ? [catalogs[letter]] : []))));
    if (readers) await db.exec(readerSql(letter));
  }
  await grantRead(db, PROBE_KEYS);
}
const calls = async db => (await db.query('SELECT package,report,params,ctx FROM public.fixture_w2_calls ORDER BY n')).rows;
const reply = (db, letter, value) => db.query('INSERT INTO public.fixture_w2_reply VALUES($1,$2::jsonb) ON CONFLICT(package) DO UPDATE SET value=EXCLUDED.value',
  [letter, JSON.stringify(value)]);
const params = (letter, values = {}) => ({ ...Object.fromEntries(PROBES[letter][1].params.map(name => [name, null])), ...values });
const run = (env, letter, values, extra) => env.report(PROBES[letter][0], params(letter, values), extra);
async function orgOverlay(db, on = true) {
  for (const table of ['hermes_connections', 'hermes_org_policies'])
    await db.query(on ? `UPDATE app_private.${table} SET scope_ids=array_append(scope_ids,$1::uuid)` : `UPDATE app_private.${table} SET scope_ids=array_remove(scope_ids,$1::uuid)`, [ORG_SCOPE]);
}
const caps = env => env.call('SELECT public.hermes_domain_capabilities_v3($1::uuid) result', [ORG]);

test('nền: 35 khoá đợt 2 khớp JS, seed ở trạng thái tắt, khoá self và từ điển tham số khớp; chuỗi đợt 2 tìm theo dải', () => inCase(async ({ db }) => {
  const one = async sql => (await db.query(sql)).rows[0].v;
  assert.deepEqual(sorted(await one('SELECT app_private.hermes_w2_read_keys_v1() v')), sorted(W2_READ_KEY_LIST));
  assert.equal(W2_READ_KEY_LIST.length, 35);
  assert.deepEqual(sorted(await one('SELECT app_private.hermes_w2_self_keys_v1() v')), sorted(W2_SELF_KEYS));
  assert.deepEqual(await one('SELECT app_private.hermes_w2_param_names_v1() v'), Object.keys(W2_PARAMS));
  const rows = (await db.query('SELECT capability,mode,enabled FROM app_private.hermes_capabilities WHERE capability=ANY($1) ORDER BY capability', [W2_READ_KEY_LIST])).rows;
  assert.deepEqual(rows, sorted(W2_READ_KEY_LIST).map(capability => ({ capability, mode: 'read', enabled: false })), 'seed tắt, mode read');
  assert.equal(DOMAIN_FAMILIES.v3.capabilitiesRpc, 'hermes_domain_capabilities_v3');
  assert.deepEqual(DOMAIN_FAMILIES.v3.capabilities, W2_READ_KEY_LIST);
  assert.equal(w2MigrationPaths({ packages: [] })[0], W2_FOUNDATION_PATH);
  for (const letter of ['a', 'b', 'c', 'd']) await assertPackageParity({ db }, letter);
}));

test('cấu trúc: v3 = đúng bản 20261017033630 + hai dòng định tuyến; không copilot_; ACL chỉ mở năm hàm public cho authenticated', () => inCase(async ({ db }) => {
  const live = block(foundation, 'public.hermes_domain_read_v3'), reviewed = block(readFileSync(FULL_READ_OWNER_PATH, 'utf8'), 'public.hermes_domain_read_v3');
  const prefix = "  -- Đợt 2 (20261018000000): hai miền meta sang cổng riêng; mọi dòng dưới giữ nguyên 20261017033630.\n" +
    "  IF p_domain IN ('report','report_list') THEN RETURN app_private.hermes_w2_gate_v1(p_binding,p_domain,p_input); END IF;\n";
  assert.equal(live.split(prefix).length, 2, 'đúng một khối định tuyến');
  assert.equal(live.replace(prefix, ''), reviewed, 'mọi dòng khác của v3 giữ nguyên');
  assert.doesNotMatch(stripComments(foundation), /copilot_/i);
  const created = [...stripComments(foundation).matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+\.[a-z0-9_]+)\(/g)].map(match => match[1]);
  const PUBLIC = ['public.hermes_domain_capabilities_v3', 'public.hermes_org_policy_options_v7', 'public.hermes_connection_options_v7',
    'public.hermes_connection_context_v7', 'public.hermes_domain_read_v3'];
  const PRIVATE = ['app_private.hermes_w2_read_keys_v1', 'app_private.hermes_w2_self_keys_v1', 'app_private.hermes_w2_grant_v1',
    'app_private.hermes_w2_extend_options_v1', ...['a', 'b', 'c', 'd'].map(letter => `app_private.hermes_w2${letter}_catalog_v1`),
    'app_private.hermes_w2_param_names_v1', 'app_private.hermes_w2_catalog_v1', 'app_private.hermes_w2_params_v1',
    ...['a', 'b', 'c', 'd'].map(letter => `app_private.hermes_w2${letter}_read_v1`), 'app_private.hermes_w2_gate_v1'];
  assert.deepEqual(sorted(created), sorted([...PUBLIC, ...PRIVATE]), 'chỉ các hàm của nền đợt 2');
  assert.doesNotMatch(stripComments(foundation), /\bDROP\b|ALTER TABLE|UPDATE app_private\.hermes_capabilities|enabled\s*=\s*true/i);
  const procs = (await db.query(`SELECT n.nspname||'.'||p.proname name,p.prosecdef definer,p.prosrc src,p.proconfig config,
      has_function_privilege('authenticated',p.oid,'EXECUTE') auth,has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('service_role',p.oid,'EXECUTE') service
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=ANY($1)`, [[...PUBLIC, ...PRIVATE]])).rows;
  assert.equal(procs.length, PUBLIC.length + PRIVATE.length);
  for (const proc of procs) {
    assert.equal(proc.definer, true, proc.name); assert.match(proc.config.join(','), /^search_path=pg_catalog, ?(public, ?)?app_private$/, proc.name);
    assert.doesNotMatch(stripComments(proc.src), /copilot_/i, proc.name);
    assert.deepEqual([proc.auth, proc.anon, proc.service], [PUBLIC.includes(proc.name), false, false], proc.name);
  }
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_proc WHERE proname LIKE 'copilot%'")).rows[0].n, 0, 'fixture không có hàm copilot nào');
}));

test('capabilities v3: đúng 35 khoá; registry, chính sách, CRM là ba hàng rào; self không trả toà; hai khoá Hermes-only theo cổng web', () => inCase(async env => {
  const { db } = env;
  const before = await caps(env);
  assert.deepEqual(sorted(Object.keys(before.permissions)), sorted(W2_READ_KEY_LIST));
  assert.deepEqual(sorted(Object.keys(before)), sorted(['organizationId', 'userId', 'membershipId', 'authorizationVersion', 'isSuperadmin', 'policyVersion', 'permissions']));
  for (const key of W2_READ_KEY_LIST) assert.deepEqual(before.permissions[key], { allowed: false, companyEnabled: false, buildingIds: [] }, `${key}: tắt`);
  await grantRead(db, ['vehicles.view', 'notifications.view', 'assistant.salary.self', 'assistant.bank_events.read']);
  let now = await caps(env);
  assert.deepEqual(now.permissions['vehicles.view'], { allowed: true, companyEnabled: true, buildingIds: sorted([BUILDING, OTHER_BUILDING]) });
  assert.deepEqual(now.permissions['notifications.view'], { allowed: true, companyEnabled: true, buildingIds: [] }, 'self: không toà');
  assert.deepEqual(now.permissions['assistant.salary.self'], { allowed: true, companyEnabled: true, buildingIds: [] }, 'Lương của tôi: không cần khoá CRM');
  assert.deepEqual(now.permissions['assistant.bank_events.read'], { allowed: false, companyEnabled: true, buildingIds: [] }, 'Biến động số dư: chỉ super admin');
  await db.exec(`INSERT INTO public.super_admins VALUES('${USER}')`);
  assert.equal((await caps(env)).permissions['assistant.bank_events.read'].allowed, true);
  await db.exec(`DELETE FROM public.super_admins; UPDATE public.fixture_acl SET allowed=false WHERE permission IN ('vehicles.view','assistant.salary.self')`);
  now = await caps(env);
  assert.deepEqual(now.permissions['vehicles.view'], { allowed: false, companyEnabled: true, buildingIds: [] }, 'mất quyền CRM');
  assert.equal(now.permissions['assistant.salary.self'].allowed, true, 'khoá Hermes-only không đọc quyền CRM');
  await db.exec("UPDATE app_private.hermes_org_policies SET read_capabilities=array_remove(read_capabilities,'notifications.view')");
  assert.deepEqual((await caps(env)).permissions['notifications.view'], { allowed: false, companyEnabled: false, buildingIds: [] }, 'chính sách công ty');
  await db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='assistant.salary.self'");
  assert.equal((await caps(env)).permissions['assistant.salary.self'].allowed, false, 'registry');
  await assert.rejects(env.call('SELECT public.hermes_domain_capabilities_v3($1::uuid) result', [ORG], { role: 'anon' }), /permission denied/);
}));

test('khung rỗng: mục lục trống, mã lạ 22023, hàm đọc của nền trả not_implemented qua đúng gói', () => inCase(async env => {
  const { db } = env;
  await grantRead(db, PROBE_KEYS);
  // Chính thân khung của nền (gói có thể đã thay thân thật sau này).
  for (const letter of ['a', 'b', 'c', 'd']) await db.exec(block(foundation, `app_private.hermes_w2${letter}_read_v1`));
  for (const letter of ['a', 'b', 'c', 'd']) await db.exec(block(foundation, `app_private.hermes_w2${letter}_catalog_v1`));
  assert.deepEqual((await env.reportList()).items, []);
  await assert.rejects(env.report('nope'), code('22023'));
  await installProbes(db, { readers: false });
  await orgOverlay(db);
  for (const letter of ['a', 'b', 'c', 'd']) {
    const value = await run(env, letter, letter === 'c' ? { month: '2026-09' } : {});
    assert.deepEqual([value.report, value.source, value.unavailable, value.items, value.summary, value.nextOffset, value.sourceCapped],
      [PROBES[letter][0], PROBES[letter][1].source, 'not_implemented', [], null, null, false], letter);
    assert.deepEqual(Object.keys(value).sort(), sorted(['organizationId', 'domain', 'fetchedAt', 'report', 'source', 'unavailable', 'summary', 'items', 'offset', 'nextOffset', 'sourceCapped']));
  }
}));

test('định tuyến: mỗi mã sang đúng hàm của gói với ctx do cổng dựng (toà = CRM ∩ overlay, khoá phụ, hôm nay)', () => inCase(async env => {
  const { db } = env;
  await installProbes(db);
  const rows = await run(env, 'a');
  assert.deepEqual(rows.items, [{ package: 'a', report: 'probe_rows' }]);
  assert.equal(rows.source, 'crm.probe_rows'); assert.equal(rows.organizationId, ORG); assert.equal(rows.domain, 'report');
  const [call] = await calls(db);
  assert.deepEqual([call.package, call.report, call.params], ['a', 'probe_rows', params('a')]);
  assert.deepEqual(call.ctx, { organizationId: ORG, userId: USER, report: 'probe_rows', permission: 'vehicles.view', scope: 'rows',
    buildings: [BUILDING], requestedBuildingId: null, overlayOrg: false, orgWide: false, isSuperadmin: false, today: '2026-10-16',
    scopes: { 'customers.view': [BUILDING] } }, 'CRM A+B ∩ overlay A; khoá phụ cùng cách tính');
  assert.deepEqual((await run(env, 'd', { kind: 'water' })).items, [{ package: 'd', report: 'probe_buildings' }]);
  assert.deepEqual((await run(env, 'c', { month: '2026-09' })).items, [{ package: 'c', report: 'probe_self' }]);
  assert.deepEqual((await calls(db)).at(-1).ctx.buildings, [], 'self: không toà, vẫn đọc');
  assert.equal((await run(env, 'b')).unavailable, 'organization_scope_required', 'organization cần Toàn tổ chức');
  assert.deepEqual((await calls(db)).map(row => row.package), ['a', 'd', 'c'], 'không gọi gói khi chưa đủ phạm vi');
  await orgOverlay(db);
  assert.deepEqual((await run(env, 'b')).items, [{ package: 'b', report: 'probe_org' }]);
  assert.equal((await calls(db)).at(-1).ctx.overlayOrg, true);
  await db.exec("UPDATE public.fixture_acl SET org_wide=true WHERE permission='vehicles.view'");
  await run(env, 'a');
  assert.deepEqual([(await calls(db)).at(-1).ctx.orgWide, (await calls(db)).at(-1).ctx.buildings], [true, sorted([BUILDING, OTHER_BUILDING])]);
  // Đợt 1 vẫn chạy qua v3 mới.
  assert.ok((await env.read3('customers', { query: '', limit: 5, cursor: null, buildingId: null, status: null })).items.length > 0);
}));

test('quyền: thiếu bất kỳ lớp nào ⇒ 42501; mục lục chỉ liệt kê báo cáo còn đủ registry ∩ chính sách ∩ Read kết nối ∩ CRM', () => inCase(async env => {
  const { db } = env;
  await installProbes(db);
  const listed = async topic => (await env.reportList(topic)).items;
  assert.deepEqual(await listed(), sorted(Object.values(PROBES).map(([report]) => report)).map(report =>
    ({ report, permission: Object.values(PROBES).find(([name]) => name === report)[1].permission })));
  assert.deepEqual(await listed('a'), [{ report: 'probe_rows', permission: 'vehicles.view' }]);
  await assert.rejects(env.reportList('x'), code('22023'));
  for (const [label, off, on] of [
    ['Read của kết nối', "UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'vehicles.view')",
      "UPDATE app_private.hermes_connections SET read_capabilities=read_capabilities||ARRAY['vehicles.view']"],
    ['registry', "UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='vehicles.view'",
      "UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='vehicles.view'"],
    ['chính sách công ty', "UPDATE app_private.hermes_org_policies SET read_capabilities=array_remove(read_capabilities,'vehicles.view')",
      "UPDATE app_private.hermes_org_policies SET read_capabilities=read_capabilities||ARRAY['vehicles.view']"],
    ['quyền CRM', "UPDATE public.fixture_acl SET allowed=false WHERE permission='vehicles.view'", "UPDATE public.fixture_acl SET allowed=true WHERE permission='vehicles.view'"],
  ]) {
    await db.exec(off);
    await assert.rejects(run(env, 'a'), code('42501'), label);
    // Chính sách công ty hẹp hơn Read đã lưu ⇒ cả kết nối bị từ chối (hermes_command_denied), không chỉ mục này.
    const rows = await listed().catch(error => { if (error.code === '42501') return 'denied'; throw error; });
    assert.ok(rows === 'denied' || !rows.some(row => row.report === 'probe_rows'), `mục lục: ${label}`);
    await db.exec(on);
  }
  assert.equal((await run(env, 'a')).items.length, 1, 'đủ lớp lại đọc được');
  await assert.rejects(env.report('probe_rows', params('a'), {}, binding, { actor: FOREIGN }), code('42501'), 'người khác cầm token');
  await assert.rejects(env.reportList(null, binding, { actor: FOREIGN }), code('42501'));
  await assert.rejects(env.report('probe_rows', params('a'), {}, { ...binding, expectedEpoch: 2 }), code('PT409'), 'kết nối đổi giữa chừng');
  await assert.rejects(env.report('probe_rows', params('a'), {}, { ...binding, expectedPolicyVersion: 2 }), code('PT409'), 'chính sách đổi giữa chừng');
}));

test('phạm vi toà: buildingId thu hẹp và phải nằm trong CRM ∩ overlay; hết toà ⇒ no_building_scope, không gọi gói', () => inCase(async env => {
  const { db } = env;
  await installProbes(db);
  await assert.rejects(run(env, 'a', { buildingId: OTHER_BUILDING }), code('42501'), 'toà B ngoài overlay');
  await run(env, 'a', { buildingId: BUILDING });
  assert.deepEqual([(await calls(db)).at(-1).ctx.buildings, (await calls(db)).at(-1).ctx.requestedBuildingId], [[BUILDING], BUILDING]);
  await db.exec(`UPDATE public.fixture_acl SET building_ids=ARRAY['${OTHER_BUILDING}'::uuid] WHERE permission IN ('vehicles.view','meters.view')`);
  const before = (await calls(db)).length;
  for (const letter of ['a', 'd']) assert.equal((await run(env, letter)).unavailable, 'no_building_scope', letter);
  assert.equal((await calls(db)).length, before, 'không gọi gói khi không còn toà');
  assert.equal((await run(env, 'c', { month: '2026-09' })).unavailable, null, 'self không phụ thuộc toà');
  await assert.rejects(env.report('probe_org', { query: null, buildingId: null }), code('22023'), 'organization không nhận buildingId');
}));

// Cùng một khai báo cho JS (w2Report/w2Params) và SQL (bảng thăm dò): mọi tham số sai bị cả hai từ chối.
const JS_PROBE = { a: w2Report({ ...PROBES.a[1], title: 'thăm dò', fields: { package: () => true, report: () => true } }),
  c: w2Report({ ...PROBES.c[1], title: 'thăm dò', fields: { package: () => true, report: () => true } }),
  d: w2Report({ ...PROBES.d[1], title: 'thăm dò', fields: { package: () => true, report: () => true } }) };
test('tham số: SQL và JS cùng luật (tên, kiểu, danh sách status/kind, bắt buộc, khoảng ngày ≤ 366)', () => inCase(async env => {
  const { db } = env;
  await installProbes(db);
  const bad = [['a', { status: 'OPEN' }], ['a', { fromDate: '2026-13-01' }], ['a', { fromDate: '2026-01-01', toDate: '2027-01-03' }],
    ['a', { fromDate: '2026-02-01', toDate: '2026-01-01' }], ['a', { query: 'a\nb' }], ['a', { query: 'x'.repeat(201) }], ['a', { buildingId: 'toà A' }],
    ['a', { buildingId: 7 }], ['c', { month: '2026-9' }], ['c', { month: null }], ['d', { year: 1999 }], ['d', { year: '2026' }], ['d', { kind: 'gas' }]];
  for (const [letter, values] of bad) {
    await assert.rejects(run(env, letter, values), code('22023'), JSON.stringify(values));
    assert.throws(() => w2Params(JS_PROBE[letter], values), JSON.stringify(values));
  }
  await assert.rejects(env.report('probe_rows', { ...params('a'), foo: 1 }), code('22023'), 'tên lạ');
  await assert.rejects(env.report('probe_rows', { query: null }), code('22023'), 'SQL đòi đủ tập tên (broker luôn gửi đủ)');
  await assert.rejects(env.report('probe_rows', params('a'), { limit: 51 }), code('22023'));
  await assert.rejects(env.report('probe_rows', params('a'), { offset: 2001 }), code('22023'));
  const good = { query: ' Toà A ', buildingId: ` ${BUILDING}`, fromDate: '2026-01-01', toDate: '2027-01-02', status: 'open' };
  const canonical = w2Params(JS_PROBE.a, good);
  assert.deepEqual(canonical, { query: 'Toà A', buildingId: BUILDING, fromDate: '2026-01-01', toDate: '2027-01-02', status: 'open' });
  assert.equal((await env.report('probe_rows', canonical)).items.length, 1, 'bản chuẩn hoá của JS qua được SQL');
  assert.deepEqual(w2Params(JS_PROBE.a, { buildingId: '00000000-0000-0000-0000-000000000000', query: '   ' }), params('a'), 'chỗ trống/UUID 0 = null');
  assert.deepEqual(domainInput('customers', {}).limit, 20, 'đợt 1 không đổi');
}));

test('kết quả gói: phân trang chung (offset/limit/≈40 KB), khuôn sai ⇒ XX000, unavailable của gói đi nguyên', () => inCase(async env => {
  const { db } = env;
  await installProbes(db);
  await reply(db, 'a', { rows: Array.from({ length: 60 }, (_, n) => ({ n })), summary: { total: 60 }, sourceCapped: true, unavailable: null });
  let page = await run(env, 'a');
  assert.deepEqual([page.items.length, page.items[0], page.offset, page.nextOffset, page.summary, page.sourceCapped], [20, { n: 0 }, 0, 20, { total: 60 }, true]);
  page = await run(env, 'a', {}, { offset: 40, limit: 50 });
  assert.deepEqual([page.items.length, page.items[0].n, page.nextOffset], [20, 40, null]);
  await reply(db, 'a', { rows: Array.from({ length: 30 }, (_, n) => ({ n, text: '"'.repeat(1500) })), summary: null, sourceCapped: false, unavailable: null });
  page = await run(env, 'a', {}, { limit: 50 });
  assert.ok(page.items.length < 30 && page.nextOffset === page.items.length, 'dừng sớm theo byte sau escape');
  await reply(db, 'a', { rows: [], summary: null, sourceCapped: false, unavailable: 'source_unavailable' });
  assert.equal((await run(env, 'a')).unavailable, 'source_unavailable');
  for (const value of ['[]', { rows: [], summary: null, sourceCapped: false }, { rows: {}, summary: null, sourceCapped: false, unavailable: null },
    { rows: [], summary: null, sourceCapped: 'no', unavailable: null }, { rows: [], summary: [], sourceCapped: false, unavailable: null },
    { rows: [], summary: null, sourceCapped: false, unavailable: 'copilot_feature_disabled' }, { rows: [{ n: 1 }], summary: null, sourceCapped: false, unavailable: 'not_implemented' },
    { rows: [1], summary: null, sourceCapped: false, unavailable: null }, { rows: Array.from({ length: 2001 }, () => ({})), summary: null, sourceCapped: false, unavailable: null },
    { rows: [], summary: null, sourceCapped: false, unavailable: null, extra: 1 }]) {
    await reply(db, 'a', value);
    await assert.rejects(run(env, 'a'), code('XX000'), JSON.stringify(value).slice(0, 80));
  }
  await reply(db, 'c', { rows: [], summary: null, sourceCapped: false, unavailable: 'no_building_scope' });
  await assert.rejects(run(env, 'c', { month: '2026-09' }), code('XX000'), 'self không thể "hết toà"');
  await reply(db, 'a', { rows: [{ text: 'x'.repeat(70000) }], summary: null, sourceCapped: false, unavailable: null });
  await assert.rejects(run(env, 'a'), code('PT413'), 'một hàng quá trần ⇒ result_too_large');
}));

test('bảng báo cáo: trùng mã giữa hai gói, khai báo sai khuôn hoặc nguồn sai dạng ⇒ XX000 (lỗi của gói, không lộ gì)', () => inCase(async env => {
  const { db } = env;
  await installProbes(db);
  const [, spec] = PROBES.a;
  const broken = [{ b: ['probe_rows', spec] }, { a: ['probe_rows', { ...spec, source: 'crm.Bad Source' }] },
    { a: ['probe_rows', (({ kinds, ...rest }) => rest)(spec)] }, { a: ['probe_rows', { ...spec, params: ['foo'] }] },
    { a: ['probe_rows', { ...spec, required: ['month'] }] }, { a: ['probe_rows', { ...spec, statuses: null }] },
    { a: ['probe_rows', { ...spec, scope: 'organization' }] }, { a: ['probe_rows', { ...spec, scope: 'global' }] },
    { a: ['Probe', spec] }, { a: ['probe_rows', { ...spec, params: ['query', 'query'] }] }];
  for (const change of broken) {
    const [letter] = Object.keys(change);
    await db.exec(catalogSql(letter, Object.fromEntries([...(letter === 'a' ? [] : [PROBES[letter]]), change[letter]])));
    await assert.rejects(env.reportList(), code('XX000'), JSON.stringify(change).slice(0, 90));
    await db.exec(catalogSql(letter, Object.fromEntries([PROBES[letter]])));
  }
  assert.equal((await env.reportList()).items.length, 4, 'khôi phục bảng ⇒ chạy lại');
}));

// Lớp options/context đợt 2 trên lớp dưới tổng hợp (fixture_v6; lớp Khách hàng identity).
const MEMBER = { userId: USER, organizationId: ORG, membershipId: USER, authorizationVersion: 1, isSuperadmin: false };
const v7 = (env, name, arg = ORG) => env.call(`SELECT public.${name}($1::uuid) result`, [arg]);
const base = (db, kind, value) => db.query('INSERT INTO public.fixture_v6 VALUES($1,$2::jsonb) ON CONFLICT(kind) DO UPDATE SET value=EXCLUDED.value', [kind, JSON.stringify(value)]);
test('options/context v7: lớp đợt 2 chỉ thêm khoá registry đã bật / CRM đang cấp; không có khoá nào ⇒ nguyên lớp dưới', () => inCase(async env => {
  const { db } = env;
  const org = { ...MEMBER, policyVersion: 1, choices: { read: ['customers.view'], action: [] } };
  const options = { ...MEMBER, policyVersion: 1, enabled: true, read: ['customers.view'], action: [], scopes: [] };
  const context = { ...MEMBER, policyVersion: 1, scopeIds: [SCOPE], restrictions: { read: ['vehicles.view', 'notifications.view'], action: [] },
    companyCeilings: { read: ['vehicles.view', 'notifications.view'], action: [] }, effective: { read: [], action: [] } };
  for (const [kind, value] of [['org_options', org], ['connection_options', options], ['context', context]]) await base(db, kind, value);
  assert.deepEqual(await v7(env, 'hermes_org_policy_options_v7'), org, 'registry tắt: nguyên lớp dưới');
  assert.deepEqual(await v7(env, 'hermes_connection_options_v7'), options);
  assert.deepEqual(await v7(env, 'hermes_connection_context_v7', binding.connectionId), context);
  await db.exec("UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability IN ('vehicles.view','notifications.view')");
  assert.deepEqual((await v7(env, 'hermes_org_policy_options_v7')).choices.read, ['customers.view', 'notifications.view', 'vehicles.view'], 'chính sách: lựa chọn từ registry');
  assert.deepEqual(await v7(env, 'hermes_connection_options_v7'), options, 'chưa vào chính sách/CRM: không mời khoá');
  await grantRead(db, ['vehicles.view', 'notifications.view']);
  const offered = await v7(env, 'hermes_connection_options_v7');
  assert.deepEqual(offered.read, ['customers.view', 'vehicles.view', 'notifications.view'], 'thêm theo thứ tự khoá của nền');
  assert.deepEqual(offered.scopes.map(scope => [scope.scopeId, scope.scopeType]), [[SCOPE, 'BUILDING']], 'phạm vi của toà grant ∩ chính sách');
  assert.deepEqual((await v7(env, 'hermes_connection_context_v7', binding.connectionId)).effective.read, ['vehicles.view', 'notifications.view'],
    'context: toà nhờ phạm vi đã chọn, self không cần toà');
  await db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='vehicles.view'");
  assert.deepEqual((await v7(env, 'hermes_connection_context_v7', binding.connectionId)).effective.read, ['notifications.view'], 'mất CRM ⇒ không hiệu lực');
  await db.exec(`UPDATE app_private.hermes_org_policies SET scope_ids='{}'`);
  await db.exec(`UPDATE app_private.hermes_connections SET scope_ids='{}'`);
  const noScope = await v7(env, 'hermes_connection_options_v7');
  assert.deepEqual([noScope.read, noScope.scopes], [['customers.view', 'notifications.view'], []], 'không phạm vi: khoá self vẫn mời');
}));

// Ghép nối broker ↔ SQL thật: adapter quyền của họ v3 gọi hermes_domain_capabilities_v3 (đúng 35 khoá,
// khuôn như v1/v2) và gộp khoá được cấp + phạm vi toà vào ảnh chụp quyền; self không toà.
test('ghép nối: createDomainAuthAdapter nhận khuôn capabilities v3 thật và gộp khoá đợt 2 vào quyền hiệu lực', { timeout: 60000 }, () => inCase(async env => {
  const { db } = env;
  await grantRead(db, ['vehicles.view', 'notifications.view']);
  const SQL = { hermes_domain_capabilities_v1: 'SELECT public.hermes_domain_capabilities_v1($1::uuid) result',
    hermes_domain_capabilities_v2: 'SELECT public.hermes_domain_capabilities_v2($1::uuid) result',
    hermes_domain_capabilities_v3: 'SELECT public.hermes_domain_capabilities_v3($1::uuid) result' };
  const seen = [];
  const fetch = async (url, options) => {
    const name = new URL(url).pathname.replace('/rest/v1/rpc/', ''); seen.push(name);
    assert.ok(Object.hasOwn(SQL, name), `unexpected RPC ${name}`);
    try { return Response.json(await env.call(SQL[name], [JSON.parse(options.body).p_organization_id])); }
    catch (error) { return Response.json({ code: error.code, message: error.message, details: null, hint: null }, { status: error.code === '42501' ? 403 : 400 }); }
  };
  const scope = createDependencyScope();
  try {
    const reads = createSupabaseDomainReads({ url: 'https://example.invalid/', publishableKey: 'sb_publishable_test', fetch, dependencyScope: scope });
    const baseAuth = { async verifySession() { return {}; }, async readAuthorization() { return { userId: USER, isSuperadmin: false, activeOrganizationIds: [ORG],
      epoch: 'base', membership: { organizationId: ORG, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null, membershipId: USER, authorizationVersion: 1 },
      permissions: { read: [], action: [] }, companyCeilings: { read: [], action: [] }, scopesByPermission: {} }; } };
    const accessToken = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION })).toString('base64url'), 'signature'].join('.');
    const merged = await createDomainAuthAdapter({ baseAuth, reads }).readAuthorization({ accessToken, userId: USER, organizationId: ORG,
      signal: new AbortController().signal });
    assert.deepEqual(sorted(seen), sorted(Object.keys(SQL)), 'một lượt cho ba họ');
    for (const key of ['vehicles.view', 'notifications.view']) assert.ok(merged.permissions.read.includes(key), key);
    assert.equal(merged.permissions.read.includes('materials.view'), false, 'chưa cấp thì không có');
    assert.deepEqual(merged.scopesByPermission['vehicles.view'].buildingIds, sorted([BUILDING, OTHER_BUILDING]));
    assert.deepEqual(merged.scopesByPermission['notifications.view'].buildingIds, []);
    assert.ok(merged.companyCeilings.read.includes('vehicles.view'));
  } finally { await scope.close(); }
}));

// Đột biến: mỗi bản bỏ MỘT hàng rào của nền; cùng phép thử mà bản sống từ chối thì bản đột biến phải lọt.
const replaceExactly = (from, to) => { assert.equal(foundation.split(from).length, 2, `anchor: ${from}`); return foundation.replace(from, () => to); };
const probes = [
  { name: 'gate: toà = grant ∩ overlay của kết nối', sql: replaceExactly(`      AND state->'buildingIds' ? b.id::text
      AND EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(scopes)`, `      AND state->'buildingIds' ? b.id::text
      AND true OR EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(scopes)`),
    run: async env => { await installProbes(env.db); await run(env, 'a'); return (await calls(env.db)).at(-1).ctx.buildings.includes(OTHER_BUILDING); } },
  { name: 'gate: Read của kết nối', sql: replaceExactly(`    IF state->'allowed' IS DISTINCT FROM 'true'::jsonb OR NOT(permission=ANY(c.read_capabilities))
      THEN`, `    IF state->'allowed' IS DISTINCT FROM 'true'::jsonb
      THEN`),
    run: async env => { await installProbes(env.db);
      await env.db.exec("UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'vehicles.view')");
      return (await run(env, 'a')).items.length === 1; } },
  { name: 'gate: registry', sql: replaceExactly(`    enabled:=policy.enabled AND permission=ANY(policy.read_capabilities) AND EXISTS(
      SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=permission AND h.mode='read' AND h.enabled);
    state:=app_private.hermes_w2_grant_v1`, `    enabled:=policy.enabled AND permission=ANY(policy.read_capabilities);
    state:=app_private.hermes_w2_grant_v1`),
    run: async env => { await installProbes(env.db);
      await env.db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='vehicles.view'");
      return (await run(env, 'a')).items.length === 1; } },
  { name: 'gate: organization cần Toàn tổ chức', sql: replaceExactly(`WHEN v_spec->>'scope'='organization' AND NOT overlay_org THEN`, `WHEN false THEN`),
    run: async env => { await installProbes(env.db); return (await run(env, 'b')).items.length === 1; } },
  { name: 'gate: buildingId phải trong phạm vi', sql: replaceExactly(`      IF NOT(requested_building=ANY(buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
      buildings:=ARRAY[requested_building];`, `      buildings:=ARRAY[requested_building];`),
    run: async env => { await installProbes(env.db); return (await run(env, 'a', { buildingId: OTHER_BUILDING })).items.length === 1; } },
  { name: 'gate: hết toà ⇒ no_building_scope', sql: replaceExactly(`      WHEN v_spec->>'scope' IN ('rows','buildings') AND cardinality(buildings)=0 THEN 'no_building_scope' END;`, ` END;`),
    run: async env => { await installProbes(env.db);
      await env.db.exec(`UPDATE public.fixture_acl SET building_ids=ARRAY['${OTHER_BUILDING}'::uuid] WHERE permission='vehicles.view'`);
      return (await run(env, 'a')).items.length === 1; } },
  { name: 'mục lục: Read của kết nối', sql: replaceExactly(`IF state->'allowed'='true'::jsonb AND k=ANY(c.read_capabilities) THEN`, `IF state->'allowed'='true'::jsonb THEN`),
    run: async env => { await installProbes(env.db);
      await env.db.exec("UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'vehicles.view')");
      return (await env.reportList()).items.some(row => row.report === 'probe_rows'); } },
  { name: 'grant: Biến động số dư chỉ super admin', sql: replaceExactly(` AND p_member->'isSuperadmin'='true'::jsonb;`, `;`),
    run: async env => { await grantRead(env.db, ['assistant.bank_events.read']); return (await caps(env)).permissions['assistant.bank_events.read'].allowed; } },
  { name: 'grant: khoá self không trả toà', sql: replaceExactly(`    IF p_key=ANY(app_private.hermes_w2_self_keys_v1()) THEN RETURN jsonb_set(v_state,'{buildingIds}','[]'::jsonb,false); END IF;
`, ''),
    run: async env => { await grantRead(env.db, ['notifications.view']); return (await caps(env)).permissions['notifications.view'].buildingIds.length > 0; } },
  { name: 'tham số: đúng tập tên', sql: replaceExactly(`  PERFORM app_private.hermes_request_v1(p_params,v_names);
`, ''),
    run: async env => { await installProbes(env.db); return (await env.report('probe_rows', { ...params('a'), foo: 1 })).items.length === 1; } },
  { name: 'kết quả gói: unavailable không kèm hàng', sql: replaceExactly(`        OR v_raw->'unavailable'<>'null'::jsonb AND (jsonb_array_length(v_raw->'rows')>0 OR v_raw->'summary'<>'null'::jsonb)
`, ''),
    run: async env => { await installProbes(env.db);
      await reply(env.db, 'a', { rows: [{ n: 1 }], summary: null, sourceCapped: false, unavailable: 'not_implemented' });
      return (await run(env, 'a')).unavailable === 'not_implemented'; } },
  { name: 'bảng báo cáo: cấm trùng mã giữa hai gói', sql: replaceExactly(`      IF v_all ? v_key OR v_key !~`, `      IF v_key !~`),
    run: async env => { await installProbes(env.db); await env.db.exec(catalogSql('b', Object.fromEntries([PROBES.b, ['probe_rows', PROBES.a[1]]])));
      return (await env.reportList()).items.length > 0; } },
  { name: 'options: khoá chưa được CRM cấp không được mời', sql: replaceExactly(`    CONTINUE WHEN cap->'allowed' IS DISTINCT FROM 'true'::jsonb;
`, ''),
    run: async env => { await base(env.db, 'connection_options', { ...MEMBER, policyVersion: 1, enabled: true, read: [], action: [], scopes: [] });
      // Không phạm vi nào ⇒ khoá cần toà bị bỏ ở cuối; khoá self (không toà) lộ ra nếu thiếu hàng rào.
      return (await v7(env, 'hermes_connection_options_v7')).read.includes('notifications.view'); } },
];
for (const probe of probes) {
  const changed = changedFunctions(foundation, probe.sql);
  test(`mutation is caught: ${probe.name}`, { timeout: 120000 }, async () => {
    await inCase(async env => assert.equal(await probe.run(env).catch(() => false), false, 'bản sống từ chối'));
    await inCase(async env => {
      for (const sql of changed) await env.db.exec(sql);
      assert.equal(await probe.run(env), true, 'bản đột biến lọt');
    });
  });
}
