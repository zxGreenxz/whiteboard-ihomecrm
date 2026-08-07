#!/usr/bin/env node
// Ratchet chống NUỐT LỖI — plan §9: "Wrapper không được biến lỗi thành [], {}
// hoặc toast chung."
//
// SỐ ĐO, VÀ MỘT LẦN TỰ ĐÍNH CHÍNH
//   Phép đo đầu ngày 07/08/2026 ra 147 chỗ (34 ở vùng tiền) — nhưng phép đo đó
//   XOÁ COMMENT trước khi khớp, nên `catch { /* lý do */ }` biến thành `catch {}`
//   và bị đếm là nuốt lỗi. Sau khi thay comment bằng ký tự đặc thay vì xoá:
//   39 chỗ, 8 ở vùng tiền. Nghĩa là 108 chỗ trong con số cũ vốn ĐÃ có ghi chú
//   giải thích — chúng là quyết định có chủ ý, không phải nợ.
//
//   Ghi cả hai con số ở đây vì bài học đắt hơn con số: một phép đo sai theo hướng
//   BI QUAN cũng nguy hiểm như sai theo hướng lạc quan. Nó tạo ra 108 việc không
//   có thật, và một danh sách như vậy sẽ bị bỏ qua trọn gói — kéo theo cả 39 chỗ
//   thật.
//
// VÌ SAO KHÔNG SỬA HẾT MỘT LƯỢT
//   39 chỗ còn lại phần lớn nằm ở đường vốn được thiết kế để im (đọc
//   localStorage, prefetch tuỳ chọn, đo hiệu năng) nhưng chưa ai ghi lý do. Sửa
//   mù sẽ tạo ra lỗi mới ném ra từ đúng những đường đó. Thứ rẻ mà hiệu quả là
//   CHẶN NÓ TĂNG, và ép chỗ mới phải hoặc xử lỗi tử tế, hoặc ghi lý do được im.
//
// VÌ SAO RATCHET LÀ TẬP FINGERPRINT, KHÔNG PHẢI SỐ ĐẾM
//   Với số đếm, xoá một chỗ ở màn cài đặt rồi thêm một chỗ ở màn thu tiền là
//   hoà. Repo này đã có đúng án lệ đó ở ratchet any-cast.
//
// VÌ SAO VÙNG TIỀN CÓ TRẦN RIÊNG
//   Ở màn cài đặt, một lỗi bị nuốt làm mất một tuỳ chọn. Ở màn thu tiền, nó làm
//   "không có quyền xem" hiển thị y hệt "không có phiếu nào" — và người đối
//   chiếu quỹ đọc ra một con số thiếu mà không có gì báo là thiếu.
//
//   node scripts/check-error-swallow-ratchet.mjs
//   node scripts/check-error-swallow-ratchet.mjs --write   # chỉ khi GIẢM
//
// Không cần credential. Thoát 0 đạt · 1 vi phạm · 3 không kiểm được.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join("tooling", "error-swallow-baseline.json");

/** Sàn chống rỗng: bộ dò hỏng thì mọi tập rỗng và gate in dấu tick. */
export const TOI_THIEU_FILE_QUET = 500;

export const MAU = [
  ["catch-rong", /catch\s*(\([^)]*\))?\s*\{\s*\}/g],
  ["catch-tra-rong", /catch\s*(\([^)]*\))?\s*\{[^{}]{0,120}return\s*(\[\s*\]|\{\s*\}|null|undefined)\s*;?[^{}]{0,40}\}/g],
  ["catch-arrow-rong", /\.catch\s*\(\s*\(\s*\)\s*=>\s*(\{\s*\}|\[\s*\]|null|undefined|void 0)\s*\)/g],
  ["if-error-return-rong", /if\s*\(\s*error\s*\)\s*return\s*(\[\s*\]|\{\s*\}|null)\s*;/g],
];

/**
 * File chạm tiền — nơi một lỗi bị nuốt đổi thành một con số sai.
 *
 * Bản đầu thiếu `credit|deposit|refund|handover|quy`, nên `customerCreditRpc.ts`
 * — đường ghi TÍN DỤNG KHÁCH HÀNG — bị xếp là "bình thường". Đột biến phát hiện
 * ra vì nó chọn đúng file đó làm nạn nhân. Danh sách theo từ khoá luôn có nguy cơ
 * này; nó chỉ dùng để XẾP MỨC ƯU TIÊN trong thông báo, không quyết định đỏ/xanh,
 * nên bỏ sót làm giảm độ rõ chứ không mở cửa cho vi phạm.
 */
export const LA_VUNG_TIEN = (f) =>
  /invoice|income-expense|payment|cashbook|salary|finance|thu-tien|thanh-toan|voucher|commission|contract|credit|deposit|refund|handover|quy-|tien/i.test(
    f,
  );

/**
 * Fingerprint = file#mẫu#thứ-tự. Không dùng số dòng: thêm một dòng ở đầu file sẽ
 * đổi mọi fingerprint bên dưới và biến một commit vô hại thành đỏ toàn bộ.
 *
 * COMMENT ĐƯỢC THAY BẰNG KÝ TỰ ĐẶC, KHÔNG BỊ XOÁ TRẮNG.
 *   Bản đầu xoá comment rồi mới khớp, nên một khối catch có comment giải thích
 *   bên trong lại biến thành
 *   `catch {  }` và VẪN bị tính — tức đúng đường thoát mà chính gate này chỉ dẫn
 *   lại không dùng được. Thay bằng ký tự đặc thì hai việc cùng đúng: comment giải
 *   thích làm khối không còn rỗng, còn một dòng code bị comment-out (`// catch {}`)
 *   cũng không bị đếm nhầm thành vi phạm.
 */
export function domFile(noiDung, duongDan) {
  const dac = (m) => "§".repeat(Math.max(m.length, 1));
  const sach = noiDung.replace(/\/\*[\s\S]*?\*\//g, dac).replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, p1) => p1 + dac(m));
  const ra = [];
  for (const [ten, re] of MAU) {
    const n = [...sach.matchAll(re)].length;
    for (let i = 0; i < n; i++) ra.push(`${duongDan}#${ten}#${i}`);
  }
  return ra;
}

export function timThemMoi(baseline, hienTai) {
  const cu = new Set(baseline);
  return hienTai.filter((f) => !cu.has(f)).sort();
}

function main() {
  const viet = process.argv.includes("--write");
  let files;
  try {
    files = execFileSync("git", ["ls-files", "src/**/*.ts", "src/**/*.tsx"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1e8,
    })
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((f) => !/__tests__|\.test\.tsx?$/.test(f));
  } catch (e) {
    console.error(`❌ Không liệt kê được file: ${e.message}`);
    process.exit(3);
  }
  if (files.length < TOI_THIEU_FILE_QUET) {
    console.error(`❌ Chỉ quét được ${files.length} file (sàn ${TOI_THIEU_FILE_QUET}) — phép đo hỏng.`);
    process.exit(3);
  }

  const hienTai = [];
  for (const f of files) {
    let s;
    try {
      s = readFileSync(join(repoRoot, f), "utf8");
    } catch {
      continue;
    }
    hienTai.push(...domFile(s, f.replace(/\\/g, "/")));
  }

  let baseline = [];
  const bPath = join(repoRoot, BASELINE);
  if (existsSync(bPath)) {
    try {
      baseline = JSON.parse(readFileSync(bPath, "utf8")).sites ?? [];
    } catch (e) {
      console.error(`❌ Không đọc được ${BASELINE}: ${e.message}`);
      process.exit(3);
    }
  }

  const themMoi = timThemMoi(baseline, hienTai);
  const daBo = baseline.filter((f) => !hienTai.includes(f));
  const tienHienTai = hienTai.filter((f) => LA_VUNG_TIEN(f)).length;
  const tienBaseline = baseline.filter((f) => LA_VUNG_TIEN(f)).length;

  console.log(
    `Nuốt lỗi: ${hienTai.length} chỗ trên ${files.length} file (vùng tiền ${tienHienTai}) · ` +
      `baseline ${baseline.length} (tiền ${tienBaseline})`,
  );

  if (viet) {
    // Lần chốt ĐẦU TIÊN là phép đo LẬP MỐC — chưa có gì để so, nên mọi chỗ đều
    // "mới" theo nghĩa kỹ thuật. Bản đầu của gate này chặn luôn cả lần đó, tức
    // không bao giờ dựng được mốc. Từ lần thứ hai trở đi ratchet mới có nghĩa.
    const laLanDau = !existsSync(bPath);
    if (!laLanDau && themMoi.length > 0) {
      console.error(`❌ Không chốt baseline khi có ${themMoi.length} chỗ MỚI. Ratchet chỉ đi xuống.`);
      for (const f of themMoi.slice(0, 10)) console.error(`   + ${f}`);
      process.exit(1);
    }
    writeFileSync(
      bPath,
      JSON.stringify(
        {
          $comment:
            "Ratchet chống nuốt lỗi (plan §9). TẬP FINGERPRINT chứ không phải số đếm — với số đếm thì xoá một chỗ ở màn cài đặt rồi thêm một chỗ ở màn thu tiền là hoà, và repo đã có đúng án lệ đó ở ratchet any-cast. Fingerprint là file#mẫu#thứ-tự, cố ý KHÔNG dùng số dòng: thêm một dòng ở đầu file sẽ đổi mọi fingerprint bên dưới và biến một commit vô hại thành đỏ toàn bộ. Chốt mức mới: npm run gate:error-swallow -- --write",
          updatedAt: new Date().toISOString().slice(0, 10),
          total: hienTai.length,
          money: tienHienTai,
          sites: hienTai.sort(),
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`✅ Đã chốt baseline ở ${hienTai.length} chỗ (bỏ được ${daBo.length} so với trước).`);
    return;
  }

  if (themMoi.length > 0) {
    const tienMoi = themMoi.filter(LA_VUNG_TIEN);
    console.error(`\n❌ ${themMoi.length} chỗ nuốt lỗi MỚI (${tienMoi.length} ở vùng tiền):`);
    for (const f of themMoi.slice(0, 20)) console.error(`   + ${LA_VUNG_TIEN(f) ? "[TIỀN] " : ""}${f}`);
    console.error("\n  Thay vì nuốt, dùng src/lib/contracts/{errors,envelopes}.ts: phân loại lỗi rồi");
    console.error("  quyết định. `[]` và `{}` không phân biệt được 'không có dữ liệu' với 'không có quyền'.");
    console.error("  Nếu chỗ này THẬT SỰ được phép im (đọc localStorage, prefetch tuỳ chọn), hãy viết");
    console.error("  `catch { /* lý do */ }` — comment nằm trong khối sẽ không còn khớp mẫu catch rỗng.");
    process.exit(1);
  }

  if (daBo.length > 0) {
    console.log(`✅ 0 chỗ mới. Đã bỏ được ${daBo.length} chỗ — chạy \`--write\` để chốt mức thấp hơn.`);
  } else {
    console.log(`✅ 0 chỗ nuốt lỗi mới.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
