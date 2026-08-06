#!/usr/bin/env node
// Ratchet cho các lời gọi RPC đi vòng qua kiểu: `(supabase as any).rpc(...)` và
// `(supabase.rpc as any)(...)`.
//
// VÌ SAO: hai dạng cast này tắt hoàn toàn kiểm tra kiểu ở đúng chỗ nguy hiểm
// nhất — tên RPC gõ sai hoặc tham số sai tên vẫn biên dịch sạch, và chỉ lộ ra
// khi chạy thật. Repo có 176 chỗ như vậy trên 67 file, dày nhất ở nhóm tiền
// (useInvoices 15, statusMutations 12, usePeriodFees 9…).
//
// Sửa hết trong một đợt là refactor xuyên hệ thống trên code sổ sách tiền thật —
// rủi ro cao hơn lợi ích. Thứ rẻ mà hiệu quả là CHẶN NÓ TĂNG: file mới không
// được có cast, file cũ không được thêm cast. Con số chỉ được đi xuống.
//
//   node scripts/check-rpc-cast-ratchet.mjs           # kiểm theo baseline
//   node scripts/check-rpc-cast-ratchet.mjs --write   # ghi lại baseline (chỉ khi GIẢM)
//
// Không cần credential, không đọc database.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(repoRoot, "tooling", "rpc-cast-baseline.json");

/**
 * Cố ý KHÔNG khoá vào riêng `.rpc`.
 *
 * Bản đầu chỉ bắt `.rpc`, và nó báo 0 trong khi repo vẫn còn 7 chỗ
 * `(supabase as any).from(...)` trên 6 file — cùng một cast, cùng một hậu quả
 * (tên bảng gõ sai vẫn biên dịch sạch), chỉ khác tên phương thức. Một trong số
 * đó ở src/lib/push.ts còn kèm comment giải thích rằng `push_subscriptions`
 * "chưa có trong Database types" — lời giải thích SAI, bảng đó nằm ở types.ts
 * dòng 19292 và cast bỏ đi không sinh lỗi nào.
 *
 * Nên bắt theo BẢN CHẤT: ép `supabase` (hoặc một phương thức của nó) về `any`
 * rồi gọi. `(?:\.\w+)+\s*\(` buộc phải có lời gọi thật phía sau — nhờ vậy các
 * đoạn văn xuôi trong comment nhắc tới cast (repo có 4 chỗ) không bị đếm nhầm.
 */
const PATTERNS = [
  // (supabase as any).rpc(…) · .from(…) · .storage.from(…) · .channel(…)
  /\(\s*supabase\s+as\s+any\s*\)\s*(?:\.\w+)+\s*\(/g,
  // (supabase.rpc as any)(…) · (supabase.from as any)(…)
  /\(\s*supabase\.\w+\s+as\s+any\s*\)\s*\(/g,
  // (supabase as unknown as {...}).rpc(…) — biến thể dài dòng cùng bản chất
  /\(\s*supabase\s+as\s+unknown\s+as[^)]*\)\s*(?:\.\w+)+\s*\(/g,
];

export function countCasts(source) {
  let n = 0;
  for (const re of PATTERNS) n += (source.match(re) ?? []).length;
  return n;
}

export function scanRepo() {
  const files = execFileSync("git", ["ls-files", "src/**/*.ts", "src/**/*.tsx"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);

  const perFile = {};
  let total = 0;
  for (const rel of files) {
    let source;
    try {
      source = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    const n = countCasts(source);
    if (n > 0) {
      perFile[rel.replace(/\\/g, "/")] = n;
      total += n;
    }
  }
  return { perFile, total };
}

export function compare(baseline, current) {
  const problems = [];
  let improved = 0;

  for (const [file, n] of Object.entries(current.perFile)) {
    const was = baseline.perFile[file] ?? 0;
    if (was === 0) {
      problems.push(
        `${file}: ${n} lời gọi RPC dùng any-cast trong file CHƯA có trong baseline.\n` +
        `      → dùng facade typed của domain (xem src/hooks/openclaw-zalo/openClawRpc.ts làm mẫu),\n` +
        `        hoặc gọi supabase.rpc() trực tiếp nếu generated types đã mô tả được hàm đó.`,
      );
    } else if (n > was) {
      problems.push(`${file}: any-cast TĂNG ${was} → ${n}. Ratchet chỉ cho phép đi xuống.`);
    } else if (n < was) {
      improved += was - n;
    }
  }

  for (const [file, was] of Object.entries(baseline.perFile)) {
    if (!(file in current.perFile) && was > 0) improved += was;
  }

  return { problems, improved };
}

function main(argv) {
  const current = scanRepo();

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    baseline = null;
  }

  if (!baseline || argv.includes("--init")) {
    writeFileSync(
      BASELINE,
      `${JSON.stringify(
        {
          $comment:
            "Ratchet any-cast RPC. Con số CHỈ ĐƯỢC GIẢM. Thêm cast mới ⇒ CI đỏ. Sinh bởi scripts/check-rpc-cast-ratchet.mjs.",
          total: current.total,
          perFile: current.perFile,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`✅ Đã khởi tạo baseline: ${current.total} cast trên ${Object.keys(current.perFile).length} file.`);
    return 0;
  }

  const { problems, improved } = compare(baseline, current);

  if (problems.length > 0) {
    console.error("❌ Ratchet any-cast RPC bị vi phạm:\n");
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      `\n  Baseline ${baseline.total} → hiện tại ${current.total}.\n` +
      "  Hai dạng cast này tắt kiểm tra kiểu ở đúng chỗ nguy hiểm nhất: tên RPC sai\n" +
      "  hay tham số sai tên vẫn biên dịch sạch, chỉ lộ khi chạy thật.",
    );
    process.exitCode = 1;
    return 1;
  }

  console.log(`✅ Any-cast RPC: ${current.total} (baseline ${baseline.total}), không có file nào tăng.`);
  if (improved > 0) {
    console.log(`   🎉 Giảm ${improved} chỗ so với baseline — chạy --write để chốt mức mới.`);
    if (argv.includes("--write")) {
      writeFileSync(
        BASELINE,
        `${JSON.stringify({ ...baseline, total: current.total, perFile: current.perFile }, null, 2)}\n`,
        "utf8",
      );
      console.log("   ✅ Đã hạ baseline.");
    }
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
