#!/usr/bin/env node
// Kiểm kê bundle sau build, và chặn REGRESSION EAGER-IMPORT.
//
// VÌ SAO CẦN
//   99 trang được khai `lazy()` trong src/app/lazyPages.ts. Chỉ cần MỘT chỗ import
//   thẳng một trang (thay vì qua lazyPages) là trang đó bị gộp vào chunk entry:
//   người dùng tải thêm vài trăm KB ở lần mở đầu tiên cho một màn hình họ có thể
//   không bao giờ mở.
//
//   Không có gì hỏng. Build vẫn xanh, test vẫn xanh, giao diện vẫn đúng. Triệu
//   chứng duy nhất là thời gian tải đầu — thứ không ai đo trong CI, và thứ mà máy
//   dev có SSD với mạng nội bộ sẽ không bao giờ thấy.
//
// PHÉP KIỂM
//   Mỗi trang khai `lazy()` phải có CHUNK RIÊNG trong dist/assets. Trang biến mất
//   khỏi danh sách chunk = nó đã bị gộp vào chỗ khác.
//
//   Và chunk ENTRY không được phình quá ngưỡng. "Chunk entry" đọc từ
//   `dist/index.html` (`<script type="module" src=…>`), KHÔNG suy từ tên file —
//   xem chú thích ở `fileEntryTuHtml`.
//
//   node scripts/generate-bundle-inventory.mjs            # kiểm
//   node scripts/generate-bundle-inventory.mjs --write    # chốt lại baseline
//
// Cần `npm run build` chạy trước. Thoát 0 · 1 khi có trang mất chunk hoặc entry
// phình quá ngưỡng · 3 khi KHÔNG ĐO ĐƯỢC (chưa build, thư mục rỗng).

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boChuThichJs } from './lib/bo-chu-thich.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(repoRoot, 'dist', 'assets');
const INDEX_HTML = join(repoRoot, 'dist', 'index.html');
const LAZY = join(repoRoot, 'src', 'app', 'lazyPages.ts');
const BASELINE = join(repoRoot, 'tooling', 'bundle-baseline.json');

/**
 * Trang khai `lazy()`, trả `{ bien, chunk }`.
 *
 * `chunk` lấy từ TÊN FILE của module được import, KHÔNG phải tên biến export —
 * đó là cách Vite đặt tên. Bản đầu dùng tên biến và báo 2 trang "mất chunk":
 *   AdminUsersPage            → import("../pages/admin/UsersPage")            → UsersPage
 *   IncomeExpenseTypesNewPage → import("../pages/settings/IncomeExpenseTypesPage")
 * Cả hai có chunk riêng đầy đủ. Nếu tin ngay kết quả đó thì kết luận sẽ là "có
 * eager-import" và người ta đi tìm một lỗi không tồn tại — trong khi phép đo mới
 * là thứ hỏng.
 */
export function trangLazy(nguon) {
  const code = boChuThichJs(nguon);
  return [...code.matchAll(/export const ([A-Za-z0-9_]+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*["']([^"']+)["']/g)]
    .map((m) => ({ bien: m[1], chunk: m[2].split('/').pop() }))
    .sort((a, b) => a.bien.localeCompare(b.bien));
}

/** `{ ten, bytes }` cho mỗi chunk .js trong dist/assets. */
export function chunkTrongDist(files, kichThuoc) {
  return files
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ ten: f.replace(/-[A-Za-z0-9_-]{8,}\.js$/, ''), file: f, bytes: kichThuoc(f) }))
    .sort((a, b) => b.bytes - a.bytes);
}

/**
 * Chunk ENTRY = đúng những file mà `dist/index.html` nạp bằng
 * `<script type="module" src="/assets/…js">`. Trả tên FILE (kèm hash).
 *
 * VÌ SAO KHÔNG ĐOÁN THEO TÊN NỮA
 *   Bản đầu lấy `chunks.filter((c) => c.ten === 'index')` — cộng MỌI chunk tên
 *   `index-*.js`. Vite đặt tên chunk theo BASENAME của module, nên mọi thứ tên
 *   `index.*` đều rơi vào rổ đó. Ngày 03/09/2026 registry.ts thêm
 *   `import.meta.glob('/docs/huong-dan-su-dung/**\/index.md')`: 25 chunk raw
 *   `index-<hash>.js` (0,9–2 kB) ra đời, cộng thêm một trang lazy vốn đã tên
 *   `index-*` (221 kB) — phép đo nhảy lên 1598 kB và gate đỏ, trong khi entry
 *   THẬT vẫn 448 kB. Gate đỏ vì phép đo hỏng, không vì bundle hỏng: đúng loại
 *   báo động giả khiến người ta nới ngưỡng rồi mất luôn cái ratchet.
 *
 * `modulepreload` CỐ Ý KHÔNG TÍNH LÀ ENTRY
 *   Vite phát `<link rel="modulepreload">` cho các vendor chunk (react, query,
 *   supabase…). Chúng có tải ở lần mở đầu thật, nhưng chúng KHÔNG bao giờ nằm
 *   trong phép đo cũ (tên `vendor-*`, không phải `index`), nên tính thêm vào
 *   đây sẽ làm `bytesEntry` nhảy bậc và ngưỡng ratchet cũ mất nghĩa. Thứ gate
 *   này canh là "một trang lazy vừa bị import thẳng vào entry" — đó là chunk
 *   entry, không phải danh sách vendor. Kích thước vendor đã có `bytesTong` canh.
 */
export function fileEntryTuHtml(html) {
  const ra = [];
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const thuocTinh = m[1];
    if (!/\btype\s*=\s*["']module["']/i.test(thuocTinh)) continue;
    const src = thuocTinh.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!src) continue;
    // Bỏ query/hash rồi lấy basename: `/assets/index-AAA.js?v=1` → `index-AAA.js`.
    const file = src[1].split(/[?#]/)[0].split('/').pop();
    if (file.endsWith('.js')) ra.push(file);
  }
  return [...new Set(ra)];
}

/** Tổng bytes của đúng các chunk có tên file nằm trong `fileEntry`. */
export function bytesEntry(chunks, fileEntry) {
  const can = new Set(fileEntry);
  return chunks.filter((c) => can.has(c.file)).reduce((n, c) => n + c.bytes, 0);
}

/**
 * Trang lazy KHÔNG có chunk mang tên nó.
 *
 * So theo TIỀN TỐ tên: Vite đặt tên chunk theo tên module/biến rồi thêm hash.
 * Một số trang gộp vào chunk chung có tên khác — đó chính là thứ cần bắt.
 */
export function trangMatChunk(trang, chunks) {
  const co = new Set(chunks.map((c) => c.ten));
  return trang.filter((t) => !co.has(t.chunk)).map((t) => `${t.bien} (chunk ${t.chunk})`);
}

function main(argv) {
  if (!existsSync(DIST)) {
    console.error('❌ KHÔNG ĐO ĐƯỢC: chưa có dist/assets. Chạy `npm run build` trước.');
    console.error('   "Chưa build" KHÁC "bundle sạch".');
    process.exit(3);
  }

  const files = readdirSync(DIST);
  const chunks = chunkTrongDist(files, (f) => statSync(join(DIST, f)).size);
  if (chunks.length < 100) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ ${chunks.length} chunk .js (đo 11/08/2026: hơn 200).`);
    console.error('   Build cũ hoặc hỏng — kết luận bên dưới sẽ vô nghĩa.');
    process.exit(3);
  }

  const trang = trangLazy(readFileSync(LAZY, 'utf8'));
  if (trang.length < 50) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ bóc được ${trang.length} trang lazy (đo 11/08/2026: 99).`);
    process.exit(3);
  }

  if (!existsSync(INDEX_HTML)) {
    console.error('❌ KHÔNG ĐO ĐƯỢC: chưa có dist/index.html — không biết chunk nào là entry.');
    process.exit(3);
  }
  const fileEntry = fileEntryTuHtml(readFileSync(INDEX_HTML, 'utf8'));
  if (fileEntry.length === 0) {
    console.error('❌ KHÔNG ĐO ĐƯỢC: dist/index.html không có <script type="module" src=…js>.');
    console.error('   Build hỏng, hoặc Vite đổi cách phát entry — sửa phép đo trước khi kết luận.');
    process.exit(3);
  }
  const coTrongDist = new Set(chunks.map((c) => c.file));
  const thieu = fileEntry.filter((f) => !coTrongDist.has(f));
  if (thieu.length > 0) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: index.html trỏ chunk không có trong dist/assets: ${thieu.join(', ')}.`);
    console.error('   dist/ lẫn hai lần build — xoá dist/ rồi build lại.');
    process.exit(3);
  }

  const tongEntry = bytesEntry(chunks, fileEntry);
  const tong = chunks.reduce((n, c) => n + c.bytes, 0);

  const kiemKe = {
    $comment:
      'Sinh bởi scripts/generate-bundle-inventory.mjs sau `npm run build`. Ngưỡng là RATCHET: chỉ được giảm. Tăng ngưỡng là một quyết định, phải ghi lý do trong commit.',
    soChunk: chunks.length,
    soTrangLazy: trang.length,
    bytesEntry: tongEntry,
    bytesTong: tong,
    top10: chunks.slice(0, 10).map((c) => ({ ten: c.ten, bytes: c.bytes })),
  };

  if (argv.includes('--write')) {
    writeFileSync(
      BASELINE,
      JSON.stringify({ ...kiemKe, nguongEntryBytes: tongEntry, nguongTongBytes: tong }, null, 2) + '\n',
    );
    console.log(`Đã chốt baseline: entry ${(tongEntry / 1024).toFixed(0)} kB, tổng ${(tong / 1024 / 1024).toFixed(2)} MB.`);
    return;
  }

  const mat = trangMatChunk(trang, chunks);
  const van = [];

  if (mat.length > 0) {
    van.push(
      `${mat.length}/${trang.length} trang lazy KHÔNG có chunk riêng: ${mat.slice(0, 8).join(', ')}` +
      (mat.length > 8 ? ` … còn ${mat.length - 8}` : ''),
    );
  }

  let baseline = null;
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch {
    console.error('❌ KHÔNG ĐO ĐƯỢC: thiếu tooling/bundle-baseline.json — chạy --write một lần để chốt.');
    process.exit(3);
  }

  // Ngưỡng có biên 5%: build không tất định tuyệt đối (thứ tự module, hash), và
  // một gate đỏ vì 200 byte sẽ bị nới ngay lần đầu.
  const bien = 1.05;
  if (tongEntry > baseline.nguongEntryBytes * bien) {
    van.push(
      `chunk entry phình: ${(tongEntry / 1024).toFixed(0)} kB > ngưỡng ${(baseline.nguongEntryBytes / 1024).toFixed(0)} kB ` +
      '(+5% biên). Nhiều khả năng một trang lazy vừa bị import thẳng.',
    );
  }

  console.log(
    `Bundle: ${chunks.length} chunk · entry ${(tongEntry / 1024).toFixed(0)} kB · ` +
    `tổng ${(tong / 1024 / 1024).toFixed(2)} MB · ${trang.length} trang lazy`,
  );

  if (van.length > 0) {
    console.error('\n❌ Bundle có hồi quy:\n');
    for (const v of van) console.error(`  - ${v}`);
    console.error('\n  Eager-import không làm gì hỏng: build xanh, test xanh, giao diện đúng.');
    console.error('  Triệu chứng duy nhất là thời gian tải đầu — thứ không ai đo trong CI.');
    process.exitCode = 1;
    return;
  }

  console.log('✅ Mọi trang lazy đều có chunk riêng; entry không phình quá ngưỡng.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv);
