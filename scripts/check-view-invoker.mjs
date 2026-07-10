// Chốt chống hồi quy: quét mọi VIEW trong schema public thiếu
// security_invoker=true. GOTCHA đã có án lệ (20260704180000): recreate view làm
// RỚT security_invoker → view chạy dưới quyền OWNER → lộ dữ liệu tenant khác
// (tài khoản demo từng đọc được sổ quỹ/chỉ số điện thật). CHẠY SAU MỌI MIGRATION
// ĐỤNG VIEW. Exit 1 nếu có view hở.
import { readFileSync } from 'node:fs';

let pat = process.env.SUPABASE_PAT;
if (!pat) {
  try {
    const local = readFileSync(new URL('../CLAUDE.local.md', import.meta.url), 'utf8');
    const m = local.match(/sbp_[a-f0-9]+/);
    if (m) pat = m[0];
  } catch {}
}
if (!pat) { console.error('Không tìm thấy PAT'); process.exit(1); }
const ref = 'tryymsxyyckgbrmmvozx';

const sql = `
  SELECT c.relname AS view_name,
         COALESCE((
           SELECT option_value FROM pg_options_to_table(c.reloptions)
           WHERE option_name = 'security_invoker'
         ), 'false') AS security_invoker
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'v'
  ORDER BY c.relname;
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const body = await res.text();
if (!res.ok) { console.error('FAILED', res.status, body.slice(0, 500)); process.exit(1); }
const rows = JSON.parse(body);
const bad = rows.filter((r) => String(r.security_invoker).toLowerCase() !== 'true');

console.log(`Views public: ${rows.length} | security_invoker=true: ${rows.length - bad.length}`);
if (bad.length) {
  console.error('❌ VIEW HỞ security_invoker (chạy dưới quyền owner — nguy cơ lộ tenant):');
  bad.forEach((r) => console.error(`   - ${r.view_name}`));
  console.error('Vá: ALTER VIEW public.<ten> SET (security_invoker = true);');
  process.exit(1);
}
console.log('✅ Mọi view đều security_invoker=true.');
