// =============================================================================
// Test các hàm THUẦN của auto-reply.js.
//
// `timTuKhoa` là cửa quyết định máy có mở miệng hay không — nó gác CẢ danh sách
// chặn (cọc/hợp đồng/thanh toán) lẫn danh sách kích hoạt. Một lỗi so khớp ở đây
// không làm test tích hợp đỏ (auto-reply-engine.test.js đưa vào những câu chắc
// chắn khớp), nhưng ngoài đời nó thành hai chuyện: máy trả lời một câu hỏi về
// tiền cọc, hoặc máy câm với mọi tin viết hoa.
//
// `soanDanhSachPhong` là toàn bộ nội dung khách đọc được. Nó phải nhóm đúng ba
// bucket và KHÔNG bao giờ trả chuỗi rỗng — một tin trắng gửi cho sale còn tệ
// hơn im lặng.
import { describe, it, expect, vi } from 'vitest';

// auto-reply.js kéo theo ctx.js (đọc .env, tạo thư mục sessions, dựng client
// Supabase). Hai hàm dưới đây không chạm DB, nên chặn ở cửa import cho test
// chạy nhanh và không phụ thuộc máy — giả lập giống auto-reply-engine.test.js.
vi.mock('../lib/ctx.js', () => ({
  sb: null,
  log: () => {},
  orgOf: () => null,
  sessions: new Map(),
  SUPABASE_URL: 'https://x.test',
}));

const { timTuKhoa, soanDanhSachPhong } = await import('../lib/auto-reply.js');

/* =============================================================== timTuKhoa */

describe('timTuKhoa', () => {
  it('KHÔNG phân biệt hoa/thường ở phía tin đến', () => {
    // Sale gõ vội "CÒN PHÒNG NÀO K" là chuyện thường ngày. Nếu chỉ khớp chữ
    // thường thì tính năng câm đúng lúc cần nhất.
    expect(timTuKhoa('CÒN PHÒNG NÀO KHÔNG SHOP', ['phòng'])).toBe('phòng');
    expect(timTuKhoa('Phòng còn không anh', ['phòng'])).toBe('phòng');
  });

  it('khớp GIỮA CÂU, không cần đứng đầu', () => {
    expect(timTuKhoa('bên em còn phòng nào trống không ạ', ['trống'])).toBe('trống');
  });

  it('không khớp → null (im lặng là mặc định an toàn)', () => {
    expect(timTuKhoa('em chào anh ạ', ['phòng', 'giá', 'trống'])).toBeNull();
  });

  it('danh sách RỖNG → null', () => {
    expect(timTuKhoa('còn phòng không', [])).toBeNull();
  });

  it('bỏ qua phần tử rỗng/null trong danh sách', () => {
    // Người dùng xoá hết chữ trong một ô từ khoá trên giao diện thì mảng còn
    // lại một chuỗi rỗng. `''` nằm trong MỌI chuỗi — không chặn thì máy trả lời
    // tất cả mọi tin nhắn, kể cả "ok".
    expect(timTuKhoa('em chào anh', ['', null, undefined])).toBeNull();
    expect(timTuKhoa('em chào anh', ['', 'chào'])).toBe('chào');
  });

  it('từ khoá tiếng Việt CÓ DẤU khớp đúng', () => {
    expect(timTuKhoa('anh muốn đặt cọc phòng này', ['cọc'])).toBe('cọc');
    expect(timTuKhoa('cho em xin hợp đồng thuê', ['hợp đồng'])).toBe('hợp đồng');
    expect(timTuKhoa('bên mình có hoá đơn không', ['hóa đơn', 'hoá đơn'])).toBe('hoá đơn');
  });

  it('CÓ DẤU khác KHÔNG DẤU — "coc" không kích hoạt từ khoá "cọc"', () => {
    // Ghi lại giới hạn đã biết: hàm so sánh nguyên văn, không bỏ dấu. Tin gõ
    // không dấu sẽ lọt qua danh sách chặn. Cách chữa là thêm biến thể không dấu
    // vào chính danh sách từ khoá, không phải sửa hàm này.
    expect(timTuKhoa('anh muon dat coc phong', ['cọc'])).toBeNull();
  });

  it('trả về từ khoá ĐẦU TIÊN theo thứ tự DANH SÁCH, không theo vị trí trong câu', () => {
    // Lý do phải biết: chuỗi này đi thẳng vào `reason` của nhật ký. Người đọc
    // sổ cần hiểu con số họ thấy đến từ đâu.
    expect(timTuKhoa('còn phòng nào giá tốt không', ['giá', 'phòng'])).toBe('giá');
    expect(timTuKhoa('còn phòng nào giá tốt không', ['phòng', 'giá'])).toBe('phòng');
  });

  it('từ khoá VIẾT HOA trong danh sách KHÔNG bao giờ khớp', () => {
    // Hàm chỉ hạ chữ thường phía tin đến. Danh sách được `chuanHoaAutoReply`
    // hạ sẵn trước khi tới đây, nên đường chạy thật vẫn đúng — nhưng ai gọi
    // trực tiếp hàm này phải tự hạ chữ.
    expect(timTuKhoa('còn phòng không', ['PHÒNG'])).toBeNull();
  });

  it('nội dung rỗng/null → null', () => {
    expect(timTuKhoa('', ['phòng'])).toBeNull();
    expect(timTuKhoa(null, ['phòng'])).toBeNull();
    expect(timTuKhoa(undefined, ['phòng'])).toBeNull();
  });
});

/* ======================================================= soanDanhSachPhong */

const phong = (over = {}) => ({
  id: 'r1',
  code: '402',
  price: 4.5,
  area: 25,
  type: 'Studio',
  status: 'free',
  availDate: null,
  buildingName: 'Toà A',
  buildingAddr: '102/30 Lê Văn Thọ',
  ...over,
});

describe('soanDanhSachPhong', () => {
  const ds = [
    phong({ id: 'r1', code: '402', status: 'free' }),
    phong({ id: 'r2', code: '403', status: 'free' }),
    phong({ id: 'r3', code: '301', status: 'soon', availDate: '01/09' }),
    phong({ id: 'r4', code: '201', status: 'pass' }),
    phong({ id: 'r5', code: '999', status: 'rented' }),
  ];

  it('nhóm đúng BA mục và đếm đúng số lượng', () => {
    const t = soanDanhSachPhong(ds, '');
    expect(t).toContain('TRỐNG NGAY (2):');
    expect(t).toContain('SẮP TRỐNG (1):');
    expect(t).toContain('KHÁCH PASS PHÒNG (1):');
    // `rented` không thuộc mục nào — phòng đã có người thuê không được chào lại.
    expect(t).not.toContain('999');
  });

  it('giữ đúng THỨ TỰ mục: trống ngay → sắp trống → khách pass', () => {
    const t = soanDanhSachPhong(ds, '');
    expect(t.indexOf('TRỐNG NGAY')).toBeLessThan(t.indexOf('SẮP TRỐNG'));
    expect(t.indexOf('SẮP TRỐNG')).toBeLessThan(t.indexOf('KHÁCH PASS PHÒNG'));
  });

  it('phòng SẮP TRỐNG hiện ngày trống', () => {
    const t = soanDanhSachPhong([phong({ status: 'soon', availDate: '01/09' })], '');
    expect(t).toContain('— trống 01/09');
  });

  it('phòng SẮP TRỐNG không có ngày thì không thêm đuôi rỗng', () => {
    const t = soanDanhSachPhong([phong({ status: 'soon', availDate: null })], '');
    expect(t).toContain('SẮP TRỐNG (1):');
    expect(t).not.toContain('— trống');
    expect(t).not.toContain('null');
  });

  it('mục nào KHÔNG có phòng thì không xuất hiện', () => {
    const t = soanDanhSachPhong([phong({ status: 'free' })], '');
    expect(t).toContain('TRỐNG NGAY (1):');
    expect(t).not.toContain('SẮP TRỐNG');
    expect(t).not.toContain('KHÁCH PASS PHÒNG');
  });

  it('danh sách RỖNG → câu báo chưa có phòng, KHÔNG phải chuỗi rỗng', () => {
    // Gửi một tin trắng cho sale còn tệ hơn im lặng: họ tưởng lỗi mạng và nhắn
    // lại, rồi lại nhận thêm một tin trắng nữa.
    const t = soanDanhSachPhong([], '');
    expect(t.trim()).not.toBe('');
    expect(t).toContain('chưa có phòng trống');
    expect(t).toContain('có phòng em báo ngay');
  });

  it('mọi phòng đều đã thuê cũng ra câu báo chưa có phòng', () => {
    const t = soanDanhSachPhong([phong({ status: 'rented' })], '');
    expect(t).toContain('chưa có phòng trống');
  });

  it('CÓ link thì thêm dòng link ở cuối', () => {
    const t = soanDanhSachPhong(ds, 'https://ptcrm.test/r/abc');
    expect(t).toContain('Bảng đầy đủ: https://ptcrm.test/r/abc');
    expect(t.trimEnd().endsWith('https://ptcrm.test/r/abc')).toBe(true);
  });

  it('KHÔNG có link thì không có dòng link', () => {
    for (const link of ['', null, undefined]) {
      const t = soanDanhSachPhong(ds, link);
      expect(t).not.toContain('Bảng đầy đủ');
    }
  });

  it('không phòng nào thì KHÔNG kèm link (câu báo đứng một mình)', () => {
    const t = soanDanhSachPhong([], 'https://ptcrm.test/r/abc');
    expect(t).not.toContain('Bảng đầy đủ');
  });

  it('dòng phòng: mã, địa chỉ, giá, diện tích, loại', () => {
    const t = soanDanhSachPhong([phong({ code: '402', price: 4.5, area: 25, type: 'Studio' })], '');
    expect(t).toContain('• P.402 — 102/30 Lê Văn Thọ: 4.500.000đ, 25m², Studio');
  });

  it('GIÁ 0 → "giá liên hệ", không phải "0đ"', () => {
    const t = soanDanhSachPhong([phong({ price: 0 })], '');
    expect(t).toContain('giá liên hệ');
    expect(t).not.toContain('0đ,');
  });

  it('diện tích 0 và loại phòng rỗng thì bỏ hẳn, không để lại dấu phẩy treo', () => {
    const t = soanDanhSachPhong([phong({ code: '402', area: 0, type: '' })], '');
    expect(t).toContain('• P.402 — 102/30 Lê Văn Thọ: 4.500.000đ');
    expect(t).not.toContain('0m²');
    expect(t).not.toContain(', ,');
  });

  it('địa chỉ thiếu thì rơi về TÊN TOÀ', () => {
    const t = soanDanhSachPhong([phong({ buildingAddr: '', buildingName: 'Toà A' })], '');
    expect(t).toContain('• P.402 — Toà A:');
  });

  it('các mục cách nhau bằng một dòng trống, phòng cùng mục thì xuống dòng đơn', () => {
    const t = soanDanhSachPhong(
      [phong({ id: 'r1', code: '402' }), phong({ id: 'r2', code: '403' }), phong({ id: 'r3', code: '301', status: 'pass' })],
      '',
    );
    const khoi = t.split('\n\n');
    expect(khoi).toHaveLength(2);
    expect(khoi[0].split('\n')).toHaveLength(3);   // tiêu đề mục + 2 phòng
    expect(t).not.toContain('\n\n\n');
  });
});
