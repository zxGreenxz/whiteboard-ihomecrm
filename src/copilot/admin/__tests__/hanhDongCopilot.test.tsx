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
} = await import('../hanhDongCopilot');
const { BangNhatKyHanhDong, TheChinhSachHanhDong } = await import('../HanhDongTab');

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
