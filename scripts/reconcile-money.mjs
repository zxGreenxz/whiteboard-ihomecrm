// Máy đối chiếu tiền — 3 NGUỒN ĐỘC LẬP cho một chỉ tiêu tiền trong một kỳ.
// Trấn an điểm đau "không tin số liệu phải đối chiếu tay" + chốt cứng bug class
// "SELECT-rồi-cộng-client dính cap 1000 dòng PostgREST" (án lệ: từng hụt ~1,5 tỷ).
//
// CHỈ TIÊU: Tổng THU đã DUYỆT (income_expenses type=INCOME, approval=APPROVED,
//           chưa xoá) theo THÁNG của voucher_date. Yêu cầu A === B === C (VND nguyên).
//
//   NGUỒN A — CHÂN LÝ (SQL aggregate qua Management API / Bearer PAT):
//     SUM(total_amount) thuần trong SQL. Chạy dưới role postgres (BỎ QUA RLS),
//     miễn nhiễm cap-1000 (aggregate trong DB, không kéo dòng về). Đây là mốc thật.
//
//   NGUỒN B — RLS + JWT thật + RPC SECURITY INVOKER:
//     đăng nhập tài khoản test → gọi RPC aggregate get_income_expense_layer_stats
//     (SECURITY INVOKER: RLS áp theo người gọi). Tổng THU duyệt = cash_income +
//     internal_income + pending_income (bất biến với cách phân lớp). Cũng aggregate
//     server-side nên KHÔNG dính cap-1000 → phải KHỚP A. Đây là đường DUY NHẤT
//     đi qua RLS + JWT authenticated. A≠B ⇒ nghi RLS/RPC scope sai (khác quyền).
//
//   NGUỒN C — ĐƯỜNG FE list-rồi-cộng (cùng JWT, replicate src/lib/supabaseFetchAll.ts):
//     lặp .range(from, from+999) với order ỔN ĐỊNH (voucher_date desc, id asc) trên
//     ĐÚNG bộ lọc của A/B rồi .reduce total_amount phía client. Chứng minh phân
//     trang khôi phục ĐỦ tổng khi vượt trần 1000 DÒNG/RESPONSE của PostgREST
//     (cơ chế bug THẬT — KHÔNG phải LIMIT 1000 trong SQL). B==A nhưng C<A ⇒ FE
//     thiếu phân trang / dính cap-1000.
//
// DATASET GUARD: cap-1000 chỉ CHỨNG MINH được khi cửa sổ có >1000 dòng khớp bộ lọc.
//   Không truyền kỳ → tự GOM từ kỳ mới nhất lùi dần cho tới khi vượt 1000 dòng.
//   Gom nhiều kỳ là hợp lệ vì trần 1000 là trần DÒNG/RESPONSE của PostgREST, không
//   liên quan ranh giới tháng. Chỉ khi CẢ TẬP dữ liệu ≤1000 dòng mới THOÁT 3
//   (không kết luận được) — KHÔNG báo xanh giả.
//
// Không sửa dữ liệu. Chỉ đọc. KHÔNG in PAT/JWT ra ngoài.
// Chạy: node scripts/reconcile-money.mjs [YYYY-MM]
// Exit: 0 khớp · 1 lệch · 2 lỗi · 3 inconclusive (thiếu >1000 dòng để chứng minh).
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const PAGE = 1000; // = SUPABASE_PAGE (src/lib/supabaseFetchAll.ts)
const HARD_CAP = 100_000; // trần an toàn phân trang: vượt = nghi order không ổn định
const REF_CONST = 'tryymsxyyckgbrmmvozx';

// ---- helpers đọc config (không in secret) ----
const readRel = (rel) => {
  try {
    return readFileSync(new URL(rel, import.meta.url), 'utf8');
  } catch {
    return '';
  }
};
const local = readRel('../CLAUDE.local.md');
const env = readRel('../.env');
const pick = (src, re) => (src.match(re)?.[1] ?? '').trim();

// PAT (Management API) — env trước, rồi CLAUDE.local.md
const pat = process.env.SUPABASE_PAT || local.match(/sbp_[a-f0-9]+/)?.[0] || '';
if (!pat) {
  console.error('Không tìm thấy Supabase PAT (SUPABASE_PAT hoặc CLAUDE.local.md).');
  process.exit(2);
}

// Project ref: env → supabase/.temp/project-ref → linked-project.json → hằng số
const refFromTemp = readRel('../supabase/.temp/project-ref').trim();
const refFromLinked = (() => {
  try {
    return JSON.parse(readRel('../supabase/.temp/linked-project.json'))?.ref || '';
  } catch {
    return '';
  }
})();
const ref = process.env.SUPABASE_PROJECT_REF || refFromTemp || refFromLinked || REF_CONST;

// URL + ANON/publishable key (KHÔNG dùng PAT ở đây) — nguồn: src/integrations/supabase/client.ts
// đọc từ import.meta.env; ở Node ta lấy env process hoặc file .env.
const supabaseUrl =
  process.env.VITE_SUPABASE_URL || pick(env, /VITE_SUPABASE_URL="?([^"\r\n]+)"?/);
const anonKey =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  pick(env, /VITE_SUPABASE_PUBLISHABLE_KEY="?([^"\r\n]+)"?/);
if (!supabaseUrl || !anonKey) {
  console.error('Thiếu VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY (env hoặc .env).');
  process.exit(2);
}

// Tài khoản test (RLS + JWT thật) — env override, rồi CLAUDE.local.md
const testEmail =
  process.env.SUPABASE_TEST_EMAIL || pick(local, /Email:\s*`([^`]+)`/);
const testPassword =
  process.env.SUPABASE_TEST_PASSWORD || pick(local, /Password:\s*`([^`]+)`/);
if (!testEmail || !testPassword) {
  console.error('Thiếu tài khoản test (SUPABASE_TEST_EMAIL/PASSWORD hoặc CLAUDE.local.md).');
  process.exit(2);
}

// ---- HARDENING (a): chốt SQL-injection — chỉ nhận đúng YYYY-MM ----
const argMonth = process.argv[2];
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
}

const fmt = (n) => Number(n).toLocaleString('vi-VN');

// ---- Management API (NGUỒN A) ----
async function sqlQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) {
    // KHÔNG in header/PAT — chỉ status + body (đã là lỗi phía server)
    throw new Error(`Management API ${res.status}: ${body.slice(0, 400)}`);
  }
  return JSON.parse(body);
}

// ---- client authenticated (NGUỒN B + C) ----
const sb = createClient(supabaseUrl, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const FILTER = `type='INCOME' AND approval_status='APPROVED' AND deleted_at IS NULL`;
// Source A chạy dưới postgres (BỎ QUA RLS) → thấy CẢ dữ liệu org tập dượt mà tài
// khoản test bị policy *_hide_demo_admin / *_hide_sandbox_admin ẩn đi. Phải thu
// phạm vi A về đúng phần B/C nhìn thấy, nếu không sẽ lệch đúng bằng phần bị ẩn.
//
// Bản trước loại theo `NOT (user_id = ANY(demo_user_ids()))` — một DANH SÁCH ĐEN,
// và nó đã TRÔI: org nhân bản `ihome-test` (cccc…) ra đời sau, không nằm trong
// danh sách đó, nên A thừa 709 phiếu / 3,52 tỷ so với B và C. Chỗ lệch này ngủ yên
// vì cửa chặn luôn thoát 3 trước khi kịp so — cả hai lỗi che nhau.
//
// Nay dùng DANH SÁCH TRẮNG suy từ dữ liệu: chỉ tổ chức có is_demo = false. Org tập
// dượt mới sinh ra sẽ tự nằm ngoài; còn nếu ai quên đánh cờ thì gate ĐỎ — hướng
// hỏng đúng, vì "quên đánh dấu org tập dượt" là thứ phải biết chứ không phải thứ
// nên bỏ qua.
const SQL_FILTER =
  `${FILTER} AND organization_id IN (SELECT id FROM public.organizations WHERE is_demo = false)`;

const bienNgay = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return { dau: `${m}-01`, cuoi: `${m}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}` };
};

// Chọn CỬA SỔ đối chiếu + đếm số phiếu khớp bộ lọc (cho DATASET GUARD).
//
// Bản trước chỉ xét MỘT kỳ, và kỳ đông nhất trên dữ liệu thật chỉ có 723 phiếu —
// dưới trần 1000. Nghĩa là cửa chặn này thoát 3 (INCONCLUSIVE) mỗi lần chạy và
// CHƯA BAO GIỜ chứng minh được điều nó sinh ra để chứng minh. Một cửa chặn tiền
// vĩnh viễn không kết luận được thì không canh gì cả — nó chỉ trông như đang canh.
//
// Trần 1000 là trần DÒNG/RESPONSE của PostgREST, không liên quan gì tới ranh giới
// tháng. Nên gom nhiều tháng liền kề là cách hợp lệ để kích hoạt đúng cơ chế đó,
// và cả ba nguồn A/B/C đều nhận được khoảng ngày (voucher_date kiểu `date` nên so
// khoảng là chính xác, không có bẫy múi giờ).
async function resolveWindow() {
  if (argMonth) {
    const { dau, cuoi } = bienNgay(argMonth);
    const rows = await sqlQuery(
      `SELECT count(*)::int c FROM income_expenses
         WHERE ${SQL_FILTER} AND voucher_date BETWEEN '${dau}' AND '${cuoi}'`,
    );
    return { start: dau, end: cuoi, count: Number(rows[0]?.c ?? 0), auto: false, moTa: argMonth };
  }
  // Auto: gom từ kỳ MỚI NHẤT lùi dần cho tới khi vượt 1000 dòng — cửa sổ NHỎ NHẤT
  // chạm được trần, tức nhanh nhất và sát dữ liệu đang dùng nhất.
  const rows = await sqlQuery(
    `SELECT to_char(voucher_date,'YYYY-MM') m, count(*)::int c FROM income_expenses
       WHERE ${SQL_FILTER} GROUP BY 1 ORDER BY 1 DESC`,
  );
  if (!rows.length) {
    console.error('Không có phiếu THU đã duyệt nào để đối chiếu.');
    process.exit(3);
  }
  let luyKe = 0;
  let i = 0;
  for (; i < rows.length; i++) {
    luyKe += Number(rows[i].c);
    if (luyKe > PAGE) break;
  }
  const cuoiCung = rows[Math.min(i, rows.length - 1)];
  const start = bienNgay(cuoiCung.m).dau;
  const end = bienNgay(rows[0].m).cuoi;
  return {
    start,
    end,
    count: luyKe,
    auto: true,
    moTa: rows[0].m === cuoiCung.m ? rows[0].m : `${cuoiCung.m} → ${rows[0].m} (${i + 1} kỳ)`,
  };
}

async function run() {
  console.log(`\n=== ĐỐI CHIẾU TIỀN — 3 NGUỒN ĐỘC LẬP (A=SQL · B=RPC+RLS · C=phân trang) ===\n`);

  // Đăng nhập JWT thật (NGUỒN B + C đi qua RLS).
  const { error: authErr } = await sb.auth.signInWithPassword({
    email: testEmail,
    password: testPassword,
  });
  if (authErr) {
    console.error(`Đăng nhập tài khoản test THẤT BẠI: ${authErr.message}`);
    process.exit(2);
  }

  const { start, end, count, auto, moTa } = await resolveWindow();
  console.log(`Chỉ tiêu : Tổng THU đã duyệt (income_expenses INCOME/APPROVED)`);
  console.log(`Cửa sổ   : ${moTa}${auto ? '  (tự gom từ kỳ mới nhất cho tới khi vượt 1000 dòng)' : ''}`);
  console.log(`Khoảng   : ${start} … ${end}`);
  console.log(`Số phiếu : ${count} dòng khớp bộ lọc\n`);

  // ---- HARDENING (c): DATASET GUARD ----
  if (count <= PAGE) {
    console.error(`⏹  KHÔNG KẾT LUẬN ĐƯỢC — cần >${PAGE} dòng mới chứng minh được cap-1000`);
    console.error(
      `    Cửa sổ ${moTa} chỉ có ${count} phiếu (≤${PAGE}) → không kích hoạt được ` +
        `trần ${PAGE} dòng/response của PostgREST, nên KHÔNG chứng minh được đường ` +
        `phân trang (NGUỒN C) khôi phục đủ tổng.`,
    );
    console.error(
      auto
        ? `    (đã gom TOÀN BỘ kỳ có dữ liệu; cả tập dữ liệu vẫn ≤${PAGE} dòng)`
        : `    Bỏ tham số kỳ để tự gom nhiều kỳ cho tới khi vượt ${PAGE} dòng.`,
    );
    process.exit(3);
  }

  // ---- NGUỒN A: SUM() thuần SQL (chân lý, bỏ qua RLS, miễn nhiễm cap-1000) ----
  const aRows = await sqlQuery(
    `SELECT COALESCE(SUM(total_amount),0)::text v FROM income_expenses
       WHERE ${SQL_FILTER} AND voucher_date BETWEEN '${start}' AND '${end}'`,
  );
  const A = Math.round(Number(aRows[0].v));

  // ---- NGUỒN B: RPC aggregate SECURITY INVOKER qua JWT (RLS) ----
  // Tổng THU duyệt = cash + internal + pending income (bất biến với p_internal_sources).
  const { data: rpc, error: rpcErr } = await sb.rpc('get_income_expense_layer_stats', {
    p_type: 'INCOME',
    p_approval: 'APPROVED',
    p_start_date: start,
    p_end_date: end,
  });
  if (rpcErr) throw new Error(`RPC get_income_expense_layer_stats: ${rpcErr.message}`);
  const r = rpc?.[0] ?? {};
  const B = Math.round(
    Number(r.cash_income ?? 0) + Number(r.internal_income ?? 0) + Number(r.pending_income ?? 0),
  );

  // ---- NGUỒN C: đường FE list-rồi-cộng, phân trang (replicate fetchAllRows) ----
  let from = 0;
  let cSum = 0;
  let cRows = 0;
  let pages = 0;
  for (;;) {
    const { data, error } = await sb
      .from('income_expenses')
      .select('total_amount')
      .eq('type', 'INCOME')
      .eq('approval_status', 'APPROVED')
      .is('deleted_at', null)
      .gte('voucher_date', start)
      .lte('voucher_date', end)
      .order('voucher_date', { ascending: false })
      .order('id', { ascending: true }) // tiebreaker duy nhất — phân trang không sót/trùng
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Phân trang FE (NGUỒN C): ${error.message}`);
    pages++;
    const rows = data ?? [];
    if (rows.length === 0) break; // trang RỖNG = hết thật (không suy từ "trang ngắn")
    for (const row of rows) cSum += Number(row.total_amount);
    cRows += rows.length;
    from += rows.length;
    if (cRows > HARD_CAP) {
      // FAIL-CLOSED: vượt trần = nghi order không ổn định → thà lỗi ồn ào còn hơn cộng thiếu.
      throw new Error(`NGUỒN C vượt hardCap ${HARD_CAP} dòng — nghi order không ổn định.`);
    }
  }
  const C = Math.round(cSum);

  // ---- Bảng so sánh ----
  console.log('┌─ NGUỒN ─────────────────────────────────────────┬─ VND ───────────────┐');
  console.log(`│ A · SQL SUM (Management API, chân lý)            │ ${fmt(A).padStart(19)} │`);
  console.log(`│ B · RPC layer_stats (JWT + RLS, invoker)        │ ${fmt(B).padStart(19)} │`);
  console.log(`│ C · Phân trang FE (JWT + RLS, .range)           │ ${fmt(C).padStart(19)} │`);
  console.log('└─────────────────────────────────────────────────┴─────────────────────┘');
  console.log(`   C: ${cRows} dòng qua ${pages - 1} trang + 1 trang rỗng\n`);

  // ---- Info line (KHÔNG tính PASS/FAIL): tổng số dư mọi sổ quỹ ----
  try {
    const acc = await sqlQuery(
      `SELECT COALESCE(SUM(current_amount),0)::text v, count(*)::int c
         FROM accounts_with_balance WHERE deleted_at IS NULL`,
    );
    console.log(
      `ℹ️  (info, KHÔNG tính PASS/FAIL) Tổng số dư mọi sổ quỹ: ` +
        `${fmt(acc[0]?.v ?? 0)} VND  (${acc[0]?.c ?? 0} sổ)\n`,
    );
  } catch {
    /* info-only: bỏ qua nếu view không sẵn */
  }

  // ---- PHÁN QUYẾT ----
  // LỆCH được xét TRƯỚC mọi guard "đủ dữ liệu chưa". Đặt ngược lại là để guard
  // nuốt mất phát hiện thật: khi đường FE bỏ phân trang, nó chỉ kéo đúng 1 trang
  // ⇒ cRows == 1000 ⇒ guard cRows>PAGE bắn exit 3 và cái lệch tiền không bao giờ
  // được in ra. Đột biến "chỉ lấy trang đầu" bắt được đúng lỗi này ở bản nháp.
  if (A !== B || B !== C) {
    console.log(`=== ❌ LỆCH — A/B/C KHÔNG bằng nhau ===`);
  } else {
    // DATASET GUARD lần hai, trên ĐÚNG con số quyết định. Guard đầu đếm bằng SQL
    // (bỏ qua RLS); đường đang thử là C, đi QUA RLS — nếu RLS thu hẹp tập xuống
    // dưới trần thì cap-1000 không hề bị chạm dù SQL đếm ra 1630. Bản trước in
    // thẳng "(vượt 1000 ⇒ có kích hoạt cap-1000)" mà không nhìn cRows, nên nó
    // khẳng định đã kích hoạt trong đúng lần chạy mà C chỉ kéo 921 dòng.
    if (cRows <= PAGE) {
      console.error(`⏹  KHÔNG KẾT LUẬN ĐƯỢC — đường C chỉ kéo ${cRows} dòng (≤${PAGE}).`);
      console.error(`    Ba nguồn BẰNG NHAU, nhưng trần ${PAGE} dòng/response KHÔNG bị chạm nên`);
      console.error(`    lần chạy này không chứng minh được gì về phân trang. Nới cửa sổ hoặc chờ dữ liệu.`);
      process.exit(3);
    }
    console.log(`   ✓ ${cRows} > ${PAGE} ⇒ trần cap-1000 CÓ bị chạm, phân trang thực sự được thử.`);
    console.log(`=== ✅ PASS — A === B === C (${fmt(A)} VND) ===\n`);
    process.exit(0);
  }

  if (A !== B) {
    console.log(
      `    A ≠ B (${fmt(A)} vs ${fmt(B)}) ⇒ nghi RLS/RPC SCOPE sai: JWT test thấy ` +
        `khác chân lý (thiếu quyền toà, hoặc RPC lọc sai).`,
    );
  }
  if (A === B && C !== A) {
    if (C < A) {
      console.log(
        `    B == A nhưng C < A (${fmt(C)} < ${fmt(A)}) ⇒ đường FE THIẾU PHÂN TRANG ` +
          `/ dính cap-1000 (âm thầm cộng thiếu).`,
      );
    } else {
      console.log(
        `    C > A (${fmt(C)} > ${fmt(A)}) ⇒ phân trang TRÙNG dòng (order không ổn định).`,
      );
    }
  }
  if (A !== B && C !== A && C !== B) {
    console.log(`    Cả 3 nguồn lệch nhau — kiểm tra cả scope RLS lẫn phân trang.`);
  }
  console.log('');
  process.exit(1);
}

run().catch((e) => {
  console.error(`\nLỖI: ${e.message}\n`);
  process.exit(2);
});
