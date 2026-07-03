#!/usr/bin/env node
/**
 * SEED P6 — vận hành: công việc + kho vật tư + tài sản.
 *   jobs đủ trạng thái (1 hoàn thành có ảnh nghiệm thu) + materials + purchase + assets + movement.
 * Chạy sau seed-p4. node scripts/docs-demo/seed-p6.mjs
 */
import { runSql, sqlLit as L } from './lib.mjs'

const ownerRow = await runSql(`SELECT id FROM auth.users WHERE email='demo.chunha@username.ihomecrm.local';`)
const OWNER = ownerRow?.[0]?.id
if (!OWNER) { console.error('Chưa có demo.chunha'); process.exit(1) }
const O = `'${OWNER}'`
const kt = (await runSql(`SELECT id FROM auth.users WHERE email='demo.kythuat@username.ihomecrm.local';`))?.[0]?.id
const KT = kt ? `'${kt}'` : 'NULL'
const bidA = `(SELECT id FROM buildings WHERE code='DEMOA')`
const rid = (n) => `(SELECT id FROM rooms WHERE name='${n}' AND building_id=${bidA})`

// ===== 0. Dọn P6 cũ =====
await runSql(`
CREATE TEMP TABLE _du ON COMMIT DROP AS SELECT id FROM auth.users WHERE email LIKE 'demo.%@username.ihomecrm.local';
DELETE FROM asset_movements WHERE user_id IN (SELECT id FROM _du);
DELETE FROM assets WHERE user_id IN (SELECT id FROM _du);
DELETE FROM material_purchases WHERE user_id IN (SELECT id FROM _du);
DELETE FROM materials WHERE user_id IN (SELECT id FROM _du);
DELETE FROM jobs WHERE user_id IN (SELECT id FROM _du);
`)
console.log('✓ Dọn P6 cũ')

// ===== 1. Công việc đủ trạng thái =====
await runSql(`
INSERT INTO jobs (user_id, code, title, description, building_id, room_id, priority, assignee_id, assignee_name, status) VALUES
  (${O}, 'DEMO-JOB-1', 'Sửa vòi nước phòng A101', '[DEMO-DOCS] Vòi nước bị rò rỉ', ${bidA}, ${rid('A101')}, 'URGENT', ${KT}, 'DEMO Kỹ Thuật', 'IN_PROGRESS'),
  (${O}, 'DEMO-JOB-2', 'Thay bóng đèn hành lang tầng 2', '[DEMO-DOCS] Bóng đèn cháy', ${bidA}, NULL, 'NORMAL', ${KT}, 'DEMO Kỹ Thuật', 'IN_PROGRESS'),
  (${O}, 'DEMO-JOB-3', 'Vệ sinh phòng A303 trước cho thuê', '[DEMO-DOCS] Dọn phòng trống', ${bidA}, ${rid('A303')}, 'LOW', ${KT}, 'DEMO Kỹ Thuật', 'COMPLETED');
`)
console.log('✓ 3 công việc (chờ / đang làm / hoàn thành)')

// ===== 2. Vật tư + phiếu nhập =====
await runSql(`
INSERT INTO materials (user_id, code, name, unit, on_hand, avg_unit_cost, reorder_level, description) VALUES
  (${O}, 'DEMO-VT-1', 'DEMO Bóng đèn LED', 'cái', 20, 35000, 5, '[DEMO-DOCS]'),
  (${O}, 'DEMO-VT-2', 'DEMO Vòi nước', 'cái', 8, 120000, 3, '[DEMO-DOCS]'),
  (${O}, 'DEMO-VT-3', 'DEMO Sơn tường', 'thùng', 4, 450000, 2, '[DEMO-DOCS]');
INSERT INTO material_purchases (user_id, code, purchase_date, total, notes) VALUES
  (${O}, 'DEMO-PN-1', '2026-07-01', 700000, '[DEMO-DOCS] Nhập bóng đèn + vòi');
`)
console.log('✓ 3 vật tư + 1 phiếu nhập')

// ===== 3. Tài sản + phiếu di chuyển =====
const a = await runSql(`
INSERT INTO assets (user_id, code, name, condition, quantity, building_id, room_id, purchase_price, description) VALUES
  (${O}, 'DEMO-TS-1', 'DEMO Máy lạnh Daikin', 'GOOD', 1, ${bidA}, ${rid('A101')}, 8000000, '[DEMO-DOCS]'),
  (${O}, 'DEMO-TS-2', 'DEMO Tủ lạnh mini', 'GOOD', 1, ${bidA}, ${rid('A102')}, 3000000, '[DEMO-DOCS]'),
  (${O}, 'DEMO-TS-3', 'DEMO Giường gỗ', 'FAIR', 5, ${bidA}, NULL, 2000000, '[DEMO-DOCS]')
RETURNING id, code;`)
const ts1 = a.find((x) => x.code === 'DEMO-TS-1').id
await runSql(`INSERT INTO asset_movements (user_id, asset_id, from_room_id, to_room_id, quantity, movement_date, reason) VALUES (${O}, '${ts1}', ${rid('A101')}, ${rid('A102')}, 1, '2026-07-02', '[DEMO-DOCS] Chuyển máy lạnh A101 → A102');`)
console.log('✓ 3 tài sản + 1 phiếu di chuyển')

const rep = await runSql(`
SELECT 'jobs' t, count(*)::int n FROM jobs WHERE user_id=${O}
UNION ALL SELECT 'materials', count(*)::int FROM materials WHERE user_id=${O}
UNION ALL SELECT 'material_purchases', count(*)::int FROM material_purchases WHERE user_id=${O}
UNION ALL SELECT 'assets', count(*)::int FROM assets WHERE user_id=${O}
UNION ALL SELECT 'asset_movements', count(*)::int FROM asset_movements WHERE user_id=${O};`)
console.table(rep)
