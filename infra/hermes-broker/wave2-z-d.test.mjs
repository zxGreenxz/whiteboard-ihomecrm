import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedW2d, D, USER, ORG } from './wave2-d-sql-fixture.mjs';
import { binding } from './wave2-sql-fixture.mjs';
import { CATEGORY } from './finance-fixture.mjs';
import { changedFunctions } from './full-read-sql-fixture.mjs';
import { W2D_REPORTS } from './wave2-d-contract.mjs';
import { w2Params } from './wave2-kit.mjs';

// Gói Z — bản sửa tích hợp của Gói D (hàm đọc 20261018080300_hermes_w2z_catalog_fixes_v1; loại thu chi ở hàm dùng chung
// 20261018080000_hermes_w2z_shared_fixes_v1) trên harness Gói D + dải Z. MỘT PGlite
// cho cả file, mỗi ca BEGIN … ROLLBACK, qua cổng thật public.hermes_w2_read_v1. Ca: HĐ thanh lý hai khách, khách đại diện
// thuộc chủ hồ sơ ngoài phạm vi (RLS customers ẩn) ⇒ không ghi chú; khử trùng loại thu chi (hàng công ty thắng hàng dùng
// chung; dòng của chính người hỏi so bằng IS TRUE). Đột biến đưa từng chỗ sửa về thân của gói D. Dữ liệu tổng hợp.
const Z = readFileSync('supabase/migrations/20261018080300_hermes_w2z_catalog_fixes_v1.sql', 'utf8');
const SHARED = readFileSync('supabase/migrations/20261018080000_hermes_w2z_shared_fixes_v1.sql', 'utf8');
const ORG_SCOPE = '00000000-0000-4000-8000-0000000000a1';
const STRANGER = '0d0d0d0d-0000-4000-8000-0000000000e1', HIDDEN_REP = '0d0d0d0d-0000-4000-8000-0000000000e2';
const GLOBAL_DUP = '0d0d0d0d-0000-4000-8000-0000000000e3', DUP_NULL = '0d0d0d0d-0000-4000-8000-0000000000e4', DUP_MINE = '0d0d0d0d-0000-4000-8000-0000000000e5';
let shared;
before(async () => { shared = await sharedW2d({ packages: ['d', 'z'] }); });
after(async () => { await shared?.close(); });
const inCase = work => shared.isolated(work);
const run = (env, report, values = {}) => env.report(report, w2Params(W2D_REPORTS[report], values), { limit: 50 }, binding);
async function orgWide(env, keys) {
  for (const key of keys) await env.db.query('UPDATE public.fixture_acl SET org_wide=true WHERE permission=$1', [key]);
  for (const table of ['hermes_connections', 'hermes_org_policies'])
    await env.db.query(`UPDATE app_private.${table} SET scope_ids=ARRAY(SELECT DISTINCT unnest(array_append(scope_ids,$1::uuid)))`, [ORG_SCOPE]);
}
const mutate = async (env, from, to) => {
  const source = Z.includes(from) ? Z : SHARED;
  assert.equal(source.split(from).length, 2, `anchor: ${from}`);
  for (const statement of changedFunctions(source, source.replace(from, () => to))) await env.db.exec(statement);
};
// Khách đại diện của HĐ thanh lý C_END thuộc chủ hồ sơ ngoài phạm vi thấy (RLS customers trả 0 dòng).
const hiddenRep = db => db.exec(`INSERT INTO public.customers(id,organization_id,user_id,full_name,phone)
    VALUES('${HIDDEN_REP}','${ORG}','${STRANGER}','Đại Diện Ẩn','0977000111') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.contract_customers(organization_id,contract_id,customer_id,is_representative) SELECT '${ORG}','${D.C_END}','${HIDDEN_REP}',true
    WHERE NOT EXISTS(SELECT 1 FROM public.contract_customers WHERE contract_id='${D.C_END}' AND customer_id='${HIDDEN_REP}');`);
const showStranger = db => db.query('INSERT INTO public.fixture_visible_owners VALUES($1) ON CONFLICT DO NOTHING', [STRANGER]);
const NOTE_FIX = `'note',CASE WHEN nv.ok THEN public.report_text_v1(v.termination_note,300) END,`;
const NOTE_OLD = `'note',CASE WHEN pii.ok THEN public.report_text_v1(v.termination_note,300) END,`;
const ORDER_FIX = '(t.organization_id IS NOT NULL) DESC,(t.user_id=auth.uid()) IS TRUE DESC,t.created_at,t.id) x';

test('Z-D thanh lý: HĐ hai khách, khách đại diện bị RLS ẩn ⇒ không ghi chú (tên khách thấy được giữ); mọi khách thấy ⇒ ghi chú', () => inCase(async env => {
  const { db } = env;
  await env.grant(['reports_real_estate.terminations']);
  await hiddenRep(db);
  let value = await run(env, 're_terminations');
  assert.deepEqual(value.items.map(row => [row.contractId, row.note, row.customerName]), [[D.C_END, null, 'Lê Ở Ghép']], 'khách ở ghép thấy được, đại diện ẩn');
  assert.ok(!JSON.stringify(value).includes('Khách chuyển đi sớm') && !JSON.stringify(value).includes('0977000111'));
  assert.deepEqual([value.summary.total, value.summary.totalContracts, value.summary.terminationRatePct], [1, 5, '20.0'], 'mẫu số theo toà giữ nguyên');
  await showStranger(db);
  value = await run(env, 're_terminations');
  assert.deepEqual(value.items.map(row => [row.note, row.customerName]), [['Khách chuyển đi sớm', 'Đại Diện Ẩn']]);
}));

test('Z-D loại thu chi: hàng dùng chung cũ hơn cùng tên không làm mất hạng mục của công ty; dòng của chính người hỏi thắng dòng user_id NULL', () => inCase(async env => {
  const { db } = env;
  await env.grant(['categories.view']);
  await orgWide(env, ['categories.view']);
  await db.query(`INSERT INTO public.income_expense_types(id,organization_id,type,name,category,is_restricted,rule_key,created_at) VALUES
    ($1,NULL,'expense','Sửa chữa','Bảo trì',false,null,'2020-01-01T00:00:00Z')`, [GLOBAL_DUP]);
  let value = await run(env, 'ie_types');
  assert.deepEqual(value.items.map(row => row.name), ['Sửa chữa', 'Ẩn', 'Tiền phòng'], 'hạng mục công ty còn nguyên');
  assert.equal(value.items.find(row => row.name === 'Sửa chữa').id, CATEGORY, 'đúng id của công ty');
  assert.deepEqual(value.summary, { total: 3, globalRowsOmitted: 0 }, 'bản dùng chung trùng tên đã bị khử trùng, không đếm thiếu');
  await db.query(`INSERT INTO public.income_expense_types(id,organization_id,type,name,category,is_restricted,rule_key,user_id,created_at) VALUES
    ($1,$3,'expense','Trùng Y','Khác',false,null,NULL,'2026-06-01T00:00:00Z'),($2,$3,'expense','Trùng Y','Khác',false,null,$4,'2026-07-01T00:00:00Z')`,
  [DUP_NULL, DUP_MINE, ORG, USER]);
  value = await run(env, 'ie_types');
  assert.equal(value.items.find(row => row.name === 'Trùng Y').id, DUP_MINE, 'như ownershipRank của web: dòng của chính mình trước');
  // Hàm dùng chung gọi thẳng như web (vai authenticated): cùng lựa chọn.
  const direct = await env.call(`SELECT COALESCE(jsonb_agg(t.type_id),'[]'::jsonb) result FROM public.income_expense_types_list_v1($1,'expense') t
    WHERE t.name IN ('Sửa chữa','Trùng Y')`, [ORG]);
  assert.deepEqual([...direct].sort(), [CATEGORY, DUP_MINE].sort());
}));

const probes = [
  { name: 'thanh lý: ghi chú theo rào tên khách (bản gói D)', from: NOTE_FIX, to: NOTE_OLD,
    run: async env => { await env.grant(['reports_real_estate.terminations']); await hiddenRep(env.db);
      return (await run(env, 're_terminations')).items[0].note !== null; } },
  { name: 'loại thu chi: không ưu tiên hàng của công ty', from: ORDER_FIX, to: '(t.user_id=auth.uid()) IS TRUE DESC,t.created_at,t.id) x',
    run: async env => { await env.grant(['categories.view']); await orgWide(env, ['categories.view']);
      await env.db.query(`INSERT INTO public.income_expense_types(id,organization_id,type,name,category,is_restricted,rule_key,created_at) VALUES
        ($1,NULL,'expense','Sửa chữa','Bảo trì',false,null,'2020-01-01T00:00:00Z') ON CONFLICT (id) DO NOTHING`, [GLOBAL_DUP]);
      return !(await run(env, 'ie_types')).items.some(row => row.name === 'Sửa chữa'); } },
  { name: 'loại thu chi: (user_id=auth.uid()) DESC xếp NULL lên đầu', from: ORDER_FIX, to: '(t.organization_id IS NOT NULL) DESC,(t.user_id=auth.uid()) DESC,t.created_at,t.id) x',
    run: async env => { await env.grant(['categories.view']); await orgWide(env, ['categories.view']);
      await env.db.query(`INSERT INTO public.income_expense_types(id,organization_id,type,name,category,is_restricted,rule_key,user_id,created_at) VALUES
        ($1,$3,'expense','Trùng Y','Khác',false,null,NULL,'2026-06-01T00:00:00Z'),($2,$3,'expense','Trùng Y','Khác',false,null,$4,'2026-07-01T00:00:00Z')
        ON CONFLICT (id) DO NOTHING`, [DUP_NULL, DUP_MINE, ORG, USER]);
      return (await run(env, 'ie_types')).items.find(row => row.name === 'Trùng Y').id === DUP_NULL; } },
];
for (const probe of probes) {
  test(`mutation is caught: Z-D ${probe.name}`, () => inCase(async env => {
    assert.equal(await probe.run(env), false, 'bản Z');
    await mutate(env, probe.from, probe.to);
    assert.equal(await probe.run(env), true, 'bản đột biến');
  }));
}
