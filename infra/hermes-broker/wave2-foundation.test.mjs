import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedW2, grantRead, assertPackageParity, BUILDING, OTHER_BUILDING, SCOPE, ORG_SCOPE, binding, USER, ORG, FOREIGN, SESSION } from './wave2-sql-fixture.mjs';
import { changedFunctions, FULL_READ_OWNER_PATH, ROOM, OTHER_ROOM, FOREIGN_ROOM, CONTRACT_A, CONTRACT_B, INVOICE_A, INVOICE_B, CUSTOMER_A,
  CUSTOMER_F } from './full-read-sql-fixture.mjs';
import { CASHBOOK } from './finance-fixture.mjs';
import { W2_FOUNDATION_PATH, W2_FIXES_PATH, W2_INVOKER_PATH, W2_ORG_FENCE_PATH, W2_RANGES, W2_FOUNDATION_FUNCTIONS, w2MigrationPaths, w2FenceViolations,
  w2AllMigrations } from './wave2-sql-paths.mjs';
import { W2_READ_KEY_LIST, W2_SELF_KEYS, W2_ENABLED_KEYS } from './wave2-registry.mjs';
import { W2_PARAMS, W2_REUSED_KEYS, W2_ORG_KEYS, w2Report, w2Params, w2PermissionKind } from './wave2-kit.mjs';
import { DOMAIN_FAMILIES, domainFamily, domainInput } from './domain-contract.mjs';
import { createDomainAuthAdapter, createSupabaseDomainReads } from './domain-adapter.mjs';
import { createDependencyScope } from './dependency-scope.mjs';

// Gói 0 (nền đợt 2) trên PGlite: khoá seed tắt, capabilities v3, lớp options v7, bảng báo cáo gom bốn
// gói, từ điển tham số, phân trang chung; sửa sau review PR #195 (20261018000500): khoá ↔ scope, rào đầu
// ra + fence, giải tham số ID, organization đòi org_wide, sổ quỹ CRM, scope cashbooks/platform, hàng rào
// gói; cổng INVOKER + RLS (20261018000600): lối vào public.hermes_w2_read_v1 gọi dưới SET ROLE
// authenticated như PostgREST, bước kiểm quyền/bước kết thúc DEFINER, hàm gói INVOKER (RLS của người hỏi).
// Báo cáo "thăm dò" chỉ cài TRONG ca (CREATE OR REPLACE catalog/read của gói, ROLLBACK sau ca).
// Không chứng minh JWT thật, PostgREST hay chuỗi options thật v1..v6 (cổng tổng hợp); RLS chỉ trên bảng thử.
let shared;
before(async () => {
  shared = await sharedW2({ seed: db => db.exec(`CREATE TABLE public.fixture_w2_reply(package text PRIMARY KEY,value jsonb NOT NULL);
    CREATE TABLE public.fixture_w2_calls(n bigserial PRIMARY KEY,package text,report text,params jsonb,ctx jsonb,who text NOT NULL DEFAULT current_user);
    GRANT SELECT,INSERT ON public.fixture_w2_reply,public.fixture_w2_calls TO authenticated;
    GRANT USAGE ON SEQUENCE public.fixture_w2_calls_n_seq TO authenticated;`) });
});
after(async () => { await shared?.close(); });
const inCase = work => shared.isolated(work);
const code = expected => error => error.code === expected;
const sorted = values => [...values].sort();
const foundation = readFileSync(W2_FOUNDATION_PATH, 'utf8'), fixes = readFileSync(W2_FIXES_PATH, 'utf8'), invoker = readFileSync(W2_INVOKER_PATH, 'utf8');
const orgfence = readFileSync(W2_ORG_FENCE_PATH, 'utf8');
const stripComments = sql => sql.replace(/--[^\n]*/g, '');
const block = (sql, name) => {
  const found = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name.replaceAll('.', '\\.')}\\([\\s\\S]*?\\$fn\\$;`, 'g'));
  assert.ok(found, name); return found.at(-1);
};
const created = sql => [...stripComments(sql).matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+\.[a-z0-9_]+)\(/g)].map(match => match[1]);
const uid = n => `0e0e0e0e-0000-4000-8000-0000000003${String(n).padStart(2, '0')}`;

// Báo cáo thăm dò, mỗi gói một, phủ bốn kiểu phạm vi; thêm sổ quỹ (b) và nền tảng (c) khi cần.
const ID_PARAMS = ['areaId', 'roomId', 'contractId', 'invoiceId', 'customerId', 'staffId', 'cashbookId', 'supplierId', 'materialId'];
const PROBES = {
  a: ['probe_rows', { permission: 'vehicles.view', source: 'crm.probe_rows', scope: 'rows',
    params: ['query', 'buildingId', 'fromDate', 'toDate', 'status', ...ID_PARAMS], required: [], statuses: ['open', 'closed'], kinds: null, scopeKeys: ['customers.view'] }],
  b: ['probe_org', { permission: 'materials.view', source: 'crm.probe_org', scope: 'organization', params: ['query'], required: [], statuses: null, kinds: null, scopeKeys: [] }],
  c: ['probe_self', { permission: 'assistant.salary.self', source: 'crm.probe_self', scope: 'self', params: ['month'], required: ['month'], statuses: null, kinds: null, scopeKeys: [] }],
  d: ['probe_buildings', { permission: 'meters.view', source: 'crm.probe_buildings', scope: 'buildings', params: ['buildingId', 'year', 'kind'], required: [],
    statuses: null, kinds: ['electric', 'water'], scopeKeys: [] }],
};
const EXTRA = {
  b: ['probe_cash', { permission: 'cashbooks.view', source: 'crm.probe_cash', scope: 'cashbooks', params: ['cashbookId'], required: [], statuses: null, kinds: null, scopeKeys: [] }],
  c: ['probe_bank', { permission: 'assistant.bank_events.read', source: 'crm.probe_bank', scope: 'platform', params: [], required: [], statuses: null, kinds: null, scopeKeys: [] }],
};
const PROBE_KEYS = Object.values(PROBES).map(([, spec]) => spec.permission), EXTRA_KEYS = Object.values(EXTRA).map(([, spec]) => spec.permission);
const catalogSql = (letter, value) => `CREATE OR REPLACE FUNCTION app_private.hermes_w2${letter}_catalog_v1()
  RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$ SELECT '${JSON.stringify(value).replaceAll("'", "''")}'::jsonb $fn$;`;
// Hàm đọc thăm dò (INVOKER như hàm gói thật): ghi lại (gói, mã, tham số, ctx, vai) rồi trả câu trả lời cài
// sẵn hoặc một hàng nêu gói.
const readerSql = letter => `CREATE OR REPLACE FUNCTION app_private.hermes_w2${letter}_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
  RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
  DECLARE v jsonb;
  BEGIN
    INSERT INTO public.fixture_w2_calls(package,report,params,ctx) VALUES('${letter}',p_report,p_params,p_ctx);
    SELECT value INTO v FROM public.fixture_w2_reply WHERE package='${letter}';
    -- Hàng mặc định tự nêu toà (rows/buildings) và công ty (trừ self/platform) như gói thật phải làm.
    RETURN COALESCE(v,jsonb_build_object('rows',jsonb_build_array(jsonb_build_object('package','${letter}','report',p_report)
      ||CASE WHEN p_ctx->>'scope' IN ('rows','buildings') THEN jsonb_build_object('buildingId',p_ctx->'buildings'->0) ELSE '{}'::jsonb END
      ||CASE WHEN p_ctx->>'scope' NOT IN ('self','platform') THEN jsonb_build_object('organizationId',p_ctx->'organizationId') ELSE '{}'::jsonb END),
      'summary',NULL,'sourceCapped',false,'unavailable',NULL));
  END $fn$;`;
async function installProbes(db, { readers = true, catalogs = PROBES, extra = false } = {}) {
  for (const letter of ['a', 'b', 'c', 'd']) {
    const entries = [...(catalogs[letter] ? [catalogs[letter]] : []), ...(extra && EXTRA[letter] ? [EXTRA[letter]] : [])];
    await db.exec(catalogSql(letter, Object.fromEntries(entries)));
    if (readers) await db.exec(readerSql(letter));
  }
  await grantRead(db, extra ? [...PROBE_KEYS, ...EXTRA_KEYS] : PROBE_KEYS);
}
const calls = async db => (await db.query('SELECT package,report,params,ctx FROM public.fixture_w2_calls ORDER BY n')).rows;
const reply = (db, letter, value) => db.query('INSERT INTO public.fixture_w2_reply VALUES($1,$2::jsonb) ON CONFLICT(package) DO UPDATE SET value=EXCLUDED.value',
  [letter, JSON.stringify(value)]);
const rowsReply = (db, letter, rows) => reply(db, letter, { rows, summary: null, sourceCapped: false, unavailable: null });
// Hàng của báo cáo công ty phải tự nêu công ty (trường rào, cổng gỡ trước khi trả).
const orgRows = (rows, org = ORG) => rows.map(row => ({ organizationId: org, ...row }));
const params = (letter, values = {}) => ({ ...Object.fromEntries(PROBES[letter][1].params.map(name => [name, null])), ...values });
const run = (env, letter, values, extra) => env.report(PROBES[letter][0], params(letter, values), extra);
async function orgOverlay(db, on = true) {
  for (const table of ['hermes_connections', 'hermes_org_policies'])
    await db.query(on ? `UPDATE app_private.${table} SET scope_ids=array_append(scope_ids,$1::uuid)` : `UPDATE app_private.${table} SET scope_ids=array_remove(scope_ids,$1::uuid)`, [ORG_SCOPE]);
}
const crmOrgWide = (db, key, on = true) => db.query('UPDATE public.fixture_acl SET org_wide=$2 WHERE permission=$1', [key, on]);
const lastCtx = async db => (await calls(db)).at(-1).ctx;
const caps = env => env.call('SELECT public.hermes_domain_capabilities_v3($1::uuid) result', [ORG]);
// Sổ quỹ CRM theo khoá (scope CASHBOOK): fixture gốc trả '{}' — mở rộng TRONG ca.
async function crmCashbooks(db, key, ids) {
  await db.exec(`ALTER TABLE public.fixture_acl ADD COLUMN IF NOT EXISTS cashbook_ids uuid[] NOT NULL DEFAULT '{}';
    CREATE OR REPLACE FUNCTION app_private.authorized_scope_v3(p_permission text,p_org uuid) RETURNS TABLE(org_wide boolean,building_ids uuid[],cashbook_ids uuid[])
      LANGUAGE sql AS $$SELECT org_wide,building_ids,cashbook_ids FROM public.fixture_acl WHERE permission=p_permission AND allowed AND p_org='${ORG}'::uuid$$;`);
  await db.query('UPDATE public.fixture_acl SET cashbook_ids=$2 WHERE permission=$1', [key, ids]);
}

test('nền: 35 khoá đợt 2 khớp JS, seed ở trạng thái tắt; khoá self, khoá dùng lại, loại khoá và từ điển tham số khớp; chuỗi đợt 2 tìm theo dải', () => inCase(async ({ db }) => {
  const one = async (sql, args) => (await db.query(sql, args)).rows[0].v;
  assert.deepEqual(sorted(await one('SELECT app_private.hermes_w2_read_keys_v1() v')), sorted(W2_READ_KEY_LIST));
  assert.equal(W2_READ_KEY_LIST.length, 35);
  assert.deepEqual(sorted(await one('SELECT app_private.hermes_w2_self_keys_v1() v')), sorted(W2_SELF_KEYS));
  assert.deepEqual(await one('SELECT app_private.hermes_w2_reused_keys_v1() v'), [...W2_REUSED_KEYS]);
  assert.deepEqual(await one('SELECT app_private.hermes_w2_param_names_v1() v'), Object.keys(W2_PARAMS));
  for (const key of [...W2_READ_KEY_LIST, ...W2_REUSED_KEYS, 'users.view', 'customers.create', 'chat_zalo.view'])
    assert.equal(await one('SELECT app_private.hermes_w2_permission_kind_v1($1) v', [key]), w2PermissionKind(key), key);
  assert.deepEqual(['assistant.bank_events.read', 'assistant.salary.self', 'notifications.view', 'invoices.view', 'materials.view', 'cashbooks.view', 'users.view']
    .map(w2PermissionKind), ['platform', 'self', 'self', 'company', 'organization', 'organization', null]);
  // Loại organization = resource organization_scope (capability-contract), khớp SQL.
  assert.deepEqual(await one('SELECT app_private.hermes_w2_org_keys_v1() v'), [...W2_ORG_KEYS]);
  assert.equal(W2_ORG_KEYS.length, 9);
  const rows = (await db.query('SELECT capability,mode,enabled FROM app_private.hermes_capabilities WHERE capability=ANY($1) ORDER BY capability', [W2_READ_KEY_LIST])).rows;
  // Seed tắt (20261018000000); chuỗi mặc định có công tắc Gói Z (20261018090000) bật đúng W2_ENABLED_KEYS, phần còn lại giữ tắt.
  assert.deepEqual(rows, sorted(W2_READ_KEY_LIST).map(capability => ({ capability, mode: 'read', enabled: W2_ENABLED_KEYS.includes(capability) })),
    'seed tắt, công tắc Z bật khoá có báo cáo, mode read');
  assert.equal(DOMAIN_FAMILIES.v3.capabilitiesRpc, 'hermes_domain_capabilities_v3');
  assert.deepEqual(DOMAIN_FAMILIES.v3.capabilities, W2_READ_KEY_LIST);
  // Hai tool meta đi lối vào INVOKER riêng; khoá vẫn do capabilities v3 cấp.
  assert.deepEqual([domainFamily('report').readRpc, domainFamily('report_list').readRpc, DOMAIN_FAMILIES.w2.capabilitiesRpc],
    ['hermes_w2_read_v1', 'hermes_w2_read_v1', null]);
  // Nền đợt 2 + bản sửa nền sau phát hành (giờ thực, tiền tố hermes_w2_; 19/10: kiểu phạm vi rls_buildings).
  assert.deepEqual(w2MigrationPaths({ packages: [] }), [W2_FOUNDATION_PATH, W2_FIXES_PATH, W2_INVOKER_PATH, W2_ORG_FENCE_PATH,
    'supabase/migrations/20261018185339_hermes_w2_rls_buildings_scope_v1.sql',
    // B5c bước 2 (21/10): customers của v3 thêm buildingName — hàm nền nên bản kế nằm trong dải nền.
    'supabase/migrations/20261020173819_hermes_w2_customers_building_name_v1.sql',
    // R2a (21/10): v3 customers/occupancy thêm summary (+ báo cáo monthly_pnl có tổng) — cũng là bản kế của hàm nền.
    'supabase/migrations/20261021004841_hermes_w2_domain_summary_v1.sql',
    // R2c phần 2 (21/10): v3 customers đếm tình trạng hợp đồng (status_v2) — bản kế tiếp của hàm nền.
    'supabase/migrations/20261021044814_hermes_w2_customer_status_summary_v1.sql',
    // R2d (21/10): v3 customers đếm khách chưa có hợp đồng (withoutContract) — bản kế tiếp của hàm nền.
    'supabase/migrations/20261021063453_hermes_w2_customers_without_contract_v1.sql',
    // Đợt 2 trang Hợp đồng: khoá contracts.view vào tập khoá dùng lại.
    'supabase/migrations/20261022043540_hermes_w2_contracts_view_reused_v1.sql',
    // Thu chi Mốc 3 (22/10): tham số minAmount — bản kế tiếp của từ điển + bộ kiểm tham số (hàm nền).
    'supabase/migrations/20261022044126_hermes_w2_min_amount_param_v1.sql',
    // Công việc Mốc 4 (23/10): tasks.view vào tập khoá dùng lại (báo cáo tasks_board) — bản kế tiếp của hàm nền.
    'supabase/migrations/20261022180359_hermes_w2_tasks_view_reused_v1.sql',
    // Thu chi lượt 14: tham số nền maxAmount.
    'supabase/migrations/20261024120208_hermes_w2_max_amount_param_v1.sql']);
  for (const letter of ['a', 'b', 'c', 'd']) await assertPackageParity({ db }, letter);
}));

test('cấu trúc: v3 = bản 20261017033630 + hai dòng định tuyến; file sửa/INVOKER đúng tập hàm; INVOKER/DEFINER và ACL mọi hermes_w2%', () => inCase(async ({ db }) => {
  const live = block(foundation, 'public.hermes_domain_read_v3'), reviewed = block(readFileSync(FULL_READ_OWNER_PATH, 'utf8'), 'public.hermes_domain_read_v3');
  const prefix = "  -- Đợt 2 (20261018000000): hai miền meta sang cổng riêng; mọi dòng dưới giữ nguyên 20261017033630.\n" +
    "  IF p_domain IN ('report','report_list') THEN RETURN app_private.hermes_w2_gate_v1(p_binding,p_domain,p_input); END IF;\n";
  assert.equal(live.split(prefix).length, 2, 'đúng một khối định tuyến');
  assert.equal(live.replace(prefix, ''), reviewed, 'mọi dòng khác của v3 giữ nguyên');
  for (const sql of [foundation, fixes, invoker, orgfence]) {
    assert.doesNotMatch(stripComments(sql), /copilot/i);
    assert.doesNotMatch(stripComments(sql), /\bDROP\b|ALTER TABLE|UPDATE app_private\.hermes_capabilities|enabled\s*=\s*true/i);
  }
  const PUBLIC = ['public.hermes_domain_capabilities_v3', 'public.hermes_org_policy_options_v7', 'public.hermes_connection_options_v7',
    'public.hermes_connection_context_v7', 'public.hermes_domain_read_v3'];
  const PRIVATE = ['app_private.hermes_w2_read_keys_v1', 'app_private.hermes_w2_self_keys_v1', 'app_private.hermes_w2_grant_v1',
    'app_private.hermes_w2_extend_options_v1', ...['a', 'b', 'c', 'd'].map(letter => `app_private.hermes_w2${letter}_catalog_v1`),
    'app_private.hermes_w2_param_names_v1', 'app_private.hermes_w2_catalog_v1', 'app_private.hermes_w2_params_v1',
    ...['a', 'b', 'c', 'd'].map(letter => `app_private.hermes_w2${letter}_read_v1`), 'app_private.hermes_w2_gate_v1'];
  const ADDED = ['app_private.hermes_w2_reused_keys_v1', 'app_private.hermes_w2_permission_kind_v1', 'app_private.hermes_w2_org_keys_v1'];
  const READERS = ['a', 'b', 'c', 'd'].map(letter => `app_private.hermes_w2${letter}_read_v1`);
  // INVOKER: lối vào + hàm đọc của gói. authenticated gọi được: lối vào, hai bước DEFINER, hàm gói (qua OID).
  const INVOKER = ['public.hermes_w2_read_v1', ...READERS];
  const CALLER = [...INVOKER, 'app_private.hermes_w2_scope_v1', 'app_private.hermes_w2_finish_v1'];
  assert.deepEqual(sorted(created(foundation)), sorted([...PUBLIC, ...PRIVATE]), 'file nền: chỉ hàm của nền đợt 2');
  assert.deepEqual(sorted(created(fixes)), sorted(['app_private.hermes_w2_reused_keys_v1', 'app_private.hermes_w2_permission_kind_v1',
    'app_private.hermes_w2_catalog_v1', 'app_private.hermes_w2_gate_v1']), 'file sửa: cổng + bảng gom + 2 hàm mới');
  assert.deepEqual(sorted(created(invoker)), sorted([...CALLER, 'app_private.hermes_w2_gate_v1']), 'file INVOKER: lối vào, hai bước, khung gói, cổng cũ ngừng');
  assert.deepEqual(sorted(created(orgfence)), sorted(['app_private.hermes_w2_org_keys_v1', 'app_private.hermes_w2_permission_kind_v1',
    'app_private.hermes_w2_catalog_v1', 'app_private.hermes_w2_scope_v1', 'app_private.hermes_w2_finish_v1']), 'file rào công ty: đúng 5 hàm, lối vào/hàm gói không đổi');
  assert.match(block(orgfence, 'app_private.hermes_w2_scope_v1'), /ORDER BY e\.key COLLATE "C"/, 'P3: mục lục theo thứ tự byte như broker');
  const retired = block(invoker, 'app_private.hermes_w2_gate_v1');
  assert.ok(retired.includes("\nBEGIN\n  RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';\nEND $fn$;") && !/hermes_w2[a-d]?_(read|catalog|scope)_v1/.test(retired),
    'cổng DEFINER cũ chỉ còn 22023, không gọi gì');
  assert.equal((await db.query("SELECT has_schema_privilege('authenticated','app_private','USAGE') v")).rows[0].v, false, 'lớp chặn gọi thẳng giữ nguyên');
  const procs = (await db.query(`SELECT n.nspname||'.'||p.proname name,p.prosecdef definer,p.prosrc src,p.proconfig config,p.prosqlbody IS NOT NULL standard,
      has_function_privilege('authenticated',p.oid,'EXECUTE') auth,has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('service_role',p.oid,'EXECUTE') service
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=ANY($1) OR p.proname LIKE 'hermes\\_w2%'`,
  [[...PUBLIC, ...PRIVATE, ...ADDED, ...CALLER]])).rows;
  assert.ok(procs.length >= new Set([...PUBLIC, ...PRIVATE, ...ADDED, ...CALLER]).size);
  for (const proc of procs) {
    const isInvoker = INVOKER.includes(proc.name);
    assert.equal(proc.definer, !isInvoker, proc.name);
    assert.match(proc.config.join(','), isInvoker ? /^search_path=pg_catalog, ?public$/ : /^search_path=pg_catalog, ?(public, ?)?app_private$/, proc.name);
    assert.equal(proc.standard, proc.name === 'public.hermes_w2_read_v1', `${proc.name}: chỉ lối vào là thân SQL chuẩn (gắn OID)`);
    assert.doesNotMatch(stripComments(proc.src), /copilot/i, proc.name);
    // ACL theo mẫu: mọi hermes_w2% (kể cả hàm gói về sau) không vai nào khác gọi được; authenticated đúng tập.
    assert.deepEqual([proc.auth, proc.anon, proc.service], [PUBLIC.includes(proc.name) || CALLER.includes(proc.name), false, false], proc.name);
  }
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_proc WHERE proname LIKE 'copilot%'")).rows[0].n, 0, 'fixture không có hàm trợ lý cũ nào');
}));

test('hàng rào gói (P2-4): file dải gói chỉ tạo hermes_w2<gói>_* hoặc hàm public.<miền>_*_v<n> MỚI; hàm nền chỉ sống ở dải nền/Z', () => {
  assert.deepEqual(w2FenceViolations(w2AllMigrations()), [], 'repo hiện tại');
  for (const name of ['20261019034254_hermes_metadata_read_snapshot_v1.sql', '20261019040948_hermes_copied_text_parity_v1.sql']) {
    const original = w2AllMigrations();
    assert(original.some(file => file.name === name));
    for (const change of [file => ({ ...file, sql: file.sql + '\n-- changed source\n' }),
      file => ({ ...file, name: '20261020000000_unreviewed_successor.sql' })]) {
      assert(w2FenceViolations(original.map(file => file.name === name ? change(file) : file)).length > 0,
        'reviewed successor remains filename and byte bound');
    }
  }
  const base = w2AllMigrations().filter(({ name }) => name < '20261018010000');
  const fn = name => `CREATE OR REPLACE FUNCTION ${name}(p jsonb) RETURNS jsonb LANGUAGE sql AS $fn$ SELECT p $fn$;`;
  const check = (...extra) => w2FenceViolations([...base, ...extra]);
  assert.deepEqual(check({ name: '20261018010000_hermes_w2a_x_v1.sql', sql: fn('app_private.hermes_w2a_read_v1') + fn('app_private.hermes_w2a_helper_v1') +
    fn('public.hermes_w2a_probe_v1') + fn('public.receivable_aging_v1') }), [], 'gói A: hàm của mình + hàm dùng chung mới');
  assert.deepEqual(check({ name: '20261018090000_hermes_w2_enable_v1.sql', sql: fn('app_private.hermes_w2_gate_v1') }), [], 'Z được thay hàm nền');
  for (const [sql, label] of [[fn('app_private.hermes_w2b_read_v1'), 'hàm gói khác'], [fn('app_private.hermes_w2_gate_v1'), 'cổng nền'],
    [fn('public.hermes_domain_read_v3'), 'v3'], [fn('app_private.hermes_report_read_v2'), 'hàm hermes đợt 1'], [fn('public.occupancy_snapshot_v2'), 'hàm CRM đã có'],
    [fn('app_private.some_helper'), 'helper ngoài tiền tố'], [fn('public.hermes_new_v1'), 'hermes_ khác']])
    assert.ok(check({ name: '20261018010000_hermes_w2a_x_v1.sql', sql }).length > 0, label);
  assert.ok(check({ name: '20261018020000_hermes_w2b_x_v1.sql', sql: fn('public.shared_v1') }, { name: '20261018030000_hermes_w2c_x_v1.sql', sql: fn('public.shared_v1') })
    .length > 0, 'hai gói cùng tạo một hàm dùng chung');
  assert.deepEqual(check({ name: '20261018030000_hermes_w2c_x_v1.sql', sql: '-- CREATE OR REPLACE FUNCTION app_private.hermes_w2_gate_v1(\n' }), [], 'chú thích không tính');
  // Mở rộng sau review cổng INVOKER: tên trong ngoặc kép, ALTER FUNCTION, DO … EXECUTE, tên thiếu schema.
  const A = '20261018010000_hermes_w2a_x_v1.sql';
  for (const [sql, label] of [['CREATE OR REPLACE FUNCTION "app_private"."hermes_w2_scope_v1"(p jsonb) RETURNS jsonb LANGUAGE sql AS $fn$ SELECT p $fn$;', 'ngoặc kép'],
    ['CREATE FUNCTION app_private . hermes_w2_finish_v1 (p jsonb) RETURNS jsonb LANGUAGE sql AS $fn$ SELECT p $fn$;', 'khoảng trắng quanh dấu chấm'],
    ['ALTER FUNCTION app_private.hermes_w2_scope_v1(jsonb,text,jsonb,text) SECURITY INVOKER;', 'ALTER hàm nền'],
    ['ALTER FUNCTION app_private.hermes_w2a_read_v1(text,jsonb,jsonb) SECURITY DEFINER;', 'ALTER hàm gói ngoài OWNER'],
    ['ALTER ROUTINE "public"."hermes_w2_read_v1"(jsonb,text,jsonb) RENAME TO x;', 'ALTER ROUTINE ngoặc kép'],
    ["DO $x$ BEGIN EXECUTE 'CREATE OR REPLACE FUNCTION app_private.hermes_w2_' || 'gate_v1() RETURNS int LANGUAGE sql AS ''SELECT 1'''; END $x$;", 'DO … EXECUTE'],
    ['CREATE OR REPLACE FUNCTION hermes_w2a_helper_v1(p jsonb) RETURNS jsonb LANGUAGE sql AS $fn$ SELECT p $fn$;', 'thiếu schema']])
    assert.ok(check({ name: A, sql }).length > 0, label);
  assert.deepEqual(check({ name: A, sql: fn('app_private.hermes_w2a_read_v1') + 'ALTER FUNCTION app_private.hermes_w2a_read_v1(text,jsonb,jsonb) OWNER TO postgres;' +
    'DO $requires$ BEGIN IF to_regprocedure(\'app_private.hermes_w2_scope_v1(jsonb,text,jsonb,text)\') IS NULL THEN RAISE EXCEPTION \'x\'; END IF; END $requires$;' }),
  [], 'ALTER OWNER hàm của gói, DO không EXECUTE: được');
  assert.deepEqual(check({ name: A, sql: fn('public.receivable_aging_v1') }, { name: '20261018010100_hermes_w2a_review_fixes_v1.sql', sql: fn('public.receivable_aging_v1') }),
    [], 'sửa sau review trong cùng dải gói được thay hàm dùng chung của mình');
});

// Định nghĩa SỐNG (catalog PGlite sau MỌI migration đợt 2 có trong repo, kể cả của gói) của từng hàm nền phải
// trùng bản định nghĩa cuối ở dải nền: chạy lại đúng câu đó trong ca phải không đổi gì — bắt cả thay đổi
// bằng SQL động / ALTER mà regex hàng rào không thấy.
test('hàng rào gói (catalog): định nghĩa sống của hàm nền = bản cuối ở dải nền', () => inCase(async ({ db }) => {
  const sources = w2AllMigrations().filter(({ name }) => W2_RANGES.foundation.test(name));
  // Câu CREATE kết thúc ở "$fn$;" (plpgsql/sql) hoặc "\nEND;" (thân SQL chuẩn), cái nào tới trước.
  const statement = (sql, fn) => {
    const start = sql.lastIndexOf(`CREATE OR REPLACE FUNCTION ${fn}(`);
    if (start < 0) return null;
    const [at, mark] = [[sql.indexOf('$fn$;', start), '$fn$;'], [sql.indexOf('\nEND;', start), '\nEND;']].filter(([index]) => index >= 0)
      .sort((x, y) => x[0] - y[0])[0];
    return sql.slice(start, at + mark.length);
  };
  const live = async fn => (await db.query(`SELECT pg_get_functiondef(p.oid) def,p.proowner::regrole::text owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname||'.'||p.proname=$1`, [fn])).rows;
  for (const fn of W2_FOUNDATION_FUNCTIONS) {
    const last = [...sources].reverse().map(({ sql }) => statement(sql, fn)).find(Boolean);
    assert.ok(last, `nguồn ${fn}`);
    const before = await live(fn);
    assert.equal(before.length, 1, `${fn}: đúng một hàm`);
    await db.exec(last);
    assert.deepEqual(await live(fn), before, `${fn}: định nghĩa sống = bản cuối ở dải nền`);
  }
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

test('khung rỗng: mục lục trống, mã lạ 22023, hàm đọc của nền trả not_implemented qua đúng gói, phong bì có fence', () => inCase(async env => {
  const { db } = env;
  await grantRead(db, PROBE_KEYS);
  // Chính thân khung của nền (bản INVOKER; gói có thể đã thay thân thật sau này).
  for (const letter of ['a', 'b', 'c', 'd']) await db.exec(block(invoker, `app_private.hermes_w2${letter}_read_v1`));
  for (const letter of ['a', 'b', 'c', 'd']) await db.exec(block(foundation, `app_private.hermes_w2${letter}_catalog_v1`));
  assert.deepEqual((await env.reportList()).items, []);
  await assert.rejects(env.report('nope'), code('22023'));
  await installProbes(db, { readers: false });
  await orgOverlay(db); await crmOrgWide(db, 'materials.view');
  for (const letter of ['a', 'b', 'c', 'd']) {
    const value = await run(env, letter, letter === 'c' ? { month: '2026-09' } : {});
    assert.deepEqual([value.report, value.source, value.unavailable, value.items, value.summary, value.nextOffset, value.sourceCapped],
      [PROBES[letter][0], PROBES[letter][1].source, 'not_implemented', [], null, null, false], letter);
    assert.deepEqual(Object.keys(value).sort(), sorted(['organizationId', 'domain', 'fetchedAt', 'report', 'source', 'unavailable', 'summary', 'items', 'offset',
      'nextOffset', 'sourceCapped', 'fence']));
  }
}));

test('định tuyến: mỗi mã sang đúng hàm của gói với ctx do cổng dựng (toà = CRM ∩ overlay, khoá phụ, sổ quỹ, hôm nay) và fence khớp ctx', () => inCase(async env => {
  const { db } = env;
  await installProbes(db);
  const rows = await run(env, 'a');
  assert.deepEqual(rows.items, [{ package: 'a', report: 'probe_rows', buildingId: BUILDING }], 'organizationId (trường rào) đã gỡ');
  assert.deepEqual([rows.source, rows.organizationId, rows.domain], ['crm.probe_rows', ORG, 'report']);
  assert.deepEqual(rows.fence, { buildings: [BUILDING], cashbooks: [], orgWide: false });
  const [call] = await calls(db);
  assert.deepEqual([call.package, call.report, call.params], ['a', 'probe_rows', params('a')]);
  assert.deepEqual((await db.query('SELECT DISTINCT who FROM public.fixture_w2_calls')).rows, [{ who: 'authenticated' }], 'hàm gói chạy dưới vai người hỏi');
  assert.deepEqual(call.ctx, { organizationId: ORG, userId: USER, report: 'probe_rows', permission: 'vehicles.view', scope: 'rows',
    buildings: [BUILDING], requestedBuildingId: null, overlayOrg: false, orgWide: false, isSuperadmin: false, today: '2026-10-16',
    scopes: { 'customers.view': [BUILDING] }, cashbooks: [] }, 'CRM A+B ∩ overlay A; khoá phụ cùng cách tính');
  assert.deepEqual((await run(env, 'd', { kind: 'water' })).items, [{ package: 'd', report: 'probe_buildings', buildingId: BUILDING }]);
  const self = await run(env, 'c', { month: '2026-09' });
  assert.deepEqual([self.items, self.fence], [[{ package: 'c', report: 'probe_self' }], { buildings: [], cashbooks: [], orgWide: false }]);
  assert.deepEqual((await lastCtx(db)).buildings, [], 'self: không toà, vẫn đọc');
  assert.equal((await run(env, 'b')).unavailable, 'organization_scope_required', 'organization cần org_wide');
  assert.deepEqual((await calls(db)).map(row => row.package), ['a', 'd', 'c'], 'không gọi gói khi chưa đủ phạm vi');
  await orgOverlay(db); await crmOrgWide(db, 'materials.view');
  const org = await run(env, 'b');
  assert.deepEqual([org.items, org.fence], [[{ package: 'b', report: 'probe_org' }], { buildings: [], cashbooks: [], orgWide: true }]);
  assert.deepEqual([(await lastCtx(db)).overlayOrg, (await lastCtx(db)).orgWide], [true, true]);
  await crmOrgWide(db, 'vehicles.view');
  assert.deepEqual((await run(env, 'a')).fence, { buildings: sorted([BUILDING, OTHER_BUILDING]), cashbooks: [], orgWide: true });
  assert.deepEqual([(await lastCtx(db)).orgWide, (await lastCtx(db)).buildings], [true, sorted([BUILDING, OTHER_BUILDING])]);
  // Đợt 1 vẫn chạy qua v3 mới.
  assert.ok((await env.read3('customers', { query: '', limit: 5, cursor: null, buildingId: null, status: null })).items.length > 0);
}));

// Gọi lối vào với claims authenticated nhưng current_user là chủ hàm (như từ một hàm DEFINER) — SAVEPOINT
// để lỗi không làm hỏng giao dịch của ca.
async function asOwner(db, sql, args) {
  await db.exec('SAVEPOINT owner_call');
  try {
    await db.query(`SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true),
      set_config('request.jwt.claim.session',$2,true)`, [USER, SESSION]);
    const result = (await db.query(sql, args)).rows[0].result;
    await db.exec('RELEASE SAVEPOINT owner_call'); return result;
  } catch (error) { await db.exec('ROLLBACK TO SAVEPOINT owner_call; RELEASE SAVEPOINT owner_call'); throw error; }
}
const ENTRY = 'SELECT public.hermes_w2_read_v1($1::jsonb,$2::text,$3::jsonb) result';
const entryArgs = (domain = 'report', input = { report: 'probe_rows', params: params('a'), limit: 20, offset: 0 }) =>
  [JSON.stringify(binding), domain, JSON.stringify(input)];
const FINISH = 'SELECT app_private.hermes_w2_finish_v1($1::jsonb,$2::jsonb,$3::jsonb) result';
const finishPlan = (extra = {}) => ({ domain: 'report', connectionId: binding.connectionId, organizationId: ORG, report: 'probe_rows', source: 'crm.probe_rows', scope: 'rows',
  limit: 20, offset: 0, unavailable: null, fence: { buildings: [BUILDING], cashbooks: [], orgWide: false }, package: 'a', params: {}, ctx: {}, ...extra });
const EMPTY = { rows: [], summary: null, sourceCapped: false, unavailable: null };

test('INVOKER + RLS: hàm gói đọc dưới RLS của người hỏi; vai chủ hàm, gọi thẳng app_private, anon, v3/cổng cũ ⇒ từ chối; adapter gọi lối vào mới', { timeout: 60000 }, () => inCase(async env => {
  const { db } = env;
  await installProbes(db);
  // Bảng có RLS: mỗi người chỉ thấy hàng của mình; hàm gói INVOKER đọc bảng đó.
  await db.exec(`CREATE TABLE public.fixture_w2_rls(n int PRIMARY KEY,owner uuid NOT NULL);
    ALTER TABLE public.fixture_w2_rls ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_w2_rls_own ON public.fixture_w2_rls FOR SELECT TO authenticated USING (owner=auth.uid());
    GRANT SELECT ON public.fixture_w2_rls TO authenticated;
    INSERT INTO public.fixture_w2_rls VALUES(1,'${USER}'),(2,'${FOREIGN}'),(3,'${USER}');
    CREATE OR REPLACE FUNCTION app_private.hermes_w2a_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
      RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
      BEGIN RETURN jsonb_build_object('rows',(SELECT COALESCE(jsonb_agg(jsonb_build_object('n',n,'buildingId',p_ctx->'buildings'->0,
        'organizationId',p_ctx->'organizationId') ORDER BY n),'[]'::jsonb) FROM public.fixture_w2_rls),
        'summary',NULL,'sourceCapped',false,'unavailable',NULL); END $fn$;`);
  assert.deepEqual((await run(env, 'a')).items, [{ n: 1, buildingId: BUILDING }, { n: 3, buildingId: BUILDING }], 'RLS của người hỏi: không thấy hàng người khác');
  // Gọi THẲNG hàm gói / bước kết thúc dưới vai authenticated (như PostgREST): không tới được (42501).
  for (const sql of ['SELECT app_private.hermes_w2a_read_v1($1,$2::jsonb,$3::jsonb) result', 'SELECT app_private.hermes_w2_finish_v1($1::jsonb,$2::jsonb,$3::jsonb) result'])
    await assert.rejects(env.call(sql, sql.includes('finish') ? [JSON.stringify(binding), JSON.stringify(finishPlan()), JSON.stringify(EMPTY)]
      : ['probe_rows', JSON.stringify(params('a')), '{}']), code('42501'), sql);
  await assert.rejects(asOwner(db, ENTRY, entryArgs()), code('42501'), 'vai chủ hàm (bỏ qua RLS) ⇒ từ chối trước khi gọi gói');
  // authenticated không gọi thẳng bước nào trong app_private (không USAGE); anon không gọi được lối vào.
  await assert.rejects(env.call(`SELECT app_private.hermes_w2_scope_v1($1::jsonb,'report',$2::jsonb,'authenticated') result`,
    [JSON.stringify(binding), entryArgs()[2]]), /permission denied for schema app_private/);
  await assert.rejects(env.call(ENTRY, entryArgs(), { role: 'anon' }), /permission denied for function hermes_w2_read_v1/);
  // Luật cho gói: thân plpgsql INVOKER gọi app_private.* theo tên ⇒ 42501.
  await db.exec(`CREATE OR REPLACE FUNCTION app_private.hermes_w2d_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
    RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
    BEGIN PERFORM app_private.hermes_w2_param_names_v1(); RETURN NULL; END $fn$;`);
  await assert.rejects(run(env, 'd'), /permission denied for schema app_private/);
  // v3 và cổng DEFINER cũ không còn đường tới hàm gói.
  await assert.rejects(env.read3('report', JSON.parse(entryArgs()[2])), code('22023'));
  await assert.rejects(env.read3('report_list', { topic: null }), code('22023'));
  // Bước kết thúc: đúng kết nối bước 1; không nhận kết quả gói khi bước 1 đã báo thiếu phạm vi.
  assert.deepEqual((await asOwner(db, FINISH, [JSON.stringify(binding), JSON.stringify(finishPlan()), JSON.stringify(EMPTY)])).items, []);
  await assert.rejects(asOwner(db, FINISH, [JSON.stringify(binding), JSON.stringify(finishPlan({ connectionId: uid(77) })), JSON.stringify(EMPTY)]),
    code('42501'), 'kết nối khác bước 1');
  await assert.rejects(asOwner(db, FINISH, [JSON.stringify(binding), JSON.stringify(finishPlan({ organizationId: FOREIGN })), JSON.stringify(EMPTY)]),
    code('42501'), 'công ty khác bước 1');
  await assert.rejects(asOwner(db, FINISH, [JSON.stringify(binding), JSON.stringify(finishPlan({ unavailable: 'no_building_scope', package: null })),
    JSON.stringify(EMPTY)]), code('XX000'), 'bước 1 báo thiếu phạm vi mà vẫn có kết quả gói');
  // Broker: adapter gọi đúng RPC lối vào mới (mục lục, vì sổ JS sản phẩm chưa có báo cáo).
  const seen = [];
  const fetch = async (url, options) => {
    const name = new URL(url).pathname.replace('/rest/v1/rpc/', ''), body = JSON.parse(options.body); seen.push(name);
    try { return Response.json(await env.call(`SELECT public.${name}($1::jsonb,$2::text,$3::jsonb) result`,
      [JSON.stringify(body.p_binding), body.p_domain, JSON.stringify(body.p_input)])); }
    catch (error) { return Response.json({ code: error.code, message: error.message, details: null, hint: null }, { status: 400 }); }
  };
  const scope = createDependencyScope();
  try {
    const reads = createSupabaseDomainReads({ url: 'https://example.invalid/', publishableKey: 'sb_publishable_test', fetch, dependencyScope: scope });
    const accessToken = ['header', Buffer.from(JSON.stringify({ role: 'authenticated', sub: USER, session_id: SESSION })).toString('base64url'), 'signature'].join('.');
    const listed = await reads.execute('report_list', { accessToken, binding, input: {} }, { signal: new AbortController().signal });
    assert.deepEqual([seen, listed.domain, listed.items.map(row => row.report)], [['hermes_w2_read_v1'], 'report_list', sorted(Object.values(PROBES).map(([report]) => report))]);
  } finally { await scope.close(); }
}));

test('quyền: thiếu lớp nào ⇒ 42501; mục lục chỉ báo cáo còn đủ lớp; token người khác, kết nối thu hồi, phiên đổi, JWT lệch phiên ⇒ từ chối', () => inCase(async env => {
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
  await assert.rejects(env.report('probe_rows', params('a'), {}, binding, { session: uid(90) }), code('42501'), 'JWT của phiên khác');
  await assert.rejects(env.reportList(null, binding, { session: uid(90) }), code('42501'));
  await db.exec('UPDATE app_private.hermes_sessions SET revision=revision+1');
  await assert.rejects(run(env, 'a'), code('PT409'), 'phiên đổi revision (đăng nhập lại/thu hồi phiên)');
  await db.exec('UPDATE app_private.hermes_sessions SET revision=revision-1');
  assert.equal((await run(env, 'a')).items.length, 1);
  await db.exec("UPDATE app_private.hermes_connections SET state='REVOKED',revoked_at=clock_timestamp()");
  await assert.rejects(run(env, 'a'), code('42501'), 'kết nối bị thu hồi');
  await assert.rejects(env.reportList(), code('42501'));
}));

test('phạm vi toà: buildingId thu hẹp và phải nằm trong CRM ∩ overlay; hết toà ⇒ no_building_scope, không gọi gói', () => inCase(async env => {
  const { db } = env;
  await installProbes(db);
  await assert.rejects(run(env, 'a', { buildingId: OTHER_BUILDING }), code('42501'), 'toà B ngoài overlay');
  const narrowed = await run(env, 'a', { buildingId: BUILDING });
  assert.deepEqual([(await lastCtx(db)).buildings, (await lastCtx(db)).requestedBuildingId, narrowed.fence.buildings], [[BUILDING], BUILDING, [BUILDING]]);
  await db.exec(`UPDATE public.fixture_acl SET building_ids=ARRAY['${OTHER_BUILDING}'::uuid] WHERE permission IN ('vehicles.view','meters.view')`);
  const before = (await calls(db)).length;
  for (const letter of ['a', 'd']) assert.equal((await run(env, letter)).unavailable, 'no_building_scope', letter);
  assert.equal((await calls(db)).length, before, 'không gọi gói khi không còn toà');
  assert.equal((await run(env, 'c', { month: '2026-09' })).unavailable, null, 'self không phụ thuộc toà');
  await assert.rejects(env.report('probe_org', { query: null, buildingId: null }), code('22023'), 'organization không nhận buildingId');
}));

test('tham số ID (P2-2b): cổng giải về công ty/toà TRƯỚC khi gọi gói; ngoài công ty hoặc ngoài toà ⇒ 42501, trong ⇒ thu hẹp ctx.buildings', () => inCase(async env => {
  const { db } = env;
  await installProbes(db);
  const AREA_A = uid(1), AREA_B = uid(2), AREA_F = uid(3), FOREIGN_CASHBOOK_ORG = uid(4), STRANGER = uid(5);
  const SUPPLIER = uid(10), SUPPLIER_F = uid(11), MATERIAL = uid(12), MATERIAL_DELETED = uid(13);
  await db.exec(`INSERT INTO public.areas VALUES('${AREA_A}','${ORG}','Khu A',null),('${AREA_B}','${ORG}','Khu B',null),('${AREA_F}','${FOREIGN}','Khu ngoài',null);
    INSERT INTO public.area_buildings VALUES('${ORG}','${AREA_A}','${BUILDING}'),('${ORG}','${AREA_B}','${OTHER_BUILDING}');
    INSERT INTO public.accounts VALUES('${FOREIGN_CASHBOOK_ORG}','${FOREIGN}','${USER}','Quỹ công ty khác','1',false,null);
    CREATE TABLE public.suppliers(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
    CREATE TABLE public.materials(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
    INSERT INTO public.suppliers VALUES('${SUPPLIER}','${ORG}',null),('${SUPPLIER_F}','${FOREIGN}',null);
    INSERT INTO public.materials VALUES('${MATERIAL}','${ORG}',null),('${MATERIAL_DELETED}','${ORG}',clock_timestamp());`);
  const before = async () => (await calls(db)).length;
  for (const [values, label] of [[{ roomId: OTHER_ROOM }, 'phòng toà B (ngoài overlay)'], [{ roomId: FOREIGN_ROOM }, 'phòng công ty khác'],
    [{ roomId: uid(9) }, 'phòng không tồn tại'], [{ contractId: CONTRACT_B }, 'hợp đồng toà B'], [{ invoiceId: INVOICE_B }, 'hoá đơn toà B'],
    [{ areaId: AREA_B }, 'khu chỉ có toà B'], [{ areaId: AREA_F }, 'khu công ty khác'], [{ customerId: CUSTOMER_F }, 'khách công ty khác'],
    [{ staffId: STRANGER }, 'không phải thành viên'], [{ cashbookId: FOREIGN_CASHBOOK_ORG }, 'sổ quỹ công ty khác'],
    [{ supplierId: SUPPLIER_F }, 'nhà cung cấp công ty khác'], [{ materialId: MATERIAL_DELETED }, 'vật tư đã xoá'],
    [{ buildingId: BUILDING, roomId: OTHER_ROOM }, 'toà hỏi A nhưng phòng ở B']]) {
    const count = await before();
    await assert.rejects(run(env, 'a', values), code('42501'), label);
    assert.equal(await before(), count, `${label}: không gọi gói`);
  }
  for (const [values, buildings] of [[{ roomId: ROOM }, [BUILDING]], [{ contractId: CONTRACT_A }, [BUILDING]], [{ invoiceId: INVOICE_A }, [BUILDING]],
    [{ areaId: AREA_A }, [BUILDING]], [{ customerId: CUSTOMER_A }, [BUILDING]], [{ staffId: USER }, [BUILDING]], [{ cashbookId: CASHBOOK }, [BUILDING]],
    [{ supplierId: SUPPLIER }, [BUILDING]], [{ materialId: MATERIAL }, [BUILDING]]]) {
    await run(env, 'a', values);
    assert.deepEqual((await lastCtx(db)).buildings, buildings, JSON.stringify(values));
  }
  await orgOverlay(db); await crmOrgWide(db, 'vehicles.view');
  await run(env, 'a', { roomId: OTHER_ROOM });
  assert.deepEqual([(await lastCtx(db)).buildings, (await lastCtx(db)).orgWide], [[OTHER_BUILDING], false], 'toàn công ty: phòng B được, thu hẹp về B');
  await db.exec(`UPDATE public.customers SET user_id='${STRANGER}' WHERE id='${CUSTOMER_A}'`);
  await assert.rejects(run(env, 'a', { customerId: CUSTOMER_A }), code('42501'), 'chủ hồ sơ khách không còn nhìn thấy');
}));

test('rào đầu ra (P2-2a): hàng nêu toà ngoài ctx.buildings, null khi không org_wide, mảng buildingIds lẫn toà ngoài, báo cáo không theo toà nêu toà ⇒ 42501', () => inCase(async env => {
  const { db } = env;
  await installProbes(db);
  for (const rows of [[{ buildingId: OTHER_BUILDING }], [{ buildingId: null }], [{ buildingId: 'not-a-uuid' }], [{ buildingId: 7 }],
    [{ buildingId: BUILDING, buildingIds: [BUILDING, OTHER_BUILDING] }], [{ buildingId: BUILDING, buildingIds: BUILDING }],
    [{ buildingId: BUILDING, buildingIds: [null] }]]) {
    await rowsReply(db, 'a', orgRows(rows));
    await assert.rejects(run(env, 'a'), code('42501'), JSON.stringify(rows));
  }
  for (const rows of [[{ buildingId: BUILDING }], [{ buildingId: BUILDING, buildingIds: [BUILDING] }], [{ buildingId: BUILDING, buildingIds: [] }],
    [{ buildingId: BUILDING, total: 1 }]]) {
    await rowsReply(db, 'a', orgRows(rows));
    assert.deepEqual((await run(env, 'a')).items, rows, `${JSON.stringify(rows)}: organizationId đã gỡ`);
  }
  // (P2-a) Theo toà: mọi hàng nêu toà; báo cáo công ty: mọi hàng nêu công ty — thiếu ⇒ khuôn sai (XX000).
  for (const rows of [orgRows([{ total: 1 }]), orgRows([{ buildingIds: [BUILDING] }]), [{ buildingId: BUILDING }]]) {
    await rowsReply(db, 'a', rows);
    await assert.rejects(run(env, 'a'), code('XX000'), `thiếu trường rào: ${JSON.stringify(rows)}`);
  }
  await rowsReply(db, 'a', orgRows([{ buildingId: BUILDING }]));
  await assert.rejects(run(env, 'a', { roomId: OTHER_ROOM }), code('42501'), 'thu hẹp xong vẫn rào');
  await orgOverlay(db); await crmOrgWide(db, 'vehicles.view');
  for (const rows of [[{ buildingId: null }], [{ buildingId: OTHER_BUILDING }]]) {
    await rowsReply(db, 'a', orgRows(rows));
    assert.deepEqual((await run(env, 'a')).items, rows, `org_wide: ${JSON.stringify(rows)}`);
  }
  await rowsReply(db, 'a', orgRows([{ buildingId: null }]));
  await assert.rejects(run(env, 'a', { buildingId: BUILDING }), code('42501'), 'đã thu hẹp toà ⇒ hết org_wide ⇒ null bị chặn');
  await crmOrgWide(db, 'materials.view');
  for (const [letter, values, rows] of [['b', {}, orgRows([{ buildingId: BUILDING }])], ['b', {}, orgRows([{ buildingIds: [] }])],
    ['c', { month: '2026-09' }, [{ buildingId: BUILDING }]]]) {
    await rowsReply(db, letter, rows);
    await assert.rejects(run(env, letter, values), code('42501'), `${letter}: báo cáo không theo toà nêu toà`);
  }
}));

// RLS kiểu web (thành viên công ty qua my_org_ids, super admin thấy tất cả) RỘNG hơn công ty của kết nối: hàm
// gói INVOKER "quên" lọc công ty phải bị cổng chặn (42501), lọc đúng thì qua.
const W2_ORG_TABLE = `CREATE TABLE public.fixture_w2_org_rows(n int PRIMARY KEY,org uuid NOT NULL,building uuid);
  ALTER TABLE public.fixture_w2_org_rows ENABLE ROW LEVEL SECURITY;
  CREATE OR REPLACE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
    SELECT COALESCE(array_agg(m.organization_id ORDER BY m.organization_id),'{}'::uuid[]) FROM public.organization_memberships m
    WHERE m.user_id=auth.uid() AND m.status='ACTIVE' AND m.revoked_at IS NULL$$;
  CREATE FUNCTION public.fixture_is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
    SELECT EXISTS(SELECT 1 FROM public.super_admins s WHERE s.user_id=auth.uid())$$;
  CREATE POLICY fixture_w2_org_rows_web ON public.fixture_w2_org_rows FOR SELECT TO authenticated
    USING (org=ANY(public.my_org_ids()) OR public.fixture_is_super_admin());
  GRANT SELECT ON public.fixture_w2_org_rows TO authenticated;`;
// filter: biểu thức SQL thêm vào WHERE của hàm gói ('true' = quên lọc công ty).
const orgReader = (letter, filter, building) => `CREATE OR REPLACE FUNCTION app_private.hermes_w2${letter}_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
  RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
  BEGIN RETURN jsonb_build_object('rows',(SELECT COALESCE(jsonb_agg(jsonb_build_object('n',n,'organizationId',org)${building ? "||jsonb_build_object('buildingId',building)" : ''}
    ORDER BY n),'[]'::jsonb) FROM public.fixture_w2_org_rows WHERE ${filter}),'summary',NULL,'sourceCapped',false,'unavailable',NULL); END $fn$;`;
test('công ty (P2-a): RLS super admin / RLS web phủ công ty khác rộng hơn kết nối; hàm gói quên lọc công ty ⇒ 42501, lọc đúng ⇒ chỉ công ty kết nối', () => inCase(async env => {
  const { db } = env;
  await installProbes(db);
  await orgOverlay(db); await crmOrgWide(db, 'materials.view'); await crmOrgWide(db, 'vehicles.view');
  await db.exec(W2_ORG_TABLE);
  await db.exec(`INSERT INTO public.fixture_w2_org_rows VALUES(1,'${ORG}','${BUILDING}'),(2,'${FOREIGN}',null),(3,'${ORG}','${OTHER_BUILDING}'),(4,'${FOREIGN}','${BUILDING}')`);
  const visible = async () => (await env.call('SELECT (SELECT array_agg(n ORDER BY n) FROM public.fixture_w2_org_rows) result', [])) ?? [];
  assert.deepEqual(await visible(), [1, 3], 'RLS: chỉ công ty là thành viên');
  // Người thường là thành viên ACTIVE của hai công ty: Hermes từ chối cả lượt trước khi gọi gói.
  await db.exec('SAVEPOINT two_orgs');
  await db.exec(`INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${uid(60)}','${USER}','${FOREIGN}','ACTIVE')`);
  await assert.rejects(run(env, 'b'), error => error.code === '42501' && /hermes_ordinary_org_ambiguous/.test(error.message), 'người thường hai công ty');
  await db.exec('ROLLBACK TO SAVEPOINT two_orgs; RELEASE SAVEPOINT two_orgs');
  // RLS rộng hơn kết nối: super admin (là thành viên vẫn một công ty), hoặc RLS web phủ công ty khác (my_org_ids).
  for (const [label, widen] of [['RLS web phủ công ty khác', `CREATE OR REPLACE FUNCTION public.my_org_ids() RETURNS uuid[] LANGUAGE sql STABLE
      SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT ARRAY['${ORG}','${FOREIGN}']::uuid[]$$`],
    ['super admin', `INSERT INTO public.super_admins VALUES('${USER}')`]]) {
    await db.exec('SAVEPOINT widen');
    await db.exec(widen);
    assert.deepEqual(await visible(), [1, 2, 3, 4], `${label}: RLS thấy cả công ty khác`);
    // organization (vật tư): hàng không gắn toà — chỉ cột công ty phân biệt được.
    await db.exec(orgReader('b', 'true', false));
    await assert.rejects(run(env, 'b'), code('42501'), `${label}: quên lọc công ty (organization)`);
    // rows: toà null ở công ty khác lọt rào toà khi org_wide — rào công ty chặn.
    await db.exec(orgReader('a', 'building IS NULL OR building IS NOT NULL', true));
    await assert.rejects(run(env, 'a'), code('42501'), `${label}: quên lọc công ty (rows)`);
    await db.exec(orgReader('b', "org=(p_ctx->>'organizationId')::uuid", false));
    assert.deepEqual((await run(env, 'b')).items, [{ n: 1 }, { n: 3 }], `${label}: lọc đúng ⇒ chỉ công ty kết nối, organizationId đã gỡ`);
    await db.exec(orgReader('a', "org=(p_ctx->>'organizationId')::uuid", true));
    assert.deepEqual((await run(env, 'a')).items, [{ n: 1, buildingId: BUILDING }, { n: 3, buildingId: OTHER_BUILDING }], `${label}: rows lọc đúng`);
    await db.exec('ROLLBACK TO SAVEPOINT widen; RELEASE SAVEPOINT widen');
  }
}));

test('org_wide, sổ quỹ, nền tảng (P2-3): organization đòi CRM toàn công ty ∩ overlay; cashbooks theo sổ CRM; platform chỉ super admin', () => inCase(async env => {
  const { db } = env;
  await installProbes(db, { extra: true });
  await crmOrgWide(db, 'materials.view');
  assert.equal((await run(env, 'b')).unavailable, 'organization_scope_required', 'CRM toàn công ty nhưng overlay chỉ toà A');
  await crmOrgWide(db, 'materials.view', false); await orgOverlay(db);
  assert.equal((await run(env, 'b')).unavailable, 'organization_scope_required', 'overlay Toàn tổ chức nhưng CRM chỉ theo toà');
  await crmOrgWide(db, 'materials.view');
  assert.equal((await run(env, 'b')).items.length, 1, 'đủ cả hai');
  // cashbooks: overlay Toàn tổ chức + sổ CRM cấp (scope CASHBOOK) — không org_wide.
  const cash = (values = {}) => env.report('probe_cash', { cashbookId: null, ...values });
  assert.equal((await cash()).unavailable, 'organization_scope_required', 'không sổ nào được cấp');
  await crmCashbooks(db, 'cashbooks.view', [CASHBOOK]);
  const allowed = await cash();
  assert.deepEqual([allowed.unavailable, allowed.fence, (await lastCtx(db)).cashbooks], [null, { buildings: [], cashbooks: [CASHBOOK], orgWide: false }, [CASHBOOK]]);
  await assert.rejects(cash({ cashbookId: uid(7) }), code('42501'), 'sổ không tồn tại');
  await db.exec(`INSERT INTO public.accounts VALUES('${uid(8)}','${ORG}','${USER}','Quỹ khác','2',false,null)`);
  await assert.rejects(cash({ cashbookId: uid(8) }), code('42501'), 'sổ cùng công ty nhưng không được cấp');
  await cash({ cashbookId: CASHBOOK });
  assert.deepEqual((await lastCtx(db)).cashbooks, [CASHBOOK]);
  for (const rows of [[{ cashbookId: uid(8) }], [{ cashbookId: null }]]) {
    await rowsReply(db, 'b', orgRows(rows));
    await assert.rejects(cash(), code('42501'), `sổ ngoài phạm vi: ${JSON.stringify(rows)}`);
  }
  await rowsReply(db, 'b', orgRows([{ cashbookId: CASHBOOK }]));
  assert.deepEqual((await cash()).items, [{ cashbookId: CASHBOOK }]);
  await orgOverlay(db, false);
  assert.equal((await cash()).unavailable, 'organization_scope_required', 'sổ CRM nhưng kết nối không chọn Toàn tổ chức');
  await orgOverlay(db); await crmOrgWide(db, 'cashbooks.view'); await rowsReply(db, 'b', orgRows([{ cashbookId: uid(8) }]));
  assert.deepEqual((await cash()).fence.orgWide, true, 'CRM toàn công ty: mọi sổ của công ty');
  // platform: biến động số dư toàn nền tảng, chỉ super admin.
  await assert.rejects(env.report('probe_bank', {}), code('42501'), 'không phải super admin');
  await db.exec(`INSERT INTO public.super_admins VALUES('${USER}')`);
  const bank = await env.report('probe_bank', {});
  assert.deepEqual([bank.items, bank.fence, (await lastCtx(db)).isSuperadmin], [[{ package: 'c', report: 'probe_bank' }], { buildings: [], cashbooks: [], orgWide: false }, true]);
}));

// Cùng một khai báo cho JS (w2Report/w2Params) và SQL (bảng thăm dò): mọi tham số sai bị cả hai từ chối.
const JS_PROBE = { a: w2Report({ ...PROBES.a[1], title: 'thăm dò', fields: { package: () => true, report: () => true, buildingId: () => true } }),
  c: w2Report({ ...PROBES.c[1], title: 'thăm dò', fields: { package: () => true, report: () => true } }),
  d: w2Report({ ...PROBES.d[1], title: 'thăm dò', fields: { package: () => true, report: () => true, buildingId: () => true } }) };
test('tham số: SQL và JS cùng luật (tên, kiểu, danh sách status/kind, bắt buộc, khoảng ngày ≤ 366)', () => inCase(async env => {
  const { db } = env;
  await installProbes(db);
  const bad = [['a', { status: 'OPEN' }], ['a', { fromDate: '2026-13-01' }], ['a', { fromDate: '2026-01-01', toDate: '2027-01-03' }],
    ['a', { fromDate: '2026-02-01', toDate: '2026-01-01' }], ['a', { query: 'a\nb' }], ['a', { query: 'x'.repeat(201) }], ['a', { buildingId: 'toà A' }],
    ['a', { buildingId: 7 }], ['a', { roomId: 'P101' }], ['c', { month: '2026-9' }], ['c', { month: null }], ['d', { year: 1999 }], ['d', { year: '2026' }], ['d', { kind: 'gas' }]];
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
  assert.deepEqual(canonical, params('a', { query: 'Toà A', buildingId: BUILDING, fromDate: '2026-01-01', toDate: '2027-01-02', status: 'open' }));
  assert.equal((await env.report('probe_rows', canonical)).items.length, 1, 'bản chuẩn hoá của JS qua được SQL');
  assert.deepEqual(w2Params(JS_PROBE.a, { buildingId: '00000000-0000-0000-0000-000000000000', query: '   ' }), params('a'), 'chỗ trống/UUID 0 = null');
  assert.deepEqual(domainInput('customers', {}).limit, 20, 'đợt 1 không đổi');
}));

test('kết quả gói: phân trang chung (offset/limit/≈40 KB), khuôn sai ⇒ XX000, unavailable của gói đi nguyên', () => inCase(async env => {
  const { db } = env;
  await installProbes(db);
  await reply(db, 'a', { rows: orgRows(Array.from({ length: 60 }, (_, n) => ({ n, buildingId: BUILDING }))), summary: { total: 60 }, sourceCapped: true, unavailable: null });
  let page = await run(env, 'a');
  assert.deepEqual([page.items.length, page.items[0], page.offset, page.nextOffset, page.summary, page.sourceCapped],
    [20, { n: 0, buildingId: BUILDING }, 0, 20, { total: 60 }, true]);
  page = await run(env, 'a', {}, { offset: 40, limit: 50 });
  assert.deepEqual([page.items.length, page.items[0].n, page.nextOffset], [20, 40, null]);
  await reply(db, 'a', { rows: orgRows(Array.from({ length: 30 }, (_, n) => ({ n, buildingId: BUILDING, text: '"'.repeat(1500) }))), summary: null,
    sourceCapped: false, unavailable: null });
  page = await run(env, 'a', {}, { limit: 50 });
  assert.ok(page.items.length < 30 && page.nextOffset === page.items.length, 'dừng sớm theo byte sau escape');
  await reply(db, 'a', { rows: [], summary: null, sourceCapped: false, unavailable: 'source_unavailable' });
  assert.equal((await run(env, 'a')).unavailable, 'source_unavailable');
  for (const value of ['[]', { rows: [], summary: null, sourceCapped: false }, { rows: {}, summary: null, sourceCapped: false, unavailable: null },
    { rows: [], summary: null, sourceCapped: 'no', unavailable: null }, { rows: [], summary: [], sourceCapped: false, unavailable: null },
    { rows: [], summary: null, sourceCapped: false, unavailable: 'feature_disabled' }, { rows: [{ n: 1 }], summary: null, sourceCapped: false, unavailable: 'not_implemented' },
    { rows: [1], summary: null, sourceCapped: false, unavailable: null }, { rows: Array.from({ length: 2001 }, () => ({})), summary: null, sourceCapped: false, unavailable: null },
    { rows: [], summary: null, sourceCapped: false, unavailable: null, extra: 1 }]) {
    await reply(db, 'a', value);
    await assert.rejects(run(env, 'a'), code('XX000'), JSON.stringify(value).slice(0, 80));
  }
  await reply(db, 'c', { rows: [], summary: null, sourceCapped: false, unavailable: 'no_building_scope' });
  await assert.rejects(run(env, 'c', { month: '2026-09' }), code('XX000'), 'self không thể "hết toà"');
  await reply(db, 'a', { rows: orgRows([{ buildingId: BUILDING, text: 'x'.repeat(70000) }]), summary: null, sourceCapped: false, unavailable: null });
  await assert.rejects(run(env, 'a'), code('PT413'), 'một hàng quá trần ⇒ result_too_large');
}));

test('bảng báo cáo: trùng mã, khai báo sai khuôn, khoá ↔ scope sai (P2-1), khoá ngoài danh sách, tham số gắn toà ở báo cáo không theo toà ⇒ XX000', () => inCase(async env => {
  const { db } = env;
  await installProbes(db);
  const [, spec] = PROBES.a, [, self] = PROBES.c, [, org] = PROBES.b;
  const broken = [{ b: ['probe_rows', spec] }, { a: ['probe_rows', { ...spec, source: 'crm.Bad Source' }] },
    { a: ['probe_rows', (({ kinds, ...rest }) => rest)(spec)] }, { a: ['probe_rows', { ...spec, params: ['foo'] }] },
    { a: ['probe_rows', { ...spec, required: ['month'] }] }, { a: ['probe_rows', { ...spec, statuses: null }] },
    { a: ['probe_rows', { ...spec, scope: 'organization' }] }, { a: ['probe_rows', { ...spec, scope: 'global' }] },
    { a: ['Probe', spec] }, { a: ['probe_rows', { ...spec, params: ['query', 'query'] }] },
    // P2-1: khoá ↔ scope, khoá ngoài danh sách.
    { a: ['probe_rows', { ...spec, scope: 'self', params: ['query'], statuses: null }] },
    { c: ['probe_self', { ...self, permission: 'vehicles.view' }] }, { c: ['probe_self', { ...self, scope: 'organization' }] },
    { c: ['probe_self', { ...self, permission: 'assistant.bank_events.read' }] }, { b: ['probe_org', { ...org, permission: 'assistant.bank_events.read' }] },
    { b: ['probe_org', { ...org, scope: 'platform' }] }, { a: ['probe_rows', { ...spec, permission: 'users.view' }] },
    { a: ['probe_rows', { ...spec, permission: 'customers.create' }] },
    // Tham số gắn toà chỉ ở rows/buildings.
    { b: ['probe_org', { ...org, params: ['roomId'] }] }, { b: ['probe_org', { ...org, scope: 'cashbooks', params: ['areaId'] }] },
    // P2-b: khoá dữ liệu không gắn toà (organization_scope) chỉ scope organization/cashbooks.
    { d: ['probe_buildings', { ...PROBES.d[1], permission: 'materials.view' }] }, { a: ['probe_rows', { ...spec, permission: 'salary.view' }] }];
  for (const change of broken) {
    const [letter] = Object.keys(change);
    await db.exec(catalogSql(letter, Object.fromEntries([...(change[letter][0] === PROBES[letter]?.[0] ? [] : [PROBES[letter]]), change[letter]])));
    await assert.rejects(env.reportList(), code('XX000'), JSON.stringify(change).slice(0, 110));
    await db.exec(catalogSql(letter, Object.fromEntries([PROBES[letter]])));
  }
  for (const reused of ['invoices.view', 'rooms.view', 'reports_finance.analysis']) {
    await db.exec(catalogSql('d', Object.fromEntries([PROBES.d, ['probe_reused', { ...PROBES.d[1], permission: reused }]])));
    assert.ok(Array.isArray((await env.reportList()).items), `khoá đợt 1 dùng lại: ${reused}`);
  }
  await db.exec(catalogSql('d', Object.fromEntries([PROBES.d])));
  assert.equal((await env.reportList()).items.length, 4, 'khôi phục bảng ⇒ chạy lại');
}));

// Lớp options/context đợt 2 trên lớp dưới tổng hợp (fixture_v6; lớp Khách hàng identity).
const MEMBER = { userId: USER, organizationId: ORG, membershipId: USER, authorizationVersion: 1, isSuperadmin: false };
const v7 = (env, name, arg = ORG) => env.call(`SELECT public.${name}($1::uuid) result`, [arg]);
const base = (db, kind, value) => db.query('INSERT INTO public.fixture_v6 VALUES($1,$2::jsonb) ON CONFLICT(kind) DO UPDATE SET value=EXCLUDED.value', [kind, JSON.stringify(value)]);
test('options/context v7: lớp đợt 2 chỉ thêm khoá registry đã bật / CRM đang cấp; không có khoá nào ⇒ nguyên lớp dưới', () => inCase(async env => {
  const { db } = env;
  // Trạng thái TRƯỚC công tắc Gói Z (20261018090000 bật khoá trong chuỗi mặc định): mọi khoá đợt 2 tắt.
  await db.query('UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability=ANY($1)', [W2_READ_KEY_LIST]);
  const org ={ ...MEMBER, policyVersion: 1, choices: { read: ['customers.view'], action: [] } };
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

// Đột biến: mỗi bản bỏ MỘT hàng rào; cùng phép thử mà bản sống từ chối thì bản đột biến phải lọt. Đột biến trên
// file chứa định nghĩa SỐNG: bước kiểm quyền, bước kết thúc, bảng gom, loại khoá ở file rào công ty (000700);
// grant, tham số, options ở file nền.
const LIVE = { base: foundation, orgfence };
const mutate = (file, from, to) => { assert.equal(LIVE[file].split(from).length, 2, `anchor: ${from}`); return { file, text: LIVE[file].replace(from, () => to) }; };
const ORG_PROBES = [
  { name: 'P2-a: hàng theo toà phải nêu buildingId', sql: mutate('orgfence', `      IF v_scope IN ('rows','buildings') AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_raw->'rows') r WHERE NOT r ? 'buildingId')
        THEN RAISE EXCEPTION 'hermes_w2_package_result_invalid' USING ERRCODE='XX000'; END IF;\n`, ''),
    run: async env => { await installProbes(env.db); await rowsReply(env.db, 'a', orgRows([{ total: 1 }])); return (await run(env, 'a')).items.length === 1; } },
  { name: 'P2-a: hàng báo cáo công ty phải nêu organizationId', sql: mutate('orgfence',
    `      IF v_scope NOT IN ('self','platform') AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_raw->'rows') r WHERE NOT r ? 'organizationId')
        THEN RAISE EXCEPTION 'hermes_w2_package_result_invalid' USING ERRCODE='XX000'; END IF;\n`, ''),
    run: async env => { await installProbes(env.db); await orgOverlay(env.db); await crmOrgWide(env.db, 'materials.view');
      await rowsReply(env.db, 'b', [{ n: 1 }]); return (await run(env, 'b')).items.length === 1; } },
  { name: 'P2-a: hàng công ty khác ⇒ 42501', sql: mutate('orgfence', `      IF v_scope<>'platform' AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_raw->'rows') r
          WHERE r ? 'organizationId' AND NOT`, `      IF false AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_raw->'rows') r
          WHERE r ? 'organizationId' AND NOT`),
    run: async env => { await installProbes(env.db); await orgOverlay(env.db); await crmOrgWide(env.db, 'materials.view');
      await rowsReply(env.db, 'b', orgRows([{ n: 1 }], FOREIGN)); return (await run(env, 'b')).items.length === 1; } },
  { name: 'P2-a: bước kết thúc kiểm lại kết nối/phiên (cả khối)', sql: mutate('orgfence',
    `  c:=app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  SELECT * INTO session FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  IF c.id::text IS DISTINCT FROM p_plan->>'connectionId' OR c.user_id IS DISTINCT FROM auth.uid()
    OR c.organization_id::text IS DISTINCT FROM p_plan->>'organizationId' OR NOT app_private.hermes_session_gate_v1(session)
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;\n`, ''),
    run: async env => (await asOwner(env.db, FINISH, [JSON.stringify(binding), JSON.stringify(finishPlan({ connectionId: uid(77), organizationId: FOREIGN })),
      JSON.stringify(EMPTY)])).items.length === 0 },
  { name: 'P2-a: bước kết thúc đúng công ty bước 1', sql: mutate('orgfence',
    `    OR c.organization_id::text IS DISTINCT FROM p_plan->>'organizationId' OR NOT`, `    OR NOT`),
    run: async env => (await asOwner(env.db, FINISH, [JSON.stringify(binding), JSON.stringify(finishPlan({ organizationId: FOREIGN })),
      JSON.stringify(EMPTY)])).items.length === 0 },
  { name: 'P2-b: khoá organization chỉ scope organization/cashbooks', sql: mutate('orgfence',
    `      IF v_kind='organization' AND v_spec->>'scope' NOT IN ('organization','cashbooks') THEN`, `      IF false THEN`),
    run: async env => { await installProbes(env.db);
      await env.db.exec(catalogSql('d', Object.fromEntries([['probe_buildings', { ...PROBES.d[1], permission: 'materials.view' }]])));
      return (await env.reportList()).items.length > 0; } },
  // Hồi quy: sổ quỹ CRM phải tính cho cả khoá loại organization (cashbooks.view) — bỏ đi thì sổ quỹ hết đọc được.
  { name: 'P2-b hồi quy: sổ quỹ CRM cho khoá organization', sql: mutate('orgfence',
    `    IF app_private.hermes_w2_permission_kind_v1(permission) IN ('company','organization') THEN`,
    `    IF app_private.hermes_w2_permission_kind_v1(permission)='company' THEN`),
    run: async env => { await installProbes(env.db, { extra: true }); await orgOverlay(env.db); await crmCashbooks(env.db, 'cashbooks.view', [CASHBOOK]);
      return (await env.report('probe_cash', { cashbookId: null })).unavailable !== null; } },
];
const probes = [
  { name: 'INVOKER: lối vào đòi vai authenticated (không chạy gói dưới vai chủ hàm)', sql: mutate('orgfence',
    `  IF p_caller IS DISTINCT FROM 'authenticated' THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;\n`, ''),
    run: async env => { await installProbes(env.db); return (await asOwner(env.db, ENTRY, entryArgs())).items.length === 1; } },
  { name: 'INVOKER: bước kết thúc đúng kết nối bước 1', sql: mutate('orgfence', `  IF c.id::text IS DISTINCT FROM p_plan->>'connectionId' OR c.user_id`, `  IF c.user_id`),
    run: async env => (await asOwner(env.db, FINISH, [JSON.stringify(binding), JSON.stringify(finishPlan({ connectionId: uid(77) })),
      JSON.stringify(EMPTY)])).items.length === 0 },
  { name: 'gate: toà = grant ∩ overlay của kết nối', sql: mutate('orgfence', `      AND state->'buildingIds' ? b.id::text
      AND EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(scopes)`, `      AND state->'buildingIds' ? b.id::text
      AND true OR EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(scopes)`),
    run: async env => { await installProbes(env.db); await run(env, 'a'); return (await lastCtx(env.db)).buildings.includes(OTHER_BUILDING); } },
  { name: 'gate: Read của kết nối', sql: mutate('orgfence', `    IF state->'allowed' IS DISTINCT FROM 'true'::jsonb OR NOT(permission=ANY(c.read_capabilities))
      THEN`, `    IF state->'allowed' IS DISTINCT FROM 'true'::jsonb
      THEN`),
    run: async env => { await installProbes(env.db);
      await env.db.exec("UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'vehicles.view')");
      return (await run(env, 'a')).items.length === 1; } },
  { name: 'gate: registry', sql: mutate('orgfence', `    enabled:=policy.enabled AND permission=ANY(policy.read_capabilities) AND EXISTS(
      SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=permission AND h.mode='read' AND h.enabled);
    state:=app_private.hermes_w2_grant_v1`, `    enabled:=policy.enabled AND permission=ANY(policy.read_capabilities);
    state:=app_private.hermes_w2_grant_v1`),
    run: async env => { await installProbes(env.db);
      await env.db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='vehicles.view'");
      return (await run(env, 'a')).items.length === 1; } },
  { name: 'P2-3 organization cần org_wide', sql: mutate('orgfence', `WHEN v_scope='organization' AND NOT org_wide THEN`, `WHEN false THEN`),
    run: async env => { await installProbes(env.db); return (await run(env, 'b')).items.length === 1; } },
  // Overlay Toàn tổ chức KHÔNG bật; CRM toàn công ty bật ⇒ bỏ "AND overlay_org" mới lọt.
  { name: 'P2-3 org_wide cần overlay Toàn tổ chức (bỏ AND overlay_org)', sql: mutate('orgfence', `    org_wide:=state->'orgWide'='true'::jsonb AND overlay_org;`,
    `    org_wide:=state->'orgWide'='true'::jsonb;`),
    run: async env => { await installProbes(env.db); await crmOrgWide(env.db, 'materials.view'); return (await run(env, 'b')).items.length === 1; } },
  { name: 'P2-3 cashbooks cần sổ CRM hoặc org_wide', sql: mutate('orgfence', `WHEN v_scope='cashbooks' AND NOT (org_wide OR overlay_org AND cardinality(v_cashbooks)>0) THEN`,
    `WHEN v_scope='cashbooks' AND NOT (org_wide OR overlay_org) THEN`),
    run: async env => { await installProbes(env.db, { extra: true }); await orgOverlay(env.db);
      return (await env.report('probe_cash', { cashbookId: null })).unavailable === null; } },
  { name: 'P2-3 platform chỉ super admin (cổng)', sql: mutate('orgfence', `    IF v_scope='platform' AND member->'isSuperadmin' IS DISTINCT FROM 'true'::jsonb
      THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
`, ''),
    run: async env => { await installProbes(env.db, { extra: true });
      // Hàng rào thứ hai: giả lập grant lỏng (đột biến grant ở file nền đã có ca riêng).
      await env.db.exec(block(foundation, 'app_private.hermes_w2_grant_v1').replace(` AND p_member->'isSuperadmin'='true'::jsonb;`, ';'));
      return (await env.report('probe_bank', {})).items.length === 1; } },
  { name: 'gate: buildingId phải trong phạm vi', sql: mutate('orgfence', `      IF NOT(requested_building=ANY(buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
      buildings:=ARRAY[requested_building];`, `      buildings:=ARRAY[requested_building];`),
    run: async env => { await installProbes(env.db); return (await run(env, 'a', { buildingId: OTHER_BUILDING })).items.length === 1; } },
  { name: 'P2-2b ID gắn toà phải thuộc ctx.buildings', sql: mutate('orgfence', `          IF v_building IS NULL OR NOT(v_building=ANY(buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
`, ''),
    run: async env => { await installProbes(env.db); return (await run(env, 'a', { roomId: OTHER_ROOM })).items.length === 1; } },
  { name: 'P2-2b staffId phải là thành viên công ty', sql: mutate('orgfence', `              AND m.status='ACTIVE' AND m.revoked_at IS NULL)
          THEN RAISE EXCEPTION`, `              AND m.status='ACTIVE' AND m.revoked_at IS NULL) AND false
          THEN RAISE EXCEPTION`),
    run: async env => { await installProbes(env.db); return (await run(env, 'a', { staffId: uid(5) })).items.length === 1; } },
  { name: 'P2-2a rào đầu ra theo ctx.buildings', sql: mutate('orgfence', `            r ? 'buildingId' AND NOT (CASE WHEN r->'buildingId'='null'::jsonb THEN org_wide`,
    `            false AND NOT (CASE WHEN r->'buildingId'='null'::jsonb THEN org_wide`),
    run: async env => { await installProbes(env.db); await rowsReply(env.db, 'a', orgRows([{ buildingId: OTHER_BUILDING }]));
      return (await run(env, 'a')).items.length === 1; } },
  { name: 'P2-2a báo cáo không theo toà không nêu toà', sql: mutate('orgfence', `      ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(v_raw->'rows') r WHERE r ? 'buildingId' OR r ? 'buildingIds') THEN`,
    `      ELSIF false THEN`),
    run: async env => { await installProbes(env.db); await rowsReply(env.db, 'c', [{ buildingId: BUILDING }]);
      return (await run(env, 'c', { month: '2026-09' })).items.length === 1; } },
  { name: 'gate: hết toà ⇒ no_building_scope', sql: mutate('orgfence', `      WHEN v_scope IN ('rows','buildings') AND cardinality(buildings)=0 THEN 'no_building_scope' END;`, ` END;`),
    run: async env => { await installProbes(env.db);
      await env.db.exec(`UPDATE public.fixture_acl SET building_ids=ARRAY['${OTHER_BUILDING}'::uuid] WHERE permission='vehicles.view'`);
      // Không toà ⇒ hàng nào nêu toà cũng bị rào; gói trả rỗng: bản sống báo no_building_scope, đột biến gọi gói.
      await rowsReply(env.db, 'a', []);
      return (await run(env, 'a')).unavailable === null; } },
  { name: 'mục lục: Read của kết nối', sql: mutate('orgfence', `IF state->'allowed'='true'::jsonb AND k=ANY(c.read_capabilities) THEN`, `IF state->'allowed'='true'::jsonb THEN`),
    run: async env => { await installProbes(env.db);
      await env.db.exec("UPDATE app_private.hermes_connections SET read_capabilities=array_remove(read_capabilities,'vehicles.view')");
      return (await env.reportList()).items.some(row => row.report === 'probe_rows'); } },
  { name: 'P2-1 bảng gom: khoá ↔ scope', sql: mutate('orgfence', `      IF v_kind IS NULL OR (v_kind='self')<>(v_spec->>'scope'='self') OR (v_kind='platform')<>(v_spec->>'scope'='platform') THEN`,
    `      IF false THEN`),
    run: async env => { await installProbes(env.db);
      await env.db.exec(catalogSql('c', Object.fromEntries([['probe_self', { ...PROBES.c[1], permission: 'vehicles.view' }]])));
      return (await env.reportList()).items.length > 0; } },
  { name: 'P2-1 bảng gom: tham số gắn toà chỉ ở rows/buildings', sql: mutate('orgfence', `        OR v_spec->>'scope' NOT IN ('rows','buildings') AND EXISTS(`,
    `        OR false AND EXISTS(`),
    run: async env => { await installProbes(env.db);
      await env.db.exec(catalogSql('b', Object.fromEntries([['probe_org', { ...PROBES.b[1], params: ['roomId'] }]])));
      return (await env.reportList()).items.length > 0; } },
  { name: 'kết quả gói: unavailable không kèm hàng', sql: mutate('orgfence', `        OR v_raw->'unavailable'<>'null'::jsonb AND (jsonb_array_length(v_raw->'rows')>0 OR v_raw->'summary'<>'null'::jsonb)
`, ''),
    run: async env => { await installProbes(env.db);
      await reply(env.db, 'a', { rows: orgRows([{ n: 1, buildingId: BUILDING }]), summary: null, sourceCapped: false, unavailable: 'not_implemented' });
      return (await run(env, 'a')).unavailable === 'not_implemented'; } },
  { name: 'bảng báo cáo: cấm trùng mã giữa hai gói', sql: mutate('orgfence', `      IF v_all ? v_key OR v_key !~`, `      IF v_key !~`),
    run: async env => { await installProbes(env.db); await env.db.exec(catalogSql('b', Object.fromEntries([PROBES.b, ['probe_rows', PROBES.a[1]]])));
      return (await env.reportList()).items.length > 0; } },
  { name: 'grant: Biến động số dư chỉ super admin', sql: mutate('base', ` AND p_member->'isSuperadmin'='true'::jsonb;`, `;`),
    run: async env => { await grantRead(env.db, ['assistant.bank_events.read']); return (await caps(env)).permissions['assistant.bank_events.read'].allowed; } },
  { name: 'grant: khoá self không trả toà', sql: mutate('base', `    IF p_key=ANY(app_private.hermes_w2_self_keys_v1()) THEN RETURN jsonb_set(v_state,'{buildingIds}','[]'::jsonb,false); END IF;
`, ''),
    run: async env => { await grantRead(env.db, ['notifications.view']); return (await caps(env)).permissions['notifications.view'].buildingIds.length > 0; } },
  { name: 'tham số: đúng tập tên', sql: mutate('base', `  PERFORM app_private.hermes_request_v1(p_params,v_names);
`, ''),
    run: async env => { await installProbes(env.db); return (await env.report('probe_rows', { ...params('a'), foo: 1 })).items.length === 1; } },
  { name: 'options: khoá chưa được CRM cấp không được mời', sql: mutate('base', `    CONTINUE WHEN cap->'allowed' IS DISTINCT FROM 'true'::jsonb;
`, ''),
    run: async env => { await base(env.db, 'connection_options', { ...MEMBER, policyVersion: 1, enabled: true, read: [], action: [], scopes: [] });
      // Không phạm vi nào ⇒ khoá cần toà bị bỏ ở cuối; khoá self (không toà) lộ ra nếu thiếu hàng rào.
      return (await v7(env, 'hermes_connection_options_v7')).read.includes('notifications.view'); } },
];
for (const probe of [...ORG_PROBES, ...probes]) {
  const changed = changedFunctions(LIVE[probe.sql.file], probe.sql.text);
  test(`mutation is caught: ${probe.name}`, { timeout: 120000 }, async () => {
    await inCase(async env => assert.equal(await probe.run(env).catch(() => false), false, 'bản sống từ chối'));
    await inCase(async env => {
      for (const sql of changed) await env.db.exec(sql);
      assert.equal(await probe.run(env), true, 'bản đột biến lọt');
    });
  });
}
