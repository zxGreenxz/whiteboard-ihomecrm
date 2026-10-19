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
//   node scripts/apply-reviewed-migration.mjs <file.sql> --env test # TEST, ROLLBACK
//
// BA LỚP CHẶN, theo thứ tự:
//   1. File phải có version > cutoff trong supabase/migration-policy.json.
//      Migration cũ là legacy-frozen, sửa chúng là chuyện khác hẳn.
//   2. File phải có entry trong migration-provenance.json và sha256 phải KHỚP.
//      Bytes đổi sau khi sinh manifest ⇒ ai đó sửa file sau review.
//   3. --apply đòi GIẤY PHÉP. Từ 07/08/2026 có HAI dạng, và đây là chỗ luật đã
//      đổi theo yêu cầu chủ dự án:
//
//        a) BIÊN NHẬN BACKUP (mặc định — lane tự chạy, KHÔNG cần người)
//           Lane tự chạy backup, đọc manifest của bản dump vừa tạo, kiểm nó đủ
//           tư cách làm đường lùi (không phải dump chỉ-schema, không bỏ dữ liệu
//           bảng nào, ≥450 bảng có dữ liệu), rồi tự phát biên nhận buộc
//           migration vào đúng bản dump đó.
//
//        b) IHOMECRM_PROMOTION_TOKEN (bắt buộc khi dùng --khong-backup)
//
//      VÌ SAO ĐỔI ĐƯỢC MÀ KHÔNG PHẢI LÀ NỚI TAY
//        Token cũ gộp hai thứ khác hẳn nhau: "có người dừng lại nhìn" và "có
//        điểm khôi phục nếu hỏng". Chỉ thứ hai mới quyết định THIỆT HẠI khi PITR
//        tắt — và con người gõ token chưa bao giờ tạo ra bản dump đó, nó chỉ tạo
//        cảm giác đã cân nhắc. Luật mới cưỡng chế đúng thứ đo được, và cưỡng chế
//        CHẶT HƠN: trước đây `--khong-backup` + token là qua; nay bỏ backup vẫn
//        cần token, còn đường tự động thì KHÔNG THỂ bỏ backup.
//
//        Thứ THẬT SỰ mất đi: không còn ai xem lại nội dung migration trước khi
//        nó chạm production. Bù lại bằng ba lớp còn nguyên (cutoff, provenance,
//        digest) — nhưng ba lớp đó kiểm XUẤT XỨ, không kiểm Ý ĐỊNH.

import { splitSqlStatements, normalizeSqlSource } from "./network-center-function-bodies.mjs";
import { HERMES_READ_STANDARD_FUNCTIONS } from "./hermes-read-function-specs.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMigrationTargetArgs, resolveMigrationTarget, migrationTargetArgs, migrationTargetPaths,
  assertMigrationArtifactTarget, withMigrationLease } from './lib/migration-target.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Digest sau khi CHUẨN HOÁ: bỏ comment, gộp khoảng trắng, thống nhất xuống dòng.
 *
 * Vì sao cần bên cạnh `sha256`: sha256 đổi khi file đổi bất kỳ byte nào — thêm
 * một dòng comment, hay đơn giản là CRLF↔LF khi ai đó mở file trên Windows.
 * Trên một lịch sử BẤT BIẾN, mọi thay đổi byte đều là báo động; mà báo động cho
 * việc đổi định dạng thì người ta sẽ học cách bỏ qua báo động.
 *
 * Chuẩn hoá KHÔNG thay thế sha256 — nó là phép đo thứ hai để phân biệt "định
 * dạng lại" với "đổi nội dung". Cả hai đều được ghi.
 *
 * Cố ý KHÔNG bỏ chuỗi nháy: `'-- không phải comment'` bên trong một chuỗi SQL là
 * dữ liệu thật. Regex bỏ comment ở đây sẽ cắt nhầm những chuỗi như vậy, nên nó
 * chỉ dùng để SO SÁNH hai bản của cùng một file, không dùng để phân tích SQL.
 */
export function chuanHoaSql(sql) {
  return sql
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function digestChuanHoa(sql) {
  return createHash("sha256").update(chuanHoaSql(sql)).digest("hex");
}

/** Blob OID của file — gắn với NỘI DUNG, không trôi theo commit khác trong repo. */
export function blobOid(duongDan) {
  const r = spawnSync("git", ["hash-object", duongDan], { cwd: repoRoot, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Bản dump phải có bao nhiêu bảng-có-dữ-liệu mới đủ tư cách làm đường lùi.
 *
 * Đo 07/08/2026: bản dump đầy đủ có 565 mục TABLE DATA. Sàn 450 để chừa chỗ cho
 * việc thêm/bớt bảng bình thường, nhưng vẫn bắt được một bản đứt giữa chừng —
 * ca đã xảy ra thật, và khi đó pg_dump VẪN thoát 0 và VẪN để lại file.
 */
export const SAN_BANG_CO_DU_LIEU = 450;

/**
 * Dọn phiên pg_dump bỏ rơi mà CHÍNH bước backup vừa để lại.
 *
 * SỰ CỐ ĐÃ TÁI DIỄN BA LẦN ngày 09-11/08/2026, mỗi lần tốn một vòng backup 4-7
 * phút: backup chạy xong, báo thành công, rồi bước apply ngay sau đó chết với
 *     55P03: canceling statement due to lock timeout
 * ở đúng những lệnh cần ACCESS EXCLUSIVE (CREATE/DROP POLICY, ALTER TABLE).
 *
 * Thủ phạm là chính bản backup vừa chạy. `pg_dump` mở một transaction
 * REPEATABLE READ và ôm AccessShareLock trên MỌI bảng; tiến trình pg_dump thoát
 * rồi, nhưng Supavisor (pooler) giữ phiên phía server ở trạng thái
 * `idle in transaction` — đo được là treo tới ~17 phút trước khi tự đóng.
 * Khoá ĐỌC đó xung khắc với ACCESS EXCLUSIVE, nên lane tự chặn chính mình.
 *
 * VỊ TỪ PHẢI CHẶT, vì đây là lệnh giết phiên trên production. Bốn vế, đúng
 * đồng thời:
 *   1. `idle in transaction` — phiên đang CHẠY thì state là 'active', nên vế
 *      này một mình đã loại mọi pg_dump còn làm việc thật.
 *   2. treo > 60 giây — dump vừa xong thì phiên mới, đợi một phút mới coi là bỏ
 *      rơi.
 *   3. truy vấn cuối mang dấu vết pg_dump (`EXECUTE dumpFunc%` hoặc `COPY %`).
 *   4. không phải phiên đang chạy chính câu lệnh này.
 * Thiếu một vế là có thể giết nhầm phiên của người khác.
 *
 * Không nổ khi dọn hụt: nếu vì lý do gì đó không terminate được, bước apply vẫn
 * chạy và vẫn báo lock timeout như cũ — tệ hơn thì bằng hiện trạng, không xấu đi.
 */
async function donPhienDumpBoRoi(pat, ref) {
  const sql = `
    SELECT pid, extract(epoch FROM now() - xact_start)::int AS treo_giay,
           pg_terminate_backend(pid) AS da_giet
      FROM pg_stat_activity
     WHERE state = 'idle in transaction'
       AND pid <> pg_backend_pid()
       AND xact_start < now() - interval '60 seconds'
       AND (query LIKE 'EXECUTE dumpFunc%' OR query LIKE 'COPY %')`;
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
    });
    if (!res.ok) return;
    const rows = JSON.parse(await res.text());
    if (Array.isArray(rows) && rows.length > 0) {
      console.log(
        `✔ Dọn ${rows.length} phiên pg_dump bỏ rơi mà bước backup vừa để lại `
        + `(treo ${rows.map((r) => r.treo_giay).join('/')}s) — chúng ôm khoá đọc và sẽ chặn apply.`,
      );
    }
  } catch {
    // Dọn hụt thì thôi; apply vẫn chạy và vẫn báo lock timeout như trước.
  }
}

/** Đọc manifest của bản backup vừa tạo từ stdout của backup-before-schema. */
export function docManifestBackup(stdout, docFile = readFileSync, coFile = existsSync, target = null) {
  const m = String(stdout).match(/^BACKUP_MANIFEST=(.+)$/m);
  if (!m) return { ok: false, vi: "không thấy dòng BACKUP_MANIFEST= trong output backup" };
  const p = m[1].trim();
  if (!coFile(p)) return { ok: false, vi: `manifest không tồn tại: ${p}` };
  let j;
  try {
    j = JSON.parse(docFile(p, "utf8"));
  } catch (e) {
    return { ok: false, vi: `manifest hỏng: ${e.message}` };
  }
  if (target) {
    try { assertMigrationArtifactTarget(j, target); }
    catch (error) { return { ok: false, vi: error.message }; }
  }
  if (j.kind === "schema" || /schema/i.test(String(j.kind))) {
    return { ok: false, vi: "bản dump CHỈ SCHEMA — không khôi phục được dữ liệu, không dùng làm đường lùi" };
  }
  if ((j.excludedTableData?.length ?? 0) > 0) {
    return { ok: false, vi: `bản dump THIẾU dữ liệu ${j.excludedTableData.length} bảng — không dùng làm đường lùi` };
  }
  if (!Number.isFinite(j.tablesWithData) || j.tablesWithData < SAN_BANG_CO_DU_LIEU) {
    return { ok: false, vi: `chỉ ${j.tablesWithData} bảng có dữ liệu (sàn ${SAN_BANG_CO_DU_LIEU}) — nghi bản dump cụt` };
  }
  if (!j.sha256) return { ok: false, vi: "manifest thiếu sha256" };
  return { ok: true, manifest: j };
}

/**
 * Chụp vân tay catalog production — dùng để ghi TRƯỚC/SAU mỗi lần apply.
 *
 * VÌ SAO EVIDENCE CẦN THÊM CÁI NÀY
 *   Trước đây file evidence trả lời được "đã apply file nào, ai cho phép, khôi
 *   phục từ đâu" — nhưng KHÔNG trả lời được "migration đó thật sự đổi gì trên
 *   database". Sáu tháng sau, đó mới là câu hỏi người ta hỏi khi truy một sự cố.
 *
 *   Hai vân tay khác nhau ⇒ có bằng chứng migration làm được việc.
 *   Hai vân tay GIỐNG nhau ⇒ migration không đổi gì ở tầng catalog. Với một
 *   migration schema thì đó là tín hiệu đáng nhìn: hoặc nó đã được apply từ
 *   trước (re-apply idempotent — bình thường), hoặc nó chỉ đổi DỮ LIỆU chứ không
 *   đổi cấu trúc, hoặc nó không làm gì cả. Không kết luận thay người đọc, nhưng
 *   phải NÓI RA.
 *
 * Chi phí đo được: 3,35 giây mỗi lần chụp.
 */
export function chupVanTayCatalog({ captureRoot = repoRoot, target = null } = {}) {
  // The collector only persists fresh data with --write. Reading the committed
  // inventory after its default print-only mode fabricated unchanged evidence.
  const r = spawnSync(process.execPath, [join(captureRoot, "scripts", "capture-production-catalog.mjs"), "--write",
    ...(target ? migrationTargetArgs(target) : [])], {
    cwd: captureRoot,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    timeout: 10 * 60 * 1000,
  });
  if (r.status !== 0) return { ok: false, vi: `capture thoát ${r.status}` };
  try {
    const inventory = target ? migrationTargetPaths(target, captureRoot).inventory
      : join(captureRoot, "docs", "generated", "database-inventory.json");
    const j = JSON.parse(readFileSync(inventory, "utf8"));
    if (target) assertMigrationArtifactTarget(j, target);
    return { ok: true, fingerprint: j.catalogFingerprint, counts: j.counts };
  } catch (e) {
    return { ok: false, vi: `không đọc được inventory: ${e.message}` };
  }
}

const LOCK_NAME = "ihomecrm:forward-migration:v1";
const LOCK_TIMEOUT = "5s";
const STATEMENT_TIMEOUT = "120s";

function projectRef() {
  try {
    return readFileSync(join(repoRoot, "supabase", ".temp", "project-ref"), "utf8").trim();
  } catch {
    return "tryymsxyyckgbrmmvozx";
  }
}

// Only consume leading lexical noise, never quote contents. Block comments may
// nest in PostgreSQL. This is also used between transaction-command tokens.
function boCommentDau(sql) {
  let cursor = 0;
  while (cursor < sql.length) {
    if (/\s/.test(sql[cursor])) { cursor++; continue; }
    if (sql.startsWith('--', cursor)) {
      const end = sql.indexOf('\n', cursor); cursor = end < 0 ? sql.length : end + 1; continue;
    }
    if (sql.startsWith('/*', cursor)) {
      let depth = 1; cursor += 2;
      while (cursor < sql.length && depth) {
        if (sql.startsWith('/*', cursor)) { depth++; cursor += 2; }
        else if (sql.startsWith('*/', cursor)) { depth--; cursor += 2; }
        else cursor++;
      }
      if (depth) throw new Error('Unclosed SQL block comment in transaction boundary.');
      continue;
    }
    break;
  }
  return sql.slice(cursor);
}

function viTriGoc(sql, offset) {
  let original = 0;
  for (let n = 0; n < offset; n++, original++) if (sql[original] === '\r' && sql[original + 1] === '\n') original++;
  return original;
}

// SQL-standard BEGIN ATOMIC is not dollar-quoted. Support the current bounded
// form: a SQL function with one SELECT/WITH statement, followed by its own END.
// The existing lexical splitter skips quoted/comment semicolons. Unsupported
// multi-statement/malformed bodies fail before a transaction terminator is cut.
function cheSqlStandard(sql) {
  const normalized = normalizeSqlSource(sql), parts = splitSqlStatements(normalized), ranges = [];
  let cursor = 0;
  const plain = boCommentDau;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index], start = normalized.indexOf(part, cursor); cursor = start + part.length;
    const body = plain(part), header = body.split(/\bAS\s+(?:\$|')/i)[0];
    if (!/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i.test(header) || !/\bBEGIN\s+ATOMIC\b/i.test(header)) continue;
    const match = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:[a-z_]\w*\.)?[a-z_]\w*\s*\([^()'"$;]*\)\s+RETURNS\s+(?:[a-z_]\w*\.)?[a-z_]\w*\s+LANGUAGE\s+sql\s+VOLATILE\s+SECURITY\s+INVOKER\s+SET\s+search_path\s*=\s*pg_catalog\s*,\s*public\s+BEGIN\s+ATOMIC\s+(?:SELECT|WITH)\b/i.exec(header);
    const next = parts[index + 1];
    // The reviewed STABLE read lane has a different search_path. Admit only
    // its exact statements; keep every other unsupported header/body closed.
    const reviewedRead = HERMES_READ_STANDARD_FUNCTIONS.some(spec =>
      createHash('sha256').update(body + ';\nEND').digest('hex') === spec.statementSha256);
    if ((!match && !reviewedRead) || !next || plain(next) !== 'END') throw new Error('Unsupported SQL-standard function boundary; expected one SELECT/WITH statement and END.');
    const endStart = normalized.indexOf(next, cursor);
    ranges.push({start: start + part.indexOf(body) + body.search(/\bBEGIN\s+ATOMIC\b/i), end: endStart + next.length});
    cursor = endStart + next.length; index++;
  }
  // splitSqlStatements normalizes CRLF; map offsets back without rewriting the
  // source bytes. Masking keeps every newline and all text outside these bodies.
  let result = sql;
  for (const range of ranges.reverse()) {
    const start = viTriGoc(sql, range.start), end = viTriGoc(sql, range.end);
    result = result.slice(0, start) + result.slice(start, end).replace(/[^\r\n]/g, ' ') + result.slice(end);
  }
  return result;
}

// Inspect complete outer statements, not lines. The existing lexical splitter
// honours quotes/comments; only the bounded SQL-standard body needs masking.
// Thus COMMIT; -- comment and inline COMMIT cannot escape either safety pass.
function transactionStatements(sql) {
  const masked = normalizeSqlSource(cheSqlStandard(sql)), found = [], statements = [];
  let cursor = 0, statementIndex = 0;
  for (const part of splitSqlStatements(masked)) {
    const start = masked.indexOf(part, cursor), end = start + part.length;
    cursor = end;
    const statement = boCommentDau(part);
    if (!statement) continue;
    statements.push(statement);
    const command = /^([a-z]+)\b/i.exec(statement)?.[1].toUpperCase();
    if (['BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'ABORT', 'PREPARE', 'SAVEPOINT', 'RELEASE'].includes(command)) {
      const rest = boCommentDau(statement.slice(command.length));
      // PREPARE name AS ... is unrelated to transactions. PREPARE TRANSACTION
      // would end this transaction and is deliberately unsupported.
      if (command !== 'PREPARE' || /^TRANSACTION\b/i.test(rest)) {
        const semicolon = end + /^\s*/.exec(masked.slice(end))[0].length;
        if (!['BEGIN', 'COMMIT', 'END', 'ROLLBACK'].includes(command) || rest || masked[semicolon] !== ';') {
          throw new Error('Unsupported transaction command: ' + command);
        }
        found.push({ start: viTriGoc(sql, start), end: viTriGoc(sql, semicolon + 1), text: command + ';', statementIndex });
      }
    }
    statementIndex++;
  }
  return { found, statements, statementCount: statementIndex };
}

function catRanges(sql, ranges) {
  let out = sql;
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + out.slice(r.end);
  }
  return out;
}

function laReloadSchema(sql) {
  let rest = sql;
  for (const token of [/^NOTIFY\b/i, /^pgrst\b/i, /^,/, /^'reload schema'/]) {
    rest = boCommentDau(rest);
    const match = token.exec(rest);
    if (!match) return false;
    rest = rest.slice(match[0].length);
  }
  return boCommentDau(rest) === '';
}

/**
 * Gỡ cặp BEGIN;/COMMIT; do chính file migration mở, TRƯỚC khi bọc lại.
 *
 * SỰ CỐ 07/08/2026: mọi migration của dự án đều tự mở `BEGIN; … COMMIT;` (nhà
 * đang bắt buộc đúng một cặp). Bọc thêm một lớp BEGIN…ROLLBACK ra ngoài KHÔNG
 * tạo transaction lồng — Postgres không có transaction lồng: lệnh BEGIN thứ hai
 * chỉ ném cảnh báo rồi bị bỏ qua, còn COMMIT bên trong đóng luôn transaction
 * NGOÀI. ROLLBACK cuối cùng rơi vào chỗ không còn transaction nào nên thành
 * no-op. Kết quả: "DRY-RUN (bọc ROLLBACK)" in ra màn hình trong khi dữ liệu đã
 * ghi thật lên production, đi vòng qua cả cửa promotion token lẫn cửa backup.
 */
function goTransactionCuaFile(sql) {
  const body = sql.trim();
  const { found, statements } = transactionStatements(body);
  const begins = found.filter(item => item.text === 'BEGIN;');
  if (begins.length > 1) {
    throw new Error(
      `Migration mở ${begins.length} lệnh BEGIN; ở mức câu lệnh — không gỡ an toàn được. Sửa file để chỉ có đúng một cặp BEGIN/COMMIT.`,
    );
  }

  const ketThuc = found.filter(item => item.text !== 'BEGIN;');
  if (ketThuc.length > 1) {
    throw new Error(
      `Migration có ${ketThuc.length} lệnh kết thúc transaction ở mức câu lệnh (${ketThuc
        .map((r) => r.text)
        .join(", ")}). Runner chỉ gỡ được đúng một COMMIT; cuối file — sửa file trước.`,
    );
  }

  // Existing forward files put this exact reload notification after COMMIT.
  // Keep it inside our wrapper: rollback suppresses it as well as the DDL/DML.
  const tail = ketThuc.length ? statements.slice(ketThuc[0].statementIndex + 1) : [];
  const reloadOnly = tail.length === 1 && laReloadSchema(tail[0]);
  if ((begins.length && begins[0].statementIndex !== 0) || (tail.length && !reloadOnly)) {
    throw new Error('BEGIN/kết thúc transaction phải ở đầu/cuối migration.');
  }

  return catRanges(body, [...begins, ...ketThuc]).trim();
}

/** Bọc migration trong một transaction có khoá và timeout rõ ràng. */
export function buildTransaction(sql, { rollback = false, lanChay = 1 } = {}) {
  const body = goTransactionCuaFile(sql);

  // `lanChay: 2` dán thân migration HAI LẦN trong CÙNG một transaction — dùng để
  // chứng minh tính idempotent (scripts/check-forward-migration-idempotent.mjs).
  // Chỉ cho phép kèm rollback: chạy hai lần rồi COMMIT là ghi đè thật hai lượt.
  if (lanChay !== 1 && !rollback) {
    throw new Error("lanChay > 1 chỉ dùng được với rollback: true — chạy lặp rồi COMMIT là ghi thật hai lượt.");
  }
  const than = Array.from({ length: lanChay }, () => body).join("\n\n");

  const out = [
    "BEGIN;",
    `SET LOCAL lock_timeout = '${LOCK_TIMEOUT}';`,
    `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}';`,
    `SELECT pg_advisory_xact_lock(hashtext('${LOCK_NAME}'));`,
    "",
    than,
    "",
    rollback ? "ROLLBACK;" : "COMMIT;",
  ].join("\n");

  // Chốt cuối: sau khi dựng xong, transaction phải đóng đúng MỘT lần và đóng
  // bằng đúng thứ đã hứa với người chạy. Sai ở đây nghĩa là dry-run lại ghi thật.
  const { found, statementCount } = transactionStatements(out);
  const dongLai = found.filter(item => item.text !== 'BEGIN;');
  const mo = found.filter(item => item.text === 'BEGIN;');
  const mongDoi = rollback ? "ROLLBACK;" : "COMMIT;";
  if (mo.length !== 1 || mo[0].statementIndex !== 0 || dongLai.length !== 1 ||
      dongLai[0].text !== mongDoi || dongLai[0].statementIndex !== statementCount - 1) {
    throw new Error(
      `Transaction dựng ra đóng bằng [${dongLai.map((r) => r.text).join(", ")}] thay vì đúng một ${mongDoi}. DỪNG.`,
    );
  }
  return out;
}

export async function chayTruyVanQuanTri({ pat, ref, query, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

/** Cửa bắt buộc trước apply: chạy hai lượt trong cùng transaction rồi rollback. */
export async function kiemTraHaiLuotTruocApply(sql, { pat, ref, fetchImpl = fetch, queryImpl = chayTruyVanQuanTri }) {
  const query = buildTransaction(sql, { rollback: true, lanChay: 2 });
  const result = await queryImpl({ pat, ref, query, fetchImpl });
  return { ...result, query };
}

export function kiemTraCoApplySom(argv, env = process.env) {
  if (!argv.includes("--apply")) return { ok: true };
  const boQuaBackup = argv.includes("--khong-backup");
  const tokenNguoi = env.IHOMECRM_PROMOTION_TOKEN;
  if (boQuaBackup && !tokenNguoi) return { ok: false, vi: "khong-token" };
  if (boQuaBackup) {
    const lyDo = argv[argv.indexOf("--khong-backup") + 1];
    if (!lyDo || lyDo.startsWith("--")) return { ok: false, vi: "thieu-ly-do" };
  }
  return { ok: true, boQuaBackup, tokenNguoi };
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

export async function main(argv, {
  root = repoRoot, resolveTarget = resolveMigrationTarget, lease = withMigrationLease,
  capture = chupVanTayCatalog, spawn = spawnSync, query = chayTruyVanQuanTri,
} = {}) {
  const targetOptions = parseMigrationTargetArgs(argv);
  const file = argv[2];
  const doApply = argv.includes("--apply");

  if (!file || file.startsWith("--")) {
    console.error("Dùng: node scripts/apply-reviewed-migration.mjs <file.sql> [--env prod|test] [--apply]");
    return 1;
  }
  const abs = join(root, file.replace(/^\.[\\/]/, ""));
  if (!existsSync(abs)) {
    console.error(`❌ Không thấy file: ${file}`);
    return 1;
  }

  // Resolve identity without credentials first. TEST-generated provenance can
  // authorize reviewed bytes without scanning production; the committed manifest
  // remains a source-only fallback for already-known files.
  const identity = await resolveTarget(targetOptions, { readProdRef: projectRef, needsPat: false });
  const identityPaths = migrationTargetPaths(identity, root);
  const hasTargetProvenance = existsSync(identityPaths.provenance);
  const provenancePath = hasTargetProvenance ? identityPaths.provenance : join(root, 'supabase', 'migration-provenance.json');
  const policy = JSON.parse(readFileSync(join(root, 'supabase', 'migration-policy.json'), "utf8"));
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  if (identity.environment === 'test' && hasTargetProvenance) assertMigrationArtifactTarget(provenance, identity);

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

  let giayPhep = null; // { loai, chiTiet } — ghi vào evidence

  const coApply = kiemTraCoApplySom(argv);
  if (!coApply.ok) {
    if (coApply.vi === "khong-token") {
      console.error(
        "\n❌ --khong-backup mà không có IHOMECRM_PROMOTION_TOKEN.\n" +
          "   Lane tự phát giấy phép DỰA TRÊN bản backup vừa tạo; bỏ backup thì không còn gì để dựa.\n" +
          "   Hai đường không dùng chung được: hoặc để lane chạy backup (tự động hoàn toàn),\n" +
          "   hoặc bỏ backup và tự chịu trách nhiệm bằng token của mình.",
      );
    } else {
      console.error("❌ --khong-backup phải kèm lý do: --khong-backup \"vì sao bỏ qua\".");
    }
    return 1;
  }
  const { boQuaBackup = false, tokenNguoi } = coApply;

  if (targetOptions.environment === 'test' && boQuaBackup) throw new Error('test_migration_backup_required');
  const target = await resolveTarget({ ...targetOptions, expectedProjectRef: identity.projectRef }, {
    readProdRef: projectRef, needsDatabase: targetOptions.environment === 'test',
  });
  const { pat, projectRef: ref } = target;
  const paths = migrationTargetPaths(target, root);
  console.log(`Đích   : ${target.environment} (${ref})`);
  return lease(target, async guard => {

  if (doApply) {
    console.log("→ Kiểm tra migration hai lượt trong transaction ROLLBACK trước khi backup/apply…");
    const preflight = await guard.execute(() => kiemTraHaiLuotTruocApply(sql, { pat, ref, queryImpl: query }));
    if (!preflight.ok) {
      console.error(`❌ Kiểm tra idempotency trước apply thất bại (HTTP ${preflight.status}) — chưa backup, chưa apply.`);
      console.error(preflight.body.slice(0, 1500));
      return 1;
    }
    console.log("✔ Hai lượt đều đạt và transaction đã ROLLBACK.");
  }

  if (doApply) {
    // ─── GIẤY PHÉP APPLY ─────────────────────────────────────────────────────
    //
    // ĐỔI LUẬT 07/08/2026 theo yêu cầu chủ dự án: lane này nay TỰ CHẠY ĐƯỢC,
    // không cần con người gõ token mỗi lần.
    //
    // Nhưng "tự động" không có nghĩa là "bỏ điều kiện". Token trước đây gộp HAI
    // thứ khác hẳn nhau vào một:
    //   (a) có người dừng lại nhìn — thứ này KHÔNG máy hoá được, và nay bỏ;
    //   (b) có điểm khôi phục nếu apply hỏng — thứ này máy KIỂM ĐƯỢC, và nay là
    //       điều kiện bắt buộc thay cho (a).
    //
    // Với PITR đang TẮT, (b) mới là thứ quyết định thiệt hại: không có bản dump
    // chụp ngay trước lúc apply thì đường lùi gần nhất là backup hằng ngày của
    // Supabase — tới ~24 giờ sổ sách tiền thật. Con người gõ token chưa bao giờ
    // tạo ra bản dump đó; nó chỉ tạo ra cảm giác đã cân nhắc.
    //
    // Nên luật mới:
    //   · Có backup TƯƠI, ĐÃ KIỂM TOÀN VẸN, tạo TRONG CHÍNH LẦN CHẠY NÀY
    //     ⇒ lane tự phát giấy phép, chạy không cần người.
    //   · KHÔNG có backup (dùng --khong-backup) ⇒ VẪN đòi token người.
    //     Đường tắt và đường tự động không được dùng chung.
    //   · Có token người ⇒ luôn chấp nhận, kể cả khi bỏ backup.
    //
    // Giấy phép tự phát là BIÊN NHẬN, không phải bí mật: nó là digest buộc bản
    // migration vào đúng bản backup vừa tạo. Giá trị của nó nằm ở chỗ KHÔNG thể
    // có nó mà không có bản dump tương ứng.
    if (tokenNguoi) {
      console.log(`⚠ Có promotion token của người — sẽ GHI THẬT lên ${target.environment}.`);
      giayPhep = { loai: "token-nguoi", chiTiet: createHash("sha256").update(tokenNguoi).digest("hex").slice(0, 16) };
    }

    // BACKUP LÀ CỬA CHẶN, KHÔNG PHẢI LỜI NHẮC.
    //
    // Chỗ này trước đây chỉ in ra câu hỏi "Đã chạy backup chưa?" rồi chạy tiếp
    // bất kể câu trả lời. Một lời nhắc mà người ta bấm Enter cho qua không phải
    // lớp bảo vệ — nhất là khi agent mới là thứ hay chạy lệnh này.
    //
    // Việc này quan trọng hơn hẳn kể từ 07/08/2026, khi PITR được chốt là KHÔNG
    // bật: bản dump chụp ngay trước lúc apply là ĐIỂM KHÔI PHỤC DUY NHẤT. Không
    // có nó, đường lùi gần nhất là backup tự động hằng ngày của Supabase — tức
    // mất tới ~24 giờ sổ sách.
    //
    // Cửa thoát hiểm `--khong-backup` vẫn còn cho tình huống khẩn (production
    // đang hỏng, cần vá ngay), nhưng bắt buộc kèm lý do và lý do đó được IN RA
    // — bỏ qua được, nhưng không im lặng.
    if (boQuaBackup) {
      const lyDo = argv[argv.indexOf("--khong-backup") + 1];
      console.warn(`⚠ BỎ QUA BACKUP theo yêu cầu — lý do: ${lyDo}`);
      console.warn("  Nếu apply hỏng, đường lùi gần nhất là backup hằng ngày của Supabase (tới ~24h dữ liệu).");
    } else {
      console.log("→ Chạy backup trước khi apply…");
      await guard.assertReady();
      // stdout PIPE để bắt dòng BACKUP_MANIFEST=, nhưng vẫn IN RA cho người xem —
      // backup chạy vài phút, một khoảng im lặng dài dễ bị hiểu là treo.
      const bk = spawn(
        process.execPath,
        [join(root, "scripts", "backup-before-schema.mjs"), "--reason", `apply ${basename(abs)}`, ...migrationTargetArgs(target)],
        { cwd: root, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], timeout: 45 * 60 * 1000 },
      );
      await guard.assertReady();
      if (bk.stdout) process.stdout.write(bk.stdout);
      if (bk.status !== 0) {
        console.error("\n❌ Backup THẤT BẠI — KHÔNG apply.");
        console.error("   Apply mà không có điểm khôi phục là đánh cược toàn bộ sổ sách.");
        console.error("   Sửa backup rồi chạy lại, hoặc dùng --khong-backup \"lý do\" nếu thật sự khẩn.");
        return 1;
      }

      // ─── TỰ PHÁT GIẤY PHÉP ─────────────────────────────────────────────────
      // Chỉ khi ĐỌC ĐƯỢC manifest của bản dump vừa tạo và bản đó đủ tư cách làm
      // đường lùi. Backup thoát 0 KHÔNG đủ để kết luận — repo này đã có án lệ:
      // một bản dump đứt giữa chừng vẫn để lại file, và bằng chứng "đã chạy
      // thành công 306 giây" từng đúng suốt nhiều tuần sau khi nó ngừng đúng.
      {
        // Target and dump integrity are mandatory even when a human token exists.
        const kq = docManifestBackup(bk.stdout ?? "", readFileSync, existsSync, target);
        if (!kq.ok) {
          console.error(`\n❌ KHÔNG tự phát được giấy phép apply: ${kq.vi}`);
          console.error("   Lane chỉ tự chạy khi có bản dump TƯƠI và ĐỦ TƯ CÁCH làm đường lùi.");
          console.error("   Sửa backup rồi chạy lại; promotion token không bỏ qua kiểm tra đích và tính toàn vẹn.");
          return 1;
        }
        // Biên nhận buộc migration vào ĐÚNG bản dump vừa tạo. Không thể có nó mà
        // không có bản dump tương ứng — đó là toàn bộ giá trị của nó.
        if (!giayPhep) giayPhep = {
          loai: "bien-nhan-backup",
          chiTiet: createHash("sha256").update(`${target.environment}:${ref}:${digest}:${kq.manifest.sha256}`).digest("hex").slice(0, 16),
          backupFile: kq.manifest.file,
          backupSha256: kq.manifest.sha256,
          backupCreatedAt: kq.manifest.createdAt,
          backupTablesWithData: kq.manifest.tablesWithData,
        };
        giayPhep.backupProjectRef = ref;
        giayPhep.backupEnvironment = target.environment;
        console.log(`✔ Backup vừa tạo đúng đích và đủ tư cách (${kq.manifest.tablesWithData} bảng có dữ liệu).`);
      }

      // Bản backup vừa chạy để lại phiên pg_dump ôm khoá đọc trên mọi bảng —
      // xem donPhienDumpBoRoi(). Không dọn thì apply tự chặn chính mình.
      // TEST does not terminate other sessions: its own lease remains held and
      // a lock timeout must be investigated, never treated as permission to kill.
      if (target.environment === 'prod') await donPhienDumpBoRoi(pat, ref);
    }

    if (!giayPhep) {
      console.error("\n❌ Không có giấy phép apply — không rõ vì sao. Dừng thay vì đoán.");
      return 1;
    }
    console.log(`Giấy phép: ${giayPhep.loai} · ${giayPhep.chiTiet}`);
  }

  // Chụp catalog TRƯỚC — chỉ khi apply thật. Dry-run không đổi gì nên chụp là
  // lãng phí 3,35 giây và tạo ra một bản inventory không tương ứng lần chạy nào.
  await guard.assertReady();
  const vanTayTruoc = doApply ? capture({ target, captureRoot: root }) : null;
  await guard.assertReady();
  if (doApply && !vanTayTruoc.ok) {
    console.error(`❌ Không chụp được catalog đúng đích TRƯỚC (${vanTayTruoc.vi}) — chưa apply.`);
    return 1;
  }

  const started = Date.now();
  const res = await guard.execute(() => query({ pat, ref, query: transaction }));
  const body = res.body;

  if (!res.ok) {
    console.error(`❌ ${doApply ? "Apply" : "Dry-run"} thất bại (HTTP ${res.status}).`);
    console.error(body.slice(0, 1500));
    return 1;
  }

  console.log(`✅ ${doApply ? "Đã apply" : "Dry-run xanh (đã ROLLBACK)"} sau ${Math.round((Date.now() - started) / 1000)}s`);

  if (doApply) {
    await guard.assertReady();
    const vanTaySau = capture({ target, captureRoot: root });
    await guard.assertReady();
    if (!vanTaySau.ok) console.warn(`⚠ Không chụp được catalog SAU (${vanTaySau.vi}).`);

    const doiCatalog =
      vanTayTruoc?.ok && vanTaySau.ok ? vanTayTruoc.fingerprint !== vanTaySau.fingerprint : null;
    if (doiCatalog === true) {
      console.log(`   catalog: ${vanTayTruoc.fingerprint.slice(0, 12)}… → ${vanTaySau.fingerprint.slice(0, 12)}… (ĐÃ ĐỔI)`);
    } else if (doiCatalog === false) {
      // KHÔNG kết luận thay người đọc — chỉ nói ra, vì có ba khả năng rất khác nhau.
      console.log(`   catalog: ${vanTaySau.fingerprint.slice(0, 12)}… (KHÔNG ĐỔI)`);
      console.log("   ⚠ Migration schema mà catalog không đổi. Ba khả năng: đã apply từ trước");
      console.log("     (re-apply idempotent — bình thường) · chỉ đổi DỮ LIỆU · hoặc không làm gì.");
    }

    // Ai chạy, và trên bản mã nguồn nào. Sáu tháng sau đây là hai câu hỏi đầu
    // tiên khi truy một thay đổi, và trước đây evidence không trả lời được.
    const actor =
      spawn("git", ["config", "user.email"], { cwd: root, encoding: "utf8" }).stdout?.trim() || "unknown";
    const repoCommit =
      spawn("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() || "unknown";

    mkdirSync(paths.evidence, { recursive: true });
    const evidence = {
      file: `supabase/migrations/${basename(abs)}`,
      sha256: digest,
      appliedAt: new Date().toISOString(),
      projectRef: ref,
      environment: target.environment,
      evidenceComplete: vanTaySau.ok,
      lockName: LOCK_NAME,
      statementTimeout: STATEMENT_TIMEOUT,
      // AI cho phép lần apply này, và DỰA TRÊN CÁI GÌ. Với `bien-nhan-backup`,
      // các trường backup* dưới đây chỉ thẳng tới bản dump là đường lùi của
      // chính lần apply này — sáu tháng nữa đó là thứ duy nhất trả lời được câu
      // "nếu hỏng thì khôi phục từ đâu".
      authorization: giayPhep,
      actor,
      repoCommit,
      // BẢN MÃ ĐÃ REVIEW, không phải bản mã lúc apply.
      //
      // `repoCommit` là HEAD lúc chạy — nó trôi theo mọi commit khác trong repo.
      // Blob OID thì gắn với ĐÚNG nội dung file này: nó không đổi khi repo có
      // commit khác, và nó đổi ngay khi file đổi một byte. Sáu tháng sau, câu
      // "bản nào đã được xem" chỉ trả lời được bằng con số này.
      reviewedBlob: blobOid(abs),
      // Số byte THẬT gửi đi, và digest sau khi chuẩn hoá.
      //
      // Hai con số này tách hai câu hỏi hay bị gộp: `sha256` đổi khi file đổi
      // BẤT KỲ byte nào — kể cả chỉ thêm một dòng comment hay đổi CRLF↔LF.
      // `normalizedDigest` chỉ đổi khi NỘI DUNG SQL đổi. Khi hai file có
      // normalizedDigest giống nhau mà sha256 khác nhau, đó là định dạng lại,
      // không phải thay đổi schema — và trên một lịch sử bất biến thì phân biệt
      // được hai thứ đó là khác nhau giữa "báo động" và "ghi chú".
      statementBytes: Buffer.byteLength(sql, "utf8"),
      normalizedDigest: digestChuanHoa(sql),
      // Bằng chứng migration THẬT SỰ đổi gì. `catalogChanged: false` không phải
      // lỗi — nó là dữ kiện, và nó chính là dấu hiệu của một lần re-apply.
      catalog: {
        before: vanTayTruoc?.ok ? vanTayTruoc.fingerprint : null,
        after: vanTaySau.ok ? vanTaySau.fingerprint : null,
        changed: doiCatalog,
        countsAfter: vanTaySau.ok ? vanTaySau.counts : null,
      },
      note: "Apply qua forward-only lane. Ledger supabase_migrations KHÔNG bị backfill — nguồn sự thật là manifest provenance + file evidence này.",
    };
    const out = join(paths.evidence, `${basename(abs, ".sql")}.json`);
    writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(`   evidence: ${out.replace(repoRoot, ".")}`);
    if (target.environment === 'prod') console.log("   Nhớ: chạy npm run provenance:generate để cập nhật state, và npm run catalog:capture.");
    else console.log('   Evidence TEST tách riêng; không chứng minh migration đã chạy trên production.');
    if (!vanTaySau.ok) return 1; // Applied, but incomplete evidence must not report a green lane.
  }
  return 0;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv)
    .then((c) => { process.exitCode = c; })
    .catch((e) => {
      console.error(`❌ ${e.message}`);
      process.exitCode = 1;
    });
}
