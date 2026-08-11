#!/usr/bin/env node
// Gate: AI Copilot chỉ đọc tài liệu được khai tường minh trong
// docs/he-thong/manifest.json.
//
// Vì sao cần gate thay vì chỉ có manifest: nếu manifest chỉ là danh sách "cho
// phép" mà không ai kiểm, thì một file .md mới thả vào docs/he-thong/ sẽ im
// lặng nằm ngoài manifest (Copilot không đọc — người viết tưởng đã đọc), hoặc
// tệ hơn, ai đó nới glob trở lại và mọi file lọt vào mà không ai thấy. Gate này
// bắt cả hai chiều.
//
//   node scripts/check-copilot-docs-manifest.mjs
//
// Không cần credential, không đọc database.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_DIR = join(repoRoot, 'docs', 'he-thong');
const MANIFEST_PATH = join(DOCS_DIR, 'manifest.json');
const REGISTRY_PATH = join(repoRoot, 'src', 'copilot', 'tools', 'registry.ts');

export function diffManifestAgainstDir(manifest, filesOnDisk) {
  const declared = new Set(manifest.entries.map((e) => e.file));
  const onDisk = new Set(filesOnDisk);
  return {
    undeclared: [...onDisk].filter((f) => !declared.has(f)).sort(),
    missing: [...declared].filter((f) => !onDisk.has(f)).sort(),
  };
}

export function findStaleEntries(manifest, today = new Date()) {
  const days = manifest.staleAfterDays;
  if (!days) return [];
  return manifest.entries
    .filter((e) => e.copilotIngest && e.reviewed)
    .map((e) => ({
      file: e.file,
      ageDays: Math.floor((today - new Date(e.reviewed)) / 86_400_000),
    }))
    .filter((e) => e.ageDays > days);
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  // ĐỆ QUY + không phân biệt hoa/thường + nhận cả .mdx. Bản đầu dùng readdirSync
  // phẳng và `endsWith('.md')`, nên một file tài liệu chưa khai chỉ cần nằm
  // trong thư mục con (docs/he-thong/noi-bo/), hoặc đặt tên `.MD`, hoặc dùng
  // `.mdx`, là hoàn toàn vô hình — trong khi đó đúng là thứ gate sinh ra để bắt.
  const filesOnDisk = [];
  for (const e of readdirSync(DOCS_DIR, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !/\.mdx?$/i.test(e.name)) continue;
    const con = relative(DOCS_DIR, e.parentPath ?? e.path).replace(/\\/g, '/');
    filesOnDisk.push(con ? `${con}/${e.name}` : e.name);
  }
  const problems = [];

  const { undeclared, missing } = diffManifestAgainstDir(manifest, filesOnDisk);
  for (const f of undeclared) {
    problems.push(
      `Chưa khai trong manifest: docs/he-thong/${f}\n` +
      '    → thêm entry với copilotIngest true/false. Mặc định KHÔNG được là "cho đọc".',
    );
  }
  for (const f of missing) {
    problems.push(`Manifest trỏ file không tồn tại: docs/he-thong/${f}`);
  }

  for (const e of manifest.entries) {
    if (typeof e.copilotIngest !== 'boolean') {
      problems.push(`Entry "${e.file}" thiếu copilotIngest (boolean).`);
    }
    if (e.copilotIngest === false && !e.why) {
      problems.push(`Entry "${e.file}" bị loại khỏi Copilot nhưng không ghi lý do ("why").`);
    }
    if (e.requiredPermission && (!e.requiredPermission.module || !e.requiredPermission.action)) {
      problems.push(`Entry "${e.file}" có requiredPermission thiếu module/action.`);
    }
  }

  // Registry phải THẬT SỰ lọc qua manifest, không được quay lại glob mù.
  //
  // Bản đầu chỉ `registry.includes('manifest.json')` — một phép so chuỗi con
  // trên TOÀN VĂN file, không phân biệt code với comment. Mà registry.ts vốn đã
  // có sẵn chữ "manifest.json" trong ba dòng comment giải thích, nên xoá SẠCH
  // code lọc manifest vẫn khiến gate xanh. Tức phép kiểm này không kiểm gì cả:
  // nó chỉ xác nhận rằng ai đó từng viết chữ đó ở đâu đó trong file.
  //
  // Nay đòi ba thứ, và cả ba phải cùng có: nạp manifest, đọc entries của nó, và
  // dùng entries đó để LỌC. Bỏ bất kỳ mảnh nào cũng đỏ.
  const registry = readFileSync(REGISTRY_PATH, 'utf8');
  const khongPhaiComment = registry
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  const doiHoi = [
    { re: /import\.meta\.glob\(\s*['"][^'"]*manifest\.json['"]/, mo: 'nạp docs/he-thong/manifest.json' },
    { re: /\.entries\b/, mo: 'đọc entries của manifest' },
    { re: /\.(filter|some|find|includes|has)\s*\(/, mo: 'dùng entries để LỌC danh sách tài liệu' },
  ];
  const thieu = doiHoi.filter((d) => !d.re.test(khongPhaiComment));
  if (thieu.length > 0) {
    problems.push(
      `src/copilot/tools/registry.ts không còn ${thieu.map((d) => d.mo).join(' / ')} ` +
      '(xét trên CODE, bỏ comment) — Copilot có thể đã quay lại đọc mù toàn thư mục.',
    );
  }

  if (problems.length > 0) {
    console.error('❌ Copilot docs manifest có vấn đề:\n');
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  const ingested = manifest.entries.filter((e) => e.copilotIngest);
  const gated = ingested.filter((e) => e.requiredPermission);
  const stale = findStaleEntries(manifest);

  console.log(
    `✅ Copilot docs manifest khớp thư mục: ${ingested.length}/${manifest.entries.length} file được đọc, ` +
    `${gated.length} file gác quyền.`,
  );
  // Cảnh báo, KHÔNG fail: nếu quá hạn review làm đỏ CI thì người ta sẽ bump ngày
  // theo nghi thức và phá luôn tín hiệu.
  if (stale.length > 0) {
    console.warn(`⚠ ${stale.length} tài liệu quá hạn review ${manifest.staleAfterDays} ngày:`);
    for (const s of stale) console.warn(`   - ${s.file} (${s.ageDays} ngày)`);
  }
  // ── Quyền sở hữu trường: manifest sở hữu, frontmatter không được lặp ──────
  //
  // Chốt 11/08/2026 sau khi đo: 1/29 tài liệu he-thong có YAML frontmatter, và nó
  // khai `reviewed: 2026-08-07` trong khi manifest — thứ gate này thật sự đọc —
  // KHÔNG có ngày nào cho file đó. Hai nguồn, đã lệch ngay khi mới có hai.
  //
  // Vì sao chọn manifest chứ không phải frontmatter: manifest là thứ máy đọc được
  // trong MỘT lần mở file, còn `reviewed` rải trong 29 file thì mọi phép đếm đều
  // phải quét cả thư mục và không ai kiểm được nó khớp gì. Frontmatter vẫn giữ
  // `status`, `source_paths`, `last_verified_commit`, `risk` — bốn thứ manifest
  // KHÔNG có, nên chúng không tạo nguồn thứ hai.
  const KHOA_CUA_MANIFEST = ['reviewed', 'copilot_ingest', 'copilotIngest'];
  const lapKhoa = [];
  for (const f of filesOnDisk) {
    let noiDung;
    try {
      noiDung = readFileSync(join(DOCS_DIR, f), 'utf8');
    } catch {
      continue;
    }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(noiDung);
    if (!m) continue;
    for (const k of KHOA_CUA_MANIFEST) {
      if (new RegExp(`^${k}:`, 'm').test(m[1])) {
        lapKhoa.push(
          `${f}: frontmatter khai \`${k}\` — khoá đó thuộc manifest.json.\n` +
          '      → dời giá trị vào manifest rồi gỡ khỏi frontmatter. Hai nguồn sẽ lệch.',
        );
      }
    }
  }
  if (lapKhoa.length > 0) {
    console.error(`\n❌ ${lapKhoa.length} chỗ lặp khoá giữa frontmatter và manifest:\n`);
    for (const l of lapKhoa) console.error(`  - ${l}`);
    process.exitCode = 1;
    return;
  }

  // ── Nợ review: chỉ được teo ────────────────────────────────────────────────
  //
  // 12/25 tài liệu Copilot đọc chưa từng ghi ngày review (đo 11/08/2026). Loại
  // hết ở runtime sẽ cắt hơn nửa kiến thức Copilot trong im lặng, nên chúng được
  // khai thành NỢ có tên. Phần cưỡng chế nằm ở hai chiều dưới đây — cùng khuôn
  // với mọi ratchet khác trong repo: so TẬP TÊN, không so số đếm. So số đếm cho
  // phép xoá một cái rồi thêm một cái khác trong cùng lát mà không ai thấy.
  const debt = manifest.unreviewedDebt;
  const unreviewed = ingested.filter((e) => !e.reviewed).map((e) => e.file);
  const loi = [];

  if (!debt || !Array.isArray(debt.files)) {
    loi.push('manifest thiếu `unreviewedDebt.files` — không có ratchet thì nợ review là vô hạn.');
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(debt.expiresAt ?? ''))) {
      loi.push('`unreviewedDebt.expiresAt` phải là ngày YYYY-MM-DD.');
    } else if (debt.expiresAt < homNay()) {
      loi.push(
        `nợ review HẾT HẠN ${debt.expiresAt} (hôm nay ${homNay()}) — review thật rồi ghi ngày, ` +
        'hoặc gia hạn có lý do. Xoá tên khỏi danh sách KHÔNG phải cách đóng.',
      );
    }
    const trongNo = new Set(debt.files);

    // Chiều 1: ingest mà không có `reviewed` và không nằm trong nợ ⇒ nợ mới.
    for (const f of unreviewed) {
      if (!trongNo.has(f)) {
        loi.push(
          `${f}: được Copilot đọc nhưng chưa từng ghi \`reviewed\`, và không nằm trong unreviewedDebt.\n` +
          '      → ghi ngày review thật. Đừng thêm vào danh sách nợ: nó chỉ để chốt hiện trạng, không để mở rộng.',
        );
      }
    }

    // Chiều 2: nằm trong nợ nhưng THỰC RA đã có `reviewed` ⇒ sổ nợ nói dối.
    // Không bỏ qua được: một danh sách nợ ghi thừa sẽ khiến người ta tưởng còn
    // việc phải làm ở chỗ đã xong, và tệ hơn, nó che một chỗ nợ thật mới xuất hiện.
    const conNo = new Set(unreviewed);
    for (const f of debt.files) {
      if (!conNo.has(f)) {
        loi.push(`${f}: nằm trong unreviewedDebt nhưng đã có \`reviewed\` (hoặc không còn được ingest) — gỡ khỏi danh sách.`);
      }
    }
  }

  // ── sourcePaths: thi hành KHI CÓ, và bắt buộc với mục thêm mới ─────────────
  //
  // Nói thẳng hiện trạng: KHÔNG entry nào khai `sourcePaths` (đo 11/08/2026), nên
  // điều kiện "source path còn tồn tại" của luật ingest chưa có dữ liệu để thi
  // hành. Bịa đường dẫn cho 29 tài liệu là đoán, và một manifest đoán còn tệ hơn
  // manifest trống. Phần làm được ngay: mọi đường dẫn ĐÃ khai phải tồn tại thật.
  for (const e of manifest.entries) {
    for (const p of e.sourcePaths ?? []) {
      if (!existsSync(join(repoRoot, p))) {
        loi.push(`${e.file}: sourcePaths trỏ \`${p}\` nhưng file đó không tồn tại.`);
      }
    }
  }

  if (loi.length > 0) {
    console.error(`\n❌ ${loi.length} vi phạm luật Copilot ingest:\n`);
    for (const l of loi) console.error(`  - ${l}`);
    process.exitCode = 1;
    return;
  }

  if (unreviewed.length > 0) {
    console.warn(
      `⚠ ${unreviewed.length} tài liệu Copilot đọc chưa từng ghi ngày review — đã khai nợ, ` +
      `hạn ${debt.expiresAt}.`,
    );
  }
}

const homNay = () => new Date().toISOString().slice(0, 10);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
