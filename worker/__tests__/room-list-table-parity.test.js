// =============================================================================
// ĐỐI CHIẾU HAI BẢN dựng bảng "DANH SÁCH PHÒNG TRỐNG":
//   • worker/lib/room-list-table.js          (Node thuần — dựng bảng gửi Zalo)
//   • src/pages/phong-trong/roomListTable.ts (web — dựng bảng cho trang /r/:token)
//
// VÌ SAO TỒN TẠI FILE NÀY. Worker chạy Node không có bước biên dịch TypeScript
// nên nó KHÔNG import được bản `.ts`; bản `.js` là một bản chép tay có chủ ý
// (xem đầu file room-list-table.js). Hai bản chép tay luôn trôi khỏi nhau —
// đó là quy luật, không phải rủi ro giả định. Và khi trôi thì KHÔNG có gì báo
// động: cả hai vẫn "chạy được", chỉ có khách nhận ảnh một bảng còn người mở
// link thấy một bảng khác. Test này là thứ DUY NHẤT ngăn chuyện đó.
//
// Nó chạy được vì suite `app-unit` gọi vitest ở gốc repo (xem
// tooling/test-matrix.json), mà vitest biên dịch `.ts` — điều kiện worker lúc
// chạy thật không có. Sửa một bên mà quên bên kia thì file này đỏ ngay.
//
// Hỏng ở đây KHÔNG được "chữa" bằng cách sửa test cho khớp: phải sửa bản đã
// trôi cho bằng bản kia, hoặc sửa cả hai.
import { describe, it, expect } from 'vitest';

import * as JS from '../lib/room-list-table.js';
import * as TS from '../../src/pages/phong-trong/roomListTable.ts';

/* ------------------------------------------------------------- dữ liệu nền */

/**
 * Dựng MỚI mỗi lần gọi: hai bản phải nhận hai object độc lập. Dùng chung một
 * object thì một bản lỡ sửa dữ liệu vào (sort tại chỗ, push…) sẽ làm bản kia
 * nhận đầu vào đã bị đổi — và test vẫn xanh vì cả hai cùng thấy dữ liệu bẩn.
 *
 * Bộ này cố ý phủ hết các nhánh của cả hai bản:
 *   • ba trạng thái xuất được (free/soon/pass) + `rented` phải bị loại;
 *   • cả ba dạng ô TÌNH TRẠNG của phòng pass (ẩn SĐT / có SĐT+tên / trống trơn);
 *   • giá điện khác nhau giữa các toà mà ảnh KHÔNG được tự sinh dòng điện (chủ tự gõ);
 *   • một toà không còn phòng nào chào được → nhóm bị bỏ;
 *   • sắp xếp tầng giảm dần rồi số phòng tăng dần;
 *   • mã phòng rỗng → rơi về số phòng; giá 0 / diện tích 0 / loại rỗng;
 *   • nội thất DÀI (bản vẽ ảnh phải xuống dòng) và nội thất rỗng → rơi về mô tả;
 *   • hotline + chính sách chung chỉ nằm trên MỘT toà (bản dựng phải tự tìm);
 *   • SĐT toà trùng hotline (khác cách viết) → ẩn; SĐT riêng khác → in ở ô địa chỉ;
 *   • chính sách sale riêng: ô khuyến mãi, rơi về chính sách khách pass, bỏ chỗ trắng.
 */
function duLieu() {
  return [
    {
      id: 'b1',
      code: 'LVT',
      name: 'Toà A',
      area: 'Gò Vấp',
      district: 'Gò Vấp',
      address: '102/30 Lê Văn Thọ, P.11, Gò Vấp, Thành phố Hồ Chí Minh',
      manager: 'A. Hiển',
      phone: '0909 111 111',
      hotline: '0909111111',
      salePolicy: '  Nước 100k/người\n\n  Xe free  ',
      elecRate: 3800,
      liftLabel: 'Thang máy',
      lift: true,
      policy: 'HĐ 12 tháng giảm 200k',
      floors: [],
      freeCount: 4,
      total: 5,
      rooms: [
        {
          id: 'r1', no: 402, code: 'A-402', floor: 4, status: 'free',
          price: 4.5, area: 25, type: 'Studio',
          amenities: ['Máy lạnh', 'Ban công', 'Gác lửng', 'Bếp riêng', 'Máy giặt', 'Cửa sổ lớn', 'Tủ lạnh', 'Full nội thất'],
          description: null, availDate: null, saleNote: ' Ký 1 năm giảm 200k suốt HĐ ',
        },
        {
          id: 'r2', no: 401, code: 'A-401', floor: 4, status: 'soon',
          price: 0, area: 0, type: '',
          amenities: [], description: 'Cửa sổ hành lang, hướng Đông', availDate: '01/09',
        },
        {
          id: 'r3', no: 501, code: 'A-501', floor: 5, status: 'pass',
          price: 6.25, area: 32, type: '1PN',
          amenities: ['Máy lạnh', ''], description: null, availDate: null,
          passContactManager: true, passContactName: 'Chị Mai', passContactPhone: '0938 000 000',
          passSalePolicy: 'Giảm 300k tháng đầu',
        },
        {
          id: 'r4', no: 301, code: '', floor: 3, status: 'free',
          price: 3.2, area: 18, type: 'Studio',
          amenities: [], description: null, availDate: null, saleNote: '   ',
        },
        {
          id: 'r5', no: 302, code: 'A-302', floor: 3, status: 'rented',
          price: 3.5, area: 18, type: 'Studio',
          amenities: ['Máy lạnh'], description: null, availDate: null,
        },
      ],
    },
    {
      id: 'b2',
      code: 'BVD',
      name: 'Toà B',
      area: 'Quận 4',
      district: 'Quận 4',
      address: '',                       // trống → ô địa chỉ rơi về tên toà
      manager: '',
      phone: '0912 345 678',             // SĐT riêng khác hotline → in ở ô địa chỉ
      hotline: '',                       // hotline chỉ chép trên toà A — bản dựng tự tìm
      elecRate: 3900,                    // lệch toà A → nhánh ngoại lệ
      liftLabel: null,
      lift: false,
      policy: '',
      floors: [],
      freeCount: 3,
      total: 3,
      rooms: [
        {
          id: 'r6', no: 201, code: 'B-201', floor: 2, status: 'pass',
          price: 5, area: 28, type: '2PN',
          amenities: ['Tủ lạnh'], description: null, availDate: null,
          passContactPhone: '0938 111 222', passContactName: 'Chị Mai',
          saleNote: 'Giảm 500k', passSalePolicy: 'Khách tự thoả thuận',   // ô khuyến mãi thắng
        },
        {
          id: 'r7', no: 202, code: 'B-202', floor: 2, status: 'soon',
          price: 4, area: 22, type: 'Studio',
          amenities: ['Máy giặt'], description: null, availDate: null,   // không có ngày
          passSalePolicy: 'Không phải phòng pass',                        // không được rò vào ô
        },
        {
          id: 'r8', no: 101, code: 'B-101', floor: 1, status: 'pass',
          price: 7.75, area: 40, type: 'Duplex',
          amenities: [], description: '', availDate: null,               // pass không có liên hệ nào
        },
      ],
    },
    {
      id: 'b3',
      code: 'SUN',
      name: 'Toà C',
      area: 'Quận 1',
      district: 'Quận 1',
      address: '37 Tôn Đức Thắng, Q.1',
      manager: 'C. Lan',
      phone: '0977 222 333',
      elecRate: 3800,                    // trùng toà A → 3800 thành mức chuẩn
      liftLabel: 'Thang bộ',
      lift: false,
      policy: '',
      floors: [],
      freeCount: 0,
      total: 1,
      rooms: [
        {
          id: 'r9', no: 101, code: 'C-101', floor: 1, status: 'rented',
          price: 9, area: 55, type: '2PN',
          amenities: ['Máy lạnh'], description: null, availDate: null,
        },
      ],
    },
  ];
}

/** Bộ thứ hai: chưa toà nào khai giá điện, chưa toà nào khai SĐT. */
function duLieuThieuThongTin() {
  return [
    {
      id: 'z1', code: 'Z', name: 'Toà Z', area: '', district: '', address: 'Số 1 Đường X',
      manager: '', phone: '', elecRate: null, liftLabel: null, lift: false, policy: '',
      floors: [], freeCount: 1, total: 1,
      rooms: [{
        id: 'z-r1', no: 101, code: 'Z-101', floor: 1, status: 'free',
        price: 3, area: 20, type: 'Studio', amenities: ['Máy lạnh'], description: null, availDate: null,
      }],
    },
  ];
}

/* ------------------------------------------------------- đối chiếu toàn bảng */

describe('buildRoomListTable — bản JS của worker KHỚP bản TS của web', () => {
  it('bộ dữ liệu đầy đủ: toàn bộ object RoomListTable giống hệt nhau', () => {
    const banJS = JS.buildRoomListTable(duLieu());
    const banTS = TS.buildRoomListTable(duLieu());
    expect(banJS).toEqual(banTS);
  });

  it('bảng dựng ra đúng như mong đợi (khoá cả hai bản vào một hình dạng cụ thể)', () => {
    // `toEqual` ở test trên chỉ nói HAI BẢN GIỐNG NHAU — nếu cả hai cùng sai
    // một kiểu thì nó vẫn xanh. Test này neo thêm vào giá trị mong đợi thật.
    const t = JS.buildRoomListTable(duLieu());

    expect(t.title).toBe('DANH SÁCH PHÒNG TRỐNG');
    // Ô liên hệ in đúng hotline đã chọn (nguyên văn), không lấy SĐT toà.
    expect(t.contactLines).toEqual(['LIÊN HỆ ADMIN ĐỂ MỞ CỬA', '0909111111']);
    // Chỉ chính sách chủ tự gõ — không tự sinh dòng giá điện (chủ bỏ 10/10/2026).
    expect(t.infoLines).toEqual(['Nước 100k/người', 'Xe free']);
    expect(t.totalRooms).toBe(7);

    // Toà C không còn phòng chào được → không có nhóm.
    expect(t.groups.map((g) => g.buildingId)).toEqual(['b1', 'b2']);

    // Tầng giảm dần, cùng tầng thì số phòng tăng dần.
    expect(t.groups[0].rows.map((r) => r.code)).toEqual(['A-501', 'A-401', 'A-402', '301']);
    expect(t.groups[1].rows.map((r) => r.code)).toEqual(['B-201', 'B-202', 'B-101']);

    // Địa chỉ tới phường (phường số giữ quận), bỏ thành phố; không còn dòng quản lý.
    expect(t.groups[0]).toMatchObject({
      address: '102/30 Lê Văn Thọ, P.11, Gò Vấp',
      lift: { kind: 'elevator', label: '(thang máy)' },
      phone: null, // "0909 111 111" là hotline viết khác → không in lặp
    });
    expect(t.groups[1]).toMatchObject({ address: 'Toà B', lift: null, phone: '0912 345 678' });

    expect(t.groups[0].rows.map((r) => r.policy)).toEqual(['Giảm 300k tháng đầu', '', 'Ký 1 năm giảm 200k suốt HĐ', '']);
    expect(t.groups[1].rows.map((r) => r.policy)).toEqual(['Giảm 500k', '', '']);
    expect(t.groups[0].rows.map((r) => r.roomId)).toEqual(['r3', 'r2', 'r1', 'r4']);
  });

  it('bộ thiếu giá điện / thiếu SĐT: hai bản cùng không bịa dữ liệu', () => {
    const banJS = JS.buildRoomListTable(duLieuThieuThongTin());
    const banTS = TS.buildRoomListTable(duLieuThieuThongTin());
    expect(banJS).toEqual(banTS);
    expect(banJS.infoLines).toEqual([]);
    expect(banJS.contactLines).toEqual(['Chưa có số liên hệ']);
  });

  it('danh sách toà RỖNG: hai bản cùng trả bảng rỗng, không ném lỗi', () => {
    expect(JS.buildRoomListTable([])).toEqual(TS.buildRoomListTable([]));
    expect(JS.buildRoomListTable([]).totalRooms).toBe(0);
    expect(JS.buildRoomListTable([]).groups).toEqual([]);
  });

  it('toà có phòng nhưng KHÔNG phòng nào xuất được → cùng bỏ nhóm', () => {
    const chiThue = () => [{
      ...duLieu()[2],
    }];
    expect(JS.buildRoomListTable(chiThue())).toEqual(TS.buildRoomListTable(chiThue()));
    expect(JS.buildRoomListTable(chiThue()).groups).toEqual([]);
  });
});

/* --------------------------------------------------- đối chiếu từng hàm nhỏ */

describe('EXPORT_STATUSES', () => {
  it('hai bản lọc cùng một bộ trạng thái', () => {
    expect([...JS.EXPORT_STATUSES]).toEqual([...TS.EXPORT_STATUSES]);
    expect([...JS.EXPORT_STATUSES]).toEqual(['free', 'soon', 'pass']);
  });
});

describe('fmtVndFull', () => {
  const cases = [0, -1, 0.5, 3, 4.5, 6.25, 7.75, 12.345, 100, 0.0004];
  for (const p of cases) {
    it(`giá ${p} triệu: hai bản ra cùng chuỗi`, () => {
      expect(JS.fmtVndFull(p)).toBe(TS.fmtVndFull(p));
    });
  }

  it('giá trị neo: 4.5 → "4.500.000", 0 → rỗng', () => {
    expect(JS.fmtVndFull(4.5)).toBe('4.500.000');
    expect(JS.fmtVndFull(6.25)).toBe('6.250.000');
    expect(JS.fmtVndFull(0)).toBe('');
    expect(JS.fmtVndFull(-1)).toBe('');
  });
});

describe('statusLines', () => {
  const phong = [
    { ten: 'trống sẵn', r: { status: 'free' } },
    { ten: 'sắp trống có ngày', r: { status: 'soon', availDate: '01/09' } },
    { ten: 'sắp trống ngày một chữ số', r: { status: 'soon', availDate: '9/12' } },
    { ten: 'sắp trống KHÔNG có ngày', r: { status: 'soon', availDate: null } },
    { ten: 'pass — khách ẩn SĐT', r: { status: 'pass', passContactManager: true, passContactPhone: '0938 111 222', passContactName: 'Chị Mai' } },
    { ten: 'pass — có SĐT và tên', r: { status: 'pass', passContactPhone: '0938 111 222', passContactName: 'Chị Mai' } },
    { ten: 'pass — chỉ có SĐT', r: { status: 'pass', passContactPhone: '0938 111 222' } },
    { ten: 'pass — chỉ có tên', r: { status: 'pass', passContactName: 'Chị Mai' } },
    { ten: 'pass — không có liên hệ nào', r: { status: 'pass' } },
    { ten: 'đã thuê (không lọt vào bảng nhưng hàm vẫn phải cùng kết quả)', r: { status: 'rented' } },
  ];
  for (const { ten, r } of phong) {
    it(`${ten}: hai bản ra cùng các dòng`, () => {
      expect(JS.statusLines(r)).toEqual(TS.statusLines(r));
    });
  }

  it('giá trị neo cho các nhánh dễ sai nhất', () => {
    expect(JS.statusLines({ status: 'free' })).toEqual(['TRỐNG SẴN']);
    // "01/09" → "1/9": bỏ số 0 đứng đầu đúng như file Excel Sale đang dùng.
    expect(JS.statusLines({ status: 'soon', availDate: '01/09' })).toEqual(['1/9 TRỐNG']);
    expect(JS.statusLines({ status: 'soon', availDate: null })).toEqual(['SẮP TRỐNG']);
    // Khách ẩn SĐT: tuyệt đối KHÔNG được lộ số dù dữ liệu có sẵn số.
    expect(JS.statusLines({ status: 'pass', passContactManager: true, passContactPhone: '0938 111 222' }))
      .toEqual(['KHÁCH PASS PHÒNG', 'LIÊN HỆ ADMIN IHOME MỞ CỬA']);
    expect(JS.statusLines({ status: 'pass', passContactPhone: '0938 111 222', passContactName: 'Chị Mai' }))
      .toEqual(['KHÁCH PASS PHÒNG:', '0938 111 222 (Chị Mai)']);
    expect(JS.statusLines({ status: 'pass' })).toEqual(['KHÁCH PASS PHÒNG']);
  });
});

describe('typeCell / amenitiesCell / ô địa chỉ / chính sách / exportFileName', () => {
  const phong = [
    { area: 25, type: 'Studio', amenities: ['Máy lạnh', 'Ban công'], description: null },
    { area: 0, type: 'Studio', amenities: [], description: 'Cửa sổ hành lang' },
    { area: 25, type: '', amenities: [], description: null },
    { area: 25, type: '  1PN  ', amenities: ['', '  '], description: '  Ban công  ' },
    { area: 0, type: '', amenities: [], description: '' },
  ];
  for (const [i, r] of phong.entries()) {
    it(`phòng #${i}: typeCell và amenitiesCell khớp`, () => {
      expect(JS.typeCell(r)).toBe(TS.typeCell(r));
      expect(JS.amenitiesCell(r)).toBe(TS.amenitiesCell(r));
    });
  }

  const toa = [
    { name: 'Toà A', address: '102/30 Lê Văn Thọ', liftLabel: 'Thang máy', manager: 'A. Hiển' },
    { name: 'Toà B', address: '', liftLabel: null, manager: '' },
    { name: 'Toà C', address: '5 Bến Vân Đồn', liftLabel: '  ', manager: '  C. Lan  ' },
    { name: 'Toà D', address: '', liftLabel: ' THANG BỘ ', manager: '' },
  ];
  for (const [i, b] of toa.entries()) {
    it(`toà #${i}: liftCell khớp`, () => {
      expect(JS.liftCell(b)).toEqual(TS.liftCell(b));
    });
  }

  const diaChi = [
    '102/30 Lê Văn Thọ, khu phố 6, Phường Thông Tây Hội, Thành phố Hồ Chí Minh',
    '403PVB, Phường 15, Quận Tân Bình, Hồ Chí Minh',
    '44/8 Trung Lang, khu phố 33, phường Bảy Hiền, TP. Hồ Chí Minh',
    '403 Phạm Văn Bạch, P15, Tân Bình',
    '37 Tôn Đức Thắng, Q.1, TP.HCM',
    '12 Lê Lợi, Phường Bến Nghé, Quận 1, Thành phố Hồ Chí Minh',
    'Phường'.normalize('NFD') + ' 3, đầu chuỗi không tính, Phường 7, TP HCM',
    'Số 1 Đường X',
    '',
    '12 Võ Văn Ngân, TP Thủ Đức, TP HCM',
    '12 ABC, Phường 7, TP Vũng Tàu, Bà Rịa - Vũng Tàu',
    'Block B, P305, Phường Bến Nghé, TPHCM',
    '5 Lê Lợi, Q.1, Ho Chi Minh',
    '5 Lê Lợi, XÃ BÌNH HƯNG, TỈNH LONG AN',
  ];
  for (const [i, a] of diaChi.entries()) {
    it(`địa chỉ #${i}: shortAddress khớp`, () => {
      expect(JS.shortAddress(a)).toBe(TS.shortAddress(a));
    });
  }

  it('samePhone / salePolicyLines / policyCell khớp', () => {
    for (const [a, b] of [['0909 111 111', '0909111111'], ['+84 909 111 111', '0909.111.111'], ['0909111111', '0909111112'], ['', null], ['0084 909 111 111', '0909111111']]) {
      expect(JS.samePhone(a, b)).toBe(TS.samePhone(a, b));
    }
    for (const s of ['', null, ' a \r\n\r\n b ', 'một dòng']) expect(JS.salePolicyLines(s)).toEqual(TS.salePolicyLines(s));
    for (const r of [
      { status: 'free', saleNote: ' x ', passSalePolicy: 'y' },
      { status: 'pass', saleNote: '', passSalePolicy: ' y ' },
      { status: 'soon', saleNote: null, passSalePolicy: 'y' },
      { status: 'pass' },
    ]) expect(JS.policyCell(r)).toBe(TS.policyCell(r));
  });

  it('exportFileName khớp', () => {
    const d = new Date(2026, 7, 31, 10, 0, 0);   // 31/08/2026 giờ máy
    expect(JS.exportFileName(d)).toBe(TS.exportFileName(d));
    expect(JS.exportFileName(d)).toBe('danh-sach-phong-trong-20260831.png');
  });
});
