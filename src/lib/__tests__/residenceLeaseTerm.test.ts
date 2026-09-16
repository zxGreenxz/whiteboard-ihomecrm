// Đọc thời hạn trên ảnh hợp đồng ở nhờ. Các dòng mẫu chép từ chữ THẬT trên hai
// ảnh chủ nộp ngày 16/09/2026 (Nguyễn Gia Bình và Trương Lâm Xuân Nghi).
import { describe, expect, it } from 'vitest';
import { congThang, docHanHopDong, hanConHieuLuc, khongDau, ngayHopLe } from '@/lib/residenceLeaseTerm';

const HOP_DONG_THAT = [
  'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM',
  'HỢP ĐỒNG CHO THUÊ, MƯỢN, Ở NHỜ',
  'Hôm nay, Ngày 14 Tháng 09 Năm 2026, Tại Phường Hạnh Thông',
  'Ông (Bà): VÕ TRỊNH THÙY GIANG    Sinh Năm: 1987',
  '4. Mục đích: để ở và đăng ký tạm trú.',
  'Thời hạn mượn: 24 tháng (từ 14/09/2026 đến 14/09/2028)',
  'Hợp đồng được lập thành 2 bản, các bản đều giống nhau',
];

describe('docHanHopDong', () => {
  it('đọc đúng cặp ngày trên hợp đồng thật', () => {
    expect(docHanHopDong(HOP_DONG_THAT)).toEqual({ from: '14/09/2026', to: '14/09/2028', months: 24, nguon: 'cap-ngay' });
  });

  it('ghép được cặp ngày dù bộ nhận dạng cắt thành hai dòng', () => {
    const han = docHanHopDong(['Thời hạn mượn: 24 tháng (từ 14/09/2026', 'đến 14/09/2028)']);
    expect(han).toMatchObject({ from: '14/09/2026', to: '14/09/2028', nguon: 'cap-ngay' });
  });

  it('không có cặp ngày thì lấy ngày lập cộng số tháng', () => {
    const han = docHanHopDong(['Hôm nay, Ngày 14 Tháng 09 Năm 2026, Tại Phường Hạnh Thông', 'Thời hạn mượn: 24 tháng']);
    expect(han).toEqual({ from: '14/09/2026', to: '14/09/2028', months: 24, nguon: 'ngay-cong-thang' });
  });

  it('cộng tháng giữ đúng cuối tháng ngắn', () => {
    expect(docHanHopDong(['Hôm nay, Ngày 31 Tháng 12 Năm 2026', 'Thời hạn mượn: 2 tháng']))
      .toMatchObject({ to: '28/02/2027' });
    expect(congThang(new Date(Date.UTC(2027, 11, 31)), 2)).toEqual(new Date(Date.UTC(2028, 1, 29)));
  });

  it('số tháng in trên giấy lệch với cặp ngày thì bỏ, không đoán', () => {
    // Một trong hai con số đã bị đọc sai mà không có cách nào biết cái nào.
    expect(docHanHopDong(['Thời hạn mượn: 24 tháng (từ 14/09/2026 đến 14/09/2027)'])).toBeNull();
  });

  it('trả null khi giấy không có thời hạn', () => {
    expect(docHanHopDong(['HỢP ĐỒNG CHO THUÊ, MƯỢN, Ở NHỜ', 'Ông (Bà): VÕ TRỊNH THÙY GIANG'])).toBeNull();
    expect(docHanHopDong([])).toBeNull();
  });

  it('trả null khi ngày không có thật hoặc ngược chiều', () => {
    expect(docHanHopDong(['Thời hạn mượn: 24 tháng (từ 31/02/2026 đến 14/09/2028)'])).toBeNull();
    expect(docHanHopDong(['(từ 14/09/2028 đến 14/09/2026)'])).toBeNull();
  });

  it('chấp nhận dấu chấm hoặc gạch nối thay dấu gạch chéo', () => {
    expect(docHanHopDong(['Thời hạn mượn: 12 tháng (từ 01.03.2026 đến 01-03-2027)']))
      .toMatchObject({ from: '01/03/2026', to: '01/03/2027', months: 12 });
  });

  it('bỏ thời hạn dài bất thường', () => {
    expect(docHanHopDong(['Thời hạn mượn: 120 tháng (từ 14/09/2026 đến 14/09/2036)'])).toBeNull();
  });
});

describe('phụ trợ', () => {
  it('khongDau bỏ dấu và gom khoảng trắng', () => {
    expect(khongDau(' Thời  hạn MƯỢN: 24 Tháng ')).toBe('thoi han muon: 24 thang');
    expect(khongDau('Đến')).toBe('den');
  });

  it('ngayHopLe từ chối ngày không có thật', () => {
    expect(ngayHopLe(29, 2, 2027)).toBeNull();
    expect(ngayHopLe(29, 2, 2028)).not.toBeNull();
    expect(ngayHopLe(0, 1, 2026)).toBeNull();
  });

  it('hanConHieuLuc so với hôm nay theo giờ Việt Nam', () => {
    const han = { from: '14/09/2026', to: '14/09/2028', nguon: 'cap-ngay' } as const;
    expect(hanConHieuLuc(han, new Date('2026-09-16T00:00:00Z'))).toBe(true);
    expect(hanConHieuLuc(han, new Date('2028-09-20T00:00:00Z'))).toBe(false);
    // 14/09/2028 lúc 23:30 giờ VN vẫn là ngày 14 nên hạn chưa qua.
    expect(hanConHieuLuc(han, new Date('2028-09-13T16:30:00Z'))).toBe(true);
  });
});
