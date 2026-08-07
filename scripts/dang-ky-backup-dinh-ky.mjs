#!/usr/bin/env node
// Đăng ký / gỡ lịch chạy backup tự động (Windows Task Scheduler).
//
// VÌ SAO: ngày 07/08/2026 cơ chế backup hỏng mà không ai biết — nó chỉ lộ ra khi
// có người tình cờ bảo "đo thử xem mất bao lâu". Với PITR đã chốt là KHÔNG bật,
// bản dump là đường lùi duy nhất cho thao tác đổi schema. Một đường lùi chỉ chạy
// khi có người nhớ thì sớm muộn cũng có tuần không ai nhớ.
//
//   node scripts/dang-ky-backup-dinh-ky.mjs           # đăng ký (Chủ nhật 09:00)
//   node scripts/dang-ky-backup-dinh-ky.mjs --xem     # xem lịch hiện có
//   node scripts/dang-ky-backup-dinh-ky.mjs --go      # gỡ lịch
//
// Task chạy dưới quyền user hiện tại, KHÔNG cần admin. Nó gọi
// scripts/backup-hang-tuan.cmd — file đó chạy backup rồi chạy luôn gate kiểm
// tra, và ghi cả hai vào ~/ihomecrm-backups/nhat-ky.log.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEN_TASK = "ihomecrm-backup-tuan";
const CMD = join(repoRoot, "scripts", "backup-hang-tuan.cmd");

function chay(args) {
  // spawnSync với shell:false — đối số truyền nguyên vẹn, không qua tầng shell
  // nào cắt dấu gạch chéo hay dấu cách. (Đường dẫn repo có dấu cách:
  // "C:\Users\Nguyen Tam\…" — đây đúng chỗ các bản viết bằng chuỗi shell hay vỡ.)
  return spawnSync("schtasks", args, { encoding: "utf8", shell: false });
}

const argv = process.argv;

if (argv.includes("--xem")) {
  const r = chay(["/Query", "/TN", TEN_TASK, "/V", "/FO", "LIST"]);
  if (r.status !== 0) {
    console.log(`Chưa đăng ký lịch "${TEN_TASK}".`);
    process.exit(0);
  }
  const giu = /(TaskName|Next Run Time|Last Run Time|Last Result|Schedule Type|Start Time|Days):/i;
  for (const d of String(r.stdout).split("\n")) if (giu.test(d)) console.log("  " + d.trim());
  process.exit(0);
}

if (argv.includes("--go")) {
  const r = chay(["/Delete", "/TN", TEN_TASK, "/F"]);
  console.log(r.status === 0 ? `✅ Đã gỡ lịch "${TEN_TASK}".` : `Không gỡ được: ${String(r.stderr || r.stdout).trim().slice(0, 200)}`);
  process.exit(r.status === 0 ? 0 : 1);
}

// Chủ nhật 09:00 — ngoài giờ làm việc, và cách xa mốc backup tự động của
// Supabase (03:53 sáng) để hai đường lùi không cùng chết vì một sự cố mạng.
const r = chay(["/Create", "/TN", TEN_TASK, "/TR", `"${CMD}"`, "/SC", "WEEKLY", "/D", "SUN", "/ST", "09:00", "/F"]);
if (r.status !== 0) {
  console.error("❌ Không đăng ký được lịch.");
  console.error(String(r.stderr || r.stdout).trim().slice(0, 400));
  process.exit(1);
}
console.log(`✅ Đã đăng ký "${TEN_TASK}" — Chủ nhật 09:00 hằng tuần.`);
console.log(`   Chạy : ${CMD}`);
console.log("   Xem  : node scripts/dang-ky-backup-dinh-ky.mjs --xem");
console.log("   Gỡ   : node scripts/dang-ky-backup-dinh-ky.mjs --go");
console.log("   Nhật ký: %USERPROFILE%\\ihomecrm-backups\\nhat-ky.log");
