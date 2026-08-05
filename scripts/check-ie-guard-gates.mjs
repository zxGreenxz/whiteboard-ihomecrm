// Chốt chống hồi quy: guard phiếu canonical
// (app_private.guard_income_expense_owned_payload) phải còn ĐỦ mọi cửa
// flex-writer mà writer đang mở, và KHÔNG được nới allowlist token lifecycle.
//
// GOTCHA đã có án lệ 2 lần: guard này được vá bằng cách đọc pg_get_functiondef
// của bản ĐANG CHẠY rồi cắt/ghép chuỗi. Đợt vá sau không thấy cửa của đợt trước.
//
//   • 31/07/2026 thêm cửa LINK_CONTRACT ngay TRƯỚC neo "-- canonical row:".
//   • 01/08/2026 (WP1) dời cửa ANNOTATE lên trước early-return bằng cách CẮT
//     nguyên đoạn từ "-- Đợt 2: cửa ANNOTATE" đến chính neo đó — nuốt luôn cửa
//     LINK_CONTRACT ở giữa. Hậu kiểm của WP1 lại ĐÒI "không còn
//     ie_flex_writer_xials nào" nên việc xoá nhầm ĐÚNG BẰNG điều kiện pass.
//   • Hậu quả im lặng 4 ngày: create_contract_v2 vẫn mở scope LINK_CONTRACT rồi
//     UPDATE contract_id ⇒ 55000 "is frozen" ⇒ MỌI hợp đồng ký trên phòng
//     "Đã cọc" fail, FE chỉ hiện "Không lưu được hợp đồng".
//
// CHẠY SAU MỌI MIGRATION ĐỤNG GUARD hoặc đụng writer mở flex scope.
// Exit 1 nếu có cửa bị rơi hoặc allowlist bị nới sai.
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

// Mỗi scope mà một writer definer mở ra PHẢI có nhánh tương ứng trong guard,
// nếu không writer đó chết 55000 ngay khi chạm phiếu canonical.
const sql = `
  SELECT
    (SELECT pg_get_functiondef(p.oid)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app_private'
        AND p.proname = 'guard_income_expense_owned_payload') AS guard_def,
    (SELECT string_agg(DISTINCT m[1], ',')
       FROM pg_proc p2, regexp_matches(p2.prosrc,
              'begin_ie_flex_write_v1\\(\\s*[^,]+,\\s*''([A-Z_]+)''', 'g') m
      WHERE p2.prokind = 'f'
        AND p2.proname <> 'begin_ie_flex_write_v1') AS scopes_opened_by_writers
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});
const body = await res.text();
if (!res.ok) { console.error('FAILED', res.status, body.slice(0, 500)); process.exit(1); }

const [row] = JSON.parse(body);
const def = row?.guard_def;
if (!def) {
  console.error('HỞ — không tìm thấy app_private.guard_income_expense_owned_payload.');
  process.exit(1);
}

const problems = [];

// 1. Mọi scope writer mở ra phải có nhánh trong guard. SALE_BONUS_DEPOSIT được
//    miễn: nó mở cửa quanh INSERT phiếu mới, mà guard chỉ chạy trên UPDATE/DELETE.
const INSERT_ONLY_SCOPES = new Set(['SALE_BONUS_DEPOSIT']);
const opened = (row.scopes_opened_by_writers ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

for (const scope of opened) {
  if (INSERT_ONLY_SCOPES.has(scope)) continue;
  if (!def.includes(`w.scope = '${scope}'`)) {
    problems.push(`cửa '${scope}' có writer mở nhưng KHÔNG có nhánh trong guard`);
  }
}

// 2. Đường canonical phải còn nguyên (không ai vô tình mở toang).
for (const marker of [
  'app_private.ie_transition_authorization',
  'is frozen (update rejected)',
  'is frozen (delete rejected)',
]) {
  if (!def.includes(marker)) problems.push(`guard mất dấu bắt buộc: ${marker}`);
}

// 3. Allowlist token lifecycle KHÔNG được chứa các cột nghiệp vụ. Nới ở đây là
//    mở cho MỌI writer có token, không chỉ writer đang cần.
const allowlistStart = def.indexOf('ALLOWLIST, not denylist');
if (allowlistStart === -1) {
  problems.push('không tìm thấy khối ALLOWLIST của đường token');
} else {
  const allowlist = def.slice(allowlistStart);
  for (const col of ['contract_id', 'total_amount', 'account_id', 'room_id', 'voucher_date']) {
    if (allowlist.includes(`'${col}'`)) {
      problems.push(`allowlist token lifecycle bị nới thêm cột nghiệp vụ '${col}'`);
    }
  }
}

if (problems.length === 0) {
  console.log(
    `OK — guard còn đủ ${opened.filter((s) => !INSERT_ONLY_SCOPES.has(s)).length} cửa ` +
      `(${opened.join(', ')}) và allowlist chưa bị nới.`,
  );
  process.exit(0);
}

console.error(`HỞ ${problems.length} điểm ở guard phiếu canonical:\n`);
for (const p of problems) console.error(`  • ${p}`);
console.error('\nĐọc supabase/migrations/20260805120000_ie_guard_link_contract_scope.sql để biết cách vá nguyên khối.');
process.exit(1);
