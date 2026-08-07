#!/usr/bin/env node
// Gate cho contracts/surfaces/rpc-surface.json — hợp đồng ở biên chuỗi.
//
// KIỂM BA THỨ, và thứ thứ nhất là lý do file này tồn tại:
//
//   (1) KHÔNG call site nào gọi một RPC mà server KHÔNG CÓ.
//       Đây là lớp lỗi mà không gì khác trong repo bắt được: `supabase.rpc('ten')`
//       là một CHUỖI. types.ts có kiểu RPC, nhưng nó chỉ che phần src/ được tsc
//       soi — Edge Function chạy Deno, services/ và infra/ nằm ngoài hoàn toàn.
//       Ở đó gõ sai một ký tự vẫn biên dịch sạch và chỉ nổ lúc chạy, trên dữ liệu
//       thật, trong một nhánh code có thể vài tháng mới đi qua một lần.
//
//   (2) MANIFEST KHÔNG ĐƯỢC TRÔI khỏi thực tế.
//       Manifest cũ mà không ai sinh lại thì tệ hơn không có manifest: nó trông
//       như bằng chứng. Gate sinh lại từ hai nguồn rồi so — lệch là đỏ.
//
//   (3) RPC SECURITY DEFINER trong bề mặt phải GHIM search_path.
//       DEFINER chạy bằng quyền chủ hàm; không ghim search_path thì người gọi
//       chèn được schema của mình vào trước và cướp quyền đó. Repo đã có invariant
//       này ở mức catalog, nhưng ở đây nó gắn với ĐÚNG những hàm mà client gọi.
//
//   node scripts/check-rpc-surface.mjs
//
// Cần SUPABASE_PAT. Thoát 0 đạt · 1 vi phạm · 3 không kiểm được.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DUONG_DAN,
  SQL_CATALOG,
  dungManifest,
  hoiCatalog,
  lietKeFile,
  pat,
  timCallSite,
} from "./generate-rpc-surface.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Sàn chống rỗng-vô-nghĩa.
 *
 * Nếu bộ dò call site hỏng (đổi regex, git ls-files trả rỗng) thì tập RPC thành
 * rỗng, mọi vòng lặp chạy 0 lần và gate in dấu tick. Repo CHẮC CHẮN gọi hàng
 * trăm RPC — con số nhỏ nghĩa là phép đo hỏng, không phải "không có vi phạm".
 */
export const TOI_THIEU_RPC = 150;
export const TOI_THIEU_HAM_CATALOG = 500;

/** So hai manifest ở phần ỔN ĐỊNH, bỏ qua thứ đổi theo mỗi lần chạy. */
export function soManifest(cu, moi) {
  const lech = [];
  const tenCu = Object.keys(cu.rpcs ?? {}).sort();
  const tenMoi = Object.keys(moi.rpcs ?? {}).sort();

  for (const t of tenMoi) if (!tenCu.includes(t)) lech.push(`+ RPC mới được gọi: ${t}`);
  for (const t of tenCu) if (!tenMoi.includes(t)) lech.push(`- RPC không còn được gọi: ${t}`);

  for (const t of tenMoi.filter((x) => tenCu.includes(x))) {
    const a = JSON.stringify(cu.rpcs[t].definitions);
    const b = JSON.stringify(moi.rpcs[t].definitions);
    if (a !== b) lech.push(`~ ${t}: chữ ký/volatility/definer/search_path đã đổi trên server`);
    const ca = JSON.stringify(cu.rpcs[t].callers);
    const cb = JSON.stringify(moi.rpcs[t].callers);
    if (ca !== cb) lech.push(`~ ${t}: danh sách nơi gọi đã đổi`);
    if (cu.rpcs[t].risk !== moi.rpcs[t].risk) lech.push(`~ ${t}: mức rủi ro ${cu.rpcs[t].risk} → ${moi.rpcs[t].risk}`);
  }
  return lech;
}

/** DEFINER trong bề mặt mà không ghim search_path. */
export function timDefinerHoSearchPath(rpcs) {
  const ra = [];
  for (const [ten, r] of Object.entries(rpcs)) {
    for (const d of r.definitions) {
      if (d.securityDefiner && !d.searchPath) ra.push(`${ten}(${d.args})`);
    }
  }
  return ra.sort();
}

async function main() {
  if (!pat()) {
    console.error("=== ⚠ KHÔNG KIỂM ĐƯỢC — KHÔNG PHẢI PASS ===");
    console.error("  Thiếu SUPABASE_PAT (env) hoặc CLAUDE.local.md.");
    process.exit(3);
  }

  let cu;
  try {
    cu = JSON.parse(readFileSync(join(repoRoot, DUONG_DAN), "utf8"));
  } catch (e) {
    console.error(`❌ Không đọc được ${DUONG_DAN}: ${e.message}`);
    console.error("   Sinh lần đầu: node scripts/generate-rpc-surface.mjs");
    process.exit(3);
  }

  const doc = (f) => {
    try {
      return readFileSync(join(repoRoot, f), "utf8");
    } catch {
      return null;
    }
  };
  const hang = await hoiCatalog(SQL_CATALOG);
  const files = lietKeFile();
  const goi = timCallSite(doc, files);
  const { rpcs, thieuTrenServer } = dungManifest(hang, goi);

  if (hang.length < TOI_THIEU_HAM_CATALOG) {
    console.error(`❌ Catalog chỉ trả ${hang.length} hàm (sàn ${TOI_THIEU_HAM_CATALOG}) — phép đo hỏng.`);
    process.exit(3);
  }
  if (Object.keys(rpcs).length + thieuTrenServer.length < TOI_THIEU_RPC) {
    console.error(
      `❌ Chỉ dò được ${Object.keys(rpcs).length} RPC từ ${files.length} file (sàn ${TOI_THIEU_RPC}) — bộ dò hỏng.`,
    );
    console.error(`   "0 vi phạm" trên một tập rỗng là câu đúng mà vô nghĩa.`);
    process.exit(3);
  }

  console.log(`Bề mặt RPC: ${Object.keys(rpcs).length} RPC được gọi · ${hang.length} hàm catalog · ${files.length} file quét`);

  let hong = 0;

  // (1) Gọi vào hư không.
  if (thieuTrenServer.length > 0) {
    console.error(`\n❌ ${thieuTrenServer.length} RPC được gọi mà SERVER KHÔNG CÓ:`);
    for (const t of thieuTrenServer.slice(0, 20)) {
      console.error(`   - ${t.name}  ← ${t.callers.slice(0, 3).join(", ")}`);
    }
    console.error("\n  Chuỗi này biên dịch sạch và chỉ nổ lúc chạy. Sửa tên, hoặc apply migration còn thiếu.");
    hong = 1;
  }

  // (2) Manifest trôi.
  const lech = soManifest(cu, { rpcs });
  if (lech.length > 0) {
    console.error(`\n❌ Manifest đã trôi khỏi thực tế ở ${lech.length} chỗ:`);
    for (const l of lech.slice(0, 25)) console.error(`   ${l}`);
    if (lech.length > 25) console.error(`   … và ${lech.length - 25} dòng nữa`);
    console.error("\n  Sinh lại rồi ĐỌC DIFF trước khi commit: node scripts/generate-rpc-surface.mjs");
    console.error("  Một manifest cũ tệ hơn không có manifest — nó trông như bằng chứng.");
    hong = 1;
  }

  // (3) DEFINER hở search_path.
  const ho = timDefinerHoSearchPath(rpcs);
  if (ho.length > 0) {
    console.error(`\n❌ ${ho.length} RPC SECURITY DEFINER trong bề mặt KHÔNG ghim search_path:`);
    for (const t of ho.slice(0, 15)) console.error(`   - ${t}`);
    console.error("  DEFINER chạy bằng quyền chủ hàm; không ghim search_path thì người gọi chèn được");
    console.error("  schema của mình vào trước và cướp đúng quyền đó.");
    hong = 1;
  }

  if (hong) process.exit(1);
  const rr = Object.values(rpcs).reduce((a, r) => ({ ...a, [r.risk]: (a[r.risk] ?? 0) + 1 }), {});
  console.log(
    `✅ Bề mặt khớp thực tế: 0 gọi hụt · 0 trôi · 0 DEFINER hở search_path. ` +
      `Rủi ro: ${Object.entries(rr).map(([k, v]) => `${k} ${v}`).join(" · ")}.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`❌ Lỗi không lường trước: ${e.message}`);
    process.exit(3);
  });
}
