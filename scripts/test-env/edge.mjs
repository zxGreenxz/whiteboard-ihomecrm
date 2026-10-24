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
// network-center-worker cố ý bỏ: không quản lý thiết bị thật từ TEST.
// meter-capture-worker dùng bearer riêng chỉ TEST, do launcher tạm nạp trong bộ nhớ;
// script này không sao chép bearer production hoặc khoá AI vào Edge.

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROD_REF, credential, docVault, ghiLog, mgmt, repoRoot } from "./lib.mjs";

export const DANH_SACH = ["admin-create-user", "llm-proxy", "salary-v5-jobs", "demo-reset", "send-push", "quick-entry", "door-access", "meter-capture-worker"];

// Hàm MỚI chưa từng lên production thì chưa có cờ verify_jwt để chép ⇒ khai sẵn ở đây. Lên production
// rồi thì cờ production thắng (vòng dưới đọc production trước) — hai bên vẫn phải khớp.
export const CHUA_CO_O_PRODUCTION = { "quick-entry": { verify_jwt: true }, "door-access": { verify_jwt: true }, "meter-capture-worker": { verify_jwt: false } };

/**
 * Secret KHÔNG BAO GIỜ được có trên TEST: VAPID_* (push tới thiết bị thật), TUYA_* (door-access mở cửa thật).
 * Có ⇒ ném, kèm thời điểm kiểm (`luc`) để biết dừng trước hay sau khi deploy.
 */
export function chanSecretCam(names, luc) {
  if (names.some((n) => /^VAPID_/.test(n))) throw new Error(`TEST có secret VAPID (${luc}) — push có thể tới thiết bị thật. Xoá ngay.`);
  if (names.some((n) => /^TUYA_/.test(n))) throw new Error(`TEST có secret TUYA_* (${luc}) — door-access có thể mở cửa thật. Xoá ngay.`);
}

/** File được tải lên: file cấp cao nhất .ts/.json/.lock của thư mục hàm, bỏ *.test.ts. */
export function tepFunction(slug) {
  const goc = join(repoRoot, "supabase", "functions", slug);
  return readdirSync(goc)
    .filter((f) => /\.(ts|json|lock)$/.test(f) && !/\.test\.ts$/.test(f))
    .sort()
    .map((f) => ({ path: f, contents: readFileSync(join(goc, f)) }));
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
  if (!/^[a-z0-9]{20}$/.test(cred.testRef ?? '') || cred.testRef === PROD_REF) throw new Error('Đích Edge phải là project TEST riêng; từ chối production.');
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
    if (slug === 'meter-capture-worker' && prod.verify_jwt !== false) throw new Error('meter-capture-worker phải verify_jwt=false; bearer worker và JWT người dùng được kiểm riêng trong handler.');
    const files = tepFunction(slug);
    const metadata = { name: slug, entrypoint_path: "index.ts", verify_jwt: prod.verify_jwt };
    if (files.some((f) => f.path === "deno.json")) metadata.import_map_path = "deno.json";
    const form = new FormData();
    form.append("metadata", JSON.stringify(metadata));
    for (const f of files) form.append("file", new Blob([f.contents], { type: "application/octet-stream" }), f.path);
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
  const moi = [];
  if (slugs.some(slug => slug !== 'meter-capture-worker')) {
    const openrouter = docKhoa().match(/sk-or-v1-[a-f0-9]{64}/)?.[0] ?? process.env.OPENROUTER_API_KEY ?? null;
    if (!coSan.has("OPENROUTER_API_KEY") && openrouter) moi.push({ name: "OPENROUTER_API_KEY", value: openrouter });
    if (!coSan.has("CRON_SECRET")) moi.push({ name: "CRON_SECRET", value: randomBytes(32).toString("base64url") });
    if (!coSan.has("DEMO_RESET_SECRET")) moi.push({ name: "DEMO_RESET_SECRET", value: randomBytes(32).toString("base64url") });
  }
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
