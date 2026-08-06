#!/usr/bin/env node
// Kéo một bản dump ĐẦY ĐỦ của database production trước khi đụng vào schema.
//
// VÌ SAO TỒN TẠI: project này KHÔNG bật PITR (quyết định 06/08/2026 — add-on
// tính phí riêng). Chỉ có backup vật lý hằng ngày, nên RPO tối đa ~24 giờ và
// không có cách tua về đúng thời điểm trước một lệnh sai. Bản dump này là đường
// lùi cho các thao tác CÓ KẾ HOẠCH (migration, backfill, apply rollout).
//
// Nó KHÔNG che được sự cố đến từ code chạy hằng ngày — chỗ đó vẫn là 24 giờ.
// Đừng nhầm hai thứ đó với nhau.
//
//   node scripts/backup-before-schema.mjs --reason "apply migration X"
//   node scripts/backup-before-schema.mjs --reason "..." --out D:/backups
//
// Mặc định ghi ra thư mục NGOÀI repo (%USERPROFILE%/ihomecrm-backups) để một
// bản sao sổ sách tiền thật không bao giờ lọt vào git.
//
// Password đọc từ CLAUDE.local.md lúc chạy và chỉ đi qua PGPASSFILE tạm
// (chmod 600, xoá ở finally) — không bao giờ nằm trên command line, nơi mọi
// tiến trình khác trên máy đều đọc được qua danh sách process.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_HOST = "aws-1-ap-southeast-1.pooler.supabase.com";
const POOLER_PORT = 5432; // session mode — pg_dump KHÔNG chạy được ở transaction mode (6543)

const PG_DUMP_CANDIDATES = [
  "C:/Program Files/PostgreSQL/17/bin/pg_dump.exe",
  "C:/Program Files/PostgreSQL/18/bin/pg_dump.exe",
  "pg_dump",
];

function findPgDump() {
  for (const candidate of PG_DUMP_CANDIDATES) {
    if (candidate === "pg_dump") return candidate;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function readProjectRef() {
  try {
    return readFileSync(join(repoRoot, "supabase", ".temp", "project-ref"), "utf8").trim();
  } catch {
    return "tryymsxyyckgbrmmvozx";
  }
}

/**
 * Đọc password pooler từ CLAUDE.local.md.
 *
 * Cùng nguồn mà scripts/openclaw-local-seed.mjs đang dùng — cố ý KHÔNG tạo chỗ
 * lưu credential thứ hai.
 */
export function readPoolerPassword(localMd) {
  const m = localMd.match(/verify pooler login\)[^`]*`([^`]+)`/u);
  return m ? m[1] : null;
}

function parseArgs(argv) {
  const args = { reason: null, out: null, schemaOnly: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--reason") args.reason = argv[i + 1] ?? null;
    if (argv[i] === "--out") args.out = argv[i + 1] ?? null;
    if (argv[i] === "--schema-only") args.schemaOnly = true;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);

  if (!args.reason) {
    console.error("❌ Thiếu --reason \"vì sao backup\".");
    console.error("   Lý do được ghi vào manifest; sáu tháng nữa đó là thứ duy nhất");
    console.error("   cho biết bản dump này thuộc về thao tác nào.");
    return 1;
  }

  const pgDump = findPgDump();
  if (!pgDump) {
    console.error("❌ Không tìm thấy pg_dump. Cài PostgreSQL client 17+ hoặc thêm vào PATH.");
    return 1;
  }

  let localMd;
  try {
    localMd = readFileSync(join(repoRoot, "CLAUDE.local.md"), "utf8");
  } catch {
    console.error("❌ Không đọc được CLAUDE.local.md — đây là nguồn credential local bắt buộc.");
    return 1;
  }

  const password = readPoolerPassword(localMd);
  if (!password) {
    console.error("❌ Không tìm thấy password pooler trong CLAUDE.local.md (mục 'Supabase Database').");
    return 1;
  }

  const ref = readProjectRef();
  const user = `postgres.${ref}`;
  const outDir = args.out ?? join(homedir(), "ihomecrm-backups");
  mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const kind = args.schemaOnly ? "schema" : "full";
  const outFile = join(outDir, `ihomecrm-${kind}-${stamp}.dump`);

  // PGPASSFILE tạm: password KHÔNG bao giờ lên command line (mọi tiến trình
  // trên máy đọc được danh sách process kèm tham số).
  const passFile = join(tmpdir(), `.pgpass-ihomecrm-${process.pid}`);
  writeFileSync(passFile, `${POOLER_HOST}:${POOLER_PORT}:postgres:${user}:${password}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  console.log(`Backup production → ${outFile}`);
  console.log(`  lý do: ${args.reason}`);
  console.log(`  chế độ: ${kind}${args.schemaOnly ? " (KHÔNG có dữ liệu — không dùng làm đường lùi)" : ""}`);

  const dumpArgs = [
    "-h", POOLER_HOST,
    "-p", String(POOLER_PORT),
    "-U", user,
    "-d", "postgres",
    "--format=custom",   // nén sẵn, pg_restore chọn được từng phần
    "--no-owner",
    "--no-acl",
    "-f", outFile,
  ];
  if (args.schemaOnly) dumpArgs.push("--schema-only");

  const started = Date.now();
  let result;
  try {
    result = spawnSync(pgDump, dumpArgs, {
      env: { ...process.env, PGPASSFILE: passFile },
      encoding: "utf8",
      timeout: 30 * 60 * 1000,
    });
  } finally {
    rmSync(passFile, { force: true });
  }

  if (result.error || result.status !== 0) {
    console.error("❌ pg_dump thất bại.");
    // stderr của pg_dump không chứa password (nó đọc từ PGPASSFILE), nhưng vẫn
    // cắt ngắn để không vô tình dội lại thứ gì dài.
    if (result.stderr) console.error(String(result.stderr).slice(0, 1200));
    if (result.error) console.error(String(result.error.message).slice(0, 300));
    rmSync(outFile, { force: true });
    return 1;
  }

  const stat = statSync(outFile);
  if (stat.size < 1024) {
    console.error(`❌ File dump chỉ ${stat.size} byte — quá nhỏ để là bản dump thật. Đã xoá.`);
    rmSync(outFile, { force: true });
    return 1;
  }

  const sha256 = createHash("sha256").update(readFileSync(outFile)).digest("hex");
  const manifest = {
    file: outFile,
    kind,
    reason: args.reason,
    projectRef: ref,
    createdAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - started) / 1000),
    bytes: stat.size,
    sha256,
    pgDump: String(spawnSync(pgDump, ["--version"], { encoding: "utf8" }).stdout ?? "").trim(),
    restoreHint:
      "pg_restore --no-owner --no-acl -d <target> " + outFile +
      "  (KHÔNG restore đè lên production; dựng target mới rồi đối chiếu)",
    // Đã diễn tập restore 06/08/2026 vào PostgreSQL 17.10 local. Ghi lại vì đây
    // là thứ dễ gây hoảng lúc khẩn cấp:
    expectedRestoreErrors:
      "Restore vào Postgres TRẦN sẽ báo ~4200 lỗi, gần như toàn bộ là 'role \"authenticated\" " +
      "does not exist' (644 lần) và các role riêng của Supabase/OpenClaw, cộng schema 'cron' và " +
      "extension 'vector'. ĐÂY LÀ BÌNH THƯỜNG: bảng, hàm và DỮ LIỆU vẫn vào đủ " +
      "(đo được 399 bảng, 1408 hàm, invoices 2290 dòng, income_expenses 5374 dòng). " +
      "Nhưng RLS policy thì KHÔNG vào hết (323/1231) vì policy tham chiếu role không tồn tại. " +
      "⇒ Muốn khôi phục ĐẦY ĐỦ kể cả RLS thì target phải là một Supabase project (đã có sẵn role), " +
      "không phải Postgres cài trần.",
  };
  writeFileSync(`${outFile}.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const mb = (stat.size / 1024 / 1024).toFixed(1);
  console.log(`✅ Xong sau ${manifest.durationSeconds}s — ${mb} MB`);
  console.log(`   sha256: ${sha256.slice(0, 16)}…`);
  console.log(`   manifest: ${outFile}.json`);
  if (args.schemaOnly) {
    console.log("⚠ Đây là dump CHỈ SCHEMA — không khôi phục được dữ liệu. Đừng coi là đường lùi.");
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
