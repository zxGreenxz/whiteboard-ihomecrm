// Apply một file SQL lên Supabase qua Management API — BẮT BUỘC dùng Node (UTF-8)
// để không hỏng font tiếng Việt trong thân hàm (án lệ đã có trong dự án).
// Dùng: node scripts/apply-sql.mjs <đường-dẫn-file.sql>
// PAT đọc từ env SUPABASE_PAT hoặc CLAUDE.local.md (không in ra console).
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/apply-sql.mjs <file.sql>'); process.exit(1); }

// ĐƯỜNG THÔ — bỏ qua cutoff, provenance, digest VÀ BACKUP.
//
// Đường chính `npm run migrate:forward <file> -- --apply` tự chạy backup, tự kiểm
// bản dump đủ tư cách làm đường lùi, tự phát giấy phép, rồi ghi evidence — không
// cần token. Script này không có gì trong số đó để dựa vào, nên nó phải dựa vào
// một con người. Đường tắt không được rẻ hơn đường chính, nếu không nó sẽ luôn
// được chọn (đã xảy ra 07/08/2026, và khi ấy PITR đang tắt).
if (!process.env.IHOMECRM_PROMOTION_TOKEN) {
  console.error('❌ Thiếu IHOMECRM_PROMOTION_TOKEN.');
  console.error('   Script này POST thẳng SQL: không cutoff, không provenance, không digest, KHÔNG BACKUP.');
  console.error('   Dùng đường chính: npm run migrate:forward <file> -- --apply');
  process.exit(1);
}

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
