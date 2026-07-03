#!/usr/bin/env node
/**
 * SEED P2 — vòng đời khách hàng (fixture "triển lãm" backdate, ngày-tương-đối):
 *   khách hàng + tenant + hợp đồng đủ trạng thái + cọc giữ chỗ + lead + xe + CT01.
 * Chạy dưới tenant demo (demo.chunha). Idempotent-ish: xoá dữ liệu P2 cũ của tenant demo trước.
 *
 * Ngày tương đối theo hôm nay để fixture "sắp hết hạn" không ôi.
 * Chạy: node scripts/docs-demo/seed-p2.mjs
 */
import { runSql, sqlLit as L } from './lib.mjs'

// Lấy demo owner id
const ownerRow = await runSql(`SELECT id FROM auth.users WHERE email = 'demo.chunha@username.ihomecrm.local';`)
const OWNER = ownerRow?.[0]?.id
if (!OWNER) { console.error('Chưa có demo.chunha — chạy seed-p0 trước'); process.exit(1) }
const O = `'${OWNER}'`

// Ngày tương đối
const d = (offsetDays) => {
  const base = new Date('2026-07-03T00:00:00Z') // mốc cố định (Date.now bị chặn ở workflow; script thường OK nhưng dùng mốc cho ổn định)
  base.setUTCDate(base.getUTCDate() + offsetDays)
  return base.toISOString().slice(0, 10)
}

const rid = (name) => `(SELECT id FROM rooms WHERE name = '${name}' AND building_id = (SELECT id FROM buildings WHERE code = ${name.startsWith('B') ? "'DEMOB'" : "'DEMOA'"}))`

// ===== 0. Dọn dữ liệu P2 cũ của tenant demo (giữ cấu trúc P0) =====
await runSql(`
CREATE TEMP TABLE _du ON COMMIT DROP AS SELECT id FROM auth.users WHERE email LIKE 'demo.%@username.ihomecrm.local';
DELETE FROM vehicles WHERE user_id IN (SELECT id FROM _du);
DELETE FROM ct01_declarations WHERE user_id IN (SELECT id FROM _du);
DELETE FROM contract_extensions WHERE contract_id IN (SELECT id FROM contracts WHERE user_id IN (SELECT id FROM _du));
DELETE FROM deposits WHERE user_id IN (SELECT id FROM _du);
DELETE FROM contracts WHERE user_id IN (SELECT id FROM _du);
DELETE FROM leads WHERE user_id IN (SELECT id FROM _du);
DELETE FROM tenants WHERE user_id IN (SELECT id FROM _du);
DELETE FROM customers WHERE user_id IN (SELECT id FROM _du);
`)
console.log('✓ Dọn dữ liệu P2 cũ')

// ===== 1. Khách hàng + tenant (cùng tên) =====
const people = [
  { k: 'A', name: 'Nguyễn Văn An', phone: '0900000001', cccd: '079090000001' },
  { k: 'B', name: 'Trần Thị Bình', phone: '0900000002', cccd: '079090000002' },
  { k: 'C', name: 'Lê Văn Cường', phone: '0900000003', cccd: '079090000003' },
  { k: 'D', name: 'Phạm Thị Dung', phone: '0900000004', cccd: '079090000004' },
  { k: 'E', name: 'Hoàng Văn Em', phone: '0900000005', cccd: '079090000005' },
  { k: 'F', name: 'Võ Thị Phương', phone: '0900000006', cccd: '079090000006' },
  { k: 'G', name: 'Đặng Văn Giang', phone: '0900000007', cccd: '079090000007' },
]
await runSql(
  people
    .map(
      (p) => `INSERT INTO customers (full_name, phone, id_type, id_number, customer_type, status, user_id, notes)
        VALUES (${L('DEMO ' + p.name)}, ${L(p.phone)}, 'CCCD', ${L(p.cccd)}, 'INDIVIDUAL', 'ACTIVE', ${O}, '[DEMO-DOCS]');
      INSERT INTO tenants (full_name, phone, id_type, id_number, user_id, notes)
        VALUES (${L('DEMO ' + p.name)}, ${L(p.phone)}, 'CCCD', ${L(p.cccd)}, ${O}, '[DEMO-DOCS]');`
    )
    .join('\n')
)
console.log('✓ 7 khách hàng + 7 tenant')

const tid = (name) => `(SELECT id FROM tenants WHERE full_name = ${L('DEMO ' + name)} AND user_id = ${O} LIMIT 1)`

// ===== 2. Hợp đồng đủ trạng thái =====
// [phòng, tenant, signed(offset), start(offset), end(offset), rent, deposit, paid, status, discounts, notes]
const contracts = [
  { room: 'A101', p: 'Nguyễn Văn An', signed: -400, start: -400, end: 330, rent: 3500000, dep: 3500000, paid: 3500000, st: 'ACTIVE', note: 'HĐ lâu năm, cọc đủ' },
  { room: 'A102', p: 'Trần Thị Bình', signed: -5, start: -5, end: 360, rent: 4000000, dep: 4000000, paid: 2000000, st: 'ACTIVE', note: 'Mới ký, cọc còn thiếu 2.000.000đ' },
  { room: 'A103', p: 'Lê Văn Cường', signed: -344, start: -344, end: 21, rent: 4500000, dep: 4500000, paid: 4500000, st: 'ACTIVE', note: 'Sắp hết hạn (~21 ngày)' },
  { room: 'A104', p: 'Phạm Thị Dung', signed: -700, start: -700, end: 300, rent: 4500000, dep: 4500000, paid: 4500000, st: 'ACTIVE', note: 'Đã gia hạn 1 lần' },
  { room: 'A105', p: 'Hoàng Văn Em', signed: -60, start: -60, end: 300, rent: 4500000, dep: 4500000, paid: 4500000, st: 'ACTIVE', disc: '[{"type":"percent","value":10,"note":"Khuyến mãi tháng đầu"}]', note: 'Có khuyến mãi + nợ cũ' },
  { room: 'A201', p: 'Võ Thị Phương', signed: -2, start: 3, end: 368, rent: 4000000, dep: 4000000, paid: 0, st: 'DRAFT', note: 'Chờ duyệt' },
  { room: 'B101', p: 'Đặng Văn Giang', signed: -30, start: -30, end: 335, rent: 5000000, dep: 5000000, paid: 5000000, st: 'ACTIVE', note: 'HĐ toà B, dùng cho chu kỳ hoá đơn' },
]
await runSql(
  contracts
    .map(
      (c) => `INSERT INTO contracts (user_id, tenant_id, room_id, signed_date, start_date, end_date, rent_price, payment_cycle, status, total_deposit, deposit_paid, discounts, notes)
        VALUES (${O}, ${tid(c.p)}, ${rid(c.room)}, '${d(c.signed)}', '${d(c.start)}', '${d(c.end)}', ${c.rent}, 'MONTHLY', '${c.st}', ${c.dep}, ${c.paid}, ${c.disc ? `'${c.disc}'::jsonb` : "'[]'::jsonb"}, ${L('[DEMO-DOCS] ' + c.note)});`
    )
    .join('\n')
)
console.log('✓ 7 hợp đồng (ACTIVE lâu năm/mới ký thiếu cọc/sắp hết hạn/đã gia hạn/KM/chờ duyệt/toà B)')

// ===== 3. Gia hạn cho A104 (extension_type UPDATE_EXISTING; new_end > old_end) =====
await runSql(`
WITH c AS (SELECT ct.id, ct.end_date FROM contracts ct
  WHERE ct.user_id=${O} AND ct.room_id=${rid('A104')})
INSERT INTO contract_extensions (user_id, contract_id, extension_date, extension_type, old_end_date, extension_months, new_end_date, status, notes)
SELECT ${O}, c.id, (c.end_date - INTERVAL '6 months')::date, 'UPDATE_EXISTING',
  (c.end_date - INTERVAL '6 months')::date, 6, c.end_date, 'COMPLETED', '[DEMO-DOCS] Gia hạn 6 tháng' FROM c;`)
console.log('✓ Gia hạn A104')

// ===== 4. Cọc giữ chỗ cho A301, A302 (chưa có HĐ) =====
await runSql(`
INSERT INTO deposits (user_id, tenant_id, room_id, amount, deposit_date, status, hold_until, notes)
VALUES
  (${O}, ${tid('Võ Thị Phương')}, ${rid('A301')}, 4500000, '${d(-3)}', 'CONFIRMED', '${d(11)}', '[DEMO-DOCS] Cọc giữ chỗ đủ tiền'),
  (${O}, ${tid('Đặng Văn Giang')}, ${rid('A302')}, 2000000, '${d(-20)}', 'CONFIRMED', '${d(-2)}', '[DEMO-DOCS] Cọc giữ chỗ quá hạn/thiếu');
`)
console.log('✓ 2 cọc giữ chỗ (A301 đủ, A302 quá hạn)')

// ===== 5. Phòng bảo trì A305 =====
await runSql(`UPDATE rooms SET status = 'MAINTENANCE' WHERE name = 'A305' AND building_id = (SELECT id FROM buildings WHERE code = 'DEMOA');`)
console.log('✓ A305 bảo trì')

// ===== 6. Leads đủ giai đoạn =====
await runSql(`
INSERT INTO leads (user_id, customer_name, phone, source, status, building_id, notes)
VALUES
  (${O}, 'DEMO Khách Tiềm Năng 1', '0900000011', 'FACEBOOK', 'B1_LEAD', (SELECT id FROM buildings WHERE code='DEMOA'), '[DEMO-DOCS] Mới vào'),
  (${O}, 'DEMO Khách Tiềm Năng 2', '0900000012', 'ZALO', 'B2_APPOINTMENT', (SELECT id FROM buildings WHERE code='DEMOA'), '[DEMO-DOCS] Đã hẹn xem'),
  (${O}, 'DEMO Khách Tiềm Năng 3', '0900000013', 'PHONE', 'B3_CONSULTATION', (SELECT id FROM buildings WHERE code='DEMOB'), '[DEMO-DOCS] Đang tư vấn'),
  (${O}, 'DEMO Khách Tiềm Năng 4', '0900000014', 'REFERRAL', 'CONVERTED', (SELECT id FROM buildings WHERE code='DEMOA'), '[DEMO-DOCS] Đã chốt cọc'),
  (${O}, 'DEMO Khách Tiềm Năng 5', '0900000015', 'WALK_IN', 'FAILED', (SELECT id FROM buildings WHERE code='DEMOB'), '[DEMO-DOCS] Không thuê');
`)
console.log('✓ 5 lead đủ giai đoạn')

// ===== 7. Xe =====
await runSql(`
INSERT INTO vehicles (user_id, tenant_id, vehicle_type, license_plate, owner_name, parking_fee, building_id, room_id, notes)
VALUES
  (${O}, ${tid('Nguyễn Văn An')}, 'MOTORBIKE', '59-X1 123.45', 'DEMO Nguyễn Văn An', 100000, (SELECT id FROM buildings WHERE code='DEMOA'), ${rid('A101')}, '[DEMO-DOCS]'),
  (${O}, ${tid('Đặng Văn Giang')}, 'CAR', '51H-678.90', 'DEMO Đặng Văn Giang', 1200000, (SELECT id FROM buildings WHERE code='DEMOB'), ${rid('B101')}, '[DEMO-DOCS]');
`)
console.log('✓ 2 xe')

// ===== 8. CT01 cho 1 khách =====
await runSql(`
INSERT INTO ct01_declarations (user_id, customer_id, registration_authority, full_name, date_of_birth, gender, id_number, permanent_address)
VALUES (${O}, (SELECT id FROM customers WHERE full_name = 'DEMO Nguyễn Văn An' AND user_id=${O} LIMIT 1),
  'Công an Phường Bến Nghé', 'DEMO Nguyễn Văn An', '1995-05-20', 'Nam', '079090000001', 'Tòa DEMO A, 999 Đường Hướng Dẫn, Q1, TP.HCM');
`)
console.log('✓ 1 hồ sơ CT01')

// ===== Báo cáo =====
const rep = await runSql(`
SELECT 'contracts' t, count(*)::int n FROM contracts WHERE user_id=${O}
UNION ALL SELECT 'customers', count(*)::int FROM customers WHERE user_id=${O}
UNION ALL SELECT 'tenants', count(*)::int FROM tenants WHERE user_id=${O}
UNION ALL SELECT 'deposits', count(*)::int FROM deposits WHERE user_id=${O}
UNION ALL SELECT 'leads', count(*)::int FROM leads WHERE user_id=${O}
UNION ALL SELECT 'vehicles', count(*)::int FROM vehicles WHERE user_id=${O}
UNION ALL SELECT 'rooms OCCUPIED', count(*)::int FROM rooms WHERE building_id IN (SELECT id FROM buildings WHERE user_id=${O}) AND status='OCCUPIED'
UNION ALL SELECT 'rooms RESERVED', count(*)::int FROM rooms WHERE building_id IN (SELECT id FROM buildings WHERE user_id=${O}) AND status='RESERVED'
UNION ALL SELECT 'rooms MAINTENANCE', count(*)::int FROM rooms WHERE building_id IN (SELECT id FROM buildings WHERE user_id=${O}) AND status='MAINTENANCE';
`)
console.table(rep)
