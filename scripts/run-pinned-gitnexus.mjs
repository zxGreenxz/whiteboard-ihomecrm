#!/usr/bin/env node
// Cửa DUY NHẤT để gọi GitNexus. Không gọi `npx gitnexus` trực tiếp ở đâu khác.
//
// VÌ SAO CẦN WRAPPER
//   GitNexus là công cụ đọc toàn bộ mã nguồn rồi ghi ra chỉ mục mà agent tin
//   theo. Hai rủi ro phải chặn ngay từ đầu:
//
//   1. VERSION TRÔI. `npx gitnexus@latest` nghĩa là mỗi lần chạy có thể là một
//      công cụ khác, và một bản mới có thể đổi cách hiểu mã nguồn mà không ai
//      hay. Wrapper đọc version TỪ tooling/agent-tools.json, nên chỉ có đúng
//      một chỗ để đổi và việc đổi hiện ra trong diff.
//   2. CÔNG CỤ GHI ĐÈ HỢP ĐỒNG. `analyze` mặc định chèn một mục vào CLAUDE.md
//      và AGENTS.md. Hai file đó là hợp đồng agent của repo này; để công cụ tự
//      sửa chúng là để công cụ tự viết luật cho chính nó. Vì vậy
//      `--skip-agents-md` được ép vào mọi lần analyze, kể cả khi người gọi quên.
//
// FAIL-CLOSED: mọi subcommand trừ `smoke` bị từ chối khi pin chưa `verified`.
// `smoke` tồn tại chính là để verify — nó là con đường duy nhất đi từ
// blocked → verified, và nó ghi bằng chứng đo được vào agent-tools.json.
//
//   node scripts/run-pinned-gitnexus.mjs smoke     # verify pin, ghi bằng chứng
//   node scripts/run-pinned-gitnexus.mjs analyze   # index (tự thêm cờ bắt buộc)
//   node scripts/run-pinned-gitnexus.mjs status
//   node scripts/run-pinned-gitnexus.mjs mcp       # MCP server (stdio)
//
// Không cần credential, không đọc database.

import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PIN = join(repoRoot, "tooling", "agent-tools.json");

/**
 * Subcommand truy vấn graph — chúng nhận `-r, --repo` và mặc định đoán repo từ
 * registry toàn cục, nên PHẢI được chỉ đích danh. Đã đối chiếu với `--help` của
 * gitnexus 1.6.9 ngày 08/08/2026.
 *
 * KHÔNG gồm: analyze/index/status/mcp/smoke/doctor/list — chúng làm việc theo thư
 * mục hiện hành hoặc không có khái niệm repo đích.
 */
export const SUB_CAN_REPO = new Set([
  "query",
  "context",
  "impact",
  "trace",
  "cypher",
  "detect-changes",
  "detect_changes",
  "check",
  "wiki",
  "augment",
]);
const INDEX_DIR = join(repoRoot, ".gitnexus");
const MANIFEST = join(INDEX_DIR, "manifest.json");

/** `npx` trên Windows là npx.cmd; Node từ chối spawn .cmd khi shell:false (EINVAL). */
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

export function docPin(text) {
  const j = JSON.parse(text);
  const g = j.gitnexus ?? {};
  return {
    version: g.version ?? null,
    status: g.status ?? "blocked-until-version-is-verified",
    analyzeArgs: Array.isArray(g.analyzeArgs) ? g.analyzeArgs : [],
    daVerify: g.status === "verified" && typeof g.version === "string" && g.version.length > 0,
  };
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * Gọi GitNexus qua npx, xử đúng hai cái bẫy của Windows.
 *
 * 1. `npx.cmd` với `shell:false` ném EINVAL — Node từ chối spawn file .cmd không
 *    qua shell (bản vá bảo mật CVE-2024-27980). Đo được: status=null,
 *    error.code=EINVAL, stdout rỗng. Nguy hiểm ở chỗ nếu chỉ nhìn stdout thì nó
 *    trông y hệt "công cụ chạy nhưng không in gì".
 * 2. Nhưng `shell:true` thì Node KHÔNG bọc nháy đối số — nó nối tất cả thành một
 *    chuỗi lệnh. Đường dẫn repo này là "C:\Users\Nguyen Tam\…" có dấu cách, nên
 *    bất kỳ đối số nào mang đường dẫn sẽ bị shell cắt làm đôi. Đây đúng lỗi đã
 *    cắn scripts/check-permission-catalog.mjs (CI Linux không bao giờ lộ vì
 *    đường dẫn ở đó không có dấu cách).
 *
 * Nên: Windows dùng shell:true và TỰ bọc nháy đối số nào có dấu cách; POSIX giữ
 * shell:false (an toàn hơn, không cần bọc).
 */
function chayGitNexus(version, args, { keThua = true } = {}) {
  const laWin = process.platform === "win32";
  const doiSo = ["--yes", `gitnexus@${version}`, ...args];
  const boc = (a) => (laWin && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  return spawnSync(NPX, laWin ? doiSo.map(boc) : doiSo, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: keThua ? "inherit" : "pipe",
    timeout: 60 * 60 * 1000,
    shell: laWin,
  });
}

/**
 * Manifest hộ chiếu cho chỉ mục GitNexus (luật #3 của Contract §12).
 *
 * Ghi vào .gitnexus/ — thư mục đã nằm trong .gitignore THEO THIẾT KẾ (chỉ mục là
 * local-only, không commit). Vì vậy manifest này cũng local: nó mô tả chỉ mục
 * TRÊN MÁY NÀY, và check-graph-freshness.mjs đọc nó để biết chỉ mục chụp ở commit
 * nào. Không có nó thì "chỉ mục cũ" và "chỉ mục mới" trông giống hệt nhau.
 *
 * configDigest dùng git blob OID, KHÔNG sha256 nội dung file: trên Windows nội
 * dung worktree có thể là CRLF trong khi blob là LF, nên sha256 worktree sẽ lệch
 * một cách vô nghĩa. Blob OID là thứ git thật sự lưu.
 */
function ghiManifest(version, analyzeArgs) {
  const head = git(["rev-parse", "HEAD"]);
  // `hash-object` chứ KHÔNG `rev-parse HEAD:<path>`: cái sau chỉ đọc được file
  // ĐÃ commit, nên lần chạy đầu tiên (khi agent-tools.json còn trong working
  // tree) nó fail và configDigest thành null — đúng lúc cần nó nhất. hash-object
  // tính OID từ nội dung hiện tại, có áp filter theo .gitattributes nên ra CÙNG
  // giá trị mà git sẽ lưu (đã đối chiếu trên .ua/config.json: khớp tuyệt đối).
  const oid = git(["hash-object", "tooling/agent-tools.json"]);
  mkdirSync(INDEX_DIR, { recursive: true });
  const m = {
    $comment:
      "SINH BỞI scripts/run-pinned-gitnexus.mjs — không sửa tay. Hộ chiếu cho chỉ mục GitNexus local (Contract §12 luật #3). File này KHÔNG được commit: .gitnexus/ là local-only theo thiết kế.",
    schemaVersion: 1,
    graph: "gitnexus",
    artifactDir: ".gitnexus",
    baseCommit: head,
    analyzedAt: new Date().toISOString(),
    scope: {
      description: `Toàn repo tại ${String(head).slice(0, 8)}, cờ analyze: ${analyzeArgs.join(" ")}`,
      analyzeArgs,
    },
    toolVersion: version,
    toolVersionSource: "measured",
    configDigest: { "tooling/agent-tools.json": oid ? `git:${oid}` : null },
  };
  writeFileSync(MANIFEST, `${JSON.stringify(m, null, 2)}\n`, "utf8");
  return m;
}

function smoke(pin) {
  console.log(`Smoke test GitNexus @${pin.version} — kiểm công cụ chạy được TRƯỚC khi tin nó.\n`);

  const v = chayGitNexus(pin.version, ["--version"], { keThua: false });
  const báo = String(v.stdout ?? "").trim();
  if (v.error) {
    // Phân biệt "không chạy được công cụ" với "công cụ báo sai version". Gộp hai
    // thứ này vào một thông điệp là cách chắc chắn để mất nửa giờ chẩn đoán.
    console.error(`❌ Không chạy được npx (${v.error.code ?? v.error.message}).`);
    console.error("   EINVAL trên Windows = Node từ chối spawn .cmd khi shell:false.");
    return 1;
  }
  if (v.status !== 0 || !báo.includes(pin.version)) {
    console.error(`❌ Công cụ không báo đúng version. Pin ${pin.version}, nhận "${báo}".`);
    console.error("   KHÔNG đổi status sang verified. Sai version nghĩa là mọi kết luận sau đó vô nghĩa.");
    return 1;
  }
  console.log(`  ✓ version khớp pin: ${báo}`);

  const d = chayGitNexus(pin.version, ["doctor"], { keThua: false });
  if (d.status !== 0) {
    console.error("❌ `doctor` thất bại — môi trường chưa chạy được GitNexus.");
    console.error(String(d.stderr ?? d.stdout ?? "").slice(0, 600));
    return 1;
  }
  console.log("  ✓ doctor chạy được");

  const j = JSON.parse(readFileSync(PIN, "utf8"));
  j.gitnexus.status = "verified";
  j.gitnexus.verifiedAt = new Date().toISOString();
  j.gitnexus.smokeEvidence = {
    versionReported: báo,
    doctorExitCode: d.status,
    platform: `${process.platform} node ${process.version}`,
  };
  writeFileSync(PIN, `${JSON.stringify(j, null, 2)}\n`, "utf8");
  console.log(`\n✅ Đã verify pin. tooling/agent-tools.json: status → verified.`);
  console.log("   Bước tiếp: node scripts/run-pinned-gitnexus.mjs analyze");
  return 0;
}

/**
 * Đếm mức lệch của chỉ mục so với HEAD. Trả null nếu không đo được.
 *
 * Cố ý KHÔNG ném: đây là lời nhắc, không phải cửa chặn. Không đo được thì im,
 * chứ không chặn người ta làm việc.
 */
export function doLechChiMuc(base) {
  const chay = (a) => execFileSync("git", a, { cwd: repoRoot, encoding: "utf8" }).trim();
  try {
    chay(["cat-file", "-e", `${base}^{commit}`]);
    const soCommit = Number(chay(["rev-list", "--count", `${base}..HEAD`]));
    const fileMoi = chay(["diff", "--name-only", "--diff-filter=A", `${base}..HEAD`])
      .split(/\r?\n/)
      .filter((f) => /\.(ts|tsx|js|mjs|cjs|sql)$/.test(f)).length;
    return { soCommit, fileMoi };
  } catch {
    return null;
  }
}

/**
 * In cảnh báo TRƯỚC mỗi lệnh truy vấn khi chỉ mục đã cũ.
 *
 * VÌ SAO ĐẶT Ở ĐÂY, không phải trong một báo cáo định kỳ (plan Đợt 6)
 *   `gate:graph-freshness` in "GitNexus: cũ N commit · M file mới chưa index" rồi
 *   thoát 0 — theo thiết kế, vì chặn CI vì độ mới của graph sẽ khiến người ta tắt
 *   gate. Nhưng hệ quả là con số đó nằm trong một báo cáo mà không ai đọc ĐÚNG
 *   LÚC nó quan trọng.
 *
 *   Lúc nó quan trọng là lúc chạy `impact`: M file chưa index nghĩa là caller nằm
 *   trong M file đó SẼ KHÔNG XUẤT HIỆN trong bán kính ảnh hưởng. Câu trả lời
 *   thiếu, và nó không tự nói là thiếu — người hỏi sẽ đọc "impactedCount: 0" thành
 *   "sửa thoải mái". Contract §12 bắt hỏi bán kính trước khi sửa; một câu trả lời
 *   thiếu ở đúng chỗ đó tệ hơn không hỏi.
 *
 *   Nên cảnh báo đứng ngay trước câu trả lời, và nói rõ nó có thể thiếu bao nhiêu.
 */
export function canhBaoChiMucCu(sub) {
  if (!existsSync(MANIFEST)) return;
  let base;
  try {
    base = JSON.parse(readFileSync(MANIFEST, "utf8")).baseCommit;
  } catch {
    return;
  }
  if (!base) return;
  const lech = doLechChiMuc(base);
  if (!lech || (lech.soCommit === 0 && lech.fileMoi === 0)) return;

  console.error(`⚠ Chỉ mục GitNexus cũ ${lech.soCommit} commit · ${lech.fileMoi} file mã mới CHƯA index.`);
  if (sub === "impact" || sub === "trace" || sub === "detect-changes" || sub === "detect_changes") {
    console.error(`   Nghĩa là caller/quan hệ nằm trong ${lech.fileMoi} file đó SẼ KHÔNG hiện ra ở kết quả dưới.`);
    console.error("   Kết quả trống KHÔNG chứng minh 'không ảnh hưởng gì' — nó có thể chỉ là chưa nhìn thấy.");
  }
  console.error("   Reindex: npm run graph:analyze\n");
}

function main(argv) {
  const sub = argv[2];
  if (!sub) {
    console.error("Dùng: node scripts/run-pinned-gitnexus.mjs <smoke|analyze|status|mcp|…> [args]");
    return 1;
  }
  if (!existsSync(PIN)) {
    console.error(`❌ Thiếu ${PIN.replace(repoRoot, ".")} — không biết phải chạy version nào.`);
    return 1;
  }
  const pin = docPin(readFileSync(PIN, "utf8"));
  if (!pin.version) {
    console.error("❌ tooling/agent-tools.json: gitnexus.version là null.");
    console.error("   null là trạng thái fail-closed CÓ CHỦ Ý, không phải version mặc định (plan §14).");
    return 1;
  }

  if (sub === "smoke") return smoke(pin);

  if (!pin.daVerify) {
    console.error(`❌ Pin chưa verified (status: ${pin.status}).`);
    console.error("   Chạy `node scripts/run-pinned-gitnexus.mjs smoke` trước — nó kiểm công cụ thật sự");
    console.error("   chạy được rồi mới ghi verified kèm bằng chứng. Không tự sửa tay trường status:");
    console.error("   một pin 'verified' mà chưa ai chạy thử là lời khai, không phải bằng chứng.");
    return 1;
  }

  const them = argv.slice(3);
  let args;
  if (sub === "analyze") {
    // Ép cờ bắt buộc kể cả khi người gọi quên. --skip-agents-md chặn GitNexus
    // tự chèn mục vào CLAUDE.md/AGENTS.md — để công cụ sửa hợp đồng agent là
    // để nó tự viết luật cho chính nó.
    args = [sub, ...pin.analyzeArgs, ...them];
    if (!args.includes("--skip-agents-md")) args.push("--skip-agents-md");
  } else {
    args = [sub, ...them];
    // Ép --repo trỏ về CHÍNH repo này, cùng lý do với --skip-agents-md ở trên:
    // gỡ một cái bẫy đặt sẵn cho mọi người dùng sau.
    //
    // GitNexus giữ một REGISTRY TOÀN CỤC theo máy, không theo repo. Máy này đang
    // có hai mục CÙNG TÊN `whiteboard-ihomecrm` (repo này, và một worktree của
    // clone khác ở XCRN/). Khi đó mọi lệnh truy vấn chết ngay với "Multiple
    // repositories indexed" — đo được 08/08/2026. Tệ hơn: nếu chỉ có MỘT mục
    // nhưng là mục của clone KIA, lệnh vẫn chạy và trả kết quả của repo khác mà
    // không báo gì. Đó mới là hỏng thật: câu trả lời sai trông y như câu đúng.
    //
    // Truyền đường dẫn tuyệt đối chứ không truyền tên: hai mục trùng tên nên tên
    // không phân biệt được.
    if (SUB_CAN_REPO.has(sub) && !them.includes("--repo") && !them.includes("-r")) {
      args.push("--repo", repoRoot);
    }
    if (SUB_CAN_REPO.has(sub)) canhBaoChiMucCu(sub);
  }

  console.log(`→ gitnexus@${pin.version} ${args.join(" ")}\n`);
  const r = chayGitNexus(pin.version, args);
  if (r.status !== 0) return r.status ?? 1;

  if (sub === "analyze") {
    const m = ghiManifest(pin.version, args.slice(1));
    console.log(`\n✅ Đã ghi ${MANIFEST.replace(repoRoot, ".")}`);
    console.log(`   baseCommit ${String(m.baseCommit).slice(0, 12)}… · toolVersion ${m.toolVersion}`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
