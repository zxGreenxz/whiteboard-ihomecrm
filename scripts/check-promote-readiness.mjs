#!/usr/bin/env node
// Preflight TRƯỚC khi promote production, và cửa chặn chống "xanh giả".
//
// VÌ SAO
//   Contract §3 cho agent tự promote khi gate xanh, và nói rõ: "Gate
//   `continue-on-error` KHÔNG bao giờ được tính là xanh khi quyết định promote."
//   Nhưng KHÔNG có gì tính hộ. "Gate xanh" là do người/agent nhìn giao diện
//   GitHub rồi kết luận — mà một step `continue-on-error: true` hiển thị dấu ✓
//   ngay cả khi nó vừa hỏng. Đó là định nghĩa của xanh giả.
//
//   Repo hiện có 1 step như vậy. Một là quản được; vấn đề là không có gì ngăn nó
//   thành năm, và ngăn một cái mới xuất hiện mà không ai đặt tên cho nó.
//
// FILE NÀY KIỂM GÌ — và KHÔNG kiểm gì
//   ✔ Mọi `continue-on-error: true` phải được chú thích `# known-gap: <id>`, và
//     id đó phải tồn tại trong tooling/known-gaps.yaml (tức có ngày hết hạn).
//   ✔ Nhánh `production` không có commit riêng ngoài `main`.
//   ✔ SHA sắp promote nằm trên `main`.
//   ✔ Cây làm việc sạch — không promote từ một thư mục đang dở.
//   ✔ IN RA danh sách step advisory, kèm câu nhắc chúng KHÔNG phải gate.
//
//   ✘ KHÔNG kiểm trạng thái CI trên GitHub. Việc đó cần token API mà repo không
//     lưu. Đây là PREFLIGHT, không thay thế việc đọc kết quả CI thật — và script
//     nói thẳng điều đó ở cuối thay vì để người chạy tưởng đã đủ.
//
//   node scripts/check-promote-readiness.mjs
//   node scripts/check-promote-readiness.mjs --sha <sha>
//
// Không cần credential. Thoát 0 đạt · 1 vi phạm · 3 không kiểm được.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const WF = join(repoRoot, ".github", "workflows");

/** Sàn chống rỗng: không đọc được workflow nào thì "0 advisory" là vô nghĩa. */
export const TOI_THIEU_WORKFLOW = 2;

const git = (a, { imLang = false } = {}) => {
  try {
    return execFileSync("git", a, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch (e) {
    if (imLang) return null;
    throw e;
  }
};

/**
 * Tìm mọi `continue-on-error: true` và id known-gap chú thích ngay trên nó.
 *
 * Quét theo DÒNG chứ không parse YAML: chú thích `# known-gap:` là comment, mà
 * parser YAML vứt comment đi. Đây là một trong số ít chỗ mà quét văn bản đúng
 * hơn parse cấu trúc.
 */
export function timAdvisory(ten, noiDung) {
  const dong = noiDung.split(/\r?\n/);
  const ra = [];
  for (let i = 0; i < dong.length; i++) {
    if (!/^\s*continue-on-error:\s*true\s*(#.*)?$/.test(dong[i])) continue;
    // Nhìn ngược tối đa 8 dòng để tìm `# known-gap: <id>` và tên step.
    let gap = null;
    let tenStep = null;
    for (let k = i - 1; k >= Math.max(0, i - 8); k--) {
      const m = dong[k].match(/#\s*known-gap:\s*([a-z0-9-]+)/i);
      if (m && !gap) gap = m[1];
      const s = dong[k].match(/^\s*-?\s*name:\s*(.+?)\s*$/);
      if (s && !tenStep) tenStep = s[1];
    }
    ra.push({ file: ten, dong: i + 1, gapId: gap, step: tenStep });
  }
  return ra;
}

export function docIdKnownGap(yaml) {
  return new Set([...yaml.matchAll(/^\s*-\s*id:\s*([a-z0-9-]+)\s*$/gim)].map((m) => m[1]));
}

function main() {
  const i = process.argv.indexOf("--sha");
  const shaMuonPromote = i >= 0 ? process.argv[i + 1] : null;

  if (!existsSync(WF)) {
    console.error("❌ Không thấy .github/workflows — không kiểm được.");
    process.exit(3);
  }
  const files = readdirSync(WF).filter((f) => /\.ya?ml$/.test(f));
  if (files.length < TOI_THIEU_WORKFLOW) {
    console.error(`❌ Chỉ thấy ${files.length} workflow (sàn ${TOI_THIEU_WORKFLOW}) — phép đo hỏng.`);
    process.exit(3);
  }

  const advisory = files.flatMap((f) => timAdvisory(f, readFileSync(join(WF, f), "utf8")));
  const idGap = docIdKnownGap(readFileSync(join(repoRoot, "tooling", "known-gaps.yaml"), "utf8"));

  const viPham = [];

  // (1) Advisory không có tên là advisory không ai nhớ.
  for (const a of advisory) {
    if (!a.gapId) {
      viPham.push(
        `${a.file}:${a.dong} — step "${a.step ?? "?"}" là advisory nhưng KHÔNG có chú thích ` +
          `\`# known-gap: <id>\`. Một bước hiện dấu ✓ trong khi có thể đã hỏng thì phải có tên và ngày hết hạn.`,
      );
    } else if (!idGap.has(a.gapId)) {
      viPham.push(
        `${a.file}:${a.dong} — chú thích \`known-gap: ${a.gapId}\` nhưng id đó KHÔNG có trong ` +
          `tooling/known-gaps.yaml, tức không có ngày hết hạn.`,
      );
    }
  }

  // (2) production không được có commit riêng.
  if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
    console.error("❌ Repo shallow — không so được production với main.");
    process.exit(3);
  }
  const co = (r) => git(["rev-parse", "--verify", r], { imLang: true }) !== null;
  const refProd = co("origin/production") ? "origin/production" : co("production") ? "production" : null;
  const refMain = co("origin/main") ? "origin/main" : "main";
  if (refProd) {
    const rieng = git(["rev-list", `${refMain}..${refProd}`]).split(/\r?\n/).filter(Boolean);
    if (rieng.length > 0) {
      viPham.push(`\`${refProd}\` có ${rieng.length} commit KHÔNG có trên \`${refMain}\` — mã chưa từng qua CI của main.`);
    }
  }

  // (3) SHA muốn promote phải nằm trên main.
  if (shaMuonPromote) {
    const tren = git(["merge-base", "--is-ancestor", shaMuonPromote, refMain], { imLang: true });
    if (tren === null) viPham.push(`SHA ${shaMuonPromote} KHÔNG nằm trên \`${refMain}\` — không promote được.`);
  }

  // (4) Cây làm việc sạch — CHỈ bắt buộc khi thật sự promote (`--sha`).
  //
  // Chạy như gate trong CI thì cây luôn sạch, còn chạy ở máy dev giữa lúc làm
  // việc thì gần như luôn bẩn. Bắt đỏ ở chế độ không-cờ sẽ làm gate đỏ thường
  // trực rồi bị tắt — và khi ấy mất luôn ba phép kiểm phía trên.
  const ban = git(["status", "--porcelain"]).split(/\r?\n/).filter(Boolean);
  if (ban.length > 0) {
    const cau =
      `Cây làm việc có ${ban.length} thay đổi chưa commit. Promote từ thư mục đang dở nghĩa là ` +
      `thứ bạn vừa kiểm không phải thứ sẽ chạy.`;
    if (shaMuonPromote) viPham.push(cau);
    else console.log(`\n⚠ ${cau}\n   (chỉ là cảnh báo vì chưa truyền --sha; lúc promote thật thì đây là lỗi)`);
  }

  console.log(
    `Preflight promote: ${files.length} workflow · ${advisory.length} step advisory · ` +
      `${refProd ?? "(chưa có nhánh production)"} vs ${refMain}`,
  );

  if (advisory.length > 0) {
    console.log(`\n⚠ ${advisory.length} step ADVISORY — hiển thị dấu ✓ ngay cả khi đã hỏng:`);
    for (const a of advisory) {
      console.log(`   ${a.file}:${a.dong}  "${a.step ?? "?"}"  [known-gap: ${a.gapId ?? "CHƯA ĐẶT TÊN"}]`);
    }
    console.log("   KHÔNG được tính chúng là xanh khi quyết định promote (Contract §3).");
  }

  if (viPham.length > 0) {
    console.error(`\n❌ ${viPham.length} vấn đề:`);
    for (const v of viPham) console.error(`   - ${v}`);
    process.exit(1);
  }

  console.log("\n✅ Preflight cục bộ đạt.");
  console.log("   CHƯA KIỂM: trạng thái CI thật trên GitHub — việc đó cần token API repo không lưu.");
  console.log("   Đây là preflight, KHÔNG thay thế việc đọc kết quả CI. Đọc nó trước khi promote.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
