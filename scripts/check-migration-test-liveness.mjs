#!/usr/bin/env node
// Gate: test khẳng định về một hàm SQL phải đo ĐỊNH NGHĨA ĐANG CHẠY, không đo
// một file migration đã đóng băng.
//
// VÌ SAO CẦN — đây là một lớp "test không thể đỏ" đặc thù của repo này.
//   Rất nhiều test đọc thẳng MỘT file migration rồi `expect(sql).toContain(...)`.
//   Hai luật của repo biến vế "actual" đó thành HẰNG SỐ, không phải phép đo:
//     - migration-policy.json: file <= cutoff là legacy-frozen, CHỈ ĐỌC.
//     - check-migration-provenance.mjs băm sha256 từng file và đỏ nếu bytes đổi.
//   Nghĩa là chuỗi đó không bao giờ đổi được. Test sẽ xanh vĩnh viễn — kể cả khi
//   hàm THẬT đã đổi hành vi.
//
//   Và repo chỉ sửa hành vi bằng forward-fix: một migration MỚI `CREATE OR REPLACE`
//   cùng hàm đó. Nên định nghĩa SỐNG dời sang file khác, còn test vẫn soi file cũ.
//   Đo 06/08/2026: 12/37 test ghim file đang nhắc tới hàm mà định nghĩa cuối cùng
//   đã nằm ở file KHÁC — gồm cả hàm tiền (record_invoice_collection_v5,
//   post_approved_income_expense_v2, create_invoice_with_credit_v1).
//
//   Khuôn ĐÚNG đã có sẵn trong repo: `liveDefinitionOf()` ở
//   src/lib/__tests__/salaryCompletionDate.test.ts — quét toàn bộ thư mục
//   migration và lấy CREATE cuối cùng.
//
// Gate này KHÔNG bắt sửa ngay 12 file cũ (ratchet, xem baseline bên dưới). Nó bảo
// đảm con số chỉ được GIẢM: thêm test ghim mới ⇒ đỏ.
//
//   node scripts/check-migration-test-liveness.mjs
//   node scripts/check-migration-test-liveness.mjs --write   # chốt mức mới
//   node scripts/check-migration-test-liveness.mjs --list    # in chi tiết
//
// Không cần credential, không đọc database.

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIG_DIR = join(repoRoot, "supabase", "migrations");
const BASELINE = join(repoRoot, "tooling", "migration-test-liveness-baseline.json");

const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");

/** Bảng: tên hàm (schema.ten) -> file migration định nghĩa nó CUỐI CÙNG. */
export function bangDinhNghiaCuoi(migDir = MIG_DIR) {
  const cuoi = new Map();
  for (const f of readdirSync(migDir).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = stripComments(readFileSync(join(migDir, f), "utf8"));
    for (const m of sql.matchAll(
      /create\s+(?:or\s+replace\s+)?function\s+([a-z_]+)\.([a-z0-9_]+)/gi,
    )) {
      cuoi.set(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`, f);
    }
  }
  return cuoi;
}

function motFile(duongDan) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!/node_modules|dist/.test(p)) walk(p);
      } else if (/\.test\.(ts|tsx|mjs)$/.test(e.name) && !/openclaw/i.test(p)) {
        out.push(p);
      }
    }
  };
  walk(duongDan);
  return out;
}

export function timTestGhimLoiThoi(cuoi, files) {
  const ket = [];
  for (const t of files) {
    const s = readFileSync(t, "utf8");
    const ghim = [
      ...new Set(
        [...s.matchAll(/supabase\/migrations\/(\d{14}_[a-z0-9_]+\.sql)/g)].map((m) => m[1]),
      ),
    ];
    if (ghim.length === 0) continue;

    // CHỈ xét hàm được khẳng định KHẲNG ĐỊNH. Bản đầu tôi bắt mọi tên hàm xuất
    // hiện trong file test, và nó báo sai ngay ca đầu tiên đọc kỹ:
    // invoiceCollectionV5Hardening.test.ts khẳng định file đó KHÔNG định nghĩa
    // lại `record_invoice_collection_v5` (`expect(sql).not.toMatch(...)`). Ghim
    // file ở đó là ĐÚNG — nó đang kiểm chính file ấy làm gì, không kiểm hàm hiện
    // hành. Một assertion phủ định về một file đóng băng vẫn có nghĩa mãi mãi.
    //
    // Chỉ khi test khẳng định KHẲNG ĐỊNH ("file này CÓ chứa …") thì nó mới đang
    // mượn file cũ để nói về hàm hiện hành — và đó mới là chỗ đo sai đối tượng.
    const dongPhuDinh = new Set(
      s
        .split("\n")
        .map((l, i) => (/\.not\s*\.\s*(toMatch|toContain)/.test(l) ? i : -1))
        .filter((i) => i >= 0),
    );
    const hams = [
      ...new Set(
        s
          .split("\n")
          .flatMap((l, i) =>
            dongPhuDinh.has(i)
              ? []
              : [...l.matchAll(/\b(public|app_private)[._]([a-z0-9_]{6,})\b/g)].map(
                  (m) => `${m[1]}.${m[2]}`,
                ),
          ),
      ),
    ];
    // Tiêu chí ĐÚNG: file bị ghim PHẢI thực sự định nghĩa hàm đó, VÀ một file
    // muộn hơn đã định nghĩa lại. Chỉ khi đó test mới đang đo một bản đã bị thay.
    //
    // Bản trước tôi chỉ hỏi "file sống có nằm trong danh sách ghim không", và nó
    // báo sai cả những ca file ghim chưa từng định nghĩa hàm — ví dụ
    // authzWave1Hardening ghim file 20260725 trong khi jobs_stamp_completion_time
    // sống ở 20260720, tức file cũ HƠN. Ở đó test chỉ nhắc tên hàm, không hề mượn
    // file cũ để nói về hàm hiện hành.
    const lech = hams
      .map((h) => ({ ham: h, song: cuoi.get(h) }))
      .filter((x) => {
        if (!x.song || ghim.includes(x.song)) return false;
        // File ghim nào ĐỊNH NGHĨA hàm này?
        const dinhNghiaTrongGhim = ghim.filter((g) => {
          try {
            const sql = stripComments(readFileSync(join(MIG_DIR, g), "utf8"));
            const [sch, ten] = x.ham.split(".");
            return new RegExp(
              `create\\s+(?:or\\s+replace\\s+)?function\\s+${sch}\\.${ten}\\b`,
              "i",
            ).test(sql);
          } catch {
            return false;
          }
        });
        if (dinhNghiaTrongGhim.length === 0) return false;
        // Và bản sống phải MUỘN HƠN bản trong file ghim.
        return dinhNghiaTrongGhim.every((g) => g < x.song);
      });

    if (lech.length > 0) {
      ket.push({
        file: t.replace(repoRoot, "").replace(/\\/g, "/").replace(/^\//, ""),
        ghim,
        lech,
      });
    }
  }
  return ket.sort((a, b) => a.file.localeCompare(b.file));
}

function main(argv) {
  const cuoi = bangDinhNghiaCuoi();
  const ket = timTestGhimLoiThoi(cuoi, motFile(join(repoRoot, "src")));
  const hienTai = ket.map((r) => r.file);

  if (argv.includes("--list")) {
    for (const r of ket) {
      console.log(`\n${r.file}`);
      console.log(`   ghim: ${r.ghim.join(", ")}`);
      for (const l of r.lech.slice(0, 4)) console.log(`   lệch: ${l.ham} → sống ở ${l.song}`);
    }
    console.log("");
  }

  if (argv.includes("--write")) {
    writeFileSync(
      BASELINE,
      `${JSON.stringify(
        {
          $comment:
            "Ratchet: test ghim file migration KHÔNG còn là nơi định nghĩa cuối cùng. Danh sách CHỈ ĐƯỢC NGẮN LẠI. Sinh bởi scripts/check-migration-test-liveness.mjs. Cách sửa: đổi test sang liveDefinitionOf() — khuôn ở src/lib/__tests__/salaryCompletionDate.test.ts.",
          total: hienTai.length,
          files: hienTai,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`✅ Đã chốt baseline: ${hienTai.length} file.`);
    return;
  }

  if (!existsSync(BASELINE)) {
    console.error("❌ Chưa có baseline. Chạy với --write để chốt mức hiện tại.");
    process.exitCode = 1;
    return;
  }

  const base = JSON.parse(readFileSync(BASELINE, "utf8"));
  const cu = new Set(base.files ?? []);
  const moi = hienTai.filter((f) => !cu.has(f));

  if (moi.length > 0) {
    console.error(`❌ ${moi.length} test MỚI ghim vào định nghĩa đã bị thay thế:\n`);
    for (const f of moi) {
      const r = ket.find((x) => x.file === f);
      console.error(`  - ${f}`);
      for (const l of (r?.lech ?? []).slice(0, 3)) {
        console.error(`      ${l.ham} → định nghĩa sống ở ${l.song}`);
      }
    }
    console.error("\n  Test đọc một file migration ĐÃ ĐÓNG BĂNG thì vế 'actual' là hằng số,");
    console.error("  không phải phép đo — nó xanh vĩnh viễn kể cả khi hàm thật đổi hành vi.");
    console.error("  Sửa: quét toàn bộ thư mục migration lấy CREATE cuối cùng.");
    console.error("  Khuôn: liveDefinitionOf() trong src/lib/__tests__/salaryCompletionDate.test.ts");
    process.exitCode = 1;
    return;
  }

  const daSua = [...cu].filter((f) => !hienTai.includes(f));
  console.log(
    `✅ Test ghim định nghĩa lỗi thời: ${hienTai.length} (baseline ${cu.size}), không có file mới.`,
  );
  if (daSua.length > 0) {
    console.log(`   🎉 Đã sửa ${daSua.length} file — chạy --write để chốt mức thấp hơn.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv);
}
