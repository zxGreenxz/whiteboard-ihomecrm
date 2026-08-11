#!/usr/bin/env node
// Gate: mỗi biên nhận trong docs/generated/schema-change-evidence/ phải trả lời
// đủ những câu người ta sẽ hỏi sáu tháng sau.
//
// VÌ SAO CẦN
//   Kho này là thứ DUY NHẤT trả lời "ai đổi schema production, lúc nào, bằng file
//   nào, ai cho phép". Ledger `supabase_migrations` đã tụt lại sau production, nên
//   không còn nguồn nào khác. Một biên nhận thiếu trường không báo lỗi lúc ghi —
//   nó chỉ im lặng, và cái im lặng đó chỉ lộ ra vào đúng lúc đang truy sự cố.
//
//   Đo 11/08/2026: hai biên nhận trong kho dùng HAI SCHEMA KHÁC NHAU, và một cái
//   ghi `promotionToken: false` + `backupTaken: false` — tức lần apply đó lên
//   production KHÔNG có giấy phép nào, trái Contract §11. Không gì phát hiện điều
//   đó cho tới khi có người đọc tay.
//
//   node scripts/check-evidence-store.mjs
//
// Thoát 0 · 1 khi biên nhận thiếu trường bắt buộc · 3 khi KHÔNG ĐỌC ĐƯỢC kho.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(repoRoot, 'docs', 'generated', 'schema-change-evidence');

/**
 * Trường bắt buộc, kèm LÝ DO — không có lý do thì trường sẽ bị bỏ khi ai đó thấy
 * phiền, và danh sách yêu cầu không giải thích được là danh sách sẽ bị cắt.
 */
export const BAT_BUOC = [
  ['file', 'file nào đã chạy — neo mọi câu hỏi còn lại'],
  ['sha256', 'đúng byte nào đã chạy, không phải "file tên đó"'],
  ['appliedAt', 'lúc nào — dựng lại dòng thời gian khi truy sự cố'],
  ['projectRef', 'lên project nào — chống nhầm môi trường'],
  ['actor', 'ai chạy — người hay agent, và ai chịu trách nhiệm'],
  ['repoCommit', 'trên bản mã nào, để đọc lại ngữ cảnh lúc đó'],
  ['reviewedBlob', 'nội dung nào đã được xem (không trôi theo commit khác)'],
  ['statementBytes', 'kích thước thật đã gửi'],
  ['normalizedDigest', 'phân biệt ĐỊNH DẠNG LẠI với ĐỔI NỘI DUNG'],
  ['catalog', 'schema có thật sự đổi không'],
];

/**
 * Biên nhận cũ hơn hợp đồng hiện tại.
 *
 * Ghi TỪNG FILE kèm lý do thay vì nới yêu cầu chung: một ngoại lệ có tên thì đọc
 * được và cãi được, còn một yêu cầu bị hạ thấp thì áp cho cả tương lai. Danh sách
 * này CHỈ ĐƯỢC TEO — thêm tên vào đây là sai cách dùng.
 */
export const MIEN_TRU = new Map([
  [
    '20260807140000_ie_guard_handover_scope.json',
    'Ghi 07/08/2026, trước khi hợp đồng biên nhận có reviewedBlob/statementBytes/normalizedDigest. Không thể bổ sung hồi tố mà vẫn trung thực: blob và byte phải chụp LÚC apply.',
  ],
  [
    '20260807163000_ie_types_org_boundary.json',
    'Cùng đợt, và còn thiếu cả `authorization` — biên nhận ghi promotionToken:false, backupTaken:false. Đây là bằng chứng của một lần apply KHÔNG giấy phép, không phải một biên nhận hợp lệ; giữ nguyên để không xoá dấu vết.',
  ],
]);

export function thieuTruong(bn) {
  return BAT_BUOC.filter(([k]) => bn[k] === undefined || bn[k] === null).map(([k, v]) => `${k} (${v})`);
}

function main() {
  if (!existsSync(DIR)) {
    console.log('✅ Chưa có biên nhận nào (chưa apply migration qua forward lane).');
    return;
  }

  let files;
  try {
    files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
  } catch (error) {
    console.error(`❌ KHÔNG ĐỌC ĐƯỢC kho bằng chứng: ${error.message}`);
    process.exit(3);
  }

  const loi = [];
  let daKiem = 0;

  for (const f of files) {
    let bn;
    try {
      bn = JSON.parse(readFileSync(join(DIR, f), 'utf8'));
    } catch (error) {
      loi.push(`${f}: không parse được (${error.message}).`);
      continue;
    }
    if (MIEN_TRU.has(f)) continue;
    daKiem++;
    const thieu = thieuTruong(bn);
    if (thieu.length > 0) {
      loi.push(`${f}: thiếu ${thieu.join(', ')}`);
    }
  }

  // Miễn trừ trỏ file không còn tồn tại ⇒ danh sách nói dối, và nó sẽ che một
  // biên nhận thật mới xuất hiện trùng tên.
  for (const f of MIEN_TRU.keys()) {
    if (!files.includes(f)) loi.push(`MIEN_TRU trỏ ${f} nhưng file đó không còn — gỡ khỏi danh sách.`);
  }

  if (loi.length > 0) {
    console.error(`❌ ${loi.length} vấn đề trong kho bằng chứng:\n`);
    for (const l of loi) console.error(`  - ${l}`);
    console.error('\n  Kho này là nguồn DUY NHẤT trả lời "ai đổi schema production, bằng file nào,');
    console.error('  ai cho phép" — ledger supabase_migrations đã tụt lại sau production.');
    process.exitCode = 1;
    return;
  }

  console.log(
    `✅ ${files.length} biên nhận: ${daKiem} khớp hợp đồng hiện tại, ${MIEN_TRU.size} miễn trừ có tên và có lý do.`,
  );

  // Chống-xanh-rỗng, nói thẳng thay vì để dấu ✅ tự nói.
  //
  // Hôm nay MỌI biên nhận đều nằm trong miễn trừ, nghĩa là gate này đang không
  // kiểm gì cả. Nó vẫn đáng có — nó cắn từ lần apply TIẾP THEO — nhưng để một
  // dòng ✅ trần đứng đây thì sáu tháng nữa ai đó sẽ đọc thành "kho bằng chứng
  // đã được kiểm và sạch".
  if (daKiem === 0 && files.length > 0) {
    console.warn('\n⚠ ĐANG KIỂM 0 BIÊN NHẬN: tất cả đều trong danh sách miễn trừ.');
    console.warn('  Gate này chỉ có hiệu lực từ lần apply migration tiếp theo.');
    console.warn('  Đừng đọc dấu ✅ ở trên thành "kho bằng chứng đã sạch".');
  }

  if (MIEN_TRU.size > 0) {
    for (const [f, ly] of MIEN_TRU) console.log(`   ⚠ ${f}: ${ly.slice(0, 100)}…`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
