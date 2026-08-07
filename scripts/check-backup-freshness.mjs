#!/usr/bin/env node
// Gate: phải có một bản dump ĐỌC LẠI ĐƯỢC và đủ mới.
//
// VÌ SAO CẦN
//   Ngày 07/08/2026, cơ chế backup HỎNG mà không ai biết. Nó chỉ lộ ra vì có
//   người bảo "đo thử xem backup mất bao lâu" — chạy thì thấy pg_dump đứt giữa
//   chừng ở bảng lớn nhất ("SSL connection has been closed unexpectedly").
//   Bản chạy trước đó thành công, nên mọi báo cáo đều ghi "backup đã chạy thật".
//
//   Đó đúng là kiểu bằng chứng chương trình này sinh ra để diệt: ảnh chụp chứng
//   minh "LÚC ĐÓ chạy được", không chứng minh "BÂY GIỜ vẫn chạy được".
//
//   Với PITR đã chốt là KHÔNG bật, bản dump này là đường lùi duy nhất cho mọi
//   thao tác đổi schema. Một đường lùi không ai kiểm là một đường lùi tưởng
//   tượng.
//
// GATE NÀY KIỂM BA THỨ, và cả ba đều cần:
//   1. Có bản dump trong ~/ihomecrm-backups
//   2. Bản mới nhất chưa quá HAN_NGAY ngày
//   3. Bản đó ĐỌC LẠI ĐƯỢC (pg_restore --list) và đủ số bảng — không chỉ tồn tại
//
//   node scripts/check-backup-freshness.mjs
//   node scripts/check-backup-freshness.mjs --han 14
//
// KHÔNG chạy được trên CI (bản dump nằm trên máy dev, cố ý ngoài git). Đây là
// gate chạy tay / theo lịch máy local.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HAN_NGAY_MAC_DINH = 7;
const TOI_THIEU_BANG = 450; // cùng sàn với backup-before-schema.mjs

const PG_RESTORE_CANDIDATES = [
  "C:/Program Files/PostgreSQL/17/bin/pg_restore.exe",
  "C:/Program Files/PostgreSQL/18/bin/pg_restore.exe",
  "pg_restore",
];

function timPgRestore() {
  for (const c of PG_RESTORE_CANDIDATES) {
    if (c === "pg_restore" || existsSync(c)) return c;
  }
  return null;
}

/** Bản dump mới nhất trong thư mục, kèm tuổi tính bằng ngày. */
export function banMoiNhat(tenFile, statOf, bayGio = Date.now()) {
  const dump = tenFile.filter((f) => /^ihomecrm-full-.*\.dump$/.test(f)).sort();
  if (dump.length === 0) return null;
  const ten = dump[dump.length - 1];
  const st = statOf(ten);
  return { ten, tuoiNgay: (bayGio - st.mtimeMs) / 86_400_000, bytes: st.size };
}

function main(argv) {
  const han = Number(argv[argv.indexOf("--han") + 1]) || HAN_NGAY_MAC_DINH;
  const dir = join(homedir(), "ihomecrm-backups");

  if (!existsSync(dir)) {
    console.error(`❌ Chưa có thư mục backup: ${dir}`);
    console.error('   Chạy: node scripts/backup-before-schema.mjs --reason "backup định kỳ"');
    process.exitCode = 1;
    return;
  }

  const moi = banMoiNhat(readdirSync(dir), (f) => statSync(join(dir, f)));
  if (!moi) {
    console.error(`❌ KHÔNG có bản dump nào trong ${dir}.`);
    console.error("   PITR đang tắt, nên đây là đường lùi duy nhất cho thao tác đổi schema.");
    process.exitCode = 1;
    return;
  }

  const tuoi = moi.tuoiNgay.toFixed(1);
  if (moi.tuoiNgay > han) {
    console.error(`❌ Bản dump mới nhất đã ${tuoi} ngày tuổi (hạn ${han} ngày): ${moi.ten}`);
    console.error('   Chạy: node scripts/backup-before-schema.mjs --reason "backup định kỳ"');
    process.exitCode = 1;
    return;
  }

  // TỒN TẠI KHÔNG ĐỦ — phải ĐỌC LẠI ĐƯỢC.
  //
  // Đây là chỗ phân biệt gate này với một phép kiểm ngày tháng vô dụng: một file
  // 20 MB nằm đúng chỗ, đúng tên, đúng ngày, vẫn có thể là bản dump cụt. Và anh
  // chỉ phát hiện đúng lúc đang cần khôi phục.
  const pgRestore = timPgRestore();
  if (!pgRestore) {
    console.error("❌ Không tìm thấy pg_restore — không kiểm được bản dump có đọc lại được không.");
    console.error("   KHÔNG coi đây là pass: chưa kiểm được khác với đã kiểm và đạt.");
    process.exitCode = 1;
    return;
  }
  const liet = spawnSync(pgRestore, ["--list", join(dir, moi.ten)], { encoding: "utf8" });
  if (liet.error || liet.status !== 0) {
    console.error(`❌ Bản dump mới nhất KHÔNG đọc lại được — cụt hoặc hỏng: ${moi.ten}`);
    if (liet.stderr) console.error(`   ${String(liet.stderr).split("\n")[0]}`);
    process.exitCode = 1;
    return;
  }
  const soBang = (String(liet.stdout).match(/^\d+;.*TABLE DATA /gm) ?? []).length;
  if (soBang < TOI_THIEU_BANG) {
    console.error(`❌ Bản dump chỉ có ${soBang} bảng dữ liệu (sàn ${TOI_THIEU_BANG}) — nghi CỤT: ${moi.ten}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `✅ Backup còn hạn: ${moi.ten} — ${tuoi} ngày tuổi, ` +
    `${(moi.bytes / 1048576).toFixed(1)} MB, ${soBang} bảng dữ liệu (đã đọc lại được).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv);
}
