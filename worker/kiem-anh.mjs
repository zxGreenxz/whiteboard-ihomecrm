#!/usr/bin/env node
// =============================================================================
// kiem-anh.mjs — vẽ thử ảnh "DANH SÁCH PHÒNG TRỐNG" rồi bảo cho biết font nào
// đã được dùng. Chạy TRƯỚC khi bật broadcast trên một máy mới:
//
//     node worker/kiem-anh.mjs            # dữ liệu mẫu, không đụng CSDL
//     node worker/kiem-anh.mjs <org_id>   # dữ liệu THẬT của một công ty
//
// VÌ SAO TỒN TẠI: thiếu font tiếng Việt không làm worker chết — nó vẫn vẽ ảnh,
// vẫn gửi, chỉ là mọi chữ có dấu ra ô vuông. Không log nào đỏ, không job nào
// failed; người duy nhất phát hiện ra là khách hàng nhận ảnh. Script này biến
// lỗi im lặng đó thành thứ nhìn thấy được trước khi bật.
//
// Nó cũng bắt luôn hai bẫy nền tảng khác đã lường trước:
//   • Node bản small-icu in giá tiền thành "4,500,000" thay vì "4.500.000";
//   • @napi-rs/canvas là gói native — copy node_modules từ Windows sang Linux
//     thì import sẽ nổ ngay ở đây chứ không phải giữa một lượt broadcast.
// =============================================================================
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRoomListTable } from './lib/room-list-table.js';
import { napFont, veAnhDanhSach } from './lib/room-list-image.js';

const orgId = process.argv[2];

const phongMau = (code, over = {}) => ({
  id: `id-${code}`, no: Number(code), code, buildingId: 'b1', buildingName: 'Toà mẫu',
  buildingArea: 'Gò Vấp', buildingAddr: '102/30 Lê Văn Thọ, Gò Vấp', floor: Number(String(code)[0]),
  type: 'Studio', price: 4.5, area: 25, status: 'free',
  amenities: ['Máy lạnh', 'Tủ lạnh', 'Giường nệm'], availDate: null, images: [],
  description: null, saleNote: null, passContactName: null, passContactPhone: null,
  passSalePolicy: null, passAvailDate: null, passContactManager: false, ...over,
});

const TOA_MAU = [{
  id: 'b1', code: 'T1', name: '102/30 Lê Văn Thọ', area: 'Gò Vấp', district: 'Gò Vấp',
  address: '102/30 Lê Văn Thọ, Gò Vấp', manager: 'C. Hoa', phone: '0903 000 111',
  elecRate: 3800, liftLabel: 'Thang máy', lift: true, policy: '', images: [], floors: [],
  rooms: [
    phongMau('402'),
    phongMau('305', { status: 'soon', availDate: '5/9', price: 3.9, type: 'Gác lửng', area: 20 }),
    phongMau('203', { status: 'pass', passContactPhone: '0909 555 123', passContactName: 'A. Tuấn' }),
  ],
  freeCount: 3, total: 3,
}];

async function layToa() {
  if (!orgId) return { buildings: TOA_MAU, nguon: 'dữ liệu mẫu' };
  // Chỉ nạp ctx khi thật sự cần CSDL — chạy bản mẫu không đòi .env.
  const { docPhongTrong } = await import('./lib/vacant-rooms.js');
  const { buildings } = await docPhongTrong(orgId);
  return { buildings, nguon: `công ty ${orgId}` };
}

const font = await napFont();
console.log(`Font: ${font.nguon}${font.soTep ? ` (${font.soTep} tệp)` : ''}`);
if (font.ghiChu) console.log(`  ${font.ghiChu}`);
if (font.nguon !== 'thu-muc-fonts') {
  console.log('  ⚠ Chưa dùng bộ font đóng gói. Chạy `node worker/tai-font.mjs` để ảnh khớp bản web.');
}

const { buildings, nguon } = await layToa();
const table = buildRoomListTable(buildings);
console.log(`Nguồn dữ liệu: ${nguon} — ${table.totalRooms} phòng / ${table.groups.length} toà`);

if (!table.totalRooms) {
  console.log('Không có phòng nào chào được → worker sẽ KHÔNG gửi (đúng thiết kế). Dừng.');
  process.exit(0);
}

// Bẫy ICU: kiểm bằng chính chuỗi giá mà bảng vừa dựng, không đoán.
const giaMau = table.groups[0]?.rows[0]?.price || '';
const icuOk = !giaMau || giaMau.includes('.');
console.log(`Định dạng giá: "${giaMau}" ${icuOk ? '(đúng kiểu Việt)' : '⚠ SAI — Node thiếu full-ICU, đang in kiểu Anh'}`);

const buf = await veAnhDanhSach(table);
const dich = join(process.cwd(), 'kiem-anh-phong-trong.png');
writeFileSync(dich, buf);
console.log(`\nĐã ghi: ${dich} (${(buf.length / 1024).toFixed(0)} KB)`);
console.log('MỞ ẢNH RA XEM: chữ có dấu (Trống, Phòng, Điện) phải đọc được, không phải ô vuông.');
