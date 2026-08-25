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
// Mục có `mang: true` gọi ra ngoài (Supabase catalog / DB thật) — hỏng thì cảnh
// báo ⚠ chứ không chặn: offline không phải lỗi của code. Nhưng nếu bạn VỪA đổi
// schema/RPC thì phải chạy lại khi có mạng — CI sẽ đo bằng catalog live.
//
// Vì sao types + surface nằm đây (thêm 25/08/2026): mổ xẻ 17 lần CI đỏ từ
// 20–25/08 thì 12 lần do số đếm tài liệu, 8 lần do types.ts trôi, 3 lần do
// manifest bề mặt RPC trôi — toàn bộ là artifact MÁY SỞ HỮU mà quy trình lại
// bắt con người nhớ chạy đúng 5 lệnh đúng thứ tự. Từ nay một lệnh này làm hết.
const TU_CHUA = [
  ["sinh types.ts từ DB thật (gen:types)", ["scripts/gen-supabase-types.mjs"], { mang: true }],
  ["chuẩn hoá types.ts (bỏ partition + ghim phiên bản nền tảng)", ["scripts/normalize-supabase-types.mjs", "--write"]],
  ["sinh manifest bề mặt RPC", ["scripts/generate-rpc-surface.mjs"], { mang: true }],
  ["sinh manifest bề mặt Edge", ["scripts/generate-edge-surface.mjs"], { mang: true }],
  ["sinh manifest bề mặt realtime", ["scripts/generate-realtime-surface.mjs"], { mang: true }],
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
  const canhBaoMang = [];
  for (const [ten, args, tuyChon] of TU_CHUA) {
    const r = chay(args);
    if (r.status === 0) console.log(`  ✅ ${ten}`);
    else if (tuyChon?.mang) {
      canhBaoMang.push(ten);
      console.log(`  ⚠ ${ten} (exit ${r.status}) — cần mạng/PAT; nếu bạn vừa đổi schema/RPC thì PHẢI chạy lại khi có mạng`);
    } else {
      loiTuChua.push([ten, r]);
      console.log(`  ❌ ${ten} (exit ${r.status})`);
    }
  }
  const sau = trangThaiGit();
  // Tập cần stage = (file đổi TRONG lượt này) ∪ (file bẩn dưới docs/generated/).
  //
  // Vế hai cần thiết vì phép so trước/sau chỉ thấy thay đổi của ĐÚNG lượt đang
  // chạy. Chạy lệnh này hai lần liên tiếp thì lượt thứ hai không sinh gì mới,
  // nên file bẩn từ lượt trước sẽ trượt khỏi tầm — rồi commit thiếu, rồi CI đỏ.
  // docs/generated/ hoàn toàn do máy sinh (mọi file ở đó có generator riêng),
  // nên gom cả file bẩn ở đó là an toàn, không đụng vào mã người viết.
  const doiTrongLuot = sau
    .split("\n")
    .filter((l) => l && !truoc.includes(l))
    .map((l) => l.slice(3));
  const banSinhTuDong = sau
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => l.slice(3))
    // schema-change-evidence/ cặp đôi với MỘT migration cụ thể và phải đi cùng
    // commit của migration đó — tự quét ở đây dễ tạo evidence mồ côi khi file
    // .sql tương ứng còn nằm ngoài stage (đã suýt xảy ra 25/08/2026).
    .filter((f) => f.startsWith("docs/generated/") && !f.startsWith("docs/generated/schema-change-evidence/"));
  const fileMoiDoi = [...new Set([...doiTrongLuot, ...banSinhTuDong])].sort();
  // TỰ STAGE, không chỉ nhắc.
  //
  // Bản cũ in "NHỚ stage kèm commit" rồi phó mặc cho trí nhớ con người. Trí nhớ
  // thua: đo 25/08/2026 trên `git log -- src/integrations/supabase/types.ts` và
  // docs/generated/, có 4 commit `fix(ci)` chỉ để dán lại thứ máy tự sinh được —
  // mỗi lần là một vòng push-chờ-CI 12 phút cho một phép cộng.
  //
  // Đây KHÔNG phải agent tự ý commit hộ: nó chỉ `git add` những file mà generator
  // của chính repo vừa ghi ra ở Bước 1, và chỉ khi người dùng đã tự tay chạy lệnh
  // này. Nội dung do máy sở hữu; con người không nên là người làm phép cộng cho gate.
  //
  // Thứ tự quan trọng: stage TRƯỚC Bước 2. check-doc-counts đếm bằng `git ls-files`
  // nên một file chưa `git add` sẽ không được tính — chạy gate trước khi stage cho
  // ra kết quả "khớp" GIẢ rồi CI đỏ.
  if (fileMoiDoi.length > 0) {
    const add = spawnSync("git", ["add", "--", ...fileMoiDoi], { cwd: repoRoot, encoding: "utf8" });
    if (add.status === 0) {
      console.log(`  ✍ generator cập nhật ${fileMoiDoi.length} file — ĐÃ tự \`git add\` (nội dung do máy sinh):`);
    } else {
      console.log(`  ✍ generator cập nhật ${fileMoiDoi.length} file — KHÔNG tự stage được (${add.stderr?.trim() || "git lỗi"}), stage tay:`);
    }
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
