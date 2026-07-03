#!/usr/bin/env node
/**
 * VERIFY BASELINE: so sánh live-demo vs demo_snapshot theo từng bảng (count).
 * Gate mỗi phase: sau reset, live phải khớp snapshot 100% (trừ bảng restore=false).
 * Exit 1 nếu lệch.
 *
 * Chạy: node scripts/docs-demo/verify-baseline.mjs
 */
import { runSql } from './lib.mjs'
import { PREP_NO_SNAPSHOT, RESET_TABLES } from './tables.mjs'

const checks = RESET_TABLES.filter((r) => r.restore)
  .map(
    (r) => `SELECT '${r.tbl}' AS tbl,
      (SELECT count(*)::int FROM public.${r.tbl} WHERE ${r.predicate}) AS live,
      (SELECT count(*)::int FROM demo_snapshot.${r.tbl}) AS snap`
  )
  .join('\nUNION ALL\n')

const rows = await runSql(`${PREP_NO_SNAPSHOT}\n${checks};`)
let bad = 0
for (const r of rows) {
  const ok = r.live === r.snap
  if (!ok || r.snap > 0) console.log(`${ok ? '✓' : '✗'} ${r.tbl.padEnd(28)} live=${r.live} snap=${r.snap}`)
  if (!ok) bad++
}
if (bad) {
  console.error(`\n✗ VERIFY FAIL: ${bad} bảng lệch baseline`)
  process.exit(1)
}
console.log('\n✓ VERIFY PASS: live khớp snapshot 100%')
