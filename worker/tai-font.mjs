#!/usr/bin/env node
// =============================================================================
// tai-font.mjs — tải bộ font "Be Vietnam Pro" về worker/fonts/.
//
// VÌ SAO CẦN: ảnh bảng phòng trống do worker vẽ dùng đúng font mà bản web dùng.
// Máy Windows của dev có sẵn font tiếng Việt nên ảnh trông đúng ngay; VPS Linux
// trần thì KHÔNG — mọi chữ có dấu ra ô vuông, và ảnh đó vẫn được gửi đi bình
// thường vì không có gì báo lỗi. Đây là kiểu hỏng chỉ người nhận mới thấy.
//
// Bộ vẽ (room-list-image.js) đã fail-soft: thiếu font thì rơi về font hệ thống
// chứ không chết. Script này là bước bù, chạy MỘT LẦN khi dựng worker:
//     node worker/tai-font.mjs
// Kiểm lại bằng:  node worker/kiem-anh.mjs
//
// Font: Be Vietnam Pro (Google Fonts, giấy phép OFL — được phép phân phối lại).
// Thư mục worker/fonts/ nằm trong .gitignore: đây là artifact tải về, không phải
// mã nguồn, và nó đổi theo nền tảng.
// =============================================================================
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const THU_MUC = join(dirname(fileURLToPath(import.meta.url)), 'fonts');
const GOC = 'https://github.com/google/fonts/raw/main/ofl/bevietnampro';

// Bốn cân nặng mà bộ vẽ thật sự gọi tới: 500 (ô thường), 700 (mã/giá/tình
// trạng), 800 (tiêu đề + ô liên hệ), 600 (dòng phụ ô địa chỉ).
const CAN_NANG = ['Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold'];

const KB = (n) => `${(n / 1024).toFixed(0)} KB`;

async function tai(ten) {
  const dich = join(THU_MUC, `BeVietnamPro-${ten}.ttf`);
  if (existsSync(dich) && statSync(dich).size > 10_000) {
    return { ten, trangThai: 'đã có', bytes: statSync(dich).size };
  }
  const res = await fetch(`${GOC}/BeVietnamPro-${ten}.ttf`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Font TTF thật luôn > 10KB; trang lỗi HTML của GitHub thì nhỏ hơn nhiều.
  // Ghi bừa một trang HTML thành .ttf sẽ làm napi-rs im lặng bỏ qua file đó.
  if (buf.length < 10_000) throw new Error(`tệp quá nhỏ (${buf.length} byte) — nhiều khả năng là trang lỗi, không phải font`);
  writeFileSync(dich, buf);
  return { ten, trangThai: 'đã tải', bytes: buf.length };
}

mkdirSync(THU_MUC, { recursive: true });
console.log(`Tải font về ${THU_MUC}`);

let loi = 0;
for (const ten of CAN_NANG) {
  try {
    const r = await tai(ten);
    console.log(`  ✓ ${r.ten.padEnd(10)} ${r.trangThai}  ${KB(r.bytes)}`);
  } catch (e) {
    loi++;
    console.error(`  ✗ ${ten.padEnd(10)} ${e.message}`);
  }
}

if (loi === CAN_NANG.length) {
  console.error('\nKhông tải được font nào. Worker vẫn chạy được (rơi về font hệ thống),');
  console.error('nhưng trên máy không có font tiếng Việt thì chữ có dấu sẽ ra ô vuông.');
  console.error('Cách khác: cài font hệ thống rồi bỏ qua script này —');
  console.error('  Ubuntu/Debian:  apt-get install -y fonts-noto-core fonts-noto-cjk');
  process.exit(1);
}

console.log('\nXong. Kiểm lại bằng: node worker/kiem-anh.mjs');
