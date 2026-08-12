// Test phần THUẦN của xử lý ảnh + luật "ảnh không bao giờ được lưu".
//
// Phần canvas không test ở đây (nó là API trình duyệt, không phải mã của ta);
// thứ đáng canh là toán thu nhỏ, phép đo kích thước, và bất biến lưu trữ.
import { describe, expect, it } from 'vitest';
import { CANH_TOI_DA, tinhKichThuoc, uocByteTuDataUrl, anhTuDataTransfer, LOAI_ANH_NHAN } from '../anh';
import { doDaiNoiDung, noiDungDeLuu } from '../chatEngine';

describe('tinhKichThuoc — thu nhỏ giữ tỉ lệ', () => {
  it('thu ảnh lớn về đúng cạnh dài tối đa', () => {
    expect(tinhKichThuoc(4000, 3000)).toEqual({ rong: 1024, cao: 768 });
    expect(tinhKichThuoc(3000, 4000)).toEqual({ rong: 768, cao: 1024 });
  });

  it('KHÔNG phóng to ảnh nhỏ', () => {
    // Phóng 300px lên 1024 không thêm thông tin nào mà làm request nặng hơn
    // mười lần — và mô hình đọc chữ trong ảnh không nhờ đó mà rõ hơn.
    expect(tinhKichThuoc(300, 200)).toEqual({ rong: 300, cao: 200 });
    expect(tinhKichThuoc(CANH_TOI_DA, 500)).toEqual({ rong: CANH_TOI_DA, cao: 500 });
  });

  it('ảnh vuông và ảnh suy biến không làm vỡ', () => {
    expect(tinhKichThuoc(2048, 2048)).toEqual({ rong: 1024, cao: 1024 });
    expect(tinhKichThuoc(0, 0)).toEqual({ rong: 0, cao: 0 });
    expect(tinhKichThuoc(-5, 10)).toEqual({ rong: 0, cao: 0 });
  });
});

describe('uocByteTuDataUrl — đo đúng số byte thật', () => {
  it('trừ phần đệm "=" của base64', () => {
    // "hi" → aGk= : 2 byte thật, 4 ký tự base64.
    expect(uocByteTuDataUrl('data:image/jpeg;base64,aGk=')).toBe(2);
    expect(uocByteTuDataUrl('data:image/jpeg;base64,YQ==')).toBe(1);
    expect(uocByteTuDataUrl('data:image/jpeg;base64,YWJj')).toBe(3);
  });

  it('chuỗi không phải data URL trả 0 thay vì NaN', () => {
    expect(uocByteTuDataUrl('khong-phai-data-url')).toBe(0);
    expect(uocByteTuDataUrl('')).toBe(0);
  });
});

describe('anhTuDataTransfer — chỉ nhận đúng loại ảnh', () => {
  const gia = (types: string[]) =>
    ({ files: types.map((type) => ({ type })) }) as unknown as DataTransfer;

  it('lọc bỏ file không phải ảnh', () => {
    const r = anhTuDataTransfer(gia(['image/png', 'application/pdf', 'text/plain', 'image/jpeg']));
    expect(r.map((f) => f.type)).toEqual(['image/png', 'image/jpeg']);
  });

  it('null hoặc rỗng ⇒ mảng rỗng, không ném', () => {
    expect(anhTuDataTransfer(null)).toEqual([]);
    expect(anhTuDataTransfer(gia([]))).toEqual([]);
  });

  it('danh sách loại nhận được là một hằng có tên', () => {
    expect(LOAI_ANH_NHAN).toContain('image/jpeg');
    expect(LOAI_ANH_NHAN).not.toContain('application/pdf');
  });
});

describe('BẤT BIẾN — ảnh KHÔNG BAO GIỜ được lưu vào lịch sử chat', () => {
  const anhGia = 'data:image/jpeg;base64,' + 'A'.repeat(4000);
  const noiDung = [
    { type: 'text' as const, text: 'Đọc giúp chỉ số công tơ' },
    { type: 'image_url' as const, image_url: { url: anhGia } },
  ];

  it('noiDungDeLuu thay ảnh bằng placeholder, giữ phần chữ', () => {
    // Lưu ảnh sẽ biến bảng lịch sử chat thành kho ảnh kèm bài toán
    // retention/PII cho thứ người dùng chụp bừa (CCCD, biên lai có số tài khoản).
    const luu = noiDungDeLuu(noiDung)!;
    expect(luu).toContain('Đọc giúp chỉ số công tơ');
    expect(luu).toContain('[ảnh]');
    expect(luu).not.toContain('base64');
    expect(luu.length).toBeLessThan(200);
  });

  it('chuỗi thường lưu nguyên vẹn', () => {
    expect(noiDungDeLuu('câu hỏi thường')).toBe('câu hỏi thường');
    expect(noiDungDeLuu(null)).toBeNull();
  });

  it('ngân sách ngữ cảnh ĐO ĐÚNG ảnh, không coi nó là 1 ký tự', () => {
    // `.length` của mảng là SỐ PHẦN TỬ. Dùng nó làm ngân sách sẽ coi một ảnh
    // base64 nửa megabyte là "2 ký tự", và cửa cắt lịch sử mất tác dụng đúng
    // lúc cần nhất.
    expect(doDaiNoiDung(noiDung)).toBeGreaterThan(4000);
    expect(doDaiNoiDung('abc')).toBe(3);
    expect(doDaiNoiDung(null)).toBe(0);
  });
});
