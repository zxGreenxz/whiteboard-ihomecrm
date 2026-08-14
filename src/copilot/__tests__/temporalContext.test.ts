// Kỳ tương đối phải chuẩn hoá bằng mã, không giao cho mô hình tính.
//
// Ca C28 của đánh giá live 13/08/2026 ("doanh thu tháng trước") là lý do file
// này tồn tại: system prompt ĐÃ mang ngày hôm nay dưới dạng câu chữ, mô hình vẫn
// nói không biết ngày và hỏi lại kỳ.
import { describe, expect, it } from 'vitest';
import {
  apDungKyTuongDoi,
  ngayCuoiThang,
  resolveRelativePeriod,
  taoRequestContext,
  type CopilotRequestContext,
} from '../temporalContext';

const ctx = (kyHienTai: string): CopilotRequestContext => ({
  kyHienTai,
  timeZone: 'Asia/Ho_Chi_Minh',
  locale: 'vi-VN',
});

describe('resolveRelativePeriod', () => {
  it('"tháng này" ra kỳ hiện tại, "tháng trước" lùi một tháng', () => {
    expect(resolveRelativePeriod('doanh thu tháng này', ctx('2026-08'))?.month).toBe('2026-08');
    expect(resolveRelativePeriod('doanh thu tháng trước', ctx('2026-08'))?.month).toBe('2026-07');
  });

  it('lùi qua ranh giới NĂM không sai', () => {
    // Phép trừ tháng viết tay hay hỏng đúng chỗ này, và kết quả sai vẫn trông
    // như một kỳ hợp lệ nên không ai để ý.
    expect(resolveRelativePeriod('tháng trước', ctx('2026-01'))?.month).toBe('2025-12');
  });

  it('nhận cả bản KHÔNG DẤU và các cách nói khác', () => {
    for (const cau of ['doanh thu thang truoc', 'doanh thu tháng rồi', 'doanh thu tháng vừa rồi']) {
      expect(resolveRelativePeriod(cau, ctx('2026-08'))?.month, cau).toBe('2026-07');
    }
    for (const cau of ['thang nay', 'tháng hiện tại']) {
      expect(resolveRelativePeriod(cau, ctx('2026-08'))?.month, cau).toBe('2026-08');
    }
  });

  it('cụm MƠ HỒ trả null — không đoán bừa một tháng', () => {
    // null nghĩa là "không có gì để ép", KHÔNG phải "dùng tháng này". Mặc định
    // ngầm sẽ biến một câu hỏi mơ hồ thành một con số tự tin.
    for (const cau of ['doanh thu quý này', 'doanh thu năm ngoái', 'doanh thu tuần trước', 'doanh thu tháng 3', 'doanh thu']) {
      expect(resolveRelativePeriod(cau, ctx('2026-08')), cau).toBeNull();
    }
  });

  it('trả kèm mốc đầu/cuối tháng đúng, kể cả tháng 2 năm nhuận', () => {
    const ky = resolveRelativePeriod('tháng này', ctx('2024-02'))!;
    expect(ky.startDate).toBe('2024-02-01');
    expect(ky.endDate).toBe('2024-02-29');
    expect(ngayCuoiThang('2026-02')).toBe('2026-02-28');
    expect(ngayCuoiThang('2026-12')).toBe('2026-12-31');
  });
});

describe('taoRequestContext — giờ Việt Nam, không phải giờ máy', () => {
  it('nửa đêm mùng 1 giờ VN vẫn ra tháng MỚI dù UTC còn ở tháng cũ', () => {
    // 2026-08-31T18:00Z = 2026-09-01T01:00 giờ VN. Đọc theo giờ máy/UTC sẽ ra
    // "2026-08" — đúng loại lệch đã làm màn lương mặc định sai kỳ (audit 20/07).
    expect(taoRequestContext(new Date('2026-08-31T18:00:00Z')).kyHienTai).toBe('2026-09');
    expect(taoRequestContext(new Date('2026-08-31T16:00:00Z')).kyHienTai).toBe('2026-08');
  });
});

describe('apDungKyTuongDoi', () => {
  const ky = resolveRelativePeriod('tháng trước', ctx('2026-08'));

  it('ép kỳ chuẩn hoá vào tool có tham số kỳ', () => {
    const ra = apDungKyTuongDoi('doanh_thu_thang', { accrual: false }, ky);
    expect(ra.args.thang).toBe('2026-07');
    expect(ra.kyBiThayThe).toBeNull();
  });

  it('mô hình điền kỳ KHÁC ⇒ ghi đè và BÁO LẠI, không im lặng', () => {
    // Im lặng sửa số của mô hình rồi trả lời như không có gì xảy ra là cách
    // nhanh nhất để không ai phát hiện bộ chuẩn hoá này hỏng.
    const ra = apDungKyTuongDoi('doanh_thu_thang', { thang: '2026-08' }, ky);
    expect(ra.args.thang).toBe('2026-07');
    expect(ra.kyBiThayThe).toBe('2026-08');
  });

  it('mô hình điền ĐÚNG kỳ ⇒ không báo gì', () => {
    const ra = apDungKyTuongDoi('doanh_thu_thang', { thang: '2026-07' }, ky);
    expect(ra.kyBiThayThe).toBeNull();
  });

  it('không đụng tool KHÔNG có tham số kỳ, và không đụng khi câu không nêu kỳ', () => {
    const a = apDungKyTuongDoi('phong_trong', { toa_nha: 'A' }, ky);
    expect(a.args).toEqual({ toa_nha: 'A' });
    const b = apDungKyTuongDoi('doanh_thu_thang', { thang: '2026-03' }, null);
    expect(b.args.thang).toBe('2026-03');
    expect(b.kyBiThayThe).toBeNull();
  });

  it('tim_hoa_don cũng nhận kỳ chuẩn hoá', () => {
    const ra = apDungKyTuongDoi('tim_hoa_don', { trang_thai: 'unpaid' }, ky);
    expect(ra.args.thang).toBe('2026-07');
  });
});

describe('dòng năng lực trong system prompt (ca C25)', () => {
  it('liệt kê đích danh tool đang có, sinh từ danh sách ĐÃ LỌC QUYỀN', async () => {
    // Mô hình từng nói "không có công cụ" cho ty_le_lap_day dù tool nằm ngay
    // trong request. Nhắc tên bằng lời trong system prompt là chỗ nó chắc đọc.
    const { dongNangLuc } = await import('../chatEngine');
    const dong = dongNangLuc(['ty_le_lap_day', 'so_quy', 'cong_no_tong_quan'])!;
    expect(dong).toContain('ty_le_lap_day');
    expect(dong).toContain('so_quy');
    expect(dong).toContain('cong_no_tong_quan');
    expect(dong).toContain('(3)');
    // Và phải dặn rõ hai điều mà đánh giá live bắt lỗi: đừng từ chối sai, và
    // một tool lỗi không huỷ các ý khác.
    expect(dong).toMatch(/không có công cụ/i);
    expect(dong).toMatch(/ý khác|ý còn lại|ý nào/i);
  });

  it('không tool nào ⇒ không chèn dòng rỗng vào prompt', async () => {
    const { dongNangLuc } = await import('../chatEngine');
    expect(dongNangLuc([])).toBeNull();
  });

  it('thứ tự tool không đổi nội dung dòng (ổn định cho prompt cache)', async () => {
    const { dongNangLuc } = await import('../chatEngine');
    expect(dongNangLuc(['b_tool', 'a_tool'])).toBe(dongNangLuc(['a_tool', 'b_tool']));
  });
});

describe('quy tắc prompt đóng ca C23/C27', () => {
  it('CHAT_SYSTEM_PROMPT dặn trả đủ từng ý và không trả lời tay không', async () => {
    const { CHAT_SYSTEM_PROMPT } = await import('../systemPromptVi');
    expect(CHAT_SYSTEM_PROMPT).toMatch(/ĐỦ TỪNG Ý|đủ từng ý/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/không thao tác được/i);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/link/i);
  });
});
