// Chạy 1 file SQL SELECT qua Management API và in FULL kết quả JSON (UTF-8).
// Khác apply-sql.mjs (cắt 500 ký tự): dùng cho query đọc/kiểm tra.
// Dùng: node scripts/query-sql.mjs <file.sql>
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/query-sql.mjs <file.sql>'); process.exit(1); }

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
const sql = readFileSync(file, 'utf8');

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const body = await res.text();
if (!res.ok) { console.error('FAILED', res.status, body.slice(0, 2000)); process.exit(1); }
try { console.log(JSON.stringify(JSON.parse(body), null, 1)); }
catch { console.log(body); }
