#!/usr/bin/env node
// Phân loại rủi ro một thay đổi: file nào đổi → tier nào → phải chạy gate nào.
//
// VÌ SAO CẦN (plan Đợt 2)
//   `tooling/risk-map.json` đã khai đủ 8 tier kèm gate bắt buộc, nhưng KHÔNG có gì
//   đọc nó. Một bảng luật không ai đọc thì chỉ là văn bản: người sửa `useInvoices.ts`
//   vẫn phải tự nhớ rằng đó là tier `money` và phải chạy `gate:reconcile-money` +
//   idempotency + concurrency. "Tự nhớ" là thứ hỏng đúng vào lúc bận nhất.
//
// ĐÂY LÀ BỘ BÁO CÁO, KHÔNG PHẢI CỬA CHẶN — và đó là quyết định, không phải thiếu sót
//   Nó trả lời "thay đổi này thuộc tier nào, cần gate nào". Nó KHÔNG kiểm được bạn
//   đã chạy các gate đó hay chưa: không có dấu vết nào trong repo để đọc. Một gate
//   giả vờ kiểm điều nó không kiểm được còn tệ hơn một báo cáo trung thực — nó tạo
//   cảm giác đã canh. Cưỡng chế thật nằm ở chính các gate được liệt kê.
//
//   node scripts/check-risk-classifier.mjs                     # so với origin/main
//   node scripts/check-risk-classifier.mjs --base <ref>
//   node scripts/check-risk-classifier.mjs --files a.ts,b.sql  # phân loại tay
//   node scripts/check-risk-classifier.mjs --json
//
// Thoát 0 · 3 khi KHÔNG XÁC ĐỊNH ĐƯỢC danh sách file (mốc hỏng, repo shallow).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAP = join(repoRoot, "tooling", "risk-map.json");

/**
 * Glob → RegExp. Chỉ ba ký tự đặc biệt, đúng những gì risk-map dùng.
 *
 * `**` phải xử TRƯỚC `*`, nếu không `**` bị hiểu thành hai lần `[^/]*` và
 * `src/hooks/income-expenses/**` sẽ không khớp file nằm sâu hai cấp.
 */
export function globSangRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` nuốt cả phần rỗng, để `a/**/b` khớp cả `a/b`.
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

export function khopGlob(duong, glob) {
  return globSangRegex(glob).test(duong);
}

/**
 * Xếp file vào tier. Thứ tự KHAI trong risk-map.json chính là thứ tự nghiêm ngặt
 * (money nghiêm nhất → docs nhẹ nhất) — `notes` của chính file đó nói "lấy tier
 * NGHIÊM NHẤT khớp được", nên vòng lặp dừng ở tier đầu tiên khớp.
 */
export function xepTier(duong, tiers) {
  for (const [ten, t] of Object.entries(tiers)) {
    if ((t.paths ?? []).some((g) => khopGlob(duong, g))) return ten;
  }
  return null;
}

export function phanLoai(files, tiers) {
  const theoTier = new Map();
  const khongTier = [];
  for (const f of files) {
    const t = xepTier(f, tiers);
    if (!t) {
      khongTier.push(f);
      continue;
    }
    if (!theoTier.has(t)) theoTier.set(t, []);
    theoTier.get(t).push(f);
  }
  const thuTu = Object.keys(tiers);
  const nghiemNhat = thuTu.find((t) => theoTier.has(t)) ?? null;
  const gates = [...new Set([...theoTier.keys()].flatMap((t) => tiers[t].gates ?? []))];
  const crossReview = [...theoTier.keys()].some((t) => tiers[t].crossReview === true);
  return { theoTier, khongTier, nghiemNhat, gates, crossReview };
}

const git = (a) => execFileSync("git", a, { cwd: repoRoot, encoding: "utf8" }).trim();

const tach = (s) =>
  s
    .split(/\r?\n/)
    .filter(Boolean)
    .map((x) => x.replace(/\\/g, "/"));

/**
 * Chọn mốc so sánh, và NÓI RA đã chọn cái gì.
 *
 * ĐIỂM MÙ ĐÃ ĐO 11/08/2026 — vì sao phải có nhánh dự phòng:
 *   Bản đầu luôn lấy `merge-base(origin/main, HEAD)`. Trên một PR thì đúng. Nhưng
 *   trên PUSH VÀO MAIN, origin/main CHÍNH LÀ HEAD, nên merge-base = HEAD và diff
 *   luôn rỗng. Gate vẫn chạy trong ci-gates mỗi lần push và in "0 file đổi — không
 *   có gì để phân loại" một cách vui vẻ. Nó chạy, nó xanh, và nó chưa từng phân
 *   loại một thay đổi nào trên main.
 *
 *   Đó là kiểu hỏng tệ nhất: không phải gate thiếu, mà là gate CÓ và báo sai.
 *
 * Thứ tự: --files → --staged → --base → merge-base với origin/main → HEAD~1.
 */
export function chonMoc(argv, coRef, diff) {
  const iB = argv.indexOf("--base");
  if (iB >= 0) {
    const r = argv[iB + 1];
    return coRef(r) ? { nhan: `--base ${r}`, files: diff(`${r}..HEAD`) } : null;
  }

  const goc = coRef("origin/main") ? "origin/main" : coRef("main") ? "main" : null;
  if (goc) {
    const base = diff.mergeBase(goc);
    // Chỉ dùng khi HEAD THẬT SỰ tách khỏi mốc. base === HEAD nghĩa là không tách,
    // và khi đó phép so này không nói gì về thay đổi vừa đưa vào.
    if (base && base !== diff.head()) return { nhan: `merge-base ${goc}`, files: diff(`${base}..HEAD`) };
  }

  // Dự phòng: so với commit ngay trước. Đây là câu trả lời đúng cho "vừa push cái
  // gì lên main", và nó chỉ vô nghĩa khi HEAD là commit đầu tiên của repo.
  if (coRef("HEAD~1")) return { nhan: "HEAD~1 (không tách khỏi mốc chung)", files: diff("HEAD~1..HEAD") };
  return null;
}

function layFile(argv) {
  const iF = argv.indexOf("--files");
  if (iF >= 0) {
    return {
      nhan: "--files",
      files: argv[iF + 1]
        .split(",")
        .map((s) => s.trim().replace(/\\/g, "/"))
        .filter(Boolean),
    };
  }

  // `--staged`: phân loại thứ ĐANG SỬA, kể cả chưa commit. Đây là lúc người ta
  // thật sự cần biết phải chạy gate nào — hỏi sau khi đã commit thì muộn rồi.
  if (argv.includes("--staged")) {
    const daTheoDoi = tach(git(["diff", "--name-only", "HEAD"]));
    const chuaTheoDoi = tach(git(["ls-files", "--others", "--exclude-standard"]));
    return { nhan: "cây làm việc (--staged)", files: [...new Set([...daTheoDoi, ...chuaTheoDoi])] };
  }

  if (git(["rev-parse", "--is-shallow-repository"]) === "true") return null;

  const coRef = (r) => {
    try {
      git(["rev-parse", "--verify", r]);
      return true;
    } catch {
      return false;
    }
  };
  const diff = (range) => tach(git(["diff", "--name-only", range]));
  diff.mergeBase = (r) => {
    try {
      return git(["merge-base", r, "HEAD"]);
    } catch {
      return null;
    }
  };
  diff.head = () => git(["rev-parse", "HEAD"]);

  return chonMoc(argv, coRef, diff);
}

function main() {
  if (!existsSync(MAP)) {
    console.error("❌ Thiếu tooling/risk-map.json — không có bảng luật để tra.");
    process.exit(3);
  }
  const { tiers, notes } = JSON.parse(readFileSync(MAP, "utf8"));
  const nguon = layFile(process.argv);

  if (nguon === null) {
    console.error("❌ Không xác định được danh sách file đổi (repo shallow hoặc mốc không phân giải được).");
    console.error("   KHÔNG KIỂM ĐƯỢC — đừng đọc thành 'thay đổi này không đụng tier nào'.");
    console.error("   Dùng --base <ref>, --files a.ts,b.sql, hoặc --staged cho cây làm việc.");
    process.exit(3);
  }
  const { files, nhan } = nguon;

  const kq = phanLoai(files, tiers);

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          soFile: files.length,
          nghiemNhat: kq.nghiemNhat,
          crossReview: kq.crossReview,
          gates: kq.gates,
          theoTier: Object.fromEntries(kq.theoTier),
          khongTier: kq.khongTier,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Phân loại rủi ro: ${files.length} file đổi  [mốc: ${nhan}]`);
  if (files.length === 0) {
    // In mốc đã dùng, vì "0 file" gần như luôn là dấu hiệu chọn sai mốc chứ không
    // phải một thay đổi rỗng. Trước 11/08/2026 dòng này chỉ nói "không có gì để
    // phân loại" — nghe như đã kiểm và sạch.
    console.log("  Không có file nào TRONG MỐC NÀY — đây không phải kết luận 'thay đổi này an toàn'.");
    console.log("  Nếu bạn đang sửa mà chưa commit, chạy lại với --staged.");
    return;
  }

  for (const [ten, ds] of kq.theoTier) {
    const t = tiers[ten];
    console.log(`\n▸ ${ten} — ${t.label}${t.crossReview ? "  [cần soi chéo]" : ""}  (${ds.length} file)`);
    for (const f of ds.slice(0, 6)) console.log(`    ${f}`);
    if (ds.length > 6) console.log(`    … còn ${ds.length - 6}`);
    console.log(`    vì sao: ${t.why}`);
  }

  if (kq.khongTier.length) {
    console.log(`\n▸ không thuộc tier nào (${kq.khongTier.length} file)`);
    for (const f of kq.khongTier.slice(0, 6)) console.log(`    ${f}`);
    if (kq.khongTier.length > 6) console.log(`    … còn ${kq.khongTier.length - 6}`);
  }

  if (kq.nghiemNhat) {
    console.log(`\nTier NGHIÊM NHẤT: ${kq.nghiemNhat}`);
    console.log(`Gate bắt buộc cho thay đổi này (${kq.gates.length}):`);
    for (const g of kq.gates) console.log(`   - ${g}`);
    if (kq.crossReview) {
      console.log("\n⚠ Tier này đòi SOI CHÉO: một agent thứ hai soi độc lập trước khi promote.");
      console.log("   " + String(notes?.[1] ?? "").slice(0, 160));
    }
  } else {
    console.log("\nKhông file nào thuộc tier có gate bắt buộc.");
  }

  console.log("\nCHƯA KIỂM: bạn ĐÃ CHẠY các gate trên hay chưa — không có dấu vết nào trong repo để đọc.");
  console.log("Đây là bộ BÁO CÁO, không phải cửa chặn. Cưỡng chế nằm ở chính các gate được liệt kê.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
