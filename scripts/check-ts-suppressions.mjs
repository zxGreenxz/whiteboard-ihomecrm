#!/usr/bin/env node
// Ratchet cho các chỉ thị TẮT kiểm tra kiểu: @ts-ignore, @ts-expect-error,
// @ts-nocheck.
//
// VÌ SAO CẦN
//   Gate typecheck (scripts/check-ts-baseline.mjs, ratchet 26 fingerprint) là
//   cửa chặn nặng ký nhất repo. Đo 07/08/2026: nó bắt được lỗi TS mới trong file
//   .ts, bắt được cả file .tsx mới toanh — NHƯNG một dòng `// @ts-ignore` đặt
//   ngay trên lỗi thì gate xanh trơn.
//
//   Đó không phải lỗi của gate kia: @ts-ignore vốn để làm đúng việc ấy. Vấn đề
//   là KHÔNG GÌ ĐẾM chúng. Nghĩa là cửa chặn nặng nhất có thể bị vô hiệu bằng
//   một comment, âm thầm, và không dấu vết nào trong CI.
//
//   Hiện trạng lúc dựng gate: TOÀN BỘ code first-party có đúng 1 chỗ, và nó
//   chính đáng — `@ts-expect-error` trong test cố tình truyền undefined để kiểm
//   guard. Dựng ratchet lúc sạch thì rẻ; đợi tới lúc có 50 chỗ thì không ai dọn.
//
//   (211 chỗ khác trong cây làm việc đều nằm trong node_modules — gate quét theo
//   danh sách `git ls-files` nên không dính, và cũng không nên dính.)
//
// PHÂN BIỆT MỨC NGUY HIỂM — cùng đếm, nhưng thông điệp khác nhau:
//   @ts-nocheck      tắt kiểm tra CẢ FILE. Nặng nhất.
//   @ts-ignore       tắt mù dòng kế tiếp; nếu sau này lỗi biến mất thì không ai
//                    biết, chỉ thị nằm lại vĩnh viễn.
//   @ts-expect-error an toàn hơn hẳn: nếu KHÔNG còn lỗi thì chính nó thành lỗi,
//                    nên không mục được. Trong test đây thường là cách viết ĐÚNG.
//
// Ratchet theo TẬP FINGERPRINT (file#directive), không theo con số — cùng cách
// ts-baseline.json làm, vì đếm số cho phép đánh tráo: bỏ một chỗ, thêm một chỗ
// khác, tổng không đổi và gate im.
//
//   node scripts/check-ts-suppressions.mjs
//   node scripts/check-ts-suppressions.mjs --list
//   node scripts/check-ts-suppressions.mjs --write   # chốt mức mới
//
// Không cần credential, không đọc database.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { laCI, lietKeUntracked, phanCap } from "./lib/git-scope.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(repoRoot, "tooling", "ts-suppression-baseline.json");

/**
 * Chỉ thị bắt trong comment. Cả 3 dạng TS công nhận.
 *
 * PHẢI đứng NGAY SAU dấu mở comment (`//`, `///`, `/*`), vì đó đúng là vị trí
 * DUY NHẤT TypeScript công nhận: bộ quét của nó khớp `^\s*(\/\/\/?\s*)?@ts-…`
 * tính từ đầu nội dung comment. Một lần nhắc TÊN chỉ thị giữa câu văn thì không
 * tắt kiểm tra kiểu của bất cứ dòng nào.
 *
 * Vì sao siết lại (11/08/2026): bản cũ khớp chuỗi ở mọi vị trí, nên một dòng
 * chú thích giải thích "ở đây KHÔNG dùng @ts-expect-error vì…" bị đếm y như một
 * chỉ thị thật. Đã dính ngay trong lát gỡ chỉ thị cuối cùng: gỡ xong mà gate vẫn
 * báo 1, và cái thứ 1 đó chính là câu văn vừa viết ra để giải thích việc gỡ.
 *
 * Đây cùng một họ với căn bệnh file này đã tự ghi ở dưới — "cấm luôn việc VIẾT
 * RA rằng điều đó bị cấm". Bản cũ mới chữa cho `scripts/`, chưa chữa trong `src/`.
 */
export const DIRECTIVE = /(?:\/\/\/?|\/\*)\s*@ts-(ignore|expect-error|nocheck)\b/g;

/**
 * Quét theo `git ls-files` chứ không đi cây thư mục.
 *
 * Đây là điểm cốt yếu: đi cây thư mục sẽ nuốt node_modules (đo được 211 chỗ,
 * kể cả một file .node NHỊ PHÂN khớp chuỗi) và con số trở nên vô nghĩa. Danh
 * sách của git đúng bằng thứ repo chịu trách nhiệm.
 */
export function quet() {
  // CHỈ file TypeScript. Bản đầu quét cả .mjs/.cjs/.js/.jsx và lập tức tự cắn:
  // chính file này nêu tên ba chỉ thị trong comment và regex, nên gate báo chính
  // nó vi phạm — đúng căn bệnh guard grep cũ của repo từng mắc (cấm luôn việc
  // VIẾT RA rằng điều đó bị cấm).
  //
  // Cách sửa không phải là miễn trừ riêng file này, mà là bám vào sự thật: chỉ
  // thị @ts-* chỉ CÓ TÁC DỤNG nơi trình kiểm kiểu thật sự chạy. tsconfig.app.json
  // include đúng ["src"], và `checkJs` không bật ở đâu cả — nên một @ts-ignore
  // trong scripts/*.mjs không tắt được gì, đếm nó là đếm thứ vô hại.
  // `--others --exclude-standard` = file MỚI chưa add nhưng không bị gitignore.
  // Thiếu hai cờ này thì `git ls-files` chỉ thấy file ĐÃ theo dõi, và một file
  // .tsx mới toanh kèm @ts-ignore đi thẳng qua — chính gate này đã dính (đo
  // 07/08/2026: tạo src/lib/thuMoi.tsx có @ts-ignore ⇒ gate vẫn xanh). Vẫn tôn
  // trọng .gitignore nên node_modules không lọt vào.
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "*.ts", "*.tsx", "*.mts", "*.cts"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const files = out.trim().split("\n").filter(Boolean).filter((f) => !f.includes("node_modules"));

  const tim = [];
  for (const rel of files) {
    let source;
    try {
      source = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      continue; // file trong index nhưng không có trên đĩa — bỏ qua, không phải lỗi của gate
    }
    if (!source.includes("@ts-")) continue;

    const dong = source.split(/\r?\n/);
    for (let i = 0; i < dong.length; i += 1) {
      DIRECTIVE.lastIndex = 0;
      let m;
      while ((m = DIRECTIVE.exec(dong[i])) !== null) {
        tim.push({ file: rel, kind: `@ts-${m[1]}`, line: i + 1, khoa: `${rel}#@ts-${m[1]}` });
      }
    }
  }
  return { files: files.length, tim };
}

const NANG = { "@ts-nocheck": 3, "@ts-ignore": 2, "@ts-expect-error": 1 };

/** Glob file mà quet() dùng — tách hằng để lượt liệt kê untracked dùng đúng tập. */
const GLOB_TS = ["*.ts", "*.tsx", "*.mts", "*.cts"];

/**
 * Tách fingerprint MỚI thành {cung, mem} theo luật phiên-song-song (28/08/2026):
 * chỉ thị nằm trong file UNTRACKED thường là WIP của phiên khác trên working
 * tree chung — local hạ xuống cảnh báo; đã stage hoặc trên CI thì cứng như cũ
 * (lúc stage file rời nhóm untracked nên lưới "bắt trước khi push" không thủng).
 */
export function phanLoaiChiThiMoi(khoaMoi, tapUntracked, ci) {
  return phanCap(khoaMoi, tapUntracked, ci, (k) => k.split("#")[0]);
}

function main(argv) {
  const { files, tim } = quet();

  // Chống rỗng-vô-nghĩa: `git ls-files` trả rỗng (chạy ngoài repo, hoặc glob đổi)
  // sẽ làm gate XANH mà không quét gì. Đây đúng lớp lỗi đã cắn repo này hai lần.
  if (files < 100) {
    console.error(`❌ Chỉ tìm thấy ${files} file để quét — nghi git ls-files hỏng hoặc glob sai.`);
    console.error("   Gate sẽ xanh mà không kiểm gì, nên phải đỏ. Kiểm tra lại lệnh quét.");
    process.exitCode = 1;
    return;
  }

  const khoa = [...new Set(tim.map((t) => t.khoa))].sort();

  if (argv.includes("--list")) {
    for (const t of tim.sort((a, b) => NANG[b.kind] - NANG[a.kind] || a.file.localeCompare(b.file))) {
      console.log(`  ${t.kind.padEnd(17)} ${t.file}:${t.line}`);
    }
    console.log(`\n  ${tim.length} chỗ / ${khoa.length} fingerprint / ${files} file đã quét.\n`);
  }

  if (argv.includes("--write")) {
    // Baseline phải TÁI LẬP ĐƯỢC từ commit — fingerprint nằm trong file
    // untracked (WIP, có thể của phiên khác) mà nướng vào đây thì baseline mô
    // tả một trạng thái không ai khác dựng lại nổi, và CI đỏ ngay lượt sau.
    const tapUntrackedWrite = new Set(lietKeUntracked(GLOB_TS));
    const khoaGhi = khoa.filter((k) => !tapUntrackedWrite.has(k.split("#")[0]));
    if (khoaGhi.length < khoa.length) {
      console.warn(`⚠ Bỏ ${khoa.length - khoaGhi.length} fingerprint trên file chưa add khỏi baseline (WIP).`);
    }
    writeFileSync(
      BASELINE,
      `${JSON.stringify(
        {
          $comment:
            "Ratchet chỉ thị tắt kiểm tra kiểu (@ts-ignore / @ts-expect-error / @ts-nocheck). Khoá theo TẬP fingerprint file#directive, KHÔNG theo con số — đếm số cho phép đánh tráo chỗ này lấy chỗ kia mà tổng không đổi. Vì sao cần: gate typecheck chính (check-ts-baseline.mjs) bị một dòng @ts-ignore vô hiệu hoàn toàn, và trước gate này không gì đếm chúng. Sinh bởi scripts/check-ts-suppressions.mjs.",
          total: khoaGhi.length,
          fingerprints: khoaGhi,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`✅ Đã chốt baseline: ${khoaGhi.length} fingerprint.`);
    return;
  }

  if (!existsSync(BASELINE)) {
    console.error("❌ Chưa có baseline. Chạy với --write để chốt mức hiện tại.");
    process.exitCode = 1;
    return;
  }

  const cu = new Set(JSON.parse(readFileSync(BASELINE, "utf8")).fingerprints ?? []);
  const moi = khoa.filter((k) => !cu.has(k));

  // Fingerprint mới trong file UNTRACKED chỉ mềm ở local — WIP phiên khác trên
  // working tree chung không được làm phiên này đỏ (đo 28/08/2026).
  const tapUntracked = new Set(lietKeUntracked(GLOB_TS));
  const { cung: moiCung, mem: moiMem } = phanLoaiChiThiMoi(moi, tapUntracked, laCI());

  if (moiMem.length > 0) {
    console.warn(`⚠ ${moiMem.length} chỉ thị tắt kiểm tra kiểu trong file CHƯA ADD (WIP — có thể của phiên khác):`);
    for (const k of moiMem) console.warn(`  - ${k}`);
    console.warn("  Nếu là của bạn: sẽ CHẶN CỨNG ngay khi `git add` — xử trước khi stage.");
  }

  if (moiCung.length > 0) {
    console.error(`❌ ${moiCung.length} chỗ tắt kiểm tra kiểu MỚI:\n`);
    for (const k of moiCung) {
      const viTri = tim.filter((t) => t.khoa === k).map((t) => `dòng ${t.line}`).join(", ");
      console.error(`  - ${k}  (${viTri})`);
    }
    console.error("\n  Những chỉ thị này TẮT kiểm tra kiểu, tức vô hiệu hoá gate typecheck");
    console.error("  (check-ts-baseline.mjs) ngay tại dòng đó — lỗi vẫn còn, chỉ là không ai thấy.");
    console.error("  Xử: sửa cho đúng kiểu. Nếu buộc phải chặn, dùng @ts-expect-error (nó tự đỏ khi");
    console.error("  lỗi biến mất, nên không mục) chứ đừng dùng @ts-ignore, rồi --write để ghi nợ.");
    process.exitCode = 1;
    return;
  }

  const daXu = [...cu].filter((k) => !khoa.includes(k));
  const theoLoai = tim.reduce((a, t) => ((a[t.kind] = (a[t.kind] ?? 0) + 1), a), {});
  const tomTat = Object.entries(theoLoai)
    .sort((a, b) => NANG[b[0]] - NANG[a[0]])
    .map(([k, v]) => `${v} ${k}`)
    .join(" · ");
  console.log(
    `✅ Chỉ thị tắt kiểm tra kiểu: ${khoa.length} fingerprint (baseline ${cu.size})${tomTat ? ` — ${tomTat}` : ""}. Không có cái mới.`,
  );
  if (daXu.length > 0) {
    console.log(`   🎉 Đã xử ${daXu.length} — chạy --write để chốt mức thấp hơn.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv);
}
