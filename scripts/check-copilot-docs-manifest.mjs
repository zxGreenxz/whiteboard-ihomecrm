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
const SRC_DIR = join(repoRoot, 'src');

/** File DUY NHẤT được phép nạp corpus hướng dẫn người dùng. */
export const FILE_NAP_HUONG_DAN = 'src/copilot/tools/registry.ts';

/**
 * Bỏ comment để gate đọc MÃ, không đọc văn kể lại về mã.
 *
 * Án lệ chung của repo, và chính file này đã dính một lần: bản đầu chỉ
 * `registry.includes('manifest.json')`, mà registry.ts vốn có sẵn chữ đó trong
 * ba dòng chú thích — xoá SẠCH code lọc manifest vẫn khiến gate xanh.
 */
export function boComment(nguon) {
  return String(nguon)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * CORPUS HƯỚNG DẪN NGƯỜI DÙNG chỉ được nạp từ MỘT chỗ.
 *
 * VÌ SAO LUẬT NÀY TỒN TẠI (03/09/2026)
 *   `docs/huong-dan-su-dung/**` vào index BM25 với allowlist suy từ
 *   `CAPABILITIES` — và allowlist đó nằm CẠNH glob, trong registry.ts, cố ý.
 *   Thêm một `import.meta.glob('/docs/huong-dan-su-dung/…')` ở file khác là mở
 *   một đường nạp thứ hai KHÔNG đi qua allowlist: mọi trang trong thư mục, kể
 *   cả trang của capability `internal` hay 16 trang onboarding không capability
 *   nào nhận, lập tức thành nguồn tư vấn cho người dùng thật.
 *
 *   Đây đúng là luật đã có sẵn cho `docs/he-thong` (nạp + lọc manifest phải
 *   chung một chỗ). Corpus thứ hai ra đời mà không có nửa cưỡng chế nào — gate
 *   này biết mọi thứ về `he-thong` và KHÔNG BIẾT GÌ về thư mục kia.
 *
 * Nhận `{ [đường dẫn]: nguồn }`; trả danh sách file vi phạm.
 */
export function timGlobHuongDanNgoaiAllowlist(nguonTheoFile, choPhep = FILE_NAP_HUONG_DAN) {
  const re = /import\.meta\.glob\(\s*['"`][^'"`]*huong-dan-su-dung[^'"`]*['"`]/;
  return Object.entries(nguonTheoFile ?? {})
    .filter(([file]) => file.replace(/\\/g, '/') !== choPhep)
    .filter(([, nguon]) => re.test(boComment(nguon)))
    .map(([file]) => file.replace(/\\/g, '/'))
    .sort();
}

/**
 * Thân của `trangHuongDanChoPhep` — hàm dựng allowlist hướng dẫn.
 *
 * Cắt tới `export function`/`export async function` KẾ TIẾP ở đầu dòng, để một
 * phép kiểm ở hàm khác trong cùng file không vô tình "chứng minh" hàm này đúng.
 */
export function thanHamAllowlist(registrySource) {
  const sach = boComment(registrySource);
  const dau = sach.search(/export function trangHuongDanChoPhep\s*\(/);
  if (dau < 0) return '';
  const con = sach.slice(dau + 1);
  const sau = con.search(/^export (?:async )?function /m);
  return sau < 0 ? sach.slice(dau) : sach.slice(dau, dau + 1 + sau);
}

/**
 * Allowlist hướng dẫn phải THẬT SỰ suy từ `CAPABILITIES`, và lọc đủ hai vế.
 *
 * Ba mảnh, cả ba phải cùng có — bỏ mảnh nào cũng đỏ:
 *   - đọc `CAPABILITIES` (nguồn allowlist, không phải một danh sách viết tay);
 *   - lọc theo `visibility` = `public` (bề mặt quản trị không hứa gì với người
 *     dùng cuối, và một trang hướng dẫn cho bề mặt họ không mở được là lời hứa
 *     hụt);
 *   - gắn `permission` của capability làm quyền gác trang.
 *
 * Mảnh thứ ba là mảnh đắt nhất: bỏ nó thì trang hướng dẫn Bảng lương vào index
 * cho MỌI người, và triệu chứng là Copilot mô tả từng cột bảng lương cho một
 * nhân viên phòng — không lỗi nào nổ ra.
 */
export function thieuLocNangLuc(registrySource) {
  const than = thanHamAllowlist(registrySource);
  if (!than) return ['không tìm thấy `export function trangHuongDanChoPhep(` trong registry.ts'];
  const thieu = [];
  if (!/\bCAPABILITIES\b/.test(than)) thieu.push('không đọc `CAPABILITIES`');
  if (!/\buserDoc\b/.test(than)) thieu.push('không đọc `docs.userDoc`');
  if (!/visibility\s*!==\s*['"]public['"]|visibility\s*===\s*['"]public['"]/.test(than)) {
    thieu.push('không lọc theo `docs.visibility === "public"`');
  }
  if (!/permission\.module/.test(than) || !/permission\.action/.test(than)) {
    thieu.push('không gắn `permission` của capability làm quyền gác trang');
  }
  return thieu;
}

/** Mọi file .ts/.tsx dưới `src/`, đệ quy. */
function lietKeNguon(thuMuc) {
  const ra = [];
  const di = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const duong = join(d, e.name);
      if (e.isDirectory()) di(duong);
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) ra.push(duong);
    }
  };
  di(thuMuc);
  return ra;
}

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

  // ── Corpus THỨ HAI: docs/huong-dan-su-dung ────────────────────────────────
  //
  // Cùng một bất biến, cho một thư mục khác: đường nạp và phép lọc allowlist
  // phải nằm chung một chỗ. Trước 03/09/2026 gate này biết mọi thứ về
  // `he-thong` và không biết gì về thư mục kia — tức nửa corpus không được canh.
  const nguonSrc = {};
  for (const duong of lietKeNguon(SRC_DIR)) {
    nguonSrc[relative(repoRoot, duong).replace(/\\/g, '/')] = readFileSync(duong, 'utf8');
  }
  if (Object.keys(nguonSrc).length < 100) {
    problems.push(
      `KHÔNG ĐO ĐƯỢC: chỉ đọc được ${Object.keys(nguonSrc).length} file trong src/ — ` +
      'bộ quét hỏng, đừng đọc thành "không ai nạp glob nào".',
    );
  }
  for (const file of timGlobHuongDanNgoaiAllowlist(nguonSrc)) {
    problems.push(
      `${file}: nạp \`docs/huong-dan-su-dung\` bằng import.meta.glob.\n` +
      `    → chỉ ${FILE_NAP_HUONG_DAN} được nạp corpus này, vì allowlist ` +
      '(CAPABILITIES) nằm ngay cạnh glob ở đó. Đường nạp thứ hai là đường đi vòng qua allowlist.',
    );
  }
  const thieuNangLuc = thieuLocNangLuc(registry);
  if (thieuNangLuc.length > 0) {
    problems.push(
      `trangHuongDanChoPhep() trong registry.ts: ${thieuNangLuc.join('; ')} ` +
      '(xét trên CODE, bỏ comment).',
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
