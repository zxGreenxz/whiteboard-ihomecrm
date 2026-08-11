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

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY = join(repoRoot, "supabase", "migration-policy.json");
const PROVENANCE = join(repoRoot, "supabase", "migration-provenance.json");
const EVIDENCE_DIR = join(repoRoot, "docs", "generated", "schema-change-evidence");

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

/** Đọc manifest của bản backup vừa tạo từ stdout của backup-before-schema. */
export function docManifestBackup(stdout, docFile = readFileSync, coFile = existsSync) {
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
function chupVanTayCatalog() {
  const r = spawnSync(process.execPath, [join(repoRoot, "scripts", "capture-production-catalog.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 10 * 60 * 1000,
  });
  if (r.status !== 0) return { ok: false, vi: `capture thoát ${r.status}` };
  try {
    const j = JSON.parse(readFileSync(join(repoRoot, "docs", "generated", "database-inventory.json"), "utf8"));
    return { ok: true, fingerprint: j.catalogFingerprint, counts: j.counts };
  } catch (e) {
    return { ok: false, vi: `không đọc được inventory: ${e.message}` };
  }
}

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

// Lệnh điều khiển transaction ở MỨC CÂU LỆNH: đứng một mình trên một dòng, có
// dấu chấm phẩy. `END;` là từ đồng nghĩa của COMMIT trong SQL nên phải tính,
// NHƯNG plpgsql cũng đóng khối bằng `END;` — vì thế mọi lần quét đều chạy trên
// bản đã che thân dollar-quote (xem cheDollarQuote).
const CAU_LENH_BEGIN = /^[ \t]*BEGIN[ \t]*;[ \t]*$/gm;
const CAU_LENH_KET_THUC = /^[ \t]*(COMMIT|ROLLBACK|END)[ \t]*;[ \t]*$/gm;

/**
 * Thay mọi ký tự trong thân `$tag$ … $tag$` bằng khoảng trắng, GIỮ NGUYÊN độ
 * dài và các dấu xuống dòng. Nhờ vậy vị trí ký tự trên bản che trùng khít bản
 * gốc, quét trên bản che rồi cắt trên bản gốc vẫn khớp.
 */
function cheDollarQuote(sql) {
  return sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, (khoi) =>
    khoi.replace(/[^\n]/g, " "),
  );
}

function timCauLenh(sqlDaChe, re) {
  const found = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(sqlDaChe)) !== null) {
    found.push({ start: m.index, end: m.index + m[0].length, text: m[0].trim() });
  }
  return found;
}

function catRanges(sql, ranges) {
  let out = sql;
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + out.slice(r.end);
  }
  return out;
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
  const che = cheDollarQuote(body);

  const begins = timCauLenh(che, CAU_LENH_BEGIN);
  if (begins.length > 1) {
    throw new Error(
      `Migration mở ${begins.length} lệnh BEGIN; ở mức câu lệnh — không gỡ an toàn được. Sửa file để chỉ có đúng một cặp BEGIN/COMMIT.`,
    );
  }

  const ketThuc = timCauLenh(che, CAU_LENH_KET_THUC);
  if (ketThuc.length > 1) {
    throw new Error(
      `Migration có ${ketThuc.length} lệnh kết thúc transaction ở mức câu lệnh (${ketThuc
        .map((r) => r.text)
        .join(", ")}). Runner chỉ gỡ được đúng một COMMIT; cuối file — sửa file trước.`,
    );
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
  const dongLai = timCauLenh(cheDollarQuote(out), CAU_LENH_KET_THUC);
  const mongDoi = rollback ? "ROLLBACK;" : "COMMIT;";
  if (dongLai.length !== 1 || dongLai[0].text !== mongDoi) {
    throw new Error(
      `Transaction dựng ra đóng bằng [${dongLai.map((r) => r.text).join(", ")}] thay vì đúng một ${mongDoi}. DỪNG.`,
    );
  }
  return out;
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

  let giayPhep = null; // { loai, chiTiet } — ghi vào evidence

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
    const tokenNguoi = process.env.IHOMECRM_PROMOTION_TOKEN;
    const boQuaBackup = argv.includes("--khong-backup");

    if (!tokenNguoi && boQuaBackup) {
      console.error(
        "\n❌ --khong-backup mà không có IHOMECRM_PROMOTION_TOKEN.\n" +
          "   Lane tự phát giấy phép DỰA TRÊN bản backup vừa tạo; bỏ backup thì không còn gì để dựa.\n" +
          "   Hai đường không dùng chung được: hoặc để lane chạy backup (tự động hoàn toàn),\n" +
          "   hoặc bỏ backup và tự chịu trách nhiệm bằng token của mình.",
      );
      return 1;
    }
    if (tokenNguoi) {
      console.log("⚠ Có promotion token của người — sẽ GHI THẬT lên production.");
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
      if (!lyDo || lyDo.startsWith("--")) {
        console.error("❌ --khong-backup phải kèm lý do: --khong-backup \"vì sao bỏ qua\".");
        return 1;
      }
      console.warn(`⚠ BỎ QUA BACKUP theo yêu cầu — lý do: ${lyDo}`);
      console.warn("  Nếu apply hỏng, đường lùi gần nhất là backup hằng ngày của Supabase (tới ~24h dữ liệu).");
    } else {
      console.log("→ Chạy backup trước khi apply…");
      // stdout PIPE để bắt dòng BACKUP_MANIFEST=, nhưng vẫn IN RA cho người xem —
      // backup chạy vài phút, một khoảng im lặng dài dễ bị hiểu là treo.
      const bk = spawnSync(
        process.execPath,
        [join(repoRoot, "scripts", "backup-before-schema.mjs"), "--reason", `apply ${basename(abs)}`],
        { cwd: repoRoot, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], timeout: 45 * 60 * 1000 },
      );
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
      if (!giayPhep) {
        const kq = docManifestBackup(bk.stdout ?? "");
        if (!kq.ok) {
          console.error(`\n❌ KHÔNG tự phát được giấy phép apply: ${kq.vi}`);
          console.error("   Lane chỉ tự chạy khi có bản dump TƯƠI và ĐỦ TƯ CÁCH làm đường lùi.");
          console.error("   Sửa backup rồi chạy lại, hoặc tự cấp IHOMECRM_PROMOTION_TOKEN.");
          return 1;
        }
        // Biên nhận buộc migration vào ĐÚNG bản dump vừa tạo. Không thể có nó mà
        // không có bản dump tương ứng — đó là toàn bộ giá trị của nó.
        giayPhep = {
          loai: "bien-nhan-backup",
          chiTiet: createHash("sha256").update(`${digest}:${kq.manifest.sha256}`).digest("hex").slice(0, 16),
          backupFile: kq.manifest.file,
          backupSha256: kq.manifest.sha256,
          backupCreatedAt: kq.manifest.createdAt,
          backupTablesWithData: kq.manifest.tablesWithData,
        };
        console.log(`✔ Giấy phép tự phát từ bản backup vừa tạo (${kq.manifest.tablesWithData} bảng có dữ liệu).`);
      }
    }

    if (!giayPhep) {
      console.error("\n❌ Không có giấy phép apply — không rõ vì sao. Dừng thay vì đoán.");
      return 1;
    }
    console.log(`Giấy phép: ${giayPhep.loai} · ${giayPhep.chiTiet}`);
  }

  const pat = readPat();
  if (!pat) {
    console.error("❌ Không tìm thấy PAT.");
    return 1;
  }
  const ref = projectRef();

  // Chụp catalog TRƯỚC — chỉ khi apply thật. Dry-run không đổi gì nên chụp là
  // lãng phí 3,35 giây và tạo ra một bản inventory không tương ứng lần chạy nào.
  const vanTayTruoc = doApply ? chupVanTayCatalog() : null;
  if (doApply && !vanTayTruoc.ok) {
    console.warn(`⚠ Không chụp được catalog TRƯỚC (${vanTayTruoc.vi}) — evidence sẽ thiếu vế so sánh.`);
  }

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
    const vanTaySau = chupVanTayCatalog();
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
      spawnSync("git", ["config", "user.email"], { cwd: repoRoot, encoding: "utf8" }).stdout?.trim() || "unknown";
    const repoCommit =
      spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout?.trim() || "unknown";

    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const evidence = {
      file: `supabase/migrations/${basename(abs)}`,
      sha256: digest,
      appliedAt: new Date().toISOString(),
      projectRef: ref,
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
