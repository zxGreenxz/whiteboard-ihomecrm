#!/usr/bin/env node
// Gate: mọi migration `unknown` có CREATE object mà object KHÔNG có trong
// production phải có hồ sơ rà soát kèm trích dẫn — và hồ sơ đó phải còn đúng.
//
// VÌ SAO CẦN
//   Trong 65 file `unknown`, 55 file chỉ ALTER/DML nên không thể chứng minh tự
//   động — đó là giới hạn đã biết, chấp nhận được. 10 file còn lại KHÁC HẲN:
//   chúng CÓ tạo object, và object đó KHÔNG có trong catalog production. Đây
//   không phải "thiếu bằng chứng" mà là bằng chứng NGƯỢC, và nó chỉ có hai cách
//   đọc:
//     (a) file đã chạy, object bị migration SAU thay thế/đổi tên;
//     (b) file CHƯA TỪNG CHẠY — production đang thiếu thứ repo tưởng đã có.
//   Khoảng cách giữa (a) và (b) là khoảng cách giữa "không sao cả" và "một tính
//   năng đang hỏng ngoài production mà không ai biết".
//
//   Rà soát 06/08/2026 kết luận cả 10 đều là (a), mỗi file kèm migration cụ thể
//   đã DROP object. Hồ sơ ở supabase/migration-unknown-review.json.
//
//   Nhưng một hồ sơ không ai canh sẽ mục: file migration bị sửa, object mới rơi
//   khỏi catalog, hoặc file `unknown` mới xuất hiện — hồ sơ vẫn nằm im trông
//   như còn đúng. Gate này gắn hồ sơ vào SỰ THẬT ĐO ĐƯỢC (sha256 + danh sách
//   object thiếu trong manifest), nên nó chỉ xanh khi vẫn còn mô tả đúng repo.
//
//   node scripts/check-unknown-review.mjs
//   node scripts/check-unknown-review.mjs --list
//
// Không cần credential, không đọc database (chỉ đọc 2 artifact JSON).

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(repoRoot, "supabase", "migration-provenance.json");
const REVIEW = join(repoRoot, "supabase", "migration-unknown-review.json");

/**
 * Tiền tố `<loại>:` là dạng bộ sinh ghi ra cho object thật (`policy:public.x.y`,
 * `function:public.f`). File chỉ-ALTER thay vào đó nhận một câu tiếng Việt giải
 * thích. Phân biệt bằng TIỀN TỐ chứ không bằng nội dung câu: câu chữ đã đổi một
 * lần rồi, và lúc đó phép đo âm thầm sai chứ không đỏ.
 */
export const CO_LOAI = /^(policy|function|index|trigger|table|view):/;

export function locCanRaSoat(manifest) {
  return manifest.entries
    .filter((e) => e.state === "unknown")
    .filter((e) => (e.missingObjects ?? []).some((x) => CO_LOAI.test(x)))
    .map((e) => ({
      path: e.path,
      sha256: e.sha256,
      missingObjects: (e.missingObjects ?? []).filter((x) => CO_LOAI.test(x)),
    }));
}

/**
 * So hồ sơ với sự thật. Trả về danh sách vấn đề, rỗng nghĩa là khớp.
 *
 * Bốn kiểu hỏng được tách riêng vì cách xử khác nhau: thiếu hồ sơ thì phải điều
 * tra, sha lệch thì phải rà lại vì file đã đổi, object lệch thì kết luận cũ có
 * thể không còn phủ hết, còn trích dẫn rỗng thì hồ sơ vốn đã vô giá trị từ đầu.
 */
export function doiChieu(canRaSoat, hoSo) {
  const vanDe = [];
  const daGhi = new Set(Object.keys(hoSo.files ?? {}));

  for (const f of canRaSoat) {
    const h = (hoSo.files ?? {})[f.path];
    if (!h) {
      vanDe.push({ loai: "thieu-ho-so", path: f.path, chiTiet: f.missingObjects.join(", ") });
      continue;
    }
    if (h.sha256 !== f.sha256) {
      vanDe.push({
        loai: "sha-lech",
        path: f.path,
        chiTiet: `hồ sơ rà file ${String(h.sha256).slice(0, 12)}…, manifest hiện là ${String(f.sha256).slice(0, 12)}…`,
      });
    }
    const a = [...(h.missingObjects ?? [])].sort().join("|");
    const b = [...f.missingObjects].sort().join("|");
    if (a !== b) {
      vanDe.push({ loai: "object-lech", path: f.path, chiTiet: `hồ sơ ghi ${h.missingObjects?.length ?? 0} object, manifest hiện có ${f.missingObjects.length}` });
    }
    const bc = h.bangChung ?? [];
    if (bc.length === 0 || bc.some((x) => !x.duong_dan || !x.trich_doan)) {
      vanDe.push({ loai: "bang-chung-rong", path: f.path, chiTiet: `${bc.length} mục, có mục thiếu đường dẫn hoặc trích đoạn` });
    }
    daGhi.delete(f.path);
  }

  for (const thua of daGhi) {
    // Không phải lỗi chặn: file đã được chứng minh hoặc đã xoá thì hồ sơ thành
    // thừa. Nhưng phải NÓI RA, vì hồ sơ thừa là hồ sơ mô tả một repo không còn.
    vanDe.push({ loai: "ho-so-thua", path: thua, chiTiet: "không còn là unknown-có-CREATE", canhBaoThoi: true });
  }
  return vanDe;
}

function main(argv) {
  if (!existsSync(MANIFEST)) {
    console.error("❌ Chưa có supabase/migration-provenance.json — chạy scripts/generate-migration-provenance.mjs --write");
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

  // Chống rỗng-vô-nghĩa: nếu KHÔNG entry nào trong toàn manifest có tiền tố
  // `<loại>:`, nghĩa là định dạng missingObjects đã đổi và bộ lọc trên đang trả
  // rỗng — gate sẽ xanh mà không kiểm gì. Đây đúng là kiểu hỏng đã cắn repo này
  // trước đây (một bộ lọc lệch làm cả cửa chặn im lặng), nên nó phải đỏ.
  const tongCoLoai = manifest.entries.reduce(
    (n, e) => n + (e.missingObjects ?? []).filter((x) => CO_LOAI.test(x)).length,
    0,
  );
  if (tongCoLoai === 0) {
    console.error("❌ Không tìm thấy missingObjects nào có tiền tố `<loại>:` trong toàn manifest.");
    console.error("   Định dạng do generate-migration-provenance.mjs sinh ra đã đổi, và bộ lọc của");
    console.error("   gate này đang trả rỗng — tức nó sẽ XANH mà không kiểm gì. Sửa CO_LOAI cho khớp.");
    process.exitCode = 1;
    return;
  }

  const canRaSoat = locCanRaSoat(manifest);

  if (!existsSync(REVIEW)) {
    console.error(`❌ Chưa có supabase/migration-unknown-review.json trong khi có ${canRaSoat.length} file cần rà soát.`);
    process.exitCode = 1;
    return;
  }
  const hoSo = JSON.parse(readFileSync(REVIEW, "utf8"));

  if (argv.includes("--list")) {
    for (const f of canRaSoat) {
      const h = (hoSo.files ?? {})[f.path];
      console.log(`\n${f.path.replace("supabase/migrations/", "")}  → ${h?.ketLuan ?? "(CHƯA RÀ)"}`);
      for (const o of f.missingObjects) console.log(`   thiếu: ${o}`);
      for (const b of h?.bangChung ?? []) console.log(`   bằng chứng: ${b.duong_dan}`);
    }
    console.log("");
  }

  const vanDe = doiChieu(canRaSoat, hoSo);
  const chan = vanDe.filter((v) => !v.canhBaoThoi);
  const canhBao = vanDe.filter((v) => v.canhBaoThoi);

  for (const c of canhBao) {
    console.log(`⚠ hồ sơ thừa: ${c.path.replace("supabase/migrations/", "")} — ${c.chiTiet}`);
  }

  if (chan.length > 0) {
    console.error(`\n❌ ${chan.length} vấn đề với hồ sơ rà soát unknown:\n`);
    for (const v of chan) {
      console.error(`  [${v.loai}] ${v.path.replace("supabase/migrations/", "")}`);
      console.error(`     ${v.chiTiet}`);
    }
    console.error("\n  File `unknown` có CREATE object mà object không có trong production nghĩa là");
    console.error("  MỘT TRONG HAI: object bị migration sau thay thế (không sao), hoặc file chưa từng");
    console.error("  chạy (một tính năng đang thiếu ngoài production). Phải điều tra và ghi vào");
    console.error("  supabase/migration-unknown-review.json kèm trích dẫn migration đã DROP object.");
    process.exitCode = 1;
    return;
  }

  console.log(
    `✅ Hồ sơ rà soát unknown khớp: ${canRaSoat.length} file có CREATE-nhưng-object-thiếu, tất cả đều có kết luận kèm trích dẫn.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv);
}
