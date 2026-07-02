// Apply một file SQL lên Supabase qua Management API — BẮT BUỘC dùng Node (UTF-8)
// để không hỏng font tiếng Việt trong thân hàm (án lệ đã có trong dự án).
// Dùng: node scripts/apply-sql.mjs <đường-dẫn-file.sql>
// PAT đọc từ env SUPABASE_PAT hoặc CLAUDE.local.md (không in ra console).
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/apply-sql.mjs <file.sql>'); process.exit(1); }

let pat = process.env.SUPABASE_PAT;
if (!pat) {
  try {
    const local = readFileSync(new URL('../CLAUDE.local.md', import.meta.url), 'utf8');
    const m = local.match(/sbp_[a-f0-9]+/);
    if (m) pat = m[0];
  } catch {}
}
if (!pat) { console.error('Không tìm thấy PAT (env SUPABASE_PAT hoặc CLAUDE.local.md)'); process.exit(1); }

const ref = 'tryymsxyyckgbrmmvozx';
const sql = readFileSync(file, 'utf8');

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const body = await res.text();
if (!res.ok) {
  console.error('FAILED', res.status, body.slice(0, 2000));
  process.exit(1);
}
console.log('OK', body.slice(0, 500));
