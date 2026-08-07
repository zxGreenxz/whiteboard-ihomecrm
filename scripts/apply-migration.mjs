#!/usr/bin/env node
// ĐƯỜNG THÔ — KHÔNG PHẢI đường apply thường dùng.
//
// Đường chính là `npm run migrate:forward <file> --apply`: nó kiểm cutoff,
// provenance và digest, TỰ CHẠY BACKUP, tự kiểm bản dump đủ tư cách làm đường
// lùi, rồi ghi evidence. Script này không làm gì trong số đó — nó POST thẳng SQL.
//
// VÌ SAO VẪN GIỮ, VÀ VÌ SAO ĐÒI TOKEN
//   07/08/2026 một migration được apply bằng chính kiểu này, bỏ qua cả backup.
//   Với PITR tắt, đường lùi khi đó là bản sao hằng ngày — tới ~24 giờ sổ sách.
//   Giữ script cho tình huống khẩn (lane từ chối vì lý do hình thức, production
//   đang hỏng), nhưng đường tắt không được RẺ HƠN đường chính: lane tự phát giấy
//   phép nhờ có bản backup nó vừa tạo và kiểm; script này không có gì để dựa vào,
//   nên nó phải dựa vào một con người.
//
// Cách dùng: IHOMECRM_PROMOTION_TOKEN=<token> node scripts/apply-migration.mjs <file.sql>
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/apply-migration.mjs <path-to-sql>');
  process.exit(1);
}
if (!process.env.IHOMECRM_PROMOTION_TOKEN) {
  console.error('❌ Thiếu IHOMECRM_PROMOTION_TOKEN.');
  console.error('   Script này bỏ qua cutoff, provenance, digest VÀ BACKUP.');
  console.error('   Dùng đường chính: npm run migrate:forward <file> -- --apply');
  console.error('   (lane đó tự chạy backup và tự phát giấy phép — không cần token).');
  console.error('   Chỉ khi lane không dùng được mới đi đường này, và khi đó phải có người ký.');
  process.exit(1);
}
const sql = readFileSync(file, 'utf8');
const localMd = readFileSync(new URL('../CLAUDE.local.md', import.meta.url), 'utf8');
const pat = localMd.match(/sbp_[a-f0-9]+/)[0];
const configToml = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
const ref = configToml.match(/project_id\s*=\s*"([^"]+)"/)[1];

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`APPLY FAILED ${res.status}: ${text}`);
  process.exit(1);
}
console.log(`Applied ${file} OK.`, text.slice(0, 200));
