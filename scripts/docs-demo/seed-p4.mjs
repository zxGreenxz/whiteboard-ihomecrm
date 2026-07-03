#!/usr/bin/env node
/**
 * SEED P4 — thanh lý & tài chính nâng cao:
 *   + 2 HĐ ACTIVE A202 (cọc đủ → move-out trả cọc) & A203 (còn nợ → forfeit giữ cọc)
 *   + 2 cổ đông 60/40 trên Tòa DEMO A (chia lợi nhuận)
 *   + vài giao dịch ví cá nhân (demo.chunha)
 * Chạy sau seed-p3. node scripts/docs-demo/seed-p4.mjs
 */
import { runSql, sqlLit as L } from './lib.mjs'

const ownerRow = await runSql(`SELECT id FROM auth.users WHERE email='demo.chunha@username.ihomecrm.local';`)
const OWNER = ownerRow?.[0]?.id
if (!OWNER) { console.error('Chưa có demo.chunha'); process.exit(1) }
const O = `'${OWNER}'`
const rid = (n) => `(SELECT id FROM rooms WHERE name='${n}' AND building_id=(SELECT id FROM buildings WHERE code='${n.startsWith('B') ? 'DEMOB' : 'DEMOA'}'))`
const bid = (c) => `(SELECT id FROM buildings WHERE code='${c}')`
const d = (off) => { const b = new Date('2026-07-03T00:00:00Z'); b.setUTCDate(b.getUTCDate() + off); return b.toISOString().slice(0, 10) }

// ===== 0. Dọn P4 cũ =====
await runSql(`
CREATE TEMP TABLE _du ON COMMIT DROP AS SELECT id FROM auth.users WHERE email LIKE 'demo.%@username.ihomecrm.local';
DELETE FROM building_shareholders WHERE user_id IN (SELECT id FROM _du);
DELETE FROM shareholders WHERE user_id IN (SELECT id FROM _du);
DELETE FROM personal_transactions WHERE user_id IN (SELECT id FROM _du);
DELETE FROM notifications WHERE contract_id IN (SELECT id FROM contracts WHERE user_id IN (SELECT id FROM _du) AND room_id IN (${rid('A202')}, ${rid('A203')}));
DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE room_id IN (${rid('A202')}, ${rid('A203')}));
DELETE FROM invoices WHERE room_id IN (${rid('A202')}, ${rid('A203')});
DELETE FROM contracts WHERE user_id IN (SELECT id FROM _du) AND room_id IN (${rid('A202')}, ${rid('A203')});
DELETE FROM tenants WHERE user_id IN (SELECT id FROM _du) AND full_name IN ('DEMO Bùi Thị Hoa','DEMO Ngô Văn Ích');
DELETE FROM customers WHERE user_id IN (SELECT id FROM _du) AND full_name IN ('DEMO Bùi Thị Hoa','DEMO Ngô Văn Ích');
`)
console.log('✓ Dọn P4 cũ')

// ===== 1. 2 khách + tenant cho A202/A203 =====
const p = [
  { name: 'Bùi Thị Hoa', phone: '0900000008', cccd: '079090000008' },
  { name: 'Ngô Văn Ích', phone: '0900000009', cccd: '079090000009' },
]
await runSql(p.map((x) => `
  INSERT INTO customers (full_name, phone, id_type, id_number, customer_type, status, user_id, notes) VALUES (${L('DEMO ' + x.name)}, ${L(x.phone)}, 'CCCD', ${L(x.cccd)}, 'INDIVIDUAL', 'ACTIVE', ${O}, '[DEMO-DOCS]');
  INSERT INTO tenants (full_name, phone, id_type, id_number, user_id, notes) VALUES (${L('DEMO ' + x.name)}, ${L(x.phone)}, 'CCCD', ${L(x.cccd)}, ${O}, '[DEMO-DOCS]');`).join('\n'))
const tid = (name) => `(SELECT id FROM tenants WHERE full_name=${L('DEMO ' + name)} AND user_id=${O} LIMIT 1)`
console.log('✓ 2 khách + tenant (A202, A203)')

// ===== 2. 2 HĐ ACTIVE =====
await runSql(`
INSERT INTO contracts (user_id, tenant_id, room_id, signed_date, start_date, end_date, rent_price, payment_cycle, status, total_deposit, deposit_paid, notes) VALUES
  (${O}, ${tid('Bùi Thị Hoa')}, ${rid('A202')}, '${d(-200)}', '${d(-200)}', '${d(160)}', 4000000, 'MONTHLY', 'ACTIVE', 4000000, 4000000, '[DEMO-DOCS] Cọc đủ — dùng cho thanh lý RỜI PHÒNG (trả cọc)'),
  (${O}, ${tid('Ngô Văn Ích')}, ${rid('A203')}, '${d(-150)}', '${d(-150)}', '${d(210)}', 4000000, 'MONTHLY', 'ACTIVE', 4000000, 4000000, '[DEMO-DOCS] Còn nợ — dùng cho thanh lý BỎ CỌC (giữ cọc trừ nợ)');
`)
console.log('✓ 2 HĐ ACTIVE (A202 trả cọc, A203 giữ cọc)')

// ===== 3. HĐ A203 có 1 hoá đơn quá hạn (để forfeit có nợ) =====
const r = await runSql(`
INSERT INTO invoices (user_id, contract_id, building_id, room_id, billing_month, issue_date, due_date, status, subtotal, total_amount, notes)
VALUES (${O}, (SELECT id FROM contracts WHERE user_id=${O} AND room_id=${rid('A203')} AND status='ACTIVE' LIMIT 1), ${bid('DEMOA')}, ${rid('A203')}, '2026-06', '2026-06-01', '2026-06-15', 'OVERDUE', 4570000, 4570000, '[DEMO-DOCS] A203 nợ quá hạn') RETURNING id;`)
await runSql(`INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, amount, sort_order) VALUES
  ('${r[0].id}', 'RENT', 'Tiền nhà tháng 6/2026', 4000000, 1, 4000000, 1),
  ('${r[0].id}', 'SERVICE', 'Điện nước rác', 570000, 1, 570000, 2);`)
console.log('✓ A203 có hoá đơn quá hạn 4.570.000đ')

// ===== 4. 2 cổ đông 60/40 trên Tòa DEMO A =====
const s1 = await runSql(`INSERT INTO shareholders (user_id, name, is_active, note) VALUES (${O}, 'DEMO Cổ Đông Xuân', true, '[DEMO-DOCS]') RETURNING id;`)
const s2 = await runSql(`INSERT INTO shareholders (user_id, name, is_active, note) VALUES (${O}, 'DEMO Cổ Đông Yến', true, '[DEMO-DOCS]') RETURNING id;`)
await runSql(`
INSERT INTO building_shareholders (user_id, building_id, shareholder_id, percent) VALUES
  (${O}, ${bid('DEMOA')}, '${s1[0].id}', 60),
  (${O}, ${bid('DEMOA')}, '${s2[0].id}', 40);`)
console.log('✓ 2 cổ đông (Xuân 60% / Yến 40% trên Tòa DEMO A)')

// ===== 5. Ví cá nhân demo.chunha =====
await runSql(`
INSERT INTO personal_transactions (user_id, type, amount, description, txn_date, category) VALUES
  (${O}, 'INCOME', 2000000, 'DEMO Tiền thưởng cá nhân', '2026-07-01', 'Thu nhập'),
  (${O}, 'EXPENSE', 350000, 'DEMO Ăn trưa', '2026-07-02', 'Ăn uống'),
  (${O}, 'EXPENSE', 1200000, 'DEMO Đổ xăng xe', '2026-07-02', 'Đi lại');`)
console.log('✓ 3 giao dịch ví cá nhân')

// ===== Báo cáo =====
const rep = await runSql(`
SELECT 'contracts A202/A203' t, count(*)::int n FROM contracts WHERE user_id=${O} AND room_id IN (${rid('A202')}, ${rid('A203')})
UNION ALL SELECT 'shareholders', count(*)::int FROM shareholders WHERE user_id=${O}
UNION ALL SELECT 'building_shareholders', count(*)::int FROM building_shareholders WHERE user_id=${O}
UNION ALL SELECT 'personal_transactions', count(*)::int FROM personal_transactions WHERE user_id=${O}
UNION ALL SELECT 'rooms OCCUPIED', count(*)::int FROM rooms WHERE building_id IN (SELECT id FROM buildings WHERE user_id=${O}) AND status='OCCUPIED';`)
console.table(rep)
