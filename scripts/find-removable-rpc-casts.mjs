#!/usr/bin/env node
// Tìm những `any`-cast quanh supabase.rpc() có thể BỎ ĐI ngay, vì generated
// types đã mô tả hàm được gọi.
//
// PHÁT HIỆN dẫn tới script này: src/integrations/supabase/types.ts hiện mô tả
// 648 function. Phần lớn cast trong repo là DI SẢN từ thời types.ts chưa có
// những hàm đó — giữ lại không còn lý do kỹ thuật, chỉ còn hậu quả: tên RPC gõ
// sai và tên tham số gõ sai đều biên dịch sạch.
//
// Đã chứng minh trên annotateMutations.ts: bỏ cast xong, đổi p_voucher thành
// p_vouchr hay đổi tên RPC đều làm tsc báo lỗi ngay. Trước đó không.
//
//   node scripts/find-removable-rpc-casts.mjs
//
// Chỉ ĐỌC và BÁO CÁO — không tự sửa file. Việc sửa nên đi từng domain kèm
// typecheck, vì đây là code sổ sách tiền thật.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = join(repoRoot, "src", "integrations", "supabase", "types.ts");

/** Tên hàm mà generated types mô tả được. */
export function knownFunctions(typesSource) {
  const start = typesSource.indexOf("Functions: {");
  if (start < 0) return new Set();
  const end = typesSource.indexOf("Enums: {", start);
  const segment = typesSource.slice(start, end > 0 ? end : undefined);
  return new Set([...segment.matchAll(/^ {6}([a-z0-9_]+): \{/gm)].map((m) => m[1]));
}

/** Rút (dòng, tên RPC) của mỗi lời gọi đi qua cast. */
export function findCastCalls(source) {
  const calls = [];
  const lines = source.split(/\r?\n/);
  // CHỈ lời gọi RPC. Bản đầu bắt cả `(supabase as any).from('rooms')` nên báo
  // 99 "phải giữ" mà thực ra là tên BẢNG (rooms, customers, invoices…) chứ không
  // phải tên hàm — một kết luận sai theo hướng làm việc trông khó hơn thực tế.
  const RPC_CAST = [
    /\(\s*supabase\s+as\s+any\s*\)\s*\.rpc\s*\(/,
    /\(\s*supabase\.rpc\s+as\s+any\s*\)\s*\(/,
    /\(\s*supabase\s+as\s+unknown\s+as[^)]*\)\s*\.rpc\s*\(/,
  ];

  for (let i = 0; i < lines.length; i += 1) {
    if (!RPC_CAST.some((re) => re.test(lines[i]))) continue;
    // Tên RPC có thể nằm cùng dòng hoặc dòng kế tiếp (prettier hay xuống dòng).
    const window = `${lines[i]} ${lines[i + 1] ?? ""} ${lines[i + 2] ?? ""}`;
    const name = /["'`]([a-z][a-z0-9_]*)["'`]/.exec(window)?.[1] ?? null;
    calls.push({ line: i + 1, name });
  }
  return calls;
}

function main() {
  const known = knownFunctions(readFileSync(TYPES, "utf8"));
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src/**/*.ts", "src/**/*.tsx"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);

  const removable = [];
  const keep = [];
  let unknownName = 0;

  for (const rel of files) {
    let source;
    try {
      source = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    for (const call of findCastCalls(source)) {
      if (!call.name) {
        unknownName += 1;
        continue;
      }
      const record = { file: rel.replace(/\\/g, "/"), line: call.line, rpc: call.name };
      if (known.has(call.name)) removable.push(record);
      else keep.push(record);
    }
  }

  console.log(`Generated types mô tả ${known.size} function.\n`);
  console.log(`✅ BỎ ĐƯỢC NGAY: ${removable.length} cast — hàm đã có trong types.ts`);
  console.log(`⏸  Phải giữ:     ${keep.length} cast — hàm CHƯA có trong types.ts`);
  if (unknownName) console.log(`❔ Không đọc được tên RPC: ${unknownName} chỗ (cần xem tay)`);

  const byFile = {};
  for (const r of removable) byFile[r.file] = (byFile[r.file] ?? 0) + 1;
  console.log("\nTop file bỏ được nhiều nhất:");
  for (const [f, n] of Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(3)}  ${f}`);
  }

  if (keep.length > 0) {
    const names = [...new Set(keep.map((k) => k.rpc))].slice(0, 12);
    console.log("\nHàm chưa có trong types.ts (giữ cast, hoặc dùng facade):");
    for (const n of names) console.log(`  - ${n}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
