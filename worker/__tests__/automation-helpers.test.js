// =============================================================================
// Test các hàm THUẦN của automation.js — phần dựng NỘI DUNG tin, không phải
// phần quyết định "gửi hay không" (cái đó đã có automation-scenario.test.js) và
// cũng không phải phần xếp hàng (đã có automation-engine.test.js).
//
// Vì sao ba hàm nhỏ này đáng có test riêng: chúng là chỗ duy nhất biến dữ liệu
// phòng thành CHỮ mà khách đọc. Sai ở đây không làm gì đổ vỡ — worker vẫn chạy,
// hàng đợi vẫn xanh — chỉ có khách nhận được tin lộ dấu ngoặc `{hotline}`, hoặc
// một tin toàn dòng trống, hoặc ảnh phòng không tải được vì URL bị cắt sai.
// Không có test thì thứ duy nhất phát hiện ra là khách.
import { describe, it, expect, vi } from 'vitest';

// automation.js kéo theo ctx.js (đọc .env, tạo thư mục sessions, dựng client
// Supabase) và room-list-image.js (nạp @napi-rs/canvas — binding native). Ba
// hàm thuần dưới đây KHÔNG chạm tới thứ nào trong số đó, nên chặn ở cửa import
// cho test chạy nhanh và không phụ thuộc máy. Giả lập giống hệt
// automation-engine.test.js để hai file cùng một nếp.
vi.mock('../lib/ctx.js', () => ({
  sb: null,
  log: () => {},
  orgOf: () => null,
  sessions: new Map(),
  SUPABASE_URL: 'https://x.test',
}));
vi.mock('../lib/room-list-image.js', () => ({
  veAnhDanhSach: () => Promise.resolve(Buffer.from('')),
}));

const { tachRefStorage, dienMau, soanTinPhong } = await import('../lib/automation.js');

/* ========================================================== tachRefStorage */

describe('tachRefStorage — tách {bucket, path} từ URL Supabase Storage', () => {
  it('URL public chuẩn → đúng bucket và path nhiều cấp', () => {
    const r = tachRefStorage(
      'https://x.supabase.co/storage/v1/object/public/zalo-media/acc-1/automation/danh-sach.png',
    );
    expect(r).toEqual({ bucket: 'zalo-media', path: 'acc-1/automation/danh-sach.png' });
  });

  it('CẮT query string khỏi path', () => {
    // URL ký (`?token=…`) là dạng hay gặp nhất khi ảnh lấy từ bucket riêng tư.
    // Nếu token dính vào path thì lệnh tải lại ảnh sẽ trỏ vào một object không
    // tồn tại — và lỗi chỉ lộ ra lúc gửi, tức là trước mặt khách.
    const r = tachRefStorage(
      'https://x.supabase.co/storage/v1/object/public/room-sale-images/b1/p.jpg?token=abc&download=1',
    );
    expect(r).toEqual({ bucket: 'room-sale-images', path: 'b1/p.jpg' });
  });

  it('hiểu cả /object/sign/ và /object/authenticated/', () => {
    expect(tachRefStorage('https://x.supabase.co/storage/v1/object/sign/zalo-media/a/b.png'))
      .toEqual({ bucket: 'zalo-media', path: 'a/b.png' });
    expect(tachRefStorage('https://x.supabase.co/storage/v1/object/authenticated/zalo-media/a/b.png'))
      .toEqual({ bucket: 'zalo-media', path: 'a/b.png' });
  });

  it('GIẢI MÃ ký tự đã mã hoá trong path', () => {
    // Tên file tiếng Việt/có khoảng trắng bị mã hoá khi lên URL. Không giải mã
    // thì `storage.download('anh%20phong.jpg')` tìm đúng chuỗi đó làm tên object
    // và trả 404, dù ảnh vẫn nằm nguyên trong bucket.
    const r = tachRefStorage(
      'https://x.supabase.co/storage/v1/object/public/zalo-media/acc-1/anh%20ph%C3%B2ng.jpg',
    );
    expect(r).toEqual({ bucket: 'zalo-media', path: 'acc-1/anh phòng.jpg' });
  });

  it('URL NGOÀI project → null (không đoán bừa là ảnh của mình)', () => {
    expect(tachRefStorage('https://example.com/x.jpg')).toBeNull();
    expect(tachRefStorage('https://cdn.khac.vn/storage/v1/anh.png')).toBeNull();
  });

  it('blob: và data: → null', () => {
    // Hai lược đồ này chỉ sống trong tab trình duyệt đã tạo ra chúng. Worker
    // không tải lại được, nên phải loại từ đầu thay vì để nó lỗi lúc gửi.
    expect(tachRefStorage('blob:https://ptcrm.test/9f0e-4a')).toBeNull();
    expect(tachRefStorage('data:image/png;base64,iVBORw0KGgo=')).toBeNull();
  });

  it('rỗng / null / không phải chuỗi → null', () => {
    expect(tachRefStorage('')).toBeNull();
    expect(tachRefStorage(null)).toBeNull();
    expect(tachRefStorage(undefined)).toBeNull();
    expect(tachRefStorage(123)).toBeNull();
    expect(tachRefStorage({ url: 'x' })).toBeNull();
  });

  it('đúng đường dẫn /object/ nhưng thiếu phần path → null', () => {
    expect(tachRefStorage('https://x.supabase.co/storage/v1/object/public/zalo-media/')).toBeNull();
    expect(tachRefStorage('https://x.supabase.co/storage/v1/object/public/zalo-media')).toBeNull();
  });
});

/* ================================================================= dienMau */

describe('dienMau — thay {khoa} trong mẫu tin', () => {
  it('thay đúng khoá có giá trị', () => {
    expect(dienMau('Xin chào {ten}!', { ten: 'anh Tâm' })).toBe('Xin chào anh Tâm!');
  });

  it('khoá THIẾU → chuỗi rỗng, KHÔNG để lộ dấu ngoặc', () => {
    // Đây là lỗi tệ nhất của cả hàm: `{hotline}` nguyên xi trong tin gửi group
    // Zalo hàng chục người là thứ ai cũng thấy và không sửa lại được.
    expect(dienMau('Liên hệ: {hotline}', {})).toBe('Liên hệ: ');
    expect(dienMau('Liên hệ: {hotline}', {})).not.toContain('{');
    expect(dienMau('A {x} B {y} C', { x: 1 })).toBe('A 1 B  C');
  });

  it('null cũng coi như thiếu, nhưng 0 và chuỗi rỗng thì KHÔNG', () => {
    // `so_phong: 0` phải in ra "0" — nếu bị nuốt thành rỗng thì câu "hiện có
    // phòng còn chào được" đọc như một lỗi đánh máy.
    expect(dienMau('[{a}]', { a: null })).toBe('[]');
    expect(dienMau('[{a}]', { a: undefined })).toBe('[]');
    expect(dienMau('[{a}]', { a: 0 })).toBe('[0]');
    expect(dienMau('[{a}]', { a: '' })).toBe('[]');
    expect(dienMau('[{a}]', { a: false })).toBe('[false]');
  });

  it('nhiều khoá khác nhau trong một mẫu', () => {
    const ra = dienMau('{ngay}: còn {so_phong} phòng — {link}', {
      ngay: '31/08', so_phong: 12, link: 'https://ptcrm.test/r/abc',
    });
    expect(ra).toBe('31/08: còn 12 phòng — https://ptcrm.test/r/abc');
  });

  it('khoá LẶP LẠI được thay ở mọi vị trí', () => {
    expect(dienMau('{a}-{a}-{a}', { a: 'x' })).toBe('x-x-x');
  });

  it('mẫu rỗng / null / không phải chuỗi → chuỗi rỗng', () => {
    expect(dienMau('', { a: 1 })).toBe('');
    expect(dienMau(null, { a: 1 })).toBe('');
    expect(dienMau(undefined, {})).toBe('');
  });

  it('chỉ nhận khoá dạng \\w+ — dấu ngoặc khác giữ nguyên', () => {
    // Ghi lại hành vi thật để người soạn mẫu biết: `{ma-phong}` và `{ ten }`
    // KHÔNG phải chỗ điền, chúng đi thẳng vào tin gửi khách.
    expect(dienMau('{ma-phong} { ten } {}', { 'ma-phong': 'A', ten: 'B' }))
      .toBe('{ma-phong} { ten } {}');
  });
});

/* ============================================================= soanTinPhong */

/** Mẫu tin mặc định trong automation-config.js — dùng đúng bản đang chạy thật. */
const MAU = 'PHÒNG {ma_phong} — {dia_chi}\nGiá {gia}đ/tháng · {dien_tich} · {loai_phong}\n'
  + 'Nội thất: {noi_that}\nTình trạng: {tinh_trang}\nXem phòng liên hệ: {hotline}';

const phong = (over = {}) => ({
  id: 'r1',
  code: 'A-402',
  price: 4.5,
  area: 25,
  type: 'Studio',
  status: 'free',
  availDate: null,
  amenities: ['Máy lạnh', 'Ban công'],
  description: null,
  saleNote: null,
  buildingName: 'Toà A',
  buildingAddr: '102/30 Lê Văn Thọ, Gò Vấp',
  ...over,
});

describe('soanTinPhong — một tin chi tiết phòng', () => {
  it('phòng TRỐNG SẴN mang chữ "Trống sẵn"', () => {
    const t = soanTinPhong(phong(), MAU, '0909 123 456');
    expect(t).toContain('Tình trạng: Trống sẵn');
  });

  it('phòng SẮP TRỐNG có ngày → "Sắp trống <ngày>"', () => {
    const t = soanTinPhong(phong({ status: 'soon', availDate: '01/09' }), MAU, '');
    expect(t).toContain('Tình trạng: Sắp trống 01/09');
  });

  it('phòng SẮP TRỐNG không có ngày → chỉ "Sắp trống"', () => {
    const t = soanTinPhong(phong({ status: 'soon', availDate: null }), MAU, '');
    expect(t).toContain('Tình trạng: Sắp trống');
    expect(t).not.toContain('Sắp trống null');
  });

  it('phòng KHÁCH PASS → "Khách pass phòng"', () => {
    const t = soanTinPhong(phong({ status: 'pass' }), MAU, '');
    expect(t).toContain('Tình trạng: Khách pass phòng');
  });

  it('trạng thái lạ thì in nguyên trạng thái, không in "undefined"', () => {
    const t = soanTinPhong(phong({ status: 'reserved' }), MAU, '');
    expect(t).toContain('Tình trạng: reserved');
  });

  it('GIÁ: triệu → đồng có phân cách nghìn', () => {
    expect(soanTinPhong(phong({ price: 4.5 }), 'x{gia}x', '')).toBe('x4.500.000x');
    expect(soanTinPhong(phong({ price: 6.25 }), 'x{gia}x', '')).toBe('x6.250.000x');
  });

  it('GIÁ 0 (hoặc âm) → "liên hệ", KHÔNG phải "0"', () => {
    // Gửi "Giá 0đ/tháng" ra group là hỏng cả tin. Phòng chưa khai giá thì mời
    // khách hỏi, đó cũng là cách Sale vẫn viết tay.
    expect(soanTinPhong(phong({ price: 0 }), 'Giá {gia}', '')).toBe('Giá liên hệ');
    expect(soanTinPhong(phong({ price: -1 }), 'Giá {gia}', '')).toBe('Giá liên hệ');
  });

  it('DIỆN TÍCH 0 → bỏ trống thay vì "0m²"', () => {
    expect(soanTinPhong(phong({ area: 0 }), '[{dien_tich}]', '')).toBe('[]');
    expect(soanTinPhong(phong({ area: 25 }), '[{dien_tich}]', '')).toBe('[25m²]');
  });

  it('NỘI THẤT: chưa khai tiện nghi thì rơi về mô tả phòng', () => {
    const t = soanTinPhong(
      phong({ amenities: [], description: 'Cửa sổ hành lang, có ban công' }), MAU, '',
    );
    expect(t).toContain('Nội thất: Cửa sổ hành lang, có ban công');
  });

  it('NỘI THẤT: không có cả hai → để trống, không in "null"', () => {
    const t = soanTinPhong(phong({ amenities: [], description: null }), MAU, '');
    expect(t).toContain('Nội thất: ');
    expect(t).not.toContain('null');
  });

  it('địa chỉ thiếu thì rơi về TÊN TOÀ', () => {
    expect(soanTinPhong(phong({ buildingAddr: '' }), '{dia_chi}', '')).toBe('Toà A');
  });

  it('hotline rỗng không để lại dấu ngoặc', () => {
    const t = soanTinPhong(phong(), MAU, '');
    expect(t).not.toContain('{');
    expect(t).not.toContain('}');
  });

  it('KHÔNG còn dòng trống thừa và không thừa khoảng trắng hai đầu', () => {
    // Mẫu có khoá đứng một mình trên dòng (vd {khuyen_mai}) là chuyện bình
    // thường; phòng nào không có khuyến mãi sẽ để lại một dòng rỗng, hai ba
    // phòng như vậy liên tiếp thì tin nhìn như bị lỗi.
    const mau = '\n\nPHÒNG {ma_phong}\n{khuyen_mai}\n\n\n{loai_phong}\n\n';
    const t = soanTinPhong(phong({ saleNote: null }), mau, '');
    expect(t).not.toContain('\n\n\n');
    expect(t).toBe('PHÒNG A-402\n\nStudio');
    expect(t).toBe(t.trim());
  });

  it('có khuyến mãi thì giữ nguyên nội dung khuyến mãi', () => {
    const t = soanTinPhong(phong({ saleNote: 'Giảm 500k tháng đầu' }), '{khuyen_mai}', '');
    expect(t).toBe('Giảm 500k tháng đầu');
  });

  it('mẫu rỗng → chuỗi rỗng, không ném lỗi', () => {
    expect(soanTinPhong(phong(), '', '')).toBe('');
    expect(soanTinPhong(phong(), null, null)).toBe('');
  });
});
