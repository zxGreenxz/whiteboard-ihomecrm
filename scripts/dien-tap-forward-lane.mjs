#!/usr/bin/env node
// Replay FORWARD LANE (mọi migration > cutoff) lên đích diễn tập vừa khôi phục
// baseline, rồi đối chiếu với SỔ KỲ VỌNG — hai chiều, khớp cả thông điệp.
//
// VÌ SAO "APPLY SẠCH 100%" KHÔNG PHẢI TIÊU CHÍ
//   Baseline là SCHEMA-ONLY (manifest ghi containsData: false), còn nhiều
//   migration của repo này KHẲNG ĐỊNH TRÊN DỮ LIỆU THẬT trước khi dám chạy:
//   "Chỉ xoá được 0 dòng — quá ít so với 165.548", "Không có người dùng thường
//   nào để nghiệm thu. DỪNG." Trên database rỗng, DỪNG là chúng làm ĐÚNG việc;
//   ép chúng xanh là tự tạo một phép kiểm không bao giờ xanh, hoặc tệ hơn —
//   seed dữ liệu giả cho qua, tức làm mù chính chốt đo của migration.
//
//   Tiêu chí đúng (đo 13/08/2026, 39 file): SỐ LỖI SCHEMA THẬT = 0. File nào
//   dừng-vì-dữ-liệu hay chết-theo (cascade) thì khai trong
//   supabase/baseline/forward-lane-expectations.json kèm why + thông điệp.
//
// VÌ SAO ĐỐI CHIẾU HAI CHIỀU VÀ KHỚP THÔNG ĐIỆP
//   · File có entry mà CHẠY SẠCH → đỏ. Nghĩa là môi trường diễn tập vừa "dễ
//     hơn thực tế" (ai đó seed dữ liệu?) hoặc entry đã thối. Cả hai đáng biết.
//   · File dừng nhưng SAI thông điệp → đỏ. Một file dung-vi-du-lieu chết vì
//     lý do KHÁC (lỗi schema mới) mà chỉ so "có lỗi/không" thì lỗi mới được
//     entry cũ che mất — đúng lớp xanh-rỗng mà bài diễn tập sinh ra để chống.
//   · Entry mồ côi (không khớp file nào trên đĩa) → đỏ. Sổ đang nói về thứ
//     không tồn tại.
//
//   node scripts/dien-tap-forward-lane.mjs --dich "postgresql://…"
//   PSQL_DOCKER=<container> node scripts/dien-tap-forward-lane.mjs --dich "…"
//
// Chạy SAU dien-tap-khoi-phuc-baseline.mjs trên CÙNG đích. KHÔNG idempotent:
// replay lần hai trên cùng database sẽ khác kết quả (nhiều file đã có hiệu
// ứng) — muốn chạy lại thì khôi phục baseline lại từ đầu.
// Thoát: 0 = khớp sổ kỳ vọng · 1 = lệch · 3 = không kiểm được.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { giaiMoc } from "./check-forward-migration-idempotent.mjs";
import { chanProduction, coPsql, goiPsql } from "./lib/goi-psql-dich.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(repoRoot, "supabase", "migrations");
const POLICY = join(repoRoot, "supabase", "migration-policy.json");
const KY_VONG = join(repoRoot, "supabase", "baseline", "forward-lane-expectations.json");
const MANIFEST = join(repoRoot, "supabase", "baseline", "manifest.json");

/** Sàn chống rỗng: forward lane hiện 39 file — quét ra dưới mức này nghĩa là
 *  cutoff/glob hỏng chứ không phải lane teo lại, và "0 lệch" khi đó vô nghĩa. */
export const TOI_THIEU_FILE = 10;

export function docCutoff() {
  const p = JSON.parse(readFileSync(POLICY, "utf8"));
  return String(p.provisionalCutoff?.version ?? "");
}

/** Chỉ file .sql có version 14 chữ số SAU cutoff, theo thứ tự apply. */
export function chonFileForwardLane(tenTrenDia, cutoff) {
  return tenTrenDia
    .filter((t) => {
      const m = t.match(/^(\d{14})_.+\.sql$/);
      return Boolean(m) && m[1] > cutoff;
    })
    .sort();
}

function dauLoi(stderr) {
  const dong = String(stderr || "").split(/\r?\n/).find((l) => /ERROR|FATAL/.test(l));
  return (dong || String(stderr || "").trim().split(/\r?\n/)[0] || "(không có stderr)").slice(0, 220);
}

/**
 * Đối chiếu kết quả chạy với sổ kỳ vọng. Thuần tuý, không I/O — test được.
 * ketQua: [{ ten, ok, stderr }] theo thứ tự chạy.
 *
 * `phamVi` (28/08/2026): Set tên file thuộc diff của push đang kiểm; `null` =
 * strict toàn bộ (hành vi cũ). Drill kích hoạt bởi paths supabase/migrations/**
 * nên migration của phiên A thiếu entry từng làm PR của phiên B đỏ. Replay vẫn
 * TUẦN TỰ TOÀN BỘ (tính đúng của lane phụ thuộc chuỗi), chỉ phần đối chiếu là
 * scoped: lệch ở file NGOÀI phạm vi hạ xuống `LECH-NGOAI-PHAM-VI` — in đầy đủ
 * chi tiết nhưng không đánh trượt; mọi chiều với file TRONG phạm vi giữ cứng.
 * Nợ cảnh báo tích tụ được quét bởi run cron strict hàng tuần (xem workflow).
 *
 * Trả { dat, dong: [{ ten, trangThai, chiTiet? }] } với trangThai:
 *   'chay-sach' | 'dung-dung-ky-vong' | 'LECH' | 'LECH-NGOAI-PHAM-VI'.
 */
export function doiChieuKyVong(ketQua, kyVong, phamVi = null) {
  const dong = [];
  const daCham = new Set();
  const nhanLech = (ten) => (phamVi && !phamVi.has(ten) ? "LECH-NGOAI-PHAM-VI" : "LECH");
  for (const k of ketQua) {
    daCham.add(k.ten);
    const e = kyVong[k.ten];
    if (!e) {
      if (k.ok) dong.push({ ten: k.ten, trangThai: "chay-sach" });
      else
        dong.push({
          ten: k.ten,
          trangThai: nhanLech(k.ten),
          chiTiet: `LỖI mà không có trong sổ kỳ vọng — lỗi schema thật, hoặc khẳng định dữ liệu mới chưa được phân loại: ${dauLoi(k.stderr)}`,
        });
    } else if (k.ok) {
      dong.push({
        ten: k.ten,
        trangThai: nhanLech(k.ten),
        chiTiet: `sổ kỳ vọng nói phải DỪNG (${e.kyVong}) mà lại chạy sạch — môi trường diễn tập "dễ hơn thực tế", hoặc entry đã thối`,
      });
    } else if (!String(k.stderr || "").includes(e.thongDiep)) {
      dong.push({
        ten: k.ten,
        trangThai: nhanLech(k.ten),
        chiTiet: `dừng nhưng SAI thông điệp — kỳ vọng chứa "${e.thongDiep}", nhận: ${dauLoi(k.stderr)}`,
      });
    } else {
      dong.push({ ten: k.ten, trangThai: "dung-dung-ky-vong" });
    }
  }
  for (const ten of Object.keys(kyVong)) {
    if (!daCham.has(ten)) {
      dong.push({
        ten,
        trangThai: nhanLech(ten),
        chiTiet: "entry trong sổ kỳ vọng không khớp file nào sau cutoff trên đĩa — file đã bị đổi tên/xoá, hoặc entry gõ sai tên",
      });
    }
  }
  return { dat: dong.every((d) => d.trangThai !== "LECH"), dong };
}

function main(argv) {
  const dich = argv[argv.indexOf("--dich") + 1];
  if (!dich || !/^postgres(ql)?:\/\//.test(dich)) {
    console.error('Dùng: node scripts/dien-tap-forward-lane.mjs --dich "postgresql://…"');
    return 3;
  }
  if (!coPsql()) {
    console.error("❌ Không tìm thấy psql. Cài PostgreSQL client 17+, HOẶC đặt PSQL_DOCKER=<container>.");
    return 3;
  }
  for (const p of [POLICY, KY_VONG, MANIFEST]) {
    if (!existsSync(p)) {
      console.error(`❌ Thiếu ${p.replace(repoRoot, ".")} — không đối chiếu được.`);
      return 3;
    }
  }
  try {
    chanProduction(dich, MANIFEST);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    return 3;
  }

  const cutoff = docCutoff();
  if (!/^\d{14}$/.test(cutoff)) {
    console.error(`❌ Cutoff đọc từ migration-policy.json không hợp lệ: "${cutoff}"`);
    return 3;
  }
  const files = chonFileForwardLane(readdirSync(MIGRATIONS), cutoff);
  if (files.length < TOI_THIEU_FILE) {
    console.error(`❌ Chỉ quét ra ${files.length} file sau cutoff ${cutoff} (sàn ${TOI_THIEU_FILE}) — glob/cutoff hỏng, "0 lệch" lúc này vô nghĩa.`);
    return 3;
  }

  const kyVong = JSON.parse(readFileSync(KY_VONG, "utf8")).expectations ?? {};

  // --moc <ref>: đối chiếu CỨNG chỉ cho file thuộc diff moc..HEAD (28/08/2026)
  // — xem chú thích doiChieuKyVong. Replay vẫn tuần tự đủ. Dùng diff ĐẦY ĐỦ
  // (không --diff-filter=A): file bị xoá/đổi tên trong push này cũng thuộc
  // trách nhiệm của nó, entry mồ côi tương ứng phải cứng.
  const iMoc = argv.indexOf("--moc");
  let phamVi = null;
  if (iMoc >= 0) {
    const coRef = (r) => {
      try {
        execFileSync("git", ["rev-parse", "--verify", "-q", `${r}^{commit}`], {
          cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        });
        return true;
      } catch { return false; }
    };
    const moc = giaiMoc(argv[iMoc + 1] ?? "", coRef);
    if (moc.kieu === "scoped") {
      phamVi = new Set(
        execFileSync("git", ["diff", "--name-only", `${moc.moc}..HEAD`, "--", "supabase/migrations"], {
          cwd: repoRoot, encoding: "utf8",
        }).split("\n").filter(Boolean).map((p) => p.replace(/\\/g, "/").split("/").pop()),
      );
      console.log(`Đối chiếu CỨNG cho ${phamVi.size} file thuộc diff ${moc.moc}..HEAD; lệch ở file ngoài diff chỉ cảnh báo.`);
    } else {
      console.log(`⚠ --moc: ${moc.lyDo} — đối chiếu STRICT toàn bộ (chiều an toàn).`);
    }
  }

  console.log(`Replay forward lane: ${files.length} file sau cutoff ${cutoff}`);
  console.log(`  đích: ${dich.replace(/:[^:@/]+@/, ":***@")}\n`);

  const t0 = Date.now();
  const ketQua = [];
  for (const ten of files) {
    const r = goiPsql(["-d", dich, "-q", "-v", "ON_ERROR_STOP=1", "-f", join(MIGRATIONS, ten)], {
      encoding: "utf8",
      timeout: 5 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    });
    ketQua.push({ ten, ok: r.status === 0, stderr: String(r.stderr || "") });
  }

  const { dat, dong } = doiChieuKyVong(ketQua, kyVong, phamVi);
  const dem = { "chay-sach": 0, "dung-dung-ky-vong": 0, LECH: 0, "LECH-NGOAI-PHAM-VI": 0 };
  for (const d of dong) {
    dem[d.trangThai] += 1;
    if (d.trangThai === "LECH") console.error(`  ✗ ${d.ten}\n      ${d.chiTiet}`);
    // In ĐẦY ĐỦ chi tiết cho lệch ngoài phạm vi — hạ mức không có nghĩa là giấu.
    if (d.trangThai === "LECH-NGOAI-PHAM-VI") console.warn(`  ⚠ ${d.ten} (ngoài diff — không đánh trượt)\n      ${d.chiTiet}`);
  }
  console.log(
    `\n${Math.round((Date.now() - t0) / 1000)}s · ${dem["chay-sach"]} chạy sạch · ${dem["dung-dung-ky-vong"]} dừng đúng kỳ vọng · ${dem.LECH} LỆCH` +
      (phamVi ? ` · ${dem["LECH-NGOAI-PHAM-VI"]} lệch ngoài diff (cảnh báo — cron tuần sẽ quét strict)` : ""),
  );
  if (!dat) {
    console.error("\n❌ Forward lane LỆCH sổ kỳ vọng — xem từng dòng ✗ ở trên.");
    return 1;
  }
  console.log("✅ Forward lane khớp sổ kỳ vọng — 0 lỗi schema thật trên bản dựng lại từ baseline.");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
