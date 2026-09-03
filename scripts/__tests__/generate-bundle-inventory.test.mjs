// Đột biến cho phép đo CHUNK ENTRY của generate-bundle-inventory.
//
// Án lệ 03/09/2026: gate lấy entry bằng `chunks.filter((c) => c.ten === 'index')`
// — cộng MỌI chunk tên `index-*.js`. Commit G1-D2 thêm
// `import.meta.glob('/docs/huong-dan-su-dung/**' + '/index.md')` trong registry.ts;
// Vite đặt tên chunk theo basename nên 25 file `index.md` sinh 25 chunk
// `index-<hash>.js`. Cộng thêm một trang lazy vốn cũng tên `index-*` (221 kB),
// phép đo nhảy 448 kB → 1598 kB và gate đỏ. KHÔNG có hồi quy nào cả: entry thật
// vẫn 448 kB. Gate đỏ vì phép đo hỏng là loại hỏng tệ nhất — cách chữa "tiện tay"
// là nới ngưỡng, và thế là mất luôn cái ratchet.
//
// Nên bài test này không kiểm "hàm chạy được"; nó dựng một dist GIẢ có đúng cái
// bẫy đó (ba chunk cùng tên `index-*`, chỉ một cái được index.html nạp) và đòi
// hàm trả về đúng một cái. Heuristic theo tên cũ sẽ cộng cả ba — được khẳng định
// tường minh bên dưới để nếu ai đó quay lại cách cũ thì test đỏ ngay.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { bytesEntry, chunkTrongDist, fileEntryTuHtml } from '../generate-bundle-inventory.mjs';

const BYTES_ENTRY = 4096;
const BYTES_MD = 900;
const BYTES_TRANG = 2048;

/** dist/ giả: index.html + assets/, trả `{ goc, assets }`. Nhớ dọn bằng `rmSync`. */
function dungDistGia() {
  const goc = mkdtempSync(join(tmpdir(), 'bundle-inventory-'));
  const assets = join(goc, 'assets');
  mkdirSync(assets);
  // Hash PHẢI dài ≥8 ký tự: `chunkTrongDist` bóc tên bằng regex
  // `-[A-Za-z0-9_-]{8,}\.js$`. Hash ngắn hơn thì `ten` giữ nguyên cả hash và
  // khẳng định "heuristic cũ cộng cả ba" bên dưới sẽ ra 0 — một fixture không
  // giống Vite thật thì đột biến không chứng minh được gì.
  // AAAAAAAA = entry thật. BBB = chunk raw của một file index.md (glob hướng dẫn).
  // CCC = một TRANG lazy mà Vite tình cờ cũng đặt tên `index` (án lệ 221 kB).
  writeFileSync(join(assets, 'index-AAAAAAAA.js'), 'a'.repeat(BYTES_ENTRY));
  writeFileSync(join(assets, 'index-BBBBBBBB.js'), 'b'.repeat(BYTES_MD));
  writeFileSync(join(assets, 'index-CCCCCCCC.js'), 'c'.repeat(BYTES_TRANG));
  writeFileSync(join(assets, 'vendor-react-DDDDDDDD.js'), 'd'.repeat(1024));
  writeFileSync(
    join(goc, 'index.html'),
    [
      '<!doctype html>',
      '<html><head>',
      // Script cổ điển (không type=module) — KHÔNG phải entry bundle.
      '<script src="/pt-boot.js"></script>',
      '<script type="module" crossorigin src="/assets/index-AAAAAAAA.js"></script>',
      // modulepreload cố ý KHÔNG tính là entry (xem chú thích trong script).
      '<link rel="modulepreload" crossorigin href="/assets/vendor-react-DDDDDDDD.js">',
      '<link rel="stylesheet" crossorigin href="/assets/index-EEEEEEEE.css">',
      '</head><body></body></html>',
    ].join('\n'),
  );
  return { goc, assets };
}

function docChunk(assets) {
  return chunkTrongDist(readdirSync(assets), (f) => statSync(join(assets, f)).size);
}

function docHtml(goc) {
  return readFileSync(join(goc, 'index.html'), 'utf8');
}

test('entry = ĐÚNG chunk index.html nạp, không phải mọi chunk tên index-*', () => {
  const { goc, assets } = dungDistGia();
  try {
    const chunks = docChunk(assets);
    const fileEntry = fileEntryTuHtml(docHtml(goc));

    assert.deepEqual(fileEntry, ['index-AAAAAAAA.js']);
    assert.equal(bytesEntry(chunks, fileEntry), BYTES_ENTRY);

    // ĐỘT BIẾN: heuristic cũ (theo tên chunk) cộng cả ba. Nếu ai đó quay về nó,
    // con số này sẽ trở thành giá trị mà `bytesEntry` trả — và test trên đỏ.
    const kieuCu = chunks.filter((c) => c.ten === 'index').reduce((n, c) => n + c.bytes, 0);
    assert.equal(kieuCu, BYTES_ENTRY + BYTES_MD + BYTES_TRANG);
    assert.notEqual(kieuCu, bytesEntry(chunks, fileEntry));
  } finally {
    rmSync(goc, { recursive: true, force: true });
  }
});

test('modulepreload và stylesheet KHÔNG bị tính vào entry', () => {
  const { goc, assets } = dungDistGia();
  try {
    const chunks = docChunk(assets);
    const fileEntry = fileEntryTuHtml(docHtml(goc));
    assert.ok(!fileEntry.includes('vendor-react-DDDDDDDD.js'));
    assert.ok(!fileEntry.some((f) => f.endsWith('.css')));
    // vendor vẫn nằm trong tổng bundle — chỉ không nằm trong entry.
    assert.ok(chunks.some((c) => c.file === 'vendor-react-DDDDDDDD.js'));
  } finally {
    rmSync(goc, { recursive: true, force: true });
  }
});

test('src đứng TRƯỚC type=module vẫn nhận ra', () => {
  // Thứ tự thuộc tính do bundler quyết; một regex đòi `type` trước `src` sẽ đo 0
  // byte entry và gate xanh giả mãi mãi.
  assert.deepEqual(
    fileEntryTuHtml('<script src="/assets/index-AAAAAAAA.js" type="module"></script>'),
    ['index-AAAAAAAA.js'],
  );
});

test('query string và base path lạ vẫn về đúng tên file', () => {
  assert.deepEqual(
    fileEntryTuHtml('<script type=\'module\' src="./sub/assets/index-AAAAAAAA.js?v=9"></script>'),
    ['index-AAAAAAAA.js'],
  );
});

test('script thường (không type=module) không phải entry', () => {
  assert.deepEqual(fileEntryTuHtml('<script src="/assets/index-AAAAAAAA.js"></script>'), []);
});

test('bytesEntry chỉ cộng chunk khớp TÊN FILE, bỏ qua tên trùng khác hash', () => {
  const chunks = [
    { ten: 'index', file: 'index-AAAAAAAA.js', bytes: 10 },
    { ten: 'index', file: 'index-BBBBBBBB.js', bytes: 20 },
  ];
  assert.equal(bytesEntry(chunks, ['index-AAAAAAAA.js']), 10);
  assert.equal(bytesEntry(chunks, ['index-KHONG-CO.js']), 0);
});
