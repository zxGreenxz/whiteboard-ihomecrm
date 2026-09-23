#!/usr/bin/env node
// Chạy thử một file SQL (thường là migration mới) lên MÔI TRƯỜNG TEST.
//
//   npm run test-env:thu-sql -- supabase/migrations/<file>.sql            # ROLLBACK (mặc định)
//   npm run test-env:thu-sql -- supabase/migrations/<file>.sql --ghi      # COMMIT vào TEST
//
// VÌ SAO: trước đây mọi migration chỉ dry-run được trên chính production (bọc ROLLBACK)
// hoặc trên Postgres trần không có dữ liệu. TEST có đúng schema + dữ liệu production,
// nên lỗi thật (ràng buộc trên dữ liệu cũ, RLS, quyền) lộ ra TRƯỚC khi đụng sổ sách.
//
// Chỉ GHI vào TEST (qua batBuocDichTest). Đổi schema PRODUCTION vẫn chỉ đi
// `npm run migrate:forward` (Contract §4) — script này không thay lane đó.
// Lần đồng bộ sau sẽ ghi đè TEST bằng production, nên thay đổi đã --ghi ở đây mất đi
// nếu chưa lên production.

import { readFileSync } from "node:fs";

import { batBuocDichTest, credential, ghiLog, ketNoi, kiemCongCu, psql } from "./lib.mjs";

async function main(argv) {
  const file = argv.slice(2).find((a) => !a.startsWith("--"));
  const ghi = argv.includes("--ghi");
  if (!file) {
    console.error("Dùng: npm run test-env:thu-sql -- <file.sql> [--ghi]");
    return 1;
  }
  const sql = readFileSync(file, "utf8");
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(sql.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ""))) {
    console.error("❌ File tự mở/đóng transaction — script đã tự bọc một transaction duy nhất.");
    return 1;
  }
  kiemCongCu();
  const cred = credential();
  const { test } = await ketNoi(cred);
  await batBuocDichTest(cred, test);
  const t0 = Date.now();
  const r = psql(test, `BEGIN;\n${sql}\n;${ghi ? "COMMIT" : "ROLLBACK"};\n`, { dungKhiLoi: true });
  ghiLog("thu-sql", `${ghi ? "ĐÃ GHI vào TEST" : "chạy trong ROLLBACK (không ghi)"} · ${file} · ${Math.round((Date.now() - t0) / 1000)}s`);
  if (r.stderr.trim()) console.log(r.stderr.trim().split(/\r?\n/).slice(0, 40).join("\n"));
  return 0;
}

main(process.argv).then((c) => process.exit(c), (e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
