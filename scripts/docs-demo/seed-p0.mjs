#!/usr/bin/env node
/**
 * SEED P0 v2 — nền demo dưới TENANT RIÊNG (demo owner `demo.chunha`):
 *   demo.chunha (owner) + 5 demo staff + clone 2 role template (BỎ module salary —
 *   ~15 RPC lương hardcode owner thật; staff còn bỏ thêm users) + KV DEMO
 *   + Tòa DEMO A (3 tầng × 5 phòng) + Tòa DEMO B (4 phòng) + 4 dịch vụ + 38 công tơ
 *   + 3 sổ quỹ + 2 loại thu chi + staff_assignments per-building.
 *
 * AN TOÀN TENANT (theo biên bản hội đồng 2026-07-03):
 *   - demo.chunha KHÔNG BAO GIỜ vào super_admins / role tên 'Admin' (policy admin XUYÊN tenant)
 *   - KHÔNG BAO GIỜ tạo assignment full-scope (building_id+area_id đều NULL = thấy MỌI tòa)
 *
 * Chạy:  DEMO_PW=<mật khẩu demo> node scripts/docs-demo/seed-p0.mjs
 * Idempotent guard: abort nếu đã có buildings code DEMO%.
 */
import { runSql, gotrueAdmin, sqlLit as L, OWNER_ID } from './lib.mjs'

const PW = process.env.DEMO_PW
if (!PW) { console.error('Thiếu env DEMO_PW'); process.exit(1) }

// ===== 0. Guards =====
const existing = await runSql(`SELECT code FROM buildings WHERE code LIKE 'DEMO%';`)
if (existing?.length) { console.error('Đã có tòa DEMO — chạy cleanup-demo.mjs --execute trước.'); process.exit(1) }
const tpl = await runSql(
  `SELECT name FROM roles WHERE user_id = '${OWNER_ID}' AND name IN ('Quản Lý Tòa', 'Viewer');`
)
if ((tpl?.length ?? 0) < 2) { console.error('Thiếu role template gốc của owner thật'); process.exit(1) }

// ===== 1. Tạo demo owner + 5 demo staff qua GoTrue Admin =====
const USERS = [
  { u: 'demo.chunha', name: 'DEMO Chủ Nhà', job: 'Chủ nhà (demo)' },
  { u: 'demo.quanly', name: 'DEMO Quản Lý', job: 'Quản lý tòa' },
  { u: 'demo.ketoan', name: 'DEMO Kế Toán', job: 'Kế toán' },
  { u: 'demo.sale', name: 'DEMO Sale', job: 'Sale' },
  { u: 'demo.kythuat', name: 'DEMO Kỹ Thuật', job: 'Kỹ thuật' },
  { u: 'demo.codong', name: 'DEMO Cổ Đông', job: 'Cổ đông' },
]
for (const s of USERS) {
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

const users = await runSql(
  `SELECT id, email FROM auth.users WHERE email LIKE 'demo.%@username.ihomecrm.local';`
)
const uid = (u) => users.find((x) => x.email.startsWith(u + '@'))?.id
for (const s of USERS) if (!uid(s.u)) { console.error(`Thiếu uuid cho ${s.u}`); process.exit(1) }
const DEMO_OWNER = uid('demo.chunha')

await runSql(
  USERS.map(
    (s) => `INSERT INTO profiles (id, full_name, job_title, is_active)
      VALUES ('${uid(s.u)}', ${L(s.name)}, ${L(s.job)}, true)
      ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, job_title = EXCLUDED.job_title;`
  ).join('\n')
)
console.log(`✓ profiles 6 user demo (owner = ${DEMO_OWNER})`)

// ===== 2. Seed cấu trúc (1 transaction) =====
const O = `'${DEMO_OWNER}'`
const REAL = `'${OWNER_ID}'`
const DESC = '[DEMO-DOCS] Dữ liệu demo cho tài liệu hướng dẫn — sandbox, có nút reset'

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

const meterValues = rooms
  .flatMap((r) => [
    `('DEMO-${r.name}-D', 'ELECTRICITY', (SELECT id FROM services WHERE name = 'DEMO Điện' AND user_id = ${O}), (SELECT id FROM buildings WHERE code = '${r.b}'), (SELECT id FROM rooms WHERE name = ${L(r.name)} AND building_id = (SELECT id FROM buildings WHERE code = '${r.b}')), 1000, ${O})`,
    `('DEMO-${r.name}-N', 'WATER', (SELECT id FROM services WHERE name = 'DEMO Nước' AND user_id = ${O}), (SELECT id FROM buildings WHERE code = '${r.b}'), (SELECT id FROM rooms WHERE name = ${L(r.name)} AND building_id = (SELECT id FROM buildings WHERE code = '${r.b}')), 100, ${O})`,
  ])
  .join(',\n  ')

// Quyền: owner giữ users.* (demo trang phân quyền), staff bỏ users.*; TẤT CẢ bỏ salary.*
const ROLE_QL = `(SELECT id FROM roles WHERE user_id = ${O} AND name = 'Quản Lý Tòa' LIMIT 1)`
const ROLE_VIEWER = `(SELECT id FROM roles WHERE user_id = ${O} AND name = 'Viewer' LIMIT 1)`
const PERM_OWNER = `(SELECT permissions FROM roles WHERE user_id = ${O} AND name = 'Quản Lý Tòa' LIMIT 1)`
const PERM_STAFF = `(SELECT permissions - 'users' FROM roles WHERE user_id = ${O} AND name = 'Quản Lý Tòa' LIMIT 1)`
const PERM_VIEWER = `(SELECT permissions FROM roles WHERE user_id = ${O} AND name = 'Viewer' LIMIT 1)`

const assignRows = []
for (const b of ['DEMOA', 'DEMOB']) {
  const bid = `(SELECT id FROM buildings WHERE code = '${b}')`
  assignRows.push(`('${DEMO_OWNER}', ${O}, ${ROLE_QL}, ${bid}, ${PERM_OWNER})`)
  for (const u of ['demo.quanly', 'demo.ketoan', 'demo.sale', 'demo.kythuat'])
    assignRows.push(`('${uid(u)}', ${O}, ${ROLE_QL}, ${bid}, ${PERM_STAFF})`)
  assignRows.push(`('${uid('demo.codong')}', ${O}, ${ROLE_VIEWER}, ${bid}, ${PERM_VIEWER})`)
}

const SQL = `
-- Clone 2 role template sang tenant demo, BỎ module salary (RPC lương hardcode owner thật).
-- CẢNH BÁO: không bao giờ đổi role demo thành tên 'Admin' hoặc thêm "__superadmin"
-- (policy is_admin() xuyên tenant — sẽ thành god-mode đọc dữ liệu thật).
INSERT INTO roles (name, user_id, permissions, is_system)
SELECT r.name, ${O}, r.permissions - 'salary', false
FROM roles r WHERE r.user_id = ${REAL} AND r.name IN ('Quản Lý Tòa', 'Viewer');

INSERT INTO areas (name, code, description, user_id)
VALUES ('KV DEMO — Hướng Dẫn', 'KVDEMO', ${L(DESC)}, ${O});

INSERT INTO buildings (name, code, province, district, ward, street_address, description, total_floors, user_id)
VALUES
  ('Tòa DEMO A', 'DEMOA', 'TP. Hồ Chí Minh', 'Quận 1', 'Phường Bến Nghé', '999 Đường Hướng Dẫn', ${L(DESC)}, 3, ${O}),
  ('Tòa DEMO B', 'DEMOB', 'TP. Hồ Chí Minh', 'Quận 1', 'Phường Bến Nghé', '998 Đường Hướng Dẫn', ${L(DESC)}, 1, ${O});

INSERT INTO area_buildings (area_id, building_id, user_id)
SELECT a.id, b.id, ${O} FROM areas a, buildings b
WHERE a.code = 'KVDEMO' AND b.code IN ('DEMOA', 'DEMOB');

INSERT INTO rooms (building_id, name, floor, rent_price, deposit_amount, area, max_occupants, description)
VALUES
  ${roomValues};

INSERT INTO services (name, code, type, fee_type, pricing_type, unit, unit_price, user_id)
VALUES
  ('DEMO Điện', 'DEMODIEN', 'METER_READING', 'TIEN_DIEN', 'DON_GIA_CO_DINH_DONG_HO', 'kWh', 3500, ${O}),
  ('DEMO Nước', 'DEMONUOC', 'METER_READING', 'TIEN_NUOC', 'DON_GIA_CO_DINH_DONG_HO', 'm3', 15000, ${O}),
  ('DEMO Rác', 'DEMORAC', 'PER_ROOM', 'TIEN_VE_SINH', 'DON_GIA_THEO_PHONG', 'phòng', 30000, ${O}),
  ('DEMO Giữ Xe', 'DEMOXE', 'PER_PERSON', 'TIEN_PHI_KHAC', 'DON_GIA_THEO_NGUOI', 'xe', 100000, ${O});

INSERT INTO building_services (building_id, service_id)
SELECT b.id, s.id FROM buildings b, services s
WHERE b.code IN ('DEMOA', 'DEMOB') AND s.name LIKE 'DEMO %' AND s.user_id = ${O};

INSERT INTO meters (code, meter_type, service_id, building_id, room_id, initial_reading, user_id)
VALUES
  ${meterValues};

-- KHÔNG set is_default: sổ demo thuộc tenant demo, auto-pick theo tên '%Thu' của từng user
INSERT INTO accounts (code, name, bank_name, account_number, description, user_id)
VALUES
  ('DEMO01', 'DEMO Ngân Hàng', 'Techcombank (demo)', '9990000001', ${L(DESC)}, ${O}),
  ('DEMO02', 'DEMO Quản Lý Thu', NULL, NULL, ${L(DESC)}, '${uid('demo.quanly')}'),
  ('DEMO03', 'DEMO Sale Thu', NULL, NULL, ${L(DESC)}, '${uid('demo.sale')}');

UPDATE buildings
SET default_account_id_tt = (SELECT id FROM accounts WHERE code = 'DEMO01'),
    default_account_id_tk = (SELECT id FROM accounts WHERE code = 'DEMO01')
WHERE code IN ('DEMOA', 'DEMOB');

INSERT INTO income_expense_types (name, type, description, user_id, is_restricted)
VALUES
  ('DEMO Thu Khác', 'income', ${L(DESC)}, ${O}, false),
  ('DEMO Chi Đặc Biệt', 'expense', ${L(DESC)}, ${O}, true);

-- Per-building ONLY (full-scope = thấy mọi tòa trong DB, kể cả tòa thật)
INSERT INTO staff_assignments (staff_id, user_id, role_id, building_id, permissions)
VALUES
  ${assignRows.join(',\n  ')};
`

await runSql(SQL)
console.log('✓ Seed cấu trúc dưới tenant demo xong (1 transaction)')

// ===== 3. Báo cáo + tripwire =====
const report = await runSql(`
SELECT 'buildings (demo owner)' AS t, count(*)::int AS n FROM buildings WHERE user_id = ${O}
UNION ALL SELECT 'rooms', count(*)::int FROM rooms WHERE building_id IN (SELECT id FROM buildings WHERE code LIKE 'DEMO%')
UNION ALL SELECT 'services', count(*)::int FROM services WHERE user_id = ${O}
UNION ALL SELECT 'meters', count(*)::int FROM meters WHERE user_id = ${O}
UNION ALL SELECT 'accounts', count(*)::int FROM accounts WHERE code LIKE 'DEMO%'
UNION ALL SELECT 'ie_types', count(*)::int FROM income_expense_types WHERE user_id = ${O}
UNION ALL SELECT 'roles (clone)', count(*)::int FROM roles WHERE user_id = ${O}
UNION ALL SELECT 'staff_assignments', count(*)::int FROM staff_assignments WHERE user_id = ${O}
UNION ALL SELECT 'TRIPWIRE super_admins demo (phải =0)', count(*)::int FROM super_admins WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE 'demo.%@username.ihomecrm.local')
UNION ALL SELECT 'TRIPWIRE full-scope demo (phải =0)', count(*)::int FROM staff_assignments WHERE user_id = ${O} AND building_id IS NULL AND area_id IS NULL;
`)
console.table(report)
