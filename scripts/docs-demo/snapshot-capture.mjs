#!/usr/bin/env node
/**
 * Chụp GOLDEN BASELINE: copy verbatim (giữ nguyên UUID) mọi row demo hiện tại
 * vào schema demo_snapshot. Chạy SAU khi seed xong mỗi phase (baseline lớn dần).
 * Nút Reset sẽ trả sandbox về đúng bản chụp gần nhất.
 *
 * Chạy: node scripts/docs-demo/snapshot-capture.mjs
 */
import { runSql } from './lib.mjs'
import { PREP_NO_SNAPSHOT, RESET_TABLES } from './tables.mjs'

const stmts = RESET_TABLES.filter((r) => r.restore)
  .map(
    (r) => `DROP TABLE IF EXISTS demo_snapshot.${r.tbl};
CREATE TABLE demo_snapshot.${r.tbl} AS SELECT * FROM public.${r.tbl} WHERE ${r.predicate};`
  )
  .join('\n')

await runSql(`CREATE SCHEMA IF NOT EXISTS demo_snapshot;\n${PREP_NO_SNAPSHOT}\n${stmts}
-- Bản đồ định danh demo (reset không restore profiles nhưng cần đối chiếu)
DROP TABLE IF EXISTS demo_snapshot.profiles;
CREATE TABLE demo_snapshot.profiles AS
  SELECT p.* FROM public.profiles p WHERE p.id IN (SELECT id FROM _du);`)

const counts = await runSql(`
SELECT c.relname AS tbl, c.reltuples::int AS n_est,
       (SELECT count(*) FROM pg_catalog.pg_class c2 WHERE false) AS _pad
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'demo_snapshot' AND c.relkind = 'r'
ORDER BY c.relname;`)

// Đếm chính xác từng bảng có dữ liệu
const exact = await runSql(
  RESET_TABLES.filter((r) => r.restore)
    .map((r) => `SELECT '${r.tbl}' AS tbl, count(*)::int AS n FROM demo_snapshot.${r.tbl}`)
    .join('\nUNION ALL\n') + `\nUNION ALL SELECT 'profiles', count(*)::int FROM demo_snapshot.profiles;`
)
let total = 0
for (const r of exact) {
  if (r.n > 0) console.log(`${r.tbl.padEnd(28)} ${r.n}`)
  total += r.n
}
console.log(`\n✓ Snapshot baseline: ${total} rows trong demo_snapshot (${counts.length} bảng)`)
