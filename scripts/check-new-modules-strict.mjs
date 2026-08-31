#!/usr/bin/env node
// Gate: module MỚI phải strict ngay từ đầu (plan P1.4).
//
// VÌ SAO TÁCH KHỎI check-strict-islands.mjs
//   Hai invariant khác nhau, và gộp lại sẽ làm hỏng cả hai:
//     - `check-strict-islands` hỏi "các đảo đã khai có còn 0 lỗi không" — thuần
//       tsc, không cần lịch sử git, chạy được ở mọi nơi.
//     - File này hỏi "file .ts/.tsx MỚI có được khai là đảo không" — cần diff với
//       một mốc, nên nó phụ thuộc lịch sử và có thể KHÔNG KIỂM ĐƯỢC (checkout
//       nông, mốc không tồn tại). Nhét phụ thuộc đó vào gate kia sẽ làm gate kia
//       exit 3 ở những nơi nó vốn chạy tốt.
//
// VÌ SAO LUẬT NÀY ĐÁNG CÓ
//   Ratchet đảo strict chỉ đi một chiều, nhưng nó không ngăn NỢ MỚI: mã mới viết
//   lỏng vẫn vào được repo, và mỗi file như vậy là một khoản nợ phải dọn sau —
//   dọn sau bao giờ cũng đắt hơn viết đúng ngay, vì lúc đó đã có người gọi nó.
//   236 đảo hiện tại là kết quả của việc dọn dần; luật này chặn dòng chảy vào.
//
//   node scripts/check-new-modules-strict.mjs                 # so với origin/main
//   node scripts/check-new-modules-strict.mjs --base <ref>
//
// Thoát 0 đạt · 1 vi phạm · 3 KHÔNG KIỂM ĐƯỢC (không có mốc để so).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSCONFIG = join(repoRoot, "tsconfig.strict-islands.json");

/**
 * File KHÔNG bị luật này ràng buộc, mỗi nhóm một lý do cụ thể — không phải danh
 * sách "cho qua cho tiện".
 */
export const MIEN_TRU = [
  { re: /[\\/]__tests__[\\/]/, vi: "thư mục test — kiểu lỏng ở đây là công cụ dựng fixture, không phải nợ kỹ thuật" },
  { re: /\.(test|spec)\.tsx?$/, vi: "file test đặt cạnh mã — cùng lý do với thư mục __tests__" },
  { re: /\.d\.ts$/, vi: "khai báo kiểu, không có thân hàm để strict" },
  { re: /^src\/integrations\/supabase\/types\.ts$/, vi: "sinh tự động từ DB, không sửa tay được" },
];

export function duocMienTru(duong) {
  return MIEN_TRU.some((m) => m.re.test(duong));
}

/** File nguồn của app mà luật này quan tâm. */
export function laModuleApp(duong) {
  return /^src\/.+\.tsx?$/.test(duong) && !duocMienTru(duong);
}

/** Đọc danh sách đảo từ tsconfig (JSONC — bỏ comment trước khi parse). */
export function docDao(noiDung) {
  const sach = noiDung.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const j = JSON.parse(sach);
  return new Set(Array.isArray(j.files) ? j.files : (j.include ?? []));
}

const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

function main() {
  const i = process.argv.indexOf("--base");
  const mocMuon = i >= 0 ? process.argv[i + 1] : null;

  if (!existsSync(TSCONFIG)) {
    console.error("❌ Thiếu tsconfig.strict-islands.json — không biết đảo nào đã khai.");
    process.exit(3);
  }
  if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
    console.error("❌ Repo shallow — không so được với mốc. KHÔNG KIỂM ĐƯỢC (thêm fetch-depth: 0).");
    process.exit(3);
  }

  const co = (r) => {
    try {
      git(["rev-parse", "--verify", r]);
      return true;
    } catch {
      return false;
    }
  };
  const moc = mocMuon ?? (co("origin/main") ? "origin/main" : co("main") ? "main" : null);
  if (!moc || !co(moc)) {
    console.error(`❌ Không phân giải được mốc so sánh${mocMuon ? ` "${mocMuon}"` : " (origin/main | main)"}.`);
    console.error("   KHÔNG KIỂM ĐƯỢC — đừng đọc thành 'không có file mới'.");
    process.exit(3);
  }

  const base = git(["merge-base", moc, "HEAD"]);
  const themMoi = git(["diff", "--name-only", "--diff-filter=A", `${base}..HEAD`])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((x) => x.replace(/\\/g, "/"))
    .filter(laModuleApp);

  const dao = docDao(readFileSync(TSCONFIG, "utf8"));
  const thieu = themMoi.filter((f) => !dao.has(f));

  console.log(`Module mới so với ${moc} (merge-base ${base.slice(0, 8)}): ${themMoi.length} file .ts/.tsx trong src/`);
  console.log(`Đảo strict đã khai: ${dao.size} file`);

  if (themMoi.length === 0) {
    console.log("\n✅ Không có module app mới trong phạm vi này.");
    return;
  }

  if (thieu.length > 0) {
    console.error(`\n❌ ${thieu.length} module MỚI không nằm trong đảo strict:`);
    for (const f of thieu) console.error(`   ${f}`);
    console.error("\n   Thêm chúng vào `include` của tsconfig.strict-islands.json rồi chạy:");
    console.error("     npx tsc -p tsconfig.strict-islands.json --noEmit");
    console.error("\n   Mã mới viết lỏng là nợ phải dọn sau, mà dọn sau luôn đắt hơn — lúc đó đã có người gọi nó.");
    process.exit(1);
  }

  console.log(`\n✅ Cả ${themMoi.length} module mới đều đã là đảo strict.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
