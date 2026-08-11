#!/usr/bin/env node
// Helper đột biến dùng chung — chứng minh một gate THẬT SỰ bắn được.
//
// VÌ SAO CẦN (plan §35 + P2-27)
//   Mỗi gate trong repo này đều kèm một thủ tục "đã chạy đột biến" viết bằng shell
//   riêng, mỗi chỗ một kiểu. Vấn đề không phải trùng lặp mà là MỘT CÁCH HỎNG
//   CHUNG mà bản viết tay nào cũng dính:
//
//     Neo không khớp ⇒ file KHÔNG đổi ⇒ suite vẫn xanh ⇒ người chạy đọc thành
//     "gate không bắt được" và đi sửa gate. Nhưng gate không sai; phép thử sai.
//
//   Đã xảy ra 6 lần trong một phiên ngày 07–08/08/2026 (anchor sai, `$` trong chuỗi
//   thay thế bị hiểu là escape, CRLF làm neo kết thúc bằng \n không khớp, file đã
//   nằm sẵn trong baseline, regex khớp tiếng Việt thất bại). Lần gần nhất suýt dẫn
//   tới kết luận "bản vá vừa rồi làm gate mù" — sai hoàn toàn.
//
//   Nên helper này KHÔNG chạy suite trước khi chứng minh được file đã đổi thật,
//   bằng sha256 chứ không bằng niềm tin vào regex.
//
// HỢP ĐỒNG
//   0 = ĐẠT: file đổi thật, suite ĐỎ đúng như kỳ vọng, file khôi phục nguyên digest
//   1 = GATE MÙ: file đổi thật nhưng suite vẫn XANH — đây mới là tin xấu thật
//   3 = KHÔNG KIỂM ĐƯỢC: neo không khớp / không khôi phục được / thiếu tham số
//
//   node scripts/dot-bien.mjs --file <path> --tim <chuỗi> --thay <chuỗi> --suite "<lệnh>"
//   node scripts/dot-bien.mjs --file <path> --regex "<re>" --thay <chuỗi> --suite "<lệnh>" --mong-doi-chua "<chuỗi trong output>"
//
// KHÔI PHỤC LÀ BẮT BUỘC và chạy trong finally: một helper làm bẩn cây làm việc rồi
// thoát giữa chừng còn tệ hơn không có helper.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function bam(s) {
  return createHash("sha256").update(s).digest("hex");
}

export function docCo(argv, ten) {
  const i = argv.indexOf(`--${ten}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Áp phép biến đổi. Trả { moi, doi } — `doi` là câu trả lời cho câu hỏi duy nhất
 * đáng hỏi trước khi chạy suite.
 *
 * Dùng hàm thay thế cho `.replace` để chuỗi `$&`, `$1`, `$'` trong `thay` được
 * hiểu là KÝ TỰ THẬT. Đã cắn: `$` trong chuỗi thay thế là escape của
 * String.replace, nên một bản vá chứa `$` bị biến dạng âm thầm.
 */
export function bienDoi(goc, { tim, regex, thay }) {
  let moi;
  if (regex !== undefined) {
    const re = new RegExp(regex, regex.includes("\n") ? "m" : "");
    moi = goc.replace(re, () => thay);
  } else {
    const i = goc.indexOf(tim);
    moi = i < 0 ? goc : goc.slice(0, i) + thay + goc.slice(i + tim.length);
  }
  return { moi, doi: moi !== goc };
}

function main() {
  const a = process.argv;
  const file = docCo(a, "file");
  const tim = docCo(a, "tim");
  const regex = docCo(a, "regex");
  const thay = docCo(a, "thay");
  const suite = docCo(a, "suite");
  const mongDoiChua = docCo(a, "mong-doi-chua");

  if (!file || !suite || thay === undefined || (tim === undefined && regex === undefined)) {
    console.error("❌ Thiếu tham số. Cần --file, --suite, --thay, và một trong --tim | --regex.");
    process.exit(3);
  }
  if (!existsSync(file)) {
    console.error(`❌ Không thấy ${file}.`);
    process.exit(3);
  }

  const goc = readFileSync(file, "utf8");
  const bamGoc = bam(goc);
  const { moi, doi } = bienDoi(goc, { tim, regex, thay });

  // ── Cửa số 1: KHÔNG chạy suite khi chưa chứng minh file đổi ────────────────
  if (!doi) {
    console.error("❌ ĐỘT BIẾN VÔ HIỆU — neo không khớp, file không đổi một byte nào.");
    console.error(`   file : ${file}`);
    console.error(`   neo  : ${regex !== undefined ? `--regex ${regex}` : `--tim ${JSON.stringify(tim)}`}`);
    console.error("\n   KHÔNG chạy suite, và KHÔNG được đọc kết quả này thành 'gate không bắt được'.");
    console.error("   Suite xanh ở đây chỉ chứng minh phép thử hỏng, không chứng minh gì về gate.");
    console.error("   Hay gặp nhất: CRLF (neo kết thúc bằng \\n), ký tự tiếng Việt, hoặc neo đã bị sửa từ trước.");
    process.exit(3);
  }

  let ma = null;
  let ra = "";
  try {
    writeFileSync(file, moi);
    const bamMoi = bam(readFileSync(file, "utf8"));
    if (bamMoi === bamGoc) {
      console.error("❌ Ghi xong mà sha256 không đổi — hệ thống tệp không nhận thay đổi. Không kiểm được.");
      process.exit(3);
    }
    console.log(`Đột biến: ${file}`);
    console.log(`  sha256 ${bamGoc.slice(0, 12)} → ${bamMoi.slice(0, 12)}  (đã đổi thật)`);
    console.log(`  suite : ${suite}\n`);

    try {
      ra = execSync(suite, { encoding: "utf8", stdio: "pipe", cwd: process.cwd() });
      ma = 0;
    } catch (e) {
      ma = e.status ?? 1;
      ra = String(e.stdout ?? "") + String(e.stderr ?? "");
    }
  } finally {
    // Khôi phục LUÔN chạy, kể cả khi trên kia ném.
    writeFileSync(file, goc);
    const bamSau = bam(readFileSync(file, "utf8"));
    if (bamSau !== bamGoc) {
      console.error(`\n❌ KHÔNG KHÔI PHỤC ĐƯỢC ${file} — sha256 ${bamSau.slice(0, 12)} ≠ gốc ${bamGoc.slice(0, 12)}.`);
      console.error("   Cây làm việc đang BẨN. Xử lý tay trước khi làm gì tiếp.");
      process.exit(3);
    }
    console.log(`\nKhôi phục: sha256 về ${bamGoc.slice(0, 12)} ✓`);
  }

  // ── Cửa số 2: suite phải ĐỎ ────────────────────────────────────────────────
  if (ma === 0) {
    console.error("\n❌ GATE MÙ — file đã đổi thật nhưng suite vẫn XANH.");
    console.error("   Đây là tin xấu thật (khác hẳn exit 3 ở trên): gate không bắt được thứ nó phải bắt.");
    process.exit(1);
  }

  if (mongDoiChua && !ra.includes(mongDoiChua)) {
    console.error(`\n❌ Suite ĐỎ nhưng output KHÔNG chứa "${mongDoiChua}".`);
    console.error("   Đỏ vì lý do khác thì không chứng minh được gate bắt đúng thứ này.");
    console.error(`   Trích output:\n${ra.split("\n").slice(0, 12).map((l) => "     " + l).join("\n")}`);
    process.exit(1);
  }

  console.log(`\n✅ ĐẠT — suite đỏ đúng kỳ vọng (exit ${ma})${mongDoiChua ? `, output có "${mongDoiChua}"` : ""}.`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) main();
