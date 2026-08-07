#!/usr/bin/env node
// Diễn tập khôi phục baseline lên một Postgres/Supabase TẠM.
//
// VÌ SAO TỒN TẠI: một bản sao lưu chưa từng thử khôi phục chỉ là hy vọng, không
// phải bảo hiểm. Trước ngày 07/08/2026 baseline này chưa ai dựng thử, và khi
// dựng thật thì nó KHÔNG dựng lại được: thiếu 271 policy vì baseline không mang
// theo role. Manifest vẫn ghi đủ số đếm suốt thời gian đó, vì nó đếm trên FILE
// chứ không đếm trên KẾT QUẢ khôi phục.
//
//   node scripts/dien-tap-khoi-phuc-baseline.mjs --dich "postgresql://…"
//   node scripts/dien-tap-khoi-phuc-baseline.mjs --dich "…" --khong-dat-lai
//
// KHÔNG BAO GIỜ chạy lên production: script từ chối nếu chuỗi kết nối chứa
// project ref ghi trong manifest.sourceProject.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(repoRoot, "supabase", "baseline");
const ROLES = join(DIR, "roles.sql");
const SCHEMA = join(DIR, "schema.sql");
const MANIFEST = join(DIR, "manifest.json");

// Baseline phủ BỐN schema. Đếm thiếu schema là cách dễ nhất để tự lừa mình:
// bản đầu tôi chỉ đếm public + app_private và báo "thiếu 59 bảng", trong khi
// chúng nằm nguyên ở clone_org và demo_snapshot.
const SCHEMA_BASELINE = "('public','app_private','clone_org','demo_snapshot')";

const PSQL = ["C:/Program Files/PostgreSQL/17/bin/psql.exe", "psql"].find(
  (p) => p === "psql" || existsSync(p),
);

function main(argv) {
  const dich = argv[argv.indexOf("--dich") + 1];
  if (!dich || dich.startsWith("--")) {
    console.error('Dùng: node scripts/dien-tap-khoi-phuc-baseline.mjs --dich "postgresql://…"');
    return 1;
  }
  if (!PSQL) {
    console.error("❌ Không tìm thấy psql. Cài PostgreSQL client 17+.");
    return 1;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

  // CHẶN CỨNG. Diễn tập ghi đè schema — trỏ nhầm vào production là mất tất cả.
  if (dich.includes(manifest.sourceProject)) {
    console.error(`❌ Chuỗi kết nối chứa "${manifest.sourceProject}" — đây là PRODUCTION. Dừng.`);
    return 1;
  }

  const psql = (args, { imLang = false } = {}) =>
    spawnSync(PSQL, ["-d", dich, ...args], {
      encoding: "utf8",
      timeout: 45 * 60 * 1000,
      maxBuffer: 256 * 1024 * 1024,
      stdio: imLang ? "pipe" : ["ignore", "pipe", "pipe"],
    });
  const hoi = (sql) =>
    execFileSync(PSQL, ["-d", dich, "-t", "-A", "-c", sql], { encoding: "utf8" })
      .trim().split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

  console.log(`Diễn tập khôi phục baseline (chụp ${manifest.capturedAt})`);
  console.log(`  đích: ${dich.replace(/:[^:@/]+@/, ":***@")}\n`);

  if (!argv.includes("--khong-dat-lai")) {
    console.log("→ Đặt lại đích về trắng…");
    // Theo LÔ, mỗi lô một transaction. DROP SCHEMA CASCADE một phát trên ~440
    // bảng + 1500 hàm vượt max_locks_per_transaction ("out of shared memory").
    // Và mỗi loại object cần ĐÚNG lệnh DROP của nó — DROP TABLE trên view lỗi.
    const thu = (sql) => { try { psql(["-q", "-c", sql]); } catch { /* vòng sau nhặt lại */ } };
    for (const ns of ["app_private", "clone_org", "demo_snapshot", "public"]) {
      for (const [kind, lenh] of [["'r','p'", "drop table if exists"], ["'v'", "drop view if exists"], ["'m'", "drop materialized view if exists"]]) {
        for (let i = 0; i < 40; i += 1) {
          const ds = hoi(`select quote_ident(n.nspname)||'.'||quote_ident(c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='${ns}' and c.relkind in (${kind}) limit 30`);
          if (ds.length === 0) break;
          thu(`${lenh} ${ds.join(",")} cascade`);
        }
      }
      for (let i = 0; i < 80; i += 1) {
        const f = hoi(`select quote_ident(n.nspname)||'.'||quote_ident(p.proname)||'('||pg_get_function_identity_arguments(p.oid)||')' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='${ns}' and p.prokind in ('f','p') limit 30`);
        if (f.length === 0) break;
        thu(`drop function if exists ${f.join(",")} cascade`);
      }
      thu(`drop schema if exists ${ns} cascade`);
    }
    thu("create schema if not exists public");
  }

  console.log("→ Nạp roles.sql (thứ pg_dump --schema-only KHÔNG xuất)…");
  const rRole = psql(["-q", "-v", "ON_ERROR_STOP=1", "-f", ROLES]);
  if (rRole.status !== 0) {
    console.error("❌ Nạp roles.sql thất bại:", String(rRole.stderr).slice(0, 300));
    return 1;
  }

  // HAI LƯỢT. Một số object tham chiếu thứ định nghĩa SAU chúng trong file —
  // ví dụ public.rooms có cột sinh phụ thuộc public.room_sort_key. Lượt 2 dựng
  // nốt phần lượt 1 bỏ lại. Đo 07/08/2026: 438→439 bảng, 11→14 view,
  // 1170→1193 policy. ON_ERROR_STOP=0 là cố ý — dừng ở lỗi đầu thì không bao
  // giờ tới được lượt 2.
  for (const luot of [1, 2]) {
    console.log(`→ Nạp schema.sql — lượt ${luot}…`);
    const t0 = Date.now();
    const r = psql(["-v", "ON_ERROR_STOP=0", "-f", SCHEMA]);
    const loi = String(r.stderr || "").split("\n").filter((l) => /ERROR/.test(l)).length;
    console.log(`   ${Math.round((Date.now() - t0) / 1000)}s · ${loi} lỗi`);
  }

  const dem = (sql) => Number(hoi(sql)[0] ?? 0);
  const thuc = {
    tables: dem(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname in ${SCHEMA_BASELINE}`),
    views: dem(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='v' and n.nspname in ${SCHEMA_BASELINE}`),
    policies: dem(`select count(*) from pg_policies where schemaname in ${SCHEMA_BASELINE}`),
    triggers: dem(`select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ${SCHEMA_BASELINE} and not t.tgisinternal`),
  };

  console.log("\n   ĐỐI CHIẾU với manifest:");
  let thieu = 0;
  for (const k of ["tables", "views", "policies", "triggers"]) {
    const ky = manifest.counts[k];
    const ti = ky ? Math.round((thuc[k] / ky) * 100) : 0;
    const dat = ti >= 99;
    if (!dat) thieu += 1;
    console.log(`     ${dat ? "✓" : "✗"} ${k.padEnd(9)} ${String(thuc[k]).padStart(5)} / ${String(ky).padStart(5)}  (${ti}%)`);
  }

  if (thieu > 0) {
    console.error(`\n❌ ${thieu} hạng mục dưới 99% — baseline CHƯA dựng lại được đầy đủ.`);
    return 1;
  }
  console.log("\n✅ Baseline dựng lại ĐƯỢC — mọi hạng mục ≥99% so với manifest.");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
