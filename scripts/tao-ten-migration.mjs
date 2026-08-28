#!/usr/bin/env node
// Cấp tên migration — timestamp UTC đến GIÂY THẬT, kiểm trùng xuyên worktree.
//
//   node scripts/tao-ten-migration.mjs <slug_snake_case>
//   → in ra: 20260828100203_<slug>.sql
//
// VÌ SAO TỒN TẠI (28/08/2026)
//   Cả HAI cặp miễn trừ trùng-version trong supabase/migration-policy.json đều
//   sinh từ cùng một kịch bản: hai luồng làm việc song song cùng chọn tay một
//   mốc giờ TRÒN kiểu `…120000`. Trùng version sau cutoff là thứ chặn
//   `db push`, làm check-migration-provenance đỏ, và mỗi lần xảy ra lại phải
//   khai thêm một miễn trừ vĩnh viễn. Contract §3 vì thế bắt cấp tên bằng
//   script này thay vì chọn tay.
//
// CÁCH CHỐNG TRÙNG
//   1. Giây thật của đồng hồ — hai phiên phải chạy trong CÙNG MỘT GIÂY mới đụng.
//   2. Kiểm version với ba nguồn rồi +1 giây tới khi thoát:
//      (a) index của worktree hiện tại (git ls-files),
//      (b) đĩa của worktree hiện tại (file chưa add),
//      (c) supabase/migrations của MỌI worktree khác (git worktree list) —
//          đây là chỗ DUY NHẤT trong bộ gate nhìn xuyên worktree, và nó chính
//          đáng: mục đích của nó đúng là chống các phiên đụng nhau.
//
// Không cần credential, không mạng. Thoát 0 · 1 (slug sai).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const SLUG = /^[a-z0-9_]+$/;

const dinhDang = (d) =>
  [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
    String(d.getUTCHours()).padStart(2, "0"),
    String(d.getUTCMinutes()).padStart(2, "0"),
    String(d.getUTCSeconds()).padStart(2, "0"),
  ].join("");

/**
 * Sinh tên file từ mốc giờ + hàm kiểm trùng. Thuần để test không đụng git/đĩa.
 * @param {string} slug  snake_case ascii
 * @param {Date} bayGio
 * @param {(version: string) => boolean} biTrung
 */
export function sinhTen(slug, bayGio, biTrung) {
  if (!SLUG.test(slug)) {
    throw new Error(
      `Slug "${slug}" không hợp lệ — dùng snake_case ascii (a-z, 0-9, _), ví dụ: them_bang_khach_hang`,
    );
  }
  const d = new Date(bayGio.getTime());
  while (biTrung(dinhDang(d))) d.setUTCSeconds(d.getUTCSeconds() + 1);
  return `${dinhDang(d)}_${slug}.sql`;
}

/** Tập version 14 chữ số đang tồn tại ở cả ba nguồn (index · đĩa · worktree khác). */
export function thuThapVersion() {
  const ra = new Set();
  const nhat = (ten) => {
    const v = /^(\d{14})_/.exec(ten)?.[1];
    if (v) ra.add(v);
  };
  const goiGit = (args) =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);

  // (a) index + (b) đĩa của worktree hiện tại
  for (const p of goiGit(["ls-files", "--cached", "--others", "--exclude-standard", "--", "supabase/migrations"])) {
    nhat(p.replace(/\\/g, "/").split("/").pop());
  }
  // (c) các worktree khác trên máy
  const dongWt = goiGit(["worktree", "list", "--porcelain"]).filter((l) => l.startsWith("worktree "));
  for (const dong of dongWt) {
    const goc = dong.slice("worktree ".length).trim();
    const thuMuc = join(goc, "supabase", "migrations");
    if (!existsSync(thuMuc)) continue;
    try {
      for (const ten of readdirSync(thuMuc)) nhat(ten);
    } catch {
      /* worktree đang bị khoá/xoá dở — bỏ qua, nguồn (a)(b) vẫn che worktree này */
    }
  }
  return ra;
}

function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Dùng: node scripts/tao-ten-migration.mjs <slug_snake_case>");
    console.error("Ví dụ: node scripts/tao-ten-migration.mjs them_bang_khach_hang");
    process.exitCode = 1;
    return;
  }
  let ten;
  try {
    const daCo = thuThapVersion();
    ten = sinhTen(slug, new Date(), (v) => daCo.has(v));
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(ten);
  console.error(`→ supabase/migrations/${ten}`);
  console.error("  (đã kiểm trùng version với index, đĩa và mọi worktree khác trên máy)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
