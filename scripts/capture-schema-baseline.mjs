#!/usr/bin/env node
// Chụp production schema baseline: một file SQL dựng lại được toàn bộ cấu trúc
// database từ database trắng, KHÔNG chứa một dòng dữ liệu nào.
//
// VÌ SAO CẦN: replay 640 file migration qua Supabase CLI KHÔNG thành công và
// chưa bao giờ thành công (ledger trùng version, migration cũ đọc cột không
// migration nào tạo). Nghĩa là hiện KHÔNG có đường dựng lại môi trường từ đầu.
// Baseline này là đường đó: dựng từ baseline rồi apply forward migrations, thay
// vì diễn lại một lịch sử đã hỏng.
//
//   node scripts/capture-schema-baseline.mjs            # xem trước, không ghi
//   node scripts/capture-schema-baseline.mjs --write    # ghi supabase/baseline/
//
// CHỈ ĐỌC production (pg_dump --schema-only). Không ghi gì lên production.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(repoRoot, "supabase", "baseline");
const POOLER_HOST = "aws-1-ap-southeast-1.pooler.supabase.com";
const POOLER_PORT = 5432;

const PG_DUMP = ["C:/Program Files/PostgreSQL/17/bin/pg_dump.exe", "pg_dump"].find(
  (p) => p === "pg_dump" || existsSync(p),
);

/**
 * Partition do runtime sinh theo NGÀY. Phải loại khỏi baseline: giữ chúng lại
 * thì baseline vô tình đóng băng một "chân trời phân mảnh" phụ thuộc ngày chụp,
 * và mỗi lần chụp lại sẽ ra một file khác dù schema không đổi.
 *
 * Partition thật sự cần thiết được tạo lại bằng hàm ensure_raw_partitions của
 * Network Center sau khi restore, không phải bằng baseline.
 */
// Hậu tố tuỳ chọn là BẮT BUỘC phải cho phép: pg_dump sinh cả object phái sinh
// của partition (network_device_samples_20260727_pkey, index…). Bản đầu neo `$`
// ngay sau 8 chữ số nên bỏ sót 84 câu `ALTER INDEX … ATTACH PARTITION`, và
// baseline vẫn kéo theo partition ngày cũ dù báo "đã loại 84 partition".
const RUNTIME_PARTITION = /^network_(device|interface)_samples_\d{8}(_[a-z0-9_]+)?$/;

function readPoolerPassword(localMd) {
  const m = localMd.match(/verify pooler login\)[^`]*`([^`]+)`/u);
  return m ? m[1] : null;
}

function projectRef() {
  try {
    return readFileSync(join(repoRoot, "supabase", ".temp", "project-ref"), "utf8").trim();
  } catch {
    return "tryymsxyyckgbrmmvozx";
  }
}

/**
 * Bỏ các câu lệnh dính tới partition runtime.
 *
 * pg_dump xuất mỗi partition thành nhiều câu: CREATE TABLE, ATTACH PARTITION,
 * index, constraint, RLS… Cắt theo TỪNG CÂU (tách bằng dòng trống giữa các
 * statement của pg_dump) rồi bỏ câu nào nhắc tên partition — an toàn hơn nhiều
 * so với xoá theo dòng, vốn dễ để lại nửa câu và làm file không parse được.
 */
export function stripRuntimePartitions(input) {
  // CHUẨN HOÁ LINE ENDING TRƯỚC. pg_dump qua pipe trên Windows trả \r\n, nên mọi
  // regex tách theo \n\n đều không khớp và cả file gộp thành MỘT khối — khối đó
  // dĩ nhiên có chứa tên partition nên bị loại sạch, cho ra baseline 1 dòng.
  // Bản đầu của hàm này đúng lỗi đó.
  const sql = input.replace(/\r\n/g, "\n");

  // Tách theo block header của pg_dump: mỗi object đứng sau một khối
  //   --
  //   -- Name: <tên>; Type: ...; Schema: ...
  //   --
  const chunks = sql.split(/(?=^--\n-- Name: )/m);
  const removed = new Set();
  const kept = [];

  for (const chunk of chunks) {
    const names = [...chunk.matchAll(/\b(network_(?:device|interface)_samples_\d{8}[a-z0-9_]*)\b/g)].map((m) => m[1]);
    const partitionNames = names.filter((n) => RUNTIME_PARTITION.test(n));

    // PostgreSQL cắt tên identifier ở 63 ký tự, nên index của partition ngày bị
    // rút ngắn và MẤT một phần ngày: `..._samples_202607_<cột>_idx1` (6 số),
    // `..._samples_20260_<cột>_idx10` (5 số) — cắt càng sâu khi hậu tố càng dài.
    //
    // Vì vậy KHÔNG đếm chữ số. Luật đúng theo bản chất: một câu `INDEX ATTACH`
    // gắn index con vào partition đã bị loại thì bản thân nó cũng phải bị loại,
    // nếu không restore sẽ lỗi "relation does not exist".
    const isPartitionIndexAttach =
      /-- Name: network_(?:device|interface)_samples_\d+[a-z0-9_]*; Type: INDEX ATTACH/.test(chunk);

    if (partitionNames.length > 0 || isPartitionIndexAttach) {
      partitionNames.forEach((n) => removed.add(n));
      continue;
    }
    kept.push(chunk);
  }
  // join("") chứ KHÔNG phải join("\n\n"): mỗi chunk đã tự mang dấu ngắt dòng của
  // nó. Nối thêm \n\n làm file phình ~10k dòng so với bản gốc — dấu hiệu ban đầu
  // khiến tôi tưởng strip đang nhân đôi nội dung.
  return { sql: kept.join(""), removed: [...removed].sort() };
}

/** Chốt chặn: baseline TUYỆT ĐỐI không được chứa dữ liệu. */
export function assertNoData(sql) {
  const offenders = [];
  if (/^COPY .+ FROM stdin;/m.test(sql)) offenders.push("COPY ... FROM stdin");
  const inserts = sql.match(/^INSERT INTO /gm);
  if (inserts) offenders.push(`${inserts.length} câu INSERT`);
  return offenders;
}

function main(argv) {
  if (!PG_DUMP) {
    console.error("❌ Không tìm thấy pg_dump.");
    return 1;
  }
  let localMd;
  try {
    localMd = readFileSync(join(repoRoot, "CLAUDE.local.md"), "utf8");
  } catch {
    console.error("❌ Không đọc được CLAUDE.local.md.");
    return 1;
  }
  const password = readPoolerPassword(localMd);
  if (!password) {
    console.error("❌ Không tìm thấy password pooler trong CLAUDE.local.md.");
    return 1;
  }

  const ref = projectRef();
  const user = `postgres.${ref}`;
  const passFile = join(tmpdir(), `.pgpass-baseline-${process.pid}`);
  writeFileSync(passFile, `${POOLER_HOST}:${POOLER_PORT}:postgres:${user}:${password}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  console.log("Đang chụp schema production (schema-only)…");
  let res;
  try {
    res = spawnSync(
      PG_DUMP,
      [
        "-h", POOLER_HOST,
        "-p", String(POOLER_PORT),
        "-U", user,
        "-d", "postgres",
        "--schema-only",
        "--no-owner",
        "--no-acl",
        // Bỏ schema do Supabase quản lý: chúng đã tồn tại sẵn trên mọi project
        // mới, và đưa vào baseline sẽ gây xung đột lúc restore.
        "--exclude-schema=auth",
        "--exclude-schema=storage",
        "--exclude-schema=realtime",
        "--exclude-schema=supabase_migrations",
        "--exclude-schema=vault",
        "--exclude-schema=extensions",
        "--exclude-schema=graphql*",
        "--exclude-schema=pgbouncer",
        "--exclude-schema=cron",
        "--exclude-schema=net",
      ],
      { env: { ...process.env, PGPASSFILE: passFile }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60 * 1000 },
    );
  } finally {
    rmSync(passFile, { force: true });
  }

  if (res.error || res.status !== 0) {
    console.error("❌ pg_dump thất bại.");
    if (res.stderr) console.error(String(res.stderr).slice(0, 1000));
    return 1;
  }

  const raw = res.stdout;
  const { sql: normalized, removed } = stripRuntimePartitions(raw);
  const offenders = assertNoData(normalized);

  const rawLines = raw.split("\n").length;
  const normLines = normalized.split("\n").length;
  console.log(`  raw: ${rawLines} dòng → canonical: ${normLines} dòng`);
  console.log(`  đã loại ${removed.length} partition runtime`);

  if (offenders.length > 0) {
    console.error(`❌ Baseline chứa DỮ LIỆU (${offenders.join(", ")}) — từ chối ghi.`);
    return 1;
  }
  console.log("  ✅ không chứa dòng dữ liệu nào");

  const counts = {
    tables: (normalized.match(/^CREATE TABLE /gm) ?? []).length,
    functions: (normalized.match(/^CREATE (OR REPLACE )?FUNCTION /gm) ?? []).length,
    views: (normalized.match(/^CREATE (OR REPLACE )?VIEW /gm) ?? []).length,
    policies: (normalized.match(/^CREATE POLICY /gm) ?? []).length,
    indexes: (normalized.match(/^CREATE (UNIQUE )?INDEX /gm) ?? []).length,
    triggers: (normalized.match(/^CREATE TRIGGER /gm) ?? []).length,
  };
  console.log(`  ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ")}`);

  if (!argv.includes("--write")) {
    console.log("\nChạy với --write để ghi supabase/baseline/.");
    return 0;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const schemaPath = join(OUT_DIR, "schema.sql");
  writeFileSync(schemaPath, normalized, "utf8");

  const manifest = {
    $comment:
      "SINH BỞI scripts/capture-schema-baseline.mjs — không sửa tay. Đây là đường dựng lại môi trường THAY CHO việc replay 640 file migration (vốn không chạy được).",
    capturedAt: new Date().toISOString(),
    sourceProject: ref,
    containsData: false,
    sha256: createHash("sha256").update(normalized).digest("hex"),
    counts,
    removedRuntimePartitions: removed.length,
    excludedSchemas: ["auth", "storage", "realtime", "supabase_migrations", "vault", "extensions", "graphql*", "pgbouncer", "cron", "net"],
    restoreNotes: [
      "Restore vào một Supabase project MỚI (đã có sẵn role authenticated/anon/service_role). Postgres cài trần sẽ thiếu role và RLS policy không vào được — đã đo 06/08/2026.",
      "Sau restore, chạy hàm ensure_raw_partitions của Network Center để tạo partition ngày; baseline cố ý KHÔNG chứa chúng.",
      "Baseline chỉ là ĐIỂM BẮT ĐẦU: apply tiếp các forward migration có version > cutoff trong migration-policy.json.",
    ],
  };
  writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`✅ Đã ghi ${schemaPath.replace(repoRoot, ".")} (${(Buffer.byteLength(normalized) / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`   sha256: ${manifest.sha256.slice(0, 16)}…`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
