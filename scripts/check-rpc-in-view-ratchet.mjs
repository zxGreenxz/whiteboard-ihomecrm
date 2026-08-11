#!/usr/bin/env node
// Ratchet: component và page KHÔNG được gọi thẳng `supabase.rpc("ten_ham")`.
//
// VÌ SAO (plan mục 9)
//   Một chuỗi tên RPC nằm giữa JSX là ba thứ cùng lúc, và cả ba đều vô hình với
//   trình biên dịch:
//     - Không kiểu: đổi chữ ký hàm phía DB thì TypeScript im lặng, lỗi rơi vào
//       runtime của người dùng cuối.
//     - Không tìm được: đổi tên RPC trong migration thì grep phải đoán đúng cách
//       viết chuỗi. Contract §12 bắt hỏi bán kính ảnh hưởng trước khi sửa — chuỗi
//       rải trong view làm câu hỏi đó không trả lời được bằng máy.
//     - Không kiểm được: lỗi bị nuốt thành mảng rỗng hoặc toast chung ngay tại
//       chỗ gọi, thay vì đi qua taxonomy lỗi ở src/lib/contracts/.
//   Chỗ đúng là hook hoặc wrapper typed: một nơi khai tên, một nơi khai kiểu.
//
// VÌ SAO LÀ RATCHET, KHÔNG PHẢI CẤM NGAY
//   Đo 08/08/2026: 9 call site đang tồn tại. Bật cấm ngay là gate đỏ ngày đầu và
//   bị tắt. Ratchet chặn cái MỚI trong khi 9 cái cũ được chuyển dần — mỗi lần
//   chuyển xong thì `--write` hạ baseline, và baseline KHÔNG BAO GIỜ được phép tăng.
//
// VÌ SAO SO TẬP VÂN TAY, KHÔNG SO SỐ ĐẾM
//   Án lệ rpc-cast-baseline so `perFile[file] = n`. Đếm thì xoá một chỗ rồi thêm
//   một chỗ khác trong CÙNG file cho ra cùng con số — vi phạm mới đi lọt. Ở đây
//   vân tay là `<file>::<tên RPC>`, nên thay thế không giấu được.
//
//   node scripts/check-rpc-in-view-ratchet.mjs           # kiểm theo baseline
//   node scripts/check-rpc-in-view-ratchet.mjs --write   # ghi baseline (CHỈ khi không có mục mới)
//
// Không cần credential. Thoát 0 đạt · 1 vi phạm · 3 không kiểm được.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(repoRoot, "tooling", "rpc-in-view-baseline.json");
export const VUNG = ["src/components", "src/pages"];

/**
 * Sàn chống-xanh-rỗng: hai thư mục này có hàng trăm file. Quét được ít hơn ngần
 * này nghĩa là đường dẫn sai hoặc bộ lọc hỏng, và khi ấy "0 vi phạm" là vô nghĩa.
 */
export const TOI_THIEU_FILE = 100;

/** Chỉ .ts/.tsx, bỏ test — test gọi thẳng RPC là hợp lệ. */
export function laFileCanQuet(p) {
  return /\.tsx?$/.test(p) && !/[\\/]__tests__[\\/]/.test(p) && !/\.(test|spec)\.tsx?$/.test(p);
}

/**
 * Rút vân tay `<file>::<tên RPC>` từ nội dung một file.
 *
 * CỐ Ý chỉ bắt dạng có tên là CHUỖI HẰNG (`.rpc("x")` / `.rpc('x')`). Dạng
 * `.rpc(bienTen)` không bắt — nó hiếm, và bắt mù sẽ dính cả JSON-RPC của cầu nối
 * OpenClaw (đã cắn thật một lần với bộ dò `.rpc(` trần).
 */
export function rutVanTay(duong, noiDung) {
  const ra = [];
  for (const m of noiDung.matchAll(/\.rpc\(\s*["']([a-zA-Z0-9_]+)["']/g)) {
    ra.push(`${duong}::${m[1]}`);
  }
  return ra;
}

export function quet(root, vung) {
  const ra = [];
  let soFile = 0;
  const di = (d) => {
    if (!existsSync(d)) return;
    for (const ten of readdirSync(d)) {
      const p = join(d, ten);
      if (statSync(p).isDirectory()) di(p);
      else if (laFileCanQuet(p)) {
        soFile++;
        ra.push(...rutVanTay(relative(root, p).replace(/\\/g, "/"), readFileSync(p, "utf8")));
      }
    }
  };
  for (const v of vung) di(join(root, v));
  return { vanTay: [...new Set(ra)].sort(), soFile };
}

/** So tập hiện tại với baseline. Trả { moi, daXoa }. */
export function soSanh(baseline, hienTai) {
  const cu = new Set(baseline);
  const nay = new Set(hienTai);
  return {
    moi: hienTai.filter((x) => !cu.has(x)),
    daXoa: baseline.filter((x) => !nay.has(x)),
  };
}

function main() {
  const ghi = process.argv.includes("--write");
  const { vanTay, soFile } = quet(repoRoot, VUNG);

  if (soFile < TOI_THIEU_FILE) {
    console.error(`❌ Chỉ quét được ${soFile} file trong ${VUNG.join(", ")} (sàn ${TOI_THIEU_FILE}).`);
    console.error("   Đường dẫn sai hoặc bộ lọc hỏng — '0 vi phạm' ở mức này là vô nghĩa.");
    process.exit(3);
  }

  let baseline = null;
  if (existsSync(BASELINE)) {
    try {
      baseline = JSON.parse(readFileSync(BASELINE, "utf8")).vanTay;
    } catch (e) {
      console.error(`❌ Baseline hỏng: ${e.message} — không kiểm được.`);
      process.exit(3);
    }
  }

  if (!baseline) {
    if (!ghi) {
      console.error("❌ Chưa có baseline. Chạy `--write` một lần để ghi hiện trạng làm mốc.");
      process.exit(3);
    }
    writeFileSync(BASELINE, JSON.stringify({ $comment: GHI_CHU, soFileQuet: soFile, vanTay }, null, 2) + "\n");
    console.log(`✅ Ghi baseline: ${vanTay.length} call site trong ${soFile} file.`);
    return;
  }

  const { moi, daXoa } = soSanh(baseline, vanTay);

  console.log(`RPC gọi thẳng trong view: ${vanTay.length} call site · baseline ${baseline.length} · quét ${soFile} file`);
  if (daXoa.length) {
    console.log(`\n✔ ${daXoa.length} call site đã được chuyển đi:`);
    for (const x of daXoa) console.log(`   ${x}`);
  }

  if (moi.length) {
    console.error(`\n❌ ${moi.length} call site MỚI — component/page không được gọi thẳng supabase.rpc():`);
    for (const x of moi) console.error(`   ${x}`);
    console.error("\n   Chuyển vào hook hoặc wrapper typed trong src/hooks/ hay src/lib/.");
    console.error("   Một chuỗi tên RPC giữa JSX thì trình biên dịch không thấy, grep phải đoán,");
    console.error("   và lỗi bị nuốt ngay tại chỗ gọi thay vì đi qua taxonomy ở src/lib/contracts/.");
    process.exit(1);
  }

  if (ghi) {
    if (daXoa.length === 0) {
      console.log("\nKhông có gì để hạ — baseline giữ nguyên.");
      return;
    }
    writeFileSync(BASELINE, JSON.stringify({ $comment: GHI_CHU, soFileQuet: soFile, vanTay }, null, 2) + "\n");
    console.log(`\n✅ Hạ baseline: ${baseline.length} → ${vanTay.length}.`);
    return;
  }

  if (daXoa.length) {
    console.log("\n   Chạy `--write` để hạ baseline (ratchet chỉ đi một chiều).");
  }
  console.log("\n✅ Không có call site mới.");
}

const GHI_CHU =
  "Ratchet cho scripts/check-rpc-in-view-ratchet.mjs. Vân tay là `<file>::<tên RPC>`, KHÔNG phải số đếm — " +
  "đếm thì xoá một chỗ rồi thêm chỗ khác trong cùng file sẽ đi lọt. Danh sách này CHỈ ĐƯỢC NGẮN ĐI. " +
  "Mỗi mục là một nợ: chuyển call site sang hook/wrapper typed rồi chạy --write.";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
