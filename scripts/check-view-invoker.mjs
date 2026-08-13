// Chốt chống hồi quy: quét mọi VIEW trong schema public thiếu
// security_invoker=true. GOTCHA đã có án lệ (20260704180000): recreate view làm
// RỚT security_invoker → view chạy dưới quyền OWNER → lộ dữ liệu tenant khác
// (tài khoản demo từng đọc được sổ quỹ/chỉ số điện thật). CHẠY SAU MỌI MIGRATION
// ĐỤNG VIEW. Exit 1 nếu có view hở.
//
// SQL này có bản psql chạy trên đích diễn tập ở kiem-bao-mat-sau-khoi-phuc.mjs
// — đổi luật ở đây thì đổi cả đó, hai phép kiểm phải cùng một định nghĩa "hở".
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
         c.relkind::text AS relkind,
         COALESCE((
           SELECT option_value FROM pg_options_to_table(c.reloptions)
           WHERE option_name = 'security_invoker'
         ), 'false') AS security_invoker
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('v','m')
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
// MATERIALIZED VIEW (relkind='m') là chuyện KHÁC HẲN, không phải "quên bật".
//
// Bộ lọc cũ chỉ lấy relkind='v' nên matview vô hình — đúng y mẫu `relkind='i'`
// quên `'I'` ở generate-migration-provenance, chỉ khác cặp v/m thay cho i/I.
// Nhưng ở đây hậu quả nặng hơn: matview KHÔNG THỂ có security_invoker. Cả hai
// lệnh vá đều lỗi (đã thử thật):
//   ALTER MATERIALIZED VIEW … SET (security_invoker = true)  → 22023 unrecognized parameter
//   ALTER VIEW … SET (security_invoker = true)               → 42809 is not a view
// Nghĩa là một matview trên bảng có RLS là lỗ vĩnh viễn: nó đọc dữ liệu dưới
// quyền owner, bỏ qua RLS, và không có cách nào bật invoker cho nó. Cách xử duy
// nhất là đổi sang view thường, hoặc gác bằng RLS trên chính matview + revoke.
// Hiện public có 0 matview — bịt trước khi có cái đầu tiên.
const matview = rows.filter((r) => r.relkind === 'm');
const bad = rows.filter((r) => r.relkind === 'v' && String(r.security_invoker).toLowerCase() !== 'true');

console.log(
  `View public: ${rows.length - matview.length} | security_invoker=true: ${rows.length - matview.length - bad.length}` +
  (matview.length ? ` | MATERIALIZED VIEW: ${matview.length}` : ''),
);
if (matview.length) {
  console.error('❌ MATERIALIZED VIEW trong public — không thể bật security_invoker, tức bỏ qua RLS vĩnh viễn:');
  matview.forEach((r) => console.error(`   - ${r.view_name}`));
  console.error('Xử: đổi sang VIEW thường, hoặc bật RLS trên chính matview + REVOKE khỏi anon/authenticated.');
}
if (bad.length) {
  console.error('❌ VIEW HỞ security_invoker (chạy dưới quyền owner — nguy cơ lộ tenant):');
  bad.forEach((r) => console.error(`   - ${r.view_name}`));
  console.error('Vá: ALTER VIEW public.<ten> SET (security_invoker = true);');
}
if (bad.length || matview.length) process.exit(1);
console.log('✅ Mọi view đều security_invoker=true, không có materialized view.');
