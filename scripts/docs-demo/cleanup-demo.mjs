#!/usr/bin/env node
/**
 * CLEANUP TOÀN PHẦN dữ liệu demo (phá dỡ sandbox — khác với RESET hằng ngày).
 * Xoá cả auth.users demo. Thứ tự FK-safe từ tables.mjs.
 *
 * Mặc định DRY-RUN (chỉ đếm). Xoá thật:  node scripts/docs-demo/cleanup-demo.mjs --execute
 */
import { runSql } from './lib.mjs'
import { PREP_NO_SNAPSHOT, RESET_TABLES, CLEANUP_TAIL } from './tables.mjs'

const EXECUTE = process.argv.includes('--execute')
const STEPS = [...RESET_TABLES.map(({ tbl, predicate }) => [tbl, predicate]), ...CLEANUP_TAIL.map(({ tbl, predicate }) => [tbl, predicate])]

if (!EXECUTE) {
  const counts = STEPS.map(
    ([t, w]) => `SELECT '${t}' AS tbl, count(*)::int AS n FROM ${t} WHERE ${w}`
  ).join('\nUNION ALL\n')
  const rows = await runSql(`${PREP_NO_SNAPSHOT}\n${counts};`)
  let total = 0
  for (const r of rows ?? []) {
    if (r.n > 0) console.log(`${r.tbl.padEnd(28)} ${r.n}`)
    total += r.n
  }
  console.log(`\nDRY-RUN: tổng ${total} bản ghi demo sẽ bị xoá (chưa xoá gì). Xoá thật: --execute`)
} else {
  const dels = STEPS.map(([t, w]) => `DELETE FROM ${t} WHERE ${w};`).join('\n')
  await runSql(`${PREP_NO_SNAPSHOT}\n${dels}`)
  console.log('✓ Đã xoá xong theo thứ tự FK-safe (kể cả auth users demo)')
}
