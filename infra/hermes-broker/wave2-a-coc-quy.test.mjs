import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedW2a, BUILDING, OTHER_BUILDING, OTHER_ROOM, USER, ORG, FOREIGN, STRANGER, DEPOSIT_TYPE, RV1, RV2, RV3, RV_SETTLED, RV_B } from './wave2-a-sql-fixture.mjs';
import { ORG_SCOPE } from './wave2-sql-fixture.mjs';
import { changedFunctions } from './full-read-sql-fixture.mjs';
import { W2A_REPORTS } from './wave2-a-contract.mjs';

// Gói A sau phát hành (19/10/2026, migration 20261018182656_hermes_w2a_reservation_fund_member_v1): phiếu cọc giữ chỗ
// (reservation_vouchers) = ĐÚNG tập web thấy dưới RLS income_expenses — kể cả phiếu vào sổ quỹ người hỏi giữ (policy sổ quỹ,
// không theo toà) — thu hẹp theo ctx.buildings (toà có deposits.view ∩ phạm vi kết nối). MỘT PGlite cho cả file, mỗi ca
// BEGIN … ROLLBACK. Tình huống: người hỏi giữ sổ quỹ ở toà B nhưng KHÔNG có buildings.view ở B (RLS rbac ẩn mọi phiếu
// khác của B). "Tập web" = câu chép đúng bộ lọc của useReservationDeposits chạy dưới RLS (vai authenticated). RLS là RLS
// giả lập của fixture (f_rbac theo toà + f_fund theo sổ người hỏi giữ); không chứng minh policy/JWT/PostgREST thật — phần
// đó so trên TEST. Đột biến: thay từng chỗ của migration trong ca ⇒ phép thử phải đổi kết quả.
const POST = readFileSync('supabase/migrations/20261018182656_hermes_w2a_reservation_fund_member_v1.sql', 'utf8');
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

test('cổng thật (public.hermes_w2_read_v1): kết nối chỉ toà A ⇒ không phiếu B; Toàn tổ chức + deposits.view ở B ⇒ có phiếu sổ của mình; không deposits.view ở B ⇒ KHÔNG trả (web vẫn hiện)', () => inCase(async env => {
  let gate = await env.report('reservation_vouchers', params(), { limit: 50 });
  assert.deepEqual(gate.fence, { buildings: [BUILDING], cashbooks: [], orgWide: false });
  assert.deepEqual(ids(gate.items), [RV2, RV1, RV_SETTLED, RV3], 'phạm vi kết nối thu hẹp: chỉ toà A');
  await orgOverlay(env);
  gate = await env.report('reservation_vouchers', params(), { limit: 50 });
  assert.deepEqual([...gate.fence.buildings].sort(), [BUILDING, OTHER_BUILDING].sort());
  assert.deepEqual(ids(gate.items), await webIds(env), 'kết nối Toàn tổ chức, deposits.view ở A+B: đúng tập web');
  assert.deepEqual(norm(gate.summary), await webSummary(env));
  // Toà ngoài ctx.buildings (không có deposits.view ở B): web vẫn hiện phiếu vào sổ của mình ở B (route web không theo toà),
  // Hermes KHÔNG trả — ctx.buildings của cổng lấy từ khoá deposits.view theo toà; giữ nguyên, ghi ở web-parity.json.
  await onlyDepositsAt(env, [BUILDING]);
  gate = await env.report('reservation_vouchers', params(), { limit: 50 });
  assert.deepEqual(gate.fence.buildings, [BUILDING]);
  assert.ok((await webIds(env)).includes(RV_FUND), 'web hiện');
  assert.ok(!ids(gate.items).includes(RV_FUND), 'Hermes không trả phiếu ở toà ngoài ctx.buildings');
  assert.deepEqual(norm(gate.summary), await webSummary(env, [BUILDING]), 'tổng trên đúng tập toà đã giao');
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
  assert.equal(POST.split(from).length, 2, `anchor: ${from}`);
  for (const statement of changedFunctions(POST, POST.replace(from, () => to))) await env.db.exec(statement);
};
const probes = [
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
