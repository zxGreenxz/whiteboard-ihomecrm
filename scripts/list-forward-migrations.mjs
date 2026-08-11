#!/usr/bin/env node
// Liệt kê migration SAU cutoff và trạng thái apply của từng file.
//
// TÊN TRONG PLAN KHÁC TÊN THẬT — đọc kỹ trước khi viết script mới
//
//   Plan §51 gọi phần việc này là `scripts/check-forward-migrations.mjs`. KHÔNG có
//   file tên đó, và không nên tạo: chức năng ấy đã nằm trọn ở BỐN script, mỗi cái
//   một câu hỏi khác nhau, tất cả đều đang xanh (đo 11/08/2026):
//
//     list-forward-migrations.mjs        file ↔ sổ ↔ ledger có lệch không, lệch chiều nào
//     check-forward-migration-idempotent chạy lại một migration có an toàn không
//     check-migration-ledger-frozen      ledger có bị sửa ngoài làn forward không
//     check-migration-test-liveness      test ghim định nghĩa lỗi thời có phình ra không
//
//   Viết thêm script thứ năm trùng tên plan chỉ tạo ra nguồn thứ hai cho cùng một
//   câu hỏi — đúng kiểu lệch mà cả file này được lập ra để bắt.
//
// VÌ SAO CẦN (plan file-map)
//   Câu hỏi "còn migration nào chưa apply?" hiện phải trả lời bằng cách mở ba file
//   rồi đối chiếu bằng mắt: supabase/migrations/ trên đĩa, supabase/migration-
//   provenance.json (sổ bằng chứng), và ledger production. Ba nguồn, và chúng CÓ
//   THỂ lệch nhau — lệch theo hai chiều, mỗi chiều một loại nguy hiểm khác hẳn.
//
// HAI CHIỀU LỆCH, VÀ VÌ SAO PHẢI TÁCH RIÊNG
//   (1) CÓ FILE, KHÔNG CÓ SỔ → migration đang chờ apply, hoặc đã apply mà quên ghi
//       sổ. Khó chịu nhưng lùi được: chạy generate-migration-provenance.mjs --write.
//   (2) CÓ SỔ, KHÔNG CÓ FILE → production đã đổi schema theo một file mà repo
//       KHÔNG CÒN mô tả. Không diff được, không audit được, không rollback theo SHA
//       được. Đây KHÔNG phải lỗi sổ sách — đây là repo thôi mô tả đúng production.
//       Đã xảy ra thật: 20260807163000_ie_types_org_boundary.sql có entry trên main
//       nhưng file chỉ tồn tại trên một nhánh chưa merge (commit 9519cd98), trong
//       khi biên nhận trong docs/generated/schema-change-evidence/ xác nhận nó ĐÃ
//       ghi thật vào production.
//
//   ĐỪNG "sửa" (2) bằng generate --write: lệnh đó tái sinh sổ từ đĩa, nên nó sẽ
//   XOÁ entry mồ côi — tức xoá luôn dấu vết rằng production có thứ repo không có.
//   Cách sửa đúng là mang file trở lại repo.
//
//   node scripts/list-forward-migrations.mjs
//   node scripts/list-forward-migrations.mjs --chua-apply   # chỉ in thứ chưa có bằng chứng
//   node scripts/list-forward-migrations.mjs --json
//
// KHÔNG cần credential: đọc sổ đã commit, không gọi database. Muốn số liệu ledger
// tươi thì chạy generate-migration-provenance.mjs trước (lệnh đó mới cần PAT).
// Thoát 0 — đây là lệnh LIỆT KÊ, không phải gate. Cưỡng chế nằm ở
// check-migration-provenance.mjs.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const THU_MUC = join(repoRoot, "supabase", "migrations");
const SO = join(repoRoot, "supabase", "migration-provenance.json");
const CHINH_SACH = join(repoRoot, "supabase", "migration-policy.json");

/** Trạng thái có bằng chứng máy — theo migration-policy.json → states. */
export const CO_BANG_CHUNG = new Set(["ledger-applied", "catalog-proven"]);

/**
 * Ghép ba nguồn thành một bảng.
 * Trả { cutoff, dong: [{version, ten, tren Dia, trongSo, state, ketLuan}] }.
 */
export function ghepBaNguon({ fileTrenDia, entries, cutoff }) {
  const soTheoTen = new Map();
  for (const e of entries) soTheoTen.set(String(e.path).split("/").pop(), e);

  const sauCutoff = (v) => /^\d{14}$/.test(v) && v > cutoff;
  const dong = [];
  const daXet = new Set();

  for (const ten of fileTrenDia) {
    const m = ten.match(/^(\d{14})_(.+)\.sql$/);
    if (!m || !sauCutoff(m[1])) continue;
    daXet.add(ten);
    const e = soTheoTen.get(ten);
    dong.push({
      version: m[1],
      ten,
      trenDia: true,
      trongSo: Boolean(e),
      state: e?.state ?? null,
      ketLuan: !e ? "THIEU_SO" : CO_BANG_CHUNG.has(e.state) ? "DA_APPLY" : "CHUA_CHUNG_MINH",
    });
  }

  // Chiều ngược: có sổ mà không có file. Quét TOÀN BỘ entry sau cutoff, kể cả
  // entry mà vòng trên không chạm tới — đó chính là loại nguy hiểm nhất.
  for (const [ten, e] of soTheoTen) {
    const m = ten.match(/^(\d{14})_/);
    if (!m || !sauCutoff(m[1]) || daXet.has(ten)) continue;
    dong.push({
      version: m[1],
      ten,
      trenDia: false,
      trongSo: true,
      state: e.state,
      ketLuan: "SO_MO_COI",
    });
  }

  dong.sort((a, b) => a.version.localeCompare(b.version));
  return dong;
}

export const NHAN = {
  DA_APPLY: "đã apply (có bằng chứng)",
  CHUA_CHUNG_MINH: "có sổ nhưng CHƯA chứng minh được",
  THIEU_SO: "trên đĩa, CHƯA có entry sổ",
  SO_MO_COI: "CÓ SỔ NHƯNG KHÔNG CÓ FILE",
};

function main() {
  const chiChuaApply = process.argv.includes("--chua-apply");
  const raJson = process.argv.includes("--json");

  for (const p of [SO, CHINH_SACH]) {
    if (!existsSync(p)) {
      console.error(`❌ Thiếu ${p.replace(repoRoot, ".")} — không đọc được sổ.`);
      process.exit(3);
    }
  }
  const so = JSON.parse(readFileSync(SO, "utf8"));
  const cs = JSON.parse(readFileSync(CHINH_SACH, "utf8"));
  const cutoff = cs.provisionalCutoff?.version;
  if (!cutoff) {
    console.error("❌ migration-policy.json không có provisionalCutoff.version.");
    process.exit(3);
  }

  const dong = ghepBaNguon({
    fileTrenDia: readdirSync(THU_MUC).filter((f) => f.endsWith(".sql")),
    entries: so.entries ?? [],
    cutoff,
  });

  const loc = chiChuaApply ? dong.filter((d) => d.ketLuan !== "DA_APPLY") : dong;

  if (raJson) {
    console.log(JSON.stringify({ cutoff, soSinhLuc: so.generatedAt, ledgerMaxVersion: so.ledgerMaxVersion, dong: loc }, null, 2));
    return;
  }

  console.log(`Migration sau cutoff ${cutoff} — ${dong.length} file`);
  console.log(`Sổ sinh lúc ${so.generatedAt} · ledger tới ${so.ledgerMaxVersion}\n`);

  if (loc.length === 0) {
    console.log("  (không có mục nào khớp bộ lọc)");
  }
  for (const d of loc) {
    const dau = d.ketLuan === "DA_APPLY" ? "✔" : d.ketLuan === "SO_MO_COI" ? "‼" : "•";
    console.log(`  ${dau} ${d.version}  ${NHAN[d.ketLuan].padEnd(34)} ${d.ten}`);
  }

  const moCoi = dong.filter((d) => d.ketLuan === "SO_MO_COI");
  const thieuSo = dong.filter((d) => d.ketLuan === "THIEU_SO");

  if (thieuSo.length) {
    console.log(`\n${thieuSo.length} file chưa có entry sổ → chạy:`);
    console.log("   node scripts/generate-migration-provenance.mjs --write");
  }
  if (moCoi.length) {
    console.log(`\n‼ ${moCoi.length} entry CÓ SỔ NHƯNG KHÔNG CÓ FILE.`);
    console.log("   Nghĩa là production đã đổi schema theo một file repo KHÔNG CÒN mô tả:");
    console.log("   không diff được, không audit được, không rollback theo SHA được.");
    console.log("   ĐỪNG chạy `generate-migration-provenance.mjs --write` để cho hết đỏ —");
    console.log("   lệnh đó tái sinh sổ từ đĩa nên sẽ XOÁ entry này, tức xoá luôn dấu vết.");
    console.log("   Cách sửa đúng: mang file trở lại repo (tìm bằng `git log --all --diff-filter=A -- <path>`).");
  }

  console.log("\nCHƯA KIỂM: trạng thái ledger THẬT trên production lúc này — số liệu ở đây");
  console.log("lấy từ sổ đã commit. Muốn tươi thì chạy generate-migration-provenance.mjs (cần PAT).");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
