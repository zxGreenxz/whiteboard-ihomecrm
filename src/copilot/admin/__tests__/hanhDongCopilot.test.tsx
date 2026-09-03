// Tab "Hành động" của trang quản trị: lớp dữ liệu + hai bảng render.
//
// BA THỨ ĐƯỢC ĐO, và vì sao từng thứ đáng đo
//   1. `supabase.rpc` KHÔNG NÉM. Lỗi về dưới dạng `{ error }` trong một promise
//      đã fulfil, nên mock ở đây dùng `mockResolvedValue({ data: null, error })`
//      — `mockRejectedValue` sẽ đo một thế giới không tồn tại và cho màu xanh
//      giả cho một nhánh `catch` không bao giờ chạy.
//   2. Chuẩn hoá dữ liệu. Server trả nguyên bộ cột của bảng sổ; giao diện phải
//      sống được khi bảng đó NỞ THÊM cột (G3/G5) và khi một dòng hỏng.
//   3. Câu lỗi. `copilot_policy_stale_revision` là mã SQLSTATE 40001 — người
//      vận hành cần đọc "ai đó vừa đổi, tải lại", không phải mã lỗi.
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));

const {
  chuanHoaChinhSach,
  chuanHoaDongSo,
  chuanHoaSo,
  dienGiaiLoiChinhSach,
  dinhDangThoiGian,
  docChinhSachHanhDong,
  docSoHanhDong,
  doiChinhSachHanhDong,
  nhanSuKien,
  locSuKienKeHoach,
} = await import('../hanhDongCopilot');
const {
  BangKeHoachGanDay,
  BangNhatKyHanhDong,
  TheChinhSachHanhDong,
  TheStepUpPin,
  TheUyQuyenDung,
  dienGiaiLoiPin,
} = await import('../HanhDongTab');

const ORG = 'aaaa0000-0000-4000-8000-000000000001';

const DONG_SO = {
  id: '11111111-1111-4111-8111-111111111111',
  created_at: '2026-09-03T04:39:56.000Z',
  event: 'action_gate_denied',
  action_id: 'income_expense.create_draft',
  user_id: '22222222-2222-4222-8222-222222222222',
  error_code: 'copilot_action_flag_disabled',
  entity_table: 'income_expenses',
  entity_id: '33333333-3333-4333-8333-333333333333',
  // Cột server có thêm mà giao diện chưa biết — không được làm vỡ gì.
  cot_moi_cua_g3: { a: 1 },
};

beforeEach(() => {
  rpc.mockReset();
});

describe('đọc sổ hành động', () => {
  it('gọi đúng RPC với công ty và trần dòng', async () => {
    rpc.mockResolvedValue({ data: [DONG_SO], error: null });
    const dong = await docSoHanhDong(ORG);
    expect(rpc).toHaveBeenCalledWith('copilot_action_ledger_list_v1', {
      p_organization_id: ORG,
      p_limit: 50,
    });
    expect(dong).toHaveLength(1);
    expect(dong[0].actionId).toBe('income_expense.create_draft');
    expect(dong[0].errorCode).toBe('copilot_action_flag_disabled');
  });

  it('chưa chọn công ty ⇒ KHÔNG gọi RPC (sổ có phạm vi công ty)', async () => {
    expect(await docSoHanhDong(null)).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('lỗi RPC về dưới dạng { error } — hàm phải ném để React Query thấy', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'unauthenticated' } });
    await expect(docSoHanhDong(ORG)).rejects.toThrow(/unauthenticated/);
  });

  it('dòng hỏng bị bỏ, dòng lành vẫn về — một bản ghi rác không giết cả bảng', () => {
    expect(chuanHoaSo([DONG_SO, { id: 'thieu-event' }, null, 'rac'])).toHaveLength(1);
    expect(chuanHoaSo('khong-phai-mang')).toEqual([]);
    expect(chuanHoaDongSo({ id: 'x', event: 'y' })).toEqual({
      id: 'x',
      createdAt: null,
      event: 'y',
      actionId: null,
      userId: null,
      errorCode: null,
      entityTable: null,
      entityId: null,
      // G3 nới bảng sổ thêm ba cột; dòng cũ không có chúng vẫn phải đọc được.
      planId: null,
      stepNo: null,
      planVersion: null,
    });
  });
});

describe('chính sách hành động', () => {
  it('đọc và chuẩn hoá payload của get_copilot_action_policy_v1', async () => {
    rpc.mockResolvedValue({
      data: {
        revision: 3,
        max_direct_risk: 'L4',
        allowed_roles: ['superadmin'],
        standing_grants_enabled: false,
      },
      error: null,
    });
    const cs = await docChinhSachHanhDong();
    expect(rpc).toHaveBeenCalledWith('get_copilot_action_policy_v1');
    expect(cs).toEqual({
      revision: 3,
      maxDirectRisk: 'L4',
      allowedRoles: ['superadmin'],
      standingGrantsEnabled: false,
    });
  });

  it('payload dị dạng ⇒ null, KHÔNG đoán một giá trị mặc định', () => {
    expect(chuanHoaChinhSach(null)).toBeNull();
    expect(chuanHoaChinhSach({ revision: 0, max_direct_risk: 'L4', allowed_roles: ['owner'] })).toBeNull();
    expect(chuanHoaChinhSach({ revision: 1, max_direct_risk: 'L9', allowed_roles: ['owner'] })).toBeNull();
    expect(chuanHoaChinhSach({ revision: 1, max_direct_risk: 'L4', allowed_roles: [] })).toBeNull();
  });

  it('đổi chính sách gửi CAS revision + lý do + bằng chứng, KHÔNG gửi standing grant', async () => {
    rpc.mockResolvedValue({
      data: {
        revision: 4,
        max_direct_risk: 'L3',
        allowed_roles: ['superadmin', 'owner'],
        standing_grants_enabled: false,
      },
      error: null,
    });
    await doiChinhSachHanhDong({
      expectedRevision: 3,
      maxDirectRisk: 'L3',
      allowedRoles: ['superadmin', 'owner'],
      reason: 'thu hep tran rui ro trong su co',
      evidenceLink: 'ticket:OPS-12',
    });
    const [ten, args] = rpc.mock.calls[0];
    expect(ten).toBe('set_copilot_action_policy_v1');
    expect(args).toEqual({
      p_expected_revision: 3,
      p_max_direct_risk: 'L3',
      p_allowed_roles: ['superadmin', 'owner'],
      p_reason: 'thu hep tran rui ro trong su co',
      p_evidence_link: 'ticket:OPS-12',
    });
    expect(Object.keys(args)).not.toContain('p_standing_grants_enabled');
  });

  it('CAS thua ⇒ câu tiếng Việt nói rõ phải tải lại', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'copilot_policy_stale_revision: dang o revision 5, nguoi goi mong 3' },
    });
    await expect(
      doiChinhSachHanhDong({
        expectedRevision: 3,
        reason: 'x',
        evidenceLink: 'y',
      }),
    ).rejects.toThrow(/copilot_policy_stale_revision/);
    expect(dienGiaiLoiChinhSach(new Error('copilot_policy_stale_revision: ...'))).toContain(
      'tải lại',
    );
  });

  it('mỗi mã lỗi của RPC có một câu riêng — không rơi hết vào câu chung', () => {
    expect(dienGiaiLoiChinhSach(new Error('policy_reason_required'))).toContain('bằng chứng');
    expect(dienGiaiLoiChinhSach(new Error('copilot_policy_not_permitted'))).toContain('super admin');
    expect(dienGiaiLoiChinhSach(new Error('copilot_policy_risk_invalid'))).toContain('L3');
    expect(dienGiaiLoiChinhSach(new Error('copilot_policy_roles_invalid'))).toContain('vai');
    expect(dienGiaiLoiChinhSach(new Error('copilot_policy_missing'))).toContain('migration');
    expect(dienGiaiLoiChinhSach(new Error('bung bét'))).toContain('bung bét');
  });
});

describe('render', () => {
  it('bảng sổ hiện thời gian, nhãn sự kiện, action_id và mã lỗi', () => {
    const html = renderToStaticMarkup(
      <BangNhatKyHanhDong dong={chuanHoaSo([DONG_SO])} />,
    );
    expect(html).toContain('income_expense.create_draft');
    expect(html).toContain('copilot_action_flag_disabled');
    expect(html).toContain(nhanSuKien('action_gate_denied'));
    expect(html).toContain(dinhDangThoiGian(DONG_SO.created_at));
    expect(html).toContain('income_expenses');
  });

  it('sổ rỗng nói rõ là rỗng, không để một cái bảng trắng', () => {
    const html = renderToStaticMarkup(<BangNhatKyHanhDong dong={[]} />);
    expect(html).toContain('Chưa có dòng nào');
  });

  it('thẻ chính sách hiện revision, trần rủi ro, vai; standing grant KHOÁ ở Mức 3', () => {
    const html = renderToStaticMarkup(
      <TheChinhSachHanhDong
        chinhSach={{
          revision: 7,
          maxDirectRisk: 'L4',
          allowedRoles: ['superadmin'],
          standingGrantsEnabled: false,
        }}
        dangTai={false}
        ruiRo="L4"
        vai={['superadmin']}
        lyDo=""
        bangChung=""
        dangLuu={false}
        onDoiRuiRo={() => {}}
        onDoiVai={() => {}}
        onDoiLyDo={() => {}}
        onDoiBangChung={() => {}}
        onLuu={() => {}}
      />,
    );
    expect(html).toContain('>7<');
    expect(html).toContain('Mức 3');
    expect(html).toMatch(/type="checkbox"[^>]*disabled/);
    // Thiếu lý do/bằng chứng ⇒ nút đổi phải KHOÁ: RPC sẽ từ chối bằng
    // `policy_reason_required`, và một cái nút bấm được rồi báo lỗi là cách tệ
    // nhất để dạy người dùng luật đó.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Đổi chính sách<\/button>/);
  });

  it('không đọc được chính sách ⇒ nói BLOCKED, không hiện giá trị đoán', () => {
    const html = renderToStaticMarkup(
      <TheChinhSachHanhDong
        chinhSach={null}
        dangTai={false}
        ruiRo=""
        vai={[]}
        lyDo="a"
        bangChung="b"
        dangLuu={false}
        onDoiRuiRo={() => {}}
        onDoiVai={() => {}}
        onDoiLyDo={() => {}}
        onDoiBangChung={() => {}}
        onLuu={() => {}}
      />,
    );
    expect(html).toContain('BLOCKED');
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});


// ── G3: mục "Kế hoạch gần đây" ───────────────────────────────────────────────
//
// Cùng một cái sổ, lọc lấy bảy sự kiện của đường kế hoạch. Hai điều được đo:
// nhãn (mã trần `step_blocked` là thứ người trực sự cố phải dịch trong đầu), và
// PHÉP LỌC (lọc theo danh sách tên, không theo tiền tố — một tiền tố sẽ nuốt
// mọi sự kiện tương lai có tên bắt đầu như thế).
const DONG_KE_HOACH = [
  { ...DONG_SO, id: 'p1', event: 'plan_created', plan_id: '99999999-9999-4999-8999-999999999999', step_no: null, error_code: null },
  { ...DONG_SO, id: 'p2', event: 'step_failed', plan_id: '99999999-9999-4999-8999-999999999999', step_no: 2, error_code: 'step_failed' },
  { ...DONG_SO, id: 'p3', event: 'action_executed' },
  { ...DONG_SO, id: 'p4', event: 'plan_step_tuong_lai_cua_ai_do' },
];

describe('sổ kế hoạch', () => {
  it('chuẩn hoá đọc thêm plan_id / step_no và KHÔNG biến null thành 0', () => {
    const d = chuanHoaDongSo(DONG_KE_HOACH[0])!;
    expect(d.planId).toBe('99999999-9999-4999-8999-999999999999');
    expect(d.stepNo).toBeNull();
    expect(chuanHoaDongSo(DONG_KE_HOACH[1])!.stepNo).toBe(2);
  });

  it('lọc theo DANH SÁCH TÊN, không theo tiền tố', () => {
    const cua = locSuKienKeHoach(chuanHoaSo(DONG_KE_HOACH));
    expect(cua.map((d) => d.id)).toEqual(['p1', 'p2']);
  });

  it('bảy sự kiện kế hoạch có nhãn tiếng Việt, không hiện mã trần', () => {
    for (const ma of ['plan_created', 'plan_approved', 'step_done', 'step_failed', 'step_blocked', 'plan_cancelled', 'plan_expired']) {
      expect(nhanSuKien(ma), ma).not.toBe(ma);
    }
  });

  it('bảng vẽ được và nối các dòng cùng một kế hoạch bằng 8 ký tự đầu', () => {
    const html = renderToStaticMarkup(
      <BangKeHoachGanDay dong={chuanHoaSo(DONG_KE_HOACH)} />,
    );
    expect(html).toContain('copilot-admin-plan-table');
    expect(html).toContain('99999999');
    expect(html).toContain('bước 2');
    expect(html).toContain('Bước hỏng');
    // Dòng không thuộc đường kế hoạch không được lọt vào bảng này.
    expect(html).not.toContain('Đã thực thi');
  });

  it('sổ rỗng nói rõ là rỗng, không vẽ một bảng trắng', () => {
    expect(renderToStaticMarkup(<BangKeHoachGanDay dong={[]} />)).toContain('Chưa có kế hoạch nào');
  });
});

describe('dienGiaiLoiPin', () => {
  it('reauth_failed là mã cục bộ của thẻ này, không phải mã server', () => {
    expect(dienGiaiLoiPin(new Error('reauth_failed'))).toContain('Mật khẩu không đúng');
  });

  it('mọi mã PIN khác nhường cho dienGiaiLoiKeHoach', () => {
    expect(dienGiaiLoiPin(new Error('pin_weak'))).toContain('dễ đoán');
    expect(dienGiaiLoiPin(new Error('pin_format'))).toContain('4 chữ số');
  });
});

describe('TheStepUpPin — render thuần', () => {
  const props = {
    trangThai: null,
    dangTaiTrangThai: false,
    pinHienTai: '',
    pinMoi: '',
    matKhau: '',
    dangDatPin: false,
    onDoiPinHienTai: () => {},
    onDoiPinMoi: () => {},
    onDoiMatKhau: () => {},
    onDatPin: () => {},
    laSuperAdmin: false,
    moKhoaUserId: '',
    moKhoaLyDo: '',
    dangMoKhoa: false,
    onDoiMoKhoaUserId: () => {},
    onDoiMoKhoaLyDo: () => {},
    onMoKhoa: () => {},
  };

  it('vẽ thẻ với testid gốc + ô PIN mới + ô mật khẩu re-auth', () => {
    const html = renderToStaticMarkup(<TheStepUpPin {...props} />);
    expect(html).toContain('copilot-admin-pin-card');
    expect(html).toContain('copilot-admin-pin-new');
    expect(html).toContain('copilot-admin-pin-password');
    expect(html).toContain('copilot-admin-pin-submit');
  });

  it('CHƯA đặt PIN: không hiện ô "PIN hiện tại", nút hiện chữ "Đặt PIN"', () => {
    const html = renderToStaticMarkup(
      <TheStepUpPin {...props} trangThai={{ daDat: false, lockedUntil: null, failedAttempts: 0 }} />,
    );
    expect(html).not.toContain('copilot-admin-pin-current');
    expect(html).toContain('Đặt PIN');
  });

  it('ĐÃ đặt PIN: hiện ô "PIN hiện tại", nút đổi chữ thành "Đổi PIN"', () => {
    const html = renderToStaticMarkup(
      <TheStepUpPin {...props} trangThai={{ daDat: true, lockedUntil: null, failedAttempts: 0 }} />,
    );
    expect(html).toContain('copilot-admin-pin-current');
    expect(html).toContain('Đổi PIN');
  });

  it('đang khoá: hiện mốc hết khoá, KHÔNG hiện dòng "lần sai chưa reset"', () => {
    const han = new Date(Date.now() + 5 * 60_000).toISOString();
    const html = renderToStaticMarkup(
      <TheStepUpPin {...props} trangThai={{ daDat: true, lockedUntil: han, failedAttempts: 0 }} />,
    );
    expect(html).toContain('Đang khoá tới');
    expect(html).not.toContain('lần sai gần nhất');
  });

  it('không phải super admin ⇒ KHÔNG vẽ cụm mở khoá người khác', () => {
    const html = renderToStaticMarkup(<TheStepUpPin {...props} laSuperAdmin={false} />);
    expect(html).not.toContain('copilot-admin-pin-unlock-submit');
  });

  it('super admin ⇒ vẽ cụm mở khoá với ô mã người dùng + lý do', () => {
    const html = renderToStaticMarkup(<TheStepUpPin {...props} laSuperAdmin />);
    expect(html).toContain('copilot-admin-pin-unlock-userid');
    expect(html).toContain('copilot-admin-pin-unlock-reason');
    expect(html).toContain('copilot-admin-pin-unlock-submit');
  });

  it('KHÔNG chuỗi PIN/mật khẩu nào rò vào HTML (chỉ value do props điều khiển)', () => {
    const html = renderToStaticMarkup(
      <TheStepUpPin
        {...props}
        trangThai={{ daDat: true, lockedUntil: null, failedAttempts: 0 }}
        pinHienTai="1357"
        pinMoi="2468"
        matKhau="mat-khau-bi-mat-xyz"
      />,
    );
    // Giá trị THẬT vẫn phải xuất hiện trong `value=` (đây là input có kiểm
    // soát bình thường) — điều cấm là PIN/mật khẩu KHÔNG được lộ ở NGOÀI thuộc
    // tính `value` của đúng ô của nó (ví dụ trong text hiển thị hay testid).
    expect(html).toContain('value="1357"');
    expect(html).toContain('value="2468"');
    expect(html).toContain('value="mat-khau-bi-mat-xyz"');
    const ngoaiValue = html.replace(/value="[^"]*"/g, '');
    expect(ngoaiValue).not.toContain('1357');
    expect(ngoaiValue).not.toContain('2468');
    expect(ngoaiValue).not.toContain('mat-khau-bi-mat-xyz');
  });
});

// G5-B — điểm nối #4: thẻ "Uỷ quyền đứng" trong trang quản trị. Ba thứ đáng
// đo giống hệt các thẻ khác của trang này: (a) thẻ THUẦN, mọi trạng thái động
// đi qua props; (b) nút "Cấp hạn mức" khoá khi thiếu dữ liệu bắt buộc (hành
// động/hạn mức/giờ hết hạn/lý do); (c) nút "Thu hồi tất cả" — kill switch —
// đòi lý do RIÊNG, dài hơn (≥10 ký tự), và khoá khi không còn hạn mức nào
// sống để thu hồi.
describe('TheUyQuyenDung — render thuần', () => {
  const GRANT_A = 'ffff0000-0000-4000-8000-000000000001';
  const GRANT_B = 'ffff0000-0000-4000-8000-000000000002';

  const props = {
    danhSach: [],
    dangTaiDs: false,
    danhSachHanhDong: [{ actionId: 'income_expense.create_draft', labelVi: 'Tạo phiếu thu/chi nháp' }],
    actionId: '',
    maxPerDay: '1',
    gioHetHan: '24',
    maxAmount: '',
    toaNha: '',
    lyDoTao: '',
    dangTao: false,
    onDoiActionId: () => {},
    onDoiMaxPerDay: () => {},
    onDoiGioHetHan: () => {},
    onDoiMaxAmount: () => {},
    onDoiToaNha: () => {},
    onDoiLyDoTao: () => {},
    onTao: () => {},
    lyDoThuHoi: '',
    onDoiLyDoThuHoi: () => {},
    dangThuHoiId: null,
    onThuHoi: () => {},
    lyDoThuHoiTatCa: '',
    onDoiLyDoThuHoiTatCa: () => {},
    dangThuHoiTatCa: false,
    onThuHoiTatCa: () => {},
    baoCao: null,
    dangTaiBaoCao: false,
    coToChuc: true,
  };

  it('chưa chọn công ty ⇒ chỉ hiện lời nhắc, không hiện form/nút nào', () => {
    const html = renderToStaticMarkup(<TheUyQuyenDung {...props} coToChuc={false} />);
    expect(html).toContain('copilot-admin-grant-card');
    expect(html).not.toContain('copilot-admin-grant-submit');
    expect(html).not.toContain('copilot-admin-grant-action');
  });

  it('vẽ đủ form tạo + nút bị KHOÁ khi chưa đủ dữ liệu bắt buộc', () => {
    const html = renderToStaticMarkup(<TheUyQuyenDung {...props} />);
    expect(html).toContain('copilot-admin-grant-action');
    expect(html).toContain('copilot-admin-grant-max-per-day');
    expect(html).toContain('copilot-admin-grant-expires-hours');
    expect(html).toContain('copilot-admin-grant-max-amount');
    expect(html).toContain('copilot-admin-grant-buildings');
    expect(html).toContain('copilot-admin-grant-reason');
    // Nút "Cấp hạn mức" disabled khi actionId/lyDoTao còn rỗng.
    const nut = html.match(/<button[^>]*copilot-admin-grant-submit[^>]*>/)?.[0] ?? '';
    expect(nut).toContain('disabled=""');
  });

  it('đủ dữ liệu bắt buộc ⇒ nút "Cấp hạn mức" KHÔNG bị khoá', () => {
    const html = renderToStaticMarkup(
      <TheUyQuyenDung
        {...props}
        actionId="income_expense.create_draft"
        maxPerDay="5"
        gioHetHan="24"
        lyDoTao="Pilot quý 4"
      />,
    );
    const nut = html.match(/<button[^>]*copilot-admin-grant-submit[^>]*>/)?.[0] ?? '';
    expect(nut).not.toContain('disabled=""');
    expect(html).toContain('Cấp hạn mức (cần PIN)');
  });

  it('bảng danh sách trống ⇒ nói rõ "chưa có hạn mức", không phải bảng rỗng câm lặng', () => {
    const html = renderToStaticMarkup(<TheUyQuyenDung {...props} />);
    expect(html).toContain('copilot-admin-grant-table');
    expect(html).toContain('Chưa có hạn mức nào');
  });

  it('mỗi hạn mức CÒN hiệu lực có nút Thu hồi; đã thu hồi thì KHÔNG có nút', () => {
    const html = renderToStaticMarkup(
      <TheUyQuyenDung
        {...props}
        lyDoThuHoi="dọn dẹp"
        danhSach={[
          {
            grantId: GRANT_A,
            actionId: 'income_expense.create_draft',
            labelVi: 'Tạo phiếu thu/chi nháp',
            constraints: {},
            maxPerDay: 5,
            usedToday: 1,
            usedOn: '2026-09-03',
            expiresAt: '2026-10-01T00:00:00Z',
            revokedAt: null,
            revokedBy: null,
            reason: 'x',
            granterUserId: 'u1',
            createdAt: '2026-09-01T00:00:00Z',
          },
          {
            grantId: GRANT_B,
            actionId: 'income_expense.create_draft',
            labelVi: 'Tạo phiếu thu/chi nháp',
            constraints: {},
            maxPerDay: 5,
            usedToday: 0,
            usedOn: null,
            expiresAt: '2026-09-05T00:00:00Z',
            revokedAt: '2026-09-02T00:00:00Z',
            revokedBy: 'u2',
            reason: 'x',
            granterUserId: 'u1',
            createdAt: '2026-09-01T00:00:00Z',
          },
        ]}
      />,
    );
    expect((html.match(/data-testid="copilot-admin-grant-revoke"/g) ?? []).length).toBe(1);
    expect(html).toContain('Còn hiệu lực');
    expect(html).toContain('Đã thu hồi');
  });

  it('nút "Thu hồi" của một dòng bị khoá khi CHƯA nhập lý do thu hồi', () => {
    const html = renderToStaticMarkup(
      <TheUyQuyenDung
        {...props}
        lyDoThuHoi=""
        danhSach={[
          {
            grantId: GRANT_A,
            actionId: 'income_expense.create_draft',
            labelVi: 'x',
            constraints: {},
            maxPerDay: 5,
            usedToday: 0,
            usedOn: null,
            expiresAt: null,
            revokedAt: null,
            revokedBy: null,
            reason: 'x',
            granterUserId: null,
            createdAt: null,
          },
        ]}
      />,
    );
    const nut = html.match(/<button[^>]*copilot-admin-grant-revoke[^>]*>/)?.[0] ?? '';
    expect(nut).toContain('disabled=""');
  });

  it('kill switch "Thu hồi tất cả" khoá khi lý do < 10 ký tự HOẶC không còn hạn mức sống', () => {
    const ngan = renderToStaticMarkup(<TheUyQuyenDung {...props} lyDoThuHoiTatCa="ngan" />);
    const nutNgan = ngan.match(/<button[^>]*copilot-admin-grant-revoke-all[^>]*>/)?.[0] ?? '';
    expect(nutNgan).toContain('disabled=""');

    const khongConGrant = renderToStaticMarkup(
      <TheUyQuyenDung {...props} lyDoThuHoiTatCa="Lý do đủ dài để thu hồi tất cả" danhSach={[]} />,
    );
    const nutKhongCon = khongConGrant.match(/<button[^>]*copilot-admin-grant-revoke-all[^>]*>/)?.[0] ?? '';
    expect(nutKhongCon).toContain('disabled=""');
  });

  it('kill switch mở khi có lý do đủ dài VÀ còn hạn mức sống', () => {
    const html = renderToStaticMarkup(
      <TheUyQuyenDung
        {...props}
        lyDoThuHoiTatCa="Lý do đủ dài để thu hồi tất cả hạn mức"
        danhSach={[
          {
            grantId: GRANT_A,
            actionId: 'a',
            labelVi: 'a',
            constraints: {},
            maxPerDay: 1,
            usedToday: 0,
            usedOn: null,
            expiresAt: null,
            revokedAt: null,
            revokedBy: null,
            reason: 'x',
            granterUserId: null,
            createdAt: null,
          },
        ]}
      />,
    );
    const nut = html.match(/<button[^>]*copilot-admin-grant-revoke-all[^>]*>/)?.[0] ?? '';
    expect(nut).not.toContain('disabled=""');
    expect(html).toContain('Thu hồi tất cả (1)');
  });

  it('báo cáo ngày hiện tổng tiền định dạng VND, mảng rỗng vẫn hiện 0 kế hoạch', () => {
    const html = renderToStaticMarkup(
      <TheUyQuyenDung
        {...props}
        baoCao={{ ok: true, maLoi: null, thongBao: null, ngay: '2026-09-03', ke: [], tongTien: 0 }}
      />,
    );
    expect(html).toContain('copilot-admin-grant-report');
    expect(html).toContain('0 kế hoạch tự duyệt');
  });
});
