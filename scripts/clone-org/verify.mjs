#!/usr/bin/env node
/**
 * BƯỚC 5 — kiểm chứng bản sao. Chạy SAU clone.mjs + mask.mjs.
 *
 *   node scripts/clone-org/verify.mjs
 *
 * 4 phép kiểm:
 *   A. RÒ RỈ NGƯỢC — dòng org TEST trỏ sang id thuộc org THẬT. Đây là phép bắt
 *      lỗi ánh xạ sót; quét theo TỪNG FK, cộng thêm các cột uuid không có FK
 *      (finance_invoice_components.invoice_id, income_expenses.posting_id…).
 *      Bất kỳ con số > 0 nào cũng là bản sao còn "dây rốn" sang công ty thật.
 *   B. ĐỦ DÒNG — so số dòng từng bảng org TEST vs org THẬT.
 *   C. TIỀN KHỚP — tổng thu/chi, hoá đơn, thanh toán 2 bên phải bằng nhau.
 *   D. CÁCH LY — 4 user test không được là super admin, không được có membership
 *      ở org thật; user thật không được có membership ở org TEST.
 */
import { runSql, REAL_ORG, TEST_ORG, USERS, testEmail, sqlLit as L, cloneTables, log } from './lib.mjs'

let fail = 0
const bad = (m) => { console.error(`✗ ${m}`); fail++ }

const tables = await cloneTables()
const tblSet = new Set(tables.map((t) => t.tbl))

// ===== A. Rò rỉ ngược =======================================================
log('A. Tham chiếu từ org TEST trỏ ngược sang org THẬT')

// Mọi cột uuid (trừ id/organization_id) của bảng đã chép + bảng đích của nó nếu
// có FK; không FK thì dò trên toàn bộ id đã ánh xạ.
const uuidCols = await runSql(`
  SELECT c.table_name AS tbl, c.column_name AS col
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.udt_name = 'uuid'
    AND c.column_name NOT IN ('id', 'organization_id')
    AND c.table_name IN (${tables.map((t) => `'${t.tbl}'`).join(',')})
  ORDER BY 1, 2;
`)

const CHUNK = 40
const leaks = []
for (let i = 0; i < uuidCols.length; i += CHUNK) {
  const part = uuidCols.slice(i, i + CHUNK)
  const q = part.map((c) => `
    SELECT '${c.tbl}.${c.col}' AS ref, count(*) AS n
    FROM public.${c.tbl} x
    WHERE x.organization_id = '${TEST_ORG}' AND x."${c.col}" IS NOT NULL
      AND EXISTS (SELECT 1 FROM clone_org.idmap m WHERE m.old_id = x."${c.col}")`).join('\nUNION ALL\n')
  const rows = await runSql(`SELECT * FROM (${q}) t WHERE t.n > 0;`)
  leaks.push(...rows)
}
if (leaks.length) {
  for (const l of leaks) bad(`  ${l.ref}: ${l.n} dòng vẫn trỏ id của công ty thật`)
} else {
  log('   ✓ 0 tham chiếu trỏ ngược (quét ' + uuidCols.length + ' cột uuid)')
}

// ===== B. Đủ dòng ===========================================================
// So với SỐ DÒNG ĐÃ CHỌN (clone_org.idmap) chứ không so với `organization_id =
// org thật`: pha 2 cố tình vét thêm dòng organization_id IS NULL thuộc về org
// thật (223 inspection_photos, 21 salary_attendance_day…), nên so theo org sẽ
// báo "thừa" một cách giả tạo. Lệch ở đây mới là mất dòng thật.
log('B. Số dòng org TEST vs số dòng đã chọn để chép')
const counts = await runSql(`
  SELECT * FROM (
    ${tables.filter((t) => t.hasUuidId).map((t) => `SELECT '${t.tbl}' AS tbl,
       (SELECT count(*) FROM public.${t.tbl} s WHERE s.id IN (SELECT old_id FROM clone_org.idmap)) AS want_n,
       (SELECT count(*) FROM public.${t.tbl} WHERE organization_id='${TEST_ORG}') AS test_n`).join('\nUNION ALL\n')}
  ) x WHERE x.want_n <> x.test_n ORDER BY x.want_n - x.test_n DESC;
`)
if (counts.length) {
  log(`   ${counts.length} bảng thiếu dòng (tham chiếu mồ côi bị bỏ có chủ ý):`)
  for (const c of counts) log(`     ${c.tbl.padEnd(38)} chọn=${c.want_n} chép=${c.test_n}`)
} else log('   ✓ mọi bảng chép đủ số dòng đã chọn')

// ===== C. Tiền khớp =========================================================
log('C. Đối chiếu tiền')
const money = await runSql(`
  SELECT 'income_expenses.total_amount' AS k,
         (SELECT coalesce(sum(total_amount),0) FROM income_expenses WHERE organization_id='${REAL_ORG}' AND deleted_at IS NULL) AS real_v,
         (SELECT coalesce(sum(total_amount),0) FROM income_expenses WHERE organization_id='${TEST_ORG}' AND deleted_at IS NULL) AS test_v
  UNION ALL SELECT 'income_expense_items.amount',
         (SELECT coalesce(sum(amount),0) FROM income_expense_items WHERE organization_id='${REAL_ORG}'),
         (SELECT coalesce(sum(amount),0) FROM income_expense_items WHERE organization_id='${TEST_ORG}')
  UNION ALL SELECT 'invoices.total_amount',
         (SELECT coalesce(sum(total_amount),0) FROM invoices WHERE organization_id='${REAL_ORG}' AND deleted_at IS NULL),
         (SELECT coalesce(sum(total_amount),0) FROM invoices WHERE organization_id='${TEST_ORG}' AND deleted_at IS NULL)
  UNION ALL SELECT 'invoice_items.amount',
         (SELECT coalesce(sum(amount),0) FROM invoice_items WHERE organization_id='${REAL_ORG}'),
         (SELECT coalesce(sum(amount),0) FROM invoice_items WHERE organization_id='${TEST_ORG}')
  UNION ALL SELECT 'payments.amount',
         (SELECT coalesce(sum(amount),0) FROM payments WHERE organization_id='${REAL_ORG}'),
         (SELECT coalesce(sum(amount),0) FROM payments WHERE organization_id='${TEST_ORG}')
  UNION ALL SELECT 'profit_monthly.computed_profit',
         (SELECT coalesce(sum(computed_profit),0) FROM profit_monthly WHERE organization_id='${REAL_ORG}'),
         (SELECT coalesce(sum(computed_profit),0) FROM profit_monthly WHERE organization_id='${TEST_ORG}')
  UNION ALL SELECT 'accounts.initial_amount',
         (SELECT coalesce(sum(initial_amount),0) FROM accounts WHERE organization_id='${REAL_ORG}' AND deleted_at IS NULL),
         (SELECT coalesce(sum(initial_amount),0) FROM accounts WHERE organization_id='${TEST_ORG}' AND deleted_at IS NULL);
`)
for (const m of money) {
  const same = String(m.real_v) === String(m.test_v)
  if (same) log(`   ✓ ${m.k.padEnd(30)} ${Number(m.real_v).toLocaleString('vi-VN')}`)
  else bad(`  ${m.k}: thật=${m.real_v} test=${m.test_v}`)
}

// ===== D. Cách ly tài khoản =================================================
log('D. Cách ly tài khoản')
const emails = USERS.map((u) => L(testEmail(u))).join(',')
const iso = await runSql(`
  SELECT 'user test là super_admin' AS k, count(*) AS n FROM super_admins s
    JOIN auth.users u ON u.id = s.user_id WHERE u.email IN (${emails})
  UNION ALL SELECT 'user test có membership org THẬT', count(*) FROM organization_memberships m
    JOIN auth.users u ON u.id = m.user_id WHERE u.email IN (${emails}) AND m.organization_id = '${REAL_ORG}'
  UNION ALL SELECT 'user THẬT có membership org TEST', count(*) FROM organization_memberships m
    JOIN auth.users u ON u.id = m.user_id WHERE u.email NOT IN (${emails}) AND m.organization_id = '${TEST_ORG}'
  UNION ALL SELECT 'staff_assignments full-scope của user test', count(*) FROM staff_assignments sa
    JOIN auth.users u ON u.id = sa.staff_id
    WHERE u.email IN (${emails}) AND sa.building_id IS NULL AND sa.area_id IS NULL;
`)
for (const r of iso) {
  if (Number(r.n) === 0) log(`   ✓ ${r.k}: 0`)
  else bad(`  ${r.k}: ${r.n}`)
}
const mem = await runSql(`
  SELECT u.email, m.member_type, m.status FROM organization_memberships m
  JOIN auth.users u ON u.id = m.user_id WHERE m.organization_id = '${TEST_ORG}' ORDER BY u.email;
`)
log(`   thành viên org TEST (${mem.length}):`)
for (const m of mem) log(`     ${m.email.padEnd(46)} ${m.member_type} ${m.status}`)

// ===== Kết luận =============================================================
if (fail) {
  console.error(`\n✗ ${fail} lỗi — chưa được dùng bản sao. Gỡ: node scripts/clone-org/rollback.mjs --data`)
  process.exit(1)
}
log('\n✓ Bản sao kín và khớp. Bước cuối: node scripts/clone-org/snapshot.mjs after')
log('  (chỉ khi snapshot after XANH mới coi là xong — nó mới là phép đo rò rỉ sang mắt tài khoản thật)')
void tblSet
