#!/usr/bin/env node
// Gate: graph tri thức phải đủ mới TRƯỚC khi agent tin nó (PROJECT_CONTRACT §12,
// luật #1, #2, #4).
//
// VÌ SAO CẦN
//   Một graph cũ không báo lỗi. Nó trả lời trôi chảy — chỉ là trả lời về một
//   codebase đã không còn tồn tại. Đo 07/08/2026 trên graph UA committed 29/07:
//   cũ 487 commit · 1.345 file đổi · thiếu 118 migration · và 0 node nguồn cho
//   Network Center lẫn OpenClaw. Hỏi nó "hệ thống có những tiểu hệ nào" thì nó
//   kể thiếu hai cái, một cách tự tin.
//
//   Nguy hiểm hơn cả sai: nó KHÔNG NÓI nó đang thiếu.
//
// HAI GRAPH, HAI MỨC KHẮT KHE — cố ý không đối xử như nhau:
//   · GitNexus: chỉ mục local, regenerate trong ~53 giây ⇒ đòi tươi được, và
//     task medium/high-risk cần impact analysis đúng ⇒ CỬA CHẶN CỨNG.
//   · UA: graph 4 MB commit vào repo, refresh là một PR ⇒ đòi tươi mọi lúc sẽ
//     khiến người ta tắt gate. Mặc định CẢNH BÁO; chỉ cứng với bốn nhiệm vụ mà
//     graph LÀ nguồn sự thật (plan kiến trúc dòng 119 đã chốt: không phải
//     required check).
//
//   node scripts/check-graph-freshness.mjs                       # cảnh báo
//   node scripts/check-graph-freshness.mjs --nhiem-vu onboarding # cửa chặn
//
// MÃ THOÁT: 0 đạt/cảnh báo · 1 vi phạm ở chế độ cứng · 3 KHÔNG KIỂM ĐƯỢC.
// Ba khác một: "chưa kiểm được" không bao giờ được coi là "đã kiểm và đạt".
//
// Không cần credential, không đọc database.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY = join(repoRoot, "tooling", "graph-policy.json");
const PIN = join(repoRoot, "tooling", "agent-tools.json");

/**
 * TRẦN CỨNG cho policy — policy không được tự nới quá đây.
 *
 * Không có trần thì luật #1/#2 vô hiệu hoá được bằng một dòng JSON:
 * `maxCommitsBehind: 999999` biến mọi graph thành "tươi". Mức lệch đã đo
 * (487/1345/118) không bao giờ được phép đi qua cửa chặn cứng.
 */
const TRAN = { maxCommitsBehind: 200, maxFilesDrifted: 500, maxMigrationsMissing: 30 };

function git(args, { imLang = false } = {}) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (e) {
    if (imLang) return null;
    throw e;
  }
}

/** Chỉ mục GitNexus có ba trạng thái, và gộp chúng lại là hỏng cả luật. */
export function phanLoaiGitnexus(pin, coManifest) {
  const daPin = pin?.status === "verified" && typeof pin?.version === "string";
  if (!daPin && !coManifest) return "NOT_ADOPTED";
  // Chỉ mục tồn tại mà pin chưa verified = ai đó chạy GitNexus ngoài wrapper.
  // Đó là dùng một công cụ chưa ai kiểm để kết luận về mã nguồn.
  if (!daPin && coManifest) return "ADOPTED_KHONG_PIN";
  if (daPin && !coManifest) return "MISSING";
  return "CO";
}

/** Đối chiếu ba nguồn baseCommit trong artifact UA với manifest. */
export function doiChieuNguon(meta, fingerprints, graphProject, manifest) {
  const s = [meta?.gitCommitHash, fingerprints?.gitCommitHash, graphProject?.gitCommitHash, manifest?.baseCommit];
  if (s.some((x) => typeof x !== "string" || x.length < 7)) return "thiếu baseCommit ở ít nhất một nguồn";
  if (new Set(s).size !== 1) return `baseCommit lệch giữa các nguồn: ${[...new Set(s)].map((x) => x.slice(0, 8)).join(" / ")}`;
  return null;
}

/**
 * Tiểu hệ thống có trên đĩa mà graph không biết.
 *
 * Đây là phép đo QUAN TRỌNG NHẤT trong file này. Commit-behind chỉ nói graph
 * cũ; missing-subsystem nói graph MÙ — nó không biết cả một hệ thống tồn tại,
 * và đó là kiểu sai không phép đo tuổi nào bắt được.
 */
export function timSubsystemThieu(thuMucCoCode, tienToTrongGraph) {
  return [...thuMucCoCode].filter((d) => !tienToTrongGraph.has(d)).sort();
}

export function danhGiaTuoi(soDo, policy, batBuoc) {
  const h = policy.hard;
  const loi = [];
  if (soDo.commitsBehind > h.maxCommitsBehind) loi.push(`cũ ${soDo.commitsBehind} commit (trần ${h.maxCommitsBehind})`);
  if (soDo.filesDrifted > h.maxFilesDrifted) loi.push(`${soDo.filesDrifted} file đã đổi (trần ${h.maxFilesDrifted})`);
  if (soDo.migrationsMissing > h.maxMigrationsMissing) loi.push(`thiếu ${soDo.migrationsMissing} migration (trần ${h.maxMigrationsMissing})`);
  if (soDo.missingSubsystems.length > h.maxMissingSubsystems) {
    loi.push(`${soDo.missingSubsystems.length} tiểu hệ thống vắng mặt: ${soDo.missingSubsystems.slice(0, 3).join(", ")}`);
  }
  if (h.requireToolVersion && !soDo.toolVersion) loi.push("không biết version công cụ đã sinh graph");
  return { dat: loi.length === 0, loi, batBuoc };
}

/** Verdict chỉ còn hiệu lực khi CẢ BA điều kiện đúng. */
export function verdictConHieuLuc(verdict, headSha, nowMs, policyOid, ttlPhut) {
  if (!verdict || verdict.headCommit !== headSha) return false;
  if (verdict.policyDigest !== policyOid) return false;
  const tuoiPhut = (nowMs - Date.parse(verdict.generatedAt)) / 60000;
  return Number.isFinite(tuoiPhut) && tuoiPhut >= 0 && tuoiPhut <= ttlPhut;
}

function thoat(ma, verdictPath) {
  // exit 3 = không kết luận được ⇒ verdict cũ phải CHẾT, không được để consumer
  // dùng một phán quyết lỗi thời tưởng là còn hiệu lực.
  if (ma === 3 && verdictPath) rmSync(verdictPath, { force: true });
  process.exit(ma);
}

function main(argv) {
  if (!existsSync(POLICY)) {
    console.error("❌ Thiếu tooling/graph-policy.json.");
    process.exit(3);
  }
  const policy = JSON.parse(readFileSync(POLICY, "utf8"));
  const verdictPath = join(repoRoot, policy.verdictFile);

  for (const [k, tran] of Object.entries(TRAN)) {
    if (policy.hard[k] > tran) {
      console.error(`❌ Policy nới quá trần: ${k} = ${policy.hard[k]} > ${tran}.`);
      console.error("   Trần tồn tại để luật không bị vô hiệu hoá bằng một dòng JSON.");
      thoat(3, verdictPath);
    }
  }

  const i = argv.indexOf("--nhiem-vu");
  const nhiemVu = i >= 0 ? argv[i + 1] : null;
  if (i >= 0 && (!nhiemVu || !(nhiemVu in policy.hardTasks))) {
    console.error(`❌ Nhiệm vụ không hợp lệ: "${nhiemVu ?? "(trống)"}".`);
    console.error(`   Hợp lệ: ${Object.keys(policy.hardTasks).join(", ")}`);
    console.error("   Gõ sai KHÔNG được âm thầm rơi về chế độ cảnh báo — đó là cách một cửa chặn");
    console.error("   biến mất mà người chạy vẫn tưởng mình đang được bảo vệ.");
    thoat(3, verdictPath);
  }
  const batBuoc = new Set(nhiemVu ? policy.hardTasks[nhiemVu] : []);

  if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
    console.error("❌ Repo SHALLOW — không đo được độ lệch. Thêm `fetch-depth: 0`.");
    thoat(3, verdictPath);
  }
  const head = git(["rev-parse", "HEAD"]);
  const policyOid = git(["hash-object", policy.verdictFile.replace(/verdict\.local\.json$/, "policy.json")], { imLang: true })
    ?? git(["hash-object", "tooling/graph-policy.json"]);

  const graphs = {};

  // ── UA ───────────────────────────────────────────────────────────────────
  const uaDir = join(repoRoot, ".ua");
  const manifestPath = join(repoRoot, "tooling", "graph-manifests", "ua.json");
  if (!existsSync(uaDir) || !existsSync(manifestPath)) {
    graphs.ua = { status: "MISSING" };
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const meta = JSON.parse(readFileSync(join(uaDir, "meta.json"), "utf8"));
    const fp = JSON.parse(readFileSync(join(uaDir, "fingerprints.json"), "utf8"));
    const kg = JSON.parse(readFileSync(join(uaDir, "knowledge-graph.json"), "utf8"));

    const lech = doiChieuNguon(meta, fp, kg.project, manifest);
    if (lech) {
      console.error(`❌ Artifact UA không tự nhất quán: ${lech}`);
      console.error("   Không kết luận được về độ mới của một graph không rõ nó chụp ở đâu.");
      thoat(3, verdictPath);
    }
    const base = manifest.baseCommit;
    if (!git(["cat-file", "-e", `${base}^{commit}`], { imLang: true }) === null) { /* noop */ }
    try {
      execFileSync("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: repoRoot, stdio: "ignore" });
    } catch {
      console.error(`❌ baseCommit ${String(base).slice(0, 12)}… không có trong lịch sử repo.`);
      thoat(3, verdictPath);
    }

    const duongDan = base === head ? [] : git(["diff", "--name-only", `${base}..${head}`]).split("\n").filter(Boolean);
    const soKhoa = Object.keys(fp.files ?? {}).length;
    if (soKhoa === 0) {
      console.error("❌ fingerprints.files rỗng — phép đo phạm vi graph hỏng.");
      thoat(3, verdictPath);
    }

    // Thư mục "có code" = khớp mẫu tiểu hệ thống VÀ có đủ số file được git theo dõi.
    const tracked = git(["ls-files"]).split("\n").filter(Boolean);
    const dem = new Map();
    const khopMau = (d) => policy.subsystemRootPatterns.some((p) => {
      const [g] = p.split("/*");
      return d.startsWith(`${g}/`) && d.split("/").length === p.split("/").length;
    });
    for (const f of tracked) {
      const parts = f.split("/");
      for (let n = 2; n <= 3 && n <= parts.length - 1; n += 1) {
        const d = parts.slice(0, n).join("/");
        if (khopMau(d)) dem.set(d, (dem.get(d) ?? 0) + 1);
      }
    }
    const thuMucCoCode = new Set([...dem].filter(([, n]) => n >= policy.subsystemMinTrackedFiles).map(([d]) => d));
    const tienTo = new Set();
    for (const p of Object.keys(fp.files)) {
      const parts = p.replace(/\\/g, "/").split("/");
      for (let n = 2; n <= 3 && n <= parts.length - 1; n += 1) tienTo.add(parts.slice(0, n).join("/"));
    }
    if (thuMucCoCode.size === 0) {
      console.error("❌ Không tìm được thư mục tiểu hệ thống nào — phép đo hỏng, không phải 'không thiếu gì'.");
      thoat(3, verdictPath);
    }

    const soDo = {
      commitsBehind: base === head ? 0 : Number(git(["rev-list", "--count", `${base}..${head}`])),
      filesDrifted: duongDan.length,
      migrationsMissing: duongDan.filter((f) => f.startsWith("supabase/migrations/")).length,
      missingSubsystems: timSubsystemThieu(thuMucCoCode, tienTo),
      toolVersion: manifest.toolVersion,
    };
    const kq = danhGiaTuoi(soDo, policy, batBuoc.has("ua"));
    graphs.ua = { status: kq.dat ? "FRESH" : "STALE", ...soDo, baseCommit: base, lyDo: kq.loi };
  }

  // ── GitNexus ─────────────────────────────────────────────────────────────
  const pin = existsSync(PIN) ? JSON.parse(readFileSync(PIN, "utf8")).gitnexus : null;
  const gnManifest = join(repoRoot, ".gitnexus", "manifest.json");
  const loai = phanLoaiGitnexus(pin, existsSync(gnManifest));
  if (loai === "CO") {
    const m = JSON.parse(readFileSync(gnManifest, "utf8"));
    const behind = m.baseCommit === head ? 0 : Number(git(["rev-list", "--count", `${m.baseCommit}..${head}`], { imLang: true }) ?? "9999");
    graphs.gitnexus = {
      status: behind > policy.hard.maxCommitsBehind ? "STALE" : "FRESH",
      commitsBehind: behind, baseCommit: m.baseCommit, toolVersion: m.toolVersion,
    };
  } else {
    graphs.gitnexus = { status: loai };
  }

  // ── Phán quyết ───────────────────────────────────────────────────────────
  console.log(`Độ mới graph — HEAD ${head.slice(0, 8)}${nhiemVu ? ` · nhiệm vụ: ${nhiemVu}` : " · chế độ cảnh báo"}\n`);
  const u = graphs.ua;
  if (u.status === "MISSING") {
    console.log("  UA        : KHÔNG CÓ graph");
  } else {
    console.log(
      `  UA        : ${u.status} — cũ ${u.commitsBehind} commit · ${u.filesDrifted} file đổi · ` +
      `thiếu ${u.migrationsMissing} migration · ${u.missingSubsystems.length} tiểu hệ vắng mặt`,
    );
    if (u.missingSubsystems.length) console.log(`              vắng: ${u.missingSubsystems.join(", ")}`);
  }
  const g = graphs.gitnexus;
  console.log(
    `  GitNexus  : ${g.status}` +
    (g.status === "NOT_ADOPTED" ? " — CHƯA ÁP DỤNG (chưa pin verified trong tooling/agent-tools.json)" : "") +
    (g.commitsBehind !== undefined ? ` — cũ ${g.commitsBehind} commit` : ""),
  );
  console.log(`\n  Ưu tiên khi mâu thuẫn: ${policy.precedence.join(" > ")}`);

  const viPham = [];
  if (batBuoc.has("ua") && u.status !== "FRESH") viPham.push(`UA ${u.status}${u.lyDo?.length ? ` (${u.lyDo.join("; ")})` : ""}`);
  if (batBuoc.has("gitnexus") && ["STALE", "MISSING"].includes(g.status)) viPham.push(`GitNexus ${g.status}`);
  // ADOPTED_KHONG_PIN đỏ ở MỌI chế độ: chỉ mục sinh bởi công cụ chưa ai kiểm.
  if (g.status === "ADOPTED_KHONG_PIN") viPham.push("GitNexus có chỉ mục nhưng pin CHƯA verified — chạy `node scripts/run-pinned-gitnexus.mjs smoke`");

  const verdict = {
    $comment: "SINH BỞI check-graph-freshness.mjs. Hết hiệu lực ngay khi HEAD đổi. Contract §12 luật #4: agent không nạp graph khi chưa có verdict còn hiệu lực.",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    headCommit: head,
    policyDigest: policyOid,
    task: nhiemVu,
    precedence: "Contract manifest + SQL harness LUÔN ưu tiên hơn mọi graph",
    graphs,
  };
  writeFileSync(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");

  if (viPham.length > 0) {
    console.error(`\n❌ Chế độ CỨNG (nhiệm vụ ${nhiemVu}) — ${viPham.length} vi phạm:`);
    for (const v of viPham) console.error(`  - ${v}`);
    console.error("\n  Refresh graph rồi chạy lại. Đừng đọc graph để kết luận trong lúc này —");
    console.error("  một graph mù không báo là nó mù.");
    process.exit(1);
  }

  const canhBao = [u.status === "STALE" ? "UA" : null, g.status === "STALE" ? "GitNexus" : null].filter(Boolean);
  if (canhBao.length > 0) {
    console.log(`\n⚠ CẢNH BÁO: ${canhBao.join(" và ")} đã cũ. Không chặn ở chế độ này, nhưng đừng`);
    console.log("  dùng graph làm bằng chứng cho kết luận kiến trúc.");
  } else {
    console.log("\n✅ Graph đủ mới cho nhiệm vụ này.");
  }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv);
}
