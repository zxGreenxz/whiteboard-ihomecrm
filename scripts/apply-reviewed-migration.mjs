#!/usr/bin/env node
// Đường apply DUY NHẤT cho migration sau cutoff (forward-only lane).
//
// Kế thừa các nguyên tắc đã được chứng minh trong scripts/apply-accounting-rollout.mjs
// (advisory lock có timeout, một cặp BEGIN/COMMIT, digest sha256, dry-run mặc
// định) thay vì dựng một runner generic yếu hơn. Cái mới ở đây là ba lớp chặn:
// provenance, cutoff, và promotion token.
//
//   node scripts/apply-reviewed-migration.mjs <file.sql>            # DRY-RUN
//   node scripts/apply-reviewed-migration.mjs <file.sql> --apply    # ghi thật
//
// BA LỚP CHẶN, theo thứ tự:
//   1. File phải có version > cutoff trong supabase/migration-policy.json.
//      Migration cũ là legacy-frozen, sửa chúng là chuyện khác hẳn.
//   2. File phải có entry trong migration-provenance.json và sha256 phải KHỚP.
//      Bytes đổi sau khi sinh manifest ⇒ ai đó sửa file sau review.
//   3. --apply đòi IHOMECRM_PROMOTION_TOKEN nhập tại thời điểm chạy.
//      PAT trong CLAUDE.local.md cho phép ghi production bất cứ lúc nào; token
//      riêng này là thứ biến "chỉ con người mới phát hành" từ lời văn thành cơ
//      chế. KHÔNG lưu nó vào vault.
//
// PITR đang TẮT ⇒ luôn chạy backup trước:
//   node scripts/backup-before-schema.mjs --reason "apply <tên file>"

import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY = join(repoRoot, "supabase", "migration-policy.json");
const PROVENANCE = join(repoRoot, "supabase", "migration-provenance.json");
const EVIDENCE_DIR = join(repoRoot, "docs", "generated", "schema-change-evidence");

const LOCK_NAME = "ihomecrm:forward-migration:v1";
const LOCK_TIMEOUT = "5s";
const STATEMENT_TIMEOUT = "120s";

function readPat() {
  if (process.env.SUPABASE_PAT) return process.env.SUPABASE_PAT;
  try {
    const m = readFileSync(join(repoRoot, "CLAUDE.local.md"), "utf8").match(/sbp_[a-f0-9]+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

function projectRef() {
  try {
    return readFileSync(join(repoRoot, "supabase", ".temp", "project-ref"), "utf8").trim();
  } catch {
    return "tryymsxyyckgbrmmvozx";
  }
}

/** Bọc migration trong một transaction có khoá và timeout rõ ràng. */
export function buildTransaction(sql, { rollback = false } = {}) {
  return [
    "BEGIN;",
    `SET LOCAL lock_timeout = '${LOCK_TIMEOUT}';`,
    `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}';`,
    `SELECT pg_advisory_xact_lock(hashtext('${LOCK_NAME}'));`,
    "",
    sql.trim(),
    "",
    rollback ? "ROLLBACK;" : "COMMIT;",
  ].join("\n");
}

export function checkGuards(file, { policy, provenance }) {
  const problems = [];
  const name = basename(file);
  const version = /^(\d{14})_/.exec(name)?.[1] ?? null;
  const cutoff = policy.provisionalCutoff.version;

  if (!version) {
    problems.push(`${name}: tên file phải bắt đầu bằng timestamp 14 chữ số.`);
  } else if (version <= cutoff) {
    problems.push(
      `${name}: version ${version} <= cutoff ${cutoff}.\n` +
      `      File trước cutoff là legacy-frozen (chỉ đọc). Muốn đổi hành vi thì viết file MỚI.`,
    );
  }

  const rel = `supabase/migrations/${name}`;
  const entry = provenance.entries.find((e) => e.path === rel);
  if (!entry) {
    problems.push(
      `${name}: chưa có entry trong migration-provenance.json.\n` +
      `      → chạy: npm run provenance:generate`,
    );
  } else {
    const sha = createHash("sha256").update(readFileSync(file, "utf8")).digest("hex");
    if (sha !== entry.sha256) {
      problems.push(
        `${name}: sha256 KHÔNG khớp manifest — file đã bị sửa sau khi sinh provenance.\n` +
        `      manifest: ${entry.sha256.slice(0, 16)}…  file: ${sha.slice(0, 16)}…`,
      );
    }
  }

  return problems;
}

async function main(argv) {
  const file = argv[2];
  const doApply = argv.includes("--apply");

  if (!file || file.startsWith("--")) {
    console.error("Dùng: node scripts/apply-reviewed-migration.mjs <file.sql> [--apply]");
    return 1;
  }
  const abs = join(repoRoot, file.replace(/^\.[\\/]/, ""));
  if (!existsSync(abs)) {
    console.error(`❌ Không thấy file: ${file}`);
    return 1;
  }

  const policy = JSON.parse(readFileSync(POLICY, "utf8"));
  const provenance = JSON.parse(readFileSync(PROVENANCE, "utf8"));

  const problems = checkGuards(abs, { policy, provenance });
  if (problems.length > 0) {
    console.error("❌ Chặn bởi gate forward-lane:\n");
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }

  const sql = readFileSync(abs, "utf8");
  const digest = createHash("sha256").update(sql).digest("hex");
  const transaction = buildTransaction(sql, { rollback: !doApply });

  console.log(`File   : ${basename(abs)}`);
  console.log(`Digest : ${digest.slice(0, 16)}…`);
  console.log(`Chế độ : ${doApply ? "APPLY THẬT" : "DRY-RUN (bọc ROLLBACK)"}`);

  if (doApply) {
    const token = process.env.IHOMECRM_PROMOTION_TOKEN;
    if (!token) {
      console.error(
        "\n❌ Thiếu IHOMECRM_PROMOTION_TOKEN.\n" +
        "   Ghi production đòi token nhập TẠI THỜI ĐIỂM CHẠY, không lấy từ CLAUDE.local.md.\n" +
        "   Đây là chỗ duy nhất biến 'chỉ con người mới phát hành' thành cơ chế thật —\n" +
        "   PAT trong vault cho phép ghi production bất cứ lúc nào mà không ai hay.",
      );
      return 1;
    }
    console.log("⚠ Đã có promotion token — sẽ GHI THẬT lên production.");
    console.log("  Đã chạy backup chưa? (node scripts/backup-before-schema.mjs --reason \"…\")");
  }

  const pat = readPat();
  if (!pat) {
    console.error("❌ Không tìm thấy PAT.");
    return 1;
  }
  const ref = projectRef();

  const started = Date.now();
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: transaction }),
  });
  const body = await res.text();

  if (!res.ok) {
    console.error(`❌ ${doApply ? "Apply" : "Dry-run"} thất bại (HTTP ${res.status}).`);
    console.error(body.slice(0, 1500));
    return 1;
  }

  console.log(`✅ ${doApply ? "Đã apply" : "Dry-run xanh (đã ROLLBACK)"} sau ${Math.round((Date.now() - started) / 1000)}s`);

  if (doApply) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const evidence = {
      file: `supabase/migrations/${basename(abs)}`,
      sha256: digest,
      appliedAt: new Date().toISOString(),
      projectRef: ref,
      lockName: LOCK_NAME,
      statementTimeout: STATEMENT_TIMEOUT,
      note: "Apply qua forward-only lane. Ledger supabase_migrations KHÔNG bị backfill — nguồn sự thật là manifest provenance + file evidence này.",
    };
    const out = join(EVIDENCE_DIR, `${basename(abs, ".sql")}.json`);
    writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(`   evidence: ${out.replace(repoRoot, ".")}`);
    console.log("   Nhớ: chạy npm run provenance:generate để cập nhật state, và npm run catalog:capture.");
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
    .then((c) => process.exit(c))
    .catch((e) => {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    });
}
