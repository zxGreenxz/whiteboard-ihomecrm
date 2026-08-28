#!/usr/bin/env node
// Sinh bản ĐỌC ĐƯỢC BẰNG MẮT từ các manifest máy-đọc (plan §10, §51).
//
// VÌ SAO CẦN, dù JSON đã có sẵn
//   contracts/surfaces/rpc-surface.json là 94 KB. Không ai đọc nó. Nhưng câu hỏi
//   mà nó trả lời được — "RPC nào chạm tiền, ai gọi, hàm nào SECURITY DEFINER" —
//   là câu người ta hỏi khi rà an ninh hoặc khi nhận bàn giao.
//
//   Một manifest không ai đọc thì chỉ phục vụ gate. Bản .md này phục vụ NGƯỜI, và
//   nó SINH RA từ đúng manifest đó nên không thể lệch.
//
// KHÔNG VIẾT TAY. Mọi con số ở đây đến từ JSON; sửa tay là tạo nguồn thứ hai.
//
//   node scripts/generate-docs-views.mjs
//   node scripts/generate-docs-views.mjs --check   # đỏ nếu bản .md đã trôi
//
// Không cần credential. Thoát 0 · 1 (trôi ở chế độ --check) · 3.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(repoRoot, "docs", "generated");

const doc = (p) => JSON.parse(readFileSync(join(repoRoot, p), "utf8"));
const NHAN_RUI_RO = { financial: "tiền", security: "an ninh", infrastructure: "hạ tầng", normal: "thường" };

/** Bảng Markdown; escape `|` để một tên có dấu gạch đứng không phá cột. */
function bang(cot, hang) {
  const esc = (v) => String(v).replace(/\|/g, "\\|");
  return [
    `| ${cot.join(" | ")} |`,
    `|${cot.map(() => "---").join("|")}|`,
    ...hang.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ].join("\n");
}

function dauTrang(nguon) {
  return [
    "---",
    "status: current",
    // KHÔNG đóng dấu `reviewed: <hôm nay>` nữa (bỏ 26/08/2026). Dấu ngày làm cả
    // ba file bẩn MỖI NGÀY chạy generator dù nội dung không đổi một chữ — rồi bị
    // gate:truoc-push tự stage, rồi đi vào commit như thay đổi giả. Chế độ
    // --check vốn đã bỏ qua dòng này khi so, tức nó chưa từng là dữ liệu ai đọc.
    // Ngày review thật của NGUỒN nằm trong docs/he-thong/manifest.json.
    "source_paths:",
    ...nguon.map((s) => `  - ${s}`),
    "copilot_ingest: false",
    "risk: normal",
    "---",
    "",
    "> **SINH TỰ ĐỘNG — đừng sửa tay.** `node scripts/generate-docs-views.mjs`",
    "> Sửa ở đây tạo nguồn sự thật thứ hai, và nó sẽ trôi khỏi manifest trong vài ngày.",
    "",
  ].join("\n");
}

/**
 * Bản người-đọc của docs/generated/repository-inventory.json.
 *
 * Con số quan trọng nhất ở đây là `khongPhanLoaiDuoc`, và nó phải nằm NGAY đầu
 * chứ không nằm cuối bảng: bộ kiểm kê không dùng AST nên có phần nó mù, và một
 * bản .md chỉ khoe những gì đếm được sẽ đọc thành "đã phủ hết".
 */
export function dungRepositoryInventory(m) {
  const loai = Object.entries(m.theoLoai ?? {}).sort((a, b) => b[1].soFile - a[1].soFile);
  return [
    dauTrang(["docs/generated/repository-inventory.json"]),
    "# Kiểm kê: test nào đọc MÃ NGUỒN thay vì import nó",
    "",
    "Một test đọc `src/App.tsx` rồi khẳng định trên VĂN BẢN của nó không kiểm hành vi —",
    "nó kiểm cách viết. Refactor không đổi hành vi vẫn làm nó đỏ; và refactor CÓ đổi hành",
    "vi vẫn để nó xanh nếu chuỗi được tìm còn nguyên.",
    "",
    `- **${m.tongSoFileTest}** file test, **${m.soFileDocBangFs}** file đọc file bằng fs (${m.tongLoiGoi} lời gọi)`,
    `- **${m.khongPhanLoaiDuoc}** lời gọi **KHÔNG phân loại được** — đường dẫn dựng lúc chạy.`,
    "  Đây là giới hạn của phép đo, không phải \"không có gì\". Bộ kiểm kê không dùng AST",
    "  (để chạy được ở mọi runner không cần parser TypeScript), nên nó phải nói ra chỗ mình mù.",
    "",
    "## Theo loại file được đọc",
    "",
    bang(
      ["Loại", "Số file", "Vì sao đáng/không đáng lo"],
      loai.map(([ten, v]) => [ten, v.soFile, v.moTa]),
    ),
    "",
    `## ${(m.testDocMaNguon ?? []).length} file đọc MÃ NGUỒN`,
    "",
    "Đây là danh sách §0.2/C10 cần: những file nên chuyển sang data-driven.",
    "",
    ...(m.testDocMaNguon ?? []).map((f) => `- \`${f}\``),
    "",
  ].join("\n");
}

export function dungRpcSurface(m) {
  const rpcs = Object.entries(m.rpcs);
  const theoRuiRo = {};
  for (const [, r] of rpcs) theoRuiRo[r.risk] = (theoRuiRo[r.risk] ?? 0) + 1;

  const definer = rpcs.filter(([, r]) => r.definitions.some((d) => d.securityDefiner));
  const tien = rpcs.filter(([, r]) => r.risk === "financial").sort((a, b) => a[0].localeCompare(b[0]));
  const anNinh = rpcs.filter(([, r]) => r.risk === "security").sort((a, b) => a[0].localeCompare(b[0]));

  return [
    dauTrang(["contracts/surfaces/rpc-surface.json"]),
    "# Bề mặt RPC — TypeScript gọi gì trên PostgreSQL",
    "",
    "Biên này là **một chuỗi ký tự**: `supabase.rpc('ten_ham')`. Không trình biên dịch",
    "nào chứng minh tên đó tồn tại trên server — types.ts chỉ che phần `src/` mà tsc soi,",
    "còn Edge Function (Deno), `services/` và `infra/` nằm ngoài hoàn toàn.",
    "",
    bang(
      ["Chỉ số", "Giá trị"],
      [
        ["RPC được gọi từ mã nguồn", rpcs.length],
        ["Hàm trong catalog (public + api)", m.generatedFrom.catalogFunctions],
        ["File mã nguồn đã quét", m.generatedFrom.sourceCallSites],
        ["SECURITY DEFINER", definer.length],
        ["**Gọi mà server KHÔNG CÓ**", `**${m.missingOnServer.length}**`],
      ],
    ),
    "",
    "## Theo mức rủi ro",
    "",
    bang(
      ["Mức", "Số RPC", "Nghĩa là"],
      Object.entries(theoRuiRo)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [
          NHAN_RUI_RO[k] ?? k,
          v,
          k === "financial"
            ? "có nơi gọi nằm trong màn tiền — sai là sai sổ sách"
            : k === "security"
              ? "nơi gọi thuộc OpenClaw"
              : k === "infrastructure"
                ? "nơi gọi thuộc Network Center"
                : "còn lại",
        ]),
    ),
    "",
    `## ${tien.length} RPC chạm TIỀN`,
    "",
    "Đây là danh sách đáng đọc nhất trong trang này: mỗi dòng là một đường ghi hoặc",
    "đọc có thể làm lệch số trên sổ.",
    "",
    bang(
      ["RPC", "DEFINER", "Nơi gọi"],
      tien.map(([ten, r]) => [
        `\`${ten}\``,
        r.definitions.some((d) => d.securityDefiner) ? "✔" : "",
        r.callers.map((c) => c.replace(/^src\//, "")).slice(0, 3).join(", ") +
          (r.callers.length > 3 ? ` … (+${r.callers.length - 3})` : ""),
      ]),
    ),
    "",
    `## ${anNinh.length} RPC thuộc OpenClaw`,
    "",
    bang(["RPC", "Nơi gọi"], anNinh.map(([ten, r]) => [`\`${ten}\``, r.callers.join(", ")])),
    "",
  ].join("\n");
}

export function dungCapabilityMatrix(registrySrc, edgeM, rtM) {
  const caps = [];
  for (const khoi of registrySrc.split(/\n\s*\{\s*\n/).slice(1)) {
    const id = khoi.match(/id:\s*"([^"]+)"/)?.[1];
    if (!id) continue;
    caps.push({
      id,
      route: khoi.match(/primaryRoute:\s*"([^"]+)"/)?.[1] ?? "?",
      label: khoi.match(/label:\s*"([^"]+)"/)?.[1] ?? "?",
      module: khoi.match(/module:\s*"([^"]+)"/)?.[1] ?? "?",
      action: khoi.match(/action:\s*"([^"]+)"/)?.[1] ?? "?",
      risk: khoi.match(/risk:\s*"([^"]+)"/)?.[1] ?? "?",
      doc: khoi.match(/systemDoc:\s*"([^"]+)"/)?.[1] ?? "?",
    });
  }

  const chuaDeploy = edgeM.sourceWithoutDeployment ?? [];
  const congKhai = Object.entries(edgeM.functions ?? {})
    .filter(([, f]) => f.deployed && f.verifyJwt === false)
    .map(([s]) => s);

  return [
    dauTrang([
      "src/app/capabilities/registry.ts",
      "contracts/surfaces/edge-function-surface.json",
      "contracts/surfaces/realtime-surface.json",
    ]),
    "# Ma trận bề mặt sản phẩm",
    "",
    "## Capability khai trong registry",
    "",
    "Registry hiện phủ **" + caps.length + "** capability. Toàn app có ~146 route —",
    "phần còn lại vẫn khai tay ở từng nơi. Đây là trạng thái CÓ CHỦ Ý: registry bắt",
    "đầu từ hai capability đã drift thật, mở rộng là việc riêng.",
    "",
    bang(
      ["Capability", "Route", "Quyền", "Rủi ro", "Tài liệu"],
      caps.map((c) => [c.label, `\`${c.route}\``, `\`${c.module}.${c.action}\``, NHAN_RUI_RO[c.risk] ?? c.risk, c.doc]),
    ),
    "",
    "## Edge Function",
    "",
    bang(
      ["Chỉ số", "Giá trị"],
      [
        ["Thư mục mã nguồn", edgeM.counts.source],
        ["ĐANG CHẠY trên server", edgeM.counts.deployed],
        ["Có mã mà **chưa deploy**", `${chuaDeploy.length}${chuaDeploy.length ? " — " + chuaDeploy.join(", ") : ""}`],
        ["`verify_jwt = false` (ai cũng gọi được)", `${congKhai.length}${congKhai.length ? " — " + congKhai.join(", ") : ""}`],
      ],
    ),
    "",
    "Thư mục trong repo **không** có nghĩa là hàm đang chạy: deploy là thao tác riêng,",
    "không gắn với `git push`.",
    "",
    "## Realtime",
    "",
    bang(
      ["Chỉ số", "Giá trị"],
      [
        ["Bảng được publish", rtM.counts.published],
        ["Hub nghiệp vụ lắng nghe", rtM.counts.listenedByHub],
        ["**Hub nghe mà KHÔNG publish** (subscribe câm)", `**${(rtM.hubWithoutPublication ?? []).length}**`],
        ["`REPLICA IDENTITY = DEFAULT`", `${rtM.counts.replicaIdentityDefault}/${rtM.counts.published}`],
      ],
    ),
    "",
    "`DEFAULT` nghĩa là payload `UPDATE`/`DELETE` chỉ mang **khoá chính**. Code đọc cột",
    "khác từ payload đó nhận `undefined` — không lỗi, chỉ là một nhánh đi sai đường.",
    "",
  ].join("\n");
}

/**
 * Danh sách bản .md mà generator này SỞ HỮU — kiem-nhanh-truoc-push đọc để
 * biết được phép tự stage những file nào (allowlist theo sở hữu, 28/08/2026).
 * Thêm view mới thì thêm ở đây, đừng chép tay đường dẫn sang runner.
 */
export const DANH_SACH_VIEW = [
  "docs/generated/rpc-surface.md",
  "docs/generated/repository-inventory.md",
  "docs/generated/capability-matrix.md",
];

function main() {
  const canCo = [
    "contracts/surfaces/rpc-surface.json",
    "contracts/surfaces/edge-function-surface.json",
    "contracts/surfaces/realtime-surface.json",
  ];
  const thieu = canCo.filter((p) => !existsSync(join(repoRoot, p)));
  if (thieu.length > 0) {
    console.error(`❌ Thiếu manifest nguồn: ${thieu.join(", ")}`);
    console.error("   Sinh trước: npm run surface:rpc / surface:edge / surface:realtime");
    process.exit(3);
  }

  const ra = {
    "rpc-surface.md": dungRpcSurface(doc(canCo[0])),
    "repository-inventory.md": dungRepositoryInventory(doc("docs/generated/repository-inventory.json")),
    "capability-matrix.md": dungCapabilityMatrix(
      readFileSync(join(repoRoot, "src/app/capabilities/registry.ts"), "utf8"),
      doc(canCo[1]),
      doc(canCo[2]),
    ),
  };

  const kiem = process.argv.includes("--check");
  mkdirSync(OUT, { recursive: true });
  const troi = [];
  for (const [ten, noiDung] of Object.entries(ra)) {
    const p = join(OUT, ten);
    // Chuẩn hoá TRƯỚC KHI SO, hai thứ, mỗi thứ chặn một kiểu đỏ giả:
    //
    //   (1) dòng `reviewed:` — generator đóng dấu ngày hiện tại nên nó đổi mỗi
    //       ngày mà không nói gì về nội dung.
    //
    //   (2) CRLF — và đây mới là cái đã cắn thật. `core.autocrlf=true` trên máy
    //       Windows nên git tái tạo file từ blob thành CRLF, còn generator luôn
    //       sinh LF. Đo 08/08/2026: sau `git checkout` file có 126 CRLF / 0 LF
    //       đơn, và `--check` báo trôi dù nội dung giống hệt từng chữ. Hệ quả:
    //       gate ĐỎ TRÊN MỌI MÁY WINDOWS sau bất kỳ checkout nào, nhưng XANH trên
    //       CI Linux.
    //
    //       Tệ gấp đôi mức "gây phiền": khi một gate luôn đỏ vì lý do không có
    //       thật, "trên Windows nó luôn đỏ" trở thành lời giải thích cho MỌI lần
    //       đỏ — kể cả lần nội dung trôi thật. Đây đúng là hạng lỗi mà
    //       configDigestNote trong tooling/graph-manifests/ua.json đã ghi cho một
    //       chỗ khác: so nội dung worktree trên Windows là so cả ký tự xuống dòng.
    const bo = (s) => s.replace(/\r\n/g, "\n").replace(/^reviewed: .*$/m, "");
    if (kiem) {
      const cu = existsSync(p) ? readFileSync(p, "utf8") : "";
      if (bo(cu) !== bo(noiDung)) troi.push(ten);
    } else {
      writeFileSync(p, noiDung);
      console.log(`✅ docs/generated/${ten}`);
    }
  }

  if (kiem) {
    if (troi.length > 0) {
      console.error(`❌ ${troi.length} bản .md đã trôi khỏi manifest: ${troi.join(", ")}`);
      console.error("   Sinh lại: node scripts/generate-docs-views.mjs");
      process.exit(1);
    }
    console.log("✅ Bản .md khớp manifest.");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
