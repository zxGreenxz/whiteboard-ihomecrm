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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOLER_HOST = "aws-1-ap-southeast-1.pooler.supabase.com";
const POOLER_PORT = 5432; // session mode — pg_dump KHÔNG chạy được ở transaction mode (6543)

/**
 * Bảng chỉ chứa dữ liệu PHÙ DU — bỏ phần DỮ LIỆU, vẫn giữ nguyên CẤU TRÚC.
 *
 * Lý do: bản dump này là đường lùi cho thao tác đổi schema, và thứ cần lùi là
 * SỔ SÁCH. Ba bảng dưới đây chiếm ~48 MB trong 197 MB dữ liệu public (đo
 * 07/08/2026) nhưng không có giá trị khôi phục: nonce dùng một lần rồi bỏ, lệnh
 * runtime đã thi hành xong, nhật ký chạy cron. Bỏ chúng cắt gần một phần tư
 * lượng phải kéo qua mạng — mà đường truyền chính là chỗ bản dump hay chết.
 *
 * `--exclude-table-data` (KHÔNG phải `--exclude-table`): cấu trúc bảng vẫn nằm
 * trong bản dump, nên restore vẫn dựng đủ schema, chỉ là bảng rỗng.
 *
 * MẶC ĐỊNH KHÔNG BỎ — phải tự bật bằng `--bo-phu-du`.
 *
 * Tôi thêm danh sách này với giả thuyết "ít dữ liệu hơn ⇒ dump nhanh hơn", rồi
 * đo và thấy nó SAI. Bốn lần chạy cùng ngày:
 *   đầy đủ, không keepalive : 306s ✅ · 344s ❌ (đứt)
 *   đầy đủ, có keepalive    : 332s ✅ 22.9 MB
 *   bỏ 48 MB, có keepalive  : 405s ✅ 20.9 MB   ← CHẬM HƠN
 * Chênh lệch nằm trong dao động đường truyền. Bằng chứng dứt điểm: dump CHỈ
 * SCHEMA — không một dòng dữ liệu — vẫn mất 175 giây. Nút thắt là độ trễ theo
 * từng object, không phải số byte.
 *
 * Nên đánh đổi này KHÔNG đáng mặc định: nó không mua được thời gian, mà bán đi
 * tính đầy đủ. Giữ lại làm tuỳ chọn cho lúc đường truyền thật sự tệ.
 *
 * Khi bật, phần bỏ đi được in ra mỗi lần chạy và ghi vào manifest — một bản dump
 * thiếu dữ liệu mà người khôi phục không biết còn tệ hơn không có bản dump.
 */
const BANG_PHU_DU = [
  "public.openclaw_service_nonces",   // 23 MB — nonce dùng một lần, tự sinh lại
  "public.openclaw_runtime_commands", // 18 MB — lệnh runtime đã thi hành
  "cron.job_run_details",             // 7.7 MB — nhật ký chạy cron
];

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

/**
 * Giữ tối đa bao nhiêu bản dump, xoá bản cũ hơn.
 *
 * Mỗi bản ~22 MB. Không dọn thì mỗi lần đổi schema đẻ thêm một bản và thư mục
 * phình vô hạn — đây là sổ sách tiền thật nằm không mã hoá trên ổ đĩa, càng ít
 * bản trôi nổi càng tốt.
 *
 * Giữ 5: đủ để lùi vài đợt thay đổi liên tiếp, mà không tích thành kho.
 * Bản manifest .json đi kèm bị xoá cùng bản dump của nó.
 */
const GIU_TOI_DA = 5;

export function chonBanCanXoa(tenFile, giuToiDa = GIU_TOI_DA) {
  // Sắp theo MỐC THỜI GIAN trong tên, KHÔNG sắp theo cả tên file.
  //
  // Bản đầu tôi viết `.sort()` trên nguyên tên với lý lẽ "tên chứa timestamp ISO
  // nên sort chuỗi = sort thời gian". Sai: tên còn chứa LOẠI (`full` / `schema`)
  // đứng TRƯỚC timestamp, và 's' > 'f'. Nên `ihomecrm-schema-2026-08-01` bị coi
  // là mới hơn `ihomecrm-full-2026-08-03`.
  //
  // Hậu quả nếu để nguyên: dọn nhầm bản FULL mới nhất và giữ lại bản SCHEMA cũ —
  // mà dump chỉ-schema KHÔNG khôi phục được dữ liệu. Tức cơ chế dọn dẹp tự tay
  // xoá đường lùi. Test "bản schema-only cũng nằm trong diện dọn" bắt được đúng
  // chỗ này.
  const mocTG = (f) => /^ihomecrm-(?:full|schema)-(.+)\.dump$/.exec(f)?.[1] ?? "";
  const dump = tenFile
    .filter((f) => /^ihomecrm-(full|schema)-.*\.dump$/.test(f))
    .sort((a, b) => mocTG(b).localeCompare(mocTG(a))); // mới → cũ
  return dump.slice(giuToiDa);
}

function donBanCu(outDir) {
  let tenFile;
  try {
    tenFile = readdirSync(outDir);
  } catch {
    return;
  }
  const canXoa = chonBanCanXoa(tenFile);
  if (canXoa.length === 0) return;
  let byte = 0;
  for (const f of canXoa) {
    const p = join(outDir, f);
    try {
      byte += statSync(p).size;
      rmSync(p, { force: true });
      rmSync(`${p}.json`, { force: true });
    } catch { /* bản đang bị khoá — bỏ qua, lần sau dọn tiếp */ }
  }
  console.log(`  đã dọn ${canXoa.length} bản dump cũ (giữ ${GIU_TOI_DA} bản mới nhất, giải phóng ${(byte / 1048576).toFixed(1)} MB)`);
}

function parseArgs(argv) {
  const args = { reason: null, out: null, schemaOnly: false, boPhuDu: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--reason") args.reason = argv[i + 1] ?? null;
    if (argv[i] === "--out") args.out = argv[i + 1] ?? null;
    if (argv[i] === "--schema-only") args.schemaOnly = true;
    if (argv[i] === "--bo-phu-du") args.boPhuDu = true;
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

  // TCP KEEPALIVE — thiếu cái này thì bản dump ĐỨT GIỮA CHỪNG.
  //
  // pg_dump kéo bảng lớn thì có những quãng dài không trao đổi gói nào; pooler
  // của Supabase coi kết nối im lặng là đã chết và đóng lại, cho ra đúng lỗi
  // "SSL connection has been closed unexpectedly".
  //
  // Đo 07/08/2026: bản chạy 06/08 mất 306 giây và VỪA ĐỦ thành công; bản chạy
  // 07/08 chết ở giây 344, đúng khi đang kéo public.invoice_audit_log (47 MB,
  // bảng lớn nhất database). Không phải sự cố ngẫu nhiên — nó vốn sát ngưỡng,
  // dữ liệu lớn thêm là vượt. Đường truyền VN → AWS Singapore, 277 MB dữ liệu
  // thật (bản dump nén còn 22 MB).
  //
  // keepalives_idle=30: cứ 30 giây gửi một gói giữ nhịp khi đường im lặng.
  const uri =
    `postgresql://${encodeURIComponent(user)}@${POOLER_HOST}:${POOLER_PORT}/postgres` +
    `?keepalives=1&keepalives_idle=30&keepalives_interval=10&keepalives_count=6`;

  const dumpArgs = [
    "-d", uri,
    "--format=custom",   // nén sẵn, pg_restore chọn được từng phần
    "--no-owner",
    "--no-acl",
    "-f", outFile,
  ];
  if (args.schemaOnly) dumpArgs.push("--schema-only");
  if (args.boPhuDu) {
    for (const t of BANG_PHU_DU) dumpArgs.push("--exclude-table-data", t);
  }

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

  // ĐỌC LẠI BẢN DUMP — pg_dump thoát 0 KHÔNG có nghĩa bản dump dùng được.
  //
  // Đây là phép kiểm quan trọng nhất trong file này. Hôm nay lỗi còn ồn ào
  // ("SSL connection has been closed unexpectedly", exit khác 0), nhưng một bản
  // dump cụt vì lý do khác — đĩa đầy giữa chừng, tiến trình bị kill — có thể để
  // lại file trông bình thường. Lúc đó anh có một file 20 MB nằm trong thư mục
  // backup, tin rằng mình có đường lùi, và chỉ phát hiện nó rỗng ruột đúng lúc
  // đang cần khôi phục. Đó là kiểu hỏng đắt nhất.
  //
  // `pg_restore --list` đọc mục lục bản dump. File cụt thì lệnh này lỗi; file
  // đủ thì đếm được số mục TABLE DATA.
  const pgRestore = pgDump.replace(/pg_dump(\.exe)?$/i, (m) => m.replace("dump", "restore"));
  const liet = spawnSync(pgRestore, ["--list", outFile], { encoding: "utf8" });
  if (liet.error || liet.status !== 0) {
    console.error("❌ Bản dump KHÔNG đọc lại được — file cụt hoặc hỏng. Đã xoá.");
    if (liet.stderr) console.error(String(liet.stderr).slice(0, 600));
    rmSync(outFile, { force: true });
    return 1;
  }
  const soBangCoDuLieu = (String(liet.stdout).match(/^\d+;.*TABLE DATA /gm) ?? []).length;

  // Sàn chống bản dump CỤT.
  //
  // Đo trên bản dump đầy đủ ngày 06/08: 565 mục TABLE DATA. (Con số này KHÁC
  // "số bảng có dữ liệu" trong catalog — pg_dump sinh một mục cho mỗi bảng nó
  // dump, kể cả bảng rỗng, và phủ nhiều schema hơn. Tôi đã đặt nhầm sàn 150
  // theo con số catalog trước khi đo bản dump thật.)
  // Bỏ 3 bảng phù du ⇒ còn ~562. Đặt 450 để còn chỗ gỡ bảng thật, nhưng vẫn bắt
  // ca dump chết giữa chừng — hôm nay nó chết khi mới qua vài chục bảng.
  const TOI_THIEU_BANG_DU_LIEU = 450;
  if (!args.schemaOnly && soBangCoDuLieu < TOI_THIEU_BANG_DU_LIEU) {
    console.error(`❌ Bản dump chỉ có ${soBangCoDuLieu} bảng dữ liệu (sàn ${TOI_THIEU_BANG_DU_LIEU}) — nghi CỤT. Đã xoá.`);
    console.error("   pg_dump thoát 0 không đủ để kết luận bản dump dùng được.");
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
    // Đã ĐỌC LẠI bản dump bằng `pg_restore --list`, không chỉ tin mã thoát của
    // pg_dump. Con số này là bằng chứng bản dump không cụt.
    tablesWithData: soBangCoDuLieu,
    // KHAI RÕ phần dữ liệu KHÔNG có trong bản dump. Người khôi phục phải đọc
    // được điều này TRƯỚC khi tin bản dump là đầy đủ.
    excludedTableData: args.boPhuDu ? BANG_PHU_DU : [],
    excludedWhy: !args.boPhuDu
      ? "Bản dump ĐẦY ĐỦ — không bỏ dữ liệu bảng nào."
      : "Dữ liệu phù du (nonce dùng một lần, lệnh runtime đã thi hành, nhật ký cron). CẤU TRÚC bảng vẫn có trong bản dump, chỉ thiếu DỮ LIỆU. Bỏ cờ --bo-phu-du để có bản đầy đủ.",
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
  donBanCu(outDir);
  console.log(`✅ Xong sau ${manifest.durationSeconds}s — ${mb} MB`);
  console.log(`   sha256: ${sha256.slice(0, 16)}…`);
  console.log(`   manifest: ${outFile}.json`);
  // Dòng MÁY ĐỌC ĐƯỢC, cố ý có tiền tố cố định. apply-reviewed-migration.mjs bắt
  // dòng này để neo giấy phép apply vào ĐÚNG bản backup vừa tạo — không phải một
  // bản nào đó nằm sẵn trong thư mục từ tuần trước.
  console.log(`BACKUP_MANIFEST=${outFile}.json`);
  if (args.schemaOnly) {
    console.log("⚠ Đây là dump CHỈ SCHEMA — không khôi phục được dữ liệu. Đừng coi là đường lùi.");
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
