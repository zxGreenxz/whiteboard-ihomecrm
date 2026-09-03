// Số học của thanh hạn mức token. Nhánh đắt nhất là `cap = 0`: theo quy ước của
// `reserve_ai_usage` nó nghĩa là TẮT hạn mức, nhưng phép chia ngây thơ cho ra
// Infinity → thanh đỏ 100% → quản trị tưởng sắp chết đúng lúc họ vừa tắt rào.
import { describe, expect, it } from 'vitest';
import {
  GIA_QUY_UOC_SELF_HOSTED_USD_PER_TOKEN,
  MUC_CANH_BAO_PHAN_TRAM,
  chiPhiQuyUocSelfHosted,
  daChamNguongCanhBao,
  mocDauNgayVN,
  tapModelSelfHosted,
  tinhPhanTramHanMuc,
  tomTatTokenHomNay,
} from '../admin/hanMucToken';

describe('tinhPhanTramHanMuc', () => {
  it('chia đúng và làm tròn tới một chữ số thập phân', () => {
    expect(tinhPhanTramHanMuc(150_000, 300_000)).toBe(50);
    expect(tinhPhanTramHanMuc(1, 3)).toBe(33.3);
    expect(tinhPhanTramHanMuc(0, 300_000)).toBe(0);
  });

  it('cap <= 0 là TẮT hạn mức → null, KHÔNG phải 0%', () => {
    // 0% nói "còn nguyên hạn mức"; sự thật là "không có hạn mức nào". Hai câu
    // khác nhau, và chỗ vẽ cần phân biệt để không bôi màu cảnh báo.
    expect(tinhPhanTramHanMuc(999_999, 0)).toBeNull();
    expect(tinhPhanTramHanMuc(10, -5)).toBeNull();
  });

  it('KHÔNG kẹp trên 100 — vượt trần là con số có thật', () => {
    // Dòng `pending` đang bay vẫn chạy nốt sau khi cửa đã đóng, nên >100% xảy ra
    // thật. Giấu nó đi là giấu đúng lúc cần nhìn.
    expect(tinhPhanTramHanMuc(360_000, 300_000)).toBe(120);
  });

  it('số âm coi như 0, không đẻ ra phần trăm âm', () => {
    expect(tinhPhanTramHanMuc(-10, 100)).toBe(0);
  });

  it('đầu vào không phải số hữu hạn → null', () => {
    for (const rac of [NaN, Infinity, -Infinity, null, undefined, '100', {}]) {
      expect(tinhPhanTramHanMuc(rac, 100), `daDung = ${String(rac)}`).toBeNull();
      expect(tinhPhanTramHanMuc(100, rac), `cap = ${String(rac)}`).toBeNull();
    }
  });
});

describe('daChamNguongCanhBao', () => {
  it('ngưỡng là 80% và tính CẢ mốc 80', () => {
    expect(MUC_CANH_BAO_PHAN_TRAM).toBe(80);
    expect(daChamNguongCanhBao(79.9)).toBe(false);
    expect(daChamNguongCanhBao(80)).toBe(true);
    expect(daChamNguongCanhBao(250)).toBe(true);
  });

  it('hạn mức TẮT (null) không bao giờ là cảnh báo', () => {
    expect(daChamNguongCanhBao(null)).toBe(false);
  });
});

describe('chiPhiQuyUocSelfHosted', () => {
  it('đúng đơn giá quy ước 0.000002 USD/token', () => {
    expect(GIA_QUY_UOC_SELF_HOSTED_USD_PER_TOKEN).toBe(0.000002);
    expect(chiPhiQuyUocSelfHosted(1_000_000)).toBeCloseTo(2, 10);
    expect(chiPhiQuyUocSelfHosted(0)).toBe(0);
  });

  it('token rác/âm → null, không hiện $0.00000 như một sự thật', () => {
    for (const rac of [NaN, Infinity, -1, null, undefined, 'x']) {
      expect(chiPhiQuyUocSelfHosted(rac), `tokens = ${String(rac)}`).toBeNull();
    }
  });
});

describe('mocDauNgayVN', () => {
  it('nửa đêm giờ VN, không phải nửa đêm giờ máy', () => {
    // 09:00 VN ngày 03/09 = 02:00Z ngày 03/09 → mốc là 17:00Z ngày 02/09.
    expect(mocDauNgayVN(new Date('2026-09-03T02:00:00.000Z'))).toBe('2026-09-02T17:00:00.000Z');
  });

  it('23:59:59 giờ VN vẫn thuộc ngày VN đó', () => {
    // Đây là chỗ giờ máy và giờ VN nói hai ngày khác nhau: 16:59Z là "hôm qua"
    // theo UTC nhưng vẫn là "hôm nay" theo sổ mà reserve_ai_usage đang đọc.
    expect(mocDauNgayVN(new Date('2026-09-02T16:59:59.000Z'))).toBe('2026-09-01T17:00:00.000Z');
  });

  it('đúng khoảnh khắc nửa đêm VN thì mốc là chính nó', () => {
    expect(mocDauNgayVN(new Date('2026-09-02T17:00:00.000Z'))).toBe('2026-09-02T17:00:00.000Z');
  });

  it('qua biên tháng vẫn đúng', () => {
    expect(mocDauNgayVN(new Date('2026-09-01T00:30:00.000Z'))).toBe('2026-08-31T17:00:00.000Z');
  });
});

describe('tomTatTokenHomNay', () => {
  const TOI = 'u-toi';
  const CHU = 'u-chu';
  const rows = [
    { user_id: TOI, owner_id: CHU, total_tokens: 100 },
    { user_id: TOI, owner_id: CHU, total_tokens: 50 },
    { user_id: 'u-ban', owner_id: CHU, total_tokens: 400 },
    { user_id: 'u-la', owner_id: 'u-chu-khac', total_tokens: 9_000 },
  ];

  it('cộng riêng trục user và trục owner', () => {
    const t = tomTatTokenHomNay(rows, TOI);
    expect(t.cuaToi).toBe(150);
    expect(t.cuaTenant).toBe(550); // 100 + 50 + 400, KHÔNG gồm tenant khác
    expect(t.ownerId).toBe(CHU);
  });

  it('suy chủ tenant từ chính dòng của mình, không đoán', () => {
    // Nhân viên không biết ai là chủ mình; database đã ghi vào owner_id rồi.
    expect(tomTatTokenHomNay(rows, TOI).ownerId).toBe(CHU);
    expect(tomTatTokenHomNay(rows, 'u-la').ownerId).toBe('u-chu-khac');
  });

  it('đánh dấu số tenant là CHƯA ĐẦY ĐỦ khi người xem chỉ là nhân viên', () => {
    // RLS cho `user_id = tôi OR owner_id = tôi`: nhân viên không thấy dòng của
    // đồng nghiệp, nên con số tenant thấp hơn sự thật. Hiện nó mà không nói rõ
    // là mời quản trị kết luận sai.
    expect(tomTatTokenHomNay(rows, TOI).tenantDayDu).toBe(false);
    // Chủ tenant tự gọi Copilot thì dòng của chính họ có owner_id = chính họ.
    const coDongCuaChu = [...rows, { user_id: CHU, owner_id: CHU, total_tokens: 1 }];
    expect(tomTatTokenHomNay(coDongCuaChu, CHU).tenantDayDu).toBe(true);
    // Super admin thấy hết nên số luôn đầy đủ, dù họ là "nhân viên" của ai đó.
    expect(tomTatTokenHomNay(rows, TOI, true).tenantDayDu).toBe(true);
  });

  it('chưa gọi lượt nào hôm nay: 0 và ownerId null, không nổ', () => {
    const t = tomTatTokenHomNay([], TOI);
    expect(t).toEqual({
      cuaToi: 0,
      cuaTenant: 0,
      ownerId: null,
      tenantDayDu: false,
      laToanHeThong: false,
    });
  });

  it('CHỦ TENANT chưa chat hôm nay vẫn thấy tổng của đội (F1)', () => {
    // Ca hỏng của bản đầu: chủ không có dòng nào `user_id = mình`, nên ownerId
    // rơi về null và tổng ra 0 — thanh xanh 0%, badge không đỏ, trong khi RLS
    // vừa trả về đủ dòng của cả đội. Đúng người cần cảnh báo nhất là người không
    // nhận được nó.
    const doiCuaChu = [
      { user_id: 'nv-1', owner_id: CHU, total_tokens: 200_000 },
      { user_id: 'nv-2', owner_id: CHU, total_tokens: 90_000 },
      { user_id: 'u-la', owner_id: 'u-chu-khac', total_tokens: 9_000 },
    ];
    const t = tomTatTokenHomNay(doiCuaChu, CHU);
    expect(t.cuaToi).toBe(0); // đúng: chủ chưa tiêu token nào hôm nay
    expect(t.ownerId).toBe(CHU); // suy từ chính quyền đọc, không phải phỏng đoán
    expect(t.cuaTenant).toBe(290_000); // KHÔNG gồm tenant khác
    expect(t.tenantDayDu).toBe(true);
    expect(t.laToanHeThong).toBe(false);
    // …và badge phải nổ ở mốc 80%.
    expect(daChamNguongCanhBao(tinhPhanTramHanMuc(t.cuaTenant, 300_000))).toBe(true);
  });

  it('SUPER ADMIN chưa chat hôm nay: cộng mọi dòng nhìn thấy, và NÓI RÕ đó là toàn hệ thống (F2)', () => {
    // Super admin thấy hết nhờ RLS. Trả 0 rồi vẫn gắn cờ "đầy đủ" là trình bày
    // một số 0 GIẢ như sự thật có thẩm quyền — tệ hơn hẳn một con số rộng hơn
    // cần thiết nhưng có nhãn nói đúng phạm vi.
    const moiDong = [
      { user_id: 'nv-1', owner_id: CHU, total_tokens: 200_000 },
      { user_id: 'u-la', owner_id: 'u-chu-khac', total_tokens: 50_000 },
    ];
    const t = tomTatTokenHomNay(moiDong, 'sa-khong-co-dong', true);
    expect(t.cuaToi).toBe(0);
    expect(t.ownerId).toBeNull();
    expect(t.cuaTenant).toBe(250_000);
    expect(t.tenantDayDu).toBe(true);
    expect(t.laToanHeThong).toBe(true); // chỗ vẽ PHẢI đổi nhãn theo cờ này
    expect(daChamNguongCanhBao(tinhPhanTramHanMuc(t.cuaTenant, 300_000))).toBe(true);
  });

  it('super admin CÓ dòng của mình thì vẫn bó về đúng tenant của họ', () => {
    // Có đường suy chủ thì dùng đường đó — không nới ra toàn hệ thống chỉ vì
    // người xem tình cờ là super admin.
    const t = tomTatTokenHomNay(rows, TOI, true);
    expect(t.ownerId).toBe(CHU);
    expect(t.cuaTenant).toBe(550); // KHÔNG cộng 9_000 của tenant khác
    expect(t.laToanHeThong).toBe(false);
  });

  it('nhân viên thường KHÔNG bao giờ được nới ra toàn hệ thống', () => {
    // Cờ toàn-hệ-thống chỉ mở cho super admin; nhân viên không suy được chủ thì
    // tổng tenant phải là 0 kèm tenantDayDu = false, không phải tổng của người lạ.
    const t = tomTatTokenHomNay(
      [{ user_id: 'nguoi-la', owner_id: 'chu-la', total_tokens: 500 }],
      'toi-khong-co-dong',
    );
    expect(t.cuaTenant).toBe(0);
    expect(t.laToanHeThong).toBe(false);
    expect(t.tenantDayDu).toBe(false);
  });

  it('total_tokens null/âm coi như 0', () => {
    const t = tomTatTokenHomNay(
      [
        { user_id: TOI, owner_id: TOI, total_tokens: null },
        { user_id: TOI, owner_id: TOI, total_tokens: -5 },
        { user_id: TOI, owner_id: TOI, total_tokens: 7 },
      ],
      TOI,
    );
    expect(t.cuaToi).toBe(7);
  });

  it('chưa đăng nhập (uid null) trả 0 sạch', () => {
    expect(tomTatTokenHomNay(rows, null).cuaToi).toBe(0);
  });
});

describe('tapModelSelfHosted', () => {
  it('đọc pricing_mode từ dữ liệu, không đoán theo tên provider', () => {
    const tap = tapModelSelfHosted([
      { provider: '9router', models: [{ id: 'cx/gpt-5.6-sol', pricing_mode: 'self_hosted' }] },
      { provider: 'openrouter', models: [{ id: 'nvidia/nemotron', pricing_mode: 'free' }] },
    ]);
    expect(tap.has('9router:cx/gpt-5.6-sol')).toBe(true);
    expect(tap.has('openrouter:nvidia/nemotron')).toBe(false);
  });

  it('models rác (không phải mảng / phần tử không phải object) không làm vỡ', () => {
    const tap = tapModelSelfHosted([
      { provider: 'x', models: null },
      { provider: 'y', models: 'khong-phai-mang' },
      { provider: 'z', models: [null, 42, { pricing_mode: 'self_hosted' }] },
    ]);
    expect(tap.size).toBe(0);
  });
});
