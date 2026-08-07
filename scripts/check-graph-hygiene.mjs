#!/usr/bin/env node
// Gate: graph tri thức phải có hộ chiếu khớp artifact, và không được lẻn vào
// commit chung với code.
//
// VÌ SAO CẦN (PROJECT_CONTRACT §12, luật #3 và #6)
//   Graph là thứ agent đọc rồi tin. Hai cách nó nói dối mà không ai thấy:
//
//   1. HỘ CHIẾU KHÔNG KHỚP HÀNG. Graph UA committed 29/07 không ghi scope,
//      không ghi version công cụ, không ghi digest config. Nhìn vào repo thì nó
//      trông như một graph hợp lệ; thực tế nó cũ 487 commit và KHÔNG BIẾT
//      Network Center lẫn OpenClaw tồn tại. Manifest bắt phải khai những thứ đó,
//      và gate này đối chiếu lời khai với artifact — một manifest không ai đối
//      chiếu chỉ là lời khai.
//   2. REFRESH LẺN VÀO COMMIT KHÁC. Nếu một commit vừa đổi code vừa regenerate
//      graph, không ai review được graph: diff của nó là 4 MB JSON nằm lẫn giữa
//      thay đổi thật. Luật #6 đòi refresh đi PR riêng.
//
//   node scripts/check-graph-hygiene.mjs
//
// Không cần credential, không đọc database. Chạy được trên CI.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY = join(repoRoot, "tooling", "graph-policy.json");
const CONTRACT = join(repoRoot, "docs", "engineering", "PROJECT_CONTRACT.md");

/**
 * Ba dòng PHẢI tồn tại nguyên văn trong Contract §12.
 *
 * Luật #4 và #5 không kiểm bằng máy được — chúng nói về việc agent PHẢI LÀM GÌ
 * trước khi đọc graph, và về việc tin cái nào hơn khi hai nguồn mâu thuẫn. Thứ
 * kiểm được là: câu luật đó CÒN NẰM ĐÓ. Ghim nguyên văn để không ai lặng lẽ xoá
 * — cùng cách MIEN_TRU trong check-agent-contract.mjs.
 */
export const DONG_GHIM_CONTRACT = [
  "## 12. Công cụ tri thức",
  "Contract manifest + SQL harness LUÔN ưu tiên hơn mọi graph",
  "Agent KHÔNG được nạp graph khi chưa có verdict còn hiệu lực",
];

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Commit đụng graph thì mọi file CÒN LẠI phải nằm trong allowlist. */
export function phanLoaiCommit(files, allowlist, graphPaths) {
  const laGraph = (f) => graphPaths.some((g) => f.startsWith(g));
  if (!files.some(laGraph)) return { xet: false, viPham: [] };
  const viPham = files.filter((f) => !allowlist.some((a) => f.startsWith(a)));
  return { xet: true, viPham };
}

/**
 * Đối chiếu manifest với artifact thật.
 *
 * `docSo` được tiêm vào để test được mà không cần 7 MB JSON trên đĩa.
 */
export function doiChieuManifestVoiArtifact(manifest, artifact) {
  const loi = [];
  for (const truong of ["baseCommit", "analyzedAt", "analyzedFiles", "scope", "toolVersion", "configDigest"]) {
    if (!(truong in manifest)) loi.push(`manifest thiếu trường bắt buộc: ${truong}`);
  }
  if (loi.length > 0) return loi;

  // baseCommit phải khớp CẢ BA nguồn trong artifact. Ba nguồn là cố ý: nếu chỉ
  // tin meta.json thì một artifact bị sửa tay ở đúng một chỗ sẽ đi lọt.
  const nguon = {
    "meta.json": artifact.metaCommit,
    "fingerprints.json": artifact.fingerprintsCommit,
    "knowledge-graph.json→project": artifact.graphCommit,
  };
  for (const [ten, sha] of Object.entries(nguon)) {
    if (sha !== manifest.baseCommit) {
      loi.push(`baseCommit lệch: manifest ${String(manifest.baseCommit).slice(0, 12)}… ≠ ${ten} ${String(sha).slice(0, 12)}…`);
    }
  }
  if (artifact.soFile !== manifest.analyzedFiles) {
    loi.push(`analyzedFiles lệch: manifest ${manifest.analyzedFiles} ≠ fingerprints ${artifact.soFile}`);
  }
  for (const [duongDan, khai] of Object.entries(manifest.configDigest ?? {})) {
    const that = artifact.digest[duongDan];
    if (!that) loi.push(`configDigest khai ${duongDan} nhưng không đọc được file đó`);
    else if (that !== khai) loi.push(`configDigest lệch ở ${duongDan}: manifest ${khai} ≠ thực tế ${that}`);
  }
  return loi;
}

export function kiemDongGhim(text, canCo) {
  return canCo.filter((d) => !text.includes(d));
}

function main() {
  if (!existsSync(POLICY)) {
    console.error("❌ Thiếu tooling/graph-policy.json — không biết luật để kiểm.");
    process.exitCode = 3;
    return;
  }
  const policy = JSON.parse(readFileSync(POLICY, "utf8"));
  const { graphPaths, commitAllowlist } = policy.hygiene;
  const van = [];

  // Repo nông thì mọi phép đo lịch sử đều vô nghĩa. "Không kiểm được" KHÁC "đạt".
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    console.error("❌ Repo đang SHALLOW — không đọc được lịch sử để kiểm luật #6.");
    console.error("   Thêm `fetch-depth: 0` vào bước checkout. Không kiểm được KHÔNG phải là đạt.");
    process.exitCode = 3;
    return;
  }

  const daTrackUa = git(["ls-files", ".ua"]).trim().length > 0;
  const daTrackGitnexus = git(["ls-files", ".gitnexus"]).trim().length > 0;

  // .gitnexus/ là local-only THEO THIẾT KẾ (.gitignore dòng 41). Nó xuất hiện
  // trong ls-files nghĩa là ai đó force-add — chỉ mục 25k node đi vào git.
  if (daTrackGitnexus) {
    van.push(".gitnexus/ đang được git theo dõi — nó là chỉ mục LOCAL, không bao giờ được commit (force-add?).");
  }

  // ── Luật #3: manifest ↔ artifact ─────────────────────────────────────────
  const manifestUa = join(repoRoot, "tooling", "graph-manifests", "ua.json");
  if (daTrackUa && !existsSync(manifestUa)) {
    van.push(".ua/ được commit nhưng thiếu tooling/graph-manifests/ua.json — graph không có hộ chiếu.");
  } else if (!daTrackUa && existsSync(manifestUa)) {
    van.push("tooling/graph-manifests/ua.json mồ côi — không có .ua/ nào được commit để nó mô tả.");
  } else if (daTrackUa) {
    const m = JSON.parse(readFileSync(manifestUa, "utf8"));
    const meta = JSON.parse(readFileSync(join(repoRoot, ".ua", "meta.json"), "utf8"));
    const fp = JSON.parse(readFileSync(join(repoRoot, ".ua", "fingerprints.json"), "utf8"));
    const kg = JSON.parse(readFileSync(join(repoRoot, ".ua", "knowledge-graph.json"), "utf8"));
    const soFile = Object.keys(fp.files ?? {}).length;
    if (soFile === 0) {
      console.error("❌ fingerprints.files rỗng — artifact hỏng hoặc định dạng đã đổi. Không kết luận được.");
      process.exitCode = 3;
      return;
    }
    const digest = {};
    for (const p of Object.keys(m.configDigest ?? {})) {
      try {
        digest[p] = `git:${git(["hash-object", p]).trim()}`;
      } catch { /* file biến mất — doiChieu sẽ báo */ }
    }
    van.push(
      ...doiChieuManifestVoiArtifact(m, {
        metaCommit: meta.gitCommitHash,
        fingerprintsCommit: fp.gitCommitHash,
        graphCommit: kg.project?.gitCommitHash,
        soFile,
        digest,
      }),
    );
  }

  // ── Luật #6: refresh graph phải đi riêng ─────────────────────────────────
  // Quét TOÀN lịch sử nhưng chỉ những commit đụng graph — hiện đúng 1, và mãi
  // hiếm vì refresh thưa. Không giới hạn N ngày: giới hạn thời gian tạo ra cửa
  // "chờ cho vi phạm trôi qua".
  // Bỏ merge commit: combined-diff của merge gộp việc của người khác vào, sẽ
  // báo giả. Auto-committer commit thẳng nên vẫn dính.
  const shas = git(["log", "--no-merges", "--format=%H", "--", ...graphPaths])
    .split("\n").map((s) => s.trim()).filter(Boolean);
  if (daTrackUa && shas.length === 0) {
    console.error("❌ .ua/ được git theo dõi nhưng không commit nào đụng tới nó — bất khả.");
    console.error("   Phép đo hỏng (đường dẫn sai?), KHÔNG phải 'sạch'.");
    process.exitCode = 3;
    return;
  }
  for (const sha of shas) {
    const files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha])
      .split("\n").map((s) => s.trim()).filter(Boolean);
    const { viPham } = phanLoaiCommit(files, commitAllowlist, graphPaths);
    if (viPham.length > 0) {
      van.push(
        `commit ${sha.slice(0, 8)} vừa đổi graph vừa đổi ${viPham.length} file khác ` +
        `(${viPham.slice(0, 3).join(", ")}${viPham.length > 3 ? "…" : ""}) — refresh graph phải đi PR riêng.`,
      );
    }
  }

  // ── Ghim luật văn bản trong Contract ─────────────────────────────────────
  if (!existsSync(CONTRACT)) {
    console.error(`❌ Thiếu ${CONTRACT.replace(repoRoot, ".")}.`);
    process.exitCode = 3;
    return;
  }
  const thieuDong = kiemDongGhim(readFileSync(CONTRACT, "utf8"), DONG_GHIM_CONTRACT);
  for (const d of thieuDong) {
    van.push(`Contract §12 mất dòng ghim: "${d}"`);
  }

  if (van.length > 0) {
    console.error(`❌ ${van.length} vấn đề vệ sinh graph:\n`);
    for (const v of van) console.error(`  - ${v}`);
    if (thieuDong.length > 0) {
      console.error("\n  Ba dòng ghim là phần DUY NHẤT của luật #4/#5 kiểm được bằng máy:");
      console.error("  chúng nói agent phải chạy freshness trước khi đọc graph, và manifest/harness");
      console.error("  thắng graph khi mâu thuẫn. Xoá chúng đi thì luật chỉ còn trong trí nhớ.");
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `✅ Vệ sinh graph OK — ${shas.length} commit đụng graph đều đi riêng; ` +
    `${daTrackUa ? "manifest UA khớp artifact" : "chưa commit graph UA"}; 3 dòng ghim Contract còn nguyên.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
