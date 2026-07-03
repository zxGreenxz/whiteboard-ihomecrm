#!/usr/bin/env node
/**
 * CLEANUP dữ liệu demo trang docs — thứ tự FK-safe, tiền trước, auth.users demo CUỐI CÙNG
 * (payments.user_id ON DELETE CASCADE từ auth.users — xoá user trước là chứng từ bốc hơi).
 *
 * Mặc định DRY-RUN (chỉ đếm). Xoá thật:  node scripts/docs-demo/cleanup-demo.mjs --execute
 * Nhận diện demo: buildings.code LIKE 'DEMO%', areas.name LIKE 'KV DEMO%',
 *   accounts.code LIKE 'DEMO%', services/ie_types name LIKE 'DEMO %',
 *   auth.users email LIKE 'demo.%@username.ihomecrm.local', customers/leads name LIKE 'DEMO %'.
 */
import { runSql } from './lib.mjs'

const EXECUTE = process.argv.includes('--execute')

// Temp tables sống trọn session (1 request Management API = 1 session)
const PREP = `
CREATE TEMP TABLE demo_users ON COMMIT DROP AS
  SELECT id FROM auth.users WHERE email LIKE 'demo.%@username.ihomecrm.local';
CREATE TEMP TABLE demo_buildings ON COMMIT DROP AS
  SELECT id FROM buildings WHERE code LIKE 'DEMO%';
CREATE TEMP TABLE demo_areas ON COMMIT DROP AS
  SELECT id FROM areas WHERE name LIKE 'KV DEMO%';
CREATE TEMP TABLE demo_rooms ON COMMIT DROP AS
  SELECT id FROM rooms WHERE building_id IN (SELECT id FROM demo_buildings);
CREATE TEMP TABLE demo_contracts ON COMMIT DROP AS
  SELECT id FROM contracts WHERE room_id IN (SELECT id FROM demo_rooms);
CREATE TEMP TABLE demo_invoices ON COMMIT DROP AS
  SELECT id FROM invoices WHERE building_id IN (SELECT id FROM demo_buildings);
CREATE TEMP TABLE demo_customers ON COMMIT DROP AS
  SELECT id FROM customers WHERE full_name LIKE 'DEMO %';
`

// [bảng, điều kiện WHERE] — THỨ TỰ XOÁ: tiền → HĐ/khách → vận hành → nhân sự/cấu trúc → auth cuối.
const STEPS = [
  ['income_expense_items', `income_expense_id IN (SELECT id FROM income_expenses WHERE building_id IN (SELECT id FROM demo_buildings) OR user_id IN (SELECT id FROM demo_users) OR name LIKE '%[DEMO-DOCS]%')`],
  ['income_expenses', `building_id IN (SELECT id FROM demo_buildings) OR user_id IN (SELECT id FROM demo_users) OR name LIKE '%[DEMO-DOCS]%'`],
  ['payments', `invoice_id IN (SELECT id FROM demo_invoices) OR user_id IN (SELECT id FROM demo_users)`],
  ['invoice_items', `invoice_id IN (SELECT id FROM demo_invoices)`],
  ['invoices', `id IN (SELECT id FROM demo_invoices)`],
  ['excess_amounts', `contract_id IN (SELECT id FROM demo_contracts)`],
  ['meter_readings', `building_id IN (SELECT id FROM demo_buildings)`],
  ['contract_terminations', `contract_id IN (SELECT id FROM demo_contracts)`],
  ['contract_extensions', `contract_id IN (SELECT id FROM demo_contracts)`],
  ['contracts', `id IN (SELECT id FROM demo_contracts)`],
  ['deposits', `room_id IN (SELECT id FROM demo_rooms) OR contract_id IN (SELECT id FROM demo_contracts)`],
  ['vehicles', `customer_id IN (SELECT id FROM demo_customers) OR building_id IN (SELECT id FROM demo_buildings)`],
  ['tenants', `full_name LIKE 'DEMO %'`],
  ['customers', `id IN (SELECT id FROM demo_customers)`],
  ['leads', `building_id IN (SELECT id FROM demo_buildings)`],
  ['jobs', `building_id IN (SELECT id FROM demo_buildings)`],
  ['notifications', `user_id IN (SELECT id FROM demo_users)`],
  ['staff_assignments', `staff_id IN (SELECT id FROM demo_users)`],
  ['team_members', `member_id IN (SELECT id FROM demo_users)`],
  ['meters', `building_id IN (SELECT id FROM demo_buildings)`],
  ['building_services', `building_id IN (SELECT id FROM demo_buildings)`],
  ['services', `name LIKE 'DEMO %'`],
  ['rooms', `building_id IN (SELECT id FROM demo_buildings)`],
  ['area_buildings', `area_id IN (SELECT id FROM demo_areas) OR building_id IN (SELECT id FROM demo_buildings)`],
  ['buildings', `id IN (SELECT id FROM demo_buildings)`],
  ['areas', `id IN (SELECT id FROM demo_areas)`],
  ['accounts', `code LIKE 'DEMO%' OR user_id IN (SELECT id FROM demo_users)`],
  ['income_expense_types', `name LIKE 'DEMO %'`],
  ['profiles', `id IN (SELECT id FROM demo_users)`],
  ['auth.users', `id IN (SELECT id FROM demo_users)`],
]

if (!EXECUTE) {
  const counts = STEPS.map(
    ([t, w]) => `SELECT '${t}' AS tbl, count(*)::int AS n FROM ${t} WHERE ${w}`
  ).join('\nUNION ALL\n')
  const rows = await runSql(`${PREP}\n${counts};`)
  let total = 0
  for (const r of rows ?? []) {
    if (r.n > 0) console.log(`${r.tbl.padEnd(24)} ${r.n}`)
    total += r.n
  }
  console.log(`\nDRY-RUN: tổng ${total} bản ghi demo sẽ bị xoá (chưa xoá gì). Xoá thật: --execute`)
} else {
  const dels = STEPS.map(([t, w]) => `DELETE FROM ${t} WHERE ${w};`).join('\n')
  await runSql(`${PREP}\n${dels}`)
  console.log('✓ Đã xoá xong theo thứ tự FK-safe')
}
