#!/usr/bin/env node
// Chụp catalog production thành inventory machine-readable + fingerprint.
//
// Vì sao cần: tài liệu đang chép tay số đếm object ("371 migration", "164 bảng",
// "322 hàm") ở BA file khác nhau, lệch thực tế hàng trăm đơn vị, và CI vẫn xanh
// vì không ai kiểm. Số đếm thủ công không phải API ổn định. File này sinh số từ
// catalog thật để tài liệu đọc lại, và cho phép so fingerprint trước/sau mỗi lần
// apply migration.
//
//   node scripts/capture-production-catalog.mjs            # in tóm tắt, không ghi
//   node scripts/capture-production-catalog.mjs --write    # ghi docs/generated/
//   node scripts/capture-production-catalog.mjs --check    # exit 1 nếu file đã ghi bị drift
//
// CHỈ ĐỌC: chỉ chạy SELECT trên pg_catalog. Không CREATE/ALTER/DROP, không đụng
// dữ liệu nghiệp vụ. An toàn kể cả khi PITR đang tắt.
//
// PAT đọc từ env SUPABASE_PAT hoặc CLAUDE.local.md (không bao giờ in ra).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(repoRoot, 'docs', 'generated');
const OUT_JSON = join(OUT_DIR, 'database-inventory.json');

export function readPat() {
  if (process.env.SUPABASE_PAT) return process.env.SUPABASE_PAT;
  try {
    const local = readFileSync(join(repoRoot, 'CLAUDE.local.md'), 'utf8');
    const m = local.match(/sbp_[a-f0-9]+/);
    if (m) return m[0];
  } catch { /* không có file local — sẽ báo lỗi bên dưới */ }
  return null;
}

export function readProjectRef() {
  if (process.env.SUPABASE_PROJECT_REF) return process.env.SUPABASE_PROJECT_REF;
  try {
    return readFileSync(join(repoRoot, 'supabase', '.temp', 'project-ref'), 'utf8').trim();
  } catch { /* chưa supabase link */ }
  return 'tryymsxyyckgbrmmvozx';
}

async function runSql(sql, { pat, ref }) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) {
    // Không in body nguyên vẹn: response lỗi có thể vọng lại câu SQL.
    throw new Error(`Management API ${res.status} khi truy vấn catalog`);
  }
  return JSON.parse(text);
}

const QUERIES = {
  // Tách bảng logic khỏi phân mảnh vật lý: relispartition=true là child partition
  // do runtime sinh, KHÔNG phải object schema mà người ta thiết kế.
  tables: `
    SELECT c.relname AS name,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced,
           c.relispartition AS is_partition,
           (c.relkind = 'p') AS is_partitioned_parent
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
    ORDER BY c.relname`,
  views: `
    SELECT c.relname AS name,
           COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                     WHERE option_name = 'security_invoker'), 'false') AS security_invoker
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'v'
    ORDER BY c.relname`,
  functions: `
    SELECT n.nspname AS schema,
           p.proname AS name,
           pg_get_function_identity_arguments(p.oid) AS args,
           p.prosecdef AS security_definer,
           p.provolatile AS volatility,
           (p.proconfig IS NOT NULL AND EXISTS (
              SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'
           )) AS has_search_path
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public','app_private')
    ORDER BY n.nspname, p.proname, args`,
  enums: `
    SELECT t.typname AS name, count(e.enumlabel) AS labels
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE n.nspname = 'public'
    GROUP BY t.typname ORDER BY t.typname`,
  realtime: `
    SELECT tablename AS name
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
    ORDER BY tablename`,
  version: `SELECT current_setting('server_version') AS server_version`,
};

export function summarize(raw) {
  const logicalTables = raw.tables.filter((t) => !t.is_partition);
  const childPartitions = raw.tables.filter((t) => t.is_partition);
  const definers = raw.functions.filter((f) => f.security_definer);

  return {
    // Số liệu ở đây là DẪN XUẤT, không phải hằng số gõ tay. Mọi tài liệu cần
    // con số thì đọc file này, đừng chép lại.
    counts: {
      logicalTables: logicalTables.length,
      childPartitions: childPartitions.length,
      views: raw.views.length,
      functions: raw.functions.length,
      securityDefinerFunctions: definers.length,
      enums: raw.enums.length,
      realtimeTables: raw.realtime.length,
    },
    invariants: {
      tablesWithoutRls: logicalTables.filter((t) => !t.rls_enabled).map((t) => t.name),
      viewsWithoutSecurityInvoker: raw.views
        .filter((v) => String(v.security_invoker).toLowerCase() !== 'true')
        .map((v) => v.name),
      definersWithoutSearchPath: definers
        .filter((f) => !f.has_search_path)
        .map((f) => `${f.schema}.${f.name}(${f.args})`),
    },
  };
}

/**
 * Fingerprint bỏ QUA child partition và mọi thứ phụ thuộc ngày.
 *
 * Nếu tính cả partition thì fingerprint đổi mỗi ngày do maintenance sinh mảnh
 * mới — báo động giả hằng ngày sẽ bị tắt đi trong một tuần, và khi ấy thay đổi
 * schema thật cũng không ai thấy.
 */
export function catalogFingerprint(raw) {
  const canonical = {
    tables: raw.tables.filter((t) => !t.is_partition).map((t) => [t.name, t.rls_enabled, t.rls_forced]),
    views: raw.views.map((v) => [v.name, String(v.security_invoker).toLowerCase()]),
    functions: raw.functions.map((f) => [f.schema, f.name, f.args, f.security_definer, f.volatility, f.has_search_path]),
    enums: raw.enums.map((e) => [e.name, Number(e.labels)]),
    realtime: raw.realtime.map((r) => r.name),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function main(argv) {
  const args = new Set(argv.slice(2));
  const pat = readPat();
  if (!pat) {
    console.error('❌ Không tìm thấy PAT (env SUPABASE_PAT hoặc CLAUDE.local.md).');
    return 1;
  }
  const ref = readProjectRef();

  const raw = {};
  for (const [key, sql] of Object.entries(QUERIES)) {
    raw[key] = await runSql(sql, { pat, ref });
  }

  const summary = summarize(raw);
  const fingerprint = catalogFingerprint(raw);
  const serverVersion = raw.version[0]?.server_version ?? 'unknown';

  const inventory = {
    $comment:
      'SINH BỞI scripts/capture-production-catalog.mjs — không sửa tay. Tài liệu cần số đếm thì đọc file này.',
    projectRef: ref,
    serverVersion,
    capturedAt: new Date().toISOString(),
    catalogFingerprint: fingerprint,
    ...summary,
  };

  console.log(`Project ${ref} · PostgreSQL ${serverVersion}`);
  console.log(`  bảng logic: ${summary.counts.logicalTables} (+${summary.counts.childPartitions} phân mảnh runtime)`);
  console.log(`  view: ${summary.counts.views} · hàm: ${summary.counts.functions} (${summary.counts.securityDefinerFunctions} SECURITY DEFINER)`);
  console.log(`  enum: ${summary.counts.enums} · bảng realtime: ${summary.counts.realtimeTables}`);
  console.log(`  fingerprint: ${fingerprint.slice(0, 16)}…`);

  const bad = summary.invariants;
  let failed = false;
  for (const [label, list] of [
    ['bảng thiếu RLS', bad.tablesWithoutRls],
    ['view thiếu security_invoker', bad.viewsWithoutSecurityInvoker],
    ['hàm DEFINER thiếu search_path', bad.definersWithoutSearchPath],
  ]) {
    if (list.length > 0) {
      failed = true;
      console.error(`❌ ${list.length} ${label}: ${list.slice(0, 5).join(', ')}${list.length > 5 ? ' …' : ''}`);
    }
  }
  if (!failed) console.log('✅ RLS, security_invoker và search_path: không có object hở.');

  if (args.has('--check')) {
    let previous;
    try {
      previous = JSON.parse(readFileSync(OUT_JSON, 'utf8'));
    } catch {
      console.error(`❌ Chưa có ${OUT_JSON}. Chạy với --write trước.`);
      return 1;
    }
    if (previous.catalogFingerprint !== fingerprint) {
      console.error('❌ Catalog drift so với inventory đã commit.');
      console.error(`   đã ghi:   ${previous.catalogFingerprint}`);
      console.error(`   hiện tại: ${fingerprint}`);
      console.error('   Nếu là thay đổi có chủ đích: chạy --write và commit kèm migration.');
      return 1;
    }
    console.log('✅ Catalog khớp inventory đã commit.');
    return failed ? 1 : 0;
  }

  if (args.has('--write')) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT_JSON, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
    console.log(`✅ Đã ghi ${OUT_JSON.replace(repoRoot, '.')}`);
  }

  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    });
}
