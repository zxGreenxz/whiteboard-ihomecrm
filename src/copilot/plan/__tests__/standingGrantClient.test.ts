// Máy trạm uỷ quyền đứng (G5-B) — ba điều được đo:
//
//   1. `supabase.rpc` KHÔNG BAO GIỜ NÉM — mock `{ data, error }` của một
//      promise ĐÃ FULFIL, không `mockRejectedValue`.
//   2. NĂM RPC gửi ĐÚNG tên tham số mà migration `20260903171622` đòi —
//      `p_step_up_token` chỉ có ở `taoGrant`, bốn hàm còn lại KHÔNG có.
//   3. `dsGrant` đọc một MẢNG jsonb thẳng (không bọc `{ok, ...}`, khác bốn
//      RPC ghi/báo cáo) — đọc sai hình dạng này là câu hỏi "còn hạn mức nào
//      đang sống" luôn trả rỗng dù server có dữ liệu.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));

const { baoCaoNgayGrant, dsGrant, taoGrant, thuHoiGrant, thuHoiTatCaGrant } = await import(
  '../standingGrantClient'
);

const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const GRANT = 'ffff0000-0000-4000-8000-000000000009';
const TOKEN = 'f'.repeat(64);
const PLAN = 'bbbb0000-0000-4000-8000-000000000002';

const tra = (data: unknown) => ({ data, error: null });
const nem = (message: string) => ({ data: null, error: { message } });

beforeEach(() => {
  rpc.mockReset();
});

describe('taoGrant', () => {
  it('gửi đủ 7 tham số của copilot_standing_grant_create_v1, kể cả token step-up', async () => {
    rpc.mockResolvedValueOnce(
      tra({ ok: true, grant_id: GRANT, action_id: 'income_expense.create_draft', max_per_day: 5, expires_at: '2026-10-01T00:00:00Z' }),
    );
    const han = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    await taoGrant({
      organizationId: ORG,
      actionId: 'income_expense.create_draft',
      constraints: { maxAmount: 2_000_000, buildingIds: ['toa-1'] },
      maxPerDay: 5,
      expiresAt: han,
      reason: 'Thử nghiệm quý 4',
      stepUpToken: TOKEN,
    });
    expect(rpc).toHaveBeenCalledWith('copilot_standing_grant_create_v1', {
      p_organization_id: ORG,
      p_action_id: 'income_expense.create_draft',
      p_constraints: { max_amount: 2_000_000, building_ids: ['toa-1'] },
      p_max_per_day: 5,
      p_expires_at: han,
      p_reason: 'Thử nghiệm quý 4',
      p_step_up_token: TOKEN,
    });
  });

  it('constraints rỗng ⇒ gửi object rỗng, không lẫn max_amount/building_ids của lần trước', async () => {
    rpc.mockResolvedValueOnce(tra({ ok: true, grant_id: GRANT, action_id: 'a', max_per_day: 1, expires_at: null }));
    await taoGrant({
      organizationId: ORG,
      actionId: 'a',
      constraints: {},
      maxPerDay: 1,
      expiresAt: new Date().toISOString(),
      reason: 'x',
      stepUpToken: TOKEN,
    });
    expect(rpc).toHaveBeenCalledWith('copilot_standing_grant_create_v1', expect.objectContaining({ p_constraints: {} }));
  });

  it('thành công ⇒ dựng Grant từ trường tường minh', async () => {
    rpc.mockResolvedValueOnce(
      tra({ ok: true, grant_id: GRANT, action_id: 'income_expense.create_draft', max_per_day: 5, expires_at: '2026-10-01T00:00:00Z' }),
    );
    const kq = await taoGrant({
      organizationId: ORG,
      actionId: 'income_expense.create_draft',
      constraints: {},
      maxPerDay: 5,
      expiresAt: new Date().toISOString(),
      reason: 'x',
      stepUpToken: TOKEN,
    });
    expect(kq.ok).toBe(true);
    expect(kq.grant).toEqual({
      grantId: GRANT,
      actionId: 'income_expense.create_draft',
      maxPerDay: 5,
      expiresAt: '2026-10-01T00:00:00Z',
    });
  });

  it('RAISE (step_up_required) về qua error, không exception — và câu tiếng Việt đúng mã', async () => {
    rpc.mockResolvedValueOnce(nem('step_up_required'));
    const kq = await taoGrant({
      organizationId: ORG,
      actionId: 'a',
      constraints: {},
      maxPerDay: 1,
      expiresAt: new Date().toISOString(),
      reason: 'x',
      stepUpToken: TOKEN,
    });
    expect(kq.ok).toBe(false);
    expect(kq.maLoi).toBe('step_up_required');
    expect(kq.thongBao).toContain('xác thực hai lớp');
  });

  it('standing_grants_disabled ⇒ câu nói đúng van đang tắt, không phải mã trần', async () => {
    rpc.mockResolvedValueOnce(nem('standing_grants_disabled'));
    const kq = await taoGrant({
      organizationId: ORG,
      actionId: 'a',
      constraints: {},
      maxPerDay: 1,
      expiresAt: new Date().toISOString(),
      reason: 'x',
      stepUpToken: TOKEN,
    });
    expect(kq.thongBao).toContain('Uỷ quyền đứng đang tắt');
  });

  it('action_not_grantable ⇒ câu nói đúng thuộc nhóm phân quyền', async () => {
    rpc.mockResolvedValueOnce(nem('action_not_grantable'));
    const kq = await taoGrant({
      organizationId: ORG,
      actionId: 'update_member_authorization_v1',
      constraints: {},
      maxPerDay: 1,
      expiresAt: new Date().toISOString(),
      reason: 'x',
      stepUpToken: TOKEN,
    });
    expect(kq.thongBao).toContain('không thể cấp uỷ quyền đứng');
  });
});

describe('thuHoiGrant / thuHoiTatCaGrant — không đòi step-up', () => {
  it('thuHoiGrant gửi đúng 2 tham số, không có p_step_up_token nào', async () => {
    rpc.mockResolvedValueOnce(tra({ ok: true, grant_id: GRANT }));
    const kq = await thuHoiGrant(GRANT, 'không còn cần nữa');
    expect(rpc).toHaveBeenCalledWith('copilot_standing_grant_revoke_v1', {
      p_grant_id: GRANT,
      p_reason: 'không còn cần nữa',
    });
    expect(kq.ok).toBe(true);
  });

  it('thuHoiTatCaGrant đọc revoked_count từ kết quả', async () => {
    rpc.mockResolvedValueOnce(tra({ ok: true, revoked_count: 3 }));
    const kq = await thuHoiTatCaGrant(ORG, 'sự cố — tắt hết ngay');
    expect(rpc).toHaveBeenCalledWith('copilot_standing_grants_revoke_all_v1', {
      p_organization_id: ORG,
      p_reason: 'sự cố — tắt hết ngay',
    });
    expect(kq.ok).toBe(true);
    expect(kq.soLuongThuHoi).toBe(3);
  });

  it('grant_already_revoked về qua error, câu tiếng Việt đúng', async () => {
    rpc.mockResolvedValueOnce(nem('grant_already_revoked'));
    const kq = await thuHoiGrant(GRANT, 'x');
    expect(kq.ok).toBe(false);
    expect(kq.thongBao).toContain('đã bị thu hồi trước đó');
  });
});

describe('dsGrant — đọc mảng jsonb thẳng, không bọc {ok, ...}', () => {
  it('dựng danh sách từ mảng trần, reset used_today hiển thị theo server', async () => {
    rpc.mockResolvedValueOnce(
      tra([
        {
          grant_id: GRANT,
          action_id: 'income_expense.create_draft',
          label_vi: 'Tạo phiếu thu/chi nháp',
          constraints: { max_amount: 2_000_000 },
          max_per_day: 5,
          used_today: 2,
          used_on: '2026-09-03',
          expires_at: '2026-10-01T00:00:00Z',
          revoked_at: null,
          revoked_by: null,
          reason: 'x',
          granter_user_id: 'u1',
          created_at: '2026-09-03T00:00:00Z',
        },
      ]),
    );
    const kq = await dsGrant(ORG);
    expect(rpc).toHaveBeenCalledWith('copilot_standing_grants_list_v1', { p_organization_id: ORG });
    expect(kq.ok).toBe(true);
    expect(kq.danhSach).toHaveLength(1);
    expect(kq.danhSach[0]).toMatchObject({
      grantId: GRANT,
      actionId: 'income_expense.create_draft',
      maxPerDay: 5,
      usedToday: 2,
      constraints: { maxAmount: 2_000_000 },
    });
  });

  it('mảng rỗng ⇒ danhSach rỗng, không lỗi', async () => {
    rpc.mockResolvedValueOnce(tra([]));
    const kq = await dsGrant(ORG);
    expect(kq.ok).toBe(true);
    expect(kq.danhSach).toEqual([]);
  });

  it('lỗi RAISE (standing_grant_not_permitted) về qua error, không exception', async () => {
    rpc.mockResolvedValueOnce(nem('standing_grant_not_permitted'));
    const kq = await dsGrant(ORG);
    expect(kq.ok).toBe(false);
    expect(kq.thongBao).toContain('Chỉ super admin');
    expect(kq.danhSach).toEqual([]);
  });
});

describe('baoCaoNgayGrant', () => {
  it('gửi p_date=null khi không truyền ngày, và dựng danh sách kế hoạch + tổng tiền', async () => {
    rpc.mockResolvedValueOnce(
      tra({
        date: '2026-09-03',
        plans: [
          {
            plan_id: PLAN,
            approved_at: '2026-09-03T10:00:00Z',
            plan_status: 'DONE',
            max_risk: 'L4',
            step_count: 1,
            standing_grant_ids: [GRANT],
          },
        ],
        plan_count: 1,
        total_amount: 2_000_000,
      }),
    );
    const kq = await baoCaoNgayGrant(ORG);
    expect(rpc).toHaveBeenCalledWith('copilot_standing_grants_daily_report_v1', {
      p_organization_id: ORG,
      p_date: null,
    });
    expect(kq.ok).toBe(true);
    expect(kq.tongTien).toBe(2_000_000);
    expect(kq.ke).toEqual([
      {
        planId: PLAN,
        approvedAt: '2026-09-03T10:00:00Z',
        planStatus: 'DONE',
        maxRisk: 'L4',
        stepCount: 1,
        standingGrantIds: [GRANT],
      },
    ]);
  });

  it('truyền ngày cụ thể thì gửi đúng chuỗi đó', async () => {
    rpc.mockResolvedValueOnce(tra({ date: '2026-09-01', plans: [], plan_count: 0, total_amount: 0 }));
    await baoCaoNgayGrant(ORG, '2026-09-01');
    expect(rpc).toHaveBeenCalledWith('copilot_standing_grants_daily_report_v1', {
      p_organization_id: ORG,
      p_date: '2026-09-01',
    });
  });

  it('không kế hoạch nào trong ngày ⇒ tổng tiền 0, mảng rỗng, không lỗi', async () => {
    rpc.mockResolvedValueOnce(tra({ date: '2026-09-03', plans: [], plan_count: 0, total_amount: 0 }));
    const kq = await baoCaoNgayGrant(ORG);
    expect(kq.ok).toBe(true);
    expect(kq.ke).toEqual([]);
    expect(kq.tongTien).toBe(0);
  });
});
