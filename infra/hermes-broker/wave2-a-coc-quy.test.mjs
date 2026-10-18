import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedW2a, INVOICE_A, CHANGE_BOOK, BUILDING, OTHER_BUILDING, OTHER_ROOM, USER, ORG, FOREIGN, STRANGER, DEPOSIT_TYPE, RV1, RV2, RV3, RV_SETTLED, RV_B } from './wave2-a-sql-fixture.mjs';
import { ORG_SCOPE } from './wave2-sql-fixture.mjs';
import { changedFunctions } from './full-read-sql-fixture.mjs';
import { W2A_REPORTS } from './wave2-a-contract.mjs';
import { W2 } from './wave2-registry.mjs';
import { domainInput, domainResult } from './domain-contract.mjs';

// Gói A sau phát hành (19/10/2026; 20261018182656 hàm dùng chung + hàm đọc theo RLS, 20261018185339 kiểu phạm vi
// rls_buildings của cổng, 20261018185413 khai báo): phiếu cọc giữ chỗ (reservation_vouchers) = ĐÚNG tập web thấy dưới RLS
// income_expenses — kể cả phiếu vào sổ quỹ người hỏi giữ ở toà KHÔNG có deposits.view (route /deposits không truyền toà) —
// thu hẹp theo phạm vi KẾT NỐI (ctx.buildings = toà công ty ∩ overlay). MỘT PGlite cho cả file, mỗi ca
// BEGIN … ROLLBACK. Tình huống: người hỏi giữ sổ quỹ ở toà B nhưng KHÔNG có buildings.view ở B (RLS rbac ẩn mọi phiếu
// khác của B). "Tập web" = câu chép đúng bộ lọc của useReservationDeposits chạy dưới RLS (vai authenticated). RLS là RLS
// giả lập của fixture (f_rbac theo toà + f_fund theo sổ người hỏi giữ); không chứng minh policy/JWT/PostgREST thật — phần
// đó so trên TEST. Đột biến: thay từng chỗ của migration trong ca ⇒ phép thử phải đổi kết quả.
const POST = readFileSync('supabase/migrations/20261018182656_hermes_w2a_reservation_fund_member_v1.sql', 'utf8');
const GATE = readFileSync('supabase/migrations/20261018185339_hermes_w2_rls_buildings_scope_v1.sql', 'utf8');
const code = expected => error => error.code === expected;
const OTHER_ORG_BUILDING = '0e0e0e0e-0000-4000-8000-000000000012';
const KEYS = [...new Set(Object.values(W2A_REPORTS).map(spec => spec.permission))];
const u = n => `0a0a0a0a-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FUND_MINE = u(300), FUND_OTHER = u(301), RV_FUND = u(302), RV_FUND_UNAPPROVED = u(303), RV_FUND_OTHER = u(304), RV_FOREIGN = u(305);
let shared;
before(async () => { shared = await sharedW2a(); });
after(async () => { await shared?.close(); });

// Sổ quỹ ở toà B: của người hỏi (hai phiếu cọc, có chữ PII tổng hợp) và của người khác (một phiếu). Người hỏi mất buildings.view ở B.
const SEED = `
  INSERT INTO public.accounts VALUES('${FUND_MINE}','${ORG}','${USER}','Quỹ toà B của tôi',null,false,null),
    ('${FUND_OTHER}','${ORG}','${STRANGER}','Quỹ toà B người khác',null,false,null);
  INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,room_id,account_id,voucher_date,total_amount,approval_status,
      payer_name,notes,contract_id) VALUES
    ('${RV_FUND}','${ORG}','${STRANGER}','PT-Q1','INCOME','Cọc giữ chỗ PII-TEN-PHIEU','${OTHER_BUILDING}','${OTHER_ROOM}','${FUND_MINE}','2026-10-14',600000,'APPROVED',
      'PII-NGUOI-NOP 0988000000','PII-GHI-CHU',null),
    ('${RV_FUND_UNAPPROVED}','${ORG}','${STRANGER}','PT-Q2','INCOME','Cọc giữ chỗ chờ duyệt','${OTHER_BUILDING}','${OTHER_ROOM}','${FUND_MINE}','2026-10-13',250000,'UNAPPROVED',
      'PII-NGUOI-NOP-2',null,null),
    ('${RV_FUND_OTHER}','${ORG}','${STRANGER}','PT-Q3','INCOME','Cọc sổ người khác','${OTHER_BUILDING}','${OTHER_ROOM}','${FUND_OTHER}','2026-10-15',800000,'APPROVED',
      'Người Khác',null,null);
  INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,amount,unit_price,quantity) VALUES
    ('${RV_FUND}','${DEPOSIT_TYPE}',600000,600000,1),('${RV_FUND_UNAPPROVED}','${DEPOSIT_TYPE}',250000,250000,1),('${RV_FUND_OTHER}','${DEPOSIT_TYPE}',800000,800000,1);
  DELETE FROM public.fixture_building_access WHERE building_id='${OTHER_BUILDING}';`;
const inCase = work => shared.isolated(async env => { await env.grant(KEYS); await env.db.exec(SEED); return work(env); });
const params = (values = {}) => ({ ...Object.fromEntries(W2A_REPORTS.reservation_vouchers.params.map(name => [name, null])), ...values });
const CTX = { organizationId: ORG, userId: USER, report: 'reservation_vouchers', permission: 'deposits.view', scope: 'rows', buildings: [BUILDING, OTHER_BUILDING],
  requestedBuildingId: null, overlayOrg: true, orgWide: false, isSuperadmin: false, today: '2026-10-16',
  scopes: { 'customers.view': [BUILDING, OTHER_BUILDING] } };
const direct = (env, values = {}, ctx = {}) => env.call('SELECT public.fixture_w2a_read($1,$2::jsonb,$3::jsonb) result',
  ['reservation_vouchers', JSON.stringify(params(values)), JSON.stringify({ ...CTX, ...ctx })]);
const ids = rows => rows.map(row => row.voucherId);
// Tập web: bộ lọc của useReservationDeposits (useDeposits.ts, vùng deposit-reservation-vouchers) dưới RLS người hỏi, công ty đang
// chọn (RLS ranh giới công ty), thứ tự voucher_date giảm dần rồi id.
const webIds = env => env.call(`SELECT COALESCE(jsonb_agg(ie.id ORDER BY ie.voucher_date DESC,ie.id),'[]'::jsonb) result FROM public.income_expenses ie
  WHERE ie.organization_id=$1 AND ie.contract_id IS NULL AND ie.deleted_at IS NULL AND ie.type='INCOME'
    AND ie.approval_status IN ('APPROVED','UNAPPROVED','CANCELLED')
    AND NOT EXISTS(SELECT 1 FROM public.deposit_management_exclusions ex WHERE ex.voucher_id=ie.id)
    AND EXISTS(SELECT 1 FROM public.income_expense_items it JOIN public.income_expense_types t ON t.id=it.income_expense_type_id AND t.is_deposit
      WHERE it.income_expense_id=ie.id)`, [ORG]);
// Tổng web: RPC get_reservation_deposit_summary như useReservationDepositSummary (không lọc toà = toàn phạm vi RLS).
const webSummary = async (env, buildings = null) => {
  const raw = await env.call('SELECT public.get_reservation_deposit_summary($1::uuid[]) result', [buildings]);
  return { holdingAmount: String(Number(raw.holding_amount)), approvedCount: raw.approved_count, unapprovedCount: raw.unapproved_count,
    cancelledCount: raw.cancelled_count };
};
const norm = summary => ({ ...summary, holdingAmount: String(Number(summary.holdingAmount)) });
const sharedIds = (env, buildings = null) => env.call(`SELECT COALESCE(jsonb_agg(t.voucher_id ORDER BY t.voucher_date DESC,t.voucher_id),'[]'::jsonb) result
  FROM public.deposit_reservation_vouchers_v1($1,$2::uuid[]) t`, [ORG, buildings]);
const onlyDepositsAt = (env, buildings) => env.db.query("UPDATE public.fixture_acl SET building_ids=$1 WHERE permission='deposits.view'", [buildings]);
const orgOverlay = async env => {
  for (const table of ['hermes_connections', 'hermes_org_policies'])
    await env.db.query(`UPDATE app_private.${table} SET scope_ids=array_append(scope_ids,$1::uuid)`, [ORG_SCOPE]);
};

test('tập web dưới RLS: phiếu vào sổ quỹ của mình ở toà không có buildings.view, không có phiếu sổ người khác ở toà đó', () => inCase(async env => {
  const web = await webIds(env);
  // A: RV2 (12/10), RV1 (10/10), RV3 (01/10), RV_SETTLED (02/10); B: chỉ hai phiếu vào sổ của mình (14/10, 13/10).
  assert.deepEqual(web, [RV_FUND, RV_FUND_UNAPPROVED, RV2, RV1, RV_SETTLED, RV3]);
  assert.ok(!web.includes(RV_FUND_OTHER) && !web.includes(RV_B), 'phiếu sổ người khác / phiếu không sổ ở toà B: RLS ẩn');
}));

test('hàm dùng chung gọi thẳng như web: đúng tập web (RLS quyết, không giao toà theo deposits.view); p_building_ids chỉ thu hẹp; thiếu khoá trang ⇒ rỗng', () => inCase(async env => {
  await onlyDepositsAt(env, [BUILDING]);
  assert.deepEqual(await sharedIds(env), await webIds(env), 'không có deposits.view ở B vẫn thấy phiếu vào sổ của mình như web');
  assert.deepEqual(await sharedIds(env, [OTHER_BUILDING]), [RV_FUND, RV_FUND_UNAPPROVED]);
  assert.deepEqual(await sharedIds(env, []), [], "'{}' = rỗng");
  await env.db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='deposits.view'");
  assert.deepEqual(await sharedIds(env), [], 'không có khoá trang ở đâu (route web chặn) ⇒ không hàng nào');
  await assert.rejects(env.call(`SELECT count(*) result FROM public.deposit_reservation_vouchers_v1('${ORG}')`, [], { role: 'postgres' }),
    error => error.code === '42501', 'vai khác authenticated bị từ chối');
}));

test('hàm đọc gói (ctx toà A+B): trả phiếu vào sổ của mình ở B như web; PII vẫn rào; tổng = RPC web trên cùng tập', () => inCase(async env => {
  const value = await direct(env);
  assert.deepEqual(ids(value.rows), await webIds(env), 'cùng tập, cùng thứ tự với web');
  assert.ok(value.rows.every(row => row.organizationId === ORG));
  const fund = value.rows.find(row => row.voucherId === RV_FUND);
  assert.deepEqual([fund.buildingId, fund.depositAmount, fund.approvalStatus, fund.code, fund.buildingName, fund.roomName],
    [OTHER_BUILDING, '600000', 'APPROVED', 'PT-Q1', null, null], 'tên toà/phòng: RLS buildings/rooms ẩn như web ("—")');
  assert.deepEqual(norm(value.summary), await webSummary(env), 'tổng = RPC web (không lọc toà)');
  assert.deepEqual(norm(value.summary), { holdingAmount: '2600000', approvedCount: 2, unapprovedCount: 2, cancelledCount: 1 },
    'RV1 2tr + phiếu sổ B 600k (bỏ phiếu đã quyết toán); chờ duyệt RV2 + phiếu sổ B; huỷ RV3');
  // Rào PII Gói Z giữ nguyên: phiếu cọc giữ chỗ không nối được hồ sơ khách ⇒ tên phiếu/người nộp NULL kể cả có customers.view ở B
  // và mọi chủ hồ sơ nhìn thấy; tìm theo chữ đã che không lọt.
  await env.db.query('INSERT INTO public.fixture_visible_owners VALUES($1) ON CONFLICT DO NOTHING', [STRANGER]);
  const again = await direct(env);
  assert.ok(again.rows.every(row => row.name === null && row.payerName === null));
  assert.ok(!JSON.stringify(again).includes('PII-') && !JSON.stringify(again).includes('0988000000'));
  for (const query of ['PII', 'nguoi-nop', '0988000000', 'Cọc giữ chỗ'])
    assert.deepEqual((await direct(env, { query })).rows, [], `không dò được tên phiếu/người nộp: ${query}`);
  assert.deepEqual(ids((await direct(env, { query: 'pt-q2' })).rows), [RV_FUND_UNAPPROVED], 'tìm theo mã phiếu');
  assert.deepEqual(ids((await direct(env, { status: 'UNAPPROVED' })).rows), [RV_FUND_UNAPPROVED, RV2]);
}));

test('ctx chỉ toà A (kết nối thu hẹp): không trả phiếu ở B dù web hiện; tổng chỉ trên toà A', () => inCase(async env => {
  const value = await direct(env, {}, { buildings: [BUILDING], scopes: { 'customers.view': [BUILDING] } });
  assert.deepEqual(ids(value.rows), [RV2, RV1, RV_SETTLED, RV3]);
  assert.ok(value.rows.every(row => row.buildingId === BUILDING));
  assert.deepEqual(norm(value.summary), await webSummary(env, [BUILDING]));
  assert.deepEqual(norm(value.summary), { holdingAmount: '2000000', approvedCount: 1, unapprovedCount: 1, cancelledCount: 1 });
}));

const identity = (read, buildings) => ({ row: { organizationId: ORG }, effective: { read, action: [] },
  scopesByPermission: Object.fromEntries(read.map(key => [key, { buildingIds: buildings, cashbookIds: [] }])) });
const viaGate = env => env.report('reservation_vouchers', params(), { limit: 50 });

test('cổng thật: kết nối chỉ toà A ⇒ chỉ phiếu toà A (kết nối thu hẹp); Toàn tổ chức ⇒ đúng tập web kể cả phiếu sổ của mình ở toà KHÔNG có deposits.view', () => inCase(async env => {
  await onlyDepositsAt(env, [BUILDING]);
  let gate = await viaGate(env);
  assert.deepEqual(gate.fence, { buildings: [BUILDING], cashbooks: [], orgWide: false });
  assert.deepEqual(ids(gate.items), [RV2, RV1, RV_SETTLED, RV3], 'phạm vi kết nối thu hẹp: chỉ toà A');
  assert.deepEqual(norm(gate.summary), await webSummary(env, [BUILDING]));
  await orgOverlay(env);
  gate = await viaGate(env);
  assert.deepEqual([...gate.fence.buildings].sort(), [BUILDING, OTHER_BUILDING].sort(), 'toà công ty ∩ kết nối, không giao tập toà deposits.view');
  assert.equal(gate.fence.orgWide, false, 'khoá không toàn công ty');
  assert.deepEqual(ids(gate.items), await webIds(env), 'đúng tập web: có phiếu sổ của mình ở B, không phiếu sổ người khác ở B');
  assert.ok(ids(gate.items).includes(RV_FUND) && !ids(gate.items).includes(RV_FUND_OTHER));
  assert.deepEqual(norm(gate.summary), await webSummary(env), 'tổng = RPC web (không lọc toà)');
  assert.ok(gate.items.every(row => row.name === null && row.payerName === null), 'PII Gói Z');
  // Hỏi một toà: được hỏi toà B (trong phạm vi kết nối), không toà công ty khác.
  const onlyB = await env.report('reservation_vouchers', params({ buildingId: OTHER_BUILDING }), { limit: 50 });
  assert.deepEqual([onlyB.fence.buildings, ids(onlyB.items)], [[OTHER_BUILDING], [RV_FUND, RV_FUND_UNAPPROVED]]);
  await assert.rejects(env.report('reservation_vouchers', params({ buildingId: OTHER_ORG_BUILDING })), code('42501'), 'toà công ty khác');
  // Rào broker: fence không ⊆ tập toà của khoá vẫn nhận (rls_buildings); hàng ngoài fence vẫn bị chặn; khoá không ở toà nào ⇒ chặn.
  const input = domainInput('report', { report: 'reservation_vouchers', params: {}, limit: 50 });
  const value = await env.report('reservation_vouchers', input.params, { limit: input.limit, offset: input.offset });
  assert.deepEqual(domainResult('report', value, identity(KEYS, [BUILDING]), input).items, value.items);
  assert.throws(() => domainResult('report', { ...value, items: [{ ...value.items[0], buildingId: OTHER_ORG_BUILDING }] },
    identity(KEYS, [BUILDING]), input), 'hàng ngoài fence');
  assert.throws(() => domainResult('report', value, identity(KEYS, []), input), 'broker: khoá không có ở toà nào');
}));

test('cổng thật: không có deposits.view ở đâu (hoặc mất khoá) ⇒ 42501', () => inCase(async env => {
  await orgOverlay(env);
  await onlyDepositsAt(env, []);
  await assert.rejects(viaGate(env), code('42501'), 'khoá không ở toà nào');
  await env.db.query("UPDATE public.fixture_acl SET allowed=false,building_ids=$1 WHERE permission='deposits.view'", [[BUILDING]]);
  await assert.rejects(viaGate(env), code('42501'), 'mất khoá');
}));

test('báo cáo khác KHÔNG đổi: chỉ reservation_vouchers khai rls_buildings; báo cáo rows giữ ctx.buildings = toà của khoá ∩ kết nối', () => inCase(async env => {
  assert.deepEqual(Object.entries(W2.reports).filter(([, spec]) => spec.scope === 'rls_buildings').map(([reportId]) => reportId), ['reservation_vouchers']);
  const catalog = (await env.db.query('SELECT app_private.hermes_w2_catalog_v1(NULL) spec')).rows[0].spec;
  assert.deepEqual(Object.entries(catalog).filter(([, spec]) => spec.scope === 'rls_buildings').map(([reportId]) => reportId), ['reservation_vouchers']);
  await orgOverlay(env);
  for (const key of KEYS) await env.db.query('UPDATE public.fixture_acl SET building_ids=$2 WHERE permission=$1', [key, [BUILDING]]);
  const defaults = { invoice_detail: { invoiceId: INVOICE_A }, collection: { month: '2026-10' }, change_ledger: { cashbookId: CHANGE_BOOK } };
  for (const report of Object.keys(W2A_REPORTS).filter(report => report !== 'reservation_vouchers')) {
    const value = await env.report(report, { ...Object.fromEntries(W2A_REPORTS[report].params.map(name => [name, null])), ...defaults[report] }, { limit: 50 });
    assert.deepEqual(value.fence.buildings, [BUILDING], `${report}: ctx.buildings = toà của khoá ∩ kết nối`);
  }
  assert.deepEqual([...(await viaGate(env)).fence.buildings].sort(), [BUILDING, OTHER_BUILDING].sort(), 'đối chứng: rls_buildings');
}));

test('cổng thật rls_buildings: hơn 256 toà trong phạm vi kết nối ⇒ 22023 hermes_domain_scope_too_large (trần toà của cổng)', () => inCase(async env => {
  await orgOverlay(env);
  await onlyDepositsAt(env, [BUILDING]);
  assert.equal((await viaGate(env)).fence.buildings.length, 2, 'đối chứng: 2 toà');
  await addBuildings(env, 254);
  assert.equal((await viaGate(env)).fence.buildings.length, 256, 'đúng 256 toà: được');
  await addBuildings(env, 1, 254);
  await assert.rejects(viaGate(env), error => error.code === '22023' && error.message === 'hermes_domain_scope_too_large', '257 toà');
}));

test('trần 2000 hàng: cắt ở 2000, sourceCapped; tổng trên toàn nguồn (RPC web)', () => inCase(async env => {
  await env.db.exec(`INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,account_id,voucher_date,total_amount,approval_status)
      SELECT ('0a0a0a0a-0000-4000-8001-'||lpad(g::text,12,'0'))::uuid,'${ORG}','${STRANGER}','PT-N'||g,'INCOME','Cọc','${OTHER_BUILDING}','${FUND_MINE}','2026-09-01',1000,'APPROVED'
      FROM generate_series(1,2000) g;
    INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,amount,unit_price,quantity)
      SELECT ('0a0a0a0a-0000-4000-8001-'||lpad(g::text,12,'0'))::uuid,'${DEPOSIT_TYPE}',1000,1000,1 FROM generate_series(1,2000) g;`);
  const value = await direct(env);
  assert.deepEqual([value.rows.length, value.sourceCapped], [2000, true]);
  assert.deepEqual(norm(value.summary), await webSummary(env));
  assert.equal(value.summary.approvedCount, 2002, 'RV1 + phiếu sổ B + 2000 phiếu mới');
}));

// Đột biến: thay từng chỗ của migration trong ca rồi chạy lại đúng hàm bị đổi ⇒ phép thử (true = sai) phải đổi từ false sang true.
const mutate = async (env, from, to) => {
  const source = POST.includes(from) ? POST : GATE;
  assert.equal(source.split(from).length, 2, `anchor: ${from}`);
  for (const statement of changedFunctions(source, source.replace(from, () => to))) await env.db.exec(statement);
};
// Toà tổng hợp của công ty kết nối (id dải 0a0a0a0a-…-8002-…); kết nối Toàn tổ chức phủ mọi toà công ty.
const addBuildings = (env, count, offset = 0) => env.db.query(`INSERT INTO public.buildings(id,organization_id,name,is_virtual,deleted_at)
  SELECT ('0a0a0a0a-0000-4000-8002-'||lpad(g::text,12,'0'))::uuid,$1,'Toà trần '||g,false,null FROM generate_series($2::int+1,$2::int+$3::int) g ON CONFLICT (id) DO NOTHING`,
  [ORG, offset, count]);
const fundViaOrgGate = async env => { await orgOverlay(env); await onlyDepositsAt(env, [BUILDING]); return ids((await viaGate(env)).items); };
const probes = [
  { name: 'cổng: giao lại tập toà của khoá (bản 000700)', from: "AND (v_scope='rls_buildings' OR state->'buildingIds' ? b.id::text)",
    to: "AND state->'buildingIds' ? b.id::text", run: async env => !(await fundViaOrgGate(env)).includes(RV_FUND) },
  { name: 'cổng: bỏ đòi khoá ở ít nhất một toà', from: "        OR jsonb_array_length(state->'buildingIds')=0 AND state->'orgWide' IS DISTINCT FROM 'true'::jsonb\n", to: '',
    run: async env => { await orgOverlay(env); await onlyDepositsAt(env, []); return viaGate(env).then(() => true, () => false); } },
  { name: 'cổng: bỏ trần 256 toà của rls_buildings',
    from: "      IF cardinality(buildings)>256 THEN RAISE EXCEPTION 'hermes_domain_scope_too_large' USING ERRCODE='22023'; END IF;\n", to: '',
    run: async env => { await orgOverlay(env); await onlyDepositsAt(env, [BUILDING]); await addBuildings(env, 255);
      return viaGate(env).then(() => true, () => false); } },
  { name: 'cổng: bỏ thu hẹp theo phạm vi kết nối', from: "      v_scope:='rows';\n",
    to: "      SELECT array_agg(b.id ORDER BY b.id) INTO buildings FROM public.buildings b WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL;\n      v_scope:='rows';\n",
    run: async env => ids((await viaGate(env)).items).includes(RV_FUND) },
  { name: 'hàm đọc: giao lại toà buildings.view cho phiếu cọc giữ chỗ (bản Z)',
    from: "WHERE p_report='reservation_vouchers' OR public.has_full_building_scope()", to: 'WHERE public.has_full_building_scope()',
    run: async env => !ids((await direct(env)).rows).includes(RV_FUND) },
  { name: 'hàm dùng chung: giao lại toà theo deposits.view (bản gói A)',
    from: '    AND (p_building_ids IS NULL OR ie.building_id=ANY(p_building_ids));',
    to: "    AND (p_building_ids IS NULL OR ie.building_id=ANY(p_building_ids)) AND public.can_do_on_building('deposits','view',ie.building_id);",
    run: async env => { await onlyDepositsAt(env, [BUILDING]); return !(await sharedIds(env)).includes(RV_FUND); } },
  { name: 'hàm dùng chung: bỏ lọc công ty', from: '  WHERE ie.organization_id=p_organization_id AND ie.contract_id IS NULL', to: '  WHERE ie.contract_id IS NULL',
    run: async env => {
      await env.db.exec(`INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,account_id,voucher_date,total_amount,approval_status)
        VALUES('${RV_FOREIGN}','${FOREIGN}','${STRANGER}','PT-F','INCOME','Cọc công ty khác','${OTHER_BUILDING}','${FUND_MINE}','2026-10-15',1,'APPROVED')
        ON CONFLICT (id) DO NOTHING;
        INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,amount,unit_price,quantity)
        SELECT '${RV_FOREIGN}','${DEPOSIT_TYPE}',1,1,1 WHERE NOT EXISTS(SELECT 1 FROM public.income_expense_items WHERE income_expense_id='${RV_FOREIGN}');`);
      return (await sharedIds(env)).includes(RV_FOREIGN);
    } },
  { name: 'hàm dùng chung: bỏ khoá trang', from: "  IF NOT public.can_access_org_entity('deposits','view') THEN RETURN; END IF;\n", to: '',
    run: async env => { await env.db.exec("UPDATE public.fixture_acl SET allowed=false WHERE permission='deposits.view'"); return (await sharedIds(env)).length > 0; } },
  { name: 'hàm đọc: không thu hẹp theo ctx.buildings', from: 'FROM public.deposit_reservation_vouchers_v1(v_org,v_b) v', to: 'FROM public.deposit_reservation_vouchers_v1(v_org,NULL) v',
    run: async env => ids((await direct(env, {}, { buildings: [BUILDING] })).rows).includes(RV_FUND) },
  { name: 'hàm đọc: tổng trên tập khác ctx.buildings', from: 'v_raw:=public.get_reservation_deposit_summary(v_b);', to: 'v_raw:=public.get_reservation_deposit_summary(NULL);',
    run: async env => (await direct(env, {}, { buildings: [BUILDING] })).summary.approvedCount !== 1 },
  { name: 'hàm đọc: trả người nộp', from: "          'payerName',NULL,\n          'depositAmount',v.deposit_amount::text",
    to: "          'payerName',v.payer_name,\n          'depositAmount',v.deposit_amount::text",
    run: async env => (await direct(env)).rows.some(row => row.payerName !== null) },
  { name: 'hàm đọc: trả tên phiếu', from: "'code',v.code,'name',NULL,", to: "'code',v.code,'name',v.name,",
    run: async env => (await direct(env)).rows.some(row => row.name !== null) },
];
for (const probe of probes) {
  test(`mutation is caught: ${probe.name}`, () => inCase(async env => {
    assert.equal(await probe.run(env), false, 'bản sửa: phép thử không sai');
    await mutate(env, probe.from, probe.to);
    assert.equal(await probe.run(env), true, 'bản đột biến: phép thử sai');
  }));
}
