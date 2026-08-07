#!/usr/bin/env node
// Preflight LOCAL: máy này có đủ credential để agent làm việc không?
//
// VÌ SAO CẦN (plan §12, Verification Đợt 0b)
//   Không có preflight thì agent chỉ phát hiện thiếu token ở GIỮA CHỪNG một việc
//   dài — sau khi đã sửa file, đã chạy nửa bộ gate. Lúc đó lựa chọn tệ nhất trở
//   nên hấp dẫn nhất: đi tìm đường vòng. Biết TRƯỚC thì việc dừng lại rẻ.
//
// LUẬT SẮT: KHÔNG BAO GIỜ IN GIÁ TRỊ.
//   Script này chỉ in TÊN field và có/không. Nó đọc CLAUDE.local.md — file chứa
//   PAT, mật khẩu database và khoá SSH — nên mọi đường ra đều phải giả định là sẽ
//   bị dán vào chat hoặc log. Ngay cả độ dài cũng không in: độ dài là thông tin.
//
// KHÔNG CHẠY TRÊN CI CLOUD.
//   CLAUDE.local.md không tồn tại ở đó theo đúng thiết kế. Chạy trên CI sẽ luôn
//   đỏ và người ta sẽ tắt nó đi, kéo theo mất cả tác dụng ở máy dev.
//
//   node scripts/check-local-agent-credentials.mjs
//
// Thoát: 0 đủ · 1 thiếu credential BẮT BUỘC · 3 không kiểm được.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOP_DONG = join("tooling", "local-credential-contract.json");

/** Sàn chống rỗng: hợp đồng rỗng ⇒ vòng lặp 0 lần ⇒ "đủ hết" trên hư không. */
export const TOI_THIEU_ENTRY = 3;

/** Có mặt = regex khớp. Trả về boolean, KHÔNG trả về giá trị bắt được. */
export function coMat(noiDung, detect) {
  try {
    return new RegExp(detect).test(noiDung);
  } catch {
    return null; // regex trong hợp đồng hỏng — khác hẳn "không có credential"
  }
}

export function soatKho(noiDung, credentials) {
  const thieuBatBuoc = [];
  const thieuTuyChon = [];
  const regexHong = [];
  for (const c of credentials) {
    const r = coMat(noiDung, c.detect);
    if (r === null) regexHong.push(c.name);
    else if (!r) (c.required ? thieuBatBuoc : thieuTuyChon).push(c);
  }
  return { thieuBatBuoc, thieuTuyChon, regexHong };
}

function main() {
  let hopDong;
  try {
    hopDong = JSON.parse(readFileSync(join(repoRoot, HOP_DONG), "utf8"));
  } catch (e) {
    console.error(`❌ Không đọc được ${HOP_DONG}: ${e.message}`);
    process.exit(3);
  }
  const creds = hopDong.credentials ?? [];
  if (creds.length < TOI_THIEU_ENTRY) {
    console.error(`❌ Hợp đồng chỉ có ${creds.length} entry (sàn ${TOI_THIEU_ENTRY}) — "đủ hết" sẽ vô nghĩa.`);
    process.exit(3);
  }

  const kho = join(repoRoot, hopDong.vaultPath ?? "CLAUDE.local.md");
  if (!existsSync(kho)) {
    console.error(`=== ⚠ KHÔNG KIỂM ĐƯỢC — KHÔNG PHẢI PASS ===`);
    console.error(`  Không thấy ${hopDong.vaultPath}. Đây là bình thường trên CI cloud (file bị gitignore`);
    console.error(`  theo đúng thiết kế) — preflight này chỉ dành cho máy dev.`);
    process.exit(3);
  }

  // Chốt an toàn: kho PHẢI đang bị gitignore. Nếu vì lý do gì đó nó được track,
  // đây là chỗ duy nhất trong ngày agent còn cơ hội dừng lại trước khi commit.
  const gi = existsSync(join(repoRoot, ".gitignore")) ? readFileSync(join(repoRoot, ".gitignore"), "utf8") : "";
  if (!new RegExp(`^\\s*${(hopDong.vaultPath ?? "").replace(/\./g, "\\.")}\\s*$`, "m").test(gi)) {
    console.error(`❌ ${hopDong.vaultPath} KHÔNG có trong .gitignore.`);
    console.error(`   Dừng lại và sửa .gitignore TRƯỚC khi làm bất cứ gì khác.`);
    process.exit(1);
  }

  const noiDung = readFileSync(kho, "utf8");
  const { thieuBatBuoc, thieuTuyChon, regexHong } = soatKho(noiDung, creds);

  console.log(`Preflight credential: ${creds.length} entry trong hợp đồng · kho ${hopDong.vaultPath} (đã gitignore)`);

  if (regexHong.length > 0) {
    console.error(`❌ ${regexHong.length} entry có regex nhận dạng hỏng: ${regexHong.join(", ")}`);
    console.error(`   Không kết luận được có hay không — sửa hợp đồng.`);
    process.exit(3);
  }

  if (thieuTuyChon.length > 0) {
    console.log(`\n⚠ Thiếu ${thieuTuyChon.length} credential TUỲ CHỌN — một số việc sẽ không chạy được:`);
    for (const c of thieuTuyChon) console.log(`   - ${c.name}: ${c.why}`);
  }

  if (thieuBatBuoc.length > 0) {
    console.error(`\n❌ Thiếu ${thieuBatBuoc.length} credential BẮT BUỘC:`);
    for (const c of thieuBatBuoc) {
      console.error(`   - ${c.name}`);
      console.error(`     dùng cho: ${c.why}`);
      console.error(`     script cần: ${(c.usedBy ?? []).slice(0, 3).join(", ")}`);
    }
    console.error(`\n  Bổ sung vào ${hopDong.vaultPath} rồi chạy lại. KHÔNG đi đường vòng.`);
    process.exit(1);
  }

  console.log(`✅ Đủ ${creds.filter((c) => c.required).length} credential bắt buộc.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
