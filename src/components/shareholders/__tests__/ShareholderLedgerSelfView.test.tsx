// @vitest-environment jsdom
// Màn cổ đông tự xem theo sổ tổng (máy tính): chỉ tiền của chính mình; tỷ lệ % / số toà chỉ khi có quyền
// VÀ máy chủ gửi kèm; phiếu tự lập còn chờ thì "Huỷ yêu cầu"; nút "Chi tạm ứng cho tôi" theo quyền + công tắc.
// Chủ yêu cầu 16/11/2026: bỏ thẻ "Doanh thu và lợi nhuận toà đã chốt"; bảng Nhà × Tháng có bộ lọc nhà tự tạo.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';

const h = vi.hoisted(() => ({ distribute: vi.fn(), cancel: vi.fn() }));

vi.mock('@/pages/reports/finance/ProfitHubShell', () => ({
  ProfitHubSlot: ({ name, children }: { name: string; children?: ReactNode }) => createElement('div', { 'data-slot': name }, children),
}));
vi.mock('@/components/shareholders/ProfitDistributeDialog', () => ({
  default: (props: Record<string, unknown>) => {
    h.distribute(props);
    return props.open ? createElement('div', { 'data-testid': 'advance-dialog' }) : null;
  },
}));
vi.mock('@/components/shareholders/ProfitPayoutCancelDialog', () => ({
  ProfitPayoutCancelDialog: (props: { open: boolean; target: unknown }) => {
    h.cancel(props);
    return props.open ? createElement('div', { 'data-testid': 'cancel-dialog' }) : null;
  },
}));

import ShareholderLedgerSelfView, { type ShareholderSelfAccess } from '../ShareholderLedgerSelfView';

const ledger = (over: Partial<MyProfitLedger> = {}): MyProfitLedger => ({
  organization_id: 'org-a', route: 'CANONICAL', ready: true, shareholder: { id: 'sh-1', name: 'Cổ đông 1' },
  balance: 8_650_000, status: 'OWED', allocated: 15_450_000, paid: 3_000_000, paid_pending: 3_000_000,
  paid_via_salary: 1_200_000, advance_recovered: 400_000,
  marker: null,
  months: [{ period_month: `${new Date().getFullYear()}-08-01`, amount: 2_450_000, excluded_by_marker: false, buildings: [
    { building_id: 'b2', building_name: 'Toà Hai', amount: -1_550_000 }, { building_id: 'b1', building_name: 'Toà Một', amount: 4_000_000 },
  ] }],
  payouts: [
    { voucher_id: 'v1', voucher_code: 'PC-DUYET', voucher_date: '2026-09-01', amount: 3_000_000, status: 'APPROVED', posting_status: 'POSTED', is_advance: false, is_mine: false, is_mine_pending: false, excluded_by_marker: false },
    { voucher_id: 'v2', voucher_code: 'PC-CHO', voucher_date: '2026-10-10', amount: 3_000_000, status: 'UNAPPROVED', posting_status: 'UNPOSTED', is_advance: true, is_mine: true, is_mine_pending: true, excluded_by_marker: false },
    { voucher_id: 'v3', voucher_code: 'PC-CHU-LAP', voucher_date: '2026-10-11', amount: 500_000, status: 'UNAPPROVED', posting_status: 'UNPOSTED', is_advance: false, is_mine: false, is_mine_pending: false, excluded_by_marker: false },
  ],
  salary: [{ period_month: '2026-08-01', investment: 1_200_000, advance_offset: 400_000, excluded_by_marker: false }],
  ...over,
});

const NO_ACCESS: ShareholderSelfAccess = { canViewPercent: false, canViewBuildingTotals: false, canAdvanceOwn: false };
const view = (l: MyProfitLedger, access: Partial<ShareholderSelfAccess> = {}) =>
  render(<ShareholderLedgerSelfView ledger={l} access={{ ...NO_ACCESS, ...access }} />);
const kpis = () => document.querySelector('[data-slot="kpis"]') as HTMLElement;
const SENSITIVE = {
  percent_rows: [{ building_id: 'b1', building_name: 'Toà Một', percent: 20 }],
  building_totals: [{ period_month: `${new Date().getFullYear()}-08-01`, building_id: 'b1', building_name: 'Toà Một', revenue: null, expense: 40_000_000, profit: 60_000_000 }],
};

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value() {}, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { value() { return false; }, configurable: true });
});
beforeEach(() => { vi.clearAllMocks(); window.localStorage.clear(); });
afterEach(cleanup);

describe('ShareholderLedgerSelfView — tiền của chính mình', () => {
  it('KPI theo sổ tổng: được chia, đã nhận + chờ duyệt, qua lương (Y − D), còn được nhận', () => {
    view(ledger());
    expect(within(kpis()).getByTestId('self-kpi-allocated').textContent).toMatch(/15\.450\.000/);
    expect(within(kpis()).getByTestId('self-kpi-paid').textContent).toMatch(/Đã nhận3\.000\.000.*chờ duyệt 3\.000\.000/);
    expect(within(kpis()).getByTestId('self-kpi-salary').textContent).toMatch(/Qua lương800\.000.*trừ tạm ứng 400\.000/);
    expect(within(kpis()).getByTestId('self-kpi-balance').textContent).toMatch(/Còn được nhận8\.650\.000/);
  });

  it('đang tạm ứng ⇒ "Đang tạm ứng" số dương; mốc ⇒ "sau mốc đã trả đủ hết MM/YYYY"', () => {
    view(ledger({ balance: -300_000, status: 'ADVANCE', marker: { settled_through_month: '2026-08-01' } }));
    expect(within(kpis()).getByTestId('self-kpi-balance').textContent).toMatch(/Đang tạm ứng300\.000/);
    expect(within(kpis()).getByTestId('self-kpi-allocated').textContent).toContain('sau mốc đã trả đủ hết 08/2026');
  });

  it('không có dòng lương ⇒ không có ô "Qua lương" (không hiện 0)', () => {
    view(ledger({ salary: [], paid_via_salary: 0, advance_recovered: 0 }));
    expect(screen.queryByTestId('self-kpi-salary')).toBeNull();
  });
});

describe('ShareholderLedgerSelfView — tỷ lệ % và số toà theo quyền', () => {
  it('thiếu quyền ⇒ không "%" trong vùng số, không thẻ tỷ lệ / số toà — kể cả khi payload lỡ mang hai mảng', () => {
    view(ledger(SENSITIVE));
    expect(kpis().textContent).not.toContain('%');
    expect(screen.queryByTestId('self-percent-card')).toBeNull();
    expect(screen.queryByTestId('self-building-totals-card')).toBeNull();
    expect(document.body.textContent).not.toContain('20%');
    expect(document.body.textContent).not.toMatch(/60\.000\.000/);
  });

  it('có quyền + máy chủ gửi ⇒ thẻ "Tỷ lệ của bạn"; thẻ doanh thu / lợi nhuận toà đã bỏ dù có quyền và có dữ liệu', () => {
    view(ledger(SENSITIVE), { canViewPercent: true, canViewBuildingTotals: true });
    expect(screen.getByTestId('self-percent-card').textContent).toMatch(/Toà Một20%/);
    expect(screen.queryByTestId('self-building-totals-card')).toBeNull();
    expect(screen.queryByText(/Doanh thu và lợi nhuận toà đã chốt/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/60\.000\.000/);
    expect(kpis().textContent).not.toContain('%');
  });

  it('có quyền nhưng máy chủ không gửi khoá ⇒ không thẻ (không đoán)', () => {
    view(ledger(), { canViewPercent: true, canViewBuildingTotals: true });
    expect(screen.queryByTestId('self-percent-card')).toBeNull();
    expect(screen.queryByTestId('self-building-totals-card')).toBeNull();
  });
});

describe('ShareholderLedgerSelfView — bộ lọc nhà của bảng Nhà × Tháng', () => {
  const headers = () => screen.getAllByRole('columnheader').map((c) => c.textContent);
  const createFilter = (name: string, building: string) => {
    fireEvent.click(screen.getByRole('button', { name: /Tạo bộ lọc/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Tên bộ lọc'), { target: { value: name } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: building }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lưu bộ lọc' }));
  };

  it('mặc định "Tất cả": đủ cột nhà và "Tổng chia" là tổng cả tháng', () => {
    view(ledger());
    expect(headers()).toEqual(expect.arrayContaining(['Toà Hai', 'Toà Một', 'Tổng chia']));
    expect(screen.getByRole('button', { name: 'Tất cả' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('tạo bộ lọc ⇒ chỉ còn cột nhà đã chọn, tổng theo nhà đang hiện; KPI và phiếu không đổi; "Tất cả" trả lại đủ cột', () => {
    view(ledger());
    const kpiBefore = kpis().textContent;
    createFilter('Chỉ Toà Một', 'Toà Một');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(headers()).toContain('Toà Một');
    expect(headers()).not.toContain('Toà Hai');
    expect(headers()).toContain('Tổng 1 nhà');
    const row = screen.getByRole('cell', { name: 'T8' }).closest('tr') as HTMLElement;
    expect(within(row).getAllByRole('cell').map((c) => c.textContent)).toEqual(['T8', expect.stringMatching(/^4\.000\.000/), expect.stringMatching(/^4\.000\.000/)]);
    expect(screen.getByRole('button', { name: 'Chỉ Toà Một' }).getAttribute('aria-pressed')).toBe('true');
    expect(kpis().textContent).toBe(kpiBefore);
    expect(screen.getAllByRole('button', { name: 'Huỷ yêu cầu' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Tất cả' }));
    expect(headers()).toEqual(expect.arrayContaining(['Toà Hai', 'Toà Một', 'Tổng chia']));
  });

  it('bộ lọc lưu trên trình duyệt theo công ty + cổ đông: mở lại vẫn còn và đang chọn; cổ đông khác không thấy', () => {
    view(ledger());
    createFilter('Chỉ Toà Hai', 'Toà Hai');
    cleanup();
    view(ledger());
    expect(screen.getByRole('button', { name: 'Chỉ Toà Hai' }).getAttribute('aria-pressed')).toBe('true');
    expect(headers()).not.toContain('Toà Một');
    cleanup();
    view(ledger({ shareholder: { id: 'sh-2', name: 'Cổ đông 2' } }));
    expect(screen.queryByRole('button', { name: 'Chỉ Toà Hai' })).toBeNull();
    expect(headers()).toEqual(expect.arrayContaining(['Toà Hai', 'Toà Một']));
  });

  it('bộ lọc trỏ nhà đã rời sổ ⇒ bảng báo rõ, hộp sửa đếm 0 nhà và không cho lưu bộ lọc rỗng', () => {
    window.localStorage.setItem(
      'ihome:ln-nha-thang:bo-loc:v1:org-a:sh-1',
      JSON.stringify({ activeId: 'p1', presets: [{ id: 'p1', name: 'Nhà cũ', keys: ['nha-da-roi-so'] }] }),
    );
    view(ledger());
    expect(screen.getByText(/Bộ lọc “Nhà cũ” không có nhà nào có phần chia/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Sửa bộ lọc/ }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Nhà hiển thị (0/2)');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lưu bộ lọc' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Chọn ít nhất một nhà');
    expect(JSON.parse(window.localStorage.getItem('ihome:ln-nha-thang:bo-loc:v1:org-a:sh-1') ?? '{}').presets[0].keys).toEqual(['nha-da-roi-so']);
  });

  it('thiếu tên hoặc chưa chọn nhà ⇒ báo lỗi trong hộp, không tạo; sửa đổi tên và xoá bộ lọc được', () => {
    view(ledger());
    fireEvent.click(screen.getByRole('button', { name: /Tạo bộ lọc/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Lưu bộ lọc' }));
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('Nhập tên bộ lọc');
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Tên bộ lọc'), { target: { value: 'Cụm thử' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Lưu bộ lọc' }));
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('Chọn ít nhất một nhà');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('checkbox', { name: 'Toà Một' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Lưu bộ lọc' }));
    expect(screen.getByRole('button', { name: 'Cụm thử' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Sửa bộ lọc/ }));
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Tên bộ lọc'), { target: { value: 'Cụm đổi tên' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Lưu bộ lọc' }));
    expect(screen.getByRole('button', { name: 'Cụm đổi tên' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cụm thử' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Sửa bộ lọc/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Xoá bộ lọc' }));
    expect(screen.queryByRole('button', { name: 'Cụm đổi tên' })).toBeNull();
    expect(headers()).toEqual(expect.arrayContaining(['Toà Hai', 'Toà Một', 'Tổng chia']));
  });
});

describe('ShareholderLedgerSelfView — phiếu và tạm ứng', () => {
  it('ngày phiếu dd/MM/yyyy (định dạng trên chuỗi date, không hiện ISO)', () => {
    view(ledger());
    for (const shown of ['01/09/2026', '10/10/2026', '11/10/2026']) expect(screen.getByText(shown)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/2026-(09-01|10-10|10-11)/);
  });

  it('chỉ phiếu TỰ LẬP còn chờ có "Huỷ yêu cầu"; bấm mở hộp huỷ đúng phiếu, đúng công ty', () => {
    view(ledger());
    const buttons = screen.getAllByRole('button', { name: 'Huỷ yêu cầu' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(screen.getByTestId('cancel-dialog')).toBeTruthy();
    expect(h.cancel).toHaveBeenLastCalledWith(expect.objectContaining({
      open: true,
      target: expect.objectContaining({ voucherId: 'v2', organizationId: 'org-a', kind: 'SHAREHOLDER', amount: 3_000_000, approvalStatus: 'UNAPPROVED' }),
    }));
  });

  it('không có quyền tạm ứng ⇒ không nút, không hộp', () => {
    view(ledger());
    expect(screen.queryByRole('button', { name: /Chi tạm ứng cho tôi/ })).toBeNull();
    expect(h.distribute).not.toHaveBeenCalled();
  });

  it('có quyền + sổ tổng chạy thật ⇒ nút mở hộp tạm ứng cho CHÍNH MÌNH đúng công ty', () => {
    view(ledger(), { canAdvanceOwn: true });
    fireEvent.click(screen.getByRole('button', { name: /Chi tạm ứng cho tôi/ }));
    expect(screen.getByTestId('advance-dialog')).toBeTruthy();
    expect(h.distribute).toHaveBeenLastCalledWith(expect.objectContaining({
      open: true, mode: 'SELF_ADVANCE', organizationId: 'org-a', me: { shareholderId: 'sh-1', name: 'Cổ đông 1' },
    }));
  });

  it.each(['SHADOW', 'FROZEN'] as const)('%s ⇒ nút khoá kèm câu giải thích', (route) => {
    view(ledger({ route }), { canAdvanceOwn: true });
    expect((screen.getByRole('button', { name: /Chi tạm ứng cho tôi/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('note').textContent).toMatch(/chưa/);
  });
});
