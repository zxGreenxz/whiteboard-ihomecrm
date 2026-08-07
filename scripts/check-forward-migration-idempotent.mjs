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

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTransaction } from "./apply-reviewed-migration.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(repoRoot, "supabase", "migrations");

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

export function docCutoff() {
  const p = JSON.parse(readFileSync(join(repoRoot, "supabase", "migration-policy.json"), "utf8"));
  return String(p.provisionalCutoff?.version ?? p.cutoff ?? "");
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
  const files =
    i >= 0 && process.argv[i + 1]
      ? [process.argv[i + 1].split(/[\\/]/).pop()]
      : timFileSauCutoff(readdirSync(DIR), cutoff);

  if (files.length < TOI_THIEU_FILE) {
    console.error(`❌ Không có file nào sau cutoff ${cutoff} — "0 lỗi" là câu đúng mà vô nghĩa.`);
    process.exit(3);
  }

  console.log(`Idempotency: ${files.length} migration sau cutoff ${cutoff} · mỗi file chạy HAI LẦN rồi ROLLBACK\n`);

  const hong = [];
  for (const f of files) {
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
    } else {
      // Lấy đúng câu lỗi Postgres, bỏ phần bao JSON — người đọc cần biết CÂU NÀO hỏng.
      let vi = kq.text.slice(0, 300);
      try {
        vi = JSON.parse(kq.text).message ?? vi;
      } catch {
        /* giữ nguyên text thô nếu không phải JSON */
      }
      hong.push({ f, vi });
      console.log(`  ✗ ${f}\n      ${vi.slice(0, 200)}`);
    }
  }

  if (hong.length > 0) {
    console.error(`\n❌ ${hong.length}/${files.length} migration KHÔNG chạy lại được lần hai:`);
    for (const h of hong) console.error(`   - ${h.f}: ${h.vi.slice(0, 160)}`);
    console.error("\n  Re-apply xảy ra khi apply hỏng giữa chừng, khi dựng lại môi trường từ baseline");
    console.error("  + forward lane, và khi hợp thức hoá một thay đổi đã đi đường tắt — cả ba đều là");
    console.error("  lúc người ta đang vội. Thêm IF NOT EXISTS / OR REPLACE / ON CONFLICT cho đúng chỗ.");
    process.exit(1);
  }

  console.log(`\n✅ ${files.length}/${files.length} migration chạy lại được lần hai mà không hỏng.`);
  console.log("   CHƯA PHỦ: ghi đè im lặng (INSERT thiếu ON CONFLICT chèn hai dòng, không ném lỗi).");
  console.log("   Phủ nốt cần database dùng-một-lần để so trạng thái từng lượt.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`❌ Lỗi không lường trước: ${e.message}`);
    process.exit(3);
  });
}
