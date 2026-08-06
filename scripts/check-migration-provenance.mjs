#!/usr/bin/env node
// Gate provenance migration. CHỈ ĐỌC file, KHÔNG gọi database — chạy được trong CI.
//
// Luật gate (theo supabase/migration-policy.json):
//   - File SAU cutoff: BẮT BUỘC có entry provenance, version 14 chữ số duy nhất.
//     Thiếu ⇒ FAIL. Đây là phần thực sự chặn.
//   - File TRƯỚC cutoff: bytes phải immutable so với manifest. Đổi ⇒ FAIL.
//   - Độ phủ của legacy (bao nhiêu unknown) chỉ là METRIC báo cáo, KHÔNG fail.
//
// Vì sao tách hai chế độ: nếu bắt toàn bộ 640 file phải hết unknown mới cho
// merge, thì mọi PR đụng migration sẽ đỏ vì nợ quá khứ, người ta sẽ bypass gate,
// và gate mất uy tín vĩnh viễn. Gate chỉ nên chặn thứ người mở PR sửa được.
//
//   node scripts/check-migration-provenance.mjs

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(repoRoot, "supabase", "migration-provenance.json");
const POLICY = join(repoRoot, "supabase", "migration-policy.json");
const MIGRATIONS_DIR = join(repoRoot, "supabase", "migrations");

/**
 * Liệt kê file .sql, ĐỆ QUY và KHÔNG phân biệt hoa/thường.
 *
 * Bản đầu dùng readdirSync phẳng + `endsWith(".sql")`, nên một file đặt trong
 * thư mục con hoặc đặt tên `.SQL` là vô hình với gate — cùng lớp lỗi
 * `relkind='i'` bỏ sót `'I'`. Trả về đường dẫn TƯƠNG ĐỐI so với `dir`, dùng `/`
 * để khớp định dạng path trong manifest trên mọi hệ điều hành.
 */
export function quetFileSql(dir) {
  const ra = [];
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !/\.sql$/i.test(e.name)) continue;
    const con = relative(dir, e.parentPath ?? e.path).replace(/\\/g, "/");
    ra.push(con ? `${con}/${e.name}` : e.name);
  }
  return ra.sort();
}

/**
 * Entry có trong manifest nhưng file đã biến mất (bị xoá hoặc đổi tên).
 *
 * `tonTai` được tiêm vào để test được mà không cần đụng đĩa thật.
 */
export function entryThieuFile(entries, tonTai) {
  return entries.filter((e) => !tonTai(e.path)).map((e) => e.path);
}

function main() {
  for (const f of [MANIFEST, POLICY]) {
    if (!existsSync(f)) {
      console.error(`❌ Thiếu ${f.replace(repoRoot, ".")}. Chạy: node scripts/generate-migration-provenance.mjs --write`);
      process.exitCode = 1;
      return;
    }
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const policy = JSON.parse(readFileSync(POLICY, "utf8"));
  const cutoff = policy.provisionalCutoff.version;

  const byPath = new Map(manifest.entries.map((e) => [e.path, e]));
  const problems = [];
  const onDisk = quetFileSql(MIGRATIONS_DIR);

  let afterCutoff = 0;
  let legacyChecked = 0;

  for (const file of onDisk) {
    const rel = `supabase/migrations/${file}`;
    const entry = byPath.get(rel);
    const version = /^(\d{14})_/.exec(file)?.[1] ?? null;
    const isAfterCutoff = version !== null && version > cutoff;

    if (isAfterCutoff) {
      afterCutoff += 1;
      if (!entry) {
        problems.push(
          `${file}: SAU cutoff nhưng chưa có entry provenance.\n` +
          `      → chạy: node scripts/generate-migration-provenance.mjs --write`,
        );
        continue;
      }
    }

    // File KHÔNG có entry = file MỚI, bất kể đặt tên thế nào.
    //
    // Manifest phủ toàn bộ 642 file đang có, nên nhánh "legacy chưa có entry"
    // mà bản đầu bỏ qua là nhánh CHẾT với mọi file hợp lệ — nhưng nó lại là cửa
    // duy nhất để một file mới đi qua: chỉ cần đặt tên KHÔNG phải 14 chữ số
    // (`018_x.sql`, `29990101_x.sql`) là `version` thành null, `isAfterCutoff`
    // thành false, rồi rơi thẳng vào `continue`. Tức lời hứa cốt lõi của gate —
    // mọi migration sau cutoff phải có provenance — bị vô hiệu chỉ bằng cách
    // ĐẶT TÊN KHÁC ĐI. Đo 07/08/2026: cả hai cách đặt tên trên đều đi qua.
    if (!entry) {
      problems.push(
        `${file}: có trên đĩa nhưng KHÔNG có entry provenance.\n` +
        `      Manifest phủ toàn bộ file đang tồn tại, nên đây là file MỚI.\n` +
        (version === null
          ? `      Tên không theo quy ước 14 chữ số — policy bắt forward-only phải là timestamp14 duy nhất.\n`
          : "") +
        `      → chạy: node scripts/generate-migration-provenance.mjs --write`,
      );
      continue;
    }

    // Immutability: file trước cutoff không được đổi bytes.
    const sha = createHash("sha256").update(readFileSync(join(MIGRATIONS_DIR, file), "utf8")).digest("hex");
    if (sha !== entry.sha256) {
      if (isAfterCutoff) {
        problems.push(`${file}: bytes đổi sau khi merge — migration là immutable, viết file MỚI thay vì sửa.`);
      } else {
        legacyChecked += 1;
        problems.push(
          `${file}: file LEGACY (trước cutoff ${cutoff}) đã bị SỬA.\n` +
          `      Lịch sử đã deploy là chỉ-đọc. Muốn đổi hành vi thì thêm file mới.`,
        );
      }
    } else if (!isAfterCutoff) {
      legacyChecked += 1;
    }
  }

  // Chiều NGƯỢC LẠI: manifest → đĩa.
  //
  // Bản đầu chỉ duyệt onDisk, nên một file BỊ XOÁ hoặc BỊ ĐỔI TÊN không để lại
  // dấu vết nào: entry vẫn nằm im trong manifest, vòng lặp kia không bao giờ
  // chạm tới nó, gate in dấu tick. Mà policy nói rõ file legacy là CHỈ ĐỌC —
  // "không sửa, không đổi tên, không di chuyển" — nên đổi tên đúng là điều gate
  // này phải chặn, và nó lại là điều duy nhất nó không thấy. Đo 07/08/2026:
  // chuyển một file ra khỏi thư mục ⇒ gate vẫn xanh.
  for (const p of entryThieuFile(manifest.entries, (rel) => existsSync(join(repoRoot, rel)))) {
    problems.push(
      `${p}: có trong manifest nhưng KHÔNG còn trên đĩa (bị xoá hoặc đổi tên).\n` +
      `      Lịch sử đã deploy là chỉ-đọc: không sửa, không đổi tên, không di chuyển.\n` +
      `      Muốn đổi hành vi thì thêm file MỚI.`,
    );
  }

  // Version 14 chữ số phải duy nhất SAU cutoff (trước cutoff đã trùng sẵn 39 nhóm).
  const seen = new Map();
  for (const file of onDisk) {
    const v = /^(\d{14})_/.exec(file)?.[1];
    if (!v || v <= cutoff) continue;
    if (seen.has(v)) problems.push(`Version ${v} bị dùng cho hai file sau cutoff: ${seen.get(v)} và ${file}`);
    seen.set(v, file);
  }

  if (problems.length > 0) {
    console.error("❌ Provenance migration có vấn đề:\n");
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  const c = manifest.counts ?? {};
  console.log(
    `✅ Provenance OK — cutoff ${cutoff}: ${afterCutoff} file sau cutoff đều có entry, ` +
    `${legacyChecked} file legacy giữ nguyên bytes.`,
  );
  // Metric, không phải điều kiện fail.
  console.log(
    `   Độ phủ ${manifest.entries.length} file: ` +
    Object.entries(c).map(([k, v]) => `${k} ${v}`).join(" · "),
  );
  if (c.unknown) {
    console.log(`   ⚠ ${c.unknown} file chưa có bằng chứng máy — nợ tồn đọng, xử theo batch (xem migration-policy.json).`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
