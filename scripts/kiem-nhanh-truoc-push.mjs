#!/usr/bin/env node
// Kiểm NHANH trước khi push — chạy tại máy dev, không cần credential, không mạng.
//
//   npm run gate:truoc-push                    # đầy đủ (~3–4 phút, đảo strict chiếm gần hết)
//   npm run gate:truoc-push -- --khong-dao-strict   # bỏ đảo strict (~40 giây)
//
// VÌ SAO TỒN TẠI
//   Ngày 13/08/2026 một đợt tính năng cần 5 vòng sửa-push-chờ CI kéo 19 tiếng,
//   trong đó 3 vòng đỏ chỉ vì số đếm tài liệu — thứ máy đếm được. Lệnh này làm
//   hai việc để vòng đó không lặp lại:
//
//   1. TỰ CHỮA trước: sinh lại các con số/bản render mà máy sở hữu
//      (kiểm kê repo, docs views, số đếm trong tài liệu). Con người không bao
//      giờ phải làm phép cộng cho gate — đó là việc của generator.
//   2. Chạy TOÀN BỘ nhóm gate tĩnh hay vấp nhất, KHÔNG dừng ở lỗi đầu tiên —
//      cùng triết lý "một lượt phơi hết lỗi" với quality-gates trên CI.
//
//   Danh sách gate dưới đây là tập con TĨNH của job quality-gates trong
//   .github/workflows/ci-gates.yml (chừa lại các bước nặng: typecheck baseline,
//   eslint, build, vitest, timezone — CI vẫn canh đủ). Thêm gate mới vào CI thì
//   cân nhắc thêm vào đây nếu nó rẻ (<5 giây) và hay vấp.
//
// PHIÊN SONG SONG (viết lại 28/08/2026)
//   Working tree này thường chạy nhiều phiên agent cùng lúc. Bản cũ stage theo
//   delta `git status` toàn repo trước/sau Bước 1 ∪ mọi file bẩn dưới
//   docs/generated/ — nó vơ cả file phiên khác ghi trong cửa sổ 30-60s lẫn file
//   bẩn sẵn của họ vào staging của mình, vi phạm chính Contract §3/§11.3 mà nó
//   phục vụ. Bản này:
//     - mỗi generator KHAI SỞ HỮU (soHuu) tường minh; chỉ stage file thuộc sở
//       hữu VÀ đang khác INDEX (nên chạy hai lần liên tiếp vẫn stage đủ);
//     - generator kiểu `va-tay` (--fix vá số vào file người viết) chỉ stage
//       file có dòng DA_SUA của lượt này VÀ sạch trước khi Bước 1 chạy;
//     - chốt cuối đo bản INDEX (check-doc-counts --nguon-index) — đúng thứ CI
//       sẽ đọc sau commit, miễn nhiễm file bẩn dở của phiên khác;
//     - lock trong git-dir của worktree chặn hai phiên chạy đồng thời.
//
// Thoát 0 = sạch · 1 = có gate đỏ (chi tiết in ở phần tóm tắt).

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DANH_SACH_VIEW } from "./generate-docs-views.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Bước 1: máy sinh số — chạy TRƯỚC để gate phía dưới đo bản đã tươi ────────
// Mục có `mang: true` gọi ra ngoài (Supabase catalog / DB thật) — hỏng thì cảnh
// báo ⚠ chứ không chặn: offline không phải lỗi của code. Nhưng nếu bạn VỪA đổi
// schema/RPC thì phải chạy lại khi có mạng — CI sẽ đo bằng catalog live.
//
// Vì sao types + surface nằm đây (thêm 25/08/2026): mổ xẻ 17 lần CI đỏ từ
// 20–25/08 thì 12 lần do số đếm tài liệu, 8 lần do types.ts trôi, 3 lần do
// manifest bề mặt RPC trôi — toàn bộ là artifact MÁY SỞ HỮU mà quy trình lại
// bắt con người nhớ chạy đúng 5 lệnh đúng thứ tự. Từ nay một lệnh này làm hết.
//
// `soHuu`: file/tiền-tố (kết thúc `/`) mà generator này được phép tự stage.
// `kieu: "va-tay"`: file NGƯỜI viết, máy chỉ vá số — stage theo dòng DA_SUA.
// docs/generated/schema-change-evidence/ cố ý KHÔNG thuộc sở hữu của ai ở đây:
// biên nhận cặp đôi với MỘT migration cụ thể và phải đi cùng commit của
// migration đó (suýt tạo evidence mồ côi 25/08/2026).
const TYPES = "src/integrations/supabase/types.ts";
const TU_CHUA = [
  ["sinh types.ts từ DB thật (gen:types)", ["scripts/gen-supabase-types.mjs"], { mang: true, soHuu: [TYPES] }],
  ["chuẩn hoá types.ts (bỏ partition + ghim phiên bản nền tảng)", ["scripts/normalize-supabase-types.mjs", "--write"], { soHuu: [TYPES] }],
  ["sinh manifest bề mặt RPC", ["scripts/generate-rpc-surface.mjs"], { mang: true, soHuu: ["contracts/surfaces/rpc-surface.json"] }],
  ["sinh manifest bề mặt Edge", ["scripts/generate-edge-surface.mjs"], { mang: true, soHuu: ["contracts/surfaces/edge-function-surface.json"] }],
  ["sinh manifest bề mặt realtime", ["scripts/generate-realtime-surface.mjs"], { mang: true, soHuu: ["contracts/surfaces/realtime-surface.json"] }],
  ["sinh kiểm kê repo (JSON)", ["scripts/generate-repository-inventory.mjs", "--write"], { soHuu: ["docs/generated/repository-inventory.json"] }],
  ["sinh bản .md render từ manifest", ["scripts/generate-docs-views.mjs"], { soHuu: DANH_SACH_VIEW }],
  ["sửa số đếm trong tài liệu", ["scripts/check-doc-counts.mjs", "--fix"], { kieu: "va-tay" }],
  ["dán số baseline từ manifest vào README", ["scripts/check-baseline-doc.mjs", "--fix"], { kieu: "va-tay" }],
];

// ── Bước 2: gate tĩnh, thứ tự khớp ci-gates.yml để dễ đối chiếu ──────────────
const GATE_NHANH = [
  // contract-gates
  "check-agent-contract",
  "check-runtime-matrix",
  "check-known-gaps",
  "check-capability-surfaces",
  "check-route-permission-drift",
  "check-capability-docs",
  "check-baseline-doc",
  "check-route-guards",
  "check-test-matrix",
  "check-workflow-paths",
  "check-raw-rpc-callers",
  "check-realtime-query-keys",
  "check-evidence-store",
  "check-test-only-exports",
  "check-unknown-review",
  "check-ts-suppressions",
  "check-rpc-cast-ratchet",
  "check-rpc-in-view-ratchet",
  "check-error-swallow-ratchet",
  "check-money-table-dml",
  // schema-gates
  "check-migration-provenance",
  ["normalize-supabase-types", "--check"],
  "check-no-auto-apply",
  "check-management-api-writes",
  "check-promote-readiness",
  "check-migration-test-liveness",
  // docs-freshness (số đã được bước 1 chữa; ở đây chỉ còn xác nhận)
  "check-copilot-docs-manifest",
  "check-copilot-routes",
  "check-copilot-tool-inventory",
  "check-doc-counts",
  "check-doc-freshness",
  ["generate-docs-views", "--check"],
  // nợ strict mới
  "check-new-modules-strict",
];

// Đảo strict gọi tsc hai lượt (~2–3 phút) — tách riêng để `--khong-dao-strict`
// còn đường chạy 40 giây khi chỉ sửa docs/script.
const GATE_NANG = ["check-strict-islands"];

const chay = (args) => spawnSync("node", args.map((a, i) => (i === 0 ? join(repoRoot, a) : a)), {
  cwd: repoRoot,
  encoding: "utf8",
});

const goiGit = (args) =>
  (spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" }).stdout ?? "")
    .split("\n")
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, "/"));

/** File tracked đang khác index + file mới chưa add, GIỚI HẠN trong `paths`. */
const dangKhacIndexTrong = (paths) => {
  if (paths.length === 0) return [];
  return [
    ...goiGit(["diff", "--name-only", "--", ...paths]),
    ...goiGit(["ls-files", "--others", "--exclude-standard", "--", ...paths]),
  ];
};

/** `file` có thuộc danh sách sở hữu không — khớp đích danh, hoặc tiền tố kết thúc `/`. */
export const thuocSoHuu = (file, soHuu) =>
  soHuu.some((s) => (s.endsWith("/") ? file.startsWith(s) : file === s));

/** Rút danh sách file từ các dòng `DA_SUA <path>` mà generator va-tay in ra. */
export const layDaSua = (stdout) =>
  [...String(stdout ?? "").matchAll(/^DA_SUA (.+)$/gm)].map((m) => m[1].trim().replace(/\\/g, "/"));

/**
 * Tập file được phép tự stage. Thuần để test không đụng git.
 *
 * @param cacMuc [{ten, kieu: "may"|"va-tay", soHuu, thanhCong, daSua}]
 * @param dangKhacIndex Set — file đang khác index (chỉ cần phủ vùng soHuu)
 * @param banTruoc Set — file đã bẩn TRƯỚC khi Bước 1 chạy
 */
export function tinhTapStage(cacMuc, dangKhacIndex, banTruoc) {
  const stage = new Set();
  const boQua = [];
  for (const m of cacMuc) {
    if (!m.thanhCong) continue;
    if (m.kieu === "va-tay") {
      for (const f of m.daSua ?? []) {
        if (banTruoc.has(f)) boQua.push({ file: f, ten: m.ten });
        else stage.add(f);
      }
    } else {
      for (const f of dangKhacIndex) {
        if (thuocSoHuu(f, m.soHuu ?? [])) stage.add(f);
      }
    }
  }
  return { stage: [...stage].sort(), boQua };
}

/**
 * Lock đã tồn tại là "song" (phải chờ) hay "stale" (chiếm được)?
 * Stale khi: không đọc được, pid đã chết, hoặc quá hạn (gate không chạy quá
 * 20 phút — lâu hơn là xác treo của một phiên đã bị kill).
 */
export function danhGiaLock(lock, pidConSong, bayGioMs, hanMs = 20 * 60 * 1000) {
  if (!lock || typeof lock.pid !== "number" || typeof lock.batDauMs !== "number") return "stale";
  if (!pidConSong(lock.pid)) return "stale";
  if (bayGioMs - lock.batDauMs > hanMs) return "stale";
  return "song";
}

// ── Lock: một worktree một lượt gate — hai phiên chạy đồng thời sẽ ghi đè
// artifact của nhau giữa chừng rồi cùng stage sai. Lock nằm trong git-dir CỦA
// WORKTREE (rev-parse --absolute-git-dir) nên hai worktree khác nhau vẫn chạy
// song song được — đúng mô hình mỗi-hạng-mục-một-worktree của Contract §3.
function chiemLock() {
  const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: repoRoot, encoding: "utf8" })
    .stdout?.trim();
  if (!gitDir) return { loi: "không tìm được git-dir — đang đứng ngoài repo?" };
  const duong = join(gitDir, "gate-truoc-push.lock");
  const ghi = () => {
    const fd = openSync(duong, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, batDauMs: Date.now() }));
    closeSync(fd);
  };
  try {
    ghi();
    return { duong };
  } catch {
    let lock = null;
    try { lock = JSON.parse(readFileSync(duong, "utf8")); } catch { /* hỏng ⇒ stale */ }
    const pidConSong = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    if (danhGiaLock(lock, pidConSong, Date.now()) === "song") {
      return {
        loi:
          `phiên khác đang chạy gate:truoc-push (pid ${lock.pid}, từ ${new Date(lock.batDauMs).toISOString()}).\n` +
          `   Chờ nó xong rồi chạy lại. Lock: ${duong} — chỉ xoá tay khi chắc chắn phiên kia đã chết.`,
      };
    }
    try { unlinkSync(duong); ghi(); return { duong }; } catch (e) {
      return { loi: `không chiếm được lock (${e.message})` };
    }
  }
}

function main() {
  const boDaoStrict = process.argv.includes("--khong-dao-strict");
  const t0 = Date.now();

  const lock = chiemLock();
  if (lock.loi) {
    console.error(`❌ ${lock.loi}`);
    process.exitCode = 1;
    return;
  }
  const nhaLock = () => { try { unlinkSync(lock.duong); } catch { /* đã gỡ */ } };
  process.on("exit", nhaLock);
  process.on("SIGINT", () => { nhaLock(); process.exit(130); });

  try {
    console.log("── Bước 1/2: máy tự sinh số ──");
    // File đã bẩn TRƯỚC Bước 1 (so với index): --fix có vá số trên đó thì cũng
    // KHÔNG stage — có thể là sửa tay dở của phiên khác.
    const banTruoc = new Set(goiGit(["diff", "--name-only"]));
    const loiTuChua = [];
    const canhBaoMang = [];
    const ketQuaMuc = [];
    for (const [ten, args, tuyChon = {}] of TU_CHUA) {
      const r = chay(args);
      const thanhCong = r.status === 0;
      if (thanhCong) console.log(`  ✅ ${ten}`);
      else if (tuyChon.mang) {
        canhBaoMang.push([ten, tuyChon]);
        console.log(`  ⚠ ${ten} (exit ${r.status}) — cần mạng/PAT; nếu bạn vừa đổi schema/RPC thì PHẢI chạy lại khi có mạng`);
      } else {
        loiTuChua.push([ten, r]);
        console.log(`  ❌ ${ten} (exit ${r.status})`);
      }
      ketQuaMuc.push({
        ten,
        kieu: tuyChon.kieu ?? "may",
        soHuu: tuyChon.soHuu ?? [],
        thanhCong,
        daSua: thanhCong && tuyChon.kieu === "va-tay" ? layDaSua(r.stdout) : [],
      });
    }

    // TỰ STAGE theo ALLOWLIST SỞ HỮU, không chỉ nhắc.
    //
    // Bản trước-nữa in "NHỚ stage kèm commit" rồi phó mặc trí nhớ con người —
    // trí nhớ thua (4 commit fix(ci) đo 25/08 chỉ để dán lại thứ máy sinh).
    // Bản 25/08 tự stage nhưng theo delta git status toàn repo — vơ nhầm file
    // phiên khác (mổ xẻ 28/08). Bản này chỉ stage file THUỘC SỞ HỮU của
    // generator vừa chạy THÀNH CÔNG và đang khác INDEX.
    //
    // Thứ tự quan trọng: stage TRƯỚC Bước 2. check-doc-counts đếm bằng
    // `git ls-files` nên một file chưa `git add` sẽ không được tính — chạy gate
    // trước khi stage cho ra kết quả "khớp" GIẢ rồi CI đỏ.
    const soHuuMayOk = ketQuaMuc.filter((m) => m.thanhCong && m.kieu === "may").flatMap((m) => m.soHuu);
    const dangKhac = new Set(dangKhacIndexTrong([...new Set(soHuuMayOk)]));
    const { stage, boQua } = tinhTapStage(ketQuaMuc, dangKhac, banTruoc);

    for (const b of boQua) {
      console.log(`  ⚠ KHÔNG stage ${b.file} — file đang có sửa tay dở từ TRƯỚC (có thể phiên khác).`);
      console.log(`     Generator đã vá số trên đĩa; nếu file là của bạn thì tự stage phần số đếm.`);
    }
    if (stage.length > 0) {
      const add = spawnSync("git", ["add", "--", ...stage], { cwd: repoRoot, encoding: "utf8" });
      if (add.status === 0) {
        console.log(`  ✍ generator cập nhật ${stage.length} file thuộc sở hữu — ĐÃ tự \`git add\`:`);
      } else {
        console.log(`  ✍ generator cập nhật ${stage.length} file — KHÔNG tự stage được (${add.stderr?.trim() || "git lỗi"}), stage tay:`);
      }
      for (const f of stage) console.log(`      ${f}`);
    }

    // ── Chốt lỗ hổng "gate đọc working tree, CI đọc bản commit" ──────────────
    //
    // Án lệ 25/08/2026, run 32873960678: check-doc-counts --fix sửa số trong
    // docs ở máy, battery xanh — nhưng file đó bẩn dở từ phiên trước nên không
    // được stage, CI đọc bản commit vẫn số cũ → đỏ. Chốt này vì thế đo đúng
    // thứ CI sẽ thấy:
    //   (a) artifact máy-toàn-phần của generator đã chạy: phải KHÔNG còn khác
    //       index (tự stage ở trên phải vét sạch);
    //   (b) số đếm đọc từ INDEX phải khớp (check-doc-counts --nguon-index) —
    //       file va-tay bẩn của phiên khác không làm chốt này đỏ, vì bản index
    //       (thứ CI đọc) vẫn đúng.
    const conKhac = dangKhacIndexTrong([...new Set(soHuuMayOk)]);
    if (conKhac.length > 0) {
      console.log(`\n  ❌ ${conKhac.length} artifact máy sinh vẫn khác INDEX sau khi tự stage — bất thường, stage tay rồi chạy lại:`);
      for (const f of conKhac) console.log(`       git add ${f}`);
      process.exitCode = 1;
    }
    const rIndex = chay(["scripts/check-doc-counts.mjs", "--nguon-index"]);
    if (rIndex.status !== 0) {
      console.log("\n  ❌ Số đếm trong INDEX (bản CI sẽ đọc) chưa khớp:");
      if (rIndex.stdout?.trim()) console.log(rIndex.stdout.trim().replace(/^/gm, "     "));
      if (rIndex.stderr?.trim()) console.log(rIndex.stderr.trim().replace(/^/gm, "     "));
      console.log("     File nêu trên cần được stage phần số đếm (git add <file>, hoặc git add -p");
      console.log("     nếu file đang lẫn sửa tay dở của phiên khác) rồi chạy lại.");
      process.exitCode = 1;
    } else {
      console.log("  ✅ số đếm trong INDEX khớp — bản CI sẽ đọc là bản đúng");
    }
    for (const [ten, tuyChon] of canhBaoMang) {
      if (tuyChon.soHuu?.length) {
        console.log(`  ⚠ ${ten} chưa chạy được — artifact có thể cũ: ${tuyChon.soHuu.join(", ")}. PHẢI chạy lại khi có mạng.`);
      }
    }

    console.log(`\n── Bước 2/2: gate tĩnh (${boDaoStrict ? "bỏ" : "kèm"} đảo strict) ──`);
    const doSo = [];
    const danhSach = boDaoStrict ? GATE_NHANH : [...GATE_NHANH, ...GATE_NANG];
    for (const muc of danhSach) {
      const args = Array.isArray(muc) ? muc : [muc];
      const ten = args.join(" ");
      const r = chay([`scripts/${args[0]}.mjs`, ...args.slice(1)]);
      if (r.status === 0) {
        console.log(`  ✅ ${ten}`);
      } else {
        // exit 3 = "không kiểm được" (thiếu tiền đề) — tin KHÁC "kiểm rồi thấy vi
        // phạm", in nhãn riêng nhưng vẫn tính là chưa sạch: chưa nhìn thấy thì
        // chưa được coi là đạt (Contract §3).
        console.log(`  ${r.status === 3 ? "⚠" : "❌"} ${ten} (exit ${r.status})`);
        doSo.push([ten, r]);
      }
    }

    const giay = Math.round((Date.now() - t0) / 1000);
    if (doSo.length === 0 && loiTuChua.length === 0 && process.exitCode !== 1) {
      console.log(`\n✅ Sạch — ${danhSach.length} gate xanh trong ${giay}s. Push được.`);
      return;
    }

    console.log(`\n❌ ${doSo.length + loiTuChua.length} mục chưa sạch (${giay}s). Output từng mục:`);
    for (const [ten, r] of [...loiTuChua, ...doSo]) {
      console.log(`\n───── ${ten} ─────`);
      if (r.stdout?.trim()) console.log(r.stdout.trim());
      if (r.stderr?.trim()) console.log(r.stderr.trim());
    }
    process.exitCode = 1;
  } finally {
    nhaLock();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
