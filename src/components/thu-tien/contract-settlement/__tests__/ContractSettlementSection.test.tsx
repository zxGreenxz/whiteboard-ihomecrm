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
/**
 * Trạng thái ĐANG LỌC đọc từ dòng kết quả, không từ ô select — ô đó chỉ tồn tại
 * khi mở vùng bộ lọc nâng cao, mà thẻ số và checkbox gộp đổi trạng thái được cả
 * khi vùng đó đang đóng. Dòng kết quả là thứ người dùng thật sự nhìn.
 */
const nhanTrangThai = () => (dongKetQua().split(' · ')[1] ?? '');

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
// 5. Phiếu ĐÃ CHI mà không đọc được ngày ghi sổ
//
// ⚠ Bốn bài dưới đây KHÔNG truyền `postingRead`, và đó là CHỦ Ý. Thứ điều
// khiển chúng là `postedOn === null` (và `isError` ở bài cuối) — trước đây
// fixture có gắn `postingRead` nhưng đặt giá trị nào cũng xanh, tức là nó nói
// dối về nhân quả và người sau sẽ đi sửa nhầm chỗ. `postingRead` được kiểm
// đúng nghĩa ở khối 12, nơi ba giá trị cho ba câu chữ khác nhau.
// ═══════════════════════════════════════════════════════════════════════════

describe('phiếu đã chi mà thiếu ngày ghi sổ', () => {
  const tap = () => [
    daChi({ amount: 3_000_000, eventDate: '2026-09-02', postedOn: null }),
    dong({ amount: 1_000_000, eventDate: '2026-09-05' }),
  ];

  it('thẻ Đã chi nói "Chưa đủ dữ liệu" kèm nút thử lại, KHÔNG nói 0đ', () => {
    ve(tap());
    expect(the('Đã chi')?.textContent).toContain('Chưa đủ dữ liệu');
    expect(the('Đã chi')?.textContent).not.toContain('0 đ');
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(H.soLanRefetch).toBe(1);
  });

  it('dòng vẫn là Đã chi, chỉ đánh dấu ngày chi chưa xác minh', () => {
    ve(tap());
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
    ve(tap());
    // Banner đếm TRONG trạng thái đang lọc, nên phải đứng ở bộ lọc thật sự chứa
    // phiếu đó — xem khối "banner chưa xác định kỳ" ở dưới cho cả hai chiều.
    fireEvent.click(the('Đã chi')!);
    expect(document.body.textContent).toContain('chưa xác định kỳ');
    expect(dongBang()).toHaveLength(0);   // và nó KHÔNG lặng lẽ nằm trong bảng
  });

  // Thiếu ngày ghi sổ là chuyện của MỘT con số, không phải lỗi của cả bảng:
  // `.cs-fail` chỉ dựng khi `isError`, và `isError` không hề đi theo `postedOn`.
  it('thiếu ngày ghi sổ không làm hỏng cả bảng', () => {
    ve(tap());
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

// ═══════════════════════════════════════════════════════════════════════════
// 11. "Đã chi thực tế" KHÔNG gộp tiền chứng minh được với tiền không chứng
//     minh được — bất kể có treo nhãn gì lên cái tổng đó.
// ═══════════════════════════════════════════════════════════════════════════

describe('tiền chứng minh được tách khỏi tiền chưa chứng minh được', () => {
  it('Tất Cả: chân trang cộng đúng phần có ngày ghi sổ, phần còn lại là số đếm', () => {
    ve([
      daChi({ amount: 2_000_000, eventDate: '2026-09-01', postedOn: '2026-09-03' }),
      daChi({ amount: 1_000_000, eventDate: '2026-09-02', postedOn: null }),
    ], { postingRead: 'partial' });
    moBoLoc();
    fireEvent.change(oTrangThai(), { target: { value: 'all' } });
    fireEvent.change(oKy(), { target: { value: 'all' } });

    // Tiền = 2.000.000 (phần chứng minh được), KHÔNG phải 3.000.000.
    expect(chanTrang()).toContain('Đã chi thực tế: 2.000.000 đ');
    expect(chanTrang()).not.toContain('Đã chi thực tế: 3.000.000 đ');
    // Phiếu còn lại xuất hiện dưới dạng SỐ ĐẾM, không kèm tiền.
    expect(chanTrang()).toContain('1 phiếu chưa xác minh');
  });

  /**
   * CA CỦA CHỦ CÔNG TY — 0 dòng bút toán đọc được, và đây là màn hình MẶC ĐỊNH
   * của người dùng chính (đo thật 22/09/2026: 1139 phiếu POSTED, 0 dòng
   * posting, 154 phiếu đã chi trong kỳ đang xem).
   *
   * ⚠ "0 đ" ở đây là SAI và bài này từng ghim đúng cái sai đó. Chứng minh được
   * 0 phiếu không phải "không có đồng nào đã chi" — nó là "chưa chứng minh
   * được đồng nào". Hai câu khác hẳn nhau khi nói về tiền (plan §3.4, docblock
   * `StatValue`). Ca "0 đ là sự thật" nằm ở bài 'không gọi tiền của sổ ảo/hủy
   * là thực chi' — hai ca đó PHẢI phân biệt được với nhau.
   */
  it('không chứng minh được đồng nào: KHÔNG in 0 đ, và nói rõ còn bao nhiêu phiếu', () => {
    ve([
      daChi({ amount: 4_000_000, eventDate: '2026-09-01', postedOn: null }),
      daChi({ amount: 5_000_000, eventDate: '2026-09-02', postedOn: null }),
    ], { postingRead: 'partial' });
    moBoLoc();
    fireEvent.change(oTrangThai(), { target: { value: 'all' } });
    fireEvent.change(oKy(), { target: { value: 'all' } });

    expect(chanTrang()).not.toContain('Đã chi thực tế: 0 đ');
    expect(chanTrang()).toContain('Đã chi thực tế: —');
    expect(chanTrang()).toContain('2 phiếu chưa xác minh');
    // Thẻ số cũng vậy: đầu thẻ là "—", không phải một con số 0 đọc như sự thật.
    expect(the('Đã chi')?.querySelector('.cs-stat-num')?.textContent).toBe('—');
    // Mệnh giá của chúng vẫn được phép nằm ở "Tổng giá trị phiếu đang xem" —
    // đó là mệnh giá, không phải tiền đã rời két. Nhưng TUYỆT ĐỐI không được
    // nằm sau nhãn thực chi.
    const sauNhan = chanTrang().split('Đã chi thực tế:')[1] ?? '';
    expect(sauNhan).not.toContain('9.000.000');
  });

  it('thẻ Đã chi ở Tất Cả cũng tách hai con số, không gộp rồi dán nhãn', () => {
    ve([
      daChi({ amount: 2_000_000, eventDate: '2026-09-01', postedOn: '2026-09-03' }),
      daChi({ amount: 1_000_000, eventDate: '2026-09-02', postedOn: null }),
    ], { postingRead: 'partial' });
    fireEvent.change(oKy(), { target: { value: 'all' } });

    const t = the('Đã chi')?.textContent ?? '';
    expect(t).toContain(fmtMoney(2_000_000));
    expect(t).not.toContain(fmtMoney(3_000_000));
    expect(t).toContain('1 phiếu chưa xác minh');
  });

  it('đọc đủ ngày thì không treo nhãn chưa xác minh lên gì cả', () => {
    ve([
      daChi({ amount: 2_000_000, eventDate: '2026-09-01', postedOn: '2026-09-03' }),
      dong({ amount: 1_000_000, eventDate: '2026-09-05' }),
    ]);
    moBoLoc();
    fireEvent.change(oTrangThai(), { target: { value: 'all' } });
    fireEvent.change(oKy(), { target: { value: 'all' } });
    expect(chanTrang()).toContain('Đã chi thực tế: 2.000.000 đ');
    expect(chanTrang()).not.toContain('chưa xác minh');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. `postingRead` phải THẬT SỰ điều khiển một thứ gì đó
//
// Ba nguyên nhân khác hẳn nhau và người dùng làm việc khác nhau với từng cái:
// thử lại được / phải đi xin quyền / thôi đừng chờ nữa. Nếu ba ca cùng ra một
// câu chữ thì fixture nói dối về nhân quả — đặt `postingRead` kiểu gì cũng
// xanh, và người sau sẽ đi sửa nhầm chỗ.
// ═══════════════════════════════════════════════════════════════════════════

describe('postingRead điều khiển lời giải thích', () => {
  const tap = () => [daChi({ amount: 3_000_000, eventDate: '2026-09-02', postedOn: null })];

  it('lỗi tải thì nói là lỗi tải', () => {
    ve(tap(), { postingRead: false });
    expect(the('Đã chi')?.textContent).toContain('lỗi tải bút toán');
  });

  it('RLS giấu thì nói là cần quyền giữ sổ quỹ', () => {
    ve(tap(), { postingRead: 'partial' });
    expect(the('Đã chi')?.textContent).toContain('cần quyền giữ sổ quỹ');
    expect(the('Đã chi')?.textContent).not.toContain('lỗi tải');
  });

  it('đọc đủ mà phiếu vẫn không có bút toán thì nói đúng như vậy', () => {
    ve(tap(), { postingRead: true });
    expect(the('Đã chi')?.textContent).toContain('không có bút toán hiệu lực');
    expect(the('Đã chi')?.textContent).not.toContain('cần quyền');
  });

  it('ba ca đều là Chưa đủ dữ liệu và đều có nút thử lại', () => {
    for (const st of [false, 'partial', true] as const) {
      const { unmount } = ve(tap(), { postingRead: st });
      expect(the('Đã chi')?.textContent, String(st)).toContain('Chưa đủ dữ liệu');
      expect(screen.getByRole('button', { name: 'Thử lại' }), String(st)).toBeTruthy();
      unmount();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. Banner "chưa xác định kỳ" phải đếm TRONG trạng thái đang lọc
//
// Nếu không, màn hình mặc định của chủ công ty (Cần xử lý · Kỳ hiện tại) sẽ
// treo suốt ngày câu "Có 1139 khoản chưa xác định kỳ" — đúng sự thật nhưng nói
// về một tập không hề nằm trong bộ lọc đang xem.
// ═══════════════════════════════════════════════════════════════════════════

describe('banner chưa xác định kỳ', () => {
  const tap = () => [
    daChi({ amount: 3_000_000, eventDate: '2026-09-02', postedOn: null }),
    dong({ amount: 1_000_000, eventDate: '2026-09-05' }),
  ];

  it('KHÔNG hiện ở màn mặc định Cần xử lý vì phiếu đó là Đã chi', () => {
    ve(tap(), { postingRead: 'partial' });
    expect(document.body.textContent).not.toContain('chưa xác định kỳ');
  });

  it('hiện khi bộ lọc trạng thái thật sự chứa phiếu đó', () => {
    ve(tap(), { postingRead: 'partial' });
    fireEvent.click(the('Đã chi')!);
    expect(document.body.textContent).toContain('1 khoản chưa xác định kỳ');
  });

  it('chip loại cũng cắt banner — không đếm loại đang bị lọc ra', () => {
    ve([
      daChi({ kind: 'refund', amount: 3_000_000, eventDate: '2026-09-02', postedOn: null }),
      daChi({ kind: 'commission', amount: 2_000_000, eventDate: '2026-09-02', postedOn: null }),
    ], { postingRead: 'partial' });
    fireEvent.click(the('Đã chi')!);
    expect(document.body.textContent).toContain('2 khoản chưa xác định kỳ');
    const chip = [...document.querySelectorAll<HTMLElement>('.cs-chip')]
      .find((c) => c.textContent?.startsWith('Hoa hồng'));
    fireEvent.click(chip!);
    expect(document.body.textContent).toContain('1 khoản chưa xác định kỳ');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. Gộp Chờ duyệt–Chi: LỐI THỨ BA vào normalizer
//
// Hai lối kia (dropdown, thẻ số) đã có bài. Lối này thì chưa, mà nó cũng ghi
// thẳng vào `{scope, status}`. Ở Tồn Cũ + pendpay, bỏ tick ra `{prior, open}` —
// đúng, nhưng chỉ vì `LOC_VIEC_CHUA_XONG` tình cờ có 'open'. Đổi một dòng trong
// `normalisePeriodFilter` là rơi thẳng vào bẫy "prior nấp sau trạng thái lịch
// sử ⇒ bảng rỗng" mà cả nhiệm vụ này sinh ra để diệt.
// ═══════════════════════════════════════════════════════════════════════════

describe('bật/tắt gộp Chờ duyệt và Chi', () => {
  const oGop = () => screen.getByLabelText('Gộp Chờ duyệt và Chi') as HTMLInputElement;
  const tap = () => [
    dong({ amount: 1_000_000, eventDate: '2026-09-05' }),
    dong({ status: 'approved', approvalStatus: 'APPROVED', postingStatus: 'UNPOSTED',
      amount: 2_000_000, eventDate: '2026-09-06' }),
    dong({ amount: 3_000_000, eventDate: '2026-08-15' }),
    daChi({ amount: 4_000_000, eventDate: '2026-09-01', postedOn: '2026-09-03' }),
  ];

  it('bật: một thẻ gộp; tắt: hai thẻ rời, số cộng lại bằng thẻ gộp', () => {
    ve(tap());
    expect(the('Chờ Duyệt và Chi')?.textContent).toContain(fmtMoney(3_000_000));
    fireEvent.click(oGop());
    expect(the('Chờ Duyệt và Chi')).toBeUndefined();
    expect(the('Chờ duyệt')?.textContent).toContain(fmtMoney(1_000_000));
    expect(the('Chờ chi')?.textContent).toContain(fmtMoney(2_000_000));
  });

  it('tắt gộp khi ĐANG lọc theo thẻ gộp: về Cần xử lý, GIỮ phạm vi hiện tại', () => {
    ve(tap());
    fireEvent.click(the('Chờ Duyệt và Chi')!);
    expect(nhanTrangThai()).toBe('Chờ duyệt và chi');
    fireEvent.click(oGop());
    expect(nhanTrangThai()).toBe('Cần xử lý');
    expect(oKy().value).toBe('current');
    expect(dongBang()).toHaveLength(2);
  });

  // Ô THỨ TƯ của ma trận (gộp × phạm vi) — chỗ dễ vỡ nhất.
  it('ở Tồn Cũ, tắt gộp KHÔNG được để lại phạm vi nấp sau trạng thái lịch sử', () => {
    ve(tap());
    fireEvent.change(oKy(), { target: { value: 'prior' } });
    fireEvent.click(the('Chờ Duyệt và Chi')!);
    expect(oKy().value).toBe('prior');
    expect(dongBang()).toHaveLength(1);           // đúng một phiếu tồn tháng 8

    fireEvent.click(oGop());
    // Tổ hợp còn lại PHẢI hợp lệ: trạng thái mới vẫn phải cho phép phạm vi đang giữ.
    expect(nhanTrangThai()).toBe('Cần xử lý');
    expect(oKy().value).toBe('prior');
    expect(optionKy()).toContain('prior');
    expect(dongBang()).toHaveLength(1);           // và bảng KHÔNG rỗng
  });

  it('bật lại gộp ở Tồn Cũ cũng không sinh tổ hợp chết', () => {
    ve(tap());
    fireEvent.change(oKy(), { target: { value: 'prior' } });
    fireEvent.click(oGop());                       // tắt
    fireEvent.click(the('Chờ duyệt')!);
    expect(nhanTrangThai()).toBe('Chờ duyệt');
    fireEvent.click(oGop());                       // bật lại
    expect(nhanTrangThai()).toBe('Cần xử lý');
    expect(oKy().value).toBe('prior');
    expect(dongBang()).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. Tòa / nguồn / vướng mắc cũng phải cắt CẢ thẻ, chip, bảng lẫn chân trang
// ═══════════════════════════════════════════════════════════════════════════

describe('tòa, nguồn và vướng mắc cắt cùng một tập nền', () => {
  const TOA_B = '0b0b0b0b-0000-4000-8000-000000000002';
  const tap = () => [
    dong({ amount: 1_000_000, eventDate: '2026-09-05' }),
    dong({ amount: 2_000_000, eventDate: '2026-09-06', buildingId: TOA_B, buildingName: 'Toà B' }),
    dong({ amount: 4_000_000, eventDate: '2026-09-07', origin: 'reservation',
      systemSource: 'reservation.refund.v1' }),
    dong({ amount: 8_000_000, eventDate: '2026-09-08',
      recipientName: null, issues: ['MISSING_PAYMENT_INFO'] }),
  ];

  it('lọc tòa cắt thẻ, chip, bảng và chân trang cùng lúc', () => {
    ve(tap());
    expect(dongBang()).toHaveLength(4);
    fireEvent.change(screen.getByLabelText('Tòa'), { target: { value: TOA_B } });

    expect(dongBang()).toHaveLength(1);
    expect(the('Chờ Duyệt và Chi')?.textContent).toContain(fmtMoney(2_000_000));
    expect(the('Cần rà soát')?.textContent).toContain('0');
    expect(chanTrang()).toContain(fmtMoney(2_000_000));
    const chipTatCa = document.querySelector('.cs-chip')?.textContent ?? '';
    expect(chipTatCa).toContain('1');
  });

  it('lọc nguồn Giữ chỗ cắt cùng một tập nền', () => {
    ve(tap());
    moBoLoc();
    fireEvent.change(screen.getByLabelText('Nguồn'), { target: { value: 'reservation' } });

    expect(dongBang()).toHaveLength(1);
    expect(the('Chờ Duyệt và Chi')?.textContent).toContain(fmtMoney(4_000_000));
    expect(chanTrang()).toContain(fmtMoney(4_000_000));
  });

  it('lọc vướng mắc giữ đúng phiếu còn blocker, thẻ đi theo', () => {
    ve(tap());
    moBoLoc();
    fireEvent.change(screen.getByLabelText('Vướng mắc'), { target: { value: 'yes' } });

    expect(dongBang()).toHaveLength(1);
    expect(the('Cần rà soát')?.textContent).toContain('1');
    expect(the('Chờ Duyệt và Chi')?.textContent).toContain('0 chờ duyệt');
    expect(chanTrang()).toContain(fmtMoney(8_000_000));
  });

  it('lọc người nhận cũng đi qua cùng tập nền', () => {
    ve(tap());
    moBoLoc();
    fireEvent.change(screen.getByLabelText('Người nhận'), { target: { value: 'Người nhận' } });
    expect(dongBang()).toHaveLength(3);
    expect(chanTrang()).toContain(fmtMoney(7_000_000));
  });
});
