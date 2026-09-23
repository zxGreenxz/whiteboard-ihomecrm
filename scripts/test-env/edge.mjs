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
// network-center-worker cố ý bỏ: không worker nào của TEST.

import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PROD_REF, credential, docVault, ghiLog, mgmt, repoRoot } from "./lib.mjs";

export const DANH_SACH = ["admin-create-user", "llm-proxy", "salary-v5-jobs", "demo-reset", "send-push"];

function tepFunction(slug) {
  const goc = join(repoRoot, "supabase", "functions", slug);
  return readdirSync(goc)
    .filter((f) => /\.(ts|json|lock)$/.test(f) && !/\.test\.ts$/.test(f))
    .sort()
    .map((f) => ({ path: f, contents: readFileSync(join(goc, f)) }));
}

async function main(argv) {
  const cred = credential();
  if (!cred.testPat) throw new Error("Thiếu TEST_SUPABASE_PAT — deploy edge function cần PAT của project TEST.");
  const chon = argv.slice(2).filter((a) => !a.startsWith("--"));
  const slugs = chon.length ? chon : DANH_SACH;
  for (const s of slugs) if (!DANH_SACH.includes(s)) throw new Error(`"${s}" không nằm trong danh sách được deploy lên TEST.`);

  const prodFns = await mgmt(cred.testPat, "GET", `/v1/projects/${PROD_REF}/functions`);
  const cauHinhProd = new Map(prodFns.map((f) => [f.slug, f]));

  for (const slug of slugs) {
    const prod = cauHinhProd.get(slug);
    if (!prod) throw new Error(`Production không có function ${slug}.`);
    const files = tepFunction(slug);
    const metadata = { name: slug, entrypoint_path: "index.ts", verify_jwt: prod.verify_jwt };
    if (files.some((f) => f.path === "deno.json")) metadata.import_map_path = "deno.json";
    const form = new FormData();
    form.append("metadata", JSON.stringify(metadata));
    for (const f of files) form.append("file", new Blob([f.contents], { type: "application/octet-stream" }), f.path);
    const res = await fetch(`https://api.supabase.com/v1/projects/${cred.testRef}/functions/deploy?slug=${slug}`, {
      method: "POST", headers: { Authorization: `Bearer ${cred.testPat}` }, body: form,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Deploy ${slug} lỗi ${res.status}: ${text.slice(0, 600)}`);
    const d = JSON.parse(text);
    if (d.verify_jwt !== prod.verify_jwt) throw new Error(`${slug}: verify_jwt TEST=${d.verify_jwt} ≠ production=${prod.verify_jwt}`);
    ghiLog("edge", `${slug} v${d.version} · verify_jwt=${d.verify_jwt} (giống production) · ${files.length} file`);
  }

  // Secret: chỉ nạp cái chưa có (giữ nguyên giá trị đã đặt ở lần trước).
  const coSan = new Set((await mgmt(cred.testPat, "GET", `/v1/projects/${cred.testRef}/secrets`)).map((x) => x.name));
  const openrouter = docVault().match(/sk-or-v1-[a-f0-9]{64}/)?.[0] ?? process.env.OPENROUTER_API_KEY ?? null;
  const moi = [];
  if (!coSan.has("OPENROUTER_API_KEY") && openrouter) moi.push({ name: "OPENROUTER_API_KEY", value: openrouter });
  if (!coSan.has("CRON_SECRET")) moi.push({ name: "CRON_SECRET", value: randomBytes(32).toString("base64url") });
  if (!coSan.has("DEMO_RESET_SECRET")) moi.push({ name: "DEMO_RESET_SECRET", value: randomBytes(32).toString("base64url") });
  if (moi.length) await mgmt(cred.testPat, "POST", `/v1/projects/${cred.testRef}/secrets`, moi);
  const sau = (await mgmt(cred.testPat, "GET", `/v1/projects/${cred.testRef}/secrets`)).map((x) => x.name);
  if (sau.some((n) => /^VAPID_/.test(n))) throw new Error("TEST có secret VAPID — push có thể tới thiết bị thật. Xoá ngay.");
  ghiLog("edge", `secret TEST: ${sau.filter((n) => !/^SUPABASE_/.test(n)).join(", ") || "(không)"} · nạp mới ${moi.map((m) => m.name).join(", ") || "không"} · không VAPID`);
  return 0;
}

main(process.argv).then((c) => process.exit(c), (e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
