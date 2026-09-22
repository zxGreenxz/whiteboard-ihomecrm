// @vitest-environment jsdom
// =============================================================================
// ContractSettlementSection — BA PHẠM VI KỲ, THẺ SỐ VÀ BỘ LỌC TRẠNG THÁI
//
// Bốn lỗi người dùng nhìn thấy mà bài này ghim lại:
//  1. "Mọi kỳ" ánh xạ sang một chế độ truy vấn CẮT sẵn POSTED/CANCELLED, nên nó
//     không phải mọi kỳ cũng không phải mọi trạng thái.
//  2. Bộ lọc 'paid' nhận cả 'noncash' còn THẺ SỐ chỉ cộng 'paid' ⇒ thẻ hiện
//     0đ/0 phiếu ngay trên một cái bảng đang có ba dòng.
//  3. Chọn một tháng thì lọc `voucher_date`, nên phiếu chi trong kỳ mà lập từ
//     tháng trước biến mất.
//  4. Chân trang hứa "lọc theo ngày chi thực tế" trong khi cả hai phía đều lọc
//     theo ngày phiếu.
//
// Ranh giới giả lập: hai hook đọc dữ liệu + hook thao tác + hai modal. Phần
// được kiểm là NỐI DÂY giữa state bộ lọc và các hàm thuần đã có bài riêng —
// không dựng lại phép lọc trong bài test.
// =============================================================================

import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface KetQuaChi {
  rows: SettlementRow[];
  postingRead: true | 'partial' | false;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

const H = vi.hoisted(() => ({
  chi: null as unknown,
  soLanRefetch: 0,
}));

vi.mock('@/hooks/useContractSettlement', () => ({
  useContractSettlement: () => H.chi,
}));

vi.mock('@/hooks/useContractMovements', async (goc) => ({
  ...(await goc<Record<string, unknown>>()),
  useContractMovements: () => ({ rows: [], isLoading: false, isError: false, refetch: () => {} }),
}));

vi.mock('@/hooks/useSettlementActions', () => ({
  useSettlementActions: () => ({ isBusy: false }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => {
      const p: unknown = new Proxy({} as Record<string, unknown>, {
        get(_t, prop) {
          if (prop === 'then') {
            return (ok: (v: unknown) => void) => ok({ data: { organization_id: ORG }, error: null });
          }
          return () => p;
        },
      });
      return p;
    },
  },
}));

vi.mock('../SettlementLifecycleModal', () => ({
  SettlementLifecycleModal: () => createElement('div', { 'data-modal': 'chi' }),
}));
vi.mock('../MovementLifecycleModal', () => ({
  MovementLifecycleModal: () => createElement('div', { 'data-modal': 'bd' }),
}));

import { ContractSettlementSection } from '../ContractSettlementSection';
import { fmtMoney, type SettlementRow } from '@/lib/contractSettlement';

// ── Định danh: UUID, KHÔNG BAO GIỜ mã phiếu ────────────────────────────────
const ORG = '0a0a0a0a-0000-4000-8000-000000000001';
const TOA = '0b0b0b0b-0000-4000-8000-000000000001';
const KY = '2026-09';

let dem = 0;
const dong = (p: Partial<SettlementRow> = {}): SettlementRow => {
  dem += 1;
  const id = p.voucherId ?? `0f0f0f0f-0000-4000-8000-${String(dem).padStart(12, '0')}`;
  const kind = p.kind ?? 'refund';
  return {
    key: `${kind}:${id}`, kind, kindSource: 'system_source', kindConflict: false,
    voucherId: id, voucherCode: `PC${dem}`, contractId: null, contractNumber: 'HD-1',
    terminationId: null, roomId: 'r1', buildingName: 'Toà A', roomName: '401',
    customerName: 'Khách A', recipientName: 'Người nhận', amount: 1_000_000,
    notes: null, systemSource: 'termination.refund.v1', commissionKind: null,
    basis: { kind: 'not-applicable' },
    status: 'pending', approvalStatus: 'UNAPPROVED', postingStatus: 'UNPOSTED',
    postingMode: null, bankAccount: '0123', bankName: 'VCB',
    attachments: [], hasAttachment: false,
    eventDate: '2026-09-05', origin: 'contract', eventLabel: 'Thanh lý',
    postedOn: null, bookName: null, issues: [], supplementPending: false,
    reviewState: 'PENDING', reviewVersion: 1, approvalVersion: 1, postingVersion: 1,
    organizationId: ORG, buildingId: TOA,
    ...p,
  };
};

const daChi = (p: Partial<SettlementRow> = {}) => dong({
  status: 'paid', approvalStatus: 'APPROVED', postingStatus: 'POSTED',
  bookName: 'Quỹ tiền mặt', ...p,
});

const ve = (rows: SettlementRow[], opts: Partial<KetQuaChi> = {}, period = KY) => {
  H.chi = {
    rows, postingRead: true, isLoading: false, isError: false,
    refetch: () => { H.soLanRefetch += 1; },
    ...opts,
  } satisfies KetQuaChi;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return render(
    createElement(ContractSettlementSection, { buildingIds: [TOA], period }),
    { wrapper },
  );
};

// ── Bộ chọn ổn định ─────────────────────────────────────────────────────────
const oKy = () => screen.getByLabelText('Phạm vi kỳ') as HTMLSelectElement;
const oTrangThai = () => screen.getByLabelText('Trạng thái') as HTMLSelectElement;
const moBoLoc = () => fireEvent.click(screen.getByRole('button', { name: 'Bộ lọc' }));
const optionKy = () => [...oKy().options].map((o) => o.value);
const dongBang = () => [...document.querySelectorAll<HTMLElement>('.cs-row')];
const the = (nhan: string) =>
  [...document.querySelectorAll<HTMLElement>('.cs-stat')]
    .find((el) => el.textContent?.includes(nhan));
const dongKetQua = () => document.querySelector('.cs-resline')?.textContent ?? '';
const chanTrang = () => document.querySelector('.cs-foot')?.textContent ?? '';

beforeEach(() => {
  // Kho này KHÔNG bật `globals` cho vitest, nên RTL không tự đăng ký afterEach
  // dọn DOM — thiếu dòng này thì mỗi bài render chồng lên bài trước và mọi phép
  // đếm dòng/thẻ đều sai theo kiểu rất khó lần.
  cleanup();
  dem = 0;
  H.soLanRefetch = 0;
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Tất Cả + Đã chi
// ═══════════════════════════════════════════════════════════════════════════

describe('Tất Cả + Đã chi', () => {
  const tap = () => [
    daChi({ amount: 3_000_000, eventDate: '2026-08-20', postedOn: '2026-09-03' }),
    daChi({ amount: 4_000_000, eventDate: '2026-05-01', postedOn: '2026-05-02' }),
    dong({ status: 'noncash', approvalStatus: 'APPROVED', postingStatus: 'NOT_APPLICABLE',
      postingMode: 'NON_CASH', amount: 9_515_634, eventDate: '2026-09-07' }),
    dong({ amount: 1_000_000 }),
  ];

  it('giữ đủ phiếu đã chi và KHÔNG nuốt phiếu không ghi quỹ vào đó', () => {
    ve(tap());
    moBoLoc();
    fireEvent.change(oTrangThai(), { target: { value: 'paid' } });
    fireEvent.change(oKy(), { target: { value: 'all' } });

    expect(dongBang()).toHaveLength(2);
    // Soi trong BẢNG: thẻ "Không ghi quỹ" vẫn có quyền hiện số của nó.
    const bang = dongBang().map((d) => d.textContent ?? '').join(' ');
    expect(bang).not.toContain('9.515.634');
    expect(dongKetQua()).toContain('2 khoản');
  });

  it('Không ghi quỹ là bộ lọc riêng, có tập dòng riêng', () => {
    ve(tap());
    moBoLoc();
    fireEvent.change(oTrangThai(), { target: { value: 'noncash' } });
    fireEvent.change(oKy(), { target: { value: 'all' } });

    expect(dongBang()).toHaveLength(1);
    expect(screen.getByText(fmtMoney(9_515_634))).toBeTruthy();
  });

  it('thẻ Đã chi và thẻ Không ghi quỹ là HAI thẻ, số không lẫn nhau', () => {
    ve(tap());
    fireEvent.change(oKy(), { target: { value: 'all' } });
    expect(the('Đã chi')?.textContent).toContain('2 phiếu');
    expect(the('Đã chi')?.textContent).toContain(fmtMoney(7_000_000));
    expect(the('Không ghi quỹ')?.textContent).toContain('1 phiếu');
    expect(the('Không ghi quỹ')?.textContent).toContain(fmtMoney(9_515_634));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Ba phạm vi kỳ
// ═══════════════════════════════════════════════════════════════════════════

describe('ba phạm vi kỳ', () => {
  const tap = () => [
    dong({ amount: 1_000_000, eventDate: '2026-09-05' }),            // kỳ này, chờ duyệt
    dong({ amount: 2_000_000, eventDate: '2026-08-15' }),            // tồn cũ, chờ duyệt
    daChi({ amount: 3_000_000, eventDate: '2026-08-20', postedOn: '2026-09-03' }),
    daChi({ amount: 4_000_000, eventDate: '2026-05-01', postedOn: '2026-05-02' }),
  ];

  it('mặc định là Kỳ hiện tại, nhãn mang đúng kỳ của trang', () => {
    ve(tap());
    expect(oKy().value).toBe('current');
    expect(within(oKy()).getByText('Kỳ hiện tại (09/2026)')).toBeTruthy();
    expect(within(oKy()).getByText('Tồn Cũ')).toBeTruthy();
    expect(within(oKy()).getByText('Tất Cả')).toBeTruthy();
  });

  it('Kỳ hiện tại: việc chưa xong theo ngày phiếu, đã chi theo ngày ghi sổ', () => {
    ve(tap());
    // 1 phiếu chờ duyệt của kỳ + 1 phiếu chi trong kỳ (lập từ tháng 8).
    expect(dongBang()).toHaveLength(1);           // Cần xử lý là mặc định
    fireEvent.change(oKy(), { target: { value: 'current' } });
    moBoLoc();
    fireEvent.change(oTrangThai(), { target: { value: 'all' } });
    expect(dongBang()).toHaveLength(2);
    expect(screen.getByText(fmtMoney(3_000_000))).toBeTruthy();  // chi tháng 9
    expect(screen.queryByText(fmtMoney(4_000_000))).toBeNull();  // chi tháng 5
  });

  it('Tồn Cũ: chỉ việc chưa xong của kỳ trước, không có phiếu đã chi', () => {
    ve(tap());
    fireEvent.change(oKy(), { target: { value: 'prior' } });
    expect(dongBang()).toHaveLength(1);
    expect(screen.getByText(fmtMoney(2_000_000))).toBeTruthy();
  });

  it('Kỳ hiện tại + Tồn Cũ KHÁC Tất Cả — Tất Cả còn chứa lịch sử đã xong', () => {
    ve(tap());
    moBoLoc();
    fireEvent.change(oTrangThai(), { target: { value: 'all' } });
    fireEvent.change(oKy(), { target: { value: 'current' } });
    const hienTai = dongBang().length;
    fireEvent.change(oKy(), { target: { value: 'all' } });
    const tatCa = dongBang().length;
    expect(tatCa).toBe(4);
    expect(tatCa).toBeGreaterThan(hienTai + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Chuyển phạm vi × trạng thái — MỘT normalizer cho mọi lối vào
// ═══════════════════════════════════════════════════════════════════════════

describe('chuyển Tồn Cũ sang trạng thái lịch sử', () => {
  const tap = () => [
    dong({ amount: 2_000_000, eventDate: '2026-08-15' }),
    daChi({ amount: 3_000_000, eventDate: '2026-08-20', postedOn: '2026-09-03' }),
    dong({ status: 'noncash', approvalStatus: 'APPROVED', postingStatus: 'NOT_APPLICABLE',
      amount: 9_000_000, eventDate: '2026-09-07' }),
  ];

  it('qua DROPDOWN: scope về Kỳ hiện tại, bỏ hẳn option Tồn Cũ, nhãn đổi theo', () => {
    ve(tap());
    fireEvent.change(oKy(), { target: { value: 'prior' } });
    expect(oKy().value).toBe('prior');
    expect(optionKy()).toContain('prior');

    moBoLoc();
    fireEvent.change(oTrangThai(), { target: { value: 'paid' } });

    expect(oKy().value).toBe('current');
    expect(optionKy()).toEqual(['current', 'all']);
    expect(dongKetQua()).toContain('Kỳ hiện tại (09/2026)');
    // Và bảng KHÔNG rỗng vì còn giữ scope cũ.
    expect(dongBang()).toHaveLength(1);
  });

  it('qua THẺ SỐ: cùng một luật, không để lại prior bị ẩn', () => {
    ve(tap());
    fireEvent.change(oKy(), { target: { value: 'prior' } });
    fireEvent.click(the('Đã chi')!);

    expect(oKy().value).toBe('current');
    expect(optionKy()).not.toContain('prior');
    expect(dongBang()).toHaveLength(1);
  });

  it('cùng luật đó cho Không ghi quỹ và Hoàn tác', () => {
    for (const v of ['noncash', 'reversed', 'cancelled', 'unknown']) {
      const { unmount } = ve(tap());
      fireEvent.change(oKy(), { target: { value: 'prior' } });
      moBoLoc();
      fireEvent.change(oTrangThai(), { target: { value: v } });
      expect(oKy().value, v).toBe('current');
      expect(optionKy(), v).toEqual(['current', 'all']);
      unmount();
    }
  });

  it('Tồn Cũ + Tất cả trạng thái thì về Cần xử lý, giữ phạm vi', () => {
    ve(tap());
    moBoLoc();
    fireEvent.change(oTrangThai(), { target: { value: 'all' } });
    fireEvent.change(oKy(), { target: { value: 'prior' } });
    expect(oKy().value).toBe('prior');
    expect(oTrangThai().value).toBe('open');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Thẻ lịch sử trên Tồn Cũ: KHÔNG ĐƯỢC hiện số 0 như kết quả tiền thật
// ═══════════════════════════════════════════════════════════════════════════

describe('thẻ lịch sử khi đang ở Tồn Cũ', () => {
  it('Đã chi và Không ghi quỹ nói "Không áp dụng cho tồn cũ", không nói 0đ', () => {
    ve([dong({ amount: 2_000_000, eventDate: '2026-08-15' })]);
    fireEvent.change(oKy(), { target: { value: 'prior' } });

    expect(the('Đã chi')?.textContent).toContain('Không áp dụng cho tồn cũ');
    expect(the('Đã chi')?.textContent).not.toContain('0 đ');
    expect(the('Không ghi quỹ')?.textContent).toContain('Không áp dụng cho tồn cũ');
  });

  it('thẻ việc chưa xong vẫn có số thật trên Tồn Cũ', () => {
    ve([dong({ amount: 2_000_000, eventDate: '2026-08-15' })]);
    fireEvent.change(oKy(), { target: { value: 'prior' } });
    expect(the('Chờ Duyệt và Chi')?.textContent).toContain(fmtMoney(2_000_000));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Đọc được phiếu nhưng KHÔNG đọc được bút toán
// ═══════════════════════════════════════════════════════════════════════════

describe('bút toán bị RLS giấu hoặc tải lỗi', () => {
  const tap = () => [
    daChi({ amount: 3_000_000, eventDate: '2026-09-02', postedOn: null }),
    dong({ amount: 1_000_000, eventDate: '2026-09-05' }),
  ];

  it('thẻ Đã chi nói "Chưa đủ dữ liệu" kèm nút thử lại, KHÔNG nói 0đ', () => {
    ve(tap(), { postingRead: 'partial' });
    expect(the('Đã chi')?.textContent).toContain('Chưa đủ dữ liệu');
    expect(the('Đã chi')?.textContent).not.toContain('0 đ');
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(H.soLanRefetch).toBe(1);
  });

  it('dòng vẫn là Đã chi, chỉ đánh dấu ngày chi chưa xác minh', () => {
    ve(tap(), { postingRead: 'partial' });
    moBoLoc();
    fireEvent.change(oTrangThai(), { target: { value: 'all' } });
    fireEvent.change(oKy(), { target: { value: 'all' } });
    const daChiRow = dongBang().find((d) => d.textContent?.includes('Ngày chi chưa xác minh'));
    expect(daChiRow, 'phải có dòng ngày chi chưa xác minh').toBeTruthy();
    expect(within(daChiRow!).getByText('Đã chi')).toBeTruthy();
    // KHÔNG bị hạ xuống chờ chi và KHÔNG mời chi lại.
    expect(within(daChiRow!).queryByText('Chi tiền')).toBeNull();
    expect(within(daChiRow!).getByText('Xem phiếu')).toBeTruthy();
  });

  it('phiếu chưa xếp được kỳ được BÁO RA, không âm thầm biến mất', () => {
    ve(tap(), { postingRead: 'partial' });
    expect(document.body.textContent).toContain('chưa xác định kỳ');
  });

  it('lỗi đọc bút toán không làm hỏng cả bảng', () => {
    ve(tap(), { postingRead: false });
    expect(document.querySelector('.cs-fail')).toBeNull();
    expect(the('Đã chi')?.textContent).toContain('Chưa đủ dữ liệu');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Tập nền chung: thẻ, chip, bảng, chân trang phải khớp nhau
// ═══════════════════════════════════════════════════════════════════════════

describe('một tập nền chung cho thẻ / chip / bảng / chân trang', () => {
  const tap = () => [
    dong({ kind: 'refund', amount: 1_000_000, eventDate: '2026-09-05' }),
    dong({ kind: 'commission', amount: 2_000_000, eventDate: '2026-09-06',
      issues: ['MISSING_PAYMENT_INFO'], recipientName: null }),
    daChi({ kind: 'refund', amount: 3_000_000, eventDate: '2026-09-01', postedOn: '2026-09-03' }),
  ];

  it('bấm thẻ nào thì count và tổng tiền khớp đúng tập dòng của thẻ đó', () => {
    ve(tap());
    fireEvent.click(the('Đã chi')!);
    expect(dongBang()).toHaveLength(1);
    expect(dongKetQua()).toContain('1 khoản');
    expect(chanTrang()).toContain(fmtMoney(3_000_000));
  });

  it('thẻ khác KHÔNG về 0 khi đang lọc theo một thẻ', () => {
    ve(tap());
    fireEvent.click(the('Đã chi')!);
    expect(the('Cần rà soát')?.textContent).toContain('1');
    expect(the('Chờ Duyệt và Chi')?.textContent).toContain(fmtMoney(1_000_000));
  });

  it('chip loại TÔN TRỌNG trạng thái đang chọn', () => {
    ve(tap());
    fireEvent.click(the('Đã chi')!);
    const chips = [...document.querySelectorAll<HTMLElement>('.cs-chip')];
    const hoanKhach = chips.find((c) => c.textContent?.startsWith('Hoàn khách'));
    const hoaHong = chips.find((c) => c.textContent?.startsWith('Hoa hồng'));
    expect(hoanKhach?.textContent).toContain('1');
    expect(hoaHong?.textContent).toContain('0');
  });

  it('tìm kiếm cắt cả thẻ lẫn bảng, không chỉ bảng', () => {
    ve(tap());
    moBoLoc();
    fireEvent.change(oTrangThai(), { target: { value: 'all' } });
    fireEvent.change(screen.getByPlaceholderText(/Tìm phòng/), { target: { value: 'PC3' } });
    expect(dongBang()).toHaveLength(1);
    expect(the('Chờ Duyệt và Chi')?.textContent).toContain('0 chờ duyệt');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Chân trang nói đúng cái nó đang làm
// ═══════════════════════════════════════════════════════════════════════════

describe('chân trang', () => {
  const tap = () => [
    dong({ amount: 1_000_000, eventDate: '2026-09-05' }),
    daChi({ amount: 3_000_000, eventDate: '2026-09-01', postedOn: '2026-09-03' }),
  ];

  it('lọc Đã chi thì nói theo NGÀY GHI SỔ', () => {
    ve(tap());
    fireEvent.click(the('Đã chi')!);
    expect(chanTrang()).toContain('ngày ghi sổ');
  });

  it('lọc việc chưa xong thì nói theo NGÀY PHIẾU', () => {
    ve(tap());
    expect(chanTrang()).toContain('ngày phiếu');
    expect(chanTrang()).not.toContain('ngày chi thực tế');
  });

  it('nhiều trạng thái thì tách Tổng giá trị phiếu và Đã chi thực tế', () => {
    ve(tap());
    moBoLoc();
    fireEvent.change(oTrangThai(), { target: { value: 'all' } });
    expect(chanTrang()).toContain('Tổng giá trị phiếu đang xem');
    expect(chanTrang()).toContain('Đã chi thực tế');
    expect(chanTrang()).toContain(fmtMoney(4_000_000));
    expect(chanTrang()).toContain(fmtMoney(3_000_000));
  });

  it('không gọi tiền của sổ ảo/hủy là thực chi', () => {
    ve([
      dong({ status: 'noncash', approvalStatus: 'APPROVED', postingStatus: 'NOT_APPLICABLE',
        amount: 9_000_000, eventDate: '2026-09-07' }),
      dong({ status: 'cancelled', approvalStatus: 'CANCELLED', amount: 5_000_000,
        eventDate: '2026-09-08' }),
    ]);
    moBoLoc();
    fireEvent.change(oTrangThai(), { target: { value: 'all' } });
    expect(chanTrang()).toContain('Đã chi thực tế: 0 đ');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Đổi kỳ chung và Bỏ lọc — không để lại tháng cũ ở đâu
// ═══════════════════════════════════════════════════════════════════════════

describe('đổi kỳ chung và bỏ lọc', () => {
  const tap = () => [
    dong({ amount: 1_000_000, eventDate: '2026-09-05' }),
    dong({ amount: 2_000_000, eventDate: '2026-10-05' }),
  ];

  it('đổi period của trang thì phạm vi đi theo, không giữ tháng cũ', () => {
    H.chi = {
      rows: tap(), postingRead: true, isLoading: false, isError: false, refetch: () => {},
    } satisfies KetQuaChi;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { rerender } = render(
      createElement(ContractSettlementSection, { buildingIds: [TOA], period: '2026-09' }),
      { wrapper },
    );
    expect(dongBang()).toHaveLength(1);
    expect(screen.getByText(fmtMoney(1_000_000))).toBeTruthy();

    rerender(createElement(QueryClientProvider, { client },
      createElement(ContractSettlementSection, { buildingIds: [TOA], period: '2026-10' })));

    expect(within(oKy()).getByText('Kỳ hiện tại (10/2026)')).toBeTruthy();
    expect(dongBang()).toHaveLength(1);
    expect(screen.getByText(fmtMoney(2_000_000))).toBeTruthy();
  });

  it('Bỏ bộ lọc đưa về Kỳ hiện tại và Cần xử lý', () => {
    ve(tap());
    moBoLoc();
    fireEvent.change(oTrangThai(), { target: { value: 'paid' } });
    fireEvent.change(oKy(), { target: { value: 'all' } });
    fireEvent.click(document.querySelector('.cs-clear') as HTMLButtonElement);
    expect(oKy().value).toBe('current');
    expect(oTrangThai().value).toBe('open');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Phiếu hoàn tác: có trạng thái riêng, KHÔNG mời chi lại
// ═══════════════════════════════════════════════════════════════════════════

describe('phiếu hoàn tác', () => {
  const tap = () => [dong({
    status: 'reversed', approvalStatus: 'APPROVED', postingStatus: 'REVERSED',
    amount: 700_000, eventDate: '2026-09-09',
  })];

  it('không nằm trong Cần xử lý và không có nút Chi tiền', () => {
    ve(tap());
    expect(dongBang()).toHaveLength(0);
    moBoLoc();
    fireEvent.change(oTrangThai(), { target: { value: 'reversed' } });
    expect(dongBang()).toHaveLength(1);
    const r = dongBang()[0];
    expect(within(r).getByText('Đã hoàn tác')).toBeTruthy();
    expect(within(r).queryByText('Chi tiền')).toBeNull();
    expect(within(r).getByText('Xem phiếu')).toBeTruthy();
  });

  it('không bị gắn nhãn tồn kỳ trước như việc còn phải làm', () => {
    ve([dong({
      status: 'reversed', approvalStatus: 'APPROVED', postingStatus: 'REVERSED',
      amount: 700_000, eventDate: '2026-07-09',
    })]);
    moBoLoc();
    fireEvent.change(oTrangThai(), { target: { value: 'reversed' } });
    fireEvent.change(oKy(), { target: { value: 'all' } });
    expect(screen.queryByText('Tồn kỳ trước')).toBeNull();
    expect(document.querySelector('.cs-tag-ton')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Empty state không được suy "mọi việc đã xong"
// ═══════════════════════════════════════════════════════════════════════════

describe('không có kết quả', () => {
  it('chỉ nói không có kết quả phù hợp trong phạm vi đang xem', () => {
    ve([daChi({ amount: 3_000_000, eventDate: '2026-05-01', postedOn: '2026-05-02' })]);
    const t = document.querySelector('.cs-empty')?.textContent ?? '';
    expect(t).toContain('Không có khoản nào');
    expect(t).not.toContain('đã được chi hoặc từ chối');
  });
});
