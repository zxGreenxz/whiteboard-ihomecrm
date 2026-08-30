#!/usr/bin/env node
// Sinh contracts/surfaces/rpc-surface.json — biên GIỮA TypeScript và PostgreSQL,
// nơi hợp đồng hiện đang là MỘT CHUỖI.
//
// VÌ SAO CẦN (plan §P1.7, §9)
//   `supabase.rpc('ten_ham')` là một string. Không trình biên dịch nào, không
//   graph code nào, không test đơn vị nào chứng minh được `ten_ham` có tồn tại
//   trên server. types.ts có kiểu cho RPC, nhưng nó chỉ che phần src/ được tsc
//   soi — Edge Function (Deno), services/ và infra/ nằm ngoài. Ở đó một chuỗi gõ
//   sai biên dịch sạch và chỉ nổ lúc chạy, trên dữ liệu thật.
//
// HAI NGUỒN, BẮT BUỘC
//   Plan §P1.7 chốt manifest phải sinh từ HAI nguồn và đỏ khi giao nhau sai:
//     (1) call site trong mã nguồn;
//     (2) catalog LIVE đã normalize.
//   Không sinh từ văn bản migration: 628 file không khớp ledger chính xác và
//   nhiều object đã được apply ngoài luồng.
//
// PHẠM VI: chỉ ghi những RPC ĐANG ĐƯỢC GỌI, không ghi cả 1040 hàm.
//   Bề mặt là thứ client phụ thuộc vào. Ghi hết catalog sẽ tạo một file khổng lồ
//   đổi theo mọi migration nội bộ, và người ta sẽ ngừng đọc diff của nó — đúng
//   thứ manifest sinh ra để tránh.
//
//   node scripts/generate-rpc-surface.mjs          # ghi manifest
//   node scripts/generate-rpc-surface.mjs --in     # in ra, không ghi
//
// Cần SUPABASE_PAT (hoặc CLAUDE.local.md khi chạy local). CHỈ ĐỌC catalog.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DUONG_DAN = join("contracts", "surfaces", "rpc-surface.json");

/** Schema mà PostgREST phơi ra. `api` đứng trước nên là profile mặc định. */
const SCHEMA_PHOI = ["public", "api"];

export function pat() {
  if (process.env.SUPABASE_PAT) return process.env.SUPABASE_PAT;
  try {
    return readFileSync(join(repoRoot, "CLAUDE.local.md"), "utf8").match(/sbp_[a-f0-9]+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function hoiCatalog(sql) {
  const token = pat();
  const ref = readFileSync(join(repoRoot, "supabase", "config.toml"), "utf8").match(/project_id\s*=\s*"([^"]+)"/)[1];
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`Management API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/**
 * Nguồn (2): catalog live.
 *
 * Lấy cả chữ ký, volatility, SECURITY DEFINER và search_path đã ghim — bốn thứ
 * quyết định hành vi mà người gọi KHÔNG nhìn thấy từ phía TypeScript. Volatility
 * đặc biệt quan trọng: PostgREST quyết định GET (read-only) hay POST theo
 * volatility chứ không theo tên, nên một hàm STABLE có khoá dòng sẽ trả 25006
 * "cannot execute UPDATE in a read-only transaction" — án lệ đã có trong repo.
 */
export const SQL_CATALOG = `
  select
    n.nspname as schema,
    p.proname as name,
    pg_get_function_arguments(p.oid) as args,
    pg_get_function_result(p.oid) as returns,
    case p.provolatile when 'i' then 'IMMUTABLE' when 's' then 'STABLE' else 'VOLATILE' end as volatility,
    p.prosecdef as security_definer,
    coalesce((select cfg from unnest(p.proconfig) cfg where cfg like 'search_path=%'), '') as search_path,
    coalesce(array_to_string(array(
      select r.rolname from pg_roles r
      where has_function_privilege(r.rolname, p.oid, 'EXECUTE')
        and r.rolname in ('anon','authenticated','service_role')
      order by r.rolname), ','), '') as exec_roles
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','api') and p.prokind in ('f','p')
  order by 1, 2, 3
`;

/**
 * Nguồn (1): call site trong mã nguồn.
 *
 * LỌC THEO IMPORT, không quét mù mọi `.rpc(`.
 *   services/openclaw-zalo-bridge có `options.rpc("agent", …)` — JSON-RPC tới
 *   cell, KHÔNG phải Supabase. Bản quét mù đầu tiên báo nó là "RPC gọi mà catalog
 *   không có", tức một báo động giả ngay ở lần đo đầu. Một gate mở màn bằng báo
 *   động giả sẽ được người ta học cách bỏ qua.
 *
 * Bắt CẢ BA biến thể theo plan §9 — chỉ dùng `.rpc(` thì baseline sai 46 %.
 */
export function timCallSite(docFile, danhSachFile) {
  const goi = new Map();
  for (const f of danhSachFile) {
    const s = docFile(f);
    if (s === null) continue;
    if (!/@supabase\/supabase-js|integrations\/supabase\/client|createClient\s*\(/.test(s)) continue;
    const sach = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
    for (const m of sach.matchAll(/\.rpc\s*(?:as\s+any\s*\))?\s*\(\s*["'`]([a-zA-Z0-9_]+)["'`]/g)) {
      if (!goi.has(m[1])) goi.set(m[1], new Set());
      goi.get(m[1]).add(f.replace(/\\/g, "/"));
    }
  }
  return goi;
}

/** Mức rủi ro suy từ nơi gọi — quyết định RPC nào phải qua wrapper (plan §9). */
export function xepRuiRo(cacFile) {
  const s = cacFile.join(" ");
  if (/income-expense|invoice|payment|cashbook|salary|finance|thu-tien|thanh-toan|voucher|commission/i.test(s))
    return "financial";
  if (/network-center/i.test(s)) return "infrastructure";
  return "normal";
}

export function lietKeFile() {
  return execFileSync(
    "git",
    ["ls-files", "src/**/*.ts", "src/**/*.tsx", "supabase/functions/**/*.ts", "services/**/*.ts", "infra/**/*.ts", "api/**/*.ts"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 1e8 },
  )
    .split(/\r?\n/)
    .filter(Boolean);
}

export function dungManifest(hang, goi) {
  const theoTen = new Map();
  for (const r of hang) {
    if (!theoTen.has(r.name)) theoTen.set(r.name, []);
    theoTen.get(r.name).push(r);
  }

  const rpcs = {};
  const thieuTrenServer = [];
  for (const ten of [...goi.keys()].sort()) {
    const dinhNghia = theoTen.get(ten);
    const cacFile = [...goi.get(ten)].sort();
    if (!dinhNghia) {
      thieuTrenServer.push({ name: ten, callers: cacFile });
      continue;
    }
    rpcs[ten] = {
      // Nhiều overload thì ghi hết — PostgREST chọn theo tên tham số gửi lên, nên
      // biết có bao nhiêu bản là thông tin cần cho người đọc hợp đồng.
      definitions: dinhNghia.map((d) => ({
        schema: d.schema,
        args: d.args,
        returns: d.returns,
        volatility: d.volatility,
        securityDefiner: d.security_definer === true || d.security_definer === "t",
        searchPath: d.search_path || null,
        execRoles: d.exec_roles ? d.exec_roles.split(",") : [],
      })),
      callers: cacFile,
      risk: xepRuiRo(cacFile),
    };
  }
  return { rpcs, thieuTrenServer };
}

async function main() {
  if (!pat()) {
    console.error("=== ⚠ KHÔNG SINH ĐƯỢC — thiếu SUPABASE_PAT hoặc CLAUDE.local.md ===");
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

  const manifest = {
    $comment:
      "BỀ MẶT RPC — hợp đồng ở biên TypeScript ↔ PostgreSQL, nơi mà không có nó thì hợp đồng chỉ là một chuỗi ký tự. Sinh từ HAI nguồn (call site trong mã nguồn + catalog live đã normalize) theo plan §P1.7; KHÔNG sinh từ văn bản migration vì 628 file không khớp ledger chính xác. Chỉ ghi RPC ĐANG ĐƯỢC GỌI: ghi cả 1040 hàm sẽ tạo file đổi theo mọi migration nội bộ và người ta sẽ ngừng đọc diff của nó. Sinh bởi scripts/generate-rpc-surface.mjs; kiểm bởi scripts/check-rpc-surface.mjs.",
    generatedFrom: { sourceCallSites: files.length, catalogFunctions: hang.length, schemas: SCHEMA_PHOI },
    counts: {
      calledRpcs: Object.keys(rpcs).length,
      byRisk: Object.values(rpcs).reduce((a, r) => ({ ...a, [r.risk]: (a[r.risk] ?? 0) + 1 }), {}),
      securityDefiner: Object.values(rpcs).filter((r) => r.definitions.some((d) => d.securityDefiner)).length,
    },
    // Đây là phần QUAN TRỌNG NHẤT của file: RPC được gọi mà server không có.
    // Rỗng là trạng thái đúng; khác rỗng là mã đang gọi vào hư không.
    missingOnServer: thieuTrenServer,
    rpcs,
  };

  if (process.argv.includes("--in")) {
    console.log(JSON.stringify(manifest.counts, null, 2));
    console.log("missingOnServer:", JSON.stringify(thieuTrenServer, null, 2));
    return;
  }
  mkdirSync(join(repoRoot, "contracts", "surfaces"), { recursive: true });
  writeFileSync(join(repoRoot, DUONG_DAN), JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `✅ ${DUONG_DAN}: ${Object.keys(rpcs).length} RPC được gọi · ${hang.length} hàm trong catalog · ` +
      `${thieuTrenServer.length} gọi mà server không có`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(3);
  });
}
