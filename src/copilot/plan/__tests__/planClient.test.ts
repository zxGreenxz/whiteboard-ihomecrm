// Máy trạm của kế hoạch thực thi — bốn điều được canh ở đây, và vì sao.
//
//   1. NONCE KHÔNG LỌT RA CHUỖI. Nó vào `confirmationStore` và không được có
//      mặt trong bất kỳ giá trị nào mà hàm trả về — vì những giá trị đó đi tiếp
//      vào chuỗi tool, tức vào ngữ cảnh mô hình.
//   2. HTTP 200 ≠ THÀNH CÔNG. `supabase.rpc` không bao giờ ném, và migration G3
//      cố ý GHI-rồi-RETURN `ok:false` cho ba nhánh. Bỏ sót `ok` là báo thành
//      công cho một bước vừa FAILED.
//   3. HẾT GIỜ CHỜ THÌ HỎI, KHÔNG ĐOÁN. 30 giây im lặng không phải bằng chứng
//      của hỏng: lời gọi có thể đã ghi xong rồi mất phản hồi trên đường về.
//   4. DUYỆT KHÔNG GỌI ĐƯỢC KHI KHE NHỚ RỖNG. Đó là toàn bộ lý do một câu văn
//      do mô hình sinh ra không mở được cửa duyệt.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));

const {
  chayTuanTu,
  chuanHoaKeHoach,
  docKeHoach,
  duyetKeHoach,
  huyKeHoach,
  khoaYKeHoach,
  taoKeHoach,
  thucThiBuoc,
} = await import('../planClient');
const { datNguCanhXacNhan, layXacNhanDangCho, xoaXacNhanDangCho } = await import(
  '../../confirmationStore'
);

const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const PLAN = 'bbbb0000-0000-4000-8000-000000000002';
const NONCE = 'ab'.repeat(32);
const DIGEST = 'cd'.repeat(32);

function buoc(stepNo: number, status: string, them: Record<string, unknown> = {}) {
  return {
    step_no: stepNo,
    action_id: 'income_expense.create_draft',
    label_vi: 'Tạo phiếu thu/chi nháp',
    risk: 'L4',
    executor_kind: 'nonce_abi_v1',
    status,
    preview: { so_tien: 2_000_000 },
    outcome: null,
    error_code: null,
    ref_step: null,
    executed_at: null,
    ...them,
  };
}

function keHoach(them: Record<string, unknown> = {}) {
  return {
    ok: true,
    error_code: null,
    plan_id: PLAN,
    plan_version: 1,
    plan_digest: DIGEST,
    plan_status: 'DRAFT',
    organization_id: ORG,
    max_risk: 'L4',
    step_count: 2,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    approved_at: null,
    execute_deadline: null,
    failure_reason: null,
    steps: [buoc(1, 'PENDING'), buoc(2, 'PENDING')],
    ...them,
  };
}

/** `{ data, error }` — hình dạng THẬT của supabase-js: nó KHÔNG ném. */
const tra = (data: unknown) => ({ data, error: null });
const nem = (message: string) => ({ data: null, error: { message } });

beforeEach(() => {
  rpc.mockReset();
  xoaXacNhanDangCho();
  datNguCanhXacNhan(null);
});

describe('taoKeHoach', () => {
  it('cất nonce vào khe `ke_hoach` và KHÔNG trả nó ra bất kỳ đâu', async () => {
    rpc.mockResolvedValueOnce(tra({ ...keHoach(), consent_nonce: NONCE, da_ton_tai: false }));

    const kq = await taoKeHoach({
      organizationId: ORG,
      clientRequestId: 'req-1',
      buoc: [{ hanh_dong: 'income_expense.create_draft', du_lieu: { so_tien: 2_000_000 } }],
    });

    expect(kq.maLoi).toBeNull();
    expect(kq.keHoach?.planId).toBe(PLAN);
    // Bài đo đắt nhất của file: nonce không được nằm trong BẤT KỲ giá trị nào
    // đi ra khỏi hàm — kể cả sâu trong một object lồng.
    expect(JSON.stringify(kq)).not.toContain(NONCE);
    // ...nhưng vẫn phải nằm trong khe nhớ cho giao diện lấy.
    const khe = layXacNhanDangCho(Date.now(), khoaYKeHoach(PLAN), undefined, 'ke_hoach');
    expect(khe?.nonce).toBe(NONCE);
    expect(khe?.tool).toBe('lap_ke_hoach');
  });

  it('gửi đúng ba tham số của `copilot_plan_create_v1`', async () => {
    rpc.mockResolvedValueOnce(tra({ ...keHoach(), consent_nonce: NONCE }));
    await taoKeHoach({
      organizationId: ORG,
      clientRequestId: 'req-2',
      buoc: [{ hanh_dong: 'meter_reading.create', du_lieu: { meter_id: 'm1' } }],
    });
    expect(rpc).toHaveBeenCalledWith('copilot_plan_create_v1', {
      p_organization_id: ORG,
      p_client_request_id: 'req-2',
      p_steps: [{ hanh_dong: 'meter_reading.create', du_lieu: { meter_id: 'm1' } }],
    });
  });

  it('`ok:false` là LỖI, dù không có `error` nào', async () => {
    // Đây là nhánh mà một client đọc `error` sẽ chấm là thành công.
    rpc.mockResolvedValueOnce(tra({ ok: false, error_code: 'plan_limit', plan_id: PLAN }));
    const kq = await taoKeHoach({ organizationId: ORG, clientRequestId: 'r', buoc: [] });
    expect(kq.keHoach).toBeNull();
    expect(kq.maLoi).toBe('plan_limit');
    expect(kq.thongBao).toContain('3 kế hoạch mở');
  });

  it('lỗi RAISE về qua `error`, không qua exception', async () => {
    rpc.mockResolvedValueOnce(nem('plan_role_not_allowed'));
    const kq = await taoKeHoach({ organizationId: ORG, clientRequestId: 'r', buoc: [] });
    expect(kq.maLoi).toBe('plan_role_not_allowed');
    expect(kq.thongBao).toContain('không được phép lập kế hoạch');
  });

  it('lời gọi trùng `client_request_id` không có nonce mới ⇒ không đặt khe', async () => {
    rpc.mockResolvedValueOnce(tra({ ...keHoach(), consent_nonce: null, da_ton_tai: true }));
    const kq = await taoKeHoach({ organizationId: ORG, clientRequestId: 'req-1', buoc: [] });
    expect(kq.daTonTai).toBe(true);
    expect(layXacNhanDangCho(Date.now(), khoaYKeHoach(PLAN), undefined, 'ke_hoach')).toBeNull();
  });

  // G5-B — điểm nối #4: uỷ quyền đứng phủ hết mọi bước. Server trả
  // `consent_nonce: null` (không nonce nào phát) kèm `tu_duyet_theo_uy_quyen`.
  it('tự duyệt theo uỷ quyền đứng ⇒ vẫn đặt khe (nonce rỗng) để thẻ đọc được kế hoạch', async () => {
    const GRANT = 'ffff0000-0000-4000-8000-000000000009';
    rpc.mockResolvedValueOnce(
      tra({
        ...keHoach({
          plan_status: 'APPROVED',
          execute_deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
        }),
        consent_nonce: null,
        da_ton_tai: false,
        tu_duyet_theo_uy_quyen: [GRANT],
      }),
    );
    const kq = await taoKeHoach({ organizationId: ORG, clientRequestId: 'req-3', buoc: [] });
    expect(kq.maLoi).toBeNull();
    expect(kq.keHoach?.standingGrantIds).toEqual([GRANT]);
    expect(kq.keHoach?.planStatus).toBe('APPROVED');
    const khe = layXacNhanDangCho(Date.now(), khoaYKeHoach(PLAN), undefined, 'ke_hoach');
    expect(khe?.nonce).toBe('');
    expect((khe?.preview.ke_hoach as { standingGrantIds: string[] } | undefined)?.standingGrantIds).toEqual([GRANT]);
  });

  it('kế hoạch DRAFT bình thường ⇒ standingGrantIds là null, không đi nhánh tự duyệt', async () => {
    rpc.mockResolvedValueOnce(tra({ ...keHoach(), consent_nonce: NONCE, da_ton_tai: false }));
    const kq = await taoKeHoach({ organizationId: ORG, clientRequestId: 'req-4', buoc: [] });
    expect(kq.keHoach?.standingGrantIds).toBeNull();
  });
});

describe('chuanHoaKeHoach', () => {
  it('dựng từ danh sách trường tường minh — trường lạ của server không đi ra', () => {
    const ke = chuanHoaKeHoach({
      ...keHoach(),
      consent_nonce: NONCE,
      bi_mat_cua_ban_sau: 'x',
    });
    expect(JSON.stringify(ke)).not.toContain(NONCE);
    expect(JSON.stringify(ke)).not.toContain('bi_mat_cua_ban_sau');
    expect(ke?.steps).toHaveLength(2);
  });

  it('hình dạng không đọc được ⇒ null, không phải một kế hoạch rỗng', () => {
    expect(chuanHoaKeHoach(null)).toBeNull();
    expect(chuanHoaKeHoach({ plan_id: PLAN })).toBeNull();
  });

  it('standingGrantIds đọc từ tu_duyet_theo_uy_quyen; mảng rỗng/vắng mặt ⇒ null', () => {
    const GRANT = 'ffff0000-0000-4000-8000-000000000009';
    expect(chuanHoaKeHoach({ ...keHoach(), tu_duyet_theo_uy_quyen: [GRANT] })?.standingGrantIds).toEqual([
      GRANT,
    ]);
    expect(chuanHoaKeHoach({ ...keHoach(), tu_duyet_theo_uy_quyen: [] })?.standingGrantIds).toBeNull();
    expect(chuanHoaKeHoach(keHoach())?.standingGrantIds).toBeNull();
  });

  // 05/09: `copilot_plan_summary_v1` — đường mà `copilot_plan_get_v1` chiếu
  // qua — nay trả `standing_grant_ids`. Đọc lại một kế hoạch tự duyệt sau khi
  // F5 phải ra đúng danh sách grant, không phụ thuộc bộ nhớ của thẻ nữa.
  it('standingGrantIds cũng đọc từ standing_grant_ids của đường get', () => {
    const GRANT = 'ffff0000-0000-4000-8000-00000000000a';
    expect(chuanHoaKeHoach({ ...keHoach(), standing_grant_ids: [GRANT] })?.standingGrantIds).toEqual([
      GRANT,
    ]);
    expect(chuanHoaKeHoach({ ...keHoach(), standing_grant_ids: [] })?.standingGrantIds).toBeNull();
    // Đường bấm tay/PIN: cột NOT NULL DEFAULT '{}' nên tóm tắt trả mảng rỗng.
    expect(
      chuanHoaKeHoach({ ...keHoach(), tu_duyet_theo_uy_quyen: [], standing_grant_ids: [] })
        ?.standingGrantIds,
    ).toBeNull();
    // Hai khoá cùng có mặt (kết quả `create` sau này cũng chiếu qua tóm tắt):
    // tên riêng của `create` thắng, và cả hai vốn là cùng một sự thật.
    expect(
      chuanHoaKeHoach({
        ...keHoach(),
        tu_duyet_theo_uy_quyen: [GRANT],
        standing_grant_ids: [GRANT],
      })?.standingGrantIds,
    ).toEqual([GRANT]);
  });
});

describe('duyetKeHoach', () => {
  it('khe nhớ rỗng ⇒ KHÔNG gọi RPC nào', async () => {
    const kq = await duyetKeHoach(PLAN, 1, DIGEST);
    expect(rpc).not.toHaveBeenCalled();
    expect(kq.ok).toBe(false);
    expect(kq.maLoi).toBe('confirmation_not_found');
  });

  it('tiêu nonce đúng một lần và gọi `copilot_plan_approve_v1`', async () => {
    rpc.mockResolvedValueOnce(tra({ ...keHoach(), consent_nonce: NONCE }));
    await taoKeHoach({ organizationId: ORG, clientRequestId: 'r', buoc: [] });
    rpc.mockResolvedValueOnce(
      tra({
        ok: true,
        error_code: null,
        plan_id: PLAN,
        plan_version: 2,
        plan_status: 'APPROVED',
        execute_deadline: '2026-09-03T10:00:00Z',
      }),
    );

    const kq = await duyetKeHoach(PLAN, 1, DIGEST);
    expect(kq.ok).toBe(true);
    expect(kq.planStatus).toBe('APPROVED');
    expect(rpc).toHaveBeenLastCalledWith('copilot_plan_approve_v1', {
      p_plan_id: PLAN,
      p_consent_nonce: NONCE,
      p_plan_digest: DIGEST,
      p_expected_plan_version: 1,
    });

    // Lần bấm thứ hai không còn nonce để tiêu — server có CAS, nhưng client
    // không được bắn lần thứ hai rồi trông chờ server dọn.
    const lai = await duyetKeHoach(PLAN, 2, DIGEST);
    expect(lai.maLoi).toBe('confirmation_not_found');
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('`ok:false` + `plan_expired` là từ chối, không phải thành công', async () => {
    rpc.mockResolvedValueOnce(tra({ ...keHoach(), consent_nonce: NONCE }));
    await taoKeHoach({ organizationId: ORG, clientRequestId: 'r', buoc: [] });
    rpc.mockResolvedValueOnce(
      tra({ ok: false, error_code: 'plan_expired', plan_id: PLAN, plan_version: 2, plan_status: 'EXPIRED' }),
    );
    const kq = await duyetKeHoach(PLAN, 1, DIGEST);
    expect(kq.ok).toBe(false);
    expect(kq.planStatus).toBe('EXPIRED');
    expect(kq.thongBao).toContain('quá hạn');
  });
});

describe('thucThiBuoc', () => {
  it('đọc trạng thái bước từ khối `step`', async () => {
    rpc.mockResolvedValueOnce(
      tra({
        ok: true,
        error_code: null,
        plan_id: PLAN,
        plan_version: 3,
        plan_status: 'APPROVED',
        step: { step_no: 1, status: 'DONE', outcome: { entity_id: 'x' }, error_code: null },
        next_step_no: 2,
      }),
    );
    const kq = await thucThiBuoc(PLAN, 1, 2, ORG);
    expect(kq.ok).toBe(true);
    expect(kq.stepStatus).toBe('DONE');
    expect(kq.nextStepNo).toBe(2);
  });

  it('bước hỏng về với `ok:false` và trạng thái FAILED', async () => {
    rpc.mockResolvedValueOnce(
      tra({
        ok: false,
        error_code: 'step_failed',
        plan_id: PLAN,
        plan_version: 4,
        plan_status: 'FAILED',
        step: { step_no: 2, status: 'FAILED', outcome: null, error_code: 'step_failed' },
        next_step_no: null,
      }),
    );
    const kq = await thucThiBuoc(PLAN, 2, 3, ORG);
    expect(kq.ok).toBe(false);
    expect(kq.stepStatus).toBe('FAILED');
  });
});

describe('chayTuanTu', () => {
  const dangChay = (them: Record<string, unknown> = {}) =>
    keHoach({ plan_status: 'APPROVED', plan_version: 2, ...them });

  it('chạy hết các bước rồi dừng khi `next_step_no` là null', async () => {
    rpc
      .mockResolvedValueOnce(tra(dangChay()))
      .mockResolvedValueOnce(
        tra({
          ok: true,
          error_code: null,
          plan_id: PLAN,
          plan_version: 3,
          plan_status: 'APPROVED',
          step: { step_no: 1, status: 'DONE', error_code: null },
          next_step_no: 2,
        }),
      )
      .mockResolvedValueOnce(
        tra({
          ok: true,
          error_code: null,
          plan_id: PLAN,
          plan_version: 4,
          plan_status: 'DONE',
          step: { step_no: 2, status: 'DONE', error_code: null },
          next_step_no: null,
        }),
      )
      .mockResolvedValueOnce(
        tra(dangChay({ plan_status: 'DONE', plan_version: 4, steps: [buoc(1, 'DONE'), buoc(2, 'DONE')] })),
      );

    const kq = await chayTuanTu(PLAN, ORG);
    expect(kq.ketThuc).toBe('xong');
    expect(kq.buoc.map((b) => b.stepNo)).toEqual([1, 2]);
    // Phiên bản CAS phải đi theo từng bước, không giữ nguyên bản đọc đầu.
    expect(rpc.mock.calls[2][1]).toMatchObject({ p_expected_plan_version: 3, p_step_no: 2 });
  });

  it('dừng ngay ở bước FAILED — không chạy bước sau', async () => {
    rpc
      .mockResolvedValueOnce(tra(dangChay()))
      .mockResolvedValueOnce(
        tra({
          ok: false,
          error_code: 'step_failed',
          plan_id: PLAN,
          plan_version: 3,
          plan_status: 'FAILED',
          step: { step_no: 1, status: 'FAILED', error_code: 'step_failed' },
          next_step_no: null,
        }),
      )
      .mockResolvedValueOnce(tra(dangChay({ plan_status: 'FAILED', steps: [buoc(1, 'FAILED'), buoc(2, 'SKIPPED')] })));

    const kq = await chayTuanTu(PLAN, ORG);
    expect(kq.ketThuc).toBe('loi');
    expect(kq.buoc).toHaveLength(1);
    // 3 lời gọi: get đầu, execute bước 1, get cuối. KHÔNG có execute bước 2.
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it('kế hoạch chưa duyệt ⇒ không chạy bước nào', async () => {
    rpc.mockResolvedValueOnce(tra(keHoach()));
    const kq = await chayTuanTu(PLAN, ORG);
    expect(kq.maLoi).toBe('plan_not_approved');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('hết giờ chờ ⇒ ĐỌC trạng thái thật; bước đã xong thì đi tiếp', async () => {
    // Lời gọi execute không bao giờ trả lời — đúng hình dạng của một phản hồi
    // mất trên đường về sau khi server đã ghi xong.
    rpc
      .mockResolvedValueOnce(tra(dangChay()))
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(
        tra(dangChay({ plan_version: 3, steps: [buoc(1, 'DONE'), buoc(2, 'PENDING')] })),
      )
      .mockResolvedValueOnce(
        tra({
          ok: true,
          error_code: null,
          plan_id: PLAN,
          plan_version: 4,
          plan_status: 'DONE',
          step: { step_no: 2, status: 'DONE', error_code: null },
          next_step_no: null,
        }),
      )
      .mockResolvedValueOnce(
        tra(dangChay({ plan_status: 'DONE', plan_version: 4, steps: [buoc(1, 'DONE'), buoc(2, 'DONE')] })),
      );

    const kq = await chayTuanTu(PLAN, ORG, { hanMoiBuocMs: 10 });
    expect(kq.ketThuc).toBe('xong');
    expect(kq.buoc[0]).toMatchObject({ stepNo: 1, stepStatus: 'DONE', doLaiSauHetGio: true });
    // Bước 2 chạy với phiên bản ĐỌC LẠI (3), không phải phiên bản đoán.
    expect(rpc.mock.calls[3][1]).toMatchObject({ p_expected_plan_version: 3, p_step_no: 2 });
  });

  it('hết giờ chờ mà bước vẫn PENDING ⇒ dừng, KHÔNG chấm là FAILED', async () => {
    rpc
      .mockResolvedValueOnce(tra(dangChay()))
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(tra(dangChay()))
      .mockResolvedValueOnce(tra(dangChay()));

    const kq = await chayTuanTu(PLAN, ORG, { hanMoiBuocMs: 10 });
    expect(kq.ketThuc).toBe('het_gio');
    expect(kq.buoc[0].stepStatus).toBe('PENDING');
    expect(kq.buoc[0].ok).toBe(false);
  });

  it('signal đã huỷ ⇒ không gọi execute nào', async () => {
    const dieuKhien = new AbortController();
    dieuKhien.abort();
    rpc.mockResolvedValueOnce(tra(dangChay())).mockResolvedValueOnce(tra(dangChay()));
    const kq = await chayTuanTu(PLAN, ORG, { signal: dieuKhien.signal });
    expect(kq.ketThuc).toBe('huy');
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

describe('docKeHoach / huyKeHoach', () => {
  it('đọc trả kế hoạch đã lược bỏ bí mật', async () => {
    rpc.mockResolvedValueOnce(tra({ ...keHoach(), consent_nonce: NONCE }));
    const kq = await docKeHoach(PLAN);
    expect(kq.keHoach?.planStatus).toBe('DRAFT');
    expect(JSON.stringify(kq)).not.toContain(NONCE);
  });

  it('huỷ thành công thì dọn luôn khe nhớ của kế hoạch', async () => {
    rpc.mockResolvedValueOnce(tra({ ...keHoach(), consent_nonce: NONCE }));
    await taoKeHoach({ organizationId: ORG, clientRequestId: 'r', buoc: [] });
    rpc.mockResolvedValueOnce(
      tra({ ok: true, error_code: null, plan_id: PLAN, plan_version: 2, plan_status: 'CANCELLED', skipped: 2 }),
    );
    const kq = await huyKeHoach(PLAN, 1, 'người dùng đổi ý');
    expect(kq.ok).toBe(true);
    expect(kq.soBuocBoQua).toBe(2);
    expect(layXacNhanDangCho(Date.now(), khoaYKeHoach(PLAN), undefined, 'ke_hoach')).toBeNull();
  });

  it('huỷ hỏng thì GIỮ khe nhớ — người dùng còn bấm Duyệt được', async () => {
    rpc.mockResolvedValueOnce(tra({ ...keHoach(), consent_nonce: NONCE }));
    await taoKeHoach({ organizationId: ORG, clientRequestId: 'r', buoc: [] });
    rpc.mockResolvedValueOnce(nem('plan_version_stale: dang o 2, nguoi goi mong 1'));
    const kq = await huyKeHoach(PLAN, 1, 'thử');
    expect(kq.ok).toBe(false);
    expect(kq.thongBao).toContain('Tải lại');
    expect(layXacNhanDangCho(Date.now(), khoaYKeHoach(PLAN), undefined, 'ke_hoach')?.nonce).toBe(NONCE);
  });
});
