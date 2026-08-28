#!/usr/bin/env node
// Gate: con số trong tài liệu phải khớp thực tế đếm được.
//
// VÌ SAO CẦN
//   Tài liệu chép tay con số thì con số sẽ trôi, và không gì báo. Repo này có án
//   lệ đủ để không phải tranh luận:
//     - "371 migration" lặp ở 3 file trong khi thực tế đã 625 — lệch 254 file,
//       CI vẫn xanh suốt.
//     - Sau khi sửa thành 625 thì hai tuần sau thực tế là 627. Trôi tiếp.
//     - AGENTS.md ghi ratchet TypeScript "hiện 30" trong khi số thật là 26.
//   Trớ trêu nhất: chính dòng ghi "625 file" cũng ghi kèm "số đếm sinh bằng
//   script, đừng chép tay" — lời dặn đúng, đặt ngay cạnh con số chép tay.
//
//   Con số sai trong tài liệu không làm test nào đỏ, không làm build nào hỏng.
//   Nó chỉ làm người đọc tin sai — và với tài liệu kiến trúc thì đó là toàn bộ
//   công dụng của nó.
//
//   node scripts/check-doc-counts.mjs
//   node scripts/check-doc-counts.mjs --fix   # ghi lại số đúng vào tài liệu
//
// Không cần credential, không đọc database.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { docTuIndex, lietKeTracked, lietKeUntracked } from "./lib/git-scope.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Đếm file .sql từ một DANH SÁCH đường dẫn (đệ quy tự nhiên vì ls-files trả
 * đường dẫn đầy đủ), KHÔNG phân biệt hoa/thường — một file `.SQL` vẫn là
 * migration (đo 07/08/2026, cùng lớp lỗi `relkind='i'` bỏ sót 'I'). Tách thuần
 * để test không cần đụng git.
 */
export const demSqlTuDanhSach = (paths, dir) => {
  const tienTo = `${dir.replace(/\\/g, "/")}/`;
  return paths.filter((p) => p.replace(/\\/g, "/").startsWith(tienTo) && /\.sql$/i.test(p)).length;
};

/**
 * Đếm từ INDEX chứ không quét đĩa (28/08/2026). Bản cũ readdirSync đếm cả file
 * .sql untracked — WIP của phiên song song — nên `--fix` từng ghi 709 vào docs
 * trong khi CI (đọc cây commit) chỉ thấy 707 → đỏ (án lệ c9f3937f, chữa tay
 * bằng worktree sạch; đây là bản mã hoá). Con số phải TÁI LẬP ĐƯỢC từ commit —
 * cùng triết lý với demTracked ngay dưới.
 */
const demSql = (dir) => demSqlTuDanhSach(lietKeTracked([dir]), dir);

/**
 * Đếm file ĐÃ ĐƯỢC GIT TRACK khớp một mẫu.
 *
 * Dùng `git ls-files` chứ không duyệt đĩa: thư mục làm việc có build output, file
 * tạm và file chưa add: đếm chúng sẽ ra một con số không ai khác tái lập được, mà
 * tái lập được mới là điểm của cả gate này.
 */
const demTracked = (re, boQua = []) =>
  execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((p) => p && re.test(p) && !boQua.some((x) => x.test(p))).length;

/**
 * Nhóm migration TRÙNG SỐ VERSION từ một danh sách đường dẫn — chỉ xét file
 * NGAY TRONG supabase/migrations (không xuống thư mục con), giữ đúng phạm vi
 * của bộ đếm cũ. Tách thuần để test không cần đụng git.
 */
export const demTrungVersionTuDanhSach = (paths) => {
  const dem = new Map();
  for (const p of paths) {
    const m = /^supabase\/migrations\/([^/]+)$/.exec(p.replace(/\\/g, "/"));
    if (!m || !/\.sql$/i.test(m[1])) continue;
    const v = /^(\d+)/.exec(m[1])?.[1];
    if (v) dem.set(v, (dem.get(v) ?? 0) + 1);
  }
  const trung = [...dem.values()].filter((n) => n > 1);
  return { soNhom: trung.length, soFile: trung.reduce((a, n) => a + n, 0) };
};

/**
 * Đếm từ INDEX (28/08/2026) — cùng lý do với demSql: số ghi vào tài liệu phải
 * tái lập được từ commit. Cái chặn `supabase db push` đúng là tên file trên
 * ĐĨA, nên nhóm trùng chỉ-tồn-tại-nhờ-file-untracked được cảnh báo RIÊNG trong
 * main() thay vì lặng lẽ đổi con số của docs theo WIP của phiên khác.
 */
const demTrungVersion = () => demTrungVersionTuDanhSach(lietKeTracked(["supabase/migrations"]));

/**
 * Mỗi mục là một con số tài liệu ĐANG khẳng định, kèm cách đếm ra sự thật.
 *
 * Cố ý khai tường minh từng chỗ thay vì dò mọi con số trong docs: dò mù sẽ đầy
 * báo động giả (số phiên bản, số tiền, số dòng code trích dẫn), và một gate hay
 * báo sai sẽ bị tắt.
 */
export const CLAIMS = [
  {
    file: "supabase/README.md",
    // "… — 625 file hiện có gồm 33 nhóm trùng version …"
    re: /(\b)(\d{3,4})( file hiện có)/,
    dem: () => demSql("supabase/migrations"),
    moTa: "số file trong supabase/migrations",
  },
  {
    file: "docs/DATABASE_SCHEMA.md",
    // "Repository hiện có 625 file trong …"
    re: /(hiện có\s+)(\d{3,4})(\s+file)/,
    dem: () => demSql("supabase/migrations"),
    moTa: "số file trong supabase/migrations",
  },
  {
    file: "docs/CODEBASE_STRUCTURE.md",
    // "(625 file + 15 trong `migrations-archive/`)"
    re: /(\()(\d{3,4})( file \+ )/,
    dem: () => demSql("supabase/migrations"),
    moTa: "số file trong supabase/migrations",
  },
  {
    file: "docs/CODEBASE_STRUCTURE.md",
    re: /( file \+ )(\d{1,3})( trong)/,
    dem: () => demSql("supabase/migrations-archive"),
    moTa: "số file trong supabase/migrations-archive",
  },

  // ── Bốn con số thêm 11/08/2026 khi mở rộng CODEBASE_STRUCTURE ────────────
  //
  // Chính tài liệu đó nay mở đầu bằng câu "mọi con số ở đây đếm được và có gate
  // canh". Thêm số mà không thêm mục ở đây thì câu ấy thành lời hứa suông —
  // và một lời hứa suông trong tài liệu định hướng còn tệ hơn không hứa gì.
  {
    file: "docs/CODEBASE_STRUCTURE.md",
    // "| `.e2e-fleet/**` | 44 spec Playwright |"
    re: /(`\.e2e-fleet\/\*\*` \| )(\d{1,3})( spec)/,
    dem: () => demTracked(/^\.e2e-fleet\/specs\/.*\.spec\.ts$/),
    moTa: "số spec Playwright trong .e2e-fleet/specs",
  },
  {
    file: "docs/CODEBASE_STRUCTURE.md",
    // "| `contracts/**` | 13 file hợp đồng |"
    re: /(`contracts\/\*\*` \| )(\d{1,3})( file)/,
    dem: () => demTracked(/^contracts\//),
    moTa: "số file trong contracts/",
  },
  {
    file: "docs/CODEBASE_STRUCTURE.md",
    // "- Route/gate: `src/app/routes/**` (11 file theo domain…"
    re: /(`src\/app\/routes\/\*\*` \()(\d{1,3})( file theo domain)/,
    dem: () => demTracked(/^src\/app\/routes\/[^/]+\.tsx$/),
    moTa: "số file route trong src/app/routes",
  },
  {
    file: "docs/CODEBASE_STRUCTURE.md",
    // "…chạy chung một lệnh: 9 suite, mỗi suite một runner…"
    re: /(một lệnh: )(\d{1,3})( suite, mỗi suite một runner)/,
    dem: () => JSON.parse(readFileSync(join(repoRoot, "tooling/test-matrix.json"), "utf8")).suites.length,
    moTa: "số suite trong tooling/test-matrix.json",
  },

  // ── PROJECT_CONTRACT.md §1 và §5 ──────────────────────────────────────────
  //
  // Ba con số thêm 11/08/2026, và cả ba ĐANG SAI lúc thêm: Contract ghi "625
  // migration" và "625 file có 33 nhóm trùng version (69 file)" trong khi thực tế
  // là 633 / 36 / 77.
  //
  // Chỗ chúng nằm mới là điều đáng nói: ngay trong LUẬT migration của Contract —
  // nơi người ta đọc để quyết định có tin manifest hay không, và để hiểu vì sao
  // legacy history không replay được. Một con số sai ở đó làm hỏng chính lập luận
  // mà nó được đưa ra để chống đỡ. Đúng án lệ "371 migration" nằm trong ba tài
  // liệu suốt nhiều tuần, lặp lại ở tầng cao hơn.
  {
    file: "docs/engineering/PROJECT_CONTRACT.md",
    // "Supabase PostgreSQL 17.6: 633 migration, ~1000 hàm SECURITY DEFINER"
    re: /(17\.6: )(\d{3,4})( migration)/,
    dem: () => demSql("supabase/migrations"),
    moTa: "số migration ở Contract §1",
  },
  {
    file: "docs/engineering/PROJECT_CONTRACT.md",
    // "633 file có 36 nhóm trùng version (77 file)"
    re: /(\n\s*)(\d{3,4})( file có \d{1,3} nhóm trùng version)/,
    dem: () => demSql("supabase/migrations"),
    moTa: "số file migration ở Contract §5",
  },
  {
    file: "docs/engineering/PROJECT_CONTRACT.md",
    re: /( file có )(\d{1,3})( nhóm trùng version)/,
    dem: () => demTrungVersion().soNhom,
    moTa: "số nhóm version trùng ở Contract §5",
  },
  {
    file: "docs/engineering/PROJECT_CONTRACT.md",
    re: /( nhóm trùng version \()(\d{1,3})( file\))/,
    dem: () => demTrungVersion().soFile,
    moTa: "số file dính version trùng ở Contract §5",
  },

  // ── docs/generated/repository-inventory.md ────────────────────────────────
  //
  // Bản .md này SINH RA từ JSON nên về lý thì không lệch được. Nhưng `--check`
  // của generate-docs-views chỉ chạy khi ai đó nhớ chạy nó, còn gate này chạy mọi
  // lúc — và con số "file test" là thứ trôi mỗi khi thêm một file test. Canh ở
  // đây bắt được trường hợp bản .md đã cũ so với repo, kể cả khi nó vẫn khớp JSON
  // (tức cả JSON lẫn .md cùng cũ — kiểu lệch mà phép so .md↔JSON không thấy).
  {
    file: "docs/generated/repository-inventory.md",
    // "- **479** file test, **150** file đọc file bằng fs"
    re: /(\*\*)(\d{3,4})(\*\* file test)/,
    dem: () => demTracked(/\.(test|spec)\.(ts|tsx|mjs|js|cjs)$/, [/node_modules/, /zalouser-bridge[\\/]upstream[\\/]/]),
    moTa: "số file test trong bản kiểm kê repo",
  },

  // ── migration-policy.json ────────────────────────────────────────────────
  // Bốn con số dưới đây từng trôi CÙNG LÚC và không gì báo: policy ghi "62/66
  // file unknown chỉ ALTER/DML" và "39 version trùng (88 file)" trong khi thực
  // tế là 55/65 và 40/90. Con số sai nằm trong chính file LUẬT của migration —
  // tức nơi người ta tra để quyết định có tin manifest hay không.
  //
  // Chúng đếm từ manifest (sinh bằng máy) chứ không từ repo, nên khi manifest
  // được sinh lại sau mỗi lần apply migration thì các số này tự lệch ngay —
  // đó chính là lúc cần đỏ.
  {
    file: "supabase/migration-policy.json",
    re: /(")(\d{1,3})(\/\d{1,3} file unknown là file CHỈ ALTER)/,
    dem: () => demUnknown().chiAlter,
    moTa: "số file unknown chỉ ALTER/DML",
  },
  {
    file: "supabase/migration-policy.json",
    re: /(\d{1,3}\/)(\d{1,3})( file unknown là file CHỈ ALTER)/,
    dem: () => demUnknown().tong,
    moTa: "tổng số file unknown",
  },
  {
    file: "supabase/migration-policy.json",
    re: /(")(\d{1,3})( file unknown còn lại thì NGƯỢC LẠI)/,
    dem: () => demUnknown().coCreate,
    moTa: "số file unknown có CREATE nhưng object thiếu",
  },
  {
    file: "supabase/migration-policy.json",
    re: /(")(\d{1,3})( version bị trùng)/,
    dem: () => demTrung().soVersion,
    moTa: "số version bị trùng",
  },
  {
    file: "supabase/migration-policy.json",
    re: /( version bị trùng \()(\d{1,3})( file\))/,
    dem: () => demTrung().soFile,
    moTa: "số file dính version trùng",
  },
];

// Bật bởi --nguon-index: đọc tài liệu VÀ manifest từ INDEX thay vì đĩa — đo
// đúng thứ CI sẽ thấy sau commit, miễn nhiễm file đang bẩn dở trên đĩa (của
// phiên này lẫn phiên khác). Đây là chế độ mà kiem-nhanh-truoc-push dùng làm
// chốt cuối trước push.
let nguonIndex = false;

/** Đọc manifest provenance (artifact sinh bằng máy) — nguồn sự thật cho các số trên. */
const docManifest = () =>
  JSON.parse(
    (nguonIndex ? docTuIndex("supabase/migration-provenance.json") : null) ??
      readFileSync(join(repoRoot, "supabase", "migration-provenance.json"), "utf8"),
  );

/**
 * Tách nhóm file `unknown`.
 *
 * `missingObjects` của một file chỉ-ALTER chứa câu giải thích chứ không phải tên
 * object, nên phân biệt bằng tiền tố `<loại>:` — đúng dạng bộ sinh ghi ra
 * (`policy:…`, `function:…`). Đừng khớp theo nội dung câu tiếng Việt: nó đã đổi
 * chữ một lần và làm phép đo âm thầm sai.
 */
export function demUnknown(manifest = docManifest()) {
  const unk = manifest.entries.filter((e) => e.state === "unknown");
  const coLoai = /^(policy|function|index|trigger|table|view):/;
  const coCreate = unk.filter((e) => (e.missingObjects ?? []).some((x) => coLoai.test(x)));
  return { tong: unk.length, coCreate: coCreate.length, chiAlter: unk.length - coCreate.length };
}

export function demTrung(manifest = docManifest()) {
  const theoVersion = new Map();
  for (const e of manifest.entries) {
    theoVersion.set(e.version, (theoVersion.get(e.version) ?? 0) + 1);
  }
  const trung = [...theoVersion.values()].filter((n) => n > 1);
  return { soVersion: trung.length, soFile: trung.reduce((a, b) => a + b, 0) };
}

export function kiemTra(doc, claim) {
  const m = claim.re.exec(doc);
  if (!m) return { trangThai: "khong-tim-thay" };
  const khai = Number(m[2]);
  const that = claim.dem();
  return { trangThai: khai === that ? "khop" : "lech", khai, that, match: m };
}

function main(argv) {
  const fix = argv.includes("--fix");
  nguonIndex = argv.includes("--nguon-index");
  if (fix && nguonIndex) {
    console.error("❌ --fix không đi cùng --nguon-index: index không phải chỗ để ghi — sửa trên đĩa rồi `git add`.");
    process.exitCode = 1;
    return;
  }

  // Nhóm trùng version chỉ-tồn-tại-nhờ-file-untracked: không đổi số trong docs
  // (số phải tái lập từ commit), nhưng phải NÓI RA — cái chặn `db push` là tên
  // file trên đĩa, kể cả chưa add.
  const trungIndex = demTrungVersion();
  const trungCaDia = demTrungVersionTuDanhSach([
    ...lietKeTracked(["supabase/migrations"]),
    ...lietKeUntracked(["supabase/migrations"]),
  ]);
  if (trungCaDia.soNhom > trungIndex.soNhom) {
    console.warn(
      `⚠ ${trungCaDia.soNhom - trungIndex.soNhom} nhóm version trùng CHỈ xuất hiện khi tính cả file chưa add (WIP — có thể của phiên khác).`,
    );
    console.warn("  Số trong tài liệu vẫn đếm theo index; nhưng tên file trùng trên đĩa sẽ chặn `db push` — xử trước khi stage.");
  }

  const lech = [];
  const mat = [];
  let daSua = 0;
  const fileDaSua = new Set();

  for (const claim of CLAIMS) {
    const path = join(repoRoot, claim.file);
    if (!existsSync(path) && !nguonIndex) { mat.push(`${claim.file} (không tồn tại)`); continue; }
    let doc = nguonIndex ? docTuIndex(claim.file) : readFileSync(path, "utf8");
    if (doc == null) { mat.push(`${claim.file} (không có trong index)`); continue; }
    const r = kiemTra(doc, claim);

    if (r.trangThai === "khong-tim-thay") {
      // Không tìm thấy chỗ khai nghĩa là câu văn đã đổi — gate mất điểm neo và
      // từ đó im lặng mãi mãi. Phải ĐỎ, không được bỏ qua.
      mat.push(`${claim.file}: không còn khớp mẫu cho "${claim.moTa}"`);
      continue;
    }
    if (r.trangThai === "khop") continue;

    if (fix) {
      doc = doc.replace(claim.re, `$1${r.that}$3`);
      writeFileSync(path, doc);
      daSua += 1;
      fileDaSua.add(claim.file);
      console.log(`  sửa ${claim.file}: ${claim.moTa} ${r.khai} → ${r.that}`);
    } else {
      lech.push(`${claim.file}: ${claim.moTa} ghi ${r.khai}, thực tế ${r.that}`);
    }
  }

  // Dòng máy-đọc-được cho kiem-nhanh-truoc-push: nó chỉ được stage đúng những
  // file mà --fix của LƯỢT NÀY vừa vá — không vơ file bẩn sẵn của phiên khác.
  if (fix) for (const f of [...fileDaSua].sort()) console.log(`DA_SUA ${f}`);

  if (mat.length > 0) {
    console.error(`❌ ${mat.length} chỗ neo bị mất — gate không còn kiểm được:\n`);
    for (const m of mat) console.error(`  - ${m}`);
    console.error("\n  Sửa mẫu regex trong scripts/check-doc-counts.mjs cho khớp câu văn mới.");
    console.error("  ĐỪNG xoá mục đi: mất neo nghĩa là con số đó quay lại trạng thái không ai canh.");
    process.exitCode = 1;
    return;
  }

  if (lech.length > 0) {
    console.error(`❌ ${lech.length} con số trong tài liệu đã lệch thực tế:\n`);
    for (const l of lech) console.error(`  - ${l}`);
    console.error("\n  Chạy: node scripts/check-doc-counts.mjs --fix");
    process.exitCode = 1;
    return;
  }

  if (fix && daSua > 0) {
    console.log(`\n✅ Đã cập nhật ${daSua} con số.`);
    return;
  }
  console.log(`✅ ${CLAIMS.length} con số trong tài liệu khớp thực tế đếm được.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv);
}
