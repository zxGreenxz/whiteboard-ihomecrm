import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedW2b } from './wave2-b-sql-fixture.mjs';
import { BUILDING, USER, ORG } from './wave2-sql-fixture.mjs';
import { changedFunctions } from './full-read-sql-fixture.mjs';
import { W2B_REPORTS } from './wave2-b-contract.mjs';

// Gói Z — bản sửa tích hợp của Gói B (20261018080100_hermes_w2z_finance_fail_closed_v1) trên harness Gói B + dải Z. MỘT
// PGlite cho cả file, mỗi ca BEGIN … ROLLBACK. Ca soát lại: bảng báo cáo thiếu khoá phụ restricted_view ⇒ cổng không đưa
// khoá vào ctx.scopes; hàm đọc gói phải ĐÓNG (ẩn phiếu/hạng mục hạn chế của người khác), không đọc NULL là "theo RLS".
// Gọi thẳng hàm đọc gói bằng vai authenticated với ctx khuôn hermes_w2_scope_v1 (thiếu khoá phụ). Dữ liệu tổng hợp.
const Z = readFileSync('supabase/migrations/20261018080100_hermes_w2z_finance_fail_closed_v1.sql', 'utf8');
const RESTRICTED = 'income_expenses.restricted_view';
let shared;
before(async () => { shared = await sharedW2b({ packages: ['b', 'z'] }); });
after(async () => { await shared?.close(); });
const inCase = work => shared.isolated(work);
const params = (report, values = {}) => ({ ...Object.fromEntries(W2B_REPORTS[report].params.map(name => [name, null])), ...values });
async function direct(env, report, values, scopes = {}) {
  await env.db.exec('GRANT USAGE ON SCHEMA app_private TO authenticated');
  const spec = W2B_REPORTS[report];
  const ctx = { organizationId: ORG, userId: USER, report, permission: spec.permission, scope: spec.scope, buildings: [BUILDING], requestedBuildingId: null,
    overlayOrg: false, orgWide: false, isSuperadmin: false, today: '2026-10-16', scopes, cashbooks: [] };
  return env.call('SELECT app_private.hermes_w2b_read_v1($1,$2::jsonb,$3::jsonb) result', [report, JSON.stringify(params(report, values)), JSON.stringify(ctx)]);
}
// Quyền CRM restricted_view ở toà A (RLS web cho xem phiếu hạn chế của người khác), nhưng kết nối không giữ khoá.
const crmRestricted = db => db.exec(`INSERT INTO public.fixture_acl(permission,building_ids) VALUES('${RESTRICTED}',ARRAY['${BUILDING}'::uuid])
  ON CONFLICT(permission) DO UPDATE SET allowed=true,building_ids=EXCLUDED.building_ids`);
const topCodes = async (env, scopes) => (await direct(env, 'top_expenses', { month: '2026-10' }, scopes)).rows.map(row => row.code);
const breakdown = async (env, scopes) => {
  const raw = await direct(env, 'fa_type_breakdown', { fromDate: '2026-10-01', toDate: '2026-10-31', basis: 'cash' }, scopes);
  return [raw.rows.map(row => row.typeName).sort(), raw.summary.restrictedIncluded];
};
const mutate = async (env, from, to) => {
  assert.equal(Z.split(from).length, 2, `anchor: ${from}`);
  for (const statement of changedFunctions(Z, Z.replace(from, () => to))) await env.db.exec(statement);
};
const FIX = `v_ok:=COALESCE(cardinality(v_buildings)>0 AND jsonb_typeof(p_ctx->'scopes'->'income_expenses.restricted_view')='array'
    AND NOT EXISTS(SELECT 1 FROM unnest(v_buildings) b(id) WHERE NOT (p_ctx->'scopes'->'income_expenses.restricted_view') ? b.id::text),false);`;
const OLD = `v_ok:=cardinality(v_buildings)>0 AND jsonb_typeof(p_ctx->'scopes'->'income_expenses.restricted_view')='array'
    AND NOT EXISTS(SELECT 1 FROM unnest(v_buildings) b(id) WHERE NOT (p_ctx->'scopes'->'income_expenses.restricted_view') ? b.id::text);`;

test('Z-B: định nghĩa sống là bản Z; thân chỉ khác bản gói B ở câu v_ok', () => inCase(async ({ db }) => {
  const src = (await db.query("SELECT prosrc FROM pg_proc WHERE oid='app_private.hermes_w2b_read_v1(text,jsonb,jsonb)'::regprocedure")).rows[0].prosrc;
  assert.ok(src.includes(FIX));
  const pkg = readFileSync('supabase/migrations/20261018020300_hermes_w2b_finance_read_fixes_v1.sql', 'utf8');
  const body = text => { const start = text.indexOf('CREATE OR REPLACE FUNCTION app_private.hermes_w2b_read_v1('); return text.slice(start, text.indexOf('$fn$;', start)); };
  assert.equal(body(Z).replace(/\n  -- \(Gói Z\)[^\n]*\n  -- [^\n]*\n/, '\n').replace(FIX, OLD), body(pkg));
}));

test('Z-B top khoản chi: ctx thiếu khoá restricted_view ⇒ không phiếu hạn chế của người khác (đóng); khoá phủ toà ⇒ có', () => inCase(async env => {
  await crmRestricted(env.db);
  assert.deepEqual(await topCodes(env, {}), ['PC-401', 'PC-404'], 'thiếu khoá phụ trong ctx ⇒ đóng');
  assert.deepEqual(await topCodes(env, { [RESTRICTED]: null }), ['PC-401', 'PC-404'], 'khoá không được cấp ⇒ đóng');
  assert.deepEqual(await topCodes(env, { [RESTRICTED]: [BUILDING] }), ['PC-402', 'PC-401', 'PC-404'], 'khoá phủ mọi toà ⇒ như RLS web');
}));

test('Z-B hạng mục thu/chi: ctx thiếu khoá restricted_view ⇒ không hạng mục hạn chế', () => inCase(async env => {
  await crmRestricted(env.db);
  assert.deepEqual(await breakdown(env, {}), [['Sửa chữa'], false]);
  assert.deepEqual(await breakdown(env, { [RESTRICTED]: [BUILDING] }), [['Lương', 'Sửa chữa'], true], 'đối chứng: khoá phủ toà ⇒ có Lương');
}));

for (const [name, run] of [
  ['top khoản chi', async env => (await topCodes(env, {})).includes('PC-402')],
  ['hạng mục thu/chi', async env => (await breakdown(env, {}))[0].includes('Lương')],
]) {
  test(`mutation is caught: Z-B v_ok NULL mở ${name}`, () => inCase(async env => {
    await crmRestricted(env.db);
    assert.equal(await run(env), false, 'bản Z: đóng');
    await mutate(env, FIX, OLD);
    assert.equal(await run(env), true, 'bản cũ: NULL ⇒ lọt hạn chế');
  }));
}
