#!/usr/bin/env node
// Gate: mọi query key mà descriptor realtime invalidate phải có QUERY THẬT dùng nó.
//
// VÌ SAO CẦN
//   `invalidateQueries({ queryKey: ["contract-terminations"] })` không báo lỗi khi
//   không query nào mang prefix đó — nó chỉ khớp 0 query rồi trả về. Nghĩa là một
//   descriptor có thể trông như đã phủ một màn hình trong khi màn đó KHÔNG BAO GIỜ
//   tự cập nhật.
//
//   Đo 11/08/2026: ba key `contract-terminations`, `contract-transfers`,
//   `room-residence-segments` chỉ tồn tại trong chính descriptor, không query nào
//   dùng. Trớ trêu: hai bảng đó được thêm vào hub CHÍNH VÌ "mọi thay đổi thanh lý /
//   chuyển phòng là im lặng hoàn toàn" — và việc sửa mới xong một nửa. Bảng đã vào
//   publication, đã vào hub, nhưng key invalidate lại trỏ vào hư không.
//
//   Đây là im lặng chồng im lặng: cái sai không làm gì đỏ, và cái sửa nó cũng vậy.
//
// KHÔNG ĐOÁN CÁCH VIẾT KEY
//   Query key được dựng bằng nhiều cách (literal, biến, hàm helper). Gate chỉ đòi
//   phần tử ĐẦU TIÊN của key xuất hiện đâu đó trong src/ như một chuỗi. Cố ý lỏng:
//   một gate hay báo sai sẽ bị tắt, và ở đây bỏ lọt vẫn còn `check-realtime-
//   descriptors` canh phía publication.
//
//   node scripts/check-realtime-query-keys.mjs
//
// Thoát 0 · 1 khi có key mồ côi · 3 khi KHÔNG ĐO ĐƯỢC.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boChuThichJs } from './lib/bo-chu-thich.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESCRIPTOR_DIR = 'src/hooks/realtime';

/**
 * Phần tử đầu của mỗi query key trong một file descriptor.
 *
 * BỎ COMMENT TRƯỚC KHI BÓC. Bản đầu không bỏ, và nó lập tức báo sai: chú thích
 * giải thích `thay cho ["contract-terminations"] chết` bị đọc thành một key đang
 * dùng. Cùng lớp lỗi đã ghi ở check-copilot-docs-manifest.mjs — so chuỗi trên
 * TOÀN VĂN file thì không phân biệt được code với văn kể lại về code, và ở đây
 * nó khiến gate đòi sửa đúng dòng vừa sửa xong.
 */
export function keyTrongDescriptor(nguon) {
  const code = boChuThichJs(nguon);
  const out = new Set();
  for (const k of code.matchAll(/keys:\s*\[([\s\S]*?)\n\s*\]/g)) {
    for (const m of k[1].matchAll(/\[\s*["'`]([^"'`]+)["'`]/g)) out.add(m[1]);
  }
  return out;
}

/** Chuỗi có xuất hiện ở file nào KHÁC thư mục descriptor không. */
export function noiDungKhac(key, files, doc) {
  const nhay = [`"${key}"`, `'${key}'`, `\`${key}\``];
  return files.filter((p) => {
    const s = doc(p);
    return nhay.some((n) => s.includes(n));
  });
}

function main() {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', 'src'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter((p) => /\.tsx?$/.test(p));
  } catch (error) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: ${error.message}`);
    process.exit(3);
  }

  const descriptorFiles = tracked.filter((p) => p.startsWith(`${DESCRIPTOR_DIR}/`) && !p.endsWith('index.ts') && !p.endsWith('types.ts'));
  if (descriptorFiles.length < 3) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ thấy ${descriptorFiles.length} file descriptor (đo 11/08/2026: 3).`);
    process.exit(3);
  }

  const cache = new Map();
  const doc = (p) => {
    if (!cache.has(p)) cache.set(p, readFileSync(join(repoRoot, p), 'utf8'));
    return cache.get(p);
  };

  const khai = new Map();
  for (const p of descriptorFiles) {
    for (const k of keyTrongDescriptor(doc(p))) {
      if (!khai.has(k)) khai.set(k, []);
      khai.get(k).push(p);
    }
  }
  if (khai.size < 20) {
    console.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ bóc được ${khai.size} key từ descriptor (đo 11/08/2026: 59).`);
    console.error('   Bộ bóc hỏng thì "không key nào mồ côi" là kết luận rỗng.');
    process.exit(3);
  }

  // Loại chính thư mục descriptor: key chỉ xuất hiện ở đó nghĩa là không ai dùng.
  const ngoai = tracked.filter((p) => !p.startsWith(`${DESCRIPTOR_DIR}/`) && !p.includes('__tests__'));

  const moCoi = [];
  for (const [k, nguon] of khai) {
    if (noiDungKhac(k, ngoai, doc).length === 0) moCoi.push({ key: k, nguon });
  }

  if (moCoi.length > 0) {
    console.error(`❌ ${moCoi.length} query key được invalidate nhưng KHÔNG query nào dùng:\n`);
    for (const m of moCoi) console.error(`  - ["${m.key}"]   khai ở ${m.nguon.join(', ')}`);
    console.error('\n  invalidateQueries với prefix không ai dùng khớp 0 query rồi trả về — không lỗi,');
    console.error('  không cảnh báo. Descriptor trông như đã phủ một màn hình mà màn đó không bao giờ');
    console.error('  tự cập nhật.');
    console.error('\n  → sửa key cho khớp queryKey THẬT của hook, hoặc bỏ nếu đã thừa.');
    process.exitCode = 1;
    return;
  }

  console.log(`✅ ${khai.size} query key trong descriptor realtime đều có query thật dùng.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
