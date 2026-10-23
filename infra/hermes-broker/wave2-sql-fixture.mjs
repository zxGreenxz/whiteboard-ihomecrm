import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedFullRead, FULL_READ_KEYS, REPORT_KEYS, BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, SCOPE, ORG_SCOPE, binding, USER, ORG, FOREIGN,
  CONNECTION, SESSION } from './full-read-sql-fixture.mjs';
import { w2MigrationPaths } from './wave2-sql-paths.mjs';
import { W2 } from './wave2-registry.mjs';
export { BUILDING, OTHER_BUILDING, ROOM, OTHER_ROOM, SCOPE, ORG_SCOPE, binding, USER, ORG, FOREIGN, CONNECTION, SESSION };

// Đợt 2 trên PGlite (Gói 0): fixture đọc đầy đủ đợt 1 (nền Hermes thật, v1/v2/v3 thật, RPC web thật của
// đợt 1) + chuỗi migration đợt 2 (nền + gói được chọn, mỗi file chạy HAI lượt: forward phải idempotent).
// Cổng tổng hợp cùng chữ ký: options v6 đọc bảng public.fixture_v6 và lớp Khách hàng
// (hermes_customer_extend_options_v1) là identity — lớp đợt 2 được thử riêng trên đó, không chứng minh
// chuỗi options thật v1..v6, RLS, JWT thật hay PostgREST. Dữ liệu tổng hợp.
// MỘT PGlite cho cả file test (shared…), mỗi ca BEGIN … ROLLBACK (isolated): runner CI từng cạn RAM.
const OPTIONS_PORT = `CREATE TABLE public.fixture_v6(kind text PRIMARY KEY,value jsonb NOT NULL);
  CREATE FUNCTION public.hermes_org_policy_options_v6(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT value FROM public.fixture_v6 WHERE kind='org_options'$$;
  CREATE FUNCTION public.hermes_connection_options_v6(p_org uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT value FROM public.fixture_v6 WHERE kind='connection_options'$$;
  CREATE FUNCTION public.hermes_connection_context_v6(p_connection_id uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT value FROM public.fixture_v6 WHERE kind='context'$$;
  CREATE FUNCTION app_private.hermes_customer_extend_options_v1(p_result jsonb,p_kind text) RETURNS jsonb LANGUAGE sql AS $$SELECT p_result$$;`;
// Đợt 3 Hoá đơn (20261022051620): $requires$ đòi hai hàm web mà sáu hàm dùng chung gói A gọi lúc chạy. Fixture gói A dựng bản port
// riêng ở before(); gói khác không dùng nên nhận bản thế chỗ ĐÓNG an toàn (không khoá trang nào, không hoá đơn nào quá hạn), chỉ khi thiếu.
const RUNTIME_PORT = `DO $port$ BEGIN
  IF to_regprocedure('public.can_do_on_building(text,text,uuid)') IS NULL THEN
    CREATE FUNCTION public.can_do_on_building(_table text,_action text,_building_id uuid) RETURNS boolean LANGUAGE sql STABLE AS 'SELECT false';
  END IF;
  IF to_regprocedure('public.is_overdue(public.invoices)') IS NULL THEN
    CREATE FUNCTION public.is_overdue(public.invoices) RETURNS boolean LANGUAGE sql STABLE AS 'SELECT false';
  END IF;
END $port$;`;

/** packages: gói đợt 2 cần nạp ('a'..'d','z'); before(db): trước migration đợt 2 (bảng mà hàm LANGUAGE sql
 * cần lúc tạo); seed(db): sau migration (dữ liệu tổng hợp của gói). */
export async function sharedW2({ reads = [...new Set([...FULL_READ_KEYS, ...REPORT_KEYS])], packages = ['a', 'b', 'c', 'd', 'z'], before = null, seed = null } = {}) {
  const shared = await sharedFullRead({ reads });
  const { db } = shared;
  await db.exec(OPTIONS_PORT);
  if (before) await before(db);
  await db.exec(RUNTIME_PORT);
  const paths = w2MigrationPaths({ packages });
  for (const path of paths) { const sql = readFileSync(path, 'utf8'); await db.exec(sql); await db.exec(sql); }
  if (seed) await seed(db);
  // Lối vào INVOKER (20261018000600), gọi như PostgREST: SET LOCAL ROLE authenticated + claims JWT.
  const w2read = (domain, input, b = binding, options) => shared.call('SELECT public.hermes_w2_read_v1($1::jsonb,$2::text,$3::jsonb) result',
    [JSON.stringify(b), domain, JSON.stringify(input)], options);
  const report = (reportId, params = {}, extra = {}, b = binding, options) =>
    w2read('report', { report: reportId, params, limit: 20, offset: 0, ...extra }, b, options);
  const reportList = (topic = null, b = binding, options) => w2read('report_list', { topic }, b, options);
  const env = { ...shared, paths, w2read, report, reportList, grant: keys => grantRead(db, keys) };
  // Mỗi ca BEGIN … ROLLBACK, nhận đúng env đợt 2 (có report/reportList).
  env.isolated = work => shared.isolated(() => work(env));
  return env;
}

/** Bật đủ bốn lớp cho khoá đọc: registry, chính sách công ty, Read của kết nối, quyền CRM (fixture_acl:
 * toà A+B, không org-wide). Gỡ từng lớp trong test để chứng minh mỗi lớp là một hàng rào. */
export async function grantRead(db, keys, { buildings = [BUILDING, OTHER_BUILDING], orgWide = false } = {}) {
  await db.query('UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability=ANY($1)', [keys]);
  for (const table of ['hermes_org_policies', 'hermes_connections'])
    await db.query(`UPDATE app_private.${table} SET read_capabilities=ARRAY(SELECT DISTINCT unnest(read_capabilities||$1::text[]))`, [keys]);
  for (const key of keys)
    await db.query(`INSERT INTO public.fixture_acl(permission,allowed,org_wide,building_ids) VALUES($1,true,$2,$3)
      ON CONFLICT(permission) DO UPDATE SET allowed=true,org_wide=EXCLUDED.org_wide,building_ids=EXCLUDED.building_ids`, [key, orgWide, buildings]);
}

/** Bảng báo cáo SQL của MỘT gói khớp từng trường khai báo JS (wave2-<gói>-contract.mjs) và bảng gom
 * (hermes_w2_catalog_v1) gắn đúng gói. Gói gọi trong test riêng; Gói 0 gọi cho cả bốn. */
export async function assertPackageParity(env, letter, registry = W2) {
  const { db } = env;
  const sql = (await db.query(`SELECT app_private.hermes_w2${letter}_catalog_v1() spec`)).rows[0].spec;
  const js = Object.keys(registry.reports).filter(reportId => registry.reports[reportId].package === letter).sort();
  assert.deepEqual(Object.keys(sql).sort(), js, `gói ${letter}: cùng tập mã báo cáo`);
  for (const reportId of js) {
    const { package: pkg, ...expected } = registry.sqlSpec(reportId);
    assert.equal(pkg, letter);
    assert.deepEqual(sql[reportId], expected, `gói ${letter}: ${reportId}`);
    const routed = (await db.query('SELECT app_private.hermes_w2_catalog_v1($1) spec', [reportId])).rows[0].spec;
    assert.deepEqual(routed, { ...expected, package: letter }, `bảng gom: ${reportId}`);
  }
}
