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

import { docKeyTuHub, keyTuKetQuaNap } from './check-realtime-key-ownership.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESCRIPTOR_DIR = 'src/hooks/realtime';

// Đọc đúng SYNC_ENTRIES mà hub dùng: helper, spread và key thêm ở index.ts đều
// phải được kiểm. Regex chỉ thấy keys: [[...]] sẽ bỏ sót các cách khai báo đó.
export const SAN_SO_KEY = 20;

/** Chuỗi có xuất hiện ở file nào KHÁC thư mục descriptor không. */
export function noiDungKhac(key, files, doc) {
  const nhay = [`"${key}"`, `'${key}'`, `\`${key}\``];
  return files.filter((p) => {
    const s = doc(p);
    return nhay.some((n) => s.includes(n));
  });
}

export function main({
  listTracked = () => execFileSync('git', ['ls-files', 'src'], { cwd: repoRoot, encoding: 'utf8' }),
  loadDescriptors = docKeyTuHub,
  readSource = (path) => readFileSync(join(repoRoot, path), 'utf8'),
  logger = console,
} = {}) {
  let tracked;
  try {
    tracked = listTracked()
      .split('\n')
      .filter((p) => /\.tsx?$/.test(p));
  } catch (error) {
    logger.error(`❌ KHÔNG ĐO ĐƯỢC: ${error.message}`);
    return 3;
  }

  const descriptorFiles = tracked.filter((p) => p.startsWith(`${DESCRIPTOR_DIR}/`) && !p.endsWith('index.ts') && !p.endsWith('types.ts'));
  if (descriptorFiles.length < 3) {
    logger.error(`❌ KHÔNG ĐO ĐƯỢC: chỉ thấy ${descriptorFiles.length} file descriptor (đo 11/08/2026: 3).`);
    return 3;
  }

  const cache = new Map();
  const doc = (p) => {
    if (!cache.has(p)) cache.set(p, readSource(p));
    return cache.get(p);
  };

  let khai;
  try {
    khai = keyTuKetQuaNap(loadDescriptors(), SAN_SO_KEY);
  } catch (error) {
    logger.error(`❌ KHÔNG ĐO ĐƯỢC: không nạp được descriptor qua vite-node — ${error.message}`);
    return 3;
  }

  // Loại chính thư mục descriptor: key chỉ xuất hiện ở đó nghĩa là không ai dùng.
  const ngoai = tracked.filter((p) => !p.startsWith(`${DESCRIPTOR_DIR}/`) && !p.includes('__tests__'));

  const moCoi = [];
  try {
    for (const k of khai) {
      if (noiDungKhac(k, ngoai, doc).length === 0) moCoi.push(k);
    }
  } catch (error) {
    logger.error(`❌ KHÔNG ĐO ĐƯỢC: không đọc được nguồn dùng query key — ${error.message}`);
    return 3;
  }

  if (moCoi.length > 0) {
    logger.error(`❌ ${moCoi.length} query key được invalidate nhưng KHÔNG query nào dùng:\n`);
    for (const key of moCoi) logger.error(`  - ["${key}"]   khai ở ${DESCRIPTOR_DIR} (SYNC_ENTRIES runtime)`);
    logger.error('\n  invalidateQueries với prefix không ai dùng khớp 0 query rồi trả về — không lỗi,');
    logger.error('  không cảnh báo. Descriptor trông như đã phủ một màn hình mà màn đó không bao giờ');
    logger.error('  tự cập nhật.');
    logger.error('\n  → sửa key cho khớp queryKey THẬT của hook, hoặc bỏ nếu đã thừa.');
    return 1;
  }

  logger.log(`✅ ${khai.length} query key trong descriptor realtime đều có query thật dùng.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
