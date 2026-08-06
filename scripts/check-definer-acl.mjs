// CI gate (AUTHORIZATION-PLAN §9.3 điểm 9): fail nếu có SECURITY DEFINER function
// mới anon-executable KHÔNG nằm trong allowlist baseline. Bắt regress ACL (vd
// CREATE OR REPLACE reset grant về PUBLIC). Regenerate baseline CÓ CHỦ Ý khi thêm
// public endpoint thật: node scripts/check-definer-acl.mjs --update
//
// Dùng: node scripts/check-definer-acl.mjs   → exit 1 nếu drift.
import { readFileSync, writeFileSync } from 'node:fs';

const pat = process.env.SUPABASE_PAT
  || readFileSync(new URL('../CLAUDE.local.md', import.meta.url), 'utf8').match(/sbp_[a-f0-9]+/)?.[0];
if (!pat) { console.error('Không tìm thấy PAT'); process.exit(1); }
const ref = 'tryymsxyyckgbrmmvozx';
const baselinePath = new URL('./definer-acl-baseline.json', import.meta.url);

// Quét MỌI schema PostgREST expose, không chỉ `public`.
//
// GET /v1/projects/<ref>/postgrest trả db_schema = "api, public,graphql_public".
// `api` đứng ĐẦU nên nó là profile MẶC ĐỊNH: hàm nằm trong đó gọi thẳng được ở
// /rest/v1/rpc/<tên> mà KHÔNG cần header Content-Profile nào, và role `anon` có
// USAGE trên schema đó (đo 07/08/2026: schema tồn tại, has_schema_privilege =
// true). Tức bề mặt phơi ra DỄ nhất lại nằm ngoài vùng quét của gate.
//
// Hiện `api` có 0 hàm — cửa mở nhưng chưa ai bước vào. Đó đúng là lúc nên bịt:
// một SECURITY DEFINER thêm vào đó ngày mai sẽ có zero bằng chứng nào chặn.
const SCHEMA_PHOI_RA = ['public', 'api', 'graphql_public'];

// Giữ NGUYÊN cách sinh chữ ký (`oid::regprocedure`) để baseline sẵn có không
// lệch: regprocedure tự thêm tiền tố schema cho schema ngoài search_path, nên
// hàm `public` vẫn ra chữ ký cũ còn hàm `api` ra `api.<tên>(...)`.
const sql = `SELECT p.oid::regprocedure::text AS sig
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname = ANY(ARRAY[${SCHEMA_PHOI_RA.map((s) => `'${s}'`).join(',')}])
    AND p.prosecdef AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ORDER BY sig`;
const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST', headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
if (!res.ok) { console.error('Query FAILED', res.status, (await res.text()).slice(0,300)); process.exit(1); }
const live = (await res.json()).map(r => r.sig);

if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, JSON.stringify({
    note: 'SECURITY DEFINER functions anon-executable — allowlist baseline (Sprint 6 CI gate). Regenerate intentionally when adding a genuine public endpoint.',
    generated: new Date().toISOString().slice(0,10), count: live.length, signatures: live,
  }, null, 2) + '\n');
  console.log(`✅ Baseline updated: ${live.length} anon-executable SECURITY DEFINER functions.`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).signatures;
const allow = new Set(baseline);
const added = live.filter(s => !allow.has(s));
const removed = baseline.filter(s => !new Set(live).has(s));

if (added.length) {
  console.error(`❌ ${added.length} SECURITY DEFINER function MỚI anon-executable ngoài allowlist:`);
  for (const s of added) console.error('   + ' + s);
  console.error('Nếu là public endpoint có chủ đích: node scripts/check-definer-acl.mjs --update. Nếu không: REVOKE anon.');
  process.exit(1);
}
if (removed.length) {
  console.log(`ℹ️  ${removed.length} function trong baseline không còn anon-executable (siết chặt — tốt). Chạy --update để dọn baseline.`);
}
console.log(`✅ Không có SECURITY DEFINER anon-executable mới ngoài allowlist (${live.length} khớp baseline).`);
process.exit(0);
