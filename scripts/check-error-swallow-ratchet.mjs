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
// MẪU KHỐI — vì sao thêm 15/09/2026
//   Bốn mẫu đầu chỉ bắt `if (error) return [];` viết trên MỘT DÒNG. Dạng thật
//   sự phổ biến trong repo lại là khối ba dòng có `console.error` ở giữa, và
//   suốt từ 07/08/2026 gate xanh trong khi 40 chỗ như vậy sống trong
//   `src/hooks`. Mẫu `if-error-khoi-tra-rong` bịt đúng khoảng đó.
//
//   Khối có `throw` KHÔNG bị tính, kể cả khi trước đó có `return null` cho
//   nhánh không-tìm-thấy — `.single()` trả PGRST116 khi 0 dòng, và "không có
//   dòng" là dữ liệu chứ không phải lỗi. Gate mà chặn cách sửa đúng thì nó
//   đang đẩy người ta về chỗ cũ.
//
//   Phạm vi cố ý hẹp: `src/hooks/` và `src/lib/` (plan C mục 4). Đây là nơi
//   một lỗi bị nuốt biến thành DỮ LIỆU RỖNG đi thẳng vào màn hình; ở
//   component/page thì mẫu cũ đã đủ và mở rộng sẽ kéo theo một đợt baseline
//   không ai rà nổi trong một lượt.
//
//   node scripts/check-error-swallow-ratchet.mjs
//   node scripts/check-error-swallow-ratchet.mjs --write   # chỉ khi GIẢM
//   node scripts/check-error-swallow-ratchet.mjs --write --nhan-mau=if-error-khoi-tra-rong
//        ↑ CHỈ dùng khi vừa THÊM một mẫu dò: mọi chỗ mẫu mới tìm ra đều "mới"
//          theo nghĩa kỹ thuật dù mã không đổi, nên ratchet phải được nhận một
//          lần. Phạm vi tha bó đúng vào tên mẫu nêu ra — mẫu cũ vẫn khoá.
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
export function lamSachChuThich(noiDung) {
  const dac = (m) => "§".repeat(Math.max(m.length, 1));
  return noiDung.replace(/\/\*[\s\S]*?\*\//g, dac).replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, p1) => p1 + dac(m));
}

/** Tên mẫu khối — giữ ở hằng vì baseline và cờ `--nhan-mau` cùng tham chiếu. */
export const MAU_KHOI = "if-error-khoi-tra-rong";

/** Mẫu khối chỉ soi nơi lỗi bị nuốt biến thành dữ liệu rỗng trên màn hình. */
export const laVungQuetKhoi = (duongDan) => /^src\/(hooks|lib)\//.test(duongDan);

/**
 * Cắt thân các khối `if (<biến có chữ error>) { … }`.
 *
 * Đếm ngoặc thay vì regex vì khối thật hay có `if (…) { … }` lồng bên trong, và
 * một regex không-tham `[^{}]*` sẽ bỏ sót đúng những khối dài nhất — tức là
 * những khối đáng soi nhất. Chú thích được làm đặc TRƯỚC khi đếm, nếu không một
 * dấu `}` nằm trong comment sẽ cắt thân khối sớm và chỗ vi phạm biến mất.
 *
 * Điều kiện phải là MỘT định danh trần: `if (errorCount > 0)` không phải đang
 * kiểm một lỗi, và tính nó vào là bắt người ta sửa thứ không hỏng.
 */
export function timKhoiIfError(noiDung) {
  const sach = lamSachChuThich(noiDung);
  const mo = /if\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/g;
  const than = [];
  for (let m = mo.exec(sach); m; m = mo.exec(sach)) {
    if (!/error/i.test(m[1])) continue;
    let sau = 1;
    let i = m.index + m[0].length;
    for (; i < sach.length && sau > 0; i += 1) {
      if (sach[i] === "{") sau += 1;
      else if (sach[i] === "}") sau -= 1;
    }
    if (sau !== 0) continue; // ngoặc lệch → không đoán, để nguyên
    than.push(sach.slice(m.index + m[0].length, i - 1));
  }
  return than;
}

/** Thân khối trả về giá trị rỗng mà KHÔNG có đường nào ném ra. */
export function laNuotKhoi(than) {
  if (/\bthrow\b/.test(than)) return false;
  return /\breturn\s*(\[\s*\]|\{\s*\}|null|undefined)\s*;/.test(than);
}

export function domKhoi(noiDung, duongDan) {
  if (!laVungQuetKhoi(duongDan)) return [];
  const nuot = timKhoiIfError(noiDung).filter(laNuotKhoi);
  return nuot.map((_, i) => `${duongDan}#${MAU_KHOI}#${i}`);
}

export function domFile(noiDung, duongDan) {
  const sach = lamSachChuThich(noiDung);
  const ra = [];
  for (const [ten, re] of MAU) {
    const n = [...sach.matchAll(re)].length;
    for (let i = 0; i < n; i++) ra.push(`${duongDan}#${ten}#${i}`);
  }
  ra.push(...domKhoi(noiDung, duongDan));
  return ra;
}

export function timThemMoi(baseline, hienTai) {
  const cu = new Set(baseline);
  return hienTai.filter((f) => !cu.has(f)).sort();
}

/**
 * Lọc ra những fingerprint MỚI mà KHÔNG thuộc mẫu được nêu tên.
 *
 * Dùng cho `--write --nhan-mau=…`: thêm một mẫu dò làm mọi chỗ mẫu ấy tìm ra
 * trở thành "mới" dù mã không đổi một dòng. Ratchet vẫn phải khoá các mẫu cũ
 * trong chính lần chốt đó — nếu không, một lần mở rộng gate lại thành cửa sau
 * cho mọi thứ khác đi kèm trong cùng commit.
 */
export function themMoiNgoaiMau(themMoi, mauChoPhep) {
  const tha = new Set(mauChoPhep ?? []);
  return themMoi.filter((f) => {
    const m = /#([^#]+)#\d+$/.exec(f);
    return !(m && tha.has(m[1]));
  });
}

function main() {
  const viet = process.argv.includes("--write");
  const nhanMau = (process.argv.find((a) => a.startsWith("--nhan-mau="))?.slice("--nhan-mau=".length) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
    const chuaThaDuoc = themMoiNgoaiMau(themMoi, nhanMau);
    if (!laLanDau && chuaThaDuoc.length > 0) {
      console.error(`❌ Không chốt baseline khi có ${chuaThaDuoc.length} chỗ MỚI. Ratchet chỉ đi xuống.`);
      for (const f of chuaThaDuoc.slice(0, 10)) console.error(`   + ${f}`);
      if (nhanMau.length > 0) {
        console.error(`   (đã tha mẫu: ${nhanMau.join(", ")} — các chỗ trên KHÔNG thuộc mẫu đó)`);
      }
      process.exit(1);
    }
    if (!laLanDau && themMoi.length > 0) {
      console.log(`⚠ Nhận ${themMoi.length} chỗ của mẫu MỚI (${nhanMau.join(", ")}) vào baseline — mã không đổi, chỉ bộ dò rộng ra.`);
    }
    writeFileSync(
      bPath,
      JSON.stringify(
        {
          $comment:
            "Ratchet chống nuốt lỗi (plan §9). TẬP FINGERPRINT chứ không phải số đếm — với số đếm thì xoá một chỗ ở màn cài đặt rồi thêm một chỗ ở màn thu tiền là hoà, và repo đã có đúng án lệ đó ở ratchet any-cast. Fingerprint là file#mẫu#thứ-tự, cố ý KHÔNG dùng số dòng: thêm một dòng ở đầu file sẽ đổi mọi fingerprint bên dưới và biến một commit vô hại thành đỏ toàn bộ. Chốt mức mới: npm run gate:error-swallow -- --write",
          $mauKhoi:
            "Mẫu `if-error-khoi-tra-rong` thêm 15/09/2026 (plan C), quét src/hooks + src/lib. 48 chỗ nó tìm ra lúc lập mốc: 42 đã đổi sang throw trong cùng commit; 6 chỗ còn trong danh sách dưới đây là QUYẾT ĐỊNH CÓ CHỦ Ý, không phải nợ — financeV2Mutations ×2 (null = tri-state 'KHÔNG rõ', caller fail-open giữ list cũ), supabaseFetchAll (null = hợp đồng fail-closed của chính hàm, caller bắt buộc kiểm), salaryBonusNotify (header ghi rõ KHÔNG throw để không chặn UI hoàn thành việc), customerExcelHelpers (tải ảnh tuỳ chọn), useRooms.ts#useRoom (thuộc plan D đợt này, chưa đụng).",
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
