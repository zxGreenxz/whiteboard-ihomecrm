#!/usr/bin/env node
// Gate: con số trong tài liệu phải khớp thực tế đếm được.
//
// VÌ SAO CẦN
//   Tài liệu chép tay con số thì con số sẽ trôi, và không gì báo. Repo này có án
//   lệ đủ để không phải tranh luận:
//     - "371 migration" lặp ở 3 file trong khi thực tế đã 625 — lệch 254 file,
//       CI vẫn xanh suốt.
//     - Sau khi sửa thành 625 thì hai tuần sau thực tế là 627. Trôi tiếp.
//     - AGENTS.md ghi ratchet TypeScript "hiện 30" trong khi số thật là 26.
//   Trớ trêu nhất: chính dòng ghi "625 file" cũng ghi kèm "số đếm sinh bằng
//   script, đừng chép tay" — lời dặn đúng, đặt ngay cạnh con số chép tay.
//
//   Con số sai trong tài liệu không làm test nào đỏ, không làm build nào hỏng.
//   Nó chỉ làm người đọc tin sai — và với tài liệu kiến trúc thì đó là toàn bộ
//   công dụng của nó.
//
//   node scripts/check-doc-counts.mjs
//   node scripts/check-doc-counts.mjs --fix   # ghi lại số đúng vào tài liệu
//
// Không cần credential, không đọc database.

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Đếm file .sql, ĐỆ QUY xuống thư mục con.
 *
 * Bản đầu tôi viết chỉ đếm file ngay trong thư mục, và nó lập tức báo
 * "migrations-archive ghi 15, thực tế 1" — trong khi tài liệu ĐÚNG: 1 file ở gốc
 * + 14 file trong `migrations-bundle/`. Chạy `--fix` lúc đó sẽ sửa một con số
 * đúng thành sai. Với một gate lấy tài liệu làm đích sửa, đếm sai còn tệ hơn
 * không đếm.
 */
const demSql = (dir) => {
  const p = join(repoRoot, dir);
  if (!existsSync(p)) return 0;
  let n = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    if (e.isDirectory()) n += demSql(join(dir, e.name));
    else if (e.name.endsWith(".sql")) n += 1;
  }
  return n;
};

/**
 * Mỗi mục là một con số tài liệu ĐANG khẳng định, kèm cách đếm ra sự thật.
 *
 * Cố ý khai tường minh từng chỗ thay vì dò mọi con số trong docs: dò mù sẽ đầy
 * báo động giả (số phiên bản, số tiền, số dòng code trích dẫn), và một gate hay
 * báo sai sẽ bị tắt.
 */
export const CLAIMS = [
  {
    file: "supabase/README.md",
    // "… — 625 file hiện có gồm 33 nhóm trùng version …"
    re: /(\b)(\d{3,4})( file hiện có)/,
    dem: () => demSql("supabase/migrations"),
    moTa: "số file trong supabase/migrations",
  },
  {
    file: "docs/DATABASE_SCHEMA.md",
    // "Repository hiện có 625 file trong …"
    re: /(hiện có\s+)(\d{3,4})(\s+file)/,
    dem: () => demSql("supabase/migrations"),
    moTa: "số file trong supabase/migrations",
  },
  {
    file: "docs/CODEBASE_STRUCTURE.md",
    // "(625 file + 15 trong `migrations-archive/`)"
    re: /(\()(\d{3,4})( file \+ )/,
    dem: () => demSql("supabase/migrations"),
    moTa: "số file trong supabase/migrations",
  },
  {
    file: "docs/CODEBASE_STRUCTURE.md",
    re: /( file \+ )(\d{1,3})( trong)/,
    dem: () => demSql("supabase/migrations-archive"),
    moTa: "số file trong supabase/migrations-archive",
  },
];

export function kiemTra(doc, claim) {
  const m = claim.re.exec(doc);
  if (!m) return { trangThai: "khong-tim-thay" };
  const khai = Number(m[2]);
  const that = claim.dem();
  return { trangThai: khai === that ? "khop" : "lech", khai, that, match: m };
}

function main(argv) {
  const fix = argv.includes("--fix");
  const lech = [];
  const mat = [];
  let daSua = 0;

  for (const claim of CLAIMS) {
    const path = join(repoRoot, claim.file);
    if (!existsSync(path)) { mat.push(`${claim.file} (không tồn tại)`); continue; }
    let doc = readFileSync(path, "utf8");
    const r = kiemTra(doc, claim);

    if (r.trangThai === "khong-tim-thay") {
      // Không tìm thấy chỗ khai nghĩa là câu văn đã đổi — gate mất điểm neo và
      // từ đó im lặng mãi mãi. Phải ĐỎ, không được bỏ qua.
      mat.push(`${claim.file}: không còn khớp mẫu cho "${claim.moTa}"`);
      continue;
    }
    if (r.trangThai === "khop") continue;

    if (fix) {
      doc = doc.replace(claim.re, `$1${r.that}$3`);
      writeFileSync(path, doc);
      daSua += 1;
      console.log(`  sửa ${claim.file}: ${claim.moTa} ${r.khai} → ${r.that}`);
    } else {
      lech.push(`${claim.file}: ${claim.moTa} ghi ${r.khai}, thực tế ${r.that}`);
    }
  }

  if (mat.length > 0) {
    console.error(`❌ ${mat.length} chỗ neo bị mất — gate không còn kiểm được:\n`);
    for (const m of mat) console.error(`  - ${m}`);
    console.error("\n  Sửa mẫu regex trong scripts/check-doc-counts.mjs cho khớp câu văn mới.");
    console.error("  ĐỪNG xoá mục đi: mất neo nghĩa là con số đó quay lại trạng thái không ai canh.");
    process.exitCode = 1;
    return;
  }

  if (lech.length > 0) {
    console.error(`❌ ${lech.length} con số trong tài liệu đã lệch thực tế:\n`);
    for (const l of lech) console.error(`  - ${l}`);
    console.error("\n  Chạy: node scripts/check-doc-counts.mjs --fix");
    process.exitCode = 1;
    return;
  }

  if (fix && daSua > 0) {
    console.log(`\n✅ Đã cập nhật ${daSua} con số.`);
    return;
  }
  console.log(`✅ ${CLAIMS.length} con số trong tài liệu khớp thực tế đếm được.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv);
}
