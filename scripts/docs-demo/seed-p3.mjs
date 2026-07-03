#!/usr/bin/env node
/**
 * SEED P3 — chu kỳ tiền tháng:
 *   chỉ số điện/nước (tháng này) + hoá đơn đủ trạng thái + payment + phiếu thu chi.
 * Tòa A = triển lãm (đã thu/quá hạn/thu một phần); Tòa B = bài tập (chưa thu → để người học tự thu rồi reset).
 * Chạy: node scripts/docs-demo/seed-p3.mjs  (chạy sau seed-p2)
 */
import { runSql, sqlLit as L } from './lib.mjs'

const ownerRow = await runSql(`SELECT id FROM auth.users WHERE email='demo.chunha@username.ihomecrm.local';`)
const OWNER = ownerRow?.[0]?.id
if (!OWNER) { console.error('Chưa có demo.chunha'); process.exit(1) }
const O = `'${OWNER}'`

const monthStart = '2026-07-01' // ngày (issue/due/voucher)
const billingMonth = '2026-07'  // billing_month text định dạng YYYY-MM

const rid = (name) => `(SELECT id FROM rooms WHERE name='${name}' AND building_id=(SELECT id FROM buildings WHERE code='${name.startsWith('B') ? 'DEMOB' : 'DEMOA'}'))`
const cid = (name) => `(SELECT id FROM contracts WHERE user_id=${O} AND room_id=${rid(name)} AND status='ACTIVE' LIMIT 1)`
const bid = (name) => `(SELECT id FROM buildings WHERE code='${name.startsWith('B') ? 'DEMOB' : 'DEMOA'}')`
const meter = (name, kind) => `(SELECT id FROM meters WHERE code='DEMO-${name}-${kind}')`

// ===== 0. Dọn P3 cũ =====
await runSql(`
CREATE TEMP TABLE _du ON COMMIT DROP AS SELECT id FROM auth.users WHERE email LIKE 'demo.%@username.ihomecrm.local';
DELETE FROM notifications WHERE invoice_id IN (SELECT id FROM invoices WHERE user_id IN (SELECT id FROM _du));
DELETE FROM income_expense_items WHERE income_expense_id IN (SELECT id FROM income_expenses WHERE user_id IN (SELECT id FROM _du));
DELETE FROM income_expenses WHERE user_id IN (SELECT id FROM _du);
DELETE FROM payments WHERE user_id IN (SELECT id FROM _du);
DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE user_id IN (SELECT id FROM _du));
DELETE FROM invoices WHERE user_id IN (SELECT id FROM _du);
DELETE FROM meter_readings WHERE user_id IN (SELECT id FROM _du);
`)
console.log('✓ Dọn P3 cũ')

// ===== 1. Chỉ số điện/nước tháng này cho các phòng có HĐ (điện +120, nước +8) =====
const readRooms = ['A101', 'A102', 'A103', 'A104', 'A105', 'B101']
await runSql(
  readRooms
    .flatMap((r) => [
      `INSERT INTO meter_readings (user_id, meter_id, current_reading, reading_date, meter_type, status, notes) VALUES (${O}, ${meter(r, 'D')}, 1120, '${monthStart}', 'ELECTRICITY', 'APPROVED', '[DEMO-DOCS]');`,
      `INSERT INTO meter_readings (user_id, meter_id, current_reading, reading_date, meter_type, status, notes) VALUES (${O}, ${meter(r, 'N')}, 108, '${monthStart}', 'WATER', 'APPROVED', '[DEMO-DOCS]');`,
    ])
    .join('\n')
)
console.log('✓ Chỉ số điện/nước tháng này (6 phòng × 2)')

// ===== 2. Hoá đơn đủ trạng thái =====
// tiền: RENT + điện(120×3500=420k) + nước(8×15000=120k) + rác 30k ≈ rent+570k
// [phòng, status, dueOffset(ngày so với 1/7), paid(0/partial/full)]
const invoices = [
  { room: 'A101', rent: 3500000, status: 'PAID', bm: billingMonth, issue: monthStart, due: '2026-07-10', pay: 4070000 },
  { room: 'A102', rent: 4000000, status: 'PARTIAL_PAID', bm: billingMonth, issue: monthStart, due: '2026-07-10', pay: 2000000 },
  { room: 'A103', rent: 4500000, status: 'PAID', bm: billingMonth, issue: monthStart, due: '2026-07-10', pay: 5070000 },
  { room: 'A105', rent: 4500000, status: 'OVERDUE', bm: '2026-06', issue: '2026-06-01', due: '2026-06-15', pay: 0, prevDebt: 1000000 },
  { room: 'B101', rent: 5000000, status: 'APPROVED', bm: billingMonth, issue: monthStart, due: '2026-07-15', pay: 0 },
]
for (const inv of invoices) {
  const svc = 570000 // điện+nước+rác gộp cho gọn
  const total = inv.rent + svc + (inv.prevDebt || 0)
  const r = await runSql(`
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, billing_month, issue_date, due_date, status, subtotal, total_amount, previous_debt, notes)
    VALUES (${O}, ${cid(inv.room)}, ${bid(inv.room)}, ${rid(inv.room)}, '${inv.bm}', '${inv.issue}', '${inv.due}', '${inv.status}', ${inv.rent + svc}, ${total}, ${inv.prevDebt || 0}, '[DEMO-DOCS] ${inv.room}')
    RETURNING id;`)
  const invId = r[0].id
  await runSql(`
    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, amount, sort_order) VALUES
      ('${invId}', 'RENT', 'Tiền nhà tháng 7/2026', ${inv.rent}, 1, ${inv.rent}, 1),
      ('${invId}', 'SERVICE', 'Tiền điện (120 kWh)', 3500, 120, 420000, 2),
      ('${invId}', 'SERVICE', 'Tiền nước (8 m3)', 15000, 8, 120000, 3),
      ('${invId}', 'SERVICE', 'Tiền rác', 30000, 1, 30000, 4);`)
  if (inv.pay > 0) {
    await runSql(`INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes) VALUES (${O}, '${invId}', ${inv.pay}, 'TM', '${monthStart}', '[DEMO-DOCS] Thu tiền');`)
  }
  console.log(`  ✓ HĐ ${inv.room} ${inv.status} (total ${total.toLocaleString('vi')}đ, đã thu ${inv.pay.toLocaleString('vi')}đ)`)
}

// ===== 3. Phiếu thu chi standalone (không gắn hoá đơn) =====
const typeInc = `(SELECT id FROM income_expense_types WHERE name='DEMO Thu Khác' AND user_id=${O} LIMIT 1)`
const typeExp = `(SELECT id FROM income_expense_types WHERE name='DEMO Chi Đặc Biệt' AND user_id=${O} LIMIT 1)`
const acc = `(SELECT id FROM accounts WHERE code='DEMO01')`
const r1 = await runSql(`INSERT INTO income_expenses (user_id, type, name, building_id, voucher_date, total_amount, approval_status, account_id, payer_name, notes)
  VALUES (${O}, 'EXPENSE', 'DEMO Chi sửa chữa tháng 7', ${bid('A101')}, '${monthStart}', 500000, 'APPROVED', ${acc}, 'Thợ sửa demo', '[DEMO-DOCS]') RETURNING id;`)
await runSql(`INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, amount) VALUES ('${r1[0].id}', ${typeExp}, 'Sửa vòi nước A101', 1, 500000, 500000);`)
const r2 = await runSql(`INSERT INTO income_expenses (user_id, type, name, building_id, voucher_date, total_amount, approval_status, account_id, payer_name, notes)
  VALUES (${O}, 'INCOME', 'DEMO Thu phí phạt trễ hạn', ${bid('B101')}, '${monthStart}', 200000, 'APPROVED', ${acc}, 'DEMO Đặng Văn Giang', '[DEMO-DOCS]') RETURNING id;`)
await runSql(`INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, amount) VALUES ('${r2[0].id}', ${typeInc}, 'Phí phạt', 1, 200000, 200000);`)
console.log('✓ 2 phiếu thu chi standalone (1 chi sửa chữa, 1 thu phí phạt)')

// ===== Báo cáo =====
const rep = await runSql(`
SELECT 'meter_readings' t, count(*)::int n FROM meter_readings WHERE user_id=${O}
UNION ALL SELECT 'invoices', count(*)::int FROM invoices WHERE user_id=${O}
UNION ALL SELECT 'invoice PAID', count(*)::int FROM invoices WHERE user_id=${O} AND status='PAID'
UNION ALL SELECT 'invoice PARTIAL', count(*)::int FROM invoices WHERE user_id=${O} AND status='PARTIAL_PAID'
UNION ALL SELECT 'invoice OVERDUE', count(*)::int FROM invoices WHERE user_id=${O} AND status='OVERDUE'
UNION ALL SELECT 'invoice chưa thu', count(*)::int FROM invoices WHERE user_id=${O} AND status='APPROVED'
UNION ALL SELECT 'payments', count(*)::int FROM payments WHERE user_id=${O}
UNION ALL SELECT 'income_expenses', count(*)::int FROM income_expenses WHERE user_id=${O};
`)
console.table(rep)
