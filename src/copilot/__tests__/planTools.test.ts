// Hai tool kế hoạch — điều được canh là RANH GIỚI, không phải định dạng chuỗi.
//
//   1. KHÔNG TOOL NÀO DUYỆT ĐƯỢC. `duyetKeHoach` không được là `execute` của
//      bất cứ tool nào, và `copilot_plan_approve_v1` không được xuất hiện trong
//      `src/copilot/tools/` — đo trên MÃ NGUỒN, vì đó là thứ không tự đúng lại
//      khi ai đó viết thêm một hàm phụ.
//   2. INPUT KHÔNG CÓ CỜ XÁC NHẬN. Một trường `xac_nhan` trong schema là cửa để
//      mô hình tự lật cờ đồng ý — chính cái đã bị gỡ ở G2-B.
//   3. CHAT-ONLY + SUPER ADMIN. PageAgent (điều khiển giao diện) không được
//      cầm hai tool này.
//   4. CHƯA BẤM THÌ KHÔNG CHẠY. `thuc_thi_buoc` gọi vào một kế hoạch DRAFT phải
//      trả lời từ chối, và không được chạy bước nào.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Gate là ESM thuần (.mjs) và chạy được dưới vitest — dùng CHÍNH bộ quét của nó
// thay vì dựng một bản thứ hai ở đây, để hai bên không bao giờ nhìn hai tập file
// khác nhau.
const gate = (await import('../../../scripts/check-copilot-forbidden-actions.mjs')) as {
  SCAN_ROOTS: readonly string[];
  collectCopilotSourceFiles: (roots: readonly string[]) => string[];
};

/** Mọi file .ts trong phạm vi quét của gate, khoá là đường dẫn dạng POSIX. */
function docNguonTrongPhamVi(): Record<string, string> {
  const ra: Record<string, string> = {};
  for (const duong of gate.collectCopilotSourceFiles([...gate.SCAN_ROOTS])) {
    ra[duong.split(String.fromCharCode(92)).join('/')] = readFileSync(duong, 'utf8');
  }
  return ra;
}

/** Tên bị cấm xuất hiện trong MÃ (đã lột chú thích) của một file dưới tools/. */
const TEN_CAM = ['duyetKeHoach', 'copilot_plan_approve_v1', 'copilot_plan_cancel_v1'] as const;

function timLoiGoiCam(nguon: string): string[] {
  const ma = nguon
    .split(/\r?\n/)
    .filter((d) => !d.trim().startsWith('//') && !d.trim().startsWith('*'))
    .join('\n');
  return TEN_CAM.filter((ten) => ma.includes(ten));
}

const rpc = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from, rpc } }));

const {
  SCHEMA_LAP_KE_HOACH,
  TOOL_KE_HOACH,
  daDuocDuyet,
  lapKeHoach,
  moTaBuoc,
  moTaKetQuaChay,
  textChuaDuyet,
  thucThiBuocTool,
} = await import('../tools/planTools');
const { buildRegistryDefinitions, toLlmTools, toPageAgentTools } = await import('../tools/registry');
const { xoaXacNhanDangCho, layXacNhanDangCho } = await import('../confirmationStore');
const { khoaYKeHoach } = await import('../plan/planClient');
const { KHOA_ROLLOUT_KE_HOACH } = await import('../featureFlags');

import type { CopilotAvailabilitySnapshot, CopilotFlagState } from '../featureFlags';
import type { ToolCtx } from '../tools/registry';
import type { PermissionsMap } from '@/lib/permissions';

const SUPER: PermissionsMap = { __superadmin: true } as unknown as PermissionsMap;
const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const PLAN = 'bbbb0000-0000-4000-8000-000000000002';
const NONCE = 'ab'.repeat(32);

function snapshot(trangThai: CopilotFlagState): CopilotAvailabilitySnapshot {
  return {
    revision: 31,
    fetchedAt: Date.now(),
    organizationId: ORG,
    states: { [KHOA_ROLLOUT_KE_HOACH]: trangThai },
  };
}

function ctxVoi(availability: CopilotAvailabilitySnapshot, sieuQuanTri = true): ToolCtx {
  return {
    perms: SUPER,
    organizationId: ORG,
    availability,
    threadId: 'thread-1',
    generation: 1,
    isSuperAdmin: sieuQuanTri,
  } as ToolCtx;
}

const tra = (data: unknown) => ({ data, error: null });

function keHoach(them: Record<string, unknown> = {}) {
  return {
    ok: true,
    error_code: null,
    plan_id: PLAN,
    plan_version: 1,
    plan_digest: 'cd'.repeat(32),
    plan_status: 'DRAFT',
    organization_id: ORG,
    max_risk: 'L4',
    step_count: 1,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    execute_deadline: null,
    failure_reason: null,
    steps: [
      {
        step_no: 1,
        action_id: 'income_expense.create_draft',
        label_vi: 'Tạo phiếu thu/chi nháp',
        risk: 'L4',
        executor_kind: 'nonce_abi_v1',
        status: 'PENDING',
        preview: { so_tien: 2_000_000, ten_phieu: 'Chi sửa điện' },
        outcome: null,
        error_code: null,
        ref_step: null,
        executed_at: null,
      },
    ],
    ...them,
  };
}

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
  xoaXacNhanDangCho();
});

describe('ranh giới: không tool nào tự duyệt được', () => {
  it('KHÔNG file nào trong phạm vi quét của gate gọi RPC duyệt/huỷ, hay `duyetKeHoach`', async () => {
    // Danh sách file SUY TỪ CHÍNH phạm vi quét của gate, không chép tay: một
    // file tool THỨ SÁU ra đời sau bản này phải tự động vào bài đo. Bản trước
    // liệt kê năm đường dẫn cứng — đúng loại drift mà hai gate copilot sinh ra
    // để chặn, chỉ là ở chính test canh chúng.
    const nguon = docNguonTrongPhamVi();
    const tep = Object.keys(nguon).filter((d) => d.includes('/tools/'));
    expect(tep.length, 'bộ quét hỏng chứ không phải thư mục tools rỗng').toBeGreaterThanOrEqual(5);
    for (const d of tep) {
      expect(timLoiGoiCam(nguon[d] ?? ''), d).toEqual([]);
    }
  });

  it('BÀI ĐO CHÍNH BỘ DÒ: một file dưới tools/ gọi `duyetKeHoach(` thì bị bắt', () => {
    // Một bộ dò không bao giờ báo động là một bộ dò không đo gì. Fixture này là
    // thứ chứng minh vòng lặp ở trên thật sự nhìn thấy vi phạm.
    expect(timLoiGoiCam("const x = async () => duyetKeHoach(planId, 1, digest);")).toEqual([
      'duyetKeHoach',
    ]);
    expect(timLoiGoiCam("supabase.rpc('copilot_plan_approve_v1', {})")).toEqual([
      'copilot_plan_approve_v1',
    ]);
    expect(timLoiGoiCam("supabase.rpc('copilot_plan_cancel_v1', {})")).toEqual([
      'copilot_plan_cancel_v1',
    ]);
    // ...và một lời NHẮC TỚI trong chú thích không phải một lời gọi.
    expect(timLoiGoiCam('// duyetKeHoach chỉ sống ở planClient')).toEqual([]);
  });

  it('`duyetKeHoach` không phải execute của tool nào trong registry', () => {
    const than = buildRegistryDefinitions()
      .map((t) => String(t.execute))
      .join('\n');
    expect(than).not.toContain('duyetKeHoach');
    expect(than).not.toContain('copilot_plan_approve_v1');
  });

  it('schema hai tool KHÔNG có trường xác nhận nào', () => {
    for (const t of TOOL_KE_HOACH) {
      const khoa = Object.keys(
        (t.inputSchema as unknown as { shape: Record<string, unknown> }).shape,
      );
      for (const cam of ['xac_nhan', 'nonce', 'confirm', 'duyet', 'approve']) {
        expect(khoa, `${t.name} có trường "${cam}"`).not.toContain(cam);
      }
    }
  });
});

describe('cờ và phạm vi', () => {
  it('cả hai tool đều chatOnly + superAdminOnly + khoá rollout kế hoạch', () => {
    for (const t of TOOL_KE_HOACH) {
      expect(t.chatOnly, t.name).toBe(true);
      expect(t.superAdminOnly, t.name).toBe(true);
      expect(t.rolloutKey, t.name).toBe(KHOA_ROLLOUT_KE_HOACH);
    }
  });

  it('PageAgent KHÔNG cầm được hai tool này', () => {
    const ds = toPageAgentTools(buildRegistryDefinitions(), ctxVoi(snapshot('enabled')), snapshot('enabled'));
    expect(Object.keys(ds)).not.toContain('lap_ke_hoach');
    expect(Object.keys(ds)).not.toContain('thuc_thi_buoc');
  });

  it('người KHÔNG phải super admin không thấy hai tool này trong chat', () => {
    const ds = toLlmTools(
      buildRegistryDefinitions(),
      ctxVoi(snapshot('enabled'), false),
      snapshot('enabled'),
    );
    expect(Object.keys(ds)).not.toContain('lap_ke_hoach');
    expect(Object.keys(ds)).not.toContain('thuc_thi_buoc');
  });

  it('cờ rollout tắt ⇒ tool biến mất khỏi danh sách gửi cho mô hình', () => {
    const bat = toLlmTools(buildRegistryDefinitions(), ctxVoi(snapshot('enabled')), snapshot('enabled'));
    expect(Object.keys(bat)).toContain('lap_ke_hoach');
    expect(Object.keys(bat)).toContain('thuc_thi_buoc');

    const tat = toLlmTools(buildRegistryDefinitions(), ctxVoi(snapshot('disabled')), snapshot('disabled'));
    expect(Object.keys(tat)).not.toContain('lap_ke_hoach');
    expect(Object.keys(tat)).not.toContain('thuc_thi_buoc');
  });
});

describe('lap_ke_hoach', () => {
  it('trả bản xem trước + câu nói rõ ai bấm; nonce KHÔNG lọt vào chuỗi', async () => {
    rpc.mockResolvedValueOnce(tra({ ...keHoach(), consent_nonce: NONCE, da_ton_tai: false }));
    const text = await lapKeHoach.execute(
      {
        muc_tieu: 'Ghi chỉ số rồi lập phiếu',
        cac_buoc: [{ hanh_dong: 'income_expense.create_draft', du_lieu: { so_tien: 2_000_000 } }],
      },
      ctxVoi(snapshot('enabled')),
    );
    expect(text).not.toContain(NONCE);
    expect(text).toContain(PLAN);
    expect(text).toContain('Tạo phiếu thu/chi nháp');
    expect(text).toMatch(/KHÔNG CÓ CÁCH NÀO TỰ LÀM/);
    // ...và nonce vẫn tới được giao diện.
    expect(layXacNhanDangCho(Date.now(), khoaYKeHoach(PLAN), undefined, 'ke_hoach')?.nonce).toBe(NONCE);
  });

  it('lỗi server về thành câu tiếng Việt, không phải mã trần', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'plan_risk_not_allowed: ...' } });
    const text = await lapKeHoach.execute(
      { muc_tieu: 'x', cac_buoc: [{ hanh_dong: 'income_expense.create_draft', du_lieu: {} }] },
      ctxVoi(snapshot('enabled')),
    );
    expect(text).toContain('vượt trần rủi ro');
  });

  it('schema chặn kế hoạch rỗng và kế hoạch quá 8 bước', () => {
    const mot = { hanh_dong: 'income_expense.create_draft' as const, du_lieu: {} };
    expect(SCHEMA_LAP_KE_HOACH.safeParse({ muc_tieu: 'x1', cac_buoc: [] }).success).toBe(false);
    expect(
      SCHEMA_LAP_KE_HOACH.safeParse({ muc_tieu: 'muc tieu', cac_buoc: Array(9).fill(mot) }).success,
    ).toBe(false);
    expect(
      SCHEMA_LAP_KE_HOACH.safeParse({ muc_tieu: 'muc tieu', cac_buoc: [mot] }).success,
    ).toBe(true);
  });

  it('hành động ngoài sổ đăng ký bị schema từ chối', () => {
    expect(
      SCHEMA_LAP_KE_HOACH.safeParse({
        muc_tieu: 'muc tieu',
        cac_buoc: [{ hanh_dong: 'income_expense.approve', du_lieu: {} }],
      }).success,
    ).toBe(false);
  });
});

describe('thuc_thi_buoc', () => {
  it('kế hoạch chưa được bấm ⇒ từ chối và KHÔNG chạy bước nào', async () => {
    rpc.mockResolvedValueOnce(tra(keHoach()));
    const text = await thucThiBuocTool.execute({ ke_hoach_id: PLAN }, ctxVoi(snapshot('enabled')));
    expect(text).toContain('plan_not_approved');
    expect(text).toContain('DRAFT');
    // Đúng MỘT lời gọi: đọc trạng thái. Không execute nào.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('copilot_plan_get_v1', { p_plan_id: PLAN });
  });

  it('kế hoạch đã bấm ⇒ chạy tuần tự và thuật lại từng bước', async () => {
    const daDuyet = keHoach({ plan_status: 'APPROVED', plan_version: 2 });
    rpc
      .mockResolvedValueOnce(tra(daDuyet)) // đọc trong thân tool
      .mockResolvedValueOnce(tra(daDuyet)) // đọc mở đầu của chayTuanTu
      .mockResolvedValueOnce(
        tra({
          ok: true,
          error_code: null,
          plan_id: PLAN,
          plan_version: 3,
          plan_status: 'DONE',
          step: { step_no: 1, status: 'DONE', error_code: null },
          next_step_no: null,
        }),
      )
      .mockResolvedValueOnce(
        tra(keHoach({ plan_status: 'DONE', plan_version: 3, steps: [] })),
      );

    const text = await thucThiBuocTool.execute({ ke_hoach_id: PLAN }, ctxVoi(snapshot('enabled')));
    expect(text).toContain('Bước 1: DONE');
    expect(text).toContain('Trạng thái kế hoạch: DONE');
  });

  it('bước hỏng ⇒ nói rõ các bước sau KHÔNG chạy', () => {
    const text = moTaKetQuaChay({
      buoc: [
        { ok: true, maLoi: null, thongBao: null, stepNo: 1, stepStatus: 'DONE', planStatus: 'APPROVED', planVersion: 3, nextStepNo: 2 },
        { ok: false, maLoi: 'step_failed', thongBao: 'Bước hỏng', stepNo: 2, stepStatus: 'FAILED', planStatus: 'FAILED', planVersion: 4, nextStepNo: null },
      ],
      keHoach: null,
      ketThuc: 'loi',
      maLoi: 'step_failed',
      thongBao: 'Bước hỏng',
    });
    expect(text).toContain('KHÔNG chạy');
    expect(text).toContain('Bước 2: FAILED');
  });
});

describe('hàm thuần', () => {
  it('`moTaBuoc` chỉ in các trường có trong sổ, không lặp khoá thật của preview', () => {
    const text = moTaBuoc({
      stepNo: 1,
      actionId: 'income_expense.create_draft',
      labelVi: 'Tạo phiếu thu/chi nháp',
      risk: 'L4',
      executorKind: 'nonce_abi_v1',
      status: 'PENDING',
      preview: { so_tien: 2_000_000, truong_la_cua_server: 'BÍ MẬT' },
      outcome: null,
      errorCode: null,
      refStep: null,
      executedAt: null,
    });
    expect(text).toContain('2000000');
    expect(text).not.toContain('BÍ MẬT');
  });

  it('bước `maker_submit_v1` mang nhãn nói rõ AI không duyệt', () => {
    const text = moTaBuoc({
      stepNo: 2,
      actionId: 'income_expense.nop_ho_so',
      labelVi: 'Nộp phiếu thu/chi vào hộp chờ duyệt',
      risk: 'L5',
      executorKind: 'maker_submit_v1',
      status: 'PENDING',
      preview: {},
      outcome: null,
      errorCode: null,
      refStep: 1,
      executedAt: null,
    });
    expect(text).toContain('L5 — nộp cho người thật duyệt');
  });

  it('`daDuocDuyet` chỉ đúng với APPROVED', () => {
    expect(daDuocDuyet(null)).toBe(false);
    expect(textChuaDuyet('DRAFT')).toContain('DRAFT');
  });
});
