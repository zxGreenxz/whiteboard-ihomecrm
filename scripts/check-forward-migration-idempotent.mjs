#!/usr/bin/env node
// Gate: mọi migration SAU CUTOFF phải chạy được HAI LẦN mà không hỏng.
//
// VÌ SAO — có án lệ hôm nay, 07/08/2026
//   Một migration đã được apply thẳng qua Management API, rồi apply LẠI qua lane
//   chính thức để hợp thức hoá. Cơ sở cho việc apply lại là câu "migration
//   idempotent nên re-apply an toàn". Câu đó ĐÚNG — nhưng lúc bấm nút thì chưa ai
//   kiểm chứng nó, và nếu sai thì hậu quả là bút toán hoặc ràng buộc nhân đôi
//   trên sổ sách tiền thật.
//
//   Re-apply không phải chuyện hiếm: nó xảy ra khi apply hỏng giữa chừng, khi
//   dựng lại môi trường từ baseline + forward lane, và khi hợp thức hoá một thay
//   đổi đã đi đường tắt. Cả ba đều là lúc người ta đang vội.
//
// CÁCH KIỂM
//   Dán thân migration HAI LẦN vào cùng một transaction rồi ROLLBACK. Chạy trên
//   production nhưng KHÔNG ghi gì — cùng cơ chế dry-run mà lane vẫn dùng, kèm
//   chốt chặn của buildTransaction: transaction phải đóng đúng MỘT lần và đóng
//   bằng ROLLBACK, nếu không thì ném.
//
// ĐIỀU NÀY KHÔNG PHỦ — ghi ra để không ai tin quá lời:
//   Nó bắt được lớp lỗi NÉM (CREATE thiếu IF NOT EXISTS, ALTER thêm cột đã có,
//   ràng buộc trùng tên). Nó KHÔNG bắt được lớp GHI ĐÈ IM LẶNG: một `INSERT`
//   không có `ON CONFLICT` sẽ chèn hai dòng mà không báo lỗi nào. Muốn phủ nốt
//   phải so trạng thái trước/sau từng lượt — việc đó cần database dùng-một-lần,
//   không làm trên production được.
//
//   node scripts/check-forward-migration-idempotent.mjs
//   node scripts/check-forward-migration-idempotent.mjs --file <đường-dẫn>
//
// Cần SUPABASE_PAT. KHÔNG ghi gì (mọi thứ ROLLBACK). Thoát 0 · 1 · 3.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTransaction } from "./apply-reviewed-migration.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(repoRoot, "supabase", "migrations");
const SO = join(repoRoot, "tooling", "idempotent-verified.json");

/** Sàn chống rỗng: nếu không tìm được file nào sau cutoff, "0 lỗi" là vô nghĩa. */
export const TOI_THIEU_FILE = 1;

export function pat() {
  if (process.env.SUPABASE_PAT) return process.env.SUPABASE_PAT;
  try {
    return readFileSync(join(repoRoot, "CLAUDE.local.md"), "utf8").match(/sbp_[a-f0-9]+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * SỔ CHỨNG NHẬN THEO DIGEST — vì sao cần, và vì sao nó không phải nới tay.
 *
 * VẤN ĐỀ: cửa này quét MỌI file sau cutoff, mà cutoff đứng yên từ 06/08/2026.
 * Tập đó CHỈ TĂNG: đo 25/08/2026 là 60 file, mỗi file dán hai lượt qua mạng tới
 * production, tổng 176 giây MỖI LẦN CI chạy — và mỗi migration mới cộng thêm ~3 giây
 * vĩnh viễn. Người viết một tính năng nhỏ phải trả giá cho toàn bộ quá khứ.
 *
 * VÌ SAO BỎ QUA ĐƯỢC MÀ KHÔNG MẤT GÌ: file sau cutoff là forward-only và BẤT BIẾN
 * — policy đã cấm sửa/đổi tên/di chuyển, và migration-provenance.json giữ sha256
 * của từng file. Một file có NỘI DUNG không đổi thì phép đo chạy lại trên nó cũng
 * không đổi. Sổ này khoá theo sha256, nên sửa MỘT byte là mất chứng nhận và file
 * bị đo lại — không có đường nào để một thay đổi lọt qua.
 *
 * KHÁC cutoff: dời cutoff sẽ làm lệch bộ khôi phục (baseline/schema.sql + forward
 * lane phải cộng lại đúng production). Sổ này không đụng tới hợp đồng đó.
 */
export function docSo(duong = SO) {
  try {
    const j = JSON.parse(readFileSync(duong, "utf8"));
    return j?.entries && typeof j.entries === "object" ? j.entries : {};
  } catch {
    return {};
  }
}

export function bam(noiDung) {
  return createHash("sha256").update(noiDung, "utf8").digest("hex");
}

/**
 * Chia tập quét thành "phải đo" và "đã có chứng nhận".
 * Thuần tuý, không I/O — test được.
 */
export function chiaTheoSo(files, digest, so) {
  const phaiDo = [];
  const daChung = [];
  for (const f of files) {
    const e = so[f];
    if (e && e.sha256 === digest.get(f)) daChung.push(f);
    else phaiDo.push(f);
  }
  return { phaiDo, daChung };
}

export function docCutoff() {
  const p = JSON.parse(readFileSync(join(repoRoot, "supabase", "migration-policy.json"), "utf8"));
  return String(p.provisionalCutoff?.version ?? p.cutoff ?? "");
}

/**
 * Ngoại lệ CÓ TÊN cho cửa idempotent, đọc từ migration-policy.json.
 *
 * VÌ SAO CẦN — và vì sao nó KHÔNG phải là nới tay.
 *   Cửa này dán thân migration HAI LẦN vào MỘT transaction. Cách đó bắt được
 *   lớp lỗi thật (CREATE thiếu IF NOT EXISTS, ràng buộc trùng tên), nhưng nó
 *   cũng buộc tội sai hai lớp file mà việc chạy lại THẬT — hai transaction
 *   riêng — hoàn toàn không đụng tới:
 *
 *     1. TEMP TABLE ... ON COMMIT DROP. Bảng tạm chỉ biến mất lúc COMMIT, mà
 *        cửa này ROLLBACK, nên lần dán thứ hai gặp lại bảng của lần thứ nhất và
 *        chết với 42P07. Không có cách viết nào tránh được — vấn đề nằm ở PHÉP
 *        ĐO, không nằm ở file.
 *     2. Khối tự-kiểm gọi hàm có bộ đếm/giới hạn nhịp. Gọi hai lần liên tiếp
 *        trong một transaction thì lần thứ hai chạm trần và ném — đúng như hàm
 *        được thiết kế.
 *
 *   Và một lớp thứ ba mà việc chạy lại PHẢI hỏng, vì đó chính là tính năng:
 *
 *     3. Migration một-lần có chốt đo. Chúng đối chiếu dữ liệu với con số đo
 *        được lúc diễn tập rồi DỪNG nếu lệch ("chỉ xoá được 530 dòng, kỳ vọng
 *        165.548"). Chạy lại nó phải ngã. Một file như thế mà chạy lại êm ru
 *        mới là điều đáng sợ.
 *
 *   Nếu để cả ba lớp trên làm cửa đỏ vĩnh viễn thì cửa sẽ bị tắt, và cùng lúc
 *   mất luôn khả năng chặn lớp lỗi THẬT. Nên: khai tên, khai lý do, và bắt mỗi
 *   mục phải còn hỏng thật thì mới được tính.
 *
 * Danh sách này CHỈ ĐƯỢC TEO. Mục khai mà file đã chạy lại được ⇒ chính nó là
 * lỗi (xem phần kiểm ở main): để lại một miễn trừ thừa là mở sẵn cửa cho lần
 * sau có người viết đúng file đó theo kiểu không chạy lại được.
 */
export function docMienTru() {
  const p = JSON.parse(readFileSync(join(repoRoot, "supabase", "migration-policy.json"), "utf8"));
  return new Map((p.idempotencyExceptions ?? []).map((x) => [x.file, x]));
}

/** File .sql có version 14 chữ số LỚN HƠN cutoff. */
export function timFileSauCutoff(danhSach, cutoff) {
  return danhSach
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => /^\d{14}_/.test(f) && f.slice(0, 14) > cutoff)
    .sort();
}

async function chaySql(ref, token, sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

async function main() {
  const token = pat();
  if (!token) {
    console.error("=== ⚠ KHÔNG KIỂM ĐƯỢC — KHÔNG PHẢI PASS ===");
    console.error("  Thiếu SUPABASE_PAT (env) hoặc CLAUDE.local.md.");
    process.exit(3);
  }
  const ref = readFileSync(join(repoRoot, "supabase", "config.toml"), "utf8").match(/project_id\s*=\s*"([^"]+)"/)[1];
  const cutoff = docCutoff();
  if (!/^\d{14}$/.test(cutoff)) {
    console.error(`❌ Không đọc được cutoff hợp lệ từ migration-policy.json (nhận "${cutoff}").`);
    process.exit(3);
  }

  const i = process.argv.indexOf("--file");
  const quetToanBo = !(i >= 0 && process.argv[i + 1]);
  const files = quetToanBo
    ? timFileSauCutoff(readdirSync(DIR), cutoff)
    : [process.argv[i + 1].split(/[\\/]/).pop()];
  const mienTru = docMienTru();
  const daKhop = new Set();

  if (files.length < TOI_THIEU_FILE) {
    console.error(`❌ Không có file nào sau cutoff ${cutoff} — "0 lỗi" là câu đúng mà vô nghĩa.`);
    process.exit(3);
  }

  // ── Sổ chứng nhận theo digest ───────────────────────────────────────────
  const boQuaSo = process.argv.includes("--bo-qua-so");
  const ghiSo = process.argv.includes("--ghi-so");
  const digest = new Map(files.map((f) => [f, bam(readFileSync(join(DIR, f), "utf8"))]));
  const so = boQuaSo ? {} : docSo();
  const { phaiDo, daChung } = chiaTheoSo(files, digest, so);

  // Sổ có mục cho file KHÔNG còn trong tầm quét ⇒ sổ đang tả một thế giới khác.
  // Không chặn, nhưng phải nói ra: một cuốn sổ lệch trong im lặng là cửa tự mở.
  const racSo = Object.keys(so).filter((f) => !digest.has(f));
  if (racSo.length > 0) {
    console.log(`⚠ ${racSo.length} mục trong tooling/idempotent-verified.json không còn file tương ứng — chạy --ghi-so để dọn.`);
  }

  const dsChay = quetToanBo ? phaiDo : files;
  console.log(`Idempotency: ${files.length} migration sau cutoff ${cutoff} · mỗi file chạy HAI LẦN rồi ROLLBACK`);
  if (quetToanBo) {
    console.log(`  đo lần này: ${dsChay.length} · bỏ qua theo sha256 đã chứng nhận: ${daChung.length}`);
    console.log("  (file sau cutoff là BẤT BIẾN theo policy; sửa một byte là mất chứng nhận và bị đo lại.");
    console.log("   --bo-qua-so để ép đo hết, --ghi-so để cập nhật sổ.)");
  }
  console.log("");

  const hong = [];
  const chungMoi = [];
  for (const f of dsChay) {
    let sql;
    try {
      sql = buildTransaction(readFileSync(join(DIR, f), "utf8"), { rollback: true, lanChay: 2 });
    } catch (e) {
      hong.push({ f, vi: `không dựng được transaction: ${e.message}` });
      console.log(`  ✗ ${f}\n      ${e.message}`);
      continue;
    }
    const kq = await chaySql(ref, token, sql);

    // PHÂN BIỆT "KHÔNG HỎI ĐƯỢC" VỚI "HỎI RỒI, HỎNG".
    //
    // Bản đầu gộp cả hai: PAT hết hạn ⇒ mọi lời gọi trả 401 ⇒ mọi migration bị
    // ghi là "không chạy lại được lần hai". Tức gate BUỘC TỘI SAI, và tệ hơn là
    // nó chỉ người đọc đi thêm IF NOT EXISTS vào những file vốn không có vấn đề
    // gì. Cùng lớp lỗi với cửa chặn sandbox từng kêu "Có rò rỉ" khi nó chỉ không
    // hỏi được — đã sửa sáng nay, và đây là lần thứ hai trong ngày.
    if (!kq.ok && (kq.status === 401 || kq.status === 403 || kq.status >= 500)) {
      console.error(`\n=== ⚠ KHÔNG KIỂM ĐƯỢC — KHÔNG PHẢI PASS, CŨNG KHÔNG PHẢI FAIL ===`);
      console.error(`  Management API trả ${kq.status} khi chạy ${f}.`);
      console.error(`  ${kq.text.slice(0, 200)}`);
      console.error(`  Token hết hạn / thiếu quyền / server lỗi — KHÔNG kết luận gì về migration.`);
      process.exit(3);
    }

    if (kq.ok) {
      console.log(`  ✓ ${f}`);
      chungMoi.push([f, "chay-lai-duoc"]);
    } else {
      // Lấy đúng câu lỗi Postgres, bỏ phần bao JSON — người đọc cần biết CÂU NÀO hỏng.
      let vi = kq.text.slice(0, 300);
      try {
        vi = JSON.parse(kq.text).message ?? vi;
      } catch {
        /* giữ nguyên text thô nếu không phải JSON */
      }
      const mt = mienTru.get(f);
      if (mt) {
        daKhop.add(f);
        console.log(`  ~ ${f}  (miễn trừ: ${mt.lop})`);
        chungMoi.push([f, "mien-tru"]);
      } else {
        hong.push({ f, vi });
        console.log(`  ✗ ${f}\n      ${vi.slice(0, 200)}`);
      }
    }
  }

  // Miễn trừ khai mà file ĐÃ chạy lại được ⇒ rác, và rác ở đây là cửa mở sẵn.
  // Chỉ kiểm khi chạy TOÀN BỘ: với --file thì phần lớn mục đương nhiên không
  // được chạm tới, báo chúng là thừa sẽ là lời buộc tội sai.
  // Chỉ kết luận "miễn trừ thừa" khi lượt này THẬT SỰ đo hết mọi file. Khi sổ đã
  // bỏ qua phần lớn, một mục miễn trừ không được chạm tới KHÔNG chứng minh nó thừa —
  // buộc tội trong trường hợp đó là đúng lớp lỗi mà chính file này cảnh báo ở trên.
  const doHet = quetToanBo && dsChay.length === files.length;
  const thua = doHet
    ? [...mienTru.keys()].filter((f) => !daKhop.has(f))
    : [];

  if (hong.length > 0 || thua.length > 0) {
    if (hong.length > 0) {
      console.error(`\n❌ ${hong.length}/${files.length} migration KHÔNG chạy lại được lần hai:`);
      for (const h of hong) console.error(`   - ${h.f}: ${h.vi.slice(0, 160)}`);
      console.error("\n  Re-apply xảy ra khi apply hỏng giữa chừng, khi dựng lại môi trường từ baseline");
      console.error("  + forward lane, và khi hợp thức hoá một thay đổi đã đi đường tắt — cả ba đều là");
      console.error("  lúc người ta đang vội. Thêm IF NOT EXISTS / OR REPLACE / ON CONFLICT cho đúng chỗ.");
    }
    for (const f of thua) {
      console.error(
        `\n❌ Miễn trừ idempotent khai cho ${f} nhưng file đó ĐÃ chạy lại được.\n` +
        `   Gỡ mục đó khỏi migration-policy.json — miễn trừ thừa là cửa mở sẵn cho lần sau.`,
      );
    }
    process.exit(1);
  }

  if (daKhop.size > 0) {
    console.log(`\n   ${daKhop.size} file miễn trừ CÓ TÊN (xem idempotencyExceptions trong migration-policy.json):`);
    for (const f of daKhop) console.log(`     ~ ${f} — ${mienTru.get(f).lop}`);
  }

  // ── Ghi sổ ──────────────────────────────────────────────────────────────
  // Chỉ ghi khi được yêu cầu tường minh. CI KHÔNG ghi sổ: một cổng tự cấp
  // chứng nhận cho chính nó là cổng không còn canh gì. Sổ đi kèm commit của
  // người viết migration, cùng đường với `npm run provenance:generate`.
  if (ghiSo) {
    const cu = boQuaSo ? {} : docSo();
    const moiSo = {};
    for (const f of files) {
      const da = chungMoi.find(([ten]) => ten === f);
      if (da) moiSo[f] = { sha256: digest.get(f), ketQua: da[1] };
      else if (cu[f]?.sha256 === digest.get(f)) moiSo[f] = cu[f];
    }
    const noiDung = {
      $comment:
        "Sổ chứng nhận idempotent theo sha256. Sinh bằng: node scripts/check-forward-migration-idempotent.mjs --ghi-so. " +
        "Mỗi mục nói: nội dung file này (theo digest) ĐÃ được chứng minh chạy lại được lần hai. " +
        "File sau cutoff là bất biến theo migration-policy.json, nên chứng nhận còn giá trị tới khi nội dung đổi. " +
        "Sửa một byte là digest đổi và file bị đo lại — không có đường lách.",
      schemaVersion: 1,
      entries: Object.fromEntries(Object.keys(moiSo).sort().map((k) => [k, moiSo[k]])),
    };
    writeFileSync(SO, `${JSON.stringify(noiDung, null, 2)}
`, "utf8");
    console.log(`
✍ Đã ghi tooling/idempotent-verified.json — ${Object.keys(moiSo).length} mục.`);
  }

  const doThucTe = dsChay.length;
  console.log(`
✅ ${doThucTe}/${doThucTe} migration đo lần này chạy lại được lần hai mà không hỏng.`);
  if (daChung.length > 0) {
    console.log(`   ${daChung.length} file bỏ qua vì sha256 khớp sổ chứng nhận (nội dung không đổi từ lần đo đạt).`);
  }
  if (!doHet) {
    console.log("   CHƯA ĐO LẦN NÀY: các mục miễn trừ không bị chạm tới nên không kết luận được chúng còn cần thiết hay đã thừa.");
  }
  console.log("   CHƯA PHỦ: ghi đè im lặng (INSERT thiếu ON CONFLICT chèn hai dòng, không ném lỗi).");
  console.log("   Phủ nốt cần database dùng-một-lần để so trạng thái từng lượt.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`❌ Lỗi không lường trước: ${e.message}`);
    process.exit(3);
  });
}
