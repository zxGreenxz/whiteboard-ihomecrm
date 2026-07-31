#!/usr/bin/env node
/**
 * BƯỚC 3 — chép dữ liệu công ty thật sang org TEST.
 *
 *   node scripts/clone-org/clone.mjs
 *
 * Toàn bộ logic chép nằm trong DB ở public.clone_org_sync_v1()
 * (supabase/migrations/20260801060000_clone_org_sync_rpc.sql) — script này chỉ
 * gọi nó. Một nguồn sự thật duy nhất cho cả CLI lẫn nút "Đồng bộ" trong app.
 *
 * Vì sao phải set request.jwt.claims: hàm chặn bằng is_super_admin(), mà hàm đó
 * đọc auth.uid() từ JWT claims. Gọi qua Management API thì không có JWT nên phải
 * tự khai — hợp lệ vì chạy được lệnh này đã cần PAT quản trị project.
 */
import { runSql, TEST_ORG, log, die } from './lib.mjs'

const org = await runSql(`SELECT id FROM public.organizations WHERE id = '${TEST_ORG}';`)
if (!org?.length) die('Chưa có org TEST — chạy create-users.mjs trước.')

const su = await runSql(`SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1;`)
if (!su?.length) die('Không tìm thấy super admin để mượn danh nghĩa gọi RPC.')

log('• gọi public.clone_org_sync_v1() …')
const t0 = Date.now()
const rows = await runSql(`
  BEGIN;
  SELECT set_config('request.jwt.claims',
    json_build_object('sub', '${su[0].user_id}', 'role', 'authenticated')::text, true);
  SELECT public.clone_org_sync_v1() AS result;
  COMMIT;
`)
const res = (Array.isArray(rows) ? rows : []).map((r) => r.result).find(Boolean)
if (!res?.ok) die(`Đồng bộ thất bại: ${JSON.stringify(res)?.slice(0, 400)}`)

const top = Object.entries(res.counts ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 12)
for (const [t, n] of top) log(`    ${t.padEnd(40)} ${n}`)
log(`\n→ ${res.rows} dòng / ${res.tables} bảng, mất ${((Date.now() - t0) / 1000).toFixed(1)}s`)
log('\n✓ Xong. Tiếp: node scripts/clone-org/mask.mjs (chỉ còn copy file mẫu HĐ)')
log('  rồi node scripts/clone-org/verify.mjs và snapshot.mjs after')
