#!/usr/bin/env node
/**
 * SEED P0 — nền phi-tiền cho demo docs:
 *   KV DEMO + Tòa DEMO A (3 tầng × 5 phòng) + Tòa DEMO B (4 phòng)
 *   + 4 dịch vụ DEMO + building_services + 38 công tơ + 3 sổ quỹ DEMO
 *   + 2 loại thu chi DEMO + 5 demo staff (auth user + profile + staff_assignments scoped).
 *
 * Chạy:  DEMO_PW=<mật khẩu demo staff> node scripts/docs-demo/seed-p0.mjs
 * Toàn bộ insert DB gói trong 1 request = 1 transaction (all-or-nothing).
 * Idempotent guard: abort nếu đã có buildings code DEMO%.
 */
import { runSql, gotrueAdmin, sqlLit as L, OWNER_ID } from './lib.mjs'

const PW = process.env.DEMO_PW
if (!PW) { console.error('Thiếu env DEMO_PW'); process.exit(1) }

// ===== 0. Guards =====
const existing = await runSql(`SELECT code FROM buildings WHERE code LIKE 'DEMO%';`)
if (existing?.length) { console.error('Đã có tòa DEMO — chạy cleanup trước.'); process.exit(1) }
const role = await runSql(
  `SELECT id FROM roles WHERE user_id = '${OWNER_ID}' AND name = 'Quản Lý Tòa' LIMIT 1;`
)
if (!role?.length) { console.error('Không tìm thấy role "Quản Lý Tòa" của owner'); process.exit(1) }

// ===== 1. Tạo 5 demo staff qua GoTrue Admin =====
const STAFF = [
  { u: 'demo.quanly', name: 'DEMO Quản Lý', job: 'Quản lý tòa' },
  { u: 'demo.ketoan', name: 'DEMO Kế Toán', job: 'Kế toán' },
  { u: 'demo.sale', name: 'DEMO Sale', job: 'Sale' },
  { u: 'demo.kythuat', name: 'DEMO Kỹ Thuật', job: 'Kỹ thuật' },
  { u: 'demo.codong', name: 'DEMO Cổ Đông', job: 'Cổ đông' },
]
for (const s of STAFF) {
  const email = `${s.u}@username.ihomecrm.local`
  const r = await gotrueAdmin('/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password: PW,
      email_confirm: true,
      user_metadata: { username: s.u, full_name: s.name, job_title: s.job },
    }),
  })
  if (r.status === 200 || r.status === 201) console.log(`✓ user ${s.u}`)
  else if (r.status === 422 && /already/i.test(JSON.stringify(r.body))) console.log(`• user ${s.u} đã tồn tại`)
  else { console.error(`✗ tạo ${s.u} fail:`, r.status, JSON.stringify(r.body).slice(0, 300)); process.exit(1) }
}

// Lấy uuid + đảm bảo profiles đủ tên (trigger handle_new_user có thể đã tạo)
const users = await runSql(
  `SELECT id, email FROM auth.users WHERE email LIKE 'demo.%@username.ihomecrm.local';`
)
const uid = (u) => users.find((x) => x.email.startsWith(u + '@'))?.id
for (const s of STAFF) if (!uid(s.u)) { console.error(`Thiếu uuid cho ${s.u}`); process.exit(1) }
await runSql(
  STAFF.map(
    (s) => `INSERT INTO profiles (id, full_name, job_title, is_active)
      VALUES ('${uid(s.u)}', ${L(s.name)}, ${L(s.job)}, true)
      ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, job_title = EXCLUDED.job_title;`
  ).join('\n')
)
console.log('✓ profiles 5 demo staff')

// ===== 2. Seed cấu trúc (1 transaction) =====
const O = `'${OWNER_ID}'`
const DESC = '[DEMO-DOCS] Dữ liệu demo cho tài liệu hướng dẫn — sẽ dọn sạch, không dùng thật'

// Phòng: A101..A105 (T1) 3.5tr | A201..A205 (T2) 4tr | A301..A305 (T3) 4.5tr | B101..B104 5tr
const rooms = []
for (let f = 1; f <= 3; f++)
  for (let i = 1; i <= 5; i++)
    rooms.push({ b: 'DEMOA', name: `A${f}0${i}`, floor: f, price: 3000000 + f * 500000 })
for (let i = 1; i <= 4; i++) rooms.push({ b: 'DEMOB', name: `B10${i}`, floor: 1, price: 5000000 })

const roomValues = rooms
  .map(
    (r) => `((SELECT id FROM buildings WHERE code = '${r.b}'), ${L(r.name)}, ${r.floor}, ${r.price}, ${r.price}, 22, 3, ${L(DESC)})`
  )
  .join(',\n  ')

// Công tơ: mỗi phòng 1 điện + 1 nước
const meterValues = rooms
  .flatMap((r) => [
    `('DEMO-${r.name}-D', 'ELECTRICITY', (SELECT id FROM services WHERE name = 'DEMO Điện' AND user_id = ${O}), (SELECT id FROM buildings WHERE code = '${r.b}'), (SELECT id FROM rooms WHERE name = ${L(r.name)} AND building_id = (SELECT id FROM buildings WHERE code = '${r.b}')), 1000, ${O})`,
    `('DEMO-${r.name}-N', 'WATER', (SELECT id FROM services WHERE name = 'DEMO Nước' AND user_id = ${O}), (SELECT id FROM buildings WHERE code = '${r.b}'), (SELECT id FROM rooms WHERE name = ${L(r.name)} AND building_id = (SELECT id FROM buildings WHERE code = '${r.b}')), 100, ${O})`,
  ])
  .join(',\n  ')

// staff_assignments: 4 staff (trừ cổ đông) × 2 tòa, role Quản Lý Tòa + snapshot permissions
const assignees = ['demo.quanly', 'demo.ketoan', 'demo.sale', 'demo.kythuat']
const assignValues = assignees
  .flatMap((u) =>
    ['DEMOA', 'DEMOB'].map(
      (b) => `('${uid(u)}', ${O}, (SELECT id FROM roles WHERE user_id = ${O} AND name = 'Quản Lý Tòa' LIMIT 1), (SELECT id FROM buildings WHERE code = '${b}'), (SELECT permissions FROM roles WHERE user_id = ${O} AND name = 'Quản Lý Tòa' LIMIT 1))`
    )
  )
  .join(',\n  ')

const SQL = `
-- Khu vực
INSERT INTO areas (name, code, description, user_id)
VALUES ('KV DEMO — Hướng Dẫn', 'KVDEMO', ${L(DESC)}, ${O});

-- 2 tòa demo
INSERT INTO buildings (name, code, province, district, ward, street_address, description, total_floors, user_id)
VALUES
  ('Tòa DEMO A', 'DEMOA', 'TP. Hồ Chí Minh', 'Quận 1', 'Phường Bến Nghé', '999 Đường Hướng Dẫn', ${L(DESC)}, 3, ${O}),
  ('Tòa DEMO B', 'DEMOB', 'TP. Hồ Chí Minh', 'Quận 1', 'Phường Bến Nghé', '998 Đường Hướng Dẫn', ${L(DESC)}, 1, ${O});

-- Gắn khu vực
INSERT INTO area_buildings (area_id, building_id, user_id)
SELECT a.id, b.id, ${O} FROM areas a, buildings b
WHERE a.code = 'KVDEMO' AND b.code IN ('DEMOA', 'DEMOB');

-- 19 phòng
INSERT INTO rooms (building_id, name, floor, rent_price, deposit_amount, area, max_occupants, description)
VALUES
  ${roomValues};

-- 4 dịch vụ demo (org-level, owner)
INSERT INTO services (name, code, type, fee_type, pricing_type, unit, unit_price, user_id)
VALUES
  ('DEMO Điện', 'DEMODIEN', 'METER_READING', 'TIEN_DIEN', 'DON_GIA_CO_DINH_DONG_HO', 'kWh', 3500, ${O}),
  ('DEMO Nước', 'DEMONUOC', 'METER_READING', 'TIEN_NUOC', 'DON_GIA_CO_DINH_DONG_HO', 'm3', 15000, ${O}),
  ('DEMO Rác', 'DEMORAC', 'PER_ROOM', 'TIEN_VE_SINH', 'DON_GIA_THEO_PHONG', 'phòng', 30000, ${O}),
  ('DEMO Giữ Xe', 'DEMOXE', 'PER_PERSON', 'TIEN_PHI_KHAC', 'DON_GIA_THEO_NGUOI', 'xe', 100000, ${O});

-- Gắn dịch vụ vào 2 tòa
INSERT INTO building_services (building_id, service_id)
SELECT b.id, s.id FROM buildings b, services s
WHERE b.code IN ('DEMOA', 'DEMOB') AND s.name LIKE 'DEMO %' AND s.user_id = ${O};

-- 38 công tơ (điện + nước mỗi phòng)
INSERT INTO meters (code, meter_type, service_id, building_id, room_id, initial_reading, user_id)
VALUES
  ${meterValues};

-- 3 sổ quỹ demo (KHÔNG set is_default — tránh hijack sổ thật của owner)
INSERT INTO accounts (code, name, bank_name, account_number, description, user_id)
VALUES
  ('DEMO01', 'DEMO Ngân Hàng', 'Techcombank (demo)', '9990000001', ${L(DESC)}, ${O}),
  ('DEMO02', 'DEMO Quản Lý Thu', NULL, NULL, ${L(DESC)}, '${uid('demo.quanly')}'),
  ('DEMO03', 'DEMO Sale Thu', NULL, NULL, ${L(DESC)}, '${uid('demo.sale')}');

-- Route TT/TK của 2 tòa demo về sổ demo
UPDATE buildings
SET default_account_id_tt = (SELECT id FROM accounts WHERE code = 'DEMO01'),
    default_account_id_tk = (SELECT id FROM accounts WHERE code = 'DEMO01')
WHERE code IN ('DEMOA', 'DEMOB');

-- 2 loại thu chi demo
INSERT INTO income_expense_types (name, type, description, user_id, is_restricted)
VALUES
  ('DEMO Thu Khác', 'income', ${L(DESC)}, ${O}, false),
  ('DEMO Chi Đặc Biệt', 'expense', ${L(DESC)}, ${O}, true);

-- Scope 4 demo staff vào 2 tòa demo (role Quản Lý Tòa + snapshot quyền)
INSERT INTO staff_assignments (staff_id, user_id, role_id, building_id, permissions)
VALUES
  ${assignValues};
`

await runSql(SQL)
console.log('✓ Seed cấu trúc xong (1 transaction)')

// ===== 3. Báo cáo tổng =====
const report = await runSql(`
SELECT 'buildings' AS t, count(*)::int AS n FROM buildings WHERE code LIKE 'DEMO%'
UNION ALL SELECT 'rooms', count(*)::int FROM rooms WHERE building_id IN (SELECT id FROM buildings WHERE code LIKE 'DEMO%')
UNION ALL SELECT 'services', count(*)::int FROM services WHERE name LIKE 'DEMO %'
UNION ALL SELECT 'building_services', count(*)::int FROM building_services WHERE building_id IN (SELECT id FROM buildings WHERE code LIKE 'DEMO%')
UNION ALL SELECT 'meters', count(*)::int FROM meters WHERE building_id IN (SELECT id FROM buildings WHERE code LIKE 'DEMO%')
UNION ALL SELECT 'accounts', count(*)::int FROM accounts WHERE code LIKE 'DEMO%'
UNION ALL SELECT 'ie_types', count(*)::int FROM income_expense_types WHERE name LIKE 'DEMO %'
UNION ALL SELECT 'staff_assignments', count(*)::int FROM staff_assignments WHERE staff_id IN (SELECT id FROM auth.users WHERE email LIKE 'demo.%@username.ihomecrm.local')
UNION ALL SELECT 'auth users', count(*)::int FROM auth.users WHERE email LIKE 'demo.%@username.ihomecrm.local';
`)
console.table(report)
