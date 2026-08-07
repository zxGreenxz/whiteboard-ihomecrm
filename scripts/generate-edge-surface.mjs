#!/usr/bin/env node
// Sinh contracts/surfaces/edge-function-surface.json — biên thứ hai mà hợp đồng
// chỉ là một chuỗi: `supabase.functions.invoke('slug')`.
//
// VÌ SAO CẦN RIÊNG, KHÔNG GỘP VÀO RPC SURFACE
//   RPC sai tên thì server trả 404 PGRST202 ngay. Edge Function sai tên cũng 404,
//   nhưng câu hỏi đắt hơn nằm ở chỗ khác: THƯ MỤC CÓ TRONG REPO KHÔNG CÓ NGHĨA LÀ
//   HÀM ĐANG CHẠY. Deploy là một thao tác riêng, không gắn với git push. Đo thật
//   07/08/2026: repo có 13 thư mục function, server chỉ có 11 bản ACTIVE —
//   network-watchdog và openclaw-watchdog có mã nguồn nhưng KHÔNG tồn tại trên
//   server. Không có gì trong repo nói ra điều đó.
//
//   Chiều ngược lại còn tệ hơn: một hàm ACTIVE trên server mà không còn thư mục
//   trong repo là mã đang chạy trên dữ liệu thật mà không ai đọc được nữa.
//
// BA NGUỒN
//   (1) thư mục supabase/functions/*  — mã nguồn;
//   (2) Management API /v1/projects/{ref}/functions — trạng thái ĐANG CHẠY;
//   (3) call site `functions.invoke('slug')` trong mã client.
//
//   node scripts/generate-edge-surface.mjs
//   node scripts/generate-edge-surface.mjs --in
//
// Cần SUPABASE_PAT. CHỈ ĐỌC.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pat } from "./generate-rpc-surface.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DUONG_DAN_EDGE = join("contracts", "surfaces", "edge-function-surface.json");

/** Thư mục KHÔNG phải function. `_shared` là mã dùng chung, không deploy được. */
const KHONG_PHAI_FUNCTION = new Set(["_shared"]);

export function thuMucFunction() {
  const d = join(repoRoot, "supabase", "functions");
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !KHONG_PHAI_FUNCTION.has(e.name))
    .map((e) => e.name)
    .sort();
}

export async function hoiDaDeploy() {
  const ref = readFileSync(join(repoRoot, "supabase", "config.toml"), "utf8").match(/project_id\s*=\s*"([^"]+)"/)[1];
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/functions`, {
    headers: { Authorization: `Bearer ${pat()}` },
  });
  if (!r.ok) throw new Error(`Management API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`Management API trả về không phải mảng: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

/**
 * Call site invoke.
 *
 * KHÔNG lọc theo import supabase như bên RPC: `functions.invoke(` là cụm riêng
 * của supabase-js, gần như không đụng tên với thứ khác. Nhưng vẫn bỏ comment —
 * một comment giải thích "gọi invoke('send-push')" không phải một call site, và
 * mẫu "gate tự khớp vào chính câu nói về nó" đã lặp nhiều lần trong repo này.
 */
export function timInvoke(docFile, danhSachFile) {
  const goi = new Map();
  for (const f of danhSachFile) {
    const s = docFile(f);
    if (s === null) continue;
    const sach = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
    for (const m of sach.matchAll(/functions\s*\.\s*invoke\s*(?:as\s+any\s*\))?\s*\(\s*["'`]([a-zA-Z0-9_-]+)["'`]/g)) {
      if (!goi.has(m[1])) goi.set(m[1], new Set());
      goi.get(m[1]).add(f.replace(/\\/g, "/"));
    }
  }
  return goi;
}

export function lietKeFileEdge() {
  return execFileSync(
    "git",
    ["ls-files", "src/**/*.ts", "src/**/*.tsx", "supabase/functions/**/*.ts", "services/**/*.ts", "infra/**/*.ts", "api/**/*.ts", "worker/**/*.ts"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 1e8 },
  )
    .split(/\r?\n/)
    .filter(Boolean);
}

export function dungManifestEdge(thuMuc, daDeploy, goi) {
  const theoSlug = new Map(daDeploy.map((f) => [f.slug, f]));
  const moiSlug = [...new Set([...thuMuc, ...theoSlug.keys(), ...goi.keys()])].sort();

  const functions = {};
  const coMaKhongChay = [];
  const dangChayKhongCoMa = [];
  const goiHamKhongTonTai = [];

  for (const slug of moiSlug) {
    const coMa = thuMuc.includes(slug);
    const tren = theoSlug.get(slug);
    const callers = [...(goi.get(slug) ?? [])].sort();

    functions[slug] = {
      hasSource: coMa,
      deployed: Boolean(tren),
      status: tren?.status ?? null,
      version: tren?.version ?? null,
      // verify_jwt = false nghĩa là AI CŨNG gọi được, không cần đăng nhập.
      // Đây là thuộc tính an ninh quan trọng nhất của một Edge Function và nó
      // KHÔNG nhìn thấy được từ mã nguồn — nó là cấu hình phía server.
      verifyJwt: tren?.verify_jwt ?? null,
      callers,
    };

    if (coMa && !tren) coMaKhongChay.push(slug);
    if (!coMa && tren) dangChayKhongCoMa.push(slug);
    if (callers.length > 0 && !tren) goiHamKhongTonTai.push({ slug, callers });
  }

  return { functions, coMaKhongChay, dangChayKhongCoMa, goiHamKhongTonTai };
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

  const thuMuc = thuMucFunction();
  const daDeploy = await hoiDaDeploy();
  const files = lietKeFileEdge();
  const goi = timInvoke(doc, files);
  const kq = dungManifestEdge(thuMuc, daDeploy, goi);

  const manifest = {
    $comment:
      "BỀ MẶT EDGE FUNCTION. Thư mục trong repo KHÔNG có nghĩa là hàm đang chạy — deploy là thao tác riêng, không gắn với git push. Sinh từ BA nguồn: thư mục supabase/functions/*, Management API (trạng thái đang chạy), và call site functions.invoke(). Sinh bởi scripts/generate-edge-surface.mjs; kiểm bởi scripts/check-edge-surface.mjs.",
    counts: {
      source: thuMuc.length,
      deployed: daDeploy.length,
      invoked: goi.size,
      publiclyCallable: daDeploy.filter((f) => f.verify_jwt === false).length,
    },
    // Ba danh sách dưới đây là phần đáng đọc nhất của file.
    sourceWithoutDeployment: kq.coMaKhongChay,
    deploymentWithoutSource: kq.dangChayKhongCoMa,
    invokedButNotDeployed: kq.goiHamKhongTonTai,
    functions: kq.functions,
  };

  if (process.argv.includes("--in")) {
    console.log(JSON.stringify({ ...manifest, functions: undefined }, null, 2));
    return;
  }
  mkdirSync(join(repoRoot, "contracts", "surfaces"), { recursive: true });
  writeFileSync(join(repoRoot, DUONG_DAN_EDGE), JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `✅ ${DUONG_DAN_EDGE}: ${thuMuc.length} thư mục · ${daDeploy.length} đang chạy · ${goi.size} slug được gọi · ` +
      `${kq.coMaKhongChay.length} có mã mà chưa deploy`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(3);
  });
}
