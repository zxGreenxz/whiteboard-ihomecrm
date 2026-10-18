import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedW2a, BUILDING, USER, ORG, CUSTOMER_C, INVOICE_A, INV_C_PAID, INV_C_REV, CONTRACT_FULL, STRANGER, CHANGE_BOOK, L1 } from './wave2-a-sql-fixture.mjs';
import { changedFunctions } from './full-read-sql-fixture.mjs';
import { W2A_REPORTS } from './wave2-a-contract.mjs';

// Gói Z — bản sửa tích hợp của Gói A (hàm đọc 20261018080100_hermes_w2z_receivables_pii_v1; Thu tiền ở hàm dùng chung
// 20261018080000_hermes_w2z_shared_fixes_v1) trên harness Gói A + dải Z. MỘT
// PGlite cho cả file, mỗi ca BEGIN … ROLLBACK. Gọi thẳng hàm đọc gói bằng vai authenticated (public.fixture_w2a_read của
// fixture, ctx như cổng dựng), hàm dùng chung gọi như web. Đột biến: đưa từng chỗ sửa về thân cũ trong ca ⇒ ca phải đỏ.
// Dữ liệu tổng hợp; RLS là RLS giả lập của fixture (chủ hồ sơ khách theo fixture_visible_owners).
const Z = readFileSync('supabase/migrations/20261018080100_hermes_w2z_receivables_pii_v1.sql', 'utf8');
const SHARED = readFileSync('supabase/migrations/20261018080000_hermes_w2z_shared_fixes_v1.sql', 'utf8');
const KEYS = [...new Set(Object.values(W2A_REPORTS).map(spec => spec.permission))];
let shared;
before(async () => { shared = await sharedW2a({ packages: ['a', 'z'] }); });
after(async () => { await shared?.close(); });
const inCase = work => shared.isolated(async env => { await env.grant(KEYS); return work(env); });
const params = (report, values = {}) => ({ ...Object.fromEntries(W2A_REPORTS[report].params.map(name => [name, null])), ...values });
const CTX = { organizationId: ORG, userId: USER, report: null, permission: null, scope: 'rows', buildings: [BUILDING], requestedBuildingId: null,
  overlayOrg: false, orgWide: false, isSuperadmin: false, today: '2026-10-16', scopes: { 'customers.view': [BUILDING] } };
const direct = (env, report, values = {}) => env.call('SELECT public.fixture_w2a_read($1,$2::jsonb,$3::jsonb) result',
  [report, JSON.stringify(params(report, values)), JSON.stringify({ ...CTX, report })]);
// Đột biến trong ca: thay một đoạn của file Z rồi chạy lại đúng các hàm bị đổi.
const mutate = async (env, from, to) => {
  const source = Z.includes(from) ? Z : SHARED;
  assert.equal(source.split(from).length, 2, `anchor: ${from}`);
  for (const statement of changedFunctions(source, source.replace(from, () => to))) await env.db.exec(statement);
};
const showStranger = env => env.db.query('INSERT INTO public.fixture_visible_owners VALUES($1) ON CONFLICT DO NOTHING', [STRANGER]);

test('Z-A: định nghĩa sống là bản Z (chuỗi a + z)', () => inCase(async ({ db }) => {
  const src = (await db.query("SELECT prosrc FROM pg_proc WHERE oid='app_private.hermes_w2a_read_v1(text,jsonb,jsonb)'::regprocedure")).rows[0].prosrc;
  assert.ok(src.includes('v_inv_text'), 'hàm đọc gói A = bản Z');
  const thu = (await db.query("SELECT prosrc FROM pg_proc WHERE oid='public.thu_tien_collection_v1(uuid,text,date,date,date,uuid[])'::regprocedure")).rows[0].prosrc;
  assert.ok(thu.includes('p.reversed_at IS NULL'));
}));

test('Z-A invoice_detail: HĐ hai khách, một khách bị RLS ẩn ⇒ không ghi chú hoá đơn; mọi khách thấy ⇒ có; tên khách thấy được giữ', () => inCase(async env => {
  const { db } = env;
  // INV_C_PAID gắn CONTRACT_FULL: CUSTOMER_C (nhìn thấy) + khách đại diện thuộc chủ hồ sơ ngoài phạm vi (RLS ẩn).
  await db.query('UPDATE public.invoices SET notes=$1 WHERE id=$2', ['PII-SYNTHETIC-NOTE 0977000000', INV_C_PAID]);
  const visibleName = (await db.query('SELECT full_name FROM public.customers WHERE id=$1', [CUSTOMER_C])).rows[0].full_name;
  let value = await direct(env, 'invoice_detail', { invoiceId: INV_C_PAID });
  assert.deepEqual([value.summary.found, value.summary.notes, value.summary.customerName], [true, null, visibleName], 'một khách bị ẩn ⇒ không ghi chú');
  assert.ok(!JSON.stringify(value).includes('PII-SYNTHETIC'), 'chuỗi PII không có trong kết quả');
  assert.ok(value.rows.filter(row => row.kind === 'voucher').every(row => row.label === null), 'tên phiếu cùng rào');
  // Đối chứng: hoá đơn của HĐ chỉ có khách nhìn thấy ⇒ ghi chú vẫn trả.
  assert.equal((await direct(env, 'invoice_detail', { invoiceId: INVOICE_A })).summary.notes, 'Khách hẹn trả cuối tháng');
  await showStranger(env);
  value = await direct(env, 'invoice_detail', { invoiceId: INV_C_PAID });
  assert.equal(value.summary.notes, 'PII-SYNTHETIC-NOTE 0977000000', 'mọi khách của HĐ nhìn thấy ⇒ trả ghi chú');
  // Hoá đơn không gắn HĐ: không có khách để đối chiếu ⇒ không ghi chú (như bản gói A).
  await db.query('UPDATE public.invoices SET notes=$1 WHERE id=$2', ['PII-SYNTHETIC-NOTE', INV_C_REV]);
  assert.equal((await direct(env, 'invoice_detail', { invoiceId: INV_C_REV })).summary.notes, null);
}));

test('Z-A change_ledger: phiếu thối nối HĐ có khách bị RLS ẩn ⇒ không người nộp/ghi chú; mọi khách thấy ⇒ có', () => inCase(async env => {
  const { db } = env;
  const VOUCHER = '0a0a0a0a-0000-4000-8000-0000000002a1';
  await db.query(`INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,voucher_date,total_amount,approval_status,
      contract_id,payer_name,notes,change_account_id,change_amount,has_restricted_item)
    VALUES($1,$2,$3,'PT-Z1','INCOME','Thu có thối Z',$4,'2026-10-12',400000,'APPROVED',$5,'Khách Ẩn Chủ','SĐT 0977000000',$6,4000,false)`,
  [VOUCHER, ORG, USER, BUILDING, CONTRACT_FULL, CHANGE_BOOK]);
  let rows = (await direct(env, 'change_ledger', { cashbookId: CHANGE_BOOK })).rows;
  const row = id => rows.find(item => item.voucherId === id);
  assert.ok(row(VOUCHER), 'phiếu có trong sổ');
  assert.deepEqual([row(VOUCHER).payerName, row(VOUCHER).notes], [null, null], 'HĐ có khách bị ẩn ⇒ không chữ tự do');
  assert.deepEqual([row(L1).payerName, row(L1).notes], ['Khách Lẻ', 'thối 5k'], 'đối chứng: HĐ chỉ có khách nhìn thấy');
  assert.ok(!JSON.stringify(rows).includes('0977000000'));
  await showStranger(env);
  rows = (await direct(env, 'change_ledger', { cashbookId: CHANGE_BOOK })).rows;
  assert.deepEqual([row(VOUCHER).payerName, row(VOUCHER).notes], ['Khách Ẩn Chủ', 'SĐT 0977000000']);
}));

test('Z-A collection (theo web #209): khoản thu đã hoàn tác không còn là tiền đã thu', () => inCase(async env => {
  // Hôm nay 16/10: P102 thu 2tr (còn hiệu lực), P104 có khoản 800k thu rồi hoàn tác cùng ngày ⇒ web (lọc reversed_at) coi P104 chưa thu.
  const value = await direct(env, 'collection', { month: '2026-10', fromDate: '2026-10-16', toDate: '2026-10-16' });
  assert.deepEqual([value.summary.collectedSum, value.summary.paidRooms, value.summary.dueRooms], ['2000000', 1, 3]);
  const p104 = value.rows.find(item => item.invoiceId === INV_C_REV);
  assert.deepEqual([p104.collectedInRange, p104.collectStatus], ['0', 'unpaid']);
  assert.deepEqual((await direct(env, 'collection', { month: '2026-10', fromDate: '2026-10-16', toDate: '2026-10-16', status: 'paid' })).rows.map(item => item.invoiceId),
    [INV_C_PAID], 'tab Đã thu hôm nay không còn P104');
  // Cả kỳ đọc paid_amount của hoá đơn như web (không đổi).
  assert.equal((await direct(env, 'collection', { month: '2026-10' })).summary.collectedSum, '3000000.00');
  // Như web: hàm dùng chung gọi thẳng (vai authenticated) cũng bỏ khoản hoàn tác.
  const shared = await env.call(`SELECT COALESCE(jsonb_agg(t.collected_in_range ORDER BY t.invoice_id),'[]'::jsonb) result
    FROM public.thu_tien_collection_v1($1,'2026-10','2026-10-16','2026-10-16','2026-10-16') t WHERE t.invoice_id=$2`, [ORG, INV_C_REV]);
  assert.deepEqual(shared.map(Number), [0]);
}));

// Đột biến: từng chỗ sửa Z về thân cũ ⇒ phép thử tương ứng phải lọt dữ liệu / sai số.
const probes = [
  { name: 'invoice_detail: bỏ điều kiện mọi khách nhìn thấy', from: 'v_inv_text:=v_inv_cust AND COALESCE(v_inv_text,false);', to: 'v_inv_text:=v_inv_cust;',
    run: async env => { await env.db.query('UPDATE public.invoices SET notes=$1 WHERE id=$2', ['PII-SYNTHETIC-NOTE', INV_C_PAID]);
      return (await direct(env, 'invoice_detail', { invoiceId: INV_C_PAID })).summary.notes === 'PII-SYNTHETIC-NOTE'; } },
  { name: 'change_ledger: chỉ cần một khách nhìn thấy (bản gói A)', from: 'SELECT count(*)>0 AND count(*)=count(cu.id)\n          FROM public.income_expenses src',
    to: 'SELECT count(cu.id)>0\n          FROM public.income_expenses src',
    run: async env => { await env.db.query(`INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,voucher_date,total_amount,
        approval_status,contract_id,payer_name,notes,change_account_id,change_amount,has_restricted_item)
      VALUES('0a0a0a0a-0000-4000-8000-0000000002a2',$1,$2,'PT-Z2','INCOME','Z',$3,'2026-10-12',1,'APPROVED',$4,'Khách Ẩn Chủ','SĐT',$5,1,false)
      ON CONFLICT (id) DO NOTHING`,
      [ORG, USER, BUILDING, CONTRACT_FULL, CHANGE_BOOK]);
      return (await direct(env, 'change_ledger', { cashbookId: CHANGE_BOOK })).rows.some(item => item.payerName === 'Khách Ẩn Chủ'); } },
  { name: 'collection: cộng cả khoản đã hoàn tác (bản gói A)', from: 'WHERE p.invoice_id=i.id AND p.reversed_at IS NULL) pay', to: 'WHERE p.invoice_id=i.id) pay',
    run: async env => (await direct(env, 'collection', { month: '2026-10', fromDate: '2026-10-16', toDate: '2026-10-16' })).summary.collectedSum === '2800000' },
];
for (const probe of probes) {
  test(`mutation is caught: Z-A ${probe.name}`, () => inCase(async env => {
    assert.equal(await probe.run(env), false, 'bản Z: phép thử không lọt');
    await mutate(env, probe.from, probe.to);
    assert.equal(await probe.run(env), true, 'bản đột biến: phép thử lọt');
  }));
}
