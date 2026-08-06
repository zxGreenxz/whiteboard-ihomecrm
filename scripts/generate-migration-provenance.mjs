#!/usr/bin/env node
// Sinh supabase/migration-provenance.json: mỗi file SQL trong repo được phân
// loại theo BẰNG CHỨNG, không theo phỏng đoán từ timestamp.
//
// VÌ SAO CẦN: ledger `supabase_migrations.schema_migrations` dừng ở
// 20260727095000 trong khi production đã có thay đổi muộn hơn, và repo có 640
// file SQL với ba quy ước đặt tên khác nhau. Câu hỏi "file này đã chạy chưa"
// hiện không ai trả lời được — điều đó chặn cả việc dựng lại môi trường lẫn
// việc biết cái gì an toàn để bỏ đi.
//
//   node scripts/generate-migration-provenance.mjs            # in tóm tắt
//   node scripts/generate-migration-provenance.mjs --write    # ghi manifest
//
// CHỈ ĐỌC database (ledger + catalog). Không CREATE/ALTER/DROP.
//
// Cách phân loại (xếp theo độ mạnh của bằng chứng, dừng ở cái đầu tiên khớp):
//   ledger-applied   file khớp CHÍNH XÁC (version, name) một dòng trong ledger
//   catalog-proven   không có trong ledger, NHƯNG mọi object nó tạo đều tồn tại
//                    trong catalog production
//   superseded       nằm trong migrations-archive/ (README ở đó ghi rõ KHÔNG replay)
//   unknown          còn lại — phải người xem, KHÔNG được đoán là đã chạy
//
// Người review duyệt QUY TẮC và MẪU KIỂM, không ký từng file. Ký 640 chữ ký mất
// 25-30 giờ và sẽ thành ký hình thức — lúc đó trường reviewedBy mất hết ý nghĩa.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(repoRoot, "supabase", "migrations");
const ARCHIVE_DIR = join(repoRoot, "supabase", "migrations-archive");
const OUT = join(repoRoot, "supabase", "migration-provenance.json");

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

async function runSql(sql, { pat, ref }) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`Management API ${res.status} khi truy vấn`);
  return res.json();
}

/** Tách version/name từ tên file, hỗ trợ cả ba quy ước đặt tên trong repo. */
export function parseFileName(file) {
  // 20260805120000_ten_migration.sql
  let m = /^(\d{14})_(.+)\.sql$/.exec(file);
  if (m) return { version: m[1], name: m[2], scheme: "timestamp14" };
  // 001_ten.sql  (bộ legacy)
  m = /^(\d{1,3})_(.+)\.sql$/.exec(file);
  if (m) return { version: m[1], name: m[2], scheme: "legacy-seq" };
  // 20260426_apply_all.sql  (bundle hand-apply)
  m = /^(\d{8})_(.+)\.sql$/.exec(file);
  if (m) return { version: m[1], name: m[2], scheme: "date8" };
  return { version: null, name: file.replace(/\.sql$/, ""), scheme: "unrecognised" };
}

/**
 * Rút tên object mà một file SQL TẠO RA.
 *
 * Cố ý chỉ bắt CREATE — không bắt ALTER/DROP. Một file chỉ ALTER bảng có sẵn
 * thì sự tồn tại của bảng đó KHÔNG chứng minh file đã chạy, và đếm nó là bằng
 * chứng sẽ tạo ra kết luận sai theo hướng nguy hiểm nhất ("tưởng đã chạy rồi").
 */
export function extractCreatedObjects(sql) {
  const objects = { tables: [], functions: [], views: [], indexes: [], policies: [], triggers: [] };
  const clean = sql.replace(/--[^\n]*/g, "");

  // Bắt schema qualifier TỔNG QUÁT. Bản đầu chỉ nhận `public.` nên với
  // `CREATE TABLE app_private.foo` nó lấy nhầm "app_private" làm tên bảng và
  // đẩy 6+ file finance_v2 thành `unknown` một cách sai — phát hiện khi đọc
  // danh sách unknown thấy `table:app_private` lặp lại.
  for (const m of clean.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?([a-z0-9_]+)"?\.)?"?([a-z0-9_]+)"?/gi,
  )) {
    objects.tables.push(`${(m[1] ?? "public").toLowerCase()}.${m[2].toLowerCase()}`);
  }
  for (const m of clean.matchAll(
    /create\s+(?:or\s+replace\s+)?function\s+(?:"?([a-z0-9_]+)"?\.)?"?([a-z0-9_]+)"?/gi,
  )) {
    objects.functions.push(`${(m[1] ?? "public").toLowerCase()}.${m[2].toLowerCase()}`);
  }
  for (const m of clean.matchAll(
    /create\s+(?:or\s+replace\s+)?view\s+(?:"?([a-z0-9_]+)"?\.)?"?([a-z0-9_]+)"?/gi,
  )) {
    objects.views.push(`${(m[1] ?? "public").toLowerCase()}.${m[2].toLowerCase()}`);
  }
  // Index / policy / trigger cũng là object được TẠO RA, nên cùng sức chứng minh
  // như table/function/view — chỉ là bản đầu chưa bóc. Đo 06/08/2026: trong 66 file
  // `unknown`, có 12 file tạo một trong ba loại này và vì thế bị xếp "không chứng
  // minh được" một cách oan.
  for (const m of clean.matchAll(
    /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?\s+on\s+(?:only\s+)?(?:"?([a-z0-9_]+)"?\.)?"?([a-z0-9_]+)"?/gi,
  )) {
    // Index nằm trong cùng schema với bảng nó gắn vào.
    objects.indexes.push(`${(m[2] ?? "public").toLowerCase()}.${m[1].toLowerCase()}`);
  }
  for (const m of clean.matchAll(
    /create\s+policy\s+"?([a-z0-9_ -]+?)"?\s+on\s+(?:"?([a-z0-9_]+)"?\.)?"?([a-z0-9_]+)"?/gi,
  )) {
    objects.policies.push(
      `${(m[2] ?? "public").toLowerCase()}.${m[3].toLowerCase()}.${m[1].trim().toLowerCase()}`,
    );
  }
  for (const m of clean.matchAll(
    /create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+"?([a-z0-9_]+)"?[\s\S]{0,200}?\son\s+(?:only\s+)?(?:"?([a-z0-9_]+)"?\.)?"?([a-z0-9_]+)"?/gi,
  )) {
    objects.triggers.push(
      `${(m[2] ?? "public").toLowerCase()}.${m[3].toLowerCase()}.${m[1].toLowerCase()}`,
    );
  }

  // Loại OBJECT MA sinh do backtracking. Với SQL động
  // `format('CREATE TABLE public.%I PARTITION OF …')`, regex không khớp nổi `%I`
  // làm tên bảng nên lùi lại, bỏ nhóm schema, rồi lấy chính `public` làm tên bảng
  // — ra `public.public`, và file bị xếp `unknown` vì "thiếu bảng public".
  // Đo ở 20260729020000_network_center_current_telemetry.sql.
  //
  // ĐÃ THỬ cách tổng quát hơn — bỏ mọi chuỗi nháy đơn trước khi bóc — và nó SAI
  // NẶNG HƠN: thân hàm PL/pgSQL đầy nháy đơn, nên regex ghép nhầm nháy giữa hai
  // hàm khác nhau và nuốt luôn các `CREATE FUNCTION` nằm giữa. Đo được: 4 file
  // mất sạch bằng chứng, catalog-proven tụt 209 → 206. Vì vậy giữ cách hẹp:
  // chỉ loại đúng dạng object-ma, không đụng gì khác.
  const laObjectMa = (n) => {
    const phan = n.split(".");
    return phan.length === 2 && phan[0] === phan[1];
  };
  const loc = (arr) => [...new Set(arr)].filter((n) => !laObjectMa(n));

  return {
    tables: loc(objects.tables),
    functions: loc(objects.functions),
    views: loc(objects.views),
    indexes: loc(objects.indexes),
    policies: [...new Set(objects.policies)],
    triggers: [...new Set(objects.triggers)],
  };
}

/**
 * Cột mà file thêm bằng `ALTER TABLE … ADD COLUMN`.
 *
 * Vì sao đáng bóc riêng: 62/66 file `unknown` là loại CHỈ ALTER/DML, và luật hiện
 * hành nói "không CREATE object nào nên không chứng minh tự động được". Đúng theo
 * chiều KHẲNG ĐỊNH — cột tồn tại KHÔNG chứng minh chính file này thêm nó.
 *
 * Nhưng chiều PHỦ ĐỊNH thì kết luận được, và đó mới là chiều đáng giá: nếu cột mà
 * file này thêm KHÔNG có trong production, thì file này gần như chắc chắn CHƯA
 * BAO GIỜ chạy. Đó là bằng chứng máy thật sự, không phải suy đoán từ timestamp.
 *
 * Cố ý bỏ qua `IF NOT EXISTS`? KHÔNG — vẫn bóc, vì kể cả file idempotent thì cột
 * vắng mặt vẫn nghĩa là nó chưa chạy.
 */
export function extractAddedColumns(sql) {
  const clean = sql.replace(/--[^\n]*/g, "");
  const out = [];
  // ALTER TABLE [IF EXISTS] [ONLY] [schema.]table ADD [COLUMN] [IF NOT EXISTS] col
  //
  // `(?!constraint|primary|foreign|unique|check|exclude|generated)` là BẮT BUỘC.
  // Không có nó, `ALTER TABLE x ADD CONSTRAINT foo …` bị đọc thành "thêm cột tên
  // `constraint`" — vì `COLUMN` là từ khoá tuỳ chọn trong cú pháp Postgres. Bản
  // đầu tôi viết thiếu và nó lập tức sinh 3 báo động giả "migration chưa chạy",
  // cả ba đều là cột tên `constraint` không tồn tại. Đúng kiểu sai nguy hiểm
  // nhất cho một công cụ forensics: nó không im lặng, nó nói dối một cách tự tin.
  const re =
    /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?([a-z0-9_]+)"?\.)?"?([a-z0-9_]+)"?\s+add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?(?!constraint\b|primary\b|foreign\b|unique\b|check\b|exclude\b|generated\b)"?([a-z0-9_]+)"?/gi;
  for (const m of clean.matchAll(re)) {
    const schema = (m[1] ?? "public").toLowerCase();
    out.push(`${schema}.${m[2].toLowerCase()}.${m[3].toLowerCase()}`);
  }
  return [...new Set(out)];
}

export function classify(entry, { ledgerIndex, catalog }) {
  const { version, name } = entry;

  if (version && ledgerIndex.has(`${version}|${name}`)) {
    return { state: "ledger-applied", evidence: [`ledger:${version}|${name}`] };
  }

  if (entry.archived) {
    return {
      state: "superseded",
      evidence: ["archive:supabase/migrations-archive/README.md ghi rõ KHÔNG replay"],
    };
  }

  const created = entry.created;
  const total = created.tables.length + created.functions.length + created.views.length
    + created.indexes.length + created.policies.length + created.triggers.length;
  if (total > 0) {
    const missing = [
      ...created.tables.filter((t) => !catalog.tables.has(t)).map((t) => `table:${t}`),
      ...created.functions.filter((f) => !catalog.functions.has(f)).map((f) => `function:${f}`),
      ...created.views.filter((v) => !catalog.views.has(v)).map((v) => `view:${v}`),
      ...created.indexes.filter((i) => !catalog.indexes.has(i)).map((i) => `index:${i}`),
      ...created.policies.filter((p) => !catalog.policies.has(p)).map((p) => `policy:${p}`),
      ...created.triggers.filter((t) => !catalog.triggers.has(t)).map((t) => `trigger:${t}`),
    ];
    if (missing.length === 0) {
      const sample = [
        ...created.tables.slice(0, 2).map((t) => `catalog:table:${t}`),
        ...created.functions.slice(0, 2).map((f) => `catalog:function:${f}`),
        ...created.views.slice(0, 1).map((v) => `catalog:view:${v}`),
        ...created.indexes.slice(0, 1).map((i) => `catalog:index:${i}`),
        ...created.policies.slice(0, 1).map((p) => `catalog:policy:${p}`),
        ...created.triggers.slice(0, 1).map((t) => `catalog:trigger:${t}`),
      ];
      return { state: "catalog-proven", evidence: sample };
    }
    return { state: "unknown", evidence: [], missing: missing.slice(0, 5) };
  }

  // File chỉ ALTER/DML. KHÔNG nâng lên catalog-proven dù các cột nó thêm đều có
  // mặt: cột tồn tại không chứng minh CHÍNH FILE NÀY thêm nó (một file khác có thể
  // đã thêm cột trùng tên) — đúng cùng điểm yếu mà migration-policy.json đã ghi.
  //
  // Nhưng chiều PHỦ ĐỊNH thì kết luận được: cột KHÔNG có trong production nghĩa là
  // file này gần như chắc chắn chưa bao giờ chạy. Đó là thứ đáng báo, vì nó biến
  // "chưa biết" thành "gần như chắc chắn chưa apply" — một việc phải làm, không
  // phải một ô trống.
  const added = entry.addedColumns ?? [];
  if (added.length > 0 && catalog.columns) {
    const absent = added.filter((c) => !catalog.columns.has(c));
    if (absent.length > 0) {
      return {
        state: "unknown",
        evidence: [],
        missing: absent.slice(0, 5).map((c) => `column:${c}`),
        note: `${absent.length}/${added.length} cột file này ADD KHÔNG có trong production ⇒ nhiều khả năng CHƯA CHẠY`,
      };
    }
    return {
      state: "unknown",
      evidence: [],
      missing: ["(chỉ ALTER/DML — không chứng minh tự động được)"],
      note: `${added.length} cột file này ADD đều CÓ trong production (nhất quán, nhưng KHÔNG phải bằng chứng file đã chạy)`,
    };
  }

  return { state: "unknown", evidence: [], missing: ["(file không CREATE object nào — chỉ ALTER/DML)"] };
}

async function main(argv) {
  const pat = readPat();
  if (!pat) {
    console.error("❌ Không tìm thấy PAT.");
    return 1;
  }
  const ref = projectRef();

  const ledgerRows = await runSql(
    "SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version",
    { pat, ref },
  );
  const ledgerIndex = new Set(ledgerRows.map((r) => `${r.version}|${r.name}`));

  const [tables, functions, views, columns, indexes, policies, triggers] = await Promise.all([
    runSql(
      "SELECT ns.nspname||'.'||c.relname AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND ns.nspname NOT LIKE 'pg_temp%' AND c.relkind IN ('r','p')",
      { pat, ref },
    ),
    runSql(
      "SELECT n.nspname||'.'||p.proname AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_temp%'",
      { pat, ref },
    ),
    runSql(
      "SELECT ns.nspname||'.'||c.relname AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE ns.nspname NOT IN ('pg_catalog','information_schema') AND c.relkind='v'",
      { pat, ref },
    ),
    // Cột: để kết luận được chiều PHỦ ĐỊNH cho các file chỉ ALTER (xem classify).
    runSql(
      "SELECT ns.nspname||'.'||c.relname||'.'||a.attname AS n FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p') AND ns.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND ns.nspname NOT LIKE 'pg_temp%'",
      { pat, ref },
    ),
    // relkind 'i' = index thường, 'I' = index trên bảng PHÂN MẢNH. Bỏ sót 'I' làm
    // bộ chứng minh mù với mọi index của Network Center (samples phân mảnh theo
    // ngày) → file tạo chúng bị chấm `unknown` OAN. Đo 06/08/2026: 6 index
    // relkind='I' tồn tại trong production mà truy vấn cũ không thấy cái nào,
    // khiến 20260729020000_network_center_current_telemetry.sql mất sạch bằng
    // chứng dù cả 2 index nó tạo đều đang chạy. So sánh: truy vấn bảng ở trên đã
    // lấy đúng IN ('r','p') — cùng một cặp thường/phân-mảnh, chỉ index bị quên.
    runSql(
      "SELECT ns.nspname||'.'||c.relname AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE c.relkind IN ('i','I') AND ns.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND ns.nspname NOT LIKE 'pg_temp%'",
      { pat, ref },
    ),
    runSql(
      "SELECT schemaname||'.'||tablename||'.'||policyname AS n FROM pg_policies",
      { pat, ref },
    ),
    runSql(
      "SELECT ns.nspname||'.'||c.relname||'.'||t.tgname AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE NOT t.tgisinternal",
      { pat, ref },
    ),
  ]);
  const catalog = {
    tables: new Set(tables.map((r) => r.n.toLowerCase())),
    functions: new Set(functions.map((r) => r.n.toLowerCase())),
    views: new Set(views.map((r) => r.n.toLowerCase())),
    columns: new Set(columns.map((r) => r.n.toLowerCase())),
    indexes: new Set(indexes.map((r) => r.n.toLowerCase())),
    policies: new Set(policies.map((r) => r.n.toLowerCase())),
    triggers: new Set(triggers.map((r) => r.n.toLowerCase())),
  };

  const entries = [];
  const collect = (dir, relPrefix, archived) => {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
      const full = join(dir, file);
      const sql = readFileSync(full, "utf8");
      const { version, name, scheme } = parseFileName(file);
      entries.push({
        path: `${relPrefix}/${file}`,
        version,
        name,
        scheme,
        archived,
        sha256: createHash("sha256").update(sql).digest("hex"),
        created: extractCreatedObjects(sql),
        addedColumns: extractAddedColumns(sql),
      });
    }
  };
  collect(MIGRATIONS_DIR, "supabase/migrations", false);
  collect(join(ARCHIVE_DIR), "supabase/migrations-archive", true);
  try {
    collect(join(ARCHIVE_DIR, "migrations-bundle"), "supabase/migrations-archive/migrations-bundle", true);
  } catch { /* thư mục có thể không tồn tại */ }

  for (const e of entries) {
    const r = classify(e, { ledgerIndex, catalog });
    e.state = r.state;
    e.evidence = r.evidence;
    if (r.missing) e.missingObjects = r.missing;
    if (r.note) e.note = r.note;
    delete e.created;
    delete e.archived;
    delete e.addedColumns;
  }

  const counts = {};
  for (const e of entries) counts[e.state] = (counts[e.state] ?? 0) + 1;

  console.log(`Ledger: ${ledgerRows.length} dòng · File SQL: ${entries.length}`);
  for (const [state, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${state}`);
  }

  const dupes = new Map();
  for (const e of entries) {
    if (!e.version) continue;
    dupes.set(e.version, (dupes.get(e.version) ?? 0) + 1);
  }
  const dupVersions = [...dupes].filter(([, n]) => n > 1);
  console.log(`  ${dupVersions.length} version bị trùng (tổng ${dupVersions.reduce((s, [, n]) => s + n, 0)} file)`);

  if (argv.includes("--write")) {
    const manifest = {
      $comment:
        "SINH BỞI scripts/generate-migration-provenance.mjs — không sửa tay. State dựa trên BẰNG CHỨNG (ledger/catalog), không suy từ timestamp. Xem đầu script để biết luật phân loại.",
      generatedAt: new Date().toISOString(),
      projectRef: ref,
      ledgerRows: ledgerRows.length,
      ledgerMaxVersion: ledgerRows.at(-1)?.version ?? null,
      counts,
      duplicateVersions: dupVersions.length,
      reviewModel:
        "Người review duyệt QUY TẮC phân loại và MẪU KIỂM theo batch, không ký từng file. Mọi file 'unknown' và mọi file đụng tiền/RLS/SECURITY DEFINER phải được xem 100%.",
      entries,
    };
    writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`✅ Đã ghi ${OUT.replace(repoRoot, ".")}`);
  } else {
    console.log("\nChạy với --write để ghi manifest.");
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
