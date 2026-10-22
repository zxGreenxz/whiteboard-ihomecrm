#!/usr/bin/env node
// Deploy edge function lên MÔI TRƯỜNG TEST — cùng mã nguồn repo, cùng cờ verify_jwt với
// production (đọc thẳng từ production, không đoán).
//
//   npm run test-env:edge                      # mọi function trong DANH_SACH
//   npm run test-env:edge -- llm-proxy         # một function
//
// Function sống NGOÀI database nên lượt đồng bộ không xoá chúng — chỉ cần chạy lại khi
// mã function đổi. Cần PAT của project TEST (TEST_SUPABASE_PAT) ⇒ chạy tại máy có vault.
//
// Secret: chỉ nạp thứ TEST cần để tính năng chạy, KHÔNG có kênh chạm thế giới thật:
//   - OPENROUTER_API_KEY (từ vault) — Copilot trên TEST gọi được mô hình.
//   - CRON_SECRET, DEMO_RESET_SECRET — sinh MỚI cho TEST, khác production.
//   - KHÔNG VAPID ⇒ send-push trên TEST không bao giờ đẩy được tới thiết bị thật.
//   - quick-entry: các QUICK_ENTRY_* nạp tay (xem supabase/functions/README.md) — thiếu thì hàm
//     trả quick_entry_disabled, trang /chi-tieu vẫn nhập tay được.
//   - door-access: KHÔNG BAO GIỜ nạp TUYA_* (khoá thật mở được cửa thật) ⇒ trên TEST hàm trả not_configured,
//     trang /cua-van-tay báo "chưa kết nối" — đúng ý đồ.
// VAPID_* hay TUYA_* có trên TEST ⇒ dừng đỏ TRƯỚC khi deploy function nào (mã mới không được lên một project đang
// cầm khoá thật), và kiểm lại sau khi nạp secret.
// network-center-worker cố ý bỏ: không worker nào của TEST.

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { PROD_REF, credential, docVault, ghiLog, mgmt, repoRoot } from "./lib.mjs";

// lifecycle-reminders: chỉ deploy MÃ. Secret LIFECYCLE_REMINDERS_SERVICE_JWT (khớp token trong Vault TEST) và
// cron 15' do scripts/test-env/bootstrap-lifecycle-reminders.mjs --apply cài; chưa bootstrap thì hàm trả 401 cho
// mọi lời gọi (đóng an toàn), deploy lại mã không đụng secret đã đặt.
export const DANH_SACH = [
  "admin-create-user", "llm-proxy", "salary-v5-jobs", "demo-reset", "send-push", "quick-entry", "door-access",
  "lifecycle-reminders",
];

// Hàm MỚI chưa từng lên production thì chưa có cờ verify_jwt để chép ⇒ khai sẵn ở đây. Lên production
// rồi thì cờ production thắng (vòng dưới đọc production trước) — hai bên vẫn phải khớp.
export const CHUA_CO_O_PRODUCTION = { "quick-entry": { verify_jwt: true }, "door-access": { verify_jwt: true } };

/**
 * Secret KHÔNG BAO GIỜ được có trên TEST: VAPID_* (push tới thiết bị thật), TUYA_* (door-access mở cửa thật).
 * Có ⇒ ném, kèm thời điểm kiểm (`luc`) để biết dừng trước hay sau khi deploy.
 */
export function chanSecretCam(names, luc) {
  if (names.some((n) => /^VAPID_/.test(n))) throw new Error(`TEST có secret VAPID (${luc}) — push có thể tới thiết bị thật. Xoá ngay.`);
  if (names.some((n) => /^TUYA_/.test(n))) throw new Error(`TEST có secret TUYA_* (${luc}) — door-access có thể mở cửa thật. Xoá ngay.`);
}

const GOC_HAM = "supabase/functions";
const LA_TEST = /\.test\.[cm]?[jt]sx?$/;
const LA_MA = /\.[cm]?[jt]sx?$/;

/** Import TƯƠNG ĐỐI (./, ../) của một file mã — tĩnh, `export … from`, `import type` và `import()`; bỏ chú thích/chuỗi. */
export function importTuongDoi(maNguon) {
  return ts.preProcessFile(maNguon, true, true).importedFiles
    .map((f) => f.fileName)
    .filter((ten) => ten.startsWith("./") || ten.startsWith("../"));
}

/**
 * Gói deploy multipart cho Management API `POST /v1/projects/{ref}/functions/deploy` — hàm THUẦN (chỉ đọc file).
 *
 * Quy ước đọc lại từ production 22/10 (bank-event-ingest v5, bank-event-admin v4 — hàm import ../_shared đang chạy):
 * mọi tên file TÍNH TỪ GỐC REPO (production ghi entrypoint `…/source/supabase/functions/<slug>/index.ts`), nên
 * import `../_shared/x.ts` của `supabase/functions/<slug>/index.ts` giải đúng tới `supabase/functions/_shared/x.ts`.
 *   files:    file cấp cao nhất .ts/.json/.lock của thư mục hàm (bỏ *.test.*) + bao đóng import tương đối của
 *             chúng (vd. supabase/functions/_shared/push-drain.ts). Import trỏ ra ngoài supabase/functions, trỏ
 *             vào file test hoặc file không tồn tại ⇒ ném (deploy hỏng ồn ào, không âm thầm thiếu file).
 *   metadata: entrypoint_path = supabase/functions/<slug>/index.ts; import_map_path = supabase/functions/<slug>/deno.json
 *             khi thư mục hàm có deno.json — kể cả deno.json chỉ có compilerOptions: bank-event-* production chạy
 *             đúng như vậy (import_map_path trỏ deno.json) và đây cũng là hành vi cũ của script cho các hàm khác.
 *             Không có deno.json ⇒ không gửi import_map_path (như demo-reset production).
 * `name`/`verify_jwt` do bên gọi thêm (formDeploy).
 */
export function dungGoiDeploy(slug, { goc = repoRoot } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug ?? "")) throw new Error(`Slug edge function không hợp lệ: ${slug}`);
  const thuMucHam = `${GOC_HAM}/${slug}`;
  const tuyetDoi = (duongDan) => join(goc, ...duongDan.split("/"));
  const tep = new Map();
  const hangDoi = [];
  const them = (duongDan) => {
    if (tep.has(duongDan)) return;
    tep.set(duongDan, readFileSync(tuyetDoi(duongDan)));
    hangDoi.push(duongDan);
  };
  for (const ten of readdirSync(tuyetDoi(thuMucHam)).sort()) {
    if (/\.(ts|json|lock)$/.test(ten) && !LA_TEST.test(ten) && statSync(tuyetDoi(`${thuMucHam}/${ten}`)).isFile()) {
      them(`${thuMucHam}/${ten}`);
    }
  }
  while (hangDoi.length) {
    const nguon = hangDoi.shift();
    if (!LA_MA.test(nguon)) continue;
    for (const ten of importTuongDoi(tep.get(nguon).toString("utf8"))) {
      const dich = posix.normalize(posix.join(posix.dirname(nguon), ten.split(/[?#]/)[0]));
      if (!dich.startsWith(`${GOC_HAM}/`)) throw new Error(`${nguon}: import "${ten}" trỏ ra ngoài ${GOC_HAM}/`);
      if (LA_TEST.test(dich)) throw new Error(`${nguon}: import "${ten}" trỏ vào file test`);
      if (!existsSync(tuyetDoi(dich)) || !statSync(tuyetDoi(dich)).isFile()) {
        throw new Error(`${nguon}: import "${ten}" — không có file ${dich}`);
      }
      them(dich);
    }
  }
  const entrypoint = `${thuMucHam}/index.ts`;
  if (!tep.has(entrypoint)) throw new Error(`${slug}: thiếu ${entrypoint}`);
  const metadata = { entrypoint_path: entrypoint };
  const denoJson = `${thuMucHam}/deno.json`;
  if (tep.has(denoJson)) {
    const cauHinh = JSON.parse(tep.get(denoJson).toString("utf8"));
    if (cauHinh.importMap !== undefined) throw new Error(`${denoJson}: "importMap" trỏ file riêng — chưa hỗ trợ, khai "imports" trong deno.json`);
    metadata.import_map_path = denoJson;
  }
  const files = [...tep.keys()].sort().map((path) => ({ path, contents: tep.get(path) }));
  return { files, metadata };
}

/** File được tải lên (tên tính từ gốc repo) — xem dungGoiDeploy. */
export function tepFunction(slug) {
  return dungGoiDeploy(slug).files;
}

/** FormData multipart: phần `metadata` (JSON) + mỗi file một phần `file` mang tên = đường dẫn từ gốc repo. */
export function formDeploy(goi, { name, verify_jwt }) {
  if (typeof verify_jwt !== "boolean") throw new Error(`${name}: verify_jwt phải là boolean`);
  const form = new FormData();
  form.append("metadata", JSON.stringify({ name, ...goi.metadata, verify_jwt }));
  for (const f of goi.files) form.append("file", new Blob([f.contents], { type: "application/octet-stream" }), f.path);
  return form;
}

/** `phuThuoc` chỉ để test thay credential/Management API/fetch/vault/log; chạy thật dùng mặc định. */
export async function main(argv, phuThuoc = {}) {
  const {
    layCredential = credential,
    goiMgmt = mgmt,
    guiDeploy = (url, init) => fetch(url, init),
    docKhoa = docVault,
    log = ghiLog,
  } = phuThuoc;
  const cred = layCredential();
  if (!cred.testPat) throw new Error("Thiếu TEST_SUPABASE_PAT — deploy edge function cần PAT của project TEST.");
  const chon = argv.slice(2).filter((a) => !a.startsWith("--"));
  const slugs = chon.length ? chon : DANH_SACH;
  for (const s of slugs) if (!DANH_SACH.includes(s)) throw new Error(`"${s}" không nằm trong danh sách được deploy lên TEST.`);
  const tenSecret = async () => (await goiMgmt(cred.testPat, "GET", `/v1/projects/${cred.testRef}/secrets`)).map((x) => x.name);

  // Kiểm TRƯỚC mọi lần deploy: project TEST đang cầm khoá thật thì không đưa mã nào lên.
  chanSecretCam(await tenSecret(), "trước khi deploy");

  const prodFns = await goiMgmt(cred.testPat, "GET", `/v1/projects/${PROD_REF}/functions`);
  const cauHinhProd = new Map(prodFns.map((f) => [f.slug, f]));

  for (const slug of slugs) {
    const prod = cauHinhProd.get(slug) ?? CHUA_CO_O_PRODUCTION[slug];
    if (!prod) throw new Error(`Production không có function ${slug}.`);
    const goi = dungGoiDeploy(slug);
    const files = goi.files;
    const form = formDeploy(goi, { name: slug, verify_jwt: prod.verify_jwt });
    const res = await guiDeploy(`https://api.supabase.com/v1/projects/${cred.testRef}/functions/deploy?slug=${slug}`, {
      method: "POST", headers: { Authorization: `Bearer ${cred.testPat}` }, body: form,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Deploy ${slug} lỗi ${res.status}: ${text.slice(0, 600)}`);
    const d = JSON.parse(text);
    if (d.verify_jwt !== prod.verify_jwt) throw new Error(`${slug}: verify_jwt TEST=${d.verify_jwt} ≠ production=${prod.verify_jwt}`);
    const nguon = cauHinhProd.has(slug) ? "giống production" : "chưa có ở production — cờ khai sẵn";
    log("edge", `${slug} v${d.version} · verify_jwt=${d.verify_jwt} (${nguon}) · ${files.length} file`);
  }

  // Secret: chỉ nạp cái chưa có (giữ nguyên giá trị đã đặt ở lần trước).
  const coSan = new Set(await tenSecret());
  const openrouter = docKhoa().match(/sk-or-v1-[a-f0-9]{64}/)?.[0] ?? process.env.OPENROUTER_API_KEY ?? null;
  const moi = [];
  if (!coSan.has("OPENROUTER_API_KEY") && openrouter) moi.push({ name: "OPENROUTER_API_KEY", value: openrouter });
  if (!coSan.has("CRON_SECRET")) moi.push({ name: "CRON_SECRET", value: randomBytes(32).toString("base64url") });
  if (!coSan.has("DEMO_RESET_SECRET")) moi.push({ name: "DEMO_RESET_SECRET", value: randomBytes(32).toString("base64url") });
  if (moi.length) await goiMgmt(cred.testPat, "POST", `/v1/projects/${cred.testRef}/secrets`, moi);
  const sau = await tenSecret();
  chanSecretCam(sau, "sau khi deploy");
  log("edge", `secret TEST: ${sau.filter((n) => !/^SUPABASE_/.test(n)).join(", ") || "(không)"} · nạp mới ${moi.map((m) => m.name).join(", ") || "không"} · không VAPID, không TUYA`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv).then((c) => process.exit(c), (e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}
