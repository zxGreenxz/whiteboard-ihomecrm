// Máy đối chiếu tiền — chống bug class "cộng client dính cap 1000" và trấn an
// điểm đau "không tin số liệu phải đối chiếu tay".
//
// Với mỗi chỉ tiêu tiền quan trọng, tính bằng HAI cách độc lập trên DB:
//   (A) SUM() aggregate thuần SQL (nguồn chân lý, không dính cap 1000)
//   (B) đếm/tổng theo cách FE hay fetch (giới hạn 1000 dòng đầu) để lộ nếu FE
//       đang bị cắt.
// In bảng so sánh + PASS/FAIL. Chạy: node scripts/reconcile-money.mjs [YYYY-MM]
//
// Không sửa dữ liệu. Chỉ đọc. Dùng làm cổng kiểm ở mọi phase đụng tiền.
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
const month = process.argv[2] || null; // YYYY-MM, mặc định: tháng nhiều phiếu nhất

async function q(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`SQL FAILED ${res.status}: ${body.slice(0, 500)}`);
  return JSON.parse(body);
}

const fmt = (n) => Number(n ?? 0).toLocaleString('vi-VN');
let failed = 0;
function check(label, truthSql, cappedSql, extra = '') {
  return q(truthSql).then(async (tRows) => {
    const truth = Number(tRows[0]?.v ?? 0);
    const cRows = await q(cappedSql);
    const capped = Number(cRows[0]?.v ?? 0);
    const ok = truth === capped;
    if (!ok) failed++;
    const rowCount = Number(tRows[0]?.c ?? 0);
    console.log(
      `${ok ? '✅' : '❌'} ${label}\n` +
      `    SUM thật (SQL):    ${fmt(truth)}\n` +
      `    Tổng 1000-dòng-đầu: ${fmt(capped)}${rowCount ? `   (${rowCount} dòng)` : ''}` +
      `${extra ? `\n    ${extra}` : ''}` +
      `${ok ? '' : '\n    ⚠️  LỆCH — nghi FE bị cap 1000 hoặc logic sai!'}`,
    );
  });
}

const picked = month
  ? `'${month}'`
  : `(SELECT to_char(voucher_date,'YYYY-MM') FROM income_expenses WHERE deleted_at IS NULL
       GROUP BY 1 ORDER BY count(*) DESC LIMIT 1)`;

console.log(`\n=== ĐỐI CHIẾU TIỀN — kỳ ${month || '(tháng nhiều phiếu nhất)'} ===\n`);

const run = async () => {
  const mRow = await q(`SELECT ${picked} AS m`);
  const m = mRow[0].m;
  console.log(`Kỳ đối chiếu: ${m}\n`);

  // 1) Tổng THU (income_expenses type=INCOME approved) trong tháng
  await check(
    'Tổng THU đã duyệt trong kỳ',
    `SELECT COALESCE(SUM(total_amount),0) v, count(*) c FROM income_expenses
       WHERE type='INCOME' AND approval_status='APPROVED' AND deleted_at IS NULL
         AND to_char(voucher_date,'YYYY-MM')='${m}'`,
    `SELECT COALESCE(SUM(total_amount),0) v FROM (
       SELECT total_amount FROM income_expenses
         WHERE type='INCOME' AND approval_status='APPROVED' AND deleted_at IS NULL
           AND to_char(voucher_date,'YYYY-MM')='${m}'
         ORDER BY voucher_date DESC, id ASC LIMIT 1000) t`,
  );

  // 2) Tổng CHI đã duyệt trong kỳ
  await check(
    'Tổng CHI đã duyệt trong kỳ',
    `SELECT COALESCE(SUM(total_amount),0) v, count(*) c FROM income_expenses
       WHERE type='EXPENSE' AND approval_status='APPROVED' AND deleted_at IS NULL
         AND to_char(voucher_date,'YYYY-MM')='${m}'`,
    `SELECT COALESCE(SUM(total_amount),0) v FROM (
       SELECT total_amount FROM income_expenses
         WHERE type='EXPENSE' AND approval_status='APPROVED' AND deleted_at IS NULL
           AND to_char(voucher_date,'YYYY-MM')='${m}'
         ORDER BY voucher_date DESC, id ASC LIMIT 1000) t`,
  );

  // 3) Số dư từng sổ quỹ (view accounts_with_balance) vs tự cộng phiếu — chỉ cảnh báo lệch tổng
  const acc = await q(
    `SELECT COALESCE(SUM(current_amount),0) v, count(*) c FROM accounts_with_balance WHERE deleted_at IS NULL`,
  );
  console.log(`ℹ️  Tổng số dư mọi sổ quỹ (view): ${fmt(acc[0]?.v)}   (${acc[0]?.c} sổ)`);

  // 4) Tổng nợ hoá đơn (remaining) — invoices chưa thu đủ
  await check(
    'Tổng nợ hoá đơn (remaining_amount)',
    `SELECT COALESCE(SUM(remaining_amount),0) v, count(*) c FROM invoices
       WHERE deleted_at IS NULL AND status IN ('APPROVED','PARTIAL_PAID','OVERDUE')`,
    `SELECT COALESCE(SUM(remaining_amount),0) v FROM (
       SELECT remaining_amount FROM invoices
         WHERE deleted_at IS NULL AND status IN ('APPROVED','PARTIAL_PAID','OVERDUE')
         ORDER BY created_at DESC, id ASC LIMIT 1000) t`,
  );

  console.log(`\n=== KẾT QUẢ: ${failed === 0 ? '✅ TẤT CẢ KHỚP' : `❌ ${failed} chỉ tiêu LỆCH`} ===\n`);
  process.exit(failed === 0 ? 0 : 1);
};

run().catch((e) => { console.error(e.message); process.exit(2); });
