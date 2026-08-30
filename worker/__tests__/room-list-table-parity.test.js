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
 *   • giá điện KHÁC NHAU giữa các toà → nhánh "Riêng <toà>: điện …" của elecLines;
 *   • một toà không còn phòng nào chào được → nhóm bị bỏ, nhưng vẫn tính vào
 *     giá điện và vào SĐT liên hệ;
 *   • sắp xếp tầng giảm dần rồi số phòng tăng dần;
 *   • mã phòng rỗng → rơi về số phòng; giá 0 / diện tích 0 / loại rỗng;
 *   • nội thất DÀI (bản vẽ ảnh phải xuống dòng) và nội thất rỗng → rơi về mô tả.
 */
function duLieu() {
  return [
    {
      id: 'b1',
      code: 'LVT',
      name: 'Toà A',
      area: 'Gò Vấp',
      district: 'Gò Vấp',
      address: '102/30 Lê Văn Thọ, P.11, Gò Vấp',
      manager: 'A. Hiển',
      phone: '0909 111 111',
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
          description: null, availDate: null,
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
        },
        {
          id: 'r4', no: 301, code: '', floor: 3, status: 'free',
          price: 3.2, area: 18, type: 'Studio',
          amenities: [], description: null, availDate: null,
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
      address: '',                       // trống → addressLines rơi về tên toà
      manager: '',                       // rỗng → không thêm dòng "(QL)"
      phone: '0909 111 111',             // trùng toà A → mode chọn số này
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
        },
        {
          id: 'r7', no: 202, code: 'B-202', floor: 2, status: 'soon',
          price: 4, area: 22, type: 'Studio',
          amenities: ['Máy giặt'], description: null, availDate: null,   // không có ngày
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
    expect(t.contactLines).toEqual(['LIÊN HỆ ADMIN ĐỂ MỞ CỬA', '0909 111 111']);
    expect(t.infoLines[0]).toBe('Điện 3.800đ/số');
    expect(t.infoLines[1]).toBe('Riêng Toà B: điện 3.900đ/số');
    expect(t.totalRooms).toBe(7);

    // Toà C không còn phòng chào được → không có nhóm, dù vẫn tính giá điện.
    expect(t.groups.map((g) => g.buildingId)).toEqual(['b1', 'b2']);

    // Tầng giảm dần, cùng tầng thì số phòng tăng dần.
    expect(t.groups[0].rows.map((r) => r.code)).toEqual(['A-501', 'A-401', 'A-402', '301']);
    expect(t.groups[1].rows.map((r) => r.code)).toEqual(['B-201', 'B-202', 'B-101']);

    expect(t.groups[0].addressLines).toEqual(['102/30 Lê Văn Thọ, P.11, Gò Vấp', '(thang máy)', '(A. Hiển)']);
    expect(t.groups[1].addressLines).toEqual(['Toà B']);
  });

  it('bộ thiếu giá điện / thiếu SĐT: hai bản cùng rơi về giá trị mặc định', () => {
    const banJS = JS.buildRoomListTable(duLieuThieuThongTin());
    const banTS = TS.buildRoomListTable(duLieuThieuThongTin());
    expect(banJS).toEqual(banTS);
    expect(banJS.infoLines[0]).toBe('Điện theo định mức tòa nhà');
    // SĐT mặc định phải là cùng một hằng MANAGER ở cả hai bản.
    expect(banJS.contactLines[1]).toBe(banTS.contactLines[1]);
    expect(banJS.contactLines[1]).toBe(JS.MANAGER.phone);
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

describe('elecLines', () => {
  const bo = (...rates) => rates.map((elecRate, i) => ({
    id: `b${i}`, name: `Toà ${i}`, address: `Địa chỉ ${i}`, elecRate, rooms: [],
  }));

  const truongHop = [
    ['không toà nào khai giá', bo(null, undefined)],
    ['một toà, một giá', bo(3800)],
    ['nhiều toà cùng giá', bo(3800, 3800, 3800)],
    ['một toà lệch giá', bo(3800, 3800, 3900)],
    ['hai mức ngoại lệ khác nhau → sắp theo giá tăng dần', bo(3800, 3800, 4200, 3900)],
    ['hai toà cùng mức ngoại lệ → gom chung một dòng', bo(3800, 3800, 3900, 3900)],
    ['hoà phiếu (mỗi giá một toà) → toà đầu tiên làm chuẩn', bo(3900, 3800)],
    ['giá 0 và giá âm bị loại khỏi thống kê', bo(0, -100, 3800)],
    ['giá lẻ được làm tròn', bo(3800.4, 3800.6)],
  ];
  for (const [ten, buildings] of truongHop) {
    it(`${ten}: hai bản ra cùng các dòng`, () => {
      expect(JS.elecLines(buildings)).toEqual(TS.elecLines(buildings));
    });
  }

  it('giá trị neo', () => {
    expect(JS.elecLines(bo(null))).toEqual(['Điện theo định mức tòa nhà']);
    expect(JS.elecLines(bo(3800, 3800))).toEqual(['Điện 3.800đ/số']);
    expect(JS.elecLines(bo(3800, 3800, 3900)))
      .toEqual(['Điện 3.800đ/số', 'Riêng Toà 2: điện 3.900đ/số']);
  });
});

describe('typeCell / amenitiesCell / addressLines / exportFileName', () => {
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
  ];
  for (const [i, b] of toa.entries()) {
    it(`toà #${i}: addressLines khớp`, () => {
      expect(JS.addressLines(b)).toEqual(TS.addressLines(b));
    });
  }

  it('exportFileName khớp', () => {
    const d = new Date(2026, 7, 31, 10, 0, 0);   // 31/08/2026 giờ máy
    expect(JS.exportFileName(d)).toBe(TS.exportFileName(d));
    expect(JS.exportFileName(d)).toBe('danh-sach-phong-trong-20260831.png');
  });
});
