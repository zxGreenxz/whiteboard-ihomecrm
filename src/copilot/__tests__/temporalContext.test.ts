// Kỳ tương đối phải chuẩn hoá bằng mã, không giao cho mô hình tính.
//
// Ca C28 của đánh giá live 13/08/2026 ("doanh thu tháng trước") là lý do file
// này tồn tại: system prompt ĐÃ mang ngày hôm nay dưới dạng câu chữ, mô hình vẫn
// nói không biết ngày và hỏi lại kỳ.
//
// Mọi mốc thời gian ở đây là CỐ ĐỊNH. Một test kỳ tương đối mà đọc `new Date()`
// sẽ xanh hôm nay và đỏ vào một ngày nào đó không ai đoán được — thường là ngày
// mùng 1, hoặc ngày cuối quý.
import { describe, expect, it } from 'vitest';
import {
  apDungKyTuongDoi,
  ngayCuoiThang,
  quetKyTrongCau,
  quetThamSoKy,
  resolveRelativePeriod,
  soKyRiengBiet,
  taoRequestContext,
  vnNgayOf,
  type CopilotRequestContext,
  type ThamSoKyCuaTool,
} from '../temporalContext';

/** Ngày mặc định 15 để không tình cờ rơi vào ranh giới tháng. */
const ctx = (kyHienTai: string, ngay = `${kyHienTai}-15`): CopilotRequestContext => ({
  kyHienTai,
  ngayHienTai: ngay,
  timeZone: 'Asia/Ho_Chi_Minh',
  locale: 'vi-VN',
});

/** Bản đồ tham số kỳ dựng tay — bộ quét thật được kiểm riêng ở dưới. */
const BAN_DO: Record<string, ThamSoKyCuaTool> = {
  doanh_thu_thang: { ky: 'thang' },
  tim_hoa_don: { ky: 'thang' },
  bao_cao_dong_tien: { ky: 'ky', tu: 'tu', den: 'den' },
  bao_cao_ty_le_chi_phi: { tu: 'tu', den: 'den' },
  tim_phieu_thu_chi: { tu: 'tu_ngay', den: 'den_ngay' },
  bang_luong_ky: { ky: 'ky' },
};

describe('resolveRelativePeriod — kỳ tháng', () => {
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

  it('trả kèm mốc đầu/cuối tháng đúng, kể cả tháng 2 năm nhuận', () => {
    const ky = resolveRelativePeriod('tháng này', ctx('2024-02'))!;
    expect(ky.startDate).toBe('2024-02-01');
    expect(ky.endDate).toBe('2024-02-29');
    expect(ngayCuoiThang('2026-02')).toBe('2026-02-28');
    expect(ngayCuoiThang('2026-12')).toBe('2026-12-31');
  });

  it('câu KHÔNG nêu kỳ vẫn trả null — không đoán bừa tháng này', () => {
    // null nghĩa là "không có gì để ép", KHÔNG phải "dùng tháng này". Mặc định
    // ngầm sẽ biến một câu hỏi mơ hồ thành một con số tự tin.
    for (const cau of ['doanh thu', 'còn phòng trống không', 'ai đang nợ tiền']) {
      expect(resolveRelativePeriod(cau, ctx('2026-08')), cau).toBeNull();
    }
  });
});

describe('resolveRelativePeriod — "N tháng trước" và "N tháng gần nhất"', () => {
  it('"3 tháng trước" là MỘT tháng, không phải ba tháng', () => {
    const ky = resolveRelativePeriod('doanh thu 3 tháng trước', ctx('2026-08'))!;
    expect(ky.kind).toBe('month');
    expect(ky.month).toBe('2026-05');
  });

  it('mẫu có số phải THẮNG mẫu "tháng trước" bao nó', () => {
    // Đây là bẫy thứ tự: nếu mẫu chung chạy trước thì "5 tháng trước" lặng lẽ
    // trở thành tháng 7 — một kỳ hợp lệ, sai, và không có gì đỏ.
    expect(resolveRelativePeriod('5 thang truoc', ctx('2026-08'))?.month).toBe('2026-03');
  });

  it('"6 tháng gần nhất" là KHOẢNG, month = null', () => {
    const ky = resolveRelativePeriod('chi phí 6 tháng gần nhất', ctx('2026-08'))!;
    expect(ky.kind).toBe('range');
    expect(ky.month).toBeNull();
    expect(ky.startDate).toBe('2026-03-01');
    expect(ky.endDate).toBe('2026-08-31');
  });
});

describe('resolveRelativePeriod — quý', () => {
  it('"quý này" bao đúng ba tháng của quý', () => {
    const ky = resolveRelativePeriod('doanh thu quý này', ctx('2026-08'))!;
    expect(ky.kind).toBe('quarter');
    expect(ky.month).toBeNull();
    expect(ky.startDate).toBe('2026-07-01');
    expect(ky.endDate).toBe('2026-09-30');
    expect(ky.nhan).toBe('quý 3/2026');
  });

  it('"quý trước" ở quý 1 lùi sang quý 4 NĂM TRƯỚC', () => {
    const ky = resolveRelativePeriod('quý trước', ctx('2026-02'))!;
    expect(ky.startDate).toBe('2025-10-01');
    expect(ky.endDate).toBe('2025-12-31');
    expect(ky.nhan).toBe('quý 4/2025');
  });

  it('không dấu: "quy truoc" trong quý 3 ra quý 2 cùng năm', () => {
    const ky = resolveRelativePeriod('doanh thu quy truoc', ctx('2026-08'))!;
    expect(ky.startDate).toBe('2026-04-01');
    expect(ky.endDate).toBe('2026-06-30');
  });
});

describe('resolveRelativePeriod — năm', () => {
  it('"năm nay" và "năm ngoái"', () => {
    expect(resolveRelativePeriod('doanh thu năm nay', ctx('2026-08'))?.startDate).toBe('2026-01-01');
    expect(resolveRelativePeriod('doanh thu năm nay', ctx('2026-08'))?.endDate).toBe('2026-12-31');
    const truoc = resolveRelativePeriod('doanh thu năm ngoái', ctx('2026-08'))!;
    expect(truoc.kind).toBe('year');
    expect(truoc.startDate).toBe('2025-01-01');
    expect(truoc.endDate).toBe('2025-12-31');
  });

  it('"năm 2024" lấy đúng năm được nêu, không phải năm hiện tại', () => {
    const ky = resolveRelativePeriod('doanh thu năm 2024', ctx('2026-08'))!;
    expect(ky.nhan).toBe('năm 2024');
    expect(ky.startDate).toBe('2024-01-01');
  });
});

describe('resolveRelativePeriod — tuần (thứ hai → chủ nhật)', () => {
  it('"tuần này" bao đúng 7 ngày, bắt đầu THỨ HAI', () => {
    // 2026-08-15 là thứ bảy ⇒ tuần 10/08 (thứ hai) → 16/08 (chủ nhật).
    const ky = resolveRelativePeriod('thu chi tuần này', ctx('2026-08', '2026-08-15'))!;
    expect(ky.kind).toBe('week');
    expect(ky.startDate).toBe('2026-08-10');
    expect(ky.endDate).toBe('2026-08-16');
  });

  it('CHỦ NHẬT vẫn thuộc tuần đang chạy, không nhảy sang tuần sau', () => {
    // Bẫy kinh điển của tuần bắt đầu thứ hai: `getDay()` trả 0 cho chủ nhật.
    const ky = resolveRelativePeriod('tuần này', ctx('2026-08', '2026-08-16'))!;
    expect(ky.startDate).toBe('2026-08-10');
    expect(ky.endDate).toBe('2026-08-16');
  });

  it('"tuần trước" lùi đúng 7 ngày, kể cả khi vắt qua tháng', () => {
    const ky = resolveRelativePeriod('tuan truoc', ctx('2026-09', '2026-09-02'))!;
    expect(ky.startDate).toBe('2026-08-24');
    expect(ky.endDate).toBe('2026-08-30');
  });
});

describe('resolveRelativePeriod — "tháng N" và khoảng "từ … đến …"', () => {
  it('"tháng 3" lấy năm hiện tại khi tháng đó đã qua', () => {
    expect(resolveRelativePeriod('doanh thu tháng 3', ctx('2026-08'))?.month).toBe('2026-03');
  });

  it('"tháng 12" hỏi vào tháng 2 nghiêng về QUÁ KHỨ (năm trước)', () => {
    // Copilot là bề mặt tra sổ. "Tháng 12" hỏi vào tháng 2 gần như luôn là
    // tháng 12 năm ngoái, và kỳ đã chốt được nói lại trong prompt nên chọn sai
    // vẫn hiện ra chứ không âm thầm.
    expect(resolveRelativePeriod('doanh thu tháng 12', ctx('2026-02'))?.month).toBe('2025-12');
  });

  it('"tháng 3/2024" lấy đúng năm được nêu', () => {
    expect(resolveRelativePeriod('hoá đơn tháng 3/2024', ctx('2026-08'))?.month).toBe('2024-03');
  });

  it('"tháng 13" không phải một tháng — không nhận', () => {
    expect(resolveRelativePeriod('mã tháng 13 là gì', ctx('2026-08'))).toBeNull();
  });

  it('"từ 01/07 đến 15/07" ra khoảng ngày, năm mặc định là năm hiện tại', () => {
    const ky = resolveRelativePeriod('thu chi từ 01/07 đến 15/07', ctx('2026-08'))!;
    expect(ky.kind).toBe('range');
    expect(ky.startDate).toBe('2026-07-01');
    expect(ky.endDate).toBe('2026-07-15');
  });

  it('khoảng có năm đầy đủ, và khoảng ISO', () => {
    expect(resolveRelativePeriod('từ 01/12/2025 đến 31/01/2026', ctx('2026-08'))?.startDate).toBe('2025-12-01');
    expect(resolveRelativePeriod('từ 01/12/2025 đến 31/01/2026', ctx('2026-08'))?.endDate).toBe('2026-01-31');
    const iso = resolveRelativePeriod('từ 2026-02-01 đến 2026-02-28', ctx('2026-08'))!;
    expect(iso.startDate).toBe('2026-02-01');
    expect(iso.endDate).toBe('2026-02-28');
  });

  it('ngày KHÔNG CÓ THẬT bị loại, không bị cuộn sang tháng sau', () => {
    // `new Date(2026, 1, 31)` im lặng thành 03/03. Một khoảng bắt đầu ở một
    // ngày không tồn tại là câu hỏi cần hỏi lại, không phải chỗ để suy.
    expect(resolveRelativePeriod('từ 31/02 đến 05/03', ctx('2026-08'))).toBeNull();
  });
});

describe('taoRequestContext — giờ Việt Nam, không phải giờ máy', () => {
  it('nửa đêm mùng 1 giờ VN vẫn ra tháng MỚI dù UTC còn ở tháng cũ', () => {
    // 2026-08-31T18:00Z = 2026-09-01T01:00 giờ VN. Đọc theo giờ máy/UTC sẽ ra
    // "2026-08" — đúng loại lệch đã làm màn lương mặc định sai kỳ (audit 20/07).
    expect(taoRequestContext(new Date('2026-08-31T18:00:00Z')).kyHienTai).toBe('2026-09');
    expect(taoRequestContext(new Date('2026-08-31T16:00:00Z')).kyHienTai).toBe('2026-08');
  });

  it('ngày hôm nay cũng theo giờ VN — lệch một ngày là lệch cả tuần', () => {
    expect(vnNgayOf(new Date('2026-08-31T18:00:00Z'))).toBe('2026-09-01');
    expect(vnNgayOf(new Date('2026-08-31T16:00:00Z'))).toBe('2026-08-31');
    expect(taoRequestContext(new Date('2026-08-31T18:00:00Z')).ngayHienTai).toBe('2026-09-01');
  });
});

describe('quetThamSoKy — nối MỌI tool có tham số kỳ, không phải hai tool chép tay', () => {
  it('nhận cả `thang`, `ky`, và cặp `tu`/`den`', () => {
    const ban = quetThamSoKy([
      { name: 'a', parameters: { properties: { thang: {}, khac: {} } } },
      { name: 'b', parameters: { properties: { ky: {}, tu: {}, den: {} } } },
      { name: 'c', parameters: { properties: { tu_ngay: {}, den_ngay: {} } } },
    ]);
    expect(ban.a).toEqual({ ky: 'thang' });
    expect(ban.b).toEqual({ ky: 'ky', tu: 'tu', den: 'den' });
    expect(ban.c).toEqual({ tu: 'tu_ngay', den: 'den_ngay' });
  });

  it('tool không có tham số kỳ KHÔNG vào bản đồ, và một nửa cặp cũng không', () => {
    const ban = quetThamSoKy([
      { name: 'khong_ky', parameters: { properties: { toa_nha: {} } } },
      { name: 'nua_cap', parameters: { properties: { tu: {} } } },
      { name: 'khong_schema' },
    ]);
    expect(ban.khong_ky).toBeUndefined();
    expect(ban.nua_cap).toBeUndefined();
    expect(ban.khong_schema).toBeUndefined();
  });

  it('quét trên REGISTRY THẬT bắt được nhiều hơn hẳn hai tool của bản chép tay', async () => {
    // Sàn chống-xanh-rỗng: bản trước nối đúng `doanh_thu_thang` và
    // `tim_hoa_don` trong khi hàng chục tool khác cũng nhận kỳ.
    const { buildRegistryDefinitions } = await import('../tools/registry');
    const { toolSangKhaiBao } = await import('../chatEngine');
    const map = Object.fromEntries(
      buildRegistryDefinitions().map((t) => [t.name, { description: t.description, inputSchema: t.inputSchema }]),
    );
    const khaiBao = toolSangKhaiBao(map);
    const ban = quetThamSoKy(khaiBao.map((k) => ({ name: k.function.name, parameters: k.function.parameters })));
    expect(Object.keys(ban).length).toBeGreaterThanOrEqual(10);
    expect(ban.doanh_thu_thang?.ky).toBe('thang');
    expect(ban.tim_hoa_don?.ky).toBe('thang');
    expect(ban.bao_cao_dong_tien?.tu).toBe('tu');
    expect(ban.tim_phieu_thu_chi?.tu).toBe('tu_ngay');
    expect(ban.phong_trong).toBeUndefined();
  });
});

describe('apDungKyTuongDoi', () => {
  const ky = resolveRelativePeriod('tháng trước', ctx('2026-08'));

  it('ép kỳ chuẩn hoá vào tool có tham số kỳ', () => {
    const ra = apDungKyTuongDoi('doanh_thu_thang', { accrual: false }, ky, BAN_DO);
    expect(ra.args.thang).toBe('2026-07');
    expect(ra.kyBiThayThe).toBeNull();
  });

  it('mô hình điền kỳ KHÁC ⇒ ghi đè và BÁO LẠI, không im lặng', () => {
    // Im lặng sửa số của mô hình rồi trả lời như không có gì xảy ra là cách
    // nhanh nhất để không ai phát hiện bộ chuẩn hoá này hỏng.
    const ra = apDungKyTuongDoi('doanh_thu_thang', { thang: '2026-08' }, ky, BAN_DO);
    expect(ra.args.thang).toBe('2026-07');
    expect(ra.kyBiThayThe).toBe('2026-08');
  });

  it('mô hình điền ĐÚNG kỳ ⇒ không báo gì', () => {
    const ra = apDungKyTuongDoi('doanh_thu_thang', { thang: '2026-07' }, ky, BAN_DO);
    expect(ra.kyBiThayThe).toBeNull();
  });

  it('không đụng tool KHÔNG có tham số kỳ, và không đụng khi câu không nêu kỳ', () => {
    const a = apDungKyTuongDoi('phong_trong', { toa_nha: 'A' }, ky, BAN_DO);
    expect(a.args).toEqual({ toa_nha: 'A' });
    const b = apDungKyTuongDoi('doanh_thu_thang', { thang: '2026-03' }, null, BAN_DO);
    expect(b.args.thang).toBe('2026-03');
    expect(b.kyBiThayThe).toBeNull();
  });

  it('tim_hoa_don cũng nhận kỳ chuẩn hoá', () => {
    const ra = apDungKyTuongDoi('tim_hoa_don', { trang_thai: 'unpaid' }, ky, BAN_DO);
    expect(ra.args.thang).toBe('2026-07');
  });

  it('kỳ tháng vào tool CHỈ có tu/den thì đi bằng mốc đầu/cuối tháng', () => {
    const ra = apDungKyTuongDoi('bao_cao_ty_le_chi_phi', {}, ky, BAN_DO);
    expect(ra.args.tu).toBe('2026-07-01');
    expect(ra.args.den).toBe('2026-07-31');
  });

  it('kỳ QUÝ đi bằng khoảng, và DỌN tham số tháng mô hình để lại', () => {
    // `khoangKy` phía tool ưu tiên `ky` hơn `tu`/`den`; để sót `ky` là "quý này"
    // lặng lẽ co lại còn một tháng.
    const quy = resolveRelativePeriod('quý này', ctx('2026-08'));
    const ra = apDungKyTuongDoi('bao_cao_dong_tien', { ky: '2026-08' }, quy, BAN_DO);
    expect(ra.args.ky).toBeUndefined();
    expect(ra.args.tu).toBe('2026-07-01');
    expect(ra.args.den).toBe('2026-09-30');
    expect(ra.kyBiThayThe).toBeNull();
  });

  it('kỳ nhiều tháng KHÔNG ép được vào tool chỉ nhận một tháng — để nguyên', () => {
    // Nhét tháng đầu quý vào `bang_luong_ky` sẽ trả một phần ba dữ liệu dưới
    // nhãn "quý này": một con số trông hợp lý và sai.
    const quy = resolveRelativePeriod('quý này', ctx('2026-08'));
    const ra = apDungKyTuongDoi('bang_luong_ky', { ky: '2026-08' }, quy, BAN_DO);
    expect(ra.args).toEqual({ ky: '2026-08' });
    expect(ra.kyBiThayThe).toBeNull();
  });

  it('khoảng ngày do người dùng nêu ghi đè cặp tu/den mô hình tự điền, và báo lại', () => {
    const khoang = resolveRelativePeriod('từ 01/07 đến 15/07', ctx('2026-08'));
    const ra = apDungKyTuongDoi(
      'tim_phieu_thu_chi',
      { tu_ngay: '2026-01-01', den_ngay: '2026-01-31' },
      khoang,
      BAN_DO,
    );
    expect(ra.args.tu_ngay).toBe('2026-07-01');
    expect(ra.args.den_ngay).toBe('2026-07-15');
    expect(ra.kyBiThayThe).toBe('2026-01-01 → 2026-01-31');
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

describe('"tháng N năm YYYY" là MỘT THÁNG, không phải cả năm', () => {
  // Bản đầu thử mẫu NĂM trước mẫu THÁNG trên toàn câu, nên "doanh thu tháng 7
  // năm 2024" trả về cả năm 2024 — con số lớn gấp mười hai lần con số được hỏi,
  // và không có gì đỏ. Nay quét theo VỊ TRÍ: "tháng" đứng trước "năm".
  it('"tháng 7 năm 2024" ra 2024-07, không phải năm 2024', () => {
    const ky = resolveRelativePeriod('doanh thu tháng 7 năm 2024', ctx('2026-08'))!;
    expect(ky.kind).toBe('month');
    expect(ky.month).toBe('2024-07');
    expect(ky.startDate).toBe('2024-07-01');
    expect(ky.endDate).toBe('2024-07-31');
  });

  it('"tháng 7/2024" và "tháng 7-2024" cũng vậy', () => {
    expect(resolveRelativePeriod('doanh thu tháng 7/2024', ctx('2026-08'))?.month).toBe('2024-07');
    expect(resolveRelativePeriod('doanh thu tháng 7-2024', ctx('2026-08'))?.month).toBe('2024-07');
  });

  it('"tháng 7" trần vẫn dùng năm hiện tại (tháng đã qua)', () => {
    const ky = resolveRelativePeriod('doanh thu tháng 7', ctx('2026-08'))!;
    expect(ky.month).toBe('2026-07');
  });

  it('"năm 2024" trần vẫn là CẢ NĂM — không bị fix này làm hỏng', () => {
    const ky = resolveRelativePeriod('doanh thu năm 2024', ctx('2026-08'))!;
    expect(ky.kind).toBe('year');
    expect(ky.startDate).toBe('2024-01-01');
  });

  it('không dấu: "thang 7 nam 2024"', () => {
    expect(resolveRelativePeriod('doanh thu thang 7 nam 2024', ctx('2026-08'))?.month).toBe('2024-07');
  });
});

describe('"N tháng rồi" là THỜI LƯỢNG, không phải "tháng trước"', () => {
  // "khách ở phòng 12 tháng rồi" từng ép mọi tool về kỳ tháng trước: mẫu
  // "tháng rồi" khớp ngay bên trong cụm chỉ thời lượng.
  it('"12 tháng rồi" ⇒ null', () => {
    expect(resolveRelativePeriod('khách ở phòng 12 tháng rồi', ctx('2026-08'))).toBeNull();
    expect(resolveRelativePeriod('12 thang roi', ctx('2026-08'))).toBeNull();
  });

  it('"tháng rồi" (không có số đứng trước) vẫn là tháng trước', () => {
    expect(resolveRelativePeriod('doanh thu tháng rồi', ctx('2026-08'))?.month).toBe('2026-07');
    expect(resolveRelativePeriod('tháng vừa rồi thế nào', ctx('2026-08'))?.month).toBe('2026-07');
  });

  it('"hợp đồng 24 tháng" ⇒ null', () => {
    expect(resolveRelativePeriod('hợp đồng 24 tháng', ctx('2026-08'))).toBeNull();
  });

  it('"3 tháng trước" KHÔNG bị chặn nhầm — nó vẫn là một kỳ thật', () => {
    // Chỉ mẫu "tháng rồi/trước" CHUNG mới bị chặn khi có số đứng trước; mẫu
    // "N tháng trước" là mẫu riêng và vẫn phải chạy.
    expect(resolveRelativePeriod('doanh thu 3 tháng trước', ctx('2026-08'))?.month).toBe('2026-05');
  });
});

describe('câu hỏi SO SÁNH: nhiều kỳ thì KHÔNG ép kỳ nào', () => {
  const ban = { doanh_thu_thang: { ky: 'thang' } };

  it('quét ra đủ các kỳ được nhắc, theo thứ tự xuất hiện', () => {
    const ds = quetKyTrongCau('so sánh doanh thu tháng 6 và tháng 7', ctx('2026-08'));
    expect(ds.map((k) => k.month)).toEqual(['2026-06', '2026-07']);
    expect(soKyRiengBiet(ds)).toBe(2);
  });

  it('"năm nay và năm ngoái" là hai kỳ', () => {
    const ds = quetKyTrongCau('doanh thu năm nay và năm ngoái', ctx('2026-08'));
    expect(soKyRiengBiet(ds)).toBe(2);
    expect(ds.map((k) => k.nhan)).toEqual(['năm 2026', 'năm 2025']);
  });

  it('"quý này so với quý trước" là hai kỳ', () => {
    const ds = quetKyTrongCau('quý này so với quý trước', ctx('2026-08'));
    expect(soKyRiengBiet(ds)).toBe(2);
  });

  it('ĐỐI CHỨNG: câu một kỳ vẫn chỉ có một kỳ', () => {
    expect(soKyRiengBiet(quetKyTrongCau('doanh thu tháng trước', ctx('2026-08')))).toBe(1);
    expect(soKyRiengBiet(quetKyTrongCau('doanh thu tháng 7 năm 2024', ctx('2026-08')))).toBe(1);
    expect(soKyRiengBiet(quetKyTrongCau('còn phòng trống không', ctx('2026-08')))).toBe(0);
    // Nhắc cùng một kỳ hai lần vẫn là MỘT kỳ.
    expect(soKyRiengBiet(quetKyTrongCau('tháng 7 và tháng 7', ctx('2026-08')))).toBe(1);
  });

  it('nhiều kỳ ⇒ GIỮ tham số của mô hình, kèm ghi chú giải thích', () => {
    // Ép cả hai lần gọi về kỳ đầu cho ra bảng so sánh hai cột bằng nhau — sai,
    // mà trông y hệt dữ liệu thật.
    const ky = resolveRelativePeriod('so sánh doanh thu tháng 6 và tháng 7', ctx('2026-08'));
    const ra = apDungKyTuongDoi('doanh_thu_thang', { thang: '2026-07' }, ky, ban, true);
    expect(ra.args.thang).toBe('2026-07');
    expect(ra.kyBiThayThe).toBeNull();
    expect(ra.ghiChu).toMatch(/nhi[eề]u k[yỳ]/i);
  });

  it('nhiều kỳ nhưng mô hình BỎ TRỐNG ⇒ vẫn lấp bằng kỳ đầu, có ghi chú', () => {
    const ky = resolveRelativePeriod('so sánh doanh thu tháng 6 và tháng 7', ctx('2026-08'));
    const ra = apDungKyTuongDoi('doanh_thu_thang', {}, ky, ban, true);
    expect(ra.args.thang).toBe('2026-06');
    expect(ra.ghiChu).not.toBeNull();
  });

  it('MỘT kỳ ⇒ vẫn ghi đè như cũ, và không có ghi chú thừa', () => {
    const ky = resolveRelativePeriod('doanh thu tháng trước', ctx('2026-08'));
    const ra = apDungKyTuongDoi('doanh_thu_thang', { thang: '2026-08' }, ky, ban, false);
    expect(ra.args.thang).toBe('2026-07');
    expect(ra.kyBiThayThe).toBe('2026-08');
    expect(ra.ghiChu).toBeNull();
  });

  it('nhiều kỳ ⇒ cặp tu/den mô hình điền cũng được giữ nguyên', () => {
    const banKhoang = { bao_cao_dong_tien: { ky: 'ky', tu: 'tu', den: 'den' } };
    const ky = resolveRelativePeriod('so sánh quý này với quý trước', ctx('2026-08'));
    const ra = apDungKyTuongDoi(
      'bao_cao_dong_tien',
      { tu: '2026-04-01', den: '2026-06-30' },
      ky,
      banKhoang,
      true,
    );
    expect(ra.args.tu).toBe('2026-04-01');
    expect(ra.args.den).toBe('2026-06-30');
    expect(ra.ghiChu).not.toBeNull();
  });
});

describe('dongKy — prompt phải nói ĐÚNG là có chốt kỳ hay không', () => {
  it('một kỳ ⇒ "đã chốt", đừng hỏi lại', async () => {
    const { dongKy } = await import('../chatEngine');
    const ds = quetKyTrongCau('doanh thu tháng trước', ctx('2026-08'));
    const d = dongKy(ds, false)!;
    expect(d).toContain('đã chốt');
    expect(d).toContain('tháng 07/2026');
  });

  it('nhiều kỳ ⇒ nói rõ KHÔNG chốt và kể đủ các kỳ', () => {
    // Câu "hệ thống đã chốt kỳ 2026-06" đặt trước một câu hỏi so sánh chính là
    // thứ dạy mô hình gọi cả hai lần với cùng một kỳ.
    return import('../chatEngine').then(({ dongKy }) => {
      const ds = quetKyTrongCau('so sánh doanh thu tháng 6 và tháng 7', ctx('2026-08'));
      const d = dongKy(ds, true)!;
      expect(d).toMatch(/KH[ÔO]NG ch[ốo]t/);
      expect(d).toContain('tháng 06/2026');
      expect(d).toContain('tháng 07/2026');
    });
  });

  it('không kỳ nào ⇒ null, không chèn dòng rỗng', async () => {
    const { dongKy } = await import('../chatEngine');
    expect(dongKy([], false)).toBeNull();
  });
});

describe('tháng + NĂM TƯƠNG ĐỐI là MỘT kỳ, không phải hai', () => {
  // Bản trước chỉ nuốt được năm viết bằng số, nên bộ quét theo vị trí cắt
  // "doanh thu tháng 6 năm ngoái" thành hai kỳ — "tháng 06/2026" và "năm 2025".
  // Sai gấp đôi: tháng sai năm, VÀ một câu hỏi đơn bị biến thành câu so sánh,
  // rồi `dongKy` bảo mô hình trả lời cả hai.
  it('"tháng 6 năm ngoái" ⇒ 2025-06, đúng MỘT kỳ', () => {
    const ds = quetKyTrongCau('doanh thu tháng 6 năm ngoái', ctx('2026-08'));
    expect(soKyRiengBiet(ds)).toBe(1);
    expect(ds[0].kind).toBe('month');
    expect(ds[0].month).toBe('2025-06');
    expect(ds[0].startDate).toBe('2025-06-01');
    expect(ds[0].endDate).toBe('2025-06-30');
  });

  it('"tháng 7 năm nay" ⇒ 2026-07, đúng MỘT kỳ', () => {
    const ds = quetKyTrongCau('doanh thu tháng 7 năm nay', ctx('2026-08'));
    expect(soKyRiengBiet(ds)).toBe(1);
    expect(ds[0].month).toBe('2026-07');
  });

  it('"tháng này năm ngoái" ⇒ cùng tháng, lùi một năm', () => {
    const ds = quetKyTrongCau('tháng này năm ngoái', ctx('2026-08'));
    expect(soKyRiengBiet(ds)).toBe(1);
    expect(ds[0].month).toBe('2025-08');
  });

  it('"tháng trước năm ngoái" ⇒ tháng-trước rồi lùi một năm', () => {
    // Đúng thứ tự người ta đọc câu: nền là "tháng trước" (2026-07), rồi mới
    // lùi năm.
    const ds = quetKyTrongCau('tháng trước năm ngoái', ctx('2026-08'));
    expect(soKyRiengBiet(ds)).toBe(1);
    expect(ds[0].month).toBe('2025-07');
  });

  it('nhận cả "năm trước", "năm rồi", "năm kia" và bản KHÔNG DẤU', () => {
    expect(resolveRelativePeriod('tháng 6 năm trước', ctx('2026-08'))?.month).toBe('2025-06');
    expect(resolveRelativePeriod('tháng 6 năm rồi', ctx('2026-08'))?.month).toBe('2025-06');
    expect(resolveRelativePeriod('tháng 6 năm kia', ctx('2026-08'))?.month).toBe('2024-06');
    expect(resolveRelativePeriod('thang 6 nam ngoai', ctx('2026-08'))?.month).toBe('2025-06');
    expect(resolveRelativePeriod('thang truoc nam ngoai', ctx('2026-08'))?.month).toBe('2025-07');
  });

  it('năm viết bằng SỐ vẫn thắng, và luật "nghiêng về quá khứ" chỉ dùng khi không nêu năm', () => {
    expect(resolveRelativePeriod('tháng 6 năm 2024', ctx('2026-08'))?.month).toBe('2024-06');
    // Không nêu năm, tháng đã qua ⇒ năm hiện tại.
    expect(resolveRelativePeriod('tháng 6', ctx('2026-08'))?.month).toBe('2026-06');
    // Không nêu năm, tháng CHƯA tới ⇒ năm trước.
    expect(resolveRelativePeriod('tháng 12', ctx('2026-02'))?.month).toBe('2025-12');
    // Nhưng nêu "năm nay" thì tháng chưa tới VẪN là năm nay.
    expect(resolveRelativePeriod('tháng 12 năm nay', ctx('2026-02'))?.month).toBe('2026-12');
  });

  it('ĐỐI CHỨNG: "tháng 6 và năm ngoái" (có chữ "và") vẫn là HAI kỳ', () => {
    // Hậu tố năm chỉ được nuốt khi nó dính LIỀN sau cụm tháng. Có "và" xen vào
    // thì người dùng thật sự đang hỏi hai kỳ.
    const ds = quetKyTrongCau('doanh thu tháng 6 và năm ngoái', ctx('2026-08'));
    expect(soKyRiengBiet(ds)).toBe(2);
    expect(ds.map((k) => k.nhan)).toEqual(['tháng 06/2026', 'năm 2025']);
  });
});

describe('"tuần này và tuần trước" là hai kỳ', () => {
  const banKhoang = { bao_cao_thu_chi_theo_ngay: { ky: 'ky', tu: 'tu', den: 'den' } };

  it('quét ra đúng hai tuần liền nhau', () => {
    const ds = quetKyTrongCau('so sánh thu chi tuần này và tuần trước', ctx('2026-08', '2026-08-15'));
    expect(soKyRiengBiet(ds)).toBe(2);
    expect(ds[0].startDate).toBe('2026-08-10');
    expect(ds[0].endDate).toBe('2026-08-16');
    expect(ds[1].startDate).toBe('2026-08-03');
    expect(ds[1].endDate).toBe('2026-08-09');
  });

  it('nhiều kỳ ⇒ GIỮ khoảng mô hình tự điền, chỉ kèm ghi chú', () => {
    const ky = resolveRelativePeriod('tuần này và tuần trước', ctx('2026-08', '2026-08-15'));
    const ra = apDungKyTuongDoi(
      'bao_cao_thu_chi_theo_ngay',
      { tu: '2026-08-03', den: '2026-08-09' },
      ky,
      banKhoang,
      true,
    );
    expect(ra.args.tu).toBe('2026-08-03');
    expect(ra.args.den).toBe('2026-08-09');
    expect(ra.kyBiThayThe).toBeNull();
    expect(ra.ghiChu).toMatch(/nhi[eề]u k[yỳ]/i);
  });

  it('nhiều kỳ nhưng mô hình BỎ TRỐNG ⇒ vẫn lấp bằng kỳ đầu (tuần này)', () => {
    const ky = resolveRelativePeriod('tuần này và tuần trước', ctx('2026-08', '2026-08-15'));
    const ra = apDungKyTuongDoi('bao_cao_thu_chi_theo_ngay', {}, ky, banKhoang, true);
    expect(ra.args.tu).toBe('2026-08-10');
    expect(ra.args.den).toBe('2026-08-16');
    expect(ra.ghiChu).not.toBeNull();
  });
});
