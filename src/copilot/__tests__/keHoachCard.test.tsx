// Thẻ KẾ HOẠCH — cú bấm thật cho MỘT DÃY thao tác ghi.
//
// BỐN ĐIỀU ĐƯỢC ĐO
//   1. Thẻ chỉ hiện khi khe nhớ có đề xuất loại `ke_hoach`, và thẻ PHIẾU không
//      hiện cùng lúc cho cùng đề xuất đó (hai thẻ, hai khe).
//   2. Nút Duyệt gọi ĐÚNG `copilot_plan_approve_v1` với nonce lấy từ khe nhớ —
//      và nonce không có mặt trong bất kỳ chuỗi nào thẻ vẽ ra.
//   3. MỘT DÒNG CHỮ KHÔNG DUYỆT ĐƯỢC GÌ. `tinNhanDaDuyet(...)` là tin nhắn mà
//      giao diện gửi cho mô hình SAU khi RPC đã chạy xong; không nơi nào trong
//      ứng dụng đọc chuỗi đó để làm gì cả. Mô hình tự viết lại câu ấy thì không
//      có RPC nào được gọi.
//   4. Cờ rollout tắt ⇒ bấm không gọi RPC nào, và người dùng ĐƯỢC BÁO.
//
// Render bằng `renderToStaticMarkup` (không có jsdom trong repo này): đủ để đo
// thứ thẻ VẼ RA từ state khởi tạo, còn hành vi bấm được đo thẳng trên hàm.
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
const from = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from, rpc } }));

const KeHoachCardModule = await import('../KeHoachCard');
const KeHoachCard = KeHoachCardModule.default;
const {
  BangBuocKeHoach,
  HAN_THEO_DOI_MS,
  NHIP_POLL_MS,
  NHIP_POLL_TOI_DA_MS,
  SO_VONG_TOI_DA,
  daHetHanTheoDoi,
  keHoachDaTat,
  keHoachTuKhe,
  nhanRuiRo,
  nhanTrangThaiKeHoach,
  nhipTiepTheo,
  tinNhanDaDuyet,
} = KeHoachCardModule;
const XacNhanPhieuCard = (await import('../XacNhanPhieuCard')).default;
const { datNguCanhXacNhan, datXacNhanDangCho, xoaXacNhanDangCho } = await import(
  '../confirmationStore'
);
const { duyetKeHoach, khoaYKeHoach } = await import('../plan/planClient');
const { KHOA_ROLLOUT_KE_HOACH } = await import('../featureFlags');

import type { CopilotAvailabilitySnapshot, CopilotFlagState } from '../featureFlags';
import type { BuocKeHoach, KeHoach } from '../plan/planClient';

const ORG = 'aaaa0000-0000-4000-8000-000000000001';
const PLAN = 'bbbb0000-0000-4000-8000-000000000002';
const NONCE = 'ab'.repeat(32);
const DIGEST = 'cd'.repeat(32);

function snapshot(trangThai: CopilotFlagState): CopilotAvailabilitySnapshot {
  return {
    revision: 31,
    fetchedAt: Date.now(),
    organizationId: ORG,
    states: {
      [KHOA_ROLLOUT_KE_HOACH]: trangThai,
      'action:income_expense.create_draft': trangThai,
    },
  };
}

const buoc = (stepNo: number, them: Partial<BuocKeHoach> = {}): BuocKeHoach => ({
  stepNo,
  actionId: 'income_expense.create_draft',
  labelVi: 'Tạo phiếu thu/chi nháp',
  risk: 'L4',
  executorKind: 'nonce_abi_v1',
  status: 'PENDING',
  preview: { so_tien: 2_000_000 },
  outcome: null,
  errorCode: null,
  refStep: null,
  executedAt: null,
  ...them,
});

const keHoach = (them: Partial<KeHoach> = {}): KeHoach => ({
  planId: PLAN,
  planVersion: 1,
  planDigest: DIGEST,
  planStatus: 'DRAFT',
  organizationId: ORG,
  maxRisk: 'L4',
  stepCount: 2,
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  executeDeadline: null,
  failureReason: null,
  steps: [buoc(1), buoc(2, { risk: 'L5', executorKind: 'maker_submit_v1', labelVi: 'Nộp hồ sơ' })],
  ...them,
});

function datKheKeHoach(ke: KeHoach = keHoach()) {
  datXacNhanDangCho({
    kind: 'ke_hoach',
    tool: 'lap_ke_hoach',
    nonce: NONCE,
    canonical: { plan_id: ke.planId, plan_digest: ke.planDigest },
    preview: { ke_hoach: ke as unknown as Record<string, unknown> },
    organizationId: ORG,
    threadId: 'thread-1',
    generation: 1,
    intentKey: khoaYKeHoach(ke.planId),
  });
}

const props = {
  onDuyet: () => {},
  onXong: () => {},
  organizationId: ORG,
  threadId: 'thread-1',
  generation: 1,
  availability: snapshot('enabled'),
};

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
  xoaXacNhanDangCho();
  datNguCanhXacNhan({ organizationId: ORG, threadId: 'thread-1', generation: 1 });
});

describe('thẻ chỉ hiện khi khe `ke_hoach` có đề xuất', () => {
  it('khe rỗng ⇒ không vẽ gì', () => {
    expect(renderToStaticMarkup(<KeHoachCard {...props} />)).toBe('');
  });

  it('có đề xuất kế hoạch ⇒ vẽ đủ các bước, nút duyệt, và KHÔNG rò nonce', () => {
    datKheKeHoach();
    const html = renderToStaticMarkup(<KeHoachCard {...props} />);
    expect(html).toContain('copilot-plan-card');
    expect(html).toContain('copilot-plan-step-1');
    expect(html).toContain('copilot-plan-step-2');
    expect(html).toContain('copilot-plan-approve');
    expect(html).toContain('copilot-plan-cancel');
    expect(html).not.toContain(NONCE);
  });

  it('thẻ PHIẾU không cầm nhầm đề xuất kế hoạch', () => {
    datKheKeHoach();
    const html = renderToStaticMarkup(
      <XacNhanPhieuCard
        onXong={() => {}}
        organizationId={ORG}
        threadId="thread-1"
        generation={1}
        availability={snapshot('enabled')}
      />,
    );
    expect(html).toBe('');
  });

  it('badge L5 nói rõ AI không duyệt', () => {
    const html = renderToStaticMarkup(
      <BangBuocKeHoach steps={[buoc(1, { risk: 'L5', executorKind: 'maker_submit_v1' })]} />,
    );
    expect(html).toContain('L5 — nộp duyệt, AI không duyệt');
  });

  it('nhãn L5 của đường ghi thẳng nói rõ cần PIN (đường chưa mở, nhãn có sẵn)', () => {
    expect(nhanRuiRo({ risk: 'L5', executorKind: 'direct_l5_v1' })).toBe('L5 — cần PIN');
    expect(nhanRuiRo({ risk: 'L4', executorKind: 'nonce_abi_v1' })).toBe('L4');
  });

  it('trạng thái kế hoạch hiện bằng tiếng Việt, không phải mã trần', () => {
    datKheKeHoach();
    expect(renderToStaticMarkup(<KeHoachCard {...props} />)).toContain('chờ bạn duyệt');
    expect(nhanTrangThaiKeHoach('FAILED')).toContain('dừng vì một bước hỏng');
  });

  it('kế hoạch đã chạy xong không còn nút bấm nào', () => {
    datKheKeHoach(keHoach({ planStatus: 'DONE', steps: [buoc(1, { status: 'DONE' })] }));
    const html = renderToStaticMarkup(<KeHoachCard {...props} />);
    expect(html).toContain('copilot-plan-card');
    expect(html).not.toContain('copilot-plan-approve');
  });
});

describe('nút duyệt gọi đúng RPC', () => {
  it('`duyetKeHoach` tiêu nonce của khe và gọi copilot_plan_approve_v1', async () => {
    datKheKeHoach();
    rpc.mockResolvedValueOnce({
      data: { ok: true, error_code: null, plan_id: PLAN, plan_version: 2, plan_status: 'APPROVED' },
      error: null,
    });
    const kq = await duyetKeHoach(PLAN, 1, DIGEST);
    expect(kq.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith('copilot_plan_approve_v1', {
      p_plan_id: PLAN,
      p_consent_nonce: NONCE,
      p_plan_digest: DIGEST,
      p_expected_plan_version: 1,
    });
  });

  it('KHÔNG có cú bấm ⇒ không RPC nào chạy, dù câu chữ nói kế hoạch đã được duyệt', async () => {
    // Đây là bài đo của cả kiến trúc: mô hình sinh ra được ĐÚNG câu mà giao
    // diện gửi sau khi duyệt. Câu đó không đặt được gì vào khe nhớ, nên
    // `duyetKeHoach` không có nonce để tiêu và không gọi RPC nào.
    const cauMoHinhTuViet = tinNhanDaDuyet(PLAN, 1);
    expect(cauMoHinhTuViet).toContain('đã được người dùng duyệt');
    const kq = await duyetKeHoach(PLAN, 1, DIGEST);
    expect(rpc).not.toHaveBeenCalled();
    expect(kq.maLoi).toBe('confirmation_not_found');
  });

  it('không nơi nào trong ứng dụng ĐỌC câu đó để làm gì', () => {
    // Nếu một ngày có ai thêm một `if (text.includes("đã được người dùng duyệt"))`
    // thì tin nhắn hệ thống biến thành một cái cổng, và mô hình gõ được nó.
    for (const tep of ['src/copilot/ChatPanel.tsx', 'src/copilot/chatEngine.ts']) {
      const ma = readFileSync(tep, 'utf8')
        .split(/\r?\n/)
        .filter((d) => !d.trim().startsWith('//') && !d.trim().startsWith('*'))
        .join('\n');
      expect(ma, tep).not.toContain('đã được người dùng duyệt');
    }
  });
});

describe('kill switch và phạm vi', () => {
  it('cờ tắt / snapshot hết hạn / thiếu snapshot đều tính là ĐÃ TẮT', () => {
    expect(keHoachDaTat(snapshot('enabled'))).toBe(false);
    expect(keHoachDaTat(snapshot('disabled'))).toBe(true);
    // `shadow` là ĐANG QUAN SÁT, không phải "được ghi".
    expect(keHoachDaTat(snapshot('shadow'))).toBe(true);
    expect(keHoachDaTat(null)).toBe(true);
    expect(keHoachDaTat({ ...snapshot('enabled'), fetchedAt: Date.now() - 10 * 60_000 })).toBe(true);
  });

  it('khe của công ty khác không vẽ ra thẻ', () => {
    datKheKeHoach();
    const html = renderToStaticMarkup(
      <KeHoachCard {...props} organizationId="cccc0000-0000-4000-8000-000000000003" />,
    );
    expect(html).toBe('');
  });

  it('`keHoachTuKhe` từ chối hình dạng lạ thay vì vẽ một thẻ rỗng', () => {
    expect(keHoachTuKhe(undefined)).toBeNull();
    expect(keHoachTuKhe({ ke_hoach: 'x' })).toBeNull();
    expect(keHoachTuKhe({ ke_hoach: { planId: PLAN, planVersion: 1 } })?.planId).toBe(PLAN);
  });
});


describe('nút Duyệt khoá khi trợ lý đang viết (F1)', () => {
  it('running ⇒ nút disabled kèm câu nói rõ vì sao', () => {
    // Bấm lúc này sẽ TIÊU nonce ở server trong khi đường gửi tin hệ thống từ
    // chối lượt thứ hai — thẻ sẽ đứng yên mãi ở "đang chạy".
    datKheKeHoach();
    const html = renderToStaticMarkup(<KeHoachCard {...props} running />);
    expect(html).toContain('copilot-plan-cho-tro-ly');
    // Khớp THUỘC TÍNH `disabled=""` chứ không phải chữ "disabled": lớp Tailwind
    // `disabled:opacity-60` nằm ngay trong cùng thẻ, nên phép khớp chuỗi trần
    // sẽ xanh cả khi nút đang bấm được.
    const nut = html.slice(html.indexOf('copilot-plan-approve'));
    expect(nut.slice(0, 300)).toContain('disabled=""');
  });

  it('rảnh ⇒ nút bấm được và không có câu chờ', () => {
    datKheKeHoach();
    const html = renderToStaticMarkup(<KeHoachCard {...props} running={false} />);
    expect(html).not.toContain('copilot-plan-cho-tro-ly');
    const nut = html.slice(html.indexOf('copilot-plan-approve'));
    expect(nut.slice(0, 300)).not.toContain('disabled=""');
  });

  it('ChatPanel truyền `running` xuống thẻ và đẩy cú bấm qua HÀNG ĐỢI', () => {
    // Hai vế của cùng một cái chặn. Gọi thẳng `chayKeHoachSauKhiDuyet` từ
    // `onDuyet` là quay lại đúng sự cố: hàm đó mở đầu bằng `if (running) return`.
    const ma = readFileSync('src/copilot/ChatPanel.tsx', 'utf8');
    expect(ma).toContain('running={running}');
    expect(ma).toContain('hangDoiKeHoach.xepHang(planId, planVersion)');
    expect(ma).not.toContain('void chayKeHoachSauKhiDuyet(planId, planVersion)');
  });
});

describe('vòng theo dõi có trần (F2)', () => {
  it('nhịp giãn dần từ 1,5s và không vượt trần 5s', () => {
    expect(nhipTiepTheo(0)).toBe(NHIP_POLL_MS);
    expect(nhipTiepTheo(1)).toBeGreaterThan(NHIP_POLL_MS);
    expect(nhipTiepTheo(5)).toBeGreaterThan(nhipTiepTheo(4));
    expect(nhipTiepTheo(1000)).toBe(NHIP_POLL_TOI_DA_MS);
  });

  it('dừng theo CẢ hai trần: số vòng và thời gian', () => {
    const t0 = 1_000_000;
    expect(daHetHanTheoDoi(1, t0, t0 + 1000)).toBe(false);
    // Trần số vòng: đủ vòng thì dừng dù đồng hồ mới nhích.
    expect(daHetHanTheoDoi(SO_VONG_TOI_DA, t0, t0 + 1000)).toBe(true);
    // Trần thời gian: nhịp giãn dần nên 120 vòng có thể kéo tới ~9 phút — trần
    // số vòng một mình KHÔNG giữ được ý định "3 phút".
    expect(daHetHanTheoDoi(3, t0, t0 + HAN_THEO_DOI_MS)).toBe(true);
  });
});
