#!/usr/bin/env node
// =============================================================================
// check-approver-provenance — CI gate cho tiêu chí §20-10 (audit provenance).
//
// BỐI CẢNH (audit 2026-07-25)
//   Plan chốt 476 chi / 1.015 thu APPROVED thiếu `approved_by` ngày 12/07 và cấm
//   backfill giả approver. Nhưng con số vẫn TĂNG sau go-live: 14 phiếu sinh
//   19–22/07 có approval_status='APPROVED', approved_by IS NULL, system_source
//   IS NULL, không correlation_id, không idempotency_key — tức KHÔNG do writer
//   canonical tạo. Đường rò tự tắt từ 23/07 khi finance-v2 writer lên.
//
//   Gate này chốt lại: từ CUTOFF trở đi, mọi phiếu APPROVED thiếu approver PHẢI
//   là bút toán hệ thống có `system_source`. Phiếu do người tạo mà thiếu approver
//   = writer legacy sống lại ⇒ fail.
//
// Dùng:  node scripts/check-approver-provenance.mjs
// Env:   SUPABASE_PAT (fallback: đọc từ CLAUDE.local.md khi chạy local)
// Exit:  0 sạch · 1 có dòng vi phạm hoặc không query được
// =============================================================================
import { readFileSync } from 'node:fs';

// Mốc chốt: 23/07 là ngày finance-v2 writer nhận toàn bộ đường tạo phiếu.
// Dòng trước mốc là nợ lịch sử đã biết, không thuộc phạm vi gate.
const CUTOFF = '2026-07-23';

let pat = process.env.SUPABASE_PAT;
if (!pat) {
  try {
    const local = readFileSync(new URL('../CLAUDE.local.md', import.meta.url), 'utf8');
    pat = local.match(/sbp_[a-f0-9]+/)?.[0];
  } catch { /* CI không có file này — đã có SUPABASE_PAT */ }
}
if (!pat) {
  console.error('❌ Thiếu SUPABASE_PAT (hoặc CLAUDE.local.md khi chạy local).');
  process.exit(1);
}

const configToml = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');
const ref = configToml.match(/project_id\s*=\s*"([^"]+)"/)[1];

const sql = `
  SELECT coalesce(json_agg(row_to_json(x)), '[]'::json) AS r FROM (
    SELECT created_at::date AS d,
           type,
           coalesce(posting_status, '(null)') AS posting_status,
           count(*) AS n
    FROM public.income_expenses
    WHERE deleted_at IS NULL
      AND approval_status = 'APPROVED'
      AND approved_by IS NULL
      AND system_source IS NULL
      AND created_at >= '${CUTOFF}'
    GROUP BY 1, 2, 3
    ORDER BY 1 DESC
  ) x;
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
if (!res.ok) {
  console.error(`❌ Query thất bại ${res.status}: ${(await res.text()).slice(0, 500)}`);
  process.exit(1);
}

// `JSON.parse(...)[0]?.r ?? []` là cách viết cũ, và nó nuốt MỌI sai lệch hình
// dạng: đổi tên cột, đổi cấu trúc trả về, kết quả rỗng bất thường — tất cả rơi êm
// thành mảng rỗng, `total = 0`, và gate in ✅. Gate này phát hiện phiếu APPROVED
// không có approver, tức đường ghi tự-duyệt không dấu vết. Im lặng cho qua ở đây
// là im lặng đúng chỗ nguy hiểm nhất.
const parsed = JSON.parse(await res.text());
if (!Array.isArray(parsed) || parsed.length === 0 || !Array.isArray(parsed[0]?.r)) {
  console.error('❌ Kết quả truy vấn KHÔNG đúng hình dạng mong đợi — không kết luận được.');
  console.error(`   Nhận: ${JSON.stringify(parsed).slice(0, 300)}`);
  console.error('   Mong đợi: [{ r: [...] }]. Sai hình dạng nghĩa là truy vấn hoặc schema đã đổi,');
  console.error('   KHÔNG phải "không có phiếu nào vi phạm".');
  process.exit(1);
}
const rows = parsed[0].r;
const total = rows.reduce((sum, r) => sum + Number(r.n), 0);

if (total > 0) {
  console.error(`❌ ${total} phiếu APPROVED thiếu approver VÀ thiếu system_source, tạo từ ${CUTOFF}:`);
  for (const r of rows) {
    console.error(`   ${r.d}  ${r.type.padEnd(8)} posting=${r.posting_status.padEnd(15)} × ${r.n}`);
  }
  console.error('');
  console.error('Nghĩa là có đường ghi NGOÀI writer canonical đang tạo phiếu tự-duyệt không dấu vết.');
  console.error('Truy `system_source`/`idempotency_key` của các dòng đó rồi khoá writer legacy tương ứng.');
  console.error('KHÔNG backfill `approved_by` bằng owner/creator — plan §4.2 cấm tạo approver giả.');
  process.exit(1);
}

console.log(`✅ Không có phiếu APPROVED thiếu approver ngoài bút toán hệ thống kể từ ${CUTOFF}.`);
