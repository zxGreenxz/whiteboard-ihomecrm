#!/usr/bin/env node
// Gate: hàm export ra mà CHỈ test dùng là một cài đặt song song — test trên nó
// không nói gì về thứ đang chạy.
//
// VÌ SAO CẦN
//   Repo này đã có bốn ca "test kiểm bản chép thay vì kiểm code thật" (xem
//   contractRoomFilter, meterReadingFormBugfix, invoiceGeneration, v5-calendar-parity).
//   Ba ca đầu chép hàm vào chính file test. Ca thứ tư tinh vi hơn và quét cú pháp
//   không thấy: người ta tạo hẳn một module helper, export đầy đủ, viết property
//   test đàng hoàng — nhưng KHÔNG code sản xuất nào import những hàm đó.
//
//   Đo 06/08/2026 ở src/hooks/useIncomeExpensesHelpers.ts: 6/10 hàm không nơi nào
//   ngoài test dùng (createVoucherPayload, canDeleteVoucher, filterNonDeleted,
//   applyVoucherUpdate, generateVoucherCode, isValidVoucherCode). 34 property test
//   chạy qua chúng. Test xanh, độ phủ trông đẹp, và không dòng nào trong đó được
//   giao tới người dùng.
//
//   Đây KHÔNG phải lỗi tự động — có khi là code đang chờ dùng, có khi là tàn dư
//   sau refactor. Nhưng nó phải NHÌN THẤY ĐƯỢC, vì một test xanh trên code chết
//   trông y hệt một test xanh trên code sống.
//
// Ratchet: danh sách chỉ được NGẮN LẠI. Thêm export chỉ-test-dùng mới ⇒ đỏ.
//
//   node scripts/check-test-only-exports.mjs
//   node scripts/check-test-only-exports.mjs --write   # chốt mức mới
//   node scripts/check-test-only-exports.mjs --list
//
// Không cần credential, không đọc database.

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(repoRoot, "src");
const BASELINE = join(repoRoot, "tooling", "test-only-exports-baseline.json");

const laTest = (p) => /__tests__|\.test\.|\.spec\./.test(p.replace(/\\/g, "/"));

function motFile(dir, ra = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) motFile(p, ra);
    else if (/\.tsx?$/.test(e.name)) ra.push(p);
  }
  return ra;
}

/**
 * Chỉ xét file `*Helpers.ts` / `*Utils.ts` trong src/.
 *
 * Cố ý hẹp: quét mọi export trong src/ sẽ đầy báo động giả (component export
 * default, type, hằng cấu hình, barrel file re-export). Hai hậu tố này là nơi
 * người ta ĐẶT logic thuần để test — tức đúng chỗ mẫu lỗi này sinh ra.
 */
export function locFileHelper(files) {
  return files.filter((f) => !laTest(f) && /(Helpers|Utils)\.tsx?$/.test(f));
}

export function timExportChiTestDung(files) {
  const helpers = locFileHelper(files);
  const nguonSanXuat = files.filter((f) => !laTest(f));
  const ket = [];

  for (const h of helpers) {
    const ten = [
      ...readFileSync(h, "utf8").matchAll(
        /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm,
      ),
    ].map((m) => m[1]);
    if (ten.length === 0) continue;

    const chet = [];
    for (const t of ten) {
      const re = new RegExp(`\\b${t}\\b`);
      const dung = nguonSanXuat.some((f) => f !== h && re.test(readFileSync(f, "utf8")));
      if (!dung) chet.push(t);
    }
    if (chet.length > 0) {
      ket.push({ file: relative(repoRoot, h).replace(/\\/g, "/"), chet, tong: ten.length });
    }
  }
  return ket.sort((a, b) => a.file.localeCompare(b.file));
}

function main(argv) {
  const ket = timExportChiTestDung(motFile(SRC));
  const khoa = ket.flatMap((r) => r.chet.map((c) => `${r.file}#${c}`));

  if (argv.includes("--list")) {
    for (const r of ket) {
      console.log(`\n${r.file}  (${r.chet.length}/${r.tong} hàm chỉ test dùng)`);
      for (const c of r.chet) console.log(`   - ${c}`);
    }
    console.log("");
  }

  if (argv.includes("--write")) {
    writeFileSync(
      BASELINE,
      `${JSON.stringify(
        {
          $comment:
            "Ratchet: hàm export trong *Helpers/*Utils mà CHỈ test dùng. Danh sách CHỈ ĐƯỢC NGẮN LẠI. Cách xử: hoặc nối code sản xuất vào dùng nó, hoặc xoá cả hàm lẫn test — một test xanh trên code chết trông y hệt test xanh trên code sống. Sinh bởi scripts/check-test-only-exports.mjs.",
          total: khoa.length,
          exports: khoa,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`✅ Đã chốt baseline: ${khoa.length} export chỉ-test-dùng.`);
    return;
  }

  if (!existsSync(BASELINE)) {
    console.error("❌ Chưa có baseline. Chạy với --write để chốt mức hiện tại.");
    process.exitCode = 1;
    return;
  }

  const cu = new Set(JSON.parse(readFileSync(BASELINE, "utf8")).exports ?? []);
  const moi = khoa.filter((k) => !cu.has(k));

  if (moi.length > 0) {
    console.error(`❌ ${moi.length} hàm export MỚI mà chỉ test dùng:\n`);
    for (const m of moi) console.error(`  - ${m}`);
    console.error("\n  Hàm không code sản xuất nào gọi là một CÀI ĐẶT SONG SONG: test trên nó");
    console.error("  xanh mà không nói gì về thứ được giao tới người dùng.");
    console.error("  Xử: nối code sản xuất vào dùng nó, HOẶC xoá cả hàm lẫn test.");
    process.exitCode = 1;
    return;
  }

  const daXu = [...cu].filter((k) => !khoa.includes(k));
  console.log(`✅ Export chỉ-test-dùng: ${khoa.length} (baseline ${cu.size}), không có cái mới.`);
  if (daXu.length > 0) {
    console.log(`   🎉 Đã xử ${daXu.length} — chạy --write để chốt mức thấp hơn.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv);
}
