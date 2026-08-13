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
// Thoát 0 = sạch · 1 = có gate đỏ (chi tiết in ở phần tóm tắt).

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── Bước 1: máy sinh số — chạy TRƯỚC để gate phía dưới đo bản đã tươi ────────
const TU_CHUA = [
  ["sinh kiểm kê repo (JSON)", ["scripts/generate-repository-inventory.mjs", "--write"]],
  ["sinh bản .md render từ manifest", ["scripts/generate-docs-views.mjs"]],
  ["sửa số đếm trong tài liệu", ["scripts/check-doc-counts.mjs", "--fix"]],
];

// ── Bước 2: gate tĩnh, thứ tự khớp ci-gates.yml để dễ đối chiếu ──────────────
const GATE_NHANH = [
  "check-openclaw-isolation",
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

const trangThaiGit = () =>
  spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).stdout ?? "";

function main() {
  const boDaoStrict = process.argv.includes("--khong-dao-strict");
  const t0 = Date.now();

  console.log("── Bước 1/2: máy tự sinh số ──");
  const truoc = trangThaiGit();
  const loiTuChua = [];
  for (const [ten, args] of TU_CHUA) {
    const r = chay(args);
    if (r.status === 0) console.log(`  ✅ ${ten}`);
    else {
      loiTuChua.push([ten, r]);
      console.log(`  ❌ ${ten} (exit ${r.status})`);
    }
  }
  const sau = trangThaiGit();
  const fileMoiDoi = sau
    .split("\n")
    .filter((l) => l && !truoc.includes(l))
    .map((l) => l.slice(3));
  if (fileMoiDoi.length > 0) {
    console.log(`  ✍ generator vừa cập nhật ${fileMoiDoi.length} file — NHỚ stage kèm commit:`);
    for (const f of fileMoiDoi) console.log(`      ${f}`);
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
  if (doSo.length === 0 && loiTuChua.length === 0) {
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
}

main();
