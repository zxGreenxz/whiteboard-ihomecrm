// Máy đối chiếu tiền V2 — POSTING-AWARE (plan §11.2 / roadmap §4c).
//
// Bản cũ `scripts/reconcile-money.mjs` hard-code ngữ nghĩa "APPROVED = cash" (chỉ
// tiêu THU đã duyệt). Sau khi Finance V2 chuyển nguồn số dư sang CANONICAL POSTING
// LINES (income_expense_posting_lines), số dư sổ quỹ = initial_amount + SUM(signed_amount)
// trên các event POSTING/REVERSAL, KHÔNG lọc approval_status. Bản V2 này đối chiếu
// đúng theo mô hình mới, để chạy song song bản cũ tới khi cutover (roadmap §4c: "thêm
// scripts/reconcile-money-v2.mjs (posting-aware / dual-count), không sửa bản cũ").
//
// LÀM 2 VIỆC:
//   (1) SỐ DƯ SỔ QUỸ (§11.2): so per-account, chỉ sổ THỰC (is_virtual = false — sổ ảo
//       là non-cash, không có posting; roadmap §4c#5), legacy accounts_with_balance
//       .current_amount vs accounts_with_balance_v2.current_amount. In mọi sổ lệch
//       (abs(diff) >= 0.01) kèm account id / org / legacy / v2 / diff.
//   (2) CAP-1000 GUARD (như reconcile-money.mjs): dual/tri-count trên bảng posting lines
//       để chốt cứng bug class "SELECT-rồi-cộng-client dính trần 1000 dòng":
//         T — SQL SUM(signed_amount) thuần (aggregate trong DB, MIỄN NHIỄM cap-1000).
//         P — phân trang 1000 dòng/trang rồi CỘNG CLIENT (replicate fetchAll). P phải == T;
//             P ≠ T ⇒ phân trang cộng thiếu/trùng (order không ổn định / dính cap).
//         N — CHỈ 1000 dòng đầu (mô phỏng client KHÔNG phân trang). Khi >1000 dòng mà
//             N ≠ T ⇒ CHỨNG MINH client cộng-1-trang sẽ sai; reader v2 dùng SQL aggregate
//             nên an toàn (thông tin, KHÔNG tính FAIL).
//
// CHẠY READ ONLY: mọi truy vấn bọc `BEGIN; SET TRANSACTION READ ONLY; … COMMIT;`.
// Import executeManagementQuery + loadSupabaseAdminConfig từ apply-accounting-rollout.mjs
// (Bearer PAT qua Management API, role postgres — bỏ qua RLS, thấy CHÂN LÝ). KHÔNG in PAT.
//
// Tham số: node scripts/reconcile-money-v2.mjs [YYYY-MM]
//   [YYYY-MM] (tuỳ chọn) — giới hạn CAP-1000 GUARD theo THÁNG của posted_on (đúng cửa sổ
//   mà các aggregate RPC v2 dùng: cashbook_period_totals_v2/…). Số dư sổ quỹ (việc 1) là
//   TỔNG luỹ kế thời-điểm nên KHÔNG scope theo kỳ.
//
// Exit: 0 khớp (hoặc schema V2 chưa apply) · 1 có lệch · 2 lỗi.
import {
  executeManagementQuery,
  loadSupabaseAdminConfig,
} from './apply-accounting-rollout.mjs';

const PAGE = 1000; // trần 1000 dòng/response (PostgREST) = SUPABASE_PAGE (src/lib/supabaseFetchAll.ts)
const HARD_CAP = 200_000; // trần an toàn phân trang: vượt = nghi order không ổn định
const EPS = 0.01; // ngưỡng lệch tiền (VND) coi là KHÁC nhau

// ---- Tham số kỳ tuỳ chọn: chỉ nhận đúng YYYY-MM (chốt SQL-injection) ----
const argMonth = process.argv[2];
let monthWindow = null; // { month, start, end }
if (argMonth !== undefined) {
  if (!/^\d{4}-\d{2}$/.test(argMonth)) {
    console.error(`Tham số kỳ không hợp lệ: "${argMonth}" — cần định dạng YYYY-MM.`);
    process.exit(2);
  }
  const mm = Number(argMonth.slice(5, 7));
  if (mm < 1 || mm > 12) {
    console.error(`Tham số kỳ không hợp lệ: tháng phải 01–12 (nhận ${argMonth}).`);
    process.exit(2);
  }
  const y = Number(argMonth.slice(0, 4));
  const lastDay = new Date(y, mm, 0).getDate();
  monthWindow = {
    month: argMonth,
    start: `${argMonth}-01`,
    end: `${argMonth}-${String(lastDay).padStart(2, '0')}`,
  };
}

const fmt = (n) => Number(n).toLocaleString('vi-VN');
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// ---- Config (PAT + projectRef). loadSupabaseAdminConfig ném lỗi nếu thiếu. ----
let config;
try {
  config = loadSupabaseAdminConfig();
} catch (e) {
  console.error(`Không nạp được cấu hình Supabase admin: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
const PAT = config.pat;
// Chốt an toàn cuối: dù executeManagementQuery đã tự redact PAT trong lỗi của nó,
// ta redact thêm lần nữa ở mọi thứ tự in ra — KHÔNG BAO GIỜ để PAT lọt ra ngoài.
const redact = (s) => (PAT ? String(s).replaceAll(PAT, '[REDACTED]') : String(s));

// ---- Helper truy vấn READ ONLY (bọc transaction chỉ-đọc; parse JSON) ----
async function roQuery(sql) {
  const body = await executeManagementQuery(
    `BEGIN; SET TRANSACTION READ ONLY;\n${sql};\nCOMMIT;`,
    config,
  );
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Không parse được kết quả Management API: ${redact(body).slice(0, 400)}`);
  }
}

async function main() {
  console.log('\n=== ĐỐI CHIẾU TIỀN V2 — POSTING-AWARE (plan §11.2 / roadmap §4c) ===\n');

  // ---- (3) SCHEMA GATE: chưa có accounts_with_balance_v2 ⇒ Stage-10 chưa forward-apply ----
  const gate = await roQuery(
    `SELECT to_regclass('public.accounts_with_balance_v2')    IS NOT NULL AS v2,
            to_regclass('public.accounts_with_balance')       IS NOT NULL AS legacy,
            to_regclass('public.income_expense_posting_lines') IS NOT NULL AS lines`,
  );
  if (!gate[0]?.v2) {
    console.log('schema not applied');
    console.log(
      '  public.accounts_with_balance_v2 chưa tồn tại (Finance V2 Stage-10 read-models chưa ' +
        'forward-apply) — không có gì để đối chiếu. Thoát 0.',
    );
    process.exit(0);
  }
  if (!gate[0]?.legacy || !gate[0]?.lines) {
    console.error(
      'Schema V2 tồn tại nhưng thiếu accounts_with_balance (legacy) hoặc income_expense_posting_lines — trạng thái bất thường.',
    );
    process.exit(2);
  }

  let mismatch = false;

  // =====================================================================
  // (4) SỐ DƯ SỔ QUỸ — legacy vs v2, chỉ sổ THỰC (is_virtual = false)
  // =====================================================================
  console.log('— §11.2 SỐ DƯ SỔ QUỸ: accounts_with_balance (legacy) vs accounts_with_balance_v2 —');
  console.log('  (chỉ sổ THỰC is_virtual=false; sổ ảo = non-cash, không có posting — roadmap §4c#5)\n');

  const cmpCount = await roQuery(
    `SELECT count(*)::int AS c FROM public.accounts_with_balance_v2 WHERE is_virtual = false`,
  );
  const compared = Number(cmpCount[0]?.c ?? 0);

  // Cả 2 view đều bắt nguồn từ accounts a WHERE deleted_at IS NULL ⇒ cùng tập id.
  // organization_id lấy từ view v2 (legacy view không phơi cột này).
  const diffs = await roQuery(
    `SELECT v2.id::text                              AS account_id,
            v2.organization_id::text                 AS organization_id,
            COALESCE(v2.name, '')                    AS name,
            COALESCE(l.current_amount, 0)::text      AS legacy_amount,
            COALESCE(v2.current_amount, 0)::text     AS v2_amount,
            (COALESCE(v2.current_amount,0) - COALESCE(l.current_amount,0))::text AS diff
       FROM public.accounts_with_balance_v2 v2
       JOIN public.accounts_with_balance    l ON l.id = v2.id
      WHERE v2.is_virtual = false
        AND abs(COALESCE(v2.current_amount,0) - COALESCE(l.current_amount,0)) >= ${EPS}
      ORDER BY abs(COALESCE(v2.current_amount,0) - COALESCE(l.current_amount,0)) DESC`,
  );

  console.log(`  Sổ THỰC đối chiếu : ${compared}`);
  if (diffs.length === 0) {
    console.log(`  ✅ Khớp toàn bộ (mọi sổ THỰC có abs(diff) < ${EPS} VND).\n`);
  } else {
    mismatch = true;
    console.log(`  ❌ ${diffs.length} sổ LỆCH (legacy ≠ v2):\n`);
    for (const r of diffs) {
      const nm = r.name ? ` — ${r.name}` : '';
      console.log(`    · account ${r.account_id}  org ${r.organization_id}${nm}`);
      console.log(
        `      legacy ${fmt(r.legacy_amount)}  |  v2 ${fmt(r.v2_amount)}  |  diff ${fmt(r.diff)} VND`,
      );
    }
    console.log('');
  }

  // =====================================================================
  // (5) CAP-1000 GUARD — dual/tri-count trên posting lines (POSTING+REVERSAL)
  // =====================================================================
  const win = monthWindow
    ? `AND p.posted_on >= '${monthWindow.start}' AND p.posted_on <= '${monthWindow.end}'`
    : '';
  const scopeLabel = monthWindow ? `kỳ ${monthWindow.month} (theo posted_on)` : 'toàn bộ lịch sử';
  // Bộ lọc chung cho cả 3 nguồn (T/N/P) — PHẢI y hệt nhau mới so được.
  const base =
    `FROM public.income_expense_posting_lines pl
       JOIN public.income_expense_postings p
         ON p.id = pl.posting_id AND p.organization_id = pl.organization_id
      WHERE p.event_kind IN ('POSTING', 'REVERSAL') ${win}`;

  console.log(`— §11.2 CAP-1000 GUARD: SUM(signed_amount) posting lines (POSTING+REVERSAL), ${scopeLabel} —\n`);

  // T — chân lý: aggregate SUM trong DB (miễn nhiễm cap-1000).
  const tRows = await roQuery(
    `SELECT COALESCE(SUM(pl.signed_amount), 0)::text AS v, count(*)::int AS c ${base}`,
  );
  const truth = round2(tRows[0].v);
  const total = Number(tRows[0].c);

  // N — chỉ 1000 dòng ĐẦU (aggregate trên subquery LIMIT 1000): mô phỏng client KHÔNG phân trang.
  const nRows = await roQuery(
    `SELECT COALESCE(SUM(s.signed_amount), 0)::text AS v
       FROM (SELECT pl.signed_amount ${base} ORDER BY pl.id LIMIT ${PAGE}) s`,
  );
  const naive = round2(nRows[0].v);

  // P — phân trang 1000 dòng/trang, CỘNG CLIENT (replicate src/lib/supabaseFetchAll.ts).
  let from = 0;
  let pagedSum = 0;
  let pages = 0;
  for (;;) {
    const rows = await roQuery(
      `SELECT pl.signed_amount::text AS s ${base} ORDER BY pl.id LIMIT ${PAGE} OFFSET ${from}`,
    );
    if (rows.length === 0) break; // trang RỖNG = hết thật
    pages += 1;
    for (const r of rows) pagedSum += Number(r.s);
    from += rows.length;
    if (from > HARD_CAP) {
      // FAIL-CLOSED: thà lỗi ồn ào còn hơn cộng thiếu âm thầm.
      throw new Error(`Phân trang vượt hardCap ${HARD_CAP} dòng — nghi order không ổn định.`);
    }
  }
  const paged = round2(pagedSum);

  console.log(`  Dòng posting                                     : ${total}`);
  console.log(`  T · SQL SUM aggregate (chân lý, miễn nhiễm cap)  : ${fmt(truth)} VND`);
  console.log(`  P · Phân trang ${PAGE}/trang, cộng client (${pages} trang) : ${fmt(paged)} VND`);
  console.log(`  N · Chỉ ${PAGE} dòng đầu (client KHÔNG phân trang)  : ${fmt(naive)} VND\n`);

  if (Math.abs(paged - truth) >= EPS) {
    mismatch = true;
    console.log(
      `  ❌ P ≠ T (${fmt(paged)} vs ${fmt(truth)}) — phân trang cộng THIẾU/TRÙNG ` +
        `(dính cap-1000 / order không ổn định).`,
    );
  } else {
    console.log(`  ✅ P == T — phân trang khôi phục ĐỦ tổng (không dính cap-1000).`);
  }

  if (total > PAGE) {
    if (Math.abs(naive - truth) >= EPS) {
      console.log(
        `  ℹ️  N ≠ T (lệch ${fmt(round2(truth - naive))} VND) — CHỨNG MINH: client cộng ${PAGE} ` +
          `dòng đầu KHÔNG phân trang sẽ SAI. Reader v2 dùng SQL aggregate nên an toàn (không tính FAIL).`,
      );
    } else {
      console.log(`  ℹ️  N == T dù >${PAGE} dòng (dữ liệu tình cờ dồn trong ${PAGE} dòng đầu theo order).`);
    }
  } else {
    console.log(`  ℹ️  Chỉ ${total} dòng (≤${PAGE}) — chưa kích hoạt được ngưỡng cap-1000 để chứng minh.`);
  }
  console.log('');

  // =====================================================================
  // PHÁN QUYẾT
  // =====================================================================
  if (mismatch) {
    console.log('=== ❌ LỆCH — có sai khác giữa nguồn cũ và posting-aware. Xem chi tiết ở trên. ===\n');
    process.exit(1);
  }
  console.log('=== ✅ PASS — số dư legacy == v2 (sổ thực) và phân trang khớp SQL aggregate. ===\n');
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nLỖI: ${redact(e instanceof Error ? e.message : String(e))}\n`);
  process.exit(2);
});